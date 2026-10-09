// The media API's index as catalog step 1 published it (packages/media/src/media-public.ts at
// main before step 2, from schema `media`), kept only so test/catalog-move.test.ts can
// compare what step 2 publishes with it. Run with search_path panel, media.
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
      FROM media m LEFT JOIN thumbs t ON t.media_id = m.id WHERE m.state = 'present'`);
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
    for (const [type, table, link, col] of [['tag', 'tags', 'media_tags', 'tag_id'], ['category', 'categories', 'media_categories', 'category_id']] as const) {
      for (const l of await all<{ id: number; scope: string; name: string; public: number }>(db, `SELECT id, scope, name, public FROM ${table}`)) {
        putLabel.run(type, l.id, l.scope, l.name, l.public);
      }
      for (const x of await all<{ media_id: number; label_id: number }>(db,
        `SELECT x.media_id, x.${col} AS label_id FROM ${link} x JOIN media m ON m.id = x.media_id WHERE m.state = 'present'`)) {
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

