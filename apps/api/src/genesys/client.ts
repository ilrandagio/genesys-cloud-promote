import { decrypt } from '../lib/crypto.js';
import type { Environment } from '../lib/schema.js';

interface Token {
  value: string;
  expiresAt: number;
}

const tokenCache = new Map<string, Token>();

/**
 * Client REST minimale verso la Platform API di una singola org.
 * Un'istanza per ambiente: ogni ambiente usa il proprio OAuth client (client credentials).
 */
export class GenesysClient {
  readonly apiBase: string;
  private readonly loginBase: string;

  constructor(private readonly env: Pick<Environment, 'id' | 'name' | 'region' | 'clientId' | 'clientSecretEncrypted'>) {
    this.apiBase = `https://api.${env.region}`;
    this.loginBase = `https://login.${env.region}`;
  }

  /** Credenziali in chiaro, usate solo per passarle a Terraform nel worker */
  credentials() {
    return { clientId: this.env.clientId, clientSecret: decrypt(this.env.clientSecretEncrypted) };
  }

  private async token(): Promise<string> {
    const cached = tokenCache.get(this.env.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

    const { clientId, clientSecret } = this.credentials();
    const res = await fetch(`${this.loginBase}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(
        `Ambiente "${this.env.name}": login dell'OAuth client ${this.env.clientId} fallito (${res.status}). ` +
          `Verificare client ID, secret e regione. Dettaglio: ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache.set(this.env.id, { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
    return body.access_token;
  }

  async get<T = any>(path: string, attempt = 0): Promise<T> {
    const res = await fetch(this.apiBase + path, {
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' },
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.get(path, attempt + 1);
    }
    if (res.status === 404) throw new NotFoundError(path);
    if (res.status === 403) throw new PermissionError(this.env, path, await res.text());
    if (!res.ok) throw new Error(`Ambiente "${this.env.name}": GET ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** Scorre tutte le pagine di un endpoint a paginazione pageNumber/pageSize */
  async listAll<T = any>(path: string, extraQuery = ''): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const body = await this.get<{ entities?: T[]; pageCount?: number }>(
        `${path}${sep}pageSize=100&pageNumber=${page}${extraQuery}`,
      );
      out.push(...(body.entities ?? []));
      if (!body.pageCount || page >= body.pageCount) break;
    }
    return out;
  }

  /** Verifica rapida delle credenziali: restituisce il nome dell'org */
  async whoAmI(): Promise<string> {
    const org = await this.get<{ name: string }>('/api/v2/organizations/me');
    return org.name;
  }
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`Non trovato: ${path}`);
  }
}

/**
 * 403 della Platform API, con un messaggio che dice quale ambiente e quale OAuth client
 * non hanno il permesso, e in quali divisioni.
 */
export class PermissionError extends Error {
  readonly statusCode = 403;
  constructor(env: Pick<Environment, 'name' | 'clientId'>, path: string, body: string) {
    let detail = '';
    try {
      const b = JSON.parse(body) as { messageParams?: { permission?: string; divisions?: string }; message?: string };
      const perm = b.messageParams?.permission;
      const divs = b.messageParams?.divisions?.replace(/\([0-9a-f-]{36}\)/gi, '').replace(/^\[|\]$/g, '');
      detail = perm
        ? `manca il permesso '${perm}'${divs ? ` nella divisione ${divs}` : ''}`
        : `mancano i permessi necessari (${b.message ?? body})`;
    } catch {
      detail = `mancano i permessi necessari (${body})`;
    }
    super(
      `Ambiente "${env.name}": all'OAuth client ${env.clientId} ${detail}. ` +
        `Aggiungere il permesso o la divisione al ruolo del client (Admin > OAuth > Roles). [GET ${path}]`,
    );
  }
}
