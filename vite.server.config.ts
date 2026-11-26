import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Bundles the Node server into dist/server/index.js; node_modules stay external.
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/server/index.ts'),
    outDir: resolve(import.meta.dirname, 'dist/server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'index.js', format: 'esm' } },
  },
});
