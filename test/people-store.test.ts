// K-a4 (docs/k-a-plan.md, "Tests that pin behaviour before each move"): what people's store
// does that no other test pins, written before it moves out of core and passing on both
// sides of the move.
//   - A password chosen with a link closes that person's open "forgot my password"
//     requests (the setup link and the emailed reset link), in the same transaction: a
//     refused password closes nothing, and nobody else's request is touched.
//   - The dummy hash: a wrong username, a malformed one and an account with no password
//     yet still run scrypt once, as a wrong password does, so the time taken doesn't say
//     whether the account exists. ESM bindings can't be spied on, so the spy is on
//     node:crypto's scrypt, the one thing verifyPassword does that takes time.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { handleAdmin } from '@panel/gate/admin';
import { buildGateApp } from '@panel/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import type { VisitorMail } from '@panel/core/gate/context';
import { all, connectPg, run, type Sql } from '@panel/core/pg';
import { addResetRequest } from '@panel/core/gate/store';
import { checkCredentials, signInCheck } from '@panel/people/gate/sign-in-check';
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
let clock = 1_800_000_000;
let sent: VisitorMail[] = [];
const mailer = async (m: VisitorMail) => { sent.push(m); };
const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: pub, domain: LFDLN.domain, modules: LFDLN.modules, visitorMail: mailer }) as Promise<any>;
let ipN = 0;
async function post(url: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url, remoteAddress: '127.0.0.1',
    headers: {
      host: HOST, 'x-pammy-base': '/', origin: `https://${HOST}`, 'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipN++ % 250) + 1}`,
    },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.body ? res.json() : null };
}
const tokenOf = (link: string | undefined) => link!.split('#')[1]!;
type Row = { username: string; status: string; handled_at: number | null; handled_by: string | null };
const resetRequests = async () => [...await all<Row>(sql,
  "SELECT name AS username, status, handled_at, handled_by FROM requests WHERE kind = 'reset' ORDER BY id")];

let kit = 0;
let lee = 0;

before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'people-store-'));
  pub = join(root, 'sites');
  mkdirSync(join(pub, 'members'), { recursive: true });
  writeFileSync(join(pub, 'members', 'index.html'), 'members');
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  sql = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 4, app: 'test-people-store' });
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
  live.markReady();
  await live.reloadAreas();
  app = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock, visitorMail: mailer }, live);
  await app.ready();
  kit = (await admin({ op: 'visitor.create', username: 'kit', password: null })).id;
  lee = (await admin({ op: 'visitor.create', username: 'lee', password: 'lee-password-123' })).id;
});
after(async () => {
  await app?.close();
  await sql?.end({ timeout: 1 });
  rmSync(root, { recursive: true, force: true });
  await pg?.stop();
});
beforeEach(() => {
  sent = [];
  clock += 7200;
});

describe('a password chosen with a link closes their open reset requests (KA-Q2)', () => {
  it('the setup link: kit\'s request is done, by "they chose a new password"; lee\'s stays open', async () => {
    assert.ok(await addResetRequest(sql, clock, null, 'kit', 'locked out', 'pammy.org', null));
    assert.ok(await addResetRequest(sql, clock, null, 'lee', 'me too', 'pammy.org', null));
    const area = await admin({ op: 'area.create', path: 'members' });
    const link = await admin({ op: 'link.create', visitorId: kit, areaId: area.id });
    const token = tokenOf(link.url);
    // a refused password: nothing is used up, nothing closes
    assert.equal((await post('/_pammy/invite', { token, password: 'password1234' })).status, 400);
    assert.deepEqual((await resetRequests()).map((r) => r.status), ['open', 'open']);
    const used = await post('/_pammy/invite', { token, password: 'kit-password-123' });
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.deepEqual(await resetRequests(), [
      { username: 'kit', status: 'done', handled_at: clock, handled_by: 'they chose a new password' },
      { username: 'lee', status: 'open', handled_at: null, handled_by: null },
    ]);
  });

  it('the emailed reset link: the same', async () => {
    await admin({ op: 'visitor-settings.set', key: 'emailedLinks', on: true, mail: true, actor: 'momolig' });
    await run(sql, "UPDATE visitors SET email = 'kit@example.org' WHERE id = ?", kit);
    assert.ok(await addResetRequest(sql, clock, null, 'kit', 'again', 'pammy.org', null));
    assert.equal((await post('/_pammy/reset-link', { login: 'kit' })).status, 200);
    assert.deepEqual([sent.length, sent[0]?.kind], [1, 'reset']);
    const token = tokenOf(sent[0]!.link);
    assert.equal((await post('/_pammy/reset', { token, password: 'password1234' })).status, 400);
    assert.deepEqual((await resetRequests()).map((r) => r.status), ['done', 'open', 'open']);
    const used = await post('/_pammy/reset', { token, password: 'kit-password-456' });
    assert.equal(used.status, 200, JSON.stringify(used.json));
    const rows = await resetRequests();
    assert.deepEqual(rows.slice(1), [
      { username: 'lee', status: 'open', handled_at: null, handled_by: null },
      { username: 'kit', status: 'done', handled_at: clock, handled_by: 'they chose a new password' },
    ]);
  });
});

describe('the dummy hash: a wrong username takes as long as a wrong password', () => {
  let calls = 0;
  const spy = () => {
    const m = mock.method(crypto, 'scrypt');
    syncBuiltinESMExports();
    return () => { calls = m.mock.callCount(); m.mock.restore(); syncBuiltinESMExports(); };
  };
  const scryptRuns = async (f: () => Promise<unknown>) => {
    const done = spy();
    try { await f(); } finally { done(); }
    return calls;
  };

  before(async () => {
    // the dummy hash is made the first time it is needed (scrypt once more): made here
    await checkCredentials(sql, 'nobody-at-all', 'whatever-password');
  });

  it('a wrong password: scrypt once', async () => {
    assert.equal(await scryptRuns(() => checkCredentials(sql, 'lee', 'not-lees-password')), 1);
  });

  it('a username nobody has, a malformed one, no password at all: scrypt once each, and nobody is let in', async () => {
    for (const [login, password] of [['nobody-at-all', 'lee-password-123'], ['!! not a name', 'lee-password-123'], ['lee', undefined], ['lee', 'x'.repeat(201)]] as const) {
      let r: unknown = 'not run';
      assert.equal(await scryptRuns(async () => { r = await signInCheck(sql, login, password); }), 1, `${login} / ${String(password).slice(0, 12)}`);
      assert.equal(r, null);
    }
  });

  it('an account with no password yet (waiting for its setup link): scrypt once, against the dummy hash', async () => {
    const pat = (await admin({ op: 'visitor.create', username: 'pat', password: null })).id;
    assert.equal(await scryptRuns(() => checkCredentials(sql, 'pat', '')), 1);
    await admin({ op: 'visitor.delete', id: pat });
  });

  it('the right password: scrypt once, and they are let in', async () => {
    let v: { username: string } | null = null;
    assert.equal(await scryptRuns(async () => { v = await checkCredentials(sql, 'lee', 'lee-password-123'); }), 1);
    assert.equal(v!.username, 'lee');
  });
});
