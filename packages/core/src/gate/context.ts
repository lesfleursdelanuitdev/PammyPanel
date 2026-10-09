// What the gate's routes share (docs/refactor-plan.md phase 4): the settings,
// the database, the clock, the rate limiter, and how a request says where it
// came from and who sent it. Every route file under src/gate/routes/ is handed
// one of these, as the panel's are handed a PanelCtx (src/panel/context.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KeyObject } from 'node:crypto';
import { callJsonLine } from '../jsonline.ts';
import type { Module } from '../profile.ts';
import type { Sql } from '../pg.ts';
import { fromNginx, RateLimiter } from '../security.ts';
import { readCookie } from '../sessions.ts';
import type { Access, GateLive } from './live.ts';
import { GateError } from './ops.ts';

// The visitor cookie's default name (docs/k-a-plan.md K-a4: the kernel's, as the gate
// context reads it; hosts/src/config.ts names the same, and test/s1e-cookie checks they agree).
export const VISITOR_COOKIE = '__Host-pammy_visitor';

export type GateConfig = {
  publicRoot: string;       // her website (the profile's website.public)
  domain: string;           // its domain (the profile's)
  now: () => number;
  // the media API (docs/media-api-plan.md M2): the panel's published index and thumbnails
  mediaIndex: string;       // <mediaPublic>/index.db
  pammydbSocket: string;    // the database helper (slice 9's data API)
  mediaThumbs: string;      // <mediaPublic>/thumbs
  // the visitor cookie's name (the profile's services.gate.cookie): each site its own,
  // so a browser signed in on one never sends it to the other's gate
  visitorCookie?: string;   // __Host-pammy_visitor when not given
  // the fixed visitor emails (docs/accounts-plan.md step 4), through the mail
  // service's door for the gate; null: this site's gate can't email anyone, so
  // "Emailed links" can't be turned on
  visitorMail?: VisitorMailer | null;
  modules?: readonly Module[];   // the site's (its profile's); every module when not given
  // the key it signs what it tells an app with (docs/s1-plan.md, review S1): systemd's
  // LoadCredential identity.key; none, no proof is made (pammy.org: no service routes)
  identityKey?: KeyObject | null;
};

// One of the mail service's fixed visitor emails (packages/mail/src/mail/visitor.ts):
// its kind, the one address, and the link where the kind has one. Throws the mail
// service's refusal (code 'full' when a limit is reached) or 'unavailable'.
export type VisitorMail = { kind: 'confirm' | 'reset' | 'email-change' | 'email-changed' | 'already-registered' | 'deleted'; to: string; link?: string };
export type VisitorMailer = (m: VisitorMail) => Promise<void>;

// The mail service's door for the gate (the profile's services.sockets.mailVisitor).
export const socketMailer = (socket: string): VisitorMailer => async (m) => {
  await callJsonLine(socket, { op: 'visitor', ...m }, 'mail service', 30_000);
};

// X-Pammy-Base: "/" for the domain itself, "/<folder>" for <folder>.<domain>.
// Never empty (nginx drops empty headers), so a missing header means nginx isn't
// set up as expected and the request is refused rather than guessed at.
const BASE_RE = /^\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/;

const STATUS: Record<GateError['code'], number> = { invalid: 400, exists: 409, 'not-found': 404, closed: 403, full: 503, stale: 409, unavailable: 503 };

// Requests a minute: with a key, without one, and with a key that is wrong.
// The responses API, comments, the media API and the data API all count by these.
export const API_LIMIT = { keyed: 600, open: 120, bad: 30 };

export type GateCtx = {
  app: FastifyInstance;
  cfg: GateConfig;
  live: GateLive;
  db: Sql;
  now: () => number;
  cookie: string;           // the visitor cookie's name
  visitorMail: VisitorMailer | null;
  limiter: RateLimiter;
  hostOf: (req: FastifyRequest) => string | null;
  ipOf: (req: FastifyRequest) => string;
  baseOf: (req: FastifyRequest) => string | null;
  visitorOf: (req: FastifyRequest, host: string) => Promise<Access | null>;
  bodyOf: (req: FastifyRequest) => Record<string, unknown>;
  refuse: (reply: FastifyReply, e: unknown) => FastifyReply;
  tooMany: (reply: FastifyReply, wait: string) => FastifyReply;
  sameOrigin: (req: FastifyRequest, reply: FastifyReply, host: string) => boolean;
  post: (req: FastifyRequest, reply: FastifyReply) => { host: string; base: string; ip: string; body: Record<string, unknown> } | null;
  apiError: (reply: FastifyReply, status: number, error: string, message: string) => FastifyReply;
};

export function gateCtx(app: FastifyInstance, cfg: GateConfig, live: GateLive): GateCtx {
  const limiter = new RateLimiter(cfg.now);
  const now = () => cfg.now();
  const cookie = cfg.visitorCookie ?? VISITOR_COOKIE;
  const hostRe = new RegExp(`^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)?${cfg.domain.replace(/\./g, '\\.')}$`);

  // nginx sets Host and X-Real-IP (after trusting CF-Connecting-IP from Cloudflare only)
  // on a site with hosts, any name a host answers to, on any of its domains (8-2)
  const hostOf = (req: FastifyRequest) => {
    const h = String(req.headers.host ?? '').toLowerCase();
    return hostRe.test(h) || live.siteRoutes?.hasHost(h) ? h : null;
  };
  // X-Real-IP only from nginx: this machine, with the edge secret once there is one (S1c)
  const ipOf = (req: FastifyRequest) => {
    const real = req.headers['x-real-ip'];
    return fromNginx(req) && typeof real === 'string' ? real.slice(0, 64) : req.socket.remoteAddress ?? '';
  };
  const baseOf = (req: FastifyRequest) => {
    const b = req.headers['x-pammy-base'];
    if (typeof b !== 'string' || !BASE_RE.test(b)) return null;
    return b === '/' ? '' : b;
  };
  // who is signed in on this hostname, and which folders they may open (from memory when it can)
  const visitorOf = (req: FastifyRequest, host: string): Promise<Access | null> =>
    live.visitorForSession(readCookie(req.headers.cookie, cookie) ?? null, host);
  const bodyOf = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof GateError) return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
    throw e;
  };
  const tooMany = (reply: FastifyReply, wait: string) =>
    reply.code(429).send({ error: 'rate-limited', message: `Too many attempts. Please wait ${wait} and try again.` });

  // ---------------------------------------------------------------- what a visitor sends
  // Same-origin JSON only: a form on another site can't sign people in or out,
  // or file requests in their name.
  function sameOrigin(req: FastifyRequest, reply: FastifyReply, host: string): boolean {
    const site = req.headers['sec-fetch-site'];
    const ok = req.headers.origin === `https://${host}`
      && (site === undefined || site === 'same-origin')
      && (req.headers['content-type'] ?? '').split(';')[0]!.trim() === 'application/json';
    if (!ok) void reply.code(403).send({ error: 'forbidden', message: 'Request refused.' });
    return ok;
  }
  // host, base and the same-origin check, for every POST
  function post(req: FastifyRequest, reply: FastifyReply): { host: string; base: string; ip: string; body: Record<string, unknown> } | null {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) { void reply.code(400).send({ error: 'bad-host', message: 'Request refused.' }); return null; }
    if (!sameOrigin(req, reply, host)) return null;
    return { host, base, ip: ipOf(req), body: bodyOf(req) };
  }
  const apiError = (reply: FastifyReply, status: number, error: string, message: string) =>
    reply.code(status).header('Cache-Control', 'private, no-store').send({ error, message });

  return { app, cfg, live, db: live.db, now, cookie, visitorMail: cfg.visitorMail ?? null, limiter, hostOf, ipOf, baseOf, visitorOf, bodyOf, refuse, tooMany, sameOrigin, post, apiError };
}
