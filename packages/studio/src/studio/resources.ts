// What her tables MEAN (docs/databases-plan.md 11). A table answers "how is
// this kept?"; a Resource answers "what is this, and what should people be able
// to do with it?".
//
// The rule that shapes this whole file: **everything is inferred, and only what
// she has changed is stored** (docs/studio-plan.md, "Inference"). A row in
// `studio_resources` is an override, never a copy of the schema. Three things
// follow, and all three are the point:
//
//  * A table she has never looked at is **proposed**, not managed. Adopting a
//    database with forty tables does not fill her menu with forty pages.
//  * A column that changes type does not leave the panel holding a stale
//    opinion about it -- there was nothing stored to go stale.
//  * Re-running inference after an Apply is free, and new tables show up as
//    something to tick rather than something that silently appeared.
//
// Pure: no database, no socket, no clock. What is stored lives in store.ts's
// half of this file; this half only decides what things mean.
import { AccountError } from '@panel/core/accounts';
import { NAME_RE } from '../pammydb/ident.ts';
import { typeLabel, type Column, type Snapshot, type Table } from '../pammydb/ir.ts';
import { isJunction, relationships, singular, type Relationship } from './relationships.ts';

// ------------------------------------------------------------------ her words for a name

// `blog_posts` -> `Blog Post` / `Blog Posts`. Naive on purpose, and she edits
// it: a wrong guess she can fix in one field beats a form she has to fill in
// before anything works.
export const titleCase = (name: string): string =>
  name.split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

export const singularName = (table: string): string => titleCase(singular(table));
export const pluralName = (table: string): string =>
  (singular(table) === table ? `${titleCase(table)} records` : titleCase(table));

// A field's label: `published_at` -> `Published at`, and `author_id` -> `Author`
// when it is a reference, because she picks an author, not a number.
export function fieldLabel(name: string, isReference: boolean): string {
  const base = isReference && name.endsWith('_id') ? name.slice(0, -3) : name;
  const words = titleCase(base);
  return words.charAt(0) + words.slice(1).toLowerCase().replace(/(^|\s)id($|\s)/g, '$1ID$2');
}

// ------------------------------------------------------------------ what a table is

export const KINDS = ['thing', 'connection', 'machinery'] as const;
export type Kind = (typeof KINDS)[number];

// Names that are somebody's plumbing rather than something she keeps. Still
// offered -- she can tick `wp_posts` and manage her blog from here -- but off
// unless she says otherwise. WordPress is not special-cased beyond the
// prefix: the rule is "does this look like machinery", not "whose is it".
const MACHINERY = [
  /^schema_migrations$/, /^sessions?$/, /_cache$/, /^cache_/, /^wp_options$/,
  /^migrations$/, /^ar_internal_metadata$/, /^flyway_/, /^knex_migrations/,
  /^django_/, /^alembic_version$/, /^_prisma_/,
];

export function kindOf(t: Table): Kind {
  if (isJunction(t)) return 'connection';
  return MACHINERY.some((re) => re.test(t.name)) ? 'machinery' : 'thing';
}

// The field that names a record. Never the raw id: a selector saying "17" is
// the thing this whole layer exists to avoid.
export function titleFieldOf(t: Table): string | null {
  const named = (n: string) => t.columns.find((c) => c.name === n && c.type !== 'other');
  const text = (c: Column) => c.type === 'text' || c.type === 'short_text';
  return (named('name') ?? named('title') ?? named('label')
    ?? t.columns.find((c) => text(c) && c.required)
    ?? t.columns.find((c) => text(c)))?.name ?? null;
}

// How a field is edited, from the kind of thing it holds (§11.1, and the table
// of controls in §6). `rich` is never worked out -- only she chooses it
// (docs/rich-text-plan.md T2), and only where it fits (canBeRich).
export const CONTROLS = ['line', 'paragraph', 'rich', 'number', 'tick', 'date', 'time', 'moment', 'picker', 'text'] as const;
export type Control = (typeof CONTROLS)[number];
export const isControl = (v: unknown): v is Control => CONTROLS.includes(v as Control);

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

// Rich text is HTML, so only a field that can hold any amount of writing can
// be one (T1): not short text (a VARCHAR fills up with tags), not the key, not
// a connection.
export const canBeRich = (f: { type: Column['type']; primaryKey: boolean; reference: string | null }): boolean =>
  f.type === 'text' && !f.primaryKey && !f.reference;

export function controlOf(c: Column, isReference: boolean): Control {
  if (isReference) return 'picker';
  switch (c.type) {
    case 'short_text': return 'line';
    case 'text': return 'paragraph';
    case 'integer': case 'decimal': return 'number';
    case 'boolean': return 'tick';
    case 'date': return 'date';
    case 'time': return 'time';
    case 'timestamptz': return 'moment';
    case 'uuid': return 'line';
    default: return 'text';
  }
}

// ------------------------------------------------------------------ the shape a page reads

export type FieldView = {
  name: string;
  // what kind of thing it holds, for the catalog (a yes/no field compares as one)
  type: Column['type'];
  // it has to be filled in: a connection that may be left empty can be cleared
  required: boolean;
  // docs/form-to-database-plan.md: what a form writing into it needs to know --
  // the most letters short text holds, and whether the engine fills it in
  // itself when nothing is given (a default, or an identity)
  length?: number;
  defaulted: boolean;
  // what the database says, in her words, so the two are never confused
  storedAs: string;
  exposed: boolean;
  label: string;
  help: string;
  control: Control;
  showInList: boolean;
  searchable: boolean;
  filterable: boolean;
  formOrder: number;
  // things she may not change, and why
  primaryKey: boolean;
  reference: string | null;
  changed: boolean;
};

export type ResourceView = {
  table: string;
  kind: Kind;
  // has she said? `enabled` is what holds now; `decided` says whether that is
  // her answer or the panel's guess (a new table is proposed, not managed)
  enabled: boolean;
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
  // "Anyone can read these" (docs/db-examples-plan.md X1), and its one fixed
  // rule: only rows where this yes/no field is yes (X12)
  publicRead: boolean;
  publicOnly: string | null;
  // docs/tutorials-plan.md V1, V2: people signed in to this protected folder
  // (the gate's area id) may change these with no key -- and, with an owner
  // field, each only their own
  visitorArea: number | null;
  visitorOwner: string | null;
  // many-to-many connections through a connecting table, for the API's answers
  // (X7): which table, and which of its two fields points here and there
  many: { other: string; junction: string; here: string; there: string }[];
  // docs/field-order-plan.md: the order of the form -- every field, and each
  // many-to-many as `many:<other table>` -- and whether she chose it (O3)
  fieldOrder: string[];
  ordered: boolean;
  fields: FieldView[];
  related: { line: string; kind: Relationship['kind']; other: string }[];
  // why it is off by default, in her words, when it is
  note: string | null;
  // docs/catalog-plan.md step 4: "Let me tag these" (a managed table with a key only),
  // its catalog source, and the picture field (one that is still text)
  tagged: boolean;
  catalogSource: number | null;
  pictureField: string | null;
};

export const ABILITIES = ['create', 'view', 'edit', 'delete', 'duplicate', 'search', 'sort', 'filter'] as const;
export type Ability = (typeof ABILITIES)[number];
export const isAbility = (v: unknown): v is Ability => ABILITIES.includes(v as Ability);

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

// Defaults for something inferred: everything on except Filter, which is a tick
// she turns on per field (§11.1).
const DEFAULT_CAN: Record<Ability, boolean> = {
  create: true, view: true, edit: true, delete: true, duplicate: true, search: true, sort: true, filter: false,
};

// Rows she has saved, as the store hands them over.
export type ResourceRow = {
  table_name: string;
  enabled: boolean | null;
  singular: string; plural: string; icon: string; description: string;
  title_field: string; sort_field: string; sort_dir: 'asc' | 'desc';
  can_create: boolean; can_view: boolean; can_edit: boolean; can_delete: boolean;
  can_duplicate: boolean; can_search: boolean; can_sort: boolean; can_filter: boolean;
  on_delete: 'follow' | 'confirm';
  // docs/db-examples-plan.md X1, X12: anyone may read these without a key, and
  // only rows where this yes/no field is yes ('' for every row)
  public_read?: boolean;
  public_only?: string;
  // docs/tutorials-plan.md V1, V2
  visitor_area?: number | null;
  visitor_owner?: string;
  // docs/field-order-plan.md O2: a JSON list of names, '[]' for none
  field_order?: string;
  // docs/catalog-plan.md step 4: its catalog source while "Let me tag these" is on, and
  // the field whose value is a record's picture ('' none)
  catalog_source?: number | null;
  picture_field?: string;
};

export type FieldRow = {
  table_name: string; field_name: string;
  exposed: boolean; label: string; help: string; control: string;
  show_in_list: boolean; searchable: boolean; filterable: boolean; form_order: number;
};

const NOTES: Record<Kind, string | null> = {
  thing: null,
  connection: 'This table only holds which records go together. It works behind the scenes, and there is usually nothing here to manage.',
  machinery: 'This looks like a table a program keeps for itself rather than something you would edit. Tick it if you do want to manage it.',
};

// Everything the Application tab shows: inference, with her overrides on top.
export function resourceViews(s: Snapshot, rows: ResourceRow[], fields: FieldRow[]): ResourceView[] {
  const byTable = new Map(rows.map((r) => [r.table_name, r]));
  const fieldsOf = new Map<string, Map<string, FieldRow>>();
  for (const f of fields) {
    if (!fieldsOf.has(f.table_name)) fieldsOf.set(f.table_name, new Map());
    fieldsOf.get(f.table_name)!.set(f.field_name, f);
  }
  const links = relationships(s);

  return s.tables.map((t) => {
    const row = byTable.get(t.name);
    const kind = kindOf(t);
    const saved = fieldsOf.get(t.name) ?? new Map<string, FieldRow>();
    const references = new Map(t.foreignKeys.flatMap((f) => f.columns.map((c) => [c, f.references.table] as const)));

    // O3, O4, O6: her order if she chose one, then everything she did not
    // name, in the table's own column order (a many-to-many after the fields).
    // A stored per-field form_order is no longer read: nothing ever set it on
    // purpose, and its default of 0 put every field she touched at the top.
    const manyNames = links.flatMap((r) => (r.junction && (r.from === t.name || r.to === t.name)
      ? [`many:${r.from === t.name ? r.to : r.from}`] : []));
    const known = new Set([...t.columns.map((c) => c.name), ...manyNames]);
    const chosen = [...new Set(readOrder(row?.field_order).filter((n) => known.has(n)))];
    const fieldOrder = [...chosen, ...[...t.columns.map((c) => c.name), ...manyNames].filter((n) => !chosen.includes(n))];
    const place = new Map(fieldOrder.map((n, i) => [n, i]));

    const inferredTitle = titleFieldOf(t);
    const fieldViews: FieldView[] = t.columns.map((c, i) => {
      const f = saved.get(c.name);
      const reference = references.get(c.name) ?? null;
      const isPk = t.primaryKey.includes(c.name);
      const stored = f && isControl(f.control) ? f.control : null;
      // a stored "Rich text" on a field that is no longer long text (the
      // Studio changed its type) is not kept: an editor on a number would be
      // worse than the control inference picks (T14)
      const control = stored && (stored !== 'rich' || canBeRich({ type: c.type, primaryKey: isPk, reference }))
        ? stored : controlOf(c, !!reference);
      return {
        name: c.name,
        type: c.type,
        required: c.required,
        ...(c.length ? { length: c.length } : {}),
        defaulted: !!c.default || !!c.identity,
        // the same words the Fields page uses, from the same function: two
        // descriptions of one field would eventually disagree
        storedAs: typeLabel(c),
        exposed: f?.exposed ?? true,
        label: f?.label || fieldLabel(c.name, !!reference),
        help: f?.help ?? '',
        control,
        showInList: f?.show_in_list ?? (isPk ? false : i < 6),
        // short text is searched by default; long text is not (§11.1)
        searchable: f?.searchable ?? (c.type === 'short_text'),
        filterable: f?.filterable ?? false,
        formOrder: place.get(c.name) ?? i,
        primaryKey: isPk,
        reference,
        changed: !!f,
      };
    }).sort((a, b) => a.formOrder - b.formOrder);

    const can = { ...DEFAULT_CAN };
    if (row) for (const a of ABILITIES) can[a] = row[`can_${a}` as keyof ResourceRow] as boolean;
    // Duplicate is Create plus a copy: without Create there is nothing to make
    // (§11.1), so it is not offered as a thing she can leave on by mistake.
    if (!can.create) can.duplicate = false;

    const ownerOk = (name: string) => t.columns.some((c) => c.name === name && OWNER_TYPES.includes(c.type));
    return {
      table: t.name,
      kind,
      enabled: row?.enabled ?? (kind === 'thing'),
      decided: row?.enabled !== null && row?.enabled !== undefined,
      singular: row?.singular || singularName(t.name),
      plural: row?.plural || pluralName(t.name),
      icon: row?.icon ?? '',
      description: row?.description ?? '',
      titleField: (row?.title_field && t.columns.some((c) => c.name === row.title_field)) ? row.title_field : inferredTitle,
      sortField: (row?.sort_field && t.columns.some((c) => c.name === row.sort_field)) ? row.sort_field : null,
      sortDir: row?.sort_dir ?? 'asc',
      can,
      onDelete: row?.on_delete ?? 'follow',
      publicRead: row?.public_read ?? false,
      // a rule on a field that is no longer a yes/no field (or no longer there)
      // cannot be kept, so it is read as "no rule" -- and the panel refuses to
      // turn it on in the first place (checkPublicOnly)
      publicOnly: row?.public_only && t.columns.some((c) => c.name === row.public_only && c.type === 'boolean')
        ? row.public_only : null,
      // An owner field renamed or removed on the canvas can't quietly become
      // "they all share every row": the folder is let in to nothing until she
      // chooses again (fails closed, V2).
      visitorArea: row?.visitor_owner && !ownerOk(row.visitor_owner) ? null : row?.visitor_area ?? null,
      visitorOwner: row?.visitor_owner && ownerOk(row.visitor_owner) ? row.visitor_owner : null,
      tagged: !!row?.catalog_source && (row?.enabled ?? (kind === 'thing')) && t.primaryKey.length > 0,
      catalogSource: row?.catalog_source ? Number(row.catalog_source) : null,
      pictureField: row?.picture_field && t.columns.some((c) => c.name === row.picture_field && (c.type === 'text' || c.type === 'short_text'))
        ? row.picture_field : null,
      many: links.flatMap((r) => {
        if (!r.junction) return [];
        const j = s.tables.find((x) => x.name === r.junction);
        if (!j) return [];
        const sides = r.at.map((a) => j.foreignKeys.find((f) => f.name === a.foreignKey)!).filter(Boolean);
        const out: ResourceView['many'] = [];
        for (const [mine, other] of [[sides[0], sides[1]], [sides[1], sides[0]]] as const) {
          if (mine?.references.table === t.name && other) {
            out.push({ other: other.references.table, junction: j.name, here: mine.columns[0]!, there: other.columns[0]! });
          }
        }
        return out;
      }),
      fields: fieldViews,
      fieldOrder,
      ordered: chosen.length > 0,
      related: links
        .filter((r) => r.from === t.name || r.to === t.name)
        .map((r) => ({ line: r.line, kind: r.kind, other: r.from === t.name ? r.to : r.from })),
      note: NOTES[kind],
    };
  });
}

// A stored order, read the way everything stored is: anything unreadable is
// "no order", never an error on her page.
export function readOrder(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

// O8: the whole order, as the page sends it. Every name a field of this table
// or one of its many-to-manys, none twice. An empty list means "the table's
// own order again".
export function checkOrder(view: ResourceView, body: unknown): string[] {
  const order = ((body ?? {}) as Record<string, unknown>).order;
  if (!Array.isArray(order) || order.length > 500) throw new AccountError('The panel could not read that order.', 400);
  const known = new Set(view.fieldOrder);
  const seen = new Set<string>();
  for (const n of order) {
    if (typeof n !== 'string' || !known.has(n)) throw new AccountError(`${String(n)} is not one of the fields of ${view.plural}.`, 400);
    if (seen.has(n)) throw new AccountError(`${n} is in that order twice.`, 400);
    seen.add(n);
  }
  return order as string[];
}

// ------------------------------------------------------------------ what arrives from the browser

const text = (v: unknown, max: number): string | undefined =>
  (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

export type ResourcePatch = Partial<{
  enabled: boolean; singular: string; plural: string; icon: string; description: string;
  titleField: string; sortField: string; sortDir: 'asc' | 'desc';
  can: Partial<Record<Ability, boolean>>;
  onDelete: 'follow' | 'confirm';
  publicRead: boolean;
  publicOnly: string;
  visitorArea: number | null;
  visitorOwner: string;
}>;

export function checkResourcePatch(body: unknown): ResourcePatch {
  const o = (body ?? {}) as Record<string, unknown>;
  const out: ResourcePatch = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  for (const k of ['singular', 'plural', 'icon', 'description'] as const) {
    const v = text(o[k], k === 'description' ? 300 : 60);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['titleField', 'sortField'] as const) {
    const v = o[k];
    if (v === '' || v === null) out[k] = '';
    else if (typeof v === 'string') {
      if (!NAME_RE.test(v)) throw new AccountError('The panel could not tell which field you meant.', 400);
      out[k] = v;
    }
  }
  if (o.sortDir === 'asc' || o.sortDir === 'desc') out.sortDir = o.sortDir;
  if (o.onDelete === 'follow' || o.onDelete === 'confirm') out.onDelete = o.onDelete;
  if (typeof o.publicRead === 'boolean') out.publicRead = o.publicRead;
  if (o.publicOnly === '' || o.publicOnly === null) out.publicOnly = '';
  else if (typeof o.publicOnly === 'string') {
    if (!NAME_RE.test(o.publicOnly)) throw new AccountError('The panel could not tell which field you meant.', 400);
    out.publicOnly = o.publicOnly;
  }
  if (o.visitorArea === null || o.visitorArea === 0) out.visitorArea = null;
  else if (o.visitorArea !== undefined) {
    const id = Number(o.visitorArea);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AccountError('The panel could not tell which folder you meant.', 400);
    out.visitorArea = id;
  }
  if (o.visitorOwner === '' || o.visitorOwner === null) out.visitorOwner = '';
  else if (typeof o.visitorOwner === 'string') {
    if (!NAME_RE.test(o.visitorOwner)) throw new AccountError('The panel could not tell which field you meant.', 400);
    out.visitorOwner = o.visitorOwner;
  }
  if (o.can && typeof o.can === 'object') {
    const can: Partial<Record<Ability, boolean>> = {};
    for (const [k, v] of Object.entries(o.can as Record<string, unknown>)) {
      if (isAbility(k) && typeof v === 'boolean') can[k] = v;
    }
    if (Object.keys(can).length) out.can = can;
  }
  return out;
}

// The fixed rule has to be a yes/no field the window shows: a rule on a hidden
// field would publish rows by something nobody reading them can see.
export function checkPublicOnly(view: ResourceView, patch: ResourcePatch): void {
  if (!patch.publicOnly) return;
  const f = view.fields.find((x) => x.name === patch.publicOnly);
  if (!f || f.type !== 'boolean') {
    throw new AccountError('Only a yes/no field can decide which records anyone may read.', 400);
  }
  if (!f.exposed) throw new AccountError(`${f.label} is hidden, so it cannot decide which records anyone may read. Show it first.`, 400);
}

// V2: the field that says whose a row is holds a username, so it is text.
export const OWNER_TYPES: string[] = ['short_text', 'text'];

// "People signed in to a folder" (docs/tutorials-plan.md V1, V2), checked
// against what the thing would be after the change.
export function checkVisitors(view: ResourceView, patch: ResourcePatch): void {
  const owner = patch.visitorOwner !== undefined ? patch.visitorOwner || null : view.visitorOwner;
  const area = patch.visitorArea !== undefined ? patch.visitorArea : view.visitorArea;
  const publicRead = patch.publicRead ?? view.publicRead;
  if (patch.visitorOwner) {
    const f = view.fields.find((x) => x.name === patch.visitorOwner);
    if (!f || !OWNER_TYPES.includes(f.type)) throw new AccountError('Only a text field can say whose each one is.', 400);
    if (f.primaryKey) throw new AccountError('The field a record is known by cannot also say whose it is.', 400);
    if (!f.exposed) throw new AccountError(`${f.label} is hidden, so it cannot say whose each one is. Show it first.`, 400);
  }
  // "each only their own" and "anyone can read all of them" can't both be true
  if (area && owner && publicRead) {
    throw new AccountError(`Anyone can read ${view.plural.toLowerCase()}, so they can't also be private to each person. Turn one of the two off first.`, 400);
  }
}

export type FieldPatch = Partial<{
  exposed: boolean; label: string; help: string; control: Control;
  showInList: boolean; searchable: boolean; filterable: boolean;
}>;

export function checkFieldPatch(body: unknown): FieldPatch {
  const o = (body ?? {}) as Record<string, unknown>;
  const out: FieldPatch = {};
  for (const k of ['exposed', 'showInList', 'searchable', 'filterable'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  const label = text(o.label, 60);
  if (label !== undefined) out.label = label;
  const help = text(o.help, 300);
  if (help !== undefined) out.help = help;
  if (isControl(o.control)) out.control = o.control;
  return out;
}

// A window she cannot see through is not a window. Hiding the field a record is
// named by, or the last thing in the list, would leave her a page of blanks --
// so the refusal happens here, in her words, rather than showing her one.
export function refuseIfBlind(view: ResourceView, field: string, patch: FieldPatch): void {
  if (patch.exposed === false) {
    // the primary key is not part of the window anyway -- the API always has it
    // as `id` (§11.1) -- so hiding it costs her nothing and is allowed
    if (view.fields.find((f) => f.name === field)?.primaryKey) return;
    if (view.publicOnly === field) {
      throw new AccountError(
        `Only ${view.plural.toLowerCase()} where ${field} is yes can be read by anyone, so hiding it would hide the rule. Change "Anyone can read these" first.`, 400);
    }
    if (view.visitorArea && view.visitorOwner === field) {
      throw new AccountError(
        `Each person only sees the ${view.plural.toLowerCase()} with their name in ${field}, so hiding it would hide the rule. Change "People signed in to a folder" first.`, 400);
    }
    if (view.titleField === field) {
      throw new AccountError(
        `${view.singular} records are named by ${field}, so hiding it would leave a list of blanks. Choose another field to name them by first.`, 400);
    }
    const left = view.fields.filter((f) => f.exposed && f.name !== field && !f.primaryKey);
    if (left.length === 0) {
      throw new AccountError(`That is the last field ${view.plural} would show. Leave at least one.`, 400);
    }
  }
  if (patch.control === 'rich') {
    const f = view.fields.find((x) => x.name === field);
    if (f && !canBeRich(f)) throw new AccountError('Only long text can hold formatting. This field cannot be rich text.', 400);
  }
  if (patch.searchable === true || patch.filterable === true) {
    const f = view.fields.find((x) => x.name === field);
    if (f && !f.exposed) {
      throw new AccountError('A field that is hidden cannot be searched or filtered. Show it first.', 400);
    }
  }
}
