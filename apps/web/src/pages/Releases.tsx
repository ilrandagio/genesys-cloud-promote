import { PlusOutlined, TagOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Environment, type ReleaseTag } from '../api/client';
import { filterBy, sortBy } from '../components/StatusTag';
import { useSessionState } from '../hooks/useSessionState';

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString('it-IT') : '—');

/** Rilasci (tag) per ambiente: ogni tag raccoglie le esecuzioni di un pacchetto e la versione di ogni oggetto */
export default function ReleasesPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [envId, setEnvId] = useSessionState<string | undefined>('releases.envId', undefined);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ name: string; targetEnvId: string; description?: string }>();

  const envs = useQuery({ queryKey: ['environments'], queryFn: () => api<Environment[]>('/api/environments') });
  const tags = useQuery({
    queryKey: ['releases', envId ?? 'all'],
    queryFn: () => api<ReleaseTag[]>(`/api/releases${envId ? `?targetEnvId=${envId}` : ''}`),
  });

  const openCreate = async () => {
    form.resetFields();
    form.setFieldsValue({ targetEnvId: envId });
    if (envId) {
      const next = await api<{ name: string }>(`/api/releases/next-name?targetEnvId=${envId}`).catch(() => ({ name: '' }));
      form.setFieldsValue({ name: next.name });
    }
    setCreating(true);
  };

  const create = async (v: { name: string; targetEnvId: string; description?: string }) => {
    try {
      const tag = await api<ReleaseTag>('/api/releases', { method: 'POST', body: v });
      qc.invalidateQueries({ queryKey: ['releases'] });
      setCreating(false);
      navigate(`/releases/${tag.id}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card
      title={
        <Space>
          <TagOutlined /> Rilasci
        </Space>
      }
      extra={
        <Space>
          <Select
            allowClear
            placeholder="Tutti gli ambienti"
            style={{ width: 260 }}
            value={envId}
            onChange={setEnvId}
            options={(envs.data ?? []).filter((e) => e.allowAsTarget).map((e) => ({ value: e.id, label: `${e.name} (${e.region})` }))}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Nuovo rilascio
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Un rilascio (tag) appartiene a un ambiente target e raccoglie più esecuzioni dello stesso pacchetto, per esempio
        prima le Queues e poi gli Scripts. Per ogni oggetto vale l'ultima versione portata nel tag; un'esecuzione
        interrotta conta solo per gli oggetti scritti davvero, un ripristino toglie dal tag le versioni annullate. Il tag
        si sceglie nella simulazione; chiuso, non si usa più e il suo contenuto resta fisso.
      </Typography.Paragraph>
      <Table<ReleaseTag>
        rowKey="id"
        size="small"
        loading={tags.isLoading}
        dataSource={tags.data}
        onRow={(r) => ({ onClick: () => navigate(`/releases/${r.id}`), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Rilascio', dataIndex: 'name', ...sortBy<ReleaseTag>((r) => r.name), render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
          { title: 'Ambiente', dataIndex: 'targetName', ...sortBy<ReleaseTag>((r) => r.targetName, 2), ...filterBy<ReleaseTag>(tags.data, (r) => r.targetName) },
          {
            title: 'Stato',
            render: (_, r) => (r.closedAt ? <Tag>chiuso</Tag> : <Tag color="green">aperto</Tag>),
            ...filterBy<ReleaseTag>(tags.data, (r) => (r.closedAt ? 'chiuso' : 'aperto')),
          },
          { title: 'Esecuzioni', dataIndex: 'jobs', width: 110 },
          { title: 'Ultima attività', render: (_, r) => fmt(r.lastActivity ?? r.createdAt) },
          { title: 'Descrizione', dataIndex: 'description', ellipsis: true },
          { title: 'Creato da', dataIndex: 'createdBy' },
        ]}
      />
      <Modal
        open={creating}
        title="Nuovo rilascio"
        okText="Crea"
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="targetEnvId" label="Ambiente target" rules={[{ required: true }]}>
            <Select
              options={(envs.data ?? []).filter((e) => e.allowAsTarget).map((e) => ({ value: e.id, label: `${e.name} (${e.region})` }))}
              onChange={async (id: string) => {
                const next = await api<{ name: string }>(`/api/releases/next-name?targetEnvId=${id}`).catch(() => ({ name: '' }));
                form.setFieldsValue({ name: next.name });
              }}
            />
          </Form.Item>
          <Form.Item name="name" label="Nome" rules={[{ required: true }]} extra="Proposto incrementando l'ultimo rilascio dell'ambiente">
            <Input placeholder="R2026.12.1" />
          </Form.Item>
          <Form.Item name="description" label="Descrizione">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
