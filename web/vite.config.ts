import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true }, '/api': { target: 'http://127.0.0.1:8787' } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
