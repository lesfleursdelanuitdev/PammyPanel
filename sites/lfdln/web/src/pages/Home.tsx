// lfdln's Home (docs/lfdln-standup-plan.md): what is on the internet through this panel
// (hosts, their routes, site folders) and what was done lately. Plain words, no
// explaining (platform plan D4).
import { Activity as Pulse, Boxes, Clock, FolderOpen, Globe, KeyRound, Route, Server, UserCog, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { describe } from '@panel/core/web/pages/Activity';
import { formatTime, plural, timeAgo } from '@panel/core/web/lib/api';
import { isOn, SITE } from '@panel/core/web/lib/site';
import { isKept, may, placeFolders } from '@panel/core/web/lib/rights';
import type { ActivityEntry, Me } from '@panel/core/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { FirstStepsCard, type PartPages } from '@panel/help/web/components/first-steps';
import { MENU } from '../menu';

type HostsData = {
  domain: string;
  hosts: { id: number; name: string; enabled: boolean; address: string; routes: { id: number; enabled: boolean }[] }[];
  folders: { id: number; name: string; shownAt: string[] }[];
};

// The page each part opens on, for the first-steps card (docs/phase9-plan.md 9-3): the
// first item of the menu that needs it, the Inbox's last (Visitors is People, not Requests).
const PART_PAGES: PartPages = {};
const items = MENU.groups.flatMap((g) => g.items);
for (const item of [...items.filter((i) => !i.count), ...items.filter((i) => i.count)]) {
  if (item.needs !== 'signed-in' && item.needs !== 'admin' && !PART_PAGES[item.needs]) PART_PAGES[item.needs] = { to: item.to, label: item.label };
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({ me }: { me: Me }) {
  usePageTitle('Home');
  const hostsOn = may(me, 'hosts');
  const hosts = useApi<HostsData>(hostsOn ? '/api/hosts' : null);
  const activity = useApi<{ entries: ActivityEntry[]; own: boolean }>('/api/activity');
  // Monitoring (docs/monitoring-plan.md M5): what is down now
  const watching = isOn('monitoring') && may(me, 'monitoring', true);
  const monitoring = useApi<{ checks: { state: string }[]; round: unknown }>(watching ? '/api/monitoring' : null, { refetchInterval: 60_000 });
  const downNow = monitoring.data ? monitoring.data.checks.filter((c) => c.state === 'down').length : null;
  const d = hosts.data;
  const live = d?.hosts.filter((h) => h.enabled) ?? [];

  const shortcuts: { to: string; icon: LucideIcon; title: string; text: string; on: boolean }[] = [
    { to: '/hosts', icon: Server, title: 'Hosts', text: `Names under ${SITE.domain}, their routes and site folders`, on: hostsOn },
    { to: '/services', icon: Boxes, title: 'Services', text: 'What runs on the server: start, stop, restart, logs', on: isOn('services') && may(me, 'services', true) },
    { to: '/accounts', icon: UserCog, title: 'Accounts', text: 'Who can use this panel, and what they can change', on: may(me, 'admin') },
    { to: '/passkeys', icon: KeyRound, title: 'Passkeys', text: 'How you sign in', on: true },
    { to: '/activity', icon: Clock, title: 'Activity', text: activity.data?.own ? 'What you did in this panel' : 'What everyone did in this panel', on: true },
  ].filter((s) => s.on);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{greeting()}, {me.displayName}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-muted-foreground">The panel for {SITE.domain} on this server.</p>
        {isKept(me) && <p data-testid="limited-to" className="mt-1 text-sm text-muted-foreground">You look after <strong className="text-foreground">{placeFolders(me).join(', ')}</strong>: you see and change only {me.places.length === 1 ? 'that host' : 'those hosts'}.</p>}
      </header>

      {SITE.help?.firstSteps && isOn('help') && <FirstStepsCard me={me} pages={PART_PAGES} />}

      {hostsOn && (
        <section aria-label="At a glance" className={cn('grid grid-cols-2 gap-3 sm:gap-4', watching ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
          <Stat to="/hosts" icon={Globe} label="Hosts on" value={d ? live.length : null} foot={d ? `${plural(d.hosts.length, 'host')} in all` : null} />
          <Stat to="/hosts" icon={Route} label="Routes on" value={d ? live.reduce((n, h) => n + h.routes.filter((r) => r.enabled).length, 0) : null}
            foot={d ? `${plural(d.hosts.reduce((n, h) => n + h.routes.length, 0), 'route')} in all` : null} />
          <Stat to="/hosts" icon={FolderOpen} label="Site folders" value={d ? d.folders.length : null}
            foot={d ? `${d.folders.filter((f) => f.shownAt.length === 0).length} not shown anywhere` : null} />
          {watching && <Stat to="/monitoring" icon={Pulse} label="Down now" value={downNow}
            foot={!monitoring.data ? null : !monitoring.data.round ? 'not checked yet' : downNow ? 'see Monitoring' : 'all well'} />}
        </section>
      )}

      <div className={cn('mt-6 grid gap-6', hostsOn && 'lg:grid-cols-2')}>
        {hostsOn && (
          <Panel title="Hosts" to="/hosts" linkText="All hosts">
            {!d ? <Skeleton /> : d.hosts.length === 0 ? <EmptyNote icon={Globe}>No hosts yet. Make one on the Hosts page.</EmptyNote> : (
              <ul aria-label="Hosts" className="divide-y divide-border">
                {d.hosts.slice(0, 6).map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <span className="min-w-0">
                      <a href={h.address} target="_blank" rel="noreferrer" className="block truncate text-sm font-semibold">{new URL(h.address).host}</a>
                      <span className="block text-xs text-muted-foreground">{plural(h.routes.length, 'route')}</span>
                    </span>
                    <span className={cn('shrink-0 rounded-full px-2 text-xs font-medium leading-5', h.enabled ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground')}>{h.enabled ? 'on' : 'off'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
        <Panel title={activity.data?.own ? 'What you did lately' : 'Lately'} to="/activity" linkText="All activity">
          {!activity.data ? <Skeleton /> : activity.data.entries.length === 0 ? <EmptyNote icon={Clock}>Nothing yet.</EmptyNote> : (
            <ul aria-label="Recent activity" className="divide-y divide-border">
              {activity.data.entries.slice(0, 6).map((e) => (
                <li key={e.id} className="px-4 py-3 sm:px-5">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm"><strong className="font-semibold">{e.actor_label}</strong> {describe(e)}</span>
                    <time title={formatTime(e.at)} className="shrink-0 text-xs text-muted-foreground">{timeAgo(e.at)}</time>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <section aria-label="Shortcuts" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {shortcuts.map((s) => (
          <Link key={s.to} to={s.to} className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 no-underline shadow-card transition-colors hover:border-primary/40">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><s.icon className="size-4" /></span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{s.title}</span>
              <span className="block text-xs text-muted-foreground">{s.text}</span>
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}

function Stat({ to, icon: Icon, label, value, foot }: { to: string; icon: LucideIcon; label: string; value: number | null; foot: string | null }) {
  return (
    <Link to={to} aria-label={value === null ? label : `${label}: ${value}`}
      className="group min-w-0 rounded-lg border border-border bg-card p-3.5 no-underline shadow-card transition-colors hover:border-primary/40 sm:p-5">
      <span className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="grid size-8 place-items-center rounded-md bg-primary-soft text-primary"><Icon className="size-4" /></span>
      </span>
      <span data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`} className="mt-2 block text-3xl font-bold tracking-tight tabular-nums text-foreground">
        {value === null ? <span className="inline-block h-8 w-10 animate-pulse rounded bg-muted align-middle" /> : value}
      </span>
      <span className="mt-1 block min-h-5 text-xs text-muted-foreground">{foot}</span>
    </Link>
  );
}

function Panel({ title, to, linkText, children }: { title: string; to: string; linkText: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <h2 className="text-[0.975rem] font-semibold">{title}</h2>
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
