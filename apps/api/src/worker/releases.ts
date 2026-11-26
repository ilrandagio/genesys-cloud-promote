import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG } from '../genesys/catalog.js';
import { NotFoundError, type GenesysClient } from '../genesys/client.js';
import { normalize } from '../genesys/compare.js';
import type { ObjectType } from '../genesys/types.js';
import { db, schema } from '../lib/db.js';
import type { ReleaseObject } from '../lib/schema.js';
import type { PlanJson } from './planJson.js';

type Log = (msg: string) => void;

/** Tipo del catalogo dal tipo Terraform (undefined per i tipi generici) */
const BY_TF = new Map(Object.entries(CATALOG).map(([type, def]) => [def.tfType, type as ObjectType]));
export const catalogTypeOf = (tfType: string) => BY_TF.get(tfType);

/** Contenuto di un oggetto sul vivo, normalizzato come nel confronto dell'analisi */
export interface LiveContent {
  name: string;
  subtype?: string;
  content: unknown;
  version?: string;
}

/**
 * Legge un oggetto dall'org e lo normalizza. Flows: configurazione dell'ultima versione salvata
 * (latestconfiguration) e versione pubblicata. Scripts: contenuto esportato (pagine, componenti, azioni).
 * undefined se l'oggetto non esiste più.
 */
export async function liveContent(client: GenesysClient, type: ObjectType, id: string): Promise<LiveContent | undefined> {
  const def = CATALOG[type];
  try {
    const raw = await client.get<any>(def.getPath.replace('{id}', encodeURIComponent(id)));
    const name = String(raw?.name ?? id);
    if (type === 'flow') {
      const configuration = await client.get(`/api/v2/flows/${encodeURIComponent(id)}/latestconfiguration`).catch(() => undefined);
      return {
        name,
        subtype: raw?.type,
        content: normalize({ description: raw?.description, type: raw?.type, configuration }, type),
        version: raw?.publishedVersion?.version != null ? String(raw.publishedVersion.version) : undefined,
      };
    }
    if (type === 'script') {
      const exported = await client.exportScript(id).catch(() => raw);
      return { name, content: normalize(exported, type), version: raw?.versionId != null ? String(raw.versionId) : undefined };
    }
    return { name, content: normalize(raw, type) };
  } catch (e) {
    if (e instanceof NotFoundError) return undefined;
    throw e;
  }
}

interface StateResource {
  mode: string;
  type: string;
  name: string;
  instances: { attributes?: Record<string, any> }[];
}

/**
 * Dopo un'esecuzione di un plan con tag: salva per ogni risorsa effettivamente scritta lo stato letto dal target.
 * Esecuzione interrotta: solo le risorse scritte prima dell'errore. Ripristino: gli oggetti riportati allo
 * stato precedente (restored) o cancellati (deleted), legati all'esecuzione annullata.
 * Non interrompe mai l'esecuzione: un oggetto non leggibile viene salvato con l'errore.
 */
export async function captureRelease(opts: {
  tagId: string;
  applyJobId: string;
  /** Esecuzione annullata, se il plan è un ripristino */
  undoneJobId?: string;
  dir: string;
  plan: PlanJson;
  applied: string[];
  target: GenesysClient;
  log: Log;
}): Promise<number> {
  const { tagId, applyJobId, undoneJobId, dir, plan, applied, target, log } = opts;
  if (!applied.length) return 0;
  let state: { resources?: StateResource[] } = {};
  try {
    state = JSON.parse(await readFile(path.join(dir, 'terraform.tfstate'), 'utf8'));
  } catch {
    // senza state si usano i valori del piano
  }
  const attrsOf = new Map(
    (state.resources ?? []).filter((r) => r.mode === 'managed').map((r) => [`${r.type}.${r.name}`, r.instances?.[0]?.attributes]),
  );
  const changes = new Map((plan.resource_changes ?? []).map((rc) => [rc.address, rc]));

  const rows: (typeof schema.releaseObjects.$inferInsert)[] = [];
  for (const address of applied) {
    const rc = changes.get(address);
    const tfType = rc?.type ?? address.slice(0, address.indexOf('.'));
    const label = address.slice(address.indexOf('.') + 1);
    const attrs = attrsOf.get(address);
    const before = (rc?.change as any)?.before as Record<string, any> | undefined;
    const deleted = !attrs && (rc?.change.actions ?? []).includes('delete');
    const targetId: string | undefined = attrs?.id ?? before?.id;
    const type = catalogTypeOf(tfType);
    const kind = deleted ? 'deleted' : undoneJobId ? 'restored' : 'applied';
    const row: typeof schema.releaseObjects.$inferInsert = {
      tagId,
      jobId: applyJobId,
      kind,
      undoneJobId: undoneJobId ?? null,
      type: type ?? null,
      tfType,
      targetId: targetId ?? null,
      name: String(attrs?.name ?? before?.name ?? label),
      content: null,
      info: null,
    };
    if (!deleted) {
      if (type && targetId && !CATALOG[type].singleton) {
        try {
          const live = await liveContent(target, type, targetId);
          if (live) {
            row.name = live.name;
            row.subtype = live.subtype ?? null;
            row.content = live.content;
            row.info = { source: 'api', ...(live.version ? { version: live.version } : {}) };
          } else {
            row.info = { error: "Non trovato sul target dopo l'esecuzione" };
          }
        } catch (e) {
          row.info = { error: (e as Error).message };
        }
      } else if (attrs) {
        // Tipi generici e oggetti unici dell'org: attributi Terraform dallo state
        row.content = normalize(attrs);
        row.info = { source: 'state' };
      }
    }
    rows.push(row);
  }
  if (rows.length) await db.insert(schema.releaseObjects).values(rows);
  const errors = rows.filter((r) => r.info?.error);
  log(
    `Rilascio: salvata la versione di ${rows.length} oggetti` +
      (errors.length ? ` (${errors.length} non leggibili: ${errors.map((r) => r.name).join(', ')})` : ''),
  );
  return rows.length;
}

/** Chiave di un oggetto nello stesso ambiente: per ID sul target, altrimenti per tipo e nome */
export const objectKey = (o: Pick<ReleaseObject, 'tfType' | 'targetId' | 'name'>) =>
  `${o.tfType}:${(o.targetId ?? `name:${o.name}`).toLowerCase()}`;

/** Chiave tra ambienti diversi (gli ID cambiano): tipo, nome e, per i flow, tipo di flow */
export const crossEnvKey = (o: Pick<ReleaseObject, 'tfType' | 'name' | 'subtype'>) =>
  `${o.tfType}:${(o.subtype ?? '').toLowerCase()}:${o.name.trim().toLowerCase()}`;

export interface ManifestEntry {
  /** Versione valida dell'oggetto nel tag */
  object: ReleaseObject;
  /** Quante volte l'oggetto è stato portato nel tag */
  versions: number;
}

export interface Manifest {
  entries: ManifestEntry[];
  /** Oggetti portati nel tag ma annullati da un ripristino senza una versione precedente nel tag */
  undone: ReleaseObject[];
}

/**
 * Contenuto del tag: per ogni oggetto vale l'ultima versione portata (in ordine di esecuzione).
 * - Esecuzione interrotta: contano solo gli oggetti effettivamente scritti; una successiva esecuzione dello
 *   stesso tag che li completa li sostituisce.
 * - Ripristino di un'esecuzione: per ogni oggetto ripristinato escono dal tag la versione di quell'esecuzione e le
 *   successive (il ripristino le ha sovrascritte); vale di nuovo la versione precedente nello stesso tag, se c'è,
 *   altrimenti l'oggetto risulta annullato.
 */
export function buildManifest(objects: ReleaseObject[]): Manifest {
  const sorted = [...objects].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const stacks = new Map<string, ReleaseObject[]>();
  const undoneLast = new Map<string, ReleaseObject>();
  for (const o of sorted) {
    const key = objectKey(o);
    if (o.kind === 'applied') {
      stacks.set(key, [...(stacks.get(key) ?? []), o]);
      undoneLast.delete(key);
      continue;
    }
    // Ripristino: si tolgono le versioni dell'esecuzione annullata per lo stesso oggetto, riconosciuto per ID o,
    // se il ripristino lo ha ricreato con un nuovo ID, per tipo e nome
    const sameName = (x: ReleaseObject) => x.tfType === o.tfType && x.name.trim().toLowerCase() === o.name.trim().toLowerCase();
    for (const [k, stack] of stacks) {
      if (k !== key && !stack.some(sameName)) continue;
      // Il ripristino riporta l'oggetto a prima dell'esecuzione annullata: perdono valore anche le versioni
      // successive dello stesso oggetto (esecuzioni più recenti sovrascritte dal ripristino)
      const from = stack.findIndex((x) => x.jobId === o.undoneJobId);
      if (from < 0) continue;
      const removed = stack.slice(from);
      const remaining = stack.slice(0, from);
      stacks.set(k, remaining);
      if (!remaining.length) undoneLast.set(k, removed[removed.length - 1]);
    }
  }
  const entries: ManifestEntry[] = [];
  for (const stack of stacks.values()) {
    if (stack.length) entries.push({ object: stack[stack.length - 1], versions: stack.length });
  }
  entries.sort((a, b) => (a.object.tfType + a.object.name).localeCompare(b.object.tfType + b.object.name));
  return { entries, undone: [...undoneLast.values()] };
}
