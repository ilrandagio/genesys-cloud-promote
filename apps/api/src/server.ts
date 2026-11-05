import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, inProcessWorker } from './config.js';
import { closeDb, migrateDb, usingPglite } from './lib/db.js';
import { localQueueIdle } from './lib/queue.js';
import { failInterruptedJobs, purgeStaleArtifacts } from './lib/maintenance.js';
import { authRoutes, COOKIE } from './routes/auth.js';
import { environmentRoutes } from './routes/environments.js';
import { jobRoutes } from './routes/jobs.js';
import { objectRoutes } from './routes/objects.js';

// Migrazioni DB all'avvio (cartella drizzle/ generata con `npm run db:generate`)
await migrateDb();

// Job rimasti a metà: con la coda interna nessun job sopravvive al riavvio dell'applicazione
if (inProcessWorker) await failInterruptedJobs(['QUEUED', 'RUNNING']);
await purgeStaleArtifacts();
setInterval(() => void purgeStaleArtifacts().catch(() => {}), 3600_000).unref();

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
// Il secret firma il cookie temporaneo con state e verifier PKCE del login
await app.register(cookie, { secret: config.JWT_SECRET });
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
if (usingPglite) {
  app.log.warn(
    'Database integrato (PGlite): adatto per provare l\'applicazione. Per plan, approvazioni e storico che devono durare ' +
      'usare PostgreSQL (DATABASE_URL): una chiusura brusca del processo può danneggiare il database integrato.',
  );
}

/**
 * Chiusura ordinata (Ctrl+C, stop del servizio): niente nuove richieste, attesa del job in corso
 * (interrompere una scrittura sul target lascerebbe un rilascio a metà), chiusura del database.
 */
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info(`${signal}: chiusura ordinata in corso`);
  await app.close();
  if (inProcessWorker) {
    app.log.info('Attendo la fine dell\'eventuale job in corso...');
    await localQueueIdle();
  }
  await closeDb();
  app.log.info('Chiusura completata');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
