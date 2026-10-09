// The ResourceForm: one generic form for one record, create or change
// (docs/databases-plan.md 11.2). Like the DataViewer it is configured only by
// the Resource, and it never decides what is safe -- the panel has already
// reduced the record to the window, and refuses a write to anything outside it.
import { ArrowLeft, Save } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Field, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { RecordPicker } from '../components/record-picker';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { Textarea } from '@panel/core/web/components/ui/textarea';
import { useAction } from '@panel/core/web/hooks/useAction';
import { notify } from '@panel/core/web/lib/status';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { W } from '@panel/core/web/lib/site';
import type { Connections, DatabaseEngine, Label, LabelNames, Links, RecordData, RecordRow, Resource, ResourceField } from '../lib/schema';
import { RecordTags } from '../components/record-tags';

// What a field starts out as on a new record: empty, except a tick box, which
// is a no rather than a nothing.
const blank = (f: ResourceField): unknown => (f.control === 'tick' ? false : '');

// The rich-text editor is big, so it is only fetched for a form that has a
// rich-text field (docs/rich-text-plan.md T28).
const RichTextEditor = lazy(() => import('../components/rich-text').then((m) => ({ default: m.RichTextEditor })));

const asInput = (v: unknown, f: ResourceField): unknown => {
  // a tick box is a yes or a no, however the engine said it (true, 1, 't'):
  // turned into text it would never match "on", and saving would untick it
  if (f.control === 'tick') return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
  if (v === null || v === undefined) return '';
  if (f.control === 'moment') {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16);
  }
  if (f.control === 'date') return String(v).slice(0, 10);
  return String(v);
};

export default function AppRecord({ mode }: { mode: 'create' | 'edit' }) {
  const { engine, name, table } = useParams<{ engine: DatabaseEngine; name: string; table: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const run = useAction();

  const base = `/api/app/${engine}/${name}/${table}`;
  const where = Object.fromEntries(params.entries());
  const list = `/app/${engine}/${name}/${table}`;
  // create needs the Resource but no record, so it reads the empty list page
  const data = useApi<RecordData | { resource: Resource }>(
    mode === 'edit' ? `${base}/one?${params.toString()}` : `${base}?page=1`);

  const d = data.data as { resource?: Resource; row?: RecordRow; connections?: Connections; links?: Links; labels?: LabelNames } | undefined;
  const conn = d?.connections;
  const r = d?.resource;
  usePageTitle(r ? (mode === 'create' ? `New ${r.singular}` : r.singular) : 'Record');

  // The fields she fills in: what is exposed, in the order she put them, minus
  // the key (the engine fills that in, and changing it later would make "this
  // record" mean something else).
  const fields = (r?.fields ?? []).filter((f) => f.exposed && !f.primaryKey);
  // the form, in her order: a field by its name, a many-to-many as many:<table>;
  // anything the order does not name (an older answer) goes at the end
  type Item = { kind: 'field'; f: ResourceField } | { kind: 'many'; m: Connections['many'][number] };
  const ordered: Item[] = (() => {
    const order = r?.fieldOrder ?? [];
    const items: { at: number; item: Item }[] = [
      ...fields.map((f) => ({ at: order.indexOf(f.name), item: { kind: 'field' as const, f } })),
      ...(conn?.many ?? []).map((m) => ({ at: order.indexOf(`many:${m.table}`), item: { kind: 'many' as const, m } })),
    ];
    const last = order.length;
    return items.map((x, i) => ({ ...x, at: x.at === -1 ? last + i : x.at })).sort((a, b) => a.at - b.at).map((x) => x.item);
  })();
  const [values, setValues] = useState<Record<string, unknown>>({});
  // what a connection field shows: the chosen record's name, never its id
  // (docs/record-picker-plan.md), and each many-to-many's choices
  const [chosen, setChosen] = useState<Record<string, Label | null>>({});
  const [many, setMany] = useState<Record<string, Label[]>>({});
  useEffect(() => {
    if (!r) return;
    setValues(Object.fromEntries(fields.map((f) =>
      [f.name, mode === 'edit' && d?.row ? asInput(d.row[f.name], f) : blank(f)])));
    const links = mode === 'edit' ? d?.links ?? {} : {};
    setChosen(Object.fromEntries((conn?.refs ?? []).map((x) => [x.column, (links[x.name] as Label | null | undefined) ?? null])));
    setMany(Object.fromEntries((conn?.many ?? []).map((m) => [m.name, (links[m.name] as Label[] | undefined) ?? []])));
  }, [r?.table, mode, d && 'row' in d ? JSON.stringify(d.row) : '', JSON.stringify(d?.links ?? null)]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!r) return;
    // a many-to-many is saved with the record, all of its choices at once
    const links = Object.fromEntries(Object.entries(many).map(([k, ls]) => [k, ls.map((l) => l.id)]));
    const withLinks = Object.keys(links).length ? { links } : {};
    const body = mode === 'create'
      ? { values, ...withLinks }
      : { where, values, ...withLinks };
    const done = await run(() => api<{ row: RecordRow }>(`${base}/${mode === 'create' ? 'new' : 'save'}`, body));
    if (!done) return;
    // kept through the move to the list, or the shell clears it on arrival and
    // whether she sees it depends on which of the two happens first
    notify(mode === 'create' ? `${r.singular} added.` : 'Saved.', 'ok', true);
    void navigate(list);
  };

  const control = (f: ResourceField) => {
    const v = values[f.name];
    const set = (next: unknown) => setValues((p) => ({ ...p, [f.name]: next }));
    switch (f.control) {
      case 'tick':
        return <Switch checked={v === true} onCheckedChange={set} aria-label={f.label} id={`f-${f.name}`} />;
      case 'paragraph':
        return <Textarea id={`f-${f.name}`} rows={6} value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
      case 'rich':
        // what the panel sent is already clean HTML (writing from before the
        // field was rich text arrives as paragraphs); what she writes is
        // cleaned again when it is saved
        return (
          // the stand-in is not labelled as the field: nothing should mistake it for the editor
          <Suspense fallback={<Textarea rows={6} disabled value="Opening the editor…" readOnly aria-label="Opening the editor" />}>
            <RichTextEditor id={`f-${f.name}`} label={f.label} value={String(v ?? '')} onChange={set} />
          </Suspense>
        );
      case 'number':
        return <Input id={`f-${f.name}`} type="number" value={String(v ?? '')}
          onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} />;
      case 'date':
        return <Input id={`f-${f.name}`} type="date" value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
      case 'time':
        return <Input id={`f-${f.name}`} type="time" value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
      case 'moment':
        return <Input id={`f-${f.name}`} type="datetime-local" value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
      case 'text':
        // a kind the panel does not offer: shown, and left exactly as it is
        return <Input id={`f-${f.name}`} value={String(v ?? '')} disabled readOnly />;
      case 'picker': {
        // a connection to a table this app shows: pick it by what it is. To
        // one it does not show, the raw reference, and the hint says why.
        const ref = conn?.refs.find((x) => x.column === f.name);
        if (!ref || !engine || !name || !table) return <Input id={`f-${f.name}`} value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
        return (
          <RecordPicker engine={engine} name={name} table={table} field={f.name} id={`f-${f.name}`}
            noun={ref.plural.toLowerCase()} value={chosen[f.name] ?? null} clearable={!f.required}
            onChange={(next) => {
              const l = next as Label | null;
              setChosen((c) => ({ ...c, [f.name]: l }));
              set(l ? l.id : '');
            }} />
        );
      }
      default:
        return <Input id={`f-${f.name}`} value={String(v ?? '')} onChange={(e) => set(e.target.value)} />;
    }
  };

  const hint = (f: ResourceField): string | undefined => {
    if (f.help) return f.help;
    if (f.control === 'text') return `Kept as ${f.storedAs}, which the panel does not offer to change.`;
    if (f.control === 'picker') {
      const ref = conn?.refs.find((x) => x.column === f.name);
      return ref
        ? `Search, or filter by field, and pick one of the ${ref.plural.toLowerCase()}.`
        : `Which ${f.reference} this belongs to, by its id. Press “Manage this” for ${f.reference} on the ${W.app.one}'s page to pick it by name instead.`;
    }
    return undefined;
  };

  return (
    <Page title={r ? (mode === 'create' ? `New ${r.singular}` : `Change this ${r.singular}`) : ''}
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}/app`}>the {W.app.one}</InlineLink>{' · '}
        <InlineLink to={list}>{r?.plural ?? table}</InlineLink>
      </>}
      actions={<Button variant="outline" asChild><Link to={list}><ArrowLeft />Back to the list</Link></Button>}>

      {!r ? <Loading /> : (
        <Section title={mode === 'create' ? 'What goes in it' : 'What is in it'}>
          <form className="space-y-4" onSubmit={save}>
            {fields.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Every field of this one is hidden, so there is nothing to fill in.
              </p>
            )}
            {/* in the order she chose (docs/field-order-plan.md): her fields and
                each many-to-many -- a recipe's tags, chosen here and saved with it (R6) */}
            {ordered.map((item) => item.kind === 'field' ? (
              <Field key={item.f.name} label={item.f.label} htmlFor={`f-${item.f.name}`} hint={hint(item.f)}>
                {control(item.f)}
              </Field>
            ) : engine && name && table && (
              <Field key={item.m.name} label={item.m.plural} htmlFor={`m-${item.m.name}`}
                hint={`Pick as many ${item.m.plural.toLowerCase()} as you like; click one again to take it off.`}>
                <RecordPicker many engine={engine} name={name} table={table} field={item.m.name} id={`m-${item.m.name}`}
                  noun={item.m.plural.toLowerCase()} value={many[item.m.name] ?? []}
                  onChange={(next) => setMany((x) => ({ ...x, [item.m.name]: next as Label[] }))} />
              </Field>
            ))}
            {fields.length > 0 && (
              <div><Button type="submit"><Save />{mode === 'create' ? `Add this ${r.singular}` : 'Save the changes'}</Button></div>
            )}
          </form>
        </Section>
      )}
      {/* docs/catalog-plan.md step 4: with tags on for this table */}
      {r && mode === 'edit' && d?.labels && (
        <RecordTags base={base} tagsUrl={`/api/databases/${engine}/${name}/app/${table}/tags`} where={where} names={d.labels} singular={r.singular} />
      )}
    </Page>
  );
}
