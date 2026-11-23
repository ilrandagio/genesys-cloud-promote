import { useQueries, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, Input, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { api, type GcObject, type ObjectType } from '../api/client';
import { flowTypeLabel } from './StatusTag';

/** Scelta per tipo: tutti gli oggetti del tipo, oppure solo quelli scelti */
export interface TypeChoice {
  mode: 'all' | 'pick';
  picked: GcObject[];
}
export type TypeSelection = Partial<Record<ObjectType, TypeChoice>>;

interface TypeInfo {
  type: ObjectType;
  label: string;
  group: string;
}

/**
 * Configurazione minima per far funzionare l'instradamento delle interazioni in ingresso: Flows e ciò che
 * usano più spesso. Le dipendenze non scelte vengono comunque trovate dall'analisi.
 */
export const MINIMAL_TYPES: ObjectType[] = [
  'flow',
  'flowoutcome',
  'flowmilestone',
  'queue',
  'skill',
  'language',
  'wrapupcode',
  'schedule',
  'schedulegroup',
  'emergencygroup',
  'prompt',
  'datatable',
  'integration',
  'dataaction',
  'script',
];

/** Oggetti che non si possono esportare: Data Actions predefinite di Genesys, Flows mai pubblicati */
export const exportable = (o: GcObject) =>
  !(o.type === 'dataaction' && o.id.toLowerCase().startsWith('static')) && !(o.type === 'flow' && o.published === false);

/** Oggetti risultanti dalla selezione, con i tipi ancora in caricamento */
export function resolveSelection(
  selection: TypeSelection,
  lists: Partial<Record<ObjectType, GcObject[]>>,
): { objects: GcObject[]; loading: ObjectType[] } {
  const objects: GcObject[] = [];
  const loading: ObjectType[] = [];
  for (const [type, choice] of Object.entries(selection) as [ObjectType, TypeChoice][]) {
    if (choice.mode === 'pick') objects.push(...choice.picked);
    else if (lists[type]) objects.push(...lists[type]!.filter(exportable));
    else loading.push(type);
  }
  return { objects, loading };
}

/**
 * Selezione per tipo (Disaster Recovery, Backup): si sceglie quali tipi includere e, per ciascuno, tutti gli
 * oggetti oppure solo alcuni. Preset: configurazione minima, tutto, nessuno.
 */
export default function TypeObjectSelection({
  envId,
  value,
  onChange,
  onResolved,
  excludeTypes = [],
}: {
  envId: string;
  value: TypeSelection;
  onChange: (v: TypeSelection) => void;
  /** Oggetti risultanti e tipi ancora in caricamento, aggiornati a ogni cambio */
  onResolved?: (r: { objects: GcObject[]; loading: ObjectType[] }) => void;
  excludeTypes?: ObjectType[];
}) {
  const types = useQuery({
    queryKey: ['object-types'],
    queryFn: () => api<TypeInfo[]>('/api/object-types'),
  });
  const available = (types.data ?? []).filter((t) => !excludeTypes.includes(t.type));
  const chosen = Object.keys(value) as ObjectType[];

  // Elenchi del sorgente dei soli tipi scelti
  const lists = useQueries({
    queries: chosen.map((type) => ({
      queryKey: ['objects', envId, type],
      queryFn: () => api<GcObject[]>(`/api/environments/${envId}/objects/${type}`),
      staleTime: 5 * 60_000,
    })),
  });
  const listByType = useMemo(() => {
    const out: Partial<Record<ObjectType, GcObject[]>> = {};
    chosen.forEach((t, i) => {
      if (lists[i]?.data) out[t] = lists[i].data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.map((l) => l.dataUpdatedAt).join(','), chosen.join(',')]);
  const errorOf = (t: ObjectType) => {
    const i = chosen.indexOf(t);
    return i >= 0 && lists[i]?.error ? (lists[i].error as Error).message : undefined;
  };

  const resolved = useMemo(() => resolveSelection(value, listByType), [value, listByType]);
  useEffect(() => {
    onResolved?.(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  const setType = (type: ObjectType, choice: TypeChoice | undefined) => {
    const next = { ...value };
    if (choice) next[type] = choice;
    else delete next[type];
    onChange(next);
  };
  const preset = (list: ObjectType[]) =>
    onChange(Object.fromEntries(list.filter((t) => available.some((a) => a.type === t)).map((t) => [t, value[t] ?? { mode: 'all', picked: [] }])));

  const rows = available.map((t) => ({ ...t, key: t.type }));
  const failed = chosen.filter((t) => errorOf(t));

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text type="secondary">Preset:</Typography.Text>
        <Tooltip title={`Flows e ciò che usano più spesso: ${MINIMAL_TYPES.length} tipi`}>
          <Button size="small" onClick={() => preset(MINIMAL_TYPES)}>
            Configurazione minima
          </Button>
        </Tooltip>
        <Button size="small" onClick={() => preset(available.map((t) => t.type))}>
          Tutto
        </Button>
        <Button size="small" onClick={() => onChange({})}>
          Nessuno
        </Button>
        <Typography.Text>
          {chosen.length} tipi, {resolved.objects.length} oggetti
          {resolved.loading.length ? ` (caricamento di ${resolved.loading.length} tipi…)` : ''}
        </Typography.Text>
      </Space>
      {failed.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Tipi non leggibili sul sorgente"
          description={failed.map((t) => `${available.find((a) => a.type === t)?.label ?? t}: ${errorOf(t)}`).join(' · ')}
        />
      )}
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        rowKey="key"
        expandable={{
          expandedRowKeys: chosen.filter((t) => value[t]?.mode === 'pick'),
          showExpandColumn: false,
          expandedRowRender: (t) => (
            <ObjectPicker
              type={t.type}
              objects={listByType[t.type]}
              picked={value[t.type]?.picked ?? []}
              onChange={(picked) => setType(t.type, { mode: 'pick', picked })}
            />
          ),
        }}
        columns={[
          {
            title: '',
            width: 40,
            render: (_: unknown, t: TypeInfo) => (
              <Checkbox
                checked={!!value[t.type]}
                onChange={(e) => setType(t.type, e.target.checked ? { mode: 'all', picked: [] } : undefined)}
              />
            ),
          },
          { title: 'Gruppo', dataIndex: 'group', width: 180, render: (g: string) => <Typography.Text type="secondary">{g}</Typography.Text> },
          { title: 'Tipo', dataIndex: 'label' },
          {
            title: 'Oggetti sul sorgente',
            width: 170,
            render: (_: unknown, t: TypeInfo) => {
              if (!value[t.type]) return null;
              if (errorOf(t.type)) return <Tag color="warning">non leggibile</Tag>;
              const list = listByType[t.type];
              if (!list) return <Typography.Text type="secondary">caricamento…</Typography.Text>;
              const n = list.filter(exportable).length;
              return (
                <Tooltip title={n < list.length ? `${list.length - n} esclusi: Data Actions predefinite o Flows mai pubblicati` : undefined}>
                  <Badge count={n} showZero overflowCount={9999} color="blue" />
                </Tooltip>
              );
            },
          },
          {
            title: 'Quali',
            width: 260,
            render: (_: unknown, t: TypeInfo) =>
              value[t.type] ? (
                <Space>
                  <Segmented
                    size="small"
                    value={value[t.type]!.mode}
                    options={[
                      { value: 'all', label: 'Tutti' },
                      { value: 'pick', label: 'Scegli' },
                    ]}
                    onChange={(m) => setType(t.type, { mode: m as 'all' | 'pick', picked: value[t.type]!.picked })}
                  />
                  {value[t.type]!.mode === 'pick' && <Typography.Text type="secondary">{value[t.type]!.picked.length} scelti</Typography.Text>}
                </Space>
              ) : null,
          },
        ]}
      />
    </Space>
  );
}

function ObjectPicker({
  type,
  objects,
  picked,
  onChange,
}: {
  type: ObjectType;
  objects?: GcObject[];
  picked: GcObject[];
  onChange: (p: GcObject[]) => void;
}) {
  const [search, setSearch] = useState('');
  const rows = (objects ?? []).filter(exportable).filter((o) => o.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input.Search size="small" placeholder="Cerca per nome" allowClear value={search} onChange={(e) => setSearch(e.target.value)} />
      <Table
        size="small"
        rowKey="id"
        loading={!objects}
        dataSource={rows}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        rowSelection={{
          preserveSelectedRowKeys: true,
          selectedRowKeys: picked.map((p) => p.id),
          // Dalle chiavi, così restano anche le scelte nascoste dalla ricerca
          onChange: (keys) => {
            const set = new Set(keys.map(String));
            onChange((objects ?? []).filter((o) => set.has(o.id)));
          },
        }}
        columns={[
          { title: 'Nome', dataIndex: 'name' },
          ...(type === 'flow' ? [{ title: 'Tipo flow', dataIndex: 'subtype', render: (t: string) => flowTypeLabel(t) }] : []),
          { title: 'Divisione', dataIndex: 'division' },
        ]}
      />
    </Space>
  );
}
