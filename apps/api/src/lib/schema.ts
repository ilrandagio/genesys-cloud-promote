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
  /** Risorse del plan già uguali sul target: nessuna modifica (assente nei plan meno recenti) */
  unchanged?: string[];
  /** Avvisi da leggere prima di approvare (es. permessi tolti dai Roles) */
  warnings?: string[];
}

/** Un'organizzazione Genesys Cloud (dev, test, prod...) con il proprio OAuth client. */
/** Regola Bot Connector: il bot del sorgente (versione vuota = tutte) diventa quello del target (vuoto = invariato) */
export interface BotMapping {
  integration?: string;
  sourceBot: string;
  sourceVersion?: string;
  targetIntegration?: string;
  targetBot?: string;
  targetVersion?: string;
}

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
  /** Come target: sostituzioni di integration, bot e versione nelle azioni Bot Connector dei Flows portati */
  botMappings: jsonb('bot_mappings').$type<BotMapping[]>(),
  /** Login delle persone in questa org (OAuth client Code Authorization): permette di cambiare org dall'app */
  loginClientId: text('login_client_id'),
  /** Secret del client di login, cifrato come quello del client dell'ambiente */
  loginClientSecretEncrypted: text('login_client_secret_encrypted'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Backup: cosa esportare e risultato */
export interface BackupInfo {
  /** Backup completo: tutto ciò che il provider esporta, senza filtri né esclusioni */
  full?: boolean;
  selection: { type: string; all: boolean; objects?: { id: string; name: string; subtype?: string }[] }[];
  /** Nome del file cifrato in BACKUP_DIR (assente finché il backup non è completato) */
  file?: string;
  /** Dimensione dell'archivio non cifrato */
  size?: number;
  /** Risorse esportate per tipo Terraform */
  counts?: Record<string, number>;
  /** Archivio cancellato dalla politica di conservazione */
  deleted?: boolean;
}

export const jobMode = pgEnum('job_mode', ['PLAN', 'APPLY', 'BACKUP']);
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
  /**
   * File della configurazione da scaricare (export rimappato e file referenziati, output del plan), cifrati.
   * Senza state, tfvars e file di piano binario. Restano anche dopo l'esecuzione
   */
  planFilesEncrypted: text('plan_files_encrypted'),
  /** Plan di ripristino: esecuzione di cui riporta il target allo stato precedente */
  rollbackOfJobId: uuid('rollback_of_job_id'),

  // ---- Solo APPLY ----
  /** Plan da cui deriva questo porting */
  planJobId: uuid('plan_job_id'),
  /** Risorse effettivamente presenti nello state dopo l'apply (anche in caso di esito parziale) */
  appliedResources: jsonb('applied_resources').$type<string[]>(),
  /**
   * Stato del target prima dell'esecuzione (export degli oggetti aggiornati) e oggetti creati, cifrati:
   * servono al plan di ripristino
   */
  rollbackEncrypted: text('rollback_encrypted'),
  /**
   * Tipi Terraform generici (fuori dal catalogo) da portare interi: export dal sorgente, abbinamento con il
   * target per etichetta, import di quelli esistenti
   */
  terraformTypes: jsonb('terraform_types').$type<string[]>(),
  /** Backup: oggetti scelti, archivio cifrato su disco, dimensione e conteggi per tipo */
  backup: jsonb('backup').$type<BackupInfo>(),
  /** Rilascio (tag) a cui appartiene: scelto nella simulazione, ereditato da esecuzione e ripristino */
  releaseTagId: uuid('release_tag_id'),
}, (t) => [
  // Garanzia a livello di database: un plan può generare al massimo un porting
  uniqueIndex('jobs_plan_job_id_unique').on(t.planJobId),
]);

export type Environment = typeof environments.$inferSelect;
export type Job = typeof jobs.$inferSelect;

/**
 * Rilascio (tag) di un ambiente target: raccoglie più esecuzioni (es. prima le Queues, poi gli Scripts).
 * Lo stesso nome può esistere su più ambienti; promosso da un altro ambiente, ne ricorda l'origine.
 */
export const releaseTags = pgTable(
  'release_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    targetEnvId: uuid('target_env_id').notNull().references(() => environments.id),
    description: text('description'),
    /** Tag di un altro ambiente da cui è stato promosso */
    promotedFromTagId: uuid('promoted_from_tag_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Tag chiuso: non si associa a nuove simulazioni, il contenuto resta fisso (si può riaprire) */
    closedAt: timestamp('closed_at'),
    closedBy: text('closed_by'),
  },
  (t) => [uniqueIndex('release_tags_env_name_unique').on(t.targetEnvId, t.name)],
);

/**
 * Versione di un oggetto in un rilascio: lo stato letto dal target subito dopo un'esecuzione del tag
 * (anche interrotta: solo gli oggetti effettivamente scritti) o dopo un ripristino.
 * - applied: scritto da un'esecuzione del tag;
 * - restored / deleted: un ripristino ha riportato l'oggetto allo stato precedente o lo ha cancellato
 *   (undoneJobId = esecuzione annullata).
 */
export const releaseObjects = pgTable('release_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tagId: uuid('tag_id').notNull().references(() => releaseTags.id),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  kind: text('kind').$type<'applied' | 'restored' | 'deleted'>().notNull(),
  undoneJobId: uuid('undone_job_id'),
  /** Tipo del catalogo (assente per i tipi Terraform generici) e tipo Terraform */
  type: text('type'),
  tfType: text('tf_type').notNull(),
  targetId: text('target_id'),
  name: text('name').notNull(),
  subtype: text('subtype'),
  /** Contenuto normalizzato (come nel confronto dell'analisi); null se non leggibile */
  content: jsonb('content'),
  /** Versione pubblicata (Flows), errore di lettura, ecc. */
  info: jsonb('info').$type<{ version?: string; error?: string; source?: 'api' | 'state' }>(),
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
});

export type ReleaseTag = typeof releaseTags.$inferSelect;
export type ReleaseObject = typeof releaseObjects.$inferSelect;
