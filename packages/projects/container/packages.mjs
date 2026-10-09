// A project's packages (docs/phase8b-plan.md 8b-8a, docs/platform-plan.md "The Packages page"),
// inside the build container:
//   node /lfdln/packages.mjs check <branch>                  what is in package.json, installed,
//        wanted and latest, deprecated, security advisories; its scripts
//   node /lfdln/packages.mjs change <branch> <by> <json>     add / update / remove / fix, committed
//        and pushed to <branch> (fast-forward only); the helper builds it after
//   node /lfdln/packages.mjs run <branch> <script>           one of its scripts, its output
//   node /lfdln/packages.mjs search <text>                   the npm registry's search
//   node /lfdln/packages.mjs about <name> <ts|js>            one package, with the warnings
// /repo: the bare repository (read-only but for change); /build: an empty folder; /cache: npm's
// and pnpm's. search and about have no folders. The last line printed is the JSON answer.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer, main, out, pmOf, run } from './common.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
// npm's own rule for a name (validate-npm-package-name, new packages): lowercase, URL-safe, scoped or not
export const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
// a version or range as people write them: 1.2.3, ^1.2, ~4, latest, next, 5.x
export const SPEC_RE = /^[a-zA-Z0-9.^~<>=*+_ |-]{1,64}$/;
// scripts that serve and never finish: a job would only time out
export const LONG_RUNNING = ['dev', 'start', 'preview', 'serve'];
// licences most open-source packages have (others are shown, with a word)
const COMMON_LICENSES = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'MPL-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0', 'Artistic-2.0', '(MIT OR Apache-2.0)', 'MIT OR Apache-2.0'];
const DAY = 86_400_000;

const getJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': 'lfdln-projects', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url.replace(REGISTRY, 'the registry')} answered ${r.status}`);
  return r.json();
};
const enc = (name) => name.replace('/', '%2f');
// a few at a time, so a long list doesn't hammer the registry
async function each(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
  }));
  return out;
}
const weekly = async (name) => (await getJson(`${DOWNLOADS}/${name}`))?.downloads ?? null;

// a command's output, whatever its exit (npm outdated exits 1 when something is outdated)
function capture(cmd, args, cwd) {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} didn't start: ${r.error.message}`);
  if (r.stderr) process.stderr.write(r.stderr.split('\n').slice(-20).join('\n'));
  return r.stdout;
}
const parse = (text) => { try { return JSON.parse(text || 'null'); } catch { return null; } };

const SRC = '/build/src';
function clone(branch, full = false) {
  run('git', ['clone', '-q', ...(full ? [] : ['--depth', '1']), '--branch', branch, '--single-branch', 'file:///repo', SRC], '/build');
  return JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));
}
// its packages as its lockfile has them, without running anything of theirs
function installFrozen(pm, scripts) {
  const quiet = scripts ? [] : ['--ignore-scripts'];
  if (pm === 'pnpm') run('pnpm', ['install', '--frozen-lockfile', ...quiet], SRC);
  else run('npm', [existsSync(join(SRC, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund', ...quiet], SRC);
}
const installedVersion = (name) => {
  try { return JSON.parse(readFileSync(join(SRC, 'node_modules', name, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
};

// The worst advisory per package, and the counts, from either audit's JSON
function audits(pm, json, direct) {
  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  const worst = {};
  const rank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
  const note = (name, sev) => { if (direct.has(name) && (worst[name] === undefined || rank[sev] > rank[worst[name]])) worst[name] = sev; };
  if (!json) return { counts, worst, read: false };
  if (pm === 'npm') {
    for (const [name, v] of Object.entries(json.vulnerabilities ?? {})) note(name, v.severity);
    for (const k of Object.keys(counts)) counts[k] = json.metadata?.vulnerabilities?.[k] ?? 0;
  } else {
    for (const a of Object.values(json.advisories ?? {})) {
      counts[a.severity] = (counts[a.severity] ?? 0) + 1;
      note(a.module_name, a.severity);
      // a direct package that brings the vulnerable one in
      for (const f of a.findings ?? []) for (const p of f.paths ?? []) note(String(p).split('>')[0], a.severity);
    }
  }
  return { counts, worst, read: true };
}

async function check(branch) {
  const pkg = clone(branch);
  const commit = out('git', ['rev-parse', 'HEAD'], SRC);
  const pm = pmOf(SRC);
  const listed = [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({ name, range, type: 'dependencies' })),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({ name, range, type: 'devDependencies' })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  installFrozen(pm, false);
  const outdated = parse(capture(pm, pm === 'pnpm' ? ['outdated', '--format', 'json'] : ['outdated', '--json'], SRC)) ?? {};
  const audit = audits(pm, parse(capture(pm, ['audit', '--json'], SRC)), new Set(listed.map((p) => p.name)));
  // latest and deprecated from the registry's short form (one request a package)
  const meta = await each(listed, 8, (p) => getJson(`${REGISTRY}/${enc(p.name)}`, { accept: 'application/vnd.npm.install-v1+json' }));
  const packages = listed.map((p, i) => {
    const current = installedVersion(p.name);
    const m = meta[i];
    const o = outdated[p.name] ?? {};
    const latest = m?.['dist-tags']?.latest ?? o.latest ?? null;
    const dep = current && m?.versions?.[current]?.deprecated;
    return { ...p, current, wanted: o.wanted ?? current, latest, deprecated: typeof dep === 'string' ? dep.slice(0, 300) : null, advisory: audit.worst[p.name] ?? null };
  });
  answer({ pm, commit, packages, scripts: pkg.scripts ?? {}, audit: audit.counts, auditRead: audit.read });
}

async function change(branch, by, spec) {
  const c = JSON.parse(spec);
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(by ?? '')) throw new Error('bad arguments');
  clone(branch, true);
  const before = out('git', ['rev-parse', 'HEAD'], SRC);
  const pm = pmOf(SRC);
  const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));
  const isDev = (n) => Object.hasOwn(pkg.devDependencies ?? {}, n);
  const names = (list) => { for (const n of list) if (!NAME_RE.test(n)) throw new Error(`"${n}" isn't a package name`); return list; };
  let summary;
  if (c.add) {
    const list = c.add.map((a) => { names([a.name]); if (a.version && !SPEC_RE.test(a.version)) throw new Error(`"${a.version}" isn't a version`); return a; });
    for (const dev of [false, true]) {
      const these = list.filter((a) => !!a.dev === dev).map((a) => `${a.name}@${a.version || 'latest'}`);
      if (these.length) run(pm, [pm === 'pnpm' ? 'add' : 'install', ...(dev ? ['-D'] : []), ...these], SRC);
    }
    summary = `add ${list.map((a) => `${a.name}@${a.version || 'latest'}${a.dev ? ' (dev)' : ''}`).join(', ')}`;
  } else if (c.update === 'all') {
    // every package to the newest its range allows (minor and patch updates)
    run(pm, ['update'], SRC);
    summary = 'update all within their ranges';
  } else if (c.update) {
    names(c.update);
    for (const dev of [false, true]) {
      const these = c.update.filter((n) => isDev(n) === dev).map((n) => `${n}@latest`);
      if (these.length) run(pm, [pm === 'pnpm' ? 'add' : 'install', ...(dev ? ['-D'] : []), ...these], SRC);
    }
    summary = `update ${c.update.join(', ')} to the latest`;
  } else if (c.remove) {
    names(c.remove);
    run(pm, [pm === 'pnpm' ? 'remove' : 'uninstall', ...c.remove], SRC);
    summary = `remove ${c.remove.join(', ')}`;
  } else if (c.fix) {
    // the fixes that break nothing (npm: no --force; pnpm: its overrides, then installed)
    if (pm === 'pnpm') { capture('pnpm', ['audit', '--fix'], SRC); run('pnpm', ['install', '--no-frozen-lockfile'], SRC); } else capture('npm', ['audit', 'fix'], SRC);
    summary = 'fix security issues (non-breaking)';
  } else {
    throw new Error('what change?');
  }
  run('git', ['add', '-A', '--', 'package.json', pm === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'], SRC);
  if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: SRC }).status === 0) {
    console.log('nothing changed in package.json or the lockfile');
    return answer({ changed: false, before, summary });
  }
  const who = ['-c', `user.name=${by}`, '-c', `user.email=${by}@panel.lesfleursdelanuit.com`];
  run('git', [...who, 'commit', '-q', '-m', `Packages: ${summary}`], SRC);
  // fast-forward only: a push in between makes this fail, and nothing is lost
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], SRC);
  answer({ changed: true, before, commit: out('git', ['rev-parse', 'HEAD'], SRC), summary });
}

function script(branch, name) {
  const pkg = clone(branch);
  if (!Object.hasOwn(pkg.scripts ?? {}, name)) throw new Error(`there is no script called ${name}`);
  if (LONG_RUNNING.includes(name)) throw new Error(`${name} serves and never finishes: it isn't run here`);
  const pm = pmOf(SRC);
  installFrozen(pm, true);
  console.log(`\n--- ${pm} run ${name}`);
  const r = spawnSync(pm, ['run', name], { cwd: SRC, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  answer({ script: name, exit: r.status ?? -1 });
  if (r.status !== 0) process.exit(1);
}

async function search(text) {
  const q = String(text ?? '').trim().slice(0, 100);
  if (!q) return answer({ results: [] });
  const r = await getJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(q)}&size=20`);
  const objects = r?.objects ?? [];
  const weeks = await each(objects, 10, (o) => weekly(o.package.name));
  answer({ results: objects.map((o, i) => ({
    name: o.package.name, version: o.package.version, description: String(o.package.description ?? '').slice(0, 300),
    date: o.package.date ?? null, publisher: o.package.publisher?.username ?? null, license: o.package.license ?? null, weekly: weeks[i] ?? null,
  })) });
}

// one letter away (a swap counts as one): Damerau-Levenshtein, cut off above 1
export function closeTo(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] === 1;
}

// What to know before adding it (docs/platform-plan.md: shown plainly, never blocking)
export function warningsOf(p, popular) {
  const w = [];
  if (p.created && Date.now() - Date.parse(p.created) < 30 * DAY) w.push({ kind: 'new', text: `It is new: first published ${p.created.slice(0, 10)}.` });
  if (p.weekly !== null && p.weekly < 500) w.push({ kind: 'few', text: `Few people use it: ${p.weekly} downloads last week.` });
  const like = popular.find((x) => x !== p.name && closeTo(p.name, x));
  if (like && !popular.includes(p.name)) w.push({ kind: 'lookalike', text: `Its name is one letter away from ${like}, a popular package: is it the one you meant?` });
  if (p.deprecated) w.push({ kind: 'deprecated', text: `Its author says not to use it: ${p.deprecated}` });
  if (!p.license) w.push({ kind: 'license', text: 'It says no licence.' });
  else if (!COMMON_LICENSES.includes(p.license)) w.push({ kind: 'license', text: `Its licence is ${p.license}, not one of the common open-source ones.` });
  if (p.installScripts) w.push({ kind: 'scripts', text: 'It runs its own scripts when installed (only ever in the build container).' });
  return w;
}

async function about(name, lang) {
  if (!NAME_RE.test(name ?? '')) throw new Error(`"${name}" isn't a package name`);
  const doc = await getJson(`${REGISTRY}/${enc(name)}`);
  if (!doc) return answer({ found: false, name });
  const version = doc['dist-tags']?.latest;
  const latest = doc.versions?.[version] ?? {};
  const scripts = latest.scripts ?? {};
  const own = !!(latest.types || latest.typings || (typeof latest.exports === 'object' && JSON.stringify(latest.exports).includes('"types"')));
  let types = own ? 'built-in' : null;
  if (!own && lang === 'ts' && !name.startsWith('@types/')) {
    const t = `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
    if (await getJson(`${REGISTRY}/${enc(t)}/latest`).catch(() => null)) types = t;
  }
  const lic = typeof latest.license === 'string' ? latest.license : latest.license?.type ?? (typeof doc.license === 'string' ? doc.license : null);
  const p = {
    found: true, name, version, description: String(latest.description ?? doc.description ?? '').slice(0, 400), license: lic,
    created: doc.time?.created ?? null, published: doc.time?.[version] ?? null, weekly: await weekly(name).catch(() => null),
    deprecated: typeof latest.deprecated === 'string' ? latest.deprecated.slice(0, 300) : null,
    installScripts: !!(latest.hasInstallScript || scripts.preinstall || scripts.install || scripts.postinstall),
    types, size: latest.dist?.unpackedSize ?? null, homepage: typeof latest.homepage === 'string' ? latest.homepage.slice(0, 200) : null,
  };
  const popular = JSON.parse(readFileSync(new URL('./popular.json', import.meta.url), 'utf8'));
  answer({ ...p, warnings: warningsOf(p, popular) });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main(async () => {
    const [what, a, b, c] = process.argv.slice(2);
    const branch = () => { if (!['main', 'dev'].includes(a)) throw new Error('bad arguments'); return a; };
    if (what === 'check') await check(branch());
    else if (what === 'change') await change(branch(), b, c);
    else if (what === 'run') script(branch(), b);
    else if (what === 'search') await search(a);
    else if (what === 'about') await about(a, b);
    else throw new Error('bad arguments');
  });
}
