// What the software helper does to a WordPress (docs/apps-plan.md phase 2):
// back it up, put a backup back, take it offline and bring it back, make a new
// admin password. Each is the same short, fixed sequence the scripts in
// ~/pamela-setup/wordpress run (backup-wordpress.sh, restore-wordpress.sh,
// place-wordpress.sh, lib.sh), done through the runner (runner.ts): commands as
// the software's own user, or as root, as named systemd units.
//
// Every value that reaches a command comes from the helper's own record or was
// checked here against what is really there (a backup's moment against the
// files in its folder, an admin's name against WordPress's own list) -- never
// from the request as it came.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, RunAs, Runner, RunResult } from './runner.ts';
import { answerSoon, listDir, readText, uidOf, type Host } from './host.ts';
import { configWriter } from './config-files.ts';
import { proxyFileOf, renderAll, WORDPRESS_NGX, type Placed } from './nginx.ts';
import { addressOf, parsePlacement, siteUrlOf, stampToUnix, type Placement } from './placement.ts';
import { AppsError, type AppRecord } from './record.ts';

export const STAMP_RE = /^\d{8}T\d{6}Z$/;
const CLI_IMAGE = 'docker.io/library/wordpress:cli-php8.3';

// The names of an install's other parts: the adopted blog's, as
// install-wordpress.sh gave them, or a panel install's, from its id.
export function partsOf(a: AppRecord) {
  if (a.layout === 'adopted-wordpress') return { network: 'pammywp', dbSecret: 'pammywp-db-password', rootSecret: 'pammywp-db-root-password', backupUnit: 'pammywp-backup', database: 'wordpress' };
  // an install from the panel (4b): everything named after it
  const n = `app-${a.id}`;
  return { network: n, dbSecret: `${n}-db-password`, rootSecret: `${n}-db-root-password`, backupUnit: `${n}-backup`, database: 'wordpress' };
}

export type Backup = { stamp: string; at: number; bytes: number; address: string | null };

export type WordPressDeps = {
  host: Host;
  run: Runner;
  exec: Exec;
  templates: string;          // the nginx templates (nginx.ts)
  sleep: (ms: number) => Promise<void>;
  apps: () => AppRecord[];    // every install, from the record (nginx has all of them in its two files)
};

export function wordpress(d: WordPressDeps) {
  const { host, run } = d;
  const putConfig = configWriter(host, run);

  const svc = async (a: AppRecord): Promise<RunAs> => {
    const uid = await uidOf(host, a.user);
    if (uid === null) throw new AppsError('unavailable', `Its system user (${a.user}) is missing, so nothing can be done to it.`);
    return { user: a.user, uid, home: `/var/lib/${a.user}` };
  };
  // A step that must work: its failure is said in her words, with the command's
  // own last lines kept for the helper's log.
  const must = (r: RunResult, words: string) => {
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
      throw new AppsError('internal', `${words}${detail ? ` (${detail.slice(0, 300)})` : ''}`);
    }
    return r;
  };
  const userCtl = async (a: AppRecord, args: string[], what: string, timeoutSec = 300) =>
    run({ as: await svc(a), argv: ['systemctl', '--user', ...args], what, timeoutSec });

  // wp-cli in a throwaway container with the site's files, settings and
  // database, exactly as lib.sh wp() runs it
  const wp = async (a: AppRecord, args: string[], stdin?: string) => {
    const p = partsOf(a);
    return run({
      as: await svc(a), what: 'wp-cli', timeoutSec: 120, stdin,
      argv: ['podman', 'run', '--rm', '-i', '--network', p.network,
        '--userns', 'keep-id:uid=33,gid=33', '--user', '33:33',
        '-v', `${a.files}:/var/www/html`, '-v', `${a.config}:/etc/pammywp:ro`,
        '-e', `WORDPRESS_DB_HOST=${a.units.db}`, '-e', `WORDPRESS_DB_NAME=${p.database}`, '-e', `WORDPRESS_DB_USER=${p.database}`,
        '-e', `WORDPRESS_DB_PASSWORD_FILE=/run/secrets/${p.dbSecret}`, '--secret', p.dbSecret,
        '-e', "WORDPRESS_CONFIG_EXTRA=require '/etc/pammywp/wp.php';",
        '-e', 'WP_CLI_CONFIG_PATH=/etc/pammywp/wp-cli.yml', '-e', 'HOME=/tmp',
        CLI_IMAGE, 'wp', ...args],
    });
  };

  const waitForDb = async (a: AppRecord) => {
    for (let i = 0; i < 60; i++) {
      if ((await run({ as: await svc(a), argv: ['podman', 'healthcheck', 'run', a.units.db], what: 'db-ready', timeoutSec: 30 })).code === 0) return;
      await d.sleep(2000);
    }
    throw new AppsError('internal', 'Its database did not become ready within two minutes.');
  };
  // Apache answering on its own port, any status: it is up
  const waitForSite = async (a: AppRecord, siteAddress: string | null) => {
    for (let i = 0; i < 60; i++) {
      const r = await host.probe({ url: siteAddress ? `${siteAddress.replace(/\/$/, '')}/` : 'http://localhost/', connect: { host: '127.0.0.1', port: a.port, tls: false }, timeoutMs: 3000 });
      if (r.status !== null) return;
      await d.sleep(2000);
    }
    throw new AppsError('internal', 'Its web server did not answer within two minutes.');
  };
  const siteAddressOf = async (a: AppRecord) => (await readText(host, `${a.config}/content-url`))?.trim() || null;

  // ------------------------------------------------------------------ nginx
  // Stage, `nginx -t`, reload -- and put the three files back if nginx says no,
  // exactly as place-wordpress.sh does.
  // Every install's placement as it is now (its own line), with this one's
  // changed to `p`, in the order they were installed (the blog first).
  const placedWith = async (a: AppRecord, p: Placement): Promise<Placed[]> => {
    const all = d.apps().some((x) => x.id === a.id) ? d.apps() : [...d.apps(), a];
    return Promise.all([...all].sort((x, y) => x.installedAt - y.installedAt || x.id.localeCompare(y.id)).map(async (x) => ({
      id: x.id, port: x.port, placementFile: x.placementFile, adopted: x.layout === 'adopted-wordpress',
      placement: x.id === a.id ? p : parsePlacement(await readText(host, x.placementFile)) ?? { mode: 'off', name: null },
    })));
  };
  // Stage every file, `nginx -t`, and put them all back if nginx says no --
  // as place-wordpress.sh does. `reload: false` leaves the reload to the
  // caller (a move reloads only once WordPress has taken its new address), and
  // the returned function puts the old files back.
  const place = async (a: AppRecord, p: Placement, opts: { reload?: boolean } = {}) => {
    let files: Map<string, string>;
    try { files = renderAll(d.templates, await placedWith(a, p)); } catch (e) { throw new AppsError('conflict', (e as Error).message); }
    return stage(files, [], opts);
  };
  // Out of nginx for good (4c): every other install's files as they are, and
  // this one's placement line and proxy file removed.
  const unplace = async (a: AppRecord) => {
    const others = (await placedWith(a, { mode: 'off', name: null })).filter((x) => x.id !== a.id);
    let files: Map<string, string>;
    try { files = renderAll(d.templates, others); } catch (e) { throw new AppsError('conflict', (e as Error).message); }
    const own: Placed = { id: a.id, port: a.port, placementFile: a.placementFile, adopted: a.layout === 'adopted-wordpress', placement: { mode: 'off', name: null } };
    // the blog's proxy.conf is install-wordpress.sh's, and stays
    return stage(files, [a.placementFile, ...(own.adopted ? [] : [`${WORDPRESS_NGX}/${proxyFileOf(own)}`])], {});
  };
  // Write these files and remove those, `nginx -t`, and put everything back if
  // nginx says no. The returned function puts it back later (a move that fails).
  const stage = async (files: Map<string, string>, gone: string[], opts: { reload?: boolean }) => {
    const before = new Map<string, string | null>();
    for (const f of [...files.keys(), ...gone]) before.set(f, await readText(host, f));
    const write = (f: string, text: string) => writeFileSync(join(host.root, f), text, { mode: 0o644 });
    const putBack = () => {
      for (const [f, text] of before) {
        if (text !== null) write(f, text);
        else rmSync(join(host.root, f), { force: true });
      }
    };
    for (const [f, text] of files) write(f, text);
    for (const f of gone) rmSync(join(host.root, f), { force: true });
    const t = await run({ as: 'root', argv: ['nginx', '-t', '-q'], what: 'nginx-test', timeoutSec: 60 });
    if (t.code !== 0) {
      putBack();
      must(t, 'nginx did not accept the change, so everything was put back as it was.');
    }
    if (opts.reload !== false) await reload();
    return putBack;
  };
  const reload = async () => {
    must(await run({ as: 'root', argv: ['systemctl', 'reload', 'nginx'], what: 'nginx-reload', timeoutSec: 60 }), 'nginx could not reload.');
    await d.sleep(2000);    // a reload hands over asynchronously; don't ask the old workers
  };

  // ------------------------------------------------------------------ backups
  const backups = async (a: AppRecord): Promise<Backup[]> => {
    const files = await listDir(host, a.backups) ?? [];
    const names = new Set(files.map((f) => f.name));
    const out: Backup[] = [];
    for (const f of files) {
      const m = f.name.match(/^db-(\d{8}T\d{6}Z)\.sql\.gz$/);
      if (!m || !names.has(`files-${m[1]}.tar.gz`)) continue;
      const stamp = m[1]!;
      const bytes = f.bytes + (files.find((x) => x.name === `files-${stamp}.tar.gz`)?.bytes ?? 0);
      const address = (await readText(host, `${a.backups}/url-${stamp}.txt`))?.trim() || null;
      out.push({ stamp, at: stampToUnix(stamp), bytes, address });
    }
    return out.sort((x, y) => y.at - x.at);
  };

  const backupNow = async (a: AppRecord) => {
    must(await userCtl(a, ['start', `${partsOf(a).backupUnit}.service`], 'backup', 1800), 'The backup did not finish.');
  };

  return {
    backups,
    place,
    unplace,
    // for the installer (install.ts)
    backupNow, waitForDb, waitForSite, wp, putConfig,

    async backup(a: AppRecord, step: (s: string) => void) {
      if (a.offline) throw new AppsError('conflict', 'It is offline, so there is nothing new to back up. Its backups from before are kept.');
      step('Copying its files and database');
      await backupNow(a);
      const b = (await backups(a))[0];
      return b ? `Backed up (${Math.max(1, Math.round(b.bytes / 1024 / 1024))} MB).` : 'Backed up.';
    },

    // A4: containers stopped, served nowhere, and it stays that way after a
    // restart of the server -- the units are masked, the nightly backup is off.
    async offline(a: AppRecord, step: (s: string) => void, save: (from: string) => void) {
      if (a.offline) throw new AppsError('conflict', 'It is already offline.');
      const line = (await readText(host, a.placementFile))?.trim() ?? '';
      if (!parsePlacement(line)) throw new AppsError('unavailable', 'Its address setting could not be read, so the panel will not change it.');
      step('Taking it off its address');
      await place(a, { mode: 'off', name: null });
      save(line);
      step('Stopping it');
      const p = partsOf(a);
      must(await userCtl(a, ['disable', '--now', `${p.backupUnit}.timer`], 'backup-timer-off'), 'Its nightly backup could not be switched off.');
      must(await userCtl(a, ['stop', `${a.units.web}.service`, `${a.units.db}.service`], 'stop'), 'It could not be stopped.');
      must(await userCtl(a, ['mask', `${a.units.web}.service`, `${a.units.db}.service`], 'mask'), 'It could not be kept stopped after a restart.');
      return 'It is offline. Nothing was deleted.';
    },

    async online(a: AppRecord, step: (s: string) => void, save: () => void) {
      if (!a.offline) throw new AppsError('conflict', 'It is already online.');
      const back = parsePlacement(a.offline.from);
      if (!back) throw new AppsError('unavailable', 'The address it had before could not be read.');
      step('Starting it');
      const p = partsOf(a);
      must(await userCtl(a, ['unmask', `${a.units.web}.service`, `${a.units.db}.service`], 'unmask'), 'It could not be unlocked.');
      must(await userCtl(a, ['start', `${a.units.web}.service`], 'start', 600), 'It could not be started.');
      step('Waiting for it to be ready');
      await waitForDb(a);
      await waitForSite(a, await siteAddressOf(a));
      must(await userCtl(a, ['enable', '--now', `${p.backupUnit}.timer`], 'backup-timer-on'), 'Its nightly backup could not be switched on again.');
      const address = addressOf(back, host.domain);
      if (address) {
        step('Putting it back on its address');
        await place(a, back);
        const r = await host.probe({ url: address, connect: { ...host.nginx, tls: true }, timeoutMs: 8000 });
        save();
        if (r.status === null || r.status >= 400) {
          return `It is running at ${address}, but it answered with ${r.status ?? 'nothing'} just now. Check again in a minute.`;
        }
        return `It is back at ${address}.`;
      }
      save();
      return 'It is running again (it was not served at any address before, and still is not).';
    },

    // Whole backups only (P2b): its files and database together, as they were
    // at that moment. A backup of now is taken first, and the files it replaces
    // are kept beside them, so a restore can itself be undone.
    async restore(a: AppRecord, stamp: string, step: (s: string) => void) {
      if (a.offline) throw new AppsError('conflict', 'Bring it online first, then put the backup back.');
      const b = (await backups(a)).find((x) => x.stamp === stamp);
      if (!b) throw new AppsError('not-found', 'That backup is not there any more.');
      const now = await siteAddressOf(a);
      if (b.address && now && b.address !== now) {
        throw new AppsError('conflict', `That backup was made when it was at ${b.address}, and its links point there. Ask momolig to put it back.`);
      }
      const db = `${a.backups}/db-${stamp}.sql.gz`;
      const files = `${a.backups}/files-${stamp}.tar.gz`;
      step('Checking the backup');
      must(await d.exec(['gzip', '-t', join(host.root, db)]), 'The backup is damaged (its database part), so nothing was changed.');
      must(await d.exec(['gzip', '-t', join(host.root, files)]), 'The backup is damaged (its files part), so nothing was changed.');
      step('Backing up how it is now, first');
      await backupNow(a);
      const aside = `${a.files}.pre-restore-${new Date(host.now() * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
      step('Putting its files back');
      must(await userCtl(a, ['stop', `${a.units.web}.service`], 'restore-stop'), 'It could not be stopped for the restore, so nothing was changed.');
      try {
        // as root: owners, modes and setgid as they were (tar -p), the folder's
        // default ACL as install-wordpress.sh set it; replaced files kept aside
        // for 14 days (older ones are removed here)
        must(await run({
          as: 'root', what: 'restore-files', timeoutSec: 1800,
          argv: ['sh', '-euc', [
            'dir=$1; aside=$2; tarball=$3',
            'find "$(dirname "$dir")" -maxdepth 1 -name "$(basename "$dir").pre-restore-*" -mtime +14 -exec rm -rf {} +',
            'mv "$dir" "$aside"',
            'tar -xpzf "$tarball" -C "$(dirname "$dir")"',
            'setfacl -d -m u::rwx,g::rwx,o::--- "$dir"',
          ].join('\n'), 'restore-files', a.files, aside, files],
        }), 'Its files could not be put back.');
      } finally {
        await userCtl(a, ['start', `${a.units.web}.service`], 'restore-start', 600);
      }
      step('Putting its database back');
      await waitForDb(a);
      const pr = partsOf(a);
      must(await run({
        as: await svc(a), what: 'restore-db', timeoutSec: 1800,
        argv: ['sh', '-euc',
          `gunzip -c "$1" | podman exec -i "$2" sh -c 'MYSQL_PWD="$(cat /run/secrets/${pr.rootSecret})" exec mariadb -uroot'`,
          'restore-db', db, a.units.db],
      }), 'Its database could not be put back. Its files were; ask momolig.');
      step('Waiting for it to answer');
      await waitForSite(a, now);
      return `Put back as it was on ${new Date(b.at * 1000).toISOString().slice(0, 16).replace('T', ' ')} (UTC). How it was just before is kept as a backup too.`;
    },

    async admins(a: AppRecord): Promise<string[]> {
      if (a.offline) throw new AppsError('conflict', 'It is offline. Bring it online first.');
      const r = must(await wp(a, ['user', 'list', '--role=administrator', '--fields=user_login', '--format=json']), 'WordPress did not say who its administrators are.');
      let list: unknown;
      try { list = JSON.parse(r.stdout); } catch { throw new AppsError('internal', 'WordPress did not say who its administrators are.'); }
      return Array.isArray(list) ? list.map((u) => (u as { user_login?: unknown }).user_login).filter((u): u is string => typeof u === 'string') : [];
    },

    // A new password for one of its administrators (P2c): shown once, and
    // written into her login file, as her, the way install-wordpress.sh left it.
    async resetAdmin(a: AppRecord, user: string, admins: string[]) {
      if (!admins.includes(user)) throw new AppsError('not-found', 'There is no administrator by that name.');
      const password = randomBytes(18).toString('base64url');
      // on stdin, so it is never on a command line (--prompt reads it from there)
      // wp-cli repeats the answer to its prompt on stdout, so this failure is
      // never quoted: the password must not reach a message or the history
      const u = await wp(a, ['user', 'update', user, '--prompt=user_pass', '--skip-email'], `${password}\n`);
      if (u.code !== 0) throw new AppsError('internal', 'WordPress did not take the new password. The old one still works.');
      let savedTo: string | null = null;
      if (a.loginFile) {
        const text = [
          'Your WordPress login', '====================',
          `Log in at:  ${(await siteAddressOf(a))?.replace(/\/$/, '') ?? '(the address you were given)'}/wp-admin/`,
          `Username:   ${user}`, `Password:   ${password}`, '',
          `Made by the control panel on ${new Date(host.now() * 1000).toISOString().slice(0, 10)}. Change it after you`,
          'log in (Users -> Profile) if you like, then delete this file.', '',
        ].join('\n');
        const w = await run({ as: { user: 'pamela', uid: (await uidOf(host, 'pamela')) ?? -1, home: '/home/pamela' }, what: 'login-file', timeoutSec: 30, stdin: text,
          argv: ['sh', '-euc', 'umask 077; cat > "$1"', 'login-file', a.loginFile] });
        if (w.code === 0) savedTo = a.loginFile;
      }
      return { user, password, savedTo };
    },

    // Move (4a): place-wordpress.sh, step for step. A backup first; nginx
    // staged and tested but not yet reloaded; WordPress given its new address
    // (wp.php, apache.conf's Alias for a path) and restarted; the links in its
    // content rewritten from the address they use (three passes, as lib.sh
    // apply_wp_placement: "old/", the bare address not followed by more of a
    // name, and the block editor's JSON-escaped form); then nginx reloads. If
    // WordPress refuses, nginx and its settings are put back.
    async move(a: AppRecord, to: Placement, step: (s: string) => void) {
      if (a.offline) throw new AppsError('conflict', 'Bring it online first, then move it.');
      if (to.mode === 'off') throw new AppsError('invalid', 'To take it off its address, use "Take it offline".');
      const cur = parsePlacement(await readText(host, a.placementFile));
      if (cur && cur.mode === to.mode && cur.name === to.name) throw new AppsError('conflict', 'It is already there.');
      const url = siteUrlOf(to, host.domain)!;
      const old = await siteAddressOf(a);
      step('Backing it up first');
      await backupNow(a);
      step('Getting nginx ready');
      const putBack = await place(a, to, { reload: false });
      const conf = (f: string) => join(host.root, a.config, f);
      const was = { wp: readFileSync(conf('wp.php'), 'utf8'), apache: readFileSync(conf('apache.conf'), 'utf8') };
      // written in place, never renamed: apache.conf is a single-file bind
      // mount, which a new file (a new inode) would leave behind
      const wpPhp = `${readFileSync(join(d.templates, 'wp.php'), 'utf8').replace(/\n+$/, '').split('@URL@').join(url)}\n`;
      const apache = `# Written by place-wordpress.sh -- placement: ${to.name ? `${to.mode} ${to.name}` : to.mode}\n${to.mode === 'path' ? `Alias /${to.name} /var/www/html` : '# no Alias: WordPress is at the root of its hostname'}\n`;
      try {
        step('Giving WordPress its new address');
        await putConfig(a, 'wp.php', wpPhp);
        await putConfig(a, 'apache.conf', apache);
        must(await userCtl(a, ['restart', `${a.units.web}.service`], 'move-restart', 600), 'WordPress could not be restarted.');
        await waitForSite(a, old);
        await waitForDb(a);
        const installed = (await wp(a, ['core', 'is-installed'])).code === 0;
        if (installed) {
          if (old && old !== url) {
            step('Changing the links in its posts');
            const oq = old.split('.').join('\\.');
            const jsOld = old.split('/').join('\\/');
            const jsUrl = url.split('/').join('\\/');
            const common = ['--skip-columns=guid', '--all-tables-with-prefix', '--report-changed-only'];
            must(await wp(a, ['search-replace', `${old}/`, `${url}/`, ...common]), 'The links in its posts could not be changed.');
            must(await wp(a, ['search-replace', `${oq}(?![A-Za-z0-9._-])`, url, '--regex', '--regex-delimiter=#', ...common]), 'The links in its posts could not all be changed.');
            must(await wp(a, ['search-replace', `${jsOld}\\/`, `${jsUrl}\\/`, ...common]), 'The links in its posts could not all be changed.');
          }
          await putConfig(a, 'content-url', `${url}\n`);
          must(await wp(a, ['rewrite', 'flush', '--hard']), 'WordPress could not update its own links (permalinks).');
        }
      } catch (e) {
        putBack();
        await putConfig(a, 'wp.php', was.wp);
        await putConfig(a, 'apache.conf', was.apache);
        await userCtl(a, ['restart', `${a.units.web}.service`], 'move-undo', 600);
        throw new AppsError('internal', `It couldn't be moved, so nginx and its settings were put back as they were. ${(e as Error).message} If some links were already changed, put back the backup just taken.`);
      }
      step('Switching nginx over');
      await reload();
      const address = addressOf(to, host.domain)!;
      const r = await answerSoon(host, address, d.sleep);
      const fromRoot = old === `https://${host.domain}` ? ` Links in its posts to your other pages on ${host.domain} were changed too: look over them.` : '';
      return r.status !== null && r.status < 400
        ? `It is now at ${address}.${fromRoot}`
        : `It is at ${address} now, but it answered with ${r.status ?? 'nothing'} just now. Check again in a minute.${fromRoot}`;
    },

    // A test email through WordPress's own wp_mail (phase 3): its plugin, its
    // SMTP, its network. The PHP is the helper's own (mail.ts testScript).
    async mailTest(a: AppRecord, php: string) {
      if (a.offline) throw new AppsError('conflict', 'It is offline. Bring it online first.');
      const r = await wp(a, ['eval', php]);
      const out = r.stdout.trim();
      if (r.code === 0 && /^sent$/m.test(out)) return;
      const why = out.match(/^failed: (.*)$/m)?.[1];
      throw new AppsError('conflict', `WordPress could not send it${why ? `: ${why.slice(0, 300)}` : '.'}`);
    },

    // The last lines it complained about (stderr and its units' own messages),
    // newest last. Read from the journal by the helper itself.
    async logs(a: AppRecord) {
      const uid = await uidOf(host, a.user);
      const part = async (unit: string) => {
        const r = await d.exec(['journalctl', '--no-pager', '-q', '-o', 'short-iso', '-n', '40',
          ...(uid !== null ? [`_UID=${uid}`] : []), `CONTAINER_NAME=${unit}`, '-p', 'warning']);
        return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(0, 400));
      };
      return { web: await part(a.units.web), db: await part(a.units.db) };
    },
  };
}
