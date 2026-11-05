import { CATALOG } from '../genesys/catalog.js';
import type { PortItem } from '../genesys/types.js';
import type { TfJson } from './exportConfig.js';

/** Quanto serve del client Genesys per leggere il target */
interface Reader {
  get<T = any>(path: string): Promise<T>;
}

type Log = (line: string) => void;

const resourcesOf = (cfg: TfJson, tfType: string) => Object.entries(cfg.resource?.[tfType] ?? {});

/**
 * Regole di sicurezza applicate a ogni export, prima del plan:
 * - campagne outbound, campagne messaging e sequenze arrivano sul target SPENTE: una campagna accesa
 *   inizierebbe subito a chiamare o a inviare messaggi;
 * - delle liste contatti si porta la struttura, mai i contatti (dati personali);
 * - l'indirizzo del file di un asset è quello del sorgente: sul target lo assegna Genesys al caricamento.
 */
export function applySafetyRules(cfg: TfJson, log: Log) {
  const off = (tfType: string, attr: string, what: string) => {
    for (const [label, attrs] of resourcesOf(cfg, tfType)) {
      if (attrs[attr] !== 'off') {
        log(`Sicurezza: ${what} "${label}" portata spenta (${attr} = off; sul sorgente: ${attrs[attr] ?? 'non impostato'})`);
      }
      attrs[attr] = 'off';
    }
  };
  off(CATALOG.campaign.tfType, 'campaign_status', 'campagna');
  off(CATALOG.messagingcampaign.tfType, 'campaign_status', 'campagna messaging');
  off(CATALOG.sequence.tfType, 'status', 'sequenza');

  for (const [label, attrs] of resourcesOf(cfg, CATALOG.contactlist.tfType)) {
    if ('contacts_filepath' in attrs || 'contacts_id_name' in attrs) {
      log(`Sicurezza: lista contatti "${label}" portata senza contatti (solo struttura)`);
    }
    delete attrs.contacts_filepath;
    delete attrs.contacts_id_name;
  }

  for (const [, attrs] of resourcesOf(cfg, CATALOG.responseasset.tfType)) delete attrs.content_location;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applica una sostituzione a tutte le stringhe di un valore JSON, contando le occorrenze */
function replaceInStrings(value: unknown, re: RegExp, replacement: string, counter: { n: number }): unknown {
  if (typeof value === 'string') {
    return value.replace(re, () => {
      counter.n++;
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((v) => replaceInStrings(v, re, replacement, counter));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceInStrings(v, re, replacement, counter)]));
  }
  return value;
}

/**
 * Link agli asset dentro i testi delle canned response (es. <img src="…">): l'URL del sorgente contiene l'ID
 * dell'asset del sorgente e va sostituito PER INTERO con l'URL dell'asset sul target:
 * - asset già presente sul target (riusato): il suo URL, letto ora dal target;
 * - asset caricato in questo stesso rilascio: il riferimento Terraform ${<asset>.content_location},
 *   che il provider valorizza dopo il caricamento (e che garantisce anche l'ordine: prima l'asset, poi la risposta).
 * Va eseguito prima della rimappatura degli ID, che altrimenti cambierebbe solo il GUID dentro l'URL.
 */
export async function rewriteAssetLinks(
  cfg: TfJson,
  items: PortItem[],
  addresses: Map<PortItem, string>,
  target: Reader,
  log: Log,
): Promise<void> {
  const assets = items.filter((i) => i.type === 'responseasset');
  if (!assets.length) return;
  const assetType = CATALOG.responseasset.tfType;
  const fileAttrs = new Set(['filepath', 'filename', 'file_content_hash']);

  for (const asset of assets) {
    let replacement: string | undefined;
    const addr = addresses.get(asset);
    if (addr) {
      replacement = `\${${addr}.content_location}`;
    } else if (asset.targetId) {
      try {
        const t = await target.get<{ contentLocation?: string }>(
          CATALOG.responseasset.getPath.replace('{id}', encodeURIComponent(asset.targetId)),
        );
        replacement = t.contentLocation;
      } catch (e) {
        log(`ATTENZIONE: asset "${asset.name}" non leggibile sul target, link non aggiornati (${(e as Error).message})`);
      }
    }
    if (!replacement) {
      log(`ATTENZIONE: asset "${asset.name}" né portato né presente sul target: i link che lo usano restano quelli del sorgente`);
      continue;
    }

    // Qualunque URL che contiene l'ID dell'asset del sorgente, fino a spazio, virgolette o parentesi
    const re = new RegExp(`https?://[^\\s"'<>()]*${escapeRe(asset.id)}[^\\s"'<>()]*`, 'gi');
    const counter = { n: 0 };
    for (const [type, labels] of Object.entries(cfg.resource ?? {})) {
      if (type === assetType) continue;
      for (const [label, attrs] of Object.entries(labels)) {
        labels[label] = Object.fromEntries(
          Object.entries(attrs ?? {}).map(([k, v]) => [k, fileAttrs.has(k) ? v : replaceInStrings(v, re, replacement!, counter)]),
        );
      }
    }
    if (counter.n) {
      log(
        `Link all'asset "${asset.name}" aggiornati: ${counter.n} ` +
          (addr ? '(con l’indirizzo che il target assegnerà al caricamento)' : '(con l’indirizzo dell’asset sul target)'),
      );
    }
  }
}

/**
 * Un deployment di Messenger punta a una versione pubblicata della configurazione, e le versioni sono diverse
 * su ogni org. Configurazione portata nel job → la sua versione (${<config>.version});
 * configurazione già presente sul target → la sua ultima versione pubblicata, letta ora.
 * Va eseguito dopo la rimappatura degli ID.
 */
export async function alignWebDeploymentVersions(cfg: TfJson, target: Reader, log: Log): Promise<void> {
  for (const [label, attrs] of resourcesOf(cfg, CATALOG.webdeployment.tfType)) {
    const blocks: any[] = Array.isArray(attrs.configuration) ? attrs.configuration : attrs.configuration ? [attrs.configuration] : [];
    for (const conf of blocks) {
      const id: unknown = conf?.id;
      if (typeof id !== 'string') continue;
      const ref = id.match(/^\$\{(.+)\.id\}$/);
      if (ref) {
        conf.version = `\${${ref[1]}.version}`;
        continue;
      }
      try {
        const res = await target.get<{ entities?: { version?: string; status?: string }[] }>(
          `/api/v2/webdeployments/configurations/${encodeURIComponent(id)}/versions`,
        );
        const published = (res.entities ?? [])
          .map((v) => v.version)
          .filter((v): v is string => !!v && /^\d+$/.test(v))
          .sort((a, b) => Number(b) - Number(a));
        if (!published.length) throw new Error('nessuna versione pubblicata');
        if (conf.version !== published[0]) {
          log(`Deployment "${label}": configurazione del target alla versione pubblicata ${published[0]} (sorgente: ${conf.version ?? '?'})`);
        }
        conf.version = published[0];
      } catch (e) {
        throw new Error(
          `Deployment "${label}": impossibile leggere le versioni della configurazione ${id} sul target (${(e as Error).message}). ` +
            `Pubblicare la configurazione sul target oppure portarla insieme al deployment.`,
        );
      }
    }
  }
}

interface WrapupMappingsBody {
  defaultSet?: string[];
  mapping?: Record<string, string[]>;
}

interface WrapupReader extends Reader {
  listAll<T = any>(path: string): Promise<T[]>;
}

/**
 * Wrap-up code mappings dell'outbound: oggetto unico per org. Il provider scrive l'intera mappatura con
 * quella della configurazione, quindi portare solo quella del sorgente cancellerebbe sul target le
 * associazioni dei wrap-up code che esistono solo lì. Si costruisce invece un'unione:
 * - si parte dalla mappatura del target (solo i wrap-up code che esistono ancora);
 * - per ogni wrap-up code del sorgente disponibile sul target (riusato o portato nello stesso job) si
 *   applicano i flag del sorgente;
 * - i wrap-up code del sorgente non disponibili sul target vengono saltati e segnalati;
 * - il set di default resta quello del target (vale per tutti i wrap-up code non mappati dell'org).
 * Il plan mostra esattamente quali associazioni cambiano.
 */
export async function buildWrapupMappings(
  source: Reader,
  target: WrapupReader,
  targetIds: Map<string, string>,
  sameJobRefs: Map<string, string>,
  log: Log,
) {
  const path = CATALOG.wrapupmapping.getPath;
  const src = await source.get<WrapupMappingsBody>(path);
  let tgt: WrapupMappingsBody = {};
  try {
    tgt = await target.get<WrapupMappingsBody>(path);
  } catch {
    log('Wrap-up code mappings: nessuna mappatura sul target, si parte da una mappatura vuota');
  }
  const existing = new Set((await target.listAll<{ id: string }>('/api/v2/routing/wrapupcodes')).map((w) => w.id.toLowerCase()));

  const merged = new Map<string, string[]>();
  for (const [id, flags] of Object.entries(tgt.mapping ?? {})) {
    if (existing.has(id.toLowerCase())) merged.set(id, flags);
  }
  let updated = 0;
  const skipped: string[] = [];
  for (const [srcId, flags] of Object.entries(src.mapping ?? {})) {
    const key = srcId.toLowerCase();
    const ref = targetIds.get(key) ?? (sameJobRefs.has(key) ? `\${${sameJobRefs.get(key)}.id}` : undefined);
    if (!ref) {
      skipped.push(srcId);
      continue;
    }
    const before = merged.get(ref);
    if (!before || [...before].sort().join() !== [...flags].sort().join()) updated++;
    merged.set(ref, flags);
  }
  log(
    `Wrap-up code mappings: ${merged.size} associazioni sul target dopo l'unione, ${updated} nuove o modificate dal sorgente` +
      (skipped.length ? `, ${skipped.length} saltate perché il wrap-up code non è sul target né portato` : ''),
  );
  const srcDefault = [...(src.defaultSet ?? [])].sort().join(', ');
  const tgtDefault = [...(tgt.defaultSet ?? [])].sort().join(', ');
  if (srcDefault !== tgtDefault) {
    log(`Wrap-up code mappings: set di default diverso (sorgente: ${srcDefault || 'vuoto'}; target: ${tgtDefault || 'vuoto'}), resta quello del target`);
  }
  return {
    default_set: tgt.defaultSet ?? src.defaultSet ?? [],
    mappings: [...merged].map(([wrapup_code_id, flags]) => ({ wrapup_code_id, flags })),
  };
}
