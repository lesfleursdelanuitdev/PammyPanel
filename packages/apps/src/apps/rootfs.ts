// File Explorer's roots for installed software (docs/catalog-plan.md step 3, S3-2):
// one folder helper per install, pammy-rootfs@<id>, running as the install's own user
// on its wp-content/ only. The template units (deploy/pammy-rootfs@.socket/.service)
// come with the panel's installer; this writes each instance's drop-in (who it runs as,
// which folder, its trash, what it may never see), makes its trash folder, and switches
// its socket on, and takes away the instances of software that is deleted or gone.
// Safe to repeat: a drop-in already as it should be is left alone.
import type { AppRecord } from './record.ts';
import type { Runner } from './runner.ts';

export const ROOTFS_DROPINS = '/etc/systemd/system';
export const rootfsSocket = (id: string) => `/run/pammy-rootfs-${id}.sock`;

// Software that has a root: installed (not mid-install or failed) and not deleted.
export const hasRoot = (a: AppRecord) => a.setup === null && a.deleted === null;

// The instance's drop-in. The software's user may read its own config and backups
// (they hold its database password); the helper is made unable to.
export function dropIn(a: AppRecord): string {
  const home = `/var/lib/${a.user}`;
  return [
    `# Written by the software helper (src/apps/rootfs.ts) for ${a.id}; rewritten when it changes.`,
    '[Service]',
    `User=${a.user}`,
    `Group=${a.user}`,
    `Environment=SITEFS_PUBLIC=${a.files}/wp-content`,
    `Environment=SITEFS_TRASH=${home}/files-trash`,
    `InaccessiblePaths=-${a.config} -${a.backups} -${home}/.local -${home}/.config -${a.files}/wp-config.php`,
    '',
  ].join('\n');
}

// argv for the script: per root, id, user, home, then the drop-in's text.
// No ${...} anywhere in it: systemd-run's ExecStart= expands ${NAME} (and an invalid
// name to nothing) before sh sees it -- ${d##*/x} became "" and the sync removed the
// drop-in it had just written (2026-09-28). $name inside a longer word is left alone.
export const SCRIPT = [
  'changed=; want=" "',
  'while [ $# -ge 4 ]; do',
  '  id=$1; user=$2; home=$3; text=$4; shift 4',
  '  want="$want$id "',
  `  d=${ROOTFS_DROPINS}/pammy-rootfs@$id.service.d`,
  '  install -d -m 755 -o root -g root "$d"',
  '  install -d -m 700 -o "$user" -g "$user" "$home/files-trash"',
  '  if [ "$(cat "$d/root.conf" 2>/dev/null)" != "$text" ]; then',
  '    printf "%s\\n" "$text" > "$d/root.conf.new"; chmod 644 "$d/root.conf.new"; mv "$d/root.conf.new" "$d/root.conf"; changed=1',
  '  fi',
  'done',
  `for d in ${ROOTFS_DROPINS}/pammy-rootfs@*.service.d; do`,
  '  [ -d "$d" ] || continue',
  '  id=$(basename "$d" .service.d | sed "s/^pammy-rootfs@//")',
  '  case "$want" in *" $id "*) continue;; esac',
  '  systemctl disable --now -q "pammy-rootfs@$id.socket" 2>/dev/null || true',
  '  systemctl stop "pammy-rootfs@$id.service" 2>/dev/null || true',
  '  rm -rf "$d"; changed=1; echo "removed $id"',
  'done',
  '[ -z "$changed" ] || systemctl daemon-reload',
  'for id in $want; do',
  '  systemctl enable --now -q "pammy-rootfs@$id.socket"',
  '  [ -z "$changed" ] || systemctl try-restart "pammy-rootfs@$id.service"',
  '  echo "root $id"',
  'done',
].join('\n');

export function rootfs(run: Runner) {
  return {
    // Makes the instances match the software there is; says which roots there are.
    async sync(apps: AppRecord[]): Promise<{ roots: string[]; removed: string[] }> {
      const args = apps.filter(hasRoot).flatMap((a) => [a.id, a.user, `/var/lib/${a.user}`, dropIn(a).trimEnd()]);
      const r = await run({ as: 'root', what: 'rootfs-sync', timeoutSec: 120, argv: ['sh', '-euc', SCRIPT, 'rootfs-sync', ...args] });
      if (r.code !== 0) throw new Error(`The file helpers for installed software could not be set up: ${(r.stderr || r.stdout).trim().slice(-400)}`);
      const lines = r.stdout.split('\n');
      return {
        roots: lines.filter((l) => l.startsWith('root ')).map((l) => l.slice(5)),
        removed: lines.filter((l) => l.startsWith('removed ')).map((l) => l.slice(8)),
      };
    },
  };
}
