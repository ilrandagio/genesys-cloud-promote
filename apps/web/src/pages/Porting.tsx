import { ArrowRightOutlined, BranchesOutlined, ExclamationCircleFilled, ExperimentOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
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
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  type DependencyNode,
  type Environment,
  type GcObject,
  type ObjectType,
  type PortAction,
  type PortItem,
} from '../api/client';
import { TargetStatusTag, TYPE_LABELS } from '../components/StatusTag';

const keyOf = (o: { type: string; id: string }) => `${o.type}:${o.id}`;

/** Tipi che in Genesys Cloud possono appartenere a una divisione */
const DIVISIONED = new Set<ObjectType>(['flow', 'queue', 'schedule', 'schedulegroup', 'wrapupcode', 'script']);

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

export default function PortingPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();

  const [sourceId, setSourceId] = useState<string>();
  const [targetId, setTargetId] = useState<string>();
  const [type, setType] = useState<ObjectType>('flow');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, GcObject>>(new Map());
  const [trees, setTrees] = useState<DependencyNode[]>();
  const [actions, setActions] = useState<Map<string, PortAction>>(new Map());
  const [analyzing, setAnalyzing] = useState(false);
  const [includeDivisions, setIncludeDivisions] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const envs = useQuery({ queryKey: ['environments'], queryFn: () => api<Environment[]>('/api/environments') });
  const types = useQuery({
    queryKey: ['object-types'],
    queryFn: () => api<{ type: ObjectType; label: string }[]>('/api/object-types'),
  });
  const objects = useQuery({
    queryKey: ['objects', sourceId, type],
    queryFn: () => api<GcObject[]>(`/api/environments/${sourceId}/objects/${type}`),
    enabled: !!sourceId,
  });

  const filtered = useMemo(
    () => (objects.data ?? []).filter((o) => o.name.toLowerCase().includes(search.toLowerCase())),
    [objects.data, search],
  );

  const resetAnalysis = () => {
    setTrees(undefined);
    setActions(new Map());
  };

  const step = !sourceId || !targetId ? 0 : !trees ? 1 : 2;

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await api<{ trees: DependencyNode[] }>('/api/analyze', {
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
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

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
          action: actions.get(keyOf(n)) ?? 'skip',
          targetStatus: n.target.status,
          targetId: n.target.id,
        });
      }
      n.children.forEach(walk);
    };
    trees?.forEach(walk);
    return [...out.values()];
  }, [trees, actions]);

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

  const submit = (mode: 'PLAN' | 'APPLY') => {
    const run = async () => {
      setSubmitting(true);
      try {
        const job = await api<{ id: string }>('/api/jobs', {
          method: 'POST',
          body: { sourceEnvId: sourceId, targetEnvId: targetId, mode, items },
        });
        navigate(`/jobs/${job.id}`);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setSubmitting(false);
      }
    };
    if (mode === 'PLAN') return run();
    const target = envs.data?.find((e) => e.id === targetId)?.name;
    modal.confirm({
      title: `Eseguire il porting su ${target}?`,
      content: (
        <>
          Verranno scritti <b>{counts.port}</b> oggetti sul target
          {counts.overwrite > 0 && (
            <>
              , di cui <b>{counts.overwrite}</b> già esistenti che verranno <b>sovrascritti</b>
            </>
          )}
          .
        </>
      ),
      okText: 'Esegui porting',
      okButtonProps: { danger: true },
      onOk: run,
    });
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
                options={(types.data ?? []).map((t) => ({ value: t.type, label: t.label }))}
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
                  {TYPE_LABELS[o.type]}: {o.name}
                </Tag>
              ))}
            </div>
          )}
          <Table
            style={{ marginTop: 12 }}
            size="small"
            rowKey={(o) => keyOf(o)}
            loading={objects.isLoading}
            dataSource={filtered}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            locale={{ emptyText: objects.isError ? (objects.error as Error).message : <Empty /> }}
            rowSelection={{
              preserveSelectedRowKeys: true,
              selectedRowKeys: [...selected.keys()],
              onChange: (_keys, rows) => {
                // Mantiene la selezione degli altri tipi e aggiorna solo quella del tipo corrente
                const next = new Map([...selected].filter(([, o]) => o.type !== type));
                rows.filter(Boolean).forEach((r) => next.set(keyOf(r), r));
                setSelected(next);
                resetAnalysis();
              },
            }}
            columns={[
              { title: 'Nome', dataIndex: 'name' },
              ...(type === 'flow'
                ? [
                    { title: 'Tipo flow', dataIndex: 'subtype' },
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
              <Button icon={<ExperimentOutlined />} loading={submitting} disabled={!counts.port} onClick={() => submit('PLAN')}>
                Simula (plan)
              </Button>
              <Button
                type="primary"
                danger
                icon={<PlayCircleOutlined />}
                loading={submitting}
                disabled={!counts.port}
                onClick={() => submit('APPLY')}
              >
                Esegui porting
              </Button>
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
              dataSource={trees.map((t) => toRows(t, '', true))}
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
                    </Space>
                  ),
                },
                {
                  title: 'Tipo',
                  render: (_, n) => (n.supported ? TYPE_LABELS[n.type] : <Tag>{n.rawType}</Tag>),
                  width: 160,
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
                    return (
                      <Select<PortAction>
                        size="small"
                        style={{ width: 240 }}
                        value={actions.get(keyOf(n))}
                        onChange={(v) => setActions(new Map(actions).set(keyOf(n), v))}
                        options={[
                          { value: 'port', label: exists ? 'Porta (sovrascrivi sul target)' : 'Porta' },
                          ...(exists ? [{ value: 'reuse' as const, label: 'Usa quella del target' }] : []),
                          { value: 'skip', label: 'Salta' },
                        ]}
                      />
                    );
                  },
                },
              ]}
            />
          </Space>
        </Card>
      )}
    </Space>
  );
}
