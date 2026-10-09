// What she drew, minus what is there: the patch, and the same patch in her
// words (docs/databases-plan.md 8, docs/studio-plan.md "a patch is an ordered
// list, not a bag").
//
// Pure. It takes two snapshots and gives back steps -- no database, no socket,
// no clock -- which is what makes Review testable without an engine, and what
// lets the same function run on the draft as she types.
//
// The one thing it has to get right, and the reason it is not a three-line
// object comparison: **a rename is not a delete and an add.** The draft carries
// `was` on a table or a field she has renamed (src/pammydb/ir.ts), so this can
// tell "she called it something else" from "she threw it away and made another
// one" -- and every step except the renames themselves is written in terms of
// the name the ENGINE has right now, because the renames run last.
import { canAlter, typeLabel, defaultLabel, type Column, type ForeignKey, type Snapshot, type Table, type Unique } from '../pammydb/ir.ts';
import { destructive, ordered, type Step } from '../pammydb/patch.ts';

// The name a table or field has on the engine right now: what it was called, or
// what it is called if she has not renamed it.
const live = (x: { name: string; was?: string }) => x.was ?? x.name;

const byLiveName = <T extends { name: string; was?: string }>(xs: T[]) => new Map(xs.map((x) => [live(x), x]));

// Two constraints are the same one when they cover the same fields, whatever
// they are called: the panel names the ones it makes, and an engine names the
// ones she made in her own client, so comparing names would propose replacing
// every rule in an adopted database with an identical one.
const uniqueKey = (u: Unique, name: (c: string) => string) => [...u.columns].map(name).sort().join(',');
const fkKey = (f: ForeignKey, name: (c: string) => string) =>
  `${f.columns.map(name).join(',')}->${f.references.table}.${f.references.columns.join(',')}:${f.onDelete}`;

// What a relationship points at, by the name the engine has for it now. In the
// draft a relationship points at the table by its NEW name -- that is what she
// sees -- but the rename runs last, so until then the engine only knows the old
// one. Without this, renaming a table would read as every relationship to it
// thrown away and made again, pointing at a table that is not there yet.
type Pointing = (f: ForeignKey) => ForeignKey;
const pointingNow = (draft: Snapshot): Pointing => {
  const was = new Map(draft.tables.map((t) => [t.name, live(t)]));
  return (f) => ({ ...f, references: { ...f.references, table: was.get(f.references.table) ?? f.references.table } });
};

// Is this field different from the one on the engine? Only the parts a patch can
// carry: what it is, whether it is required, and what it starts out as. Its name
// is a rename, which is its own step.
function changed(draft: Column, current: Column): boolean {
  return draft.type !== current.type
    || (draft.length ?? null) !== (current.length ?? null)
    || (draft.precision ?? null) !== (current.precision ?? null)
    || (draft.scale ?? null) !== (current.scale ?? null)
    || draft.required !== current.required
    || defaultKey(draft) !== defaultKey(current);
}

const defaultKey = (c: Column): string => {
  const d = c.default;
  if (!d || d.kind === 'none') return 'none';
  return d.kind === 'now' ? 'now' : `${d.kind}:${'value' in d ? String(d.value) : d.sql}`;
};

export function diff(current: Snapshot, draft: Snapshot): Step[] {
  const steps: Step[] = [];
  const currentTables = new Map(current.tables.map((t) => [t.name, t]));
  const draftTables = byLiveName(draft.tables);
  const pointing = pointingNow(draft);

  // Gone: in the database, not in the draft. When two of the tables going are
  // connected -- a many-to-many and the table on one side of it -- the
  // connection between them goes first: the engine will not drop a table
  // something still points at, and tables go in name order, not in the order
  // that would happen to work.
  const going = new Set(current.tables.filter((t) => !draftTables.has(t.name)).map((t) => t.name));
  for (const t of current.tables) {
    if (!going.has(t.name)) continue;
    for (const f of t.foreignKeys) {
      if (f.references.table !== t.name && going.has(f.references.table)) {
        steps.push({ kind: 'drop-foreign-key', table: t.name, foreignKey: f.name });
      }
    }
    steps.push({ kind: 'drop-table', table: t.name });
  }

  for (const t of draft.tables) {
    const before = currentTables.get(live(t));
    if (!before) {
      // New. Its relationships are their own steps, always, so two new tables
      // that point at each other can both be made first (src/pammydb/patch.ts).
      steps.push({ kind: 'create-table', table: { ...t, was: undefined, foreignKeys: [] } });
      for (const f of t.foreignKeys) steps.push({ kind: 'add-foreign-key', table: t.name, foreignKey: pointing(f) });
      continue;
    }
    steps.push(...tableSteps(before, t, pointing));
  }
  return ordered(steps);
}

function tableSteps(current: Table, draft: Table, pointing: Pointing): Step[] {
  const steps: Step[] = [];
  const table = current.name;                       // what the engine calls it now
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  const draftColumns = byLiveName(draft.columns);
  // A field that is being renamed is still called its old name for every step
  // except the rename, because the rename is last.
  const nameNow = (field: string) => {
    const c = draft.columns.find((x) => x.name === field);
    return c ? live(c) : field;
  };

  for (const c of current.columns) {
    if (!draftColumns.has(c.name)) steps.push({ kind: 'drop-column', table, column: c.name });
  }

  for (const c of draft.columns) {
    const before = currentColumns.get(live(c));
    if (!before) {
      steps.push({ kind: 'add-column', table, column: { ...c, was: undefined } });
      continue;
    }
    // A field the panel cannot describe is left exactly as it is: the page does
    // not offer to change it, and if something else proposes one anyway, this is
    // where it stops.
    if (changed(c, before) && canAlter(c) && canAlter(before)) {
      steps.push({ kind: 'alter-column', table, column: { ...c, name: before.name, was: undefined }, from: before });
    }
    if (c.was && c.was !== c.name) steps.push({ kind: 'rename-column', table, column: c.was, to: c.name });
  }

  // Must-be-different rules, matched by the fields they cover.
  const currentUniques = new Map(current.uniques.map((u) => [uniqueKey(u, (x) => x), u]));
  const draftUniques = new Map(draft.uniques.map((u) => [uniqueKey(u, nameNow), u]));
  for (const [key, u] of currentUniques) {
    if (!draftUniques.has(key)) steps.push({ kind: 'drop-unique', table, unique: u.name });
  }
  for (const [key, u] of draftUniques) {
    if (!currentUniques.has(key)) {
      steps.push({ kind: 'add-unique', table, unique: { name: u.name, columns: u.columns.map(nameNow) } });
    }
  }

  // Relationships: slice 4 does not draw them, but an adopted database is full
  // of them and a patch has to be able to carry one (slice 6 draws them).
  const currentKeys = new Map(current.foreignKeys.map((f) => [fkKey(f, (x) => x), f]));
  const draftKeys = new Map(draft.foreignKeys.map((f) => [fkKey(pointing(f), nameNow), pointing(f)]));
  for (const [key, f] of currentKeys) {
    if (!draftKeys.has(key)) steps.push({ kind: 'drop-foreign-key', table, foreignKey: f.name });
  }
  for (const [key, f] of draftKeys) {
    if (!currentKeys.has(key)) {
      steps.push({
        kind: 'add-foreign-key',
        table,
        foreignKey: { ...f, columns: f.columns.map(nameNow) },
      });
    }
  }

  if (draft.was && draft.was !== draft.name) steps.push({ kind: 'rename-table', table: draft.was, to: draft.name });
  return steps;
}

// ------------------------------------------------------------------ in her words

export type Change = {
  table: string;
  line: string;
  // what it costs, said plainly, or null when it costs nothing
  warning: string | null;
  destructive: boolean;
  step: Step;
};

// One sentence per step, naming the table and the field, never the SQL. Review
// shows these; the statements are under Advanced, and they come from the helper.
export function describe(step: Step): Change {
  const d = destructive(step);
  const change = (table: string, line: string, warning: string | null = null): Change =>
    ({ table, line, warning, destructive: d, step });

  switch (step.kind) {
    case 'create-table':
      return change(step.table.name,
        `New table ${step.table.name}, with ${step.table.columns.length} field${step.table.columns.length === 1 ? '' : 's'}`);

    case 'drop-table':
      return change(step.table, `Remove the table ${step.table}`,
        `Every row in ${step.table} is deleted with it, and that cannot be undone here.`);

    case 'rename-table':
      return change(step.table, `Rename the table ${step.table} to ${step.to}`,
        'Anything that already asks for this table by name will stop working until it is changed too.');

    case 'add-column':
      return change(step.table, `Add ${step.table}.${step.column.name} (${typeLabel(step.column)})`,
        step.column.required && !step.column.default
          ? `${step.column.name} has to be filled in, so this only works while ${step.table} is still empty.`
          : null);

    case 'drop-column':
      return change(step.table, `Remove ${step.table}.${step.column}`,
        `Whatever is in ${step.column} is deleted with it, and that cannot be undone here.`);

    case 'rename-column':
      return change(step.table, `Rename ${step.table}.${step.column} to ${step.to}`,
        'Anything that already asks for this field by name will stop working until it is changed too.');

    case 'alter-column': {
      const parts: string[] = [];
      if (typeLabel(step.column) !== typeLabel(step.from)) parts.push(`from ${typeLabel(step.from)} to ${typeLabel(step.column)}`);
      if (step.column.required !== step.from.required) parts.push(step.column.required ? 'and make it required' : 'and make it optional');
      const now = defaultLabel(step.column.default);
      const before = defaultLabel(step.from.default);
      if (now !== before) parts.push(now ? `and start it out as ${now}` : 'and give it no starting value');
      return change(step.table, `Change ${step.table}.${step.column.name} ${parts.join(' ')}`.trim(),
        !d ? null
          : step.column.required && !step.from.required
            ? `Rows where ${step.column.name} is empty will stop this, so fill them in first.`
            : `What is already in ${step.column.name} has to fit the new kind of field, or the database will refuse this.`);
    }

    case 'add-unique':
      return change(step.table, `${step.table}: ${step.unique.columns.join(' and ')} must be different in every row`,
        `Rows that already share a ${step.unique.columns.join(' and ')} will stop this.`);

    case 'drop-unique':
      return change(step.table, `${step.table}: ${step.unique} no longer has to be different in every row`);

    case 'add-foreign-key':
      return change(step.table,
        `${step.table}.${step.foreignKey.columns.join(', ')} points at ${step.foreignKey.references.table}`,
        `Rows pointing at a ${step.foreignKey.references.table} that is not there will stop this.`);

    case 'drop-foreign-key':
      return change(step.table, `${step.table}: ${step.foreignKey} no longer has to point at anything`);
  }
}

export type Plan = {
  steps: Step[];
  changes: Change[];
  destructive: boolean;
};

export function plan(current: Snapshot, draft: Snapshot): Plan {
  const steps = diff(current, draft);
  return { steps, changes: steps.map(describe), destructive: steps.some(destructive) };
}
