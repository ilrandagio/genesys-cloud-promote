import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATALOG } from '../genesys/catalog.js';
import { ID_TOKEN_G } from '../genesys/ids.js';
import type { PortItem } from '../genesys/types.js';

/** Configurazione Terraform in JSON (genesyscloud.tf.json) prodotta da genesyscloud_tf_export */
export interface TfJson {
  terraform?: any;
  provider?: any;
  resource?: Record<string, Record<string, Record<string, any>>>;
  data?: Record<string, Record<string, Record<string, any>>>;
  [k: string]: any;
}

// ID Genesys con eventuale prefisso (custom_-_<guid> per le data action): sostituiti sempre per intero
const GUID_G = ID_TOKEN_G;

/** Attributi che contengono percorsi o hash di file: gli ID nel nome del file non sono riferimenti */
const FILE_ATTRIBUTES = new Set(['filepath', 'file_content_hash', 'filename']);

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

/**
 * Rimappa gli ID nella configurazione Terraform risorsa per risorsa:
 * - non tocca l'ID della risorsa stessa (eviterebbe un riferimento a se stessa: "Self-referential block");
 * - non tocca percorsi e hash dei file (il nome del file esportato contiene l'ID del sorgente).
 * sameJobRefs: ID sorgente -> indirizzo della risorsa creata nello stesso job.
 */
export function remapConfig(cfg: TfJson, targetIds: Map<string, string>, sameJobRefs: Map<string, string>): TfJson {
  const out: TfJson = { ...cfg };
  for (const block of ['resource', 'data'] as const) {
    if (!cfg[block]) continue;
    out[block] = {};
    for (const [type, labels] of Object.entries(cfg[block]!)) {
      out[block]![type] = {};
      for (const [label, attrs] of Object.entries(labels)) {
        const self = `${type}.${label}`;
        const map = new Map(targetIds);
        for (const [id, addr] of sameJobRefs) {
          if (addr !== self && !map.has(id)) map.set(id, `\${${addr}.id}`);
        }
        out[block]![type][label] = Object.fromEntries(
          Object.entries(attrs ?? {}).map(([k, v]) => [k, FILE_ATTRIBUTES.has(k) ? v : remapIds(v, map)]),
        );
      }
    }
  }
  return out;
}

/**
 * GUID rimasti nella configurazione (potenziali riferimenti al sorgente non risolti).
 * Percorsi e hash dei file sono esclusi: il nome del file contiene l'ID del sorgente senza essere un riferimento.
 */
export function remainingGuids(value: unknown): Set<string> {
  const out = new Set<string>();
  JSON.stringify(value, (k, v) => (FILE_ATTRIBUTES.has(k) ? undefined : v)).replace(GUID_G, (g) => {
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

/**
 * Sostituisce gli ID del sorgente anche nei file referenziati dalle risorse (attributo filepath):
 * il JSON degli script agente e lo YAML dei flow possono contenere ID in chiaro.
 * - ID di oggetti già presenti sul target: sostituiti con l'ID del target.
 * - ID di oggetti creati nello stesso job: sostituiti con un segnaposto {{gcp_N}} che Terraform
 *   riempie tramite l'attributo "substitutions" della risorsa (così l'ordine di creazione è garantito).
 * Restituisce, per file, quante sostituzioni sono state fatte.
 */
export async function remapReferencedFiles(
  cfg: TfJson,
  baseDir: string,
  targetIds: Map<string, string>,
  sameJobRefs: Map<string, string>,
): Promise<{ file: string; replaced: number; placeholders: number }[]> {
  const report: { file: string; replaced: number; placeholders: number }[] = [];
  // ID sorgente della risorsa stessa: dentro il proprio file non va mai sostituito
  const ownIdOf = new Map([...sameJobRefs].map(([id, addr]) => [addr, id]));
  const placeholderOf = new Map<string, string>();
  let counter = 0;

  for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
    for (const [label, attrs] of Object.entries(labels)) {
      const ownId = ownIdOf.get(`${type}.${label}`);
      const filepath: unknown = attrs?.filepath;
      if (typeof filepath !== 'string' || filepath.includes('${')) continue;
      const abs = path.resolve(baseDir, filepath);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue; // file non presente: lo segnalerà Terraform
      }

      let replaced = 0;
      let placeholders = 0;
      const used: Record<string, string> = {};
      // Si sostituiscono solo gli ID che corrispondono a oggetti dell'analisi;
      // gli ID interni (pagine, componenti, variabili...) restano invariati
      const next = content.replace(GUID_G, (g) => {
        const key = g.toLowerCase();
        if (key === ownId) return g;
        const tgt = targetIds.get(key);
        if (tgt) {
          replaced++;
          return tgt;
        }
        const addr = sameJobRefs.get(key);
        if (addr) {
          if (!placeholderOf.has(key)) placeholderOf.set(key, `gcp_${++counter}`);
          const name = placeholderOf.get(key)!;
          used[name] = `\${${addr}.id}`;
          placeholders++;
          return `{{${name}}}`;
        }
        return g;
      });
      if (next === content) continue;

      await writeFile(abs, next);
      if (Object.keys(used).length) attrs.substitutions = { ...(attrs.substitutions ?? {}), ...used };
      // L'hash del contenuto deve seguire il file modificato
      if ('file_content_hash' in attrs) attrs.file_content_hash = `\${filesha256("${filepath.replace(/\\/g, '/')}")}`;
      report.push({ file: filepath, replaced, placeholders });
    }
  }
  return report;
}
