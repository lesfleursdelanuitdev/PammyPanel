// What the panel's routes share (docs/refactor-plan.md phase 3): the settings,
// the database, the clock, who is asking, and the sockets the panel speaks to.
// Every route file is handed one of these and nothing else.
//
// This is the core's part (docs/packaging-plan.md step 1a). The helpers' clients
// belong to their packages, so the site passes them in as plain calls; files and
// studio add their own parts beside it (files-ctx.ts, studio-ctx.ts).
//
// Before this it was all closures inside `buildApp`, which is why every change
// touched the same 4000-line file. Nothing here decides anything: it is the
// plumbing, and the decisions live in the route files and in src/studio/.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AccountError, type Actor } from '../accounts.ts';
import { RECENT_AUTH, type Config } from '../config.ts';
import type { Sql } from '../pg.ts';
import { callJsonLine, CallError } from '../jsonline.ts';
import { clientIp, RateLimiter } from '../security.ts';
import { lookupSession, readCookie, SESSION_COOKIE, clearedSessionCookie, type Authed } from '../sessions.ts';
import { mayUse, type Needs } from './rights.ts';

export type Body = Record<string, unknown>;

// A refusal from one of the helpers, in the status the panel answers with.
export const HELPER_STATUS: Record<string, number> = {
  invalid: 400, 'not-found': 404, exists: 409, stale: 409, conflict: 409, busy: 409, 'not-set-up': 409, refused: 502,
  'not-allowed': 403, closed: 403, full: 503, unavailable: 503, timeout: 504,
};

export type PanelCtx = {
  app: FastifyInstance;
  config: Config;
  db: Sql;
  now: () => number;

  // who is asking
  authOf: (req: FastifyRequest) => Promise<Authed | null>;
  actorOf: (a: Authed, req: FastifyRequest) => Actor;
  // Who is asking, if the route's `needs` (rights.ts) lets them in, and, with fresh,
  // only if they confirmed with a passkey in the last few minutes. Returns null
  // after sending the refusal.
  need: (req: FastifyRequest, reply: FastifyReply, opts?: { fresh?: boolean }) => Promise<Authed | null>;
  // The same question, for a route that reads its own body first (the uploads)
  // and answers the refusal itself: false when the route isn't theirs to use.
  may: (a: Authed, req: FastifyRequest) => boolean;
  limited: (req: FastifyRequest, reply: FastifyReply, bucket: string, max: number, windowSec: number) => boolean;

  // what was sent
  body: (req: FastifyRequest) => Body;
  idParam: (req: FastifyRequest, name: string) => number;

  // the three sockets: her website's folders, the gate, and her own engines
  helper: <T>(req: Record<string, unknown>) => Promise<T>;
  gate: <T>(req: Record<string, unknown>) => Promise<T>;
  studio: <T>(req: Record<string, unknown>) => Promise<T>;
  // and the software she has installed (WordPress), through the software helper
  software: <T>(req: Record<string, unknown>) => Promise<T>;
  // and the mail service, which sends the panel's own emails (docs/apps-plan.md phase 3)
  mailer: <T>(req: Record<string, unknown>) => Promise<T>;

  dateOf: (unix: number) => string;
};

// A helper's client, as its package makes it: a request in, the answer out, or a
// CallError the context turns into the status the panel answers with.
type Call = <T>(req: Record<string, unknown>) => Promise<T>;
export type HelperCalls = { helper: Call; studio: Call; software: Call; mailer: Call };

// What the route says it needs (rights.ts); an /api route that forgot to say is
// a mistake, and refuses everyone rather than let anyone in.
const needsOf = (req: FastifyRequest): Needs | null => req.routeOptions.config.needs ?? null;
const allowed = (a: Authed, req: FastifyRequest) => {
  const needs = needsOf(req);
  return needs !== null && mayUse(a.user, needs, req.routeOptions.config.wholeSite === true);
};

export function panelContext(app: FastifyInstance, config: Config, db: Sql, calls: HelperCalls): PanelCtx {
  const now = () => config.now();
  const limiter = new RateLimiter(config.now);
  const refused = <T>(e: unknown): T => {
    if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
    throw e;
  };
  const authOf = (req: FastifyRequest) => lookupSession(db, now(), readCookie(req.headers.cookie, SESSION_COOKIE));

  return {
    app, config, db, now,

    authOf,
    actorOf: (a, req) => ({ id: a.user.id, label: a.user.username, ip: clientIp(req) }),

    async need(req, reply, opts = {}) {
      const a = await authOf(req);
      if (!a) {
        void reply.code(401).header('Set-Cookie', clearedSessionCookie()).send({ error: 'signed-out', message: 'Please sign in again.' });
        return null;
      }
      if (!allowed(a, req)) {
        // R4 (docs/permissions-plan.md): a part a person doesn't have isn't
        // there at all for them, whatever their menu shows
        void reply.code(404).send({ error: 'not-found', message: 'Not found.' });
        return null;
      }
      if (opts.fresh && now() - a.session.auth_at >= RECENT_AUTH) {
        void reply.code(403).send({ error: 'reauth-required', message: 'Please confirm with your passkey.' });
        return null;
      }
      return a;
    },

    may: allowed,

    limited(req, reply, bucket, max, windowSec) {
      if (limiter.take(`${bucket}:${clientIp(req)}`, max, windowSec)) return false;
      void reply.code(429).send({ error: 'rate-limited', message: 'Too many attempts. Wait a few minutes and try again.' });
      return true;
    },

    body: (req) => (req.body && typeof req.body === 'object' ? req.body as Body : {}),
    idParam(req, name) {
      const v = Number((req.params as Record<string, string>)[name]);
      if (!Number.isSafeInteger(v) || v <= 0) throw new AccountError('Not found.', 404);
      return v;
    },

    // The panel never touches her files itself: pammy-sitefs (running as pamela,
    // sandboxed to /pamela/public and /pamela/trash) does, and re-checks every name.
    helper: async <T>(req: Record<string, unknown>) => {
      try { return await calls.helper<T>(req); } catch (e) { return refused<T>(e); }
    },
    gate: async <T>(req: Record<string, unknown>) => {
      try { return await callJsonLine<T>(config.gateSocket, req, 'protected-folder service'); } catch (e) { return refused<T>(e); }
    },
    // The panel does not open her engines itself -- everything asks the database
    // helper (src/pammydb/) and keeps only what the panel means by the answer.
    studio: async <T>(req: Record<string, unknown>) => {
      try { return await calls.studio<T>(req); } catch (e) { return refused<T>(e); }
    },
    // The software helper (src/apps/, root, docs/apps-plan.md G2) is the truth
    // about what is installed; the panel shows what it says.
    software: async <T>(req: Record<string, unknown>) => {
      try { return await calls.software<T>(req); } catch (e) { return refused<T>(e); }
    },
    mailer: async <T>(req: Record<string, unknown>) => {
      try { return await calls.mailer<T>(req); } catch (e) { return refused<T>(e); }
    },

    dateOf: (unix) => new Date(unix * 1000).toISOString().slice(0, 10),
  };
}
