import { CATALOG } from './catalog.js';
import { PermissionError, type GenesysClient } from './client.js';
import type { DependencyNode, GcObjectRef, ObjectType, TargetInfo } from './types.js';

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
  private lists = new Map<ObjectType, Promise<any[]>>();

  constructor(
    private readonly source: GenesysClient,
    private readonly target: GenesysClient,
  ) {}

  private list(type: ObjectType) {
    if (!this.lists.has(type)) this.lists.set(type, this.target.listAll(CATALOG[type].listPath));
    return this.lists.get(type)!;
  }

  async compare(obj: GcObjectRef): Promise<TargetInfo> {
    const candidates = await this.list(obj.type);
    const match = candidates.find(
      (c) =>
        c.name?.toLowerCase() === obj.name.toLowerCase() &&
        (obj.type !== 'flow' || !obj.subtype || c.type?.toUpperCase() === obj.subtype.toUpperCase()),
    );
    if (!match) return { status: 'missing' };

    const def = CATALOG[obj.type];
    if (!def.comparable) return { status: 'present', id: match.id };

    const [src, tgt] = await Promise.all([
      this.source.get(def.getPath.replace('{id}', obj.id)),
      this.target.get(def.getPath.replace('{id}', match.id)),
    ]);
    const a = normalize(src);
    const b = normalize(tgt);
    const diff = diffKeys(a, b);
    return diff.length ? { status: 'different', id: match.id, diff } : { status: 'same', id: match.id };
  }

  /** Arricchisce ogni nodo dell'albero con lo stato sul target */
  async annotate(node: DependencyNode): Promise<void> {
    if (node.supported) {
      try {
        node.target = await this.compare(node);
      } catch (e) {
        if (!(e instanceof PermissionError)) throw e;
        node.error = node.error ? `${node.error}\n${e.message}` : e.message;
      }
    }
    for (const c of node.children) await this.annotate(c);
  }
}
