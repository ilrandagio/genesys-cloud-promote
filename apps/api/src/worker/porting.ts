import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { GenesysClient, PermissionError } from '../genesys/client.js';
import { CATALOG, WRAPUP_MAPPINGS_ID, listObjects } from '../genesys/catalog.js';
import { lazyIdIndex } from '../genesys/dependencies.js';
import { parse as parseYaml } from 'yaml';
import { ID_TOKEN_G, idKey } from '../genesys/ids.js';

/**
 * Per ogni oggetto che il piano ricrea: chi lo usa sul target (Dependency Tracking del target). Ricreandolo
 * cambia ID, quindi chi lo usa e non viene portato in questo rilascio resta con un riferimento all'ID vecchio.
 */
async function consumersOfReplaced(
  replaced: string[],
  items: Map<string, PortItem>,
  portedTargetIds: Set<string>,
  target: GenesysClient,
  info: (l: string) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (const addr of replaced) {
    const it = items.get(addr);
    if (!it?.targetId) continue;
    const what = `${CATALOG[it.type].label} "${it.name}"`;
    let consumers: { id: string; name: string; type: string }[] = [];
    try {
      const objectType = it.type === 'dataaction' ? 'DATAACTION' : it.type.toUpperCase();
      consumers = await target.listAll(
        '/api/v2/architect/dependencytracking/consumingresources',
        `&id=${encodeURIComponent(it.targetId)}&objectType=${objectType}`,
      );
    } catch (e) {
      out.push(`${what} viene RICREATA con un nuovo ID; non è stato possibile leggere chi la usa sul target (${(e as Error).message}): verificare Flows e Scripts che la usano.`);
      continue;
    }
    const notPorted = consumers.filter((c) => !portedTargetIds.has(c.id));
    const list = (cs: typeof consumers) => cs.map((c) => `${c.name} (${c.type})`).join(', ');
    info(`${what}: ricreata; usata sul target da ${consumers.length ? list(consumers) : 'nessun oggetto'}`);
    out.push(
      `${what} viene RICREATA (cancellata e creata con un nuovo ID) perché il provider non può aggiornarla, per esempio per un contract cambiato.` +
        (notPorted.length
          ? ` Sul target la usano oggetti non portati in questo rilascio, che resterebbero con l'ID vecchio: ${list(notPorted)}. Portarli nello stesso rilascio oppure ripubblicarli dopo.`
          : consumers.length
            ? ` Chi la usa sul target (${list(consumers)}) è portato in questo rilascio e riceve il nuovo ID.`
            : ' Sul target non risulta usata da altri oggetti.'),
    );
  }
  return out;
}

/** Scripts esistenti sul target da aggiornare: nessun altro Script deve avere lo stesso nome */
async function checkDuplicateScripts(items: PortItem[], target: GenesysClient, info: (l: string) => void) {
  const updates = items.filter((i) => i.type === 'script' && i.action === 'port' && i.targetId);
  const dup: string[] = [];
  for (const it of updates) {
    const found = await target.listAll<{ id: string; name: string; modifiedDate?: string }>(
      CATALOG.script.listPath,
      `&name=${encodeURIComponent(it.name)}`,
    );
    const same = found.filter((s) => s.name === it.name);
    if (same.length > 1) {
      dup.push(
        `"${it.name}": ${same.length} Scripts con questo nome sul target (ID ${same.map((s) => s.id).join(', ')}; ` +
          `quello aggiornato sarebbe ${it.targetId})`,
      );
    }
  }
  if (dup.length) {
    throw new Error(
      `Scripts con nome duplicato sul target: ${dup.join('; ')}. Il provider Terraform cerca lo Script per nome dopo ` +
        `averlo caricato e si ferma se ne trova più di uno (problema noto del provider). Rinominare o eliminare sul ` +
        `target le copie non usate, poi rifare l'analisi e la simulazione.`,
    );
  }
  if (updates.length) info(`Scripts da aggiornare senza nomi duplicati sul target: ${updates.length}`);
}

/** Voci TTS dei Flows da portare, lette dai loro file YAML esportati */
async function voicesOfFlows(cfg: TfJson, addresses: Map<PortItem, string>, baseDir: string): Promise<FlowVoice[]> {
  const out: FlowVoice[] = [];
  for (const [it, addr] of addresses) {
    if (it.type !== 'flow') continue;
    const filepath = cfg.resource?.genesyscloud_flow?.[addr.slice('genesyscloud_flow.'.length)]?.filepath;
    if (typeof filepath !== 'string' || filepath.includes('${')) continue;
    try {
      const text = await readFile(path.resolve(baseDir, ...filepath.split(/[\\/]+/)), 'utf8');
      out.push(...flowVoices(it.name, parseYaml(text)));
    } catch {
      // file non leggibile o non YAML: lo segnala già il controllo dei file esportati
    }
  }
  return out;
}

/** Per ogni Trigger della configurazione, i GUID citati nelle condizioni (match_criteria) */
function triggerCriteriaIds(cfg: TfJson): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [label, attrs] of Object.entries(cfg.resource?.[CATALOG.trigger.tfType] ?? {})) {
    const text = JSON.stringify((attrs as any)?.match_criteria ?? '');
    const ids = new Set((text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).map((g) => g.toLowerCase()));
    if (ids.size) out.set(label, ids);
  }
  return out;
}
import { awsRegion } from '../genesys/regions.js';
import type { PortItem } from '../genesys/types.js';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Environment } from '../lib/schema.js';
import { getEnvironment } from '../lib/repo.js';
import { packArtifact, packPlanFiles, unpackArtifact } from './artifact.js';
import {
  alignWebDeploymentVersions,
  applyDataTableRows,
  applyGroupRoles,
  checkRoleUserConditions,
  filterRolePermissions,
  checkFlowVoices,
  flowVoices,
  type FlowVoice,
  applyActionRequestSettings,
  applyQueueMembership,
  applySafetyRules,
  applyTargetSettings,
  restoreActionUrlTemplates,
  buildWrapupMappings,
  rewriteAssetLinks,
} from './transforms.js';
import { appliedFromOutput, blockReason, comparableChanges, describeDrift, summarize, type PlanJson } from './planJson.js';
import {
  addDependsOn,
  ensureProvider,
  remainingGuids,
  remapConfig,
  dropFlowContentHash,
  normalizeFilePaths,
  remapReferencedFiles,
  selectResources,
  unexportedFiles,
  type TfJson,
} from './exportConfig.js';
import { exportObjects } from './exporter.js';
import {
  createdResources,
  openSnapshot,
  prepareRollback,
  resolveReplacedIds,
  sealSnapshot,
  takeRollbackSnapshot,
  type RollbackSnapshot,
} from './rollback.js';
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
    if (job.mode === 'PLAN' && job.rollbackOfJobId) await runRollbackPlan(job, workDir, log, setJob);
    else if (job.mode === 'PLAN') await runPlan(job, workDir, log, setJob);
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
  // Gli oggetti unici per org (wrap-up code mappings) non si esportano: la configurazione la costruisce il worker
  const singletons = toPort.filter((i) => CATALOG[i.type].singleton);
  const toExport = toPort.filter((i) => !CATALOG[i.type].singleton);

  log.info(`Simulazione: ${sourceEnv.name} -> ${targetEnv.name}, ${toPort.length} oggetti da portare`);
  log.info('SIMULAZIONE: nessuna modifica verrà applicata alle org');
  const srcCreds = credsOf(sourceEnv);
  const tgtCreds = credsOf(targetEnv);

  // ---- 1. Export dal sorgente ----
  let cfg: TfJson = { resource: {} };
  let cfgPath = path.join(exportDir, 'genesyscloud.tf.json');
  if (!toExport.length) {
    await mkdir(exportDir, { recursive: true });
    log.info('Nessun oggetto da esportare dal sorgente: solo oggetti unici per org');
  } else {
    ({ cfg, cfgPath } = await exportObjects({
      items: toExport,
      runnerDir,
      exportDir,
      creds: srcCreds,
      orgName: sourceEnv.name,
      line: log.line,
      info: log.info,
    }));
  }

  // ---- 2. Selezione risorse e rimappatura ID ----
  const fixedPaths = normalizeFilePaths(cfg);
  if (fixedPaths) log.info(`Percorsi dei file con "\\" normalizzati con "/": ${fixedPaths}`);
  dropFlowContentHash(cfg);
  // Data Actions omonime in Integrations diverse: si sceglie quella con l'integration_id del sorgente
  const match = new Map<PortItem, Record<string, string>>();
  for (const it of toExport.filter((i) => i.type === 'dataaction')) {
    try {
      const a = await new GenesysClient(sourceEnv).get<{ integrationId?: string }>(
        CATALOG.dataaction.getPath.replace('{id}', encodeURIComponent(it.id)),
      );
      if (a.integrationId) match.set(it, { integration_id: a.integrationId });
    } catch {
      // dettaglio non leggibile: abbinamento solo per nome
    }
  }
  const addresses = selectResources(cfg, toExport, match);
  const missing = toExport.filter((i) => !addresses.has(i));
  if (missing.length) {
    // Le Data Actions predefinite (statiche) l'export le scrive come data source, non come risorse
    const asData = Object.values(cfg.data?.genesyscloud_integration_action ?? {}).map((a: any) => String(a?.name ?? '').toLowerCase());
    throw new Error(
      `Oggetti non trovati nell'export: ${missing
        .map((m) =>
          `${CATALOG[m.type].label} "${m.name}"` +
          (m.type === 'dataaction' && asData.includes(m.name.toLowerCase())
            ? ' (Data Action predefinita di Genesys: non si porta, scegliere "Usa quella del target")'
            : ''),
        )
        .join(', ')}`,
    );
  }

  // Data Actions: URL della richiesta tolto dall'export (provider 1.88.0), riletto dal sorgente
  await restoreActionUrlTemplates(cfg, addresses, new GenesysClient(sourceEnv), log.info);

  // Regole di sicurezza: campagne e sequenze spente, liste senza contatti, indirizzo degli asset rimosso
  applySafetyRules(cfg, log.info);

  // Ogni file referenziato (YAML dei flow, JSON degli script) deve essere stato davvero esportato
  const unexported = unexportedFiles(cfg);
  if (unexported.length) {
    throw new Error(
      `File non esportati dal sorgente per: ${unexported.join(', ')}. ` +
        `Il percorso è rimasto una variabile da compilare: l'oggetto non può essere portato con questo export.`,
    );
  }

  // Pre-controllo: Scripts da aggiornare con lo stesso nome di altri Scripts sul target. Il provider, dopo il
  // caricamento, ricerca lo Script per nome e fallisce se ne trova più di uno ("more than one script found
  // with name"): l'aggiornamento si interromperebbe in esecuzione
  await checkDuplicateScripts([...addresses.keys()], new GenesysClient(targetEnv), log.info);

  // Pre-controllo: voci TTS dei Flows portati disponibili sul target (altrimenti la pubblicazione fallisce)
  const voiceWarnings = await checkFlowVoices(
    await voicesOfFlows(cfg, addresses, path.dirname(cfgPath)),
    new GenesysClient(targetEnv),
    log.info,
  );

  // ID sorgente -> ID target: dipendenze riusate (o già presenti) e divisioni abbinate per nome
  const targetIds = new Map<string, string>();
  for (const it of items) {
    if (it.action !== 'port' && it.targetId) targetIds.set(it.id.toLowerCase(), it.targetId);
  }
  // ID sorgente -> risorsa Terraform: oggetti creati o aggiornati in questo stesso job
  const sameJobRefs = new Map<string, string>();
  for (const [it, addr] of addresses) sameJobRefs.set(it.id.toLowerCase(), addr);

  const missingDivisions = await mapDivisionsByName(sourceEnv, targetEnv, targetIds, log.info);

  // Link agli asset nei testi delle canned response: URL interi, prima della rimappatura dei GUID
  const targetClient = new GenesysClient(targetEnv);

  // Analisi non più attuale: un oggetto da creare (mancante al momento dell'analisi) ora esiste sul target,
  // per esempio creato da un'esecuzione precedente. Crearlo di nuovo fallirebbe ("name is currently in use")
  // e l'azione giusta potrebbe essere un'altra: si chiede di rifare l'analisi
  {
    const byType = new Map<string, any[]>();
    const nowPresent: string[] = [];
    for (const it of toExport.filter((i) => !i.targetId && !CATALOG[i.type].singleton)) {
      if (!byType.has(it.type)) byType.set(it.type, await listObjects(targetClient, it.type).catch(() => []));
      const hit = byType.get(it.type)!.find(
        (o) =>
          String(o.name ?? '').toLowerCase() === it.name.toLowerCase() &&
          (it.type !== 'flow' || !it.subtype || String(o.type ?? '').toLowerCase() === it.subtype.toLowerCase()),
      );
      if (hit) nowPresent.push(`${CATALOG[it.type].label} "${it.name}"`);
    }
    if (nowPresent.length) {
      throw new Error(
        `L'analisi non è più attuale: questi oggetti risultavano mancanti ma ora esistono sul target: ` +
          `${nowPresent.join(', ')}. Rifare l'analisi e poi la simulazione.`,
      );
    }
  }
  await rewriteAssetLinks(cfg, items, addresses, targetClient, log.info);

  // Configurazione: ID del target oppure riferimento alla risorsa creata nel job (mai sé stessa, mai i percorsi)
  // Triggers: ID citati nelle condizioni (matchCriteria) prima della rimappatura
  const triggerIdsBefore = triggerCriteriaIds(cfg);
  cfg = remapConfig(cfg, targetIds, sameJobRefs);

  // Campaigns e Queues: Site, Edge Group, email e numero scelti sul target (mai quelli del sorgente)
  await applyTargetSettings(cfg, addresses, targetClient, log.info);
  // Queues: membri mai portati, quelli del target mai toccati
  await applyQueueMembership(cfg, addresses, targetClient, log.info);
  // Data Actions: URL e header costanti scelti sul target
  applyActionRequestSettings(cfg, addresses, log.info);

  // Utenti mai portati: nessun Role può citare un utente del sorgente
  checkRoleUserConditions(cfg);
  // Roles: permessi che il target non ha (licenze diverse) → errore, oppure tolti se richiesto
  const planWarnings = [...voiceWarnings, ...(await filterRolePermissions(cfg, addresses, targetClient, log.info))];

  // Groups: Roles assegnati sul sorgente, assegnati anche sul target
  const extraImports: { addr: string; id: string }[] = [];
  await applyGroupRoles(cfg, addresses, new GenesysClient(sourceEnv), targetIds, sameJobRefs, extraImports, log.info);

  // Data Tables con "Porta anche i dati": righe del sorgente, quelle già sul target importate e aggiornate
  await applyDataTableRows(cfg, addresses, new GenesysClient(sourceEnv), targetClient, log.info);

  // Wrap-up code mappings: unione di sorgente e target, già con gli ID del target
  for (const it of singletons) {
    const tfType = CATALOG[it.type].tfType;
    const sourceClient = new GenesysClient(sourceEnv);
    const body = await buildWrapupMappings(sourceClient, targetClient, targetIds, sameJobRefs, log.info);
    cfg.resource ??= {};
    cfg.resource[tfType] = { [WRAPUP_MAPPINGS_ID]: body };
    addresses.set({ ...it, targetId: WRAPUP_MAPPINGS_ID }, `${tfType}.${WRAPUP_MAPPINGS_ID}`);
  }

  // Deployment di Messenger: versione della configurazione valida sul target
  await alignWebDeploymentVersions(cfg, targetClient, log.info);

  // File esportati (JSON degli script, YAML dei flow): ID scritti in chiaro nel contenuto
  const { report: fileReport, missingFiles } = await remapReferencedFiles(cfg, exportDir, targetIds, sameJobRefs);
  for (const f of missingFiles) log.info(`ATTENZIONE: file esportato non trovato, ID non sostituiti: ${f}`);
  // Per ogni file (JSON degli Scripts, YAML dei Flows): quali oggetti sono stati sostituiti e con cosa
  const byId = new Map(items.map((i) => [i.id.toLowerCase(), i]));
  const describe = (id: string) => {
    const it = byId.get(id);
    return it ? `${CATALOG[it.type].label} "${it.name}"` : `Division o oggetto ${id}`;
  };
  for (const r of fileReport) {
    log.info(
      `ID sostituiti in ${r.file}: ${r.replaced} con ID del target` +
        (r.placeholders ? `, ${r.placeholders} con riferimenti a oggetti creati in questo porting` : ''),
    );
    for (const d of r.details) {
      log.info(
        `  - ${describe(d.sourceId)}: ${d.sourceId} → ` +
          (d.sameJob ? `creato in questo rilascio (${d.target})` : d.target) +
          (d.count > 1 ? ` (${d.count} occorrenze)` : ''),
      );
    }
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
  // Riferimenti a oggetti che non esistono sul target e non vengono portati: Genesys rifiuterebbe la
  // creazione in esecuzione (es. "Skill … does not exist"). Si ferma la simulazione, che non scrive nulla
  const sourceIds = new Set(items.filter((i) => i.action !== 'port').map((i) => i.id.toLowerCase()));
  const dangling = [...remainingGuids(cfg)]
    .filter((g) => sourceIds.has(g))
    .map((g) => items.find((i) => i.id.toLowerCase() === g)!);
  if (dangling.length) {
    throw new Error(
      `Oggetti referenziati che non esistono sul target e non vengono portati: ` +
        `${dangling.map((i) => `${CATALOG[i.type].label} "${i.name}"`).join(', ')}. ` +
        `Impostarli su "Porta" nell'albero oppure crearli sul target, poi rifare la simulazione.`,
    );
  }

  // Riferimenti a oggetti del sorgente che non sono nell'analisi (analisi vecchia o riferimento non
  // riconosciuto): i loro ID resterebbero quelli del sorgente e Genesys rifiuterebbe la risorsa
  {
    const index = await lazyIdIndex(new GenesysClient(sourceEnv))();
    const analyzed = new Set(items.map((i) => idKey(i.id)));
    const unknown = new Map<string, Set<string>>();
    for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
      // Righe delle Data Tables: dati copiati così come sono, per scelta
      if (type === 'genesyscloud_architect_datatable_row') continue;
      for (const [label, attrs] of Object.entries(labels as Record<string, unknown>)) {
        const text = JSON.stringify(attrs, (k, v) => (k === 'filepath' || k === 'file_content_hash' || k === 'filename' ? undefined : v));
        for (const token of text.match(ID_TOKEN_G) ?? []) {
          const entry = index.byId.get(idKey(token));
          if (!entry || entry.type === 'division' || analyzed.has(idKey(entry.id))) continue;
          const key = `${CATALOG[entry.type].label} "${entry.name}"`;
          if (!unknown.has(key)) unknown.set(key, new Set());
          unknown.get(key)!.add(`${type}.${label}`);
        }
      }
    }
    if (unknown.size) {
      throw new Error(
        `Oggetti del sorgente citati ma non presenti nell'analisi: ` +
          [...unknown].map(([obj, by]) => `${obj} (in ${[...by].slice(0, 3).join(', ')}${by.size > 3 ? '…' : ''})`).join('; ') +
          `. Rifare l'analisi, così compaiono nell'albero con la loro azione, poi la simulazione.`,
      );
    }
  }
  // Triggers: un ID nelle condizioni rimasto uguale dopo la rimappatura è un oggetto del sorgente non
  // riconosciuto (es. un utente, che non si porta): sul target la condizione non scatterebbe mai
  {
    const after = triggerCriteriaIds(cfg);
    const stale: string[] = [];
    for (const [label, ids] of triggerIdsBefore) {
      const left = [...ids].filter((id) => after.get(label)?.has(id));
      if (left.length) stale.push(`Trigger "${cfg.resource?.[CATALOG.trigger.tfType]?.[label]?.name ?? label}" (${left.join(', ')})`);
    }
    if (stale.length) {
      throw new Error(
        `Condizioni dei Triggers con ID del sorgente non riconosciuti (es. utenti, che non si portano): ` +
          `${stale.join('; ')}. Togliere o cambiare la condizione sul sorgente, oppure non portare il Trigger.`,
      );
    }
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
  for (const { addr, id } of extraImports) {
    log.info(`Import di ${addr} nello state locale (Roles attuali del Group sul target)`);
    await tfOrThrow(['import', '-no-color', '-input=false', addr, id], exportDir, tgtCreds, log.line);
  }

  // Blocchi import (righe delle Data Tables): servono Terraform 1.5 o successivo
  if (Array.isArray(cfg.import) && cfg.import.length) {
    const ver = await tfOrThrow(['version', '-json'], exportDir, tgtCreds, () => {});
    const v = (/"terraform_version"\s*:\s*"([\d.]+)"/.exec(ver.output)?.[1] ?? '0.0.0').split('.').map(Number);
    if (v[0] < 1 || (v[0] === 1 && v[1] < 5)) {
      throw new Error(`Portare i dati delle Data Tables richiede Terraform 1.5 o successivo (installato: ${v.join('.')})`);
    }
  }

  // ---- 4. Piano salvato ----
  // Ricreazioni consentite dall'utente (Data Actions il cui contract cambia): l'oggetto cambia ID, quindi
  // si avvisa di chi lo usa sul target e non viene portato in questo rilascio
  const replaceable = new Map<string, PortItem>();
  for (const [it, addr] of addresses) if (it.allowReplace && it.targetId) replaceable.set(addr, it);
  const portedIds = new Set(job.items.filter((i) => i.action === 'port' && i.targetId).map((i) => i.targetId!));
  await savePlan({
    exportDir,
    targetEnv,
    tgtCreds,
    log,
    setJob,
    warnings: planWarnings,
    allowedReplaces: new Set(replaceable.keys()),
    replaceWarnings: (replaced) => consumersOfReplaced(replaced, replaceable, portedIds, new GenesysClient(targetEnv), log.info),
  });
}

/**
 * Calcola il piano salvato nella cartella di lavoro, ne verifica l'eseguibilità e salva artefatto cifrato e
 * file scaricabili. allowedDeletes: cancellazioni ammesse (solo nei plan di ripristino, per gli oggetti creati
 * dal rilascio da annullare); ricreazioni mai ammesse.
 */
async function savePlan(opts: {
  exportDir: string;
  targetEnv: Environment;
  tgtCreds: TfCreds;
  log: JobLog;
  setJob: SetJob;
  warnings: string[];
  allowedDeletes?: Set<string>;
  allowedReplaces?: Set<string>;
  /** Avvisi da aggiungere per le ricreazioni effettivamente presenti nel piano (indirizzo → testo) */
  replaceWarnings?: (addresses: string[]) => Promise<string[]>;
}) {
  const { exportDir, targetEnv, tgtCreds, log, setJob, warnings, allowedDeletes, allowedReplaces, replaceWarnings } = opts;
  log.info(`Piano delle modifiche su ${targetEnv.name} (nessuna modifica applicata)`);
  const plan = await tfOrThrow(['plan', '-no-color', '-input=false', `-out=${PLAN_FILE}`], exportDir, tgtCreds, log.line);
  const planJson = await showPlan(exportDir, PLAN_FILE, tgtCreds);
  const summary = summarize(planJson);
  const replaced = summary.changes
    .filter((c) => c.actions.includes('delete') && c.actions.includes('create') && allowedReplaces?.has(c.address))
    .map((c) => c.address);
  const allWarnings = [...warnings, ...(replaced.length && replaceWarnings ? await replaceWarnings(replaced) : [])];
  if (allWarnings.length) summary.warnings = allWarnings;
  let blockedReason = blockReason(summary, allowedDeletes, allowedReplaces);
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
  // Configurazione scaricabile dall'interfaccia (anche dopo l'esecuzione, anche se il plan è bloccato)
  const planFilesEncrypted = await packPlanFiles(exportDir, {
    'plan.txt': plan.output,
    'riepilogo.json': JSON.stringify({ ...summary, blockedReason: blockedReason ?? null }, null, 2),
  });
  await setJob({ planOutput: plan.output, planSummary: summary, blockedReason, artifactEncrypted, expiresAt, planFilesEncrypted });
}

/**
 * Plan di ripristino: riporta il target allo stato precedente a un'esecuzione. Oggetti aggiornati come erano
 * prima (dallo stato salvato prima della scrittura), oggetti creati cancellati. Poi approvazione ed esecuzione
 * come per ogni plan: il controllo di deriva vale anche qui.
 */
async function runRollbackPlan(job: JobRow, workDir: string, log: JobLog, setJob: SetJob) {
  const [apply] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.rollbackOfJobId!));
  if (!apply || apply.mode !== 'APPLY') throw new Error('Esecuzione da annullare non trovata');
  if (!apply.rollbackEncrypted) throw new Error("Stato precedente all'esecuzione non disponibile: ripristino non possibile");
  if (apply.targetEnvId !== job.targetEnvId) throw new Error("Il target non corrisponde a quello dell'esecuzione");
  const targetEnv = await getEnvironment(job.targetEnvId);
  const snapshot = openSnapshot(apply.rollbackEncrypted);
  if (snapshot.targetEnvId !== targetEnv.id) throw new Error("Lo stato salvato appartiene a un altro ambiente");

  log.info(
    `Ripristino su ${targetEnv.name}: stato precedente all'esecuzione ${apply.id} del ${apply.createdAt.toISOString()} ` +
      `(salvato il ${snapshot.takenAt})`,
  );
  log.info('SIMULAZIONE: nessuna modifica verrà applicata');
  if (!snapshot.imports.length && !snapshot.created.length) throw new Error("L'esecuzione non ha modificato nulla di ripristinabile");

  const tgtCreds = credsOf(targetEnv);
  const exportDir = path.join(workDir, 'export');
  await mkdir(exportDir, { recursive: true });
  const { allowedDeletes, allowedReplaces } = await prepareRollback({
    snapshot,
    dir: exportDir,
    creds: tgtCreds,
    providerVersion: config.GENESYS_PROVIDER_VERSION,
    line: log.line,
    info: log.info,
  });

  const warnings = [
    "Gli oggetti tornano com'erano prima dell'esecuzione: eventuali modifiche fatte dopo vanno perse.",
    ...(allowedDeletes.size ? [`Oggetti creati dall'esecuzione che verranno cancellati: ${[...allowedDeletes].join(', ')}`] : []),
    ...snapshot.notRestorable.map((n) => `Non ripristinabile in automatico: ${n}`),
    ...(Object.keys(snapshot.cfg.resource ?? {}).some((t) => t.startsWith('genesyscloud_outbound_campaign') || t === 'genesyscloud_outbound_sequence')
      ? ['Campaigns e Campaign Sequences restano spente anche se prima erano attive: si riavviano a mano.']
      : []),
  ];
  if (allowedReplaces.size) {
    warnings.push(`Oggetti ricreati dall'esecuzione che vengono ricreati com'erano prima (nuovo ID): ${[...allowedReplaces].join(', ')}`);
  }
  await savePlan({ exportDir, targetEnv, tgtCreds, log, setJob, warnings, allowedDeletes, allowedReplaces });
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

    // ---- Stato attuale degli oggetti che verranno modificati, per un eventuale ripristino ----
    log.info(`Salvataggio dello stato attuale su ${targetEnv.name} degli oggetti da aggiornare (sola lettura), per il ripristino`);
    let snapshot: RollbackSnapshot;
    try {
      snapshot = await takeRollbackSnapshot({
        plan: saved,
        targetEnv,
        creds: tgtCreds,
        workDir: path.join(workDir, 'snapshot'),
        line: log.line,
        info: log.info,
      });
    } catch (e) {
      throw new Error(
        `Impossibile salvare lo stato attuale per il ripristino: nessuna modifica applicata. ${(e as Error).message}`,
      );
    }

    // ---- Applicazione del piano salvato ----
    log.info(`Scrittura su ${targetEnv.name}: applicazione del piano salvato`);
    const res = await terraform(['apply', '-no-color', '-input=false', artifact.planFile], dir, tgtCreds, log.line);
    const applied = appliedFromOutput(res.output);
    // Oggetti creati (anche con esito parziale): nel ripristino vanno cancellati
    snapshot.created = await createdResources(dir, saved);
    await resolveReplacedIds(dir, snapshot);
    await setJob({ appliedResources: applied, rollbackEncrypted: sealSnapshot(snapshot) });
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
