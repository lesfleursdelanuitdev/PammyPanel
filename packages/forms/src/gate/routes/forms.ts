// A form on any page of her site: what it asks, and sending a response
// (docs/forms-plan.md). What decides whether it may be used is src/gate/form-use.ts.
import type { GateCtx } from '@panel/core/gate/context';
import type { FormPages } from '../form-use.ts';
import { addResponse } from '../forms/responses.ts';
import { logEvent } from '@panel/core/gate/ops';

// What other packages do when a response is kept (docs/packaging-plan.md step 1c):
// form-links saves it into a database. Called without waiting, and never throws.
export type FormHooks = { responseKept: (responseId: number) => void };

export function registerForms(ctx: GateCtx, { formUse, publicItems, notePage }: FormPages, hooks: FormHooks) {
  const { app, db, now, limiter, hostOf, baseOf, refuse, tooMany, post } = ctx;

  app.get('/_pammy/forms/:name', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const { name } = req.params as { name: string };
    const use = await formUse(req, reply, host, base, name, (req.query as Record<string, unknown>).page);
    if (!use) return reply;
    notePage(use.form, use.target);
    return {
      name: use.form.name, title: use.form.title,
      items: publicItems(use.form.items, base),
      submitText: use.form.settings.submitText, sentText: use.form.settings.sentText,
      signedInAs: use.sender?.username ?? null,
    };
  });

  app.post('/_pammy/forms/:name', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    const { name } = req.params as { name: string };
    const use = await formUse(req, reply, host, base, name, body.page);
    if (!use) return reply;
    // A field people can't see: only robots fill it in. They're told it worked.
    if (typeof body.website === 'string' && body.website !== '') {
      await logEvent(db, now(), 'form-spam', { host, ip });
      return { ok: true };
    }
    if (!limiter.take(`form-ip:${ip}`, 10, 3600)) return tooMany(reply, 'an hour');
    let responseId: number;
    try {
      responseId = await addResponse(db, now(), use.form, use.target?.rel ?? '', body.answers, use.sender, host, ip);
    } catch (e) {
      return refuse(reply, e);
    }
    // a form that saves its answers in a database (docs/form-to-database-plan.md):
    // after the response is kept, and without the visitor waiting for it -- a
    // database that is asleep must not keep their "Thank you" from them
    hooks.responseKept(responseId);
    await logEvent(db, now(), 'form-response', { visitorId: use.sender?.visitorId ?? null, username: use.sender?.username ?? null, host, ip });
    return { ok: true };
  });
}
