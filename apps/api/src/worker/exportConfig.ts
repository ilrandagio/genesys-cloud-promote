import { CATALOG } from '../genesys/catalog.js';
import type { PortItem } from '../genesys/types.js';

/** Configurazione Terraform in JSON (genesyscloud.tf.json) prodotta da genesyscloud_tf_export */
export interface TfJson {
  terraform?: any;
  provider?: any;
  resource?: Record<string, Record<string, Record<string, any>>>;
  data?: Record<string, Record<string, Record<string, any>>>;
  [k: string]: any;
}

const GUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Filtro per include_filter_resources: "tipo::regex".
 * La regex è volutamente larga (i caratteri speciali diventano "."):
 * l'output viene poi ripulito da selectResources.
 */
export function includeFilter(item: PortItem): string {
  const loose = item.name.replace(/[^A-Za-z0-9]/g, '.');
  // Le label dei flow possono avere il tipo come prefisso (es. INBOUNDCALL_Main_IVR): niente ancora iniziale
  return item.type === 'flow' ? `${CATALOG[item.type].tfType}::${loose}` : `${CATALOG[item.type].tfType}::^_?${loose}`;
}

/** Trova l'indirizzo Terraform (tipo.label) dell'oggetto nella configurazione esportata */
export function findAddress(cfg: TfJson, item: PortItem): string | undefined {
  const tfType = CATALOG[item.type].tfType;
  const resources = cfg.resource?.[tfType] ?? {};
  for (const [label, attrs] of Object.entries(resources)) {
    const nameAttr = typeof attrs?.name === 'string' ? attrs.name : undefined;
    const labelMatch =
      simplify(label) === simplify(item.name) ||
      (item.type === 'flow' && !!item.subtype && simplify(label) === simplify(`${item.subtype}_${item.name}`));
    if (nameAttr ? nameAttr.toLowerCase() === item.name.toLowerCase() : labelMatch) {
      return `${tfType}.${label}`;
    }
  }
  return undefined;
}

/**
 * Tiene solo le risorse scelte dall'utente (il filtro dell'export può includere omonimi parziali).
 * Restituisce gli indirizzi mantenuti per ogni item.
 */
export function selectResources(cfg: TfJson, items: PortItem[]): Map<PortItem, string> {
  const found = new Map<PortItem, string>();
  for (const it of items) {
    const addr = findAddress(cfg, it);
    if (addr) found.set(it, addr);
  }
  const keep = new Set(found.values());
  for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
    for (const label of Object.keys(labels)) {
      if (!keep.has(`${type}.${label}`)) delete labels[label];
    }
    if (!Object.keys(labels).length) delete cfg.resource![type];
  }
  return found;
}

/** Sostituisce in profondità gli ID del sorgente con quelli del target */
export function remapIds<T>(value: T, idMap: Map<string, string>): T {
  if (Array.isArray(value)) return value.map((v) => remapIds(v, idMap)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapIds(v, idMap)])) as T;
  }
  if (typeof value === 'string') {
    return value.replace(GUID_G, (g) => idMap.get(g.toLowerCase()) ?? g) as T;
  }
  return value;
}

/** GUID rimasti nella configurazione (potenziali riferimenti al sorgente non risolti) */
export function remainingGuids(value: unknown): Set<string> {
  const out = new Set<string>();
  JSON.stringify(value).replace(GUID_G, (g) => {
    out.add(g.toLowerCase());
    return g;
  });
  return out;
}

export function ensureProvider(cfg: TfJson, version: string) {
  cfg.terraform ??= {};
  const tf = Array.isArray(cfg.terraform) ? cfg.terraform[0] : cfg.terraform;
  tf.required_providers ??= {};
  const rp = Array.isArray(tf.required_providers) ? tf.required_providers[0] : tf.required_providers;
  rp.genesyscloud ??= { source: 'mypurecloud/genesyscloud', version };
  cfg.provider ??= { genesyscloud: {} };
}
