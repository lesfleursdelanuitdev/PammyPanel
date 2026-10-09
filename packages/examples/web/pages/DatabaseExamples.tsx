// Databases › Database examples (docs/db-examples-plan.md): a recipe book on
// Postgres and a blog on MariaDB. Each is a real database the panel owns --
// open it in the Database Manager, add a recipe in its app -- and a public page
// that reads it without a key, framed here from pammy.org. "Make my own" builds
// the same thing as a database of hers, with the page in a folder of her site.
import {
  ArrowLeft, Boxes, Copy, ExternalLink as ExternalLinkIcon, Monitor, RotateCcw, Shapes, Smartphone, Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { FolderPicker } from '@panel/core/web/components/folder-picker';
import { ActionButton, Collapsible, Empty, Field, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { copyText, useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { newIdentProblem, type DatabaseEngine } from '@panel/studio/web/lib/schema';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';
import { cap, SITE_ORIGIN, W } from '@panel/core/web/lib/site';

type DbExample = {
  kind: 'recipes' | 'blog';
  heading: string;
  about: string;
  engine: DatabaseEngine;
  database: string;
  title: string;
  suggested: { name: string; title: string; pageName: string };
  pictures: number;
  setUp: boolean;
  active: boolean;
};

type Made = { engine: DatabaseEngine; name: string; title: string; rows: number; address: string; subdomainAddress: string | null };

const ENGINE_NAMES: Record<DatabaseEngine, string> = { postgres: 'Postgres', mariadb: 'MariaDB' };
// the table her app opens on, and the page it is about
const MAIN: Record<DbExample['kind'], string> = { recipes: 'recipes', blog: 'posts' };
// what each is made of, in a sentence per table
const MADE_OF: Record<DbExample['kind'], [string, string][]> = {
  recipes: [
    ['recipes', 'the recipes themselves: title, a summary, the method, how long, whether it is vegetarian, and a picture'],
    ['cooks', 'who each recipe is from. One cook has many recipes'],
    ['ingredients', 'what goes in, in order. One recipe has many ingredients, and they go when it does'],
    ['tags', 'quick, baking, summer… Many recipes have many tags, through a small connecting table, recipe_tags'],
  ],
  blog: [
    ['posts', 'the posts: title, its address, a summary, the writing, the date, and a "published" tick'],
    ['authors', 'who wrote each one. One author has many posts'],
    ['topics', 'garden, kitchen, travel… Many posts have many topics, through post_topics'],
  ],
};

// The examples live on her website, where the data API is.
const SITE = SITE_ORIGIN;
const exampleUrl = (kind: string) => `${SITE}/_pammy/examples/${kind}/`;
const GUIDE = '/help/databases-in-the-control-panel#part-16';

export default function DatabaseExamples() {
  usePageTitle('Database examples');
  const data = useApi<{ examples: DbExample[] }>('/api/databases/examples');
  const navigate = useNavigate();
  return (
    <Page title="Database examples"
      intro={`Two small ${W.app.many} built with the Database Manager: a recipe book and a blog. Each is a real database with tables, connections and some sample records, ${W.app.a} for adding to it, and a public page that shows it. Look inside, change things, then make your own.`}>
      {!data.data ? <Loading /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.data.examples.map((e) => (
            <button key={e.kind} type="button" onClick={() => navigate(`/databases/examples/${e.kind}`)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left shadow-card transition hover:border-primary/60 hover:shadow-md">
              <span className="flex items-center gap-2 text-base font-semibold">
                {e.heading}<Badge variant="outline">{ENGINE_NAMES[e.engine]}</Badge>
              </span>
              <span className="text-sm text-muted-foreground">{e.about}</span>
              <span className="mt-auto pt-2 text-sm font-medium text-primary">{e.setUp ? 'Have a look, or make one →' : 'Set it up and have a look →'}</span>
            </button>
          ))}
        </div>
      )}
      <Section title="What you are looking at" intro="Three parts, and all three are things you can make yourself.">
        <ul className="ml-5 list-disc space-y-1.5 py-1 text-sm text-muted-foreground">
          <li><strong className="text-foreground">The database</strong>: tables and the connections between them, drawn on the canvas like any database of yours.</li>
          <li><strong className="text-foreground">The {W.app.one}</strong>: pages in the panel for adding and changing recipes or posts, worked out from the tables.</li>
          <li><strong className="text-foreground">The public page</strong>: a page anyone can read, which asks the database for what it shows. Only the tables set to “Anyone can read these” answer it, and nobody can change anything through it.</li>
          <li>The examples belong to the panel, so they can't be deleted — change them as much as you like, and “Put it back as it was” undoes it all. “Make my own” gives you one that is entirely yours. <InlineLink to={GUIDE}>The guide</InlineLink> walks through both.</li>
        </ul>
      </Section>
    </Page>
  );
}

export function DatabaseExample() {
  const kind = useParams().kind ?? '';
  const list = useApi<{ examples: DbExample[] }>('/api/databases/examples');
  const code = useApi<{ files: { path: string; content: string }[] }>(`/api/databases/examples/${encodeURIComponent(kind)}`, { meta: { quiet: true } });
  const e = list.data?.examples.find((x) => x.kind === kind);
  usePageTitle(e?.heading ?? 'Database example');
  const navigate = useNavigate();
  const run = useAction();
  const dialogs = useDialogs();
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');
  // bumped after a reset, so the framed page is read again
  const [shown, setShown] = useState(0);

  if (list.data && !e) return <Page title="Database example"><Empty>There is no example called "{kind}". <InlineLink to="/databases/examples">Back to the database examples</InlineLink></Empty></Page>;
  if (!e) return <Page title="Database example"><Loading /></Page>;

  const setUp = async () => {
    const r = await run(() => api(`/api/databases/examples/${e.kind}/setup`, {}),
      `The ${e.heading.toLowerCase()} is ready, with its sample ${e.kind === 'recipes' ? 'recipes' : 'posts'}.`);
    if (r) setShown((n) => n + 1);
  };
  const reset = async () => {
    const ok = await dialogs.confirm({
      title: `Put the ${e.heading.toLowerCase()} back as it was?`,
      body: <>Its database is made again from the start: the tables, the sample records and the {W.app.one}'s settings as they were shipped. <strong>Anything you added to it or changed goes.</strong> Your own copies are not touched.</>,
      action: 'Put it back', danger: true,
    });
    if (ok) await setUp();
  };

  const base = `/databases/${e.engine}/${e.database}`;
  return (
    <Page wide title={e.heading} intro={e.about}
      actions={<Button variant="ghost" onClick={() => navigate('/databases/examples')}><ArrowLeft />All the database examples</Button>}>

      {!e.setUp ? (
        <Section title="Set it up"
          intro={`The panel makes the example's database on your ${ENGINE_NAMES[e.engine]} — ${e.database} — with its tables and some sample records, and switches its ${W.app.one} on. It asks for your passkey, because the public page lets anyone read the sample records.`}>
          <Button onClick={() => void setUp()}><Sparkles />Set up the {e.heading.toLowerCase()}</Button>
        </Section>
      ) : <>
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
              <iframe key={shown} src={exampleUrl(kind)} title={`The ${e.heading} example`} referrerPolicy="no-referrer"
                className={cn('h-[44rem] max-h-[80vh] rounded-md border border-border bg-white', width === 'phone' ? 'w-[24rem] max-w-full' : 'w-full')} />
            </div>
            <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
              This is the public page itself, reading the example database {e.database} on your {ENGINE_NAMES[e.engine]}.
              {e.kind === 'blog' && ` One post is not published, so it is not here — open the ${W.app.one} to see it.`}
            </p>
          </div>
        </Section>

        <Section title="Look inside"
          intro={`The same database, seen from the Database Manager. Add a recipe in the ${W.app.one} and it is on the page above; draw a new field on the canvas and apply it.`}
          action={<div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild><Link to={`${base}/canvas`}><Shapes />The canvas</Link></Button>
            <Button variant="outline" size="sm" asChild><Link to={`${base}/app`}><Boxes />Its {W.app.one} settings</Link></Button>
            <Button size="sm" asChild><Link to={`/app/${e.engine}/${e.database}/${MAIN[e.kind]}`}>Open the {W.app.one}</Link></Button>
          </div>}>
          <ul className="divide-y divide-border text-sm">
            {MADE_OF[e.kind].map(([t, about]) => (
              <li key={t} className="py-2"><code className="font-medium">{t}</code> — <span className="text-muted-foreground">{about}.</span></li>
            ))}
          </ul>
        </Section>
      </>}

      <MakeMine example={e} />

      <Section title="The code" intro={`Three files: ${e.suggested.pageName}, and its look and its little program in the folder beside it. “Make my own” writes them for you, pointed at your database.`}>
        <p className="mb-3 text-sm text-muted-foreground">
          The line that decides what it reads is <code>data-api="…"</code>: the address of a database's tables. The program asks it for
          {e.kind === 'recipes' ? ' /recipes, /tags and /ingredients' : ' /posts and /topics'}, and each answer brings its connections with it.{' '}
          <InlineLink to={GUIDE}>The guide</InlineLink> explains every part.
        </p>
        {!code.data ? <Loading rows={2} /> : (
          <div className="space-y-2">
            {code.data.files.map((f) => (
              <Collapsible key={f.path} summary={<code>{f.path}</code>}>
                <div className="flex justify-end pb-2"><ActionButton icon={Copy} onClick={() => copyText(f.content, f.path)}>Copy</ActionButton></div>
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-[0.8125rem]"><code>{f.content}</code></pre>
              </Collapsible>
            ))}
          </div>
        )}
      </Section>

      {e.setUp && (
        <Section title="Put it back as it was" intro="Changed the example until it no longer makes sense? This makes its database again, exactly as it was shipped.">
          <ActionButton icon={RotateCcw} onClick={() => void reset()}>Put it back as it was</ActionButton>
        </Section>
      )}
    </Page>
  );
}

// "Make my own" (X3): her database, the same tables and app, the page in a
// folder of hers -- and the sample records only if she ticks the box.
function MakeMine({ example: e }: { example: DbExample }) {
  const folders = useApi<{ folders: string[] }>('/api/folders');
  const run = useAction();
  const [engine, setEngine] = useState<DatabaseEngine>(e.engine);
  const [name, setName] = useState(e.suggested.name);
  const [title, setTitle] = useState(e.suggested.title);
  const [folder, setFolder] = useState('');
  const [page, setPage] = useState(e.suggested.pageName);
  const [rows, setRows] = useState(false);
  const [done, setDone] = useState<Made | null>(null);

  if (done) {
    return (
      <Section title="It's yours" intro={`Everything below is yours to change or delete, like anything you made yourself.`}>
        <ol className="ml-5 list-decimal space-y-2 py-1 text-sm">
          <li>
            Your page is at <a className="font-medium underline" href={done.address} target="_blank" rel="noreferrer noopener">{done.address}</a>
            {done.subdomainAddress && <> and <a className="font-medium underline" href={done.subdomainAddress} target="_blank" rel="noreferrer noopener">{done.subdomainAddress}</a></>}.
          </li>
          <li>
            The database is <InlineLink to={`/databases/${done.engine}/${done.name}`}>{done.name}</InlineLink> on your {ENGINE_NAMES[done.engine]}
            {done.rows ? `, with the sample ${e.kind === 'recipes' ? 'recipes' : 'posts'} to start from` : ', empty and ready'}.
          </li>
          <li>
            Its {W.app.one}, <InlineLink to={`/app/${done.engine}/${done.name}/${MAIN[e.kind]}`}>{done.title}</InlineLink>, is in your menu:
            {e.kind === 'recipes' ? ' add a recipe there and it is on the page.' : ' write a post there, tick “Published”, and it is on the page.'}
          </li>
        </ol>
        <div className="mt-3"><ActionButton icon={Sparkles} onClick={() => setDone(null)}>Make another</ActionButton></div>
      </Section>
    );
  }

  const make = async () => {
    const clean = name.trim();
    const problem = newIdentProblem(clean, 'table');
    if (problem) return notify(problem.replace('table', 'database'), 'error');
    const pageName = page.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,60}\.html$/.test(pageName)) return notify(`The page needs a name like ${e.suggested.pageName}: lowercase letters, digits and hyphens.`, 'error');
    const r = await run(() => api<Made>(`/api/databases/examples/${e.kind}/copy`, {
      engine, name: clean, title: title.trim(), folder, page: pageName, rows,
    }), (x) => `${x.title} is yours: the database, its ${W.app.one} and the page.`);
    if (r) setDone(r);
  };

  return (
    <Section title="Make my own"
      intro={`A database of your own with the same tables and connections, its ${W.app.one} switched on, and the page in a folder of ${W.website.your}, reading it. It asks for your passkey: the page lets anyone read what you put in it${e.kind === 'blog' ? ' (posts only once they are published)' : ''}. Nothing is ever written over.`}>
      <form className="grid items-start gap-4 sm:grid-cols-2" onSubmit={(ev) => { ev.preventDefault(); void make(); }}>
        <Field label="Which kind of database" htmlFor={`dbx-engine-${e.kind}`} hint="Either works the same. The example is on the one it says.">
          <NativeSelect id={`dbx-engine-${e.kind}`} value={engine} onChange={(ev) => setEngine(ev.target.value as DatabaseEngine)}>
            <option value="postgres">Postgres</option>
            <option value="mariadb">MariaDB</option>
          </NativeSelect>
        </Field>
        <Field label="Database name" htmlFor={`dbx-name-${e.kind}`} hint="Lowercase letters, digits and underscores.">
          <Input id={`dbx-name-${e.kind}`} value={name} maxLength={63} autoComplete="off" autoCapitalize="none" spellCheck={false}
            onChange={(ev) => setName(ev.target.value)} />
        </Field>
        <Field label={`${cap(W.app.one)} name`} htmlFor={`dbx-title-${e.kind}`} hint="In your menu, and the heading on the page.">
          <Input id={`dbx-title-${e.kind}`} value={title} maxLength={60} onChange={(ev) => setTitle(ev.target.value)} />
        </Field>
        <Field label="Page name" htmlFor={`dbx-page-${e.kind}`} hint="Ending in .html. Its look and program go in a folder of the same name beside it.">
          <Input id={`dbx-page-${e.kind}`} value={page} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(ev) => setPage(ev.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <FolderPicker id={`dbx-where-${e.kind}`} label="Which folder of your website" mainSite loading={!folders.data}
            folders={folders.data?.folders} value={folder} onChange={setFolder} />
        </div>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <Checkbox checked={rows} onCheckedChange={(v) => setRows(v === true)} className="mt-0.5" />
          <span>
            Copy the sample records too
            <span className="block text-muted-foreground">
              {e.kind === 'recipes' ? `The recipes, cooks and tags — and their ${e.pictures} pictures, beside your page.` : 'The posts, authors and topics.'} Leave it empty to start from nothing.
            </span>
          </span>
        </label>
        <div className="sm:col-span-2"><Button type="submit"><Sparkles />Make my own {e.heading.toLowerCase()}</Button></div>
      </form>
    </Section>
  );
}
