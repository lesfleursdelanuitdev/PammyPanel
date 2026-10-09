import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { siteFacts, type SiteProfile } from '@panel/core/profile';
import type { Site } from '@panel/core/web/lib/site';
import { PROFILE as PAMMY } from '@panel/pammy/profile';

// PANEL_PROFILE: another profile's file, and PANEL_WEB_OUT: somewhere else to put the pages
// (test/words.test.ts builds them with test/fixtures/lfdln-profile.ts; docs/adapters-plan.md A8)
const PROFILE: SiteProfile = process.env.PANEL_PROFILE
  ? (await import(resolve(process.env.PANEL_PROFILE))).PROFILE : PAMMY;

// The panel's pages: built into panel/public, which the server reads at startup
// (sites/pammy/src/app.ts). The server swaps PAMMY_NONCE for a fresh value on every page
// it sends, and puts the same value in its Content-Security-Policy.
// The pages themselves are in each package's web/ (packages/<name>/web); this site puts
// them together (src/App.tsx, src/menu.ts). They import each other as @panel/<name>/web/...
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss(), {
    // index.html's %PANEL_NAME%: the title, and the words when JavaScript is off
    name: 'panel-name',
    transformIndexHtml: (html) => html.replaceAll('%PANEL_NAME%', PROFILE.panelName),
  }],
  resolve: { alias: [{ find: /^@panel\/([a-z-]+)\/web\//, replacement: `${fileURLToPath(new URL('../../../packages', import.meta.url))}/$1/web/` }] },
  // what the pages say about the website (@panel/core/web/lib/site)
  define: { __PANEL_SITE__: JSON.stringify(siteFacts(PROFILE) satisfies Site) },
  html: { cspNonce: 'PAMMY_NONCE' },
  build: {
    outDir: process.env.PANEL_WEB_OUT ?? fileURLToPath(new URL('../../../public', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,          // no data: fonts or pictures; everything is a file under /assets
    modulePreload: { polyfill: false },
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  // npm run web:dev, with the panel itself running on :3044
  server: { proxy: { '/api': 'http://127.0.0.1:3044' } },
});
