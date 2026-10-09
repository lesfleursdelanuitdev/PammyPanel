// A route to a service (docs/adopt-plan.md V3; docs/domains-hosts-plan.md step 2, D-4):
// the services module's kind of target. The route names a service and one of its parts;
// the port comes from the services helper's record (the table's `services`, which the
// routing helper checks against that record again), never from the route. With
// websockets, the largest upload, and sign-in addresses behind the sign-in rate limit.
//
// A host with a service answers 404 at /_lfdln/ from outside: that is where the panel
// calls its apps ("this account was deleted", docs/accounts-plan.md step 4b), straight on
// 127.0.0.1.
import { maxBodyMb, routePath, serviceId, servicePort, signInPath } from '@panel/hosts/names';
import { appCookieLine, FIELDS, gateLines, identityOf, proofLine, safePath, tokenOf, type HostsConfig, type Route, type RouteBase, type RouteKind, type ServicePart, type Table } from '@panel/hosts/render';

export type ServiceRoute = RouteBase & { kind: 'service'; service: string; part: string; websockets: boolean; maxBodyMb: number | null; signInPaths: string[] };

const PROXY_LINES = [
  'proxy_http_version 1.1;',
  'proxy_set_header Host $host;',
  'proxy_set_header X-Real-IP $remote_addr;',
  'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  'proxy_set_header X-Forwarded-Proto $scheme;',
];

// the table's services, by "service/part", each once
function partsOf(_cfg: HostsConfig, t: Table): Map<string, ServicePart> {
  const parts = new Map<string, ServicePart>();
  for (const p of t.services ?? []) {
    const key = `${serviceId(p.service)}/${serviceId(p.part, 'A part')}`;
    if (parts.has(key)) throw new Error(`hosts: service ${key} is there twice`);
    parts.set(key, { ...p, port: servicePort(p.port) });
  }
  return parts;
}

// A part's folders from disk (docs/domains-hosts-plan.md step 7, 7-2), each checked again:
// a plain path inside the route's, a folder under the roots root allows.
function servedLines(cfg: HostsConfig, path: string, key: string, taken: Set<string>): string[] {
  const out: string[] = [];
  const roots = cfg.served?.roots ?? [];
  for (const f of cfg.served?.folders[key] ?? []) {
    const at = routePath(f.path);
    if (!at.startsWith(path) || at === path) throw new Error(`hosts: ${key}'s folder at ${at} isn't inside ${path}`);
    const dir = `${safePath(f.dir, 'served folder')}/`;
    if (!roots.some((r) => r.startsWith('/') && r.endsWith('/') && dir.startsWith(r) && dir !== r)) throw new Error(`hosts: ${key}'s folder ${dir} isn't under ${roots.join(' or ') || 'a folder this site allows'}`);
    if (!Number.isInteger(f.days) || f.days < 1 || f.days > 365) throw new Error(`hosts: ${key}'s folder at ${at} is cached 1 to 365 days`);
    if (taken.has(`^~ ${at}`)) throw new Error(`hosts: ${at} is there twice`);
    taken.add(`^~ ${at}`);
    out.push(`    location ^~ ${at} {`, `        alias ${dir};`, '        access_log off;', `        expires ${f.days}d;`,
      '        add_header Cache-Control "public, immutable";', '        location ~ /\\. { deny all; }', '    }');
  }
  return out;
}

// the app its proofs are made out to (docs/s1-plan.md S1a): in the check nginx makes, and in
// gate-routes.json, so the gate signs it only on this route's area
const serviceAudience = (r: ServiceRoute) => `service.${serviceId(r.service)}.${serviceId(r.part, 'A part')}`;

function serviceLocation(cfg: HostsConfig, r: ServiceRoute, parts: Map<string, ServicePart>, taken: Set<string>): string[] {
  const path = routePath(r.path);
  const key = `${serviceId(r.service)}/${serviceId(r.part, 'A part')}`;
  const part = parts.get(key);
  if (!part) throw new Error(`hosts: ${path} goes to ${key}, which isn't a service here`);
  const port = servicePort(part.port);
  if ((cfg.reservedPorts ?? []).includes(port)) throw new Error(`hosts: ${key} can't be on port ${port}, which is the panel's own`);
  const body = maxBodyMb(r.maxBodyMb);
  const pass = `proxy_pass http://127.0.0.1:${port};`;
  const token = tokenOf(r);
  const id = identityOf(cfg);
  const inner = (ws: boolean) => [
    ...(token ? gateLines(cfg, token, '        ', serviceAudience(r)) : []),
    `        ${pass}`, ...PROXY_LINES.map((l) => `        ${l}`),
    // who is signed in, from the gate's answer; without accounts, nothing (and never what the visitor sent)
    ...FIELDS.map(([f]) => `        proxy_set_header ${id.header(f)} ${token ? id.v(f) : '""'};`),
    // ... and the gate's proof of it, for this service alone (docs/s1-plan.md S1a)
    proofLine(cfg, token, '        '),
    // the visitor's cookies without the gate's (docs/s1-plan.md S1e)
    ...appCookieLine(cfg, '        '),
    ...(ws ? ['        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";'] : []),
    ...(body ? [`        client_max_body_size ${body}m;`] : []),
  ];
  const out: string[] = [];
  if (path !== '/') out.push(`    location = ${path.slice(0, -1)} { return 301 ${path}; }`);
  // folders nginx serves itself, before the proxy (7-2): no accounts in front of them
  const files = servedLines(cfg, path, key, taken);
  if (files.length && token) throw new Error(`hosts: ${path} has accounts, but ${key}'s folders would be open to anyone`);
  out.push(...files);
  // sign-in addresses: the same service, with the sign-in rate limit in front
  for (const raw of r.signInPaths) {
    const s = signInPath(raw);
    if (!cfg.signInZone || !/^[a-z][a-z0-9_]{0,30}$/.test(cfg.signInZone)) throw new Error('hosts: this site has no sign-in rate limit, so a route can\'t have sign-in paths');
    const exact = s.startsWith('=');
    const at = exact ? s.slice(1) : s;
    if (!at.startsWith(path) || at === path) throw new Error(`hosts: sign-in path ${at} isn't inside ${path}`);
    const loc = exact ? `= ${at}` : `^~ ${at}`;
    if (taken.has(loc)) throw new Error(`hosts: ${at} is there twice`);
    taken.add(loc);
    out.push(`    location ${loc} {`, `        limit_req zone=${cfg.signInZone} burst=3 nodelay;`, ...inner(false), '    }');
  }
  out.push(`    location ^~ ${path} {`, ...inner(r.websockets), '    }');
  return out;
}

const words = (v: unknown, what: string) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) throw new Error(`${what} is not a list of words.`);
  return v as string[];
};

export const serviceKind: RouteKind = {
  kind: 'service',
  accounts: true,
  fields: (r) => {
    if (typeof r.service !== 'string') throw new Error('a route\'s service is missing.');
    if (typeof r.part !== 'string') throw new Error('a route\'s part is missing.');
    if (typeof r.websockets !== 'boolean') throw new Error('websockets is not true or false.');
    if (r.maxBodyMb !== null && typeof r.maxBodyMb !== 'number') throw new Error('The largest upload is a number or nothing.');
    return { service: r.service, part: r.part, websockets: r.websockets, maxBodyMb: r.maxBodyMb, signInPaths: words(r.signInPaths, 'signInPaths') };
  },
  prepare: partsOf,
  describe: (r) => `service ${r.service}/${r.part}`,
  audience: (r) => serviceAudience(r as ServiceRoute),
  locations: (ctx, r) => serviceLocation(ctx.cfg, r as ServiceRoute, ctx.state as Map<string, ServicePart>, ctx.taken),
  reserve: (ctx, on: Route[]) => {
    for (const r of on) if (routePath(r.path).startsWith('/_lfdln/')) throw new Error(`hosts: ${ctx.host} can't have a route at ${routePath(r.path)} (the panel's calls to its apps)`);
    ctx.taken.add('^~ /_lfdln/');
    return ['', "    # /_lfdln/: the panel's calls to its apps, never from outside", '    location ^~ /_lfdln/ { return 404; }'];
  },
};
