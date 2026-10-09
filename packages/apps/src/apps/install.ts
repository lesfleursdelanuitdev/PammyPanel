// Installing a new WordPress from the panel (docs/apps-plan.md 4b): what
// ~/pamela-setup/wordpress/install-wordpress.sh does for the blog, with the
// install's own names (record.ts standardRecord) and in steps she can watch.
// Every command runs as a short-lived systemd unit (runner.ts), as root, as the
// install's own user, or as pamela (her link and her login file).
//
// Checked before anything is made (G7): the name and address, the server's free
// memory and disk, how many are running, and a free port. If a step fails, what
// was made so far stays, and the record says where it stopped. Installing it
// again under the same name goes through every step once more: each one is safe
// to repeat, so it picks up what is missing. Delete (4c) clears it instead.
import { randomBytes } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { answerSoon, memory, readText, uidOf, type Host } from './host.ts';
import { addressOf, RESERVED, siteUrlOf, type Placement } from './placement.ts';
import { AppsError, type AppRecord } from './record.ts';
import type { RunAs, Runner, RunResult } from './runner.ts';
import { unitsFor } from './wp/units.ts';
import { partsOf } from './wordpress.ts';

export const INSTALL_ID_RE = /^[a-z][a-z0-9]{0,19}(?:-[a-z0-9]+)*$/;
export const PORTS = { from: 3100, to: 3199 };
export const LIMITS = { memory: 1024 ** 3, disk: 3 * 1024 ** 3, running: 3 };
const IMAGES = ['docker.io/library/mariadb:11.4', 'docker.io/library/wordpress:php8.3-apache', 'docker.io/library/wordpress:cli-php8.3'];
// its first step: until it has made the install's user, nothing else exists
export const FIRST_STEP = 'Making its own user';
export const BACKUP_SCRIPT = new URL('./wp/backup-app.sh', import.meta.url).pathname;
// what it reads from ~/pamela-setup/wordpress/config (build.sh ships them, and checks)
export const WP_CONFIG_FILES = ['php.ini', 'wp-cli.yml', 'auto-updates.php'];

export type InstallRequest = { id: string; placement: Placement; title: string; adminUser: string; adminEmail: string };

// Ports something is listening on, from /proc/net/tcp{,6} (state 0A: LISTEN)
async function listening(h: Host): Promise<Set<number>> {
  const out = new Set<number>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (await readText(h, f, 16 * 1024 * 1024))?.split('\n').slice(1) ?? []) {
      const c = line.trim().split(/\s+/);
      if (c[3] === '0A' && c[1]) out.add(parseInt(c[1].split(':').at(-1)!, 16));
    }
  }
  return out;
}

// What she asked for, checked; her words for what's wrong.
export function checkRequest(r: Record<string, unknown>, domain: string): InstallRequest {
  const t = r.placement as { mode?: unknown; name?: unknown } | null;
  const mode = t?.mode;
  const name = typeof t?.name === 'string' ? t.name : null;
  if (mode !== 'subdomain' && mode !== 'path' && mode !== 'root' && mode !== 'off') throw new AppsError('invalid', `Choose where it goes: a subdomain, a folder of ${domain}, the whole site, or nowhere yet.`);
  if ((mode === 'subdomain' || mode === 'path') && (!name || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) throw new AppsError('invalid', 'Use lowercase letters, digits and hyphens for the name, like "journal".');
  if (name && RESERVED.includes(name)) throw new AppsError('invalid', `"${name}" is kept for the server itself. Pick another name.`);
  const id = typeof r.id === 'string' ? r.id : '';
  if (!INSTALL_ID_RE.test(id) || id.length > 20) throw new AppsError('invalid', 'Its short name: lowercase letters and digits (hyphens between), starting with a letter, at most 20.');
  const title = typeof r.title === 'string' ? r.title.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > 80) throw new AppsError('invalid', 'Give it a title (at most 80 characters).');
  const adminUser = typeof r.adminUser === 'string' ? r.adminUser.trim() : '';
  if (!/^[a-z][a-z0-9._-]{2,29}$/.test(adminUser)) throw new AppsError('invalid', 'Its admin name: 3 to 30 lowercase letters, digits, dots, hyphens or underscores, starting with a letter.');
  const adminEmail = typeof r.adminEmail === 'string' ? r.adminEmail.trim() : '';
  if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(adminEmail)) throw new AppsError('invalid', 'Its admin email doesn\'t look like an email address.');
  const placement = (mode === 'root' || mode === 'off' ? { mode, name: null } : { mode, name }) as Placement;
  return { id, placement, title, adminUser, adminEmail };
}

export type InstallDeps = {
  host: Host;
  run: Runner;
  wpConfig: string;           // php.ini, wp-cli.yml, auto-updates.php (~/pamela-setup/wordpress/config)
  templates: string;          // nginx templates (for wp.php)
  sleep: (ms: number) => Promise<void>;
};

// Before anything is made: is there room, and is the port free? `again`: an
// install of this name that didn't finish, tried again. Its user and port are
// its own already, and its containers may be using memory.
export async function preflight(d: InstallDeps, all: AppRecord[], req: InstallRequest, again: AppRecord | null = null): Promise<number> {
  if (all.some((a) => a.id === req.id)) throw new AppsError('exists', `There is already software called "${req.id}".`);
  if (again) {
    try {
      const fs = statfsSync(join(d.host.root, '/var/lib'));
      if (fs.bavail * fs.bsize < LIMITS.disk) throw new AppsError('invalid', 'The server is short of disk space. Ask momolig.');
    } catch (e) { if (e instanceof AppsError) throw e; }
    return again.port;
  }
  if (await uidOf(d.host, `svc-app-${req.id}`) !== null) throw new AppsError('exists', `There is already a system user for "${req.id}". Ask momolig.`);
  const running = all.filter((a) => !a.offline && !a.setup).length;
  if (running >= LIMITS.running) throw new AppsError('invalid', `${running} are running already, which is as many as this server keeps. Take one offline first.`);
  const mem = await memory(d.host);
  if (mem.available !== null && mem.available < LIMITS.memory) throw new AppsError('invalid', 'The server is short of free memory just now, so nothing new can start. Ask momolig.');
  try {
    const fs = statfsSync(join(d.host.root, '/var/lib'));
    if (fs.bavail * fs.bsize < LIMITS.disk) throw new AppsError('invalid', 'The server is short of disk space. Ask momolig.');
  } catch (e) { if (e instanceof AppsError) throw e; }
  const used = new Set(all.map((a) => a.port));
  const busy = await listening(d.host);
  for (let p = PORTS.from; p <= PORTS.to; p++) if (!used.has(p) && !busy.has(p)) return p;
  throw new AppsError('invalid', 'There is no free port for another install. Ask momolig.');
}

export function installer(d: InstallDeps, wp: {
  place: (a: AppRecord, p: Placement) => Promise<unknown>;
  backupNow: (a: AppRecord) => Promise<void>;
  waitForDb: (a: AppRecord) => Promise<void>;
  waitForSite: (a: AppRecord, url: string | null) => Promise<void>;
  wp: (a: AppRecord, args: string[], stdin?: string) => Promise<RunResult>;
  putConfig: (a: AppRecord, name: string, text: string) => Promise<void>;
  mailFor: (a: AppRecord) => Promise<void>;
}) {
  const { host, run } = d;
  const must = (r: RunResult, words: string) => {
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ').slice(0, 300);
      throw new AppsError('internal', `${words}${detail ? ` (${detail})` : ''}`);
    }
    return r;
  };
  const root = (what: string, script: string, args: string[], timeoutSec = 300, stdin?: string) =>
    run({ as: 'root', what, timeoutSec, stdin, argv: ['sh', '-euc', script, what, ...args] });
  const svcAs = async (a: AppRecord): Promise<RunAs> => {
    const uid = await uidOf(host, a.user);
    if (uid === null) throw new AppsError('internal', `Its system user (${a.user}) is missing.`);
    return { user: a.user, uid, home: `/var/lib/${a.user}` };
  };
  const asSvc = async (a: AppRecord, what: string, argv: string[], timeoutSec = 300, stdin?: string) =>
    run({ as: await svcAs(a), what, timeoutSec, stdin, argv });
  const asPamela = async (what: string, script: string, args: string[], stdin?: string) =>
    run({ as: { user: 'pamela', uid: (await uidOf(host, 'pamela')) ?? -1, home: '/home/pamela' }, what, timeoutSec: 60, stdin, argv: ['sh', '-euc', script, what, ...args] });

  return async function install(a: AppRecord, req: InstallRequest, step: (s: string) => void): Promise<{ password: string; message: string }> {
    const home = `/var/lib/${a.user}`;
    const p = partsOf(a);

    // 1. its user: a system user with no shell and no password, a subuid range
    // after everyone else's, lingering (its containers start at boot), and
    // pamela in its group so she can edit its files (at her next login)
    step(FIRST_STEP);
    must(await root('app-user', [
      'u=$1; home=$2',
      // each part only if it isn't there yet: an install tried again repeats this
      'id -u "$u" >/dev/null 2>&1 || useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin "$u"',
      'chmod 700 "$home"',
      'if ! grep -q "^$u:" /etc/subuid || ! grep -q "^$u:" /etc/subgid; then',
      '  start=$(awk -F: \'{e=$2+$3; if (e>m) m=e} END {print m}\' /etc/subuid /etc/subgid)',
      '  grep -q "^$u:" /etc/subuid || usermod --add-subuids "$start-$((start+65535))" "$u"',
      '  grep -q "^$u:" /etc/subgid || usermod --add-subgids "$start-$((start+65535))" "$u"',
      'fi',
      // podman 4.9 overmounts /var/lib when this is missing (install-wordpress.sh)
      'install -d -o root -g root -m 755 /var/lib/cni',
      'loginctl enable-linger "$u"',
      'usermod -aG "$u" pamela',
      'uid=$(id -u "$u"); for i in $(seq 60); do [ -S "/run/user/$uid/bus" ] && exit 0; sleep 1; done; echo "its systemd user manager did not start" >&2; exit 1',
    ].join('\n'), [a.user, home], 120), 'Its user could not be made.');

    // 2. its files (hers to edit, through the link) and its settings (root's)
    step('Making its folders and settings');
    must(await root('app-folders', [
      'u=$1; files=$2; conf=$3; home=$4',
      'install -d -o root -g root -m 755 "$(dirname "$files")"',
      'install -d -o "$u" -g "$u" -m 2770 "$files"',
      'setfacl -d -m u::rwx,g::rwx,o::--- "$files"',
      'install -d -o root -g root -m 755 "$conf" "$home/bin"',
      'install -d -o "$u" -g "$u" -m 700 "$home/backups"',
    ].join('\n'), [a.user, a.files, a.config, home]), 'Its folders could not be made.');
    const url = siteUrlOf(req.placement, host.domain) ?? `http://127.0.0.1:${a.port}`;
    const wpPhp = `${readFileSync(join(d.templates, 'wp.php'), 'utf8').replace(/\n+$/, '').split('@URL@').join(url)}\n`;
    const label = req.placement.name ? `${req.placement.mode} ${req.placement.name}` : req.placement.mode;
    await wp.putConfig(a, 'wp.php', wpPhp);
    await wp.putConfig(a, 'apache.conf', `# Written by the ${host.domain} panel -- placement: ${label}\n${req.placement.mode === 'path' ? `Alias /${req.placement.name} /var/www/html` : '# no Alias: WordPress is at the root of its hostname'}\n`);
    await wp.putConfig(a, 'php.ini', readFileSync(join(d.wpConfig, 'php.ini'), 'utf8'));
    await wp.putConfig(a, 'wp-cli.yml', readFileSync(join(d.wpConfig, 'wp-cli.yml'), 'utf8'));
    must(await root('app-backup-script', 'umask 022; cat > "$1"; chmod 755 "$1"', [`${home}/bin/backup-app.sh`], 60, readFileSync(BACKUP_SCRIPT, 'utf8')), 'Its backup program could not be put in place.');
    // her way in, next to her website folder (P4b)
    must(await asPamela('app-link', 'mkdir -p "$(dirname "$2")"; ln -sfn "$1" "$2"', [a.files, a.filesLink!]), 'Her link to its files could not be made.');

    // 3. its database's passwords, as podman secrets (never in a file of ours)
    step('Making its database passwords');
    must(await asSvc(a, 'app-secrets', ['sh', '-euc', 'for s in "$@"; do podman secret exists "$s" || head -c 33 /dev/urandom | base64 | tr -d "/+=\\n" | podman secret create "$s" - >/dev/null; done', 'app-secrets', p.dbSecret, p.rootSecret]), 'Its database passwords could not be made.');

    // 4. its units, and WordPress itself (its own copy of each image)
    step('Downloading WordPress (a few minutes)');
    for (const [name, u] of Object.entries(unitsFor(a, host.domain))) {
      const dir = u.dir === 'quadlet' ? `${home}/.config/containers/systemd` : `${home}/.config/systemd/user`;
      must(await asSvc(a, 'app-unit', ['sh', '-euc', 'mkdir -p -m 700 "$(dirname "$1")"; umask 077; cat > "$1"; chmod 644 "$1"', 'app-unit', `${dir}/${name}`], 60, u.text), `Its unit ${name} could not be written.`);
    }
    for (const img of IMAGES) {
      must(await asSvc(a, 'app-pull', ['sh', '-euc', 'podman image exists "$1" || podman pull -q "$1" >/dev/null', 'app-pull', img], 1800), 'WordPress could not be downloaded.');
    }

    step('Starting it');
    must(await asSvc(a, 'app-reload', ['systemctl', '--user', 'daemon-reload']), 'Its units could not be loaded.');
    must(await asSvc(a, 'app-start', ['systemctl', '--user', 'start', `${a.units.web}.service`], 600), 'It could not be started.');
    await wp.waitForSite(a, url);
    await wp.waitForDb(a);
    // the image's first copy leaves everything world-readable (install-wordpress.sh):
    // the group gets write for her, others get nothing
    must(await root('app-modes', [
      'files=$1',
      'for i in $(seq 60); do [ -f "$files/wp-includes/version.php" ] && break; sleep 2; done',
      '[ -f "$files/wp-includes/version.php" ] || { echo "the WordPress files never appeared" >&2; exit 1; }',
      'chmod -R g+rwX,o-rwx "$files"',
      'find "$files" -type d -exec chmod g+s {} +',
    ].join('\n'), [a.files], 300), 'Its files could not be made hers to edit.');

    // 5. WordPress: installed, with the admin she named (the password on stdin)
    step('Setting up WordPress');
    const password = randomBytes(18).toString('base64url');
    // wp-cli repeats a prompted password on stdout: these failures are never quoted
    const quiet = (r: RunResult, what: string) => (r.code === 0 ? r : { ...r, stdout: '', stderr: what });
    if ((await wp.wp(a, ['core', 'is-installed'])).code !== 0) {
      must(quiet(await wp.wp(a, ['core', 'install', `--url=${url}`, `--title=${req.title}`, `--admin_user=${req.adminUser}`, `--admin_email=${req.adminEmail}`, '--prompt=admin_password', '--skip-email'], `${password}\n`),
        'wp core install failed'), 'WordPress could not be set up.');
    } else {
      // set up by an earlier try, whose password she never saw: a new one for
      // her admin (made if that try's name was another)
      const has = (await wp.wp(a, ['user', 'get', req.adminUser, '--field=ID'])).code === 0;
      must(quiet(await wp.wp(a, has
        ? ['user', 'update', req.adminUser, '--prompt=user_pass', '--skip-email']
        : ['user', 'create', req.adminUser, req.adminEmail, '--role=administrator', '--prompt=user_pass'], `${password}\n`),
        'wp user failed'), 'Its admin could not be set up.');
    }
    await wp.putConfig(a, 'content-url', `${url}\n`);
    must(await wp.wp(a, ['rewrite', 'structure', '/%postname%/', '--hard']), 'Its links could not be set up.');
    must(await asSvc(a, 'app-mu-plugins', ['sh', '-euc', 'install -d -m 2775 "$(dirname "$1")"; umask 002; cat > "$1"; chmod 664 "$1"', 'app-mu-plugins', `${a.files}/wp-content/mu-plugins/auto-updates.php`], 60,
      readFileSync(join(d.wpConfig, 'auto-updates.php'), 'utf8')), 'Its automatic updates could not be switched on.');
    await wp.mailFor(a);
    must(await asSvc(a, 'app-timers', ['systemctl', '--user', 'enable', '--now', 'podman-auto-update.timer', `${p.backupUnit}.timer`]), 'Its nightly backup could not be switched on.');

    // 6. her login file (as install-wordpress.sh's wordpress-login.txt)
    if (a.loginFile) {
      await asPamela('app-login-file', 'mkdir -p "$(dirname "$1")"; umask 077; cat > "$1"', [a.loginFile], [
        `Your WordPress login (${req.title})`, '====================', `Log in at:  ${url}/wp-admin/`,
        `Username:   ${req.adminUser}`, `Password:   ${password}`, '',
        'Change this password after you first log in (Users -> Profile), then delete this file.', '',
      ].join('\n'));
    }

    // 7. its address, a first backup, and a look
    if (req.placement.mode !== 'off') step('Putting it at its address');
    await wp.place(a, req.placement);
    step('Making its first backup');
    await wp.backupNow(a);
    const address = addressOf(req.placement, host.domain);
    if (address) {
      const r = await answerSoon(host, address, d.sleep);
      if (r.status === null || r.status >= 400) return { password, message: `It is installed at ${address}, but it answered with ${r.status ?? 'nothing'} just now. Check again in a minute.` };
      return { password, message: `It is installed at ${address}.` };
    }
    return { password, message: 'It is installed, and not at any address yet. Move it to one when you are ready.' };
  };
}
