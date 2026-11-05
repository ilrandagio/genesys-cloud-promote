import { CATALOG } from './catalog.js';
import type { DependencyNode, EmailAddress, NamedRef, SourceSettings } from './types.js';

/** Quanto serve del client Genesys */
interface Reader {
  get<T = any>(path: string): Promise<T>;
  listAll<T = any>(path: string): Promise<T[]>;
}

/** Tipi con impostazioni da scegliere sul target */
export const SETTINGS_TYPES = new Set(['campaign', 'queue']);

const ref = (r: any): NamedRef | undefined => (r?.id ? { id: r.id, name: r.name ?? r.id } : undefined);

/** Indirizzo di una Email Route: pattern@dominio */
async function emailAddress(client: Reader, a: any): Promise<EmailAddress | undefined> {
  const domainId = a?.domain?.id;
  const routeId = a?.route?.id;
  if (!domainId || !routeId) return undefined;
  let pattern = a.route.name ?? a.route.pattern;
  if (!pattern) {
    try {
      const r = await client.get(
        `/api/v2/routing/email/domains/${encodeURIComponent(domainId)}/routes/${encodeURIComponent(routeId)}`,
      );
      pattern = r.pattern;
    } catch {
      pattern = routeId;
    }
  }
  return { domainId, routeId, address: `${pattern}@${domainId}` };
}

/** Impostazioni del sorgente di una Campaign o di una Queue (undefined se non ne ha) */
async function sourceSettings(
  source: Reader,
  target: Reader,
  n: DependencyNode,
): Promise<SourceSettings | undefined> {
  const path = (id: string) => CATALOG[n.type].getPath.replace('{id}', encodeURIComponent(id));
  const src = await source.get(path(n.id));
  const tgt = n.target?.id ? await target.get(path(n.target.id)).catch(() => undefined) : undefined;
  const out: SourceSettings = {};

  if (n.type === 'campaign') {
    out.site = ref(src.site);
    out.edgeGroup = ref(src.edgeGroup);
    if (src.callerAddress || tgt?.callerAddress) {
      out.phone = { source: src.callerAddress, target: tgt?.callerAddress, required: Boolean(src.callerAddress) };
    }
  } else {
    const callback = src.mediaSettings?.callback;
    out.site = ref(callback?.site);
    out.edgeGroup = ref(callback?.edgeGroup);
    out.emailDefault = await emailAddress(source, src.outboundEmailAddress);
    const all = src.mediaSettings?.email?.allOutboundEmailAddresses as any[] | undefined;
    if (all?.length) {
      out.emailAll = (await Promise.all(all.map((a) => emailAddress(source, a)))).filter((a): a is EmailAddress => !!a);
    }
    if (src.callingPartyNumber || tgt?.callingPartyNumber) {
      out.phone = { source: src.callingPartyNumber, target: tgt?.callingPartyNumber, required: false };
    }
  }
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/** Aggiunge ai nodi Campaign e Queue le impostazioni da scegliere sul target */
export async function annotateSettings(source: Reader, target: Reader, trees: DependencyNode[]) {
  const byKey = new Map<string, DependencyNode[]>();
  const collect = (n: DependencyNode) => {
    if (SETTINGS_TYPES.has(n.type) && n.supported && n.target) {
      const key = `${n.type}:${n.id}`;
      byKey.set(key, [...(byKey.get(key) ?? []), n]);
    }
    n.children.forEach(collect);
  };
  trees.forEach(collect);
  for (const nodes of byKey.values()) {
    try {
      const settings = await sourceSettings(source, target, nodes[0]);
      if (settings) nodes.forEach((n) => (n.settings = settings));
    } catch {
      // dettaglio non leggibile: l'errore è già sul nodo
    }
  }
}

/** Valori disponibili sul target: Sites, Edge Groups e indirizzi email (Email Routes) */
export async function targetOptions(target: Reader) {
  const named = (list: any[]): NamedRef[] =>
    list.map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
  const [sites, edgeGroups, domains] = await Promise.all([
    target.listAll('/api/v2/telephony/providers/edges/sites'),
    target.listAll('/api/v2/telephony/providers/edges/edgegroups'),
    target.listAll('/api/v2/routing/email/domains').catch(() => []),
  ]);
  const emailAddresses: EmailAddress[] = [];
  for (const d of domains) {
    const routes = await target
      .listAll(`/api/v2/routing/email/domains/${encodeURIComponent(d.id)}/routes`)
      .catch(() => [] as any[]);
    for (const r of routes) emailAddresses.push({ domainId: d.id, routeId: r.id, address: `${r.pattern}@${d.id}` });
  }
  emailAddresses.sort((a, b) => a.address.localeCompare(b.address));
  return { sites: named(sites), edgeGroups: named(edgeGroups), emailAddresses };
}
