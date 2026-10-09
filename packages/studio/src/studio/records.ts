// Her records, through the Resource's window (docs/databases-plan.md 11.1).
//
// This is the security boundary of the generated app, and it is worth being
// blunt about what it is for: **being in the database is not permission to read
// or write.** The helper will happily select any column it is handed a name
// for. What stops `password_hash` reaching a page, or a page writing to
// `is_admin`, is this file and nothing else.
//
// So every request takes the same shape:
//
//   1. work out the Resource (inference + her overrides), fresh
//   2. check the ability the request needs is switched on
//   3. reduce what was asked for down to the exposed fields, dropping the rest
//   4. only then ask the helper
//
// Step 3 **drops** what it does not recognise rather than refusing: a stale
// browser asking for a column she has since hidden should see the page without
// it, not an error. A WRITE to a hidden column is different -- that is refused,
// because quietly ignoring half of what someone sent is how data goes missing.
import { AccountError } from '@panel/core/accounts';
import { NAME_RE } from '../pammydb/ident.ts';
import { PAGE, type Filter, type RowQuery, type Scalar } from '../pammydb/rows.ts';
import type { Ability, ResourceView } from './resources.ts';
import { asRich, MAX_RICH_SENT, plainOf, RichTextError } from './rich-text.ts';

// What the browser may ask for when listing.
export type ListAsk = {
  page: number;
  search: string;
  sort: { column: string; dir: 'asc' | 'desc' } | null;
  filters: Filter[];
};

export const abilityMissing = (r: ResourceView, a: Ability): AccountError | null =>
  (r.can[a] ? null : new AccountError(whyNot(r, a), 403));

function whyNot(r: ResourceView, a: Ability): string {
  switch (a) {
    case 'create': return `${r.plural} are set up so that new ones cannot be added here.`;
    case 'edit': return `${r.plural} are set up so that they cannot be changed here.`;
    case 'delete': return `${r.plural} are set up so that they cannot be deleted here.`;
    case 'view': return `${r.plural} are not set up to be looked at here.`;
    default: return `That is switched off for ${r.plural}.`;
  }
}

// The fields a page may read: what she exposed, plus the key, which the app
// always needs to say which record it means (and which the API calls `id`).
export const readable = (r: ResourceView): string[] => {
  const out = r.fields.filter((f) => f.exposed || f.primaryKey).map((f) => f.name);
  return out.length ? out : r.fields.slice(0, 1).map((f) => f.name);
};

// The key. Without one there is no honest way to say "this record", so the
// generated pages refuse rather than guessing at row order.
export function keyOf(r: ResourceView): string[] {
  const key = r.fields.filter((f) => f.primaryKey).map((f) => f.name);
  if (key.length === 0) {
    throw new AccountError(
      `${r.plural} have no field that tells one record from another, so the panel cannot safely open one. Give the table a primary key on the Tables page first.`, 400);
  }
  return key;
}

// Which record, from the address. Every part of the key must be there.
export function whereFor(r: ResourceView, params: Record<string, unknown>): Record<string, Scalar> {
  const where: Record<string, Scalar> = {};
  for (const k of keyOf(r)) {
    const v = params[k];
    if (v === undefined || v === null || v === '') {
      throw new AccountError('The panel could not tell which record you meant.', 400);
    }
    where[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  return where;
}

// What the list shows, and how it is narrowed. Everything is clipped to the
// window: a sort or a filter on a hidden field is dropped, not honoured.
export function listQuery(r: ResourceView, ask: ListAsk): RowQuery {
  const columns = readable(r);
  const shown = new Set(columns);
  const searchable = r.fields.filter((f) => f.exposed && f.searchable).map((f) => f.name);
  const filterable = new Set(r.fields.filter((f) => f.exposed && f.filterable).map((f) => f.name));

  const sort = ask.sort && r.can.sort && shown.has(ask.sort.column) ? ask.sort : null;
  // always sorted by something, or page 2 may hold what page 1 did
  const fallback = r.sortField && shown.has(r.sortField)
    ? { column: r.sortField, dir: r.sortDir }
    : { column: keyOf(r)[0]!, dir: 'asc' as const };

  return {
    table: r.table,
    columns,
    limit: PAGE,
    offset: Math.max(0, (Math.max(1, ask.page) - 1) * PAGE),
    order: sort ?? fallback,
    search: r.can.search && ask.search.trim() && searchable.length
      ? { columns: searchable, text: ask.search.trim() }
      : null,
    filters: r.can.filter ? ask.filters.filter((f) => filterable.has(f.column)) : [],
  };
}

// ------------------------------------------------------------ the record picker
// (docs/record-picker-plan.md). Choosing the recipe an ingredient belongs to
// reads the RECIPES, through their own window: the fields shown there, the
// ones searchable there, in their own order.

// What the picker's "Filter by field" may use, and how (R5): a yes/no or a
// connection is one value, a number or a moment is from / to, a line of text
// is "contains". Long writing is left out -- nobody picks a recipe by its method.
const PICK_KINDS: Partial<Record<string, Filter['kind'][]>> = {
  tick: ['equals'], picker: ['equals'], line: ['contains', 'equals'],
  number: ['range', 'equals'], date: ['range', 'equals'], time: ['range'], moment: ['range'],
};
export const pickFilterable = (r: ResourceView) =>
  r.fields.filter((f) => f.exposed && !f.primaryKey && PICK_KINDS[f.control]);

export function pickQuery(r: ResourceView, ask: ListAsk): RowQuery {
  const columns = readable(r);
  const searchable = r.fields.filter((f) => f.exposed && f.searchable).map((f) => f.name);
  const allowed = new Map(pickFilterable(r).map((f) => [f.name, PICK_KINDS[f.control]!]));
  const title = r.titleField && columns.includes(r.titleField) ? r.titleField : null;
  const order = r.sortField && columns.includes(r.sortField)
    ? { column: r.sortField, dir: r.sortDir }
    : title ? { column: title, dir: 'asc' as const } : { column: keyOf(r)[0]!, dir: 'asc' as const };
  return {
    table: r.table,
    columns,
    limit: PAGE,
    offset: Math.max(0, (Math.max(1, ask.page) - 1) * PAGE),
    order,
    // searching is how a picker works, so it does not wait for "Search" to
    // be ticked -- but only ever across what she said is searchable
    search: ask.search.trim() && searchable.length ? { columns: searchable, text: ask.search.trim() } : null,
    // all of them at once (AND), each only in a way that fits its field
    filters: ask.filters.filter((f) => allowed.get(f.column)?.includes(f.kind)).slice(0, 10),
  };
}

// Values on the way in. A field she has hidden, or one the panel cannot
// change, is refused rather than dropped -- see the note at the top.
export function valuesFor(r: ResourceView, body: unknown, mode: 'create' | 'edit'): Record<string, Scalar> {
  const sent = ((body ?? {}) as Record<string, unknown>).values;
  const o = (sent ?? {}) as Record<string, unknown>;
  if (typeof o !== 'object' || Array.isArray(o)) throw new AccountError('The panel could not read what you filled in.', 400);
  const byName = new Map(r.fields.map((f) => [f.name, f]));
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!NAME_RE.test(k)) throw new AccountError('The panel could not read what you filled in.', 400);
    const f = byName.get(k);
    if (!f) throw new AccountError(`There is no field called ${k} in ${r.singular}.`, 400);
    if (!f.exposed) throw new AccountError(`${f.label} is hidden, so it cannot be filled in here.`, 403);
    // the key fills itself in on create, and changing it afterwards would make
    // "this record" mean something else half way through
    if (f.primaryKey && mode === 'edit') continue;
    if (f.primaryKey && mode === 'create' && (v === null || v === '')) continue;
    out[k] = f.control === 'rich' ? cleanRichValue(v, f.label) : clean(v, f.label);
  }
  return out;
}

// A rich-text field on the way in (docs/rich-text-plan.md T6): through the
// cleaner, whatever the browser sent. Writing with no tags in it becomes
// paragraphs; an empty editor is nothing.
function cleanRichValue(v: unknown, label: string): Scalar {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new AccountError(`The panel could not read what you put in ${label}.`, 400);
  if (v.length > MAX_RICH_SENT) throw new AccountError(`${label} is too long to store.`, 400);
  try {
    return asRich(v);
  } catch (e) {
    if (e instanceof RichTextError) throw new AccountError(`${label}: ${e.message}`, 400);
    throw e;
  }
}

// Rich-text fields on the way out. Opening a record for the editor: clean HTML
// (T7 -- what is stored may not have come through here). A list or the record
// picker: the words alone, never HTML (T15).
export const richFields = (r: ResourceView): string[] => r.fields.filter((f) => f.control === 'rich').map((f) => f.name);

export function richForEditing(r: ResourceView, row: Record<string, unknown>): Record<string, unknown> {
  for (const k of richFields(r)) if (k in row) row[k] = asRich(row[k], { limits: false });
  return row;
}

export function richAsWords(r: ResourceView, items: Record<string, unknown>[]): Record<string, unknown>[] {
  const rich = richFields(r);
  if (rich.length) {
    for (const item of items) {
      for (const k of rich) if (typeof item[k] === 'string') item[k] = plainOf(item[k] as string, 200);
    }
  }
  return items;
}

function clean(v: unknown, label: string): Scalar {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length > 100_000) throw new AccountError(`${label} is too long to store.`, 400);
    return v;
  }
  throw new AccountError(`The panel could not read what you put in ${label}.`, 400);
}

// The counts a delete should show first, when she asked to be warned (D20).
// Read through the same window: only Resources she manages are counted.
export const relatedTables = (r: ResourceView): string[] =>
  [...new Set(r.related.filter((x) => x.kind !== 'one-to-one').map((x) => x.other))];
