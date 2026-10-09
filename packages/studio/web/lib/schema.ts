// The schema designer's side of the shared IR (src/pammydb/ir.ts is the server's
// copy and the one the helper enforces). The panel's web app is a separate Vite
// root with no path into ../src, so this is written out again here -- and
// test/studio.test.ts imports both and asserts they still say the same thing,
// which is what stops the page offering a kind of field the helper would refuse.
//
// Pure TypeScript on purpose: no React, no imports, so that test can load it.

export type DatabaseEngine = 'postgres' | 'mariadb';

export const COLUMN_TYPES = [
  'text', 'short_text', 'integer', 'decimal', 'boolean', 'date', 'time', 'timestamptz', 'uuid',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number] | 'other';

export const TYPE_NAMES: Record<ColumnType, string> = {
  text: 'Text',
  short_text: 'Short text',
  integer: 'Whole number',
  decimal: 'Decimal number',
  boolean: 'Yes / no',
  date: 'Date',
  time: 'Time',
  timestamptz: 'Date and time',
  uuid: 'Unique id',
  other: 'Something else',
};

export const TYPE_HINTS: Record<ColumnType, string> = {
  text: 'Any amount of writing — a title, a paragraph, a whole page.',
  short_text: 'Writing with a length limit, like a postcode or a two-letter country.',
  integer: 'A number with nothing after the point: 0, 7, 2026.',
  decimal: 'A number with a point in it, like a price: 12.50.',
  boolean: 'A tick box: yes or no, on or off.',
  date: 'A day, with no time of day.',
  time: 'A time of day, with no date.',
  timestamptz: 'A moment: the day and the time, kept in UTC.',
  uuid: 'A long random id, the kind programs make for themselves.',
  other: 'Something this database already had that the panel does not offer. It is left exactly as it is.',
};

export type ColumnDefault =
  | { kind: 'none' }
  | { kind: 'now' }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'raw'; sql: string };

export const DEFAULT_TEXT_RE = /^[A-Za-z0-9 .,_@:+/()?!%&#-]{0,100}$/;

export type SchemaColumn = {
  name: string;
  was?: string;
  type: ColumnType;
  sqlType?: string | null;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  required: boolean;
  default?: ColumnDefault | null;
  identity?: boolean;
};

export type SchemaUnique = { name: string; columns: string[] };
export type SchemaIndex = { name: string; columns: string[]; unique: boolean };
export type SchemaForeignKey = {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete: 'restrict' | 'cascade' | 'set null';
};

export type SchemaTable = {
  name: string;
  was?: string;
  columns: SchemaColumn[];
  primaryKey: string[];
  uniques: SchemaUnique[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
};

export type Schema = { engine: DatabaseEngine; database: string; tables: SchemaTable[]; notes: string[] };

export type SchemaChange = { table: string; line: string; warning: string | null; destructive: boolean };

export type SchemaData = {
  engine: DatabaseEngine;
  database: string;
  current: Schema;
  currentHash: string;
  draft: Schema;
  hasDraft: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  plan: { steps: unknown[]; changes: SchemaChange[]; destructive: boolean };
  drift: boolean;
  notes: string[];
  // Where the rectangles are on the canvas (src/studio/layout.ts). Every table
  // in `draft` has an entry: the server places the ones she has never dragged,
  // so the canvas never has to guess and never draws two tables on top of each
  // other. Not part of the drawing -- it survives Discard.
  layout: SchemaLayout;
  // every relationship in the drawing, a many-to-many being one line rather
  // than two references into a table she never asked for
  relationships: Relationship[];
  // What these changes do to her app, when it is switched on; null when it is
  // off (src/studio/impact.ts).
  app: AppImpact | null;
  // docs/catalog-plan.md step 4: tables that go with tags on their records
  tagsLost?: { table: string; plural: string; labelled: number }[];
};

export type AppImpact = {
  title: string;
  // either API switch is on: programs may be reading this
  programs: boolean;
  touched: { table: string; plural: string; how: 'goes' | 'renamed' | 'changed' }[];
  added: string[];
};

// The line over the changes on the Tables page and the canvas. On a switched-on
// app it says which app they reach, the way the Review page then spells out
// (docs/databases-plan.md 5: "5 schema changes · may affect Blog").
export function drawnLine(count: number, app: AppImpact | null): string {
  const n = `${count} ${count === 1 ? 'change' : 'changes'} in your drawing.`;
  return app && app.touched.length
    ? `${n} Nothing has happened yet — when you apply ${count === 1 ? 'it' : 'them'}, ${app.title} changes too, because it is switched on.`
    : `${n} The database itself has not been touched.`;
}

export type Spot = { x: number; y: number };
// `manyToMany` is how a connecting table is drawn: `simple` hides it behind one
// line, `expanded` shows the real three rectangles. Remembered per database, and
// only ever about how the drawing is looked at (docs/databases-plan.md 7).
export type CanvasView = 'simple' | 'expanded';
export type SchemaLayout = { tables: Record<string, Spot>; manyToMany: CanvasView };

// A relationship as she would describe it (src/studio/relationships.ts is where
// this is worked out -- unlike the simpler draft edits, the panel does it rather
// than the page, because a many-to-many means inventing a table).
export type RelationshipKind = 'one-to-one' | 'one-to-many' | 'many-to-many';
export type OnDelete = 'restrict' | 'cascade' | 'set null';

export const ON_DELETE_NAMES: Record<OnDelete, string> = {
  restrict: 'Prevent deletion',
  cascade: 'Delete the related rows too',
  'set null': 'Keep them, but remove the connection',
};

// What each choice means for her rows, under the name of it.
export const ON_DELETE_HINTS: Record<OnDelete, string> = {
  restrict: 'The row cannot be deleted while anything is still connected to it. The safest choice, and the one to keep unless you have a reason.',
  cascade: 'Deleting the row deletes everything connected to it as well. Quick, and there is no undo.',
  'set null': 'The connected rows stay, and simply stop being connected. Only possible when the field is optional.',
};

export const KIND_NAMES: Record<RelationshipKind, string> = {
  'one-to-one': 'one of each',
  'one-to-many': 'one has many',
  'many-to-many': 'many have many',
};

export type Relationship = {
  kind: RelationshipKind;
  from: string;
  fromColumns: string[];
  to: string;
  toColumns: string[];
  onDelete: OnDelete;
  at: { table: string; foreignKey: string }[];
  junction: string | null;
  line: string;
};

export type ReviewData = SchemaData & { sql: string[] };

export type ApplyData = SchemaData & {
  ok: boolean;
  applied: number;
  total: number;
  failed: { at: number; message: string } | null;
  rolledBack: boolean;
};

// ------------------------------------------------------------------ small helpers

export const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function newIdentProblem(name: string, what: 'table' | 'field'): string | null {
  if (name === '') return `Please type a ${what} name.`;
  if (name.length > 63) return 'Names can be at most 63 characters.';
  if (/[A-Z]/.test(name)) return 'Use lowercase letters only.';
  if (/^[0-9]/.test(name)) return 'Names have to start with a letter.';
  if (!NAME_RE.test(name)) return 'Use only lowercase letters, digits and underscores, starting with a letter.';
  return null;
}

export const typeLabel = (c: SchemaColumn): string => {
  if (c.type === 'other') return c.sqlType ?? 'something else';
  if (c.type === 'short_text') return `${TYPE_NAMES.short_text} (${c.length ?? 255})`;
  if (c.type === 'decimal' && (c.precision ?? 12) !== 12) return `${TYPE_NAMES.decimal} (${c.precision}, ${c.scale})`;
  return TYPE_NAMES[c.type];
};

export function defaultLabel(d: ColumnDefault | null | undefined): string | null {
  if (!d || d.kind === 'none') return null;
  switch (d.kind) {
    case 'now': return 'the moment it is added';
    case 'text': return d.value === '' ? 'empty text' : `"${d.value}"`;
    case 'number': return String(d.value);
    case 'boolean': return d.value ? 'yes' : 'no';
    case 'raw': return d.sql;
  }
}

export const canAlter = (c: SchemaColumn): boolean => c.type !== 'other' && c.default?.kind !== 'raw';

export function whyNotAlterable(c: SchemaColumn): string | null {
  if (c.type === 'other') return `This field is a ${c.sqlType ?? 'kind'} the panel does not offer, so it leaves it exactly as it is.`;
  if (c.default?.kind === 'raw') return `This field starts out as ${c.default.sql}, which the panel cannot write down, so it leaves the field as it is.`;
  return null;
}

// A new table comes with the key she would have had to invent and the two dates
// the generated list wants -- suggested, and she can take them off before Apply
// (docs/databases-plan.md 6, C13).
export function starterTable(name: string): SchemaTable {
  return {
    name,
    columns: [
      { name: 'id', type: 'integer', required: true, identity: true, default: null },
      { name: 'created_at', type: 'timestamptz', required: true, default: { kind: 'now' } },
      { name: 'updated_at', type: 'timestamptz', required: false, default: { kind: 'now' } },
    ],
    primaryKey: ['id'],
    uniques: [],
    foreignKeys: [],
    indexes: [],
  };
}

export const starterColumn = (name: string): SchemaColumn =>
  ({ name, type: 'text', required: false, default: null });

// The next free table_n, so + Add table always has something to call it.
export function nextTableName(tables: SchemaTable[]): string {
  const taken = new Set(tables.map((t) => t.name));
  for (let n = 2; n < 500; n++) if (!taken.has(`table_${n}`)) return `table_${n}`;
  return `table_${Date.now()}`;
}

// What she can pick as a field's starting value, for the kind of field it is.
// "now" only means something for the three kinds of field that hold a moment.
export const canBeNow = (t: ColumnType) => t === 'date' || t === 'time' || t === 'timestamptz';

export function defaultChoices(t: ColumnType): { value: string; label: string }[] {
  const none = { value: 'none', label: 'Nothing' };
  if (canBeNow(t)) return [none, { value: 'now', label: 'The moment the row is added' }, { value: 'text', label: 'Something I type' }];
  if (t === 'boolean') return [none, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  return [none, { value: 'text', label: 'Something I type' }];
}

// ------------------------------------------------------------------ whole-table edits
// The canvas's table menu and the Tables list make the same few moves on the
// drawing. Each takes the draft's tables and gives the next ones back; nothing
// here saves anything.

// The relationships in OTHER tables that point at this one. A table's own
// relationships go with it; these are the ones she would not see go.
export const pointingAt = (tables: SchemaTable[], name: string): { table: string; columns: string[] }[] =>
  tables.flatMap((t) => (t.name === name ? [] : t.foreignKeys
    .filter((f) => f.references.table === name)
    .map((f) => ({ table: t.name, columns: f.columns }))));

// Taking a table out takes the relationships to it with it. Left behind, they
// would point at nothing, and the engine refuses to drop a table something still
// points at. The fields that held them stay: only the connection goes.
export const withoutTable = (tables: SchemaTable[], name: string): SchemaTable[] =>
  tables.filter((t) => t.name !== name).map((t) => (
    t.foreignKeys.some((f) => f.references.table === name)
      ? { ...t, foreignKeys: t.foreignKeys.filter((f) => f.references.table !== name) }
      : t));

// A rename, and not a table thrown away and another made: `was` keeps the name
// the engine has, exactly as a field rename does (docs/databases-plan.md 8).
// Relationships pointing at it are pointed at the new name, which is what she
// sees; the panel works out that on the engine they still point at the old one
// until the rename runs (src/studio/diff.ts).
export function renamedTable(current: Schema, tables: SchemaTable[], from: string, to: string): SchemaTable[] {
  return tables.map((t) => {
    const foreignKeys = t.foreignKeys.map((f) =>
      (f.references.table === from ? { ...f, references: { ...f.references, table: to } } : f));
    if (t.name !== from) return { ...t, foreignKeys };
    const { was: _, ...rest } = t;
    const was = t.was ?? (isNew(current, t) ? undefined : t.name);
    return was && was !== to ? { ...rest, name: to, was, foreignKeys } : { ...rest, name: to, foreignKeys };
  });
}

// The next free name for a copy: recipes_copy, recipes_copy_2, ...
export function copyName(tables: SchemaTable[], name: string): string {
  const taken = new Set(tables.map((t) => t.name));
  const stem = `${name.slice(0, 63 - '_copy_99'.length)}_copy`;
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 100; n++) if (!taken.has(`${stem}_${n}`)) return `${stem}_${n}`;
  return nextTableName(tables);
}

// A copy of a table's DESIGN -- its fields, key, rules and relationships -- as a
// new table in the drawing. Not its rows: the drawing has no rows in it, and a
// copy is made the way any new table is, empty, when she applies it.
//
// Two things cannot be copied, and she is told which rather than having Apply
// fail later: a field the panel did not make (it does not know how to write
// one down), and anything resting on such a field. Its indexes are left behind
// too: the panel never makes indexes, it only keeps the ones she had.
// Constraints are named after the copy, because on Postgres two tables cannot
// share a rule's name. A relationship the table has with itself (a recipe's
// "based on" another recipe) points at the copy.
export function clonedTable(t: SchemaTable, name: string): { table: SchemaTable; left: string[] } | { problem: string } {
  const skip = new Set(t.columns.filter((c) => !canAlter(c)).map((c) => c.name));
  const key = t.primaryKey.find((k) => skip.has(k));
  if (key) return { problem: `${t.name} can't be copied: its key, ${key}, is a kind of field the panel does not make.` };
  const keeps = (cols: string[]) => !cols.some((c) => skip.has(c));
  const named = (cols: string[], end: string) => `${name}_${cols.join('_')}`.slice(0, 63 - end.length) + end;
  const table: SchemaTable = {
    name,
    columns: t.columns.filter((c) => !skip.has(c.name)).map(({ was: _, ...c }) => c),
    primaryKey: [...t.primaryKey],
    uniques: t.uniques.filter((u) => keeps(u.columns)).map((u) => ({ name: named(u.columns, '_key'), columns: [...u.columns] })),
    foreignKeys: t.foreignKeys.filter((f) => keeps(f.columns)).map((f) => ({
      ...f,
      name: named(f.columns, '_fkey'),
      columns: [...f.columns],
      references: { table: f.references.table === t.name ? name : f.references.table, columns: [...f.references.columns] },
    })),
    indexes: [],
  };
  if (table.columns.length === 0) return { problem: `${t.name} can't be copied: none of its fields are a kind the panel makes.` };
  return { table, left: [...skip] };
}

// Does this table exist on the engine, or is it only in the drawing?
export const isNew = (current: Schema, t: SchemaTable): boolean =>
  !current.tables.some((x) => x.name === (t.was ?? t.name));

// Whether a field is part of the primary key: those are not edited here (S16).
export const isKey = (t: SchemaTable, c: SchemaColumn): boolean => t.primaryKey.includes(c.name);

// ------------------------------------------------------------------ what her tables MEAN
// The Application side (docs/databases-plan.md 11). Everything here is inferred
// from the schema and only overridden where she has said otherwise, so a table
// she has never looked at arrives proposed rather than managed
// (src/studio/resources.ts is where that is worked out).

export const ABILITIES = ['create', 'view', 'edit', 'delete', 'duplicate', 'search', 'sort', 'filter'] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  create: 'Add new ones',
  view: 'Look at them',
  edit: 'Change them',
  delete: 'Delete them',
  duplicate: 'Make a copy',
  search: 'Search',
  sort: 'Sort',
  filter: 'Filter',
};

export const CONTROLS = ['line', 'paragraph', 'rich', 'number', 'tick', 'date', 'time', 'moment', 'picker', 'text'] as const;
export type Control = (typeof CONTROLS)[number];

export const CONTROL_NAMES: Record<Control, string> = {
  line: 'One line',
  paragraph: 'A few lines',
  rich: 'Rich text',
  number: 'A number',
  tick: 'A tick box',
  date: 'A day',
  time: 'A time of day',
  moment: 'A day and a time',
  picker: 'Pick a related record',
  text: 'Left as it is',
};

// Only long text can hold formatting (docs/rich-text-plan.md T1; the panel
// refuses the rest too -- src/studio/resources.ts canBeRich).
export const canBeRich = (f: { type: ColumnType; primaryKey: boolean; reference: string | null }): boolean =>
  f.type === 'text' && !f.primaryKey && !f.reference;

export type ResourceKind = 'thing' | 'connection' | 'machinery';

export type ResourceField = {
  name: string;
  type: ColumnType;
  required: boolean;
  storedAs: string;
  exposed: boolean;
  label: string;
  help: string;
  control: Control;
  showInList: boolean;
  searchable: boolean;
  filterable: boolean;
  formOrder: number;
  primaryKey: boolean;
  reference: string | null;
  changed: boolean;
};

export type Resource = {
  table: string;
  kind: ResourceKind;
  enabled: boolean;
  // false means the panel is guessing: she has not said yes or no yet
  decided: boolean;
  singular: string;
  plural: string;
  icon: string;
  description: string;
  titleField: string | null;
  sortField: string | null;
  sortDir: 'asc' | 'desc';
  can: Record<Ability, boolean>;
  onDelete: 'follow' | 'confirm';
  // "Anyone can read these", and its one rule: only rows where this yes/no
  // field is yes (docs/db-examples-plan.md X1, X12)
  publicRead: boolean;
  publicOnly: string | null;
  // docs/tutorials-plan.md V1, V2: people signed in to this protected folder
  // (its id) may change these with no key; with an owner field, each their own
  visitorArea: number | null;
  visitorOwner: string | null;
  fields: ResourceField[];
  // docs/field-order-plan.md: every field, and each many-to-many as
  // `many:<other table>`, in the order of the form; and whether she chose it
  fieldOrder: string[];
  ordered: boolean;
  related: { line: string; kind: RelationshipKind; other: string }[];
  note: string | null;
};

export type AppData = {
  engine: DatabaseEngine;
  database: string;
  // 'active' means the pages exist and the menu has a group for it. It does
  // NOT mean anything is on the internet: the API switches are separate.
  status: 'inactive' | 'active';
  title: string;
  // the two switches that let programs in. Both off until she says otherwise:
  // switching the app on gives her pages, these give the internet a way in.
  apiRead: boolean;
  apiWrite: boolean;
  resources: Resource[];
};

// A key a program uses. The key itself is shown once, when it is made, and
// never again -- only its first characters are kept, to tell keys apart.
export type AppKey = {
  id: number;
  label: string;
  prefix: string;
  resources: 'all' | string[];
  canWrite: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

// What a generated page is handed (docs/databases-plan.md 11.7). The rows have
// already been reduced to the Resource's window by the panel, so a page can
// show everything it is given without deciding what is safe.
export type RecordRow = Record<string, unknown>;

// A record's connections, by name (docs/record-picker-plan.md R11): a field
// pointing at another table as { id, label }, a many-to-many as a list.
export type Label = { id: unknown; label: string };
export type Links = Record<string, Label | null | Label[]>;
// which fields connect to what, as far as this app may read
export type Connections = {
  refs: { column: string; name: string; table: string; plural: string }[];
  many: { name: string; table: string; plural: string; singular: string }[];
};

export type RecordsData = {
  resource: Resource;
  items: RecordRow[];
  total: number;
  page: number;
  connections: Connections;
  // the connections of each item, in the same order
  links: Links[];
  // docs/catalog-plan.md step 4: each item's tags and categories, with tags on
  labels?: LabelNames[];
};

export type RecordData = { resource: Resource; row: RecordRow; connections: Connections; links: Links; labels?: LabelNames };

// A table's "Tags and categories" (docs/catalog-plan.md step 4); the same shapes as
// @panel/catalog's web lib/labels.ts (no imports here: test/studio.test.ts loads this file)
export type LabelNames = { tags: string[]; categories: string[] };
export type TableLabel = { id: number; type: 'tag' | 'category'; name: string; address: string; everywhere: boolean; count: number; public: boolean };
export type TableTags = {
  on: boolean; hasKey: boolean; max: number;
  pictureField: string | null; titleField: string | null;
  pictureChoices: { name: string; label: string }[];
  counts: { items: number; labelled: number; links: number; labels: number } | null;
  state: { at: number; items: number; missing: number; error: string | null } | null;
  labels: TableLabel[];
};

// A field's value as she reads it: a connection by the other record's name.
export function cellOf(f: { name: string; control: Control }, row: RecordRow, links: Links | undefined, c: Connections | undefined): string {
  const ref = c?.refs.find((x) => x.column === f.name);
  if (ref && links && ref.name in links) {
    const l = links[ref.name];
    return l && !Array.isArray(l) ? (l.label || String(l.id)) : '—';
  }
  return showValue(row[f.name], f.control);
}

// A many-to-many in a list: a few names, and how many more.
export function namesOf(ls: Label[] | undefined, most = 3): string {
  if (!ls || ls.length === 0) return '—';
  const shown = ls.slice(0, most).map((l) => l.label).join(', ');
  return ls.length > most ? `${shown} and ${ls.length - most} more` : shown;
}

export const PAGE_SIZE = 20;

// How a value is shown in a list: her words, not the database's. Nothing here
// guesses at meaning -- it only makes a value readable.
export function showValue(v: unknown, control: Control): string {
  if (v === null || v === undefined || v === '') return '—';
  if (control === 'tick') return v === true || v === 1 || v === '1' ? 'Yes' : 'No';
  if (control === 'moment' || control === 'date') {
    const d = new Date(String(v));
    if (!Number.isNaN(d.getTime())) {
      return control === 'date' ? d.toLocaleDateString() : d.toLocaleString();
    }
  }
  return String(v);
}

