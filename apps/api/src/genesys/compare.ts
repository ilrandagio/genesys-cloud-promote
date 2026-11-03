import { CATALOG } from './catalog.js';
import { PermissionError, type GenesysClient } from './client.js';
import type { DependencyNode, DivisionRef, GcObjectRef, ObjectType, TargetInfo } from './types.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Campi che cambiano sempre tra org e non sono significativi per il confronto */
const VOLATILE = new Set([
  'id',
  'selfUri',
  'dateCreated',
  'dateModified',
  'createdBy',
  'modifiedBy',
  'version',
  'memberCount',
  'userMemberCount',
  'joinedMemberCount',
  'division',
  'state',
  'modifiedByApp',
  'createdByApp',
  'mediaUri',
  'resources',
]);

/** Rimuove campi volatili e GUID: i riferimenti vengono confrontati per nome */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof value === 'string' && GUID.test(value)) return '<id>';
  return value;
}

function diffKeys(a: any, b: any): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

/**
 * Confronta gli oggetti sorgente con il target (match per nome e, per i flow, per tipo).
 * Gli elenchi del target vengono letti una sola volta per tipo.
 */
export class TargetComparer {
  private targetLists = new Map<ObjectType, Promise<any[]>>();
  private sourceLists = new Map<ObjectType, Promise<any[]>>();
  private targetDivisions?: Promise<Set<string> | undefined>;

  constructor(
    private readonly source: GenesysClient,
    private readonly target: GenesysClient,
  ) {}

  private cached(cache: Map<ObjectType, Promise<any[]>>, client: GenesysClient, type: ObjectType) {
    if (!cache.has(type)) cache.set(type, client.listAll(CATALOG[type].listPath));
    return cache.get(type)!;
  }

  /** Nomi delle divisioni del target (undefined se il client non può leggerle) */
  private divisionsOnTarget() {
    this.targetDivisions ??= this.target
      .listAll('/api/v2/authorization/divisions')
      .then((ds) => new Set(ds.map((d: any) => String(d.name).toLowerCase())))
      .catch((e) => {
        if (e instanceof PermissionError) return undefined;
        throw e;
      });
    return this.targetDivisions;
  }

  /** Divisione dell'oggetto sul sorgente, letta dall'elenco del tipo (già paginato e in cache) */
  async sourceDivision(obj: GcObjectRef): Promise<DivisionRef | undefined> {
    try {
      const item = (await this.cached(this.sourceLists, this.source, obj.type)).find((o) => o.id === obj.id);
      return item?.division?.name ? { id: item.division.id, name: item.division.name } : undefined;
    } catch (e) {
      if (e instanceof PermissionError) return undefined;
      throw e;
    }
  }

  async compare(obj: GcObjectRef, sourceDivision?: DivisionRef): Promise<TargetInfo> {
    const divisionMissing = sourceDivision
      ? await this.divisionsOnTarget().then((set) => (set ? !set.has(sourceDivision.name.toLowerCase()) : undefined))
      : undefined;

    const candidates = await this.cached(this.targetLists, this.target, obj.type);
    const match = candidates.find(
      (c) =>
        c.name?.toLowerCase() === obj.name.toLowerCase() &&
        (obj.type !== 'flow' || !obj.subtype || c.type?.toUpperCase() === obj.subtype.toUpperCase()),
    );
    if (!match) return { status: 'missing', divisionMissing };

    const division: DivisionRef | undefined = match.division?.name
      ? { id: match.division.id, name: match.division.name }
      : undefined;
    const def = CATALOG[obj.type];
    if (!def.comparable) return { status: 'present', id: match.id, division, divisionMissing };

    const [src, tgt] = await Promise.all([
      this.source.get(def.getPath.replace('{id}', obj.id)),
      this.target.get(def.getPath.replace('{id}', match.id)),
    ]);
    const diff = diffKeys(normalize(src), normalize(tgt));
    if (sourceDivision && division && sourceDivision.name.toLowerCase() !== division.name.toLowerCase()) {
      diff.push('division');
    }
    return diff.length
      ? { status: 'different', id: match.id, diff, division, divisionMissing }
      : { status: 'same', id: match.id, division, divisionMissing };
  }

  /** Arricchisce ogni nodo dell'albero con divisione e stato sul target */
  async annotate(node: DependencyNode): Promise<void> {
    if (node.supported) {
      try {
        node.division ??= await this.sourceDivision(node);
        node.target = await this.compare(node, node.division);
      } catch (e) {
        if (!(e instanceof PermissionError)) throw e;
        node.error = node.error ? `${node.error}\n${e.message}` : e.message;
      }
    }
    for (const c of node.children) await this.annotate(c);
  }
}
