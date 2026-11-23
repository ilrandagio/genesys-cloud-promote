import { useQuery } from '@tanstack/react-query';
import { Alert, Modal, Space, Spin, Switch, Tag, Typography, theme } from 'antd';
import { diffLines } from 'diff';
import { useMemo, useState } from 'react';
import { api, type ObjectType } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  name: string;
  type: ObjectType;
  sourceEnvId: string;
  targetEnvId: string;
  sourceId: string;
  targetId: string;
}

interface Compare {
  source: unknown;
  target: unknown;
  diff: string[];
}

type Line = { kind: 'same' | 'del' | 'add'; text: string } | { kind: 'gap'; count: number };

/** Righe uguali mostrate prima e dopo ogni differenza; le altre vengono raggruppate */
const CONTEXT = 3;

function buildLines(a: string, b: string, all: boolean): Line[] {
  const lines: Line[] = [];
  for (const part of diffLines(a, b)) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'same';
    for (const text of part.value.replace(/\n$/, '').split('\n')) lines.push({ kind, text });
  }
  if (all) return lines;
  // Solo le righe vicine a una differenza
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: Line[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'gap', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'gap', count: skipped });
  return out;
}

const SIGN: Record<'same' | 'del' | 'add', string> = { same: ' ', del: '-', add: '+' };

/** Differenze tra l'oggetto sul sorgente e sul target, come le vede l'analisi */
export default function DiffModal({ open, onClose, name, type, sourceEnvId, targetEnvId, sourceId, targetId }: Props) {
  const [all, setAll] = useState(false);
  const { token } = theme.useToken();
  // Colori dal tema: leggibili sia in chiaro sia in scuro
  const STYLE: Record<'same' | 'del' | 'add', { bg?: string; color?: string }> = {
    same: {},
    del: { bg: token.colorErrorBg, color: token.colorErrorText },
    add: { bg: token.colorSuccessBg, color: token.colorSuccessText },
  };
  const q = useQuery({
    queryKey: ['compare', sourceEnvId, targetEnvId, type, sourceId, targetId],
    queryFn: () =>
      api<Compare>(
        `/api/compare?${new URLSearchParams({ sourceEnvId, targetEnvId, type, sourceId, targetId })}`,
      ),
    enabled: open,
  });
  const lines = useMemo(
    () =>
      q.data
        ? buildLines(JSON.stringify(q.data.source, null, 2), JSON.stringify(q.data.target, null, 2), all)
        : [],
    [q.data, all],
  );

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={1000} title={`Differenze: ${name}`} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Contenuto confrontato dall'analisi: senza i campi che cambiano sempre tra org (id, date, versione, division),
          con gli ID sostituiti da "&lt;id&gt;" e le chiavi in ordine alfabetico. <Tag color="red">- sorgente</Tag>
          <Tag color="green">+ target</Tag>
        </Typography.Text>
        {q.isLoading && <Spin />}
        {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
        {q.data && (
          <>
            {q.data.diff.length ? (
              <Alert
                type="warning"
                showIcon
                message={`Campi diversi (${q.data.diff.length})`}
                description={q.data.diff.join(', ')}
              />
            ) : (
              <Alert type="success" showIcon message="Nessuna differenza: l'oggetto è uguale sul target" />
            )}
            <Space>
              <Switch size="small" checked={all} onChange={setAll} /> Mostra tutto il contenuto
            </Space>
            <pre
              style={{
                margin: 0,
                maxHeight: '60vh',
                overflow: 'auto',
                fontSize: 12,
                lineHeight: 1.5,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 6,
              }}
            >
              {lines.map((l, i) =>
                l.kind === 'gap' ? (
                  <div key={i} style={{ background: token.colorFillQuaternary, color: token.colorTextTertiary, padding: '0 8px' }}>
                    ⋯ {l.count} righe uguali
                  </div>
                ) : (
                  <div key={i} style={{ background: STYLE[l.kind].bg, color: STYLE[l.kind].color, padding: '0 8px' }}>
                    {SIGN[l.kind]} {l.text}
                  </div>
                ),
              )}
            </pre>
          </>
        )}
      </Space>
    </Modal>
  );
}
