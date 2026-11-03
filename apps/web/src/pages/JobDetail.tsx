import { useQuery } from '@tanstack/react-query';
import { Card, Descriptions, Space, Table, Tabs, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import { api, type JobDetail, type PortItem } from '../api/client';
import { JobStatusTag, TargetStatusTag, TYPE_LABELS } from '../components/StatusTag';

const ACTION_LABEL = { port: 'Porta', reuse: 'Usa target', skip: 'Salta' } as const;

export default function JobDetailPage() {
  const { id } = useParams();
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/api/jobs/${id}`),
    // Aggiornamento continuo finché il job è in corso
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 2000 : false),
  });

  if (!job.data) return <Card loading={job.isLoading}>{job.isError && (job.error as Error).message}</Card>;
  const j = job.data;

  const pre = (text: string) => (
    <pre style={{ background: '#111', color: '#ddd', padding: 16, maxHeight: 600, overflow: 'auto', fontSize: 12 }}>
      {text || '—'}
    </pre>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={j.mode === 'PLAN' ? 'Simulazione (plan)' : 'Porting'}>
        <Descriptions column={3}>
          <Descriptions.Item label="Stato">
            <JobStatusTag status={j.status} />
          </Descriptions.Item>
          <Descriptions.Item label="Da → A">
            {j.sourceName} → {j.targetName}
          </Descriptions.Item>
          <Descriptions.Item label="Utente">{j.createdBy}</Descriptions.Item>
          <Descriptions.Item label="Avviato">{new Date(j.createdAt).toLocaleString('it-IT')}</Descriptions.Item>
          <Descriptions.Item label="Terminato">{j.finishedAt ? new Date(j.finishedAt).toLocaleString('it-IT') : '—'}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card>
        <Tabs
          items={[
            {
              key: 'items',
              label: 'Oggetti',
              children: (
                <Table<PortItem>
                  size="small"
                  rowKey={(i) => `${i.type}:${i.id}`}
                  dataSource={j.items}
                  pagination={false}
                  columns={[
                    { title: 'Oggetto', dataIndex: 'name' },
                    { title: 'Tipo', dataIndex: 'type', render: (t) => TYPE_LABELS[t] },
                    { title: 'Stato target (all\'analisi)', dataIndex: 'targetStatus', render: (s) => <TargetStatusTag status={s} /> },
                    {
                      title: 'Azione',
                      dataIndex: 'action',
                      render: (a: PortItem['action']) => <Tag color={a === 'port' ? 'red' : undefined}>{ACTION_LABEL[a]}</Tag>,
                    },
                  ]}
                />
              ),
            },
            ...(j.planOutput ? [{ key: 'plan', label: 'Output plan', children: pre(j.planOutput) }] : []),
            { key: 'log', label: 'Log', children: pre(j.log) },
          ]}
        />
      </Card>
    </Space>
  );
}
