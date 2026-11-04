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
  | 'division'
  | 'script';

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
  repeated?: boolean;
  error?: string;
  division?: DivisionRef;
  target?: { status: TargetStatus; id?: string; diff?: string[]; division?: DivisionRef; divisionMissing?: boolean };
  children: DependencyNode[];
}

export interface PortItem {
  type: ObjectType;
  id: string;
  name: string;
  subtype?: string;
  action: PortAction;
  targetStatus: TargetStatus;
  targetId?: string;
}

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface JobSummary {
  id: string;
  mode: 'PLAN' | 'APPLY';
  status: JobStatus;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
  sourceName: string;
  targetName: string;
}

export interface JobDetail extends JobSummary {
  items: PortItem[];
  log: string;
  planOutput?: string;
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
