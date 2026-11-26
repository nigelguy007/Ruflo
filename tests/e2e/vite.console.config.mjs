// Temporary: builds only the console (src/web/app) while the landing page is being written elsewhere.
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repo = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: resolve(repo, 'src/web'),
  plugins: [react()],
  build: {
    outDir: resolve(repo, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: { input: { app: resolve(repo, 'src/web/app/index.html') } },
  },
});
