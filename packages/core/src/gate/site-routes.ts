// The site's routes as the gate reads them (docs/phase8-plan.md 8-2): on a site with
// hosts (lfdln), the routing helper writes gate-routes.json beside the host files, in
// the same apply as nginx's, so the gate and nginx never disagree about a route. The
// gate reads it again whenever it changes on disk.
//
// With it the gate knows
//   - every name a host answers to, on every domain (hostOf takes them all);
//   - what a page on a host is: a path in a site folder, or a service's page (no file);
//   - which routes with accounts show a site folder, so a folder behind a private
//     route is private to every "may this visitor see it" check (P8-4, policy.ts).
//
// A site without hosts (pammy.org) has none of this, and nothing changes for it. A
// site with hosts whose file can't be read (not written yet, or broken) fails
// closed: whatever needs a route answers "try again in a minute", never a guess.
import { readFileSync, statSync } from 'node:fs';
import { AUDIENCE_RE } from '../identity-proof.ts';
import { PgUnavailable } from '../pg.ts';

// audience: the app a route with accounts sends to, as the gate's proofs name it (docs/s1-plan.md)
export type SiteRoute = { path: string; kind: string; folder?: string; service?: string; area: string | null; audience?: string };
type Read = { domains: string[]; hosts: Map<string, SiteRoute[]>; byFolder: Map<string, string[]> };

// What a page on a host is (placeOf): a path in a site folder (base "/<folder>", path
// from there, both as pammy.org's gate has always had them), or a page some other kind
// of route answers (a service: no file behind it).
export type Place =
  | { kind: 'folder'; folder: string; base: string; path: string; route: SiteRoute }
  | { kind: 'other'; route: SiteRoute };

const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const FOLDER_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_RE = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

// The file as the helper wrote it, checked for its shape: anything else is refused whole.
export function parseSiteRoutes(text: string): Read {
  const j = JSON.parse(text) as { v?: unknown; domains?: unknown; hosts?: unknown };
  if (j.v !== 1 || !Array.isArray(j.domains) || !j.hosts || typeof j.hosts !== 'object') throw new Error('not a routes file');
  const domains = j.domains.map((d) => {
    if (typeof d !== 'string' || !NAME_RE.test(d)) throw new Error('a domain that is not one');
    return d;
  });
  const hosts = new Map<string, SiteRoute[]>();
  const byFolder = new Map<string, string[]>();
  for (const [name, list] of Object.entries(j.hosts as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || !Array.isArray(list)) throw new Error('a host that is not one');
    const routes = list.map((r: Record<string, unknown>): SiteRoute => {
      if (typeof r?.path !== 'string' || !PATH_RE.test(r.path) || typeof r.kind !== 'string') throw new Error('a route that is not one');
      if (r.area !== null && (typeof r.area !== 'string' || !TOKEN_RE.test(r.area))) throw new Error('an area that is not one');
      if (r.kind === 'folder' && (typeof r.folder !== 'string' || !FOLDER_RE.test(r.folder))) throw new Error('a folder that is not one');
      if (r.audience !== undefined && (typeof r.audience !== 'string' || !AUDIENCE_RE.test(r.audience) || r.area === null)) throw new Error('an app that is not one');
      return {
        path: r.path, kind: r.kind, area: r.area as string | null,
        ...(r.kind === 'folder' ? { folder: r.folder as string } : {}),
        ...(typeof r.service === 'string' ? { service: r.service } : {}),
        ...(typeof r.audience === 'string' ? { audience: r.audience } : {}),
      };
    });
    // longest path first: the route a page is on is the deepest one it is under
    routes.sort((a, b) => b.path.length - a.path.length);
    hosts.set(name, routes);
    for (const r of routes) {
      if (r.kind !== 'folder' || !r.area) continue;
      const tokens = byFolder.get(r.folder!) ?? [];
      if (!tokens.includes(r.area)) tokens.push(r.area);
      byFolder.set(r.folder!, tokens);
    }
  }
  return { domains, hosts, byFolder };
}

export class SiteRoutes {
  readonly file: string;
  #read: Read | null = null;
  #seen = '';            // the file's stat when it was last looked at
  #text = '';            // ... and what it said, when it was read well
  #at = 0;               // when it was last read (ms)
  #log: (line: string) => void;

  constructor(file: string, log: (line: string) => void = () => {}) {
    this.file = file;
    this.#log = log;
  }

  // The file as it is now: read again when its stat changed, and at least every 2 s
  // (a rewrite of the same size within one clock tick keeps its stat). A copy that
  // can't be read (being written just now, say) leaves the last good one in place;
  // with none, throws.
  #now(): Read {
    let key = '';
    try {
      const st = statSync(this.file);
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch { /* gone: keep the last good copy, if any */ }
    const t = Date.now();
    if (key && (key !== this.#seen || t - this.#at >= 2000 || !this.#read)) {
      this.#seen = key;
      this.#at = t;
      try {
        const text = readFileSync(this.file, 'utf8');
        if (text !== this.#text || !this.#read) {
          this.#read = parseSiteRoutes(text);
          this.#text = text;
        }
      } catch (e) {
        this.#seen = '';
        this.#log(`gate: the routes (${this.file}) couldn't be read: ${(e as Error).message}`);
      }
    }
    if (!this.#read) throw new PgUnavailable('the routes are not known yet');
    return this.#read;
  }

  get known(): boolean {
    try { this.#now(); return true; } catch { return false; }
  }

  // A name some host answers to (any domain); false while the routes aren't known.
  hasHost(host: string): boolean {
    try { return this.#now().hosts.has(host); } catch { return false; }
  }

  // The route a page on this host is on, and where that puts it; null: no route there.
  placeOf(host: string, path: string): Place | null {
    const routes = this.#now().hosts.get(host);
    if (!routes || !path.startsWith('/')) return null;
    const r = routes.find((x) => path === x.path.slice(0, -1) || path.startsWith(x.path));
    if (!r) return null;
    if (r.kind !== 'folder') return { kind: 'other', route: r };
    const rest = path.length < r.path.length ? '/' : `/${path.slice(r.path.length)}`;
    return { kind: 'folder', folder: r.folder!, base: `/${r.folder}`, path: rest, route: r };
  }

  // Whether this host has a route with this area that sends to this app (docs/s1-plan.md
  // S1a): the only check the gate signs a proof for. Throws while the routes aren't known.
  hasAudience(host: string, area: string, audience: string): boolean {
    return (this.#now().hosts.get(host) ?? []).some((r) => r.area === area && r.audience === audience);
  }

  // The area tokens of the routes with accounts that show this site folder (P8-4).
  areasOverFolder(folder: string): string[] {
    return this.#now().byFolder.get(folder) ?? [];
  }

  // Where a site folder is shown: each host and the path of the route that shows it,
  // the home domain's hosts first, then by name (a file's address in the media API).
  shownAt(folder: string): { host: string; path: string }[] {
    const r = this.#now();
    const home = r.domains[0] ?? '';
    const out: { host: string; path: string }[] = [];
    for (const [host, routes] of r.hosts) for (const x of routes) if (x.kind === 'folder' && x.folder === folder) out.push({ host, path: x.path });
    const rank = (h: string) => (h === home ? 0 : h.endsWith(`.${home}`) ? 1 : 2);
    return out.sort((a, b) => rank(a.host) - rank(b.host) || a.host.localeCompare(b.host) || a.path.localeCompare(b.path));
  }
}
