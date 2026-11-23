import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CATALOG } from '../genesys/catalog.js';
import { GenesysClient } from '../genesys/client.js';
import type { ObjectType, PortItem } from '../genesys/types.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import type { Environment } from '../lib/schema.js';
import { collect } from './artifact.js';
import { dropFlowContentHash, normalizeFilePaths, selectResources, unexportedFiles, type TfJson } from './exportConfig.js';
import { exportObjects } from './exporter.js';
import type { PlanJson } from './planJson.js';
import { tfOrThrow, type TfCreds } from './terraform.js';
import { applyQueueMembership, applySafetyRules, restoreActionUrlTemplates } from './transforms.js';

/** Risorsa dello state di Terraform (formato v4), quanto serve qui */
interface StateResource {
  mode: string;
  type: string;
  name: string;
  provider: string;
  instances: unknown[];
}

/**
 * Stato del target prima di un'esecuzione, per poterla annullare:
 * - cfg + files: configurazione degli oggetti che l'esecuzione aggiorna, esportata dal target subito prima di
 *   scrivere e già pronta per essere riapplicata (con i file referenziati: YAML dei flow, script, audio...);
 * - imports: ID sul target di quelle risorse;
 * - created: risorse create dall'esecuzione (dallo state dopo l'apply), da cancellare nel ripristino;
 * - notRestorable: ciò che non si può ripristinare in automatico.
 */
export interface RollbackSnapshot {
  version: 1;
  targetEnvId: string;
  takenAt: string;
  cfg: TfJson;
  files: Record<string, string>;
  /**
   * Risorse da importare dal target. replaced: ricreata dall'esecuzione (nuovo ID, letto dallo state dopo
   * l'apply tramite planAddress): il ripristino la ricrea com'era
   */
  imports: { address: string; id: string; label: string; planAddress?: string; replaced?: boolean }[];
  created: StateResource[];
  notRestorable: string[];
}

/** Risorse costruite dal worker (non esportabili singolarmente): si ripristinano dai valori precedenti del plan */
const FROM_PRIOR_VALUES = new Set([
  'genesyscloud_outbound_wrapupcodemappings',
  'genesyscloud_group_roles',
  'genesyscloud_architect_datatable_row',
]);

const typeOfResource = (tfType: string): ObjectType | undefined =>
  (Object.entries(CATALOG) as [ObjectType, (typeof CATALOG)[ObjectType]][]).find(([, d]) => d.tfType === tfType)?.[0];

/** Valori dello state come configurazione: senza "id" e senza attributi nulli */
function configFromValues(values: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== null && x !== undefined)
          .map(([k, x]) => [k, clean(x)]),
      );
    }
    return v;
  };
  const { id: _id, ...rest } = values;
  return clean(rest) as Record<string, unknown>;
}

/** Sostituisce i riferimenti a risorse non tenute (${tipo.label.id}) con l'ID letterale preso dallo state */
function resolveDanglingRefs(cfg: TfJson, kept: Set<string>, idByAddress: Map<string, string>) {
  const unresolved = new Set<string>();
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\$\{([a-z0-9_]+\.[A-Za-z0-9_-]+)\.id\}/g, (m, addr: string) => {
        if (kept.has(addr)) return m;
        const id = idByAddress.get(addr);
        if (!id) unresolved.add(addr);
        return id ?? m;
      });
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
    for (const label of Object.keys(labels)) cfg.resource![type][label] = fix(labels[label]) as any;
  }
  if (unresolved.size) throw new Error(`Riferimenti non risolvibili nello stato salvato: ${[...unresolved].join(', ')}`);
}

/**
 * Prima di un'esecuzione: salva lo stato attuale sul target degli oggetti che il plan aggiorna.
 * Un errore qui ferma l'esecuzione prima di scrivere: senza stato precedente non c'è ripristino.
 */
export async function takeRollbackSnapshot(opts: {
  plan: PlanJson;
  targetEnv: Environment;
  creds: TfCreds;
  workDir: string;
  line: (l: string) => void;
  info: (l: string) => void;
}): Promise<RollbackSnapshot> {
  const { plan, targetEnv, creds, workDir, line, info } = opts;
  const client = new GenesysClient(targetEnv);
  const snapshot: RollbackSnapshot = {
    version: 1,
    targetEnvId: targetEnv.id,
    takenAt: new Date().toISOString(),
    cfg: { resource: {} },
    files: {},
    imports: [],
    created: [],
    notRestorable: [],
  };

  const toExport: PortItem[] = [];
  const planInfo = new Map<PortItem, { planAddress: string; replaced: boolean }>();
  for (const rc of plan.resource_changes ?? []) {
    const actions = rc.change.actions;
    if (rc.mode && rc.mode !== 'managed') continue;
    const type = rc.type ?? rc.address.split('.')[0];
    const label = rc.name ?? rc.address.split('.').slice(1).join('.');
    if (actions.includes('delete') && !actions.includes('create')) {
      snapshot.notRestorable.push(`${rc.address}: cancellato dall'esecuzione, non si ricrea in automatico`);
      continue;
    }
    const replaced = actions.includes('delete') && actions.includes('create');
    if (!actions.includes('update') && !replaced) continue;
    const before = (rc.change.before ?? {}) as Record<string, unknown>;
    const id = typeof before.id === 'string' ? before.id : undefined;
    if (!id) {
      snapshot.notRestorable.push(`${rc.address}: ID sul target non noto`);
      continue;
    }
    if (FROM_PRIOR_VALUES.has(type)) {
      snapshot.cfg.resource![type] ??= {};
      snapshot.cfg.resource![type][label] = configFromValues(before) as any;
      snapshot.imports.push({ address: `${type}.${label}`, id, label: rc.address, planAddress: rc.address, replaced });
      continue;
    }
    const objectType = typeOfResource(type);
    if (!objectType) {
      snapshot.notRestorable.push(`${rc.address}: tipo Terraform generico, non ripristinabile in automatico`);
      continue;
    }
    // Nome e (per i Flows) tipo attuali sul target: servono a trovarlo nell'export
    const current = await client.get<any>(CATALOG[objectType].getPath.replace('{id}', encodeURIComponent(id)));
    const pending: PortItem = {
      type: objectType,
      id,
      name: String(current?.name ?? ''),
      subtype: objectType === 'flow' && current?.type ? String(current.type) : undefined,
      action: 'port',
      targetStatus: 'different',
      targetId: id,
    };
    toExport.push(pending);
    planInfo.set(pending, { planAddress: rc.address, replaced });
  }

  if (toExport.length) {
    const exportDir = path.join(workDir, 'export');
    const { cfg, cfgPath } = await exportObjects({
      items: toExport,
      runnerDir: path.join(workDir, 'runner'),
      exportDir,
      creds,
      orgName: targetEnv.name,
      line,
      info,
    });
    normalizeFilePaths(cfg);
    dropFlowContentHash(cfg);
    const match = new Map<PortItem, Record<string, string>>();
    for (const it of toExport.filter((i) => i.type === 'dataaction')) {
      const a = await client.get<{ integrationId?: string }>(CATALOG.dataaction.getPath.replace('{id}', encodeURIComponent(it.id)));
      if (a.integrationId) match.set(it, { integration_id: a.integrationId });
    }
    const addresses = selectResources(cfg, toExport, match);
    // Oggetti che l'export del target non restituisce (per esempio uno Script non pubblicato): il rilascio
    // prosegue, ma per loro il ripristino non sarà disponibile, e lo si dice chiaramente
    for (const m of toExport.filter((i) => !addresses.has(i))) {
      const what = `${CATALOG[m.type].label} "${m.name}"`;
      snapshot.notRestorable.push(
        `${what}: l'export del target non lo restituisce` +
          (m.type === 'script' ? ' (di solito perché sul target non è pubblicato)' : '') +
          ', quindi non si può riportare com\'era prima',
      );
      info(`ATTENZIONE: stato attuale di ${what} non salvato: per questo oggetto il ripristino non sarà disponibile`);
    }
    // Solo le risorse da ripristinare; i riferimenti alle altre diventano ID letterali (stesso target)
    const kept = new Set(addresses.values());
    const idByAddress = new Map<string, string>();
    for (const [it, addr] of addresses) idByAddress.set(addr, it.id);
    for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
      for (const label of Object.keys(labels)) {
        if (!kept.has(`${type}.${label}`)) delete cfg.resource![type][label];
      }
      if (!Object.keys(cfg.resource![type]).length) delete cfg.resource![type];
    }
    resolveDanglingRefs(cfg, kept, idByAddress);
    // Stesse regole del porting: URL delle Data Actions rilette (ora, prima della scrittura), membri e
    // indirizzi delle Queues di oggi, campagne spente
    await restoreActionUrlTemplates(cfg, addresses, client, info);
    await applyQueueMembership(cfg, addresses, client, info);
    applySafetyRules(cfg, info);
    const unexported = unexportedFiles(cfg);
    if (unexported.length) throw new Error(`File non esportati dal target per: ${unexported.join(', ')}`);

    for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
      snapshot.cfg.resource![type] = { ...(snapshot.cfg.resource![type] ?? {}), ...labels };
    }
    if (cfg.data) snapshot.cfg.data = cfg.data;
    for (const [it, addr] of addresses) {
      snapshot.imports.push({ address: addr, id: it.id, label: `${CATALOG[it.type].label} "${it.name}"`, ...planInfo.get(it) });
    }
    const cfgName = path.basename(cfgPath);
    for (const [rel, b64] of Object.entries(await collect(exportDir))) {
      if (rel !== cfgName && !/\.tfstate(\.backup)?$/i.test(rel)) snapshot.files[rel] = b64;
    }
  }
  info(
    `Stato precedente salvato per il ripristino: ${snapshot.imports.length} oggetti` +
      (snapshot.notRestorable.length ? `; non ripristinabili in automatico: ${snapshot.notRestorable.join('; ')}` : ''),
  );
  return snapshot;
}

/** Dopo un'esecuzione (anche interrotta): le risorse create, lette dallo state, da cancellare nel ripristino */
export async function createdResources(dir: string, plan: PlanJson): Promise<StateResource[]> {
  const created = new Set(
    (plan.resource_changes ?? [])
      .filter((rc) => rc.change.actions.length === 1 && rc.change.actions[0] === 'create')
      .map((rc) => rc.address),
  );
  if (!created.size) return [];
  let state: { resources?: StateResource[] };
  try {
    state = JSON.parse(await readFile(path.join(dir, 'terraform.tfstate'), 'utf8'));
  } catch {
    return [];
  }
  return (state.resources ?? []).filter((r) => r.mode === 'managed' && created.has(`${r.type}.${r.name}`));
}

/**
 * Dopo un'esecuzione: le risorse ricreate hanno un nuovo ID sul target, letto dallo state. Se una ricreazione
 * non è avvenuta (esecuzione interrotta) resta l'ID precedente, che è ancora quello valido.
 */
export async function resolveReplacedIds(dir: string, snapshot: RollbackSnapshot) {
  if (!snapshot.imports.some((i) => i.replaced)) return;
  let state: { resources?: { mode: string; type: string; name: string; instances: { attributes?: { id?: string } }[] }[] };
  try {
    state = JSON.parse(await readFile(path.join(dir, 'terraform.tfstate'), 'utf8'));
  } catch {
    return;
  }
  const idOf = new Map<string, string | undefined>(
    (state.resources ?? [])
      .filter((r) => r.mode === 'managed')
      .map((r): [string, string | undefined] => [`${r.type}.${r.name}`, r.instances?.[0]?.attributes?.id]),
  );
  for (const i of snapshot.imports) {
    const id = i.replaced && i.planAddress ? idOf.get(i.planAddress) : undefined;
    if (id) i.id = id;
  }
}

export const sealSnapshot = (s: RollbackSnapshot) => encrypt(JSON.stringify(s));

export function openSnapshot(encrypted: string): RollbackSnapshot {
  const s = JSON.parse(decrypt(encrypted)) as RollbackSnapshot;
  if (s.version !== 1) throw new Error(`Versione dello stato salvato non supportata: ${s.version}`);
  return s;
}

/**
 * Prepara nella cartella "dir" la configurazione del ripristino: oggetti aggiornati come erano prima
 * (importati dal target con il loro ID) e oggetti creati dall'esecuzione nello state senza configurazione,
 * così il plan li cancella. Restituisce gli indirizzi delle cancellazioni ammesse.
 */
export async function prepareRollback(opts: {
  snapshot: RollbackSnapshot;
  dir: string;
  creds: TfCreds;
  providerVersion: string;
  line: (l: string) => void;
  info: (l: string) => void;
}): Promise<{ allowedDeletes: Set<string>; allowedReplaces: Set<string> }> {
  const { snapshot, dir, creds, providerVersion, line, info } = opts;
  for (const [rel, b64] of Object.entries(snapshot.files)) {
    const full = path.resolve(dir, ...rel.split('/'));
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Percorso non valido nello stato salvato: ${rel}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(b64, 'base64'));
  }
  const cfg: TfJson = JSON.parse(JSON.stringify(snapshot.cfg));
  cfg.terraform = { required_providers: { genesyscloud: { source: 'mypurecloud/genesyscloud', version: providerVersion } } };
  await writeFile(path.join(dir, 'genesyscloud.tf.json'), JSON.stringify(cfg, null, 2));

  await tfOrThrow(['init', '-no-color', '-input=false'], dir, creds, line);
  for (const { address, id, label } of snapshot.imports) {
    info(`Import di ${label} dal target (${address})`);
    await tfOrThrow(['import', '-no-color', '-input=false', address, id], dir, creds, line);
  }

  // Oggetti creati dall'esecuzione: nello state ma non nella configurazione, quindi il plan li cancella
  const allowedDeletes = new Set<string>();
  if (snapshot.created.length) {
    const statePath = path.join(dir, 'terraform.tfstate');
    let state: any;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      const ver = await tfOrThrow(['version', '-json'], dir, creds, () => {});
      const tfVersion = /"terraform_version"\s*:\s*"([\d.]+)"/.exec(ver.output)?.[1] ?? '1.5.0';
      state = { version: 4, terraform_version: tfVersion, serial: 0, lineage: randomUUID(), outputs: {}, resources: [], check_results: null };
    }
    const taken = new Set<string>((state.resources ?? []).map((r: StateResource) => `${r.type}.${r.name}`));
    for (const [type, labels] of Object.entries(cfg.resource ?? {})) for (const l of Object.keys(labels)) taken.add(`${type}.${l}`);
    for (const r of snapshot.created) {
      let name = r.name;
      for (let n = 2; taken.has(`${r.type}.${name}`); n++) name = `${r.name}_creato${n > 2 ? n : ''}`;
      taken.add(`${r.type}.${name}`);
      state.resources.push({ ...r, name });
      allowedDeletes.add(`${r.type}.${name}`);
    }
    state.serial = (state.serial ?? 0) + 1;
    await writeFile(statePath, JSON.stringify(state, null, 2));
    info(`Oggetti creati dall'esecuzione, da cancellare: ${[...allowedDeletes].join(', ')}`);
  }
  // Oggetti ricreati dall'esecuzione: per tornare alla versione precedente vanno ricreati di nuovo
  const allowedReplaces = new Set(snapshot.imports.filter((i) => i.replaced).map((i) => i.address));
  return { allowedDeletes, allowedReplaces };
}
