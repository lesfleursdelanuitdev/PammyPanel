// Media › Media examples (docs/media-api-plan.md M10-M13): a gallery, a slide show,
// a list of documents and a music player -- real pages, framed from pammy.org and
// running on the built-in example folder, their code, and "Put this on my
// website", which writes the same page into a folder of hers, showing the files
// with the tags and categories she picks.
import { ArrowLeft, Copy, ExternalLink as ExternalLinkIcon, Eye, Monitor, Smartphone, ToggleRight } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ActionButton, Collapsible, Empty, Field, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { copyText, useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { scopeOf } from '@panel/files/web/lib/media';
import { siteLabel } from '@panel/core/web/lib/format';
import type { MediaLabel, MediaSites } from '@panel/files/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { SITE_ORIGIN } from '@panel/core/web/lib/site';

type MediaExample = { kind: string; heading: string; about: string; pageName: string; mediaKind: string; title: string; demo: { type: string; name: string } };
type Installed = { address: string; subdomainAddress: string | null; created: string[]; toSwitch: MediaLabel[] };

// The examples live on her website, where the media API is.
const SITE = SITE_ORIGIN;
const exampleUrl = (kind: string) => `${SITE}/_pammy/examples/${kind}/`;

export default function MediaExamples() {
  usePageTitle('Media examples');
  const data = useApi<{ examples: MediaExample[] }>('/api/media/examples');
  const navigate = useNavigate();
  return (
    <Page title="Media examples" intro="Four pages that show media from a media folder: a gallery, a slide show, a list of documents and a music player. Each shows the files with the tags and categories you choose (a file needs every one), so what's on the page changes as you tag files. Try them, then have one for yourself.">
      {!data.data ? <Loading /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.data.examples.map((e) => (
            <button key={e.kind} type="button" onClick={() => navigate(`/media/examples/${e.kind}`)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left shadow-card transition hover:border-primary/60 hover:shadow-md">
              <span className="text-base font-semibold">{e.heading}</span>
              <span className="text-sm text-muted-foreground">{e.about}</span>
              <span className="mt-auto pt-2 text-sm font-medium text-primary">Have a look, or make one →</span>
            </button>
          ))}
        </div>
      )}
      <Section title="How they work" intro="The same idea four times.">
        <ul className="ml-5 list-disc space-y-1.5 py-1 text-sm text-muted-foreground">
          <li>The page asks your website for the files in one media folder with tags and categories, like the pictures tagged <code>summer</code> and in the category <code>travel</code> (a file needs every one you ask for), and shows them. Tag a new picture and it's on the page.</li>
          <li>Only tags and categories you've switched on ("Anyone can list its files", on <InlineLink to="/tags">Tags &amp; categories</InlineLink>) can be shown. The rest stay in the panel.</li>
          <li>A title and "what it shows", given in a file's details on the Media tab, appear on the page too.</li>
          <li>The examples here run on a small example folder of our own, so they work before you have any media.</li>
        </ul>
      </Section>
    </Page>
  );
}

export function MediaExample() {
  const kind = useParams().kind ?? '';
  const data = useApi<MediaExample & { files: { path: string; content: string }[] }>(`/api/media/examples/${encodeURIComponent(kind)}`, { meta: { quiet: true } });
  usePageTitle(data.data?.heading ?? 'Media example');
  const navigate = useNavigate();
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');
  if (data.error) return <Page title="Media example"><Empty>There is no example called "{kind}". <InlineLink to="/media/examples">Back to the media examples</InlineLink></Empty></Page>;
  if (!data.data) return <Page title="Media example"><Loading /></Page>;
  const e = data.data;

  return (
    <Page wide title={e.heading} intro={e.about}
      actions={<Button variant="ghost" onClick={() => navigate('/media/examples')}><ArrowLeft />All the media examples</Button>}>
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
            <iframe src={exampleUrl(kind)} title={`The ${e.heading} example`} referrerPolicy="no-referrer" allow="autoplay"
              className={cn('h-[44rem] max-h-[80vh] rounded-md border border-border bg-white', width === 'phone' ? 'w-[24rem] max-w-full' : 'w-full')} />
          </div>
          <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
            This is the page itself, running on the example folder: it shows the files there with the {e.demo.type} <code>{e.demo.name}</code>.
          </p>
        </div>
      </Section>

      <Install example={e} />

      <Section title="The code" intro={`Three files: ${e.pageName}, and its look and its little program in the folder beside it. "Put this on my website" writes them for you; the guide explains every part.`}>
        <p className="mb-3 text-sm text-muted-foreground">
          The line that decides what it shows is <code>data-api="…"</code>: the media folder, then <code>t/</code> and a tag and/or <code>c/</code> and a category, several of each if you like.{' '}
          <InlineLink to="/help/media-on-your-pages">Media on your pages</InlineLink> explains it.
        </p>
        <div className="space-y-2">
          {e.files.map((f) => (
            <Collapsible key={f.path} summary={<code>{f.path}</code>}>
              <div className="flex justify-end pb-2"><ActionButton icon={Copy} onClick={() => copyText(f.content, f.path)}>Copy</ActionButton></div>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-[0.8125rem]"><code>{f.content}</code></pre>
            </Collapsible>
          ))}
        </div>
      </Section>
    </Page>
  );
}

// "Put this on my website": which media folder, what it shows, and the page's name.
function Install({ example: e }: { example: MediaExample }) {
  const sites = useApi<MediaSites>('/api/media');
  const withMedia = (sites.data?.folders ?? []).filter((f) => f.hasMedia);
  const [folder, setFolder] = useState<string | null>(null);
  const site = folder ?? sites.data?.limitedTo?.[0] ?? withMedia[0]?.folder ?? '';
  const labels = useApi<{ labels: MediaLabel[] }>(sites.data ? `/api/media/labels?scope=${encodeURIComponent(scopeOf(site))}` : null);
  const [tags, setTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [page, setPage] = useState(e.pageName);
  const [title, setTitle] = useState(e.title);
  const [done, setDone] = useState<Installed | null>(null);
  const run = useAction();
  // one line per name: the media API reads "summer" as the folder's summer and
  // any tag scope's inside it, together
  const of = (t: string) => {
    const byName = new Map<string, MediaLabel>();
    for (const l of (labels.data?.labels ?? []).filter((x) => x.type === t)) {
      const had = byName.get(l.name);
      byName.set(l.name, had ? { ...had, count: had.count + l.count, public: had.public || l.public } : l);
    }
    return [...byName.values()];
  };

  if (sites.data && withMedia.length === 0) {
    return <Section title="Put this on my website"><p className="text-muted-foreground">You need a media folder with some files in it first: <InlineLink to="/media/folders">make one</InlineLink>, then tag some files on the Media tab.</p></Section>;
  }
  if (done) {
    return (
      <Section title="It's on your website" intro={done.toSwitch.length ? 'One thing left.' : 'Nothing left to do.'}>
        <ol className="ml-5 list-decimal space-y-2 py-1 text-sm">
          <li>
            Your page is at <a className="font-medium underline" href={done.address} target="_blank" rel="noreferrer noopener">{done.address}</a>
            {done.subdomainAddress && <> and <a className="font-medium underline" href={done.subdomainAddress} target="_blank" rel="noreferrer noopener">{done.subdomainAddress}</a></>}.
            <span className="text-muted-foreground"> It was written as {done.created.join(', ')}.</span>
          </li>
          {done.toSwitch.length > 0 && (
            <li>
              Switch on "Anyone can list its files" for {done.toSwitch.map((l) => <code key={l.address} className="mx-0.5">{l.address}</code>)}. Until then the page shows nothing.
              It asks for your passkey, because it lets anyone see which files have it.
              <div className="mt-2 flex flex-wrap gap-2">
                {done.toSwitch.map((l) => (
                  <ActionButton key={l.address} icon={ToggleRight} onClick={async () => {
                    if (await run(() => api(`/api/media/labels/${l.type}/${l.id}`, { public: true }), `Switched on for ${l.address}.`)) {
                      setDone({ ...done, toSwitch: done.toSwitch.filter((x) => x.address !== l.address) });
                    }
                  }}>Switch it on for {l.address}</ActionButton>
                ))}
              </div>
            </li>
          )}
        </ol>
        <div className="mt-3"><ActionButton icon={Eye} onClick={() => setDone(null)}>Put another one up</ActionButton></div>
      </Section>
    );
  }
  return (
    <Section title="Put this on my website" intro={`The same page, in a folder of yours, showing ${e.mediaKind === 'images' ? 'the pictures' : e.mediaKind === 'audio' ? 'the songs' : 'the files'} with the tags and categories you choose (a file needs every one). Nothing is ever written over.`}>
      {!sites.data ? <Loading rows={2} /> : (
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (ev) => {
          ev.preventDefault();
          const r = await run(() => api<Installed>(`/api/media/examples/${e.kind}/install`, {
            folder: site, page: page.trim().toLowerCase(), title, tags, categories,
          }), 'Your page is on your website.');
          if (r) setDone(r);
        }}>
          <Field label="Media folder" htmlFor={`mx-site-${e.kind}`} hint="The page goes in the same folder, beside its media folder.">
            <NativeSelect id={`mx-site-${e.kind}`} value={site} disabled={sites.data.limitedTo?.length === 1} onChange={(ev) => { setFolder(ev.target.value); setTags([]); setCategories([]); }}>
              {withMedia.map((f) => <option key={f.folder} value={f.folder}>{siteLabel(f.folder)}</option>)}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {([['tag', 'Tags', tags, setTags], ['category', 'Categories', categories, setCategories]] as const).map(([type, heading, picked, set]) => (
              <Field key={type} label={heading}>
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border bg-card p-2">
                  {of(type).length === 0 && <p className="px-1 py-1 text-sm text-muted-foreground">None yet</p>}
                  {of(type).map((l) => {
                    const on = picked.includes(l.name);
                    return (
                      <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                        <Checkbox checked={on} onCheckedChange={() => set(on ? picked.filter((n) => n !== l.name) : [...picked, l.name])} />
                        <span className="min-w-0 truncate">{type === 'tag' ? `#${l.name}` : l.name} ({l.count}){l.public ? '' : ' – not switched on'}</span>
                      </label>
                    );
                  })}
                </div>
              </Field>
            ))}
          </div>
          <Field label="Page name" htmlFor={`mx-page-${e.kind}`} hint="Ending in .html. Its look and program go in a folder of the same name beside it.">
            <Input id={`mx-page-${e.kind}`} value={page} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(ev) => setPage(ev.target.value)} />
          </Field>
          <Field label="Heading on the page" htmlFor={`mx-title-${e.kind}`}>
            <Input id={`mx-title-${e.kind}`} value={title} maxLength={120} onChange={(ev) => setTitle(ev.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={!tags.length && !categories.length}>Put it on my website</Button>
            {!tags.length && !categories.length && <span className="ml-3 text-sm text-muted-foreground">Choose a tag or a category first.</span>}
          </div>
        </form>
      )}
    </Section>
  );
}
