import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { siteFacts } from '@panel/core/profile';
import type { Site } from '@panel/core/web/lib/site';
import { PROFILE } from '@panel/lfdln/profile';

// lfdln's pages (docs/lfdln-standup-plan.md L1): built into public-lfdln/, which build.sh
// puts in release-lfdln/ as its public/. The server swaps PAMMY_NONCE for a fresh value
// on every page it sends, as pammy.org's does (@panel/files/panel/routes/pages).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss(), {
    // index.html's %PANEL_NAME%: the title, and the words when JavaScript is off
    name: 'panel-name',
    transformIndexHtml: (html) => html.replaceAll('%PANEL_NAME%', PROFILE.panelName),
  }],
  resolve: { alias: [{ find: /^@panel\/([a-z-]+)\/web\//, replacement: `${fileURLToPath(new URL('../../../packages', import.meta.url))}/$1/web/` }] },
  define: { __PANEL_SITE__: JSON.stringify(siteFacts(PROFILE) satisfies Site) },
  html: { cspNonce: 'PAMMY_NONCE' },
  build: {
    outDir: process.env.PANEL_WEB_OUT ?? fileURLToPath(new URL('../../../public-lfdln', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  // npm run web:dev:lfdln, with lfdln's panel itself running on :3046
  server: { proxy: { '/api': 'http://127.0.0.1:3046' } },
});
