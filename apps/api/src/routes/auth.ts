import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { REGIONS } from '../genesys/regions.js';

/**
 * Login con Genesys Cloud: OAuth 2.0 Authorization Code + PKCE verso l'org di login.
 * Dopo il callback l'app emette un proprio cookie di sessione (JWT, 8 ore);
 * il token Genesys dell'utente serve solo a leggere chi è e non viene conservato.
 */

export const COOKIE = 'gcpromote_session';
const STATE_COOKIE = 'gcpromote_oauth';
const SESSION_HOURS = 8;

if (!(config.GENESYS_LOGIN_REGION in REGIONS)) {
  throw new Error(`GENESYS_LOGIN_REGION "${config.GENESYS_LOGIN_REGION}" non valida. Valori ammessi: ${Object.keys(REGIONS).join(', ')}`);
}

const loginBase = `https://login.${config.GENESYS_LOGIN_REGION}`;
const apiBase = `https://api.${config.GENESYS_LOGIN_REGION}`;
const redirectUri = `${config.APP_URL.replace(/\/$/, '')}/api/auth/callback`;
const secure = config.APP_URL.startsWith('https://');
const allowedEmails = config.APP_ALLOWED_EMAILS
  ? new Set(config.APP_ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
  : undefined;

export interface SessionUser {
  sub: string; // email
  name: string;
  genesysUserId: string;
  /** Può eseguire plan (scrivere sul target) */
  canApply: boolean;
  /** Può approvare plan verso ambienti protetti */
  canApprove: boolean;
}

const emailList = (v?: string) => new Set((v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const applyEmails = emailList(config.APP_APPLY_EMAILS);
const approverEmails = emailList(config.APP_APPROVER_EMAILS);

/**
 * Permesso concesso se l'utente ha il ruolo O è nell'elenco email.
 * Se non è configurato né ruolo né elenco, il permesso è aperto a tutti gli utenti autenticati.
 */
function grants(role: string | undefined, emails: Set<string>, userRoles: string[], email: string): boolean {
  if (!role && emails.size === 0) return true;
  return (!!role && userRoles.includes(role.toLowerCase())) || emails.has(email);
}

/** Utente della sessione corrente (dopo requireAuth) */
export const sessionUser = (req: FastifyRequest) => req.user as SessionUser;

const b64url = (buf: Buffer) => buf.toString('base64url');

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Non autenticato' });
  }
}

/** Torna all'interfaccia con un messaggio di errore leggibile nella pagina di login */
function fail(reply: FastifyReply, message: string) {
  return reply.redirect(`${config.APP_URL}/?loginError=${encodeURIComponent(message)}`);
}

export async function authRoutes(app: FastifyInstance) {
  /** Avvia il login: redirect alla pagina di login di Genesys Cloud */
  app.get('/api/auth/login', async (_req, reply) => {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());

    const url = new URL(`${loginBase}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.GENESYS_LOGIN_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return reply
      .setCookie(STATE_COOKIE, JSON.stringify({ state, verifier }), {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/api/auth',
        maxAge: 600,
        signed: true,
      })
      .redirect(url.toString());
  });

  /** Ritorno da Genesys: scambio del code, lettura dell'utente, emissione della sessione */
  app.get('/api/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth' });

    if (q.error) return fail(reply, `Genesys Cloud: ${q.error_description ?? q.error}`);

    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    if (!unsigned?.valid || !unsigned.value) return fail(reply, 'Sessione di login scaduta, riprova');
    const saved = JSON.parse(unsigned.value) as { state: string; verifier: string };
    if (!q.code || q.state !== saved.state) return fail(reply, 'Risposta di login non valida, riprova');

    // Scambio del code con il token dell'utente
    const tokenRes = await fetch(`${loginBase}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${config.GENESYS_LOGIN_CLIENT_ID}:${config.GENESYS_LOGIN_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.code,
        redirect_uri: redirectUri,
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenRes.ok) {
      req.log.error({ status: tokenRes.status, body: await tokenRes.text() }, 'Scambio code OAuth fallito');
      return fail(reply, 'Login Genesys non riuscito (scambio del codice). Verificare client ID, secret e redirect URI.');
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // Chi è l'utente (con i ruoli, se serve il controllo)
    // Ruoli sempre letti: servono per accesso, esecuzione e approvazione
    const meRes = await fetch(`${apiBase}/api/v2/users/me?expand=authorization`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) return fail(reply, `Impossibile leggere il profilo Genesys (${meRes.status})`);
    const me = (await meRes.json()) as {
      id: string;
      name: string;
      email?: string;
      username?: string;
      authorization?: { roles?: { name: string }[] };
    };
    const email = (me.email ?? me.username ?? '').toLowerCase();

    if (allowedEmails && !allowedEmails.has(email)) {
      return fail(reply, `L'utente ${email} non è abilitato a questa applicazione`);
    }
    const roles = (me.authorization?.roles ?? []).map((r) => r.name.toLowerCase());
    if (config.GENESYS_LOGIN_REQUIRED_ROLE && !roles.includes(config.GENESYS_LOGIN_REQUIRED_ROLE.toLowerCase())) {
      return fail(reply, `Serve il ruolo Genesys "${config.GENESYS_LOGIN_REQUIRED_ROLE}" per usare questa applicazione`);
    }

    const user: SessionUser = {
      sub: email,
      name: me.name,
      genesysUserId: me.id,
      canApply: grants(config.GENESYS_APPLY_ROLE, applyEmails, roles, email),
      canApprove: grants(config.GENESYS_APPROVER_ROLE, approverEmails, roles, email),
    };
    req.log.info({ user: email, canApply: user.canApply, canApprove: user.canApprove }, 'Login');
    const token = app.jwt.sign(user, { expiresIn: `${SESSION_HOURS}h` });
    return reply
      .setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_HOURS * 3600 })
      .redirect(`${config.APP_URL}/`);
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const u = req.user as SessionUser;
    return {
      username: u.sub,
      name: u.name,
      org: config.GENESYS_LOGIN_REGION,
      // Sessioni create prima dell'introduzione dei permessi: nessun permesso finché non si rifà il login
      canApply: u.canApply === true,
      canApprove: u.canApprove === true,
    };
  });
}
