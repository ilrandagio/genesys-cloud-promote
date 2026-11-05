import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * Con DATABASE_URL: PostgreSQL vero (Docker / produzione).
 * Senza: PGlite, Postgres integrato salvato in DATA_DIR (modalità locale, un solo processo).
 * Le due istanze espongono la stessa API Drizzle.
 */
export const usingPglite = !config.DATABASE_URL;

function create() {
  if (config.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
    return { db: drizzlePg(pool, { schema }), pglite: undefined };
  }
  const dir = path.join(config.DATA_DIR, 'pglite');
  mkdirSync(dir, { recursive: true });
  const pglite = new PGlite(dir);
  return { db: drizzlePglite(pglite, { schema }) as unknown as NodePgDatabase<typeof schema>, pglite };
}

const created = create();
export const db = created.db;
export { schema };

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function migrateDb() {
  if (created.pglite) {
    try {
      await migratePglite(drizzlePglite(created.pglite), { migrationsFolder });
    } catch (e) {
      throw new Error(
        `Il database locale in ${path.join(config.DATA_DIR, 'pglite')} non si apre, probabilmente è danneggiato ` +
          `(l'applicazione è stata chiusa in modo brusco). Spostare o cancellare la cartella per ripartire, ` +
          `oppure usare PostgreSQL (DATABASE_URL) per dati che devono durare. Dettaglio: ${(e as Error).message}`,
      );
    }
  } else {
    await migratePg(db, { migrationsFolder });
  }
}

/** Chiusura ordinata: con PGlite è indispensabile per non lasciare il database su disco danneggiato */
export async function closeDb() {
  if (created.pglite) await created.pglite.close();
}
