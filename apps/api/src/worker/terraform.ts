import { spawn } from 'node:child_process';
import { config } from '../config.js';

export interface TfCreds {
  clientId: string;
  clientSecret: string;
  region: string; // regione AWS, es. eu-central-1
}

/** Esegue terraform con le credenziali dell'org indicata, inoltrando l'output riga per riga. */
export function terraform(
  args: string[],
  cwd: string,
  creds: TfCreds,
  onLine: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // Ambiente del processo (serve su Windows: SystemRoot, APPDATA, TEMP, proxy...) senza i segreti dell'app
    const { JWT_SECRET, ENCRYPTION_KEY, APP_USERS, DATABASE_URL, REDIS_URL, ...baseEnv } = process.env;
    const child = spawn(config.TERRAFORM_BIN, [...args], {
      cwd,
      env: {
        ...baseEnv,
        TF_IN_AUTOMATION: '1',
        GENESYSCLOUD_OAUTHCLIENT_ID: creds.clientId,
        GENESYSCLOUD_OAUTHCLIENT_SECRET: creds.clientSecret,
        GENESYSCLOUD_REGION: creds.region,
      },
    });
    let output = '';
    let partial = '';
    const handle = (chunk: Buffer) => {
      const text = partial + chunk.toString();
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) {
        output += l + '\n';
        onLine(l);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        e.code === 'ENOENT'
          ? new Error(`Terraform non trovato ("${config.TERRAFORM_BIN}"): installalo e mettilo nel PATH, oppure imposta TERRAFORM_BIN nel .env`)
          : e,
      ),
    );
    child.on('close', (code) => {
      if (partial) {
        output += partial;
        onLine(partial);
      }
      resolve({ code: code ?? 1, output });
    });
  });
}

export async function tfOrThrow(...params: Parameters<typeof terraform>) {
  const res = await terraform(...params);
  if (res.code !== 0) throw new Error(`terraform ${params[0].join(' ')} terminato con codice ${res.code}`);
  return res;
}
