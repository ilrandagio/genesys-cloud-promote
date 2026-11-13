export type ObjectType =
  | 'flow'
  | 'queue'
  | 'skill'
  | 'wrapupcode'
  | 'language'
  | 'dataaction'
  | 'integration'
  | 'schedule'
  | 'schedulegroup'
  | 'prompt'
  | 'group'
  | 'skillgroup'
  | 'role'
  | 'division'
  | 'script'
  | 'datatable'
  | 'emergencygroup'
  | 'campaign'
  | 'messagingcampaign'
  | 'sequence'
  | 'contactlist'
  | 'contactlistfilter'
  | 'dnclist'
  | 'callanalysisresponseset'
  | 'ruleset'
  | 'digitalruleset'
  | 'campaignrule'
  | 'attemptlimit'
  | 'callabletimeset'
  | 'filespectemplate'
  | 'webconfig'
  | 'webdeployment'
  | 'supportedcontent'
  | 'responselibrary'
  | 'response'
  | 'responseasset'
  | 'wrapupmapping';

export interface DivisionRef {
  id?: string;
  name: string;
}

export type TargetStatus = 'missing' | 'same' | 'different' | 'present';
export type PortAction = 'port' | 'reuse' | 'skip';

export interface Environment {
  id: string;
  name: string;
  region: string;
  clientId: string;
  allowAsTarget: boolean;
  /** Ambiente protetto: i plan richiedono l'approvazione di una seconda persona */
  requireApproval: boolean;
}

export interface Me {
  username: string;
  name: string;
  org: string;
  canApply: boolean;
  canApprove: boolean;
}

export interface GcObject {
  type: ObjectType;
  id: string;
  name: string;
  subtype?: string;
  description?: string;
  division?: string;
  published?: boolean;
}

export interface DependencyNode {
  type: ObjectType;
  id: string;
  name: string;
  subtype?: string;
  rawType?: string;
  supported: boolean;
  /** Oggetto contenuto nel padre (es. Canned Response di una Library): nell'ordine di creazione viene dopo il padre */
  contained?: boolean;
  repeated?: boolean;
  error?: string;
  division?: DivisionRef;
  target?: { status: TargetStatus; id?: string; diff?: string[]; division?: DivisionRef; divisionMissing?: boolean };
  /** Solo Campaign e Queue: impostazioni legate all'org, da scegliere sul target */
  settings?: SourceSettings;
  children: DependencyNode[];
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface EmailAddress {
  domainId: string;
  routeId: string;
  address: string;
}

export interface SourceSettings {
  site?: NamedRef;
  edgeGroup?: NamedRef;
  emailDefault?: EmailAddress;
  emailAll?: EmailAddress[];
  phone?: { source?: string; target?: string; required: boolean };
  /** Valori attuali dell'oggetto sul target, se esiste già */
  targetCurrent?: { site?: NamedRef; edgeGroup?: NamedRef; emailDefault?: EmailAddress; emailAll?: EmailAddress[] };
}

/** Valori del target scelti per una Campaign o una Queue */
export interface TargetSettings {
  siteId?: string;
  edgeGroupId?: string;
  emailDefault?: { domainId: string; routeId: string };
  emailAll?: { domainId: string; routeId: string }[];
  phone?: string;
}

export interface TargetOptions {
  sites: NamedRef[];
  edgeGroups: NamedRef[];
  emailAddresses: EmailAddress[];
  /** Elenchi del target non leggibili (es. permessi mancanti) */
  errors: string[];
}

export interface PortItem {
  type: ObjectType;
  id: string;
  name: string;
  subtype?: string;
  action: PortAction;
  targetStatus: TargetStatus;
  targetId?: string;
  targetSettings?: TargetSettings;
  includeRows?: boolean;
}

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
  replace: number;
  changes: { address: string; actions: string[] }[];
  /** Risorse del plan già uguali sul target: nessuna modifica (assente nei plan meno recenti) */
  unchanged?: string[];
}

export type PlanStateName = 'running' | 'failed' | 'blocked' | 'applied' | 'expired' | 'awaiting_approval' | 'ready';

/** Stato del plan e azioni consentite all'utente corrente (calcolati dal server) */
export interface PlanState {
  state: PlanStateName;
  canApprove: boolean;
  canApply: boolean;
  reasons: string[];
}

export interface JobSummary {
  id: string;
  mode: 'PLAN' | 'APPLY';
  status: JobStatus;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
  sourceName: string;
  targetName: string;
  targetRequireApproval: boolean;
  planSummary?: PlanSummary | null;
  blockedReason?: string | null;
  expiresAt?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  appliedJobId?: string | null;
  planJobId?: string | null;
  appliedResources?: string[] | null;
  plan?: PlanState;
}

export interface JobDetail extends JobSummary {
  items: PortItem[];
  log: string;
  planOutput?: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}
