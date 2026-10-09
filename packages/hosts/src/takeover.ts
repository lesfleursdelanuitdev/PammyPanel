// What the panel takes over from the hand-written nginx files (docs/adopt-plan.md V2-V6):
// for each of lfdln's names already served before the panel, the host, the routes and
// the site folder that answer the same way, and the requests that show they do.
//
// The nginx harness (test/run-adopt-nginx-test.sh) sends these requests to a copy of
// each hand-written file and to what the renderer makes of these rows, side by side,
// and compares the answers. The takeover on the server (step 3) sends the live ones
// before and after the switch, and puts the hand-written file back if anything differs.
//
// What is meant to differ, on purpose, is written down here too (DIFFERENCES), and a
// request that would only show one of those is not in the lists.
import { readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { APEX } from './names.ts';
import type { Host, Route, ServicePart } from './render.ts';

// One request: its path on the host (or www., for the domain's second name), over
// https unless http is asked for. `harness`: only in the test harness (it would
// spend a real sign-in's rate limit, or send a real service 30 MB).
export type Check = {
  path: string;
  www?: boolean;
  http?: boolean;
  method?: 'GET' | 'POST' | 'HEAD';
  bytes?: number;                        // a POST body of this many bytes
  headers?: Record<string, string>;
  times?: number;                        // sent this many times in a row; every answer compared
  harness?: boolean;
};

export type Takeover = {
  name: string;                          // the host: a label, or "@" for the domain itself
  domain?: string;                       // on another domain (docs/domains-hosts-plan.md step 7); none, the site's own
  link: string;                          // its hand-written file in sites-enabled (and sites-available)
  host: Host;
  folder?: { name: string; from: string; runPhp: false };   // moved into the site folders (V5)
  routes: Route[];
  services?: ServicePart[];              // (a service route: where it answers, from the services record)
  probeDir?: string;                     // a folder its checks take a few files from, when it has no site folder
  checks: (folderDir: string | null) => Check[];
};

// its full name, as the command line takes it: "tutor.lesfleursdelanuit.com", "gonsalvesfamily.com"
export const fullName = (t: Takeover, home: string) => {
  const on = t.domain ?? home;
  return t.name === APEX ? on : `${t.name}.${on}`;
};

// instastylr's headers, as its hand-written file sends them (V4)
const INSTASTYLR_HEADERS = [
  { name: 'Content-Security-Policy', value: "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'" },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
  { name: 'X-Frame-Options', value: 'DENY' },
  { name: 'Referrer-Policy', value: 'no-referrer' },
  { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { name: 'Permissions-Policy', value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()' },
  { name: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

// up to n files of a folder inside the site folder, as paths ("/assets/x.js")
const filesIn = (dir: string | null, sub: string, n: number) => {
  if (!dir) return [];
  try { return readdirSync(`${dir}${sub}`, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${sub}${e.name}`).sort().slice(0, n); } catch { return []; }
};

// up to n files anywhere under a folder (a few levels down), as paths under `at`
const filesUnder = (dir: string | null, at: string, n: number) => {
  const out: string[] = [];
  const walk = (sub: string, depth: number) => {
    if (!dir || out.length >= n || depth > 4) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(`${dir}${sub}`, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      if (out.length >= n) return;
      if (e.name.startsWith('.') || !/^[A-Za-z0-9._~-]+$/.test(e.name)) continue;
      if (e.isFile()) out.push(`${at}${sub}${e.name}`);
      else if (e.isDirectory()) walk(`${sub}${e.name}/`, depth + 1);
    }
  };
  walk('', 0);
  return out;
};

// Gonsalves's two sites (step 7, 7-4): a service each, websockets, 25 MB, the sign-in
// address behind the sign-in limit; the public one's media folders from disk (7-2)
const GONSALVES = 'gonsalvesfamily.com';
const gonsalvesChecks = (health: string, media: boolean) => (dir: string | null): Check[] => [
  { path: '/' }, { path: health }, { path: '/nope-0000' },
  ...(media ? [
    ...filesUnder(dir ? `${dir}/gedcom-admin/` : null, '/uploads/gedcom-admin/', 2).map((path) => ({ path })),
    ...filesUnder(dir ? `${dir}/site-media/` : null, '/uploads/site-media/', 2).map((path) => ({ path })),
    { path: '/uploads/site-media/missing-0000.png' },
  ] : []),
  // (the sign-in address only in the harness: on the server, each round of asking would
  // spend the live sign-in limit, and a 503 there would look like a difference)
  { path: '/api/auth/login', method: 'HEAD' as const, harness: true },
  { path: '/', http: true }, { path: '/deep/page?x=1', http: true },
  ...(media ? [{ path: '/', www: true }, { path: '/', www: true, http: true }] : []),
  { path: '/api/auth/login', method: 'POST' as const, times: 6, harness: true },
  { path: '/upload', method: 'POST' as const, bytes: 20 * 1024 * 1024, harness: true },
  { path: '/upload', method: 'POST' as const, bytes: 30 * 1024 * 1024, harness: true },
  { path: '/ws', headers: { Upgrade: 'websocket', Connection: 'Upgrade' }, harness: true },
];
const gonsalvesRoute = (host: string, part: string): Route => ({
  host, domain: GONSALVES, path: '/', enabled: true, kind: 'service', service: 'gonsalves', part,
  websockets: true, maxBodyMb: 25, signInPaths: ['=/api/auth/login'],
});

export const TAKEOVERS: Takeover[] = [
  {
    name: 'instastylr',
    link: 'instastylr',
    host: { name: 'instastylr', enabled: true },
    folder: { name: 'instastylr', from: '/var/www/instastylr', runPhp: false },
    routes: [{
      host: 'instastylr', path: '/', enabled: true, kind: 'folder', folder: 'instastylr', spa: true,
      headers: INSTASTYLR_HEADERS, cacheForever: ['/assets/'],
    }],
    checks: (dir) => [
      { path: '/' }, { path: '/index.html' }, { path: '/some/client/route' }, { path: '/favicon.ico' },
      ...filesIn(dir, '/assets/', 3).map((path) => ({ path })),
      { path: '/assets/missing-0000.js' }, { path: '/assets/' }, { path: '/', method: 'HEAD' as const },
      { path: '/', http: true }, { path: '/deep/page?x=1', http: true },
    ],
  },
  {
    name: APEX,
    link: 'lesfleursdelanuit',
    host: { name: APEX, enabled: true, withWww: true },
    folder: { name: 'home', from: '/var/www/lesfleursdelanuit', runPhp: false },
    routes: [{ host: APEX, path: '/', enabled: true, kind: 'folder', folder: 'home', spa: false }],
    checks: (dir) => [
      { path: '/' }, { path: '/', www: true }, { path: '/stefanie/' }, { path: '/stefanie' }, { path: '/stefanie/', www: true },
      ...filesIn(dir, '/stefanie/', 5).map((path) => ({ path })),
      ...filesIn(dir, '/stefanie/fonts/', 2).map((path) => ({ path })),
      { path: '/stefanie/fonts/' }, { path: '/nope.html' },
      { path: '/', http: true }, { path: '/stefanie/', http: true, www: true },
    ],
  },
  {
    name: 'tutor',
    link: 'tutorstar',
    host: { name: 'tutor', enabled: true },
    routes: [{
      host: 'tutor', path: '/', enabled: true, kind: 'service', service: 'tutorstar', part: 'web',
      websockets: true, maxBodyMb: 25, signInPaths: ['/api/auth/sign-in'],
    }],
    services: [{ service: 'tutorstar', part: 'web', port: 3041 }],
    checks: () => [
      { path: '/' }, { path: '/login' }, { path: '/api/auth/get-session' }, { path: '/nope-0000' },
      { path: '/', http: true },
      { path: '/api/auth/sign-in/email', method: 'POST', times: 6, harness: true },
      { path: '/api/auth/sign-in-other', harness: true },
      { path: '/upload', method: 'POST', bytes: 20 * 1024 * 1024, harness: true },
      { path: '/upload', method: 'POST', bytes: 30 * 1024 * 1024, harness: true },
      { path: '/ws', headers: { Upgrade: 'websocket', Connection: 'Upgrade' }, harness: true },
    ],
  },
  {
    name: APEX,
    domain: GONSALVES,
    link: 'gonsalves-public',
    host: { name: APEX, enabled: true, withWww: true, domain: GONSALVES },
    routes: [gonsalvesRoute(APEX, 'public')],
    services: [{ service: 'gonsalves', part: 'public', port: 3039 }],
    probeDir: '/mnt/storage/uploads',
    checks: gonsalvesChecks('/', true),
  },
  {
    name: 'admin',
    domain: GONSALVES,
    link: 'gonsalves-admin',
    host: { name: 'admin', enabled: true, domain: GONSALVES },
    routes: [gonsalvesRoute('admin', 'admin')],
    services: [{ service: 'gonsalves', part: 'admin', port: 3040 }],
    checks: gonsalvesChecks('/api/health', false),
  },
];

// What is different after a takeover, on purpose (the page and the plan say so too):
export const DIFFERENCES = [
  'a path with a part starting with a dot (/.env, /.git/) is refused (403), where the hand-written files served it or the single-page app',
  'a 404 is the site folder\'s own 404.html, or the plain one, instead of nginx\'s built-in page',
  'nginx doesn\'t say its version (server_tokens off)',
  'nothing is served through a symlink inside a site folder',
  'a .php file in a site folder whose Run PHP pages is off answers 404, never as text',
  'a 404 is never marked as cached for good (instastylr\'s file marked a missing /assets/ file immutable for a year)',
];

// ---------------------------------------------------------------- sending them

export type Where = { ip: string; http: number; https: number; domain: string };
// What is compared of an answer: its status, the headers that change what a
// browser does, whether it may be cached, and the body of a successful one.
export type Answer = { status: number; headers: Record<string, string>; body: string | null };

const COMPARED = [
  'location', 'content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
  'referrer-policy', 'cross-origin-opener-policy', 'permissions-policy', 'strict-transport-security', 'upgrade',
];

// (Where's domain is the site's own: a takeover on another domain says its own, step 7)
export function hostOf(t: Takeover, c: Check, domain: string): string {
  const on = t.domain ?? domain;
  if (t.name === APEX) return c.www ? `www.${on}` : on;
  return `${t.name}.${on}`;
}

function once(w: Where, host: string, c: Check): Promise<Answer> {
  const body = c.bytes ? Buffer.alloc(c.bytes, 0x61) : null;
  return new Promise((resolve, reject) => {
    const req = (c.http ? httpRequest : httpsRequest)({
      host: w.ip, port: c.http ? w.http : w.https, path: c.path, method: c.method ?? 'GET', servername: host,
      rejectUnauthorized: false, agent: false,
      // a body goes only once nginx says it will take one (a 413 comes back first otherwise)
      headers: { Host: host, ...(c.headers ?? {}), ...(body ? { 'Content-Length': String(body.length), Expect: '100-continue' } : {}) },
      timeout: 20_000,
    }, (res) => {
      const hash = createHash('sha256');
      res.on('data', (d: Buffer) => hash.update(d));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const h of COMPARED) {
          const v = res.headers[h];
          if (v !== undefined) headers[h] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        // Expires is a date: that there is one is what matters
        if (res.headers.expires) headers.expires = '(set)';
        const status = res.statusCode ?? 0;
        // a 404 isn't cached for good any more (DIFFERENCES): its caching isn't compared
        if (status === 404) { delete headers['cache-control']; delete headers.expires; }
        // the harness's own ports, which the real server doesn't have
        if (headers.location) headers.location = headers.location.replace(`:${w.https}/`, '/').replace(`:${w.http}/`, '/');
        resolve({ status, headers, body: status === 200 ? hash.digest('hex') : null });
      });
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, headers: { upgrade: String(res.headers.upgrade ?? '') }, body: null }); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.on('continue', () => req.end(body));
    else req.end();
  });
}

// Every check's answers, in order (a check sent n times gives n answers).
export async function probe(t: Takeover, w: Where, opts: { harness: boolean; folderDir: string | null }): Promise<{ what: string; answer: Answer | string }[]> {
  const out: { what: string; answer: Answer | string }[] = [];
  for (const c of t.checks(opts.folderDir)) {
    if (c.harness && !opts.harness) continue;
    const host = hostOf(t, c, w.domain);
    for (let i = 0; i < (c.times ?? 1); i++) {
      const what = `${c.method ?? 'GET'} ${c.http ? 'http' : 'https'}://${host}${c.path}${c.bytes ? ` (${c.bytes} bytes)` : ''}${c.times ? ` #${i + 1}` : ''}`;
      try { out.push({ what, answer: await once(w, host, c) }); } catch (e) { out.push({ what, answer: `no answer: ${(e as Error).message}` }); }
    }
  }
  return out;
}

// The differences between two runs of the same checks, one line each.
export function compare(before: { what: string; answer: Answer | string }[], after: { what: string; answer: Answer | string }[]): string[] {
  const diffs: string[] = [];
  if (before.length !== after.length) return [`${before.length} answers before, ${after.length} after`];
  before.forEach((b, i) => {
    const a = after[i]!;
    const was = JSON.stringify(b.answer);
    const now = JSON.stringify(a.answer);
    if (was !== now) diffs.push(`${b.what}: was ${was}, now ${now}`);
  });
  return diffs;
}
