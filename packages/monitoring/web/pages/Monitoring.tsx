// Monitoring (docs/monitoring-plan.md M5): what is checked every 5 minutes and how each
// check is now -- what's down first, then the hosts, the services and the panel's own
// pieces -- with the last week's changes. Check now runs a round straight away (once a
// minute). Admins can make something quiet for maintenance (checked and shown, not
// mailed) and turn the emails off.
import { useId, useState } from 'react';
import { BellOff, CircleCheck, CircleAlert, RefreshCw } from 'lucide-react';
import { ActionButton, Empty, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, formatTime, plural, timeAgo } from '@panel/core/web/lib/api';
import { useQueryClient } from '@tanstack/react-query';

type Check = {
  key: string; group: 'hosts' | 'certs' | 'other' | 'services' | 'projects' | 'panel' | 'backups' | 'disk' | 'dns' | 'domain'; subject: string; label: string;
  state: 'up' | 'down' | 'warn' | 'stopped'; fails: number; since: number; lastAt: number; why: string; link: string | null; quiet: boolean;
};
type Change = { id: number; key: string; label: string; kind: string; why: string; at: number; mail: string };
type Quiet = { id: number; subject: string; until: number; created_by: string | null; created_at: number };
export type MonitoringView = {
  every: number;
  round: { at: number; ms: number | null; note: string | null } | null;
  mail: { on: boolean; sentToday: number; heldToday: number; perDay: number };
  checks: Check[]; events: Change[]; quiet: Quiet[]; againIn: number;
};

const GROUPS: { id: Check['group']; title: string; intro: string }[] = [
  { id: 'hosts', title: 'Hosts', intro: 'Each name a host answers to: its DNS points here, the certificate nginx gives covers it, and it answers.' },
  { id: 'certs', title: 'Certificates', intro: "Days left on each certificate nginx gives. Let's Encrypt renews at 30 days left: under 21 needs a look, under 7 is down." },
  { id: 'other', title: 'Other addresses', intro: "Sites that aren't hosts here yet (Gonsalves, pammy.org), as visitors reach them: they answer, and their certificate isn't close to running out." },
  { id: 'services', title: 'Services', intro: 'Each part: it runs, and answers at its health path. A part stopped from Services is stopped on purpose.' },
  { id: 'projects', title: 'Projects', intro: "Each project's server, live and preview: it runs, and answers. A server stopped from Projects is stopped on purpose. And the builds' way out to the package registries." },
  { id: 'panel', title: "The panel's own", intro: 'Its databases, the gate, the mail service and the helpers: each answers.' },
  { id: 'backups', title: 'Backups', intro: 'Each hour: the newest nightly backup of each database is under 26 hours old, and none of it is empty.' },
  { id: 'disk', title: 'Disk', intro: 'Each hour: free space. Under 15% needs a look, under 5% is down.' },
  { id: 'dns', title: 'Mail DNS and nameservers', intro: 'Each hour: the records mail from the panel needs, and the domain\'s nameservers, as they were when first read. A change is down until an admin keeps it.' },
  { id: 'domain', title: 'The domain', intro: 'Each hour: when its registration runs out, as its registry says. Shown here only, never emailed.' },
];
const STATE: Record<Check['state'], { word: string; variant: 'ok' | 'danger' | 'warn' | 'outline' }> = {
  up: { word: 'up', variant: 'ok' }, down: { word: 'down', variant: 'danger' }, warn: { word: 'look soon', variant: 'warn' }, stopped: { word: 'stopped on purpose', variant: 'outline' },
};
const KIND: Record<string, string> = { down: 'went down', back: 'came back', warn: 'needs a look', stopped: 'was stopped', started: 'was started', 'still-down': 'still down' };
const MAIL: Record<string, string> = { sent: 'emailed', held: 'not emailed (the day\'s limit)', quiet: 'not emailed (quiet)', no: '' };
const SUBJECTS: Record<string, string> = { all: 'everything', panel: "the panel's own pieces", certificates: 'the certificates', backups: 'the backups', disk: 'the disk', dns: 'the mail DNS records and nameservers', registration: "the domain's registration" };
const subjectWords = (s: string) => SUBJECTS[s] ?? (s.startsWith('service:') ? `the service ${s.slice(8)}` : s.startsWith('project:') ? `the project ${s.slice(8)}` : s);

export default function Monitoring() {
  usePageTitle('Monitoring');
  const me = useMe();
  const admin = me?.role === 'manager';
  const data = useApi<MonitoringView>('/api/monitoring', { refetchInterval: 60_000 });
  const run = useAction();
  const qc = useQueryClient();
  const d = data.data;
  const down = d?.checks.filter((c) => c.state === 'down') ?? [];
  const failing = d?.checks.filter((c) => c.state !== 'down' && c.fails > 0) ?? [];

  const checkNow = async () => {
    const r = await run(() => api<MonitoringView>('/api/monitoring/check', {}), 'Checked.');
    if (r) qc.setQueryData(['/api/monitoring'], r);
  };

  return (
    <Page title="Monitoring" intro={`Every ${d ? Math.round(d.every / 60) : 5} minutes the panel checks every host, its certificates, a few other addresses, every service and its own pieces; each hour, the backups, the disk, the mail DNS records and the domain's registration too. Something that fails twice in a row is down, and you get an email; one more when it comes back.`}
      actions={<Button type="button" variant="outline" disabled={!d || d.againIn > 0} onClick={checkNow}><RefreshCw />Check now</Button>}>
      {!d ? <Loading /> : <>
        <section aria-label="Now" className={`mb-6 flex items-start gap-3 rounded-lg border p-4 ${down.length ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card'}`}>
          {down.length ? <CircleAlert className="mt-0.5 size-6 shrink-0 text-destructive" /> : <CircleCheck className="mt-0.5 size-6 shrink-0 text-success" />}
          <div className="min-w-0">
            <p data-testid="monitoring-now" className="text-lg font-semibold">{!d.round ? 'Not checked yet' : down.length ? `${plural(down.length, 'thing')} down` : 'All well'}</p>
            <p className="text-sm text-muted-foreground">
              {d.round ? <>Last checked {timeAgo(d.round.at)} ({plural(d.checks.length, 'check')}).</> : 'The first round runs a minute after the panel starts.'}
              {d.round?.note && <> {d.round.note}.</>}
              {failing.length > 0 && <> {plural(failing.length, 'check')} failed once: down if {failing.length === 1 ? 'it fails' : 'they fail'} again.</>}
            </p>
            {down.length > 0 && (
              <ul aria-label="Down now" className="mt-2 space-y-1 text-sm">
                {down.map((c) => <li key={c.key}><strong>{c.label}</strong>: {c.why} <span className="text-muted-foreground">(since {timeAgo(c.since)})</span></li>)}
              </ul>
            )}
          </div>
        </section>

        {GROUPS.map((g) => {
          const checks = d.checks.filter((c) => c.group === g.id);
          return (
            <Section key={g.id} flush title={g.title} intro={g.intro}>
              {checks.length === 0 ? <Empty>Nothing checked here yet.</Empty> : (
                <List label={`Checks: ${g.title}`}>
                  {checks.map((c) => <CheckRow key={c.key} c={c} admin={admin} events={d.events.filter((e) => e.key === c.key)} />)}
                </List>
              )}
            </Section>
          );
        })}

        <Section title="Emails" intro={`To the notice address, one per round at most, and ${d.mail.perDay} a day at most. What is quiet isn't emailed.`}>
          <p className="text-sm">{plural(d.mail.sentToday, 'email')} today{d.mail.heldToday ? `; ${plural(d.mail.heldToday, 'change')} not emailed (the day's limit)` : ''}.</p>
          {admin && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <Switch checked={d.mail.on} onCheckedChange={(on) => run(() => api<MonitoringView>('/api/monitoring/mail', { on }), on ? 'Monitoring emails are on.' : 'Monitoring emails are off.').then((r) => r && qc.setQueryData(['/api/monitoring'], r))} />
              Email me when something goes down or comes back
            </label>
          )}
        </Section>

        {admin && <QuietSection d={d} />}

        <Section flush title="The last 7 days" intro="What changed: down, back, stopped and started.">
          {d.events.length === 0 ? <Empty>No changes this week.</Empty> : (
            <List label="Changes">
              {d.events.slice(0, 100).map((e) => (
                <Row key={e.id} title={e.label} badges={<Badge variant={e.kind === 'down' || e.kind === 'still-down' ? 'danger' : e.kind === 'back' ? 'ok' : 'outline'}>{KIND[e.kind] ?? e.kind}</Badge>}
                  meta={[formatTime(e.at), e.why, MAIL[e.mail]].filter(Boolean).join(' · ')} />
              ))}
            </List>
          )}
        </Section>
      </>}
    </Page>
  );
}

function CheckRow({ c, events, admin }: { c: Check; events: Change[]; admin: boolean }) {
  const s = STATE[c.state];
  const last = events[0];
  const run = useAction();
  const qc = useQueryClient();
  // a DNS record that reads otherwise than it did: an admin may keep it as it is now
  const changed = admin && c.group === 'dns' && c.why.startsWith('changed:');
  return (
    <Row title={c.label}
      actions={changed ? <ActionButton variant="outline" onClick={async () => {
        const r = await run(() => api<MonitoringView>('/api/monitoring/records/keep', { key: c.key.slice('dns:'.length) }), 'Kept as it is now.');
        if (r) qc.setQueryData(['/api/monitoring'], r);
      }}>Keep as it is now</ActionButton> : undefined}
      badges={<>
        <Badge variant={s.variant}>{s.word}</Badge>
        {c.fails > 0 && c.state !== 'down' && <Badge variant="warn">failed once</Badge>}
        {c.quiet && <Badge variant="outline"><BellOff className="size-3" />quiet</Badge>}
      </>}
      meta={[c.why || null, `since ${timeAgo(c.since)}`, last ? `last change: ${KIND[last.kind] ?? last.kind} ${timeAgo(last.at)}` : null].filter(Boolean).join(' · ')} />
  );
}

function QuietSection({ d }: { d: MonitoringView }) {
  const uid = useId();
  const run = useAction();
  const qc = useQueryClient();
  const subjects = [...new Set(d.checks.map((c) => c.subject))].sort();
  const [subject, setSubject] = useState('all');
  const [hours, setHours] = useState('1');
  const set = (r: MonitoringView | undefined) => { if (r) qc.setQueryData(['/api/monitoring'], r); };
  return (
    <Section title="Quiet for maintenance" intro="Still checked and shown, but not emailed: before a planned stop, an install or a move.">
      {d.quiet.length > 0 && (
        <ul aria-label="Quiet now" className="mb-4 space-y-2 text-sm">
          {d.quiet.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-2">
              <span><strong>{subjectWords(q.subject)}</strong> until {formatTime(q.until)}{q.created_by ? ` (${q.created_by})` : ''}</span>
              <ActionButton variant="outline" icon={BellOff} onClick={async () => set(await run(() => api<MonitoringView>(`/api/monitoring/quiet/${q.id}/end`, {}), 'Not quiet any more.'))}>End now</ActionButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm" htmlFor={`${uid}-s`}>What
          <NativeSelect id={`${uid}-s`} value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-56">
            <option value="all">everything</option>
            {subjects.map((s) => <option key={s} value={s}>{subjectWords(s)}</option>)}
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${uid}-h`}>For
          <NativeSelect id={`${uid}-h`} value={hours} onChange={(e) => setHours(e.target.value)} className="w-32">
            <option value="1">1 hour</option><option value="4">4 hours</option><option value="24">24 hours</option>
          </NativeSelect>
        </label>
        <Button type="button" variant="outline" onClick={async () => set(await run(() => api<MonitoringView>('/api/monitoring/quiet', { subject, hours: Number(hours) }),
          `${subjectWords(subject)[0]!.toUpperCase()}${subjectWords(subject).slice(1)} is quiet for ${hours === '1' ? '1 hour' : `${hours} hours`}.`))}><BellOff />Make quiet</Button>
      </div>
    </Section>
  );
}
