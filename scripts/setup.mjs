// Crea il file .env per l'uso in locale, con segreti generati e il primo utente.
// Uso:  npm run setup -- <utente> <password>      (utente predefinito: admin)
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

const force = process.argv.includes('--force');
const args = process.argv.slice(2).filter((a) => a !== '--force');
const [user, password] = args.length >= 2 ? args : ['admin', args[0]];

if (!password) {
  console.error('Uso: npm run setup -- <utente> <password>   oppure   npm run setup -- <password>');
  process.exit(1);
}
if (existsSync(envPath) && !force) {
  console.error('Il file .env esiste già. Per rigenerarlo aggiungi --force (gli ambienti salvati andranno reinseriti).');
  process.exit(1);
}

const content = `# Generato da "npm run setup" il ${new Date().toISOString()}
# Modalità locale: senza DATABASE_URL e REDIS_URL l'app usa un database integrato
# (cartella data/) e una coda interna. Servono solo Node.js e Terraform.

JWT_SECRET=${randomBytes(32).toString('hex')}

# Cifra i client secret degli ambienti. Se la cambi o la perdi, vanno reinseriti.
ENCRYPTION_KEY=${randomBytes(32).toString('base64')}

# Aggiungere utenti con: npm run hash-password -w apps/api -- "password"
APP_USERS='${user}:${bcrypt.hashSync(password, 10)}'

# Per usare PostgreSQL e Redis veri (come in Docker) togliere il commento:
# DATABASE_URL=postgres://gcp:gcp@localhost:5432/gcp
# REDIS_URL=redis://localhost:6379

GENESYS_PROVIDER_VERSION=>= 1.50.0
`;

writeFileSync(envPath, content);
console.log(`Creato ${envPath} con l'utente "${user}". Ora: npm run dev  ->  http://localhost:5173`);
