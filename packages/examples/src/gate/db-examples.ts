// The two database examples' public pages (docs/db-examples-plan.md): a
// recipe book and a blog. Each is three files in public-gate/examples/<kind>/
// -- page.html, style.css and <kind>.js -- with four blanks: @API@ (the data
// API address of the database it reads), @FILES@ (the folder its style and
// program are in), @TITLE@ (the heading) and @COMMENTS@ (the blog's comment
// area, docs/comments-plan.md). The recipe book also has its sample pictures,
// in pictures/.
//
// The gate serves them pointed at the example databases, which have fixed
// names, so the panel can show them working; "Make my own" fills the same
// blanks for her copy. One source, two uses -- like the form and media examples.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_EXAMPLE_KINDS, DB_EXAMPLES, type DbExampleKind } from '../studio/db-examples.ts';

export const dataApiUrl = (engine: string, name: string) => `/_pammy/api/data/${engine}/${name}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The three files, blanks filled.
export function dbExamplePage(dir: string, kind: DbExampleKind, api: string, filesDir: string, title?: string, comments?: string): { html: string; css: string; js: string } {
  const read = (file: string) => readFileSync(join(dir, kind, file), 'utf8');
  return {
    html: read('page.html').replaceAll('@API@', escapeHtml(api)).replaceAll('@FILES@', filesDir)
      .replaceAll('@TITLE@', escapeHtml(title ?? DB_EXAMPLES[kind].suggested.title))
      .replaceAll('@COMMENTS@', escapeHtml(comments ?? DB_EXAMPLES[kind].comments?.area.name ?? '')),
    css: read('style.css'),
    js: read(`${kind}.js`),
  };
}

// Where a page's style, program and pictures go: recipes.html -> recipes-files.
export const dbFilesDirFor = (pageName: string) => `${pageName.replace(/\.html?$/i, '')}-files`;

// Her copy: the page and its two files, as install-pages takes them (text,
// never over anything) -- and, when she copies the sample rows too, the
// pictures they point at, which go beside them through the ordinary upload
// (a picture is bigger than install-pages will carry, and should be).
export function dbExampleForHer(dir: string, kind: DbExampleKind, api: string, pageName: string, title: string, pictures: boolean, comments?: string): {
  files: { path: string; content: string }[];
  pictures: { dir: string; name: string; bytes: Buffer }[];
} {
  const filesDir = dbFilesDirFor(pageName);
  const page = dbExamplePage(dir, kind, api, filesDir, title, comments);
  return {
    files: [
      { path: pageName, content: page.html },
      { path: `${filesDir}/style.css`, content: page.css },
      { path: `${filesDir}/${kind}.js`, content: page.js },
    ],
    pictures: pictures
      ? DB_EXAMPLES[kind].pictures.map((p) => ({ dir: filesDir, name: p, bytes: readFileSync(join(dir, kind, 'pictures', p)) }))
      : [],
  };
}

// Where the rows' pictures sit relative to the page: in the example, the
// pictures/ folder beside it; in her copy, the page's own files folder.
export const examplePicturePrefix = './pictures/';
export const herPicturePrefix = (pageName: string) => `${dbFilesDirFor(pageName)}/`;

// What the gate serves at /_pammy/examples/<kind>/, read once.
export function loadDbExamples(dir: string): Map<string, { body: Buffer; type: string }> {
  const out = new Map<string, { body: Buffer; type: string }>();
  for (const kind of DB_EXAMPLE_KINDS) {
    const ex = DB_EXAMPLES[kind];
    let page: { html: string; css: string; js: string };
    try { page = dbExamplePage(dir, kind, dataApiUrl(ex.engine, ex.database), '.', ex.suggested.title); } catch { continue; }
    const at = (file: string, body: Buffer | string, type: string) => out.set(`/_pammy/examples/${kind}/${file}`, { body: Buffer.from(body), type });
    at('', page.html, 'text/html; charset=utf-8');
    at('index.html', page.html, 'text/html; charset=utf-8');
    at('style.css', page.css, 'text/css; charset=utf-8');
    at(`${kind}.js`, page.js, 'text/javascript; charset=utf-8');
    let names: string[] = [];
    try { names = readdirSync(join(dir, kind, 'pictures')); } catch { /* none */ }
    for (const n of names.filter((x) => x.endsWith('.jpg'))) at(`pictures/${n}`, readFileSync(join(dir, kind, 'pictures', n)), 'image/jpeg');
  }
  return out;
}
