// The gate's visitor session cache (docs/k-a-plan.md K-a2): pinned before it moves from
// core's live.ts to people. A checked session is used from memory for SESSION_FRESH
// seconds; forgetting one token forgets only that one; a change (changed()) forgets
// everyone's; the host, the expiry, revocation and a switched-off visitor are checked
// on every answer, cached or not.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { GateLive } from '@panel/core/gate/live';
import { SESSION_FRESH, VisitorSessions, visitorSessions } from '@panel/people/gate/session-cache';
import { handleAdmin } from '@panel/gate/admin';
import { one, run, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { createArea, setMember } from '@panel/core/gate/store';
import { createVisitor } from '@panel/people/gate/visitors';
import { createVisitorSession } from '@panel/people/gate/sessions';
import { startPg, type PgTest } from './pg-harness.ts';

const HOST = 'pammy.org';
let pg: PgTest;
let db: Sql;
let clock = 1_800_000_000;
let live: GateLive;
let jo = 0, sam = 0, area = 0;

const fresh = () => new GateLive(db, { sessions: visitorSessions, now: () => clock });
const signedIn = async (token: string, host = HOST) => (await live.visitorForSession(token, host))?.visitor.username ?? null;

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('gate', database, 4);
  jo = (await createVisitor(db, clock, 'jo', '', 'jo-password-123')).id;
  sam = (await createVisitor(db, clock, 'sam', '', 'sam-password-123')).id;
  area = (await createArea(db, clock, 'family')).id;
  await setMember(db, clock, jo, area, true);
});
after(async () => {
  await db?.end({ timeout: 1 });
  pg?.stop();
});
beforeEach(() => {
  clock += 3600;
  live = fresh();
  live.markReady();
});

describe('the visitor session cache (pinned before K-a2 moves it to people)', () => {
  it('answers who is signed in, their roles, and which areas they may open', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    const a = await live.visitorForSession(t, HOST);
    assert.equal(a?.visitor.username, 'jo');
    assert.ok(a?.opens.has(area));
    assert.equal(a?.roles.get(area)?.role, 'Member');
    assert.equal(typeof a?.sessionId, 'number');
  });

  it('nobody for a missing, malformed or unknown token, or another host', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    assert.equal(await live.visitorForSession(null, HOST), null);
    assert.equal(await live.visitorForSession('nope', HOST), null);
    assert.equal(await live.visitorForSession('A'.repeat(43), HOST), null);
    assert.equal(await signedIn(t, 'family.pammy.org'), null);
    assert.equal(await signedIn(t), 'jo');
  });

  it('uses a checked session from memory for SESSION_FRESH seconds, then asks again', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    assert.equal(await signedIn(t), 'jo');
    await run(db, 'UPDATE sessions SET revoked_at = ? WHERE visitor_id = ?', clock, jo);
    assert.equal(await signedIn(t), 'jo', 'kept');
    clock += SESSION_FRESH - 1;
    assert.equal(await signedIn(t), 'jo', 'still fresh');
    clock += 1;
    assert.equal(await signedIn(t), null, 'asked again: revoked');
  });

  it('forgetSession forgets that token only', async () => {
    const a = await createVisitorSession(db, clock, jo, HOST, null);
    const b = await createVisitorSession(db, clock, sam, HOST, null);
    assert.equal(await signedIn(a), 'jo');
    assert.equal(await signedIn(b), 'sam');
    await run(db, 'UPDATE sessions SET revoked_at = ? WHERE visitor_id IN (?, ?)', clock, jo, sam);
    live.forgetSession(a);
    assert.equal(await signedIn(a), null, 'forgotten: asked again');
    assert.equal(await signedIn(b), 'sam', 'the other still from memory');
  });

  it('changed() forgets every session (today: anyone\'s change clears everyone\'s, review P2)', async () => {
    const a = await createVisitorSession(db, clock, jo, HOST, null);
    const b = await createVisitorSession(db, clock, sam, HOST, null);
    assert.equal(await signedIn(a), 'jo');
    assert.equal(await signedIn(b), 'sam');
    await run(db, 'UPDATE sessions SET revoked_at = ? WHERE visitor_id IN (?, ?)', clock, jo, sam);
    await live.changed();
    assert.equal(await signedIn(a), null);
    assert.equal(await signedIn(b), null);
  });

  it('a kept session past its expiry, or of someone switched off on reload, counts for nothing', async () => {
    const t = await createVisitorSession(db, clock, sam, HOST, null);
    assert.equal(await signedIn(t), 'sam');
    await run(db, 'UPDATE sessions SET expires_at = ? WHERE token_hash IS NOT NULL AND visitor_id = ?', clock + SESSION_FRESH + 10, sam);
    assert.equal(await signedIn(t), 'sam', 'kept: the old expiry');
    clock += SESSION_FRESH;
    assert.equal(await signedIn(t), 'sam', 'reloaded: expires in the future still');
    clock += 11;
    assert.equal(await signedIn(t), null, 'expired, even from memory');
    const u = await createVisitorSession(db, clock, sam, HOST, null);
    await run(db, 'UPDATE visitors SET active = 0 WHERE id = ?', sam);
    assert.equal(await signedIn(u), null);
    await run(db, 'UPDATE visitors SET active = 1 WHERE id = ?', sam);
  });

  it('notes when a session was last seen, at most every 5 minutes', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    const seen = async () => (await one<{ s: number }>(db, 'SELECT last_seen_at AS s FROM sessions WHERE visitor_id = ? ORDER BY id DESC LIMIT 1', jo))!.s;
    const start = clock;
    clock += 299;
    await signedIn(t);
    assert.equal(await seen(), start);
    clock += 1;
    live.forgetSession(t);
    await signedIn(t);
    assert.equal(await seen(), clock);
  });
});

// ------------------------------------------------------------------ review P2 (K-a3)
// Loads counted by the query that starts one (a session by its token's hash).
// opts.failFirst: the first load fails. opts.holdFirst: the first load, having read the
// session and the visitor, waits for it before reading their roles (its last query).
function counting(real: Sql, opts: { holdFirst?: Promise<void>; failFirst?: boolean } = {}) {
  const seen = { loads: 0, roles: 0 };
  const spy = new Proxy(real, {
    get(t, p) {
      if (p === 'unsafe') {
        return (text: string, ...rest: unknown[]) => {
          const query = () => (t.unsafe as (...a: unknown[]) => unknown)(text, ...rest);
          if (/JOIN role_sets s ON s.id = a.role_set_id/.test(text) && ++seen.roles === 1 && opts.holdFirst) return opts.holdFirst.then(query);
          if (!/FROM sessions WHERE token_hash/.test(text)) return query();
          seen.loads++;
          if (seen.loads === 1 && opts.failFirst) return Promise.reject(new Error('the first load fails'));
          return query();
        };
      }
      const v = Reflect.get(t, p) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { spy, seen };
}

describe('the session cache, review P2: single-flight, and forgetting only who changed', () => {
  let c: ReturnType<typeof counting>;
  let ready = true;
  let cache: VisitorSessions;
  beforeEach(() => {
    c = counting(db);
    ready = true;
    cache = new VisitorSessions({ db: c.spy, now: () => clock, ready: () => ready });
  });
  const who = async (token: string) => (await cache.visitorFor(token, HOST))?.visitor.username ?? null;

  it('40 lookups at once of one session not kept: one load, the same answer for all', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    const answers = await Promise.all(Array.from({ length: 40 }, () => who(t)));
    assert.deepEqual(new Set(answers), new Set(['jo']));
    assert.equal(c.seen.loads, 1);
    clock += SESSION_FRESH;           // expired in memory: the next 40 share one load again
    await Promise.all(Array.from({ length: 40 }, () => who(t)));
    assert.equal(c.seen.loads, 2);
  });

  it('while Postgres is not ready: nothing is loaded and nothing kept', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    ready = false;
    const all = await Promise.allSettled(Array.from({ length: 5 }, () => who(t)));
    assert.ok(all.every((r) => r.status === 'rejected'));
    ready = true;
    assert.equal(await who(t), 'jo');
    assert.equal(c.seen.loads, 1);
  });

  it('a load that fails is shared by those waiting, and not kept: the next lookup loads again', async () => {
    const failing = counting(db, { failFirst: true });
    const s = new VisitorSessions({ db: failing.spy, now: () => clock, ready: () => true });
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    const all = await Promise.allSettled(Array.from({ length: 5 }, () => s.visitorFor(t, HOST)));
    assert.ok(all.every((r) => r.status === 'rejected'));
    assert.equal(failing.seen.loads, 1);
    assert.equal((await s.visitorFor(t, HOST))?.visitor.username, 'jo');
    assert.equal(failing.seen.loads, 2);
  });

  it('a lookup after a visitor is forgotten never joins a load begun before (switched off: refused)', async () => {
    let release = () => {};
    const held = counting(db, { holdFirst: new Promise<void>((r) => { release = r; }) });
    const s = new VisitorSessions({ db: held.spy, now: () => clock, ready: () => true });
    const t = await createVisitorSession(db, clock, sam, HOST, null);
    try {
      const first = s.visitorFor(t, HOST);            // in flight: sam read while on, held before the roles
      while (held.seen.roles === 0) await new Promise((r) => setTimeout(r, 5));
      setTimeout(() => release(), 1000).unref();      // (joining the held load would wait for this)
      await run(db, 'UPDATE visitors SET active = 0 WHERE id = ?', sam);
      s.forgetVisitor(sam);
      const second = await s.visitorFor(t, HOST);     // must load anew, not join the first
      assert.equal(second, null);
      assert.equal(held.seen.loads, 2);
      release();
      assert.equal((await first)?.visitor.username, 'sam', 'began before the change: answered as then');
      assert.equal(await s.visitorFor(t, HOST), null);
    } finally {
      release();
      await run(db, 'UPDATE visitors SET active = 1 WHERE id = ?', sam);
    }
  });

  it('forgetVisitor forgets every session of that visitor, and nobody else\'s', async () => {
    const a1 = await createVisitorSession(db, clock, jo, HOST, null);
    const a2 = await createVisitorSession(db, clock, jo, HOST, null);
    const b = await createVisitorSession(db, clock, sam, HOST, null);
    for (const t of [a1, a2, b]) await who(t);
    assert.equal(c.seen.loads, 3);
    cache.forgetVisitor(jo);
    for (const t of [a1, a2, b]) await who(t);
    assert.equal(c.seen.loads, 5, "jo's two loaded again, sam's from memory");
  });

  it('a load in flight when its visitor changes is not kept', async () => {
    const t = await createVisitorSession(db, clock, jo, HOST, null);
    const pending = who(t);
    cache.forgetVisitor(jo);
    await pending;
    await who(t);
    assert.equal(c.seen.loads, 2);
  });

  it('a load in flight when its token is forgotten, or everything is, is not kept', async () => {
    const t = await createVisitorSession(db, clock, sam, HOST, null);
    let pending = who(t);
    cache.forget(t);
    await pending;
    await who(t);
    assert.equal(c.seen.loads, 2);
    clock += SESSION_FRESH;
    pending = who(t);
    cache.forgetAll();
    await pending;
    await who(t);
    assert.equal(c.seen.loads, 4);
  });

  it('through the gate: an owner changing one visitor (password, switch off, a role) forgets only that visitor', async () => {
    const counted = counting(db);
    const g = new GateLive(counted.spy, { sessions: visitorSessions, now: () => clock });
    g.markReady();
    const a = await createVisitorSession(db, clock, jo, HOST, null);
    const b = await createVisitorSession(db, clock, sam, HOST, null);
    const name = async (t: string) => (await g.visitorForSession(t, HOST))?.visitor.username ?? null;
    assert.equal(await name(a), 'jo');
    assert.equal(await name(b), 'sam');
    const admin = (req: Record<string, unknown>) => handleAdmin(g, clock, req as { op: string }, { publicRoot: null, domain: 'pammy.org' });
    await admin({ op: 'visitor.password', id: jo, password: 'jo-new-password-456' });
    assert.equal(await name(a), null, 'jo signed out everywhere');
    assert.equal(await name(b), 'sam');
    assert.equal(counted.seen.loads, 3, "sam's from memory");
    await admin({ op: 'grant', visitorId: sam, areaId: area, allow: true });
    assert.ok((await g.visitorForSession(b, HOST))?.opens.has(area), "sam's new role at once");
    assert.equal(counted.seen.loads, 4);
    // an area changed: everyone's (roles are kept per session)
    await admin({ op: 'area.requests', id: area, open: false });
    await name(b);
    assert.equal(counted.seen.loads, 5);
  });
});
