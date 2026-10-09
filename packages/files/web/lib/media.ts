// Media folders: <site>/media/<kind>/<inner folders>. Same lists as src/sitefs/media.ts,
// for quick answers before uploading; the server checks again.
import { SUBDOMAIN_RE } from '@panel/core/web/lib/names';
import type { MediaKind } from './types';
import { isOn, SITE, sizeWords } from '@panel/core/web/lib/site';
import { useApi } from '@panel/core/web/hooks/useApi';

export type FileKind = import('./types').FileKind;
export const MEDIA_KINDS: [MediaKind, string][] = [['images', 'Images'], ['files', 'Files'], ['audio', 'Audio'], ['video', 'Video']];
export const FILE_KINDS: [import('./types').FileKind, string][] = [...MEDIA_KINDS, ['pages', 'Pages'], ['other', 'Other']];
export const KIND_EXTENSIONS: Record<Exclude<MediaKind, 'files'>, string[]> = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'ogv'],
};
const NOT_FILES = ['html', 'htm', 'xhtml', 'xht', 'shtml', 'svg', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar', 'cgi', 'pl', 'py', 'sh', 'asp', 'aspx', 'jsp', 'htaccess'];
export const MAX_UPLOAD = SITE.uploads.maxBytes;   // the site's profile

export const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
// a site's program files (.php and the like, as the folder helper's FORBIDDEN_WRITE): listed, run on
// the server, never changed, moved or trashed from the panel (docs/lfdln-mariadb-plan.md finding 1)
const PROGRAM_EXTS = new Set(['php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar', 'cgi', 'pl', 'py', 'sh', 'asp', 'aspx', 'jsp', 'htaccess']);
export const isProgramFile = (name: string) => PROGRAM_EXTS.has(extOf(name));
export const kindFits = (kind: MediaKind, name: string) =>
  (kind === 'files' ? !!extOf(name) && !NOT_FILES.includes(extOf(name)) : KIND_EXTENSIONS[kind].includes(extOf(name)));
export const kindLabel = (kind: string) => FILE_KINDS.find(([k]) => k === kind)?.[1] ?? 'File';
export const isKind = (k: string | null): k is MediaKind => MEDIA_KINDS.some(([x]) => x === k);


export const scopeOf = (folder: string) => (folder ? `/${folder}` : '/');
export const folderOfScope = (scope: string) => (scope === '/' ? '' : scope.slice(1));

// What the Media page shows, all of it in its address (so Back works and links can be shared):
//   ?folder=*          every media folder        ?folder=/  the main site's     ?folder=olivia
//   &kind=images       one of the four (none: all four)
//   &in=2026/trip      a folder inside that kind (one media folder and one kind only)
//   &q= &tag= &cat=    name search, a tag's or a category's id
//   &sort=name|size|added &order=desc &page=2
export type Browse = {
  folder: string | null; kind: MediaKind | null; inner: string; q: string; tags: number[]; categories: number[];
  sort: 'name' | 'size' | 'added'; desc: boolean; page: number;
};
export const BROWSE_DEFAULTS: Omit<Browse, 'folder'> = { kind: null, inner: '', q: '', tags: [], categories: [], sort: 'name', desc: false, page: 1 };

const idList = (p: URLSearchParams, key: string): number[] => {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of p.getAll(key)) {
    for (const part of v.split(',')) {
      const n = Number(part.trim());
      if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
};
export function readBrowse(p: URLSearchParams, fallbackFolder: string | null): Browse {
  const f = p.get('folder');
  const kind = p.get('kind');
  return {
    folder: f === '*' ? null : f === '/' ? '' : f !== null ? f : fallbackFolder,
    kind: isKind(kind) ? kind : null,
    inner: (p.get('in') || '').split('/').filter((x) => x && x !== '..' && x !== '.').join('/'),
    q: p.get('q') ?? '',
    tags: idList(p, 'tag'),
    categories: idList(p, 'cat'),
    sort: p.get('sort') === 'size' || p.get('sort') === 'added' ? p.get('sort') as 'size' | 'added' : 'name',
    desc: p.get('order') === 'desc',
    page: Math.max(1, Number(p.get('page')) || 1),
  };
}
export function browseHref(b: Browse): string {
  const q = new URLSearchParams();
  q.set('folder', b.folder === null ? '*' : b.folder === '' ? '/' : b.folder);
  if (b.kind) q.set('kind', b.kind);
  if (b.inner && b.kind && b.folder !== null) q.set('in', b.inner);
  if (b.q) q.set('q', b.q);
  for (const id of b.tags) q.append('tag', String(id));
  for (const id of b.categories) q.append('cat', String(id));
  if (b.sort !== 'name') q.set('sort', b.sort);
  if (b.desc) q.set('order', 'desc');
  if (b.page > 1) q.set('page', String(b.page));
  return `/media?${q}`;
}
// Only one folder can be browsed: one media folder, one kind, nothing searched for.
export const browsing = (b: Browse) => b.folder !== null && b.kind !== null && !b.q && !b.tags.length && !b.categories.length;
export const browseDir = (b: Browse) => (b.folder !== null && b.kind ? [b.folder, 'media', b.kind, b.inner].filter(Boolean).join('/') : null);
export function itemsUrl(b: Browse): string {
  const q = new URLSearchParams();
  if (b.folder !== null) q.set('scope', scopeOf(b.folder));
  if (b.kind) q.set('kind', b.kind);
  if (b.inner && b.kind && b.folder !== null) q.set('in', b.inner);
  if (b.q) q.set('q', b.q);
  for (const id of b.tags) q.append('tag', String(id));
  for (const id of b.categories) q.append('category', String(id));
  q.set('sort', b.sort);
  if (b.desc) q.set('order', 'desc');
  if (b.page > 1) q.set('offset', String((b.page - 1) * 100));
  return `/api/media/items?${q}`;
}

// Per browser (D20): Grid or Table, and the media folder last looked at. Storage
// can be missing or refuse (private windows), so nothing depends on it.
export function pref<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
  try {
    const v = localStorage.getItem(`pammy.media.${key}`);
    return v !== null && (!allowed || allowed.includes(v as T)) ? v as T : fallback;
  } catch { return fallback; }
}
export function setPref(key: string, value: string) {
  try { localStorage.setItem(`pammy.media.${key}`, value); } catch { /* not kept: fine */ }
}

// An upload with no kind chosen goes where its ending says.
export function kindForFile(name: string): MediaKind {
  for (const k of ['images', 'audio', 'video'] as const) if (KIND_EXTENSIONS[k].includes(extOf(name))) return k;
  return 'files';
}

// Tags and categories (D10): lowercase letters, digits and hyphens. "Summer 2026" -> summer-2026.
export const LABEL_RULE = 'Lowercase letters, digits and hyphens, like summer-2026.';
export const labelSlug = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
export const labelAddress = (type: 'tag' | 'category', scope: string, name: string) => `${scope === '/' ? '' : scope}/${type === 'tag' ? 't' : 'c'}/${name}`;

export const fileUrl = (path: string, download = false) => {
  const p = path.split('/');
  const at = p[0] === 'media' ? 0 : p[1] === 'media' ? 1 : -1;
  const media = at >= 0 && ['images', 'files', 'audio', 'video'].includes(p[at + 1] ?? '');
  return `${media ? '/api/media/file' : '/api/files/file'}?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
};
// A file of a software root (docs/catalog-plan.md step 3): always File Explorer's route.
export const rootFileUrl = (root: string, path: string, download = false) =>
  (root && root !== 'website' ? `/api/files/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${download ? '&download=1' : ''}` : fileUrl(path, download));
export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
// ('*' is Everywhere: labels that go on anything, docs/catalog-plan.md step 4)
export function pathUnderScope(path: string, scope: string): boolean {
  if (scope === '/' || scope === '*') return true;
  const prefix = scope.slice(1);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function folderToScope(folderPath: string): string {
  const p = folderPath.split('/').filter(Boolean).join('/');
  return p ? `/${p}` : '/';
}

export function scopeLabel(scope: string): string {
  if (scope === '/') return 'Whole site';
  if (scope === '*') return 'Everywhere';
  return scope.slice(1).split('/').join(' › ');
}

// Where a media file is on the internet: pammy.org/<path>, and <folder>.pammy.org/<rest> too.
// shown (/api/files/shown, lfdln): each top folder's addresses through its routes; a file
// in a folder no route shows has none.
export type Shown = Record<string, string[]> | null;
export function useShown(): Shown {
  const r = useApi<{ shown: Shown }>(isOn('hosts') ? '/api/files/shown' : null, { staleTime: 60_000 });
  return isOn('hosts') ? r.data?.shown ?? {} : null;
}
export function publicAddresses(path: string, reserved: string[], shown: Shown = null): string[] {
  const enc = (parts: string[]) => parts.map(encodeURIComponent).join('/');
  const parts = path.split('/');
  if (shown) return (shown[parts[0]!] ?? []).map((base) => `${base}${enc(parts.slice(1))}`);
  const out = [`https://${SITE.domain}/${enc(parts)}`];
  const first = parts[0]!;
  if (SITE.folderSubdomains && parts.indexOf('media') > 0 && SUBDOMAIN_RE.test(first) && !reserved.includes(first)) out.push(`https://${first}.${SITE.domain}/${enc(parts.slice(1))}`);
  return out;
}

// For a page in the site folder itself: media/images/x.jpg
export function htmlFor(path: string, kind: string): string {
  const at = path.split('/').indexOf('media');
  const rel = (at >= 0 ? path.split('/').slice(at) : path.split('/')).map(encodeURIComponent).join('/');
  const name = path.split('/').pop()!;
  const alt = name.replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ').replace(/"/g, '');
  if (kind === 'images') return `<img src="${rel}" alt="${alt}">`;
  if (kind === 'audio') return `<audio src="${rel}" controls></audio>`;
  if (kind === 'video') return `<video src="${rel}" controls></video>`;
  return `<a href="${rel}">${name.replace(/[<>&]/g, '')}</a>`;
}

// One file, with progress. XMLHttpRequest, because fetch can't report upload progress.
export function sendFile(file: File, dir: string, onProgress: (fraction: number) => void, endpoint = '/api/media/upload'): Promise<{ name: string; renamed: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${endpoint}${endpoint.includes('?') ? '&' : '?'}dir=${encodeURIComponent(dir)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Pammy-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.message || (xhr.status === 413 ? `That file is over ${sizeWords(MAX_UPLOAD)}.` : `Upload failed (${xhr.status})`)), { status: xhr.status, code: data.error }));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

export type FilesBrowse = {
  root?: string;   // a software root (docs/catalog-plan.md step 3); none: the website
  path: string; kind: import('./types').FileKind | null; q: string; tags: number[]; categories: number[];
  sort: 'name' | 'size' | 'added'; desc: boolean; page: number;
};
export const FILES_DEFAULTS: Omit<FilesBrowse, 'path'> = { kind: null, q: '', tags: [], categories: [], sort: 'name', desc: false, page: 1 };

export function readFilesBrowse(p: URLSearchParams, fallbackPath: string): FilesBrowse {
  const kind = p.get('kind');
  const path = (p.get('path') ?? fallbackPath).split('/').filter((x) => x && x !== '..' && x !== '.').join('/');
  const root = p.get('root') ?? '';
  return {
    ...(root && root !== 'website' ? { root } : {}),
    path,
    kind: FILE_KINDS.some(([k]) => k === kind) ? kind as FilesBrowse['kind'] : null,
    q: p.get('q') ?? '',
    tags: idList(p, 'tag'),
    categories: idList(p, 'cat'),
    sort: p.get('sort') === 'size' || p.get('sort') === 'added' ? p.get('sort') as 'size' | 'added' : 'name',
    desc: p.get('order') === 'desc',
    page: Math.max(1, Number(p.get('page')) || 1),
  };
}
export function filesHref(b: FilesBrowse): string {
  const q = new URLSearchParams();
  if (b.root && b.root !== 'website') q.set('root', b.root);
  if (b.path) q.set('path', b.path);
  if (b.kind) q.set('kind', b.kind);
  if (b.q) q.set('q', b.q);
  for (const id of b.tags) q.append('tag', String(id));
  for (const id of b.categories) q.append('cat', String(id));
  if (b.sort !== 'name') q.set('sort', b.sort);
  if (b.desc) q.set('order', 'desc');
  if (b.page > 1) q.set('page', String(b.page));
  const s = q.toString();
  return s ? `/files?${s}` : '/files';
}
export const filesBrowsing = (b: FilesBrowse) => !b.q && !b.tags.length && !b.categories.length && !b.kind;
export function filesItemsUrl(b: FilesBrowse): string {
  const q = new URLSearchParams();
  q.set('dir', b.path);
  if (b.kind) q.set('kind', b.kind);
  if (b.q) q.set('q', b.q);
  for (const id of b.tags) q.append('tag', String(id));
  for (const id of b.categories) q.append('category', String(id));
  q.set('sort', b.sort);
  if (b.desc) q.set('order', 'desc');
  if (b.page > 1) q.set('offset', String((b.page - 1) * 100));
  return `/api/files/items?${q}`;
}

// Where a media folder can be, in the Media pages' words: at the top of the main site or of a
// folder directly inside it (pammy.org), or inside a site folder, where the top is Hosts'
// (lfdln, docs/phase8-plan.md P8-5: the site's own address shows its home folder).
export const MEDIA_WHERE = isOn('hosts')
  ? "A media folder keeps a site folder's images, files, audio and video together, in media/images, media/files, media/audio and media/video inside it. Each site folder can have one; the site's own address shows the home folder."
  : "A media folder keeps a site's images, files, audio and video together, in media/images, media/files, media/audio and media/video inside the site's folder. The main site and each folder directly inside it (the ones that can be subdomains) can have one.";
// a site with no main site's media folder (lfdln)
export const NO_MAIN_MEDIA = isOn('hosts');
