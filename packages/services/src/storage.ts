// The backups and the disk (docs/monitoring-plan.md step 2, M1): the newest nightly dump
// in each backup folder, and the free space of each disk. Read-only: it lists and stats,
// and changes nothing.
//
// The services helper can't read these itself: the backup folders are 700, each its own
// service user's, and the helper holds no capability (so its root can't open them), and
// its sandbox hides /mnt/storage. So it runs this file as a short-lived root unit of its
// own ("lfdln-services-storage-..."), with the folders on stdin -- the ones in known.ts,
// checked again here -- and reads one JSON line back. The tests call the functions directly.
import { readdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export type BackupSet = { id: string; dir: string; prefix: string };
export type Disk = { path: string };
export type StorageTask = { backups: BackupSet[]; disks: Disk[] };

// The newest nightly batch: every dump with the newest stamp (lfdln-appdb makes one per
// database, all with the same stamp). at: the stamp, as seconds.
export type BackupAnswer = { id: string; newest: { at: number; files: number; empty: number; bytes: number } | null; why: string | null };
export type DiskAnswer = { path: string; dev: string | null; size: number; avail: number; why: string | null };
export type StorageAnswer = { backups: BackupAnswer[]; disks: DiskAnswer[] };

const DIR_RE = /^\/var\/lib\/svc-[a-z0-9-]{1,40}\/backups$/;
const PREFIX_RE = /^[a-z0-9_-]{0,40}$/;
const DISK_RE = /^\/(?:[A-Za-z0-9._-]{1,60}(?:\/[A-Za-z0-9._-]{1,60}){0,3})?$/;

export function checkStorageTask(t: unknown): StorageTask {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  if (!Array.isArray(o.backups) || o.backups.length > 10 || !Array.isArray(o.disks) || o.disks.length > 5) throw new Error('backups and disks: two short lists');
  const backups = (o.backups as Record<string, unknown>[]).map((b) => {
    if (typeof b?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.id)) throw new Error('not a backup id');
    if (typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) throw new Error(`not a backup folder: ${String(b.dir).slice(0, 80)}`);
    if (typeof b.prefix !== 'string' || !PREFIX_RE.test(b.prefix)) throw new Error('not a prefix');
    return { id: b.id, dir: b.dir, prefix: b.prefix };
  });
  const disks = (o.disks as Record<string, unknown>[]).map((x) => {
    if (typeof x?.path !== 'string' || !DISK_RE.test(x.path) || x.path.includes('..')) throw new Error('not a disk path');
    return { path: x.path };
  });
  return { backups, disks };
}

// "<prefix><name>-20260927T044500Z-nightly.dump" (Postgres) or "...-nightly.sql.gz" (MariaDB,
// docs/lfdln-mariadb-plan.md M5): the nightly dumps only (not the installer's before-* ones, not
// the roles or accounts files, not a .part left over)
const NIGHTLY_RE = /^([a-z0-9_-]+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-nightly\.(?:dump|sql\.gz)$/;
// lfdln-appmaria's accounts file, written last by each nightly run (after every dump, which
// stops the run if it fails): newer than the newest dump means a run with no databases to dump
const ACCOUNTS_RE = /^accounts-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-nightly\.sql$/;

export function newestNightly(dir: string, prefix: string, files: { name: string; size: number }[]): BackupAnswer['newest'] {
  let best: { at: number; files: { size: number }[] } | null = null;
  for (const f of files) {
    const m = NIGHTLY_RE.exec(f.name);
    if (!m || !f.name.startsWith(prefix)) continue;
    const at = Date.UTC(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!, +m[7]!) / 1000;
    if (!best || at > best.at) best = { at, files: [f] };
    else if (at === best.at) best.files.push(f);
  }
  void dir;
  let ran = -Infinity;
  for (const f of files) {
    const m = prefix === '' ? ACCOUNTS_RE.exec(f.name) : null;
    if (m) ran = Math.max(ran, Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000);
  }
  if (ran > (best?.at ?? -Infinity)) return { at: ran, files: 0, empty: 0, bytes: 0 };
  if (!best) return null;
  return { at: best.at, files: best.files.length, empty: best.files.filter((f) => f.size === 0).length, bytes: best.files.reduce((n, f) => n + f.size, 0) };
}

export function readBackups(b: BackupSet): BackupAnswer {
  try {
    const files = readdirSync(b.dir).flatMap((name) => {
      try { const s = statSync(join(b.dir, name)); return s.isFile() ? [{ name, size: s.size }] : []; } catch { return []; }
    });
    return { id: b.id, newest: newestNightly(b.dir, b.prefix, files), why: null };
  } catch (e) {
    return { id: b.id, newest: null, why: `the folder can't be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

export function readDisk(d: Disk): DiskAnswer {
  try {
    const s = statfsSync(d.path, { bigint: true });
    const dev = String(statSync(d.path).dev);
    return { path: d.path, dev, size: Number(s.blocks * s.bsize), avail: Number(s.bavail * s.bsize), why: null };
  } catch (e) {
    return { path: d.path, dev: null, size: 0, avail: 0, why: `can't be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

export const readStorage = (t: StorageTask): StorageAnswer => ({ backups: t.backups.map(readBackups), disks: t.disks.map(readDisk) });

// As the unit: the task on stdin, one JSON line out
if (import.meta.main) {
  const t = checkStorageTask(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(`${JSON.stringify(readStorage(t))}\n`);
}
