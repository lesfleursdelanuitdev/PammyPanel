// Account operations shared by the web API and the pammy-panel command line,
// so both enforce the same rules and write the same activity entries.
import { randomBytes } from 'node:crypto';
import { INVITE_TTL } from './config.ts';
import { all, one, run, tx, type Db } from './pg.ts';
import { isRight, PLACE_RIGHTS, RIGHTS, SOFTWARE_ONLY_RIGHTS, type Right } from './panel/rights.ts';
import { cleanDisplayName, hashToken, newToken, USERNAME_RE } from './util.ts';

// The rows of schema `panel` (db/migrations/0001-panel.sql) this code works with.
export type UserRow = {
  id: number;
  username: string;
  display_name: string;
  role: 'manager' | 'member';
  active: number;
  webauthn_user_id: string;
  created_at: number;
};

// A person as the panel decides about them: the account, the parts of the panel
// they have and the places they are kept to (docs/permissions-plan.md R4-R5).
export type Person = UserRow & { rights: Right[]; places: string[] };

export async function personOf(db: Db, user: UserRow): Promise<Person> {
  // in the list's own order; a name no part of the panel has is no right at all
  const had = new Set((await all<{ name: string }>(db, 'SELECT name FROM user_rights WHERE user_id = ?', user.id)).map((r) => r.name));
  const rights = RIGHTS.filter((r) => had.has(r));
  return { ...user, rights, places: await placesOf(db, user.id) };
}
export const placesOf = async (db: Db, userId: number) =>
  (await all<{ place: string }>(db, 'SELECT place FROM user_places WHERE user_id = ? ORDER BY place COLLATE "C"', userId)).map((r) => r.place);

export type PasskeyRow = {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

export type Actor = { id: number | null; label: string; ip?: string | null };
export const COMMAND_LINE: Actor = { id: null, label: 'server command line' };

export class AccountError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function logActivity(db: Db, now: number, actor: Actor, action: string, target?: string | null, detail?: string | null) {
  await run(db, 'INSERT INTO activity (at, actor_id, actor_label, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now, actor.id, actor.label, action, target ?? null, detail ?? null, actor.ip ?? null);
}

export const getUser = (db: Db, id: number) => one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);

export const getUserByName = (db: Db, username: string) => one<UserRow>(db, 'SELECT * FROM users WHERE username = ?', username);

export const listPasskeys = (db: Db, userId: number) =>
  all<PasskeyRow>(db, 'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);

export async function createUser(db: Db, now: number, actor: Actor, username: unknown, displayName: unknown, role: 'manager' | 'member' = 'member', access: Access = NO_ACCESS): Promise<UserRow> {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new AccountError('Usernames are 2-32 characters: lowercase letters, digits and hyphens, starting with a letter.');
  }
  const name = cleanDisplayName(displayName);
  if (!name) throw new AccountError('Please give a name (1-60 characters).');
  return tx(db, async (q) => {
    if (await getUserByName(q, username)) throw new AccountError(`There is already an account called ${username}.`, 409);
    const u = (await one<UserRow>(q, 'INSERT INTO users (username, display_name, role, active, webauthn_user_id, created_at) VALUES (?, ?, ?, 1, ?, ?) RETURNING *',
      username, name, role, randomBytes(32).toString('base64url'), now))!;
    await logActivity(q, now, actor, 'user-created', username, role === 'manager' ? 'account manager' : null);
    // what it may use, chosen with it on the Accounts page (R6); none unless chosen
    if (role === 'member' && (access.rights.length || access.places.length)) await setAccess(q, now, actor, u, access);
    return u;
  });
}

// One live invite per account: making a new one cancels the old link.
export async function createInvite(db: Db, now: number, actor: Actor, user: UserRow): Promise<{ token: string; expiresAt: number }> {
  if (!user.active) throw new AccountError(`${user.username} is switched off. Switch the account back on first.`, 409);
  const token = newToken();
  const expiresAt = now + INVITE_TTL;
  await tx(db, async (q) => {
    await run(q, 'UPDATE invites SET cancelled_at = ? WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL', now, user.id);
    await run(q, 'INSERT INTO invites (token_hash, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      hashToken(token), user.id, actor.id, now, expiresAt);
    await logActivity(q, now, actor, 'invite-created', user.username, 'passkey setup link, valid 24 hours');
  });
  return { token, expiresAt };
}

export type InviteRow = { id: number; user_id: number; expires_at: number; used_at: number | null; cancelled_at: number | null };

export async function findLiveInvite(db: Db, now: number, token: string): Promise<{ invite: InviteRow; user: UserRow } | null> {
  const invite = await one<InviteRow>(db, 'SELECT id, user_id, expires_at, used_at, cancelled_at FROM invites WHERE token_hash = ?', hashToken(token));
  if (!invite || invite.used_at || invite.cancelled_at || invite.expires_at <= now) return null;
  const user = await getUser(db, invite.user_id);
  if (!user || !user.active) return null;
  return { invite, user };
}

export async function cancelInvites(db: Db, now: number, actor: Actor, user: UserRow): Promise<number> {
  return tx(db, async (q) => {
    const n = await run(q, 'UPDATE invites SET cancelled_at = ? WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?', now, user.id, now);
    if (n) await logActivity(q, now, actor, 'invite-cancelled', user.username);
    return n;
  });
}

export const revokeSessions = (db: Db, now: number, userId: number, exceptSessionId: number | null = null) =>
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS DISTINCT FROM ?', now, userId, exceptSessionId);

const activeManagers = async (db: Db) =>
  (await one<{ n: number }>(db, "SELECT count(*) AS n FROM users WHERE role = 'manager' AND active = 1"))!.n;

// "The last account manager stays" is checked inside the change: two managers
// switching each other off at the same moment can't both succeed.
export async function setActive(db: Db, now: number, actor: Actor, user: UserRow, active: boolean) {
  if (!active && actor.id === user.id) throw new AccountError("You can't switch off your own account.", 409);
  await tx(db, async (q) => {
    if (!active && user.role === 'manager' && await activeManagers(q) <= 1) {
      throw new AccountError('This is the only account manager, so it has to stay on.', 409);
    }
    await run(q, 'UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, user.id);
    if (!active) {
      await revokeSessions(q, now, user.id);
      await run(q, 'UPDATE invites SET cancelled_at = ? WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL', now, user.id);
    }
    await logActivity(q, now, actor, active ? 'user-enabled' : 'user-disabled', user.username, active ? null : 'signed out everywhere');
  });
}

// Account managers (admins: momolig and Pamela): only ever made on the server's
// command line, never in the panel. The last active manager can't stop being one.
// Either way the account starts over with no rights written: an account manager
// needs none, and an ordinary account is given its parts on the Accounts page.
export async function setRole(db: Db, now: number, actor: Actor, user: UserRow, role: unknown) {
  if (role !== 'manager' && role !== 'member') throw new AccountError("The role is either 'manager' or 'member'.");
  if (user.role === role) return;
  await tx(db, async (q) => {
    const places = await placesOf(q, user.id);
    if (role === 'manager' && places.length) throw new AccountError(`${user.username} only sees ${places.map((p) => p.slice(1)).join(', ')}. Let it see everything first: an account manager sees the whole panel.`, 409);
    if (role === 'member' && user.active && await activeManagers(q) <= 1) {
      throw new AccountError('This is the only account manager, so it has to stay one.', 409);
    }
    await run(q, 'UPDATE users SET role = ? WHERE id = ?', role, user.id);
    await run(q, 'DELETE FROM user_rights WHERE user_id = ?', user.id);
    await logActivity(q, now, actor, 'user-role-changed', user.username, role === 'manager' ? 'now an account manager' : 'no longer an account manager');
  });
}

// What an ordinary account may use (docs/permissions-plan.md R4-R6): its rights,
// on or off, and the places it is kept to (none: the whole site). An account
// manager has every part and no places, so nothing is written for one. A person
// with places may only have the parts that can tell a thing's place
// (PLACE_RIGHTS). Nobody is signed out: rights and places are read with the
// session on every request, so the change works on their very next one.
//
// Places are checked by the caller against what is there (the panel's route
// asks the folder helper); here only their shape.
export const PLACE_RE = /^\/[^/\\\x00-\x1f\x7f]{1,200}$|^software:[a-z0-9][a-z0-9-]{0,39}$/;
export type Access = { rights: Right[]; places: string[] };
export const NO_ACCESS: Access = { rights: [], places: [] };

export function cleanAccess(rights: unknown, places: unknown): Access {
  if (!Array.isArray(rights) || !rights.every(isRight)) throw new AccountError("That isn't a part of the panel.");
  if (!Array.isArray(places) || !places.every((p) => typeof p === 'string' && PLACE_RE.test(p) && !p.startsWith('/.'))) {
    throw new AccountError("That isn't one of the website's folders or installed software.");
  }
  const had = new Set(rights);
  const clean = { rights: RIGHTS.filter((r) => had.has(r)), places: [...new Set(places as string[])].sort() };
  if (clean.places.length > 20) throw new AccountError('That is more places than one account needs (20 at most).');
  const wide = clean.rights.filter((r) => !PLACE_RIGHTS.includes(r));
  if (clean.places.length && wide.length) {
    throw new AccountError(`Someone kept to places can't have ${wide.join(', ')}: ${wide.length === 1 ? 'that part' : 'those parts'} can't tell which place a thing is in yet.`, 409);
  }
  // kept only to installed software (docs/catalog-plan.md step 3b, QP1): File Explorer only
  const notFiles = clean.rights.filter((r) => !SOFTWARE_ONLY_RIGHTS.includes(r));
  if (clean.places.length && clean.places.every((p) => !p.startsWith('/')) && notFiles.length) {
    throw new AccountError(`Someone kept only to installed software can have File Explorer, not ${notFiles.join(', ')}: ${notFiles.length === 1 ? 'that part is' : 'those parts are'} about the website.`, 409);
  }
  return clean;
}

export async function setAccess(db: Db, now: number, actor: Actor, user: UserRow, access: Access): Promise<Access> {
  if (user.role === 'manager') throw new AccountError('An account manager has every part of the panel and the whole site. Nothing to choose.', 409);
  return tx(db, async (q) => {
    const before = await personOf(q, user);
    const on = access.rights.filter((r) => !before.rights.includes(r));
    const off = before.rights.filter((r) => !access.rights.includes(r));
    if (on.length || off.length) {
      await run(q, 'DELETE FROM user_rights WHERE user_id = ?', user.id);
      for (const r of access.rights) await run(q, 'INSERT INTO user_rights (user_id, name) VALUES (?, ?)', user.id, r);
      await logActivity(q, now, actor, 'user-rights-changed', user.username, [...on.map((r) => `${r}: on`), ...off.map((r) => `${r}: off`)].join(', '));
    }
    if (access.places.join('\n') !== before.places.join('\n')) {
      await run(q, 'DELETE FROM user_places WHERE user_id = ?', user.id);
      for (const p of access.places) await run(q, 'INSERT INTO user_places (user_id, place) VALUES (?, ?)', user.id, p);
      await logActivity(q, now, actor, 'user-places-changed', user.username, access.places.length ? `places: ${access.places.join(', ')}` : 'places: none (the whole site)');
    }
    return access;
  });
}

export async function signOutEverywhere(db: Db, now: number, actor: Actor, user: UserRow): Promise<number> {
  return tx(db, async (q) => {
    const n = await revokeSessions(q, now, user.id);
    await logActivity(q, now, actor, 'sessions-revoked', user.username, `${n} session${n === 1 ? '' : 's'}`);
    return n;
  });
}

// The last passkey can only go through the account manager (who can send a new
// setup link); an account holder removing their own last one would lock them out.
export async function deletePasskey(db: Db, now: number, actor: Actor, user: UserRow, passkeyId: number, allowLast: boolean) {
  await tx(db, async (q) => {
    const pk = await one<PasskeyRow>(q, 'SELECT * FROM passkeys WHERE id = ? AND user_id = ?', passkeyId, user.id);
    if (!pk) throw new AccountError('That passkey no longer exists.', 404);
    if (!allowLast && (await listPasskeys(q, user.id)).length <= 1) {
      throw new AccountError("This is your only passkey. Add another one first, so you don't lock yourself out.", 409);
    }
    await run(q, 'DELETE FROM passkeys WHERE id = ?', pk.id);   // cascades to its sessions
    await logActivity(q, now, actor, 'passkey-removed', user.username, pk.name);
  });
}
