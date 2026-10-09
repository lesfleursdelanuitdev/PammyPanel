// The website folder helper: filesystem operations on real temp folders, and
// its socket protocol. Runs as momolig; ownership as pamela is checked live by
// verify-panel.sh.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { newNameProblem, parseTrashEntry, reservedNames, trashStamp } from '@panel/core/names';
import { callSiteFs, readFromSiteFs, SiteFsCallError, uploadToSiteFs } from '@panel/files/sitefs/client';
import { Readable } from 'node:stream';
import {
  createFolder, installPages, listDirs, listTrash, listFolders, markers, protectDir, purgeTrash, restoreFolder, SiteFsError, trashFolder,
  unprotectDir, type SiteFsConfig,
} from '@panel/files/sitefs/ops';
import { filesCopy, filesMkdir, filesMove, filesRestore, filesTrash, filesUpload, mediaCreate, mediaList, mediaScan, mediaSites } from '@panel/files/sitefs/media';
import { saveText } from '@panel/files/sitefs/edit';
import { homePageGet, homePageRemove, homePageSave } from '@panel/files/sitefs/home-page';
import { createSiteFsServer } from '@panel/files/sitefs/service';

let root: string;
let cfg: SiteFsConfig;
let clock = Date.UTC(2026, 8, 16, 12, 0, 0);

function fresh() {
  clock = Date.UTC(2026, 8, 16, 12, 0, 0);
  rmSync(join(root, 'pamela'), { recursive: true, force: true });
  const pub = join(root, 'pamela', 'public');
  const trash = join(root, 'pamela', 'trash');
  mkdirSync(pub, { recursive: true });
  mkdirSync(trash, { recursive: true });
  chmodSync(pub, 0o2750);          // like the real web root: setgid
  writeFileSync(join(root, 'placement'), 'subdomain blog\n');
  cfg = { publicDir: pub, trashDir: trash, placementFile: join(root, 'placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date(clock) };
}

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof SiteFsError) return e.code; throw e; }
  return 'ok';
};

before(() => { root = mkdtempSync(join(tmpdir(), 'pammy-sitefs-test-')); });
after(() => rmSync(root, { recursive: true, force: true }));

describe('name rules', () => {
  it('accepts exactly what the nginx folder-subdomain regex accepts', () => {
    const r = reservedNames('subdomain blog');
    for (const ok of ['recipes', 'my-recipes', '2026-trip', 'a', 'x'.repeat(63)]) assert.equal(newNameProblem(ok, r), null, ok);
    for (const bad of ['', 'Recipes', 'my_recipes', 'my recipes', '-x', 'x-', 'a.b', '../x', 'x'.repeat(64), 'é']) {
      assert.notEqual(newNameProblem(bad, r), null, bad);
    }
  });
  it('reserves www, api, panel and wherever WordPress is placed', () => {
    assert.deepEqual(reservedNames('subdomain blog'), ['www', 'api', 'panel', 'media', 'blog']);
    assert.deepEqual(reservedNames('path news\n'), ['www', 'api', 'panel', 'media', 'news']);
    assert.deepEqual(reservedNames('root'), ['www', 'api', 'panel', 'media']);
    assert.deepEqual(reservedNames(null), ['www', 'api', 'panel', 'media']);
    assert.match(newNameProblem('blog', reservedNames('subdomain blog'))!, /already used/);
  });
  it('round-trips trash stamps', () => {
    const d = new Date(Date.UTC(2026, 8, 16, 17, 5, 9));
    assert.equal(trashStamp(d), '20260916T170509Z');
    assert.deepEqual(parseTrashEntry('my--recipes--20260916T170509Z'), { name: 'my--recipes', trashedAt: d.getTime() / 1000 });
    assert.equal(parseTrashEntry('recipes'), null);
    assert.equal(parseTrashEntry('.hidden--20260916T170509Z'), null);
  });
});

describe('folder operations', () => {
  beforeEach(fresh);

  it('creates a folder with a starter page, modes like her uploads, setgid inherited', () => {
    createFolder(cfg, 'recipes');
    const dir = join(cfg.publicDir, 'recipes');
    const st = statSync(dir);
    assert.ok(st.isDirectory());
    assert.equal(st.mode & 0o2777, 0o2755, 'folder 2755 (setgid from the web root)');
    assert.equal(st.gid, statSync(cfg.publicDir).gid, 'group inherited from the web root');
    const idx = statSync(join(dir, 'index.html'));
    assert.equal(idx.mode & 0o777, 0o644);
    assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /<h1>recipes<\/h1>/);
  });

  it('refuses bad, reserved and existing names, including files and links with that name', () => {
    assert.equal(code(() => createFolder(cfg, '../escape')), 'invalid');
    assert.equal(code(() => createFolder(cfg, 'Recipes')), 'invalid');
    assert.equal(code(() => createFolder(cfg, 'panel')), 'invalid');
    assert.equal(code(() => createFolder(cfg, 'blog')), 'invalid');
    assert.equal(code(() => createFolder(cfg, { name: 'x' })), 'invalid');
    createFolder(cfg, 'recipes');
    assert.equal(code(() => createFolder(cfg, 'recipes')), 'exists');
    writeFileSync(join(cfg.publicDir, 'notes'), 'a file');
    assert.equal(code(() => createFolder(cfg, 'notes')), 'exists');
    symlinkSync('/tmp', join(cfg.publicDir, 'linky'));
    assert.equal(code(() => createFolder(cfg, 'linky')), 'exists');
    assert.ok(!existsSync(join(root, 'escape')));
  });

  it('lists folders only, hiding dotfiles, and says which are subdomains', () => {
    createFolder(cfg, 'recipes');
    mkdirSync(join(cfg.publicDir, 'My Photos'));
    mkdirSync(join(cfg.publicDir, 'blog'));
    mkdirSync(join(cfg.publicDir, '.git'));
    writeFileSync(join(cfg.publicDir, 'index.html'), 'home');
    const l = listFolders(cfg);
    assert.deepEqual(l.folders.map((f) => f.name), ['blog', 'My Photos', 'recipes']);
    const by = Object.fromEntries(l.folders.map((f) => [f.name, f]));
    assert.equal(by.recipes!.subdomain, true);
    assert.equal(by.recipes!.hasIndex, true);
    assert.equal(by['My Photos']!.subdomain, false);
    assert.equal(by.blog!.subdomain, false);
    assert.equal(by.blog!.reserved, true);
    assert.deepEqual(l.reserved, ['www', 'api', 'panel', 'media', 'blog']);
  });

  // docs/adapters-plan.md A5: a site whose folders are not subdomains (lfdln)
  it('on a site whose folders are not subdomains, says none is', () => {
    const routed = { ...cfg, folderSubdomains: false };
    createFolder(routed, 'recipes');
    assert.equal(listFolders(routed).folders.find((f) => f.name === 'recipes')!.subdomain, false);
    assert.equal(listFolders(cfg).folders.find((f) => f.name === 'recipes')!.subdomain, true);
  });

  // docs/adapters-plan.md A6: the upload limit is the site's
  it("refuses an upload over the site's limit, saying the limit", async () => {
    const small = { ...cfg, maxUpload: 1024 * 1024 };
    mkdirSync(join(cfg.publicDir, 'media', 'files'), { recursive: true });
    await assert.rejects(filesUpload(small, { dir: 'media/files', name: 'big.bin', size: 2 * 1024 * 1024 }, Readable.from([])),
      (e: unknown) => e instanceof SiteFsError && /at most 1 MB/.test(e.message));
  });

  it('moves a folder to the trash and back', () => {
    createFolder(cfg, 'recipes');
    writeFileSync(join(cfg.publicDir, 'recipes', 'beef.html'), 'beef');
    const t = trashFolder(cfg, 'recipes');
    assert.equal(t.entry, 'recipes--20260916T120000Z');
    assert.equal(t.purgeAt - t.trashedAt, 30 * 86400);
    assert.ok(!existsSync(join(cfg.publicDir, 'recipes')));
    assert.deepEqual(listFolders(cfg).trash.map((x) => x.name), ['recipes']);

    assert.deepEqual(restoreFolder(cfg, t.entry), { name: 'recipes' });
    assert.equal(readFileSync(join(cfg.publicDir, 'recipes', 'beef.html'), 'utf8'), 'beef');
    assert.equal(readdirSync(cfg.trashDir).length, 0);
  });

  it('trashes folders whose names are not subdomains, and shortcuts without touching their target', () => {
    mkdirSync(join(cfg.publicDir, 'My Photos'));
    assert.equal(code(() => trashFolder(cfg, 'My Photos')), 'ok');
    const target = join(root, 'outside');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep.txt'), 'keep');
    symlinkSync(target, join(cfg.publicDir, 'shortcut'));
    clock += 1000;
    const t = trashFolder(cfg, 'shortcut');
    assert.ok(lstatSync(join(cfg.trashDir, t.entry)).isSymbolicLink());
    assert.ok(existsSync(join(target, 'keep.txt')));
  });

  it('refuses to trash files, missing folders, hidden or path-like names', () => {
    writeFileSync(join(cfg.publicDir, 'index.html'), 'home');
    mkdirSync(join(cfg.publicDir, '.git'));
    assert.equal(code(() => trashFolder(cfg, 'index.html')), 'invalid');
    assert.equal(code(() => trashFolder(cfg, 'nope')), 'not-found');
    assert.equal(code(() => trashFolder(cfg, '.git')), 'invalid');
    assert.equal(code(() => trashFolder(cfg, '..')), 'invalid');
    assert.equal(code(() => trashFolder(cfg, '../trash')), 'invalid');
    assert.equal(code(() => trashFolder(cfg, 'a/b')), 'invalid');
    assert.ok(existsSync(join(cfg.publicDir, '.git')));
  });

  it('never replaces an existing folder when restoring; offers another name instead', () => {
    createFolder(cfg, 'recipes');
    const t = trashFolder(cfg, 'recipes');
    createFolder(cfg, 'recipes');
    assert.equal(code(() => restoreFolder(cfg, t.entry)), 'exists');
    assert.equal(code(() => restoreFolder(cfg, t.entry, 'Bad Name')), 'invalid');
    assert.equal(code(() => restoreFolder(cfg, t.entry, 'www')), 'invalid');
    assert.deepEqual(restoreFolder(cfg, t.entry, 'recipes-old'), { name: 'recipes-old' });
    assert.ok(existsSync(join(cfg.publicDir, 'recipes-old', 'index.html')));
  });

  it('never restores out of anywhere but the trash', () => {
    assert.equal(code(() => restoreFolder(cfg, '../public/x--20260916T120000Z')), 'invalid');
    assert.equal(code(() => restoreFolder(cfg, 'nothing-here')), 'invalid');
    assert.equal(code(() => restoreFolder(cfg, 'ghost--20260916T120000Z')), 'not-found');
  });

  it('refuses to trash into an entry that already exists (rename would replace an empty folder)', () => {
    mkdirSync(join(cfg.publicDir, 'recipes'));
    mkdirSync(join(cfg.trashDir, 'recipes--20260916T120000Z'));
    assert.equal(code(() => trashFolder(cfg, 'recipes')), 'exists');
    assert.ok(existsSync(join(cfg.publicDir, 'recipes')));
  });

  it('purges only entries older than 30 days, and leaves anything it did not put there', () => {
    createFolder(cfg, 'old');
    trashFolder(cfg, 'old');
    clock += 20 * 86400 * 1000;
    createFolder(cfg, 'newer');
    trashFolder(cfg, 'newer');
    mkdirSync(join(cfg.trashDir, 'something-she-put-here'));
    clock += 11 * 86400 * 1000;
    const r = purgeTrash(cfg);
    assert.deepEqual(r.purged.map((e) => e.replace(/--.*/, '')), ['old']);
    assert.deepEqual(readdirSync(cfg.trashDir).sort(), ['newer--20261006T120000Z', 'something-she-put-here'].sort());
  });
});

// docs/phase8-plan.md P8-1: on lfdln the top holds only site folders, and Hosts keeps them
describe('a site whose top is Hosts\' (hostsKeepTop)', () => {
  beforeEach(fresh);
  const top = (e: unknown) => e instanceof SiteFsError && /Hosts page/.test(e.message);

  it('File Explorer makes, copies, moves and uploads nothing into the top, and never renames or trashes a site folder', async () => {
    const lfdln = { ...cfg, hostsKeepTop: true, folderSubdomains: false };
    mkdirSync(join(cfg.publicDir, 'docs', 'inner'), { recursive: true });
    mkdirSync(join(cfg.publicDir, 'other'));
    writeFileSync(join(cfg.publicDir, 'docs', 'a.txt'), 'a');
    assert.throws(() => filesMkdir(lfdln, '', 'new'), top);
    assert.throws(() => filesCopy(lfdln, 'docs/a.txt', '', null), top);
    assert.throws(() => filesMove(lfdln, 'docs/a.txt', '', null), top);
    assert.throws(() => filesMove(lfdln, 'docs', '', 'renamed'), top, 'a site folder renamed');
    assert.throws(() => filesMove(lfdln, 'docs', 'other', null), top, 'a site folder moved into another');
    assert.throws(() => filesTrash(lfdln, 'docs'), top);
    await assert.rejects(filesUpload(lfdln, { dir: '', name: 'x.txt', size: 1 }, Readable.from([Buffer.from('x')])), top);
    await assert.rejects(saveText(lfdln, { path: 'x.html', create: 'exact', actor: 't', expect: null }, Buffer.from('<p>x</p>')), top);
    // inside a site folder, anything goes
    assert.equal(filesMkdir(lfdln, 'docs', 'more').path, 'docs/more');
    assert.equal(filesCopy(lfdln, 'docs/a.txt', 'other', null).path, 'other/a.txt');
    assert.equal(filesMove(lfdln, 'docs/inner', 'other', null).path, 'other/inner');
    assert.equal((await saveText(lfdln, { path: 'docs/x.html', create: 'exact', actor: 't', expect: null }, Buffer.from('<p>x</p>'))).path, 'docs/x.html');
    // a file whose site folder went while it was in the trash doesn't land at the top
    const t = filesTrash(lfdln, 'other/a.txt');
    rmSync(join(cfg.publicDir, 'other'), { recursive: true });
    assert.throws(() => filesRestore(lfdln, t.id, null), (e: unknown) => e instanceof SiteFsError && /Hosts page/.test(e.message));
    // pammy.org's top is hers, as ever
    assert.equal(filesMkdir(cfg, '', 'new').path, 'new');
  });

  // docs/phase8-plan.md P8-5: no main site's media folder; each site folder has its own
  it('media folders: only inside a site folder, never at the top', () => {
    const lfdln = { ...cfg, hostsKeepTop: true, folderSubdomains: false };
    mkdirSync(join(cfg.publicDir, 'home'));
    mkdirSync(join(cfg.publicDir, 'media', 'images'), { recursive: true });   // (left by hand: not a media folder here)
    const noMain = (e: unknown) => e instanceof SiteFsError && /inside a site folder/.test(e.message);
    assert.deepEqual(mediaSites(lfdln).folders.map((f) => f.folder), ['home'], 'no "" and no top-level media');
    assert.throws(() => mediaCreate(lfdln, ''), noMain);
    assert.deepEqual(mediaCreate(lfdln, 'home').created, ['media', 'media/images', 'media/files', 'media/audio', 'media/video']);
    assert.equal(mediaList(lfdln, 'home/media/images').path, 'home/media/images');
    assert.throws(() => mediaList(lfdln, 'media/images'), noMain);
    // pammy.org: the main site's, as ever
    assert.equal(mediaSites(cfg).folders[0]!.folder, '');
    assert.equal(mediaList(cfg, 'media/images').path, 'media/images');
  });
});

describe('a temporary home page (docs/temporary-home-plan.md)', () => {
  beforeEach(fresh);
  const words = (o: Record<string, unknown> = {}) => ({ heading: 'Coming soon', message: 'Back soon.\n\nHonest <b>&</b> true.', link: true, style: 'plain', ...o });
  const index = (name: string) => readFileSync(join(cfg.publicDir, name, 'index.html'), 'utf8');
  const kindOf = (name: string) => listFolders(cfg).folders.find((f) => f.name === name)!.homePage;

  it('a folder with no home page gets one, with her words, escaped', () => {
    mkdirSync(join(cfg.publicDir, 'garden'));
    assert.equal(kindOf('garden'), 'none');
    assert.equal(listFolders(cfg).folders.find((f) => f.name === 'garden')!.hasIndex, false);
    const r = homePageSave(cfg, 'garden', words(), 'pammy.org');
    assert.equal(r.made, true);
    const html = index('garden');
    assert.match(html, /<h1>Coming soon<\/h1>/);
    assert.match(html, /<p>Back soon\.<\/p>\n    <p>Honest &lt;b&gt;&amp;&lt;\/b&gt; true\.<\/p>/);
    assert.match(html, /<a href="https:\/\/pammy\.org\/">Go to pammy\.org<\/a>/);
    assert.equal(statSync(join(cfg.publicDir, 'garden', 'index.html')).mode & 0o777, 0o644);
    assert.deepEqual(readdirSync(join(cfg.publicDir, 'garden')), ['index.html'], 'nothing left over from writing it');
    assert.equal(kindOf('garden'), 'temporary');
    // and the panel gets her words back to change them
    assert.deepEqual(homePageGet(cfg, 'garden').words, { heading: 'Coming soon', message: 'Back soon.\n\nHonest <b>&</b> true.', link: true, style: 'plain' });
    homePageSave(cfg, 'garden', words({ heading: 'Open in spring', link: false }), 'pammy.org');
    assert.match(index('garden'), /<h1>Open in spring<\/h1>/);
    assert.doesNotMatch(index('garden'), /Go to pammy/);
  });

  it('wears one of her stylesheets: the folder\'s, or the main site\'s by its whole address', () => {
    mkdirSync(join(cfg.publicDir, 'garden'));
    writeFileSync(join(cfg.publicDir, 'garden', 'style.css'), 'h1 { color: green }');
    writeFileSync(join(cfg.publicDir, 'site.css'), 'body { }');
    writeFileSync(join(cfg.publicDir, 'garden', 'odd name.css'), '');
    assert.deepEqual(homePageGet(cfg, 'garden').styles.map((s) => s.id), ['plain', 'folder:style.css', 'site:site.css']);
    homePageSave(cfg, 'garden', words({ style: 'folder:style.css' }), 'pammy.org');
    assert.match(index('garden'), /<link rel="stylesheet" href="style\.css">/);
    assert.doesNotMatch(index('garden'), /<body style=/, 'her look, not the plain one');
    homePageSave(cfg, 'garden', words({ style: 'site:site.css' }), 'pammy.org');
    assert.match(index('garden'), /href="https:\/\/pammy\.org\/site\.css"/);
    assert.equal(code(() => homePageSave(cfg, 'garden', words({ style: 'site:../../etc/passwd' }), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, 'garden', words({ style: 'folder:gone.css' }), 'pammy.org')), 'invalid');
  });

  it('never over a page of hers, never in a protected folder, only in a folder that can be a subdomain', () => {
    for (const d of ['mine', 'php', 'locked', 'My Stuff', 'blog', 'real']) mkdirSync(join(cfg.publicDir, d));
    writeFileSync(join(cfg.publicDir, 'mine', 'index.html'), '<h1>Mine</h1>');
    writeFileSync(join(cfg.publicDir, 'php', 'index.php'), '<?php echo 1;');
    writeFileSync(join(cfg.publicDir, 'locked', '.pammy-protected'), 'token');
    symlinkSync(join(cfg.publicDir, 'real'), join(cfg.publicDir, 'shortcut'));
    assert.equal(code(() => homePageSave(cfg, 'mine', words(), 'pammy.org')), 'exists');
    assert.equal(readFileSync(join(cfg.publicDir, 'mine', 'index.html'), 'utf8'), '<h1>Mine</h1>');
    assert.equal(code(() => homePageRemove(cfg, 'mine')), 'not-allowed');
    assert.equal(code(() => homePageSave(cfg, 'php', words(), 'pammy.org')), 'exists');
    assert.equal(code(() => homePageSave(cfg, 'locked', words(), 'pammy.org')), 'not-allowed');
    assert.equal(listFolders(cfg).folders.find((f) => f.name === 'locked')!.protected, true);
    assert.equal(code(() => homePageSave(cfg, 'My Stuff', words(), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, 'blog', words(), 'pammy.org')), 'invalid', 'WordPress has that name');
    assert.equal(code(() => homePageSave(cfg, 'shortcut', words(), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, '..', words(), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, 'nope', words(), 'pammy.org')), 'not-found');
    assert.equal(code(() => homePageSave(cfg, 'real', words({ heading: ' ' }), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, 'real', words({ heading: 'x'.repeat(121) }), 'pammy.org')), 'invalid');
    assert.equal(code(() => homePageSave(cfg, 'real', words(), 'evil.example/"><script>')), 'invalid');
  });

  it('a new subdomain\'s starter page is one, and so is an old starter page; removing it leaves "no home page"', () => {
    createFolder(cfg, 'recipes');
    assert.equal(kindOf('recipes'), 'temporary');
    assert.equal(homePageGet(cfg, 'recipes').words!.heading, 'recipes');
    mkdirSync(join(cfg.publicDir, 'old'));
    writeFileSync(join(cfg.publicDir, 'old', 'index.html'), '<p>Coming soon.</p>\n<!-- A starter page made by the pammy.org control panel. Replace it with your own. -->');
    assert.equal(kindOf('old'), 'temporary');
    homePageRemove(cfg, 'recipes');
    assert.equal(kindOf('recipes'), 'none');
  });
});

describe('socket protocol', () => {
  let sock: string;
  let server: ReturnType<typeof createSiteFsServer>;
  const lines: string[] = [];

  before(async () => {
    fresh();
    sock = join(root, 'sitefs.sock');
    server = createSiteFsServer(cfg, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(sock, r));
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const raw = (payload: string) => new Promise<string>((resolve) => {
    const c = connect(sock);
    let out = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { out += d; });
    c.on('end', () => resolve(out));
    c.on('error', () => resolve(out));
    c.write(payload);
  });

  it('does a full create / list / trash / restore round trip', async () => {
    await callSiteFs(sock, { op: 'create', name: 'garden', actor: 'pamela' });
    const l = await callSiteFs<{ folders: { name: string }[] }>(sock, { op: 'list' });
    assert.ok(l.folders.some((f) => f.name === 'garden'));
    const t = await callSiteFs<{ entry: string }>(sock, { op: 'trash', name: 'garden' });
    await callSiteFs(sock, { op: 'restore', entry: t.entry });
    assert.ok(existsSync(join(cfg.publicDir, 'garden')));
    assert.ok(lines.some((l2) => l2.startsWith('op=create target="garden" actor=pamela ok')));
  });

  it('passes refusals back with their code', async () => {
    await assert.rejects(callSiteFs(sock, { op: 'create', name: 'garden' }), (e: SiteFsCallError) => e.code === 'exists');
    await assert.rejects(callSiteFs(sock, { op: 'rm -rf', name: 'garden' }), (e: SiteFsCallError) => e.code === 'invalid');
  });

  it('rejects malformed and oversized requests', async () => {
    assert.match(await raw('not json\n'), /"error":"invalid"/);
    assert.match(await raw('[1,2]\n'), /"error":"invalid"/);
    assert.match(await raw(`${'x'.repeat(70_000)}`), /Request too large/);
  });

  it('reports an unreachable helper as unavailable', async () => {
    await assert.rejects(callSiteFs(join(root, 'nope.sock'), { op: 'list' }), (e: SiteFsCallError) => e.code === 'unavailable');
  });
});

describe('protected folder files', () => {
  beforeEach(fresh);
  const T1 = 'a'.repeat(32);
  const T2 = 'b'.repeat(32);
  const ALL_PAGES = ['login.html', 'login-forgot.html', 'login-invite.html', 'login-request.html', 'logout.html', 'login-files/style.css'];

  it('protects a folder: marker (644) plus five starter sign-in pages and their stylesheet, without touching existing ones', () => {
    mkdirSync(join(cfg.publicDir, 'recipes', 'family'), { recursive: true });
    const r = protectDir(cfg, 'recipes/family', T1);
    assert.deepEqual(r, { path: 'recipes/family', loginCreated: true, created: ALL_PAGES });
    const dir = join(cfg.publicDir, 'recipes', 'family');
    assert.equal(readFileSync(join(dir, '.pammy-protected'), 'utf8'), `pammy-protected ${T1}\n`);
    assert.equal(statSync(join(dir, '.pammy-protected')).mode & 0o777, 0o644);
    const page = readFileSync(join(dir, 'login.html'), 'utf8');
    assert.match(page, /<script src="\/_pammy\/login\.js" defer><\/script>/);
    assert.match(page, /<pammy-login heading="family: members only"><\/pammy-login>/);
    assert.ok(!readdirSync(dir).some((n) => n.includes('.tmp-')), 'no temp files left');
    for (const [file, tag] of [['login-forgot.html', 'pammy-forgot'], ['login-invite.html', 'pammy-invite'], ['login-request.html', 'pammy-request'], ['logout.html', 'pammy-signed-out']]) {
      const text = readFileSync(join(dir, file!), 'utf8');
      assert.match(text, new RegExp(`<${tag}></${tag}>`), file);
      assert.match(text, /<script src="\/_pammy\/login\.js" defer><\/script>/, file);
      assert.equal(statSync(join(dir, file!)).mode & 0o777, 0o644, file);
    }
    for (const file of ALL_PAGES.filter((f) => f.endsWith('.html'))) {
      assert.match(readFileSync(join(dir, file), 'utf8'), /<link rel="stylesheet" href="login-files\/style\.css">/, `${file} uses the shared stylesheet`);
    }
    assert.equal(statSync(join(dir, 'login-files')).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, 'login-files', 'style.css')).mode & 0o777, 0o644);
    assert.match(readFileSync(join(dir, 'login-files', 'style.css'), 'utf8'), /The look of the sign-in pages of "family"[\s\S]*body \{[\s\S]*--pammy-accent/);

    mkdirSync(join(cfg.publicDir, 'club'));
    writeFileSync(join(cfg.publicDir, 'club', 'login.html'), 'MINE');
    symlinkSync('/etc/passwd', join(cfg.publicDir, 'club', 'login-request.html'));
    const club = protectDir(cfg, 'club', T2);
    assert.equal(club.loginCreated, false);
    assert.deepEqual(club.created, ['login-forgot.html', 'login-invite.html', 'logout.html', 'login-files/style.css'], 'her page and anything already there (even a shortcut) left alone');
    assert.equal(readFileSync(join(cfg.publicDir, 'club', 'login.html'), 'utf8'), 'MINE');

    // her own stylesheet stays; a login-files that's a shortcut or a file is never written into
    for (const [folder, make] of [
      ['own', () => { mkdirSync(join(cfg.publicDir, 'own', 'login-files'), { recursive: true }); writeFileSync(join(cfg.publicDir, 'own', 'login-files', 'style.css'), 'HERS'); }],
      ['linked', () => { mkdirSync(join(cfg.publicDir, 'linked')); mkdirSync(join(cfg.publicDir, 'elsewhere')); symlinkSync(join(cfg.publicDir, 'elsewhere'), join(cfg.publicDir, 'linked', 'login-files')); }],
      ['filed', () => { mkdirSync(join(cfg.publicDir, 'filed')); writeFileSync(join(cfg.publicDir, 'filed', 'login-files'), 'x'); }],
    ] as const) {
      make();
      assert.ok(!protectDir(cfg, folder, folder[0]!.repeat(32)).created.includes('login-files/style.css'), folder);
    }
    assert.equal(readFileSync(join(cfg.publicDir, 'own', 'login-files', 'style.css'), 'utf8'), 'HERS');
    assert.ok(!existsSync(join(cfg.publicDir, 'elsewhere', 'style.css')), 'nothing written through a shortcut');
  });

  it('adds only the missing pages when asked again, and none when only repairing the marker', () => {
    mkdirSync(join(cfg.publicDir, 'club'));
    protectDir(cfg, 'club', T1);
    rmSync(join(cfg.publicDir, 'club', 'login-forgot.html'));
    rmSync(join(cfg.publicDir, 'club', '.pammy-protected'));
    assert.deepEqual(protectDir(cfg, 'club', T1, false).created, [], 'repair writes only the marker');
    assert.ok(existsSync(join(cfg.publicDir, 'club', '.pammy-protected')));
    assert.ok(!existsSync(join(cfg.publicDir, 'club', 'login-forgot.html')), 'a page she deleted stays deleted');
    assert.deepEqual(protectDir(cfg, 'club', T1).created, ['login-forgot.html']);
    rmSync(join(cfg.publicDir, 'club', 'login-files'), { recursive: true });
    assert.deepEqual(protectDir(cfg, 'club', T1).created, ['login-files/style.css'], 'the stylesheet comes back on request too');
  });

  it('escapes the folder name in the starter page', () => {
    mkdirSync(join(cfg.publicDir, 'a"<b>&c'));
    protectDir(cfg, 'a"<b>&c', T1);
    assert.match(readFileSync(join(cfg.publicDir, 'a"<b>&c', 'login.html'), 'utf8'), /a&quot;&lt;b&gt;&amp;c: members only/);
  });

  it('is repeatable with the same id, and refuses a folder that belongs to another protection', () => {
    mkdirSync(join(cfg.publicDir, 'club'));
    protectDir(cfg, 'club', T1);
    assert.equal(code(() => protectDir(cfg, 'club', T1)), 'ok');
    assert.equal(code(() => protectDir(cfg, 'club', T2)), 'exists');
    assert.equal(code(() => unprotectDir(cfg, 'club', T2)), 'exists');
    assert.ok(existsSync(join(cfg.publicDir, 'club', '.pammy-protected')));
  });

  it('refuses shortcuts, files, missing folders, the whole site and path tricks', () => {
    mkdirSync(join(cfg.publicDir, 'real'));
    symlinkSync(join(cfg.publicDir, 'real'), join(cfg.publicDir, 'link'));
    writeFileSync(join(cfg.publicDir, 'file.html'), 'x');
    assert.equal(code(() => protectDir(cfg, 'link', T1)), 'invalid');
    assert.equal(code(() => protectDir(cfg, 'file.html', T1)), 'invalid');
    assert.equal(code(() => protectDir(cfg, 'nope', T1)), 'not-found');
    for (const p of ['', '/', '..', '../trash', 'real/../..', '.git', 'real/.hidden']) {
      assert.equal(code(() => protectDir(cfg, p, T1)), 'invalid', p);
    }
    assert.equal(code(() => protectDir(cfg, 'real', 'short')), 'invalid');
    assert.ok(!existsSync(join(cfg.publicDir, '.pammy-protected')));
  });

  it('unprotects by removing only its own marker, leaving login.html', () => {
    mkdirSync(join(cfg.publicDir, 'club'));
    protectDir(cfg, 'club', T1);
    assert.deepEqual(unprotectDir(cfg, 'club', T1), { path: 'club', removed: true });
    assert.ok(!existsSync(join(cfg.publicDir, 'club', '.pammy-protected')));
    assert.ok(existsSync(join(cfg.publicDir, 'club', 'login.html')));
    assert.deepEqual(unprotectDir(cfg, 'club', T1), { path: 'club', removed: false });
    assert.deepEqual(unprotectDir(cfg, 'gone', T1), { path: 'gone', removed: false });
  });

  it('finds markers wherever they have been moved or copied, and reports folder state', () => {
    mkdirSync(join(cfg.publicDir, 'recipes', 'family'), { recursive: true });
    protectDir(cfg, 'recipes/family', T1);
    renameSync(join(cfg.publicDir, 'recipes', 'family'), join(cfg.publicDir, 'recipes', 'fam'));
    mkdirSync(join(cfg.publicDir, 'odd'));
    writeFileSync(join(cfg.publicDir, 'odd', '.pammy-protected'), 'garbage');
    const m = markers(cfg, ['recipes/family', 'recipes/fam', '../x']);
    assert.deepEqual(m.found.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'odd', token: null, hasLogin: false, pages: [], hasIndex: false },
      { path: 'recipes/fam', token: T1, hasLogin: true, pages: ALL_PAGES, hasIndex: false },
    ]);
    rmSync(join(cfg.publicDir, 'recipes', 'fam', 'login.html'));
    writeFileSync(join(cfg.publicDir, 'recipes', 'fam', 'index.html'), 'home');
    assert.deepEqual(markers(cfg, ['recipes/family', 'recipes/fam', '../x']).status, [
      { path: 'recipes/family', exists: false, hasLogin: false, pages: [], hasIndex: false, marker: null },
      { path: 'recipes/fam', exists: true, hasLogin: false, pages: ALL_PAGES.slice(1), hasIndex: true, marker: T1 },
      { path: '../x', exists: false, hasLogin: false, pages: [], hasIndex: false, marker: null },
    ]);
  });

  it('lists folders to choose from at every depth, without hidden folders, shortcuts, login-files or media', () => {
    mkdirSync(join(cfg.publicDir, 'recipes', 'family', 'login-files'), { recursive: true });
    mkdirSync(join(cfg.publicDir, 'recipes', 'media', 'images', '2026-trip'), { recursive: true });
    mkdirSync(join(cfg.publicDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(cfg.publicDir, 'recipes', 'family', '.drafts'), { recursive: true });
    mkdirSync(join(cfg.publicDir, 'b'));
    symlinkSync(join(cfg.publicDir, 'b'), join(cfg.publicDir, 'c'));
    const deep = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
    mkdirSync(join(cfg.publicDir, 'b', ...deep), { recursive: true });
    assert.deepEqual(listDirs(cfg), ['b', ...deep.map((_, i) => ['b', ...deep.slice(0, i + 1)].join('/')), 'recipes', 'recipes/family']);
  });
});

describe('a worked example, written into her website', () => {
  beforeEach(fresh);
  const files = () => [
    { path: 'guestbook.html', content: '<pammy-form name="olivias-book"></pammy-form>' },
    { path: 'guestbook-files/style.css', content: 'body { margin: 0; }' },
    { path: 'guestbook-files/entries.js', content: '// the little program' },
  ];

  it('writes the page and its two files, into a folder or the website itself', () => {
    mkdirSync(join(cfg.publicDir, 'party'));
    const r = installPages(cfg, 'party', files());
    assert.deepEqual(r, { path: 'party', created: ['guestbook.html', 'guestbook-files/style.css', 'guestbook-files/entries.js'] });
    const dir = join(cfg.publicDir, 'party');
    assert.match(readFileSync(join(dir, 'guestbook.html'), 'utf8'), /olivias-book/);
    assert.equal(statSync(join(dir, 'guestbook.html')).mode & 0o777, 0o644);
    assert.equal(statSync(join(dir, 'guestbook-files')).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, 'guestbook-files', 'entries.js')).mode & 0o777, 0o644);
    // the website's own folder counts as a folder
    assert.deepEqual(installPages(cfg, '', files()).path, '');
    assert.ok(existsSync(join(cfg.publicDir, 'guestbook.html')));
  });

  it('never writes over anything, and only writes pages, styles and scripts', () => {
    mkdirSync(join(cfg.publicDir, 'party'));
    writeFileSync(join(cfg.publicDir, 'party', 'guestbook.html'), 'hers');
    assert.equal(code(() => installPages(cfg, 'party', files())), 'exists');
    assert.equal(readFileSync(join(cfg.publicDir, 'party', 'guestbook.html'), 'utf8'), 'hers');
    assert.ok(!existsSync(join(cfg.publicDir, 'party', 'guestbook-files')), 'and nothing else is written either');

    assert.equal(code(() => installPages(cfg, 'party', [{ path: '../escape.html', content: 'x' }])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'party', [{ path: 'deep/er/still.html', content: 'x' }])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'party', [{ path: 'notes.txt', content: 'x' }])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'party', [{ path: '.hidden.html', content: 'x' }])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'party', [{ path: 'big.html', content: 'x'.repeat(200_001) }])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'party', [])), 'invalid');
    assert.equal(code(() => installPages(cfg, 'nowhere', files())), 'not-found');
  });

  it('refuses to write through a shortcut', () => {
    mkdirSync(join(cfg.publicDir, 'party'));
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(cfg.publicDir, 'party', 'guestbook-files'));
    assert.equal(code(() => installPages(cfg, 'party', files())), 'exists');
    assert.equal(readdirSync(join(root, 'elsewhere')).length, 0);
    symlinkSync(join(root, 'elsewhere'), join(cfg.publicDir, 'link'));
    assert.equal(code(() => installPages(cfg, 'link', files())), 'invalid');
  });
});

describe('media folders', () => {
  let sock: string;
  let server: ReturnType<typeof createSiteFsServer>;
  const pub = () => cfg.publicDir;
  const call = <T = any>(req: Record<string, unknown>) => callSiteFs<T>(sock, req);
  const refusal = async (req: Record<string, unknown>) => {
    try { await call(req); return 'ok'; } catch (e) { return (e as SiteFsCallError).code; }
  };
  const upload = (dir: string, name: string, data: Buffer | string, size?: number) =>
    uploadToSiteFs<{ path: string; name: string; renamed: boolean }>(sock, { op: 'media-upload', dir, name, size: size ?? Buffer.byteLength(data) }, Readable.from([Buffer.from(data)]));
  const download = async (req: Record<string, unknown>) => {
    const { header, bytes } = await readFromSiteFs<{ size: number; start: number; end: number }>(sock, { op: 'media-read', ...req });
    const chunks: Buffer[] = [];
    for await (const c of bytes) chunks.push(c as Buffer);
    return { header, body: Buffer.concat(chunks) };
  };
  // a real 3x2 PNG header and a JPEG with a 640x480 frame, enough to read their size
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 2, 0, 0, 0])]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0]);

  before(async () => {
    fresh();
    mkdirSync(join(pub(), 'recipes', 'beef'), { recursive: true });
    sock = join(root, 'media.sock');
    server = createSiteFsServer(cfg);
    await new Promise<void>((r) => server.listen(sock, r));
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('makes a media folder with its four folders, at the top or one folder down, only where asked', async () => {
    assert.deepEqual((await call({ op: 'media-sites' })).folders, [
      { folder: '', hasMedia: false }, { folder: 'recipes', hasMedia: false }], 'only the top and the folders directly inside it');
    const r = await call({ op: 'media-create', folder: 'recipes' });
    assert.deepEqual(r, { folder: 'recipes', created: ['media', 'media/images', 'media/files', 'media/audio', 'media/video'] });
    assert.equal(statSync(join(pub(), 'recipes', 'media', 'images')).mode & 0o7777, 0o2755, 'like her own folders: setgid, readable by the web server');
    assert.deepEqual((await call({ op: 'media-create', folder: 'recipes' })).created, [], 'again: nothing to do');
    await call({ op: 'media-create', folder: '' });
    rmSync(join(pub(), 'media', 'audio'), { recursive: true });
    assert.deepEqual((await call({ op: 'media-create', folder: '' })).created, ['media/audio'], 'puts back a missing one');
    const sites = (await call({ op: 'media-sites' })).folders;
    assert.deepEqual(sites.map((f: { folder: string; hasMedia: boolean }) => `${f.folder}:${f.hasMedia}`), [':true', 'recipes:true'], 'media folders are not sites');
    assert.deepEqual(listDirs(cfg), ['recipes', 'recipes/beef'], 'and are left out of the folder lists');
    assert.ok(!listFolders(cfg).folders.some((f) => f.name === 'media'));
    for (const folder of ['nope', 'recipes/media', '../x', '/etc']) assert.notEqual(await refusal({ op: 'media-create', folder }), 'ok', folder);
    assert.equal(await refusal({ op: 'media-create', folder: 'recipes/beef' }), 'invalid', 'never deeper than one folder down');
    mkdirSync(join(pub(), 'shop'));
    writeFileSync(join(pub(), 'shop', 'media'), 'a file');
    assert.equal(await refusal({ op: 'media-create', folder: 'shop' }), 'exists');
    rmSync(join(pub(), 'shop'), { recursive: true });
    // a media folder somebody made deeper by hand is not one the panel works in
    mkdirSync(join(pub(), 'recipes', 'beef', 'media', 'images'), { recursive: true });
    writeFileSync(join(pub(), 'recipes', 'beef', 'media', 'images', 'x.jpg'), 'x');
    assert.equal(await refusal({ op: 'media-list', dir: 'recipes/beef/media/images' }), 'invalid');
    assert.equal(await refusal({ op: 'media-trash', path: 'recipes/beef/media/images/x.jpg' }), 'invalid');
    rmSync(join(pub(), 'recipes', 'beef', 'media'), { recursive: true });
  });

  it('uploads into the right kind of folder, never overwriting, and leaves nothing behind when it fails', async () => {
    const a = await upload('recipes/media/images', 'lasagne.jpg', JPEG);
    const { modifiedAt, ...rest } = a as typeof a & { modifiedAt: number };
    assert.deepEqual(rest, { path: 'recipes/media/images/lasagne.jpg', name: 'lasagne.jpg', renamed: false, size: JPEG.length,
      hash: createHash('sha256').update(JPEG).digest('hex') }, 'with what the panel records: size, time and sha256');
    assert.equal(modifiedAt, Math.floor(statSync(join(pub(), a.path)).mtimeMs / 1000));
    assert.equal(statSync(join(pub(), a.path)).mode & 0o777, 0o644);
    const b = await upload('recipes/media/images', 'lasagne.jpg', 'other');
    assert.deepEqual([b.name, b.renamed], ['lasagne-2.jpg', true]);
    assert.deepEqual(readFileSync(join(pub(), a.path)), JPEG, 'the first one is untouched');
    assert.equal((await upload('recipes/media/images', '../../../evil.png', PNG)).path, 'recipes/media/images/evil.png', 'no way out of the folder');
    const refuse = async (dir: string, name: string, data: string, size?: number) => {
      try { await upload(dir, name, data, size); return 'ok'; } catch (e) { return (e as SiteFsCallError).message; }
    };
    assert.match(await refuse('recipes/media/images', 'song.mp3', 'x'), /isn't an image/);
    assert.match(await refuse('recipes/media/files', 'page.html', 'x'), /web pages and scripts/);
    assert.match(await refuse('recipes/media/files', 'drawing.svg', 'x'), /web pages and scripts/);
    assert.equal(await refuse('recipes/media/files', 'menu.pdf', 'x'), 'ok');
    assert.match(await refuse('recipes/media/video', 'huge.mp4', 'x', 101 * 1024 * 1024), /at most 100 MB/);
    assert.match(await refuse('recipes/media/audio', 'short.mp3', 'abc', 10), /stopped before the whole file/);
    assert.match(await refuse('recipes/media/audio', 'long.mp3', 'abcdef', 3), /bigger than it said/);
    assert.match(await refuse('recipes/media', 'x.jpg', 'x'), /images, files, audio or video/);
    assert.match(await refuse('recipes', 'x.jpg', 'x'), /isn't in a media folder/);
    assert.deepEqual(readdirSync(join(pub(), 'recipes', 'media', 'audio')), [], 'no half-written files');
  });

  it('lists buckets and files with sizes and dates, and reads files (or part of one) back', async () => {
    const mk = await call({ op: 'media-mkdir', dir: 'recipes/media/images', name: '2026 trip' });
    assert.equal(mk.path, 'recipes/media/images/2026 trip');
    assert.equal(await refusal({ op: 'media-mkdir', dir: 'recipes/media/images', name: '2026 trip' }), 'exists');
    assert.equal(await refusal({ op: 'media-mkdir', dir: 'recipes/media/images', name: 'media' }), 'invalid');
    writeFileSync(join(pub(), 'recipes', 'media', 'images', 'notes.txt'), 'put here with WinSCP');
    writeFileSync(join(pub(), 'recipes', 'media', 'images', '.pammy-upload-1-abc'), 'in progress');
    const l = await call({ op: 'media-list', dir: 'recipes/media/images' });
    assert.deepEqual([l.site, l.kind, l.inner], ['recipes', 'images', []]);
    assert.deepEqual(l.buckets.map((x: { name: string; items: number }) => [x.name, x.items]), [['2026 trip', 0]]);
    assert.deepEqual(l.files.map((f: { name: string; fits: boolean; size: number }) => [f.name, f.fits, f.size]),
      [['evil.png', true, PNG.length], ['lasagne-2.jpg', true, 5], ['lasagne.jpg', true, JPEG.length], ['notes.txt', false, 20]], 'hidden files left out; the odd one flagged');
    assert.ok(l.files.every((f: { createdAt: number; modifiedAt: number }) => f.createdAt > 1e9 && f.modifiedAt > 1e9));
    assert.deepEqual((await call({ op: 'media-info', path: 'recipes/media/images/lasagne.jpg' })).dimensions, { width: 640, height: 480 });
    assert.deepEqual((await call({ op: 'media-info', path: 'recipes/media/images/evil.png' })).dimensions, { width: 3, height: 2 });
    const whole = await download({ path: 'recipes/media/images/lasagne.jpg' });
    assert.deepEqual([whole.header.size, whole.body], [JPEG.length, JPEG]);
    const part = await download({ path: 'recipes/media/images/lasagne.jpg', start: 2, end: 5 });
    assert.deepEqual([part.header.start, part.header.end, part.body], [2, 5, JPEG.subarray(2, 6)]);
    await assert.rejects(readFromSiteFs(sock, { op: 'media-read', path: 'recipes/index.html' }), /media folder/);
  });

  it('copies and moves within and between media folders, checking kinds and never replacing', async () => {
    const c = await call({ op: 'media-copy', from: 'recipes/media/images/lasagne.jpg', to: 'recipes/media/images' });
    assert.equal(c.name, 'lasagne-3.jpg', 'a copy next to it gets a free name');
    const c2 = await call({ op: 'media-copy', from: 'recipes/media/images/lasagne.jpg', to: 'media/images', name: 'hero.jpg' });
    assert.equal(c2.path, 'media/images/hero.jpg', 'to the main site, under a new name');
    assert.equal(await refusal({ op: 'media-copy', from: 'recipes/media/images/lasagne.jpg', to: 'media/audio' }), 'invalid', 'a photo is not audio');
    const m = await call({ op: 'media-move', from: 'recipes/media/images/lasagne-2.jpg', to: 'recipes/media/images/2026 trip' });
    assert.equal(m.path, 'recipes/media/images/2026 trip/lasagne-2.jpg');
    assert.equal(await refusal({ op: 'media-move', from: 'recipes/media/images/lasagne-3.jpg', to: 'recipes/media/images/2026 trip', name: 'lasagne-2.jpg' }), 'exists');
    assert.equal((await call({ op: 'media-move', from: 'recipes/media/images/lasagne-3.jpg', to: 'recipes/media/images', name: 'lasagne small.jpg' })).name, 'lasagne small.jpg', 'a rename is a move in place');
    assert.equal((await call({ op: 'media-move', from: 'recipes/media/images/2026 trip', to: 'media/images' })).path, 'media/images/2026 trip', 'a whole bucket, to another site');
    await call({ op: 'media-mkdir', dir: 'media/images/2026 trip', name: 'day 1' });
    assert.equal(await refusal({ op: 'media-move', from: 'media/images/2026 trip', to: 'media/images/2026 trip/day 1' }), 'invalid', 'not inside itself');
    assert.equal(await refusal({ op: 'media-move', from: 'media/images/2026 trip', to: 'media/video' }), 'invalid', 'an images bucket stays in images');
    for (const from of ['recipes/media/images', 'recipes/media', 'recipes/index.html']) assert.equal(await refusal({ op: 'media-move', from, to: 'media/images' }), 'invalid', from);
    symlinkSync(join(pub(), 'media', 'images'), join(pub(), 'recipes', 'media', 'images', 'shortcut'));
    assert.equal(await refusal({ op: 'media-copy', from: 'recipes/media/images/shortcut/hero.jpg', to: 'recipes/media/images' }), 'invalid', 'never through a shortcut');
    rmSync(join(pub(), 'recipes', 'media', 'images', 'shortcut'));
  });

  it('trash: restorable (to where it was, or a new name, or the top if its folder has gone), gone after 30 days', async () => {
    const t = await call({ op: 'media-trash', path: 'media/images/hero.jpg' });
    assert.ok(!existsSync(join(pub(), 'media', 'images', 'hero.jpg')));
    assert.equal(t.purgeAt, Math.floor(clock / 1000) + 30 * 86400);
    const bucket = await call({ op: 'media-trash', path: 'media/images/2026 trip' });
    for (const path of ['media/images', 'media', 'recipes/media/images/nope.jpg']) assert.notEqual(await refusal({ op: 'media-trash', path }), 'ok', path);
    const list = (await call({ op: 'media-trash-list' })).items;
    assert.deepEqual(list.map((i: { path: string; isDir: boolean }) => [i.path, i.isDir]).sort(), [['media/images/2026 trip', true], ['media/images/hero.jpg', false]]);
    assert.deepEqual(listTrash(cfg), [], "the folders trash doesn't show media");

    await upload('media/images', 'hero.jpg', 'a new hero');
    assert.equal(await refusal({ op: 'media-restore', id: t.id }), 'exists');
    assert.equal((await call({ op: 'media-restore', id: t.id, as: 'old hero.jpg' })).path, 'media/images/old hero.jpg');
    rmSync(join(pub(), 'media', 'images'), { recursive: true });
    mkdirSync(join(pub(), 'media', 'images'));
    await upload('media/images', 'x.jpg', 'x');
    rmSync(join(pub(), 'media', 'images', 'x.jpg'));
    const again = await call({ op: 'media-trash', path: 'recipes/media/images/2026 trip' }).catch(() => null);
    assert.equal(again, null, 'already moved away');
    await upload('recipes/media/audio', 'song.mp3', 'la la');
    await call({ op: 'media-mkdir', dir: 'recipes/media/audio', name: 'album' });
    await call({ op: 'media-move', from: 'recipes/media/audio/song.mp3', to: 'recipes/media/audio/album' });
    const song = await call({ op: 'media-trash', path: 'recipes/media/audio/album/song.mp3' });
    rmSync(join(pub(), 'recipes', 'media', 'audio', 'album'), { recursive: true });
    assert.equal((await call({ op: 'media-restore', id: song.id })).path, 'recipes/media/audio/song.mp3', 'its bucket is gone: back to the top of audio');

    clock += 29 * 86400 * 1000;
    await call({ op: 'purge' });
    assert.equal((await call({ op: 'media-trash-list' })).items.length, 1, 'still there after 29 days');
    clock += 2 * 86400 * 1000;
    const purged = await call({ op: 'purge' });
    assert.equal(purged.media, 1);
    assert.deepEqual((await call({ op: 'media-trash-list' })).items, []);
    assert.equal(await refusal({ op: 'media-restore', id: bucket.id }), 'not-found');
    assert.equal(await refusal({ op: 'media-restore', id: '../../etc' }), 'invalid');
  });

  it('photos/ becomes images/: renamed, merged without overwriting, and old trash comes back under images/', async () => {
    const put = (rel: string, body = rel) => { mkdirSync(join(pub(), rel, '..'), { recursive: true }); writeFileSync(join(pub(), rel), body); };
    // a media folder that only has photos/
    mkdirSync(join(pub(), 'shop', 'media', 'photos', 'sub'), { recursive: true });
    put('shop/media/photos/a.jpg'); put('shop/media/photos/sub/b.jpg');
    // one that has both: photos/ is emptied into images/, a taken name stays behind
    put('media/photos/new.jpg'); put('media/photos/clash.jpg', 'old'); put('media/images/clash.jpg', 'new');
    put('media/photos/trip/c.jpg'); put('media/images/trip/d.jpg');
    // something trashed from photos/ before the change (made by hand: the helper no longer takes photos/)
    const t = { id: '20260917T120000Z-0123abcd' };
    mkdirSync(join(cfg.trashDir, '.media', t.id), { recursive: true });
    renameSync(join(pub(), 'shop', 'media', 'photos', 'sub', 'b.jpg'), join(cfg.trashDir, '.media', t.id, 'b.jpg'));
    writeFileSync(join(cfg.trashDir, '.media', t.id, 'origin.json'), JSON.stringify({ path: 'shop/media/photos/sub/b.jpg', name: 'b.jpg', isDir: false, trashedAt: Math.floor(clock / 1000) }));
    const r = await call({ op: 'media-rename-photos' });
    assert.deepEqual(r, { renamed: ['shop/media'], merged: ['media'], left: ['media/photos/clash.jpg'] });
    assert.equal(readFileSync(join(pub(), 'shop', 'media', 'images', 'a.jpg'), 'utf8'), 'shop/media/photos/a.jpg');
    assert.ok(!existsSync(join(pub(), 'shop', 'media', 'photos')));
    assert.deepEqual(readdirSync(join(pub(), 'media', 'images', 'trip')).sort(), ['c.jpg', 'd.jpg'], 'folders in both are merged');
    assert.ok(existsSync(join(pub(), 'media', 'images', 'new.jpg')));
    assert.equal(readFileSync(join(pub(), 'media', 'images', 'clash.jpg'), 'utf8'), 'new', 'never overwritten');
    assert.deepEqual(readdirSync(join(pub(), 'media', 'photos')), ['clash.jpg'], 'what is left stays where it was');
    assert.deepEqual(await call({ op: 'media-rename-photos' }), { renamed: [], merged: ['media'], left: ['media/photos/clash.jpg'] }, 'running it again changes nothing');
    assert.equal((await call({ op: 'media-restore', id: t.id })).path, 'shop/media/images/sub/b.jpg');
    rmSync(join(pub(), 'media', 'photos'), { recursive: true });
    assert.deepEqual(await call({ op: 'media-rename-photos' }), { renamed: [], merged: [], left: [] });
  });

  it('scans every media folder for the panel\'s records (never content), flagging what is out of place, and hashes one file', async () => {
    const put = (rel: string, body = rel) => { mkdirSync(join(pub(), rel, '..'), { recursive: true }); writeFileSync(join(pub(), rel), body); };
    put('scan/media/images/a.jpg', 'aaaa');
    put('scan/media/images/deep/er/b.png', 'bb');
    put('scan/media/files/notes.pdf');
    put('scan/media/images/.pammy-upload-1-abc', 'half');               // an upload in progress: not a file yet
    put('scan/media/readme.txt');                                        // directly under media/
    put('scan/media/photos/old.jpg');                                    // not one of the four
    put('scan/media/images/oops.pdf');                                   // wrong kind: still a file, the panel flags it
    symlinkSync('/etc/passwd', join(pub(), 'scan', 'media', 'images', 'link.jpg'));
    put('scan/beef/media/images/x.jpg');                                 // nested website file: still a record
    put('scan/api.php', '<?php');                                        // a site's program file: listed (finding 1)
    put('scan/media/files/run.php', '<?php');                            // ...but never in a media folder
    const r = await call<{ files: { path: string; size: number; modifiedAt: number }[]; strays: string[]; truncated: boolean }>({ op: 'media-scan' });
    const mine = r.files.filter((f) => f.path.startsWith('scan/'));
    assert.deepEqual(mine.map((f) => [f.path, f.size]), [
      ['scan/api.php', 5], ['scan/beef/media/images/x.jpg', 'scan/beef/media/images/x.jpg'.length],
      ['scan/media/files/notes.pdf', 'scan/media/files/notes.pdf'.length], ['scan/media/images/a.jpg', 4],
      ['scan/media/images/deep/er/b.png', 2], ['scan/media/images/oops.pdf', 'scan/media/images/oops.pdf'.length],
      ['scan/media/photos/old.jpg', 'scan/media/photos/old.jpg'.length], ['scan/media/readme.txt', 'scan/media/readme.txt'.length]]);
    assert.equal(mine.find((f) => f.path === 'scan/media/images/a.jpg')!.modifiedAt, Math.floor(statSync(join(pub(), 'scan/media/images/a.jpg')).mtimeMs / 1000));
    assert.deepEqual(r.strays.filter((x) => x.startsWith('scan/')), ['scan/media/files/run.php', 'scan/media/images/link.jpg', 'scan/media/photos', 'scan/media/readme.txt']);
    // a program file isn't trashed from the panel (it couldn't come back); its folder can be
    assert.throws(() => filesTrash(cfg, 'scan/api.php'), (e: unknown) => e instanceof SiteFsError && /changed on the server/.test(e.message));
    assert.equal(r.truncated, false);
    assert.ok(r.files.every((f) => !('content' in f)));
    const capped = mediaScan(cfg, 2);
    assert.deepEqual([capped.files.length, capped.truncated], [2, true], 'capped, and says so');

    const h = await call({ op: 'media-hash', path: 'scan/media/images/a.jpg' });
    assert.deepEqual([h.path, h.size, h.hash], ['scan/media/images/a.jpg', 4, createHash('sha256').update('aaaa').digest('hex')]);
    assert.equal(await refusal({ op: 'media-hash', path: 'scan/media/images/link.jpg' }), 'invalid', 'never through a shortcut');
    assert.equal(await refusal({ op: 'media-hash', path: 'scan/index.html' }), 'invalid');
    assert.equal(await refusal({ op: 'media-hash', path: 'scan/media/images/gone.jpg' }), 'not-found');
    rmSync(join(pub(), 'scan'), { recursive: true });
  });
});

describe('the editor: saving text, new files, earlier versions (docs/editor-plan.md)', () => {
  let sock: string;
  let server: ReturnType<typeof createSiteFsServer>;
  const pub = () => cfg.publicDir;
  const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
  const write = <T = any>(req: Record<string, unknown>, text: string | Buffer) => {
    const b = Buffer.from(text);
    return uploadToSiteFs<T>(sock, { op: 'files-write', actor: 'pamela', ...req, size: b.length }, Readable.from([b]));
  };
  const refused = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as SiteFsCallError).code; } };
  const call = <T = any>(req: Record<string, unknown>) => callSiteFs<T>(sock, req);
  const versionText = async (id: string) => {
    const { header, bytes } = await readFromSiteFs<{ path: string }>(sock, { op: 'files-version-read', id });
    const chunks: Buffer[] = [];
    for await (const c of bytes) chunks.push(c as Buffer);
    return { header, text: Buffer.concat(chunks).toString('utf8') };
  };

  before(async () => {
    fresh();
    mkdirSync(join(pub(), 'olivia', 'media', 'files'), { recursive: true });
    mkdirSync(join(pub(), 'olivia', 'login-files'), { recursive: true });
    writeFileSync(join(pub(), 'olivia', 'login-files', 'style.css'), 'body{}');
    sock = join(root, 'edit.sock');
    server = createSiteFsServer(cfg);
    await new Promise<void>((r) => server.listen(sock, r));
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('saves over the file it opened, atomically, keeping its mode, and refuses when it changed meanwhile', async () => {
    writeFileSync(join(pub(), 'olivia', 'index.html'), '<p>one</p>');
    chmodSync(join(pub(), 'olivia', 'index.html'), 0o664);
    const r = await write({ path: 'olivia/index.html', expect: sha('<p>one</p>') }, '<p>two</p>');
    assert.equal(readFileSync(join(pub(), 'olivia', 'index.html'), 'utf8'), '<p>two</p>');
    assert.equal(statSync(join(pub(), 'olivia', 'index.html')).mode & 0o7777, 0o664, 'mode kept');
    assert.deepEqual([r.path, r.hash, r.created, r.unchanged], ['olivia/index.html', sha('<p>two</p>'), false, false]);
    assert.match(r.version, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    assert.deepEqual(readdirSync(join(pub(), 'olivia')).filter((n) => n.startsWith('.')), [], 'no temporary file left');

    writeFileSync(join(pub(), 'olivia', 'index.html'), '<p>winscp</p>');
    assert.equal(await refused(write({ path: 'olivia/index.html', expect: sha('<p>two</p>') }, '<p>three</p>')), 'conflict');
    assert.equal(readFileSync(join(pub(), 'olivia', 'index.html'), 'utf8'), '<p>winscp</p>', 'left alone');
    assert.equal(await refused(write({ path: 'olivia/index.html' }, 'x')), 'invalid', 'no expect: refused');
    const same = await write({ path: 'olivia/index.html', expect: sha('<p>winscp</p>') }, '<p>winscp</p>');
    assert.deepEqual([same.unchanged, same.version], [true, null], 'the same text: nothing written, no version');
  });

  it('keeps one version per quick run of saves from one open editor; a new one for anyone or anywhere else', async () => {
    clock += 3600_000;
    writeFileSync(join(pub(), 'olivia', 'about.html'), 'v0');
    const s1 = await write({ path: 'olivia/about.html', expect: sha('v0'), session: 'editor-one' }, 'v1');
    clock += 60_000;
    const s2 = await write({ path: 'olivia/about.html', expect: sha('v1'), session: 'editor-one' }, 'v2');
    assert.equal(s2.version, s1.version, 'a minute later, same editor: the same version (it still holds v0)');
    assert.deepEqual([s1.newVersion, s2.newVersion], [true, false]);
    clock += 60_000;
    const s3 = await write({ path: 'olivia/about.html', expect: sha('v2'), actor: 'momolig', session: 'editor-two' }, 'v3');
    assert.notEqual(s3.version, s1.version, 'someone else: a new version');
    writeFileSync(join(pub(), 'olivia', 'about.html'), 'winscp');
    clock += 60_000;
    const s4 = await write({ path: 'olivia/about.html', expect: sha('winscp'), actor: 'momolig', session: 'editor-two' }, 'v4');
    assert.notEqual(s4.version, s3.version, 'changed outside in between: its text is kept too');
    clock += 6 * 60_000;
    const s5 = await write({ path: 'olivia/about.html', expect: sha('v4'), actor: 'momolig', session: 'editor-two' }, 'v5');
    assert.notEqual(s5.version, s4.version, 'over 5 minutes later: a new version');
    const list = await call<{ versions: { id: string; hash: string; by: string }[]; keepDays: number }>({ op: 'files-versions', path: 'olivia/about.html' });
    assert.deepEqual(list.versions.map((v) => v.id), [s5.version, s4.version, s3.version, s1.version], 'newest first');
    assert.equal(list.keepDays, 30);
    assert.deepEqual((await versionText(s1.version)).text, 'v0');
    assert.deepEqual((await versionText(s3.version)).text, 'v2');
    assert.deepEqual((await versionText(s4.version)).text, 'winscp');
    assert.deepEqual((await versionText(s5.version)).header.path, 'olivia/about.html');
    assert.ok(!('after' in list.versions[0]!));

    const back = await call<{ path: string; hash: string; version: string; from: { id: string } }>({ op: 'files-version-restore', id: s1.version, expect: sha('v5'), actor: 'pamela' });
    assert.equal(readFileSync(join(pub(), 'olivia', 'about.html'), 'utf8'), 'v0', 'restored');
    assert.equal((await versionText(back.version)).text, 'v5', 'what was there is a version too');
    assert.equal(await refused(call({ op: 'files-version-restore', id: s1.version, expect: sha('v5') })), 'conflict');
    assert.equal(await refused(call({ op: 'files-version-read', id: '../../etc' })), 'invalid');
    assert.equal(await refused(call({ op: 'files-version-read', id: '20260101T000000Z-00000000' })), 'not-found');
  });

  it('a save from another window, or with no editor named, always keeps what it replaces', async () => {
    writeFileSync(join(pub(), 'olivia', 'window.html'), 'w0');
    const a = await write({ path: 'olivia/window.html', expect: sha('w0'), session: 'window-one' }, 'w1');
    clock += 60_000;
    const b = await write({ path: 'olivia/window.html', expect: sha('w1'), session: 'window-two' }, 'w2');
    assert.notEqual(b.version, a.version, 'the same person in another window');
    clock += 60_000;
    const c = await write({ path: 'olivia/window.html', expect: sha('w2') }, 'w3');
    const d = await write({ path: 'olivia/window.html', expect: sha('w3') }, 'w4');
    assert.notEqual(c.version, d.version, 'no editor named (a program)');
    assert.deepEqual(await Promise.all([a, b, c, d].map(async (x) => (await versionText(x.version)).text)), ['w0', 'w1', 'w2', 'w3']);
    assert.equal(await refused(write({ path: 'olivia/window.html', expect: sha('w4'), session: '../../x' }, 'w5')), 'ok', 'a strange session is ignored, not trusted');
  });

  it('keeps at most 50 versions per file, and purges them after 30 days', async () => {
    writeFileSync(join(pub(), 'olivia', 'many.txt'), 'n0');
    for (let n = 1; n <= 53; n++) {
      clock += 6 * 60_000;
      await write({ path: 'olivia/many.txt', expect: sha(`n${n - 1}`) }, `n${n}`);
    }
    const list = await call<{ versions: unknown[] }>({ op: 'files-versions', path: 'olivia/many.txt' });
    assert.equal(list.versions.length, 50);
    clock += 31 * 86400_000;
    const r = await call<{ versions: number }>({ op: 'purge' });
    assert.ok(r.versions >= 50);
    assert.equal((await call<{ versions: unknown[] }>({ op: 'files-versions', path: 'olivia/many.txt' })).versions.length, 0);
  });

  it('makes new files, never over an existing one, or under the next free name when asked', async () => {
    const r = await write({ path: 'olivia/new.html', create: 'exact' }, '<h1>new</h1>');
    assert.deepEqual([r.path, r.created], ['olivia/new.html', true]);
    assert.equal(statSync(join(pub(), 'olivia', 'new.html')).mode & 0o777, 0o644);
    assert.equal(await refused(write({ path: 'olivia/new.html', create: 'exact' }, 'other')), 'exists');
    assert.equal(readFileSync(join(pub(), 'olivia', 'new.html'), 'utf8'), '<h1>new</h1>', 'never overwritten');
    const c = await write({ path: 'olivia/new.html', create: 'free' }, 'mine');
    assert.equal(c.path, 'olivia/new-2.html');
    assert.equal(await refused(write({ path: 'olivia/nope/new.html', create: 'exact' }, 'x')), 'not-found');
    assert.deepEqual(readdirSync(join(pub(), 'olivia')).filter((n) => n.startsWith('.')), [], 'nothing left behind');
  });

  it('only writes text files the editor knows, never in login-files, media kinds or through shortcuts, and only UTF-8 up to 2 MB', async () => {
    assert.equal(await refused(write({ path: 'olivia/x.php', create: 'exact' }, '<?php')), 'invalid');
    assert.equal(await refused(write({ path: 'olivia/x.png', create: 'exact' }, 'png')), 'invalid');
    assert.equal(await refused(write({ path: 'olivia/media/files/x.html', create: 'exact' }, 'x')), 'invalid', 'media/files takes no pages');
    assert.equal((await write({ path: 'olivia/media/files/notes.txt', create: 'exact' }, 'ok')).path, 'olivia/media/files/notes.txt');
    assert.equal(await refused(write({ path: 'olivia/login-files/style.css', expect: sha('body{}') }, 'x')), 'invalid');
    assert.equal(await refused(write({ path: 'olivia/.hidden.txt', create: 'exact' }, 'x')), 'invalid');
    assert.equal(await refused(write({ path: '../x.txt', create: 'exact' }, 'x')), 'invalid');
    symlinkSync('/etc', join(pub(), 'olivia', 'etc'));
    assert.equal(await refused(write({ path: 'olivia/etc/x.txt', create: 'exact' }, 'x')), 'invalid');
    writeFileSync(join(root, 'outside.txt'), 'outside');
    symlinkSync(join(root, 'outside.txt'), join(pub(), 'olivia', 'link.txt'));
    assert.equal(await refused(write({ path: 'olivia/link.txt', expect: sha('outside') }, 'x')), 'invalid');
    assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'outside');
    assert.equal(await refused(write({ path: 'olivia/bin.txt', create: 'exact' }, Buffer.from([0xff, 0xfe, 0x00]))), 'invalid', 'not UTF-8');
    assert.equal(await refused(write({ path: 'olivia/big.txt', create: 'exact' }, 'x'.repeat(2 * 1024 * 1024 + 1))), 'invalid');
  });

  it('lets the preview read a sign-in page\'s login-files, and nothing else does', async () => {
    const read = async (req: Record<string, unknown>) => {
      const { bytes } = await readFromSiteFs(sock, { op: 'files-read', ...req });
      const chunks: Buffer[] = [];
      for await (const c of bytes) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    };
    assert.equal(await read({ path: 'olivia/login-files/style.css', view: true }), 'body{}');
    assert.equal(await refused(read({ path: 'olivia/login-files/style.css' })), 'invalid');
    assert.equal(await refused(call({ op: 'files-list', dir: 'olivia/login-files' })), 'invalid');
  });
});
