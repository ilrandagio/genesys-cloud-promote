import { Input, Select, Space, Tooltip } from 'antd';
import type { EmailAddress, NamedRef, SourceSettings, TargetOptions, TargetSettings } from '../api/client';

const localPart = (address: string) => address.split('@')[0].toLowerCase();
const byName = (list: NamedRef[], ref?: NamedRef) =>
  ref ? list.find((x) => x.name.toLowerCase() === ref.name.toLowerCase())?.id : undefined;
/** Indirizzo del target con la stessa parte prima della @ (i domini di solito cambiano tra org), se unico */
const byLocalPart = (list: EmailAddress[], a?: EmailAddress) => {
  if (!a) return undefined;
  const hits = list.filter((x) => localPart(x.address) === localPart(a.address));
  return hits.length === 1 ? { domainId: hits[0].domainId, routeId: hits[0].routeId } : undefined;
};

/**
 * Proposta iniziale: Site ed Edge Group con lo stesso nome, indirizzi email con la stessa parte prima della @,
 * numero in uscita del target se l'oggetto esiste già sul target (altrimenti da inserire a mano)
 */
export function proposeSettings(s: SourceSettings, o: TargetOptions): TargetSettings {
  return {
    siteId: byName(o.sites, s.site),
    edgeGroupId: byName(o.edgeGroups, s.edgeGroup),
    emailDefault: byLocalPart(o.emailAddresses, s.emailDefault),
    emailAll: s.emailAll?.map((a) => byLocalPart(o.emailAddresses, a)).filter((a): a is NonNullable<typeof a> => !!a),
    phone: s.phone?.target ?? '',
  };
}

/** true se le scelte puntano tutte a valori presenti sul target attuale */
export function settingsValid(c: TargetSettings, o: TargetOptions) {
  const route = (a: { routeId: string }) => o.emailAddresses.some((x) => x.routeId === a.routeId);
  return (
    (!c.siteId || o.sites.some((x) => x.id === c.siteId)) &&
    (!c.edgeGroupId || o.edgeGroups.some((x) => x.id === c.edgeGroupId)) &&
    (!c.emailDefault || route(c.emailDefault)) &&
    (c.emailAll ?? []).every(route)
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
export default function TargetSettingsEditor({ settings: s, options: o, loading, value, onChange }: Props) {
  const set = (patch: TargetSettings) => onChange({ ...value, ...patch });
  const width = 240;
  const picker = (label: string, source: NamedRef, list: NamedRef[] | undefined, v: string | undefined, f: (id: string) => void) => (
    <Tooltip title={`Sul sorgente: ${source.name}`}>
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
      {s.site && picker('Site', s.site, o?.sites, value.siteId, (id) => set({ siteId: id }))}
      {s.edgeGroup && picker('Edge Group', s.edgeGroup, o?.edgeGroups, value.edgeGroupId, (id) => set({ edgeGroupId: id }))}
      {s.emailDefault && (
        <Tooltip title={`Indirizzo email in uscita sul sorgente: ${s.emailDefault.address}`}>
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
