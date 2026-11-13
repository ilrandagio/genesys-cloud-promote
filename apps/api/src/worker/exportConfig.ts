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

/**
 * Percorsi dei file esportati con "\\" (export eseguito su Windows): dentro un'espressione Terraform come
 * ${filesha256("audio_prompts\\x.wav")} la barra rovesciata diventa una sequenza di escape non valida
 * ("\\c", "\\n"…). Si usano sempre "/", che Terraform accetta su ogni sistema, anche nei blocchi annidati
 * (es. resources[] degli User Prompt).
 */
/**
 * Percorso da inserire in una stringa di un'espressione Terraform: sempre "/", e i caratteri che lì hanno
 * un significato (", ${, %{) protetti, nel caso un nome di file li contenga
 */
export function hclPath(p: string): string {
  return p
    .replace(/\\+/g, '/')
    .replace(/"/g, () => '\\"')
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
}

export function normalizeFilePaths(cfg: TfJson): number {
  let fixed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (FILE_ATTRIBUTES.has(k) && typeof v === 'string' && v.includes('\\')) {
          obj[k] = v.replace(/\\+/g, '/');
          fixed++;
        } else {
          obj[k] = walk(v);
        }
      }
      return obj;
    }
    return node;
  };
  walk(cfg.resource ?? {});
  return fixed;
}

const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Filtro per include_filter_resources: "tipo::regex".
 * La regex è volutamente larga (i caratteri speciali diventano "."):
 * l'output viene poi ripulito da selectResources.
 */
export function includeFilter(item: PortItem): string {
  const loose = item.name.replace(/[^A-Za-z0-9]/g, '.');
  // Niente ancora iniziale dove la label ha un prefisso prima del nome:
  // - Flows: il tipo (es. INBOUNDCALL_Main_IVR);
  // - Data Actions: la categoria (es. Isybank_FDI_WS_authenticate; per le azioni statiche anche l'integrazione).
  // Eventuali omonimi parziali inclusi dal filtro vengono scartati da selectResources (confronto sul nome esatto).
  const prefixed = item.type === 'flow' || item.type === 'dataaction';
  return prefixed ? `${CATALOG[item.type].tfType}::${loose}` : `${CATALOG[item.type].tfType}::^_?${loose}`;
}

/** Trova l'indirizzo Terraform (tipo.label) dell'oggetto nella configurazione esportata */
export function findAddress(cfg: TfJson, item: PortItem, match?: Record<string, string>): string | undefined {
  const tfType = CATALOG[item.type].tfType;
  const resources = cfg.resource?.[tfType] ?? {};
  const byName: string[] = [];
  for (const [label, attrs] of Object.entries(resources)) {
    const nameAttr = typeof attrs?.name === 'string' ? attrs.name : undefined;
    const labelMatch =
      simplify(label) === simplify(item.name) ||
      (item.type === 'flow' && !!item.subtype && simplify(label) === simplify(`${item.subtype}_${item.name}`));
    if (!(nameAttr ? nameAttr.toLowerCase() === item.name.toLowerCase() : labelMatch)) continue;
    // Attributi che distinguono gli omonimi (es. integration_id per Data Actions con lo stesso nome)
    const same = Object.entries(match ?? {}).every(([k, v]) => String(attrs?.[k] ?? '').toLowerCase() === v.toLowerCase());
    if (same) return `${tfType}.${label}`;
    byName.push(label);
  }
  // Un solo omonimo ma attributo diverso (es. integration_id scritto come riferimento): è comunque quello
  return byName.length === 1 ? `${tfType}.${byName[0]}` : undefined;
}

/**
 * Tiene solo le risorse scelte dall'utente (il filtro dell'export può includere omonimi parziali).
 * Restituisce gli indirizzi mantenuti per ogni item.
 */
export function selectResources(
  cfg: TfJson,
  items: PortItem[],
  match?: Map<PortItem, Record<string, string>>,
): Map<PortItem, string> {
  const found = new Map<PortItem, string>();
  for (const it of items) {
    const addr = findAddress(cfg, it, match?.get(it));
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
): Promise<{ report: { file: string; replaced: number; placeholders: number }[]; missingFiles: string[] }> {
  const report: { file: string; replaced: number; placeholders: number }[] = [];
  const missingFiles: string[] = [];
  // ID sorgente della risorsa stessa: dentro il proprio file non va mai sostituito
  const ownIdOf = new Map([...sameJobRefs].map(([id, addr]) => [addr, id]));
  const placeholderOf = new Map<string, string>();
  let counter = 0;

  for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
    for (const [label, attrs] of Object.entries(labels)) {
      const ownId = ownIdOf.get(`${type}.${label}`);
      const filepath: unknown = attrs?.filepath;
      if (typeof filepath !== 'string' || filepath.includes('${')) continue;
      // L'export può scrivere i percorsi con "\\" (Windows): normalizzati per funzionare su ogni sistema
      const abs = path.resolve(baseDir, ...filepath.split(/[\\/]+/));
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        missingFiles.push(filepath);
        continue;
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
      if ('file_content_hash' in attrs) attrs.file_content_hash = `\${filesha256("${hclPath(filepath)}")}`;
      report.push({ file: filepath, replaced, placeholders });
    }
  }
  return { report, missingFiles };
}

/**
 * Ordine di creazione dall'albero delle dipendenze: per ogni arco "from usa to" in cui entrambi gli oggetti
 * vengono portati in questo job, la risorsa di "from" dipende da quella di "to" (depends_on).
 * Serve soprattutto per i flow, che referenziano gli oggetti per nome e quindi non hanno riferimenti Terraform:
 * senza, Terraform potrebbe creare un flow prima della coda o della data action che usa.
 * Un ciclo emerge già nel plan (errore "Cycle"), mai durante l'esecuzione.
 */
export function addDependsOn(cfg: TfJson, edges: { from: string; to: string }[], keyToAddress: Map<string, string>): number {
  let added = 0;
  for (const { from, to } of edges) {
    const fromAddr = keyToAddress.get(from.toLowerCase());
    const toAddr = keyToAddress.get(to.toLowerCase());
    if (!fromAddr || !toAddr || fromAddr === toAddr) continue;
    const [type, label] = fromAddr.split('.');
    const attrs = cfg.resource?.[type]?.[label];
    if (!attrs) continue;
    const current: string[] = Array.isArray(attrs.depends_on) ? attrs.depends_on : [];
    if (current.includes(toAddr)) continue;
    attrs.depends_on = [...current, toAddr];
    added++;
  }
  return added;
}

/**
 * Risorse il cui file (filepath) non è stato esportato: il percorso è rimasto una variabile
 * (es. "${var.genesyscloud_flow_X_filepath}") oppure è vuoto. Restituisce gli indirizzi Terraform.
 */
export function unexportedFiles(cfg: TfJson): string[] {
  const out: string[] = [];
  for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
    for (const [label, attrs] of Object.entries(labels)) {
      if (!attrs) continue;
      // filepath: flow e script; filename: file degli asset delle canned response
      for (const key of ['filepath', 'filename']) {
        if (!(key in attrs)) continue;
        const fp = attrs[key];
        if (typeof fp !== 'string' || !fp.trim() || fp.includes('${var.')) out.push(`${type}.${label}`);
      }
    }
  }
  return out;
}
