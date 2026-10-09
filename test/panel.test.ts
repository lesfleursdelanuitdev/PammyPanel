// End-to-end tests of the panel API with a software passkey authenticator.
//   node --test test/*.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { cleanAccess, COMMAND_LINE, createInvite, createUser, getUserByName, listPasskeys, placesOf, setAccess, setActive, setRole } from '@panel/core/accounts';
import { MEMBER_RIGHTS, PLACE_RIGHTS } from '@panel/core/panel/rights';

// what members always had (docs/permissions-plan.md R8): a new account has nothing until it is given
const MEMBER = { rights: [...MEMBER_RIGHTS], places: [] };
// and what an account kept to one folder always had
const keptTo = (place: string) => cleanAccess(['files', 'media', 'forms', 'responses', 'comments'], [place]);
import { buildApp, nextPage, PAGE_PATHS } from '@panel/pammy/app';
import type { Config } from '@panel/core/config';
import { siteFacts } from '@panel/core/profile';
import { PROFILE } from '@panel/pammy/profile';
import { all, one, run, type Sql } from '@panel/core/pg';
import { carryRenames } from '@panel/studio/studio/resource-store';
import { migrate } from '@panel/core/pg-migrate';
import { renamePhotos } from '@panel/files/media-rename';
import { MediaSync } from '@panel/files/media-sync';
import { Publisher } from '@panel/media/media-public';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { DEFAULT_TOOLS } from '@panel/thumbs/thumbs/make';
import { createThumbsServer } from '@panel/thumbs/thumbs/service';
import { createSiteFsServer } from '@panel/files/sitefs/service';
import { createPammyDbServer } from '@panel/studio/pammydb/service';
import { adoptWordPress } from '@panel/apps/apps/adopt';
import { createMailServer } from '@panel/mail/mail/service';
import { readKey, readSettings } from '@panel/mail/mail/settings';
import { createOps } from '@panel/apps/apps/ops';
import { createAppsServer } from '@panel/apps/apps/service';
import { fakeSystem, wordpressServer } from './apps-world.ts';
import type { DatabaseFacts, DbUser, Driver } from '@panel/studio/pammydb/driver';
import type { AccessRole } from '@panel/studio/pammydb/roles';
import { PammyDbError } from '@panel/studio/pammydb/ident';
import { mergeDatabases, type ManagedRow } from '@panel/studio/studio/databases';
import { mergeUsers, newDbPassword, type UserNoteRow } from '@panel/studio/studio/users';
import { memoryRows, memorySchemas, seedTables } from './studio-stub.ts';
import { PASSWORD_RE } from '@panel/studio/pammydb/ident';
import { createGateAdminServer, handleAdmin } from '@panel/pammy/gate/admin';
import { addResponse } from '@panel/forms/gate/forms/responses';
import { formById } from '@panel/forms/gate/forms/store';
import type { GateLive } from '@panel/core/gate/live';
import { addAccessRequest, addResetRequest, areaById, rolesOf } from '@panel/core/gate/store';
import { copySet, resetSet, saveRole } from '@panel/areas/gate/access';
import { setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import { newGate } from './gate-seed.ts';
import { catalogFor } from '@panel/studio/gate/studio';
import { readCatalog } from '@panel/studio/studio/catalog';
import { DB_EXAMPLES } from '@panel/examples/studio/db-examples';
import { startPg, type PgTest } from './pg-harness.ts';
import { SoftAuthenticator, type Knobs } from './authenticator.ts';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';

const ORIGIN = 'https://panel.pammy.org';

// A stand-in for the gate's HTTP side (the one her pages talk to), so the
// tutorial examples' to-do proxy can be driven here: it records what the panel
// asked and answers whatever the test put in `gateReplies`.
let fakeGate: HttpServer;
let fakeGatePort = 0;
const gateAsked: { method: string; url: string; key: string | null; body: unknown }[] = [];
let gateReplies: (asked: { method: string; url: string; body: unknown }) => unknown = () => ({ items: [], total: 0 });
async function startFakeGate() {
  fakeGate = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
      const auth = req.headers.authorization;
      const asked = { method: req.method ?? '', url: req.url ?? '', key: typeof auth === 'string' ? auth.replace('Bearer ', '') : null, body };
      gateAsked.push(asked);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(gateReplies(asked)));
    });
  });
  await new Promise<void>((r) => fakeGate.listen(0, '127.0.0.1', r));
  fakeGatePort = (fakeGate.address() as { port: number }).port;
}
let clock = 1_800_000_000;
const advance = (sec: number) => { clock += sec; };

let dir: string;
let db: Sql;              // the panel's Postgres (a test container's)
let media: MediaSync;
let thumbs: Thumbnailer;
let publisher: Publisher;
let app: FastifyInstance;
// One test container: the panel's database, and the gates' (a database each)
let pgTest: PgTest | undefined;
const gatePg = async () => (pgTest ??= await startPg());

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-panel-test-'));
  await startFakeGate();
  const pg = await gatePg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('panel', database, 8);
  mkdirSync(join(dir, 'help'));
  writeFileSync(join(dir, 'help', '08-control-panel.txt'), [
    '='.repeat(40), ' Your control panel', ' About 5 minutes.', '='.repeat(40), '', 'Intro words.', '',
    '-'.repeat(40), 'PART 9 -- Forms', '-'.repeat(40), '', 'Put <pammy-form> on any page.', '',
  ].join('\n'));
  writeFileSync(join(dir, 'help', '00-README.txt'), `${'='.repeat(30)}\n Your instructions\n${'='.repeat(30)}\n\nRead these.\n`);
  writeFileSync(join(dir, 'help', 'not-a-guide.md'), 'ignored');
  writeFileSync(join(dir, 'help', '11-one-folder.txt'), `${'='.repeat(30)}\n Looking after one folder\n${'='.repeat(30)}\n\nFor helpers.\n`);
  // the map build.sh copies in beside them: their order, and the Help tab's words
  writeFileSync(join(dir, 'help', 'guides.map'), '# a comment\nREADME.txt  00-README.txt\ncp.txt  08-control-panel.txt  parts,listed\none.txt  11-one-folder.txt  kept\n');
  const config: Config = {
    site: siteFacts(PROFILE),
    origin: ORIGIN, rpID: 'panel.pammy.org', rpName: 'pammy.org panel', pgPasswordFile: '',
    host: '127.0.0.1', port: 0, publicDir: new URL('../public/', import.meta.url).pathname, helpDir: join(dir, 'help'),
    sitefsSocket: join(dir, 'sitefs.sock'), gateSocket: join(dir, 'gate.sock'), now: () => clock,
    thumbsSocket: join(dir, 'thumbs.sock'), thumbsDir: join(dir, 'thumbs'), mediaPublicDir: join(dir, 'media-public'),
    pammydbSocket: join(dir, 'pammydb.sock'), appsSocket: join(dir, 'apps.sock'), mailSocket: join(dir, 'mail.sock'),
    rootfsSockets: join(dir, 'rootfs-{id}.sock'),
    tutorialsDir: new URL('../tutorials/', import.meta.url).pathname, tutorialExamplesDir: join(dir, 'tutorial-examples'),
    gateUrl: `http://127.0.0.1:${fakeGatePort}`,
  };
  media = new MediaSync(db, config.sitefsSocket, config.now);
  thumbs = new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
  publisher = new Publisher(db, config.mediaPublicDir, config.now);
  publisher.delayMs = 0;
  app = buildApp(config, db, { media, thumbs, publisher });
});
after(async () => {
  fakeGate?.close();
  await app.close();
  await db?.end({ timeout: 2 });
  pgTest?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// A browser: one cookie jar, one IP, one authenticator.
class Browser {
  cookie = '';
  ip: string;
  auth = new SoftAuthenticator(ORIGIN);
  constructor(ip: string) {
    this.ip = ip;
  }
  async req(method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({
      method, url, remoteAddress: '127.0.0.1',
      headers: {
        'x-real-ip': this.ip, 'user-agent': 'Mozilla/5.0 (Macintosh; Mac OS X) Safari/605.1',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(method === 'POST' ? { payload: JSON.stringify(payload ?? {}) } : {}),
    });
    const set = res.headers['set-cookie'];
    for (const c of [set ?? []].flat()) {
      const [pair] = String(c).split(';');
      this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    let json: any = null;
    try { json = res.json(); } catch { /* not JSON */ }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, payload?: unknown) => this.req('POST', url, payload);

  async useInvite(token: string, name = 'test device', k: Knobs = {}) {
    const o = await this.post('/api/invite/options', { token });
    assert.equal(o.status, 200, JSON.stringify(o.json));
    return this.post('/api/invite/verify', { token, name, ceremony: o.json.ceremony, response: this.auth.create(o.json.options, k) });
  }
  async login(k: Knobs = {}, which = 0) {
    const o = await this.post('/api/login/options');
    assert.equal(o.status, 200);
    return this.post('/api/login/verify', { ceremony: o.json.ceremony, response: this.auth.get(o.json.options, k, which) });
  }
  async confirm() {
    const o = await this.post('/api/reauth/options');
    assert.equal(o.status, 200);
    return this.post('/api/reauth/verify', { ceremony: o.json.ceremony, response: this.auth.get(o.json.options) });
  }
  async addPasskey(name: string, other?: SoftAuthenticator) {
    const o = await this.post('/api/me/passkeys/options');
    if (o.status !== 200) return o;
    return this.post('/api/me/passkeys/verify', { name, ceremony: o.json.ceremony, response: (other ?? this.auth).create(o.json.options) });
  }
}

const actions = async () => (await all(db, 'SELECT action FROM activity ORDER BY id') as { action: string }[]).map((r) => r.action);

// ---------------------------------------------------------------------------
describe('pages and headers', () => {
  it('sends signed-out visitors to the login page', async () => {
    const b = new Browser('198.51.100.1');
    const r = await b.get('/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
  });

  it('serves the login page with strict security headers, and a new style nonce each time', async () => {
    const r = await new Browser('198.51.100.1').get('/login');
    assert.equal(r.status, 200);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /font-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
    const nonce = csp.match(/style-src 'self' 'nonce-([A-Za-z0-9+/=]{24})'/)?.[1];
    assert.ok(nonce, csp);
    assert.ok(r.body.includes(`<meta property="csp-nonce" nonce="${nonce}">`), 'the page knows its nonce');
    assert.ok(!r.body.includes('PAMMY_NONCE'));
    const again = await new Browser('198.51.100.1').get('/login');
    assert.notEqual(String(again.headers['content-security-policy']), csp);
    // API answers keep the plain policy: no nonce, nothing inline
    assert.match(String((await new Browser('198.51.100.1').get('/api/session')).headers['content-security-policy']), /style-src 'self';/);
  });

  it('serves only built files, the hashed ones cached for good', async () => {
    const b = new Browser('198.51.100.1');
    const page = (await b.get('/login')).body;
    const script = page.match(/src="(\/assets\/index-[\w-]{8}\.js)"/)?.[1];
    const style = page.match(/href="(\/assets\/index-[\w-]{8}\.css)"/)?.[1];
    assert.ok(script && style, page);
    const js = await b.get(script);
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /^text\/javascript/);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await b.get(style)).status, 200);
    const icon = await b.get('/assets/favicon.svg');
    assert.deepEqual([icon.status, icon.headers['cache-control']], [200, 'public, max-age=3600']);
    assert.equal((await b.get('/assets/../src/app.ts')).status, 404);
    assert.equal((await b.get('/assets/%2e%2e/src/app.ts')).status, 404);
    assert.equal((await b.get('/assets/nope.js')).status, 404);
    assert.equal((await b.get('/static/js/app.js')).status, 404, 'the old front end is gone');
    assert.equal((await b.get('/index.html')).status, 404);
  });

  it('keeps /api/session closed without a session', async () => {
    assert.equal((await new Browser('198.51.100.1').get('/api/session')).status, 401);
  });
});

describe('cross-site request protection', () => {
  const b = new Browser('198.51.100.2');
  it('refuses a POST with no Origin', async () => {
    assert.equal((await b.req('POST', '/api/login/options', {}, { origin: '' })).status, 403);
  });
  it('refuses a POST from another origin', async () => {
    assert.equal((await b.req('POST', '/api/login/options', {}, { origin: 'https://evil.pammy.org' })).status, 403);
  });
  it('refuses a form-encoded POST', async () => {
    assert.equal((await b.req('POST', '/api/login/options', {}, { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
  });
  it('refuses a cross-site fetch even with a forged Origin header', async () => {
    assert.equal((await b.req('POST', '/api/login/options', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  });
});

describe('accounts, passkeys and sessions', () => {
  const momolig = new Browser('203.0.113.10');
  const pamela = new Browser('203.0.113.20');
  let pamelaId = 0;

  it('bootstraps the manager from the command line', async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'momolig', 'momolig', 'manager');
    const { token } = await createInvite(db, clock, COMMAND_LINE, u);

    assert.equal((await momolig.post('/api/invite/info', { token: 'A'.repeat(43) })).status, 404);
    const info = await momolig.post('/api/invite/info', { token });
    assert.equal(info.status, 200);
    assert.equal(info.json.username, 'momolig');

    const r = await momolig.useInvite(token, 'laptop');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const setCookie = String(r.headers['set-cookie']);
    assert.match(setCookie, /^__Host-pammy_panel=/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const s = await momolig.get('/api/session');
    assert.equal(s.status, 200);
    assert.equal(s.json.user.role, 'manager');
    assert.equal(s.json.recentAuth, true);

    // single use
    assert.equal((await new Browser('203.0.113.11').post('/api/invite/info', { token })).status, 404);
  });

  it('stores only hashes of session tokens', async () => {
    const token = momolig.cookie.split('=')[1]!;
    const hit = await one(db, 'SELECT count(*) AS n FROM sessions WHERE token_hash = ?', token) as { n: number };
    assert.equal(hit.n, 0);
  });

  it('refuses a passkey made for another site or without user verification', async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'tester', 'Tester', 'member', MEMBER);
    const t1 = (await createInvite(db, clock, COMMAND_LINE, u)).token;
    const b = new Browser('203.0.113.30');
    assert.equal((await b.useInvite(t1, 'x', { origin: 'https://pammy.org' })).status, 400);
    assert.equal((await b.useInvite(t1, 'x', { rpId: 'pammy.org' })).status, 400);
    assert.equal((await b.useInvite(t1, 'x', { uv: false })).status, 400);
    const n = await one(db, 'SELECT count(*) AS n FROM passkeys WHERE user_id = ?', u.id) as { n: number };
    assert.equal(n.n, 0);
    // the link survives failed attempts
    assert.equal((await b.useInvite(t1, 'x')).status, 200);
  });

  it('never accepts the same challenge twice', async () => {
    const b = new Browser('203.0.113.12');
    b.auth = momolig.auth;
    const o = await b.post('/api/login/options');
    const response = b.auth.get(o.json.options);
    assert.equal((await b.post('/api/login/verify', { ceremony: o.json.ceremony, response })).status, 200);
    b.cookie = '';
    assert.equal((await b.post('/api/login/verify', { ceremony: o.json.ceremony, response })).status, 400);
  });

  it('refuses changes from another site even with a valid session cookie', async () => {
    // what SameSite=Lax alone would allow through in an older browser: a cross-site
    // request that carries the cookie. The Origin check must still stop it.
    const who = (await momolig.get('/api/session')).json.user.id;
    const attempts: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'https://blog.pammy.org' },
      { origin: '' },
      { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of attempts) {
      const r = await momolig.req('POST', '/api/users', { username: 'mallory', displayName: 'Mallory' }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    assert.equal((await momolig.req('POST', `/api/users/${who}/invite`, {}, { origin: 'https://pammy.org' })).status, 403);
    assert.equal((await one(db, "SELECT count(*) AS n FROM users WHERE username = 'mallory'") as { n: number }).n, 0);
    // a top-level visit from a link (a GET) is fine and still signed in
    const page = await momolig.req('GET', '/', undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(page.status, 200);
  });

  it('signs out, then signs back in with the passkey', async () => {
    assert.equal((await momolig.post('/api/logout')).status, 200);
    assert.equal((await momolig.get('/api/session')).status, 401);
    const r = await momolig.login();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await momolig.get('/api/session')).status, 200);
  });

  it('rejects a passkey it has never seen, an assertion for another origin, and a counter going backwards', async () => {
    const stranger = new Browser('203.0.113.40');
    stranger.auth.create({ rp: { id: 'panel.pammy.org' }, user: { id: 'xx' }, challenge: 'yy' });
    assert.equal((await stranger.login()).status, 401);

    const copy = new Browser('203.0.113.41');
    copy.auth = momolig.auth;
    assert.equal((await copy.login({ origin: 'https://evil.example' })).status, 401);
    assert.equal((await copy.login({ counter: 1 })).status, 401);   // counter was already higher
    assert.ok((await actions()).includes('login-failed'));
  });

  it('asks for a fresh passkey check before adding a passkey', async () => {
    advance(11 * 60);
    const r = await momolig.addPasskey('phone');
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'reauth-required');
    assert.equal((await momolig.confirm()).status, 200);
    const phone = new SoftAuthenticator(ORIGIN);
    assert.equal((await momolig.addPasskey('phone', phone)).status, 200);
    const list = await momolig.get('/api/me/passkeys');
    assert.deepEqual(list.json.passkeys.map((p: { name: string }) => p.name), ['laptop', 'phone']);
  });

  it("won't let you remove your own last passkey", async () => {
    const list = (await momolig.get('/api/me/passkeys')).json.passkeys as { id: number; name: string; thisSession: boolean }[];
    const phone = list.find((p) => p.name === 'phone')!;
    assert.equal((await momolig.post(`/api/me/passkeys/${phone.id}/delete`)).status, 200);
    const laptop = list.find((p) => p.name === 'laptop')!;
    const r = await momolig.post(`/api/me/passkeys/${laptop.id}/delete`);
    assert.equal(r.status, 409);
  });

  it('only lets the account manager manage accounts', async () => {
    const created = await momolig.post('/api/users', { username: 'pamela', displayName: 'Pamela' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    pamelaId = created.json.id;
    assert.equal((await momolig.post('/api/users', { username: 'Pamela!', displayName: 'x' })).status, 400);
    assert.equal((await momolig.post('/api/users', { username: 'pamela', displayName: 'again' })).status, 409);

    const inv = await momolig.post(`/api/users/${pamelaId}/invite`);
    assert.equal(inv.status, 200);
    assert.match(inv.json.link, /^https:\/\/panel\.pammy\.org\/invite#[A-Za-z0-9_-]{43}$/);
    const token = inv.json.link.split('#')[1];
    assert.equal((await pamela.useInvite(token, 'iPhone')).status, 200);

    assert.equal((await pamela.get('/api/users')).status, 404);
    assert.equal((await pamela.post('/api/users', { username: 'eve', displayName: 'Eve' })).status, 404);
    assert.equal((await pamela.post(`/api/users/${pamelaId}/invite`)).status, 404);
    // but she sees what she did herself in the activity log, and nobody else's
    // (docs/permissions-plan.md R7)
    const act = await pamela.get('/api/activity');
    assert.equal(act.status, 200);
    assert.equal(act.json.own, true);
    assert.ok(act.json.entries.some((e: { action: string }) => e.action === 'invite-used'));
    assert.ok(act.json.entries.every((e: { actor_id: number }) => e.actor_id === pamelaId), 'only her own lines');
    const all = await momolig.get('/api/activity');
    assert.equal(all.json.own, false);
    assert.ok(all.json.entries.some((e: { action: string; actor_id: number }) => e.action === 'user-created' && e.actor_id !== pamelaId), 'the account manager sees everyone');
  });

  it('makes a second account manager only on the command line, and never leaves none', async () => {
    const pam = (await getUserByName(db, 'pamela'))!;
    await setRole(db, clock, COMMAND_LINE, pam, 'manager');
    const seen = await pamela.get('/api/users');
    assert.equal(seen.status, 200, 'Pamela manages accounts too');
    assert.equal((await pamela.get('/api/session')).json.user.role, 'manager');
    await assert.rejects(setRole(db, clock, COMMAND_LINE, pam, 'owner'), /manager' or 'member/);
    // back to one manager: the last one can't be demoted
    await setRole(db, clock, COMMAND_LINE, (await getUserByName(db, 'pamela'))!, 'member');
    assert.equal((await pamela.get('/api/users')).status, 404);
    await assert.rejects(setRole(db, clock, COMMAND_LINE, (await getUserByName(db, 'momolig'))!, 'member'), /only account manager/);
    const acts = (await all(db, "SELECT detail FROM activity WHERE action = 'user-role-changed' ORDER BY id") as { detail: string }[]).map((r) => r.detail);
    assert.deepEqual(acts, ['now an account manager', 'no longer an account manager']);
  });

  it('switching an account off locks it out immediately, and back on restores it', async () => {
    assert.equal((await pamela.get('/api/session')).status, 200);
    assert.equal((await momolig.post(`/api/users/${pamelaId}/disable`)).status, 200);
    assert.equal((await pamela.get('/api/session')).status, 401);
    assert.equal((await pamela.login()).status, 401);
    assert.equal((await momolig.post(`/api/users/${pamelaId}/enable`)).status, 200);
    assert.equal((await pamela.login()).status, 200);
  });

  it("won't let the manager switch off their own account", async () => {
    const me = (await momolig.get('/api/session')).json.user.id;
    assert.equal((await momolig.post(`/api/users/${me}/disable`)).status, 409);
  });

  it('signs someone out everywhere', async () => {
    assert.equal((await momolig.post(`/api/users/${pamelaId}/signout`)).status, 200);
    assert.equal((await pamela.get('/api/session')).status, 401);
    assert.equal((await pamela.login()).status, 200);
  });

  it('removing the passkey a session used ends that session', async () => {
    const users = (await momolig.get('/api/users')).json.users as { id: number; passkeys: { id: number }[] }[];
    const pk = users.find((u) => u.id === pamelaId)!.passkeys[0]!;
    assert.equal((await momolig.post(`/api/users/${pamelaId}/passkeys/${pk.id}/delete`)).status, 200);
    assert.equal((await pamela.get('/api/session')).status, 401);
    assert.equal((await pamela.login()).status, 401);
  });

  it('cancelled and expired setup links stop working', async () => {
    const a = (await momolig.post(`/api/users/${pamelaId}/invite`)).json.link.split('#')[1];
    const b = (await momolig.post(`/api/users/${pamelaId}/invite`)).json.link.split('#')[1];
    assert.equal((await pamela.post('/api/invite/info', { token: a })).status, 404, 'a new link replaces the old one');
    assert.equal((await momolig.post(`/api/users/${pamelaId}/invite/cancel`)).status, 200);
    assert.equal((await pamela.post('/api/invite/info', { token: b })).status, 404);

    const c = (await momolig.post(`/api/users/${pamelaId}/invite`)).json.link.split('#')[1];
    advance(24 * 3600 + 1);
    assert.equal((await pamela.post('/api/invite/info', { token: c })).status, 404);
  });

  it('manager actions need a recent passkey check', async () => {
    // the 24h jump above expired momolig's session too (8h idle)
    assert.equal((await momolig.get('/api/session')).status, 401);
    assert.equal((await momolig.login()).status, 200);
    advance(11 * 60);
    const r = await momolig.post(`/api/users/${pamelaId}/invite`);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'reauth-required');
    assert.equal((await momolig.confirm()).status, 200);
    const link = (await momolig.post(`/api/users/${pamelaId}/invite`)).json.link.split('#')[1];
    pamela.auth = new SoftAuthenticator(ORIGIN);
    assert.equal((await pamela.useInvite(link, 'new phone')).status, 200);
  });

  it('ends sessions after 8 idle hours and after 7 days regardless', async () => {
    advance(8 * 3600);
    assert.equal((await pamela.get('/api/session')).status, 401);
    assert.equal((await pamela.login()).status, 200);
    for (let i = 0; i < 24; i++) {        // active every 7 hours for 7 days
      advance(7 * 3600);
      if ((await pamela.get('/api/session')).status !== 200) break;
    }
    assert.equal((await pamela.get('/api/session')).status, 401);
  });

  it('lists and signs out other sessions', async () => {
    assert.equal((await pamela.login()).status, 200);
    const other = new Browser('203.0.113.21');
    other.auth = pamela.auth;
    assert.equal((await other.login()).status, 200);
    const list = (await pamela.get('/api/me/sessions')).json.sessions as { id: number; current: boolean; device: string }[];
    assert.equal(list.length, 2);
    assert.equal(list.find((s) => s.current)!.device, 'Safari on Mac');
    const theirs = list.find((s) => !s.current)!;
    assert.equal((await pamela.post(`/api/me/sessions/${theirs.id}/revoke`)).status, 200);
    assert.equal((await other.get('/api/session')).status, 401);
    // can't revoke someone else's session by id
    const mine = list.find((s) => s.current)!;
    assert.equal((await momolig.login()).status, 200);
    assert.equal((await momolig.post(`/api/me/sessions/${mine.id}/revoke`)).status, 404);
    assert.equal((await pamela.get('/api/session')).status, 200);
  });

  it('records what happened', async () => {
    const a = new Set((await actions()));
    for (const x of ['user-created', 'invite-created', 'invite-used', 'passkey-added', 'login', 'logout', 'login-failed',
                     'passkey-removed', 'user-disabled', 'user-enabled', 'sessions-revoked', 'invite-cancelled', 'session-revoked']) {
      assert.ok(a.has(x), `missing activity: ${x}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Postgres runs requests side by side, where SQLite ran them one at a time
// (docs/postgres-plan.md P11): each of these would let two through if the code
// only checked and then wrote.
describe('two requests at once', () => {
  it('a sign-in challenge works once, however many use it at the same moment', async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'twice', 'Twice', 'member', MEMBER);
    const b = new Browser('203.0.113.140');
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    const o = await b.post('/api/login/options');
    const answer = { ceremony: o.json.ceremony, response: b.auth.get(o.json.options) };
    const [x, y] = await Promise.all([new Browser('203.0.113.141').post('/api/login/verify', answer), new Browser('203.0.113.142').post('/api/login/verify', answer)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  });

  it('one setup link, two devices at the same moment: one passkey', async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'twodevices', 'Two Devices', 'member', MEMBER);
    const token = (await createInvite(db, clock, COMMAND_LINE, u)).token;
    const [p, q] = [new Browser('203.0.113.143'), new Browser('203.0.113.144')];
    const [op, oq] = await Promise.all([p.post('/api/invite/options', { token }), q.post('/api/invite/options', { token })]);
    const [rp, rq] = await Promise.all([
      p.post('/api/invite/verify', { token, name: 'phone', ceremony: op.json.ceremony, response: p.auth.create(op.json.options) }),
      q.post('/api/invite/verify', { token, name: 'laptop', ceremony: oq.json.ceremony, response: q.auth.create(oq.json.options) }),
    ]);
    assert.equal([rp.status, rq.status].filter((st) => st === 200).length, 1, `${rp.status} ${rq.status}`);
    assert.equal((await listPasskeys(db, u.id)).length, 1);
    assert.ok([rp, rq].some((r) => r.status === 409 || r.status === 404));
  });

  it('two account managers switching each other off at once: one stays on', async () => {
    const a = await createUser(db, clock, COMMAND_LINE, 'boss-a', 'Boss A', 'manager');
    const b = await createUser(db, clock, COMMAND_LINE, 'boss-b', 'Boss B', 'manager');
    // only these two are account managers for this test
    const others = await all<{ id: number }>(db, "SELECT id FROM users WHERE role = 'manager' AND active = 1 AND id NOT IN (?, ?)", a.id, b.id);
    for (const o of others) await run(db, 'UPDATE users SET active = 0 WHERE id = ?', o.id);
    const results = await Promise.allSettled([
      setActive(db, clock, { id: a.id, label: a.username }, b, false),
      setActive(db, clock, { id: b.id, label: b.username }, a, false),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await one<{ n: number }>(db, "SELECT count(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id IN (?, ?)", a.id, b.id))!.n, 1);
    for (const o of others) await run(db, 'UPDATE users SET active = 1 WHERE id = ?', o.id);
    for (const u of [a, b]) await run(db, 'DELETE FROM users WHERE id = ?', u.id);
  });

  it('the same new username twice at once: one account', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => createUser(db, clock, COMMAND_LINE, 'samename', 'Same Name', 'member', MEMBER)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /already an account called samename/);
  });
});

describe('rate limits and client IPs', () => {
  it('caps pending sign-in challenges', async () => {
    await run(db, "INSERT INTO ceremonies (id_hash, kind, challenge, expires_at) SELECT 'flood-' || i, 'login', 'c', ? FROM generate_series(0, 4999) i", clock + 300);
    assert.equal((await new Browser('192.0.2.60').post('/api/login/options')).status, 503);
    await run(db, "DELETE FROM ceremonies WHERE id_hash LIKE 'flood-%'");
    assert.equal((await new Browser('192.0.2.60').post('/api/login/options')).status, 200);
  });

  it('limits sign-in attempts per visitor IP', async () => {
    const b = new Browser('192.0.2.50');
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await b.post('/api/login/verify', { ceremony: 'x', response: {} })).status;
    assert.equal(last, 429);
    const other = new Browser('192.0.2.51');
    assert.equal((await other.post('/api/login/verify', { ceremony: 'x', response: {} })).status, 400);
  });

  it('ignores X-Real-IP unless the request came from nginx on this machine', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/login/verify', remoteAddress: '198.51.100.99',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': `10.0.0.${i}` },
        payload: '{}',
      });
      last = res.statusCode;
    }
    assert.equal(last, 429, 'rotating a spoofed X-Real-IP must not reset the limit');
  });
});

describe('subdomains through the panel', () => {
  const b = new Browser('203.0.113.90');
  let helper: ReturnType<typeof createSiteFsServer>;
  let pub = '';

  before(async () => {
    pub = join(dir, 'public');
    mkdirSync(pub, { recursive: true });
    mkdirSync(join(dir, 'trash'), { recursive: true });
    helper = createSiteFsServer({
      publicDir: pub, trashDir: join(dir, 'trash'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024,
      purgeDays: 30, now: () => new Date(clock * 1000),
    });
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    const u = await createUser(db, clock, COMMAND_LINE, 'sitesuser', 'Sites User', 'member', MEMBER);
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });
  after(() => new Promise<void>((r) => helper.close(() => r())));

  it('needs a session', async () => {
    const stranger = new Browser('203.0.113.91');
    assert.equal((await stranger.get('/api/sites')).status, 401);
    assert.equal((await stranger.post('/api/sites', { name: 'x' })).status, 401);
  });

  it('creates, lists, trashes (after a passkey check) and restores, logging each', async () => {
    const c = await b.post('/api/sites', { name: 'recipes' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.ok(existsSync(join(pub, 'recipes', 'index.html')));
    assert.equal((await b.post('/api/sites', { name: 'recipes' })).status, 409);
    assert.equal((await b.post('/api/sites', { name: 'Not Valid' })).status, 400);
    assert.equal((await b.post('/api/sites', { name: 'panel' })).status, 400);

    const list = await b.get('/api/sites');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.folders.map((f: { name: string }) => f.name), ['recipes']);

    advance(11 * 60);
    const refused = await b.post('/api/sites/trash', { name: 'recipes' });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'reauth-required');
    assert.ok(existsSync(join(pub, 'recipes')));
    assert.equal((await b.confirm()).status, 200);
    const t = await b.post('/api/sites/trash', { name: 'recipes' });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.ok(!existsSync(join(pub, 'recipes')));

    await b.post('/api/sites', { name: 'recipes' });
    assert.equal((await b.post('/api/sites/restore', { entry: t.json.entry })).status, 409);
    const r = await b.post('/api/sites/restore', { entry: t.json.entry, as: 'recipes-old' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'recipes-old');

    const acts = await all(db, "SELECT action, target, detail FROM activity WHERE actor_label = 'sitesuser' AND action LIKE '%folder%' OR action = 'subdomain-created' ORDER BY id") as { action: string; target: string; detail: string | null }[];
    assert.deepEqual(acts.map((x) => `${x.action}:${x.target}`), ['subdomain-created:recipes', 'folder-trashed:recipes', 'subdomain-created:recipes', 'folder-restored:recipes-old']);
    assert.equal(acts[3]!.detail, 'was "recipes"');
  });

  it('a temporary home page for a folder with none: made, changed, removed, logged', async () => {
    mkdirSync(join(pub, 'garden'));
    writeFileSync(join(pub, 'style.css'), 'body { }');
    const folder = async () => (await b.get('/api/sites')).json.folders.find((f: { name: string }) => f.name === 'garden');
    assert.deepEqual([(await folder()).homePage, (await folder()).protected], ['none', false]);

    const g = await b.get('/api/sites/garden/home-page');
    assert.deepEqual([g.status, g.json.kind, g.json.site, g.json.styles.map((x: { id: string }) => x.id)], [200, 'none', 'pammy.org', ['plain', 'site:style.css']]);
    const made = await b.post('/api/sites/garden/home-page', { heading: 'Coming soon', message: 'Seeds first.', link: true, style: 'site:style.css' });
    assert.deepEqual([made.status, made.json.made, made.json.address], [200, true, 'https://garden.pammy.org/']);
    assert.match(readFileSync(join(pub, 'garden', 'index.html'), 'utf8'), /href="https:\/\/pammy\.org\/style\.css"/);
    assert.equal((await folder()).homePage, 'temporary');
    assert.equal((await b.post('/api/sites/garden/home-page', { heading: 'Open in May', message: '', link: false, style: 'plain' })).json.made, false);
    assert.equal((await b.post('/api/sites/garden/home-page/remove', {})).status, 200);
    assert.equal((await folder()).homePage, 'none');

    // never over hers
    writeFileSync(join(pub, 'garden', 'index.html'), '<h1>Mine</h1>');
    assert.equal((await b.post('/api/sites/garden/home-page', { heading: 'x', message: '', link: false, style: 'plain' })).status, 409);
    assert.equal((await b.post('/api/sites/garden/home-page/remove', {})).status, 403);
    assert.equal(readFileSync(join(pub, 'garden', 'index.html'), 'utf8'), '<h1>Mine</h1>');
    assert.equal((await b.get('/api/sites/..%2Fetc/home-page')).status, 400);

    const acts = await all(db, "SELECT action, target, detail FROM activity WHERE action LIKE 'home-page-%' ORDER BY id") as { action: string; target: string; detail: string | null }[];
    assert.deepEqual(acts.map((x) => `${x.action}:${x.target}:${x.detail}`),
      ['home-page-made:garden:"Coming soon"', 'home-page-changed:garden:"Open in May"', 'home-page-removed:garden:null']);
    rmSync(join(pub, 'garden'), { recursive: true });
    rmSync(join(pub, 'style.css'));
  });

  it('turns a missing helper into a clear 503', async () => {
    await new Promise<void>((r) => helper.close(() => r()));
    const res = await b.get('/api/sites');
    assert.equal(res.status, 503);
    assert.match(res.json.message, /helper isn't answering/);
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
  });
});

describe('protected folders and people through the panel', () => {
  const b = new Browser('203.0.113.95');
  let helper: ReturnType<typeof createSiteFsServer>;
  let gateAdmin: ReturnType<typeof createGateAdminServer>;
  let gate: GateLive;
  let pub = '';
  let areaId = 0;
  let personId = 0;
  const state = () => handleAdmin(gate, clock, { op: 'state' }) as Promise<{ areas: { id: number; path: string; visitors: number[] }[]; visitors: { id: number; username: string; active: boolean }[] }>;

  before(async () => {
    pub = join(dir, 'public');
    mkdirSync(join(pub, 'club', 'inner'), { recursive: true });
    mkdirSync(join(dir, 'trash'), { recursive: true });
    helper = createSiteFsServer({
      publicDir: pub, trashDir: join(dir, 'trash'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024,
      purgeDays: 30, now: () => new Date(clock * 1000),
    });
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    gate = await newGate(await gatePg(), () => clock);
    gateAdmin = createGateAdminServer(gate, () => clock);
    await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
    const u = await createUser(db, clock, COMMAND_LINE, 'protector', 'Protector', 'member', MEMBER);
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => helper.close(() => r()));
    await new Promise<void>((r) => gateAdmin.close(() => r()));
    await gate.db.end({ timeout: 2 });
  });

  it('lists folders to choose from', async () => {
    const r = await b.get('/api/folders');
    assert.equal(r.status, 200);
    assert.ok(r.json.folders.includes('club') && r.json.folders.includes('club/inner'));
  });

  it('protects a folder: gate area, marker and starter login.html together', async () => {
    const r = await b.post('/api/protected', { path: '/club/' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.path, 'club');
    assert.equal(r.json.loginCreated, true);
    areaId = r.json.id;
    assert.ok(existsSync(join(pub, 'club', '.pammy-protected')));
    assert.ok(existsSync(join(pub, 'club', 'login.html')));
    assert.equal((await b.post('/api/protected', { path: 'club' })).status, 409);
  });

  it("doesn't leave a half-made protection behind when the folder doesn't exist", async () => {
    const r = await b.post('/api/protected', { path: 'no-such-folder' });
    assert.equal(r.status, 404);
    assert.deepEqual((await state()).areas.map((a) => a.path), ['club']);
    assert.equal((await b.post('/api/protected', { path: '../etc' })).status, 400);
  });

  it('adds a person who can open it, and refuses weak passwords', async () => {
    assert.equal((await b.post('/api/visitors', { username: 'auntie.jo', password: 'short', areaIds: [areaId] })).status, 400);
    const r = await b.post('/api/visitors', { username: 'Auntie.Jo', name: 'Auntie Jo', password: 'a-long-secret-password', areaIds: [areaId] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    personId = r.json.id;
    const st = await state();
    assert.deepEqual(st.areas[0]!.visitors, [personId]);
    const view = await b.get('/api/protected');
    assert.equal(view.json.areas[0].hasLogin, true);
    assert.equal(view.json.visitors[0].username, 'auntie.jo');
    // the People page's list: the gate's alone (no folder helper), the same people and folders
    const people = await b.get('/api/people');
    assert.equal(people.status, 200);
    assert.deepEqual(people.json.visitors, view.json.visitors);
    assert.deepEqual(people.json.areas.map((x: { id: number; visitors: number[] }) => [x.id, x.visitors]), [[areaId, [personId]]]);
  });

  it('changes who can open it', async () => {
    assert.equal((await b.post(`/api/protected/${areaId}/access`, { visitorId: personId, allow: false })).status, 200);
    assert.deepEqual((await state()).areas[0]!.visitors, []);
    assert.equal((await b.post(`/api/protected/${areaId}/access`, { visitorId: personId, allow: true })).status, 200);
    assert.equal((await b.post(`/api/protected/${areaId}/access`, { visitorId: 9999, allow: true })).status, 404);
  });

  it('changes passwords, switches people off and on, renames and signs them out', async () => {
    assert.equal((await b.post(`/api/visitors/${personId}/password`, { password: 'another-long-password' })).status, 200);
    assert.equal((await b.post(`/api/visitors/${personId}/password`, { password: 'short' })).status, 400);
    assert.equal((await b.post(`/api/visitors/${personId}/active`, { active: false })).status, 200);
    assert.equal((await state()).visitors[0]!.active, false);
    assert.equal((await b.post(`/api/visitors/${personId}/active`, { active: true })).status, 200);
    assert.equal((await b.post(`/api/visitors/${personId}/rename`, { name: 'Jo' })).status, 200);
    assert.equal((await b.post(`/api/visitors/${personId}/signout`)).status, 200);
  });

  it('follows a folder renamed in WinSCP, and puts back a deleted marker', async () => {
    renameSync(join(pub, 'club'), join(pub, 'club2'));
    const r = await b.get('/api/protected');
    assert.equal(r.json.areas[0].path, 'club2');
    assert.equal((await state()).areas[0]!.path, 'club2');

    rmSync(join(pub, 'club2', '.pammy-protected'));
    await b.get('/api/protected');
    assert.ok(existsSync(join(pub, 'club2', '.pammy-protected')), 'marker restored');
  });

  it('reports markers it does not recognise as locked folders', async () => {
    mkdirSync(join(pub, 'mystery'));
    writeFileSync(join(pub, 'mystery', '.pammy-protected'), `pammy-protected ${'Q'.repeat(32)}\n`);
    assert.deepEqual((await b.get('/api/protected')).json.locked, ['mystery']);
  });

  const ALL_PAGES = ['login.html', 'login-forgot.html', 'login-invite.html', 'login-request.html', 'logout.html', 'login-files/style.css'];
  const links: string[] = [];
  const gateState = () => handleAdmin(gate, clock, { op: 'state' }) as Promise<any>;

  it('puts starter copies of all five sign-in pages and their stylesheet in, and adds back missing ones on request', async () => {
    const view = await b.get('/api/protected');
    assert.deepEqual(view.json.areas[0].pages, ALL_PAGES);
    rmSync(join(pub, 'club2', 'login-forgot.html'));
    assert.deepEqual((await b.get('/api/protected')).json.areas[0].pages, ALL_PAGES.filter((p) => p !== 'login-forgot.html'));
    const r = await b.post(`/api/protected/${areaId}/pages`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.created, ['login-forgot.html']);
    assert.ok(existsSync(join(pub, 'club2', 'login-forgot.html')));
  });

  it('switches access requests off and on for a folder', async () => {
    assert.equal((await b.post(`/api/protected/${areaId}/requests`, { open: false })).status, 200);
    assert.equal((await gateState()).areas[0].requestsOpen, false);
    assert.equal((await b.post(`/api/protected/${areaId}/requests`, { open: true })).status, 200);
    assert.equal((await b.get('/api/protected')).json.areas[0].requestsOpen, true);
  });

  it('adds a person who chooses their own password with a setup link', async () => {
    const r = await b.post('/api/visitors', { username: 'rose', name: 'Rose', contact: '07700 900123', areaIds: [areaId] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.link.url, /^https:\/\/pammy\.org\/_pammy\/invite#[A-Za-z0-9_-]{43}$/);
    assert.equal(r.json.link.firstPassword, true);
    links.push(r.json.link.url);
    const rose = (await gateState()).visitors.find((v: { username: string }) => v.username === 'rose');
    assert.deepEqual([rose.hasPassword, rose.contact, rose.areas, typeof rose.linkExpiresAt], [false, '07700 900123', [areaId], 'number']);

    const again = await b.post(`/api/visitors/${rose.id}/link`, {});
    assert.equal(again.status, 200);
    assert.notEqual(again.json.link.url, r.json.link.url);
    links.push(again.json.link.url);
    assert.equal((await b.post(`/api/visitors/${rose.id}/link/cancel`, {})).status, 200);
    assert.equal((await gateState()).visitors.find((v: { id: number }) => v.id === rose.id).linkExpiresAt, null);
    assert.equal((await b.post(`/api/visitors/${rose.id}/contact`, { contact: 'rose@example.com' })).status, 200);
    assert.equal((await gateState()).visitors.find((v: { id: number }) => v.id === rose.id).contact, 'rose@example.com');
    assert.equal((await b.post('/api/visitors', { username: 'rose2', password: '', areaIds: [areaId] })).status, 400, 'an empty password is a mistake, not a request for a link');
  });

  it('approves an access request as a new person, and hands back a link for them', async () => {
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Sam Lee', contact: 'sam@example.com', message: 'hello' }, 'pammy.org', '198.51.100.1');
    const list = await b.get('/api/requests');
    assert.equal(list.json.open.length, 1);
    const req = list.json.open[0];
    assert.deepEqual([req.kind, req.name, req.contact, req.areaPath], ['access', 'Sam Lee', 'sam@example.com', 'club2']);
    assert.equal((await b.post(`/api/requests/${req.id}/approve`, { username: 'rose' })).status, 409, 'username taken: nothing done');
    assert.equal((await b.get('/api/requests')).json.open.length, 1);
    const r = await b.post(`/api/requests/${req.id}/approve`, { username: 'sam.lee', name: '' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.username, r.json.contact, r.json.areaPath, r.json.link.firstPassword], ['sam.lee', 'sam@example.com', 'club2', true]);
    links.push(r.json.link.url);
    const st = await gateState();
    const sam = st.visitors.find((v: { username: string }) => v.username === 'sam.lee');
    assert.deepEqual([sam.name, sam.contact, sam.areas], ['Sam Lee', 'sam@example.com', [areaId]]);
    assert.equal(st.requests.find((x: { id: number }) => x.id === req.id).status, 'done');
    assert.equal((await b.post(`/api/requests/${req.id}/approve`, { username: 'sam2' })).status, 409, 'only once');
  });

  it("approves someone already on the list: no link if they have a password", async () => {
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Jo', contact: 'jo', message: '' }, 'pammy.org', null);
    const req = (await b.get('/api/requests')).json.open[0];
    const r = await b.post(`/api/requests/${req.id}/approve`, { visitorId: personId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.link, null);
  });

  // docs/roles-plan.md step 5 (S5-7): with roles on and more than Member to give,
  // the request lists the area's roles, and approving gives the one picked
  it('with roles on, approving gives the role picked', async () => {
    await setVisitorSwitch(gate.db, clock, 'roles', true, 'test', { mail: false });
    await copySet(gate.db, clock, areaId);
    const helperId = (await saveRole(gate.db, areaId, { label: 'Helper', privileges: ['pages.read'] })).id;
    try {
      await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Kit', contact: 'kit', message: '' }, 'pammy.org', null);
      const req = (await b.get('/api/requests')).json.open[0];
      assert.deepEqual(req.roles.map((x: { label: string }) => x.label).sort(), ['Helper', 'Member']);
      assert.equal((await b.post(`/api/requests/${req.id}/approve`, { username: 'kit', roleId: 'x' })).status, 400);
      assert.equal((await b.post(`/api/requests/${req.id}/approve`, { username: 'kit', roleId: 999999 })).status, 404, 'a role that isn\'t the area\'s');
      const r = await b.post(`/api/requests/${req.id}/approve`, { username: 'kit', roleId: helperId });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.role, 'Helper');
      const kit = (await gateState()).visitors.find((v: { username: string }) => v.username === 'kit');
      assert.equal((await rolesOf(gate.db, kit.id, areaId)).get(areaId)?.role, 'Helper');
      const act = await one<{ detail: string }>(db, "SELECT detail FROM activity WHERE action = 'request-approved' ORDER BY id DESC LIMIT 1");
      assert.equal(act?.detail, 'kit, role Helper');
    } finally {
      await resetSet(gate.db, areaId);
      await setVisitorSwitch(gate.db, clock, 'roles', false, 'test', { mail: false });
    }
    // roles off: nothing to pick
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Lu', contact: 'lu', message: '' }, 'pammy.org', null);
    const lu = (await b.get('/api/requests')).json.open[0];
    assert.equal(lu.roles, undefined);
    assert.equal((await b.post(`/api/requests/${lu.id}/decline`, {})).status, 200);
  });

  it('makes a new-password link for someone who forgot theirs; declines and deletes others', async () => {
    await addResetRequest(gate.db, clock, (await areaById(gate.db, areaId))!, 'auntie.jo', 'please', 'pammy.org', null);
    const reset = (await b.get('/api/requests')).json.open[0];
    assert.equal(reset.person.username, 'auntie.jo');
    const r = await b.post(`/api/requests/${reset.id}/approve`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.link.firstPassword, false);
    links.push(r.json.link.url);

    await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Stranger', contact: 's', message: '' }, 'pammy.org', null);
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, areaId))!, { name: 'Spammer', contact: 'x', message: 'buy' }, 'pammy.org', null);
    const open = (await b.get('/api/requests')).json.open;
    const stranger = open.find((x: { name: string }) => x.name === 'Stranger');
    const spammer = open.find((x: { name: string }) => x.name === 'Spammer');
    assert.equal((await b.post(`/api/requests/${stranger.id}/decline`, {})).status, 200);
    assert.equal((await b.post(`/api/requests/${spammer.id}/delete`, {})).status, 200);
    const after = await b.get('/api/requests');
    assert.deepEqual(after.json.open, []);
    assert.equal(after.json.recent.find((x: { id: number }) => x.id === stranger.id).status, 'declined');
    assert.ok(!after.json.recent.some((x: { id: number }) => x.id === spammer.id));
  });

  it('logs requests and links in plain words, and never a link', async () => {
    const actions = (await all(db, 'SELECT action FROM activity') as { action: string }[]).map((r) => r.action);
    for (const a of ['signin-pages-added', 'requests-closed', 'requests-opened', 'person-link-created', 'person-link-cancelled',
      'person-contact-changed', 'request-approved', 'request-declined', 'request-deleted']) {
      assert.ok(actions.includes(a), `missing ${a}`);
    }
    const everything = JSON.stringify(await all(db, 'SELECT * FROM activity'));
    assert.equal(links.length, 4);
    for (const l of links) assert.ok(!everything.includes(l.split('#')[1]!), 'no link tokens in the activity log');
  });

  it('removing a person and unprotecting need a fresh passkey check', async () => {
    advance(11 * 60);
    assert.equal((await b.post(`/api/visitors/${personId}/delete`)).json.error, 'reauth-required');
    assert.equal((await b.post(`/api/protected/${areaId}/unprotect`)).json.error, 'reauth-required');
    assert.ok(existsSync(join(pub, 'club2', '.pammy-protected')));
    assert.equal((await b.confirm()).status, 200);
    assert.equal((await b.post(`/api/protected/${areaId}/unprotect`)).status, 200);
    assert.ok(!existsSync(join(pub, 'club2', '.pammy-protected')));
    assert.ok(existsSync(join(pub, 'club2', 'login.html')), "her login.html stays");
    assert.deepEqual((await state()).areas, []);
    assert.equal((await b.post(`/api/visitors/${personId}/delete`)).status, 200);
    assert.ok(!(await state()).visitors.some((v) => v.id === personId));
  });

  it('visitor settings (docs/accounts-plan.md steps 1 and 4): account managers see every switch off, and what each needs', async () => {
    assert.equal((await b.get('/api/visitor-settings')).status, 404, 'a new right: members have it only if given (R4: not there for them)');
    const boss = new Browser('203.0.113.96');
    const u = await createUser(db, clock, COMMAND_LINE, 'settings-boss', 'Settings Boss', 'manager');
    assert.equal((await boss.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    const r = await boss.get('/api/visitor-settings');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.switches.map((x: { key: string; on: boolean }) => [x.key, x.on]),
      [['emailedLinks', false], ['selfRegister', false], ['changePassword', false], ['deleteAccount', false], ['openAreas', false], ['roles', false]]);
    // this panel's gate has no door to a mail service; "Open with accounts" is roles step 5
    const blocked = Object.fromEntries(r.json.switches.map((x: { key: string; blocked: string | null }) => [x.key, x.blocked]));
    assert.deepEqual(blocked, {
      emailedLinks: "Mail isn't set up for visitors on this site.", selfRegister: 'Needs "Emailed links" on first.',
      changePassword: null, deleteAccount: null, openAreas: 'Needs "People can register themselves" on first.', roles: null,
    });
    const refused = await boss.post('/api/visitor-settings', { key: 'emailedLinks', on: true });
    assert.deepEqual([refused.status, refused.json.message], [400, "Mail isn't set up for visitors on this site."]);
    const off = await boss.post('/api/visitor-settings', { key: 'openAreas', on: false });
    assert.equal(off.status, 200);
    assert.ok(off.json.switches.every((x: { on: boolean }) => !x.on));
    assert.equal((await all(db, "SELECT 1 FROM activity WHERE action LIKE 'visitor-setting-%'")).length, 0, 'nothing changed, nothing logged');
    // one that needs nothing goes on, and off again, each in Activity
    const on = await boss.post('/api/visitor-settings', { key: 'changePassword', on: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.switches.find((x: { key: string }) => x.key === 'changePassword').on, true);
    assert.equal((await boss.post('/api/visitor-settings', { key: 'changePassword', on: false })).status, 200);
    assert.deepEqual((await all<{ action: string }>(db, "SELECT action FROM activity WHERE action LIKE 'visitor-setting-%' ORDER BY id")).map((x) => x.action),
      ['visitor-setting-on', 'visitor-setting-off']);
    assert.equal((await b.post('/api/visitor-settings', { key: 'openAreas', on: false })).status, 404);
  });

  it('the Access page (docs/roles-plan.md step 4): nothing changes with roles off; on, a folder gets roles of its own, and back', async () => {
    mkdirSync(join(pub, 'roles-club'), { recursive: true });
    const folder = await b.post('/api/protected', { path: 'roles-club' });
    assert.equal(folder.status, 200, JSON.stringify(folder.json));
    const id = folder.json.id as number;
    const person = await b.post('/api/visitors', { username: 'role.person', name: '', contact: '', password: 'role-person-password', areaIds: [id] });
    assert.equal(person.status, 200, JSON.stringify(person.json));

    let v = await b.get(`/api/access/${id}`);
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.deepEqual([v.json.rolesOn, v.json.set.label, v.json.set.builtIn], [false, 'Protected folder', true]);
    assert.ok(v.json.people.some((p: { username: string }) => p.username === 'role.person'));
    assert.equal((await b.get('/api/protected')).json.rolesOn, false);
    const off = await b.post(`/api/access/${id}/copy`, {});
    assert.deepEqual([off.status, off.json.message], [400, 'Roles and privileges are switched off (Settings, Visitors).']);

    // an account manager turns roles on (the protector hasn't the right)
    assert.equal((await b.post('/api/visitor-settings', { key: 'roles', on: true })).status, 404);
    const boss = new Browser('203.0.113.97');
    const u = await createUser(db, clock, COMMAND_LINE, 'roles-boss', 'Roles Boss', 'manager');
    assert.equal((await boss.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    assert.equal((await boss.post('/api/visitor-settings', { key: 'roles', on: true })).status, 200);
    assert.equal((await b.get('/api/protected')).json.rolesOn, true);

    assert.equal((await b.post(`/api/access/${id}/copy`, {})).status, 200);
    v = await b.get(`/api/access/${id}`);
    assert.deepEqual([v.json.set.builtIn, v.json.canEditRoles, v.json.canEditPrivileges], [false, true, true]);
    assert.equal((await b.post(`/api/access/${id}/resource`, { key: 'notes', label: 'Notes', owned: true, actions: ['read', 'update'] })).status, 200);
    const role = await b.post(`/api/access/${id}/role`, { label: 'Editor', privileges: ['pages.read', 'notes.update:own'] });
    assert.equal(role.status, 200, JSON.stringify(role.json));
    const pid = person.json.id as number;
    assert.equal((await b.post(`/api/access/${id}/person`, { visitorId: pid, roleId: role.json.result.id })).status, 200);
    v = await b.get(`/api/access/${id}`);
    assert.deepEqual(v.json.members.filter((m: { visitorId: number }) => m.visitorId === pid).map((m: { roleId: number }) => m.roleId), [role.json.result.id]);
    const missing = await b.post(`/api/access/${id}/manifest`, {});
    assert.deepEqual([missing.status, missing.json.message], [404, 'There\'s no pammy-panel.json at the top of "roles-club".']);

    // roles can't be switched off while a folder has its own
    const blocked = await boss.post('/api/visitor-settings', { key: 'roles', on: false });
    assert.deepEqual([blocked.status, blocked.json.message], [400, 'First put "roles-club" back on the built-in roles (Access, Roles).']);
    const back = await b.post(`/api/access/${id}/reset`, {});
    assert.deepEqual([back.status, back.json.result.lost], [200, ['role.person']]);
    assert.equal((await boss.post('/api/visitor-settings', { key: 'roles', on: false })).status, 200);

    const acts = (await all(db, "SELECT action, detail FROM activity WHERE target = 'roles-club' ORDER BY id") as { action: string; detail: string | null }[]).map((r) => r.action);
    for (const a of ['roles-copied', 'privileges-changed', 'role-saved', 'person-role', 'roles-reset']) assert.ok(acts.includes(a), `missing ${a}`);
    assert.equal((await b.get('/api/access/999999')).status, 404);
  });

  it('logs every change in plain words, and never a password', async () => {
    const rows = await all(db, "SELECT action, target, detail FROM activity WHERE actor_label IN ('protector', 'automatic') ORDER BY id") as { action: string; target: string; detail: string | null }[];
    const actions = rows.map((r) => r.action);
    for (const a of ['folder-protected', 'person-added', 'access-removed', 'access-granted', 'person-password-changed',
      'person-switched-off', 'person-switched-on', 'person-renamed', 'person-signed-out', 'protection-followed',
      'folder-unprotected', 'person-removed']) {
      assert.ok(actions.includes(a), `missing ${a}`);
    }
    const added = rows.find((r) => r.action === 'person-added')!;
    assert.deepEqual([added.target, added.detail], ['auntie.jo', 'can open club']);
    const everything = JSON.stringify(await all(db, 'SELECT * FROM activity'));
    assert.ok(!everything.includes('long-secret') && !everything.includes('another-long'), 'no passwords in the activity log');
  });
});

describe('forms, responses, API keys and help through the panel', () => {
  const b = new Browser('203.0.113.97');
  let helper: ReturnType<typeof createSiteFsServer>;
  let gateAdmin: ReturnType<typeof createGateAdminServer>;
  let gate: GateLive;
  let pub = '';
  let formId = 0;
  let version = 0;
  const actionsOf = async () => await all(db, "SELECT action, target, detail FROM activity WHERE actor_label = 'former' ORDER BY id") as { action: string; target: string; detail: string | null }[];

  before(async () => {
    pub = join(dir, 'public-forms');
    mkdirSync(join(pub, 'shop'), { recursive: true });
    mkdirSync(join(pub, 'club', 'inner'), { recursive: true });
    writeFileSync(join(pub, 'club', 'inner', 'rsvp.html'), 'hers');
    helper = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-forms'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    gate = await newGate(await gatePg(), () => clock);
    gateAdmin = createGateAdminServer(gate, () => clock);
    await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
    await handleAdmin(gate, clock, { op: 'area.create', path: 'club' });
    const u = await createUser(db, clock, COMMAND_LINE, 'former', 'Former', 'member', MEMBER);
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => helper.close(() => r()));
    await new Promise<void>((r) => gateAdmin.close(() => r()));
    await gate.db.end({ timeout: 2 });
  });

  it('needs a session', async () => {
    const stranger = new Browser('203.0.113.98');
    for (const url of ['/api/forms', '/api/responses', '/api/responses/unread', '/api/api-keys', '/api/help']) {
      assert.equal((await stranger.get(url)).status, 401, url);
    }
    assert.equal((await stranger.post('/api/forms', { name: 'x' })).status, 401);
  });

  it('lists the forms: the converted sample, and the three examples', async () => {
    const r = await b.get('/api/forms');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.forms.map((f: { name: string; enabled: boolean }) => [f.name, f.enabled]), [
      ['example-guest-book', true], ['example-pinboard', true], ['example-rsvp', true], ['sample-contact-form', false],
    ]);
    // the examples arrive ready to show: on, approvable and readable by anyone
    const guestbook = r.json.forms.find((f: { name: string }) => f.name === 'example-guest-book');
    assert.deepEqual([guestbook.fixture, guestbook.approvable, guestbook.publicApproved], ['guestbook', true, true]);
  });

  it('makes, saves, duplicates and switches forms, logging each', async () => {
    assert.equal((await b.post('/api/forms', { name: 'Bad Name' })).status, 400);
    const made = await b.post('/api/forms', { name: 'bookings', title: 'Table bookings', items: [{ type: 'short-text', label: 'Name', required: true }] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    formId = made.json.form.id;
    version = made.json.form.version;
    assert.deepEqual([made.json.form.name, made.json.form.enabled], ['bookings', true]);

    const saved = await b.post(`/api/forms/${formId}`, { version, items: [...made.json.form.items, { type: 'number', label: 'Guests' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    version = saved.json.form.version;
    assert.deepEqual((await formById(gate.db, formId))!.items.map((i) => i.key), ['name', 'guests']);
    const stale = await b.post(`/api/forms/${formId}`, { version: version - 1, items: saved.json.form.items });
    assert.deepEqual([stale.status, /saved this form/.test(stale.json.message)], [409, true]);
    assert.equal((await b.post('/api/forms/9999', { version: 1, items: [] })).status, 404);

    const copyName = await b.get(`/api/forms/${formId}/copy-name`);
    assert.equal(copyName.json.name, 'bookings-copy');
    const copy = await b.post(`/api/forms/${formId}/duplicate`, { name: copyName.json.name });
    assert.equal(copy.json.form.name, 'bookings-copy');
    assert.equal((await b.post(`/api/forms/${formId}/switches`, { enabled: false })).json.form.enabled, false);
    assert.equal((await b.post(`/api/forms/${formId}/switches`, { enabled: true, approvable: true })).json.form.approvable, true);

    const acts = (await actionsOf());
    assert.deepEqual(acts.filter((x) => x.action.startsWith('form-')).map((x) => `${x.action}:${x.target}`),
      ['form-created:bookings', 'form-saved:bookings', 'form-duplicated:bookings-copy', 'form-switched:bookings', 'form-switched:bookings']);
    assert.equal(acts.find((x) => x.action === 'form-duplicated')!.detail, 'copied from "bookings"');
  });

  it('trashes a form after a passkey check, and restores it', async () => {
    const spare = (await b.post('/api/forms', { name: 'spare-form', items: [{ type: 'short-text', label: 'x' }] })).json.form.id;
    advance(11 * 60);
    assert.equal((await b.post(`/api/forms/${spare}/trash`)).json.error, 'reauth-required');
    assert.equal((await b.confirm()).status, 200);
    assert.equal((await b.post(`/api/forms/${spare}/trash`)).status, 200);
    assert.ok((await formById(gate.db, spare))!.trashedAt);
    assert.equal((await b.post(`/api/forms/${spare}/restore`)).status, 200);
    assert.ok(!(await formById(gate.db, spare))!.trashedAt);
    assert.ok((await actionsOf()).some((x) => x.action === 'form-trashed') && (await actionsOf()).some((x) => x.action === 'form-restored'));
  });

  it('lists responses, marks them read, approves, trashes and restores them', async () => {
    const form = (await formById(gate.db, formId))!;
    const ids: number[] = [];
    for (const i of [1, 2, 3]) ids.push(await addResponse(gate.db, clock + i, form, 'shop/rsvp.html', { name: `Guest ${i}`, guests: String(i) }, null, 'pammy.org', null));
    await addResponse(gate.db, clock + 4, (await formById(gate.db, 1))!, 'shop/rsvp.html', { 'your-name': 'Other', 'email-address': 'other@example.com', message: 'private words' }, null, 'pammy.org', null);
    const list = await b.get('/api/responses?examples=hide');
    assert.equal(list.status, 200);
    assert.equal(list.json.responses.length, 4);
    // the examples' entries sit in the full list, and never in the red number
    assert.equal((await b.get('/api/responses')).json.responses.length, 4 + 11);
    assert.equal((await b.get('/api/responses')).json.unread, 4);
    assert.deepEqual(list.json.responses[1].answers, [{ key: 'name', label: 'Name', type: 'short-text', value: 'Guest 3' }, { key: 'guests', label: 'Guests', type: 'number', value: 3 }]);
    assert.equal((await b.get('/api/responses/unread')).json.unread, 4);
    assert.equal((await b.get(`/api/responses?form=${formId}`)).json.responses.length, 3);

    assert.equal((await b.post(`/api/responses/${ids[0]}/read`, { read: true })).status, 200);
    assert.equal((await b.get('/api/responses?read=unread')).json.responses.length, 3);
    assert.equal((await b.get('/api/responses?read=read')).json.responses.length, 1 + 11);
    assert.equal((await b.post('/api/responses/read-all', { formId })).json.marked, 2);
    assert.equal((await b.post('/api/responses/99999/read', { read: true })).status, 404);

    assert.equal((await b.post(`/api/responses/${ids[1]}/approve`, { approved: true })).status, 200);
    assert.deepEqual((await b.get(`/api/responses?form=${formId}&approval=approved`)).json.responses.map((r: { id: number }) => r.id), [ids[1]]);
    assert.equal((await b.post(`/api/responses/${ids[1]}/approve`, { approved: false })).status, 200);

    assert.equal((await b.post(`/api/responses/${ids[1]}/trash`)).status, 200);
    assert.deepEqual((await b.get('/api/responses?view=trash')).json.responses.map((m: { id: number }) => m.id), [ids[1]]);
    assert.equal((await b.post(`/api/responses/${ids[1]}/restore`)).status, 200);

    const acts = (await actionsOf());
    assert.ok(acts.some((x) => x.action === 'response-trashed') && acts.some((x) => x.action === 'response-restored'));
    assert.ok(acts.some((x) => x.action === 'response-approved') && acts.some((x) => x.action === 'response-unapproved'));
    assert.ok(!acts.some((x) => x.action.includes('read')), 'reading is not logged');
    const everything = JSON.stringify(await all(db, 'SELECT * FROM activity'));
    assert.ok(!everything.includes('private words') && !everything.includes('Guest 2'), 'no answers in the activity log');
  });

  it('only an account manager, just after a passkey check, can make or revoke an API key', async () => {
    // the list too: API keys are the programs right, which only account managers
    // have for now (docs/permissions-plan.md R2, no "see" level)
    assert.equal((await b.get('/api/api-keys')).json.error, 'not-found');
    assert.equal((await b.post('/api/api-keys', { label: 'Site', level: 'approved', forms: 'all' })).json.error, 'not-found');
    await setRole(db, clock, COMMAND_LINE, (await getUserByName(db, 'former'))!, 'manager');
    advance(11 * 60);
    assert.equal((await b.post('/api/api-keys', { label: 'Site', level: 'approved', forms: 'all' })).json.error, 'reauth-required');
    assert.equal((await b.confirm()).status, 200);
    const made = await b.post('/api/api-keys', { label: 'Olivia site', level: 'approved', forms: [formId] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.match(made.json.key, /^pammy_[A-Za-z0-9_-]{43}$/);
    const keys = (await b.get('/api/api-keys')).json.keys as { id: number; label: string; prefix: string; revokedAt: number | null }[];
    assert.deepEqual(keys.map((k) => k.label), ['Olivia site']);
    assert.ok(!JSON.stringify(keys).includes(made.json.key), 'the key itself is shown once and never again');
    assert.equal((await b.post(`/api/api-keys/${keys[0]!.id}/revoke`)).status, 200);
    assert.ok(((await b.get('/api/api-keys')).json.keys as { revokedAt: number | null }[])[0]!.revokedAt);
    assert.deepEqual((await actionsOf()).filter((x) => x.action.startsWith('api-key')).map((x) => `${x.action}:${x.target}`),
      ['api-key-created:Olivia site', 'api-key-revoked:Olivia site']);
  });

  it('asks for a passkey before letting anyone read approved responses without a key', async () => {
    advance(11 * 60);
    assert.equal((await b.post(`/api/forms/${formId}/switches`, { publicApproved: true })).json.error, 'reauth-required');
    assert.equal((await b.confirm()).status, 200);
    assert.equal((await b.post(`/api/forms/${formId}/switches`, { publicApproved: true })).json.form.publicApproved, true);
  });

  it('asks for a passkey before showing new responses right away, not before going back to waiting', async () => {
    advance(11 * 60);
    assert.equal((await b.post(`/api/forms/${formId}/switches`, { autoApprove: true })).json.error, 'reauth-required');
    assert.equal((await b.confirm()).status, 200);
    const on = await b.post(`/api/forms/${formId}/switches`, { autoApprove: true });
    assert.deepEqual([on.json.form.autoApprove, on.json.unreviewedAuto], [true, 0]);
    advance(11 * 60);
    const off = await b.post(`/api/forms/${formId}/switches`, { autoApprove: false });
    assert.deepEqual([off.status, off.json.form.autoApprove], [200, false]);
    const hid = await b.post(`/api/forms/${formId}/hide-unreviewed`, {});
    assert.deepEqual([hid.status, hid.json.hidden], [200, 0]);
    const details = (await actionsOf()).filter((x) => x.action === 'form-switched' || x.action === 'responses-unapproved').map((x) => x.detail).slice(-3);
    assert.deepEqual(details, ['new responses: shown right away', 'new responses: wait for approval', "hid 0 responses nobody had looked at"]);
    assert.equal((await b.confirm()).status, 200, 'fresh again for what comes next');
  });

  it('shows the three examples, the starters, and puts one back as it was', async () => {
    const r = await b.get('/api/examples');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.examples.map((e: { kind: string; formName: string; switchedOn: boolean }) => [e.kind, e.formName, e.switchedOn]), [
      ['guestbook', 'example-guest-book', true], ['rsvp', 'example-rsvp', true], ['pinboard', 'example-pinboard', true],
    ]);
    assert.deepEqual(r.json.starters.map((x: { kind: string }) => x.kind), ['contact', 'guestbook', 'rsvp', 'pinboard']);
    assert.equal(r.json.examples[0].responses, 3);

    const id = r.json.examples[0].formId;
    assert.equal((await b.post(`/api/forms/${id}/trash`)).json.error, 'refused', 'an example is never deleted');
    await b.post(`/api/forms/${id}/switches`, { enabled: false });
    const reset = await b.post('/api/examples/guestbook/reset', {});
    assert.deepEqual([reset.status, reset.json.form.enabled, reset.json.form.title], [200, true, 'Guest book']);
    assert.ok((await actionsOf()).some((x) => x.action === 'example-reset' && x.target === 'example-guest-book'));
    assert.equal((await b.post('/api/examples/nonesuch/reset', {})).status, 400);
  });

  it('puts an example page on her website, with a form of her own behind it', async () => {
    const made = await b.post('/api/examples/guestbook/install', { folder: 'shop', page: 'GuestBook.HTML', name: 'shop-guest-book' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.deepEqual([made.json.madeForm, made.json.form.name, made.json.folder, made.json.switchNeeded], [true, 'shop-guest-book', 'shop', true]);
    assert.deepEqual(made.json.created, ['guestbook.html', 'guestbook-files/style.css', 'guestbook-files/entries.js']);
    const page = readFileSync(join(pub, 'shop', 'guestbook.html'), 'utf8');
    assert.match(page, /<pammy-form name="shop-guest-book">/);
    assert.match(page, /href="guestbook-files\/style\.css"/);
    assert.ok(!page.includes('example-guest-book'), 'it is her form, not the example');
    assert.equal(made.json.address, 'https://pammy.org/shop/guestbook.html');
    assert.ok((await actionsOf()).some((x) => x.action === 'example-installed' && x.target === 'shop/guestbook.html'));

    // a second page can use the form she already has, and nothing is ever written over
    const again = await b.post('/api/examples/guestbook/install', { folder: 'shop', page: 'guestbook.html', formId: made.json.form.id });
    assert.deepEqual([again.status, again.json.error], [409, 'refused']);
    assert.match(again.json.message, /already a file called guestbook.html/);
    const second = await b.post('/api/examples/guestbook/install', { folder: 'shop', page: 'visitors-book.html', formId: made.json.form.id });
    assert.deepEqual([second.status, second.json.madeForm], [200, false]);
    assert.match(readFileSync(join(pub, 'shop', 'visitors-book.html'), 'utf8'), /name="shop-guest-book"/);

    assert.equal((await b.post('/api/examples/guestbook/install', { folder: 'shop', page: 'not a page' })).json.error, 'bad-page');
    const onto = await b.post('/api/examples/guestbook/install', { folder: 'shop', page: 'x.html', formId: (await b.get('/api/examples')).json.examples[0].formId });
    assert.equal(onto.json.error, 'fixture', 'her pages never point at the example form');
  });

  it('serves the guides for the Help tab, one per file, split into sections and formatted', async () => {
    const r = await b.get('/api/help');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.guides.map((g: { file: string; title: string; subtitle: string }) => [g.file, g.title, g.subtitle]),
      [['00-README.txt', 'Your instructions', ''], ['08-control-panel.txt', 'Your control panel', 'About 5 minutes.'], ['11-one-folder.txt', 'Looking after one folder', '']]);
    // the map's words (docs/phase9-plan.md 9-1)
    assert.deepEqual(r.json.guides.map((g: { parts: boolean; listed: boolean }) => [g.parts, g.listed]), [[false, false], [true, true], [false, false]]);
    assert.deepEqual(r.json.guides[1].sections, [
      { title: 'Introduction', part: null, flag: null, text: 'Intro words.', blocks: [{ t: 'p', text: 'Intro words.' }] },
      { title: 'Forms', part: 9, flag: null, text: 'Put <pammy-form> on any page.', blocks: [{ t: 'p', text: 'Put <pammy-form> on any page.' }] },
    ]);
  });
});

describe('every tab is its own address', () => {
  const b = new Browser('203.0.113.99');
  before(async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'pagevisitor', 'Page Visitor', 'member', MEMBER);
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });

  it('serves the panel at each page address when signed in', async () => {
    for (const path of ['/', '/subdomains', '/protected-folders', '/people', '/requests', '/visitor-settings', '/forms', '/forms/new', '/forms/12', '/responses',
      '/files', '/files/edit?path=olivia%2Findex.html', '/tags', '/tags?folder=*', '/media', '/media/tags', '/media/folders', '/examples', '/examples/guestbook', '/api-keys', '/passkeys', '/accounts', '/activity', '/help', '/help/control-panel',
      '/help/control-panel/part-9', '/responses?form=3', '/help?q=contact%20page', '/databases', '/databases/users', '/databases/users/postgres/website',
      '/databases/postgres/blog', '/databases/postgres/blog/canvas', '/databases/postgres/blog/tables/posts', '/databases/postgres/blog/review',
      '/databases/postgres/blog/app', '/databases/postgres/blog/app/posts', '/databases/postgres/blog/programs',
      '/app/postgres/blog/posts', '/app/postgres/blog/posts/new', '/app/postgres/blog/posts/edit', '/forms/3/database', '/comments', '/databases/tutorial-examples', '/getting-started', '/software', '/software/new', '/software/blog', '/email', '/hosts', '/hosts/add-domain', '/services', '/backups', '/catalog', '/catalog/examprep/topics', '/monitoring', '/projects/git-tokens', '/projects/shop/packages']) {
      const r = await b.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.body, /<div id="root"><\/div>/, path);
      assert.match(String(r.headers['content-security-policy']), /script-src 'self'/, path);
    }
    assert.equal(PAGE_PATHS.length, 62);
    assert.deepEqual([(await b.get('/home')).status, (await b.get('/home')).headers.location], [302, '/']);
    assert.equal((await b.get('/nope')).status, 404);
    assert.equal((await b.get('/help/a/b/c')).status, 404);
  });

  it('sends signed-out visitors to sign in, and back to that page afterwards', async () => {
    const stranger = new Browser('203.0.113.98');
    const r = await stranger.get('/help/control-panel/part-9?q=contact');
    assert.deepEqual([r.status, r.headers.location], [302, '/login?next=%2Fhelp%2Fcontrol-panel%2Fpart-9%3Fq%3Dcontact']);
    assert.equal((await stranger.get('/')).headers.location, '/login');
    const signedIn = await b.get('/login?next=%2Fresponses%3Fform%3D2');
    assert.deepEqual([signedIn.status, signedIn.headers.location], [302, '/responses?form=2']);
  });

  it('only ever returns to a panel page', () => {
    for (const [next, want] of [['/responses', '/responses'], ['/help/wordpress?q=x#part-2', '/help/wordpress?q=x#part-2'],
      ['//evil.example/', '/'], ['/\\evil.example', '/'], ['https://evil.example/', '/'], ['javascript:alert(1)', '/'],
      ['/login', '/'], ['/api/users', '/'], ['/assets/index-abc.js', '/'], ['/invite#token', '/'], ['', '/'], [undefined, '/'], ['/a b', '/']] as const) {
      assert.equal(nextPage(next), want, String(next));
    }
  });
});

describe('media folders through the panel', () => {
  const b = new Browser('203.0.113.100');
  let helper: ReturnType<typeof createSiteFsServer>;
  let pub = '';
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
  const upload = (dir: string, name: string, data: Buffer, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: `/api/media/upload?dir=${encodeURIComponent(dir)}`, remoteAddress: '127.0.0.1', payload: data,
    headers: { cookie: b.cookie, origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-pammy-name': encodeURIComponent(name), 'x-real-ip': b.ip, ...headers },
  });
  const acts = async () => await all(db, "SELECT action, target, detail FROM activity WHERE actor_label = 'mediauser' ORDER BY id") as { action: string; target: string; detail: string | null }[];

  before(async () => {
    pub = join(dir, 'public-media');
    mkdirSync(join(pub, 'recipes'), { recursive: true });
    mkdirSync(join(dir, 'trash-media'), { recursive: true });
    helper = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-media'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    const u = await createUser(db, clock, COMMAND_LINE, 'mediauser', 'Media User', 'member', MEMBER);
    assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });
  after(() => new Promise<void>((r) => helper.close(() => r())));

  it('needs a session, and uploads must come from the panel itself', async () => {
    const stranger = new Browser('203.0.113.101');
    assert.equal((await stranger.get('/api/media')).status, 401);
    assert.equal((await stranger.get('/api/media/file?path=media/images/x.jpg')).status, 401);
    const cross = await upload('recipes/media/images', 'x.jpg', JPEG, { origin: 'https://evil.example' });
    assert.equal(cross.statusCode, 403);
    const noName = await app.inject({ method: 'POST', url: '/api/media/upload?dir=recipes/media/images', remoteAddress: '127.0.0.1', payload: JPEG,
      headers: { cookie: b.cookie, origin: ORIGIN, 'content-type': 'application/octet-stream' } });
    assert.equal(noName.statusCode, 403, 'raw bytes without our header are refused like any cross-site post');
    assert.equal((await b.req('POST', '/api/media/mkdir', { dir: 'x', name: 'y' }, { 'content-type': 'application/octet-stream' })).status, 403, 'raw bytes only for uploads');
  });

  it('makes a media folder, uploads, lists who added what, and serves files (and parts of them)', async () => {
    const made = await b.post('/api/media/folder', { folder: '/recipes/' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.deepEqual(made.json.created, ['media', 'media/images', 'media/files', 'media/audio', 'media/video']);
    assert.deepEqual((await b.get('/api/media')).json.folders.map((f: { folder: string; hasMedia: boolean }) => `${f.folder}:${f.hasMedia}`), [':false', 'recipes:true']);

    const up = await upload('recipes/media/images', 'lasagne.jpg', JPEG);
    assert.equal(up.statusCode, 200, up.body);
    assert.deepEqual(JSON.parse(up.body), { ok: true, path: 'recipes/media/images/lasagne.jpg', name: 'lasagne.jpg', renamed: false });
    assert.equal((await upload('recipes/media/images', 'song.mp3', JPEG)).statusCode, 400);
    writeFileSync(join(pub, 'recipes', 'media', 'images', 'from-winscp.png'), 'x');
    const before = await b.get('/api/media/list?dir=recipes%2Fmedia%2Fimages');
    assert.deepEqual(before.json.files.map((f: { name: string }) => f.name), ['lasagne.jpg'], 'files come from media.db: not seen until a sync');
    const synced = await b.post('/api/media/sync');
    assert.deepEqual([synced.status, synced.json.found, synced.json.summary], [200, 1, '1 new']);

    const list = await b.get('/api/media/list?dir=recipes%2Fmedia%2Fimages');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.files.map((f: { name: string; addedBy: string | null; how: string | null }) => [f.name, f.addedBy, f.how]),
      [['from-winscp.png', null, null], ['lasagne.jpg', 'mediauser', 'uploaded']]);
    const info = await b.get('/api/media/info?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg');
    assert.deepEqual([info.json.dimensions, info.json.addedBy], [{ width: 64, height: 32 }, 'mediauser']);

    const file = await b.get('/api/media/file?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg');
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.match(String(file.headers['content-security-policy']), /sandbox/);
    assert.match(String(file.headers['content-disposition']), /^inline/);
    const raw = await app.inject({ method: 'GET', url: '/api/media/file?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg', remoteAddress: '127.0.0.1', headers: { cookie: b.cookie } });
    assert.deepEqual(raw.rawPayload, JPEG, 'the exact bytes');
    const part = await b.req('GET', '/api/media/file?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg', undefined, { range: 'bytes=2-5' });
    assert.deepEqual([part.status, part.headers['content-range'], part.headers['content-length']], [206, `bytes 2-5/${JPEG.length}`, '4']);
    const tail = await b.req('GET', '/api/media/file?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg', undefined, { range: 'bytes=-3' });
    assert.equal(tail.headers['content-range'], `bytes ${JPEG.length - 3}-${JPEG.length - 1}/${JPEG.length}`);
    const dl = await b.get('/api/media/file?path=recipes%2Fmedia%2Fimages%2Flasagne.jpg&download=1');
    assert.match(String(dl.headers['content-disposition']), /^attachment; filename\*=UTF-8''lasagne\.jpg$/);
    writeFileSync(join(pub, 'recipes', 'media', 'files', 'page.html'), '<script>alert(1)</script>');
    const html = await b.get('/api/media/file?path=recipes%2Fmedia%2Ffiles%2Fpage.html');
    assert.deepEqual([html.headers['content-type'], String(html.headers['content-disposition']).split(';')[0]], ['application/octet-stream', 'attachment'], 'never shown as a page');
    assert.equal((await b.get('/api/media/file?path=recipes%2Findex.html')).status, 400);
  });

  it('copies, moves and renames with who-added-it following along; trash and restore', async () => {
    assert.equal((await b.post('/api/media/folder', { folder: '' })).status, 200);
    assert.equal((await b.post('/api/media/mkdir', { dir: 'recipes/media/images', name: 'mains' })).status, 200);
    const copy = await b.post('/api/media/copy', { from: 'recipes/media/images/lasagne.jpg', to: 'media/images' });
    assert.deepEqual([copy.status, copy.json.path], [200, 'media/images/lasagne.jpg']);
    const move = await b.post('/api/media/move', { from: 'recipes/media/images/lasagne.jpg', to: 'recipes/media/images/mains' });
    assert.equal(move.json.path, 'recipes/media/images/mains/lasagne.jpg');
    assert.equal((await b.post('/api/media/move', { from: 'recipes/media/images/mains', to: 'recipes/media/images', name: 'main courses' })).status, 200);
    const inBucket = (await b.get('/api/media/list?dir=recipes%2Fmedia%2Fimages%2Fmain%20courses')).json.files[0];
    assert.deepEqual([inBucket.name, inBucket.addedBy], ['lasagne.jpg', 'mediauser'], 'the note followed the file, and its renamed bucket');
    assert.equal((await b.post('/api/media/move', { from: 'media/images/lasagne.jpg', to: 'media/video' })).status, 400);

    const t = await b.post('/api/media/trash', { path: 'recipes/media/images/main courses' });
    assert.equal(t.status, 200);
    assert.deepEqual((await b.get('/api/media/trash')).json.items.map((i: { path: string }) => i.path), ['recipes/media/images/main courses']);
    const r = await b.post('/api/media/restore', { id: t.json.id });
    assert.deepEqual([r.status, r.json.path], [200, 'recipes/media/images/main courses']);
    assert.equal((await b.get('/api/media/list?dir=recipes%2Fmedia%2Fimages%2Fmain%20courses')).json.files[0].addedBy, 'mediauser', 'and came back from the trash');

    assert.deepEqual((await acts()).map((x) => x.action).filter((x) => x.startsWith('media-')), ['media-folder-made', 'media-uploaded', 'media-synced', 'media-folder-made', 'media-bucket-made', 'media-copied', 'media-moved', 'media-renamed', 'media-trashed', 'media-restored']);
  });

  it('refuses uploads over 100 MB before reading them', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/media/upload?dir=media/video', remoteAddress: '127.0.0.1', payload: 'x',
      headers: { cookie: b.cookie, origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-pammy-name': 'big.mp4', 'content-length': String(101 * 1024 * 1024) } });
    assert.equal(r.statusCode, 413);
  });

  it('photos/ becomes images/ (pammy-panel media-images)', async () => {
    mkdirSync(join(pub, 'recipes', 'media', 'photos', 'old'), { recursive: true });
    writeFileSync(join(pub, 'recipes', 'media', 'photos', 'old', 'pie.jpg'), JPEG);
    writeFileSync(join(pub, 'recipes', 'media', 'photos', 'lasagne.jpg'), JPEG);      // taken in images/: stays
    writeFileSync(join(pub, 'recipes', 'media', 'images', 'lasagne.jpg'), JPEG);
    const r = await renamePhotos(db, join(dir, 'sitefs.sock'), clock);
    assert.deepEqual([r.renamed, r.merged, r.left], [[], ['recipes/media'], ['recipes/media/photos/lasagne.jpg']]);
    // media.db took its notes when it was made; files renamed since are found by a sync
    const synced = await b.post('/api/media/sync');
    assert.deepEqual(synced.json.strays, ['recipes/media/photos'], 'what stayed in photos/ is out of place');
    const pie = (await b.get('/api/media/list?dir=recipes%2Fmedia%2Fimages%2Fold')).json.files[0];
    assert.deepEqual([pie.name, pie.addedBy], ['pie.jpg', null]);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'media-photos-renamed' AND target = 'recipes'"));
    rmSync(join(pub, 'recipes', 'media', 'photos'), { recursive: true });
  });

  describe('the media records, and the sync (media-plan D14-D17)', () => {
    const rec = (path: string) => one<{ id: number; state: string; how: string; added_by: string | null; hash: string | null; scope: string; state_at: number }>(db,
      "SELECT * FROM records WHERE path = ? ORDER BY (state = 'present') DESC, id DESC", path);
    const tagOn = async (id: number, scope: string, name: string) => {
      const { labelIn } = await import('@panel/catalog/labels');
      await run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', id, await labelIn(db, 'tag', scope, name, clock, null, []));
    };
    const tagsOf = async (id: number) => (await all<{ scope: string; name: string }>(db,
      "SELECT s.path AS scope, t.name FROM links x JOIN labels t ON t.id = x.label_id JOIN scopes s ON s.id = t.scope_id WHERE x.item_id = ? AND t.kind = 'tag' ORDER BY t.name", id))
      .map((t) => `${t.scope === '/' ? '' : t.scope}/t/${t.name}`);
    const sync = async () => {
      const r = await b.post('/api/media/sync');
      assert.equal(r.status, 200, r.body);
      await media.hashing;      // the background hashes, as the next 15-minute sync would have them
      return r.json;
    };
    const garden = (...p: string[]) => join(pub, 'garden', 'media', ...p);

    before(async () => {
      mkdirSync(join(pub, 'garden'));
      assert.equal((await b.post('/api/media/folder', { folder: 'garden' })).status, 200);
      await sync();       // everything from the tests above is known
    });

    it('an upload is recorded at once, with its hash; one made outside the panel only after a sync', async () => {
      assert.equal((await upload('garden/media/images', 'rose.jpg', JPEG)).statusCode, 200);
      const r = (await rec('garden/media/images/rose.jpg'))!;
      assert.deepEqual([r.state, r.how, r.added_by, r.scope, r.hash], ['present', 'uploaded', 'mediauser', '/garden', createHash('sha256').update(JPEG).digest('hex')]);
      writeFileSync(garden('images', 'tulip.png'), 'tulip bytes');
      assert.equal((await rec('garden/media/images/tulip.png')), undefined);
      const s = await sync();
      assert.deepEqual([s.found, s.moved, s.missing, s.summary], [1, 0, 0, '1 new']);
      assert.deepEqual([(await rec('garden/media/images/tulip.png'))!.how, (await rec('garden/media/images/tulip.png'))!.added_by], ['found', null]);
      assert.ok((await rec('garden/media/images/tulip.png'))!.hash, 'hashed after the sync (in the background)');
      assert.equal((await sync()).summary, 'no changes');
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'media-synced' AND actor_label = 'mediauser' AND detail = '1 new'"));
    });

    it('a file moved or renamed outside the panel keeps its record, id and tags, even into another media folder', async () => {
      const tulip = (await rec('garden/media/images/tulip.png'))!;
      await tagOn(tulip.id, '/garden', 'spring');
      mkdirSync(garden('images', 'beds'));
      renameSync(garden('images', 'tulip.png'), garden('images', 'beds', 'tulip-red.png'));
      let s = await sync();
      assert.deepEqual([s.moved, s.found, s.missing], [1, 0, 0]);
      assert.equal((await rec('garden/media/images/beds/tulip-red.png'))!.id, tulip.id);
      assert.deepEqual((await tagsOf(tulip.id)), ['/garden/t/spring']);
      // into the main site's media folder: the tag goes by name, made there (D8)
      renameSync(garden('images', 'beds', 'tulip-red.png'), join(pub, 'media', 'images', 'tulip-red.png'));
      s = await sync();
      assert.equal(s.moved, 1);
      assert.deepEqual([(await rec('media/images/tulip-red.png'))!.id, (await rec('media/images/tulip-red.png'))!.scope], [tulip.id, '/']);
      assert.deepEqual((await tagsOf(tulip.id)), ['/t/spring']);
    });

    it('a file gone is kept as missing, comes back as the same record, and is forgotten after 30 days', async () => {
      const rose = (await rec('garden/media/images/rose.jpg'))!;
      renameSync(garden('images', 'rose.jpg'), join(dir, 'rose-away.jpg'));
      assert.equal((await sync()).missing, 1);
      assert.equal((await rec('garden/media/images/rose.jpg'))!.state, 'missing');
      assert.deepEqual((await b.get('/api/media/list?dir=garden%2Fmedia%2Fimages')).json.files.map((f: { name: string }) => f.name), []);
      renameSync(join(dir, 'rose-away.jpg'), garden('images', 'rose.jpg'));
      assert.equal((await sync()).back, 1);
      assert.deepEqual([(await rec('garden/media/images/rose.jpg'))!.id, (await rec('garden/media/images/rose.jpg'))!.state, (await rec('garden/media/images/rose.jpg'))!.how], [rose.id, 'present', 'uploaded']);
      rmSync(garden('images', 'rose.jpg'));
      await sync();
      advance(29 * 86400);
      assert.equal((await b.login()).status, 200);       // a month on: signed out long ago
      assert.equal((await sync()).purged, 0);
      advance(86400 + 1);
      assert.equal((await b.login()).status, 200);
      assert.ok((await sync()).purged >= 1);
      assert.equal((await rec('garden/media/images/rose.jpg')), undefined);
    });

    it('moves, copies, trash and restore through the panel keep records and tags; another scope gets them by name', async () => {
      assert.equal((await upload('garden/media/images', 'lily.jpg', JPEG)).statusCode, 200);
      const lily = (await rec('garden/media/images/lily.jpg'))!;
      await tagOn(lily.id, '/garden', 'white');
      const mv = await b.post('/api/media/move', { from: 'garden/media/images/lily.jpg', to: 'recipes/media/images', name: 'lily-2.jpg' });
      assert.equal(mv.status, 200, mv.body);
      assert.deepEqual(mv.json.created, { tags: ['/recipes/t/white'], categories: [] });
      assert.deepEqual([(await rec('recipes/media/images/lily-2.jpg'))!.id, (await tagsOf(lily.id))], [lily.id, ['/recipes/t/white']]);
      assert.match((await one(db, "SELECT detail FROM activity WHERE action = 'media-moved' ORDER BY id DESC") as { detail: string }).detail, /made \/recipes\/t\/white/);
      const cp = await b.post('/api/media/copy', { from: 'recipes/media/images/lily-2.jpg', to: 'garden/media/images' });
      const copy = (await rec(cp.json.path))!;
      assert.notEqual(copy.id, lily.id);
      assert.deepEqual([copy.how, copy.added_by, copy.hash, (await tagsOf(copy.id))], ['copied', 'mediauser', lily.hash, ['/garden/t/white']]);
      const t = await b.post('/api/media/trash', { path: 'recipes/media/images/lily-2.jpg' });
      assert.equal((await rec('recipes/media/images/lily-2.jpg'))!.state, 'trashed');
      assert.equal((await sync()).missing, 0, 'in the trash is not missing');
      const back = await b.post('/api/media/restore', { id: t.json.id, as: 'lily-back.jpg' });
      assert.equal(back.json.path, 'recipes/media/images/lily-back.jpg');
      assert.deepEqual([(await rec('recipes/media/images/lily-back.jpg'))!.id, (await rec('recipes/media/images/lily-back.jpg'))!.state, (await tagsOf(lily.id))], [lily.id, 'present', ['/recipes/t/white']]);
      const info = await b.get('/api/media/info?path=recipes%2Fmedia%2Fimages%2Flily-back.jpg');
      assert.deepEqual([info.json.id, info.json.addedBy, info.json.how], [lily.id, 'mediauser', 'uploaded']);
    });

    it('a bucket moved through the panel takes every record inside it along', async () => {
      assert.equal((await b.post('/api/media/mkdir', { dir: 'garden/media/images', name: 'pots' })).status, 200);
      assert.equal((await upload('garden/media/images/pots', 'fern.jpg', JPEG)).statusCode, 200);
      const fern = (await rec('garden/media/images/pots/fern.jpg'))!;
      assert.equal((await b.post('/api/media/move', { from: 'garden/media/images/pots', to: 'garden/media/images', name: 'planters' })).status, 200);
      assert.equal((await rec('garden/media/images/planters/fern.jpg'))!.id, fern.id);
      assert.equal((await sync()).summary, 'no changes');
    });

    it('a file deleted outside the panel is marked missing as soon as someone opens it', async () => {
      assert.equal((await upload('garden/media/files', 'plan.pdf', JPEG)).statusCode, 200);
      rmSync(garden('files', 'plan.pdf'));
      assert.equal((await b.get('/api/media/info?path=garden%2Fmedia%2Ffiles%2Fplan.pdf')).status, 404);
      assert.equal((await rec('garden/media/files/plan.pdf'))!.state, 'missing');
    });

    it('opening Media syncs when the last sync is over 5 minutes old, and says what is out of place', async () => {
      writeFileSync(garden('stray.txt'), 'x');
      writeFileSync(garden('images', 'later.jpg'), 'later');
      const quick = await b.get('/api/media');
      assert.equal((await rec('garden/media/images/later.jpg')), undefined, 'the last sync was just now');
      assert.deepEqual(quick.json.sync.strays, []);
      advance(5 * 60);
      const opened = await b.get('/api/media');
      assert.equal((await rec('garden/media/images/later.jpg'))!.how, 'found');
      assert.deepEqual([opened.json.sync.at, opened.json.sync.strays, opened.json.sync.truncated], [clock, ['garden/media/stray.txt'], false]);
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'media-synced' AND actor_label = 'automatic check'"));
      rmSync(garden('stray.txt'));
    });

    it('something trashed before media.db existed comes back with who added it (from the old notes)', async () => {
      const id = '20260917T120000Z-0badc0de';
      mkdirSync(join(dir, 'trash-media', '.media', id), { recursive: true });
      writeFileSync(join(dir, 'trash-media', '.media', id, 'old.jpg'), 'old picture');
      writeFileSync(join(dir, 'trash-media', '.media', id, 'origin.json'), JSON.stringify({ path: 'garden/media/photos/old.jpg', name: 'old.jpg', isDir: false, trashedAt: clock - 3600 }));
      await run(db, "INSERT INTO imported_notes (path, added_by, added_at, how) VALUES (?, 'pamela', 12345, 'uploaded')", `trash:${id}/old.jpg`);
      const r = await b.post('/api/media/restore', { id });
      assert.deepEqual([r.status, r.json.path], [200, 'garden/media/images/old.jpg']);
      const old = (await rec('garden/media/images/old.jpg'))!;
      assert.deepEqual([old.state, old.how, old.added_by], ['present', 'uploaded', 'pamela']);
      assert.equal(await one(db, "SELECT 1 FROM imported_notes WHERE path LIKE '%old.jpg'"), undefined, 'used once');
    });

    it('a folder trashed on the Subdomains tab takes its media records with it, and brings them back', async () => {
      writeFileSync(join(pub, 'garden', 'index.html'), 'garden');
      const later = (await rec('garden/media/images/later.jpg'))!;
      await tagOn(later.id, '/garden', 'evening');
      assert.equal((await b.login()).status, 200);       // trashing a folder needs a recent passkey check
      const t = await b.post('/api/sites/trash', { name: 'garden' });
      assert.equal(t.status, 200, t.body);
      await sync();
      assert.equal((await rec('garden/media/images/later.jpg'))!.state, 'missing');
      const back = await b.post('/api/sites/restore', { entry: t.json.entry, as: 'gardens' });
      assert.equal(back.status, 200, back.body);
      await sync();
      const moved = (await rec('gardens/media/images/later.jpg'))!;
      assert.deepEqual([moved.id, moved.scope, (await tagsOf(later.id))], [later.id, '/gardens', ['/gardens/t/evening']], 'another name is another scope (D8, and D9 to come)');
    });
  });

  describe('thumbnails (media-plan D18)', () => {
    let thumbsServer: ReturnType<typeof createThumbsServer>;
    let PNG: Buffer;
    const listed = async (dirPath: string, name: string) =>
      ((await b.get(`/api/media/list?dir=${encodeURIComponent(dirPath)}`)).json.files as { name: string; id: number; thumb: any }[]).find((f) => f.name === name)!;
    before(async () => {
      PNG = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#2e86c1' } }).png().toBuffer();
      mkdirSync(join(pub, 'pics'));
      assert.equal((await b.post('/api/media/folder', { folder: 'pics' })).status, 200);
    });
    after(() => new Promise<void>((r) => (thumbsServer ? thumbsServer.close(() => r()) : r())));

    it('waits while the thumbnail service is away, and catches up when it is back', async () => {
      assert.equal((await upload('pics/media/images', 'sky.png', PNG)).statusCode, 200);
      await thumbs.running;
      assert.equal((await listed('pics/media/images', 'sky.png')).thumb, null, 'not made yet');
      thumbsServer = createThumbsServer({ publicDir: pub, tools: DEFAULT_TOOLS });
      await new Promise<void>((r) => thumbsServer.listen(join(dir, 'thumbs.sock'), r));
      assert.ok(await thumbs.kick() >= 1);
      const sky = await listed('pics/media/images', 'sky.png');
      assert.deepEqual([sky.thumb.icon, sky.thumb.width, sky.thumb.height], ['image', 320, 160]);
      assert.match(sky.thumb.src, new RegExp(`^/api/media/thumb/${sky.id}\\?v=[0-9a-f]{12}$`));
    });

    it('serves it only when signed in, cached for good under an address that changes with the content', async () => {
      const sky = await listed('pics/media/images', 'sky.png');
      const r = await b.get(sky.thumb.src);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/webp');
      assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
      assert.match(String(r.headers['content-security-policy']), /sandbox/);
      const raw = await app.inject({ method: 'GET', url: sky.thumb.src, remoteAddress: '127.0.0.1', headers: { cookie: b.cookie } });
      const meta = await sharp(raw.rawPayload).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 320, 160]);
      assert.equal((await new Browser('203.0.113.101').get(sky.thumb.src)).status, 401);
      assert.equal((await b.get('/api/media/thumb/999999')).status, 404);
      const info = await b.get('/api/media/info?path=pics%2Fmedia%2Fimages%2Fsky.png');
      assert.equal(info.json.thumb.src, sky.thumb.src);
    });

    it('an upload gets one straight away; renaming keeps it; new content gets a new one and the old goes', async () => {
      assert.equal((await upload('pics/media/images', 'sea.png', PNG)).statusCode, 200);
      await thumbs.running;
      const sea = await listed('pics/media/images', 'sea.png');
      assert.ok(sea.thumb.src);
      assert.equal((await b.post('/api/media/move', { from: 'pics/media/images/sea.png', to: 'pics/media/images', name: 'ocean.png' })).status, 200);
      assert.equal((await listed('pics/media/images', 'ocean.png')).thumb.src, sea.thumb.src, 'same record, same thumbnail');
      const oldFile = readdirSync(join(dir, 'thumbs')).find((n) => n.startsWith(`${sea.id}-`))!;
      writeFileSync(join(pub, 'pics', 'media', 'images', 'ocean.png'), await sharp({ create: { width: 100, height: 300, channels: 3, background: '#000' } }).png().toBuffer());
      utimesSync(join(pub, 'pics', 'media', 'images', 'ocean.png'), clock + 5, clock + 5);
      await b.post('/api/media/sync');
      await media.hashing;
      await thumbs.running;
      const ocean = await listed('pics/media/images', 'ocean.png');
      assert.notEqual(ocean.thumb.src, sea.thumb.src);
      assert.deepEqual([ocean.thumb.width, ocean.thumb.height], [100, 300], 'small enough already: never enlarged');
      assert.ok(!existsSync(join(dir, 'thumbs', oldFile)), 'the old picture is gone');
    });

    it('files that are not pictures get their icon without asking the service; broken ones too, and say so', async () => {
      assert.equal((await upload('pics/media/files', 'budget.xlsx', PNG)).statusCode, 200);
      assert.equal((await upload('pics/media/images', 'broken.png', Buffer.from('nope'))).statusCode, 200);
      await thumbs.running;
      assert.deepEqual((await listed('pics/media/files', 'budget.xlsx')).thumb, { src: null, icon: 'spreadsheet' });
      assert.deepEqual((await listed('pics/media/images', 'broken.png')).thumb, { src: null, icon: 'image' });
      const why = (await one<{ why: string }>(db, "SELECT t.why FROM thumbs t JOIN records m ON m.id = t.item_id WHERE m.name = 'broken.png'"))!;
      assert.match(why.why, /not a picture/);
    });

    it('housekeeping removes pictures whose files are gone for good', async () => {
      writeFileSync(join(dir, 'thumbs', `424242-${'a'.repeat(64)}.webp`), 'stray');
      writeFileSync(join(dir, 'thumbs', 'keep-me.txt'), 'not ours');
      const sky = await listed('pics/media/images', 'sky.png');
      await run(db, 'DELETE FROM items WHERE id = ?', sky.id);
      assert.equal(await thumbs.clean(), 2);
      assert.ok(existsSync(join(dir, 'thumbs', 'keep-me.txt')));
      assert.ok(readdirSync(join(dir, 'thumbs')).some((n) => /^\d+-[0-9a-f]{64}\.webp$/.test(n)), 'the others stay');
    });
  });

  describe('the Media page: list, tags and categories (media-plan D6-D13, D20-D21)', () => {
    const put = (rel: string, data: string | Buffer = rel) => { mkdirSync(join(pub, rel, '..'), { recursive: true }); writeFileSync(join(pub, rel), data); };
    const items = async (query: string) => {
      const r = await b.get(`/api/media/items?${query}`);
      assert.equal(r.status, 200, r.body);
      return r.json as { mode: string; folders: { name: string; items: number }[]; items: { id: number; name: string; folder: string; site: string; kind: string; tags: string[]; categories: string[]; size: number }[]; total: number };
    };
    const idOf = async (scope: string, name: string) => (await items(`scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(name)}`)).items.find((i) => i.name === name)!.id;

    before(async () => {
      mkdirSync(join(pub, 'shop'));
      assert.equal((await b.post('/api/media/folder', { folder: 'shop' })).status, 200);
      put('shop/media/images/red-hat.jpg', 'x'.repeat(30));
      put('shop/media/images/blue-hat.jpg', 'x'.repeat(10));
      put('shop/media/images/2026/summer/sun-hat.jpg', 'x'.repeat(20));
      put('shop/media/files/price-list.pdf', 'x');
      for (let i = 0; i < 105; i++) put(`shop/media/files/many/receipt-${String(i).padStart(3, '0')}.pdf`, 'r');
      put('media/images/hat-logo.png', 'logo');
      assert.equal((await b.post('/api/media/sync')).status, 200);
    });

    it('browses one folder: its subfolders and the files directly in it', async () => {
      const r = await items('scope=%2Fshop&kind=images');
      assert.equal(r.mode, 'browse');
      assert.deepEqual(r.folders, [{ name: '2026', items: 1 }]);
      assert.deepEqual(r.items.map((i) => i.name), ['blue-hat.jpg', 'red-hat.jpg']);
      const inner = await items('scope=%2Fshop&kind=images&in=2026%2Fsummer');
      assert.deepEqual([inner.items.map((i) => i.name), inner.items[0]!.folder, inner.items[0]!.site], [['sun-hat.jpg'], '2026/summer', 'shop']);
      assert.equal((await b.get('/api/media/items?scope=%2Fshop&kind=images&in=nope')).status, 404);
      assert.equal((await b.get('/api/media/items?scope=..%2Fetc&kind=images')).status, 404);
      assert.equal((await new Browser('203.0.113.102').get('/api/media/items')).status, 401);
    });

    it('everything that matches, from every folder inside and every media folder, sorted and 100 at a time', async () => {
      const hats = await items('q=HAT');
      assert.deepEqual(hats.items.map((i) => `${i.site || '/'}:${i.name}`), ['shop:blue-hat.jpg', '/:hat-logo.png', 'shop:red-hat.jpg', 'shop:sun-hat.jpg']);
      assert.equal(hats.mode, 'all');
      const bySize = await items('scope=%2Fshop&kind=images&q=hat&sort=size&order=desc');
      assert.deepEqual(bySize.items.map((i) => i.size), [30, 20, 10]);
      const shopAll = await items('scope=%2Fshop');
      assert.equal(shopAll.total, 109);
      assert.equal(shopAll.items.length, 100);
      const page2 = await items('scope=%2Fshop&offset=100');
      assert.equal(page2.items.length, 9);
      assert.ok(!page2.items.some((i) => shopAll.items.some((j) => j.id === i.id)), 'no repeats between pages');
      assert.equal((await items('scope=%2Fshop&kind=files&in=many&q=receipt-10')).total, 5, 'a search inside a folder looks everywhere under it');
    });

    it('tags and categories: made, set on files, counted, filtered by, renamed and deleted', async () => {
      const red = await idOf('/shop', 'red-hat.jpg');
      const blue = await idOf('/shop', 'blue-hat.jpg');
      const made = await b.post('/api/media/labels', { scope: '/shop', type: 'tag', name: 'hats' });
      assert.deepEqual([made.status, made.json.label.address], [200, '/shop/t/hats']);
      assert.equal((await b.post('/api/media/labels', { scope: '/shop', type: 'tag', name: 'hats' })).status, 409);
      assert.match((await b.post('/api/media/labels', { scope: '/shop', type: 'tag', name: 'Summer Hats' })).json.message, /Lowercase letters/);
      assert.equal((await b.post('/api/media/labels', { scope: '/nowhere', type: 'tag', name: 'x' })).status, 404);
      assert.equal((await b.post('/api/media/labels', { scope: '/shop', type: 'colour', name: 'x' })).status, 404);

      const set = await b.post('/api/media/items/labels', { ids: [red], set: { tags: ['hats', 'red'], categories: ['for-sale'] } });
      assert.deepEqual([set.status, set.json.changed, set.json.created], [200, 1, ['/shop/t/red', '/shop/c/for-sale']]);
      assert.equal((await b.post('/api/media/items/labels', { ids: [blue], add: { tags: ['hats'] } })).json.changed, 1);
      const labels = (await b.get('/api/media/labels?scope=%2Fshop')).json.labels as { id: number; type: string; name: string; count: number; address: string }[];
      assert.deepEqual(labels.map((l) => `${l.address}:${l.count}`), ['/shop/t/hats:2', '/shop/t/red:1', '/shop/c/for-sale:1']);
      const hats = labels.find((l) => l.name === 'hats')!;
      assert.deepEqual((await items(`scope=%2Fshop&tag=${hats.id}`)).items.map((i) => i.name), ['blue-hat.jpg', 'red-hat.jpg']);
      const forSale = labels.find((l) => l.name === 'for-sale')!;
      assert.deepEqual((await items(`category=${forSale.id}`)).items.map((i) => [i.name, i.tags, i.categories]), [['red-hat.jpg', ['hats', 'red'], ['for-sale']]]);
      const redTag = labels.find((l) => l.name === 'red')!;
      assert.deepEqual((await items(`scope=%2Fshop&tag=${hats.id}&tag=${redTag.id}`)).items.map((i) => i.name), ['red-hat.jpg'], 'every chosen tag at once');
      assert.deepEqual((await items(`scope=%2Fshop&tag=${hats.id}&category=${forSale.id}`)).items.map((i) => i.name), ['red-hat.jpg']);

      const ren = await b.post(`/api/media/labels/tag/${hats.id}`, { name: 'headwear' });
      assert.equal(ren.json.label.address, '/shop/t/headwear');
      assert.deepEqual((await items(`scope=%2Fshop&kind=images`)).items.map((i) => i.tags), [['headwear'], ['headwear', 'red']], 'files keep it under its new name');
      const red2 = labels.find((l) => l.name === 'red')!;
      assert.equal((await b.post(`/api/media/labels/tag/${red2.id}`, { name: 'headwear' })).status, 409);
      const del = await b.post(`/api/media/labels/tag/${hats.id}`, { delete: true });
      assert.deepEqual([del.status, del.json.removedFrom], [200, 2]);
      assert.deepEqual((await items(`scope=%2Fshop&kind=images`)).items.map((i) => i.tags), [[], ['red']]);
      assert.equal((await b.post(`/api/media/labels/tag/${hats.id}`, { delete: true })).status, 404);
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'media-tag-deleted' AND target = '/shop/t/headwear' AND detail = 'taken off 2 files'"));
    });

    it('many files at once, across media folders: each gets the label in its own scope', async () => {
      const ids = [await idOf('/shop', 'sun-hat.jpg'), await idOf('/', 'hat-logo.png')];
      const r = await b.post('/api/media/items/labels', { ids, add: { tags: ['summer'] } });
      assert.deepEqual([r.json.changed, r.json.created.sort()], [2, ['/shop/t/summer', '/t/summer']]);
      assert.deepEqual((await items('q=hat')).items.filter((i) => i.tags.includes('summer')).map((i) => i.name), ['hat-logo.png', 'sun-hat.jpg']);
      assert.equal((await b.post('/api/media/items/labels', { ids, remove: { tags: ['summer'] } })).json.changed, 2);
      assert.equal((await b.post('/api/media/items/labels', { ids, remove: { tags: ['summer'] } })).json.changed, 0, 'nothing left to remove');
      assert.equal((await b.post('/api/media/items/labels', { ids: [999999], add: { tags: ['x'] } })).status, 404);
      assert.equal((await b.post('/api/media/items/labels', { ids: [], add: { tags: ['x'] } })).status, 400);
      assert.equal((await b.post('/api/media/items/labels', { ids, add: { tags: ['Not OK'] } })).status, 400);
      assert.deepEqual((await b.get('/api/media/labels?scope=%2F')).json.labels.filter((l: { name: string }) => l.name === 'summer')
        .map((l: { address: string; count: number }) => `${l.address}:${l.count}`), ['/t/summer:0'], 'still there, on nothing');
    });

    it('a nested folder can be a tag scope, and File Explorer lists the whole site', async () => {
      mkdirSync(join(pub, 'shop', 'lookbook'), { recursive: true });
      writeFileSync(join(pub, 'shop', 'lookbook', 'cover.jpg'), Buffer.concat([JPEG, Buffer.from('lookbook')]));
      writeFileSync(join(pub, 'shop', 'about.html'), '<p>Hats</p>');
      const synced = await b.post('/api/media/sync');
      assert.ok(synced.json.found >= 2, synced.json.summary);
      const tree = await b.get('/api/files');
      assert.equal(tree.status, 200);
      assert.ok(tree.json.dirs.includes('shop/lookbook'));
      assert.ok(tree.json.dirs.includes('shop/media'));
      const listed = await b.get('/api/files/items?dir=shop');
      assert.equal(listed.status, 200);
      assert.ok(listed.json.items.some((i: { name: string }) => i.name === 'about.html'));
      assert.ok(listed.json.folders.some((f: { name: string }) => f.name === 'lookbook' || f.name === 'media'));
      const page = await b.get('/api/files/file?path=shop%2Fabout.html');
      assert.equal(page.status, 200);
      // a site's program file is listed, and only an admin may download it (docs/lfdln-mariadb-plan.md
      // finding 1): mediauser isn't one
      writeFileSync(join(pub, 'shop', 'cart.php'), '<?php echo 1;');
      await b.post('/api/media/sync');
      assert.ok((await b.get('/api/files/items?dir=shop')).json.items.some((i: { name: string }) => i.name === 'cart.php'), 'cart.php listed');
      const php = await b.get('/api/files/file?path=shop%2Fcart.php');
      assert.deepEqual([php.status, php.json?.message], [403, 'Only admins can download program files (.php and the like).']);
      rmSync(join(pub, 'shop', 'cart.php'));
      const made = await b.post('/api/media/scopes', { path: 'shop/lookbook' });
      assert.deepEqual([made.status, made.json.scope.path], [200, '/shop/lookbook']);
      assert.equal((await b.post('/api/media/scopes', { path: 'shop/lookbook' })).status, 409);
      const tag = await b.post('/api/media/labels', { scope: '/shop/lookbook', type: 'tag', name: 'looks' });
      assert.equal(tag.json.label.address, '/shop/lookbook/t/looks');
      const cover = (await b.get('/api/files/items?dir=shop%2Flookbook')).json.items.find((i: { name: string }) => i.name === 'cover.jpg');
      assert.ok(cover);
      const set = await b.post('/api/media/items/labels', { ids: [cover.id], add: { tags: ['looks'] } });
      assert.equal(set.status, 200);
      assert.equal((await b.post('/api/media/scopes/delete', { path: '/shop/lookbook' })).status, 400, 'still has a tag');
      await b.post(`/api/media/labels/tag/${tag.json.label.id}`, { delete: true });
      assert.equal((await b.post('/api/media/scopes/delete', { path: '/shop/lookbook' })).status, 200);
    });

    it('a title and "what it shows" per file, for the media API', async () => {
      const red = await idOf('/shop', 'red-hat.jpg');
      const r = await b.post(`/api/media/items/${red}/details`, { title: '  Red   hat ', alt: 'A red hat\non a chair' });
      assert.deepEqual([r.status, r.json.title, r.json.alt], [200, 'Red hat', 'A red hat on a chair']);
      const it = (await items('scope=%2Fshop&q=red-hat')).items[0] as unknown as { title: string; alt: string };
      assert.deepEqual([it.title, it.alt], ['Red hat', 'A red hat on a chair']);
      assert.equal((await b.post(`/api/media/items/${red}/details`, { title: '' })).json.title, null);
      await b.post(`/api/media/items/${red}/details`, { title: 'Red hat' });
      assert.equal((await b.post('/api/media/items/999999/details', { title: 'x' })).status, 404);
    });

    it('"Anyone can list its files": switching on asks for a passkey; off does not', async () => {
      const red = ((await b.get('/api/media/labels?scope=%2Fshop')).json.labels as { id: number; name: string; type: string; public: boolean }[]).find((l) => l.name === 'red')!;
      assert.equal(red.public, false);
      advance(11 * 60);
      const stale = await b.post(`/api/media/labels/tag/${red.id}`, { public: true });
      assert.deepEqual([stale.status, stale.json.error], [403, 'reauth-required']);
      assert.equal((await b.login()).status, 200);
      const on = await b.post(`/api/media/labels/tag/${red.id}`, { public: true });
      assert.deepEqual([on.status, on.json.label.public], [200, true]);
      advance(11 * 60);
      const off = await b.post(`/api/media/labels/tag/${red.id}`, { public: false });
      assert.deepEqual([off.status, off.json.label.public], [200, false]);
      assert.equal((await b.login()).status, 200);
      await b.post(`/api/media/labels/tag/${red.id}`, { public: true });
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'media-label-public' AND target = '/shop/t/red'"));
    });

    it('the published index: what the gate may know, rewritten after changes', async () => {
      // the routes kick the publisher; this waits for that rewrite (and any still
      // running, which it queues behind) instead of guessing how long it takes
      await new Promise((r) => setTimeout(r, 30));
      await publisher.publishNow();
      const { DatabaseSync } = await import('node:sqlite');
      const idx = new DatabaseSync(join(dir, 'media-public', 'index.db'), { readOnly: true });
      const red = idx.prepare("SELECT * FROM files WHERE path = 'shop/media/images/red-hat.jpg'").get() as { title: string; alt: string };
      assert.deepEqual([red.title, red.alt], ['Red hat', 'A red hat on a chair']);
      assert.deepEqual(idx.prepare("SELECT type, name, public FROM labels WHERE scope = '/shop' AND name IN ('red', 'for-sale') ORDER BY name").all().map((r) => ({ ...r })),
        [{ type: 'category', name: 'for-sale', public: 0 }, { type: 'tag', name: 'red', public: 1 }]);
      assert.equal((idx.prepare("SELECT count(*) AS n FROM files WHERE path LIKE 'shop/%'").get() as { n: number }).n, 109);
      idx.close();
      assert.equal(statSync(join(dir, 'media-public', 'index.db')).mode & 0o777, 0o640);
    });

    it('media examples: the four, and "Put this on my website" writes a page pointed at her tag', async () => {
      assert.deepEqual((await b.get('/api/media/examples')).json.examples.map((e: { kind: string }) => e.kind), ['gallery', 'slideshow', 'documents', 'music']);
      const code = (await b.get('/api/media/examples/music')).json;
      assert.deepEqual(code.files.map((f: { path: string }) => f.path), ['music.html', 'music-files/style.css', 'music-files/music.js']);
      assert.match(code.files[0].content, /data-api="\/_pammy\/api\/media\/example\/c\/music\?kind=audio"/);
      assert.equal((await b.get('/api/media/examples/nope')).status, 404);
      const put = await b.post('/api/media/examples/gallery/install', { folder: 'shop', page: 'hats.html', tags: ['red'], categories: ['for-sale'], title: 'My <hats>' });
      assert.equal(put.status, 200, put.body);
      assert.deepEqual([put.json.created, put.json.address, put.json.subdomainAddress], [['hats.html', 'hats-files/style.css', 'hats-files/gallery.js'], 'https://pammy.org/shop/hats.html', 'https://shop.pammy.org/hats.html']);
      assert.deepEqual(put.json.toSwitch.map((l: { address: string }) => l.address), ['/shop/c/for-sale'], 'red is on already');
      const html = readFileSync(join(pub, 'shop', 'hats.html'), 'utf8');
      assert.match(html, /data-api="\/_pammy\/api\/media\/in\/shop\/t\/red\/c\/for-sale\?kind=images"/);
      assert.match(html, /<h1>My &lt;hats&gt;<\/h1>/);
      assert.match(html, /href="hats-files\/style.css"/);
      assert.equal((await b.post('/api/media/examples/gallery/install', { folder: 'shop', page: 'hats.html', tags: ['red'] })).status, 409, 'never over a page that is there');
      assert.match((await b.post('/api/media/examples/gallery/install', { folder: 'shop', page: 'x.html', tags: [] })).json.message, /Choose a tag or a category/);
      assert.match((await b.post('/api/media/examples/gallery/install', { folder: 'shop', page: 'x.html', tags: ['nope'] })).json.message, /no tag called "nope"/);
      assert.equal((await b.post('/api/media/examples/gallery/install', { folder: 'nowhere', page: 'x.html', tags: ['red'] })).status, 404);
      assert.equal((await b.post('/api/media/examples/gallery/install', { folder: 'shop', page: '../x.html', tags: ['red'] })).status, 400);
    });

    it('a file\'s details include its labels', async () => {
      const red = await idOf('/shop', 'red-hat.jpg');
      const info = await b.get('/api/media/info?path=shop%2Fmedia%2Fimages%2Fred-hat.jpg');
      assert.deepEqual([info.json.id, info.json.scope, info.json.tags, info.json.categories], [red, '/shop', ['red'], ['for-sale']]);
    });
  });
});

describe('an account that only sees one folder (media-plan D22-D25)', () => {
  const boss = new Browser('203.0.113.110');
  const bad = new Browser('203.0.113.111');
  let helper: ReturnType<typeof createSiteFsServer>;
  let gateAdmin: ReturnType<typeof createGateAdminServer>;
  let gate: GateLive;
  let pub = '';
  let badId = 0;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
  const upload = (who: Browser, dir: string, name: string) => app.inject({
    method: 'POST', url: `/api/media/upload?dir=${encodeURIComponent(dir)}`, remoteAddress: '127.0.0.1', payload: JPEG,
    headers: { cookie: who.cookie, origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-pammy-name': encodeURIComponent(name), 'x-real-ip': who.ip },
  });
  const idOf = async (path: string) => (await one<{ id: number }>(db, "SELECT id FROM records WHERE path = ? AND state = 'present'", path))!.id;

  before(async () => {
    pub = join(dir, 'public-limited');
    for (const f of ['olivia', 'recipes']) mkdirSync(join(pub, f), { recursive: true });
    writeFileSync(join(pub, 'olivia', 'contact.html'), 'hers');
    helper = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-limited'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    mkdirSync(join(dir, 'trash-limited'));
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    gate = await newGate(await gatePg(), () => clock);
    gateAdmin = createGateAdminServer(gate, () => clock);
    await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
    const m = await createUser(db, clock, COMMAND_LINE, 'bossy', 'Bossy', 'manager');
    assert.equal((await boss.useInvite((await createInvite(db, clock, COMMAND_LINE, m)).token)).status, 200);
    const u = await createUser(db, clock, COMMAND_LINE, 'badmon', 'Badmon', 'member', MEMBER);
    badId = u.id;
    assert.equal((await bad.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    for (const f of ['olivia', 'recipes']) assert.equal((await boss.post('/api/media/folder', { folder: f })).status, 200);
    assert.equal((await upload(boss, 'recipes/media/images', 'secret-recipe.jpg')).statusCode, 200);
    assert.equal((await upload(boss, 'olivia/media/images', 'party.jpg')).statusCode, 200);
  });
  after(async () => {
    await new Promise<void>((r) => helper.close(() => r()));
    await new Promise<void>((r) => gateAdmin.close(() => r()));
    await gate.db.end({ timeout: 2 });
  });

  it('only an account manager sets what it can use, with a passkey check, to folders that are there; it works on the next request (R6)', async () => {
    const olivia = { rights: ['files', 'media', 'forms', 'responses', 'comments'], places: ['/olivia'] };
    assert.equal((await bad.post(`/api/users/${badId}/access`, olivia)).status, 404, 'not there for anyone else (R4)');
    assert.equal((await boss.post(`/api/users/${badId}/access`, { ...olivia, places: ['/nowhere'] })).status, 404);
    assert.equal((await boss.post(`/api/users/${badId}/access`, { ...olivia, places: ['olivia'] })).status, 400, 'a place is /<folder>');
    assert.equal((await boss.post(`/api/users/${badId}/access`, { ...olivia, rights: ['forms', 'root'] })).status, 400, 'a part the panel has');
    const wide = await boss.post(`/api/users/${badId}/access`, { ...olivia, rights: ['forms', 'databases', 'software'] });
    assert.deepEqual([wide.status, wide.json.message], [409, "Someone kept to places can't have databases, software: those parts can't tell which place a thing is in yet."]);
    const set = await boss.post(`/api/users/${badId}/access`, olivia);
    assert.deepEqual([set.status, set.json.places, set.json.rights], [200, ['/olivia'], olivia.rights]);
    // not signed out: rights and places are read with the session, every request
    const session = (await bad.get('/api/session')).json.user;
    assert.deepEqual([session.places, session.rights], [['/olivia'], olivia.rights]);
    const list = (await boss.get('/api/users')).json.users.find((u: { username: string }) => u.username === 'badmon');
    assert.deepEqual([list.places, list.rights], [['/olivia'], olivia.rights]);
    // kept in user_places, the one place that says it (users.scope went, docs/permissions-plan.md R9)
    assert.deepEqual(await placesOf(db, badId), ['/olivia']);
    const me = (await boss.get('/api/users')).json.users.find((u: { isYou: boolean }) => u.isYou);
    assert.equal((await boss.post(`/api/users/${me.id}/access`, olivia)).status, 409, 'an account manager has everything');
    await assert.rejects(setRole(db, clock, COMMAND_LINE, (await getUserByName(db, 'badmon'))!, 'manager'), /only sees olivia/);
    // Activity says what changed, and saying it again changes nothing
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'user-places-changed' AND target = 'badmon' AND detail = 'places: /olivia'"));
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'user-rights-changed' AND target = 'badmon' AND detail = 'subdomains: off, protected: off'"));
    const lines = async () => (await one<{ n: number }>(db, "SELECT count(*) AS n FROM activity WHERE target = 'badmon' AND action IN ('user-places-changed', 'user-rights-changed')"))!.n;
    const before = await lines();
    assert.equal((await boss.post(`/api/users/${badId}/access`, olivia)).status, 200);
    assert.equal(await lines(), before);
  });

  it('a new account has nothing until it is given, or what it was given as it was made (R6)', async () => {
    const made = await boss.post('/api/users', { username: 'newbie', displayName: 'Newbie' });
    assert.equal(made.status, 200);
    const newbie = (await boss.get('/api/users')).json.users.find((u: { username: string }) => u.username === 'newbie');
    assert.deepEqual([newbie.rights, newbie.places], [[], []]);
    assert.equal((await boss.post('/api/users', { username: 'helper2', displayName: 'Helper', rights: ['media'], places: ['/nowhere'] })).status, 404);
    assert.equal(await getUserByName(db, 'helper2'), undefined, 'a folder that isn\'t there: nothing is made');
    assert.equal((await boss.post('/api/users', { username: 'helper2', displayName: 'Helper', rights: ['media', 'examples'], places: ['/recipes'] })).status, 409);
    assert.equal(await getUserByName(db, 'helper2'), undefined);
    assert.equal((await boss.post('/api/users', { username: 'helper2', displayName: 'Helper', rights: ['media', 'protected'], places: ['/recipes'] })).status, 200);
    const h = (await boss.get('/api/users')).json.users.find((u: { username: string }) => u.username === 'helper2');
    assert.deepEqual([h.rights, h.places], [['media', 'protected'], ['/recipes']]);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'user-rights-changed' AND target = 'helper2' AND detail = 'media: on, protected: on'"));
  });

  it('everything but its own things is simply not there', async () => {
    for (const url of ['/api/sites', '/api/protected', '/api/requests', '/api/users', '/api/api-keys', '/api/examples', '/api/folders']) {
      assert.equal((await bad.get(url)).status, 404, url);
    }
    for (const url of ['/api/sites', '/api/protected', '/api/visitors', `/api/users/${badId}/access`]) assert.equal((await bad.post(url, {})).status, 404, url);
    for (const url of ['/api/session', '/api/me/passkeys', '/api/help', '/api/media', '/api/files', '/api/forms', '/api/responses']) assert.equal((await bad.get(url)).status, 200, url);
    // its own lines in Activity, and nobody else's (docs/permissions-plan.md R7)
    const act = (await bad.get('/api/activity')).json;
    assert.equal(act.own, true);
    assert.ok(act.entries.every((e: { actor_id: number }) => e.actor_id === badId), 'only its own lines');
    // Help: its own guide (and the one about forms), not Pamela's others
    assert.deepEqual((await bad.get('/api/help')).json.guides.map((g: { file: string }) => g.file), ['11-one-folder.txt']);
    assert.ok((await boss.get('/api/help')).json.guides.length >= 3);
  });

  it('media: only its folder, whatever it asks for', async () => {
    const m = (await bad.get('/api/media')).json;
    assert.deepEqual([m.folders.map((f: { folder: string }) => f.folder), m.limitedTo], [['olivia'], ['olivia']]);
    const all = (await bad.get('/api/media/items')).json;
    assert.deepEqual(all.items.map((i: { name: string }) => i.name), ['party.jpg']);
    assert.equal((await bad.get('/api/media/items?scope=*')).json.items.length, 1);
    const recipe = (await idOf('recipes/media/images/secret-recipe.jpg'));
    const party = (await idOf('olivia/media/images/party.jpg'));
    for (const url of [
      '/api/media/items?scope=%2Frecipes', '/api/media/items?scope=%2F', '/api/media/list?dir=recipes%2Fmedia%2Fimages', '/api/media/buckets?dir=recipes%2Fmedia%2Fimages',
      '/api/media/info?path=recipes%2Fmedia%2Fimages%2Fsecret-recipe.jpg', '/api/media/file?path=recipes%2Fmedia%2Fimages%2Fsecret-recipe.jpg',
      `/api/media/thumb/${recipe}`, '/api/media/labels?scope=%2Frecipes', '/api/files/items?dir=recipes',
    ]) assert.equal((await bad.get(url)).status, 404, url);
    assert.equal((await bad.get('/api/media/file?path=olivia%2F..%2Frecipes%2Fmedia%2Fimages%2Fsecret-recipe.jpg')).status, 400, 'no way round it with ..');
    assert.equal((await upload(bad, 'recipes/media/images', 'x.jpg')).statusCode, 404);
    assert.equal((await upload(bad, 'olivia/media/images', 'mine.jpg')).statusCode, 200);
    for (const [url, b] of [
      ['/api/media/folder', { folder: 'recipes' }], ['/api/media/folder', { folder: '' }], ['/api/media/mkdir', { dir: 'recipes/media/images', name: 'x' }],
      ['/api/media/copy', { from: 'recipes/media/images/secret-recipe.jpg', to: 'olivia/media/images' }],
      ['/api/media/move', { from: 'olivia/media/images/mine.jpg', to: 'recipes/media/images' }],
      ['/api/media/trash', { path: 'recipes/media/images/secret-recipe.jpg' }],
      ['/api/media/labels', { scope: '/recipes', type: 'tag', name: 'x' }],
      ['/api/media/items/labels', { ids: [recipe, party], add: { tags: ['x'] } }],
    ] as const) assert.equal((await bad.post(url, b)).status, 404, url);
    // its own: everything works
    assert.equal((await bad.post('/api/media/items/labels', { ids: [party], add: { tags: ['party'] } })).status, 200);
    assert.deepEqual((await bad.get('/api/media/labels')).json.labels.map((l: { address: string }) => l.address), ['/olivia/t/party']);
    const theirs = (await boss.post('/api/media/labels', { scope: '/recipes', type: 'tag', name: 'secret' })).json.label;
    assert.equal((await bad.post(`/api/media/labels/tag/${theirs.id}`, { name: 'mine' })).status, 404);
    assert.equal((await bad.post(`/api/media/labels/tag/${theirs.id}`, { delete: true })).status, 404);
    // the trash: only its own, and only its own back
    const t = await boss.post('/api/media/trash', { path: 'recipes/media/images/secret-recipe.jpg' });
    assert.equal((await bad.post('/api/media/trash', { path: 'olivia/media/images/mine.jpg' })).status, 200);
    assert.deepEqual((await bad.get('/api/media/trash')).json.items.map((i: { path: string }) => i.path), ['olivia/media/images/mine.jpg']);
    assert.equal((await bad.post('/api/media/restore', { id: t.json.id })).status, 404);
    assert.equal((await boss.post('/api/media/restore', { id: t.json.id })).status, 200);
    // the others see everything, as before
    assert.deepEqual((await boss.get('/api/media')).json.folders.filter((f: { hasMedia: boolean }) => f.hasMedia).map((f: { folder: string }) => f.folder), ['olivia', 'recipes']);
  });

  it('forms and responses: its folder\'s only; its new forms are its folder\'s', async () => {
    const everywhere = (await boss.post('/api/forms', { name: 'boss-form' })).json.form;
    assert.equal(everywhere.scope, '/');
    const scoped = (await boss.post('/api/forms', { name: 'recipes-form', scope: 'recipes', items: [{ type: 'short-text', label: 'Note' }] })).json.form;
    assert.equal(scoped.scope, '/recipes');
    assert.equal((await boss.post('/api/forms', { name: 'nowhere-form', scope: 'nowhere' })).status, 404);
    const mine = (await bad.post('/api/forms', { name: 'olivias-rsvp', scope: '/' })).json.form;
    assert.equal(mine.scope, '/olivia');
    assert.deepEqual((await bad.get('/api/forms')).json.forms.map((f: { name: string }) => f.name), ['olivias-rsvp']);
    for (const url of [`/api/forms/${everywhere.id}`, `/api/forms/${scoped.id}`, `/api/forms/${everywhere.id}/copy-name`]) assert.equal((await bad.get(url)).status, 404, url);
    assert.equal((await bad.post(`/api/forms/${everywhere.id}/trash`)).status, 404);
    assert.equal((await bad.post(`/api/forms/${mine.id}/scope`, { scope: '' })).status, 404, 'only the others choose where a form works');
    const moved = await boss.post(`/api/forms/${everywhere.id}/scope`, { scope: 'olivia' });
    assert.deepEqual([moved.status, moved.json.form.scope], [200, '/olivia']);
    assert.equal((await bad.get(`/api/forms/${everywhere.id}`)).status, 200, 'now olivia\'s, so it sees it');
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'form-scope-changed' AND target = 'boss-form' AND detail = 'works only in olivia'"));
    // responses
    await addResponse(gate.db, clock, (await formById(gate.db, scoped.id))!, 'recipes/x.html', { note: 'hi' }, null, 'pammy.org', null);
    const theirs = (await boss.get('/api/responses')).json.responses.find((r: { formName: string }) => r.formName === 'recipes-form');
    assert.ok(theirs);
    assert.equal((await bad.get('/api/responses')).json.responses.length, 0);
    assert.equal((await bad.get('/api/responses/unread')).json.unread, 0);
    assert.equal((await bad.get(`/api/responses?form=${scoped.id}`)).status, 404);
    for (const act of ['read', 'approve', 'trash']) assert.equal((await bad.post(`/api/responses/${theirs.id}/${act}`, { read: true, approved: true })).status, 404, act);
  });

  it('seeing everything again', async () => {
    assert.deepEqual((await boss.post(`/api/users/${badId}/access`, MEMBER)).json.places, []);
    assert.equal((await bad.get('/api/sites')).status, 200);
    // what members have always had, and no places
    const session = (await bad.get('/api/session')).json.user;
    assert.deepEqual([session.places, session.rights], [[], ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected']]);
    assert.deepEqual(await placesOf(db, badId), []);
  });

  // docs/permissions-plan.md R4-R5: what a person has is what is written for them,
  // read afresh on every request. The Accounts page writes it in step 3; here, by hand.
  const give = async (rights: string[], places: string[]) => {
    await run(db, 'DELETE FROM user_rights WHERE user_id = ?', badId);
    await run(db, 'DELETE FROM user_places WHERE user_id = ?', badId);
    for (const r of rights) await run(db, 'INSERT INTO user_rights (user_id, name) VALUES (?, ?)', badId, r);
    for (const p of places) await run(db, 'INSERT INTO user_places (user_id, place) VALUES (?, ?)', badId, p);
  };

  it('a person with two rights and nothing else: those two parts, and no others (R4)', async () => {
    await give(['forms', 'responses'], []);
    // no sign-in again: the change works on their very next request
    assert.deepEqual((await bad.get('/api/session')).json.user.rights, ['forms', 'responses']);
    for (const url of ['/api/forms', '/api/responses', '/api/responses/unread', '/api/examples', '/api/help', '/api/activity']) assert.equal((await bad.get(url)).status, 200, url);
    for (const url of ['/api/media', '/api/files', '/api/sites', '/api/protected', '/api/requests', '/api/folders', '/api/users', '/api/databases']) {
      assert.equal((await bad.get(url)).status, 404, `${url}: a part they don't have isn't there (R4)`);
    }
    // a right that no part of the panel has is no right at all
    await give(['forms', 'root'], []);
    assert.deepEqual((await bad.get('/api/session')).json.user.rights, ['forms']);
  });

  it('a person kept to two places: both, in every part they have, and only there (R5)', async () => {
    await give(['files', 'media', 'forms', 'responses', 'comments'], ['/olivia', '/recipes']);
    const me = (await bad.get('/api/session')).json.user;
    assert.deepEqual(me.places, ['/olivia', '/recipes']);
    const m = (await bad.get('/api/media')).json;
    assert.deepEqual([m.folders.filter((f: { hasMedia: boolean }) => f.hasMedia).map((f: { folder: string }) => f.folder), m.limitedTo], [['olivia', 'recipes'], ['olivia', 'recipes']]);
    // with none asked for, every one of theirs; asked for one, only that one
    const names = async (q: string) => (await bad.get(`/api/media/items${q}`)).json.items.map((i: { name: string }) => i.name).sort();
    assert.deepEqual(await names(''), ['party.jpg', 'secret-recipe.jpg']);
    assert.deepEqual(await names('?scope=%2Frecipes'), ['secret-recipe.jpg']);
    assert.equal((await bad.get('/api/media/items?scope=%2F')).status, 404, 'the top of the website is in neither');
    assert.deepEqual((await bad.get('/api/files')).json.limitedTo, ['olivia', 'recipes']);
    assert.equal((await bad.get('/api/files/items?dir=recipes')).status, 200);
    assert.equal((await bad.get('/api/files/items?dir=')).status, 404);
    // forms: theirs from both places, and a new one where they chose
    const forms = (await bad.get('/api/forms')).json.forms.map((f: { name: string }) => f.name);
    assert.ok(forms.includes('recipes-form') && forms.includes('olivias-rsvp') && !forms.includes('boss-form-x'), forms.join(', '));
    assert.equal((await bad.post('/api/forms', { name: 'no-place-form' })).status, 400, 'with two, it has to say which');
    assert.equal((await bad.post('/api/forms', { name: 'no-place-form', scope: 'elsewhere' })).status, 404);
    assert.equal((await bad.post('/api/forms', { name: 'recipes-two', scope: 'recipes' })).json.form.scope, '/recipes');
    assert.ok((await bad.get('/api/responses')).json.responses.some((r: { formName: string }) => r.formName === 'recipes-form'));
    // still nothing about the whole site, whatever rights are written
    await give(['files', 'media', 'forms', 'subdomains', 'protected', 'databases'], ['/olivia', '/recipes']);
    for (const url of ['/api/databases', '/api/folders', '/api/examples']) assert.equal((await bad.get(url)).status, 404, url);
    assert.deepEqual((await bad.get('/api/session')).json.user.rights, ['files', 'media', 'subdomains', 'forms', 'protected']);
  });

  it('subdomains: only their own folders, and never a new, trashed or restored one (step 3)', async () => {
    await give(['subdomains'], ['/olivia']);
    const st = (await bad.get('/api/sites')).json;
    assert.deepEqual([st.folders.map((f: { name: string }) => f.name), st.trash, st.kept], [['olivia'], [], true]);
    assert.ok((await boss.get('/api/sites')).json.folders.length >= 2);
    for (const [url, b] of [['/api/sites', { name: 'mine' }], ['/api/sites/trash', { name: 'olivia' }], ['/api/sites/restore', { entry: 'x--20260101T000000Z' }]] as const) {
      assert.equal((await bad.post(url, b)).status, 404, url);
    }
    assert.equal((await bad.get('/api/sites/recipes/home-page')).status, 404);
    assert.equal((await bad.post('/api/sites/recipes/home-page', { heading: 'Mine now' })).status, 404);
    assert.equal((await bad.get('/api/sites/olivia/home-page')).status, 200);
  });

  it('protected folders: theirs, the people who open them, and the requests about them (step 3)', async () => {
    await give(['protected'], []);
    const club = (await boss.post('/api/protected', { path: 'recipes' })).json;
    await give(['protected'], ['/olivia']);
    const mine = await bad.post('/api/protected', { path: 'olivia' });
    assert.equal(mine.status, 200);
    assert.equal((await bad.post('/api/protected', { path: 'recipes' })).status, 404);
    // people: one only theirs, one who opens both places, one who opens only the other
    const alice = (await bad.post('/api/visitors', { username: 'alice', areaIds: [mine.json.id] })).json;
    assert.equal((await bad.post('/api/visitors', { username: 'nobody-sees' })).status, 400, 'a person with none of their folders');
    assert.equal((await bad.post('/api/visitors', { username: 'sneaky', areaIds: [club.id] })).status, 400);
    const bob = (await boss.post('/api/visitors', { username: 'bob', areaIds: [mine.json.id, club.id] })).json;
    const carol = (await boss.post('/api/visitors', { username: 'carol', areaIds: [club.id] })).json;
    const st = (await bad.get('/api/protected')).json;
    assert.deepEqual(st.areas.map((x: { path: string }) => x.path), ['olivia']);
    assert.deepEqual(st.visitors.map((v: { username: string; whole: boolean; areas: number[] }) => [v.username, v.whole, v.areas]),
      [['alice', true, [mine.json.id]], ['bob', false, [mine.json.id]]], 'carol is not theirs to see, and bob\'s other folder is not named');
    assert.deepEqual(st.folders.every((f: string) => f === 'olivia' || f.startsWith('olivia/')), true);
    // their folder: give and take, for anyone they see; someone who then opens none
    // of their folders is no longer theirs to see (the page warns before that)
    assert.equal((await bad.post(`/api/protected/${mine.json.id}/access`, { visitorId: bob.id, allow: false })).status, 200);
    assert.equal((await bad.post(`/api/protected/${mine.json.id}/access`, { visitorId: bob.id, allow: true })).status, 404);
    assert.equal((await boss.post(`/api/protected/${mine.json.id}/access`, { visitorId: bob.id, allow: true })).status, 200);
    assert.equal((await bad.post(`/api/protected/${mine.json.id}/access`, { visitorId: carol.id, allow: true })).status, 404);
    for (const act of ['pages', 'requests', 'access', 'unprotect']) assert.equal((await bad.post(`/api/protected/${club.id}/${act}`, { visitorId: alice.id, allow: true, open: true })).status, 404, act);
    // the person themselves: only someone wholly theirs
    assert.equal((await bad.post(`/api/visitors/${alice.id}/rename`, { name: 'Alice' })).status, 200);
    assert.equal((await bad.post(`/api/visitors/${alice.id}/link`, {})).status, 200);
    for (const act of ['rename', 'password', 'active', 'signout', 'link', 'link/cancel', 'delete']) {
      assert.equal((await bad.post(`/api/visitors/${bob.id}/${act}`, { name: 'Bobby', password: 'a-long-password-1', active: false })).status, 409, `bob: ${act}`);
      assert.equal((await bad.post(`/api/visitors/${carol.id}/${act}`, { name: 'C', password: 'a-long-password-1', active: false })).status, 404, `carol: ${act}`);
    }
    // requests: only about their folders
    await boss.post(`/api/protected/${club.id}/requests`, { open: true });
    await boss.post(`/api/protected/${mine.json.id}/requests`, { open: true });
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, club.id))!, { name: 'Club fan', contact: 'fan@example.com', message: '' }, 'pammy.org', null);
    await addAccessRequest(gate.db, clock, (await areaById(gate.db, mine.json.id))!, { name: 'Olivia fan', contact: 'ofan@example.com', message: '' }, 'pammy.org', null);
    const reqs = (await bad.get('/api/requests')).json;
    assert.deepEqual(reqs.open.map((r: { name: string }) => r.name), ['Olivia fan']);
    assert.deepEqual(reqs.visitors.map((v: { username: string }) => v.username).sort(), ['alice', 'bob']);
    const theirs = (await boss.get('/api/requests')).json.open.find((r: { name: string }) => r.name === 'Club fan');
    for (const act of ['approve', 'decline', 'delete']) assert.equal((await bad.post(`/api/requests/${theirs.id}/${act}`, { username: 'fan' })).status, 404, act);
    const ours = reqs.open[0];
    assert.equal((await bad.post(`/api/requests/${ours.id}/approve`, { visitorId: carol.id })).status, 404, 'not a person they see');
    assert.equal((await bad.post(`/api/requests/${ours.id}/approve`, { username: 'ofan' })).status, 200);
    // the rest of the site's people and folders are untouched
    assert.equal((await boss.get('/api/protected')).json.visitors.find((v: { username: string }) => v.username === 'carol').name, '');
    await give(['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected'], []);
  });
});

// ---------------------------------------------------------------------------
describe('the editor through the panel (docs/editor-plan.md)', () => {
  const boss = new Browser('203.0.113.120');
  const helperAcct = new Browser('203.0.113.121');
  let helper: ReturnType<typeof createSiteFsServer>;
  let pub = '';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const q = (p: string) => encodeURIComponent(p);
  const PAGE = '<!doctype html><html><head><title>Hi</title><link rel="stylesheet" href="style.css"></head><body><img src="/media/images/a.jpg"><pammy-form name="rsvp"></pammy-form></body></html>';
  const view = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' });     // no cookie, like the sandboxed frame

  before(async () => {
    pub = join(dir, 'public-editor');
    for (const f of ['olivia/login-files', 'recipes', 'olivia/media/images']) mkdirSync(join(pub, f), { recursive: true });
    writeFileSync(join(pub, 'olivia', 'index.html'), PAGE);
    writeFileSync(join(pub, 'olivia', 'style.css'), 'body { color: red }');
    writeFileSync(join(pub, 'olivia', 'login-files', 'style.css'), 'form {}');
    writeFileSync(join(pub, 'olivia', 'photo.jpg'), 'not text \xff');
    writeFileSync(join(pub, 'olivia', 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(join(pub, 'olivia', 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    writeFileSync(join(pub, 'recipes', 'secret.html'), '<p>secret</p>');
    writeFileSync(join(pub, 'top.html'), '<p>top</p>');
    helper = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-editor'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    mkdirSync(join(dir, 'trash-editor'));
    await new Promise<void>((r) => helper.listen(join(dir, 'sitefs.sock'), r));
    const m = await createUser(db, clock, COMMAND_LINE, 'editboss', 'Edit Boss', 'manager');
    assert.equal((await boss.useInvite((await createInvite(db, clock, COMMAND_LINE, m)).token)).status, 200);
    const u = await createUser(db, clock, COMMAND_LINE, 'edithelper', 'Edit Helper', 'member', MEMBER);
    await setAccess(db, clock, COMMAND_LINE, u, keptTo('/olivia'));
    assert.equal((await helperAcct.useInvite((await createInvite(db, clock, COMMAND_LINE, (await getUserByName(db, 'edithelper'))!)).token)).status, 200);
    await media.sync('test');
  });
  after(async () => { await new Promise<void>((r) => helper.close(() => r())); });

  it('opens text files whole with their sha256, and only text files it can edit, up to 2 MB', async () => {
    const r = await boss.get(`/api/files/text?path=${q('olivia/index.html')}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.text, r.json.hash, r.json.name, r.json.size], [PAGE, sha(PAGE), 'index.html', Buffer.byteLength(PAGE)]);
    assert.equal((await boss.get(`/api/files/text?path=${q('olivia/photo.jpg')}`)).status, 400, 'not a type the editor opens');
    assert.equal((await boss.get(`/api/files/text?path=${q('olivia/binary.txt')}`)).status, 415, 'not UTF-8');
    assert.equal((await boss.get(`/api/files/text?path=${q('olivia/huge.txt')}`)).status, 413);
    assert.equal((await boss.get(`/api/files/text?path=${q('olivia/nope.html')}`)).status, 404);
    assert.equal((await boss.get(`/api/files/text?path=${q('olivia/login-files/style.css')}`)).status, 400, 'login-files belong to the protected folder');
  });

  it('saves over what it opened, refuses with "conflict" when the file changed, and keeps the record and the log up to date', async () => {
    const before = (await actions()).filter((x) => x === 'file-saved').length;
    const s1 = await boss.post('/api/files/save', { path: 'olivia/style.css', text: 'body { color: blue }', expect: sha('body { color: red }'), session: 'panel-test-editor' });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.equal(readFileSync(join(pub, 'olivia', 'style.css'), 'utf8'), 'body { color: blue }');
    const rec = (await one<{ hash: string; size: number }>(db, "SELECT hash, size FROM records WHERE path = 'olivia/style.css' AND state = 'present'"))!;
    assert.deepEqual([rec.hash, rec.size], [sha('body { color: blue }'), 20]);
    advance(60);
    const s2 = await boss.post('/api/files/save', { path: 'olivia/style.css', text: 'body { color: green }', expect: s1.json.hash, session: 'panel-test-editor' });
    assert.equal(s2.json.version, s1.json.version, 'a quick second save: the same earlier version');
    assert.equal((await actions()).filter((x) => x === 'file-saved').length, before + 1, 'and one line in the activity log');
    writeFileSync(join(pub, 'olivia', 'style.css'), 'changed in WinSCP');
    const c = await boss.post('/api/files/save', { path: 'olivia/style.css', text: 'mine', expect: s2.json.hash });
    assert.deepEqual([c.status, c.json.error], [409, 'conflict']);
    assert.equal(readFileSync(join(pub, 'olivia', 'style.css'), 'utf8'), 'changed in WinSCP');
    assert.equal((await boss.post('/api/files/save', { path: 'olivia/style.css', text: 'x'.repeat(2 * 1024 * 1024 + 1), expect: 'x' })).status, 413);
    assert.equal((await boss.post('/api/files/save', { path: 'olivia/style.css' })).status, 400);
  });

  it('makes new files (never over one), or saves a copy under a free name', async () => {
    const n = await boss.post('/api/files/save', { path: 'olivia/new-page.html', text: '<h1>New</h1>', create: 'exact' });
    assert.deepEqual([n.status, n.json.path, n.json.created], [200, 'olivia/new-page.html', true]);
    const rec = (await one<{ added_by: string; how: string }>(db, "SELECT added_by, how FROM records WHERE path = 'olivia/new-page.html' AND state = 'present'"))!;
    assert.deepEqual([rec.added_by, rec.how], ['editboss', 'uploaded']);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'file-created' AND target = 'olivia/new-page.html'"));
    assert.equal((await boss.post('/api/files/save', { path: 'olivia/new-page.html', text: 'again', create: 'exact' })).status, 409);
    const copy = await boss.post('/api/files/save', { path: 'olivia/new-page.html', text: 'mine', create: 'free' });
    assert.equal(copy.json.path, 'olivia/new-page-2.html');
    assert.equal((await boss.post('/api/files/save', { path: 'olivia/x.php', text: '<?php', create: 'exact' })).status, 400);
  });

  it('lists earlier versions, shows one, and restores it (a save itself)', async () => {
    const list = await boss.get(`/api/files/versions?path=${q('olivia/style.css')}`);
    assert.equal(list.status, 200);
    assert.equal(list.json.versions.length, 1);
    const v = list.json.versions[0];
    assert.deepEqual([v.by, v.path], ['editboss', 'olivia/style.css']);
    const old = await boss.get(`/api/files/version?id=${v.id}`);
    assert.deepEqual([old.status, old.json.text], [200, 'body { color: red }']);
    const cur = (await boss.get(`/api/files/text?path=${q('olivia/style.css')}`)).json;
    assert.equal((await boss.post('/api/files/versions/restore', { id: v.id, expect: sha('stale') })).status, 409);
    const r = await boss.post('/api/files/versions/restore', { id: v.id, expect: cur.hash });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(readFileSync(join(pub, 'olivia', 'style.css'), 'utf8'), 'body { color: red }');
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'file-version-restored' AND target = 'olivia/style.css'"));
    assert.equal((await boss.get(`/api/files/versions?path=${q('olivia/style.css')}`)).json.versions.length, 2, 'what was there is kept too');
  });

  it('an account kept to one folder edits only in that folder', async () => {
    assert.equal((await helperAcct.get(`/api/files/text?path=${q('olivia/index.html')}`)).status, 200);
    assert.equal((await helperAcct.get(`/api/files/text?path=${q('recipes/secret.html')}`)).status, 404);
    assert.equal((await helperAcct.get(`/api/files/text?path=${q('olivia/../recipes/secret.html')}`)).status, 400);
    assert.equal((await helperAcct.post('/api/files/save', { path: 'recipes/secret.html', text: 'x', expect: sha('<p>secret</p>') })).status, 404);
    assert.equal((await helperAcct.post('/api/files/save', { path: 'recipes/new.html', text: 'x', create: 'exact' })).status, 404);
    assert.equal((await helperAcct.post('/api/files/save', { path: 'top.html', text: 'x', create: 'free' })).status, 404);
    assert.equal((await helperAcct.post('/api/files/save', { path: 'olivia/helper.js', text: 'console.log(1)', create: 'exact' })).status, 200, 'any editable type in its own folder');
    assert.equal((await helperAcct.get(`/api/files/versions?path=${q('recipes/secret.html')}`)).status, 404);
    const theirs = (await boss.post('/api/files/save', { path: 'recipes/secret.html', text: 'v2', expect: sha('<p>secret</p>') })).json;
    assert.equal((await helperAcct.get(`/api/files/version?id=${theirs.version}`)).status, 404, "another folder's versions aren't there");
    assert.equal((await helperAcct.post('/api/files/versions/restore', { id: theirs.version, expect: sha('v2') })).status, 404);
    assert.equal((await helperAcct.post('/api/files/preview', { path: 'recipes/secret.html' })).status, 404);
  });

  it('tags and categories on any file: a folder with no media folder, and what a folder\'s files can have', async () => {
    const t = await boss.post('/api/media/labels', { scope: '/recipes', type: 'tag', name: 'desserts' });
    assert.equal(t.status, 200, 'recipes has no media folder, and can still have tags');
    assert.equal((await boss.post('/api/media/labels', { scope: '/recipes/deep', type: 'tag', name: 'x' })).status, 404, 'a deeper folder must be marked as a tag scope first');
    assert.equal((await boss.post('/api/media/labels', { scope: '/', type: 'category', name: 'everywhere' })).status, 200);
    const id = (await one<{ id: number }>(db, "SELECT id FROM records WHERE path = 'recipes/secret.html' AND state = 'present'"))!.id;
    const set = await boss.post('/api/media/items/labels', { ids: [id], set: { tags: ['desserts'], categories: ['everywhere'] } });
    assert.deepEqual([set.status, set.json.created], [200, []], 'the labels already there are used, from its folder and from the top');
    const around = (w: Browser, f: string) => w.get(`/api/media/labels?around=${q(f)}`);
    const names = (r: { json: { labels: { address: string }[] } }) => r.json.labels.map((l) => l.address).sort();
    const here = names(await around(boss, 'recipes'));
    assert.ok(here.includes('/c/everywhere') && here.includes('/recipes/t/desserts'), 'its folder\'s labels and the top\'s');
    assert.ok(here.every((a: string) => !a.slice(1).includes('/') || a.startsWith('/recipes/') || /^\/[tc]\//.test(a)), `only its own and the top's: ${here}`);
    assert.ok(!names(await around(boss, 'olivia')).includes('/recipes/t/desserts'), "another folder's labels aren't offered");
    assert.ok(names(await around(boss, '')).includes('/recipes/t/desserts'), 'from the top: everything below');
    const found = await boss.get(`/api/files/items?dir=recipes&tag=${t.json.label.id}`);
    assert.deepEqual(found.json.items.map((i: { name: string }) => i.name), ['secret.html'], 'File Explorer finds the page by its tag');
    const all = (await boss.get('/api/media/labels?scope=*')).json.labels.map((l: { address: string }) => l.address);
    assert.ok(all.includes('/recipes/t/desserts') && all.includes('/c/everywhere'));
    // an account kept to olivia: only its own
    assert.equal((await around(helperAcct, 'recipes')).status, 404);
    assert.ok(names(await around(helperAcct, 'olivia')).every((a: string) => a.startsWith('/olivia/')));
    assert.equal((await helperAcct.post('/api/media/labels', { scope: '/recipes', type: 'tag', name: 'x' })).status, 404);
  });

  it('previews through a token, sandboxed, inside the page\'s top folder only, with the unsaved text', async () => {
    const t = await boss.post('/api/files/preview', { path: 'olivia/index.html' });
    assert.equal(t.status, 200);
    const base: string = t.json.base;
    assert.match(base, /^\/api\/files\/view\/[A-Za-z0-9_-]{32}\/$/);
    const page = await view(`${base}olivia/index.html`);
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-type']), /^text\/html/);
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, /sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /frame-ancestors https:\/\/panel\.pammy\.org/);
    assert.equal(page.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(page.body, /<head><style data-pammy-preview>/, 'the gate\'s tags get a labelled box');
    assert.ok(page.body.includes(`src="${base}olivia/media/images/a.jpg"`), '"/" means the top of the folder');
    assert.ok(page.body.includes('href="style.css"'), 'relative links left as they are');
    assert.equal((await view(`${base}olivia/style.css`)).body, 'body { color: red }');
    assert.equal((await view(`${base}olivia/login-files/style.css`)).body, 'form {}', 'a sign-in page\'s own styles show');
    assert.equal((await view(`${base}olivia/`)).statusCode, 200, 'a folder address is its index.html');
    assert.equal((await view(`${base}olivia`)).statusCode, 302);
    assert.equal((await view(`${base}recipes/secret.html`)).statusCode, 404, 'outside the page\'s folder');
    assert.equal((await view(`${base}top.html`)).statusCode, 404);
    assert.equal((await view(`${base}olivia/..%2F..%2Frecipes/secret.html`)).statusCode, 404);
    assert.equal((await view('/api/files/view/not-a-token/olivia/index.html')).statusCode, 410);

    // unsaved text
    const token = base.split('/')[4];
    assert.equal((await boss.post('/api/files/draft', { token, path: 'olivia/index.html', text: '<p>draft</p>' })).status, 200);
    assert.match((await view(`${base}olivia/index.html`)).body, /<p>draft<\/p>/);
    assert.equal((await helperAcct.post('/api/files/draft', { token, path: 'olivia/index.html', text: '<p>not mine</p>' })).status, 410, "someone else's token");
    assert.equal((await boss.post('/api/files/draft', { token, path: 'recipes/secret.html', text: 'x' })).status, 410, 'outside its folder');

    // a page at the top of the website may see all of it; an account kept to one folder only its own
    const top = (await boss.post('/api/files/preview', { path: 'top.html' })).json.base;
    assert.equal((await view(`${top}recipes/secret.html`)).statusCode, 200);
    const h = (await helperAcct.post('/api/files/preview', { path: 'olivia/index.html' })).json.base;
    assert.equal((await view(`${h}olivia/index.html`)).statusCode, 200);
    assert.equal((await view(`${h}recipes/secret.html`)).statusCode, 404);

    // signing out ends its previews at once
    const other = new Browser('203.0.113.122');
    other.auth = boss.auth;
    assert.equal((await other.login()).status, 200);
    const mine = (await other.post('/api/files/preview', { path: 'olivia/index.html' })).json.base;
    assert.equal((await view(`${mine}olivia/index.html`)).statusCode, 200);
    assert.equal((await other.post('/api/logout')).status, 200);
    assert.equal((await view(`${mine}olivia/index.html`)).statusCode, 410);

    // idle for over two hours: gone
    advance(2 * 3600 + 1);
    assert.equal((await view(`${base}olivia/index.html`)).statusCode, 410);
    assert.equal((await boss.post('/api/files/draft', { token, path: 'olivia/index.html', text: 'x' })).status, 410);
  });
});

// ------------------------------------------------------------------ her databases
// The dashboard over her own engines (docs/databases-plan.md 5). The helper is
// stubbed here -- test/pammydb.test.ts is what drives the real engines -- so
// these are about the panel: who may ask, what it remembers, and what it refuses.
describe('her databases', () => {
  const boss = new Browser('203.0.113.140');
  const member = new Browser('203.0.113.141');
  let helper: ReturnType<typeof createPammyDbServer>;
  let gateAdmin: ReturnType<typeof createGateAdminServer>;
  let gate: GateLive;
  // what the stubbed engines have; tests push and pull on this
  let live: Record<'postgres' | 'mariadb', string[]>;
  let down: string | null = null;
  const asked: string[] = [];
  let liveUsers: Record<'postgres' | 'mariadb', string[]>;
  const grants = new Map<string, AccessRole>();
  let schemas: Record<'postgres' | 'mariadb', ReturnType<typeof memorySchemas>>;
  // her rows, in memory, so the generated app's routes can be exercised
  const appRows = memoryRows();
  const passwords: string[] = [];

  const facts = (engine: 'postgres' | 'mariadb', name: string): DatabaseFacts => ({
    engine, name, bytes: 4096, tables: name === 'pamela' ? 3 : 0, owner: engine === 'postgres' ? 'pammy_studio' : null,
    protectedName: name === 'pamela' || name === 'postgres' || name === 'mysql',
    system: name === 'postgres' || name === 'mysql',
  });
  const stub = (engine: 'postgres' | 'mariadb'): Driver => ({
    engine,
    state: async () => ({ engine, ok: true, version: null, message: null }),
    list: async () => {
      if (down === engine) throw new PammyDbError('unavailable', `Her ${engine} is not answering.`);
      return live[engine].map((n) => facts(engine, n));
    },
    create: async (name) => { live[engine].push(name); return facts(engine, name); },
    drop: async (name) => {
      live[engine] = live[engine].filter((n) => n !== name);
      // and everything in it, as on a real engine
      schemas[engine].set(name, []);
      appRows.forget(name);
    },
    size: async (name) => ({ bytes: 4096, tables: facts(engine, name).tables ?? 0 }),
    // the shape inside one, kept in memory (test/studio-stub.ts). Whether a real
    // engine would accept a step is test/pammydb.test.ts's job.
    introspect: (database) => schemas[engine].introspect(engine, database),
    apply: (database, steps) => schemas[engine].apply(engine, database, steps),
    // logins and their access, as far as the routes are concerned: the real
    // GRANTs are test/pammydb.test.ts's job, against real engines
    listUsers: async () => {
      if (down === engine) throw new PammyDbError('unavailable', `Her ${engine} is not answering.`);
      return liveUsers[engine].map((name) => ({
        engine, name, host: engine === 'mariadb' ? '%' : null, canLogin: true,
        reserved: ['postgres', 'pamela', 'root'].includes(name),
        serverWide: name === 'pamela',
      }));
    },
    createUser: async (name) => {
      liveUsers[engine].push(name);
      return { engine, name, host: engine === 'mariadb' ? '%' : null, canLogin: true, reserved: false, serverWide: false };
    },
    dropUser: async (name) => {
      liveUsers[engine] = liveUsers[engine].filter((n) => n !== name);
      for (const k of [...grants.keys()]) if (k.startsWith(`${engine}:${name}:`)) grants.delete(k);
    },
    setPassword: async (name, password) => { passwords.push(`${engine}:${name}:${password}`); },
    accessOf: async (user, databases) => databases
      .map((database) => ({ database, role: grants.get(`${engine}:${user}:${database}`) }))
      .filter((a): a is { database: string; role: AccessRole } => !!a.role),
    grant: async (user, database, role) => { grants.set(`${engine}:${user}:${database}`, role); },
    revoke: async (user, database) => { grants.delete(`${engine}:${user}:${database}`); },
    listRows: (database, q) => appRows.list(database, q),
    getRow: (database, table, columns, where) => appRows.get(database, table, columns, where),
    insertRow: (database, table, values, back) => appRows.insert(database, table, values, back),
    updateRow: (database, table, values, where, back) => appRows.update(database, table, values, where, back),
    deleteRow: (database, table, where) => appRows.remove(database, table, where),
    setLinks: (database, table, here, id, there, ids) => appRows.setLinks(database, table, here, id, there, ids),
    close: async () => {},
  });

  before(async () => {
    live = { postgres: ['postgres', 'pamela', 'made_by_hand'], mariadb: ['mysql', 'pamela'] };
    schemas = {
      postgres: memorySchemas('postgres', { made_by_hand: seedTables() }),
      mariadb: memorySchemas('mariadb', {}),
    };
    liveUsers = { postgres: ['postgres', 'pamela'], mariadb: ['root', 'pamela'] };
    helper = createPammyDbServer(
      { postgres: stub('postgres'), mariadb: stub('mariadb') },
      (line) => asked.push(line),
    );
    await new Promise<void>((r) => helper.listen(join(dir, 'pammydb.sock'), r));
    // The gate, because the panel pushes it a catalog whenever what programs
    // could read changes (slice 9) -- and refuses loudly when it cannot, so a
    // missing gate here would fail every one of these tests rather than
    // quietly leaving the two out of step.
    gate = await newGate(await gatePg(), () => clock);
    gateAdmin = createGateAdminServer(gate, () => clock);
    await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
    const m = await createUser(db, clock, COMMAND_LINE, 'dbboss', 'DB Boss', 'manager');
    assert.equal((await boss.useInvite((await createInvite(db, clock, COMMAND_LINE, m)).token)).status, 200);
    const u = await createUser(db, clock, COMMAND_LINE, 'dbmember', 'DB Member', 'member', MEMBER);
    assert.equal((await member.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => helper.close(() => r()));
    await new Promise<void>((r) => gateAdmin.close(() => r()));
    await gate.db.end({ timeout: 2 });
  });

  it('is the account manager\'s, and nobody else\'s', async () => {
    assert.equal((await new Browser('203.0.113.142').get('/api/databases')).status, 401);
    assert.equal((await member.get('/api/databases')).status, 404);
    assert.equal((await member.post('/api/databases', { engine: 'postgres', name: 'sneaky' })).status, 404);
    assert.equal((await boss.get('/api/databases')).status, 200);
  });

  it('shows what the engines have, and marks what it will not touch', async () => {
    const r = await boss.get('/api/databases');
    const by = (n: string, e = 'postgres') => r.json.databases.find((d: { name: string; engine: string }) => d.name === n && d.engine === e);
    assert.deepEqual(r.json.engines.map((e: { ok: boolean }) => e.ok), [true, true]);
    assert.equal(by('postgres').system, true);
    assert.equal(by('mysql', 'mariadb').system, true);
    assert.equal(by('pamela').protectedName, true);
    assert.equal(by('pamela').system, false, 'hers is not the server\'s own');
    assert.equal(by('made_by_hand').managed, false);
    assert.equal(by('made_by_hand').live, true);
  });

  it('makes one, remembers it, and says so in the activity log', async () => {
    const made = await boss.post('/api/databases', { engine: 'postgres', name: 'family_recipes', displayName: 'Recipes' });
    assert.equal(made.status, 200);
    assert.ok(live.postgres.includes('family_recipes'), 'the helper really made it');
    const r = await boss.get('/api/databases');
    const card = r.json.databases.find((d: { name: string }) => d.name === 'family_recipes');
    assert.equal(card.managed, true);
    assert.equal(card.displayName, 'Recipes');
    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'database-created');
    assert.match(log.json.entries[0].target, /Postgres: family_recipes/);
  });

  it('explains a name the database would not take, and makes nothing', async () => {
    for (const name of ['My Recipes', '2026', 'recipes-2026', '']) {
      const r = await boss.post('/api/databases', { engine: 'postgres', name });
      assert.equal(r.status, 400, name);
      assert.ok(r.json.message.length > 10, `${name}: ${r.json.message}`);
    }
    assert.equal((await boss.post('/api/databases', { engine: 'sqlite', name: 'ok_name' })).status, 400);
    assert.deepEqual(live.postgres.filter((n) => n !== 'postgres' && n !== 'pamela' && n !== 'made_by_hand'), ['family_recipes']);
  });

  it('never makes or deletes the ones it does not own', async () => {
    assert.equal((await boss.post('/api/databases', { engine: 'postgres', name: 'pamela' })).status, 400);
    assert.equal((await boss.post('/api/databases', { engine: 'mariadb', name: 'mysql' })).status, 400);
    // and the helper refuses again even when the panel is asked directly
    const r = await boss.post('/api/databases/postgres/pamela/delete', { confirm: 'pamela' });
    assert.equal(r.status, 403);
    assert.ok(live.postgres.includes('pamela'), 'hers is still there');
  });

  it('adopts one she made herself, including the one that came with her account', async () => {
    assert.equal((await boss.post('/api/databases/postgres/made_by_hand/adopt', {})).status, 200);
    assert.equal((await boss.post('/api/databases/postgres/pamela/adopt', { displayName: 'My things' })).status, 200);
    const r = await boss.get('/api/databases');
    const by = (n: string) => r.json.databases.find((d: { name: string; engine: string }) => d.name === n && d.engine === 'postgres');
    assert.equal(by('made_by_hand').managed, true);
    assert.equal(by('pamela').managed, true);
    assert.equal(by('pamela').displayName, 'My things');
    // ...but adopting never lets it be deleted
    assert.equal((await boss.post('/api/databases/postgres/pamela/delete', { confirm: 'pamela' })).status, 403);
    // adopting twice is not an error
    assert.equal((await boss.post('/api/databases/postgres/made_by_hand/adopt', {})).status, 200);
  });

  it('will not adopt one that is not there, or the server\'s own', async () => {
    assert.equal((await boss.post('/api/databases/postgres/nothing_here/adopt', {})).status, 404);
    assert.equal((await boss.post('/api/databases/mariadb/mysql/adopt', {})).status, 403);
  });

  it('renames the app, and clears the name again', async () => {
    assert.equal((await boss.post('/api/databases/postgres/family_recipes/settings', { displayName: '  Family   Recipes ' })).status, 200);
    let r = await boss.get('/api/databases/postgres/family_recipes');
    assert.equal(r.json.displayName, 'Family Recipes', 'the spaces are tidied');
    assert.equal((await boss.post('/api/databases/postgres/family_recipes/settings', { displayName: '' })).status, 200);
    r = await boss.get('/api/databases/postgres/family_recipes');
    assert.equal(r.json.displayName, '');
    assert.equal((await boss.post('/api/databases/postgres/family_recipes/settings', { displayName: 'x'.repeat(61) })).status, 400);
    assert.equal((await boss.post('/api/databases/postgres/nothing_here/settings', { displayName: 'No' })).status, 404);
  });

  it('gives one database its size and table count', async () => {
    const r = await boss.get('/api/databases/postgres/family_recipes');
    assert.equal(r.status, 200);
    assert.equal(r.json.bytes, 4096);
    assert.equal(r.json.tables, 0);
    assert.equal((await boss.get('/api/databases/postgres/NOPE')).status, 404);
    assert.equal((await boss.get('/api/databases/sqlite/family_recipes')).status, 404);
  });

  it('stops looking after one without touching it', async () => {
    assert.equal((await boss.post('/api/databases/postgres/made_by_hand/unmanage', {})).status, 200);
    const r = await boss.get('/api/databases');
    const card = r.json.databases.find((d: { name: string }) => d.name === 'made_by_hand');
    assert.equal(card.managed, false);
    assert.equal(card.live, true, 'the database itself is untouched');
    assert.ok(live.postgres.includes('made_by_hand'));
    assert.equal((await boss.post('/api/databases/postgres/made_by_hand/unmanage', {})).status, 404, 'twice is nothing to stop');
  });

  it('deletes one only with the name typed out and a passkey just now', async () => {
    assert.equal((await boss.post('/api/databases/postgres/family_recipes/delete', {})).status, 400);
    assert.equal((await boss.post('/api/databases/postgres/family_recipes/delete', { confirm: 'family_recipe' })).status, 400);
    assert.ok(live.postgres.includes('family_recipes'), 'nothing went yet');
    // the passkey check has to be recent (D20)
    advance(11 * 60);
    const stale = await boss.post('/api/databases/postgres/family_recipes/delete', { confirm: 'family_recipes' });
    assert.equal(stale.status, 403);
    assert.equal(stale.json.error, 'reauth-required');
    await boss.confirm();
    const gone = await boss.post('/api/databases/postgres/family_recipes/delete', { confirm: 'family_recipes' });
    assert.equal(gone.status, 200);
    assert.ok(!live.postgres.includes('family_recipes'), 'the helper really dropped it');
    const r = await boss.get('/api/databases');
    assert.ok(!r.json.databases.some((d: { name: string }) => d.name === 'family_recipes'), 'and the panel forgot it');
    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'database-deleted');
  });

  it('says so when one it remembers is no longer on the server', async () => {
    assert.equal((await boss.post('/api/databases/mariadb/notes/adopt', {})).status, 404);
    live.mariadb.push('notes');
    assert.equal((await boss.post('/api/databases/mariadb/notes/adopt', {})).status, 200);
    live.mariadb = live.mariadb.filter((n) => n !== 'notes');     // as if she dropped it in her own client
    const r = await boss.get('/api/databases');
    const card = r.json.databases.find((d: { name: string }) => d.name === 'notes');
    assert.equal(card.managed, true);
    assert.equal(card.live, false);
  });

  it('shows one engine when the other is not answering', async () => {
    down = 'mariadb';
    try {
      const r = await boss.get('/api/databases');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.engines.map((e: { engine: string; ok: boolean }) => [e.engine, e.ok]), [['mariadb', false], ['postgres', true]]);
      assert.match(r.json.engines[0].message, /not answering/);
      // the engine that answered is shown in full
      assert.ok(r.json.databases.some((d: { engine: string; live: boolean | null }) => d.engine === 'postgres' && d.live === true));
      // and a MariaDB database it remembers is "we can't see it", never "gone":
      // the server being asleep is not the same as her data being deleted
      const notes = r.json.databases.find((d: { name: string }) => d.name === 'notes');
      assert.equal(notes.engine, 'mariadb');
      assert.equal(notes.live, null);
      assert.equal(notes.managed, true);
    } finally {
      down = null;
    }
  });

  // ---------------------------------------------------------------- her database users
  // The routes, over a stubbed helper. What the GRANTs really mean on an engine
  // is test/pammydb.test.ts's job, against real ones.

  it('the users page is the account manager\'s too', async () => {
    assert.equal((await new Browser('203.0.113.143').get('/api/databases/users')).status, 401);
    assert.equal((await member.get('/api/databases/users')).status, 404);
    assert.equal((await member.post('/api/databases/users', { engine: 'postgres', name: 'sneaky' })).status, 404);
    assert.equal((await boss.get('/api/databases/users')).status, 200);
  });

  it('makes a login, shows the password once, and never again', async () => {
    const made = await boss.post('/api/databases/users', { engine: 'postgres', name: 'recipes_app', note: 'the recipes app' });
    assert.equal(made.status, 200);
    assert.match(made.json.password, /^[A-Za-z0-9]{32}$/);
    assert.ok(liveUsers.postgres.includes('recipes_app'), 'the helper really made it');

    const r = await boss.get('/api/databases/users');
    const card = r.json.users.find((u: { name: string }) => u.name === 'recipes_app');
    assert.equal(card.known, true);
    assert.equal(card.note, 'the recipes app');
    assert.equal(card.engineName, 'Postgres');
    // nothing anywhere hands it back: not the list, not the login's own page
    assert.ok(!JSON.stringify(r.json).includes(made.json.password), 'the list is not carrying it');
    const one = await boss.get('/api/databases/users/postgres/recipes_app');
    assert.ok(!JSON.stringify(one.json).includes(made.json.password), 'nor its page');

    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'db-user-created');
    assert.ok(!JSON.stringify(log.json).includes(made.json.password), 'nor the activity log');
  });

  it('a new login reaches nothing until she says so', async () => {
    const r = await boss.get('/api/databases/users/postgres/recipes_app');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.access, []);
    // and it is offered her Postgres databases, not her MariaDB ones
    assert.ok(r.json.databases.every((d: { engine: string }) => d.engine === 'postgres'));
    assert.ok(!r.json.databases.some((d: { system: boolean }) => d.system), 'never the server\'s own');
  });

  it('explains a name the server would not take, and makes nothing', async () => {
    for (const name of ['Recipes App', '2026', 'recipes-app', '']) {
      const r = await boss.post('/api/databases/users', { engine: 'postgres', name });
      assert.equal(r.status, 400, name);
      assert.ok(r.json.message.length > 10, `${name}: ${r.json.message}`);
    }
    // and never one of the server's own
    for (const [engine, name] of [['postgres', 'postgres'], ['postgres', 'pamela'], ['mariadb', 'root'], ['postgres', 'pg_monitor']]) {
      const r = await boss.post('/api/databases/users', { engine, name });
      assert.equal(r.status, 400, `${engine} ${name}`);
    }
    assert.deepEqual(liveUsers.postgres, ['postgres', 'pamela', 'recipes_app']);
  });

  it('grants one of the four, and reads it back from the engine', async () => {
    // a database of its own: family_recipes was deleted a few tests ago
    assert.equal((await boss.post('/api/databases', { engine: 'postgres', name: 'shop' })).status, 200);
    const r = await boss.post('/api/databases/users/postgres/recipes_app/access',
      { database: 'shop', role: 'write' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.access, [{ database: 'shop', role: 'write', roleName: 'Read & write' }]);
    assert.equal(grants.get('postgres:recipes_app:shop'), 'write');

    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'db-access-granted');
    assert.match(log.json.entries[0].detail, /Read & write on shop/);
  });

  it('takes access away again', async () => {
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/access',
      { database: 'shop', role: 'none' })).status, 200);
    assert.equal(grants.has('postgres:recipes_app:shop'), false);
    assert.equal((await boss.get('/api/activity')).json.entries[0].action, 'db-access-revoked');
  });

  it('refuses a role it does not have, and a database on the other engine', async () => {
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/access',
      { database: 'shop', role: 'superuser' })).status, 400);
    // `notes` is a MariaDB database: a Postgres login cannot be given it
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/access',
      { database: 'notes', role: 'read' })).status, 404);
    // nor the server's own
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/access',
      { database: 'postgres', role: 'read' })).status, 404);
    assert.equal(grants.size, 0);
  });

  it('writes a note on a login it did not make', async () => {
    liveUsers.mariadb.push('backup_job');
    const r = await boss.post('/api/databases/users/mariadb/backup_job/note', { note: 'the nightly backup' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.note, 'the nightly backup');
    assert.equal(r.json.user.known, true);
  });

  it('a new password replaces the old one and is shown once', async () => {
    const r = await boss.post('/api/databases/users/postgres/recipes_app/password', {});
    assert.equal(r.status, 200);
    assert.match(r.json.password, /^[A-Za-z0-9]{32}$/);
    assert.ok(passwords.some((p) => p === `postgres:recipes_app:${r.json.password}`), 'the helper was given it');
    assert.equal((await boss.get('/api/activity')).json.entries[0].action, 'db-user-password-reset');
  });

  it('wants the name typed out before it removes a login', async () => {
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/delete', { confirm: 'recipes' })).status, 400);
    assert.ok(liveUsers.postgres.includes('recipes_app'), 'still there');
    assert.equal((await boss.post('/api/databases/users/postgres/recipes_app/delete', { confirm: 'recipes_app' })).status, 200);
    assert.ok(!liveUsers.postgres.includes('recipes_app'));
    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'db-user-deleted');
  });

  it('shows who can reach one database, from its own side', async () => {
    liveUsers.postgres.push('shopfront');
    grants.set('postgres:shopfront:shop', 'read');
    const r = await boss.get('/api/databases/postgres/shop/users');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.users, [{ name: 'shopfront', note: '', serverWide: false, role: 'read', roleName: 'Read only' }]);
    // logins on this engine with no access yet, for the Grant access list
    assert.ok(r.json.others.includes('backup_job') === false, 'the other engine\'s logins are not offered');
    grants.clear();
    liveUsers.postgres = liveUsers.postgres.filter((n) => n !== 'shopfront');
  });

  it('never calls a login gone when its engine is only asleep', async () => {
    liveUsers.mariadb.push('sleepy');
    await boss.post('/api/databases/users/mariadb/sleepy/note', { note: 'x' });
    down = 'mariadb';
    try {
      const r = await boss.get('/api/databases/users');
      assert.equal(r.status, 200);
      const sleepy = r.json.users.find((u: { name: string }) => u.name === 'sleepy');
      assert.equal(sleepy.live, null, 'unknown, never gone');
      assert.ok(r.json.users.some((u: { engine: string; live: boolean | null }) => u.engine === 'postgres' && u.live === true));
    } finally {
      down = null;
    }
  });

  // ---------------------------------------------------------------- the shape inside one
  // The designer's routes (docs/databases-plan.md 8 and 10), over a helper whose
  // schema is kept in memory (test/studio-stub.ts). Whether an engine would
  // accept a step is test/pammydb.test.ts's business; this is about what the
  // panel keeps, what it refuses, and what it tells her.

  const schemaOf = async (db = 'design_me') => (await boss.get(`/api/databases/postgres/${db}/schema`)).json;
  const draw = async (tables: unknown[], db = 'design_me') => {
    const view = await schemaOf(db);
    return boss.post(`/api/databases/postgres/${db}/schema/draft`,
      { draft: { ...view.draft, tables }, basedOn: view.currentHash });
  };

  it('reads the tables back, and is the account manager\'s alone', async () => {
    // its own database, set up here rather than in a before() so the dashboard
    // tests above still see exactly the shelf they expect
    live.postgres.push('design_me', 'not_looked_after');
    schemas.postgres.set('design_me', seedTables());
    assert.equal((await boss.post('/api/databases/postgres/design_me/adopt', {})).status, 200);

    assert.equal((await member.get('/api/databases/postgres/design_me/schema')).status, 404);
    assert.equal((await new Browser('203.0.113.144').get('/api/databases/postgres/design_me/schema')).status, 401);
    const r = await boss.get('/api/databases/postgres/design_me/schema');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.current.tables.map((t: { name: string }) => t.name), ['recipes']);
    assert.equal(r.json.hasDraft, false);
    assert.equal(r.json.plan.steps.length, 0, 'no drawing means nothing to apply');
    assert.match(r.json.currentHash, /^[0-9a-f]{32}$/);
  });

  it('will not design a database the panel is not looking after', async () => {
    const r = await boss.get('/api/databases/postgres/not_looked_after/schema');
    assert.equal(r.status, 404);
    assert.match(r.json.message, /not looking after/);
  });

  it('keeps a drawing without touching the database', async () => {
    const before = await schemaOf();
    const saved = await draw([...before.draft.tables, {
      name: 'notes', columns: [{ name: 'id', type: 'integer', required: true, identity: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    }]);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.hasDraft, true);
    assert.equal(saved.json.plan.steps.length, 1);
    assert.match(saved.json.plan.changes[0].line, /New table notes/);
    // the database itself has not moved
    assert.deepEqual(saved.json.current.tables.map((t: { name: string }) => t.name), ['recipes']);
    assert.equal(saved.json.currentHash, before.currentHash);
  });

  it('shows the statements the helper would run, under Advanced', async () => {
    const r = await boss.get('/api/databases/postgres/design_me/schema/review');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sql, ['CREATE TABLE "notes" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL, PRIMARY KEY ("id"))']);
  });

  it('refuses a drawing the engine would refuse, before it is kept', async () => {
    const bad = await draw([{ name: 'Nope', columns: [{ name: 'id', type: 'integer', required: true }], primaryKey: [], uniques: [], foreignKeys: [], indexes: [] }]);
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /lowercase letters/);
    // and the drawing that was there is untouched
    assert.equal((await schemaOf()).plan.steps.length, 1);
  });

  it('refuses a drawing that does not say which reading it came from', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/draft', { draft: { tables: [] } });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /which version/);
  });

  it('applies it, tells her how much went in, and then has nothing left to do', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/apply', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, 1);
    assert.equal(r.json.failed, null);
    assert.equal(r.json.hasDraft, false, 'the drawing is spent');
    assert.deepEqual(r.json.current.tables.map((t: { name: string }) => t.name), ['notes', 'recipes']);
    const log = await boss.get('/api/activity');
    assert.equal(log.json.entries[0].action, 'schema-applied');
    assert.match(log.json.entries[0].detail, /1 of 1 change/);
  });

  it('has nothing to apply when the drawing and the database agree', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/apply', {});
    assert.equal(r.status, 400);
    assert.match(r.json.message, /nothing to apply/);
  });

  it('asks for a passkey tap before anything that deletes', async () => {
    const view = await schemaOf();
    assert.equal((await draw(view.draft.tables.filter((t: { name: string }) => t.name !== 'notes'))).status, 200);
    // the passkey check has to be recent, the same as deleting a database (D20)
    advance(11 * 60);
    const plain = await boss.post('/api/databases/postgres/design_me/schema/apply', {});
    assert.equal(plain.status, 403);
    assert.equal(plain.json.error, 'reauth-required');
    // still there: a refusal is not a half-apply
    assert.deepEqual((await schemaOf()).current.tables.map((t: { name: string }) => t.name), ['notes', 'recipes']);
    assert.equal((await boss.confirm()).status, 200);
    const done = await boss.post('/api/databases/postgres/design_me/schema/apply', {});
    assert.equal(done.status, 200);
    assert.equal(done.json.applied, 1);
    assert.deepEqual(done.json.current.tables.map((t: { name: string }) => t.name), ['recipes']);
  });

  it('will not apply a drawing built on a reading that has gone stale', async () => {
    const view = await schemaOf();
    assert.equal((await draw([...view.draft.tables, {
      name: 'later', columns: [{ name: 'id', type: 'integer', required: true }], primaryKey: [], uniques: [], foreignKeys: [], indexes: [],
    }])).status, 200);
    // someone else changes the database underneath her
    schemas.postgres.set('design_me', [...schemas.postgres.get('design_me').tables, {
      name: 'from_somewhere_else',
      columns: [{ name: 'id', type: 'integer', required: true, default: null, sqlType: 'integer' }],
      primaryKey: [], uniques: [], foreignKeys: [], indexes: [],
    }]);
    const view2 = await schemaOf();
    assert.equal(view2.drift, true, 'she is told, rather than it being quietly rebased');
    assert.equal(view2.hasDraft, true, 'and her drawing is still there');
    const r = await boss.post('/api/databases/postgres/design_me/schema/apply', {});
    assert.equal(r.status, 409);
    assert.match(r.json.message, /changed since you started/);
  });

  it('throws the drawing away and goes back to the database', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/discard', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.hasDraft, false);
    assert.equal(r.json.drift, false);
    assert.equal(r.json.plan.steps.length, 0);
  });

  // ------------------------------------------------- where the rectangles are
  // Positions are not part of the drawing (src/studio/layout.ts): they save on
  // their own, and Discard must not take them with it.

  it('gives every table somewhere to be, even on a first visit', async () => {
    const view = await schemaOf();
    assert.deepEqual(Object.keys(view.layout.tables), view.draft.tables.map((x: { name: string }) => x.name),
      'the canvas never has to guess where to draw one');
  });

  it('remembers where she dragged a table to', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/layout',
      { layout: { tables: { recipes: { x: 120, y: 340 } } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.layout.tables.recipes, { x: 120, y: 340 });
    assert.deepEqual((await schemaOf()).layout.tables.recipes, { x: 120, y: 340 }, 'and still there on the next visit');
  });

  it('throwing the drawing away does NOT move her tables back', async () => {
    // the whole reason positions live beside the draft rather than inside it:
    // "throw these changes away" is about the database, not about her desk
    await draw([...(await schemaOf()).draft.tables, {
      name: 'notes', columns: [{ name: 'id', type: 'integer', required: true, identity: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    }]);
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/discard', {})).status, 200);
    assert.deepEqual((await schemaOf()).layout.tables.recipes, { x: 120, y: 340 },
      'the drawing went back to the database; where she put recipes did not');
  });

  it('tidying up puts them back in rows', async () => {
    const before = await schemaOf();
    const r = await boss.post('/api/databases/postgres/design_me/schema/tidy', {});
    assert.equal(r.status, 200);
    // reading order: the first table in the database starts the first row, and
    // nothing is left where she had dragged it
    const names = before.draft.tables.map((x: { name: string }) => x.name);
    assert.deepEqual(r.json.layout.tables[names[0]!], { x: 0, y: 0 });
    assert.deepEqual((await schemaOf()).layout.tables, r.json.layout.tables, 'and that is what was written down');
    assert.notDeepEqual(r.json.layout.tables.recipes, { x: 120, y: 340 }, 'recipes did not stay where it was dragged');
  });

  it('a position for a table that is not there is dropped, not stored for ever', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/schema/layout',
      { layout: { tables: { recipes: { x: 5, y: 5 }, ghost: { x: 9, y: 9 }, 'not a name': { x: 1, y: 1 } } } });
    assert.equal(r.status, 200);
    // what comes back is every table in the drawing, placed -- but `ghost` is
    // not one of them, and never reaches the stored document
    assert.ok(!('ghost' in r.json.layout.tables), 'a table that is not there gets no position');
    assert.ok(!('not a name' in r.json.layout.tables));
    assert.deepEqual(Object.keys(r.json.layout.tables).sort(),
      (await schemaOf()).draft.tables.map((x: { name: string }) => x.name).sort());
    assert.deepEqual(r.json.layout.tables.recipes, { x: 5, y: 5 }, 'and the real one was kept');
  });

  it('the positions are the account manager\'s alone, like the rest of it', async () => {
    assert.equal((await member.post('/api/databases/postgres/design_me/schema/layout', { layout: { tables: {} } })).status, 404);
    assert.equal((await member.post('/api/databases/postgres/design_me/schema/tidy', {})).status, 404);
    assert.equal((await new Browser('203.0.113.144').post('/api/databases/postgres/design_me/schema/tidy', {})).status, 401);
  });

  // ------------------------------------------------------------ relationships
  // The gesture, over the routes (docs/databases-plan.md 7). What a pair may be
  // is test/studio.test.ts's business; this is what the panel keeps and what it
  // tells her when it will not.

  it('connects two tables, and reads it back as one relationship', async () => {
    await draw([...(await schemaOf()).draft.tables, {
      name: 'notes', columns: [{ name: 'id', type: 'integer', required: true, identity: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    }]);
    const r = await boss.post('/api/databases/postgres/design_me/schema/relationship', {
      from: { table: 'recipes', column: 'id' }, to: { table: 'notes' },
      kind: 'one-to-many', onDelete: 'restrict',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.relationships.map((x: { line: string }) => x.line), ['One recipe has many notes']);
    const notes = r.json.draft.tables.find((x: { name: string }) => x.name === 'notes');
    assert.ok(notes.columns.some((c: { name: string }) => c.name === 'recipe_id'), 'the field was added for her');
    assert.ok(r.json.plan.changes.some((c: { line: string }) => /recipe_id/.test(c.line)), 'and it is on the list of changes');
  });

  it('says why in her words when the pair could not work', async () => {
    const bad = await boss.post('/api/databases/postgres/design_me/schema/relationship', {
      from: { table: 'recipes', column: 'title' }, to: { table: 'notes' },
      kind: 'one-to-many', onDelete: 'restrict',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /cannot say which row is meant|must-be-different/);
    // and nothing was written down
    assert.equal((await schemaOf()).relationships.length, 1, 'the refusal left the drawing alone');
  });

  it('a many-to-many builds the connecting table, and disconnecting removes it', async () => {
    const before = await schemaOf();
    const r = await boss.post('/api/databases/postgres/design_me/schema/relationship', {
      from: { table: 'recipes', column: 'id' }, to: { table: 'notes' },
      kind: 'many-to-many', onDelete: 'cascade', junction: 'recipe_notes',
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.draft.tables.some((x: { name: string }) => x.name === 'recipe_notes'));
    const m2m = r.json.relationships.find((x: { junction: string | null }) => x.junction === 'recipe_notes');
    assert.ok(m2m, 'one relationship, through a table she did not have to think about');
    assert.equal(m2m.line, 'Many recipes have many notes');
    assert.equal(before.draft.tables.length + 1, r.json.draft.tables.length);

    const gone = await boss.post('/api/databases/postgres/design_me/schema/relationship/delete', { at: m2m.at });
    assert.equal(gone.status, 200);
    assert.ok(!gone.json.draft.tables.some((x: { name: string }) => x.name === 'recipe_notes'),
      'the table it invented goes with it');
  });

  it('changes only what happens on delete, without rebuilding anything', async () => {
    const before = (await schemaOf()).relationships.find((x: { to: string }) => x.to === 'notes');
    assert.equal(before.onDelete, 'restrict');
    const r = await boss.post('/api/databases/postgres/design_me/schema/relationship/on-delete',
      { at: before.at, onDelete: 'cascade' });
    assert.equal(r.status, 200);
    assert.equal(r.json.relationships.find((x: { to: string }) => x.to === 'notes').onDelete, 'cascade');
    // drawing it again would have been refused as a duplicate, which is why
    // this is its own route
    const dup = await boss.post('/api/databases/postgres/design_me/schema/relationship', {
      from: { table: 'recipes', column: 'id' }, to: { table: 'notes' }, kind: 'one-to-many', onDelete: 'cascade',
    });
    assert.equal(dup.status, 400);
    assert.match(dup.json.message, /already points at something/);
    await boss.post('/api/databases/postgres/design_me/schema/relationship/on-delete',
      { at: before.at, onDelete: 'restrict' });
  });

  it('remembers whether connecting tables are tucked away', async () => {
    assert.equal((await schemaOf()).layout.manyToMany, 'simple', 'tucked away to begin with');
    const r = await boss.post('/api/databases/postgres/design_me/schema/layout', { manyToMany: 'expanded' });
    assert.equal(r.status, 200);
    assert.equal(r.json.layout.manyToMany, 'expanded');
    // the switch does not have to send every position back with it
    assert.deepEqual((await schemaOf()).layout.tables, r.json.layout.tables, 'and the positions are untouched');
    assert.equal((await schemaOf()).layout.manyToMany, 'expanded');
    await boss.post('/api/databases/postgres/design_me/schema/layout', { manyToMany: 'simple' });
  });

  it('the connections are the account manager\'s alone', async () => {
    assert.equal((await member.post('/api/databases/postgres/design_me/schema/relationship', {})).status, 404);
    assert.equal((await member.post('/api/databases/postgres/design_me/schema/relationship/delete', {})).status, 404);
    assert.equal((await new Browser('203.0.113.144').post('/api/databases/postgres/design_me/schema/relationship', {})).status, 401);
  });

  // -------------------------------------------------------- the Application tab
  // What her tables mean (docs/databases-plan.md 11). Inference is
  // test/studio.test.ts's business; this is what the routes keep, what they
  // refuse, and that none of it is a change to her database.

  const appOf = async (db = 'design_me') => (await boss.get(`/api/databases/postgres/${db}/app`)).json;

  it('offers every table, and manages the ordinary ones', async () => {
    const a = await appOf();
    const recipes = a.resources.find((r: { table: string }) => r.table === 'recipes');
    assert.ok(recipes, 'the table is offered');
    assert.equal(recipes.enabled, true);
    assert.equal(recipes.decided, false, 'the panel is guessing until she says');
    assert.equal(recipes.singular, 'Recipe');
    assert.equal(recipes.plural, 'Recipes');
  });

  it('remembers what she says, and only what she says', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/app/recipes/settings',
      { singular: 'Dish', plural: 'Dishes', can: { delete: false } });
    assert.equal(r.status, 200);
    const recipes = r.json.resources.find((x: { table: string }) => x.table === 'recipes');
    assert.equal(recipes.singular, 'Dish');
    assert.equal(recipes.can.delete, false);
    assert.equal(recipes.can.edit, true, 'the rest is left alone');
    assert.equal(recipes.decided, false, 'naming it is not the same as saying whether to manage it');

    // and the words survive the next visit
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'recipes').plural, 'Dishes');
  });

  it('will not let her hide her way to a page of blanks', async () => {
    const named = (await appOf()).resources.find((x: { table: string }) => x.table === 'recipes').titleField;
    const bad = await boss.post(`/api/databases/postgres/design_me/app/recipes/fields/${named}/settings`, { exposed: false });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /named by|leave a list of blanks/);
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'recipes')
      .fields.find((f: { name: string }) => f.name === named).exposed, true, 'and nothing was written down');
  });

  it('hides a field, and a hidden field cannot then be searched', async () => {
    const ok = await boss.post('/api/databases/postgres/design_me/app/recipes/fields/servings/settings',
      { exposed: false, label: 'How many it feeds' });
    assert.equal(ok.status, 200);
    const f = () => appOf().then((a) => a.resources.find((x: { table: string }) => x.table === 'recipes')
      .fields.find((y: { name: string }) => y.name === 'servings'));
    assert.equal((await f()).exposed, false);
    assert.equal((await f()).label, 'How many it feeds');
    const no = await boss.post('/api/databases/postgres/design_me/app/recipes/fields/servings/settings', { searchable: true });
    assert.equal(no.status, 400);
    assert.match(no.json.message, /hidden cannot be searched/);
  });

  it('starting again forgets her words and goes back to the guess', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/app/recipes/forget', {});
    assert.equal(r.status, 200);
    const recipes = r.json.resources.find((x: { table: string }) => x.table === 'recipes');
    assert.equal(recipes.singular, 'Recipe', 'back to what the panel works out');
    assert.equal(recipes.can.delete, true);
    assert.equal(recipes.fields.find((f: { name: string }) => f.name === 'servings').exposed, true,
      'the fields she had changed are forgotten too');
  });

  it('a table that is not there is not a page', async () => {
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/nope/settings', { singular: 'X' })).status, 404);
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/recipes/fields/nope/settings', { exposed: false })).status, 404);
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/Not_A_Name/settings', {})).status, 404);
  });

  it('a table that is applied away takes what it meant with it', async () => {
    // docs/studio-plan.md, "re-run after every Apply": the panel must not hold
    // an opinion about a table that is not there any more.
    const start = await schemaOf();
    const spare = {
      name: 'scribbles', columns: [{ name: 'id', type: 'integer', required: true, identity: true },
        { name: 'note', type: 'short_text', length: 80, required: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    };
    await draw([...start.draft.tables, spare]);
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    // a word the panel would never guess, so the assertion below can tell her
    // override from inference ('scribbles' infers to 'Scribble' by itself)
    await boss.post('/api/databases/postgres/design_me/app/scribbles/settings', { singular: 'Doodle', enabled: true });
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'scribbles').singular, 'Doodle');

    // now take the table away for real
    const now = await schemaOf();
    await draw(now.draft.tables.filter((x: { name: string }) => x.name !== 'scribbles'));
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    const after = await appOf();
    assert.ok(!after.resources.some((x: { table: string }) => x.table === 'scribbles'), 'gone from the app');
    // and if she makes a table of the same name again, it is proposed afresh
    // rather than arriving with her old words already on it
    await draw([...(await schemaOf()).draft.tables, spare]);
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    const again = (await appOf()).resources.find((x: { table: string }) => x.table === 'scribbles');
    assert.equal(again.singular, 'Scribble', 'the panel guesses again instead of remembering "Doodle"');
    assert.equal(again.decided, false);
  });

  it('a table that is renamed keeps what she said about it, and its place on the canvas', async () => {
    await boss.post('/api/databases/postgres/design_me/app/scribbles/settings', { singular: 'Doodle' });
    await boss.post('/api/databases/postgres/design_me/app/scribbles/fields/note/settings', { label: 'What it says' });
    const start = await schemaOf();
    const renamed = start.draft.tables.map((x: { name: string; columns: { name: string }[] }) => (x.name === 'scribbles'
      ? { ...x, name: 'doodles', was: 'scribbles', columns: x.columns
        .map((c) => (c.name === 'note' ? { ...c, name: 'words', was: 'note' } : c)) }
      : x));
    const saved = await boss.post('/api/databases/postgres/design_me/schema/draft',
      { draft: { ...start.draft, tables: renamed }, basedOn: start.currentHash, renamed: { from: 'scribbles', to: 'doodles', at: { x: 777, y: 55 } } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.layout.tables.doodles, { x: 777, y: 55 }, 'drawn where it was, not placed afresh');
    assert.equal(saved.json.layout.tables.scribbles, undefined);

    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    const doodles = (await appOf()).resources.find((x: { table: string }) => x.table === 'doodles');
    assert.equal(doodles.singular, 'Doodle', 'her word followed the table to its new name');
    assert.equal(doodles.fields.find((f: { name: string }) => f.name === 'words').label, 'What it says', 'and the field\'s');

    // and back, so the tests after this one find scribbles as they left it
    const now = await schemaOf();
    await draw(now.draft.tables.map((x: { name: string; columns: { name: string }[] }) => (x.name === 'doodles'
      ? { ...x, name: 'scribbles', was: 'doodles', columns: x.columns
        .map((c) => (c.name === 'words' ? { ...c, name: 'note', was: 'words' } : c)) }
      : x)));
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'scribbles').singular, 'Doodle');
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/scribbles/forget', {})).status, 200);
  });

  it('what a table means is the account manager\'s alone', async () => {
    assert.equal((await member.get('/api/databases/postgres/design_me/app')).status, 404);
    assert.equal((await member.post('/api/databases/postgres/design_me/app/recipes/settings', {})).status, 404);
    assert.equal((await new Browser('203.0.113.144').get('/api/databases/postgres/design_me/app')).status, 401);
  });

  // ------------------------------------------------------- the generated app
  // The pages her app is made of (docs/databases-plan.md 11.6-11.8). What the
  // SQL does is test/pammydb.test.ts's business against real engines; this is
  // the window and the abilities -- what may be read, what may be written, and
  // what is refused.

  const appList = (q = '') => boss.get(`/api/app/postgres/design_me/recipes${q}`);

  it('switching the app on needs something to manage, and a passkey just now', async () => {
    // nothing ticked yet on a fresh database
    assert.equal((await boss.post('/api/databases/postgres/design_me/deactivate', {})).status, 200);
    const r = await boss.post('/api/databases/postgres/design_me/activate', {});
    assert.equal(r.status, 200, 'recipes is managed by inference, so there is something to switch on');
    assert.equal((await boss.get('/api/databases/postgres/design_me')).json.status, 'active');
  });

  it('lists her records through the window, twenty at a time', async () => {
    appRows.set('design_me', 'recipes', Array.from({ length: 25 }, (_, i) => ({
      id: i + 1, title: `Recipe ${String(i + 1).padStart(2, '0')}`, servings: (i % 8) + 1, tags: null,
    })));
    const r = await appList();
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 25);
    assert.equal(r.json.items.length, 20, 'a page is twenty (11.7)');
    assert.equal(r.json.resource.plural, 'Recipes');
    assert.deepEqual(Object.keys(r.json.items[0]).sort(), ['id', 'servings', 'tags', 'title'],
      'everything exposed, and the key');

    const p2 = await appList('?page=2');
    assert.equal(p2.json.items.length, 5);
    assert.notDeepEqual(p2.json.items[0], r.json.items[0], 'page 2 is not page 1');
  });

  it('a hidden field is not in the list, however the request asks', async () => {
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/recipes/fields/servings/settings',
      { exposed: false })).status, 200);
    const r = await appList('?sort=servings&search=Recipe');
    assert.ok(!('servings' in r.json.items[0]), 'being in the database is not permission to read');
    assert.notEqual(r.json.resource.fields.find((f: { name: string }) => f.name === 'servings').exposed, true);
    // and it cannot be written either
    const bad = await boss.post('/api/app/postgres/design_me/recipes/new', { values: { title: 'x', servings: 2 } });
    assert.equal(bad.status, 403);
    assert.match(bad.json.message, /hidden, so it cannot be filled in/);
    await boss.post('/api/databases/postgres/design_me/app/recipes/fields/servings/settings', { exposed: true });
  });

  it('long text is not searched until she says so, and then it narrows the count', async () => {
    // `title` here is long text, which is deliberately not searched by default:
    // searching every paragraph is slow and noisy (docs/databases-plan.md 11.1)
    assert.equal((await appList('?search=Recipe%2001')).json.total, 25, 'the search was not applied');

    assert.equal((await boss.post('/api/databases/postgres/design_me/app/recipes/fields/title/settings',
      { searchable: true })).status, 200);
    const r = await appList('?search=Recipe%2001');
    assert.equal(r.json.total, 1, 'the count is the narrowed count, not the whole table');
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].title, 'Recipe 01');
  });

  it('adds, opens, changes and deletes one record', async () => {
    const made = await boss.post('/api/app/postgres/design_me/recipes/new', { values: { title: 'Pancakes', servings: 4 } });
    assert.equal(made.status, 200);
    const id = made.json.row.id;
    assert.equal(made.json.row.title, 'Pancakes');

    const one = await boss.get(`/api/app/postgres/design_me/recipes/one?id=${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.row.title, 'Pancakes');

    const saved = await boss.post('/api/app/postgres/design_me/recipes/save',
      { where: { id }, values: { title: 'Pancakes with syrup' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.row.title, 'Pancakes with syrup');

    assert.equal((await boss.post('/api/app/postgres/design_me/recipes/delete', { where: { id } })).status, 200);
    assert.equal((await boss.get(`/api/app/postgres/design_me/recipes/one?id=${id}`)).status, 404);
  });

  it('an ability that is off is refused by the server, not just hidden', async () => {
    await boss.post('/api/databases/postgres/design_me/app/recipes/settings', { can: { create: false, delete: false } });
    const no = await boss.post('/api/app/postgres/design_me/recipes/new', { values: { title: 'nope' } });
    assert.equal(no.status, 403);
    assert.match(no.json.message, /cannot be added here/);
    const nodel = await boss.post('/api/app/postgres/design_me/recipes/delete', { where: { id: 1 } });
    assert.equal(nodel.status, 403);
    assert.match(nodel.json.message, /cannot be deleted here/);
    await boss.post('/api/databases/postgres/design_me/app/recipes/settings', { can: { create: true, delete: true } });
  });

  it('a table the app does not manage has no pages at all', async () => {
    await boss.post('/api/databases/postgres/design_me/app/notes/settings', { enabled: false });
    const r = await boss.get('/api/app/postgres/design_me/notes');
    assert.equal(r.status, 404);
    assert.match(r.json.message, /not one of the tables this app manages/);
    assert.equal((await boss.get('/api/app/postgres/design_me/nope')).status, 404);
  });

  it('her records are the account manager\'s alone', async () => {
    assert.equal((await member.get('/api/app/postgres/design_me/recipes')).status, 404);
    assert.equal((await member.post('/api/app/postgres/design_me/recipes/new', { values: {} })).status, 404);
    assert.equal((await new Browser('203.0.113.144').get('/api/app/postgres/design_me/recipes')).status, 401);
  });

  // -------------------------------------------------------- letting programs in
  // The catalog push and the keys (slice 9). What the gate then DOES with a
  // catalog is test/gate.test.ts's business; this is that the panel keeps the
  // gate in step, and refuses the shapes that would be a trap.

  it('switching the app on tells the gate what it may serve', async () => {
    assert.equal((await boss.post('/api/databases/postgres/design_me/activate', {})).status, 200);
    const pushed = await handleAdmin(gate, clock, { op: 'appkeys.list', databaseId: 1 }) as { keys: unknown[] };
    assert.ok(Array.isArray(pushed.keys), 'the gate is answering about this database at all');
    // ...and it is off to the internet until she says otherwise
    const view = await appOf();
    assert.equal(view.apiRead, false);
    assert.equal(view.apiWrite, false);
  });

  it('writing without reading is not a shape she can choose', async () => {
    const bad = await boss.post('/api/databases/postgres/design_me/api', { read: false, write: true });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /has to be able to read them too/);
    assert.equal((await appOf()).apiRead, false, 'and nothing was switched on');
  });

  it('switching reading on, and then writing', async () => {
    const r = await boss.post('/api/databases/postgres/design_me/api', { read: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.apiRead, true);
    assert.equal(r.json.apiWrite, false, 'reading does not imply writing');
    assert.equal((await boss.post('/api/databases/postgres/design_me/api', { write: true })).json.apiWrite, true);
  });

  it('a key can be made, is shown once, and can be stopped', async () => {
    const made = await boss.post('/api/databases/postgres/design_me/keys', { label: 'Her website', canWrite: false });
    assert.equal(made.status, 200);
    assert.match(made.json.key, /^pammy_app_[A-Za-z0-9_-]{43}$/);
    const id = made.json.appKey.id;

    const listed = await boss.get('/api/databases/postgres/design_me/keys');
    assert.equal(listed.status, 200);
    const mine = listed.json.keys.find((k: { id: number }) => k.id === id);
    assert.equal(mine.label, 'Her website');
    assert.equal(mine.canWrite, false);
    assert.ok(!JSON.stringify(listed.json).includes(made.json.key), 'the key itself is never handed back again');

    assert.equal((await boss.post(`/api/databases/postgres/design_me/keys/${id}/revoke`, {})).status, 200);
    const after = (await boss.get('/api/databases/postgres/design_me/keys')).json.keys
      .find((k: { id: number }) => k.id === id);
    assert.ok(after.revokedAt, 'and it says when it was stopped');
  });

  it('a key needs a name, and an app that is switched on', async () => {
    assert.equal((await boss.post('/api/databases/postgres/design_me/keys', { label: '  ' })).status, 400);
    await boss.post('/api/databases/postgres/design_me/deactivate', {});
    const no = await boss.post('/api/databases/postgres/design_me/keys', { label: 'Too early' });
    assert.equal(no.status, 400);
    assert.match(no.json.message, /Switch the app on/);
    assert.equal((await boss.post('/api/databases/postgres/design_me/api', { read: true })).status, 400,
      'and the switches need it too');
    await boss.post('/api/databases/postgres/design_me/activate', {});
  });

  it('switching the app off shuts the way in as well', async () => {
    await boss.post('/api/databases/postgres/design_me/api', { read: true, write: true });
    const key = await boss.post('/api/databases/postgres/design_me/keys', { label: 'Doomed', canWrite: true });
    assert.equal(key.status, 200);

    assert.equal((await boss.post('/api/databases/postgres/design_me/deactivate', {})).status, 200);
    const view = await appOf();
    assert.equal(view.apiRead, false, 'the switches go off with it');
    assert.equal(view.apiWrite, false);
    // and every key for it stops, rather than waiting to be revoked one by one
    const keys = (await boss.get('/api/databases/postgres/design_me/keys')).json.keys;
    assert.ok(keys.every((k: { revokedAt: number | null }) => k.revokedAt), 'every key was stopped');
    await boss.post('/api/databases/postgres/design_me/activate', {});
  });

  it('a table added to a switched-on app is not handed to programs until she ticks it', async () => {
    // docs/databases-plan.md 16 PART 14: "a new table is a proposed Resource,
    // not silently published". The menu always kept to that; the catalog the
    // gate serves from has to as well, or Apply puts a table on the internet.
    assert.equal((await boss.post('/api/databases/postgres/design_me/api', { read: true })).status, 200);
    const served = async () => readCatalog((await catalogFor(gate.db, 'postgres', 'design_me'))!.catalog_json)
      .resources.map((r) => r.table);
    assert.ok((await served()).includes('recipes'), 'what she switched on is served');

    const secrets = {
      name: 'secrets', columns: [{ name: 'id', type: 'integer', required: true, identity: true },
        { name: 'note', type: 'short_text', length: 80, required: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    };
    await draw([...(await schemaOf()).draft.tables, secrets]);
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'secrets').decided, false);
    assert.ok(!(await served()).includes('secrets'), 'proposed, not published');
    // the contrast: scribbles was there when the app was switched on, and
    // switching on wrote her yes down for it, so it IS served
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'scribbles').decided, true);
    assert.ok((await served()).includes('scribbles'));

    // once she says so, it is
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/secrets/settings', { enabled: true })).status, 200);
    assert.ok((await served()).includes('secrets'));

    await draw((await schemaOf()).draft.tables.filter((x: { name: string }) => x.name !== 'secrets'));
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/apply', {})).status, 200);
    assert.equal((await boss.post('/api/databases/postgres/design_me/api', { read: false })).status, 200);
  });

  it('"anyone can read these" asks for a passkey to switch on, and reaches the gate', async () => {
    const settings = (patch: Record<string, unknown>) => boss.post('/api/databases/postgres/design_me/app/recipes/settings', patch);
    advance(11 * 60);
    assert.equal((await settings({ publicRead: true })).json.error, 'reauth-required', 'it publishes, so it asks');
    assert.equal((await boss.confirm()).status, 200);
    const on = await settings({ publicRead: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.resources.find((x: { table: string }) => x.table === 'recipes').publicRead, true);
    const pushed = readCatalog((await catalogFor(gate.db, 'postgres', 'design_me'))!.catalog_json).resources.find((r) => r.table === 'recipes')!;
    assert.deepEqual(pushed.public, { only: null });

    // the rule has to be a yes/no field
    const bad = await settings({ publicOnly: 'title' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /yes\/no/);

    // switching it off takes nothing off the internet that was not already, so no passkey
    advance(11 * 60);
    assert.equal((await settings({ publicRead: false })).status, 200);
    const off = readCatalog((await catalogFor(gate.db, 'postgres', 'design_me'))!.catalog_json).resources.find((r) => r.table === 'recipes')!;
    assert.equal(off.public, null);
    // leave the session as fresh as the tests after this one expect
    assert.equal((await boss.confirm()).status, 200);
  });

  // ------------------------------------------------------- the database examples (docs/db-examples-plan.md)

  it('the two examples are set up on their own engines, with their rows, switched on and readable by anyone', async () => {
    const list = async () => (await boss.get('/api/databases/examples')).json.examples as { kind: string; setUp: boolean; active: boolean }[];
    assert.deepEqual((await list()).map((e) => [e.kind, e.setUp]), [['recipes', false], ['blog', false]]);
    for (const kind of ['recipes', 'blog'] as const) {
      const r = await boss.post(`/api/databases/examples/${kind}/setup`, {});
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.rows, DB_EXAMPLES[kind].rows.length);
    }
    assert.deepEqual((await list()).map((e) => [e.kind, e.setUp, e.active]), [['recipes', true, true], ['blog', true, true]]);
    assert.ok(live.postgres.includes('example_recipes'));
    assert.ok(live.mariadb.includes('example_blog'), 'the blog is the MariaDB one');

    // rows went in without ids, each connection from the id it was given
    const recipes = appRows.all('example_recipes', 'recipes');
    assert.equal(recipes.length, 8);
    const cooks = new Set(appRows.all('example_recipes', 'cooks').map((c) => c.id));
    assert.ok(recipes.every((r) => cooks.has(r.cook_id)));
    assert.ok(recipes.some((r) => r.picture === './pictures/pancakes.jpg'));

    // on the dashboard, badged and after hers; not in the menu
    const cards = (await boss.get('/api/databases')).json.databases as { name: string; example: string | null }[];
    assert.equal(cards.find((c) => c.name === 'example_recipes')!.example, 'recipes');
    assert.deepEqual(cards.slice(-2).map((c) => c.example).sort(), ['blog', 'recipes'], 'the examples come last');
    assert.ok(cards.findIndex((c) => c.example) > cards.findIndex((c) => !c.example && c.name === 'design_me'));
    assert.ok(!((await boss.get('/api/apps')).json.apps as { name: string }[]).some((x) => x.name.startsWith('example_')));

    // what the gate serves: public, with the blog's rule, and the connections
    const served = async (engine: string, name: string) => readCatalog((await catalogFor(gate.db, engine, name))!.catalog_json).resources;
    const r = (await served('postgres', 'example_recipes')).find((x) => x.table === 'recipes')!;
    assert.deepEqual(r.public, { only: null });
    assert.deepEqual(r.refs, [{ column: 'cook_id', name: 'cook', to: 'cooks' }]);
    assert.deepEqual(r.many!.map((m) => m.name), ['tags']);
    const posts = (await served('mariadb', 'example_blog')).find((x) => x.table === 'posts')!;
    assert.deepEqual(posts.public, { only: 'published' });
  });

  it('an example can be used but not deleted, let go of, renamed or switched off -- and Reset puts it back', async () => {
    const base = '/api/databases/postgres/example_recipes';
    for (const [url, payload] of [
      [`${base}/delete`, { confirm: 'example_recipes' }], [`${base}/deactivate`, {}], [`${base}/settings`, { displayName: 'Mine now' }], [`${base}/unmanage`, {}],
    ] as const) {
      const r = await boss.post(url, payload);
      assert.equal(r.status, 403, url);
      assert.match(r.json.message, /example/);
    }
    assert.equal((await boss.post('/api/databases', { engine: 'postgres', name: 'example_blog' })).status, 400, 'the names are kept');

    // she changes things; Reset brings the shipped ones back
    appRows.set('example_recipes', 'recipes', []);
    assert.equal((await boss.post('/api/databases/examples/recipes/setup', {})).status, 200);
    assert.equal(appRows.all('example_recipes', 'recipes').length, 8, 'not 16: the old database went first');
  });

  // ------------------------------------------------------- the record picker (docs/record-picker-plan.md)

  it('lists and records say which recipe, by name, and which tags', async () => {
    const ingredients = (await boss.get('/api/app/postgres/example_recipes/ingredients')).json;
    assert.deepEqual(ingredients.connections.refs.map((x: { column: string; name: string }) => [x.column, x.name]), [['recipe_id', 'recipe']]);
    const titles = new Set(appRows.all('example_recipes', 'recipes').map((x) => x.title));
    assert.ok(ingredients.links.length === ingredients.items.length);
    assert.ok(ingredients.links.every((l: { recipe: { label: string } }) => titles.has(l.recipe.label)), 'a recipe name, not an id');
    const recipes = (await boss.get('/api/app/postgres/example_recipes/recipes')).json;
    assert.deepEqual(recipes.connections.many.map((m: { name: string }) => m.name), ['tags']);
    const pancakes = recipes.items.findIndex((x: { title: string }) => x.title === 'Raspberry pancakes');
    assert.deepEqual(recipes.links[pancakes].tags.map((t: { label: string }) => t.label), ['family', 'quick', 'vegetarian', 'weekend']);
    const one = (await boss.get(`/api/app/postgres/example_recipes/recipes/one?id=${recipes.items[pancakes].id}`)).json;
    assert.equal(one.links.cook.label, 'Olivia');
  });

  it('the picker searches and filters the other table through its own window', async () => {
    const pick = async (q: string) => (await boss.get(`/api/app/postgres/example_recipes/ingredients/pick/recipe_id?${q}`)).json;
    const lemon = await pick('search=lemon');
    assert.deepEqual(lemon.items.map((x: { title: string }) => x.title), ['Lemon drizzle loaf']);
    assert.equal(lemon.resource.table, 'recipes');
    assert.ok(lemon.filterable.includes('vegetarian') && lemon.filterable.includes('cook_id'));
    assert.ok(!lemon.filterable.includes('method'), 'not by its long writing');
    const meaty = await pick(`filters=${encodeURIComponent(JSON.stringify([{ kind: 'equals', column: 'vegetarian', value: false }]))}`);
    assert.deepEqual(meaty.items.map((x: { title: string }) => x.title), ['Spaghetti bolognese']);
    // several at once: Olivia's, and vegetarian
    const olivia = appRows.all('example_recipes', 'cooks').find((c) => c.name === 'Olivia')!.id;
    const hers = await pick(`filters=${encodeURIComponent(JSON.stringify([{ kind: 'equals', column: 'cook_id', value: olivia }, { kind: 'equals', column: 'vegetarian', value: true }]))}`);
    assert.deepEqual(hers.items.map((x: { title: string }) => x.title).sort(), ['Chocolate brownies', 'Lemon drizzle loaf', 'Raspberry pancakes']);
    assert.ok(hers.links.every((l: { cook: { label: string } }) => l.cook.label === 'Olivia'), 'each row with its own connections, to tell them apart');
    // a recipe's tags are picked the same way, by name
    const tags = (await boss.get('/api/app/postgres/example_recipes/recipes/pick/tags?search=sum')).json;
    assert.deepEqual(tags.items.map((x: { name: string }) => x.name), ['summer']);
    assert.equal((await boss.get('/api/app/postgres/example_recipes/recipes/pick/nothing_here')).status, 404);
  });

  it('a record is saved with its picked connection, and its many-to-many choices all at once', async () => {
    const recipe = appRows.all('example_recipes', 'recipes').find((x) => x.title === 'Greek salad')!;
    const made = await boss.post('/api/app/postgres/example_recipes/ingredients/new', { values: { recipe_id: recipe.id, item: 'capers', amount: '1 tbsp' } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(appRows.all('example_recipes', 'ingredients').find((x) => x.item === 'capers')!.recipe_id, recipe.id);

    const tagId = (n: string) => appRows.all('example_recipes', 'tags').find((t) => t.name === n)!.id;
    const saved = await boss.post('/api/app/postgres/example_recipes/recipes/save', {
      where: { id: recipe.id }, values: {}, links: { tags: [tagId('summer'), tagId('family')] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const pairs = appRows.all('example_recipes', 'recipe_tags').filter((p) => p.recipe_id === recipe.id).map((p) => p.tag_id).sort();
    assert.deepEqual(pairs, [tagId('summer'), tagId('family')].sort(), 'the old choices replaced, not added to');
    // a connection this table does not have is refused before anything is saved
    const bad = await boss.post('/api/app/postgres/example_recipes/recipes/save', { where: { id: recipe.id }, values: { title: 'Changed' }, links: { cooks: [1] } });
    assert.equal(bad.status, 400);
    assert.equal(appRows.all('example_recipes', 'recipes').find((x) => x.id === recipe.id)!.title, 'Greek salad');
  });

  // ------------------------------------------------------- rich text (docs/rich-text-plan.md)

  it('rich text: only on long text, cleaned on the way in, clean HTML to open it and words in a list', async () => {
    // the blog example's body is rich text, and the gate is told so (T13)
    const served = readCatalog((await catalogFor(gate.db, 'mariadb', 'example_blog'))!.catalog_json).resources.find((x) => x.table === 'posts')!;
    assert.deepEqual(served.rich, ['body']);
    const fields = (await boss.get('/api/databases/mariadb/example_blog/app')).json.resources
      .find((x: { table: string }) => x.table === 'posts').fields as { name: string; control: string }[];
    assert.equal(fields.find((f) => f.name === 'body')!.control, 'rich');

    // refused where it does not fit (T1, T14)
    for (const f of ['title', 'author_id', 'id']) {
      const r = await boss.post(`/api/databases/mariadb/example_blog/app/posts/fields/${f}/settings`, { control: 'rich' });
      assert.equal(r.status, 400, f);
      assert.match(r.json.message, /Only long text can hold formatting/);
    }

    // saved clean, whatever the browser sent (T6)
    const made = await boss.post('/api/app/mariadb/example_blog/posts/new', {
      values: { title: 'Rich', slug: 'rich', published: false, body: '<h2>Hi</h2><p onclick="steal()">a <b>b</b></p><script>alert(1)</script>' },
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.row.id;
    const stored = () => appRows.all('example_blog', 'posts').find((x) => x.id === id)!;
    assert.equal(stored().body, '<h2>Hi</h2><p>a <strong>b</strong></p>');

    // written some other way -- her own SQL -- and still clean when opened (T7)
    appRows.set('example_blog', 'posts', appRows.all('example_blog', 'posts').map((x) =>
      (x.id === id ? { ...x, body: '<p>kept</p><img src=x onerror=alert(1)>' } : x)));
    const one = await boss.get(`/api/app/mariadb/example_blog/posts/one?id=${id}`);
    assert.equal(one.json.row.body, '<p>kept</p>');
    // and a list, or the picker, has the words alone (T15)
    const list = await boss.get('/api/app/mariadb/example_blog/posts?search=Rich');
    assert.equal(list.json.items.find((x: { id: number }) => x.id === id).body, 'kept');

    // a long post gets past the usual 64k (T16) -- and one too long is refused in words
    const long = `<p>${'Words and more words. '.repeat(4000)}</p>`;
    assert.ok(long.length > 64 * 1024);
    const saved = await boss.post('/api/app/mariadb/example_blog/posts/save', { where: { id }, values: { body: long } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 300));
    assert.equal(stored().body, long);
    const tooLong = await boss.post('/api/app/mariadb/example_blog/posts/save', { where: { id }, values: { body: `<p>${'x'.repeat(100_001)}</p>` } });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.message, /Body: This is too long to store/);

    assert.equal((await boss.post('/api/app/mariadb/example_blog/posts/delete', { where: { id } })).status, 200);
  });

  // ------------------------------------------------------- the order of the form (docs/field-order-plan.md)

  it('the order of the form: set, followed by the form and the gate, kept through renames, and put back', async () => {
    const base = '/api/databases/mariadb/example_blog/app/posts';
    const posts = async () => (await boss.get('/api/databases/mariadb/example_blog/app')).json.resources
      .find((x: { table: string }) => x.table === 'posts') as { ordered: boolean; fieldOrder: string[]; fields: { name: string }[] };
    // the example comes ordered, title first (O9) -- not Author, as its settings used to put it
    const shipped = (await posts()).fieldOrder;
    assert.equal((await posts()).ordered, true);
    assert.deepEqual(shipped.slice(0, 3), ['title', 'slug', 'author_id']);

    assert.equal((await boss.post(`${base}/order`, { order: ['body', 'many:topics', 'title'] })).status, 200);
    const now = await posts();
    assert.deepEqual(now.fieldOrder.slice(0, 3), ['body', 'many:topics', 'title']);
    assert.deepEqual(now.fields.slice(0, 2).map((f) => f.name), ['body', 'title']);
    const served = readCatalog((await catalogFor(gate.db, 'mariadb', 'example_blog'))!.catalog_json).resources.find((x) => x.table === 'posts')!;
    assert.deepEqual(served.columns.slice(0, 2), ['body', 'title'], 'the gate is told at once');

    const bad = await boss.post(`${base}/order`, { order: ['body', 'body'] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /twice/);

    // a field or a table renamed on the canvas keeps its place (O5)
    const dbId = (await one<{ id: number }>(db, "SELECT id FROM studio_databases WHERE engine = 'mariadb' AND name = 'example_blog'"))!.id;
    const stored = async (t: string) => JSON.parse((await one<{ field_order: string }>(db,
      'SELECT field_order FROM studio_resources WHERE database_id = ? AND table_name = ?', dbId, t))!.field_order) as string[];
    await carryRenames(db, dbId, { tables: [{ from: 'topics', to: 'subjects' }], fields: [{ table: 'posts', from: 'body', to: 'content' }] });
    assert.deepEqual((await stored('posts')).slice(0, 2), ['content', 'many:subjects']);
    await carryRenames(db, dbId, { tables: [{ from: 'subjects', to: 'topics' }], fields: [{ table: 'posts', from: 'content', to: 'body' }] });
    assert.deepEqual((await stored('posts')).slice(0, 2), ['body', 'many:topics']);

    // put back: the table's own order
    assert.equal((await boss.post(`${base}/order`, { order: [] })).status, 200);
    assert.equal((await posts()).ordered, false);
    assert.equal((await posts()).fieldOrder[0], 'id');
    assert.equal((await boss.post(`${base}/order`, { order: shipped.slice(0, 8) })).status, 200);
  });

  // ------------------------------------------------------- forms into a database (docs/form-to-database-plan.md)

  it('forms into a database: what fits where, refused until complete, pushed with the catalog; private answers ask first', async () => {
    const made = await boss.post('/api/forms', { name: 'share-a-recipe', title: 'Share a recipe', items: [
      { id: 'new-1', type: 'short-text', label: 'Recipe name', required: true },
      { id: 'new-2', type: 'email', label: 'Email', required: true },
      { id: 'new-3', type: 'number', label: 'Servings' },
    ] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const fid = made.json.form.id;
    const st = (await boss.get(`/api/forms/${fid}/database`)).json;
    assert.equal(st.link, null);
    assert.deepEqual(st.questions.map((q: { key: string }) => q.key), ['recipe-name', 'email', 'servings']);
    assert.ok(st.databases.some((d: { name: string; active: boolean }) => d.name === 'design_me' && d.active));
    assert.ok(!st.databases.some((d: { name: string }) => d.name.startsWith('example_')), "the examples' databases are not offered");

    // what fits where, worked out by the panel from her tables
    const recipes = (await boss.get(`/api/forms/${fid}/database/postgres/design_me`)).json.tables.find((t: { table: string }) => t.table === 'recipes');
    assert.ok(recipes, 'recipes takes new records');
    assert.ok(recipes.fits['recipe-name'].includes('title'));
    assert.ok(!recipes.fits.servings.includes('title'), 'a number does not go into text');
    assert.ok(recipes.fits.servings.includes('servings'));
    assert.deepEqual(recipes.suggested, [{ key: 'servings', field: 'servings' }]);

    // refused until every field it needs is filled (F7)
    const link = { engine: 'postgres', name: 'design_me', table: 'recipes', when: 'arrived', pairs: [] as unknown[], fixed: [] };
    const bad = await boss.post(`/api/forms/${fid}/database`, link);
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /title has to be filled in/);
    assert.match((await boss.post(`/api/forms/${fid}/database`, { ...link, pairs: [{ key: 'recipe-name', field: 'title' }], when: 'approved' })).json.message,
      /Responses can be approved/);
    const ok = await boss.post(`/api/forms/${fid}/database`, { ...link, pairs: [{ key: 'recipe-name', field: 'title' }, { key: 'servings', field: 'servings' }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    // the gate has it, and a catalog that says each field's kind
    const served = readCatalog((await catalogFor(gate.db, 'postgres', 'design_me'))!.catalog_json).resources.find((x) => x.table === 'recipes')!;
    assert.deepEqual(served.types!.title, { type: 'text', required: true, defaulted: false });
    const now = (await boss.get(`/api/forms/${fid}/database`)).json;
    assert.equal(now.link.table, 'recipes');
    assert.deepEqual(now.problems, []);
    assert.deepEqual((await boss.get('/api/databases/postgres/design_me/form-links')).json.links.map((l: { title: string }) => l.title), ['Share a recipe']);

    // F8: a private answer into a table anyone can read asks first
    assert.equal((await boss.confirm()).status, 200);
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/recipes/settings', { publicRead: true })).status, 200);
    const priv = { ...link, pairs: [{ key: 'email', field: 'title' }] };
    const asked = await boss.post(`/api/forms/${fid}/database`, priv);
    assert.equal(asked.status, 409);
    assert.equal(asked.json.error, 'confirm-public');
    assert.match(asked.json.message, /"Email" would be public/);
    assert.equal((await boss.post(`/api/forms/${fid}/database`, { ...priv, confirmPublic: true })).status, 200);
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/recipes/settings', { publicRead: false })).status, 200);

    // the account manager's alone, never an example's form; and it can be let go
    assert.equal((await member.get(`/api/forms/${fid}/database`)).status, 404);
    const fixture = ((await boss.get('/api/forms')).json.forms as { id: number; fixture: string | null }[]).find((x) => x.fixture);
    if (fixture) assert.equal((await boss.get(`/api/forms/${fixture.id}/database`)).status, 400);
    assert.equal((await boss.post(`/api/forms/${fid}/database/disconnect`, {})).status, 200);
    assert.equal((await boss.get(`/api/forms/${fid}/database`)).json.link, null);
    const acts = (await all<{ action: string }>(db, "SELECT action FROM activity WHERE target = 'share-a-recipe' ORDER BY id")).map((x) => x.action);
    assert.ok(acts.includes('form-linked') && acts.includes('form-unlinked'));
  });

  // ------------------------------------------------------- comments in her apps (docs/comments-plan.md C8-C10)

  it('"This app takes comments" and "People can comment on these" draw tables into the draft and make the area -- nothing runs', async () => {
    const before = (await boss.get('/api/databases/postgres/design_me/schema')).json;
    const r = await boss.post('/api/databases/postgres/design_me/comments', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.review, '/databases/postgres/design_me/review');
    const drawn = (await boss.get('/api/databases/postgres/design_me/schema')).json;
    assert.ok(drawn.draft.tables.some((t: { name: string }) => t.name === 'comment_threads'));
    assert.ok(drawn.draft.tables.some((t: { name: string }) => t.name === 'comments'));
    assert.ok(!drawn.current.tables.some((t: { name: string }) => t.name === 'comments'), 'not in her database until Apply');
    assert.ok(drawn.plan.steps.length > before.plan.steps.length);
    // C9: the area, already keeping its copy there
    const area = ((await boss.get('/api/forms')).json.forms as { id: number; name: string; kind: string }[]).find((f) => f.name === 'design-me-comments')!;
    assert.equal(area.kind, 'comments');
    const link = (await gate.db.unsafe("SELECT mode, table_name, write_when FROM gate.form_links WHERE form_id = $1", [area.id]))[0];
    assert.deepEqual({ ...link }, { mode: 'comments', table_name: 'comments', write_when: 'approved' });
    // drawing again does not make a second of anything
    assert.equal((await boss.post('/api/databases/postgres/design_me/comments', {})).status, 200);
    assert.equal(((await boss.get('/api/forms')).json.forms as { name: string }[]).filter((f) => f.name === 'design-me-comments').length, 1);

    const c = await boss.post('/api/databases/postgres/design_me/app/recipes/commentable', {});
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.table, 'recipe_comment_threads');
    assert.ok((await boss.get('/api/databases/postgres/design_me/schema')).json.draft.tables.some((t: { name: string }) => t.name === 'recipe_comment_threads'));
    assert.equal((await boss.post('/api/databases/postgres/design_me/app/nope/commentable', {})).status, 400);

    // choosing an app for an area needs its tables to be really there
    const copy = await boss.post(`/api/forms/${area.id}/comments-copy`, { engine: 'postgres', name: 'design_me' });
    assert.equal(copy.status, 400);
    assert.match(copy.json.message, /no comments tables yet/);
    assert.equal((await boss.post(`/api/forms/${area.id}/comments-copy`, { engine: null })).status, 200, 'and none, always');
    assert.equal((await member.post('/api/databases/postgres/design_me/comments', {})).status, 404);
    assert.equal((await boss.post('/api/databases/postgres/design_me/schema/discard', {})).status, 200);
  });

  it('"Make my own": her database, its app switched on, and the page in her folder -- rows only if she ticks it', async () => {
    const pub = join(dir, 'public-dbex');
    mkdirSync(join(pub, 'kitchen'), { recursive: true });
    mkdirSync(join(dir, 'trash-dbex'), { recursive: true });
    const site = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-dbex'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    await new Promise<void>((r) => site.listen(join(dir, 'sitefs.sock'), r));
    try {
      const copy = (kind: string, o: Record<string, unknown>) => boss.post(`/api/databases/examples/${kind}/copy`, o);
      const r = await copy('recipes', { engine: 'mariadb', name: 'our_recipes', title: 'Our recipes', folder: 'kitchen', page: 'recipes.html', rows: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.rows, DB_EXAMPLES.recipes.rows.length);
      assert.equal(r.json.address, 'https://pammy.org/kitchen/recipes.html');
      const page = readFileSync(join(pub, 'kitchen', 'recipes.html'), 'utf8');
      assert.match(page, /data-api="\/_pammy\/api\/data\/mariadb\/our_recipes"/, 'pointed at her database');
      assert.match(page, /recipes-files\/style\.css/);
      assert.ok(existsSync(join(pub, 'kitchen', 'recipes-files', 'recipes.js')));
      assert.ok(existsSync(join(pub, 'kitchen', 'recipes-files', 'pancakes.jpg')), 'the pictures came with the rows');
      assert.ok(appRows.all('our_recipes', 'recipes').some((x) => x.picture === 'recipes-files/pancakes.jpg'), 'and the rows point at her copies');
      // hers: in the menu, not an example
      const card = ((await boss.get('/api/databases')).json.databases as { name: string; example: string | null; status: string }[]).find((c) => c.name === 'our_recipes')!;
      assert.deepEqual([card.example, card.status], [null, 'active']);
      assert.ok(((await boss.get('/api/apps')).json.apps as { title: string }[]).some((x) => x.title === 'Our recipes'));

      // without the tick: the tables and the page, and no rows
      const b = await copy('blog', { engine: 'postgres', name: 'our_blog', title: 'Our blog', folder: 'kitchen', page: 'blog.html' });
      assert.equal(b.status, 200, JSON.stringify(b.json));
      assert.equal(b.json.rows, 0);
      assert.deepEqual(appRows.all('our_blog', 'posts'), []);
      assert.ok(existsSync(join(pub, 'kitchen', 'blog.html')));
      // what Getting started looks for (docs/getting-started-plan.md G1)
      const copied = await all(db, "SELECT name, copied_from, page, copied_rows FROM studio_databases WHERE name IN ('our_blog', 'our_recipes') ORDER BY name");
      assert.deepEqual(copied.map((r) => [r.name, r.copied_from, r.page, r.copied_rows]),
        [['our_blog', 'blog', 'kitchen/blog.html', false], ['our_recipes', 'recipes', 'kitchen/recipes.html', true]]);

      // everything is checked before anything is made
      const again = await copy('blog', { engine: 'postgres', name: 'our_blog_two', title: 'Another blog', folder: 'kitchen', page: 'blog.html' });
      assert.equal(again.status, 409);
      assert.ok(!live.postgres.includes('our_blog_two'), 'no database made for a page that could not be written');
      assert.equal((await copy('blog', { engine: 'postgres', name: 'our_blog_three', title: 'Our blog', folder: 'kitchen', page: 'b.html' })).status, 400, 'an app of that name is on');
      assert.equal((await copy('blog', { engine: 'postgres', name: 'example_recipes', title: 'X', folder: 'kitchen', page: 'x.html' })).status, 400);

      // tidy up, the way she would
      for (const [engine, name] of [['mariadb', 'our_recipes'], ['postgres', 'our_blog']]) {
        assert.equal((await boss.post(`/api/databases/${engine}/${name}/deactivate`, {})).status, 200);
        assert.equal((await boss.post(`/api/databases/${engine}/${name}/delete`, { confirm: name })).status, 200);
      }
    } finally {
      await new Promise<void>((r) => site.close(() => r()));
    }
  });

  it('Home hears about changes waiting, and only ones that really change something', async () => {
    const home = async () => (await boss.get('/api/databases/home')).json;
    const mine = (h: { waiting: { name: string }[] }) => h.waiting.find((w) => w.name === 'design_me');
    const first = await home();
    assert.ok(first.managed >= 1);
    assert.equal(mine(first), undefined, 'nothing drawn, nothing waiting');

    const start = await schemaOf();
    const recipes = start.draft.tables.find((x: { name: string }) => x.name === 'recipes');
    await draw(start.draft.tables.map((x: { name: string }) => (x.name === 'recipes'
      ? { ...recipes, columns: [...recipes.columns, { name: 'rating', type: 'integer', required: false }] } : x)));
    assert.deepEqual(mine(await home()), { engine: 'postgres', name: 'design_me', title: (await appOf()).title, active: true, changes: 1 });

    // and the pages say which part of the switched-on app it reaches
    const view = await schemaOf();
    assert.deepEqual(view.app.touched, [{ table: 'recipes', plural: 'Recipes', how: 'changed' }]);
    assert.deepEqual(view.app.added, []);

    // drawn back to what the database has: the drawing is still saved, but it
    // says nothing, and Home must not claim otherwise
    await draw(start.draft.tables);
    assert.equal((await schemaOf()).hasDraft, true);
    assert.equal(mine(await home()), undefined);

    await boss.post('/api/databases/postgres/design_me/schema/discard', {});
    assert.equal((await member.get('/api/databases/home')).status, 404);
    assert.equal((await new Browser('203.0.113.144').get('/api/databases/home')).status, 401);
  });

  it('the programs page names exactly the addresses the gate answers on', async () => {
    const served = async () => (await boss.get('/api/databases/postgres/design_me/keys')).json.served;
    const held = readCatalog((await catalogFor(gate.db, 'postgres', 'design_me'))!.catalog_json).resources.map((r) => r.slug);
    assert.deepEqual((await served()).map((r: { slug: string }) => r.slug), held);
    assert.ok(held.length > 0);
    await boss.post('/api/databases/postgres/design_me/deactivate', {});
    assert.deepEqual(await served(), [], 'switched off, the gate holds nothing, so there is nothing to name');
    await boss.post('/api/databases/postgres/design_me/activate', {});
  });

  it('a switched-off app has nothing more to say about a change', async () => {
    await boss.post('/api/databases/postgres/design_me/deactivate', {});
    assert.equal((await schemaOf()).app, null);
    await boss.post('/api/databases/postgres/design_me/activate', {});
  });

  it('letting programs in is the account manager\'s alone', async () => {
    assert.equal((await member.get('/api/databases/postgres/design_me/keys')).status, 404);
    assert.equal((await member.post('/api/databases/postgres/design_me/keys', { label: 'x' })).status, 404);
    assert.equal((await member.post('/api/databases/postgres/design_me/api', { read: true })).status, 404);
    assert.equal((await new Browser('203.0.113.144').get('/api/databases/postgres/design_me/keys')).status, 401);
  });

  it('switching the app off leaves the data and her words alone', async () => {
    assert.equal((await boss.post('/api/databases/postgres/design_me/deactivate', {})).status, 200);
    assert.equal((await boss.get('/api/databases/postgres/design_me')).json.status, 'inactive');
    // D15: the pages go; the rows and the Resource definition stay
    assert.equal(appRows.all('design_me', 'recipes').length, 25);
    assert.equal((await appOf()).resources.find((x: { table: string }) => x.table === 'recipes').plural, 'Recipes');
  });

  it('keeps what is left when an engine stops half way (MariaDB)', async () => {
    assert.equal((await boss.post('/api/databases', { engine: 'mariadb', name: 'shop' })).status, 200);
    const start = (await boss.get('/api/databases/mariadb/shop/schema')).json;
    const table = (name: string) => ({
      name, columns: [{ name: 'id', type: 'integer', required: true, identity: true }],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    });
    assert.equal((await boss.post('/api/databases/mariadb/shop/schema/draft',
      { draft: { ...start.draft, tables: [table('orders'), table('items')] }, basedOn: start.currentHash })).status, 200);
    // the engine takes the first and refuses the second, and -- being MariaDB --
    // keeps the first: what ran, ran
    schemas.mariadb.refuse((_s, at) => at === 1);
    const r = await boss.post('/api/databases/mariadb/shop/schema/apply', {});
    schemas.mariadb.refuse(null);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false, 'it did not all work, and says so');
    assert.equal(r.json.applied, 1);
    assert.equal(r.json.rolledBack, false, 'MariaDB did not undo anything, and the panel does not pretend it did');
    assert.equal(r.json.hasDraft, true, 'what is left is still waiting');
    assert.equal(r.json.plan.changes.length, 1);
    assert.match(r.json.plan.changes[0].line, /New table orders/);
    assert.deepEqual(r.json.current.tables.map((t: { name: string }) => t.name), ['items'], 'the one that went in is really there');
    // and applying again finishes the job rather than starting over
    const again = await boss.post('/api/databases/mariadb/shop/schema/apply', {});
    assert.equal(again.json.ok, true);
    assert.equal(again.json.applied, 1);
    assert.deepEqual(again.json.current.tables.map((t: { name: string }) => t.name), ['items', 'orders']);
    assert.equal(again.json.hasDraft, false);
  });
});

describe('what the dashboard makes of the two sides', () => {
  const row = (engine: 'postgres' | 'mariadb', name: string, over: Partial<ManagedRow> = {}): ManagedRow => ({
    id: 1, engine, name, display_name: '', adopted_at: 1000, status: 'inactive', api_read: 0, api_write: 0, ...over,
  });
  const fact = (engine: 'postgres' | 'mariadb', name: string, over: Partial<DatabaseFacts> = {}): DatabaseFacts => ({
    engine, name, bytes: 1, tables: 2, owner: null, protectedName: false, system: false, ...over,
  });

  it('keeps a remembered database that the engine no longer has', () => {
    const cards = mergeDatabases([fact('postgres', 'here')], [row('postgres', 'here'), row('mariadb', 'gone', { display_name: 'Notes' })]);
    assert.deepEqual(cards.map((c) => [c.engine, c.name, c.managed, c.live]), [
      ['mariadb', 'gone', true, false],
      ['postgres', 'here', true, true],
    ]);
    assert.equal(cards[0]!.displayName, 'Notes');
    assert.equal(cards[0]!.bytes, null, 'nothing is claimed about a database that is not there');
  });

  it('matches on the engine as well as the name', () => {
    const cards = mergeDatabases(
      [fact('postgres', 'blog'), fact('mariadb', 'blog')],
      [row('mariadb', 'blog', { display_name: 'Blog' })],
    );
    assert.deepEqual(cards.map((c) => [c.engine, c.managed, c.displayName]), [['mariadb', true, 'Blog'], ['postgres', false, '']]);
  });

  it('carries the flags and the engine\'s own name through', () => {
    const [card] = mergeDatabases([fact('mariadb', 'mysql', { protectedName: true, system: true })], []);
    assert.equal(card!.engineName, 'MariaDB');
    assert.equal(card!.system, true);
    assert.equal(card!.protectedName, true);
    assert.equal(card!.managed, false);
  });
});

describe('what the users page makes of the two sides', () => {
  const note = (engine: 'postgres' | 'mariadb', name: string, over: Partial<UserNoteRow> = {}): UserNoteRow => ({
    id: 1, engine, name, note: '', created_at: 1000, ...over,
  });
  const live = (engine: 'postgres' | 'mariadb', name: string, over: Partial<DbUser> = {}): DbUser => ({
    engine, name, host: null, canLogin: true, reserved: false, serverWide: false, ...over,
  });

  it('keeps a login the panel wrote down that the engine no longer has', () => {
    const cards = mergeUsers([live('postgres', 'here')], [note('postgres', 'here'), note('mariadb', 'gone', { note: 'the old app' })]);
    assert.deepEqual(cards.map((c) => [c.engine, c.name, c.known, c.live]), [
      ['mariadb', 'gone', true, false],
      ['postgres', 'here', true, true],
    ]);
    assert.equal(cards[0]!.note, 'the old app');
  });

  it('never calls a login gone when its engine did not answer', () => {
    const cards = mergeUsers([], [note('mariadb', 'backup')],
      [{ engine: 'mariadb', ok: false, version: null, message: 'asleep' }]);
    assert.equal(cards[0]!.live, null, 'unknown, not gone');
  });

  it('matches on the engine as well as the name', () => {
    // the same word on two servers is two logins, and always will be
    const cards = mergeUsers(
      [live('postgres', 'website'), live('mariadb', 'website')],
      [note('mariadb', 'website', { note: 'the shop' })],
    );
    assert.deepEqual(cards.map((c) => [c.engine, c.known, c.note]), [['mariadb', true, 'the shop'], ['postgres', false, '']]);
  });

  it('carries reserved and server-wide through, rather than hiding them', () => {
    const [card] = mergeUsers([live('mariadb', 'root', { reserved: true, serverWide: true, host: '%' })], []);
    assert.equal(card!.engineName, 'MariaDB');
    assert.equal(card!.reserved, true);
    assert.equal(card!.serverWide, true);
    assert.equal(card!.host, '%');
  });

  it('makes a password nothing would have to escape', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = newDbPassword();
      assert.match(pw, /^[A-Za-z0-9]{32}$/, pw);
      // it is what the helper will accept, checked by the helper's own rule
      assert.equal(PASSWORD_RE.test(pw), true);
      seen.add(pw);
    }
    assert.equal(seen.size, 200, 'and a different one each time');
  });
});

// N5 (docs/refactor-plan.md): the tutorial examples' to-do pages go through the
// panel, which is the one signed in. The gate applies the owner rule for a
// signed-in visitor (V2); here the panel applies the same rule itself, so it is
// worth checking that it really does -- a second copy of a rule is a rule that
// can drift.
describe("the tutorial examples' to-do proxy keeps the owner rule (N5)", () => {
  const b = new Browser('203.0.113.77');
  const TASKS = '/_pammy/api/data/postgres/example_todo/tasks';
  let me = '';

  before(async () => {
    const u = await createUser(db, clock, COMMAND_LINE, 'todo-boss', 'Todo boss', 'manager');
    me = u.username;
    const { token } = await createInvite(db, clock, COMMAND_LINE, u);
    await b.useInvite(token, 'laptop');
    // the key as "Set up the tutorial examples" writes it (guide 18, PART 2)
    mkdirSync(join(dir, 'tutorial-examples', 'todo-php'), { recursive: true });
    writeFileSync(join(dir, 'tutorial-examples', 'todo-php', 'settings.php'), "<?php\nreturn 'pammy_the-examples-key';\n");
  });
  beforeEach(() => { gateAsked.length = 0; });

  it('asks only for this account\'s tasks, whatever the page asks for', async () => {
    gateReplies = () => ({ items: [], total: 0 });
    const r = await b.get(`${TASKS}?where.owner=someone-else&where.done=false`);
    assert.equal(r.status, 200);
    assert.equal(gateAsked.length, 1);
    const url = new URL(gateAsked[0]!.url, 'http://gate');
    assert.deepEqual(url.searchParams.getAll('where.owner'), [me], 'the owner it asks for is the one signed in, once');
    assert.equal(url.searchParams.get('where.done'), 'false', 'and the rest of the question is passed on');
    assert.equal(gateAsked[0]!.key, 'pammy_the-examples-key');
  });

  it('answers "no such record" for a task that is someone else\'s, and does not pass it on', async () => {
    gateReplies = () => ({ item: { id: 7, title: 'Not yours', owner: 'someone-else' } });
    const r = await b.get(`${TASKS}/7`);
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not-found');
    assert.equal(gateAsked.length, 1, 'it looked once, to see whose it was, and stopped');

    gateAsked.length = 0;
    const saved = await b.post(`${TASKS}/7/save`, { values: { title: 'Mine now' } });
    assert.equal(saved.status, 404);
    assert.equal(gateAsked.length, 1, 'nothing was written');
  });

  it('puts the owner on a new task, whatever was sent', async () => {
    gateReplies = () => ({ item: { id: 8 } });
    const r = await b.post(`${TASKS}/new`, { values: { title: 'Mine, honest', owner: 'someone-else' } });
    assert.equal(r.status, 200);
    const sent = gateAsked.at(-1)!.body as { values: Record<string, unknown> };
    assert.equal(sent.values.owner, me, 'the owner is the account, not what the page sent');
    assert.equal(sent.values.title, 'Mine, honest');
  });

  it('never lets a save change whose task it is', async () => {
    gateReplies = (asked) => (asked.method === 'GET' ? { item: { id: 9, owner: me } } : { item: { id: 9 } });
    const r = await b.post(`${TASKS}/9/save`, { values: { title: 'Still mine', owner: 'someone-else' } });
    assert.equal(r.status, 200);
    const sent = gateAsked.at(-1)!.body as { values: Record<string, unknown> };
    assert.deepEqual(sent.values, { title: 'Still mine' }, 'owner is dropped rather than passed on');
  });

  it('says so plainly when the examples have not been set up', async () => {
    const before = readFileSync(join(dir, 'tutorial-examples', 'todo-php', 'settings.php'), 'utf8');
    rmSync(join(dir, 'tutorial-examples', 'todo-php', 'settings.php'));
    // the key the panel already read is still the one it uses (N6: read once)
    assert.equal((await b.get(TASKS)).status, 200);
    writeFileSync(join(dir, 'tutorial-examples', 'todo-php', 'settings.php'), before);
  });
});

describe('getting started (docs/getting-started-plan.md)', () => {
  const boss = new Browser('203.0.113.160');
  const second = new Browser('203.0.113.161');
  const kept = new Browser('203.0.113.162');
  let gateAdmin: ReturnType<typeof createGateAdminServer>;
  let gate: GateLive;
  const PIN = { goal: 'pinboard', who: 'people', when: 'after' };

  before(async () => {
    gate = await newGate(await gatePg(), () => clock);
    gateAdmin = createGateAdminServer(gate, () => clock);
    await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));
    for (const [b, name, role] of [[boss, 'gsboss', 'manager'], [second, 'gssecond', 'manager'], [kept, 'gskept', 'member']] as const) {
      const u = await createUser(db, clock, COMMAND_LINE, name, name, role, b === kept ? keptTo('/club') : role === 'member' ? MEMBER : undefined);
      assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    }
  });
  after(async () => {
    await new Promise<void>((r) => gateAdmin.close(() => r()));
    await gate.db.end({ timeout: 2 });
  });

  it('is for account managers only (D4)', async () => {
    for (const [method, url] of [['GET', '/api/getting-started'], ['POST', '/api/getting-started/ask'], ['POST', '/api/getting-started/start'], ['POST', '/api/getting-started/open']] as const) {
      assert.equal((await kept.req(method, url, {})).status, 404, url);
    }
    assert.equal((await new Browser('203.0.113.163').get('/api/getting-started')).status, 401);
    assert.ok(PAGE_PATHS.includes('/getting-started'));
  });

  it('asks one question at a time, and ends with a recommendation and guide 19', async () => {
    const first = await boss.post('/api/getting-started/ask', { answers: {} });
    assert.equal(first.json.question.key, 'goal');
    assert.equal(first.json.question.text, 'What would you like to do?');
    const next = await boss.post('/api/getting-started/ask', { answers: { goal: 'pinboard', stray: 'x' } });
    assert.deepEqual([next.json.question.key, next.json.answers], ['who', { goal: 'pinboard' }]);
    const r = await boss.post('/api/getting-started/ask', { answers: PIN });
    assert.equal(r.json.recommendation.path, 'pinboard');
    assert.equal(r.json.recommendation.guide19.href, '/help/forms-or-a-database/part-4');
    assert.ok(r.json.recommendation.steps.includes('Keep it for people you know'));
    assert.equal((await boss.post('/api/getting-started/start', { answers: { goal: 'pinboard' } })).status, 400, 'not all answered');
  });

  it('a path, shared by the managers, ticked by what is on the site (G1)', async () => {
    const s = await boss.post('/api/getting-started/start', { answers: PIN });
    assert.equal(s.status, 200);
    const id = s.json.id as number;
    const stepsOf = async (b: Browser, deep = false) => {
      const g = await b.get(`/api/getting-started${deep ? '?deep=1' : ''}`);
      const p = g.json.paths.find((x: { id: number }) => x.id === id);
      return Object.fromEntries(p.steps.map((x: { key: string; state: string }) => [x.key, x.state]));
    };
    assert.deepEqual(await stepsOf(boss), { form: 'todo', 'on-page': 'todo', public: 'todo', protect: 'todo', first: 'todo' });

    // her own pinboard form, seen on a page in a protected folder, public, with an approved note
    const f = await handleAdmin(gate, clock, { op: 'form.create', name: 'our-pinboard', starter: 'pinboard', actor: 'gsboss' }) as { id: number };
    await gate.db`INSERT INTO form_pages (form_id, page, last_seen) VALUES (${f.id}, 'club/pinboard.html', ${clock})`;
    await handleAdmin(gate, clock, { op: 'area.create', path: 'club' });
    await handleAdmin(gate, clock, { op: 'form.switches', id: f.id, approvable: true, publicApproved: true, actor: 'gsboss' });
    const got = await stepsOf(second, true);
    assert.deepEqual(got, { form: 'done', 'on-page': 'done', public: 'done', protect: 'done', first: 'todo' }, 'the other manager sees the same');
    const g = (await second.get('/api/getting-started?deep=1')).json.paths.find((x: { id: number }) => x.id === id);
    assert.equal(g.startedBy, 'gsboss');
    assert.deepEqual(g.holding, [{ what: 'form', label: '"Pinboard" (our-pinboard)' }]);
    assert.equal(g.next, 'first');
    assert.equal(g.steps.find((x: { key: string }) => x.key === 'first').to.href, '/responses');
  });

  it('skip, tick by hand only where nothing checks, put away', async () => {
    advance(5);   // the folder the last test protected was made before this path started
    const id = (await boss.post('/api/getting-started/start', { answers: { goal: 'private' } })).json.id as number;
    assert.equal((await boss.post(`/api/getting-started/${id}/step`, { step: 'protect', state: 'done-by-hand' })).status, 400, 'the site can tell');
    assert.equal((await boss.post(`/api/getting-started/${id}/step`, { step: 'nope', state: 'skipped' })).status, 400);
    assert.equal((await boss.post(`/api/getting-started/${id}/step`, { step: 'try', state: 'done-by-hand' })).status, 200);
    assert.equal((await boss.post(`/api/getting-started/${id}/step`, { step: 'person', state: 'skipped' })).status, 200);
    let p = (await boss.get('/api/getting-started')).json.paths.find((x: { id: number }) => x.id === id);
    assert.deepEqual(p.steps.map((x: { state: string }) => x.state), ['todo', 'skipped', 'done-by-hand']);
    // a folder protected since she started ticks the first one; then everything is done or skipped
    advance(5);
    await handleAdmin(gate, clock, { op: 'area.create', path: 'secret' });
    p = (await boss.get('/api/getting-started')).json.paths.find((x: { id: number }) => x.id === id);
    assert.deepEqual([p.steps[0].state, p.steps[0].found, p.finished], ['done', 'secret', true]);
    assert.equal((await boss.post(`/api/getting-started/${id}/not-the-one`, { what: 'area' })).status, 200);
    p = (await boss.get('/api/getting-started')).json.paths.find((x: { id: number }) => x.id === id);
    assert.deepEqual([p.steps[0].state, p.finished], ['todo', false], 'let go of, and not taken again');
    assert.equal((await boss.post(`/api/getting-started/${id}/put-away`, {})).status, 200);
    assert.equal((await boss.get('/api/getting-started')).json.paths.some((x: { id: number }) => x.id === id), false);
    assert.equal((await boss.post(`/api/getting-started/${id}/put-away`, {})).status, 404);
  });

  it('open or closed on Home, per account (D2)', async () => {
    assert.equal((await boss.get('/api/getting-started')).json.open, true);
    assert.equal((await boss.post('/api/getting-started/open', { open: false })).status, 200);
    assert.equal((await boss.get('/api/getting-started')).json.open, false);
    assert.equal((await second.get('/api/getting-started')).json.open, true);
    assert.equal((await boss.post('/api/getting-started/open', { open: 'yes' })).status, 400);
  });
});

// ---------------------------------------------------------------------------
describe('installed software (docs/apps-plan.md phase 1)', () => {
  const boss = new Browser('203.0.113.170');
  const member = new Browser('203.0.113.171');
  const kept = new Browser('203.0.113.172');
  let apps: ReturnType<typeof createAppsServer>;
  let probed = 0;
  const ran: string[] = [];
  let mail: ReturnType<typeof createMailServer>;
  let swGate: GateLive;
  let swGateAdmin: ReturnType<typeof createGateAdminServer>;
  let swSitefs: ReturnType<typeof createSiteFsServer>;
  const resend: Record<string, unknown>[] = [];
  const settled = async () => {
    for (let i = 0; i < 100 && (await boss.get('/api/software/blog')).json.job; i++) await new Promise((r) => setTimeout(r, 5));
  };

  before(async () => {
    const root = join(dir, 'apps-root');
    const world = wordpressServer(root);
    world.lay();
    const fake = fakeSystem(world, () => clock);
    const state = join(dir, 'apps-state');
    assert.equal((await adoptWordPress({ root, domain: 'pammy.org' }, state, clock)).done, 'adopted');
    apps = createAppsServer(createOps({
      root, domain: 'pammy.org', nginx: { host: '127.0.0.1', port: 443 },
      probe: async () => { probed++; return { status: 200, ms: 9, error: null }; }, now: () => clock,
    }, state, {
      ...fakeSystem(world, () => clock),
      run: async (spec) => { ran.push(spec.argv.join(' ')); return fake.run(spec); },
      templates: new URL('../../wordpress/nginx/templates/', import.meta.url).pathname,
      wpConfig: new URL('../../wordpress/config/', import.meta.url).pathname,
    }));
    await new Promise<void>((r) => apps.listen(join(dir, 'apps.sock'), r));
    // the mail service, reading what the software helper writes, with Resend stood in for
    mail = createMailServer({ names: { site: PROFILE.name, panel: PROFILE.panelName },
      settings: () => readSettings(join(root, 'etc/pammy-mail/settings.json')),
      key: () => readKey(join(root, 'etc/pammy-mail/resend.key')),
      fetch: (async (_url: string, init: RequestInit) => {
        resend.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: `email-${resend.length}` }), { status: 200 });
      }) as typeof fetch,
      panelOrigin: ORIGIN, domain: 'pammy.org', now: () => clock,
    });
    await new Promise<void>((r) => mail.listen(join(dir, 'mail.sock'), r));
    // her website's folders, for Move (a name that is one of them is refused)
    const pub = join(dir, 'public-software');
    mkdirSync(join(pub, 'journal'), { recursive: true });
    mkdirSync(join(dir, 'trash-software'), { recursive: true });
    swSitefs = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash-software'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock * 1000) });
    await new Promise<void>((r) => swSitefs.listen(join(dir, 'sitefs.sock'), r));
    // a gate, for the Email page's list of forms (the seeded sample contact form)
    swGate = await newGate(await gatePg(), () => clock);
    swGateAdmin = createGateAdminServer(swGate, () => clock);
    await new Promise<void>((r) => swGateAdmin.listen(join(dir, 'gate.sock'), r));
    for (const [b, name, role] of [[boss, 'swboss', 'manager'], [member, 'swmember', 'member'], [kept, 'swkept', 'member']] as const) {
      const u = await createUser(db, clock, COMMAND_LINE, name, name, role, b === kept ? keptTo('/club') : role === 'member' ? MEMBER : undefined);
      assert.equal((await b.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
    }
  });
  after(async () => {
    await new Promise<void>((r) => apps.close(() => r()));
    await new Promise<void>((r) => mail.close(() => r()));
    await new Promise<void>((r) => swGateAdmin.close(() => r()));
    await new Promise<void>((r) => swSitefs.close(() => r()));
    await swGate.db.end({ timeout: 2 });
  });

  it('is for account managers only, and a page of its own', async () => {
    for (const url of ['/api/software', '/api/software/blog']) {
      assert.equal((await member.get(url)).status, 404, url);
      assert.equal((await kept.get(url)).status, 404, `${url}: an account kept to one folder doesn't have it`);
      assert.equal((await new Browser('203.0.113.173').get(url)).status, 401, url);
    }
    assert.ok(PAGE_PATHS.includes('/software') && PAGE_PATHS.includes('/software/:id'));
  });

  it('lists what the helper says is installed, without asking the site', async () => {
    const r = await boss.get('/api/software');
    assert.equal(r.status, 200);
    // where a browser that once saw nginx's 301 still goes by itself
    assert.deepEqual((await boss.get('/api/software/')).json, r.json);
    assert.deepEqual(r.json.apps.map((a: { id: string; kindName: string; address: string; running: boolean }) => [a.id, a.kindName, a.address, a.running]),
      [['blog', 'WordPress', 'https://blog.pammy.org/', true]]);
    assert.equal(probed, 0);
  });

  it('shows one in full, and records nothing for looking', async () => {
    const before = (await actions()).length;
    const r = await boss.get('/api/software/blog');
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'running');
    assert.equal(r.json.version, '6.8.2');
    assert.equal(r.json.filesPath, '/pamela/wordpress');
    assert.equal(r.json.backups.count, 2);
    assert.equal(probed, 1);
    assert.equal((await actions()).length, before);
  });

  it('an address the helper could never have made is not a page', async () => {
    for (const id of ['Blog', 'blog.x', '-blog', 'a'.repeat(40)]) assert.equal((await boss.get(`/api/software/${id}`)).status, 404, id);
    const r = await boss.get('/api/software/shop');
    assert.deepEqual([r.status, r.json.message], [404, 'There is no such software.']);
  });

  it('says so plainly when the helper is not there', async () => {
    await new Promise<void>((r) => apps.close(() => r()));
    try {
      const r = await boss.get('/api/software');
      assert.equal(r.status, 503);
      assert.match(r.json.message, /software helper isn't answering/);
    } finally {
      await new Promise<void>((r) => apps.listen(join(dir, 'apps.sock'), r));
    }
  });

  it('phase 2: every change is for account managers, and a page kept to one folder has none of it', async () => {
    for (const [method, url] of [['GET', '/api/software/blog/backups'], ['POST', '/api/software/blog/backup'], ['POST', '/api/software/blog/restore'],
      ['GET', '/api/software/blog/backups/20260921T033012Z/download'], ['POST', '/api/software/blog/offline'], ['POST', '/api/software/blog/online'],
      ['GET', '/api/software/blog/admins'], ['POST', '/api/software/blog/admin-password'], ['GET', '/api/software/blog/logs']] as const) {
      assert.equal((await member.req(method, url, {})).status, 404, url);
      assert.equal((await kept.req(method, url, {})).status, 404, url);
    }
    assert.deepEqual(ran, []);
  });

  it('backs up now, and says who asked', async () => {
    const r = await boss.post('/api/software/blog/backup', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.job.op, 'backup');
    await settled();
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-backup' AND target = 'blog' AND actor_label = 'swboss'"));
    assert.equal((await boss.get('/api/software/blog')).json.recent[0].by, 'swboss');
    const list = await boss.get('/api/software/blog/backups');
    assert.deepEqual(list.json.backups.slice(1).map((b: { stamp: string }) => b.stamp), ['20260922T034501Z', '20260921T033012Z'], 'the new one first');
    assert.equal(list.json.backups[0].bytes, 4_000_000);
  });

  it('putting a backup back asks for the passkey again', async () => {
    advance(11 * 60);
    const early = await boss.post('/api/software/blog/restore', { stamp: '20260921T033012Z' });
    assert.deepEqual([early.status, early.json.error], [403, 'reauth-required']);
    assert.equal((await boss.confirm()).status, 200);
    for (const stamp of ['../x', 'yesterday', 12]) assert.equal((await boss.post('/api/software/blog/restore', { stamp })).status, 404, String(stamp));
    const r = await boss.post('/api/software/blog/restore', { stamp: '20260921T033012Z' });
    assert.deepEqual([r.status, r.json.job.op], [200, 'restore']);
    await settled();
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-restore' AND detail = 'the backup of 2026-09-21 03:30 UTC'"));
  });

  it('downloads a backup as a .tar, and records it', async () => {
    const r = await boss.get('/api/software/blog/backups/20260921T033012Z/download');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'], "attachment; filename*=UTF-8''wordpress-blog-backup-2026-09-21-0330.tar");
    assert.equal(r.headers['content-type'], 'application/x-tar');
    assert.equal(r.body, 'the tar');
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-backup-downloaded' AND detail = 'the backup of 2026-09-21 03:30 UTC'"));
    assert.equal((await boss.get('/api/software/blog/backups/20990101T000000Z/download')).status, 404);
    assert.equal((await boss.get('/api/software/blog/backups/..%2F..%2Fetc/download')).status, 404);
  });

  it('offline and online again', async () => {
    const off = await boss.post('/api/software/blog/offline', {});
    assert.deepEqual([off.status, off.json.job.op], [200, 'offline']);
    await settled();
    assert.equal((await boss.get('/api/software/blog')).json.state, 'offline');
    assert.equal((await boss.post('/api/software/blog/offline', {})).status, 409);
    assert.equal((await boss.post('/api/software/blog/online', {})).status, 200);
    await settled();
    assert.equal((await boss.get('/api/software/blog')).json.offline, null);
    assert.deepEqual((await all(db, "SELECT action FROM activity WHERE action LIKE 'software-o%' ORDER BY id") as { action: string }[]).map((x) => x.action), ['software-offline', 'software-online']);
  });

  it('a new admin password: passkey again, shown once, kept nowhere by the panel', async () => {
    assert.deepEqual((await boss.get('/api/software/blog/admins')).json, { admins: ['pamela'] });
    advance(11 * 60);
    assert.equal((await boss.post('/api/software/blog/admin-password', { user: 'pamela' })).json.error, 'reauth-required');
    assert.equal((await boss.confirm()).status, 200);
    const r = await boss.post('/api/software/blog/admin-password', { user: 'pamela' });
    assert.equal(r.status, 200);
    assert.match(r.json.password, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const row = await one<{ detail: string }>(db, "SELECT detail FROM activity WHERE action = 'software-admin-password'");
    assert.equal(row?.detail, 'for pamela');
    const everything = JSON.stringify(await all(db, 'SELECT * FROM activity'));
    assert.ok(!everything.includes(r.json.password), 'the activity never holds it');
    assert.equal((await boss.post('/api/software/blog/admin-password', { user: 'mallory' })).status, 404);
    assert.equal((await boss.post('/api/software/blog/admin-password', {})).status, 404);
  });

  it('shows its complaints', async () => {
    const logs = (await boss.get('/api/software/blog/logs')).json;
    assert.match(logs.web[0], /09:01:00.*a warning/);
    assert.match(logs.db[0], /09:02:00.*a warning/);
  });

  it('phase 3: the Email page is for account managers', async () => {
    for (const [method, url] of [['GET', '/api/mail'], ['POST', '/api/mail/settings'], ['POST', '/api/mail/notices'], ['POST', '/api/mail/test'], ['POST', '/api/software/blog/mail-test']] as const) {
      assert.equal((await member.req(method, url, {})).status, 404, url);
      assert.equal((await kept.req(method, url, {})).status, 404, url);
    }
    assert.ok(PAGE_PATHS.includes('/email'));
  });

  it('phase 3: set up mail (passkey again), and the key never comes back out', async () => {
    const before = (await boss.get('/api/mail')).json;
    assert.deepEqual([before.sending.keySet, before.sender.ready, before.sender.why], [false, false, 'No Resend key has been set.']);
    assert.deepEqual(before.notices, { forms: [], commentAreas: [], requests: false, lastSentAt: null, lastProblem: null, lastProblemAt: null });
    const KEY = 're_PammyPanelTestKey_9876';
    const SET = { key: KEY, from: 'noreply@mail.lesfleursdelanuit.com', replyTo: 'hello@pammy.org', notifyTo: 'hello@pammy.org' };
    advance(11 * 60);
    assert.equal((await boss.post('/api/mail/settings', SET)).json.error, 'reauth-required');
    assert.equal((await boss.confirm()).status, 200);
    const r = await boss.post('/api/mail/settings', SET);
    assert.equal(r.status, 200);
    assert.equal(r.json.keyEnds, '9876');
    assert.ok(!r.body.includes(KEY));
    const after = await boss.get('/api/mail');
    assert.ok(!after.body.includes(KEY), 'never shown again');
    assert.deepEqual([after.json.sending.keySet, after.json.sender.ready, after.json.sender.notifyTo], [true, true, 'hello@pammy.org']);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'mail-settings-changed' AND detail = 'a new key, ending 9876'"));
    assert.ok(!JSON.stringify(await all(db, 'SELECT * FROM activity')).includes(KEY));
    assert.equal((await boss.post('/api/mail/settings', { ...SET, key: '', notifyTo: 'not an address' })).status, 400);
  });

  it('phase 3: a test email from the panel, and one through WordPress', async () => {
    const r = await boss.post('/api/mail/test', {});
    assert.deepEqual([r.status, r.json.to], [200, 'hello@pammy.org']);
    assert.equal(resend.at(-1)!.subject, 'pammy.org: a test email');
    assert.deepEqual(resend.at(-1)!.to, ['hello@pammy.org']);
    const w = await boss.post('/api/software/blog/mail-test', {});
    assert.deepEqual([w.status, w.json.sent], [200, true]);
    assert.ok(ran.some((x) => x.includes(' eval ') && x.includes('hello@pammy.org')));
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'mail-test' AND detail = 'from WordPress (blog)'"));
  });

  it('phase 3: which notices -- only forms and comment areas that are there', async () => {
    const page = (await boss.get('/api/mail')).json;
    const form = page.forms.find((f: { kind: string }) => f.kind !== 'comments');
    assert.ok(form, 'the gate has a form');
    assert.equal((await boss.post('/api/mail/notices', { forms: [999999], commentAreas: [], requests: false })).status, 400);
    assert.equal((await boss.post('/api/mail/notices', { forms: [form.id], commentAreas: [form.id], requests: true })).status, 400, 'a form is not a comment area');
    const r = await boss.post('/api/mail/notices', { forms: [form.id, form.id], commentAreas: [], requests: true });
    assert.equal(r.status, 200);
    assert.deepEqual((await boss.get('/api/mail')).json.notices.forms, [form.id]);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'mail-notices-changed' AND detail = '1 form, access requests'"));
  });

  it('4a: moving it asks for the passkey, and never onto one of her folders', async () => {
    advance(11 * 60);
    assert.equal((await boss.post('/api/software/blog/move', { mode: 'path', name: 'diary' })).json.error, 'reauth-required');
    assert.equal((await boss.confirm()).status, 200);
    const mine = await boss.post('/api/software/blog/move', { mode: 'subdomain', name: 'Journal' });
    assert.deepEqual([mine.status, mine.json.message], [409, 'You have a folder called "journal", and journal.pammy.org shows it. Pick another name, or move or rename the folder first.']);
    assert.equal((await boss.post('/api/software/blog/move', { mode: 'sideways', name: 'x' })).status, 400);
    assert.equal((await boss.post('/api/software/blog/move', { mode: 'path', name: 'www' })).status, 400, 'the helper keeps the server\'s own names');
    const r = await boss.post('/api/software/blog/move', { mode: 'path', name: 'diary' });
    assert.deepEqual([r.status, r.json.job.op], [200, 'move']);
    await settled();
    const s = (await boss.get('/api/software/blog')).json;
    assert.equal(s.recent[0].ok, true, s.recent[0].message);
    assert.equal(s.address, 'https://pammy.org/diary/');
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-move' AND detail = 'to pammy.org/diary/'"));
    assert.equal((await member.post('/api/software/blog/move', { mode: 'root' })).status, 404);
  });

  it('4b: installing a new WordPress: passkey again, never over one of her folders, and its password once', async () => {
    const REQ = { placement: { mode: 'subdomain', name: 'garden' }, title: 'The garden', adminUser: 'pamela', adminEmail: 'hello@pammy.org' };
    advance(11 * 60);
    assert.equal((await boss.post('/api/software/install', REQ)).json.error, 'reauth-required');
    assert.equal((await boss.confirm()).status, 200);
    const mine = await boss.post('/api/software/install', { ...REQ, placement: { mode: 'path', name: 'journal' } });
    assert.deepEqual([mine.status, mine.json.message], [409, 'You have a folder called "journal", and pammy.org/journal/ shows it. Pick another name.']);
    assert.equal((await boss.post('/api/software/install', { ...REQ, title: '' })).status, 400);
    const r = await boss.post('/api/software/install', REQ);
    assert.deepEqual([r.status, r.json.id, r.json.job.op], [200, 'garden', 'install']);
    for (let i = 0; i < 200 && (await boss.get('/api/software/garden')).json.job; i++) await new Promise((res) => setTimeout(res, 5));
    const s = (await boss.get('/api/software/garden')).json;
    assert.equal(s.recent[0].ok, true, s.recent[0].message);
    assert.deepEqual([s.state, s.address], ['running', 'https://garden.pammy.org/']);
    assert.deepEqual((await boss.get('/api/software')).json.apps.map((a: { id: string }) => a.id), ['blog', 'garden']);
    const login = await boss.post('/api/software/garden/login', {});
    assert.equal(login.headers['cache-control'], 'no-store');
    assert.equal(login.json.login.user, 'pamela');
    assert.match(login.json.login.password, /^[A-Za-z0-9_-]{24}$/);
    assert.deepEqual((await boss.post('/api/software/garden/login', {})).json, { login: null }, 'only once');
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-install' AND target = 'garden' AND detail = 'at garden.pammy.org'"));
    assert.ok(!JSON.stringify(await all(db, 'SELECT * FROM activity')).includes(login.json.login.password));
    assert.equal((await member.post('/api/software/install', REQ)).status, 404);
    assert.equal((await kept.post('/api/software/install', REQ)).status, 404);
  });

  it('4c: delete (passkey, its name typed), restore (neither), delete for good (both)', async () => {
    const until = async (id: string) => { for (let i = 0; i < 400 && (await boss.get(`/api/software/${id}`)).json.job; i++) await new Promise((res) => setTimeout(res, 5)); };
    advance(11 * 60);
    assert.equal((await boss.post('/api/software/garden/delete', { confirm: 'garden' })).json.error, 'reauth-required');
    assert.equal((await boss.confirm()).status, 200);
    const wrong = await boss.post('/api/software/garden/delete', { confirm: 'blog' });
    assert.deepEqual([wrong.status, wrong.json.message], [400, 'Type its name, "garden", to delete it.']);
    assert.equal((await member.post('/api/software/garden/delete', { confirm: 'garden' })).status, 404);
    const r = await boss.post('/api/software/garden/delete', { confirm: 'garden' });
    assert.deepEqual([r.status, r.json.job.op], [200, 'delete']);
    await until('garden');
    let s = (await boss.get('/api/software/garden')).json;
    assert.equal(s.recent[0].ok, true, s.recent[0].message);
    assert.deepEqual([s.state, s.deleted.until - s.deleted.at], ['deleted', 30 * 86400]);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-delete' AND target = 'garden'"));
    // restoring loses nothing: no fresh passkey asked
    advance(11 * 60);
    assert.equal((await boss.post('/api/software/garden/undelete', {})).status, 200);
    await until('garden');
    s = (await boss.get('/api/software/garden')).json;
    assert.deepEqual([s.state, s.deleted], ['offline', null], JSON.stringify(s.problems));
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-undelete' AND target = 'garden'"));
    // for good: from the deleted software only, passkey and name again
    assert.equal((await boss.confirm()).status, 200);
    assert.equal((await boss.post('/api/software/garden/purge', { confirm: 'garden' })).status, 409);
    await boss.post('/api/software/garden/delete', { confirm: 'garden' });
    await until('garden');
    assert.equal((await boss.post('/api/software/garden/purge', {})).status, 400);
    // two accounts that had its files as a place (catalog step 3b): one only that, one a folder too
    const only = await createUser(db, clock, COMMAND_LINE, 'gardenonly', 'Garden only', 'member', { rights: ['files'], places: ['software:garden'] });
    const mixed = await createUser(db, clock, COMMAND_LINE, 'gardenmixed', 'Garden and club', 'member', { rights: ['files', 'forms'], places: ['/club', 'software:garden'] });
    assert.equal((await boss.post('/api/software/garden/purge', { confirm: 'garden' })).status, 200);
    for (let i = 0; i < 400 && (await boss.get('/api/software/garden')).status === 200; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal((await boss.get('/api/software/garden')).status, 404);
    assert.deepEqual((await boss.get('/api/software')).json.apps.map((a: { id: string }) => a.id), ['blog']);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'software-purge' AND target = 'garden'"));
    // gone for good: its place is taken off; the one it was the only place of has nothing left (never the whole site)
    const placesOf = async (id: number) => (await all<{ place: string }>(db, 'SELECT place FROM user_places WHERE user_id = ? ORDER BY place', id)).map((r) => r.place);
    const rightsOf = async (id: number) => (await all<{ name: string }>(db, 'SELECT name FROM user_rights WHERE user_id = ? ORDER BY name', id)).map((r) => r.name);
    assert.deepEqual([await placesOf(only.id), await rightsOf(only.id)], [[], []]);
    assert.deepEqual([await placesOf(mixed.id), await rightsOf(mixed.id)], [['/club'], ['files', 'forms']]);
    assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'user-places-changed' AND target = 'gardenonly' AND detail LIKE '%their only place%'"));
  });

  it('File Explorer on the blog\'s wp-content (catalog step 3): for anyone with files not kept to places, .php for account managers only', async () => {
    // the blog's files helper, as pammy-rootfs@blog runs it (its software mode)
    const content = join(dir, 'blog-wp-content');
    mkdirSync(join(content, 'themes', 'rose'), { recursive: true });
    mkdirSync(join(dir, 'blog-files-trash'), { recursive: true });
    writeFileSync(join(content, 'themes', 'rose', 'style.css'), 'body {}\n');
    writeFileSync(join(content, 'themes', 'rose', 'functions.php'), '<?php // rose\n');
    const rootfs = createSiteFsServer({ publicDir: content, trashDir: join(dir, 'blog-files-trash'), placementFile: null, domain: 'pammy.org', siteName: 'pammy.org',
      folderSubdomains: false, maxUpload: 100 * 1024 * 1024, purgeDays: 30, kind: 'software', now: () => new Date(clock * 1000) });
    await new Promise<void>((r) => rootfs.listen(join(dir, 'rootfs-blog.sock'), r));
    try {
      const top = (await boss.get('/api/files')).json;
      assert.equal(top.root, 'website');
      assert.deepEqual(top.roots.map((r: { id: string }) => r.id), ['website', 'software-blog']);
      assert.deepEqual((await member.get('/api/files')).json.roots.map((r: { id: string }) => r.id), ['website', 'software-blog']);
      // kept to a place: the website's folders they have, never software
      assert.deepEqual((await kept.get('/api/files')).json.roots.map((r: { id: string }) => r.id), ['website']);
      assert.equal((await kept.get('/api/files/items?root=software-blog&dir=')).status, 404);
      assert.equal((await boss.get('/api/files/items?root=software-shop&dir=')).status, 404);

      const tree = (await boss.get('/api/files?root=software-blog')).json;
      assert.deepEqual([tree.root, tree.sync, tree.dirs], ['software-blog', null, ['', 'themes', 'themes/rose']]);
      const l = (await member.get('/api/files/items?root=software-blog&dir=themes/rose')).json;
      assert.deepEqual(l.files.map((f: { path: string }) => f.path), ['themes/rose/functions.php', 'themes/rose/style.css']);
      assert.equal((await member.get('/api/files/file?root=software-blog&path=themes/rose/style.css')).body, 'body {}\n');

      // the editor: text for anyone; .php read-only unless an account manager
      const css = (await member.get('/api/files/text?root=software-blog&path=themes/rose/style.css')).json;
      assert.equal(css.readOnly, false);
      assert.equal((await member.post('/api/files/save', { root: 'software-blog', path: 'themes/rose/style.css', text: 'p {}\n', expect: css.hash })).status, 200);
      assert.equal(readFileSync(join(content, 'themes', 'rose', 'style.css'), 'utf8'), 'p {}\n');
      const phpM = (await member.get('/api/files/text?root=software-blog&path=themes/rose/functions.php')).json;
      assert.equal(phpM.readOnly, true);
      const refused = await member.post('/api/files/save', { root: 'software-blog', path: 'themes/rose/functions.php', text: '<?php // mine', expect: phpM.hash });
      assert.deepEqual([refused.status, refused.json.message], [400, 'Only panel admins can put or change .php files here.']);
      const phpB = (await boss.get('/api/files/text?root=software-blog&path=themes/rose/functions.php')).json;
      assert.equal(phpB.readOnly, false);
      assert.equal((await boss.post('/api/files/save', { root: 'software-blog', path: 'themes/rose/functions.php', text: '<?php // boss\n', expect: phpB.hash })).status, 200);
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'file-saved' AND target = 'blog: wp-content/themes/rose/functions.php'"));
      assert.equal((await boss.get('/api/files/versions?root=software-blog&path=themes/rose/functions.php')).json.versions.length, 1);
      // no records for a software root: the website's catalogue is untouched
      assert.equal(await one(db, "SELECT 1 FROM files.records WHERE path LIKE 'themes/%'"), undefined);

      // move, trash and restore, through the same routes with root
      assert.equal((await member.post('/api/files/mkdir', { root: 'software-blog', dir: 'themes', name: 'lily' })).status, 200);
      assert.equal((await member.post('/api/files/move', { root: 'software-blog', from: 'themes/rose/functions.php', to: 'themes/lily' })).status, 403);
      assert.equal((await member.post('/api/files/move', { root: 'software-blog', from: 'themes/rose/style.css', to: 'themes/lily' })).json.path, 'themes/lily/style.css');
      const t = (await member.post('/api/files/trash', { root: 'software-blog', path: 'themes/lily/style.css' })).json;
      assert.equal(t.path, 'themes/lily/style.css');
      assert.deepEqual((await member.get('/api/files/trash?root=software-blog')).json.items.map((x: { id: string }) => x.id), [t.id]);
      // without root: the website's trash (docs/phase8-plan.md step 8-1), not the blog's
      const site = await member.get('/api/files/trash');
      assert.equal(site.status, 200);
      assert.ok(!site.json.items.some((x: { id: string }) => x.id === t.id));
      assert.equal((await member.post('/api/files/restore', { root: 'software-blog', id: t.id })).json.path, 'themes/lily/style.css');
      assert.ok(await one(db, "SELECT 1 FROM activity WHERE action = 'file-restored' AND target = 'blog: wp-content/themes/lily/style.css'"));
      // the website, asked without root, as ever
      assert.equal((await boss.get('/api/files/items?dir=')).json.mode, 'browse');

      // step 3b: the blog's files as a place
      const soft = new Browser('203.0.113.173');
      const u = await createUser(db, clock, COMMAND_LINE, 'swblog', 'Blog helper', 'member', { rights: ['files'], places: ['software:blog'] });
      assert.equal((await soft.useInvite((await createInvite(db, clock, COMMAND_LINE, u)).token)).status, 200);
      const mine = (await soft.get('/api/files')).json;
      assert.deepEqual([mine.root, mine.roots.map((r: { id: string }) => r.id)], [null, ['software-blog']]);
      assert.equal((await soft.get('/api/files/items?root=software-blog&dir=themes')).status, 200);
      assert.equal((await soft.get('/api/files/items?dir=')).status, 404);
      assert.equal((await soft.get('/api/files?root=website')).status, 404);
      // the Tags page is File Explorer's too: it answers, with none of the website's labels or scopes (never the whole site's)
      assert.deepEqual((await soft.get('/api/media/scopes')).json, { scopes: [] });
      assert.deepEqual((await soft.get('/api/media/labels')).json.labels ?? [], []);
      assert.deepEqual((await soft.get('/api/session')).json.user.rights, ['files']);
      assert.equal((await soft.get('/api/files/text?root=software-blog&path=themes/rose/functions.php')).json.readOnly, true);
      // a folder and the blog: both roots; the forms part still asks the gate with the folder only
      advance(11 * 60);
      assert.equal((await boss.confirm()).status, 200);
      const keptId = (await one<{ id: number }>(db, "SELECT id FROM users WHERE username = 'swkept'"))!.id;
      const both = await boss.post(`/api/users/${keptId}/access`, { rights: ['files', 'forms'], places: ['/journal', 'software:blog'] });
      assert.equal(both.status, 200, JSON.stringify(both.json));
      assert.deepEqual((await kept.get('/api/files')).json.roots.map((r: { id: string }) => r.id), ['website', 'software-blog']);
      assert.equal((await kept.get('/api/forms')).status, 200);
      // only software: File Explorer only; and only software that is installed
      const wide = await boss.post(`/api/users/${u.id}/access`, { rights: ['files', 'forms'], places: ['software:blog'] });
      assert.deepEqual([wide.status, wide.json.message], [409, 'Someone kept only to installed software can have File Explorer, not forms: that part is about the website.']);
      const gone = await boss.post(`/api/users/${u.id}/access`, { rights: ['files'], places: ['software:shop'] });
      assert.deepEqual([gone.status, gone.json.message], [404, "There's no installed software called shop."]);
    } finally {
      await new Promise<void>((r) => rootfs.close(() => r()));
    }
  });
});
