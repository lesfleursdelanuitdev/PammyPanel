// The panel's email notices (docs/apps-plan.md phase 3, M3): once a minute,
// what arrived at the gate since the last look, and an email for each thing
// the account managers asked to be told about -- a new response to a chosen
// form, a comment waiting for approval in a chosen comment area, a new request
// to open a protected folder. pammy-mail sends it, to the notice address only.
//
// What an email says is the least that is useful: which form, which page,
// which folder, and a link into the panel. Never the answer itself, a
// visitor's name or contact: mail goes through Resend, in the US.
//
// The first look only notes where things stand. When mail isn't set up the
// look still moves on, so setting it up later doesn't send a pile of old news.
// When Resend can't be reached, it stops there and tries again next minute,
// for up to an hour; the same event never goes twice (its idempotency key).
import { one, run, type Sql } from '@panel/core/pg';

export type NoticeResponse = { id: number; formId: number | null; formName: string; formTitle: string | null; kind: string | null; page: string; createdAt: number; waiting: boolean };
export type NoticeRequest = { id: number; kind: string; area: string | null; createdAt: number };
export type Since = { responses: NoticeResponse[]; requests: NoticeRequest[]; last: { responses: number; requests: number } };
export type Notice = { key: string; subject: string; lines: string[]; link: string };

type Row = {
  forms: string; comment_areas: string; requests: boolean;
  seen_response: number | null; seen_request: number | null;
};

export const NOTICE_EVERY = 60_000;
const MAX_PER_LOOK = 10;
const STALE = 3600;

const ids = (s: string) => { try { const v = JSON.parse(s); return new Set(Array.isArray(v) ? v.filter(Number.isSafeInteger) : []); } catch { return new Set<number>(); } };
// a page or folder as it goes into a line of text: one line, not too long
const plain = (s: string | null, max = 120) => (s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);

export function noticeFor(e: { response?: NoticeResponse; request?: NoticeRequest }, origin: string): Notice {
  if (e.response) {
    const r = e.response;
    const title = plain(r.formTitle || r.formName, 80);
    if (r.kind === 'comments') {
      return {
        key: `response:${r.id}`, subject: `a comment is waiting for your OK (${title})`,
        lines: [`A new comment on ${plain(r.page)} is waiting for your OK. Nobody else sees it until you approve it.`],
        link: `${origin}/comments`,
      };
    }
    return {
      key: `response:${r.id}`, subject: `a new response to "${title}"`,
      lines: [`Someone filled in "${title}" on ${plain(r.page)}.`],
      link: r.formId ? `${origin}/responses?form=${r.formId}` : `${origin}/responses`,
    };
  }
  const q = e.request!;
  const area = plain(q.area, 80) || 'a protected folder';
  return q.kind === 'reset'
    ? { key: `request:${q.id}`, subject: `someone forgot their password for ${area}`, lines: [`Someone who can open ${area} asked for a new password.`], link: `${origin}/requests` }
    : { key: `request:${q.id}`, subject: `someone asked to open ${area}`, lines: [`Someone asked to be let into ${area}.`], link: `${origin}/requests` };
}

export class Notifier {
  db: Sql;
  gate: <T>(req: Record<string, unknown>) => Promise<T>;
  mail: <T>(req: Record<string, unknown>) => Promise<T>;
  origin: string;
  now: () => number;
  log: (msg: string, err?: unknown) => void = () => {};
  private busy = false;

  constructor(db: Sql, gate: Notifier['gate'], mail: Notifier['mail'], origin: string, now: () => number) {
    this.db = db;
    this.gate = gate;
    this.mail = mail;
    this.origin = origin;
    this.now = now;
  }

  private async problem(words: string | null) {
    await run(this.db, 'UPDATE mail_notices SET last_problem = ?, last_problem_at = ? WHERE id = 1', words, words ? this.now() : null);
  }

  // One look. Returns how many were sent (for the tests and the log).
  async look(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const row = await one<Row>(this.db, 'SELECT forms, comment_areas, requests, seen_response, seen_request FROM mail_notices WHERE id = 1');
      if (!row) return 0;
      const first = row.seen_response === null || row.seen_request === null;
      const since = await this.gate<Since>({ op: 'notices.since', responses: first ? null : row.seen_response, requests: first ? null : row.seen_request });
      const forms = ids(row.forms);
      const areas = ids(row.comment_areas);
      const wanted: (Notice & { at: number; seen: { responses: number; requests: number } })[] = [];
      let seen = { responses: row.seen_response ?? 0, requests: row.seen_request ?? 0 };
      // in the order they arrived, each carrying how far the look has got with it
      const events = [
        ...since.responses.map((r) => ({ at: r.createdAt, id: r.id, response: r })),
        ...since.requests.map((q) => ({ at: q.createdAt, id: q.id, request: q })),
      ].sort((a, b) => a.at - b.at || a.id - b.id);
      for (const e of events) {
        seen = 'response' in e ? { ...seen, responses: e.id } : { ...seen, requests: e.id };
        const want = 'response' in e
          ? (e.response.kind === 'comments' ? e.response.waiting && e.response.formId !== null && areas.has(e.response.formId)
            : e.response.formId !== null && forms.has(e.response.formId))
          : row.requests;
        if (want) wanted.push({ ...noticeFor(e, this.origin), at: e.at, seen: { ...seen } });
      }
      const save = (s: { responses: number; requests: number }) =>
        run(this.db, 'UPDATE mail_notices SET seen_response = ?, seen_request = ? WHERE id = 1', s.responses, s.requests);
      const all = first ? since.last : { responses: Math.max(seen.responses, since.last.responses), requests: Math.max(seen.requests, since.last.requests) };
      if (first || wanted.length === 0) { await save(all); return 0; }

      const status = await this.mail<{ ready: boolean; why: string | null }>({ op: 'status' }).catch(() => null);
      if (status && !status.ready) {
        // not set up: nothing is kept back to send later
        await save(all);
        await this.problem(`${wanted.length === 1 ? 'A notice was' : `${wanted.length} notices were`} not sent: ${status.why ?? 'mail is not set up.'}`);
        return 0;
      }
      let sent = 0;
      for (const n of wanted.slice(0, MAX_PER_LOOK)) {
        try {
          await this.mail({ op: 'notice', subject: n.subject, lines: n.lines, link: n.link, key: n.key });
          sent++;
          await save(n.seen);
        } catch (e) {
          const words = (e as Error).message;
          if (this.now() - n.at > STALE) {
            // too old to be worth trying again: past it, and say so
            await save(n.seen);
            await this.problem(`A notice could not be sent and was given up after an hour: ${words}`);
            continue;
          }
          await this.problem(`A notice could not be sent yet (it will be tried again): ${words}`);
          this.log('a notice could not be sent', e);
          return sent;
        }
      }
      if (wanted.length > MAX_PER_LOOK) {
        // a flood (a spam wave on a form): one line for the rest, then past them all
        await this.mail({ op: 'notice', subject: `${wanted.length - MAX_PER_LOOK} more new things`, lines: [`And ${wanted.length - MAX_PER_LOOK} more, which were not sent one by one.`], link: `${this.origin}/responses` }).catch(() => null);
      }
      await save(all);
      await run(this.db, 'UPDATE mail_notices SET last_sent_at = ?, last_problem = NULL, last_problem_at = NULL WHERE id = 1', this.now());
      return sent;
    } finally {
      this.busy = false;
    }
  }
}
