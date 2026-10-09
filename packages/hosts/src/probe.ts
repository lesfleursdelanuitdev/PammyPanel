// The hosts' checks (docs/domains-hosts-plan.md step 3, part 8): does a name's DNS point
// here, does the certificate nginx gives for it cover it and for how long, does it answer
// -- and, for the setup guide (step 4), does a certificate file cover a domain, and does a
// made-up name resolve here (a wildcard record). Read-only: it asks, and changes nothing.
//
// The routing helper can't do this itself (no network, and /etc/letsencrypt hidden), so
// it runs this file as a short-lived root unit of its own ("lfdln-routes-check-..."), with
// the tasks on stdin -- names and paths it has already checked -- and reads one JSON line
// back. This file checks them again. The tests call the functions directly.
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls';
import { CLOUDFLARE_RANGES } from './cloudflare.ts';

export type Front = 'cloudflare' | 'direct';
// host: a name as visitors use it; cert-file: a certificate on disk and the names it
// must cover; resolve: a name that should come here (a random one, for a wildcard);
// records: what DNS holds for a name, of one type (monitoring's mail records and
// nameservers, docs/monitoring-plan.md step 2); url: an address outside the site's hosts
// (monitoring step 3), asked of this server's nginx when its name points here, or through
// Cloudflare when it is behind it (as visitors reach it) -- never anywhere else; rdap: when
// a domain's registration runs out, from its registry (step 3)
export const RECORD_TYPES = ['TXT', 'MX', 'NS'] as const;
export type RecordType = typeof RECORD_TYPES[number];
export type Task =
  | { kind: 'host'; name: string; front: Front; path?: string }
  | { kind: 'cert-file'; path: string; names: string[]; key?: string }
  | { kind: 'resolve'; name: string; front: Front }
  | { kind: 'records'; name: string; type: RecordType }
  | { kind: 'url'; name: string; path: string }
  | { kind: 'rdap'; domain: string };

export type Check = { ok: boolean; why: string };
export type DnsCheck = Check & { addresses: string[] };
// covers: it is for the name (whatever its days left): monitoring judges the days itself
export type CertCheck = Check & { notAfter: number | null; daysLeft: number | null; names: string[]; covers: boolean };
export type AnswerCheck = Check & { status: number | null };
export type Result =
  | { kind: 'host'; name: string; dns: DnsCheck; cert: CertCheck; answers: AnswerCheck }
  | { kind: 'cert-file'; path: string; cert: CertCheck }
  | { kind: 'resolve'; name: string; dns: DnsCheck }
  | { kind: 'records'; name: string; type: RecordType; ok: boolean; why: string; values: string[] }
  | { kind: 'url'; name: string; path: string; via: 'here' | 'cloudflare' | null; dns: DnsCheck; cert: CertCheck; answers: AnswerCheck }
  | { kind: 'rdap'; domain: string; ok: boolean; why: string; expires: number | null };

// Where nginx listens, and this server's own addresses (the tests: their own)
export type ProbeEnv = {
  ip: string; port: number; own: () => string[]; now: () => number; resolve: (name: string) => Promise<string[]>; timeoutMs: number;
  // a name's records of one type, each as text ("10 feedback.example.net" for MX)
  records?: (name: string, type: RecordType) => Promise<string[]>;
  // where a name behind Cloudflare is asked (the tests: their own server)
  via?: (address: string) => { ip: string; port: number };
  // a registry's RDAP answer for a domain (the tests: their own)
  rdap?: (url: string) => Promise<unknown>;
};

// The registries asked when a domain runs out (RDAP): only these, never an address a
// request names. IANA's bootstrap list, for the endings lfdln and pammy.org have.
export const RDAP_BASES: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
};

// A certificate with less than this left is a warning, not a pass (Let's Encrypt renews at 30)
export const MIN_DAYS = 14;

const NAME_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,300}$/;
export function checkTask(t: unknown): Task {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  const name = (v: unknown, star = false) => {
    if (typeof v !== 'string' || v.length > 253 || !NAME_RE.test(v) || (!star && v.startsWith('*.'))) throw new Error(`not a name: ${String(v).slice(0, 80)}`);
    return v;
  };
  const front = (v: unknown): Front => (v === 'cloudflare' ? 'cloudflare' : 'direct');
  if (o.kind === 'host') {
    const path = o.path === undefined ? undefined : typeof o.path === 'string' && /^\/[A-Za-z0-9._~/-]{0,200}$/.test(o.path) && !o.path.includes('..') ? o.path : null;
    if (path === null) throw new Error('not a path');
    return { kind: 'host', name: name(o.name), front: front(o.front), ...(path ? { path } : {}) };
  }
  if (o.kind === 'url') {
    if (typeof o.path !== 'string' || !/^\/[A-Za-z0-9._~/-]{0,200}$/.test(o.path) || o.path.includes('..')) throw new Error('not a path');
    return { kind: 'url', name: name(o.name), path: o.path };
  }
  if (o.kind === 'rdap') {
    const d = name(o.domain);
    if (d.split('.').length !== 2 || !RDAP_BASES[d.split('.')[1]!]) throw new Error(`no registry known for ${d.slice(0, 80)}`);
    return { kind: 'rdap', domain: d };
  }
  if (o.kind === 'resolve') return { kind: 'resolve', name: name(o.name), front: front(o.front) };
  if (o.kind === 'records') {
    // a DKIM selector or _dmarc starts with an underscore: allowed as a label's first letter here
    const n = typeof o.name === 'string' && o.name.length <= 253 && /^(?:_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(o.name) ? o.name : null;
    if (!n) throw new Error(`not a name: ${String(o.name).slice(0, 80)}`);
    if (!(RECORD_TYPES as readonly unknown[]).includes(o.type)) throw new Error('not a record type');
    return { kind: 'records', name: n, type: o.type as RecordType };
  }
  if (o.kind === 'cert-file') {
    if (typeof o.path !== 'string' || !PATH_RE.test(o.path) || o.path.includes('/../')) throw new Error('not a path');
    if (!Array.isArray(o.names) || !o.names.length || o.names.length > 10) throw new Error('no names');
    if (o.key !== undefined && (typeof o.key !== 'string' || !PATH_RE.test(o.key) || o.key.includes('/../'))) throw new Error('not a path');
    return { kind: 'cert-file', path: o.path, names: o.names.map((n) => name(n, true)), ...(o.key ? { key: o.key as string } : {}) };
  }
  throw new Error('not a task');
}

const cloudflare = (() => {
  const b = new BlockList();
  for (const r of CLOUDFLARE_RANGES) {
    const [net, bits] = r.split('/');
    b.addSubnet(net!, Number(bits), isIP(net!) === 6 ? 'ipv6' : 'ipv4');
  }
  return b;
})();
export const isCloudflare = (ip: string) => isIP(ip) !== 0 && cloudflare.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

// DNS points here: straight at one of this server's addresses, or (behind Cloudflare) at
// Cloudflare only -- proxied, as the guide asks -- since its own addresses are hidden then.
export function pointsHere(addresses: string[], own: string[], front: Front): DnsCheck {
  if (!addresses.length) return { ok: false, why: 'the name has no address in DNS', addresses };
  if (front === 'cloudflare') {
    const other = addresses.filter((a) => !isCloudflare(a));
    if (!other.length) return { ok: true, why: 'proxied through Cloudflare', addresses };
    const here = other.filter((a) => own.includes(a));
    return { ok: false, why: here.length ? `not proxied: ${here.join(', ')} is this server, seen by everyone` : `points elsewhere: ${other.join(', ')}`, addresses };
  }
  const here = addresses.filter((a) => own.includes(a));
  if (here.length === addresses.length) return { ok: true, why: `points here (${here.join(', ')})`, addresses };
  if (addresses.some(isCloudflare)) return { ok: false, why: 'goes through Cloudflare, but this domain says nothing is in front', addresses };
  return { ok: false, why: here.length ? `some addresses aren't this server: ${addresses.filter((a) => !own.includes(a)).join(', ')}` : `points elsewhere: ${addresses.join(', ')}`, addresses };
}

// The names a certificate covers, from its subjectaltname ("DNS:a.b, DNS:*.b")
export const sanNames = (san: string | undefined) => (san ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4).toLowerCase());

// Does a certificate cover every name, and for how long? A "*.b" name to cover is asked as a
// random label under b, as a browser would see it.
export function certCovers(sans: string[], validTo: number, names: string[], now: number): CertCheck {
  const days = Math.floor((validTo - now) / 86400);
  const cert = { subjectaltname: sans.map((n) => `DNS:${n}`).join(', '), subject: {} } as unknown as PeerCertificate;
  const missing = names.filter((n) => checkServerIdentity(n.startsWith('*.') ? `zz-any${n.slice(1)}` : n, cert) !== undefined);
  const base = { notAfter: validTo, daysLeft: days, names: sans, covers: !missing.length };
  if (missing.length) return { ok: false, why: `doesn't cover ${missing.join(', ')} (it has ${sans.join(', ') || 'no names'})`, ...base };
  if (days < 0) return { ok: false, why: `expired ${-days} day(s) ago`, ...base };
  if (days < MIN_DAYS) return { ok: false, why: `expires in ${days} day(s)`, ...base };
  return { ok: true, why: `covers it, ${days} days left`, ...base };
}

const noCert = (why: string): CertCheck => ({ ok: false, why, notAfter: null, daysLeft: null, names: [], covers: false });

// The certificate nginx gives for a name (SNI), on this server
function servedCert(name: string, env: ProbeEnv, to = { ip: env.ip, port: env.port }): Promise<CertCheck> {
  return new Promise((resolve) => {
    const s = connect({ host: to.ip, port: to.port, servername: name, rejectUnauthorized: false, timeout: env.timeoutMs });
    const done = (c: CertCheck) => { s.destroy(); resolve(c); };
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      if (!c || !c.valid_to) return done(noCert('nginx gave no certificate'));
      done(certCovers(sanNames(c.subjectaltname), Math.floor(Date.parse(c.valid_to) / 1000), [name], env.now()));
    });
    s.once('timeout', () => done(noCert('no answer on 443')));
    s.once('error', (e) => done(noCert(`couldn't connect: ${e.message}`)));
  });
}

// It answers: any HTTP status from nginx for the name's path, 5xx being a failure
function answers(name: string, path: string, env: ProbeEnv, to = { ip: env.ip, port: env.port }): Promise<AnswerCheck> {
  return new Promise((resolve) => {
    const req = request({ host: to.ip, port: to.port, servername: name, path, method: 'GET', headers: { Host: name, 'User-Agent': 'lfdln-panel-check' }, rejectUnauthorized: false, timeout: env.timeoutMs }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve({ ok: status > 0 && status < 500, status, why: status >= 500 ? `answers ${status}` : `answers ${status}` });
    });
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: null, why: `no answer in ${env.timeoutMs / 1000}s` }); });
    req.once('error', (e) => resolve({ ok: false, status: null, why: `no answer: ${e.message}` }));
    req.end();
  });
}

async function lookup(name: string, env: ProbeEnv): Promise<string[] | string> {
  try { return await env.resolve(name); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOTFOUND' || (e as NodeJS.ErrnoException).code === 'ENODATA' ? [] : `DNS didn't answer: ${(e as Error).message}`; }
}

// What DNS holds, sorted, so two readings compare as text. None there is said, not failed
// here: monitoring decides what a missing record means.
async function records(t: Extract<Task, { kind: 'records' }>, env: ProbeEnv): Promise<Result> {
  const base = { kind: 'records' as const, name: t.name, type: t.type };
  if (!env.records) return { ...base, ok: false, why: "records can't be read here", values: [] };
  try {
    const values = [...new Set(await env.records(t.name, t.type))].sort();
    return { ...base, ok: values.length > 0, why: values.length ? '' : `no ${t.type} record`, values };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { ...base, ok: false, why: `no ${t.type} record`, values: [] };
    return { ...base, ok: false, why: `DNS didn't answer: ${(e as Error).message}`, values: [] };
  }
}

// An address outside the site's hosts: its name points here (asked of nginx here) or
// through Cloudflare only (asked through Cloudflare, as visitors reach it). A name that
// points anywhere else isn't asked at all.
async function url(t: Extract<Task, { kind: 'url' }>, env: ProbeEnv): Promise<Result> {
  const base = { kind: 'url' as const, name: t.name, path: t.path };
  const skipped = (why: string) => ({ cert: noCert(why), answers: { ok: false, why, status: null } });
  const addrs = await lookup(t.name, env);
  if (typeof addrs === 'string') return { ...base, via: null, dns: { ok: false, why: addrs, addresses: [] }, ...skipped('not asked: DNS didn\'t answer') };
  const own = env.own();
  const via = !addrs.length ? null : addrs.every((a) => own.includes(a)) ? 'here' as const : addrs.every(isCloudflare) ? 'cloudflare' as const : null;
  if (!via) {
    const dns = addrs.length ? { ok: false, why: `points elsewhere: ${addrs.join(', ')}`, addresses: addrs } : { ok: false, why: 'the name has no address in DNS', addresses: addrs };
    return { ...base, via, dns, ...skipped('not asked: it isn\'t this server') };
  }
  const to = via === 'here' ? { ip: env.ip, port: env.port } : (env.via ?? ((a: string) => ({ ip: a, port: 443 })))(addrs.find((a) => isIP(a) === 4) ?? addrs[0]!);
  const dns = { ok: true, why: via === 'here' ? `points here (${addrs.join(', ')})` : 'through Cloudflare', addresses: addrs };
  const [cert, answer] = await Promise.all([servedCert(t.name, env, to), answers(t.name, t.path, env, to)]);
  return { ...base, via, dns, cert, answers: answer };
}

// When a domain's registration runs out: the "expiration" event of its registry's answer
async function rdap(t: Extract<Task, { kind: 'rdap' }>, env: ProbeEnv): Promise<Result> {
  const base = { kind: 'rdap' as const, domain: t.domain };
  if (!env.rdap) return { ...base, ok: false, why: "the registry can't be asked here", expires: null };
  try {
    const got = await env.rdap(`${RDAP_BASES[t.domain.split('.')[1]!]}domain/${t.domain}`) as { events?: { eventAction?: unknown; eventDate?: unknown }[] };
    const e = Array.isArray(got?.events) ? got.events.find((x) => x?.eventAction === 'expiration') : undefined;
    const at = typeof e?.eventDate === 'string' ? Date.parse(e.eventDate) : NaN;
    if (!Number.isFinite(at)) return { ...base, ok: false, why: 'the registry gave no end date', expires: null };
    return { ...base, ok: true, why: '', expires: Math.floor(at / 1000) };
  } catch (err) {
    return { ...base, ok: false, why: `the registry didn't answer: ${(err as Error).message}`.slice(0, 200), expires: null };
  }
}

export async function runTask(t: Task, env: ProbeEnv): Promise<Result> {
  if (t.kind === 'records') return records(t, env);
  if (t.kind === 'url') return url(t, env);
  if (t.kind === 'rdap') return rdap(t, env);
  if (t.kind === 'cert-file') {
    try {
      const c = new X509Certificate(readFileSync(t.path));
      const covers = certCovers(sanNames(c.subjectAltName), Math.floor(Date.parse(c.validTo) / 1000), t.names, env.now());
      // its key, when asked: there, readable, and the certificate's own (nginx refuses anything else)
      if (t.key && covers.ok) {
        let matches = false;
        try { matches = c.checkPrivateKey(createPrivateKey(readFileSync(t.key))); } catch (e) {
          return { kind: 'cert-file', path: t.path, cert: { ...covers, ok: false, why: `its key can't be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` } };
        }
        if (!matches) return { kind: 'cert-file', path: t.path, cert: { ...covers, ok: false, why: 'its key is another certificate\'s' } };
      }
      return { kind: 'cert-file', path: t.path, cert: covers };
    } catch (e) {
      return { kind: 'cert-file', path: t.path, cert: noCert(`can't be read as a certificate: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`) };
    }
  }
  const addrs = await lookup(t.name, env);
  const dnsCheck = typeof addrs === 'string' ? { ok: false, why: addrs, addresses: [] } : pointsHere(addrs, env.own(), t.front);
  if (t.kind === 'resolve') return { kind: 'resolve', name: t.name, dns: dnsCheck };
  const [cert, answer] = await Promise.all([servedCert(t.name, env), answers(t.name, t.path ?? '/', env)]);
  return { kind: 'host', name: t.name, dns: dnsCheck, cert, answers: answer };
}

export const realEnv = (): ProbeEnv => ({
  ip: '127.0.0.1', port: 443, timeoutMs: 8000,
  now: () => Math.floor(Date.now() / 1000),
  own: () => Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address),
  resolve: async (name) => {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(name), dns.resolve6(name)]);
    const got = [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])];
    if (!got.length && v4.status === 'rejected') throw v4.reason;
    return got;
  },
  records: async (name, type) => {
    const host = (s: string) => s.toLowerCase().replace(/\.$/, '');
    if (type === 'TXT') return (await dns.resolveTxt(name)).map((chunks) => chunks.join(''));
    if (type === 'MX') return (await dns.resolveMx(name)).map((m) => `${m.priority} ${host(m.exchange)}`);
    return (await dns.resolveNs(name)).map(host);
  },
  rdap: async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!r.ok) throw new Error(`it answered ${r.status}`);
    return r.json();
  },
});

// As the unit: tasks on stdin (at most 200), one JSON line out
if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as unknown[];
  if (!Array.isArray(input) || input.length > 200) throw new Error('tasks: a list of at most 200');
  const env = realEnv();
  const results = await Promise.all(input.map((t) => runTask(checkTask(t), env)));
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
