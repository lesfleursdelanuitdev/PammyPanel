// Tags and categories (docs/media-plan.md D6-D13, docs/catalog-plan.md): labels in
// catalog.labels, each in one scope, put on items by links in catalog.links. A label only
// goes on items under its scope ("/", "/olivia", or a nested folder someone marked as a
// scope). Anyone who can see a scope can make, rename and delete its labels (D13); items
// link by id, so a rename changes nothing else. Tags and categories behave the same; the
// kind tells them apart.
//
// This is the website's (source 1, its files) side, in folder paths, as the pages have
// always spoken; Studio tables and apps come as sources with steps 4 and 5.
import { all, isUniqueViolation, one, run, tx, type Db } from '@panel/core/pg';
import { ancestorScopePaths, ensureScope, findLabelInAncestors, isAutomaticPath, SCOPE_RE, WEBSITE, WEBSITE_FILES } from './scopes.ts';

export type LabelType = 'tag' | 'category';
export const LABEL_TYPES: LabelType[] = ['tag', 'category'];
const LETTER = { tag: 't', category: 'c' } as const;
const PLURAL = { tag: 'tags', category: 'categories' } as const;

// D10: like form names, at most 40 characters.
export const LABEL_NAME_RE = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LABEL_RULE = 'Lowercase letters, digits and hyphens, like summer-2026 (at most 40).';
export { SCOPE_RE };

export class LabelError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// "Summer 2026!" -> "summer-2026": what the pages suggest; the server only accepts the result.
export function labelSlug(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export function checkLabelName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!LABEL_NAME_RE.test(n)) throw new LabelError(n ? `"${n}" can't be used: ${LABEL_RULE}` : 'Please type a name.');
  return n;
}

// "/t/dogs", "/olivia/c/news" (D6)
export const labelAddress = (type: LabelType, scope: string, name: string) => `${scope === '/' ? '' : scope}/${LETTER[type]}/${name}`;

// public: anyone may list its files through the media API (docs/media-api-plan.md M5)
export type Label = { id: number; type: LabelType; scope: string; name: string; address: string; count: number; public: boolean };

// the website's labels, with their scope's path
const WEBSITE_LABELS = 'FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.source_id = ?';

// Every label in a scope (or all of them), with how many files that are there have it.
export async function listLabels(db: Db, scope: string | null): Promise<Label[]> {
  const where = !scope ? '' : scope === '/' ? "AND (s.path = '/' OR starts_with(s.path, '/media/'))" : 'AND (s.path = ? OR starts_with(s.path, ?))';
  const args = !scope ? [] : scope === '/' ? [] : [scope, `${scope}/`];
  const rows = await all<{ id: number; kind: LabelType; scope: string; name: string; count: number; public: boolean }>(db,
    `SELECT l.id, l.kind, s.path AS scope, l.name, l.public,
      (SELECT count(*) FROM links x JOIN items i ON i.id = x.item_id WHERE x.label_id = l.id AND i.state = 'present') AS count
    ${WEBSITE_LABELS} ${where} ORDER BY s.path, l.name`, WEBSITE, ...args);
  // tags first, then categories, each by scope and name (as the two tables were read)
  return LABEL_TYPES.flatMap((type) => rows.filter((r) => r.kind === type)
    .map((r) => ({ id: Number(r.id), type, scope: r.scope, name: r.name, count: Number(r.count), public: r.public, address: labelAddress(type, r.scope, r.name) })));
}

// Everything a file in or under `folder` ("" = the whole website) can have: the
// labels of that folder and the folders above it, and of scopes further down.
// And Everywhere's (scope '*', docs/catalog-plan.md step 4), which any file can have.
export async function listLabelsAround(db: Db, folder: string): Promise<Label[]> {
  const here = folder ? `/${folder}` : '/';
  const above = new Set(ancestorScopePaths(`${folder ? `${folder}/` : ''}x`));
  const website = (await listLabels(db, null)).filter((l) => above.has(l.scope) || here === '/' || l.scope.startsWith(`${here}/`));
  return [...website, ...await everywhereLabels(db)];
}

// Everywhere's labels as the website's pages see them: scope '*', counting every item.
export async function everywhereLabels(db: Db): Promise<Label[]> {
  const rows = await all<{ id: number; kind: LabelType; name: string; count: number; public: boolean }>(db,
    `SELECT l.id, l.kind, l.name, l.public,
      (SELECT count(*) FROM links x JOIN items i ON i.id = x.item_id WHERE x.label_id = l.id AND i.state = 'present') AS count
    FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.parent_id IS NULL ORDER BY l.name`);
  return LABEL_TYPES.flatMap((type) => rows.filter((r) => r.kind === type)
    .map((r) => ({ id: Number(r.id), type, scope: '*', name: r.name, count: Number(r.count), public: r.public, address: `*/${LETTER[type]}/${r.name}` })));
}

export async function getLabel(db: Db, type: LabelType, id: number): Promise<Label | undefined> {
  return (await listLabels(db, null)).find((l) => l.type === type && l.id === id);
}

// The label of this kind called `name` in the scope at `scope`, made if it isn't there
// (D8, D13). Two at once (an upload and a sync, say): the insert that loses the race gets
// back the row that won, and nothing is reported as newly made twice.
export async function labelIn(q: Db, type: LabelType, scope: string, name: string, now: number, by: string | null, created: string[]): Promise<number> {
  const scopeId = await ensureScope(q, scope, now, { automatic: isAutomaticPath(scope), by });
  const row = await one<{ id: number }>(q, 'SELECT id FROM labels WHERE scope_id = ? AND kind = ? AND name = ?', scopeId, type, name);
  if (row) return Number(row.id);
  created.push(labelAddress(type, scope, name));
  const made = await one<{ id: number }>(q, `INSERT INTO labels (scope_id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scope_id, kind, name) DO UPDATE SET name = excluded.name RETURNING id`, scopeId, type, name, now, by);
  return Number(made!.id);
}

export async function createLabel(db: Db, now: number, by: string, type: LabelType, scope: string, name: unknown): Promise<Label> {
  const n = checkLabelName(name);
  try {
    return await tx(db, async (q) => {
      const scopeId = await ensureScope(q, scope, now, { automatic: isAutomaticPath(scope), by });
      const made = await one<{ id: number }>(q, 'INSERT INTO labels (scope_id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id', scopeId, type, n, now, by);
      return { id: Number(made!.id), type, scope, name: n, address: labelAddress(type, scope, n), count: 0, public: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new LabelError(`There's already a ${type} called "${n}" here.`, 409);
    throw e;
  }
}

// D12: a new name; its files keep it.
export async function renameLabel(db: Db, type: LabelType, id: number, name: unknown): Promise<{ from: string; to: Label }> {
  const before = await getLabel(db, type, id);
  if (!before) throw new LabelError('Not found.', 404);
  const n = checkLabelName(name);
  try {
    await run(db, 'UPDATE labels SET name = ? WHERE id = ? AND kind = ?', n, id, type);
  } catch (e) {
    if (isUniqueViolation(e)) throw new LabelError(`There's already a ${type} called "${n}" here.`, 409);
    throw e;
  }
  return { from: before.address, to: { ...before, name: n, address: labelAddress(type, before.scope, n) } };
}

// M5: whether anyone may list its files through the media API.
export async function setLabelPublic(db: Db, type: LabelType, id: number, on: boolean): Promise<Label> {
  if (!await getLabel(db, type, id)) throw new LabelError('Not found.', 404);
  await run(db, 'UPDATE labels SET public = ? WHERE id = ? AND kind = ?', on, id, type);
  return (await getLabel(db, type, id))!;
}

// D12: gone from every file (the count says how many).
export async function deleteLabel(db: Db, type: LabelType, id: number): Promise<Label> {
  const before = await getLabel(db, type, id);
  if (!before) throw new LabelError('Not found.', 404);
  await run(db, 'DELETE FROM labels WHERE id = ? AND kind = ?', id, type);
  return before;
}

// ------------------------------------------------------------------ labels on items
// A linked label: its kind, id, scope path ('*' for Everywhere) and name.
export type LinkedLabel = { type: LabelType; id: number; scope: string; name: string };

export async function linkedLabels(q: Db, itemId: number): Promise<LinkedLabel[]> {
  return (await all<{ kind: LabelType; id: number; scope: string; name: string }>(q,
    "SELECT l.kind, l.id, CASE WHEN s.parent_id IS NULL THEN '*' ELSE s.path END AS scope, l.name FROM links x JOIN labels l ON l.id = x.label_id JOIN scopes s ON s.id = l.scope_id WHERE x.item_id = ? ORDER BY l.kind, l.name", itemId))
    .map((r) => ({ type: r.kind, id: Number(r.id), scope: r.scope, name: r.name }));
}

export async function labelNames(q: Db, type: LabelType, itemId: number): Promise<string[]> {
  return (await all<{ name: string }>(q, 'SELECT l.name FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = ? AND l.kind = ? ORDER BY l.name', itemId, type)).map((r) => r.name);
}

export async function unlinkAll(q: Db, itemId: number) {
  await run(q, 'DELETE FROM links WHERE item_id = ?', itemId);
}

export async function link(q: Db, itemId: number, labelId: number, by: string | null, now: number) {
  await run(q, 'INSERT INTO links (item_id, label_id, made_by, made_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', itemId, labelId, by, now);
}

export type LabelChange = { tags?: unknown; categories?: unknown };
const names = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100) throw new LabelError(`Bad list of ${what}.`);
  return [...new Set(v.map(checkLabelName))];
};

// Labels on files, by name, each file in its own scope (so one call can cover
// files in several media folders): `set` replaces a file's labels, `add` and
// `remove` change some. Missing labels are made (D13). All or nothing.
export async function changeFileLabels(db: Db, now: number, by: string, ids: unknown, change: { set?: LabelChange; add?: LabelChange; remove?: LabelChange }):
  Promise<{ changed: number; created: string[] }> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((i) => Number.isSafeInteger(i) && i > 0)) throw new LabelError('Choose some files first.');
  const plan = LABEL_TYPES.map((type) => {
    const key = PLURAL[type];
    return {
      type,
      set: change.set ? names(change.set[key], key) : null,
      add: names(change.add?.[key], key),
      remove: names(change.remove?.[key], key),
    };
  });
  return await tx(db, async (q) => {
    const created: string[] = [];
    let changed = 0;
    for (const id of new Set(ids as number[])) {
      const file = await one<{ path: string; scope: string }>(q, "SELECT path, scope FROM records WHERE id = ? AND state = 'present'", id);
      if (!file) throw new LabelError("One of those files isn't there any more. Check for changes and try again.", 404);
      let touched = false;
      for (const p of plan) {
        const has = new Set(await labelNames(q, p.type, id));
        const want = new Set(p.set ?? has);
        for (const n of p.add) want.add(n);
        for (const n of p.remove) want.delete(n);
        for (const n of has) {
          if (want.has(n)) continue;
          await run(q, 'DELETE FROM links WHERE item_id = ? AND label_id IN (SELECT id FROM labels WHERE kind = ? AND name = ?)', id, p.type, n);
          touched = true;
        }
        for (const n of want) {
          if (has.has(n)) continue;
          const existing = await findLabelInAncestors(q, p.type, file.path, n);
          await link(q, id, existing?.id ?? await labelIn(q, p.type, file.scope, n, now, by, created), by, now);
          touched = true;
        }
      }
      if (touched) {
        await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', now, id);
        changed++;
      }
    }
    return { changed, created };
  });
}

// Each file's labels, for a page of files.
export async function labelsOf(db: Db, ids: number[]): Promise<Map<number, { tags: string[]; categories: string[] }>> {
  const out = new Map<number, { tags: string[]; categories: string[] }>(ids.map((id) => [id, { tags: [], categories: [] }]));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await all<{ id: number; kind: LabelType; name: string }>(db,
      `SELECT x.item_id AS id, l.kind, l.name FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id IN (${chunk.map(() => '?').join(',')}) ORDER BY l.name`, ...chunk);
    for (const r of rows) out.get(Number(r.id))![PLURAL[r.kind]].push(r.name);
  }
  return out;
}

export { WEBSITE, WEBSITE_FILES };
