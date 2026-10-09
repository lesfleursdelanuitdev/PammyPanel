// Thumbnails for media records (docs/media-plan.md D18). The panel never decodes
// a file itself: it asks pammy-thumbs (a sandboxed service of its own) for each
// one, and keeps what comes back as <thumbs dir>/<id>-<hash>.webp, plus a row in
// the thumbs table. Keyed by record id, so a move or rename needs no new
// thumbnail; remade when the content (its hash) changes. Files that aren't
// pictures, videos, audio or PDFs get an icon without asking anyone.
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallError, callJsonLine } from '@panel/core/jsonline';
import { all, one, run, type Sql } from '@panel/core/pg';
import { hasPicture, iconFor, type IconName } from './thumbs/icons.ts';

// The part of a catalogued file the thumbnails need (the files module's records
// have more; docs/catalog-plan.md: Thumbnails don't depend on File Explorer).
export type ThumbSource = { id: number; hash: string | null; kind: string; name: string; path: string };

export type ThumbRow = { media_id: number; hash: string; result: 'picture' | 'icon'; icon: IconName; width: number | null; height: number | null; why: string | null; made_at: number };
// What the pages get for each file: a picture's address, or the icon to show (null: not made yet).
export type ThumbInfo = { src: string; icon: IconName; width: number | null; height: number | null } | { src: null; icon: IconName } | null;

const FILE_RE = /^(\d+)-([0-9a-f]{64})\.webp$/;
const BATCH = 200;

// a row as the code has always named it (media_id: the item's id)
const COLS = 'item_id AS media_id, hash, result, icon, width, height, why, made_at';

export class Thumbnailer {
  readonly db: Sql;
  readonly socket: string;
  readonly dir: string;
  readonly now: () => number;
  log: (msg: string, err?: unknown) => void = () => {};
  // told when a run made some (the media API's index names them)
  onMade: (() => void) | null = null;
  #wanted = new Set<number>();
  #running: Promise<number> | null = null;

  constructor(db: Sql, socket: string, dir: string, now: () => number) {
    this.db = db;
    this.socket = socket;
    this.dir = dir;
    this.now = now;
  }

  // (thumbs.thumbs is keyed by the catalog's item, which is the record's id: docs/catalog-plan.md step 2)
  fileOf(id: number, hash: string) {
    return join(this.dir, `${id}-${hash}.webp`);
  }

  // A thumbnail row that fits the record's content as it is now.
  async current(r: Pick<ThumbSource, 'id' | 'hash'>): Promise<ThumbRow | undefined> {
    if (!r.hash) return undefined;
    return await one<ThumbRow>(this.db, `SELECT ${COLS} FROM thumbs WHERE item_id = ? AND hash = ?`, r.id, r.hash);
  }

  // What the pages show for a record, given its thumbnail row (none: not made yet).
  infoWith(r: Pick<ThumbSource, 'id' | 'hash' | 'kind' | 'name'>, row: ThumbRow | undefined): ThumbInfo {
    if (!row) return hasPicture(r.kind, r.name) ? null : { src: null, icon: iconFor(r.kind, r.name) };
    if (row.result === 'icon') return { src: null, icon: row.icon };
    return { src: `/api/media/thumb/${r.id}?v=${row.hash.slice(0, 12)}`, icon: row.icon, width: row.width, height: row.height };
  }

  async info(r: Pick<ThumbSource, 'id' | 'hash' | 'kind' | 'name'>): Promise<ThumbInfo> {
    return this.infoWith(r, await this.current(r));
  }

  // Thumbnails for many records at once (a folder's list).
  async infoFor(rows: readonly ThumbSource[]): Promise<Map<number, ThumbInfo>> {
    const got = new Map<number, ThumbRow>();
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id);
      if (!ids.length) break;
      for (const t of await all<ThumbRow>(this.db, `SELECT ${COLS} FROM thumbs WHERE item_id IN (${ids.map(() => '?').join(',')})`, ...ids)) got.set(t.media_id, t);
    }
    return new Map(rows.map((r) => {
      const t = got.get(r.id);
      return [r.id, this.infoWith(r, t && t.hash === r.hash ? t : undefined)];
    }));
  }

  // Make what's missing: these records first, then any others waiting. Returns
  // how many were made; one run at a time (a second call joins the first).
  kick(ids: number[] = []): Promise<number> {
    for (const id of ids) this.#wanted.add(id);
    // never a stray rejection: a run in the background can outlive the database (shutting down)
    this.#running ??= this.#run().catch((e: unknown) => { this.log('thumbnails stopped', e); return 0; })
      .then((n) => { if (n) try { this.onMade?.(); } catch { /* the index's business */ } return n; })
      .finally(() => { this.#running = null; });
    return this.#running;
  }

  get running(): Promise<number> {
    return this.#running ?? Promise.resolve(0);
  }

  async #run(): Promise<number> {
    let made = 0;
    for (;;) {
      const first = [...this.#wanted];
      this.#wanted.clear();
      const waiting = await all<{ id: number }>(this.db, `SELECT m.id FROM records m LEFT JOIN thumbs t ON t.item_id = m.id
        WHERE m.state = 'present' AND m.hash IS NOT NULL AND (t.item_id IS NULL OR t.hash <> m.hash) ORDER BY m.id DESC LIMIT ?`, BATCH);
      const ids = [...new Set([...first, ...waiting.map((w) => w.id)])];
      if (!ids.length) return made;
      let progress = 0;
      for (const id of ids) {
        const r = await one<ThumbSource>(this.db, "SELECT * FROM records WHERE id = ? AND state = 'present'", id);
        if (!r?.hash || await this.current(r)) continue;
        try {
          await this.#make(r as ThumbSource & { hash: string });
          made++;
          progress++;
        } catch (e) {
          // the service isn't answering: try again next time, and leave the rest waiting
          this.log('thumbnail service unavailable; will try again later', e);
          return made;
        }
      }
      if (!progress && !this.#wanted.size) return made;
    }
  }

  // One record's thumbnail now, whatever else is waiting (pammy-panel media-thumbs --only).
  async makeOne(id: number): Promise<ThumbRow | undefined> {
    const r = await one<ThumbSource>(this.db, "SELECT * FROM records WHERE id = ? AND state = 'present'", id);
    if (!r?.hash) return undefined;
    await this.#make(r as ThumbSource & { hash: string });
    return await this.current(r);
  }

  async #make(r: ThumbSource & { hash: string }) {
    const hash = r.hash;
    const icon = iconFor(r.kind, r.name);
    let row: Omit<ThumbRow, 'media_id' | 'hash' | 'made_at'>;
    if (!hasPicture(r.kind, r.name)) {
      row = { result: 'icon', icon, width: null, height: null, why: null };
    } else {
      let t: { webp?: string; width?: number; height?: number; icon?: IconName; why?: string };
      try {
        t = await callJsonLine(this.socket, { op: 'thumb', path: r.path, kind: r.kind, actor: 'panel' }, 'thumbnail service', 60_000);
      } catch (e) {
        if (e instanceof CallError && e.code !== 'unavailable' && e.code !== 'timeout' && e.code !== 'internal') {
          // gone, or not a media file after all: an icon, until its content changes
          t = { icon, why: e.message };
        } else throw e;
      }
      if (t.webp) {
        const bytes = Buffer.from(t.webp, 'base64');
        if (bytes.length > 2 * 1024 * 1024 || bytes.toString('latin1', 8, 12) !== 'WEBP') throw new Error('the thumbnail service sent something odd');
        mkdirSync(this.dir, { recursive: true, mode: 0o750 });
        const tmp = join(this.dir, `.${r.id}-${hash}.tmp`);
        // readable by the gate's group too, which serves them for the media API (M8)
        writeFileSync(tmp, bytes, { mode: 0o640 });
        chmodSync(tmp, 0o640);          // the service's umask would take the group's read away
        renameSync(tmp, this.fileOf(r.id, hash));
        row = { result: 'picture', icon, width: t.width ?? null, height: t.height ?? null, why: null };
      } else {
        row = { result: 'icon', icon: t.icon ?? icon, width: null, height: null, why: t.why ?? null };
      }
    }
    const before = await one<{ hash: string; result: string }>(this.db, 'SELECT hash, result FROM thumbs WHERE item_id = ?', r.id);
    await run(this.db, `INSERT INTO thumbs (item_id, hash, result, icon, width, height, why, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (item_id) DO UPDATE SET hash = excluded.hash, result = excluded.result, icon = excluded.icon, width = excluded.width,
      height = excluded.height, why = excluded.why, made_at = excluded.made_at`,
      r.id, hash, row.result, row.icon, row.width, row.height, row.why, this.now());
    // the picture of what it used to be
    if (before?.result === 'picture' && before.hash !== hash) try { unlinkSync(this.fileOf(r.id, before.hash)); } catch { /* gone */ }
  }

  // Housekeeping: pictures whose record is gone or whose content changed.
  async clean(): Promise<number> {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return 0; }
    const keep = new Set((await all<{ media_id: number; hash: string }>(this.db, "SELECT item_id AS media_id, hash FROM thumbs WHERE result = 'picture'"))
      .map((t) => `${t.media_id}-${t.hash}.webp`));
    let removed = 0;
    for (const n of names) {
      if (keep.has(n) || !(FILE_RE.test(n) || n.endsWith('.tmp'))) continue;
      try { unlinkSync(join(this.dir, n)); removed++; } catch { /* gone */ }
    }
    return removed;
  }
}
