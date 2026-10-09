// The data API's side of the gate (docs/databases-plan.md 11.3, 13).
//
// The gate serves her records to programs. It knows nothing about Resources of
// its own: the panel pushes a finished catalog (src/studio/catalog.ts) and this
// file serves exactly that. If a column is not in the catalog, the gate has
// never heard of it.
//
// Three gates, in this order, on every single request:
//
//   1. **Is the API switched on** for that database, for reading or writing?
//      Off is a 403 and says so -- not a 404, because pretending a thing does
//      not exist when she has simply not switched it on is a worse answer.
//   2. **Does the key say it may?** Grants are resource names plus a write bit.
//   3. **Does the CATALOG still allow it?** This is the one that matters. A
//      key issued yesterday saying "write" cannot delete once she has turned
//      Delete off, because the ability is read from the catalog every time,
//      never from the key.
import { randomBytes } from 'node:crypto';
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { hashToken } from '@panel/core/util';
import { GateError } from '@panel/core/gate/ops';
import { readCatalog, type Catalog, type CatalogResource } from '../studio/catalog.ts';
import type { Ability } from '../studio/resources.ts';

export const APP_KEY_RE = /^pammy_app_[A-Za-z0-9_-]{43}$/;
export const MAX_APP_KEYS = 40;

export type CatalogRow = {
  database_id: number; engine: 'postgres' | 'mariadb'; name: string;
  api_read: boolean; api_write: boolean; catalog_json: string; updated_at: number;
};

export type AppKeyRow = {
  id: number; database_id: number; label: string; prefix: string; key_hash: string;
  grants: string; can_write: boolean;
  created_at: number; created_by: string | null;
  last_used_at: number | null; revoked_at: number | null; revoked_by: string | null;
};

export type AppKey = {
  id: number; databaseId: number; label: string; prefix: string;
  resources: 'all' | string[]; canWrite: boolean;
  createdAt: number; createdBy: string | null; lastUsedAt: number | null; revokedAt: number | null;
};

const toKey = (r: AppKeyRow): AppKey => ({
  id: r.id, databaseId: r.database_id, label: r.label, prefix: r.prefix,
  resources: grantsOf(r.grants), canWrite: r.can_write,
  createdAt: r.created_at, createdBy: r.created_by, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
});

function grantsOf(json: string): 'all' | string[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (v === 'all') return 'all';
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // unreadable means nothing, not everything
    return [];
  }
}

// ------------------------------------------------------------------ the catalog the panel pushes

export async function pushCatalog(db: Db, now: number, input: {
  databaseId: unknown; engine: unknown; name: unknown;
  apiRead: unknown; apiWrite: unknown; catalog: unknown;
}): Promise<{ resources: number }> {
  const id = Number(input.databaseId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new GateError('invalid', 'The panel did not say which database.');
  if (input.engine !== 'postgres' && input.engine !== 'mariadb') throw new GateError('invalid', 'Unknown kind of database.');
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(input.name)) {
    throw new GateError('invalid', 'That is not a database name.');
  }
  // Read back through the same reader the gate serves from, so what is stored
  // is what can be served -- a catalog that would not parse is refused here
  // rather than quietly becoming "this database exposes nothing".
  const catalog = readCatalog(JSON.stringify((input.catalog ?? {}) as Catalog));
  await run(db,
    `INSERT INTO studio_catalog (database_id, engine, name, api_read, api_write, catalog_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (database_id) DO UPDATE
        SET engine = EXCLUDED.engine, name = EXCLUDED.name,
            api_read = EXCLUDED.api_read, api_write = EXCLUDED.api_write,
            catalog_json = EXCLUDED.catalog_json, updated_at = EXCLUDED.updated_at`,
    id, input.engine, input.name, input.apiRead === true, input.apiWrite === true,
    JSON.stringify(catalog), now);
  return { resources: catalog.resources.length };
}

// She stopped looking after the database, or switched the app off: the gate
// forgets it entirely, and every key for it stops working at the same moment.
export async function dropCatalog(db: Db, now: number, databaseId: unknown): Promise<{ ok: true }> {
  const id = Number(databaseId);
  if (!Number.isSafeInteger(id)) throw new GateError('invalid', 'The panel did not say which database.');
  await tx(db, async (q) => {
    await run(q, 'DELETE FROM studio_catalog WHERE database_id = ?', id);
    await run(q, 'UPDATE studio_app_keys SET revoked_at = ?, revoked_by = ? WHERE database_id = ? AND revoked_at IS NULL',
      now, 'the app was switched off', id);
  });
  return { ok: true };
}

// ------------------------------------------------------------------ touches (docs/catalog-plan.md step 4)
// A write to a table she tags in the panel: noted here for the panel to take (it can't
// read the gate's tables, nor the gate the catalog). `key` for a delete: the record's key
// as the catalog keeps it (its one value, or the values as a JSON list).
export function touchKey(r: CatalogResource, where: Record<string, unknown>): string | null {
  const parts = r.key.map((k) => where[k]);
  if (parts.some((p) => p === null || p === undefined || p === '')) return null;
  const text = parts.map((p) => String(p));
  return text.length === 1 ? text[0]! : JSON.stringify(text);
}

export async function noteTouch(db: Db, now: number, databaseId: number, r: CatalogResource, what: 'changed' | 'deleted', key: string | null = null) {
  if (!r.tagged) return;
  await run(db, 'INSERT INTO record_touches (database_id, table_name, key, what, at) VALUES (?, ?, ?, ?, ?)',
    databaseId, r.table, what === 'deleted' ? key : null, what, now);
}

// The panel takes them (a thousand at a time) and they go; any older than a week (the
// panel's catalog off, say) go too.
export async function takeTouches(db: Db, now: number) {
  return await tx(db, async (q) => {
    await run(q, 'DELETE FROM record_touches WHERE at < ?', now - 7 * 86400);
    const touches = await all<{ database_id: number; table_name: string; key: string | null; what: 'changed' | 'deleted' }>(q,
      'DELETE FROM record_touches WHERE id IN (SELECT id FROM record_touches ORDER BY id LIMIT 1000) RETURNING database_id, table_name, key, what');
    return { touches: touches.map((t) => ({ ...t, database_id: Number(t.database_id) })) };
  });
}

// ------------------------------------------------------------------ labels (docs/catalog-plan.md step 4b)
// The gate's copy of a tagged table's labels, sent whole by the panel: the labels (kind,
// name, public) and each record's key with the labels it has, by their place in the list.
export type LabelNames = { tags: string[]; categories: string[] };
type LabelIn = { kind: 'tag' | 'category'; name: string; public: boolean };
const LABEL_NAME = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export async function putRecordLabels(db: Db, input: Record<string, unknown>): Promise<{ records: number; links: number }> {
  const id = Number(input.databaseId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new GateError('invalid', 'The panel did not say which database.');
  if (typeof input.table !== 'string' || !TABLE_NAME.test(input.table)) throw new GateError('invalid', 'That is not a table name.');
  const labels = Array.isArray(input.labels) ? input.labels as LabelIn[] : [];
  const records = Array.isArray(input.records) ? input.records as [string, number[]][] : [];
  if (labels.length > 5000 || records.length > 20_000) throw new GateError('invalid', 'That is more than a tagged table has.');
  for (const l of labels) {
    if ((l.kind !== 'tag' && l.kind !== 'category') || typeof l.name !== 'string' || !LABEL_NAME.test(l.name) || typeof l.public !== 'boolean') {
      throw new GateError('invalid', 'The panel sent a label the gate could not read.');
    }
  }
  const rows: { key: string; kind: string; name: string; public: boolean }[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || r[0].length < 1 || r[0].length > 4096 || !Array.isArray(r[1])) {
      throw new GateError('invalid', 'The panel sent a record the gate could not read.');
    }
    for (const i of r[1]) {
      const l = labels[i];
      if (!l) throw new GateError('invalid', 'The panel sent a record the gate could not read.');
      const k = `${r[0]}\n${l.kind}\n${l.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ key: r[0], kind: l.kind, name: l.name, public: l.public });
    }
  }
  await tx(db, async (q) => {
    await run(q, 'DELETE FROM record_labels WHERE database_id = ? AND table_name = ?', id, input.table as string);
    for (let i = 0; i < rows.length; i += 5000) {
      await run(q, `INSERT INTO record_labels (database_id, table_name, key, kind, name, public)
        SELECT ?, ?, r.key, r.kind, r.name, r.public FROM jsonb_to_recordset(?::text::jsonb) AS r(key text, kind text, name text, public boolean)`,
        id, input.table as string, JSON.stringify(rows.slice(i, i + 5000)));
    }
  });
  return { records: new Set(rows.map((r) => r.key)).size, links: rows.length };
}

// After each listing: the tables still tagged. Any other table's copy goes (switched off,
// renamed, dropped, the database no longer looked after).
export async function keepRecordLabels(db: Db, tables: unknown): Promise<{ removed: number }> {
  const keep = (Array.isArray(tables) ? tables : []).flatMap((t) => {
    const o = (t ?? {}) as { databaseId?: unknown; table?: unknown };
    return Number.isSafeInteger(Number(o.databaseId)) && typeof o.table === 'string' && TABLE_NAME.test(o.table)
      ? [{ database_id: Number(o.databaseId), table_name: o.table }] : [];
  });
  const removed = await run(db, `DELETE FROM record_labels x WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(?::text::jsonb) AS k(database_id bigint, table_name text)
     WHERE k.database_id = x.database_id AND k.table_name = x.table_name)`, JSON.stringify(keep));
  return { removed };
}

// Each of these records' labels (only public ones for a reader without a key).
export async function labelsOfKeys(db: Db, databaseId: number, table: string, keys: string[], publicOnly: boolean): Promise<Map<string, LabelNames>> {
  const out = new Map<string, LabelNames>();
  if (!keys.length) return out;
  const rows = await all<{ key: string; kind: 'tag' | 'category'; name: string }>(db,
    `SELECT key, kind, name FROM record_labels WHERE database_id = ? AND table_name = ? AND key = ANY (?::text::text[])
     ${publicOnly ? 'AND public' : ''} ORDER BY name`, databaseId, table, pgArray(keys));
  for (const r of rows) {
    const n = out.get(r.key) ?? { tags: [], categories: [] };
    (r.kind === 'tag' ? n.tags : n.categories).push(r.name);
    out.set(r.key, n);
  }
  return out;
}

// The keys of the records with every one of these labels; or the first one nobody has
// (for a reader without a key, that nobody has as a public label).
export async function keysWithAll(db: Db, databaseId: number, table: string, wants: { kind: 'tag' | 'category'; name: string }[], publicOnly: boolean):
  Promise<{ keys: string[] } | { missing: { kind: 'tag' | 'category'; name: string } }> {
  let keys: string[] | null = null;
  for (const w of wants) {
    const got = (await all<{ key: string }>(db, `SELECT key FROM record_labels WHERE database_id = ? AND table_name = ? AND kind = ? AND name = ?
      ${publicOnly ? 'AND public' : ''}`, databaseId, table, w.kind, w.name)).map((r) => r.key);
    if (!got.length) return { missing: w };
    const have = new Set(got);
    keys = keys === null ? got : keys.filter((k) => have.has(k));
  }
  return { keys: [...(keys ?? [])].sort() };
}

// A table's labels: for a page's filter buttons. With a key, how many records have each and
// whether it's public; without one, the public names only (a count would give away records
// her rule keeps back).
export async function labelCounts(db: Db, databaseId: number, table: string, publicOnly: boolean) {
  const rows = await all<{ kind: 'tag' | 'category'; name: string; public: boolean; n: number }>(db,
    `SELECT kind, name, bool_or(public) AS public, count(*)::int AS n FROM record_labels WHERE database_id = ? AND table_name = ?
     ${publicOnly ? 'AND public' : ''} GROUP BY kind, name ORDER BY name`, databaseId, table);
  const one = (r: typeof rows[number]) => (publicOnly ? { name: r.name } : { name: r.name, records: Number(r.n), public: r.public });
  return { tags: rows.filter((r) => r.kind === 'tag').map(one), categories: rows.filter((r) => r.kind === 'category').map(one) };
}

// a text[] literal for ?::text::text[] (quoted, so any key is one element)
const pgArray = (xs: string[]) => `{${xs.map((x) => `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

export const catalogFor = (db: Db, engine: string, name: string) =>
  one<CatalogRow>(db, 'SELECT * FROM studio_catalog WHERE engine = ? AND name = ?', engine, name);

// ------------------------------------------------------------------ keys

export async function createAppKey(db: Db, now: number, input: {
  databaseId: unknown; label: unknown; resources: unknown; canWrite: unknown;
}, by: unknown): Promise<{ key: string; appKey: AppKey }> {
  const id = Number(input.databaseId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new GateError('invalid', 'The panel did not say which database.');
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 80) : '';
  if (!label) throw new GateError('invalid', 'Give the key a name, like "Olivia\'s website".');
  const resources = input.resources === 'all'
    ? 'all'
    : Array.isArray(input.resources) && input.resources.length
      ? [...new Set(input.resources.filter((r): r is string => typeof r === 'string'))]
      : null;
  if (resources === null) throw new GateError('invalid', 'Choose what the key can reach: everything, or some of it.');
  if ((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM studio_app_keys WHERE revoked_at IS NULL'))!.n >= MAX_APP_KEYS) {
    throw new GateError('full', `There can be at most ${MAX_APP_KEYS} keys. Revoke one you don't use first.`);
  }
  // `pammy_app_` so a key for her data is never mistaken for a form key at a
  // glance -- and neither regex matches the other's keys
  const key = `pammy_app_${randomBytes(32).toString('base64url')}`;
  const r = await one<AppKeyRow>(db,
    `INSERT INTO studio_app_keys (database_id, label, prefix, key_hash, grants, can_write, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    id, label, key.slice(0, 18), hashToken(key), JSON.stringify(resources), input.canWrite === true, now,
    typeof by === 'string' ? by.slice(0, 80) : null);
  return { key, appKey: toKey(r!) };
}

export const listAppKeys = async (db: Db, databaseId: unknown) =>
  (await all<AppKeyRow>(db,
    'SELECT * FROM studio_app_keys WHERE database_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC',
    Number(databaseId))).map(toKey);

export async function revokeAppKey(db: Db, now: number, id: unknown, by: unknown): Promise<AppKey> {
  return tx(db, async (q) => {
    const r = await one<AppKeyRow>(q, 'SELECT * FROM studio_app_keys WHERE id = ?', Number(id));
    if (!r) throw new GateError('not-found', 'That key no longer exists.');
    if (r.revoked_at) throw new GateError('exists', 'That key was already revoked.');
    return toKey((await one<AppKeyRow>(q,
      'UPDATE studio_app_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? RETURNING *',
      now, typeof by === 'string' ? by.slice(0, 80) : null, r.id))!);
  });
}

// A table she renamed: every key that named it names the new one instead. Keys
// for "all" say nothing about names and are left alone. Revoked keys too, so
// the list of keys still says what each one could reach.
export async function renameAppKeyGrants(db: Db, databaseId: unknown, from: unknown, to: unknown): Promise<number> {
  const id = Number(databaseId);
  const name = /^[a-z][a-z0-9_]{0,62}$/;
  if (!Number.isSafeInteger(id) || typeof from !== 'string' || typeof to !== 'string' || !name.test(from) || !name.test(to)) {
    throw new GateError('invalid', 'The panel did not say which table was renamed.');
  }
  return tx(db, async (q) => {
    const rows = await all<AppKeyRow>(q, 'SELECT * FROM studio_app_keys WHERE database_id = ?', id);
    let changed = 0;
    for (const r of rows) {
      const grants = grantsOf(r.grants);
      if (grants === 'all' || !grants.includes(from)) continue;
      const next = [...new Set(grants.map((g) => (g === from ? to : g)))];
      await run(q, 'UPDATE studio_app_keys SET grants = ? WHERE id = ?', JSON.stringify(next), r.id);
      changed++;
    }
    return changed;
  });
}

export async function appKeyFor(db: Db, now: number, token: string): Promise<AppKey | null> {
  if (!APP_KEY_RE.test(token)) return null;
  const r = await one<AppKeyRow>(db, 'SELECT * FROM studio_app_keys WHERE key_hash = ?', hashToken(token));
  if (!r || r.revoked_at) return null;
  if (!r.last_used_at || now - r.last_used_at >= 60) await run(db, 'UPDATE studio_app_keys SET last_used_at = ? WHERE id = ?', now, r.id);
  return toKey(r);
}

// ------------------------------------------------------------------ what a request may do

export type Allowed = { catalog: CatalogRow; resource: CatalogResource };

// The three gates, in order. Every refusal says which one it was, because
// "403" on its own sends her looking in the wrong place.
// Whether this request may read another resource in the same catalog -- the
// question the connections in an answer ask (docs/db-examples-plan.md X7): a
// label from a table the request could not read by itself is left out.
export function mayRead(row: CatalogRow, key: AppKey | null, r: CatalogResource, visitor: Visitor | null = null): boolean {
  if (!row.api_read || !r.can.view) return false;
  if (!key && visitor && signedInFor(r, visitor)) return true;
  if (!key) return !!r.public;
  return key.databaseId === row.database_id && (key.resources === 'all' || key.resources.includes(r.slug));
}

// A read without a key: only a table she has said anyone may read, and only
// reading (docs/db-examples-plan.md X1).
const READING: Ability[] = ['view', 'search', 'sort', 'filter'];

// Someone signed in to one of her protected folders (docs/tutorials-plan.md
// V1): their username, and the folders (area ids) they may open.
export type Visitor = { username: string; opens: ReadonlySet<number> };
const signedInFor = (r: CatalogResource, v: Visitor) => !!r.visitors && v.opens.has(r.visitors.area);

// X12: a request reads a table through her public rule exactly when it reads
// it only because anyone may -- no key, and not signed in to that table's
// folder. Asked per table, so connections get the same answer as the table itself.
export const onlyPublicRows = (key: AppKey | null, r: CatalogResource, visitor: Visitor | null): boolean =>
  !key && !(visitor && signedInFor(r, visitor));

// V2: the rows a signed-in person may reach, when each only sees their own.
export const ownerOf = (r: CatalogResource, visitor: string | null): { column: string; value: string } | null =>
  (visitor && r.visitors?.owner ? { column: r.visitors.owner, value: visitor } : null);

export function allow(row: CatalogRow | undefined, key: AppKey | null, slug: string, write: boolean, ability: Ability, visitor: Visitor | null = null):
  { ok: true; resource: CatalogResource; keyless: boolean; visitor: string | null } | { ok: false; status: number; code: string; message: string } {
  if (!row) return { ok: false, status: 404, code: 'no-app', message: 'There is no app here.' };
  // 1. the switch
  if (!(write ? row.api_write : row.api_read)) {
    return {
      ok: false, status: 403, code: write ? 'writing-off' : 'reading-off',
      message: write
        ? 'This app is not set up to be changed by programs. Switch writing on in the panel first.'
        : 'This app is not set up to be read by programs. Switch reading on in the panel first.',
    };
  }
  const resource = readCatalog(row.catalog_json).resources.find((r) => r.slug === slug);
  if (!resource) return { ok: false, status: 404, code: 'no-resource', message: 'This app has no table called that.' };
  // 2. the key -- or someone signed in to the folder she chose (V1) -- or, for
  // reading a table anyone may read, no key at all
  if (!key && visitor && signedInFor(resource, visitor)) {
    if (!resource.can[ability]) {
      return { ok: false, status: 403, code: 'switched-off', message: `${resource.plural} are set up so that cannot be done.` };
    }
    return { ok: true, resource, keyless: false, visitor: visitor.username };
  }
  if (!key && !write && resource.public && READING.includes(ability)) {
    if (!resource.can[ability]) {
      return { ok: false, status: 403, code: 'switched-off', message: `${resource.plural} are set up so that cannot be done.` };
    }
    return { ok: true, resource, keyless: true, visitor: null };
  }
  if (!key || key.databaseId !== row.database_id) {
    return { ok: false, status: 401, code: 'no-key', message: 'This needs a key: send it as "Authorization: Bearer ...".' };
  }
  if (key.resources !== 'all' && !key.resources.includes(resource.slug)) {
    return { ok: false, status: 403, code: 'not-this-one', message: 'That key does not reach this part of the app.' };
  }
  if (write && !key.canWrite) {
    return { ok: false, status: 403, code: 'read-only-key', message: 'That key can read, but not change anything.' };
  }
  // 3. the catalog, which is the one that matters: a key cannot outlive a
  // decision she made about the Resource itself
  if (!resource.can[ability]) {
    return { ok: false, status: 403, code: 'switched-off', message: `${resource.plural} are set up so that cannot be done.` };
  }
  return { ok: true, resource, keyless: false, visitor: null };
}
