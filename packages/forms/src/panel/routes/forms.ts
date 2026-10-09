// Forms, the responses visitors send and the worked examples (the API keys
// are @panel/api-keys' since docs/catalog-plan.md step 3c).
// They all live in the gate (it serves the public side); the panel checks who
// is asking, logs what was done, and passes the answer on.
import type { FastifyInstance } from 'fastify';
import type { FormSummary, FormsState } from '@panel/core/panel/gate-shapes';
import { AccountError, logActivity } from '@panel/core/accounts';
import { isKept, keptTo } from '@panel/core/panel/rights';
import { type Authed } from '@panel/core/sessions';
import type { PanelCtx } from '@panel/core/panel/context';
import { isOn } from '@panel/core/profile';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, body, idParam, actorOf, gate, helper } = ctx;

    // ---------------------------------------------------------------- forms and responses
    // Forms and the responses visitors send live in the gate
    // (it serves the public side). The panel checks who is asking and logs it.
    const formOf = async (a: Authed, id: number) => {
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.get', id });
      return f;
    };

    app.get('/api/forms', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return gate<FormsState>({ places: keptTo(a.user), op: 'forms.state' });
    });

    // What a new form can start from, without the examples module (docs/phase8-plan.md 8-5):
    // the gate's starters, which are the forms module's own
    app.get('/api/forms/starters', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return gate<{ starters: { kind: string; label: string; about: string }[] }>({ places: keptTo(a.user), op: 'starters' });
    });

    // The folders a form can be kept to (the website's top-level folders on pammy.org, the
    // site folders on lfdln: P8-10), from the folder helper, as formScopeParam checks them
    app.get('/api/forms/scopes', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const sites = await helper<{ folders: { name: string; symlink?: boolean }[] }>({ op: 'list', actor: a.user.username });
      return { folders: sites.folders.filter((f) => !f.symlink).map((f) => f.name) };
    });

    // '/' (every page) or one of her folders, which has to be there.
    async function formScopeParam(v: unknown, user: string): Promise<string> {
      if (v === undefined || v === null || v === '' || v === '/') return '/';
      const folder = typeof v === 'string' ? v.replace(/^\/+|\/+$/g, '') : '';
      const sites = await helper<{ folders: { name: string }[] }>({ op: 'list', actor: user });
      if (!folder || !sites.folders.some((f) => f.name === folder)) throw new AccountError("There's no folder called that in your website.", 404);
      return `/${folder}`;
    }

    // A person kept to places makes forms that work in one of them: their only
    // one (whatever they asked, as always, D22), or the one of theirs they chose.
    function keptFormScope(a: Authed, v: unknown): string {
      const { places } = a.user;
      if (places.length === 1) return places[0]!;
      const folder = typeof v === 'string' ? v.replace(/^\/+|\/+$/g, '') : '';
      if (!folder) throw new AccountError('Choose which of your folders it works in.', 400);
      if (!places.includes(`/${folder}`)) throw new AccountError("There's no folder called that in your website.", 404);
      return `/${folder}`;
    }

    // Where a form works: everywhere, or only on one folder's pages (not for
    // people kept to places: theirs work in the place they were made in).
    app.post('/api/forms/:id/scope', { config: { needs: 'forms', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const formScope = await formScopeParam(body(req).scope, a.user.username);
      const f = await gate<FormSummary>({ op: 'form.scope', id: idParam(req, 'id'), formScope, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-scope-changed', f.name, formScope === '/' ? 'works on every page' : `works only in ${formScope.slice(1)}`);
      return { ok: true, form: f };
    });

    app.post('/api/forms', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      // where it works (D22): one of the places of a person kept to places, or
      // what the others chose (everywhere by default)
      const formScope = isKept(a.user) ? keptFormScope(a, b.scope) : await formScopeParam(b.scope, a.user.username);
      // a comment area is made here too (docs/comments-plan.md C1): kind and what it is about
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.create', name: b.name, title: b.title, items: b.items, settings: b.settings, starter: b.starter, formScope,
        ...(b.kind === 'comments' ? { kind: 'comments', contentType: typeof b.contentType === 'string' ? b.contentType : 'page' } : {}), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-created', f.name, f.title !== f.name ? f.title : null);
      return { ok: true, form: f };
    });

    app.get('/api/forms/:id', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return formOf(a, idParam(req, 'id'));
    });

    app.post('/api/forms/:id', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.save', id: idParam(req, 'id'), version: b.version, title: b.title, items: b.items, settings: b.settings, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-saved', f.name, null);
      return { ok: true, form: f };
    });

    app.post('/api/forms/:id/switches', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      // Showing approved responses to anyone publishes them, and so does approving
      // them as they arrive (together, a visitor's words go public the moment they
      // send them): a passkey check first.
      if ((b.publicApproved === true || b.autoApprove === true) && !await need(req, reply, { fresh: true })) return reply;
      const f = await gate<FormSummary & { unreviewedAuto: number }>({ places: keptTo(a.user), op: 'form.switches', id: idParam(req, 'id'), enabled: b.enabled, approvable: b.approvable, publicApproved: b.publicApproved, autoApprove: b.autoApprove, actor: a.user.username });
      const what = b.enabled !== undefined ? `switched ${f.enabled ? 'on' : 'off'}`
        : b.approvable !== undefined ? `approving responses ${f.approvable ? 'on' : 'off'}`
          : b.autoApprove !== undefined ? `new responses: ${f.autoApprove ? 'shown right away' : 'wait for approval'}`
            : `anyone can read approved responses: ${f.publicApproved ? 'on' : 'off'}`;
      await logActivity(db, now(), actorOf(a, req), 'form-switched', f.name, what);
      const { unreviewedAuto, ...form } = f;
      return { ok: true, form, unreviewedAuto };
    });

    // After "Show right away": unapprove what went up on its own and nobody has opened.
    app.post('/api/forms/:id/hide-unreviewed', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const r = await gate<{ id: number; name: string; hidden: number }>({ places: keptTo(a.user), op: 'form.hide-unreviewed', id: idParam(req, 'id') });
      await logActivity(db, now(), actorOf(a, req), 'responses-unapproved', r.name, `hid ${r.hidden} response${r.hidden === 1 ? '' : 's'} nobody had looked at`);
      return { ok: true, hidden: r.hidden };
    });

    app.get('/api/forms/:id/copy-name', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return gate<{ name: string }>({ places: keptTo(a.user), op: 'form.copy-name', id: idParam(req, 'id') });
    });

    app.post('/api/forms/:id/duplicate', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const from = await formOf(a, idParam(req, 'id'));
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.duplicate', id: from.id, name: body(req).name, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-duplicated', f.name, `copied from "${from.name}"`);
      return { ok: true, form: f };
    });

    app.post('/api/forms/:id/trash', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.trash', id: idParam(req, 'id'), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-trashed', f.name, 'restorable for 30 days; its name stays taken until then');
      return { ok: true };
    });

    app.post('/api/forms/:id/restore', { config: { needs: 'forms' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.restore', id: idParam(req, 'id'), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'form-restored', f.name, null);
      return { ok: true };
    });

    // ---- the worked examples (docs/examples-plan.md): only where the examples are on (not lfdln, P8-12)
    if (isOn(config.site, 'examples')) {
      type ExampleState = { kind: string; heading: string; pageName: string; formId: number | null; formName: string };

      app.get('/api/examples', { config: { needs: 'forms', wholeSite: true } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const [state, starters] = await Promise.all([
          gate<{ examples: ExampleState[]; maxResponses: number }>({ places: keptTo(a.user), op: 'examples.state' }),
          gate<{ starters: { kind: string; label: string; about: string }[] }>({ places: keptTo(a.user), op: 'starters' }),
        ]);
        return { ...state, ...starters, domain: config.rpID.replace(/^panel\./, '') };
      });

      app.post('/api/examples/:kind/reset', { config: { needs: 'forms', wholeSite: true } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const kind = (req.params as { kind: string }).kind;
        const f = await gate<FormSummary>({ places: keptTo(a.user), op: 'example.reset', kind, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'example-reset', f.name, 'back to its questions and its sample responses');
        return { ok: true, form: f };
      });

      // "Put this on my website": her own copy of an example's page, pointed at a
      // form of hers. The form comes first, so a half-made page can never point at
      // a form that isn't there.
      app.post('/api/examples/:kind/install', { config: { needs: 'forms', wholeSite: true } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const kind = (req.params as { kind: string }).kind;
        const b = body(req);
        const folder = typeof b.folder === 'string' ? b.folder.trim().replace(/^\/+|\/+$/g, '') : '';
        const pageName = typeof b.page === 'string' ? b.page.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9-]{0,60}\.html$/.test(pageName)) {
          return reply.code(400).send({ error: 'bad-page', message: 'The page needs a name like guestbook.html: lowercase letters, digits and hyphens.' });
        }
        let form = typeof b.formId === 'number' ? await formOf(a, b.formId) : null;
        let made = false;
        if (!form) {
          form = await gate<FormSummary>({ places: keptTo(a.user), op: 'form.create', name: b.name, starter: kind, actor: a.user.username });
          made = true;
          await logActivity(db, now(), actorOf(a, req), 'form-created', form.name, `for the ${kind} example`);
        }
        if (form.fixture) return reply.code(400).send({ error: 'fixture', message: 'That is the example itself. Make a form of your own first.' });
        const built = await gate<{ files: { path: string; content: string }[] }>({ places: keptTo(a.user), op: 'example.files', kind, formId: form.id, pageName });
        let written: { path: string; created: string[] };
        try {
          written = await helper({ op: 'install-pages', path: folder, files: built.files, actor: a.user.username });
        } catch (e) {
          // The page could not be written; a form we just made for it stays, so she
          // can try again with another name rather than losing it.
          if (made) await logActivity(db, now(), actorOf(a, req), 'form-created', form.name, 'the page it was for could not be written');
          throw e;
        }
        await logActivity(db, now(), actorOf(a, req), 'example-installed', `${written.path ? `${written.path}/` : ''}${pageName}`,
          `the ${kind} example, using the form "${form.name}"`);
        return {
          ok: true, form, madeForm: made, folder: written.path, created: written.created,
          address: `https://${config.rpID.replace(/^panel\./, '')}/${written.path ? `${written.path}/` : ''}${pageName}`,
          switchNeeded: !form.publicApproved,
        };
      });
    }

    app.get('/api/responses', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, string>;
      const num = (v: string | undefined) => (v !== undefined && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : undefined);
      return gate({
        places: keptTo(a.user), op: 'responses.list', trash: q.view === 'trash', hideExamples: q.examples === 'hide',
        read: q.read === 'unread' || q.read === 'read' ? q.read : undefined,
        approval: q.approval === 'approved' || q.approval === 'waiting' ? q.approval : undefined,
        formId: num(q.form), before: num(q.before),
      });
    });

    // Comments (docs/comments-plan.md section 4): the same rows as Responses,
    // through their own door -- waiting for her OK by default, one area or one
    // conversation at a time. Approving and trashing use the responses routes.
    app.get('/api/comments', { config: { needs: 'comments' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, string>;
      const num = (v: string | undefined) => (v !== undefined && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : undefined);
      const approval = q.view === 'shown' ? 'approved' : q.view === 'all' ? undefined : 'waiting';
      const thread = typeof q.type === 'string' && typeof q.content === 'string' && q.content ? { contentType: q.type, contentId: q.content } : {};
      const [list, st] = await Promise.all([
        gate<{ responses: unknown[]; more: boolean; trashDays: number }>({
          places: keptTo(a.user), op: 'responses.list', kind: 'comments', trash: q.view === 'trash', approval: q.view === 'trash' ? undefined : approval,
          formId: num(q.area), before: num(q.before), ...thread,
        }),
        gate<FormsState & { commentsWaiting: number }>({ places: keptTo(a.user), op: 'forms.state' }),
      ]);
      return { ...list, waiting: st.commentsWaiting, areas: st.forms.filter((f) => f.kind === 'comments') };
    });

    // Just the number, for the tab's badge.
    app.get('/api/responses/unread', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<FormsState & { commentsWaiting: number }>({ places: keptTo(a.user), op: 'forms.state' });
      // comments have their own red number (docs/comments-plan.md C6)
      return { unread: st.unread, comments: st.commentsWaiting };
    });

    // Read and unread aren't logged in Activity: they'd drown everything else.
    app.post('/api/responses/:id/read', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      await gate({ places: keptTo(a.user), op: 'response.read', id: idParam(req, 'id'), read: body(req).read === true, actor: a.user.username });
      return { ok: true };
    });

    app.post('/api/responses/read-all', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const formId = Number.isSafeInteger(body(req).formId) ? body(req).formId : null;
      return { ok: true, ...await gate<{ marked: number }>({ places: keptTo(a.user), op: 'responses.read-all', formId, actor: a.user.username }) };
    });

    app.post('/api/responses/:id/approve', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const approved = body(req).approved === true;
      const r = await gate<{ id: number; formName: string; saved?: unknown }>({ places: keptTo(a.user), op: 'response.approve', id: idParam(req, 'id'), approved, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), approved ? 'response-approved' : 'response-unapproved', r.formName, `response ${r.id}`);
      // a form that saves its answers on approval: where it went, or why not
      return { ok: true, saved: r.saved ?? null };
    });

    app.post('/api/responses/:id/trash', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const m = await gate<{ id: number; formName: string }>({ places: keptTo(a.user), op: 'response.trash', id: idParam(req, 'id'), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'response-trashed', m.formName, `response ${m.id}, restorable for 30 days`);
      return { ok: true };
    });

    app.post('/api/responses/:id/restore', { config: { needs: 'responses' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const m = await gate<{ id: number; formName: string }>({ places: keptTo(a.user), op: 'response.restore', id: idParam(req, 'id'), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'response-restored', m.formName, `response ${m.id}`);
      return { ok: true };
    });

}
