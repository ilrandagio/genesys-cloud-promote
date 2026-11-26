import { ArrowLeftOutlined, DiffOutlined, LockOutlined, RocketOutlined, UnlockOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Descriptions, Empty, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type GcObject,
  type ObjectType,
  type ReleaseCompare,
  type ReleaseCompareStatus,
  type ReleaseDetail,
  type ReleaseObjectBrief,
  type ReleaseTag,
} from '../api/client';
import { DiffView } from '../components/DiffModal';
import { filterBy, JobStatusTag, sortBy, typeLabel } from '../components/StatusTag';

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString('it-IT') : '—');
const objType = (o: Pick<ReleaseObjectBrief, 'type' | 'tfType' | 'subtype'>) =>
  o.type ? typeLabel({ type: o.type, subtype: o.subtype ?? undefined }) : o.tfType;

const STATUS: Record<ReleaseCompareStatus, { color: string; label: string }> = {
  same: { color: 'green', label: 'uguale' },
  different: { color: 'orange', label: 'diverso' },
  only_tag: { color: 'blue', label: 'solo nel tag' },
  only_other: { color: 'purple', label: "solo nell'altro" },
  missing_live: { color: 'red', label: 'non più presente' },
  not_comparable: { color: 'default', label: 'non confrontabile' },
};

type CompareRow = ReleaseCompare['rows'][number];

export default function ReleaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [compareWith, setCompareWith] = useState<string>();
  const [diffRow, setDiffRow] = useState<CompareRow>();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState('');

  const tag = useQuery({ queryKey: ['release', id], queryFn: () => api<ReleaseDetail>(`/api/releases/${id}`), enabled: !!id });
  const allTags = useQuery({ queryKey: ['releases', 'all'], queryFn: () => api<ReleaseTag[]>('/api/releases') });
  const compare = useQuery({
    queryKey: ['release-compare', id, compareWith],
    queryFn: () => api<ReleaseCompare>(`/api/releases/${id}/compare?with=${encodeURIComponent(compareWith!)}`),
    enabled: !!id && !!compareWith,
  });
  const diff = useQuery({
    queryKey: ['release-diff', id, compareWith, diffRow?.key],
    queryFn: () => {
      const q = new URLSearchParams();
      if (diffRow?.tag) q.set('objectId', diffRow.tag.id);
      if (diffRow?.other) q.set('otherObjectId', diffRow.other.id);
      if (compareWith === 'live') q.set('live', '1');
      return api<{ tag: unknown; other: unknown }>(`/api/releases/${id}/diff?${q}`);
    },
    enabled: !!diffRow,
  });

  const otherLabel = compareWith === 'live' ? 'live' : compare.data?.other.kind === 'tag' ? `${compare.data.other.name} (${compare.data.other.targetName})` : "l'altro tag";

  const compareOptions = useMemo(() => {
    const t = tag.data;
    if (!t) return [];
    const others = (allTags.data ?? []).filter((x) => x.id !== t.id);
    const same = others.filter((x) => x.targetEnvId === t.targetEnvId);
    const diffEnv = others.filter((x) => x.targetEnvId !== t.targetEnvId);
    return [
      { label: 'Sistema live', options: [{ value: 'live', label: `Live di ${t.targetName}` }] },
      ...(same.length ? [{ label: `Altri rilasci di ${t.targetName}`, options: same.map((x) => ({ value: x.id, label: x.name })) }] : []),
      ...(diffEnv.length
        ? [{ label: 'Rilasci di altri ambienti', options: diffEnv.map((x) => ({ value: x.id, label: `${x.name} (${x.targetName})` })) }]
        : []),
    ];
  }, [tag.data, allTags.data]);

  if (!id) return null;
  if (tag.isLoading) return <Spin />;
  if (tag.error) return <Alert type="error" showIcon message={(tag.error as Error).message} />;
  const t = tag.data!;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['release', id] });
    qc.invalidateQueries({ queryKey: ['releases'] });
  };
  const setClosed = async (closed: boolean) => {
    try {
      await api(`/api/releases/${id}/close`, { method: 'POST', body: { closed } });
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const saveDescription = async () => {
    try {
      await api(`/api/releases/${id}`, { method: 'PATCH', body: { description } });
      setEditing(false);
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const remove = async () => {
    try {
      await api(`/api/releases/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['releases'] });
      navigate('/releases');
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  /** Promozione: porting con sorgente = ambiente del tag e oggetti = contenuto del tag (tipi del catalogo) */
  const promotable = t.objects.filter((o) => o.type && o.targetId);
  const promoteTo = () => {
    const objects: GcObject[] = promotable.map((o) => ({
      type: o.type as ObjectType,
      id: o.targetId!,
      name: o.name,
      subtype: o.subtype ?? undefined,
    }));
    navigate('/porting', { state: { promote: { sourceEnvId: t.targetEnvId, objects, tagName: t.name, fromTagId: t.id } } });
  };

  const applies = t.jobs.filter((j) => j.mode === 'APPLY');
  const genericCount = t.objects.length - promotable.length;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/releases')} />
            <Typography.Text strong style={{ fontSize: 16 }}>
              {t.name}
            </Typography.Text>
            <Tag>{t.targetName}</Tag>
            {t.closedAt ? <Tag icon={<LockOutlined />}>chiuso</Tag> : <Tag color="green">aperto</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Tooltip
              title={
                promotable.length
                  ? `Apre il porting con sorgente ${t.targetName} e i ${promotable.length} oggetti del rilascio` +
                    (genericCount ? ` (${genericCount} di tipi generici esclusi)` : '')
                  : 'Nessun oggetto del catalogo da promuovere'
              }
            >
              <Button icon={<RocketOutlined />} disabled={!promotable.length} onClick={promoteTo}>
                Promuovi in un altro ambiente
              </Button>
            </Tooltip>
            {t.closedAt ? (
              <Button icon={<UnlockOutlined />} onClick={() => setClosed(false)}>
                Riapri
              </Button>
            ) : (
              <Popconfirm title="Chiudere il rilascio? Non si potrà più associare a nuove simulazioni (si può riaprire)." onConfirm={() => setClosed(true)}>
                <Button icon={<LockOutlined />}>Chiudi</Button>
              </Popconfirm>
            )}
            {!t.jobs.length && (
              <Popconfirm title="Eliminare il rilascio?" onConfirm={remove}>
                <Button danger>Elimina</Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="Ambiente">
            {t.targetName} ({t.targetRegion})
          </Descriptions.Item>
          <Descriptions.Item label="Creato">
            {fmt(t.createdAt)} da {t.createdBy}
          </Descriptions.Item>
          {t.promotedFrom && (
            <Descriptions.Item label="Promosso da">
              <a onClick={() => navigate(`/releases/${t.promotedFrom!.id}`)}>
                {t.promotedFrom.name} ({t.promotedFrom.targetName})
              </a>
            </Descriptions.Item>
          )}
          {t.closedAt && (
            <Descriptions.Item label="Chiuso">
              {fmt(t.closedAt)} da {t.closedBy}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Descrizione" span={2}>
            {editing ? (
              <Space.Compact style={{ width: '100%' }}>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} onPressEnter={saveDescription} />
                <Button type="primary" onClick={saveDescription}>
                  Salva
                </Button>
              </Space.Compact>
            ) : (
              <a
                onClick={() => {
                  setDescription(t.description ?? '');
                  setEditing(true);
                }}
              >
                {t.description || 'Aggiungi una descrizione'}
              </a>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: 'objects',
              label: `Contenuto (${t.objects.length})`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Typography.Text type="secondary">
                    Per ogni oggetto l'ultima versione portata nel rilascio, letta dal target dopo l'esecuzione.
                  </Typography.Text>
                  <Table<ReleaseObjectBrief>
                    rowKey="id"
                    size="small"
                    dataSource={t.objects}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    locale={{ emptyText: <Empty description="Nessun oggetto: il contenuto si forma con le esecuzioni del rilascio" /> }}
                    columns={[
                      { title: 'Oggetto', dataIndex: 'name', ...sortBy<ReleaseObjectBrief>((o) => o.name) },
                      { title: 'Tipo', render: (_, o) => objType(o), ...sortBy<ReleaseObjectBrief>(objType, 2), ...filterBy<ReleaseObjectBrief>(t.objects, objType) },
                      { title: 'Versione pubblicata', dataIndex: 'version', width: 150, render: (v?: string) => v ?? '—' },
                      {
                        title: 'Portato',
                        width: 110,
                        render: (_, o) => (
                          <Tooltip title="Volte in cui l'oggetto è stato portato nel rilascio">{o.versions ?? 1}×</Tooltip>
                        ),
                      },
                      {
                        title: 'Ultima esecuzione',
                        render: (_, o) => <a onClick={() => navigate(`/jobs/${o.jobId}`)}>{fmt(o.capturedAt)}</a>,
                      },
                      {
                        title: '',
                        render: (_, o) =>
                          o.error ? (
                            <Tooltip title={o.error}>
                              <Tag color="warning">non letto</Tag>
                            </Tooltip>
                          ) : !o.comparable ? (
                            <Tag>senza contenuto</Tag>
                          ) : null,
                      },
                    ]}
                  />
                  {t.undone.length > 0 && (
                    <Alert
                      type="info"
                      showIcon
                      message={`Annullati da un ripristino (${t.undone.length})`}
                      description={t.undone.map((o) => `${objType(o)} "${o.name}"`).join(', ')}
                    />
                  )}
                </Space>
              ),
            },
            {
              key: 'jobs',
              label: `Esecuzioni (${applies.length})`,
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={t.jobs}
                  pagination={false}
                  onRow={(r) => ({ onClick: () => navigate(`/jobs/${r.id}`), style: { cursor: 'pointer' } })}
                  columns={[
                    { title: 'Data', render: (_, r) => fmt(r.createdAt) },
                    {
                      title: 'Tipo',
                      render: (_, r) =>
                        r.mode === 'APPLY' ? (
                          <Tag color="red">esecuzione</Tag>
                        ) : r.rollbackOfJobId ? (
                          <Tag color="purple">simulazione di ripristino</Tag>
                        ) : (
                          <Tag>simulazione</Tag>
                        ),
                    },
                    { title: 'Esito', render: (_, r) => <JobStatusTag status={r.status as any} /> },
                    { title: 'Sorgente', dataIndex: 'sourceName' },
                    { title: 'Oggetti scritti', render: (_, r) => (r.mode === 'APPLY' ? (r.appliedResources?.length ?? 0) : '') },
                    { title: 'Da', dataIndex: 'createdBy' },
                  ]}
                />
              ),
            },
            {
              key: 'compare',
              label: 'Confronta',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space wrap>
                    <Typography.Text>Confronta {t.name} con</Typography.Text>
                    <Select
                      style={{ width: 360 }}
                      placeholder="Sistema live o un altro rilascio"
                      value={compareWith}
                      onChange={setCompareWith}
                      options={compareOptions}
                      showSearch
                      optionFilterProp="label"
                    />
                    {compareWith && (
                      <Button icon={<DiffOutlined />} loading={compare.isFetching} onClick={() => compare.refetch()}>
                        Aggiorna
                      </Button>
                    )}
                  </Space>
                  {compareWith && (
                    <Typography.Text type="secondary">
                      Le differenze vanno da {otherLabel} a {t.name}: <Tag color="green">+ nel rilascio {t.name}</Tag>
                      <Tag color="red">- solo in {otherLabel}</Tag>
                      {compareWith === 'live' && 'Un "-" sul live indica una modifica fatta dopo il rilascio.'}
                    </Typography.Text>
                  )}
                  {compare.error && <Alert type="error" showIcon message={(compare.error as Error).message} />}
                  {compare.data && (
                    <Table<CompareRow>
                      rowKey="key"
                      size="small"
                      loading={compare.isFetching}
                      dataSource={compare.data.rows}
                      pagination={{ pageSize: 20, showSizeChanger: false }}
                      columns={[
                        {
                          title: 'Oggetto',
                          render: (_, r) => (r.tag ?? r.other)!.name,
                          ...sortBy<CompareRow>((r) => (r.tag ?? r.other)!.name),
                        },
                        {
                          title: 'Tipo',
                          render: (_, r) => objType((r.tag ?? r.other)!),
                          ...sortBy<CompareRow>((r) => objType((r.tag ?? r.other)!), 2),
                          ...filterBy<CompareRow>(compare.data.rows, (r) => objType((r.tag ?? r.other)!)),
                        },
                        {
                          title: 'Esito',
                          render: (_, r) => (
                            <Tooltip title={r.error}>
                              <Tag color={STATUS[r.status].color}>{STATUS[r.status].label}</Tag>
                            </Tooltip>
                          ),
                          ...filterBy<CompareRow>(compare.data.rows, (r) => STATUS[r.status].label),
                        },
                        {
                          title: 'Versione',
                          render: (_, r) => {
                            const a = r.tag?.version;
                            const b = compareWith === 'live' ? r.liveVersion : r.other?.version;
                            if (!a && !b) return '—';
                            return `${a ?? '—'} → ${b ?? '—'}`;
                          },
                        },
                        { title: 'Campi diversi', render: (_, r) => (r.diff?.length ? r.diff.slice(0, 4).join(', ') + (r.diff.length > 4 ? '…' : '') : '') },
                        {
                          title: '',
                          render: (_, r) =>
                            ['different', 'only_tag', 'only_other'].includes(r.status) ? (
                              <Button size="small" icon={<DiffOutlined />} onClick={() => setDiffRow(r)}>
                                Differenze
                              </Button>
                            ) : null,
                        },
                      ]}
                    />
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!diffRow}
        onCancel={() => setDiffRow(undefined)}
        footer={null}
        width={1000}
        title={diffRow ? `Differenze: ${(diffRow.tag ?? diffRow.other)!.name}` : ''}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Contenuto normalizzato (senza ID, date e versioni). <Tag color="green">+ nel rilascio {t.name}</Tag>
            <Tag color="red">- solo in {otherLabel}</Tag>
          </Typography.Text>
          {diff.isLoading && <Spin />}
          {diff.error && <Alert type="error" showIcon message={(diff.error as Error).message} />}
          {diff.data && <DiffView from={diff.data.other} to={diff.data.tag} />}
        </Space>
      </Modal>
    </Space>
  );
}
