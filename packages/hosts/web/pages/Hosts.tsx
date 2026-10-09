// Hosts, their routes, and site folders (docs/hosts-plan.md G3, G3b, step 3).
// A host is a name under the domain; a route sends a path on it to a site
// folder or redirects it. Nothing is on the internet until a route shows it (F1).
// Every change here goes to nginx at once, or not at all: if nginx refuses it,
// the panel says so and nothing changed.
//
// Accounts on a route (docs/roles-plan.md step 5): a folder or service route can be
// Open with accounts (anyone comes in, the app is told who is signed in) or Only
// people let in (a sign-in first), as well as open to anyone.
import { Globe, Plus, Power, PowerOff, RefreshCw, Trash2 } from 'lucide-react';
import { NeedList, type Need } from './AddDomain';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Addresses, Empty, Field, GuideLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, formatTime } from '@panel/core/web/lib/api';
import { isKept } from '@panel/core/web/lib/rights';

// kind: what it shows (docs/domains-hosts-plan.md step 2); the kind's own fields beside it
type RouteView = {
  id: number; path: string; kind: string; enabled: boolean; address: string;
  folderId: number | null; folder: string | null;
  spa?: boolean; headers?: { name: string; value: string }[]; cacheForever?: string[];                       // a site folder
  to?: string; status?: number; keepPath?: boolean;                                                          // a redirect
  service?: string; part?: string; websockets?: boolean; maxBodyMb?: number | null; signInPaths?: string[];  // a service
  project?: string; branch?: string;                                                                         // a project (docs/phase8b-plan.md 8b-2)
  accounts: Accounts;
  accessId: number | null;     // its Access page (roles, people), when it has accounts
};
type Accounts = 'open' | 'private' | null;
type HostView = {
  id: number; name: string; enabled: boolean; address: string; createdBy: string | null; createdAt: number; routes: RouteView[];
  adopted: boolean; withWww: boolean;
  domain: string; onHome: boolean;     // the domain it is on (docs/domains-hosts-plan.md step 7)
};
type ServicePort = { service: string; part: string; title: string; port: number };
type ProjectChoice = { id: string; kind: string; live: boolean; dev?: boolean };
type FolderView = { id: number; name: string; runPhp: boolean; adopted: boolean; exists: boolean; createdBy: string | null; createdAt: number; shownAt: string[] };
// accounts: null on a site with no accounts for visitors; open: whether "Open with accounts" is on
// kinds: what a route may show on this site; services: a service route's choices (for those who may)
type HostsData = {
  domain: string; hosts: HostView[]; folders: FolderView[]; kinds: { kind: string; label: string }[]; services?: ServicePort[]; projects?: ProjectChoice[];
  accounts: { open: boolean } | null;
};

// The checks (docs/domains-hosts-plan.md step 3): each name a host answers to
type Check = { ok: boolean; why: string };
type NameCheck = {
  name: string; checkedAt: number | null; dns?: Check; answers?: Check & { status: number | null };
  cert?: Check & { daysLeft: number | null };
};
type ChecksData = { againIn: number; hosts: { id: number; checks: NameCheck[] }[] };

// the same rule as the server's (packages/hosts/src/names.ts): one DNS label
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEPT_NAMES = ['panel', 'www', 'api', 'mail', 'git'];

export default function Hosts() {
  usePageTitle('Hosts');
  const data = useApi<HostsData>('/api/hosts');
  const me = useMe();
  const kept = !!me && isKept(me);
  // the DreamHost zone's own names: only for those who may make hosts
  const zone = useApi<{ ok: boolean; taken?: string[]; message?: string }>(kept ? null : '/api/hosts/zone', { staleTime: 5 * 60_000 });
  const d = data.data;
  const checks = useApi<ChecksData>('/api/hosts/checks', { staleTime: 60_000 });
  const qc = useQueryClient();
  const run = useAction();
  const checksOf = (id: number) => checks.data?.hosts.find((h) => h.id === id)?.checks ?? null;

  return (
    <Page title="Hosts" intro={<>{`A host is a name under ${d?.domain ?? 'the domain'}, or under another of the domains below. Its routes send a path to a site folder or a service, or redirect it. A folder isn't on the internet until a route shows it. Every change goes to nginx straight away, or not at all.`}<GuideLink topic="hosts">How hosts work</GuideLink></>}>
      {!kept && <Domains />}
      {!kept && <NewFolder domain={d?.domain} taken={zone.data?.taken ?? []} zoneDown={zone.data?.ok === false ? zone.data.message ?? '' : null} />}

      <Section flush title="Hosts" intro="Each host is checked every 10 minutes: its DNS points here, the certificate nginx gives covers it, and it answers."
        action={<ActionButton icon={RefreshCw} disabled={checks.isFetching} onClick={() => run(async () => {
          qc.setQueryData(['/api/hosts/checks'], await api<ChecksData>('/api/hosts/checks?again=1'));
        }, 'Checked again.')}>Check again</ActionButton>}>
        {!d ? <Loading /> : (
          <List label="Hosts">
            {d.hosts.length === 0 && <Empty>No hosts yet.</Empty>}
            {d.hosts.map((h) => <HostRow key={h.id} h={h} folders={d.folders} services={d.services ?? []} projects={d.projects ?? []} kinds={d.kinds} kept={kept} accounts={d.accounts} checks={checksOf(h.id)} />)}
          </List>
        )}
      </Section>

      {!kept && <NewHost home={d?.domain} taken={zone.data?.taken ?? []} />}

      <Section flush title="Site folders" intro="Folders of static files (and PHP pages, when that's on). A folder is served only where a route shows it.">
        {!d ? <Loading /> : (
          <List label="Site folders">
            {d.folders.length === 0 && <Empty>No site folders yet.</Empty>}
            {d.folders.map((f) => <FolderRow key={f.id} f={f} kept={kept} />)}
          </List>
        )}
      </Section>
    </Page>
  );
}

// The domains (docs/domains-hosts-plan.md steps 1 and 4): each with its settings and its
// checks; Add a domain is the setup guide.
type DomainView = {
  id: number; name: string; home: boolean; dns: string; front: string; cert: string; tls: { cert: string };
  wildcardRecord: boolean; folderHosts: boolean; hosts: number;
};
const DNS_WORDS: Record<string, string> = { dreamhost: 'DNS at DreamHost', cloudflare: 'DNS at Cloudflare', manual: 'DNS kept elsewhere' };
const CERT_WORDS: Record<string, string> = { 'wildcard-dns': 'wildcard certificate', 'per-host': 'a certificate per host', 'cloudflare-origin': "Cloudflare's origin certificate", files: 'certificate files', names: 'a certificate for its hosts only' };

function Domains() {
  const data = useApi<{ domains: DomainView[] }>('/api/domains');
  return (
    <Section flush title="Domains" intro="The names hosts are made under, and what each needs from DNS and its certificate."
      action={<Button asChild size="sm" variant="outline"><Link to="/hosts/add-domain"><Plus />Add a domain</Link></Button>}>
      {!data.data ? <Loading /> : (
        <List label="Domains">
          {data.data.domains.map((d) => <DomainRow key={d.id} d={d} />)}
        </List>
      )}
    </Section>
  );
}

function DomainRow({ d }: { d: DomainView }) {
  const run = useAction();
  const dialogs = useDialogs();
  // quiet: the row says so itself (and a domain just removed asks once more before it goes)
  const checks = useApi<{ checks: Need[] }>(`/api/domains/${d.id}/checks`, { staleTime: 5 * 60_000, meta: { quiet: true } });
  return (
    <Row title={d.name}
      badges={<>
        {d.home && <Badge>this panel's own</Badge>}
        <Badge variant="outline">{DNS_WORDS[d.dns] ?? d.dns}</Badge>
        <Badge variant="outline">{d.front === 'cloudflare' ? "behind Cloudflare's proxy" : 'nothing in front'}</Badge>
        <Badge variant="outline">{CERT_WORDS[d.cert] ?? d.cert}</Badge>
        {d.wildcardRecord && <Badge variant="outline">* record</Badge>}
      </>}
      meta={`${d.hosts === 1 ? '1 host' : `${d.hosts} hosts`} · ${d.tls.cert}`}
      actions={!d.home && d.hosts === 0 ? (
        <ActionButton variant="danger" icon={Trash2} onClick={async () => {
          if (!await dialogs.confirm({ title: `Remove the domain ${d.name}?`, action: 'Remove', danger: true,
            body: 'Its catch-all leaves nginx. Nothing on the server is deleted, and it can be added again.' })) return;
          await run(() => api(`/api/domains/${d.id}/delete`, {}), `${d.name} is removed.`);
        }}>Remove</ActionButton>
      ) : undefined}>
      <div className="mt-2">{checks.data ? <NeedList checks={checks.data.checks} /> : checks.isError ? <p className="text-sm text-destructive">The checks couldn't run.</p> : <Loading />}</div>
    </Row>
  );
}

function nameProblem(name: string, taken: string[]): string | null {
  if (!name) return '';
  if (!LABEL_RE.test(name)) return 'Lowercase letters, digits and hyphens, not starting or ending with a hyphen.';
  if (name === 'www') return 'www is never a host of its own: make "@" (the domain itself) with www beside it.';
  if (KEPT_NAMES.includes(name)) return `${name} is kept for the server itself.`;
  if (taken.includes(name)) return `${name} has a DNS record of its own at DreamHost, so it doesn't come here.`;
  return null;
}

// Add a static folder (G3b): the folder with a placeholder page, and by default
// the host of the same name showing it.
function NewFolder({ domain, taken, zoneDown }: { domain?: string; taken: string[]; zoneDown: string | null }) {
  const run = useAction();
  const uid = useId();
  const [name, setName] = useState('');
  const [show, setShow] = useState(true);
  const [php, setPhp] = useState(true);
  const n = name.trim();
  const problem = nameProblem(n, show ? taken : []);
  return (
    <Section title="Add a static folder" intro="A folder with a placeholder page in it. By default it shows at a host of the same name straight away.">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (problem !== null) return;
        const r = await run(() => api<{ address: string | null }>('/api/site-folders', { name: n, host: show, runPhp: php }),
          (x) => (x.address ? `Made. ${x.address} shows it now.` : `Made. ${n} isn't shown anywhere yet: add a route to show it.`));
        if (r) setName('');
      }}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Name" htmlFor={`${uid}-name`} className="flex-1">
            <Input id={`${uid}-name`} maxLength={63} placeholder="e.g. docs" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!problem} aria-describedby={`${uid}-hint`} />
          </Field>
          <Button type="submit" disabled={problem !== null}><Plus />Add folder</Button>
        </div>
        <p id={`${uid}-hint`} className={problem ? 'text-sm font-semibold text-destructive' : 'text-sm text-muted-foreground'}>
          {problem || (show ? `It will be at https://${n || 'name'}.${domain ?? ''}/` : 'It will be made, and shown nowhere until a route shows it.')}
        </p>
        {show && zoneDown !== null && <p className="text-sm font-semibold text-destructive">{zoneDown} No new host can be made until then.</p>}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2.5"><Checkbox checked={show} onCheckedChange={(v) => setShow(v === true)} /><span>Show it at its own host</span></label>
          <label className="flex items-center gap-2.5"><Checkbox checked={php} onCheckedChange={(v) => setPhp(v === true)} /><span>Run PHP pages</span></label>
        </div>
      </form>
    </Section>
  );
}

// Add a host (docs/domains-hosts-plan.md 7-6): on the home domain, or on another one the
// site has; "@" is the domain itself, with www beside it when ticked.
function NewHost({ home, taken }: { home?: string; taken: string[] }) {
  const run = useAction();
  const uid = useId();
  const domains = useApi<{ domains: DomainView[] }>('/api/domains');
  const [name, setName] = useState('');
  const [on, setOn] = useState('');
  const [www, setWww] = useState(true);
  const n = name.trim();
  const list = domains.data?.domains ?? [];
  const d = list.find((x) => x.name === on) ?? list.find((x) => x.home);
  const onHome = !d || d.home;
  const dn = d?.name ?? home ?? '';
  const apex = n === '@';
  const problem = apex ? null : nameProblem(n, onHome ? taken : []);
  const shown = apex ? `https://${dn}/${www ? ` and https://www.${dn}/` : ''}` : `https://${n || 'name'}.${dn}/`;
  return (
    <Section title="Add a host" intro={'A name with nothing on it yet: add a route to it afterwards. "@" is the domain itself. (To show a new folder, Add a static folder above does both.)'}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (problem !== null) return;
        const r = await run(() => api<{ address: string }>('/api/hosts', { name: n, ...(onHome ? {} : { domain: dn }), ...(apex ? { withWww: www } : {}) }),
          (x) => `Made. ${x.address} answers "not found" until a route shows something there.`);
        if (r) setName('');
      }}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Name" htmlFor={`${uid}-host`} className="flex-1">
            <Input id={`${uid}-host`} maxLength={63} placeholder="e.g. shop, or @" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!problem} aria-describedby={`${uid}-hint`} />
          </Field>
          {list.length > 1 && (
            <Field label="Domain" htmlFor={`${uid}-domain`}>
              <NativeSelect id={`${uid}-domain`} value={dn} onChange={(e) => setOn(e.target.value)}>
                {list.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Button type="submit" variant="outline" disabled={problem !== null}><Globe />Add host</Button>
        </div>
        <p id={`${uid}-hint`} className={problem ? 'text-sm font-semibold text-destructive' : 'text-sm text-muted-foreground'}>
          {problem || `It will be at ${shown}`}
        </p>
        {apex && (
          <label className="flex items-center gap-2.5"><Checkbox checked={www} onCheckedChange={(v) => setWww(v === true)} /><span>www.{dn} too</span></label>
        )}
      </form>
    </Section>
  );
}

function HostRow({ h, folders, services, projects, kinds, kept, accounts, checks }: {
  h: HostView; folders: FolderView[]; services: ServicePort[]; projects: ProjectChoice[]; kinds: HostsData['kinds']; kept: boolean; accounts: HostsData['accounts'];
  checks: NameCheck[] | null;
}) {
  const run = useAction();
  const dialogs = useDialogs();
  const [adding, setAdding] = useState(false);
  const live = h.enabled && h.routes.some((r) => r.enabled);
  // "@" is the domain itself (docs/adopt-plan.md V2); a host on another domain says which (step 7)
  const title = h.name === '@' ? `${h.domain}${h.withWww ? ` and www.${h.domain}` : ''}` : h.onHome ? h.name : `${h.name}.${h.domain}`;
  // how the notices and the confirm name it: the domain itself for "@", the full name on another domain
  const who = h.name === '@' ? h.domain : h.onHome ? h.name : `${h.name}.${h.domain}`;
  return (
    <Row title={title}
      badges={<>
        {h.adopted && <Badge>taken over from its hand-written nginx file</Badge>}
        {!h.enabled && <Badge variant="warn">switched off</Badge>}
        {h.enabled && !live && <Badge>nothing shown yet</Badge>}
      </>}
      meta={`${h.createdBy ? `made by ${h.createdBy} ` : ''}${formatTime(h.createdAt)}`}
      actions={<>
        <ActionButton icon={Plus} onClick={() => setAdding((x) => !x)}>Add a route</ActionButton>
        <ActionButton variant={h.enabled ? 'outline' : 'default'} icon={h.enabled ? PowerOff : Power}
          onClick={() => run(() => api(`/api/hosts/${h.id}`, { enabled: !h.enabled }), h.enabled ? `${who} is switched off: it answers "not found".` : `${who} is switched on.`)}>
          {h.enabled ? 'Switch off' : 'Switch on'}
        </ActionButton>
        {!kept && !h.adopted && (
          <ActionButton variant="danger" icon={Trash2} onClick={async () => {
            if (!await dialogs.confirm({ title: `Delete the host ${who}?`, action: 'Delete', danger: true,
              body: 'Its routes go with it, and its address answers "not found". The site folders it shows stay, with their files.' })) return;
            await run(() => api(`/api/hosts/${h.id}/delete`, {}), `${who} is deleted.`);
          }}>Delete</ActionButton>
        )}
      </>}>
      {live && <Addresses links={[{ href: h.address, text: h.address }]} />}
      {checks && <HostChecks checks={checks} />}
      {h.routes.length > 0 && (
        <ul className="mt-3 space-y-2 border-l-2 border-border pl-3" aria-label={`Routes of ${who}`}>
          {h.routes.map((r) => <RouteLine key={r.id} r={r} services={services} accounts={h.onHome ? accounts : null} />)}
        </ul>
      )}
      {adding && <NewRoute h={h} folders={folders} services={services} projects={projects} kinds={kinds} onDone={() => setAdding(false)} />}
    </Row>
  );
}

// One line per name: DNS, the certificate, the answer -- each plainly passed or not, and why
function HostChecks({ checks }: { checks: NameCheck[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm" aria-label="Checks">
      {checks.map((c) => (
        <li key={c.name} className="flex flex-wrap items-center gap-1.5">
          {checks.length > 1 && <span className="font-mono text-muted-foreground">{c.name}</span>}
          {c.checkedAt === null ? <Badge variant="outline">not checked yet</Badge> : <>
            <CheckBadge label="DNS" c={c.dns} />
            <CheckBadge label={c.cert?.ok ? `certificate, ${c.cert.daysLeft} days` : 'certificate'} c={c.cert} />
            <CheckBadge label={c.answers?.status ? `answers ${c.answers.status}` : 'answers'} c={c.answers} />
            <span className="text-xs text-muted-foreground">checked {formatTime(c.checkedAt)}</span>
          </>}
        </li>
      ))}
    </ul>
  );
}

function CheckBadge({ label, c }: { label: string; c?: Check }) {
  if (!c) return null;
  return <Badge variant={c.ok ? 'ok' : 'warn'} title={c.why}>{c.ok ? '✓' : '✗'} {label}{c.ok ? '' : `: ${c.why}`}</Badge>;
}

const ACCOUNT_WORDS: Record<'open' | 'private' | 'none', string> = {
  none: 'Open to anyone', open: 'Open with accounts', private: 'Only people let in',
};

function RouteLine({ r, services, accounts }: { r: RouteView; services: ServicePort[]; accounts: HostsData['accounts'] }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const svc = services.find((p) => p.service === r.service && p.part === r.part);
  const signIn = r.signInPaths ?? [];
  const headers = r.headers ?? [];
  const forever = r.cacheForever ?? [];
  const extras = r.kind === 'service'
    ? [r.websockets && 'websockets', r.maxBodyMb && `uploads up to ${r.maxBodyMb} MB`, signIn.length > 0 && `sign-in limited: ${signIn.join(', ')}`]
    : r.kind === 'folder' ? [headers.length > 0 && `${headers.length} security headers`, forever.length > 0 && `cached for good: ${forever.join(', ')}`] : [];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <span className="font-mono">{r.path}</span>
      <span>{r.kind === 'folder' ? <>shows <strong>{r.folder}</strong></>
        : r.kind === 'service' ? <>goes to <strong>{svc ? svc.title : `${r.service}/${r.part}`}</strong>{svc && <span className="text-muted-foreground"> (127.0.0.1:{svc.port})</span>}</>
        : r.kind === 'project' ? <>shows the project <strong>{r.project}</strong>{r.branch && r.branch !== 'main' ? ` (${r.branch})` : ''}</>
        : r.kind === 'redirect' ? <>redirects ({r.status}) to <span className="font-mono [overflow-wrap:anywhere]">{r.to}</span>{r.keepPath ? ', path and all' : ''}</>
        : <>shows <strong>{r.kind}</strong></>}</span>
      {extras.filter(Boolean).length > 0 && <span className="text-muted-foreground">{extras.filter(Boolean).join(' · ')}</span>}
      {!r.enabled && <Badge variant="warn">stopped</Badge>}
      {accounts && r.kind !== 'redirect' && (
        <span className="flex items-center gap-1.5">
          <label htmlFor={`${uid}-acc`} className="text-muted-foreground">Accounts</label>
          <NativeSelect id={`${uid}-acc`} className="h-7 w-auto py-0 text-sm" value={r.accounts ?? 'none'} onChange={async (e) => {
            const want = e.target.value === 'none' ? null : e.target.value as 'open' | 'private';
            if (want === null && !await dialogs.confirm({ title: `Open ${r.path} to anyone?`, action: 'Open to anyone',
              body: 'Nobody signs in there any more, and anyone given a role there loses it.' })) return;
            await run(() => api<{ lost: string[] }>(`/api/routes/${r.id}/accounts`, { accounts: want }), (x) =>
              `${r.path}: ${ACCOUNT_WORDS[want ?? 'none'].toLowerCase()}.${x.lost.length ? ` ${x.lost.join(', ')} lost their role there.` : ''}`);
          }}>
            <option value="none">{ACCOUNT_WORDS.none}</option>
            <option value="open" disabled={!accounts.open && r.accounts !== 'open'}>{ACCOUNT_WORDS.open}{!accounts.open && r.accounts !== 'open' ? ' (switched off)' : ''}</option>
            <option value="private">{ACCOUNT_WORDS.private}</option>
          </NativeSelect>
          {r.accessId !== null && <Link to={`/access/${r.accessId}`} className="font-semibold text-primary underline-offset-2 hover:underline">Who may use it</Link>}
        </span>
      )}
      {r.kind === 'folder' && (
        <span className="flex items-center gap-1.5">
          <Switch id={`${uid}-spa`} checked={r.spa === true} onCheckedChange={(v) => run(() => api(`/api/routes/${r.id}`, { spa: v }), v ? 'Single-page app: an unknown path now gives index.html.' : 'Single-page app off: an unknown path is "not found".')} />
          <label htmlFor={`${uid}-spa`} className="cursor-pointer">single-page app</label>
        </span>
      )}
      <ActionButton variant="ghost" className="h-7" icon={r.enabled ? PowerOff : Power}
        onClick={() => run(() => api(`/api/routes/${r.id}`, { enabled: !r.enabled }), r.enabled ? `${r.path} is stopped.` : `${r.path} is started.`)}>
        {r.enabled ? 'Stop' : 'Start'}
      </ActionButton>
      <ActionButton variant="ghost" className="h-7 text-destructive" icon={Trash2} onClick={async () => {
        if (!await dialogs.confirm({ title: `Remove the route ${r.path}?`, action: 'Remove', danger: true })) return;
        await run(() => api(`/api/routes/${r.id}/delete`, {}), `${r.path} is removed.`);
      }}>Remove</ActionButton>
    </li>
  );
}

function NewRoute({ h, folders, services, projects, kinds, onDone }: { h: HostView; folders: FolderView[]; services: ServicePort[]; projects: ProjectChoice[]; kinds: HostsData['kinds']; onDone: () => void }) {
  const run = useAction();
  const uid = useId();
  const [path, setPath] = useState(h.routes.some((r) => r.path === '/') ? '' : '/');
  const [kind, setKind] = useState<string>(folders.length ? 'folder' : 'redirect');
  const [folderId, setFolderId] = useState(String(folders[0]?.id ?? ''));
  const [svc, setSvc] = useState(services[0] ? `${services[0].service}/${services[0].part}` : '');
  const [project, setProject] = useState(projects[0]?.id ?? '');
  const [maxBody, setMaxBody] = useState('');
  const [signIn, setSignIn] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('302');
  const [keepPath, setKeepPath] = useState(true);
  return (
    <form className="mt-3 grid gap-3 rounded-lg border border-border p-3" onSubmit={async (e) => {
      e.preventDefault();
      const [service, part] = svc.split('/');
      const b = kind === 'folder' ? { path, kind, folderId: Number(folderId) }
        // (a project's dev branch is "<name>@dev": docs/phase8b-plan.md 8b-3)
        : kind === 'project' ? { path, kind, project: project.split('@')[0], branch: project.endsWith('@dev') ? 'dev' : 'main' }
        : kind === 'service' ? { path, kind, service, part, websockets: true, maxBodyMb: maxBody ? Number(maxBody) : null, signInPaths: signIn.split(/[\s,]+/).filter(Boolean) }
        : { path, kind, to, status: Number(status), keepPath };
      const r = await run(() => api(`/api/hosts/${h.id}/routes`, b), 'Route added. nginx has it now.');
      if (r) onDone();
    }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Path" htmlFor={`${uid}-path`}>
          <Input id={`${uid}-path`} placeholder="/ or /docs/" autoCapitalize="none" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        <Field label="What it does" htmlFor={`${uid}-kind`}>
          {/* the kinds this site has (docs/domains-hosts-plan.md step 2), each when there's something to choose */}
          <NativeSelect id={`${uid}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.filter((k) => (k.kind !== 'service' || services.length > 0) && (k.kind !== 'project' || projects.length > 0)).map((k) => (
              <option key={k.kind} value={k.kind} disabled={k.kind === 'folder' && !folders.length}>{k.label}</option>
            ))}
          </NativeSelect>
        </Field>
        {kind === 'project' ? (
          <Field label="Project" htmlFor={`${uid}-project`}>
            <NativeSelect id={`${uid}-project`} value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.flatMap((p) => [
                <option key={p.id} value={p.id}>{p.id}{p.live ? '' : ' (not built yet)'}</option>,
                ...(p.dev ? [<option key={`${p.id}@dev`} value={`${p.id}@dev`}>{p.id}, its dev branch (a preview)</option>] : []),
              ])}
            </NativeSelect>
          </Field>
        ) : kind === 'service' ? (
          <Field label="Service" htmlFor={`${uid}-svc`}>
            <NativeSelect id={`${uid}-svc`} value={svc} onChange={(e) => setSvc(e.target.value)}>
              {services.map((p) => <option key={`${p.service}/${p.part}`} value={`${p.service}/${p.part}`}>{p.title} (:{p.port})</option>)}
            </NativeSelect>
          </Field>
        ) : kind === 'folder' ? (
          <Field label="Site folder" htmlFor={`${uid}-folder`}>
            <NativeSelect id={`${uid}-folder`} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </NativeSelect>
          </Field>
        ) : (
          <Field label="Kind" htmlFor={`${uid}-status`}>
            <NativeSelect id={`${uid}-status`} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="302">Temporary (302)</option>
              <option value="301">Permanent (301)</option>
            </NativeSelect>
          </Field>
        )}
      </div>
      {kind === 'service' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Largest upload, MB" htmlFor={`${uid}-body`} hint="Empty: nginx's own 1 MB.">
            <Input id={`${uid}-body`} inputMode="numeric" placeholder="1" value={maxBody} onChange={(e) => setMaxBody(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Sign-in paths" htmlFor={`${uid}-signin`} hint="Each limited to 5 tries a minute per address. =/path for exactly that address.">
            <Input id={`${uid}-signin`} placeholder="/api/auth/sign-in" autoCapitalize="none" spellCheck={false} value={signIn} onChange={(e) => setSignIn(e.target.value)} />
          </Field>
        </div>
      )}
      {kind === 'redirect' && (
        <div className="grid gap-2">
          <Field label="To" htmlFor={`${uid}-to`}>
            <Input id={`${uid}-to`} placeholder="https://example.com/page or /page" autoCapitalize="none" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2.5 text-sm"><Checkbox checked={keepPath} onCheckedChange={(v) => setKeepPath(v === true)} /><span>Take the rest of the path along ({h.name}{path || '/'}x goes to …/x)</span></label>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit"><Plus />Add route</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function FolderRow({ f, kept }: { f: FolderView; kept: boolean }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  return (
    <Row title={f.name}
      badges={<>
        {f.adopted && <Badge>on the server before the panel</Badge>}
        {!f.exists && <Badge variant="warn">not on disk</Badge>}
        {f.shownAt.length === 0 && <Badge>not shown anywhere</Badge>}
      </>}
      meta={`${f.createdBy ? `made by ${f.createdBy} ` : ''}${formatTime(f.createdAt)}`}
      // one that was on the server before the panel goes only once no route shows it
      actions={!kept && (!f.adopted || f.shownAt.length === 0) ? (
        <ActionButton variant="danger" icon={Trash2} onClick={async () => {
          if (!await dialogs.confirm({ title: `Delete the site folder ${f.name}?`, action: 'Delete', danger: true,
            body: `${f.shownAt.length ? 'Its routes are removed first, so those addresses stop working. ' : ''}${f.adopted ? 'It was on the server before the panel. ' : ''}The folder goes to the trash for 30 days.` })) return;
          await run(() => api(`/api/site-folders/${f.id}/delete`, {}), `${f.name} is in the trash.`);
        }}>Delete</ActionButton>
      ) : undefined}>
      {f.shownAt.length > 0 && <Addresses links={f.shownAt.map((a) => ({ href: a, text: a }))} />}
      <div className="mt-2 flex items-center gap-2 text-sm">
        <Switch id={`${uid}-php`} checked={f.runPhp} onCheckedChange={(v) => run(() => api(`/api/site-folders/${f.id}`, { runPhp: v }), v ? `PHP pages in ${f.name} run.` : `PHP pages in ${f.name} don't run (and are never sent as text).`)} />
        <label htmlFor={`${uid}-php`} className="cursor-pointer">Run PHP pages</label>
      </div>
    </Row>
  );
}
