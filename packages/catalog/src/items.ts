// Sources other than the website, their items, and labels by scope (docs/catalog-plan.md
// step 4). The website's files speak in folder paths (labels.ts, scopes.ts); everything
// else here speaks in ids: a source (a Studio table today, apps with step 5) has one
// resource, one scope right under All, and items the source says exist. The catalog knows
// nothing about what an item is (C2): the source hands in a key, a title and a kind.
//
// Labels here are a scope's own (the source's scope) or All's ("Everywhere", C5), which
// go on any item in any source, the website's files included.
import { all, isUniqueViolation, one, run, tx, type Db } from '@panel/core/pg';
import { checkLabelName, LABEL_TYPES, LabelError, labelSlug, type LabelType } from './labels.ts';
import { WEBSITE_FILES } from './scopes.ts';

export type SourceKind = 'studio' | 'app';
// records (a Studio table's), or what an app names its things (step 5: its resource's key by default)
export type ItemKind = string;
// The ids a source's code needs: its source, its one resource, its scope.
export type SourceRefs = { source: number; resource: number; scope: number };

// How long an item that went missing (deleted outside the panel) keeps its labels.
export const KEEP_MISSING_DAYS = 30;
// Everywhere's scope in the pages and in labels' addresses.
export const EVERYWHERE = '*';

const PLURAL = { tag: 'tags', category: 'categories' } as const;
const LETTER = { tag: 't', category: 'c' } as const;

export async function allScopeId(q: Db): Promise<number> {
  return Number((await one<{ id: number }>(q, 'SELECT id FROM scopes WHERE parent_id IS NULL'))!.id);
}

// ------------------------------------------------------------------ sources
// (resourceLabel: an app's "Topics", beside its source's "Placement Exam Prep: Topics")
export async function makeSource(q: Db, now: number, by: string | null, o: { kind: SourceKind; ref: string; label: string; resource: string; resourceLabel?: string }): Promise<SourceRefs> {
  return await tx(q, async (t) => {
    const source = Number((await one<{ id: number }>(t, 'INSERT INTO sources (kind, ref, label, created_at) VALUES (?, ?, ?, ?) RETURNING id', o.kind, o.ref, o.label, now))!.id);
    const resource = Number((await one<{ id: number }>(t, 'INSERT INTO resources (source_id, key, label) VALUES (?, ?, ?) RETURNING id', source, o.resource, o.resourceLabel ?? o.label))!.id);
    const scope = Number((await one<{ id: number }>(t, `INSERT INTO scopes (parent_id, source_id, path, label, automatic, created_at, created_by)
      VALUES (?, ?, '/', ?, true, ?, ?) RETURNING id`, await allScopeId(t), source, o.label, now, by))!.id);
    return { source, resource, scope };
  });
}

export async function sourceRefs(q: Db, source: number): Promise<SourceRefs | undefined> {
  const r = await one<{ resource: number; scope: number }>(q, `SELECT (SELECT id FROM resources WHERE source_id = ? ORDER BY id LIMIT 1) AS resource,
    (SELECT id FROM scopes WHERE source_id = ? AND path = '/') AS scope`, source, source);
  return r?.resource && r.scope ? { source, resource: Number(r.resource), scope: Number(r.scope) } : undefined;
}

// Her words for it changed ("Recipes" -> "Dishes"): the source, its resource and scope follow.
export async function relabelSource(q: Db, source: number, label: string) {
  await run(q, 'UPDATE sources SET label = ? WHERE id = ? AND label <> ?', label, source, label);
  await run(q, 'UPDATE resources SET label = ? WHERE source_id = ? AND label <> ?', label, source, label);
  await run(q, "UPDATE scopes SET label = ? WHERE source_id = ? AND path = '/' AND label <> ?", label, source, label);
}

export type SourceCounts = { items: number; labelled: number; links: number; labels: number };
export async function sourceCounts(q: Db, source: number): Promise<SourceCounts> {
  const r = (await one<{ items: number; labelled: number; links: number; labels: number }>(q, `SELECT
      (SELECT count(*) FROM items i JOIN resources r ON r.id = i.resource_id WHERE r.source_id = ? AND i.state = 'present') AS items,
      (SELECT count(DISTINCT x.item_id) FROM links x JOIN items i ON i.id = x.item_id JOIN resources r ON r.id = i.resource_id WHERE r.source_id = ? AND i.state = 'present') AS labelled,
      (SELECT count(*) FROM links x JOIN items i ON i.id = x.item_id JOIN resources r ON r.id = i.resource_id WHERE r.source_id = ?) AS links,
      (SELECT count(*) FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.source_id = ?) AS labels`, source, source, source, source))!;
  return { items: Number(r.items), labelled: Number(r.labelled), links: Number(r.links), labels: Number(r.labels) };
}

// Off, or the table gone: its labels, items and scope go (catalog.drop_source); labels at
// Everywhere stay and only lose these links.
export async function dropSource(q: Db, source: number): Promise<SourceCounts> {
  return await tx(q, async (t) => {
    const before = await sourceCounts(t, source);
    await one(t, 'SELECT drop_source(?)', source);
    return before;
  });
}

// ------------------------------------------------------------------ items
// scope: where it sits, when not in the source's own scope (an app's sub-scope, step 5)
export type ItemIn = { key: string; title: string | null; kind: ItemKind; scope?: number };
export type ItemRow = { id: number; key: string; title: string | null; state: 'present' | 'missing'; scope: number };

const cutTitle = (t: string | null) => (t === null ? null : t.slice(0, 200));

// A record as the source sees it now: kept up to date if it's there; brought back if it
// went missing and has come back with the same title (a key handed out again to another
// record must never carry the old one's labels, S4-4); else a new item.
export async function putItem(q: Db, refs: SourceRefs, it: ItemIn, now: number): Promise<number> {
  const title = cutTitle(it.title);
  const scope = it.scope ?? refs.scope;
  const present = await one<{ id: number; title: string | null; scope_id: number }>(q, "SELECT id, title, scope_id FROM items WHERE resource_id = ? AND key = ? AND state = 'present'", refs.resource, it.key);
  if (present) {
    if (present.title !== title || Number(present.scope_id) !== scope) await run(q, 'UPDATE items SET title = ?, scope_id = ?, changed_at = ? WHERE id = ?', title, scope, now, present.id);
    return Number(present.id);
  }
  const back = await one<{ id: number }>(q, `SELECT id FROM items WHERE resource_id = ? AND key = ? AND state = 'missing' AND title IS NOT DISTINCT FROM ?
    ORDER BY state_at DESC LIMIT 1`, refs.resource, it.key, title);
  if (back) {
    await run(q, "UPDATE items SET state = 'present', scope_id = ?, state_at = ?, changed_at = ? WHERE id = ?", scope, now, now, back.id);
    return Number(back.id);
  }
  return Number((await one<{ id: number }>(q, `INSERT INTO items (resource_id, key, scope_id, kind, title, state, state_at, changed_at)
    VALUES (?, ?, ?, ?, ?, 'present', ?, ?) RETURNING id`, refs.resource, it.key, scope, it.kind, title, now, now))!.id);
}

export async function presentItems(q: Db, resource: number): Promise<Map<string, ItemRow>> {
  const rows = await all<ItemRow>(q, "SELECT id, key, title, state, scope_id AS scope FROM items WHERE resource_id = ? AND state = 'present'", resource);
  return new Map(rows.map((r) => [r.key, { ...r, id: Number(r.id), scope: Number(r.scope) }]));
}

export async function itemAt(q: Db, resource: number, key: string): Promise<ItemRow | undefined> {
  const r = await one<ItemRow>(q, "SELECT id, key, title, state, scope_id AS scope FROM items WHERE resource_id = ? AND key = ? AND state = 'present'", resource, key);
  return r && { ...r, id: Number(r.id), scope: Number(r.scope) };
}

// Deleted through the panel or the gate: gone at once with its links (records have no
// trash). What it had, for Activity.
export async function itemDeleted(q: Db, resource: number, key: string): Promise<{ title: string | null; labels: string[] } | undefined> {
  const it = await itemAt(q, resource, key);
  if (!it) return undefined;
  const labels = (await all<{ kind: LabelType; name: string }>(q,
    'SELECT l.kind, l.name FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = ? ORDER BY l.kind, l.name', it.id))
    .map((l) => (l.kind === 'tag' ? `#${l.name}` : l.name));
  await run(q, 'DELETE FROM items WHERE id = ?', it.id);
  return { title: it.title, labels };
}

// Not in a full listing (deleted outside the panel): missing, labels kept 30 days.
export async function markMissing(q: Db, ids: number[], now: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    n += await run(q, `UPDATE items SET state = 'missing', state_at = ?, changed_at = ? WHERE state = 'present' AND id IN (${chunk.map(() => '?').join(',')})`, now, now, ...chunk);
  }
  return n;
}

// Missing for 30 days: forgotten (the website's files have their own, in the files sync).
export async function purgeMissing(q: Db, now: number): Promise<number> {
  return await run(q, "DELETE FROM items WHERE resource_id <> ? AND state = 'missing' AND state_at <= ?", WEBSITE_FILES, now - KEEP_MISSING_DAYS * 86400);
}

// ------------------------------------------------------------------ labels in a scope
export type ScopeLabel = {
  id: number; type: LabelType; name: string; address: string;
  // where it is: this source's scope, or Everywhere
  everywhere: boolean;
  count: number;
  // step 4b: a reader of the data API without a key may see it
  public: boolean;
};

const addressOf = (type: LabelType, where: string, name: string) => `${where}/${LETTER[type]}/${name}`;
// "@recipes" for a source's scope, "*" for Everywhere
const scopeWord = async (q: Db, scope: number): Promise<string> => {
  const s = await one<{ parent_id: number | null; label: string }>(q, 'SELECT parent_id, label FROM scopes WHERE id = ?', scope);
  if (!s) throw new LabelError('Not found.', 404);
  return s.parent_id === null ? EVERYWHERE : `@${labelSlug(s.label) || 'items'}`;
};

// The labels of these scopes, each with how many items that are there have it.
export async function scopeLabels(q: Db, scopes: number[]): Promise<ScopeLabel[]> {
  if (!scopes.length) return [];
  const rows = await all<{ id: number; kind: LabelType; name: string; scope: number; parent_id: number | null; label: string; count: number; public: boolean }>(q,
    `SELECT l.id, l.kind, l.name, s.id AS scope, s.parent_id, s.label, l.public,
       (SELECT count(*) FROM links x JOIN items i ON i.id = x.item_id WHERE x.label_id = l.id AND i.state = 'present') AS count
     FROM labels l JOIN scopes s ON s.id = l.scope_id WHERE s.id IN (${scopes.map(() => '?').join(',')}) ORDER BY l.name`, ...scopes);
  return LABEL_TYPES.flatMap((type) => rows.filter((r) => r.kind === type).map((r) => {
    const where = r.parent_id === null ? EVERYWHERE : `@${labelSlug(r.label) || 'items'}`;
    return { id: Number(r.id), type, name: r.name, address: addressOf(type, where, r.name), everywhere: r.parent_id === null, count: Number(r.count), public: r.public };
  }));
}

export async function createScopeLabel(q: Db, now: number, by: string, scope: number, type: LabelType, name: unknown): Promise<ScopeLabel> {
  const n = checkLabelName(name);
  const where = await scopeWord(q, scope);
  try {
    const made = await one<{ id: number }>(q, 'INSERT INTO labels (scope_id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id', scope, type, n, now, by);
    return { id: Number(made!.id), type, name: n, address: addressOf(type, where, n), everywhere: where === EVERYWHERE, count: 0, public: false };
  } catch (e) {
    if (isUniqueViolation(e)) throw new LabelError(`There's already a ${type} called "${n}" here.`, 409);
    throw e;
  }
}

const labelInScope = async (q: Db, scope: number, type: LabelType, id: number) =>
  (await scopeLabels(q, [scope])).find((l) => l.type === type && l.id === id);

export async function renameScopeLabel(q: Db, scope: number, type: LabelType, id: number, name: unknown): Promise<{ from: string; to: ScopeLabel }> {
  const before = await labelInScope(q, scope, type, id);
  if (!before) throw new LabelError('Not found.', 404);
  const n = checkLabelName(name);
  try {
    await run(q, 'UPDATE labels SET name = ? WHERE id = ? AND kind = ? AND scope_id = ?', n, id, type, scope);
  } catch (e) {
    if (isUniqueViolation(e)) throw new LabelError(`There's already a ${type} called "${n}" here.`, 409);
    throw e;
  }
  return { from: before.address, to: (await labelInScope(q, scope, type, id))! };
}

// step 4b (B4): whether a reader of the data API without a key may see it
export async function setScopeLabelPublic(q: Db, scope: number, type: LabelType, id: number, on: boolean): Promise<ScopeLabel> {
  if (!await labelInScope(q, scope, type, id)) throw new LabelError('Not found.', 404);
  await run(q, 'UPDATE labels SET public = ? WHERE id = ? AND kind = ? AND scope_id = ?', on, id, type, scope);
  return (await labelInScope(q, scope, type, id))!;
}

export async function deleteScopeLabel(q: Db, scope: number, type: LabelType, id: number): Promise<ScopeLabel> {
  const before = await labelInScope(q, scope, type, id);
  if (!before) throw new LabelError('Not found.', 404);
  await run(q, 'DELETE FROM labels WHERE id = ? AND kind = ? AND scope_id = ?', id, type, scope);
  return before;
}

// ------------------------------------------------------------------ labels on an item
export type Names = { tags: string[]; categories: string[] };

export async function namesOn(q: Db, item: number): Promise<Names> {
  const out: Names = { tags: [], categories: [] };
  for (const r of await all<{ kind: LabelType; name: string }>(q,
    'SELECT DISTINCT l.kind, l.name FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = ? ORDER BY l.name', item)) out[PLURAL[r.kind]].push(r.name);
  return out;
}

const namesIn = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100) throw new LabelError(`Bad list of ${what}.`);
  return [...new Set(v.map(checkLabelName))];
};

// One item's labels, by name (the record page's editor): what isn't wanted comes off; a
// name wanted is the source's own label, else Everywhere's, else made in the source's
// scope. What was made is said back.
export async function setItemLabels(db: Db, now: number, by: string, item: number, scope: number, set: { tags?: unknown; categories?: unknown }):
  Promise<{ changed: boolean; created: string[]; names: Names }> {
  const want = { tag: namesIn(set.tags, 'tags'), category: namesIn(set.categories, 'categories') };
  return await tx(db, async (q) => {
    const everywhere = await allScopeId(q);
    const where = await scopeWord(q, scope);
    const created: string[] = [];
    let changed = false;
    for (const type of LABEL_TYPES) {
      const has = await all<{ id: number; name: string }>(q,
        'SELECT l.id, l.name FROM links x JOIN labels l ON l.id = x.label_id WHERE x.item_id = ? AND l.kind = ?', item, type);
      for (const h of has) {
        if (want[type].includes(h.name)) continue;
        await run(q, 'DELETE FROM links WHERE item_id = ? AND label_id = ?', item, h.id);
        changed = true;
      }
      for (const n of want[type]) {
        if (has.some((h) => h.name === n)) continue;
        const found = await one<{ id: number }>(q, `SELECT l.id FROM labels l WHERE l.kind = ? AND l.name = ? AND l.scope_id IN (?, ?)
          ORDER BY (l.scope_id = ?) DESC LIMIT 1`, type, n, scope, everywhere, scope);
        let id = found?.id;
        if (!id) {
          id = (await one<{ id: number }>(q, `INSERT INTO labels (scope_id, kind, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (scope_id, kind, name) DO UPDATE SET name = excluded.name RETURNING id`, scope, type, n, now, by))!.id;
          created.push(addressOf(type, where, n));
        }
        await run(q, 'INSERT INTO links (item_id, label_id, made_by, made_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', item, id, by, now);
        changed = true;
      }
    }
    if (changed) await run(q, 'UPDATE items SET changed_at = ? WHERE id = ?', now, item);
    return { changed, created, names: await namesOn(q, item) };
  });
}

// Each item's label names, for a page of a source's items, by key.
export async function namesByKey(q: Db, resource: number, keys: string[]): Promise<Map<string, Names>> {
  const out = new Map<string, Names>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    if (!chunk.length) continue;
    const rows = await all<{ key: string; kind: LabelType | null; name: string | null }>(q,
      `SELECT i.key, l.kind, l.name FROM items i LEFT JOIN links x ON x.item_id = i.id LEFT JOIN labels l ON l.id = x.label_id
       WHERE i.resource_id = ? AND i.state = 'present' AND i.key IN (${chunk.map(() => '?').join(',')}) ORDER BY l.name`, resource, ...chunk);
    for (const r of rows) {
      const n = out.get(r.key) ?? { tags: [], categories: [] };
      if (r.kind && r.name && !n[PLURAL[r.kind]].includes(r.name)) n[PLURAL[r.kind]].push(r.name);
      out.set(r.key, n);
    }
  }
  return out;
}

// ------------------------------------------------------------------ what the data API is told (step 4b)
// A source's present items with their labels, as the gate's copy takes them: the labels
// once each (kind, name, public), and each item's key with the labels' places in that list.
export async function labelsForGate(q: Db, source: number): Promise<{ labels: { kind: LabelType; name: string; public: boolean }[]; records: [string, number[]][] }> {
  const rows = await all<{ key: string; kind: LabelType; name: string; public: boolean }>(q,
    `SELECT i.key, l.kind, l.name, l.public FROM links x JOIN items i ON i.id = x.item_id JOIN resources r ON r.id = i.resource_id
       JOIN labels l ON l.id = x.label_id WHERE r.source_id = ? AND i.state = 'present' ORDER BY i.key, l.kind, l.name`, source);
  const labels: { kind: LabelType; name: string; public: boolean }[] = [];
  const at = new Map<string, number>();
  const records = new Map<string, number[]>();
  for (const r of rows) {
    const id = `${r.kind}:${r.name}:${r.public}`;
    if (!at.has(id)) { at.set(id, labels.length); labels.push({ kind: r.kind, name: r.name, public: r.public }); }
    records.set(r.key, [...(records.get(r.key) ?? []), at.get(id)!]);
  }
  return { labels, records: [...records] };
}

// The keys of a source's items that have this label (a label of its scope or Everywhere's).
export async function keysWithLabel(q: Db, resource: number, label: number): Promise<string[]> {
  return (await all<{ key: string }>(q, `SELECT i.key FROM links x JOIN items i ON i.id = x.item_id
    WHERE x.label_id = ? AND i.resource_id = ? AND i.state = 'present' ORDER BY i.key`, label, resource)).map((r) => r.key);
}

// ------------------------------------------------------------------ pictures (C13)
// S4-8: a website file's thumbnail, by the file's path, for items whose picture is one.
// Only a thumbnail already made (no new ones); anything else has none.
export async function websitePictures(q: Db, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(paths)].slice(0, 1000);
  if (!want.length) return out;
  for (const r of await all<{ id: number; key: string; hash: string }>(q,
    `SELECT i.id, i.key, t.hash FROM items i JOIN files f ON f.item_id = i.id JOIN thumbs t ON t.item_id = i.id AND t.hash = f.hash AND t.result = 'picture'
     WHERE i.resource_id = ? AND i.state = 'present' AND i.key IN (${want.map(() => '?').join(',')})`, WEBSITE_FILES, ...want)) {
    out.set(r.key, `/api/media/thumb/${Number(r.id)}?v=${r.hash.slice(0, 12)}`);
  }
  return out;
}
