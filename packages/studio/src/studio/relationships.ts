// Relationships, in her words (docs/databases-plan.md 7).
//
// She connects **fields**, not rectangles: `users.id` to `posts.user_id`. The
// storage for that has existed since slice 4 -- the IR has had `ForeignKey`
// with its `onDelete` all along, and the dialect printers already write it.
// What is here is the product layer above it: what kinds of relationship there
// are in her words, whether a pair she has picked makes sense, what a
// many-to-many needs built for it, and how to read an existing schema back as
// relationships rather than as constraints.
//
// It lives on the server rather than in the page, unlike the simpler draft
// edits the Tables list makes. Building a many-to-many means inventing a table,
// and that is not a thing to write twice and hope the two copies agree.
//
// Pure: no database, no socket, no clock.
import { AccountError } from '@panel/core/accounts';
import { NAME_RE } from '../pammydb/ident.ts';
import type { Column, ForeignKey, Snapshot, Table } from '../pammydb/ir.ts';

export const KINDS = ['one-to-one', 'one-to-many', 'many-to-many'] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (v: unknown): v is Kind => KINDS.includes(v as Kind);

export const ON_DELETE = ['restrict', 'cascade', 'set null'] as const;
export type OnDelete = (typeof ON_DELETE)[number];
export const isOnDelete = (v: unknown): v is OnDelete => ON_DELETE.includes(v as OnDelete);

// Her words for what each choice does when the row on the "one" side goes.
// Deliberately about her rows, not about the constraint.
export const ON_DELETE_NAMES: Record<OnDelete, string> = {
  restrict: 'Prevent deletion',
  cascade: 'Delete the related rows too',
  'set null': 'Keep them, but remove the connection',
};

// ------------------------------------------------------------------ reading a schema back

const col = (t: Table, name: string): Column | undefined => t.columns.find((c) => c.name === name);

const isUnique = (t: Table, columns: string[]) =>
  (t.primaryKey.length === columns.length && columns.every((c) => t.primaryKey.includes(c)))
  || t.uniques.some((u) => u.columns.length === columns.length && columns.every((c) => u.columns.includes(c)));

// A connecting table, in the shape the panel makes and the shape it recognises
// in a database it did not make (docs/studio-plan.md, inference): a composite
// primary key of exactly two foreign keys, and nothing else of substance.
//
// "Little else" is the part worth being careful about. A junction with its own
// `added_at` is still a junction; one with a price and a quantity is an order
// line, and calling that a hidden connection would lose her a table. So: the
// two key columns, and at most a couple of plain extras, none of them required.
export function isJunction(t: Table): boolean {
  if (t.primaryKey.length !== 2) return false;
  if (t.foreignKeys.length !== 2) return false;
  const keyed = t.foreignKeys.flatMap((f) => f.columns);
  if (keyed.length !== 2 || !t.primaryKey.every((c) => keyed.includes(c))) return false;
  const extras = t.columns.filter((c) => !t.primaryKey.includes(c.name));
  return extras.length <= 2 && extras.every((c) => !c.required);
}

export type Relationship = {
  kind: Kind;
  // the table she would say the relationship is "from": the one holding the
  // reference for a plain relationship, and the left-hand one for a M:N
  from: string;
  fromColumns: string[];
  to: string;
  toColumns: string[];
  onDelete: OnDelete;
  // how to find it again in the draft: the table carrying the constraint, and
  // its name. For a many-to-many, the junction table and both its constraints.
  at: { table: string; foreignKey: string }[];
  // the connecting table, when there is one. Named so the canvas can hide it.
  junction: string | null;
  line: string;
};

// `users` -> `user`, for her words and for a reference field's name. Only the
// obvious case: guessing English plurals wrongly is worse than leaving a name
// she can read, so anything that does not end in -s is left exactly as it is.
export function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
  // Words that end in -s and are already singular. Without these, `status`
  // becomes `statu` and she is told "One statu has many orders", which is the
  // exact failure the rest of this function is written to avoid.
  if (/(?:ss|us|is)$/.test(name)) return name;
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

// Every relationship in a drawing, as she would describe it. A many-to-many is
// ONE relationship between the two outer tables, not two references into a
// table she never asked for.
export function relationships(s: Snapshot): Relationship[] {
  const out: Relationship[] = [];
  const junctions = new Set(s.tables.filter(isJunction).map((t) => t.name));
  for (const t of s.tables) {
    if (junctions.has(t.name)) {
      // in the order of the connecting table's fields, which is the order she
      // named them in: an engine lists constraints by name, and that would
      // turn "recipes have many labels" round once it had been applied
      const at = (f: ForeignKey) => t.columns.findIndex((c) => c.name === f.columns[0]);
      const [a, b] = [...t.foreignKeys].sort((x, y) => at(x) - at(y)) as [ForeignKey, ForeignKey];
      out.push({
        kind: 'many-to-many',
        from: a.references.table, fromColumns: a.references.columns,
        to: b.references.table, toColumns: b.references.columns,
        // the connecting table is what carries the rule, and both halves of it
        onDelete: a.onDelete,
        at: [{ table: t.name, foreignKey: a.name }, { table: t.name, foreignKey: b.name }],
        junction: t.name,
        line: `Many ${a.references.table} have many ${b.references.table}`,
      });
      continue;
    }
    for (const f of t.foreignKeys) {
      const kind: Kind = isUnique(t, f.columns) ? 'one-to-one' : 'one-to-many';
      out.push({
        kind,
        from: f.references.table, fromColumns: f.references.columns,
        to: t.name, toColumns: f.columns,
        onDelete: f.onDelete,
        at: [{ table: t.name, foreignKey: f.name }],
        junction: null,
        line: kind === 'one-to-one'
          ? `One ${singular(f.references.table)} has one ${singular(t.name)}`
          : `One ${singular(f.references.table)} has many ${t.name}`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ making one

export type Spec = {
  // the "one" side: what is being pointed AT
  from: { table: string; column: string };
  // the "many" side: what holds the reference. For a many-to-many, just the
  // other table -- the column is worked out, because the junction is new.
  to: { table: string; column?: string };
  kind: Kind;
  onDelete: OnDelete;
  // for a many-to-many she may rename the connecting table before it is made
  junction?: string;
};

const table = (s: Snapshot, name: string): Table => {
  const t = s.tables.find((x) => x.name === name);
  if (!t) throw new AccountError(`There is no table called ${name} in your drawing.`, 400);
  return t;
};

// Two fields can be connected when a value of one could really sit in the
// other. Checked here, in her words, before anything reaches the draft -- the
// helper would refuse a mismatch too, but only after she pressed Apply, and by
// then she has lost the thread.
export function typesFit(a: Column, b: Column): boolean {
  if (a.type === 'other' || b.type === 'other') return a.sqlType === b.sqlType && !!a.sqlType;
  // an id that fills itself in is an integer as far as the other side goes
  if (a.type !== b.type) return false;
  if (a.type === 'short_text') return (a.length ?? 255) === (b.length ?? 255);
  return true;
}

// The column a new reference gets: `users.id` seen from `posts` is `user_id`.
// Singular only in the obvious case, because guessing English plurals wrongly
// is worse than a name she can edit.
export function referenceName(toTable: string, toColumn: string): string {
  return `${singular(toTable)}_${toColumn}`;
}

// `users` + `groups` -> `user_groups`, the name the plan writes out.
export function junctionName(a: string, b: string): string {
  return `${singular(a)}_${b}`;
}

const constraintName = (t: string, columns: string[]) => `${t}_${columns.join('_')}_fkey`;

const free = (s: Snapshot, base: string): string => {
  if (!s.tables.some((t) => t.name === base)) return base;
  for (let i = 2; i < 100; i++) if (!s.tables.some((t) => t.name === `${base}_${i}`)) return `${base}_${i}`;
  throw new AccountError('The panel could not find a free name for the connecting table.', 400);
};

// What a relationship would do to the drawing, with everything checked first.
// Returns the new snapshot; never touches a database.
export function addRelationship(s: Snapshot, spec: Spec): Snapshot {
  const fromTable = table(s, spec.from.table);
  const fromColumn = col(fromTable, spec.from.column);
  if (!fromColumn) throw new AccountError(`${spec.from.table} has no field called ${spec.from.column}.`, 400);

  // The side being pointed at has to be able to identify a row. Without that,
  // "which user?" has no answer and no engine will take the constraint.
  if (!isUnique(fromTable, [spec.from.column])) {
    throw new AccountError(
      `${spec.from.table}.${spec.from.column} is not the primary key and is not marked as must-be-different, so it cannot say which row is meant. Pick the id, or make that field must-be-different first.`, 400);
  }

  if (spec.kind === 'many-to-many') return addManyToMany(s, spec, fromColumn);

  const toTable = table(s, spec.to.table);
  if (toTable.name === fromTable.name) {
    // Not refused: a table pointing at itself is how a tree is stored. It just
    // needs its own field, which the caller has to have named.
    if (!spec.to.column) throw new AccountError('A table connected to itself needs a field to keep the connection in.', 400);
  }
  const wantName = spec.to.column ?? referenceName(spec.from.table, spec.from.column);
  const problem = newFieldProblem(toTable, wantName, spec.to.column);
  if (problem) throw new AccountError(problem, 400);

  const existing = col(toTable, wantName);
  if (existing && !typesFit(fromColumn, existing)) {
    throw new AccountError(
      `${toTable.name}.${wantName} and ${fromTable.name}.${spec.from.column} hold different kinds of thing, so one cannot point at the other. Give them the same kind of field first.`, 400);
  }
  if (spec.onDelete === 'set null' && existing?.required) {
    throw new AccountError(
      `${toTable.name}.${wantName} is required, so it cannot be emptied when a ${fromTable.name} row goes. Choose another option, or make the field optional first.`, 400);
  }
  if (toTable.foreignKeys.some((f) => f.columns.length === 1 && f.columns[0] === wantName)) {
    throw new AccountError(`${toTable.name}.${wantName} already points at something.`, 400);
  }

  // A reference field mirrors what it points at, minus the identity: two tables
  // cannot both be filling in the same number.
  const made: Column = existing ?? {
    ...fromColumn, name: wantName, identity: false, required: false, default: null,
  };
  const fk: ForeignKey = {
    name: constraintName(toTable.name, [wantName]),
    columns: [wantName],
    references: { table: fromTable.name, columns: [spec.from.column] },
    onDelete: spec.onDelete,
  };
  // one-to-one is a one-to-many that may only happen once, which is a
  // must-be-different rule on the field holding the reference
  const uniques = spec.kind === 'one-to-one' && !isUnique(toTable, [wantName])
    ? [...toTable.uniques, { name: `${toTable.name}_${wantName}_key`, columns: [wantName] }]
    : toTable.uniques;

  return {
    ...s,
    tables: s.tables.map((t) => (t.name !== toTable.name ? t : {
      ...t,
      columns: existing ? t.columns : [...t.columns, made],
      uniques,
      foreignKeys: [...t.foreignKeys, fk],
    })),
  };
}

function newFieldProblem(t: Table, name: string, asked: string | undefined): string | null {
  if (!NAME_RE.test(name)) {
    return asked
      ? 'A field name uses lowercase letters, digits and underscores, and starts with a letter.'
      : `The panel would have called the new field ${name}, which is not a name a database will take. Pick the field yourself.`;
  }
  return null;
}

// A many-to-many needs a table in the middle. The panel offers to make one
// (docs/databases-plan.md 7): two references, a composite key of them both,
// and nothing else -- which is exactly the shape `isJunction` reads back, so
// the canvas can hide it again.
function addManyToMany(s: Snapshot, spec: Spec, fromColumn: Column): Snapshot {
  const a = table(s, spec.from.table);
  const b = table(s, spec.to.table);
  if (a.name === b.name) {
    throw new AccountError('A many-to-many between a table and itself needs a connecting table you make yourself.', 400);
  }
  const bKey = spec.to.column ?? b.primaryKey[0];
  if (!bKey) throw new AccountError(`${b.name} has no primary key, so there is nothing to connect to.`, 400);
  const bColumn = col(b, bKey);
  if (!bColumn) throw new AccountError(`${b.name} has no field called ${bKey}.`, 400);
  if (!isUnique(b, [bKey])) {
    throw new AccountError(`${b.name}.${bKey} cannot say which row is meant, so it cannot be connected to.`, 400);
  }

  const name = spec.junction?.trim() || junctionName(a.name, b.name);
  if (!NAME_RE.test(name)) {
    throw new AccountError('A table name uses lowercase letters, digits and underscores, and starts with a letter.', 400);
  }
  if (s.tables.some((t) => t.name === name)) {
    throw new AccountError(`There is already a table called ${name}. Give the connecting table another name, or point at the one you have.`, 400);
  }
  const left = referenceName(a.name, spec.from.column);
  const right = referenceName(b.name, bKey);
  if (left === right) {
    throw new AccountError(`Both sides would be called ${left} in the connecting table. Make it yourself so the two fields can have different names.`, 400);
  }

  const column = (from: Column, as: string): Column =>
    ({ ...from, name: as, identity: false, required: true, default: null });
  const junction: Table = {
    name: free(s, name),
    columns: [column(fromColumn, left), column(bColumn, right)],
    // both together identify the row, which is what stops the same pair being
    // connected twice
    primaryKey: [left, right],
    uniques: [],
    foreignKeys: [
      { name: constraintName(name, [left]), columns: [left], references: { table: a.name, columns: [spec.from.column] }, onDelete: spec.onDelete },
      { name: constraintName(name, [right]), columns: [right], references: { table: b.name, columns: [bKey] }, onDelete: spec.onDelete },
    ],
    indexes: [],
  };
  return { ...s, tables: [...s.tables, junction] };
}

// Changing only what happens when the row on the "one" side is deleted.
//
// Its own operation rather than "remove it and draw it again": for a
// many-to-many that would delete the connecting table and build a new one,
// losing anything she had added beside the pair -- and on a plain relationship
// it would drop and re-add a constraint for no reason.
export function setOnDelete(s: Snapshot, at: { table: string; foreignKey: string }[], onDelete: OnDelete): Snapshot {
  const names = new Set(at.map((x) => `${x.table}:${x.foreignKey}`));
  let found = 0;
  const tables = s.tables.map((t) => ({
    ...t,
    foreignKeys: t.foreignKeys.map((f) => {
      if (!names.has(`${t.name}:${f.name}`)) return f;
      found++;
      if (onDelete === 'set null') {
        const holding = t.columns.filter((c) => f.columns.includes(c.name));
        const required = holding.find((c) => c.required);
        if (required) {
          throw new AccountError(
            `${t.name}.${required.name} is required, so it cannot be emptied when a ${f.references.table} row goes. Choose another option, or make the field optional first.`, 400);
        }
      }
      return { ...f, onDelete };
    }),
  }));
  if (found !== at.length) throw new AccountError('That connection is not in your drawing any more. Open the page again.', 400);
  return { ...s, tables };
}

// Taking a relationship off the drawing. A many-to-many is its connecting
// table, so removing it removes that table -- which is a real loss if she had
// put anything in it, and is why the page asks before calling this.
export function removeRelationship(s: Snapshot, at: { table: string; foreignKey: string }[]): Snapshot {
  const names = new Set(at.map((x) => `${x.table}:${x.foreignKey}`));
  const junctions = new Set(
    s.tables.filter((t) => isJunction(t) && t.foreignKeys.every((f) => names.has(`${t.name}:${f.name}`))).map((t) => t.name));
  return {
    ...s,
    tables: s.tables
      .filter((t) => !junctions.has(t.name))
      .map((t) => ({ ...t, foreignKeys: t.foreignKeys.filter((f) => !names.has(`${t.name}:${f.name}`)) })),
  };
}

// The gesture as it arrives from the browser, read field by field.
export function checkSpec(body: unknown): Spec {
  const o = (body ?? {}) as Record<string, unknown>;
  const from = (o.from ?? {}) as Record<string, unknown>;
  const to = (o.to ?? {}) as Record<string, unknown>;
  const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !NAME_RE.test(v)) throw new AccountError(`The panel could not read which ${what} you meant.`, 400);
    return v;
  };
  if (!isKind(o.kind)) throw new AccountError('Pick what kind of relationship this is.', 400);
  if (!isOnDelete(o.onDelete)) throw new AccountError('Pick what should happen when a row is deleted.', 400);
  return {
    from: { table: str(from.table, 'table'), column: str(from.column, 'field') },
    to: {
      table: str(to.table, 'table'),
      column: to.column === undefined || to.column === null || to.column === '' ? undefined : str(to.column, 'field'),
    },
    kind: o.kind,
    onDelete: o.onDelete,
    junction: typeof o.junction === 'string' && o.junction.trim() ? o.junction.trim() : undefined,
  };
}

export function checkWhere(body: unknown): { table: string; foreignKey: string }[] {
  const o = (body ?? {}) as Record<string, unknown>;
  const at = Array.isArray(o.at) ? o.at : [];
  if (at.length === 0 || at.length > 2) throw new AccountError('The panel could not tell which relationship you meant.', 400);
  return at.map((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    if (typeof e.table !== 'string' || !NAME_RE.test(e.table) || typeof e.foreignKey !== 'string' || !e.foreignKey) {
      throw new AccountError('The panel could not tell which relationship you meant.', 400);
    }
    return { table: e.table, foreignKey: e.foreignKey };
  });
}
