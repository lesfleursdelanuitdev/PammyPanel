// Visitor sessions the gate has checked lately (docs/k-a-plan.md K-a2; moved from core's
// live.ts): who is signed in, with their role and privileges in every area
// (docs/roles-plan.md), kept for 60 s. When Postgres can't be reached, a session checked
// in the last 15 minutes still counts: nothing can revoke one while Postgres is down, and
// every revocation made before it went down has already been applied here.
//
// Review P2 (K-a3): lookups of one session that isn't kept share one load (a gallery of 40
// protected images asks 40 times at once), and a change to one visitor forgets only that
// visitor's sessions. A load still in flight when its token, its visitor or everything is
// forgotten is answered but not kept, so nothing from before a change outlives it.
//
// The gate host hands this to GateLive (LiveOptions.sessions); the gate asks it through
// GateLive.visitorForSession and tells it to forget through forgetSession and changed().
import { isPgUnavailable, one, PgUnavailable, run } from '@panel/core/pg';
import { hashToken, looksLikeToken } from '@panel/core/util';
import type { SessionDeps, SessionSource } from '@panel/core/gate/live';
import type { Access, AreaRole, Visitor } from '@panel/core/gate/types';
import { PAGES_READ, rolesOf } from '@panel/core/gate/store';

type Session = {
  id: number; host: string; expiresAt: number; revokedAt: number | null; lastSeenAt: number;
  visitor: Visitor; roles: ReadonlyMap<number, AreaRole>; opens: ReadonlySet<number>;
};

export const SESSION_FRESH = 60;           // seconds a checked session is used without asking again
export const SESSION_STALE = 15 * 60;      // ... and while Postgres can't be reached
const MAX_SESSIONS = 10_000;

export class VisitorSessions implements SessionSource {
  #deps: SessionDeps;
  #kept = new Map<string, { at: number; s: Session | null }>();
  // the load in flight per token, and the forget count when it began: only a lookup
  // with nothing forgotten since may join it
  #loading = new Map<string, { p: Promise<Session | null>; started: number }>();
  // a count of forgets, and the count when each visitor was last forgotten: a load
  // started before its visitor's forget is not kept
  #forgets = 0;
  #forgotAt = new Map<number, number>();

  constructor(deps: SessionDeps) { this.#deps = deps; }

  async visitorFor(token: string | null, host: string): Promise<Access | null> {
    if (!looksLikeToken(token)) return null;
    const now = this.#deps.now();
    const key = hashToken(token);
    const kept = this.#kept.get(key);
    const age = kept ? now - kept.at : Infinity;
    let s: Session | null;
    if (kept && age >= 0 && age < SESSION_FRESH) {
      s = kept.s;
    } else {
      try {
        if (!this.#deps.ready()) throw new PgUnavailable();
        s = await this.#shared(key, now);
      } catch (e) {
        if (!isPgUnavailable(e) || !kept || age < 0 || age >= SESSION_STALE) throw e;
        s = kept.s;
      }
    }
    if (!s || s.revokedAt || s.expiresAt <= now || s.host !== host || !s.visitor.active) return null;
    return { visitor: s.visitor, sessionId: s.id, roles: s.roles, opens: s.opens };
  }

  // One load per token at a time; joined only by lookups with nothing forgotten since it
  // began (a lookup after a forget loads anew, and the old load is then not kept);
  // kept only if nothing was forgotten meanwhile.
  #shared(key: string, now: number): Promise<Session | null> {
    const inFlight = this.#loading.get(key);
    if (inFlight && inFlight.started === this.#forgets) return inFlight.p;
    const started = this.#forgets;
    const p: Promise<Session | null> = this.#load(key, now).then((s) => {
      const forgotten = this.#loading.get(key)?.p !== p
        || (s !== null && (this.#forgotAt.get(s.visitor.id) ?? -1) >= started);
      if (!forgotten) {
        if (this.#kept.size >= MAX_SESSIONS) this.#kept.clear();
        this.#kept.set(key, { at: now, s });
      }
      return s;
    }).finally(() => {
      if (this.#loading.get(key)?.p === p) this.#loading.delete(key);
      // nothing in flight: no load can have begun before a forget
      if (this.#loading.size === 0) this.#forgotAt.clear();
    });
    this.#loading.set(key, { p, started });
    return p;
  }

  async #load(key: string, now: number): Promise<Session | null> {
    const db = this.#deps.db;
    const r = await one<{ id: number; visitor_id: number; host: string; expires_at: number; revoked_at: number | null; last_seen_at: number }>(db,
      'SELECT id, visitor_id, host, expires_at, revoked_at, last_seen_at FROM sessions WHERE token_hash = ?', key);
    if (!r) return null;
    const visitor = await one<Visitor>(db, 'SELECT * FROM visitors WHERE id = ?', r.visitor_id);
    if (!visitor) return null;
    const roles = await rolesOf(db, visitor.id);
    const opens = new Set([...roles].filter(([, r]) => r.privileges.has(PAGES_READ)).map(([id]) => id));
    let lastSeenAt = r.last_seen_at;
    if (!r.revoked_at && r.expires_at > now && now - lastSeenAt >= 300) {
      await run(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, r.id);
      lastSeenAt = now;
    }
    return { id: r.id, host: r.host, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastSeenAt, visitor, roles, opens };
  }

  forget(token: string) {
    if (!looksLikeToken(token)) return;
    const key = hashToken(token);
    this.#kept.delete(key);
    this.#loading.delete(key);
  }

  // Every session of this visitor (a password, a sign-out everywhere, switched off,
  // deleted, a role given or taken): the rest stay.
  forgetVisitor(visitorId: number) {
    this.#forgotAt.set(visitorId, this.#forgets++);
    for (const [key, k] of this.#kept) if (k.s?.visitor.id === visitorId) this.#kept.delete(key);
  }

  forgetAll() {
    this.#forgets++;
    this.#forgotAt.clear();
    this.#kept.clear();
    this.#loading.clear();
  }
}

// What the host hands GateLive: new GateLive(sql, { …, sessions: visitorSessions }).
export const visitorSessions = (deps: SessionDeps): SessionSource => new VisitorSessions(deps);
