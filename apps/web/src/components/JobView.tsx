import { PlayCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Descriptions, Space, Table, Tabs, Tag } from 'antd';
import { useState } from 'react';
import { api, type JobDetail, type PortItem } from '../api/client';
import { JobStatusTag, TargetStatusTag, typeLabel } from './StatusTag';

const ACTION_LABEL = { port: 'Porta', reuse: 'Usa target', skip: 'Salta' } as const;

/**
 * Dettaglio di un job (plan o porting) con aggiornamento dal vivo.
 * Per una simulazione completata offre "Esegui questo porting", che crea il porting lato server
 * copiando esattamente oggetti e azioni del plan.
 */
export default function JobView({
  id,
  onApplied,
  compact = false,
}: {
  id: string;
  onApplied?: (applyJobId: string) => void;
  /** Layout per il pannello laterale */
  compact?: boolean;
}) {
  const { modal, message } = App.useApp();
  const [applying, setApplying] = useState(false);
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/api/jobs/${id}`),
    // Aggiornamento continuo finché il job è in corso
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 2000 : false),
  });

  if (!job.data) return <Card loading={job.isLoading}>{job.isError && (job.error as Error).message}</Card>;
  const j = job.data;
  const toPort = j.items.filter((i) => i.action === 'port');
  const overwrite = toPort.filter((i) => i.targetId).length;

  const apply = () =>
    modal.confirm({
      title: `Eseguire questo porting su ${j.targetName}?`,
      content: (
        <>
          Verranno scritti gli stessi <b>{toPort.length}</b> oggetti della simulazione
          {overwrite > 0 && (
            <>
              , di cui <b>{overwrite}</b> già esistenti che verranno <b>sovrascritti</b>
            </>
          )}
          . La simulazione è del {new Date(j.createdAt).toLocaleString('it-IT')}: se nel frattempo il target è cambiato,
          conviene rifarla.
        </>
      ),
      okText: 'Esegui porting',
      okButtonProps: { danger: true },
      onOk: async () => {
        setApplying(true);
        try {
          const res = await api<{ id: string }>(`/api/jobs/${j.id}/apply`, { method: 'POST' });
          onApplied?.(res.id);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setApplying(false);
        }
      },
    });

  const pre = (text: string) => (
    <pre
      style={{
        background: '#111',
        color: '#ddd',
        padding: 16,
        maxHeight: compact ? 'calc(100vh - 360px)' : 600,
        overflow: 'auto',
        fontSize: 12,
        margin: 0,
      }}
    >
      {text || '—'}
    </pre>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        size={compact ? 'small' : 'default'}
        title={j.mode === 'PLAN' ? 'Simulazione (plan)' : 'Porting'}
        extra={
          j.mode === 'PLAN' &&
          j.status === 'SUCCEEDED' &&
          onApplied && (
            <Button type="primary" danger icon={<PlayCircleOutlined />} loading={applying} onClick={apply}>
              Esegui questo porting
            </Button>
          )
        }
      >
        <Descriptions column={compact ? 2 : 3} size="small">
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
        {j.mode === 'PLAN' && j.status === 'FAILED' && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message="La simulazione non è riuscita: vedi il log. Il porting non può essere eseguito da questa simulazione."
          />
        )}
      </Card>
      <Card size={compact ? 'small' : 'default'}>
        <Tabs
          defaultActiveKey={j.planOutput ? 'plan' : 'log'}
          items={[
            ...(j.planOutput ? [{ key: 'plan', label: 'Output plan', children: pre(j.planOutput) }] : []),
            { key: 'log', label: 'Log', children: pre(j.log) },
            {
              key: 'items',
              label: `Oggetti (${j.items.length})`,
              children: (
                <Table<PortItem>
                  size="small"
                  rowKey={(i) => `${i.type}:${i.id}`}
                  dataSource={j.items}
                  pagination={false}
                  columns={[
                    { title: 'Oggetto', dataIndex: 'name' },
                    { title: 'Tipo', render: (_, i) => typeLabel(i) },
                    { title: "Stato target (all'analisi)", dataIndex: 'targetStatus', render: (s) => <TargetStatusTag status={s} /> },
                    {
                      title: 'Azione',
                      dataIndex: 'action',
                      render: (a: PortItem['action']) => <Tag color={a === 'port' ? 'red' : undefined}>{ACTION_LABEL[a]}</Tag>,
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
