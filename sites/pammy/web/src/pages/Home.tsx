import {
  AppWindow, BookOpen, ClipboardList, FolderTree, Globe, Images, Inbox, KeyRound, LockKeyhole, PencilRuler, Plus, Search, Send,
  UserRoundPlus, Users, type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { GettingStartedCard } from '@panel/getting-started/web/components/getting-started';
import { Avatar } from '@panel/core/web/components/shell';
import { useApps, type AppMenu } from '@panel/studio/web/hooks/useApps';
import { useWaiting, WAITING_EVERY } from '@panel/core/web/hooks/useWaiting';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { formatTime, plural, timeAgo } from '@panel/core/web/lib/api';
import { personLabel } from '@panel/core/web/lib/names';
import { answerText } from '@panel/forms/web/lib/form-items';
import type { GateRequest, RequestsData } from '@panel/requests/web/lib/types';
import type { GateState } from '@panel/core/web/lib/types';
import type { Me } from '@panel/core/web/lib/types';
import type { FormResponse, FormsData, ResponsesData } from '@panel/forms/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { isOn, SITE, W } from '@panel/core/web/lib/site';
import { isKept, may, placeWords } from '@panel/core/web/lib/rights';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// Who a response is from: who was signed in, else the answer to a name question, else their email.
function senderOf(m: FormResponse) {
  if (m.sender) return m.sender.name || m.sender.username;
  const named = m.answers.find((a) => (a.type === 'name' || (a.type === 'short-text' && /name/i.test(a.label))) && answerText(a.value));
  return (named && answerText(named.value)) || answerText(m.answers.find((a) => a.type === 'email' && a.value)?.value) || 'Someone';
}
function excerptOf(m: FormResponse) {
  const a = m.answers.find((x) => x.type === 'long-text' && x.value) ?? m.answers.find((x) => x.type !== 'checkbox' && x.value);
  return a ? answerText(a.value).replace(/\s+/g, ' ') : '';
}

const LIMITED_SHORTCUTS = ['/forms', '/files', '/media', '/passkeys'];
// on: whether this site has what the shortcut opens (its modules, and folders that are subdomains)
const SHORTCUTS: { to: string; icon: LucideIcon; title: string; text: string; on: boolean }[] = [
  { to: '/subdomains', icon: Globe, title: 'Make a subdomain', text: `A new site like recipes.${SITE.domain}`, on: isOn('files') && SITE.folderSubdomains },
  { to: '/protected-folders', icon: LockKeyhole, title: 'Protect a folder', text: 'Behind a sign-in page', on: isOn('areas') },
  { to: '/people', icon: UserRoundPlus, title: 'Add a person', text: 'Who can open protected folders', on: isOn('people') },
  { to: '/forms', icon: Send, title: 'Forms', text: 'Questions people answer on your pages', on: isOn('forms') },
  { to: '/files', icon: FolderTree, title: 'File Explorer', text: `Every file in ${W.website.your}`, on: isOn('files') },
  { to: '/media', icon: Images, title: 'Upload media', text: 'Images, files, audio, video', on: isOn('media') },
  { to: '/passkeys', icon: KeyRound, title: 'Passkeys', text: 'How you sign in', on: true },
].filter((s) => s.on);

export function Home({ me }: { me: Me }) {
  usePageTitle('Home');
  const waiting = useWaiting(me);
  // what they have (docs/permissions-plan.md R4): someone without protected
  // folders has no requests; a person kept to places (D22-D23) sees their own
  const visitors = may(me, 'protected');
  const limited = !visitors;
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const unread = useApi<ResponsesData>('/api/responses?view=inbox&read=unread&examples=hide', { refetchInterval: WAITING_EVERY });
  const requests = useApi<RequestsData>(visitors ? '/api/requests' : null, { refetchInterval: WAITING_EVERY });
  const gate = useApi<GateState>(visitors ? '/api/protected' : null);
  const forms = useApi<FormsData>('/api/forms');

  const count = waiting.responses + waiting.requests;
  const summary = !waiting.loaded ? 'Checking for anything new…'
    : count === 0 ? 'Nothing is waiting for you.'
      : `${[waiting.responses && plural(waiting.responses, 'unread response'), waiting.requests && plural(waiting.requests, 'request')].filter(Boolean).join(' and ')} ${count === 1 ? 'is' : 'are'} waiting.`;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{greeting()}, {me.displayName}</h1>
          <p data-testid="waiting-summary" aria-live="polite" className="mt-1.5 text-[0.9375rem] text-muted-foreground">{summary}</p>
          {isKept(me) && <p data-testid="limited-to" className="mt-1 text-sm text-muted-foreground">You look after <strong className="text-foreground">{placeWords(me).join(', ')}</strong>: every part of the panel you have shows only what is in {me.places.length === 1 ? 'it' : 'them'}.</p>}
        </div>
        <form role="search" className="flex w-full gap-2 lg:w-96" onSubmit={(e) => { e.preventDefault(); navigate(`/help?q=${encodeURIComponent(q.trim())}`); }}>
          <label htmlFor="home-help-q" className="sr-only">Look something up in your guides</label>
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="home-help-q" type="search" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your guides" autoComplete="off" />
          </div>
          <Button type="submit" variant="outline">Search</Button>
        </form>
      </header>

      {isOn('getting-started') && may(me, 'databases') && <GettingStartedCard />}

      <section aria-label="At a glance" className={cn('grid grid-cols-2 gap-3 sm:gap-4', !limited && 'xl:grid-cols-4')}>
        <Stat to="/responses" icon={Inbox} label="Unread responses" value={waiting.loaded ? waiting.responses : null} alert={waiting.responses > 0}
          foot={forms.data ? `${plural(forms.data.forms.reduce((n, f) => n + f.responses, 0), 'response')} in all` : null} />
        {!limited && <>
          <Stat to="/requests" icon={ClipboardList} label="Waiting requests" value={waiting.loaded ? waiting.requests : null} alert={waiting.requests > 0}
            foot={requests.data ? `${requests.data.recent.length} dealt with in the last 30 days` : null} />
          <Stat to="/protected-folders" icon={LockKeyhole} label="Protected folders" value={gate.data?.areas.length ?? null}
            foot={gate.data ? `${plural(gate.data.visitors.filter((v) => v.active).length, 'person', 'people')} can sign in` : null} />
        </>}
        <Stat to="/forms" icon={Send} label="Forms working" value={forms.data ? forms.data.forms.filter((f) => f.enabled && !f.trashedAt).length : null}
          foot={forms.data ? plural(forms.data.forms.filter((f) => !f.trashedAt).length, 'form') + ' in all' : null} />
      </section>

      <div className={cn('mt-6 grid gap-6', !limited && 'lg:grid-cols-2')}>
        <Panel title="New responses" count={waiting.responses} to="/responses" linkText="All responses">
          {!unread.data ? <Skeleton /> : unread.data.responses.length === 0 ? <EmptyNote icon={Inbox}>No unread responses.</EmptyNote> : (
            <ul aria-label="New responses" className="divide-y divide-border">
              {unread.data.responses.slice(0, 5).map((m) => (
                <li key={m.id}>
                  <Link to={m.formId ? `/responses?form=${m.formId}` : '/responses'} className="flex gap-3 px-4 py-3 no-underline hover:bg-muted/60 sm:px-5">
                    <Avatar name={senderOf(m)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-semibold text-foreground">{senderOf(m)}</span>
                        <time title={formatTime(m.createdAt)} className="shrink-0 text-xs text-muted-foreground">{timeAgo(m.createdAt)}</time>
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">{excerptOf(m)}</span>
                      <span className="block truncate text-xs text-muted-foreground/80">{m.formName} · {m.page}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {!limited && <Panel title="Waiting requests" count={waiting.requests} to="/requests" linkText="All requests">
          {!requests.data ? <Skeleton /> : requests.data.open.length === 0 ? <EmptyNote icon={ClipboardList}>No requests waiting.</EmptyNote> : (
            <ul aria-label="Waiting requests" className="divide-y divide-border">
              {requests.data.open.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <Link to="/requests" className="flex gap-3 px-4 py-3 no-underline hover:bg-muted/60 sm:px-5">
                    <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', r.kind === 'reset' ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary')}>
                      {r.kind === 'reset' ? <KeyRound className="size-4" /> : <Users className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-semibold text-foreground">{requestWho(r)}</span>
                        <time title={formatTime(r.createdAt)} className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.createdAt)}</time>
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">{requestWhat(r)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>}
      </div>

      {may(me, 'databases') && <DatabasesCard me={me} />}

      <section aria-labelledby="shortcuts" className="mt-6 rounded-lg border border-border bg-card shadow-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5 sm:px-5">
          <h2 id="shortcuts" className="text-[0.975rem] font-semibold">Shortcuts</h2>
          <Link to="/help" className="flex items-center gap-1.5 text-sm font-medium no-underline hover:underline"><BookOpen className="size-4" />Help and guides</Link>
        </div>
        <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
          {SHORTCUTS.filter((s) => !isKept(me) || LIMITED_SHORTCUTS.includes(s.to)).map((s) => (
            <li key={s.to} className="bg-card">
              <Link to={s.to} className="flex items-center gap-3 px-4 py-3.5 no-underline hover:bg-muted/60 sm:px-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><s.icon className="size-[1.125rem]" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{s.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{s.text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const requestWho = (r: GateRequest) => (r.kind === 'reset' && r.person ? personLabel(r.person) : r.name);
const requestWhat = (r: GateRequest) => (r.kind === 'reset' ? 'Forgot their password' : `Wants to open ${r.areaPath ? `"${r.areaPath}"` : 'a folder that is no longer protected'}`);

function Stat({ to, icon: Icon, label, value, foot, alert = false }:
  { to: string; icon: LucideIcon; label: string; value: number | null; foot: string | null; alert?: boolean }) {
  return (
    <Link to={to} aria-label={value === null ? label : `${label}: ${value}`}
      className="group min-w-0 rounded-lg border border-border bg-card p-3.5 no-underline shadow-card transition-colors hover:border-primary/40 sm:p-5">
      <span className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn('grid size-8 place-items-center rounded-md', alert ? 'bg-destructive/10 text-destructive' : 'bg-primary-soft text-primary')}><Icon className="size-4" /></span>
      </span>
      <span data-testid={`stat-${to.slice(1)}`} className={cn('mt-2 block text-3xl font-bold tracking-tight tabular-nums', alert ? 'text-destructive' : 'text-foreground')}>
        {value === null ? <span className="inline-block h-8 w-10 animate-pulse rounded bg-muted align-middle" /> : value}
      </span>
      <span className="mt-1 block min-h-5 text-xs text-muted-foreground">{foot}</span>
    </Link>
  );
}

function Panel({ title, count, to, linkText, children }: { title: string; count: number; to: string; linkText: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <h2 className="flex items-center gap-2 text-[0.975rem] font-semibold">
          {title}
          {count > 0 && <span className="rounded-full bg-destructive px-1.5 text-[0.6875rem] font-semibold leading-5 text-destructive-foreground tabular-nums">{count}</span>}
        </h2>
        <Link to={to} className="text-sm font-medium no-underline hover:underline">{linkText}</Link>
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading">
      {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}
    </div>
  );
}

function EmptyNote({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground">
      <Icon className="size-6 opacity-50" />{children}
    </div>
  );
}

// Databases on Home (docs/databases-plan.md 16): quiet, and only for the account
// manager, who is the only one who can open them. Nothing yet: one line offering
// to make one. Otherwise: what has changes drawn and not applied, and the apps
// that are switched on.
type HomeDatabases = {
  managed: number;
  // changes = null: there is a drawing, but the database did not answer in time
  waiting: { engine: string; name: string; title: string; active: boolean; changes: number | null }[];
};

function DatabasesCard({ me }: { me: Me }) {
  const home = useApi<HomeDatabases>('/api/databases/home');
  const apps = useApps(me);
  const d = home.data;
  return (
    <section aria-labelledby="home-databases" className="mt-6 rounded-lg border border-border bg-card shadow-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5 sm:px-5">
        <h2 id="home-databases" className="text-[0.975rem] font-semibold">Databases</h2>
        <Link to="/databases" className="text-sm font-medium no-underline hover:underline">Your databases</Link>
      </div>
      {!d ? <Skeleton /> : d.managed === 0 ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 text-sm text-muted-foreground sm:px-5">
          You have no databases yet.
          <Link to="/databases" className="inline-flex items-center gap-1 font-medium no-underline hover:underline"><Plus className="size-4" />Make a database</Link>
        </p>
      ) : d.waiting.length === 0 && apps.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground sm:px-5">
          {plural(d.managed, 'database')}, and no changes waiting to be applied.
        </p>
      ) : (
        <ul aria-label="Databases" className="divide-y divide-border">
          {d.waiting.map((w) => (
            <HomeRow key={`w-${w.engine}-${w.name}`} icon={PencilRuler}
              to={w.changes === null ? `/databases/${w.engine}/${w.name}` : `/databases/${w.engine}/${w.name}/review`}
              title={w.changes === null ? `${w.name}: a drawing not applied yet` : `${w.name}: ${plural(w.changes, 'change')} not applied yet`}
              text={w.changes === null ? 'The database did not answer just now, so the panel could not count them.'
                : w.active ? `${w.title} is switched on, so applying ${w.changes === 1 ? 'it' : 'them'} changes it too.`
                  : `Nothing has happened to the database yet. Review ${w.changes === 1 ? 'it' : 'them'}, then apply.`} />
          ))}
          {apps.map((a) => <HomeRow key={`a-${a.engine}-${a.name}`} icon={AppWindow} to={appAddress(a)}
            title={`Open ${a.title}`} text={a.things.length ? a.things.map((t) => t.plural).join(', ') : 'Switched on, with nothing ticked to manage yet'} />)}
        </ul>
      )}
    </section>
  );
}

// The app's first page, the same one the menu starts with; its settings when
// nothing is ticked yet, so the link never leads nowhere.
const appAddress = (a: AppMenu) => (a.things[0] ? `/app/${a.engine}/${a.name}/${a.things[0].table}` : `/databases/${a.engine}/${a.name}/app`);

function HomeRow({ icon: Icon, to, title, text }: { icon: LucideIcon; to: string; title: string; text: string }) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-4 py-3 no-underline hover:bg-muted/60 sm:px-5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Icon className="size-4" /></span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground">{text}</span>
        </span>
      </Link>
    </li>
  );
}
