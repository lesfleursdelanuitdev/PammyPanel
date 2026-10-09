// Projects (docs/phase8b-plan.md). 8b-1: the build environment (the user and image every
// build runs as and in) with a check that runs it, and the helper's jobs with their logs.
// 8b-2: static projects -- New project (React, Vue, Svelte, Lit, a Next.js export), each
// project's live release, Rebuild, the kept releases to roll back to, Delete.
// 8b-3: git and the dev branch -- a preview at <name>-dev (only people let in), Put dev live,
// owners (only they or an admin change a project), the SSH address to clone it from.
// 8b-4a: Next.js servers -- each branch running or not, Start / Stop / Restart, its log.
// 8b-4b: each branch's environment -- names shown, values after a fresh passkey (D4-11).
// 8b-5: each branch's database (Postgres or MariaDB), and dev using the live one.
import { useId, useState } from 'react';
import { ArrowUpFromLine, CircleAlert, CircleCheck, Database, Eye, EyeOff, FileText, Link2, Link2Off, GitBranch, Hammer, History, KeyRound, Package, Pencil, Play, Plus, RefreshCw, RotateCw, Square, Trash2, Users, X } from 'lucide-react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Addresses, Empty, Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, formatTime, timeAgo } from '@panel/core/web/lib/api';
import { may } from '@panel/core/web/lib/rights';
import { SITE } from '@panel/core/web/lib/site';
import { JobRow, WHAT, type Job } from '../components/jobs';

type Versions = { node: string; npm: string; pnpm: string; git: string };
type Release = { id: string; commit: string; at: number; by: string; files: number; bytes: number };
type Branch = 'main' | 'dev';
type BranchDatabase = { engine: 'postgres' | 'mariadb'; name: string; owner: string; app: string; at: number; by: string; shared?: boolean };
type BranchState = { live: Release | null; releases: Release[]; stopped?: boolean; database?: BranchDatabase | null };
type Project = {
  id: string; kind: string; pm: 'npm' | 'pnpm'; typescript: boolean; tailwind: boolean; createdAt: number; createdBy: string;
  branches: Partial<Record<Branch, BranchState>>;
  owners: string[]; pushers: string[]; group: string; mayChange: boolean;
  // a server's branches (8b-4a): its live slot as systemd sees it
  running?: Partial<Record<Branch, { unit: string; port: number; active: string; sub: string; masked: boolean }>>;
  shownAt: { address: string; live: boolean; branch: Branch; accounts: string | null }[];
  // the last check of its packages, in short (8b-8b)
  packages?: { at: number | null; outdated: number; inRange: number; majors: string[]; advisories: number } | null;
};
type Making = { id: string; kind: string; dev: boolean };
type ProjectsView = {
  info: {
    user: string | null; image: string | null; ports: { min: number; max: number; used: number }; projects: number; busy: boolean;
    lastCheck: { id: string; state: 'done' | 'failed'; at: number | null; result: Versions | null; error: string | null } | null;
  };
  projects: Project[];
  making: Making[];
  jobs: Job[];
  ssh: { host: string; root: string };
  me: string;
  candidates: { username: string; name: string }[];
  maxOwners: number;
};

// what the panel makes (the server says so too); Laravel comes with 8b-6
const KINDS: { kind: string; label: string }[] = [
  { kind: 'react', label: 'React' }, { kind: 'vue', label: 'Vue' }, { kind: 'svelte', label: 'Svelte' }, { kind: 'lit', label: 'Lit' },
  { kind: 'next-static', label: 'Next.js, static export' }, { kind: 'next', label: 'Next.js (a server)' },
];
const KIND_LABEL: Record<string, string> = Object.fromEntries([...KINDS.map((k) => [k.kind, k.label]), ['laravel', 'Laravel']]);
const SERVER_KINDS = ['next'];
// the rules the helper keeps (packages/projects/src/helper/ops.ts ENV_NAME_RE, PANEL_ENV, PUBLIC_ENV)
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PUBLIC_ENV = ['NEXT_PUBLIC_', 'VITE_'];
type EnvView = { vars: { name: string; public: boolean; oldHost?: boolean }[]; max: number; panel: string[] };
// docs/s1-plan.md S1f (b): a project's server is on pasta, where 10.0.2.2 reaches nothing
const OLD_HOST = '10.0.2.2';
type EnvSaved = { name: string; removed: boolean; needs: 'rebuild' | 'restart' | 'nothing'; public: boolean };
// the rule the server keeps (packages/projects/src/record.ts isProjectId)
const NAME_RE = /^[a-z](?:[a-z0-9-]{0,34}[a-z0-9])?$/;
const nameProblem = (n: string) => (!n ? null
  : !NAME_RE.test(n) || n.includes('--') ? 'Lowercase letters, digits and dashes, starting with a letter, at most 36.'
    : n.endsWith('-dev') ? 'Not ending in -dev: that name is for its preview.' : null);
// host names kept for the site itself (packages/hosts/src/names.ts RESERVED_HOSTS)
const RESERVED_HOSTS = ['panel', 'www', 'api', 'mail', 'git'];
const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

const working = (d: ProjectsView) => d.jobs.some((j) => j.state === 'queued' || j.state === 'running');

export default function Projects() {
  usePageTitle('Projects');
  const run = useAction();
  // every 2 seconds while a job waits or runs
  const data = useApi<ProjectsView>('/api/projects', { refetchInterval: (q) => (q.state.data && working(q.state.data) ? 2000 : 30_000) });
  const d = data.data;
  const active = d ? working(d) : false;
  const [adding, setAdding] = useState(false);
  const check = d?.info.lastCheck;
  const view = d;
  const jobOf = (p: string) => d?.jobs.find((j) => j.project === p && (j.state === 'queued' || j.state === 'running')) ?? null;
  const failedOf = (p: string) => { const j = d?.jobs.find((x) => x.project === p); return j?.state === 'failed' ? j : null; };

  return (
    <Page title="Projects" intro="Code the panel builds and deploys: React, Vue, Svelte and Lit sites, Next.js sites exported as files, and Next.js servers. Every build runs in a throwaway container, never as the panel or root."
      actions={<Button size="sm" variant="outline" asChild><Link to="/projects/git-tokens"><KeyRound />Your git tokens</Link></Button>}>
      <Section title="Your projects"
        action={!adding && <Button size="sm" onClick={() => setAdding(true)} disabled={!d?.info.image}><Plus />New project</Button>}>
        {adding && d && <NewProject taken={d.projects.map((p) => p.id)} onDone={() => setAdding(false)} />}
        <List label="Projects">
          {!d ? <Loading rows={1} /> : d.projects.length === 0 ? <Empty>No projects yet.</Empty>
            : d.projects.map((p) => <ProjectRow key={p.id} p={p} view={view!} job={jobOf(p.id)} failed={failedOf(p.id)} />)}
          {d?.jobs.filter((j) => j.what === 'create' && (j.state === 'queued' || j.state === 'running') && !d.projects.some((p) => p.id === j.project)).map((j) => (
            <Row key={j.id} title={j.project} badges={<Badge variant="warn">being made</Badge>} meta={j.step ?? 'waiting its turn'} />
          ))}
        </List>
      </Section>

      <Section title="Build environment" className="mt-6" intro={d && `Builds run as ${d.info.user ?? 'svc-lfdln-apps'}, one at a time, each with 2 GB and 15 minutes. Ports ${d.info.ports.min}-${d.info.ports.max} are kept for projects' servers.`}
        action={<ActionButton icon={RefreshCw} disabled={!d || active} onClick={() => run(() => api('/api/projects/check', {}), 'Checking: it runs after any build waiting.')}>Check the build environment</ActionButton>}>
        {!d ? <Loading rows={1} /> : (
          <dl data-testid="build-environment" className="grid gap-x-6 gap-y-2 px-4 py-4 text-sm sm:grid-cols-[max-content_1fr] sm:px-5">
            <dt className="text-muted-foreground">User</dt>
            <dd>{d.info.user ?? <span className="text-destructive">missing: run install-lfdln.sh</span>}</dd>
            <dt className="text-muted-foreground">Build image</dt>
            <dd className="font-mono text-[0.8125rem] [overflow-wrap:anywhere]">{d.info.image ?? <span className="font-sans text-destructive">missing: run install-lfdln.sh</span>}</dd>
            <dt className="text-muted-foreground">Last check</dt>
            <dd data-testid="last-check">
              {!check ? 'Not checked yet.'
                : check.state === 'done' && check.result ? (
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    <CircleCheck className="size-4 text-success" aria-hidden />
                    Node {check.result.node}, npm {check.result.npm}, pnpm {check.result.pnpm}, git {check.result.git}
                    {check.at && <time title={formatTime(check.at)} className="text-muted-foreground">({timeAgo(check.at)})</time>}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 text-destructive"><CircleAlert className="size-4" aria-hidden />{check.error ?? 'It failed.'}</span>
                )}
            </dd>
          </dl>
        )}
      </Section>

      <Section title="Jobs" intro="What the projects helper did lately, newest first. One job runs at a time." className="mt-6">
        <List label="Jobs">
          {!d ? <Loading rows={2} /> : d.jobs.length === 0 ? <Empty>Nothing yet.</Empty> : d.jobs.map((j) => <JobRow key={j.id} j={j} />)}
        </List>
      </Section>
    </Page>
  );
}

function NewProject({ taken, onDone }: { taken: string[]; onDone: () => void }) {
  const run = useAction();
  const uid = useId();
  const me = useMe();
  const hosts = !!me && may(me, 'hosts', true);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('react');
  const [typescript, setTypescript] = useState(true);
  const [tailwind, setTailwind] = useState(true);
  const [pm, setPm] = useState<'npm' | 'pnpm'>('npm');
  const [show, setShow] = useState(true);
  const [dev, setDev] = useState(true);
  const problem = nameProblem(name) ?? (taken.includes(name) ? 'There is already a project called that.'
    : show && hosts && RESERVED_HOSTS.includes(name) ? `${name}.${SITE.domain} is kept for the site itself: pick another name, or don't give it a host of its own.` : null);
  return (
    <form aria-label="New project" className="grid gap-4 border-b border-border px-4 py-4 sm:px-5" onSubmit={async (e) => {
      e.preventDefault();
      const made = await run(async () => {
        await api('/api/projects', { id: name, kind, typescript, tailwind, pm, dev });
        if (show && hosts) {
          // its own host, <name>.<domain>, showing it (the Hosts page's own API)
          const h = await api<{ id: number }>('/api/hosts', { name });
          await api(`/api/hosts/${h.id}/routes`, { path: '/', kind: 'project', project: name });
          if (dev) {
            // the preview, <name>-dev.<domain>: only people let in (D3-7); if that can't be
            // set, the route goes again rather than show the preview to anyone
            const hd = await api<{ id: number }>('/api/hosts', { name: `${name}-dev` });
            const r = await api<{ id: number }>(`/api/hosts/${hd.id}/routes`, { path: '/', kind: 'project', project: name, branch: 'dev' });
            try { await api(`/api/routes/${r.id}/accounts`, { accounts: 'private' }); } catch (e) {
              await api(`/api/routes/${r.id}/delete`, {}).catch(() => {});
              throw e;
            }
          }
        }
        return true;
      }, show && hosts ? `Making ${name}: it shows at ${name}.${SITE.domain}${dev ? ` (and its preview at ${name}-dev.${SITE.domain})` : ''} once its first build is done.` : `Making ${name}.`);
      if (made) onDone();
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${uid}-name`} hint={problem ?? (name ? `${name}.${SITE.domain}` : 'Its address, if it gets its own host.')}>
          <Input id={`${uid}-name`} autoCapitalize="none" spellCheck={false} autoComplete="off" value={name} aria-invalid={!!problem}
            onChange={(e) => setName(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Kind" htmlFor={`${uid}-kind`}>
          <NativeSelect id={`${uid}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Language" htmlFor={`${uid}-lang`}>
          <NativeSelect id={`${uid}-lang`} value={typescript ? 'ts' : 'js'} onChange={(e) => setTypescript(e.target.value === 'ts')}>
            <option value="ts">TypeScript</option>
            <option value="js">JavaScript</option>
          </NativeSelect>
        </Field>
        <Field label="Package manager" htmlFor={`${uid}-pm`}>
          <NativeSelect id={`${uid}-pm`} value={pm} onChange={(e) => setPm(e.target.value as 'npm' | 'pnpm')}>
            <option value="npm">npm</option>
            <option value="pnpm">pnpm</option>
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-2">
        <label className="flex items-center gap-2.5 text-sm"><Checkbox checked={tailwind} onCheckedChange={(v) => setTailwind(v === true)} /><span>Tailwind CSS</span></label>
        <label className="flex items-center gap-2.5 text-sm"><Checkbox checked={dev} onCheckedChange={(v) => setDev(v === true)} /><span>Dev branch: try changes on a preview before they go live</span></label>
        {hosts && <label className="flex items-center gap-2.5 text-sm"><Checkbox checked={show} onCheckedChange={(v) => setShow(v === true)} /><span>Show it at {name || 'its-name'}.{SITE.domain} (a host of its own){dev && <>, its preview at {name || 'its-name'}-dev.{SITE.domain} (only people let in)</>}</span></label>}
      </div>
      <p className="text-sm text-muted-foreground">The latest {kind.startsWith('next') ? 'create-next-app' : 'create-vite'} makes it; its packages are installed once, then it is built{kind === 'next' ? ' into a container, which runs it' : ''}. A few minutes.</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={!name || !!problem}><Hammer />Make it</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ProjectRow({ p, view, job, failed }: { p: Project; view: ProjectsView; job: Job | null; failed: Job | null }) {
  const run = useAction();
  const dialogs = useDialogs();
  const [open, setOpen] = useState(false);
  const main = p.branches.main;
  const dev = p.branches.dev;
  const live = main?.live ?? null;
  const can = p.mayChange;
  const busy = !!job || !can;
  const why = can ? undefined : `Only ${p.owners.join(', ') || 'its owners'} or an admin can change it.`;
  const shownDev = p.shownAt.filter((s) => s.branch === 'dev');
  return (
    <Row title={p.id}
      badges={<>
        <Badge>{KIND_LABEL[p.kind] ?? p.kind}</Badge>
        {dev && <Badge variant="outline">dev branch</Badge>}
        {job ? <Badge variant="warn">{job.state === 'running' ? (job.what === 'create' ? 'being made' : `${WHAT[job.what] ?? job.what}${job.branch && job.what !== 'create' ? ` (${job.branch})` : ''}`) : 'waiting'}</Badge>
          : !live ? <Badge variant="outline">not built</Badge> : null}
        {failed && !job && <Badge variant="danger">last job failed</Badge>}
        {!!p.packages?.advisories && <Badge variant="danger">security: {p.packages.advisories}</Badge>}
        {!!p.packages?.outdated && <Badge variant="warn">{p.packages.outdated} update{p.packages.outdated === 1 ? '' : 's'}</Badge>}
      </>}
      meta={<Facts items={[p.typescript ? 'TypeScript' : 'JavaScript', p.tailwind && 'Tailwind', p.pm,
        live ? <>live: release {live.id} <span className="font-mono">{live.commit.slice(0, 7)}</span>, <time title={formatTime(live.at)}>{timeAgo(live.at)}</time></> : null,
        dev?.live ? <>dev: <span className="font-mono">{dev.live.commit.slice(0, 7)}</span>{dev.live.commit === live?.commit ? ' (same as live)' : ''}</> : null,
        job?.step]} />}
      actions={<>
        <ActionButton icon={RefreshCw} disabled={busy || !main} title={why} onClick={() => run(() => api(`/api/projects/${p.id}/build`, { branch: 'main' }), `Rebuilding ${p.id}.`)}>Rebuild</ActionButton>
        {dev && <ActionButton icon={ArrowUpFromLine} disabled={busy || !dev.live} title={why} onClick={async () => {
          if (!await dialogs.confirm({ title: `Put ${p.id}'s dev branch live?`, action: 'Put dev live',
            body: `main moves to dev's commit${dev.live ? ` (${dev.live.commit.slice(0, 7)})` : ''} and is built and put live. If main has commits dev doesn't, nothing changes: merge main into dev first.` })) return;
          await run(() => api(`/api/projects/${p.id}/promote`, {}), `Putting ${p.id}'s dev branch live.`);
        }}>Put dev live</ActionButton>}
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}><History />Details</Button>
        <Button size="sm" variant="outline" asChild><Link to={`/projects/${p.id}/packages`}><Package />Packages</Link></Button>
        <ActionButton variant="ghost" icon={Trash2} disabled={busy} title={why} aria-label={`Delete ${p.id}`} onClick={async () => {
          if (!await dialogs.confirm({ title: `Delete ${p.id}?`, action: 'Delete', danger: true,
            body: p.shownAt.length ? `It is still shown at ${p.shownAt.map((s) => s.address).join(', ')}: remove those routes on the Hosts page first.`
              : `Its code and releases go to the trash for 30 days, then they are gone.${Object.values(p.branches).some((b) => b?.database && !b.database.shared) ? ' Its databases stay (in the Studio).' : ''}` })) return;
          await run(() => api(`/api/projects/${p.id}/delete`, {}), `${p.id} is going to the trash.`);
        }}>Delete</ActionButton>
      </>}
      footer={<>
        {p.shownAt.length > 0
          ? <Addresses links={p.shownAt.map((s) => ({ href: s.address, text: `${s.address}${s.branch === 'dev' ? ' (preview)' : ''}${s.live ? '' : ' (off)'}` }))} />
          : <p className="mt-1 text-sm text-muted-foreground">Not shown anywhere: add a route on the Hosts page ("Show a project").</p>}
        {failed && !job && <p className="mt-1 text-sm text-destructive">{failed.error}</p>}
        {open && (
          <div className="mt-3 grid gap-4">
            {SERVER_KINDS.includes(p.kind) && <Servers p={p} busy={busy} />}
            {SERVER_KINDS.includes(p.kind) && <Databases p={p} busy={busy} />}
            {(['main', 'dev'] as const).filter((b) => p.branches[b]).map((b) => (
              <Releases key={b} p={p} branch={b} busy={busy} />
            ))}
            <Environment p={p} busy={busy} />
            <DevBranch p={p} busy={busy} shownDev={shownDev} />
            <Owners p={p} view={view} busy={busy} />
            <Clone p={p} view={view} />
          </div>
        )}
      </>} />
  );
}

// A server's branches (D4-7, D4-8): running or not, on which port, its controls and its log
function Servers({ p, busy }: { p: Project; busy: boolean }) {
  const run = useAction();
  const [log, setLog] = useState<Branch | null>(null);
  const lines = useApi<{ lines: string[] }>(log ? `/api/projects/${p.id}/logs?branch=${log}` : null, { refetchInterval: log ? 5000 : false });
  return (
    <div>
      <h3 className="text-sm font-semibold">Its server</h3>
      <ul aria-label={`Servers of ${p.id}`} className="mt-1.5 divide-y divide-border rounded-md border border-border">
        {(['main', 'dev'] as const).filter((b) => p.branches[b]).map((b) => {
          const r = p.running?.[b];
          const up = r?.active === 'active';
          const stopped = !!p.branches[b]?.stopped || !!r?.masked;
          const act = (action: 'start' | 'stop' | 'restart', words: string) => run(() => api(`/api/projects/${p.id}/control`, { branch: b, action }), words);
          return (
            <li key={b} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span>
                <strong className="font-semibold">{b === 'main' ? 'Live (main)' : 'Preview (dev)'}</strong>{' '}
                {!r ? <span className="text-muted-foreground">not running yet</span>
                  : <>
                    <Badge variant={stopped ? 'outline' : up ? 'ok' : 'danger'}>{stopped ? 'stopped' : up ? 'running' : r.active}</Badge>
                    <span className="text-muted-foreground"> · port {r.port}</span>
                  </>}
              </span>
              <span className="flex flex-wrap gap-2">
                {r && (stopped || !up
                  ? <ActionButton icon={Play} disabled={busy} onClick={() => act('start', `Starting ${p.id} (${b}).`)}>Start</ActionButton>
                  : <>
                    <ActionButton icon={RotateCw} disabled={busy} onClick={() => act('restart', `Restarting ${p.id} (${b}).`)}>Restart</ActionButton>
                    <ActionButton icon={Square} disabled={busy} onClick={() => act('stop', `Stopping ${p.id} (${b}): it stays stopped until started again.`)}>Stop</ActionButton>
                  </>)}
                <Button size="sm" variant="outline" aria-expanded={log === b} onClick={() => setLog((x) => (x === b ? null : b))}><FileText />{log === b ? 'Hide the log' : 'Server log'}</Button>
              </span>
              {log === b && (
                <pre data-testid="server-log" className="mt-1 max-h-80 w-full overflow-auto rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed">
                  {lines.data ? lines.data.lines.join('\n') || '(nothing yet)' : 'Loading…'}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Each branch's database (8b-5): made by the database helper; its two connections are put in
// the branch's environment. Shown in the Studio, which reads it and never changes it.
const ENGINE_LABEL = { postgres: 'Postgres', mariadb: 'MariaDB' } as const;
function Databases({ p, busy }: { p: Project; busy: boolean }) {
  const run = useAction();
  const dialogs = useDialogs();
  const me = useMe();
  const studio = !!me && may(me, 'databases', true);
  const engines = (['postgres', 'mariadb'] as const).filter((e) => SITE.studioPorts?.[e]);
  const main = p.branches.main?.database ?? null;
  return (
    <div>
      <h3 className="text-sm font-semibold">Database</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        A database of its own for each branch, so the preview never touches live data. Its code finds it in <code>DATABASE_URL</code> (its rows) and <code>DATABASE_OWNER_URL</code> (for its migrations: making and changing tables).
      </p>
      <ul aria-label={`Databases of ${p.id}`} className="mt-1.5 divide-y divide-border rounded-md border border-border">
        {(['main', 'dev'] as const).filter((b) => p.branches[b]).map((b) => {
          const d = p.branches[b]!.database ?? null;
          const make = (engine: 'postgres' | 'mariadb') => run(() => api<{ kept: boolean; needs: string }>(`/api/projects/${p.id}/database`, { branch: b, engine }),
            (r) => `${p.id}${b === 'dev' ? ' (dev)' : ''} has its ${ENGINE_LABEL[engine]} database${r.kept ? ' (the one kept from before, with its tables)' : ''}: ${r.needs === 'restart' ? `restart its server (${b}) to use it.` : 'its first build uses it.'}`);
          return (
            <li key={b} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <strong className="font-semibold">{b === 'main' ? 'Live (main)' : 'Preview (dev)'}</strong>{' '}
                {!d ? <span className="text-muted-foreground">no database</span> : <>
                  <Badge variant={d.shared ? 'warn' : 'outline'}>{d.shared ? 'the live database' : ENGINE_LABEL[d.engine]}</Badge>{' '}
                  <span className="font-mono text-[0.8125rem]">{d.name}</span>
                  <span className="text-muted-foreground"> · logins <span className="font-mono">{d.owner}</span> and <span className="font-mono">{d.app}</span></span>
                </>}
              </span>
              <span className="flex flex-wrap gap-2">
                {d && studio && <Button size="sm" variant="outline" asChild><Link to={`/databases/${d.engine}/${d.name}`}><Database />In the Studio</Link></Button>}
                {(!d || d.shared) && !p.mayChange ? null : <>
                  {!d && engines.map((e) => <ActionButton key={e} icon={Database} disabled={busy} onClick={() => make(e)}>Make a {ENGINE_LABEL[e]} database</ActionButton>)}
                  {b === 'dev' && !d && main && <ActionButton icon={Link2} variant="ghost" disabled={busy} onClick={async () => {
                    if (!await dialogs.confirm({ title: `Let ${p.id}'s preview use the live database?`, action: 'Use the live database', danger: true,
                      body: 'Whatever the preview does, live data changes with it: its migrations too. Only for a moment you need it, and turn it off after.' })) return;
                    await run(() => api(`/api/projects/${p.id}/database/share`, { on: true }), `${p.id}'s preview uses the live database: restart its server (dev) to use it.`);
                  }}>Use the live database</ActionButton>}
                  {d?.shared && <ActionButton icon={Link2Off} disabled={busy} onClick={() => run(() => api(`/api/projects/${p.id}/database/share`, { on: false }), `${p.id}'s preview no longer uses the live database: restart its server (dev).`)}>Stop using the live database</ActionButton>}
                </>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-sm text-muted-foreground">A database stays when its project or dev branch goes: made again under the same name, it is taken up with its tables.</p>
    </div>
  );
}

// Each branch's environment (D4-11): only its owners and admins see even the names
function Environment({ p, busy }: { p: Project; busy: boolean }) {
  const branches = (['main', 'dev'] as const).filter((b) => p.branches[b]);
  return (
    <div>
      <h3 className="text-sm font-semibold">Environment</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Settings and secrets its code reads (<code>process.env.NAME</code>){SERVER_KINDS.includes(p.kind) ? ': when its server starts, and while it is built' : ': while it is built, so they end up in its files'}. Values stay hidden until you show them.
      </p>
      {/* docs/s1-plan.md S1b: the headers alone prove nothing, anyone on the server can send them */}
      {SERVER_KINDS.includes(p.kind) && <p className="mt-1 text-sm text-muted-foreground">
        Behind a route with accounts, its server is told who is signed in by the <code>X-Lfdln-*</code> headers. Believe them only with a good <code>X-Lfdln-Proof</code>, checked with <code>LFDLN_IDENTITY_KEY</code> and <code>LFDLN_IDENTITY_AUDIENCE</code> (the panel sets both). <InlineLink to="/help/visitors#part-7">How to check it</InlineLink>
      </p>}
      {!p.mayChange ? <p className="mt-1.5 text-sm text-muted-foreground">Only {p.owners.join(', ') || 'its owners'} or an admin see it.</p>
        : branches.map((b) => <EnvBranch key={b} p={p} branch={b} busy={busy} several={branches.length > 1} />)}
    </div>
  );
}

function EnvBranch({ p, branch, busy, several }: { p: Project; branch: Branch; busy: boolean; several: boolean }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const env = useApi<EnvView>(`/api/projects/${p.id}/env?branch=${branch}`);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const server = SERVER_KINDS.includes(p.kind);
  const vars = env.data?.vars ?? [];
  const problem = !name ? null : !ENV_NAME_RE.test(name) ? 'Capital letters, digits and _, not starting with a digit.'
    : env.data?.panel.includes(name) ? `${name} is the panel's: it is set for every project.` : null;
  const isPublic = PUBLIC_ENV.some((x) => name.startsWith(x));
  // what a change takes before it is used, as the helper says
  const said = (r: EnvSaved) => `${r.name} ${r.removed ? 'removed' : 'saved'}: ${r.needs === 'nothing' ? 'its first build uses it.'
    : r.needs === 'restart' ? `restart its server (${branch}) to use it.` : `rebuild ${branch === 'main' ? p.id : `${p.id}'s dev branch`} to use it${server ? ' (it is built into the pages)' : ''}.`}`;
  const save = async (n: string, v: string | null) => {
    const r = await run(() => api<EnvSaved>(`/api/projects/${p.id}/env`, { branch, name: n, value: v }), said);
    if (r && values) setValues((x) => { const y = { ...x }; if (v === null) delete y[n]; else y[n] = v; return y; });
    return r;
  };
  return (
    <div className="mt-2">
      {several && <h4 className="text-sm font-medium">{branch === 'main' ? 'Live (main)' : 'Preview (dev)'}</h4>}
      <ul aria-label={`Environment of ${p.id}${branch === 'dev' ? ' (dev)' : ''}`} className="mt-1.5 divide-y divide-border rounded-md border border-border">
        {!env.data ? <li className="px-3 py-2.5 text-sm text-muted-foreground">Loading…</li>
          : vars.length === 0 ? <li className="px-3 py-2.5 text-sm text-muted-foreground">Nothing set yet.</li>
            : vars.map((v) => (
              <li key={v.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong className="font-mono text-[0.8125rem] font-semibold">{v.name}</strong>{' '}
                  <span data-testid="env-value" className="font-mono text-[0.8125rem] text-muted-foreground">{values ? (values[v.name] || '(empty)') : '••••••••'}</span>
                  {v.public && <> <Badge variant="warn">in the pages: not secret</Badge></>}
                  {v.oldHost && <> <Badge variant="warn">names 10.0.2.2: reaches nothing</Badge></>}
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Change ${v.name}`} onClick={() => { setName(v.name); setValue(values?.[v.name] ?? ''); }}><Pencil />Change</Button>
                  <ActionButton variant="ghost" icon={Trash2} disabled={busy} aria-label={`Remove ${v.name}`} onClick={async () => {
                    if (!await dialogs.confirm({ title: `Remove ${v.name}?`, action: 'Remove', danger: true, body: `${p.id}'s ${branch === 'main' ? 'live site' : 'preview'} no longer gets it, from its next ${server && !v.public ? 'restart' : 'build'}.` })) return;
                    await save(v.name, null);
                  }}>Remove</ActionButton>
                </span>
              </li>
            ))}
      </ul>
      {vars.some((v) => v.oldHost) && <OldHostWarning server={server} />}
      <div className="mt-2 flex flex-wrap gap-2">
        {vars.length > 0 && (values
          ? <Button size="sm" variant="outline" onClick={() => setValues(null)}><EyeOff />Hide the values</Button>
          : <ActionButton icon={Eye} onClick={async () => {
            const r = await run(() => api<{ values: Record<string, string> }>(`/api/projects/${p.id}/env/values`, { branch }));
            if (r) setValues(r.values);
          }}>Show the values</ActionButton>)}
        {branch === 'dev' && <ActionButton icon={RefreshCw} disabled={busy || !p.branches.dev} onClick={() => run(() => api(`/api/projects/${p.id}/build`, { branch: 'dev' }), `Rebuilding ${p.id}'s dev branch.`)}>Rebuild dev</ActionButton>}
      </div>
      <form aria-label={`Set a variable${branch === 'dev' ? ' (dev)' : ''}`} className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end" onSubmit={async (e) => {
        e.preventDefault();
        if (await save(name, value)) { setName(''); setValue(''); }
      }}>
        <Field label="Name" htmlFor={`${uid}-name`} hint={problem ?? undefined}>
          <Input id={`${uid}-name`} className="font-mono" autoCapitalize="characters" spellCheck={false} autoComplete="off" value={name} aria-invalid={!!problem}
            onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="MY_API_KEY" />
        </Field>
        <Field label="Value" htmlFor={`${uid}-value`}>
          <Input id={`${uid}-value`} className="font-mono" spellCheck={false} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value.replace(/[\r\n]/g, ''))} />
        </Field>
        <Button type="submit" size="sm" disabled={busy || !name || !!problem || (vars.length >= (env.data?.max ?? 100) && !vars.some((v) => v.name === name))}><KeyRound />{vars.some((v) => v.name === name) ? 'Change it' : 'Add it'}</Button>
        {value.includes(OLD_HOST) && <p className="text-sm text-warning sm:col-span-3"><CircleAlert className="mr-1 inline size-4 align-text-bottom" aria-hidden />10.0.2.2 reaches nothing from a project: its databases are at 127.0.0.1 (same port).</p>}
        {isPublic && <p className="text-sm text-warning sm:col-span-3"><CircleAlert className="mr-1 inline size-4 align-text-bottom" aria-hidden />{name.startsWith('VITE_') ? 'VITE_' : 'NEXT_PUBLIC_'} names are built into the files every visitor gets: never put a secret in one.</p>}
      </form>
    </div>
  );
}

// S1f (b): a variable naming 10.0.2.2, the way to the server before S1d
function OldHostWarning({ server }: { server: boolean }) {
  return (
    <p role="note" className="mt-2 text-sm text-warning">
      <CircleAlert className="mr-1 inline size-4 align-text-bottom" aria-hidden />
      A variable here names <code>10.0.2.2</code>, which reaches nothing from a project{server
        ? <>'s server: its databases are at <code>127.0.0.1</code> (same port), and nothing else on the server can be reached. Change it to <code>127.0.0.1</code>, then Restart.</>
        : <>: change or remove it, then rebuild.</>}
    </p>
  );
}

function Releases({ p, branch, busy }: { p: Project; branch: Branch; busy: boolean }) {
  const run = useAction();
  const b = p.branches[branch]!;
  return (
    <div>
      <h3 className="text-sm font-semibold">{branch === 'main' ? 'Live (main)' : 'Preview (dev)'}</h3>
      <ul aria-label={`Releases of ${p.id}${branch === 'dev' ? ' (dev)' : ''}`} className="mt-1.5 divide-y divide-border rounded-md border border-border">
        {b.releases.length === 0 ? <li className="px-3 py-2.5 text-sm text-muted-foreground">No releases yet.</li> : b.releases.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span>
              <strong className="font-semibold">{r.id}</strong> <span className="font-mono text-muted-foreground">{r.commit.slice(0, 7)}</span>
              <span className="text-muted-foreground"> · {r.by}, <time title={formatTime(r.at)}>{timeAgo(r.at)}</time> · {r.files} files, {size(r.bytes)}</span>
            </span>
            {b.live?.id === r.id ? <Badge variant="ok">{branch === 'main' ? 'live' : 'shown'}</Badge>
              : <ActionButton disabled={busy} onClick={() => run(() => api(`/api/projects/${p.id}/rollback`, { branch, release: r.id }), `Putting release ${r.id} back.`)}>Put this {branch === 'main' ? 'live' : 'back'}</ActionButton>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DevBranch({ p, busy, shownDev }: { p: Project; busy: boolean; shownDev: Project['shownAt'] }) {
  const run = useAction();
  const on = !!p.branches.dev;
  return (
    <div>
      <h3 className="text-sm font-semibold">Dev branch</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {on ? <>A push to <code>dev</code> builds the preview{shownDev.length ? <> at {shownDev.map((s) => s.address).join(', ')}</> : ' (not shown anywhere yet: add a route on the Hosts page, branch dev)'}; <strong>Put dev live</strong> moves <code>main</code> to it. </>
          : <>Off: a push to <code>dev</code> builds nothing. </>}
        {shownDev.some((s) => s.accounts === 'private') && <>Who may see it: <Link to="/hosts" className="font-semibold text-primary underline-offset-2 hover:underline">Hosts</Link>, its route's "Who may use it" (let in your own visitor account too).</>}
      </p>
      <div className="mt-2">
        <ActionButton icon={GitBranch} disabled={busy} onClick={() => run(() => api(`/api/projects/${p.id}/dev`, { on: !on }), on ? `Turning ${p.id}'s dev branch off.` : `Turning ${p.id}'s dev branch on: it is built from main.`)}>
          {on ? 'Turn the dev branch off' : 'Turn the dev branch on'}
        </ActionButton>
      </div>
    </div>
  );
}

function Owners({ p, view, busy }: { p: Project; view: ProjectsView; busy: boolean }) {
  const run = useAction();
  const uid = useId();
  const [add, setAdd] = useState('');
  const others = view.candidates.filter((c) => !p.owners.includes(c.username));
  const save = (owners: string[], words: string) => run(() => api(`/api/projects/${p.id}/owners`, { owners }), words);
  return (
    <div>
      <h3 className="text-sm font-semibold">Owners</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">They (and admins) change it; those with an account on the server also push to it by SSH.</p>
      <ul aria-label={`Owners of ${p.id}`} className="mt-2 flex flex-wrap gap-2">
        {p.owners.map((o) => (
          <li key={o} className="inline-flex items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-1 text-sm">
            {o}{p.pushers.includes(o) && <span className="text-muted-foreground"> (SSH)</span>}
            <Button size="icon" variant="ghost" className="size-6" aria-label={`Remove ${o}`} disabled={busy || p.owners.length < 2}
              onClick={() => save(p.owners.filter((x) => x !== o), `${o} no longer owns ${p.id}.`)}><X /></Button>
          </li>
        ))}
      </ul>
      {others.length > 0 && p.owners.length < view.maxOwners && (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (add && await save([...p.owners, add], `${add} owns ${p.id} too.`)) setAdd(''); }}>
          <Field label="Add an owner" htmlFor={`${uid}-owner`}>
            <NativeSelect id={`${uid}-owner`} value={add} disabled={busy} onChange={(e) => setAdd(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((c) => <option key={c.username} value={c.username}>{c.name ? `${c.name} (${c.username})` : c.username}</option>)}
            </NativeSelect>
          </Field>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !add}><Users />Add</Button>
        </form>
      )}
    </div>
  );
}

function Clone({ p, view }: { p: Project; view: ProjectsView }) {
  const ssh = `ssh://${view.me}@${view.ssh.host}${view.ssh.root}/${p.id}/repo.git`;
  const https = `https://git.${SITE.domain}/${p.id}.git`;
  const mayPush = p.mayChange;
  return (
    <div>
      <h3 className="text-sm font-semibold">Its code</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Clone it over HTTPS with your panel username and a <Link className="underline" to="/projects/git-tokens">git token</Link>{mayPush ? <>; a push to <code>main</code> goes live, to <code>dev</code> the preview.</> : <>. Only its owners (and admins) can push.</>}
      </p>
      <pre data-testid="clone-https" className="mt-1.5 overflow-x-auto rounded-md bg-muted/70 p-2.5 font-mono text-xs">git clone {https} {p.id}</pre>
      {p.pushers.includes(view.me) ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">Or by SSH, with your account on the server:</p>
          <pre data-testid="clone" className="mt-1.5 overflow-x-auto rounded-md bg-muted/70 p-2.5 font-mono text-xs">git clone {ssh} {p.id}</pre>
        </>
      ) : p.pushers.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">Owners with an account on the server can use SSH too ({p.pushers.join(', ')}).</p>
      )}
    </div>
  );
}
