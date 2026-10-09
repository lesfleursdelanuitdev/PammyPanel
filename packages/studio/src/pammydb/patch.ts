// A patch: the ordered list of steps between the schema she has and the schema
// she drew (docs/studio-plan.md, "a patch is an ordered list, not a bag").
//
// The panel works out what the steps are (src/studio/diff.ts, which knows what
// she meant); this file says what a step may be, what order they run in, and
// checks every one again on the helper's side. The helper never receives SQL and
// never receives a step it has not read field by field.
import type { Column, ForeignKey, Table, Unique } from './ir.ts';
import { checkColumn, checkTable } from './ir.ts';
import { NAME_RE, PammyDbError } from './ident.ts';

export type Step =
  | { kind: 'create-table'; table: Table }
  | { kind: 'drop-table'; table: string }
  | { kind: 'rename-table'; table: string; to: string }
  | { kind: 'add-column'; table: string; column: Column }
  | { kind: 'drop-column'; table: string; column: string }
  | { kind: 'rename-column'; table: string; column: string; to: string }
  | { kind: 'alter-column'; table: string; column: Column; from: Column }
  | { kind: 'add-unique'; table: string; unique: Unique }
  | { kind: 'drop-unique'; table: string; unique: string }
  | { kind: 'add-foreign-key'; table: string; foreignKey: ForeignKey }
  | { kind: 'drop-foreign-key'; table: string; foreignKey: string };

export type StepKind = Step['kind'];

// Dependency order, not the order she clicked (docs/studio-plan.md). Anything
// that would block a later step comes off first; anything that depends on
// something new goes on last.
//
// Renames are last of all, and that is what makes the rest of the list
// readable: every other step names the table and field the ENGINE has right
// now, so nothing in the middle of an Apply has to know whether a rename has
// happened yet. It is also what lets Review say `title -> headline` instead of
// "removed title, added headline".
const ORDER: StepKind[] = [
  'drop-foreign-key',
  'drop-unique',
  'drop-column',
  'drop-table',
  'create-table',
  'add-column',
  'alter-column',
  'add-unique',
  'add-foreign-key',
  'rename-column',
  'rename-table',
];

export const stepOrder = (kind: StepKind): number => ORDER.indexOf(kind);

// Stable: two steps of the same kind keep the order the panel put them in, so a
// patch reads the way the page read.
export function ordered(steps: Step[]): Step[] {
  return steps
    .map((step, at) => ({ step, at }))
    .sort((a, b) => stepOrder(a.step.kind) - stepOrder(b.step.kind) || a.at - b.at)
    .map((s) => s.step);
}

// The steps that can lose something she cannot get back. Review marks these,
// and the panel asks for a passkey tap before an Apply that contains one
// (docs/databases-plan.md 8).
export function destructive(step: Step): boolean {
  switch (step.kind) {
    case 'drop-table':
    case 'drop-column':
      return true;
    // Narrowing a field can refuse to convert, or round, or cut. Widening is
    // safe, but telling the two apart per engine is guesswork, so any change of
    // what a field IS counts -- a required tick or a starting value does not.
    case 'alter-column':
      return step.column.type !== step.from.type
        || (step.column.length ?? null) !== (step.from.length ?? null)
        || (step.column.precision ?? null) !== (step.from.precision ?? null)
        || (step.column.scale ?? null) !== (step.from.scale ?? null)
        // making a field required can fail outright on rows that have nothing
        // in it, which is not data loss but is a refusal she should expect
        || (step.column.required && !step.from.required);
    default:
      return false;
  }
}

// ------------------------------------------------------------------ the helper's own check

const bad = (message: string) => new PammyDbError('invalid', message);

const ident = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !NAME_RE.test(v)) {
    throw bad(`That ${what} name has characters the database will not take.`);
  }
  return v;
};

// Everything the panel sends, read again here. A step that does not parse stops
// the whole patch before a single statement runs: half a patch is the one thing
// MariaDB cannot undo.
export function checkStep(v: unknown): Step {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('The panel sent a change the helper cannot read.');
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'create-table': {
      const table = checkTable(o.table);
      // Relationships are their own steps, always. Two new tables that point at
      // each other cannot both be made with their foreign keys inline, so the
      // order (tables, then keys) is the rule rather than a special case -- and
      // it keeps one step meaning one statement.
      if (table.foreignKeys.length > 0) {
        throw bad('Relationships are added after the tables they join, so they are separate steps.');
      }
      return { kind: 'create-table', table };
    }
    case 'drop-table':
      return { kind: 'drop-table', table: ident(o.table, 'table') };
    case 'rename-table':
      return { kind: 'rename-table', table: ident(o.table, 'table'), to: ident(o.to, 'table') };
    case 'add-column':
      return { kind: 'add-column', table: ident(o.table, 'table'), column: checkColumn(o.column, ident(o.table, 'table')) };
    case 'drop-column':
      return { kind: 'drop-column', table: ident(o.table, 'table'), column: ident(o.column, 'field') };
    case 'rename-column':
      return {
        kind: 'rename-column',
        table: ident(o.table, 'table'),
        column: ident(o.column, 'field'),
        to: ident(o.to, 'field'),
      };
    case 'alter-column': {
      const table = ident(o.table, 'table');
      const column = checkColumn(o.column, table);
      const from = checkColumn(o.from, table);
      if (column.name !== from.name) throw bad('A change to a field has to be about one field.');
      // Identity is the engine filling a number in, and turning that on or off
      // on a column with rows in it is not one statement on either engine. It
      // is set when the table is made and left alone after (S16).
      if ((column.identity ?? false) !== (from.identity ?? false)) {
        throw bad('Whether a field fills itself in is settled when the table is made. Make a new field instead.');
      }
      return { kind: 'alter-column', table, column, from };
    }
    case 'add-unique': {
      const table = ident(o.table, 'table');
      const u = (o.unique ?? {}) as Record<string, unknown>;
      const columns = Array.isArray(u.columns) ? u.columns.map((c) => ident(c, 'field')) : [];
      if (columns.length === 0) throw bad('A must-be-different rule has to name a field.');
      return { kind: 'add-unique', table, unique: { name: ident(u.name, 'rule'), columns } };
    }
    case 'drop-unique':
      return { kind: 'drop-unique', table: ident(o.table, 'table'), unique: ident(o.unique, 'rule') };
    case 'add-foreign-key': {
      const table = ident(o.table, 'table');
      const f = (o.foreignKey ?? {}) as Record<string, unknown>;
      const ref = (f.references ?? {}) as Record<string, unknown>;
      const columns = Array.isArray(f.columns) ? f.columns.map((c) => ident(c, 'field')) : [];
      const refColumns = Array.isArray(ref.columns) ? ref.columns.map((c) => ident(c, 'field')) : [];
      if (columns.length === 0 || columns.length !== refColumns.length) {
        throw bad('A relationship has to join the same number of fields on both sides.');
      }
      const onDelete = f.onDelete === 'cascade' || f.onDelete === 'set null' ? f.onDelete : 'restrict';
      return {
        kind: 'add-foreign-key',
        table,
        foreignKey: {
          name: ident(f.name, 'relationship'),
          columns,
          references: { table: ident(ref.table, 'table'), columns: refColumns },
          onDelete,
        },
      };
    }
    case 'drop-foreign-key':
      return { kind: 'drop-foreign-key', table: ident(o.table, 'table'), foreignKey: ident(o.foreignKey, 'relationship') };
    default:
      throw bad('The panel sent a kind of change the helper does not know.');
  }
}

// A patch is bounded: 200 steps is far more than a page of changes, and the
// limit is here rather than in the socket so the refusal is in her words rather
// than "Request too large".
export const MAX_STEPS = 200;

export function checkPatch(v: unknown): Step[] {
  if (!Array.isArray(v)) throw bad('The panel sent a list of changes the helper cannot read.');
  if (v.length === 0) throw bad('There is nothing to apply.');
  if (v.length > MAX_STEPS) throw bad(`That is more changes than the panel will apply at once (${MAX_STEPS}). Apply some of them first.`);
  return ordered(v.map(checkStep));
}

// Which table a step is about, for the per-table grouping on Review and for the
// log line.
export const stepTable = (step: Step): string =>
  step.kind === 'create-table' ? step.table.name : step.table;
