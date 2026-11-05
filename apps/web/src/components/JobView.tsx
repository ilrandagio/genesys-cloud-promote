import { CheckOutlined, DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Descriptions, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type JobDetail, type PortItem } from '../api/client';
import { JobStatusTag, PlanStateTag, TargetStatusTag, typeLabel } from './StatusTag';

const ACTION_LABEL = { port: 'Porta', reuse: 'Usa target', skip: 'Salta' } as const;

const CHANGE_LABEL: Record<string, { color: string; label: string }> = {
  create: { color: 'green', label: 'crea' },
  update: { color: 'blue', label: 'aggiorna' },
  delete: { color: 'red', label: 'cancella' },
};
const describeActions = (actions: string[]) =>
  actions.includes('delete') && actions.includes('create')
    ? [{ color: 'red', label: 'ricrea' }]
    : actions.filter((a) => CHANGE_LABEL[a]).map((a) => CHANGE_LABEL[a]);

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString('it-IT') : '—');

/**
 * Dettaglio di un job con aggiornamento dal vivo.
 * Per una simulazione mostra cosa cambierà sul target e le azioni consentite all'utente
 * (approva, esegui, scarta), come calcolate dal server.
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
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => api<JobDetail>(`/api/jobs/${id}`),
    // Aggiornamento continuo finché il job è in corso
    refetchInterval: (q) => (q.state.data && ['QUEUED', 'RUNNING'].includes(q.state.data.status) ? 2000 : false),
  });

  if (!job.data) return <Card loading={job.isLoading}>{job.isError && (job.error as Error).message}</Card>;
  const j = job.data;
  const p = j.plan;
  const summary = j.planSummary;

  const call = async (path: string, done: (res: any) => void) => {
    setBusy(true);
    try {
      done(await api(path, { method: 'POST' }));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['job', id] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  };

  const approve = () =>
    modal.confirm({
      title: `Approvare il plan verso ${j.targetName}?`,
      content: `Plan creato da ${j.createdBy}. Con l'approvazione il plan potrà essere eseguito così com'è.`,
      okText: 'Approva',
      onOk: () => call(`/api/jobs/${j.id}/approve`, () => message.success('Plan approvato')),
    });

  const apply = () =>
    modal.confirm({
      title: `Eseguire il plan su ${j.targetName}?`,
      width: 520,
      content: (
        <Space direction="vertical">
          <span>
            Verrà applicato esattamente il piano simulato il {fmt(j.createdAt)}:{' '}
            <b>{summary?.add ?? 0}</b> da creare, <b>{summary?.change ?? 0}</b> da aggiornare.
          </span>
          <span>
            Prima di scrivere viene verificato che {j.targetName} non sia cambiato dopo la simulazione: in quel caso non viene
            applicato nulla. Il plan si può eseguire una sola volta.
          </span>
        </Space>
      ),
      okText: 'Esegui il plan',
      okButtonProps: { danger: true },
      onOk: () => call(`/api/jobs/${j.id}/apply`, (res) => onApplied?.(res.id)),
    });

  const discard = () =>
    modal.confirm({
      title: 'Scartare il plan?',
      content: 'Il plan non potrà più essere eseguito.',
      okText: 'Scarta',
      onOk: () => call(`/api/jobs/${j.id}/discard`, () => message.success('Plan scartato')),
    });

  const pre = (text?: string | null) => (
    <pre
      style={{
        background: '#111',
        color: '#ddd',
        padding: 16,
        maxHeight: compact ? 'calc(100vh - 420px)' : 600,
        overflow: 'auto',
        fontSize: 12,
        margin: 0,
      }}
    >
      {text || '—'}
    </pre>
  );

  const planActions = p && (
    <Space wrap>
      {p.canApprove && (
        <Button icon={<CheckOutlined />} loading={busy} onClick={approve}>
          Approva
        </Button>
      )}
      {onApplied && (
        <Tooltip title={!p.canApply ? p.reasons.join(' · ') : undefined}>
          <Button type="primary" danger icon={<PlayCircleOutlined />} loading={busy} disabled={!p.canApply} onClick={apply}>
            Esegui il plan
          </Button>
        </Tooltip>
      )}
      {['ready', 'awaiting_approval'].includes(p.state) && (
        <Button icon={<DeleteOutlined />} loading={busy} onClick={discard}>
          Scarta
        </Button>
      )}
    </Space>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        size={compact ? 'small' : 'default'}
        title={
          <Space>
            {j.mode === 'PLAN' ? 'Simulazione (plan)' : 'Esecuzione'}
            {p ? <PlanStateTag state={p.state} /> : <JobStatusTag status={j.status} />}
          </Space>
        }
        extra={planActions}
      >
        <Descriptions column={compact ? 2 : 3} size="small">
          <Descriptions.Item label="Da → A">
            {j.sourceName} → {j.targetName}
            {j.targetRequireApproval && (
              <Tag color="purple" style={{ marginLeft: 8 }}>
                protetto
              </Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={j.mode === 'PLAN' ? 'Creato da' : 'Eseguito da'}>{j.createdBy}</Descriptions.Item>
          <Descriptions.Item label="Avviato">{fmt(j.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="Terminato">{fmt(j.finishedAt)}</Descriptions.Item>
          {j.mode === 'PLAN' && (
            <>
              <Descriptions.Item label="Valido fino al">{fmt(j.expiresAt)}</Descriptions.Item>
              <Descriptions.Item label="Approvato da">
                {j.approvedBy ? `${j.approvedBy} (${fmt(j.approvedAt)})` : '—'}
              </Descriptions.Item>
              {j.appliedJobId && (
                <Descriptions.Item label="Esecuzione">
                  <Link to={`/jobs/${j.appliedJobId}`}>vedi esecuzione</Link>
                </Descriptions.Item>
              )}
            </>
          )}
          {j.mode === 'APPLY' && (
            <>
              <Descriptions.Item label="Stato">
                <JobStatusTag status={j.status} />
              </Descriptions.Item>
              {j.planJobId && (
                <Descriptions.Item label="Plan">
                  <Link to={`/jobs/${j.planJobId}`}>vedi simulazione</Link>
                </Descriptions.Item>
              )}
            </>
          )}
        </Descriptions>

        {j.blockedReason && <Alert style={{ marginTop: 12 }} type="error" showIcon message={j.blockedReason} />}
        {p?.state === 'failed' && (
          <Alert style={{ marginTop: 12 }} type="error" showIcon message="La simulazione non è riuscita: vedi il log." />
        )}
        {p && p.reasons.length > 0 && ['ready', 'awaiting_approval'].includes(p.state) && (
          <Alert style={{ marginTop: 12 }} type="info" showIcon message={p.reasons.join(' · ')} />
        )}
        {j.mode === 'APPLY' && j.status === 'FAILED' && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message={
              j.appliedResources?.length
                ? `Esecuzione interrotta: ${j.appliedResources.length} modifiche erano già state applicate (vedi log). Rifare la simulazione per completare.`
                : 'Esecuzione non riuscita: nessuna modifica applicata (vedi log).'
            }
          />
        )}
      </Card>

      {summary && (
        <Card size={compact ? 'small' : 'default'} title="Modifiche sul target">
          <Space wrap style={{ marginBottom: 12 }}>
            <Tag color="green">{summary.add} da creare</Tag>
            <Tag color="blue">{summary.change} da aggiornare</Tag>
            {summary.destroy > 0 && <Tag color="red">{summary.destroy} da cancellare</Tag>}
            {summary.replace > 0 && <Tag color="red">{summary.replace} da ricreare</Tag>}
          </Space>
          <Table
            size="small"
            rowKey="address"
            pagination={false}
            dataSource={summary.changes}
            columns={[
              { title: 'Risorsa', dataIndex: 'address', render: (a: string) => <Typography.Text code>{a}</Typography.Text> },
              {
                title: 'Modifica',
                dataIndex: 'actions',
                width: 140,
                render: (a: string[]) => describeActions(a).map((x) => <Tag key={x.label} color={x.color}>{x.label}</Tag>),
              },
              ...(j.appliedResources
                ? [
                    {
                      title: 'Applicata',
                      width: 100,
                      render: (_: unknown, r: { address: string }) =>
                        j.appliedResources?.includes(r.address) ? <Tag color="green">sì</Tag> : <Tag>no</Tag>,
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}

      <Card size={compact ? 'small' : 'default'}>
        <Tabs
          defaultActiveKey="log"
          items={[
            { key: 'log', label: 'Log', children: pre(j.log) },
            ...(j.planOutput ? [{ key: 'plan', label: 'Output plan', children: pre(j.planOutput) }] : []),
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
