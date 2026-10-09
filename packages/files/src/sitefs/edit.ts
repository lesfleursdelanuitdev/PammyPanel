// The editor's side of the website folder helper (docs/editor-plan.md): saving a
// text file, making one, and the earlier versions every save keeps (D1).
// Everything here runs as pamela and trusts nothing it's sent, like media.ts.
//
// A save replaces the file atomically: the new text goes to a hidden temporary
// file in the same folder, is flushed to disk, and is renamed over the old one,
// so the website never serves half a page. It's refused if the file isn't the
// one the editor opened (its sha256 differs): someone changed it meanwhile.
//
// Versions: /pamela/trash/.versions/<stamp>-<random>/ holding `file` (the text as
// it was before a save) and version.json. Hidden, outside the web root, purged
// after 30 days with the trash. Saves close together from one open editor (the
// same person and `session`, within VERSION_QUIET seconds, nothing else changing
// the file in between) share one version, so pressing Ctrl+S every minute doesn't
// fill the disk; a save from anywhere else always keeps what it replaces. At most
// MAX_VERSIONS are kept per file.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, createReadStream, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { isSafeEntryName, trashStamp } from '@panel/core/names';
import {
  CODE, cleanName, copyBytes, extensionOf, fileMode, friendly, isSoftware, lstatOrNull, parsePublicPath, parts, placeFile, refuseTop, seconds, tmpName, writeProblem,
  type WriteAs,
} from './media.ts';
import { SiteFsError, type SiteFsConfig } from './ops.ts';

// What the editor opens (C2). Anything else opens the way it always did.
export const EDITABLE: ReadonlySet<string> = new Set(['html', 'htm', 'css', 'js', 'txt', 'md', 'json', 'xml', 'svg']);
export const MAX_TEXT = 2 * 1024 * 1024;
export const VERSIONS = '.versions';
export const VERSION_QUIET = 300;
export const MAX_VERSIONS = 50;
const VERSION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

// A version: the file as it was (modifiedAt, hash, size) until `by` saved over it
// at savedAt, from the editor opened as `session`. `after`: what the file held
// after the latest save this version covers (a later quick save from the same
// editor only moves this on).
// order: when exactly, for sorting saves within the same second.
export type VersionMeta = { path: string; name: string; hash: string; size: number; modifiedAt: number; savedAt: number; by: string; after: string; session?: string; order?: number };
export type Version = VersionMeta & { id: string };
// version: the earlier version that holds what this save replaced; newVersion: made
// by this save (not an earlier save of the same quick run).
export type Saved = { path: string; name: string; size: number; modifiedAt: number; hash: string; created: boolean; unchanged: boolean; version: string | null; newVersion: boolean };

// A software root's PHP opens in the editor too (docs/catalog-plan.md step 3,
// Q3-2); whether it may be saved is writeProblem's (panel admins only).
export function editProblem(name: string, software = false): string | null {
  const ext = extensionOf(name);
  if (EDITABLE.has(ext) || (software && CODE.has(ext))) return null;
  return `The editor works on ${[...EDITABLE].map((e) => `.${e}`).join(', ')} files${ext ? `, not .${ext}` : ''}.`;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function hashFile(abs: string): Promise<string> {
  const h = createHash('sha256');
  try {
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  } catch (e) { friendly(e, 'read that file'); }
  return h.digest('hex');
}

function checkText(buf: Buffer) {
  if (buf.length > MAX_TEXT) throw new SiteFsError('invalid', 'The editor saves files of up to 2 MB. Put bigger ones in with WinSCP.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new SiteFsError('invalid', "That isn't text the editor can save (it isn't UTF-8)."); }
}

// The whole body of a stream request: exactly `size` bytes.
// A refusal still reads (and drops) the rest, or the socket would wait for its timeout.
function readBody(body: Readable, size: unknown): Promise<Buffer> {
  const refuse = (message: string) => { body.resume(); return Promise.reject(new SiteFsError('invalid', message)); };
  if (!Number.isSafeInteger(size) || (size as number) < 0) return refuse('Size missing.');
  if ((size as number) > MAX_TEXT) return refuse('The editor saves files of up to 2 MB. Put bigger ones in with WinSCP.');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    let over = false;
    if (size === 0) { body.resume(); resolve(Buffer.alloc(0)); return; }
    body.on('error', reject);
    body.on('data', (c: Buffer) => {
      if (over) return;
      got += c.length;
      if (got > (size as number)) { over = true; reject(new SiteFsError('invalid', 'The text was longer than it said.')); return; }
      chunks.push(c);
      if (got === size) resolve(Buffer.concat(chunks));
    });
    body.on('end', () => { if (got !== size) reject(new SiteFsError('invalid', 'The text stopped before it all arrived. Please try again.')); });
  });
}

// A hidden temporary file in `dir` with these bytes, on disk (fsync) before it's used.
function writeTemp(dir: string, buf: Buffer, mode: number): string {
  const tmp = join(dir, tmpName());
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return tmp;
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(tmp); } catch { /* never made */ }
    friendly(e, 'save files there');
  }
}

// ------------------------------------------------------------------ versions
const versionsRoot = (cfg: SiteFsConfig) => join(cfg.trashDir, VERSIONS);

function readMeta(box: string): VersionMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(box, 'version.json'), 'utf8')) as VersionMeta;
    return typeof m.path === 'string' && typeof m.name === 'string' && isSafeEntryName(m.name) && Number.isSafeInteger(m.savedAt)
      && typeof m.hash === 'string' && typeof m.by === 'string' ? m : null;
  } catch { return null; }
}

function allVersions(cfg: SiteFsConfig): Version[] {
  let ids: string[] = [];
  try { ids = readdirSync(versionsRoot(cfg)); } catch { return []; }
  const out: Version[] = [];
  for (const id of ids) {
    if (!VERSION_ID_RE.test(id)) continue;
    const m = readMeta(join(versionsRoot(cfg), id));
    if (m) out.push({ ...m, id });
    if (out.length >= 20_000) break;
  }
  return out.sort((a, b) => b.savedAt - a.savedAt || (b.order ?? 0) - (a.order ?? 0) || b.id.localeCompare(a.id));
}

// Milliseconds, and never the same twice in this process.
let lastOrder = 0;
const nextOrder = (cfg: SiteFsConfig) => (lastOrder = Math.max(cfg.now().getTime(), lastOrder + 1));

const versionsOf = (cfg: SiteFsConfig, rel: string) => allVersions(cfg).filter((v) => v.path === rel);

// Before a save replaces `abs` (whose sha256 is `current`) with text whose sha256
// is `next`: keep what's there now, unless this save continues the same person's
// quick run of saves. Returns the version that covers it.
function keepVersion(cfg: SiteFsConfig, rel: string, abs: string, current: string, next: string, actor: string, session: string | null): { id: string; made: boolean } {
  const now = seconds(cfg.now().getTime());
  const had = versionsOf(cfg, rel);
  const newest = had[0];
  if (newest && session && newest.session === session && newest.by === actor && now - newest.savedAt < VERSION_QUIET && newest.after === current) {
    const { id, ...meta } = newest;
    try { writeFileSync(join(versionsRoot(cfg), id, 'version.json'), JSON.stringify({ ...meta, after: next } satisfies VersionMeta), { mode: 0o600 }); } catch (e) { friendly(e, 'keep the earlier version'); }
    return { id, made: false };
  }
  const st = statSync(abs);
  const id = `${trashStamp(cfg.now())}-${randomBytes(4).toString('hex')}`;
  const box = join(versionsRoot(cfg), id);
  try {
    mkdirSync(versionsRoot(cfg), { recursive: true, mode: 0o700 });
    mkdirSync(box, { mode: 0o700 });
    copyBytes(abs, join(box, 'file'));
    const meta: VersionMeta = { path: rel, name: rel.split('/').pop()!, hash: current, size: st.size, modifiedAt: seconds(st.mtimeMs), savedAt: now, by: actor, after: next, ...(session ? { session } : {}), order: nextOrder(cfg) };
    writeFileSync(join(box, 'version.json'), JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    try { rmSync(box, { recursive: true, force: true }); } catch { /* leave it */ }
    friendly(e, 'keep the earlier version');
  }
  for (const old of had.slice(MAX_VERSIONS - 1)) {
    try { rmSync(join(versionsRoot(cfg), old.id), { recursive: true, force: true }); } catch { /* next time */ }
  }
  return { id, made: true };
}

export function filesVersions(cfg: SiteFsConfig, path: unknown): { path: string; versions: Omit<Version, 'after' | 'session' | 'order'>[]; keepDays: number } {
  const p = parts(path);
  if (!p || !p.length) throw new SiteFsError('invalid', "That isn't a file.");
  const rel = p.join('/');
  return { path: rel, versions: versionsOf(cfg, rel).map(({ after: _after, session: _session, order: _order, ...v }) => v), keepDays: cfg.purgeDays };
}

function versionById(cfg: SiteFsConfig, id: unknown): Version {
  if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) throw new SiteFsError('invalid', "That isn't an earlier version.");
  const box = join(versionsRoot(cfg), id);
  const m = readMeta(box);
  const st = lstatOrNull(join(box, 'file'));
  if (!m || !st || !st.isFile()) throw new SiteFsError('not-found', 'That earlier version is no longer kept.');
  return { ...m, id };
}

export function filesVersionRead(cfg: SiteFsConfig, id: unknown): { info: Version; stream: Readable } {
  const v = versionById(cfg, id);
  return { info: v, stream: createReadStream(join(versionsRoot(cfg), v.id, 'file')) };
}

// Restoring is a save of the old text (so what's there now becomes a version too).
// `expect`: the file as the editor last saw it; null if it's gone (it's made again).
export async function filesVersionRestore(cfg: SiteFsConfig, id: unknown, expect: unknown, actor: unknown, code?: unknown): Promise<Saved & { from: Version }> {
  const v = versionById(cfg, id);
  let buf: Buffer;
  try { buf = readFileSync(join(versionsRoot(cfg), v.id, 'file')); } catch (e) { friendly(e, 'read that earlier version'); }
  const saved = await saveText(cfg, { path: v.path, expect, create: expect === null ? 'exact' : false, actor, code }, buf);
  return { ...saved, from: v };
}

export function purgeVersions(cfg: SiteFsConfig): { purged: number } {
  const cutoff = seconds(cfg.now().getTime()) - cfg.purgeDays * 86400;
  let purged = 0;
  for (const v of allVersions(cfg)) {
    if (v.savedAt > cutoff) continue;
    try { rmSync(join(versionsRoot(cfg), v.id), { recursive: true, force: false }); purged++; } catch { /* next time */ }
  }
  return { purged };
}

// ------------------------------------------------------------------ saving
// One save at a time, so two saves of the same file can't both pass the check.
let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(f: () => Promise<T>): Promise<T> => {
  const run = queue.then(f, f);
  queue = run.catch(() => undefined);
  return run;
};

// create: false = replace the file the editor opened (expect = its sha256);
// 'exact' = a new file at exactly `path`; 'free' = a new file there, or the first
// free name after it ("page-2.html"): "Save mine as a copy". session: the open
// editor it comes from (see keepVersion), if any.
export type SaveRequest = { path: unknown; expect: unknown; create: false | 'exact' | 'free'; actor: unknown; session?: unknown; code?: unknown };

export function saveText(cfg: SiteFsConfig, req: SaveRequest, buf: Buffer): Promise<Saved> {
  return oneAtATime(async () => {
    checkText(buf);
    const actor = typeof req.actor === 'string' && req.actor ? req.actor.slice(0, 64) : 'someone';
    const as: WriteAs = { code: req.code === true };
    const hash = sha256(buf);
    if (req.create) {
      const p = parts(req.path);
      if (!p || !p.length) throw new SiteFsError('invalid', 'Please give the file a name.');
      const dir = parsePublicPath(cfg, p.slice(0, -1).join('/'), 'dir');
      refuseTop(cfg, dir.parts);
      const name = cleanName(p[p.length - 1], 'file');
      const problem = editProblem(name, isSoftware(cfg)) ?? writeProblem(name, dir.parts, cfg, as);
      if (problem) throw new SiteFsError('invalid', problem);
      const tmp = writeTemp(dir.abs, buf, fileMode(cfg));
      let placed = name;
      if (req.create === 'free') placed = placeFile(tmp, dir.abs, name);
      else {
        try { linkSync(tmp, join(dir.abs, name)); } catch (e) {
          try { unlinkSync(tmp); } catch { /* gone */ }
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new SiteFsError('exists', `There's already something called "${name}" there.`);
          friendly(e, 'save files there');
        }
        unlinkSync(tmp);
      }
      const st = statSync(join(dir.abs, placed));
      return { path: dir.rel ? `${dir.rel}/${placed}` : placed, name: placed, size: st.size, modifiedAt: seconds(st.mtimeMs), hash, created: true, unchanged: false, version: null, newVersion: false };
    }
    const f = parsePublicPath(cfg, req.path, 'file');
    const name = f.parts[f.parts.length - 1]!;
    const problem = editProblem(name, isSoftware(cfg)) ?? writeProblem(name, f.parts.slice(0, -1), cfg, as);
    if (problem) throw new SiteFsError('invalid', problem);
    if (typeof req.expect !== 'string') throw new SiteFsError('invalid', 'Which copy of the file was opened is missing.');
    const before = statSync(f.abs);
    const current = await hashFile(f.abs);
    if (current !== req.expect) throw new SiteFsError('conflict', 'This file was changed since you opened it (by someone else, or in another window).');
    if (current === hash) return { path: f.rel, name, size: before.size, modifiedAt: seconds(before.mtimeMs), hash, created: false, unchanged: true, version: null, newVersion: false };
    const session = typeof req.session === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(req.session) ? req.session : null;
    const kept = keepVersion(cfg, f.rel, f.abs, current, hash, actor, session);
    const dir = join(cfg.publicDir, ...f.parts.slice(0, -1));
    const tmp = writeTemp(dir, buf, before.mode & 0o7777);
    try { renameSync(tmp, f.abs); } catch (e) {
      try { unlinkSync(tmp); } catch { /* gone */ }
      friendly(e, 'save that file');
    }
    const st = statSync(f.abs);
    return { path: f.rel, name, size: st.size, modifiedAt: seconds(st.mtimeMs), hash, created: false, unchanged: false, version: kept.id, newVersion: kept.made };
  });
}

// The stream op: {op, path, expect, create, session, size} then exactly `size` bytes of UTF-8.
export async function filesWrite(cfg: SiteFsConfig, req: { path?: unknown; expect?: unknown; create?: unknown; size?: unknown; actor?: unknown; session?: unknown; code?: unknown }, body: Readable): Promise<Saved> {
  const buf = await readBody(body, req.size);
  const create = req.create === 'exact' || req.create === 'free' ? req.create : false;
  return saveText(cfg, { path: req.path, expect: req.expect ?? null, create, actor: req.actor, session: req.session, code: req.code }, buf);
}
