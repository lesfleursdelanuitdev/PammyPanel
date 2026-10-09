// How long the nightly copies of the Studio's databases are kept (docs/lfdln-mariadb-plan.md B2):
// the panel's setting, Settings > Backups. The backup scripts make the copies; this deletes the
// ones older than the setting, in the folders known.ts marks prunable.
//
// Like storage.ts, the services helper can't do it itself (the folders are 700, each its own
// service user's, and the helper holds no capability), so it runs this file as a short-lived
// root unit ("lfdln-services-prune-..."), with the folders and the days on stdin -- checked again
// here -- and reads one JSON line back. It deletes only files named as a backup is
// ("<name>-<stamp>-<label>.dump|.sql|.sql.gz"), never the newest nightly batch whatever its age,
// and nothing else in the folder. The tests call the functions directly.
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_MIN = 7;
export const KEEP_MAX = 365;
export const KEEP_DEFAULT = 60;

export type PruneSet = { id: string; dir: string };
export type PruneTask = { sets: PruneSet[]; days: number };
export type PruneAnswer = { sets: { id: string; deleted: number; bytes: number; kept: number; why: string | null }[] };

const DIR_RE = /^\/var\/lib\/svc-[a-z0-9-]{1,40}\/backups$/;
// "tutorstar-20260927T050001Z-nightly.dump", "roles-...-before-switch-tutorstar.sql", "notes-...-nightly.sql.gz"
const BACKUP_RE = /^[a-z0-9_.-]+?-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([a-z0-9][a-z0-9.-]{0,60})\.(?:dump|sql|sql\.gz)$/;

export function checkPruneTask(t: unknown): PruneTask {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  if (!Number.isInteger(o.days) || (o.days as number) < KEEP_MIN || (o.days as number) > KEEP_MAX) throw new Error(`days: a whole number from ${KEEP_MIN} to ${KEEP_MAX}`);
  if (!Array.isArray(o.sets) || o.sets.length > 10) throw new Error('sets: a short list');
  const sets = (o.sets as Record<string, unknown>[]).map((b) => {
    if (typeof b?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.id)) throw new Error('not a backup id');
    if (typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) throw new Error(`not a backup folder: ${String(b.dir).slice(0, 80)}`);
    return { id: b.id, dir: b.dir };
  });
  return { sets, days: o.days as number };
}

// The stamp a backup's name carries (seconds), or null for anything that isn't a backup's name
export function stampOf(name: string): { at: number; label: string } | null {
  const m = BACKUP_RE.exec(name);
  if (!m) return null;
  return { at: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000, label: m[7]! };
}

// Which of these files go: older than `days` before `now` (seconds), and not of the newest
// nightly batch (so a folder whose backups stopped keeps its last good copy)
export function toDelete(names: string[], days: number, now: number): string[] {
  const stamps = names.map((n) => ({ n, s: stampOf(n) })).filter((x): x is { n: string; s: { at: number; label: string } } => !!x.s);
  const newestNightly = Math.max(-Infinity, ...stamps.filter((x) => x.s.label === 'nightly').map((x) => x.s.at));
  const before = now - days * 86_400;
  return stamps.filter((x) => x.s.at < before && x.s.at !== newestNightly).map((x) => x.n);
}

export function prune(task: PruneTask, now = Date.now() / 1000): PruneAnswer {
  return {
    sets: task.sets.map(({ id, dir }) => {
      try {
        const names = readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isFile(); } catch { return false; } });
        let deleted = 0, bytes = 0;
        for (const n of toDelete(names, task.days, now)) {
          const size = statSync(join(dir, n)).size;
          unlinkSync(join(dir, n));
          deleted++; bytes += size;
        }
        return { id, deleted, bytes, kept: names.filter((n) => stampOf(n)).length - deleted, why: null };
      } catch (e) {
        return { id, deleted: 0, bytes: 0, kept: 0, why: `the folder can't be pruned: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
      }
    }),
  };
}

// As the unit: the task on stdin, one JSON line out
if (import.meta.main) {
  const t = checkPruneTask(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(`${JSON.stringify(prune(t))}\n`);
}
