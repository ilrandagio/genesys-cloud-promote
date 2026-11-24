import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, AutoComplete, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import { api, type BotConnectorInfo, type BotMapping, type Environment } from '../api/client';

/**
 * Regole Bot Connector di un ambiente target: nei Flows portati verso questo ambiente, il bot del sorgente
 * (con versione, o tutte) diventa quello indicato. Bot e versioni del target sono proposti leggendo l'org.
 */
export default function BotMappingsModal({ env, onClose }: { env: Environment | null; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ rules: BotMapping[] }>();

  const connectors = useQuery({
    queryKey: ['bot-connectors', env?.id],
    enabled: !!env,
    queryFn: () => api<BotConnectorInfo[]>(`/api/environments/${env!.id}/bot-connectors`),
  });

  useEffect(() => {
    if (env) form.setFieldsValue({ rules: env.botMappings ?? [] });
  }, [env, form]);

  const save = useMutation({
    mutationFn: (rules: BotMapping[]) => api(`/api/environments/${env!.id}/bot-mappings`, { method: 'PUT', body: rules }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['environments'] });
      message.success('Regole Bot Connector salvate');
      onClose();
    },
    onError: (e) => message.error(e.message),
  });

  const integrations = useMemo(() => (connectors.data ?? []).map((c) => ({ value: c.integration })), [connectors.data]);
  const bots = useMemo(
    () => [...new Set((connectors.data ?? []).flatMap((c) => c.bots.map((b) => b.name)))].map((value) => ({ value })),
    [connectors.data],
  );
  const versionsOf = (bot?: string) =>
    [
      ...new Set(
        (connectors.data ?? []).flatMap((c) =>
          c.bots.filter((b) => !bot || b.name.toLowerCase() === bot.toLowerCase()).flatMap((b) => b.versions),
        ),
      ),
    ].map((value) => ({ value }));

  return (
    <Modal
      open={!!env}
      width={1000}
      title={env ? `Bot Connector: regole per i Flows portati su "${env.name}"` : ''}
      okText="Salva"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Le azioni <i>Call Bot Connector</i> dei Flows citano integration, bot e versione per nome. Quando questo ambiente è
        il target, ogni bot del sorgente che corrisponde a una regola viene sostituito prima della simulazione. Versione
        sorgente vuota = tutte; campi target vuoti = invariati. In simulazione bot e versione vengono comunque verificati
        su questo ambiente.
      </Typography.Paragraph>
      {connectors.isError && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`Bot di questo ambiente non leggibili: ${connectors.error.message}`} />
      )}
      {connectors.data?.some((c) => c.error) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={connectors.data.filter((c) => c.error).map((c) => `${c.integration}: ${c.error}`).join(' · ')}
        />
      )}
      <Form form={form} onFinish={(v) => save.mutate(v.rules ?? [])}>
        <Form.List name="rules">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name }) => (
                <Space key={key} align="start" wrap style={{ display: 'flex', marginBottom: 4 }}>
                  <Form.Item name={[name, 'integration']} style={{ marginBottom: 0 }}>
                    <Input placeholder="Integration sorgente (tutte)" style={{ width: 190 }} />
                  </Form.Item>
                  <Form.Item name={[name, 'sourceBot']} rules={[{ required: true, message: 'Obbligatorio' }]} style={{ marginBottom: 0 }}>
                    <Input placeholder="Bot sorgente" style={{ width: 160 }} />
                  </Form.Item>
                  <Form.Item name={[name, 'sourceVersion']} style={{ marginBottom: 0 }}>
                    <Input placeholder="Versione (tutte)" style={{ width: 110 }} />
                  </Form.Item>
                  <span style={{ lineHeight: '32px' }}>→</span>
                  <Form.Item name={[name, 'targetIntegration']} style={{ marginBottom: 0 }}>
                    <AutoComplete options={integrations} placeholder="Integration target" style={{ width: 170 }} />
                  </Form.Item>
                  <Form.Item name={[name, 'targetBot']} style={{ marginBottom: 0 }}>
                    <AutoComplete options={bots} placeholder="Bot target" style={{ width: 160 }} filterOption />
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate>
                    {() => (
                      <Form.Item name={[name, 'targetVersion']} style={{ marginBottom: 0 }}>
                        <AutoComplete
                          options={versionsOf(form.getFieldValue(['rules', name, 'targetBot']) || form.getFieldValue(['rules', name, 'sourceBot']))}
                          placeholder="Versione target"
                          style={{ width: 120 }}
                        />
                      </Form.Item>
                    )}
                  </Form.Item>
                  <Button icon={<DeleteOutlined />} onClick={() => remove(name)} />
                </Space>
              ))}
              <Button icon={<PlusOutlined />} onClick={() => add({ sourceBot: '' })}>
                Aggiungi regola
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
