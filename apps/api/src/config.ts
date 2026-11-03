import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Carica il .env dalla radice del repository (o dalla cartella corrente), senza dipendenze esterne.
// Le variabili già presenti nell'ambiente (es. Docker) hanno la precedenza.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(here, '../../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const empty = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  /// Se assente: modalità locale con database integrato (PGlite) in DATA_DIR
  DATABASE_URL: z.preprocess(empty, z.string().optional()),
  /// Se assente: coda interna al processo dell'API (niente worker separato)
  REDIS_URL: z.preprocess(empty, z.string().optional()),
  DATA_DIR: z.string().default(path.resolve(here, '../../../data')),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve avere almeno 32 caratteri (npm run setup lo genera)'),
  /// Chiave a 32 byte in base64 per cifrare i client secret degli ambienti
  ENCRYPTION_KEY: z.string(),
  /// Utenti locali: "utente:bcryptHash,utente2:bcryptHash". Da sostituire con OIDC in produzione.
  APP_USERS: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /// Cartella di lavoro per gli export Terraform
  WORK_DIR: z.string().default(path.join(tmpdir(), 'gc-promote')),
  TERRAFORM_BIN: z.string().default('terraform'),
  /// Versione del provider genesyscloud usata per export e apply
  GENESYS_PROVIDER_VERSION: z.string().default('>= 1.50.0'),
});

export const config = schema.parse(process.env);

/** true quando il worker gira dentro il processo dell'API (nessun Redis configurato) */
export const inProcessWorker = !config.REDIS_URL;
