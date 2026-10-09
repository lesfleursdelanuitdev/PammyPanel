// Comments (docs/comments-plan.md): a comment area is a form (C1) and a comment
// is a response with a thread. Everything a form has -- the honeypot, 10 an
// hour, 64 KB, the caps, Approve -- applies unchanged; this only adds which
// thread, and a public read.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAnswerType } from '@panel/forms/shared/form-types';
import { API_LIMIT, type GateCtx } from '@panel/core/gate/context';
import { answersOut, type FormPages, type PageTarget } from '@panel/forms/gate/form-use';
import { addResponse, decodeCursor, type Response, type Thread } from '@panel/forms/gate/forms/responses';
import type { Form } from '@panel/forms/gate/forms/store';
import { queryThread, threadCounts } from '@panel/forms/gate/forms/threads';
import { decide } from '@panel/areas/gate/policy';
import { saveResponse } from '@panel/form-links/gate/saves/save';
import { logEvent } from '@panel/core/gate/ops';

export function registerComments(ctx: GateCtx, { formUse, pageResolved, publicItems, notePage, noForm }: FormPages) {
  const { app, cfg, db, now, limiter, hostOf, ipOf, baseOf, visitorOf, refuse, tooMany, post } = ctx;

  // A page is known by its file (amendments): the address resolved to the real
  // file, a folder's index.html filled in, so /about/ and /about/index.html are
  // one conversation.
  // A service's page (lfdln, docs/phase8-plan.md 8-6) has no file: its address is its name.
  const pageId = (target: PageTarget): string => {
    if (!target.resolved.real) return target.rel;
    try {
      if (target.resolved.kind === 'ok' && statSync(target.resolved.real).isDirectory()) {
        return target.rel === '/' ? 'index.html' : `${target.rel}/index.html`;
      }
    } catch { /* gone since: its path is still its name */ }
    return target.rel;
  };
  const CONTENT_ID_RE = /^[A-Za-z0-9._~:@/+-]{1,200}$/;
  // Which conversation a request is about (C4, C5). A page area: the page's own
  // file, or an id of hers given as content-id. An area about a table: its
  // content-id, which it must have -- never the page, or every post on a
  // blog.html?id=12 template would share one thread.
  function threadFor(form: Form, target: PageTarget, content: unknown): Thread | string {
    const given = typeof content === 'number' && Number.isSafeInteger(content) ? String(content)
      : typeof content === 'string' ? content.trim() : '';
    if (given && !CONTENT_ID_RE.test(given)) return 'That content-id has characters it cannot have.';
    if (form.contentType === 'page') return { type: 'page', id: given || pageId(target) };
    if (!given) return `This comment area is about ${form.contentType}, so the page has to say which one: content-id="...".`;
    return { type: form.contentType, id: given };
  }
  // The area, the page it is on, and who is asking: formUse's checks (switched
  // on, in scope, a page this visitor may open, signed in if it must be), for
  // a comment area, on a page that really exists (C13: decide() needs one).
  // The example pages the gate serves itself (/_pammy/examples/<kind>/) are
  // not files of her website, and are public: an example's comment area (a
  // fixture) may be used on them, known by that address.
  const EXAMPLE_PAGE_RE = /^\/_pammy\/examples\/([a-z-]{1,40})\/(index\.html)?$/;
  const exampleTarget = (form: Form, page: unknown): PageTarget | null => {
    const m = typeof page === 'string' && form.fixture ? EXAMPLE_PAGE_RE.exec(page) : null;
    // (no file, no protections: nothing is ever decided on it -- see pageAllowed)
    return m ? { resolved: { kind: 'ok', real: '', exists: false, protections: [] }, rel: `_pammy/examples/${m[1]}/index.html` } : null;
  };
  async function commentUse(req: FastifyRequest, reply: FastifyReply, host: string, base: string, name: unknown, page: unknown, content: unknown) {
    const use = await formUse(req, reply, host, base, name, page);
    if (!use) return null;
    if (use.form.kind !== 'comments') { void noForm(reply); return null; }
    const target = use.target ?? exampleTarget(use.form, page);
    if (!target) { void reply.code(400).send({ error: 'no-page', message: "This page can't be found, so its comments can't be shown." }); return null; }
    const thread = threadFor(use.form, target, content);
    if (typeof thread === 'string') { void reply.code(400).send({ error: 'no-content', message: thread }); return null; }
    return { ...use, target, thread };
  }
  // A comment sent from a page this visitor may not open stays behind that
  // page, wherever else its thread is shown (a content-id is shared by pages).
  const pageAllowed = async (req: FastifyRequest, host: string) => {
    const s = await visitorOf(req, host);
    const known = new Map<string, boolean>();
    return (page: string) => {
      // the gate's own example pages are public
      if (page.startsWith('_pammy/examples/')) return true;
      if (!known.has(page)) known.set(page, decide(pageResolved(page), s).allow);
      return known.get(page)!;
    };
  };
  // What a page shows of one comment (C13): its public answers only, and who
  // wrote it -- a signed-in visitor's name from the session (C18), otherwise
  // the first public name or short answer. Never the email, the address it
  // came from, whether she has read it, or the page it was sent from.
  const commentOut = (form: Form, r: Response) => {
    const shown = form.items.filter((i) => isAnswerType(i.type) && i.public);
    const allowed = new Set(shown.map((i) => i.key!));
    const answers = answersOut(r.answers, allowed);
    const authorItem = shown.find((i) => i.type === 'name' || i.type === 'short-text');
    const bodyItem = shown.find((i) => i.type === 'long-text');
    const said = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v as Record<string, string>).filter(Boolean).join(' ') : v ? String(v) : '');
    return {
      id: r.id,
      sentAt: new Date(r.createdAt * 1000).toISOString().replace('.000', ''),
      author: r.sender ? (r.sender.name || r.sender.username) : authorItem ? said(answers[authorItem.key!]) : '',
      body: bodyItem ? said(answers[bodyItem.key!]) : '',
      answers,
    };
  };

  app.get('/_pammy/comments/:name', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    if (!limiter.take(`comments-ip:${ipOf(req)}`, API_LIMIT.open, 60)) return tooMany(reply, 'a minute');
    const q = req.query as Record<string, unknown>;
    const use = await commentUse(req, reply, host, base, (req.params as { name: string }).name, q.page, q.content);
    if (!use) return reply;
    const order = q.order === 'oldest' ? 'asc' : 'desc';
    const per = Math.min(100, Math.max(1, Number(q.per) || 20));
    const after = typeof q.after === 'string' ? decodeCursor(q.after) : null;
    const { rows, totals, next } = await queryThread(db, { formId: use.form.id, thread: use.thread, order, limit: per, after: after && after.o === order ? after : null });
    const may = await pageAllowed(req, host);
    const visible = rows.filter((r) => may(r.page));
    const body = {
      area: { name: use.form.name, title: use.form.title },
      content: use.thread.id,
      open: use.form.enabled,
      comments: visible.map((r) => commentOut(use.form, r)),
      // B7/W8: the whole thread, minus every page this visitor may not see --
      // not just the ones left out of the page of comments being sent back.
      total: totals.reduce((n, t) => n + (may(t.page) ? t.n : 0), 0),
      next,
    };
    // anyone may read these, so a page asking again costs a 304
    reply.header('Cache-Control', 'no-cache');
    const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"`;
    reply.header('ETag', tag);
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return body;
  });

  app.get('/_pammy/comments/:name/form', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const q = req.query as Record<string, unknown>;
    const use = await commentUse(req, reply, host, base, (req.params as { name: string }).name, q.page, q.content);
    if (!use) return reply;
    notePage(use.form, use.target);
    return {
      name: use.form.name, title: use.form.title,
      items: publicItems(use.form.items, base),
      submitText: use.form.settings.submitText, sentText: use.form.settings.sentText,
      signedInAs: use.sender?.username ?? null,
    };
  });

  app.post('/_pammy/comments/:name', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const c = post(req, reply);
    if (!c) return reply;
    const { host, base, ip, body } = c;
    const use = await commentUse(req, reply, host, base, (req.params as { name: string }).name, body.page, body.content);
    if (!use) return reply;
    if (typeof body.website === 'string' && body.website !== '') {
      await logEvent(db, now(), 'form-spam', { host, ip });
      return { ok: true };
    }
    if (!limiter.take(`form-ip:${ip}`, 10, 3600)) return tooMany(reply, 'an hour');
    let responseId: number;
    try {
      responseId = await addResponse(db, now(), use.form, use.target.rel, body.answers, use.sender, host, ip, use.thread);
    } catch (e) {
      return refuse(reply, e);
    }
    await logEvent(db, now(), 'form-response', { visitorId: use.sender?.visitorId ?? null, username: use.sender?.username ?? null, host, ip });
    saveResponse(db, now(), cfg.pammydbSocket, responseId)
      .catch((e: unknown) => app.log.warn({ err: e }, 'saving a comment in a database failed'));
    // C15: it waits for her OK -- the page says so rather than showing it
    return { ok: true, waiting: true };
  });

  app.get('/_pammy/comments/:name/counts', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    if (!limiter.take(`comments-ip:${ipOf(req)}`, API_LIMIT.open, 60)) return tooMany(reply, 'a minute');
    const q = req.query as Record<string, unknown>;
    const asked = typeof q.content === 'string' && q.content ? q.content.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100) : [];
    // one thread to make sure the area, the page and the visitor are all right
    const use = await commentUse(req, reply, host, base, (req.params as { name: string }).name, q.page, asked[0]);
    if (!use) return reply;
    const ids = asked.length ? asked : [use.thread.id];
    if (ids.some((x) => !CONTENT_ID_RE.test(x))) return reply.code(400).send({ error: 'no-content', message: 'One of those content ids has characters it cannot have.' });
    const may = await pageAllowed(req, host);
    const counts: Record<string, number> = Object.fromEntries(ids.map((x) => [x, 0]));
    for (const r of await threadCounts(db, use.form.id, use.thread.type, ids)) if (may(r.page)) counts[r.content_id] = (counts[r.content_id] ?? 0) + Number(r.n);
    reply.header('Cache-Control', 'no-cache');
    return { area: use.form.name, counts };
  });
}
