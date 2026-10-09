// Examples: three pages that really work, framed from pammy.org, so she can see
// a guest book, a list of who's coming and a pinboard before she builds one --
// and sign them herself, approve her own response in Responses, and watch it
// appear. "Put this on my website" writes the same page into a folder of hers,
// with a form of her own behind it (docs/examples-plan.md).
import { ArrowLeft, ExternalLink as ExternalLinkIcon, Eye, Monitor, PenLine, RotateCcw, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FolderPicker } from '@panel/core/web/components/folder-picker';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Empty, Field, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { formNameProblem, FORM_NAME_RULE } from '@panel/core/web/lib/names';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';
import type { ExampleInList, ExamplesData, FormsData } from '../lib/types';
import { SITE_ORIGIN } from '@panel/core/web/lib/site';

// The examples live on her website, which is the only place a form works.
const SITE = SITE_ORIGIN;
export const exampleUrl = (kind: string) => `${SITE}/_pammy/examples/${kind}/`;

export function Examples() {
  usePageTitle('Form examples');
  const data = useApi<ExamplesData>('/api/examples');
  const navigate = useNavigate();

  return (
    <Page title="Form examples" intro="Three pages that work: a guest book, a list of who's coming, and a pinboard. They are all the same idea — a form collects the answers, you approve the ones you like, and a page of yours shows those. Try one, then have it for yourself.">
      {!data.data ? <Loading /> : (
        <div className="grid gap-4 sm:grid-cols-3">
          {data.data.examples.map((e) => (
            <button key={e.kind} type="button" onClick={() => navigate(`/examples/${e.kind}`)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left shadow-card transition hover:border-primary/60 hover:shadow-md">
              <span className="text-base font-semibold">{e.heading}</span>
              <span className="text-sm text-muted-foreground">{e.about}</span>
              <span className="mt-auto pt-2 text-sm font-medium text-primary">Have a look, or make one →</span>
            </button>
          ))}
        </div>
      )}
      <Section title="What you are looking at" intro="The same machine in three different coats.">
        <ul className="ml-5 list-disc space-y-1.5 py-1 text-sm text-muted-foreground">
          <li>Each example is a real form, like the ones on your <InlineLink to="/forms">Forms</InlineLink> tab. Fill one in and it arrives in <InlineLink to="/responses">Responses</InlineLink> like any other answer.</li>
          <li>Nothing shows on the page until you approve it. That is what keeps a guest book yours.</li>
          <li>You can change the examples about as much as you like: "Put it back as it was" undoes anything, whenever you want.</li>
          <li>They belong to the panel, so they can't be deleted — but "Put this on my website" gives you your own, which is yours to change or delete.</li>
        </ul>
      </Section>
    </Page>
  );
}

export function Example() {
  const kind = useParams().kind ?? '';
  const data = useApi<ExamplesData>('/api/examples');
  const example = data.data?.examples.find((e) => e.kind === kind);
  usePageTitle(example?.heading ?? 'Example');
  const navigate = useNavigate();
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');

  if (!data.data) return <Page title="Example"><Loading /></Page>;
  if (!example) {
    return (
      <Page title="Example">
        <Empty>There is no example called "{kind}". <InlineLink to="/examples">Back to the form examples</InlineLink></Empty>
      </Page>
    );
  }

  return (
    <Page wide title={example.heading} intro={example.about}
      actions={<Button variant="ghost" onClick={() => navigate('/examples')}><ArrowLeft />All the examples</Button>}>

      <Section plain>
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
            <code className="mr-auto truncate rounded bg-background px-2 py-1 text-xs text-muted-foreground">{exampleUrl(kind)}</code>
            <div className="flex gap-1 rounded-md border border-border p-0.5">
              <Button size="sm" variant={width === 'desktop' ? 'light' : 'ghost'} aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}><Monitor />Computer</Button>
              <Button size="sm" variant={width === 'phone' ? 'light' : 'ghost'} aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}><Smartphone />Phone</Button>
            </div>
            <Button size="sm" variant="ghost" asChild>
              <a href={exampleUrl(kind)} target="_blank" rel="noreferrer noopener"><ExternalLinkIcon />Open it in a tab</a>
            </Button>
          </div>
          <div className="flex justify-center bg-muted/30 p-3">
            <iframe src={exampleUrl(kind)} title={`The ${example.heading} example`} referrerPolicy="no-referrer"
              className={cn('h-[44rem] max-h-[80vh] rounded-md border border-border bg-white', width === 'phone' ? 'w-[24rem] max-w-full' : 'w-full')} />
          </div>
          <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
            This is the page itself, not a picture of it: scroll inside it to see the responses, and fill the form in to send one.
          </p>
        </div>
      </Section>

      <Section title="Try it" intro="This is the quickest way to see how a page like this works.">
        <ol className="ml-5 list-decimal space-y-1.5 py-1 text-sm text-muted-foreground">
          <li>Fill in the form on the page above and send it. Nothing appears yet — that's on purpose.</li>
          <li>Open <InlineLink to={`/responses?form=${example.formId ?? ''}`}>Responses</InlineLink> and click "Approve" on what you just sent.</li>
          <li>Come back here and reload. There it is.</li>
        </ol>
        <p className="mt-2 text-sm text-muted-foreground">
          {example.waiting > 0
            ? <>There {example.waiting === 1 ? 'is' : 'are'} {plural(example.waiting, 'response', 'responses')} waiting to be approved.</>
            : <>Everything sent so far has been approved.</>}
          {' '}The example keeps its newest {data.data.maxResponses} responses and lets the older ones go.
        </p>
      </Section>

      <Section title="Make one by hand" intro={`Its tutorial names every file this page is made of and prints all of them, with a Copy button on each.`}>
        <p className="text-sm text-muted-foreground">
          <InlineLink to={`/help/forms/part-${example.guidePart}`}>Part {example.guidePart} of the Forms guide: {tutorialName(example)}</InlineLink>
          {' '}walks through the questions, the two switches, and the three files &mdash; {example.pageName}, and the style and the little program that go
          in the folder beside it. The button below does the same thing for you in one go.
        </p>
      </Section>

      <Install example={example} />

      <Section title="Put it back as it was" intro="Anything you change here can be undone, including the responses.">
        <ResetButton example={example} />
      </Section>
    </Page>
  );
}

function ResetButton({ example }: { example: ExampleInList }) {
  const run = useAction();
  const qc = useQueryClient();
  const dialogs = useDialogs();
  return (
    <ActionButton icon={RotateCcw} onClick={async () => {
      const ok = await dialogs.confirm({
        title: `Put the ${example.heading} example back as it was?`, action: 'Put it back', danger: true,
        body: <>
          <p>Its questions, its wording and its three switches go back to how they started.</p>
          <p>Every response to it is deleted, and the few we wrote come back. They are examples, so they are not kept in the trash.</p>
          <p>Nothing of yours is touched: forms you made from this example, and their answers, stay exactly as they are.</p>
        </>,
      });
      if (!ok) return;
      if (await run(() => api(`/api/examples/${example.kind}/reset`, {}), 'The example is back as it was.')) {
        await qc.invalidateQueries({ queryKey: ['/api/examples'] });
        await qc.invalidateQueries({ queryKey: ['/api/forms'] });
      }
    }}>Put it back as it was</ActionButton>
  );
}

// "Put this on my website": her own page, in a folder she picks, with a form of
// her own behind it (a new one from the same questions, or one she already has).
function Install({ example }: { example: ExampleInList }) {
  const folders = useApi<{ folders: string[] }>('/api/folders');
  const forms = useApi<FormsData>('/api/forms');
  const run = useAction();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [folder, setFolder] = useState('');
  const [page, setPage] = useState(example.pageName);
  const [formId, setFormId] = useState<number | 'new'>('new');
  const [name, setName] = useState(suggestedName(example.kind));
  const [done, setDone] = useState<{ address: string; created: string[]; switchNeeded: boolean; form: { id: number; name: string } } | null>(null);

  // Forms of hers that came from this example's questions, so a second page can use one.
  const mine = (forms.data?.forms ?? []).filter((f) => !f.fixture && !f.trashedAt);

  const put = async () => {
    const pageName = page.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,60}\.html$/.test(pageName)) return notify('The page needs a name like guestbook.html: lowercase letters, digits and hyphens.', 'error');
    const newName = name.trim().toLowerCase();
    if (formId === 'new') {
      const problem = formNameProblem(newName);
      if (problem) return notify(problem, 'error');
    }
    const r = await run(() => api<{ address: string; created: string[]; switchNeeded: boolean; form: { id: number; name: string } }>(
      `/api/examples/${example.kind}/install`,
      { folder, page: pageName, ...(formId === 'new' ? { name: newName } : { formId }) },
    ), 'Your page is on your website.');
    if (!r) return;
    setDone(r);
    await qc.invalidateQueries({ queryKey: ['/api/forms'] });
  };

  if (done) {
    return (
      <Section title="It's on your website" intro="Two things left, and both are quick.">
        <ol className="ml-5 list-decimal space-y-2 py-1 text-sm">
          <li>
            Your page is at <a className="font-medium underline" href={done.address} target="_blank" rel="noreferrer noopener">{done.address}</a>.
            <span className="text-muted-foreground"> It was written as {done.created.join(', ')}. Link to it from your other pages however you like.</span>
          </li>
          <li>
            {done.switchNeeded
              ? <>Switch on <strong>"Anyone can read the approved responses"</strong> for the form "{done.form.name}" on the <InlineLink to={`/forms#form-${done.form.id}`}>Forms</InlineLink> tab.
                It asks for your passkey, because it puts what people wrote on the open internet. Until then the page shows the form but no responses.</>
              : <>The form "{done.form.name}" is ready: its responses will show as soon as you approve them.</>}
          </li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton icon={PenLine} onClick={() => navigate(`/forms/${done.form.id}`)}>Change the questions</ActionButton>
          <ActionButton icon={Eye} onClick={() => setDone(null)}>Put another one up</ActionButton>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Put this on my website" intro="The same page, in a folder of yours, with a form of your own behind it. Nothing is ever written over: if a page of that name is already there, you'll be asked for another name.">
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void put(); }}>
        <FolderPicker id={`where-${example.kind}`} label="Which folder" mainSite loading={!folders.data}
          folders={folders.data?.folders} value={folder} onChange={setFolder}
          hint="The website itself, or any folder in it." />

        <Field label="Page name" htmlFor={`page-${example.kind}`} hint="What the page is called, ending in .html. Its look and its little program go in a folder of the same name beside it.">
          <Input id={`page-${example.kind}`} value={page} autoComplete="off" autoCapitalize="none" spellCheck={false}
            onChange={(e) => setPage(e.target.value)} />
        </Field>

        <Field label="Which form collects the answers" htmlFor={`form-${example.kind}`}
          hint={formId === 'new' ? 'A new form of yours, with the same questions as the example. You can change them afterwards.' : 'A form you already have. Its questions decide what the page can show.'}>
          <select id={`form-${example.kind}`} value={String(formId)} onChange={(e) => setFormId(e.target.value === 'new' ? 'new' : Number(e.target.value))}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="new">Make me a new one</option>
            {mine.map((f) => <option key={f.id} value={f.id}>{f.title} ({f.name})</option>)}
          </select>
        </Field>

        {formId === 'new' && (
          <Field label="Name for the new form" htmlFor={`name-${example.kind}`} hint={FORM_NAME_RULE}>
            <Input id={`name-${example.kind}`} value={name} autoComplete="off" autoCapitalize="none" spellCheck={false}
              onChange={(e) => setName(e.target.value)} />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Put it on my website</Button>
          <Badge variant="warn">One switch is left afterwards</Badge>
        </div>
      </form>
    </Section>
  );
}

const tutorialName = (e: ExampleInList) => (e.kind === 'guestbook' ? 'a guest book' : e.kind === 'rsvp' ? "a list of who's coming" : 'a pinboard');

const suggestedName = (kind: string) => (kind === 'guestbook' ? 'guest-book' : kind === 'rsvp' ? 'whos-coming' : 'pinboard');
