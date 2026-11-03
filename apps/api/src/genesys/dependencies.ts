import { CATALOG, flowDependencyType, fromDependencyType } from './catalog.js';
import { GenesysClient, NotFoundError, PermissionError } from './client.js';
import { DIVISIONED_TYPES, type DependencyNode, type GcObjectRef, type ObjectType } from './types.js';

type Get = (path: string) => Promise<any>;

interface RawDep {
  type: ObjectType | undefined;
  rawType: string;
  id: string;
  name: string;
  subtype?: string;
}

/**
 * Risolve le dipendenze dirette di un oggetto sul sorgente.
 * Flow: Dependency Tracking API. Altri tipi: lettura della configurazione.
 */
async function directDependencies(client: GenesysClient, get: Get, obj: GcObjectRef): Promise<RawDep[]> {
  switch (obj.type) {
    case 'flow': {
      const flow = await get(`/api/v2/flows/${obj.id}`);
      const objectType = flowDependencyType(flow.type);
      const res = await get(
        `/api/v2/architect/dependencytracking/object?id=${obj.id}&objectType=${objectType}&consumedResources=true`,
      );
      // L'endpoint può restituire un oggetto singolo o una listing
      const entity = Array.isArray(res?.entities) ? res.entities[0] : res;
      const consumed: any[] = entity?.consumedResources ?? [];
      return consumed
        .filter((d) => !d.deleted)
        .map((d) => ({ type: fromDependencyType(d.type), rawType: d.type, id: d.id, name: d.name ?? d.id }));
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

    default:
      return [];
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
  options: { includeDivisions?: boolean; maxDepth?: number } = {},
): Promise<DependencyNode> {
  const { includeDivisions = false, maxDepth = 6 } = options;
  const seen = new Set<string>();
  // Ogni oggetto viene letto una sola volta per analisi, anche se compare più volte
  const memo = new Map<string, Promise<any>>();
  const get: Get = (path) => {
    if (!memo.has(path)) memo.set(path, client.get(path));
    return memo.get(path)!;
  };

  async function visit(obj: GcObjectRef, rawType: string, depth: number): Promise<DependencyNode> {
    const key = `${obj.type}:${obj.id}`;
    const node: DependencyNode = { ...obj, rawType, supported: true, children: [] };
    if (seen.has(key)) return { ...node, repeated: true };
    seen.add(key);
    if (depth >= maxDepth) return node;

    let deps: RawDep[] = [];
    try {
      deps = await directDependencies(client, get, obj);
    } catch (e) {
      if (e instanceof PermissionError) {
        node.error = e.message;
        // Anche se l'oggetto non è leggibile, Genesys indica in quale divisione si trova
        if (e.divisions[0]) node.division = e.divisions[0];
      } else if (!(e instanceof NotFoundError)) throw e;
    }

    // Divisione dell'oggetto: letta dalla configurazione (o dal 403) e, se richiesto, aggiunta come dipendenza
    if (DIVISIONED_TYPES.has(obj.type) && !node.division) {
      try {
        const full = await get(CATALOG[obj.type].getPath.replace('{id}', obj.id));
        if (full?.division?.id) node.division = { id: full.division.id, name: full.division.name ?? full.division.id };
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
    const unique = new Map(deps.map((d) => [`${d.rawType}:${d.id}`, d]));
    for (const d of unique.values()) {
      if (!d.type) {
        node.children.push({ type: 'flow', id: d.id, name: d.name, rawType: d.rawType, supported: false, children: [] });
        continue;
      }
      node.children.push(await visit({ type: d.type, id: d.id, name: d.name, subtype: d.subtype }, d.rawType, depth + 1));
    }
    return node;
  }

  return visit(root, root.type.toUpperCase(), 0);
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
