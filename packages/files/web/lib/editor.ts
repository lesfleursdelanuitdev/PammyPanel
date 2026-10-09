// The editor (docs/editor-plan.md): which files it opens, its address, the
// templates for new files, and the unsaved text it keeps in this browser.
// No CodeMirror here: the File Explorer uses this, and the editor itself loads
// only when a file is opened.

// What the editor opens (C2); the server has the same list (src/sitefs/edit.ts).
export const EDITABLE = ['html', 'htm', 'css', 'js', 'txt', 'md', 'json', 'xml', 'svg'] as const;
export const MAX_TEXT = 2 * 1024 * 1024;

export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
export const isEditable = (name: string) => (EDITABLE as readonly string[]).includes(extensionOf(name));
export const isPage = (name: string) => ['html', 'htm'].includes(extensionOf(name));
// Cloudflare keeps these for up to 4 hours (not pages).
export const isCached = (name: string) => ['css', 'js'].includes(extensionOf(name));

// root: a software root (docs/catalog-plan.md step 3); none or "website": her website
export const editorHref = (path: string, root = '') => `/files/edit?path=${encodeURIComponent(path)}${root && root !== 'website' ? `&root=${encodeURIComponent(root)}` : ''}`;
// A software root's code, which the editor opens too (saved by panel admins only)
export const CODE = ['php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phar'] as const;
export const isCode = (name: string) => (CODE as readonly string[]).includes(extensionOf(name));

// Names that mean something to the protected-folder service.
export function specialName(name: string): string | null {
  const n = name.toLowerCase();
  if (n === 'login.html') return 'This is the sign-in page of a protected folder. Saving it changes the page visitors sign in on.';
  if (/^login-(forgot|invite|request|signed-out|logout)\.html$/.test(n)) return 'This is one of the sign-in pages of a protected folder. Saving it changes what visitors see.';
  return null;
}

// ------------------------------------------------------------------ new files (D3)
export type Template = 'page' | 'css' | 'blank';
export const TEMPLATES: { id: Template; label: string; ending: string; hint: string }[] = [
  { id: 'page', label: 'A web page', ending: '.html', hint: 'A starter page with a heading and a paragraph.' },
  { id: 'css', label: 'A style sheet', ending: '.css', hint: 'A few starter styles for your pages.' },
  { id: 'blank', label: 'An empty file', ending: '.txt', hint: 'Nothing in it. Give it the ending you want: .html, .css, .js, .txt, .md, .json, .xml or .svg.' },
];

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function templateText(t: Template, name: string, withStyle: boolean): string {
  const title = escapeHtml(name.replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ').trim() || 'New page');
  if (t === 'page') {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${title}</title>`,
      ...(withStyle ? ['  <link rel="stylesheet" href="style.css">'] : []),
      '</head>',
      '<body>',
      `  <h1>${title}</h1>`,
      '  <p>Write something here.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }
  if (t === 'css') {
    return [
      'body {',
      '  margin: 0 auto;',
      '  max-width: 42rem;',
      '  padding: 2rem 1rem;',
      '  font-family: system-ui, sans-serif;',
      '  line-height: 1.6;',
      '  color: #2b1e33;',
      '}',
      '',
      'h1, h2, h3 {',
      '  line-height: 1.2;',
      '}',
      '',
      'a {',
      '  color: #6e3f87;',
      '}',
      '',
      'img {',
      '  max-width: 100%;',
      '  height: auto;',
      '}',
      '',
    ].join('\n');
  }
  return '';
}

// The name as it will be saved: the template's ending added when there is none.
export function newFileName(typed: string, t: Template): string {
  const name = typed.trim();
  if (!name || extensionOf(name)) return name;
  return name + TEMPLATES.find((x) => x.id === t)!.ending;
}

// ------------------------------------------------------------------ unsaved text (Q2)
// Kept in this browser only, never sent anywhere: offered back when the file is
// opened again (after a closed tab, a crash, or leaving without saving).
export type Draft = { text: string; base: string; at: number };
const draftKey = (user: string, path: string) => `pammy.editor.draft.${user}:${path}`;

export function readDraft(user: string, path: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(user, path)) ?? 'null') as Draft | null;
    return d && typeof d.text === 'string' && typeof d.base === 'string' && typeof d.at === 'number' ? d : null;
  } catch { return null; }
}
export function writeDraft(user: string, path: string, d: Draft) {
  try { localStorage.setItem(draftKey(user, path), JSON.stringify(d)); } catch { /* full or blocked: only this safety net is lost */ }
}
export function clearDraft(user: string, path: string) {
  try { localStorage.removeItem(draftKey(user, path)); } catch { /* blocked */ }
}
