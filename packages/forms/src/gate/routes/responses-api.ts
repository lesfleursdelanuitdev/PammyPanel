// The responses API (docs/forms-plan.md): read-only. A Bearer key, or no key
// at all when the form's "anyone can read approved responses" is on (then only
// its public fields).
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAnswerType } from '../../shared/form-types.ts';
import { API_LIMIT, type GateCtx } from '@panel/core/gate/context';
import { answersOut } from '../form-use.ts';
import { apiKeyFor } from '@panel/api-keys/gate/forms/api-keys';
import { decodeCursor, queryResponses } from '../forms/responses.ts';
import { formById, formByName } from '../forms/store.ts';

export function registerResponsesApi(ctx: GateCtx) {
  const { app, db, now, limiter, ipOf, apiError } = ctx;

  async function apiResponses(req: FastifyRequest, reply: FastifyReply) {
    const params = req.params as { id?: string; name?: string; scope: string; field?: string; value?: string };
    const query = req.query as Record<string, unknown>;
    const ip = ipOf(req);
    // Keys go in the Authorization header, never in the address (they end up in logs).
    for (const [k, v] of Object.entries(query)) {
      if (['key', 'apikey', 'api_key', 'token', 'access_token'].includes(k.toLowerCase()) || (typeof v === 'string' && v.startsWith('pammy_'))) {
        return apiError(reply, 400, 'key-in-query', 'Send the key in the Authorization header (Bearer ...), never in the address.');
      }
    }
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && /^Bearer /i.test(auth) ? auth.slice(7).trim() : '';
    const key = token ? await apiKeyFor(db, now(), token) : null;
    if (token && !key) {
      if (!limiter.take(`api-bad:${ip}`, API_LIMIT.bad, 60)) return apiError(reply, 429, 'too-many', 'Too many requests. Please wait a minute.');
      return apiError(reply, 401, 'bad-key', 'That key is not accepted.');
    }
    if (!limiter.take(key ? `api-key:${key.id}` : `api-ip:${ip}`, key ? API_LIMIT.keyed : API_LIMIT.open, 60)) {
      return apiError(reply, 429, 'too-many', 'Too many requests. Please wait a minute.');
    }
    const approvedOnly = params.scope === 'approved';
    // Two ways in: the form's number, or its name under /by-name/ ("by-name" can't be a
    // number, so the two never collide). A name that isn't a name at all looks the same as
    // one nobody has: formByName checks the shape first.
    const byName = params.name !== undefined;
    const form = byName
      ? await formByName(db, params.name)
      : /^[1-9][0-9]{0,15}$/.test(params.id ?? '') ? await formById(db, Number(params.id)) : undefined;
    const alive = form && !form.trashedAt ? form : undefined;
    const openToAll = !!alive && approvedOnly && alive.approvable && alive.publicApproved;
    if (!key) {
      // Without a key, nothing is said about forms that aren't open to everyone.
      if (!openToAll) return apiError(reply, 401, 'no-key', 'This needs a key: send it as "Authorization: Bearer ...".');
    } else {
      if (!alive) return apiError(reply, 404, 'no-form', byName ? 'There is no form with that name.' : 'There is no form with that id.');
      if (key.level !== 'all' && !approvedOnly) return apiError(reply, 403, 'not-allowed', 'This key can only read approved responses.');
      if (key.forms !== null && !key.forms.includes(alive.id)) return apiError(reply, 403, 'not-allowed', "This key can't read that form.");
      if (approvedOnly && !alive.approvable) return apiError(reply, 404, 'not-approvable', "This form doesn't have approvals switched on, so it has no approved responses.");
    }
    const f = alive!;
    const order = query.order === undefined || query.order === 'asc' ? 'asc' : query.order === 'desc' ? 'desc' : null;
    if (order === null) return apiError(reply, 400, 'bad-order', 'order can be asc (oldest first, the default) or desc.');
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return apiError(reply, 400, 'bad-limit', 'limit can be a whole number from 1 to 1000 (100 by default).');
    const after = query.after === undefined ? null : decodeCursor(String(query.after));
    if (query.after !== undefined && (!after || after.o !== order)) return apiError(reply, 400, 'bad-cursor', 'That "after" does not belong to this list. Use the "next" from the page before, with the same order.');

    // Which fields the answer of a response may show: all of them with a key,
    // only the ones marked "Show publicly" without one.
    const fields = f.items.filter((i) => isAnswerType(i.type) && (key || i.public));
    const allowed = new Set(fields.map((i) => i.key!));
    let filter: { key: string; value: string } | null = null;
    if (params.field !== undefined) {
      let asked: string;
      try { asked = decodeURIComponent(params.field); } catch { asked = params.field; }
      if (!allowed.has(asked.split('.')[0]!)) {
        return apiError(reply, 400, 'unknown-field', `There is no field called "${asked}" on this form. Its fields are: ${[...allowed].join(', ') || '(none)'}.`);
      }
      let value: string;
      try { value = decodeURIComponent(params.value ?? ''); } catch { value = params.value ?? ''; }
      filter = { key: asked, value };
    }
    const { rows, total, next } = await queryResponses(db, { formId: f.id, approvedOnly, filter, order, limit, after });
    const body = {
      form: { id: f.id, name: f.name, title: f.title },
      fields: fields.map((i) => ({ key: i.key, label: i.label, type: i.type })),
      order,
      responses: rows.map((r) => ({
        id: r.id,
        sentAt: new Date(r.createdAt * 1000).toISOString().replace('.000', ''),
        ...(approvedOnly ? {} : { approved: r.approvedAt !== null, approvedAt: r.approvedAt === null ? null : new Date(r.approvedAt * 1000).toISOString().replace('.000', '') }),
        ...(key ? { page: r.page } : {}),
        ...(r.sender && (key || f.settings.showSender) ? { signedInAs: r.sender.username } : {}),
        answers: answersOut(r.answers, allowed),
      })),
      next,
      total,
    };
    // A key's answer is never cached anywhere; an open one may be kept by the
    // browser, but only after asking whether it changed.
    reply.header('Cache-Control', key ? 'private, no-store' : 'no-cache');
    const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"`;
    if (!key) {
      reply.header('ETag', tag);
      if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    }
    return body;
  }

  app.get('/_pammy/api/forms/by-name/:name/:scope', apiResponses);
  app.get('/_pammy/api/forms/by-name/:name/:scope/filterby/:field/:value', apiResponses);
  app.get('/_pammy/api/forms/:id/:scope', apiResponses);
  app.get('/_pammy/api/forms/:id/:scope/filterby/:field/:value', apiResponses);
}
