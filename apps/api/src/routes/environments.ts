import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GenesysClient } from '../genesys/client.js';
import { REGIONS } from '../genesys/regions.js';
import { encrypt } from '../lib/crypto.js';
import { db, schema } from '../lib/db.js';
import { randomUUID } from 'node:crypto';
import { getEnvironment, HttpError } from '../lib/repo.js';
import { requireAuth } from './auth.js';

/** Il nome non si inserisce: viene letto dall'org Genesys con le credenziali fornite */
const envInput = z.object({
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

/**
 * Prova le credenziali e restituisce il nome dell'org Genesys.
 * Errore 400 leggibile se il login OAuth o la lettura dell'org non riescono.
 */
async function orgNameFor(region: string, clientId: string, clientSecretEncrypted: string): Promise<string> {
  const probeId = `probe:${randomUUID()}`;
  try {
    return await new GenesysClient({ id: probeId, name: 'nuovo ambiente', region, clientId, clientSecretEncrypted }).whoAmI();
  } catch (e) {
    const msg = (e as Error).message.replace(/^Ambiente "[^"]*": /, "");
    throw new HttpError(400, `Verifica delle credenziali non riuscita: ${msg}`);
  } finally {
    GenesysClient.forget(probeId);
  }
}

/** Il nome è unico: due ambienti sulla stessa org non sono ammessi */
async function ensureNameFree(name: string, exceptId?: string) {
  const [existing] = await db.select({ id: t.id }).from(t).where(eq(t.name, name));
  if (existing && existing.id !== exceptId) {
    throw new HttpError(409, `L'org "${name}" è già configurata come ambiente`);
  }
}

export async function environmentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/regions', async () => Object.keys(REGIONS));

  app.get('/api/environments', async () => db.select(publicFields).from(t).orderBy(asc(t.name)));

  app.post('/api/environments', async (req) => {
    const body = envInput.parse(req.body);
    if (!body.clientSecret) throw new HttpError(400, 'Client secret obbligatorio');
    const clientSecretEncrypted = encrypt(body.clientSecret);
    const name = await orgNameFor(body.region, body.clientId, clientSecretEncrypted);
    await ensureNameFree(name);
    const [row] = await db
      .insert(t)
      .values({ name, region: body.region, clientId: body.clientId, clientSecretEncrypted, allowAsTarget: body.allowAsTarget })
      .returning(publicFields);
    return row;
  });

  app.put('/api/environments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = envInput.parse(req.body);
    const current = await getEnvironment(id);
    const clientSecretEncrypted = body.clientSecret ? encrypt(body.clientSecret) : current.clientSecretEncrypted;
    // Credenziali riverificate a ogni salvataggio: il nome segue l'org (es. se cambia client o regione)
    const name = await orgNameFor(body.region, body.clientId, clientSecretEncrypted);
    await ensureNameFree(name, id);
    const [row] = await db
      .update(t)
      .set({
        name,
        region: body.region,
        clientId: body.clientId,
        clientSecretEncrypted,
        allowAsTarget: body.allowAsTarget,
        updatedAt: new Date(),
      })
      .where(eq(t.id, id))
      .returning(publicFields);
    GenesysClient.forget(id);
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
