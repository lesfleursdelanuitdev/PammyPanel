// lfdln's gate (docs/accounts-plan.md step 3): @panel/gate with lfdln's profile. Only
// what its modules bring (areas, and people since step 4; requests, forms and the rest
// stay off), its own cookie, and the admin requests of modules it has off refused.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { handleAdmin } from '@panel/gate/admin';
import { buildGateApp } from '@panel/gate/app';
import { buildGateApp as buildPammyGate } from '@panel/pammy/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { connectPg, type Sql } from '@panel/core/pg';
import { createVisitorSession } from '@panel/people/gate/sessions';
import { migrate } from '@panel/core/pg-migrate';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { startPg, type PgTest } from './pg-harness.ts';

const HOST = 'examprep.lesfleursdelanuit.com';
let pg: PgTest;
let root: string;
let pub: string;
let sql: Sql;
let live: GateLive;
let app: FastifyInstance;
const routes: string[] = [];
const clock = 1_800_000_000;
const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: pub, domain: LFDLN.domain, modules: LFDLN.modules }) as Promise<any>;
const check = (uri: string, cookie?: string) => app.inject({
  method: 'GET', url: '/check', remoteAddress: '127.0.0.1',
  headers: { host: HOST, 'x-pammy-base': '/', 'x-pammy-uri': uri, 'x-pammy-next': uri, ...(cookie ? { cookie } : {}) },
});

before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'lfdln-gate-'));
  pub = join(root, 'sites');
  mkdirSync(join(pub, 'members'), { recursive: true });
  writeFileSync(join(pub, 'members', 'index.html'), 'members');
  writeFileSync(join(pub, 'index.html'), 'home');
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  sql = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 4, app: 'test-lfdln-gate' });
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
  live.markReady();
  await live.reloadAreas();
  app = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock }, live, { onRoute: (r: RouteOptions) => { routes.push(`${r.method} ${r.url}`); } });
  await app.ready();
});
after(async () => {
  await app?.close();
  await sql?.end({ timeout: 1 });
  rmSync(root, { recursive: true, force: true });
  await pg?.stop();
});

describe("lfdln's gate", () => {
  it('has the check, the component files and the built-in pages, and nothing of the modules lfdln has off', () => {
    // people (step 4: signing in, and the accounts)
    for (const r of ['GET /check', 'GET /_pammy/login.js', 'GET /_pammy/login', 'POST /_pammy/login', 'GET /_pammy/me', 'POST /_pammy/register', 'GET /_pammy/account']) assert.ok(routes.includes(r), r);
    // requests (roles plan step 6: on lfdln too, for a route's "ask for access")
    for (const r of ['POST /_pammy/request', 'POST /_pammy/forgot']) assert.ok(routes.includes(r), r);
    // the media API and its thumbnails (docs/phase8-plan.md step 8-3)
    for (const r of ['GET /_pammy/api/media/*', 'GET /_pammy/media-thumbs/:name']) assert.ok(routes.includes(r), r);
    // forms, comments, the examples, the responses and data APIs
    // the data API (step 8-4)
    assert.ok(routes.some((r) => r.split(' ')[1]!.startsWith('/_pammy/api/data/')));
    // forms, the responses API and the preview (step 8-5)
    for (const r of ['GET /_pammy/forms.js', 'GET /_pammy/forms/:name', 'POST /_pammy/forms/:name', 'GET /_pammy/form-preview']) assert.ok(routes.includes(r), r);
    assert.ok(routes.some((r) => r.split(' ')[1]!.startsWith('/_pammy/api/forms/')));
    // comments (step 8-6)
    for (const r of ['GET /_pammy/comments.js', 'GET /_pammy/comments/:name', 'GET /_pammy/comments/:name/form', 'POST /_pammy/comments/:name', 'GET /_pammy/comments/:name/counts']) assert.ok(routes.includes(r), r);
    for (const gone of ['/_pammy/examples/']) {
      assert.ok(!routes.some((r) => r.split(' ')[1]!.startsWith(gone)), gone);
    }
  });

  it("pammy.org's gate still has them all", async () => {
    const seen: string[] = [];
    const p = buildPammyGate({ publicRoot: pub, domain: 'pammy.org', now: () => clock, mediaIndex: join(root, 'none.db'), mediaThumbs: join(root, 'thumbs') }, live,
      { onRoute: (r: RouteOptions) => { seen.push(`${r.method} ${r.url}`); } });
    await p.ready();
    for (const r of ['POST /_pammy/login', 'GET /_pammy/me', 'POST /_pammy/request', 'GET /_pammy/examples/*', 'GET /_pammy/form-preview']) assert.ok(seen.includes(r), r);
    await p.close();
  });

  it('answers only for its own domain', async () => {
    assert.equal((await check('/index.html')).statusCode, 204);
    const other = await app.inject({ method: 'GET', url: '/check', remoteAddress: '127.0.0.1', headers: { host: 'pammy.org', 'x-pammy-base': '/', 'x-pammy-uri': '/index.html' } });
    assert.equal(other.statusCode, 403);
  });

  // docs/phase8-plan.md 8-2: every name a host answers to, on every domain, from the
  // routing helper's gate-routes.json; nothing else
  it("with the routes: another domain's hosts too, and still nothing else", async () => {
    const { SiteRoutes } = await import('@panel/core/gate/site-routes');
    const f = join(root, 'gate-routes.json');
    writeFileSync(f, JSON.stringify({ v: 1, domains: ['lesfleursdelanuit.com', 'gonsalvesfamily.com'], hosts: {
      'admin.gonsalvesfamily.com': [{ path: '/', kind: 'service', service: 'gonsalves', area: null }],
    } }));
    const routed = new GateLive(sql, { sessions: visitorSessions, now: () => clock, routes: new SiteRoutes(f) });
    routed.markReady();
    await routed.reloadAreas();
    const r = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock }, routed);
    const me = (host: string) => r.inject({ method: 'GET', url: '/_pammy/me', remoteAddress: '127.0.0.1', headers: { host, 'x-pammy-base': '/' } });
    try {
      assert.equal((await me('admin.gonsalvesfamily.com')).statusCode, 200);
      // the media API (docs/phase8-plan.md 8-3): no main site's media folder, no example folder
      for (const where of ['main/t/summer', 'example/t/summer']) {
        const m = await r.inject({ method: 'GET', url: `/_pammy/api/media/${where}`, remoteAddress: '127.0.0.1', headers: { host: HOST, 'x-pammy-base': '/' } });
        assert.deepEqual([m.statusCode, m.json().error], [404, 'bad-address'], where);
      }
      assert.equal((await me(HOST)).statusCode, 200, 'its own domain as before');
      assert.equal((await me('gonsalvesfamily.com')).statusCode, 400, 'a name no host answers to');
      assert.equal((await me('pammy.org')).statusCode, 400);
      assert.equal((await app.inject({ method: 'GET', url: '/_pammy/me', remoteAddress: '127.0.0.1', headers: { host: 'admin.gonsalvesfamily.com' } })).statusCode, 400, 'without the routes: its own domain only');
    } finally { await r.close(); }
  });

  it('refuses the admin requests of modules lfdln has off, and answers its own', async () => {
    for (const op of ['examples.state', 'comments.example']) {
      await assert.rejects(admin({ op, id: 1 }), /Unknown request/, op);
    }
    // form links (step 8-6): on here, for a form that saves into a Studio database
    assert.deepEqual(await admin({ op: 'formlinks.for-database', databaseId: 1 }), { links: [] });
    assert.deepEqual(Object.values(await admin({ op: 'visitor-settings.get' })).filter((v) => v === true), []);
    assert.deepEqual((await admin({ op: 'state' })).areas, []);
    // API keys (step 8-3): on here, for the media API
    assert.ok(Array.isArray((await admin({ op: 'apikeys.list' })).keys));
    assert.deepEqual(await admin({ op: 'housekeeping' }), { ok: true });
  });

  it("uses its own cookie: pammy.org's never opens anything here", async () => {
    const a = await admin({ op: 'area.create', path: 'members' });
    writeFileSync(join(pub, 'members', '.pammy-protected'), `pammy-protected ${a.token}\n`);
    const v = await admin({ op: 'visitor.create', username: 'jo', password: 'jo-password-123' });
    await admin({ op: 'grant', visitorId: v.id, areaId: a.id, allow: true });
    const token = await createVisitorSession(sql, clock, v.id, HOST, '198.51.100.9');
    assert.equal((await check('/members/index.html')).statusCode, 401);
    assert.equal((await check('/members/index.html', `__Host-pammy_visitor=${token}`)).statusCode, 401);
    const own = await check('/members/index.html', `__Host-lfdln_visitor=${token}`);
    assert.equal(own.statusCode, 204);
    assert.equal(own.headers['x-pammy-user'], 'jo');
  });
});
