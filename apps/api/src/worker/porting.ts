import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { CATALOG } from '../genesys/catalog.js';
import { GenesysClient, PermissionError } from '../genesys/client.js';
import { awsRegion } from '../genesys/regions.js';
import type { PortItem } from '../genesys/types.js';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Environment } from '../lib/schema.js';
import { getEnvironment } from '../lib/repo.js';
import {
  ensureProvider,
  includeFilter,
  remainingGuids,
  remapIds,
  selectResources,
  type TfJson,
} from './exportConfig.js';
import { terraform, tfOrThrow, type TfCreds } from './terraform.js';

/** Log del job bufferizzato e salvato su DB ogni secondo */
class JobLog {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout;
  constructor(private readonly jobId: string) {
    this.timer = setInterval(() => void this.flush(), 1000);
  }
  line = (l: string) => {
    this.buffer.push(l);
  };
  info = (l: string) => this.line(`[porting] ${l}`);
  async flush() {
    if (!this.buffer.length) return;
    const chunk = this.buffer.splice(0).join('\n') + '\n';
    await db
      .update(schema.jobs)
      .set({ log: sql`${schema.jobs.log} || ${chunk}` })
      .where(eq(schema.jobs.id, this.jobId));
  }
  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

/**
 * Esegue un job di porting:
 * 1. genesyscloud_tf_export sul sorgente per i soli oggetti con azione "port"
 * 2. rimappatura degli ID delle dipendenze riusate (sorgente -> target)
 * 3. terraform import degli oggetti che esistono già sul target (vengono aggiornati, non duplicati)
 * 4. plan (simulazione) oppure apply in due fasi: prima gli oggetti non-flow, poi i flow
 */
export async function runPortingJob(jobId: string) {
  const setJob = (data: Partial<typeof schema.jobs.$inferInsert>) =>
    db.update(schema.jobs).set(data).where(eq(schema.jobs.id, jobId));

  const [row] = await db.update(schema.jobs).set({ status: 'RUNNING' }).where(eq(schema.jobs.id, jobId)).returning();
  if (!row) throw new Error(`Job ${jobId} non trovato`);
  const job = {
    ...row,
    sourceEnv: await getEnvironment(row.sourceEnvId),
    targetEnv: await getEnvironment(row.targetEnvId),
  };
  const log = new JobLog(jobId);
  const workDir = path.join(config.WORK_DIR, jobId);
  const runnerDir = path.join(workDir, 'runner');
  const exportDir = path.join(workDir, 'export');

  try {
    const items: PortItem[] = job.items;
    const toPort = items.filter((i) => i.action === 'port');
    log.info(`Job ${job.mode}: ${job.sourceEnv.name} -> ${job.targetEnv.name}, ${toPort.length} oggetti da portare`);

    const srcCreds: TfCreds = {
      ...new GenesysClient(job.sourceEnv).credentials(),
      region: awsRegion(job.sourceEnv.region),
    };
    const tgtCreds: TfCreds = {
      ...new GenesysClient(job.targetEnv).credentials(),
      region: awsRegion(job.targetEnv.region),
    };

    // ---- 1. Export dal sorgente ----
    await mkdir(runnerDir, { recursive: true });
    const runner = {
      terraform: {
        required_providers: { genesyscloud: { source: 'mypurecloud/genesyscloud', version: config.GENESYS_PROVIDER_VERSION } },
      },
      provider: { genesyscloud: {} },
      resource: {
        genesyscloud_tf_export: {
          export: {
            directory: exportDir,
            export_format: 'json',
            include_state_file: false,
            enable_dependency_resolution: false,
            split_files_by_resource: false,
            include_filter_resources: toPort.map(includeFilter),
          },
        },
      },
    };
    await writeFile(path.join(runnerDir, 'main.tf.json'), JSON.stringify(runner, null, 2));
    log.info('Export dal sorgente (genesyscloud_tf_export)...');
    await tfOrThrow(['init', '-no-color', '-input=false'], runnerDir, srcCreds, log.line);
    await tfOrThrow(['apply', '-no-color', '-auto-approve', '-input=false'], runnerDir, srcCreds, log.line);

    // ---- 2. Selezione risorse e rimappatura ID ----
    const exportFile = (await readdir(exportDir)).find((f) => f.endsWith('.tf.json'));
    if (!exportFile) throw new Error('Export senza file .tf.json');
    const cfgPath = path.join(exportDir, exportFile);
    let cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as TfJson;

    const addresses = selectResources(cfg, toPort);
    const missing = toPort.filter((i) => !addresses.has(i));
    if (missing.length) {
      throw new Error(`Oggetti non trovati nell'export: ${missing.map((m) => `${m.type} "${m.name}"`).join(', ')}`);
    }

    const idMap = new Map<string, string>();
    // Dipendenze riusate: ID sorgente -> ID target
    for (const it of items) {
      if (it.action !== 'port' && it.targetId) idMap.set(it.id.toLowerCase(), it.targetId);
    }
    // Oggetti portati nello stesso job: riferimento Terraform alla risorsa (es. una divisione creata ora)
    for (const [it, addr] of addresses) idMap.set(it.id.toLowerCase(), `\${${addr}.id}`);

    // Divisioni non selezionate esplicitamente: abbinamento per nome tra sorgente e target
    const missingDivisions = await mapDivisionsByName(job.sourceEnv, job.targetEnv, idMap, log.info);

    cfg = remapIds(cfg, idMap);
    ensureProvider(cfg, config.GENESYS_PROVIDER_VERSION);

    const stillReferenced = remainingGuids(cfg);
    const blocking = missingDivisions.filter((d) => stillReferenced.has(d.id.toLowerCase()));
    if (blocking.length) {
      throw new Error(
        `Divisioni assenti sul target: ${blocking.map((d) => `"${d.name}"`).join(', ')}. ` +
          `Crearle sul target oppure rianalizzare con "Includi divisioni" e portarle.`,
      );
    }

    // Avviso su riferimenti al sorgente non risolti (dipendenze saltate e assenti sul target)
    const sourceIds = new Set(items.map((i) => i.id.toLowerCase()));
    const unresolved = [...remainingGuids(cfg)].filter((g) => sourceIds.has(g));
    for (const g of unresolved) {
      const it = items.find((i) => i.id.toLowerCase() === g)!;
      log.info(`ATTENZIONE: ${it.type} "${it.name}" è referenziato ma non esiste sul target e non viene portato`);
    }

    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await rm(path.join(exportDir, 'terraform.tfstate'), { force: true });

    // ---- 3. Import degli oggetti già presenti sul target ----
    log.info('Inizializzazione sul target...');
    await tfOrThrow(['init', '-no-color', '-input=false'], exportDir, tgtCreds, log.line);
    for (const [it, addr] of addresses) {
      if (it.targetId) {
        log.info(`Import di ${addr} (esiste già sul target: ${it.targetId})`);
        await tfOrThrow(['import', '-no-color', '-input=false', addr, it.targetId], exportDir, tgtCreds, log.line);
      }
    }

    // ---- 4. Plan o apply ----
    if (job.mode === 'PLAN') {
      const plan = await tfOrThrow(['plan', '-no-color', '-input=false'], exportDir, tgtCreds, log.line);
      await setJob({ planOutput: plan.output });
    } else {
      const flowType = CATALOG.flow.tfType;
      const nonFlow = [...addresses.values()].filter((a) => !a.startsWith(flowType + '.'));
      const hasFlows = nonFlow.length < addresses.size;
      if (hasFlows && nonFlow.length) {
        log.info('Fase 1: oggetti non-flow');
        await tfOrThrow(
          ['apply', '-no-color', '-auto-approve', '-input=false', ...nonFlow.map((a) => `-target=${a}`)],
          exportDir,
          tgtCreds,
          log.line,
        );
      }
      log.info(hasFlows ? 'Fase 2: flow' : 'Apply');
      let res = await terraform(['apply', '-no-color', '-auto-approve', '-input=false'], exportDir, tgtCreds, log.line);
      if (res.code !== 0 && hasFlows) {
        // I flow possono dipendere tra loro (es. common module): un secondo giro risolve l'ordine
        log.info('Apply fallito, nuovo tentativo per dipendenze tra flow...');
        res = await terraform(['apply', '-no-color', '-auto-approve', '-input=false'], exportDir, tgtCreds, log.line);
      }
      if (res.code !== 0) throw new Error(`terraform apply terminato con codice ${res.code}`);
    }

    log.info('Completato');
    await log.close();
    await setJob({ status: 'SUCCEEDED', finishedAt: new Date() });
  } catch (e) {
    log.info(`ERRORE: ${(e as Error).message}`);
    await log.close();
    await setJob({ status: 'FAILED', finishedAt: new Date() });
  } finally {
    // L'export può contenere secret (tfvars): non lasciare nulla su disco
    if (!process.env.KEEP_WORKDIR) await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Aggiunge a idMap l'abbinamento per nome tra le divisioni del sorgente e quelle del target
 * (gli ID delle divisioni cambiano tra un'org e l'altra). Non sovrascrive scelte esplicite.
 * Restituisce le divisioni del sorgente che non esistono sul target.
 */
async function mapDivisionsByName(
  sourceEnv: Environment,
  targetEnv: Environment,
  idMap: Map<string, string>,
  info: (l: string) => void,
): Promise<{ id: string; name: string }[]> {
  let src: { id: string; name: string }[];
  let tgt: { id: string; name: string }[];
  try {
    [src, tgt] = await Promise.all([
      new GenesysClient(sourceEnv).listAll('/api/v2/authorization/divisions'),
      new GenesysClient(targetEnv).listAll('/api/v2/authorization/divisions'),
    ]);
  } catch (e) {
    if (!(e instanceof PermissionError)) throw e;
    info(`ATTENZIONE: divisioni non leggibili, nessuna rimappatura automatica (${e.message})`);
    return [];
  }
  const byName = new Map(tgt.map((d) => [d.name.toLowerCase(), d.id]));
  const missing: { id: string; name: string }[] = [];
  for (const d of src) {
    if (idMap.has(d.id.toLowerCase())) continue;
    const targetId = byName.get(d.name.toLowerCase());
    if (targetId) idMap.set(d.id.toLowerCase(), targetId);
    else missing.push(d);
  }
  return missing;
}
