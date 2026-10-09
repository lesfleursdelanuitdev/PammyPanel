// Forms: every form she has, what each one is used on, and the switches that
// decide whether it works, whether responses can be approved (and whether new
// ones wait for her OK or show right away), and whether anyone may read the
// approved ones.
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, Code, Copy, Database, Eye, Inbox, PartyPopper, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Collapsible, Empty, Facts, Field, GuideLink, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, formatTime, plural } from '@panel/core/web/lib/api';
import { FORM_NAME_RULE, formNameProblem } from '@panel/core/web/lib/names';
import { isAnswerType } from '../lib/types';
import { notify } from '@panel/core/web/lib/status';
import type { FormInList, FormsData } from '../lib/types';
import { guideTo, isOn, W } from '@panel/core/web/lib/site';
import { isKept, may, placeFolders } from '@panel/core/web/lib/rights';

export { FORM_NAME_RULE as NAME_RULE, formNameProblem as nameProblem } from '@panel/core/web/lib/names';

export const formCode = (name: string) => `<script src="/_pammy/forms.js" defer></script>
<pammy-form name="${name}"></pammy-form>`;

// The same, with a page of her own to land on and her own thank-you words in place
// of the form (whichever she keeps).
export const thanksCode = (name: string) => `<script src="/_pammy/forms.js" defer></script>

<!-- go to a page of your own after sending -->
<pammy-form name="${name}" thanks="thank-you.html"></pammy-form>

<!-- or stay on this page and show your own words in place of the form -->
<pammy-form name="${name}">
  <template class="pammy-thanks">
    <h2>Thank you!</h2>
    <p>I'll be in touch soon. <a href="/">Back to the website</a></p>
  </template>
</pammy-form>`;

// Showing the answers she has approved on a page of her own. It uses textContent,
// never innerHTML: what visitors typed is words, never part of the page's code.
export const approvedCode = (name: string, keys: string[]) => `<ul id="answers"></ul>

<script>
  fetch('/_pammy/api/forms/by-name/${name}/approved?order=desc&limit=20')
    .then((r) => r.json())
    .then((data) => {
      const list = document.getElementById('answers');
      for (const response of data.responses) {
        const item = document.createElement('li');
        // the names of your own questions, as the Edit screen shows them
        item.textContent = response.answers['${keys[0] ?? 'your-name'}'] + ': ' + response.answers['${keys[1] ?? keys[0] ?? 'message'}'];
        list.append(item);
      }
    });
</script>`;

export function Forms() {
  usePageTitle('Forms');
  const data = useApi<FormsData>('/api/forms');
  const [trashOpen, setTrashOpen] = useState(false);
  const navigate = useNavigate();
  const run = useAction();
  const [name, setName] = useState('');
  const [making, setMaking] = useState(false);

  const [starter, setStarter] = useState('blank');
  // a person kept to places (D22): their new forms work in one of their folders, and they have no examples
  const me = useMe();
  const limited = !!me && isKept(me);
  const mine = me ? placeFolders(me) : [];
  // the starters are the forms module's own (docs/phase8-plan.md 8-5), whether or not the examples
  // are on; for whoever sees the whole site, as they always were (a person kept to places starts blank)
  const starters = useApi<{ starters: { kind: string; label: string; about: string }[] }>(me && may(me, 'forms', true) ? '/api/forms/starters' : null, { staleTime: 60_000 });
  const scopes = useApi<{ folders: string[] }>(me && !limited ? '/api/forms/scopes' : null, { staleTime: 60_000 });
  const folders = scopes.data?.folders ?? [];
  const [worksOn, setWorksOn] = useState('');

  // comment areas are forms underneath, but they live on Comments (docs/comments-plan.md C7)
  const allForms = data.data?.forms.filter((f) => f.kind !== 'comments') ?? [];
  const areas = (data.data?.forms ?? []).filter((f) => f.kind === 'comments' && !f.trashedAt).length;
  const live = allForms.filter((f) => !f.trashedAt && !f.fixture);
  const fixtures = allForms.filter((f) => !f.trashedAt && f.fixture);
  const trashed = allForms.filter((f) => f.trashedAt);

  const make = async () => {
    const n = name.trim().toLowerCase();
    const problem = formNameProblem(n);
    if (problem) return notify(problem, 'error');
    const r = starter === 'blank'
      ? await run(() => api<{ form: { id: number } }>('/api/forms', { name: n, title: n, items: [], scope: worksOn || (limited ? mine[0] : '') }))
      : await run(() => api<{ form: { id: number } }>('/api/forms', { name: n, starter, scope: worksOn || (limited ? mine[0] : '') }));
    if (r) navigate(`/forms/${r.form.id}`);
  };

  return (
    <Page title="Forms" intro={<>A form is a list of questions. Put it on any page of {W.website.your}, and the answers arrive in <InlineLink to="/responses">Responses</InlineLink>.<GuideLink topic="forms">How forms work</GuideLink>{guideTo('forms') && guideTo('form-or-database') && ' ·'}<GuideLink topic="form-or-database">Form or database?</GuideLink></>}
      actions={<Button onClick={() => setMaking((m) => !m)}><Plus />New form</Button>}>

      {making && (
        <Section title="New form" intro="Start from nothing, or from a list of questions that is already written. Either way you can change every question afterwards.">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void make(); }}>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-1.5 text-sm font-medium">What kind of form</legend>
              <StarterChoice id="blank" label="Blank" about="No questions yet: you add them yourself." now={starter} set={setStarter} />
              {(starters.data?.starters ?? []).map((st) => (
                <StarterChoice key={st.kind} id={st.kind} label={st.label} about={st.about} now={starter} set={setStarter} />
              ))}
            </fieldset>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Name" htmlFor="new-form-name" hint={FORM_NAME_RULE} className="flex-1">
                <Input id="new-form-name" value={name} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false}
                  placeholder="e.g. olivias-form" onChange={(e) => setName(e.target.value)} />
              </Field>
              {(!limited || mine.length > 1) && (
                <Field label="Works on" htmlFor="new-form-scope" className="sm:w-56">
                  <NativeSelect id="new-form-scope" value={limited ? worksOn || mine[0] : worksOn} onChange={(e) => setWorksOn(e.target.value)}>
                    {!limited && <option value="">Every page</option>}
                    {(limited ? mine : folders).map((f) => <option key={f} value={f}>Only the pages in {f}</option>)}
                  </NativeSelect>
                </Field>
              )}
              <Button type="submit"><Plus />Make it</Button>
            </div>
            {limited && mine.length === 1 && <p className="text-sm text-muted-foreground">It works on the pages in {mine[0]}.</p>}
          </form>
        </Section>
      )}

      <Section plain title="Your forms">
        {!data.data ? <Loading />
          : live.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-5 py-6 text-muted-foreground">
              No forms of your own yet. Click "New form"{isOn('examples') && <> &mdash; or see a guest book, an RSVP list and a pinboard working first, under <InlineLink to="/examples">Form examples</InlineLink></>}.
            </p>
          )
            : <div className="space-y-4">{live.map((f) => <FormCard key={f.id} f={f} folders={limited ? null : folders} />)}</div>}
      </Section>

      {fixtures.length > 0 && (
        <Section plain title="The examples"
          intro={<>A guest book, a list of who's coming and a pinboard, ready to play with. They can't be deleted, and what arrives on them stays out of your Responses count. <InlineLink to="/examples">See them working, and how to make one</InlineLink></>}>
          <div className="space-y-4">{fixtures.map((f) => <FormCard key={f.id} f={f} />)}</div>
        </Section>
      )}

      {trashed.length > 0 && (
        <Collapsible summary={<><Trash2 className="size-4" />Trash</>} onToggle={setTrashOpen}>
          <p className="mb-3 text-muted-foreground">
            Forms you deleted. Restore one within {data.data?.trashDays ?? 30} days; after that it's gone for good. Their names stay taken meanwhile,
            and their responses stay in Responses.
          </p>
          {trashOpen && (
            <List label="Forms in the trash">
              {trashed.map((f) => (
                <Row key={f.id} title={f.title} meta={<Facts items={[f.name, `moved to the trash ${formatTime(f.trashedAt)}${f.trashedBy ? ` by ${f.trashedBy}` : ''}`]} />}
                  actions={<ActionButton icon={ArchiveRestore} onClick={() => run(() => api(`/api/forms/${f.id}/restore`, {}), `"${f.name}" is back.`)}>Restore</ActionButton>} />
              ))}
            </List>
          )}
        </Collapsible>
      )}
      <p className="text-sm text-muted-foreground">
        Comment areas live in <InlineLink to="/comments">Comments</InlineLink>{areas ? ` (you have ${areas})` : ''}.
      </p>
    </Page>
  );
}

// folders: the choice of where a form works (null for an account that only sees one folder)
function FormCard({ f, folders = null }: { f: FormInList; folders?: string[] | null }) {
  const run = useAction();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const [showCode, setShowCode] = useState<'page' | 'thanks' | 'approved' | null>(null);
  const questions = f.items.filter((i) => isAnswerType(i.type));
  const refresh = () => qc.invalidateQueries({ queryKey: ['/api/forms'] });
  const set = async (patch: Record<string, boolean>, said: string) => {
    if (await run(() => api(`/api/forms/${f.id}/switches`, patch), said)) await refresh();
  };
  // Back to waiting for her OK: offer to take down what went up on its own
  // and nobody has opened yet -- the undo for a burst of junk.
  const setWay = async (auto: boolean) => {
    const r = await run(() => api<{ unreviewedAuto: number }>(`/api/forms/${f.id}/switches`, { autoApprove: auto }),
      auto ? 'New responses now show right away.' : 'New responses now wait for your OK.');
    if (!r) return;
    await refresh();
    if (auto || r.unreviewedAuto === 0) return;
    const n = r.unreviewedAuto;
    const hide = await dialogs.confirm({
      title: `Also hide the ${plural(n, 'response')} nobody has looked at?`, action: n === 1 ? 'Hide it' : 'Hide them', cancel: 'Leave them showing',
      body: <>
        <p>{n === 1 ? 'One response' : `${n} responses`} went up on {n === 1 ? 'its' : 'their'} own while this form showed new responses right away, and {n === 1 ? "hasn't" : "haven't"} been opened yet.
          If junk got through, this takes {n === 1 ? 'it' : 'them'} down in one go.</p>
        <p>{n === 1 ? 'It stays' : 'They stay'} in Responses, not approved, so you can still approve {n === 1 ? 'it' : 'any of them'} one by one. Anything you have opened or approved yourself is not touched.</p>
      </>,
    });
    if (hide) await run(() => api<{ hidden: number }>(`/api/forms/${f.id}/hide-unreviewed`, {}), (x) => `${plural(x.hidden, 'response')} hidden.`);
  };

  return (
    <article id={`form-${f.id}`} className="scroll-mt-20 rounded-lg border border-border bg-card shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold [overflow-wrap:anywhere]">
            {f.title}
            {f.fixture && <Badge variant="ok">example</Badge>}
            {f.scope !== '/' && <Badge variant="outline">only in {f.scope.slice(1)}</Badge>}
            {!f.enabled && <Badge variant="warn">off</Badge>}
            {f.approvable && <Badge>responses are approved</Badge>}
            {f.approvable && f.autoApprove && <Badge variant="warn">shown right away</Badge>}
            {f.publicApproved && <Badge variant="ok">approved ones are public</Badge>}
            {f.unread > 0 && <Badge variant="solid">{f.unread} unread</Badge>}
          </h3>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            <Facts items={[
              <code key="n" className="rounded bg-muted px-1.5 py-0.5">{f.name}</code>,
              <span key="id">number {f.id} <span className="opacity-70">(for the API)</span></span>,
              plural(questions.length, 'question'),
              plural(f.responses, 'response'),
              f.lastResponseAt ? `last one ${formatTime(f.lastResponseAt)}` : null,
            ]} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {folders && !f.fixture && (
            <NativeSelect aria-label={`Where "${f.title}" works`} value={f.scope === '/' ? '' : f.scope.slice(1)} className="h-8 w-auto text-sm"
              onChange={async (e) => {
                const v = e.target.value;
                if (await run(() => api(`/api/forms/${f.id}/scope`, { scope: v }), v ? `"${f.title}" now works only on the pages in ${v}.` : `"${f.title}" now works on every page.`)) await refresh();
              }}>
              <option value="">Works on every page</option>
              {[...new Set([...folders, ...(f.scope !== '/' ? [f.scope.slice(1)] : [])])].map((x) => <option key={x} value={x}>Works only in {x}</option>)}
            </NativeSelect>
          )}
          <ActionButton icon={Pencil} onClick={() => navigate(`/forms/${f.id}`)}>Edit</ActionButton>
          {f.responses > 0 && <ActionButton icon={Inbox} onClick={() => navigate(`/responses?form=${f.id}`)}>Responses</ActionButton>}
          <ActionButton icon={Copy} onClick={async () => {
            const suggested = await api<{ name: string }>(`/api/forms/${f.id}/copy-name`);
            const name = await dialogs.prompt({
              title: `Make a copy of "${f.title}"`, action: 'Make the copy', label: 'Name for the copy', value: suggested.name,
              body: 'The copy has the same questions and settings. Its responses are not copied.',
            });
            if (name === null) return;
            const problem = formNameProblem(name.trim().toLowerCase());
            if (problem) return notify(problem, 'error');
            const r = await run(() => api<{ form: { id: number } }>(`/api/forms/${f.id}/duplicate`, { name: name.trim().toLowerCase() }), `Copied to "${name.trim().toLowerCase()}".`);
            if (r) navigate(`/forms/${r.form.id}`);
          }}>Duplicate</ActionButton>
          {f.fixture ? <>
            <ActionButton icon={Sparkles} onClick={() => navigate(`/examples/${f.fixture}`)}>Open the example</ActionButton>
            <ActionButton icon={RotateCcw} onClick={async () => {
              const ok = await dialogs.confirm({
                title: `Put the "${f.title}" example back as it was?`, action: 'Put it back', danger: true,
                body: <>
                  <p>Its questions, its wording and its switches go back to how they started, and every response to it is replaced by the few we wrote.</p>
                  <p>Forms of your own made from this example are not touched.</p>
                </>,
              });
              if (ok && await run(() => api(`/api/examples/${f.fixture}/reset`, {}), `The ${f.title} example is back as it was.`)) await refresh();
            }}>Put it back as it was</ActionButton>
          </> : <ActionButton variant="danger" icon={Trash2} onClick={async () => {
            const ok = await dialogs.confirm({
              title: `Delete the form "${f.title}"?`, action: 'Move to the trash', danger: true,
              body: <>
                {f.pages.length > 0 && <p>It's on {f.pages.map((p) => p.page).join(', ')}. Those pages will say the form isn't available.</p>}
                <p>You can restore it for 30 days. Its {plural(f.responses, 'response')} stay in Responses, and the name "{f.name}" stays taken until it's gone for good.</p>
              </>,
            });
            if (ok && await run(() => api(`/api/forms/${f.id}/trash`, {}), `"${f.title}" is in the trash.`)) await refresh();
          }}>Delete</ActionButton>}
        </div>
      </div>

      <div className="grid gap-3 px-4 py-4 sm:px-5">
        <SwitchRow id={`on-${f.id}`} checked={f.enabled} label="Working on your pages"
          hint={f.enabled ? 'Pages that use it show the form.' : "Pages that use it say it isn't available, and nothing can be sent."}
          onChange={(v) => set({ enabled: v }, v ? `"${f.name}" is working.` : `"${f.name}" is switched off.`)} />
        <SwitchRow id={`app-${f.id}`} checked={f.approvable} label="Responses can be approved"
          hint="Adds an Approve button in Responses, so you can pick the ones that may be shown elsewhere."
          onChange={(v) => set(v ? { approvable: true } : { approvable: false, publicApproved: false },
            v ? 'You can now approve its responses.' : 'Approving is off (what you approved is remembered).')} />
        {f.approvable && !f.fixture && <ApprovalWay id={f.id} auto={f.autoApprove} onChange={setWay} />}
        {f.approvable && (
          <SwitchRow id={`pub-${f.id}`} checked={f.publicApproved} label="Anyone can read the approved responses"
            hint={<>So a page can show them (a guest book, an RSVP list). Only answers you marked "Show publicly" are given out.<GuideLink topic="forms">How to use it</GuideLink></>}
            onChange={(v) => set({ publicApproved: v }, v ? 'Approved responses can now be read by anyone.' : 'Approved responses are private again.')} />
        )}
        {/* docs/form-to-database-plan.md: the account manager's, for a form of hers */}
        {me && may(me, 'databases') && !f.fixture && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Database aria-hidden className="size-4 text-muted-foreground" />
            <span className="mr-auto">Save its answers in one of your databases as well</span>
            <Button variant="outline" size="sm" asChild><Link to={`/forms/${f.id}/database`}>Save answers in a database</Link></Button>
          </div>
        )}
      </div>

      <div className="border-t border-border px-4 py-3.5 text-sm sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="mr-auto text-muted-foreground">
            {f.pages.length === 0 ? "Not seen on any page yet." : <>Used on {f.pages.map((p) => p.page).join(', ')}</>}
          </span>
          <CodeTab id="page" now={showCode} set={setShowCode} icon={Code}>Code for a page</CodeTab>
          <CodeTab id="thanks" now={showCode} set={setShowCode} icon={PartyPopper}>After sending</CodeTab>
          <CodeTab id="approved" now={showCode} set={setShowCode} icon={Eye}>Show approved answers</CodeTab>
        </div>

        {showCode === 'page' && (
          <CodeBlock code={formCode(f.name)} copied="The two lines are copied. Paste them into your page."
            intro="Put these two lines on any page of your website, wherever the form should appear:" />
        )}
        {showCode === 'thanks' && (
          <CodeBlock code={thanksCode(f.name)} copied="Copied. Keep whichever of the two you want."
            intro={<>What people see after they send. Either they go to a page of your own, which is an ordinary page you write and style however you like, or they stay
              where they are and see your own words in place of the form. Without either, they see the thank-you words set in the form's settings.</>} />
        )}
        {showCode === 'approved' && (
          <CodeBlock code={approvedCode(f.name, questions.filter((i) => i.public !== false && i.type !== 'hidden').map((i) => i.key!))} copied="Copied. Paste it into the page that should show them."
            intro={<>Shows the responses you have approved on a page of your own. It needs "Responses can be approved" and "Anyone can read the approved responses" above
              to be switched on{f.publicApproved ? '' : ' (they are not yet)'}, and it only ever gives out the answers you marked "Show publicly".{f.autoApprove && f.approvable ? ' This form shows new responses right away, so each one appears as soon as it is sent.' : ''}<GuideLink topic="forms">More about this</GuideLink></>} />
        )}
      </div>
    </article>
  );
}

function StarterChoice({ id, label, about, now, set }: { id: string; label: string; about: string; now: string; set: (v: string) => void }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${now === id ? 'border-primary bg-primary/5' : 'border-border'}`}>
      <input type="radio" name="starter" value={id} checked={now === id} onChange={() => set(id)} className="mt-1" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-muted-foreground">{about}</span>
      </span>
    </label>
  );
}

function CodeTab({ id, now, set, icon: Icon, children }: { id: 'page' | 'thanks' | 'approved'; now: string | null; set: (v: 'page' | 'thanks' | 'approved' | null) => void; icon: React.ComponentType; children: React.ReactNode }) {
  return (
    <Button size="sm" variant={now === id ? 'light' : 'ghost'} aria-pressed={now === id} onClick={() => set(now === id ? null : id)}><Icon />{children}</Button>
  );
}

export function CodeBlock({ code, intro, copied }: { code: string; intro: React.ReactNode; copied: string }) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 max-w-[72ch] text-muted-foreground">{intro}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem]"><code>{code}</code></pre>
      <ActionButton className="mt-2" icon={Copy} onClick={async () => {
        await navigator.clipboard.writeText(code);
        notify(copied);
      }}>Copy</ActionButton>
    </div>
  );
}

// Which state a new response starts in. Two choices rather than a third switch:
// it is "which way", not "on or off".
function ApprovalWay({ id, auto, onChange }: { id: number; auto: boolean; onChange: (auto: boolean) => void }) {
  const choice = (value: boolean, label: string, about: React.ReactNode) => (
    <label className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${auto === value ? 'border-primary bg-primary/5' : 'border-border'}`}>
      <input type="radio" name={`way-${id}`} checked={auto === value} onChange={() => { if (auto !== value) onChange(value); }} className="mt-1" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-muted-foreground">{about}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="grid gap-2 sm:ml-12">
      <legend className="mb-1.5 text-sm font-semibold">New responses</legend>
      {choice(false, 'Wait for my OK', 'Nothing is approved until you click Approve.')}
      {choice(true, 'Show right away', <>Each one is approved as it arrives, and you click Unapprove on any that shouldn't show.
        There's no robot check yet, so junk can appear on your page until you take it down.</>)}
    </fieldset>
  );
}

function SwitchRow({ id, checked, label, hint, onChange }: { id: string; checked: boolean; label: string; hint: React.ReactNode; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-[0.95rem] font-medium">{label}</label>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
