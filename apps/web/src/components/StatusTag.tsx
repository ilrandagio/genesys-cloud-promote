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
  queue: 'Queue',
  skill: 'ACD Skill',
  wrapupcode: 'Wrap-up Code',
  language: 'Language',
  dataaction: 'Data Action',
  integration: 'Integration',
  schedule: 'Schedule',
  schedulegroup: 'Schedule Group',
  prompt: 'User Prompt',
  division: 'Division',
  group: 'Group',
  role: 'Role',
  script: 'Script',
  datatable: 'Data Table',
  emergencygroup: 'Emergency Group',
  campaign: 'Campaign',
  messagingcampaign: 'Messaging Campaign',
  sequence: 'Campaign Sequence',
  contactlist: 'Contact List',
  contactlistfilter: 'Contact List Filter',
  dnclist: 'DNC List',
  callanalysisresponseset: 'Call Analysis Response Set',
  ruleset: 'Rule Set',
  digitalruleset: 'Digital Rule Set',
  campaignrule: 'Campaign Rule',
  attemptlimit: 'Attempt Limit',
  callabletimeset: 'Callable Time Set',
  filespectemplate: 'File Specification Template',
  webconfig: 'Messenger Configuration',
  webdeployment: 'Messenger Deployment',
  supportedcontent: 'Supported Content',
  responselibrary: 'Canned Response Library',
  response: 'Canned Response',
  responseasset: 'Canned Response Asset',
  wrapupmapping: 'Wrap-up Code Mappings',
};

/** Tipi di flow Architect (campo "type" di /api/v2/flows) */
const FLOW_TYPE_LABELS: Record<string, string> = {
  INBOUNDCALL: 'Inbound Call',
  INBOUNDCHAT: 'Inbound Chat',
  INBOUNDEMAIL: 'Inbound Email',
  INBOUNDSHORTMESSAGE: 'Inbound Message',
  INQUEUECALL: 'In-Queue Call',
  INQUEUEEMAIL: 'In-Queue Email',
  INQUEUESHORTMESSAGE: 'In-Queue Message',
  OUTBOUNDCALL: 'Outbound Call',
  SECURECALL: 'Secure Call',
  COMMONMODULE: 'Common Module',
  WORKFLOW: 'Workflow',
  WORKITEM: 'Workitem',
  BOT: 'Bot',
  DIGITALBOT: 'Digital Bot',
  VOICE: 'Voice',
  VOICEMAIL: 'Voicemail',
  VOICESURVEY: 'Voice Survey',
  SURVEYINVITE: 'Survey Invite',
  SPEECH: 'Speech',
};

/** Tipo di flow leggibile, es. COMMONMODULE -> "Common Module" */
export function flowTypeLabel(subtype?: string): string {
  if (!subtype) return '';
  const sub = subtype.toUpperCase();
  return FLOW_TYPE_LABELS[sub] ?? sub;
}

/** Etichetta del tipo di oggetto; per i flow aggiunge il tipo di flow, es. "Flow (Common Module)" */
export function typeLabel(o: { type: string; subtype?: string }): string {
  const base = TYPE_LABELS[o.type] ?? o.type;
  if (o.type !== 'flow' || !o.subtype) return base;
  return `${base} (${flowTypeLabel(o.subtype)})`;
}

const PLAN_STATE: Record<string, { color: string; label: string; help: string }> = {
  running: { color: 'processing', label: 'In corso', help: 'La simulazione è in esecuzione' },
  failed: { color: 'error', label: 'Fallita', help: 'La simulazione non è riuscita' },
  blocked: { color: 'error', label: 'Non eseguibile', help: 'Il piano contiene modifiche non ammesse o nessuna modifica' },
  applied: { color: 'default', label: 'Già usato', help: 'Il plan è stato usato per un’esecuzione (si esegue una sola volta): l’esito è nell’esecuzione collegata' },
  expired: { color: 'default', label: 'Scaduto', help: 'Il plan è scaduto o è stato scartato: rifare la simulazione' },
  awaiting_approval: { color: 'purple', label: 'Da approvare', help: 'Il target è protetto: serve l’approvazione di una seconda persona' },
  ready: { color: 'success', label: 'Pronto', help: 'Il plan può essere eseguito' },
};

export function PlanStateTag({ state }: { state: string }) {
  const s = PLAN_STATE[state] ?? { color: 'default', label: state, help: '' };
  return (
    <Tooltip title={s.help}>
      <Tag color={s.color}>{s.label}</Tag>
    </Tooltip>
  );
}
