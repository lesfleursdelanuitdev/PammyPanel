// What may be a host, a site folder, a route's path and a redirect's address
// (docs/hosts-plan.md H1, H5, H6). Each of these ends up inside an nginx file, so
// the rules are narrow on purpose: nothing that could close a string, end a
// directive or name a variable ($, ", ', ;, {, }, spaces) can pass any of them.
// The database's checks (migrations/0001-hosts.sql) say the same for names and
// paths; the renderer (render.ts) asks again before it writes anything.

// One DNS label: a-z, 0-9 and hyphens, 1-63, no hyphen at either end. A host is
// <label>.<domain>; a site folder is a folder of that name.
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Names nobody may take as a host: the panel's own (git: projects' git over HTTPS, 8b-7), and the ones every domain
// keeps (docs/platform-plan.md G3). Names with their own record at DreamHost
// (webmail, ftp, ...) are refused too, from the zone (the routing helper, H6).
export const RESERVED_HOSTS = ['panel', 'www', 'api', 'mail', 'git'] as const;

export class NameError extends Error {}

// A domain (docs/domains-hosts-plan.md step 1): two or more DNS labels, the last one
// starting with a letter; lowercase, at most 253 characters.
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function domainName(v: unknown): string {
  const t = typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : '';
  if (t.length > 253 || !DOMAIN_RE.test(t)) throw new NameError('A domain is a name like example.com: lowercase letters, digits, hyphens and dots.');
  return t;
}

export function hostName(v: unknown): string {
  if (typeof v !== 'string' || !LABEL_RE.test(v)) {
    throw new NameError('A host is one name: lowercase letters, digits and hyphens, 1-63 of them, not starting or ending with a hyphen.');
  }
  if ((RESERVED_HOSTS as readonly string[]).includes(v)) throw new NameError(`${v} is kept for the server itself.`);
  return v;
}

export function folderName(v: unknown): string {
  if (typeof v !== 'string' || !LABEL_RE.test(v)) {
    throw new NameError('A site folder\'s name is lowercase letters, digits and hyphens, 1-63 of them, not starting or ending with a hyphen.');
  }
  return v;
}

// A route's path: "/" or "/docs/" or "/a/b/", each part letters, digits, "-",
// "_", "~" and ".", never starting with a dot (no "..", no hidden folders).
const PATH_RE = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,99}\/){0,8}$/;
export function routePath(v: unknown): string {
  let p = typeof v === 'string' ? v.trim() : '';
  if (p === '') p = '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  if (!PATH_RE.test(p)) throw new NameError('A path is "/" or like "/docs/": letters, digits, "-", "_", "~" and ".", and no part starting with a dot.');
  // where the panel calls its apps (docs/accounts-plan.md step 4b; nginx answers 404 there)
  if (p.startsWith('/_lfdln/')) throw new NameError('/_lfdln/ is kept for the panel\'s calls to its apps.');
  return p;
}

// Where a redirect goes: an address on the web (https:// or http://, a host
// name, maybe a port and a path), or a path on the same host. Query strings and
// fragments are left out: the visitor's own query goes along when the path does.
const URL_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%!*()+,=:@/-]*)?$/;
// (never "//...": a browser reads that as another site)
const LOCAL_RE = /^\/(?!\/)[A-Za-z0-9._~%!*()+,=:@/-]*$/;
export function redirectTo(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length > 500 || !(URL_RE.test(t) || LOCAL_RE.test(t)) || t.includes('/../') || t.endsWith('/..')) {
    throw new NameError('A redirect goes to an address like https://example.com/page, or a path like /page.');
  }
  return t;
}

export function redirectStatus(v: unknown): 301 | 302 {
  if (v === 301 || v === 302) return v;
  throw new NameError('A redirect is permanent (301) or temporary (302).');
}

// ---------------------------------------------------------------- phase 6 (docs/adopt-plan.md)

// The domain itself, as a host (V2): "@", served with www beside it when asked.
// Taking over what is already there makes it, and since 7-6 the Hosts page too;
// www is never a host of its own.
export const APEX = '@';
export function tableHostName(v: unknown): string {
  return v === APEX ? APEX : hostName(v);
}

// A host made on the Hosts page (docs/domains-hosts-plan.md 7-6): "@" (the domain itself)
// too now, on any domain. The server's names stay kept on every domain (the renderer
// refuses them anywhere); www is only ever beside "@".
export function newHostName(v: unknown): string {
  if (v === APEX) return APEX;
  if (v === 'www') throw new NameError('www is never a host of its own: make "@" (the domain itself) with www beside it.');
  return hostName(v);
}

// A service's id and a part's id: one label, as the services helper's record has
// them (docs/adopt-plan.md V7).
const SERVICE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function serviceId(v: unknown, what = 'A service'): string {
  if (typeof v !== 'string' || !SERVICE_RE.test(v)) throw new NameError(`${what} is named with lowercase letters, digits and hyphens.`);
  return v;
}

// Where a service answers: a port on 127.0.0.1, above the ones only root may open.
export function servicePort(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 || v > 65535) throw new NameError('A service answers on a port from 1024 to 65535.');
  return v;
}

// The largest upload a route takes, in MB (nginx's own default, 1, when none is set).
export function maxBodyMb(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1024) throw new NameError('The largest upload is a whole number of MB, from 1 to 1024.');
  return v;
}

// A sign-in path (V3): "/api/auth/sign-in" (it and everything under it) or
// "=/api/auth/login" (exactly that address). Letters, digits and "-_.~/", no
// part starting with a dot, no "//".
const SIGN_IN_RE = /^=?\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,99}\/?){0,12}$/;
export function signInPath(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length > 300 || !SIGN_IN_RE.test(t) || t.includes('//')) throw new NameError('A sign-in path is like /api/auth/sign-in, or =/api/auth/login for exactly that address.');
  return t;
}

// Response headers on a folder route (V4). Only these names, and values that can't
// close nginx's quotes, name a variable or start a new line.
export const HEADER_NAMES = [
  'Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy',
  'Cross-Origin-Opener-Policy', 'Permissions-Policy', 'Strict-Transport-Security',
  // (a project's dev preview sends it: docs/phase8b-plan.md D3-7)
  'X-Robots-Tag',
] as const;
const HEADER_VALUE_RE = /^[A-Za-z0-9 '\-_.:/;=,()*@+]{1,2000}$/;
export type Header = { name: string; value: string };
export function header(v: unknown): Header {
  const h = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const name = HEADER_NAMES.find((n) => typeof h.name === 'string' && n.toLowerCase() === h.name.toLowerCase());
  if (!name) throw new NameError(`A header is one of: ${HEADER_NAMES.join(', ')}.`);
  if (typeof h.value !== 'string' || !HEADER_VALUE_RE.test(h.value) || h.value.trim() !== h.value) {
    throw new NameError(`${name}'s value may have letters, digits, spaces and ' - _ . : / ; = , ( ) * @ +, and nothing else.`);
  }
  return { name, value: h.value };
}
