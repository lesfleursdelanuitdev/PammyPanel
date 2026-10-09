import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The pammy.org widgets (<pammy-login>, <pammy-form>, <pammy-comments>): each built into one
// plain script in panel/public-gate, Lit and all, which the gate serves as /_pammy/<name>.js.
// Her pages load them with a plain <script defer>, so no modules, no imports.
// The source is in the package the widget belongs to (packages/<package>/widgets/<name>.ts).
//   PAMMY_COMPONENT=login npx vite build -c sites/pammy/widgets/vite.config.ts   (build.sh does all three)
const WIDGETS: Record<string, string> = { login: 'areas', forms: 'forms', comments: 'comments' };
const name = process.env.PAMMY_COMPONENT ?? '';
const pkg = WIDGETS[name];
if (!pkg) throw new Error(`PAMMY_COMPONENT must be one of ${Object.keys(WIDGETS).join(', ')}`);
const packages = fileURLToPath(new URL('../../../packages', import.meta.url));
const entry = `${packages}/${pkg}/widgets/${name}.ts`;
// The source's opening comment is the reference for her guides: it goes on top of what's served.
const source = readFileSync(entry, 'utf8');
const header = source.slice(0, source.search(/^(?!\/\/)/m));
const banner = `${header}//\n// BUILT FILE: made by build.sh from packages/${pkg}/widgets/${name}.ts. Edit that, not this.\n`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  logLevel: 'warn',
  // a widget imports another package's widgets as @panel/<name>/widgets/<file>.ts
  resolve: { alias: [{ find: /^@panel\/([a-z-]+)\/widgets\//, replacement: `${packages}/$1/widgets/` }] },
  build: {
    outDir: fileURLToPath(new URL('../../../public-gate', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    lib: { entry, formats: ['iife'], name: `pammy_${name}`, fileName: () => `${name}.js` },
    rollupOptions: { output: { postBanner: banner } },   // post: after minifying, which drops comments
  },
});
