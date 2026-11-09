import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Hybrid architecture: `npm run dev` for the cloud-connected dev app,
// `npm run build` produces ONE self-contained HTML file (offline export,
// no cloud features baked in beyond whatever is in .env at build time).
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['.e2b.app'],
    proxy: { '/api': 'http://localhost:4100' }   // Express API (npm run api)
  },
  build: {
    target: 'es2019',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});
