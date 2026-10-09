// The media records: one per file under the website (docs/media-plan.md D5-D17),
// with tags and categories. Since catalog step 2 (docs/catalog-plan.md) a file is an
// item of the catalog (catalog.items: its key is its path, its state, title and site
// scope) with File Explorer's own columns beside it (files.files); `records` is the
// two as one row, the shape media.media had, and what everything reads. The files
// themselves are only ever touched by the website folder helper; this is what the
// panel knows about them, kept up to date by its own changes and by a sync
// (media-sync.ts).
//
// Every record has a site scope: "/" for a file at the top of the site or in
// media/..., "/<folder>" for a file in a top-level folder. A tag or category
// may be nested (a defined folder scope); it only links to files under that
// folder (or an ancestor of it).
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { labelIn, labelNames, link, linkedLabels, LABEL_TYPES, unlinkAll, type LinkedLabel } from '@panel/catalog/labels';
import { ensureAutomaticScopes, ensureScope, pathUnderScope, rewriteScopePrefix, WEBSITE_FILES } from '@panel/catalog/scopes';

export const MEDIA_KINDS = ['images', 'files', 'audio', 'video'] as const;
export const FILE_KINDS = ['images', 'files', 'audio', 'video', 'pages', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type FileKind = (typeof FILE_KINDS)[number];
export type How = 'uploaded' | 'copied' | 'found';
export type MediaState = 'present' | 'trashed' | 'missing';
// Missing and trashed records are kept this long (the helper's trash lasts as long).
export const KEEP_DAYS = 30;

export type MediaRow = {
  id: number; path: string; scope: string; kind: FileKind; name: string; size: number; hash: string | null;
  modified_at: number; added_at: number; added_by: string | null; how: How; state: MediaState; state_at: number | null;
  trash_id: string | null; changed_at: number;
  title: string | null; alt: string | null;
};

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const PAGE_EXT = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml', 'css', 'js', 'mjs', 'cjs']);
const OTHER_EXT = new Set([
  'php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar', 'cgi', 'pl', 'py', 'sh', 'asp', 'aspx', 'jsp', 'htaccess',
]);

export function extensionOf(name: string) {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

export function kindOfName(name: string): FileKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return 'images';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (PAGE_EXT.has(ext)) return 'pages';
  if (!ext || OTHER_EXT.has(ext)) return 'other';
  return 'files';
}

// A file inside media/images|files|audio|video (the Media tab's filter).
export function inMediaLibrary(path: string): boolean {
  const p = path.split('/');
  const at = p[0] === 'media' ? 0 : p[1] === 'media' ? 1 : -1;
  return at >= 0 && p.length >= at + 3 && (MEDIA_KINDS as readonly string[]).includes(p[at + 1]!);
}

export function mediaFolderKind(path: string): MediaKind | null {
  const p = path.split('/');
  const at = p[0] === 'media' ? 0 : p[1] === 'media' ? 1 : -1;
  const kind = at >= 0 ? p[at + 1] : undefined;
  return kind && (MEDIA_KINDS as readonly string[]).includes(kind) ? kind as MediaKind : null;
}

// ------------------------------------------------------------------ paths
// "olivia/media/images/2026/dog.jpg" -> scope /olivia, kind images, name dog.jpg.
// "olivia/index.html" -> scope /olivia, kind pages. null for empty steps, hidden
// names, or login-files.
export function placeOf(path: string): { scope: string; kind: FileKind; name: string } | null {
  const p = path.split('/');
  if (!p.length || p.length > 24 || p.some((x) => x === '' || x.startsWith('.') || x === 'login-files')) return null;
  const name = p[p.length - 1]!;
  const scope = p.length === 1 || p[0] === 'media' ? '/' : `/${p[0]}`;
  return { scope, kind: kindOfName(name), name };
}

// A path, or everything under it (a folder): the records it covers.
const underSql = "(path = ? OR starts_with(path, ? || '/'))";
const folderScope = (folder: string) => (folder ? `/${folder}` : '/');
const under = (prefix: string) => [prefix, prefix];

export async function presentAt(db: Db, path: string): Promise<MediaRow | undefined> {
  return await one<MediaRow>(db, "SELECT * FROM records WHERE path = ? AND state = 'present'", path);
}

// A file's site scope, as a scope row (the automatic ones are made as they're needed).
const siteScopeId = (q: Db, scope: string, now: number) => ensureScope(q, scope, now, { automatic: true });

// A new record: the item and its file's columns. Returns its id.
export async function insertRecord(q: Db, now: number, r: {
  path: string; scope: string; kind: FileKind; name: string; size: number; hash?: string | null; modifiedAt: number;
  addedAt: number; addedBy: string | null; how: How; stateAt?: number | null;
}): Promise<number> {
  const item = await one<{ id: number }>(q, `INSERT INTO items (resource_id, key, scope_id, kind, state, state_at, changed_at)
    VALUES (?, ?, ?, ?, 'present', ?, ?) RETURNING id`, WEBSITE_FILES, r.path, await siteScopeId(q, r.scope, now), r.kind, r.stateAt ?? null, now);
  await run(q, 'INSERT INTO files (item_id, name, size, hash, modified_at, added_at, added_by, how) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    item!.id, r.name, r.size, r.hash ?? null, r.modifiedAt, r.addedAt, r.addedBy, r.how);
  return Number(item!.id);
}

// The files directly in one folder, for the Media page and File Explorer.
export async function presentIn(db: Db, dir: string): Promise<MediaRow[]> {
  if (!dir) {
    return await all<MediaRow>(db, "SELECT * FROM records WHERE state = 'present' AND strpos(path, '/') = 0");
  }
  return await all<MediaRow>(db, `SELECT * FROM records WHERE state = 'present' AND starts_with(path, ? || '/')
    AND strpos(substr(path, length(?) + 2), '/') = 0`, dir, dir);
}

// ------------------------------------------------------------------ changes made through the panel
// A file the panel just put there (upload or copy). If a sync got to it first, or
// a stale record says something was at that path, this one takes its place.
export async function recordAdded(db: Db, now: number, f: { path: string; size: number; modifiedAt: number; hash?: string | null; how: 'uploaded' | 'copied'; by: string }): Promise<number> {
  const place = placeOf(f.path);
  if (!place) throw new Error(`not a file path: ${f.path}`);
  return await tx(db, async (q) => {
    const had = await presentAt(q, f.path);
    if (had) {
      await run(q, 'UPDATE files SET size = ?, modified_at = ?, hash = ?, added_at = ?, added_by = ?, how = ? WHERE item_id = ?',
        f.size, f.modifiedAt, f.hash ?? null, now, f.by, f.how, had.id);
      await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', now, had.id);
      return had.id;
    }
    const id = await insertRecord(q, now, { path: f.path, ...place, size: f.size, hash: f.hash, modifiedAt: f.modifiedAt, addedAt: now, addedBy: f.by, how: f.how });
    await ensureAutomaticScopes(q, now);
    return id;
  });
}

export type CreatedLabels = { tags: string[]; categories: string[] };
// a label made in `scope` by name (D8), said in `created` under its kind
const labelMade = async (q: Db, l: Pick<LinkedLabel, 'type' | 'name'>, scope: string, now: number, by: string | null, created: CreatedLabels) => {
  const made: string[] = [];
  const id = await labelIn(q, l.type, scope, l.name, now, by, made);
  created[l.type === 'tag' ? 'tags' : 'categories'].push(...made);
  return id;
};

// One record to a new path (a move, a rename, a restore, or a sync that
// recognised a moved file). Labels that still apply stay; the rest go by name
// in the destination site's scope (D8). Any stale record still claiming the new
// path is marked missing: the helper has just shown nothing is there. Must run
// inside a transaction.
export async function moveRecord(q: Db, row: MediaRow, to: string, now: number, by: string | null, created: CreatedLabels, extra: Partial<Pick<MediaRow, 'size' | 'modified_at' | 'hash'>> = {}) {
  const place = placeOf(to);
  if (!place) throw new Error(`not a file path: ${to}`);
  await run(q, "UPDATE items SET state = 'missing', state_at = ?, changed_at = ? WHERE resource_id = ? AND key = ? AND state = 'present' AND id <> ?", now, now, WEBSITE_FILES, to, row.id);
  const carried = await linkedLabels(q, row.id);
  await unlinkAll(q, row.id);
  await run(q, `UPDATE items SET key = ?, scope_id = ?, kind = ?, state = 'present', state_at = ?, changed_at = ? WHERE id = ?`,
    to, await siteScopeId(q, place.scope, now), place.kind, row.state === 'present' ? row.state_at : now, now, row.id);
  await run(q, 'UPDATE files SET name = ?, trash_id = NULL, size = ?, modified_at = ?, hash = ? WHERE item_id = ?',
    place.name, extra.size ?? row.size, extra.modified_at ?? row.modified_at, extra.hash !== undefined ? extra.hash : row.hash, row.id);
  for (const l of carried) {
    await link(q, row.id, pathUnderScope(to, l.scope) ? l.id : await labelMade(q, l, place.scope, now, by, created), by, now);
  }
}

// A file or a whole folder moved or renamed by the panel: its records follow,
// and defined scopes under that prefix are rewritten (D9).
export async function recordMoved(db: Db, now: number, from: string, to: string, by: string): Promise<{ moved: number; created: CreatedLabels }> {
  if (from === to) return { moved: 0, created: { tags: [], categories: [] } };
  return await tx(db, async (q) => {
    const created: CreatedLabels = { tags: [], categories: [] };
    const rows = await all<MediaRow>(q, `SELECT * FROM records WHERE state = 'present' AND ${underSql}`, ...under(from));
    const saved: { r: MediaRow; labels: LinkedLabel[] }[] = [];
    for (const r of rows) saved.push({ r, labels: await linkedLabels(q, r.id) });
    for (const { r } of saved) await unlinkAll(q, r.id);
    await rewriteScopePrefix(q, from, to);
    for (const { r, labels } of saved) {
      const dest = to + r.path.slice(from.length);
      await moveRecord(q, r, dest, now, by, created);
      const place = placeOf(dest)!;
      for (const l of labels) {
        // (its scope may have moved with the folder, or been merged into another one)
        const cur = await one<{ id: number; scope: string }>(q, "SELECT l.id, CASE WHEN s.parent_id IS NULL THEN '*' ELSE s.path END AS scope FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE l.id = ?", l.id)
          ?? await one<{ id: number; scope: string }>(q, `SELECT l.id, s.path AS scope FROM labels l JOIN scopes s ON s.id = l.scope_id
               WHERE s.path = ? AND l.kind = ? AND l.name = ?`, to + l.scope.slice(folderScope(from).length), l.type, l.name);
        const fits = cur && pathUnderScope(dest, cur.scope);
        await link(q, r.id, fits ? Number(cur.id) : await labelMade(q, l, place.scope, now, by, created), by, now);
      }
    }
    return { moved: rows.length, created };
  });
}

// A copy: a new record, with the original's labels (by name in another scope, D8)
// and its hash when the bytes are the same.
export async function recordCopied(db: Db, now: number, from: string, f: { path: string; size: number; modifiedAt: number }, by: string): Promise<{ id: number; created: CreatedLabels }> {
  return await tx(db, async (q) => {
    const created: CreatedLabels = { tags: [], categories: [] };
    const src = await presentAt(q, from);
    const id = await recordAdded(q, now, { ...f, hash: src && src.size === f.size ? src.hash : null, how: 'copied', by });
    if (!src) return { id, created };
    const scope = placeOf(f.path)!.scope;
    // Everywhere's labels come along as they are (step 4); the rest by name in its scope
    const everywhere = (await linkedLabels(q, src.id)).filter((l) => l.scope === '*');
    for (const l of everywhere) await link(q, id, l.id, by, now);
    for (const type of LABEL_TYPES) {
      for (const name of await labelNames(q, type, src.id)) {
        if (everywhere.some((l) => l.type === type && l.name === name)) continue;
        await link(q, id, await labelMade(q, { type, name }, scope, now, by, created), by, now);
      }
    }
    return { id, created };
  });
}

// Into the helper's trash: the records keep their labels, and where they were.
export async function recordTrashed(db: Db, now: number, path: string, trashId: string): Promise<number> {
  return await tx(db, async (q) => {
    const ids = (await all<{ id: number }>(q, `SELECT id FROM records WHERE state = 'present' AND ${underSql}`, ...under(path))).map((r) => Number(r.id));
    if (!ids.length) return 0;
    const list = ids.map(() => '?').join(',');
    await run(q, `UPDATE items SET state = 'trashed', state_at = ?, changed_at = ? WHERE id IN (${list})`, now, now, ...ids);
    await run(q, `UPDATE files SET trash_id = ? WHERE item_id IN (${list})`, trashId, ...ids);
    return ids.length;
  });
}

// Back from the trash, perhaps somewhere else or under another name: `was` is
// where the trashed file or folder came from, `to` where it is now.
export async function recordRestored(db: Db, now: number, trashId: string, was: string, to: string, by: string): Promise<{ restored: number; created: CreatedLabels }> {
  return await tx(db, async (q) => {
    const created: CreatedLabels = { tags: [], categories: [] };
    const rows = await all<MediaRow>(q, "SELECT * FROM records WHERE trash_id = ? AND state = 'trashed'", trashId);
    for (const r of rows) {
      const inside = r.path === was ? '' : r.path.startsWith(`${was}/`) ? r.path.slice(was.length) : null;
      if (inside === null) continue;
      await moveRecord(q, r, to + inside, now, by, created);
    }
    return { restored: rows.length, created };
  });
}

// Saved in the editor: same record, new content. Who added it stays as it was.
// Not recorded yet (put there outside the panel, before a sync): the sync finds it.
export async function recordEdited(db: Db, now: number, f: { path: string; size: number; modifiedAt: number; hash: string }): Promise<number | null> {
  const had = await presentAt(db, f.path);
  if (!had) return null;
  await tx(db, async (q) => {
    await run(q, 'UPDATE files SET size = ?, modified_at = ?, hash = ? WHERE item_id = ?', f.size, f.modifiedAt, f.hash, had.id);
    await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', now, had.id);
  });
  return had.id;
}

// The helper said the file isn't there: say so until a sync sees it again.
export async function recordGone(db: Db, now: number, path: string) {
  await run(db, "UPDATE items SET state = 'missing', state_at = ?, changed_at = ? WHERE resource_id = ? AND key = ? AND state = 'present'", now, now, WEBSITE_FILES, path);
}

// Imported notes follow a restore of something trashed before the media records
// existed ("trash:<id>/<name>" in media_notes), so the sync that finds it knows
// who added it.
export async function moveImportedNotes(db: Db, from: string, to: string) {
  await tx(db, async (q) => {
    const rows = await all<{ path: string }>(q, `SELECT path FROM imported_notes WHERE ${underSql}`, ...under(from));
    for (const { path } of rows) {
      const dest = to + path.slice(from.length);
      await run(q, 'DELETE FROM imported_notes WHERE path = ?', dest);
      await run(q, 'UPDATE imported_notes SET path = ? WHERE path = ?', dest, path);
    }
  });
}

// ------------------------------------------------------------------ for the sync (media-sync.ts)
// Missing and trashed records older than KEEP_DAYS go, with their links.
export async function purgeRecords(db: Db, now: number): Promise<number> {
  return await run(db, "DELETE FROM items WHERE resource_id = ? AND state IN ('missing', 'trashed') AND state_at <= ?", WEBSITE_FILES, now - KEEP_DAYS * 86400);
}

export async function syncState<T>(db: Db, key: string): Promise<T | null> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM sync_state WHERE key = ?', key);
  return row ? JSON.parse(row.value) as T : null;
}

export async function setSyncState(db: Db, key: string, value: unknown) {
  await run(db, 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// ------------------------------------------------------------------ the Media page's list (D20)
export type ItemQuery = {
  scope: string | null;             // null: every site
  within?: readonly string[] | null; // and only these sites (a person kept to places); null: any
  kind: FileKind | null;            // null: every kind
  dir: string | null;               // a folder: its files only (browse); with `deep`, everything under it
  deep: boolean;
  library: 'media' | 'all';         // media: only media/{images|files|audio|video}/
  q: string;                        // part of the name
  tags: number[];
  categories: number[];
  sort: 'name' | 'size' | 'added';
  desc: boolean;
  offset: number;
  limit: number;
};

// media/<kind>/… at the top of the site, or <folder>/media/<kind>/… one level in
// (the second test was GLOB '*/media/<kind>/*' with the first slash where /media/ is).
const MEDIA_PATH_SQL = `(
  starts_with(m.path, 'media/images/') OR starts_with(m.path, 'media/files/') OR starts_with(m.path, 'media/audio/') OR starts_with(m.path, 'media/video/')
  OR ((strpos(m.path, '/media/images/') > 0 OR strpos(m.path, '/media/files/') > 0 OR strpos(m.path, '/media/audio/') > 0 OR strpos(m.path, '/media/video/') > 0)
    AND strpos(m.path, '/media/') = strpos(m.path, '/'))
)`;

export async function queryItems(db: Db, q: ItemQuery): Promise<{ rows: MediaRow[]; total: number }> {
  const where = ["m.state = 'present'"];
  const args: (string | number)[] = [];
  if (q.scope) { where.push('m.scope = ?'); args.push(q.scope); }
  if (q.within) { where.push(`m.scope IN (${q.within.map(() => '?').join(', ') || 'NULL'})`); args.push(...q.within); }
  if (q.library !== 'all') {
    if (q.kind && (MEDIA_KINDS as readonly string[]).includes(q.kind)) {
      where.push("(starts_with(m.path, ?) OR (strpos(m.path, ?) > 0 AND strpos(m.path, '/media/') = strpos(m.path, '/')))");
      args.push(`media/${q.kind}/`, `/media/${q.kind}/`);
    } else {
      where.push(MEDIA_PATH_SQL);
    }
  } else if (q.kind) {
    where.push('m.kind = ?');
    args.push(q.kind);
  }
  if (q.dir !== null) {
    if (q.dir === '') {
      if (!q.deep) where.push("strpos(m.path, '/') = 0");
    } else {
      where.push("starts_with(m.path, ? || '/')");
      args.push(q.dir);
      if (!q.deep) { where.push("strpos(substr(m.path, length(?) + 2), '/') = 0"); args.push(q.dir); }
    }
  }
  if (q.q) { where.push('strpos(lower(m.name), lower(?)) > 0'); args.push(q.q); }
  for (const [kind, ids] of [['tag', q.tags], ['category', q.categories]] as const) {
    for (const id of ids) {
      where.push("EXISTS (SELECT 1 FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = m.id AND x.label_id = ? AND l.kind = ?)");
      args.push(id, kind);
    }
  }
  // NOCASE was SQLite's; lower() is the same for the ASCII names these are
  const order = { name: 'lower(m.name)', size: 'm.size', added: 'm.added_at' }[q.sort];
  const w = where.join(' AND ');
  const total = (await one<{ n: number }>(db, `SELECT count(*) AS n FROM records m WHERE ${w}`, ...args))!.n;
  const rows = await all<MediaRow>(db, `SELECT m.* FROM records m WHERE ${w} ORDER BY ${order} ${q.desc ? 'DESC' : 'ASC'}, m.id ${q.desc ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
    ...args, q.limit, q.offset);
  return { rows, total };
}

export async function recordById(db: Db, id: number): Promise<MediaRow | undefined> {
  return await one<MediaRow>(db, "SELECT * FROM records WHERE id = ? AND state = 'present'", id);
}

// M9: a file's title and "what it shows" (for people who can't see it). Empty: none.
const oneLine = (v: unknown, max: number) =>
  (typeof v === 'string' ? v.normalize('NFC').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;
export async function setDetails(db: Db, now: number, id: number, d: { title?: unknown; alt?: unknown }): Promise<MediaRow> {
  return await tx(db, async (q) => {
    const r = await recordById(q, id);
    if (!r) throw new Error('not-found');
    const title = d.title === undefined ? r.title : oneLine(d.title, 200);
    const alt = d.alt === undefined ? r.alt : oneLine(d.alt, 500);
    await run(q, 'UPDATE items SET title = ?, changed_at = ? WHERE id = ?', title, now, id);
    await run(q, 'UPDATE files SET alt = ? WHERE item_id = ?', alt, id);
    return (await recordById(q, id))!;
  });
}
