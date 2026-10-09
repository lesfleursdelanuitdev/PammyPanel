// The thumbnail service (src/thumbs/), over a real socket, on a throwaway website.
// ffmpeg and pdftoppm are stood in for by small scripts, so the plumbing (the
// open file on fd 3, the limits, the time-out) is tested everywhere; the real
// tools are tried too where they're installed.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { callJsonLine, CallError } from '@panel/core/jsonline';
import { iconFor } from '@panel/thumbs/thumbs/icons';
import { DEFAULT_TOOLS, makeThumb, type ThumbsConfig } from '@panel/thumbs/thumbs/make';
import { createThumbsServer } from '@panel/thumbs/thumbs/service';

let dir: string;
let pub: string;
let sock: string;
let server: ReturnType<typeof createThumbsServer>;
let cfg: ThumbsConfig;
const have = (tool: string) => existsSync(tool);

const put = (rel: string, data: Buffer | string) => { mkdirSync(join(pub, rel, '..'), { recursive: true }); writeFileSync(join(pub, rel), data); };
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
const ask = <T = any>(req: Record<string, unknown>) => callJsonLine<T>(sock, req, 'thumbnail service', 30_000);
const refusal = async (req: Record<string, unknown>) => { try { await ask(req); return 'ok'; } catch (e) { return (e as CallError).code; } };
const size = async (b64: string) => { const m = await sharp(Buffer.from(b64, 'base64')).metadata(); return [m.format, m.width, m.height]; };

let PNG: Buffer;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-thumbs-'));
  pub = join(dir, 'public');
  PNG = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#c0392b' } }).png().toBuffer();
  cfg = {
    publicDir: pub,
    // stand-ins: "ffmpeg" hands back whatever the file on fd 3 holds; "pdftoppm" too
    tools: { ffmpeg: script('fake-ffmpeg', 'cat /proc/self/fd/3'), pdftoppm: script('fake-pdftoppm', 'cat /proc/self/fd/3'), prlimit: DEFAULT_TOOLS.prlimit },
    timeLimitMs: 1500,
  };
  sock = join(dir, 'thumbs.sock');
  server = createThumbsServer(cfg);
  await new Promise<void>((r) => server.listen(sock, r));
});
after(() => new Promise<void>((r) => server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); })));

describe('the thumbnail service', () => {
  it('makes a small WebP of a picture, fitted inside 320 x 320 and never enlarged', async () => {
    put('media/images/wide.png', PNG);
    const t = await ask({ op: 'thumb', path: 'media/images/wide.png', kind: 'images' });
    assert.deepEqual([t.width, t.height], [320, 160]);
    assert.deepEqual(await size(t.webp), ['webp', 320, 160]);
    put('olivia/media/images/tiny.png', await sharp({ create: { width: 20, height: 10, channels: 3, background: '#000' } }).png().toBuffer());
    assert.deepEqual([(await ask({ op: 'thumb', path: 'olivia/media/images/tiny.png', kind: 'images' })).width], [20]);
  });

  it('SVG, WebP, GIF and AVIF pictures too', async () => {
    put('media/images/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/></svg>');
    assert.deepEqual(await size((await ask({ op: 'thumb', path: 'media/images/logo.svg', kind: 'images' })).webp), ['webp', 200, 100]);
    for (const fmt of ['webp', 'gif', 'avif'] as const) {
      put(`media/images/x.${fmt}`, await sharp(PNG)[fmt]().toBuffer());
      assert.equal((await ask({ op: 'thumb', path: `media/images/x.${fmt}`, kind: 'images' })).width, 320, fmt);
    }
  });

  it('an SVG that points at other files gets nothing from them', async () => {
    put('media/images/sneaky.svg', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="50">
      <image xlink:href="file:///etc/passwd" width="50" height="50"/><image xlink:href="../wide.png" width="50" height="50"/></svg>`);
    const t = await ask({ op: 'thumb', path: 'media/images/sneaky.svg', kind: 'images' });
    const { data } = await sharp(Buffer.from(t.webp, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(data.every((b, i) => i % 4 !== 3 || b === 0), 'fully see-through: nothing drawn from elsewhere');
  });

  it('a broken picture, or one far too big, gets its icon and says why', async () => {
    put('media/images/broken.jpg', 'not a picture at all');
    const broken = await ask({ op: 'thumb', path: 'media/images/broken.jpg', kind: 'images' });
    assert.equal(broken.icon, 'image');
    assert.match(broken.why, /not a picture that can be read/);
    // a PNG header claiming 40000 x 40000 pixels: refused before anything is decoded
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(40_000, 0); ihdr.writeUInt32BE(40_000, 4); ihdr[8] = 8; ihdr[9] = 2;
    put('media/images/bomb.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]));
    const bomb = await ask({ op: 'thumb', path: 'media/images/bomb.png', kind: 'images' });
    assert.equal(bomb.icon, 'image');
  });

  it('video and audio: a frame or the cover, handed over as the open file (fd 3), else the icon', async () => {
    put('media/video/clip.mp4', PNG);                       // the stand-in ffmpeg "decodes" it as-is
    assert.equal((await ask({ op: 'thumb', path: 'media/video/clip.mp4', kind: 'video' })).width, 320);
    put('media/audio/song.mp3', PNG);
    assert.equal((await ask({ op: 'thumb', path: 'media/audio/song.mp3', kind: 'audio' })).height, 160);
    put('media/audio/plain.mp3', '');
    assert.deepEqual(await ask({ op: 'thumb', path: 'media/audio/plain.mp3', kind: 'audio' }), { icon: 'audio', why: 'no cover picture' });
    put('media/files/menu.pdf', PNG);
    assert.equal((await ask({ op: 'thumb', path: 'media/files/menu.pdf', kind: 'files' })).width, 320);
    put('media/files/notes.docx', 'x');
    assert.deepEqual(await ask({ op: 'thumb', path: 'media/files/notes.docx', kind: 'files' }), { icon: 'document', why: 'no picture for this kind of file' });
  });

  it('a tool that takes too long is stopped, and the icon stands in', async () => {
    const slow = { ...cfg, tools: { ...cfg.tools, ffmpeg: script('slow-ffmpeg', 'sleep 30') } };
    put('media/video/slow.mp4', 'x');
    const started = Date.now();
    const t = await makeThumb(slow, 'media/video/slow.mp4', 'video');
    assert.equal('icon' in t && t.icon, 'video');
    assert.match('why' in t ? t.why : '', /stopped: too slow/);
    assert.ok(Date.now() - started < 6000, 'within the time limit (twice: a second in, then the start)');
  });

  it('a tool runs with limits on memory, CPU and open files', async () => {
    const limits = { ...cfg, tools: { ...cfg.tools, pdftoppm: script('limits', 'echo "as=$(ulimit -v) cpu=$(ulimit -t) nofile=$(ulimit -n)" >&2; exit 3') } };
    put('media/files/limits.pdf', 'x');
    const t = await makeThumb(limits, 'media/files/limits.pdf', 'files');
    assert.match('why' in t ? t.why : '', /failed \(3\): as=786432 cpu=2 nofile=64$/, 'kB of address space, CPU seconds, open files');
  });

  it('any public file, never through a shortcut', async () => {
    put('olivia/index.html', 'x');
    symlinkSync(join(pub, 'media', 'images', 'wide.png'), join(pub, 'media', 'images', 'link.png'));
    mkdirSync(join(pub, 'shortcut-dir'));
    symlinkSync(join(pub, 'media'), join(pub, 'olivia', 'media2'));
    put('olivia/deep/media/images/x.png', PNG);
    for (const [path, kind] of [
      ['media/images/link.png', 'images'], ['olivia/media2/images/wide.png', 'images'],
      ['media/images/../images/wide.png', 'images'], ['/etc/passwd', 'files'], ['media/images', 'images'], [42, 'images'],
    ] as const) assert.equal(await refusal({ op: 'thumb', path, kind }), 'invalid', String(path));
    assert.equal(await refusal({ op: 'thumb', path: 'media/images/nope.png', kind: 'images' }), 'not-found');
    assert.equal(await refusal({ op: 'rm', path: 'media/images/wide.png' }), 'invalid');
    const page = await ask({ op: 'thumb', path: 'olivia/index.html', kind: 'pages' });
    assert.deepEqual(page, { icon: 'text', why: 'no picture for this kind of file' });
    const nested = await ask({ op: 'thumb', path: 'olivia/deep/media/images/x.png', kind: 'images' });
    assert.equal(nested.width, 320);
  });

  it('says which tools it has', async () => {
    const t = await ask({ op: 'tools' });
    assert.equal(t.ffmpeg, true);
    assert.match(t.sharp, /^\d/);
  });

  it('icons by type', () => {
    assert.deepEqual(['a.xlsx', 'b.ZIP', 'c.pptx', 'd.txt', 'e.pdf', 'f.weird'].map((n) => iconFor('files', n)), ['spreadsheet', 'archive', 'presentation', 'text', 'pdf', 'file']);
  });
});

// The real tools, where they're installed (the install puts them on the server).
describe('the real ffmpeg and pdftoppm', { skip: !have(DEFAULT_TOOLS.ffmpeg) || !have(DEFAULT_TOOLS.pdftoppm) ? 'ffmpeg or pdftoppm not installed here' : false }, () => {
  const real = () => ({ ...cfg, tools: DEFAULT_TOOLS, timeLimitMs: 10_000 });
  const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile(cmd, args, (e) => (e ? reject(e) : resolve())));
  });

  it('a frame from a real video, and from one shorter than a second', async () => {
    await run(DEFAULT_TOOLS.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(pub, 'media', 'video', 'real.mp4')]);
    await run(DEFAULT_TOOLS.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=0.3', join(pub, 'media', 'video', 'short.webm')]);
    for (const f of ['real.mp4', 'short.webm']) {
      const t = await makeThumb(real(), `media/video/${f}`, 'video');
      assert.ok('webp' in t, `${f}: ${'why' in t ? t.why : ''}`);
      assert.deepEqual([t.width, t.height], [320, 180]);
    }
  });

  it('the cover of a real song, or the icon when it has none', async () => {
    writeFileSync(join(dir, 'cover.png'), PNG);
    await run(DEFAULT_TOOLS.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-i', join(dir, 'cover.png'), '-map', '0:a', '-map', '1:v', '-c:v', 'png', '-disposition:v', 'attached_pic', join(pub, 'media', 'audio', 'covered.mp3')]);
    await run(DEFAULT_TOOLS.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', join(pub, 'media', 'audio', 'bare.mp3')]);
    const covered = await makeThumb(real(), 'media/audio/covered.mp3', 'audio');
    assert.ok('webp' in covered && covered.width === 320, 'why' in covered ? covered.why : '');
    assert.deepEqual(await makeThumb(real(), 'media/audio/bare.mp3', 'audio'), { icon: 'audio', why: 'no cover picture' });
  });

  it('a playlist pretending to be a video reads nothing else', async () => {
    put('media/video/list.mp4', `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${join(pub, 'media', 'video', 'real.mp4')}\n#EXT-X-ENDLIST\n`);
    const t = await makeThumb(real(), 'media/video/list.mp4', 'video');
    assert.equal('icon' in t && t.icon, 'video');
  });

  it('the first page of a real PDF', async () => {
    // a one-page PDF, written out by hand
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R >>'];
    const stream = '0 0 1 rg 20 20 360 160 re f';
    let pdf = '%PDF-1.4\n';
    const offs: number[] = [];
    for (const [i, o] of [...objs, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`].entries()) { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; }
    const xref = pdf.length;
    pdf += `xref\n0 5\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    put('media/files/real.pdf', pdf);
    const t = await makeThumb(real(), 'media/files/real.pdf', 'files');
    assert.ok('webp' in t, 'why' in t ? t.why : '');
    assert.deepEqual([t.width, t.height], [320, 160]);
  });
});
