// The gate: its access decisions on a real folder tree, sign-in and sign-out,
// and its admin socket. What nginx does around it is in run-gate-nginx-test.sh.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { all, one, run, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { callJsonLine } from '@panel/core/jsonline';
import { createGateAdminServer, handleAdmin } from '@panel/pammy/gate/admin';
import { buildGateApp, EXAMPLE_FILES, EXAMPLE_LOOKS } from '@panel/pammy/gate/app';
import type { Server } from 'node:net';
import type { Driver } from '@panel/studio/pammydb/driver';
import { createPammyDbServer } from '@panel/studio/pammydb/service';
import { memoryRows, memorySchemas } from './studio-stub.ts';
import { EXAMPLES, examplePage, type ExampleKind } from '@panel/examples/gate/examples';
import { parseGuide } from '@panel/help/help';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { addResponse } from '@panel/forms/gate/forms/responses';
import { formById } from '@panel/forms/gate/forms/store';
import { retrySaves, saveResponse } from '@panel/form-links/gate/saves/save';
import { claim, retryDue, settle } from '@panel/form-links/gate/saves/queue';
import { startProxy } from './fake-pammydb.ts';
import { seedGate } from './gate-seed.ts';
import { startPg, type PgTest } from './pg-harness.ts';
import { request as httpRequest } from 'node:http';
import { createPhpServer } from '@panel/php/gate/php-socket';

let root: string;
let pub: string;
let pg: PgTest;
let db: Sql;
let database: string;       // the gate's and the panel's schemas, side by side (the media API's index)
let live: GateLive;
let app: FastifyInstance;
let clock = 1_800_000_000;
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};

const file = (rel: string, text = rel) => { mkdirSync(join(pub, rel, '..'), { recursive: true }); writeFileSync(join(pub, rel), text); };
const admin = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }) as Promise<any>;
const mark = (dir: string, token: string) => writeFileSync(join(pub, dir, '.pammy-protected'), `pammy-protected ${token}\n`);

async function protect(key: string, path: string, marker = true) {
  const a = await admin({ op: 'area.create', path });
  ids[key] = a.id;
  tokens[key] = a.token;
  if (marker) mark(path, a.token);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pammy-gate-test-'));
  pub = join(root, 'public');
  pg = await startPg();
  database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('gate', database, 8);
  live = new GateLive(db, { sessions: visitorSessions, now: () => clock });
  live.markReady();
  await live.reloadAreas();
  await seedGate(db, clock);
  app = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(root, 'media-public', 'index.db'), mediaThumbs: join(root, 'media-public', 'thumbs') }, live);

  file('index.html'); file('open/index.html'); file('recipes/index.html');
  file('recipes/private/index.html'); file('recipes/private/secret.jpg');
  file('recipes/private/login.html'); file('recipes/private/login-files/style.css');
  for (const f of ['Banner.JPG', 'photo.webp', 'logo.svg', 'hand.woff2', 'notes.txt', 'page.html', 'secret.pdf', '.hidden.css', 'style.css.bak', 'sub/x.css', 'sub/deeper/y.png', 'dir.css/z.txt']) {
    file(`recipes/private/login-files/${f}`);
  }
  symlinkSync(join(pub, 'recipes', 'private', 'secret.jpg'), join(pub, 'recipes', 'private', 'login-files', 'pointer.jpg'));
  file('recipes/private/login-forgot.html'); file('recipes/private/login-request.html'); file('recipes/private/login-other.html');
  file('recipes/private/logout.html'); file('recipes/private/logout-old.html');
  file('members/login-invite.html'); file('members/login-forgot.html/inside.txt');
  // a protected folder with no index.html: pages, a subfolder with a home page, one without, and a nested area
  file('bare/login.html'); file('bare/about.html'); file('bare/media/images/x.jpg'); file('bare/media/index.html'); file('bare/photo.jpg'); file('bare/.hidden.html');
  file('bare/privacy/index.html'); file('bare/drafts/notes.txt'); file('bare/inner/index.html'); file('bare/login-files/x.css');
  file('recipes/private/inner/x.html');
  file('members/index.html');
  file('dbonly/a.html');
  file('locked/a.html');
  file('garbage/a.html');
  symlinkSync(join(pub, 'recipes', 'private'), join(pub, 'alias'));
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(root, 'elsewhere', 'x.txt'), 'x');
  symlinkSync(join(root, 'elsewhere'), join(pub, 'out'));

  await protect('A', 'recipes/private');
  await protect('B', 'recipes/private/inner');
  await protect('C', 'members');
  await protect('D', 'dbonly', false);
  mark('locked', 'Z'.repeat(32));
  writeFileSync(join(pub, 'garbage', '.pammy-protected'), 'hello');

  for (const [u, areas] of [['alice', ['A']], ['bob', ['A', 'B']], ['carol', ['A']]] as const) {
    const v = await admin({ op: 'visitor.create', username: u, name: u.toUpperCase(), password: `${u}-password-123` });
    ids[u] = v.id;
    for (const a of areas) await admin({ op: 'grant', visitorId: v.id, areaId: ids[a], allow: true });
  }
  await admin({ op: 'visitor.active', id: ids.carol, active: false });
});
after(async () => { await app?.close(); await db?.end({ timeout: 2 }); pg?.stop(); rmSync(root, { recursive: true, force: true }); });

// ------------------------------------------------------------------ helpers
type Check = { status: number; login?: string; cache?: string; user?: string; account?: string; role?: string; privileges?: string };
async function check(uri: string, opts: { host?: string; base?: string | null; cookie?: string; next?: string } = {}): Promise<Check> {
  const res = await app.inject({
    method: 'GET', url: '/check', remoteAddress: '127.0.0.1',
    headers: {
      host: opts.host ?? 'pammy.org', ...(opts.base === null ? {} : { 'x-pammy-base': opts.base ?? '/' }), 'x-pammy-uri': uri,
      'x-pammy-next': opts.next ?? uri, ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
  });
  return {
    status: res.statusCode, login: res.headers['x-pammy-login'] as string | undefined, cache: res.headers['x-pammy-cache'] as string | undefined,
    user: res.headers['x-pammy-user'] as string | undefined,
    account: res.headers['x-pammy-account'] as string | undefined,
    role: res.headers['x-pammy-role'] as string | undefined,
    privileges: res.headers['x-pammy-privileges'] as string | undefined,
  };
}

async function login(body: Record<string, unknown>, opts: { host?: string; base?: string; origin?: string; ip?: string } = {}) {
  const host = opts.host ?? 'pammy.org';
  const res = await app.inject({
    method: 'POST', url: '/_pammy/login', remoteAddress: '127.0.0.1',
    headers: {
      host, 'x-pammy-base': opts.base ?? '/', origin: opts.origin ?? `https://${host}`,
      'content-type': 'application/json', 'x-real-ip': opts.ip ?? `198.51.100.${Math.floor(Math.random() * 200)}`,
    },
    payload: JSON.stringify(body),
  });
  const set = res.headers['set-cookie'];
  const cookie = set ? String(set).split(';')[0] : undefined;
  return { status: res.statusCode, json: res.json(), cookie, setCookie: set ? String(set) : '' };
}

// ------------------------------------------------------------------ decisions
describe('who gets through (no one signed in)', () => {
  it('lets anything unprotected through, without the private cache header', async () => {
    for (const u of ['/', '/index.html', '/open/', '/recipes/', '/nope.html']) {
      const r = await check(u);
      assert.equal(r.status, 204, u);
      assert.equal(r.cache, undefined, u);
    }
  });

  it("sends a protected folder to its own login.html, with where they wanted to go", async () => {
    const r = await check('/recipes/private/');
    assert.equal(r.status, 401);
    assert.equal(r.login, '/recipes/private/login.html?next=%2Frecipes%2Fprivate%2F');
    assert.equal(r.cache, 'private, no-store');
  });

  it('uses the address they came in on for subdomains', async () => {
    const r = await check('/private/secret.jpg', { host: 'recipes.pammy.org', base: '/recipes' });
    assert.equal(r.status, 401);
    assert.equal(r.login, '/private/login.html?next=%2Fprivate%2Fsecret.jpg');
  });

  it('lets the login page and the look files in login-files through, still marked private', async () => {
    for (const u of ['/recipes/private/login.html', '/recipes/private/login-files/style.css', '/recipes/private/login-files/Banner.JPG',
      '/recipes/private/login-files/photo.webp', '/recipes/private/login-files/logo.svg', '/recipes/private/login-files/hand.woff2']) {
      const r = await check(u);
      assert.equal(r.status, 204, u);
      assert.equal(r.cache, 'private, no-store', u);
    }
  });

  it('keeps anything else in login-files private: other kinds of file, hidden files, subfolders, shortcuts out', async () => {
    for (const f of ['notes.txt', 'page.html', 'secret.pdf', '.hidden.css', 'style.css.bak', 'sub/', 'sub/x.css', 'sub/deeper/y.png',
      'dir.css', 'dir.css/', 'dir.css/z.txt', 'pointer.jpg', 'missing.css']) {
      const r = await check(`/recipes/private/login-files/${f}`);
      assert.equal(r.status, 401, f);
      assert.match(r.login!, /^\/recipes\/private\/login\.html\?/, f);
    }
  });

  it('protects everything else inside, including missing files and paths through files', async () => {
    for (const u of ['/recipes/private/secret.jpg', '/recipes/private/index.html', '/recipes/private/nope.html',
      '/recipes/private/secret.jpg/more', '/recipes/private/login-files/', '/recipes/private/.pammy-protected',
      '/recipes/private/inner/x.html', '/recipes/private']) {
      assert.equal((await check(u)).status, 401, u);
    }
  });

  it('follows shortcuts: a symlink into a protected folder is protected', async () => {
    const r = await check('/alias/secret.jpg');
    assert.equal(r.status, 401);
    assert.match(r.login!, /^\/recipes\/private\/login\.html\?/);
    assert.equal((await check('/alias/login.html')).status, 204, 'its login page is still reachable through the shortcut');
  });

  it('uses the built-in sign-in page when a folder has no login.html', async () => {
    const r = await check('/members/');
    assert.equal(r.status, 401);
    assert.equal(r.login, `/_pammy/login?next=%2Fmembers%2F&area=${tokens.C}`);
  });

  it('protects by the database path when the marker is gone', async () => {
    assert.equal((await check('/dbonly/a.html')).status, 401);
  });

  it('locks folders whose marker is unknown or unreadable, for everyone', async () => {
    assert.equal((await check('/locked/a.html')).status, 401);
    assert.equal((await check('/garbage/a.html')).status, 401);
  });

  it("refuses requests nginx wouldn't send: no path, dot segments, odd bases, foreign hosts", async () => {
    assert.equal((await check('')).status, 403);
    assert.equal((await check('/recipes/private/../open/')).status, 403);
    assert.equal((await check('/x', { base: '/../recipes' })).status, 403);
    assert.equal((await check('/x', { base: 'recipes' })).status, 403);
    assert.equal((await check('/x', { base: '' })).status, 403, 'an empty base is not the main site');
    assert.equal((await check('/x', { base: null })).status, 403, 'nor is a missing one');
    assert.equal((await check('/x', { host: 'evil.example' })).status, 403);
  });

  it("leaves paths that really live outside the web root to nginx's normal rules", async () => {
    assert.equal((await check('/out/x.txt')).status, 204);
  });
});

describe('signing in', () => {
  let alice = '';

  it('refuses sign-ins from another site', async () => {
    const r = await login({ username: 'alice', password: 'alice-password-123', page: '/recipes/private/login.html' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(r.cookie, undefined);
  });

  it('refuses a wrong password, an unknown user and a switched-off one with the same message', async () => {
    const page = '/recipes/private/login.html';
    const a = await login({ username: 'alice', password: 'wrong-password-1', page });
    const b = await login({ username: 'nobody', password: 'alice-password-123', page });
    const c = await login({ username: 'carol', password: 'carol-password-123', page });
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.equal(r.json.message, "That username and password don't match.");
      assert.equal(r.cookie, undefined);
    }
  });

  it('signs in from the folder login page and sends them to the folder', async () => {
    const r = await login({ username: ' Alice ', password: 'alice-password-123', page: '/recipes/private/login.html' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.next, '/recipes/private/');
    assert.match(r.setCookie, /^__Host-pammy_visitor=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    alice = r.cookie!;
  });

  it('then lets them in, marked private so nothing caches it', async () => {
    const r = await check('/recipes/private/secret.jpg', { cookie: alice });
    assert.equal(r.status, 204);
    assert.equal(r.cache, 'private, no-store');
    assert.equal((await check('/alias/secret.jpg', { cookie: alice })).status, 204);
  });

  it("keeps a nested folder closed to someone who can only open the outer one", async () => {
    const r = await check('/recipes/private/inner/x.html', { cookie: alice });
    assert.equal(r.status, 401);
    assert.match(r.login!, /denied=1/);
    assert.match(r.login!, new RegExp(`area=${tokens.B}`));
  });

  it('only honours the session on the hostname it was made on', async () => {
    assert.equal((await check('/private/secret.jpg', { host: 'recipes.pammy.org', base: '/recipes', cookie: alice })).status, 401);
    const r = await login({ username: 'alice', password: 'alice-password-123', page: '/private/login.html' }, { host: 'recipes.pammy.org', base: '/recipes' });
    assert.equal(r.status, 200);
    assert.equal(r.json.next, '/private/');
    assert.equal((await check('/private/secret.jpg', { host: 'recipes.pammy.org', base: '/recipes', cookie: r.cookie })).status, 204);
  });

  it('refuses someone signing in to a folder they have no access to, even with the right password', async () => {
    const r = await login({ username: 'alice', password: 'alice-password-123', area: tokens.C });
    assert.equal(r.status, 403);
    assert.equal(r.cookie, undefined);
  });

  it("only accepts real sign-in pages and known areas", async () => {
    assert.equal((await login({ username: 'alice', password: 'alice-password-123', page: '/open/index.html' })).status, 400);
    assert.equal((await login({ username: 'alice', password: 'alice-password-123', page: '/open/login.html' })).status, 400);
    assert.equal((await login({ username: 'alice', password: 'alice-password-123', area: 'Z'.repeat(32) })).status, 400);
    assert.equal((await login({ username: 'alice', password: 'alice-password-123', page: 'https://evil.example/login.html' })).status, 400);
  });

  it('only redirects to a path on the same hostname', async () => {
    const page = '/recipes/private/login.html';
    const ok = await login({ username: 'bob', password: 'bob-password-123', page, next: '/recipes/private/secret.jpg?x=1' });
    assert.equal(ok.json.next, '/recipes/private/secret.jpg?x=1');
    for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      assert.equal((await login({ username: 'bob', password: 'bob-password-123', page, next })).json.next, '/recipes/private/', next);
    }
    assert.equal((await check('/recipes/private/inner/x.html', { cookie: ok.cookie })).status, 204);
  });

  it('shows who is signed in', async () => {
    const res = await app.inject({ method: 'GET', url: '/_pammy/me', headers: { host: 'pammy.org', cookie: alice } });
    assert.deepEqual(res.json(), { signedIn: true, username: 'alice', name: 'ALICE', email: null, emailConfirmed: false, registered: false });
  });

  it('switching someone off, or changing their password, locks them out at once', async () => {
    const b = await login({ username: 'bob', password: 'bob-password-123', page: '/recipes/private/login.html' });
    await admin({ op: 'visitor.password', id: ids.bob, password: 'bob-new-password-456' });
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: b.cookie })).status, 401);

    await admin({ op: 'visitor.active', id: ids.alice, active: false });
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: alice })).status, 401);
    await admin({ op: 'visitor.active', id: ids.alice, active: true });
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: alice })).status, 401, 'switching back on does not revive old sessions');
  });

  it('removing access locks them out at once', async () => {
    const r = await login({ username: 'alice', password: 'alice-password-123', page: '/recipes/private/login.html' });
    await admin({ op: 'grant', visitorId: ids.alice, areaId: ids.A, allow: false });
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: r.cookie })).status, 401);
    await admin({ op: 'grant', visitorId: ids.alice, areaId: ids.A, allow: true });
  });

  it('signs out', async () => {
    const r = await login({ username: 'alice', password: 'alice-password-123', page: '/recipes/private/login.html' });
    const out = await app.inject({
      method: 'POST', url: '/_pammy/logout',
      headers: { host: 'pammy.org', origin: 'https://pammy.org', 'content-type': 'application/json', cookie: r.cookie! }, payload: '{}',
    });
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.json(), { ok: true }, "no page named: nowhere to send them");
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: r.cookie })).status, 401);
  });

  it("after signing out, sends them to the folder's signed-out page (hers, or the built-in one)", async () => {
    const out = async (payload: object, host = 'pammy.org', base = '/') => (await app.inject({
      method: 'POST', url: '/_pammy/logout',
      headers: { host, 'x-pammy-base': base, origin: `https://${host}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload),
    })).json();
    // from any page in the folder (a <pammy-logout> button), a sign-in page, or her logout.html itself
    for (const page of ['/recipes/private/secret.jpg', '/recipes/private/login.html', '/recipes/private/logout.html']) {
      assert.deepEqual(await out({ page }), { ok: true, next: '/recipes/private/logout.html' }, page);
    }
    assert.equal((await out({ page: '/recipes/private/inner/x.html' })).next, `/_pammy/logout?area=${tokens.B}`, 'a folder protected on its own inside: its own (built-in) page');
    assert.equal((await out({ page: '/private/secret.jpg' }, 'recipes.pammy.org', '/recipes')).next, '/private/logout.html', 'on the subdomain address');
    assert.equal((await out({ page: '/members/index.html' })).next, `/_pammy/logout?area=${tokens.C}`, 'no logout.html: the built-in page');
    assert.equal((await out({ area: tokens.C })).next, `/_pammy/logout?area=${tokens.C}`);
    for (const payload of [{ page: '/open/index.html' }, { page: '//evil.example/x' }, { area: 'Z'.repeat(32) }, {}]) {
      assert.deepEqual(await out(payload), { ok: true }, JSON.stringify(payload));
    }
  });

  it('has a built-in signed-out page', async () => {
    const r = await app.inject({ method: 'GET', url: `/_pammy/logout?area=${tokens.C}`, headers: { host: 'pammy.org', 'x-pammy-base': '/' } });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, new RegExp(`<pammy-signed-out area="${tokens.C}"></pammy-signed-out>`));
    assert.match(r.body, /<title>Signed out · pammy\.org<\/title>/);
  });

  it('sessions last 30 days', async () => {
    const r = await login({ username: 'alice', password: 'alice-password-123', page: '/recipes/private/login.html' });
    clock += 29 * 86400;
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: r.cookie })).status, 204);
    clock += 2 * 86400;
    assert.equal((await check('/recipes/private/secret.jpg', { cookie: r.cookie })).status, 401);
  });

  it('limits sign-in attempts per visitor IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await login({ username: 'alice', password: 'wrong-password-1', page: '/recipes/private/login.html' }, { ip: '203.0.113.200' })).status;
    }
    assert.equal(last, 429);
  });
});

// ------------------------------------------------------------------ self-service pages
async function postTo(url: string, body: Record<string, unknown>, opts: { host?: string; base?: string; origin?: string; ip?: string } = {}) {
  const host = opts.host ?? 'pammy.org';
  const res = await app.inject({
    method: 'POST', url, remoteAddress: '127.0.0.1',
    headers: {
      host, 'x-pammy-base': opts.base ?? '/', origin: opts.origin ?? `https://${host}`,
      'content-type': 'application/json', 'x-real-ip': opts.ip ?? `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    payload: JSON.stringify(body),
  });
  const set = res.headers['set-cookie'];
  return { status: res.statusCode, json: res.json(), cookie: set ? String(set).split(';')[0] : undefined };
}
const requestsRows = () => all<{ id: number; kind: string; area_id: number | null; visitor_id: number | null; name: string; contact: string; message: string; status: string; handled_by: string | null }>(db, 'SELECT * FROM requests ORDER BY id');
const tokenOf = (url: string) => url.split('#')[1]!;
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

describe('self-service pages: what anyone can reach', () => {
  it('lets all five sign-in pages through before signing in, and nothing else starting with "login" or "logout"', async () => {
    for (const u of ['/recipes/private/login-forgot.html', '/recipes/private/login-request.html', '/members/login-invite.html', '/recipes/private/logout.html']) {
      const r = await check(u);
      assert.equal(r.status, 204, u);
      assert.equal(r.cache, 'private, no-store', u);
    }
    for (const u of ['/recipes/private/login-other.html', '/recipes/private/login-invite.html', '/members/login-forgot.html/inside.txt', '/members/login-forgot.html/',
      '/recipes/private/logout-old.html', '/members/logout.html']) {
      assert.equal((await check(u)).status, 401, u);
    }
  });

  it("tells the components which pages a folder has, on the address they're using", async () => {
    const get = async (q: string, host = 'pammy.org', base = '/') =>
      app.inject({ method: 'GET', url: `/_pammy/about?${q}`, headers: { host, 'x-pammy-base': base } });
    const own = await get('page=/recipes/private/login.html');
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.json(), { requestsOpen: true, pages: {
      login: '/recipes/private/login.html', forgot: '/recipes/private/login-forgot.html', request: '/recipes/private/login-request.html',
      logout: '/recipes/private/logout.html' } });
    const sub = await get('page=/private/login-request.html', 'recipes.pammy.org', '/recipes');
    assert.equal(sub.json().pages.forgot, '/private/login-forgot.html');
    const builtIn = await get(`area=${tokens.C}`);
    assert.deepEqual(builtIn.json().pages, {
      login: `/_pammy/login?area=${tokens.C}`, forgot: `/_pammy/forgot?area=${tokens.C}`, request: `/_pammy/request?area=${tokens.C}`,
      logout: `/_pammy/logout?area=${tokens.C}` });
    assert.equal((await get('page=/recipes/private/logout.html')).statusCode, 200, 'her logout.html finds its folder too');
    assert.equal((await get('page=/members/login-invite.html')).json().pages.forgot, `/_pammy/forgot?area=${tokens.C}`, "a page the folder doesn't have is the built-in one");
    for (const q of ['page=/open/index.html', 'page=/recipes/private/index.html', `area=${'Z'.repeat(32)}`, 'page=//evil.example/login.html', '']) {
      assert.equal((await get(q)).statusCode, 404, q);
    }
  });

  it('serves the built-in pages, each with its own component, and only a well-formed area', async () => {
    for (const [kind, tag] of [['forgot', 'pammy-forgot'], ['request', 'pammy-request'], ['invite', 'pammy-invite']]) {
      const res = await app.inject({ method: 'GET', url: `/_pammy/${kind}?area=${tokens.C}`, headers: { host: 'pammy.org' } });
      assert.equal(res.statusCode, 200, kind);
      assert.match(res.body, new RegExp(`<${tag}[ >]`), kind);
      assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
      assert.doesNotMatch(res.body, /@AREA@|@TITLE@|@ELEMENT@/);
    }
    const bad = await app.inject({ method: 'GET', url: '/_pammy/request?area="><script>x</script>', headers: { host: 'pammy.org' } });
    assert.match(bad.body, /<pammy-request area=""><\/pammy-request>/);
    assert.equal((await app.inject({ method: 'GET', url: '/_pammy/nope', headers: { host: 'pammy.org' } })).statusCode, 404);
  });
});

describe('example looks (09-protected-folders.txt, PART 9 to 11)', () => {
  const exampleFile = (look: string, file: string) => readFileSync(new URL(`../public-gate/examples/${look}/${file}`, import.meta.url), 'utf8');

  it('serves all three looks, five pages and a style file each, framable only by the panel', async () => {
    for (const look of EXAMPLE_LOOKS) {
      for (const file of EXAMPLE_FILES) {
        const r = await app.inject({ method: 'GET', url: `/_pammy/examples/${look}/${file}`, headers: { host: 'pammy.org' } });
        assert.equal(r.statusCode, 200, `${look}/${file}`);
        assert.equal(r.body, exampleFile(look, file));
        assert.match(String(r.headers['content-type']), file.endsWith('.css') ? /^text\/css/ : /^text\/html/);
        assert.match(String(r.headers['content-security-policy']), /frame-ancestors https:\/\/panel\.pammy\.org;/);
        assert.equal(r.headers['cache-control'], 'no-store');
        if (file.endsWith('.html')) {
          assert.match(r.body, /<link rel="stylesheet" href="login-files\/style\.css">/);
          assert.match(r.body, /<script src="\/_pammy\/login\.js" defer><\/script>/);
        }
      }
    }
    for (const url of ['/_pammy/examples/garden/secret.html', '/_pammy/examples/other/login.html', 
      '/_pammy/examples/', '/_pammy/examples/garden/login-files/', '/_pammy/examples/garden/login-files/../../../../src/gate/app.ts']) {
      assert.equal((await app.inject({ method: 'GET', url, headers: { host: 'pammy.org' } })).statusCode, 404, url);
    }
  });

  it('match the guide word for word, each file one piece of code to copy', () => {
    const guide = parseGuide('09-protected-folders.txt', readFileSync(new URL('../../protected-folders-guide.txt', import.meta.url), 'utf8'));
    const code = guide.sections.flatMap((sec) => sec.blocks).flatMap(function all(b): string[] {
      if (b.t === 'code') return [b.text];
      if (b.t === 'ol' || b.t === 'ul') return b.items.flat().flatMap(all);
      return [];
    });
    EXAMPLE_LOOKS.forEach((look, i) => {
      const part = guide.sections.find((sec) => sec.part === 9 + i);
      assert.ok(part, `PART ${9 + i}`);
      assert.match(part.text, new RegExp(`https://pammy\\.org/_pammy/examples/${look}/login\\.html`), `PART ${9 + i} links its preview`);
      for (const file of EXAMPLE_FILES) {
        assert.ok(code.includes(exampleFile(look, file).trimEnd()), `${look}/${file} is in the guide exactly`);
        assert.ok(part.blocks.some((b) => b.t === 'code' && b.text === exampleFile(look, file).trimEnd()), `${look}/${file} is in PART ${9 + i}`);
      }
    });
  });
});

describe('forgot password', () => {
  const page = '/recipes/private/login-forgot.html';

  it('refuses other sites, and pages that are not sign-in pages', async () => {
    assert.equal((await postTo('/_pammy/forgot', { username: 'bob', page }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postTo('/_pammy/forgot', { username: 'bob', page: '/open/index.html' })).status, 400);
    assert.equal((await postTo('/_pammy/forgot', { username: '', page })).status, 400);
  });

  it('answers the same for real and made-up usernames, but only real ones reach Pamela', async () => {
    const before = (await requestsRows()).length;
    const known = await postTo('/_pammy/forgot', { username: 'Bob', message: `text me${BEL} on 0770\r\n\r\n\r\n\r\nthanks`, page });
    const unknown = await postTo('/_pammy/forgot', { username: 'nobody-here', page });
    assert.deepEqual([known.status, known.json], [200, { ok: true }]);
    assert.deepEqual([unknown.status, unknown.json], [200, { ok: true }]);
    const rows = (await requestsRows()).slice(before);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.kind, rows[0]!.visitor_id, rows[0]!.area_id, rows[0]!.name, rows[0]!.status], ['reset', ids.bob, ids.A, 'bob', 'open']);
    assert.equal(rows[0]!.message, 'text me  on 0770\n\nthanks', 'control characters gone, blank lines squeezed');
  });

  it('asking again updates the same request', async () => {
    const before = (await requestsRows()).length;
    await postTo('/_pammy/forgot', { username: 'bob', message: 'second try', page });
    assert.equal((await requestsRows()).length, before);
    assert.equal((await requestsRows()).find((r) => r.kind === 'reset' && r.visitor_id === ids.bob)!.message, 'second try');
  });

  it('limits attempts per visitor IP', async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await postTo('/_pammy/forgot', { username: 'nobody', page }, { ip: '203.0.113.77' })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  });
});

describe('asking for access', () => {
  const page = '/recipes/private/login-request.html';
  const form = { name: 'Rose Smith', contact: '07700 900123', message: "I'm Jo's daughter", page };

  it('needs a name and a way to reach them', async () => {
    assert.equal((await postTo('/_pammy/request', { ...form, name: '  ' })).status, 400);
    assert.equal((await postTo('/_pammy/request', { ...form, contact: '' })).status, 400);
    assert.equal((await postTo('/_pammy/request', { ...form, page: '/recipes/private/secret.jpg' })).status, 400);
  });

  it('records a request for the folder the page belongs to, once per person', async () => {
    const before = (await requestsRows()).length;
    assert.equal((await postTo('/_pammy/request', form)).status, 200);
    assert.equal((await postTo('/_pammy/request', { ...form, name: 'rose smith', message: 'again' })).status, 200);
    const rows = (await requestsRows()).slice(before);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.kind, rows[0]!.area_id, rows[0]!.name, rows[0]!.contact, rows[0]!.message], ['access', ids.A, 'Rose Smith', '07700 900123', 'again']);
    const onBuiltIn = await postTo('/_pammy/request', { name: 'Sam', contact: 'sam@example.com', area: tokens.C });
    assert.equal(onBuiltIn.status, 200);
    assert.equal((await requestsRows()).at(-1)!.area_id, ids.C);
  });

  it('pretends to accept what robots send, and stores nothing', async () => {
    const before = (await requestsRows()).length;
    const r = await postTo('/_pammy/request', { ...form, name: 'Buy pills', website: 'http://spam.example' });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.equal((await requestsRows()).length, before);
  });

  it("refuses when the folder isn't taking requests, and says so", async () => {
    await admin({ op: 'area.requests', id: ids.C, open: false });
    const r = await postTo('/_pammy/request', { name: 'Tom', contact: 'tom', area: tokens.C });
    assert.equal(r.status, 403);
    assert.match(r.json.message, /isn't taking requests/);
    const info = await app.inject({ method: 'GET', url: `/_pammy/about?area=${tokens.C}`, headers: { host: 'pammy.org', 'x-pammy-base': '/' } });
    assert.equal(info.json().requestsOpen, false);
    await admin({ op: 'area.requests', id: ids.C, open: true });
  });

  it('caps how many can wait for one folder', async () => {
    let last = 0;
    for (let i = 0; i < 52; i++) last = (await postTo('/_pammy/request', { name: `Flood ${i}`, contact: `x${i}`, area: tokens.C })).status;
    assert.equal(last, 503);
    await run(db, "DELETE FROM requests WHERE name LIKE 'Flood %'");
  });
});

describe('setup links', () => {
  const secret = '/recipes/private/secret.jpg';
  let dora = 0;

  it("makes people who haven't chosen a password yet, who can't sign in", async () => {
    const v = await admin({ op: 'visitor.create', username: 'dora', name: 'Dora', contact: ` 0770${NUL} 111 ` });
    dora = v.id;
    assert.equal(v.hasPassword, false);
    await admin({ op: 'grant', visitorId: dora, areaId: ids.A, allow: true });
    for (const password of ['', 'anything-at-all-1']) {
      assert.equal((await login({ username: 'dora', password, page: '/recipes/private/login.html' })).status, 401);
    }
    const st = await admin({ op: 'state' });
    assert.equal(st.visitors.find((x: { id: number }) => x.id === dora).contact, '0770 111');
  });

  it("links to the folder's own login-invite.html when it has one, else the built-in page", async () => {
    const cfg = { publicRoot: pub, domain: 'pammy.org' };
    const a = await handleAdmin(live, clock, { op: 'link.create', visitorId: dora, areaId: ids.A }, cfg) as { url: string; expiresAt: number };
    assert.match(a.url, /^https:\/\/pammy\.org\/_pammy\/invite#[A-Za-z0-9_-]{43}$/);
    assert.equal(a.expiresAt, clock + 7 * 86400);
    const c = await handleAdmin(live, clock, { op: 'link.create', visitorId: dora, areaId: ids.C }, cfg) as { url: string };
    assert.match(c.url, /^https:\/\/pammy\.org\/members\/login-invite\.html#[A-Za-z0-9_-]{43}$/);
    assert.equal((await postTo('/_pammy/invite/check', { token: tokenOf(a.url) })).status, 410, 'a new link cancels the old one');
  });

  it('shows their username, refuses weak passwords without using the link up, then signs them in', async () => {
    const l = await admin({ op: 'link.create', visitorId: dora, areaId: ids.A });
    const token = tokenOf(l.url);
    const info = await postTo('/_pammy/invite/check', { token });
    assert.equal(info.status, 200);
    assert.deepEqual([info.json.username, info.json.firstPassword], ['dora', true]);
    assert.equal((await postTo('/_pammy/invite', { token, password: 'short' })).status, 400);
    assert.equal((await postTo('/_pammy/invite', { token, password: 'dora-password-123' }, { origin: 'https://evil.example' })).status, 403);
    const used = await postTo('/_pammy/invite', { token, password: 'dora-password-123' });
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.equal(used.json.next, '/recipes/private/');
    assert.equal((await check(secret, { cookie: used.cookie })).status, 204);
    assert.equal((await login({ username: 'dora', password: 'dora-password-123', page: '/recipes/private/login.html' })).status, 200);
    assert.equal((await postTo('/_pammy/invite', { token, password: 'dora-password-456' })).status, 410, 'works once');
    assert.equal((await postTo('/_pammy/invite/check', { token })).status, 410);
  });

  it('a new-password link: old sessions end, the old password stops, open forgot requests close', async () => {
    const old = await login({ username: 'dora', password: 'dora-password-123', page: '/recipes/private/login.html' });
    await postTo('/_pammy/forgot', { username: 'dora', page: '/recipes/private/login-forgot.html' });
    const l = await admin({ op: 'link.create', visitorId: dora, areaId: ids.A });
    assert.equal((await postTo('/_pammy/invite/check', { token: tokenOf(l.url) })).json.firstPassword, false);
    assert.equal((await check(secret, { cookie: old.cookie })).status, 204, 'nothing changes until they use it');
    const used = await postTo('/_pammy/invite', { token: tokenOf(l.url), password: 'dora-new-password-1' }, { host: 'recipes.pammy.org', base: '/recipes' });
    assert.equal(used.status, 200);
    assert.equal(used.json.next, '/private/', 'lands on the folder at the address the link was opened on');
    assert.equal((await check(secret, { cookie: old.cookie })).status, 401);
    assert.equal((await login({ username: 'dora', password: 'dora-password-123', page: '/recipes/private/login.html' })).status, 401);
    const req = (await requestsRows()).find((r) => r.kind === 'reset' && r.visitor_id === dora)!;
    assert.deepEqual([req.status, req.handled_by], ['done', 'they chose a new password']);
  });

  it('stops working after 7 days, when cancelled, when the person is switched off, or when Pamela sets a password', async () => {
    const t1 = tokenOf((await admin({ op: 'link.create', visitorId: dora, areaId: ids.A })).url);
    clock += 7 * 86400;
    assert.equal((await postTo('/_pammy/invite/check', { token: t1 })).status, 410);
    const t2 = tokenOf((await admin({ op: 'link.create', visitorId: dora, areaId: null })).url);
    await admin({ op: 'link.cancel', visitorId: dora });
    assert.equal((await postTo('/_pammy/invite/check', { token: t2 })).status, 410);
    const t3 = tokenOf((await admin({ op: 'link.create', visitorId: dora })).url);
    await admin({ op: 'visitor.active', id: dora, active: false });
    assert.equal((await postTo('/_pammy/invite/check', { token: t3 })).status, 410);
    await assert.rejects(admin({ op: 'link.create', visitorId: dora }), (e: { code: string }) => e.code === 'invalid');
    await admin({ op: 'visitor.active', id: dora, active: true });
    assert.equal((await postTo('/_pammy/invite/check', { token: t3 })).status, 410, 'switching back on does not revive it');
    const t4 = tokenOf((await admin({ op: 'link.create', visitorId: dora })).url);
    await admin({ op: 'visitor.password', id: dora, password: 'set-by-pamela-123' });
    assert.equal((await postTo('/_pammy/invite/check', { token: t4 })).status, 410);
    assert.equal((await postTo('/_pammy/invite/check', { token: 'not-a-token' })).status, 410);
  });

  it("with no folder, or one they can't open, lands on the home page", async () => {
    const l = await admin({ op: 'link.create', visitorId: dora, areaId: ids.C });
    const used = await postTo('/_pammy/invite', { token: tokenOf(l.url), password: 'dora-password-789' });
    assert.equal(used.json.next, '/');
  });

  it('the admin side: state, resolving, deleting', async () => {
    const st = await admin({ op: 'state' });
    const d = st.visitors.find((x: { id: number }) => x.id === dora);
    assert.deepEqual([d.hasPassword, d.linkExpiresAt], [true, null]);
    assert.ok(st.areas.every((a: { requestsOpen: boolean }) => a.requestsOpen === true));
    const open = st.requests.find((r: { status: string; kind: string }) => r.status === 'open' && r.kind === 'access');
    assert.ok(open.contact && open.name);
    await admin({ op: 'request.resolve', id: open.id, status: 'declined', actor: 'pamela' });
    await assert.rejects(admin({ op: 'request.resolve', id: open.id, status: 'done' }), (e: { code: string }) => e.code === 'exists');
    await assert.rejects(admin({ op: 'request.resolve', id: open.id + 1000, status: 'done' }), (e: { code: string }) => e.code === 'not-found');
    await admin({ op: 'request.delete', id: open.id });
    assert.ok(!(await requestsRows()).some((r) => r.id === open.id));
  });
});

describe('a protected folder with no home page', () => {
  let cookie = '';
  before(async () => {
    await protect('BARE', 'bare');
    await protect('BARE_INNER', 'bare/inner');
    const v = await admin({ op: 'visitor.create', username: 'gina', password: 'gina-password-123' });
    await admin({ op: 'grant', visitorId: v.id, areaId: ids.BARE, allow: true });
    cookie = (await login({ username: 'gina', password: 'gina-password-123', page: '/bare/login.html' })).cookie!;
  });

  it("signed in: the folder itself goes to the built-in welcome page instead of nginx's 403", async () => {
    for (const u of ['/bare/', '/bare']) {
      const r = await check(u, { cookie });
      assert.equal(r.status, 401, u);
      assert.equal(r.login, `/_pammy/welcome?area=${tokens.BARE}&path=%2Fbare%2F`, u);
      assert.equal(r.cache, 'private, no-store');
    }
    const sub = await check('/', { host: 'bare.pammy.org', base: '/bare', cookie: (await login({ username: 'gina', password: 'gina-password-123', page: '/login.html' }, { host: 'bare.pammy.org', base: '/bare' })).cookie });
    assert.equal(sub.login, `/_pammy/welcome?area=${tokens.BARE}&path=%2F`, 'at its subdomain address too');
    assert.equal((await check('/bare/drafts/', { cookie })).login, `/_pammy/welcome?area=${tokens.BARE}&path=%2Fbare%2Fdrafts%2F`, 'a subfolder with no home page too');
  });

  it('everything else is unchanged', async () => {
    assert.equal((await check('/bare/about.html', { cookie })).status, 204);
    assert.equal((await check('/bare/privacy/', { cookie })).status, 204, 'a subfolder with an index.html');
    // docs/tutorials-plan.md P1: index.php is a home page too
    file('bare/php-home/index.php', '<?php echo 1;');
    try {
      assert.equal((await check('/bare/php-home/', { cookie })).status, 204, 'a subfolder with an index.php');
    } finally {
      rmSync(join(pub, 'bare', 'php-home'), { recursive: true });
    }
    assert.match((await check('/bare/')).login!, /^\/bare\/login\.html\?/, 'not signed in: the sign-in page as before');
    assert.equal((await check('/open/', { cookie })).status, 204, 'unprotected folders are left to nginx');
    assert.equal((await check('/recipes/private/', { cookie })).status, 401, 'no access: sign-in, not welcome');
  });

  it('lists what they can open, on the address they use; nothing for anyone else', async () => {
    const get = (q: string, c?: string, host = 'pammy.org', base = '/') =>
      app.inject({ method: 'GET', url: `/_pammy/folder?${q}`, headers: { host, 'x-pammy-base': base, ...(c ? { cookie: c } : {}) } });
    const r = await get(`area=${tokens.BARE}`, cookie);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { username: 'gina', login: '/bare/login.html', items: [
      { name: 'about.html', folder: false, href: '/bare/about.html' },
      { name: 'privacy', folder: true, href: '/bare/privacy/' },
    ] }, 'no login pages, hidden files, non-pages, folders without a home page, or nested areas they cannot open');
    const signedOut = await get(`area=${tokens.BARE}`);
    assert.equal(signedOut.statusCode, 401);
    assert.deepEqual(Object.keys(signedOut.json()).sort(), ['error', 'login']);
    const other = await login({ username: 'bob', password: 'bob-new-password-456', page: '/recipes/private/login.html' });
    assert.equal(other.status, 200, 'bob is really signed in');
    assert.equal((await get(`area=${tokens.BARE}`, other.cookie)).statusCode, 401, 'signed in, but without access to this folder');
    assert.equal((await get(`area=${'Z'.repeat(32)}`, cookie)).statusCode, 404);

    file('bare/drafts/draft one.html');
    const drafts = await get(`area=${tokens.BARE}&path=${encodeURIComponent('/bare/drafts/')}`, cookie);
    assert.deepEqual(drafts.json().items, [{ name: 'draft one.html', folder: false, href: '/bare/drafts/draft%20one.html' }], 'the folder they opened, not the top');
    for (const path of ['/recipes/private/', '/bare/inner/', '/open/', '/bare/../recipes/private/', '//evil/', '/bare/about.html/']) {
      const items = (await get(`area=${tokens.BARE}&path=${encodeURIComponent(path)}`, cookie)).json().items;
      assert.deepEqual(items.map((i: { name: string }) => i.name), ['about.html', 'privacy'], `${path}: not theirs or not inside this area, so the area itself`);
    }
    const subCookie = (await login({ username: 'gina', password: 'gina-password-123', page: '/login.html' }, { host: 'bare.pammy.org', base: '/bare' })).cookie!;
    const onSub = await get(`area=${tokens.BARE}&path=%2F`, subCookie, 'bare.pammy.org', '/bare');
    assert.deepEqual(onSub.json().items.map((i: { href: string }) => i.href), ['/about.html', '/privacy/'], 'links on the subdomain address');
  });

  it('serves the built-in welcome page', async () => {
    const res = await app.inject({ method: 'GET', url: `/_pammy/welcome?area=${tokens.BARE}`, headers: { host: 'pammy.org' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, new RegExp(`<pammy-welcome area="${tokens.BARE}"></pammy-welcome>`));
    const src = res.body.match(/<script src="([^"]+)" defer>/)![1]!;
    assert.match(src, /^\/_pammy\/login\.js\?v=[0-9a-f]{12}$/, 'versioned script address');
    const js = await app.inject({ method: 'GET', url: src, headers: { host: 'pammy.org' } });
    assert.equal(js.statusCode, 200);
    assert.match(js.body, /customElements\.define\(['"`]pammy-welcome['"`]/);
  });
});

// ------------------------------------------------------------------ forms
describe('forms: building them', () => {
  it('checks the name, and keeps it unique', async () => {
    const refuse = async (req: Record<string, unknown>, code: string, match: RegExp) =>
      assert.rejects(admin(req), (e: { code: string; message: string }) => e.code === code && match.test(e.message), JSON.stringify(req));
    for (const name of ['', 'x', 'Olivias-Form', 'olivias form', 'olivias_form', '-olivia', 'olivia-', 'olivia--form', 'o'.repeat(65)]) {
      await refuse({ op: 'form.create', name, items: [] }, 'invalid', /name/i);
    }
    await admin({ op: 'form.create', name: 'olivias-form', title: 'Olivias party', actor: 'pamela' });
    await refuse({ op: 'form.create', name: 'olivias-form', items: [] }, 'exists', /already a form called olivias-form/);
  });

  it('makes keys from labels, keeps them unique, and never reuses an old one', async () => {
    const made = await admin({ op: 'form.create', name: 'keys-form', items: [
      { type: 'short-text', label: 'Your name' }, { type: 'short-text', label: 'Your name' }, { type: 'email', label: '  Email!  ' },
    ] });
    assert.deepEqual(made.items.map((i: { key: string }) => i.key), ['your-name', 'your-name-2', 'email']);
    // the second field goes; a new one with the same label can't take its key back
    const saved = await admin({ op: 'form.save', id: made.id, version: made.version, items: [made.items[0], made.items[2]] });
    const again = await admin({ op: 'form.save', id: made.id, version: saved.version, items: [...saved.items, { type: 'short-text', label: 'Your name' }] });
    assert.deepEqual(again.items.map((i: { key: string }) => i.key), ['your-name', 'email', 'your-name-3']);
  });

  it("a saved field keeps its key when its label changes, and its kind can't change", async () => {
    const f = await admin({ op: 'form.create', name: 'fixed-keys', items: [{ type: 'short-text', label: 'Pudding' }] });
    const renamed = await admin({ op: 'form.save', id: f.id, version: f.version, items: [{ ...f.items[0], label: 'Dessert' }] });
    assert.deepEqual([renamed.items[0].key, renamed.items[0].label], ['pudding', 'Dessert']);
    await assert.rejects(admin({ op: 'form.save', id: f.id, version: renamed.version, items: [{ ...renamed.items[0], type: 'number' }] }),
      (e: { message: string }) => /kind can't change/.test(e.message));
  });

  it('checks every kind of item', async () => {
    const refuse = async (item: Record<string, unknown>, match: RegExp) =>
      assert.rejects(admin({ op: 'form.create', name: `check-${Math.random().toString(36).slice(2, 8)}`, items: [item] }),
        (e: { code: string; message: string }) => e.code === 'invalid' && match.test(e.message), JSON.stringify(item));
    await refuse({ type: 'short-text' }, /needs a label/);
    await refuse({ type: 'nonsense', label: 'x' }, /unknown kind/);
    await refuse({ type: 'dropdown', label: 'Pick', options: [' ', ''] }, /at least one choice/);
    await refuse({ type: 'short-text', label: 'x', minLength: 10, maxLength: 5 }, /fewest characters is more/);
    await refuse({ type: 'number', label: 'x', min: 10, max: 5 }, /smallest number is more/);
    await refuse({ type: 'number', label: 'x', min: 1, max: 5, default: 9 }, /outside the numbers allowed/);
    await refuse({ type: 'date', label: 'x', earliest: '2026-13-40' }, /must be a date/);
    await refuse({ type: 'date', label: 'x', earliest: '2026-05-02', latest: '2026-05-01' }, /earliest date is after/);
    await refuse({ type: 'time', label: 'x', earliest: '9am' }, /must be a time/);
    await refuse({ type: 'rating', label: 'x', stars: 2 }, /whole number from 3 to 10/);
    await refuse({ type: 'heading' }, /heading needs some words/);
    await refuse({ type: 'image', src: 'x.txt', alt: 'x' }, /choose a picture/);
    await refuse({ type: 'image', src: 'media/images/x.jpg' }, /describe the picture/);
    await refuse({ type: 'hidden', label: 'x', param: 'no spaces' }, /address setting's name/);
    await assert.rejects(admin({ op: 'form.create', name: 'too-big', items: Array.from({ length: 101 }, () => ({ type: 'divider' })) }),
      (e: { message: string }) => /at most 100 items/.test(e.message));

    const f = await admin({ op: 'form.create', name: 'every-kind', title: 'Every kind', items: [
      { type: 'heading', text: 'About you', size: 'large' }, { type: 'paragraph', text: 'A few questions.' }, { type: 'divider' },
      { type: 'name', label: 'Your name', required: true, parts: { middle: true } },
      { type: 'email', label: 'Email', required: true }, { type: 'phone', label: 'Phone' },
      { type: 'short-text', label: 'Nickname', maxLength: 10 }, { type: 'long-text', label: 'Notes', rows: 3 },
      { type: 'number', label: 'How many', min: 1, max: 8, decimals: 0 }, { type: 'website', label: 'Website' },
      { type: 'date', label: 'Day', earliest: '2026-01-01' }, { type: 'time', label: 'Time', earliest: '09:00', latest: '17:00', step: 30 },
      { type: 'dropdown', label: 'Course', options: ['Starter', 'Main'] },
      { type: 'single-choice', label: 'Coming', options: ['Yes', 'No'], other: true },
      { type: 'multiple-choice', label: 'Bring', options: ['Cake', 'Drinks', 'Games'], minPicks: 1, maxPicks: 2 },
      { type: 'checkbox', label: 'I agree', required: true },
      { type: 'address', label: 'Address', parts: { line2: false, region: false } },
      { type: 'rating', label: 'Stars', stars: 5 }, { type: 'scale', label: 'Score', from: 0, to: 5, lowLabel: 'Poor' },
      { type: 'hidden', label: 'Where from', param: 'source', value: 'the website' },
    ] });
    assert.equal(f.items.length, 20);
    const byKey = Object.fromEntries(f.items.filter((i: { key?: string }) => i.key).map((i: { key: string }) => [i.key, i]));
    assert.deepEqual([byKey.email.public, byKey.phone.public, byKey.address.public, byKey['where-from'].public, byKey.stars.public],
      [false, false, false, false, true], 'email, phone, address and hidden values stay private unless she says otherwise');
    assert.deepEqual([byKey['your-name'].parts, byKey.address.parts],
      [{ title: false, middle: true }, { line2: false, region: false, postcode: true, country: true }]);
  });

  it('refuses a save that would overwrite someone else', async () => {
    const f = await admin({ op: 'form.create', name: 'stale-form', items: [{ type: 'short-text', label: 'A' }] });
    await admin({ op: 'form.save', id: f.id, version: f.version, items: f.items, actor: 'pamela' });
    await assert.rejects(admin({ op: 'form.save', id: f.id, version: f.version, items: f.items, actor: 'momolig' }),
      (e: { code: string; message: string }) => e.code === 'stale' && /pamela saved this form/.test(e.message));
  });

  it('duplicates everything but the id and the name, and suggests a copy name', async () => {
    const from = await admin({ op: 'forms.state' }).then((st: { forms: { name: string; id: number }[] }) => st.forms.find((x) => x.name === 'every-kind')!);
    await admin({ op: 'form.switches', id: from.id, approvable: true });
    const suggested = await admin({ op: 'form.copy-name', id: from.id });
    assert.equal(suggested.name, 'every-kind-copy');
    const copy = await admin({ op: 'form.duplicate', id: from.id, name: suggested.name, actor: 'pamela' });
    assert.notEqual(copy.id, from.id);
    assert.equal(copy.name, 'every-kind-copy');
    assert.equal(copy.approvable, true);
    const full = await admin({ op: 'form.get', id: from.id });
    assert.deepEqual(copy.items, full.items);
    assert.equal((await admin({ op: 'form.copy-name', id: from.id })).name, 'every-kind-copy-2');
  });

  it('trashes and restores a form, and keeps its name taken meanwhile', async () => {
    const f = await admin({ op: 'form.create', name: 'gone-soon', items: [{ type: 'short-text', label: 'A' }] });
    await admin({ op: 'form.trash', id: f.id, actor: 'pamela' });
    await assert.rejects(admin({ op: 'form.create', name: 'gone-soon', items: [] }),
      (e: { code: string; message: string }) => e.code === 'exists' && /in the trash/.test(e.message));
    await assert.rejects(admin({ op: 'form.save', id: f.id, version: f.version, items: [] }), (e: { code: string }) => e.code === 'not-found');
    await admin({ op: 'form.restore', id: f.id });
    await admin({ op: 'form.trash', id: f.id });
    clock += 29 * 86400;
    await admin({ op: 'housekeeping' });
    assert.ok(await admin({ op: 'form.get', id: f.id }), 'still restorable after 29 days');
    clock += 2 * 86400;
    await admin({ op: 'housekeeping' });
    await assert.rejects(admin({ op: 'form.get', id: f.id }), (e: { code: string }) => e.code === 'not-found', 'gone for good after 30');
    const back = await admin({ op: 'form.create', name: 'gone-soon', items: [{ type: 'short-text', label: 'A' }] });
    assert.ok(back.id > f.id, 'the name is free again, but ids are never reused');
  });
});

describe('forms: on her pages', () => {
  let party = 0;
  let partyVersion = 0;
  let memberCookie = '';
  const get = (name: string, page: string, opts: { host?: string; base?: string; cookie?: string } = {}) =>
    app.inject({ method: 'GET', url: `/_pammy/forms/${name}?page=${encodeURIComponent(page)}`,
      headers: { host: opts.host ?? 'pammy.org', 'x-pammy-base': opts.base ?? '/', ...(opts.cookie ? { cookie: opts.cookie } : {}) } });
  const send = async (name: string, body: Record<string, unknown>, opts: { host?: string; base?: string; cookie?: string; ip?: string; origin?: string } = {}) => {
    const host = opts.host ?? 'pammy.org';
    const res = await app.inject({
      method: 'POST', url: `/_pammy/forms/${name}`, remoteAddress: '127.0.0.1',
      headers: {
        host, 'x-pammy-base': opts.base ?? '/', origin: opts.origin ?? `https://${host}`, 'content-type': 'application/json',
        'x-real-ip': opts.ip ?? `192.0.2.${Math.floor(Math.random() * 250)}`, ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      payload: JSON.stringify(body),
    });
    return { status: res.statusCode, json: res.json() };
  };
  // not the sample entries the three examples come with (examples.ts)
  const responseRows = () => all<{ id: number; form_id: number | null; form_name: string; page: string; answers: string; visitor_username: string | null; read_at: number | null; approved_at: number | null }>(db,
    'SELECT * FROM responses WHERE form_id NOT IN (SELECT id FROM forms WHERE fixture IS NOT NULL) ORDER BY id');
  const good = () => ({ 'your-name': { first: 'Rose', last: 'Smith' }, 'coming': 'Yes', 'how-many': '2', 'bring': ['Cake'], 'i-agree': true, 'when': '2026-10-01' });

  before(async () => {
    file('party.html'); file('open/rsvp.html'); file('members/rsvp.html'); file('open/pictures/party.jpg');
    const f = await admin({ op: 'form.create', name: 'party-form', title: 'Party', items: [
      { type: 'heading', text: 'Olivia is 8!' },
      { type: 'image', src: 'open/pictures/party.jpg', alt: 'Balloons' },
      { type: 'name', label: 'Your name', required: true },
      { type: 'single-choice', label: 'Coming', options: ['Yes', 'No'], other: true, required: true },
      { type: 'number', label: 'How many', min: 1, max: 8 },
      { type: 'multiple-choice', label: 'Bring', options: ['Cake', 'Drinks'], maxPicks: 1 },
      { type: 'checkbox', label: 'I agree', required: true },
      { type: 'date', label: 'When', earliest: '2026-01-01' },
      { type: 'email', label: 'Email' },
      { type: 'hidden', label: 'Where from', param: 'from', value: 'the website' },
    ], actor: 'pamela' });
    party = f.id;
    partyVersion = f.version;
    const v = await admin({ op: 'visitor.create', username: 'maya', name: 'Maya', password: 'maya-password-123' });
    await admin({ op: 'grant', visitorId: v.id, areaId: ids.C, allow: true });
    memberCookie = (await login({ username: 'maya', password: 'maya-password-123', area: tokens.C })).cookie!;
  });

  it('gives any page the form it asks for, with pictures on this hostname', async () => {
    const r = await get('party-form', '/open/rsvp.html');
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.title, 'Party');
    assert.equal(body.items.find((i: { type: string }) => i.type === 'image').src, '/open/pictures/party.jpg');
    assert.equal(body.items.find((i: { type: string }) => i.type === 'hidden').value, undefined, 'a fixed hidden value never reaches the page');
    assert.equal(body.signedInAs, null);
    const sub = await get('party-form', '/rsvp.html', { host: 'open.pammy.org', base: '/open' });
    assert.equal(sub.statusCode, 200);
    assert.equal(sub.json().items.find((i: { type: string }) => i.type === 'image').src, '/pictures/party.jpg');
    assert.equal((await get('party-form', '/party.html')).statusCode, 200, 'the main site');
  });

  it('says nothing about a form that is off, in the trash or not there', async () => {
    await admin({ op: 'form.switches', id: party, enabled: false });
    const off = await get('party-form', '/open/rsvp.html');
    assert.deepEqual([off.statusCode, off.json().error], [404, 'unavailable']);
    assert.equal((await send('party-form', { page: '/open/rsvp.html', answers: good() })).status, 404, "a form that is off doesn't take answers");
    await admin({ op: 'form.switches', id: party, enabled: true });
    for (const name of ['nope-form', 'NOT-A-NAME', 'sample-contact-form']) {
      assert.equal((await get(name, '/open/rsvp.html')).json().error, 'unavailable', name);
    }
  });

  it('in a protected folder: only for people who can open it, and says who they are', async () => {
    assert.equal((await get('party-form', '/members/rsvp.html')).statusCode, 401);
    assert.equal((await send('party-form', { page: '/members/rsvp.html', answers: good() })).status, 401);
    const r = await get('party-form', '/members/rsvp.html', { cookie: memberCookie });
    assert.deepEqual([r.statusCode, r.json().signedInAs], [200, 'maya']);
  });

  it('can be set to signed-in visitors only', async () => {
    await admin({ op: 'form.save', id: party, version: partyVersion, items: (await admin({ op: 'form.get', id: party })).items, settings: { signedInOnly: true } });
    partyVersion += 1;
    const out = await get('party-form', '/open/rsvp.html');
    assert.deepEqual([out.statusCode, out.json().error], [403, 'sign-in-needed']);
    assert.equal((await get('party-form', '/members/rsvp.html', { cookie: memberCookie })).statusCode, 200);
    await admin({ op: 'form.save', id: party, version: partyVersion, items: (await admin({ op: 'form.get', id: party })).items, settings: { signedInOnly: false } });
    partyVersion += 1;
  });

  it('checks the answers and says which field is wrong', async () => {
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ ...good(), 'your-name': { first: 'Rose', last: '' } }, 'your-name', /both first and last name/],
      [{ ...good(), 'coming': '' }, 'coming', /Please choose an answer for "Coming"/],
      [{ ...good(), 'how-many': '9' }, 'how-many', /should be at most 8/],
      [{ ...good(), 'how-many': '2.5' }, 'how-many', /whole number/],
      [{ ...good(), 'bring': ['Cake', 'Drinks'] }, 'bring', /at most 1 answers/],
      [{ ...good(), 'bring': ['Fireworks'] }, 'bring', /Please choose from the answers/],
      [{ ...good(), 'i-agree': false }, 'i-agree', /Please tick "I agree"/],
      [{ ...good(), 'when': '2025-12-31' }, 'when', /can't be before 2026-01-01/],
      [{ ...good(), 'when': 'soon' }, 'when', /should be a date/],
      [{ ...good(), 'email': 'not an email' }, 'email', /doesn't look like an email/],
    ];
    for (const [answers, field, message] of cases) {
      const r = await send('party-form', { page: '/open/rsvp.html', answers });
      assert.deepEqual([r.status, r.json.field], [400, field], JSON.stringify(answers));
      assert.match(r.json.message, message);
    }
    assert.equal((await responseRows()).length, 0);
  });

  it('stores a response with the questions as they were, and rows to filter by', async () => {
    const r = await send('party-form', { page: '/open/rsvp.html', answers: { ...good(), 'coming': 'Maybe next year' } });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    const [row] = await responseRows();
    assert.deepEqual([row!.form_id, row!.form_name, row!.page, row!.visitor_username], [party, 'party-form', 'open/rsvp.html', null]);
    const answers = JSON.parse(row!.answers) as { key: string; value: unknown }[];
    assert.deepEqual(answers.map((a) => [a.key, a.value]), [
      ['your-name', { first: 'Rose', last: 'Smith' }], ['coming', 'Maybe next year'], ['how-many', 2], ['bring', ['Cake']],
      ['i-agree', true], ['when', '2026-10-01'], ['email', null], ['where-from', 'the website'],
    ], 'an "other" answer is its words, a number is a number, and a fixed hidden value comes from the form');
    const values = await all<{ key: string; value: string }>(db, 'SELECT key, value FROM response_values WHERE response_id = ? ORDER BY key', row!.id);
    assert.deepEqual(values.map((v) => `${v.key}=${v.value}`),
      ['bring=cake', 'coming=maybe next year', 'how-many=2', 'i-agree=true', 'when=2026-10-01', 'where-from=the website', 'your-name.first=rose', 'your-name.last=smith']);
  });

  it('records who sent it from a protected folder, and where from', async () => {
    const r = await send('party-form', { page: '/members/rsvp.html', answers: good() }, { cookie: memberCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const last = (await responseRows()).at(-1)!;
    assert.deepEqual([last.visitor_username, last.page], ['maya', 'members/rsvp.html']);
  });

  it('notes which pages show a form, at most once an hour each', async () => {
    const pages = async () => (await all<{ page: string }>(db, 'SELECT page FROM form_pages WHERE form_id = ? ORDER BY page', party)).map((p) => p.page);
    assert.deepEqual(await pages(), ['members/rsvp.html', 'open/rsvp.html', 'party.html']);
    const before = (await one<{ last_seen: number }>(db, 'SELECT last_seen FROM form_pages WHERE form_id = ? AND page = ?', party, 'open/rsvp.html'))!.last_seen;
    clock += 10;
    await get('party-form', '/open/rsvp.html');
    assert.equal((await one<{ last_seen: number }>(db, 'SELECT last_seen FROM form_pages WHERE form_id = ? AND page = ?', party, 'open/rsvp.html'))!.last_seen, before);
  });

  it('refuses other sites, pretends to accept robots, and limits each visitor', async () => {
    const before = (await responseRows()).length;
    assert.equal((await send('party-form', { page: '/open/rsvp.html', answers: good() }, { origin: 'https://evil.example' })).status, 403);
    const robot = await send('party-form', { page: '/open/rsvp.html', answers: good(), website: 'http://spam.example' });
    assert.deepEqual([robot.status, robot.json.ok], [200, true]);
    assert.equal((await responseRows()).length, before);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await send('party-form', { page: '/open/rsvp.html', answers: good() }, { ip: '203.0.113.66' })).status);
    assert.deepEqual(codes.slice(9), [200, 429, 429]);
    await run(db, "DELETE FROM responses WHERE ip = '203.0.113.66'");
  });

  it('serves the component, never cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/_pammy/forms.js', headers: { host: 'pammy.org' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /customElements\.define\(['"`]pammy-form['"`]/);
  });

  it('has a preview page the panel can frame, and nobody else', async () => {
    const res = await app.inject({ method: 'GET', url: '/_pammy/form-preview', headers: { host: 'pammy.org' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<pammy-form preview panel="https:\/\/panel\.pammy\.org"><\/pammy-form>/);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors https:\/\/panel\.pammy\.org/);
  });
});

// ---------------------------------------------------------- comments (docs/comments-plan.md)
describe('comments', () => {
  let pageArea = 0;
  let postsArea = 0;
  let memberCookie = '';
  const headers = (o: { host?: string; cookie?: string; ip?: string } = {}) => ({
    host: o.host ?? 'pammy.org', 'x-pammy-base': '/', ...(o.cookie ? { cookie: o.cookie } : {}),
  });
  const read = (name: string, q: Record<string, string>, o: { cookie?: string; etag?: string } = {}) =>
    app.inject({ method: 'GET', url: `/_pammy/comments/${name}?${new URLSearchParams(q)}`, headers: { ...headers(o), ...(o.etag ? { 'if-none-match': o.etag } : {}) } });
  const send = async (name: string, body: Record<string, unknown>, o: { cookie?: string; ip?: string } = {}) => {
    const res = await app.inject({
      method: 'POST', url: `/_pammy/comments/${name}`, remoteAddress: '127.0.0.1',
      headers: { ...headers(o), origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': o.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}` },
      payload: JSON.stringify(body),
    });
    return { status: res.statusCode, json: res.json() };
  };
  const comment = (name: string, words: string) => ({ 'your-name': name, 'your-comment': words });
  const approveAll = async (formId: number) => {
    for (const r of (await admin({ op: 'responses.list', formId, kind: 'comments' })).responses) {
      if (!r.approvedAt) await admin({ op: 'response.approve', id: r.id, approved: true, actor: 'pamela' });
    }
  };

  before(async () => {
    file('about/index.html'); file('blog.html'); file('members/news.html');
    pageArea = (await admin({ op: 'form.create', name: 'page-comments', title: 'Page comments', kind: 'comments', actor: 'pamela' })).id;
    postsArea = (await admin({ op: 'form.create', name: 'blog-comments', title: 'Blog comments', kind: 'comments', contentType: 'posts', actor: 'pamela' })).id;
    const v = await admin({ op: 'visitor.create', username: 'june', name: 'June', password: 'june-password-123' });
    await admin({ op: 'grant', visitorId: v.id, areaId: ids.C, allow: true });
    memberCookie = (await login({ username: 'june', password: 'june-password-123', area: tokens.C })).cookie!;
  });

  it('a comment area is a form that always waits for her OK (C1, C15)', async () => {
    const f = await admin({ op: 'form.get', id: pageArea });
    assert.equal(f.kind, 'comments');
    assert.equal(f.approvable, true);
    assert.deepEqual(f.items.map((i: { key: string; public: boolean }) => [i.key, i.public]), [['your-name', true], ['your-comment', true]]);
    await assert.rejects(admin({ op: 'form.switches', id: pageArea, autoApprove: true }), /always wait for your OK/);
    await assert.rejects(admin({ op: 'form.switches', id: pageArea, approvable: false }), /always wait for your OK/);
  });

  it('on any page: sent, waiting, approved, then shown -- and a folder and its index.html are one page', async () => {
    const sent = await send('page-comments', { page: '/about/', answers: comment('Rose', 'Lovely page.\nSecond line.') });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json, { ok: true, waiting: true });
    // not shown until she says so
    assert.equal((await read('page-comments', { page: '/about/index.html' })).json().total, 0);
    await approveAll(pageArea);
    const r = await read('page-comments', { page: '/about/index.html' });
    const body = r.json();
    assert.equal(body.total, 1);
    assert.equal(body.content, 'about/index.html');
    assert.deepEqual({ author: body.comments[0].author, body: body.comments[0].body }, { author: 'Rose', body: 'Lovely page.\nSecond line.' });
    assert.ok(!('page' in body.comments[0]) && !('ip' in body.comments[0]), 'never where it came from');
    // a page asking again costs a 304
    assert.equal((await read('page-comments', { page: '/about/' }, { etag: String(r.headers.etag) })).statusCode, 304);
    // another page is another conversation
    assert.equal((await read('page-comments', { page: '/blog.html' })).json().total, 0);
  });

  it('only the public answers, and a signed-in visitor by their own name (C13, C18)', async () => {
    const f = await admin({ op: 'form.get', id: pageArea });
    await admin({ op: 'form.save', id: pageArea, version: f.version, items: [...f.items, { id: 'new-9', type: 'email', label: 'Email' }], actor: 'pamela' });
    await send('page-comments', { page: '/blog.html', answers: { ...comment('Sam', 'Hi'), email: 'sam@example.org' } });
    await approveAll(pageArea);
    const c = (await read('page-comments', { page: '/blog.html' })).json().comments[0];
    assert.deepEqual(Object.keys(c.answers).sort(), ['your-comment', 'your-name']);
    assert.ok(!JSON.stringify(c).includes('sam@example.org'));
  });

  it('comments on a protected page are as private as the page, reading and writing (C13)', async () => {
    assert.equal((await send('page-comments', { page: '/members/news.html', answers: comment('X', 'nope') })).status, 401);
    const inside = await send('page-comments', { page: '/members/news.html', answers: comment('June', 'Members only') }, { cookie: memberCookie });
    assert.equal(inside.status, 200);
    await approveAll(pageArea);
    assert.equal((await read('page-comments', { page: '/members/news.html' })).statusCode, 401);
    const mine = (await read('page-comments', { page: '/members/news.html' }, { cookie: memberCookie })).json();
    assert.equal(mine.comments[0].author, 'June', 'signed in: the name comes from the session');
    // and a thread named from a public page does not show what was sent behind the door
    await send('page-comments', { page: '/members/news.html', content: 'shared-thread', answers: comment('June', 'Secret') }, { cookie: memberCookie });
    await send('page-comments', { page: '/blog.html', content: 'shared-thread', answers: comment('Ann', 'Public') });
    await approveAll(pageArea);
    const outside = (await read('page-comments', { page: '/blog.html', content: 'shared-thread' })).json();
    assert.deepEqual(outside.comments.map((c: { body: string }) => c.body), ['Public']);
    assert.equal(outside.total, 1);
    // B7/W8: the total is the whole thread minus what this visitor may not see,
    // not the page of comments being sent back minus what it left out. Two
    // public comments, one behind the door, read one at a time: two.
    await send('page-comments', { page: '/blog.html', content: 'shared-thread', answers: comment('Bill', 'Also public') });
    await approveAll(pageArea);
    const paged = (await read('page-comments', { page: '/blog.html', content: 'shared-thread', per: '1' })).json();
    assert.equal(paged.comments.length, 1);
    assert.equal(paged.total, 2, 'the secret one is left out of the count as well as the list');
  });

  it('an area about a table needs content-id, and each id is its own thread; counts in one request (C5, C14)', async () => {
    const none = await send('blog-comments', { page: '/blog.html', answers: comment('A', 'b') });
    assert.equal(none.status, 400);
    assert.match(none.json.message, /content-id/);
    for (const [post, n] of [['12', 2], ['13', 1]] as const) {
      for (let i = 0; i < n; i++) assert.equal((await send('blog-comments', { page: '/blog.html', content: post, answers: comment('A', `on ${post}`) })).status, 200);
    }
    await approveAll(postsArea);
    assert.equal((await read('blog-comments', { page: '/blog.html', content: '12' })).json().total, 2);
    const counts = await app.inject({ method: 'GET', url: `/_pammy/comments/blog-comments/counts?${new URLSearchParams({ page: '/blog.html', content: '12,13,14' })}`, headers: headers() });
    assert.deepEqual(counts.json().counts, { 12: 2, 13: 1, 14: 0 });
    assert.equal((await send('blog-comments', { page: '/blog.html', content: '1 OR 1=1', answers: comment('A', 'b') })).status, 400);
  });

  it('a form is not a comment area, and comments are kept out of Responses (C6)', async () => {
    assert.equal((await read('party-form', { page: '/blog.html' })).statusCode, 404);
    const listed = (await admin({ op: 'responses.list' })).responses as { formId: number }[];
    assert.ok(!listed.some((r) => r.formId === pageArea || r.formId === postsArea));
    assert.ok((await admin({ op: 'forms.state' })).commentsWaiting >= 0);
  });

  // docs/comments-plan.md + the blog example: a fixture comment area on the
  // gate's own example page, that cannot fill up her comments
  it("the blog example's comment area: samples back on Reset, on the example page, never piling up, never a red number", async () => {
    const example = { name: 'example-blog-comments', fixture: 'blog-comments', title: 'Blog comments (example)', contentType: 'posts', actor: 'pamela',
      link: { databaseId: 99, engine: 'mariadb', name: 'example_blog', table: 'comments', when: 'approved', fixed: [], enabled: true,
        pairs: [{ key: 'your-name', field: 'author' }, { key: 'your-comment', field: 'body' }] } };
    const samples = [{ contentId: '4', author: 'Sam', body: 'How deep are the beds?', at: clock - 86400 },
      { contentId: '4', author: 'Pamela', body: 'About a foot.', at: clock - 3600 }, { contentId: '7', author: 'Rose', body: 'Radishes!', at: clock - 60 }];
    const made = await admin({ op: 'comments.example', ...example, items: samples });
    assert.equal(made.comments, 3);
    const onExample = { page: '/_pammy/examples/blog/' };
    const post4 = (await read('example-blog-comments', { ...onExample, content: '4' })).json();
    assert.deepEqual(post4.comments.map((c: { author: string }) => c.author), ['Pamela', 'Sam'], 'newest first, on the example page');
    const counts = await app.inject({ method: 'GET', url: `/_pammy/comments/example-blog-comments/counts?${new URLSearchParams({ ...onExample, content: '4,7,9' })}`, headers: headers() });
    assert.deepEqual(counts.json().counts, { 4: 2, 7: 1, 9: 0 });

    // opening every post on the page writes nothing: no rows, no threads
    const before = (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM responses'))!.n;
    for (let post = 1; post <= 14; post++) await read('example-blog-comments', { ...onExample, content: String(post) });
    assert.equal((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM responses'))!.n, before, 'reading is only reading');

    // a passer-by can write in it -- it keeps only the newest 50, and never counts towards her red number
    const waiting = (await admin({ op: 'forms.state' })).commentsWaiting;
    for (let i = 0; i < 60; i++) {
      assert.equal((await send('example-blog-comments', { ...onExample, content: '9', answers: comment(`Visitor ${i}`, `Hello ${i}`) }, { ip: `203.0.113.${i}` })).status, 200);
    }
    const kept = (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM responses WHERE form_id = ?', made.id))!.n;
    assert.equal(Number(kept), 50, 'the newest 50, and no more');
    assert.equal((await admin({ op: 'forms.state' })).commentsWaiting, waiting, 'no red number for the example');
    assert.equal((await read('example-blog-comments', { ...onExample, content: '9' })).json().total, 0, 'and none of it is shown until approved');

    // an ordinary comment area cannot be used on the gate's example pages
    assert.equal((await send('page-comments', { page: '/_pammy/examples/blog/', answers: comment('A', 'b') })).status, 400);
    // Reset puts the samples back
    assert.equal((await admin({ op: 'comments.example', ...example, items: samples })).comments, 3);
  });

  it('the limits are per form: a full comment area does not stop other forms (section 0)', async () => {
    await run(db, `INSERT INTO responses (form_id, form_name, page, answers, created_at)
      SELECT ?, 'blog-comments', 'blog.html', '[]', 1 FROM generate_series(1, 1000)`, postsArea);
    const full = await send('blog-comments', { page: '/blog.html', content: '12', answers: comment('A', 'b') });
    assert.notEqual(full.status, 200);
    assert.match(full.json.message, /can't take answers/);
    assert.equal((await send('page-comments', { page: '/blog.html', answers: comment('A', 'still fine') })).status, 200);
    await run(db, "DELETE FROM responses WHERE form_id = ? AND answers = '[]'", postsArea);
  });

  // docs/phase8-plan.md 8-6 (P8-10): on a site with routes, a comment is on a site folder's
  // page (the file, whatever host shows it) or on a service's page, known by its address;
  // a service's page behind a private route is as private as nginx makes it
  it('with routes: a folder page is its file; a service page is its address, private behind a private route', async () => {
    const { SiteRoutes } = await import('@panel/core/gate/site-routes');
    const priv = await admin({ op: 'route-area.set', routeId: 86, accounts: 'private', address: 'members.pammy.org/' });
    const routesFile = join(root, 'gate-routes-comments.json');
    writeFileSync(routesFile, JSON.stringify({ v: 1, domains: ['pammy.org'], hosts: {
      'about.pammy.org': [{ path: '/', kind: 'folder', folder: 'about', area: null }],
      'shop.pammy.org': [{ path: '/', kind: 'service', service: 'shop', area: null }],
      'members.pammy.org': [{ path: '/', kind: 'service', service: 'club', area: priv.token }],
    } }));
    const routed = new GateLive(live.db, { sessions: visitorSessions, now: () => clock, routes: new SiteRoutes(routesFile) });
    routed.markReady();
    await routed.reloadAreas();
    const r = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(root, 'none.db'), mediaThumbs: join(root, 'thumbs') }, routed);
    const rread = (host: string, q: Record<string, string>) =>
      r.inject({ method: 'GET', url: `/_pammy/comments/page-comments?${new URLSearchParams(q)}`, headers: { host, 'x-pammy-base': '/' } });
    const rsend = (host: string, body: Record<string, unknown>) => r.inject({
      method: 'POST', url: '/_pammy/comments/page-comments', remoteAddress: '127.0.0.1',
      headers: { host, 'x-pammy-base': '/', origin: `https://${host}`, 'content-type': 'application/json', 'x-real-ip': `198.51.100.${Math.floor(Math.random() * 250)}` },
      payload: JSON.stringify(body),
    });
    try {
      // the folder's page: the same conversation as the file's, on whichever host shows it
      const folder = (await rread('about.pammy.org', { page: '/' })).json();
      assert.equal(folder.content, 'about/index.html');
      assert.equal(folder.total, 1, "Rose's comment, sent from pammy.org/about/");
      // a service's page: by its address, no file needed
      const sent = await rsend('shop.pammy.org', { page: '/checkout?step=2', answers: comment('Kim', 'Quick delivery') });
      assert.equal(sent.statusCode, 200, sent.body);
      await approveAll(pageArea);
      const shop = (await rread('shop.pammy.org', { page: '/checkout' })).json();
      assert.equal(shop.content, 'https://shop.pammy.org/checkout');
      assert.deepEqual(shop.comments.map((c: { body: string }) => c.body), ['Quick delivery']);
      assert.equal((await rread('shop.pammy.org', { page: '/basket' })).json().total, 0, 'another address, another conversation');
      assert.equal((await rread('nowhere.pammy.org', { page: '/checkout' })).statusCode, 400, 'a host with no routes');
      // behind a private route: nobody who isn't let in reads or writes there
      assert.equal((await rsend('members.pammy.org', { page: '/news', answers: comment('X', 'nope') })).statusCode, 401);
      assert.equal((await rread('members.pammy.org', { page: '/news' })).statusCode, 401);
      // ... and a thread shared by content-id leaves out what was sent from there
      await run(db, `INSERT INTO responses (form_id, form_name, page, answers, created_at, approved_at, content_type, content_id)
        VALUES (?, 'page-comments', 'https://members.pammy.org/news', ?, ?, ?, 'page', 'shared-thread')`,
      pageArea, JSON.stringify([{ key: 'your-comment', value: 'Behind the route' }]), clock, clock);
      const shared = (await rread('shop.pammy.org', { page: '/checkout', content: 'shared-thread' })).json();
      assert.ok(!shared.comments.some((c: { body: string }) => c.body === 'Behind the route'));
      assert.equal(shared.total, 2, "the two public ones from pammy.org's blog.html");
    } finally {
      await run(db, "DELETE FROM responses WHERE form_id = ? AND page LIKE 'https://%'", pageArea);
      await admin({ op: 'route-area.set', routeId: 86, accounts: null });
      await r.close();
    }
  });
});

describe('forms: reading, approving and the trash', () => {
  let party = 0;
  it('lists responses, marks them read, trashes and restores them', async () => {
    const st = await admin({ op: 'forms.state' });
    party = st.forms.find((f: { name: string }) => f.name === 'party-form').id;
    const list = await admin({ op: 'responses.list' });
    assert.ok(list.responses.length >= 2, `${list.responses.length} responses`);
    // the examples' entries are in the list too, but read and never in the red number
    const hers = await admin({ op: 'responses.list', hideExamples: true });
    assert.equal(list.unread, hers.responses.length);
    assert.ok(list.responses.length > hers.responses.length, 'the examples are in the list as well');
    const first = list.responses[0].id;
    await admin({ op: 'response.read', id: first, read: true, actor: 'pamela' });
    assert.equal((await admin({ op: 'responses.list', read: 'unread' })).responses.length, hers.responses.length - 1);
    assert.equal((await admin({ op: 'responses.list', read: 'read' })).responses.length, list.responses.length - hers.responses.length + 1);
    assert.equal((await admin({ op: 'responses.read-all', formId: party, actor: 'pamela' })).marked, hers.responses.length - 1);
    await admin({ op: 'response.trash', id: first, actor: 'pamela' });
    assert.deepEqual((await admin({ op: 'responses.list', trash: true })).responses.map((r: { id: number }) => r.id), [first]);
    await admin({ op: 'response.restore', id: first });
    assert.equal((await admin({ op: 'responses.list', trash: true })).responses.length, 0);
  });

  it('approves only when the form says so, and marks it read', async () => {
    const list = await admin({ op: 'responses.list', formId: party });
    const id = list.responses[0].id;
    await assert.rejects(admin({ op: 'response.approve', id, approved: true, actor: 'pamela' }),
      (e: { message: string }) => /doesn't have approvals switched on/.test(e.message));
    assert.equal(list.responses[0].approvable, false);
    await admin({ op: 'form.switches', id: party, approvable: true });
    await admin({ op: 'response.read', id, read: false });
    const r = await admin({ op: 'response.approve', id, approved: true, actor: 'pamela' });
    assert.ok(r.approvedAt);
    const after = (await admin({ op: 'responses.list', formId: party })).responses.find((x: { id: number }) => x.id === id);
    assert.deepEqual([!!after.approvedAt, after.approvedBy, !!after.readAt, after.approvable], [true, 'pamela', true, true]);
    assert.equal((await admin({ op: 'responses.list', formId: party, approval: 'approved' })).responses.length, 1);
    assert.ok((await admin({ op: 'responses.list', formId: party, approval: 'waiting' })).responses.every((x: { approvedAt: number | null }) => !x.approvedAt));
    await admin({ op: 'response.approve', id, approved: false, actor: 'pamela' });
    assert.equal((await admin({ op: 'responses.list', formId: party, approval: 'approved' })).responses.length, 0);
    await admin({ op: 'response.approve', id, approved: true, actor: 'pamela' });
  });

  it("trashing a form doesn't touch its responses, and can't be read through the API", async () => {
    const before = (await admin({ op: 'responses.list', formId: party })).responses.length;
    await admin({ op: 'form.trash', id: party, actor: 'pamela' });
    assert.equal((await admin({ op: 'responses.list', formId: party })).responses.length, before);
    await admin({ op: 'form.restore', id: party });
  });

  // per form (docs/comments-plan.md, section 0): a flood on this form stops this form
  it('stops taking responses when too many are unread', async () => {
    await run(db, "INSERT INTO responses (form_id, form_name, page, answers, created_at) SELECT ?, 'flood', 'x', '[]', ? FROM generate_series(1, 1000)", party, clock);
    const res = await app.inject({
      method: 'POST', url: '/_pammy/forms/party-form', remoteAddress: '127.0.0.1',
      headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': '198.51.100.7' },
      payload: JSON.stringify({ page: '/open/rsvp.html', answers: { 'your-name': { first: 'A', last: 'B' }, coming: 'Yes', 'i-agree': true } }),
    });
    assert.equal(res.statusCode, 503);
    await run(db, "DELETE FROM responses WHERE form_name = 'flood'");
  });

  it("doesn't write answers or keys to the admin socket's log", async () => {
    const lines: string[] = [];
    const sock = join(root, 'admin-forms.sock');
    const server = createGateAdminServer(live, () => clock, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(sock, r));
    const list = await callJsonLine<{ responses: { id: number }[] }>(sock, { op: 'responses.list', actor: 'pamela' }, 'gate');
    await callJsonLine(sock, { op: 'response.read', id: list.responses[0]!.id, read: true, actor: 'pamela' }, 'gate');
    const made = await callJsonLine<{ key: string }>(sock, { op: 'apikey.create', label: 'Log test', level: 'approved', forms: 'all', actor: 'pamela' }, 'gate');
    await new Promise<void>((r) => server.close(() => r()));
    assert.ok(lines.length >= 2, lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('Rose') && !l.includes(made.key)), lines.join('\n'));
  });
});

// ------------------------------------------------------------------ the responses API
describe('the responses API', () => {
  let form = 0;
  let keyAll = '';
  let keyApproved = '';
  let keyOther = '';
  const ids: number[] = [];
  const call = (url: string, opts: { key?: string; headers?: Record<string, string> } = {}) =>
    app.inject({ method: 'GET', url, headers: { host: 'pammy.org', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...opts.headers } });

  before(async () => {
    file('open/guestbook.html');
    const f = await admin({ op: 'form.create', name: 'guestbook', title: 'Guest book', items: [
      { type: 'short-text', label: 'Your name', required: true },
      { type: 'long-text', label: 'Message', required: true },
      { type: 'email', label: 'Email' },
      { type: 'dropdown', label: 'Town', options: ['Bath', 'Bristol'] },
    ], actor: 'pamela' });
    form = f.id;
    await admin({ op: 'form.switches', id: form, approvable: true });
    const rows: [string, string, string, string][] = [
      ['Rose', 'Lovely cake', 'rose@example.com', 'Bath'],
      ['Sam', 'Thank you', 'sam@example.com', 'Bristol'],
      ['Priya', 'Wonderful day', 'priya@example.com', 'Bath'],
    ];
    for (const [name, message, email, town] of rows) {
      clock += 60;
      const res = await app.inject({
        method: 'POST', url: '/_pammy/forms/guestbook', remoteAddress: '127.0.0.1',
        headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': `198.51.100.${rows.length}` },
        payload: JSON.stringify({ page: '/open/guestbook.html', answers: { 'your-name': name, message, email, town } }),
      });
      assert.equal(res.statusCode, 200, res.body);
      ids.push((await one<{ id: number }>(db, 'SELECT max(id) AS id FROM responses'))!.id);
    }
    await admin({ op: 'response.approve', id: ids[0]!, approved: true, actor: 'pamela' });
    await admin({ op: 'response.approve', id: ids[2]!, approved: true, actor: 'pamela' });
    keyAll = (await admin({ op: 'apikey.create', label: 'Everything', level: 'all', forms: 'all', actor: 'momolig' })).key;
    keyApproved = (await admin({ op: 'apikey.create', label: 'Approved only', level: 'approved', forms: [form], actor: 'momolig' })).key;
    keyOther = (await admin({ op: 'apikey.create', label: 'Another form', level: 'all', forms: [1], actor: 'momolig' })).key;
  });

  it('gives every response to a key that may read them, oldest first', async () => {
    const r = await call(`/_pammy/api/forms/${form}/all`, { key: keyAll });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.deepEqual([body.form.name, body.total, body.next], ['guestbook', 3, null]);
    assert.deepEqual(body.fields.map((f: { key: string }) => f.key), ['your-name', 'message', 'email', 'town']);
    assert.deepEqual(body.responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Rose', 'Sam', 'Priya']);
    assert.deepEqual(body.responses[0].answers, { 'your-name': 'Rose', message: 'Lovely cake', email: 'rose@example.com', town: 'Bath' });
    assert.deepEqual([body.responses[0].approved, body.responses[1].approved], [true, false]);
    assert.equal(body.responses[0].page, 'open/guestbook.html');
    assert.match(body.responses[0].sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(r.headers['cache-control'], 'private, no-store');
  });

  it('gives only approved ones to an approved-only key, and refuses the rest', async () => {
    const ok = await call(`/_pammy/api/forms/${form}/approved`, { key: keyApproved });
    assert.deepEqual(ok.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Rose', 'Priya']);
    assert.equal(ok.json().responses[0].approved, undefined, 'they are all approved, so it is not repeated');
    const no = await call(`/_pammy/api/forms/${form}/all`, { key: keyApproved });
    assert.deepEqual([no.statusCode, no.json().error], [403, 'not-allowed']);
    const otherForm = await call(`/_pammy/api/forms/${form}/all`, { key: keyOther });
    assert.deepEqual([otherForm.statusCode, otherForm.json().error], [403, 'not-allowed']);
  });

  it('sorts, pages and filters', async () => {
    const desc = await call(`/_pammy/api/forms/${form}/all?order=desc`, { key: keyAll });
    assert.deepEqual(desc.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Priya', 'Sam', 'Rose']);
    const page1 = await call(`/_pammy/api/forms/${form}/all?limit=2`, { key: keyAll });
    assert.equal(page1.json().responses.length, 2);
    assert.equal(page1.json().total, 3);
    const page2 = await call(`/_pammy/api/forms/${form}/all?limit=2&after=${encodeURIComponent(page1.json().next)}`, { key: keyAll });
    assert.deepEqual(page2.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Priya']);
    assert.equal(page2.json().next, null);

    const bath = await call(`/_pammy/api/forms/${form}/all/filterby/town/Bath`, { key: keyAll });
    assert.deepEqual(bath.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Rose', 'Priya']);
    assert.equal(bath.json().total, 2);
    const caps = await call(`/_pammy/api/forms/${form}/all/filterby/town/${encodeURIComponent(' bristol ')}`, { key: keyAll });
    assert.deepEqual(caps.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Sam'], 'capitals and spaces are ignored');
    const approvedBath = await call(`/_pammy/api/forms/${form}/approved/filterby/town/Bath`, { key: keyApproved });
    assert.equal(approvedBath.json().total, 2);
    const none = await call(`/_pammy/api/forms/${form}/all/filterby/town/Leeds`, { key: keyAll });
    assert.deepEqual([none.json().total, none.json().responses.length], [0, 0]);
  });

  it('refuses what it should', async () => {
    const cases: [string, number, string][] = [
      [`/_pammy/api/forms/${form}/all`, 401, 'no-key'],
      [`/_pammy/api/forms/999999/all`, 401, 'no-key'],
      [`/_pammy/api/forms/${form}/all?order=sideways`, 400, 'bad-order'],
      [`/_pammy/api/forms/${form}/all?limit=0`, 400, 'bad-limit'],
      [`/_pammy/api/forms/${form}/all?limit=1001`, 400, 'bad-limit'],
      [`/_pammy/api/forms/${form}/all?after=nonsense!`, 400, 'bad-cursor'],
      [`/_pammy/api/forms/${form}/all/filterby/nope/x`, 400, 'unknown-field'],
    ];
    for (const [url, status, error] of cases) {
      const key = url.includes('order') || url.includes('limit') || url.includes('after') || url.includes('filterby') ? keyAll : undefined;
      const r = await call(url, { key });
      assert.deepEqual([r.statusCode, r.json().error], [status, error], url);
    }
    const bad = await call(`/_pammy/api/forms/${form}/all`, { key: 'pammy_notarealkeynotarealkeynotarealkeynotareal' });
    assert.deepEqual([bad.statusCode, bad.json().error], [401, 'bad-key']);
    const inQuery = await call(`/_pammy/api/forms/${form}/all?key=${keyAll}`);
    assert.deepEqual([inQuery.statusCode, inQuery.json().error], [400, 'key-in-query']);
    const missing = await call('/_pammy/api/forms/999999/all', { key: keyAll });
    assert.deepEqual([missing.statusCode, missing.json().error], [404, 'no-form']);
    // a form nobody approves has no approved list
    const plain = await admin({ op: 'form.create', name: 'plain-form', items: [{ type: 'short-text', label: 'A' }] });
    const notApprovable = await call(`/_pammy/api/forms/${plain.id}/approved`, { key: keyAll });
    assert.deepEqual([notApprovable.statusCode, notApprovable.json().error], [404, 'not-approvable']);
  });

  it('a revoked key stops working at once', async () => {
    const made = await admin({ op: 'apikey.create', label: 'Short lived', level: 'all', forms: 'all', actor: 'momolig' });
    assert.equal((await call(`/_pammy/api/forms/${form}/all`, { key: made.key })).statusCode, 200);
    await admin({ op: 'apikey.revoke', id: made.apiKey.id, actor: 'momolig' });
    assert.deepEqual((await call(`/_pammy/api/forms/${form}/all`, { key: made.key })).json().error, 'bad-key');
    const keys = (await admin({ op: 'apikeys.list' })).keys as { id: number; prefix: string; revokedAt: number | null; lastUsedAt: number | null }[];
    const k = keys.find((x) => x.id === made.apiKey.id)!;
    assert.match(k.prefix, /^pammy_[A-Za-z0-9_-]{8}$/);
    assert.ok(k.revokedAt && k.lastUsedAt);
    assert.ok(!JSON.stringify(keys).includes(made.key), 'the key itself is never given back');
  });

  it('lets anyone read approved responses only when she says so, and only the public fields', async () => {
    const shut = await call(`/_pammy/api/forms/${form}/approved`);
    assert.deepEqual([shut.statusCode, shut.json().error], [401, 'no-key']);
    await admin({ op: 'form.switches', id: form, publicApproved: true });
    const open = await call(`/_pammy/api/forms/${form}/approved`);
    assert.equal(open.statusCode, 200);
    const body = open.json();
    assert.deepEqual(body.fields.map((f: { key: string }) => f.key), ['your-name', 'message', 'town'], 'the email address is not public');
    assert.deepEqual(body.responses.map((x: { answers: Record<string, unknown> }) => Object.keys(x.answers)), [['your-name', 'message', 'town'], ['your-name', 'message', 'town']]);
    assert.equal(body.responses[0].page, undefined, 'where it was sent from is not public');
    assert.equal(open.headers['cache-control'], 'no-cache');
    const tag = open.headers.etag as string;
    assert.ok(tag);
    assert.equal((await call(`/_pammy/api/forms/${form}/approved`, { headers: { 'if-none-match': tag } })).statusCode, 304);
    // still nothing else without a key
    assert.equal((await call(`/_pammy/api/forms/${form}/all`)).json().error, 'no-key');
    assert.equal((await call(`/_pammy/api/forms/${form}/approved/filterby/email/rose@example.com`)).json().error, 'unknown-field', 'a private field cannot be guessed at');
    assert.equal((await call(`/_pammy/api/forms/${form}/approved/filterby/town/Bath`)).json().total, 2);
  });

  it('finds the same form by name, with the same rules', async () => {
    // by-name runs after the test above, so this form is open to everyone.
    const open = await call('/_pammy/api/forms/by-name/guestbook/approved?order=desc');
    assert.equal(open.statusCode, 200);
    const body = open.json();
    assert.deepEqual([body.form.id, body.form.name, body.total], [form, 'guestbook', 2]);
    assert.deepEqual(body.responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Priya', 'Rose']);
    assert.deepEqual(body.fields.map((f: { key: string }) => f.key), ['your-name', 'message', 'town'], 'the email address is not public here either');
    assert.equal((await call('/_pammy/api/forms/by-name/guestbook/approved/filterby/town/Bath')).json().total, 2);
    // a key works the same way
    const keyed = await call('/_pammy/api/forms/by-name/guestbook/all', { key: keyAll });
    assert.deepEqual([keyed.statusCode, keyed.json().total], [200, 3]);
    // and nothing is given away about forms that aren't open: the same answer either way
    const noSuchName = await call('/_pammy/api/forms/by-name/nobody-has-this-name/approved');
    const notAName = await call('/_pammy/api/forms/by-name/NOT A NAME/approved');
    const shutForm = await call('/_pammy/api/forms/by-name/guestbook/all');
    for (const r of [noSuchName, notAName, shutForm]) assert.deepEqual([r.statusCode, r.json().error], [401, 'no-key']);
    assert.equal((await call('/_pammy/api/forms/by-name/nobody-has-this-name/approved', { key: keyAll })).json().message,
      'There is no form with that name.');
  });

  it('shows who sent it only when the form says so', async () => {
    const st = await admin({ op: 'form.get', id: form });
    const withSender = await call(`/_pammy/api/forms/${form}/approved`, { key: keyApproved });
    assert.equal(withSender.json().responses[0].signedInAs, undefined, 'nobody was signed in for these');
    await admin({ op: 'form.save', id: form, version: st.version, items: st.items, settings: { showSender: true } });
    assert.equal((await call(`/_pammy/api/forms/${form}/approved`)).statusCode, 200);
  });

  it('never gives out a response in the trash', async () => {
    await admin({ op: 'response.trash', id: ids[0]!, actor: 'pamela' });
    const r = await call(`/_pammy/api/forms/${form}/approved`, { key: keyApproved });
    assert.deepEqual(r.json().responses.map((x: { answers: { 'your-name': string } }) => x.answers['your-name']), ['Priya']);
    await admin({ op: 'response.restore', id: ids[0]! });
  });
});

// ------------------------------------------------------------------ the worked examples
describe('the worked examples', () => {
  const page = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'pammy.org', 'x-pammy-base': '/' } });
  const api = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'pammy.org' } });
  const sign = (answers: Record<string, unknown>, ip = '198.51.100.7') => app.inject({
    method: 'POST', url: '/_pammy/forms/example-guest-book', remoteAddress: '127.0.0.1',
    headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': ip },
    payload: JSON.stringify({ page: '/_pammy/examples/guestbook/', answers }),
  });
  const guestbook = async () => (await one<{ id: number; name: string; enabled: number; approvable: number; public_approved: number }>(db, "SELECT * FROM forms WHERE fixture = 'guestbook'"))!;

  it('makes all three, switched on and with their sample entries approved', async () => {
    const forms = await all<{ id: number; name: string; fixture: string; enabled: number; approvable: number; public_approved: number }>(db, "SELECT * FROM forms WHERE fixture IS NOT NULL AND kind <> 'comments' ORDER BY id");
    assert.deepEqual(forms.map((f) => [f.fixture, f.name, f.enabled, f.approvable, f.public_approved]), [
      ['guestbook', 'example-guest-book', 1, 1, 1],
      ['rsvp', 'example-rsvp', 1, 1, 1],
      ['pinboard', 'example-pinboard', 1, 1, 1],
    ]);
    const entries = (await one<{ n: number; approved: number }>(db, "SELECT count(*) AS n, count(*) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM responses WHERE form_id IN (SELECT id FROM forms WHERE fixture IS NOT NULL AND kind <> 'comments')"))!;
    assert.deepEqual([entries.n, entries.approved], [11, 11], 'the pages have something on them from the start');
  });

  it('serves each page with its two files, never to be indexed', async () => {
    for (const kind of ['guestbook', 'rsvp', 'pinboard']) {
      const slash = await page(`/_pammy/examples/${kind}/`);
      assert.equal(slash.statusCode, 200, kind);
      assert.match(slash.headers['x-robots-tag'] as string, /noindex/);
      assert.match(slash.body, /<pammy-form name="example-/);
      assert.match(slash.body, /src="\/_pammy\/forms\.js"/);
      assert.ok(!slash.body.includes('@FORM@') && !slash.body.includes('@FILES@'), 'nothing is left to fill in');
      // without the slash, style.css would be looked for a folder up
      const bare = await page(`/_pammy/examples/${kind}`);
      assert.deepEqual([bare.statusCode, bare.headers.location], [301, `/_pammy/examples/${kind}/`]);
      assert.equal((await page(`/_pammy/examples/${kind}/style.css`)).headers['content-type'], 'text/css; charset=utf-8');
      assert.equal((await page(`/_pammy/examples/${kind}/entries.js`)).headers['content-type'], 'text/javascript; charset=utf-8');
    }
    assert.equal((await page('/_pammy/examples/nonesuch/')).statusCode, 404);
  });

  it('gives its approved entries to anyone by name, and keeps the private answers back', async () => {
    const book = await api('/_pammy/api/forms/by-name/example-guest-book/approved?order=desc');
    assert.equal(book.statusCode, 200);
    assert.deepEqual(book.json().responses.map((r: { answers: { 'your-name': string } }) => r.answers['your-name']), ['Auntie Jo', 'Dilip', 'Rose']);
    const rsvp = await api('/_pammy/api/forms/by-name/example-rsvp/approved/filterby/coming/Yes');
    assert.deepEqual([rsvp.json().total, rsvp.json().responses.map((r: { answers: Record<string, unknown> }) => r.answers['how-many'])], [2, [2, 1]]);
    assert.ok(!JSON.stringify(rsvp.json()).includes('Bringing the pudding'), '"anything I should know" is not public');
    assert.ok(!JSON.stringify(rsvp.json()).includes('notes'), 'not even the question is given out');
  });

  it('takes an entry from a passer-by without putting a red number on her Responses tab', async () => {
    const before = await admin({ op: 'responses.list' });
    const sent = await sign({ 'your-name': 'A stranger', message: 'Hello!' });
    assert.deepEqual([sent.statusCode, sent.json()], [200, { ok: true }]);
    const after = await admin({ op: 'responses.list' });
    assert.equal(after.unread, before.unread, 'the red number is hers alone');
    assert.ok(after.responses.some((r: { answers: { value: unknown }[] }) => JSON.stringify(r.answers).includes('A stranger')),
      'but it is in the list, where she can see it');
    // Home asks for hers only, so what it says is waiting agrees with the number
    const home = await admin({ op: 'responses.list', hideExamples: true, read: 'unread' });
    assert.ok(!JSON.stringify(home.responses).includes('A stranger'), "Home doesn't show the examples' entries");
    const own = await admin({ op: 'responses.list', formId: (await guestbook()).id });
    assert.equal(own.responses[0].answers.find((a: { key: string }) => a.key === 'your-name').value, 'A stranger', 'and it is there when she asks for the example');
    assert.ok(!(await api('/_pammy/api/forms/by-name/example-guest-book/approved')).body.includes('A stranger'), 'until she approves it, nobody sees it');
  });

  it('keeps only the newest 50 entries, however many arrive', async () => {
    const id = (await guestbook()).id;
    const count = async () => (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM responses WHERE form_id = ?', id))!.n;
    for (let i = 0; i < 60; i++) {
      clock += 60;
      const r = await sign({ 'your-name': `Visitor ${i}`, message: 'Knock knock' }, `198.51.100.${100 + (i % 40)}`);
      assert.equal(r.statusCode, 200, r.body);
    }
    assert.equal(await count(), 50);
    const oldest = (await one<{ answers: string }>(db, 'SELECT answers FROM responses WHERE form_id = ? ORDER BY id LIMIT 1', id))!;
    assert.ok(!oldest.answers.includes('Rose'), 'the sample entries fall off the end like any other');
    assert.equal((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM response_values WHERE response_id NOT IN (SELECT id FROM responses)'))!.n, 0);
  });

  it('cannot be deleted, but can be copied and reset', async () => {
    const id = (await guestbook()).id;
    await assert.rejects(admin({ op: 'form.trash', id, actor: 'pamela' }), /one of the examples/);
    const copy = await admin({ op: 'form.duplicate', id, name: 'my-guest-book', actor: 'pamela' });
    assert.deepEqual([copy.name, copy.fixture, copy.approvable], ['my-guest-book', null, true], 'a copy is an ordinary form of hers');

    // she changes it about, then puts it back
    await admin({ op: 'form.switches', id, enabled: false, approvable: false, publicApproved: false });
    const before = await admin({ op: 'form.get', id });
    await admin({ op: 'form.save', id, version: before.version, title: 'My own words', items: before.items, actor: 'pamela' });
    const reset = await admin({ op: 'example.reset', kind: 'guestbook' });
    assert.deepEqual([reset.id, reset.title, reset.enabled, reset.approvable, reset.publicApproved], [id, 'Guest book', true, true, true]);
    assert.deepEqual(reset.items.map((i: { key: string }) => i.key), ['your-name', 'from', 'message', 'email']);
    const entries = await all<{ answers: string }>(db, 'SELECT answers FROM responses WHERE form_id = ? ORDER BY id', id);
    assert.equal(entries.length, 3, 'the sample entries are back, and everything else is gone');
    assert.ok(entries.every((e) => !e.answers.includes('Visitor ')));
    assert.equal((await api('/_pammy/api/forms/by-name/example-guest-book/approved')).json().total, 3);
    await assert.rejects(admin({ op: 'example.reset', kind: 'nonesuch' }), /no example of that kind/);
  });

  it('is printed in the guide file for file, so she can build one by hand', () => {
    const guide = parseGuide('10-forms.txt', readFileSync(new URL('../../forms-guide.txt', import.meta.url), 'utf8'));
    // PART 12 guest book, PART 13 who's coming, PART 14 pinboard: each tutorial holds
    // that example's three files, word for word, each as one piece of code to copy.
    const tutorials: [number, ExampleKind, string, string][] = [
      [12, 'guestbook', 'guest-book', 'guestbook-files'],
      [13, 'rsvp', 'whos-coming', 'whos-coming-files'],
      [14, 'pinboard', 'pinboard', 'pinboard-files'],
    ];
    // the numbers here are what the panel links to from each example (examples.ts)
    for (const [part, kind] of tutorials) assert.equal(EXAMPLES[kind].guidePart, part, `${kind} points at PART ${part}`);
    for (const [part, kind, formName, filesDir] of tutorials) {
      const sec = guide.sections.find((s) => s.part === part);
      assert.ok(sec, `PART ${part}`);
      assert.match(sec.title, /^Tutorial: /, `PART ${part} is a tutorial`);
      const code = sec.blocks.filter((b) => b.t === 'code').map((b) => (b as { text: string }).text);
      const page = examplePage(new URL('../public-gate/examples/', import.meta.url).pathname, kind, formName, filesDir);
      for (const [what, text] of Object.entries(page)) {
        assert.ok(code.includes(text.trimEnd()), `PART ${part} has the ${what} of the ${kind} example, exactly as it ships`);
      }
      // and the files it names are the ones it prints
      for (const file of [`${filesDir}/style.css`, `${filesDir}/entries.js`]) assert.ok(sec.text.includes(file), `PART ${part} names ${file}`);
      assert.ok(sec.text.includes(formName), `PART ${part} names the form`);
    }
  });

  it('offers the same questions as starters for a form of her own', async () => {
    const { starters } = await admin({ op: 'starters' });
    assert.deepEqual(starters.map((s: { kind: string }) => s.kind), ['contact', 'guestbook', 'rsvp', 'pinboard']);
    const made = await admin({ op: 'form.create', name: 'olivias-book', starter: 'guestbook', actor: 'pamela' });
    assert.deepEqual([made.title, made.fixture, made.settings.submitText], ['Guest book', null, 'Sign the book']);
    assert.deepEqual(made.items.map((i: { key: string; public?: boolean }) => `${i.key}:${i.public}`),
      ['your-name:true', 'from:true', 'message:true', 'email:false'], 'the email address is private from the start');
    // and it is hers: off until she says otherwise, like any new form
    assert.deepEqual([made.enabled, made.approvable, made.publicApproved], [true, false, false]);
  });

  it('builds her own copy of a page from the very same files', async () => {
    const form = await admin({ op: 'form.get', id: (await admin({ op: 'forms.state' })).forms.find((f: { name: string }) => f.name === 'olivias-book').id });
    const built = await admin({ op: 'example.files', kind: 'guestbook', formId: form.id, pageName: 'signing-book.html' });
    assert.deepEqual(built.files.map((f: { path: string }) => f.path), ['signing-book.html', 'signing-book-files/style.css', 'signing-book-files/entries.js']);
    const html = built.files[0].content;
    assert.match(html, /<pammy-form name="olivias-book">/);
    assert.match(html, /href="signing-book-files\/style\.css"/);
    assert.ok(!html.includes('example-guest-book'), 'it points at her form, not ours');
    assert.equal(built.files[2].content, (await page('/_pammy/examples/guestbook/entries.js')).body, 'the same little program the example runs');
  });
});

// ------------------------------------------------------------------ show right away (docs/auto-approve-plan.md)
describe('forms: show right away', () => {
  let form = 0;
  let n = 0;
  const send = async (name: string, who: string) => {
    clock += 1;
    const res = await app.inject({
      method: 'POST', url: `/_pammy/forms/${name}`, remoteAddress: '127.0.0.1',
      headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': `203.0.113.${100 + ++n}` },
      payload: JSON.stringify({ page: '/open/quick.html', answers: { 'your-name': who } }),
    });
    assert.equal(res.statusCode, 200, res.body);
    return (await one<{ id: number }>(db, 'SELECT max(id) AS id FROM responses'))!.id;
  };
  const response = async (id: number) =>
    (await admin({ op: 'responses.list', formId: form, trash: false })).responses.find((r: { id: number }) => r.id === id);
  const publicNames = async () => (await app.inject({ method: 'GET', url: `/_pammy/api/forms/${form}/approved`, headers: { host: 'pammy.org' } }))
    .json().responses.map((r: { answers: { 'your-name': string } }) => r.answers['your-name']);

  it('waits for her OK unless she chooses otherwise', async () => {
    form = (await admin({ op: 'form.create', name: 'quick-book', items: [{ type: 'short-text', label: 'Your name', required: true }], actor: 'pamela' })).id;
    await admin({ op: 'form.switches', id: form, enabled: true, approvable: true, publicApproved: true });
    assert.equal((await admin({ op: 'form.get', id: form })).autoApprove, false);
    const id = await send('quick-book', 'Waiting Wendy');
    assert.equal((await response(id)).approvedAt, null);
    assert.deepEqual(await publicNames(), []);
  });

  it('only on a form whose responses can be approved', async () => {
    const other = (await admin({ op: 'form.create', name: 'quick-other', items: [], actor: 'pamela' })).id;
    await assert.rejects(admin({ op: 'form.switches', id: other, autoApprove: true }), (e: { message: string }) => /Responses can be approved/.test(e.message));
  });

  it('approves a new response as it arrives, leaves it unread, and the page shows it at once', async () => {
    const r = await admin({ op: 'form.switches', id: form, autoApprove: true });
    assert.deepEqual([r.autoApprove, r.unreviewedAuto], [true, 0]);
    const before = (await admin({ op: 'responses.list' })).unread;
    const id = await send('quick-book', 'Quick Quentin');
    const m = await response(id);
    assert.ok(m.approvedAt);
    assert.deepEqual([m.approvedAuto, m.approvedBy, m.readAt], [true, null, null], 'approved by nobody, and still unread');
    assert.equal((await admin({ op: 'responses.list' })).unread, before + 1, 'it counts in the red number');
    assert.deepEqual(await publicNames(), ['Quick Quentin']);
    assert.equal((await admin({ op: 'responses.list', formId: form, approval: 'waiting' })).responses.length, 1, 'the earlier one is not touched');
  });

  it('keeps the choice while approving is off, and approves nothing then', async () => {
    await admin({ op: 'form.switches', id: form, approvable: false, publicApproved: false });
    const id = await send('quick-book', 'Off Olive');
    assert.equal((await response(id)).approvedAt, null);
    const f = await admin({ op: 'form.switches', id: form, approvable: true, publicApproved: true });
    assert.equal(f.autoApprove, true, 'switching approving back on returns to the same way');
    await admin({ op: 'response.trash', id, actor: 'pamela' });
  });

  it('a duplicate copies it', async () => {
    assert.equal((await admin({ op: 'form.duplicate', id: form, name: 'quick-copy', actor: 'pamela' })).autoApprove, true);
  });

  it('by hand from then on: unapproving and approving again makes it an ordinary approval', async () => {
    const id = (await admin({ op: 'responses.list', formId: form, approval: 'approved' })).responses[0].id;
    await admin({ op: 'response.approve', id, approved: false, actor: 'pamela' });
    const off = await response(id);
    assert.deepEqual([off.approvedAt, off.approvedAuto], [null, false]);
    await admin({ op: 'response.approve', id, approved: true, actor: 'pamela' });
    const m = await response(id);
    assert.deepEqual([m.approvedAuto, m.approvedBy, !!m.readAt], [false, 'pamela', true]);
  });

  it('switching back offers to hide only what went up on its own and nobody opened', async () => {
    const junk1 = await send('quick-book', 'Junk One');
    const junk2 = await send('quick-book', 'Junk Two');
    const seen = await send('quick-book', 'Seen Sally');
    const binned = await send('quick-book', 'Binned Bob');
    await admin({ op: 'response.read', id: seen, read: true, actor: 'pamela' });
    await admin({ op: 'response.trash', id: binned, actor: 'pamela' });
    const r = await admin({ op: 'form.switches', id: form, autoApprove: false });
    assert.deepEqual([r.autoApprove, r.unreviewedAuto], [false, 2]);
    assert.deepEqual(await admin({ op: 'form.hide-unreviewed', id: form }), { id: form, name: 'quick-book', hidden: 2 });
    for (const id of [junk1, junk2]) {
      const m = await response(id);
      assert.deepEqual([m.approvedAt, m.approvedAuto], [null, false]);
    }
    assert.ok((await response(seen)).approvedAt, 'what she opened stays approved');
    assert.deepEqual((await publicNames()).sort(), ['Quick Quentin', 'Seen Sally']);
    assert.equal((await response(await send('quick-book', 'Later Lou'))).approvedAt, null, 'new ones wait again');
  });

  it('the examples always wait, and Reset keeps it so', async () => {
    const ex = (await one<{ id: number }>(db, "SELECT id FROM forms WHERE fixture = 'guestbook'"))!;
    await assert.rejects(admin({ op: 'form.switches', id: ex.id, autoApprove: true }), (e: { message: string }) => /always wait/.test(e.message));
    // even with the flag set behind its back, an example's entries aren't approved on arrival
    await run(db, 'UPDATE forms SET auto_approve = 1 WHERE id = ?', ex.id);
    const res = await app.inject({
      method: 'POST', url: '/_pammy/forms/example-guest-book', remoteAddress: '127.0.0.1',
      headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': '203.0.113.250' },
      payload: JSON.stringify({ page: '/_pammy/examples/guestbook/', answers: { 'your-name': 'Eve', message: 'Hello' } }),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await one<{ approved_at: number | null }>(db, 'SELECT approved_at FROM responses WHERE id = (SELECT max(id) FROM responses)'))!.approved_at, null);
    await admin({ op: 'example.reset', kind: 'guestbook' });
    assert.equal((await one<{ auto_approve: number }>(db, 'SELECT auto_approve FROM forms WHERE id = ?', ex.id))!.auto_approve, 0);
  });
});

// ------------------------------------------------------------------ renames
describe('renames and repairs', () => {
  it('a renamed protected folder stays protected (the marker moves with it)', async () => {
    renameSync(join(pub, 'recipes', 'private'), join(pub, 'recipes', 'renamed'));
    assert.equal((await check('/recipes/renamed/secret.jpg')).status, 401);
    assert.equal((await check('/recipes/renamed/login.html')).status, 204);
    // and a new folder under the old name is still protected by the database path
    file('recipes/private/new.html');
    assert.equal((await check('/recipes/private/new.html')).status, 401);
  });
});

describe('pages', () => {
  it('serves the built-in sign-in page with a strict policy and only a well-formed area', async () => {
    const res = await app.inject({ method: 'GET', url: `/_pammy/login?area=${tokens.C}&next=/members/`, headers: { host: 'pammy.org' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.match(res.body, new RegExp(`area="${tokens.C}"`));
    const bad = await app.inject({ method: 'GET', url: '/_pammy/login?area="><script>alert(1)</script>', headers: { host: 'pammy.org' } });
    assert.match(bad.body, /area=""/);
    assert.doesNotMatch(bad.body, /<script>alert/);
  });

  it('serves the component', async () => {
    const res = await app.inject({ method: 'GET', url: '/_pammy/login.js', headers: { host: 'pammy.org' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.match(res.body, /customElements\.define\(['"`]pammy-login['"`]/);
    assert.equal(res.headers['cache-control'], 'no-store', "never cached: Cloudflare turns no-cache into 4 hours");
  });

  it('knows nothing else', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/_pammy/check', headers: { host: 'pammy.org' } })).statusCode, 404);
  });
});

describe('admin socket', () => {
  it('checks every value', async () => {
    const refuse = async (req: Record<string, unknown>, code: string) =>
      assert.rejects(admin(req), (e: { code: string }) => e.code === code, JSON.stringify(req));
    for (const path of ['', '/', '../x', 'a/../b', '.git', 'a/.hidden', 'x'.repeat(201)]) await refuse({ op: 'area.create', path }, 'invalid');
    await refuse({ op: 'area.create', path: 'members' }, 'exists');
    await refuse({ op: 'visitor.create', username: 'dave', password: 'short' }, 'invalid');
    await refuse({ op: 'visitor.create', username: 'Bad Name!', password: 'long-enough-pass' }, 'invalid');
    await refuse({ op: 'visitor.create', username: 'alice', password: 'long-enough-pass' }, 'exists');
    await refuse({ op: 'grant', visitorId: 99999, areaId: ids.A, allow: true }, 'not-found');
    await refuse({ op: 'grant', visitorId: ids.alice, areaId: ids.A, allow: 'yes' }, 'invalid');
    await refuse({ op: 'drop tables' }, 'invalid');
  });

  it('never writes passwords to its log, and works over the socket', async () => {
    const lines: string[] = [];
    const sock = join(root, 'admin.sock');
    const server = createGateAdminServer(live, () => clock, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(sock, r));
    await callJsonLine(sock, { op: 'visitor.create', username: 'erin', password: 'erin-secret-password', actor: 'pamela' }, 'gate');
    await assert.rejects(callJsonLine(sock, { op: 'visitor.create', username: 'erin', password: 'erin-secret-password' }, 'gate'));
    const link = await callJsonLine<{ url: string }>(sock, { op: 'link.create', visitorId: ids.bob, actor: 'pamela' }, 'gate');
    await callJsonLine(sock, { op: 'visitor.contact', id: ids.bob, contact: 'bob-private-phone-0770', actor: 'pamela' }, 'gate');
    const st = await callJsonLine<{ visitors: { username: string }[] }>(sock, { op: 'state' }, 'gate');
    assert.ok(st.visitors.some((v) => v.username === 'erin'));
    await new Promise<void>((r) => server.close(() => r()));
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((l) => !l.includes('erin-secret-password')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes(tokenOf(link.url)) && !l.includes('bob-private-phone')), 'no link tokens or contact details in the log');
    const row = (await one<{ password_hash: string }>(db, "SELECT password_hash FROM visitors WHERE username = 'erin'"))!;
    assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  });
});

// ------------------------------------------------------------------ however deep
// A protected folder protects everything inside it: every file and folder at any
// depth, wherever the protected folder itself sits, by any address.
describe('everything inside a protected folder is protected, however deep', () => {
  const olivia = 'family/2026/summer/olivia';
  const deepDir = Array.from({ length: 30 }, (_, i) => `d${i + 1}`).join('/');
  const deep = `${olivia}/${deepDir}`;
  let olive = '';
  let outsider = '';     // allowed into another folder only

  before(async () => {
    file(`${olivia}/index.html`); file(`${olivia}/login.html`); file(`${olivia}/login-files/style.css`);
    file(`${deep}/photo.jpg`); file(`${deep}/index.html`);
    file(`${olivia}/d1/about.html`); file(`${olivia}/d1/d2/notes.txt`);
    // sign-in page names and login-files further down are ordinary private files, not sign-in pages
    file(`${olivia}/d1/login.html`); file(`${olivia}/d1/d2/logout.html`); file(`${olivia}/d1/login-forgot.html`);
    file(`${olivia}/d1/login-files/style.css`); file(`${deep}/login-files/x.css`);
    file('family/2026/summer/other/index.html');
    symlinkSync(join(pub, olivia, 'd1', 'd2'), join(pub, 'shortcut-into-olivia'));
    await protect('O', olivia);
    const v = await admin({ op: 'visitor.create', username: 'olive', name: 'Olive', password: 'olive-password-123' });
    await admin({ op: 'grant', visitorId: v.id, areaId: ids.O, allow: true });
    olive = (await login({ username: 'olive', password: 'olive-password-123', page: `/${olivia}/login.html` })).cookie!;
    const w = await admin({ op: 'visitor.create', username: 'walt', name: 'Walt', password: 'walt-password-123' });
    await admin({ op: 'grant', visitorId: w.id, areaId: ids.C, allow: true });
    outsider = (await login({ username: 'walt', password: 'walt-password-123', area: tokens.C })).cookie!;
  });

  const paths = [
    `/${olivia}`, `/${olivia}/`, `/${olivia}/d1/`, `/${olivia}/d1`, `/${olivia}/d1/about.html`, `/${olivia}/d1/d2/notes.txt`,
    `/${deep}/`, `/${deep}/photo.jpg`, `/${deep}/index.html`, `/${deep}/missing.jpg`, `/${deep}/missing-folder/a/b/c.html`,
    `/${olivia}/d1/login.html`, `/${olivia}/d1/d2/logout.html`, `/${olivia}/d1/login-forgot.html`,
    `/${olivia}/d1/login-files/style.css`, `/${deep}/login-files/x.css`,
  ];

  it('sends every one of them to the folder sign-in page when no one is signed in', async () => {
    for (const u of paths) {
      const r = await check(u);
      assert.equal(r.status, 401, u);
      assert.ok(r.login!.startsWith(`/${olivia}/login.html?next=`), `${u} -> ${r.login}`);
      assert.equal(r.cache, 'private, no-store', u);
    }
  });

  it('only its own sign-in page and login-files look files open before signing in', async () => {
    for (const u of [`/${olivia}/login.html`, `/${olivia}/login-files/style.css`]) {
      const r = await check(u);
      assert.equal(r.status, 204, u);
      assert.equal(r.cache, 'private, no-store', u);
    }
  });

  it('is the same on a subdomain address and through a shortcut', async () => {
    const onSub = `/2026/summer/olivia/${deepDir}/photo.jpg`;
    const r = await check(onSub, { host: 'family.pammy.org', base: '/family' });
    assert.equal(r.status, 401);
    assert.ok(r.login!.startsWith('/2026/summer/olivia/login.html?next='), r.login);
    for (const u of ['/shortcut-into-olivia/', '/shortcut-into-olivia/notes.txt', `/shortcut-into-olivia/${deepDir.split('/').slice(2).join('/')}/photo.jpg`]) {
      assert.equal((await check(u)).status, 401, u);
    }
  });

  it('opens all of it to someone allowed in, still private', async () => {
    for (const u of [`/${deep}/photo.jpg`, `/${olivia}/d1/login.html`, `/${olivia}/d1/d2/notes.txt`, '/shortcut-into-olivia/notes.txt']) {
      const r = await check(u, { cookie: olive });
      assert.equal(r.status, 204, u);
      assert.equal(r.cache, 'private, no-store', u);
      // who it is, for a PHP page in there (docs/tutorials-plan.md P4)
      assert.match(r.user ?? '', /^[a-z0-9._-]+$/, u);
    }
    // and nobody, for a page anyone can open
    assert.equal((await check('/open/index.html', { cookie: olive })).user, undefined);
  });

  it('keeps it closed to someone signed in who is not allowed in', async () => {
    const r = await check(`/${deep}/photo.jpg`, { cookie: outsider });
    assert.equal(r.status, 401);
    assert.match(r.login!, /denied=1/);
  });

  it('stays protected with the protection file deleted, or with a folder above it renamed', async () => {
    const marker = join(pub, olivia, '.pammy-protected');
    const text = readFileSync(marker, 'utf8');
    rmSync(marker);
    assert.equal((await check(`/${deep}/photo.jpg`)).status, 401, 'database path alone');
    writeFileSync(marker, text);
    renameSync(join(pub, 'family'), join(pub, 'family-renamed'));
    try {
      assert.equal((await check(`/family-renamed/2026/summer/olivia/${deepDir}/photo.jpg`)).status, 401, 'marker alone');
    } finally {
      renameSync(join(pub, 'family-renamed'), join(pub, 'family'));
    }
  });

  it("doesn't reach folders next to it", async () => {
    const r = await check('/family/2026/summer/other/');
    assert.equal(r.status, 204);
    assert.equal(r.cache, undefined);
  });
});

describe('forms that belong to one folder (media-plan D22-D24)', () => {
  const get = (name: string, page: string, opts: { host?: string; base?: string } = {}) =>
    app.inject({ method: 'GET', url: `/_pammy/forms/${name}?page=${encodeURIComponent(page)}`, headers: { host: opts.host ?? 'pammy.org', 'x-pammy-base': opts.base ?? '/' } });
  const send = (name: string, page: string) => app.inject({
    method: 'POST', url: `/_pammy/forms/${name}`, remoteAddress: '127.0.0.1',
    headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': '192.0.2.201' },
    payload: JSON.stringify({ page, answers: { message: 'hello' } }),
  });
  const refused = async (req: Record<string, unknown>) => { try { await admin(req); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
  let olivia = 0;
  let everywhere = 0;

  before(async () => {
    file('olivia/contact.html'); file('olivia/media/images/o.jpg'); file('elsewhere/contact.html'); file('elsewhere/media/images/e.jpg');
    olivia = (await admin({ op: 'form.create', name: 'olivias-own', items: [{ type: 'long-text', label: 'Message' }], formScope: '/olivia', actor: 'pamela' })).id;
    everywhere = (await admin({ op: 'form.create', name: 'for-everywhere', items: [{ type: 'long-text', label: 'Message' }], actor: 'pamela' })).id;
  });

  it('a folder\'s form works only on that folder\'s pages, at either address', async () => {
    assert.equal((await admin({ op: 'form.get', id: olivia })).scope, '/olivia');
    assert.equal((await admin({ op: 'form.get', id: everywhere })).scope, '/', 'every other form works everywhere, as before');
    assert.equal((await get('olivias-own', '/olivia/contact.html')).statusCode, 200);
    assert.equal((await get('olivias-own', '/contact.html', { host: 'olivia.pammy.org', base: '/olivia' })).statusCode, 200);
    assert.equal((await get('olivias-own', '/elsewhere/contact.html')).statusCode, 404);
    assert.equal((await get('olivias-own', '')).statusCode, 404, 'not without a page');
    assert.equal((await send('olivias-own', '/elsewhere/contact.html')).statusCode, 404);
    assert.equal((await send('olivias-own', '/olivia/contact.html')).statusCode, 200);
    assert.equal((await get('for-everywhere', '/elsewhere/contact.html')).statusCode, 200);
  });

  // docs/phase8-plan.md 8-5 (P8-10): on a site with routes, a page is placed by the route it
  // is on -- a folder's form works on the host that shows the folder, whatever its address; a
  // service's page has no folder, so only a form that works anywhere is used there
  it('with routes: placed by the route, and a service page takes only an anywhere form', async () => {
    const { SiteRoutes } = await import('@panel/core/gate/site-routes');
    const routesFile = join(root, 'gate-routes-forms.json');
    writeFileSync(routesFile, JSON.stringify({ v: 1, domains: ['pammy.org'], hosts: {
      'o.pammy.org': [{ path: '/', kind: 'folder', folder: 'olivia', area: null }],
      'mixed.pammy.org': [{ path: '/', kind: 'service', service: 'shop', area: null }, { path: '/docs/', kind: 'folder', folder: 'elsewhere', area: null }],
    } }));
    const routed = new GateLive(live.db, { sessions: visitorSessions, now: () => clock, routes: new SiteRoutes(routesFile) });
    routed.markReady();
    await routed.reloadAreas();
    const r = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(root, 'none.db'), mediaThumbs: join(root, 'thumbs') }, routed);
    const rget = (name: string, host: string, page: string) =>
      r.inject({ method: 'GET', url: `/_pammy/forms/${name}?page=${encodeURIComponent(page)}`, headers: { host, 'x-pammy-base': '/' } });
    try {
      assert.equal((await rget('olivias-own', 'o.pammy.org', '/contact.html')).statusCode, 200, 'the host that shows olivia (the base header says /)');
      assert.equal((await rget('olivias-own', 'mixed.pammy.org', '/docs/contact.html')).statusCode, 404, "another folder's page");
      assert.equal((await rget('for-everywhere', 'mixed.pammy.org', '/docs/contact.html')).statusCode, 200, 'a folder page, under /docs/');
      assert.equal((await rget('for-everywhere', 'mixed.pammy.org', '/checkout')).statusCode, 200, "a service's page: an anywhere form");
      assert.equal((await rget('olivias-own', 'mixed.pammy.org', '/checkout')).statusCode, 404, "...but not a folder's form");
      assert.equal((await rget('olivias-own', 'nowhere.pammy.org', '/contact.html')).statusCode, 404, 'a host with no routes');
    } finally { await r.close(); }
  });

  it('its pictures come from its own folder; moving it elsewhere checks them again', async () => {
    const f = await admin({ op: 'form.get', id: olivia });
    await assert.rejects(admin({ op: 'form.save', id: olivia, version: f.version, items: [...f.items, { type: 'image', src: 'elsewhere/media/images/e.jpg', alt: 'E' }] }), /isn't in olivia\//);
    const saved = await admin({ op: 'form.save', id: olivia, version: f.version, items: [...f.items, { type: 'image', src: 'olivia/media/images/o.jpg', alt: 'O' }] });
    await assert.rejects(admin({ op: 'form.scope', id: olivia, formScope: '/elsewhere' }), /isn't in elsewhere\//, 'its picture is in olivia/');
    assert.equal((await admin({ op: 'form.scope', id: olivia, formScope: '/' })).scope, '/');
    assert.equal((await admin({ op: 'form.scope', id: olivia, formScope: '/olivia' })).scope, '/olivia');
    assert.equal(await refused({ op: 'form.scope', id: olivia, formScope: '/a/b' }), 'invalid');
    assert.equal(saved.scope, '/olivia');
    const fixture = (await admin({ op: 'forms.state' })).forms.find((x: { fixture: string | null }) => x.fixture);
    assert.equal(await refused({ op: 'form.scope', id: fixture.id, formScope: '/olivia' }), 'invalid', 'the examples work everywhere');
  });

  it('asked on behalf of an account limited to olivia: only olivia\'s forms and responses, nothing else at all', async () => {
    const lim = { places: ['/olivia'] };
    const st = await admin({ op: 'forms.state', ...lim });
    assert.deepEqual(st.forms.map((f: { name: string }) => f.name), ['olivias-own']);
    assert.equal(st.unread, 1);
    assert.equal(await refused({ op: 'form.get', id: everywhere, ...lim }), 'not-found');
    assert.equal(await refused({ op: 'form.trash', id: everywhere, ...lim }), 'not-found');
    assert.equal(await refused({ op: 'form.create', name: 'olivias-second', formScope: '/', actor: 'badmon', ...lim }), 'not-found', 'its new forms are its folder\'s');
    assert.equal(await refused({ op: 'form.create', name: 'olivias-second', formScope: '/elsewhere', actor: 'badmon', ...lim }), 'not-found');
    const made = await admin({ op: 'form.create', name: 'olivias-second', formScope: '/olivia', actor: 'badmon', ...lim });
    assert.equal(made.scope, '/olivia');
    await send('for-everywhere', '/elsewhere/contact.html');
    const mine = await admin({ op: 'responses.list', ...lim });
    assert.ok(mine.responses.length >= 1 && mine.responses.every((r: { formName: string }) => r.formName.startsWith('olivias')));
    const other = (await admin({ op: 'responses.list', formId: everywhere })).responses[0];
    for (const op of ['response.read', 'response.approve', 'response.trash']) assert.equal(await refused({ op, id: other.id, read: true, approved: true, ...lim }), 'not-found', op);
    assert.equal(await refused({ op: 'responses.list', formId: everywhere, ...lim }), 'not-found');
    assert.equal((await admin({ op: 'responses.read-all', ...lim })).marked, mine.responses.filter((r: { readAt: number | null }) => !r.readAt).length);
    assert.equal((await admin({ op: 'forms.state' })).forms.find((f: { name: string }) => f.name === 'for-everywhere').unread, 1, 'the others\' responses untouched');
    for (const op of ['state', 'area.create', 'visitor.create', 'apikeys.list', 'examples.state', 'form.scope', 'housekeeping']) {
      assert.equal(await refused({ op, path: 'olivia', ...lim }), 'not-found', op);
    }
  });

  it('asked on behalf of a person kept to two places: the forms of both, and still nothing else (permissions-plan R5)', async () => {
    const two = { places: ['/olivia', '/elsewhere'] };
    const both = await admin({ op: 'form.create', name: 'elsewheres-own', formScope: '/elsewhere', actor: 'badmon', ...two });
    assert.equal(both.scope, '/elsewhere');
    const names = (await admin({ op: 'forms.state', ...two })).forms.map((f: { name: string }) => f.name);
    assert.deepEqual(names, ['elsewheres-own', 'olivias-own', 'olivias-second']);
    assert.equal(await refused({ op: 'form.get', id: everywhere, ...two }), 'not-found', 'a form for every page is in neither place');
    assert.equal((await admin({ op: 'form.get', id: both.id, ...two })).name, 'elsewheres-own');
    assert.equal(await refused({ op: 'form.get', id: both.id, places: ['/olivia'] }), 'not-found', 'and not for someone kept to olivia alone');
    // a place is a folder, never the whole site, and a list that says nothing is refused, not read as "everything"
    for (const places of [['/'], [], '/olivia', ['olivia'], ['/a/b']]) {
      assert.equal(await refused({ op: 'forms.state', places }), 'invalid', JSON.stringify(places));
    }
    // the one folder sent before places is refused, never ignored (read as "everything")
    for (const scope of ['/olivia', null, '']) assert.equal(await refused({ op: 'forms.state', scope }), 'invalid', JSON.stringify(scope));
    assert.equal(await refused({ op: 'state', scope: '/olivia' }), 'invalid');
  });
});

describe('the media API (media-api-plan M1-M11)', () => {
  let mdb: Sql;               // the panel's side of the same database: the media records
  const pubDir = () => join(root, 'media-public');
  const idOf = async (path: string) => (await one<{ id: number }>(mdb, 'SELECT id FROM records WHERE path = ?', path))!.id;
  const get = (url: string, opts: { host?: string; base?: string; cookie?: string; key?: string } = {}) => app.inject({
    method: 'GET', url, remoteAddress: '127.0.0.1',
    headers: { host: opts.host ?? 'pammy.org', 'x-pammy-base': opts.base ?? '/', 'x-real-ip': '192.0.2.77',
      ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
  });
  const names = async (url: string, opts = {}) => {
    const r = await get(url, opts);
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    return (r.json().files as { name: string }[]).map((f) => f.name);
  };
  const label = async (type: 'tag' | 'category', scope: string, name: string) =>
    (await one<{ id: number }>(mdb, 'SELECT l.id FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.path = ? AND l.kind = ? AND l.name = ?', scope, type, name))!.id;

  before(async () => {
    const { recordAdded } = await import('@panel/files/media-db');
    const { changeFileLabels, labelIn, setLabelPublic } = await import('@panel/catalog/labels');
    const { ensureScope } = await import('@panel/catalog/scopes');
    const { publishIndex } = await import('@panel/media/media-public');
    mdb = pg.connect('panel', database, 4);
    let t = 100;
    for (const scope of ['/', '/shop', '/members']) await ensureScope(mdb, scope, 1, { automatic: true });
    for (const [type, scope, name] of [['tag', '/shop', 'summer'], ['tag', '/shop', 'hats'], ['tag', '/shop', 'private-tag'], ['category', '/shop', 'travel'], ['tag', '/', 'summer'], ['tag', '/members', 'summer']] as const) {
      await labelIn(mdb, type, scope, name, 1, null, []);
    }
    const add = async (path: string, tags: string[], categories: string[]) => {
      file(path);
      const id = await recordAdded(mdb, t++, { path, size: 10, modifiedAt: 1, hash: 'a'.repeat(64), how: 'uploaded', by: 'pamela' });
      await changeFileLabels(mdb, t, 'pamela', [id], { add: { tags, categories } });
      return id;
    };
    await add('shop/media/images/red.jpg', ['summer', 'hats'], ['travel']);
    await add('shop/media/images/blue.jpg', ['summer'], []);
    await add('shop/media/images/secret.jpg', ['summer', 'private-tag'], []);
    await add('shop/media/files/menu.pdf', [], ['travel']);
    await add('media/images/logo.png', ['summer'], []);
    await add('members/media/images/m.jpg', ['summer'], []);
    for (const [type, scope, name] of [['tag', '/shop', 'summer'], ['tag', '/shop', 'hats'], ['category', '/shop', 'travel'], ['tag', '/', 'summer'], ['tag', '/members', 'summer']] as const) {
      await setLabelPublic(mdb, type, await label(type, scope, name), true);
    }
    const { setDetails } = await import('@panel/files/media-db');
    await setDetails(mdb, 1, await idOf('shop/media/images/red.jpg'), { title: 'Red hat', alt: 'A red hat on a chair' });
    // two thumbnails: one open, one in the protected members folder
    mkdirSync(join(pubDir(), 'thumbs'), { recursive: true });
    for (const p of ['shop/media/images/red.jpg', 'members/media/images/m.jpg']) {
      const id = await idOf(p);
      await run(mdb, "INSERT INTO thumbs (item_id, hash, result, icon, width, height, made_at) VALUES (?, ?, 'picture', 'image', 320, 213, 1)", id, 'a'.repeat(64));
      writeFileSync(join(pubDir(), 'thumbs', `${id}-${'a'.repeat(64)}.webp`), 'RIFF....WEBP');
    }
    await publishIndex(mdb, pubDir(), clock);
  });
  after(async () => { await mdb?.end({ timeout: 2 }); });

  it('a tag, a category, or both at once, only ever in the media folder asked for', async () => {
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer'), ['secret.jpg', 'blue.jpg', 'red.jpg'], 'newest first');
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer/c/travel'), ['red.jpg'], 'both: a file must have both');
    assert.deepEqual(await names('/_pammy/api/media/in/shop/c/travel?kind=files'), ['menu.pdf']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer?order=name'), ['blue.jpg', 'red.jpg', 'secret.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/main/t/summer'), ['logo.png'], 'the main site\'s summer is another tag');
    const one = (await get('/_pammy/api/media/in/shop/t/summer/c/travel')).json();
    const red = one.files[0];
    assert.deepEqual([red.title, red.alt, red.kind, red.tags, red.categories], ['Red hat', 'A red hat on a chair', 'images', ['hats', 'summer'], ['travel']]);
    assert.deepEqual([red.src, red.url, red.subdomainUrl], ['/shop/media/images/red.jpg', 'https://pammy.org/shop/media/images/red.jpg', 'https://shop.pammy.org/media/images/red.jpg']);
    assert.match(red.thumb.src, /^\/_pammy\/media-thumbs\/\d+-a{12}\.webp$/);
    const onSub = (await get('/_pammy/api/media/in/shop/t/summer/c/travel', { host: 'shop.pammy.org', base: '/shop' })).json();
    assert.equal(onSub.files[0].src, '/media/images/red.jpg', 'its address from a page on that subdomain');
    assert.deepEqual([one.folder, one.filter, one.total, one.next], ['shop', { tags: ['summer'], categories: ['travel'] }, 1, null]);
    const paged = (await get('/_pammy/api/media/in/shop/t/summer?limit=2')).json();
    assert.deepEqual([paged.files.length, paged.total, paged.next], [2, 3, 2]);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer?limit=2&offset=2'), ['red.jpg']);
  });

  it('several tags and categories at once, in the path or as ?tags= and ?categories=', async () => {
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer/t/hats'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop?tags=summer,hats'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop?tag=summer&tag=hats'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer?tags=hats'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop?tags=summer&categories=travel'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/hats/c/travel'), ['red.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop?tags=hats'), ['red.jpg']);
    const both = (await get('/_pammy/api/media/in/shop?tags=summer,hats&categories=travel')).json();
    assert.deepEqual(both.filter, { tags: ['summer', 'hats'], categories: ['travel'] });
    assert.equal((await get('/_pammy/api/media/in/shop?tags=Summer')).statusCode, 400);
    assert.equal((await get('/_pammy/api/media/in/shop/all?tags=summer')).statusCode, 400);
  });

  it('without a key: only public labels, which look exactly like missing ones otherwise', async () => {
    const priv = await get('/_pammy/api/media/in/shop/t/private-tag');
    const none = await get('/_pammy/api/media/in/shop/t/no-such-tag');
    assert.deepEqual([priv.statusCode, none.statusCode, priv.json().error], [404, 404, 'no-label']);
    assert.equal(priv.json().message.replace('private-tag', 'X'), none.json().message.replace('no-such-tag', 'X'));
    const secret = (await get('/_pammy/api/media/in/shop/t/summer')).json().files.find((f: { name: string }) => f.name === 'secret.jpg');
    assert.deepEqual(secret.tags, ['summer'], 'its private tag is left out');
    assert.equal((await get('/_pammy/api/media/in/shop/all')).statusCode, 401);
    const labels = (await get('/_pammy/api/media/in/shop/labels')).json();
    assert.deepEqual([labels.tags, labels.categories], [[{ name: 'hats', files: 1 }, { name: 'summer', files: 3 }], [{ name: 'travel', files: 2 }]]);
    for (const [url, status] of [['/_pammy/api/media/in/shop', 400], ['/_pammy/api/media/in/shop/t', 400], ['/_pammy/api/media/in/shop/x/summer', 400],
      ['/_pammy/api/media/in/shop/t/Summer', 400], ['/_pammy/api/media/shop/t/summer', 404], ['/_pammy/api/media/in/shop/t/summer?kind=pictures', 400],
      ['/_pammy/api/media/in/shop/t/summer?limit=500', 400], ['/_pammy/api/media/in/shop/t/summer?key=pammy_x', 400], ['/_pammy/api/media/in/nowhere/t/summer', 404]] as const) {
      assert.equal((await get(url)).statusCode, status, url);
    }
    const r = await get('/_pammy/api/media/in/shop/t/summer');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal((await app.inject({ method: 'GET', url: '/_pammy/api/media/in/shop/t/summer', headers: { host: 'pammy.org', 'x-pammy-base': '/', 'if-none-match': String(r.headers.etag) } })).statusCode, 304);
  });

  it('a protected folder\'s files, and their small pictures, only for someone signed in to it', async () => {
    mark('members', tokens.C!);
    assert.deepEqual(await names('/_pammy/api/media/in/members/t/summer'), []);
    const m = await admin({ op: 'visitor.create', username: 'mediafan', name: 'Media Fan', password: 'media-fan-password' });
    await admin({ op: 'grant', visitorId: m.id, areaId: ids.C, allow: true });
    const cookie = (await login({ username: 'mediafan', password: 'media-fan-password', area: tokens.C })).cookie!;
    assert.deepEqual(await names('/_pammy/api/media/in/members/t/summer', { cookie }), ['m.jpg']);
    const thumb = `/_pammy/media-thumbs/${(await idOf('members/media/images/m.jpg'))}-${'a'.repeat(12)}.webp`;
    assert.equal((await get(thumb)).statusCode, 404);
    assert.equal((await get(thumb, { cookie })).statusCode, 200);
    const open = await get(`/_pammy/media-thumbs/${(await idOf('shop/media/images/red.jpg'))}-${'a'.repeat(12)}.webp`);
    assert.deepEqual([open.statusCode, open.headers['content-type'], open.headers['cache-control']], [200, 'image/webp', 'private, max-age=86400']);
    assert.equal((await get(`/_pammy/media-thumbs/${(await idOf('shop/media/images/red.jpg'))}-${'b'.repeat(12)}.webp`)).statusCode, 404, 'the wrong hash');
    assert.equal((await get(`/_pammy/media-thumbs/${(await idOf('shop/media/images/blue.jpg'))}-${'a'.repeat(12)}.webp`)).statusCode, 404, 'no thumbnail');
  });

  it('keys: only the media folders they were given, any label, every file, private labels shown', async () => {
    const shopKey = (await admin({ op: 'apikey.create', label: 'shop program', level: 'approved', forms: 'none', media: ['/shop'] })).key;
    const allKey = (await admin({ op: 'apikey.create', label: 'everything', level: 'approved', forms: 'none', media: 'all' })).key;
    await assert.rejects(admin({ op: 'apikey.create', label: 'nothing', level: 'approved', forms: 'none' }), /able to read something/);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/all?order=name', { key: shopKey }), ['blue.jpg', 'menu.pdf', 'red.jpg', 'secret.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/private-tag', { key: shopKey }), ['secret.jpg']);
    const labels = (await get('/_pammy/api/media/in/shop/labels', { key: shopKey })).json();
    assert.deepEqual(labels.tags.map((t: { name: string; public: boolean }) => `${t.name}:${t.public}`), ['hats:true', 'private-tag:false', 'summer:true']);
    assert.equal((await get('/_pammy/api/media/in/members/t/summer', { key: shopKey })).statusCode, 403);
    assert.equal((await get('/_pammy/api/media/main/t/summer', { key: shopKey })).statusCode, 403);
    assert.deepEqual(await names('/_pammy/api/media/in/members/t/summer', { key: allKey }), ['m.jpg'], 'a key is not held back by a protected folder');
    assert.equal((await get('/_pammy/api/media/in/shop/t/summer', { key: shopKey })).headers['cache-control'], 'private, no-store');
    assert.equal((await get('/_pammy/api/media/in/shop/t/summer', { key: 'pammy_' + 'x'.repeat(43) })).statusCode, 401);
    assert.equal((await get('/_pammy/api/forms/1/approved', { key: shopKey })).statusCode, 403, 'a media-only key reads no forms');
  });

  it('a new index from the panel is picked up at once', async () => {
    const { setLabelPublic } = await import('@panel/catalog/labels');
    const { publishIndex } = await import('@panel/media/media-public');
    await setLabelPublic(mdb, 'tag', await label('tag', '/shop', 'private-tag'), true);
    await publishIndex(mdb, pubDir(), clock);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/private-tag'), ['secret.jpg']);
  });

  it('a tag scope inside the folder: its labels answer to the same name, public ones only without a key', async () => {
    const { recordAdded } = await import('@panel/files/media-db');
    const { changeFileLabels, labelIn, setLabelPublic } = await import('@panel/catalog/labels');
    const { ensureScope } = await import('@panel/catalog/scopes');
    const { publishIndex } = await import('@panel/media/media-public');
    await ensureScope(mdb, '/shop/media/images/beach', 1, { automatic: false });
    for (const name of ['summer', 'sand']) await labelIn(mdb, 'tag', '/shop/media/images/beach', name, 1, null, []);
    file('shop/media/images/beach/dune.jpg');
    const id = await recordAdded(mdb, 900, { path: 'shop/media/images/beach/dune.jpg', size: 10, modifiedAt: 1, hash: 'a'.repeat(64), how: 'uploaded', by: 'pamela' });
    await changeFileLabels(mdb, 901, 'pamela', [id], { add: { tags: ['summer', 'sand'] } });
    assert.deepEqual((await all<{ scope: string }>(mdb, "SELECT s.path AS scope FROM links x JOIN labels t ON t.id = x.label_id JOIN scopes s ON s.id = t.scope_id WHERE x.item_id = ? AND t.kind = 'tag' ORDER BY t.name", id)).map((r) => r.scope),
      ['/shop/media/images/beach', '/shop/media/images/beach'], 'the deepest scope\'s labels');
    await publishIndex(mdb, pubDir(), clock);
    assert.ok(!(await names('/_pammy/api/media/in/shop/t/summer')).includes('dune.jpg'), 'the beach summer is not switched on yet');
    assert.equal((await get('/_pammy/api/media/in/shop/t/sand')).statusCode, 404);
    await setLabelPublic(mdb, 'tag', await label('tag', '/shop/media/images/beach', 'summer'), true);
    await setLabelPublic(mdb, 'tag', await label('tag', '/shop/media/images/beach', 'sand'), true);
    await publishIndex(mdb, pubDir(), clock);
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/summer?order=name'), ['blue.jpg', 'dune.jpg', 'red.jpg', 'secret.jpg'], 'both summers, one name');
    assert.deepEqual(await names('/_pammy/api/media/in/shop/t/sand/t/summer'), ['dune.jpg']);
    assert.deepEqual(await names('/_pammy/api/media/main/t/summer'), ['logo.png'], 'never another folder\'s');
    const labels = (await get('/_pammy/api/media/in/shop/labels')).json();
    assert.deepEqual(labels.tags.filter((t: { name: string }) => t.name === 'summer'), [{ name: 'summer', files: 4 }], 'listed once');
  });

  it('the built-in example folder and the four example pages', async () => {
    const land = (await get('/_pammy/api/media/example/c/landscapes?kind=images')).json();
    assert.equal(land.folder, 'example');
    assert.ok(land.files.length >= 4);
    assert.ok(land.files.every((f: { src: string; thumb: { src: string }; alt: string }) => f.src.startsWith('/_pammy/examples/media-demo/') && f.thumb.src.startsWith('/_pammy/examples/media-demo/thumbs/') && f.alt));
    assert.ok((await names('/_pammy/api/media/example/c/music?kind=audio')).length >= 3);
    const pic = await get(land.files[0].src);
    assert.deepEqual([pic.statusCode, pic.headers['content-type']], [200, 'image/jpeg']);
    for (const kind of ['gallery', 'slideshow', 'documents', 'music']) {
      const page = await get(`/_pammy/examples/${kind}/`);
      assert.equal(page.statusCode, 200, kind);
      assert.match(page.body, /data-api="\/_pammy\/api\/media\/example\//, kind);
      assert.match(String(page.headers['content-security-policy']), /media-src 'self'/);
      assert.equal((await get(`/_pammy/examples/${kind}/${kind}.js`)).statusCode, 200);
      assert.equal((await get(`/_pammy/examples/${kind}`)).statusCode, 301);
    }
  });

  it('the two database example pages, pointed at the example databases (docs/db-examples-plan.md)', async () => {
    for (const [kind, api] of [['recipes', '/_pammy/api/data/postgres/example_recipes'], ['blog', '/_pammy/api/data/mariadb/example_blog']]) {
      const page = await get(`/_pammy/examples/${kind}/`);
      assert.equal(page.statusCode, 200, kind);
      assert.ok(page.body.includes(`data-api="${api}"`), kind);
      assert.ok(!page.body.includes('@'), 'every blank filled in');
      assert.match(String(page.headers['x-robots-tag']), /noindex/);
      assert.equal((await get(`/_pammy/examples/${kind}/${kind}.js`)).statusCode, 200);
      assert.equal((await get(`/_pammy/examples/${kind}/style.css`)).statusCode, 200);
      assert.equal((await get(`/_pammy/examples/${kind}`)).statusCode, 301);
    }
    const pic = await get('/_pammy/examples/recipes/pictures/pancakes.jpg');
    assert.deepEqual([pic.statusCode, pic.headers['content-type']], [200, 'image/jpeg']);
    assert.equal((await get('/_pammy/examples/recipes/pictures/CREDITS.txt')).statusCode, 404, 'only the pictures');
  });

  // docs/phase8-plan.md 8-2 (P8-4): on a site with hosts, a folder shown by a route that
  // only people let in may open is private to the media API too -- the hole 8-2 closes
  it("a folder behind a private route: its files aren't listed, and its thumbnails aren't handed out", async () => {
    const { SiteRoutes } = await import('@panel/core/gate/site-routes');
    const made = await admin({ op: 'route-area.set', routeId: 9001, accounts: 'private', address: 'shop.pammy.org/' });
    const routesFile = join(root, 'gate-routes.json');
    const write = (area: string | null) => writeFileSync(routesFile, JSON.stringify({ v: 1, domains: ['pammy.org'], hosts: {
      'shop.pammy.org': [{ path: '/', kind: 'folder', folder: 'shop', area }],
      'pammy.org': [{ path: '/', kind: 'folder', folder: 'home', area: null }],
    } }));
    write(made.token);
    const routed = new GateLive(live.db, { sessions: visitorSessions, now: () => clock, routes: new SiteRoutes(routesFile) });
    routed.markReady();
    await routed.reloadAreas();
    const routedApp = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(pubDir(), 'index.db'), mediaThumbs: join(pubDir(), 'thumbs') }, routed);
    const rget = (url: string) => routedApp.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers: { host: 'pammy.org', 'x-pammy-base': '/', 'x-real-ip': '192.0.2.78' } });
    try {
      const before = await names('/_pammy/api/media/in/shop/t/summer');
      assert.ok(before.includes('red.jpg'), 'without routes: as before');
      const listed = await rget('/_pammy/api/media/in/shop/t/summer');
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json().files, [], 'nobody signed in sees none of it');
      const thumb = `${await idOf('shop/media/images/red.jpg')}-${'a'.repeat(12)}.webp`;
      assert.equal((await get(`/_pammy/media-thumbs/${thumb}`)).statusCode, 200);
      assert.equal((await rget(`/_pammy/media-thumbs/${thumb}`)).statusCode, 404);
      // a site with hosts has no main site's media folder (docs/phase8-plan.md P8-5)
      const main = await rget('/_pammy/api/media/main/t/summer');
      assert.deepEqual([main.statusCode, main.json().error], [404, 'bad-address']);
      // a route's token the gate has no area for locks it too; with no accounts, open again
      write('Z'.repeat(32));
      assert.deepEqual((await rget('/_pammy/api/media/in/shop/t/summer')).json().files, []);
      write(null);
      assert.deepEqual((await rget('/_pammy/api/media/in/shop/t/summer')).json().files.map((f: { name: string }) => f.name), before);
      // a file's addresses through the routes (8-3): relative on a host that shows its folder,
      // else the first host that does
      const red = (r: { json: () => { files: { name: string; src: string; url: string; subdomainUrl: string | null }[] } }) => r.json().files.find((f) => f.name === 'red.jpg')!;
      assert.deepEqual(red(await rget('/_pammy/api/media/in/shop/t/summer')), { ...red(await rget('/_pammy/api/media/in/shop/t/summer')),
        src: 'https://shop.pammy.org/media/images/red.jpg', url: 'https://shop.pammy.org/media/images/red.jpg', subdomainUrl: null });
      const onShop = await routedApp.inject({ method: 'GET', url: '/_pammy/api/media/in/shop/t/summer', remoteAddress: '127.0.0.1', headers: { host: 'shop.pammy.org', 'x-pammy-base': '/shop' } });
      assert.equal(red(onShop).src, '/media/images/red.jpg');
    } finally {
      await routedApp.close();
      await admin({ op: 'route-area.set', routeId: 9001, accounts: null });
      await live.changed();
    }
  });
});

// ------------------------------------------------------------------ the data API
// The one part of the studio anything on the internet can reach (slice 9). The
// engines are stood in for by a real helper socket over in-memory drivers, so
// what is exercised here is the gate's own decisions: the switches, the keys,
// and that the catalog -- not the key -- has the last word.
describe('her records, for programs', () => {
  let dataApp: Awaited<ReturnType<typeof buildGateApp>>;
  let sock = '';
  let helper: Server;
  let readKey = '';
  let writeKey = '';
  const DB = 41;

  const rows = memoryRows({
    blog: { posts: [
      { id: 1, title: 'Hello', secret: 'not for programs' },
      { id: 2, title: 'Second post', secret: 'nor this' },
    ] },
    // a to-do list for people signed in to a folder (docs/tutorials-plan.md V1-V6)
    todo: {
      lists: [{ id: 1, name: 'Shopping', owner: 'alice', published: false }, { id: 2, name: 'Bob stuff', owner: 'bob', published: true }],
      tasks: [
        { id: 1, title: 'Milk', done: false, owner: 'alice', list_id: 1 },
        { id: 2, title: 'Bob thing', done: false, owner: 'bob', list_id: 2 },
      ],
    },
    // a recipe book with connections, for anyone-can-read and { id, label }
    kitchen: {
      cooks: [{ id: 1, name: 'Olivia', phone: '07700 900123' }, { id: 2, name: 'Sam', phone: '07700 900456' }],
      recipes: [
        { id: 1, title: 'Pancakes', cook_id: 1, shared: true },
        { id: 2, title: 'Secret stew', cook_id: 2, shared: false },
        { id: 3, title: 'Toast', cook_id: null, shared: true },
      ],
      tags: [{ id: 1, name: 'quick' }, { id: 2, name: 'breakfast' }, { id: 3, name: 'family' }],
      recipe_tags: [
        { recipe_id: 1, tag_id: 2 }, { recipe_id: 1, tag_id: 1 }, { recipe_id: 3, tag_id: 1 }, { recipe_id: 2, tag_id: 3 },
      ],
    },
  });
  const schemas = memorySchemas('postgres', {});
  const driver = (): Driver => ({
    engine: 'postgres',
    state: async () => ({ engine: 'postgres', ok: true, version: null, message: null }),
    list: async () => [],
    create: async () => { throw new Error('not used'); },
    drop: async () => {},
    size: async () => ({ bytes: 0, tables: 0 }),
    listUsers: async () => [], createUser: async () => { throw new Error('not used'); },
    dropUser: async () => {}, setPassword: async () => {},
    accessOf: async () => [], grant: async () => {}, revoke: async () => {},
    introspect: (database) => schemas.introspect('postgres', database),
    apply: (database, steps) => schemas.apply('postgres', database, steps),
    listRows: (database, q) => rows.list(database, q),
    getRow: (database, table, columns, where) => rows.get(database, table, columns, where),
    insertRow: (database, table, values, back) => rows.insert(database, table, values, back),
    updateRow: (database, table, values, where, back) => rows.update(database, table, values, where, back),
    deleteRow: (database, table, where) => rows.remove(database, table, where),
    setLinks: (database, table, here, id, there, ids) => rows.setLinks(database, table, here, id, there, ids),
    close: async () => {},
  });

  // exactly what the panel would push for a blog with one thing in it
  const catalog = (over: Partial<Record<string, unknown>> = {}) => ({
    resources: [{
      slug: 'posts', table: 'posts', singular: 'Post', plural: 'Posts',
      columns: ['id', 'title'], key: ['id'], titleField: 'title',
      searchable: ['title'], sortable: ['id', 'title'],
      can: { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false },
      ...over,
    }],
  });

  const push = (o: Record<string, unknown> = {}) => handleAdmin(live, clock, {
    op: 'catalog.push', databaseId: DB, engine: 'postgres', name: 'blog',
    apiRead: true, apiWrite: true, catalog: catalog(), ...o,
  });

  const get = (url: string, key?: string) => dataApp.inject({
    method: 'GET', url, headers: { host: 'pammy.org', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
  const post = (url: string, key: string | undefined, payload: unknown) => dataApp.inject({
    method: 'POST', url, payload: payload as object,
    headers: { host: 'pammy.org', 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });

  before(async () => {
    sock = join(root, 'pammydb.sock');
    helper = createPammyDbServer({ postgres: driver(), mariadb: driver() });
    await new Promise<void>((r) => helper.listen(sock, r));
    dataApp = buildGateApp({
      publicRoot: pub, domain: 'pammy.org', now: () => clock, pammydbSocket: sock,
      mediaIndex: join(root, 'media-public', 'index.db'), mediaThumbs: join(root, 'media-public', 'thumbs'),
    }, live);
    await push();
    readKey = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Website', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string }).key;
    writeKey = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Robot', resources: 'all', canWrite: true, actor: 'pamela' }) as { key: string }).key;
  });
  after(async () => { await new Promise<void>((r) => helper.close(() => r())); });

  it('reads her records with a key, and only the columns the catalog carries', async () => {
    const r = await get('/_pammy/api/data/postgres/blog/posts', readKey);
    assert.equal(r.statusCode, 200);
    const body = r.json() as { total: number; items: Record<string, unknown>[] };
    assert.equal(body.total, 2);
    assert.deepEqual(Object.keys(body.items[0]!).sort(), ['id', 'title']);
    assert.ok(!JSON.stringify(body).includes('not for programs'), 'a hidden column is not in the catalog, so the gate never asks for it');
    assert.match(String(r.headers['cache-control']), /no-store/);
  });

  it('and nothing at all without one', async () => {
    const r = await get('/_pammy/api/data/postgres/blog/posts');
    assert.equal(r.statusCode, 401);
    assert.equal((r.json() as { error: string }).error, 'no-key');
  });

  it('a key in the address is refused, because addresses end up in logs', async () => {
    const r = await get(`/_pammy/api/data/postgres/blog/posts?key=${readKey}`);
    assert.equal(r.statusCode, 400);
    assert.equal((r.json() as { error: string }).error, 'key-in-query');
  });

  it('reading can be switched off without touching a key', async () => {
    await push({ apiRead: false, apiWrite: false });
    const r = await get('/_pammy/api/data/postgres/blog/posts', readKey);
    assert.equal(r.statusCode, 403, 'not a 404: she has simply not switched it on');
    assert.equal((r.json() as { error: string }).error, 'reading-off');
    await push();
  });

  it('a read-only key cannot add, change or delete', async () => {
    for (const [url, payload] of [
      ['/_pammy/api/data/postgres/blog/posts/new', { values: { title: 'x' } }],
      ['/_pammy/api/data/postgres/blog/posts/1/save', { values: { title: 'x' } }],
      ['/_pammy/api/data/postgres/blog/posts/1/delete', {}],
    ] as const) {
      const r = await post(url, readKey, payload);
      assert.equal(r.statusCode, 403, url);
      assert.equal((r.json() as { error: string }).error, 'read-only-key', url);
    }
  });

  it('a key that may write can add, change and delete', async () => {
    const made = await post('/_pammy/api/data/postgres/blog/posts/new', writeKey, { values: { title: 'From a program', secret: 'ignored' } });
    assert.equal(made.statusCode, 201);
    const item = (made.json() as { item: Record<string, unknown> }).item;
    assert.equal(item.title, 'From a program');
    assert.ok(!('secret' in item), 'a column outside the catalog is dropped, never written');
    assert.equal(rows.all('blog', 'posts').find((x) => x.id === item.id)!.secret, undefined,
      'and it really was not written');

    const saved = await post(`/_pammy/api/data/postgres/blog/posts/${item.id}/save`, writeKey, { values: { title: 'Renamed' } });
    assert.equal(saved.statusCode, 200);
    assert.equal((saved.json() as { item: { title: string } }).item.title, 'Renamed');

    assert.equal((await post(`/_pammy/api/data/postgres/blog/posts/${item.id}/delete`, writeKey, {})).statusCode, 200);
    assert.equal((await get(`/_pammy/api/data/postgres/blog/posts/${item.id}`, readKey)).statusCode, 404);
  });

  // docs/rich-text-plan.md T6, T7, T13
  it('a rich-text field is cleaned on the way in and on the way out, and the answer says which fields are rich', async () => {
    const before = rows.all('blog', 'posts');
    await push({ catalog: catalog({ columns: ['id', 'title', 'body'], rich: ['body'] }) });
    try {
      const made = await post('/_pammy/api/data/postgres/blog/posts/new', writeKey, {
        values: { title: 'Rich', body: '<p>Hi <b>there</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a>' },
      });
      assert.equal(made.statusCode, 201, made.body);
      const got = made.json() as { rich: string[]; item: { id: number; body: string } };
      assert.deepEqual(got.rich, ['body']);
      assert.equal(rows.all('blog', 'posts').find((x) => x.id === got.item.id)!.body, '<p>Hi <strong>there</strong></p>x',
        'stored clean, whatever the program sent');

      // plain writing from a program becomes paragraphs, word for word
      const saved = await post(`/_pammy/api/data/postgres/blog/posts/${got.item.id}/save`, writeKey, { values: { body: 'One\n\nTwo <3' } });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(rows.all('blog', 'posts').find((x) => x.id === got.item.id)!.body, '<p>One</p><p>Two &lt;3</p>');

      // written straight into the database -- her own SQL, her WordPress --
      // and still clean in every answer (T7)
      await rows.insert('blog', 'posts', { id: 77, title: 'Planted', body: '<p>ok</p><img src=x onerror=alert(1)><iframe src="https://evil.example"></iframe>' }, ['id']);
      const one = await get('/_pammy/api/data/postgres/blog/posts/77', readKey);
      assert.equal(one.statusCode, 200);
      assert.deepEqual(one.json(), { resource: 'posts', rich: ['body'], item: { id: 77, title: 'Planted', body: '<p>ok</p>' } });
      const list = (await get('/_pammy/api/data/postgres/blog/posts?per=100', readKey)).json() as { rich: string[]; items: { id: number; body: string }[] };
      assert.deepEqual(list.rich, ['body']);
      assert.equal(list.items.find((x) => x.id === 77)!.body, '<p>ok</p>');
      assert.ok(!JSON.stringify(list).includes('onerror'));

      // a long post from a program gets past the gate's usual 8 KB -- and a
      // write with no key is turned away before its body is read
      const long = `<p>${'Words and more words. '.repeat(4000)}</p>`;
      const stored = await post('/_pammy/api/data/postgres/blog/posts/new', writeKey, { values: { title: 'Long', body: long } });
      assert.equal(stored.statusCode, 201, stored.body.slice(0, 300));
      assert.equal(rows.all('blog', 'posts').find((x) => x.title === 'Long')!.body, long);
      const keyless = await post('/_pammy/api/data/postgres/blog/posts/new', undefined, { values: { title: 'Long', body: long } });
      assert.equal(keyless.statusCode, 401);
      assert.equal((keyless.json() as { error: string }).error, 'no-key');

      // too big a table is refused in words, not cut
      const big = await post('/_pammy/api/data/postgres/blog/posts/new', writeKey, {
        values: { title: 'Big', body: `<table><tr>${'<td>x</td>'.repeat(31)}</tr></table>` },
      });
      assert.equal(big.statusCode, 400);
      assert.equal((big.json() as { error: string }).error, 'invalid');

      // a catalog from an older panel, with no `rich`, still serves -- and
      // says nothing is rich, so a page shows every field as words
      await push({ catalog: catalog({ columns: ['id', 'title', 'body'] }) });
      const old = (await get('/_pammy/api/data/postgres/blog/posts/77', readKey)).json() as { rich: string[] };
      assert.deepEqual(old.rich, []);
    } finally {
      rows.set('blog', 'posts', before);
      await push();
    }
  });

  // The claim the whole design rests on.
  it('turning Delete off stops an old key deleting, without revoking it', async () => {
    // a moment ago this key really could delete
    const before = await post('/_pammy/api/data/postgres/blog/posts/2/delete', writeKey, {});
    assert.equal(before.statusCode, 200);
    assert.ok(!rows.all('blog', 'posts').some((x) => x.id === 2), 'and it really went');

    // she turns Delete off on the Resource; the key is not touched
    await push({ catalog: catalog({ can: { create: true, view: true, edit: true, delete: false, duplicate: true, search: true, sort: true, filter: false } }) });
    const after = await post('/_pammy/api/data/postgres/blog/posts/1/delete', writeKey, {});
    assert.equal(after.statusCode, 403);
    assert.equal((after.json() as { error: string }).error, 'switched-off');
    assert.ok(rows.all('blog', 'posts').some((x) => x.id === 1), 'and post 1 is still there');
    // the key is untouched and still reads
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', writeKey)).statusCode, 200);
    await push();
  });

  it('a key for another database reaches nothing here', async () => {
    const other = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: 99, label: 'Elsewhere', resources: 'all', canWrite: true, actor: 'pamela' }) as { key: string }).key;
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', other)).statusCode, 401);
  });

  it('a revoked key stops at once, and so does every key when the app is switched off', async () => {
    const doomed = await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Temporary', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string; appKey: { id: number } };
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', doomed.key)).statusCode, 200);
    await handleAdmin(live, clock, { op: 'appkey.revoke', id: doomed.appKey.id, actor: 'pamela' });
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', doomed.key)).statusCode, 401);

    // switching the app off makes the gate forget the database entirely
    await handleAdmin(live, clock, { op: 'catalog.drop', databaseId: DB });
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts')).statusCode, 404);
    // (its keys are looked up first: they no longer exist, so they are told that)
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', readKey)).json().error, 'bad-key');
    // ...and revokes the keys with it, so switching back on does not quietly
    // let yesterday's key back in
    await push();
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', readKey)).statusCode, 401);
    readKey = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Website again', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string }).key;
    assert.equal((await get('/_pammy/api/data/postgres/blog/posts', readKey)).statusCode, 200);
  });

  it('a made-up key earns nothing: it is charged as guessing, and cannot make the gate read a big body (N2)', async () => {
    const from = (ip: string, headers: Record<string, string>, url = '/_pammy/api/data/postgres/blog/posts') =>
      dataApp.inject({ method: 'GET', url, headers: { host: 'pammy.org', 'x-real-ip': ip, ...headers } });
    // an unknown key is told so, and a stream of them runs into the small allowance, not the keyed one
    const first = await from('203.0.113.7', { authorization: 'Bearer pammy_app_madeup0000000000000000000000' });
    assert.equal(first.statusCode, 401);
    assert.equal((first.json() as { error: string }).error, 'bad-key');
    let limited = 0;
    for (let n = 0; n < 40; n++) {
      if ((await from('203.0.113.7', { authorization: `Bearer made-up-${n}` })).statusCode === 429) limited++;
    }
    assert.ok(limited >= 10, `random tokens hit the guessing limit (${limited} of 40 refused)`);
    // ...which is the IP's, so a real key from elsewhere is not held up
    assert.equal((await from('203.0.113.8', { authorization: `Bearer ${readKey}` })).statusCode, 200);

    // a write's body is only read for a key that exists or someone really signed in:
    // anything else is refused before it (unreadable JSON would be a 400 once read)
    const write = (headers: Record<string, string>) => dataApp.inject({
      method: 'POST', url: '/_pammy/api/data/postgres/blog/posts/new', payload: '{not json',
      headers: { host: 'pammy.org', 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', origin: 'https://pammy.org', ...headers },
    });
    const tries: Record<string, string>[] = [
      { authorization: 'Bearer pammy_app_madeup0000000000000000000000' },
      { cookie: '__Host-pammy_visitor=not-a-session' },
      {},
    ];
    for (const headers of tries) {
      const r = await write(headers);
      assert.equal(r.statusCode, 401, JSON.stringify(headers));
    }
    const real = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Big writer', resources: 'all', canWrite: true, actor: 'pamela' }) as { key: string }).key;
    assert.equal((await write({ authorization: `Bearer ${real}` })).statusCode, 400, 'a real key gets its body read');
  });

  it('a key that names a table follows it when the table is renamed', async () => {
    const some = await handleAdmin(live, clock, { op: 'appkey.create', databaseId: DB, label: 'Just posts', resources: ['posts', 'tags'], canWrite: false, actor: 'pamela' }) as { appKey: { id: number } };
    const other = await handleAdmin(live, clock, { op: 'appkey.create', databaseId: 99, label: 'Elsewhere posts', resources: ['posts'], canWrite: false, actor: 'pamela' }) as { appKey: { id: number } };
    const r = await handleAdmin(live, clock, { op: 'appkeys.rename-table', databaseId: DB, from: 'posts', to: 'articles' }) as { keys: number };
    assert.equal(r.keys, 1, 'only the key that named posts, and not the ones for everything');
    const listed = (await handleAdmin(live, clock, { op: 'appkeys.list', databaseId: DB }) as { keys: { id: number; resources: unknown }[] }).keys;
    assert.deepEqual(listed.find((k) => k.id === some.appKey.id)!.resources, ['articles', 'tags']);
    assert.ok(listed.filter((k) => k.id !== some.appKey.id).every((k) => k.resources === 'all'));
    const elsewhere = (await handleAdmin(live, clock, { op: 'appkeys.list', databaseId: 99 }) as { keys: { id: number; resources: unknown }[] }).keys;
    assert.deepEqual(elsewhere.find((k) => k.id === other.appKey.id)!.resources, ['posts'], 'another database with a posts table is not touched');
    await assert.rejects(handleAdmin(live, clock, { op: 'appkeys.rename-table', databaseId: DB, from: 'posts', to: 'Bad Name' }));
    await handleAdmin(live, clock, { op: 'appkey.revoke', id: some.appKey.id, actor: 'pamela' });
  });

  // ---------------------------------------------------------- people signed in to a folder (docs/tutorials-plan.md V1-V7)
  it('people signed in to the folder she chose can change these with no key, each only their own, only from the site itself', async () => {
    const TODO = 43;
    const thing = (slug: string, table: string, columns: string[], over: Record<string, unknown> = {}) => ({
      slug, table, singular: slug, plural: slug, columns, key: ['id'], titleField: columns[1], searchable: [], sortable: columns,
      can: { create: true, view: true, edit: true, delete: true, duplicate: false, search: false, sort: true, filter: true },
      booleans: ['done'], visitors: { area: ids.A, owner: 'owner' }, refs: [], many: [], ...over,
    });
    const tasks = (over: Record<string, unknown> = {}) => thing('tasks', 'tasks', ['id', 'title', 'done', 'owner', 'list_id'], {
      refs: [{ column: 'list_id', name: 'list', to: 'lists' }], ...over,
    });
    const pushTodo = (resources: unknown[], o: Record<string, unknown> = {}) => handleAdmin(live, clock, {
      op: 'catalog.push', databaseId: TODO, engine: 'postgres', name: 'todo', apiRead: true, apiWrite: true, catalog: { resources }, ...o,
    });
    await pushTodo([tasks(), thing('lists', 'lists', ['id', 'name', 'owner'])]);
    // by the folder itself: earlier tests move its pages about, and change bob's password
    await handleAdmin(live, clock, { op: 'visitor.password', id: ids.bob, password: 'bob-todo-password-789' });
    const alice = (await login({ username: 'alice', password: 'alice-password-123', area: tokens.A })).cookie!;
    const bob = (await login({ username: 'bob', password: 'bob-todo-password-789', area: tokens.A })).cookie!;
    const as = (cookie: string | null, method: 'GET' | 'POST', url: string, payload?: unknown, origin: string | null = 'https://pammy.org') => dataApp.inject({
      method, url: `/_pammy/api/data/postgres/todo/${url}`,
      headers: { host: 'pammy.org', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { payload: payload as object } : {}),
    });

    // nothing without signing in; each person sees only their own
    assert.equal((await as(null, 'GET', 'tasks')).statusCode, 401);
    const mine = await as(alice, 'GET', 'tasks');
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.headers['cache-control'], 'private, no-store');
    assert.deepEqual((mine.json() as { items: { title: string; list: { label: string } }[] }).items.map((t) => [t.title, t.list.label]), [['Milk', 'Shopping']]);
    assert.equal((await as(alice, 'GET', 'tasks/2')).statusCode, 404, "bob's task is not there for alice");

    // a new one is hers, whatever the page said
    const made = await as(alice, 'POST', 'tasks/new', { values: { title: 'Eggs', done: false, owner: 'bob', list_id: 1 } });
    assert.equal(made.statusCode, 201);
    const eggs = (made.json() as { item: { id: number; owner: string } }).item;
    assert.equal(eggs.owner, 'alice');
    // she can tick it off, can't give it away, and bob can't touch it
    const ticked = await as(alice, 'POST', `tasks/${eggs.id}/save`, { values: { done: true, owner: 'bob' } });
    assert.equal(ticked.statusCode, 200);
    assert.deepEqual([(ticked.json() as { item: { done: boolean; owner: string } }).item.done, (ticked.json() as { item: { owner: string } }).item.owner], [true, 'alice']);
    assert.equal((await as(bob, 'POST', `tasks/${eggs.id}/save`, { values: { title: 'Mine now' } })).statusCode, 404);
    assert.equal((await as(bob, 'POST', `tasks/${eggs.id}/delete`)).statusCode, 404);
    assert.deepEqual((await as(bob, 'GET', 'tasks')).json().items.map((t: { title: string }) => t.title), ['Bob thing']);

    // V4: never from another site's page, nor without saying where from
    assert.equal((await as(alice, 'POST', `tasks/${eggs.id}/delete`, undefined, 'https://evil.example')).statusCode, 403);
    assert.equal((await as(alice, 'POST', `tasks/${eggs.id}/delete`, undefined, null)).statusCode, 403);
    assert.equal((await as(alice, 'POST', `tasks/${eggs.id}/delete`)).statusCode, 200);

    // someone signed in to another folder, or no longer let in, reaches nothing
    await pushTodo([tasks({ visitors: { area: ids.C, owner: 'owner' } })]);
    assert.equal((await as(alice, 'GET', 'tasks')).statusCode, 401);
    // without an owner field they all share every row
    await pushTodo([tasks({ visitors: { area: ids.A, owner: null } })]);
    assert.equal((await as(alice, 'GET', 'tasks')).json().total, 2);
    // the catalog's switches still have the last word, and so do the API's two main ones
    await pushTodo([tasks({ can: { create: false, view: true, edit: true, delete: false, duplicate: false, search: false, sort: true, filter: true } })]);
    assert.equal((await as(alice, 'POST', 'tasks/new', { values: { title: 'No' } })).statusCode, 403);
    await pushTodo([tasks()], { apiWrite: false });
    assert.equal((await as(alice, 'POST', 'tasks/1/save', { values: { done: true } })).statusCode, 403);
    // an older catalog (no `visitors`) lets nobody in without a key
    await pushTodo([tasks({ visitors: undefined })]);
    assert.equal((await as(alice, 'GET', 'tasks')).statusCode, 401);
    // N3: a connected table readable only because it's public keeps her rule for
    // someone signed in too -- the title of a list that isn't published stays back
    await pushTodo([tasks(), thing('lists', 'lists', ['id', 'name', 'published'], { visitors: undefined, public: { only: 'published' }, booleans: ['published'] })]);
    const milk = (await as(alice, 'GET', 'tasks')).json().items.find((t: { title: string }) => t.title === 'Milk');
    assert.equal(milk.list_id, 1);
    assert.equal(milk.list, null, "the unpublished list's name is not given away");
    assert.equal(JSON.stringify(milk).includes('Shopping'), false);
    // a published one still comes with its label
    const bobThing = (await as(bob, 'GET', 'tasks')).json().items.find((t: { title: string }) => t.title === 'Bob thing');
    assert.deepEqual(bobThing.list, { id: 2, label: 'Bob stuff' });
    // a key still works as before, for every row
    const key = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: TODO, label: 'Her PHP', resources: 'all', canWrite: true, actor: 'pamela' }) as { key: string }).key;
    assert.equal((await dataApp.inject({ method: 'GET', url: '/_pammy/api/data/postgres/todo/tasks', headers: { host: 'pammy.org', authorization: `Bearer ${key}` } })).json().total, 2);
  });

  // ---------------------------------------------------------- PHP's door (docs/tutorials-plan.md P3)
  it("PHP's socket reaches the API with a key, and nothing else: no pages, no sign-in, no visitor", async () => {
    const path = join(root, 'php.sock');
    const php = createPhpServer((req, res) => dataApp.routing(req, res), 'pammy.org');
    await new Promise<void>((r) => php.listen(path, r));
    const ask = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ socketPath: path, path: url, method: 'GET', headers: { host: 'evil.example', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      const got = await ask('/_pammy/api/data/postgres/blog/posts', { authorization: `Bearer ${readKey}` });
      assert.equal(got.status, 200, 'the host PHP claims is not believed: it is always hers');
      // the very same answer the site gets
      assert.deepEqual(JSON.parse(got.body), (await get('/_pammy/api/data/postgres/blog/posts', readKey)).json());
      assert.equal((await ask('/_pammy/api/data/postgres/blog/posts')).status, 401);
      for (const url of ['/check', '/_pammy/login.js', '/_pammy/me', '/_pammy/examples/blog/', '/']) {
        assert.equal((await ask(url)).status, 404, `${url} is not PHP's business`);
      }
      // a visitor's cookie sent along does not make PHP that visitor
      const alice = (await login({ username: 'alice', password: 'alice-password-123', area: tokens.A })).cookie!;
      assert.ok(alice);
      assert.equal((await ask('/_pammy/api/data/postgres/todo/tasks', { cookie: alice })).status, 401);
    } finally {
      php.closeAllConnections();
      await new Promise<void>((r) => php.close(() => r()));
    }
  });

  // ---------------------------------------------------------- forms into a database (docs/form-to-database-plan.md)
  it('a form that saves its answers in a database: on approval, once only, checked against the catalog, and says why when it cannot', async () => {
    const FDB = 52;
    const cfg = { publicRoot: null, domain: 'pammy.org', pammydbSocket: sock };
    const adm = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, cfg) as Promise<any>;
    const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false };
    const posts = (over: Record<string, unknown> = {}) => ({
      resources: [{
        slug: 'posts', table: 'posts', singular: 'Post', plural: 'Posts', columns: ['id', 'title', 'body'], key: ['id'], titleField: 'title',
        searchable: [], sortable: ['id'], can, rich: ['body'],
        types: {
          id: { type: 'integer', required: true, defaulted: true },
          title: { type: 'short_text', length: 40, required: true, defaulted: false },
          body: { type: 'text', required: false, defaulted: false, rich: true },
        },
        ...over,
      }],
    });
    const pushPosts = (over: Record<string, unknown> = {}) => adm({ op: 'catalog.push', databaseId: FDB, engine: 'postgres', name: 'formsdb', apiRead: false, apiWrite: false, catalog: posts(over) });
    await pushPosts();
    const form = await adm({ op: 'form.create', name: 'share-a-post', title: 'Share a post', actor: 'pamela',
      items: [{ id: 'new-1', type: 'short-text', label: 'Post title', required: true }, { id: 'new-2', type: 'long-text', label: 'Words' }] });
    await adm({ op: 'form.switches', id: form.id, approvable: true });
    const link = { databaseId: FDB, engine: 'postgres', name: 'formsdb', table: 'posts', when: 'approved',
      pairs: [{ key: 'post-title', field: 'title' }, { key: 'words', field: 'body' }], fixed: [] };
    await adm({ op: 'formlink.save', id: form.id, link, actor: 'pamela' });
    const send = async (answers: Record<string, unknown>) => addResponse(db, clock, (await formById(db, form.id))!, 'share.html', answers, null, 'pammy.org', '198.51.100.7');
    const stored = () => rows.all('formsdb', 'posts');
    const responseOf = async (id: number) => (await adm({ op: 'responses.list', formId: form.id })).responses.find((x: { id: number }) => x.id === id);

    // waits for her OK (F3), then is saved when she gives it
    const first = await send({ 'post-title': 'Hello', words: 'Line one\n\nLine <b>two</b>' });
    assert.deepEqual(await saveResponse(db, clock, sock, first), { saved: null, why: 'It is waiting for your OK.' });
    assert.equal(stored().length, 0);
    const approved = await adm({ op: 'response.approve', id: first, approved: true, actor: 'pamela' });
    assert.deepEqual(approved.saved, { saved: true, table: 'Posts', label: 'Hello' });
    assert.equal(stored().length, 1);
    assert.equal(stored()[0]!.body, '<p>Line one</p><p>Line &lt;b&gt;two&lt;/b&gt;</p>', 'what a visitor typed is words');
    assert.equal((await responseOf(first)).savedTo.label, 'Hello');

    // once only (F11): approving again makes no second row
    await adm({ op: 'response.approve', id: first, approved: false, actor: 'pamela' });
    await adm({ op: 'response.approve', id: first, approved: true, actor: 'pamela' });
    assert.equal(stored().length, 1);

    // what does not fit is kept, and says why (F10) -- the response is intact
    const tooLong = await send({ 'post-title': 'x'.repeat(41) });
    const r2 = await adm({ op: 'response.approve', id: tooLong, approved: true, actor: 'pamela' });
    assert.equal(r2.saved.saved, false);
    assert.match(r2.saved.problem, /longer than title can hold \(40 letters\)/);
    assert.match((await responseOf(tooLong)).saveProblem, /longer than title/);
    assert.equal(stored().length, 1);

    // the catalog is the window (F2, F12): "Add new ones" off, and nothing is written ...
    await pushPosts({ can: { ...can, create: false } });
    const third = await send({ 'post-title': 'Third' });
    const r3 = await adm({ op: 'response.approve', id: third, approved: true, actor: 'pamela' });
    assert.match(r3.saved.problem, /new ones can't be added/);
    // ... a field renamed, and nothing is written ...
    await pushPosts({ columns: ['id', 'heading', 'body'], types: { id: { type: 'integer', required: true, defaulted: true }, heading: { type: 'short_text', required: true, defaulted: false }, body: { type: 'text', required: false, defaulted: false } } });
    assert.match((await adm({ op: 'response.save-again', id: third })).problem, /title is not one of the table's fields any more/);
    // ... the app switched off, and nothing is written; back on, and Try again saves it
    await adm({ op: 'catalog.drop', databaseId: FDB });
    assert.match((await adm({ op: 'response.save-again', id: third })).problem, /switched off/);
    await pushPosts();
    assert.equal((await adm({ op: 'response.save-again', id: third })).saved, true);
    assert.equal(stored().length, 2);

    // a database that is asleep is tried again on its own
    await adm({ op: 'formlink.save', id: form.id, link: { ...link, when: 'arrived' }, actor: 'pamela' });
    const fourth = await send({ 'post-title': 'Fourth' });
    const asleep = await saveResponse(db, clock, join(root, 'no-such.sock'), fourth);
    assert.equal(asleep.saved, false);
    assert.equal((await responseOf(fourth)).saveRetry, true);
    assert.equal(await retrySaves(db, clock, sock), 1);
    assert.equal(stored().length, 3);

    // the earlier ones, on her word (Q2): the too-long one still can't be, and says so
    const earlier = await adm({ op: 'formlink.save-earlier', id: form.id });
    assert.deepEqual(earlier, { saved: 0, problems: 1 });

    // the examples' forms can't be connected (F14); a question the form does not have can't be paired
    const example = (await all<{ id: number }>(db, 'SELECT id FROM forms WHERE fixture IS NOT NULL LIMIT 1'))[0];
    if (example) await assert.rejects(adm({ op: 'formlink.save', id: example.id, link, actor: 'pamela' }), /examples' forms/);
    await assert.rejects(adm({ op: 'formlink.save', id: form.id, link: { ...link, pairs: [{ key: 'nope', field: 'title' }] }, actor: 'pamela' }), /no question called nope/);
    // "when I approve" needs approvals
    await adm({ op: 'form.switches', id: form.id, approvable: false });
    await assert.rejects(adm({ op: 'formlink.save', id: form.id, link, actor: 'pamela' }), /Responses can be approved/);
    assert.deepEqual((await adm({ op: 'formlinks.for-database', databaseId: FDB })).links.map((l: { title: string }) => l.title), ['Share a post']);
    await adm({ op: 'formlink.drop', id: form.id });
    await adm({ op: 'catalog.drop', databaseId: FDB });
  });

  // ---------------------------------------------------------- a comment area's copy (docs/comments-plan.md A1, A2)
  it("a comment area keeps its approved comments in an app: thread found or made, approval followed both ways, the post linked", async () => {
    const CDB = 53;
    const cfg = { publicRoot: null, domain: 'pammy.org', pammydbSocket: sock };
    const adm = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, cfg) as Promise<any>;
    const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: true };
    const res = (table: string, columns: string[]) => ({ slug: table.replace(/_/g, '-'), table, singular: table, plural: table === 'comments' ? 'Comments' : table, columns, key: ['id'], titleField: null, searchable: [], sortable: ['id'], can });
    await adm({ op: 'catalog.push', databaseId: CDB, engine: 'postgres', name: 'commentsdb', apiRead: false, apiWrite: false, catalog: { resources: [
      res('comment_threads', ['id', 'area', 'content_type', 'content_id', 'open', 'comments', 'last_at']),
      res('comments', ['id', 'thread_id', 'author', 'body', 'approved', 'sent_at', 'response_id']),
      res('post_comment_threads', ['id', 'post_id', 'thread_id']),
    ] } });
    const area = await adm({ op: 'form.create', name: 'post-talk', title: 'Post talk', kind: 'comments', contentType: 'posts', actor: 'pamela' });
    const link = { databaseId: CDB, engine: 'postgres', name: 'commentsdb', table: 'comments', when: 'approved', fixed: [],
      pairs: [{ key: 'your-name', field: 'author' }, { key: 'your-comment', field: 'body' }] };
    // the wrong kind of link either way round is refused
    await assert.rejects(adm({ op: 'formlink.save', id: area.id, link, actor: 'pamela' }), /comments tables/);
    await adm({ op: 'formlink.save', id: area.id, link: { ...link, mode: 'comments' }, actor: 'pamela' });
    const send = async (words: string) => addResponse(db, clock, (await formById(db, area.id))!, 'blog.html', { 'your-name': 'Rose', 'your-comment': words }, null, 'pammy.org', '198.51.100.8', { type: 'posts', id: '5' });
    const threads = () => rows.all('commentsdb', 'comment_threads');
    const comments = () => rows.all('commentsdb', 'comments');

    const first = await send('First!');
    assert.equal(comments().length, 0, 'nothing until she approves');
    assert.equal((await adm({ op: 'response.approve', id: first, approved: true, actor: 'pamela' })).saved.saved, true);
    assert.deepEqual(threads().map((t) => [t.area, t.content_type, t.content_id, t.comments]), [['post-talk', 'posts', '5', 1]]);
    assert.deepEqual(comments().map((c) => [c.author, c.body, c.approved, c.response_id]), [['Rose', 'First!', true, first]]);
    assert.deepEqual(rows.all('commentsdb', 'post_comment_threads').map((l) => [l.post_id, l.thread_id]), [['5', threads()[0]!.id]], 'the post is linked to its thread');

    // taken off the page: the copy says so, and the count follows (A1)
    await adm({ op: 'response.approve', id: first, approved: false, actor: 'pamela' });
    assert.equal(comments()[0]!.approved, false);
    assert.equal(threads()[0]!.comments, 0);
    await adm({ op: 'response.approve', id: first, approved: true, actor: 'pamela' });
    assert.equal(comments().length, 1, 'still one row');
    assert.equal(comments()[0]!.approved, true);

    // a second comment on the same post finds the same thread
    const second = await send('Second');
    await adm({ op: 'response.approve', id: second, approved: true, actor: 'pamela' });
    assert.equal(threads().length, 1);
    assert.equal(threads()[0]!.comments, 2);
    assert.equal(rows.all('commentsdb', 'post_comment_threads').length, 1);
    // in the trash: not shown, here either
    await adm({ op: 'response.trash', id: second, actor: 'pamela' });
    assert.equal(comments().find((c) => c.response_id === second)!.approved, false);
    assert.equal(threads()[0]!.comments, 1);

    // the app switched off: kept in Responses, and it says why
    await adm({ op: 'catalog.drop', databaseId: CDB });
    const third = await send('Third');
    assert.match((await adm({ op: 'response.approve', id: third, approved: true, actor: 'pamela' })).saved.problem, /switched off/);
    await adm({ op: 'formlink.drop', id: area.id });
  });

  // ---------------------------------------------------------- when the write goes wrong (docs/refactor-plan.md phase 2)
  // The queue and the two writers, put through what a real engine will not do
  // on request: a helper that is not there, and one that takes the request and
  // never answers (test/fake-pammydb.ts).
  const ASLEEP = () => join(root, 'nothing-is-listening.sock');
  const saveState = async (id: number) => (await one<{ save_state: string; save_retry: boolean; saved_to: string | null }>(
    db, 'SELECT save_state, save_retry, saved_to FROM response_saves WHERE response_id = ?', id))!;

  it('a write taken and never answered is left unsure, and not tried again by itself (B3, W4)', async () => {
    const UDB = 61;
    const cfg = { publicRoot: null, domain: 'pammy.org', pammydbSocket: sock };
    const adm = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, cfg) as Promise<any>;
    const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false };
    await adm({ op: 'catalog.push', databaseId: UDB, engine: 'postgres', name: 'unsuredb', apiRead: false, apiWrite: false, catalog: { resources: [{
      slug: 'notes', table: 'notes', singular: 'Note', plural: 'Notes', columns: ['id', 'title'], key: ['id'], titleField: 'title',
      searchable: [], sortable: ['id'], can, types: { id: { type: 'integer', required: true, defaulted: true }, title: { type: 'short_text', length: 80, required: true, defaulted: false } },
    }] } });
    const form = await adm({ op: 'form.create', name: 'unsure-form', title: 'Unsure', actor: 'pamela',
      items: [{ id: 'new-1', type: 'short-text', label: 'Title', required: true }] });
    await adm({ op: 'formlink.save', id: form.id, actor: 'pamela',
      link: { databaseId: UDB, engine: 'postgres', name: 'unsuredb', table: 'notes', when: 'arrived', pairs: [{ key: 'title', field: 'title' }], fixed: [] } });
    const id = await addResponse(db, clock, (await formById(db, form.id))!, 'notes.html', { title: 'Taken and lost' }, null, 'pammy.org', '198.51.100.9');

    const proxy = await startProxy(join(root, 'proxy-unsure.sock'), sock);
    proxy.swallow = 1;
    const res = await saveResponse(db, clock, proxy.path, id) as { saved: false; problem: string; retry: boolean; unsure?: true };
    assert.equal(res.saved, false);
    assert.equal(res.unsure, true);
    assert.equal(res.retry, false, 'a second try could make a second row');
    assert.match(res.problem, /may already be in Notes/);
    assert.equal(rows.all('unsuredb', 'notes').length, 1, 'and it really is there: the helper did the write');
    const st = await saveState(id);
    assert.equal(st.save_state, 'unsure');
    assert.equal(st.save_retry, false);
    assert.equal(await retrySaves(db, clock, sock), 0, 'nothing picks it up on its own');
    assert.equal(rows.all('unsuredb', 'notes').length, 1, 'so no second row is made behind her back');
    // she looks, sees it, and it is hers to decide: Try again would make the second row
    assert.equal((await adm({ op: 'response.save-again', id })).saved, true);
    assert.equal(rows.all('unsuredb', 'notes').length, 2, 'because she asked for it');
    await proxy.stop();
  });

  it('a comment changed while her database sleeps is put right when it wakes (B1, W3)', async () => {
    const SDB = 62;
    const live_ = { publicRoot: null, domain: 'pammy.org', pammydbSocket: sock };
    const adm = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, live_) as Promise<any>;
    const admAsleep = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, { publicRoot: null, domain: 'pammy.org', pammydbSocket: ASLEEP() }) as Promise<any>;
    const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: true };
    const res = (table: string, columns: string[]) => ({ slug: table.replace(/_/g, '-'), table, singular: table, plural: table === 'comments' ? 'Comments' : table, columns, key: ['id'], titleField: null, searchable: [], sortable: ['id'], can });
    await adm({ op: 'catalog.push', databaseId: SDB, engine: 'postgres', name: 'sleepdb', apiRead: false, apiWrite: false, catalog: { resources: [
      res('comment_threads', ['id', 'area', 'content_type', 'content_id', 'open', 'comments', 'last_at']),
      res('comments', ['id', 'thread_id', 'author', 'body', 'approved', 'sent_at', 'response_id']),
    ] } });
    const area = await adm({ op: 'form.create', name: 'sleep-talk', title: 'Sleep talk', kind: 'comments', actor: 'pamela' });
    await adm({ op: 'formlink.save', id: area.id, actor: 'pamela', link: { databaseId: SDB, engine: 'postgres', name: 'sleepdb', table: 'comments',
      when: 'approved', mode: 'comments', fixed: [], pairs: [{ key: 'your-name', field: 'author' }, { key: 'your-comment', field: 'body' }] } });
    const send = async (words: string) => addResponse(db, clock, (await formById(db, area.id))!, 'blog.html',
      { 'your-name': 'Rose', 'your-comment': words }, null, 'pammy.org', '198.51.100.10', { type: 'page', id: '/blog.html' });
    const comments = () => rows.all('sleepdb', 'comments');
    const threads = () => rows.all('sleepdb', 'comment_threads');

    const id = await send('Up on the page');
    assert.equal((await adm({ op: 'response.approve', id, approved: true, actor: 'pamela' })).saved.saved, true);
    assert.equal(comments()[0]!.approved, true);

    // her database goes to sleep, and she takes the comment down
    await admAsleep({ op: 'response.approve', id, approved: false, actor: 'pamela' });
    assert.equal(comments()[0]!.approved, true, 'her table still says it is shown -- nothing could be written');
    const st = await saveState(id);
    assert.ok(st.saved_to, 'it is still noted as copied');
    assert.equal(st.save_state, 'retrying');
    assert.ok((await retryDue(db, 100)).includes(id), 'B1: something already copied is still in the queue');
    // ... and while it is still asleep, bins it and puts it back
    await admAsleep({ op: 'response.trash', id, actor: 'pamela' });
    await admAsleep({ op: 'response.restore', id, actor: 'pamela' });

    // it wakes: one try puts her table right
    assert.equal(await retrySaves(db, clock, sock), 1);
    assert.equal(comments().length, 1, 'still one row');
    assert.equal(comments()[0]!.approved, false, 'not approved, so not shown');
    assert.equal(threads()[0]!.comments, 0);
    assert.equal((await saveState(id)).save_retry, false, 'and it lets go of the queue');

    // two approved at the same moment: the thread is counted once, under a lock (B6, W6)
    const a = await send('One');
    const b = await send('Two');
    await Promise.all([
      adm({ op: 'response.approve', id: a, approved: true, actor: 'pamela' }),
      adm({ op: 'response.approve', id: b, approved: true, actor: 'pamela' }),
    ]);
    assert.equal(threads().length, 1);
    assert.equal(threads()[0]!.comments, 2, 'neither try wrote a count it read before the other one changed it');
  });

  it('nothing left to do lets go of the queue, so newer ones are not stuck behind it (B2, W3)', async () => {
    const QDB = 63;
    const cfg = { publicRoot: null, domain: 'pammy.org', pammydbSocket: sock };
    const adm = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, cfg) as Promise<any>;
    const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false };
    await adm({ op: 'catalog.push', databaseId: QDB, engine: 'postgres', name: 'queuedb', apiRead: false, apiWrite: false, catalog: { resources: [{
      slug: 'lines', table: 'lines', singular: 'Line', plural: 'Lines', columns: ['id', 'title'], key: ['id'], titleField: 'title',
      searchable: [], sortable: ['id'], can, types: { id: { type: 'integer', required: true, defaulted: true }, title: { type: 'short_text', length: 80, required: true, defaulted: false } },
    }] } });
    const form = await adm({ op: 'form.create', name: 'queue-form', title: 'Queue', actor: 'pamela',
      items: [{ id: 'new-1', type: 'short-text', label: 'Title', required: true }] });
    const link = { databaseId: QDB, engine: 'postgres', name: 'queuedb', table: 'lines', when: 'arrived', pairs: [{ key: 'title', field: 'title' }], fixed: [] };
    await adm({ op: 'formlink.save', id: form.id, link, actor: 'pamela' });
    const send = async (title: string) => addResponse(db, clock, (await formById(db, form.id))!, 'q.html', { title }, null, 'pammy.org', '198.51.100.11');

    // sixty of them fail while her database is asleep
    const stuck: number[] = [];
    for (let i = 0; i < 60; i++) stuck.push(await send(`stuck ${i}`));
    for (const id of stuck) assert.equal((await saveResponse(db, clock, ASLEEP(), id)).saved, false);
    assert.equal((await retryDue(db, 100)).length, 60);

    // she switches the saving off: there is nothing left for them to do, and
    // they say so instead of sitting at the head of the queue for ever
    await adm({ op: 'formlink.save', id: form.id, link: { ...link, enabled: false }, actor: 'pamela' });
    const newer = await send('the newer one');
    await retrySaves(db, clock, sock);
    await retrySaves(db, clock, sock);
    assert.deepEqual(await retryDue(db, 100), [], 'the queue clears itself, 50 at a time');
    assert.equal(rows.all('queuedb', 'lines').length, 0);

    // switched back on, the newer one is saved at once
    await adm({ op: 'formlink.save', id: form.id, link, actor: 'pamela' });
    assert.equal((await saveResponse(db, clock, sock, newer)).saved, true);
    assert.equal(rows.all('queuedb', 'lines').length, 1);

    // and approvals can't be taken away while a link waits for them (B4, W7)
    await adm({ op: 'form.switches', id: form.id, approvable: true });
    await adm({ op: 'formlink.save', id: form.id, link: { ...link, when: 'approved' }, actor: 'pamela' });
    await assert.rejects(adm({ op: 'form.switches', id: form.id, approvable: false }), /as soon as they arrive/);
    await adm({ op: 'formlink.save', id: form.id, link, actor: 'pamela' });
    await adm({ op: 'form.switches', id: form.id, approvable: false });
  });

  it('a claim ages in real seconds while the helper is being waited on (B5, W5)', async () => {
    const form = await handleAdmin(live, clock, { op: 'form.create', name: 'claim-form', title: 'Claim', actor: 'pamela',
      items: [{ id: 'new-1', type: 'short-text', label: 'Title', required: true }] } as { op: string }) as any;
    const id = await addResponse(db, clock, (await formById(db, form.id))!, 'c.html', { title: 'x' }, null, 'pammy.org', '198.51.100.12');
    const c = (await claim(db, clock, id))!;
    assert.ok(c, 'the first try takes the claim');
    assert.equal(await claim(db, clock, id), null, 'and a second try does not');
    await new Promise((r) => setTimeout(r, 1100));
    await c.renew();
    const after = (await one<{ save_claimed_at: number }>(db, 'SELECT save_claimed_at FROM response_saves WHERE response_id = ?', id))!;
    assert.ok(Number(after.save_claimed_at) > clock, 'the claim moved on with the clock on the wall, not the one it was handed');
    await settle(db, clock, c, { kind: 'wait', why: 'that is all' });
    assert.ok(await claim(db, clock, id), 'and it is let go at the end');
  });

  // ---------------------------------------------------------- anyone can read (docs/db-examples-plan.md)
  const KITCHEN = 43;
  const can = { create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false };
  const kitchen = (o: { recipesPublic?: unknown; cooksPublic?: unknown; tagsPublic?: unknown } = {}) => ({
    resources: [
      {
        slug: 'recipes', table: 'recipes', singular: 'Recipe', plural: 'Recipes',
        columns: ['id', 'title', 'cook_id', 'shared'], key: ['id'], titleField: 'title',
        searchable: ['title'], sortable: ['id', 'title'], can, booleans: ['shared'],
        public: 'recipesPublic' in o ? o.recipesPublic : { only: 'shared' },
        refs: [{ column: 'cook_id', name: 'cook', to: 'cooks' }],
        many: [{ name: 'tags', junction: 'recipe_tags', here: 'recipe_id', there: 'tag_id', to: 'tags' }],
      },
      {
        slug: 'cooks', table: 'cooks', singular: 'Cook', plural: 'Cooks',
        columns: ['id', 'name'], key: ['id'], titleField: 'name',
        searchable: ['name'], sortable: ['id', 'name'], can,
        public: 'cooksPublic' in o ? o.cooksPublic : { only: null },
      },
      {
        slug: 'tags', table: 'tags', singular: 'Tag', plural: 'Tags',
        columns: ['id', 'name'], key: ['id'], titleField: 'name',
        searchable: ['name'], sortable: ['id', 'name'], can,
        public: 'tagsPublic' in o ? o.tagsPublic : { only: null },
      },
    ],
  });
  const pushKitchen = (o: Record<string, unknown> = {}, c = kitchen()) => handleAdmin(live, clock, {
    op: 'catalog.push', databaseId: KITCHEN, engine: 'postgres', name: 'kitchen',
    apiRead: true, apiWrite: false, catalog: c, ...o,
  });
  type Item = Record<string, unknown> & { id: number };
  const itemsOf = async (url: string, key?: string) => {
    const r = await get(url, key);
    assert.equal(r.statusCode, 200, r.body);
    return (r.json() as { items: Item[] }).items;
  };

  it('a table anyone may read answers without a key -- only its rows her rule lets out', async () => {
    await pushKitchen();
    const r = await get('/_pammy/api/data/postgres/kitchen/recipes');
    assert.equal(r.statusCode, 200);
    const body = r.json() as { total: number; items: Item[] };
    assert.deepEqual(body.items.map((i) => i.title), ['Pancakes', 'Toast'], 'the stew is not shared, so it is not there');
    assert.equal(body.total, 2, 'and is not counted either');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.ok(r.headers.etag, 'a public answer can be asked about again cheaply');
    const again = await dataApp.inject({ method: 'GET', url: '/_pammy/api/data/postgres/kitchen/recipes', headers: { host: 'pammy.org', 'if-none-match': String(r.headers.etag) } });
    assert.equal(again.statusCode, 304);

    // one record her rule keeps back is not there, the same as one that never was
    assert.equal((await get('/_pammy/api/data/postgres/kitchen/recipes/2')).statusCode, 404);
    assert.equal((await get('/_pammy/api/data/postgres/kitchen/recipes/1')).statusCode, 200);
  });

  it('a key still reads everything its grants allow, rule or no rule', async () => {
    const key = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: KITCHEN, label: 'Kitchen robot', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string }).key;
    assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes', key)).map((i) => i.title), ['Pancakes', 'Secret stew', 'Toast']);
    assert.equal((await get('/_pammy/api/data/postgres/kitchen/recipes/2', key)).statusCode, 200);
  });

  it('without a key, nothing is written, and a private table still asks for one', async () => {
    // even with writing switched on for keys
    await pushKitchen({ apiWrite: true });
    const w = await post('/_pammy/api/data/postgres/kitchen/recipes/new', undefined, { values: { title: 'Sneaky' } });
    assert.equal(w.statusCode, 401);
    assert.equal((w.json() as { error: string }).error, 'no-key');
    await pushKitchen({}, kitchen({ cooksPublic: null }));
    const c = await get('/_pammy/api/data/postgres/kitchen/cooks');
    assert.equal(c.statusCode, 401);
    assert.equal((c.json() as { error: string }).error, 'no-key');
    await pushKitchen();
  });

  it('the reading switch is still the master switch', async () => {
    await pushKitchen({ apiRead: false });
    const r = await get('/_pammy/api/data/postgres/kitchen/recipes');
    assert.equal(r.statusCode, 403);
    assert.equal((r.json() as { error: string }).error, 'reading-off');
    await pushKitchen();
  });

  it('answers carry their connections as { id, label }, and a many-to-many as a list', async () => {
    const [pancakes, toast] = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes');
    assert.deepEqual(pancakes!.cook, { id: 1, label: 'Olivia' });
    assert.equal(pancakes!.cook_id, 1, 'the field itself is still there');
    assert.deepEqual(pancakes!.tags, [{ id: 2, label: 'breakfast' }, { id: 1, label: 'quick' }]);
    assert.equal(toast!.cook, null, 'no cook is null, not missing');
    assert.deepEqual(toast!.tags, [{ id: 1, label: 'quick' }]);
    // and on one record
    const one = (await get('/_pammy/api/data/postgres/kitchen/recipes/1')).json() as { item: Item };
    assert.deepEqual(one.item.cook, { id: 1, label: 'Olivia' });
    assert.equal(JSON.stringify(one).includes('07700'), false, 'only the title field of what it points at');
  });

  it('a connection to a table the request could not read by itself is left out', async () => {
    await pushKitchen({}, kitchen({ cooksPublic: null, tagsPublic: null }));
    const [pancakes] = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes');
    assert.equal('cook' in pancakes!, false);
    assert.equal('tags' in pancakes!, false);
    await pushKitchen();
  });

  it('a yes/no filter means yes or no, however it is written', async () => {
    const key = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: KITCHEN, label: 'Filter robot', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string }).key;
    for (const yes of ['true', '1', 'yes']) {
      assert.deepEqual((await itemsOf(`/_pammy/api/data/postgres/kitchen/recipes?where.shared=${yes}`, key)).map((i) => i.id), [1, 3], yes);
    }
    assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes?where.shared=false', key)).map((i) => i.id), [2]);
    // and without a key, asking for the rows the rule keeps back finds none
    assert.deepEqual(await itemsOf('/_pammy/api/data/postgres/kitchen/recipes?where.shared=false'), []);
  });

  it('a catalog pushed by an older panel serves as before: private, no connections', async () => {
    const old = kitchen();
    for (const r of old.resources) { delete (r as Record<string, unknown>).public; delete (r as Record<string, unknown>).refs; delete (r as Record<string, unknown>).many; }
    await pushKitchen({}, old);
    assert.equal((await get('/_pammy/api/data/postgres/kitchen/recipes')).statusCode, 401);
    await pushKitchen();
  });

  it('a kind of thing that is not in the catalog is simply not there', async () => {
    assert.equal((await get('/_pammy/api/data/postgres/blog/nothing-like-this', readKey)).statusCode, 404);
    assert.equal((await get('/_pammy/api/data/postgres/other_db/posts', readKey)).statusCode, 404);
  });

  // docs/catalog-plan.md step 4b: her records' labels, from the copy the panel sends
  describe('labels (catalog step 4b)', () => {
    const tagged = () => {
      const c = kitchen();
      (c.resources[0] as Record<string, unknown>).tagged = true;
      return c;
    };
    const putLabels = (o: Record<string, unknown> = {}) => handleAdmin(live, clock, {
      op: 'record-labels.put', databaseId: KITCHEN, table: 'recipes',
      labels: [{ kind: 'tag', name: 'quick-x', public: true }, { kind: 'category', name: 'breakfast-x', public: false }],
      records: [['1', [0, 1]], ['2', [0]], ['3', [0]]], ...o,
    });
    let key = '';
    before(async () => {
      key = (await handleAdmin(live, clock, { op: 'appkey.create', databaseId: KITCHEN, label: 'Labels robot', resources: 'all', canWrite: false, actor: 'pamela' }) as { key: string }).key;
    });
    after(async () => {
      await handleAdmin(live, clock, { op: 'record-labels.keep', tables: [] });
      await pushKitchen();
    });

    it('a table without tags on answers as before, and says so when asked by tag', async () => {
      await pushKitchen();
      await putLabels();
      const items = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes', key);
      assert.equal('labels' in items[0]!, false);
      const r = await get('/_pammy/api/data/postgres/kitchen/recipes?tag=quick-x', key);
      assert.equal(r.statusCode, 400);
      assert.equal((r.json() as { error: string }).error, 'not-tagged');
    });

    it('a key sees every label on every record, and can ask by several', async () => {
      await pushKitchen({}, tagged());
      await putLabels();
      const items = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes', key);
      assert.deepEqual(items.map((i) => [i.id, i.labels]), [
        [1, { tags: ['quick-x'], categories: ['breakfast-x'] }], [2, { tags: ['quick-x'], categories: [] }], [3, { tags: ['quick-x'], categories: [] }]]);
      assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes?tag=quick-x', key)).map((i) => i.id), [1, 2, 3]);
      const both = await get('/_pammy/api/data/postgres/kitchen/recipes?tag=quick-x&category=breakfast-x', key);
      assert.deepEqual(((both.json()) as { total: number; items: Item[] }).items.map((i) => i.id), [1]);
      assert.equal((both.json() as { total: number }).total, 1);
      // one record, with its labels too
      const one = await get('/_pammy/api/data/postgres/kitchen/recipes/1', key);
      assert.deepEqual((one.json() as { item: Item }).item.labels, { tags: ['quick-x'], categories: ['breakfast-x'] });
      // with her other filters
      assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes?tag=quick-x&where.shared=false', key)).map((i) => i.id), [2]);
    });

    it('without a key: public labels only, and only the rows her rule lets out', async () => {
      const items = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes');
      assert.deepEqual(items.map((i) => [i.id, i.labels]), [[1, { tags: ['quick-x'], categories: [] }], [3, { tags: ['quick-x'], categories: [] }]]);
      assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes?tag=quick-x')).map((i) => i.id), [1, 3]);
      const priv = await get('/_pammy/api/data/postgres/kitchen/recipes?category=breakfast-x');
      assert.equal(priv.statusCode, 404);
      assert.match((priv.json() as { message: string }).message, /no public category called "breakfast-x"/);
      assert.equal((await get('/_pammy/api/data/postgres/kitchen/recipes?tag=nobody-has-it', key)).statusCode, 404);
    });

    it('the label list: counts and public for a key, public names only without one', async () => {
      const withKey = (await get('/_pammy/api/data/postgres/kitchen/recipes/_labels', key)).json();
      assert.deepEqual(withKey, { resource: 'recipes', tags: [{ name: 'quick-x', records: 3, public: true }], categories: [{ name: 'breakfast-x', records: 1, public: false }] });
      const open = (await get('/_pammy/api/data/postgres/kitchen/recipes/_labels')).json();
      assert.deepEqual(open, { resource: 'recipes', tags: [{ name: 'quick-x' }], categories: [] });
    });

    it('a field called labels keeps its name: the panel\'s are pammy_labels then', async () => {
      const c = tagged();
      const recipes = c.resources[0] as { refs: { column: string; name: string; to: string }[] };
      recipes.refs = [{ column: 'cook_id', name: 'labels', to: 'cooks' }];
      await pushKitchen({}, c);
      const items = await itemsOf('/_pammy/api/data/postgres/kitchen/recipes', key);
      assert.deepEqual(items[0]!.pammy_labels, { tags: ['quick-x'], categories: ['breakfast-x'] });
      await pushKitchen({}, tagged());
    });

    it('a table no longer tagged loses its copy; a bad label is refused', async () => {
      await handleAdmin(live, clock, { op: 'record-labels.keep', tables: [{ databaseId: KITCHEN, table: 'cooks' }] });
      assert.deepEqual((await itemsOf('/_pammy/api/data/postgres/kitchen/recipes', key))[0]!.labels, { tags: [], categories: [] });
      await assert.rejects(putLabels({ labels: [{ kind: 'tag', name: 'Not A Name', public: true }], records: [] }), /could not read/);
      await assert.rejects(putLabels({ records: [['1', [7]]] }), /could not read/);
    });
  });
});

// ------------------------------------------------------------------ roles (docs/roles-plan.md step 3)
describe('who it is, for a page in a protected folder', () => {
  it('the account, and the role and privileges of the innermost folder', async () => {
    // folders and a person of its own: the tests above change the others
    file('roles-out/page.html'); file('roles-out/in/page.html'); file('open-roles/page.html');
    await protect('RO', 'roles-out');
    await protect('RI', 'roles-out/in');
    const rolf = (await admin({ op: 'visitor.create', username: 'rolf', password: 'rolf-password-123' })).id as number;
    for (const a of ['RO', 'RI']) await admin({ op: 'grant', visitorId: rolf, areaId: ids[a], allow: true });
    const cookie = (await login({ username: 'rolf', password: 'rolf-password-123', area: tokens.RO })).cookie!;
    const outer = await check('/roles-out/page.html', { cookie });
    assert.deepEqual([outer.status, outer.user, outer.account, outer.role, outer.privileges], [204, 'rolf', String(rolf), 'Member', 'pages.read']);

    // the inner folder on a set of its own: its role counts, groups and all
    const [set] = await db`INSERT INTO role_sets (label, created_at) VALUES ('Inner', 1) RETURNING id`;
    const [editor] = await db`INSERT INTO roles (role_set_id, key, label) VALUES (${set!.id}, 'editor', 'Editor') RETURNING id`;
    const [g] = await db`INSERT INTO groups (role_set_id, key, label) VALUES (${set!.id}, 'write', 'Write') RETURNING id`;
    await db`INSERT INTO group_privileges (group_id, privilege) VALUES (${g!.id}, 'notes.update:own'), (${g!.id}, 'notes.read:any')`;
    await db`INSERT INTO role_groups (role_id, group_id, role_set_id) VALUES (${editor!.id}, ${g!.id}, ${set!.id})`;
    await db`INSERT INTO role_privileges (role_id, privilege) VALUES (${editor!.id}, 'pages.read')`;
    await db`DELETE FROM memberships WHERE area_id = ${ids.RI!}`;
    await db`UPDATE areas SET role_set_id = ${set!.id} WHERE id = ${ids.RI!}`;
    await db`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${rolf}, ${ids.RI!}, ${set!.id}, ${editor!.id}, 1)`;
    await live.changed();
    const inner = await check('/roles-out/in/page.html', { cookie });
    assert.deepEqual([inner.status, inner.role, inner.privileges], [204, 'Editor', 'notes.read:any notes.update:own pages.read']);
    // and none of it for a page anyone can open
    const open = await check('/open-roles/page.html', { cookie });
    assert.deepEqual([open.status, open.user, open.account, open.role, open.privileges], [204, undefined, undefined, undefined, undefined]);
  });

  it('step 4: a folder whose "not signed in" slot opens the pages is open to anyone, and its pages are told so', async () => {
    file('roles-public/page.html');
    await protect('RP', 'roles-public');
    assert.equal((await check('/roles-public/page.html')).status, 401);
    await admin({ op: 'visitor-settings.set', key: 'roles', on: true, mail: false, actor: 'test' });
    const st = await admin({ op: 'access.copy', areaId: ids.RP });
    const slot = st.roles.find((r: { slot: string | null }) => r.slot === 'not-signed-in');
    await admin({ op: 'access.resource', areaId: ids.RP, key: 'notes', label: 'Notes', owned: false, actions: ['read'] });
    await admin({ op: 'access.role', areaId: ids.RP, id: slot.id, privileges: ['pages.read', 'notes.read'] });
    const anyone = await check('/roles-public/page.html');
    assert.deepEqual([anyone.status, anyone.user, anyone.account, anyone.role, anyone.privileges], [204, undefined, undefined, 'Not signed in', 'notes.read pages.read']);
    // taken away again: sign-in as before
    await admin({ op: 'access.role', areaId: ids.RP, id: slot.id, privileges: [] });
    assert.equal((await check('/roles-public/page.html')).status, 401);
    await admin({ op: 'access.reset', areaId: ids.RP });
  });
});
