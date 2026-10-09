// Accounts for visitors, step 1 (docs/accounts-plan.md): the switches, all off.
// The migration's defaults and checks, the switches' rules, the gate keeping
// them in memory and in its saved copy, the admin socket, and setup links still
// being the only links anything accepts. The panel's page: test/panel.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { one, run, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { checkCredentials } from '@panel/people/gate/sign-in-check';
import { createLink, linkForToken, LINK_LIFETIMES, openLink } from '@panel/people/gate/links';
import { createVisitor } from '@panel/people/gate/visitors';
import { ALL_OFF, BUILT, readVisitorSettings, settingsOf, SWITCHES, type Switch } from '@panel/core/gate/visitor-settings';
import { needing, setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import { whyNot } from '@panel/people/shared/visitor-switches';
import { handleAdmin } from '@panel/pammy/gate/admin';
import { hashToken, newToken } from '@panel/core/util';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let db: Sql;
let dir: string;
const clock = 1_800_000_000;
const EVERY: ReadonlySet<Switch> = new Set(SWITCHES);
// a release from before roles step 5: "Open with accounts" not carried out
const OLDER: ReadonlySet<Switch> = new Set(SWITCHES.filter((k) => k !== 'openAreas'));

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('gate', database, 4);
  dir = mkdtempSync(join(tmpdir(), 'pammy-visitor-settings-'));
});
after(async () => {
  await db?.end({ timeout: 2 });
  pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// One statement, rolled back: null if accepted, else the error.
async function tryIt(stmt: string): Promise<string | null> {
  let error: string | null = null;
  await db.begin(async (t) => {
    try { await t.unsafe(stmt); } catch (e) { error = (e as Error).message; }
    throw new Error('roll back');
  }).catch((e) => { if (!error && (e as Error).message !== 'roll back') error = (e as Error).message; });
  return error;
}

describe('the migration (areas/0001-visitor-accounts.sql)', () => {
  it('makes one row with every switch off, readable and writable by the gate', async () => {
    const row = await one<Record<string, unknown>>(db, 'SELECT * FROM visitor_settings');
    assert.deepEqual(row, {
      id: 1, emailed_links: false, self_register: false, change_password: false, delete_account: false, open_areas: false, roles: false,
      changed_by: null, changed_at: null,
    });
    assert.deepEqual((await readVisitorSettings(db)).switches, ALL_OFF);
  });

  it('refuses a switch on without the one it needs, and a second row', async () => {
    assert.match(await tryIt('UPDATE visitor_settings SET self_register = true') ?? '', /check constraint/);
    assert.match(await tryIt('UPDATE visitor_settings SET emailed_links = true, open_areas = true') ?? '', /check constraint/);
    assert.equal(await tryIt('UPDATE visitor_settings SET emailed_links = true, self_register = true, open_areas = true'), null);
    assert.equal(await tryIt('UPDATE visitor_settings SET change_password = true, delete_account = true'), null);
    assert.match(await tryIt('INSERT INTO visitor_settings (id) VALUES (2)') ?? '', /check constraint/);
  });

  it("visitors: the owner's people have no email, are not registered; emails are lower-case and one account each", async () => {
    const v = await createVisitor(db, clock, 'plain-person', '', 'a-long-password-1');
    assert.deepEqual([v.email, v.email_confirmed_at, v.registered], [null, null, false]);
    assert.match(await tryIt(`UPDATE visitors SET email = 'Jo@Example.org' WHERE id = ${v.id}`) ?? '', /check constraint/);
    assert.match(await tryIt(`UPDATE visitors SET email = 'not-an-address' WHERE id = ${v.id}`) ?? '', /check constraint/);
    assert.match(await tryIt(`UPDATE visitors SET email_confirmed_at = 1 WHERE id = ${v.id}`) ?? '', /check constraint/);
    const w = await createVisitor(db, clock, 'other-person', '', 'a-long-password-2');
    assert.match(await tryIt(`UPDATE visitors SET email = 'jo@example.org' WHERE id IN (${v.id}, ${w.id})`) ?? '', /visitors_email/);
    assert.equal(await tryIt(`UPDATE visitors SET email = 'jo@example.org', email_confirmed_at = 1 WHERE id = ${v.id}`), null);
  });

  it('links: every link is a setup link unless it says otherwise; an email-change link carries its address', async () => {
    const v = await createVisitor(db, clock, 'link-person', '', null);
    const ins = (purpose: string, email: string | null) =>
      `INSERT INTO links (token_hash, visitor_id, created_at, expires_at, purpose, new_email) VALUES ('h-${purpose}', ${v.id}, 1, 2, '${purpose}', ${email === null ? 'NULL' : `'${email}'`})`;
    assert.equal(await tryIt(`INSERT INTO links (token_hash, visitor_id, created_at, expires_at) VALUES ('h', ${v.id}, 1, 2)`), null);
    for (const p of ['setup', 'confirm', 'reset']) assert.equal(await tryIt(ins(p, null)), null, p);
    assert.equal(await tryIt(ins('email-change', 'new@example.org')), null);
    assert.match(await tryIt(ins('email-change', null)) ?? '', /check constraint/);
    assert.match(await tryIt(ins('reset', 'new@example.org')) ?? '', /check constraint/);
    assert.match(await tryIt(ins('login', null)) ?? '', /check constraint/);
    assert.match(await tryIt(ins('email-change', 'New@example.org')) ?? '', /check constraint/);
  });
});

describe('the switches (A5)', () => {
  it('every switch is built: the accounts (accounts step 4), roles (roles step 4), "Open with accounts" (roles step 5)', async () => {
    assert.deepEqual([...BUILT].sort(), ['changePassword', 'deleteAccount', 'emailedLinks', 'openAreas', 'roles', 'selfRegister']);
    for (const k of ['roles', 'changePassword', 'deleteAccount'] as const) assert.equal(whyNot(k, ALL_OFF, { mail: false }), null, k);
    assert.equal(whyNot('emailedLinks', ALL_OFF, { mail: true }), null);
    assert.equal(whyNot('openAreas', { ...ALL_OFF, emailedLinks: true, selfRegister: true }, { mail: true }), null);
    assert.equal(whyNot('openAreas', { ...ALL_OFF, emailedLinks: true }, { mail: true }), 'Needs "People can register themselves" on first.');
    // a release that doesn't carry one out says so
    assert.equal(whyNot('openAreas', ALL_OFF, { mail: true, built: OLDER }), 'This comes in a later release of the panel.');
    await assert.rejects(setVisitorSwitch(db, clock, 'openAreas', true, 'momolig', { mail: true }), (e: { code: string }) => e.code === 'invalid');
    assert.deepEqual((await readVisitorSettings(db)).switches, ALL_OFF);
  });

  it('a true in the database that this code does not carry out counts as off', async () => {
    await run(db, 'UPDATE visitor_settings SET emailed_links = true, self_register = true, open_areas = true WHERE id = 1');
    try {
      assert.deepEqual((await readVisitorSettings(db, OLDER)).switches, { ...ALL_OFF, emailedLinks: true, selfRegister: true });
      assert.equal((await readVisitorSettings(db, EVERY)).switches.openAreas, true);
      // and turning it off writes it off
      const r = await setVisitorSwitch(db, clock, 'openAreas', false, 'momolig', { mail: false, built: OLDER });
      assert.equal(r.changed, true);
      assert.equal((await readVisitorSettings(db, EVERY)).switches.openAreas, false);
    } finally {
      await run(db, 'UPDATE visitor_settings SET emailed_links = false, self_register = false, open_areas = false, changed_by = NULL, changed_at = NULL WHERE id = 1');
    }
  });

  it('once built: mail first, each needs the one before, and off turns off what needs it', async () => {
    const can = { mail: false, built: EVERY };
    assert.deepEqual(needing('emailedLinks'), ['selfRegister', 'openAreas']);
    assert.deepEqual(needing('changePassword'), []);
    await assert.rejects(setVisitorSwitch(db, clock, 'emailedLinks', true, 'momolig', can), /Mail isn't set up for visitors on this site/);
    await assert.rejects(setVisitorSwitch(db, clock, 'selfRegister', true, 'momolig', { ...can, mail: true }), /Needs "Emailed links" on first/);
    await assert.rejects(setVisitorSwitch(db, clock, 'nope', true, 'momolig', can), /no such setting/);
    await assert.rejects(setVisitorSwitch(db, clock, 'emailedLinks', 'yes', 'momolig', can), /on or off/);
    try {
      for (const k of ['emailedLinks', 'selfRegister', 'openAreas', 'deleteAccount'] as const) {
        const r = await setVisitorSwitch(db, clock + 1, k, true, 'momolig', { mail: true, built: EVERY });
        assert.equal(r.switches[k], true);
      }
      const again = await setVisitorSwitch(db, clock + 2, 'openAreas', true, 'pamela', { mail: true, built: EVERY });
      assert.equal(again.changed, false, 'already on');
      const off = await setVisitorSwitch(db, clock + 3, 'emailedLinks', false, 'pamela', { mail: true, built: EVERY });
      assert.deepEqual(off.alsoOff, ['selfRegister', 'openAreas']);
      assert.deepEqual(off.switches, { ...ALL_OFF, deleteAccount: true });
      assert.deepEqual([off.changedBy, off.changedAt], ['pamela', clock + 3]);
    } finally {
      await run(db, 'UPDATE visitor_settings SET emailed_links = false, self_register = false, open_areas = false, delete_account = false, changed_by = NULL, changed_at = NULL WHERE id = 1');
    }
  });
});

describe('the gate keeps them in memory (P14)', () => {
  it('reads them with the areas, and saves them in the same file; an older file means all off', async () => {
    const snapshot = join(dir, 'areas.json');
    const g = new GateLive(db, { sessions: visitorSessions, now: () => clock, snapshot });
    g.markReady();
    await g.reloadAreas();
    assert.deepEqual(g.visitorSettings, ALL_OFF);
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
    assert.deepEqual(saved.visitorSettings, ALL_OFF);
    assert.ok(Array.isArray(saved.areas));

    writeFileSync(snapshot, JSON.stringify({ savedAt: 1, areas: [] }));
    const early = new GateLive(db, { sessions: visitorSessions, now: () => clock, snapshot });
    assert.equal(early.areasKnown, true);
    assert.deepEqual(early.visitorSettings, ALL_OFF);
    // ... and it is written again with them straight away
    assert.deepEqual(JSON.parse(readFileSync(snapshot, 'utf8')).visitorSettings, ALL_OFF);
    // a copy saying on, for a switch this code doesn't carry out: still off
    writeFileSync(snapshot, JSON.stringify({ savedAt: 1, areas: [], visitorSettings: { ...ALL_OFF, openAreas: true } }));
    assert.deepEqual(settingsOf({ ...ALL_OFF, openAreas: true }, false, OLDER), ALL_OFF);
    assert.deepEqual(settingsOf({ ...ALL_OFF, openAreas: true }, false, EVERY), { ...ALL_OFF, openAreas: true });
    // ... and one this code does carry out, on
    writeFileSync(snapshot, JSON.stringify({ savedAt: 1, areas: [], visitorSettings: { ...ALL_OFF, changePassword: true } }));
    assert.deepEqual(new GateLive(db, { sessions: visitorSessions, now: () => clock, snapshot }).visitorSettings, { ...ALL_OFF, changePassword: true });
  });

  it('the admin socket: read them, and every change is checked', async () => {
    const g = new GateLive(db, { sessions: visitorSessions, now: () => clock });
    g.markReady();
    const admin = (req: Record<string, unknown>) => handleAdmin(g, clock, req as { op: string }) as Promise<any>;
    const st = await admin({ op: 'visitor-settings.get' });
    // gateMail: this gate has no door to a mail service (none given)
    assert.deepEqual(st, { switches: ALL_OFF, changedBy: null, changedAt: null, gateMail: false });
    // so emailed links can't go on, whatever the panel says about its own mail
    await assert.rejects(admin({ op: 'visitor-settings.set', key: 'emailedLinks', on: true, mail: true, actor: 'momolig' }),
      (e: { code: string; message: string }) => e.code === 'invalid' && /Mail isn't set up for visitors/.test(e.message));
    await assert.rejects(admin({ op: 'visitor-settings.set', key: 'selfRegister', on: true, mail: true, actor: 'momolig' }), /Needs "Emailed links" on first/);
    await assert.rejects(admin({ op: 'visitor-settings.set', key: 'visitor_settings', on: true, mail: true, actor: 'momolig' }), /no such setting/);
    // off when off: nothing changes, nothing is recorded
    const r = await admin({ op: 'visitor-settings.set', key: 'openAreas', on: false, mail: false, actor: 'momolig' });
    assert.deepEqual([r.changed, r.alsoOff, r.changedBy], [false, [], null]);
    // the panel can't say which switches are built
    // ... nor skip what one needs
    await assert.rejects(admin({ op: 'visitor-settings.set', key: 'openAreas', on: true, mail: true, built: [...SWITCHES], actor: 'momolig' }), /Needs "People can register themselves" on first/);
  });
});

describe('links: setup links work as before, and nothing else chooses a password', () => {
  it('a setup link is made as before; a link made for anything else is never taken as one', async () => {
    const v = await createVisitor(db, clock, 'linked', '', null);
    const { token, link } = await createLink(db, clock, v.id, null);
    assert.deepEqual([link.purpose, link.new_email, link.expires_at - link.created_at], ['setup', null, LINK_LIFETIMES.setup]);
    assert.equal(LINK_LIFETIMES.setup, 7 * 24 * 3600);
    assert.equal((await linkForToken(db, clock, token))?.link.id, link.id);

    const reset = newToken();
    await run(db, "INSERT INTO links (token_hash, visitor_id, created_at, expires_at, purpose) VALUES (?, ?, ?, ?, 'reset')", hashToken(reset), v.id, clock, clock + 3600);
    assert.equal(await linkForToken(db, clock, reset), null);
    assert.equal((await openLink(db, clock, v.id))?.id, link.id, 'the open setup link, not the newer reset link');
    // a new setup link cancels the old setup link only
    const second = await createLink(db, clock + 5, v.id, null);
    assert.equal(await linkForToken(db, clock + 5, token), null);
    assert.equal((await linkForToken(db, clock + 5, second.token))?.link.id, second.link.id);
    assert.equal((await one<{ cancelled_at: number | null }>(db, "SELECT cancelled_at FROM links WHERE purpose = 'reset' AND visitor_id = ?", v.id))?.cancelled_at, null);
  });

  it('an account someone made themselves signs in only once its email is confirmed (A4)', async () => {
    const v = await createVisitor(db, clock, 'self-made', '', 'a-long-password-3');
    await run(db, "UPDATE visitors SET registered = true, email = 'self@example.org' WHERE id = ?", v.id);
    assert.equal(await checkCredentials(db, 'self-made', 'a-long-password-3'), null);
    await run(db, 'UPDATE visitors SET email_confirmed_at = ? WHERE id = ?', clock, v.id);
    assert.equal((await checkCredentials(db, 'self-made', 'a-long-password-3'))?.id, v.id);
    // the owner's people: as before, with or without an email
    assert.ok(await checkCredentials(db, 'plain-person', 'a-long-password-1'));
  });
});
