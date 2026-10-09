// Media folders: the top of her website and each folder directly inside it (the
// ones that can be subdomains) can have a "media" folder, holding images/,
// files/, audio/ and video/, each with folders of its own ("buckets") if she
// likes -- and nothing else directly inside media/ (docs/media-plan.md). Everything here runs in the website folder helper, as pamela,
// and trusts nothing it's sent: every path is checked again, shortcuts
// (symlinks) are never followed, and nothing is ever overwritten.
import { sizeWords } from '@panel/core/profile';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { isSafeEntryName, trashStamp } from '@panel/core/names';
import { SiteFsError, type SiteFsConfig } from './ops.ts';

export const MEDIA = 'media';
export const KINDS = ['images', 'files', 'audio', 'video'] as const;
// What images/ was called until 2026-09-18 (nginx still sends old addresses on).
export const OLD_IMAGES = 'photos';
export type Kind = (typeof KINDS)[number];
// Cloudflare's free plan refuses any single upload over 100 MB.

const EXTENSIONS: Record<Exclude<Kind, 'files'>, ReadonlySet<string>> = {
  images: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']),
  audio: new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac']),
  video: new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']),
};
// "files" takes anything but web pages and scripts: those would run as part of her site.
const NOT_FILES: ReadonlySet<string> = new Set([
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'svg', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs',
  'php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar', 'cgi', 'pl', 'py', 'sh', 'asp', 'aspx', 'jsp', 'htaccess',
]);

export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

export function belongs(kind: Kind, name: string): boolean {
  const ext = extensionOf(name);
  return kind === 'files' ? ext !== '' && !NOT_FILES.has(ext) : EXTENSIONS[kind].has(ext);
}

export function kindProblem(kind: Kind, name: string): string | null {
  if (belongs(kind, name)) return null;
  const ext = extensionOf(name);
  if (kind === 'files') return ext ? `".${ext}" files can't go in media folders: web pages and scripts would run as part of your site.` : 'Files need an ending like .pdf.';
  return `"${name}" isn't ${kind === 'images' ? 'an image' : kind === 'audio' ? 'an audio file' : 'a video'}. ${kind[0]!.toUpperCase()}${kind.slice(1)} takes ${[...EXTENSIONS[kind]].map((e) => `.${e}`).join(', ')}.`;
}

// ------------------------------------------------------------------ paths
// A media path, relative to the website: "recipes/media/images/2026-trip/stew.jpg".
// The first "media" in it is the media folder; the folder before it (if any) is the site.
export type MediaPath = { rel: string; site: string; kind: Kind | null; inner: string[]; abs: string };

export const lstatOrNull = (p: string): Stats | null => {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

export function parts(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  const p = v.split('/').filter((x) => x !== '');
  if (p.length > 24 || p.some((x) => x === '.' || x === '..' || !isSafeEntryName(x))) return null;
  return p;
}

export type PublicPath = { rel: string; parts: string[]; abs: string };

// Any real path under the website (the File Explorer). Hidden names, login-files
// and shortcuts are refused. An empty path is the top of the site. `readLoginFiles`:
// the editor's preview may read a sign-in page's own login-files (never change them).
export function parsePublicPath(cfg: SiteFsConfig, v: unknown, need: 'dir' | 'file' | 'any' | 'new', readLoginFiles = false): PublicPath {
  if (v === '' || v === null || v === undefined) {
    if (need === 'file' || need === 'new') throw new SiteFsError('invalid', "That isn't a file.");
    return { rel: '', parts: [], abs: cfg.publicDir };
  }
  const p = parts(v);
  if (!p) throw new SiteFsError('invalid', "That isn't a folder in your website.");
  if (!isSoftware(cfg) && p.includes('login-files') && !(readLoginFiles && need === 'file')) throw new SiteFsError('invalid', 'login-files is used by protected folders, not the file explorer.');
  let abs = cfg.publicDir;
  for (const [i, part] of p.entries()) {
    abs = join(abs, part);
    const last = i === p.length - 1;
    const st = lstatOrNull(abs);
    if (!st) {
      if (last && need === 'new') break;
      throw new SiteFsError('not-found', `"${p.slice(0, i + 1).join('/')}" isn't there any more.`);
    }
    if (st.isSymbolicLink()) throw new SiteFsError('invalid', 'That is a shortcut; the panel only works with real folders and files.');
    if (last && need === 'new') throw new SiteFsError('exists', `There's already something called "${part}" there.`);
    if (!last || need === 'dir') { if (!st.isDirectory()) throw new SiteFsError('invalid', `"${part}" is a file, not a folder.`); }
    else if (need === 'file' && !st.isFile()) throw new SiteFsError('invalid', `"${part}" is a folder, not a file.`);
  }
  return { rel: p.join('/'), parts: p, abs };
}

function mediaKindOf(parts: string[]): Kind | null {
  const at = parts[0] === MEDIA ? 0 : parts[1] === MEDIA ? 1 : -1;
  const kind = at >= 0 ? parts[at + 1] : undefined;
  return kind && KINDS.includes(kind as Kind) ? kind as Kind : null;
}

const FORBIDDEN_WRITE = new Set([
  'php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar', 'cgi', 'pl', 'py', 'sh', 'asp', 'aspx', 'jsp', 'htaccess',
]);
// A program file (.php and the like): put in and changed on the server, never from the panel.
// Outside a media folder File Explorer lists it (docs/lfdln-mariadb-plan.md finding 1), so a
// PHP site's own files are seen; nothing in the panel writes, moves or trashes one.
export const isProgramFile = (name: string) => FORBIDDEN_WRITE.has(extensionOf(name));
const PROGRAM_FILE = 'Program files (.php and the like) are changed on the server, not in the panel.';

// What a software root (docs/catalog-plan.md step 3) lets only panel admins put
// there: files its WordPress would run (Q3-2). Anything else in FORBIDDEN_WRITE
// is refused for everyone, as on the website; names starting with a dot
// (.htaccess, .user.ini) never get this far (isSafeEntryName).
export const CODE: ReadonlySet<string> = new Set(['php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar']);

// Who is asking, for a software root: `code` is true only when the panel says
// the person is a panel admin (only the panel can open the socket).
export type WriteAs = { code?: boolean };

export const isSoftware = (cfg: SiteFsConfig) => cfg.kind === 'software';

// P8-1 (docs/phase8-plan.md): on a site whose top is Hosts' (lfdln), nothing goes into it
// and no site folder is renamed, moved or trashed from File Explorer.
const TOP_IS_HOSTS = 'The top holds only site folders; a site folder is made, renamed and removed on the Hosts page.';
export function refuseTop(cfg: SiteFsConfig, into: string[] | null, moving?: string[]) {
  if (!cfg.hostsKeepTop || isSoftware(cfg)) return;
  if ((into && into.length === 0) || (moving && moving.length === 1)) throw new SiteFsError('invalid', TOP_IS_HOSTS);
}
// Modes a new folder and file get: the website's as ever; a software root's are
// group-writable, like WordPress's own (its folders are 2775, and pamela is in its
// group; the setgid bit comes from the parent folder, mkdir ignores it in a mode).
export const dirMode = (cfg: SiteFsConfig) => (isSoftware(cfg) ? 0o775 : 0o755);
export const fileMode = (cfg: SiteFsConfig) => (isSoftware(cfg) ? 0o664 : 0o644);

export function writeProblem(name: string, destParts: string[], cfg?: SiteFsConfig, as: WriteAs = {}): string | null {
  const ext = extensionOf(name);
  if (cfg && isSoftware(cfg)) {
    if (CODE.has(ext)) return as.code === true ? null : `Only panel admins can put or change .${ext} files here.`;
    if (FORBIDDEN_WRITE.has(ext)) return `"${name}" can't be put here from the panel.`;
    return null;
  }
  if (FORBIDDEN_WRITE.has(ext) || name.toLowerCase() === '.htaccess') return `"${name}" can't be put in the website from the panel.`;
  const at = destParts[0] === MEDIA ? 0 : destParts[1] === MEDIA ? 1 : -1;
  if (at >= 0) {
    const kind = destParts[at + 1];
    if (!kind || !KINDS.includes(kind as Kind)) return `A media folder only has ${KINDS.join(', ')}.`;
    return kindProblem(kind as Kind, name);
  }
  return null;
}

// In a software root, a person who isn't an admin can't move, rename, trash or
// restore a folder holding code either (it would take a plugin or theme away).
export function codeInside(abs: string, cap = 20000): boolean {
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 30) return true;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (++seen > cap) return true;
      if (e.isDirectory()) { if (walk(join(dir, e.name), depth + 1)) return true; }
      else if (CODE.has(extensionOf(e.name)) || e.name.startsWith('.')) return true;
    }
    return false;
  };
  const st = lstatOrNull(abs);
  if (!st) return false;
  if (!st.isDirectory()) return CODE.has(extensionOf(abs.split('/').pop() ?? ''));
  return walk(abs, 0);
}
export function refuseCode(cfg: SiteFsConfig, abs: string, as: WriteAs) {
  if (isSoftware(cfg) && as.code !== true && codeInside(abs)) {
    throw new SiteFsError('not-allowed', 'Only panel admins can move, rename or trash code (a .php file, or a folder holding one).');
  }
}

// Checks every existing step: real folders only, no shortcuts. `need`: what the
// last step must be (a missing last step is fine for 'new').
function parseMediaPath(cfg: SiteFsConfig, v: unknown, need: 'dir' | 'file' | 'any' | 'new', minDepth: 'media' | 'kind' | 'inside'): MediaPath {
  const p = parts(v);
  const at = p ? p.indexOf(MEDIA) : -1;
  if (p && at === 0 && topIsHosts(cfg)) throw new SiteFsError('invalid', NO_MAIN_MEDIA);
  if (!p || at < 0) throw new SiteFsError('invalid', "That isn't in a media folder.");
  if (at > 1) throw new SiteFsError('invalid', 'Media folders are only at the top of your website or in a folder directly inside it.');
  const kind = p[at + 1];
  if (kind !== undefined && !KINDS.includes(kind as Kind)) throw new SiteFsError('invalid', `A media folder only has ${KINDS.join(', ')}.`);
  const depth = p.length - at;          // 1: media, 2: media/images, 3+: inside
  if ((minDepth === 'kind' && depth < 2) || (minDepth === 'inside' && depth < 3)) {
    throw new SiteFsError('invalid', minDepth === 'inside' ? "That can't be changed: it's part of the media folder itself." : 'Choose images, files, audio or video.');
  }
  let abs = cfg.publicDir;
  for (const [i, part] of p.entries()) {
    abs = join(abs, part);
    const last = i === p.length - 1;
    const st = lstatOrNull(abs);
    if (!st) {
      if (last && need === 'new') break;
      throw new SiteFsError('not-found', `"${p.slice(0, i + 1).join('/')}" isn't there any more.`);
    }
    if (st.isSymbolicLink()) throw new SiteFsError('invalid', 'That is a shortcut; the panel only works with real folders and files.');
    if (last && need === 'new') throw new SiteFsError('exists', `There's already something called "${part}" there.`);
    if (!last || need === 'dir') { if (!st.isDirectory()) throw new SiteFsError('invalid', `"${part}" is a file, not a folder.`); }
    else if (need === 'file' && !st.isFile()) throw new SiteFsError('invalid', `"${part}" is a folder, not a file.`);
  }
  return { rel: p.join('/'), site: p.slice(0, at).join('/'), kind: (kind as Kind) ?? null, inner: p.slice(at + 2), abs };
}

// Folder names people choose (buckets) and names of uploaded files.
export function cleanName(v: unknown, what: 'folder' | 'file'): string {
  if (typeof v !== 'string') throw new SiteFsError('invalid', `Please give the ${what} a name.`);
  // a file's name is what's after its last slash (some browsers send a whole path)
  const base = what === 'file' ? v.split(/[\\/]/).pop()! : v;
  const name = base.normalize('NFC').replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').trim();
  if (!name) throw new SiteFsError('invalid', `Please give the ${what} a name.`);
  if ([...name].length > 120) throw new SiteFsError('invalid', 'Names can be at most 120 characters.');
  if (what === 'folder' && name.toLowerCase() === MEDIA) throw new SiteFsError('invalid', 'Please pick another name: "media" is the media folder itself.');
  if (!isSafeEntryName(name)) throw new SiteFsError('invalid', "That name can't be used.");
  return name;
}

// "stew.jpg", "stew-2.jpg", "stew-3.jpg"...: the first name free in dir.
function freeName(dir: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    if (!lstatOrNull(join(dir, candidate))) return candidate;
  }
  throw new SiteFsError('exists', 'Too many files with that name already.');
}

// Puts a finished temporary file in place under the first free name, atomically
// (link fails rather than replace anything), and removes the temporary name.
export function placeFile(tmp: string, dir: string, wanted: string): string {
  for (let tries = 0; tries < 20; tries++) {
    const name = freeName(dir, wanted);
    try {
      linkSync(tmp, join(dir, name));
      unlinkSync(tmp);
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
    }
  }
  try { unlinkSync(tmp); } catch { /* gone */ }
  throw new SiteFsError('exists', 'Please try again.');
}

// A copy of `src` at `dest`, which must not exist yet. Not copyFileSync: libuv
// fchown()s the copy to the original's owner, and fchown is in @privileged, which
// the helper's seccomp filter forbids, so the kernel kills the helper (SIGSYS).
export function copyBytes(src: string, dest: string) {
  const from = openSync(src, 'r');
  let to: number | null = null;
  try {
    to = openSync(dest, 'wx', statSync(src).mode & 0o777);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = readSync(from, chunk, 0, chunk.length, null)) > 0;) {
      for (let at = 0; at < n;) at += writeSync(to, chunk, at, n - at);
    }
  } finally {
    closeSync(from);
    if (to !== null) closeSync(to);
  }
}

export const tmpName = () => `.pammy-upload-${process.pid}-${randomBytes(6).toString('hex')}`;

export function friendly(e: unknown, what: string): never {
  if (e instanceof SiteFsError) throw e;
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') throw new SiteFsError('not-allowed', `The server won't let the panel ${what}. It probably belongs to another account; ask momolig.`);
  if (code === 'ENOENT') throw new SiteFsError('not-found', "That isn't there any more.");
  if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new SiteFsError('exists', 'Something with that name is already there.');
  if (code === 'ENOSPC') throw new SiteFsError('internal', 'The server is out of space; ask momolig.');
  throw e;
}

export const seconds = (ms: number) => Math.floor(ms / 1000);

// ------------------------------------------------------------------ media folders
// The places a media folder can be -- the top of the website ("") and each real
// folder directly inside it -- and whether each has one.
// Where the top is Hosts' (lfdln, docs/phase8-plan.md P8-5) there is no main site: a media
// folder is only ever <site folder>/media (the apex's is home/media).
const NO_MAIN_MEDIA = 'On this site a media folder is inside a site folder (the site\'s own address is its home folder).';
const topIsHosts = (cfg: SiteFsConfig) => cfg.hostsKeepTop === true && !isSoftware(cfg);

export function mediaSites(cfg: SiteFsConfig): { folders: { folder: string; hasMedia: boolean }[] } {
  const hasMedia = (abs: string) => lstatOrNull(join(abs, MEDIA))?.isDirectory() === true;
  const out = topIsHosts(cfg) ? [] : [{ folder: '', hasMedia: hasMedia(cfg.publicDir) }];
  let entries;
  try { entries = readdirSync(cfg.publicDir, { withFileTypes: true }); } catch (e) { friendly(e, 'read the website folder'); }
  for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() || d.name === MEDIA || d.name === 'login-files' || !isSafeEntryName(d.name) || out.length >= 2000) continue;
    out.push({ folder: d.name, hasMedia: hasMedia(join(cfg.publicDir, d.name)) });
  }
  return { folders: out };
}

// "Make a media folder": media/ and the four folders in it, keeping anything already there.
export function mediaCreate(cfg: SiteFsConfig, folder: unknown): { folder: string; created: string[] } {
  if (folder === '' && topIsHosts(cfg)) throw new SiteFsError('invalid', NO_MAIN_MEDIA);
  const p = folder === '' ? [] : parts(folder);
  if (!p || p.includes(MEDIA)) throw new SiteFsError('invalid', "That isn't a folder in your website.");
  if (p.length > 1) throw new SiteFsError('invalid', 'A media folder can only go at the top of your website or in a folder directly inside it (the ones that can be subdomains).');
  let abs = cfg.publicDir;
  for (const part of p) {
    abs = join(abs, part);
    const st = lstatOrNull(abs);
    if (!st) throw new SiteFsError('not-found', `There's no folder called "${p.join('/')}" any more.`);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SiteFsError('invalid', `"${p.join('/')}" isn't a real folder.`);
  }
  const created: string[] = [];
  for (const sub of [MEDIA, ...KINDS.map((k) => join(MEDIA, k))]) {
    const target = join(abs, sub);
    const st = lstatOrNull(target);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SiteFsError('exists', `"${sub}" is already there but isn't a folder; rename it in WinSCP first.`);
      continue;
    }
    try { mkdirSync(target, { mode: 0o755 }); } catch (e) { friendly(e, 'make the media folder'); }
    created.push(sub);
  }
  return { folder: p.join('/'), created };
}

// ------------------------------------------------------------------ looking
export type MediaEntry = { name: string; size: number; createdAt: number; modifiedAt: number; fits: boolean };

export function mediaList(cfg: SiteFsConfig, dir: unknown) {
  const d = parseMediaPath(cfg, dir, 'dir', 'kind');
  const buckets: { name: string; items: number; modifiedAt: number }[] = [];
  const files: MediaEntry[] = [];
  let entries;
  try { entries = readdirSync(d.abs, { withFileTypes: true }); } catch (e) { friendly(e, 'open that folder'); }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (e.name.startsWith('.') || !isSafeEntryName(e.name) || buckets.length + files.length >= 5000) continue;
    let st: Stats;
    try { st = lstatSync(join(d.abs, e.name)); } catch { continue; }
    if (st.isDirectory()) {
      let items = 0;
      try { items = readdirSync(join(d.abs, e.name)).filter((n) => !n.startsWith('.')).length; } catch { /* unreadable */ }
      buckets.push({ name: e.name, items, modifiedAt: seconds(st.mtimeMs) });
    } else if (st.isFile()) {
      files.push({ name: e.name, size: st.size, createdAt: seconds(st.birthtimeMs || st.mtimeMs), modifiedAt: seconds(st.mtimeMs), fits: belongs(d.kind!, e.name) });
    }
  }
  return { path: d.rel, site: d.site, kind: d.kind, inner: d.inner, buckets, files };
}

// Every bucket of one kind in one media folder, for "Move to..." and "Copy to...".
export function mediaBuckets(cfg: SiteFsConfig, dir: unknown): { path: string; buckets: string[] } {
  const d = parseMediaPath(cfg, dir, 'dir', 'kind');
  if (d.inner.length) throw new SiteFsError('invalid', 'Choose images, files, audio or video.');
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 10 || out.length >= 2000) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || !isSafeEntryName(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      walk(join(abs, e.name), r, depth + 1);
    }
  };
  walk(d.abs, '', 0);
  return { path: d.rel, buckets: out };
}

// ------------------------------------------------------------------ for the panel's records (docs/media-plan.md D16)
// Every file in every media folder -- path, size, modified time, never the
// content -- so the panel can see what changed outside it (WinSCP, Claude).
// "strays" are things that aren't where a media file can be: directly under
// media/, in a folder that isn't one of the four, a shortcut, or a name the panel
// can't work with. They're reported, never touched. Hidden names (an upload in
// progress, dotfiles) are left out. Capped, so the answer stays well under the
// client's 4 MB; `truncated` says the list isn't everything.
export const SCAN_CAP = 20_000;
const STRAY_CAP = 200;
export type ScannedFile = { path: string; size: number; modifiedAt: number };

export function mediaScan(cfg: SiteFsConfig, cap = SCAN_CAP): { files: ScannedFile[]; strays: string[]; truncated: boolean } {
  const files: ScannedFile[] = [];
  const strays: string[] = [];
  let truncated = false;
  const stray = (rel: string) => { if (strays.length < STRAY_CAP) strays.push(rel); };
  const walk = (abs: string, relParts: string[], depth: number) => {
    const rel = relParts.join('/');
    const mediaAt = relParts[0] === MEDIA ? 0 : relParts[1] === MEDIA ? 1 : -1;
    const atMediaFolder = mediaAt >= 0 && relParts.length === mediaAt + 1;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { stray(rel || '.'); return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith('.') || e.name === 'login-files') continue;
      const child = relParts.concat(e.name);
      const r = child.join('/');
      if (!isSafeEntryName(e.name)) { stray(r); continue; }
      let st: Stats;
      try { st = lstatSync(join(abs, e.name)); } catch { continue; }
      if (st.isSymbolicLink()) { stray(r); continue; }
      if (st.isDirectory() && depth < 20) {
        // leftover folders inside media/ (photos/, …) are out of place, but the
        // files in them still get a record so File Explorer can show them
        if (atMediaFolder && !KINDS.includes(e.name as Kind)) stray(r);
        walk(join(abs, e.name), child, depth + 1);
      } else if (st.isFile()) {
        // a program file: listed where pages are, out of place in a media folder
        if (FORBIDDEN_WRITE.has(extensionOf(e.name)) && mediaAt >= 0) { stray(r); continue; }
        if (atMediaFolder) stray(r);
        if (files.length >= cap) { truncated = true; return; }
        files.push({ path: r, size: st.size, modifiedAt: seconds(st.mtimeMs) });
      } else stray(r);
    }
  };
  walk(cfg.publicDir, [], 0);
  return { files, strays, truncated };
}

// A file's sha256, read in pieces (videos can be big), for recognising a file
// that moved. Refused if the file changed while it was being read.
export async function mediaHash(cfg: SiteFsConfig, path: unknown): Promise<{ path: string; size: number; modifiedAt: number; hash: string }> {
  const f = parseMediaPath(cfg, path, 'file', 'inside');
  const before = statSync(f.abs);
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(f.abs)) hash.update(chunk as Buffer);
  } catch (e) { friendly(e, 'read that file'); }
  const after = lstatOrNull(f.abs);
  if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SiteFsError('invalid', 'The file changed while it was being read.');
  return { path: f.rel, size: before.size, modifiedAt: seconds(before.mtimeMs), hash: hash.digest('hex') };
}

// Width and height from the start of the file, for the formats that say so early.
function dimensions(abs: string, ext: string): { width: number; height: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    if (ext === 'png' && b.length > 24 && b.toString('latin1', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (ext === 'gif' && b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if ((ext === 'jpg' || ext === 'jpeg') && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (ext === 'webp' && b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
  } catch { /* not readable: no dimensions */ } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

export function mediaInfo(cfg: SiteFsConfig, path: unknown) {
  const f = parseMediaPath(cfg, path, 'file', 'inside');
  const st = statSync(f.abs);
  const name = f.rel.split('/').pop()!;
  return {
    path: f.rel, site: f.site, kind: f.kind, name, size: st.size, createdAt: seconds(st.birthtimeMs || st.mtimeMs), modifiedAt: seconds(st.mtimeMs),
    fits: belongs(f.kind!, name), ...(f.kind === 'images' ? { dimensions: dimensions(f.abs, extensionOf(name)) } : {}),
  };
}

// ------------------------------------------------------------------ streams (see service.ts)
// A file's bytes (or a range of them), for previews and downloads in the panel.
export function mediaRead(cfg: SiteFsConfig, path: unknown, start: unknown, end: unknown): { info: { name: string; size: number; start: number; end: number; modifiedAt: number }; stream: Readable } {
  const f = parseMediaPath(cfg, path, 'file', 'inside');
  const st = statSync(f.abs);
  const s = Number.isSafeInteger(start) && (start as number) >= 0 ? start as number : 0;
  const e = Number.isSafeInteger(end) && (end as number) < st.size ? end as number : st.size - 1;
  if (st.size > 0 && (s > e || s >= st.size)) throw new SiteFsError('invalid', 'That part of the file is out of range.');
  const stream = st.size === 0 ? createReadStream(f.abs, { start: 0, end: -1 }) : createReadStream(f.abs, { start: s, end: e });
  return { info: { name: f.rel.split('/').pop()!, size: st.size, start: s, end: st.size === 0 ? -1 : e, modifiedAt: seconds(st.mtimeMs) }, stream };
}

// An upload: exactly `size` bytes into a hidden temporary file in the folder,
// then put in place under a free name. Anything short, long or failed leaves nothing behind.
// The sha256 is worked out as the bytes go by, so the panel's record has it for free.
export async function mediaUpload(cfg: SiteFsConfig, req: { dir?: unknown; name?: unknown; size?: unknown }, body: Readable):
  Promise<{ path: string; name: string; renamed: boolean; size: number; modifiedAt: number; hash: string }> {
  const d = parseMediaPath(cfg, req.dir, 'dir', 'kind');
  const wanted = cleanName(req.name, 'file');
  const problem = kindProblem(d.kind!, wanted);
  if (problem) throw new SiteFsError('invalid', problem);
  const size = req.size;
  if (!Number.isSafeInteger(size) || (size as number) < 0) throw new SiteFsError('invalid', 'Upload size missing.');
  if ((size as number) > cfg.maxUpload) throw new SiteFsError('invalid', `Files can be at most ${sizeWords(cfg.maxUpload)}. Put bigger ones in with WinSCP.`);
  const tmp = join(d.abs, tmpName());
  let out: Writable;
  try { out = createWriteStream(tmp, { flags: 'wx', mode: 0o644 }); } catch (e) { friendly(e, 'save files there'); }
  let received = 0;
  const hash = createHash('sha256');
  try {
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      body.on('error', reject);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > (size as number)) { body.destroy(); reject(new SiteFsError('invalid', 'The upload was bigger than it said.')); return; }
        hash.update(chunk);
        if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
        if (received === size) out.end();
      });
      body.on('end', () => { if (received !== size) reject(new SiteFsError('invalid', 'The upload stopped before the whole file arrived. Please try again.')); });
      out.on('finish', () => resolve());
      if (size === 0) out.end();
    });
  } catch (e) {
    // the file opens in the background: wait until it's closed, or it could appear
    // only after it was removed and be left behind
    await new Promise<void>((resolve) => { out.once('close', () => resolve()); out.destroy(); if (out.closed) resolve(); });
    try { unlinkSync(tmp); } catch { /* never made */ }
    friendly(e, 'save files there');
  }
  const name = placeFile(tmp, d.abs, wanted);
  const st = statSync(join(d.abs, name));
  return { path: `${d.rel}/${name}`, name, renamed: name !== wanted, size: st.size, modifiedAt: seconds(st.mtimeMs), hash: hash.digest('hex') };
}

// ------------------------------------------------------------------ changing
export function mediaMkdir(cfg: SiteFsConfig, dir: unknown, name: unknown): { path: string } {
  const d = parseMediaPath(cfg, dir, 'dir', 'kind');
  const n = cleanName(name, 'folder');
  if (lstatOrNull(join(d.abs, n))) throw new SiteFsError('exists', `There's already something called "${n}" there.`);
  try { mkdirSync(join(d.abs, n), { mode: 0o755 }); } catch (e) { friendly(e, 'make that folder'); }
  return { path: `${d.rel}/${n}` };
}

// A copy of a file, into any images/files/audio/video folder (or a bucket in one)
// that takes its kind. A name already taken gets -2, -3...
export function mediaCopy(cfg: SiteFsConfig, from: unknown, to: unknown, name: unknown): { path: string; name: string; size: number; modifiedAt: number } {
  const src = parseMediaPath(cfg, from, 'file', 'inside');
  const dest = parseMediaPath(cfg, to, 'dir', 'kind');
  const wanted = name === undefined || name === null || name === '' ? src.rel.split('/').pop()! : cleanName(name, 'file');
  const problem = kindProblem(dest.kind!, wanted);
  if (problem) throw new SiteFsError('invalid', problem);
  const tmp = join(dest.abs, tmpName());
  try { copyBytes(src.abs, tmp); } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } friendly(e, 'copy that'); }
  const placed = placeFile(tmp, dest.abs, wanted);
  const st = statSync(join(dest.abs, placed));
  return { path: `${dest.rel}/${placed}`, name: placed, size: st.size, modifiedAt: seconds(st.mtimeMs) };
}

// Move or rename a file or a bucket. Never onto something that's there already.
export function mediaMove(cfg: SiteFsConfig, from: unknown, to: unknown, name: unknown): { path: string; name: string } {
  const src = parseMediaPath(cfg, from, 'any', 'inside');
  const dest = parseMediaPath(cfg, to, 'dir', 'kind');
  const isDir = lstatSync(src.abs).isDirectory();
  const wanted = name === undefined || name === null || name === '' ? src.rel.split('/').pop()! : cleanName(name, isDir ? 'folder' : 'file');
  if (isDir) {
    if (dest.kind !== src.kind) throw new SiteFsError('invalid', `A folder of ${src.kind} can only go into ${src.kind}.`);
    if (`${dest.rel}/`.startsWith(`${src.rel}/`)) throw new SiteFsError('invalid', "A folder can't go inside itself.");
    if (wanted.toLowerCase() === MEDIA) throw new SiteFsError('invalid', 'Please pick another name: "media" is the media folder itself.');
  } else {
    const problem = kindProblem(dest.kind!, wanted);
    if (problem) throw new SiteFsError('invalid', problem);
  }
  const target = join(dest.abs, wanted);
  if (target === src.abs) return { path: src.rel, name: wanted };
  if (lstatOrNull(target)) throw new SiteFsError('exists', `There's already something called "${wanted}" there. Choose another name.`);
  try { renameSync(src.abs, target); } catch (e) { friendly(e, 'move that'); }
  return { path: `${dest.rel}/${wanted}`, name: wanted };
}

// ------------------------------------------------------------------ trash
// /pamela/trash/.media/<stamp>-<random>/<name>, with origin.json saying where it came from.
// Hidden, so the folders trash list never shows it.
const MEDIA_TRASH = '.media';
const TRASH_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
type Origin = { path: string; name: string; isDir: boolean; trashedAt: number };

export function mediaTrash(cfg: SiteFsConfig, path: unknown): { id: string; path: string; purgeAt: number } {
  const src = parseMediaPath(cfg, path, 'any', 'inside');
  const isDir = lstatSync(src.abs).isDirectory();
  const now = cfg.now();
  const id = `${trashStamp(now)}-${randomBytes(4).toString('hex')}`;
  const box = join(cfg.trashDir, MEDIA_TRASH, id);
  const name = src.rel.split('/').pop()!;
  try {
    mkdirSync(join(cfg.trashDir, MEDIA_TRASH), { recursive: true, mode: 0o700 });
    mkdirSync(box, { mode: 0o700 });
    const trashedAt = seconds(now.getTime());
    writeFileSync(join(box, 'origin.json'), JSON.stringify({ path: src.rel, name, isDir, trashedAt } satisfies Origin), { mode: 0o600, flag: 'wx' });
    renameSync(src.abs, join(box, name));
    return { id, path: src.rel, purgeAt: trashedAt + cfg.purgeDays * 86400 };
  } catch (e) {
    try { rmSync(box, { recursive: true, force: true }); } catch { /* leave it */ }
    friendly(e, 'move that to the trash');
  }
}

function readOrigin(box: string): Origin | null {
  try {
    const o = JSON.parse(readFileSync(join(box, 'origin.json'), 'utf8')) as Origin;
    return typeof o.path === 'string' && typeof o.name === 'string' && isSafeEntryName(o.name) && Number.isSafeInteger(o.trashedAt) ? o : null;
  } catch { return null; }
}

export function mediaTrashList(cfg: SiteFsConfig) {
  const root = join(cfg.trashDir, MEDIA_TRASH);
  const out: (Origin & { id: string; purgeAt: number })[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return { items: out, purgeDays: cfg.purgeDays }; }
  for (const id of ids) {
    if (!TRASH_ID_RE.test(id)) continue;
    const o = readOrigin(join(root, id));
    if (o) out.push({ ...o, id, purgeAt: o.trashedAt + cfg.purgeDays * 86400 });
    if (out.length >= 2000) break;
  }
  return { items: out.sort((a, b) => b.trashedAt - a.trashedAt), purgeDays: cfg.purgeDays };
}

// Back where it was (or under a new name `as`). If its folder has gone, it goes
// to the top of the same kind in that media folder.
export function mediaRestore(cfg: SiteFsConfig, id: unknown, as: unknown): { path: string } {
  if (typeof id !== 'string' || !TRASH_ID_RE.test(id)) throw new SiteFsError('invalid', "That isn't something in the trash.");
  const box = join(cfg.trashDir, MEDIA_TRASH, id);
  const o = readOrigin(box);
  if (!o || !lstatOrNull(join(box, o.name))) throw new SiteFsError('not-found', "That's no longer in the trash.");
  // trashed before images/ was called that: it goes back under the new name
  const original = parts(o.path.replace(new RegExp(`(^|/)${MEDIA}/${OLD_IMAGES}(/|$)`), `$1${MEDIA}/images$2`));
  if (!original) throw new SiteFsError('invalid', "That can't be restored.");
  let dir: MediaPath;
  try {
    dir = parseMediaPath(cfg, original.slice(0, -1).join('/'), 'dir', 'kind');
  } catch {
    const at = original.indexOf(MEDIA);
    dir = parseMediaPath(cfg, original.slice(0, at + 2).join('/'), 'dir', 'kind');
  }
  const wanted = as === undefined || as === null || as === '' ? o.name : cleanName(as, o.isDir ? 'folder' : 'file');
  if (lstatOrNull(join(dir.abs, wanted))) throw new SiteFsError('exists', `There's already something called "${wanted}" in ${dir.rel}. Restore it under another name.`);
  try { renameSync(join(box, o.name), join(dir.abs, wanted)); } catch (e) { friendly(e, 'restore that'); }
  rmSync(box, { recursive: true, force: true });
  return { path: `${dir.rel}/${wanted}` };
}

export function purgeMediaTrash(cfg: SiteFsConfig): { purged: number } {
  const cutoff = seconds(cfg.now().getTime()) - cfg.purgeDays * 86400;
  let purged = 0;
  for (const item of mediaTrashList(cfg).items) {
    if (item.trashedAt > cutoff) continue;
    try { rmSync(join(cfg.trashDir, MEDIA_TRASH, item.id), { recursive: true, force: false }); purged++; } catch { /* next time */ }
  }
  return { purged };
}

// ------------------------------------------------------------------ the whole website (File Explorer)
export function filesStat(cfg: SiteFsConfig, path: unknown): { path: string; dir: boolean } {
  const d = parsePublicPath(cfg, path ?? '', 'any');
  const st = lstatSync(d.abs);
  if (st.isSymbolicLink()) throw new SiteFsError('invalid', 'That is a shortcut; the panel only works with real folders and files.');
  if (!st.isDirectory() && !st.isFile()) throw new SiteFsError('invalid', "That's not a folder or a file.");
  return { path: d.rel, dir: st.isDirectory() };
}

export function filesList(cfg: SiteFsConfig, dir: unknown) {
  const d = parsePublicPath(cfg, dir ?? '', 'dir');
  const buckets: { name: string; items: number; modifiedAt: number }[] = [];
  const files: MediaEntry[] = [];
  let entries;
  try { entries = readdirSync(d.abs, { withFileTypes: true }); } catch (e) { friendly(e, 'open that folder'); }
  const kind = mediaKindOf(d.parts);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (e.name.startsWith('.') || (e.name === 'login-files' && !isSoftware(cfg)) || !isSafeEntryName(e.name) || buckets.length + files.length >= 5000) continue;
    let st: Stats;
    try { st = lstatSync(join(d.abs, e.name)); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let items = 0;
      try { items = readdirSync(join(d.abs, e.name)).filter((n) => !n.startsWith('.') && (n !== 'login-files' || isSoftware(cfg))).length; } catch { /* unreadable */ }
      buckets.push({ name: e.name, items, modifiedAt: seconds(st.mtimeMs) });
    } else if (st.isFile()) {
      files.push({ name: e.name, size: st.size, createdAt: seconds(st.birthtimeMs || st.mtimeMs), modifiedAt: seconds(st.mtimeMs), fits: kind ? belongs(kind, e.name) : true });
    }
  }
  return { path: d.rel, site: d.parts[0] === MEDIA || !d.parts.length ? '' : d.parts[0]!, kind, inner: d.parts, buckets, files };
}

export function filesTree(cfg: SiteFsConfig): { dirs: string[] } {
  const dirs: string[] = [''];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 20 || dirs.length >= 5000) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || (e.name === 'login-files' && !isSoftware(cfg)) || !isSafeEntryName(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatOrNull(join(abs, e.name));
      if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
      dirs.push(r);
      walk(join(abs, e.name), r, depth + 1);
    }
  };
  walk(cfg.publicDir, '', 1);
  return { dirs };
}

export function filesMkdir(cfg: SiteFsConfig, dir: unknown, name: unknown): { path: string } {
  const d = parsePublicPath(cfg, dir ?? '', 'dir');
  refuseTop(cfg, d.parts);
  const n = cleanName(name, 'folder');
  if (lstatOrNull(join(d.abs, n))) throw new SiteFsError('exists', `There's already something called "${n}" there.`);
  try { mkdirSync(join(d.abs, n), { mode: dirMode(cfg) }); } catch (e) { friendly(e, 'make that folder'); }
  return { path: d.rel ? `${d.rel}/${n}` : n };
}

export async function filesUpload(cfg: SiteFsConfig, req: { dir?: unknown; name?: unknown; size?: unknown; code?: unknown }, body: Readable):
  Promise<{ path: string; name: string; renamed: boolean; size: number; modifiedAt: number; hash: string }> {
  const d = parsePublicPath(cfg, req.dir ?? '', 'dir');
  refuseTop(cfg, d.parts);
  const wanted = cleanName(req.name, 'file');
  const problem = writeProblem(wanted, d.parts, cfg, { code: req.code === true });
  if (problem) throw new SiteFsError('invalid', problem);
  const size = req.size;
  if (!Number.isSafeInteger(size) || (size as number) < 0) throw new SiteFsError('invalid', 'Upload size missing.');
  if ((size as number) > cfg.maxUpload) throw new SiteFsError('invalid', `Files can be at most ${sizeWords(cfg.maxUpload)}. Put bigger ones in with WinSCP.`);
  const tmp = join(d.abs, tmpName());
  let out: Writable;
  try { out = createWriteStream(tmp, { flags: 'wx', mode: fileMode(cfg) }); } catch (e) { friendly(e, 'save files there'); }
  let received = 0;
  const hash = createHash('sha256');
  try {
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      body.on('error', reject);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > (size as number)) { body.destroy(); reject(new SiteFsError('invalid', 'The upload was bigger than it said.')); return; }
        hash.update(chunk);
        if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
        if (received === size) out.end();
      });
      body.on('end', () => { if (received !== size) reject(new SiteFsError('invalid', 'The upload stopped before the whole file arrived. Please try again.')); });
      out.on('finish', () => resolve());
      if (size === 0) out.end();
    });
  } catch (e) {
    await new Promise<void>((resolve) => { out.once('close', () => resolve()); out.destroy(); if (out.closed) resolve(); });
    try { unlinkSync(tmp); } catch { /* never made */ }
    friendly(e, 'save files there');
  }
  const name = placeFile(tmp, d.abs, wanted);
  const st = statSync(join(d.abs, name));
  return { path: d.rel ? `${d.rel}/${name}` : name, name, renamed: name !== wanted, size: st.size, modifiedAt: seconds(st.mtimeMs), hash: hash.digest('hex') };
}

export function filesCopy(cfg: SiteFsConfig, from: unknown, to: unknown, name: unknown, as: WriteAs = {}): { path: string; name: string; size: number; modifiedAt: number } {
  const src = parsePublicPath(cfg, from, 'file');
  const dest = parsePublicPath(cfg, to ?? '', 'dir');
  refuseTop(cfg, dest.parts);
  const wanted = name === undefined || name === null || name === '' ? src.rel.split('/').pop()! : cleanName(name, 'file');
  const problem = writeProblem(wanted, dest.parts, cfg, as);
  if (problem) throw new SiteFsError('invalid', problem);
  const tmp = join(dest.abs, tmpName());
  try { copyBytes(src.abs, tmp); } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } friendly(e, 'copy that'); }
  const placed = placeFile(tmp, dest.abs, wanted);
  const st = statSync(join(dest.abs, placed));
  return { path: dest.rel ? `${dest.rel}/${placed}` : placed, name: placed, size: st.size, modifiedAt: seconds(st.mtimeMs) };
}

export function filesMove(cfg: SiteFsConfig, from: unknown, to: unknown, name: unknown, as: WriteAs = {}): { path: string; name: string } {
  const src = parsePublicPath(cfg, from, 'any');
  refuseCode(cfg, src.abs, as);
  const dest = parsePublicPath(cfg, to ?? '', 'dir');
  refuseTop(cfg, dest.parts, src.parts);
  const isDir = lstatSync(src.abs).isDirectory();
  const wanted = name === undefined || name === null || name === '' ? (src.rel.split('/').pop() ?? src.rel) : cleanName(name, isDir ? 'folder' : 'file');
  if (isDir) {
    const fromRel = src.rel || '';
    const destRel = dest.rel || '';
    if (fromRel && (destRel === fromRel || `${destRel}/`.startsWith(`${fromRel}/`))) throw new SiteFsError('invalid', "A folder can't go inside itself.");
  } else {
    const problem = writeProblem(wanted, dest.parts, cfg, as);
    if (problem) throw new SiteFsError('invalid', problem);
  }
  const target = join(dest.abs, wanted);
  if (target === src.abs) return { path: src.rel, name: wanted };
  if (lstatOrNull(target)) throw new SiteFsError('exists', `There's already something called "${wanted}" there. Choose another name.`);
  try { renameSync(src.abs, target); } catch (e) { friendly(e, 'move that'); }
  return { path: dest.rel ? `${dest.rel}/${wanted}` : wanted, name: wanted };
}

export function filesTrash(cfg: SiteFsConfig, path: unknown, as: WriteAs = {}): { id: string; path: string; purgeAt: number } {
  const src = parsePublicPath(cfg, path, 'any');
  if (!src.rel) throw new SiteFsError('invalid', `The top of ${isSoftware(cfg) ? 'these files' : 'the website'} can't go in the trash from here.`);
  refuseTop(cfg, null, src.parts);
  refuseCode(cfg, src.abs, as);
  const isDir = lstatSync(src.abs).isDirectory();
  // the website's program files: one in the trash couldn't be put back from the panel
  if (!isDir && !isSoftware(cfg) && isProgramFile(src.rel)) throw new SiteFsError('not-allowed', PROGRAM_FILE);
  const now = cfg.now();
  const id = `${trashStamp(now)}-${randomBytes(4).toString('hex')}`;
  const box = join(cfg.trashDir, MEDIA_TRASH, id);
  const name = src.rel.split('/').pop()!;
  try {
    mkdirSync(join(cfg.trashDir, MEDIA_TRASH), { recursive: true, mode: 0o700 });
    mkdirSync(box, { mode: 0o700 });
    const trashedAt = seconds(now.getTime());
    writeFileSync(join(box, 'origin.json'), JSON.stringify({ path: src.rel, name, isDir, trashedAt } satisfies Origin), { mode: 0o600, flag: 'wx' });
    renameSync(src.abs, join(box, name));
    return { id, path: src.rel, purgeAt: trashedAt + cfg.purgeDays * 86400 };
  } catch (e) {
    try { rmSync(box, { recursive: true, force: true }); } catch { /* leave it */ }
    friendly(e, 'move that to the trash');
  }
}

export function filesRestore(cfg: SiteFsConfig, id: unknown, as: unknown, who: WriteAs = {}): { path: string } {
  if (typeof id !== 'string' || !TRASH_ID_RE.test(id)) throw new SiteFsError('invalid', "That isn't something in the trash.");
  const box = join(cfg.trashDir, MEDIA_TRASH, id);
  const o = readOrigin(box);
  if (!o || !lstatOrNull(join(box, o.name))) throw new SiteFsError('not-found', "That's no longer in the trash.");
  refuseCode(cfg, join(box, o.name), who);
  const original = parts(o.path.replace(new RegExp(`(^|/)${MEDIA}/${OLD_IMAGES}(/|$)`), `$1${MEDIA}/images$2`));
  if (!original) throw new SiteFsError('invalid', "That can't be restored.");
  const parent = original.slice(0, -1);
  let dir: PublicPath | MediaPath;
  const media = (() => { try { return parent.length && !isSoftware(cfg) ? parseMediaPath(cfg, parent.join('/'), 'dir', 'kind') : null; } catch { return null; } })();
  if (media) dir = media;
  else {
    try { dir = parsePublicPath(cfg, parent.join('/'), 'dir'); }
    catch {
      let rest = parent;
      while (rest.length) {
        rest = rest.slice(0, -1);
        try { dir = parsePublicPath(cfg, rest.join('/'), 'dir'); break; } catch { /* up */ }
      }
      dir ??= parsePublicPath(cfg, '', 'dir');
    }
  }
  // (its site folder gone: it can't land at the top; P8-1)
  if (cfg.hostsKeepTop && !isSoftware(cfg) && dir.rel === '') throw new SiteFsError('invalid', "The site folder this came from isn't there any more. Make it again on the Hosts page, then restore this.");
  const wanted = as === undefined || as === null || as === '' ? o.name : cleanName(as, o.isDir ? 'folder' : 'file');
  if (!o.isDir) {
    const problem = writeProblem(wanted, 'parts' in dir ? dir.parts : dir.rel.split('/').filter(Boolean), cfg, who);
    if (problem) throw new SiteFsError('invalid', problem);
  }
  if (lstatOrNull(join(dir.abs, wanted))) throw new SiteFsError('exists', `There's already something called "${wanted}" in ${dir.rel || (isSoftware(cfg) ? 'the top folder' : 'the website')}. Restore it under another name.`);
  try { renameSync(join(box, o.name), join(dir.abs, wanted)); } catch (e) { friendly(e, 'restore that'); }
  rmSync(box, { recursive: true, force: true });
  return { path: dir.rel ? `${dir.rel}/${wanted}` : wanted };
}

export function filesRead(cfg: SiteFsConfig, path: unknown, start: unknown, end: unknown, view = false): { info: { name: string; size: number; start: number; end: number; modifiedAt: number }; stream: Readable } {
  const f = parsePublicPath(cfg, path, 'file', view);
  const st = statSync(f.abs);
  const s = Number.isSafeInteger(start) && (start as number) >= 0 ? start as number : 0;
  const e = Number.isSafeInteger(end) && (end as number) < st.size ? end as number : st.size - 1;
  if (st.size > 0 && (s > e || s >= st.size)) throw new SiteFsError('invalid', 'That part of the file is out of range.');
  const stream = st.size === 0 ? createReadStream(f.abs, { start: 0, end: -1 }) : createReadStream(f.abs, { start: s, end: e });
  return { info: { name: f.rel.split('/').pop()!, size: st.size, start: s, end: st.size === 0 ? -1 : e, modifiedAt: seconds(st.mtimeMs) }, stream };
}

export async function filesHash(cfg: SiteFsConfig, path: unknown): Promise<{ path: string; size: number; modifiedAt: number; hash: string }> {
  const f = parsePublicPath(cfg, path, 'file');
  const before = statSync(f.abs);
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(f.abs)) hash.update(chunk as Buffer);
  } catch (e) { friendly(e, 'read that file'); }
  const after = lstatOrNull(f.abs);
  if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SiteFsError('invalid', 'The file changed while it was being read.');
  return { path: f.rel, size: before.size, modifiedAt: seconds(before.mtimeMs), hash: hash.digest('hex') };
}


// ------------------------------------------------------------------ photos/ -> images/
// Once, at the install that renamed it (docs/media-plan.md D1): in every media
// folder, photos/ becomes images/. If both are there, photos/ is emptied into
// images/ piece by piece; anything whose name is taken in images/ stays where it
// is and is reported, never overwritten. An emptied photos/ is removed.
export function mediaRenamePhotos(cfg: SiteFsConfig): { renamed: string[]; merged: string[]; left: string[] } {
  const renamed: string[] = [];
  const merged: string[] = [];
  const left: string[] = [];
  const mergeInto = (from: string, to: string, rel: string) => {
    for (const name of readdirSync(from).sort()) {
      const a = join(from, name);
      const b = join(to, name);
      const sa = lstatSync(a);
      const sb = lstatOrNull(b);
      if (!sb) { renameSync(a, b); continue; }
      if (sa.isDirectory() && !sa.isSymbolicLink() && sb.isDirectory() && !sb.isSymbolicLink()) mergeInto(a, b, `${rel}/${name}`);
      else left.push(`${rel}/${name}`);
    }
    if (readdirSync(from).length === 0) rmdirSync(from);
  };
  for (const { folder, hasMedia } of mediaSites(cfg).folders) {
    if (!hasMedia) continue;
    const media = join(cfg.publicDir, folder, MEDIA);
    const rel = folder ? `${folder}/${MEDIA}` : MEDIA;
    const old = lstatOrNull(join(media, OLD_IMAGES));
    if (!old || old.isSymbolicLink() || !old.isDirectory()) continue;
    const now = lstatOrNull(join(media, 'images'));
    try {
      if (!now) { renameSync(join(media, OLD_IMAGES), join(media, 'images')); renamed.push(rel); }
      else if (now.isDirectory() && !now.isSymbolicLink()) { mergeInto(join(media, OLD_IMAGES), join(media, 'images'), `${rel}/${OLD_IMAGES}`); merged.push(rel); }
      else left.push(`${rel}/${OLD_IMAGES}`);
    } catch (e) { friendly(e, `rename ${rel}/${OLD_IMAGES}`); }
  }
  return { renamed, merged, left };
}
