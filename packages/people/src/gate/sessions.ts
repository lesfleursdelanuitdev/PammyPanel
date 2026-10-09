// Visitors' sign-in sessions, the rows (gate.sessions; docs/k-a-plan.md K-a4, moved from
// core's gate/store.ts). Checking one is the session cache (session-cache.ts), through
// GateLive. The cookie's name is the kernel's (VISITOR_COOKIE, @panel/core/gate/context).
import { run, type Db } from '@panel/core/pg';
import { hashToken, newToken } from '@panel/core/util';

export const VISITOR_SESSION = 30 * 24 * 3600;

export async function createVisitorSession(db: Db, now: number, visitorId: number, host: string, ip: string | null): Promise<string> {
  const token = newToken();
  await run(db, 'INSERT INTO sessions (token_hash, visitor_id, host, created_at, last_seen_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), visitorId, host, now, now, now + VISITOR_SESSION, ip);
  return token;
}

export const revokeSession = (db: Db, now: number, token: string) =>
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now, hashToken(token));

export const revokeVisitorSessions = (db: Db, now: number, visitorId: number) =>
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE visitor_id = ? AND revoked_at IS NULL', now, visitorId);
