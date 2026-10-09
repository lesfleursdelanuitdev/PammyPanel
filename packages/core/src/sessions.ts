import { AccountError, personOf, type Person, type UserRow } from './accounts.ts';
import { CEREMONY_TTL, SESSION_IDLE, SESSION_MAX } from './config.ts';
import { one, run, type Db } from './pg.ts';
import { hashToken, looksLikeToken, newToken } from './util.ts';

// __Host- prefix: the browser only accepts it with Secure, Path=/ and no
// Domain, so no other *.pammy.org page (hers, WordPress) can set or read it.
// SameSite=Lax, not Strict: Strict drops the cookie when you arrive from a link
// in an email or chat, so you'd see the sign-in page while signed in. Lax still
// withholds it from cross-site POSTs, and every change here is a POST that must
// also carry this exact Origin (security.ts), so Lax gives up nothing.
export const SESSION_COOKIE = '__Host-pammy_panel';

export type SessionRow = {
  id: number;
  token_hash: string;
  user_id: number;
  passkey_id: number | null;
  created_at: number;
  auth_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  ip: string | null;
  user_agent: string | null;
};

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    // spaces before a name (after the ";") are the separator's; a name with spaces after it
    // isn't that name (docs/s1-plan.md S1e, review F1)
    if (i > 0 && part.slice(0, i).replace(/^[ \t]+/, '') === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function createSession(db: Db, now: number, userId: number, passkeyId: number, ip: string | null, userAgent: string | null): Promise<string> {
  const token = newToken();
  await run(db, `INSERT INTO sessions (token_hash, user_id, passkey_id, created_at, auth_at, last_seen_at, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    hashToken(token), userId, passkeyId, now, now, now, now + SESSION_MAX, ip, userAgent?.slice(0, 300) ?? null);
  return token;
}

export type Authed = { session: SessionRow; user: Person };

// Checked on every request against the database, so switching an account off,
// removing a passkey or signing a session out takes effect immediately.
export async function lookupSession(db: Db, now: number, token: string | null): Promise<Authed | null> {
  if (!looksLikeToken(token)) return null;
  const session = await one<SessionRow>(db, 'SELECT * FROM sessions WHERE token_hash = ?', hashToken(token));
  if (!session || session.revoked_at || session.expires_at <= now || session.last_seen_at + SESSION_IDLE <= now) return null;
  const user = await one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user || !user.active) return null;
  if (now - session.last_seen_at >= 60) {
    await run(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, session.id);
    session.last_seen_at = now;
  }
  // with what they may do, read afresh: a change works on their very next request
  return { session, user: await personOf(db, user) };
}

// --- WebAuthn ceremonies: one challenge, one use, five minutes ----------------

export type CeremonyKind = 'login' | 'invite' | 'add-passkey' | 'reauth';
export type CeremonyRow = {
  kind: CeremonyKind;
  challenge: string;
  user_id: number | null;
  invite_id: number | null;
  session_id: number | null;
  expires_at: number;
};

export async function startCeremony(db: Db, now: number, kind: CeremonyKind, challenge: string,
                                    ids: { userId?: number; inviteId?: number; sessionId?: number } = {}): Promise<string> {
  await run(db, 'DELETE FROM ceremonies WHERE expires_at <= ?', now);
  // Anyone can start a sign-in; cap the pending ones so a flood can't grow the database.
  const pending = (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM ceremonies'))!.n;
  if (pending >= 5000) throw new AccountError('The panel is busy. Please try again in a few minutes.', 503);
  const token = newToken();
  await run(db, 'INSERT INTO ceremonies (id_hash, kind, challenge, user_id, invite_id, session_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), kind, challenge, ids.userId ?? null, ids.inviteId ?? null, ids.sessionId ?? null, now + CEREMONY_TTL);
  return token;
}

// Deleted as it's read, in one statement: a failed attempt can't be retried with
// the same challenge, and two requests racing with the same one can't both have it.
export async function takeCeremony(db: Db, now: number, token: unknown, kind: CeremonyKind): Promise<CeremonyRow | null> {
  if (!looksLikeToken(token)) return null;
  const row = await one<CeremonyRow>(db, 'DELETE FROM ceremonies WHERE id_hash = ? RETURNING kind, challenge, user_id, invite_id, session_id, expires_at', hashToken(token));
  if (!row) return null;
  return row.kind === kind && row.expires_at > now ? row : null;
}
