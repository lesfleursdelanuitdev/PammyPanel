// Public entries (docs/master-plan.md rule 2, step C1): each package's package.json lists the
// files others may import ("exports"), not "./*", so what a package shows is written down and
// a new one shows in review. At C1 the list is what the code already imports from outside
// each package; it is meant to shrink as modules get one public entry each (K-b on).
//
//   node tools/coupling/entries.ts           write each package.json's exports from the code
//   node tools/coupling/entries.ts --check   exit 1 when they differ (test/boundaries.test.ts does the same)
//
// The pages (web/) and widgets (widgets/) aren't here: vite and their tsconfig find those by
// path, never through exports.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// Every file that may name a package's entry: code, tests, tools, the units and scripts
const SCAN = ['packages', 'sites', 'test', 'tools', 'deploy', 'db', 'src', 'build.sh'];
const SKIP = new Set(['node_modules', 'public', 'public-gate', 'release', 'release-lfdln', 'test-results', 'migrations']);
// imported with a name made at run time (tools/render-nginx.ts: `@panel/${site}/...`)
const BY_TEMPLATE: Record<string, string[]> = { lfdln: ['nginx', 'profile'], pammy: ['nginx', 'profile'] };

function files(rel: string): string[] {
  let entries;
  try { entries = readdirSync(join(ROOT, rel), { withFileTypes: true }); } catch { return existsSync(join(ROOT, rel)) ? [rel] : []; }
  return entries.flatMap((e) => SKIP.has(e.name) ? [] : e.isDirectory() ? files(join(rel, e.name)) : [join(rel, e.name)]);
}

const NAME = /@panel\/([a-z-]+)\/([A-Za-z0-9_./-]+?)(?:\.ts)?(?=['"`\s)]|$)/gm;

// package -> the entries named by name (a site's own vite.config.ts names its profile so, too)
export function usedEntries(root = ROOT): Map<string, Set<string>> {
  const pkgDirs = new Map<string, string>([
    ...readdirSync(join(root, 'packages')).map((n) => [n, `packages/${n}`] as const),
    ...readdirSync(join(root, 'sites')).map((n) => [n, `sites/${n}`] as const),
  ]);
  const used = new Map<string, Set<string>>([...pkgDirs.keys()].map((n) => [n, new Set<string>()]));
  for (const [site, names] of Object.entries(BY_TEMPLATE)) for (const n of names) used.get(site)!.add(n);
  for (const file of SCAN.flatMap(files)) {
    if (!/\.(ts|tsx|sh|service|socket|timer|json|mjs|js|env|conf)$|^build\.sh$/.test(file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(NAME)) {
      const [, pkg, sub] = m as unknown as [string, string, string];
      if (!pkgDirs.has(pkg) || /^(web|widgets)\//.test(sub)) continue;
      // (a comment may name a file loosely: only real files are entries)
      if (existsSync(join(root, pkgDirs.get(pkg)!, 'src', `${sub}.ts`))) used.get(pkg)!.add(sub);
    }
  }
  return used;
}

export const exportsOf = (subs: Set<string>): Record<string, string> =>
  Object.fromEntries([...subs].sort().map((s) => [`./${s}`, `./src/${s}.ts`]));

export function packageFiles(root = ROOT) {
  return [...readdirSync(join(root, 'packages')).map((n) => ({ name: n, file: `packages/${n}/package.json` })),
    ...readdirSync(join(root, 'sites')).map((n) => ({ name: n, file: `sites/${n}/package.json` }))];
}

if (import.meta.main) {
  const used = usedEntries();
  const stale: string[] = [];
  for (const { name, file } of packageFiles()) {
    const pj = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, unknown>;
    const want = exportsOf(used.get(name)!);
    if (JSON.stringify(pj.exports) === JSON.stringify(want)) continue;
    stale.push(file);
    if (!process.argv.includes('--check')) writeFileSync(join(ROOT, file), `${JSON.stringify({ ...pj, exports: want }, null, 2)}\n`);
  }
  if (process.argv.includes('--check')) {
    if (stale.length) { console.error(`exports out of date: ${stale.join(', ')}. Run: node tools/coupling/entries.ts`); process.exit(1); }
    console.log('public entries: up to date');
  } else console.log(stale.length ? `wrote ${stale.join(', ')}` : 'public entries: up to date');
}
