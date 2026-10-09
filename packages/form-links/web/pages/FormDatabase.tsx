// "Save answers in a database" (docs/form-to-database-plan.md): a form of hers
// also puts each response into one of her tables. Pick the database and the
// table, pair each question with a field, give the rest fixed values, and
// choose when. The panel refuses a link that would leave a required field
// empty (F7); the response is always kept in Responses as well (F1).
import { ArrowLeft, Database, Save, Unplug } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Field, GuideLink, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, ApiError } from '@panel/core/web/lib/api';
import { W } from '@panel/core/web/lib/site';
import { notify } from '@panel/core/web/lib/status';

type Question = { key: string; label: string; type: string; required: boolean; parts?: string[] };
type Pair = { key: string; part?: string; field: string };
type Fixed = { field: string; value?: string | number | boolean | null; from?: 'sent-at' | 'page' | 'sender' };
type Link_ = { databaseId: number; engine: 'postgres' | 'mariadb'; name: string; table: string; when: 'approved' | 'arrived'; pairs: Pair[]; fixed: Fixed[]; enabled: boolean };
type State = {
  form: { id: number; name: string; title: string; approvable: boolean; autoApprove: boolean };
  questions: Question[];
  link: Link_ | null; saved: number; problems: string[]; notSaved: number; unsure: number;
  databases: { engine: 'postgres' | 'mariadb'; name: string; title: string; active: boolean }[];
};
type TableField = { name: string; label: string; type: string; storedAs: string; required: boolean };
type Table = { table: string; plural: string; singular: string; publicRead: boolean; fields: TableField[]; fits: Record<string, string[]>; suggested: Pair[] };

const PART_NAMES: Record<string, string> = {
  title: 'title', first: 'first name', middle: 'middle name', last: 'last name',
  line1: 'street', line2: 'second line', town: 'town', region: 'county', postcode: 'postcode', country: 'country',
};
// a pair's place in the select: "key" or "key.part"
const slot = (p: { key: string; part?: string }) => (p.part ? `${p.key}.${p.part}` : p.key);

export default function FormDatabase() {
  const { id } = useParams();
  const data = useApi<State>(`/api/forms/${id}/database`);
  usePageTitle('Save answers in a database');
  // an example's form, or one that is gone: say so rather than wait for ever
  if (data.error) return <Page title="Save answers in a database"><p className="text-sm text-muted-foreground">{data.error.message}</p></Page>;
  if (!data.data) return <Page title="Save answers in a database"><Loading /></Page>;
  return <Editor key={JSON.stringify(data.data.link)} s={data.data} />;
}

function Editor({ s }: { s: State }) {
  const run = useAction();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  const first = s.databases.find((d) => d.active);
  const [db, setDb] = useState(s.link ? `${s.link.engine}/${s.link.name}` : first ? `${first.engine}/${first.name}` : '');
  const tables = useApi<{ tables: Table[] }>(db ? `/api/forms/${s.form.id}/database/${db}` : null, { meta: { quiet: true } });
  const [table, setTable] = useState(s.link?.table ?? '');
  const [when, setWhen] = useState<'approved' | 'arrived'>(s.link?.when ?? (s.form.approvable ? 'approved' : 'arrived'));
  const [pairs, setPairs] = useState<Pair[]>(s.link?.pairs ?? []);
  const [fixed, setFixed] = useState<Fixed[]>(s.link?.fixed ?? []);
  const [enabled, setEnabled] = useState(s.link?.enabled ?? true);
  const t = tables.data?.tables.find((x) => x.table === table);

  // picking a table starts from the panel's guesses (which she changes)
  const pickTable = (name: string) => {
    setTable(name);
    const nt = tables.data?.tables.find((x) => x.table === name);
    setPairs(nt?.suggested ?? []);
    setFixed([]);
  };
  useEffect(() => {
    if (!table && tables.data?.tables.length === 1) pickTable(tables.data.tables[0]!.table);
  }, [tables.data]);

  // each question, and each part of a name or address, as one row
  const rows = useMemo(() => s.questions.flatMap((q) => (q.parts?.length
    ? [{ q, part: undefined as string | undefined }, ...q.parts.map((part) => ({ q, part }))]
    : [{ q, part: undefined as string | undefined }])), [s.questions]);
  const pairOf = (key: string, part?: string) => pairs.find((p) => p.key === key && p.part === part)?.field ?? '';
  const setPair = (key: string, part: string | undefined, field: string) => {
    const rest = pairs.filter((p) => !(p.key === key && p.part === part) && (field === '' || p.field !== field));
    setPairs(field ? [...rest, { key, ...(part ? { part } : {}), field }] : rest);
    if (field) setFixed((fx) => fx.filter((x) => x.field !== field));
  };
  const paired = new Set(pairs.map((p) => p.field));
  const unpaired = (t?.fields ?? []).filter((f) => !paired.has(f.name));
  const fixedOf = (field: string) => fixed.find((x) => x.field === field);
  const setFixedFor = (field: string, v: Fixed | null) => setFixed((fx) => [...fx.filter((x) => x.field !== field), ...(v ? [v] : [])]);
  const missing = unpaired.filter((f) => f.required && !fixedOf(f.name));

  const save = async (confirmPublic = false): Promise<void> => {
    const [engine, name] = db.split('/');
    try {
      await api(`/api/forms/${s.form.id}/database`, { engine, name, table, when, pairs, fixed, enabled, confirmPublic });
      notify(enabled ? `Saved. New answers now go into ${t?.plural ?? table} as well.` : 'Saved. Saving answers in the database is switched off.', 'ok');
      await qc.invalidateQueries();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm-public') {
        if (await dialogs.confirm({ title: 'Put private answers where anyone can read them?', body: e.message, action: 'Yes, save them there' })) return save(true);
        return;
      }
      notify(e instanceof Error ? e.message : 'That could not be saved.', 'error');
    }
  };
  const disconnect = async () => {
    if (!await dialogs.confirm({ title: 'Stop saving answers in the database?', action: 'Stop', danger: true,
      body: 'New answers will only go to Responses. What is already in the table stays there.' })) return;
    await run(() => api(`/api/forms/${s.form.id}/database/disconnect`, {}), 'The form no longer saves its answers in a database.');
  };
  const earlier = async () => {
    const r = await run(() => api<{ saved: number; problems: number }>(`/api/forms/${s.form.id}/database/earlier`, {}));
    if (r) notify(`${r.saved} earlier ${r.saved === 1 ? 'response' : 'responses'} saved${r.problems ? `; ${r.problems} could not be — Responses says why` : ''}.`, r.problems ? 'error' : 'ok');
  };

  return (
    <Page title="Save answers in a database"
      intro={<>The form <strong>{s.form.title}</strong> keeps every response in <InlineLink to="/responses">Responses</InlineLink>. Here it can also add each one to a table of yours, as a new record.<GuideLink topic="forms">How this works</GuideLink></>}
      actions={<Button variant="outline" asChild><Link to="/forms"><ArrowLeft />Forms</Link></Button>}>

      {s.link && (
        <Section title="Now"
          action={<Button variant="outline" size="sm" onClick={() => void disconnect()}><Unplug />Stop saving</Button>}>
          <p className="text-sm">
            {s.link.enabled ? <>Saves into <strong>{s.link.table}</strong> ({s.link.name}) {s.link.when === 'approved' ? 'when you approve a response' : 'as soon as a response arrives'}.</>
              : <>Connected to <strong>{s.link.table}</strong> ({s.link.name}), but switched off.</>}
            {' '}{s.saved} saved so far.
            {/* B3: a write the database took without answering. Nothing is tried
                again by itself, because a second try could make a second row. */}
            {s.unsure > 0 && <> {s.unsure} may or may not have been saved &mdash; Responses says which.</>}
          </p>
          {s.problems.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-destructive">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
          {s.link.enabled && s.notSaved > 0 && (
            <div className="mt-3">
              <Button variant="outline" onClick={() => void earlier()}>
                <Database />Save the earlier responses too{s.link.when === 'approved' ? ' (the approved ones)' : ''}
              </Button>
            </div>
          )}
        </Section>
      )}

      <Section title={s.link ? 'Change it' : 'Set it up'}>
        {s.databases.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no databases yet. Make one under <InlineLink to="/databases">Databases</InlineLink> first.</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Database" htmlFor="fd-db">
                <NativeSelect id="fd-db" value={db} onChange={(e) => { setDb(e.target.value); setTable(''); setPairs([]); setFixed([]); }}>
                  {s.databases.map((d) => (
                    <option key={`${d.engine}/${d.name}`} value={`${d.engine}/${d.name}`} disabled={!d.active}>
                      {d.title}{d.title !== d.name ? ` (${d.name})` : ''}{d.active ? '' : ` — switch its ${W.app.one} on first`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Table" htmlFor="fd-table"
                hint={tables.data && tables.data.tables.length === 0 ? `No table of this ${W.app.one} can take new records: turn on "Add new ones" for one on its page.` : undefined}>
                <NativeSelect id="fd-table" value={table} onChange={(e) => pickTable(e.target.value)} disabled={!tables.data?.tables.length}>
                  <option value="">Choose a table</option>
                  {(tables.data?.tables ?? []).map((x) => <option key={x.table} value={x.table}>{x.plural}</option>)}
                </NativeSelect>
              </Field>
            </div>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">When</legend>
              <div className="space-y-2 text-sm">
                <label className="flex items-start gap-2">
                  <input type="radio" name="fd-when" className="mt-1 size-4" checked={when === 'approved'} disabled={!s.form.approvable}
                    onChange={() => setWhen('approved')} />
                  <span>When I approve a response {s.form.approvable
                    ? (s.form.autoApprove ? <span className="text-muted-foreground">— this form shows new responses right away, so that is as soon as they arrive</span> : <span className="text-muted-foreground">— the spam stays out of the table</span>)
                    : <span className="text-muted-foreground">— switch on "Responses can be approved" on the form first</span>}</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="fd-when" className="mt-1 size-4" checked={when === 'arrived'} onChange={() => setWhen('arrived')} />
                  <span>As soon as it arrives</span>
                </label>
              </div>
              {/* W7: the rule said plainly, where she chooses it -- rather than
                  leaving her to find out from the form's own switches */}
              {when === 'approved' && (
                <p className="mt-2 text-sm text-muted-foreground">
                  While this is set, "Responses can be approved" has to stay on for this form: answers that
                  nobody can approve would wait for ever. Choose "As soon as it arrives" first if you want to
                  switch approvals off.
                </p>
              )}
            </fieldset>

            {t && (
              <>
                {t.publicRead && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm">Anyone can read {t.plural}: what goes in here can be on a page. Give it a fixed value like "not shared yet" if you want to look first.</p>}
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Each answer goes into</h3>
                  <ul className="divide-y divide-border rounded-md border border-border" aria-label="Questions and the fields they go into">
                    {rows.map(({ q, part }) => {
                      const options = t.fits[slot({ key: q.key, part })] ?? [];
                      const idFor = `fd-q-${q.key}${part ? `-${part}` : ''}`;
                      return (
                        <li key={idFor} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <label htmlFor={idFor} className={`min-w-0 flex-1 basis-40 text-sm ${part ? 'pl-4 text-muted-foreground' : 'font-medium'}`}>
                            {part ? `…${PART_NAMES[part] ?? part}` : q.label}{q.parts && !part ? ' (all of it)' : ''}
                          </label>
                          <NativeSelect id={idFor} className="w-full sm:w-64" value={pairOf(q.key, part)} onChange={(e) => setPair(q.key, part, e.target.value)}>
                            <option value="">— not saved —</option>
                            {options.map((f) => <option key={f} value={f}>{t.fields.find((x) => x.name === f)?.label ?? f}</option>)}
                          </NativeSelect>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {unpaired.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Fields no answer goes into</h3>
                    <ul className="divide-y divide-border rounded-md border border-border" aria-label="Fields with no question">
                      {unpaired.map((f) => <FixedRow key={f.name} f={f} value={fixedOf(f.name)} onChange={(v) => setFixedFor(f.name, v)} />)}
                    </ul>
                  </div>
                )}

                {missing.length > 0
                  ? <p className="text-sm text-destructive">{missing.map((f) => f.label).join(', ')} {missing.length === 1 ? 'has' : 'have'} to be filled in: pair {missing.length === 1 ? 'it' : 'each'} with a question, or give {missing.length === 1 ? 'it' : 'each'} a fixed value.</p>
                  : <p className="text-sm text-success">Every field {t.plural} needs is filled in.</p>}

                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Save answers in the database" />
                  Save answers in the database
                </label>
                <div><Button onClick={() => void save()} disabled={!table}><Save />Save</Button></div>
              </>
            )}
          </div>
        )}
      </Section>
    </Page>
  );
}

// A field no question fills: left empty, a fixed value, or something about the
// response itself (F6).
function FixedRow({ f, value, onChange }: { f: TableField; value: Fixed | undefined; onChange: (v: Fixed | null) => void }) {
  const idFor = `fd-f-${f.name}`;
  const text = f.type === 'text' || f.type === 'short_text';
  const how = !value ? '' : value.from ?? 'value';
  const input = () => {
    if (f.type === 'boolean') return (
      <NativeSelect aria-label={`${f.label}: the value`} className="w-full sm:w-32" value={value?.value === true ? 'yes' : 'no'}
        onChange={(e) => onChange({ field: f.name, value: e.target.value === 'yes' })}>
        <option value="no">No</option><option value="yes">Yes</option>
      </NativeSelect>
    );
    const type = f.type === 'integer' || f.type === 'decimal' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'text';
    return (
      <Input aria-label={`${f.label}: the value`} className="w-full sm:w-48" type={type} value={value?.value === null || value?.value === undefined ? '' : String(value.value)}
        onChange={(e) => onChange({ field: f.name, value: type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value })} />
    );
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <label htmlFor={idFor} className="min-w-0 flex-1 basis-40 text-sm font-medium">
        {f.label} {f.required && <Badge variant="outline">has to be filled in</Badge>}
      </label>
      <NativeSelect id={idFor} className="w-full sm:w-56" value={how}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onChange(null);
          else if (v === 'value') onChange({ field: f.name, value: f.type === 'boolean' ? false : f.type === 'integer' || f.type === 'decimal' ? 0 : '' });
          else onChange({ field: f.name, from: v as Fixed['from'] });
        }}>
        <option value="">{f.required ? '— choose —' : '— leave empty —'}</option>
        <option value="value">A fixed value</option>
        {(f.type === 'timestamptz' || f.type === 'date') && <option value="sent-at">When it was sent</option>}
        {text && <option value="page">The page it was sent from</option>}
        {text && <option value="sender">Who sent it (signed-in visitors)</option>}
      </NativeSelect>
      {how === 'value' && input()}
    </li>
  );
}
