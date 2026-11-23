import { spawn } from 'node:child_process';
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { CATALOG } from '../genesys/catalog.js';
import type { ObjectType, PortItem } from '../genesys/types.js';
import { config } from '../config.js';
import { db, schema } from '../lib/db.js';
import { encryptFile } from '../lib/crypto.js';
import { getEnvironment } from '../lib/repo.js';
import type { BackupInfo } from '../lib/schema.js';
import { exportObjects } from './exporter.js';
import { credsOf } from './porting.js';

type JobRow = typeof schema.jobs.$inferSelect;

export const backupDir = () => config.BACKUP_DIR ?? path.join(config.DATA_DIR, 'backups');

/** Archivio .tar.gz di una cartella con il tar di sistema (anche per export molto grandi) */
function tarDir(dir: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-czf', out, '-C', dir, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim() || `codice ${code}`}`))));
  });
}

/**
 * Backup: export in sola lettura degli oggetti scelti di un ambiente (configurazione Terraform, file dei flow,
 * script, audio dei prompt e state con gli ID), archiviato e cifrato su disco. Nessuna scrittura sulle org.
 */
export async function runBackup(
  job: JobRow,
  workDir: string,
  log: { info: (l: string) => void; line: (l: string) => void },
  setJob: (data: Partial<JobRow>) => Promise<unknown>,
) {
  const env = await getEnvironment(job.sourceEnvId);
  const info = job.backup;
  if (!info || (!info.full && !info.selection.length)) throw new Error('Backup senza tipi scelti');

  const items: PortItem[] = [];
  const filters: { type: ObjectType; filter: string }[] = [];
  for (const sel of info.selection) {
    const type = sel.type as ObjectType;
    const def = CATALOG[type];
    if (!def) throw new Error(`Tipo non gestito: ${sel.type}`);
    if (sel.all) filters.push({ type, filter: `${def.tfType}::.*` });
    else {
      for (const o of sel.objects ?? []) {
        items.push({ type, id: o.id, name: o.name, subtype: o.subtype, action: 'port', targetStatus: 'missing' });
      }
    }
  }
  const total = filters.length + items.length;
  log.info(
    info.full
      ? `Backup completo di ${env.name}: tutto ciò che il provider esporta, senza filtri né esclusioni (anche utenti e membri). ` +
          "Sola lettura: nessuna modifica all'org. Su un'org grande richiede tempo."
      : `Backup di ${env.name}: ${info.selection.length} tipi (${filters.length} completi, ${items.length} oggetti scelti singolarmente). ` +
          "Sola lettura: nessuna modifica all'org.",
  );
  if (!info.full && !total) throw new Error('Nessun oggetto da salvare');

  const exportDir = path.join(workDir, 'export');
  const { cfg } = await exportObjects({
    items,
    filters,
    includeState: true,
    wholeOrg: !!info.full,
    runnerDir: path.join(workDir, 'runner'),
    exportDir,
    creds: credsOf(env),
    orgName: env.name,
    line: log.line,
    info: log.info,
  });

  const counts: Record<string, number> = {};
  for (const [type, labels] of Object.entries(cfg.resource ?? {})) counts[type] = Object.keys(labels).length;
  const resources = Object.values(counts).reduce((a, b) => a + b, 0);
  log.info(`Oggetti salvati: ${resources} (${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ') || 'nessuno'})`);
  // Descrizione del backup dentro l'archivio, per chi lo apre fuori dall'applicativo
  await writeFile(
    path.join(exportDir, 'BACKUP.json'),
    JSON.stringify(
      {
        environment: { name: env.name, region: env.region },
        createdAt: job.createdAt.toISOString(),
        createdBy: job.createdBy,
        providerVersion: config.GENESYS_PROVIDER_VERSION,
        full: !!info.full,
        selection: info.selection.map((s) => ({ type: s.type, all: s.all, objects: s.objects?.map((o) => o.name) })),
        counts,
      },
      null,
      2,
    ),
  );

  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const plain = path.join(workDir, 'backup.tar.gz');
  await tarDir(exportDir, plain);
  const size = (await stat(plain)).size;
  const file = `${job.id}.tar.gz.enc`;
  await encryptFile(plain, path.join(dir, file));
  await rm(plain, { force: true });
  log.info(`Archivio cifrato salvato: ${(size / 1024 / 1024).toFixed(1)} MB`);
  await setJob({ backup: { ...info, file, size, counts } });
  await applyRetention(log.info);
}

/** Conserva solo gli ultimi BACKUP_KEEP backup completati: gli archivi più vecchi vengono cancellati */
async function applyRetention(info: (l: string) => void) {
  const done = await db
    .select({ id: schema.jobs.id, backup: schema.jobs.backup })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.mode, 'BACKUP'), eq(schema.jobs.status, 'SUCCEEDED')))
    .orderBy(desc(schema.jobs.createdAt));
  // Il backup appena completato non è ancora SUCCEEDED: conta come uno dei da tenere
  const old = done.filter((j) => j.backup?.file && !j.backup.deleted).slice(Math.max(0, config.BACKUP_KEEP - 1));
  for (const j of old) {
    await unlink(path.join(backupDir(), j.backup!.file!)).catch(() => {});
    await db
      .update(schema.jobs)
      .set({ backup: { ...(j.backup as BackupInfo), deleted: true } })
      .where(eq(schema.jobs.id, j.id));
  }
  if (old.length) info(`Conservazione: cancellati ${old.length} archivi di backup più vecchi (si tengono gli ultimi ${config.BACKUP_KEEP})`);
}
