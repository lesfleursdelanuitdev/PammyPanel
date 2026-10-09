// pammy-thumbs.service (src/thumbs/main.ts): thumbnails of pammy.org's media files.
import { runThumbs } from '@panel/thumbs/thumbs/main';
import { PROFILE } from '../profile.ts';

runThumbs(process.env.THUMBS_PUBLIC ?? PROFILE.website.public);
