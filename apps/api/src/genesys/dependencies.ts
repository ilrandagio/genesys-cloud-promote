import { CATALOG, flowDependencyType, fromDependencyType, listObjects } from './catalog.js';
import { GenesysClient, NotFoundError, PermissionError } from './client.js';
import { idKey, idTokens } from './ids.js';
import { DIVISIONED_TYPES, toDivision, type DependencyNode, type GcObjectRef, type ObjectType } from './types.js';

type Get = (path: string) => Promise<any>;

/** Tipi che una configurazione (script, flow) può referenziare */
const REFERENCE_TYPES: ObjectType[] = (
  [
    'dataaction',
    'datatable',
    'queue',
    'flow',
    'wrapupcode',
    'skill',
    'language',
    'prompt',
    'schedule',
    'schedulegroup',
    'emergencygroup',
    'integration',
    'script',
  ] as ObjectType[]
).concat(
  // Outbound, messaging e canned response: referenziati per ID nei dettagli degli oggetti
  [
    'campaign',
    'messagingcampaign',
    'sequence',
    'contactlist',
    'contactlistfilter',
    'dnclist',
    'callanalysisresponseset',
    'ruleset',
    'digitalruleset',
    'campaignrule',
    'attemptlimit',
    'callabletimeset',
    'filespectemplate',
    'site',
    'edgegroup',
    'webconfig',
    'webdeployment',
    'supportedcontent',
    'responselibrary',
    'response',
    'responseasset',
  ] as ObjectType[],
);

/**
 * Tipi che possono essere referenziati anche per nome (es. data action e data table nelle azioni
 * Architect). Il match è sul valore esatto di una stringa, solo per nomi univoci di almeno 4 caratteri.
 */
const NAME_REFERENCE_TYPES = new Set<ObjectType>(['dataaction', 'datatable', 'flow', 'emergencygroup', 'schedulegroup']);
const MIN_NAME_LENGTH = 4;

/**
 * Nei flow Architect i riferimenti sono per nome: lì il riconoscimento per nome vale per tutti i tipi,
 * anche con nomi brevi (code e skill hanno spesso nomi corti) e anche se lo stesso nome esiste in più tipi.
 */
const MIN_FLOW_NAME_LENGTH = 2;

/** Espressioni Architect che non sono nomi di oggetti (variabili, funzioni) */
const ARCHITECT_EXPRESSION = /^(flow|task|state|common|session|interaction|call|message|email|system|memory|slot|bot|workflow)\./i;
/** Prompt referenziati come "Prompt.<nome>" */
const PROMPT_REFERENCE = /^prompt\.(.+)$/i;

interface IdIndexEntry {
  type: ObjectType;
  /** ID originale (con eventuale prefisso, es. custom_-_...) */
  id: string;
  name: string;
  subtype?: string;
}

export interface IdIndex {
  byId: Map<string, IdIndexEntry>;
  /** Nome (minuscolo) -> oggetto, solo per i tipi in NAME_REFERENCE_TYPES e solo se il nome è univoco */
  byName: Map<string, IdIndexEntry>;
  /** Nome (minuscolo) -> tutti gli oggetti con quel nome, di qualunque tipo (usato per i flow) */
  byNameAll: Map<string, IdIndexEntry[]>;
  /** Tipi che non è stato possibile leggere (permessi o endpoint non disponibile) */
  unreadable: string[];
}

/**
 * Indice degli oggetti dell'org sorgente, costruito una sola volta per analisi
 * e solo se serve (quando si incontra uno script o un flow). I tipi non leggibili vengono saltati.
 */
export function lazyIdIndex(client: GenesysClient) {
  let index: Promise<IdIndex> | undefined;
  const get = () =>
    (index ??= (async () => {
      const byId = new Map<string, IdIndexEntry>();
      const names = new Map<string, IdIndexEntry[]>();
      const byNameAll = new Map<string, IdIndexEntry[]>();
      const unreadable: string[] = [];
      for (const type of REFERENCE_TYPES) {
        try {
          for (const o of await listObjects(client, type)) {
            const entry: IdIndexEntry = {
              type,
              id: String(o.id),
              name: o.name ?? String(o.id),
              subtype: type === 'flow' ? o.type : undefined,
            };
            byId.set(idKey(entry.id), entry);
            const k = entry.name.trim().toLowerCase();
            if (k.length >= MIN_FLOW_NAME_LENGTH) byNameAll.set(k, [...(byNameAll.get(k) ?? []), entry]);
            if (NAME_REFERENCE_TYPES.has(type) && entry.name.length >= MIN_NAME_LENGTH) {
              names.set(k, [...(names.get(k) ?? []), entry]);
            }
          }
        } catch (e) {
          // Un tipo non leggibile (permessi, endpoint non disponibile) non deve far perdere gli altri
          if (!(e instanceof PermissionError) && !(e instanceof NotFoundError)) throw e;
          unreadable.push(CATALOG[type].label);
        }
      }
      const byName = new Map([...names].filter(([, list]) => list.length === 1).map(([k, list]) => [k, list[0]]));
      return { byId, byName, byNameAll, unreadable };
    })());
  /** L'indice, solo se è già stato costruito durante l'analisi */
  return Object.assign(get, { peek: () => index });
}

interface RawDep {
  type: ObjectType | undefined;
  rawType: string;
  id: string;
  name: string;
  subtype?: string;
}

/** Dipendenze non leggibili per un motivo noto: il nodo viene mostrato con il messaggio, l'analisi prosegue */
class DependencyReadError extends Error {}

/**
 * Tutte le stringhe contenute in una struttura JSON (valori e, se richiesto, anche chiavi:
 * in alcune azioni Architect il nome dell'oggetto è la chiave del blocco, es. dataAction: { "<nome>": {...} }).
 */
function stringValues(value: unknown, includeKeys: boolean, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') out.add(value.trim().toLowerCase());
  else if (Array.isArray(value)) value.forEach((v) => stringValues(v, includeKeys, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (includeKeys) out.add(k.trim().toLowerCase());
      stringValues(v, includeKeys, out);
    }
  }
  return out;
}

/**
 * Cerca in una configurazione i riferimenti a oggetti dell'org:
 * - per ID, con o senza prefisso (custom_-_<guid> per le data action);
 * - per nome esatto. Nei flow (mode "flow") i riferimenti sono per nome: valgono tutti i tipi, anche nomi
 *   brevi e nomi presenti in più tipi, e i prompt nella forma "Prompt.<nome>". Negli script (mode "script")
 *   solo nomi univoci dei tipi principali, perché lì i nomi compaiono anche come testo libero.
 * Gli ID interni (pagine, componenti, task, azioni, variabili...) e l'oggetto stesso vengono ignorati.
 */
function scanReferences(value: unknown, index: IdIndex, self: GcObjectRef, mode: 'flow' | 'script' | 'id'): RawDep[] {
  const deps = new Map<string, RawDep>();
  const add = (hit: IdIndexEntry, byName: boolean) => {
    if (idKey(hit.id) === idKey(self.id)) return;
    const key = `${hit.type}:${idKey(hit.id)}`;
    if (deps.has(key)) return;
    deps.set(key, {
      type: hit.type,
      rawType: byName ? `${hit.type.toUpperCase()} (per nome)` : hit.type.toUpperCase(),
      id: hit.id,
      name: hit.name,
      subtype: hit.subtype,
    });
  };

  for (const token of idTokens(JSON.stringify(value))) {
    const hit = index.byId.get(token);
    if (hit) add(hit, false);
  }

  // "id": solo riferimenti per ID (dettaglio di un oggetto della Platform API, dove i riferimenti sono sempre ID)
  if (mode === 'id') return [...deps.values()];

  const selfName = self.name.trim().toLowerCase();
  for (const str of stringValues(value, mode === 'flow')) {
    if (!str || str === selfName) continue;
    if (mode === 'script') {
      const hit = index.byName.get(str);
      if (hit) add(hit, true);
      continue;
    }
    const prompt = str.match(PROMPT_REFERENCE);
    if (prompt) {
      for (const hit of index.byNameAll.get(prompt[1].trim()) ?? []) if (hit.type === 'prompt') add(hit, true);
      continue;
    }
    if (ARCHITECT_EXPRESSION.test(str)) continue;
    for (const hit of index.byNameAll.get(str) ?? []) add(hit, true);
  }
  return [...deps.values()];
}

/**
 * Risolve le dipendenze dirette di un oggetto sul sorgente.
 * - Flow: Dependency Tracking API + ID trovati nella configurazione del flow (unione delle due).
 * - Script: ID trovati nel JSON esportato.
 * - Altri tipi: lettura della configurazione.
 */
async function directDependencies(
  client: GenesysClient,
  get: Get,
  obj: GcObjectRef,
  idIndex: () => Promise<IdIndex>,
): Promise<RawDep[]> {
  switch (obj.type) {
    case 'script': {
      // Gli script contengono ID in chiaro: si cercano tutti i GUID nel JSON esportato
      // e si riconoscono confrontandoli con gli oggetti dell'org sorgente.
      return scanReferences(await client.exportScript(obj.id), await idIndex(), obj, 'script');
    }

    case 'flow': {
      const flow = await get(`/api/v2/flows/${obj.id}`);
      const deps: RawDep[] = [];
      const problems: string[] = [];

      // 1. Dependency Tracking API: affidabile solo se Genesys ha già calcolato le dipendenze del flow
      try {
        const res = await get(
          `/api/v2/architect/dependencytracking/object?id=${obj.id}&objectType=${flowDependencyType(flow.type)}&consumedResources=true`,
        );
        const entity = Array.isArray(res?.entities) ? res.entities[0] : res;
        for (const d of (entity?.consumedResources ?? []) as any[]) {
          if (!d.deleted) deps.push({ type: fromDependencyType(d.type), rawType: d.type, id: d.id, name: d.name ?? d.id });
        }
      } catch (e) {
        if (e instanceof PermissionError) problems.push(e.message);
        else if (!(e instanceof NotFoundError)) throw e;
      }

      // 2. Configurazione del flow: gli ID degli oggetti usati (data action, code, altri flow, prompt...)
      try {
        const configuration = await get(`/api/v2/flows/${obj.id}/latestconfiguration`);
        deps.push(...scanReferences(configuration, await idIndex(), obj, 'flow'));
      } catch (e) {
        if (e instanceof PermissionError) problems.push(e.message);
        else if (e instanceof NotFoundError) problems.push(`Configurazione del flow "${obj.name}" non disponibile (mai pubblicato o salvato?)`);
        else throw e;
      }

      if (!deps.length && problems.length) throw new DependencyReadError(problems.join('\n'));
      return deps;
    }

    case 'queue': {
      const q = await get(`/api/v2/routing/queues/${obj.id}`);
      const deps: RawDep[] = [];
      for (const key of ['queueFlow', 'emailInQueueFlow', 'messageInQueueFlow'] as const) {
        if (q[key]?.id) deps.push({ type: 'flow', rawType: 'FLOW', id: q[key].id, name: q[key].name ?? q[key].id });
      }
      if (q.whisperPrompt?.id) {
        deps.push({ type: 'prompt', rawType: 'USERPROMPT', id: q.whisperPrompt.id, name: q.whisperPrompt.name ?? q.whisperPrompt.id });
      }
      for (const rule of q.bullseye?.rings ?? []) {
        for (const s of rule.skillsToRemove ?? []) {
          deps.push({ type: 'skill', rawType: 'ACDSKILL', id: s.id, name: s.name ?? s.id });
        }
      }
      const wrapups = await client.listAll(`/api/v2/routing/queues/${obj.id}/wrapupcodes`);
      for (const w of wrapups) deps.push({ type: 'wrapupcode', rawType: 'ACDWRAPUPCODE', id: w.id, name: w.name });
      return deps;
    }

    case 'dataaction': {
      const a = await get(`/api/v2/integrations/actions/${obj.id}`);
      return a.integrationId
        ? [{ type: 'integration', rawType: 'INTEGRATION', id: a.integrationId, name: await nameOf(get, 'integration', a.integrationId) }]
        : [];
    }

    case 'schedulegroup': {
      const g = await get(`/api/v2/architect/schedulegroups/${obj.id}`);
      return [...(g.openSchedules ?? []), ...(g.closedSchedules ?? []), ...(g.holidaySchedules ?? [])].map((s: any) => ({
        type: 'schedule' as const,
        rawType: 'SCHEDULE',
        id: s.id,
        name: s.name ?? s.id,
      }));
    }

    case 'division':
      return [];

    default: {
      // Tutti gli altri tipi (outbound, messaging, canned response, routing...): il dettaglio della Platform API
      // contiene i riferimenti come ID (contactList, queue, script, callAnalysisResponseSet, assets, flow...)
      const detail = await get(CATALOG[obj.type].getPath.replace('{id}', encodeURIComponent(obj.id)));
      return scanReferences(detail, await idIndex(), obj, 'id');
    }
  }
}

async function nameOf(get: Get, type: ObjectType, id: string): Promise<string> {
  try {
    const o = await get(CATALOG[type].getPath.replace('{id}', id));
    return o.name ?? id;
  } catch {
    return id;
  }
}

/** Costruisce l'albero completo delle dipendenze (ricorsivo, con protezione dai cicli). */
export async function buildDependencyTree(
  client: GenesysClient,
  root: GcObjectRef,
  options: { includeDivisions?: boolean; maxDepth?: number; idIndex?: ReturnType<typeof lazyIdIndex> } = {},
): Promise<DependencyNode> {
  const { includeDivisions = false, maxDepth = 12 } = options;
  // Ramo già calcolato per ogni oggetto: se l'oggetto ricompare altrove si mostra di nuovo
  // con tutte le sue dipendenze, senza rileggerlo
  const built = new Map<string, DependencyNode>();
  // Ogni oggetto viene letto una sola volta per analisi, anche se compare più volte
  const memo = new Map<string, Promise<any>>();
  // Indice condivisibile tra più alberi della stessa analisi
  const idIndex = options.idIndex ?? lazyIdIndex(client);
  const get: Get = (path) => {
    if (!memo.has(path)) memo.set(path, client.get(path));
    return memo.get(path)!;
  };

  async function visit(
    obj: GcObjectRef,
    rawType: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<DependencyNode> {
    const key = `${obj.type}:${obj.id.toLowerCase()}`;
    const node: DependencyNode = { ...obj, rawType, supported: true, children: [] };
    // Solo un vero ciclo (A usa B che usa A) interrompe il ramo
    if (ancestors.has(key)) return { ...node, repeated: true };
    const done = built.get(key);
    if (done) return structuredClone({ ...done, rawType });
    if (depth >= maxDepth) return { ...node, error: `Profondità massima (${maxDepth}) raggiunta: dipendenze non analizzate` };
    const path = new Set(ancestors).add(key);

    let deps: RawDep[] = [];
    try {
      deps = await directDependencies(client, get, obj, idIndex);
    } catch (e) {
      if (e instanceof PermissionError) {
        node.error = e.message;
        // Anche se l'oggetto non è leggibile, Genesys indica in quale divisione si trova
        node.division = toDivision(e.divisions[0]);
      } else if (e instanceof DependencyReadError) {
        node.error = `Dipendenze non leggibili: ${e.message}`;
      } else if (e instanceof NotFoundError) {
        node.error = `Oggetto non trovato sul sorgente (${e.message})`;
      } else throw e;
    }

    // Divisione dell'oggetto: letta dalla configurazione (o dal 403) e, se richiesto, aggiunta come dipendenza
    if (DIVISIONED_TYPES.has(obj.type) && !node.division) {
      try {
        const full = await get(CATALOG[obj.type].getPath.replace('{id}', obj.id));
        node.division = toDivision(full?.division);
      } catch (e) {
        if (!(e instanceof PermissionError) && !(e instanceof NotFoundError)) throw e;
      }
    }
    if (includeDivisions && node.division?.id) {
      deps.unshift({ type: 'division', rawType: 'DIVISION', id: node.division.id, name: node.division.name });
    }

    // Per i flow serve il sottotipo per il match sul target
    for (const d of deps) {
      if (d.type === 'flow' && !d.subtype) {
        try {
          d.subtype = (await get(`/api/v2/flows/${d.id}`)).type;
        } catch {
          /* flow non leggibile: resta senza sottotipo */
        }
      }
    }

    // Deduplica dipendenze dirette
    // Lo stesso oggetto può arrivare da più fonti (Dependency Tracking e configurazione): vince la prima
    const unique = new Map<string, RawDep>();
    for (const d of deps) {
      const key = `${d.type ?? d.rawType}:${d.id.toLowerCase()}`;
      if (!unique.has(key)) unique.set(key, d);
    }
    for (const d of unique.values()) {
      if (!d.type) {
        node.children.push({ type: 'flow', id: d.id, name: d.name, rawType: d.rawType, supported: false, children: [] });
        continue;
      }
      node.children.push(await visit({ type: d.type, id: d.id, name: d.name, subtype: d.subtype }, d.rawType, depth + 1, path));
    }
    built.set(key, node);
    return node;
  }

  return visit(root, root.type.toUpperCase(), 0, new Set());
}

/** Appiattisce l'albero in un elenco unico di oggetti supportati (ordine: prima le foglie) */
export function flatten(tree: DependencyNode): DependencyNode[] {
  const out = new Map<string, DependencyNode>();
  const walk = (n: DependencyNode) => {
    n.children.forEach(walk);
    if (n.supported && !n.repeated) out.set(`${n.type}:${n.id}`, n);
  };
  walk(tree);
  return [...out.values()];
}
