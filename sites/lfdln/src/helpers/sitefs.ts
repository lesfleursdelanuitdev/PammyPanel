// lfdln-sitefs.service: the folder helper (@panel/files/sitefs) for lfdln's site
// folders and their trash (docs/hosts-plan.md H8), as svc-lfdlnsites. Its unit's
// UMask=0027 makes folders 2750 and files 640 (group lfdln-sites, which nginx and
// PHP are in). No WordPress here, so no placement file. File Explorer (phase 8)
// works inside the site folders only. The unit sets these too
// (SITEFS_*), and wins.
import { runSiteFs } from '@panel/files/sitefs/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
runSiteFs({
  publicDir: env.SITEFS_PUBLIC ?? PROFILE.website.public,
  trashDir: env.SITEFS_TRASH ?? PROFILE.website.trash,
  placementFile: null,
  purgeDays: Number(env.SITEFS_PURGE_DAYS ?? PROFILE.services.trashDays),
  domain: PROFILE.domain,
  siteName: PROFILE.name,
  folderSubdomains: PROFILE.folderSubdomains,
  maxUpload: PROFILE.uploads.maxBytes,
  // the top is Hosts' (docs/phase8-plan.md P8-1)
  hostsKeepTop: true,
  now: () => new Date(),
}, env);
