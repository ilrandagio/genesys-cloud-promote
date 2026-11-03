import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './lib/db.js';
import { ZodError } from 'zod';
import { config } from './config.js';
import { authRoutes, COOKIE } from './routes/auth.js';
import { environmentRoutes } from './routes/environments.js';
import { jobRoutes } from './routes/jobs.js';
import { objectRoutes } from './routes/objects.js';

// Migrazioni DB all'avvio (cartella drizzle/ generata con `npm run db:generate`)
await migrate(db, { migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle') });

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
