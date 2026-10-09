// lfdln's Hosts page, through the panel's API (docs/hosts-plan.md step 3): lfdln's own
// panel (sites/lfdln, its real profile: the hosts module on), a real folder helper on
// a throwaway sites root, and the real routing helper writing real files -- with a
// stand-in for nginx that can be told to say no (test/run-hosts-nginx-test.sh has
// the real one). Every change is made with nginx or not at all.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { cleanAccess, COMMAND_LINE, createInvite, createUser, setAccess } from '@panel/core/accounts';
import type { Config } from '@panel/core/config';
import { all, one, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { siteFacts } from '@panel/core/profile';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { createSiteFsServer } from '@panel/files/sitefs/service';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { createRoutesServer } from '@panel/hosts/helper/service';
import { adoptFolders } from '@panel/hosts/adopt';
import { seedHomeDomain } from '@panel/hosts/domains';
import { tableFrom } from '@panel/hosts/panel/routes/hosts';
import { callJsonLine } from '@panel/core/jsonline';
import { buildApp } from '@panel/lfdln/app';
import { parseMap } from '@panel/help/help';
import { createGateAdminServer } from '@panel/gate/admin';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import { SoftAuthenticator } from './authenticator.ts';
import { PROFILE } from '@panel/lfdln/profile';
import { startPg, type PgTest } from './pg-harness.ts';

const ORIGIN = 'https://panel.lesfleursdelanuit.com';
let clock = 1_800_000_000;
let dir = '';
let db: Sql;
let pgTest: PgTest;
let app: FastifyInstance;
let sitefs: ReturnType<typeof createSiteFsServer>;
let routesServer: ReturnType<typeof createRoutesServer>;
// the gate's admin door (accounts on a route, docs/roles-plan.md step 5): a real one
let gateServer: ReturnType<typeof createGateAdminServer>;
let gateDb: Sql;
let gateLive: GateLive;
let nginxSays = 0;
let zoneUp = true;
const nginxCalls: string[] = [];
const sites = () => join(dir, 'sites');
const seen: { method: string; url: string; needs?: string; wholeSite: boolean }[] = [];
const hostFile = (name: string) => join(dir, 'nginx', 'hosts', `${name}.conf`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hosts-panel-'));
  mkdirSync(sites()); mkdirSync(join(dir, 'trash')); mkdirSync(join(dir, 'help'));
  // lfdln's guides and their map, as build.sh copies them (docs/phase9-plan.md 9-1)
  const guides = new URL('../../lfdln-guides/', import.meta.url).pathname;
  for (const e of parseMap(readFileSync(join(guides, 'guides.map'), 'utf8'))) writeFileSync(join(dir, 'help', e.file), readFileSync(join(guides, e.src)));
  writeFileSync(join(dir, 'help', 'guides.map'), readFileSync(join(guides, 'guides.map')));
  pgTest = await startPg();
  const database = pgTest.freshDatabase();
  const owner = pgTest.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pgTest.connect('panel', database, 8);
  gateDb = pgTest.connect('gate', database, 4);
  gateLive = new GateLive(gateDb, { sessions: visitorSessions, now: () => clock });
  gateLive.markReady();
  await gateLive.reloadAreas();
  gateServer = createGateAdminServer(gateLive, () => clock, () => {}, { publicRoot: null, domain: PROFILE.domain, modules: PROFILE.modules });

  sitefs = createSiteFsServer({ publicDir: sites(), trashDir: join(dir, 'trash'), placementFile: join(dir, 'no-placement'), domain: PROFILE.domain, siteName: PROFILE.name,
    folderSubdomains: false, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000), hostsKeepTop: true });
  await new Promise<void>((r) => sitefs.listen(join(dir, 'sitefs.sock'), r));
  const run = async (spec: RunSpec): Promise<RunResult> => {
    nginxCalls.push(spec.what);
    if (spec.what === 'nginx-test') return { code: nginxSays, stdout: '', stderr: nginxSays ? 'nginx: [emerg] no' : '' };
    // the checks (docs/domains-hosts-plan.md step 3): every name fine, but a host called "broken-dns"
    if (spec.what === 'check') {
      const ok = { ok: true, why: 'fine' };
      return { code: 0, stderr: '', stdout: JSON.stringify((JSON.parse(spec.stdin!) as { kind: string; name: string; path?: string; names?: string[] }[]).map((t) => {
        const dns = t.name?.startsWith('byhand.') ? { ok: false, why: 'points elsewhere: 203.0.113.5', addresses: ['203.0.113.5'] } : { ...ok, addresses: ['203.0.113.200'] };
        // (step 4) a certificate file: fine unless its path says "missing"
        if (t.kind === 'cert-file') return { kind: 'cert-file', path: t.path, cert: t.path!.includes('missing') ? { ok: false, why: "can't be read as a certificate: ENOENT", notAfter: null, daysLeft: null, names: [] } : { ...ok, notAfter: 1, daysLeft: 80, names: t.names } };
        if (t.kind === 'resolve') return { kind: 'resolve', name: t.name, dns };
        return { kind: 'host', name: t.name, dns, cert: { ...ok, notAfter: 1, daysLeft: 60, names: [] }, answers: { ...ok, status: 200 } };
      })) };
    }
    if (spec.what === 'zone') return zoneUp ? { code: 0, stdout: 'lesfleursdelanuit.com A 0 1.2.3.4\nwebmail.lesfleursdelanuit.com CNAME 0 x.\n', stderr: '' } : { code: 1, stdout: '', stderr: 'down' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const { zoneReader } = await import('@panel/hosts/zone');
  // a fresh reading every time, so the tests can take the zone down
  const zone = { taken: () => zoneReader(run, ['dh', 'list'], PROFILE.domain, () => clock).taken() };
  // nginx's other sites (step 4): pammy.org's folder subdomains (a regex), and Gonsalves's hand-written exact names
  mkdirSync(join(dir, 'sites-enabled'));
  writeFileSync(join(dir, 'sites-enabled', 'pamela'), 'server {\n    server_name ~^(?!(?:www|api)\\.)(?<sub>[a-z0-9-]+)\\.pammy\\.org$;\n}\n');
  writeFileSync(join(dir, 'sites-enabled', 'gonsalves'), 'server {\n    server_name gonsalvesfamily.com www.gonsalvesfamily.com admin.gonsalvesfamily.com;\n}\n');
  routesServer = createRoutesServer(createRoutesOps({ cfg: { ...hostsConfigOf(PROFILE), dir: join(dir, 'nginx') }, run, zone, root: '/', sitesEnabled: join(dir, 'sites-enabled') }));
  await new Promise<void>((r) => routesServer.listen(join(dir, 'routes.sock'), r));
  await new Promise<void>((r) => gateServer.listen(join(dir, 'gate.sock'), r));

  const config: Config = {
    site: siteFacts(PROFILE),
    origin: ORIGIN, rpID: 'panel.lesfleursdelanuit.com', rpName: 'lesfleursdelanuit.com panel', pgPasswordFile: '',
    host: '127.0.0.1', port: 0, publicDir: new URL('../public/', import.meta.url).pathname, helpDir: join(dir, 'help'),
    sitefsSocket: join(dir, 'sitefs.sock'), gateSocket: join(dir, 'gate.sock'), now: () => clock,
    thumbsSocket: join(dir, 'thumbs.sock'), thumbsDir: join(dir, 'thumbs'), mediaPublicDir: join(dir, 'media-public'),
    pammydbSocket: join(dir, 'pammydb.sock'), appsSocket: join(dir, 'apps.sock'), mailSocket: join(dir, 'mail.sock'),
    routesSocket: join(dir, 'routes.sock'),
    tutorialsDir: new URL('../tutorials/', import.meta.url).pathname, tutorialExamplesDir: join(dir, 'tutorial-examples'),
    gateUrl: 'http://127.0.0.1:9',
  };
  app = buildApp(config, db, { onRoute: (r) => { for (const m of [r.method].flat()) seen.push({ method: String(m), url: r.url, needs: r.config?.needs, wholeSite: r.config?.wholeSite === true }); } });
});
after(async () => {
  await app?.close();
  await new Promise<void>((r) => sitefs.close(() => r()));
  await new Promise<void>((r) => routesServer.close(() => r()));
  await new Promise<void>((r) => gateServer.close(() => r()));
  await gateDb?.end({ timeout: 2 });
  await db?.end({ timeout: 2 });
  pgTest?.stop();
  rmSync(dir, { recursive: true, force: true });
});

class Browser {
  cookie = '';
  auth = new SoftAuthenticator(ORIGIN);
  ip: string;
  constructor(ip: string) { this.ip = ip; }
  async req(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const res = await app.inject({
      method, url, remoteAddress: '127.0.0.1',
      headers: { 'x-real-ip': this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { payload: JSON.stringify(payload ?? {}) } : {}),
    });
    for (const c of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = String(c).split(';');
      this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    let json: any = null;
    try { json = res.json(); } catch { /* not JSON */ }
    return { status: res.statusCode, json };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, payload?: unknown) => this.req('POST', url, payload);
  async useInvite(token: string) {
    const o = await this.post('/api/invite/options', { token });
    return this.post('/api/invite/verify', { token, name: 'test device', ceremony: o.json.ceremony, response: this.auth.create(o.json.options) });
  }
}

const admin = new Browser('203.0.113.200');
const helper = new Browser('203.0.113.201');
let helperId = 0;
const list = async (b: Browser = admin) => (await b.get('/api/hosts')).json as {
  hosts: { id: number; name: string; enabled: boolean; routes: { id: number; path: string; kind: string; folder: string | null; enabled: boolean }[] }[];
  folders: { id: number; name: string; runPhp: boolean; exists: boolean; shownAt: string[] }[];
};
const actions = async () => (await all<{ action: string; target: string; detail: string | null }>(db, 'SELECT action, target, detail FROM activity ORDER BY id'));

describe('the hosts module\'s routes (docs/permissions-plan.md R3)', () => {
  it('each says what it needs, and making or deleting a host or a folder is about the whole site', () => {
    const api = seen.filter((r) => r.url.startsWith('/api/') && r.method !== 'HEAD');
    assert.deepEqual(api.filter((r) => !r.needs).map((r) => `${r.method} ${r.url}`), []);
    const hosts = api.filter((r) => /^\/api\/(hosts|routes|site-folders)/.test(r.url)).map((r) => `${r.method} ${r.url} ${r.needs}${r.wholeSite ? ' whole-site' : ''}`).sort();
    assert.deepEqual(hosts, [
      'GET /api/hosts hosts', 'GET /api/hosts/checks hosts', 'GET /api/hosts/zone hosts whole-site',
      'POST /api/hosts hosts whole-site', 'POST /api/hosts/:id hosts', 'POST /api/hosts/:id/delete hosts whole-site', 'POST /api/hosts/:id/routes hosts',
      'POST /api/routes/:id hosts', 'POST /api/routes/:id/accounts hosts', 'POST /api/routes/:id/delete hosts',
      'POST /api/site-folders hosts whole-site', 'POST /api/site-folders/:id hosts', 'POST /api/site-folders/:id/delete hosts whole-site',
    ]);
  });
});

describe('the hosts module on lfdln', () => {
  before(async () => {
    const m = await createUser(db, clock, COMMAND_LINE, 'momolig', 'momolig', 'manager');
    assert.equal((await admin.useInvite((await createInvite(db, clock, COMMAND_LINE, m)).token)).status, 200);
    const u = await createUser(db, clock, COMMAND_LINE, 'ericka', 'Ericka');
    helperId = u.id;
    assert.equal((await helper.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });

  it('Add a static folder: the folder with its placeholder, the host of its name, and nginx', async () => {
    const r = await admin.post('/api/site-folders', { name: 'docs' });
    assert.deepEqual([r.status, r.json.address], [200, 'https://docs.lesfleursdelanuit.com/'], JSON.stringify(r.json));
    assert.ok(existsSync(join(sites(), 'docs', 'index.html')), 'the placeholder page');
    assert.match(readFileSync(hostFile('docs'), 'utf8'), /server_name docs\.lesfleursdelanuit\.com;/);
    const l = await list();
    assert.deepEqual(l.hosts.map((h) => [h.name, h.routes.map((x) => `${x.path} ${x.kind} ${x.folder}`)]), [['docs', ['/ folder docs']]]);
    assert.deepEqual(l.folders.map((f) => [f.name, f.runPhp, f.exists, f.shownAt]), [['docs', true, true, ['https://docs.lesfleursdelanuit.com/']]]);
    const acts = (await actions()).map((a) => a.action);
    assert.ok(acts.includes('site-folder-created') && acts.includes('host-created'));
  });

  it('a folder not shown anywhere yet: made, and nothing in nginx for it', async () => {
    const r = await admin.post('/api/site-folders', { name: 'drafts', host: false });
    assert.deepEqual([r.status, r.json.host], [200, null]);
    assert.ok(existsSync(join(sites(), 'drafts')) && !existsSync(hostFile('drafts')));
  });

  it('refuses the server\'s names, DreamHost\'s, names in use, and everything while the zone is down', async () => {
    for (const [name, status] of [['www', 400], ['webmail', 409], ['docs', 409], ['Bad Name', 400], ['a.b', 400], ['media', 400]] as const) {
      const r = await admin.post('/api/site-folders', { name });
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.json)}`);
    }
    assert.equal((await admin.post('/api/hosts', { name: 'webmail' })).status, 409);
    zoneUp = false;
    const down = await admin.post('/api/site-folders', { name: 'later' });
    assert.equal(down.status, 503);
    assert.ok(!existsSync(join(sites(), 'later')), 'nothing made on disk');
    assert.equal((await admin.get('/api/hosts/zone')).json.ok, false);
    zoneUp = true;
    assert.deepEqual((await admin.get('/api/hosts/zone')).json.taken, ['webmail']);
  });

  it('nginx says no: nothing is kept -- not the row, not the host, and the new folder goes to the trash', async () => {
    nginxSays = 1;
    const r = await admin.post('/api/site-folders', { name: 'broken' });
    assert.equal(r.status, 502);
    assert.match(r.json.message, /put back as it was/);
    nginxSays = 0;
    assert.equal(await one(db, "SELECT 1 FROM site_folders WHERE name = 'broken'"), undefined);
    assert.equal(await one(db, "SELECT 1 FROM hosts WHERE name = 'broken'"), undefined);
    assert.ok(!existsSync(join(sites(), 'broken')), 'not left on disk');
    assert.ok(readdirSync(join(dir, 'trash')).some((e) => e.startsWith('broken--')), 'in the trash');
    assert.ok(!existsSync(hostFile('broken')));
  });

  it('routes on a host: a redirect, stopped and started, a single-page app, and removed', async () => {
    const docs = (await list()).hosts.find((h) => h.name === 'docs')!;
    const r = await admin.post(`/api/hosts/${docs.id}/routes`, { path: 'old', kind: 'redirect', to: 'https://example.com/new', status: 301 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(readFileSync(hostFile('docs'), 'utf8'), /location \^~ \/old\/ \{ rewrite \^\/old\/\(\.\*\)\$ https:\/\/example\.com\/new\/\$1 permanent; \}/);
    assert.equal((await admin.post(`/api/hosts/${docs.id}/routes`, { path: '/old/', kind: 'redirect', to: '/', status: 302 })).status, 409, 'a path once');
    assert.equal((await admin.post(`/api/hosts/${docs.id}/routes`, { path: '/loop/', kind: 'redirect', to: '/loop/x', status: 302 })).status, 400, 'a loop');
    assert.equal((await admin.post(`/api/hosts/${docs.id}/routes`, { path: '/x/', kind: 'redirect', to: 'https://x.com/$host', status: 302 })).status, 400);
    await admin.post(`/api/routes/${r.json.id}`, { enabled: false });
    assert.doesNotMatch(readFileSync(hostFile('docs'), 'utf8'), /\/old\//);
    await admin.post(`/api/routes/${r.json.id}`, { enabled: true });
    assert.match(readFileSync(hostFile('docs'), 'utf8'), /\/old\//);
    const top = (await list()).hosts.find((h) => h.name === 'docs')!.routes.find((x) => x.path === '/')!;
    await admin.post(`/api/routes/${top.id}`, { spa: true });
    assert.match(readFileSync(hostFile('docs'), 'utf8'), /try_files \$uri \$uri\/ \/index\.html;/);
    assert.equal((await admin.post(`/api/routes/${r.json.id}/delete`)).status, 200);
    assert.doesNotMatch(readFileSync(hostFile('docs'), 'utf8'), /\/old\//);
    assert.ok((await actions()).some((a) => a.action === 'route-changed' && a.detail === 'single-page app: on'));
  });

  it('Run PHP pages, and a host stopped and started', async () => {
    const l = await list();
    const docs = l.folders.find((f) => f.name === 'docs')!;
    await admin.post(`/api/site-folders/${docs.id}`, { runPhp: false });
    assert.doesNotMatch(readFileSync(hostFile('docs'), 'utf8'), /fastcgi_pass/);
    const h = l.hosts.find((x) => x.name === 'docs')!;
    await admin.post(`/api/hosts/${h.id}`, { enabled: false });
    assert.ok(!existsSync(hostFile('docs')), 'a host switched off has no file: the catch-all answers');
    await admin.post(`/api/hosts/${h.id}`, { enabled: true });
    assert.ok(existsSync(hostFile('docs')));
  });

  it('someone kept to a host: that host, the folders it shows, and nothing about the whole site', async () => {
    // a second host and folder they must not see
    assert.equal((await admin.post('/api/site-folders', { name: 'other' })).status, 200);
    assert.equal((await admin.post(`/api/users/${helperId}/access`, { rights: ['hosts'], places: ['/nope'] })).status, 404, 'a place on lfdln is a host');
    assert.equal((await admin.post(`/api/users/${helperId}/access`, { rights: ['hosts'], places: ['/docs'] })).status, 200);
    const l = await list(helper);
    assert.deepEqual([l.hosts.map((h) => h.name), l.folders.map((f) => f.name)], [['docs'], ['docs']]);
    const all = await list();
    const other = all.hosts.find((h) => h.name === 'other')!;
    const otherFolder = all.folders.find((f) => f.name === 'other')!;
    const docs = all.hosts.find((h) => h.name === 'docs')!;
    for (const [url, b] of [['/api/hosts', { name: 'mine' }], ['/api/site-folders', { name: 'mine' }], [`/api/hosts/${docs.id}/delete`, {}], [`/api/site-folders/${otherFolder.id}/delete`, {}]] as const) {
      assert.equal((await helper.post(url, b)).status, 404, url);
    }
    assert.equal((await helper.get('/api/hosts/zone')).status, 404);
    assert.equal((await helper.post(`/api/hosts/${other.id}`, { enabled: false })).status, 404);
    assert.equal((await helper.post(`/api/hosts/${other.id}/routes`, { path: '/x/', kind: 'redirect', to: '/', status: 302 })).status, 404);
    assert.equal((await helper.post(`/api/hosts/${docs.id}/routes`, { path: '/x/', kind: 'folder', folderId: otherFolder.id })).status, 404, 'not a folder of theirs');
    const mine = await helper.post(`/api/hosts/${docs.id}/routes`, { path: '/help/', kind: 'redirect', to: '/', status: 302, keepPath: false });
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.equal((await helper.post(`/api/site-folders/${all.folders.find((f) => f.name === 'docs')!.id}`, { runPhp: true })).status, 200);
    // File Explorer (docs/phase8-plan.md step 8-1): kept to the folders their hosts show (P8-2),
    // each file's address through those hosts' routes, and the top Hosts' (P8-1)
    assert.equal((await admin.post(`/api/users/${helperId}/access`, { rights: ['hosts', 'files'], places: ['/docs'] })).status, 200);
    const files = await helper.get('/api/files');
    assert.equal(files.status, 200, JSON.stringify(files.json));
    assert.deepEqual(files.json.limitedTo, ['docs']);
    assert.ok(files.json.dirs.every((d: string) => d === 'docs' || d.startsWith('docs/')), JSON.stringify(files.json.dirs));
    assert.deepEqual((await helper.get('/api/files/shown')).json.shown, { docs: ['https://docs.lesfleursdelanuit.com/'] });
    assert.deepEqual(Object.keys((await admin.get('/api/files/shown')).json.shown).sort(), ['docs', 'other']);
    assert.equal((await helper.get('/api/files/list?dir=other')).status, 404);
    assert.equal((await helper.post('/api/files/mkdir', { dir: 'docs', name: 'notes' })).status, 200);
    const atTop = await admin.post('/api/files/mkdir', { dir: '', name: 'sneaky' });
    assert.equal(atTop.status, 400);
    assert.match(atTop.json.message, /Hosts page/);
    assert.equal((await admin.post('/api/files/trash', { path: 'other' })).status, 400, 'a site folder goes on the Hosts page');
    // kept to a host that shows no folder: nothing at all
    assert.equal((await admin.post('/api/hosts', { name: 'bare' })).status, 200);
    assert.equal((await admin.post(`/api/users/${helperId}/access`, { rights: ['hosts', 'files'], places: ['/bare'] })).status, 200);
    assert.deepEqual((await helper.get('/api/files')).json.dirs, []);
    assert.equal((await helper.get('/api/files/list?dir=docs')).status, 404);
    await setAccess(db, clock, COMMAND_LINE, (await one(db, 'SELECT * FROM users WHERE id = ?', helperId)) as never, cleanAccess([], []));
  });

  it('delete a site folder: its routes first, then the folder to the trash; one on the server before the panel stays', async () => {
    const l = await list();
    const other = l.folders.find((f) => f.name === 'other')!;
    const r = await admin.post(`/api/site-folders/${other.id}/delete`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!existsSync(join(sites(), 'other')) && !existsSync(hostFile('other')), 'the host has no route left, so no file');
    assert.ok(readdirSync(join(dir, 'trash')).some((e) => e.startsWith('other--')));
    await db`UPDATE panel.site_folders SET adopted = true WHERE name = 'docs'`;
    const docs = l.folders.find((f) => f.name === 'docs')!;
    assert.equal((await admin.post(`/api/site-folders/${docs.id}/delete`)).status, 409);
    assert.ok(existsSync(join(sites(), 'docs')));
  });

  it('a host deleted takes its routes, and leaves its folders', async () => {
    const docs = (await list()).hosts.find((h) => h.name === 'docs')!;
    assert.equal((await admin.post(`/api/hosts/${docs.id}/delete`)).status, 200);
    assert.ok(!existsSync(hostFile('docs')));
    assert.equal((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM routes"))!.n, 0);
    assert.ok((await list()).folders.some((f) => f.name === 'docs'));
    assert.ok(nginxCalls.includes('nginx-reload'));
  });
});

// Taking over the stopgap (docs/hosts-plan.md H10): what it served stays served.
describe('Help on lfdln (docs/phase9-plan.md 9-1)', () => {
  it("lists lfdln's own guides, and none of Pamela's", async () => {
    const r = await admin.get('/api/help');
    assert.equal(r.status, 200);
    const files = r.json.guides.map((g: { file: string }) => g.file);
    assert.deepEqual(files, ['01-start-here.txt', '02-domains-hosts-and-routes.txt', '03-site-folders.txt', '04-services-and-monitoring.txt',
      '05-visitors.txt', '06-forms-and-comments.txt', '07-databases.txt']);
    assert.ok(!files.some((f: string) => /README|control-panel|wordpress/.test(f)), files.join(' '));
    assert.equal(r.json.guides.find((g: { file: string }) => g.file === '05-visitors.txt').title, 'Visitors: accounts, roles and access');
  });

  it('asks only to be signed in', () => {
    const help = seen.filter((s) => s.url === '/api/help');
    assert.ok(help.length && help.every((s) => s.needs === 'signed-in'));
  });
});

// The first-steps card on Home (docs/phase9-plan.md 9-3): a second passkey, the guide to
// read first, and the guide about each part the person can change.
describe('first steps on lfdln (docs/phase9-plan.md 9-3)', () => {
  const steps = async (b: Browser) => (await b.get('/api/first-steps')).json as {
    hidden: boolean; passkeys: number; read: { slug: string; title: string; done: boolean } | null; guides: Record<string, { slug: string; title: string }>;
  };

  it('the admin: one passkey, Start here not read, and a guide for each part a guide names', async () => {
    const d = await steps(admin);
    assert.deepEqual([d.hidden, d.passkeys, d.read], [false, 1, { slug: 'start-here', title: 'Start here', done: false }]);
    assert.deepEqual(Object.fromEntries(Object.entries(d.guides).map(([r, g]) => [r, g.slug])), {
      files: 'site-folders', media: 'site-folders', forms: 'forms-and-comments', responses: 'forms-and-comments', comments: 'forms-and-comments',
      protected: 'visitors', databases: 'databases', hosts: 'domains-hosts-and-routes', services: 'services-and-monitoring',
    });
  });

  it('someone with no parts gets no guides; kept to a host with hosts, only the hosts guide', async () => {
    assert.deepEqual((await steps(helper)).guides, {});
    const u = (await one(db, 'SELECT * FROM users WHERE id = ?', helperId)) as never;
    await setAccess(db, clock, COMMAND_LINE, u, cleanAccess(['hosts'], ['/docs']));
    try {
      assert.deepEqual(Object.keys((await steps(helper)).guides), ['hosts']);
    } finally {
      await setAccess(db, clock, COMMAND_LINE, u, cleanAccess([], []));
    }
  });

  it('"I\'ve read it", put away and back again, each for this account only', async () => {
    assert.equal((await helper.post('/api/first-steps', { read: true })).status, 200);
    assert.equal((await helper.post('/api/first-steps', { hidden: true })).status, 200);
    assert.deepEqual([(await steps(helper)).read?.done, (await steps(helper)).hidden], [true, true]);
    assert.deepEqual([(await steps(admin)).read?.done, (await steps(admin)).hidden], [false, false]);
    assert.equal((await helper.post('/api/first-steps', { read: false, hidden: false })).status, 200);
    assert.deepEqual([(await steps(helper)).read?.done, (await steps(helper)).hidden], [false, false]);
  });

  it('refuses anything but read or hidden, true or false', async () => {
    for (const b of [{}, { read: 'yes' }, { read: true, extra: 1 }, { done: true }]) {
      assert.equal((await helper.post('/api/first-steps', b)).status, 400, JSON.stringify(b));
    }
    assert.equal((await new Browser('203.0.113.202').get('/api/first-steps')).status, 401);
  });

  it('a second passkey ticks it', async () => {
    const o = await helper.post('/api/me/passkeys/options');
    assert.equal(o.status, 200, JSON.stringify(o.json));
    const v = await helper.post('/api/me/passkeys/verify', { ceremony: o.json.ceremony, name: 'laptop', response: new SoftAuthenticator(ORIGIN).create(o.json.options) });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal((await steps(helper)).passkeys, 2);
  });

  it('asks only to be signed in', () => {
    const fs = seen.filter((s) => s.url === '/api/first-steps');
    assert.deepEqual(fs.map((s) => `${s.method} ${s.needs}`).sort(), ['GET signed-in', 'HEAD signed-in', 'POST signed-in']);
  });
});

describe('adopting the folders already there', () => {
  const apply = (table: unknown) => callJsonLine(join(dir, 'routes.sock'), { op: 'apply', table }, 'the routing helper');
  const onDisk = () => readdirSync(sites()).filter((n) => !n.startsWith('.'));

  it('refused by nginx: nothing is written', async () => {
    mkdirSync(join(sites(), 'blog'));
    nginxSays = 1;
    try {
      await assert.rejects(adoptFolders(db, { now: clock, onDisk: onDisk(), actor: 'lfdln installer', apply }));
    } finally { nginxSays = 0; }
    assert.equal(await one(db, "SELECT 1 FROM site_folders WHERE name = 'blog'"), undefined);
    assert.ok(!existsSync(hostFile('blog')));
  });

  it('each folder a site folder, adopted, shown at its own host as before (PHP off, as the stopgap)', async () => {
    mkdirSync(join(sites(), 'www'));            // a name kept for the server: adopted, not shown
    mkdirSync(join(sites(), 'Old_Stuff'));      // not a name a site folder can have: left alone
    const r = await adoptFolders(db, { now: clock, onDisk: onDisk(), actor: 'lfdln installer', apply });
    assert.deepEqual(r.shown, ['blog']);
    assert.deepEqual(r.adopted.sort(), ['blog', 'www']);
    assert.deepEqual(r.skipped.map((s) => s.name).sort(), ['Old_Stuff', 'www']);
    const blog = (await one<{ adopted: boolean; run_php: boolean }>(db, "SELECT adopted, run_php FROM site_folders WHERE name = 'blog'"))!;
    assert.deepEqual([blog.adopted, blog.run_php], [true, false]);
    assert.match(readFileSync(hostFile('blog'), 'utf8'), /root .*\/blog;/);
    assert.ok(!existsSync(hostFile('www')));
    const l = await admin.get('/api/hosts');
    assert.ok(l.json.folders.some((f: { name: string; adopted: boolean }) => f.name === 'blog' && f.adopted));
    assert.equal((await admin.post(`/api/site-folders/${l.json.folders.find((f: { name: string }) => f.name === 'blog').id}/delete`)).status, 409, 'an adopted folder stays');
    const act = await all<{ action: string; target: string }>(db, "SELECT action, target FROM activity WHERE action = 'site-folder-adopted' ORDER BY target");
    assert.deepEqual(act.map((a) => a.target), ['blog', 'www']);
  });

  it('a second time changes nothing', async () => {
    const before = await all(db, 'SELECT * FROM site_folders ORDER BY id');
    const r = await adoptFolders(db, { now: clock, onDisk: onDisk(), actor: 'lfdln installer', apply });
    assert.deepEqual([r.adopted, r.shown], [[], []]);
    assert.deepEqual(await all(db, 'SELECT * FROM site_folders ORDER BY id'), before);
  });

  // (exam prep's old folder, 2026-10-10: its host now goes to the Next.js service)
  it('one that was there before the panel goes to the trash once no route shows it, not before', async () => {
    const l = (await admin.get('/api/hosts')).json as { folders: { id: number; name: string }[]; hosts: { id: number; name: string; routes: { id: number }[] }[] };
    const blog = l.folders.find((f) => f.name === 'blog')!;
    const refused = await admin.post(`/api/site-folders/${blog.id}/delete`);
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.json), /remove the route at https:\/\/blog\.lesfleursdelanuit\.com\/ first/);
    // its route goes elsewhere (here: removed), and then the folder can go
    const route = l.hosts.find((h) => h.name === 'blog')!.routes[0]!;
    assert.equal((await admin.post(`/api/routes/${route.id}/delete`)).status, 200);
    const r = await admin.post(`/api/site-folders/${blog.id}/delete`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!existsSync(join(sites(), 'blog')));
    assert.ok(readdirSync(join(dir, 'trash')).some((e) => e.startsWith('blog--')), 'in the trash, for 30 days');
    assert.equal(await one(db, "SELECT 1 FROM site_folders WHERE name = 'blog'"), undefined);
    // its host was made with it (adopt-folders), and goes with it now that nothing is on it
    assert.equal(await one(db, "SELECT 1 FROM hosts WHERE name = 'blog'"), undefined);
    const act = (await actions()).filter((a) => a.action === 'site-folder-deleted').at(-1)!;
    assert.deepEqual([act.target, /before the panel/.test(act.detail ?? '')], ['blog', true]);
    // one that was never shown (www, a name kept for the server) goes the same way
    const www = l.folders.find((f) => f.name === 'www')!;
    assert.equal((await admin.post(`/api/site-folders/${www.id}/delete`)).status, 200);
  });
});

// docs/roles-plan.md step 5 (S5-3, S5-6): a route's accounts, through the panel. The
// gate keeps the area; the route its token; nginx follows the table.
describe('accounts on a route', () => {
  let host: { id: number; routes: { id: number; path: string; kind: string }[] };
  let route: number;
  const accounts = (id: number, value: unknown, b: Browser = admin) => b.post(`/api/routes/${id}/accounts`, { accounts: value });
  const token = async (id: number) => (await one<{ area_token: string | null; accounts: string | null }>(db, 'SELECT area_token, accounts FROM routes WHERE id = ?', id))!;

  before(async () => {
    assert.equal((await admin.post('/api/site-folders', { name: 'club' })).status, 200);
    host = (await list()).hosts.find((h) => h.name === 'club')!;
    route = host.routes[0]!.id;
  });

  it('the page is told whether "Open with accounts" is on', async () => {
    assert.deepEqual((await admin.get('/api/hosts')).json.accounts, { open: false });
  });

  it('Only people let in: the area in the gate, its token on the route, the gate in nginx', async () => {
    const r = await accounts(route, 'private');
    assert.deepEqual([r.status, r.json.accounts], [200, 'private'], JSON.stringify(r.json));
    const t = await token(route);
    assert.match(t.area_token!, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(t.accounts, 'private');
    const f = readFileSync(hostFile('club'), 'utf8');
    assert.match(f, new RegExp(`auth_request /_pammy/check/${t.area_token};`));
    const st = await callJsonLine<{ areas: { kind: string; routeId: number; label: string; token: string }[] }>(join(dir, 'gate.sock'), { op: 'state' }, 'gate');
    assert.deepEqual(st.areas.map((a) => [a.kind, a.routeId, a.label, a.token]), [['route', route, 'club.lesfleursdelanuit.com/', t.area_token]]);
    const l = (await admin.get('/api/hosts')).json;
    assert.equal(l.hosts.find((h: { name: string }) => h.name === 'club').routes[0].accounts, 'private');
    assert.ok((await actions()).some((a) => a.action === 'route-accounts' && a.detail === 'only people let in'));
  });

  it('Open with accounts needs its switch; with it on, the same area moves over', async () => {
    const before = (await token(route)).area_token;
    const off = await accounts(route, 'open');
    assert.equal(off.status, 400);
    assert.match(off.json.message, /"Open with accounts" is switched off/);
    for (const k of ['emailedLinks', 'selfRegister', 'openAreas'] as const) await setVisitorSwitch(gateDb, clock, k, true, 'test', { mail: true });
    assert.deepEqual((await admin.get('/api/hosts')).json.accounts, { open: true });
    const on = await accounts(route, 'open');
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.deepEqual(await token(route), { area_token: before, accounts: 'open' });
  });

  it('nginx says no: the route keeps what it had', async () => {
    const other = (await list()).folders.find((f) => f.name === 'drafts')!;
    const add = await admin.post(`/api/hosts/${host.id}/routes`, { path: 'drafts', kind: 'folder', folderId: other.id });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    nginxSays = 1;
    try {
      assert.equal((await accounts(add.json.id, 'private')).status, 502);
    } finally { nginxSays = 0; }
    assert.deepEqual(await token(add.json.id), { area_token: null, accounts: null });
    const st = await callJsonLine<{ areas: { routeId: number }[] }>(join(dir, 'gate.sock'), { op: 'state' }, 'gate');
    assert.ok(!st.areas.some((a) => a.routeId === add.json.id), 'and the gate made no area for it');
    assert.equal((await admin.post(`/api/routes/${add.json.id}/delete`)).status, 200);
  });

  it('refuses a redirect, and nothing with accounts is deleted by accident', async () => {
    const r = await admin.post(`/api/hosts/${host.id}/routes`, { path: 'old', kind: 'redirect', to: 'https://example.com/', status: 302 });
    assert.equal((await accounts(r.json.id, 'private')).status, 400);
    assert.equal((await accounts(route, 'nope')).status, 400);
    const del = await admin.post(`/api/routes/${route}/delete`);
    assert.equal(del.status, 409);
    assert.match(del.json.message, /has accounts: set it to "Open to anyone" first/);
    assert.equal((await admin.post(`/api/hosts/${host.id}/delete`)).status, 409);
    const club = (await list()).folders.find((f) => f.name === 'club')!;
    assert.equal((await admin.post(`/api/site-folders/${club.id}/delete`)).status, 409);
  });

  // docs/roles-plan.md step 6: the Hosts page links a route to its Access page, and Read
  // again takes the pammy-panel.json at its site folder's top
  it("a route with accounts links to its Access page; Read again takes its folder's pammy-panel.json", async () => {
    const r = (await admin.get('/api/hosts')).json.hosts.find((h: { name: string }) => h.name === 'club').routes[0];
    const st = await callJsonLine<{ areas: { id: number; routeId: number }[] }>(join(dir, 'gate.sock'), { op: 'state' }, 'gate');
    assert.equal(r.accessId, st.areas.find((a) => a.routeId === route)!.id);
    const page = await admin.get(`/api/access/${r.accessId}`);
    assert.equal(page.status, 200, JSON.stringify(page.json));
    assert.deepEqual([page.json.area.kind, page.json.area.path, page.json.set.label], ['route', 'club.lesfleursdelanuit.com/', 'Open with accounts']);
    await setVisitorSwitch(gateDb, clock, 'roles', true, 'test', { mail: true });
    try {
      const none = await admin.post(`/api/access/${r.accessId}/manifest`);
      assert.equal(none.status, 404);
      assert.match(none.json.message, /There's no pammy-panel\.json at the top of "club"/);
      // docs/catalog-plan.md step 5: only a service's may offer things to tag
      const exam = JSON.parse(readFileSync(new URL('./fixtures/examprep-pammy-panel.json', import.meta.url), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(sites(), 'club', 'pammy-panel.json'), JSON.stringify({ ...exam, catalog: { topics: { label: 'Topics', list: '/topics' } } }));
      const folderCatalog = await admin.post(`/api/access/${r.accessId}/manifest`);
      assert.equal(folderCatalog.status, 400);
      assert.match(folderCatalog.json.message, /has a "catalog" section, and only a service's can/);
      writeFileSync(join(sites(), 'club', 'pammy-panel.json'), readFileSync(new URL('./fixtures/examprep-pammy-panel.json', import.meta.url), 'utf8'));
      const read = await admin.post(`/api/access/${r.accessId}/manifest`);
      assert.equal(read.status, 200, JSON.stringify(read.json));
      const after = await admin.get(`/api/access/${r.accessId}`);
      assert.deepEqual(after.json.roles.map((x: { label: string }) => x.label).sort(), ['Not signed in', 'Student', 'Teacher']);
      assert.ok((await actions()).some((a) => a.action === 'manifest-read' && a.target === 'club.lesfleursdelanuit.com/'));
    } finally {
      await setVisitorSwitch(gateDb, clock, 'roles', false, 'test', { mail: true }).catch(() => {});
    }
  });

  it('Open to anyone: nginx first, then the area, and whose role went with it', async () => {
    const v = await callJsonLine<{ id: number }>(join(dir, 'gate.sock'), { op: 'visitor.create', username: 'jo', password: 'jo-password-123' }, 'gate');
    const st = await callJsonLine<{ areas: { id: number; routeId: number }[] }>(join(dir, 'gate.sock'), { op: 'state' }, 'gate');
    // (the route is on the app's roles since Read again: jo is given Student)
    const areaId = st.areas.find((a) => a.routeId === route)!.id;
    const roles = await callJsonLine<{ roles: { id: number; label: string }[] }>(join(dir, 'gate.sock'), { op: 'access.state', areaId }, 'gate');
    await setVisitorSwitch(gateDb, clock, 'roles', true, 'test', { mail: true });
    await callJsonLine(join(dir, 'gate.sock'), { op: 'access.person', areaId, visitorId: v.id, roleId: roles.roles.find((x) => x.label === 'Student')!.id }, 'gate');
    const r = await accounts(route, null);
    assert.deepEqual([r.status, r.json.lost], [200, ['jo']]);
    assert.deepEqual(await token(route), { area_token: null, accounts: null });
    assert.doesNotMatch(readFileSync(hostFile('club'), 'utf8'), /auth_request|_pammy\/check|@lfdln_login/, 'nothing asks the gate (its /_pammy/ pages stay: 8-2)');
    assert.ok((await actions()).some((a) => a.action === 'route-accounts' && /1 person lost their role there \(jo\)/.test(a.detail ?? '')));
    assert.equal((await admin.post(`/api/hosts/${host.id}/delete`)).status, 200, 'and now it can go');
    await setVisitorSwitch(gateDb, clock, 'roles', false, 'test', { mail: true });
  });
});

// docs/domains-hosts-plan.md step 1: the site's own domain as a row, seeded by the
// installer from the profile; hosts on it, and where each came from.
describe('the home domain, as data', () => {
  const apply = (table: unknown) => callJsonLine<{ changed: string[]; removed: string[] }>(join(dir, 'routes.sock'), { op: 'apply', table }, 'the routing helper');

  it('hosts say where they came from: by hand, or with their folder', async () => {
    assert.equal((await admin.post('/api/site-folders', { name: 'withhost' })).status, 200);
    assert.equal((await admin.post('/api/hosts', { name: 'byhand' })).status, 200);
    const rows = await all<{ name: string; origin: string; domain_id: number | null }>(db, "SELECT name, origin, domain_id FROM hosts WHERE name IN ('withhost', 'byhand') ORDER BY name");
    assert.deepEqual(rows.map((r) => [r.name, r.origin, r.domain_id]), [['byhand', 'hand', null], ['withhost', 'folder', null]]);
  });

  it('seeded from the profile: the row, every host on it, and nginx byte for byte as it was', async () => {
    const r = await seedHomeDomain(db, PROFILE, clock);
    assert.deepEqual([r.made, r.name], [true, 'lesfleursdelanuit.com']);
    assert.ok(r.hosts > 0);
    const d = (await one<{ id: number; dns: string; front: string; cert: string; wildcard_record: boolean; folder_hosts: boolean; tls: unknown }>(db, 'SELECT * FROM domains WHERE home'))!;
    assert.deepEqual([d.dns, d.front, d.cert, d.wildcard_record, d.folder_hosts], ['dreamhost', 'direct', 'wildcard-dns', true, false]);
    assert.deepEqual(d.tls, PROFILE.hosts.tls);
    assert.equal((await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hosts WHERE domain_id IS NULL'))!.n, 0);
    const t = await tableFrom(db);
    assert.deepEqual(t.domains, [{ name: 'lesfleursdelanuit.com', home: true, tls: PROFILE.hosts.tls, front: 'direct' }]);
    const a = await apply(t);
    assert.deepEqual([a.changed, a.removed], [[], []], 'the same files as the profile gave');
  });

  it('a host made after is on it; a second seed changes nothing; a profile with another domain is refused', async () => {
    assert.equal((await admin.post('/api/hosts', { name: 'later' })).status, 200);
    const home = (await one<{ id: number }>(db, 'SELECT id FROM domains WHERE home'))!.id;
    assert.equal((await one<{ domain_id: number }>(db, "SELECT domain_id FROM hosts WHERE name = 'later'"))!.domain_id, home);
    const before = await all(db, 'SELECT * FROM domains');
    assert.deepEqual(await seedHomeDomain(db, PROFILE, clock + 5), { made: false, name: 'lesfleursdelanuit.com', hosts: 0 });
    assert.deepEqual(await all(db, 'SELECT * FROM domains'), before);
    await assert.rejects(seedHomeDomain(db, { ...PROFILE, domain: 'example.com' }, clock), /home domain is lesfleursdelanuit\.com/);
    await assert.rejects(db`INSERT INTO panel.domains (name, home, dns, front, cert, tls, created_at) VALUES ('example.com', true, 'manual', 'direct', 'files', '{"cert":"/etc/ssl/a","key":"/etc/ssl/b"}', 1)`, /domains_one_home/);
  });

  it('a site folder deleted takes the host made with it, not one made by hand', async () => {
    const l = await list();
    const f = l.folders.find((x) => x.name === 'withhost')!;
    assert.equal((await admin.post(`/api/site-folders/${f.id}/delete`)).status, 200);
    const names = (await list()).hosts.map((h) => h.name);
    assert.ok(!names.includes('withhost') && names.includes('byhand'), names.join(' '));
    assert.match((await actions()).at(-1)!.detail ?? '', /the host https:\/\/withhost\.lesfleursdelanuit\.com\/ made with it/);
  });
});

// docs/domains-hosts-plan.md step 2: what a route may show is the site's kinds.
describe('target kinds on the Hosts page', () => {
  it('the page is told the kinds, and a route of any other is refused', async () => {
    const l = (await admin.get('/api/hosts')).json;
    assert.deepEqual(l.kinds, [{ kind: 'folder', label: 'Show a site folder' }, { kind: 'service', label: 'Go to a service' }, { kind: 'project', label: 'Show a project' }, { kind: 'redirect', label: 'Redirect' }]);
    const h = l.hosts.find((x: { name: string }) => x.name === 'byhand');
    const r = await admin.post(`/api/hosts/${h.id}/routes`, { path: '/tea/', kind: 'teapot' });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /show a site folder, or go to a service, or show a project, or redirect/);
  });

  it('a redirect made from the page keeps its fields as target_ref, and the list shows them as before', async () => {
    const h = (await list()).hosts.find((x) => x.name === 'byhand')!;
    assert.equal((await admin.post(`/api/hosts/${h.id}/routes`, { path: '/go/', kind: 'redirect', to: 'https://example.com/', status: 301, keepPath: false })).status, 200);
    const row = (await one<{ target_kind: string; target_ref: unknown; folder_id: number | null }>(db, "SELECT target_kind, target_ref, folder_id FROM routes WHERE path = '/go/'"))!;
    assert.deepEqual([row.target_kind, row.target_ref, row.folder_id], ['redirect', { to: 'https://example.com/', status: 301, keepPath: false }, null]);
    const shown = ((await admin.get('/api/hosts')).json.hosts as { name: string; routes: Record<string, unknown>[] }[]).find((x) => x.name === 'byhand')!.routes.find((x) => x.path === '/go/')!;
    assert.deepEqual([shown.kind, shown.to, shown.status, shown.keepPath], ['redirect', 'https://example.com/', 301, false]);
    assert.match(readFileSync(hostFile('byhand'), 'utf8'), /# \/go\/: redirect 301 to https:\/\/example\.com\//);
  });
});

// docs/domains-hosts-plan.md step 3: the checks on the Hosts page.
describe('the checks on the Hosts page', () => {
  it('each host a person may see, every name it answers to, with what failed and why', async () => {
    const r = await admin.get('/api/hosts/checks');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const hosts = (await list()).hosts;
    const byhand = hosts.find((h) => h.name === 'byhand')!;
    const c = r.json.hosts.find((h: { id: number }) => h.id === byhand.id).checks;
    assert.deepEqual(c.map((x: { name: string; dns: { ok: boolean; why: string } }) => [x.name, x.dns.ok, x.dns.why]), [['byhand.lesfleursdelanuit.com', false, 'points elsewhere: 203.0.113.5']]);
    assert.equal(r.json.hosts.length, hosts.length);
    // again: asked now, and not again within the minute
    const again = await admin.get('/api/hosts/checks?again=1');
    assert.ok(again.json.againIn > 0);
    // someone kept to a host sees only theirs
    const u = (await one(db, 'SELECT * FROM users WHERE id = ?', helperId)) as never;
    await setAccess(db, clock, COMMAND_LINE, u, cleanAccess(['hosts'], ['/byhand']));
    const mine = await helper.get('/api/hosts/checks');
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.deepEqual(mine.json.hosts.map((h: { id: number }) => h.id), [byhand.id]);
    await setAccess(db, clock, COMMAND_LINE, u, cleanAccess([], []));
    assert.equal((await helper.get('/api/hosts/checks')).status, 404);
  });
});

// docs/domains-hosts-plan.md step 4: the domains, the setup guide's checks, Add a domain.
describe('domains and the setup guide', () => {
  const LE = (d: string) => ({ cert: `/etc/letsencrypt/live/wildcard.${d}/fullchain.pem`, key: `/etc/letsencrypt/live/wildcard.${d}/privkey.pem`,
    include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' });
  const answers = (name: string, more: Record<string, unknown> = {}) => ({ name, dns: 'manual', front: 'direct', wildcardRecord: true, cert: 'wildcard-dns', tls: LE(name), ...more });

  it('the home domain, and every one of its checks green', async () => {
    const l = await admin.get('/api/domains');
    assert.equal(l.status, 200);
    const home = l.json.domains[0];
    assert.deepEqual([home.name, home.home, home.dns, home.cert, home.wildcardRecord, home.hosts > 0], ['lesfleursdelanuit.com', true, 'dreamhost', 'wildcard-dns', true, true]);
    const c = await admin.get(`/api/domains/${home.id}/checks`);
    assert.deepEqual(c.json.checks.map((x: { key: string; ok: boolean }) => [x.key, x.ok]), [['name', true], ['nginx', true], ['dns', true], ['wildcard', true], ['certificate', true], ['zone', true]]);
    assert.equal(c.json.ok, true);
    assert.equal((await one<{ zone_readable: boolean }>(db, 'SELECT zone_readable FROM domains WHERE home'))!.zone_readable, true);
    // for someone kept to a host: not theirs to see
    assert.equal((await helper.get('/api/domains')).status, 404);
  });

  it('the guide\'s checks: nginx already answering by regex for every name under it refuses; hand-written exact names are fine', async () => {
    const pammy = await admin.post('/api/domains/check', answers('pammy.org'));
    const n = pammy.json.checks.find((x: { key: string }) => x.key === 'nginx');
    assert.deepEqual([n.ok, n.required, pammy.json.ok], [false, true, false]);
    assert.match(n.why, /already answered by sites-enabled\/pamela/);
    const g = await admin.post('/api/domains/check', answers('gonsalvesfamily.com', { dns: 'dreamhost' }));
    assert.equal(g.json.ok, true, JSON.stringify(g.json));
    assert.match(g.json.checks.find((x: { key: string }) => x.key === 'nginx').why, /hand-written sites answer for admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com/);
    assert.match(g.json.checks.find((x: { key: string }) => x.key === 'zone').why, /reads lesfleursdelanuit\.com only/);
    for (const [b, re] of [[answers('Not A Domain'), /A domain is/], [answers('x.com', { tls: { cert: '/root/c.pem', key: '/root/k.pem' } }), /isn't under/], [answers('x.com', { cert: 'per-host' }), /The certificate is one of/]] as const) {
      const r = await admin.post('/api/domains/check', b);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.match(JSON.stringify(r.json), re);
    }
  });

  it('Turn on: refused while a needed check fails; then the row, its catch-all in nginx, and a made-up name asked', async () => {
    const missing = await admin.post('/api/domains', answers('gonsalvesfamily.com', { tls: { cert: '/etc/ssl/missing.pem', key: '/etc/ssl/missing.key' } }));
    assert.equal(missing.status, 409);
    assert.match(JSON.stringify(missing.json), /Not yet: The certificate covers/);
    assert.equal((await admin.post('/api/domains', { ...answers('gonsalvesfamily.com'), folderHosts: true })).status, 400);
    const r = await admin.post('/api/domains', answers('gonsalvesfamily.com'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.test.name, /^zz-check-[a-z0-9]+\.gonsalvesfamily\.com$/);
    const catchAll = readFileSync(join(dir, 'nginx', 'domains', 'gonsalvesfamily.com', 'catch-all.conf'), 'utf8');
    assert.match(catchAll, /server_name "~\^\(\?!www\\\.\)\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?\\\.gonsalvesfamily\\\.com\$";/);
    assert.match(catchAll, /ssl_certificate     \/etc\/letsencrypt\/live\/wildcard\.gonsalvesfamily\.com\/fullchain\.pem;/);
    assert.match(catchAll, /root .*\/nginx\/domains\/gonsalvesfamily\.com\/pages;/);
    assert.match(readFileSync(join(dir, 'nginx', 'domains', 'gonsalvesfamily.com', 'pages', '_lfdln', '404.html'), 'utf8'), /nothing at this address on gonsalvesfamily\.com/);
    assert.match(readFileSync(join(dir, 'nginx', 'site.conf'), 'utf8'), /include .*\/nginx\/domains\/\*\/catch-all\.conf;/);
    assert.equal((await actions()).at(-1)!.action, 'domain-added');
    assert.equal((await admin.post('/api/domains', answers('gonsalvesfamily.com'))).status, 409, 'there already');
    // under the home domain: said by the guide's first check, and refused
    const under = await admin.post('/api/domains', answers('shop.lesfleursdelanuit.com'));
    assert.equal(under.status, 409, JSON.stringify(under.json));
    assert.match(JSON.stringify(under.json), /lesfleursdelanuit\.com is a domain here, and one is inside the other/);
    assert.equal(await one(db, "SELECT 1 FROM domains WHERE name = 'shop.lesfleursdelanuit.com'"), undefined);
  });

  it('nginx says no: no row', async () => {
    nginxSays = 1;
    try { assert.equal((await admin.post('/api/domains', answers('example.org'))).status, 502); } finally { nginxSays = 0; }
    assert.equal(await one(db, "SELECT 1 FROM domains WHERE name = 'example.org'"), undefined);
    assert.ok(!existsSync(join(dir, 'nginx', 'domains', 'example.org')));
  });

  it('removing one: not the home domain; one with no hosts, and its files go', async () => {
    const l = (await admin.get('/api/domains')).json.domains as { id: number; name: string }[];
    assert.equal((await admin.post(`/api/domains/${l.find((d) => d.name === 'lesfleursdelanuit.com')!.id}/delete`)).status, 409);
    assert.equal((await admin.post(`/api/domains/${l.find((d) => d.name === 'gonsalvesfamily.com')!.id}/delete`)).status, 200);
    assert.ok(!existsSync(join(dir, 'nginx', 'domains', 'gonsalvesfamily.com')));
    assert.doesNotMatch(readFileSync(join(dir, 'nginx', 'site.conf'), 'utf8'), /domains/);
  });
});

describe('a domain with named hosts (docs/domains-hosts-plan.md step 7)', () => {
  const G = 'gonsalvesfamily.com';
  const tls = { cert: `/etc/letsencrypt/live/${G}/fullchain.pem`, key: `/etc/letsencrypt/live/${G}/privkey.pem`, include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' };
  const answers = (more: Record<string, unknown> = {}) => ({ name: G, dns: 'manual', front: 'direct', cert: 'names', names: ['@', 'www', 'admin'], wildcardRecord: true, tls, ...more });
  const gFile = (f: string) => join(dir, 'nginx', 'domains', G, f);

  it('the guide: a certificate for these names -- checked against them, and hand-written sites keep theirs until they are taken over', async () => {
    const c = await admin.post('/api/domains/check', answers());
    assert.equal(c.json.ok, true, JSON.stringify(c.json));
    const n = c.json.checks.find((x: { key: string }) => x.key === 'nginx');
    assert.match(n.why, /hand-written sites answer for admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com until they are taken over/);
    assert.match(c.json.checks.find((x: { key: string }) => x.key === 'certificate').label, /covers admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com/);
    assert.ok(!c.json.checks.some((x: { key: string }) => x.key === 'wildcard'), 'no * record asked of it');
    for (const [b, re] of [[answers({ names: [] }), /Say which names/], [answers({ names: ['a.b'] }), /one name like www or admin/], [answers({ names: ['-x'] }), /one name/]] as const) {
      const r = await admin.post('/api/domains/check', b);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.match(JSON.stringify(r.json), re);
    }
  });

  it('Turn on: the row with its names, no catch-all, and no made-up name asked', async () => {
    const r = await admin.post('/api/domains', answers());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.test, null);
    const row = await one<{ cert: string; cert_names: string[]; wildcard_record: boolean }>(db, 'SELECT cert, cert_names, wildcard_record FROM domains WHERE name = ?', G);
    assert.deepEqual(row, { cert: 'names', cert_names: [`admin.${G}`, G, `www.${G}`], wildcard_record: false });
    assert.ok(!existsSync(gFile('catch-all.conf')));
    assert.ok(existsSync(gFile('pages/_lfdln/404.html')));
    assert.doesNotMatch(readFileSync(join(dir, 'nginx', 'site.conf'), 'utf8'), /domains/);
    const view = (await admin.get('/api/domains')).json.domains.find((d: { name: string }) => d.name === G);
    assert.deepEqual([view.cert, view.certNames], ['names', [`admin.${G}`, G, `www.${G}`]]);
    assert.match((await actions()).at(-1)!.detail!, /certificate: names \(admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com\)/);
  });

  it('its hosts (as the takeover makes them): beside the home domain\'s of the same name, in the list at their own address, in nginx under the domain', async () => {
    const d = (await one<{ id: number }>(db, 'SELECT id FROM domains WHERE name = ?', G))!.id;
    await one(db, "INSERT INTO hosts (name, with_www, adopted, origin, domain_id, created_by, created_at) VALUES ('@', true, true, 'adopted', ?, 't', 1) RETURNING id", d);
    const adm = (await one<{ id: number }>(db, "INSERT INTO hosts (name, adopted, origin, domain_id, created_by, created_at) VALUES ('admin', true, 'adopted', ?, 't', 1) RETURNING id", d))!.id;
    await one(db, `INSERT INTO routes (host_id, path, target_kind, target_ref, created_by, created_at) VALUES (?, '/', 'redirect', '{"to":"https://example.org/","status":302,"keepPath":false}', 't', 1) RETURNING id`, adm);
    // a host of the same name on the home domain is another host
    const own = await admin.post('/api/hosts', { name: 'admin' });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.address, 'https://admin.lesfleursdelanuit.com/');
    const l = (await admin.get('/api/hosts')).json.hosts as { id: number; name: string; domain: string; address: string; routes: { address: string }[] }[];
    const ga = l.find((h) => h.id === adm)!;
    assert.deepEqual([ga.domain, ga.address, ga.routes[0]!.address], [G, `https://admin.${G}/`, `https://admin.${G}/`]);
    assert.equal(l.find((h) => h.name === '@' && h.domain === G)!.address, `https://${G}/`);
    // switched off and on: nginx has its file under the domain, and site.conf takes it
    assert.equal((await admin.post(`/api/hosts/${adm}`, { enabled: false })).status, 200);
    assert.ok(!existsSync(gFile('hosts/admin.conf')));
    assert.equal((await admin.post(`/api/hosts/${adm}`, { enabled: true })).status, 200);
    assert.match(readFileSync(gFile('hosts/admin.conf'), 'utf8'), /server_name admin\.gonsalvesfamily\.com;[\s\S]*acme-challenge/);
    assert.match(readFileSync(join(dir, 'nginx', 'site.conf'), 'utf8'), /include .*\/nginx\/domains\/\*\/hosts\/\*\.conf;/);
    assert.equal((await actions()).at(-1)!.target, `https://admin.${G}/`);
    const t = await tableFrom(db);
    assert.deepEqual(t.hosts.filter((h) => h.name === 'admin'), [{ name: 'admin', enabled: true, domain: G }, { name: 'admin', enabled: true }]);
    assert.equal(t.routes.find((r) => r.host === 'admin')!.domain, G);
    // the checks ask each domain for its own names
    const c = (await admin.get('/api/hosts/checks')).json.hosts.find((h: { id: number }) => h.id === adm);
    assert.deepEqual(c.checks.map((x: { name: string }) => x.name), [`admin.${G}`]);
    // a place is a home domain host: someone kept to "admin" sees lfdln's admin, not Gonsalves's
    assert.equal((await admin.post(`/api/users/${helperId}/access`, { rights: ['hosts'], places: ['/admin'] })).status, 200);
    const mine = (await helper.get('/api/hosts')).json.hosts as { domain: string }[];
    assert.deepEqual(mine.map((h) => h.domain), ['lesfleursdelanuit.com']);
    assert.equal((await helper.post(`/api/hosts/${adm}`, { enabled: false })).status, 404);
  });

  it('a host on it whose names the certificate doesn\'t cover: nginx isn\'t asked, and nothing changes', async () => {
    const d = (await one<{ id: number }>(db, 'SELECT id FROM domains WHERE name = ?', G))!.id;
    const shop = (await one<{ id: number }>(db, "INSERT INTO hosts (name, origin, domain_id, created_at) VALUES ('shop', 'hand', ?, 1) RETURNING id", d))!.id;
    const r = await admin.post(`/api/hosts/${shop}/routes`, { path: '/', kind: 'redirect', to: 'https://example.org/', status: 302 });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), /certificate doesn't cover shop\.gonsalvesfamily\.com/);
    assert.equal(await one(db, 'SELECT 1 FROM routes WHERE host_id = ?', shop), undefined);
    await one(db, 'DELETE FROM hosts WHERE id = ? RETURNING id', shop);
  });

  it('Add a host on it (7-6): only the names its certificate covers, www beside "@" too', async () => {
    const shop = await admin.post('/api/hosts', { name: 'shop', domain: G });
    assert.equal(shop.status, 400, JSON.stringify(shop.json));
    assert.match(JSON.stringify(shop.json), /gonsalvesfamily\.com's certificate covers admin\.gonsalvesfamily\.com, gonsalvesfamily\.com, www\.gonsalvesfamily\.com only, not shop\.gonsalvesfamily\.com/);
    assert.equal((await admin.post('/api/hosts', { name: 'admin', domain: G })).status, 409, 'taken over already');
    assert.equal(await one(db, "SELECT 1 FROM hosts WHERE name = 'shop'"), undefined);
  });

  it('the domain can\'t go while it has hosts; once they go, it can', async () => {
    const d = (await one<{ id: number }>(db, 'SELECT id FROM domains WHERE name = ?', G))!.id;
    assert.equal((await admin.post(`/api/domains/${d}/delete`)).status, 409);
    for (const h of await all<{ id: number }>(db, 'SELECT id FROM hosts WHERE domain_id = ?', d)) assert.equal((await admin.post(`/api/hosts/${h.id}/delete`)).status, 200);
    assert.equal((await admin.post(`/api/domains/${d}/delete`)).status, 200);
    assert.ok(!existsSync(join(dir, 'nginx', 'domains', G)));
  });
});

describe('Add a host on another domain (docs/domains-hosts-plan.md 7-6)', () => {
  const T = 'tutorlumi.com';
  const tls = { cert: `/etc/ssl/cloudflare/${T}.pem`, key: `/etc/ssl/cloudflare/${T}.key` };
  const tFile = (f: string) => join(dir, 'nginx', 'domains', T, 'hosts', f);
  let apex = 0;

  before(async () => {
    const r = await admin.post('/api/domains', { name: T, dns: 'cloudflare', front: 'cloudflare', cert: 'cloudflare-origin', wildcardRecord: true, tls });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it('"@" with www beside it: on that domain, at its own address, in nginx under it with its certificate', async () => {
    const r = await admin.post('/api/hosts', { name: '@', domain: T, withWww: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.address, `https://${T}/`);
    apex = r.json.id;
    const row = await one<{ name: string; with_www: boolean; origin: string; domain: string }>(db, 'SELECT h.name, h.with_www, h.origin, d.name AS domain FROM hosts h JOIN domains d ON d.id = h.domain_id WHERE h.id = ?', apex);
    assert.deepEqual(row, { name: '@', with_www: true, origin: 'hand', domain: T });
    assert.deepEqual((await actions()).at(-1), { action: 'host-created', target: `https://${T}/`, detail: `www.${T} beside it` });
    const route = await admin.post(`/api/hosts/${apex}/routes`, { path: '/', kind: 'redirect', to: 'https://example.org/', status: 302 });
    assert.equal(route.status, 200, JSON.stringify(route.json));
    const text = readFileSync(tFile('@.conf'), 'utf8');
    assert.match(text, /server_name tutorlumi\.com www\.tutorlumi\.com;/);
    assert.match(text, /ssl_certificate +\/etc\/ssl\/cloudflare\/tutorlumi\.com\.pem;/);
    const h = ((await admin.get('/api/hosts')).json.hosts as { id: number; domain: string; onHome: boolean; address: string }[]).find((x) => x.id === apex)!;
    assert.deepEqual([h.domain, h.onHome, h.address], [T, false, `https://${T}/`]);
    // the home domain's own hosts say they are on it
    assert.ok(((await admin.get('/api/hosts')).json.hosts as { onHome: boolean; domain: string }[]).filter((x) => x.domain !== T).every((x) => x.onHome));
  });

  it('a name under it: not asked of DreamHost\'s zone (it isn\'t there), even while that can\'t be read', async () => {
    zoneUp = false;
    try {
      const r = await admin.post('/api/hosts', { name: 'webmail', domain: T, withWww: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.address, `https://webmail.${T}/`);
      assert.equal((await one<{ with_www: boolean }>(db, 'SELECT with_www FROM hosts WHERE id = ?', r.json.id))!.with_www, false, 'www only beside "@"');
      // the home domain's still are
      assert.equal((await admin.post('/api/hosts', { name: 'later' })).status, 503);
    } finally { zoneUp = true; }
  });

  it('refused: www on its own, the server\'s names, a name there already, a domain that isn\'t one here, a bad name', async () => {
    for (const [b, status, re] of [
      [{ name: 'www', domain: T }, 400, /www is never a host of its own/],
      [{ name: '@', domain: T }, 409, /tutorlumi\.com is already a host/],
      [{ name: 'webmail', domain: T }, 409, /webmail\.tutorlumi\.com is already a host/],
      [{ name: 'x', domain: 'example.net' }, 404, /example\.net isn't a domain here/],
      [{ name: 'x', domain: 'Not A Domain' }, 400, /A domain is/],
      [{ name: 'a.b', domain: T }, 400, /A host is one name/],
      [{ name: 'panel', domain: T }, 400, /kept for the server itself/],
      [{ name: 'www' }, 400, /www is never a host of its own/],
    ] as const) {
      const r = await admin.post('/api/hosts', b);
      assert.equal(r.status, status, `${JSON.stringify(b)}: ${JSON.stringify(r.json)}`);
      assert.match(JSON.stringify(r.json), re);
    }
  });

  it('a route on it can\'t have accounts yet', async () => {
    const route = (await one<{ id: number }>(db, 'SELECT id FROM routes WHERE host_id = ?', apex))!.id;
    await one(db, `UPDATE routes SET target_kind = 'folder', target_ref = '{"spa":false,"headers":[],"cacheForever":[]}', folder_id = (SELECT id FROM site_folders ORDER BY id LIMIT 1) WHERE id = ? RETURNING id`, route);
    const r = await admin.post(`/api/routes/${route}/accounts`, { accounts: 'private' });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), /Accounts are only on lesfleursdelanuit\.com's routes for now, not tutorlumi\.com's/);
  });

  it('its hosts deleted, then the domain', async () => {
    const d = (await one<{ id: number }>(db, 'SELECT id FROM domains WHERE name = ?', T))!.id;
    for (const h of await all<{ id: number }>(db, 'SELECT id FROM hosts WHERE domain_id = ?', d)) assert.equal((await admin.post(`/api/hosts/${h.id}/delete`)).status, 200);
    assert.ok(!existsSync(tFile('@.conf')));
    assert.equal((await admin.post(`/api/domains/${d}/delete`)).status, 200);
  });
});
