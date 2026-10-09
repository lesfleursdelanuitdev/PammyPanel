// What the gate may know about her media, for the media API (docs/media-api-plan.md
// M2): a small read-only database, index.db, in a folder the panel writes and the
// gate can only read. The gate never opens the panel's own databases.
//
// It is rewritten as a whole whenever media or labels change (a moment after the
// last change, so a burst of uploads is one rewrite), into a new file that is then
// renamed into place: the gate sees the old index or the new one, never half of
// one. Only files that are there, their titles, labels (with which are public),
// and the name of each one's thumbnail in thumbs/ beside it.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { all, type Db } from '@panel/core/pg';
import { WEBSITE } from '@panel/catalog/scopes';

export const INDEX_FILE = 'index.db';
export const INDEX_VERSION = 1;

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE files (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    size INTEGER NOT NULL, modified_at INTEGER NOT NULL, added_at INTEGER NOT NULL, title TEXT, alt TEXT,
    thumb TEXT, thumb_width INTEGER, thumb_height INTEGER
  );
  CREATE INDEX files_scope ON files(scope, kind);
  CREATE TABLE labels (type TEXT NOT NULL, id INTEGER NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL, public INTEGER NOT NULL, PRIMARY KEY (type, id));
  CREATE UNIQUE INDEX labels_name ON labels(scope, type, name);
  CREATE TABLE file_labels (file_id INTEGER NOT NULL, type TEXT NOT NULL, label_id INTEGER NOT NULL, PRIMARY KEY (type, label_id, file_id));
  CREATE INDEX file_labels_file ON file_labels(file_id);
`;

// The whole index, written anew. Returns how many files it lists.
export async function publishIndex(db: Db, dir: string, now: number): Promise<number> {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const tmp = join(dir, `.index-${randomBytes(6).toString('hex')}.db`);
  const out = new DatabaseSync(tmp);
  try {
    out.exec('PRAGMA journal_mode = DELETE');     // one plain file: the gate opens it read-only
    out.exec(SCHEMA);
    out.exec('BEGIN');
    out.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)').run('version', String(INDEX_VERSION), 'published_at', String(now));
    const files = await all<{
      id: number; path: string; scope: string; kind: string; name: string; size: number; modified_at: number; added_at: number;
      title: string | null; alt: string | null; hash: string | null; result: string | null; thumb_hash: string | null; width: number | null; height: number | null }>(db,
      `SELECT m.id, m.path, m.scope, m.kind, m.name, m.size, m.modified_at, m.added_at, m.title, m.alt, m.hash,
        t.result, t.hash AS thumb_hash, t.width, t.height
      FROM records m LEFT JOIN thumbs t ON t.item_id = m.id WHERE m.state = 'present'`);
    const putFile = out.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const published = new Set<number>();
    for (const f of files) {
      const p = f.path.split('/');
      const at = p[0] === 'media' ? 0 : p[1] === 'media' ? 1 : -1;
      if (at < 0 || p.length < at + 3 || !['images', 'files', 'audio', 'video'].includes(p[at + 1]!)) continue;
      const thumb = f.result === 'picture' && f.hash && f.thumb_hash === f.hash ? `${f.id}-${f.hash}.webp` : null;
      putFile.run(f.id, f.path, f.scope, f.kind, f.name, f.size, f.modified_at, f.added_at, f.title, f.alt, thumb, thumb ? f.width : null, thumb ? f.height : null);
      published.add(f.id);
    }
    const putLabel = out.prepare('INSERT INTO labels VALUES (?, ?, ?, ?, ?)');
    const putLink = out.prepare('INSERT INTO file_labels VALUES (?, ?, ?)');
    // the website's labels (docs/catalog-plan.md step 2: catalog.labels, in the scopes' paths)
    for (const type of ['tag', 'category'] as const) {
      for (const l of await all<{ id: number; scope: string; name: string; public: boolean }>(db,
        'SELECT l.id, s.path AS scope, l.name, l.public FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.source_id = ? AND l.kind = ? ORDER BY l.id', WEBSITE, type)) {
        putLabel.run(type, l.id, l.scope, l.name, l.public ? 1 : 0);
      }
      for (const x of await all<{ media_id: number; label_id: number }>(db,
        `SELECT x.item_id AS media_id, x.label_id FROM links x JOIN labels l ON l.id = x.label_id JOIN scopes s ON s.id = l.scope_id JOIN records m ON m.id = x.item_id
          WHERE m.state = 'present' AND l.kind = ? AND s.source_id = ?`, type, WEBSITE)) {
        if (published.has(x.media_id)) putLink.run(x.media_id, type, x.label_id);
      }
    }
    out.exec('COMMIT');
    out.close();
    chmodSync(tmp, 0o640);
    renameSync(tmp, join(dir, INDEX_FILE));
    return published.size;
  } catch (e) {
    try { out.close(); } catch { /* closed */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Publishes a moment after the last change asked for it.
export class Publisher {
  readonly db: Db;
  readonly dir: string;
  readonly now: () => number;
  log: (msg: string, err?: unknown) => void = () => {};
  delayMs = 1500;
  #timer: NodeJS.Timeout | null = null;
  // one publish at a time: reading Postgres is awaited, so two that overlapped
  // could rename their files into place the wrong way round
  #chain: Promise<number | null> = Promise.resolve(null);

  constructor(db: Db, dir: string, now: () => number) {
    this.db = db;
    this.dir = dir;
    this.now = now;
  }

  kick() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.publishNow(); }, this.delayMs);
    this.#timer.unref();
  }

  publishNow(): Promise<number | null> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#chain = this.#chain.catch(() => null).then(async () => {
      try { return await publishIndex(this.db, this.dir, this.now()); } catch (e) { this.log('media index not published', e); return null; }
    });
    return this.#chain;
  }
}
