// Deleted accounts passed on to the apps (docs/accounts-plan.md Q1, step 4b): every way an
// account goes is noted by the gate (areas/0006's trigger), the panel tells each service behind
// a route with accounts that has the hook, signed with its key, and tries again later when one
// doesn't answer; the gate forgets a deletion once all have, or after 30 days. nginx never lets
// /_lfdln/ in from outside, and no route may be there.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { handleAdmin } from '@panel/gate/admin';
import { gateHousekeeping } from '@panel/gate/housekeeping';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { all, connectPg, one, run, type Sql } from '@panel/core/pg';
import { deleteOwnAccount } from '@panel/people/gate/self-service';
import { migrate } from '@panel/core/pg-migrate';
import { routePath } from '@panel/hosts/names';
import { backoff, DELETIONS_KEPT } from '@panel/areas/gate/deletions';
import { deletionTargets, passOnDeletions, type DeletionDeps } from '@panel/services/panel/account-deleted';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let gateSql: Sql;
let owner: Sql;
let live: GateLive;
let root: string;
// the trigger stamps the database's own time: the test's clock starts there too
let clock = Math.floor(Date.now() / 1000);
const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: null, domain: LFDLN.domain, modules: LFDLN.modules }) as Promise<any>;
const kept = async () => [...await all<{ visitor_id: number; username: string; told: string[]; tries: number; next_at: number; last_error: string | null }>(gateSql,
  'SELECT visitor_id, username, told, tries, next_at, last_error FROM deleted_accounts ORDER BY visitor_id')];
let n = 0;
const catchUp = () => { clock = Math.max(clock, Math.floor(Date.now() / 1000) + 2); };
const person = async () => (await admin({ op: 'visitor.create', username: `p${++n}x`, password: 'a-long-password-123' })) as { id: number; username: string };
const PORTS = [{ service: 'examprep', part: 'web', title: 'Exam prep', port: 4101 }, { service: 'tutorstar', part: 'web', title: 'TutorStar', port: 3041 }];

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  owner = pg.connect('owner', database, 2);
  await migrate(owner);
  gateSql = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 2, app: 'test-deletions' });
  root = mkdtempSync(join(tmpdir(), 'deletions-'));
  live = new GateLive(gateSql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
  live.markReady();
  await live.reloadAreas();
  writeFileSync(join(root, 'examprep.key'), 'k'.repeat(44) + '\n');
  // a host whose top is exam prep, open with accounts; TutorStar behind a route without accounts
  const h = (await one<{ id: number }>(owner, "INSERT INTO panel.hosts (name, created_at) VALUES ('examprep', 1) RETURNING id"))!;
  await run(owner, `INSERT INTO panel.routes (host_id, path, target_kind, target_ref, area_token, accounts, created_at) VALUES (?, '/', 'service', '{"service":"examprep","part":"web","websockets":true,"maxBodyMb":null,"signInPaths":[]}', ?, 'open', 1)`, h.id, 'a'.repeat(32));
  const t = (await one<{ id: number }>(owner, "INSERT INTO panel.hosts (name, created_at) VALUES ('tutor', 1) RETURNING id"))!;
  await run(owner, `INSERT INTO panel.routes (host_id, path, target_kind, target_ref, created_at) VALUES (?, '/', 'service', '{"service":"tutorstar","part":"web","websockets":true,"maxBodyMb":null,"signInPaths":[]}', 1)`, t.id);
});
after(async () => {
  await gateSql?.end({ timeout: 1 });
  await owner?.end({ timeout: 1 });
  rmSync(root, { recursive: true, force: true });
  await pg?.stop();
});

// the panel's side, with a stand-in for the app
function deps(answer: (url: string, init: RequestInit) => number, seen: { url: string; headers: Record<string, string>; body: string }[] = []): DeletionDeps {
  return {
    db: owner, now: () => clock, keyFile: (s) => join(root, `${s}.key`),
    gate: (req) => admin(req),
    ports: async () => PORTS,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('{}', { status: answer(url, init) });
    }) as typeof fetch,
  };
}

describe('the gate notes every deleted account', () => {
  it('an owner deleting one, and the person deleting their own', async () => {
    const a = await person(), b = await person();
    await admin({ op: 'visitor.delete', id: a.id });
    await deleteOwnAccount(gateSql, b.id, 'a-long-password-123');
    const rows = (await kept()).filter((r) => r.visitor_id === a.id || r.visitor_id === b.id);
    assert.deepEqual(rows.map((r) => [r.visitor_id, r.username, r.told, r.tries]), [[a.id, a.username, [], 0], [b.id, b.username, [], 0]]);
    await run(gateSql, 'DELETE FROM deleted_accounts');
  });

  it('an unconfirmed account removed after 48 hours', async () => {
    const c = await person();
    await run(gateSql, 'UPDATE visitors SET registered = true, email_confirmed_at = NULL, created_at = ? WHERE id = ?', clock - 3 * 86400, c.id);
    await gateHousekeeping(gateSql, clock, LFDLN.modules);
    assert.deepEqual((await kept()).map((r) => r.visitor_id), [c.id]);
    await run(gateSql, 'DELETE FROM deleted_accounts');
  });

  it('forgotten after 30 days, told or not', async () => {
    const d = await person();
    await admin({ op: 'visitor.delete', id: d.id });
    await run(gateSql, 'UPDATE deleted_accounts SET deleted_at = ?', clock - DELETIONS_KEPT - 1);
    await gateHousekeeping(gateSql, clock, LFDLN.modules);
    assert.deepEqual(await kept(), []);
  });
});

describe('the panel passes them on', () => {
  it('only to services behind a route with accounts that have the hook', async () => {
    assert.deepEqual(await deletionTargets(owner, PORTS), [{ service: 'examprep', title: 'Placement Exam Prep', url: 'http://127.0.0.1:4101/_lfdln/account-deleted' }]);
    assert.deepEqual(await deletionTargets(owner, []), [], 'a part the helper has no port for is left out');
  });

  it('signed with the service\'s key; told, the gate forgets it', async () => {
    const e = await person();
    await admin({ op: 'visitor.delete', id: e.id });
    catchUp();
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    assert.deepEqual(await passOnDeletions(deps(() => 200, seen)), { done: 1, waiting: 0 });
    assert.equal(seen.length, 1);
    const [s] = seen;
    assert.equal(s!.url, 'http://127.0.0.1:4101/_lfdln/account-deleted');
    assert.deepEqual(JSON.parse(s!.body), { account: e.id, deletedAt: JSON.parse(s!.body).deletedAt });
    const ts = s!.headers['X-Lfdln-Timestamp']!;
    assert.match(ts, /^\d{13}$/);
    assert.equal(s!.headers['X-Lfdln-Signature'], 'v1=' + createHmac('sha256', 'k'.repeat(44)).update(`${ts}.${s!.body}`).digest('hex'));
    assert.deepEqual(await kept(), []);
  });

  it('not answering: kept, tried again later (a minute, five, half an hour, then every six hours)', async () => {
    const f = await person();
    await admin({ op: 'visitor.delete', id: f.id });
    catchUp();
    assert.deepEqual(await passOnDeletions(deps(() => 503)), { done: 0, waiting: 1 });
    let [r] = await kept();
    assert.equal(r!.tries, 1);
    assert.equal(r!.next_at, clock + backoff(0));
    assert.equal(r!.last_error, 'Placement Exam Prep: answered 503');
    // not due yet: nobody is asked
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    await passOnDeletions(deps(() => 200, seen));
    assert.equal(seen.length, 0);
    assert.deepEqual([backoff(0), backoff(1), backoff(2), backoff(3), backoff(9)], [60, 300, 1800, 21600, 21600]);
    // due, and it answers
    clock += 61;
    assert.deepEqual(await passOnDeletions(deps(() => 200)), { done: 1, waiting: 0 });
    assert.deepEqual(await kept(), []);
    [r] = await kept();
    assert.equal(r, undefined);
  });

  it('no key for the service: kept, and the People page says why', async () => {
    const g = await person();
    await admin({ op: 'visitor.delete', id: g.id });
    catchUp();
    rmSync(join(root, 'examprep.key'));
    try {
      await passOnDeletions(deps(() => 200));
      assert.equal((await kept())[0]!.last_error, 'Placement Exam Prep: no key (examprep.key)');
    } finally {
      writeFileSync(join(root, 'examprep.key'), 'k'.repeat(44) + '\n');
      await run(gateSql, 'DELETE FROM deleted_accounts');
    }
  });

  it('no service to tell (pammy.org, or none with the hook): done at once', async () => {
    const h = await person();
    await admin({ op: 'visitor.delete', id: h.id });
    catchUp();
    await passOnDeletions({ ...deps(() => 500), ports: async () => [] });
    assert.deepEqual(await kept(), []);
  });

  it('the gate refuses what isn\'t a list of services', async () => {
    await assert.rejects(admin({ op: 'deletions.told', id: 1, told: ['../x'], done: false }), /Told/);
    await assert.rejects(admin({ op: 'deletions.told', id: 'x', told: [], done: true }), /Which/);
  });
});

describe('/_lfdln/ is the panel\'s', () => {
  it('no route may be there', () => {
    assert.throws(() => routePath('/_lfdln/'), /kept for the panel/);
    assert.throws(() => routePath('/_lfdln/x/'), /kept for the panel/);
    assert.equal(routePath('/_lfdlnx/'), '/_lfdlnx/');
  });
});
