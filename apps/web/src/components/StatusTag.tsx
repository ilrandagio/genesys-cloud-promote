import { Tag, Tooltip } from 'antd';
import type { JobStatus, TargetStatus } from '../api/client';

const TARGET: Record<TargetStatus, { color: string; label: string; help: string }> = {
  missing: { color: 'red', label: 'Mancante', help: 'Non esiste sul target (match per nome)' },
  same: { color: 'green', label: 'Presente, uguale', help: 'Esiste sul target con la stessa configurazione' },
  different: { color: 'orange', label: 'Presente, diverso', help: 'Esiste sul target ma la configurazione differisce' },
  present: { color: 'blue', label: 'Presente', help: 'Esiste sul target; il contenuto non viene confrontato' },
};

export function TargetStatusTag({ status, diff }: { status?: TargetStatus; diff?: string[] }) {
  if (!status) return <Tag>n/d</Tag>;
  const s = TARGET[status];
  const help = diff?.length ? `${s.help}. Campi diversi: ${diff.join(', ')}` : s.help;
  return (
    <Tooltip title={help}>
      <Tag color={s.color}>{s.label}</Tag>
    </Tooltip>
  );
}

const JOB: Record<JobStatus, { color: string; label: string }> = {
  QUEUED: { color: 'default', label: 'In coda' },
  RUNNING: { color: 'processing', label: 'In esecuzione' },
  SUCCEEDED: { color: 'success', label: 'Completato' },
  FAILED: { color: 'error', label: 'Fallito' },
};

export function JobStatusTag({ status }: { status: JobStatus }) {
  return <Tag color={JOB[status].color}>{JOB[status].label}</Tag>;
}

export const TYPE_LABELS: Record<string, string> = {
  flow: 'Flow',
  queue: 'Coda',
  skill: 'Skill',
  wrapupcode: 'Wrap-up code',
  language: 'Language',
  dataaction: 'Data action',
  integration: 'Integrazione',
  schedule: 'Schedule',
  schedulegroup: 'Schedule group',
  prompt: 'Prompt',
  division: 'Divisione',
  script: 'Script agente',
};
