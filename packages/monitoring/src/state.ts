// What a round of checks changes (docs/monitoring-plan.md M2): pure, so the tests can
// walk it. A check that fails twice in a row is down, and one pass brings it back; a
// warning is shown and mailed once; a part stopped from the panel (or a host switched
// off) is stopped on purpose, never down. Still down a day later: one reminder a day.
// Quiet (for maintenance) changes nothing here but the mail.

// certs: from the hosts' checks, every round; backups, disk, dns: the slow checks, hourly;
// other: addresses outside the hosts, every round; domain: the registration, hourly, shown
// and never down (Q4: never mailed)
// projects: each project's server, every round (docs/phase8b-plan.md D4-12)
export type Group = 'hosts' | 'services' | 'projects' | 'panel' | 'certs' | 'backups' | 'disk' | 'dns' | 'other' | 'domain';
export const GROUPS: readonly Group[] = ['hosts', 'certs', 'other', 'services', 'projects', 'panel', 'backups', 'disk', 'dns', 'domain'];
export const SLOW: readonly Group[] = ['backups', 'disk', 'dns', 'domain'];
export type State = 'up' | 'down' | 'warn' | 'stopped';

// One check's answer this round. subject: what quiet is set on (a host's address,
// "service:<id>", "panel").
export type Result = {
  key: string; group: Group; subject: string; label: string;
  ok: boolean; why: string; warn?: boolean; stopped?: boolean; link?: string | null;
};
export type Row = {
  key: string; grp: string; subject: string; label: string; state: State; fails: number;
  since: number; last_at: number; why: string; link: string | null; reminded_at: number | null;
};
export type EventKind = 'down' | 'back' | 'warn' | 'stopped' | 'started' | 'still-down';
export type Change = { key: string; subject: string; label: string; kind: EventKind; why: string; at: number };

export const DOWN_AFTER = 2;             // failures in a row
export const REMIND_EVERY = 86_400;      // still down: once a day (Q3)
// what an email is for: the rest is only shown
export const MAILED: readonly EventKind[] = ['down', 'back', 'warn', 'still-down'];

// unread: the groups whose helper didn't answer this round, or that weren't asked (the
// slow ones, between hours), and single checks by key -- their rows stay as they were
// (a failure of the helper, said on its own, not of every check it would have made).
export function step(prev: ReadonlyMap<string, Row>, results: readonly Result[], at: number, unread: ReadonlySet<string> = new Set()): { rows: Row[]; changes: Change[]; gone: string[] } {
  const rows: Row[] = [];
  const changes: Change[] = [];
  const seen = new Set<string>();
  const change = (r: Result, kind: EventKind, why = r.why) => changes.push({ key: r.key, subject: r.subject, label: r.label, kind, why, at });
  for (const r of results) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const p = prev.get(r.key);
    const base = { key: r.key, grp: r.group, subject: r.subject, label: r.label, last_at: at, why: r.why, link: r.link ?? null };
    const was: State = p?.state ?? 'up';
    let state: State;
    let fails = 0;
    if (r.stopped) {
      state = 'stopped';
      if (p && was !== 'stopped') change(r, 'stopped');
    } else if (!r.ok) {
      fails = (p?.fails ?? 0) + 1;
      state = was === 'down' || fails >= DOWN_AFTER ? 'down' : was === 'stopped' ? 'up' : was;
      if (state === 'down' && was !== 'down') change(r, 'down');
    } else if (r.warn) {
      state = 'warn';
      if (was !== 'warn') change(r, was === 'down' ? 'back' : 'warn', r.why);
    } else {
      state = 'up';
      if (was === 'down' || was === 'warn') change(r, 'back', '');
      else if (was === 'stopped' && p) change(r, 'started', '');
    }
    let reminded = state === 'down' ? p?.reminded_at ?? null : null;
    if (state === 'down' && was === 'down') {
      const last = reminded ?? p!.since;
      if (at - last >= REMIND_EVERY) { change(r, 'still-down'); reminded = at; }
    }
    rows.push({ ...base, state, fails, since: state === was && p ? p.since : at, reminded_at: reminded });
  }
  for (const p of prev.values()) if (!seen.has(p.key) && (unread.has(p.grp) || unread.has(p.key))) { seen.add(p.key); rows.push(p); }
  // checks there are no more of (a host deleted): their rows go, with no news
  const gone = [...prev.keys()].filter((k) => !seen.has(k));
  return { rows, changes, gone };
}

// Is this subject quiet now? ("all", or the subject itself)
export const isQuiet = (quiet: readonly { subject: string; until: number }[], subject: string, at: number) =>
  quiet.some((q) => q.until > at && (q.subject === 'all' || q.subject === subject));

// ------------------------------------------------------------------ the email
export const MAIL_PER_DAY = 10;          // Q2: of lfdln-mail's 20

const WORDS: Record<EventKind, string> = {
  down: 'down', back: 'back', warn: 'to look at', stopped: 'stopped', started: 'started', 'still-down': 'still down',
};
const line = (c: Change) => `${c.label}${c.why ? `: ${c.why}` : ''}`.replace(/[\r\n]+/g, ' ').slice(0, 290);

// One email for a round's changes: the subject counts them, a line each (the mail
// service takes 10 lines at most).
export function mailFor(changes: readonly Change[], site: string): { subject: string; lines: string[] } | null {
  const mailed = changes.filter((c) => MAILED.includes(c.kind));
  if (!mailed.length) return null;
  const order: EventKind[] = ['down', 'still-down', 'warn', 'back'];
  const counts = order.map((k) => [k, mailed.filter((c) => c.kind === k).length] as const).filter(([, n]) => n > 0);
  const subject = `${site}: ${counts.map(([k, n]) => `${n} ${WORDS[k]}`).join(', ')}`.slice(0, 150);
  const sorted = order.flatMap((k) => mailed.filter((c) => c.kind === k));
  const lines = sorted.slice(0, 9).map((c) => `${WORDS[c.kind][0]!.toUpperCase()}${WORDS[c.kind].slice(1)}: ${line(c)}`);
  if (sorted.length > 9) lines.push(`And ${sorted.length - 9} more: see the panel.`);
  return { subject, lines };
}
