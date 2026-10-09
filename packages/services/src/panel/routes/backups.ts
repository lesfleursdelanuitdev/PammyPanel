// Settings > Backups (docs/lfdln-mariadb-plan.md B1-B4): how long the nightly copies of the
// Studio's databases are kept. Anyone signed in may read the number (the Delete-a-database
// dialog says it); only an admin changes it, with a fresh passkey, since lowering it deletes
// copies at once.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { run } from '@panel/core/pg';
import type { PanelCtx } from '@panel/core/panel/context';
import { BACKUPS } from '../../known.ts';
import { KEEP_MAX, KEEP_MIN } from '../../prune.ts';
import { backupSettings, pruneBackups } from '../backups.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, body, actorOf } = ctx;

  app.get('/api/backups', { config: { needs: 'signed-in' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return { ...await backupSettings(db), min: KEEP_MIN, max: KEEP_MAX, covers: BACKUPS.filter((b) => b.pruned).map((b) => b.title) };
  });

  app.post('/api/backups', { config: { needs: 'admin', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const days = body(req).days;
    if (!Number.isInteger(days) || (days as number) < KEEP_MIN || (days as number) > KEEP_MAX) {
      throw new AccountError(`Keep them for ${KEEP_MIN} to ${KEEP_MAX} days.`, 400);
    }
    const before = (await backupSettings(db)).days;
    if (days === before) return { ...await backupSettings(db), pruned: null };
    await run(db, 'UPDATE backup_settings SET keep_days = ? WHERE id = 1', days as number);
    await logActivity(db, now(), actorOf(a, req), 'backup-days-changed', `${days} days`, `was ${before}`);
    // fewer days: the older copies go now, not within the hour
    if ((days as number) < before && config.servicesSocket) {
      try {
        const r = await pruneBackups(db, config.servicesSocket, now, actorOf(a, req));
        return { ...await backupSettings(db), pruned: r.sets.reduce((n, s) => n + s.deleted, 0) };
      } catch (e) {
        if (e instanceof CallError) return { ...await backupSettings(db), pruned: null, problem: `Saved, but the old copies couldn't be deleted yet (${e.message}). The panel tries again within the hour.` };
        throw e;
      }
    }
    return { ...await backupSettings(db), pruned: null };
  });
}
