// "I forgot my password" and "please let me in" from a protected folder's pages
// (docs/roles-plan.md step 1: the Requests module).
import type { GateCtx } from '@panel/core/gate/context';
import { targetsFor } from '@panel/areas/gate/targets';
import { addAccessRequest, addResetRequest, cleanVisitorName } from '@panel/core/gate/store';
import { logEvent } from '@panel/core/gate/ops';

export function registerRequests(ctx: GateCtx) {
  const { app, db, now, limiter, refuse, tooMany, post } = ctx;
  const { targetOf, noArea } = targetsFor(ctx);

  // Nothing is sent anywhere: these wait in the panel's Requests list for Pamela.
  app.post('/_pammy/forgot', async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    const target = targetOf(base, body);
    if (!target) return noArea(reply);
    const username = cleanVisitorName(body.username);
    if (!username) return reply.code(400).send({ error: 'invalid', message: 'Please type your username.' });
    if (!limiter.take(`forgot-ip:${ip}`, 5, 3600)) return tooMany(reply, 'an hour');
    // Same answer whether or not the username exists, so the form can't be used
    // to find out who has an account. Only real accounts become requests.
    const quiet = !limiter.take(`forgot-user:${username}`, 3, 86400);
    const recorded = quiet ? null : await addResetRequest(db, now(), target.area, username, body.message, host, ip);
    await logEvent(db, now(), recorded ? 'forgot' : 'forgot-ignored', { visitorId: recorded?.visitor_id ?? null, username, areaId: target.area.id, host, ip });
    return { ok: true };
  });

  app.post('/_pammy/request', async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    const target = targetOf(base, body);
    if (!target) return noArea(reply);
    // A field people can't see: only robots fill it in. They're told it worked.
    if (typeof body.website === 'string' && body.website !== '') {
      await logEvent(db, now(), 'request-spam', { areaId: target.area.id, host, ip });
      return { ok: true };
    }
    if (!limiter.take(`request-ip:${ip}`, 5, 3600)) return tooMany(reply, 'an hour');
    try {
      const r = await addAccessRequest(db, now(), target.area, { name: body.name, contact: body.contact, message: body.message }, host, ip);
      await logEvent(db, now(), 'access-requested', { username: r.name, areaId: target.area.id, host, ip });
      return { ok: true };
    } catch (e) {
      return refuse(reply, e);
    }
  });
}
