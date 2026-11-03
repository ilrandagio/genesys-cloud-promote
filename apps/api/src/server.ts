import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { inArray, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, inProcessWorker } from './config.js';
import { db, migrateDb, schema, usingPglite } from './lib/db.js';
import { authRoutes, COOKIE } from './routes/auth.js';
import { environmentRoutes } from './routes/environments.js';
import { jobRoutes } from './routes/jobs.js';
import { objectRoutes } from './routes/objects.js';

// Migrazioni DB all'avvio (cartella drizzle/ generata con `npm run db:generate`)
await migrateDb();

if (inProcessWorker) {
  // I job in corso al riavvio non possono essere ripresi: la coda interna vive nel processo
  await db
    .update(schema.jobs)
    .set({ status: 'FAILED', finishedAt: new Date(), log: sql`${schema.jobs.log} || '[porting] Interrotto dal riavvio dell''applicazione\n'` })
    .where(inArray(schema.jobs.status, ['QUEUED', 'RUNNING']));
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
await app.register(cookie);
await app.register(jwt, { secret: config.JWT_SECRET, cookie: { cookieName: COOKIE, signed: false } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Input non valido', details: err.issues });
  app.log.error(err);
  const e = err as { statusCode?: number; message: string };
  reply.code(e.statusCode ?? 500).send({ error: e.message });
});

app.get('/api/health', async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(environmentRoutes);
await app.register(objectRoutes);
await app.register(jobRoutes);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
app.log.info(
  `Database: ${usingPglite ? `integrato (PGlite) in ${config.DATA_DIR}` : 'PostgreSQL'} · ` +
    `Job: ${inProcessWorker ? 'eseguiti in questo processo' : 'worker separato via Redis'}`,
);
