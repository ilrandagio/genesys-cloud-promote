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
  const emailList = async (client: Reader, list?: any[]) =>
    list?.length
      ? (await Promise.all(list.map((a) => emailAddress(client, a)))).filter((a): a is EmailAddress => !!a)
      : undefined;

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
    out.emailAll = await emailList(source, src.mediaSettings?.email?.allOutboundEmailAddresses);
    if (src.callingPartyNumber || tgt?.callingPartyNumber) {
      out.phone = { source: src.callingPartyNumber, target: tgt?.callingPartyNumber, required: false };
    }
  }
  if (!Object.values(out).some((v) => v !== undefined)) return undefined;

  // Oggetto già presente sul target: i suoi valori attuali sono la proposta di partenza
  if (tgt) {
    const holder = n.type === 'campaign' ? tgt : tgt.mediaSettings?.callback;
    out.targetCurrent = {
      site: ref(holder?.site),
      edgeGroup: ref(holder?.edgeGroup),
      ...(n.type === 'queue'
        ? {
            emailDefault: await emailAddress(target, tgt.outboundEmailAddress),
            emailAll: await emailList(target, tgt.mediaSettings?.email?.allOutboundEmailAddresses),
          }
        : {}),
    };
  }
  return out;
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

/** Valori disponibili sul target: Sites, Edge Groups e indirizzi email (Email Routes); errors = elenchi non leggibili */
export async function targetOptions(target: Reader) {
  const errors: string[] = [];
  const safe = async <T>(what: string, f: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await f();
    } catch (e) {
      errors.push(`${what}: ${(e as Error).message}`);
      return [];
    }
  };
  const named = (list: any[]): NamedRef[] =>
    list.map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
  const [sites, edgeGroups, domains] = await Promise.all([
    safe('Sites', () => target.listAll('/api/v2/telephony/providers/edges/sites')),
    safe('Edge Groups', () => target.listAll('/api/v2/telephony/providers/edges/edgegroups')),
    safe('Email domains', () => target.listAll('/api/v2/routing/email/domains')),
  ]);
  const emailAddresses: EmailAddress[] = [];
  for (const d of domains as any[]) {
    const routes = await safe(`Email Routes di ${d.id}`, () =>
      target.listAll(`/api/v2/routing/email/domains/${encodeURIComponent(d.id)}/routes`),
    );
    for (const r of routes as any[]) emailAddresses.push({ domainId: d.id, routeId: r.id, address: `${r.pattern}@${d.id}` });
  }
  emailAddresses.sort((a, b) => a.address.localeCompare(b.address));
  return { sites: named(sites), edgeGroups: named(edgeGroups), emailAddresses, errors };
}
