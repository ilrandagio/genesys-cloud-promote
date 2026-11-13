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
 * - se un wrap-up code del sorgente non è disponibile sul target (né presente né portato) la simulazione
 *   si ferma con l'elenco: la mappatura del target non deve restare incompleta;
 * - il set di default resta quello del target (vale per tutti i wrap-up code non mappati dell'org).
 * Il plan mostra esattamente quali associazioni cambiano.
 */
export async function buildWrapupMappings(
  source: WrapupReader,
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
  const unavailable: string[] = [];
  for (const [srcId, flags] of Object.entries(src.mapping ?? {})) {
    const key = srcId.toLowerCase();
    const ref = targetIds.get(key) ?? (sameJobRefs.has(key) ? `\${${sameJobRefs.get(key)}.id}` : undefined);
    if (!ref) {
      unavailable.push(srcId);
      continue;
    }
    const before = merged.get(ref);
    if (!before || [...before].sort().join() !== [...flags].sort().join()) updated++;
    merged.set(ref, flags);
  }
  if (unavailable.length) {
    const names = new Map(
      (await source.listAll<{ id: string; name: string }>('/api/v2/routing/wrapupcodes')).map((w) => [w.id.toLowerCase(), w.name]),
    );
    const list = unavailable.map((id) => `"${names.get(id.toLowerCase()) ?? id}"`).sort();
    throw new Error(
      `Wrap-up code mappings: ${list.length} wrap-up code del sorgente non sono disponibili sul target: ${list.join(', ')}. ` +
        `Portarli insieme alla mappatura (azione "Porta" nell'albero) oppure crearli sul target, poi rifare la simulazione.`,
    );
  }
  log(`Wrap-up code mappings: ${merged.size} associazioni sul target dopo l'unione, ${updated} nuove o modificate dal sorgente`);
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

/**
 * Campaigns e Queues: le impostazioni legate alla singola org non si portano, si usano quelle del target
 * scelte dall'utente nell'analisi (ogni scelta viene verificata sul target):
 * - Site ed Edge Group (Campaign; callback della Queue);
 * - indirizzi email in uscita della Queue (dominio + Email Route), predefinito ed elenco completo;
 * - numero in uscita (Campaign: caller_address, obbligatorio se c'era sul sorgente; Queue: calling_party_number,
 *   facoltativo: se vuoto viene tolto).
 * Se sul sorgente un valore c'è e sul target non è stato scelto, la simulazione si ferma con l'elenco.
 */
export async function applyTargetSettings(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  target: Reader,
  log: Log,
) {
  const missing: string[] = [];
  const verify = async (what: string, path: string, it: PortItem) => {
    try {
      return await target.get<any>(path);
    } catch {
      throw new Error(`${what} scelto per ${CATALOG[it.type].label} "${it.name}" non trovato sul target`);
    }
  };
  const site = (id: string, it: PortItem) => verify('Site', `/api/v2/telephony/providers/edges/sites/${encodeURIComponent(id)}`, it);
  const edgeGroup = (id: string, it: PortItem) =>
    verify('Edge Group', `/api/v2/telephony/providers/edges/edgegroups/${encodeURIComponent(id)}`, it);
  const route = (a: { domainId: string; routeId: string }, it: PortItem) =>
    verify(
      'Indirizzo email',
      `/api/v2/routing/email/domains/${encodeURIComponent(a.domainId)}/routes/${encodeURIComponent(a.routeId)}`,
      it,
    );

  for (const [it, addr] of addresses) {
    if (it.type !== 'campaign' && it.type !== 'queue') continue;
    const tfType = CATALOG[it.type].tfType;
    const attrs = cfg.resource?.[tfType]?.[addr.slice(tfType.length + 1)];
    if (!attrs) continue;
    const chosen = it.targetSettings ?? {};
    const what = `${CATALOG[it.type].label} "${it.name}"`;

    // Site ed Edge Group: sulla Campaign, oppure nelle impostazioni di callback della Queue
    const holder = it.type === 'campaign' ? attrs : attrs.media_settings_callback?.[0];
    if (holder?.site_id) {
      if (!chosen.siteId) missing.push(`Site di ${what}`);
      else {
        holder.site_id = chosen.siteId;
        log(`${what}: Site del target "${(await site(chosen.siteId, it)).name}"`);
      }
    }
    if (holder?.edge_group_id) {
      if (!chosen.edgeGroupId) missing.push(`Edge Group di ${what}`);
      else {
        holder.edge_group_id = chosen.edgeGroupId;
        log(`${what}: Edge Group del target "${(await edgeGroup(chosen.edgeGroupId, it)).name}"`);
      }
    }

    if (it.type === 'campaign') {
      if (attrs.caller_address) {
        if (!chosen.phone?.trim()) missing.push(`numero in uscita (Caller Address) di ${what}`);
        else {
          attrs.caller_address = chosen.phone.trim();
          log(`${what}: Caller Address ${attrs.caller_address}`);
        }
      }
      continue;
    }

    // Queue: indirizzi email in uscita
    const pair = (a: { domainId: string; routeId: string }) => ({ domain_id: a.domainId, route_id: a.routeId });
    if (attrs.outbound_email_address?.length) {
      if (!chosen.emailDefault) missing.push(`indirizzo email in uscita di ${what}`);
      else {
        const r = await route(chosen.emailDefault, it);
        attrs.outbound_email_address = [pair(chosen.emailDefault)];
        log(`${what}: indirizzo email in uscita ${r.pattern}@${chosen.emailDefault.domainId}`);
      }
    }
    if (attrs.all_outbound_email_addresses?.length) {
      const list = [...(chosen.emailAll ?? [])];
      // L'indirizzo predefinito deve far parte dell'elenco completo
      if (chosen.emailDefault && !list.some((a) => a.routeId === chosen.emailDefault!.routeId)) list.unshift(chosen.emailDefault);
      if (!list.length) missing.push(`indirizzi email in uscita di ${what}`);
      else {
        for (const a of list) await route(a, it);
        attrs.all_outbound_email_addresses = list.map(pair);
        log(`${what}: ${list.length} indirizzi email in uscita del target`);
      }
    }

    // Queue: numero in uscita, facoltativo
    const phone = chosen.phone?.trim();
    if (phone) {
      attrs.calling_party_number = phone;
      log(`${what}: Calling Party Number ${phone}`);
    } else if (attrs.calling_party_number) {
      delete attrs.calling_party_number;
      log(`${what}: Calling Party Number non impostato sul target`);
    }
  }
  if (missing.length) {
    throw new Error(`Scegliere sul target: ${missing.join(', ')}. Si sceglie nell'analisi, sulla riga dell'oggetto.`);
  }
}

/**
 * Queue: i membri non si portano e quelli del target non si toccano.
 * - members non esportati; ignore_members = true, così il provider non legge né modifica i membri del target;
 * - Groups, Teams e Skill Groups (membri tramite gruppo): il provider li riscrive sempre, quindi per una Queue
 *   già presente si usano quelli del target, per una Queue nuova nessuno;
 * - indirizzi di messaggistica in uscita (SMS, WhatsApp, Open Messaging): ID dell'org, quelli del target se la
 *   Queue esiste già, altrimenti nessuno.
 */
export async function applyQueueMembership(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  target: Reader,
  log: Log,
) {
  const tfType = CATALOG.queue.tfType;
  const MESSAGING: Record<string, string> = {
    outbound_messaging_sms_address_id: 'smsAddress',
    outbound_messaging_whatsapp_recipient_id: 'whatsAppRecipient',
    outbound_messaging_open_messaging_recipient_id: 'openMessagingRecipient',
  };
  const GROUPS: Record<string, string> = { groups: 'GROUP', teams: 'TEAM', skill_groups: 'SKILLGROUP' };
  for (const [it, addr] of addresses) {
    if (it.type !== 'queue') continue;
    const attrs = cfg.resource?.[tfType]?.[addr.slice(tfType.length + 1)];
    if (!attrs) continue;
    delete attrs.members;
    attrs.ignore_members = true;
    const current = it.targetId
      ? await target.get<any>(`/api/v2/routing/queues/${encodeURIComponent(it.targetId)}`)
      : undefined;

    for (const [attr, type] of Object.entries(GROUPS)) {
      const ids = ((current?.memberGroups ?? []) as any[]).filter((g) => g.type === type).map((g) => g.id);
      if (ids.length) attrs[attr] = ids;
      else delete attrs[attr];
    }
    for (const [attr, field] of Object.entries(MESSAGING)) {
      const id = current?.outboundMessagingAddresses?.[field]?.id;
      if (id) attrs[attr] = id;
      else if (attrs[attr]) {
        delete attrs[attr];
        log(`Queue "${it.name}": ${attr} del sorgente non portato (ID dell'org sorgente)`);
      }
    }
    log(
      `Queue "${it.name}": membri non portati` +
        (current ? ', membri e gruppi del target mantenuti' : ', nessun membro sulla nuova Queue'),
    );
  }
}

/**
 * Groups portati: i Roles assegnati sul sorgente (con le divisioni) vengono assegnati anche sul target con
 * genesyscloud_group_roles, costruito dal worker dai grants del sorgente:
 * - Role riusato sul target → suo ID; Role portato nello stesso rilascio → riferimento Terraform;
 * - divisione abbinata per nome ("*" = tutte le divisioni resta com'è);
 * - Role o divisione non disponibili sul target → la simulazione si ferma con l'elenco.
 * Le assegnazioni di Roles del Group sul target vengono sostituite da quelle del sorgente. Un Group senza
 * Roles sul sorgente non tocca i Roles del Group sul target.
 */
export async function applyGroupRoles(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  source: Reader,
  targetIds: Map<string, string>,
  sameJobRefs: Map<string, string>,
  extraImports: { addr: string; id: string }[],
  log: Log,
) {
  const tfType = 'genesyscloud_group_roles';
  const missing: string[] = [];
  for (const [it, addr] of [...addresses]) {
    if (it.type !== 'group') continue;
    const subject = await source.get<any>(`/api/v2/authorization/subjects/${encodeURIComponent(it.id)}`);
    const byRole = new Map<string, { roleId: string; roleName: string; divisions: Set<string> }>();
    const divisionNames = new Map<string, string>();
    for (const g of (subject?.grants ?? []) as any[]) {
      const roleId: string | undefined = g.role?.id;
      if (!roleId) continue;
      const entry = byRole.get(roleId) ?? { roleId, roleName: g.role.name ?? roleId, divisions: new Set<string>() };
      if (g.division?.id) {
        entry.divisions.add(g.division.id);
        divisionNames.set(g.division.id, g.division.name ?? g.division.id);
      }
      byRole.set(roleId, entry);
    }
    if (!byRole.size) {
      log(`Group "${it.name}": nessun Role sul sorgente, i Roles del Group sul target non vengono toccati`);
      continue;
    }
    const roles: { role_id: string; division_ids: string[] }[] = [];
    for (const r of byRole.values()) {
      const key = r.roleId.toLowerCase();
      const roleRef = targetIds.get(key) ?? (sameJobRefs.has(key) ? `\${${sameJobRefs.get(key)}.id}` : undefined);
      if (!roleRef) {
        missing.push(`Role "${r.roleName}" del Group "${it.name}"`);
        continue;
      }
      const divisions: string[] = [];
      for (const d of r.divisions) {
        if (d === '*') divisions.push('*');
        else {
          const mapped = targetIds.get(d.toLowerCase());
          if (mapped) divisions.push(mapped);
          else missing.push(`Division "${divisionNames.get(d)}" del Role "${r.roleName}" nel Group "${it.name}"`);
        }
      }
      roles.push({ role_id: roleRef, division_ids: divisions });
    }
    const label = addr.slice('genesyscloud_group.'.length);
    cfg.resource ??= {};
    cfg.resource[tfType] ??= {};
    cfg.resource[tfType][label] = { group_id: `\${${addr}.id}`, roles };
    if (it.targetId) extraImports.push({ addr: `${tfType}.${label}`, id: it.targetId });
    log(`Group "${it.name}": ${roles.length} Roles assegnati sul target (sostituiscono quelli attuali del Group)`);
  }
  if (missing.length) {
    throw new Error(
      `Roles dei Groups non assegnabili sul target: ${missing.join(', ')}. ` +
        `Portare i Roles insieme al Group (azione "Porta" nell'albero) oppure crearli sul target; ` +
        `le Divisions vanno create sul target con lo stesso nome.`,
    );
  }
}

/**
 * Gli utenti non si portano mai. Un Role con una condizione su un utente specifico
 * (permission_policies.conditions.terms.operands.user_id) porterebbe sul target l'ID di un utente del
 * sorgente: la simulazione si ferma, la condizione va tolta o adattata sul sorgente.
 */
export function checkRoleUserConditions(cfg: TfJson) {
  const offending: string[] = [];
  for (const [label, attrs] of Object.entries(cfg.resource?.genesyscloud_auth_role ?? {})) {
    const json = JSON.stringify((attrs as any).permission_policies ?? []);
    if (/"user_id"\s*:\s*"[^"]+"/.test(json)) offending.push((attrs as any).name ?? label);
  }
  if (offending.length) {
    throw new Error(
      `Roles con condizioni su utenti specifici: ${offending.join(', ')}. Gli utenti non vengono portati e i ` +
        `loro ID sono diversi sul target: togliere o adattare la condizione, oppure non portare il Role.`,
    );
  }
}

interface RowsReader extends Reader {
  listAll<T = any>(path: string): Promise<T[]>;
}

/**
 * Data Tables portate con "Porta anche i dati": le righe del sorgente diventano risorse
 * genesyscloud_architect_datatable_row (chiave + properties_json). Le righe con la stessa chiave già presenti
 * sul target vengono importate con blocchi `import` (un solo plan, niente import uno per uno) e aggiornate;
 * le righe che esistono solo sul target non vengono toccate (nessuna cancellazione). I valori sono copiati
 * così come sono: eventuali ID di oggetti del sorgente scritti nelle celle non vengono rimappati.
 */
/** Testo letterale in una stringa della configurazione JSON di Terraform: "${" e "%{" non devono diventare espressioni */
const tfLiteral = (v: string) => v.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

export async function applyDataTableRows(
  cfg: TfJson,
  addresses: Map<PortItem, string>,
  source: RowsReader,
  target: RowsReader,
  log: Log,
) {
  const tfType = 'genesyscloud_architect_datatable_row';
  const tableType = CATALOG.datatable.tfType;
  for (const [it, addr] of addresses) {
    if (it.type !== 'datatable' || !it.includeRows) continue;
    const rows = await source.listAll<Record<string, unknown>>(
      `/api/v2/flows/datatables/${encodeURIComponent(it.id)}/rows?showbrief=false`,
    );
    const onTarget = new Set(
      it.targetId
        ? (
            await target.listAll<{ key: string }>(
              `/api/v2/flows/datatables/${encodeURIComponent(it.targetId)}/rows?showbrief=true`,
            )
          ).map((r) => String(r.key))
        : [],
    );
    const tableLabel = addr.slice(tableType.length + 1);
    cfg.resource ??= {};
    cfg.resource[tfType] ??= {};
    cfg.import ??= [];
    let updated = 0;
    rows.forEach((row, i) => {
      const { key, ...properties } = row;
      const keyValue = String(key);
      const label = `${tableLabel}__row_${i + 1}`;
      cfg.resource![tfType][label] = {
        datatable_id: `\${${addr}.id}`,
        key_value: tfLiteral(keyValue),
        properties_json: tfLiteral(JSON.stringify(properties)),
      };
      if (onTarget.has(keyValue)) {
        cfg.import.push({ to: `${tfType}.${label}`, id: tfLiteral(`${it.targetId}/${keyValue}`) });
        updated++;
      }
    });
    log(
      `Data Table "${it.name}": ${rows.length} righe portate (${rows.length - updated} nuove, ${updated} già presenti ` +
        `sul target e aggiornate); le righe presenti solo sul target restano invariate`,
    );
  }
  if (Array.isArray(cfg.import) && !cfg.import.length) delete cfg.import;
}
