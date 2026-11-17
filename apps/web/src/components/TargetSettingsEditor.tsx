import { Input, Select, Space, Tooltip } from 'antd';
import type { EmailAddress, MessagingKind, NamedRef, SourceSettings, TargetOptions, TargetSettings } from '../api/client';

const MESSAGING_LABELS: Record<MessagingKind, string> = { sms: 'SMS', whatsapp: 'WhatsApp', open: 'Open Messaging' };
const KINDS: MessagingKind[] = ['sms', 'whatsapp', 'open'];

const localPart = (address: string) => address.split('@')[0].toLowerCase();
const byName = (list: NamedRef[], ref?: NamedRef) =>
  ref ? list.find((x) => x.name.toLowerCase() === ref.name.toLowerCase())?.id : undefined;
/** Indirizzo del target con la stessa parte prima della @ (i domini di solito cambiano tra org), se unico */
const byLocalPart = (list: EmailAddress[], a?: EmailAddress) => {
  if (!a) return undefined;
  const hits = list.filter((x) => localPart(x.address) === localPart(a.address));
  return hits.length === 1 ? { domainId: hits[0].domainId, routeId: hits[0].routeId } : undefined;
};

/** Valori del target per un oggetto: gli elenchi del target più i valori attuali dell'oggetto sul target */
export function optionsFor(s: SourceSettings, o: TargetOptions): TargetOptions {
  const add = <T,>(list: T[], extra: (T | undefined)[], same: (a: T, b: T) => boolean) => [
    ...list,
    ...extra.filter((x): x is T => !!x && !list.some((y) => same(x, y))),
  ];
  const c = s.targetCurrent ?? {};
  return {
    ...o,
    sites: add(o.sites, [c.site], (a, b) => a.id === b.id),
    edgeGroups: add(o.edgeGroups, [c.edgeGroup], (a, b) => a.id === b.id),
    emailAddresses: add(o.emailAddresses, [c.emailDefault, ...(c.emailAll ?? [])], (a, b) => a.routeId === b.routeId),
    messaging: Object.fromEntries(
      KINDS.map((k) => [k, add(o.messaging?.[k] ?? [], [c.messaging?.[k]], (a, b) => a.id === b.id)]),
    ) as Record<MessagingKind, NamedRef[]>,
  };
}

const pairOf = (a?: EmailAddress) => (a ? { domainId: a.domainId, routeId: a.routeId } : undefined);

/**
 * Proposta iniziale: se l'oggetto esiste già sul target, i suoi valori attuali; altrimenti Site ed Edge Group
 * con lo stesso nome, indirizzi email con la stessa parte prima della @; numero del target o da inserire a mano
 */
export function proposeSettings(s: SourceSettings, options: TargetOptions): TargetSettings {
  const o = optionsFor(s, options);
  const c = s.targetCurrent ?? {};
  return {
    siteId: c.site?.id ?? byName(o.sites, s.site),
    edgeGroupId: c.edgeGroup?.id ?? byName(o.edgeGroups, s.edgeGroup),
    emailDefault: pairOf(c.emailDefault) ?? byLocalPart(o.emailAddresses, s.emailDefault),
    emailAll: c.emailAll?.length
      ? c.emailAll.map((a) => pairOf(a)!)
      : s.emailAll?.map((a) => byLocalPart(o.emailAddresses, a)).filter((a): a is NonNullable<typeof a> => !!a),
    phone: s.phone?.target ?? '',
    // Messaggistica: il valore attuale del target se c'è, altrimenti nessuno (da scegliere)
    ...(s.messaging
      ? {
          messaging: Object.fromEntries(
            KINDS.filter((k) => s.messaging?.[k]).map((k) => [k, c.messaging?.[k]?.id ?? '']),
          ) as Partial<Record<MessagingKind, string>>,
        }
      : {}),
  };
}

/** true se le scelte puntano tutte a valori presenti sul target attuale */
export function settingsValid(c: TargetSettings, s: SourceSettings, options: TargetOptions) {
  const o = optionsFor(s, options);
  const route = (a: { routeId: string }) => o.emailAddresses.some((x) => x.routeId === a.routeId);
  return (
    (!c.siteId || o.sites.some((x) => x.id === c.siteId)) &&
    (!c.edgeGroupId || o.edgeGroups.some((x) => x.id === c.edgeGroupId)) &&
    (!c.emailDefault || route(c.emailDefault)) &&
    (c.emailAll ?? []).every(route) &&
    KINDS.every((k) => !c.messaging?.[k] || o.messaging[k].some((x) => x.id === c.messaging![k]))
  );
}

/** Impostazioni ancora da scegliere (vuoto = pronte) */
export function missingSettings(s: SourceSettings, c: TargetSettings = {}): string[] {
  const out: string[] = [];
  if (s.site && !c.siteId) out.push('Site');
  if (s.edgeGroup && !c.edgeGroupId) out.push('Edge Group');
  if (s.emailDefault && !c.emailDefault) out.push('indirizzo email');
  if (s.emailAll?.length && !c.emailAll?.length && !c.emailDefault) out.push('indirizzi email');
  if (s.phone?.required && !c.phone?.trim()) out.push('numero in uscita');
  return out;
}

interface Props {
  settings: SourceSettings;
  options?: TargetOptions;
  loading: boolean;
  value: TargetSettings;
  onChange: (v: TargetSettings) => void;
}

/** Scelta dei valori del target per Site, Edge Group, indirizzi email e numero in uscita */
export default function TargetSettingsEditor({ settings: s, options, loading, value, onChange }: Props) {
  const o = options ? optionsFor(s, options) : undefined;
  const set = (patch: TargetSettings) => onChange({ ...value, ...patch });
  const width = 240;
  const picker = (
    label: string,
    source: NamedRef,
    current: NamedRef | undefined,
    list: NamedRef[] | undefined,
    v: string | undefined,
    f: (id: string) => void,
  ) => (
    <Tooltip
      title={
        `Sul sorgente: ${source.name}. ` +
        (s.targetCurrent ? `Attuale sul target: ${current?.name ?? 'nessuno'}.` : 'Oggetto non presente sul target.')
      }
    >
      <Select
        size="small"
        style={{ width }}
        showSearch
        optionFilterProp="label"
        loading={loading}
        status={v ? undefined : 'error'}
        placeholder={`${label} del target`}
        value={v}
        onChange={f}
        options={(list ?? []).map((x) => ({ value: x.id, label: `${label}: ${x.name}` }))}
      />
    </Tooltip>
  );
  const emailOptions = (o?.emailAddresses ?? []).map((a) => ({ value: a.routeId, label: a.address }));
  const toPair = (routeId: string) => {
    const a = o?.emailAddresses.find((x) => x.routeId === routeId);
    return a ? { domainId: a.domainId, routeId: a.routeId } : undefined;
  };

  return (
    <Space direction="vertical" size={4}>
      {s.site && picker('Site', s.site, s.targetCurrent?.site, o?.sites, value.siteId, (id) => set({ siteId: id }))}
      {s.edgeGroup &&
        picker('Edge Group', s.edgeGroup, s.targetCurrent?.edgeGroup, o?.edgeGroups, value.edgeGroupId, (id) =>
          set({ edgeGroupId: id }),
        )}
      {s.emailDefault && (
        <Tooltip
          title={
            `Indirizzo email in uscita sul sorgente: ${s.emailDefault.address}` +
            (s.targetCurrent
              ? `. Attuale sul target: ${s.targetCurrent.emailDefault?.address ?? 'nessuno'}`
              : '. Oggetto non presente sul target.') +
            ` Indirizzi disponibili sul target: ${o?.emailAddresses.length ?? 0}.`
          }
        >
          <Select
            size="small"
            style={{ width }}
            showSearch
            optionFilterProp="label"
            loading={loading}
            status={value.emailDefault ? undefined : 'error'}
            placeholder="Indirizzo email del target"
            value={value.emailDefault?.routeId}
            onChange={(id) => set({ emailDefault: toPair(id) })}
            options={emailOptions}
          />
        </Tooltip>
      )}
      {!!s.emailAll?.length && (
        <Tooltip title={`Indirizzi email sul sorgente: ${s.emailAll.map((a) => a.address).join(', ')}`}>
          <Select
            size="small"
            mode="multiple"
            style={{ width }}
            optionFilterProp="label"
            loading={loading}
            placeholder="Tutti gli indirizzi email del target"
            value={(value.emailAll ?? []).map((a) => a.routeId)}
            onChange={(ids: string[]) =>
              set({ emailAll: ids.map(toPair).filter((a): a is NonNullable<typeof a> => !!a) })
            }
            options={emailOptions}
          />
        </Tooltip>
      )}
      {KINDS.filter((k) => s.messaging?.[k]).map((k) => (
        <Tooltip
          key={k}
          title={
            `${MESSAGING_LABELS[k]} in uscita sul sorgente: ${s.messaging![k]!.name}. ` +
            (s.targetCurrent
              ? `Attuale sul target: ${s.targetCurrent.messaging?.[k]?.name ?? 'nessuno'}.`
              : 'Oggetto non presente sul target.') +
            ' Vuoto = nessuno.'
          }
        >
          <Select
            size="small"
            style={{ width }}
            allowClear
            showSearch
            optionFilterProp="label"
            loading={loading}
            placeholder={`${MESSAGING_LABELS[k]} del target (nessuno)`}
            value={value.messaging?.[k] || undefined}
            onChange={(id?: string) => set({ messaging: { ...value.messaging, [k]: id ?? '' } })}
            options={(o?.messaging[k] ?? []).map((x) => ({ value: x.id, label: `${MESSAGING_LABELS[k]}: ${x.name}` }))}
          />
        </Tooltip>
      ))}
      {s.phone && (
        <Tooltip
          title={
            `Sul sorgente: ${s.phone.source || 'nessuno'}. ` +
            (s.phone.target ? `Sul target: ${s.phone.target}.` : 'Non presente sul target: inserirlo a mano.') +
            (s.phone.required ? '' : ' Vuoto = nessun numero.')
          }
        >
          <Input
            size="small"
            style={{ width }}
            addonBefore="Numero"
            status={s.phone.required && !value.phone?.trim() ? 'error' : undefined}
            placeholder={s.phone.required ? 'obbligatorio' : 'nessuno'}
            value={value.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Tooltip>
      )}
    </Space>
  );
}
