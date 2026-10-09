// pammy-rootfs@<id>.service: the folder helper (@panel/files/sitefs) for one piece of
// software's files (docs/catalog-plan.md step 3): its wp-content/, as the software's
// own user, File Explorer and the editor only. The instance's drop-in (written by the
// software helper, src/apps/rootfs.ts) sets SITEFS_PUBLIC and SITEFS_TRASH, the user
// and the group.
import { runSiteFs } from '@panel/files/sitefs/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
if (!env.SITEFS_PUBLIC || !env.SITEFS_TRASH) {
  console.error('pammy-rootfs: SITEFS_PUBLIC and SITEFS_TRASH must be set (the instance drop-in)');
  process.exit(2);
}
runSiteFs({
  publicDir: env.SITEFS_PUBLIC,
  trashDir: env.SITEFS_TRASH,
  placementFile: null,
  purgeDays: Number(env.SITEFS_PURGE_DAYS ?? PROFILE.services.trashDays),
  domain: PROFILE.domain,
  siteName: PROFILE.name,
  folderSubdomains: false,
  maxUpload: PROFILE.uploads.maxBytes,
  kind: 'software',
  now: () => new Date(),
}, env);
