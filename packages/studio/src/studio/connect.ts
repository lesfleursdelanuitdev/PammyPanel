// A record's connections, as names rather than ids (docs/db-examples-plan.md X7,
// docs/record-picker-plan.md R11): a field pointing at another table becomes
// { id, label }, and a many-to-many a list of those, sorted by name.
//
// One way of working labels out, used by both the gate's data API and the
// panel's generated pages. Each says what it may read (`readable`) and adds
// any rule of its own (`rule`: the gate's "only where published is yes"); this
// file only asks, a page at a time -- one statement per connection per page,
// never one per row.
import type { Filter, RowPage, RowQuery, Scalar } from '../pammydb/rows.ts';
import type { CatalogResource } from './catalog.ts';

export type Label = { id: unknown; label: string };
export type Lister = (q: RowQuery) => Promise<RowPage>;

// What one record connects to: `{ cook: { id, label } | null, tags: [...] }`.
export type Links = Record<string, Label | null | Label[]>;

export async function labelsOf(list: Lister, target: CatalogResource, ids: Scalar[], rule: Filter[] = []): Promise<Map<string, Label>> {
  const out = new Map<string, Label>();
  const k = target.key[0]!;
  const title = target.titleField && target.columns.includes(target.titleField) ? target.titleField : null;
  const unique = [...new Set(ids.filter((x) => x !== null && x !== undefined).map(String))];
  for (let i = 0; i < unique.length; i += 200) {
    const got = await list({
      table: target.table, columns: title ? [k, title] : [k], limit: 200, offset: 0,
      order: { column: k, dir: 'asc' }, search: null,
      filters: [{ kind: 'in', column: k, values: unique.slice(i, i + 200) }, ...rule],
    });
    for (const it of got.items) out.set(String(it[k]), { id: it[k], label: title ? String(it[title] ?? '') : String(it[k]) });
  }
  return out;
}

// The links of each item, in the same order. A connection to a table the
// caller may not read is left out altogether -- not null, not an id.
export async function linksOf(o: {
  list: Lister;
  resource: CatalogResource;
  all: Map<string, CatalogResource>;
  readable: (t: CatalogResource) => boolean;
  rule?: (t: CatalogResource) => Filter[];
  items: Record<string, unknown>[];
}): Promise<Links[]> {
  const out: Links[] = o.items.map(() => ({}));
  if (!o.items.length) return out;
  const rule = o.rule ?? (() => []);
  const target = (slug: string) => {
    const t = o.all.get(slug);
    return t && t.key.length === 1 && o.readable(t) ? t : null;
  };
  for (const ref of o.resource.refs ?? []) {
    const t = target(ref.to);
    if (!t) continue;
    const labels = await labelsOf(o.list, t, o.items.map((i) => i[ref.column] as Scalar), rule(t));
    o.items.forEach((i, n) => {
      const v = i[ref.column];
      out[n]![ref.name] = v === null || v === undefined ? null : labels.get(String(v)) ?? null;
    });
  }
  if (o.resource.key.length !== 1) return out;
  const k = o.resource.key[0]!;
  for (const m of o.resource.many ?? []) {
    const t = target(m.to);
    if (!t) continue;
    const ids = [...new Set(o.items.map((i) => i[k]).filter((x) => x !== null && x !== undefined).map(String))];
    const pairs: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      // a page of 100 things with many connections each: read them all, in
      // pages, up to a limit no real page reaches
      for (let offset = 0; offset < 5000; offset += 200) {
        const got = await o.list({
          table: m.junction, columns: [m.here, m.there], limit: 200, offset,
          order: { column: m.there, dir: 'asc' }, search: null,
          filters: [{ kind: 'in', column: m.here, values: ids.slice(i, i + 200) }],
        });
        pairs.push(...got.items);
        if (got.items.length < 200) break;
      }
    }
    const labels = await labelsOf(o.list, t, pairs.map((p) => p[m.there] as Scalar), rule(t));
    o.items.forEach((item, n) => {
      out[n]![m.name] = pairs
        .filter((p) => String(p[m.here]) === String(item[k]))
        .map((p) => labels.get(String(p[m.there])))
        .filter((x): x is Label => !!x)
        .sort((a, b) => a.label.localeCompare(b.label));
    });
  }
  return out;
}
