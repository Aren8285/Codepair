import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const SERVER_HOST = process.env.CODE_PAIR_HOST_URL ?? 'http://localhost:7420';

// Enable HTTPS so that browsers grant secure-context APIs (getUserMedia,
// getDisplayMedia) when the page is opened via a LAN IP instead of localhost.
// Set CODE_PAIR_NO_SSL=1 to disable if you only use localhost.
const useSSL = !process.env.CODE_PAIR_NO_SSL;

export default defineConfig({
  plugins: [react(), ...(useSSL ? [basicSsl()] : [])],
  server: {
    port: 5180,
    host: true,
    strictPort: true,
    ...(useSSL ? { https: {} } : {}),
    proxy: {
      '/api': { target: SERVER_HOST, changeOrigin: false },
      '/ws': { target: SERVER_HOST.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // Guest workspace and the loopback Host console are separate pages; the
    // admin listener serves host.html from the same build.
    rollupOptions: {
      input: {
        main: 'index.html',
        host: 'host.html',
      },
    },
  },
  worker: {
    format: 'es',
  },
});
