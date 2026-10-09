// What an account's names and password may be (docs/k-a-plan.md K-a4, moved from core's
// gate/store.ts): usernames, email addresses (A4) and the password rules (A7).
import { isCommonPassword } from './passwords.ts';

// Visitor usernames: what people type to sign in. An email address works too.
// (Still core's until requests' store moves, K-a5: core's addResetRequest cleans the
// username it is given with it, and core can't import people. The same objects.)
export { cleanVisitorName, VISITOR_NAME_RE } from '@panel/core/gate/store';

// A7: at least 10 characters, and not one of the common ones. No other rules.
export function passwordProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'Please type a password.';
  if ([...v].length < 10) return 'Passwords need at least 10 characters.';
  if (v.length > 200) return 'Passwords can be at most 200 characters.';
  if (isCommonPassword(v)) return 'That password is one of the most common ones, so it is easy to guess. Please choose another.';
  return null;
}

// An account's email address (docs/accounts-plan.md A4): one plain address,
// lower-cased. The same shape the mail service sends to (packages/mail's
// ADDRESS_RE), so an address kept here can always be mailed.
export const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}
