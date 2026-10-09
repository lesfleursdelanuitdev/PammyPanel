// Made-up media for trying the Media tab: pictures (drawn here, so no copyright
// questions), short videos and songs from ffmpeg's test sources, and PDFs
// written by hand. Nothing is downloaded.
//   node tools/make-test-media.ts <out dir>
// It writes <out>/images, files, audio, video (with a couple of folders inside).
// tools/put-test-media.sh puts them into a folder's media folder, as pamela.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const out = process.argv[2];
if (!out) { console.error('usage: node tools/make-test-media.ts <out dir>'); process.exit(2); }
const put = (rel: string, data: Buffer | string) => { mkdirSync(join(out, rel, '..'), { recursive: true }); writeFileSync(join(out, rel), data); };

// A little landscape: sky, sun, two hills, and a caption.
const scene = (w: number, h: number, sky: [string, string], hills: [string, string], sun: string, caption: string) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <circle cx="${w * 0.72}" cy="${h * 0.32}" r="${Math.min(w, h) * 0.11}" fill="${sun}"/>
  <path d="M0 ${h * 0.7} Q ${w * 0.3} ${h * 0.45} ${w * 0.6} ${h * 0.68} T ${w} ${h * 0.62} V ${h} H 0 Z" fill="${hills[0]}"/>
  <path d="M0 ${h * 0.82} Q ${w * 0.4} ${h * 0.66} ${w} ${h * 0.84} V ${h} H 0 Z" fill="${hills[1]}"/>
  <text x="${w * 0.05}" y="${h * 0.93}" font-family="DejaVu Sans, sans-serif" font-size="${Math.round(h * 0.06)}" fill="#fff" fill-opacity="0.9">${caption}</text>
</svg>`;

const pictures: [string, number, number, [string, string], [string, string], string, string][] = [
  ['sunset-beach.jpg', 1600, 1000, ['#f39c12', '#e74c3c'], ['#6c3483', '#4a235a'], '#fdebd0', 'Sunset at the beach'],
  ['morning-lake.jpg', 1600, 1067, ['#85c1e9', '#d6eaf8'], ['#1e8449', '#145a32'], '#fef9e7', 'Morning by the lake'],
  ['autumn-hills.jpg', 1200, 800, ['#f5b041', '#fad7a0'], ['#a04000', '#6e2c00'], '#fdfefe', 'Autumn hills'],
  ['night-sky.png', 1400, 900, ['#1b2631', '#2e4053'], ['#17202a', '#0b0f14'], '#f7f9f9', 'A clear night'],
  ['garden-roses.jpg', 900, 1350, ['#f5b7b1', '#fadbd8'], ['#229954', '#186a3b'], '#c0392b', 'Roses in the garden'],
  ['snowy-peaks.webp', 1600, 900, ['#aed6f1', '#ebf5fb'], ['#d5dbdb', '#f8f9f9'], '#f4d03f', 'Snowy peaks'],
];
const encode = (img: sharp.Sharp, name: string) => (name.endsWith('.png') ? img.png() : name.endsWith('.webp') ? img.webp({ quality: 82 }) : img.jpeg({ quality: 84 }));

for (const [name, w, h, sky, hills, sun, caption] of pictures) {
  put(`images/${name}`, await encode(sharp(Buffer.from(scene(w, h, sky, hills, sun, caption))), name).toBuffer());
}
// a folder of trip pictures, and one inside that
for (const [i, hue] of [['01', '#48c9b0'], ['02', '#5dade2'], ['03', '#af7ac5']] as const) {
  put(`images/2026-trip/day-${i}.jpg`, await sharp(Buffer.from(scene(1200, 800, [hue, '#fdfefe'], ['#566573', '#2c3e50'], '#f9e79f', `Trip, day ${Number(i)}`))).jpeg({ quality: 82 }).toBuffer());
}
put('images/2026-trip/food/lemon-cake.jpg', await sharp(Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#fcf3cf"/>
  <ellipse cx="500" cy="560" rx="330" ry="140" fill="#f7dc6f"/><rect x="170" y="420" width="660" height="140" fill="#f4d03f"/>
  <ellipse cx="500" cy="420" rx="330" ry="140" fill="#fef9e7"/><circle cx="500" cy="380" r="40" fill="#f1c40f"/>
  <text x="80" y="920" font-family="DejaVu Sans, sans-serif" font-size="60" fill="#7d6608">Lemon cake</text></svg>`)).jpeg({ quality: 85 }).toBuffer());
put('images/logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <circle cx="120" cy="120" r="110" fill="#8e44ad"/><text x="120" y="150" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="96" fill="#fff">P</text></svg>`);

// videos: ffmpeg's test pictures, a few seconds long
const ff = (...args: string[]) => execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', ...args]);
ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(mkdir('video'), 'test-pattern.mp4'));
ff('-f', 'lavfi', '-i', 'mandelbrot=size=854x480:rate=25', '-t', '5', '-c:v', 'libvpx-vp9', '-b:v', '600k', join(mkdir('video/clips'), 'mandelbrot.webm'));

// audio: two tunes of sine waves, one with a cover picture
writeFileSync(join(out, 'cover.png'), await sharp(Buffer.from(scene(600, 600, ['#16a085', '#a3e4d7'], ['#0e6655', '#0b5345'], '#f9e79f', 'Cover'))).png().toBuffer());
ff('-f', 'lavfi', '-i', 'sine=frequency=523:duration=8', '-i', join(out, 'cover.png'), '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-q:a', '5',
  '-c:v', 'png', '-disposition:v', 'attached_pic', '-metadata', 'title=A test tune', join(mkdir('audio'), 'test-tune.mp3'));
execFileSync('rm', [join(out, 'cover.png')]);
ff('-f', 'lavfi', '-i', 'sine=frequency=392:duration=6', '-c:a', 'libvorbis', join(mkdir('audio'), 'low-hum.ogg'));

// PDFs, by hand: one page of text in a built-in font
function pdf(title: string, lines: string[]): string {
  const esc = (t: string) => t.replace(/[\\()]/g, '\\$&');
  const text = [`BT /F1 26 Tf 60 760 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 14 Tf 60 ${710 - i * 24} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let s = '%PDF-1.4\n';
  const offs: number[] = [];
  for (const [i, o] of objs.entries()) { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; }
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${s}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
put('files/menu.pdf', pdf('Menu', ['Lemon cake ....... 3.50', 'Apple pie ........ 3.00', 'Tea or coffee .... 2.00']));
put('files/newsletters/autumn-newsletter.pdf', pdf('Autumn newsletter', ['News from the garden.', 'The roses did well this year.']));
put('files/price-list.csv', 'item,price\nlemon cake,3.50\napple pie,3.00\ntea,2.00\n');
put('files/notes.txt', 'Test notes for the Media tab.\n');

function mkdir(rel: string) { const d = join(out, rel); mkdirSync(d, { recursive: true }); return d; }
console.log(`made test media in ${out}`);
