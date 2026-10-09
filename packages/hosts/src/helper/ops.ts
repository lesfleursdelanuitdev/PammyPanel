// What the routing helper does (docs/hosts-plan.md H6, H7). It is the only thing
// that writes lfdln's host files, and it writes nothing else: every file comes
// from render.ts, into cfg.dir, and stale host files there are removed.
//
// apply: the whole table from the panel -> every file's text -> write what
// changed -> `nginx -t` -> put everything back as it was if nginx says no ->
// reload. So a route nginx won't take never reaches the sites that are running.
// One apply at a time.
//
// check-name: may a new host take this name? Not one the server keeps, not one
// with its own DNS record at DreamHost, and not while the zone can't be read (Q3).
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Runner, RunResult } from '@panel/core/runner';
import { fileURLToPath } from 'node:url';
import { APEX, domainName, hostName, NameError, tableHostName } from '../names.ts';
import { checkTask, type Front, type Result, type Task } from '../probe.ts';
import { certNames, checkedTls, kindsOf, renderAll, type Domain, type Tls, type RouteKind, type Folder, type Host, type HostsConfig, type Route, type ServicePart, type Table } from '../render.ts';
import type { ZoneReader } from '../zone.ts';
import { TAKEOVERS } from '../takeover.ts';

export class HostsError extends Error {
  code: 'invalid' | 'exists' | 'unavailable' | 'refused' | 'internal';
  constructor(code: HostsError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type RoutesDeps = {
  cfg: HostsConfig;
  run: Runner;
  // the home domain's DNS records, where this server can read them (lfdln: DreamHost's);
  // null where they are kept by hand (pammy.org: Cloudflare, with a * record), and then a
  // new name is refused only if the server keeps it (docs/phase8-plan.md 8-7)
  zone: ZoneReader | null;
  // the hand-written files this site's panel takes over (sites-enabled links); none: lfdln's
  links?: readonly string[];
  // the site's own link (sites-enabled/<its folder's name> -> <its folder>/site.conf) goes in
  // with a takeover and out with a give-back, in the same nginx -t: pammy.org's switch, where
  // one hand-written file is the whole site (docs/phase8-plan.md 8-7c). lfdln's own link is
  // the installer's.
  ownLink?: boolean;
  root?: string;                 // the tests' stand-in for "/"
  log?: (line: string) => void;
  // where the site's services really answer (the services helper's record, which only
  // the installer writes): a service route in the table must say the same, so the
  // panel can't send a host to any other port (docs/adopt-plan.md V3)
  ports?: () => ServicePart[];
  sitesEnabled?: string;         // /etc/nginx/sites-enabled, and where its links point (the tests: their own)
  sitesAvailable?: string;       // /etc/nginx/sites-available
  now?: () => number;            // seconds (the checks' cache)
};

// The checks (docs/domains-hosts-plan.md step 3): kept 10 minutes; asked again at most
// once a minute
export const CHECK_TTL = 10 * 60;
export const CHECK_AGAIN = 60;
export const PROBE = fileURLToPath(new URL('../probe.ts', import.meta.url));

export type Applied = { changed: string[]; removed: string[]; reloaded: boolean; link?: 'taken-over' | 'given-back' };
// A hand-written host's file, taken out of sites-enabled as the panel's block goes in
// (docs/adopt-plan.md V6), or put back. Only the links takeover.ts names, and only
// pointing where the hand-written file is.
export type LinkOp = { takeOver?: unknown; giveBack?: unknown };
export const TAKEOVER_LINKS: readonly string[] = TAKEOVERS.map((t) => t.link);


// The table as the panel sends it, checked for its shape (render.ts checks every
// name, path and address in it).
const bool = (v: unknown, what: string) => {
  if (typeof v !== 'boolean') throw new HostsError('invalid', `${what} is not true or false.`);
  return v;
};
const str = (v: unknown, what: string) => {
  if (typeof v !== 'string') throw new HostsError('invalid', `${what} is missing.`);
  return v;
};
const list = (v: unknown, what: string) => {
  if (!Array.isArray(v) || v.length > 5000) throw new HostsError('invalid', `${what} is not a list.`);
  return v as Record<string, unknown>[];
};
const strs = (v: unknown, what: string) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) throw new HostsError('invalid', `${what} is not a list of words.`);
  return v as string[];
};
const frontOf = (v: unknown) => {
  if (v !== 'cloudflare' && v !== 'direct') throw new HostsError('invalid', 'What is in front of a domain is Cloudflare or nothing.');
  return v;
};
export function tableOf(v: unknown, kinds: Map<string, RouteKind> = kindsOf({} as HostsConfig)): Table {
  const t = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const hosts: Host[] = list(t.hosts, 'hosts').map((h) => ({
    name: str(h.name, 'a host\'s name'), enabled: bool(h.enabled, 'enabled'),
    ...(h.withWww === undefined ? {} : { withWww: bool(h.withWww, 'withWww') }),
    // on another domain (docs/domains-hosts-plan.md step 7); render.ts checks it is one here
    ...(h.domain === undefined ? {} : { domain: str(h.domain, 'a host\'s domain') }),
  }));
  const services: ServicePart[] = t.services === undefined ? [] : list(t.services, 'services').map((p) => {
    if (typeof p.port !== 'number') throw new HostsError('invalid', 'A service\'s port is missing.');
    return { service: str(p.service, 'a service'), part: str(p.part, 'a service\'s part'), port: p.port };
  });
  // the domains' rows (docs/domains-hosts-plan.md step 1); render.ts checks the home one and its paths
  const domains: Domain[] | undefined = t.domains === undefined ? undefined : list(t.domains, 'domains').map((d) => {
    const tls = (d.tls && typeof d.tls === 'object' ? d.tls : {}) as Record<string, unknown>;
    return {
      name: str(d.name, 'a domain\'s name'), home: bool(d.home, 'home'),
      // a certificate for named hosts only (step 7); render.ts checks every name
      ...(d.names === undefined ? {} : { names: strs(d.names, 'a domain\'s certificate names') }),
      // folder hosts (docs/phase8-plan.md 8-7): render.ts refuses them where they can't be
      ...(d.folderHosts === undefined ? {} : { folderHosts: bool(d.folderHosts, 'folderHosts') }),
      // who stands in front (S6): Cloudflare, or nothing
      ...(d.front === undefined ? {} : { front: frontOf(d.front) }),
      tls: {
        cert: str(tls.cert, 'a domain\'s certificate'), key: str(tls.key, 'a domain\'s certificate key'),
        ...(tls.include === undefined ? {} : { include: strs(tls.include, 'a domain\'s TLS includes') }),
        ...(tls.dhparam === undefined ? {} : { dhparam: str(tls.dhparam, 'a domain\'s DH parameters') }),
      },
    };
  });
  const folders: Folder[] = list(t.folders, 'folders').map((f) => ({ name: str(f.name, 'a folder\'s name'), runPhp: bool(f.runPhp, 'runPhp') }));
  // each route's own fields are its kind's to check (docs/domains-hosts-plan.md step 2)
  const routes: Route[] = list(t.routes, 'routes').map((r) => {
    const base = {
      host: str(r.host, 'a route\'s host'), path: str(r.path, 'a route\'s path'), enabled: bool(r.enabled, 'enabled'),
      ...(r.domain === undefined ? {} : { domain: str(r.domain, 'a route\'s domain') }),
      // accounts: the route's area in the gate (docs/roles-plan.md step 5); render.ts checks the token
      ...(r.accounts === undefined || r.accounts === null ? {} : { accounts: { token: str((r.accounts as Record<string, unknown>)?.token, 'a route\'s area') } }),
    };
    const k = typeof r.kind === 'string' ? kinds.get(r.kind) : undefined;
    if (!k) throw new HostsError('invalid', `A route shows ${[...kinds.keys()].map((x) => `a ${x}`).join(', ')}; not ${String(r.kind).slice(0, 30)}.`);
    try { return { ...base, kind: k.kind, ...k.fields(r) }; } catch (e) { throw new HostsError('invalid', (e as Error).message); }
  });
  // installed software a route may show (docs/phase8-plan.md 8-7), each with its proxy file;
  // the software kind checks both
  const software = t.software === undefined ? undefined : list(t.software, 'software').map((x) => ({ id: str(x.id, 'a piece of software'), proxy: str(x.proxy, 'its proxy file') }));
  return { hosts, folders, routes, services, ...(domains ? { domains } : {}), ...(software ? { software } : {}) };
}

const firstLine = (r: RunResult) => (r.stderr || r.stdout).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? `exit ${r.code}`;

export function createRoutesOps(d: RoutesDeps) {
  const log = d.log ?? (() => {});
  const at = (f: string) => join(d.root ?? '/', d.cfg.dir, f);
  const read = (f: string) => { try { return readFileSync(at(f), 'utf8'); } catch { return null; } };
  const hostFiles = () => { try { return readdirSync(at('hosts')).filter((n) => n.endsWith('.conf')).map((n) => `hosts/${n}`); } catch { return []; } };
  // the other domains' files (docs/domains-hosts-plan.md step 4): domains/<name>/...
  const domainDirs = () => { try { return readdirSync(at('domains')).filter((n) => /^[a-z0-9.-]+$/.test(n)); } catch { return []; } };
  // ...and their hosts (step 7): domains/<name>/hosts/<host>.conf
  const domainFiles = (dom: string) => [
    ...[`domains/${dom}/catch-all.conf`, `domains/${dom}/pages/_lfdln/404.html`].filter((f) => existsSync(at(f))),
    ...(() => { try { return readdirSync(at(`domains/${dom}/hosts`)).filter((n) => n.endsWith('.conf')).map((n) => `domains/${dom}/hosts/${n}`); } catch { return []; } })(),
  ];
  // a domain's folder with none of its files left (removed, or put back as it was): gone too
  const tidy = () => {
    for (const dom of domainDirs()) if (!domainFiles(dom).length) rmSync(at(`domains/${dom}`), { recursive: true, force: true });
  };
  const managed = () => [...hostFiles(), ...domainDirs().flatMap(domainFiles)];
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const enabled = (link: string) => join(d.root ?? '/', d.sitesEnabled ?? '/etc/nginx/sites-enabled', link);
  const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  // what the link op is, checked before anything is written
  const linkOf = (op: LinkOp) => {
    if (op.takeOver === undefined && op.giveBack === undefined) return null;
    if (op.takeOver !== undefined && op.giveBack !== undefined) throw new HostsError('invalid', 'One link at a time.');
    const link = (op.takeOver ?? op.giveBack) as string;
    if (typeof link !== 'string' || !(d.links ?? TAKEOVER_LINKS).includes(link)) throw new HostsError('invalid', `${String(link).slice(0, 60)} isn't a hand-written file the panel takes over.`);
    const target = `${d.sitesAvailable ?? '/etc/nginx/sites-available'}/${link}`;
    if (op.takeOver !== undefined) {
      if (!isLink(enabled(link)) || readlinkSync(enabled(link)) !== target) throw new HostsError('invalid', `sites-enabled/${link} isn't the link to ${target} it should be, so it isn't taken out.`);
      return { kind: 'taken-over' as const, link, target };
    }
    if (existsSync(enabled(link)) || isLink(enabled(link))) throw new HostsError('invalid', `sites-enabled/${link} is there already.`);
    if (!existsSync(join(d.root ?? '/', target))) throw new HostsError('invalid', `${target} isn't there to put back.`);
    return { kind: 'given-back' as const, link, target };
  };

  async function apply(table: unknown, op: LinkOp = {}): Promise<Applied> {
    const lk = linkOf(op);
    let files: Map<string, string>;
    try {
      const t = tableOf(table, kindsOf(d.cfg));
      if (t.services?.length) {
        const known = d.ports?.() ?? [];
        for (const p of t.services) {
          if (!known.some((k) => k.service === p.service && k.part === p.part && k.port === p.port)) {
            throw new HostsError('invalid', `${p.service}/${p.part} on port ${p.port} isn't a service this server has taken in.`);
          }
        }
      }
      files = renderAll(d.cfg, t);
    } catch (e) {
      if (e instanceof HostsError) throw e;
      throw new HostsError('invalid', (e as Error).message);
    }
    return oneAtATime(async () => {
      const changed = [...files].filter(([f, text]) => read(f) !== text).map(([f]) => f).sort();
      const removed = managed().filter((f) => !files.has(f)).sort();
      if (!changed.length && !removed.length && !lk) return { changed, removed, reloaded: false };
      const before = new Map([...changed, ...removed].map((f) => [f, read(f)]));
      // the link, and undoing it: the hand-written file itself is never touched
      const own = enabled(basename(d.cfg.dir));
      const ownTarget = join(d.cfg.dir, 'site.conf');
      let ownMade = false;
      let ownGone = false;
      const linkDo = () => {
        if (lk?.kind === 'taken-over') rmSync(enabled(lk.link)); else if (lk) symlinkSync(lk.target, enabled(lk.link));
        if (lk && d.ownLink && lk.kind === 'taken-over' && !isLink(own)) { symlinkSync(ownTarget, own); ownMade = true; }
        if (lk && d.ownLink && lk.kind === 'given-back' && isLink(own)) { rmSync(own); ownGone = true; }
      };
      const linkUndo = () => {
        if (lk?.kind === 'taken-over' && !isLink(enabled(lk.link))) symlinkSync(lk.target, enabled(lk.link));
        if (lk?.kind === 'given-back' && isLink(enabled(lk.link))) rmSync(enabled(lk.link));
        if (ownMade && isLink(own)) rmSync(own);
        if (ownGone && !isLink(own)) symlinkSync(ownTarget, own);
      };
      const putBack = () => {
        for (const [f, text] of before) {
          if (text === null) rmSync(at(f), { force: true });
          else writeFileSync(at(f), text, { mode: 0o644 });
        }
        tidy();
        linkUndo();
      };
      try {
        for (const f of changed) {
          mkdirSync(dirname(at(f)), { recursive: true, mode: 0o755 });
          writeFileSync(at(f), files.get(f)!, { mode: 0o644 });
        }
        for (const f of removed) rmSync(at(f), { force: true });
        linkDo();
      } catch (e) {
        putBack();
        throw new HostsError('internal', `The files could not be written, so everything was put back: ${(e as Error).message}`);
      }
      const t = await d.run({ as: 'root', argv: ['nginx', '-t', '-q'], what: 'nginx-test', timeoutSec: 60 });
      if (t.code !== 0) {
        putBack();
        log(`nginx -t refused: ${firstLine(t)}`);
        throw new HostsError('refused', `nginx did not accept the change, so everything was put back as it was: ${firstLine(t)}`);
      }
      const r = await d.run({ as: 'root', argv: ['systemctl', 'reload', 'nginx'], what: 'nginx-reload', timeoutSec: 60 });
      if (r.code !== 0) throw new HostsError('internal', `nginx accepted the change but could not reload: ${firstLine(r)}`);
      tidy();
      log(`applied: ${changed.length} written, ${removed.length} removed${lk ? `, sites-enabled/${lk.link} ${lk.kind === 'taken-over' ? 'taken out' : 'put back'}` : ''}`);
      return { changed, removed, reloaded: true, ...(lk ? { link: lk.kind } : {}) };
    });
  }

  async function checkName(name: unknown) {
    let n: string;
    try { n = hostName(name); } catch (e) { throw new HostsError('invalid', (e as NameError).message); }
    if (!d.zone) return { ok: true, name: n };
    const z = await d.zone.taken();
    if (!z) throw new HostsError('unavailable', "The DNS records at DreamHost can't be read right now, so no new host can be made. Try again in a few minutes.");
    if (z.labels.has(n)) throw new HostsError('exists', `${n}.${d.cfg.domain} has a DNS record of its own at DreamHost, so it doesn't come to this server.`);
    return { ok: true, name: n };
  }

  async function zone() {
    if (!d.zone) throw new HostsError('unavailable', 'This site\'s DNS records are kept by hand: the server doesn\'t read them.');
    const z = await d.zone.taken();
    if (!z) throw new HostsError('unavailable', "The DNS records at DreamHost can't be read right now.");
    return { taken: [...z.labels].sort(), readAt: z.readAt };
  }

  // ---------------------------------------------------------------- checks (step 3)
  // The probe runs as a root unit of its own (it needs the network and the certificates,
  // this helper has neither), with the tasks on stdin; every name is checked here first.
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const probe = async (tasks: Task[]): Promise<Result[]> => {
    if (!tasks.length) return [];
    const r = await d.run({ as: 'root', argv: ['/usr/bin/node', '--disable-warning=ExperimentalWarning', PROBE], what: 'check', stdin: JSON.stringify(tasks), timeoutSec: 60 });
    if (r.code !== 0) throw new HostsError('unavailable', `The checks couldn't run: ${firstLine(r)}`);
    try { return JSON.parse(r.stdout) as Result[]; } catch { throw new HostsError('internal', 'The checks answered with something that isn\'t a list.'); }
  };
  type HostResult = Extract<Result, { kind: 'host' }>;
  const checked = new Map<string, { at: number; result: HostResult }>();
  const lastAgain = new Map<string, number>();

  // hosts: [{name, withWww?}] as the table names them ("@": the domain itself); front: what
  // the domain says stands in front of it. Every name a visitor uses is checked.
  async function check(req: { domain?: unknown; front?: unknown; hosts?: unknown; again?: unknown }) {
    let domain: string;
    try { domain = domainName(req.domain ?? d.cfg.domain); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    const front: Front = req.front === 'cloudflare' ? 'cloudflare' : 'direct';
    if (!Array.isArray(req.hosts) || req.hosts.length > 200) throw new HostsError('invalid', 'The hosts to check are a list.');
    const names: string[] = [];
    for (const h of req.hosts as Record<string, unknown>[]) {
      let n: string;
      try { n = tableHostName(h?.name); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
      if (n === APEX) names.push(domain, ...(h.withWww === true ? [`www.${domain}`] : []));
      else names.push(`${n}.${domain}`);
    }
    const t = now();
    // once a minute for each domain (the panel asks once a domain, docs/domains-hosts-plan.md step 7)
    const last = lastAgain.get(domain) ?? 0;
    const again = req.again === true && t - last >= CHECK_AGAIN;
    if (again) lastAgain.set(domain, t);
    const key = (n: string) => `${front} ${n}`;
    const stale = [...new Set(names)].filter((n) => again || !checked.has(key(n)) || t - checked.get(key(n))!.at >= CHECK_TTL);
    const got = await probe(stale.map((name) => checkTask({ kind: 'host', name, front })));
    for (const r of got) if (r.kind === 'host') checked.set(key(r.name), { at: t, result: r });
    return {
      checks: [...new Set(names)].map((n): Partial<HostResult> & { name: string; checkedAt: number | null } => ({ ...(checked.get(key(n))?.result ?? { kind: 'host', name: n }), checkedAt: checked.get(key(n))?.at ?? null })),
      againIn: Math.max(0, CHECK_AGAIN - (t - (lastAgain.get(domain) ?? 0))),
    };
  }

  // ---------------------------------------------------------------- a domain (step 4)
  // Who else in nginx answers for names under a domain: a regex or wildcard name in another
  // site (pammy.org's folder subdomains, say) would fight with the domain's catch-all, so it
  // refuses; exact names are fine (nginx prefers them) and only said.
  function claims(domain: string): { conflicts: string[]; exact: string[] } {
    const dir = join(d.root ?? '/', d.sitesEnabled ?? '/etc/nginx/sites-enabled');
    const conflicts = new Set<string>();
    const exact = new Set<string>();
    const esc = domain.replace(/\./g, '\\.');
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { /* none */ }
    for (const f of entries) {
      if (f === basename(d.cfg.dir)) continue;       // (the panel's own: site.conf)
      let text = '';
      try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
        for (const raw of m[1]!.trim().split(/\s+/)) {
          const n = raw.replace(/^["']|["']$/g, '').toLowerCase();
          if (n.startsWith('~')) { if (n.includes(esc) || n.includes(domain)) conflicts.add(`sites-enabled/${f}: ${n}`); continue; }
          if (n === `*.${domain}` || n === `.${domain}` || (n.startsWith('*.') && n.endsWith(`.${domain}`))) { conflicts.add(`sites-enabled/${f}: ${n}`); continue; }
          if (n === domain || n.endsWith(`.${domain}`)) exact.add(n);
        }
      }
    }
    return { conflicts: [...conflicts].sort(), exact: [...exact].sort() };
  }

  type Need = { key: string; label: string; ok: boolean; why: string; required: boolean };
  // The setup guide's checks for a domain (its answers so far), and a domain's own on the
  // Hosts page: nothing else in nginx claims names under it, its DNS, a wildcard record, the
  // certificate and its key, the zone.
  // names: its certificate is for these names only (step 7): no catch-all, so nothing else
  // in nginx is in its way (exact names win over any pattern), and the certificate covers them
  async function checkDomain(req: { domain?: unknown; front?: unknown; dns?: unknown; wildcardRecord?: unknown; tls?: unknown; names?: unknown }) {
    let domain: string;
    try { domain = domainName(req.domain); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    let names: string[] | null = null;
    if (req.names !== undefined && req.names !== null) {
      try { names = certNames(domain, req.names); } catch (e) { throw new HostsError('invalid', (e as Error).message.replace(/^hosts: /, '')); }
    }
    const front: Front = req.front === 'cloudflare' ? 'cloudflare' : 'direct';
    let tls: Tls | null = null;
    if (req.tls !== undefined && req.tls !== null) {
      const t = (typeof req.tls === 'object' ? req.tls : {}) as Record<string, unknown>;
      try {
        tls = checkedTls(d.cfg, { cert: str(t.cert, 'the certificate'), key: str(t.key, 'the certificate key'), ...(t.include === undefined ? {} : { include: strs(t.include, 'the TLS includes') }), ...(t.dhparam === undefined ? {} : { dhparam: str(t.dhparam, 'the DH parameters') }) });
      } catch (e) { throw new HostsError('invalid', (e as Error).message.replace(/^hosts: /, '')); }
    }
    const out: Need[] = [];
    const c = claims(domain);
    if (names) {
      const hand = c.exact.filter((n) => names!.includes(n));
      out.push({ key: 'nginx', label: 'No catch-all: only its hosts\' names are the panel\'s', required: true, ok: true,
        why: hand.length ? `hand-written sites answer for ${hand.join(', ')} until they are taken over` : 'nothing else answers for them' });
    } else {
      out.push({ key: 'nginx', label: 'Nothing else in nginx answers for every name under it', required: true, ok: !c.conflicts.length,
        why: c.conflicts.length ? `already answered by ${c.conflicts.join('; ')}` : c.exact.length ? `hand-written sites answer for ${c.exact.join(', ')} (they keep them)` : 'nothing else answers for it' });
    }
    const tasks: Task[] = [checkTask({ kind: 'resolve', name: domain, front })];
    if (req.wildcardRecord === true) tasks.push(checkTask({ kind: 'resolve', name: `zz-check-${randomBytes(4).toString('hex')}.${domain}`, front }));
    if (tls) tasks.push(checkTask({ kind: 'cert-file', path: tls.cert, names: names ?? [domain, `*.${domain}`], key: tls.key }));
    const got = await probe(tasks);
    const res = (i: number) => got[i];
    const apex = res(0);
    if (apex?.kind === 'resolve') out.push({ key: 'dns', label: `${domain} comes to this server${front === 'cloudflare' ? ' (through Cloudflare)' : ''}`, required: false, ok: apex.dns.ok, why: apex.dns.why });
    if (req.wildcardRecord === true) {
      const w = res(1);
      if (w?.kind === 'resolve') out.push({ key: 'wildcard', label: `A * record sends every new name under ${domain} here`, required: false, ok: w.dns.ok, why: w.dns.ok ? `a made-up name ${w.dns.why}` : w.dns.why });
    }
    if (tls) {
      const f = res(tasks.length - 1);
      if (f?.kind === 'cert-file') out.push({ key: 'certificate', label: `The certificate covers ${names ? names.join(', ') : `${domain} and *.${domain}`}, with its key`, required: true, ok: f.cert.ok, why: f.cert.why });
    }
    // the zone: DreamHost's script on this server reads the home domain's (dreamhost-dns.sh)
    if (req.dns === 'dreamhost' && domain === d.cfg.domain && d.zone) {
      const z = await d.zone.taken();
      out.push({ key: 'zone', label: 'Its DNS records can be read, so names with a record of their own are refused', required: false, ok: !!z, why: z ? `read: ${z.labels.size} name(s) with a record of their own` : "DreamHost's records can't be read right now" });
    } else {
      out.push({ key: 'zone', label: 'Its DNS records can be read, so names with a record of their own are refused', required: false, ok: false,
        why: req.dns === 'dreamhost' ? `the DreamHost script on this server reads ${d.cfg.domain} only: new names under ${domain} aren't checked against its records`
          : req.dns === 'cloudflare' ? 'no Cloudflare key is kept on this server yet: new names aren\'t checked against its records' : 'kept somewhere else: new names aren\'t checked against its records' });
    }
    return { domain, checks: out, ok: out.every((x) => x.ok || !x.required) };
  }

  const status = async () => ({ hosts: hostFiles().map((f) => f.slice('hosts/'.length, -'.conf'.length)).sort() });   // ("@": the domain itself)

  // ---------------------------------------------------------------- DNS records (monitoring step 2)
  // What DNS holds for a few names under a domain (its mail records, its nameservers),
  // read fresh each time: monitoring asks hourly. Only names under the domain asked about.
  async function records(req: { domain?: unknown; records?: unknown }) {
    let domain: string;
    try { domain = domainName(req.domain ?? d.cfg.domain); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    if (!Array.isArray(req.records) || !req.records.length || req.records.length > 20) throw new HostsError('invalid', 'The records to read are a list of at most 20.');
    const tasks: Task[] = [];
    for (const r of req.records as Record<string, unknown>[]) {
      const name = typeof r?.name === 'string' ? r.name.toLowerCase() : '';
      if (name !== domain && !name.endsWith(`.${domain}`)) throw new HostsError('invalid', `${name.slice(0, 80) || 'A name'} isn't under ${domain}.`);
      try { tasks.push(checkTask({ kind: 'records', name, type: r.type })); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    }
    return { records: (await probe(tasks)).filter((x) => x.kind === 'records') };
  }

  // ---------------------------------------------------------------- other addresses (monitoring step 3)
  // A few https addresses outside the site's hosts (Q5), fresh each time. The probe asks
  // only names that point here or through Cloudflare, so nothing else is ever reached.
  async function urls(req: { urls?: unknown }) {
    if (!Array.isArray(req.urls) || !req.urls.length || req.urls.length > 20) throw new HostsError('invalid', 'The addresses to check are a list of at most 20.');
    const tasks: Task[] = [];
    for (const u of req.urls as Record<string, unknown>[]) {
      try { tasks.push(checkTask({ kind: 'url', name: typeof u?.name === 'string' ? u.name.toLowerCase() : u?.name, path: u?.path })); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    }
    return { urls: (await probe(tasks)).filter((x) => x.kind === 'url') };
  }

  // When the site's domain runs out (Q4: shown, never mailed)
  async function registration(req: { domain?: unknown }) {
    let task: Task;
    try { task = checkTask({ kind: 'rdap', domain: domainName(req.domain ?? d.cfg.domain) }); } catch (e) { throw new HostsError('invalid', (e as Error).message); }
    const got = (await probe([task]))[0];
    if (got?.kind !== 'rdap') throw new HostsError('internal', 'The registry check answered with something else.');
    return got;
  }

  return { apply, checkName, zone, status, check, checkDomain, records, urls, registration, probe };
}
export type RoutesOps = ReturnType<typeof createRoutesOps>;
