import { CATALOG } from './catalog.js';
import { isStaticDataAction, type DependencyNode, EmailAddress, MessagingKind, NamedRef, SourceSettings } from './types.js';

/** Quanto serve del client Genesys */
interface Reader {
  get<T = any>(path: string): Promise<T>;
  listAll<T = any>(path: string): Promise<T[]>;
}

/** Tipi con impostazioni da scegliere sul target */
export const SETTINGS_TYPES = new Set(['campaign', 'queue', 'dataaction']);

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

/** Campi di outboundMessagingAddresses della Queue e API per leggerne nome/numero */
const MESSAGING_FIELDS: Record<MessagingKind, { field: string; path: (id: string) => string; label: (o: any) => string }> = {
  sms: {
    field: 'smsAddress',
    path: (id) => `/api/v2/routing/sms/phonenumbers/${encodeURIComponent(id)}`,
    label: (o) => o.phoneNumber ?? o.name,
  },
  whatsapp: {
    field: 'whatsAppRecipient',
    path: (id) => `/api/v2/routing/message/recipients/${encodeURIComponent(id)}`,
    label: (o) => o.name,
  },
  open: {
    field: 'openMessagingRecipient',
    path: (id) => `/api/v2/routing/message/recipients/${encodeURIComponent(id)}`,
    label: (o) => o.name,
  },
};

/** Indirizzi di messaggistica in uscita di una Queue, con nome o numero leggibile */
async function messagingOf(client: Reader, queue: any): Promise<Partial<Record<MessagingKind, NamedRef>> | undefined> {
  const out: Partial<Record<MessagingKind, NamedRef>> = {};
  for (const [kind, f] of Object.entries(MESSAGING_FIELDS) as [MessagingKind, (typeof MESSAGING_FIELDS)[MessagingKind]][]) {
    const r = queue?.outboundMessagingAddresses?.[f.field];
    if (!r?.id) continue;
    const label = await client
      .get(f.path(r.id))
      .then((o) => f.label(o))
      .catch(() => undefined);
    out[kind] = { id: r.id, name: label ?? r.name ?? r.id };
  }
  return Object.keys(out).length ? out : undefined;
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
  if (n.type === 'dataaction') return actionSettings(source, src, tgt);
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
    out.messaging = await messagingOf(source, src);
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
            messaging: await messagingOf(target, tgt),
          }
        : {}),
    };
  }
  return out;
}

/** Header con un valore costante: niente template ($input, ${credentials...}) */
export const isConstantHeader = (value: unknown): value is string => typeof value === 'string' && !value.includes('$');

/**
 * Data Action: URL e header costanti, che spesso cambiano tra ambienti (es. host di test e di produzione).
 * Le Function Data Actions non hanno URL (lo imposta la piattaforma).
 */
async function actionSettings(source: Reader, src: any, tgt: any): Promise<SourceSettings | undefined> {
  const request = src?.config?.request;
  if (!request?.requestUrlTemplate) return undefined;
  if (src.integrationId) {
    const integration = await source
      .get(`/api/v2/integrations/${encodeURIComponent(src.integrationId)}`)
      .catch(() => undefined);
    if (integration?.integrationType?.id === 'function-data-actions') return undefined;
  }
  const targetHeaders = tgt?.config?.request?.headers ?? {};
  return {
    request: {
      url: { source: request.requestUrlTemplate, target: tgt?.config?.request?.requestUrlTemplate },
      headers: Object.entries(request.headers ?? {})
        .filter(([, v]) => isConstantHeader(v))
        .map(([name, v]) => ({
          name,
          source: v as string,
          target: isConstantHeader(targetHeaders[name]) ? targetHeaders[name] : undefined,
        })),
    },
  };
}

/** Aggiunge ai nodi Campaign, Queue e Data Action le impostazioni da scegliere sul target */
export async function annotateSettings(source: Reader, target: Reader, trees: DependencyNode[]) {
  const byKey = new Map<string, DependencyNode[]>();
  const collect = (n: DependencyNode) => {
    if (SETTINGS_TYPES.has(n.type) && n.supported && n.target && !isStaticDataAction(n)) {
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
  // Indirizzi di messaggistica in uscita delle Queues
  const [sms, whatsapp, open] = await Promise.all([
    safe('Numeri SMS', () => target.listAll('/api/v2/routing/sms/phonenumbers')),
    safe('Recipients WhatsApp', () => target.listAll('/api/v2/routing/message/recipients?messengerType=whatsapp')),
    safe('Recipients Open Messaging', () => target.listAll('/api/v2/routing/message/recipients?messengerType=open')),
  ]);
  const messaging = {
    sms: (sms as any[]).map((o) => ({ id: o.id, name: o.phoneNumber ?? o.name ?? o.id })),
    whatsapp: named(whatsapp as any[]),
    open: named(open as any[]),
  };
  return { sites: named(sites), edgeGroups: named(edgeGroups), emailAddresses, messaging, errors };
}
