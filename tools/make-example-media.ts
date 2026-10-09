// The built-in example folder the media examples show (docs/media-api-plan.md M11):
// pictures drawn here, tunes from ffmpeg, PDFs written by hand, each with a small
// picture, a title and "what it shows", and tags and categories -- written into
// public-gate/examples/media-demo/ with its manifest.json. Run once (the files are
// part of the panel); run again to change them.
//   node tools/make-example-media.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const out = new URL('../public-gate/examples/media-demo/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'thumbs'), { recursive: true });
type Entry = { file: string; kind: string; title: string; alt?: string; tags: string[]; categories: string[]; thumb?: string; width?: number; height?: number };
const files: Entry[] = [];

const scene = (w: number, h: number, sky: [string, string], hills: [string, string], sun: string) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.1}" fill="${sun}"/>
  <path d="M0 ${h * 0.68} Q ${w * 0.3} ${h * 0.46} ${w * 0.6} ${h * 0.66} T ${w} ${h * 0.6} V ${h} H 0 Z" fill="${hills[0]}"/>
  <path d="M0 ${h * 0.82} Q ${w * 0.4} ${h * 0.68} ${w} ${h * 0.84} V ${h} H 0 Z" fill="${hills[1]}"/>
</svg>`;
async function thumbOf(input: Buffer, name: string) {
  const { data, info } = await sharp(input).resize(320, 320, { fit: 'inside' }).webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
  writeFileSync(join(out, 'thumbs', name), data);
  return { thumb: `thumbs/${name}`, width: info.width, height: info.height };
}

const pictures: [string, number, number, [string, string], [string, string], string, string, string, string[], string[]][] = [
  ['sunset-beach.jpg', 1200, 800, ['#f39c12', '#e74c3c'], ['#6c3483', '#4a235a'], '#fdebd0', 'Sunset at the beach', 'An orange sky over purple hills, with a pale sun.', ['summer', 'evening'], ['landscapes']],
  ['morning-lake.jpg', 1200, 800, ['#85c1e9', '#d6eaf8'], ['#1e8449', '#145a32'], '#fef9e7', 'Morning by the lake', 'A pale blue morning sky above green hills.', ['summer', 'morning'], ['landscapes']],
  ['autumn-hills.jpg', 1200, 800, ['#f5b041', '#fad7a0'], ['#a04000', '#6e2c00'], '#fdfefe', 'Autumn hills', 'Rust-brown hills under a golden sky.', ['autumn'], ['landscapes']],
  ['night-sky.jpg', 1200, 800, ['#1b2631', '#2e4053'], ['#17202a', '#0b0f14'], '#f7f9f9', 'A clear night', 'A dark blue sky with a bright moon over black hills.', ['evening'], ['landscapes']],
  ['snowy-peaks.jpg', 1200, 800, ['#aed6f1', '#ebf5fb'], ['#d5dbdb', '#f8f9f9'], '#f4d03f', 'Snowy peaks', 'White snowy hills under a light blue sky.', ['winter'], ['landscapes']],
  ['garden-roses.jpg', 800, 1200, ['#f5b7b1', '#fadbd8'], ['#229954', '#186a3b'], '#c0392b', 'Roses in the garden', 'A tall picture: pink sky, green garden, a red sun like a rose.', ['summer', 'flowers'], ['garden']],
  ['harbour-boats.jpg', 1200, 800, ['#48c9b0', '#e8f8f5'], ['#2471a3', '#1a5276'], '#f9e79f', 'Boats in the harbour', 'Blue water under a turquoise sky.', ['summer', 'sea'], ['travel']],
  ['city-lights.jpg', 1200, 800, ['#5b2c6f', '#a569bd'], ['#212f3d', '#17202a'], '#f5cba7', 'City lights', 'A purple evening sky over dark rooftops.', ['evening'], ['travel']],
];
for (const [file, w, h, sky, hills, sun, title, alt, tags, categories] of pictures) {
  const jpg = await sharp(Buffer.from(scene(w, h, sky, hills, sun))).jpeg({ quality: 76 }).toBuffer();
  writeFileSync(join(out, file), jpg);
  files.push({ file, kind: 'images', title, alt, tags, categories, ...(await thumbOf(jpg, file.replace(/\.jpg$/, '.webp'))) });
}

// tunes: a few notes each, and two with a cover picture
const ff = (...args: string[]) => execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const tunes: [string, string, string, string, [string, string]][] = [
  ['morning-song.mp3', 'Morning song', '0.25*sin(2*PI*t*(392+98*floor(mod(t*2,4))))', 'morning', ['#f7dc6f', '#f5b041']],
  ['evening-hum.mp3', 'Evening hum', '0.25*sin(2*PI*t*(262+65*floor(mod(t*1.5,3))))', 'evening', ['#5b2c6f', '#1b2631']],
  ['little-waltz.mp3', 'A little waltz', '0.22*sin(2*PI*t*(330+110*floor(mod(t*3,3))))*(0.6+0.4*sin(2*PI*t*1.5))', 'summer', ['#48c9b0', '#1a5276']],
];
for (const [file, title, expr, tag, colours] of tunes) {
  const cover = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colours[0]}"/><stop offset="1" stop-color="${colours[1]}"/></linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="300" r="150" fill="#fff" fill-opacity="0.25"/><circle cx="300" cy="300" r="30" fill="#fff" fill-opacity="0.6"/></svg>`)).png().toBuffer();
  writeFileSync(join(out, 'cover.png'), cover);
  ff('-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=12`, '-i', join(out, 'cover.png'), '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-q:a', '7',
    '-c:v', 'png', '-disposition:v', 'attached_pic', '-metadata', `title=${title}`, join(out, file));
  files.push({ file, kind: 'audio', title, alt: 'A cover of soft colours with a circle in the middle.', tags: [tag], categories: ['music'], ...(await thumbOf(cover, file.replace(/\.mp3$/, '.webp'))) });
}
rmSync(join(out, 'cover.png'));

// PDFs by hand, one page of text each; their first page as the small picture
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
const docs: [string, string, string[], string[]][] = [
  ['menu.pdf', 'Menu', ['Lemon cake ....... 3.50', 'Apple pie ........ 3.00', 'Tea or coffee .... 2.00'], ['food']],
  ['autumn-newsletter.pdf', 'Autumn newsletter', ['News from the garden.', 'The roses did well this year.', 'Next meeting: the first Saturday.'], ['autumn']],
  ['booking-form.pdf', 'Booking form', ['Name: ____________________', 'Date: ____________________', 'How many: ______'], ['events']],
];
for (const [file, title, lines, tags] of docs) {
  writeFileSync(join(out, file), pdf(title, lines));
  const png = execFileSync('/usr/bin/pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '640', '-png', join(out, file)]);
  files.push({ file, kind: 'files', title, tags, categories: ['documents'], ...(await thumbOf(png, file.replace(/\.pdf$/, '.webp'))) });
}
writeFileSync(join(out, 'price-list.csv'), 'item,price\nlemon cake,3.50\napple pie,3.00\ntea,2.00\n');
files.push({ file: 'price-list.csv', kind: 'files', title: 'Price list', tags: ['food'], categories: ['documents'] });

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ about: 'The built-in example folder of the media examples (tools/make-example-media.ts).', files }, null, 2)}\n`);
console.log(`${files.length} example files in ${out}`);
