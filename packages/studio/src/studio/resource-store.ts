// The stored half of a Resource definition (docs/databases-plan.md 15).
// `resources.ts` decides what things mean; this only writes down the places
// where she has disagreed with it.
//
// Every write is an upsert of one row, because that is what the page does: she
// ticks one box, not a form. And a row is only ever written when she changes
// something, so `studio_resources` stays a list of her decisions rather than a
// second copy of the schema.
import { all, one, run, type Db, type Param } from '@panel/core/pg';
import { readOrder, type Ability, type FieldPatch, type FieldRow, type ResourcePatch, type ResourceRow } from './resources.ts';

export const resourceRows = (db: Db, databaseId: number) =>
  all<ResourceRow>(db, 'SELECT * FROM studio_resources WHERE database_id = ? ORDER BY table_name', databaseId);

export const fieldRows = (db: Db, databaseId: number) =>
  all<FieldRow>(db, 'SELECT * FROM studio_fields WHERE database_id = ? ORDER BY table_name, form_order', databaseId);

// Make sure there is a row to change, then change it. Split in two so the
// defaults live in the migration rather than being restated here.
async function ensureResource(db: Db, databaseId: number, table: string): Promise<void> {
  await run(db,
    `INSERT INTO studio_resources (database_id, table_name) VALUES (?, ?)
     ON CONFLICT (database_id, table_name) DO NOTHING`, databaseId, table);
}

export async function saveResource(db: Db, databaseId: number, table: string, patch: ResourcePatch): Promise<void> {
  await ensureResource(db, databaseId, table);
  const sets: string[] = [];
  const args: Param[] = [];
  const set = (col: string, value: Param) => { sets.push(`${col} = ?`); args.push(value); };
  if (patch.enabled !== undefined) set('enabled', patch.enabled);
  if (patch.singular !== undefined) set('singular', patch.singular);
  if (patch.plural !== undefined) set('plural', patch.plural);
  if (patch.icon !== undefined) set('icon', patch.icon);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.titleField !== undefined) set('title_field', patch.titleField);
  if (patch.sortField !== undefined) set('sort_field', patch.sortField);
  if (patch.sortDir !== undefined) set('sort_dir', patch.sortDir);
  if (patch.onDelete !== undefined) set('on_delete', patch.onDelete);
  if (patch.publicRead !== undefined) set('public_read', patch.publicRead);
  if (patch.publicOnly !== undefined) set('public_only', patch.publicOnly);
  if (patch.visitorArea !== undefined) set('visitor_area', patch.visitorArea);
  if (patch.visitorOwner !== undefined) set('visitor_owner', patch.visitorOwner);
  for (const [a, v] of Object.entries(patch.can ?? {})) set(`can_${a as Ability}`, v);
  if (!sets.length) return;
  args.push(databaseId, table);
  await run(db, `UPDATE studio_resources SET ${sets.join(', ')} WHERE database_id = ? AND table_name = ?`, ...args);
}

export async function saveField(db: Db, databaseId: number, table: string, field: string, patch: FieldPatch): Promise<void> {
  await run(db,
    `INSERT INTO studio_fields (database_id, table_name, field_name) VALUES (?, ?, ?)
     ON CONFLICT (database_id, table_name, field_name) DO NOTHING`, databaseId, table, field);
  const sets: string[] = [];
  const args: Param[] = [];
  const set = (col: string, value: Param) => { sets.push(`${col} = ?`); args.push(value); };
  if (patch.exposed !== undefined) set('exposed', patch.exposed);
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.help !== undefined) set('help', patch.help);
  if (patch.control !== undefined) set('control', patch.control);
  if (patch.showInList !== undefined) set('show_in_list', patch.showInList);
  if (patch.searchable !== undefined) set('searchable', patch.searchable);
  if (patch.filterable !== undefined) set('filterable', patch.filterable);
  if (!sets.length) return;
  args.push(databaseId, table, field);
  await run(db, `UPDATE studio_fields SET ${sets.join(', ')} WHERE database_id = ? AND table_name = ? AND field_name = ?`, ...args);
}

// The order of the form (docs/field-order-plan.md O2, O8): the whole list at
// once, so two quick moves can never interleave into a third order.
export async function saveOrder(db: Db, databaseId: number, table: string, order: string[]): Promise<void> {
  await ensureResource(db, databaseId, table);
  await run(db, 'UPDATE studio_resources SET field_order = ? WHERE database_id = ? AND table_name = ?',
    JSON.stringify(order), databaseId, table);
}

// A name in every order that holds it, changed to another (O5): a field in its
// own table's order, a table's `many:` entry in the orders of the others.
async function renameInOrders(db: Db, databaseId: number, table: string | null, from: string, to: string): Promise<void> {
  const rows = await all<{ table_name: string; field_order: string }>(db,
    'SELECT table_name, field_order FROM studio_resources WHERE database_id = ?', databaseId);
  for (const r of rows) {
    if (table !== null && r.table_name !== table) continue;
    const order = readOrder(r.field_order);
    if (!order.includes(from)) continue;
    await run(db, 'UPDATE studio_resources SET field_order = ? WHERE database_id = ? AND table_name = ?',
      JSON.stringify(order.map((n) => (n === from ? to : n))), databaseId, r.table_name);
  }
}

// "Start this one again": forget what she said about a table and let inference
// speak for it. Its own operation because it is the honest way out of a
// definition she has tangled, and it loses nothing but opinions.
export async function forgetResource(db: Db, databaseId: number, table: string): Promise<void> {
  await run(db, 'DELETE FROM studio_fields WHERE database_id = ? AND table_name = ?', databaseId, table);
  await run(db, 'DELETE FROM studio_resources WHERE database_id = ? AND table_name = ?', databaseId, table);
}

// After an Apply: what she said about a table or a field follows it to its new
// name. Everything here is keyed by name, so without this a rename would read
// as a table gone and another one arrived -- and forgetMissing would throw her
// labels, ticks and the app switch for it away. Tables first, then fields,
// which are named under the table's NEW name (schema.ts renamesDone).
export type Renamed = {
  tables: { from: string; to: string }[];
  fields: { table: string; from: string; to: string }[];
};

export async function carryRenames(db: Db, databaseId: number, r: Renamed): Promise<void> {
  for (const t of r.tables) {
    await forgetResource(db, databaseId, t.to);
    await run(db, 'UPDATE studio_resources SET table_name = ? WHERE database_id = ? AND table_name = ?', t.to, databaseId, t.from);
    await run(db, 'UPDATE studio_fields SET table_name = ? WHERE database_id = ? AND table_name = ?', t.to, databaseId, t.from);
    await renameInOrders(db, databaseId, null, `many:${t.from}`, `many:${t.to}`);
  }
  for (const f of r.fields) {
    await run(db, 'DELETE FROM studio_fields WHERE database_id = ? AND table_name = ? AND field_name = ?', databaseId, f.table, f.to);
    await run(db, 'UPDATE studio_fields SET field_name = ? WHERE database_id = ? AND table_name = ? AND field_name = ?',
      f.to, databaseId, f.table, f.from);
    await run(db, 'UPDATE studio_resources SET title_field = ? WHERE database_id = ? AND table_name = ? AND title_field = ?',
      f.to, databaseId, f.table, f.from);
    await run(db, 'UPDATE studio_resources SET sort_field = ? WHERE database_id = ? AND table_name = ? AND sort_field = ?',
      f.to, databaseId, f.table, f.from);
    await renameInOrders(db, databaseId, f.table, f.from, f.to);
  }
}

// After an Apply: a table that is gone takes its definition with it. Called
// where the draft is rebased, so the panel never holds a Resource for
// something that is not there any more.
export async function forgetMissing(db: Db, databaseId: number, tables: string[]): Promise<number> {
  const keep = tables.length ? tables : [''];
  const marks = keep.map(() => '?').join(', ');
  const gone = await all<{ table_name: string }>(db,
    `SELECT table_name FROM studio_resources WHERE database_id = ? AND table_name NOT IN (${marks})`,
    databaseId, ...keep);
  for (const g of gone) await forgetResource(db, databaseId, g.table_name);
  await run(db, `DELETE FROM studio_fields WHERE database_id = ? AND table_name NOT IN (${marks})`, databaseId, ...keep);
  return gone.length;
}

export const countManaged = (db: Db, databaseId: number) =>
  one<{ n: number }>(db, 'SELECT count(*) AS n FROM studio_resources WHERE database_id = ? AND enabled', databaseId);
