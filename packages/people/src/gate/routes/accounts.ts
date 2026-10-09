// Accounts people make and look after themselves (docs/accounts-plan.md step 4):
// register, confirm an address, a new password by email, and the account page
// (change password, change address, sign out everywhere, delete the account).
//
// Every one of these is behind a switch the panel's owners turn on (Settings >
// Visitors, A5), read from memory (live.ts). With a switch off its routes answer
// 404, exactly as before they existed, so a site keeps today's behaviour.
//
// The emails are the mail service's fixed kinds, sent through its door for the
// gate (ctx.visitorMail). Nothing a visitor types goes into one, and each link
// points at this hostname's own /_pammy/ page, the token after the # (so it never
// reaches a log). Every answer that could tell whether an address has an account
// is the same either way.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie } from '@panel/core/sessions';
import type { GateCtx, VisitorMail } from '@panel/core/gate/context';
import type { VisitorSettings } from '@panel/core/gate/visitor-settings';
import { safeNext } from '@panel/areas/gate/policy';
import { targetsFor } from '@panel/areas/gate/targets';
import { MODULES } from '@panel/core/profile';
import {
  changeOwnPassword, deleteOwnAccount, forgetRegistration, registerVisitor, startEmailChange, useConfirmLink, useResetLink, type Registered,
} from '../self-service.ts';
import { liveLink, makeEmailedLink } from '../links.ts';
import { revokeVisitorSessions } from '../sessions.ts';
import { visitorByLogin } from '../sign-in-check.ts';
import type { PeopleSockets } from '../reset-requests.ts';
import { GateError, logEvent } from '@panel/core/gate/ops';
import { sessionCookie, signedOutCookie } from './sign-in.ts';

// What the switches allow, as the pages see it. Emailed links need the gate's
// door to the mail service as well as the switch.
export type AccountSwitches = { register: boolean; emailedLinks: boolean; changePassword: boolean; deleteAccount: boolean };
export const accountSwitches = (s: VisitorSettings, canMail: boolean): AccountSwitches => ({
  register: s.selfRegister && s.emailedLinks && canMail,
  emailedLinks: s.emailedLinks && canMail,
  changePassword: s.changePassword,
  deleteAccount: s.deleteAccount,
});
const accountPage = (a: AccountSwitches) => a.changePassword || a.deleteAccount || a.emailedLinks;

// The built-in pages: /_pammy/<kind>, each there while what it is for is on.
export const ACCOUNT_PAGES: Record<string, { title: string; element: string; shown: (a: AccountSwitches) => boolean }> = {
  register: { title: 'Make an account', element: '<pammy-register></pammy-register>', shown: (a) => a.register },
  confirm: { title: 'Confirm your email address', element: '<pammy-confirm></pammy-confirm>', shown: (a) => a.emailedLinks },
  reset: { title: 'Choose a new password', element: '<pammy-reset></pammy-reset>', shown: (a) => a.emailedLinks },
  account: { title: 'Your account', element: '<pammy-account></pammy-account>', shown: accountPage },
};

// people: the sockets the host fills (KA-Q2: requests' reset requests)
export function registerAccounts(ctx: GateCtx, people: PeopleSockets) {
  const { app, cfg, live, db, now, cookie: cookieName, visitorMail, limiter, visitorOf, refuse, tooMany, post } = ctx;
  const { targetOf } = targetsFor(ctx);
  const requestsOn = (cfg.modules ?? MODULES).includes('requests');
  const switches = () => accountSwitches(live.visitorSettings, visitorMail !== null);
  const notHere = (reply: FastifyReply) => reply.code(404).send();
  const linkTo = (host: string, page: 'confirm' | 'reset', token: string) => `https://${host}/_pammy/${page}#${token}`;

  // One email. A limit reached says so (Q5: "try later"); anything else is the
  // mail service being out of reach for now.
  const send = async (m: VisitorMail) => {
    if (!visitorMail) throw new GateError('unavailable', "This site can't send email.");
    try {
      await visitorMail(m);
    } catch (e) {
      if ((e as { code?: unknown }).code === 'full') throw new GateError('full', (e as Error).message);
      app.log.warn(`a visitor email (${m.kind}) was not sent: ${(e as Error).message}`);
      throw new GateError('unavailable', "The email couldn't be sent just now. Please try again in a few minutes.");
    }
  };
  // The same, where the person is told the same whatever happens (so the answer
  // can't say whether an address has an account): a failure is only logged.
  const sendQuietly = (m: VisitorMail, what: string) => send(m).catch((e: unknown) => {
    app.log.warn(`${what}: ${(e as Error).message}`);
    return false as const;
  });

  const linkGone = (reply: FastifyReply, what: string) => reply.code(410).send({
    error: 'gone', message: `This link doesn't work any more: it has been used, replaced by a newer one, or it's more than ${what} old.`,
  });

  // What the pages may offer: the components ask before showing a link or a form.
  app.get('/_pammy/accounts', async () => switches());

  // ---------------------------------------------------------------- register
  app.post('/_pammy/register', async (req, reply) => {
    if (!switches().register) return notHere(reply);
    const c = post(req, reply);
    if (!c) return reply;
    const { host, ip, body } = c;
    // A field people can't see: only robots fill it in. They're told it worked.
    if (typeof body.website === 'string' && body.website !== '') {
      await logEvent(db, now(), 'register-spam', { host, ip });
      return { ok: true };
    }
    if (!limiter.take(`register-ip:${ip}`, 5, 3600)) return tooMany(reply, 'an hour');
    let r: Registered;
    try {
      r = await registerVisitor(db, now(), { username: body.username, email: body.email, password: body.password });
    } catch (e) {
      return refuse(reply, e);
    }
    if ('taken' in r) {
      // The address has an account: it gets a note with a way back in, and the
      // person here is told exactly what a new account would tell them.
      const v = r.taken;
      if (v.active && v.email && limiter.take(`register-mail:${v.email}`, 3, 86400)) {
        const token = await makeEmailedLink(db, now(), v.id, 'reset');
        await sendQuietly({ kind: 'already-registered', to: v.email, link: linkTo(host, 'reset', token) }, 'an already-registered note was not sent');
      }
      await logEvent(db, now(), 'register-existing', { visitorId: v.id, username: v.username, host, ip });
      return { ok: true };
    }
    try {
      await send({ kind: 'confirm', to: r.made.email!, link: linkTo(host, 'confirm', r.token) });
    } catch (e) {
      // no email, no account: they can try again later with the same name
      await forgetRegistration(db, r.made.id);
      return refuse(reply, e);
    }
    await logEvent(db, now(), 'registered', { visitorId: r.made.id, username: r.made.username, host, ip });
    return { ok: true };
  });

  // ---------------------------------------------------------------- confirm an address (a new account's, or a new one for an account)
  app.post('/_pammy/confirm', async (req, reply) => {
    if (!switches().emailedLinks) return notHere(reply);
    const c = post(req, reply);
    if (!c) return reply;
    const { host, ip, body } = c;
    if (!limiter.take(`link-ip:${ip}`, 30, 900)) return tooMany(reply, '15 minutes');
    let used;
    try {
      used = await useConfirmLink(db, now(), body.token, host, ip);
    } catch (e) {
      return refuse(reply, e);
    }
    if (!used) return linkGone(reply, '24 hours');
    const changed = used.purpose === 'email-change';
    if (changed && used.oldEmail) await sendQuietly({ kind: 'email-changed', to: used.oldEmail }, 'the note to the old address was not sent');
    await logEvent(db, now(), changed ? 'email-changed' : 'email-confirmed', { visitorId: used.visitor.id, username: used.visitor.username, host, ip });
    reply.header('Set-Cookie', sessionCookie(cookieName, used.session));
    return { ok: true, username: used.visitor.username, changed, next: changed ? '/_pammy/account' : safeNext(body.next) ?? '/' };
  });

  // ---------------------------------------------------------------- forgot password: a link by email
  // Always the same answer. An account with no address (one the owner made) gets
  // no email: from a folder's page, it becomes a "forgot password" request for the
  // owner, as with emailed links off.
  app.post('/_pammy/reset-link', async (req, reply) => {
    if (!switches().emailedLinks) return notHere(reply);
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    if (!limiter.take(`reset-ip:${ip}`, 5, 3600)) return tooMany(reply, 'an hour');
    const v = await visitorByLogin(db, body.login ?? body.username);
    const quiet = !v || !limiter.take(`reset-account:${v.id}`, 3, 86400);
    let event = 'reset-link-ignored';
    if (!quiet && v.active === 1 && v.email) {
      const link = linkTo(host, 'reset', await makeEmailedLink(db, now(), v.id, 'reset'));
      if (await sendQuietly({ kind: 'reset', to: v.email, link }, 'a reset link was not sent') !== false) event = 'reset-link-sent';
    } else if (!quiet && !v.email && requestsOn) {
      const target = targetOf(base, body);
      if (target && await people.resetRequests.add(db, now(), target.area, v.username, '', host, ip)) event = 'forgot';
    }
    await logEvent(db, now(), event, { visitorId: v?.id ?? null, username: v?.username ?? null, host, ip });
    return { ok: true };
  });

  app.post('/_pammy/reset/check', async (req, reply) => {
    if (!switches().emailedLinks) return notHere(reply);
    const c = post(req, reply);
    if (!c) return reply;
    if (!limiter.take(`link-ip:${c.ip}`, 30, 900)) return tooMany(reply, '15 minutes');
    const found = await liveLink(db, now(), c.body.token, ['reset']);
    if (!found) return linkGone(reply, 'an hour');
    return { ok: true, username: found.visitor.username, expiresAt: found.link.expires_at };
  });

  // A6: a reset signs the person out everywhere, then in here.
  app.post('/_pammy/reset', async (req, reply) => {
    if (!switches().emailedLinks) return notHere(reply);
    const c = post(req, reply);
    if (!c) return reply;
    const { host, ip, body } = c;
    if (!limiter.take(`link-ip:${ip}`, 30, 900)) return tooMany(reply, '15 minutes');
    let used;
    try {
      used = await useResetLink(db, now(), body.token, body.password, host, ip, people.resetRequests);
    } catch (e) {
      return refuse(reply, e);
    }
    if (!used) return linkGone(reply, 'an hour');
    await live.changed({ visitor: used.visitor.id });
    await logEvent(db, now(), 'password-reset', { visitorId: used.visitor.id, username: used.visitor.username, host, ip });
    reply.header('Set-Cookie', sessionCookie(cookieName, used.session));
    return { ok: true, username: used.visitor.username, next: safeNext(body.next) ?? '/' };
  });

  // ---------------------------------------------------------------- the account page's changes
  // Signed in on this hostname, the account page there (one of its switches on),
  // and not too many tries at the password.
  const signedIn = async (req: FastifyRequest, reply: FastifyReply, allowed: (a: AccountSwitches) => boolean) => {
    if (!allowed(switches())) { notHere(reply); return null; }
    const c = post(req, reply);
    if (!c) return null;
    const s = await visitorOf(req, c.host);
    if (!s) { void reply.code(401).send({ error: 'signed-out', message: "You're not signed in any more. Please sign in again." }); return null; }
    if (!limiter.take(`account:${s.visitor.id}`, 10, 900)) { tooMany(reply, '15 minutes'); return null; }
    return { ...c, s };
  };

  app.post('/_pammy/account/password', async (req, reply) => {
    const c = await signedIn(req, reply, (a) => a.changePassword);
    if (!c) return reply;
    try {
      await changeOwnPassword(db, now(), c.s.visitor.id, c.s.sessionId, c.body.current, c.body.password);
    } catch (e) {
      return refuse(reply, e);
    }
    await live.changed({ visitor: c.s.visitor.id });
    await logEvent(db, now(), 'password-changed', { visitorId: c.s.visitor.id, username: c.s.visitor.username, host: c.host, ip: c.ip });
    return { ok: true };
  });

  // The new address gets a link; nothing changes until it's used. The answer is
  // the same when another account has that address.
  app.post('/_pammy/account/email', async (req, reply) => {
    const c = await signedIn(req, reply, (a) => a.emailedLinks);
    if (!c) return reply;
    let started;
    try {
      started = await startEmailChange(db, now(), c.s.visitor.id, c.body.password, c.body.email);
      if (started) await send({ kind: 'email-change', to: started.to, link: linkTo(c.host, 'confirm', started.token) });
    } catch (e) {
      return refuse(reply, e);
    }
    await logEvent(db, now(), started ? 'email-change-sent' : 'email-change-ignored', { visitorId: c.s.visitor.id, username: c.s.visitor.username, host: c.host, ip: c.ip });
    return { ok: true };
  });

  app.post('/_pammy/account/signout', async (req, reply) => {
    const c = await signedIn(req, reply, accountPage);
    if (!c) return reply;
    await revokeVisitorSessions(db, now(), c.s.visitor.id);
    await live.changed({ visitor: c.s.visitor.id });
    await logEvent(db, now(), 'signed-out-everywhere', { visitorId: c.s.visitor.id, username: c.s.visitor.username, host: c.host, ip: c.ip });
    reply.header('Set-Cookie', signedOutCookie(cookieName));
    return { ok: true, next: '/' };
  });

  // A9: the account and everything the gate keeps about it (its events keep the
  // username only). The apps behind an area are told in roles step 5 (Q1).
  app.post('/_pammy/account/delete', async (req, reply) => {
    const c = await signedIn(req, reply, (a) => a.deleteAccount);
    if (!c) return reply;
    let gone;
    try {
      gone = await deleteOwnAccount(db, c.s.visitor.id, c.body.password);
    } catch (e) {
      return refuse(reply, e);
    }
    await live.changed({ visitor: c.s.visitor.id });
    const token = readCookie(req.headers.cookie, cookieName);
    if (token) live.forgetSession(token);
    await logEvent(db, now(), 'account-deleted', { username: gone.username, host: c.host, ip: c.ip });
    if (gone.email && gone.email_confirmed_at && visitorMail) await sendQuietly({ kind: 'deleted', to: gone.email }, 'the deleted note was not sent');
    reply.header('Set-Cookie', signedOutCookie(cookieName));
    return { ok: true, next: '/' };
  });

}
