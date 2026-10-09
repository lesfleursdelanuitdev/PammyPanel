// Signing in and out, who is signed in, and the setup links (docs/refactor-plan.md
// phase 4; docs/roles-plan.md step 1: the People module). A sign-in is to a
// protected folder (@panel/areas' targets), or, with "People can register
// themselves" on, to the site itself: one account for all of it (accounts step 4,
// A2). The accounts' own pages are accounts.ts.
import type { FastifyReply } from 'fastify';
import { readCookie } from '@panel/core/sessions';
import type { GateCtx } from '@panel/core/gate/context';
import { folderHome, safeNext } from '@panel/areas/gate/policy';
import { targetsFor } from '@panel/areas/gate/targets';
import { opensArea } from '@panel/core/gate/store';
import { linkForToken, useLink } from '../links.ts';
import type { PeopleSockets } from '../reset-requests.ts';
import { createVisitorSession, revokeSession, VISITOR_SESSION } from '../sessions.ts';
import { signInCheck } from '../sign-in-check.ts';
import { logEvent } from '@panel/core/gate/ops';

export const sessionCookie = (name: string, token: string) => `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_SESSION}`;
export const signedOutCookie = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

// people: the sockets the host fills (KA-Q2: requests' reset requests)
export function registerSignIn(ctx: GateCtx, people: PeopleSockets) {
  const { app, live, db, now, cookie: cookieName, limiter, hostOf, ipOf, baseOf, visitorOf, bodyOf, refuse, tooMany, sameOrigin, post } = ctx;
  const { targetOf, noArea, signedOutPage } = targetsFor(ctx);

  app.get('/_pammy/me', async (req, reply) => {
    const host = hostOf(req);
    if (!host) return reply.code(400).send({ error: 'bad-host' });
    const s = await visitorOf(req, host);
    // their own address, for the account page (only ever to the signed-in person)
    return {
      signedIn: !!s, username: s?.visitor.username ?? null, name: s?.visitor.name || null,
      ...(s && { email: s.visitor.email, emailConfirmed: s.visitor.email_confirmed_at !== null, registered: s.visitor.registered }),
    };
  });

  // ---------------------------------------------------------------- sign in / out
  const cookie = (token: string) => sessionCookie(cookieName, token);

  app.post('/_pammy/login', async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 80) : '';
    if (!limiter.take(`ip:${ip}`, 10, 900) || !limiter.take(`user:${username}`, 20, 3600)) {
      await logEvent(db, now(), 'rate-limited', { username, host, ip });
      return tooMany(reply, '15 minutes');
    }
    // a folder's sign-in page, or (accounts on) the site's own
    const target = targetOf(base, body);
    if (!target && !live.visitorSettings.selfRegister) return noArea(reply);
    const areaId = target?.area.id ?? null;

    const checked = await signInCheck(db, body.username, body.password);
    if (!checked) {
      await logEvent(db, now(), 'login-failed', { username, areaId, host, ip });
      return reply.code(401).send({ error: 'wrong', message: "That username and password don't match." });
    }
    // A4: an account someone made works once its address is confirmed. Only
    // someone who has just typed its password is told so.
    if ('unconfirmed' in checked) {
      await logEvent(db, now(), 'login-unconfirmed', { visitorId: checked.unconfirmed.id, username: checked.unconfirmed.username, areaId, host, ip });
      return reply.code(403).send({ error: 'unconfirmed', message: 'Please confirm your email address first: open the link we emailed you when you made the account.' });
    }
    const visitor = checked.visitor;
    if (target && !await opensArea(db, visitor.id, target.area.id)) {
      await logEvent(db, now(), 'denied', { visitorId: visitor.id, username: visitor.username, areaId: target.area.id, host, ip });
      return reply.code(403).send({ error: 'no-access', message: "This account can't open this folder." });
    }
    const token = await createVisitorSession(db, now(), visitor.id, host, ip);
    await logEvent(db, now(), 'login', { visitorId: visitor.id, username: visitor.username, areaId, host, ip });
    // Where to go: back to what they asked for, or the folder's front page (the site's).
    reply.header('Set-Cookie', cookie(token));
    return { ok: true, next: safeNext(body.next) ?? (target ? folderHome(target.area.path, base) : '/') };
  });

  app.post('/_pammy/logout', async (req, reply) => {
    const host = hostOf(req);
    if (!host) return reply.code(400).send({ error: 'bad-host' });
    if (!sameOrigin(req, reply, host)) return reply;
    const token = readCookie(req.headers.cookie, cookieName);
    if (token) {
      const s = await visitorOf(req, host);
      await revokeSession(db, now(), token);
      live.forgetSession(token);
      if (s) await logEvent(db, now(), 'logout', { visitorId: s.visitor.id, username: s.visitor.username, host, ip: ipOf(req) });
    }
    reply.header('Set-Cookie', signedOutCookie(cookieName));
    const base = baseOf(req);
    const next = base === null ? null : signedOutPage(base, bodyOf(req));
    return next ? { ok: true, next } : { ok: true };
  });

  // ---------------------------------------------------------------- setup links
  const linkGone = (reply: FastifyReply) => reply.code(410).send({
    error: 'gone', message: "This link doesn't work any more: it has been used, replaced by a newer one, or it's more than 7 days old. Ask for a new one.",
  });

  app.post('/_pammy/invite/check', async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    if (!limiter.take(`invite-ip:${c.ip}`, 30, 900)) return tooMany(reply, '15 minutes');
    const found = await linkForToken(db, now(), c.body.token);
    if (!found) return linkGone(reply);
    return { ok: true, username: found.visitor.username, firstPassword: !found.visitor.password_hash, expiresAt: found.link.expires_at };
  });

  app.post('/_pammy/invite', async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    if (!limiter.take(`invite-ip:${ip}`, 30, 900)) return tooMany(reply, '15 minutes');
    let used;
    try {
      used = await useLink(db, now(), body.token, body.password, host, ip, people.resetRequests);
    } catch (e) {
      return refuse(reply, e);
    }
    if (!used) return linkGone(reply);
    // their other sessions just ended
    await live.changed({ visitor: used.visitor.id });
    await logEvent(db, now(), 'link-used', { visitorId: used.visitor.id, username: used.visitor.username, areaId: used.area?.id ?? null, host, ip });
    reply.header('Set-Cookie', cookie(used.session));
    const home = used.area && await opensArea(db, used.visitor.id, used.area.id) ? folderHome(used.area.path, base) : '/';
    return { ok: true, username: used.visitor.username, next: home };
  });
}
