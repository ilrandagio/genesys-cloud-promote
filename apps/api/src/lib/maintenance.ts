import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from './db.js';

const j = schema.jobs;

/**
 * Elimina gli artefatti dei plan che non possono più essere eseguiti (scaduti o già eseguiti):
 * contengono configurazione e state, che possono includere secret.
 */
export async function purgeStaleArtifacts(): Promise<number> {
  const rows = await db
    .update(j)
    .set({ artifactEncrypted: null })
    .where(and(eq(j.mode, 'PLAN'), isNotNull(j.artifactEncrypted), or(lt(j.expiresAt, new Date()), isNotNull(j.appliedJobId))))
    .returning({ id: j.id });
  return rows.length;
}

/**
 * Chiude come falliti i job rimasti a metà per un riavvio (worker o applicazione).
 * Un'esecuzione interrotta non viene mai ripresa in automatico: il plan resta consumato
 * e il log indica di verificare il target e rifare la simulazione.
 */
export async function failInterruptedJobs(statuses: ('QUEUED' | 'RUNNING')[]): Promise<number> {
  const rows = await db
    .update(j)
    .set({
      status: 'FAILED',
      finishedAt: new Date(),
      log: sql`${j.log} || ${'[porting] Interrotto dal riavvio dell\'applicazione: verificare lo stato del target e rifare la simulazione\n'}`,
    })
    .where(and(inArray(j.status, statuses), isNull(j.finishedAt)))
    .returning({ id: j.id });
  return rows.length;
}
