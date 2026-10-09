// A project's packages (docs/phase8b-plan.md 8b-8a, docs/platform-plan.md "The Packages page"):
// what is installed, with updates, advisories and deprecations from the last check; adding a
// package from the npm registry, with what to know first; updating, removing, fixing security
// issues; and its scripts, each with a Run button. Every change is a commit to the branch
// changes go to (dev when there is one), then a build; undone if the build fails.
import { useId, useState } from 'react';
import { ArrowLeft, CircleAlert, Package, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Empty, Facts, Field, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime, timeAgo } from '@panel/core/web/lib/api';
import { JobRow, type Job } from '../components/jobs';

type Pkg = { name: string; range: string; type: 'dependencies' | 'devDependencies'; current: string | null; wanted: string | null; latest: string | null; deprecated: string | null; advisory: string | null };
type Check = { pm: 'npm' | 'pnpm'; commit: string; packages: Pkg[]; scripts: Record<string, string>; audit: Record<'low' | 'moderate' | 'high' | 'critical', number>; auditRead: boolean; branch: 'main' | 'dev'; at: number };
type View = {
  branch: 'main' | 'dev'; check: Check | null; autoUpdate: boolean; mayChange: boolean; jobs: Job[];
  project: { id: string; kind: string; pm: 'npm' | 'pnpm'; typescript: boolean; owners: string[]; dev: boolean };
};
type Found = { name: string; version: string; description: string; date: string | null; publisher: string | null; license: string | null; weekly: number | null };
type About = {
  found: boolean; name: string; version?: string; description?: string; license?: string | null; created?: string | null; published?: string | null; weekly?: number | null;
  deprecated?: string | null; installScripts?: boolean; types?: string | null; size?: number | null; homepage?: string | null; warnings?: { kind: string; text: string }[];
};
type Pick = { name: string; version: string; dev: boolean };

// A new major version of a framework is upgraded together with its companions (8b-8b, D8b-6):
// those of them the project has, to their latest, on dev when it has it, undone if the build fails
const UPGRADES = [
  { label: 'Next.js', lead: 'next', with: ['eslint-config-next', 'react', 'react-dom', '@types/react', '@types/react-dom'], guide: 'https://nextjs.org/docs/app/guides/upgrading' },
  { label: 'React', lead: 'react', with: ['react-dom', '@types/react', '@types/react-dom'], guide: 'https://react.dev/blog' },
  { label: 'Vite', lead: 'vite', with: ['@vitejs/plugin-react', '@vitejs/plugin-vue', '@sveltejs/vite-plugin-svelte', '@tailwindcss/vite', 'vitest'], guide: 'https://vite.dev/guide/migration' },
];
const majorOf = (v: string | null) => Number(/^(\d+)/.exec(v ?? '')?.[1] ?? NaN);

// the scripts that serve and never finish (packages/projects/src/record.ts LONG_RUNNING)
const LONG_RUNNING = ['dev', 'start', 'preview', 'serve'];
const SEVERITY: Record<string, 'danger' | 'warn' | 'outline'> = { critical: 'danger', high: 'danger', moderate: 'warn', low: 'outline' };
const working = (v: View) => v.jobs.some((j) => j.state === 'queued' || j.state === 'running');
const count = (n: number | null | undefined) => (n === null || n === undefined ? '?' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export default function Packages() {
  const { id = '' } = useParams();
  usePageTitle(`Packages: ${id}`);
  const run = useAction();
  const dialogs = useDialogs();
  const data = useApi<View>(`/api/projects/${id}/packages`, { refetchInterval: (q) => (q.state.data && working(q.state.data) ? 2000 : 30_000) });
  const v = data.data;
  const busy = !v || working(v) || !v.mayChange;
  const c = v?.check ?? null;
  const change = (body: Record<string, unknown>, words: string) => run(() => api(`/api/projects/${id}/packages`, { change: body }), words);
  const where = v ? (v.branch === 'dev' ? 'dev (its preview), so you try it there first' : 'main (live)') : '';
  const outdated = c?.packages.filter((p) => p.latest && p.current && p.latest !== p.current) ?? [];
  const advisories = c ? Object.values(c.audit).reduce((a, b) => a + b, 0) : 0;
  return (
    <Page title={`Packages: ${id}`} intro={v && <>The npm packages {id} uses ({v.project.pm}). A change is committed to {where}, then built; if the build fails, it is undone.</>}
      actions={<Button size="sm" variant="outline" asChild><Link to="/projects"><ArrowLeft />Projects</Link></Button>}>
      <Section title="Installed"
        intro={c ? <>Checked <time title={formatTime(c.at)}>{timeAgo(c.at)}</time> on {c.branch}, commit <span className="font-mono">{c.commit.slice(0, 7)}</span>.</> : v && 'Not checked yet.'}
        action={<div className="flex flex-wrap gap-2">
          <ActionButton icon={RefreshCw} disabled={busy} onClick={() => run(() => api(`/api/projects/${id}/packages/check`, {}), `Checking ${id}'s packages: it runs after any job waiting.`)}>{c ? 'Check again' : 'Check packages'}</ActionButton>
          {c && <ActionButton icon={RefreshCw} disabled={busy} onClick={() => change({ update: 'all' }, `Updating ${id}'s packages within their ranges (minor and patch).`)}>Update all (minor and patch)</ActionButton>}
          {advisories > 0 && <ActionButton icon={ShieldCheck} disabled={busy} onClick={() => change({ fix: true }, `Fixing ${id}'s security issues (the fixes that break nothing).`)}>Fix security issues</ActionButton>}
        </div>}>
        {c && (
          <p data-testid="audit" className="border-b border-border px-4 py-2.5 text-sm sm:px-5">
            {!c.auditRead ? <span className="text-muted-foreground">The security check didn't answer.</span>
              : advisories === 0 ? <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4 text-success" aria-hidden />No known security issues.</span>
                : <span className="inline-flex flex-wrap items-center gap-1.5"><CircleAlert className="size-4 text-destructive" aria-hidden />Security issues: {(['critical', 'high', 'moderate', 'low'] as const).filter((k) => c.audit[k]).map((k) => `${c.audit[k]} ${k}`).join(', ')}.</span>}
            {outdated.length > 0 && <> {outdated.length} with a newer version.</>}
          </p>
        )}
        <List label="Installed packages">
          {!v ? <Loading rows={3} /> : !c ? <Empty>Check its packages to see them here.</Empty> : c.packages.length === 0 ? <Empty>No packages.</Empty>
            : c.packages.map((p) => (
              <Row key={p.name} title={<span className="font-mono">{p.name}</span>}
                badges={<>
                  {p.type === 'devDependencies' && <Badge variant="outline">dev</Badge>}
                  {p.latest && p.current && p.latest !== p.current && <Badge variant="warn">{p.latest} available</Badge>}
                  {p.advisory && <Badge variant={SEVERITY[p.advisory] ?? 'warn'}>security: {p.advisory}</Badge>}
                  {p.deprecated && <Badge variant="danger">deprecated</Badge>}
                </>}
                meta={<Facts items={[`asks for ${p.range}`, p.current ? `installed ${p.current}` : 'not installed', p.latest && `latest ${p.latest}`, p.deprecated && `"${p.deprecated}"`]} />}
                actions={<>
                  {p.latest && p.current && p.latest !== p.current && <ActionButton disabled={busy} onClick={() => change({ update: [p.name] }, `Updating ${p.name} to ${p.latest}.`)}>Update</ActionButton>}
                  <ActionButton variant="ghost" icon={Trash2} disabled={busy} aria-label={`Remove ${p.name}`} onClick={async () => {
                    if (!await dialogs.confirm({ title: `Remove ${p.name}?`, action: 'Remove', danger: true, body: `It is taken out of package.json, committed to ${v!.branch} and built. If the build fails (its code still uses it), nothing changes.` })) return;
                    await change({ remove: [p.name] }, `Removing ${p.name}.`);
                  }}>Remove</ActionButton>
                </>} />
            ))}
        </List>
      </Section>

      {v && c && <Updates v={v} c={c} busy={busy} change={change} />}

      {v?.mayChange && <AddPackages id={id} typescript={v.project.typescript} busy={busy} />}

      <Section title="Scripts" className="mt-6" intro="The scripts in its package.json. Each runs in the build container, with its environment; the output is in its job's log.">
        <List label="Scripts">
          {!c ? <Empty>Check its packages to see them here.</Empty> : Object.keys(c.scripts).length === 0 ? <Empty>No scripts.</Empty>
            : Object.entries(c.scripts).map(([name, cmd]) => (
              <Row key={name} title={<span className="font-mono">{name}</span>} meta={<span className="font-mono [overflow-wrap:anywhere]">{cmd}</span>}
                actions={LONG_RUNNING.includes(name) ? <span className="text-sm text-muted-foreground">serves, never finishes: not run here</span>
                  : <ActionButton icon={Play} disabled={busy} onClick={() => run(() => api(`/api/projects/${id}/scripts/run`, { script: name }), `Running ${name}: its output is in the job's log below.`)}>Run</ActionButton>} />
            ))}
        </List>
      </Section>

      <Section title="Jobs" className="mt-6" intro={`What the projects helper did lately for ${id}, newest first.`}>
        <List label="Jobs">
          {!v ? <Loading rows={2} /> : v.jobs.length === 0 ? <Empty>Nothing yet.</Empty> : v.jobs.map((j) => <JobRow key={j.id} j={j} />)}
        </List>
      </Section>
    </Page>
  );
}

// Updates (8b-8b): new major versions of the frameworks, each upgraded with its companions; and
// whether the project updates itself each night (within its ranges)
function Updates({ v, c, busy, change }: { v: View; c: Check; busy: boolean; change: (body: Record<string, unknown>, words: string) => Promise<unknown> }) {
  const run = useAction();
  const has = new Map(c.packages.map((p) => [p.name, p]));
  const majors = UPGRADES.map((u) => ({ ...u, p: has.get(u.lead) })).filter((u) => u.p && majorOf(u.p.latest) > majorOf(u.p.current))
    // React comes with Next.js's upgrade when both are due
    .filter((u, _, all) => !(u.lead === 'react' && all.some((x) => x.lead === 'next')));
  return (
    <Section title="Updates" className="mt-6" intro="Checked each night (and whenever you press Check again). Patch and minor updates stay within the versions package.json asks for; a new major version can change how the code has to be written.">
      <ul aria-label="New major versions" className="divide-y divide-border">
        {majors.length === 0 ? <li className="px-4 py-3 text-sm text-muted-foreground sm:px-5">No new major version of Next.js, React or Vite.</li> : majors.map((u) => {
          const names = [u.lead, ...u.with.filter((n) => has.has(n))];
          return (
            <li key={u.lead} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-5">
              <span><strong className="font-semibold">{u.label} {majorOf(u.p!.latest)}</strong> is out (it has {u.p!.current}). Upgraded together: <span className="font-mono">{names.join(', ')}</span>, on {v.branch}; if the build fails it is undone, and its <a href={u.guide} target="_blank" rel="noreferrer" className="font-semibold text-primary underline-offset-2 hover:underline">upgrade guide</a> says what to change.</span>
              {v.mayChange && <ActionButton disabled={busy} onClick={() => change({ update: names }, `Upgrading ${u.label} to ${majorOf(u.p!.latest)} on ${v.branch}: then it is built.`)}>Upgrade {u.label} to {majorOf(u.p!.latest)}</ActionButton>}
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border px-4 py-3 sm:px-5">
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox checked={v.autoUpdate} disabled={!v.mayChange} onCheckedChange={(x) => run(() => api(`/api/projects/${v.project.id}/auto-update`, { on: x === true }),
            x === true ? `${v.project.id}'s packages are updated each night.` : `${v.project.id}'s packages are no longer updated each night.`)} />
          <span>Each night, update its packages within their versions (minor and patch), committed to {v.branch} and built; undone if the build fails.{v.branch === 'main' && ' It has no dev branch, so that goes live.'}</span>
        </label>
      </div>
    </Section>
  );
}

// Add: search the registry, look at one (its warnings), pick several, install them together
function AddPackages({ id, typescript, busy }: { id: string; typescript: boolean; busy: boolean }) {
  const run = useAction();
  const uid = useId();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const found = useApi<{ results: Found[] }>(asked ? `/api/projects/packages/search?q=${encodeURIComponent(asked)}` : null, { staleTime: 60_000 });
  const add = (p: Pick) => setPicks((x) => [...x.filter((y) => y.name !== p.name), p]);
  return (
    <Section title="Add a package" className="mt-6" intro="Any package from the npm registry. What to know about one is shown before it is added; nothing is blocked.">
      <form role="search" className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-4 sm:px-5" onSubmit={(e) => { e.preventDefault(); setAsked(q.trim()); setOpen(null); }}>
        <Field label="Search the npm registry" htmlFor={`${uid}-q`}>
          <Input id={`${uid}-q`} value={q} autoCapitalize="none" spellCheck={false} autoComplete="off" onChange={(e) => setQ(e.target.value)} placeholder="date picker, zod, …" />
        </Field>
        <Button type="submit" size="sm" disabled={!q.trim()}><Search />Search</Button>
      </form>
      {asked && (
        <List label="Search results">
          {found.isLoading ? <Loading rows={3} /> : found.error ? <Empty>The registry didn't answer: try again in a moment.</Empty>
            : !found.data?.results.length ? <Empty>Nothing found for "{asked}".</Empty>
              : found.data.results.map((r) => (
                <Row key={r.name} title={<span className="font-mono">{r.name}</span>}
                  badges={picks.some((p) => p.name === r.name) && <Badge variant="ok">picked</Badge>}
                  meta={<Facts items={[r.description, `${r.version}`, r.date && `released ${r.date.slice(0, 10)}`, `${count(r.weekly)} a week`, r.license]} />}
                  actions={<Button size="sm" variant="outline" aria-expanded={open === r.name} onClick={() => setOpen((o) => (o === r.name ? null : r.name))}>{open === r.name ? 'Close' : 'Look at it'}</Button>}>
                  {open === r.name && <AboutPackage name={r.name} typescript={typescript} onPick={add} />}
                </Row>
              ))}
        </List>
      )}
      {picks.length > 0 && (
        <div className="grid gap-2 border-t border-border px-4 py-4 sm:px-5">
          <h3 className="text-sm font-semibold">To add</h3>
          <ul aria-label="Packages to add" className="flex flex-wrap gap-2">
            {picks.map((p) => (
              <li key={p.name} className="inline-flex items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-1 font-mono text-sm">
                {p.name}@{p.version || 'latest'}{p.dev && <span className="font-sans text-muted-foreground"> (dev)</span>}
                <Button size="icon" variant="ghost" className="size-6" aria-label={`Don't add ${p.name}`} onClick={() => setPicks((x) => x.filter((y) => y.name !== p.name))}><X /></Button>
              </li>
            ))}
          </ul>
          <div>
            <ActionButton icon={Package} disabled={busy} onClick={async () => {
              const done = await run(() => api(`/api/projects/${id}/packages`, { change: { add: picks.map((p) => ({ name: p.name, ...(p.version ? { version: p.version } : {}), ...(p.dev ? { dev: true } : {}) })) } }),
                `Adding ${picks.map((p) => p.name).join(', ')}: then it is built.`);
              if (done) { setPicks([]); setOpen(null); }
            }}>Install {picks.length === 1 ? 'it' : `these ${picks.length}`}</ActionButton>
          </div>
        </div>
      )}
    </Section>
  );
}

function AboutPackage({ name, typescript, onPick }: { name: string; typescript: boolean; onPick: (p: Pick) => void }) {
  const uid = useId();
  const about = useApi<About>(`/api/projects/packages/about?name=${encodeURIComponent(name)}&lang=${typescript ? 'ts' : 'js'}`, { staleTime: 300_000 });
  const [version, setVersion] = useState('');
  const [dev, setDev] = useState(false);
  const [withTypes, setWithTypes] = useState(true);
  const a = about.data;
  if (about.isLoading) return <div className="mt-2"><Loading rows={2} /></div>;
  if (!a || !a.found) return <p className="mt-2 text-sm text-muted-foreground">{about.error ? "The registry didn't answer." : 'No such package.'}</p>;
  const typesPkg = a.types && a.types !== 'built-in' ? a.types : null;
  return (
    <div data-testid="about-package" className="mt-3 grid gap-3 rounded-md border border-border p-3 text-sm">
      {a.description && <p>{a.description}</p>}
      <Facts items={[`latest ${a.version}`, a.published && `released ${a.published.slice(0, 10)}`, a.created && `first ${a.created.slice(0, 10)}`, `${count(a.weekly)} downloads a week`,
        a.license ?? 'no licence', a.size ? `${Math.max(1, Math.round(a.size / 1024))} KB` : null,
        typescript ? (a.types === 'built-in' ? 'its own types' : typesPkg ? `types in ${typesPkg}` : 'no types') : null]} />
      {(a.warnings ?? []).length > 0 ? (
        <ul aria-label={`What to know about ${name}`} className="grid gap-1.5">
          {a.warnings!.map((w) => (
            <li key={w.kind} className="flex items-start gap-2 text-warning"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{w.text}</span></li>
          ))}
        </ul>
      ) : <p className="inline-flex items-center gap-1.5 text-muted-foreground"><ShieldCheck className="size-4 text-success" aria-hidden />Nothing to warn about.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Version" htmlFor={`${uid}-v`} hint="Empty: the latest.">
          <Input id={`${uid}-v`} className="w-32 font-mono" value={version} spellCheck={false} autoComplete="off" onChange={(e) => setVersion(e.target.value.trim())} placeholder={a.version} />
        </Field>
        <label className="flex items-center gap-2.5 pb-2"><Checkbox checked={dev} onCheckedChange={(x) => setDev(x === true)} /><span>Only while building (a dev dependency)</span></label>
        {typesPkg && <label className="flex items-center gap-2.5 pb-2"><Checkbox checked={withTypes} onCheckedChange={(x) => setWithTypes(x === true)} /><span>Also {typesPkg} (dev)</span></label>}
      </div>
      <div>
        <Button size="sm" onClick={() => { onPick({ name, version, dev }); if (typesPkg && withTypes) onPick({ name: typesPkg, version: '', dev: true }); }}><Plus />Pick it</Button>
      </div>
    </div>
  );
}
