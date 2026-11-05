import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { PortItem } from '../genesys/types.js';

/** Arco dell'albero delle dipendenze: "from" usa "to" (chiavi tipo:id). Serve per l'ordine di creazione. */
export interface DependencyEdge {
  from: string;
  to: string;
}

/** Riepilogo del piano Terraform (da terraform show -json) */
export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
  replace: number;
  changes: { address: string; actions: string[] }[];
}

/** Un'organizzazione Genesys Cloud (dev, test, prod...) con il proprio OAuth client. */
export const environments = pgTable('environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Dominio, es. mypurecloud.de */
  region: text('region').notNull(),
  clientId: text('client_id').notNull(),
  /** Secret cifrato AES-256-GCM (src/lib/crypto.ts) */
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  /** Se false l'ambiente può essere solo sorgente (es. prod in sola lettura) */
  allowAsTarget: boolean('allow_as_target').notNull().default(true),
  /** Ambiente protetto: i plan verso questo target vanno approvati da una persona diversa da chi li ha creati */
  requireApproval: boolean('require_approval').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const jobMode = pgEnum('job_mode', ['PLAN', 'APPLY']);
export const jobStatus = pgEnum('job_status', ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']);

/** Un'esecuzione di porting: PLAN = simulazione, APPLY = scrittura sul target. Fa anche da audit. */
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  mode: jobMode('mode').notNull(),
  status: jobStatus('status').notNull().default('QUEUED'),
  sourceEnvId: uuid('source_env_id').notNull().references(() => environments.id),
  targetEnvId: uuid('target_env_id').notNull().references(() => environments.id),
  items: jsonb('items').$type<PortItem[]>().notNull(),
  /** Archi dell'albero delle dipendenze usati per l'ordine di creazione (solo PLAN) */
  edges: jsonb('edges').$type<DependencyEdge[]>().notNull().default([]),
  log: text('log').notNull().default(''),
  planOutput: text('plan_output'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),

  // ---- Solo PLAN ----
  /** Riepilogo delle modifiche pianificate */
  planSummary: jsonb('plan_summary').$type<PlanSummary>(),
  /** Se valorizzato il plan non è eseguibile (es. contiene cancellazioni o ricreazioni) */
  blockedReason: text('blocked_reason'),
  /**
   * Cartella di lavoro Terraform del plan (configurazione, file, state, file di piano, lock dei provider),
   * cifrata: è ciò che verrà applicato, senza riesportare dal sorgente
   */
  artifactEncrypted: text('artifact_encrypted'),
  /** Oltre questa data il plan non è più eseguibile */
  expiresAt: timestamp('expires_at'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at'),
  /** Job APPLY che ha consumato questo plan (un plan si esegue una sola volta) */
  appliedJobId: uuid('applied_job_id'),

  // ---- Solo APPLY ----
  /** Plan da cui deriva questo porting */
  planJobId: uuid('plan_job_id'),
  /** Risorse effettivamente presenti nello state dopo l'apply (anche in caso di esito parziale) */
  appliedResources: jsonb('applied_resources').$type<string[]>(),
}, (t) => [
  // Garanzia a livello di database: un plan può generare al massimo un porting
  uniqueIndex('jobs_plan_job_id_unique').on(t.planJobId),
]);

export type Environment = typeof environments.$inferSelect;
export type Job = typeof jobs.$inferSelect;
