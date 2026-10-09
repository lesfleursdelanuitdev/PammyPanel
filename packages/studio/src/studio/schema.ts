// The panel's side of designing a table: the draft it keeps, and what it makes
// of the difference between that draft and the database
// (docs/databases-plan.md 8, 10, 15).
//
// The division of labour is the same as everywhere else in the studio. The
// engine is the truth and only the helper speaks to it. This file holds what she
// has drawn and not applied yet, works out what that would mean, and never
// composes a statement.
import { AccountError } from '@panel/core/accounts';
import { one, run, type Db } from '@panel/core/pg';
import { checkSnapshot, snapshotHash, type Snapshot } from '../pammydb/ir.ts';
import type { Engine } from '../pammydb/ident.ts';
import { plan, type Plan } from './diff.ts';
import type { Step } from '../pammydb/patch.ts';
import type { Renamed } from './resource-store.ts';

export type DraftRow = {
  database_id: number;
  draft_json: string;
  based_on: string;
  updated_at: number;
  updated_by: string;
};

export const getDraftRow = (db: Db, databaseId: number) =>
  one<DraftRow>(db, 'SELECT * FROM studio_drafts WHERE database_id = ?', databaseId);

// Last write wins, with a stamp saying who (docs/databases-plan.md 15). The
// draft is one document, so saving it is one row.
export async function saveDraft(db: Db, o: {
  databaseId: number; draft: Snapshot; basedOn: string; at: number; by: string;
}): Promise<void> {
  await run(db,
    `INSERT INTO studio_drafts (database_id, draft_json, based_on, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (database_id) DO UPDATE
        SET draft_json = EXCLUDED.draft_json, based_on = EXCLUDED.based_on,
            updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    o.databaseId, JSON.stringify(o.draft), o.basedOn, o.at, o.by);
}

// Throw the drawing away and start again from the database. Positions and
// resource ticks are not here and so are not touched (plan 8, Discard).
export const discardDraft = (db: Db, databaseId: number) =>
  run(db, 'DELETE FROM studio_drafts WHERE database_id = ?', databaseId);

// ------------------------------------------------------------------ what the page shows

export type SchemaView = {
  engine: Engine;
  database: string;
  // what the engine has right now
  current: Snapshot;
  currentHash: string;
  // what she has drawn. Equal to `current` when there is no draft, so the page
  // has one thing to render either way.
  draft: Snapshot;
  hasDraft: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  // the draft's changes, in her words
  plan: Plan;
  // The database moved since the draft was started. Not an error and not
  // something to fix silently: she is told, and chooses (plan 8).
  drift: boolean;
  notes: string[];
};

// A draft written by an older version of the panel, or by a browser that has
// been open a long time, must not take a page down. It is read the same way
// anything from outside is read, and a draft that no longer parses is treated
// as no draft at all rather than as a crash.
export function readDraft(row: DraftRow | undefined, engine: Engine, database: string): Snapshot | null {
  if (!row) return null;
  try {
    return checkSnapshot(JSON.parse(row.draft_json), engine, database);
  } catch {
    return null;
  }
}

export function schemaView(o: {
  engine: Engine; database: string; current: Snapshot; currentHash: string; row: DraftRow | undefined;
}): SchemaView {
  const draft = readDraft(o.row, o.engine, o.database);
  return {
    engine: o.engine,
    database: o.database,
    current: o.current,
    currentHash: o.currentHash,
    draft: draft ?? o.current,
    hasDraft: !!draft,
    updatedAt: draft ? o.row!.updated_at : null,
    updatedBy: draft ? o.row!.updated_by : null,
    plan: plan(o.current, draft ?? o.current),
    // Only a draft can drift. Without one there is nothing that was built on an
    // older reading of the database.
    drift: !!draft && o.row!.based_on !== o.currentHash,
    notes: o.current.notes,
  };
}

// The draft as it arrives from the browser: read against the IR, and then
// checked against the database it claims to be about, so a draft for one
// database can never be saved over another.
export function checkDraft(body: unknown, engine: Engine, database: string): { draft: Snapshot; basedOn: string } {
  const o = (body ?? {}) as Record<string, unknown>;
  const draft = checkSnapshot(o.draft, engine, database);
  const basedOn = typeof o.basedOn === 'string' ? o.basedOn : '';
  if (!/^[0-9a-f]{32}$/.test(basedOn)) {
    throw new AccountError('The panel could not tell which version of this database you were working from. Open the page again.', 400);
  }
  return { draft, basedOn };
}

// A rename that has already happened is not still waiting.
//
// The draft carries `was` on anything she has renamed, and the diff reads it as
// "this field is called something else on the engine". Once the rename has run,
// that is no longer true -- and leaving the marker there would make the very
// next diff read the field as one dropped and another added, which is the one
// misreading the marker exists to prevent. So after an Apply, a `was` whose new
// name the engine now has is cleared.
//
// Checked against the engine rather than against the list of steps that ran,
// because that is the question being asked: has this rename happened? On
// MariaDB, where a patch can stop half way, some will have and some will not.
export function rebaseDraft(draft: Snapshot, after: Snapshot): Snapshot {
  const tables = draft.tables.map((t) => {
    const renamedAlready = !!t.was && after.tables.some((x) => x.name === t.name);
    const table = renamedAlready ? { ...t, was: undefined } : t;
    const live = after.tables.find((x) => x.name === (table.was ?? table.name));
    return {
      ...table,
      columns: table.columns.map((c) =>
        (c.was && live?.columns.some((x) => x.name === c.name) ? { ...c, was: undefined } : c)),
    };
  });
  return { ...draft, tables };
}

// Which of the patch's renames the engine has now, so what she said about
// those tables and fields can follow them (resource-store.ts carryRenames).
// Asked of the engine for the same reason as rebaseDraft: on MariaDB a patch
// can stop half way. A field's table is named as it is AFTER the Apply, because
// that is the name her field settings end up under.
export function renamesDone(steps: Step[], after: Snapshot): Renamed {
  const has = (t: string) => after.tables.find((x) => x.name === t);
  const tables = steps.flatMap((s) =>
    (s.kind === 'rename-table' && has(s.to) && !has(s.table) ? [{ from: s.table, to: s.to }] : []));
  const nowCalled = (t: string) => tables.find((x) => x.from === t)?.to ?? t;
  const fields = steps.flatMap((s) => {
    if (s.kind !== 'rename-column') return [];
    const t = has(nowCalled(s.table));
    return t && t.columns.some((c) => c.name === s.to) && !t.columns.some((c) => c.name === s.column)
      ? [{ table: t.name, from: s.column, to: s.to }]
      : [];
  });
  return { tables, fields };
}

// After an Apply the draft is whatever is still outstanding. On Postgres that is
// nothing -- the patch went in one transaction or not at all. On MariaDB some of
// it may have landed, so the draft becomes "the new live schema, with what she
// still wants on top of it", which is exactly the draft she had, re-based. We
// never tell her a rollback happened (docs/studio-plan.md).
export const stillToDo = (after: Snapshot, draft: Snapshot): Plan => plan(after, draft);

export { snapshotHash };
