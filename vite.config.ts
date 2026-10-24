import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Static, backend-free bundle. `base: './'` keeps the same output working at a
 * domain root, on a GitHub Pages project path, or in any sub-directory.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5213, host: true },
  preview: { port: 4213, host: true },
});
