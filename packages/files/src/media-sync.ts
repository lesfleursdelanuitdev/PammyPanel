// Keeping the media records in step with the media folders (docs/media-plan.md D16).
// Files also change outside the panel (WinSCP, Claude on the server), so a sync
// asks the helper for every file's path, size and modified time and compares:
//   - a path it knows whose size or time changed: the content changed (new hash later);
//   - a path that had gone missing and is back: the same record again;
//   - a new path with the same content as a record that has gone: a move, so the
//     record keeps its id and labels (by hash; a file too new to have one yet
//     matches on name, size and modified time instead);
//   - any other new path: a new record, "found", nobody named as who added it;
//   - a known path that has gone: missing, kept 30 days in case it comes back.
// Hashes are worked out a little at a time after each sync (fillHashes), so a
// move can be recognised later without reading big videos on every sync.
//
// Media changes made through the panel run under the same lock (withLock), so
// a sync never sees half of a move.
import { posix } from 'node:path';
import {
  insertRecord, moveRecord, placeOf, purgeRecords, setSyncState, syncState, type CreatedLabels, type MediaRow,
} from './media-db.ts';
import { all, one, run, tx, type Db, type Sql } from '@panel/core/pg';
import { ensureAutomaticScopes } from '@panel/catalog/scopes';
import { callSiteFs } from './sitefs/client.ts';

export type ScannedFile = { path: string; size: number; modifiedAt: number };
export type Scan = { files: ScannedFile[]; strays: string[]; truncated: boolean };
export type SyncSummary = {
  at: number; files: number; found: number; moved: number; changed: number; back: number; missing: number; purged: number;
  hashed: number; strays: string[]; truncated: boolean;
};

// Opening the Media page syncs first if the last sync is older than this.
export const STALE_AFTER = 5 * 60;
// Hashes worked out after each sync: at most this many bytes and files (the CLI can ask for all).
export const HASH_BUDGET = { bytes: 1024 * 1024 * 1024, files: 2000 };

type Plan = {
  changed: { row: MediaRow; f: ScannedFile }[];
  back: { row: MediaRow; f: ScannedFile }[];
  moved: { row: MediaRow; f: ScannedFile; hash: string | null }[];
  found: ScannedFile[];
  gone: MediaRow[];
  needHash: string[];
};

// What a scan means for the records. Pure: run once to learn which new files
// need a hash, and again (inside the transaction) with those hashes.
export function planSync(rows: MediaRow[], scan: Scan, hashes: Map<string, string>): Plan {
  const plan: Plan = { changed: [], back: [], moved: [], found: [], gone: [], needHash: [] };
  const present = new Map<string, MediaRow>();
  const missing = new Map<string, MediaRow[]>();
  for (const r of rows) {
    if (r.state === 'present') present.set(r.path, r);
    else if (r.state === 'missing') missing.set(r.path, [...(missing.get(r.path) ?? []), r].sort((a, b) => (b.state_at ?? 0) - (a.state_at ?? 0)));
  }
  const used = new Set<number>();
  const fresh: ScannedFile[] = [];
  for (const f of scan.files) {
    if (!placeOf(f.path)) continue;
    const p = present.get(f.path);
    if (p) {
      used.add(p.id);
      if (p.size !== f.size || p.modified_at !== f.modifiedAt) plan.changed.push({ row: p, f });
      continue;
    }
    const m = missing.get(f.path)?.find((r) => !used.has(r.id));
    if (m) { used.add(m.id); plan.back.push({ row: m, f }); continue; }
    fresh.push(f);
  }
  // A cut-short scan can't say what's gone: only records already missing can be matched.
  const seen = new Set(scan.files.map((f) => f.path));
  const goneNow = scan.truncated ? [] : rows.filter((r) => r.state === 'present' && !seen.has(r.path));
  const candidates = [...goneNow, ...rows.filter((r) => r.state === 'missing' && !used.has(r.id))];
  const bySize = new Map<number, MediaRow[]>();
  for (const r of candidates) bySize.set(r.size, [...(bySize.get(r.size) ?? []), r]);
  for (const f of fresh) {
    const cands = (bySize.get(f.size) ?? []).filter((r) => !used.has(r.id));
    if (!cands.length) { plan.found.push(f); continue; }
    let match: MediaRow | undefined;
    const hash = hashes.get(f.path) ?? null;
    if (cands.some((r) => r.hash)) {
      if (hash === null) plan.needHash.push(f.path);
      else match = cands.find((r) => r.hash === hash);
    }
    match ??= cands.find((r) => !r.hash && r.name === posix.basename(f.path) && r.modified_at === f.modifiedAt);
    if (match) { used.add(match.id); plan.moved.push({ row: match, f, hash }); } else plan.found.push(f);
  }
  plan.gone = goneNow.filter((r) => !used.has(r.id));
  return plan;
}

export class MediaSync {
  readonly db: Sql;
  readonly socket: string;
  readonly now: () => number;
  // told about each sync that changed something (the panel logs it as activity)
  onChange: ((s: SyncSummary, actor: string) => void) | null = null;
  // told when a round of hashes is done (the thumbnails wait for them)
  onHashed: (() => void) | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #running: Promise<SyncSummary> | null = null;
  #hashing: Promise<number> | null = null;

  constructor(db: Sql, socket: string, now: () => number) {
    this.db = db;
    this.socket = socket;
    this.now = now;
  }

  // One media change (or sync) at a time, in the order they came.
  withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async last(): Promise<SyncSummary | null> {
    return await syncState<SyncSummary>(this.db, 'last');
  }

  // A sync (two at once share the first), then some hashes in the background,
  // so opening Media never waits for a video to be read. The command line waits
  // for them (waitForHashes), and says how many.
  sync(actor: string, opts: { hashBudget?: { bytes: number; files: number }; waitForHashes?: boolean } = {}): Promise<SyncSummary> {
    this.#running ??= this.withLock(() => this.syncLocked(actor)).finally(() => { this.#running = null; });
    const run = this.#running;
    const hashed = run.then(() => this.hashSoon(opts.hashBudget ?? HASH_BUDGET), () => 0);
    return opts.waitForHashes ? run.then(async (s) => ({ ...s, hashed: await hashed })) : run;
  }

  // Hashes being worked out now, if any (tests wait for them).
  hashSoon(budget = HASH_BUDGET): Promise<number> {
    this.#hashing ??= this.fillHashes(budget).catch(() => 0).finally(() => {
      this.#hashing = null;
      try { this.onHashed?.(); } catch { /* the thumbnails' business */ }
    });
    return this.#hashing;
  }
  get hashing(): Promise<number> {
    return this.#hashing ?? Promise.resolve(0);
  }

  async syncIfStale(actor: string, maxAge = STALE_AFTER): Promise<SyncSummary | null> {
    const last = await this.last();
    if (last && this.now() - last.at < maxAge) return null;
    return this.sync(actor);
  }

  // The sync itself; only call it holding the lock (the restore route does, for
  // things trashed before the media records existed).
  async syncLocked(actor: string): Promise<SyncSummary> {
    const scan = await callSiteFs<Scan>(this.socket, { op: 'media-scan', actor }, 60_000);
    const rowsNow = (q = this.db as Db) => all<MediaRow>(q, "SELECT * FROM records WHERE state IN ('present', 'missing')");
    const hashes = new Map<string, string>();
    for (const path of planSync(await rowsNow(), scan, hashes).needHash.slice(0, 500)) {
      try {
        const h = await callSiteFs<{ hash: string }>(this.socket, { op: 'files-hash', path, actor }, 120_000);
        hashes.set(path, h.hash);
      } catch { /* changed or gone meanwhile: it'll be "found" this time */ }
    }
    const now = this.now();
    const s = await tx(this.db, async (q) => {
      const plan = planSync(await rowsNow(q), scan, hashes);
      const created: CreatedLabels = { tags: [], categories: [] };
      for (const { row, f } of plan.changed) {
        await run(q, 'UPDATE files SET size = ?, modified_at = ?, hash = NULL WHERE item_id = ?', f.size, f.modifiedAt, row.id);
        await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', now, row.id);
      }
      for (const { row, f } of plan.back) {
        const same = row.size === f.size && row.modified_at === f.modifiedAt;
        await run(q, "UPDATE items SET state = 'present', state_at = ?, changed_at = ? WHERE id = ?", now, now, row.id);
        await run(q, 'UPDATE files SET size = ?, modified_at = ?, hash = ? WHERE item_id = ?', f.size, f.modifiedAt, same ? row.hash : null, row.id);
      }
      for (const { row, f, hash } of plan.moved) {
        await moveRecord(q, row, f.path, now, null, created, { size: f.size, modified_at: f.modifiedAt, hash: hash ?? row.hash });
      }
      for (const f of plan.found) {
        const place = placeOf(f.path)!;
        const n = await one<{ added_by: string; added_at: number; how: string }>(q, 'SELECT * FROM imported_notes WHERE path = ?', f.path);
        await insertRecord(q, now, {
          path: f.path, ...place, size: f.size, modifiedAt: f.modifiedAt, addedAt: n?.added_at ?? f.modifiedAt, addedBy: n?.added_by ?? null,
          how: (n?.how ?? 'found') as 'uploaded' | 'copied' | 'found', stateAt: now,
        });
        if (n) await run(q, 'DELETE FROM imported_notes WHERE path = ?', f.path);
      }
      await ensureAutomaticScopes(q, now);
      for (const row of plan.gone) {
        await run(q, "UPDATE items SET state = 'missing', state_at = ?, changed_at = ? WHERE id = ?", now, now, row.id);
      }
      const summary: SyncSummary = {
        at: now, files: scan.files.length, found: plan.found.length, moved: plan.moved.length, changed: plan.changed.length,
        back: plan.back.length, missing: plan.gone.length, purged: await purgeRecords(q, now), hashed: 0, strays: scan.strays, truncated: scan.truncated,
      };
      await setSyncState(q, 'last', summary);
      return summary;
    });
    if (s.found || s.moved || s.changed || s.back || s.missing || s.purged) {
      try { this.onChange?.(s, actor); } catch { /* logging only */ }
    }
    return s;
  }

  // Hashes for records that don't have one yet, smallest first, within a budget.
  // Outside the lock: each is saved only if the record still matches the file
  // that was read.
  async fillHashes(budget: { bytes: number; files: number }): Promise<number> {
    const rows = await all<{ id: number; path: string; size: number }>(this.db,
      "SELECT id, path, size FROM records WHERE state = 'present' AND hash IS NULL ORDER BY size, id LIMIT ?", Math.min(budget.files, 100_000));
    let spent = 0;
    let n = 0;
    for (const r of rows) {
      if (n > 0 && spent + r.size > budget.bytes) break;
      spent += r.size;
      try {
        const h = await callSiteFs<{ hash: string; size: number; modifiedAt: number }>(this.socket, { op: 'files-hash', path: r.path, actor: 'media sync' }, 120_000);
        const ch = await run(this.db, `UPDATE files f SET hash = ? FROM items i
          WHERE f.item_id = ? AND i.id = f.item_id AND i.key = ? AND f.size = ? AND f.modified_at = ? AND i.state = 'present' AND f.hash IS NULL`,
          h.hash, r.id, r.path, h.size, h.modifiedAt);
        if (ch) n++;
      } catch { /* gone or changed: the next sync sorts it out */ }
    }
    return n;
  }
}

// "3 new, 1 moved, 2 missing" for the activity log and the command line.
export function describeSync(s: SyncSummary): string {
  const parts = [
    s.found && `${s.found} new`, s.moved && `${s.moved} moved`, s.changed && `${s.changed} changed`, s.back && `${s.back} back`,
    s.missing && `${s.missing} missing`, s.purged && `${s.purged} forgotten after 30 days`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no changes';
}
