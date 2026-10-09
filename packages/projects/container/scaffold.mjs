// Making a project (docs/phase8b-plan.md "New project"), inside the build container:
//   node /lfdln/scaffold.mjs <kind> <ts|js> <tailwind|plain> <npm|pnpm> <name> <by>
// /work: an empty folder for it; /repo: an empty folder for its bare repository. The
// starter tool of its kind (create-vite, create-next-app, always the latest), Tailwind if
// asked, its packages installed once for the lockfile, then the first commit on main, pushed
// to /repo. Answers {"commit": "..."}.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer, main, out, run } from './common.mjs';

const VITE = { react: 'react', vue: 'vue', svelte: 'svelte', lit: 'lit' };
// each Vite template's plugin, and the CSS file its page loads (checked 2026-10-05)
const PLUGIN = {
  react: ["import react from '@vitejs/plugin-react'", 'react()'],
  vue: ["import vue from '@vitejs/plugin-vue'", 'vue()'],
  svelte: ["import { svelte } from '@sveltejs/vite-plugin-svelte'", 'svelte()'],
  lit: null,
};
const CSS = { react: 'src/index.css', vue: 'src/style.css', svelte: 'src/app.css', lit: 'src/index.css' };

main(async () => {
  const [kind, lang, style, pm, name, by] = process.argv.slice(2);
  const ts = lang === 'ts';
  const tailwind = style === 'tailwind';
  if (!/^[a-z][a-z0-9-]{0,36}$/.test(name ?? '') || !['npm', 'pnpm'].includes(pm)) throw new Error('bad arguments');
  const app = '/work/app';

  if (VITE[kind]) {
    run('npx', ['--yes', 'create-vite@latest', 'app', '--template', `${VITE[kind]}${ts ? '-ts' : ''}`, '--no-interactive'], '/work');
  } else if (kind === 'next' || kind === 'next-static') {
    run('npx', ['--yes', 'create-next-app@latest', 'app', ts ? '--ts' : '--js', tailwind ? '--tailwind' : '--no-tailwind', '--eslint', '--app',
      '--no-src-dir', '--no-react-compiler', '--import-alias', '@/*', pm === 'pnpm' ? '--use-pnpm' : '--use-npm', '--disable-git', '--skip-install', '--yes'], '/work');
  } else {
    throw new Error(`${kind} projects aren't made yet`);
  }

  const pkgFile = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.name = name;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);

  // a static export: HTML files in out/, pictures as they are (no image server); a server
  // (8b-4): standalone, the server and only the packages it uses, for its container
  if (kind === 'next-static' || kind === 'next') {
    const options = kind === 'next' ? "  output: 'standalone',\n" : "  output: 'export',\n  images: { unoptimized: true },\n";
    writeFileSync(join(app, ts ? 'next.config.ts' : 'next.config.mjs'), ts
      ? `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {\n${options}};\n\nexport default nextConfig;\n`
      : `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n${options}};\n\nexport default nextConfig;\n`);
  }

  run(pm, ['install'], app);

  if (VITE[kind] && tailwind) {
    run(pm, [pm === 'pnpm' ? 'add' : 'install', '-D', 'tailwindcss', '@tailwindcss/vite'], app);
    const plugin = PLUGIN[kind];
    const lines = [...(plugin ? [plugin[0]] : []), "import tailwindcss from '@tailwindcss/vite'", "import { defineConfig } from 'vite'", '',
      '// https://vite.dev/config/', 'export default defineConfig({', `  plugins: [${[...(plugin ? [plugin[1]] : []), 'tailwindcss()'].join(', ')}],`, '})', ''];
    writeFileSync(join(app, `vite.config.${ts ? 'ts' : 'js'}`), lines.join('\n'));
    const css = join(app, CSS[kind]);
    writeFileSync(css, `@import "tailwindcss";\n\n${readFileSync(css, 'utf8')}`);
    console.log(`Tailwind: vite.config.${ts ? 'ts' : 'js'} and ${CSS[kind]}`);
  }

  const who = ['-c', `user.name=${by}`, '-c', `user.email=${by}@panel.lesfleursdelanuit.com`];
  run('git', ['init', '-q', '-b', 'main'], app);
  run('git', ['add', '-A'], app);
  run('git', [...who, 'commit', '-q', '-m', `Made by the panel: ${kind}, ${ts ? 'TypeScript' : 'JavaScript'}${tailwind ? ', Tailwind' : ''}, ${pm}`], app);
  run('git', ['init', '-q', '--bare', '-b', 'main', '/repo'], '/work');
  run('git', ['push', '-q', '/repo', 'main'], app);
  answer({ commit: out('git', ['rev-parse', 'HEAD'], app) });
});
