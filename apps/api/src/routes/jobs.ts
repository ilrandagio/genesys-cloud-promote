import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OBJECT_TYPES } from '../genesys/types.js';
import { db, schema } from '../lib/db.js';
import { enqueuePorting } from '../lib/queue.js';
import { getEnvironment, HttpError } from '../lib/repo.js';
import { requireAuth } from './auth.js';

const itemSchema = z.object({
  type: z.enum(OBJECT_TYPES),
  id: z.string(),
  name: z.string(),
  subtype: z.string().optional(),
  action: z.enum(['port', 'reuse', 'skip']),
  targetStatus: z.enum(['missing', 'same', 'different', 'present']),
  targetId: z.string().optional(),
});

const j = schema.jobs;
const src = alias(schema.environments, 'src');
const tgt = alias(schema.environments, 'tgt');

const summaryFields = {
  id: j.id,
  mode: j.mode,
  status: j.status,
  createdBy: j.createdBy,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
  sourceName: src.name,
  targetName: tgt.name,
};

function withEnvs() {
  return db
    .select({ ...summaryFields, items: j.items, log: j.log, planOutput: j.planOutput })
    .from(j)
    .innerJoin(src, eq(j.sourceEnvId, src.id))
    .innerJoin(tgt, eq(j.targetEnvId, tgt.id));
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Crea un job: PLAN (simulazione con terraform plan) o APPLY (scrittura sul target) */
  app.post('/api/jobs', async (req) => {
    const body = z
      .object({
        sourceEnvId: z.string(),
        targetEnvId: z.string(),
        mode: z.enum(['PLAN', 'APPLY']),
        items: z.array(itemSchema).min(1),
      })
      .parse(req.body);

    if (body.sourceEnvId === body.targetEnvId) throw new HttpError(400, 'Sorgente e target coincidono');
    const target = await getEnvironment(body.targetEnvId);
    if (!target.allowAsTarget) throw new HttpError(400, `${target.name} non è abilitato come target`);
    if (!body.items.some((i) => i.action === 'port')) throw new HttpError(400, 'Nessun oggetto da portare');

    const [job] = await db
      .insert(j)
      .values({
        mode: body.mode,
        sourceEnvId: body.sourceEnvId,
        targetEnvId: body.targetEnvId,
        items: body.items,
        createdBy: (req.user as { sub: string }).sub,
      })
      .returning();
    await enqueuePorting(job.id);
    return job;
  });

  /**
   * Esegue il porting di una simulazione completata: il job APPLY viene creato copiando sorgente, target,
   * oggetti e azioni salvati nel plan, così ciò che viene scritto corrisponde a ciò che è stato simulato.
   */
  app.post('/api/jobs/:id/apply', async (req) => {
    const { id } = req.params as { id: string };
    const [plan] = await db.select().from(j).where(eq(j.id, id));
    if (!plan) throw new HttpError(404, 'Simulazione non trovata');
    if (plan.mode !== 'PLAN') throw new HttpError(400, 'Il job indicato non è una simulazione');
    if (plan.status !== 'SUCCEEDED') throw new HttpError(400, 'Si può eseguire solo una simulazione completata con successo');
    const target = await getEnvironment(plan.targetEnvId);
    if (!target.allowAsTarget) throw new HttpError(400, `${target.name} non è abilitato come target`);

    const [job] = await db
      .insert(j)
      .values({
        mode: 'APPLY',
        sourceEnvId: plan.sourceEnvId,
        targetEnvId: plan.targetEnvId,
        items: plan.items,
        createdBy: (req.user as { sub: string }).sub,
        log: `[porting] Porting della simulazione ${plan.id} del ${plan.createdAt.toISOString()} (stessi oggetti e azioni)\n`,
      })
      .returning();
    await enqueuePorting(job.id);
    return job;
  });

  app.get('/api/jobs', async () =>
    db
      .select(summaryFields)
      .from(j)
      .innerJoin(src, eq(j.sourceEnvId, src.id))
      .innerJoin(tgt, eq(j.targetEnvId, tgt.id))
      .orderBy(desc(j.createdAt))
      .limit(100),
  );

  app.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [job] = await withEnvs().where(eq(j.id, id));
    if (!job) throw new HttpError(404, 'Job non trovato');
    return job;
  });
}
