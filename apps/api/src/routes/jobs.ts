import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OBJECT_TYPES, isStaticDataAction } from '../genesys/types.js';
import { db, schema } from '../lib/db.js';
import { enqueuePorting } from '../lib/queue.js';
import { getEnvironment, HttpError } from '../lib/repo.js';
import { unpackPlanFiles } from '../worker/artifact.js';
import { tarGz } from '../lib/tar.js';
import { decryptFileStream } from '../lib/crypto.js';
import { backupDir } from '../worker/backup.js';
import path from 'node:path';
import { requireAuth, sessionUser, type SessionUser } from './auth.js';
import { buildReleaseNotes } from './releaseNotes.js';

/** Parte di nome file sicura (nomi degli ambienti) */
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'ambiente';
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

const itemSchema = z.object({
  type: z.enum(OBJECT_TYPES),
  id: z.string(),
  name: z.string(),
  subtype: z.string().optional(),
  action: z.enum(['port', 'reuse', 'skip']),
  targetStatus: z.enum(['missing', 'same', 'different', 'present']),
  targetId: z.string().optional(),
  includeRows: z.boolean().optional(),
  dropUnavailablePermissions: z.boolean().optional(),
  allowReplace: z.boolean().optional(),
  targetSettings: z
    .object({
      siteId: z.string().optional(),
      edgeGroupId: z.string().optional(),
      emailDefault: z.object({ domainId: z.string(), routeId: z.string() }).optional(),
      emailAll: z.array(z.object({ domainId: z.string(), routeId: z.string() })).optional(),
      phone: z.string().optional(),
      messaging: z
        .object({ sms: z.string().optional(), whatsapp: z.string().optional(), open: z.string().optional() })
        .optional(),
      request: z
        .object({ url: z.string().optional(), headers: z.record(z.string(), z.string()).optional() })
        .optional(),
    })
    .optional(),
});

const j = schema.jobs;
const src = alias(schema.environments, 'src');
const tgt = alias(schema.environments, 'tgt');

/** Campi pubblici di un job: l'artefatto cifrato non esce mai dal server */
const publicFields = {
  id: j.id,
  mode: j.mode,
  status: j.status,
  createdBy: j.createdBy,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
  sourceName: src.name,
  targetName: tgt.name,
  targetRequireApproval: tgt.requireApproval,
  targetAllowAsTarget: tgt.allowAsTarget,
  planSummary: j.planSummary,
  blockedReason: j.blockedReason,
  expiresAt: j.expiresAt,
  approvedBy: j.approvedBy,
  approvedAt: j.approvedAt,
  appliedJobId: j.appliedJobId,
  planJobId: j.planJobId,
  appliedResources: j.appliedResources,
  artifactAvailable: sql<boolean>`${j.artifactEncrypted} is not null`,
  planFilesAvailable: sql<boolean>`${j.planFilesEncrypted} is not null`,
  rollbackOfJobId: j.rollbackOfJobId,
  rollbackAvailable: sql<boolean>`${j.rollbackEncrypted} is not null`,
  backup: j.backup,
};

type PublicJob = Awaited<ReturnType<typeof selectJobs>>[number];

function selectJobs() {
  return db
    .select(publicFields)
    .from(j)
    .innerJoin(src, eq(j.sourceEnvId, src.id))
    .innerJoin(tgt, eq(j.targetEnvId, tgt.id));
}

/**
 * Stato di un plan e cosa può farne l'utente corrente. Calcolato solo qui, così interfaccia e controlli
 * dell'API usano le stesse regole.
 */
function planState(job: PublicJob, user: SessionUser) {
  if (job.mode !== 'PLAN') return undefined;
  const now = Date.now();
  const reasons: string[] = [];
  let state: 'running' | 'failed' | 'blocked' | 'applied' | 'expired' | 'awaiting_approval' | 'ready';

  if (job.status === 'QUEUED' || job.status === 'RUNNING') state = 'running';
  else if (job.status === 'FAILED') state = 'failed';
  else if (job.blockedReason) state = 'blocked';
  else if (job.appliedJobId) state = 'applied';
  else if (!job.expiresAt || job.expiresAt.getTime() < now || !job.artifactAvailable) state = 'expired';
  else if (job.targetRequireApproval && !job.approvedBy) state = 'awaiting_approval';
  else state = 'ready';

  const approvable = ['awaiting_approval', 'ready'].includes(state) && !job.approvedBy;
  const canApprove = approvable && user.canApprove === true && user.sub !== job.createdBy;
  if (approvable && !user.canApprove) reasons.push('Non hai il permesso di approvare');
  if (approvable && user.sub === job.createdBy) reasons.push('Chi crea il plan non può approvarlo (4 occhi)');

  const canApply = state === 'ready' && user.canApply === true && job.targetAllowAsTarget;
  if (state === 'ready' && !user.canApply) reasons.push('Non hai il permesso di eseguire i plan');
  if (state === 'awaiting_approval') reasons.push(`${job.targetName} richiede l'approvazione di una seconda persona`);

  return { state, canApprove, canApply, reasons };
}

/** Messaggio preciso del perché un plan non può essere eseguito ora */
function notExecutable(job: PublicJob): string {
  if (job.mode !== 'PLAN') return 'Il job indicato non è una simulazione';
  if (job.status !== 'SUCCEEDED') return 'Si può eseguire solo una simulazione completata con successo';
  if (job.blockedReason) return `Plan non eseguibile: ${job.blockedReason}`;
  if (job.appliedJobId) return 'Questo plan è già stato eseguito: ogni plan si esegue una sola volta';
  if (!job.artifactAvailable || !job.expiresAt || job.expiresAt.getTime() < Date.now()) return 'Plan scaduto: rifare la simulazione';
  if (job.targetRequireApproval && !job.approvedBy) return `${job.targetName} richiede l'approvazione del plan`;
  if (!job.targetAllowAsTarget) return `${job.targetName} non è abilitato come target`;
  return 'Plan non eseguibile';
}

async function loadJob(id: string): Promise<PublicJob> {
  const [job] = await selectJobs().where(eq(j.id, id));
  if (!job) throw new HttpError(404, 'Job non trovato');
  return job;
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * Crea una simulazione (plan). È l'unico modo per arrivare a un rilascio:
   * non esiste un'esecuzione diretta senza plan.
   */
  app.post('/api/jobs', async (req) => {
    const body = z
      .object({
        sourceEnvId: z.string(),
        targetEnvId: z.string(),
        items: z.array(itemSchema).min(1),
        /** Archi dell'albero delle dipendenze ("from" usa "to"), per l'ordine di creazione */
        edges: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
      })
      .parse(req.body);

    if (body.sourceEnvId === body.targetEnvId) throw new HttpError(400, 'Sorgente e target coincidono');
    await getEnvironment(body.sourceEnvId);
    const target = await getEnvironment(body.targetEnvId);
    if (!target.allowAsTarget) throw new HttpError(400, `${target.name} non è abilitato come target`);
    const staticPorted = body.items.filter((i) => i.action === 'port' && isStaticDataAction(i));
    if (staticPorted.length) {
      throw new HttpError(
        400,
        `Data Actions predefinite di Genesys, non portabili (si usa quella del target): ${staticPorted.map((i) => i.name).join(', ')}`,
      );
    }
    if (!body.items.some((i) => i.action === 'port')) throw new HttpError(400, 'Nessun oggetto da portare');

    const keys = new Set(body.items.map((i) => `${i.type}:${i.id}`.toLowerCase()));
    const edges = body.edges.filter((e) => keys.has(e.from.toLowerCase()) && keys.has(e.to.toLowerCase()));

    const [job] = await db
      .insert(j)
      .values({
        mode: 'PLAN',
        sourceEnvId: body.sourceEnvId,
        targetEnvId: body.targetEnvId,
        items: body.items,
        edges,
        createdBy: sessionUser(req).sub,
      })
      .returning({ id: j.id });
    await enqueuePorting(job.id);
    return job;
  });

  /** Approvazione (4 occhi): da una persona con il permesso, diversa da chi ha creato il plan */
  app.post('/api/jobs/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const user = sessionUser(req);
    if (!user.canApprove) throw new HttpError(403, 'Non hai il permesso di approvare i plan');

    const [approved] = await db
      .update(j)
      .set({ approvedBy: user.sub, approvedAt: new Date() })
      .where(
        and(
          eq(j.id, id),
          eq(j.mode, 'PLAN'),
          eq(j.status, 'SUCCEEDED'),
          isNull(j.blockedReason),
          isNull(j.appliedJobId),
          isNull(j.approvedBy),
          isNotNull(j.artifactEncrypted),
          gt(j.expiresAt, new Date()),
          ne(j.createdBy, user.sub),
        ),
      )
      .returning({ id: j.id });

    if (!approved) {
      const job = await loadJob(id);
      if (job.createdBy === user.sub) throw new HttpError(403, 'Chi crea il plan non può approvarlo (4 occhi)');
      if (job.approvedBy) throw new HttpError(409, `Plan già approvato da ${job.approvedBy}`);
      throw new HttpError(409, notExecutable(job));
    }
    req.log.info({ plan: id, approvedBy: user.sub }, 'Plan approvato');
    return { ok: true };
  });

  /**
   * Esegue un plan. In un'unica transazione il plan viene "consumato" con un aggiornamento condizionale
   * (solo se completato, non bloccato, non scaduto, non già eseguito e, se serve, approvato) e viene creato
   * il job di esecuzione. Due richieste contemporanee non possono entrambe riuscire; in più un indice univoco
   * sul database impedisce due esecuzioni dello stesso plan.
   */
  app.post('/api/jobs/:id/apply', async (req) => {
    const { id } = req.params as { id: string };
    const user = sessionUser(req);
    if (!user.canApply) throw new HttpError(403, 'Non hai il permesso di eseguire i plan');

    const applyId = randomUUID();
    const created = await db.transaction(async (tx) => {
      const [plan] = await tx
        .update(j)
        .set({ appliedJobId: applyId })
        .where(
          and(
            eq(j.id, id),
            eq(j.mode, 'PLAN'),
            eq(j.status, 'SUCCEEDED'),
            isNull(j.blockedReason),
            isNull(j.appliedJobId),
            isNotNull(j.artifactEncrypted),
            gt(j.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!plan) return undefined;

      const target = await tx.select().from(schema.environments).where(eq(schema.environments.id, plan.targetEnvId));
      const env = target[0];
      if (!env?.allowAsTarget) throw new HttpError(409, `${env?.name ?? 'Il target'} non è abilitato come target`);
      if (env.requireApproval && !plan.approvedBy) throw new HttpError(409, `${env.name} richiede l'approvazione del plan`);

      await tx.insert(j).values({
        id: applyId,
        mode: 'APPLY',
        sourceEnvId: plan.sourceEnvId,
        targetEnvId: plan.targetEnvId,
        items: plan.items,
        planJobId: plan.id,
        createdBy: user.sub,
        log:
          `[porting] Esecuzione richiesta da ${user.sub} del plan ${plan.id} ` +
          `(creato da ${plan.createdBy} il ${plan.createdAt.toISOString()})\n`,
      });
      return plan;
    });

    if (!created) throw new HttpError(409, notExecutable(await loadJob(id)));
    req.log.info({ plan: id, apply: applyId, by: user.sub }, 'Esecuzione del plan richiesta');

    try {
      await enqueuePorting(applyId);
    } catch (e) {
      // Il plan resta consumato (nessun rilascio è partito): va rifatta la simulazione
      await db
        .update(j)
        .set({ status: 'FAILED', finishedAt: new Date(), log: sql`${j.log} || ${`[porting] ERRORE: impossibile accodare l'esecuzione: ${(e as Error).message}\n`}` })
        .where(and(eq(j.id, applyId), eq(j.status, 'QUEUED')));
      throw e;
    }
    return { id: applyId };
  });

  /** Scarta un plan non ancora eseguito (chi l'ha creato o chi può approvare) */
  app.post('/api/jobs/:id/discard', async (req) => {
    const { id } = req.params as { id: string };
    const user = sessionUser(req);
    const job = await loadJob(id);
    if (job.mode !== 'PLAN') throw new HttpError(400, 'Il job indicato non è una simulazione');
    if (job.createdBy !== user.sub && !user.canApprove) throw new HttpError(403, 'Solo chi ha creato il plan può scartarlo');
    await db
      .update(j)
      .set({ artifactEncrypted: null, expiresAt: new Date() })
      .where(and(eq(j.id, id), isNull(j.appliedJobId)));
    return { ok: true };
  });

  /**
   * Configurazione di un plan (o del plan di un'esecuzione) come .tar.gz: export rimappato per il target,
   * file referenziati, output del plan e riepilogo. Senza state né file di piano binario
   */
  app.get('/api/jobs/:id/plan-files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await db.select().from(j).where(eq(j.id, id));
    if (!job) throw new HttpError(404, 'Job non trovato');
    const [plan] = job.mode === 'PLAN' ? [job] : job.planJobId ? await db.select().from(j).where(eq(j.id, job.planJobId)) : [];
    if (!plan?.planFilesEncrypted) throw new HttpError(404, 'File del plan non disponibili (simulazione non completata o precedente a questa funzione)');
    const target = await getEnvironment(plan.targetEnvId);
    const name = `plan-${fileSafe(target.name)}-${stamp(plan.createdAt)}.tar.gz`;
    req.log.info({ plan: plan.id, by: sessionUser(req).sub }, 'Download dei file del plan');
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(tarGz(unpackPlanFiles(plan.planFilesEncrypted), plan.createdAt));
  });

  /**
   * Backup: export in sola lettura degli oggetti scelti di un ambiente. Per ogni tipo tutti gli oggetti
   * (all) oppure quelli indicati. Nessuna scrittura sulle org, nessuna approvazione
   */
  app.post('/api/backups', async (req) => {
    const body = z
      .object({
        envId: z.string(),
        selection: z
          .array(
            z.object({
              type: z.enum(OBJECT_TYPES),
              all: z.boolean(),
              objects: z.array(z.object({ id: z.string(), name: z.string(), subtype: z.string().optional() })).optional(),
            }),
          )
          .min(1),
      })
      .parse(req.body);
    const selection = body.selection.filter((s) => s.all || s.objects?.length);
    if (!selection.length) throw new HttpError(400, 'Nessun oggetto scelto per il backup');
    const env = await getEnvironment(body.envId);
    const [job] = await db
      .insert(j)
      .values({
        mode: 'BACKUP',
        sourceEnvId: env.id,
        targetEnvId: env.id,
        items: [],
        backup: { selection },
        createdBy: sessionUser(req).sub,
      })
      .returning({ id: j.id });
    await enqueuePorting(job.id);
    req.log.info({ backup: job.id, env: env.name, by: sessionUser(req).sub }, 'Backup richiesto');
    return job;
  });

  /** Archivio di un backup (.tar.gz), decifrato al volo */
  app.get('/api/jobs/:id/backup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await db.select().from(j).where(eq(j.id, id));
    if (!job || job.mode !== 'BACKUP') throw new HttpError(404, 'Backup non trovato');
    if (!job.backup?.file || job.backup.deleted) {
      throw new HttpError(404, job.backup?.deleted ? 'Archivio cancellato dalla politica di conservazione' : 'Backup non completato');
    }
    const env = await getEnvironment(job.sourceEnvId);
    const stream = await decryptFileStream(path.join(backupDir(), job.backup.file));
    req.log.info({ backup: id, by: sessionUser(req).sub }, 'Download del backup');
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="backup-${fileSafe(env.name)}-${stamp(job.createdAt)}.tar.gz"`)
      .send(stream);
  });

  /** Note di rilascio di un'esecuzione (Markdown) */
  app.get('/api/jobs/:id/release-notes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [apply] = await db.select().from(j).where(eq(j.id, id));
    if (!apply || apply.mode !== 'APPLY') throw new HttpError(404, 'Esecuzione non trovata');
    const [plan] = apply.planJobId ? await db.select().from(j).where(eq(j.id, apply.planJobId)) : [];
    const [rollbackOf] = plan?.rollbackOfJobId ? await db.select().from(j).where(eq(j.id, plan.rollbackOfJobId)) : [];
    const source = await getEnvironment(apply.sourceEnvId);
    const target = await getEnvironment(apply.targetEnvId);
    const md = buildReleaseNotes({ apply, plan, sourceName: source.name, targetName: target.name, rollbackOf });
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="note-di-rilascio-${fileSafe(target.name)}-${stamp(apply.createdAt)}.md"`)
      .send(md);
  });

  /**
   * Ripristino: crea un plan che riporta il target allo stato precedente a un'esecuzione (oggetti aggiornati
   * come erano prima, oggetti creati cancellati). Segue il percorso normale: simulazione, approvazione, esecuzione
   */
  app.post('/api/jobs/:id/rollback', async (req) => {
    const { id } = req.params as { id: string };
    const [apply] = await db.select().from(j).where(eq(j.id, id));
    if (!apply || apply.mode !== 'APPLY') throw new HttpError(404, 'Esecuzione non trovata');
    if (apply.status === 'QUEUED' || apply.status === 'RUNNING') throw new HttpError(409, 'Esecuzione ancora in corso');
    if (!apply.rollbackEncrypted) {
      throw new HttpError(409, 'Stato precedente non disponibile per questa esecuzione (precedente a questa funzione o non arrivata alla scrittura)');
    }
    const target = await getEnvironment(apply.targetEnvId);
    if (!target.allowAsTarget) throw new HttpError(400, `${target.name} non è abilitato come target`);
    const [job] = await db
      .insert(j)
      .values({
        mode: 'PLAN',
        sourceEnvId: apply.targetEnvId,
        targetEnvId: apply.targetEnvId,
        items: apply.items,
        rollbackOfJobId: apply.id,
        createdBy: sessionUser(req).sub,
      })
      .returning({ id: j.id });
    await enqueuePorting(job.id);
    req.log.info({ apply: id, rollbackPlan: job.id, by: sessionUser(req).sub }, 'Plan di ripristino richiesto');
    return job;
  });

  app.get('/api/jobs', async (req) => {
    const user = sessionUser(req);
    const rows = await selectJobs().orderBy(desc(j.createdAt)).limit(200);
    return rows.map((r) => ({ ...r, plan: planState(r, user) }));
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const user = sessionUser(req);
    const job = await loadJob(id);
    const [extra] = await db
      .select({ items: j.items, log: j.log, planOutput: j.planOutput })
      .from(j)
      .where(eq(j.id, id));
    return { ...job, ...extra, plan: planState(job, user) };
  });
}
