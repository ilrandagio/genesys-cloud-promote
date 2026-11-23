import { DownloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Radio, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, appUrl, type Environment, type GcObject, type JobSummary, type ObjectType } from '../api/client';
import { JobStatusTag } from '../components/StatusTag';
import TypeObjectSelection, { type TypeSelection } from '../components/TypeObjectSelection';
import { useSessionState } from '../hooks/useSessionState';

/**
 * Backup di un ambiente: export in sola lettura della configurazione scelta (di default tutti i tipi),
 * archiviato cifrato e scaricabile. Nessuna simulazione né approvazione: non scrive sulle org.
 */
export default function BackupPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [envId, setEnvId] = useSessionState<string | undefined>('backup.envId', undefined);
  const [selection, setSelection] = useSessionState<TypeSelection>('backup.selection', {});
  /** Completo: tutto ciò che il provider esporta (backup esatto). Selezione: solo i tipi scelti */
  const [full, setFull] = useSessionState('backup.full', true);
  const [resolved, setResolved] = useState<{ objects: GcObject[]; loading: ObjectType[] }>({ objects: [], loading: [] });
  const [submitting, setSubmitting] = useState(false);

  const envs = useQuery({ queryKey: ['environments'], queryFn: () => api<Environment[]>('/api/environments') });
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<JobSummary[]>('/api/jobs'),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.mode === 'BACKUP' && ['QUEUED', 'RUNNING'].includes(j.status)) ? 3000 : false),
  });
  const backups = (jobs.data ?? []).filter((j) => j.mode === 'BACKUP');

  const chosen = Object.entries(selection) as [ObjectType, NonNullable<TypeSelection[ObjectType]>][];
  const start = async () => {
    setSubmitting(true);
    try {
      const job = await api<{ id: string }>('/api/backups', {
        method: 'POST',
        body: {
          envId,
          full,
          selection: full ? [] : chosen.map(([type, c]) =>
            c.mode === 'all'
              ? { type, all: true }
              : { type, all: false, objects: c.picked.map(({ id, name, subtype }) => ({ id, name, subtype })) },
          ),
        },
      });
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const pickedEmpty = chosen.filter(([, c]) => c.mode === 'pick' && !c.picked.length).length;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="Backup della configurazione"
        extra={
          <Tooltip
            title={
              !envId
                ? "Scegli l'ambiente"
                : full
                  ? undefined
                  : !chosen.length
                  ? 'Scegli almeno un tipo'
                  : resolved.loading.length
                    ? 'Attendi il caricamento degli elenchi'
                    : undefined
            }
          >
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={submitting}
              disabled={!envId || (!full && (!chosen.length || resolved.loading.length > 0 || chosen.length === pickedEmpty))}
              onClick={start}
            >
              Avvia il backup
            </Button>
          </Tooltip>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="Sola lettura: il backup non modifica l'ambiente"
            description="Esporta con Terraform la configurazione: risorse Terraform, file dei Flows, degli Scripts e audio dei Prompts, state con gli ID e un BACKUP.json che descrive il contenuto. L'archivio viene salvato cifrato sul server e si scarica dalla pagina del backup. Il backup completo comprende tutto ciò che il provider sa esportare, utenti, membri, telefonia e sicurezza compresi: su un'org grande può richiedere parecchi minuti."
          />
          <Radio.Group value={full} onChange={(e) => setFull(e.target.value)}>
            <Radio value={true}>Completo: tutto ciò che il provider esporta (backup esatto)</Radio>
            <Radio value={false}>Selezione: solo i tipi e gli oggetti scelti</Radio>
          </Radio.Group>
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">Ambiente</Typography.Text>
            <Select
              style={{ width: 320 }}
              placeholder="Ambiente da salvare"
              value={envId}
              onChange={(v) => setEnvId(v)}
              options={(envs.data ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.region})` }))}
            />
          </Space>
          {envId && !full && (
            <TypeObjectSelection envId={envId} value={selection} onChange={setSelection} onResolved={setResolved} />
          )}
        </Space>
      </Card>

      <Card title="Backup eseguiti">
        <Table
          size="small"
          rowKey="id"
          loading={jobs.isLoading}
          dataSource={backups}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: 'Data',
              dataIndex: 'createdAt',
              render: (v: string, j: JobSummary) => <Link to={`/jobs/${j.id}`}>{new Date(v).toLocaleString('it-IT')}</Link>,
            },
            { title: 'Ambiente', dataIndex: 'sourceName' },
            {
              title: 'Contenuto',
              render: (_: unknown, j: JobSummary) =>
                j.backup ? (
                  <Space size={4} wrap>
                    {j.backup.full ? <Tag color="blue">completo</Tag> : <Tag>{j.backup.selection.length} tipi</Tag>}
                    {j.backup.counts && <Tag>{Object.values(j.backup.counts).reduce((a, b) => a + b, 0)} oggetti</Tag>}
                  </Space>
                ) : null,
            },
            {
              title: 'Archivio',
              render: (_: unknown, j: JobSummary) =>
                j.backup?.deleted ? (
                  <Typography.Text type="secondary">cancellato</Typography.Text>
                ) : j.backup?.size ? (
                  `${(j.backup.size / 1024 / 1024).toFixed(1)} MB`
                ) : (
                  ''
                ),
            },
            { title: 'Utente', dataIndex: 'createdBy' },
            { title: 'Stato', render: (_: unknown, j: JobSummary) => <JobStatusTag status={j.status} /> },
            {
              title: '',
              render: (_: unknown, j: JobSummary) =>
                j.status === 'SUCCEEDED' && j.backup?.file && !j.backup.deleted ? (
                  <Button size="small" icon={<DownloadOutlined />} href={appUrl(`/api/jobs/${j.id}/backup`)}>
                    Scarica
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
