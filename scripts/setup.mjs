// Crea il file .env per l'uso in locale, con i segreti generati e la configurazione del login Genesys.
//
// Uso:
//   npm run setup -- --region mypurecloud.de --client-id <id> --client-secret <secret>
//
// Il client OAuth va creato nell'org Genesys usata per il login:
//   Admin > Integrations > OAuth > Add Client, Grant Type "Code Authorization",
//   Authorized redirect URI: http://localhost:5173/api/auth/callback
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (existsSync(envPath) && !argv.includes('--force')) {
  console.error('Il file .env esiste già. Per rigenerarlo aggiungi --force (gli ambienti salvati andranno reinseriti).');
  process.exit(1);
}

const region = flag('region') ?? '';
const clientId = flag('client-id') ?? '';
const clientSecret = flag('client-secret') ?? '';
const appUrl = flag('app-url') ?? 'http://localhost:5173';

const content = `# Generato da "npm run setup" il ${new Date().toISOString()}
# Modalità locale: senza DATABASE_URL e REDIS_URL l'app usa un database integrato
# (cartella data/) e una coda interna. Servono solo Node.js e Terraform.

JWT_SECRET=${randomBytes(32).toString('hex')}

# Cifra i client secret degli ambienti. Se la cambi o la perdi, vanno reinseriti.
ENCRYPTION_KEY=${randomBytes(32).toString('base64')}

# URL dell'interfaccia. Il redirect URI da registrare nel client OAuth è APP_URL/api/auth/callback
APP_URL=${appUrl}

# ---- Login con Genesys Cloud ----
# OAuth client di tipo "Code Authorization" nell'org usata per il login
GENESYS_LOGIN_REGION=${region}
GENESYS_LOGIN_CLIENT_ID=${clientId}
GENESYS_LOGIN_CLIENT_SECRET=${clientSecret}
# Facoltativi: limitare l'accesso a un ruolo Genesys e/o a un elenco di email
GENESYS_LOGIN_REQUIRED_ROLE=
APP_ALLOWED_EMAILS=

# Per usare PostgreSQL e Redis veri (come in Docker) valorizzare:
DATABASE_URL=
REDIS_URL=

GENESYS_PROVIDER_VERSION=>= 1.50.0
`;

writeFileSync(envPath, content);
console.log(`Creato ${envPath}`);
if (!region || !clientId || !clientSecret) {
  console.log('Completa GENESYS_LOGIN_REGION, GENESYS_LOGIN_CLIENT_ID e GENESYS_LOGIN_CLIENT_SECRET nel .env prima di avviare.');
}
console.log(`Redirect URI da registrare nel client OAuth Genesys: ${appUrl}/api/auth/callback`);
console.log('Poi: npm run dev  ->  ' + appUrl);
