// The record picker (docs/record-picker-plan.md): choosing the recipe an
// ingredient belongs to -- or a recipe's tags -- by what it is, not by its id.
//
// One box, top to bottom: what is chosen (a chip, or several), a search box,
// the filters in force, and the list itself, joined underneath, a fixed height
// and scrolling, twenty at a time as she scrolls. Every row shows the other
// record's name and the fields she ticked "In the list" for it, so two lemon
// cakes can be told apart.
//
// It reads through /api/app/.../pick/<field>, which applies the other table's
// own window: nothing hidden there is searched, filtered or shown here.
import { Check, ExternalLink, Filter as FilterIcon, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { api } from '@panel/core/web/lib/api';
import {
  cellOf, namesOf, type Connections, type Label, type Links, type RecordRow, type Resource,
} from '../lib/schema';
import { cn } from '@panel/core/web/lib/utils';

type PickData = {
  resource: Resource;
  items: RecordRow[];
  total: number;
  filterable: string[];
  connections: Connections;
  links: Links[];
};

// A filter as the panel takes it (src/pammydb/rows.ts Filter), and the words on its chip.
type RowFilter =
  | { kind: 'equals'; column: string; value: string | number | boolean | null }
  | { kind: 'contains'; column: string; text: string }
  | { kind: 'range'; column: string; from: string | number | null; to: string | number | null };
export type Chip = { filter: RowFilter; words: string };

type Props = {
  engine: string;
  name: string;
  // the table whose field this is, and the field: a connection's column, or a
  // many-to-many's name
  table: string;
  field: string;
  id: string;
  // what she is choosing, in her words ("recipe", "tags"), for the screen reader and the empty list
  noun: string;
  many?: boolean;
  value: Label | null | Label[];
  onChange: (next: Label | null | Label[]) => void;
  // a connection that may be left empty gets a ✕
  clearable?: boolean;
  // inside a filter: a shorter list
  compact?: boolean;
};

const PAGE_WAIT = 250;

export function RecordPicker(p: Props) {
  const listId = useId();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [items, setItems] = useState<RecordRow[]>([]);
  const [links, setLinks] = useState<Links[]>([]);
  const [meta, setMeta] = useState<Omit<PickData, 'items' | 'links' | 'total'> | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [adding, setAdding] = useState(false);
  const asked = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const chosen: Label[] = p.many ? (p.value as Label[]) : p.value ? [p.value as Label] : [];
  const isChosen = (id: unknown) => chosen.some((c) => String(c.id) === String(id));

  // what she types waits a moment, so a word is one request, not five
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), PAGE_WAIT);
    return () => clearTimeout(t);
  }, [typed]);

  const load = useCallback(async (n: number) => {
    const mine = ++asked.current;
    setLoading(true);
    const q = new URLSearchParams({ page: String(n) });
    if (search) q.set('search', search);
    if (chips.length) q.set('filters', JSON.stringify(chips.map((c) => c.filter)));
    try {
      const d = await api<PickData>(`/api/app/${p.engine}/${p.name}/${p.table}/pick/${p.field}?${q}`);
      if (mine !== asked.current) return;          // a newer search has been asked for
      const { items: got, links: gotLinks, total: all, ...rest } = d;
      setMeta(rest);
      setTotal(all);
      setPage(n);
      setItems((prev) => (n === 1 ? got : [...prev, ...got]));
      setLinks((prev) => (n === 1 ? gotLinks : [...prev, ...gotLinks]));
      setProblem(null);
    } catch (e) {
      if (mine === asked.current) setProblem(e instanceof Error ? e.message : 'The list could not be read just now.');
    } finally {
      if (mine === asked.current) setLoading(false);
    }
  }, [p.engine, p.name, p.table, p.field, search, chips]);

  // a new search or filter starts the list again from the top
  useEffect(() => {
    setActive(-1);
    listRef.current?.scrollTo({ top: 0 });
    void load(1);
  }, [load]);

  const more = () => { if (!loading && items.length < total) void load(page + 1); };

  const r = meta?.resource;
  const key = r?.fields.find((f) => f.primaryKey)?.name ?? 'id';
  const labelOf = (row: RecordRow) => {
    const t = r?.titleField;
    const v = t ? row[t] : null;
    return v === null || v === undefined || v === '' ? String(row[key]) : String(v);
  };
  // what tells two records apart: the fields she ticked "In the list" (R4),
  // then its many-to-many names -- up to four, two on a phone
  const factsOf = (row: RecordRow, i: number): string[] => {
    if (!r || !meta) return [];
    const shown = r.fields.filter((f) => f.exposed && f.showInList && !f.primaryKey && f.name !== r.titleField);
    // each in words that say what it is: "Vegetarian" rather than "Yes",
    // "Servings: 4" rather than "4"; a connection by its name
    const facts = shown.flatMap((f) => {
      const v = row[f.name];
      if (f.control === 'tick') return v === true || v === 1 || v === '1' || v === 'true' ? [f.label] : [];
      const said = cellOf(f, row, links[i], meta.connections);
      if (!said || said === '—') return [];
      return f.control === 'number' || f.control === 'date' || f.control === 'time' || f.control === 'moment' ? [`${f.label}: ${said}`] : [said];
    });
    const many = meta.connections.many.map((m) => namesOf(links[i]?.[m.name] as Label[] | undefined)).filter((x) => x !== '—');
    return [...facts, ...many].slice(0, 4);
  };

  const pick = (row: RecordRow) => {
    const l: Label = { id: row[key], label: labelOf(row) };
    if (p.many) {
      const list = p.value as Label[];
      p.onChange(isChosen(l.id) ? list.filter((c) => String(c.id) !== String(l.id)) : [...list, l]);
    } else {
      p.onChange(l);
    }
  };
  const unpick = (l: Label) => {
    if (p.many) p.onChange((p.value as Label[]).filter((c) => String(c.id) !== String(l.id)));
    else p.onChange(null);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(items.length - 1, active + 1);
      setActive(next);
      if (next >= items.length - 3) more();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (e.key === 'Enter') {
      // Enter picks; it never sends the whole form from inside the list
      e.preventDefault();
      if (active >= 0 && items[active]) pick(items[active]!);
    } else if (e.key === 'Escape' && typed) {
      e.preventDefault();
      setTyped('');
    }
  };

  // keep the row the keyboard is on in sight
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-n="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const optionId = (n: number) => `${listId}-o${n}`;
  const other = r?.plural ?? p.noun;

  return (
    <div className="overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/40">
      {/* what is chosen */}
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-2 py-2" aria-label={`Chosen ${p.noun}`}>
          {chosen.map((c) => (
            <span key={String(c.id)} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-sm font-medium text-primary">
              <span className="truncate">{c.label}</span>
              {(p.many || p.clearable) && (
                <button type="button" className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-primary/20"
                  aria-label={`Take ${c.label} off`} onClick={() => unpick(c)}>
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* the search box, and the filters */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Input id={p.id} value={typed} autoComplete="off" spellCheck={false}
          className="h-8 border-0 px-1 shadow-none focus-visible:ring-0"
          placeholder={`Search ${other.toLowerCase()}…`}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onChange={(e) => setTyped(e.target.value)} onKeyDown={onKey} />
        {meta && meta.filterable.length > 0 && !p.compact && (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-expanded={adding}
            onClick={() => setAdding((x) => !x)}>
            <FilterIcon />Filter by field
          </Button>
        )}
      </div>
      {(chips.length > 0 || adding) && (
        <div className="space-y-2 border-b border-border bg-muted/30 px-2 py-2">
          <FilterChips chips={chips} onChange={setChips} />
          {adding && r && meta && (
            <FilterEditor engine={p.engine} name={p.name} resource={r} filterable={meta.filterable}
              onAdd={(c) => { setChips((x) => [...x, c]); setAdding(false); }} onCancel={() => setAdding(false)} />
          )}
        </div>
      )}

      {/* the list, joined to the box, a fixed height, scrolling */}
      <ul id={listId} ref={listRef} role="listbox" aria-label={`Choose ${p.many ? '' : 'a '}${p.noun}`}
        aria-multiselectable={p.many ? 'true' : undefined}
        className={cn('overflow-y-auto overscroll-contain', p.compact ? 'max-h-40' : 'h-64')}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) more();
        }}>
        {items.map((row, i) => {
          const on = isChosen(row[key]);
          const facts = factsOf(row, i);
          return (
            <li key={String(row[key])} id={optionId(i)} data-n={i} role="option" aria-selected={on}
              className={cn('flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0',
                i === active && 'bg-accent', on && 'bg-primary/5')}
              onMouseDown={(e) => e.preventDefault()}        // keep the focus in the search box
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(row)}>
              <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm', p.many && 'border border-input', on && 'text-primary')}>
                {on && <Check className="size-4" aria-hidden />}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{labelOf(row)}</span>
                {facts.length > 0 && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {facts.map((f, n) => (
                      <span key={n} className={cn(n >= 2 && 'hidden sm:inline')}>{n > 0 && ' · '}{f}</span>
                    ))}
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {problem && <li className="px-3 py-3 text-sm text-destructive">{problem}</li>}
        {!problem && !loading && items.length === 0 && (
          <li className="px-3 py-3 text-sm text-muted-foreground">
            {search || chips.length ? `No ${other.toLowerCase()} match that.` : `No ${other.toLowerCase()} yet.`}{' '}
            <a className="inline-flex items-center gap-1 underline" target="_blank" rel="noreferrer noopener"
              href={`/app/${p.engine}/${p.name}/${r?.table ?? ''}/new`}>
              Add one on the {other} page<ExternalLink className="size-3" aria-hidden />
            </a>
          </li>
        )}
        {loading && <li className="px-3 py-2 text-xs text-muted-foreground" aria-live="polite">Loading…</li>}
      </ul>
      {!p.compact && (
        <p className="flex flex-wrap justify-between gap-2 border-t border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">
          <span>{total === 1 ? '1 of them' : `${total} of them`}{search || chips.length ? ' match' : ''}</span>
          <a className="inline-flex items-center gap-1 hover:underline" target="_blank" rel="noreferrer noopener"
            href={`/app/${p.engine}/${p.name}/${r?.table ?? ''}/new`}>
            Not there? Add one<ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
      )}
    </div>
  );
}

// The filters in force, as chips she can take off one by one.
export function FilterChips({ chips, onChange }: { chips: Chip[]; onChange: (next: Chip[]) => void }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Filters">
      {chips.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-background py-0.5 pl-2.5 pr-1 text-xs">
          {c.words}
          <button type="button" className="grid size-5 place-items-center rounded-full hover:bg-accent"
            aria-label={`Remove the filter ${c.words}`} onClick={() => onChange(chips.filter((_, n) => n !== i))}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

// "Filter by field": which field, then a value that fits it (R5). Used by the
// picker and by the app's own lists (docs/record-picker-plan.md Q1).
export function FilterEditor({ engine, name, resource, filterable, onAdd, onCancel }: {
  engine: string; name: string; resource: Resource; filterable: string[];
  onAdd: (c: Chip) => void; onCancel: () => void;
}) {
  const fields = resource.fields.filter((f) => filterable.includes(f.name));
  const [column, setColumn] = useState(fields[0]?.name ?? '');
  const f = fields.find((x) => x.name === column);
  const [yes, setYes] = useState('yes');
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<Label | null>(null);
  useEffect(() => { setText(''); setFrom(''); setTo(''); setPicked(null); setYes('yes'); }, [column]);
  if (!f) return null;

  const inputType = f.control === 'number' ? 'number' : f.control === 'date' ? 'date' : f.control === 'time' ? 'time' : 'datetime-local';
  const num = (v: string) => (f.control === 'number' ? (v === '' ? null : Number(v)) : v === '' ? null : v);

  const chip = (): Chip | null => {
    switch (f.control) {
      case 'tick':
        return { filter: { kind: 'equals', column, value: yes === 'yes' }, words: `${f.label}: ${yes}` };
      case 'picker':
        return picked ? { filter: { kind: 'equals', column, value: picked.id as string | number }, words: `${f.label}: ${picked.label}` } : null;
      case 'line':
        return text.trim() ? { filter: { kind: 'contains', column, text: text.trim() }, words: `${f.label} has “${text.trim()}”` } : null;
      default:
        if (!from && !to) return null;
        return {
          filter: { kind: 'range', column, from: num(from), to: num(to) },
          words: `${f.label}: ${from && to ? `${from} to ${to}` : from ? `${from} or more` : `up to ${to}`}`,
        };
    }
  };
  const ready = chip();

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-start">
      <NativeSelect aria-label="Which field" value={column} onChange={(e) => setColumn(e.target.value)}>
        {fields.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
      </NativeSelect>
      <div className="min-w-0">
        {f.control === 'tick' && (
          <NativeSelect aria-label={f.label} value={yes} onChange={(e) => setYes(e.target.value)}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </NativeSelect>
        )}
        {f.control === 'picker' && f.reference && (
          <RecordPicker compact engine={engine} name={name} table={resource.table} field={f.name}
            id={`filter-${f.name}`} noun={f.label.toLowerCase()} value={picked}
            onChange={(v) => setPicked(v as Label | null)} clearable />
        )}
        {f.control === 'line' && (
          <Input aria-label={`${f.label} has`} placeholder="has these letters…" value={text} onChange={(e) => setText(e.target.value)} />
        )}
        {['number', 'date', 'time', 'moment'].includes(f.control) && (
          <div className="flex items-center gap-2">
            <Input aria-label={`${f.label} from`} type={inputType} value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input aria-label={`${f.label} to`} type={inputType} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
      </div>
      <div className="flex gap-1.5">
        <Button type="button" size="sm" disabled={!ready} onClick={() => ready && onAdd(ready)}><Plus />Add</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

