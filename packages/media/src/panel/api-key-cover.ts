// A key's media folders (docs/catalog-plan.md step 3c; docs/media-api-plan.md M6).
import type { KeyCover } from '@panel/api-keys/panel/covers';

export const mediaCover: KeyCover = {
  kind: 'media',
  describe: (k) => [k.media === 'all' ? 'every media folder' : k.media ? `media: ${k.media.join(', ')}` : null],
};
