// Deleting installed software (docs/apps-plan.md 4c): to the trash for 30 days,
// back from it, and for good.
//
// To the trash: a last backup (when it is running), then offline as A4 (off
// nginx, stopped, masked, nightly backup off), then her link to its files goes.
// Its user, files, database and backups all stay where they are, so Restore is
// only the link back and the record; it comes back offline, and "Bring it back
// online" checks its address is still free.
//
// For good: out of nginx; its containers, images, volumes and secrets removed
// by podman as its own user; then, as root, its user (and group, subuids,
// linger), its home (settings, backups, database), its files, her link and her
// login file. Every path is checked here against the only two shapes an install
// can have (the blog's, from install-wordpress.sh, and a panel install's), so a
// damaged record can never point it anywhere else.
import { uidOf, type Host } from './host.ts';
import { AppsError, type AppRecord } from './record.ts';
import type { Runner, RunResult } from './runner.ts';
import { partsOf, type wordpress } from './wordpress.ts';

export type RemoveDeps = { host: Host; run: Runner };

// What deleting for good may remove, for this install -- or a refusal.
export function purgePaths(a: AppRecord) {
  const adopted = a.layout === 'adopted-wordpress';
  const user = adopted ? 'svc-pammywp' : `svc-app-${a.id}`;
  const files = adopted ? '/srv/pamela-wordpress' : `/srv/pamela-apps/${a.id}`;
  const link = adopted ? '/pamela/wordpress' : `/pamela/apps/${a.id}`;
  const login = adopted ? '/home/pamela/wordpress-login.txt' : `/home/pamela/apps/${a.id}-login.txt`;
  if (a.user !== user || a.files !== files || (a.filesLink !== null && a.filesLink !== link) || (a.loginFile !== null && a.loginFile !== login)) {
    throw new AppsError('unavailable', 'Its record doesn\'t look like anything the panel installed, so the panel won\'t delete it. Ask momolig.');
  }
  return { user, home: `/var/lib/${user}`, files, link: a.filesLink, login: a.loginFile };
}

export function remover(d: RemoveDeps, wp: ReturnType<typeof wordpress>) {
  const { host, run } = d;
  const must = (r: RunResult, words: string) => {
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ').slice(0, 300);
      throw new AppsError('internal', `${words}${detail ? ` (${detail})` : ''}`);
    }
    return r;
  };
  const asPamela = async (what: string, script: string, args: string[]) =>
    run({ as: { user: 'pamela', uid: (await uidOf(host, 'pamela')) ?? -1, home: '/home/pamela' }, what, timeoutSec: 60, argv: ['sh', '-euc', script, what, ...args] });

  return {
    // To the trash. The caller has taken it offline (and backed it up) first.
    async hide(a: AppRecord) {
      if (!a.filesLink) return;
      // only a link: her folder of the same name, if she made one, is hers
      must(await asPamela('app-unlink', 'if [ -L "$1" ]; then rm -f "$1"; fi', [a.filesLink]), 'Her link to its files could not be removed.');
    },

    async unhide(a: AppRecord) {
      if (!a.filesLink) return;
      must(await asPamela('app-link', 'mkdir -p "$(dirname "$2")"; if [ -e "$2" ] && [ ! -L "$2" ]; then echo "something else is there now" >&2; exit 1; fi; ln -sfn "$1" "$2"',
        [a.files, a.filesLink]), `Its files could not be linked into your folders again (${a.filesLink}).`);
    },

    async purge(a: AppRecord, step: (s: string) => void): Promise<void> {
      const p = purgePaths(a);
      step('Taking it off nginx');
      await wp.unplace(a);
      const uid = await uidOf(host, p.user);
      if (uid !== null) {
        step('Removing its containers and database');
        const parts = partsOf(a);
        // not a must: whatever podman leaves, removing its home takes with it
        await run({
          as: { user: p.user, uid, home: p.home }, what: 'app-reset', timeoutSec: 600,
          argv: ['sh', '-uc', 'systemctl --user stop "$@" 2>/dev/null; podman system reset -f', 'app-reset',
            `${a.units.web}.service`, `${a.units.db}.service`, `${parts.backupUnit}.timer`, 'podman-auto-update.timer'],
        });
      }
      step('Removing its user and files');
      must(await run({
        as: 'root', what: 'app-purge', timeoutSec: 600,
        argv: ['sh', '-euc', [
          'u=$1; home=$2; files=$3; link=$4; login=$5',
          'if id -u "$u" >/dev/null 2>&1; then',
          '  uid=$(id -u "$u")',
          '  loginctl disable-linger "$u" || true',
          '  loginctl terminate-user "$u" 2>/dev/null || true',
          '  for i in $(seq 30); do systemctl is-active -q "user@$uid.service" || break; sleep 1; done',
          '  pkill -KILL -U "$uid" 2>/dev/null || true',
          '  sleep 1',
          '  userdel "$u"',
          'fi',
          'if getent group "$u" >/dev/null; then groupdel "$u"; fi',
          'sed -i "/^$u:/d" /etc/subuid /etc/subgid',
          'rm -rf --one-file-system "$home" "$files"',
          'for x in "$files".pre-restore-*; do if [ -e "$x" ]; then rm -rf --one-file-system "$x"; fi; done',
          'if [ -n "$link" ] && [ -L "$link" ]; then rm -f "$link"; fi',
          'if [ -n "$login" ]; then rm -f "$login"; fi',
        ].join('\n'), 'app-purge', p.user, p.home, p.files, p.link ?? '', p.login ?? ''],
      }), 'Its user and files could not all be removed. Ask momolig.');
    },
  };
}
