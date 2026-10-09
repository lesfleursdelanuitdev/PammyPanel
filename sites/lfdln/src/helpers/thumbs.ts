// lfdln-thumbs.service (@panel/thumbs): thumbnails of the files in lfdln's site folders
// (docs/phase8-plan.md step 8-1). The unit sets THUMBS_PUBLIC too, and wins.
import { runThumbs } from '@panel/thumbs/thumbs/main';
import { PROFILE } from '../profile.ts';

runThumbs(process.env.THUMBS_PUBLIC ?? PROFILE.website.public);
