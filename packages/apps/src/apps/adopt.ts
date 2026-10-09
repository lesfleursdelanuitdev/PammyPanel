// Adopting the WordPress at blog.pammy.org (docs/apps-plan.md G3, A1): the one
// momolig installed by hand with ~/pamela-setup/wordpress/install-wordpress.sh
// becomes the first software the panel looks after.
//
// It ONLY writes the helper's record. No file, unit, container, database or
// nginx line of WordPress is touched, read-write or otherwise: A1 is "don't
// reinstall it, and don't change it to adopt it". Run once by the installer
// (adopt-cli.ts); never a request on the socket, so the panel can't ask for it.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Host } from './host.ts';
import { readText, uidOf } from './host.ts';
import { addressOf, parsePlacement } from './placement.ts';
import { readState, writeState, type AppRecord } from './record.ts';

// Where ~/pamela-setup/wordpress/lib.sh put everything (SVC, WP_DIR, WP_LINK,
// WP_CONF, NGX, PORT), and where rootless podman keeps the pammywp-db volume.
export const ADOPTED_WORDPRESS = {
  id: 'blog',
  kind: 'wordpress',
  layout: 'adopted-wordpress',
  user: 'svc-pammywp',
  units: { web: 'pammywp-web', db: 'pammywp-db' },
  port: 3043,
  files: '/srv/pamela-wordpress',
  filesLink: '/pamela/wordpress',
  config: '/var/lib/svc-pammywp/config',
  backups: '/var/lib/svc-pammywp/backups',
  dbVolume: '/var/lib/svc-pammywp/.local/share/containers/storage/volumes/pammywp-db/_data',
  placementFile: '/etc/nginx/pammy-wordpress/placement',
  loginFile: '/home/pamela/wordpress-login.txt',
  offline: null,
  setup: null,
  deleted: null,
} as const;

export type AdoptResult =
  | { done: 'adopted'; record: AppRecord; address: string | null }
  | { done: 'already'; record: AppRecord }
  | { done: 'nothing'; why: string };

export async function adoptWordPress(h: Pick<Host, 'root' | 'domain'>, stateDir: string, now: number, dryRun = false): Promise<AdoptResult> {
  const w = ADOPTED_WORDPRESS;
  const state = readState(stateDir);
  const had = state.apps.find((a) => a.user === w.user);
  if (had) return { done: 'already', record: had };
  if (state.apps.some((a) => a.id === w.id)) throw new Error(`the record already has an app called "${w.id}" that isn't ${w.user}'s -- not adopting over it`);

  // It has to BE the WordPress the scripts made, or there is nothing to adopt.
  const host = { ...h, nginx: { host: '', port: 0 }, probe: async () => ({ status: null, ms: 0, error: null }), now: () => now };
  if (await uidOf(host, w.user) === null) return { done: 'nothing', why: `no ${w.user} user (WordPress was never installed here)` };
  const placement = parsePlacement(await readText(host, w.placementFile));
  if (!placement) return { done: 'nothing', why: `${w.placementFile} is missing or not a placement line` };
  if (await readText(host, `${w.files}/wp-includes/version.php`) === null) return { done: 'nothing', why: `no WordPress in ${w.files}` };

  // When it was installed: its user's home was made by install-wordpress.sh.
  // The birth time where the filesystem keeps one, otherwise its linger file.
  let installedAt = now;
  for (const p of [`/var/lib/${w.user}`, `/var/lib/systemd/linger/${w.user}`]) {
    try {
      const s = await stat(join(h.root, p));
      const t = Math.floor((s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs) / 1000);
      if (t > 0) { installedAt = t; break; }
    } catch { /* try the next */ }
  }

  const record: AppRecord = { ...w, units: { ...w.units }, installedAt, adoptedAt: now };
  if (!dryRun) writeState(stateDir, { version: 1, apps: [...state.apps, record] });
  return { done: 'adopted', record, address: addressOf(placement, h.domain) };
}
