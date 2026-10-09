// The DataViewer: one generic collection page, configured only by the Resource
// (docs/databases-plan.md 11.7). It does not know what a recipe is.
//
// Everything it shows has already been reduced to the Resource's window by the
// panel (src/studio/records.ts), so this page can render whatever it is handed
// without deciding what is safe to show. The abilities work the same way: a
// button that is not here is also refused by the server if something asks
// anyway.
import { ArrowLeft, Filter as FilterIcon, LayoutGrid, Pencil, Plus, Rows3, Search, Trash2 } from 'lucide-react';
import { FilterChips, FilterEditor, type Chip } from '../components/record-picker';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { isOn, W } from '@panel/core/web/lib/site';
import {
  cellOf, namesOf, PAGE_SIZE, showValue,
  type DatabaseEngine, type Label, type LabelNames, type RecordRow, type RecordsData, type Resource, type TableTags,
} from '../lib/schema';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';

// Table or cards, remembered per Resource (11.7 "Remembered"). A phone starts
// on cards, where a wide table would be unreadable.
const viewKey = (engine: string, name: string, table: string) => `pammy.app.view.${engine}.${name}.${table}`;
const startView = (key: string): 'table' | 'grid' => {
  try {
    const kept = localStorage.getItem(key);
    if (kept === 'table' || kept === 'grid') return kept;
  } catch { /* a private window, or storage turned off */ }
  return window.matchMedia('(max-width: 640px)').matches ? 'grid' : 'table';
};

// What stands for a record in a list: the field she named them by, or the key.
const titleOf = (r: Resource, row: RecordRow): string => {
  const named = r.titleField ? row[r.titleField] : null;
  if (named !== null && named !== undefined && named !== '') return String(named);
  const key = r.fields.find((f) => f.primaryKey);
  return key ? `${r.singular} ${row[key.name]}` : r.singular;
};

const keyParams = (r: Resource, row: RecordRow): string =>
  r.fields.filter((f) => f.primaryKey)
    .map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(String(row[f.name] ?? ''))}`).join('&');

export default function AppRecords() {
  const { engine, name, table } = useParams<{ engine: DatabaseEngine; name: string; table: string }>();
  const [params, setParams] = useSearchParams();
  const run = useAction();
  const dialogs = useDialogs();

  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = params.get('search') ?? '';
  const sort = params.get('sort') ?? '';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';

  // typed straight away, sent a moment later: every trip is a real query
  const [typed, setTyped] = useState(search);
  useEffect(() => { setTyped(search); }, [search]);
  useEffect(() => {
    if (typed === search) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (typed) next.set('search', typed); else next.delete('search');
      next.delete('page');
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  // "Filter by field" (docs/record-picker-plan.md Q1): kept in the address, so
  // Back and a bookmark keep them
  const chips: Chip[] = (() => {
    try { const v = JSON.parse(params.get('filters') ?? '[]') as unknown; return Array.isArray(v) ? v as Chip[] : []; } catch { return []; }
  })();
  const [adding, setAdding] = useState(false);
  // docs/catalog-plan.md step 4: only the ones with this tag or category (its id)
  const labelAsked = params.get('label') ?? '';

  const query = new URLSearchParams();
  if (page > 1) query.set('page', String(page));
  if (search) query.set('search', search);
  if (chips.length) query.set('filters', JSON.stringify(chips.map((c) => c.filter)));
  if (sort) { query.set('sort', sort); query.set('dir', dir); }
  if (labelAsked) query.set('label', labelAsked);
  const base = `/api/app/${engine}/${name}/${table}`;
  const data = useApi<RecordsData>(`${base}${query.toString() ? `?${query}` : ''}`);
  const d = data.data;
  const r = d?.resource;
  usePageTitle(r?.plural ?? table ?? 'Records');
  // the labels to filter by, when this table has tags on
  const tags = useApi<TableTags>(isOn('catalog') && d?.labels ? `/api/databases/${engine}/${name}/app/${table}/tags` : null, { meta: { quiet: true } });
  const labelNames = (n: LabelNames | undefined) => (n ? [...n.categories, ...n.tags.map((t) => `#${t}`)].join(', ') || '—' : '—');

  const key = viewKey(engine ?? '', name ?? '', table ?? '');
  const [view, setView] = useState<'table' | 'grid'>(() => startView(key));
  const choose = (v: 'table' | 'grid') => {
    setView(v);
    try { localStorage.setItem(key, v); } catch { /* fine: it is only a preference */ }
  };

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    setParams(next);
  };

  const remove = async (row: RecordRow) => {
    if (!r) return;
    const ok = await dialogs.confirm({
      title: `Delete ${titleOf(r, row)}?`,
      body: r.onDelete === 'confirm'
        ? <>This cannot be undone. Anything connected to it may be affected — what the database does about that was settled when the connection was made.</>
        : 'This cannot be undone.',
      action: 'Delete it',
      danger: true,
    });
    if (!ok) return;
    const where = Object.fromEntries(r.fields.filter((f) => f.primaryKey).map((f) => [f.name, row[f.name]]));
    await run(() => api(`${base}/delete`, { where }), `${titleOf(r, row)} is gone.`);
  };

  const columns = r?.fields.filter((f) => f.exposed && f.showInList) ?? [];
  const setChips = (next: Chip[]) => go({ filters: next.length ? JSON.stringify(next) : null, page: null });
  // what her list may be filtered by: the fields she ticked "Filterable" on
  const filterable = r?.can.filter
    ? r.fields.filter((f) => f.exposed && f.filterable && !f.primaryKey && ['tick', 'picker', 'line', 'number', 'date', 'time', 'moment'].includes(f.control)).map((f) => f.name)
    : [];
  const from = ((d?.page ?? 1) - 1) * PAGE_SIZE + 1;
  const to = Math.min((d?.total ?? 0), from + (d?.items.length ?? 0) - 1);
  const pages = Math.max(1, Math.ceil((d?.total ?? 0) / PAGE_SIZE));

  const actions = (row: RecordRow) => (
    <div className="flex flex-wrap gap-2">
      {r?.can.edit && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/app/${engine}/${name}/${table}/edit?${keyParams(r, row)}`}><Pencil />Change</Link>
        </Button>
      )}
      {r?.can.delete && <Button variant="outline" size="sm" onClick={() => void remove(row)}><Trash2 />Delete</Button>}
    </div>
  );

  return (
    <Page title={r?.plural ?? table ?? ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}/app`}>the {W.app.one}</InlineLink>
        {r?.description ? ` · ${r.description}` : ''}
      </>}
      actions={r?.can.create
        ? <Button asChild><Link to={`/app/${engine}/${name}/${table}/new`}><Plus />New {r.singular}</Link></Button>
        : undefined}>

      {!d || !r ? <Loading /> : <>
        <Section flush
          title={search || chips.length || labelAsked ? `${d.total} of them match` : plural(d.total, r.singular.toLowerCase())}
          action={<div className="flex flex-wrap items-center gap-2">
            {d.labels && (tags.data?.labels ?? []).length > 0 && (
              <NativeSelect className="w-48" aria-label="Only the ones with this tag or category" value={labelAsked}
                onChange={(e) => go({ label: e.target.value || null, page: null })}>
                <option value="">Any tag or category</option>
                {(['category', 'tag'] as const).map((type) => (
                  <optgroup key={type} label={type === 'tag' ? 'Tags' : 'Categories'}>
                    {tags.data!.labels.filter((l) => l.type === type).map((l) => (
                      <option key={l.id} value={String(l.id)}>{type === 'tag' ? `#${l.name}` : l.name}{l.everywhere ? ' (everywhere)' : ''}</option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            )}
            {filterable.length > 0 && (
              <Button variant="outline" size="sm" aria-expanded={adding} onClick={() => setAdding((x) => !x)}>
                <FilterIcon />Filter by field
              </Button>
            )}
            {r.can.search && (
              <label className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
                <Input className="w-56 pl-8" placeholder={`Search ${r.plural.toLowerCase()}`}
                  aria-label={`Search ${r.plural}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <div className="flex rounded-md border border-border">
              <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" className="rounded-r-none"
                aria-label="Show a table" aria-pressed={view === 'table'} onClick={() => choose('table')}><Rows3 /></Button>
              <Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="sm" className="rounded-l-none"
                aria-label="Show cards" aria-pressed={view === 'grid'} onClick={() => choose('grid')}><LayoutGrid /></Button>
            </div>
          </div>}>

          {(chips.length > 0 || adding) && engine && name && (
            <div className="space-y-2 border-b border-border bg-muted/30 px-4 py-3">
              <FilterChips chips={chips} onChange={setChips} />
              {adding && (
                <FilterEditor engine={engine} name={name} resource={r} filterable={filterable}
                  onAdd={(c) => { setChips([...chips, c]); setAdding(false); }} onCancel={() => setAdding(false)} />
              )}
            </div>
          )}
          {d.items.length === 0 ? (
            <Empty>
              {labelAsked && !chips.length && !search ? <>None have that tag or category. <Button variant="link" className="px-1" onClick={() => go({ label: null, page: null })}>Show them all</Button></> : chips.length && !search ? <>Nothing matches those filters. <Button variant="link" className="px-1" onClick={() => setChips([])}>Clear them</Button></> : search
                ? <>Nothing matches “{search}”. <Button variant="link" className="px-1" onClick={() => go({ search: null, page: null })}>Clear the search</Button></>
                : `No ${r.plural.toLowerCase()} yet.`}
            </Empty>
          ) : view === 'table' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    {columns.map((f) => (
                      <th key={f.name} scope="col" className="px-4 py-2.5 font-medium">
                        {r.can.sort ? (
                          <button type="button" className="hover:underline"
                            onClick={() => go({ sort: f.name, dir: sort === f.name && dir === 'asc' ? 'desc' : 'asc', page: null })}>
                            {f.label}{sort === f.name ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                          </button>
                        ) : f.label}
                      </th>
                    ))}
                    {d.connections.many.map((m) => (
                      <th key={m.name} scope="col" className="px-4 py-2.5 font-medium">{m.plural}</th>
                    ))}
                    {d.labels && <th scope="col" className="px-4 py-2.5 font-medium">Tags &amp; categories</th>}
                    <th scope="col" className="px-4 py-2.5"><span className="sr-only">What you can do</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((row, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      {columns.map((f) => (
                        <td key={f.name} className="max-w-xs truncate px-4 py-2.5">{cellOf(f, row, d.links[i], d.connections)}</td>
                      ))}
                      {d.connections.many.map((m) => (
                        <td key={m.name} className="max-w-xs truncate px-4 py-2.5">{namesOf(d.links[i]?.[m.name] as Label[] | undefined)}</td>
                      ))}
                      {d.labels && <td className="max-w-xs truncate px-4 py-2.5">{labelNames(d.labels[i])}</td>}
                      <td className="px-4 py-2 text-right">{actions(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <List label={r.plural}>
              {d.items.map((row, i) => (
                <Row key={i} title={titleOf(r, row)}
                  meta={<Facts items={[
                    ...columns.filter((f) => f.name !== r.titleField)
                      .slice(0, 4).map((f) => `${f.label}: ${cellOf(f, row, d.links[i], d.connections)}`),
                    ...d.connections.many.map((m) => `${m.plural}: ${namesOf(d.links[i]?.[m.name] as Label[] | undefined)}`),
                    ...(d.labels ? [`Tags & categories: ${labelNames(d.labels[i])}`] : []),
                  ]} />}
                  actions={actions(row)} />
              ))}
            </List>
          )}
        </Section>

        {d.total > PAGE_SIZE && (
          <Section plain>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Showing {from}–{to} of {d.total}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1}
                  onClick={() => go({ page: String(page - 1) })}><ArrowLeft />Back</Button>
                <span aria-live="polite">Page {page} of {pages}</span>
                <Button variant="outline" size="sm" disabled={page >= pages}
                  onClick={() => go({ page: String(page + 1) })}>Next</Button>
              </div>
            </div>
          </Section>
        )}

        {!r.can.edit && !r.can.delete && (
          <Section plain>
            <p className="text-sm text-muted-foreground">
              <Badge variant="outline">look only</Badge>{' '}
              These are set up to be read here, not changed. You can change that on the {W.app.one}'s settings.
            </p>
          </Section>
        )}
      </>}
    </Page>
  );
}
