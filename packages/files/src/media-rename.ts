// photos/ -> images/ in every media folder (docs/media-plan.md D1), run once by
// the install through "pammy-panel media-images". The helper renames the folders
// (as pamela) and the panel logs it. Who added each file is on its media record
// now, and the next sync finds the renamed files.
// Safe to run again: with nothing left called photos/, it changes nothing.
import { COMMAND_LINE, logActivity } from '@panel/core/accounts';
import type { Db } from '@panel/core/pg';
import { callSiteFs } from './sitefs/client.ts';

export type PhotosRenamed = { renamed: string[]; merged: string[]; left: string[] };

export async function renamePhotos(db: Db, sitefsSocket: string, now: number): Promise<PhotosRenamed> {
  const r = await callSiteFs<PhotosRenamed>(sitefsSocket, { op: 'media-rename-photos', actor: 'install' }, 120_000);
  if (r.renamed.length || r.merged.length) {
    await logActivity(db, now, COMMAND_LINE, 'media-photos-renamed', [...r.renamed, ...r.merged].map((m) => m.replace(/\/?media$/, '') || 'the main site').join(', '),
      r.left.length ? `${r.left.length} left in photos/ because the name was taken in images/` : null);
  }
  return r;
}
