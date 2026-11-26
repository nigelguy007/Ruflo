import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.SWITCHYARD_API ?? 'http://127.0.0.1:4310';

// Two pages from one root: the public landing page (/) and the console (/app/).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, 'src/web/index.html'),
        app: resolve(import.meta.dirname, 'src/web/app/index.html'),
      },
    },
  },
});
