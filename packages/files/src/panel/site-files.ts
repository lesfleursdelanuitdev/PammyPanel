// What the three areas that work with her website's files share: Media, File
// Explorer and the editor (docs/refactor-plan.md phase 3). They all ask the
// website folder helper for the files themselves, keep a record of each one
// (src/media-db.ts), and answer only about the folder a limited account may see.
//
// Made per request-handler file with siteFiles(ctx); it holds nothing of its own.
import type { Readable } from 'node:stream';
import { AccountError } from '@panel/core/accounts';
import { one } from '@panel/core/pg';
import { mediaFolderKind, type MediaRow } from '../media-db.ts';
import type { SyncSummary } from '../media-sync.ts';
import type { LabelType } from '@panel/catalog/labels';
import { checkScope, scopeIdOf } from '@panel/catalog/scopes';
import { belongs } from '../sitefs/media.ts';
import type { Authed } from '@panel/core/sessions';
import { isKept, websitePlaces } from '@panel/core/panel/rights';
import type { PanelCtx } from '@panel/core/panel/context';

export type MediaList = {
  path: string; site: string; kind: string; inner: string[];
  buckets: { name: string; items: number; modifiedAt: number }[];
};

// What the browser may be handed back straight from her website. Anything not
// here is downloaded rather than shown, so nothing runs in her panel's page.
export const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', pdf: 'application/pdf',
};

export const stringParam = (v: unknown) => (typeof v === 'string' ? v : '');
// a path as the helper spells it (it drops empty steps), to find its record
export const pathParam = (v: unknown) => stringParam(v).split('/').filter(Boolean).join('/');
export const syncInfo = (s: SyncSummary | null) => (s ? { at: s.at, strays: s.strays, truncated: s.truncated } : null);
export const siteOf = (scope: string) => (scope === '/' ? '' : scope.slice(1));
export const labelsNote = (c: { tags: string[]; categories: string[] }) =>
  (c.tags.length || c.categories.length ? `made ${[...c.tags, ...c.categories].join(', ')}` : null);

// An upload that is refused is read to the end all the same, so the browser is
// told why rather than seeing the connection cut.
export const drained = (stream: Readable) => new Promise<void>((resolve) => {
  if (stream.readableEnded || stream.destroyed) return resolve();
  stream.on('end', resolve).on('close', resolve).on('error', () => resolve());
  stream.resume();
});

export const typeParam = (v: unknown): LabelType => {
  if (v === 'tag' || v === 'category') return v;
  throw new AccountError('Not found.', 404);
};

export const scopeParam = (v: unknown): string | null => {
  const sc = stringParam(v);
  if (sc === '' || sc === '*') return null;
  try { return checkScope(sc); } catch { throw new AccountError('Not found.', 404); }
};

// D22/D24, docs/permissions-plan.md R5: a person kept to places reaches only
// what is in one of them (on pammy.org a place is a folder at the top of her
// website, "/olivia"); any other path, id or label is "not found".
// (only website places: a software place, docs/catalog-plan.md step 3b, is File Explorer's root of its own)
export const siteLimits = (a: Authed): string[] | null => (isKept(a.user) ? websitePlaces(a.user).map((p) => p.slice(1)) : null);
const under = (p: string, site: string) => p === site || p.startsWith(`${site}/`);
export const ownsPath = (a: Authed, path: unknown) => {
  const sites = siteLimits(a);
  const p = pathParam(path);
  return sites === null || sites.some((site) => under(p, site));
};
export const own = (a: Authed, ...paths: unknown[]) => {
  for (const p of paths) if (!ownsPath(a, p)) throw new AccountError('Not found.', 404);
};
// The folder of theirs a path is in, for a person kept to places (null: anyone else).
export const siteOfPath = (a: Authed, path: unknown) => {
  const p = pathParam(path);
  return siteLimits(a)?.find((site) => under(p, site)) ?? null;
};
// The place a scope ("/olivia/recipes") is in, or null when it is in none of theirs.
export const placeOfScope = (a: Authed, scope: string) => websitePlaces(a.user).find((pl) => under(scope, pl)) ?? null;
export const ownsScope = (a: Authed, scope: string | null | undefined) => !isKept(a.user) || (!!scope && placeOfScope(a, scope) !== null);
// What a list is about: for a person kept to places, the place of what they
// asked about (which has to be theirs), or else each of their places; for
// anyone else, what they asked (null: all of it).
export function listedScopes(a: Authed, asked: string | null): (string | null)[] {
  if (!isKept(a.user)) return [asked];
  if (asked === null) return [...websitePlaces(a.user)];
  const place = placeOfScope(a, asked);
  if (!place) throw new AccountError('Not found.', 404);
  return [place];
}
export const syncFor = (a: Authed, s: SyncSummary | null) => {
  const i = syncInfo(s);
  return i && isKept(a.user) ? { ...i, strays: i.strays.filter((x) => ownsPath(a, x)) } : i;
};
export const who = (r: { added_by: string | null; added_at: number; how: string } | undefined) =>
  ({ addedBy: r?.added_by ?? null, addedAt: r && r.how !== 'found' ? r.added_at : null, how: r && r.how !== 'found' ? r.how : null });

// One file as the Media tab and File Explorer show it.
export const itemOf = (
  f: MediaRow,
  pictures: Map<number, unknown>,
  labels: Map<number, { tags: string[]; categories: string[] }>,
  library: 'media' | 'all' = 'media',
) => {
  const parts = f.path.split('/');
  const at = parts.indexOf('media');
  const folderKind = mediaFolderKind(f.path);
  const folder = library === 'media' && at >= 0 && (at === 0 || at === 1) ? parts.slice(at + 2, -1).join('/') : parts.slice(0, -1).join('/');
  const kind = folderKind ?? f.kind;
  return {
    ...who(f), id: f.id, path: f.path, scope: f.scope, site: siteOf(f.scope), kind, folder, name: f.name,
    size: f.size, addedAt: f.added_at, modifiedAt: f.modified_at,
    fits: folderKind ? belongs(folderKind, f.name) : true, title: f.title, alt: f.alt,
    thumb: pictures.get(f.id) ?? null, ...labels.get(f.id)!,
  };
};

// The ones that have to ask something: a scope labels can be made in -- the
// whole site, any folder at the top of it (with or without a media folder), or
// a deeper folder marked as a tag scope.
export function siteFiles(ctx: PanelCtx) {
  const { db, helper } = ctx;
  return {
    realScope: async (v: unknown, user: string): Promise<string> => {
      const sc = scopeParam(v);
      if (!sc) throw new AccountError("That folder isn't there.", 404);
      if (sc === '/') return sc;
      const parts = sc.slice(1).split('/');
      if (parts.length === 1) {
        const st = await helper<{ dir: boolean }>({ op: 'files-stat', path: parts[0], actor: user });
        if (!st.dir) throw new AccountError("That folder isn't there.", 404);
      } else if (!await scopeIdOf(db, sc)) {
        throw new AccountError("That folder isn't a tag scope.", 404);
      }
      return sc;
    },
  };
}
