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
    const child = spawn(config.TERRAFORM_BIN, [...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TF_IN_AUTOMATION: '1',
        TF_PLUGIN_CACHE_DIR: process.env.TF_PLUGIN_CACHE_DIR ?? '',
        GENESYSCLOUD_OAUTHCLIENT_ID: creds.clientId,
        GENESYSCLOUD_OAUTHCLIENT_SECRET: creds.clientSecret,
        GENESYSCLOUD_REGION: creds.region,
        HTTPS_PROXY: process.env.HTTPS_PROXY ?? '',
        NO_PROXY: process.env.NO_PROXY ?? '',
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
    child.on('error', reject);
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
