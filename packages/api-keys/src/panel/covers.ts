// What a key can cover (docs/catalog-plan.md step 3c, K1): each module that owns
// something a key reads (forms, media folders) says how a key's cover of it reads
// in Activity. The site hands the routes the covers of the modules it has on.
import type { ApiKey } from '../gate/forms/api-keys.ts';

export type KeyCover = {
  kind: 'forms' | 'media';
  // the parts of the Activity line about this kind, in order (null: left out)
  describe: (k: ApiKey) => (string | null)[];
};
