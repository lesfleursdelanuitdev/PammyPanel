// Which visitor passwords are allowed (docs/accounts-plan.md A7; moved from core's
// gate/passwords.ts in docs/k-a-plan.md K-a4). The hashing itself is the kernel's
// (@panel/core/security: hashPassword, verifyPassword).
import { readFileSync } from 'node:fs';

// A7: the common passwords of 10 characters or more (common-passwords.txt, bundled:
// nothing is looked up anywhere else), refused whatever their case. Read once, when
// first needed.
let common: ReadonlySet<string> | null = null;
export function isCommonPassword(password: string): boolean {
  common ??= new Set(readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8')
    .split('\n').filter((l) => l !== '' && !l.startsWith('# ')));
  return common.has(password.normalize('NFC').toLowerCase());
}
