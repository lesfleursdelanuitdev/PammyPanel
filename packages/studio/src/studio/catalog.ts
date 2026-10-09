// The catalog: what the panel tells the gate a database exposes
// (docs/studio-plan.md "catalog push").
//
// The gate cannot read the panel's tables, so it cannot work out for itself
// what a Resource means. The panel sends it a finished answer instead, and the
// gate serves exactly that. Three consequences, all deliberate:
//
//  * **No merge.** A push replaces the whole catalog for one database. There is
//    no way for a stale entry to survive a change she made.
//  * **The catalog is the window.** A column that is not in it does not exist
//    as far as the API is concerned -- the gate has no other list to consult.
//  * **Abilities travel with it**, so turning Delete off reaches the API at the
//    same moment it reaches the pages, without touching any key.
//
// Pure: building a catalog is a function of the Resource views.
import type { Ability, ResourceView } from './resources.ts';

export type CatalogResource = {
  // the address it answers on: her plural, lowercased and hyphenated
  slug: string;
  table: string;
  singular: string;
  plural: string;
  // exactly the columns the API may read or write
  columns: string[];
  // which of them say which record
  key: string[];
  titleField: string | null;
  searchable: string[];
  sortable: string[];
  can: Record<Ability, boolean>;
  // Added for docs/db-examples-plan.md. Optional when read, so a catalog pushed
  // by an older panel still serves -- as private, with no connections.
  //
  // yes/no fields: a filter on one compares as a yes/no, not as the text "true"
  // (on MariaDB a yes/no is a number, and 'true' = 1 is false)
  booleans?: string[];
  // X1/X12: anyone may read these without a key, only rows where `only` is yes
  public?: { only: string | null } | null;
  // X7: fields pointing at another resource here, answered as { id, label }
  refs?: { column: string; name: string; to: string }[];
  // X7: many-to-many through a connecting table, answered as [{ id, label }]
  many?: { name: string; junction: string; here: string; there: string; to: string }[];
  // docs/rich-text-plan.md T13: fields she marked "Rich text". The gate cleans
  // them on the way in and on the way out, and says which they are, so a page
  // knows which to show as HTML. Absent (an older catalog) = none.
  rich?: string[];
  // docs/form-to-database-plan.md: each column's kind, so the gate can check a
  // row a form writes against what the table holds. Absent (an older catalog)
  // = no form may write here.
  types?: Record<string, { type: string; length?: number; required: boolean; defaulted: boolean; rich?: boolean }>;
  // docs/tutorials-plan.md V1-V3: people signed in to this protected folder (the
  // gate's area id, so a rename keeps it) may do what `can` allows, with no key;
  // with `owner`, only ever to the rows where that field is their username.
  // Absent (an older catalog) = nobody without a key.
  visitors?: { area: number; owner: string | null } | null;
  // docs/catalog-plan.md step 4: she tags these in the panel, so the gate notes its
  // writes to them (gate.record_touches) for the panel to take. Absent = not tagged.
  tagged?: boolean;
};

export type Catalog = { resources: CatalogResource[] };

// `Blog Posts` -> `blog-posts`. The address a program uses, from her words
// rather than from the table name, because the API is the application layer.
export function slugOf(plural: string, table: string): string {
  const slug = plural.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z][a-z0-9-]*$/.test(slug) ? slug : table.replace(/_/g, '-');
}

// `decidedOnly: false` is for the panel's own pages, which show a table she has
// ticked into the app whether or not the gate has been told (the menu and the
// record routes work from `enabled`); the gate is always pushed decided ones.
export function buildCatalog(resources: ResourceView[], o: { decidedOnly?: boolean } = {}): Catalog {
  const decidedOnly = o.decidedOnly ?? true;
  const out: CatalogResource[] = [];
  const taken = new Set<string>();
  for (const r of resources) {
    // Only what she has SAID yes to. `enabled` alone is also inference's guess
    // for a table she has never looked at, and Activate writes her yes down for
    // everything it switches on -- so a table applied into a switched-on app
    // later is proposed on the Application tab, and not on the internet until
    // she ticks it (docs/databases-plan.md 16 PART 14; the menu, /api/apps,
    // already kept to this).
    if (!r.enabled || (decidedOnly && !r.decided)) continue;
    const key = r.fields.filter((f) => f.primaryKey).map((f) => f.name);
    // Without a key there is no honest way to say "this record", so it is left
    // out of the API rather than served with rows nothing can point at.
    if (key.length === 0) continue;
    let slug = slugOf(r.plural, r.table);
    // two things cannot answer on one address; the table name breaks the tie
    if (taken.has(slug)) slug = r.table.replace(/_/g, '-');
    if (taken.has(slug)) continue;
    taken.add(slug);
    out.push({
      slug,
      table: r.table,
      singular: r.singular,
      plural: r.plural,
      columns: r.fields.filter((f) => f.exposed || f.primaryKey).map((f) => f.name),
      key,
      titleField: r.titleField,
      searchable: r.fields.filter((f) => f.exposed && f.searchable).map((f) => f.name),
      sortable: r.fields.filter((f) => f.exposed || f.primaryKey).map((f) => f.name),
      can: r.can,
      booleans: r.fields.filter((f) => (f.exposed || f.primaryKey) && f.type === 'boolean').map((f) => f.name),
      public: r.publicRead ? { only: r.publicOnly } : null,
      visitors: r.visitorArea ? { area: r.visitorArea, owner: r.visitorOwner } : null,
      rich: r.fields.filter((f) => f.exposed && f.control === 'rich').map((f) => f.name),
      types: Object.fromEntries(r.fields.filter((f) => f.exposed || f.primaryKey).map((f) => [f.name, {
        type: f.type, ...(f.length ? { length: f.length } : {}), required: f.required, defaulted: f.defaulted,
        ...(f.control === 'rich' ? { rich: true } : {}),
      }])),
      refs: [],
      many: [],
      ...(r.tagged ? { tagged: true } : {}),
    });
  }
  // Connections, now that every resource has its address: only to another
  // resource in this catalog, and only under a name the answer is not using.
  const bySlugOfTable = new Map(out.map((c) => [c.table, c.slug]));
  for (const c of out) {
    const r = resources.find((x) => x.table === c.table)!;
    const used = new Set(c.columns);
    for (const f of r.fields) {
      const to = f.reference ? bySlugOfTable.get(f.reference) : undefined;
      if (!to || !c.columns.includes(f.name) || c.key.includes(f.name)) continue;
      const name = f.name.endsWith('_id') && f.name.length > 3 ? f.name.slice(0, -3) : `${f.name}_link`;
      if (used.has(name)) continue;
      used.add(name);
      c.refs!.push({ column: f.name, name, to });
    }
    for (const m of r.many) {
      const to = bySlugOfTable.get(m.other);
      const name = to?.replace(/-/g, '_');
      if (!to || !name || used.has(name)) continue;
      used.add(name);
      c.many!.push({ name, junction: m.junction, here: m.here, there: m.there, to });
    }
  }
  return { resources: out };
}

// Read back the way everything from outside is read. The gate stores what the
// panel sent, but a catalog written by an older panel must not take the API
// down -- an unreadable one means "this database exposes nothing", which is the
// safe answer rather than the convenient one.
export function readCatalog(json: string): Catalog {
  try {
    const v = JSON.parse(json) as { resources?: unknown };
    if (!Array.isArray(v.resources)) return { resources: [] };
    return { resources: v.resources.filter(isResource) };
  } catch {
    return { resources: [] };
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isResource(v: unknown): v is CatalogResource {
  const o = (v ?? {}) as Record<string, unknown>;
  return typeof o.slug === 'string' && typeof o.table === 'string'
    && strings(o.columns) && o.columns.length > 0
    && strings(o.key) && o.key.length > 0
    && strings(o.searchable) && strings(o.sortable)
    && !!o.can && typeof o.can === 'object';
}
