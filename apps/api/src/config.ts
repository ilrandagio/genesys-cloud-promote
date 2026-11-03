import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve avere almeno 32 caratteri'),
  /// Chiave a 32 byte in base64 per cifrare i client secret degli ambienti
  ENCRYPTION_KEY: z.string(),
  /// Utenti locali: "utente:bcryptHash,utente2:bcryptHash". Da sostituire con OIDC in produzione.
  APP_USERS: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /// Cartella di lavoro per gli export Terraform
  WORK_DIR: z.string().default('/tmp/gc-promote'),
  TERRAFORM_BIN: z.string().default('terraform'),
  /// Versione del provider genesyscloud usata per export e apply
  GENESYS_PROVIDER_VERSION: z.string().default('>= 1.50.0'),
});

export const config = schema.parse(process.env);
