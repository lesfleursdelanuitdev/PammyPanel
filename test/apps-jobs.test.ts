// The software helper's changes (docs/apps-plan.md phase 2): backups, putting
// one back, offline and online, a new admin password, its complaints, a
// download -- over a real socket, against a folder laid out like the server
// (test/apps-world.ts), with a runner that stands in for systemd-run: it records
// every command and plays its part (a backup makes backup files, stopping a
// container empties its cgroup). What systemd, podman and nginx really do with
// those commands is verify-apps.sh's to check, on the server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { adoptWordPress } from '@panel/apps/apps/adopt';
import { AppsCallError, callApps } from '@panel/apps/apps/client';
import type { Host } from '@panel/apps/apps/host';
import type { Job } from '@panel/apps/apps/jobs';
import { renderAll, renderPlacement } from '@panel/apps/apps/nginx';
import { createOps, parsePlacement, type Status, type Summary } from '@panel/apps/apps/ops';
import { AppsError, checkRecord, readState, standardRecord } from '@panel/apps/apps/record';
import { purgePaths } from '@panel/apps/apps/remove';
import { runArgs, type RunResult, type RunSpec } from '@panel/apps/apps/runner';
import { createAppsServer } from '@panel/apps/apps/service';
import { callJsonLineRead } from '@panel/core/jsonline';
import { WP_UID, wordpressServer } from './apps-world.ts';

const TEMPLATES = new URL('../../wordpress/nginx/templates/', import.meta.url).pathname;
const NGX = '/etc/nginx/pammy-wordpress';
const BK = '/var/lib/svc-pammywp/backups';

let dir: string;
let root: string;
let state: string;
let sock: string;
let clock = 1_790_500_000;       // 2026-09-27: after the backups the fake server starts with
let world: ReturnType<typeof wordpressServer>;
let server: ReturnType<typeof createAppsServer>;

// what the runner was asked, and how the world answers
let ran: RunSpec[] = [];
let execd: string[][] = [];
let nginxRefuses = false;
let reloads = 0;
let masked = new Set<string>();
let timerOn = true;
let hold: Promise<void> | null = null;       // a backup that doesn't finish until the test says so
let wpUpdateFails = false;
let mailFails = false;
let srFails = false;
let installFails: 'user' | 'pull' | 'folders' | 'rewrite' | null = null;
// the WordPress sites set up, by their files folder, and their users
let wpSites = new Map<string, Set<string>>();
const running = new Map<string, boolean>();

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): RunResult => ({ code: 1, stdout, stderr });
const stampOf = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const setRunning = (unit: string, up: boolean) => { running.set(unit, up); world.container(unit, up); };

async function runner(spec: RunSpec): Promise<RunResult> {
  ran.push(spec);
  const [cmd, ...args] = spec.argv;
  const line = spec.argv.join(' ');
  if (cmd === 'nginx') return nginxRefuses ? fail('nginx: [emerg] unexpected "}" in /etc/nginx/pammy-wordpress/main.conf:3') : ok();
  if (line === 'systemctl reload nginx') { reloads++; return ok(); }
  if (cmd === 'systemctl' && args[0] === '--user') {
    const [verb, ...units] = args.slice(1);
    const home = spec.as === 'root' ? '' : spec.as.home;
    const uid = spec.as === 'root' ? 0 : spec.as.uid;
    if (verb === 'start' && units[0]!.endsWith('-backup.service')) {
      if (hold) await hold;
      const db = units[0]!.replace('-backup.service', '-db');
      if (!running.get(db)) return fail(`Job for ${units[0]} failed`);
      clock += 60;
      const s = stampOf(clock);
      world.put(`${home}/backups/db-${s}.sql.gz`, 'd'.repeat(2 * 1024 * 1024));
      world.put(`${home}/backups/files-${s}.tar.gz`, 'f'.repeat(3 * 1024 * 1024));
      world.put(`${home}/backups/url-${s}.txt`, 'https://blog.pammy.org\n');
      return ok();
    }
    if (verb === 'start' && units[0]!.startsWith('app-') && units[0]!.endsWith('-web.service')) {
      const id = units[0]!.slice(4, -'-web.service'.length);
      running.set(`app-${id}-web`, true); running.set(`app-${id}-db`, true);
      world.container(`app-${id}-web`, true, 40_000_000, uid); world.container(`app-${id}-db`, true, 90_000_000, uid);
      // the image's first start copies WordPress in
      world.put(`/srv/pamela-apps/${id}/wp-includes/version.php`, "<?php\n$wp_version = '6.8.2';\n");
      return ok();
    }
    if (verb === 'daemon-reload') return ok();
    if (verb === 'enable' && units.includes('podman-auto-update.timer')) return ok();
    if (verb === 'start') {
      if (units.some((u) => masked.has(u))) return fail(`Failed to start ${units[0]}: Unit ${units[0]} is masked.`);
      // the web container pulls in its database (Requires=)
      for (const u of units) { setRunning(u.replace('.service', ''), true); if (u === 'pammywp-web.service') setRunning('pammywp-db', true); }
      return ok();
    }
    if (verb === 'stop') { for (const u of units) setRunning(u.replace('.service', ''), false); return ok(); }
    if (verb === 'restart') { for (const u of units) setRunning(u.replace('.service', ''), true); return ok(); }
    if (verb === 'mask') { for (const u of units) masked.add(u); return ok(); }
    if (verb === 'unmask') { for (const u of units) masked.delete(u); return ok(); }
    if (verb === 'disable' && units.includes('pammywp-backup.timer')) { timerOn = false; return ok(); }
    if (verb === 'enable' && units.includes('pammywp-backup.timer')) { timerOn = true; return ok(); }
    return fail(`unexpected systemctl --user ${verb}`);
  }
  if (cmd === 'podman' && args[0] === 'healthcheck') return running.get(args[2]!) ? ok() : fail('unhealthy');
  if (cmd === 'podman' && args[0] === 'run') {
    const wp = args.slice(args.indexOf('wp') + 1);
    const files = args[args.indexOf('-v') + 1]!.split(':')[0]!;
    const site = wpSites.get(files);
    const opt = (k: string) => wp.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3);
    if (wp[0] === 'core' && wp[1] === 'is-installed') return site ? ok() : fail('');
    if (wp[0] === 'core' && wp[1] === 'install') { wpSites.set(files, new Set([opt('admin_user')!])); return ok(`${spec.stdin}\nSuccess: WordPress installed successfully.`); }
    if (wp[0] === 'user' && wp[1] === 'get') return site?.has(wp[2]!) ? ok('1') : fail(`Error: Invalid user ID, email or login: '${wp[2]}'`);
    if (wp[0] === 'user' && wp[1] === 'create') { site?.add(wp[2]!); return ok(`${spec.stdin}\nSuccess: Created user 2.`); }
    if (wp[0] === 'rewrite' && wp[1] === 'structure') return installFails === 'rewrite' ? fail('Error: rewrite') : ok();
    if (wp[0] === 'search-replace') return srFails && wp[1]!.includes('(?!') ? fail('Error: regex') : ok('Success: Made 3 replacements.');
    if (wp[0] === 'rewrite') return ok();
    if (wp[0] === 'eval') return mailFails ? ok('failed: SMTP Error: Could not authenticate.\nnot sent\n') : ok('sent\n');
    if (wp[0] === 'user' && wp[1] === 'list') return ok('[{"user_login":"pamela"},{"user_login":"olivia.admin"}]');
    if (wp[0] === 'user' && wp[1] === 'update') {
      // wp-cli repeats what it was given on stdin
      const echo = `wp user update '${wp[2]}' --skip-email --user_pass='${spec.stdin?.trim()}'`;
      return wpUpdateFails ? fail('Error: something', echo) : ok(`${echo}\nSuccess: Updated user 1.`);
    }
    return fail(`unexpected wp ${wp.join(' ')}`);
  }
  if (cmd === 'sh' && spec.argv[3] === 'restore-files') return ok();
  if (cmd === 'sh' && spec.argv[3] === 'restore-db') return ok();
  if (cmd === 'sh' && spec.argv[3] === 'login-file') return ok();
  // an install (4b): what each of its root and user steps leaves behind
  if (cmd === 'sh' && spec.argv[3] === 'app-user') {
    const [u, h] = spec.argv.slice(4);
    if (installFails === 'user') return fail('useradd: failure');
    if (readFileSync(join(root, 'etc/passwd'), 'utf8').includes(`\n${u}:`)) return ok();
    world.put('/etc/passwd', `${readFileSync(join(root, 'etc/passwd'), 'utf8')}${u}:x:990:990::${h}:/usr/sbin/nologin\n`);
    return ok();
  }
  if (cmd === 'sh' && spec.argv[3] === 'config') { world.put(spec.argv[4]!, spec.stdin ?? ''); return ok(); }
  if (cmd === 'sh' && ['app-unit', 'app-backup-script', 'app-mu-plugins'].includes(spec.argv[3]!)) { world.put(spec.argv[4]!, spec.stdin ?? ''); return ok(); }
  if (cmd === 'sh' && spec.argv[3] === 'app-pull') return installFails === 'pull' ? fail('Error: initializing source docker://...: pinging registry: timeout') : ok();
  if (cmd === 'sh' && spec.argv[3] === 'app-folders' && installFails === 'folders') return fail('install: cannot create directory');
  if (cmd === 'sh' && ['app-folders', 'app-link', 'app-secrets', 'app-modes', 'app-login-file'].includes(spec.argv[3]!)) return ok();
  if (cmd === 'sh' && spec.argv[3] === 'mail-plugin') { world.put(spec.argv[4]!, spec.stdin ?? ''); return ok(); }
  // delete (4c): her link, podman's reset, and root's removal of the rest
  if (cmd === 'sh' && spec.argv[3] === 'app-unlink') return ok();
  if (cmd === 'sh' && spec.argv[3] === 'app-reset') { for (const u of spec.argv.slice(4)) setRunning(u.replace(/\.(service|timer)$/, ''), false); return ok(); }
  if (cmd === 'sh' && spec.argv[3] === 'app-purge') {
    const [u, home, files] = spec.argv.slice(4);
    world.put('/etc/passwd', readFileSync(join(root, 'etc/passwd'), 'utf8').split('\n').filter((l) => !l.startsWith(`${u}:`)).join('\n'));
    rmSync(join(root, home!), { recursive: true, force: true });
    rmSync(join(root, files!), { recursive: true, force: true });
    return ok();
  }
  if (line === 'systemctl try-restart pammy-mail.service') return ok();
  return fail(`unexpected: ${line}`);
}

const host = (): Host => ({
  root, domain: 'pammy.org', nginx: { host: '127.0.0.1', port: 443 },
  // the site answers while its web server runs
  probe: async () => ({ status: running.get('pammywp-web') ? 200 : null, ms: 5, error: running.get('pammywp-web') ? null : 'ECONNREFUSED' }),
  now: () => clock,
  // the pamela site enabled (beforeEach); pammy.org on its hosts takes it out (8-7d)
  wholeSite: '/etc/nginx/sites-enabled/pamela',
});

const ask = <T>(req: Record<string, unknown>) => callApps<T>(sock, req);
const status = () => ask<Status>({ op: 'status', id: 'blog' });
// a job runs on after the request answers: wait for it to end, and say how
async function finished(): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const s = await status();
    if (!s.job) return s.recent[0]!;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the job never ended');
}
const said = () => ran.map((r) => `${r.as === 'root' ? 'root' : r.as.user}: ${r.argv.join(' ').replace(/podman run .* wp /, 'wp ')}`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-apps-jobs-'));
  root = join(dir, 'root');
  world = wordpressServer(root);
  state = join(dir, 'state');
  sock = join(dir, 'apps.sock');
  server = createAppsServer(createOps(host(), state, {
    run: runner,
    exec: async (argv) => {
      execd.push(argv);
      if (argv[0] === 'gzip') return readFileSync(argv[2]!, 'utf8').startsWith('damaged') ? fail('gzip: unexpected end of file') : ok();
      if (argv[0] === 'journalctl') return ok(`2026-09-23T09:00:00+00:00 host ${argv.at(-3)!.slice(15)}[1]: AH00112: Warning\n2026-09-23T09:01:00+00:00 host x[1]: PHP Fatal error:  oops\n`);
      return fail('unexpected');
    },
    execStream: (argv) => { execd.push(argv); return Readable.from([Buffer.from(`TAR OF ${argv.slice(-3).join(' ')}`)]); },
    templates: TEMPLATES,
    wpConfig: new URL('../../wordpress/config/', import.meta.url).pathname,
    sleep: async () => {},
  }));
  await new Promise<void>((r) => server.listen(sock, r));
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  world.lay();
  world.put('/etc/nginx/sites-enabled/pamela', '# the pamela site\n');
  // nginx as place-wordpress.sh left it
  const live = renderPlacement(TEMPLATES, parsePlacement('subdomain blog')!);
  for (const [f, text] of Object.entries(live)) world.put(`${NGX}/${f}`, text);
  rmSync(state, { recursive: true, force: true });
  await adoptWordPress({ root, domain: 'pammy.org' }, state, clock);
  ran = []; execd = []; nginxRefuses = false; reloads = 0; masked = new Set(); timerOn = true; hold = null; wpUpdateFails = false; mailFails = false; srFails = false; installFails = null; wpSites = new Map([['/srv/pamela-wordpress', new Set(['pamela'])]]);
  running.set('pammywp-web', true); running.set('pammywp-db', true);
  clock += 3600;
});

describe('backups', () => {
  it('lists the whole ones, newest first, with the address their links use', async () => {
    const r = await ask<{ backups: { stamp: string; bytes: number; address: string | null }[] }>({ op: 'backups', id: 'blog' });
    assert.deepEqual(r.backups.map((b) => [b.stamp, b.bytes, b.address]), [
      ['20260922T034501Z', 420, null],
      ['20260921T033012Z', 400, 'https://blog.pammy.org'],
    ]);
  });

  it('"Back up now" is a job: it answers at once, runs the nightly backup unit as WordPress\'s user, and is remembered', async () => {
    const { job } = await ask<{ job: Job }>({ op: 'backup', id: 'blog', actor: 'pamela' });
    assert.equal(job.op, 'backup');
    assert.equal(job.ok, null);
    const end = await finished();
    assert.deepEqual([end.ok, end.message, end.by], [true, 'Backed up (5 MB).', 'pamela']);
    assert.deepEqual(said(), ['svc-pammywp: systemctl --user start pammywp-backup.service']);
    assert.deepEqual(ran[0]!.as, { user: 'svc-pammywp', uid: WP_UID, home: '/var/lib/svc-pammywp' });
    assert.equal((await status()).backups.count, 3);
    assert.equal(statSync(join(state, 'history.json')).mode & 0o777, 0o600);
  });

  it('one thing at a time', async () => {
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    await ask({ op: 'backup', id: 'blog', actor: 'pamela' });
    assert.equal((await status()).job?.step, 'Copying its files and database');
    for (const req of [{ op: 'backup' }, { op: 'offline' }, { op: 'restore', stamp: '20260921T033012Z' }, { op: 'reset-admin', user: 'pamela' }]) {
      await assert.rejects(ask({ ...req, id: 'blog', actor: 'pamela' }), (e: AppsCallError) => e.code === 'busy' && /Wait until that has finished/.test(e.message), req.op);
    }
    release();
    assert.equal((await finished()).ok, true);
  });

  it('a backup that fails says so, and the history keeps it', async () => {
    running.set('pammywp-db', false);
    await ask({ op: 'backup', id: 'blog', actor: 'pamela' });
    const end = await finished();
    assert.equal(end.ok, false);
    assert.match(end.message!, /^The backup did not finish\. \(Job for pammywp-backup\.service failed\)$/);
  });

  it('downloads one as a single .tar, and nothing that is not a backup', async () => {
    const { header, bytes } = await callJsonLineRead<{ name: string }>(sock, { op: 'download', id: 'blog', stamp: '20260921T033012Z' }, 'software helper');
    assert.equal(header.name, 'wordpress-blog-backup-2026-09-21-0330.tar');
    let got = '';
    for await (const c of bytes) got += c;
    assert.equal(got, 'TAR OF db-20260921T033012Z.sql.gz files-20260921T033012Z.tar.gz url-20260921T033012Z.txt');
    assert.deepEqual(execd.at(-1)!.slice(0, 5), ['tar', '-C', `${root}${BK}`, '-cf', '-']);
    for (const stamp of ['20260923T031500Z', '../../etc', '20260921T033012Z/../x', 42]) {
      await assert.rejects(callJsonLineRead(sock, { op: 'download', id: 'blog', stamp }, 'software helper'), (e: Error & { code: string }) => e.code === 'not-found', String(stamp));
    }
  });
});

describe('putting a backup back (P2b: the whole backup)', () => {
  it('checks it, backs up now, puts the files back as root and the database as WordPress\'s user, and waits for it to answer', async () => {
    const { job } = await ask<{ job: Job }>({ op: 'restore', id: 'blog', stamp: '20260921T033012Z', actor: 'pamela' });
    assert.equal(job.op, 'restore');
    const end = await finished();
    assert.equal(end.ok, true, end.message ?? '');
    assert.match(end.message!, /^Put back as it was on 2026-09-21 03:30 \(UTC\)\./);
    assert.deepEqual(execd.map((a) => [a[0], a[2]!.slice(root.length)]), [['gzip', `${BK}/db-20260921T033012Z.sql.gz`], ['gzip', `${BK}/files-20260921T033012Z.tar.gz`]]);
    const steps = said();
    assert.equal(steps[0], 'svc-pammywp: systemctl --user start pammywp-backup.service', 'a backup of now, first');
    assert.equal(steps[1], 'svc-pammywp: systemctl --user stop pammywp-web.service');
    const files = ran[2]!;
    assert.equal(files.as, 'root');
    assert.deepEqual(files.argv.slice(3), ['restore-files', '/srv/pamela-wordpress', `/srv/pamela-wordpress.pre-restore-${stampOf(clock)}`, `${BK}/files-20260921T033012Z.tar.gz`]);
    assert.match(files.argv[2]!, /mv "\$dir" "\$aside"\ntar -xpzf "\$tarball"/);
    assert.equal(steps[3], 'svc-pammywp: systemctl --user start pammywp-web.service');
    const db = ran.find((r) => r.argv[3] === 'restore-db')!;
    assert.deepEqual([db.as !== 'root' && db.as.user, ...db.argv.slice(4)], ['svc-pammywp', `${BK}/db-20260921T033012Z.sql.gz`, 'pammywp-db']);
  });

  it('only a backup that is there, by its own name', async () => {
    for (const stamp of ['20260923T031500Z', '20990101T000000Z', '../x', 'db-20260921T033012Z.sql.gz', null]) {
      await assert.rejects(ask({ op: 'restore', id: 'blog', stamp, actor: 'pamela' }), (e: AppsCallError) => e.code === 'not-found', String(stamp));
    }
    assert.deepEqual(ran, []);
  });

  it('a damaged backup changes nothing', async () => {
    world.put(`${BK}/files-20260921T033012Z.tar.gz`, 'damaged');
    await ask({ op: 'restore', id: 'blog', stamp: '20260921T033012Z', actor: 'pamela' });
    const end = await finished();
    assert.equal(end.ok, false);
    assert.match(end.message!, /^The backup is damaged \(its files part\), so nothing was changed\./);
    assert.deepEqual(ran, []);
  });

  it('a backup from another address is left to momolig (its links would point there)', async () => {
    world.put(`${BK}/url-20260921T033012Z.txt`, 'https://pammy.org/blog\n');
    await ask({ op: 'restore', id: 'blog', stamp: '20260921T033012Z', actor: 'pamela' });
    const end = await finished();
    assert.equal(end.ok, false);
    assert.equal(end.message, 'That backup was made when it was at https://pammy.org/blog, and its links point there. Ask momolig to put it back.');
    assert.deepEqual(ran, []);
  });
});

describe('offline and online again (A4)', () => {
  const nginxFiles = () => Object.fromEntries(['main.conf', 'server.conf', 'placement'].map((f) => [f, readFileSync(join(root, NGX, f), 'utf8')]));

  it('offline: off its address (as place-wordpress.sh off writes it), stopped, kept stopped, nightly backup off', async () => {
    await ask({ op: 'offline', id: 'blog', actor: 'pamela' });
    const end = await finished();
    assert.deepEqual([end.ok, end.message], [true, 'It is offline. Nothing was deleted.']);
    assert.deepEqual(nginxFiles(), renderPlacement(TEMPLATES, { mode: 'off', name: null }));
    assert.deepEqual(said(), [
      'root: nginx -t -q', 'root: systemctl reload nginx',
      'svc-pammywp: systemctl --user disable --now pammywp-backup.timer',
      'svc-pammywp: systemctl --user stop pammywp-web.service pammywp-db.service',
      'svc-pammywp: systemctl --user mask pammywp-web.service pammywp-db.service',
    ]);
    assert.deepEqual(readState(state).apps[0]!.offline, { from: 'subdomain blog', at: clock });
    const s = await status();
    assert.deepEqual([s.state, s.problems, s.answering, s.offline], ['offline', [], null, { at: clock }]);
    await assert.rejects(ask({ op: 'offline', id: 'blog', actor: 'pamela' }), (e: AppsCallError) => e.code === 'conflict');
    await ask({ op: 'backup', id: 'blog', actor: 'pamela' });
    assert.equal((await finished()).message, 'It is offline, so there is nothing new to back up. Its backups from before are kept.');
  });

  it('online: unlocked, started, ready, nightly backup back on, and back on the address it had', async () => {
    await ask({ op: 'offline', id: 'blog', actor: 'pamela' });
    await finished();
    ran = [];
    await ask({ op: 'online', id: 'blog', actor: 'olivia' });
    const end = await finished();
    assert.deepEqual([end.ok, end.message, end.by], [true, 'It is back at https://blog.pammy.org/.', 'olivia']);
    assert.deepEqual(nginxFiles(), renderPlacement(TEMPLATES, { mode: 'subdomain', name: 'blog' }), 'byte for byte as before it went offline');
    assert.deepEqual(said(), [
      'svc-pammywp: systemctl --user unmask pammywp-web.service pammywp-db.service',
      'svc-pammywp: systemctl --user start pammywp-web.service',
      'svc-pammywp: podman healthcheck run pammywp-db',
      'svc-pammywp: systemctl --user enable --now pammywp-backup.timer',
      'root: nginx -t -q', 'root: systemctl reload nginx',
    ]);
    assert.equal(readState(state).apps[0]!.offline, null);
    assert.deepEqual([(await status()).state, timerOn, masked.size], ['running', true, 0]);
    assert.deepEqual((await status()).recent.map((j) => [j.op, j.ok]), [['online', true], ['offline', true]]);
  });

  it('if nginx says no, its three files are put back and nothing else happens', async () => {
    const before = nginxFiles();
    nginxRefuses = true;
    await ask({ op: 'offline', id: 'blog', actor: 'pamela' });
    const end = await finished();
    assert.equal(end.ok, false);
    assert.match(end.message!, /^nginx did not accept the change, so everything was put back as it was\./);
    assert.deepEqual(nginxFiles(), before);
    assert.equal(reloads, 0);
    assert.equal(readState(state).apps[0]!.offline, null);
    assert.deepEqual([running.get('pammywp-web'), timerOn], [true, true], 'still running, nightly backup still on');
  });

  it('comes back to a path or to nothing just as well', async () => {
    world.placement('path blog');
    await ask({ op: 'offline', id: 'blog', actor: 'pamela' });
    await finished();
    await ask({ op: 'online', id: 'blog', actor: 'pamela' });
    assert.equal((await finished()).message, 'It is back at https://pammy.org/blog/.');
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'path blog\n');
  });
});

describe('a new admin password (P2c)', () => {
  it('lists its administrators as WordPress says', async () => {
    assert.deepEqual(await ask({ op: 'admins', id: 'blog' }), { admins: ['pamela', 'olivia.admin'] });
  });

  it('never puts the password on a command line; writes her login file as her; the history never sees it', async () => {
    const r = await ask<{ user: string; password: string; savedTo: string }>({ op: 'reset-admin', id: 'blog', user: 'pamela', actor: 'pamela' });
    assert.equal(r.user, 'pamela');
    assert.match(r.password, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(r.savedTo, '/home/pamela/wordpress-login.txt');
    const update = ran.find((x) => x.argv.includes('update'))!;
    assert.deepEqual(update.argv.slice(-6), ['wp', 'user', 'update', 'pamela', '--prompt=user_pass', '--skip-email']);
    assert.equal(update.stdin, `${r.password}\n`);
    for (const x of ran) assert.ok(!x.argv.join(' ').includes(r.password), 'never an argument');
    const file = ran.find((x) => x.argv[3] === 'login-file')!;
    assert.deepEqual([file.as !== 'root' && file.as.user, file.argv.at(-1)], ['pamela', '/home/pamela/wordpress-login.txt']);
    assert.match(file.stdin!, new RegExp(`Log in at:  https://blog\\.pammy\\.org/wp-admin/\\nUsername:   pamela\\nPassword:   ${r.password}\\n`));
    const note = (await status()).recent[0]!;
    assert.deepEqual([note.op, note.ok, note.message], ['admin-password', true, 'A new password for pamela, also in your wordpress-login.txt.']);
    assert.ok(!readFileSync(join(state, 'history.json'), 'utf8').includes(r.password));
  });

  it('only for one of its administrators', async () => {
    for (const user of ['mallory', 'pamela; rm -rf /', '--role=administrator', '', null]) {
      await assert.rejects(ask({ op: 'reset-admin', id: 'blog', user, actor: 'pamela' }), (e: AppsCallError) => e.code === 'not-found', String(user));
    }
    assert.ok(!ran.some((x) => x.argv.includes('update')));
  });

  it('a failure never repeats what wp-cli echoed', async () => {
    wpUpdateFails = true;
    await assert.rejects(ask({ op: 'reset-admin', id: 'blog', user: 'pamela', actor: 'pamela' }),
      (e: AppsCallError) => e.message === 'WordPress did not take the new password. The old one still works.' && !e.message.includes('user_pass'));
  });

  it('writes no login file for software that keeps none', async () => {
    const s = JSON.parse(readFileSync(join(state, 'apps.json'), 'utf8'));
    s.apps[0].loginFile = null;
    writeFileSync(join(state, 'apps.json'), JSON.stringify(s));
    const r = await ask<{ savedTo: string | null }>({ op: 'reset-admin', id: 'blog', user: 'olivia.admin', actor: 'pamela' });
    assert.equal(r.savedTo, null);
    assert.ok(!ran.some((x) => x.argv[3] === 'login-file'));
  });
});

describe('its complaints', () => {
  it('reads the last warnings and errors of each container from the journal, as WordPress\'s user wrote them', async () => {
    const r = await ask<{ web: string[]; db: string[] }>({ op: 'logs', id: 'blog' });
    assert.equal(r.web.length, 2);
    assert.match(r.web[1]!, /PHP Fatal error/);
    assert.deepEqual(execd[0], ['journalctl', '--no-pager', '-q', '-o', 'short-iso', '-n', '40', `_UID=${WP_UID}`, 'CONTAINER_NAME=pammywp-web', '-p', 'warning']);
    assert.deepEqual(execd[1]!.at(-3), 'CONTAINER_NAME=pammywp-db');
  });
});

describe('the record, from phase 1', () => {
  it('a record written before phase 2 reads as online, with the WordPress login file', async () => {
    const s = JSON.parse(readFileSync(join(state, 'apps.json'), 'utf8'));
    delete s.apps[0].loginFile;
    delete s.apps[0].offline;
    writeFileSync(join(state, 'apps.json'), JSON.stringify(s));
    const a = readState(state).apps[0]!;
    assert.deepEqual([a.loginFile, a.offline], ['/home/pamela/wordpress-login.txt', null]);
  });
});

describe('mail settings (phase 3)', () => {
  const KEY = 're_PammyOnlyKey_0123456789abcd';
  const SET = { from: 'noreply@mail.lesfleursdelanuit.com', replyTo: 'hello@pammy.org', notifyTo: 'hello@pammy.org' };
  const file = (p: string) => readFileSync(join(root, p), 'utf8');
  const mode = (p: string) => statSync(join(root, p)).mode & 0o777;

  it('nothing set up to start with', async () => {
    assert.deepEqual(await ask({ op: 'mail-get' }), { keySet: false, keyEnds: null, settings: null, wordpress: [{ id: 'blog', configured: false, plugin: false }] });
  });

  it('saves the key (root 600) and the settings, gives WordPress its copy and its plugin, and restarts the mail service', async () => {
    const v = await ask<{ keySet: boolean; keyEnds: string; wordpress: unknown[] }>({ op: 'mail-set', key: ` ${KEY} `, ...SET, actor: 'pamela' });
    assert.deepEqual([v.keySet, v.keyEnds, v.wordpress], [true, 'abcd', [{ id: 'blog', configured: true, plugin: true }]]);
    assert.equal(file('/etc/pammy-mail/resend.key'), `${KEY}\n`);
    assert.equal(mode('/etc/pammy-mail/resend.key'), 0o600);
    assert.deepEqual(JSON.parse(file('/etc/pammy-mail/settings.json')), SET);
    assert.equal(mode('/etc/pammy-mail/settings.json'), 0o644);
    assert.deepEqual(JSON.parse(file('/var/lib/svc-pammywp/config/mail.json')),
      { host: 'smtp.resend.com', port: 587, user: 'resend', pass: KEY, from: SET.from, replyTo: SET.replyTo });
    assert.match(file('/srv/pamela-wordpress/wp-content/mu-plugins/pammy-mail.php'), /Plugin Name: pammy mail/);
    const plugin = ran.find((r) => r.argv[3] === 'mail-plugin')!;
    assert.equal(plugin.as !== 'root' && plugin.as.user, 'svc-pammywp', 'as WordPress\'s own user');
    assert.ok(said().includes('root: systemctl try-restart pammy-mail.service'));
    for (const r of ran) assert.ok(!r.argv.join(' ').includes(KEY), 'the key is never on a command line');
  });

  it('keeps the key when none is given, and refuses what is not an address or a key', async () => {
    await ask({ op: 'mail-set', key: KEY, ...SET });
    await ask({ op: 'mail-set', ...SET, notifyTo: 'site-owner@example.org' });
    assert.equal(file('/etc/pammy-mail/resend.key'), `${KEY}\n`);
    assert.equal(JSON.parse(file('/etc/pammy-mail/settings.json')).notifyTo, 'site-owner@example.org');
    for (const bad of [{ key: 'sk_live_nope' }, { from: 'noreply' }, { replyTo: 'a@b.c\nBcc: x@y.z' }, { notifyTo: 'Hello <hello@pammy.org>' }, { notifyTo: '"; system("x"); "@pammy.org' }]) {
      await assert.rejects(ask({ op: 'mail-set', ...SET, ...bad }), (e: AppsCallError) => e.code === 'invalid', JSON.stringify(bad));
    }
    assert.equal(JSON.parse(file('/etc/pammy-mail/settings.json')).notifyTo, 'site-owner@example.org', 'unchanged by the refusals');
  });

  it('refuses to start without any key at all', async () => {
    await assert.rejects(ask({ op: 'mail-set', ...SET }), (e: AppsCallError) => e.code === 'invalid' && /Paste the Resend API key/.test(e.message));
  });

  it('a test through WordPress: wp_mail to the notice address, and its reason when it fails', async () => {
    await assert.rejects(ask({ op: 'mail-test', id: 'blog' }), (e: AppsCallError) => e.message === 'Set up mail first.');
    await ask({ op: 'mail-set', key: KEY, ...SET });
    ran = [];
    assert.deepEqual(await ask({ op: 'mail-test', id: 'blog', actor: 'pamela' }), { sent: true, to: 'hello@pammy.org' });
    const ev = ran.find((r) => r.argv.includes('eval'))!;
    assert.match(ev.argv.at(-1)!, /wp_mail\("hello@pammy\.org", "pammy\.org: a test from WordPress"/);
    assert.equal((await status()).recent[0]!.message, 'A test email went to hello@pammy.org.');
    mailFails = true;
    await assert.rejects(ask({ op: 'mail-test', id: 'blog' }), (e: AppsCallError) => e.message === 'WordPress could not send it: SMTP Error: Could not authenticate.');
  });
});

describe('moving it to another address (4a)', () => {
  const cfg = (f: string) => readFileSync(join(root, '/var/lib/svc-pammywp/config', f), 'utf8');
  const ngx = (f: string) => readFileSync(join(root, NGX, f), 'utf8');
  const bashRender = (mode: string, name: string, url: string) => {
    const out = join(dir, `bash-${mode}-${name}`);
    execFileSync('bash', ['-c', 'source "$1/lib.sh"; render_placement "$2" "$3" "$4" "$5"', '_', new URL('../../wordpress/', import.meta.url).pathname, mode, name, out, url]);
    return (f: string) => readFileSync(join(out, f), 'utf8');
  };

  it('backs up, stages nginx, gives WordPress its new address, rewrites its links, then switches nginx over', async () => {
    const { job } = await ask<{ job: Job }>({ op: 'move', id: 'blog', to: { mode: 'path', name: 'blog' }, actor: 'pamela' });
    assert.equal(job.op, 'move');
    const end = await finished();
    assert.deepEqual([end.ok, end.message], [true, 'It is now at https://pammy.org/blog/.']);
    const steps = said().map((x) => x.replace(/^svc-pammywp: wp /, 'wp '));
    const common = '--skip-columns=guid --all-tables-with-prefix --report-changed-only';
    assert.deepEqual(steps, [
      'svc-pammywp: systemctl --user start pammywp-backup.service',
      'root: nginx -t -q',
      'svc-pammywp: systemctl --user restart pammywp-web.service',
      'svc-pammywp: podman healthcheck run pammywp-db',
      'wp core is-installed',
      `wp search-replace https://blog.pammy.org/ https://pammy.org/blog/ ${common}`,
      `wp search-replace https://blog\\.pammy\\.org(?![A-Za-z0-9._-]) https://pammy.org/blog --regex --regex-delimiter=# ${common}`,
      `wp search-replace https:\\/\\/blog.pammy.org\\/ https:\\/\\/pammy.org\\/blog\\/ ${common}`,
      'wp rewrite flush --hard',
      'root: systemctl reload nginx',
    ], 'nginx reloads only once WordPress has its new address');
    // as place-wordpress.sh would have written them
    const bash = bashRender('path', 'blog', 'https://pammy.org/blog');
    for (const f of ['wp.php', 'apache.conf']) assert.equal(cfg(f), bash(f), f);
    for (const f of ['main.conf', 'server.conf', 'placement']) assert.equal(ngx(f), bash(f), f);
    assert.equal(cfg('content-url'), 'https://pammy.org/blog\n');
    assert.equal((await status()).address, 'https://pammy.org/blog/');
  });

  it('if WordPress refuses, nginx and its settings are put back and nginx never reloads', async () => {
    const before = { main: ngx('main.conf'), server: ngx('server.conf'), placement: ngx('placement'), wp: cfg('wp.php'), apache: cfg('apache.conf'), url: cfg('content-url') };
    srFails = true;
    await ask({ op: 'move', id: 'blog', to: { mode: 'root' }, actor: 'pamela' });
    const end = await finished();
    assert.equal(end.ok, false);
    assert.match(end.message!, /^It couldn't be moved, so nginx and its settings were put back as they were\. The links in its posts could not all be changed\..*put back the backup just taken\.$/);
    assert.deepEqual({ main: ngx('main.conf'), server: ngx('server.conf'), placement: ngx('placement'), wp: cfg('wp.php'), apache: cfg('apache.conf'), url: cfg('content-url') }, before);
    assert.equal(reloads, 0);
    assert.ok(said().includes('svc-pammywp: systemctl --user restart pammywp-web.service'));
  });

  it('refuses what makes no sense, before anything happens', async () => {
    for (const [to, code, words] of [
      [{ mode: 'subdomain', name: 'blog' }, 'conflict', 'It is already there.'],
      [{ mode: 'subdomain', name: 'www' }, 'invalid', '"www" is kept for the server itself. Pick another name.'],
      [{ mode: 'path', name: 'Blog Posts' }, 'invalid', null],
      [{ mode: 'off' }, 'invalid', null],
      [{ mode: 'sideways', name: 'x' }, 'invalid', null],
      [null, 'invalid', null],
    ] as const) {
      const r = await ask({ op: 'move', id: 'blog', to, actor: 'pamela' }).then(async () => finished(), (e: AppsCallError) => e);
      if (r instanceof Error) { assert.equal((r as AppsCallError).code, code, JSON.stringify(to)); if (words) assert.equal(r.message, words); }
      else { assert.equal(r.ok, false); assert.equal(r.message, words); }
    }
    assert.ok(!said().some((x) => x.includes('backup')), 'nothing backed up, nothing touched');
  });

  it('the whole site is refused once pammy.org is on its hosts (the pamela site out of sites-enabled), and the list says so', async () => {
    assert.equal((await ask<{ wholeSite: boolean }>({ op: 'list' })).wholeSite, true);
    rmSync(join(root, 'etc/nginx/sites-enabled/pamela'));
    assert.equal((await ask<{ wholeSite: boolean }>({ op: 'list' })).wholeSite, false);
    const e = await ask({ op: 'move', id: 'blog', to: { mode: 'root' }, actor: 'pamela' }).then(() => null, (x: AppsCallError) => x);
    assert.equal(e?.code, 'invalid');
    assert.equal(e?.message, "pammy.org is served from its hosts now, so software can't be the whole of it. Choose a subdomain or a folder of pammy.org.");
    const i = await ask({ op: 'install', id: 'shop', placement: { mode: 'root' }, title: 'Shop', adminUser: 'pamela', adminEmail: 'hello@pammy.org', actor: 'pamela' }).then(() => null, (x: AppsCallError) => x);
    assert.equal(i?.code, 'invalid');
    assert.deepEqual(ran, [], 'nothing backed up, nothing touched');
    // a subdomain or a folder still moves
    await ask({ op: 'move', id: 'blog', to: { mode: 'path', name: 'blog' }, actor: 'pamela' });
    assert.equal((await finished()).message, 'It is now at https://pammy.org/blog/.');
  });

  it('moving away from the whole site warns about links to her other pages', async () => {
    world.placement('root');
    world.put('/var/lib/svc-pammywp/config/content-url', 'https://pammy.org\n');
    await ask({ op: 'move', id: 'blog', to: { mode: 'subdomain', name: 'journal' }, actor: 'pamela' });
    const end = await finished();
    assert.equal(end.message, 'It is now at https://journal.pammy.org/. Links in its posts to your other pages on pammy.org were changed too: look over them.');
  });
});

describe('installing a new WordPress (4b)', () => {
  const REQ = { op: 'install', id: 'journal', placement: { mode: 'subdomain', name: 'journal' }, title: "Olivia's journal", adminUser: 'pamela', adminEmail: 'hello@pammy.org', actor: 'pamela' };
  const finishedFor = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const s = await ask<Status>({ op: 'status', id });
      // status reads the record before it looks for a job: once the job is
      // gone, ask again for the record as the job left it
      if (!s.job) return ask<Status>({ op: 'status', id });
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the install never ended');
  };

  it('makes its user, folders, units and WordPress, puts it at its address, backs it up -- in that order', async () => {
    const r = await ask<{ job: Job; id: string }>(REQ);
    assert.deepEqual([r.id, r.job.op], ['journal', 'install']);
    const s = await finishedFor('journal');
    assert.equal(s.recent[0]!.ok, true, s.recent[0]!.message ?? '');
    assert.equal(s.recent[0]!.message, 'It is installed at https://journal.pammy.org/.');
    assert.deepEqual([s.state, s.setup, s.address, s.version, s.filesPath], ['running', null, 'https://journal.pammy.org/', '6.8.2', '/pamela/apps/journal']);
    const steps = ran.map((x) => (x.argv[0] === 'sh' ? `${x.as === 'root' ? 'root' : x.as.user}: ${x.argv[3]}` : `${x.as === 'root' ? 'root' : x.as.user}: ${x.argv.join(' ').replace(/podman run .* wp /, 'wp ')}`));
    const order = ['root: app-user', 'root: app-folders', 'root: config', 'root: app-backup-script', 'pamela: app-link', 'svc-app-journal: app-secrets', 'svc-app-journal: app-unit', 'svc-app-journal: app-pull',
      'svc-app-journal: systemctl --user daemon-reload', 'svc-app-journal: systemctl --user start app-journal-web.service', 'root: app-modes', 'svc-app-journal: app-mu-plugins',
      'svc-app-journal: systemctl --user enable --now podman-auto-update.timer app-journal-backup.timer', 'pamela: app-login-file', 'root: nginx -t -q', 'root: systemctl reload nginx', 'svc-app-journal: systemctl --user start app-journal-backup.service'];
    let at = -1;
    for (const o of order) { const i = steps.indexOf(o, at + 1); assert.ok(i > at, `${o} after ${order[order.indexOf(o) - 1]}\n${steps.join('\n')}`); at = i; }
    // its own names everywhere (record.ts standardRecord)
    const rec = readState(state).apps.find((a) => a.id === 'journal')!;
    assert.deepEqual([rec.user, rec.units, rec.port, rec.files, rec.config, rec.placementFile, rec.loginFile],
      ['svc-app-journal', { web: 'app-journal-web', db: 'app-journal-db' }, 3100, '/srv/pamela-apps/journal', '/var/lib/svc-app-journal/config', '/etc/nginx/pammy-wordpress/placement-journal', '/home/pamela/apps/journal-login.txt']);
    // its settings and units
    assert.match(readFileSync(join(root, rec.config, 'wp.php'), 'utf8'), /define\('WP_HOME', 'https:\/\/journal\.pammy\.org'\);/);
    assert.equal(readFileSync(join(root, rec.config, 'content-url'), 'utf8'), 'https://journal.pammy.org\n');
    const web = readFileSync(join(root, '/var/lib/svc-app-journal/.config/containers/systemd/app-journal-web.container'), 'utf8');
    assert.match(web, /^PublishPort=127\.0\.0\.1:3100:80$/m);
    assert.match(web, /^Volume=\/srv\/pamela-apps\/journal:\/var\/www\/html$/m);
    assert.match(web, /^MemoryMax=512M$/m);
    // nginx: both installs, each with its own proxy
    // both server blocks, each with its own proxy file; their order is by install time, and the
    // adopted blog's comes from a real folder's birth time while the test's clock is fixed, so
    // the order isn't checked here (nginx picks by exact server_name, whatever the order)
    const blocks = readFileSync(join(root, NGX, 'server.conf'), 'utf8').split(/\n(?=# \/etc\/nginx\/pammy-wordpress\/server\.conf)/);
    assert.equal(blocks.length, 2);
    assert.ok(blocks.some((b) => /server_name journal\.pammy\.org;[\s\S]*proxy-journal\.conf/.test(b)), 'journal block');
    assert.ok(blocks.some((b) => /server_name blog\.pammy\.org;[\s\S]*proxy\.conf/.test(b) && !b.includes('proxy-journal')), 'blog block');
    assert.match(readFileSync(join(root, NGX, 'proxy-journal.conf'), 'utf8'), /^proxy_pass http:\/\/127\.0\.0\.1:3100;$/m);
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'subdomain blog\n', 'the blog stays where it is');
    // the password: on stdin only, in her login file, and once for the page
    const install = ran.find((x) => x.argv.includes('install') && x.argv.includes('core'))!;
    assert.ok(install.argv.includes('--prompt=admin_password') && install.argv.includes("--title=Olivia's journal") && install.argv.includes('--admin_user=pamela'));
    const login = await ask<{ user: string; password: string }>({ op: 'install-login', id: 'journal' });
    assert.equal(install.stdin, `${login.password}\n`);
    for (const x of ran) assert.ok(!x.argv.join(' ').includes(login.password), 'never an argument');
    assert.match(ran.find((x) => x.argv[3] === 'app-login-file')!.stdin!, new RegExp(`Password:   ${login.password}`));
    assert.equal(await ask({ op: 'install-login', id: 'journal' }), null, 'only once');
    assert.ok(!readFileSync(join(state, 'history.json'), 'utf8').includes(login.password));
  });

  it('checks first: its name, its address, room on the server, a free port', async () => {
    for (const [req, code, words] of [
      [{ id: 'blog' }, 'exists', 'There is already software called "blog".'],
      [{ placement: { mode: 'subdomain', name: 'blog' } }, 'conflict', 'blog.pammy.org is already used by other software.'],
      [{ placement: { mode: 'subdomain', name: 'www' } }, 'invalid', '"www" is kept for the server itself. Pick another name.'],
      [{ id: 'Journal' }, 'invalid', null], [{ id: 'a'.repeat(21) }, 'invalid', null],
      [{ title: '' }, 'invalid', 'Give it a title (at most 80 characters).'],
      [{ adminUser: 'Root!' }, 'invalid', null], [{ adminEmail: 'nope' }, 'invalid', null],
      [{ placement: { mode: 'sideways' } }, 'invalid', null],
    ] as const) {
      await assert.rejects(ask({ ...REQ, ...req }), (e: AppsCallError) => e.code === code && (!words || e.message === words), JSON.stringify(req));
    }
    world.put('/proc/meminfo', 'MemTotal: 8000000 kB\nMemAvailable: 500000 kB\n');
    await assert.rejects(ask(REQ), (e: AppsCallError) => /short of free memory/.test(e.message));
    assert.deepEqual(ran, [], 'nothing made');
    assert.deepEqual(readState(state).apps.map((a) => a.id), ['blog']);
  });

  it('skips a port something is already listening on', async () => {
    // 3100 (0x0C1C) in LISTEN
    world.put('/proc/net/tcp', '  sl  local_address rem_address   st\n   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000\n');
    await ask(REQ);
    await finishedFor('journal');
    assert.equal(readState(state).apps.find((a) => a.id === 'journal')!.port, 3101);
  });

  it('a step that fails: it stops there, says where and why, and keeps what it made for Delete', async () => {
    installFails = 'pull';
    await ask(REQ);
    const s = await finishedFor('journal');
    assert.equal(s.state, 'failed');
    assert.deepEqual(s.setup, { state: 'failed', step: 'Downloading WordPress (a few minutes)', message: 'WordPress could not be downloaded. (Error: initializing source docker://...: pinging registry: timeout)' });
    assert.deepEqual(s.problems, ['Installing it stopped at "Downloading WordPress (a few minutes)": WordPress could not be downloaded. (Error: initializing source docker://...: pinging registry: timeout)']);
    assert.equal(s.answering, null);
    assert.equal(await ask({ op: 'install-login', id: 'journal' }), null);
    assert.ok(!ran.some((x) => x.argv.includes('nginx')), 'never put at an address');
  });

  it('an install that didn\'t finish can be tried again under its name, and picks up where it stopped', async () => {
    installFails = 'user';
    await ask(REQ);
    assert.deepEqual([(await finishedFor('journal')).setup!.step], ['Making its own user']);
    installFails = 'folders';
    await ask(REQ);
    assert.deepEqual([(await finishedFor('journal')).setup!.step], ['Making its folders and settings']);
    const first = readState(state).apps.find((a) => a.id === 'journal')!;
    installFails = null;
    ran = [];
    await ask(REQ);
    const s = await finishedFor('journal');
    assert.equal(s.recent[0]!.ok, true, s.recent[0]!.message ?? '');
    assert.equal(s.state, 'running');
    const rec = readState(state).apps.find((a) => a.id === 'journal')!;
    assert.deepEqual([rec.port, rec.installedAt], [first.port, first.installedAt], 'the same install, not a new one');
    assert.deepEqual(readState(state).apps.map((a) => a.id), ['blog', 'journal']);
    assert.equal(readFileSync(join(root, 'etc/passwd'), 'utf8').split('\nsvc-app-journal:').length, 2, 'its user once');
    assert.ok(ran.some((x) => x.argv.includes('install') && x.argv.includes('core')));
  });

  it('tried again after WordPress was set up: no second install, a new password for her admin', async () => {
    installFails = 'rewrite';
    await ask(REQ);
    assert.equal((await finishedFor('journal')).setup!.step, 'Setting up WordPress');
    await ask({ op: 'install-login', id: 'journal' });
    installFails = null;
    ran = [];
    await ask({ ...REQ, adminUser: 'olivia' });
    const s = await finishedFor('journal');
    assert.equal(s.recent[0]!.ok, true, s.recent[0]!.message ?? '');
    assert.ok(!ran.some((x) => x.argv.includes('install') && x.argv.includes('core')), 'WordPress is not installed twice');
    const made = ran.find((x) => x.argv.includes('user') && x.argv.includes('create'))!;
    assert.ok(made.argv.includes('olivia') && made.argv.includes('--prompt=user_pass'));
    const login = await ask<{ user: string; password: string }>({ op: 'install-login', id: 'journal' });
    assert.deepEqual([login.user, made.stdin], ['olivia', `${login.password}\n`]);
    assert.ok(!readFileSync(join(state, 'history.json'), 'utf8').includes(login.password));
  });

  it('a finished install is not installed again', async () => {
    await ask({ ...REQ, placement: { mode: 'off' } });
    await finishedFor('journal');
    await assert.rejects(ask({ ...REQ, placement: { mode: 'off' } }), (e: AppsCallError) => e.code === 'exists');
  });

  it('runs its steps with the sbin folders in PATH (useradd, usermod, nginx)', () => {
    const args = runArgs({ as: 'root', argv: ['sh', '-euc', 'useradd x'], what: 'app-user', timeoutSec: 60 }, 'u');
    const path = args[args.indexOf('--') - 1]!;
    assert.match(path, /^PATH=/);
    for (const d of ['/usr/sbin', '/usr/bin', '/sbin']) assert.ok(path.slice(5).split(':').includes(d), d);
  });
});

describe('deleting (4c): to the deleted software for 30 days, restore, and for good', () => {
  const blogJob = async () => finished();
  const days = (n: number) => n * 86400;

  it('delete: a last backup, offline as A4, her link gone, kept 30 days', async () => {
    const r = await ask<{ job: Job }>({ op: 'delete', id: 'blog', actor: 'pamela' });
    assert.equal(r.job.op, 'delete');
    const j = await blogJob();
    assert.equal(j.ok, true, j.message ?? '');
    const at = readState(state).apps[0]!.deleted!.at;
    assert.equal(j.message, `Deleted. It is kept until ${new Date((at + days(30)) * 1000).toISOString().slice(0, 10)}, and "Restore" brings it back until then.`);
    const order = ['svc-pammywp: systemctl --user start pammywp-backup.service', 'root: nginx -t -q', 'svc-pammywp: systemctl --user disable --now pammywp-backup.timer',
      'svc-pammywp: systemctl --user stop pammywp-web.service pammywp-db.service', 'svc-pammywp: systemctl --user mask pammywp-web.service pammywp-db.service'];
    let i = -1;
    for (const o of order) { const k = said().indexOf(o, i + 1); assert.ok(k > i, `${o}\n${said().join('\n')}`); i = k; }
    const unlink = ran.find((x) => x.argv[3] === 'app-unlink')!;
    assert.deepEqual([unlink.as !== 'root' && unlink.as.user, unlink.argv.slice(4)], ['pamela', ['/pamela/wordpress']]);
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'off\n');
    const rec = readState(state).apps[0]!;
    assert.deepEqual([rec.deleted!.by, rec.offline!.from], ['pamela', 'subdomain blog']);
    // nothing of it removed: its files, backups and user are all still there
    assert.ok(!ran.some((x) => ['app-reset', 'app-purge'].includes(x.argv[3]!)));
    const s = await status();
    assert.deepEqual([s.state, s.problems, s.deleted!.until], ['deleted', [], at + days(30)]);
    assert.equal((await ask<{ apps: Summary[] }>({ op: 'list' })).apps[0]!.deleted!.at, at);
    // its backups can still be downloaded, and nothing else is done to it
    assert.ok((await ask<{ backups: unknown[] }>({ op: 'backups', id: 'blog' })).backups.length > 0);
    await assert.rejects(ask({ op: 'online', id: 'blog' }), (e: AppsCallError) => e.message === 'It is deleted. Restore it first.');
    await assert.rejects(ask({ op: 'delete', id: 'blog' }), (e: AppsCallError) => e.message === 'It is deleted already.');
    await assert.rejects(ask({ op: 'move', id: 'blog', to: { mode: 'path', name: 'x' } }), (e: AppsCallError) => e.code === 'conflict');
  });

  it('delete when it is offline already: no backup, no second offline', async () => {
    await ask({ op: 'offline', id: 'blog' }); await blogJob();
    ran = [];
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' });
    assert.equal((await blogJob()).ok, true);
    // then File Explorer's helpers follow (catalog step 3): the deleted blog's goes
    assert.deepEqual(said().map((x) => x.split('\n')[0]), ['pamela: sh -euc if [ -L "$1" ]; then rm -f "$1"; fi app-unlink /pamela/wordpress', 'root: sh -euc changed=; want=" "']);
    assert.ok(ran.at(-1)!.argv.at(-1) === 'rootfs-sync', 'no install left with a root');
  });

  it('the last backup fails: nothing is deleted, and it says how to go on', async () => {
    const orig = running.get('pammywp-db');
    setRunning('pammywp-db', false);
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' });
    const j = await blogJob();
    setRunning('pammywp-db', orig ?? true);
    assert.equal(j.ok, false);
    assert.match(j.message!, /^The last backup didn't work, so nothing was deleted\. To delete it without one, take it offline first\./);
    assert.deepEqual([readState(state).apps[0]!.deleted, readState(state).apps[0]!.offline], [null, null]);
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'subdomain blog\n');
  });

  it('restore: her link back, and it comes back offline; online puts it at its address', async () => {
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' }); await blogJob();
    ran = [];
    await ask({ op: 'undelete', id: 'blog', actor: 'pamela' });
    const j = await blogJob();
    assert.equal(j.message, 'It is back, offline. "Bring it back online" puts it at https://blog.pammy.org/ again.');
    const link = ran.find((x) => x.argv[3] === 'app-link')!;
    assert.deepEqual([link.as !== 'root' && link.as.user, link.argv.slice(4)], ['pamela', ['/srv/pamela-wordpress', '/pamela/wordpress']]);
    assert.equal(readState(state).apps[0]!.deleted, null);
    assert.equal((await status()).state, 'offline');
    await ask({ op: 'online', id: 'blog' });
    assert.equal((await blogJob()).ok, true);
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'subdomain blog\n');
  });

  it('for good: only from the deleted software; then out of nginx, podman reset, its user and files removed, and out of the record', async () => {
    await assert.rejects(ask({ op: 'purge', id: 'blog' }), (e: AppsCallError) => e.code === 'conflict' && /^Delete it first/.test(e.message));
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' }); await blogJob();
    ran = [];
    await ask({ op: 'purge', id: 'blog', actor: 'pamela' });
    // it leaves the record as it ends: wait on the history instead of its status
    for (let i = 0; i < 200 && !readFileSync(join(state, 'history.json'), 'utf8').includes('"purge"'); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    const h = JSON.parse(readFileSync(join(state, 'history.json'), 'utf8')) as Job[];
    assert.deepEqual([h.at(-1)!.op, h.at(-1)!.ok, h.at(-1)!.message], ['purge', true, 'Deleted for good: its files, database, backups and its user are gone.']);
    assert.deepEqual(said().map((x) => x.split(' ').slice(0, 4).join(' ')), [
      'root: nginx -t -q', 'root: systemctl reload nginx',
      'svc-pammywp: sh -uc systemctl', 'root: sh -euc u=$1;', 'root: sh -euc changed=;',
    ]);
    const reset = ran.find((x) => x.argv[3] === 'app-reset')!;
    assert.match(reset.argv[2]!, /podman system reset -f$/);
    assert.deepEqual(reset.argv.slice(4), ['pammywp-web.service', 'pammywp-db.service', 'pammywp-backup.timer', 'podman-auto-update.timer']);
    const purge = ran.find((x) => x.argv[3] === 'app-purge')!;
    assert.deepEqual(purge.argv.slice(4), ['svc-pammywp', '/var/lib/svc-pammywp', '/srv/pamela-wordpress', '/pamela/wordpress', '/home/pamela/wordpress-login.txt']);
    assert.deepEqual(readState(state).apps, []);
    // nginx: no install left -- its placement line gone, and main/server as the helper writes them for none
    assert.ok(!existsSync(join(root, NGX, 'placement')));
    for (const [f, t] of renderAll(TEMPLATES, [])) assert.equal(readFileSync(join(root, f), 'utf8'), t, f);
    await assert.rejects(status(), (e: AppsCallError) => e.code === 'not-found');
  });

  it('a panel install that didn\'t finish: Delete removes it for good at once, with its proxy file and placement', async () => {
    installFails = 'pull';
    await ask({ op: 'install', id: 'journal', placement: { mode: 'subdomain', name: 'journal' }, title: 'J', adminUser: 'pamela', adminEmail: 'hello@pammy.org', actor: 'pamela' });
    for (let i = 0; i < 400 && readState(state).apps.find((a) => a.id === 'journal')!.setup!.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    world.put(`${NGX}/proxy-journal.conf`, 'x');
    world.put(`${NGX}/placement-journal`, 'off\n');
    const r = await ask<{ job: Job }>({ op: 'delete', id: 'journal', actor: 'pamela' });
    assert.equal(r.job.op, 'purge');
    for (let i = 0; i < 400 && readState(state).apps.some((a) => a.id === 'journal'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(readState(state).apps.map((a) => a.id), ['blog']);
    assert.ok(!existsSync(join(root, NGX, 'proxy-journal.conf')) && !existsSync(join(root, NGX, 'placement-journal')));
    assert.equal(readFileSync(join(root, NGX, 'placement'), 'utf8'), 'subdomain blog\n', 'the blog stays where it is');
    const purge = ran.find((x) => x.argv[3] === 'app-purge')!;
    assert.deepEqual(purge.argv.slice(4), ['svc-app-journal', '/var/lib/svc-app-journal', '/srv/pamela-apps/journal', '/pamela/apps/journal', '/home/pamela/apps/journal-login.txt']);
  });

  it('after 30 days, purge-due deletes it for good; not a day before', async () => {
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' }); await blogJob();
    clock += days(30) - 60;
    assert.deepEqual(await ask({ op: 'purge-due' }), { started: [] });
    clock += 120;
    assert.deepEqual(await ask({ op: 'purge-due' }), { started: ['blog'] });
    for (let i = 0; i < 400 && readState(state).apps.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(readState(state).apps, []);
    const h = JSON.parse(readFileSync(join(state, 'history.json'), 'utf8')) as Job[];
    assert.deepEqual([h.at(-1)!.op, h.at(-1)!.by], ['purge', 'after 30 days']);
  });

  it('a deleted name can\'t be installed again until it goes for good', async () => {
    await ask({ op: 'delete', id: 'blog', actor: 'pamela' }); await blogJob();
    await assert.rejects(ask({ op: 'install', id: 'blog', placement: { mode: 'off' }, title: 'B', adminUser: 'pamela', adminEmail: 'hello@pammy.org' }),
      (e: AppsCallError) => e.code === 'exists' && /is in your deleted software until/.test(e.message));
  });

  it('for good never goes anywhere a record could point it but its own two shapes', () => {
    const blog = readState(state).apps[0]!;
    assert.deepEqual(purgePaths(blog), { user: 'svc-pammywp', home: '/var/lib/svc-pammywp', files: '/srv/pamela-wordpress', link: '/pamela/wordpress', login: '/home/pamela/wordpress-login.txt' });
    for (const bad of [{ files: '/srv' }, { files: '/pamela/public' }, { user: 'svc-pammypanel' }, { filesLink: '/pamela/public' }, { loginFile: '/home/pamela/.ssh' }, { layout: 'standard' as const }]) {
      assert.throws(() => purgePaths({ ...blog, ...bad }), (e: AppsError) => e.code === 'unavailable', JSON.stringify(bad));
    }
    const std = standardRecord('shop', 3100, clock);
    assert.equal(purgePaths(std).files, '/srv/pamela-apps/shop');
    assert.throws(() => purgePaths({ ...std, files: '/srv/pamela-apps' }));
  });

  it('a damaged record: deleted but not offline is refused', () => {
    assert.throws(() => checkRecord({ ...readState(state).apps[0]!, deleted: { at: clock, by: 'x' }, offline: null }), /deleted of blog/);
  });
});
