// nginx for lfdln's hosts (docs/hosts-plan.md H3-H5): plain functions from the
// table (hosts, their routes, the site folders) to the texts of every file the
// routing helper writes. Nothing here touches the disk.
//
//   <dir>/site.conf              what sites-enabled points at: the two includes
//   <dir>/catch-all.conf         any other <name>.<domain>: https, then a plain 404
//   <dir>/hosts/<name>.conf      one server block per host with a route switched on
//   <dir>/pages/_lfdln/404.html  the plain 404 page
//   <dir>/domains/<domain>/...   another domain's: its catch-all (not for one whose
//                                certificate is for named hosts), 404 page and hosts/
//
// One block per host, with its exact server_name: nginx picks an exact name over
// the catch-all's regex, so a host that is switched off, or has no route on,
// simply falls to the catch-all's 404 (H3). Every name, path and address is
// checked again here (names.ts) before it goes into a file.
//
// Accounts on a route (docs/roles-plan.md step 5, S5-4): a route can name an area
// of the site's gate. Its location asks the gate (auth_request /_pammy/check/<token>,
// inherited by every location inside it), sends someone who may not come in to the
// sign-in page, and hands the gate's answer to the app: X-<Id>-Account, -Username,
// -Role and -Privileges to a service, <ID>_ACCOUNT and the rest to PHP. Every host
// with a route on has the gate's own locations (/_pammy/: sign-in, register, the
// account page, and forms, comments, media and the data API; docs/phase8-plan.md 8-2),
// and the routes are written for the gate too (gate-routes.json). Every service and
// PHP location, accounts or not, clears those names from what the visitor sent, so no
// app can be fooled by a route without them.
//
// Phase 6 (docs/adopt-plan.md V2-V4): the domain itself as a host ("@", with www
// beside it), routes to a service (a port on 127.0.0.1, from the service's own
// record, never from the route), and a folder route's headers and forever-cached
// paths -- what the hand-written files for the apex, instastylr and tutor do, so
// they can be taken over without a visitor seeing a difference.
//
// Target kinds (docs/domains-hosts-plan.md step 2, D-4): what a route shows is a kind,
// and each kind is its module's -- a site folder and a redirect are this module's
// (folderKind, redirectKind below), a service is the services module's
// (@panel/services/route-kind), and so on. A kind checks its own fields, says what it
// is in the file, and writes its own locations; the site hands the renderer the kinds it
// has (cfg.kinds). A route of a kind the site doesn't have is refused.
import { AUDIENCE_RE } from '@panel/core/identity-proof';
import { CLOUDFLARE_RANGES, realIpConf } from './cloudflare.ts';
import { renderFolderCatchAll, renderGatedHost, type FolderGate } from './folder-gate.ts';
import {
  APEX, domainName, folderName, header, LABEL_RE, redirectStatus, redirectTo, routePath, tableHostName, type Header,
} from './names.ts';

export type HostsConfig = {
  domain: string;              // lesfleursdelanuit.com
  dir: string;                 // /etc/nginx/lfdln-hosts: where the files go
  sitesRoot: string;           // /var/www/lesfleursdelanuit-sub: the site folders
  tls: { cert: string; key: string; include?: string[]; dhparam?: string };   // the wildcard, and Let's Encrypt's own settings
  php: { socket: string } | null;   // pammy-php's pool for the site folders, when the PHP module is on
  logs: string;                // /var/log/nginx
  listen?: { http: string; https: string; v6: boolean };    // "80" / "443" (the tests: 127.0.0.1:port)
  // the limit_req zone sign-in paths use (conf.d/ratelimit.conf's "login"); none: refused
  signInZone?: string | null;
  // ports no route may send visitors to: the panel's own, its gate's, its database's
  reservedPorts?: number[];
  // what apps are told who is signed in as ("Lfdln": X-Lfdln-Account, LFDLN_ACCOUNT,
  // $lfdln_account in nginx), and the gate that answers (host:port); no gate: no
  // route can have accounts
  identity?: string;
  gate?: string | null;
  // where a domain's certificate files may be (docs/domains-hosts-plan.md step 1): the
  // table names them, so the helper takes only paths under these
  tlsRoots?: string[];
  // the kinds of target a route may have here (step 2): none given, this module's own
  kinds?: RouteKind[];
  // a domain whose certificate covers these names only (step 7, 7-1): no catch-all, every
  // host's names must be among them, and each host has its own port-80 block
  names?: string[];
  // where certbot's webroot challenges are (7-3), on a domain with named certificates
  acmeRoot?: string;
  // folders nginx serves itself on a route to a service part, by "service/part", and the
  // roots they may be under (7-2): the site's code (the services module's known.ts), never the table
  served?: { folders: Record<string, ServedFolder[]>; roots: string[] };
  // pammy.org (docs/phase8-plan.md 8-7): protected folders are folders, so every block that
  // serves files includes the site's own gate snippets from this folder (folder-gate.ts)
  folderGate?: FolderGate;
  // the logs' name: <logs>/<name>.access.log (none: lfdln-hosts)
  logName?: string;
  // folder hosts (the domain's folder_hosts): the catch-all serves <label>.<domain> from the
  // site folder of that name, instead of a plain 404 (folderGate sites only, for now)
  folderHosts?: boolean;
  // who stands in front of the domain (docs/security-performance-review.md S6): with
  // Cloudflare, every block includes the real-IP file (REAL_IP_FILE), so $remote_addr is the
  // visitor; none: nothing. The domain's row says (withDomain, otherDomains), else the profile.
  front?: 'cloudflare' | 'direct';
  // the ranges the real-IP file trusts (the tests add one of their own): none, cloudflare.ts's
  cloudflareRanges?: readonly string[];
  // where that file is (renderAll sets it: <the hosts folder>/cloudflare-realip.conf)
  realIp?: string;
  // the gate's visitor cookie (the profile's services.gate.cookie): never handed to an app
  // (docs/s1-plan.md S1e); none, no gate and nothing taken out
  visitorCookie?: string;
  // nginx's edge secret (docs/s1-plan.md S1c): the root-only file every location to the gate
  // includes, so the gate believes its X-Real-IP; none, nothing (the gate then believes any
  // local caller, as before)
  edge?: string;
};
export type ServedFolder = { path: string; dir: string; days: number };

// A domain (docs/domains-hosts-plan.md step 1): its settings are data now. The home one
// is the site's own (cfg.domain), and its certificate is what every host block uses.
export type Tls = { cert: string; key: string; include?: string[]; dhparam?: string };
// names: a certificate for exactly these names (step 7, 7-1), and no catch-all
// front: who stands in front of it (S6); none, nothing
export type Domain = { name: string; home: boolean; tls: Tls; names?: string[]; folderHosts?: boolean; front?: 'cloudflare' | 'direct' };

// withWww: only for the domain itself ("@"), www.<domain> answers the same.
// domain: the other domain it is on (step 7); none, the home one
export type Host = { name: string; enabled: boolean; withWww?: boolean; domain?: string };
export type Folder = { name: string; runPhp: boolean };
// A part of an adopted service, and where it answers (the services helper's record)
export type ServicePart = { service: string; part: string; port: number };
// accounts: the route's area in the site's gate (its token): the gate decides who comes in.
// kind: what it shows, and the kind's own fields beside it (step 2), as the panel's table
// has always named them; the kind checks them (RouteKind.fields).
// domain: its host's, when that is on another domain (step 7)
export type RouteBase = { host: string; path: string; enabled: boolean; accounts?: { token: string }; domain?: string };
export type Route = RouteBase & { kind: string; [field: string]: unknown };
export type FolderRoute = RouteBase & { kind: 'folder'; folder: string; spa: boolean; headers?: Header[]; cacheForever?: string[] };
export type RedirectRoute = RouteBase & { kind: 'redirect'; to: string; status: 301 | 302; keepPath: boolean };

// What a kind is given to write its part of a host's block.
export type KindCtx = {
  cfg: HostsConfig;
  host: string;                      // the host's name ("@": the domain itself)
  folders: Map<string, Folder>;      // the site folders, by name
  table: Table;
  taken: Set<string>;                // the locations written so far ("^~ /x/", "= /x"): none twice
  state: unknown;                    // what the kind's own prepare() made of the table
};

// A kind of target (D-4). Its module makes it; the site lists the kinds it has.
export type RouteKind = {
  kind: string;                      // the word in the table and the database ("folder")
  accounts: boolean;                 // whether a route of this kind can have accounts
  // the kind's fields as the panel sends them, checked for their shape (names.ts rules
  // are checked again when written): the route with only those fields, or a throw
  fields(r: Record<string, unknown>): Record<string, unknown>;
  // once per table, before any host: the kind's own view of it (the services' ports)
  prepare?(cfg: HostsConfig, t: Table): unknown;
  describe(r: Route): string;        // the comment above its locations
  // the app a route of this kind sends visitors to, as the gate's proofs name it
  // ("service.examprep.web"; docs/s1-plan.md S1a); none: no app (files), no proof
  audience?(r: Route): string | null;
  locations(ctx: KindCtx, r: Route): string[];
  // lines at the host's level where a route of this kind is on: reserved locations first,
  // then headers every answer gets
  reserve?(ctx: KindCtx, on: Route[]): string[];
  hostHeaders?(ctx: KindCtx, on: Route[]): string[];
};

// domains: none, and the profile's own (cfg.domain, cfg.tls) is the only one
// software: the installed software a route may show (docs/phase8-plan.md 8-7), each with the
// proxy file its helper writes (the apps module's kind reads it)
export type SoftwarePart = { id: string; proxy: string };
export type Table = { hosts: Host[]; folders: Folder[]; routes: Route[]; services?: ServicePart[]; domains?: Domain[]; software?: SoftwarePart[] };

const HEAD = '# Written by the panel\'s routing helper (docs/hosts-plan.md). Changes here are overwritten.\n';
const PLAIN_404 = '/_lfdln/404.html';
// the routes as the gate reads them, beside the host files (8-2)
export const GATE_ROUTES_FILE = 'gate-routes.json';

// a path is safe in a file only if it is a plain absolute path
export const safePath = (p: string, what: string) => {
  if (!/^\/[A-Za-z0-9._/-]*$/.test(p) || p.includes('/../') || p.endsWith('/..')) throw new Error(`hosts: ${what} "${p}" is not a plain path`);
  return p.replace(/\/+$/, '') || '/';
};

function listenLines(cfg: HostsConfig, which: 'http' | 'https'): string[] {
  const l = cfg.listen ?? { http: '80', https: '443', v6: true };
  const port = which === 'http' ? l.http : `${l.https} ssl`;
  const v6 = which === 'http' ? '80' : '443 ssl';
  return [`    listen ${port};`, ...(l.v6 ? [`    listen [::]:${v6};`] : [])];
}

function tlsLines(cfg: HostsConfig): string[] {
  return [
    `    ssl_certificate     ${safePath(cfg.tls.cert, 'certificate')};`,
    `    ssl_certificate_key ${safePath(cfg.tls.key, 'certificate key')};`,
    ...(cfg.tls.include ?? []).map((i) => `    include ${safePath(i, 'TLS include')};`),
    ...(cfg.tls.dhparam ? [`    ssl_dhparam ${safePath(cfg.tls.dhparam, 'DH parameters')};`] : []),
  ];
}

// Cloudflare in front (S6): the real-IP file, in every server block of the domain, so the
// logs, limit_req and every location's X-Real-IP see the visitor, never Cloudflare's edge
export const REAL_IP_FILE = 'cloudflare-realip.conf';
export function frontLines(cfg: HostsConfig): string[] {
  if (cfg.front !== 'cloudflare') return [];
  if (!cfg.realIp) throw new Error(`hosts: Cloudflare is in front of ${cfg.domain}, but there is no real-IP file`);
  return [`    include ${safePath(cfg.realIp, 'real-IP file')};   # Cloudflare in front: the visitor's own address`];
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- accounts
const IDENTITY_RE = /^[A-Z][a-z]{1,15}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
// the four things an app is told, and the gate's own header each comes from
export const FIELDS = [['Account', 'account'], ['Username', 'user'], ['Role', 'role'], ['Privileges', 'privileges']] as const;

type Ident = { header: (f: string) => string; php: (f: string) => string; v: (f: string) => string; login: string };
export function identityOf(cfg: HostsConfig): Ident {
  const id = cfg.identity ?? 'Lfdln';
  if (!IDENTITY_RE.test(id)) throw new Error(`hosts: "${id}" can't name the identity headers`);
  const low = id.toLowerCase();
  return {
    header: (f) => `X-${id}-${f}`, php: (f) => `${id.toUpperCase()}_${f.toUpperCase()}`, v: (f) => `$${low}_${f.toLowerCase()}`,
    login: `@${low}_login`,
  };
}
export const tokenOf = (r: RouteBase) => {
  if (!r.accounts) return null;
  if (!TOKEN_RE.test(r.accounts.token)) throw new Error(`hosts: ${r.path} names an area that isn't one`);
  return r.accounts.token;
};

// Inside a route's location: ask the gate, keep its answer, and send whoever may
// not come in to the sign-in page. Locations inside it inherit all of this (a
// location there with an error_page of its own would have to say 401 again).
//
// audience (docs/s1-plan.md S1a): a route to an app names it ("service.examprep.web"), and
// the gate signs what the app is told for that app alone: the proof (X-<Id>-Proof, below).
export function gateLines(cfg: HostsConfig, token: string, indent: string, audience?: string): string[] {
  const id = identityOf(cfg);
  if (audience !== undefined && !AUDIENCE_RE.test(audience)) throw new Error(`hosts: "${audience}" can't name an app`);
  return [
    `auth_request /_pammy/check/${token}${audience ? `/${audience}` : ''};`,
    `auth_request_set ${id.v('login')} $upstream_http_x_pammy_login;`,
    `auth_request_set ${id.v('cache')} $upstream_http_x_pammy_cache;`,
    ...FIELDS.map(([f, g]) => `auth_request_set ${id.v(f)} $upstream_http_x_pammy_${g};`),
    ...(audience ? [`auth_request_set ${id.v(PROOF)} $upstream_http_x_pammy_proof;`] : []),
    `error_page 401 = ${id.login};`,
  ].map((l) => `${indent}${l}`);
}

// The proof an app checks the four headers with (docs/s1-plan.md, review S1): the gate's,
// on a route with accounts; never what the visitor sent.
export const PROOF = 'Proof';
export const proofLine = (cfg: HostsConfig, token: string | null, indent: string) => {
  const id = identityOf(cfg);
  return `${indent}proxy_set_header ${id.header(PROOF)} ${token ? id.v(PROOF) : '""'};`;
};

// The gate's cookie stays with the gate (docs/s1-plan.md S1e, review SF3): the visitor's
// session cookie is the gate's alone -- apps learn who is signed in from the headers above,
// never from it -- so what nginx hands an app (a service, a project's server, PHP in a site
// folder) is the visitor's Cookie header without it; the app's own cookies go along as
// they came. Two maps in site.conf (http level): the first takes one out (at the start, or
// after a ";" and any spaces), the second sends no cookies at all if the name is still there (sent twice,
// say), so a header nginx can't take it out of cleanly never reaches the app.
const VISITOR_COOKIE_RE = /^__Host-[a-z][a-z0-9_]{0,40}$/;
const cookieVarOf = (cfg: HostsConfig) => {
  const c = cfg.visitorCookie;
  if (!c) return null;
  if (!VISITOR_COOKIE_RE.test(c)) throw new Error(`hosts: "${c}" can't be the visitor cookie's name`);
  return `app_cookie_${c.slice('__Host-'.length)}`;
};
// what an app gets as Cookie (none: no gate cookie on this site, the visitor's header as it is)
export function appCookieLine(cfg: HostsConfig, indent: string, as: 'proxy' | 'php' = 'proxy'): string[] {
  const v = cookieVarOf(cfg);
  if (!v) return [];
  return [as === 'php' ? `${indent}fastcgi_param HTTP_COOKIE $${v};` : `${indent}proxy_set_header Cookie $${v};`];
}
// as: the variable's name (WordPress's own map, wordpress/nginx/cookie-map.conf, has one of its
// own, so it can be at http level beside the site's)
export function appCookieMaps(cfg: HostsConfig, as?: string): string[] {
  if (as !== undefined && !/^[a-z][a-z0-9_]{0,60}$/.test(as)) throw new Error(`hosts: "${as}" can't name a variable`);
  const v = cookieVarOf(cfg) && (as ?? cookieVarOf(cfg));
  if (!v) return [];
  const name = cfg.visitorCookie!;
  return [
    `# the gate's cookie (${name}) is never handed to an app (docs/s1-plan.md S1e)`,
    `map $http_cookie $${v}_once {`,
    `    "~^${name}=[^;]*(?:;\\s*)?(?<rest>.*)$" "$rest";`,
    `    "~^(?<pre>.*?);\\s*${name}=[^;]*(?<post>.*)$" "$pre$post";`,
    '    default $http_cookie;',
    '}',
    // the name anywhere a cookie's name can start, with any spaces before its "=" (the
    // review's F1: a tab after ";", "name =v"), as loosely as any cookie reader might take it
    `map $${v}_once $${v} {`,
    `    "~(?:^|[;\\s])${name}\\s*=" "";`,
    `    default $${v}_once;`,
    '}',
  ];
}

// The gate's own locations (docs/phase8-plan.md 8-2, P8-3): on every host with a route
// switched on, /_pammy/ -- the sign-in pages, and what forms, comments, media and the
// data API answer there -- with the 2m data-API write location beside it; and, only on a
// host with a route that has accounts, the check nginx asks (internal) and the way to the
// sign-in page. base: X-Pammy-Base, the site folder the host shows at its top ("/home"),
// "/" when that isn't a site folder; the gate finds any other page by the route table
// (gate-routes.json, beside these files).
function gateServerLines(cfg: HostsConfig, base: string, accounts: boolean): string[] {
  if (!cfg.gate || !/^127\.0\.0\.1:[0-9]{2,5}$/.test(cfg.gate)) throw new Error('hosts: this site has no gate, so no route can have accounts');
  if (!/^\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/.test(base)) throw new Error(`hosts: "${base}" can't be the gate's base`);
  const id = identityOf(cfg);
  const proxied = (limit: string) => [
    `        proxy_pass http://${cfg.gate};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host            $host;',
    `        proxy_set_header X-Pammy-Base    "${base}";`,
    '        proxy_set_header X-Real-IP       $remote_addr;',
    ...(cfg.edge ? [`        include ${safePath(cfg.edge, 'edge file')};   # X-Lfdln-Edge: so the gate believes X-Real-IP (S1c)`] : []),
    '        proxy_set_header X-Forwarded-For "";',
    `        client_max_body_size ${limit};`,
  ];
  return [
    ...(accounts ? [
      '',
      '    # accounts (docs/roles-plan.md step 5): the gate answers for the routes that have',
      '    # them; nobody from outside can ask it here (internal)',
      '    location ^~ /_pammy/check/ {',
      '        internal;',
      `        proxy_pass http://${cfg.gate}/check/;`,
      '        proxy_pass_request_body off;',
      '        proxy_set_header Content-Length "";',
      '        proxy_set_header Host         $host;',
      '        proxy_set_header X-Pammy-Next $request_uri;',
      '        proxy_set_header Cookie       $http_cookie;',
      '        proxy_set_header X-Real-IP    "";   # never the visitor\'s own (S1c): the check doesn\'t need one',
      '        proxy_connect_timeout 2s;',
      '        proxy_read_timeout 5s;',
      '        # up to 100 privileges of 64 characters in the answer\'s headers: never cut',
      '        proxy_buffer_size 16k;',
      '        proxy_buffers 4 16k;',
      '    }',
    ] : []),
    '',
    '    # the gate (docs/phase8-plan.md 8-2): the sign-in, register and account pages, and',
    '    # what forms, comments, media and the data API answer, on every host',
    '    location ^~ /_pammy/ {',
    ...proxied('64k'),
    '        # a program adding or changing a record through the data API: rich text goes',
    '        # far past 64k (as pammy.org\'s gate.conf; nested, since ^~ keeps regexes out)',
    '        location ~ ^/_pammy/api/data/[^/]+/[^/]+/[^/]+/(new|[^/]+/save)$ {',
    ...proxied('2m').map((l) => `    ${l}`),
    '        }',
    '    }',
    ...(accounts ? [
      `    location ${id.login} {`,
      '        add_header Cache-Control "private, no-store" always;',
      `        return 302 ${id.v('login')};`,
      '    }',
    ] : []),
  ];
}

// The routes as the gate reads them (gate-routes.json, docs/phase8-plan.md 8-2): every
// name a host with a route on answers to, and what each of its routes shows -- a site
// folder, a service, a redirect -- with its area's token where it has accounts. Written
// with the host files, so nginx and the gate never disagree about a route.
// audience: on a route with accounts to an app, the app its proofs are made out to; the gate
// signs for an audience only on a route that has it with that area (docs/s1-plan.md S1a, B1)
export type GateRoute = { path: string; kind: string; folder?: string; service?: string; area: string | null; audience?: string };
export type GateRoutes = { v: 1; domains: string[]; hosts: Record<string, GateRoute[]> };

// The plain 404 page every host and the catch-all fall back to.
export const plain404 = (domain: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
<h1>Not found</h1>
<p>There is nothing at this address on ${domain}.</p>
</html>
`;

// Hidden files and folders, and anything PHP might once have run that isn't
// being run here, are never handed out as they are.
const DENY_HIDDEN = '        location ~ /\\. { deny all; }';
const NEVER_AS_TEXT = '        location ~* "\\.(?:php[0-9]?|phtml|phar|phps)$" { return 404; }';
// an app's privileges and roles (docs/roles-plan.md step 6): the panel reads it, visitors never do
const NO_MANIFEST = '        location ~ "/pammy-panel\\.json$" { return 404; }';

function folderLocation(cfg: HostsConfig, r: FolderRoute, folder: Folder): string[] {
  const dir = `${safePath(cfg.sitesRoot, 'site folders root')}/${folderName(folder.name)}`;
  return staticLocation(cfg, r, dir, !!cfg.php && folder.runPhp);
}

// What nginx serves as files from a folder: a site folder, or a project's live release
// (docs/phase8b-plan.md 8b-2: the projects module's kind writes its routes with this too).
export type StaticRoute = RouteBase & { spa: boolean; headers?: Header[]; cacheForever?: string[] };
export function staticLocation(cfg: HostsConfig, r: StaticRoute, dir: string, php: boolean): string[] {
  const path = routePath(r.path);
  const top = path === '/';
  const fallback = r.spa ? `${path}index.html` : '=404';
  const headers = (r.headers ?? []).map(header);
  if (new Set(headers.map((h) => h.name)).size !== headers.length) throw new Error(`hosts: ${path} sends one header twice`);
  const forever = (r.cacheForever ?? []).map((c) => routePath(c));
  // (under a folder shown further down, nginx's alias and a location inside it don't mix)
  if (forever.length && !top) throw new Error(`hosts: only a folder at the top of a host has paths cached for good (${path})`);
  for (const c of forever) if (c === '/') throw new Error('hosts: the whole host can\'t be cached for good');
  const token = tokenOf(r);
  const id = identityOf(cfg);
  // with accounts, "private, no-store" where the gate says so (a route only some may open)
  const headerLines = (indent: string, cache = true) => [
    ...headers.map((h) => `${indent}add_header ${h.name} "${h.value}" always;`),
    ...(token && cache ? [`${indent}add_header Cache-Control ${id.v('cache')} always;`] : []),
  ];
  const out: string[] = [];
  // "/docs" without its slash goes on to "/docs/", as a folder does
  if (!top) out.push(`    location = ${path.slice(0, -1)} { return 301 ${path}; }`);
  out.push(`    location ^~ ${path} {`);
  // at the top the host's root is the folder; further down, the folder stands in for the path
  out.push(top ? `        root ${dir};` : `        alias ${dir}/;`);
  out.push(`        index index.html${php ? ' index.php' : ''};`);
  out.push(`        try_files $uri $uri/ ${fallback};`);
  if (token) out.push(...gateLines(cfg, token, '        '));
  // every answer from this route, errors too; the locations inside it that set their
  // own headers repeat these (nginx drops the outer add_header lines where a location
  // has any of its own)
  out.push(...headerLines('        '));
  for (const c of [...new Set(forever)].sort()) {
    // files that never change under their name (a build's hashed assets): a year in
    // any cache; a missing one is a 404, never the single-page app's index.html.
    // No ^~, so the hidden-file and PHP rules below still come first.
    out.push(`        location ${c} {`);
    out.push('            try_files $uri =404;');
    out.push('            expires 1y;');
    out.push('            add_header Cache-Control "public, immutable" always;');
    out.push(...headerLines('            ', false));
    out.push('        }');
  }
  if (top) {
    // the folder's own 404.html, if it has one; the plain one otherwise
    out.push('        error_page 404 /404.html;');
    out.push(`        location = /404.html { try_files /404.html ${PLAIN_404}; }`);
  }
  out.push(DENY_HIDDEN);
  out.push(NO_MANIFEST);
  if (php) {
    out.push('        location ~ "^(?!.*/\\.).*\\.php$" {');
    out.push('            try_files $uri =404;');
    out.push(`            fastcgi_pass unix:${safePath(cfg.php!.socket, 'PHP socket')};`);
    out.push('            include /etc/nginx/fastcgi_params;');
    out.push('            fastcgi_param SCRIPT_FILENAME $request_filename;');
    out.push('            fastcgi_param PAMMY_USER "";');
    // PHP reaches the data API through its socket with a key, never the visitor's session (S1e)
    out.push(...appCookieLine(cfg, '            ', 'php'));
    // who is signed in, from the gate's answer (empty without accounts), and never from the visitor
    for (const [f] of FIELDS) out.push(`            fastcgi_param ${id.php(f)} ${token ? id.v(f) : '""'};`);
    for (const f of [...FIELDS.map(([x]) => x), PROOF]) out.push(`            fastcgi_param HTTP_${id.header(f).toUpperCase().replace(/-/g, '_')} "";`);
    out.push('            fastcgi_param HTTP_PROXY "";');
    out.push('            fastcgi_read_timeout 35s;');
    out.push('            client_max_body_size 8m;');
    out.push('        }');
  }
  out.push(NEVER_AS_TEXT);
  out.push('    }');
  return out;
}

function redirectLocation(r: RedirectRoute): string[] {
  const path = routePath(r.path);
  if (r.accounts) throw new Error(`hosts: ${path} is a redirect, which can't have accounts`);
  const to = redirectTo(r.to);
  const status = redirectStatus(r.status);
  // a path on this host inside the route's own path would send the visitor round forever
  if (to.startsWith('/') && `${to.replace(/\/?$/, '/')}`.startsWith(path)) throw new Error(`hosts: ${path} can't redirect to ${to}, which is inside it (a loop)`);
  const flag = status === 301 ? 'permanent' : 'redirect';
  const body = r.keepPath
    // the rest of the path after the route's own goes along, and so does the query
    ? `rewrite ^${escRe(path)}(.*)$ ${to.replace(/\/+$/, '')}/$1 ${flag};`
    : `return ${status} ${to};`;
  const out: string[] = [];
  if (path !== '/') out.push(`    location = ${path.slice(0, -1)} { ${r.keepPath ? `return ${status} ${to};` : body} }`);
  out.push(`    location ^~ ${path} { ${body} }`);
  return out;
}

export const ACME_ROOT = '/var/www/letsencrypt';
// certbot's webroot challenges (step 7, 7-3), where a domain's certificate is for named hosts
const acmeLines = (cfg: HostsConfig) => (cfg.names
  ? [`    location ^~ /.well-known/acme-challenge/ { root ${safePath(cfg.acmeRoot ?? ACME_ROOT, 'challenge folder')}; }`]
  : []);

// the names a host answers to: <name>.<domain>, or the domain (and www) for "@"
function serverNames(cfg: HostsConfig, host: Host): string {
  const name = tableHostName(host.name);
  if (host.withWww && name !== APEX) throw new Error(`hosts: only the domain itself has www beside it, not ${name}`);
  return name === APEX ? `${cfg.domain}${host.withWww ? ` www.${cfg.domain}` : ''}` : `${name}.${cfg.domain}`;
}

// ---------------------------------------------------------------- this module's kinds (step 2)

// A site folder (D-3: the hosts module's until phase 8, then Files').
export const folderKind: RouteKind = {
  kind: 'folder',
  accounts: true,
  fields: (r) => {
    if (typeof r.folder !== 'string') throw new Error('a route\'s folder is missing.');
    if (typeof r.spa !== 'boolean') throw new Error('spa is not true or false.');
    if (r.headers !== undefined && (!Array.isArray(r.headers) || r.headers.length > 20)) throw new Error('A route\'s headers are not a list.');
    const words = (v: unknown, what: string) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) throw new Error(`${what} is not a list of words.`);
      return v as string[];
    };
    const headers = ((r.headers ?? []) as Record<string, unknown>[]).map((h) => {
      if (typeof h?.name !== 'string' || typeof h?.value !== 'string') throw new Error('a header\'s name or value is missing.');
      return { name: h.name, value: h.value };
    });
    return { folder: r.folder, spa: r.spa, headers, cacheForever: words(r.cacheForever, 'cacheForever') };
  },
  describe: (r) => `site folder ${r.folder}${r.spa ? ' (single-page app)' : ''}`,
  locations: (ctx, r) => {
    const f = ctx.folders.get(r.folder as string);
    if (!f) throw new Error(`hosts: ${ctx.host}${routePath(r.path)} shows site folder "${r.folder}", which isn't there`);
    return folderLocation(ctx.cfg, r as FolderRoute, f);
  },
  // The top folder route's headers are the host's: the plain 404 page (and anything
  // else answered outside a route) sends them too, as a hand-written server block's
  // headers would (docs/adopt-plan.md V4)
  hostHeaders: (_ctx, on) => {
    const top = on.find((r) => r.kind === 'folder' && routePath(r.path) === '/') as FolderRoute | undefined;
    return (top?.headers ?? []).map(header).map((h) => `    add_header ${h.name} "${h.value}" always;`);
  },
};

export const redirectKind: RouteKind = {
  kind: 'redirect',
  accounts: false,
  fields: (r) => {
    if (typeof r.to !== 'string') throw new Error('a redirect\'s address is missing.');
    if (r.status !== 301 && r.status !== 302) throw new Error('A redirect is 301 or 302.');
    if (typeof r.keepPath !== 'boolean') throw new Error('keepPath is not true or false.');
    return { to: r.to, status: r.status, keepPath: r.keepPath };
  },
  describe: (r) => `redirect ${r.status} to ${r.to}${r.keepPath ? ' (the path goes along)' : ''}`,
  locations: (_ctx, r) => redirectLocation(r as RedirectRoute),
};

// The hosts module's own kinds: what a site with no others has.
export const HOSTS_KINDS: readonly RouteKind[] = [folderKind, redirectKind];

// The site's kinds by their word, each once.
export function kindsOf(cfg: HostsConfig): Map<string, RouteKind> {
  const out = new Map<string, RouteKind>();
  for (const k of cfg.kinds ?? HOSTS_KINDS) {
    if (!/^[a-z][a-z-]{0,30}[a-z]$/.test(k.kind) || out.has(k.kind)) throw new Error(`hosts: the kind "${k.kind}" is there twice, or isn't a word`);
    out.set(k.kind, k);
  }
  return out;
}

export function renderHost(cfg: HostsConfig, host: Host, routes: Route[], folders: Map<string, Folder>, t: Table, states: Map<string, unknown> = new Map()): string {
  const kinds = kindsOf(cfg);
  const name = tableHostName(host.name);
  const names = serverNames(cfg, host);
  const on = routes.filter((r) => r.enabled).sort((a, b) => a.path.localeCompare(b.path));
  for (const r of on) if (!kinds.has(r.kind)) throw new Error(`hosts: ${name}${routePath(r.path)} is a ${r.kind}, which this site doesn't have`);
  const seen = new Set<string>();
  const taken = new Set<string>();
  const ctxOf = (k: RouteKind): KindCtx => ({ cfg, host: name, folders, table: t, taken, state: states.get(k.kind) });
  // pammy.org's shapes (docs/phase8-plan.md 8-7)
  if (cfg.folderGate) return renderGatedHost(cfg, host, names, on, kinds, ctxOf);
  // a domain whose certificate is for named hosts (step 7): every name the host answers to is on it
  if (cfg.names) {
    const missing = names.split(' ').filter((n) => !cfg.names!.includes(n));
    if (missing.length) throw new Error(`hosts: ${cfg.domain}'s certificate doesn't cover ${missing.join(', ')}`);
  }
  const lines: string[] = [HEAD];
  // the catch-all's http block only takes <label>.<domain> names: the domain and www
  // get their own way to https; on a domain with no catch-all (named certificates) every
  // host has its own, where certbot's challenges are answered too
  if (cfg.names) {
    lines.push('server {', ...listenLines(cfg, 'http'), `    server_name ${names};`, ...frontLines(cfg), '    server_tokens off;', ...acmeLines(cfg),
      '    location / { return 301 https://$host$request_uri; }', '}', '');
  } else if (name === APEX) lines.push('server {', ...listenLines(cfg, 'http'), `    server_name ${names};`, ...frontLines(cfg), '    return 301 https://$host$request_uri;', '}', '');
  lines.push('server {', ...listenLines(cfg, 'https'), `    server_name ${names};`, ...tlsLines(cfg), ...frontLines(cfg), '');
  lines.push(`    access_log ${safePath(cfg.logs, 'log folder')}/lfdln-hosts.access.log;`);
  lines.push(`    error_log  ${safePath(cfg.logs, 'log folder')}/lfdln-hosts.error.log;`);
  lines.push('    server_tokens off;');
  // nothing is served through a symlink inside a site folder (one pointing out of
  // it, say); the path up to the folder itself isn't looked at
  lines.push('    disable_symlinks on from=$document_root;');
  lines.push(`    error_page 404 ${PLAIN_404};`);
  lines.push(`    location = ${PLAIN_404} { root ${safePath(cfg.dir, 'hosts folder')}/pages; }`);
  lines.push(...acmeLines(cfg));
  // the gate's own locations, on every host (P8-3); no route of its own may be under /_pammy/
  if (cfg.gate) {
    for (const r of on) if (routePath(r.path).startsWith('/_pammy/')) throw new Error(`hosts: /_pammy/ is the gate's on every host, so ${name} can't have a route at ${routePath(r.path)}`);
    const top = on.find((r) => routePath(r.path) === '/' && r.kind === 'folder') as FolderRoute | undefined;
    lines.push(...gateServerLines(cfg, top ? `/${folderName(top.folder)}` : '/', on.some((r) => r.accounts)));
  } else if (on.some((r) => r.accounts)) gateServerLines(cfg, '/', true);
  // what the kinds on this host keep for themselves, then the headers every answer gets
  const here = [...kinds.values()].filter((k) => on.some((r) => r.kind === k.kind));
  for (const k of here) if (k.reserve) lines.push(...k.reserve(ctxOf(k), on));
  for (const k of here) if (k.hostHeaders) lines.push(...k.hostHeaders(ctxOf(k), on));
  for (const r of on) {
    const k = kinds.get(r.kind)!;
    const path = routePath(r.path);
    if (seen.has(path) || taken.has(`^~ ${path}`)) throw new Error(`hosts: ${name} has two routes at ${path}`);
    seen.add(path);
    taken.add(`^~ ${path}`);
    if (r.accounts && !k.accounts) throw new Error(`hosts: ${path} is a ${r.kind}, which can't have accounts`);
    lines.push('', `    # ${path}: ${k.describe(r)}`);
    lines.push(...k.locations(ctxOf(k), r));
  }
  // with no route at the top, the top is the plain 404 too
  if (!seen.has('/')) lines.push('', '    location / { return 404; }');
  lines.push('}', '');
  return lines.join('\n');
}

export function renderCatchAll(cfg: HostsConfig): string {
  const re = `"~^(?!www\\.)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${escRe(cfg.domain)}$"`;
  return [
    HEAD,
    '# Any other <name>.' + cfg.domain + ': the hosts have exact server_names, which nginx',
    '# prefers, so this only ever answers names the panel isn\'t serving: a plain 404.',
    'server {', ...listenLines(cfg, 'http'), `    server_name ${re};`, ...frontLines(cfg), '    return 301 https://$host$request_uri;', '}', '',
    'server {', ...listenLines(cfg, 'https'), `    server_name ${re};`, ...tlsLines(cfg), ...frontLines(cfg),
    `    access_log ${safePath(cfg.logs, 'log folder')}/lfdln-hosts.access.log;`,
    '    server_tokens off;',
    `    root ${safePath(cfg.dir, 'hosts folder')}/pages;`,
    `    error_page 404 ${PLAIN_404};`,
    `    location = ${PLAIN_404} { }`,
    '    location / { return 404; }',
    '}', '',
  ].join('\n');
}

export const TLS_ROOTS = ['/etc/letsencrypt/', '/etc/ssl/'];

// A domain's certificate, checked: every path a plain one under the roots the site allows.
export function checkedTls(cfg: HostsConfig, tls: Tls): Tls {
  const roots = cfg.tlsRoots ?? TLS_ROOTS;
  const under = (p: unknown, what: string) => {
    if (typeof p !== 'string') throw new Error(`hosts: the ${what} is missing`);
    const clean = safePath(p, what);
    if (!roots.some((r) => clean.startsWith(r))) throw new Error(`hosts: the ${what} ${clean} isn't under ${roots.join(' or ')}`);
    return clean;
  };
  if (tls.include !== undefined && (!Array.isArray(tls.include) || tls.include.length > 5)) throw new Error('hosts: the TLS includes are not a list');
  return {
    cert: under(tls.cert, 'certificate'), key: under(tls.key, 'certificate key'),
    ...(tls.include?.length ? { include: tls.include.map((i) => under(i, 'TLS include')) } : {}),
    ...(tls.dhparam ? { dhparam: under(tls.dhparam, 'DH parameters') } : {}),
  };
}

// The home domain's row, checked: it is the site's own domain (the panel can't send
// the hosts somewhere else), and its certificate's files are under the roots the site
// allows. The profile's settings stand when the table has no domains.
export function withDomain(cfg: HostsConfig, t: Table): HostsConfig {
  if (!t.domains?.length) return cfg;
  const homes = t.domains.filter((d) => d.home);
  if (homes.length !== 1) throw new Error('hosts: the table has no home domain, or more than one');
  const home = homes[0]!;
  if (domainName(home.name) !== cfg.domain) throw new Error(`hosts: the home domain is ${cfg.domain}, not ${home.name}`);
  return { ...cfg, tls: checkedTls(cfg, home.tls), ...(home.folderHosts ? { folderHosts: true } : {}), ...(home.front ? { front: home.front } : {}) };
}

// The names a domain's certificate covers (step 7, 7-1): the domain itself or names under
// it, one label deep ("www.<domain>", "admin.<domain>"), each once; no wildcards.
export function certNames(domain: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new Error(`hosts: ${domain}'s certificate names are not a list`);
  const out = new Set<string>();
  for (const n of v) {
    const label = typeof n === 'string' && n.endsWith(`.${domain}`) ? n.slice(0, -domain.length - 1) : null;
    if (n !== domain && (label === null || !LABEL_RE.test(label))) throw new Error(`hosts: ${String(n).slice(0, 80)} isn't ${domain} or one name under it`);
    out.add(n as string);
  }
  return [...out].sort();
}

// The site's other domains (step 4), each with its own settings: a catch-all of their own
// -- any <name>.<domain> to https, then the plain 404 -- unless their certificate is for
// named hosts only (step 7). None may be the home domain, under it, or over it.
export function otherDomains(cfg: HostsConfig, t: Table): HostsConfig[] {
  const out: HostsConfig[] = [];
  const seen = new Set<string>([cfg.domain]);
  for (const d of t.domains ?? []) {
    if (d.home) continue;
    const name = domainName(d.name);
    if (d.name !== name) throw new Error(`hosts: "${d.name}" is not a domain`);
    for (const other of seen) {
      if (name === other || name.endsWith(`.${other}`) || other.endsWith(`.${name}`)) throw new Error(`hosts: ${name} is ${name === other ? 'there twice' : `inside ${other}, or the other way round`}`);
    }
    seen.add(name);
    out.push({
      ...cfg, domain: name, tls: checkedTls(cfg, d.tls), dir: `${safePath(cfg.dir, 'hosts folder')}/domains/${name}`,
      // its own front (S6): a row without one has nothing in front, whatever the home one has
      front: d.front ?? 'direct',
      ...(d.names ? { names: certNames(name, d.names) } : {}),
    });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

// Every file, by its path under cfg.dir. Hosts switched off, or with no route
// switched on, have no file: the catch-all answers for them.
export function renderAll(base: HostsConfig, t: Table): Map<string, string> {
  // the real-IP file is the same for every domain (S6), beside site.conf
  const cfg = { ...withDomain(base, t), realIp: `${safePath(base.dir, 'hosts folder')}/${REAL_IP_FILE}` };
  if (!LABEL_RE.test(cfg.domain.split('.')[0] ?? '') || !/^[a-z0-9.-]+$/.test(cfg.domain)) throw new Error(`hosts: "${cfg.domain}" is not a domain`);
  const dir = safePath(cfg.dir, 'hosts folder');
  const folders = new Map(t.folders.map((f) => [folderName(f.name), f]));
  // each kind's own view of the table (the services' ports), once
  const states = new Map<string, unknown>();
  for (const k of kindsOf(cfg).values()) if (k.prepare) states.set(k.kind, k.prepare(cfg, t));
  const others = otherDomains(cfg, t);
  // a host's domain (step 7): the home one, unless it names another
  const byDomain = new Map<string, HostsConfig>([[cfg.domain, cfg], ...others.map((d) => [d.domain, d] as const)]);
  const domainOf = (d: string | undefined, what: string) => {
    const c = byDomain.get(d ?? cfg.domain);
    if (!c) throw new Error(`hosts: ${what} is on ${d}, which isn't a domain here`);
    return c;
  };
  const keys = new Set<string>();
  const out = new Map<string, string>();
  const hostFiles = new Set<string>();
  const gateRoutes: GateRoutes = { v: 1, domains: [cfg.domain, ...others.map((d) => d.domain)], hosts: {} };
  const homeKinds = kindsOf(cfg);
  const audienceOf = (r: Route) => {
    const a = r.accounts ? homeKinds.get(r.kind)?.audience?.(r) ?? null : null;
    if (a !== null && !AUDIENCE_RE.test(a)) throw new Error(`hosts: "${a}" can't name an app`);
    return a;
  };
  for (const h of [...t.hosts].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = tableHostName(h.name);
    const hc = domainOf(h.domain, name);
    const key = `${hc.domain} ${name}`;
    if (keys.has(key)) throw new Error(`hosts: ${name === APEX ? hc.domain : `${name}.${hc.domain}`} is there twice`);
    keys.add(key);
    const routes = t.routes.filter((r) => r.host === name && (r.domain ?? cfg.domain) === hc.domain);
    if (!h.enabled || !routes.some((r) => r.enabled)) continue;
    const home = hc === cfg;
    // (the site's gate answers for the home domain's hosts only, for now)
    if (!home && routes.some((r) => r.accounts)) throw new Error(`hosts: ${name === APEX ? hc.domain : `${name}.${hc.domain}`} is on another domain, where no route can have accounts yet`);
    out.set(home ? `hosts/${name}.conf` : `domains/${hc.domain}/hosts/${name}.conf`, renderHost(hc, h, routes, folders, t, states));
    if (!home) hostFiles.add(hc.domain);
    const shown = routes.filter((r) => r.enabled).sort((a, b) => a.path.localeCompare(b.path)).map((r): GateRoute => ({
      path: routePath(r.path), kind: r.kind,
      ...(r.kind === 'folder' ? { folder: folderName(String(r.folder)) } : {}),
      ...(typeof r.service === 'string' ? { service: r.service } : {}),
      area: r.accounts ? tokenOf(r) : null,
      ...(audienceOf(r) ? { audience: audienceOf(r)! } : {}),
    }));
    for (const n of serverNames(hc, h).split(' ')) gateRoutes.hosts[n] = shown;
  }
  for (const r of t.routes) {
    if (!keys.has(`${domainOf(r.domain, r.host).domain} ${r.host}`)) throw new Error(`hosts: a route is on ${r.host}${r.domain ? ` (${r.domain})` : ''}, which isn't a host`);
  }
  if (cfg.folderHosts && !cfg.folderGate) throw new Error('hosts: folder hosts are only on where the gate looks at folders, for now');
  out.set('catch-all.conf', cfg.folderHosts ? renderFolderCatchAll(cfg) : renderCatchAll(cfg));
  out.set('pages/_lfdln/404.html', plain404(cfg.domain));
  // the other domains (step 4): each its own catch-all (none where the certificate is for
  // named hosts, step 7) and 404 page, under domains/<name>/, and their hosts (step 7)
  for (const d of others) {
    if (!d.names) out.set(`domains/${d.domain}/catch-all.conf`, renderCatchAll(d));
    out.set(`domains/${d.domain}/pages/_lfdln/404.html`, plain404(d.domain));
  }
  const includes = [
    `include ${dir}/catch-all.conf;`, `include ${dir}/hosts/*.conf;`,
    ...(others.some((d) => !d.names) ? [`include ${dir}/domains/*/catch-all.conf;`] : []),
    ...(hostFiles.size ? [`include ${dir}/domains/*/hosts/*.conf;`] : []),
  ];
  out.set('site.conf', `${HEAD}${[...appCookieMaps(cfg), ...includes].join('\n')}\n`);
  // always there, so a block that includes it never meets a missing file (S6)
  out.set(REAL_IP_FILE, realIpConf(cfg.cloudflareRanges ?? CLOUDFLARE_RANGES));
  if (cfg.gate) out.set(GATE_ROUTES_FILE, `${JSON.stringify(gateRoutes, null, 1)}\n`);
  return out;
}
