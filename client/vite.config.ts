import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const HOST = process.env.CODE_PAIR_HOST_URL ?? 'http://localhost:7420';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    host: true,
    strictPort: true,
    proxy: {
      '/api': { target: HOST, changeOrigin: false },
      '/ws': { target: HOST.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: 'es',
  },
});
