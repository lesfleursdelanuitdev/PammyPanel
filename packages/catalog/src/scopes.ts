// Scopes (docs/catalog-plan.md C4): one tree in catalog.scopes -- All, then each source's
// scopes. For the website (a File Explorer root, source 1) a scope is a folder path as it
// always was: '/' (the whole site, the Website scope), each top-level folder (automatic),
// and nested folders someone marked as a scope. A file may take a label whose scope is the
// file's folder or any folder above it. Everything here speaks in those paths; the ids stay
// inside the catalog's tables.
import { isSafeEntryName } from '@panel/core/names';
import { all, one, run, type Db } from '@panel/core/pg';

// The website: the only source until Studio tables and apps (steps 4, 5), and its files.
export const WEBSITE = 1;
export const WEBSITE_FILES = 1;

export class ScopeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ScopeRow = { path: string; automatic: boolean; created_at: number; created_by: string | null; labels: number };

export const SCOPE_RE = /^\/(?:[^/\x00-\x1f\x7f\\]{1,200}(?:\/[^/\x00-\x1f\x7f\\]{1,200}){0,11})?$/;

export function checkScope(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!SCOPE_RE.test(s)) throw new ScopeError('Not found.', 404);
  if (s !== '/') {
    for (const part of s.slice(1).split('/')) {
      if (!isSafeEntryName(part)) throw new ScopeError('Not found.', 404);
    }
  }
  return s;
}

// ('*' is Everywhere, All's labels: on anything, docs/catalog-plan.md step 4)
export function pathUnderScope(path: string, scope: string): boolean {
  if (scope === '/' || scope === '*') return true;
  const prefix = scope.slice(1);
  return path === prefix || path.startsWith(`${prefix}/`);
}

// Deepest first: `/olivia/media/images/2026`, `/olivia/media/images`, …, `/`.
export function ancestorScopePaths(filePath: string): string[] {
  const segs = filePath.split('/').filter(Boolean);
  if (!segs.length) return ['/'];
  segs.pop();
  const out = ['/'];
  for (let i = 1; i <= segs.length; i++) out.push(`/${segs.slice(0, i).join('/')}`);
  return out.reverse();
}

export function folderToScope(folderPath: string): string {
  const p = folderPath.split('/').filter(Boolean).join('/');
  return p ? `/${p}` : '/';
}

export function scopeToFolder(scope: string): string {
  return scope === '/' ? '' : scope.slice(1);
}

// ------------------------------------------------------------------ the rows
// The website's scope at a path, if it is one.
export async function scopeIdOf(db: Db, path: string): Promise<number | undefined> {
  return (await one<{ id: number }>(db, 'SELECT id FROM scopes WHERE source_id = ? AND path = ?', WEBSITE, path))?.id;
}

// The nearest scope above a path ('/' for a top-level folder; All for '/' itself).
async function parentOf(db: Db, path: string, now: number): Promise<number> {
  if (path === '/') return (await one<{ id: number }>(db, 'SELECT id FROM scopes WHERE parent_id IS NULL'))!.id;
  return (await one<{ id: number }>(db, `SELECT id FROM scopes WHERE source_id = ? AND path <> ? AND path_under(path, ?)
    ORDER BY length(path) DESC LIMIT 1`, WEBSITE, path, path.slice(1)))?.id ?? await ensureScope(db, '/', now, { automatic: true });
}

// A new scope at a path, under its nearest ancestor; undefined when one is there already.
async function insertScope(db: Db, path: string, now: number, o: { automatic: boolean; by?: string | null }): Promise<number | undefined> {
  const made = await one<{ id: number }>(db, `INSERT INTO scopes (parent_id, source_id, path, label, automatic, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, path) DO NOTHING RETURNING id`,
    await parentOf(db, path, now), WEBSITE, path, path === '/' ? 'Website' : path, o.automatic, now, o.by ?? null);
  return made?.id;
}

// '/' and each top-level folder are automatic scopes (made by themselves, never removed)
export const isAutomaticPath = (path: string) => path === '/' || !path.slice(1).includes('/');

// The scope at a path, made if it isn't there. Two at once: the insert that loses finds the
// one that won.
export async function ensureScope(db: Db, path: string, now: number, o: { automatic: boolean; by?: string | null }): Promise<number> {
  return await scopeIdOf(db, path) ?? await insertScope(db, path, now, o) ?? (await scopeIdOf(db, path))!;
}

// '/' and each top-level folder a file or a label is in: automatic scopes.
export async function ensureAutomaticScopes(db: Db, now: number) {
  await ensureScope(db, '/', now, { automatic: true });
  const rows = await all<{ path: string }>(db, `SELECT DISTINCT '/' || split_part(i.key, '/', 1) AS path FROM items i
    WHERE i.resource_id = ? AND strpos(i.key, '/') > 0 AND split_part(i.key, '/', 1) <> 'media'
    EXCEPT SELECT path FROM scopes WHERE source_id = ?`, WEBSITE_FILES, WEBSITE);
  for (const { path } of rows) await ensureScope(db, path, now, { automatic: true });
}

export async function listScopes(db: Db, tree: string | null): Promise<ScopeRow[]> {
  await ensureAutomaticScopes(db, Math.floor(Date.now() / 1000));
  const where = !tree ? '' : tree === '/' ? "AND (s.path = '/' OR starts_with(s.path, '/media/'))" : 'AND (s.path = ? OR starts_with(s.path, ?))';
  const args = !tree ? [] : tree === '/' ? [] : [tree, `${tree}/`];
  const rows = await all<{ path: string; automatic: boolean; created_at: number; created_by: string | null; labels: number }>(db,
    `SELECT s.path, s.automatic, s.created_at, s.created_by, (SELECT count(*) FROM labels l WHERE l.scope_id = s.id) AS labels
    FROM scopes s WHERE s.source_id = ? ${where} ORDER BY s.path`, WEBSITE, ...args);
  return rows.map((r) => ({ ...r, labels: Number(r.labels) }));
}

export async function definedAncestors(db: Db, filePath: string): Promise<string[]> {
  const wanted = ancestorScopePaths(filePath);
  const have = new Set((await all<{ path: string }>(db, 'SELECT path FROM scopes WHERE source_id = ?', WEBSITE)).map((r) => r.path));
  have.add('/');
  const top = filePath.split('/').find(Boolean);
  if (top && top !== 'media') have.add(`/${top}`);
  return wanted.filter((s) => have.has(s));
}

export async function addScope(db: Db, now: number, by: string, folderPath: string): Promise<ScopeRow> {
  const path = folderToScope(folderPath);
  checkScope(path);
  if (path === '/') throw new ScopeError('The whole site is already a scope.');
  if (await scopeIdOf(db, path)) throw new ScopeError('That folder is already a scope.', 409);
  // two at once: the second is the one that finds it already there
  const id = await insertScope(db, path, now, { automatic: false, by });
  if (!id) throw new ScopeError('That folder is already a scope.', 409);
  // scopes further down now sit under this one
  await run(db, `UPDATE scopes SET parent_id = ? WHERE source_id = ? AND starts_with(path, ?) AND parent_id = (SELECT parent_id FROM scopes WHERE id = ?)`,
    id, WEBSITE, `${path}/`, id);
  return (await listScopes(db, null)).find((s) => s.path === path)!;
}

export async function removeScope(db: Db, path: string): Promise<ScopeRow> {
  const sc = checkScope(path);
  const row = (await listScopes(db, null)).find((s) => s.path === sc);
  if (!row) throw new ScopeError('Not found.', 404);
  if (row.automatic) throw new ScopeError('The main site and each subdomain folder stay scopes.');
  if (row.labels) throw new ScopeError(`Move or delete its ${row.labels} tag${row.labels === 1 ? '' : 's'} and categories first.`);
  const id = (await scopeIdOf(db, sc))!;
  // what sat under it now sits under its parent
  await run(db, 'UPDATE scopes SET parent_id = (SELECT parent_id FROM scopes WHERE id = ?) WHERE parent_id = ?', id, id);
  await run(db, 'DELETE FROM scopes WHERE id = ?', id);
  return row;
}

// A folder moved or renamed: the scopes at or under it follow (their labels with them, by id).
export async function rewriteScopePrefix(db: Db, fromFolder: string, toFolder: string) {
  const from = folderToScope(fromFolder);
  const to = folderToScope(toFolder);
  if (from === to || from === '/') return;
  const rows = await all<{ id: number; path: string }>(db,
    'SELECT id, path FROM scopes WHERE source_id = ? AND (path = ? OR starts_with(path, ?)) ORDER BY length(path) DESC', WEBSITE, from, `${from}/`);
  for (const r of rows) {
    const dest = to + r.path.slice(from.length);
    const clash = await scopeIdOf(db, dest);
    if (clash && clash !== r.id) {
      // a scope is already there (an automatic one for a new top-level folder, say): its
      // labels move onto it, and the old one goes
      await run(db, 'UPDATE labels SET scope_id = ? WHERE scope_id = ? AND NOT EXISTS (SELECT 1 FROM labels x WHERE x.scope_id = ? AND x.kind = labels.kind AND x.name = labels.name)', clash, r.id, clash);
      await run(db, 'UPDATE scopes SET parent_id = ? WHERE parent_id = ?', clash, r.id);
      if (!(await one(db, 'SELECT 1 FROM labels WHERE scope_id = ?', r.id))) await run(db, 'DELETE FROM scopes WHERE id = ?', r.id);
      continue;
    }
    await run(db, 'UPDATE scopes SET path = ?, label = ? WHERE id = ?', dest, dest, r.id);
  }
  // each now under its nearest scope at its new place, shallowest first
  const moved = await all<{ id: number; path: string }>(db,
    'SELECT id, path FROM scopes WHERE source_id = ? AND (path = ? OR starts_with(path, ?)) ORDER BY length(path)', WEBSITE, to, `${to}/`);
  for (const r of moved) await run(db, 'UPDATE scopes SET parent_id = ? WHERE id = ?', await parentOf(db, r.path, 0), r.id);
}

export async function findLabelInAncestors(db: Db, type: 'tag' | 'category', filePath: string, name: string): Promise<{ id: number; scope: string } | undefined> {
  for (const scope of await definedAncestors(db, filePath)) {
    const row = await one<{ id: number; scope: string }>(db,
      'SELECT l.id, s.path AS scope FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.source_id = ? AND s.path = ? AND l.kind = ? AND l.name = ?', WEBSITE, scope, type, name);
    if (row) return row;
  }
  // then Everywhere's (C5, step 4): after every folder's, so a nearer one wins
  const everywhere = await one<{ id: number }>(db,
    "SELECT l.id FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.parent_id IS NULL AND l.kind = ? AND l.name = ?", type, name);
  return everywhere ? { id: Number(everywhere.id), scope: '*' } : undefined;
}
