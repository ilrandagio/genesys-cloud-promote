import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd';
import { useState } from 'react';
import { api, type Environment } from '../api/client';

/** Il nome non si inserisce: lo restituisce il backend leggendolo dall'org Genesys */
type FormValues = Omit<Environment, 'id' | 'name'> & { clientSecret?: string };

export default function EnvironmentsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Environment | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();

  const envs = useQuery({ queryKey: ['environments'], queryFn: () => api<Environment[]>('/api/environments') });
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => api<string[]>('/api/regions') });

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      editing === 'new'
        ? api('/api/environments', { method: 'POST', body: v })
        : api(`/api/environments/${(editing as Environment).id}`, { method: 'PUT', body: v }),
    onSuccess: (env) => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['environments'] });
      message.success(`Ambiente "${(env as Environment).name}" salvato`);
    },
    onError: (e) => message.error(e.message),
  });

  const test = async (env: Environment) => {
    try {
      const r = await api<{ organization: string }>(`/api/environments/${env.id}/test`, { method: 'POST' });
      message.success(`Connessione OK: org "${r.organization}"`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (env: Environment) => {
    try {
      await api(`/api/environments/${env.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['environments'] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const open = (env: Environment | 'new') => {
    setEditing(env);
    form.resetFields();
    if (env !== 'new') form.setFieldsValue(env);
    else form.setFieldsValue({ allowAsTarget: true });
  };

  return (
    <Card
      title="Ambienti Genesys Cloud"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>
          Nuovo ambiente
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={envs.isLoading}
        dataSource={envs.data}
        pagination={false}
        columns={[
          { title: 'Nome', dataIndex: 'name' },
          { title: 'Regione', dataIndex: 'region' },
          { title: 'OAuth client ID', dataIndex: 'clientId', render: (v: string) => <code>{v}</code> },
          {
            title: 'Uso',
            dataIndex: 'allowAsTarget',
            render: (v: boolean) => (v ? <Tag color="green">sorgente e target</Tag> : <Tag>solo sorgente</Tag>),
          },
          {
            title: '',
            render: (_, env) => (
              <Space>
                <Button size="small" onClick={() => test(env)}>
                  Prova connessione
                </Button>
                <Button size="small" onClick={() => open(env)}>
                  Modifica
                </Button>
                <Popconfirm title="Eliminare l'ambiente?" onConfirm={() => remove(env)}>
                  <Button size="small" danger>
                    Elimina
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={editing !== null}
        title={editing === 'new' || editing === null ? 'Nuovo ambiente' : `Modifica ambiente "${editing.name}"`}
        okText="Verifica e salva"
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Il nome dell'ambiente è lo short name dell'org Genesys Cloud"
          description="Al salvataggio le credenziali vengono verificate e lo short name (unico) viene letto dall'organizzazione."
        />
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="region" label="Regione" rules={[{ required: true }]}>
            <Select options={(regions.data ?? []).map((r) => ({ value: r, label: r }))} showSearch />
          </Form.Item>
          <Form.Item name="clientId" label="OAuth client ID (Client Credentials)" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="clientSecret"
            label="Client secret"
            rules={[{ required: editing === 'new' }]}
            extra={editing !== 'new' ? 'Lascia vuoto per non modificarlo' : 'Viene salvato cifrato e non è più visualizzabile'}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="allowAsTarget" label="Utilizzabile come target" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
