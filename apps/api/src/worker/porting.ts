import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { GenesysClient, PermissionError } from '../genesys/client.js';
import { awsRegion } from '../genesys/regions.js';
import type { PortItem } from '../genesys/types.js';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Environment } from '../lib/schema.js';
import { getEnvironment } from '../lib/repo.js';
import { packArtifact, unpackArtifact } from './artifact.js';
import { appliedFromOutput, blockReason, comparableChanges, describeDrift, summarize, type PlanJson } from './planJson.js';
import {
  addDependsOn,
  ensureProvider,
  includeFilter,
  remainingGuids,
  remapConfig,
  remapReferencedFiles,
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

type JobRow = typeof schema.jobs.$inferSelect;
type SetJob = (data: Partial<typeof schema.jobs.$inferInsert>) => Promise<unknown>;

const PLAN_FILE = 'promote.tfplan';
const CHECK_FILE = 'drift-check.tfplan';

const credsOf = (env: Environment): TfCreds => ({
  ...new GenesysClient(env).credentials(),
  region: awsRegion(env.region),
});

/**
 * Esegue un job. Il job passa da QUEUED a RUNNING con un aggiornamento condizionale:
 * se un altro processo l'ha già preso (o è stato annullato), qui non succede nulla.
 * - PLAN: esporta dal sorgente, prepara la configurazione, calcola il piano e lo salva (artefatto cifrato).
 * - APPLY: applica esattamente il piano salvato, dopo aver verificato che il target non sia cambiato.
 */
export async function runPortingJob(jobId: string) {
  const [job] = await db
    .update(schema.jobs)
    .set({ status: 'RUNNING' })
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'QUEUED')))
    .returning();
  if (!job) return;

  const setJob: SetJob = (data) => db.update(schema.jobs).set(data).where(eq(schema.jobs.id, jobId));
  const log = new JobLog(jobId);
  const workDir = path.join(config.WORK_DIR, jobId);

  try {
    if (job.mode === 'PLAN') await runPlan(job, workDir, log, setJob);
    else await runApply(job, workDir, log, setJob);
    log.info('Completato');
    await log.close();
    await setJob({ status: 'SUCCEEDED', finishedAt: new Date() });
  } catch (e) {
    log.info(`ERRORE: ${(e as Error).message}`);
    await log.close();
    await setJob({ status: 'FAILED', finishedAt: new Date() });
  } finally {
    // La cartella di lavoro può contenere secret (tfvars, state): non lasciare nulla su disco
    if (!process.env.KEEP_WORKDIR) await rm(workDir, { recursive: true, force: true });
  }
}

/** Simulazione: export dal sorgente, configurazione per il target, piano salvato */
async function runPlan(job: JobRow, workDir: string, log: JobLog, setJob: SetJob) {
  const sourceEnv = await getEnvironment(job.sourceEnvId);
  const targetEnv = await getEnvironment(job.targetEnvId);
  const runnerDir = path.join(workDir, 'runner');
  const exportDir = path.join(workDir, 'export');
  const items: PortItem[] = job.items;
  const toPort = items.filter((i) => i.action === 'port');

  log.info(`Simulazione: ${sourceEnv.name} -> ${targetEnv.name}, ${toPort.length} oggetti da portare`);
  log.info('SIMULAZIONE: nessuna modifica verrà applicata alle org');
  const srcCreds = credsOf(sourceEnv);
  const tgtCreds = credsOf(targetEnv);

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
          // Percorso relativo con "/": su Windows un percorso assoluto (c:\...) viene scambiato
          // dal provider per un URL ("unsupported protocol scheme c") quando scarica script e prompt
          directory: path.relative(runnerDir, exportDir).split(path.sep).join('/'),
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
  log.info(
    `Export da ${sourceEnv.name} (genesyscloud_tf_export): sola lettura, i file vengono scritti in locale. ` +
      `"Apply complete" qui sotto si riferisce alla sola risorsa di export.`,
  );
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

  // ID sorgente -> ID target: dipendenze riusate (o già presenti) e divisioni abbinate per nome
  const targetIds = new Map<string, string>();
  for (const it of items) {
    if (it.action !== 'port' && it.targetId) targetIds.set(it.id.toLowerCase(), it.targetId);
  }
  // ID sorgente -> risorsa Terraform: oggetti creati o aggiornati in questo stesso job
  const sameJobRefs = new Map<string, string>();
  for (const [it, addr] of addresses) sameJobRefs.set(it.id.toLowerCase(), addr);

  const missingDivisions = await mapDivisionsByName(sourceEnv, targetEnv, targetIds, log.info);

  // Configurazione: ID del target oppure riferimento alla risorsa creata nel job (mai sé stessa, mai i percorsi)
  cfg = remapConfig(cfg, targetIds, sameJobRefs);

  // File esportati (JSON degli script, YAML dei flow): ID scritti in chiaro nel contenuto
  const { report: fileReport, missingFiles } = await remapReferencedFiles(cfg, exportDir, targetIds, sameJobRefs);
  for (const f of missingFiles) log.info(`ATTENZIONE: file esportato non trovato, ID non sostituiti: ${f}`);
  for (const r of fileReport) {
    log.info(
      `ID sostituiti in ${r.file}: ${r.replaced} con ID del target` +
        (r.placeholders ? `, ${r.placeholders} con riferimenti a oggetti creati in questo porting` : ''),
    );
  }

  // Ordine di creazione dall'albero delle dipendenze
  const keyToAddress = new Map([...addresses].map(([it, addr]) => [`${it.type}:${it.id}`.toLowerCase(), addr]));
  const ordered = addDependsOn(cfg, job.edges ?? [], keyToAddress);
  if (ordered) log.info(`Ordine di creazione: ${ordered} vincoli dalle dipendenze (depends_on)`);
  ensureProvider(cfg, config.GENESYS_PROVIDER_VERSION);

  const stillReferenced = remainingGuids(cfg);
  const blocking = missingDivisions.filter((d) => stillReferenced.has(d.id.toLowerCase()));
  if (blocking.length) {
    throw new Error(
      `Divisioni assenti sul target: ${blocking.map((d) => `"${d.name}"`).join(', ')}. ` +
        `Crearle sul target oppure rianalizzare con "Includi divisioni" e portarle.`,
    );
  }
  const sourceIds = new Set(items.filter((i) => i.action !== 'port').map((i) => i.id.toLowerCase()));
  for (const g of [...remainingGuids(cfg)].filter((g) => sourceIds.has(g))) {
    const it = items.find((i) => i.id.toLowerCase() === g)!;
    log.info(`ATTENZIONE: ${it.type} "${it.name}" è referenziato ma non esiste sul target e non viene portato`);
  }

  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await rm(path.join(exportDir, 'terraform.tfstate'), { force: true });

  // ---- 3. Import degli oggetti già presenti sul target (solo nello state locale) ----
  log.info(`Preparazione per ${targetEnv.name}: inizializzazione Terraform (locale)`);
  await tfOrThrow(['init', '-no-color', '-input=false'], exportDir, tgtCreds, log.line);
  for (const [it, addr] of addresses) {
    if (it.targetId) {
      log.info(
        `Import di ${addr} nello state locale (esiste già sul target: ${it.targetId}). ` +
          `Sola lettura: serve perché il piano proponga un aggiornamento e non una creazione.`,
      );
      await tfOrThrow(['import', '-no-color', '-input=false', addr, it.targetId], exportDir, tgtCreds, log.line);
    }
  }

  // ---- 4. Piano salvato ----
  log.info(`Piano delle modifiche su ${targetEnv.name} (nessuna modifica applicata)`);
  const plan = await tfOrThrow(['plan', '-no-color', '-input=false', `-out=${PLAN_FILE}`], exportDir, tgtCreds, log.line);
  const planJson = await showPlan(exportDir, PLAN_FILE, tgtCreds);
  const summary = summarize(planJson);
  let blockedReason = blockReason(summary);
  if (!blockedReason && !summary.changes.length) blockedReason = 'Il piano non contiene modifiche: niente da eseguire.';
  log.info(
    `Riepilogo: ${summary.add} da creare, ${summary.change} da aggiornare, ` +
      `${summary.destroy} da cancellare, ${summary.replace} da ricreare`,
  );
  if (blockedReason) log.info(`PLAN NON ESEGUIBILE: ${blockedReason}`);

  const artifactEncrypted = blockedReason
    ? null
    : await packArtifact(exportDir, {
        target: { envId: targetEnv.id, name: targetEnv.name, region: targetEnv.region, clientId: targetEnv.clientId },
        planFile: PLAN_FILE,
      });
  const expiresAt = new Date(Date.now() + config.PLAN_TTL_HOURS * 3600_000);
  if (!blockedReason) log.info(`Plan eseguibile fino al ${expiresAt.toISOString()}`);
  await setJob({ planOutput: plan.output, planSummary: summary, blockedReason, artifactEncrypted, expiresAt });
}

/** Esecuzione: applica il piano salvato del plan collegato, solo se il target non è cambiato */
async function runApply(job: JobRow, workDir: string, log: JobLog, setJob: SetJob) {
  if (!job.planJobId) throw new Error('Esecuzione senza plan collegato: rifiutata');
  const [plan] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.planJobId));
  const targetEnv = await getEnvironment(job.targetEnvId);

  // Controlli ripetuti qui (oltre che nell'API): il worker non si fida dello stato visto al momento della richiesta
  if (!plan || plan.mode !== 'PLAN' || plan.status !== 'SUCCEEDED') throw new Error('Plan non valido o non completato');
  if (plan.appliedJobId !== job.id) throw new Error('Il plan non è assegnato a questa esecuzione');
  if (plan.blockedReason) throw new Error(`Plan non eseguibile: ${plan.blockedReason}`);
  if (!plan.artifactEncrypted) throw new Error('Il piano salvato non è più disponibile');
  if (!plan.expiresAt || plan.expiresAt.getTime() < Date.now()) throw new Error('Plan scaduto: rifare la simulazione');
  if (plan.targetEnvId !== job.targetEnvId) throw new Error('Il target non corrisponde a quello del plan');
  if (targetEnv.requireApproval && !plan.approvedBy) throw new Error(`${targetEnv.name} richiede l'approvazione del plan`);
  if (!targetEnv.allowAsTarget) throw new Error(`${targetEnv.name} non è abilitato come target`);

  log.info(`Esecuzione del plan ${plan.id} (creato da ${plan.createdBy} il ${plan.createdAt.toISOString()})`);
  if (plan.approvedBy) log.info(`Approvato da ${plan.approvedBy} il ${plan.approvedAt?.toISOString()}`);

  const dir = path.join(workDir, 'plan');
  await mkdir(dir, { recursive: true });
  try {
    const artifact = await unpackArtifact(plan.artifactEncrypted, dir);
    const t = artifact.target;
    if (t.envId !== targetEnv.id || t.name !== targetEnv.name || t.region !== targetEnv.region || t.clientId !== targetEnv.clientId) {
      throw new Error(
        `L'ambiente target è stato modificato dopo il plan (era ${t.name} / ${t.region} / client ${t.clientId}): rifare la simulazione`,
      );
    }
    const tgtCreds = credsOf(targetEnv);

    log.info(`Inizializzazione Terraform con le stesse versioni dei provider del plan (locale)`);
    await tfOrThrow(['init', '-no-color', '-input=false'], dir, tgtCreds, log.line);

    // ---- Controllo di deriva: il piano ricalcolato ora deve coincidere con quello salvato ----
    log.info(`Controllo che ${targetEnv.name} non sia cambiato dopo la simulazione (sola lettura)`);
    await tfOrThrow(['plan', '-no-color', '-input=false', `-out=${CHECK_FILE}`], dir, tgtCreds, () => {});
    const saved = await showPlan(dir, artifact.planFile, tgtCreds);
    const fresh = await showPlan(dir, CHECK_FILE, tgtCreds);
    if (comparableChanges(saved) !== comparableChanges(fresh)) {
      const diff = describeDrift(saved, fresh);
      throw new Error(
        `${targetEnv.name} è cambiato dopo la simulazione: nessuna modifica applicata. Rifare la simulazione.\n` +
          diff.map((d) => `  - ${d}`).join('\n'),
      );
    }
    log.info('Nessuna differenza rispetto alla simulazione');

    // ---- Applicazione del piano salvato ----
    log.info(`Scrittura su ${targetEnv.name}: applicazione del piano salvato`);
    const res = await terraform(['apply', '-no-color', '-input=false', artifact.planFile], dir, tgtCreds, log.line);
    const applied = appliedFromOutput(res.output);
    await setJob({ appliedResources: applied });
    if (res.code !== 0) {
      throw new Error(
        `Esecuzione interrotta con errore. Modifiche applicate prima dell'errore (${applied.length}): ` +
          `${applied.join(', ') || 'nessuna'}. Il plan è consumato: rifare la simulazione per completare.`,
      );
    }
    log.info(`Modifiche applicate (${applied.length}): ${applied.join(', ')}`);
  } finally {
    // Il plan si esegue una sola volta: l'artefatto (con eventuali secret) non serve più
    await db.update(schema.jobs).set({ artifactEncrypted: null }).where(eq(schema.jobs.id, plan.id));
  }
}

async function showPlan(dir: string, planFile: string, creds: TfCreds): Promise<PlanJson> {
  const res = await tfOrThrow(['show', '-json', '-no-color', planFile], dir, creds, () => {});
  const line = res.output.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`terraform show -json non ha restituito il piano (${planFile})`);
  return JSON.parse(line) as PlanJson;
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
