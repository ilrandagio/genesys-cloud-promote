import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OBJECT_TYPES } from '../genesys/types.js';
import { db, schema } from '../lib/db.js';
import { portingQueue } from '../lib/queue.js';
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
    await portingQueue.add('port', { jobId: job.id }, { jobId: job.id, attempts: 1 });
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
