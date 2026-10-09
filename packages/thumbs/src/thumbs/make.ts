// Making one thumbnail (docs/media-plan.md D18-D19). Runs inside pammy-thumbs,
// which can read her website (like the web server) and nothing else, has no
// network and can write nowhere but its own /tmp. Files come from anyone, so:
//   - the path is checked step by step, never through a shortcut, and the file
//     is opened with O_NOFOLLOW; the tools get that open file, not the name;
//   - pictures are decoded by sharp (libvips) with a pixel limit and a timeout;
//   - video frames and cover art come from ffmpeg, PDF pages from pdftoppm,
//     each a child process under a memory limit, a CPU limit and a 10-second
//     timeout, and ffmpeg only reads the plain file formats (no playlists);
//   - what comes back is always re-encoded by sharp as a small WebP.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { isSafeEntryName } from '@panel/core/names';
import { extensionOf, iconFor, type IconName } from './icons.ts';

export const THUMB_SIZE = 320;
export const TIME_LIMIT_MS = 10_000;
// the most a tool may map (virtual memory; the service as a whole has MemoryMax too)
export const TOOL_MEMORY = 768 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;          // e.g. 8000 x 6000
const MAX_TOOL_OUTPUT = 32 * 1024 * 1024;

export type ThumbsConfig = {
  publicDir: string;                     // /pamela/public
  tools: { ffmpeg: string; pdftoppm: string; prlimit: string };
  timeLimitMs?: number;                  // per tool run (tests shorten it)
};
export const DEFAULT_TOOLS = { ffmpeg: '/usr/bin/ffmpeg', pdftoppm: '/usr/bin/pdftoppm', prlimit: '/usr/bin/prlimit' };

export type Thumb = { webp: Buffer; width: number; height: number } | { icon: IconName; why: string };

export class ThumbError extends Error {
  code: 'invalid' | 'not-found';
  constructor(code: ThumbError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

sharp.concurrency(1);
sharp.cache(false);

// "olivia/media/images/2026/dog.jpg": a real file inside one of a media folder's
// four, with nothing on the way a shortcut. Opened without following one either.
export function openMediaFile(cfg: ThumbsConfig, path: unknown, kind: unknown): { fd: number; st: Stats; name: string } {
  if (typeof path !== 'string') throw new ThumbError('invalid', 'No path.');
  const p = path.split('/');
  if (!p.length || p.length > 24 || p.some((x) => !isSafeEntryName(x)) || p.includes('login-files')) throw new ThumbError('invalid', "That isn't a file the panel can make a picture of.");
  if (typeof kind === 'string' && !['images', 'files', 'audio', 'video', 'pages', 'other'].includes(kind)) throw new ThumbError('invalid', "That isn't a file of that kind.");
  let abs = cfg.publicDir;
  for (const [i, part] of p.entries()) {
    abs = join(abs, part);
    let st: Stats;
    try { st = lstatSync(abs); } catch { throw new ThumbError('not-found', "That file isn't there."); }
    if (st.isSymbolicLink()) throw new ThumbError('invalid', 'That goes through a shortcut.');
    if (i < p.length - 1 ? !st.isDirectory() : !st.isFile()) throw new ThumbError('invalid', "That isn't a file.");
  }
  let fd: number;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOCTTY); } catch { throw new ThumbError('not-found', "That file can't be read."); }
  const st = fstatSync(fd);
  if (!st.isFile()) { closeSync(fd); throw new ThumbError('invalid', "That isn't a file."); }
  return { fd, st, name: p[p.length - 1]! };
}

// Any picture (JPEG, PNG, WebP, GIF, AVIF, SVG, or a frame from a tool) -> a WebP
// that fits THUMB_SIZE, turned the right way up. As forgiving as a browser about
// small flaws (a picture that shows on her site gets a thumbnail too).
export async function toWebp(input: Buffer): Promise<{ webp: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'none', pages: 1 })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75, effort: 4 })
    .timeout({ seconds: TIME_LIMIT_MS / 1000 })
    .toBuffer({ resolveWithObject: true });
  return { webp: data, width: info.width, height: info.height };
}

// A tool run on the open file (it sees it as /proc/self/fd/3), its picture on stdout.
export function runTool(cfg: ThumbsConfig, tool: string, args: string[], fd: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const limit = cfg.timeLimitMs ?? TIME_LIMIT_MS;
    // its own process group, so stopping it stops anything it started too
    const child = spawn(cfg.tools.prlimit, [`--as=${TOOL_MEMORY}`, `--cpu=${Math.ceil(limit / 1000)}`, '--core=0', '--nofile=64', '--', tool, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', fd], detached: true, env: { PATH: '/usr/bin:/bin' }, cwd: '/',
    });
    let stopped: string | null = null;
    const stop = (why: string) => {
      stopped ??= why;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => stop('too slow'), limit);
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout!.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_TOOL_OUTPUT) stop('too much output'); else out.push(c);
    });
    child.stderr!.on('data', (c: Buffer) => { if (err.length < 2000) err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !stopped) resolve(Buffer.concat(out));
      else if (stopped) reject(new Error(`${tool} stopped: ${stopped}`));
      else reject(new Error(signal ? `${tool} stopped (${signal}: too big or too slow)` : `${tool} failed (${code}): ${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

const FD = '/proc/self/fd/3';
// Plain files only: no playlists, concat lists or anything else that points at other files.
const VIDEO_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,avi';
const AUDIO_FORMATS = 'mp3,mov,mp4,m4a,3gp,3g2,mj2,aac,wav,ogg,flac,matroska,webm';
const ffmpegArgs = (formats: string, seek: string | null) => [
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-protocol_whitelist', 'file,fd', '-format_whitelist', formats,
  ...(seek ? ['-ss', seek] : []), '-i', FD, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
  '-vf', `scale=${THUMB_SIZE * 2}:${THUMB_SIZE * 2}:force_original_aspect_ratio=decrease`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
];

function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

// The thumbnail for one media file, or the icon to show instead (and why).
export async function makeThumb(cfg: ThumbsConfig, path: unknown, kind: unknown): Promise<Thumb> {
  const { fd, st, name } = openMediaFile(cfg, path, kind);
  const icon = iconFor(kind as string, name);
  try {
    if (kind === 'images') {
      if (st.size > MAX_IMAGE_BYTES) return { icon, why: 'too big to make a picture of' };
      try { return await toWebp(readAll(fd, st.size)); } catch (e) { return { icon, why: `not a picture that can be read (${(e as Error).message})` }; }
    }
    if (kind === 'video') {
      // a frame from about a second in; a shorter video, its first frame
      for (const seek of ['1', null]) {
        try {
          const png = await runTool(cfg, cfg.tools.ffmpeg, ffmpegArgs(VIDEO_FORMATS, seek), fd);
          if (png.length) return await toWebp(png);
        } catch (e) { if (seek === null) return { icon, why: (e as Error).message }; }
      }
      return { icon, why: 'no picture in it' };
    }
    if (kind === 'audio') {
      try {
        const png = await runTool(cfg, cfg.tools.ffmpeg, ffmpegArgs(AUDIO_FORMATS, null), fd);
        return png.length ? await toWebp(png) : { icon, why: 'no cover picture' };
      } catch { return { icon, why: 'no cover picture' }; }
    }
    if (extensionOf(name) === 'pdf') {
      try {
        const png = await runTool(cfg, cfg.tools.pdftoppm, ['-f', '1', '-l', '1', '-singlefile', '-scale-to', String(THUMB_SIZE * 2), '-png', FD], fd);
        return await toWebp(png);
      } catch (e) { return { icon, why: (e as Error).message }; }
    }
    return { icon, why: 'no picture for this kind of file' };
  } finally {
    closeSync(fd);
  }
}
