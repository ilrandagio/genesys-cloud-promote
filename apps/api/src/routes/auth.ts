import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Login applicativo con utenti locali (APP_USERS).
 * Punto di estensione: sostituire con OIDC (Entra ID / Okta / login Genesys) mantenendo
 * lo stesso cookie JWT, così il resto dell'app non cambia.
 */
const users = new Map(
  config.APP_USERS.replace(/^['"]|['"]$/g, '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      const i = u.indexOf(':');
      return [u.slice(0, i), u.slice(i + 1)] as const;
    }),
);

export const COOKIE = 'gcpromote_session';

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Non autenticato' });
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const hash = users.get(username);
    if (!hash || !(await bcrypt.compare(password, hash))) {
      return reply.code(401).send({ error: 'Credenziali non valide' });
    }
    const token = app.jwt.sign({ sub: username }, { expiresIn: '8h' });
    reply
      .setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' })
      .send({ username });
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({ username: (req.user as { sub: string }).sub }));
}
