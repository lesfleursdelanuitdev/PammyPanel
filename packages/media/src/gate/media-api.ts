// The media API (docs/media-api-plan.md): her pages ask for "olivia's files tagged
// summer and in the category travel" and draw them; programs ask with a key.
//
//   GET /_pammy/api/media/main/t/<tag>/c/<category>...   the main site's media folder
//   GET /_pammy/api/media/in/<folder>/t/<tag>...          a folder's media folder
//   GET /_pammy/api/media/in/<folder>/all                  every file there (key only)
//   GET /_pammy/api/media/in/<folder>/labels               its tags and categories
//   GET /_pammy/api/media/example/...                      the built-in example folder (M11)
//   GET /_pammy/media-thumbs/<id>-<hash>.webp              a listed picture's small version
//
// Filters are every t/<name> and c/<name> in the path, plus ?tags= and
// ?categories= (comma-separated, or repeated tag= / category=). A file must
// have every one. The path after the folder may be empty when the query has
// labels: /_pammy/api/media/in/olivia?tags=dogs,cats&categories=pets.
//
// What it knows comes from the panel's published index (media-public.ts), opened
// read-only and reopened when the panel replaces it. Without a key: only labels
// the panel made public (M5), only the public ones in answers, and nothing inside
// a protected folder unless this visitor is signed in to it (M7).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from '@panel/core/security';
import type { ApiKey } from '@panel/api-keys/gate/forms/api-keys';
import { decide, encodePath, pathOnHost, resolve } from '@panel/areas/gate/policy';
import type { Access, AreaLookup } from '@panel/core/gate/live';
import type { SiteRoutes } from '@panel/core/gate/site-routes';

const LABEL_RE = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_RE = /^[^/\\\x00-\x1f\x7f.][^/\\\x00-\x1f\x7f]{0,199}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KINDS = ['images', 'audio', 'video', 'files'];
export const EXAMPLE_SCOPE = '/:example';                 // can't be a folder: folders don't start with ":"
export const EXAMPLE_FILES_URL = '/_pammy/examples/media-demo/';

type FileRow = {
  id: number; path: string; scope: string; kind: string; name: string; size: number; modified_at: number; added_at: number;
  title: string | null; alt: string | null; thumb: string | null; thumb_width: number | null; thumb_height: number | null;
};
type LabelRow = { type: 'tag' | 'category'; id: number; scope: string; name: string; public: number };

// ------------------------------------------------------------------ the index
// Opened read-only; a new one (a new file renamed into place) is noticed by its
// inode and opened instead. A missing index is an empty one.
export class MediaIndex {
  readonly path: string;
  #db: DatabaseSync | null = null;
  #ino = -1;
  #mtime = -1;
  constructor(path: string) { this.path = path; }

  get(): DatabaseSync | null {
    let st;
    try { st = statSync(this.path); } catch { this.#close(); return null; }
    if (!this.#db || st.ino !== this.#ino || st.mtimeMs !== this.#mtime) {
      this.#close();
      try { this.#db = new DatabaseSync(this.path, { readOnly: true }); } catch { return null; }
      this.#ino = st.ino;
      this.#mtime = st.mtimeMs;
    }
    return this.#db;
  }

  #close() {
    try { this.#db?.close(); } catch { /* closed */ }
    this.#db = null;
  }
}

// The example folder (M11): a manifest of shipped files, loaded into a database of
// the same shape as the index, so the very same queries answer for it.
export type ExampleManifest = { files: { file: string; kind: string; title?: string; alt?: string; tags?: string[]; categories?: string[]; thumb?: string; size?: number; width?: number; height?: number }[] };
export function exampleIndex(dir: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, scope TEXT, kind TEXT, name TEXT, size INTEGER, modified_at INTEGER, added_at INTEGER,
      title TEXT, alt TEXT, thumb TEXT, thumb_width INTEGER, thumb_height INTEGER);
    CREATE TABLE labels (type TEXT, id INTEGER, scope TEXT, name TEXT, public INTEGER, PRIMARY KEY (type, id));
    CREATE TABLE file_labels (file_id INTEGER, type TEXT, label_id INTEGER);`);
  let manifest: ExampleManifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExampleManifest; } catch { return db; }
  const labelIds = new Map<string, number>();
  const label = (type: string, name: string) => {
    const k = `${type}:${name}`;
    if (!labelIds.has(k)) {
      labelIds.set(k, labelIds.size + 1);
      db.prepare('INSERT INTO labels VALUES (?, ?, ?, ?, 1)').run(type, labelIds.size, EXAMPLE_SCOPE, name);
    }
    return labelIds.get(k)!;
  };
  const t0 = 1_788_000_000;
  for (const [i, f] of manifest.files.entries()) {
    let size = f.size ?? 0;
    try { size = statSync(join(dir, f.file)).size; } catch { /* listed anyway */ }
    db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(i + 1, f.file, EXAMPLE_SCOPE, f.kind, f.file.split('/').pop()!, size,
      t0 + i * 86400, t0 + i * 86400, f.title ?? null, f.alt ?? null, f.thumb ?? null, f.width ?? null, f.height ?? null);
    for (const t of f.tags ?? []) db.prepare('INSERT INTO file_labels VALUES (?, ?, ?)').run(i + 1, 'tag', label('tag', t));
    for (const c of f.categories ?? []) db.prepare('INSERT INTO file_labels VALUES (?, ?, ?)').run(i + 1, 'category', label('category', c));
  }
  return db;
}

// ------------------------------------------------------------------ the routes
export type MediaApiDeps = {
  areas: AreaLookup;                        // the protected folders (from memory: live.ts)
  publicRoot: string;
  domain: string;
  folderSubdomains: boolean;   // a folder's files also at <folder>.<domain> (the site's profile)
  now: () => number;
  index: MediaIndex;
  thumbsDir: string;
  example: DatabaseSync;
  exampleDir: string;
  limiter: RateLimiter;
  limits: { keyed: number; open: number; bad: number };
  ipOf: (req: FastifyRequest) => string;
  hostOf: (req: FastifyRequest) => string | null;
  baseOf: (req: FastifyRequest) => string | null;
  visitorOf: (req: FastifyRequest, host: string) => Promise<Access | null>;
  keyFor: (token: string) => Promise<ApiKey | null>;
  // a site with hosts (lfdln, docs/phase8-plan.md 8-3): no main site's media folder (P8-5), a
  // file's addresses through the routes that show its site folder
  routes?: SiteRoutes | null;
  // the built-in example folder, where the examples are on (not lfdln, P8-12)
  examples?: boolean;
  apiError: (reply: FastifyReply, status: number, error: string, message: string) => FastifyReply;
};

// Whether a key may read a media folder: its list of folders, or all of them.
export const keyReadsMedia = (key: ApiKey, scope: string) => key.media === 'all' || (Array.isArray(key.media) && key.media.includes(scope));

export function registerMediaApi(app: FastifyInstance, d: MediaApiDeps) {
  // One answer per folder per request: can this visitor open it? (Everything in a
  // media folder shares a handful of folders, so this is a few looks, not one per file.)
  const openable = (access: Access | null) => {
    const seen = new Map<string, boolean>();
    return (path: string) => {
      const dir = path.split('/').slice(0, -1).join('/');
      if (!seen.has(dir)) seen.set(dir, decide(resolve(d.areas, d.publicRoot, `/${dir}/`), access).allow);
      return seen.get(dir)!;
    };
  };

  async function media(req: FastifyRequest, reply: FastifyReply) {
    const host = d.hostOf(req);
    const base = d.baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const ip = d.ipOf(req);
    const query = req.query as Record<string, unknown>;
    for (const [k, v] of Object.entries(query)) {
      if (['key', 'apikey', 'api_key', 'token', 'access_token'].includes(k.toLowerCase()) || (typeof v === 'string' && v.startsWith('pammy_'))) {
        return d.apiError(reply, 400, 'key-in-query', 'Send the key in the Authorization header (Bearer ...), never in the address.');
      }
    }
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && /^Bearer /i.test(auth) ? auth.slice(7).trim() : '';
    const key = token ? await d.keyFor(token) : null;
    if (token && !key) {
      if (!d.limiter.take(`api-bad:${ip}`, d.limits.bad, 60)) return d.apiError(reply, 429, 'too-many', 'Too many requests. Please wait a minute.');
      return d.apiError(reply, 401, 'bad-key', 'That key is not accepted.');
    }
    if (!d.limiter.take(key ? `api-key:${key.id}` : `api-ip:${ip}`, key ? d.limits.keyed : d.limits.open, 60)) {
      return d.apiError(reply, 429, 'too-many', 'Too many requests. Please wait a minute.');
    }

    // which media folder
    let segs: string[];
    try { segs = String((req.params as Record<string, string>)['*'] ?? '').split('/').filter((s) => s !== '').map(decodeURIComponent); } catch {
      return d.apiError(reply, 400, 'bad-address', "That address can't be read.");
    }
    let scope: string;
    let rest: string[];
    if (segs[0] === 'main' && d.routes) return d.apiError(reply, 404, 'bad-address', 'This site has no main media folder: each site folder has its own, like /_pammy/api/media/in/home/t/summer.');
    if (segs[0] === 'example' && d.examples === false) return d.apiError(reply, 404, 'bad-address', 'Start with in/<folder>/, like /_pammy/api/media/in/home/t/summer.');
    if (segs[0] === 'main') { scope = '/'; rest = segs.slice(1); }
    else if (segs[0] === 'in' && segs[1] && FOLDER_RE.test(segs[1])) { scope = `/${segs[1]}`; rest = segs.slice(2); }
    else if (segs[0] === 'example') { scope = EXAMPLE_SCOPE; rest = segs.slice(1); }
    else return d.apiError(reply, 404, 'bad-address', 'Start with main/ (the main site\'s media folder) or in/<folder>/, like /_pammy/api/media/in/olivia/t/summer.');
    const isExample = scope === EXAMPLE_SCOPE;
    const idx = isExample ? d.example : d.index.get();
    if (key && !isExample && !keyReadsMedia(key, scope)) return d.apiError(reply, 403, 'not-allowed', "This key can't read that media folder.");
    const open = !key || isExample;           // without a key: public labels only

    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      // one entry per name: a tag scope inside the folder may have its own "summer" too
      const t = inTree(scope);
      const rows = (idx?.prepare(`SELECT * FROM labels WHERE ${t.sql} ORDER BY type, name`).all(...t.args) as LabelRow[] | undefined ?? []).filter((l) => !open || l.public);
      const groups = new Map<string, { type: string; name: string; ids: number[]; public: boolean }>();
      for (const l of rows) {
        const g = groups.get(`${l.type}:${l.name}`) ?? { type: l.type, name: l.name, ids: [], public: false };
        g.ids.push(l.id);
        g.public ||= l.public === 1;
        groups.set(`${l.type}:${l.name}`, g);
      }
      const visible = new Set(visibleFiles(idx, scope, null, [], open ? openable(await visitorOf(req, host)) : null).map((f) => f.id));
      const count = (g: { type: string; ids: number[] }) => new Set((idx!.prepare(`SELECT file_id FROM file_labels WHERE type = ? AND label_id IN (${g.ids.map(() => '?').join(',')})`)
        .all(g.type, ...g.ids) as { file_id: number }[]).map((x) => x.file_id).filter((id) => visible.has(id))).size;
      const listed = [...groups.values()];
      return send(req, reply, key, {
        folder: folderOf(scope),
        tags: listed.filter((g) => g.type === 'tag').map((g) => ({ name: g.name, files: count(g), ...(open ? {} : { public: g.public }) })),
        categories: listed.filter((g) => g.type === 'category').map((g) => ({ name: g.name, files: count(g), ...(open ? {} : { public: g.public }) })),
      });
    }

    // files: /all (key only), or t/<name> and c/<name> pairs and/or ?tags= & ?categories=
    const wanted: { type: 'tag' | 'category'; name: string }[] = [];
    const seen = new Set<string>();
    const addWanted = (type: 'tag' | 'category', name: string) => {
      if (!LABEL_RE.test(name)) return false;
      const k = `${type}:${name}`;
      if (!seen.has(k)) { seen.add(k); wanted.push({ type, name }); }
      return true;
    };
    const queryNames = (keys: string[]): string[] => {
      const out: string[] = [];
      for (const key of keys) {
        const v = query[key];
        if (v === undefined) continue;
        for (const item of Array.isArray(v) ? v : [v]) {
          for (const part of String(item).split(',')) {
            const s = part.trim();
            if (s) out.push(s);
          }
        }
      }
      return out;
    };
    if (rest.length === 1 && rest[0] === 'all') {
      if (queryNames(['tags', 'tag', 'categories', 'category']).length) {
        return d.apiError(reply, 400, 'bad-filter', '/all lists every file; to filter, ask for tags and categories instead of all.');
      }
      if (open) return d.apiError(reply, 401, 'no-key', 'Every file at once needs a key. Without one, ask for a tag or category: .../t/<tag> or .../c/<category>.');
    } else {
      if (rest.length % 2 !== 0 || rest.length > 20) {
        return d.apiError(reply, 400, 'bad-filter', 'Ask for tags and categories in pairs: t/<tag>, c/<category>, like .../t/summer/c/travel. Several of each: .../t/dogs/t/cats/c/pets. Or ?tags=dogs,cats&categories=pets.');
      }
      for (let i = 0; i < rest.length; i += 2) {
        const [kind, name] = [rest[i]!, rest[i + 1]!];
        if ((kind !== 't' && kind !== 'c') || !addWanted(kind === 't' ? 'tag' : 'category', name)) {
          return d.apiError(reply, 400, 'bad-filter', 'Ask for tags and categories in pairs: t/<tag>, c/<category>, like .../t/summer/c/travel. Several of each: .../t/dogs/t/cats/c/pets. Or ?tags=dogs,cats&categories=pets.');
        }
      }
      for (const name of queryNames(['tags', 'tag'])) {
        if (!addWanted('tag', name)) return d.apiError(reply, 400, 'bad-filter', 'Tag names are lowercase letters, digits and hyphens, like summer or street-animals.');
      }
      for (const name of queryNames(['categories', 'category'])) {
        if (!addWanted('category', name)) return d.apiError(reply, 400, 'bad-filter', 'Category names are lowercase letters, digits and hyphens, like travel or street-animals.');
      }
      if (!wanted.length) {
        return d.apiError(reply, 400, 'bad-filter', 'Ask for tags and categories in pairs: t/<tag>, c/<category>, like .../t/summer/c/travel. Several of each: .../t/dogs/t/cats/c/pets. Or ?tags=dogs,cats&categories=pets.');
      }
      if (wanted.length > 10) {
        return d.apiError(reply, 400, 'bad-filter', 'Ask for at most ten tags and categories at once.');
      }
    }
    // A name means every label of that name in the folder or a tag scope inside it
    // (a file only ever has one of them: its own folder's or an ancestor's).
    const labelIds: { type: string; ids: number[] }[] = [];
    const t = inTree(scope);
    for (const w of wanted) {
      const ls = (idx?.prepare(`SELECT * FROM labels WHERE ${t.sql} AND type = ? AND name = ?`).all(...t.args, w.type, w.name) as LabelRow[] | undefined ?? [])
        .filter((l) => !open || l.public);
      // a private label looks exactly like a missing one without a key (M5)
      if (!ls.length) {
        return d.apiError(reply, 404, 'no-label', `There is no ${open ? 'public ' : ''}${w.type} called "${w.name}" in ${folderOf(scope) ?? 'the main site'}'s media folder.`);
      }
      labelIds.push({ type: w.type, ids: ls.map((l) => l.id) });
    }

    const kind = query.kind === undefined ? null : KINDS.includes(String(query.kind)) ? String(query.kind) : undefined;
    if (kind === undefined) return d.apiError(reply, 400, 'bad-kind', 'kind can be images, audio, video or files.');
    const order = query.order === undefined ? 'newest' : ['newest', 'oldest', 'name'].includes(String(query.order)) ? String(query.order) : null;
    if (!order) return d.apiError(reply, 400, 'bad-order', 'order can be newest (the default), oldest or name.');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return d.apiError(reply, 400, 'bad-limit', 'limit can be a whole number from 1 to 100 (50 by default).');
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return d.apiError(reply, 400, 'bad-offset', 'offset is a whole number: how many to skip.');

    const all = visibleFiles(idx, scope, kind, labelIds, open && !isExample ? openable(await visitorOf(req, host)) : null, order);
    const page = all.slice(offset, offset + limit);
    const labelsOf = (id: number) => (idx!.prepare('SELECT l.type, l.name, l.public FROM file_labels x JOIN labels l ON l.type = x.type AND l.id = x.label_id WHERE x.file_id = ? ORDER BY l.name')
      .all(id) as { type: string; name: string; public: number }[]).filter((l) => !open || l.public);
    return send(req, reply, key, {
      folder: folderOf(scope),
      filter: { tags: wanted.filter((w) => w.type === 'tag').map((w) => w.name), categories: wanted.filter((w) => w.type === 'category').map((w) => w.name) },
      kind, order, total: all.length, offset, limit, next: offset + limit < all.length ? offset + limit : null,
      files: page.map((f) => {
        const ls = labelsOf(f.id);
        return {
          name: f.name, kind: f.kind, title: f.title, alt: f.alt, size: f.size,
          addedAt: iso(f.added_at), modifiedAt: iso(f.modified_at),
          ...addresses(f, isExample, base, host),
          thumb: f.thumb ? { src: isExample ? `${EXAMPLE_FILES_URL}${encodePath(f.thumb)}` : `/_pammy/media-thumbs/${f.id}-${f.thumb.split('-')[1]!.slice(0, 12)}.webp`, width: f.thumb_width, height: f.thumb_height } : null,
          tags: [...new Set(ls.filter((l) => l.type === 'tag').map((l) => l.name))],
          categories: [...new Set(ls.filter((l) => l.type === 'category').map((l) => l.name))],
        };
      }),
    });
  }

  const visitorOf = (req: FastifyRequest, host: string) => d.visitorOf(req, host);
  const folderOf = (scope: string) => (scope === '/' ? null : scope === EXAMPLE_SCOPE ? 'example' : scope.slice(1));
  const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000', '');

  // Where a file is: from a page on this hostname (src), and its full addresses.
  function addresses(f: FileRow, isExample: boolean, base: string, host: string): { src: string | null; url: string | null; subdomainUrl: string | null } {
    if (isExample) return { src: `${EXAMPLE_FILES_URL}${encodePath(f.path)}`, url: `https://${d.domain}${EXAMPLE_FILES_URL}${encodePath(f.path)}`, subdomainUrl: null };
    if (d.routes) {
      // through the routes (8-3): on this host when one of its routes shows the folder
      // (src relative to it), else the first host that does; none: no address at all
      const [first, ...inner] = f.path.split('/');
      const at = d.routes.shownAt(first!);
      const here = at.find((x) => x.host === host);
      const main = here ?? at[0];
      const tail = encodePath(inner.join('/'));
      return { src: here ? `${here.path}${tail}` : main ? `https://${main.host}${main.path}${tail}` : null, url: main ? `https://${main.host}${main.path}${tail}` : null, subdomainUrl: null };
    }
    const onHost = pathOnHost(f.path, base);
    const url = `https://${d.domain}/${encodePath(f.path)}`;
    const [first, ...inner] = f.path.split('/');
    const subdomainUrl = d.folderSubdomains && f.scope !== '/' && SUBDOMAIN_RE.test(first!) ? `https://${first}.${d.domain}/${encodePath(inner.join('/'))}` : null;
    return { src: onHost === null ? url : encodePath(onHost), url, subdomainUrl };
  }

  function send(req: FastifyRequest, reply: FastifyReply, key: ApiKey | null, body: unknown) {
    reply.header('Cache-Control', key ? 'private, no-store' : 'no-cache');
    if (!key) {
      const tag = `"${hash(JSON.stringify(body))}"`;
      reply.header('ETag', tag);
      if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    }
    return reply.send(body);
  }

  app.get('/_pammy/api/media/*', media);

  // A listed picture's small version (M8): the same rules as the file itself.
  app.get('/_pammy/media-thumbs/:name', async (req, reply) => {
    const host = d.hostOf(req);
    const base = d.baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const m = /^(\d{1,12})-([0-9a-f]{12})\.webp$/.exec((req.params as { name: string }).name);
    const idx = d.index.get();
    const f = m && idx ? idx.prepare('SELECT * FROM files WHERE id = ?').get(Number(m[1])) as FileRow | undefined : undefined;
    if (!m || !f?.thumb || !f.thumb.startsWith(`${m[1]}-${m[2]}`)) return reply.code(404).header('Cache-Control', 'no-store').send();
    const allowed = openable(await visitorOf(req, host))(f.path);
    if (!allowed) return reply.code(404).header('Cache-Control', 'no-store').send();
    let bytes: Buffer;
    try { bytes = readFileSync(join(d.thumbsDir, f.thumb)); } catch { return reply.code(404).header('Cache-Control', 'no-store').send(); }
    // kept by the browser only: never in Cloudflare's cache, where a folder
    // protected later could still hand it out
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.type('image/webp').send(bytes);
  });
}

// The files in a media folder with one of each group of labels, that this visitor
// may open (openable null: all of them, for keys and the example folder).
// The labels of a folder: its own and those of tag scopes inside it. The main
// site's tag scopes inside it are in its media folder (/media/...); a top-level
// folder's are /olivia/... (substr, not GLOB: folder names may hold * or [).
function inTree(scope: string): { sql: string; args: (string | number)[] } {
  if (scope === '/') return { sql: "(scope = '/' OR substr(scope, 1, 7) = '/media/')", args: [] };
  return { sql: '(scope = ? OR substr(scope, 1, ?) = ?)', args: [scope, scope.length + 1, `${scope}/`] };
}

function visibleFiles(idx: DatabaseSync | null, scope: string, kind: string | null, labels: { type: string; ids: number[] }[],
  openable: ((path: string) => boolean) | null, order = 'newest'): FileRow[] {
  if (!idx) return [];
  const where = ['scope = ?'];
  const args: (string | number)[] = [scope];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  for (const l of labels) {
    where.push(`EXISTS (SELECT 1 FROM file_labels x WHERE x.file_id = files.id AND x.type = ? AND x.label_id IN (${l.ids.map(() => '?').join(',')}))`);
    args.push(l.type, ...l.ids);
  }
  const by = order === 'oldest' ? 'added_at ASC, id ASC' : order === 'name' ? 'name COLLATE NOCASE ASC, id ASC' : 'added_at DESC, id DESC';
  const rows = idx.prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY ${by}`).all(...args) as FileRow[];
  return openable ? rows.filter((f) => openable(f.path)) : rows;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
