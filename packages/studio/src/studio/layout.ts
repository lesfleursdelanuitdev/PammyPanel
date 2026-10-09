// Where she put the rectangles (docs/databases-plan.md 6, "Workspace, not a
// static picture"; docs/studio-plan.md "draft is one JSON document").
//
// This is the only part of the studio that is purely about how the drawing
// looks. Nothing here is ever applied to a database and nothing here is read by
// the diff, which is why it sits beside the draft rather than inside it: a
// Discard means "go back to what the database really has", and where she
// dragged `orders` to is not one of her changes to throw away.
//
// Positions are keyed by table NAME, not by anything from the engine, because a
// table she has drawn and not applied yet has nothing else to be keyed by.
import { one, run, type Db } from '@panel/core/pg';
import { NAME_RE } from '../pammydb/ident.ts';
import type { Snapshot } from '../pammydb/ir.ts';

export type Spot = { x: number; y: number };

// How a many-to-many is drawn (docs/databases-plan.md 7, "two visual modes",
// remembered per database). `simple` hides the connecting table and draws one
// line between the two outer tables; `expanded` shows the real three
// rectangles. Hiding the junction never deletes it -- both modes are the same
// drawing, and this is only how it is looked at.
export const VIEWS = ['simple', 'expanded'] as const;
export type View = (typeof VIEWS)[number];
export const isView = (v: unknown): v is View => VIEWS.includes(v as View);

// Everything about how the drawing LOOKS, as one document. 0007's comment
// describes the shape at the time it was written (positions only); the document
// has since grown the many-to-many mode, which is the same kind of thing --
// never applied, never read by the diff, and safe to lose.
export type Layout = { tables: Record<string, Spot>; manyToMany: View };

export type LayoutRow = {
  database_id: number;
  layout_json: string;
  updated_at: number;
  updated_by: string;
};

export const emptyLayout = (): Layout => ({ tables: {}, manyToMany: 'simple' });

// How far apart auto-layout puts them, and how wide a row of tables gets before
// it wraps. Plain numbers rather than anything measured: the canvas can always
// be dragged, and "fit to screen" is one press away. A rectangle is 256 wide,
// so this leaves room between two for a line to be seen, with its ends.
export const SPOT_X = 400;
export const SPOT_Y = 260;
export const PER_ROW = 4;
// Enough to stop one runaway drag putting a table somewhere she can never find
// it again, while still being far larger than any real drawing.
const FAR = 100_000;

export const getLayoutRow = (db: Db, databaseId: number) =>
  one<LayoutRow>(db, 'SELECT * FROM studio_layouts WHERE database_id = ?', databaseId);

export async function saveLayout(db: Db, o: {
  databaseId: number; layout: Layout; at: number; by: string;
}): Promise<void> {
  await run(db,
    `INSERT INTO studio_layouts (database_id, layout_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (database_id) DO UPDATE
        SET layout_json = EXCLUDED.layout_json,
            updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    o.databaseId, JSON.stringify(o.layout), o.at, o.by);
}

// A layout written by an older panel, or by a browser left open a long time,
// must not take the page down -- the same rule readDraft follows. Anything that
// does not read as a position is dropped, and a layout that does not parse at
// all is treated as no layout, which auto-layout then fills in.
export function readLayout(row: LayoutRow | undefined): Layout {
  if (!row) return emptyLayout();
  try {
    return checkLayout(JSON.parse(row.layout_json));
  } catch {
    return emptyLayout();
  }
}

const spot = (v: unknown): Spot | null => {
  const o = (v ?? {}) as Record<string, unknown>;
  const x = Number(o.x);
  const y = Number(o.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // rounded: a position is a place on a grid, not a measurement, and whole
  // numbers keep the stored document from churning on every sub-pixel drag
  return { x: clamp(Math.round(x)), y: clamp(Math.round(y)) };
};
const clamp = (n: number) => Math.max(-FAR, Math.min(FAR, n));

// Read the way everything from the browser is read: field by field, keeping
// only what makes sense. A name that no database would take cannot be a key
// here either -- not because it is dangerous (nothing here reaches SQL) but
// because it could only have come from something other than a table.
export function checkLayout(v: unknown): Layout {
  const o = (v ?? {}) as Record<string, unknown>;
  const manyToMany = isView(o.manyToMany) ? o.manyToMany : 'simple';
  const src = (o.tables ?? {}) as Record<string, unknown>;
  if (typeof src !== 'object' || Array.isArray(src)) return { ...emptyLayout(), manyToMany };
  const tables: Record<string, Spot> = {};
  for (const [name, value] of Object.entries(src)) {
    if (!NAME_RE.test(name)) continue;
    const s = spot(value);
    if (s) tables[name] = s;
  }
  return { tables, manyToMany };
}

// What the canvas draws: every table in the drawing, each with somewhere to be.
//
// A table she has just added has no position yet, and neither does anything at
// all on a first visit. Rather than piling them on top of each other at the
// origin, the ones without a spot are laid out in reading order after the ones
// that have one -- so opening a database the panel has never drawn gives a tidy
// grid, and adding a table puts it somewhere she can see instead of underneath
// another one.
export function placed(snapshot: Snapshot, layout: Layout): Layout {
  const tables: Record<string, Spot> = {};
  const missing: string[] = [];
  for (const t of snapshot.tables) {
    const at = layout.tables[t.name];
    if (at) tables[t.name] = at;
    else missing.push(t.name);
  }
  // start the new ones on the row below everything already placed, so an added
  // table never lands on top of one she has arranged
  const used = Object.values(tables);
  const startRow = used.length ? Math.floor(Math.max(...used.map((s) => s.y)) / SPOT_Y) + 1 : 0;
  missing.forEach((name, i) => {
    tables[name] = { x: (i % PER_ROW) * SPOT_X, y: (startRow + Math.floor(i / PER_ROW)) * SPOT_Y };
  });
  return { tables, manyToMany: layout.manyToMany };
}

// "Tidy up": forget where everything is and lay the whole drawing out again in
// reading order. Separate from `placed` because this one is something she asks
// for, and it moves tables she had put somewhere on purpose.
export const tidy = (snapshot: Snapshot, view: View = 'simple'): Layout =>
  placed(snapshot, { ...emptyLayout(), manyToMany: view });

// A table she renamed keeps its place, and one that is gone stops taking up
// room in the stored document. Called on save rather than on read so the row
// does not quietly grow a position for every table she ever deleted.
export function forget(layout: Layout, snapshot: Snapshot): Layout {
  const live = new Set(snapshot.tables.map((t) => t.name));
  const tables: Record<string, Spot> = {};
  for (const [name, at] of Object.entries(layout.tables)) if (live.has(name)) tables[name] = at;
  return { tables, manyToMany: layout.manyToMany };
}

// A table she renamed keeps its place. The drawing and the positions are saved
// separately, and positions are keyed by name, so the draft save that renames a
// table moves its position in the same breath -- otherwise it would be placed
// afresh, somewhere else, the moment she renamed it. The page says where it was
// drawn, because a table she never dragged has no stored spot: it was placed.
// Only when the drawing really has the new name and not the old one.
export function renamedIn(layout: Layout, snapshot: Snapshot, from: string, to: string, at: unknown): Layout | null {
  const s = spot(at);
  const names = new Set(snapshot.tables.map((t) => t.name));
  if (!s || !NAME_RE.test(to) || !names.has(to) || names.has(from)) return null;
  const { [from]: _, ...rest } = layout.tables;
  return { ...layout, tables: { ...rest, [to]: s } };
}
