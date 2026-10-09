// The gate while Postgres is away (docs/postgres-plan.md P14, option b; live.ts):
// her site keeps working from memory, signed-in visitors keep going for a while,
// and whatever needs the database says "try again in a minute". Plus the races
// Postgres brings (P11): two requests after the same name, exactly one wins.
//
// Postgres "goes away" by cutting a relay between the gate and the test
// container, so the gate sees what it would see: connections refused and dropped.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { handleAdmin } from '@panel/pammy/gate/admin';
import { buildGateApp } from '@panel/pammy/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { SESSION_FRESH, SESSION_STALE, visitorSessions } from '@panel/people/gate/session-cache';
import { connectPg, one, run, type Sql } from '@panel/core/pg';
import { rolesOf } from '@panel/core/gate/store';
import { migrate } from '@panel/core/pg-migrate';
import { seedGate } from './gate-seed.ts';
import { startPg, type PgTest } from './pg-harness.ts';

// ------------------------------------------------------------------ a relay that can be cut
class Relay {
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  port = 0;
  target: number;
  constructor(target: number) { this.target = target; }
  async up() {
    const server = createServer((c) => {
      const s = connect(this.target, '127.0.0.1');
      for (const x of [c, s]) { this.#sockets.add(x); x.on('close', () => this.#sockets.delete(x)); x.on('error', () => {}); }
      c.pipe(s).pipe(c);
    });
    await new Promise<void>((r) => server.listen(this.port, '127.0.0.1', r));
    this.port = (server.address() as { port: number }).port;
    this.#server = server;
  }
  async down() {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    this.#server = null;
  }
}

let pg: PgTest;
let root: string;
let pub: string;
let database: string;
let relay: Relay;
let sql: Sql;           // the gate's, through the relay
let direct: Sql;        // the test's own, straight to Postgres
let live: GateLive;
let app: FastifyInstance;
let clock = 1_800_000_000;
const snapshot = () => join(root, 'areas.json');
const gateSql = (port: number) => connectPg({ role: 'gate', password: pg.passwords.gate, port, database, max: 4, app: 'test-gate' });
const admin = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }) as Promise<any>;
const file = (rel: string) => { mkdirSync(join(pub, rel, '..'), { recursive: true }); writeFileSync(join(pub, rel), rel); };

async function check(a: FastifyInstance, uri: string, cookie?: string) {
  const res = await a.inject({
    method: 'GET', url: '/check', remoteAddress: '127.0.0.1',
    headers: { host: 'pammy.org', 'x-pammy-base': '/', 'x-pammy-uri': uri, 'x-pammy-next': uri, ...(cookie ? { cookie } : {}) },
  });
  return res.statusCode;
}
async function signIn(a: FastifyInstance, username: string, password: string, area: string) {
  const res = await a.inject({
    method: 'POST', url: '/_pammy/login', remoteAddress: '127.0.0.1',
    headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': '198.51.100.9' },
    payload: JSON.stringify({ username, password, area }),
  });
  return { status: res.statusCode, cookie: res.headers['set-cookie'] ? String(res.headers['set-cookie']).split(';')[0]! : undefined };
}
const buildApp = (l: GateLive) => buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(root, 'none.db'), mediaThumbs: join(root, 'thumbs') }, l);

let token = '';
before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'pammy-gate-live-'));
  pub = join(root, 'public');
  file('index.html'); file('open/page.html'); file('family/index.html'); file('family/photo.jpg'); file('family/login.html');
  database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  direct = gateSql(pg.port);
  await seedGate(direct, clock);
  relay = new Relay(pg.port);
  await relay.up();
  sql = gateSql(relay.port);
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: snapshot() });
  live.markReady();
  await live.reloadAreas();
  app = buildApp(live);
  const a = await admin({ op: 'area.create', path: 'family' });
  token = a.token;
  writeFileSync(join(pub, 'family', '.pammy-protected'), `pammy-protected ${a.token}\n`);
  for (const u of ['jo', 'sam']) {
    const v = await admin({ op: 'visitor.create', username: u, password: `${u}-password-123` });
    await admin({ op: 'grant', visitorId: v.id, areaId: a.id, allow: true });
  }
});
after(async () => {
  await app?.close();
  await relay?.down();
  await Promise.all([sql?.end({ timeout: 1 }), direct?.end({ timeout: 1 })]);
  pg?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('while Postgres is away', () => {
  it('her site keeps working, a visitor checked lately keeps going, anything needing the database says try again', async () => {
    const jo = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(jo.status, 200);
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 204);
    const sam = await signIn(app, 'sam', 'sam-password-123', token);     // signed in, never checked

    await relay.down();
    clock += SESSION_FRESH + 5;          // past fresh: it would ask Postgres now if it could
    for (const u of ['/', '/index.html', '/open/page.html', '/nope.html']) assert.equal(await check(app, u), 204, u);
    assert.equal(await check(app, '/family/photo.jpg'), 401, 'signed out: still asked to sign in');
    assert.equal(await check(app, '/family/login.html'), 204, 'the sign-in page itself');
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 204, 'jo was checked a minute ago');
    assert.equal(await check(app, '/family/photo.jpg', sam.cookie), 503, 'sam was never checked: nobody can say');
    const login = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(login.status, 503);
    const form = await app.inject({ method: 'GET', url: '/_pammy/forms/example-guest-book?page=/open/page.html', headers: { host: 'pammy.org', 'x-pammy-base': '/' } });
    assert.deepEqual([form.statusCode, form.json().error], [503, 'unavailable']);
    await assert.rejects(admin({ op: 'state' }), (e: { code: string; message: string }) => e.code === 'unavailable' && /try again in a minute/.test(e.message));

    clock += SESSION_STALE;              // a long outage: jo's check is too old to trust now
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 503);
    assert.equal(await check(app, '/open/page.html'), 204, 'unprotected pages still never ask');

    await relay.up();
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 204);
    assert.equal(await check(app, '/family/photo.jpg', sam.cookie), 204);
    assert.equal((await signIn(app, 'jo', 'jo-password-123', token)).status, 200);
  });

  it('starts before Postgres: from the areas it saved last time, or 503 for folders if it never saved any', async () => {
    await relay.down();
    const early = new GateLive(gateSql(relay.port), { sessions: visitorSessions, now: () => clock, snapshot: snapshot() });
    const earlyApp = buildApp(early);
    assert.equal(early.ready, false);
    assert.equal(await check(earlyApp, '/open/page.html'), 204);
    assert.equal(await check(earlyApp, '/family/photo.jpg'), 401, 'still protected, from the saved copy');
    const me = await earlyApp.inject({ method: 'GET', url: '/_pammy/me', headers: { host: 'pammy.org' } });
    assert.equal(me.statusCode, 503);

    const blank = new GateLive(gateSql(relay.port), { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'never-saved.json') });
    const blankApp = buildApp(blank);
    assert.equal(await check(blankApp, '/family/photo.jpg'), 503, 'no guessing');
    assert.equal(await check(blankApp, '/open/page.html'), 503, 'a folder the database might protect');

    // it keeps trying, and is ready once Postgres answers
    await relay.up();
    early.start();
    for (let i = 0; i < 100 && !early.ready; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(early.ready, true);
    assert.equal((await earlyApp.inject({ method: 'GET', url: '/_pammy/me', headers: { host: 'pammy.org' } })).statusCode, 200);
    early.stop();
    await Promise.all([earlyApp.close(), buildApp(blank).close(), early.db.end({ timeout: 1 }), blank.db.end({ timeout: 1 })]);
  });
});

describe('what is kept in memory never outlives a change', () => {
  it('signing someone out, switching them off or taking their access away works at once', async () => {
    const jo = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 204);
    const v = (await admin({ op: 'state' })).visitors.find((x: { username: string }) => x.username === 'jo');
    await admin({ op: 'visitor.signout', id: v.id });
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 401);

    const again = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(await check(app, '/family/photo.jpg', again.cookie), 204);
    const area = (await admin({ op: 'state' })).areas[0];
    await admin({ op: 'grant', visitorId: v.id, areaId: area.id, allow: false });
    assert.equal(await check(app, '/family/photo.jpg', again.cookie), 401);
    await admin({ op: 'grant', visitorId: v.id, areaId: area.id, allow: true });
  });

  it('a change made by hand in Postgres counts within a minute', async () => {
    const jo = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 204);
    await run(direct, "UPDATE sessions SET revoked_at = ? WHERE visitor_id = (SELECT id FROM visitors WHERE username = 'jo')", clock);
    clock += SESSION_FRESH;
    assert.equal(await check(app, '/family/photo.jpg', jo.cookie), 401);
  });

  it('saves the areas for the next start, readable only by the gate', async () => {
    const { statSync, readFileSync } = await import('node:fs');
    assert.equal(statSync(snapshot()).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(snapshot(), 'utf8')).areas.map((a: { path: string }) => a.path), ['family']);
  });
});

describe('two requests at once (P11)', () => {
  it('after the same username: exactly one wins', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => admin({ op: 'visitor.create', username: 'twin', password: 'twin-password-1' })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal((r as PromiseRejectedResult).reason.code, 'exists');
  });

  it('after the same form name: exactly one wins, and the others are told why', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => admin({ op: 'form.create', name: 'twin-form', items: [] })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal((r as PromiseRejectedResult).reason.code, 'exists', String((r as PromiseRejectedResult).reason));
  });

  it('protecting the same folder twice: one area', async () => {
    const results = await Promise.allSettled([1, 2].map(() => admin({ op: 'area.create', path: 'open' })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await one<{ n: number }>(direct, "SELECT count(*) AS n FROM areas WHERE path = 'open'"))!.n, 1);
  });

  it('the same person asking for access twice at once: one request', async () => {
    const send = () => app.inject({
      method: 'POST', url: '/_pammy/request', remoteAddress: '127.0.0.1',
      headers: { host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'content-type': 'application/json', 'x-real-ip': '198.51.100.20' },
      payload: JSON.stringify({ area: token, name: 'Rose', contact: 'rose@example.com', message: 'hello' }),
    });
    const codes = (await Promise.all([send(), send()])).map((r) => r.statusCode);
    assert.deepEqual(codes, [200, 200]);
    assert.equal((await one<{ n: number }>(direct, "SELECT count(*) AS n FROM requests WHERE name = 'Rose'"))!.n, 1);
  });
});

// docs/roles-plan.md step 2: the gate works from roles now. A protected folder's
// Member opens it (the grants of old); a set's "signed in, no role given" slot
// counts for everyone signed in; a role without pages.read opens nothing.
describe('roles', () => {
  it('a session carries each area\'s role and privileges, and pages.read decides who opens a folder', async () => {
    file('club/index.html');
    const club = await admin({ op: 'area.create', path: 'club' });
    writeFileSync(join(pub, 'club', '.pammy-protected'), `pammy-protected ${club.token}\n`);
    const jo = await signIn(app, 'jo', 'jo-password-123', token);
    assert.equal(jo.status, 200);
    assert.equal(await check(app, '/club/index.html', jo.cookie), 401, 'no role in club: the built-in set gives the signed-in nothing (the sign-in page, marked denied)');
    const joId = (await one<{ id: number }>(direct, "SELECT id FROM visitors WHERE username = 'jo'"))!.id;
    const family = (await rolesOf(direct, joId)).get((await one<{ id: number }>(direct, "SELECT id FROM areas WHERE path = 'family'"))!.id);
    assert.deepEqual(family && { role: family.role, privileges: [...family.privileges] }, { role: 'Member', privileges: ['pages.read'] });

    // a set of club's own whose "signed in" slot is a role that opens it
    const [set] = await direct`INSERT INTO role_sets (label, created_at) VALUES ('Club', 1) RETURNING id`;
    const [guest] = await direct`INSERT INTO roles (role_set_id, key, label) VALUES (${set!.id}, 'guest', 'Guest') RETURNING id`;
    const [looker] = await direct`INSERT INTO roles (role_set_id, key, label) VALUES (${set!.id}, 'looker', 'Looker') RETURNING id`;
    await direct`INSERT INTO role_privileges (role_id, privilege) VALUES (${guest!.id}, 'pages.read'), (${guest!.id}, 'notes.read:own'), (${looker!.id}, 'notes.read:any')`;
    await direct`UPDATE role_sets SET signed_in_role_id = ${guest!.id} WHERE id = ${set!.id}`;
    await direct`UPDATE areas SET role_set_id = ${set!.id} WHERE id = ${club.id}`;
    await live.changed();
    assert.equal(await check(app, '/club/index.html', jo.cookie), 204, 'signed in, no role given: Guest');
    assert.deepEqual([...(await rolesOf(direct, joId, club.id)).get(club.id)!.privileges], ['notes.read:own', 'pages.read']);

    // a role given there wins over the slot, and this one doesn't open the pages
    await direct`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${joId}, ${club.id}, ${set!.id}, ${looker!.id}, 1)`;
    await live.changed();
    assert.equal(await check(app, '/club/index.html', jo.cookie), 401, 'Looker: no pages.read');
    assert.equal((await rolesOf(direct, joId, club.id)).get(club.id)!.role, 'Looker');
    assert.equal(await check(app, '/club/index.html'), 401, 'signed out: asked to sign in, as before');
  });
});
