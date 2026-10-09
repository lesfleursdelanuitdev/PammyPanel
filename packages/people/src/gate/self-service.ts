// Accounts people make and look after themselves (docs/accounts-plan.md step 4;
// docs/k-a-plan.md K-a4, moved from core's gate/store.ts). Each is behind a switch
// (visitor settings), which the gate's routes check before calling these.
import { one, run, tx, type Db } from '@panel/core/pg';
import { hashPassword } from '@panel/core/security';
import { GateError } from '@panel/core/gate/ops';
import type { Visitor } from '@panel/core/gate/types';
import { cleanEmail, cleanVisitorName, passwordProblem } from './accounts-store.ts';
import { cancelLinks, liveLink, makeEmailedLink } from './links.ts';
import type { ResetRequests } from './reset-requests.ts';
import { createVisitorSession, revokeVisitorSessions } from './sessions.ts';
import { passwordMatches } from './sign-in-check.ts';
import { deleteVisitor, needVisitor } from './visitors.ts';

// Registering (Q3: an account, and no role anywhere). made: a new account, not
// confirmed, and its confirmation link; taken: the address already has an account
// (the person is told the same either way; that address gets a note instead). A
// username that is taken is said on the form: it's the public sign-in name.
export type Registered = { made: Visitor; token: string } | { taken: Visitor };
export async function registerVisitor(db: Db, now: number, form: { username: unknown; email: unknown; password: unknown }): Promise<Registered> {
  const u = cleanVisitorName(form.username);
  if (!u) throw new GateError('invalid', 'Usernames are 2-64 characters: letters, digits and . _ @ + -', 'username');
  const e = cleanEmail(form.email);
  if (!e) throw new GateError('invalid', "That doesn't look like an email address.", 'email');
  const problem = passwordProblem(form.password);
  if (problem) throw new GateError('invalid', problem, 'password');
  const nameTaken = () => new GateError('exists', `The username ${u} is taken. Please choose another.`, 'username');
  if (await one(db, 'SELECT 1 FROM visitors WHERE username = ?', u)) throw nameTaken();
  const holder = await one<Visitor>(db, 'SELECT * FROM visitors WHERE email = ?', e);
  if (holder) return { taken: holder };
  const hash = await hashPassword(form.password as string);
  // someone may have taken the name or the address while the password was hashed
  const v = await one<Visitor>(db, `INSERT INTO visitors (username, name, password_hash, active, created_at, password_changed_at, contact, email, registered)
    VALUES (?, '', ?, 1, ?, ?, '', ?, true) ON CONFLICT DO NOTHING RETURNING *`, u, hash, now, now, e);
  if (!v) {
    const h = await one<Visitor>(db, 'SELECT * FROM visitors WHERE email = ?', e);
    if (h) return { taken: h };
    throw nameTaken();
  }
  return { made: v, token: await makeEmailedLink(db, now, v.id, 'confirm') };
}

// The confirmation email couldn't be sent: the account goes again, so they can try later.
export const forgetRegistration = (db: Db, id: number) =>
  run(db, 'DELETE FROM visitors WHERE id = ? AND registered AND email_confirmed_at IS NULL', id);

// Q2: accounts nobody confirmed are removed after 48 hours (housekeeping).
export const UNCONFIRMED_KEPT = 48 * 3600;

// A confirmation link (a new account's, or a new address's): the address is
// confirmed, and they're signed in on this hostname. email-change: the account
// now uses the new address; oldEmail is where the note that it changed goes.
export async function useConfirmLink(db: Db, now: number, token: unknown, host: string, ip: string | null):
  Promise<{ visitor: Visitor; purpose: 'confirm' | 'email-change'; oldEmail: string | null; session: string } | null> {
  return tx(db, async (q) => {
    const found = await liveLink(q, now, token, ['confirm', 'email-change']);
    if (!found) return null;
    const { link, visitor } = found;
    // another tab may have used it meanwhile
    if (!await run(q, 'UPDATE links SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL', now, link.id)) return null;
    let oldEmail: string | null = null;
    if (link.purpose === 'email-change') {
      if (await one(q, 'SELECT 1 FROM visitors WHERE email = ? AND id <> ?', link.new_email, visitor.id)) {
        throw new GateError('exists', 'That address has been given to another account since the link was sent.');
      }
      oldEmail = visitor.email;
      await run(q, 'UPDATE visitors SET email = ?, email_confirmed_at = ? WHERE id = ?', link.new_email, now, visitor.id);
    } else {
      await run(q, 'UPDATE visitors SET email_confirmed_at = coalesce(email_confirmed_at, ?) WHERE id = ? AND email IS NOT NULL', now, visitor.id);
    }
    return {
      visitor: await needVisitor(q, visitor.id), purpose: link.purpose as 'confirm' | 'email-change', oldEmail,
      session: await createVisitorSession(q, now, visitor.id, host, ip),
    };
  });
}

// Choosing a new password with an emailed reset link (A6: 1 hour, once): every
// session and other link ends, open "forgot password" requests close (through
// requests' socket, KA-Q2), the address counts as confirmed (the link reached it),
// and they're signed in here.
export async function useResetLink(db: Db, now: number, token: unknown, password: unknown, host: string, ip: string | null, resets: ResetRequests):
  Promise<{ visitor: Visitor; session: string } | null> {
  if (!await liveLink(db, now, token, ['reset'])) return null;
  const problem = passwordProblem(password);
  if (problem) throw new GateError('invalid', problem, 'password');
  const hash = await hashPassword(password as string);
  return tx(db, async (q) => {
    const found = await liveLink(q, now, token, ['reset']);
    if (!found) return null;
    const { link, visitor } = found;
    if (!await run(q, 'UPDATE links SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL', now, link.id)) return null;
    await cancelLinks(q, now, visitor.id);
    await run(q, 'UPDATE visitors SET password_hash = ?, password_changed_at = ?, email_confirmed_at = coalesce(email_confirmed_at, ?) WHERE id = ?', hash, now, now, visitor.id);
    await revokeVisitorSessions(q, now, visitor.id);
    await resets.close(q, visitor.id, now);
    return { visitor: await needVisitor(q, visitor.id), session: await createVisitorSession(q, now, visitor.id, host, ip) };
  });
}

// Changing their own password (needs the current one): every other session ends,
// and so does any reset link still open. This one stays signed in.
export async function changeOwnPassword(db: Db, now: number, visitorId: number, sessionId: number, current: unknown, password: unknown): Promise<Visitor> {
  const v = await needVisitor(db, visitorId);
  if (!v.password_hash || !await passwordMatches(v, current)) throw new GateError('invalid', "That isn't your current password.", 'current');
  const problem = passwordProblem(password);
  if (problem) throw new GateError('invalid', problem, 'password');
  const hash = await hashPassword(password as string);
  return tx(db, async (q) => {
    await run(q, 'UPDATE visitors SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, now, v.id);
    await run(q, 'UPDATE sessions SET revoked_at = ? WHERE visitor_id = ? AND revoked_at IS NULL AND id <> ?', now, v.id, sessionId);
    await run(q, "UPDATE links SET cancelled_at = ? WHERE visitor_id = ? AND purpose = 'reset' AND used_at IS NULL AND cancelled_at IS NULL", now, v.id);
    return needVisitor(q, v.id);
  });
}

// A new address for their account (needs their password): a link to the new
// address, which changes it once used. null: another account has that address
// (they're told the same as when it worked, so the form can't find out whose it is).
export async function startEmailChange(db: Db, now: number, visitorId: number, password: unknown, email: unknown): Promise<{ token: string; to: string } | null> {
  const v = await needVisitor(db, visitorId);
  if (!v.password_hash || !await passwordMatches(v, password)) throw new GateError('invalid', "That isn't your password.", 'password');
  const e = cleanEmail(email);
  if (!e) throw new GateError('invalid', "That doesn't look like an email address.", 'email');
  if (e === v.email) throw new GateError('invalid', 'That is the address your account uses already.', 'email');
  if (await one(db, 'SELECT 1 FROM visitors WHERE email = ?', e)) return null;
  return { token: await makeEmailedLink(db, now, v.id, 'email-change', e), to: e };
}

// Deleting their own account (A9, needs their password): the account, its
// sessions, roles and links go; the events keep only the username.
export async function deleteOwnAccount(db: Db, visitorId: number, password: unknown): Promise<Visitor> {
  const v = await needVisitor(db, visitorId);
  if (!v.password_hash || !await passwordMatches(v, password)) throw new GateError('invalid', "That isn't your password.", 'password');
  return deleteVisitor(db, v.id);
}
