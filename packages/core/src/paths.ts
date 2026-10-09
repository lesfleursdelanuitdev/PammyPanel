// Where the panel's own folders are (docs/packaging-plan.md step 2): public/,
// help/, tutorials/, db/, public-gate/ and apps/ sit at the top of the release,
// beside the packages. Only this file knows where it is itself, so a file that
// moves between packages can't point at the wrong folder.
import { join } from 'node:path';

export const APP_ROOT = join(import.meta.dirname, '..', '..', '..');   // packages/core/src/
export const appPath = (...parts: string[]) => join(APP_ROOT, ...parts);
