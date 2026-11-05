import { ArrowRightOutlined, BranchesOutlined, CodeOutlined, ExclamationCircleFilled, ExperimentOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  type DependencyNode,
  type Environment,
  type GcObject,
  type TargetOptions,
  type TargetSettings,
  type ObjectType,
  type PortAction,
  type PortItem,
} from '../api/client';
import JobView from '../components/JobView';
import TargetSettingsEditor, { missingSettings, proposeSettings, settingsValid } from '../components/TargetSettingsEditor';
import { flowTypeLabel, TargetStatusTag, typeLabel } from '../components/StatusTag';
import { mapCodec, useSessionState } from '../hooks/useSessionState';

const keyOf = (o: { type: string; id: string }) => `${o.type}:${o.id}`;

/** Tipi che in Genesys Cloud possono appartenere a una divisione */
const DIVISIONED = new Set<ObjectType>(['flow', 'queue', 'schedule', 'schedulegroup', 'wrapupcode', 'script', 'datatable', 'emergencygroup',
  'campaign', 'messagingcampaign', 'contactlist', 'contactlistfilter', 'dnclist', 'callanalysisresponseset', 'ruleset', 'campaignrule', 'callabletimeset', 'responseasset']);

interface TreeRow extends Omit<DependencyNode, 'children'> {
  rowKey: string;
  isRoot: boolean;
  /** undefined per le foglie, così la tabella non mostra l'icona di espansione */
  children?: TreeRow[];
}

function toRows(n: DependencyNode, path: string, isRoot: boolean): TreeRow {
  const rowKey = `${path}/${n.rawType ?? n.type}:${n.id}`;
  const children = n.children.map((c) => toRows(c, rowKey, false));
  return { ...n, rowKey, isRoot, children: children.length ? children : undefined };
}

/** Azione proposta di default in base allo stato sul target */
function defaultAction(n: DependencyNode, isRoot: boolean): PortAction {
  if (isRoot) return 'port';
  switch (n.target?.status) {
    case 'missing':
      return 'port';
    case 'same':
    case 'present':
    case 'different':
      return 'reuse';
    default:
      return 'skip';
  }
}

/**
 * Azione effettiva di un nodo: "Usa quella del target" esiste solo se l'oggetto è sul target, "Salta" solo se
 * manca (per un oggetto presente sul target le due scelte coincidono: i riferimenti puntano a quello del target)
 */
function effectiveAction(n: DependencyNode, chosen: PortAction | undefined): PortAction {
  const a = chosen ?? 'skip';
  const exists = !!n.target && n.target.status !== 'missing';
  if (a === 'skip' && exists) return 'reuse';
  if (a === 'reuse' && !exists) return 'skip';
  return a;
}

const ACTION_LABELS: Record<PortAction, string> = { port: 'Porta', reuse: 'Usa quella del target', skip: 'Salta' };

/** Albero filtrato per azione: restano i nodi con quell'azione e i loro antenati */
function filterRows(rows: TreeRow[], keep: (r: TreeRow) => boolean): TreeRow[] {
  return rows.flatMap((r) => {
    const children = r.children ? filterRows(r.children, keep) : [];
    if (!keep(r) && !children.length) return [];
    return [{ ...r, children: children.length ? children : undefined }];
  });
}

export default function PortingPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();

  // Selezione, analisi e azioni restano salvate nella sessione: cambiare pagina o aprire il plan non le perde
  const [sourceId, setSourceId] = useSessionState<string | undefined>('sourceId', undefined);
  const [targetId, setTargetId] = useSessionState<string | undefined>('targetId', undefined);
  const [type, setType] = useSessionState<ObjectType>('type', 'flow');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useSessionState<Map<string, GcObject>>('selected', new Map(), mapCodec());
  const [trees, setTrees] = useSessionState<DependencyNode[] | undefined>('trees', undefined);
  const [warnings, setWarnings] = useSessionState<string[]>('warnings', []);
  const [actions, setActions] = useSessionState<Map<string, PortAction>>('actions', new Map(), mapCodec());
  const [targetSettings, setTargetSettings] = useSessionState<Map<string, TargetSettings>>('targetSettings', new Map(), mapCodec());
  const [includeDivisions, setIncludeDivisions] = useSessionState('includeDivisions', false);
  const [onlySelected, setOnlySelected] = useSessionState('onlySelected', false);
  const [actionFilter, setActionFilter] = useSessionState<PortAction | 'all'>('actionFilter', 'all');
  /** Ultima simulazione, con l'impronta delle scelte da cui è stata generata */
  const [plan, setPlan] = useSessionState<{ jobId: string; fingerprint: string } | undefined>('plan', undefined);
  const [planOpen, setPlanOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const envs = useQuery({ queryKey: ['environments'], queryFn: () => api<Environment[]>('/api/environments') });
  const types = useQuery({
    queryKey: ['object-types'],
    queryFn: () => api<{ type: ObjectType; label: string; group: string }[]>('/api/object-types'),
  });
  const objects = useQuery({
    queryKey: ['objects', sourceId, type],
    queryFn: () => api<GcObject[]>(`/api/environments/${sourceId}/objects/${type}`),
    enabled: !!sourceId,
  });

  // "Solo selezionati": gli oggetti selezionati di tutti i tipi, altrimenti quelli del tipo corrente
  const filtered = useMemo(
    () =>
      (onlySelected ? [...selected.values()] : (objects.data ?? [])).filter((o) =>
        o.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [objects.data, search, onlySelected, selected],
  );

  const resetAnalysis = () => {
    setTrees(undefined);
    setActions(new Map());
    setWarnings([]);
    setPlan(undefined);
  };

  const step = !sourceId || !targetId ? 0 : !trees ? 1 : 2;

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await api<{ trees: DependencyNode[]; warnings?: string[] }>('/api/analyze', {
        method: 'POST',
        body: {
          sourceEnvId: sourceId,
          targetEnvId: targetId,
          objects: [...selected.values()].map(({ type, id, name, subtype }) => ({ type, id, name, subtype })),
          includeDivisions,
        },
      });
      const acts = new Map<string, PortAction>();
      const walk = (n: DependencyNode, root: boolean) => {
        if (n.supported && !acts.has(keyOf(n))) acts.set(keyOf(n), defaultAction(n, root));
        n.children.forEach((c) => walk(c, false));
      };
      res.trees.forEach((t) => walk(t, true));
      setActions(acts);
      setTrees(res.trees);
      setWarnings(res.warnings ?? []);
      setPlan(undefined);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  /** Campaigns e Queues dell'analisi con impostazioni legate all'org (Site, Edge Group, email, numero) */
  const settingsNodes = useMemo(() => {
    const out = new Map<string, DependencyNode>();
    const walk = (n: DependencyNode) => {
      if (n.settings && !out.has(keyOf(n))) out.set(keyOf(n), n);
      n.children.forEach(walk);
    };
    trees?.forEach(walk);
    return out;
  }, [trees]);

  /** Valori del target tra cui scegliere */
  const targetValues = useQuery({
    queryKey: ['target-options', targetId],
    queryFn: () => api<TargetOptions>(`/api/environments/${targetId}/target-options`),
    enabled: !!targetId && settingsNodes.size > 0,
  });

  // Proposta iniziale (per nome, per indirizzo, numero del target); scelte non valide sul target attuale riproposte
  useEffect(() => {
    const data = targetValues.data;
    if (!data || !settingsNodes.size) return;
    let changed = false;
    const next = new Map(targetSettings);
    for (const [key, n] of settingsNodes) {
      const current = next.get(key);
      if (current && settingsValid(current, data)) continue;
      next.set(key, proposeSettings(n.settings!, data));
      changed = true;
    }
    if (changed) setTargetSettings(next);
  }, [targetValues.data, settingsNodes, targetSettings, setTargetSettings]);

  /** Elenco unico degli oggetti con l'azione scelta (un oggetto può comparire più volte nell'albero) */
  const items = useMemo<PortItem[]>(() => {
    const out = new Map<string, PortItem>();
    const walk = (n: DependencyNode) => {
      if (n.supported && n.target && !out.has(keyOf(n))) {
        out.set(keyOf(n), {
          type: n.type,
          id: n.id,
          name: n.name,
          subtype: n.subtype,
          action: effectiveAction(n, actions.get(keyOf(n))),
          targetStatus: n.target.status,
          targetId: n.target.id,
          ...(n.settings ? { targetSettings: targetSettings.get(keyOf(n)) ?? {} } : {}),
        });
      }
      n.children.forEach(walk);
    };
    trees?.forEach(walk);
    return [...out.values()];
  }, [trees, actions, targetSettings]);

  /** Archi dell'albero ("from" usa "to"): il server li usa per l'ordine di creazione (depends_on) */
  const edges = useMemo(() => {
    const out = new Map<string, { from: string; to: string }>();
    const walk = (n: DependencyNode) => {
      for (const c of n.children) {
        if (n.supported && c.supported && !c.repeated) {
          const e = { from: keyOf(n), to: keyOf(c) };
          out.set(`${e.from}>${e.to}`, e);
        }
        if (!c.repeated) walk(c);
      }
    };
    trees?.forEach(walk);
    return [...out.values()];
  }, [trees]);

  /** Impronta delle scelte correnti: se cambia dopo la simulazione, il plan non corrisponde più */
  const fingerprint = useMemo(
    () =>
      JSON.stringify([
        sourceId,
        targetId,
        [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b))).map((i) => [keyOf(i), i.action, i.targetId ?? '', i.targetSettings ?? null]),
      ]),
    [sourceId, targetId, items],
  );
  const planIsCurrent = !!plan && plan.fingerprint === fingerprint;

  /** Campaigns e Queues da portare a cui manca una scelta sul target */
  const settingsMissing = items
    .filter((i) => i.action === 'port' && settingsNodes.has(keyOf(i)))
    .map((i) => ({ name: i.name, missing: missingSettings(settingsNodes.get(keyOf(i))!.settings!, i.targetSettings) }))
    .filter((x) => x.missing.length)
    .map((x) => `${x.name} (${x.missing.join(', ')})`);

  const counts = {
    port: items.filter((i) => i.action === 'port').length,
    overwrite: items.filter((i) => i.action === 'port' && i.targetId).length,
    missingSkipped: items.filter((i) => i.action === 'skip' && i.targetStatus === 'missing').length,
  };

  const unsupported = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: DependencyNode) => {
      if (!n.supported) out.add(`${n.rawType} "${n.name}"`);
      n.children.forEach(walk);
    };
    trees?.forEach(walk);
    return [...out];
  }, [trees]);

  /** Problemi di lettura (permessi) emersi durante l'analisi, senza duplicati */
  const readErrors = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: DependencyNode) => {
      n.error?.split('\n').forEach((e) => out.add(e));
      n.children.forEach(walk);
    };
    trees?.forEach(walk);
    return [...out];
  }, [trees]);

  /** Simulazione: unica strada verso un rilascio (plan → eventuale approvazione → esecuzione del plan) */
  const simulate = async () => {
    setSubmitting(true);
    try {
      const job = await api<{ id: string }>('/api/jobs', {
        method: 'POST',
        body: { sourceEnvId: sourceId, targetEnvId: targetId, items, edges },
      });
      setPlan({ jobId: job.id, fingerprint });
      setPlanOpen(true);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const envOptions = (envs.data ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.region})` }));
  const targetOptions = (envs.data ?? [])
    .filter((e) => e.allowAsTarget && e.id !== sourceId)
    .map((e) => ({ value: e.id, label: `${e.name} (${e.region})` }));

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Steps
        current={step}
        items={[{ title: 'Ambienti' }, { title: 'Oggetti da portare' }, { title: 'Dipendenze e porting' }]}
      />

      <Card title="1. Ambienti">
        {envs.data?.length === 0 && (
          <Alert
            type="info"
            showIcon
            message="Nessun ambiente configurato"
            description="Aggiungi almeno due ambienti nella sezione Ambienti."
            style={{ marginBottom: 16 }}
          />
        )}
        <Space size="large" wrap>
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">Sorgente</Typography.Text>
            <Select
              style={{ width: 280 }}
              placeholder="Ambiente sorgente"
              options={envOptions}
              value={sourceId}
              onChange={(v) => {
                setSourceId(v);
                if (v === targetId) setTargetId(undefined);
                setSelected(new Map());
                resetAnalysis();
              }}
            />
          </Space>
          <ArrowRightOutlined style={{ fontSize: 20, marginTop: 20 }} />
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">Target</Typography.Text>
            <Select
              style={{ width: 280 }}
              placeholder="Ambiente target"
              options={targetOptions}
              value={targetId}
              disabled={!sourceId}
              onChange={(v) => {
                setTargetId(v);
                resetAnalysis();
              }}
            />
          </Space>
        </Space>
      </Card>

      {sourceId && targetId && (
        <Card
          title="2. Oggetti sul sorgente"
          extra={
            <Space size="large">
              <Tooltip title="Mostra la divisione di ogni oggetto come dipendenza, con la scelta se portarla o usare quella del target. Da spento, le divisioni vengono comunque abbinate per nome.">
                <Space size={6}>
                  <Switch
                    size="small"
                    checked={includeDivisions}
                    onChange={(v) => {
                      setIncludeDivisions(v);
                      resetAnalysis();
                    }}
                  />
                  <Typography.Text>Includi divisioni</Typography.Text>
                </Space>
              </Tooltip>
              <Tooltip title="Mostra nell'elenco solo gli oggetti selezionati, di tutti i tipi">
                <Space size={6}>
                  <Switch size="small" checked={onlySelected} onChange={setOnlySelected} />
                  <Typography.Text>Solo selezionati</Typography.Text>
                </Space>
              </Tooltip>
              <Typography.Text>{selected.size} selezionati</Typography.Text>
              <Button
                type="primary"
                icon={<BranchesOutlined />}
                disabled={!selected.size}
                loading={analyzing}
                onClick={analyze}
              >
                Analizza dipendenze
              </Button>
            </Space>
          }
        >
          <Row gutter={16}>
            <Col flex="220px">
              <Select
                style={{ width: '100%' }}
                value={type}
                onChange={(v) => {
                  setType(v);
                  setSearch('');
                }}
                showSearch
                optionFilterProp="label"
                options={Object.entries(
                  (types.data ?? []).reduce<Record<string, { value: ObjectType; label: string }[]>>((acc, t) => {
                    (acc[t.group] ??= []).push({ value: t.type, label: t.label });
                    return acc;
                  }, {}),
                ).map(([group, opts]) => ({ label: group, options: opts }))}
              />
            </Col>
            <Col flex="auto">
              <Input.Search placeholder="Cerca per nome" allowClear value={search} onChange={(e) => setSearch(e.target.value)} />
            </Col>
          </Row>
          {selected.size > 0 && (
            <div style={{ margin: '12px 0' }}>
              {[...selected.values()].map((o) => (
                <Tag
                  key={keyOf(o)}
                  closable
                  onClose={() => {
                    const next = new Map(selected);
                    next.delete(keyOf(o));
                    setSelected(next);
                    resetAnalysis();
                  }}
                >
                  {typeLabel(o)}: {o.name}
                </Tag>
              ))}
            </div>
          )}
          <Table
            style={{ marginTop: 12 }}
            size="small"
            rowKey={(o) => keyOf(o)}
            loading={!onlySelected && objects.isLoading}
            dataSource={filtered}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            locale={{ emptyText: !onlySelected && objects.isError ? (objects.error as Error).message : <Empty /> }}
            rowSelection={{
              preserveSelectedRowKeys: true,
              selectedRowKeys: [...selected.keys()],
              onChange: (keys, rows) => {
                // Solo selezionati: si può solo togliere dalla selezione
                if (onlySelected) {
                  const keep = new Set(keys.map(String));
                  setSelected(new Map([...selected].filter(([k]) => keep.has(k))));
                  resetAnalysis();
                  return;
                }
                // Mantiene la selezione degli altri tipi e aggiorna solo quella del tipo corrente
                const next = new Map([...selected].filter(([, o]) => o.type !== type));
                rows.filter(Boolean).forEach((r) => next.set(keyOf(r), r));
                setSelected(next);
                resetAnalysis();
              },
            }}
            columns={[
              { title: 'Nome', dataIndex: 'name' },
              ...(onlySelected ? [{ title: 'Tipo', key: 'type', render: (_: unknown, o: GcObject) => typeLabel(o) }] : []),
              ...(!onlySelected && type === 'flow'
                ? [
                    { title: 'Tipo flow', dataIndex: 'subtype', render: (t: string) => flowTypeLabel(t) },
                    {
                      title: 'Pubblicato',
                      dataIndex: 'published',
                      render: (v: boolean) => (v ? <Tag color="green">sì</Tag> : <Tag>no</Tag>),
                    },
                  ]
                : []),
              { title: 'Divisione', dataIndex: 'division' },
              { title: 'Descrizione', dataIndex: 'description', ellipsis: true },
            ]}
          />
        </Card>
      )}

      {trees && (
        <Card
          title="3. Dipendenze e stato sul target"
          extra={
            <Space>
              {plan &&
                (planIsCurrent ? (
                  <Button onClick={() => setPlanOpen(true)}>Vedi simulazione</Button>
                ) : (
                  <Tooltip title="Dopo la simulazione sono cambiate le scelte: rifai la simulazione per vedere il piano aggiornato">
                    <Tag color="orange">simulazione non più valida</Tag>
                  </Tooltip>
                ))}
              <Select<PortAction | 'all'>
                style={{ width: 260 }}
                value={actionFilter}
                onChange={setActionFilter}
                options={[
                  { value: 'all', label: `Mostra: tutti (${items.length})` },
                  ...(['port', 'reuse', 'skip'] as const).map((a) => ({
                    value: a,
                    label: `Mostra: ${ACTION_LABELS[a]} (${items.filter((i) => i.action === a).length})`,
                  })),
                ]}
              />
              <Tooltip
                title={settingsMissing.length ? `Scegliere sul target: ${settingsMissing.join('; ')}` : undefined}
              >
                <Button
                  type="primary"
                  icon={<ExperimentOutlined />}
                  loading={submitting}
                  disabled={!counts.port || settingsMissing.length > 0}
                  onClick={simulate}
                >
                  Simula (plan)
                </Button>
              </Tooltip>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="red">Da portare: {counts.port}</Tag>
              <Tag color="orange">Sovrascritture: {counts.overwrite}</Tag>
              <Tag>Oggetti distinti: {items.length}</Tag>
            </Space>
            {counts.missingSkipped > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${counts.missingSkipped} dipendenze mancanti sul target sono impostate su "Salta": gli oggetti che le usano potrebbero fallire.`}
              />
            )}
            {warnings.map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}
            {readErrors.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="Alcuni oggetti non sono leggibili: l'analisi è incompleta"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {readErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {unsupported.length > 0 && (
              <Alert
                type="info"
                showIcon
                message="Dipendenze non gestite dal porting (verificare manualmente sul target)"
                description={unsupported.join(', ')}
              />
            )}
            <Table<TreeRow>
              size="small"
              rowKey="rowKey"
              pagination={false}
              // key: con un filtro diverso l'albero si riapre tutto espanso
              key={actionFilter}
              dataSource={(() => {
                const rows = trees.map((t) => toRows(t, '', true));
                if (actionFilter === 'all') return rows;
                return filterRows(
                  rows,
                  (r) => r.supported && !r.repeated && !!r.target && effectiveAction(r as DependencyNode, actions.get(keyOf(r))) === actionFilter,
                );
              })()}
              locale={{ emptyText: <Empty description={actionFilter === 'all' ? undefined : `Nessun oggetto con azione "${ACTION_LABELS[actionFilter]}"`} /> }}
              expandable={{ defaultExpandAllRows: true }}
              columns={[
                {
                  title: 'Oggetto',
                  dataIndex: 'name',
                  render: (name: string, n) => (
                    <Space>
                      <Typography.Text strong={n.isRoot} type={n.supported ? undefined : 'secondary'}>
                        {name}
                      </Typography.Text>
                      {n.rawType?.includes('(per nome)') && (
                        <Tooltip title="Riconosciuto dal nome usato nella configurazione (nei flow i riferimenti sono per nome)">
                          <Tag color="blue">per nome</Tag>
                        </Tooltip>
                      )}
                      {n.repeated && (
                        <Tooltip title="Questo oggetto dipende (anche indirettamente) da un oggetto che lo contiene: il ramo si ferma qui">
                          <Tag>dipendenza circolare</Tag>
                        </Tooltip>
                      )}
                      {n.error && (
                        <Tooltip title={n.error}>
                          <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />
                        </Tooltip>
                      )}
                      {n.supported && (n.type === 'flow' || n.type === 'script') && (
                        <Tooltip title="Configurazione letta da Genesys (dove l'analisi cerca i riferimenti)">
                          <a
                            href={`/api/environments/${sourceId}/objects/${n.type}/${encodeURIComponent(n.id)}/raw`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <CodeOutlined />
                          </a>
                        </Tooltip>
                      )}
                    </Space>
                  ),
                },
                {
                  title: 'Tipo',
                  render: (_, n) => (n.supported ? typeLabel(n) : <Tag>{n.rawType}</Tag>),
                  width: 220,
                },
                {
                  title: 'Divisione',
                  width: 200,
                  render: (_, n) => {
                    if (!n.division) {
                      // Tipi che prevedono una divisione ma l'oggetto non è assegnato a nessuna (es. script)
                      return n.supported && DIVISIONED.has(n.type) ? <Typography.Text type="secondary">nessuna</Typography.Text> : null;
                    }
                    const tgt = n.target?.division;
                    const differs = tgt && tgt.name.toLowerCase() !== n.division.name.toLowerCase();
                    return (
                      <Space size={4} wrap>
                        <Typography.Text>{n.division.name}</Typography.Text>
                        {differs && (
                          <Tooltip title={`Sul target l'oggetto è nella divisione "${tgt.name}"`}>
                            <Tag color="orange">target: {tgt.name}</Tag>
                          </Tooltip>
                        )}
                        {n.target?.divisionMissing && (
                          <Tooltip title="Questa divisione non esiste sul target: va creata o portata (Includi divisioni)">
                            <Tag color="red">assente sul target</Tag>
                          </Tooltip>
                        )}
                      </Space>
                    );
                  },
                },
                {
                  title: 'Sul target',
                  render: (_, n) =>
                    !n.supported ? (
                      <Tag>non gestito</Tag>
                    ) : n.target ? (
                      <TargetStatusTag status={n.target.status} diff={n.target.diff} />
                    ) : (
                      <Tooltip title={n.error}>
                        <Tag color="red">non accessibile</Tag>
                      </Tooltip>
                    ),
                  width: 170,
                },
                {
                  title: 'Azione',
                  width: 260,
                  render: (_, n) => {
                    if (!n.supported || n.repeated || !n.target) return null;
                    const exists = n.target?.status !== 'missing';
                    const action = (
                      <Select<PortAction>
                        size="small"
                        style={{ width: 240 }}
                        value={effectiveAction(n as DependencyNode, actions.get(keyOf(n)))}
                        onChange={(v) => setActions(new Map(actions).set(keyOf(n), v))}
                        options={[
                          { value: 'port', label: exists ? 'Porta (sovrascrivi sul target)' : 'Porta' },
                          // Presente sul target: si usa quello; mancante: si salta (i riferimenti restano scoperti)
                          exists
                            ? { value: 'reuse' as const, label: ACTION_LABELS.reuse }
                            : { value: 'skip' as const, label: `${ACTION_LABELS.skip} (non portare)` },
                        ]}
                      />
                    );
                    if (!n.settings || effectiveAction(n as DependencyNode, actions.get(keyOf(n))) !== 'port') return action;
                    // Campaign e Queue: Site, Edge Group, email e numero si scelgono sul target
                    return (
                      <Space direction="vertical" size={4}>
                        {action}
                        <TargetSettingsEditor
                          settings={n.settings}
                          options={targetValues.data}
                          loading={targetValues.isLoading}
                          value={targetSettings.get(keyOf(n)) ?? {}}
                          onChange={(v) => setTargetSettings(new Map(targetSettings).set(keyOf(n), v))}
                        />
                      </Space>
                    );
                  },
                },
              ]}
            />
          </Space>
        </Card>
      )}

      <Drawer
        title="Simulazione"
        width={960}
        open={planOpen && !!plan}
        onClose={() => setPlanOpen(false)}
        destroyOnHidden
      >
        {plan && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {!planIsCurrent && (
              <Alert
                type="warning"
                showIcon
                message="Le scelte sono cambiate dopo questa simulazione. Eseguendola si applicano le scelte della simulazione, non quelle attuali: per applicare quelle attuali rifai la simulazione."
              />
            )}
            <JobView compact id={plan.jobId} onApplied={(applyId) => navigate(`/jobs/${applyId}`)} />
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
