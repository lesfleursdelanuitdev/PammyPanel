// One Resource, in its six parts (docs/databases-plan.md 11.1): identity,
// storage, fields, relationships, behavior, presentation.
//
// Nothing on this page reaches her database. The section headings are the six
// parts on purpose -- it is the one place the product's own vocabulary is worth
// showing her, because "what is this called" and "what may people do with it"
// really are different questions from "how is it stored".
import { ArrowDown, ArrowLeft, ArrowUp, GripVertical, MessageSquare, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { isOn, W } from '@panel/core/web/lib/site';
import { TableTags } from '../components/table-tags';
import { cn } from '@panel/core/web/lib/utils';
import {
  ABILITIES, ABILITY_NAMES, canBeRich, CONTROL_NAMES, CONTROLS,
  type Ability, type AppData, type Control, type DatabaseEngine, type ResourceField,
} from '../lib/schema';

export default function DatabaseAppTable() {
  const { engine, name, table } = useParams<{ engine: DatabaseEngine; name: string; table: string }>();
  usePageTitle(table ?? 'Table');
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<AppData>(`${base}/app`);
  const run = useAction();
  const dialogs = useDialogs();

  const r = data.data?.resources.find((x) => x.table === table);
  // forms that save their answers into this table (docs/form-to-database-plan.md)
  const formLinks = useApi<{ links: { formId: number; title: string; table: string; enabled: boolean; when: string }[] }>(
    `${base}/form-links`, { meta: { quiet: true } });
  const fillers = (formLinks.data?.links ?? []).filter((l) => l.table === table);
  // docs/tutorials-plan.md V1: who can be let in without a key -- a protected folder's people,
  // or on lfdln a route's with accounts (docs/phase8-plan.md 8-4)
  const visitorAreas = useApi<{ areas: { id: number; kind: string; label: string }[] }>('/api/databases/visitor-areas', { meta: { quiet: true } });
  const folders = visitorAreas.data?.areas ?? [];
  const byRoute = isOn('hosts');
  // docs/comments-plan.md C10: can people comment on these? A link table that
  // points here says so. The comments tables themselves are not commentable.
  const navigate = useNavigate();
  const commentable = (data.data?.resources ?? []).some((x) => x.table.endsWith('_comment_threads') && x.fields.some((f) => f.reference === table));
  const isCommentsTable = !!table && (table === 'comments' || table === 'comment_threads' || table.endsWith('_comment_threads'));
  const letComment = async () => {
    const ok = await dialogs.confirm({
      title: `Let people comment on ${r?.plural.toLowerCase() ?? table}?`, action: 'Draw the table',
      body: <>A small table is drawn into your changes, linking each {r?.singular.toLowerCase() ?? 'record'} to its conversation (and the comments tables, if this {W.app.one} has not got them yet). Nothing happens to your database until you press Apply on Review. On the page, the comments go in <code>{'<pammy-comments name="..." content-id="THE ID">'}</code>.</>,
    });
    if (!ok) return;
    const res = await run(() => api<{ review: string }>(`${base}/app/${table}/commentable`, {}), 'Drawn. Look at it on Review, then Apply.');
    if (res) navigate(res.review);
  };

  // the two free-text identity fields are the only things here she types, so
  // they are the only things that need holding while she does
  const [singular, setSingular] = useState('');
  const [plural, setPlural] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (r) { setSingular(r.singular); setPlural(r.plural); setDescription(r.description); }
  }, [r?.table, r?.singular, r?.plural, r?.description]);

  const save = (patch: Record<string, unknown>, done = 'Saved.') =>
    run(() => api(`${base}/app/${table}/settings`, patch), done);
  const saveField = (field: string, patch: Record<string, unknown>, done = 'Saved.') =>
    run(() => api(`${base}/app/${table}/fields/${field}/settings`, patch), done);

  // "How it is filled in". Rich text only where it fits (T1). Switching a
  // rich-text field back to plain writing asks first: what she already wrote
  // with formatting shows its codes, although nothing is lost (T12).
  const setControl = async (f: ResourceField, control: Control) => {
    if (f.control === 'rich' && control !== 'rich') {
      const ok = await dialogs.confirm({
        title: `Stop using rich text for ${f.label}?`,
        body: 'Records you already wrote with formatting will show their formatting codes, like <p> and <strong>. Nothing is lost, and switching back to Rich text shows the formatting again.',
        action: `Change to "${CONTROL_NAMES[control]}"`,
      });
      if (!ok) return;
    }
    await saveField(f.name, { control });
  };
  const controlsFor = (f: ResourceField): readonly Control[] =>
    CONTROLS.filter((c) => c !== 'rich' || canBeRich(f) || f.control === 'rich');

  // ---- the order of the form (docs/field-order-plan.md)
  // What can be moved: what is on the form -- shown fields other than the key,
  // and each many-to-many to a table the app shows. The rest is listed below,
  // greyed, so the list is the whole table.
  const [said, setSaid] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const others = data.data?.resources ?? [];
  const onForm = (n: string): boolean => {
    if (n.startsWith('many:')) {
      const o = others.find((x) => x.table === n.slice(5));
      return !!o && o.enabled && o.can.view;
    }
    const f = r?.fields.find((x) => x.name === n);
    return !!f && f.exposed && !f.primaryKey;
  };
  const labelOf = (n: string): string =>
    n.startsWith('many:') ? others.find((x) => x.table === n.slice(5))?.plural ?? n.slice(5) : r?.fields.find((x) => x.name === n)?.label ?? n;
  const kindOf = (n: string): string =>
    n.startsWith('many:') ? 'Pick several' : CONTROL_NAMES[r?.fields.find((x) => x.name === n)?.control ?? 'text'];
  const movable = (r?.fieldOrder ?? []).filter(onForm);
  const resting = (r?.fieldOrder ?? []).filter((n) => !onForm(n));
  // the whole order goes every time (O8), so two quick moves cannot interleave
  const saveOrder = async (next: string[], announce: string) => {
    // [] is "the table's own order again" -- the resting fields must not make it an order
    const order = next.length ? [...next, ...resting] : [];
    if (await run(() => api(`${base}/app/${table}/order`, { order }), 'Saved.')) setSaid(announce);
  };
  const move = (n: string, by: number) => {
    const i = movable.indexOf(n);
    const j = i + by;
    if (i < 0 || j < 0 || j >= movable.length) return;
    const next = [...movable];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void saveOrder(next, `${labelOf(n)} moved ${by < 0 ? 'up' : 'down'}: now ${j + 1} of ${movable.length}.`);
  };
  const dropOn = (target: string) => {
    if (!dragging || dragging === target) return;
    const next = movable.filter((x) => x !== dragging);
    next.splice(next.indexOf(target) + (movable.indexOf(dragging) < movable.indexOf(target) ? 1 : 0), 0, dragging);
    void saveOrder(next, `${labelOf(dragging)} moved: now ${next.indexOf(dragging) + 1} of ${next.length}.`);
    setDragging(null);
  };

  const forget = async () => {
    const ok = await dialogs.confirm({
      title: `Start ${r?.plural ?? table} again?`,
      body: 'Everything you have set here goes back to what the panel works out from the database itself. Your data is not touched.',
      action: 'Start it again',
    });
    if (ok) await run(() => api(`${base}/app/${table}/forget`, {}), 'Back to what the panel works out.');
  };

  const fieldRow = (f: ResourceField) => (
    <Row key={f.name} title={f.label}
      badges={<>
        {f.primaryKey && <Badge variant="outline">how records are told apart</Badge>}
        {f.reference && <Badge variant="outline">points at {f.reference}</Badge>}
        {!f.exposed && <Badge variant="warn">hidden</Badge>}
      </>}
      meta={<Facts items={[f.name, `kept as ${f.storedAs}`, f.help || null]} />}
      actions={<div className="flex flex-wrap items-end gap-3">
        <Field label="Name for it" htmlFor={`label-${f.name}`} className="w-44">
          <Input id={`label-${f.name}`} defaultValue={f.label} maxLength={60} autoComplete="off"
            onBlur={(e) => { if (e.target.value.trim() !== f.label) void saveField(f.name, { label: e.target.value }); }} />
        </Field>
        <Field label="How it is filled in" htmlFor={`ctl-${f.name}`} className="w-48">
          <NativeSelect id={`ctl-${f.name}`} value={f.control} disabled={!f.exposed}
            onChange={(e) => void setControl(f, e.target.value as Control)}>
            {controlsFor(f).map((c) => <option key={c} value={c}>{CONTROL_NAMES[c]}</option>)}
          </NativeSelect>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={f.exposed} onCheckedChange={(v) => void saveField(f.name, { exposed: v })}
            aria-label={`Show ${f.label}`} />
          Show it
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={f.showInList} disabled={!f.exposed}
            onCheckedChange={(v) => void saveField(f.name, { showInList: v })}
            aria-label={`${f.label} in the list`} />
          In the list
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={f.searchable} disabled={!f.exposed}
            onCheckedChange={(v) => void saveField(f.name, { searchable: v })}
            aria-label={`Search ${f.label}`} />
          Searchable
        </label>
        {f.control === 'rich' && f.searchable && (
          <p className="basis-full text-xs text-muted-foreground">
            Searching rich text also looks inside its formatting codes, so a search for "strong" can find a post with bold in it.
          </p>
        )}
      </div>} />
  );

  return (
    <Page title={r?.plural ?? table ?? ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}`}>{name}</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}/app`}>the {W.app.one}</InlineLink>{' · '}
        Nothing on this page changes your database.
      </>}
      actions={<Button variant="outline" asChild>
        <Link to={`/databases/${engine}/${name}/app`}><ArrowLeft />All of them</Link>
      </Button>}>

      {!data.data ? <Loading /> : !r ? (
        <Section title="Not here">
          <p className="text-sm">There is no table called {table} in this database.{' '}
            <InlineLink to={`/databases/${engine}/${name}/app`}>Back to the {W.app.one}</InlineLink></p>
        </Section>
      ) : <>
        <Section title="What it is called"
          intro="How it appears in the menu and on its pages. The panel guesses from the table name; you can say it better."
          action={<Button variant="outline" size="sm" onClick={forget}><RotateCcw />Start again</Button>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="One of them" htmlFor="res-singular" hint="Used on a form: “Add a Recipe”.">
              <Input id="res-singular" value={singular} maxLength={60} onChange={(e) => setSingular(e.target.value)} />
            </Field>
            <Field label="More than one" htmlFor="res-plural" hint="Used in the menu and above the list.">
              <Input id="res-plural" value={plural} maxLength={60} onChange={(e) => setPlural(e.target.value)} />
            </Field>
            <Field label="What it is for" htmlFor="res-description" className="sm:col-span-2"
              hint="Optional. A line to remind you, shown at the top of the list.">
              <Input id="res-description" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4">
            <Button onClick={() => void save({ singular, plural, description })}
              disabled={singular === r.singular && plural === r.plural && description === r.description}>
              <Save />Save these words
            </Button>
          </div>
        </Section>

        <Section title="Where it is kept" plain>
          <p className="text-sm text-muted-foreground">
            The table <strong>{r.table}</strong>, in {r.kind === 'connection' ? 'a connecting table' : 'this database'}.
            {' '}Records are told apart by {r.fields.filter((f) => f.primaryKey).map((f) => f.name).join(', ') || 'nothing — which will make editing hard'}.
            {' '}Its records are the table's rows: the {W.app.one} only decides how you see and change them.
          </p>
        </Section>

        <Section flush title="What people see"
          intro="A field that is not shown is not on the form, not in the list, and not in the API. Being in the database is not the same as being readable.">
          <List label="Fields">{r.fields.map(fieldRow)}</List>
        </Section>

        <Section flush title="The form"
          intro="The order the fields are in when you add or change one, and in the list. Nothing here changes the database."
          action={r.ordered ? (
            <Button variant="outline" size="sm" onClick={() => void saveOrder([], 'Back to the table\'s own order.')}>
              <RotateCcw />Put back the table's order
            </Button>
          ) : undefined}>
          <p className="sr-only" aria-live="polite">{said}</p>
          <ol aria-label="The order of the form" className="divide-y divide-border">
            {movable.map((n, i) => (
              <li key={n} data-name={n}
                // drag by the handle on a computer (Q3); Up and Down always work
                draggable onDragStart={() => setDragging(n)} onDragEnd={() => setDragging(null)}
                onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); dropOn(n); }}
                className={cn('flex items-center gap-2 px-3 py-1.5 sm:px-4', dragging === n && 'opacity-50')}>
                <GripVertical aria-hidden className="hidden size-4 shrink-0 cursor-grab text-muted-foreground sm:block" />
                <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">{labelOf(n)}</span>
                <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">{kindOf(n)}</span>
                <Button variant="ghost" size="icon" className="size-11 sm:size-9" disabled={i === 0}
                  aria-label={`Move ${labelOf(n)} up`} onClick={() => move(n, -1)}><ArrowUp /></Button>
                <Button variant="ghost" size="icon" className="size-11 sm:size-9" disabled={i === movable.length - 1}
                  aria-label={`Move ${labelOf(n)} down`} onClick={() => move(n, 1)}><ArrowDown /></Button>
              </li>
            ))}
            {resting.map((n) => (
              <li key={n} className="flex items-center gap-2 px-3 py-2.5 text-muted-foreground sm:px-4">
                <span className="hidden size-4 shrink-0 sm:block" />
                <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{labelOf(n)}</span>
                <span className="shrink-0 text-sm">not on the form</span>
              </li>
            ))}
          </ol>
        </Section>

        {!isCommentsTable && (
          <Section title="Comments"
            intro={commentable
              ? `People can comment on ${r.plural.toLowerCase()}: each one has its own conversation, and the comments you approve are kept in this ${W.app.one}.`
              : `Let visitors comment on each of your ${r.plural.toLowerCase()}, with every comment waiting for your OK.`}
            action={commentable ? <Button variant="outline" asChild><Link to="/comments"><MessageSquare />Comments</Link></Button>
              : <Button variant="outline" onClick={() => void letComment()}><MessageSquare />People can comment on these</Button>} />
        )}

        {fillers.length > 0 && (
          <Section title="Filled in by"
            intro="Forms that add a record here for each response they get. Renaming or hiding a field one of them uses stops that form saving until you change it.">
            <ul className="space-y-1 text-sm">
              {fillers.map((l) => (
                <li key={l.formId}>
                  The form <InlineLink to={`/forms/${l.formId}/database`}>{l.title}</InlineLink>
                  {l.enabled ? (l.when === 'approved' ? ', when you approve a response' : ', as each response arrives') : ' (switched off)'}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="What it is named by"
          intro="The one field that stands for a whole record, so a list shows names instead of numbers.">
          <Field label="Named by" htmlFor="res-title" className="max-w-sm">
            <NativeSelect id="res-title" value={r.titleField ?? ''}
              onChange={(e) => void save({ titleField: e.target.value })}>
              <option value="">nothing — show the id</option>
              {r.fields.filter((f) => f.exposed && !f.primaryKey).map((f) => (
                <option key={f.name} value={f.name}>{f.label}</option>
              ))}
            </NativeSelect>
          </Field>
        </Section>

        {/* docs/catalog-plan.md step 4 */}
        {isOn('catalog') && r.enabled && (
          <TableTags base={`${base}/app/${r.table}`} singular={r.singular} pluralName={r.plural} />
        )}

        {r.related.length > 0 && (
          <Section flush title="How it connects to other tables"
            intro="From the connections on the drawing. Changing these is a change to the database, so it happens on the Tables page.">
            <List label="Connections">
              {r.related.map((x, i) => (
                <Row key={i} title={x.line}
                  badges={<Badge variant="outline">{x.kind === 'many-to-many' ? 'both ways' : x.kind === 'one-to-one' ? 'one of each' : 'one has many'}</Badge>}
                  meta={<Facts items={[`with ${x.other}`]} />} />
              ))}
            </List>
          </Section>
        )}

        <Section title="What people may do"
          intro="These bind the pages and the API alike. An old record book you want kept but not edited can be “look at” and “search” only.">
          <div className="grid gap-3 sm:grid-cols-2">
            {ABILITIES.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm">
                <Switch checked={r.can[a]} disabled={a === 'duplicate' && !r.can.create}
                  onCheckedChange={(v) => void save({ can: { [a]: v } as Partial<Record<Ability, boolean>> })}
                  aria-label={ABILITY_NAMES[a]} />
                {ABILITY_NAMES[a]}
                {a === 'duplicate' && !r.can.create && (
                  <span className="text-muted-foreground">— needs “add new ones”</span>
                )}
              </label>
            ))}
          </div>
        </Section>

        {/* docs/db-examples-plan.md X1, X12 */}
        <Section title="Anyone can read these"
          intro="For a page on your website: every visitor can see these, with no key. Only reading, only the fields shown above — nobody can add or change anything this way.">
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={r.publicRead} disabled={!r.can.view}
              onCheckedChange={(v) => void save({ publicRead: v },
                v ? `Anyone can now read ${r.plural.toLowerCase()}.` : `${r.plural} need a key again.`)}
              aria-label="Anyone can read these" />
            <span>
              <span className="font-medium">Anyone can read {r.plural.toLowerCase()}</span>
              <span className="block text-muted-foreground">
                {!r.can.view
                  ? 'Turn “Look at them” on first.'
                  : data.data.apiRead
                    ? 'Switching it on asks for your passkey, because it puts them on the internet.'
                    : <>Nothing is readable yet: reading is off on <InlineLink to={`/databases/${engine}/${name}/programs`}>Letting programs in</InlineLink>. That stays the main switch.</>}
              </span>
            </span>
          </label>
          {r.publicRead && (
            <Field label="Which of them" htmlFor="res-public-only" className="mt-4 max-w-md"
              hint="A yes/no field can keep some back — like a post that is not published yet. Those are not there at all without a key, however someone asks.">
              <NativeSelect id="res-public-only" value={r.publicOnly ?? ''}
                onChange={(e) => void save({ publicOnly: e.target.value })}>
                <option value="">Every one</option>
                {r.fields.filter((f) => f.exposed && f.type === 'boolean').map((f) => (
                  <option key={f.name} value={f.name}>Only the ones where “{f.label}” is yes</option>
                ))}
              </NativeSelect>
            </Field>
          )}
        </Section>

        {/* docs/tutorials-plan.md V1-V7 */}
        <Section title={byRoute ? 'People with accounts on a part of the site' : 'People signed in to a protected folder'}
          intro={byRoute
            ? 'For a page on a host route with accounts, like a to-do list: the people let in there can add and change these from the page, with no key — only what the switches above allow, only the fields shown above.'
            : 'For a page inside a protected folder, like a to-do list: the people you let into that folder can add and change these from the page, with no key — only what the switches above allow, only the fields shown above.'}>
          <Field label="Who can change them" htmlFor="res-visitor-area" className="max-w-md"
            hint={folders.length === 0 ? (byRoute ? 'No route has accounts yet. Give one accounts on the Hosts page first.' : 'You have no protected folders yet. Protect one on the Protected folders page first.')
              : !data.data.apiWrite || !data.data.apiRead ? 'Nothing works this way yet: reading and changing are off on Letting programs in. Those stay the main switches.'
                : `Choosing ${byRoute ? 'one' : 'a folder'} asks for your passkey, because it lets other people change your data.`}>
            <NativeSelect id="res-visitor-area" value={r.visitorArea ? String(r.visitorArea) : ''}
              onChange={(e) => void save({ visitorArea: e.target.value ? Number(e.target.value) : null },
                e.target.value ? (byRoute ? 'People let in there can now change these.' : 'People signed in to that folder can now change these.') : 'Only a key can change these again.')}>
              <option value="">Nobody without a key</option>
              {folders.map((f) => <option key={f.id} value={String(f.id)}>{f.label}</option>)}
              {r.visitorArea && !folders.some((f) => f.id === r.visitorArea) && <option value={String(r.visitorArea)}>{byRoute ? 'A route that no longer has accounts (nobody)' : 'A folder that is no longer protected (nobody)'}</option>}
            </NativeSelect>
          </Field>
          {r.visitorArea && (
            <Field label="Whose are they" htmlFor="res-visitor-owner" className="mt-4 max-w-md"
              hint="With a field chosen, the panel writes each person's username into it when they add one, and they only ever see and change their own. Nobody can put someone else's name there.">
              <NativeSelect id="res-visitor-owner" value={r.visitorOwner ?? ''}
                onChange={(e) => void save({ visitorOwner: e.target.value },
                  e.target.value ? 'Each person now only sees their own.' : 'They now all share every one.')}>
                <option value="">{byRoute ? 'Everyone let in there shares all of them' : 'Everyone in the folder shares all of them'}</option>
                {r.fields.filter((f) => f.exposed && !f.primaryKey && (f.type === 'short_text' || f.type === 'text')).map((f) => (
                  <option key={f.name} value={f.name}>Each person only their own, by “{f.label}”</option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {r.visitorArea && !r.visitorOwner && (r.can.edit || r.can.delete) && (
            <p role="note" className="mt-4 max-w-md rounded-md bg-warning-soft px-3 py-2 text-sm">
              With no “Whose are they” field, everyone {byRoute ? 'let in there' : 'signed in to that folder'} can {r.can.edit && r.can.delete ? 'change and delete' : r.can.edit ? 'change' : 'delete'} every one of these — including the ones other people added.
            </p>
          )}
        </Section>

        <Section title="When something is deleted"
          intro="What the database does about connected records is already settled on the Tables page, and that stays the law. This is only whether you are shown what will happen first.">
          <Field label="Before deleting a record" htmlFor="res-ondelete" className="max-w-md">
            <NativeSelect id="res-ondelete" value={r.onDelete}
              onChange={(e) => void save({ onDelete: e.target.value })}>
              <option value="follow">Just ask, and let the database do what it says</option>
              <option value="confirm">Show me what else it affects first</option>
            </NativeSelect>
          </Field>
        </Section>
      </>}
    </Page>
  );
}
