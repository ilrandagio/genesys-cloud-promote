import { PlusOutlined, TagOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Input, Popover, Select, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, type ReleaseTag } from '../api/client';

interface Props {
  targetEnvId?: string;
  value?: string;
  onChange: (tagId: string | undefined) => void;
  /** Promozione da un altro ambiente: nome proposto e tag di origine */
  suggestedName?: string;
  promotedFromTagId?: string;
}

/**
 * Rilascio (tag) della simulazione: un tag aperto dell'ambiente target, oppure uno nuovo (nome proposto
 * incrementando l'ultimo). Facoltativo: senza tag la simulazione non appartiene a nessun rilascio.
 */
export default function ReleaseTagPicker({ targetEnvId, value, onChange, suggestedName, promotedFromTagId }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const tags = useQuery({
    queryKey: ['releases', targetEnvId],
    queryFn: () => api<ReleaseTag[]>(`/api/releases?targetEnvId=${targetEnvId}`),
    enabled: !!targetEnvId,
  });
  const open = (tags.data ?? []).filter((t) => !t.closedAt);

  // Il tag scelto deve essere ancora aperto e dell'ambiente target
  useEffect(() => {
    if (value && tags.data && !open.some((t) => t.id === value)) onChange(undefined);
  }, [value, tags.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const startCreate = async () => {
    setDescription('');
    if (suggestedName) setName(suggestedName);
    else {
      const next = await api<{ name: string }>(`/api/releases/next-name?targetEnvId=${targetEnvId}`).catch(() => ({ name: '' }));
      setName(next.name);
    }
    setCreating(true);
  };

  const create = async () => {
    setSaving(true);
    try {
      const tag = await api<ReleaseTag>('/api/releases', {
        method: 'POST',
        body: { name, targetEnvId, description: description || undefined, promotedFromTagId },
      });
      await qc.invalidateQueries({ queryKey: ['releases'] });
      onChange(tag.id);
      setCreating(false);
      message.success(`Rilascio "${tag.name}" creato`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space size={4}>
      <Tooltip title="Rilascio (tag) a cui appartiene la simulazione: dopo l'esecuzione la versione di ogni oggetto portato viene salvata nel tag">
        <Select
          allowClear
          style={{ width: 220 }}
          placeholder={
            <span>
              <TagOutlined /> Rilascio (facoltativo)
            </span>
          }
          disabled={!targetEnvId}
          loading={tags.isLoading}
          value={value}
          onChange={(v) => onChange(v)}
          options={open.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Tooltip>
      <Popover
        open={creating}
        onOpenChange={(v) => !v && setCreating(false)}
        trigger="click"
        title="Nuovo rilascio"
        content={
          <Space direction="vertical" style={{ width: 300 }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome, es. R2026.12.1" onPressEnter={create} />
            <Input.TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descrizione (facoltativa)"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
            {promotedFromTagId && <Typography.Text type="secondary">Promosso da un rilascio di un altro ambiente</Typography.Text>}
            <Button type="primary" block loading={saving} disabled={!name.trim()} onClick={create}>
              Crea
            </Button>
          </Space>
        }
      >
        <Tooltip title="Nuovo rilascio su questo ambiente">
          <Button icon={<PlusOutlined />} disabled={!targetEnvId} onClick={startCreate} />
        </Tooltip>
      </Popover>
    </Space>
  );
}
