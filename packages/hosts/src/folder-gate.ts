// pammy.org's hosts (docs/phase8-plan.md 8-7a): the shapes of the hand-kept `pamela` site,
// made from the table. On a site whose protected folders are folders (cfg.folderGate), the
// gate is asked about every file the way the hand-kept file has always asked it: each block
// that serves files includes the site's own gate snippets (gate.conf, uri.conf -- the same
// files, installed by the site's installer) with its base, so nested protected folders,
// their sign-in pages, PHP with who is signed in and the photos -> images redirect answer
// exactly as they do today. lfdln's hosts (route areas, render.ts) are untouched by this.
//
//   a host with the whole website at its top (the `site` kind): pammy.org's main block --
//     every folder at /<folder>/, a folder's own 404.html then the site's;
//   a host with a site folder at its top (the folder kind, gated): <folder>.pammy.org's
//     block -- the folder's 404.html then the site's;
//   folder hosts on: the domain's catch-all is the regex block that serves any
//     <label>.<domain> from the site folder of that name (none: its 404), so a folder she
//     uploads is at its subdomain at once, as today;
//   any other host (WordPress on its own name): no gate, hidden files refused.
//
// The order of the regex locations is the hand-kept file's, since nginx takes the first
// regex that matches: the gate's (photos, PHP) first, then the hidden-file deny, then the
// folder-404 rule.
import { domainName, folderName, routePath, servicePort, tableHostName } from './names.ts';
import { frontLines, safePath, type Host, type HostsConfig, type KindCtx, type Route, type RouteBase, type RouteKind } from './render.ts';

export type FolderGate = { dir: string };
export type ProxyRoute = RouteBase & { kind: 'proxy'; port: number; websockets: boolean };

const HEAD = '# Written by the panel\'s routing helper (docs/phase8-plan.md 8-7). Changes here are overwritten.\n';

const gateDir = (cfg: HostsConfig) => safePath(cfg.folderGate!.dir, 'gate snippets folder');
const uriLine = (cfg: HostsConfig, indent: string) => `${indent}include ${gateDir(cfg)}/uri.conf;`;
const logLines = (cfg: HostsConfig) => {
  const logs = safePath(cfg.logs, 'log folder');
  const name = cfg.logName ?? 'lfdln-hosts';
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`hosts: "${name}" can't name a log`);
  return [`    access_log ${logs}/${name}.access.log;`, `    error_log  ${logs}/${name}.error.log;`];
};
// both ports in one block, as the hand-kept file has them (Cloudflare in front)
function listenBoth(cfg: HostsConfig): string[] {
  const l = cfg.listen ?? { http: '80', https: '443', v6: true };
  return [`    listen ${l.http};`, ...(l.v6 ? ['    listen [::]:80;'] : []), `    listen ${l.https} ssl;`, ...(l.v6 ? ['    listen [::]:443 ssl;'] : [])];
}
function tls(cfg: HostsConfig): string[] {
  return [
    `    ssl_certificate     ${safePath(cfg.tls.cert, 'certificate')};`,
    `    ssl_certificate_key ${safePath(cfg.tls.key, 'certificate key')};`,
    ...(cfg.tls.include ?? []).map((i) => `    include ${safePath(i, 'TLS include')};`),
    ...(cfg.tls.dhparam ? [`    ssl_dhparam ${safePath(cfg.tls.dhparam, 'DH parameters')};`] : []),
  ];
}
const WELL_KNOWN = ['    location ^~ /.well-known/ {', '        auth_request off;', '        allow all;', '    }'];
const HIDDEN = ['    location ~ /\\. {', '        auth_request off;', '        deny all;', '    }'];
// the gate's own, from the base on: every location from here on is asked about, or says
// auth_request off (gate.conf's rule -- one with neither gets the gate's 403, never content)
const gateLines = (cfg: HostsConfig, base: string) => [`    set $pammy_base ${base};`, `    include ${gateDir(cfg)}/gate.conf;`];

// ---------------------------------------------------------------- the kinds

// The whole website at a host's top (pammy.org and www): every site folder at /<folder>/.
export const siteKind: RouteKind = {
  kind: 'site',
  accounts: false,
  fields: () => ({}),
  describe: () => 'the whole website',
  locations: (ctx, r) => {
    if (!ctx.cfg.folderGate) throw new Error('hosts: the whole website is only shown where the gate looks at folders');
    if (routePath(r.path) !== '/') throw new Error('hosts: the whole website is only ever at the top of a host');
    return ['    location / {', uriLine(ctx.cfg, '        '), '        try_files $uri $uri/ =404;', '    }'];
  },
};

// A program on 127.0.0.1 (P8-14): pammy.org's /api/ to pamela-app. No gate: the program
// has its own sign-ins. A plain prefix location, as the hand-kept file's, so the site's
// hidden-file deny still comes first.
export const proxyKind: RouteKind = {
  kind: 'proxy',
  accounts: false,
  fields: (r) => {
    if (typeof r.port !== 'number') throw new Error('a proxy\'s port is missing.');
    if (typeof r.websockets !== 'boolean') throw new Error('websockets is not true or false.');
    return { port: r.port, websockets: r.websockets };
  },
  describe: (r) => `a program on 127.0.0.1:${r.port}${r.websockets ? ' (websockets)' : ''}`,
  locations: (ctx, r) => {
    const port = servicePort(r.port);
    if ((ctx.cfg.reservedPorts ?? []).includes(port)) throw new Error(`hosts: ${port} is the panel's own, never a route's`);
    const path = routePath(r.path);
    if (path === '/') throw new Error('hosts: a program is shown at a path, not at the top of a host');
    return [
      `    location ${path} {`,
      '        auth_request off;',
      `        proxy_pass http://127.0.0.1:${port};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host              $host;',
      '        proxy_set_header X-Real-IP         $remote_addr;',
      '        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      ...((r as ProxyRoute).websockets ? ['        proxy_set_header Upgrade           $http_upgrade;', '        proxy_set_header Connection        "upgrade";'] : []),
      '    }',
    ];
  },
};

// ---------------------------------------------------------------- a host

// The folder-404 rule (pammy.org/recipes/nope: the folder's own 404.html, else hers). A
// regex outranks a plain prefix, so the plain prefixes on this host (the /api/ proxy) are
// kept out of it by name; ^~ ones never meet it.
function siteTail(prefixes: string[]): string[] {
  const not = prefixes.map((p) => `(?!${p.slice(1).replace(/[.]/g, '\\.')})`).join('');
  return [
    '    error_page 404 /404.html;',
    `    location ~ "^/${not}(?<folder>[^/.]+)/" {`,
    '        include @URI@;',
    '        try_files $uri $uri/ =404;',
    '        error_page 404 @folder_404;',
    '        # a location\'s own error_page hides the server\'s, so the gate\'s sign-in redirect again',
    '        error_page 401 = @pammy_login;',
    '    }',
    '    location @folder_404 {',
    '        try_files /$folder/404.html /404.html =404;',
    '    }',
  ];
}

// A site folder's 404 lines (<folder>.pammy.org/nope): its own 404.html, else the site's.
function folderTail(cfg: HostsConfig): string[] {
  return [
    '    error_page 404 /404.html;',
    '    location = /404.html {',
    '        internal;',
    uriLine(cfg, '        '),
    '        try_files /404.html @pammy_404;',
    '    }',
    '    location @pammy_404 {',
    `        root ${safePath(cfg.sitesRoot, 'site folders root')};`,
    '        try_files /404.html =404;',
    '    }',
  ];
}

export function renderGatedHost(cfg: HostsConfig, host: Host, names: string, on: Route[], kinds: Map<string, RouteKind>,
  ctxOf: (k: RouteKind) => KindCtx): string {
  const name = tableHostName(host.name);
  const top = on.find((r) => routePath(r.path) === '/');
  const whole = top?.kind === 'site' ? top : null;
  const folder = top?.kind === 'folder' ? top : null;
  for (const r of on) {
    if (r.accounts) throw new Error(`hosts: ${routePath(r.path)} on ${name}: here protected folders are folders, and routes have no accounts`);
    if (r.kind === 'folder' && routePath(r.path) !== '/') throw new Error(`hosts: a site folder is shown at the top of a host here (${name}${routePath(r.path)}); the whole website shows every folder at /<folder>/`);
  }
  const root = safePath(cfg.sitesRoot, 'site folders root');
  const lines: string[] = [HEAD, 'server {', ...listenBoth(cfg), `    server_name ${names};`, ...tls(cfg), ...frontLines(cfg), ''];
  let base: string | null = null;
  if (whole) { lines.push(`    root ${root};`, '    index index.html;'); base = '/'; }
  if (folder) {
    const f = folderName(folder.folder);
    if (!ctxOf(kinds.get('folder')!).folders.has(f)) throw new Error(`hosts: ${name} shows site folder "${f}", which isn't there`);
    lines.push(`    root ${root}/${f};`, '    index index.html;');
    base = `/${f}`;
  }
  lines.push('', ...logLines(cfg), '');
  if (base) lines.push(...gateLines(cfg, base), '');
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const r of on) {
    const k = kinds.get(r.kind)!;
    const path = routePath(r.path);
    if (seen.has(path)) throw new Error(`hosts: ${name} has two routes at ${path}`);
    seen.add(path);
    if (r.kind === 'proxy') prefixes.push(path);
    lines.push(`    # ${path}: ${k.describe(r)}`);
    if (r.kind === 'folder') lines.push('    location / {', uriLine(cfg, '        '), '        try_files $uri $uri/ =404;', '    }');
    else lines.push(...k.locations(ctxOf(k), r));
    lines.push('');
  }
  if (!top) lines.push('    location / {', '        auth_request off;', '        return 404;', '    }', '');
  if (base) lines.push(...WELL_KNOWN);
  lines.push(...HIDDEN);
  if (whole) lines.push('', ...siteTail(prefixes).map((l) => l.replace('@URI@', `${gateDir(cfg)}/uri.conf`)));
  if (folder) lines.push('', ...folderTail(cfg));
  lines.push('}', '');
  return lines.join('\n');
}

// Folder hosts (the domain's folder_hosts): any <label>.<domain> but www and api that no
// host has is the site folder of that name, as the hand-kept regex block has always done.
// The name is one label of [a-z0-9-] -- no dot, no slash -- which is what makes it safe
// in a path.
export function renderFolderCatchAll(cfg: HostsConfig): string {
  const d = domainName(cfg.domain).replace(/\./g, '\\.');
  const root = safePath(cfg.sitesRoot, 'site folders root');
  return [
    HEAD,
    `# Any other <folder>.${cfg.domain}: the site folder of that name (folder hosts). The hosts`,
    '# have exact server_names, which nginx prefers.',
    'server {', ...listenBoth(cfg),
    `    server_name "~^(?!(?:www|api)\\.)(?<sub>[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\\.${d}$";`,
    ...tls(cfg), ...frontLines(cfg), '',
    `    root ${root}/$sub;`,
    '    index index.html;',
    '', ...logLines(cfg), '',
    ...gateLines(cfg, '/$sub'), '',
    '    location / {', uriLine(cfg, '        '), '        try_files $uri $uri/ =404;', '    }', '',
    ...folderTail(cfg), '',
    ...WELL_KNOWN, ...HIDDEN,
    '}', '',
  ].join('\n');
}

