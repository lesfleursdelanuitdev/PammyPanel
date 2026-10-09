// Is this their password (docs/k-a-plan.md K-a4, moved from core's gate/store.ts):
// signing in with a username or an email address, and the dummy hash that makes a
// wrong username take as long as a wrong password.
import { one, type Db } from '@panel/core/pg';
import { newToken } from '@panel/core/util';
import { hashPassword, verifyPassword } from '@panel/core/security';
import type { Visitor } from '@panel/core/gate/types';
import { cleanEmail, cleanVisitorName } from './accounts-store.ts';

// A fixed hash to check against when the username doesn't exist, so a wrong
// username takes as long as a wrong password.
let dummyHash: Promise<string> | null = null;

// Signing in with a username or an email address (A8): the username first (an
// owner may have made one that looks like an address), then the account's email.
export async function visitorByLogin(db: Db, login: unknown): Promise<Visitor | undefined> {
  const u = cleanVisitorName(login);
  const byName = u ? await one<Visitor>(db, 'SELECT * FROM visitors WHERE username = ?', u) : undefined;
  if (byName) return byName;
  const e = cleanEmail(login);
  return e ? one<Visitor>(db, 'SELECT * FROM visitors WHERE email = ?', e) : undefined;
}

// Whether this is their password; a wrong username takes as long as a wrong password.
export async function passwordMatches(v: Visitor | undefined, password: unknown): Promise<boolean> {
  dummyHash ??= hashPassword(newToken());
  const pw = typeof password === 'string' && password.length <= 200 ? password : '';
  return verifyPassword(pw, v?.password_hash || await dummyHash);
}

export async function checkCredentials(db: Db, username: unknown, password: unknown): Promise<Visitor | null> {
  const r = await signInCheck(db, username, password);
  return r && 'visitor' in r ? r.visitor : null;
}

// The same, saying when the password was right but the account's address isn't
// confirmed yet (A4: it works once it is). Only someone who knows the password learns that.
export async function signInCheck(db: Db, username: unknown, password: unknown): Promise<{ visitor: Visitor } | { unconfirmed: Visitor } | null> {
  const v = await visitorByLogin(db, username);
  const ok = await passwordMatches(v, password);
  if (!ok || !v || !v.active || !v.password_hash) return null;
  return v.registered && !v.email_confirmed_at ? { unconfirmed: v } : { visitor: v };
}
