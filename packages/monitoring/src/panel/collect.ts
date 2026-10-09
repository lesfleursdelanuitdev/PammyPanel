// A round's answers (docs/monitoring-plan.md M1, step 1), from what the panel may ask:
// the routing helper's probe for every host (DNS here, the certificate, it answers), the
// services helper for every part it can start and stop, and the panel's own pieces. The
// panel has no network of its own (its sandbox): everything goes through a helper. A
// helper that doesn't answer is one failure of its own ("the routing helper didn't
// answer"), and its group is left as it was (unread).
//
// Step 2: the certificates, from the hosts' checks (days left: a warning under 21, down
// under 7); and hourly (slow), the nightly backups and the disk (the services helper's
// storage) and the mail DNS records and nameservers (the routing helper's records),
// compared with what they were when first read. Between hours those rows stay as they were.
//
// Step 3: a few addresses outside the site's hosts (Q5), every round, through the routing
// helper's urls: they answer under 500, with a certificate for the name that isn't close
// to running out; and hourly, when the domain's registration runs out (Q4: shown, never
// down, so never mailed).
//
// Phase 8b (docs/phase8b-plan.md D4-12): each project's server, every round, through the
// projects helper: its live slot runs and answers (a server stopped from Projects is
// stopped on purpose).
import { SLOW, type Result } from '../state.ts';

// domain, front: its own, when it is on another domain (docs/domains-hosts-plan.md step 7)
export type HostRowLike = { name: string; with_www: boolean; enabled: boolean; domain?: string | null; front?: string | null };
type Named = { ok: boolean; why: string };
// covers: the certificate is for the name, whatever its days left (the certs group judges those)
export type CertLike = Named & { daysLeft?: number | null; notAfter?: number | null; names?: string[]; covers?: boolean };
export type HostCheckLike = { name: string; dns?: Named; cert?: CertLike; answers?: Named & { status?: number | null } };
export type StorageLike = {
  backups: { id: string; title: string; newest: { at: number; files: number; empty: number; bytes: number } | null; why: string | null }[];
  disks: { path: string; dev: string | null; size: number; avail: number; why: string | null }[];
};
export type RecordType = 'TXT' | 'MX' | 'NS';
// a record to watch: key ("dkim"), what it is called on the page, where it is
export type RecordWant = { key: string; label: string; name: string; type: RecordType };
export type RecordGot = { name: string; type: RecordType; ok: boolean; why: string; values: string[] };
export type PartLike = {
  id: string; title: string; controls: boolean; active: string; sub: string; masked: boolean;
  answering: { status: number | null; ms: number } | null; well: boolean | null;
};
export type ServiceLike = { id: string; title: string; parts: PartLike[] };
// a project's server branch, as the projects helper's health says
export type ProjectServerLike = {
  project: string; branch: 'main' | 'dev'; port: number; active: string; sub: string; stopped: boolean;
  answering: { status: number | null; ms: number } | null;
};
// an address outside the hosts: key ("gonsalves"), https://<name><path>
export type UrlWant = { key: string; name: string; path: string };
export type UrlGot = HostCheckLike & { path: string; via?: 'here' | 'cloudflare' | null };
export type RegistrationLike = { domain: string; ok: boolean; why: string; expires: number | null };

// One of the panel's own pieces: null when it answers, else what went wrong.
export type Piece = { id: string; label: string; ask: () => Promise<string | null> };

export type Sources = {
  domain: () => Promise<{ name: string; front: string }>;
  hosts: () => Promise<HostRowLike[]>;
  // the routing helper's check (fresh), for these hosts
  check: (domain: { name: string; front: string }, hosts: HostRowLike[]) => Promise<HostCheckLike[]>;
  services: (() => Promise<ServiceLike[]>) | null;
  // phase 8b: each project's server (left out where the site has no projects); 8b-8b: and
  // whether the build boxes' proxy runs (null: not asked)
  projects?: () => Promise<ProjectServerLike[] | { servers: ProjectServerLike[]; proxy?: boolean | null }>;
  pieces: Piece[];
  // the slow checks (step 2): each left out where the site has none
  storage?: () => Promise<StorageLike>;
  records?: {
    want: RecordWant[];
    read: (want: RecordWant[]) => Promise<RecordGot[]>;
    // what each record was when first read (key -> its values, a line each), and keeping one
    baseline: () => Promise<Map<string, string>>;
    keep: (key: string, value: string) => Promise<void>;
  };
  // step 3: other addresses (every round) and the registration (hourly)
  urls?: { want: UrlWant[]; check: (want: UrlWant[]) => Promise<UrlGot[]> };
  registration?: () => Promise<RegistrationLike>;
};

export const CERT_WARN_DAYS = 21;
export const CERT_DOWN_DAYS = 7;
export const BACKUP_MAX_AGE = 26 * 3600;
export const DISK_WARN = 0.15;
export const DISK_DOWN = 0.05;

const STORAGE = { key: 'panel:storage', group: 'panel' as const, subject: 'panel', label: 'Reading the backups and the disk (the services helper)', link: '/monitoring' };
const URLS = { key: 'panel:urls', group: 'panel' as const, subject: 'panel', label: 'Checking the other addresses (the routing helper)', link: '/monitoring' };
const RECORDS = { key: 'panel:records', group: 'panel' as const, subject: 'panel', label: 'Reading the DNS records (the routing helper)', link: '/monitoring' };
const day = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
const hours = (s: number) => (s < 5400 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 3600)} h`);
export const bytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const short = (v: string) => (v ? v.replace(/\n/g, ', ') : 'nothing').slice(0, 140);

const APEX = '@';
const namesOf = (h: HostRowLike, domain: string) => (h.name === APEX ? [domain, ...(h.with_www ? [`www.${domain}`] : [])] : [`${h.name}.${domain}`]);
const ROUTES = { key: 'panel:routes', group: 'panel' as const, subject: 'panel', label: "The routing helper (the hosts' checks)", link: '/monitoring' };
const SERVICES = { key: 'panel:services', group: 'panel' as const, subject: 'panel', label: 'The services helper', link: '/monitoring' };
const PROJECTS = { key: 'panel:projects', group: 'panel' as const, subject: 'panel', label: 'The projects helper', link: '/monitoring' };
const said = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);

// slow: this round asks the hourly checks too; at: now, in seconds (a backup's age)
export async function collect(s: Sources, opts: { slow?: boolean; at?: number } = {}): Promise<{ results: Result[]; unread: Set<string> }> {
  const results: Result[] = [];
  const unread = new Set<string>();
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const certs = new Map<string, { names: string[]; daysLeft: number; notAfter: number | null }>();
  // every name the hosts answer to: an "other address" that became a host is one of them
  // (docs/domains-hosts-plan.md 7-5: Gonsalves's, once taken over), and isn't asked twice
  const hostNames = new Set<string>();

  // hosts: each name each host answers to (@ with www: both), as the Hosts page shows them
  try {
    const home = await s.domain();
    const hosts = await s.hosts();
    const domainOf = (h: HostRowLike) => (h.domain ? { name: h.domain, front: h.front ?? 'direct' } : home);
    // one check a domain, each with its own front
    const groups = new Map<string, { d: { name: string; front: string }; on: HostRowLike[] }>();
    for (const h of hosts.filter((x) => x.enabled)) {
      const d = domainOf(h);
      groups.set(d.name, { d, on: [...(groups.get(d.name)?.on ?? []), h] });
    }
    const checks = (await Promise.all([...groups.values()].map((g) => s.check(g.d, g.on)))).flat();
    const by = new Map(checks.map((c) => [c.name, c]));
    for (const h of hosts) {
      for (const name of namesOf(h, domainOf(h).name)) {
        hostNames.add(name);
        const base = { key: `host:${name}`, group: 'hosts' as const, subject: name, label: name, link: '/hosts' };
        if (!h.enabled) { results.push({ ...base, ok: true, stopped: true, why: 'switched off' }); continue; }
        const c = by.get(name);
        // a certificate for the name is the host's pass; its days are the certs group's
        const cert = c?.cert?.covers === true ? { ok: true, why: '' } : c?.cert;
        const bad = !c ? { why: 'not checked' } : [c.dns, cert, c.answers].find((x) => !x || !x.ok);
        if (c?.cert?.covers === true && typeof c.cert.daysLeft === 'number' && c.cert.names?.length) {
          const names = [...c.cert.names].sort();
          certs.set(names.join(','), { names, daysLeft: c.cert.daysLeft, notAfter: c.cert.notAfter ?? null });
        }
        results.push({ ...base, ok: !bad, why: bad ? (bad as { why: string }).why || 'not checked' : '' });
      }
    }
    results.push({ ...ROUTES, ok: true, why: '' });
    // each certificate nginx gives, once (the wildcard covers many hosts)
    for (const [k, c] of certs) {
      const label = `Certificate: ${c.names.slice(0, 3).join(', ')}${c.names.length > 3 ? ` and ${c.names.length - 3} more` : ''}`;
      const until = c.notAfter ? ` (until ${day(c.notAfter)})` : '';
      const why = c.daysLeft < 0 ? `expired ${-c.daysLeft} day(s) ago` : `${c.daysLeft} day(s) left${until}`;
      results.push({ key: `cert:${k}`.slice(0, 300), group: 'certs', subject: 'certificates', label, link: '/hosts',
        ok: c.daysLeft >= CERT_DOWN_DAYS, warn: c.daysLeft < CERT_WARN_DAYS, why: c.daysLeft < CERT_WARN_DAYS ? `${why}: Let's Encrypt renews at 30, so renewing has failed` : why });
    }
  } catch (e) {
    unread.add('hosts');
    unread.add('certs');
    results.push({ ...ROUTES, ok: false, why: `didn't answer: ${said(e)}` });
  }

  // other addresses: each as visitors reach it; its certificate judged as the certs group's
  const want = (s.urls?.want ?? []).filter((w) => !hostNames.has(w.name));
  if (s.urls && want.length) {
    try {
      const got = await s.urls.check(want);
      for (const w of want) {
        const g = got.find((x) => x.name === w.name && x.path === w.path);
        const label = `https://${w.name}${w.path}`;
        const base = { key: `url:${w.key}`, group: 'other' as const, subject: w.name, label, link: '/monitoring' };
        if (!g) { results.push({ ...base, ok: false, why: 'not checked' }); continue; }
        const days = g.cert?.covers === true && typeof g.cert.daysLeft === 'number' ? g.cert.daysLeft : null;
        const bad = [g.dns, g.cert?.covers === true ? { ok: true, why: '' } : g.cert, g.answers].find((x) => !x || !x.ok);
        if (bad || days === null) { results.push({ ...base, ok: false, why: (bad as Named | undefined)?.why || 'no certificate for it' }); continue; }
        const how = `${g.answers?.why ?? 'answers'}${g.via === 'cloudflare' ? ' through Cloudflare' : ''}`;
        const cert = days < 0 ? `certificate expired ${-days} day(s) ago` : `certificate: ${days} day(s) left`;
        results.push({ ...base, ok: days >= CERT_DOWN_DAYS, warn: days < CERT_WARN_DAYS, why: `${how}, ${cert}` });
      }
      results.push({ ...URLS, ok: true, why: '' });
    } catch (e) {
      unread.add('other');
      results.push({ ...URLS, ok: false, why: `didn't answer: ${said(e)}` });
    }
  }

  // services: every part the panel can start and stop (the Gonsalves migrator is neither)
  if (s.services) {
    try {
      for (const sv of await s.services()) {
        for (const p of sv.parts.filter((x) => x.controls)) {
          const base = { key: `service:${sv.id}/${p.id}`, group: 'services' as const, subject: `service:${sv.id}`, label: `${sv.title} / ${p.title}`, link: '/services' };
          if (p.masked) { results.push({ ...base, ok: true, stopped: true, why: 'stopped from the panel' }); continue; }
          const running = p.active === 'active';
          const why = !running ? `not running (${p.active}${p.sub ? `, ${p.sub}` : ''})`
            : p.well === false ? (p.answering?.status ? `answers ${p.answering.status}` : 'no answer') : '';
          results.push({ ...base, ok: !why, why });
        }
      }
      results.push({ ...SERVICES, ok: true, why: '' });
    } catch (e) {
      unread.add('services');
      results.push({ ...SERVICES, ok: false, why: `didn't answer: ${said(e)}` });
    }
  }

  // projects: each server branch with a release (D4-12)
  if (s.projects) {
    try {
      const got = await s.projects();
      const servers = Array.isArray(got) ? got : got.servers;
      const proxy = Array.isArray(got) ? null : got.proxy ?? null;
      if (proxy !== null) {
        results.push({ key: 'project:build-proxy', group: 'projects', subject: 'projects', label: "The builds' way out (lfdln-build-proxy)", link: '/projects',
          ok: proxy, why: proxy ? '' : "not running: builds can't reach the package registries" });
      }
      for (const p of servers) {
        const base = { key: `project:${p.project}/${p.branch}`, group: 'projects' as const, subject: `project:${p.project}`,
          label: `${p.project} (${p.branch === 'main' ? 'live' : 'preview'})`, link: '/projects' };
        if (p.stopped) { results.push({ ...base, ok: true, stopped: true, why: 'stopped from Projects' }); continue; }
        const why = p.active !== 'active' ? `not running (${p.active}${p.sub ? `, ${p.sub}` : ''})`
          : !p.answering || p.answering.status === null ? `no answer on port ${p.port}`
            : p.answering.status >= 500 ? `answers ${p.answering.status}` : '';
        results.push({ ...base, ok: !why, why });
      }
      results.push({ ...PROJECTS, ok: true, why: '' });
    } catch (e) {
      unread.add('projects');
      results.push({ ...PROJECTS, ok: false, why: `didn't answer: ${said(e)}` });
    }
  }

  // the slow checks: asked on the hour (and by Check now); between, their rows stay
  if (!opts.slow) {
    for (const g of SLOW) unread.add(g);
    unread.add(STORAGE.key);
    unread.add(RECORDS.key);
  } else {
    if (s.storage) {
      try {
        const st = await s.storage();
        for (const b of st.backups) {
          const base = { key: `backup:${b.id}`, group: 'backups' as const, subject: 'backups', label: `Backups: ${b.title}`, link: '/monitoring' };
          const n = b.newest;
          if (b.why) results.push({ ...base, ok: false, why: b.why });
          else if (!n) results.push({ ...base, ok: false, why: 'no nightly backup there' });
          else if (at - n.at > BACKUP_MAX_AGE) results.push({ ...base, ok: false, why: `the newest nightly one is ${hours(at - n.at)} old` });
          else if (!n.files) results.push({ ...base, ok: true, why: `no databases to copy yet (ran ${hours(at - n.at)} ago)` });
          else if (n.empty) results.push({ ...base, ok: false, why: `${n.empty} of the newest ${n.files} dump(s) empty` });
          else results.push({ ...base, ok: true, why: `${n.files === 1 ? 'one dump' : `${n.files} dumps`}, ${bytes(n.bytes)}, ${hours(at - n.at)} ago` });
        }
        // one row a disk: paths on the same one are said together
        const disks = new Map<string, StorageLike['disks']>();
        for (const d of st.disks) disks.set(d.dev ?? d.path, [...disks.get(d.dev ?? d.path) ?? [], d]);
        for (const same of disks.values()) {
          const d = same[0]!;
          const base = { key: `disk:${d.path}`, group: 'disk' as const, subject: 'disk', label: `Disk space: ${same.map((x) => x.path).join(' and ')}`, link: '/monitoring' };
          if (d.why || !d.size) { results.push({ ...base, ok: false, why: d.why ?? 'no size' }); continue; }
          const free = d.avail / d.size;
          const why = `${bytes(d.avail)} free of ${bytes(d.size)} (${Math.round(free * 100)}%)`;
          results.push({ ...base, ok: free >= DISK_DOWN, warn: free < DISK_WARN, why });
        }
        results.push({ ...STORAGE, ok: true, why: '' });
      } catch (e) {
        unread.add('backups');
        unread.add('disk');
        results.push({ ...STORAGE, ok: false, why: `didn't answer: ${said(e)}` });
      }
    }
    // the registration: always "up" (Q4: shown on the page, never mailed), what it says
    // is its words; a helper that doesn't answer is said there too
    if (s.registration) {
      const base = { key: 'domain:registration', group: 'domain' as const, subject: 'registration', link: '/monitoring', ok: true };
      try {
        const r = await s.registration();
        const label = `Registration: ${r.domain}`;
        if (!r.ok || r.expires === null) results.push({ ...base, label, why: `not read: ${r.why}` });
        else {
          const days = Math.floor((r.expires - at) / 86400);
          results.push({ ...base, label, why: days < 0 ? `ran out on ${day(r.expires)}` : `registered until ${day(r.expires)} (${days} day(s))` });
        }
      } catch (e) {
        results.push({ ...base, label: 'Registration', why: `not read: the routing helper didn't answer: ${said(e)}` });
      }
    }
    if (s.records) {
      try {
        const got = await s.records.read(s.records.want);
        const was = await s.records.baseline();
        for (const w of s.records.want) {
          const base = { key: `dns:${w.key}`, group: 'dns' as const, subject: 'dns', label: w.label, link: '/monitoring' };
          const g = got.find((x) => x.name === w.name && x.type === w.type);
          const value = g ? [...g.values].sort().join('\n') : '';
          const before = was.get(w.key);
          if (!g) results.push({ ...base, ok: false, why: 'not read' });
          else if (!g.values.length) results.push({ ...base, ok: false, why: before === undefined ? g.why : `${g.why} (it was ${short(before)})` });
          else if (before === undefined) { await s.records.keep(w.key, value); results.push({ ...base, ok: true, why: short(value) }); }
          else if (before !== value) results.push({ ...base, ok: false, why: `changed: now ${short(value)}; it was ${short(before)}` });
          else results.push({ ...base, ok: true, why: short(value) });
        }
        results.push({ ...RECORDS, ok: true, why: '' });
      } catch (e) {
        unread.add('dns');
        results.push({ ...RECORDS, ok: false, why: `didn't answer: ${said(e)}` });
      }
    }
  }

  // the panel's own pieces, each asked on its own
  await Promise.all(s.pieces.map(async (p) => {
    let why: string | null;
    try { why = await p.ask(); } catch (e) { why = said(e); }
    results.push({ key: `panel:${p.id}`, group: 'panel', subject: 'panel', label: p.label, ok: why === null, why: why ?? '', link: '/monitoring' });
  }));
  return { results, unread };
}
