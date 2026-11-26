import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { REGIONS } from '../genesys/regions.js';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';

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

/** Org in cui fare login: quella predefinita (.env) o un ambiente con un client di login configurato */
interface LoginOrg {
  envId?: string;
  region: string;
  clientId: string;
  clientSecret: string;
}

/** Nome dell'org di login predefinita: noto dal primo login dopo l'avvio (prima si mostra la regione) */
let defaultOrgName: string | undefined;

async function loginOrg(envId?: string): Promise<LoginOrg | undefined> {
  if (!envId) {
    return { region: config.GENESYS_LOGIN_REGION, clientId: config.GENESYS_LOGIN_CLIENT_ID, clientSecret: config.GENESYS_LOGIN_CLIENT_SECRET };
  }
  const [env] = await db.select().from(schema.environments).where(eq(schema.environments.id, envId));
  if (!env?.loginClientId || !env.loginClientSecretEncrypted) return undefined;
  return { envId, region: env.region, clientId: env.loginClientId, clientSecret: decrypt(env.loginClientSecretEncrypted) };
}
const redirectUri = `${config.APP_URL.replace(/\/$/, '')}/api/auth/callback`;
const secure = config.APP_URL.startsWith('https://');
/**
 * Percorso con cui il browser vede l'app (es. "/promote" se pubblicata dietro un altro server, "" alla radice):
 * i cookie devono usarlo, altrimenti il browser non li rimanda.
 */
const basePath = new URL(config.APP_URL).pathname.replace(/\/+$/, '');
const STATE_PATH = `${basePath}/api/auth`;
const SESSION_PATH = `${basePath}/`;
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
  /** Org Genesys in cui è stato fatto il login (nome e regione) */
  org?: string;
  orgRegion?: string;
  /** Ambiente dell'org di login (assente = org di login predefinita) */
  envId?: string;
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
  /** Org in cui si può fare login: la predefinita e gli ambienti con un client di login (anche dalla pagina di login) */
  app.get('/api/auth/orgs', async () => {
    const envs = await db
      .select({ id: schema.environments.id, name: schema.environments.name, region: schema.environments.region })
      .from(schema.environments)
      .where(isNotNull(schema.environments.loginClientId))
      .orderBy(asc(schema.environments.name));
    const main = { envId: '', name: defaultOrgName ?? `Org di login predefinita (${config.GENESYS_LOGIN_REGION})`, region: config.GENESYS_LOGIN_REGION };
    // Un ambiente sulla stessa org di quella predefinita non si ripete
    const others = envs.filter((e) => !(defaultOrgName && e.name.toLowerCase() === defaultOrgName.toLowerCase() && e.region === main.region));
    return [main, ...others.map((e) => ({ envId: e.id, name: e.name, region: e.region }))];
  });

  /** Avvia il login: redirect alla pagina di login di Genesys Cloud (?env=<id> per l'org di un ambiente) */
  app.get('/api/auth/login', async (req, reply) => {
    const raw = (req.query as { env?: string }).env;
    const envId = raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : undefined;
    if (raw && !envId) return fail(reply, 'Org non valida');
    const org = await loginOrg(envId);
    if (!org) return fail(reply, "Login non configurato per l'org scelta");
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());

    const url = new URL(`https://login.${org.region}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', org.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return reply
      .setCookie(STATE_COOKIE, JSON.stringify({ state, verifier, envId }), {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: STATE_PATH,
        maxAge: 600,
        signed: true,
      })
      .redirect(url.toString());
  });

  /** Ritorno da Genesys: scambio del code, lettura dell'utente, emissione della sessione */
  app.get('/api/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    reply.clearCookie(STATE_COOKIE, { path: STATE_PATH });

    if (q.error) return fail(reply, `Genesys Cloud: ${q.error_description ?? q.error}`);

    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    if (!unsigned?.valid || !unsigned.value) return fail(reply, 'Sessione di login scaduta, riprova');
    const saved = JSON.parse(unsigned.value) as { state: string; verifier: string; envId?: string };
    if (!q.code || q.state !== saved.state) return fail(reply, 'Risposta di login non valida, riprova');
    const org = await loginOrg(saved.envId);
    if (!org) return fail(reply, "Login non più configurato per l'org scelta");
    const loginBase = `https://login.${org.region}`;
    const apiBase = `https://api.${org.region}`;

    // Scambio del code con il token dell'utente
    const tokenRes = await fetch(`${loginBase}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${org.clientId}:${org.clientSecret}`).toString('base64'),
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

    // Nome dell'org in cui si è entrati: mostrato nell'intestazione
    const orgName = await fetch(`${apiBase}/api/v2/organizations/me`, { headers: { Authorization: `Bearer ${access_token}` } })
      .then(async (r) => (r.ok ? ((await r.json()) as { thirdPartyOrgName?: string; name?: string }) : undefined))
      .then((o) => o?.thirdPartyOrgName ?? o?.name)
      .catch(() => undefined);
    if (orgName && !org.envId) defaultOrgName = orgName;

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
      org: orgName ?? org.region,
      orgRegion: org.region,
      envId: org.envId,
    };
    req.log.info({ user: email, org: user.org, canApply: user.canApply, canApprove: user.canApprove }, 'Login');
    const token = app.jwt.sign(user, { expiresIn: `${SESSION_HOURS}h` });
    return reply
      .setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: SESSION_PATH, maxAge: SESSION_HOURS * 3600 })
      .redirect(`${config.APP_URL}/`);
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: SESSION_PATH }).send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const u = req.user as SessionUser;
    return {
      username: u.sub,
      name: u.name,
      org: u.org ?? config.GENESYS_LOGIN_REGION,
      orgRegion: u.orgRegion ?? config.GENESYS_LOGIN_REGION,
      envId: u.envId ?? '',
      // Sessioni create prima dell'introduzione dei permessi: nessun permesso finché non si rifà il login
      canApply: u.canApply === true,
      canApprove: u.canApprove === true,
    };
  });
}
