// Review P2 (docs/k-a-plan.md K-a3), every change to one visitor: with V's two sessions and
// another visitor's (B) already in memory, the change refuses or reloads V's, and B's is
// still answered from memory (no load). Owner side through the admin socket (switched off,
// deleted, signed out, a role given); the visitor's own through lfdln's gate (their password,
// a setup link used, deleting their account).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { handleAdmin } from '@panel/gate/admin';
import { buildGateApp } from '@panel/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { connectPg, one, type Sql } from '@panel/core/pg';
import { createLink } from '@panel/people/gate/links';
import { createVisitorSession } from '@panel/people/gate/sessions';
import { migrate } from '@panel/core/pg-migrate';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { startPg, type PgTest } from './pg-harness.ts';

const HOST = 'examprep.lesfleursdelanuit.com';
const COOKIE = LFDLN.services.gate!.cookie;
let pg: PgTest;
let root: string;
let direct: Sql;
let sql: Sql;
let live: GateLive;
let app: FastifyInstance;
let clock = 1_800_000_000;
const seen = { loads: 0 };
let n = 0;
let b = 0;
let bToken = '';
let area = 0;

const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: join(root, 'sites'), domain: LFDLN.domain, modules: LFDLN.modules, visitorMail: async () => {} }) as Promise<any>;
const who = async (token: string) => (await live.visitorForSession(token, HOST))?.visitor.username ?? null;
let ip = 0;
const post = (url: string, body: Record<string, unknown>, token?: string) => app.inject({
  method: 'POST', url, remoteAddress: '127.0.0.1',
  headers: {
    host: HOST, 'x-pammy-base': '/', origin: `https://${HOST}`, 'content-type': 'application/json', 'x-real-ip': `198.51.100.${(ip++ % 250) + 1}`,
    ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
  },
  payload: JSON.stringify(body),
});

before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'session-forget-'));
  mkdirSync(join(root, 'sites'), { recursive: true });
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  direct = pg.connect('gate', database, 2);
  const real = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 4, app: 'test-session-forget' });
  // loads counted by the query that starts one
  sql = new Proxy(real, {
    get(t, p) {
      if (p === 'unsafe') {
        return (text: string, ...rest: unknown[]) => {
          if (/FROM sessions WHERE token_hash/.test(text)) seen.loads++;
          return (t.unsafe as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock });
  live.markReady();
  await live.reloadAreas();
  app = buildGateApp(LFDLN, { publicRoot: join(root, 'sites'), domain: LFDLN.domain, now: () => clock }, live);
  await app.ready();
  for (const key of ['roles', 'changePassword', 'deleteAccount']) await admin({ op: 'visitor-settings.set', key, on: true, mail: true, actor: 'test' });
  area = (await admin({ op: 'area.create', path: 'members' })).id;
  b = (await admin({ op: 'visitor.create', username: 'bea', password: 'bea-password-123' })).id;
});
after(async () => {
  await app?.close();
  await Promise.all([sql?.end({ timeout: 1 }), direct?.end({ timeout: 1 })]);
  rmSync(root, { recursive: true, force: true });
  pg?.stop();
});

// V with two sessions and B with one, all three in memory
let v = 0, a1 = '', a2 = '', vName = '';
beforeEach(async () => {
  clock += 3600;
  vName = `v${++n}`;
  v = (await admin({ op: 'visitor.create', username: vName, password: `${vName}-password-123` })).id;
  a1 = await createVisitorSession(direct, clock, v, HOST, null);
  a2 = await createVisitorSession(direct, clock, v, HOST, null);
  bToken = await createVisitorSession(direct, clock, b, HOST, null);
  for (const t of [a1, a2, bToken]) await who(t);
});
// B's session from memory: answered, and nothing loaded
async function bStillKept() {
  const before = seen.loads;
  assert.equal(await who(bToken), 'bea');
  assert.equal(seen.loads, before, "B's session answered from memory");
}
async function vRefused() {
  assert.equal(await who(a1), null);
  assert.equal(await who(a2), null);
}

describe('review P2: a change to one visitor forgets only that visitor', () => {
  it('owner: switched off', async () => {
    await admin({ op: 'visitor.active', id: v, active: false });
    await bStillKept();
    await vRefused();
  });

  it('owner: deleted', async () => {
    await admin({ op: 'visitor.delete', id: v });
    await bStillKept();
    await vRefused();
  });

  it('owner: signed out everywhere', async () => {
    await admin({ op: 'visitor.signout', id: v });
    await bStillKept();
    await vRefused();
  });

  it('owner: a role given (access.person): V reloaded with it at once', async () => {
    const member = (await one<{ id: number }>(direct, "SELECT r.id FROM roles r JOIN areas a ON a.role_set_id = r.role_set_id WHERE a.id = ? AND r.key = 'member'", area))!.id;
    await admin({ op: 'access.person', areaId: area, visitorId: v, roleId: member });
    await bStillKept();
    const before = seen.loads;
    assert.ok((await live.visitorForSession(a1, HOST))?.opens.has(area));
    assert.ok((await live.visitorForSession(a2, HOST))?.opens.has(area));
    assert.equal(seen.loads, before + 2, "V's two sessions loaded again");
  });

  it('themselves: a new password (the session they use stays)', async () => {
    const r = await post('/_pammy/account/password', { current: `${vName}-password-123`, password: `${vName}-new-password-9` }, a1);
    assert.equal(r.statusCode, 200, r.body);
    await bStillKept();
    assert.equal(await who(a1), vName);
    assert.equal(await who(a2), null);
  });

  it('themselves: a setup link used (every other session ends)', async () => {
    const { token } = await createLink(direct, clock, v, null);
    const r = await post('/_pammy/invite', { token, password: `${vName}-chosen-password-7` });
    assert.equal(r.statusCode, 200, r.body);
    await bStillKept();
    await vRefused();
  });

  it('themselves: deleting their account', async () => {
    const r = await post('/_pammy/account/delete', { password: `${vName}-password-123` }, a1);
    assert.equal(r.statusCode, 200, r.body);
    await bStillKept();
    await vRefused();
  });

  it('anything else (an area changed) still forgets everyone, B included', async () => {
    await admin({ op: 'area.requests', id: area, open: false });
    const before = seen.loads;
    assert.equal(await who(bToken), 'bea');
    assert.equal(seen.loads, before + 1);
  });
});
