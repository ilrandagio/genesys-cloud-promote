import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decrypt, encrypt } from '../lib/crypto.js';

/**
 * Artefatto di un plan: la cartella di lavoro Terraform completa (configurazione esportata, file di script
 * e flow, state con gli import, file di piano, lock dei provider) più i metadati del target.
 * È ciò che viene applicato all'esecuzione, senza riesportare nulla dal sorgente.
 * Viene salvato cifrato perché può contenere secret (variabili dell'export, state).
 */
export interface PlanArtifact {
  version: 1;
  /** Identità del target al momento del plan: all'esecuzione deve coincidere */
  target: { envId: string; name: string; region: string; clientId: string };
  /** Nome del file di piano nella cartella */
  planFile: string;
  /** Percorso relativo (con "/") -> contenuto in base64 */
  files: Record<string, string>;
}

/** Cartelle escluse: i provider vengono riscaricati con le stesse versioni grazie a .terraform.lock.hcl */
const EXCLUDED_DIRS = new Set(['.terraform']);

async function collect(dir: string, base = dir, out: Record<string, string> = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) await collect(full, base, out);
    } else if (entry.isFile()) {
      out[path.relative(base, full).split(path.sep).join('/')] = (await readFile(full)).toString('base64');
    }
  }
  return out;
}

export async function packArtifact(dir: string, meta: Omit<PlanArtifact, 'files' | 'version'>): Promise<string> {
  const artifact: PlanArtifact = { version: 1, ...meta, files: await collect(dir) };
  return encrypt(JSON.stringify(artifact));
}

/** Ricrea la cartella di lavoro del plan in "dir" e restituisce l'artefatto */
export async function unpackArtifact(encrypted: string, dir: string): Promise<PlanArtifact> {
  const artifact = JSON.parse(decrypt(encrypted)) as PlanArtifact;
  if (artifact.version !== 1) throw new Error(`Versione dell'artefatto non supportata: ${artifact.version}`);
  for (const [rel, b64] of Object.entries(artifact.files)) {
    // Nessun percorso fuori dalla cartella di lavoro
    const full = path.resolve(dir, ...rel.split('/'));
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Percorso non valido nell'artefatto: ${rel}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(b64, 'base64'));
  }
  return artifact;
}
