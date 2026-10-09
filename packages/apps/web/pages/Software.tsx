// Installed software (docs/apps-plan.md): WordPress, which runs on pammy.org
// beside her own pages. How it is doing (phase 1), and from phase 2: backups
// (now, download, put one back), offline and online again, a new admin
// password, and what it complained about. Moving it waits for phase 4.
//
// Everything here is what the software helper says (src/apps/): the panel
// doesn't look at WordPress itself. The long changes are jobs: the page asks
// again every two seconds while one runs.
import { ArrowLeft, Copy, Mail, MoveRight, Plus, DatabaseBackup, Download, ExternalLink as ExternalIcon, KeyRound, Loader2, LogIn, Power, PowerOff, RefreshCw, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Collapsible, Empty, ExternalLink, Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, ApiError, formatTime, timeAgo } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import type { SoftwareBackup, SoftwareJob, SoftwareStatus, SoftwareSummary } from '../lib/types';
import { useWholeSite } from '../lib/whole-site';
import { SITE } from '@panel/core/web/lib/site';

export function sizeOf(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'not known';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const STATE: Record<SoftwareStatus['state'], { label: string; variant: 'ok' | 'warn' | 'danger' | 'outline'; says: string }> = {
  running: { label: 'Working', variant: 'ok', says: 'It is running, and it answered when the panel opened it.' },
  offline: { label: 'Offline', variant: 'outline', says: 'It is offline: visitors can’t see it, and nothing of it was deleted.' },
  stopped: { label: 'Stopped', variant: 'danger', says: 'It is not running, so visitors can’t see it.' },
  trouble: { label: 'Needs a look', variant: 'warn', says: 'Something isn’t right:' },
  installing: { label: 'Installing…', variant: 'outline', says: 'It is being installed.' },
  failed: { label: 'Didn’t finish', variant: 'danger', says: 'Installing it didn’t finish. What it made is kept, and “Try again” picks up where it stopped:' },
  deleted: { label: 'Deleted', variant: 'outline', says: 'It is deleted: offline, and out of your folders. Its files, database and backups are kept for 30 days, then deleted for good.' },
};

export function StateBadge({ status }: { status: SoftwareStatus | undefined }) {
  if (!status) return <Badge variant="outline">checking…</Badge>;
  const s = STATE[status.state];
  return <Badge variant={s.variant} data-testid="software-state">{s.label}</Badge>;
}

// "WordPress (garden)": with more than one install, each needs its own name
export const nameOf = (s: SoftwareSummary) => `${s.kindName} (${s.id})`;

function whereOf(s: SoftwareSummary): string {
  if (s.deleted) return `Deleted ${formatTime(s.deleted.at)}; kept until ${formatTime(s.deleted.until)}.`;
  if (s.setup) return s.setup.state === 'installing' ? 'Not at its address yet: it is being installed.' : 'Not at any address: installing it didn’t finish.';
  if (!s.placement) return 'The panel can’t tell where it is served.';
  switch (s.placement.mode) {
    case 'subdomain': return `On its own subdomain, ${s.placement.name}.${SITE.domain}`;
    case 'path': return `In a folder of ${SITE.domain}, /${s.placement.name}/`;
    case 'root': return `As the whole of ${SITE.domain}`;
    case 'off': return 'Not served at any address';
  }
}

function OpenButtons({ s }: { s: SoftwareSummary }) {
  if (!s.address) return null;
  return <>
    <Button asChild size="sm" variant="outline"><a href={s.address} target="_blank" rel="noopener"><ExternalIcon />Open it</a></Button>
    {s.adminAddress && <Button asChild size="sm" variant="outline"><a href={s.adminAddress} target="_blank" rel="noopener"><LogIn />Sign in to its admin</a></Button>}
  </>;
}

// ------------------------------------------------------------------ the list
function SoftwareRow({ s }: { s: SoftwareSummary }) {
  const status = useApi<SoftwareStatus>(`/api/software/${s.id}`, { meta: { quiet: true } });
  return (
    <Row title={<Link className="hover:underline" to={`/software/${s.id}`}>{nameOf(s)}</Link>}
      badges={<StateBadge status={status.data} />}
      meta={<Facts items={[
        s.address ? <ExternalLink href={s.address}>{s.address.replace(/^https:\/\//, '').replace(/\/$/, '')}</ExternalLink> : whereOf(s),
        s.version ? `version ${s.version}` : null,
        status.data?.backups.last ? `last backup ${timeAgo(status.data.backups.last.at)}` : null,
      ]} />}
      actions={<>
        <OpenButtons s={s} />
        <Button asChild size="sm"><Link to={`/software/${s.id}`}>How it’s doing</Link></Button>
      </>} />
  );
}

export default function Software() {
  usePageTitle('Installed software');
  const list = useApi<{ apps: SoftwareSummary[] }>('/api/software', { meta: { quiet: true } });
  return (
    <Page title="Installed software"
      intro={<>Ready-made software that runs on {SITE.domain} beside your own pages, like WordPress. The panel keeps an eye on it for you. <InlineLink to="/help/wordpress">About WordPress</InlineLink></>}
      actions={<Button asChild><Link to="/software/new"><Plus />Install WordPress</Link></Button>}>
      {list.error ? <Unavailable message={list.error.message} />
        : !list.data ? <Loading rows={1} />
        : (
          <>
            <Section flush title={`On ${SITE.domain}`}>
              <List label="Installed software">
                {list.data.apps.filter((s) => !s.deleted).length === 0 && <Empty>Nothing is installed yet.</Empty>}
                {list.data.apps.filter((s) => !s.deleted).map((s) => <SoftwareRow key={s.id} s={s} />)}
              </List>
            </Section>
            {list.data.apps.some((s) => s.deleted) && (
              <Section flush title="Deleted" intro="Kept for 30 days after it was deleted, then deleted for good. Until then it can be restored.">
                <List label="Deleted software">
                  {list.data.apps.filter((s) => s.deleted).map((s) => (
                    <Row key={s.id} title={<Link className="hover:underline" to={`/software/${s.id}`}>{nameOf(s)}</Link>}
                      meta={<Facts items={[`deleted ${timeAgo(s.deleted!.at)}`, `kept until ${formatTime(s.deleted!.until)}`]} />}
                      actions={<Button asChild size="sm" variant="outline"><Link to={`/software/${s.id}`}>Restore or delete for good</Link></Button>} />
                  ))}
                </List>
              </Section>
            )}
          </>
        )}
    </Page>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <Section title="The panel can’t see your software just now" className="border-destructive/40">
      <p className="text-sm">{message}</p>
    </Section>
  );
}

// ------------------------------------------------------------------ one of them
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const DOING: Record<SoftwareJob['op'], string> = {
  backup: 'Making a backup', restore: 'Putting a backup back', offline: 'Taking it offline',
  online: 'Bringing it back online', 'admin-password': 'Making a new admin password', 'mail-test': 'Sending a test email', move: 'Moving it', install: 'Installing it',
  delete: 'Deleting it', undelete: 'Restoring it', purge: 'Deleting it for good',
};
const DONE: Record<SoftwareJob['op'], string> = {
  backup: 'Backup', restore: 'Backup put back', offline: 'Taken offline', online: 'Back online', 'admin-password': 'New admin password', 'mail-test': 'Test email', move: 'Moved', install: 'Installed',
  delete: 'Deleted', undelete: 'Restored', purge: 'Deleted for good',
};
const whenOf = (stamp: string) => formatTime(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13)) / 1000);

function Working({ job }: { job: SoftwareJob }) {
  return (
    <Section className="border-primary/40">
      <p className="flex items-center gap-2 text-sm font-medium" role="status" data-testid="software-job">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        {DOING[job.op]}: {job.step.toLowerCase()}…
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Started {timeAgo(job.startedAt)} by {job.by}. You can leave this page; it carries on.</p>
    </Section>
  );
}

function Backups({ s }: { s: SoftwareStatus }) {
  const list = useApi<{ backups: SoftwareBackup[] }>(`/api/software/${s.id}/backups`, { meta: { quiet: true } });
  const run = useAction();
  const dialogs = useDialogs();
  const busy = !!s.job;
  const now = () => run(() => api(`/api/software/${s.id}/backup`, {}), 'Making a backup. It takes a minute or two.');
  const putBack = async (b: SoftwareBackup) => {
    if (!await dialogs.confirm({
      title: `Put back the backup of ${whenOf(b.stamp)}?`,
      body: <>
        <p>Its files and its database go back to how they were then: posts, pages, comments, settings, themes, plugins and uploads. Anything added since is replaced.</p>
        <p className="mt-2">A backup of how it is now is made first, so this can be undone the same way. It is unavailable for a minute or two while this happens.</p>
      </>,
      action: 'Put it back', danger: true,
    })) return;
    await run(() => api(`/api/software/${s.id}/restore`, { stamp: b.stamp }), 'Putting the backup back. Visitors will see it again in a minute or two.');
  };
  const backups = list.data?.backups ?? [];
  return (
    <Section flush title="Backups"
      intro="A new one is made every night and kept for 14 days. Each has its files and its database."
      action={<ActionButton icon={DatabaseBackup} size="sm" variant="outline" disabled={busy || !!s.offline} onClick={now}>Back up now</ActionButton>}>
      <List label="Backups">
        {!list.data && <Empty>Looking…</Empty>}
        {list.data && backups.length === 0 && <Empty>No backups yet.</Empty>}
        {backups.map((b, i) => (
          <Row key={b.stamp} title={whenOf(b.stamp)}
            badges={i === 0 ? <Badge variant="outline">newest</Badge> : undefined}
            meta={<Facts items={[sizeOf(b.bytes), b.address && s.siteAddress && b.address !== s.siteAddress ? `made when it was at ${b.address}` : null]} />}
            actions={<>
              <Button asChild size="sm" variant="outline"><a href={`/api/software/${s.id}/backups/${b.stamp}/download`} download><Download />Download</a></Button>
              <ActionButton icon={RotateCcw} size="sm" variant="outline" disabled={busy || !!s.offline} onClick={() => putBack(b)}>Put this back</ActionButton>
            </>} />
        ))}
      </List>
    </Section>
  );
}

function AdminPassword({ s }: { s: SoftwareStatus }) {
  const [asked, setAsked] = useState(false);
  const admins = useApi<{ admins: string[] }>(asked ? `/api/software/${s.id}/admins` : null, { meta: { quiet: true }, staleTime: 60_000 });
  const [user, setUser] = useState('');
  const [made, setMade] = useState<{ user: string; password: string; savedTo: string | null } | null>(null);
  const run = useAction();
  const list = admins.data?.admins ?? [];
  const who = user || list[0] || '';
  const make = async () => {
    const r = await run(() => api<{ user: string; password: string; savedTo: string | null }>(`/api/software/${s.id}/admin-password`, { user: who }));
    if (r) setMade(r);
  };
  if (made) {
    return (
      <Section title={`A new password for ${made.user}`} className="border-primary/40">
        <p className="text-sm">Copy it now: the panel won’t show it again. {made.savedTo ? <>It is also in <code className="rounded bg-muted px-1">wordpress-login.txt</code> in your home folder.</> : null}</p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem]" data-testid="new-admin-password"><code>{`Username: ${made.user}\nPassword: ${made.password}`}</code></pre>
        <div className="mt-2 flex flex-wrap gap-2">
          <ActionButton icon={Copy} onClick={async () => { await navigator.clipboard.writeText(made.password); notify('Password copied.'); }}>Copy the password</ActionButton>
          {s.adminAddress && <Button asChild variant="outline"><a href={s.adminAddress} target="_blank" rel="noopener"><LogIn />Sign in to its admin</a></Button>}
          <Button variant="ghost" onClick={() => setMade(null)}>Done</Button>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Admin password"
      intro="Forgotten the password for its admin pages? Make a new one here. The old one stops working.">
      {!asked ? (
        <Button variant="outline" disabled={!!s.offline || !!s.job} onClick={() => setAsked(true)}><KeyRound />Make a new password…</Button>
      ) : !admins.data ? (
        admins.error ? <p className="text-sm text-destructive">{admins.error.message}</p> : <p className="text-sm text-muted-foreground">Asking WordPress who its administrators are…</p>
      ) : list.length === 0 ? (
        <p className="text-sm">WordPress says it has no administrators. Ask momolig.</p>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void make(); }}>
          {list.length > 1 && (
            <label className="grid gap-1 text-sm">For
              <NativeSelect value={who} onChange={(e) => setUser(e.target.value)} aria-label="Which administrator">
                {list.map((u) => <option key={u} value={u}>{u}</option>)}
              </NativeSelect>
            </label>
          )}
          <Button type="submit" disabled={!!s.job}><KeyRound />Make a new password{list.length === 1 ? ` for ${who}` : ''}</Button>
        </form>
      )}
    </Section>
  );
}

// Move (4a): a subdomain, a folder of pammy.org, or the whole site (not while the site is
// on its hosts, 8-7d). The panel refuses a name that is one of her folders; the passkey is
// asked again.
function Move({ s }: { s: SoftwareStatus }) {
  const wholeSite = useWholeSite();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'subdomain' | 'path' | 'root'>('subdomain');
  const [name, setName] = useState('');
  const run = useAction();
  const dialogs = useDialogs();
  if (s.offline) return null;
  const clean = name.trim().toLowerCase();
  const target = mode === 'root' ? SITE.domain : mode === 'subdomain' ? `${clean || 'name'}.${SITE.domain}` : `${SITE.domain}/${clean || 'name'}/`;
  const fromRoot = s.placement?.mode === 'root';
  const move = async () => {
    if (mode !== 'root' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) return notify('Use lowercase letters, digits and hyphens, like "journal".', 'error');
    if (!await dialogs.confirm({
      title: `Move ${s.kindName} to ${target}?`,
      body: <>
        <p>A backup is made first. Then it answers at {target}, and the links inside its posts and pages are changed to the new address. It is unavailable for a minute or two.</p>
        <p className="mt-2"><strong>The old address stops working</strong>{s.address ? ` (${s.address.replace(/^https:\/\//, '').replace(/\/$/, '')})` : ''}: links to it from elsewhere, and in emails already sent, won’t find it.</p>
        {mode === 'root' && <p className="mt-2">Your own home page (index.html) stops being the home page. Your other pages and folders stay as they are.</p>}
        {fromRoot && <p className="mt-2">It is the whole of {SITE.domain} now, so links in its posts to your other pages on {SITE.domain} are changed too. Look over them afterwards.</p>}
      </>,
      action: 'Move it', danger: true,
    })) return;
    const r = await run(() => api(`/api/software/${s.id}/move`, { mode, name: mode === 'root' ? undefined : clean }), 'Moving it. It takes a minute or two.');
    if (r) setOpen(false);
  };
  return (
    <Section title="Move it"
      intro={wholeSite ? `Put it at another address: its own subdomain, a folder of ${SITE.domain}, or the whole site.` : `Put it at another address: its own subdomain, or a folder of ${SITE.domain}.`}
      action={!open ? <Button size="sm" variant="outline" disabled={!!s.job} onClick={() => setOpen(true)}><MoveRight />Move it…</Button> : undefined}>
      {open && (
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void move(); }}>
          <fieldset className="grid gap-1.5 text-sm">
            <legend className="mb-1 font-semibold">Where</legend>
            {([['subdomain', `Its own subdomain, like journal.${SITE.domain}`], ['path', `A folder of ${SITE.domain}, like ${SITE.domain}/journal/`], ['root', `The whole of ${SITE.domain}`]] as const).filter(([v]) => v !== 'root' || wholeSite).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" name="move-mode" value={v} checked={mode === v} onChange={() => setMode(v)} />{label}</label>
            ))}
          </fieldset>
          {mode !== 'root' && (
            <Field label="Name" htmlFor="move-name" hint="Lowercase letters, digits and hyphens. Not the name of one of your folders.">
              <Input id="move-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={63} autoComplete="off" spellCheck={false} placeholder="journal" />
            </Field>
          )}
          <p className="text-sm text-muted-foreground">It will be at <strong>{target}</strong>.</p>
          <div className="flex gap-2">
            <Button type="submit" disabled={!!s.job}><MoveRight />Move it</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

// Delete (4c): to the deleted software for 30 days -- or, for an install that
// didn't finish, for good at once. Her passkey, and its name typed out.
function DeleteIt({ s }: { s: SoftwareStatus }) {
  const run = useAction();
  const dialogs = useDialogs();
  const unfinished = !!s.setup;
  const del = async () => {
    const typed = await dialogs.prompt({
      title: unfinished ? `Delete ${nameOf(s)} for good?` : `Delete ${nameOf(s)}?`,
      body: unfinished
        ? <p>Installing it didn’t finish, so there is nothing in it to keep: what it made so far is removed for good.</p>
        : <>
          <p>{s.offline ? '' : 'A last backup is made first. Then '}{s.address ? `${s.address.replace(/^https:\/\//, '').replace(/\/$/, '')} stops working` : 'it is stopped'}, and its folder leaves your folders.</p>
          <p className="mt-2">Its files, database and backups are kept for 30 days: until then, “Restore” brings it all back. After that they are deleted for good.</p>
        </>,
      label: `Type its name, “${s.id}”, to delete it`,
      action: unfinished ? 'Delete it for good' : 'Delete it',
    });
    if (typed === null) return;
    if (typed.trim() !== s.id) return notify(`That isn’t its name. Type “${s.id}” to delete it.`, 'error');
    await run(() => api(`/api/software/${s.id}/delete`, { confirm: typed.trim() }), unfinished ? 'Deleting it for good.' : 'Deleting it.');
  };
  return (
    <Section title="Delete it" className="border-destructive/40"
      intro={unfinished ? 'Give up on this install and remove what it made.' : 'Take it away: kept for 30 days in case you change your mind.'}>
      <ActionButton icon={Trash2} variant="destructive" disabled={!!s.job} onClick={del}>Delete it…</ActionButton>
    </Section>
  );
}

// A deleted one (4c): restore it, offline, or delete it for good now.
function Deleted({ s }: { s: SoftwareStatus }) {
  const run = useAction();
  const dialogs = useDialogs();
  const d = s.deleted!;
  const restore = () => run(() => api(`/api/software/${s.id}/undelete`, {}), 'Restoring it.');
  const purge = async () => {
    const typed = await dialogs.prompt({
      title: `Delete ${nameOf(s)} for good?`,
      body: <>
        <p>Its files, its database and all its backups are removed, and can’t be brought back. Download a backup first if you might want anything from it.</p>
        <p className="mt-2">Otherwise this happens by itself on {formatTime(d.until)}.</p>
      </>,
      label: `Type its name, “${s.id}”, to delete it for good`,
      action: 'Delete it for good',
    });
    if (typed === null) return;
    if (typed.trim() !== s.id) return notify(`That isn’t its name. Type “${s.id}” to delete it for good.`, 'error');
    await run(() => api(`/api/software/${s.id}/purge`, { confirm: typed.trim() }), 'Deleting it for good.');
  };
  return (
    <Section title="Deleted" className="border-destructive/40">
      <p className="text-sm">Deleted {formatTime(d.at)} by {d.by}. It is kept until <strong>{formatTime(d.until)}</strong>, then deleted for good.</p>
      <p className="mt-1 text-sm text-muted-foreground">Restore brings it back offline, with its folder back in your folders; then “Bring it back online” puts it at its address again.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton icon={Undo2} disabled={!!s.job} onClick={restore}>Restore it</ActionButton>
        <ActionButton icon={Trash2} variant="destructive" disabled={!!s.job} onClick={purge}>Delete it for good…</ActionButton>
      </div>
    </Section>
  );
}

function Complaints({ s }: { s: SoftwareStatus }) {
  const [open, setOpen] = useState(false);
  const logs = useApi<{ web: string[]; db: string[] }>(open ? `/api/software/${s.id}/logs` : null, { meta: { quiet: true } });
  const part = (title: string, lines: string[] | undefined) => (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {!lines ? <p className="text-sm text-muted-foreground">Looking…</p>
        : lines.length === 0 ? <p className="text-sm text-muted-foreground">Nothing lately.</p>
        : <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{lines.join('\n')}</pre>}
    </div>
  );
  return (
    <Collapsible summary="What it complained about lately" onToggle={setOpen}>
      <p className="mb-3 text-sm text-muted-foreground">Its last warnings and errors, newest at the bottom. Mostly useful to momolig, or to Claude when something is wrong.</p>
      {logs.error ? <p className="text-sm text-destructive">{logs.error.message}</p> : (
        <div className="grid gap-4">{part('Its web server', logs.data?.web)}{part('Its database', logs.data?.db)}</div>
      )}
    </Collapsible>
  );
}

function History({ jobs }: { jobs: SoftwareJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <Section flush title="What was done lately">
      <List label="What was done lately">
        {jobs.map((j) => (
          <Row key={`${j.op}-${j.startedAt}`} title={DONE[j.op]}
            badges={j.ok ? undefined : <Badge variant="danger">didn’t work</Badge>}
            meta={<Facts items={[`${timeAgo(j.endedAt ?? j.startedAt)} by ${j.by}`, j.message]} />} />
        ))}
      </List>
    </Section>
  );
}

export function SoftwareDetail() {
  const { id = '' } = useParams();
  const status = useApi<SoftwareStatus>(`/api/software/${id}`, {
    meta: { quiet: true },
    // while something is being done to it, ask again every two seconds
    refetchInterval: (q) => (q.state.data?.job ? 2000 : false),
  });
  const s = status.data;
  const run = useAction();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  // a job just ended: its backups, its admins, its complaints may all be new
  const hadJob = useRef(false);
  useEffect(() => {
    if (hadJob.current && !s?.job) void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(`/api/software/${id}/`) });
    hadJob.current = !!s?.job;
  }, [s?.job, id, qc]);
  // A new install's admin password (4b): the helper hands it over once, within
  // the hour after it finished; asked for once, when the page sees that install.
  const [login, setLogin] = useState<{ user: string; password: string } | null>(null);
  const askedLogin = useRef(false);
  const justInstalled = !s?.job && s?.recent[0]?.op === 'install' && s.recent[0].ok && !!s.recent[0].endedAt && Date.now() / 1000 - s.recent[0].endedAt < 3600;
  useEffect(() => {
    if (!justInstalled || askedLogin.current) return;
    askedLogin.current = true;
    api<{ login: { user: string; password: string } | null }>(`/api/software/${id}/login`, {}).then((r) => { if (r.login) setLogin(r.login); }, () => {});
  }, [justInstalled, id]);
  usePageTitle(s ? nameOf(s) : 'Installed software');
  // Deleted for good while this page watched (the page may never see the job
  // itself, when it ends between two looks): shown a moment ago, not there now.
  const navigate = useNavigate();
  const gone = !!s && status.error instanceof ApiError && status.error.status === 404;
  useEffect(() => {
    if (!gone) return;
    notify('Deleted for good.');
    void qc.invalidateQueries({ queryKey: ['/api/software'] });
    navigate('/software', { replace: true });
  }, [gone, navigate, qc]);
  const back = <Button asChild variant="ghost" size="sm"><Link to="/software"><ArrowLeft />Installed software</Link></Button>;

  if (status.error) return <Page title="Installed software" actions={back}><Unavailable message={status.error.message} /></Page>;
  if (!s) return <Page title="Installed software" actions={back}><Loading /></Page>;

  const web = s.containers.find((c) => c.role === 'web');
  const db = s.containers.find((c) => c.role === 'db');
  const running = (c: typeof web) => !c ? 'not known' : c.running ? `running${c.memory !== null ? `, using ${sizeOf(c.memory)} of memory` : ''}` : 'not running';
  const lastFailed = !s.job && s.recent[0] && s.recent[0].ok === false && s.recent[0].endedAt && Date.now() / 1000 - s.recent[0].endedAt < 3600 ? s.recent[0] : null;

  const offline = async () => {
    if (!await dialogs.confirm({
      title: `Take ${s.kindName} offline?`,
      body: <>
        <p>Visitors to {s.address ? s.address.replace(/^https:\/\//, '').replace(/\/$/, '') : 'it'} won’t see it any more. It is stopped, and stays stopped until you bring it back, even if the server restarts.</p>
        <p className="mt-2">Nothing is deleted: its posts, files and backups stay. The nightly backup pauses while it is offline.</p>
      </>,
      action: 'Take it offline', danger: true,
    })) return;
    await run(() => api(`/api/software/${s.id}/offline`, {}));
  };
  const online = () => run(() => api(`/api/software/${s.id}/online`, {}));

  return (
    <Page title={nameOf(s)} actions={back}
      intro={s.address ? <ExternalLink href={s.address}>{s.address}</ExternalLink> : whereOf(s)}>

      {s.job && <Working job={s.job} />}
      {login && (
        <Section title={`It is installed. Its admin password, for ${login.user}`} className="border-primary/40">
          <p className="text-sm">Copy it now: the panel won’t show it again. It is also in <code className="rounded bg-muted px-1">apps/{s.id}-login.txt</code> in your home folder.</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem]" data-testid="install-password"><code>{`Username: ${login.user}\nPassword: ${login.password}`}</code></pre>
          <div className="mt-2 flex flex-wrap gap-2">
            <ActionButton icon={Copy} onClick={async () => { await navigator.clipboard.writeText(login.password); notify('Password copied.'); }}>Copy the password</ActionButton>
            {s.adminAddress && <Button asChild variant="outline"><a href={s.adminAddress} target="_blank" rel="noopener"><LogIn />Sign in to its admin</a></Button>}
            <Button variant="ghost" onClick={() => setLogin(null)}>Done</Button>
          </div>
        </Section>
      )}
      {lastFailed && (
        <Section className="border-destructive/40">
          <p className="text-sm" role="alert"><strong>{DONE[lastFailed.op]} didn’t work.</strong> {lastFailed.message}</p>
        </Section>
      )}

      <Section title={<span className="flex items-center gap-2">How it’s doing <StateBadge status={s} /></span>}
        action={<Button size="sm" variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}><RefreshCw />Check again</Button>}>
        <p className="text-sm">{STATE[s.state].says}{s.offline ? ` Taken offline ${timeAgo(s.offline.at)}.` : ''}</p>
        {s.problems.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm" data-testid="software-problems">
            {s.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        {s.answering && (
          <p className="mt-3 text-xs text-muted-foreground">
            Checked {timeAgo(s.answering.checkedAt)}
            {s.answering.ok && s.answering.ms !== null ? `; it answered in ${s.answering.ms < 1000 ? `${s.answering.ms} ms` : `${(s.answering.ms / 1000).toFixed(1)} seconds`}` : ''}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {!s.setup && !s.deleted && <OpenButtons s={s} />}
          {s.setup?.state === 'failed' && !s.job && (
            <Button asChild size="sm"><Link to={`/software/new?again=${encodeURIComponent(s.id)}`}><RotateCcw />Try again</Link></Button>
          )}
          {s.setup || s.deleted ? null : s.offline
            ? <ActionButton icon={Power} disabled={!!s.job} onClick={online}>Bring it back online</ActionButton>
            : <ActionButton icon={PowerOff} variant="outline" disabled={!!s.job} onClick={offline}>Take it offline</ActionButton>}
        </div>
      </Section>

      <Section title="Where it is">
        <dl className="divide-y divide-border">
          <Line label="Address">{s.offline ? 'Offline' : whereOf(s)}</Line>
          {s.siteAddress && s.address && s.siteAddress.replace(/\/$/, '') !== s.address.replace(/\/$/, '') && (
            <Line label="Its own settings say">{s.siteAddress} <span className="text-muted-foreground">(not the same, so some of its links may point to the old address)</span></Line>
          )}
          <Line label="Its files"><code className="rounded bg-muted px-1 py-0.5 text-[0.8125rem]">{s.filesPath}</code> <span className="text-muted-foreground">— with WinSCP or Claude, one level up from your website folder</span></Line>
          <Line label="Version">{s.version ? `${s.kindName} ${s.version}` : 'not known'}</Line>
          <Line label="Installed">{formatTime(s.installedAt)}{s.adoptedAt ? ', by momolig, before the panel looked after it' : ''}</Line>
        </dl>
      </Section>

      {s.deleted && <Deleted s={s} />}
      {!s.setup && !s.deleted && <>
      <Move s={s} />

      <Backups s={s} />
      <AdminPassword s={s} />
      <Section title="Email"
        intro="Password resets and comment notices from WordPress go out through Resend.">
        <Button asChild variant="outline"><Link to="/email"><Mail />Email settings and a test</Link></Button>
      </Section>
      </>}
      {s.deleted && <Backups s={s} />}

      <Section title="Inside">
        <dl className="divide-y divide-border">
          <Line label="Web server">{running(web)}</Line>
          <Line label="Database">{running(db)}</Line>
          <Line label="The server’s free memory">
            {s.server.memoryAvailable !== null && s.server.memoryTotal !== null ? `${sizeOf(s.server.memoryAvailable)} of ${sizeOf(s.server.memoryTotal)}` : 'not known'}
          </Line>
          <Line label="Space it uses">{`files ${sizeOf(s.disk.files)}, database ${sizeOf(s.disk.database)}, backups ${sizeOf(s.disk.backups)}`}</Line>
        </dl>
      </Section>

      <Complaints s={s} />
      <History jobs={s.recent} />
      {!s.deleted && !(s.setup?.state === 'installing') && <DeleteIt s={s} />}
    </Page>
  );
}
