// pammy-sitefs.service (src/sitefs/main.ts): the website folder helper, with pammy.org's
// website and trash. The unit sets them too (SITEFS_*), and wins.
import { runSiteFs } from '@panel/files/sitefs/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
runSiteFs({
  publicDir: env.SITEFS_PUBLIC ?? PROFILE.website.public,
  trashDir: env.SITEFS_TRASH ?? PROFILE.website.trash,
  placementFile: env.SITEFS_PLACEMENT ?? PROFILE.services.wordpressPlacement,
  purgeDays: Number(env.SITEFS_PURGE_DAYS ?? PROFILE.services.trashDays),
  domain: PROFILE.domain,
  siteName: PROFILE.name,
  folderSubdomains: PROFILE.folderSubdomains,
  maxUpload: PROFILE.uploads.maxBytes,
  now: () => new Date(),
}, env);
