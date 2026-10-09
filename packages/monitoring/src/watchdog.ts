// The watchdog (docs/monitoring-plan.md M6, step 3, Q6): if the panel itself is down, its
// rounds can't mail that it is. lfdln-watchdog.timer runs this as root every 10 minutes:
// does the panel answer on 127.0.0.1:3046, and did its last round run under 15 minutes
// ago (the file the round writes, PANEL_MONITOR_BEAT)? Two failures in a row (as the
// rounds' own rule: an install's restart mails no one) send one notice through the mail
// service's socket; then one a day while it stays wrong, and one when it's right again.
// Its own state is a file in its StateDirectory. Node's own modules only: it runs from
// the release, outside the panel.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';

export const ROUND_MAX_AGE = 15 * 60;
export const DOWN_AFTER = 2;
export const REMIND_EVERY = 86_400;

export type WatchState = { fails: number; alerted: number | null; why: string | null };
export type Reading = { answers: string | null; round: string | null };   // null: fine; else what's wrong
export type Notice = { subject: string; lines: string[] };

export const FRESH: WatchState = { fails: 0, alerted: null, why: null };

// What this run does: the next state, and a notice to send (the state is kept only if it goes)
export function decide(prev: WatchState, r: Reading, at: number, site: string): { next: WatchState; notice: Notice | null } {
  const why = r.answers ?? r.round;
  if (!why) {
    if (prev.alerted === null) return { next: FRESH, notice: null };
    return { next: FRESH, notice: { subject: `${site}: the panel is back`, lines: ['The panel answers and its checks run again.', `It was: ${prev.why ?? 'not answering'}.`] } };
  }
  const fails = prev.fails + 1;
  if (fails < DOWN_AFTER) return { next: { ...prev, fails, why }, notice: null };
  const first = prev.alerted === null;
  if (!first && at - prev.alerted! < REMIND_EVERY) return { next: { ...prev, fails, why }, notice: null };
  return {
    next: { fails, alerted: at, why },
    notice: {
      subject: `${site}: the panel ${first ? 'is down' : 'is still down'}`,
      lines: [
        `The watchdog: ${why}.`,
        'Its own checks can\'t email while it is like this, so nothing else will tell you.',
        'Look: systemctl status lfdln-panel; journalctl -u lfdln-panel -n 50',
      ],
    },
  };
}

// The round's file: how old its last round is, or what's wrong with it
export function roundAge(text: string | null, at: number): string | null {
  if (text === null) return 'no round of checks recorded yet';
  let beat: { at?: unknown };
  try { beat = JSON.parse(text) as { at?: unknown }; } catch { return 'its round file can\'t be read'; }
  if (typeof beat.at !== 'number') return 'its round file can\'t be read';
  const age = at - beat.at;
  return age > ROUND_MAX_AGE ? `its last round of checks ran ${Math.round(age / 60)} minutes ago` : null;
}

// The panel answers: any HTTP status under 500
function answers(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/login', timeout: 10_000, headers: { 'User-Agent': 'lfdln-watchdog' } }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve(status > 0 && status < 500 ? null : `it answers ${status}`);
    });
    req.once('timeout', () => { req.destroy(); resolve('it doesn\'t answer (10 s)'); });
    req.once('error', (e) => resolve(`it doesn't answer: ${e.message}`));
    req.end();
  });
}

// One notice through the mail service's socket (one JSON line each way)
function send(socket: string, n: Notice & { link: string; key: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = '';
    s.setTimeout(30_000, () => { s.destroy(); reject(new Error('the mail service didn\'t answer')); });
    s.on('connect', () => s.write(`${JSON.stringify({ op: 'notice', ...n })}\n`));
    s.on('data', (c) => { buf += c.toString(); });
    s.on('error', reject);
    s.on('close', () => {
      try {
        const r = JSON.parse(buf.trim()) as { ok?: boolean; error?: string; message?: string };
        if (r.ok === false || r.error) reject(new Error(r.message ?? r.error ?? 'refused')); else resolve();
      } catch { reject(new Error(`the mail service said: ${buf.slice(0, 200)}`)); }
    });
  });
}

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

if (import.meta.main) {
  const env = process.env;
  const need = (k: string) => { if (!env[k]) { console.error(`lfdln-watchdog: ${k} not set`); process.exit(2); } return env[k]!; };
  const [beat, stateFile, socket, origin, site] = ['WATCHDOG_BEAT', 'WATCHDOG_STATE', 'WATCHDOG_MAIL_SOCKET', 'WATCHDOG_ORIGIN', 'WATCHDOG_SITE'].map(need) as [string, string, string, string, string];
  const at = Math.floor(Date.now() / 1000);
  let prev = FRESH;
  try { prev = { ...FRESH, ...JSON.parse(read(stateFile) ?? '{}') as Partial<WatchState> }; } catch { /* a fresh start */ }
  const reading: Reading = { answers: await answers(Number(env.WATCHDOG_PORT ?? 3046)), round: null };
  if (!reading.answers) reading.round = roundAge(read(beat), at);
  const { next, notice } = decide(prev, reading, at, site);
  if (notice) {
    try {
      await send(socket, { ...notice, link: `${origin}/monitoring`, key: `watchdog:${at}` });
      console.log(`lfdln-watchdog: sent "${notice.subject}"`);
    } catch (e) {
      // not kept: the next run tries again
      console.error(`lfdln-watchdog: the notice was not sent: ${(e as Error).message}`);
      writeFileSync(`${stateFile}.new`, JSON.stringify({ ...next, alerted: prev.alerted }));
      renameSync(`${stateFile}.new`, stateFile);
      process.exit(1);
    }
  }
  writeFileSync(`${stateFile}.new`, JSON.stringify(next));
  renameSync(`${stateFile}.new`, stateFile);
  console.log(`lfdln-watchdog: ${reading.answers ?? reading.round ?? 'the panel answers and its rounds run'}${next.fails ? ` (${next.fails} in a row)` : ''}`);
}
