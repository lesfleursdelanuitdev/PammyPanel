// The round (docs/monitoring-plan.md M2-M4, M6): every 5 minutes in the panel's process,
// one at a time. Collect, step (state.ts), then write what changed: the state rows, the
// changes (kept 90 days), one email for what went down or came back (not for what is
// quiet, at most 10 a day), and when the round ran. Quiet that has ended is said in
// Activity.
import { logActivity, type Actor } from '@panel/core/accounts';
import { all, one, run, tx, type Db, type Sql } from '@panel/core/pg';
import { isQuiet, mailFor, MAIL_PER_DAY, MAILED, step, type Change, type Result, type Row } from '../state.ts';

export const ROUND_EVERY = 5 * 60_000;
export const KEEP_DAYS = 90;             // Q8
export const AGAIN_EVERY = 60;           // Check now: once a minute at most
export const SLOW_EVERY = 3600;          // backups, disk, DNS records: hourly (Q7)

export type Notice = { subject: string; lines: string[]; link: string; key: string };
export type MonitorDeps = {
  db: Sql;
  now: () => number;                     // seconds
  site: string;                          // "lesfleursdelanuit.com": the emails' subject
  origin: string;                        // https://panel.…: the emails' link
  // slow: ask the hourly checks too (the first round, then each hour, and Check now)
  collect: (opts: { slow: boolean; at: number }) => Promise<{ results: Result[]; unread: Set<string> }>;
  mail: ((n: Notice) => Promise<unknown>) | null;
  log?: (msg: string, err?: unknown) => void;
  // after each round: the watchdog's reading that rounds still run (step 3, M6)
  beat?: (s: RoundSummary) => Promise<void>;
};
export type RoundSummary = { at: number; ms: number; checks: number; down: number; changes: number; mail: 'sent' | 'held' | 'quiet' | 'off' | 'none' | 'failed' };

const AUTOMATIC: Actor = { id: null, label: 'monitoring' };
const dayOf = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);

export function createMonitor(d: MonitorDeps) {
  const log = d.log ?? (() => {});
  let busy: Promise<RoundSummary> | null = null;
  let slowAt: number | null = null;

  // quiet that has ended: said once in Activity
  async function endQuiet(q: Db, at: number) {
    const ended = await all<{ id: number; subject: string }>(q, 'SELECT id, subject FROM monitor_quiet WHERE ended_at IS NULL AND until <= ?', at);
    for (const e of ended) {
      await run(q, 'UPDATE monitor_quiet SET ended_at = until WHERE id = ?', e.id);
      await logActivity(q, at, AUTOMATIC, 'monitoring-quiet-ended', e.subject === 'all' ? 'everything' : e.subject, null);
    }
  }

  async function once(everything: boolean): Promise<RoundSummary> {
    const t0 = Date.now();
    const at = d.now();
    const slow = everything || slowAt === null || at - slowAt >= SLOW_EVERY;
    const { results, unread } = await d.collect({ slow, at });
    if (slow) slowAt = at;
    const summary = await tx(d.db, async (q) => {
      await endQuiet(q, at);
      const prev = new Map((await all<Row>(q, 'SELECT * FROM monitor_checks')).map((r) => [r.key, r]));
      const { rows, changes, gone } = step(prev, results, at, unread);
      for (const r of rows) {
        await run(q, `INSERT INTO monitor_checks (key, grp, subject, label, state, fails, since, last_at, why, link, reminded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET grp = EXCLUDED.grp, subject = EXCLUDED.subject, label = EXCLUDED.label, state = EXCLUDED.state,
            fails = EXCLUDED.fails, since = EXCLUDED.since, last_at = EXCLUDED.last_at, why = EXCLUDED.why, link = EXCLUDED.link, reminded_at = EXCLUDED.reminded_at`,
          r.key, r.grp, r.subject, r.label.slice(0, 300), r.state, r.fails, r.since, r.last_at, r.why.slice(0, 500), r.link, r.reminded_at);
      }
      for (const k of gone) await run(q, 'DELETE FROM monitor_checks WHERE key = ?', k);

      // the email: what isn't quiet, if mail is on, within the day's limit
      const quiet = await all<{ subject: string; until: number }>(q, 'SELECT subject, until FROM monitor_quiet WHERE ended_at IS NULL');
      const settings = (await one<{ mail: boolean }>(q, 'SELECT mail FROM monitor_settings WHERE id = 1')) ?? { mail: true };
      const wanted = changes.filter((c) => MAILED.includes(c.kind) && !isQuiet(quiet, c.subject, at));
      const markOf = new Map<Change, string>();
      for (const c of changes) markOf.set(c, !MAILED.includes(c.kind) ? 'no' : isQuiet(quiet, c.subject, at) ? 'quiet' : 'no');
      let mail: RoundSummary['mail'] = wanted.length ? 'none' : changes.some((c) => markOf.get(c) === 'quiet') ? 'quiet' : 'none';
      let notice: Notice | null = null;
      if (wanted.length && (!settings.mail || !d.mail)) mail = 'off';
      else if (wanted.length) {
        const day = dayOf(at);
        await run(q, 'INSERT INTO monitor_mail (day) VALUES (?::date) ON CONFLICT (day) DO NOTHING', day);
        const m = (await one<{ sent: number }>(q, 'SELECT sent FROM monitor_mail WHERE day = ?::date FOR UPDATE', day))!;
        const body = mailFor(wanted, d.site)!;
        if (m.sent >= MAIL_PER_DAY) {
          mail = 'held';
          await run(q, 'UPDATE monitor_mail SET held = held + ? WHERE day = ?::date', wanted.length, day);
          for (const c of wanted) markOf.set(c, 'held');
        } else {
          if (m.sent === MAIL_PER_DAY - 1) body.lines = [...body.lines.slice(0, 9), `This is the last monitoring email today (${MAIL_PER_DAY}). What changes after it is on the panel.`];
          notice = { ...body, link: `${d.origin}/monitoring`, key: `monitoring:${at}:${wanted.map((c) => `${c.kind}:${c.key}`).join(',')}`.slice(0, 250) };
          await run(q, 'UPDATE monitor_mail SET sent = sent + 1 WHERE day = ?::date', day);
          mail = 'sent';
          for (const c of wanted) markOf.set(c, 'sent');
        }
      }
      for (const c of changes) {
        await run(q, 'INSERT INTO monitor_events (key, label, kind, why, at, mail) VALUES (?, ?, ?, ?, ?, ?)',
          c.key, c.label.slice(0, 300), c.kind, c.why.slice(0, 500), c.at, markOf.get(c) ?? 'no');
      }
      await run(q, 'DELETE FROM monitor_events WHERE at < ?', at - KEEP_DAYS * 86_400);
      await run(q, "DELETE FROM monitor_mail WHERE day < (?::date - 30)", dayOf(at));
      await run(q, 'DELETE FROM monitor_quiet WHERE ended_at IS NOT NULL AND ended_at < ?', at - KEEP_DAYS * 86_400);
      const s: RoundSummary = { at, ms: Date.now() - t0, checks: rows.length, down: rows.filter((r) => r.state === 'down').length, changes: changes.length, mail };
      return { s, notice };
    });
    // sent after the rows are written: a failed send is said, and the next change mails again
    if (summary.notice && d.mail) {
      try { await d.mail(summary.notice); } catch (e) { summary.s.mail = 'failed'; log('monitoring email not sent', e); }
    }
    const note = summary.s.mail === 'failed' ? 'the email could not be sent' : null;
    await run(d.db, 'UPDATE monitor_settings SET round_at = ?, round_ms = ?, round_note = ? WHERE id = 1', summary.s.at, Date.now() - t0, note);
    if (d.beat) {
      try { await d.beat(summary.s); } catch (e) { log('the watchdog\'s file not written', e); }
    }
    return summary.s;
  }

  // One round at a time: a second ask while one runs waits for it. all: the hourly
  // checks too, whenever they last ran (Check now).
  function round(opts: { all?: boolean } = {}): Promise<RoundSummary> {
    if (busy) return busy;
    busy = once(opts.all === true).finally(() => { busy = null; });
    return busy;
  }
  return { round };
}
