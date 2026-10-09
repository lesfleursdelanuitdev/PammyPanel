// A key's forms (docs/catalog-plan.md step 3c): which forms, and which of their responses.
import type { KeyCover } from '@panel/api-keys/panel/covers';
import { plural } from '@panel/core/util';

export const formsCover: KeyCover = {
  kind: 'forms',
  describe: (k) => [
    k.forms === null ? 'every form' : k.forms.length ? plural(k.forms.length, 'form') : 'no forms',
    k.forms?.length !== 0 ? (k.level === 'all' ? 'all responses' : 'approved responses only') : null,
  ],
};
