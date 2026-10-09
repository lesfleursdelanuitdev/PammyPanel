// Accounts people make and look after themselves (docs/accounts-plan.md step 4),
// through lfdln's gate with its mail door stood in for: every switch off answers as
// before (404); on, registering, confirming, signing in with an address, a new
// password by email, the account page, deleting, and what the owner can still do.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { handleAdmin } from '@panel/gate/admin';
import { buildGateApp } from '@panel/gate/app';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import type { VisitorMail } from '@panel/core/gate/context';
import { all, connectPg, one, type Sql } from '@panel/core/pg';
import { peopleHousekeeping } from '@panel/people/gate/housekeeping';
import { LINK_LIFETIMES } from '@panel/people/gate/links';
import { passwordProblem } from '@panel/people/gate/accounts-store';
import { UNCONFIRMED_KEPT } from '@panel/people/gate/self-service';
import { isCommonPassword } from '@panel/people/gate/passwords';
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
let mailFails: null | { code: string; message: string } = null;
const mailer = async (m: VisitorMail) => {
  if (mailFails) throw Object.assign(new Error(mailFails.message), { code: mailFails.code });
  sent.push(m);
};
const admin = (req: Record<string, unknown>) =>
  handleAdmin(live, clock, req as { op: string }, { publicRoot: pub, domain: LFDLN.domain, modules: LFDLN.modules, visitorMail: mailer }) as Promise<any>;

let ipN = 0;
async function post(url: string, body: Record<string, unknown>, opts: { cookie?: string; origin?: string; host?: string } = {}) {
  const host = opts.host ?? HOST;
  const res = await app.inject({
    method: 'POST', url, remoteAddress: '127.0.0.1',
    headers: {
      host, 'x-pammy-base': '/', origin: opts.origin ?? `https://${host}`, 'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipN++ % 250) + 1}`, ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    payload: JSON.stringify(body),
  });
  const set = res.headers['set-cookie'];
  return { status: res.statusCode, json: res.body ? res.json() : null, cookie: set ? String(set).split(';')[0] : undefined, setCookie: set ? String(set) : '' };
}
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers: { host: HOST, ...(cookie ? { cookie } : {}) } });
const me = async (cookie?: string) => (await get('/_pammy/me', cookie)).json();
const tokenOf = (link: string | undefined) => link!.split('#')[1]!;
const lastMail = () => sent[sent.length - 1]!;
const turn = (key: string, on: boolean) => admin({ op: 'visitor-settings.set', key, on, mail: true, actor: 'momolig' });

before(async () => {
  pg = await startPg();
  root = mkdtempSync(join(tmpdir(), 'accounts-'));
  pub = join(root, 'sites');
  mkdirSync(join(pub, 'members'), { recursive: true });
  writeFileSync(join(pub, 'members', 'index.html'), 'members');
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  sql = connectPg({ role: 'gate', password: pg.passwords.gate, port: pg.port, database, max: 4, app: 'test-accounts' });
  live = new GateLive(sql, { sessions: visitorSessions, now: () => clock, snapshot: join(root, 'areas.json') });
  live.markReady();
  await live.reloadAreas();
  app = buildGateApp(LFDLN, { publicRoot: pub, domain: LFDLN.domain, now: () => clock, visitorMail: mailer }, live);
  await app.ready();
});
after(async () => {
  await app?.close();
  await sql?.end({ timeout: 1 });
  rmSync(root, { recursive: true, force: true });
  await pg?.stop();
});
beforeEach(() => {
  sent = [];
  mailFails = null;
  clock += 7200;      // past the rate limits of the test before
});

describe('passwords (A7)', () => {
  it('at least 10 characters, and not one of the common ones, whatever the case', () => {
    assert.ok(isCommonPassword('password1234'));
    assert.ok(isCommonPassword('QWERTYUIOP'));
    assert.ok(!isCommonPassword('jo-password-123'));
    assert.match(passwordProblem('Password1234') ?? '', /most common/);
    assert.match(passwordProblem('short') ?? '', /at least 10/);
    assert.equal(passwordProblem('a-quiet-kettle-9'), null);
  });
});

describe('every switch off (A5): as before', () => {
  it('the account pages and their routes are not there, and signing in needs a folder', async () => {
    assert.deepEqual((await get('/_pammy/accounts')).json(), { register: false, emailedLinks: false, changePassword: false, deleteAccount: false });
    for (const p of ['register', 'confirm', 'reset', 'account']) assert.equal((await get(`/_pammy/${p}`)).statusCode, 404, p);
    for (const p of ['register', 'confirm', 'reset-link', 'reset/check', 'reset', 'account/password', 'account/email', 'account/signout', 'account/delete']) {
      assert.equal((await post(`/_pammy/${p}`, {})).status, 404, p);
    }
    assert.equal((await post('/_pammy/login', { username: 'x', password: 'y' })).json.error, 'no-area');
  });

  it("emailed links can't go on without the gate's door to the mail service", async () => {
    const bare = (req: Record<string, unknown>) => handleAdmin(live, clock, req as { op: string }, { publicRoot: pub, domain: LFDLN.domain, modules: LFDLN.modules }) as Promise<any>;
    assert.equal((await bare({ op: 'visitor-settings.get' })).gateMail, false);
    await assert.rejects(bare({ op: 'visitor-settings.set', key: 'emailedLinks', on: true, mail: true }), /Mail isn't set up for visitors/);
    assert.equal((await admin({ op: 'visitor-settings.get' })).gateMail, true);
  });
});

describe('with the switches on', () => {
  before(async () => {
    for (const k of ['emailedLinks', 'selfRegister', 'changePassword', 'deleteAccount']) await turn(k, true);
  });

  it('the pages are there, named for the site', async () => {
    assert.deepEqual((await get('/_pammy/accounts')).json(), { register: true, emailedLinks: true, changePassword: true, deleteAccount: true });
    const page = await get('/_pammy/register');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<pammy-register><\/pammy-register>/);
    assert.match(page.body, /<title>Make an account · lesfleursdelanuit\.com<\/title>/);
    assert.equal((await get('/_pammy/account')).statusCode, 200);
  });

  it('registering: a confirmation link, and no sign-in until it is used (A4)', async () => {
    const bad = await post('/_pammy/register', { username: 'jo', email: 'not-an-address', password: 'jo-password-123' });
    assert.deepEqual([bad.status, bad.json.field], [400, 'email']);
    const common = await post('/_pammy/register', { username: 'jo', email: 'jo@example.org', password: 'password1234' });
    assert.deepEqual([common.status, common.json.field], [400, 'password']);
    assert.equal(sent.length, 0);

    const r = await post('/_pammy/register', { username: 'Jo', email: 'Jo@Example.org', password: 'jo-password-123' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.cookie, undefined, 'not signed in');
    assert.deepEqual([lastMail().kind, lastMail().to], ['confirm', 'jo@example.org']);
    assert.match(lastMail().link!, /^https:\/\/examprep\.lesfleursdelanuit\.com\/_pammy\/confirm#[A-Za-z0-9_-]{43}$/);
    const v = await one<{ registered: boolean; email: string; email_confirmed_at: number | null }>(sql, "SELECT * FROM visitors WHERE username = 'jo'");
    assert.deepEqual([v?.registered, v?.email, v?.email_confirmed_at], [true, 'jo@example.org', null]);
    // no role anywhere (Q3)
    assert.equal((await all(sql, 'SELECT 1 FROM memberships m JOIN visitors v ON v.id = m.visitor_id WHERE v.username = ?', 'jo')).length, 0);

    const early = await post('/_pammy/login', { username: 'jo', password: 'jo-password-123' });
    assert.deepEqual([early.status, early.json.error], [403, 'unconfirmed']);
    const wrong = await post('/_pammy/login', { username: 'jo', password: 'not-her-password' });
    assert.deepEqual([wrong.status, wrong.json.error], [401, 'wrong'], 'a wrong password never says the account is waiting');

    const c = await post('/_pammy/confirm', { token: tokenOf(lastMail().link) });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.deepEqual([c.json.username, c.json.changed, c.json.next], ['jo', false, '/']);
    assert.match(c.setCookie, /^__Host-lfdln_visitor=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    assert.deepEqual(await me(c.cookie), { signedIn: true, username: 'jo', name: null, email: 'jo@example.org', emailConfirmed: true, registered: true });
    assert.equal((await post('/_pammy/confirm', { token: tokenOf(lastMail().link) })).status, 410, 'once only');
  });

  it('signs in with the username or the address (A8), to the site itself (A2)', async () => {
    for (const login of ['jo', 'JO@example.org']) {
      const s = await post('/_pammy/login', { username: login, password: 'jo-password-123' });
      assert.equal(s.status, 200, JSON.stringify(s.json));
      assert.equal(s.json.next, '/');
      assert.equal((await me(s.cookie)).username, 'jo');
    }
  });

  it('a taken username is said; a taken address is not (it gets a note instead)', async () => {
    const name = await post('/_pammy/register', { username: 'jo', email: 'other@example.org', password: 'other-password-1' });
    assert.deepEqual([name.status, name.json.field], [409, 'username']);
    const again = await post('/_pammy/register', { username: 'jo2', email: 'jo@example.org', password: 'other-password-1' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ok: true }, 'the same answer as a new account');
    assert.deepEqual([lastMail().kind, lastMail().to], ['already-registered', 'jo@example.org']);
    assert.match(lastMail().link!, /\/_pammy\/reset#/);
    assert.equal(await one(sql, "SELECT 1 FROM visitors WHERE username = 'jo2'"), undefined);
    // a robot filling in the hidden field is told it worked
    const bot = await post('/_pammy/register', { username: 'bot', email: 'bot@example.org', password: 'bot-password-12', website: 'spam' });
    assert.deepEqual([bot.status, sent.length], [200, 1]);
    assert.equal(await one(sql, "SELECT 1 FROM visitors WHERE username = 'bot'"), undefined);
  });

  it("no email sent, no account: they can try again with the same name", async () => {
    mailFails = { code: 'unavailable', message: 'Resend could not be reached.' };
    const r = await post('/_pammy/register', { username: 'sam', email: 'sam@example.org', password: 'sam-password-123' });
    assert.deepEqual([r.status, r.json.error], [503, 'unavailable']);
    assert.equal(await one(sql, "SELECT 1 FROM visitors WHERE username = 'sam'"), undefined);
    mailFails = { code: 'full', message: 'The site has sent as many emails as it may today. Please try again tomorrow.' };
    const full = await post('/_pammy/register', { username: 'sam', email: 'sam@example.org', password: 'sam-password-123' });
    assert.deepEqual([full.status, full.json.message], [503, 'The site has sent as many emails as it may today. Please try again tomorrow.']);
    mailFails = null;
    assert.equal((await post('/_pammy/register', { username: 'sam', email: 'sam@example.org', password: 'sam-password-123' })).status, 200);
  });

  it('a new password by email (A6: an hour, once, signed out everywhere)', async () => {
    const before = (await post('/_pammy/login', { username: 'jo', password: 'jo-password-123' })).cookie;
    const nobody = await post('/_pammy/reset-link', { login: 'nobody@example.org' });
    assert.deepEqual([nobody.status, nobody.json, sent.length], [200, { ok: true }, 0]);
    const r = await post('/_pammy/reset-link', { login: 'jo@example.org' });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.deepEqual([lastMail().kind, lastMail().to], ['reset', 'jo@example.org']);
    const token = tokenOf(lastMail().link);
    assert.equal((await post('/_pammy/reset/check', { token })).json.username, 'jo');
    assert.equal((await post('/_pammy/reset', { token, password: 'password1234' })).status, 400);
    const done = await post('/_pammy/reset', { token, password: 'jo-new-password-9' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal((await me(before)).signedIn, false, 'the older session ended');
    assert.equal((await me(done.cookie)).username, 'jo');
    assert.equal((await post('/_pammy/reset', { token, password: 'jo-other-password-9' })).status, 410);
    // an hour and no more
    await post('/_pammy/reset-link', { login: 'jo' });
    clock += LINK_LIFETIMES.reset + 1;
    assert.equal((await post('/_pammy/reset/check', { token: tokenOf(lastMail().link) })).status, 410);
  });

  it('the account page: change the password (the current one needed), others signed out', async () => {
    const a = (await post('/_pammy/login', { username: 'jo', password: 'jo-new-password-9' })).cookie!;
    const b = (await post('/_pammy/login', { username: 'jo', password: 'jo-new-password-9' })).cookie!;
    const wrong = await post('/_pammy/account/password', { current: 'nope-nope-nope', password: 'jo-third-password' }, { cookie: a });
    assert.deepEqual([wrong.status, wrong.json.field], [400, 'current']);
    assert.equal((await post('/_pammy/account/password', { current: 'jo-new-password-9', password: 'jo-third-password' })).status, 401, 'signed out: refused');
    const ok = await post('/_pammy/account/password', { current: 'jo-new-password-9', password: 'jo-third-password' }, { cookie: a });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await me(a)).signedIn, true, 'this one stays');
    assert.equal((await me(b)).signedIn, false, 'the others end');
    // from another site: refused (same-origin JSON only)
    assert.equal((await post('/_pammy/account/password', { current: 'jo-third-password', password: 'x-long-enough-1' }, { cookie: a, origin: 'https://evil.example' })).status, 403);
  });

  it('the account page: a new address, confirmed from the new one; the old one is told', async () => {
    const a = (await post('/_pammy/login', { username: 'jo', password: 'jo-third-password' })).cookie!;
    const taken = await post('/_pammy/account/email', { email: 'sam@example.org', password: 'jo-third-password' }, { cookie: a });
    assert.deepEqual([taken.status, taken.json, sent.length], [200, { ok: true }, 0], "another account's address: the same answer, nothing sent");
    const r = await post('/_pammy/account/email', { email: 'jo.new@example.org', password: 'jo-third-password' }, { cookie: a });
    assert.equal(r.status, 200);
    assert.deepEqual([lastMail().kind, lastMail().to], ['email-change', 'jo.new@example.org']);
    assert.equal((await me(a)).email, 'jo@example.org', 'nothing changes until the link is used');
    const c = await post('/_pammy/confirm', { token: tokenOf(lastMail().link) });
    assert.deepEqual([c.status, c.json.changed, c.json.next], [200, true, '/_pammy/account']);
    assert.deepEqual([lastMail().kind, lastMail().to, lastMail().link], ['email-changed', 'jo@example.org', undefined]);
    assert.equal((await me(c.cookie)).email, 'jo.new@example.org');
  });

  it('what the owner can do: no password for an account someone made, but a reset link by email', async () => {
    const jo = await one<{ id: number }>(sql, "SELECT id FROM visitors WHERE username = 'jo'");
    await assert.rejects(admin({ op: 'visitor.password', id: jo!.id, password: 'owner-chosen-123' }), /made their own account/);
    await assert.rejects(admin({ op: 'link.create', visitorId: jo!.id, areaId: null }), /made their own account/);
    const r = await admin({ op: 'visitor.send-reset', id: jo!.id, actor: 'momolig' });
    assert.equal(r.sentTo, 'jo.new@example.org');
    // to the hostname they last used here
    assert.match(lastMail().link!, /^https:\/\/examprep\.lesfleursdelanuit\.com\/_pammy\/reset#/);
    const st = await admin({ op: 'state' });
    assert.deepEqual(st.visitors.filter((v: { username: string }) => v.username === 'jo').map((v: Record<string, unknown>) => [v.email, v.emailConfirmed, v.registered]),
      [['jo.new@example.org', true, true]]);
    // sam hasn't confirmed: the owner can send the link again
    const sam = await one<{ id: number }>(sql, "SELECT id FROM visitors WHERE username = 'sam'");
    await admin({ op: 'visitor.resend-confirm', id: sam!.id, actor: 'momolig' });
    assert.deepEqual([lastMail().kind, lastMail().to], ['confirm', 'sam@example.org']);
    await assert.rejects(admin({ op: 'visitor.resend-confirm', id: jo!.id }), /nothing to confirm/);
  });

  it('accounts nobody confirmed go after 48 hours (Q2); confirmed ones stay', async () => {
    const at = await one<{ created_at: number }>(sql, "SELECT created_at FROM visitors WHERE username = 'sam'");
    await peopleHousekeeping(sql, at!.created_at + UNCONFIRMED_KEPT - 1);
    assert.ok(await one(sql, "SELECT 1 FROM visitors WHERE username = 'sam'"));
    await peopleHousekeeping(sql, at!.created_at + UNCONFIRMED_KEPT);
    assert.equal(await one(sql, "SELECT 1 FROM visitors WHERE username = 'sam'"), undefined);
    assert.ok(await one(sql, "SELECT 1 FROM visitors WHERE username = 'jo'"));
  });

  it('sign out everywhere', async () => {
    const a = (await post('/_pammy/login', { username: 'jo', password: 'jo-third-password' })).cookie!;
    const b = (await post('/_pammy/login', { username: 'jo', password: 'jo-third-password' })).cookie!;
    const r = await post('/_pammy/account/signout', {}, { cookie: a });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /Max-Age=0/);
    assert.deepEqual([(await me(a)).signedIn, (await me(b)).signedIn], [false, false]);
  });

  it('deleting their own account (A9): the password needed; it goes, and they are told', async () => {
    const a = (await post('/_pammy/login', { username: 'jo', password: 'jo-third-password' })).cookie!;
    assert.equal((await post('/_pammy/account/delete', { password: 'not-it-at-all' }, { cookie: a })).status, 400);
    const r = await post('/_pammy/account/delete', { password: 'jo-third-password' }, { cookie: a });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([lastMail().kind, lastMail().to], ['deleted', 'jo.new@example.org']);
    assert.equal(await one(sql, "SELECT 1 FROM visitors WHERE username = 'jo'"), undefined);
    assert.equal((await me(a)).signedIn, false);
    // the events keep the username only
    const ev = await all<{ visitor_id: number | null; username: string }>(sql, "SELECT visitor_id, username FROM events WHERE username = 'jo'");
    assert.ok(ev.length > 0 && ev.every((e) => e.visitor_id === null));
    // and the name is free again
    assert.equal((await post('/_pammy/register', { username: 'jo', email: 'jo@example.org', password: 'jo-password-123' })).status, 200);
  });

  it('each switch off takes its part away again', async () => {
    await turn('deleteAccount', false);
    await turn('changePassword', false);
    const off = await turn('emailedLinks', false);
    assert.deepEqual(off.alsoOff, ['selfRegister']);
    for (const p of ['register', 'confirm', 'reset', 'account']) assert.equal((await get(`/_pammy/${p}`)).statusCode, 404, p);
    assert.equal((await post('/_pammy/register', { username: 'kim', email: 'kim@example.org', password: 'kim-password-123' })).status, 404);
  });
});
