// Building a branch (docs/phase8b-plan.md "A build"), inside the build container:
//   node /lfdln/build.mjs <branch> <release id> <kind>
// /repo: the bare repository (read here, never written); /build: an empty folder; /out: the
// branch's releases folder (a server's: a folder in the build folder, made into its image
// after). The branch is checked out, its packages installed from its lockfile, `build` run,
// and the output (dist/, or out/ for a Next.js export) copied to /out/<release id>. A
// Next.js server (8b-4): .next/standalone, with .next/static and public/ beside server.js
// and the container's health check. Answers {"commit", "files", "bytes"}.
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { answer, main, out, pmOf, run } from './common.mjs';

const count = (dir) => {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { files++; bytes += statSync(join(e.parentPath, e.name)).size; }
  }
  return { files, bytes };
};

main(async () => {
  const [branch, id, kind] = process.argv.slice(2);
  if (!['main', 'dev'].includes(branch) || !/^[0-9]{14}$/.test(id ?? '')) throw new Error('bad arguments');
  const src = '/build/src';
  run('git', ['clone', '-q', '--depth', '1', '--branch', branch, 'file:///repo', src], '/build');
  const commit = out('git', ['rev-parse', 'HEAD'], src);
  console.log(`commit ${commit}`);
  const pm = pmOf(src);
  if (pm === 'pnpm') run('pnpm', ['install', '--frozen-lockfile'], src);
  else run('npm', existsSync(join(src, 'package-lock.json')) ? ['ci'] : ['install'], src);
  run(pm, ['run', 'build'], src);

  const partial = `/out/.${id}.partial`;
  rmSync(partial, { recursive: true, force: true });
  if (kind === 'next') {
    const standalone = join(src, '.next', 'standalone');
    if (!existsSync(join(standalone, 'server.js'))) throw new Error("the build made no .next/standalone/server.js (is output: 'standalone' in next.config?)");
    // (pnpm's node_modules are links: kept as they are, relative, never made absolute paths
    // into this build folder)
    cpSync(standalone, partial, { recursive: true, verbatimSymlinks: true });
    if (existsSync(join(src, '.next', 'static'))) cpSync(join(src, '.next', 'static'), join(partial, '.next', 'static'), { recursive: true });
    if (existsSync(join(src, 'public'))) cpSync(join(src, 'public'), join(partial, 'public'), { recursive: true });
    cpSync('/lfdln/health.mjs', join(partial, '.lfdln-health.mjs'));
  } else {
    const made = join(src, kind.startsWith('next') ? 'out' : 'dist');
    if (!existsSync(join(made, 'index.html'))) throw new Error(`the build made no ${kind.startsWith('next') ? 'out' : 'dist'}/index.html`);
    cpSync(made, partial, { recursive: true });
  }
  renameSync(partial, `/out/${id}`);
  const c = count(`/out/${id}`);
  console.log(`release ${id}: ${c.files} files, ${c.bytes} bytes`);
  answer({ commit, ...c });
});
