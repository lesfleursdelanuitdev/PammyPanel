// A temporary home page for a folder that has none (docs/temporary-home-plan.md).
// A top-level folder with no index.html (or index.php) answers "403 Forbidden",
// so the panel offers to put a page there that says what she wants it to say,
// in her site's own look if she picks one of her stylesheets.
//
// Only top-level folders that can be subdomains, never a protected one (the gate
// has its own welcome page for those), and never over a page of hers: the page
// carries a marker, and only a page with that marker is ever changed or removed.
// A new subdomain's starter page is one of these too, so she can change its words.
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, SUBDOMAIN_RE, readPlacements, reservedNames } from '@panel/core/names';
import { SiteFsError, type SiteFsConfig } from './ops.ts';

export const GENERATOR = 'pammy-temporary-page';
// the page's own words, kept in the page so the panel can offer them again
const DATA_RE = /<!-- pammy-temporary-page ([A-Za-z0-9+/=]+) -->/;
// starter pages from before, which are just as much the panel's own
const OLD_STARTER = 'A starter page made by the pammy.org control panel.';

export const LIMITS = { heading: 120, message: 2000 };
export type PageWords = { heading: string; message: string; link: boolean; style: string };
export type HomePage = 'none' | 'own' | 'temporary';
export type StyleChoice = { id: string; label: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const placement = (cfg: SiteFsConfig) => readPlacements(cfg.placementFile);

// What a folder's home page is now.
export function homePageOf(dir: string): { kind: HomePage; words: PageWords | null } {
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (isFile(join(dir, 'index.php'))) return { kind: 'own', words: null };
  if (!isFile(join(dir, 'index.html'))) return { kind: 'none', words: null };
  let head = '';
  try { head = readFileSync(join(dir, 'index.html'), 'utf8').slice(0, 64 * 1024); } catch { return { kind: 'own', words: null }; }
  if (head.includes(`<meta name="generator" content="${GENERATOR}">`)) {
    const m = head.match(DATA_RE);
    try {
      const w = JSON.parse(Buffer.from(m![1]!, 'base64').toString('utf8')) as PageWords;
      return { kind: 'temporary', words: { heading: String(w.heading), message: String(w.message), link: !!w.link, style: String(w.style) } };
    } catch {
      return { kind: 'temporary', words: null };
    }
  }
  if (head.includes(OLD_STARTER)) return { kind: 'temporary', words: null };
  return { kind: 'own', words: null };
}

export const isProtected = (dir: string) => { try { lstatSync(join(dir, MARKER)); return true; } catch { return false; } };

// A top-level folder that can be a subdomain, a real folder (not a shortcut), not protected.
function folderFor(cfg: SiteFsConfig, name: unknown): string {
  if (typeof name !== 'string' || !SUBDOMAIN_RE.test(name) || reservedNames(placement(cfg)).includes(name)) {
    throw new SiteFsError('invalid', 'Only a folder that can be a subdomain can have a temporary page.');
  }
  const dir = join(cfg.publicDir, name);
  let st;
  try { st = lstatSync(dir); } catch { throw new SiteFsError('not-found', 'That folder no longer exists.'); }
  if (!st.isDirectory()) throw new SiteFsError('invalid', 'Only a real folder can have a temporary page, not a shortcut.');
  if (isProtected(dir)) throw new SiteFsError('not-allowed', 'This folder is protected: people who sign in already get a welcome page.');
  return dir;
}

const cssIn = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.css$/.test(d.name)).map((d) => d.name).sort().slice(0, 20);
  } catch { return []; }
};

// The looks she can pick from: plain, a stylesheet in the folder, or one of the main site's.
export function styleChoices(cfg: SiteFsConfig, name: string): StyleChoice[] {
  const dir = join(cfg.publicDir, name);
  return [
    { id: 'plain', label: 'Plain' },
    ...cssIn(dir).map((f) => ({ id: `folder:${f}`, label: `${f}, in this folder` })),
    ...cssIn(cfg.publicDir).map((f) => ({ id: `site:${f}`, label: `${f}, your main site's` })),
  ];
}

function hrefFor(style: string, site: string): string | null {
  if (style.startsWith('folder:')) return style.slice(7);
  // the folder is also <name>.<domain>, so the main site's stylesheet needs its whole address
  if (style.startsWith('site:')) return `https://${site}/${style.slice(5)}`;
  return null;
}

export function pageHtml(w: PageWords, site: string, siteName: string): string {
  const href = hrefFor(w.style, site);
  const paragraphs = w.message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `    <p>${esc(p).replace(/\n/g, '<br>\n    ')}</p>`).join('\n');
  const data = Buffer.from(JSON.stringify(w), 'utf8').toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="${GENERATOR}">
  <title>${esc(w.heading)}</title>
${href ? `  <link rel="stylesheet" href="${esc(href)}">` : ''}
</head>
<body${href ? '' : ' style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5;"'}>
  <main>
    <h1>${esc(w.heading)}</h1>
${paragraphs}
${w.link ? `    <p><a href="https://${site}/">Go to ${esc(site)}</a></p>\n` : ''}  </main>
  <!-- pammy-temporary-page ${data} -->
  <!--
    A temporary page made by the ${siteName} control panel. Put your own index.html
    here and it takes this one's place. This folder is also its own subdomain, so
    links inside it must not start with "/" (see 06-folders-and-subdomains.txt).
  -->
</body>
</html>
`;
}

function wordsOf(cfg: SiteFsConfig, name: string, v: unknown): PageWords {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const heading = typeof o.heading === 'string' ? o.heading.trim().replace(/\s+/g, ' ') : '';
  const message = typeof o.message === 'string' ? o.message.replace(/\r\n?/g, '\n').trim() : '';
  if (!heading) throw new SiteFsError('invalid', 'Give the page a heading, like "Coming soon".');
  if (heading.length > LIMITS.heading) throw new SiteFsError('invalid', `The heading can be at most ${LIMITS.heading} characters.`);
  if (message.length > LIMITS.message) throw new SiteFsError('invalid', `What it says can be at most ${LIMITS.message} characters.`);
  const style = typeof o.style === 'string' ? o.style : 'plain';
  if (!styleChoices(cfg, name).some((c) => c.id === style)) throw new SiteFsError('invalid', 'That stylesheet is not there any more. Choose another look.');
  return { heading, message, link: o.link === true, style };
}

const siteOf = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,250}[a-z0-9])?$/.test(v)) throw new SiteFsError('invalid', 'Which website?');
  return v;
};

// ------------------------------------------------------------------ the ops
export function homePageGet(cfg: SiteFsConfig, name: unknown) {
  const dir = folderFor(cfg, name);
  const now = homePageOf(dir);
  return { name, kind: now.kind, words: now.words, styles: styleChoices(cfg, name as string), limits: LIMITS };
}

export function homePageSave(cfg: SiteFsConfig, name: unknown, words: unknown, site: unknown) {
  const dir = folderFor(cfg, name);
  const now = homePageOf(dir);
  if (now.kind === 'own') throw new SiteFsError('exists', 'This folder has a home page of your own, so the panel leaves it alone.');
  const w = wordsOf(cfg, name as string, words);
  // written beside it, then moved over it: a visitor never sees half a page
  const tmp = join(dir, '.index.html.pammy-tmp');
  try {
    writeFileSync(tmp, pageHtml(w, siteOf(site), cfg.siteName), { mode: 0o644 });
    renameSync(tmp, join(dir, 'index.html'));
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to tidy */ }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new SiteFsError('not-allowed', "The server won't let the panel write there. Ask momolig.");
    throw e;
  }
  return { name, made: now.kind === 'none', words: w };
}

export function homePageRemove(cfg: SiteFsConfig, name: unknown) {
  const dir = folderFor(cfg, name);
  if (homePageOf(dir).kind !== 'temporary') throw new SiteFsError('not-allowed', 'Only a temporary page the panel made can be removed here.');
  rmSync(join(dir, 'index.html'));
  return { name };
}
