// Package boundaries (docs/packaging-plan.md): the panel is packages/<name> and
// sites/<site>, and a package may import only from the packages it depends on.
// The core imports no module; a site (the composition roots) may import anything.
//
// Checked here, from the files themselves:
// - an import between packages goes by name (@panel/<name>/...), never by a
//   relative path out of the package's own folder;
// - it is one the table allows, and one the package's package.json lists;
// - each package.json lists exactly what the table allows;
// - src/ holds nothing but the stable entry points (step 2);
// - the same for each package's three parts (step 4): src/ (the server), web/ (the
//   panel's pages) and widgets/ (the <pammy-*> elements on her pages). Each imports
//   only its own kind from another package (web/ from web/, ...), and never leaves
//   its own part by a relative path.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import { MODULES } from '@panel/core/profile';
import { REGISTRY } from '@panel/modules/index';
import { compare, couplingOf, readAllow } from '../tools/coupling/allow.ts';
import { exportsOf, packageFiles, usedEntries } from '../tools/coupling/entries.ts';
import { bigFiles, copies, MAX_BYTES, MAX_LINES, readSizeAllow } from '../tools/coupling/size.ts';
import { makeReport } from '../tools/coupling/scan.ts';

const ROOT = join(import.meta.dirname, '..');

// What each package may import, besides itself. The site may import everything.
const DEPENDS_ON: Record<string, string[]> = {
  core: [],
  mail: ['core'],
  areas: ['core'],
  people: ['core', 'areas'],
  requests: ['core', 'areas'],
  // Settings > Visitors: people's switch words and rules (docs/k-a-plan.md KA-Q4)
  settings: ['core', 'people'],
  // tags and categories on items in scopes (docs/catalog-plan.md step 2)
  catalog: ['core'],
  files: ['core', 'catalog', 'thumbs'],
  thumbs: ['core', 'catalog'],
  media: ['core', 'areas', 'api-keys', 'catalog', 'files', 'thumbs'],
  forms: ['core', 'areas', 'mail', 'api-keys'],
  'api-keys': ['core'],
  studio: ['core', 'catalog'],
  'form-links': ['core', 'forms', 'studio'],
  comments: ['core', 'areas', 'forms', 'form-links', 'studio'],
  apps: ['core', 'mail', 'studio'],
  php: ['core'],
  examples: ['core', 'areas', 'files', 'forms', 'api-keys', 'studio', 'form-links', 'comments', 'apps'],
  help: ['core'],
  // pammy.org's questionnaire and paths (docs/phase9-plan.md 9-1: split from help)
  'getting-started': ['core', 'examples', 'help', 'studio'],
  // its routes show the files module's site folders (docs/phase8b-plan.md 8b-9)
  hosts: ['core', 'files'],
  services: ['core', 'hosts'],
  // it asks the helpers through the site (docs/monitoring-plan.md): nothing of hosts or services itself
  monitoring: ['core'],
  // the projects helper and its page (docs/phase8b-plan.md 8b-1), its route kind (8b-2)
  projects: ['core', 'hosts'],
  // every site's gate (docs/accounts-plan.md step 3): puts the modules' gate parts together
  gate: ['core', 'api-keys', 'areas', 'comments', 'examples', 'files', 'form-links', 'forms', 'media', 'people', 'php', 'requests', 'studio'],
  // every module's definition, put together (docs/module-contracts-plan.md step C1): only their src/module.ts
  modules: ['core', ...MODULES],
};
const SITES = ['lfdln', 'pammy'];

type Pkg = { name: string; dir: string; site: boolean };
const PACKAGES: Pkg[] = [
  ...readdirSync(join(ROOT, 'packages')).map((name) => ({ name, dir: `packages/${name}`, site: false })),
  ...readdirSync(join(ROOT, 'sites')).map((name) => ({ name, dir: `sites/${name}`, site: true })),
];
// The three parts of a package (and of a site): the server's code, the panel's
// pages, and the widgets on her pages.
const PARTS = ['src', 'web', 'widgets'] as const;
const allowed = (p: Pkg) => (p.site ? Object.keys(DEPENDS_ON) : DEPENDS_ON[p.name] ?? []);

function sourceFiles(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
}

// Every import and export-from, static or dynamic or for its side effects, types included: a type import
// still makes the package depend on the other one.
const IMPORT = /(?:^|[\s;{])(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]/gm;
const importsOf = (file: string) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3])!);

describe('package boundaries', () => {
  it('knows every package there is, and nothing else', () => {
    assert.deepEqual(PACKAGES.filter((p) => !p.site).map((p) => p.name).sort(), Object.keys(DEPENDS_ON).sort());
    assert.deepEqual(PACKAGES.filter((p) => p.site).map((p) => p.name).sort(), SITES);
  });

  it('has package.json files that list exactly what the table allows', () => {
    for (const p of PACKAGES) {
      const pj = JSON.parse(readFileSync(join(ROOT, p.dir, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
      assert.equal(pj.name, `@panel/${p.name}`);
      const listed = Object.keys(pj.dependencies ?? {}).sort();
      if (p.site) {
        // a site lists the packages it puts together: every one it imports, and only packages
        const used = [...new Set(PARTS.flatMap((part) => sourceFiles(`${p.dir}/${part}`).flatMap(importsOf))
          .map((spec) => /^@panel\/([a-z-]+)\//.exec(spec)?.[1]).filter((n): n is string => !!n && !SITES.includes(n)))];
        for (const n of listed) assert.ok(n.slice('@panel/'.length) in DEPENDS_ON, `${p.dir}/package.json: ${n} is no package`);
        for (const n of used) assert.ok(listed.includes(`@panel/${n}`), `${p.dir}/package.json doesn't list @panel/${n}, which it imports`);
        continue;
      }
      assert.deepEqual(listed, allowed(p).map((d) => `@panel/${d}`).sort(), `${p.dir}/package.json`);
    }
  });

  it('imports across packages only by name, and only what the table allows', () => {
    const bad: string[] = [];
    for (const p of PACKAGES) for (const part of PARTS) {
      const home = `${p.dir}/${part}`;
      // a site's vite.config.ts is the build's, run by Node: it reads the site's profile
      for (const file of sourceFiles(home).filter((f) => !f.endsWith('/vite.config.ts'))) {
        for (const spec of importsOf(file)) {
          if (spec.startsWith('.')) {
            const to = normalize(join(dirname(file), spec));
            if (!to.startsWith(`${home}/`)) bad.push(`${file}: ${spec} leaves ${home}`);
            continue;
          }
          if (spec.startsWith('@/')) { bad.push(`${file}: ${spec} (no @/ alias: relative inside a package, @panel/<name>/${part}/... across)`); continue; }
          const m = /^@panel\/([a-z-]+)\/(?:(web|widgets)\/)?/.exec(spec);
          if (!m) continue;                          // node:, fastify, ...
          const to = m[1]!;
          if ((m[2] ?? 'src') !== part) bad.push(`${file}: ${spec} (${part}/ imports only another package's ${part}/)`);
          else if (to === p.name) bad.push(`${file}: ${spec} (its own package: use a relative path)`);
          else if (SITES.includes(to)) bad.push(`${file}: ${spec} (a package never imports a site)`);
          else if (!allowed(p).includes(to)) bad.push(`${file}: ${spec} (${p.name} doesn't depend on ${to})`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it('keeps src/ to the stable entry points', () => {
    const odd = sourceFiles('src').filter((f) => {
      const code = readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//'));
      return code.length !== 1 || !/^export \* from '@panel\/[a-z-]+\/[a-z0-9/-]+';$/.test(code[0]!);
    });
    assert.deepEqual(odd, [], 'src/ is only for one-line entry points (export * from ...)');
  });

  // The units, the installer, verify and the tools run src/ paths from outside
  // the code, often inside a `node -e` string, where no import check sees them.
  // Release fd62978a failed verify on six of these after it was installed.
  it('has an entry point at every src/ path the scripts and units run', () => {
    const files = [
      'build.sh',
      ...readdirSync(join(ROOT, 'deploy'), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(ROOT.length + 1)),
      ...readdirSync(join(ROOT, 'tools'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join('tools', e.name)),
      ...sourceFiles('packages'),
    ];
    const named = /(?:\/opt\/pammy-panel|\$\{?APP\}?|release)\/(src\/[a-z0-9/_-]+\.ts)/g;
    const missing = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(named)) {
        try { readFileSync(join(ROOT, m[1]!)); } catch { missing.add(`${m[1]} (named in ${file})`); }
      }
    }
    assert.deepEqual([...missing], []);
  });

  // A module's tables are its own (docs/master-plan.md rule 1): the first table moved to
  // its owner (docs/phase8b-plan.md 8b-9) is checked here; C1's boundary test widens it.
  it('lets only the files module\'s store touch panel.site_folders', () => {
    const owner = 'packages/files/src/site-folders/store.ts';
    const code = [...sourceFiles('packages'), ...sourceFiles('sites')].filter((f) => !f.includes('/migrations/') && f !== owner);
    const touching = code.filter((f) => readFileSync(join(ROOT, f), 'utf8').split('\n').some((l) => !l.trim().startsWith('//') && /\bsite_folders\b/.test(l)));
    assert.deepEqual(touching, []);
    assert.ok(readFileSync(join(ROOT, owner), 'utf8').includes('FROM site_folders'));
  });

  // DEPENDS_ON checked against the modules' definitions (docs/module-contracts-plan.md step C1)
  it('has each module depend on the core and on what its definition needs, nothing else', () => {
    for (const m of MODULES) assert.deepEqual([...DEPENDS_ON[m]!].sort(), ['core', ...REGISTRY[m].needs].sort(), m);
  });

  it('has @panel/modules import only the modules\' definitions', () => {
    const odd = sourceFiles('packages/modules/src').flatMap(importsOf)
      .filter((spec) => !/^@panel\/[a-z-]+\/module$/.test(spec) && spec !== '@panel/core/profile');
    assert.deepEqual(odd, []);
  });

  // Rules 1 and 5 (docs/master-plan.md section 3), step C1: a module's tables are its own, and
  // what it calls at run time it depends on. What was there at C1 is allowed (docs/coupling-allow.json,
  // K0's report); nothing new, and the list only shrinks.
  describe('coupling between modules', () => {
    const { added, gone } = compare(readAllow(ROOT), couplingOf(makeReport(ROOT)));
    it('adds no SQL on another module\'s tables', () => {
      assert.deepEqual(added.sql, [], 'use the owning module\'s functions, ops or events instead (docs/coupling-report.md says whose each table is)');
    });
    it('adds no call to a module it doesn\'t depend on', () => {
      assert.deepEqual(added.undeclared, [], 'depend on the module (its definition\'s needs and package.json), or go through one you depend on');
    });
    it('lists nothing the code no longer does', () => {
      assert.deepEqual([...gone.sql, ...gone.undeclared], [], 'gone from the code: node tools/coupling/allow.ts --shrink');
    });
  });

  // Rule 2 (docs/master-plan.md section 3), step C1: a package's package.json lists the entries
  // others import, not "./*" (tools/coupling/entries.ts writes them from the code)
  it('lists in each package.json exactly the entries others import', () => {
    const used = usedEntries(ROOT);
    const off = packageFiles(ROOT).filter(({ name, file }) =>
      JSON.stringify((JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { exports?: unknown }).exports) !== JSON.stringify(exportsOf(used.get(name)!)))
      .map(({ file }) => file);
    assert.deepEqual(off, [], 'node tools/coupling/entries.ts (a new entry is a package showing more: is it the right one?)');
  });

  // Rule 8 (docs/master-plan.md section 3), step C1: a report, not a check (yet). The details:
  // node tools/coupling/size.ts
  it('reports new big files and copied blocks (fails nothing)', (t) => {
    const allow = new Set(readSizeAllow(ROOT));
    for (const b of bigFiles(ROOT).filter((x) => !allow.has(x.file))) {
      t.diagnostic(`rule 8: ${b.file} is ${b.lines} lines, ${Math.round(b.bytes / 1024)} KB (over ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB): split it?`);
    }
    t.diagnostic(`rule 8: ${copies(ROOT).length} copied blocks (node tools/coupling/size.ts)`);
  });

  it('keeps the table itself free of loops', () => {
    const seen = new Set<string>(), path: string[] = [];
    const visit = (name: string) => {
      assert.ok(!path.includes(name), `loop: ${[...path, name].join(' -> ')}`);
      if (seen.has(name)) return;
      path.push(name);
      for (const dep of DEPENDS_ON[name] ?? []) visit(dep);
      path.pop();
      seen.add(name);
    };
    for (const name of Object.keys(DEPENDS_ON)) visit(name);
  });
});
