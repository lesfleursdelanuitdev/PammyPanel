// lfdln's whole panel on one port for its browser tests (docs/lfdln-standup-plan.md L9):
// its app (sites/lfdln), the folder helper over throwaway site folders, and the real
// routing helper writing real files into a throwaway folder -- with nginx and the
// DreamHost zone stood in for, so a test can have nginx say no. Its Postgres is a
// throwaway container (test/pg-harness.ts), removed when it stops.
//   node test/e2e-lfdln/server.ts        (its playwright.config.ts starts it)
// It writes an admin's setup link to $PAMMY_E2E_STATE/invite.json.
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanAccess, COMMAND_LINE, createInvite, createUser, getUserByName, setAccess } from '@panel/core/accounts';
import type { Config } from '@panel/core/config';
import { migrate } from '@panel/core/pg-migrate';
import { seedHomeDomain } from '@panel/hosts/domains';
import { siteFacts } from '@panel/core/profile';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { createSiteFsServer } from '@panel/files/sitefs/service';
import { DEFAULT_TOOLS } from '@panel/thumbs/thumbs/make';
import { createThumbsServer } from '@panel/thumbs/thumbs/service';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { createRoutesServer } from '@panel/hosts/helper/service';
import { zoneReader } from '@panel/hosts/zone';
import { buildApp, monitorOf } from '@panel/lfdln/app';
import { createJsonLineServer } from '@panel/core/jsonline';
import { createGateAdminServer } from '@panel/gate/admin';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { createServicesOps } from '@panel/services/helper/ops';
import { createServicesServer } from '@panel/services/helper/service';
import { createProjectsOps } from '@panel/projects/helper/ops';
import { createProjectsServer } from '@panel/projects/helper/service';
import type { ServicesRecord } from '@panel/services/record';
import { PROFILE } from '@panel/lfdln/profile';
import { parseMap } from '@panel/help/help';
import { signedRequestOk } from '@panel/core/signed';
import { startPg } from '../pg-harness.ts';
import { createPammyDbServer } from '@panel/studio/pammydb/service';
import type { DatabaseFacts, Driver } from '@panel/studio/pammydb/driver';
import { isManaged, isProjectDb } from '@panel/studio/pammydb/ident';
import { LFDLN_HELPER } from '@panel/lfdln/studio-site';
import { memoryRows, memorySchemas } from '../studio-stub.ts';

const PORT = Number(process.env.PAMMY_E2E_PORT ?? 3299);
const STATE = process.env.PAMMY_E2E_STATE ?? join(import.meta.dirname, '.state');
const root = new URL('../../', import.meta.url).pathname;
const now = () => Math.floor(Date.now() / 1000);
const origin = `http://localhost:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'lfdln-e2e-'));
for (const d of ['sites', 'trash', 'nginx', 'help']) mkdirSync(join(dir, d));
// lfdln's guides and their map, as build.sh copies them (docs/phase9-plan.md 9-1)
for (const e of parseMap(readFileSync(join(root, '../lfdln-guides/guides.map'), 'utf8'))) copyFileSync(join(root, '../lfdln-guides', e.src), join(dir, 'help', e.file));
copyFileSync(join(root, '../lfdln-guides/guides.map'), join(dir, 'help', 'guides.map'));

const sitefs = createSiteFsServer({ publicDir: join(dir, 'sites'), trashDir: join(dir, 'trash'), placementFile: null, domain: PROFILE.domain, siteName: PROFILE.name,
  folderSubdomains: false, maxUpload: PROFILE.uploads.maxBytes, purgeDays: 30, now: () => new Date(), hostsKeepTop: true });
// thumbnails (docs/phase8-plan.md step 8-1), as lfdln-thumbs makes them
mkdirSync(join(dir, 'media-public', 'thumbs'), { recursive: true });
const thumbsServer = createThumbsServer({ publicDir: join(dir, 'sites'), tools: DEFAULT_TOOLS });
await new Promise<void>((r) => thumbsServer.listen(join(dir, 'thumbs.sock'), r));
await new Promise<void>((r) => sitefs.listen(join(dir, 'sitefs.sock'), r));
// lfdln-appdb, stood in for (docs/phase8-plan.md step 8-4): Postgres, with lfdln's own rules,
// two of the apps' databases (examprep's tables in "prep") and nothing of Pamela's
const rules = LFDLN_HELPER.rules!.postgres!;
const appdbHas = ['postgres', 'examprep', 'tutorstar'];
const appdbFacts = (name: string): DatabaseFacts => ({
  engine: 'postgres', name, bytes: 8192, tables: name === 'examprep' ? 1 : 0, owner: 'pammy_studio',
  protectedName: rules.protected.includes(name), system: rules.system.includes(name), appOwned: isManaged(rules, name), projectOwned: isProjectDb(rules, name),
});
const appdbSchemas = memorySchemas('postgres', {
  examprep: [{ name: 'topics', columns: [{ name: 'id', type: 'integer', required: true, default: null, identity: true }, { name: 'title', type: 'text', required: true, default: null }],
    primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [] }],
});
const appdbRows = memoryRows({ examprep: { topics: [{ id: 1, title: 'Fractions' }, { id: 2, title: 'Algebra' }] } });
const appdb: Driver = {
  engine: 'postgres', rules,
  state: async () => ({ engine: 'postgres', ok: true, version: null, message: null }),
  list: async () => appdbHas.map(appdbFacts),
  create: async (name) => { appdbHas.push(name); return appdbFacts(name); },
  drop: async (name) => { appdbHas.splice(appdbHas.indexOf(name), 1); },
  size: async (name) => ({ bytes: 8192, tables: appdbFacts(name).tables ?? 0 }),
  introspect: (database) => appdbSchemas.introspect('postgres', database),
  apply: (database, steps) => appdbSchemas.apply('postgres', database, steps),
  listUsers: async () => ['postgres', 'pammy_studio', 'tutorstar'].map((name) => ({ engine: 'postgres' as const, name, host: null, canLogin: true, reserved: true, serverWide: false })),
  createUser: async (name) => ({ engine: 'postgres', name, host: null, canLogin: true, reserved: false, serverWide: false }),
  dropUser: async () => {}, setPassword: async () => {},
  accessOf: async () => [], grant: async () => {}, revoke: async () => {},
  listRows: (database, q) => appdbRows.list(database, q),
  getRow: (database, table, columns, where) => appdbRows.get(database, table, columns, where),
  insertRow: (database, table, values, back) => appdbRows.insert(database, table, values, back),
  updateRow: (database, table, values, where, back) => appdbRows.update(database, table, values, where, back),
  deleteRow: (database, table, where) => appdbRows.remove(database, table, where),
  setLinks: (database, table, here, id, there, ids) => appdbRows.setLinks(database, table, here, id, there, ids),
  close: async () => {},
};
// lfdln-appmaria, stood in for (docs/lfdln-mariadb-plan.md M4): the Studio's MariaDB, with no apps
const mariaRules = LFDLN_HELPER.rules!.mariadb!;
const mariaHas = ['mysql', 'information_schema'];
const mariaFacts = (name: string): DatabaseFacts => ({
  engine: 'mariadb', name, bytes: 4096, tables: 0, owner: null,
  protectedName: mariaRules.protected.includes(name), system: mariaRules.system.includes(name), appOwned: isManaged(mariaRules, name), projectOwned: isProjectDb(mariaRules, name),
});
const mariaSchemas = memorySchemas('mariadb', {});
const mariaUsers = ['root', 'pammy_studio'];
const appmaria: Driver = {
  engine: 'mariadb', rules: mariaRules,
  state: async () => ({ engine: 'mariadb', ok: true, version: null, message: null }),
  list: async () => mariaHas.map(mariaFacts),
  create: async (name) => { mariaHas.push(name); return mariaFacts(name); },
  drop: async (name) => { mariaHas.splice(mariaHas.indexOf(name), 1); },
  size: async () => ({ bytes: 4096, tables: 0 }),
  introspect: (database) => mariaSchemas.introspect('mariadb', database),
  apply: (database, steps) => mariaSchemas.apply('mariadb', database, steps),
  listUsers: async () => mariaUsers.map((name) => ({ engine: 'mariadb' as const, name, host: '%', canLogin: true, reserved: mariaRules.reservedUsers.includes(name), serverWide: false })),
  createUser: async (name) => { mariaUsers.push(name); return { engine: 'mariadb', name, host: '%', canLogin: true, reserved: false, serverWide: false }; },
  dropUser: async (name) => { mariaUsers.splice(mariaUsers.indexOf(name), 1); }, setPassword: async () => {},
  accessOf: async () => [], grant: async () => {}, revoke: async () => {},
  listRows: (database, q) => appdbRows.list(database, q),
  getRow: (database, table, columns, where) => appdbRows.get(database, table, columns, where),
  insertRow: (database, table, values, back) => appdbRows.insert(database, table, values, back),
  updateRow: (database, table, values, where, back) => appdbRows.update(database, table, values, where, back),
  deleteRow: (database, table, where) => appdbRows.remove(database, table, where),
  setLinks: (database, table, here, id, there, ids) => appdbRows.setLinks(database, table, here, id, there, ids),
  close: async () => {},
};
const pammydb = createPammyDbServer({ postgres: appdb, mariadb: appmaria });
await new Promise<void>((r) => pammydb.listen(join(dir, 'pammydb.sock'), r));

// nginx and the zone, stood in for: what they say is the control port's to change
const world = { nginxSays: 0, zoneUp: true, nameservers: ['ns1.dreamhost.com', 'ns2.dreamhost.com'], urlsDown: [] as string[] };
const run = async (spec: RunSpec): Promise<RunResult> => {
  if (spec.what === 'nginx-test') return { code: world.nginxSays, stdout: '', stderr: world.nginxSays ? 'nginx: [emerg] a test said no' : '' };
  if (spec.what === 'zone') {
    return world.zoneUp
      ? { code: 0, stdout: `${PROFILE.domain} A 0 203.0.113.200\nwebmail.${PROFILE.domain} CNAME 0 webmail.dreamhost.com.\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: 'DreamHost did not answer' };
  }
  // the checks (docs/domains-hosts-plan.md steps 3-4): all fine, except a name starting
  // "elsewhere" (its DNS points elsewhere) and a certificate file with "missing" in its path
  if (spec.what === 'check') {
    const ok = { ok: true, why: 'fine' };
    const results = (JSON.parse(spec.stdin!) as { kind: string; name?: string; path?: string; names?: string[]; type?: string }[]).map((t) => {
      // monitoring's DNS records (step 2): the same each time
      if (t.kind === 'records') return { kind: 'records', name: t.name, type: t.type, ok: true, why: '', values: t.type === 'NS' ? world.nameservers : [`${t.type} record of ${t.name}`] };
      // step 3: the registration, and the other addresses (all answering, except when a test says)
      if (t.kind === 'rdap') return { kind: 'rdap', domain: (t as { domain?: string }).domain, ok: true, why: '', expires: now() + 400 * 86400 };
      if (t.kind === 'url') {
        const up = !world.urlsDown.includes(t.name!);
        return { kind: 'url', name: t.name, path: t.path, via: t.name!.includes('pammy') ? 'cloudflare' : 'here', dns: { ok: true, why: 'points here', addresses: ['203.0.113.200'] },
          cert: { ok: true, why: 'covers it, 60 days left', notAfter: now() + 60 * 86400, daysLeft: 60, covers: true, names: [t.name] },
          answers: up ? { ok: true, why: 'answers 200', status: 200 } : { ok: false, why: 'answers 502', status: 502 } };
      }
      const dns = t.name?.startsWith('elsewhere') ? { ok: false, why: 'points elsewhere: 203.0.113.5', addresses: ['203.0.113.5'] } : { ...ok, why: 'points here (203.0.113.200)', addresses: ['203.0.113.200'] };
      const cert = t.path?.includes('missing') ? { ok: false, why: "can't be read as a certificate: ENOENT", notAfter: null, daysLeft: null, names: [] }
        : { ...ok, why: 'covers it, 80 days left', notAfter: now() + 80 * 86400, daysLeft: 80, covers: true, names: t.names ?? [`*.${PROFILE.domain}`, PROFILE.domain] };
      if (t.kind === 'cert-file') return { kind: 'cert-file', path: t.path, cert };
      if (t.kind === 'resolve') return { kind: 'resolve', name: t.name, dns };
      return { kind: 'host', name: t.name, dns, cert, answers: { ...ok, why: 'answers 200', status: 200 } };
    });
    return { code: 0, stdout: JSON.stringify(results), stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};
// a fresh reading every time, so a test can take the zone down
const zone = { taken: () => zoneReader(run, ['dreamhost-dns.sh', 'list'], PROFILE.domain, now).taken() };
// The services helper (docs/adopt-plan.md V7), with what it asks systemd stood in for:
// a demo service of two parts (the web part can't run without the API), each "answering"
// while its unit is active.
const svcRecord: ServicesRecord = { version: 1, services: [{
  id: 'demo', title: 'Demo app', user: 'svc-demo', about: 'A stand-in for TutorStar and the Gonsalves apps.', adoptedAt: now() - 3600,
  parts: [
    { id: 'api', title: 'API', unit: 'demo-api', port: 3296, health: '/health', controls: true, requires: [], source: '/q/demo-api.container', sha256: 'a'.repeat(64) },
    { id: 'web', title: 'Web', unit: 'demo-web', port: 3295, health: '/', controls: true, requires: ['api'], source: '/q/demo-web.container', sha256: 'a'.repeat(64) },
  ],
}] };
const units = { active: new Set(['demo-api', 'demo-web']), masked: new Set<string>() };
mkdirSync(join(dir, 'root/etc'), { recursive: true });
writeFileSync(join(dir, 'root/etc/passwd'), 'svc-demo:x:991:991::/var/lib/svc-demo:/usr/sbin/nologin\n');
const svcRun = async (spec: RunSpec): Promise<RunResult> => {
  const [cmd, ...a] = spec.argv;
  if (cmd === 'systemctl') {
    const verb = a[1];
    const us = a.filter((x) => x.endsWith('.service')).map((x) => x.slice(0, -'.service'.length));
    if (verb === 'show') {
      return { code: 0, stderr: '', stdout: us.map((u) => [`Id=${u}.service`, `LoadState=${units.masked.has(u) ? 'masked' : 'loaded'}`,
        `ActiveState=${units.active.has(u) ? 'active' : 'inactive'}`, `SubState=${units.active.has(u) ? 'running' : 'dead'}`, 'NRestarts=0', `ActiveEnterTimestamp=@${now() - 600}`].join('\n')).join('\n\n') };
    }
    if (verb === 'stop') us.forEach((u) => units.active.delete(u));
    if (verb === 'start' || verb === 'restart') us.forEach((u) => units.active.add(u));
    if (verb === 'mask') us.forEach((u) => units.masked.add(u));
    if (verb === 'unmask') us.forEach((u) => units.masked.delete(u));
    return { code: 0, stdout: '', stderr: '' };
  }
  // monitoring's backups and disk (step 2): last night's dumps, a roomy disk
  if (spec.what === 'storage') {
    const t = JSON.parse(spec.stdin!) as { backups: { id: string }[]; disks: { path: string }[] };
    return { code: 0, stderr: '', stdout: JSON.stringify({
      backups: t.backups.map((b) => ({ id: b.id, newest: { at: now() - 6 * 3600, files: 1, empty: 0, bytes: 1_500_000 }, why: null })),
      disks: t.disks.map((d) => ({ path: d.path, dev: '2051', size: 1_000_000_000_000, avail: 700_000_000_000, why: null })),
    }) };
  }
  // Settings > Backups (docs/lfdln-mariadb-plan.md B2): three old copies go when fewer than 60 days are kept
  if (spec.what === 'prune') {
    const t = JSON.parse(spec.stdin!) as { sets: { id: string }[]; days: number };
    return { code: 0, stderr: '', stdout: JSON.stringify({ sets: t.sets.map((b, i) => ({ id: b.id, deleted: t.days < 60 && i === 0 ? 3 : 0, bytes: t.days < 60 && i === 0 ? 4_500_000 : 0, kept: 5, why: null })) }) };
  }
  if (cmd === 'sha256sum') return { code: 0, stderr: '', stdout: a.slice(1).map((f) => `${'a'.repeat(64)}  ${f}`).join('\n') };
  if (cmd === 'journalctl') return { code: 0, stderr: '', stdout: `2026-09-25T07:00:00+00:00 lfdln demo[1]: listening on ${a[0]?.slice('_SYSTEMD_USER_UNIT='.length)}\n` };
  return { code: 0, stdout: '', stderr: '' };
};
const portUnit = new Map(svcRecord.services[0]!.parts.map((p) => [p.port, p.unit]));
const services = createServicesServer(createServicesOps({
  record: () => svcRecord, run: svcRun, root: join(dir, 'root'), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), waitMs: 5000,
  probe: async (port) => ({ status: units.active.has(portUnit.get(port) ?? '') ? (webBroken && port === 3295 ? 500 : 200) : null, ms: 4 }),
}));
await new Promise<void>((r) => services.listen(join(dir, 'services.sock'), r));
// the projects helper (docs/phase8b-plan.md 8b-1): svc-lfdln-apps and its build image stood in for
mkdirSync(join(dir, 'root', 'etc'), { recursive: true });
writeFileSync(join(dir, 'root', 'etc', 'passwd'), 'svc-lfdln-apps:x:974:966::/var/lib/svc-lfdln-apps:/usr/sbin/nologin\n', { flag: 'a' });
mkdirSync(join(dir, 'projects-state'));
mkdirSync(join(dir, 'srv'));
mkdirSync(join(dir, 'nginx-projects'));
let e2eBuilds = 0;
// 8b-8a: the packages a project has, as the box would find them (zod once it is added)
const e2ePackages = [{ name: 'next', range: '15.5.0', type: 'dependencies', current: '15.5.0', wanted: '15.5.0', latest: '16.0.1', deprecated: null, advisory: 'moderate' },
  { name: 'react', range: '19.1.0', type: 'dependencies', current: '19.1.0', wanted: '19.1.0', latest: '19.1.0', deprecated: null, advisory: null }];
const packagesBox = (argv: string[]) => {
  const [op, , , change] = argv.slice(argv.indexOf('/lfdln/packages.mjs') + 1);
  if (op === 'check') return { code: 0, stdout: `$ npm ci --ignore-scripts\n${JSON.stringify({ pm: 'npm', commit: '8c15326709167d865046c0843b0a7088c13e2b89', packages: e2ePackages, scripts: { dev: 'next dev', build: 'next build', lint: 'eslint' }, audit: { low: 0, moderate: 1, high: 0, critical: 0 }, auditRead: true })}\n`, stderr: '' };
  if (op === 'change') {
    const c = JSON.parse(change!) as { add?: { name: string; dev?: boolean }[] };
    for (const a of c.add ?? []) if (!e2ePackages.some((p) => p.name === a.name)) e2ePackages.push({ name: a.name, range: '^4.6.5', type: a.dev ? 'devDependencies' : 'dependencies', current: '4.6.5', wanted: '4.6.5', latest: '4.6.5', deprecated: null, advisory: null });
    return { code: 0, stdout: `$ npm install zod@latest\n{"changed":true,"before":"${'8'.repeat(40)}","commit":"${'9'.repeat(40)}","summary":"add zod@latest"}\n`, stderr: '' };
  }
  return { code: 0, stdout: '$ npm ci\n--- npm run lint\nall clean\n{"script":"lint","exit":0}\n', stderr: '' };
};
const registryBox = (argv: string[]) => (argv.includes('search')
  ? { code: 0, stdout: `${JSON.stringify({ results: [{ name: 'zod', version: '4.6.5', description: 'TypeScript-first schema validation', date: '2026-09-13T23:25:14Z', publisher: 'colinhacks', license: 'MIT', weekly: 387371526 },
      { name: 'zood', version: '0.0.1', description: 'a look-alike', date: '2026-10-01T00:00:00Z', publisher: 'someone', license: 'SSPL-1.0', weekly: 3 }] })}\n`, stderr: '' }
  : argv.includes('zood')
    ? { code: 0, stdout: `${JSON.stringify({ found: true, name: 'zood', version: '0.0.1', description: 'a look-alike', license: 'SSPL-1.0', created: '2026-10-01T00:00:00Z', weekly: 3, deprecated: null, installScripts: true, types: null, size: 2000,
        warnings: [{ kind: 'new', text: 'It is new: first published 2026-10-01.' }, { kind: 'lookalike', text: 'Its name is one letter away from zod, a popular package: is it the one you meant?' }, { kind: 'scripts', text: 'It runs its own scripts when installed (only ever in the build container).' }] })}\n`, stderr: '' }
    : { code: 0, stdout: `${JSON.stringify({ found: true, name: 'zod', version: '4.6.5', description: 'TypeScript-first schema validation', license: 'MIT', created: '2020-03-07T21:19:15Z', published: '2026-09-13T23:25:14Z', weekly: 387371526, deprecated: null, installScripts: false, types: 'built-in', size: 6140311, warnings: [] })}\n`, stderr: '' });
const projects = createProjectsServer(createProjectsOps({
  recordFile: join(dir, 'projects-state', 'projects.json'), stateDir: join(dir, 'projects-state'), now, root: join(dir, 'root'),
  // the starter and the build stood in for (8b-2: test/run-projects-builds-test.sh runs them for real)
  run: async (spec) => (spec.what === 'versions' ? { code: 0, stdout: '{"node":"v24.21.0","npm":"11.19.0","pnpm":"12.9.1","git":"2.39.5"}\n', stderr: '' }
    : spec.what === 'make' ? { code: 0, stdout: '$ npx --yes create-vite@latest app --template react-ts --no-interactive\n{"commit":"8c15326709167d865046c0843b0a7088c13e2b89"}\n', stderr: '' }
    : spec.what === 'build' ? { code: 0, stdout: `$ npm run build\n{"commit":"${(++e2eBuilds % 10).toString().repeat(40)}","files":8,"bytes":273585}\n`, stderr: '' }
    // 8b-3: the helper's own git (main and dev's heads; dev ahead of main once Put dev live is asked)
    // 8b-4a: systemd's view of a server's live slot: running
    : spec.what === 'show' ? { code: 0, stdout: spec.argv.filter((a) => a.endsWith('.service')).map((u) => `Id=${u}\nLoadState=loaded\nActiveState=active\nSubState=running\n`).join('\n'), stderr: '' }
    : spec.what === 'logs' ? { code: 0, stdout: '2026-10-06T01:00:00+00:00 lfdln proj-backend-main-a[1]: ▲ Next.js ready on 0.0.0.0:3000\n', stderr: '' }
    : spec.what === 'packages' ? packagesBox(spec.argv)
    : spec.what === 'registry' ? registryBox(spec.argv)
    : spec.what === 'git-head' ? { code: 0, stdout: `${spec.argv.at(-1) === 'refs/heads/dev' ? 'd'.repeat(40) : '8c15326709167d865046c0843b0a7088c13e2b89'}\n`, stderr: '' }
    : { code: 0, stdout: '', stderr: '' }),
  projectsRoot: join(dir, 'srv'), spool: join(dir, 'pushes'), safeFile: join(dir, 'safe.gitconfig'),
  // 8b-4a: every server answers at once; nginx's upstreams in a folder of the test's
  probe: async () => ({ status: 200, ms: 2 }), sleep: async () => {}, nginxDir: join(dir, 'nginx-projects'),
}));
await new Promise<void>((r) => projects.listen(join(dir, 'projects.sock'), r));
const ports = () => svcRecord.services.flatMap((s) => s.parts.map((p) => ({ service: s.id, part: p.id, port: p.port! })));

const routes = createRoutesServer(createRoutesOps({ cfg: { ...hostsConfigOf(PROFILE), dir: join(dir, 'nginx') }, run, zone, ports }));
await new Promise<void>((r) => routes.listen(join(dir, 'routes.sock'), r));

const pg = await startPg();
const database = pg.freshDatabase();
const owner = pg.connect('owner', database, 1);
await migrate(owner);
await owner.end();
const db = pg.connect('panel', database, 8);
// the home domain's row, as the installer seeds it (docs/domains-hosts-plan.md step 1)
await seedHomeDomain(db, PROFILE, now());
// the gate's admin door (docs/roles-plan.md step 6): visitors, a route's roles, the
// visitor settings -- the real gate code, over the same throwaway database
const gateDb = pg.connect('gate', database, 4);
const gateLive = new GateLive(gateDb, { sessions: visitorSessions, now });
gateLive.markReady();
await gateLive.reloadAreas();
const gateAdmin = createGateAdminServer(gateLive, now, () => {}, { publicRoot: join(dir, 'sites'), domain: PROFILE.domain, modules: PROFILE.modules, pammydbSocket: join(dir, 'pammydb.sock') });
await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
const admin = await createUser(db, now(), COMMAND_LINE, 'momolig', 'momolig', 'manager');
mkdirSync(STATE, { recursive: true });
writeFileSync(join(STATE, 'invite.json'), JSON.stringify({ origin, token: (await createInvite(db, now(), COMMAND_LINE, admin)).token }));

// the mail service, stood in for (monitoring's emails, docs/monitoring-plan.md): set up,
// and keeping each notice for GET /mail-sent
const mailSent: Record<string, unknown>[] = [];
const mail = createJsonLineServer((req) => {
  if (req.op === 'status') return { ready: true, why: null, from: 'noreply@mail.example', notifyTo: 'me@example.org', sentToday: mailSent.length, visitorSentToday: 0, visitorPerDay: 40 };
  if (req.op === 'notice') { mailSent.push(req); return { ok: true, id: `m${mailSent.length}` }; }
  throw new Error(`the stand-in mail service has no ${String(req.op)}`);
});
await new Promise<void>((r) => mail.listen(join(dir, 'mail.sock'), r));
// the apps' database: anything listening will do (the control port)
process.env.PANEL_APPDB_PORT = String(PORT - 1);
process.env.PANEL_APPMARIA_PORT = String(PORT - 1);
// a demo part that runs but answers 500 (monitoring: down, not stopped)
let webBroken = false;

const config: Config = {
  site: siteFacts(PROFILE),
  origin, rpID: 'localhost', rpName: PROFILE.panelName, pgPasswordFile: '', host: '127.0.0.1', port: PORT,
  publicDir: join(root, 'public-lfdln'), helpDir: join(dir, 'help'),
  sitefsSocket: join(dir, 'sitefs.sock'), routesSocket: join(dir, 'routes.sock'), servicesSocket: join(dir, 'services.sock'), projectsSocket: join(dir, 'projects.sock'),
  gateSocket: join(dir, 'gate.sock'),
  // File Explorer's thumbnails (step 8-1); the rest aren't lfdln's yet (phase 8); mail is a
  // stand-in that keeps what it is asked to send
  thumbsSocket: join(dir, 'thumbs.sock'), thumbsDir: join(dir, 'media-public', 'thumbs'), mediaPublicDir: join(dir, 'media-public'), pammydbSocket: join(dir, 'pammydb.sock'), appsSocket: '', mailSocket: join(dir, 'mail.sock'),
  tutorialsDir: '', tutorialExamplesDir: '', gateUrl: '', now,
};

// For the tests only, on its own port: nginx and DreamHost changing their minds, and a
// person kept to one host (permissions R5: on lfdln a place is a host), with a setup link.
const control = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/nginx-says-no') world.nginxSays = 1;
  else if (req.method === 'POST' && req.url === '/nginx-says-yes') world.nginxSays = 0;
  else if (req.method === 'POST' && req.url === '/zone-down') world.zoneUp = false;
  else if (req.method === 'POST' && req.url === '/zone-up') world.zoneUp = true;
  // monitoring (docs/monitoring-plan.md): a round now, the demo web part broken or fixed, the emails sent
  else if (req.method === 'POST' && req.url === '/monitor-round') await monitorOf.get(app)!.round();
  else if (req.method === 'POST' && req.url === '/web-broken') webBroken = true;
  else if (req.method === 'POST' && req.url === '/nameservers-moved') world.nameservers = ['ns1.example.net', 'ns2.example.net'];
  else if (req.method === 'POST' && req.url === '/monitor-round-all') await monitorOf.get(app)!.round({ all: true });
  else if (req.method === 'POST' && req.url === '/web-fixed') webBroken = false;
  else if (req.method === 'POST' && req.url?.startsWith('/url-down/')) world.urlsDown.push(req.url.slice('/url-down/'.length));
  else if (req.method === 'POST' && req.url === '/urls-up') world.urlsDown = [];
  else if (req.method === 'GET' && req.url === '/mail-sent') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mailSent)); return; }
  else if (req.method === 'POST' && req.url?.startsWith('/kept/')) {
    const host = req.url.slice('/kept/'.length);
    const u = await getUserByName(db, 'ericka') ?? await createUser(db, now(), COMMAND_LINE, 'ericka', 'Ericka');
    await setAccess(db, now(), COMMAND_LINE, u, cleanAccess(['hosts'], [`/${host}`]));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: (await createInvite(db, now(), COMMAND_LINE, u)).token }));
    return;
  } else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(204).end();
});
await new Promise<void>((r) => control.listen(PORT - 1, '127.0.0.1', r));

// The demo service's things to tag (docs/catalog-plan.md step 5): its pammy-panel.json's
// catalog section, and its list on a port of its own, signed with its key as the panel signs
const DEMO_KEY = 'demo-key-'.padEnd(44, 'x');
const demoTopics = [
  { id: 'poly-addsub', title: 'Adding polynomials', section: 'Polynomials' },
  { id: 'poly-divmono', title: 'Dividing by a monomial', section: 'Polynomials' },
  { id: 'lin-eq', title: 'Linear equations', section: 'Equations' },
];
const demoList = createServer((req, res) => {
  const ok = signedRequestOk(DEMO_KEY, { ts: req.headers['x-lfdln-timestamp'], signature: req.headers['x-lfdln-signature'] }, req.method ?? '', req.url ?? '', '', Date.now());
  if (!ok || !req.url?.startsWith('/_demo/catalog/topics?')) { res.writeHead(ok ? 404 : 401).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: demoTopics, next: null }));
});
await new Promise<void>((r) => demoList.listen(PORT - 2, '127.0.0.1', r));
const demoManifest = JSON.stringify({
  version: 1, name: 'Demo app', resources: { topics: { label: 'Topics', actions: ['read'] } },
  catalog: { topics: {
    label: 'Topics', list: '/_demo/catalog/topics', open: 'https://demo.example/practice/{id}', scopes: 'section',
    uses: { featured: { kind: 'tag', label: 'Question of the day', means: 'Picked for the daily question' } },
  } },
});

const app = buildApp(config, db, { apps: {
  manifest: async (id) => { if (id !== 'demo') throw new Error('It has no pammy-panel.json.'); return demoManifest; },
  port: async (id) => (id === 'demo' ? PORT - 2 : null),
  key: async (id) => (id === 'demo' ? DEMO_KEY : null),
} });
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`lfdln e2e panel on ${origin} (${dir})`);

const stop = () => {
  void app.close().finally(() => {
    sitefs.close();
    thumbsServer.close();
    pammydb.close();
    routes.close();
    services.close();
    mail.close();
    control.close();
    demoList.close();
    rmSync(dir, { recursive: true, force: true });
  }).then(() => db.end({ timeout: 2 })).finally(() => {
    pg.stop();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
