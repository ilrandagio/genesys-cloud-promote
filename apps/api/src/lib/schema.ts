import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PortItem } from '../genesys/types.js';

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
  log: text('log').notNull().default(''),
  planOutput: text('plan_output'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
});

export type Environment = typeof environments.$inferSelect;
export type Job = typeof jobs.$inferSelect;
