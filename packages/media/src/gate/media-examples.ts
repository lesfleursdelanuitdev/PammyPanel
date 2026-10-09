// The four media examples (docs/media-api-plan.md M10-M12): a gallery, a slide
// show, a list of documents and a music player. Each is three files in
// public-gate/examples/<kind>/ -- page.html, style.css and <kind>.js -- with
// three blanks: @API@ (the media API address it reads), @FILES@ (the folder its
// style and program are in) and @TITLE@ (the heading).
//
// The gate serves them pointed at the built-in example folder (so the panel can
// show them working); "Put this on my website" fills the same blanks for her.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_EXAMPLE_KINDS = ['gallery', 'slideshow', 'documents', 'music'] as const;
export type MediaExampleKind = (typeof MEDIA_EXAMPLE_KINDS)[number];
export const isMediaExampleKind = (k: unknown): k is MediaExampleKind => MEDIA_EXAMPLE_KINDS.includes(k as MediaExampleKind);

export const MEDIA_EXAMPLES: Record<MediaExampleKind, {
  heading: string; about: string; pageName: string; mediaKind: 'images' | 'files' | 'audio'; title: string;
  demo: { type: 'tag' | 'category'; name: string };      // what the example page shows of the example folder
}> = {
  gallery: {
    heading: 'Gallery', pageName: 'gallery.html', mediaKind: 'images', title: 'Pictures',
    about: 'Little pictures in a grid. Click one to see it big, then go through them with the arrows, the keyboard, or by swiping on a phone.',
    demo: { type: 'category', name: 'landscapes' },
  },
  slideshow: {
    heading: 'Slide show', pageName: 'slideshow.html', mediaKind: 'images', title: 'Slide show',
    about: 'One picture at a time, with its title, dots to jump about, and the arrows. It moves on by itself every few seconds, and stops while you point at it.',
    demo: { type: 'tag', name: 'summer' },
  },
  documents: {
    heading: 'Documents', pageName: 'documents.html', mediaKind: 'files', title: 'Documents',
    about: "A list of files to open or download: PDFs, spreadsheets and the like, each with its kind, size and date, and the first page's picture where there is one.",
    demo: { type: 'category', name: 'documents' },
  },
  music: {
    heading: 'Music player', pageName: 'music.html', mediaKind: 'audio', title: 'Music',
    about: 'A player with a list of songs: play and pause, the next and previous song, a bar to skip about, and each song\'s cover picture. It goes on to the next song by itself.',
    demo: { type: 'category', name: 'music' },
  },
};

// The address a page reads: "/_pammy/api/media/in/olivia/t/summer/c/travel?kind=images".
export function mediaApiUrl(scope: string, tags: string[], categories: string[], kind: string): string {
  const where = scope === ':example' ? 'example' : scope === '/' ? 'main' : `in/${encodeURIComponent(scope.slice(1))}`;
  const filters = [...tags.map((t) => `t/${t}`), ...categories.map((c) => `c/${c}`)].join('/');
  return `/_pammy/api/media/${where}/${filters}?kind=${kind}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The three files, blanks filled. api null: the built-in example folder.
export function mediaExamplePage(dir: string, kind: MediaExampleKind, api: string | null, filesDir: string, title?: string): { html: string; css: string; js: string } {
  const e = MEDIA_EXAMPLES[kind];
  const read = (file: string) => readFileSync(join(dir, kind, file), 'utf8');
  const url = api ?? mediaApiUrl(':example', e.demo.type === 'tag' ? [e.demo.name] : [], e.demo.type === 'category' ? [e.demo.name] : [], e.mediaKind);
  return {
    html: read('page.html').replaceAll('@API@', escapeHtml(url)).replaceAll('@FILES@', filesDir).replaceAll('@TITLE@', escapeHtml(title ?? e.title)),
    css: read('style.css'),
    js: read(`${kind}.js`),
  };
}

// Her own copy: music.html, and music-files/{style.css,music.js} beside it.
export function mediaExampleForHer(dir: string, kind: MediaExampleKind, api: string, pageName: string, title?: string): { path: string; content: string }[] {
  const filesDir = `${pageName.replace(/\.html?$/i, '')}-files`;
  const page = mediaExamplePage(dir, kind, api, filesDir, title);
  return [
    { path: pageName, content: page.html },
    { path: `${filesDir}/style.css`, content: page.css },
    { path: `${filesDir}/${kind}.js`, content: page.js },
  ];
}
