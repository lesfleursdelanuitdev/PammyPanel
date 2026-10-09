// Monitoring (docs/monitoring-plan.md M5): the page's API. What every check says now,
// the last 7 days of changes, what is quiet, and the day's emails -- for anyone with the
// monitoring right, about the whole site. Check now (once a minute at most) runs a round
// straight away. Quiet for maintenance and mail on/off are for admins, and in Activity.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { all, one, run } from '@panel/core/pg';
import type { PanelCtx } from '@panel/core/panel/context';
import { MAIL_PER_DAY, type Row } from '../../state.ts';
import { AGAIN_EVERY, createMonitor, ROUND_EVERY, type MonitorDeps } from '../monitor.ts';

export const QUIET_HOURS = [1, 4, 24] as const;
const SHOW_DAYS = 7;                     // Q8: the page shows a week

export function routes(app: FastifyInstance, ctx: PanelCtx, deps: Omit<MonitorDeps, 'db' | 'now'>) {
  const { db, now, need, body, idParam, actorOf } = ctx;
  const monitor = createMonitor({ ...deps, db, now });
  let lastAgain = 0;

  const view = async () => {
    const at = now();
    const [checks, events, quiet, settings, mail] = await Promise.all([
      all<Row>(db, 'SELECT * FROM monitor_checks ORDER BY grp, label'),
      all<{ id: number; key: string; label: string; kind: string; why: string; at: number; mail: string }>(db,
        'SELECT id, key, label, kind, why, at, mail FROM monitor_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT 500', at - SHOW_DAYS * 86_400),
      all<{ id: number; subject: string; until: number; created_by: string | null; created_at: number }>(db,
        'SELECT id, subject, until, created_by, created_at FROM monitor_quiet WHERE ended_at IS NULL AND until > ? ORDER BY until', at),
      one<{ mail: boolean; round_at: number | null; round_ms: number | null; round_note: string | null }>(db, 'SELECT * FROM monitor_settings WHERE id = 1'),
      one<{ sent: number; held: number }>(db, 'SELECT sent, held FROM monitor_mail WHERE day = ?::date', new Date(at * 1000).toISOString().slice(0, 10)),
    ]);
    const quietOn = (s: string) => quiet.some((q) => q.subject === 'all' || q.subject === s);
    return {
      every: ROUND_EVERY / 1000,
      round: settings?.round_at ? { at: settings.round_at, ms: settings.round_ms, note: settings.round_note } : null,
      mail: { on: settings?.mail ?? true, sentToday: mail?.sent ?? 0, heldToday: mail?.held ?? 0, perDay: MAIL_PER_DAY },
      checks: checks.map((c) => ({ key: c.key, group: c.grp, subject: c.subject, label: c.label, state: c.state, fails: c.fails, since: c.since, lastAt: c.last_at, why: c.why, link: c.link, quiet: quietOn(c.subject) })),
      events,
      quiet,
      againIn: Math.max(0, AGAIN_EVERY - (at - lastAgain)),
    };
  };

  app.get('/api/monitoring', { config: { needs: 'monitoring', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return view();
  });

  // Check now: a round straight away (a round already running is waited for)
  app.post('/api/monitoring/check', { config: { needs: 'monitoring', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    if (now() - lastAgain < AGAIN_EVERY) throw new AccountError('Checked a moment ago: once a minute at most.', 429);
    lastAgain = now();
    await monitor.round({ all: true });
    return view();
  });

  // Quiet for maintenance: a subject the checks have (or everything), for 1, 4 or 24 hours
  app.post('/api/monitoring/quiet', { config: { needs: 'admin', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const hours = Number(b.hours);
    if (!(QUIET_HOURS as readonly number[]).includes(hours)) throw new AccountError(`Quiet for ${QUIET_HOURS.join(', ')} hours.`, 400);
    const subject = typeof b.subject === 'string' ? b.subject : '';
    if (subject !== 'all' && !await one(db, 'SELECT 1 FROM monitor_checks WHERE subject = ? LIMIT 1', subject)) throw new AccountError('Nothing is checked by that name.', 404);
    const at = now();
    await run(db, 'UPDATE monitor_quiet SET ended_at = ? WHERE ended_at IS NULL AND subject = ?', at, subject);
    await run(db, 'INSERT INTO monitor_quiet (subject, until, created_by, created_at) VALUES (?, ?, ?, ?)', subject, at + hours * 3600, a.user.username, at);
    await logActivity(db, at, actorOf(a, req), 'monitoring-quiet', subject === 'all' ? 'everything' : subject, `for ${hours} hour${hours === 1 ? '' : 's'}`);
    return view();
  });

  app.post('/api/monitoring/quiet/:id/end', { config: { needs: 'admin', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const at = now();
    const q = await one<{ subject: string }>(db, 'UPDATE monitor_quiet SET ended_at = ?, until = ? WHERE id = ? AND ended_at IS NULL RETURNING subject', at, at, idParam(req, 'id'));
    if (!q) throw new AccountError('That is no longer quiet.', 404);
    await logActivity(db, at, actorOf(a, req), 'monitoring-quiet-ended', q.subject === 'all' ? 'everything' : q.subject, null);
    return view();
  });

  // A DNS record that changed on purpose (a new mail provider, new nameservers): keep it
  // as it is now. Its first reading goes, and a round straight away reads and keeps it.
  app.post('/api/monitoring/records/keep', { config: { needs: 'admin', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const key = body(req).key;
    if (typeof key !== 'string' || !/^[a-z0-9-]{1,40}$/.test(key)) throw new AccountError('Which record?', 400);
    const gone = await one<{ key: string }>(db, 'DELETE FROM monitor_baseline WHERE key = ? RETURNING key', key);
    if (!gone) throw new AccountError('That record has nothing kept to change.', 404);
    const label = (await one<{ label: string }>(db, 'SELECT label FROM monitor_checks WHERE key = ?', `dns:${key}`))?.label ?? key;
    await logActivity(db, now(), actorOf(a, req), 'monitoring-record-kept', label, null);
    lastAgain = now();
    await monitor.round({ all: true });
    return view();
  });

  app.post('/api/monitoring/mail', { config: { needs: 'admin', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const on = body(req).on;
    if (typeof on !== 'boolean') throw new AccountError('On or off?', 400);
    await run(db, 'UPDATE monitor_settings SET mail = ? WHERE id = 1', on);
    await logActivity(db, now(), actorOf(a, req), on ? 'monitoring-mail-on' : 'monitoring-mail-off', null, null);
    return view();
  });

  return monitor;
}
