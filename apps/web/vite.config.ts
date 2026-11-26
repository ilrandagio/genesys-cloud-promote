import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

/**
 * Percorso dell'app quando è pubblicata sotto un prefisso dietro un altro server (es. "/promote/").
 * Il proxy davanti toglie il prefisso: l'app riceve sempre /api/... e /assets/...
 */
const base = `/${(process.env.VITE_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

/** Porta dell'api in sviluppo: API_PORT del .env nella cartella principale (default 3000), la stessa letta dall'api */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiPort = process.env.API_PORT || loadEnv('development', root, '').API_PORT || '3000';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // In sviluppo le chiamate /api vanno al backend: stesso origin, il cookie di sessione funziona senza CORS
    // 127.0.0.1 e non localhost: con Node recenti localhost può diventare l'IPv6 ::1, dove l'API non ascolta
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
