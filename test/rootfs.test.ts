// File Explorer's software roots (docs/catalog-plan.md step 3): the folder helper in its
// software mode, on a folder laid out like a WordPress wp-content/, through its socket as
// the panel asks it; and the software helper's drop-ins for pammy-rootfs@<id>. Runs as
// momolig; the live helper's user, sandbox and socket are checked by verify-panel.sh.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:net';
import { callSiteFs, readFromSiteFs, SiteFsCallError, uploadToSiteFs } from '@panel/files/sitefs/client';
import type { SiteFsConfig } from '@panel/files/sitefs/ops';
import { createSiteFsServer, SOFTWARE_OPS } from '@panel/files/sitefs/service';
import { dropIn, hasRoot, rootfs, ROOTFS_DROPINS, SCRIPT } from '@panel/apps/apps/rootfs';
import type { AppRecord } from '@panel/apps/apps/record';
import type { RunSpec } from '@panel/apps/apps/runner';

let dir: string;
let content: string;
let trash: string;
let sock: string;
let server: Server;
const clock = Date.UTC(2026, 8, 28, 12, 0, 0);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-rootfs-test-'));
  content = join(dir, 'wp-content');
  trash = join(dir, 'files-trash');
  sock = join(dir, 'rootfs.sock');
  const cfg: SiteFsConfig = {
    publicDir: content, trashDir: trash, placementFile: null, domain: 'pammy.org', siteName: 'pammy.org',
    folderSubdomains: false, maxUpload: 10 * 1024 * 1024, purgeDays: 30, kind: 'software', now: () => new Date(clock),
  };
  server = createSiteFsServer(cfg);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(content, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
  mkdirSync(join(content, 'themes', 'rose'), { recursive: true });
  mkdirSync(join(content, 'plugins', 'hello'), { recursive: true });
  mkdirSync(join(content, 'uploads', '2026'), { recursive: true });
  mkdirSync(join(content, 'login-files'), { recursive: true });
  mkdirSync(trash, { recursive: true });
  writeFileSync(join(content, 'themes', 'rose', 'style.css'), 'body { color: red }\n');
  writeFileSync(join(content, 'themes', 'rose', 'functions.php'), '<?php // rose\n');
  writeFileSync(join(content, 'plugins', 'hello', 'hello.php'), '<?php // hello\n');
  writeFileSync(join(content, 'plugins', 'hello', 'readme.txt'), 'Hello\n');
  writeFileSync(join(content, 'uploads', '2026', 'cat.jpg'), 'jpeg');
  writeFileSync(join(content, '.htaccess'), 'Deny from all\n');
  writeFileSync(join(content, 'index.php'), '<?php // Silence is golden.\n');
});

const ask = <T = Record<string, unknown>>(req: Record<string, unknown>) => callSiteFs<T>(sock, { actor: 'test', ...req });
const refusal = async (req: Record<string, unknown>) => {
  try { await ask(req); return 'ok'; } catch (e) { if (e instanceof SiteFsCallError) return `${e.code}: ${e.message}`; throw e; }
};
const put = (path: string, text: string, code = false, expect: string | null = null) => {
  const buf = Buffer.from(text);
  return uploadToSiteFs<{ path: string; version: string | null }>(sock, { op: 'files-write', path, create: expect === null ? 'exact' : false, expect, size: buf.length, actor: 'test', ...(code ? { code: true } : {}) }, Readable.from([buf]));
};
const upload = (dirPath: string, name: string, text: string, code = false) => {
  const buf = Buffer.from(text);
  return uploadToSiteFs<{ path: string; name: string }>(sock, { op: 'files-upload', dir: dirPath, name, size: buf.length, actor: 'test', ...(code ? { code: true } : {}) }, Readable.from([buf]));
};
const hashOf = async (path: string) => (await ask<{ hash: string }>({ op: 'files-hash', path })).hash;

describe('the helper on a software root', () => {
  it('does File Explorer and the editor, nothing that is only the website\'s', async () => {
    for (const op of ['list', 'create', 'trash', 'restore', 'dirs', 'markers', 'protect', 'unprotect', 'install-pages', 'media-sites', 'media-create',
      'media-list', 'media-buckets', 'media-info', 'media-mkdir', 'media-copy', 'media-move', 'media-trash', 'media-restore', 'media-rename-photos', 'media-scan',
      'home-page-get', 'home-page-save', 'home-page-remove']) {
      assert.equal(await refusal({ op, name: 'x', path: 'x', folder: 'x' }), 'invalid: That is only for the website.', op);
    }
    for (const op of SOFTWARE_OPS) assert.ok(!op.startsWith('media-') || op === 'media-trash-list', op);
  });

  it('lists wp-content as it is: login-files is an ordinary folder here, names starting with a dot are never shown', async () => {
    const top = await ask<{ buckets: { name: string }[]; files: { name: string }[] }>({ op: 'files-list', dir: '' });
    assert.deepEqual(top.buckets.map((b) => b.name), ['login-files', 'plugins', 'themes', 'uploads']);
    assert.deepEqual(top.files.map((f) => f.name), ['index.php']);
    const tree = await ask<{ dirs: string[] }>({ op: 'files-tree' });
    assert.ok(tree.dirs.includes('login-files') && tree.dirs.includes('themes/rose') && tree.dirs.includes('uploads/2026'));
    assert.match(await refusal({ op: 'files-stat', path: '.htaccess' }), /^invalid/);
    assert.match(await refusal({ op: 'files-stat', path: '../wp-config.php' }), /^invalid/);
  });

  it('never follows a shortcut out of wp-content', async () => {
    writeFileSync(join(dir, 'wp-config.php'), '<?php define("DB_PASSWORD", "secret");');
    symlinkSync(join(dir, 'wp-config.php'), join(content, 'config-link.php'));
    assert.match(await refusal({ op: 'files-stat', path: 'config-link.php' }), /shortcut/);
    await assert.rejects(readFromSiteFs(sock, { op: 'files-read', path: 'config-link.php', actor: 'test' }), /shortcut/);
  });

  it('uploads group-writable files; .php only for a panel admin; a dotted name never keeps its dot', async () => {
    const css = await upload('themes/rose', 'extra.css', 'p {}');
    assert.equal(statSync(join(content, css.path)).mode & 0o777, 0o664 & ~process.umask());
    await assert.rejects(upload('themes/rose', 'evil.php', '<?php system($_GET[1]);'), /Only panel admins can put or change \.php files here/);
    assert.equal(existsSync(join(content, 'themes', 'rose', 'evil.php')), false);
    const php = await upload('themes/rose', 'page-about.php', '<?php // about', true);
    assert.equal(php.path, 'themes/rose/page-about.php');
    for (const name of ['x.phtml', 'x.phar', 'x.PHP5']) await assert.rejects(upload('themes/rose', name, 'x'), /Only panel admins/, name);
    for (const name of ['x.cgi', 'x.sh', 'x.pl']) await assert.rejects(upload('themes/rose', name, 'x', true), /can't be put here/, name);
    const dotted = await upload('', '.htaccess', 'Allow from all');
    assert.equal(dotted.name.startsWith('.'), false);
    assert.equal(readFileSync(join(content, '.htaccess'), 'utf8'), 'Deny from all\n');
  });

  it('new folders are group-writable, and keep the setgid group of the folder they are in', async () => {
    chmodSync(join(content, 'themes'), 0o2775);
    const r = await ask<{ path: string }>({ op: 'files-mkdir', dir: 'themes', name: 'lily' });
    assert.equal(statSync(join(content, r.path)).mode & 0o2777, 0o2000 | (0o775 & ~process.umask()));
  });

  it('code is moved, renamed and trashed only by a panel admin, and so is a folder holding any', async () => {
    const noCode = /Only panel admins can move, rename or trash code/;
    assert.match(await refusal({ op: 'files-move', from: 'themes/rose/functions.php', to: 'themes/rose', name: 'off.php' }), noCode);
    assert.match(await refusal({ op: 'files-move', from: 'plugins/hello', to: 'themes' }), noCode);
    assert.match(await refusal({ op: 'files-trash', path: 'plugins/hello' }), noCode);
    assert.match(await refusal({ op: 'files-trash', path: 'index.php' }), noCode);
    assert.match(await refusal({ op: 'files-copy', from: 'plugins/hello/hello.php', to: 'plugins/hello', name: 'hello-2.php' }), /Only panel admins can put/);
    // what holds no code is anyone's
    assert.equal(await refusal({ op: 'files-move', from: 'plugins/hello/readme.txt', to: 'plugins/hello', name: 'README.txt' }), 'ok');
    const t = await ask<{ id: string }>({ op: 'files-trash', path: 'uploads/2026' });
    assert.equal(existsSync(join(content, 'uploads', '2026')), false);
    assert.ok(readdirSync(trash).length > 0);
    assert.equal((await ask<{ path: string }>({ op: 'files-restore', id: t.id })).path, 'uploads/2026');
    // and an admin may
    const p = await ask<{ id: string; path: string }>({ op: 'files-trash', path: 'plugins/hello', code: true });
    assert.equal(p.path, 'plugins/hello');
    assert.match(await refusal({ op: 'files-restore', id: p.id }), noCode);
    assert.equal((await ask<{ path: string }>({ op: 'files-restore', id: p.id, code: true })).path, 'plugins/hello');
    assert.equal((await ask<{ path: string }>({ op: 'files-move', from: 'themes/rose/functions.php', to: 'themes/rose', name: 'functions-old.php', code: true })).path, 'themes/rose/functions-old.php');
  });

  it('the trash lists what went in, and the top of wp-content never goes', async () => {
    await ask({ op: 'files-trash', path: 'uploads/2026/cat.jpg' });
    const l = await ask<{ items: { path: string; name: string }[] }>({ op: 'media-trash-list' });
    assert.deepEqual(l.items.map((x) => x.path), ['uploads/2026/cat.jpg']);
    assert.match(await refusal({ op: 'files-trash', path: '' }), /top of these files/);
  });

  it('the editor saves text for anyone and .php only for a panel admin, keeping versions in its own trash folder', async () => {
    const css = 'themes/rose/style.css';
    const s1 = await put(css, 'body { color: blue }\n', false, await hashOf(css));
    assert.ok(s1.version);
    assert.ok(existsSync(join(trash, '.versions')));
    const php = 'themes/rose/functions.php';
    await assert.rejects(put(php, '<?php // changed\n', false, await hashOf(php)), /Only panel admins can put or change \.php files here/);
    assert.equal(readFileSync(join(content, php), 'utf8'), '<?php // rose\n');
    await put(php, '<?php // changed\n', true, await hashOf(php));
    assert.equal(readFileSync(join(content, php), 'utf8'), '<?php // changed\n');
    await assert.rejects(put('themes/rose/new.php', '<?php'), /Only panel admins/);
    await put('themes/rose/new.php', '<?php // new', true);
    const v = await ask<{ versions: { id: string }[] }>({ op: 'files-versions', path: php });
    assert.equal(v.versions.length, 1);
    // putting an earlier .php back is a change to code too
    await assert.rejects(uploadToSiteFs(sock, { op: 'files-version-restore', id: v.versions[0]!.id, expect: await hashOf(php), actor: 'test', size: 0 }, Readable.from([])), /Only panel admins/);
    const back = await uploadToSiteFs<{ path: string }>(sock, { op: 'files-version-restore', id: v.versions[0]!.id, expect: await hashOf(php), actor: 'test', code: true, size: 0 }, Readable.from([]));
    assert.equal(back.path, php);
    assert.equal(readFileSync(join(content, php), 'utf8'), '<?php // rose\n');
    assert.equal(lstatSync(join(content, php)).isFile(), true);
  });
});

describe('the software helper: pammy-rootfs@<id> for each install', () => {
  const rec = (id: string, over: Partial<AppRecord> = {}): AppRecord => ({
    id, kind: 'wordpress', layout: 'standard', user: `svc-app-${id}`, units: { web: `app-${id}-web`, db: `app-${id}-db` }, port: 3050,
    files: `/srv/pamela-apps/${id}`, filesLink: `/pamela/apps/${id}`, config: `/var/lib/svc-app-${id}/config`, backups: `/var/lib/svc-app-${id}/backups`,
    dbVolume: '', placementFile: `/etc/nginx/pammy-wordpress/placement-${id}`, installedAt: 1, adoptedAt: null, loginFile: null,
    offline: null, setup: null, deleted: null, ...over,
  } as AppRecord);

  it('a drop-in runs it as the install\'s own user on its wp-content, with its secrets out of reach', () => {
    const d = dropIn(rec('garden'));
    assert.match(d, /^User=svc-app-garden$/m);
    assert.match(d, /^Group=svc-app-garden$/m);
    assert.match(d, /^Environment=SITEFS_PUBLIC=\/srv\/pamela-apps\/garden\/wp-content$/m);
    assert.match(d, /^Environment=SITEFS_TRASH=\/var\/lib\/svc-app-garden\/files-trash$/m);
    assert.match(d, /^InaccessiblePaths=.*-\/var\/lib\/svc-app-garden\/config .*-\/srv\/pamela-apps\/garden\/wp-config\.php$/m);
    assert.doesNotMatch(d, /User=root|User=pamela/);
  });

  it('its script has nothing systemd-run would expand (${...}), and keeps a drop-in it just wrote', async () => {
    assert.doesNotMatch(SCRIPT, /\$\{/);
    // run as systemd would hand it over: sh, in a folder standing in for /etc/systemd/system
    const etc = mkdtempSync(join(tmpdir(), 'rootfs-etc-'));
    const bin = mkdtempSync(join(tmpdir(), 'rootfs-bin-'));
    try {
      writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'install'), '#!/bin/sh\nfor a; do last=$a; done; mkdir -p "$last"\n', { mode: 0o755 });
      const script = SCRIPT.replaceAll(ROOTFS_DROPINS, etc);
      const { execFileSync } = await import('node:child_process');
      const run = () => execFileSync('sh', ['-euc', script, 'rootfs-sync', 'blog', 'svc-pammywp', join(etc, 'home'), 'text'], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
      mkdirSync(join(etc, 'pammy-rootfs@gone.service.d'));
      assert.equal(run(), 'removed gone\nroot blog\n');
      assert.equal(readFileSync(join(etc, 'pammy-rootfs@blog.service.d', 'root.conf'), 'utf8'), 'text\n');
      assert.equal(existsSync(join(etc, 'pammy-rootfs@gone.service.d')), false);
      assert.equal(run(), 'root blog\n');
      assert.ok(existsSync(join(etc, 'pammy-rootfs@blog.service.d', 'root.conf')));
    } finally { rmSync(etc, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
  });

  it('only installed, not deleted, software has one; the sync is asked of root with each one', async () => {
    assert.equal(hasRoot(rec('a')), true);
    assert.equal(hasRoot(rec('b', { setup: { state: 'installing', step: 'x', message: null } })), false);
    assert.equal(hasRoot(rec('c', { deleted: { at: 1, by: 'x' } })), false);
    const calls: RunSpec[] = [];
    const r = rootfs(async (spec) => { calls.push(spec); return { code: 0, stdout: 'removed old\nroot a\n', stderr: '' }; });
    const got = await r.sync([rec('a'), rec('b', { setup: { state: 'failed', step: 'x', message: null } }), rec('c', { deleted: { at: 1, by: 'x' } })]);
    assert.deepEqual(got, { roots: ['a'], removed: ['old'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.as, 'root');
    const argv = calls[0]!.argv;
    assert.deepEqual(argv.slice(4), ['a', 'svc-app-a', '/var/lib/svc-app-a', dropIn(rec('a')).trimEnd()]);
    const failing = rootfs(async () => ({ code: 1, stdout: '', stderr: 'Unit pammy-rootfs@.socket not found.' }));
    await assert.rejects(failing.sync([rec('a')]), /could not be set up: Unit pammy-rootfs@\.socket not found/);
  });
});
