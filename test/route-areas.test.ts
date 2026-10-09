// Accounts on a route (docs/roles-plan.md step 5): the gate's side, with lfdln's
// profile. A route's area is made, changed and taken away through the admin
// socket (route-area.set); nginx asks /check/<token>; anyone may use one "Open
// with accounts" and the app is told who is signed in; "Only people let in" asks
// them to sign in, as a protected folder does. Nothing here finds a route's area
// by a folder's path, and a token the gate doesn't know is refused.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { handleAdmin } from '@panel/gate/admin';
import { buildGateApp } from '@panel/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { SiteRoutes } from '@panel/core/gate/site-routes';
import { connectPg, one, type Sql } from '@panel/core/pg';
import { createVisitorSession } from '@panel/people/gate/sessions';
import { readVisitorSettings } from '@panel/core/gate/visitor-settings';
import { setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import { GateError } from '@panel/core/gate/ops';
import { migrate } from '@panel/core/pg-migrate';
import { resolve } from '@panel/areas/gate/policy';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { startPg, type PgTest } from './pg-harness.ts';
import { generateKeyPairSync } from 'node:crypto';
import { proofOk, type Told } from '@panel/core/identity-proof';

const HOST = 'examprep.lesfleursdelanuit.com';
const COOKIE = '__Host-lfdln_visitor';
let pg: PgTest;
let root: string;
let pub: string;
let sql: Sql;
let live: GateLive;
let app: FastifyInstance;
const clock = 1_800_000_000;
// the key the gate signs what apps are told with (docs/s1-plan.md S1a)
const identity = generateKeyPairSync('ed25519');
const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: pub, domain: LFDLN.domain, modules: LFDLN.modules }) as Promise<any>;
const check = (token: string, cookie?: string, next = '/practice/3?x=1') => app.inject({
  method: 'GET', url: `/check/${token}`, remoteAddress: '127.0.0.1',
  headers: { host: HOST, 'x-pammy-next': next, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) },
});
const who = (r: { headers: Record<string, unknown> }) => ['x-pammy-account', 'x-pammy-user', 'x-pammy-role', 'x-pammy-privileges'].map((h) => r.headers[h] ?? null);

let jo: { id: number }, al: { id: number };
let joSession: string, alSession: string;

before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'route-areas-'));
  pub = join(root, 'sites');
  mkdirSync(join(pub, 'route'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), 'home');
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  sql = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 4, app: 'test-route-areas' });
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
  live.markReady();
  await live.reloadAreas();
  app = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock, identityKey: identity.privateKey }, live);
  await app.ready();
  jo = await admin({ op: 'visitor.create', username: 'jo', password: 'jo-password-123' });
  al = await admin({ op: 'visitor.create', username: 'al', password: 'al-password-123' });
  joSession = await createVisitorSession(sql, clock, jo.id, HOST, '198.51.100.9');
  alSession = await createVisitorSession(sql, clock, al.id, HOST, '198.51.100.9');
});
after(async () => {
  await app?.close();
  await sql?.end({ timeout: 1 });
  rmSync(root, { recursive: true, force: true });
  await pg?.stop();
});

const switches = async (on: boolean) => {
  for (const k of on ? ['emailedLinks', 'selfRegister', 'openAreas'] as const : ['emailedLinks'] as const) {
    await setVisitorSwitch(sql, clock, k, on, 'test', { mail: true });
  }
  await live.changed();
};

describe('a route with accounts, in the gate', () => {
  let open: string;

  it('"Open with accounts" needs its switch; the built-in set is there', async () => {
    const set = await one<{ label: string; signed_in: string }>(sql,
      "SELECT s.label, r.key AS signed_in FROM role_sets s JOIN roles r ON r.id = s.signed_in_role_id WHERE s.key = 'open-with-accounts'");
    assert.deepEqual(set, { label: 'Open with accounts', signed_in: 'member' });
    await assert.rejects(admin({ op: 'route-area.set', routeId: 7, accounts: 'open', address: `${HOST}/` }), /"Open with accounts" is switched off/);
    await assert.rejects(admin({ op: 'route-area.set', routeId: 7, accounts: 'public', address: `${HOST}/` }), /open, private, or none/);
    await assert.rejects(admin({ op: 'route-area.set', routeId: 'x', accounts: 'private', address: `${HOST}/` }), /Which route/);
    await assert.rejects(admin({ op: 'route-area.set', routeId: 7, accounts: 'private', address: 'a b' }), /address isn't one/);
  });

  it('open: anyone comes in, told who is signed in (and nobody, when nobody is)', async () => {
    await switches(true);
    const made = await admin({ op: 'route-area.set', routeId: 7, accounts: 'open', address: `${HOST}/` });
    assert.match(made.token, /^[A-Za-z0-9_-]{32}$/);
    open = made.token;
    const again = await admin({ op: 'route-area.set', routeId: 7, accounts: 'open', address: `${HOST}/` });
    assert.equal(again.token, open, 'the same area');

    const out = await check(open);
    assert.equal(out.statusCode, 204);
    assert.deepEqual(who(out), [null, null, 'Not signed in', 'pages.read']);
    assert.equal(out.headers['x-pammy-cache'], undefined, 'nothing private about it');
    const signed = await check(open, joSession);
    assert.equal(signed.statusCode, 204);
    assert.deepEqual(who(signed), [String(jo.id), 'jo', 'Member', 'pages.read']);
    // a session from another host, or a made-up one: not signed in, still in
    assert.deepEqual(who(await check(open, 'x'.repeat(43))), [null, null, 'Not signed in', 'pages.read']);
  });

  it('for an app: what it is told is signed for that app alone (docs/s1-plan.md S1a)', async () => {
    // the routes as the routing helper writes them: exam prep's route has the open area; another
    // route on another host has area B, to project "other"
    const b = await admin({ op: 'route-area.set', routeId: 8, accounts: 'open', address: `${HOST}/b/` });
    const routesFile = join(root, 'gate-routes.json');
    const OTHER = 'other.lesfleursdelanuit.com';
    writeFileSync(routesFile, JSON.stringify({ v: 1, domains: [LFDLN.domain], hosts: {
      [HOST]: [{ path: '/', kind: 'service', service: 'examprep', area: open, audience: 'service.examprep.web' }],
      [OTHER]: [{ path: '/', kind: 'project', area: b.token, audience: 'project.other.main' }],
    } }));
    const routed = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas-routed.json'), routes: new SiteRoutes(routesFile) });
    routed.markReady();
    await routed.reloadAreas();
    const gate = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock, identityKey: identity.privateKey }, routed);
    const ask = (aud: string, cookie?: string, o: { token?: string; host?: string; via?: FastifyInstance } = {}) => (o.via ?? gate).inject({
      method: 'GET', url: `/check/${o.token ?? open}/${aud}`, remoteAddress: '127.0.0.1',
      headers: { host: o.host ?? HOST, 'x-pammy-next': '/', ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) },
    });
    const told = (r: { headers: Record<string, unknown> }): Told => {
      const [account, username, role, privileges] = who(r).map((v) => String(v ?? ''));
      return { account: account!, username: username!, role: role!, privileges: privileges! };
    };
    const signed = await ask('service.examprep.web', joSession);
    assert.equal(signed.statusCode, 204);
    const proof = signed.headers['x-pammy-proof'];
    assert.match(String(proof), /^v1\.\d{13}\.[A-Za-z0-9_-]{86}$/);
    const now = Date.now();
    assert.ok(proofOk(identity.publicKey, proof, 'service.examprep.web', HOST, told(signed), now), "the app's own: good");
    assert.ok(!proofOk(identity.publicKey, proof, 'project.other.main', HOST, told(signed), now), "another app's: no good");
    assert.ok(!proofOk(identity.publicKey, proof, 'service.examprep.web', 'x.lesfleursdelanuit.com', told(signed), now), 'another host: no good');
    assert.ok(!proofOk(identity.publicKey, proof, 'service.examprep.web', HOST, { ...told(signed), privileges: 'pages.read progress.read:any' }, now), 'more privileges: no good');
    assert.ok(!proofOk(identity.publicKey, proof, 'service.examprep.web', HOST, { ...told(signed), account: String(jo.id + 1) }, now), 'another account: no good');
    assert.ok(!proofOk(identity.publicKey, proof, 'service.examprep.web', HOST, told(signed), now + 6 * 60_000), 'too old: no good');
    // nobody signed in is signed too: "Not signed in" and what anyone may do
    const guest = await ask('service.examprep.web');
    assert.deepEqual(told(guest), { account: '', username: '', role: 'Not signed in', privileges: 'pages.read' });
    assert.ok(proofOk(identity.publicKey, guest.headers['x-pammy-proof'], 'service.examprep.web', HOST, told(guest), now));
    // B1 of the review: only the app this host's route with this area sends to
    assert.equal((await ask('service.examprep.web', joSession, { token: b.token })).statusCode, 403, "area B's token for exam prep's proof");
    assert.equal((await ask('project.other.main', joSession)).statusCode, 403, "exam prep's area for another app");
    assert.equal((await ask('service.examprep.web', joSession, { host: OTHER })).statusCode, 403, 'exam prep on another host');
    assert.equal((await ask('project.other.main', joSession, { token: b.token, host: OTHER })).statusCode, 204, "B's own route: its own app");
    // a gate with no routes (pammy.org: no apps) signs for nobody
    assert.equal((await ask('service.examprep.web', joSession, { via: app })).statusCode, 403);
    // a folder route's check names no app: no proof
    assert.equal((await check(open, joSession)).headers['x-pammy-proof'], undefined);
    // what can't name an app is refused outright
    for (const bad of ['Service.x.y', 'service..y', 'service.x.y.z', 'a'.repeat(17) + '.x']) assert.equal((await ask(bad)).statusCode, 403, bad);
    // a gate without the key says who, without a proof
    const plain = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock }, routed);
    const r = await ask('service.examprep.web', undefined, { via: plain });
    assert.equal(r.statusCode, 204);
    assert.equal(r.headers['x-pammy-proof'], undefined);
    await plain.close();
    await gate.close();
    await admin({ op: 'route-area.set', routeId: 8, accounts: null });
  });

  it('never found by a folder path, and a token it does not know is refused', async () => {
    const area = live.byToken(open)!;
    assert.equal(area.kind, 'route');
    assert.equal(area.path, '/route/7');
    assert.equal(live.byPath('/route/7'), undefined);
    const r = resolve(live, pub, '/route/7/index.html');
    assert.ok(r.kind === 'ok' && r.protections.length === 0);
    assert.equal((await check('A'.repeat(32))).statusCode, 403);
    assert.equal((await check('short')).statusCode, 403);
    // a protected folder's token isn't a route's
    mkdirSync(join(pub, 'members'));
    const folder = await admin({ op: 'area.create', path: 'members' });
    assert.equal((await check(folder.token)).statusCode, 403);
    // nor does the folder list show a route's area as a folder to protect
    await assert.rejects(admin({ op: 'area.delete', id: area.id }), /no longer exists/);
    await assert.rejects(admin({ op: 'area.move', id: area.id, path: 'members2' }), /no longer exists/);
    const st = await admin({ op: 'state' });
    assert.deepEqual(st.areas.map((a: { kind: string; routeId: number | null; label: string | null }) => [a.kind, a.routeId, a.label]),
      [['route', 7, `${HOST}/`], ['folder', null, null]]);
    // another host's session isn't signed in here
    const other = await app.inject({ method: 'GET', url: `/check/${open}`, remoteAddress: '127.0.0.1', headers: { host: 'pammy.org' } });
    assert.equal(other.statusCode, 403);
  });

  it('private: sign in first, then only people let in; Member keeps their role across the change', async () => {
    await admin({ op: 'route-area.set', routeId: 7, accounts: 'private', address: `${HOST}/` });
    const area = live.byToken(open)!;
    const out = await check(open);
    assert.equal(out.statusCode, 401);
    assert.equal(out.headers['x-pammy-cache'], 'private, no-store');
    assert.equal(out.headers['x-pammy-login'], `/_pammy/login?next=${encodeURIComponent('/practice/3?x=1')}&area=${open}`);
    // signed in without a role: denied, said so
    const denied = await check(open, joSession);
    assert.equal(denied.statusCode, 401);
    assert.match(String(denied.headers['x-pammy-login']), /&denied=1$/);
    const privatePage = await app.inject({ method: 'GET', url: `/_pammy/login?area=${open}`, headers: { host: HOST } });
    assert.match(privatePage.body, /<pammy-login area="[A-Za-z0-9_-]+" heading="This part of the site is private"><\/pammy-login>/, 'a route, not a folder');
    await admin({ op: 'grant', visitorId: jo.id, areaId: area.id, allow: true });
    const let_in = await check(open, joSession);
    assert.equal(let_in.statusCode, 204);
    assert.equal(let_in.headers['x-pammy-cache'], 'private, no-store');
    assert.deepEqual(who(let_in), [String(jo.id), 'jo', 'Member', 'pages.read']);
    assert.equal((await check(open, alSession)).statusCode, 401);
    // back to open: jo is still Member (by key), everyone else gets in too
    const back = await admin({ op: 'route-area.set', routeId: 7, accounts: 'open', address: `${HOST}/` });
    assert.deepEqual(back.lost, []);
    assert.deepEqual((await admin({ op: 'state' })).areas.find((a: { id: number }) => a.id === area.id).visitors, [jo.id]);
    assert.equal((await check(open, alSession)).statusCode, 204);
  });

  it('the sign-in page for a route is the built-in one, and signing in goes back where they were', async () => {
    const about = await app.inject({ method: 'GET', url: `/_pammy/about?area=${open}`, headers: { host: HOST, 'x-pammy-base': '/' } });
    assert.equal(about.statusCode, 200);
    assert.deepEqual(about.json().pages.login, `/_pammy/login?area=${open}`);
    // open with accounts: signing in is only asked, and anyone may make an account
    const page = await app.inject({ method: 'GET', url: `/_pammy/login?area=${open}`, headers: { host: HOST } });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`<pammy-login area="${open}" heading="Sign in" accounts="open"></pammy-login>`), page.body);
    assert.doesNotMatch(page.body, /This folder is private/);
    // a protected folder's page is word for word as before
    mkdirSync(join(pub, 'members-page'), { recursive: true });
    const folder = await admin({ op: 'area.create', path: 'members-page' });
    const folderPage = await app.inject({ method: 'GET', url: `/_pammy/login?area=${folder.token}`, headers: { host: HOST } });
    assert.ok(folderPage.body.includes(`<pammy-login area="${folder.token}" heading="This folder is private"></pammy-login>`));
    await admin({ op: 'area.delete', id: folder.id });
    const login = await app.inject({
      method: 'POST', url: '/_pammy/login', remoteAddress: '127.0.0.1',
      headers: { host: HOST, 'x-pammy-base': '/', origin: `https://${HOST}`, 'content-type': 'application/json', 'x-real-ip': '203.0.113.5' },
      payload: { area: open, username: 'al', password: 'al-password-123', next: '/practice/3' },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().next, '/practice/3');
    const home = await app.inject({
      method: 'POST', url: '/_pammy/login', remoteAddress: '127.0.0.1',
      headers: { host: HOST, 'x-pammy-base': '/', origin: `https://${HOST}`, 'content-type': 'application/json', 'x-real-ip': '203.0.113.5' },
      payload: { area: open, username: 'al', password: 'al-password-123' },
    });
    assert.equal(home.json().next, '/', "the host's top, not a folder");
  });

  it('"Open with accounts" and roles stay on while a route uses them', async () => {
    // word for word (docs/k-a-plan.md K-a4: the check moves to areas, the words to people), and nothing changed
    const words = `First take accounts off "${HOST}/" (Hosts), or make them "Only people let in".`;
    await assert.rejects(setVisitorSwitch(sql, clock, 'openAreas', false, 'test', { mail: true }), (e) => e instanceof GateError && e.code === 'invalid' && e.message === words);
    await assert.rejects(setVisitorSwitch(sql, clock, 'emailedLinks', false, 'test', { mail: true }), (e) => e instanceof GateError && e.message === words);
    assert.deepEqual([(await readVisitorSettings(sql)).switches.openAreas, (await readVisitorSettings(sql)).switches.emailedLinks], [true, true]);
    // roles off is fine: the route is on a built-in set
    await setVisitorSwitch(sql, clock, 'roles', true, 'test', { mail: true });
    await setVisitorSwitch(sql, clock, 'roles', false, 'test', { mail: true });
  });

  it("a setup link goes where the sign-in pages are (the route's address), never the bare domain", async () => {
    const pat = await admin({ op: 'visitor.create', username: 'pat', password: null });
    const l = await admin({ op: 'link.create', visitorId: pat.id, areaId: null });
    assert.match(l.url, new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/_pammy/invite#`));
    await admin({ op: 'visitor.delete', id: pat.id });
  });

  it('none: the area goes, and says whose role went with it', async () => {
    const gone = await admin({ op: 'route-area.set', routeId: 7, accounts: null });
    assert.deepEqual(gone, { token: null, areaId: null, accounts: null, lost: ['jo'] });
    assert.equal((await check(open)).statusCode, 403, 'nginx still asking about it: refused');
    assert.deepEqual(await admin({ op: 'route-area.set', routeId: 7, accounts: null }), { token: null, areaId: null, accounts: null, lost: [] });
    await setVisitorSwitch(sql, clock, 'openAreas', false, 'test', { mail: true });
  });

  // docs/roles-plan.md step 6 (S6-3): an app's pammy-panel.json on a route's area
  it("Read again on a route: the app's own set (app-route-<area>); guests practise, anyone signed in is Student", async () => {
    await switches(true);
    await setVisitorSwitch(sql, clock, 'roles', true, 'test', { mail: true });
    const made = await admin({ op: 'route-area.set', routeId: 9, accounts: 'open', address: `${HOST}/` });
    // exam prep's (web/pammy-panel.json on its nextjs branch), as the plan's example has it
    const manifest = readFileSync(join(import.meta.dirname, 'fixtures', 'examprep-pammy-panel.json'), 'utf8');
    const r = await admin({ op: 'access.manifest', areaId: made.areaId, text: manifest });
    assert.deepEqual(r.lost, []);
    const set = await one<{ key: string }>(sql, 'SELECT s.key FROM areas a JOIN role_sets s ON s.id = a.role_set_id WHERE a.id = ?', made.areaId);
    assert.equal(set?.key, `app-route-${made.areaId}`);
    const guest = await check(made.token);
    assert.equal(guest.statusCode, 204);
    assert.equal(guest.headers['x-pammy-role'], 'Not signed in');
    assert.equal(guest.headers['x-pammy-privileges'], 'attempts.create:own attempts.read:own attempts.submit:own attempts.update:own pages.read questions.read');
    const al_ = await check(made.token, alSession);
    assert.equal(al_.headers['x-pammy-role'], 'Student');
    assert.match(String(al_.headers['x-pammy-privileges']), /progress\.update:own/);
    // its roles are the app's now: not moved to a built-in set from the Hosts page
    await assert.rejects(admin({ op: 'route-area.set', routeId: 9, accounts: 'private', address: `${HOST}/` }), /come from its app's pammy-panel\.json/);
    // still open to anyone, so "Open with accounts" stays on
    await assert.rejects(setVisitorSwitch(sql, clock, 'openAreas', false, 'test', { mail: true }), /First take accounts off/);
    // and they go with the area
    await admin({ op: 'route-area.set', routeId: 9, accounts: null });
    assert.equal(await one(sql, 'SELECT 1 FROM role_sets WHERE key = ?', `app-route-${made.areaId}`), undefined);
    await setVisitorSwitch(sql, clock, 'roles', false, 'test', { mail: true });
    await setVisitorSwitch(sql, clock, 'openAreas', false, 'test', { mail: true });
  });

  it('answers from memory before Postgres is reached, for a route open to all', async () => {
    await switches(true);
    const made = await admin({ op: 'route-area.set', routeId: 8, accounts: 'open', address: `${HOST}/app/` });
    const early = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
    const cold = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock }, early);
    await cold.ready();
    const r = await cold.inject({ method: 'GET', url: `/check/${made.token}`, remoteAddress: '127.0.0.1', headers: { host: HOST } });
    assert.equal(r.statusCode, 204);
    assert.equal(r.headers['x-pammy-role'], 'Not signed in');
    await cold.close();
    await admin({ op: 'route-area.set', routeId: 8, accounts: null });
  });
});
