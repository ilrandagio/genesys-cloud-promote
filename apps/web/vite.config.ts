import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Percorso dell'app quando è pubblicata sotto un prefisso dietro un altro server (es. "/promote/").
 * Il proxy davanti toglie il prefisso: l'app riceve sempre /api/... e /assets/...
 */
const base = `/${(process.env.VITE_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // In sviluppo le chiamate /api vanno al backend: stesso origin, il cookie di sessione funziona senza CORS
    proxy: { '/api': 'http://localhost:3000' },
  },
});
