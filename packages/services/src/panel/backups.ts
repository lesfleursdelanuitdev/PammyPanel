// How long the nightly copies of the Studio's databases are kept (docs/lfdln-mariadb-plan.md B):
// the setting, and pruning by it -- every hour from the server, and at once when an admin
// lowers it. The helper deletes (prune.ts, a root unit); this asks it and writes down what
// happened, in the setting's row and, when something went, in Activity.
import { logActivity } from '@panel/core/accounts';
import { one, run, type Db } from '@panel/core/pg';
import { callServices } from '../client.ts';
import type { PruneAnswer } from '../prune.ts';

export type BackupSettings = { days: number; prunedAt: number | null; prunedNote: string | null };

export async function backupSettings(db: Db): Promise<BackupSettings> {
  const r = await one<{ keep_days: number; pruned_at: number | null; pruned_note: string | null }>(db, 'SELECT keep_days, pruned_at, pruned_note FROM backup_settings WHERE id = 1');
  return { days: r?.keep_days ?? 60, prunedAt: r?.pruned_at === null || r?.pruned_at === undefined ? null : Number(r.pruned_at), prunedNote: r?.pruned_note ?? null };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

// One prune by today's setting. Throws when the helper can't (the caller logs it).
export async function pruneBackups(db: Db, socket: string, now: () => number, actor: { id: number | null; label: string }): Promise<PruneAnswer> {
  const { days } = await backupSettings(db);
  const a = await callServices<PruneAnswer>(socket, { op: 'prune', days, actor: actor.label });
  const deleted = a.sets.reduce((n, s) => n + s.deleted, 0);
  const bytes = a.sets.reduce((n, s) => n + s.bytes, 0);
  const failed = a.sets.filter((s) => s.why);
  const note = [
    deleted ? `${deleted} older than ${days} days deleted (${mb(bytes)})` : `nothing older than ${days} days`,
    ...failed.map((s) => `${s.id}: ${s.why}`),
  ].join('; ').slice(0, 500);
  await run(db, 'UPDATE backup_settings SET pruned_at = ?, pruned_note = ? WHERE id = 1', now(), note);
  if (deleted) await logActivity(db, now(), actor, 'backups-pruned', `${deleted} database ${deleted === 1 ? 'copy' : 'copies'}`, `older than ${days} days, ${mb(bytes)}`);
  return a;
}
