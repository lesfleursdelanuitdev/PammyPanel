// pammy-mail (docs/apps-plan.md phase 3), over a real socket, with Resend's API
// stood in for: what it sends, to whom, and what it refuses.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { callMail, MailCallError } from '@panel/mail/mail/client';
import { createMailDoors, createMailServer, PER_HOUR } from '@panel/mail/mail/service';
import { PROFILE } from '@panel/pammy/profile';
import { readKey, readSettings } from '@panel/mail/mail/settings';

let dir: string;
let sock: string;
let server: ReturnType<typeof createMailServer>;
let clock = 1_790_000_000;
let asked: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let answer: { status: number; body: unknown } | 'down' = { status: 200, body: { id: 'email-1' } };
const KEY = 're_TestKeyTestKeyTestKey_123';

const ask = <T>(req: Record<string, unknown>) => callMail<T>(sock, req);
const put = (settings: unknown, key: string | null) => {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(dir, 'resend.key'), key ?? '');
};
const GOOD = { from: 'noreply@mail.lesfleursdelanuit.com', replyTo: 'hello@pammy.org', notifyTo: 'hello@pammy.org' };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-mail-'));
  sock = join(dir, 'mail.sock');
  server = createMailServer({ names: { site: PROFILE.name, panel: PROFILE.panelName },
    settings: () => readSettings(join(dir, 'settings.json')),
    key: () => readKey(join(dir, 'resend.key')),
    fetch: (async (url: string, init: RequestInit) => {
      asked.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      if (answer === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    panelOrigin: 'https://panel.pammy.org', domain: 'pammy.org',
    now: () => clock,
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  put(GOOD, KEY);
  asked = [];
  answer = { status: 200, body: { id: 'email-1' } };
  clock += 2 * 86_400;    // past the limits of the test before
});

describe('pammy-mail', () => {
  it('says whether it is ready, and why not', async () => {
    assert.deepEqual(await ask({ op: 'status' }), { ready: true, why: null, from: GOOD.from, notifyTo: 'hello@pammy.org', sentToday: 0, visitorSentToday: 0, visitorPerDay: 40 });
    put(GOOD, null);
    assert.deepEqual((await ask<{ ready: boolean; why: string }>({ op: 'status' })).why, 'No Resend key has been set.');
    put(GOOD, 'not-a-key');
    assert.equal((await ask<{ ready: boolean }>({ op: 'status' })).ready, false);
    put({ ...GOOD, notifyTo: 'hello@pammy.org\nBcc: x@evil.test' }, KEY);
    assert.equal((await ask<{ why: string }>({ op: 'status' })).why, 'The mail settings could not be read.');
  });

  it('sends a test to the notice address, from the pammy sender, replies to hello@', async () => {
    const r = await ask<{ sent: boolean; to: string }>({ op: 'test' });
    assert.deepEqual([r.sent, r.to], [true, 'hello@pammy.org']);
    assert.equal(asked[0]!.url, 'https://api.resend.com/emails');
    assert.equal(asked[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual({ ...asked[0]!.body, text: undefined }, {
      from: 'pammy.org panel <noreply@mail.lesfleursdelanuit.com>', to: ['hello@pammy.org'], reply_to: 'hello@pammy.org',
      subject: 'pammy.org: a test email', text: undefined,
    });
    assert.match(String(asked[0]!.body.text), /If you can read it, the panel can email you\.\n\n--\nSent by the pammy\.org control panel\. To change what it tells you about: https:\/\/panel\.pammy\.org\/email$/);
  });

  it('a notice: a subject, a few lines and a link into the panel -- to the notice address only', async () => {
    await ask({ op: 'notice', subject: 'a new response to RSVP', lines: ['On /party.html.'], link: 'https://panel.pammy.org/responses?form=3', key: 'response:41', to: 'evil@example.com' });
    assert.deepEqual(asked[0]!.body.to, ['hello@pammy.org'], 'never where the request says');
    assert.equal(asked[0]!.body.subject, 'pammy.org: a new response to RSVP');
    assert.match(String(asked[0]!.body.text), /^On \/party\.html\.\n\nhttps:\/\/panel\.pammy\.org\/responses\?form=3\n\n--/);
    assert.equal(asked[0]!.headers['idempotency-key'], 'response:41', 'the same event is never sent twice');
    for (const bad of [
      { subject: 'two\nlines', lines: [], link: 'https://panel.pammy.org/' },
      { subject: 'ok', lines: ['x'.repeat(301)], link: 'https://panel.pammy.org/' },
      { subject: 'ok', lines: [], link: 'https://evil.example/phish' },
      { subject: 'ok', lines: [], link: 'https://panel.pammy.org.evil.example/' },
      { subject: 'ok', lines: 'not a list', link: 'https://panel.pammy.org/' },
    ]) await assert.rejects(ask({ op: 'notice', ...bad }), (e: MailCallError) => e.code === 'invalid', JSON.stringify(bad));
    assert.equal(asked.length, 1);
  });

  it("says Resend's reason when it refuses", async () => {
    answer = { status: 403, body: { name: 'validation_error', message: 'The mail.lesfleursdelanuit.com domain is not verified.' } };
    await assert.rejects(ask({ op: 'test' }), (e: MailCallError) => e.code === 'refused' && e.message === 'Resend did not accept the key. Resend said: The mail.lesfleursdelanuit.com domain is not verified.');
    answer = 'down';
    await assert.rejects(ask({ op: 'test' }), (e: MailCallError) => e.code === 'unavailable');
    put(GOOD, null);
    await assert.rejects(ask({ op: 'test' }), (e: MailCallError) => e.code === 'not-set-up' && e.message === 'No Resend key has been set.');
  });

  it('keeps under Resend\'s free plan: at most so many an hour', async () => {
    for (let i = 0; i < PER_HOUR; i++) await ask({ op: 'test' });
    await assert.rejects(ask({ op: 'test' }), (e: MailCallError) => e.code === 'full');
    clock += 3601;
    await ask({ op: 'test' });
    assert.equal(asked.length, PER_HOUR + 1);
  });

  it('knows nothing else', async () => {
    for (const op of ['send', 'set-key', 'list']) await assert.rejects(ask({ op }), (e: MailCallError) => e.code === 'invalid', op);
  });
});

// docs/accounts-plan.md step 2: the fixed visitor emails
describe('visitor mail', () => {
  const RESET = 'https://pammy.org/_pammy/reset#tok123';
  it('sends a fixed email, in the site\'s name, to the visitor, linking only into the site', async () => {
    const r = await ask<{ sent: boolean }>({ op: 'visitor', kind: 'reset', to: 'Jo@Example.org', link: RESET });
    assert.equal(r.sent, true);
    const b = asked[0]!.body;
    assert.deepEqual(b.to, ['jo@example.org']);
    assert.equal(b.from, `${PROFILE.name} <${GOOD.from}>`);
    assert.equal(b.reply_to, GOOD.replyTo);
    assert.equal(b.subject, `Choose a new password for ${PROFILE.name}`);
    assert.match(String(b.text), /open this link within an hour\. It works once:\nhttps:\/\/pammy\.org\/_pammy\/reset#tok123\n/);
    assert.match(String(b.text), /If this wasn't you, you can ignore this email\./);
    assert.doesNotMatch(String(b.text), /control panel|panel\.pammy\.org/, 'no panel footer in a visitor email');
    // a subdomain of the site is the site too
    await ask({ op: 'visitor', kind: 'confirm', to: 'jo@example.org', link: 'https://family.pammy.org/_pammy/confirm#x' });
    // a note after the fact carries no link
    await ask({ op: 'visitor', kind: 'deleted', to: 'jo@example.org' });
    assert.doesNotMatch(String(asked[2]!.body.text), /https:/);
  });

  it('refuses anything but its own words and the site\'s own pages', async () => {
    for (const bad of [
      { kind: 'hello', to: 'jo@example.org', link: RESET },
      { kind: 'reset', to: 'not an address', link: RESET },
      { kind: 'reset', to: 'a@b.org, c@d.org', link: RESET },
      { kind: 'reset', to: 'jo@example.org' },
      { kind: 'reset', to: 'jo@example.org', link: 'https://evil.example/_pammy/reset' },
      { kind: 'reset', to: 'jo@example.org', link: 'https://pammy.org.evil.example/_pammy/reset' },
      { kind: 'reset', to: 'jo@example.org', link: 'http://pammy.org/_pammy/reset' },
      { kind: 'reset', to: 'jo@example.org', link: 'https://pammy.org/somewhere-else' },
      { kind: 'reset', to: 'jo@example.org', link: 'https://pammy.org:8443/_pammy/reset' },
      { kind: 'reset', to: 'jo@example.org', link: 'https://user@pammy.org/_pammy/reset' },
      { kind: 'deleted', to: 'jo@example.org', link: RESET },
    ]) await assert.rejects(ask({ op: 'visitor', ...bad }), (e: MailCallError) => e.code === 'invalid', JSON.stringify(bad));
    assert.equal(asked.length, 0);
    // extra fields are simply not used: nothing a caller writes reaches the text
    await ask({ op: 'visitor', kind: 'deleted', to: 'jo@example.org', subject: 'BUY NOW', text: 'spam', username: 'spam' });
    assert.doesNotMatch(JSON.stringify(asked[0]!.body), /BUY NOW|spam/);
  });

  it('5 a day to one address, 40 a day for the site', async () => {
    for (let i = 0; i < 5; i++) await ask({ op: 'visitor', kind: 'reset', to: 'jo@example.org', link: RESET });
    await assert.rejects(ask({ op: 'visitor', kind: 'reset', to: 'JO@example.org', link: RESET }), (e: MailCallError) => e.code === 'full' && /That address/.test(e.message));
    for (let i = 0; i < 35; i++) await ask({ op: 'visitor', kind: 'deleted', to: `p${i}@example.org` });
    await assert.rejects(ask({ op: 'visitor', kind: 'deleted', to: 'late@example.org' }), (e: MailCallError) => e.code === 'full' && /The site has sent/.test(e.message));
    assert.equal((await ask<{ visitorSentToday: number }>({ op: 'status' })).visitorSentToday, 40);
    clock += 86_400;
    await ask({ op: 'visitor', kind: 'deleted', to: 'late@example.org' });
  });

  it('a failed send counts for nothing', async () => {
    answer = 'down';
    await assert.rejects(ask({ op: 'visitor', kind: 'reset', to: 'jo@example.org', link: RESET }), (e: MailCallError) => e.code === 'unavailable');
    answer = { status: 200, body: { id: 'email-2' } };
    assert.equal((await ask<{ visitorSentToday: number }>({ op: 'status' })).visitorSentToday, 0);
  });

  it('samples of every kind go to the notice address, to read them', async () => {
    const r = await ask<{ sent: string[] }>({ op: 'visitor-samples' });
    assert.deepEqual(r.sent, ['confirm', 'reset', 'email-change', 'email-changed', 'already-registered', 'deleted']);
    assert.ok(asked.every((a) => JSON.stringify(a.body.to) === JSON.stringify([GOOD.notifyTo])));
    assert.match(String(asked[0]!.body.subject), /sample visitor email: Confirm your email address/);
  });
});

// docs/accounts-plan.md step 4: the gate's own door (<unit>-visitor.socket) sends
// the fixed visitor emails and nothing else, counted with the panel's door.
describe("the gate's door", () => {
  it('answers only visitor emails, and shares the limits with the panel\'s door', async () => {
    const doors = createMailDoors({ names: { site: PROFILE.name, panel: PROFILE.panelName },
      settings: () => readSettings(join(dir, 'settings.json')), key: () => readKey(join(dir, 'resend.key')),
      fetch: (async (url: string, init: RequestInit) => {
        asked.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: 'email-2' }), { status: 200 });
      }) as typeof fetch,
      panelOrigin: 'https://panel.pammy.org', domain: 'pammy.org', now: () => clock, visitorsPerDay: 2,
    });
    const panelSock = join(dir, 'doors-panel.sock'), gateSock = join(dir, 'doors-gate.sock');
    await new Promise<void>((r) => doors.panel.listen(panelSock, r));
    await new Promise<void>((r) => doors.visitor.listen(gateSock, r));
    try {
      for (const op of [{ op: 'test' }, { op: 'status' }, { op: 'visitor-samples' }, { op: 'notice', subject: 'x', lines: [], link: 'https://panel.pammy.org/' }]) {
        await assert.rejects(callMail(gateSock, op), (e: MailCallError) => e.code === 'invalid' && /Unknown request/.test(e.message), op.op);
      }
      assert.equal(asked.length, 0, 'nothing was sent for them');
      assert.equal((await callMail<{ sent: boolean }>(gateSock, { op: 'visitor', kind: 'reset', to: 'jo@example.org', link: 'https://pammy.org/_pammy/reset#t' })).sent, true);
      // the panel's door still does everything, and counts what the gate's sent
      assert.equal((await callMail<{ visitorSentToday: number }>(panelSock, { op: 'status' })).visitorSentToday, 1);
      await callMail(panelSock, { op: 'visitor', kind: 'deleted', to: 'sam@example.org' });
      await assert.rejects(callMail(gateSock, { op: 'visitor', kind: 'deleted', to: 'kim@example.org' }), (e: MailCallError) => e.code === 'full');
    } finally {
      await new Promise<void>((r) => doors.panel.close(() => r()));
      await new Promise<void>((r) => doors.visitor.close(() => r()));
    }
  });
});
