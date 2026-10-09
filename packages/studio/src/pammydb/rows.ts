// Asking for rows, as a shape rather than as SQL (docs/studio-plan.md
// "`list-rows`: limit, offset, sort, search, filters -> { items, total }").
//
// This is the first thing in the studio that touches what is actually IN her
// tables, so the two rules it exists to enforce are worth stating plainly:
//
//  1. **Every identifier is a name, checked and quoted.** A column arrives as a
//     name matching NAME_RE and leaves through `quote()`. There is no path by
//     which a string from a browser becomes part of a statement unquoted.
//  2. **Every value is a parameter.** Not escaped, not quoted -- passed to the
//     driver beside the statement. Searching for `'; DROP TABLE` finds nothing
//     and does nothing, which is the only acceptable behaviour.
//
// The helper still holds no opinion about Resources: which columns may be read
// or written is the panel's business (src/studio/records.ts), and by the time a
// query reaches here it is already a list of column names.
import { NAME_RE, PammyDbError, quote, type Engine } from './ident.ts';

export type Scalar = string | number | boolean | null;

export type Order = { column: string; dir: 'asc' | 'desc' };

export type Filter =
  | { kind: 'equals'; column: string; value: Scalar }
  | { kind: 'contains'; column: string; text: string }
  | { kind: 'range'; column: string; from: Scalar; to: Scalar }
  | { kind: 'empty'; column: string; empty: boolean }
  // one of these values: how the data API finds the labels for a page of
  // connections in one statement rather than one per row
  | { kind: 'in'; column: string; values: Scalar[] };

export type RowQuery = {
  table: string;
  // exactly the columns to read: the Resource's window, worked out by the panel
  columns: string[];
  limit: number;
  offset: number;
  order: Order | null;
  // one box across several columns, the way she expects a search to work
  search: { columns: string[]; text: string } | null;
  filters: Filter[];
};

export type RowPage = { items: Record<string, unknown>[]; total: number };

// How many rows one page is, and the most the helper will ever return. Fixed at
// 20 in v1 (docs/databases-plan.md 11.7); the cap is here so a request cannot
// ask for her whole table by saying limit=1000000.
export const PAGE = 20;
export const MAX_LIMIT = 200;
// "one of these values": up to as many records as a tagged table has (docs/catalog-plan.md
// step 4b, B6), so asking by a tag works whatever its size. One parameter per value.
export const MAX_IN = 20_000;

const name = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !NAME_RE.test(v)) {
    throw new PammyDbError('invalid', `That is not a ${what} name this panel will use.`);
  }
  return v;
};

const scalar = (v: unknown): Scalar => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 100_000 ? v.slice(0, 100_000) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  // a shape the panel does not send; refused rather than guessed at
  throw new PammyDbError('invalid', 'That value is not one this panel knows how to store.');
};

// A table name on its own, for the one operation that names no columns.
export const checkTableName = (v: unknown): string => name(v, 'table');

export function checkQuery(v: unknown): RowQuery {
  const o = (v ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(o.columns) ? o.columns.map((c) => name(c, 'field')) : [];
  if (columns.length === 0) throw new PammyDbError('invalid', 'A list needs at least one field to show.');
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(o.limit) || PAGE));
  const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(o.offset) || 0)));
  const ord = (o.order ?? null) as Record<string, unknown> | null;
  const search = (o.search ?? null) as Record<string, unknown> | null;
  return {
    table: name(o.table, 'table'),
    columns,
    limit,
    offset,
    order: ord ? { column: name(ord.column, 'field'), dir: ord.dir === 'desc' ? 'desc' : 'asc' } : null,
    search: search && typeof search.text === 'string' && search.text.trim() && Array.isArray(search.columns)
      ? { columns: search.columns.map((c) => name(c, 'field')), text: String(search.text).slice(0, 200) }
      : null,
    filters: (Array.isArray(o.filters) ? o.filters : []).slice(0, 20).map(checkFilter),
  };
}

function checkFilter(v: unknown): Filter {
  const o = (v ?? {}) as Record<string, unknown>;
  const column = name(o.column, 'field');
  switch (o.kind) {
    case 'equals': return { kind: 'equals', column, value: scalar(o.value) };
    case 'contains': return { kind: 'contains', column, text: String(o.text ?? '').slice(0, 200) };
    case 'range': return { kind: 'range', column, from: scalar(o.from), to: scalar(o.to) };
    case 'empty': return { kind: 'empty', column, empty: o.empty !== false };
    case 'in': {
      const values = (Array.isArray(o.values) ? o.values : []).slice(0, MAX_IN).map(scalar).filter((x) => x !== null);
      return { kind: 'in', column, values };
    }
    default: throw new PammyDbError('invalid', 'That is not a way of narrowing a list that this panel offers.');
  }
}

// The values of one row, on the way in. Column names checked; values left to
// the driver to pass as parameters.
// set-links: which record, and the ids it is to be paired with -- plain values,
// none of them empty, at most a thousand, each once.
export function checkLinks(o: { table: unknown; here: unknown; id: unknown; there: unknown; ids: unknown }):
  { table: string; here: string; id: Scalar; there: string; ids: Scalar[] } {
  const id = scalar(o.id);
  if (id === null || id === '') throw new PammyDbError('invalid', 'The panel could not tell which record those connections are for.');
  if (!Array.isArray(o.ids) || o.ids.length > 1000) throw new PammyDbError('invalid', 'That is more connections than the panel will save in one go.');
  const seen = new Set<string>();
  const ids = o.ids.map((x) => scalar(x)).filter((x) => x !== null && x !== '' && !seen.has(String(x)) && !!seen.add(String(x)));
  return { table: name(o.table, 'table'), here: name(o.here, 'field'), id, there: name(o.there, 'field'), ids };
}

export function checkValues(v: unknown): Record<string, Scalar> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, Scalar> = {};
  for (const [k, value] of Object.entries(o)) out[name(k, 'field')] = scalar(value);
  return out;
}

// Which row. Always by the table's own key, never by position: "the third row"
// is not a thing that survives someone else adding a row.
export function checkWhere(v: unknown): Record<string, Scalar> {
  const where = checkValues(v);
  if (Object.keys(where).length === 0) {
    throw new PammyDbError('invalid', 'The panel could not tell which record you meant.');
  }
  return where;
}

// `%` and `_` mean something to LIKE, so a search for "100%" must not become a
// search for "anything starting 100". Escaped with a backslash, and both
// engines are told that is the escape character.
export const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

// ------------------------------------------------------------------ building the statement

// One builder for both engines. They differ in two small ways -- how a name is
// quoted and how a parameter is written -- and in nothing else, so writing this
// twice would be two chances to get the escaping wrong instead of one.
export type Built = { text: string; params: Scalar[] };

const mark = (engine: Engine, n: number) => (engine === 'postgres' ? `$${n}` : '?');

// Telling LIKE that backslash is the escape character -- and the two engines
// need it written differently, which is not a nicety. Inside a MariaDB string
// literal a backslash is ITSELF an escape, so `ESCAPE '\'` is an escaped quote
// and the statement does not parse at all. Postgres (standard_conforming_strings)
// takes the same text as one backslash. So MariaDB gets it doubled.
const escapeClause = (engine: Engine) => (engine === 'postgres' ? "ESCAPE '\\'" : "ESCAPE '\\\\'");

type Sql = {
  engine: Engine;
  params: Scalar[];
  // the only way a value ever reaches a statement
  val(v: Scalar): string;
  id(name: string): string;
};

const sqlFor = (engine: Engine): Sql => {
  const params: Scalar[] = [];
  return {
    engine,
    params,
    val(v) { params.push(v); return mark(engine, params.length); },
    id(name) { return quote(engine, name); },
  };
};

function where(s: Sql, table: string, filters: Filter[], search: RowQuery['search']): string {
  const parts: string[] = [];
  for (const f of filters) {
    const col = `${s.id(table)}.${s.id(f.column)}`;
    switch (f.kind) {
      case 'equals':
        parts.push(f.value === null ? `${col} IS NULL` : `${col} = ${s.val(f.value)}`);
        break;
      case 'contains': {
        // ignores case on both engines, like the search box (Postgres' LIKE matches case)
        const asText = s.engine === 'postgres' ? `CAST(${col} AS TEXT)` : `CAST(${col} AS CHAR)`;
        parts.push(`LOWER(${asText}) LIKE LOWER(${s.val(`%${likeEscape(f.text)}%`)}) ${escapeClause(s.engine)}`);
        break;
      }
      case 'range': {
        if (f.from !== null) parts.push(`${col} >= ${s.val(f.from)}`);
        if (f.to !== null) parts.push(`${col} <= ${s.val(f.to)}`);
        break;
      }
      case 'empty':
        parts.push(f.empty ? `${col} IS NULL` : `${col} IS NOT NULL`);
        break;
      case 'in':
        // nothing to be one of is nothing at all, not everything
        parts.push(f.values.length ? `${col} IN (${f.values.map((v) => s.val(v)).join(', ')})` : '1 = 0');
        break;
    }
  }
  if (search) {
    // one box, several columns: any of them matching is a match. Cast so a
    // number or a date can be searched as the text she sees.
    const text = s.val(`%${likeEscape(search.text)}%`);
    const any = search.columns.map((c) => {
      const col = `${s.id(table)}.${s.id(c)}`;
      const asText = s.engine === 'postgres' ? `CAST(${col} AS TEXT)` : `CAST(${col} AS CHAR)`;
      // case-insensitive: Postgres needs telling, MariaDB's default collation
      // already is, and asking for LOWER() twice costs nothing either way
      return `LOWER(${asText}) LIKE LOWER(${text}) ${escapeClause(s.engine)}`;
    });
    if (any.length) parts.push(`(${any.join(' OR ')})`);
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

export function buildList(engine: Engine, q: RowQuery): { rows: Built; count: Built } {
  const rows = sqlFor(engine);
  const clause = where(rows, q.table, q.filters, q.search);
  const cols = q.columns.map((c) => `${rows.id(q.table)}.${rows.id(c)}`).join(', ');
  // Sorted by something, always: without an ORDER BY neither engine promises
  // page 2 holds what page 1 did not, and she would see rows twice.
  const order = q.order
    ? ` ORDER BY ${rows.id(q.table)}.${rows.id(q.order.column)} ${q.order.dir === 'desc' ? 'DESC' : 'ASC'}`
    : '';
  const text = `SELECT ${cols} FROM ${rows.id(q.table)}${clause}${order}`
    + ` LIMIT ${rows.val(q.limit)} OFFSET ${rows.val(q.offset)}`;

  // the same narrowing, counted: "8 of 32" has to mean the same 8
  const count = sqlFor(engine);
  const countClause = where(count, q.table, q.filters, q.search);
  return {
    rows: { text, params: rows.params },
    count: { text: `SELECT count(*) AS n FROM ${count.id(q.table)}${countClause}`, params: count.params },
  };
}

const whereOnly = (s: Sql, table: string, w: Record<string, Scalar>): string =>
  ` WHERE ${Object.entries(w).map(([c, v]) =>
    (v === null ? `${s.id(table)}.${s.id(c)} IS NULL` : `${s.id(table)}.${s.id(c)} = ${s.val(v)}`)).join(' AND ')}`;

export function buildGet(engine: Engine, table: string, columns: string[], w: Record<string, Scalar>): Built {
  const s = sqlFor(engine);
  const cols = columns.map((c) => `${s.id(table)}.${s.id(c)}`).join(', ');
  return { text: `SELECT ${cols} FROM ${s.id(table)}${whereOnly(s, table, w)} LIMIT 2`, params: s.params };
}

export function buildInsert(engine: Engine, table: string, values: Record<string, Scalar>): Built {
  const s = sqlFor(engine);
  const entries = Object.entries(values);
  if (entries.length === 0) {
    // every column has a default or is filled in by the engine
    return { text: engine === 'postgres' ? `INSERT INTO ${s.id(table)} DEFAULT VALUES` : `INSERT INTO ${s.id(table)} () VALUES ()`, params: [] };
  }
  const cols = entries.map(([c]) => s.id(c)).join(', ');
  const marks = entries.map(([, v]) => s.val(v)).join(', ');
  return { text: `INSERT INTO ${s.id(table)} (${cols}) VALUES (${marks})`, params: s.params };
}

export function buildUpdate(engine: Engine, table: string, values: Record<string, Scalar>, w: Record<string, Scalar>): Built | null {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  const s = sqlFor(engine);
  const sets = entries.map(([c, v]) => `${s.id(c)} = ${s.val(v)}`).join(', ');
  return { text: `UPDATE ${s.id(table)} SET ${sets}${whereOnly(s, table, w)}`, params: s.params };
}

export function buildDelete(engine: Engine, table: string, w: Record<string, Scalar>): Built {
  const s = sqlFor(engine);
  return { text: `DELETE FROM ${s.id(table)}${whereOnly(s, table, w)}`, params: s.params };
}

// A record's pairs in a connecting table, replaced (docs/record-picker-plan.md
// R12): the ones no longer chosen go, the new ones are added, and a pair that
// is already there is left alone. Two statements, which the drivers run in one
// transaction. A pair pointing at something that is not there is still an
// error from the engine -- only "already there" is let through, never a bad id
// (which MariaDB's INSERT IGNORE would quietly drop).
export function buildSetLinks(engine: Engine, table: string, here: string, id: Scalar, there: string, ids: Scalar[]): { remove: Built; add: Built | null } {
  const d = sqlFor(engine);
  const which = `${d.id(here)} = ${d.val(id)}`;
  const keep = ids.length ? ` AND ${d.id(there)} NOT IN (${ids.map((v) => d.val(v)).join(', ')})` : '';
  const remove = { text: `DELETE FROM ${d.id(table)} WHERE ${which}${keep}`, params: d.params };
  if (!ids.length) return { remove, add: null };
  const a = sqlFor(engine);
  const rows = ids.map((v) => `(${a.val(id)}, ${a.val(v)})`).join(', ');
  const cols = `${a.id(table)} (${a.id(here)}, ${a.id(there)})`;
  const text = engine === 'postgres'
    ? `INSERT INTO ${cols} VALUES ${rows} ON CONFLICT DO NOTHING`
    : `INSERT INTO ${cols} VALUES ${rows} ON DUPLICATE KEY UPDATE ${a.id(here)} = ${a.id(here)}`;
  return { remove, add: { text, params: a.params } };
}
