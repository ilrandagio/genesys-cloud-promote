import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GenesysClient } from '../genesys/client.js';
import { REGIONS } from '../genesys/regions.js';
import { encrypt } from '../lib/crypto.js';
import { db, schema } from '../lib/db.js';
import { getEnvironment } from '../lib/repo.js';
import { requireAuth } from './auth.js';

const envInput = z.object({
  name: z.string().min(1),
  region: z.string().refine((r) => r in REGIONS, 'Regione non valida'),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  allowAsTarget: z.boolean().default(true),
});

const t = schema.environments;
/** Mai restituire il secret, nemmeno cifrato */
const publicFields = {
  id: t.id,
  name: t.name,
  region: t.region,
  clientId: t.clientId,
  allowAsTarget: t.allowAsTarget,
  createdAt: t.createdAt,
};

export async function environmentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/regions', async () => Object.keys(REGIONS));

  app.get('/api/environments', async () => db.select(publicFields).from(t).orderBy(asc(t.name)));

  app.post('/api/environments', async (req, reply) => {
    const body = envInput.parse(req.body);
    if (!body.clientSecret) return reply.code(400).send({ error: 'clientSecret obbligatorio' });
    const [row] = await db
      .insert(t)
      .values({
        name: body.name,
        region: body.region,
        clientId: body.clientId,
        clientSecretEncrypted: encrypt(body.clientSecret),
        allowAsTarget: body.allowAsTarget,
      })
      .returning(publicFields);
    return row;
  });

  app.put('/api/environments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = envInput.parse(req.body);
    const [row] = await db
      .update(t)
      .set({
        name: body.name,
        region: body.region,
        clientId: body.clientId,
        allowAsTarget: body.allowAsTarget,
        updatedAt: new Date(),
        ...(body.clientSecret ? { clientSecretEncrypted: encrypt(body.clientSecret) } : {}),
      })
      .where(eq(t.id, id))
      .returning(publicFields);
    return row;
  });

  app.delete('/api/environments/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(t).where(eq(t.id, id));
    return { ok: true };
  });

  /** Prova le credenziali OAuth dell'ambiente */
  app.post('/api/environments/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const env = await getEnvironment(id);
    try {
      return { ok: true, organization: await new GenesysClient(env).whoAmI() };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });
}
