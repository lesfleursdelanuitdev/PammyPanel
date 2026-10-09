// Is this request allowed? The whole of the gate's security decision lives here.
//
// nginx hands over the path it is about to serve ($uri: decoded, dot segments
// resolved) plus which folder the hostname maps to. The decision is made on
// the REAL path on disk, so a shortcut (symlink) into a protected folder is
// protected too, and a missing page inside a protected folder asks for a login
// instead of revealing that it doesn't exist.
//
// A folder is protected if EITHER
//   - it contains a .pammy-protected marker (which moves with the folder when
//     she renames it in WinSCP), or
//   - the gate's database lists its path (which survives the marker being deleted).
// A marker the database doesn't know locks the folder for everyone.
//
// Nothing here waits for Postgres: the areas come from memory (live.ts), and who
// is signed in, with the folders they may open, is looked up beforehand.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Access, AreaLookup } from '@panel/core/gate/live';
import { AREA_TOKEN_RE, MARKER, openToAll, type Area } from '@panel/core/gate/store';

export type Protection = {
  area: Area | null;         // null: marker with a token the database doesn't know (locked)
  token: string | null;
  dir: string;               // real directory on disk
  rel: string;               // that directory relative to the web root
  exempt: boolean;           // this request is one of the area's own sign-in pages, or a look file in its login-files
};

export type Resolved =
  | { kind: 'outside' }                                  // real path is outside the web root: not ours
  | { kind: 'unreadable' }                               // can't look: fail closed
  | { kind: 'ok'; real: string; exists: boolean; protections: Protection[] };

// The pages anyone can open inside a protected folder, before signing in. The
// names are exact and mostly start with "login", so a page she already has (say,
// a party invite.html) never becomes public by accident. logout.html is the one
// exception (momolig's choice of name): it has to open for someone who has just
// signed out, and a sign-out page holds nothing private. Each one she deletes
// falls back to a built-in page at /_pammy/<kind>.
export const PAGES = {
  login: 'login.html',
  forgot: 'login-forgot.html',
  invite: 'login-invite.html',
  request: 'login-request.html',
  logout: 'logout.html',
} as const;
export type PageKind = keyof typeof PAGES;
export const PAGE_KINDS = Object.keys(PAGES) as PageKind[];
export const PAGE_FILES: ReadonlySet<string> = new Set(Object.values(PAGES));
// A folder's home page: index.html, or index.php (docs/tutorials-plan.md P1 --
// nginx tries them in that order, deploy/nginx/php.conf)
export const HOMES = ['index.html', 'index.php'];
const LOGIN_FILES = 'login-files';
// What the sign-in pages may use from login-files before anyone signs in: style,
// picture and font files directly inside it. Anything else there (a page, a
// document, a subfolder and all in it) is as private as the rest of the folder.
export const LOOK_FILE_RE = /^[^.][^/]*\.(css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;

export function readMarker(dir: string): { present: boolean; token: string | null } {
  let text: string;
  try {
    text = readFileSync(join(dir, MARKER), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { present: false, token: null };
    return { present: true, token: null };   // exists but unreadable: locked
  }
  const m = text.trim().match(/^pammy-protected ([A-Za-z0-9_-]+)$/);
  return { present: true, token: m && AREA_TOKEN_RE.test(m[1]!) ? m[1]! : null };
}

export function markerText(token: string): string {
  return `pammy-protected ${token}\n`;
}

// uri: what nginx will serve, relative to the web root (base already prepended).
// Throws PgUnavailable if the areas aren't known yet (the gate started before
// Postgres, with no saved copy): nothing is let through on a guess.
export function resolve(areas: AreaLookup, publicRoot: string, uri: string): Resolved {
  if (!uri.startsWith('/') || uri.includes('\0')) return { kind: 'unreadable' };
  const parts = uri.split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) return { kind: 'unreadable' };

  let root: string;
  try { root = realpathSync(publicRoot); } catch { return { kind: 'unreadable' }; }

  // The deepest part of the path that exists, resolved through any symlinks.
  let real: string | null = null;
  let exists = false;
  for (let n = parts.length; n >= 0; n--) {
    try {
      real = realpathSync(join(root, ...parts.slice(0, n)));
      exists = n === parts.length;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { kind: 'unreadable' };
    }
  }
  if (real === null) return { kind: 'unreadable' };
  if (real !== root && !real.startsWith(root + sep)) return { kind: 'outside' };

  let dir: string;
  try { dir = statSync(real).isDirectory() ? real : dirname(real); } catch { return { kind: 'unreadable' }; }

  const relParts = relative(root, dir).split(sep).filter((p) => p !== '');
  const protections: Protection[] = [];
  for (let i = 0; i <= relParts.length; i++) {
    const rel = relParts.slice(0, i).join('/');
    const d = join(root, ...relParts.slice(0, i));
    // a page is exempt only as a file directly in that folder (a directory called login.html isn't)
    const exempt = exists && real !== dir && (
      (dirname(real) === d && PAGE_FILES.has(basename(real)))
      || (dirname(real) === join(d, LOGIN_FILES) && LOOK_FILE_RE.test(basename(real))));
    const marker = readMarker(d);
    const byMarker = marker.token ? areas.byToken(marker.token) ?? null : null;
    if (marker.present) protections.push({ area: byMarker, token: marker.token, dir: d, rel, exempt });
    // The database's record for this path counts too, unless it's the same area
    // the marker named (a folder renamed onto another's old name needs both).
    const byPath = rel !== '' ? areas.byPath(rel) : undefined;
    if (byPath && byPath.id !== byMarker?.id) protections.push({ area: byPath, token: byPath.token, dir: d, rel, exempt });
    // A site folder (the top, on a site with hosts) shown by a route with accounts: that
    // route's area protects all of it, wherever else it is shown (docs/phase8-plan.md
    // P8-4). No sign-in page of the folder's own is exempt: a route has none.
    if (i === 1 && areas.routeAreasOf) {
      for (const a of areas.routeAreasOf(rel)) protections.push({ area: a, token: a?.token ?? null, dir: d, rel, exempt: false });
    }
  }
  return { kind: 'ok', real, exists, protections };
}

export type Decision =
  // area: the innermost protected folder it is in, whose role says what the
  // visitor may do there (docs/roles-plan.md step 3); null outside them
  | { allow: true; protectedContent: boolean; area: Area | null }
  | { allow: false; reason: 'login' | 'denied' | 'locked'; protection: Protection }
  | { allow: false; reason: 'unreadable' };

// Whether this request needs to know who is signed in: only when a protection
// applies to it. Everything else is decided without asking Postgres anything.
export function needsVisitor(r: Resolved): boolean {
  return r.kind === 'ok' && r.protections.some((p) => !p.exempt && p.area);
}

export function decide(r: Resolved, access: Access | null): Decision {
  if (r.kind === 'outside') return { allow: true, protectedContent: false, area: null };
  if (r.kind === 'unreadable') return { allow: false, reason: 'unreadable' };
  let area: Area | null = null;
  for (const p of r.protections) {
    if (p.exempt) continue;
    if (!p.area) return { allow: false, reason: 'locked', protection: p };
    // a folder whose "not signed in" slot opens the pages is open to anyone
    // (only with the roles switch on can that slot be given anything: Q3)
    if (!openToAll(p.area)) {
      if (!access) return { allow: false, reason: 'login', protection: p };
      if (!access.opens.has(p.area.id)) return { allow: false, reason: 'denied', protection: p };
    }
    area = p.area;
  }
  return { allow: true, protectedContent: r.protections.length > 0, area };
}

// Where to send someone who needs to sign in, as a path on the hostname they
// used. base is "" for pammy.org and "/<folder>" for <folder>.pammy.org.
export function loginUrl(p: Protection, base: string, next: string, reason: string): string {
  const q = new URLSearchParams({ next });
  if (reason === 'denied') q.set('denied', '1');
  return pageUrl(p, base, 'login', q);
}

// The folder's own page of that kind if it has one reachable on this hostname,
// else the built-in one (which names the area so it knows which folder).
export function pageUrl(p: Pick<Protection, 'dir' | 'rel' | 'token'> & { area?: Area | null }, base: string, kind: PageKind, q = new URLSearchParams()): string {
  const file = PAGES[kind];
  // a route's area (docs/roles-plan.md step 5; its path starts with "/") has no
  // folder, so no pages of its own: always the built-in ones
  const onThisHost = p.rel.startsWith('/') || p.area?.kind === 'route' ? null : pathOnHost(p.rel, base);
  let hasPage = false;
  try { hasPage = lstatSync(join(p.dir, file)).isFile(); } catch { /* none */ }
  if (onThisHost !== null && hasPage && p.token) {
    return `${encodePath(onThisHost)}/${file}${q.size ? `?${q}` : ''}`;
  }
  if (p.token) q.set('area', p.token);
  return `/_pammy/${kind}${q.size ? `?${q}` : ''}`;
}

// A folder's path on a hostname: base "" is pammy.org, "/<folder>" is
// <folder>.pammy.org. null when the folder isn't under that subdomain.
export function pathOnHost(rel: string, base: string): string | null {
  const logical = `/${rel}`;
  return base === '' ? logical : logical === base ? '' : logical.startsWith(`${base}/`) ? logical.slice(base.length) : null;
}

// Where to land after signing in: the folder's front page on this hostname.
export function folderHome(rel: string, base: string): string {
  const onThisHost = rel.startsWith('/') ? null : pathOnHost(rel, base);   // (a route's area: the host's top)
  return onThisHost === null ? '/' : `${encodePath(onThisHost)}/`;
}

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// A redirect target after signing in: a path on this same hostname, nothing else.
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string' || next.length > 2000) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) return null;
  return next;
}
