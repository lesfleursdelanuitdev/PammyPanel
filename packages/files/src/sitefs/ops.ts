// What the website folder helper can do to /pamela/public, and nothing else.
// Synchronous on purpose: the helper handles one request at a time, so two
// requests can never race on the same folder.
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  AREA_TOKEN_RE, cleanAreaPath, isSafeEntryName, MARKER, newNameProblem, parseTrashEntry, readPlacements, reservedNames, SUBDOMAIN_RE, trashStamp,
} from '@panel/core/names';
import { homePageOf, isProtected, pageHtml, type HomePage } from './home-page.ts';

export type SiteFsConfig = {
  publicDir: string;       // her website (/pamela/public)
  trashDir: string;        // its trash (/pamela/trash), outside the web root: never served
  placementFile: string | null;   // /etc/nginx/pammy-wordpress/placement (null: no WordPress on this site)
  purgeDays: number;
  domain: string;          // pammy.org: a folder is also <name>.<domain>
  siteName: string;        // "pammy.org": the pages it writes say they were made by "the <siteName> control panel"
  folderSubdomains: boolean; // a folder is also <name>.<domain> (the site's profile)
  maxUpload: number;       // bytes, one file (the site's profile: 100 MB behind Cloudflare's free plan)
  now: () => Date;
  // 'software': a software root (docs/catalog-plan.md step 3): publicDir is its
  // wp-content/, run as the software's own user; File Explorer and the editor only,
  // code only for panel admins (media.ts writeProblem). Unset: the website.
  kind?: 'website' | 'software';
  // lfdln (docs/phase8-plan.md P8-1): the top holds only site folders, and Hosts keeps
  // their record, so File Explorer and the editor never make, rename, move or trash
  // anything at the top (the helper's own create/trash ops, Hosts', still do).
  hostsKeepTop?: boolean;
};

export class SiteFsError extends Error {
  code: 'invalid' | 'exists' | 'not-found' | 'not-allowed' | 'conflict' | 'internal';
  constructor(code: SiteFsError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type Folder = {
  name: string;
  subdomain: boolean;       // reachable as <name>.<domain>
  reserved: boolean;        // the name is taken by the server (www, api, panel, WordPress)
  hasIndex: boolean;
  // none: "403 Forbidden" for now; temporary: a page the panel made (home-page.ts); own: hers
  homePage: HomePage;
  protected: boolean;
  symlink: boolean;
  modifiedAt: number;
};

export type TrashEntry = { entry: string; name: string; trashedAt: number; purgeAt: number };

const MAX_LIST = 2000;

function reserved(cfg: SiteFsConfig): string[] {
  return reservedNames(readPlacements(cfg.placementFile));
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function friendly(e: unknown, what: string): never {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    throw new SiteFsError('not-allowed', `The server won't let the panel ${what}. The folder probably belongs to another account; ask momolig.`);
  }
  if (code === 'ENOENT') throw new SiteFsError('not-found', 'That folder no longer exists.');
  if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new SiteFsError('exists', 'A folder with that name already exists.');
  if (code === 'EXDEV') throw new SiteFsError('internal', `The server's setup won't let the panel ${what} (the trash is on a different mount); ask momolig.`);
  throw e;
}

export function listFolders(cfg: SiteFsConfig) {
  const taken = reserved(cfg);
  const folders: Folder[] = [];
  for (const d of readdirSync(cfg.publicDir, { withFileTypes: true })) {
    if (folders.length >= MAX_LIST) break;
    if (!isSafeEntryName(d.name) || d.name === 'media') continue;      // the main site's media folder isn't a site
    const p = join(cfg.publicDir, d.name);
    const st = lstatOrNull(p);
    if (!st) continue;
    let isDir = st.isDirectory();
    if (st.isSymbolicLink()) {
      try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;
    // a home page: index.html, or index.php (docs/tutorials-plan.md P1)
    const homePage = homePageOf(p).kind;
    folders.push({
      name: d.name,
      subdomain: cfg.folderSubdomains && SUBDOMAIN_RE.test(d.name) && !taken.includes(d.name),
      reserved: taken.includes(d.name),
      hasIndex: homePage !== 'none',
      homePage,
      protected: isProtected(p),
      symlink: st.isSymbolicLink(),
      modifiedAt: Math.floor(st.mtimeMs / 1000),
    });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return { folders, trash: listTrash(cfg), reserved: taken, purgeDays: cfg.purgeDays };
}

export function listTrash(cfg: SiteFsConfig): TrashEntry[] {
  const out: TrashEntry[] = [];
  let names: string[] = [];
  try { names = readdirSync(cfg.trashDir); } catch { return out; }
  for (const entry of names) {
    const parsed = parseTrashEntry(entry);
    if (!parsed || !isSafeEntryName(entry)) continue;
    out.push({ entry, ...parsed, purgeAt: parsed.trashedAt + cfg.purgeDays * 86400 });
    if (out.length >= MAX_LIST) break;
  }
  return out.sort((a, b) => b.trashedAt - a.trashedAt);
}

// A new folder's starter page: a temporary page (home-page.ts), so she can change its words.
const starterPage = (cfg: SiteFsConfig, name: string) => pageHtml({ heading: name, message: 'Coming soon.', link: false, style: 'plain' }, cfg.folderSubdomains ? `${name}.${cfg.domain}` : cfg.domain, cfg.siteName);

export function createFolder(cfg: SiteFsConfig, name: unknown): { name: string } {
  const problem = newNameProblem(name, reserved(cfg));
  if (problem) throw new SiteFsError('invalid', problem);
  const n = name as string;
  const dir = join(cfg.publicDir, n);
  // mkdir is atomic: it fails if anything (folder, file, link) already has the name.
  // The web root's setgid bit gives the new folder group www-data, like her uploads.
  try { mkdirSync(dir, { mode: 0o755 }); } catch (e) { friendly(e, 'create that folder'); }
  try {
    writeFileSync(join(dir, 'index.html'), starterPage(cfg, n), { mode: 0o644, flag: 'wx' });
  } catch (e) {
    try { rmdirSync(dir); } catch { /* leave it; the error below explains */ }
    friendly(e, 'create the starter page');
  }
  return { name: n };
}

export function trashFolder(cfg: SiteFsConfig, name: unknown): TrashEntry {
  if (!isSafeEntryName(name)) throw new SiteFsError('invalid', "That isn't a folder name.");
  const src = join(cfg.publicDir, name);
  const st = lstatOrNull(src);
  if (!st) throw new SiteFsError('not-found', 'That folder no longer exists.');
  if (!st.isDirectory() && !st.isSymbolicLink()) throw new SiteFsError('invalid', "That's a file, not a folder.");
  if (!lstatOrNull(cfg.trashDir)?.isDirectory()) throw new SiteFsError('internal', 'The trash folder is missing; ask momolig.');
  const date = cfg.now();
  const entry = `${name}--${trashStamp(date)}`;
  const dest = join(cfg.trashDir, entry);
  // rename() would silently replace an existing EMPTY folder, so check first
  // (safe: requests are handled one at a time).
  if (lstatOrNull(dest)) throw new SiteFsError('exists', 'Please wait a second and try again.');
  try { renameSync(src, dest); } catch (e) { friendly(e, 'move that folder'); }
  const trashedAt = Math.floor(date.getTime() / 1000);
  return { entry, name, trashedAt, purgeAt: trashedAt + cfg.purgeDays * 86400 };
}

export function restoreFolder(cfg: SiteFsConfig, entry: unknown, as?: unknown): { name: string } {
  const parsed = typeof entry === 'string' && isSafeEntryName(entry) ? parseTrashEntry(entry) : null;
  if (!parsed) throw new SiteFsError('invalid', "That isn't something in the trash.");
  let name = parsed.name;
  if (as !== undefined && as !== null && as !== '' && as !== parsed.name) {
    const problem = newNameProblem(as, reserved(cfg));
    if (problem) throw new SiteFsError('invalid', problem);
    name = as as string;
  }
  const src = join(cfg.trashDir, entry as string);
  if (!lstatOrNull(src)) throw new SiteFsError('not-found', "That's no longer in the trash.");
  const dest = join(cfg.publicDir, name);
  if (lstatOrNull(dest)) {
    throw new SiteFsError('exists', `There's already a folder called "${name}". Restore it under a different name.`);
  }
  try { renameSync(src, dest); } catch (e) { friendly(e, 'restore that folder'); }
  return { name };
}

// Deletes trash entries older than purgeDays. Never follows links out of the trash.
export function purgeTrash(cfg: SiteFsConfig): { purged: string[]; failed: string[] } {
  const cutoff = Math.floor(cfg.now().getTime() / 1000) - cfg.purgeDays * 86400;
  const purged: string[] = [];
  const failed: string[] = [];
  for (const t of listTrash(cfg)) {
    if (t.trashedAt > cutoff) continue;
    try {
      rmSync(join(cfg.trashDir, t.entry), { recursive: true, force: false });
      purged.push(t.entry);
    } catch {
      failed.push(t.entry);
    }
  }
  return { purged, failed };
}

// ------------------------------------------------------------------ protected folders
// The helper only writes the marker, starter sign-in pages and their stylesheet; who may enter is
// the gate's business. Paths never follow shortcuts (symlinks): a protection is
// always on the real folder.

function realDir(cfg: SiteFsConfig, path: unknown): { rel: string; abs: string } {
  const rel = cleanAreaPath(path);
  if (!rel) throw new SiteFsError('invalid', "That isn't a folder in your website.");
  let abs = cfg.publicDir;
  for (const part of rel.split('/')) {
    abs = join(abs, part);
    const st = lstatOrNull(abs);
    if (!st) throw new SiteFsError('not-found', `There's no folder called "${rel}" any more.`);
    if (st.isSymbolicLink()) throw new SiteFsError('invalid', 'That is a shortcut to another folder; protect the real folder instead.');
    if (!st.isDirectory()) throw new SiteFsError('invalid', `"${rel}" is a file, not a folder.`);
  }
  return { rel, abs };
}

function markerToken(dir: string): string | null | undefined {   // undefined: no marker
  let text: string;
  try { text = readFileSync(join(dir, MARKER), 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  const m = text.trim().match(/^pammy-protected ([A-Za-z0-9_-]+)$/);
  return m && AREA_TOKEN_RE.test(m[1]!) ? m[1]! : null;
}

// Every folder under the web root, at every depth, for the panel's folder pickers.
// Hidden folders, shortcuts, login-files and media folders (and all inside them)
// are left out. maxDepth and MAX_LIST only guard against something pathological.
export const MAX_DEPTH = 32;
export function listDirs(cfg: SiteFsConfig, maxDepth = MAX_DEPTH): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= MAX_LIST) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || !isSafeEntryName(d.name) || d.name === 'login-files' || d.name === 'media') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      out.push(r);
      walk(join(abs, d.name), r, depth + 1);
    }
  };
  walk(cfg.publicDir, '', 1);
  return out;
}

// Where the protection markers actually are right now (she may have renamed or
// copied a protected folder), plus the state of the folders the gate knows.
export function markers(cfg: SiteFsConfig, paths: unknown) {
  const found: { path: string; token: string | null; hasLogin: boolean; pages: string[]; hasIndex: boolean }[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 8 || found.length >= MAX_LIST) return;
    const t = rel ? markerToken(abs) : undefined;
    if (t !== undefined) {
      const pages = signinPagesIn(abs);
      found.push({ path: rel, token: t, hasLogin: pages.includes('login.html'), pages, hasIndex: !!lstatOrNull(join(abs, 'index.html')) });
    }
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (d.isDirectory() && isSafeEntryName(d.name)) walk(join(abs, d.name), rel ? `${rel}/${d.name}` : d.name, depth + 1);
    }
  };
  walk(cfg.publicDir, '', 0);
  const status = (Array.isArray(paths) ? paths.slice(0, MAX_LIST) : []).map((p) => {
    const rel = cleanAreaPath(p);
    if (!rel) return { path: String(p), exists: false, hasLogin: false, pages: [], hasIndex: false, marker: null };
    const abs = join(cfg.publicDir, rel);
    const st = lstatOrNull(abs);
    const exists = !!st?.isDirectory();
    const pages = exists ? signinPagesIn(abs) : [];
    return { path: rel, exists, hasLogin: pages.includes('login.html'), pages, hasIndex: exists && !!lstatOrNull(join(abs, 'index.html')), marker: exists ? markerToken(abs) ?? null : null };
  });
  return { found, status };
}

// Starter sign-in pages, one per kind. She can change everything around the
// component line; missing ones fall back to the gate's built-in pages.
export const SIGNIN_PAGES = {
  'login.html': { title: 'Sign in', tag: 'pammy-login', attrs: (name: string) => ` heading="${name}: members only"`,
    note: 'The sign-in page for this protected folder.' },
  'login-forgot.html': { title: 'Forgot your password', tag: 'pammy-forgot', attrs: () => '',
    note: 'Where people say they forgot their password. It shows up in your control panel under Requests.' },
  'login-invite.html': { title: 'Choose your password', tag: 'pammy-invite', attrs: () => '',
    note: 'Where the setup links you send people open, so they can choose their own password.' },
  'login-request.html': { title: 'Ask for access', tag: 'pammy-request', attrs: () => '',
    note: 'Where people can ask to be let in. Requests show up in your control panel under Requests.' },
  'logout.html': { title: 'Signed out', tag: 'pammy-signed-out', attrs: () => '',
    note: 'Opening this page signs people out, so a link to it is a "Sign out" link: <a href="logout.html">Sign out</a>.' },
} as const;
export type SigninPage = keyof typeof SIGNIN_PAGES;
const SIGNIN_FILES = Object.keys(SIGNIN_PAGES) as SigninPage[];
// The sign-in pages' shared stylesheet, in the one folder they may use before signing in.
export const LOGIN_FILES = 'login-files';
export const LOGIN_STYLE = `${LOGIN_FILES}/style.css`;

function starterStyle(folder: string, siteName: string): string {
  const name = folder.split('/').pop()!.replace(/\*\//g, '');
  return `/* The look of the sign-in pages of "${name}": login.html, login-forgot.html,
   login-invite.html, login-request.html and logout.html all use this file.
   Made by the ${siteName} control panel; change anything you like.

   The style, picture and font files directly in this login-files folder can be
   seen before signing in (not those in folders inside it), so keep only what
   these pages use in it. Anything else here stays locked.
   More: 09-protected-folders.txt, PART 7 (Changing the look), and three
   ready-made looks to copy, with previews, in PART 9, PART 10 and PART 11. */

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem 1rem;
  box-sizing: border-box;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #f6f3ee;
  color: #2a2622;
}

main {
  width: 100%;
  max-width: 24rem;
}

/* The forms' own settings. To use one, take away the slash-star and star-slash
   around it and change the value. */
pammy-login, pammy-forgot, pammy-invite, pammy-request, pammy-signed-out, pammy-logout {
  /* --pammy-accent: #7a4b8c; */          /* the button colour */
  /* --pammy-accent-text: #ffffff; */     /* the words on the button */
  /* --pammy-radius: 8px; */              /* how round the corners are */
  /* --pammy-font: Georgia, serif; */     /* the lettering */
}
`;
}

function starterSigninPage(folder: string, file: SigninPage, siteName: string): string {
  const name = folder.split('/').pop()!.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const p = SIGNIN_PAGES[file];
  const tag = `<${p.tag}${p.attrs(name)}></${p.tag}>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${p.title} · ${name}</title>
  <!--
    ${p.note} Made by the ${siteName} control panel.
    Change anything you like around it; keep these two lines somewhere on the page:

      <script src="/_pammy/login.js" defer></script>
      ${tag}

    This page can be seen before signing in, like this folder's other sign-in pages.
    Its look is in login-files/style.css, shared by all five. Put any pictures or
    fonts it uses directly in the "login-files" folder too, because everything
    else is locked.
    Changing its words and look: 09-protected-folders.txt, PART 6 and PART 7.
    Three ready-made looks to copy, with previews: PART 9, PART 10 and PART 11.
  -->
  <script src="/_pammy/login.js" defer></script>
  <link rel="stylesheet" href="login-files/style.css">
</head>
<body>
  <main>
    ${tag}
  </main>
</body>
</html>
`;
}

// The starter files a folder has: its sign-in pages, and login-files/style.css.
const signinPagesIn = (abs: string) => [...SIGNIN_FILES, LOGIN_STYLE].filter((f) => lstatOrNull(join(abs, f))?.isFile());

// pages false: only (re)write the marker, leave her sign-in pages alone (used
// when repairing a deleted marker, so pages she deleted on purpose stay deleted).
export function protectDir(cfg: SiteFsConfig, path: unknown, token: unknown, pages: unknown = true): { path: string; loginCreated: boolean; created: string[] } {
  if (typeof token !== 'string' || !AREA_TOKEN_RE.test(token)) throw new SiteFsError('invalid', 'Bad protection id.');
  const { rel, abs } = realDir(cfg, path);
  const existing = markerToken(abs);
  if (existing && existing !== token) throw new SiteFsError('exists', 'That folder already belongs to another protection.');
  if (existing !== token) {
    // write-then-rename: the marker is never half-written
    const tmp = join(abs, `${MARKER}.tmp-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(tmp, `pammy-protected ${token}\n`, { mode: 0o644, flag: 'wx' });
      renameSync(tmp, join(abs, MARKER));
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      friendly(e, 'protect that folder');
    }
  }
  const created: string[] = [];
  if (pages !== false) {
    for (const file of SIGNIN_FILES) {
      if (lstatOrNull(join(abs, file))) continue;    // anything already there (hers, or a shortcut) is left alone
      try {
        writeFileSync(join(abs, file), starterSigninPage(rel, file, cfg.siteName), { mode: 0o644, flag: 'wx' });
        created.push(file);
      } catch (e) {
        friendly(e, `create ${file}`);
      }
    }
    // login-files/style.css, unless something is already there (a shortcut is never written through)
    const filesDir = lstatOrNull(join(abs, LOGIN_FILES));
    if (!filesDir) {
      try { mkdirSync(join(abs, LOGIN_FILES), { mode: 0o755 }); } catch (e) { friendly(e, `make the ${LOGIN_FILES} folder`); }
    }
    if ((!filesDir || (filesDir.isDirectory() && !filesDir.isSymbolicLink())) && !lstatOrNull(join(abs, LOGIN_STYLE))) {
      try {
        writeFileSync(join(abs, LOGIN_STYLE), starterStyle(rel, cfg.siteName), { mode: 0o644, flag: 'wx' });
        created.push(LOGIN_STYLE);
      } catch (e) {
        friendly(e, `create ${LOGIN_STYLE}`);
      }
    }
  }
  return { path: rel, loginCreated: created.includes('login.html'), created };
}

// "Put this on my website" (docs/examples-plan.md): the three files of a worked
// example, written into a folder she picked. The panel composes them; here they
// are checked again and written like anything else: never over something that is
// already there, never through a shortcut, and only pages, styles and scripts.
const EXAMPLE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}(?:\/[a-z0-9][a-z0-9-]{0,60})?\.(?:html|css|js)$/;
const MAX_EXAMPLE_FILE = 200_000;

export function installPages(cfg: SiteFsConfig, path: unknown, files: unknown): { path: string; created: string[] } {
  // "" means the website's own folder, which is where a first page often goes.
  const rel = typeof path === 'string' && path.trim() === '' ? '' : cleanAreaPath(path);
  if (rel === null) throw new SiteFsError('invalid', "That isn't a folder in your website.");
  const { abs } = rel === '' ? { abs: cfg.publicDir } : realDir(cfg, rel);
  if (!Array.isArray(files) || files.length === 0 || files.length > 10) throw new SiteFsError('invalid', 'Expected the files to write.');

  const writing: { rel: string; abs: string; content: string }[] = [];
  for (const raw of files) {
    const f = (raw && typeof raw === 'object' ? raw : {}) as { path?: unknown; content?: unknown };
    if (typeof f.path !== 'string' || !EXAMPLE_FILE_RE.test(f.path)) {
      throw new SiteFsError('invalid', 'A page can only be written as name.html, name.css or name.js, in this folder or one folder beside it.');
    }
    if (typeof f.content !== 'string' || f.content.length > MAX_EXAMPLE_FILE) throw new SiteFsError('invalid', `${f.path} is too big to write.`);
    const [dir, name] = f.path.includes('/') ? f.path.split('/') as [string, string] : [null, f.path];
    if (dir !== null && !isSafeEntryName(dir)) throw new SiteFsError('invalid', 'Bad folder name.');
    if (!isSafeEntryName(name)) throw new SiteFsError('invalid', 'Bad file name.');
    if (lstatOrNull(join(abs, f.path))) throw new SiteFsError('exists', `There is already a file called ${f.path} in that folder. Choose another name for the page.`);
    writing.push({ rel: f.path, abs: join(abs, f.path), content: f.content });
  }

  const created: string[] = [];
  for (const f of writing) {
    if (f.rel.includes('/')) {
      const dir = join(abs, f.rel.split('/')[0]!);
      const st = lstatOrNull(dir);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new SiteFsError('exists', `Something called ${f.rel.split('/')[0]} is in the way in that folder.`);
      if (!st) {
        try { mkdirSync(dir, { mode: 0o755 }); } catch (e) { friendly(e, 'make that folder'); }
      }
    }
    try {
      writeFileSync(f.abs, f.content, { mode: 0o644, flag: 'wx' });
      created.push(f.rel);
    } catch (e) {
      friendly(e, `create ${f.rel}`);
    }
  }
  return { path: rel, created };
}

export function unprotectDir(cfg: SiteFsConfig, path: unknown, token: unknown): { path: string; removed: boolean } {
  if (typeof token !== 'string' || !AREA_TOKEN_RE.test(token)) throw new SiteFsError('invalid', 'Bad protection id.');
  const rel = cleanAreaPath(path);
  if (!rel) throw new SiteFsError('invalid', "That isn't a folder in your website.");
  const abs = join(cfg.publicDir, rel);
  const st = lstatOrNull(abs);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return { path: rel, removed: false };
  const existing = markerToken(abs);
  if (existing === undefined) return { path: rel, removed: false };
  if (existing !== token) throw new SiteFsError('exists', 'That folder belongs to a different protection.');
  try { rmSync(join(abs, MARKER)); } catch (e) { friendly(e, 'unprotect that folder'); }
  return { path: rel, removed: true };
}

