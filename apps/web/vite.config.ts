import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // In sviluppo le chiamate /api vanno al backend: stesso origin, il cookie di sessione funziona senza CORS
    proxy: { '/api': 'http://localhost:3000' },
  },
});
