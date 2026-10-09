// The panel's email notices (docs/apps-plan.md phase 3, src/panel/notices.ts):
// a real gate (its database, its admin ops) and the panel's database, with the
// mail service stood in for -- what gets sent, when, and what never does.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { handleAdmin } from '@panel/pammy/gate/admin';
import { addResponse } from '@panel/forms/gate/forms/responses';
import { createForm, duplicateForm, formById, setFormSwitches } from '@panel/forms/gate/forms/store';
import type { GateLive } from '@panel/core/gate/live';
import { addAccessRequest, addResetRequest, areaById } from '@panel/core/gate/store';
import { noticesSince } from '@panel/forms/gate/notices';
import { migrate } from '@panel/core/pg-migrate';
import { one, run, type Sql } from '@panel/core/pg';
import { Notifier, noticeFor } from '@panel/mail/panel/notices';
import { newGate } from './gate-seed.ts';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let gate: GateLive;
let db: Sql;
let clock = 1_790_000_000;
let sent: Record<string, unknown>[] = [];
let mailReady = true;
let mailDown = false;
let notifier: Notifier;
let rsvp = 0;
let quiet = 0;
let comments = 0;

const ORIGIN = 'https://panel.pammy.org';
// the sample contact form's questions (gate-seed), or a comment area's
const answer = async (formId: number, page = 'party.html') => {
  const f = (await formById(gate.db, formId))!;
  const values = f.kind === 'comments'
    ? { 'your-name': 'Olivia', 'your-comment': 'Lovely!' }
    : { 'your-name': 'Olivia', 'email-address': 'olivia@example.com', 'phone-number': '', 'what-is-it-about': '', message: 'Coming!', 'add-me-to-the-mailing-list': false };
  return addResponse(gate.db, clock, f, page, values, null, 'pammy.org', '198.51.100.9');
};
const prefs = (p: { forms?: number[]; areas?: number[]; requests?: boolean }) =>
  run(db, 'UPDATE mail_notices SET forms = ?, comment_areas = ?, requests = ? WHERE id = 1', JSON.stringify(p.forms ?? []), JSON.stringify(p.areas ?? []), p.requests ?? false);

before(async () => {
  pg = await startPg();
  gate = await newGate(pg, () => clock);
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('panel', database, 4);
  // two copies of the seeded sample contact form, and a comment area
  const copy = async (name: string) => {
    const f = await duplicateForm(gate.db, clock, 1, name, 'test');
    await run(gate.db, 'UPDATE forms SET title = ? WHERE id = ?', name.toUpperCase(), f.id);
    await setFormSwitches(gate.db, f.id, { enabled: true });
    return f.id;
  };
  rsvp = await copy('rsvp');
  quiet = await copy('guestbook');
  comments = (await createForm(gate.db, clock, { name: 'blog-comments', title: 'BLOG-COMMENTS', kind: 'comments' }, 'test')).id;
  await setFormSwitches(gate.db, comments, { enabled: true, approvable: true });
  notifier = new Notifier(db,
    (req) => handleAdmin(gate, clock, { ...req, op: String(req.op) }) as Promise<never>,
    async <T>(req: Record<string, unknown>) => {
      if (req.op === 'status') return { ready: mailReady, why: mailReady ? null : 'No Resend key has been set.' } as T;
      if (mailDown) throw new Error("The mail service isn't answering.");
      sent.push(req);
      return { sent: true } as T;
    },
    ORIGIN, () => clock);
});
after(async () => {
  await db?.end({ timeout: 2 });
  await gate?.db.end({ timeout: 2 });
  pg?.stop();
});
beforeEach(async () => {
  sent = []; mailReady = true; mailDown = false;
  clock += 600;
});

describe('the gate: what arrived since', () => {
  it('the first time, only where things stand', async () => {
    const r = await noticesSince(gate.db, {});
    assert.deepEqual([r.responses, r.requests], [[], []]);
    assert.ok(r.last.responses >= 0 && r.last.requests >= 0);
  });

  it('never the answers, a name, a contact or an IP', async () => {
    const before = (await noticesSince(gate.db, {})).last;
    await answer(rsvp);
    const r = await noticesSince(gate.db, before);
    assert.equal(r.responses.length, 1);
    assert.deepEqual(Object.keys(r.responses[0]!).sort(), ['createdAt', 'formId', 'formName', 'formTitle', 'id', 'kind', 'page', 'waiting']);
    assert.ok(!JSON.stringify(r).includes('Olivia') && !JSON.stringify(r).includes('198.51.100.9'));
  });
});

describe('the notices', () => {
  it('the first look sends nothing, whatever is already there', async () => {
    await prefs({ forms: [rsvp], requests: true });
    await answer(rsvp);
    assert.equal(await notifier.look(), 0);
    assert.deepEqual(sent, []);
    assert.ok((await one<{ s: number | null }>(db, 'SELECT seen_response AS s FROM mail_notices'))!.s !== null);
  });

  it('a new response to a chosen form: its title, its page, a link -- and not for a form she didn\'t choose', async () => {
    await prefs({ forms: [rsvp] });
    const id = await answer(rsvp);
    await answer(quiet);
    assert.equal(await notifier.look(), 1);
    assert.deepEqual(sent, [{ op: 'notice', subject: 'a new response to "RSVP"', lines: ['Someone filled in "RSVP" on party.html.'], link: `${ORIGIN}/responses?form=${rsvp}`, key: `response:${id}` }]);
    assert.equal(await notifier.look(), 0, 'and only once');
  });

  it('a comment waiting for approval, in a chosen comment area', async () => {
    await prefs({ areas: [comments] });
    await answer(comments, 'blog/first-post.html');
    await notifier.look();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, 'a comment is waiting for your OK (BLOG-COMMENTS)');
    assert.equal(sent[0]!.link, `${ORIGIN}/comments`);
  });

  it('requests to open a protected folder, and forgotten passwords', async () => {
    await prefs({ requests: true });
    const made = await handleAdmin(gate, clock, { op: 'area.create', path: 'family' }) as { id: number };
    const area = (await areaById(gate.db, made.id))!;
    await addAccessRequest(gate.db, clock, area, { name: 'Rose', contact: 'rose@example.com', message: 'hi' }, 'pammy.org', null);
    // a forgotten password is only a request for someone who exists (the gate says nothing otherwise)
    const jo = await handleAdmin(gate, clock, { op: 'visitor.create', username: 'auntie.jo', name: 'Auntie Jo', password: 'correct-horse-battery', contact: '' }) as { id: number };
    await handleAdmin(gate, clock, { op: 'grant', visitorId: jo.id, areaId: area.id, allow: true });
    assert.ok(await addResetRequest(gate.db, clock, area, 'auntie.jo', 'forgot', 'pammy.org', null));
    await notifier.look();
    assert.deepEqual(sent.map((m) => m.subject), ['someone asked to open family', 'someone forgot their password for family']);
    assert.ok(!JSON.stringify(sent).includes('Rose') && !JSON.stringify(sent).includes('rose@example.com'));
  });

  it('mail not set up: nothing kept back to send later, and the page is told why', async () => {
    await prefs({ forms: [rsvp] });
    mailReady = false;
    await answer(rsvp);
    await notifier.look();
    assert.deepEqual(sent, []);
    assert.equal((await one<{ p: string }>(db, 'SELECT last_problem AS p FROM mail_notices'))!.p, 'A notice was not sent: No Resend key has been set.');
    mailReady = true;
    assert.equal(await notifier.look(), 0, 'setting it up later sends no old news');
  });

  it('the mail service down: tried again next minute, then sent once', async () => {
    await prefs({ forms: [rsvp] });
    mailDown = true;
    await answer(rsvp);
    assert.equal(await notifier.look(), 0);
    assert.match((await one<{ p: string }>(db, 'SELECT last_problem AS p FROM mail_notices'))!.p, /will be tried again/);
    mailDown = false;
    clock += 60;
    assert.equal(await notifier.look(), 1);
    assert.equal((await one<{ p: string | null }>(db, 'SELECT last_problem AS p FROM mail_notices'))!.p, null);
    assert.equal(await notifier.look(), 0);
  });

  it('a flood: ten one by one, then one line for the rest', async () => {
    await prefs({ forms: [rsvp] });
    for (let i = 0; i < 14; i++) await answer(rsvp);
    assert.equal(await notifier.look(), 10);
    assert.equal(sent.length, 11);
    assert.equal(sent.at(-1)!.subject, '4 more new things');
    assert.equal(await notifier.look(), 0);
  });

  it('a page name can\'t add lines to an email', () => {
    const n = noticeFor({ response: { id: 1, formId: 2, formName: 'x', formTitle: 'RSVP\nBcc: evil', kind: 'form', page: 'a.html\r\nevil', createdAt: 1, waiting: false } }, ORIGIN);
    assert.ok(!n.subject.includes('\n') && !n.lines.join('').includes('\n'));
  });
});
