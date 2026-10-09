// Comments in her apps (docs/comments-plan.md): the comments tables a database
// gets when she says it takes comments, and the area that fills them.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '@panel/studio/panel/studio';
import { commentAreas } from '../comment-areas.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { ENGINE_NAMES, NAME_RE, isEngine } from '@panel/studio/pammydb/ident';
import { type FormFull, type FormSummary, type FormsState } from '@panel/core/panel/gate-shapes';
import { run, tx } from '@panel/core/pg';
import { buildCatalog } from '@panel/studio/studio/catalog';
import { COMMENT_RESOURCES, linkResource, linkTableFor, withCommentLink, withCommentTables } from '../../studio/comments-tables.ts';
import { saveField, saveResource } from '@panel/studio/studio/resource-store';
import { saveDraft } from '@panel/studio/studio/schema';
import type { StudioCtx } from '@panel/studio/panel/studio-ctx';
import { isKept } from '@panel/core/panel/rights';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  const { db, now, need, body, idParam, actorOf, gate, engineParam, dbNameParam, tableParam } = ctx;
  const { managed, changeable, schemaFor, appFor, refreshCatalog } = studioFor(ctx);
  const { linkCommentArea } = commentAreas(ctx);

    // ---------------------------------------------------------------- comments in her apps
    // (docs/comments-plan.md C8-C11, A1-A3). Both switches draw tables into the
    // draft and send her to Review: nothing reaches her database until she
    // presses Apply. What the app says about the new tables is written now, so
    // they arrive in the app, and in the catalog the gate checks every copy
    // against, the moment Apply makes them.
    app.post('/api/databases/:engine/:name/comments', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await changeable(a, engine, name);
      if (row.example) throw new AccountError("The examples can't be changed like this.", 403);
      const view = await schemaFor(a, engine, name);
      const draft = withCommentTables(view.draft);
      await tx(db, async (q) => {
        await saveDraft(q, { databaseId: row.id, draft, basedOn: view.currentHash, at: now(), by: a.user.username });
        for (const [table, { patch, fields }] of Object.entries(COMMENT_RESOURCES)) {
          await saveResource(q, row.id, table, patch);
          for (const [field, fp] of Object.entries(fields ?? {})) await saveField(q, row.id, table, field, fp);
        }
      });
      // C9: and a comment area for it, already keeping its copy here -- the gate
      // checks each copy against the catalog when it writes, so until Apply makes
      // the tables it simply says the tables are not there yet
      const areaName = `${name.replace(/_/g, '-')}-comments`.slice(0, 64);
      const st = await gate<FormsState>({ op: 'forms.state' });
      const area: FormSummary = st.forms.find((f) => f.name === areaName)
        ?? await gate<FormSummary>({ op: 'form.create', name: areaName, title: `Comments (${row.display_name || name})`, kind: 'comments', contentType: 'page', actor: a.user.username });
      if (area.kind === 'comments') await linkCommentArea(a, area.id, row.id, engine, name);
      await logActivity(db, now(), actorOf(a, req), 'comments-switched-on', `${ENGINE_NAMES[engine]}: ${name}`, `area ${areaName}`);
      return { ok: true, review: `/databases/${engine}/${name}/review`, area: areaName };
    });

    // C10: "People can comment on these" on one of her tables: a link table,
    // one conversation per record, drawn into the draft (and the shared tables
    // too, if they are not there yet).
    app.post('/api/databases/:engine/:name/app/:table/commentable', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const table = tableParam(req);
      const { row } = await changeable(a, engine, name);
      if (row.example) throw new AccountError("The examples can't be changed like this.", 403);
      const view = await schemaFor(a, engine, name);
      let draft;
      try { draft = withCommentLink(view.draft, table); } catch (e) { throw new AccountError(`${(e as Error).message}.`, 400); }
      const link = linkTableFor(table);
      await tx(db, async (q) => {
        await saveDraft(q, { databaseId: row.id, draft, basedOn: view.currentHash, at: now(), by: a.user.username });
        for (const [t, { patch, fields }] of Object.entries(COMMENT_RESOURCES)) {
          await saveResource(q, row.id, t, patch);
          for (const [field, fp] of Object.entries(fields ?? {})) await saveField(q, row.id, t, field, fp);
        }
        await saveResource(q, row.id, link, linkResource(table).patch);
      });
      await logActivity(db, now(), actorOf(a, req), 'comments-switched-on', `${ENGINE_NAMES[engine]}: ${name}`, `on ${table}`);
      return { ok: true, review: `/databases/${engine}/${name}/review`, table: link };
    });

    // A comment area keeping its copy in an app's comments tables (A1, A2): its
    // author and its words, once approved, following approval both ways.

    // Choosing, on Comments, which app keeps an area's copy -- or none.
    app.post('/api/forms/:id/comments-copy', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (isKept(a.user)) throw new AccountError('Not found.', 404);
      const f = await gate<FormFull>({ op: 'form.get', id: idParam(req, 'id') });
      if (f.kind !== 'comments') throw new AccountError('That is not a comment area.', 400);
      const b = body(req);
      if (b.engine === null || b.engine === undefined) {
        await gate({ op: 'formlink.drop', id: f.id });
        await logActivity(db, now(), actorOf(a, req), 'form-unlinked', f.name, null);
        return { ok: true };
      }
      if (!isEngine(b.engine) || typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw new AccountError('Which database?', 400);
      const { row } = await changeable(a, b.engine, b.name);
      const view = await appFor(a, b.engine, b.name);
      const ok = (t: string) => view.resources.some((r) => r.table === t && r.enabled && r.can.create && r.can.edit);
      if (!ok('comments') || !ok('comment_threads')) {
        throw new AccountError(`${row.display_name || b.name} has no comments tables yet: switch "This ${APP.one} takes comments" on for it, and Apply.`, 400);
      }
      await refreshCatalog(a, b.engine, b.name);
      await linkCommentArea(a, f.id, row.id, b.engine, b.name);
      await logActivity(db, now(), actorOf(a, req), 'form-linked', f.name, `keeps its comments in ${b.name}`);
      return { ok: true };
    });

    // The two switches that put something on the internet. Separate from
    // Activate on purpose (D9): switching the app on gives her pages, and these
    // two give programs a way in.
    app.post('/api/databases/:engine/:name/api', { config: { needs: 'programs' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await changeable(a, engine, name);
      if (row.status !== 'active') {
        throw new AccountError(`Switch the ${APP.one} on first, then programs can be let in.`, 400);
      }
      const sent = body(req);
      const read = typeof sent.read === 'boolean' ? sent.read : row.api_read === 1;
      const write = typeof sent.write === 'boolean' ? sent.write : row.api_write === 1;
      // writing without reading is a shape nobody wants and every client would
      // trip over, so it is not offered
      if (write && !read) throw new AccountError('A program that may change records has to be able to read them too.', 400);
      await tx(db, (q) => run(q, 'UPDATE studio_databases SET api_read = ?, api_write = ? WHERE id = ?',
        read ? 1 : 0, write ? 1 : 0, row.id));
      await refreshCatalog(a, engine, name);
      await logActivity(db, now(), actorOf(a, req), 'database-api-changed', `${ENGINE_NAMES[engine]}: ${name}`,
        read ? (write ? 'programs may read and change' : 'programs may read') : 'programs are shut out');
      return { ok: true, ...await appFor(a, engine, name) };
    });

    // Keys live with the gate, beside the form keys, because the gate is what
    // checks them (src/gate/studio.ts).
    app.get('/api/databases/:engine/:name/keys', { config: { needs: 'programs' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const listed = await gate<{ keys: unknown[] }>({ op: 'appkeys.list', databaseId: row.id });
      // Where a program asks: the addresses the gate answers on. Worked out by
      // the same buildCatalog the gate is pushed (pushCatalog), so the page
      // cannot name an address the gate does not have -- and empty while the
      // app is off, because then the gate holds nothing at all.
      const served = row.status === 'active'
        ? buildCatalog((await appFor(a, engine, name)).resources).resources.map((r) => ({ plural: r.plural, slug: r.slug }))
        : [];
      return { ...listed, served };
    });

    app.post('/api/databases/:engine/:name/keys', { config: { needs: 'programs' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await changeable(a, engine, name);
      if (row.status !== 'active') throw new AccountError(`Switch the ${APP.one} on before making a key for it.`, 400);
      const sent = body(req);
      const made = await gate<{ key: string; appKey: { label: string } }>({
        op: 'appkey.create', databaseId: row.id, label: sent.label,
        resources: sent.resources ?? 'all', canWrite: sent.canWrite === true, actor: a.user.username,
      });
      await logActivity(db, now(), actorOf(a, req), 'app-key-made', `${ENGINE_NAMES[engine]}: ${name}`,
        `"${made.appKey.label}", ${sent.canWrite === true ? 'it can read and change' : 'it can read'}`);
      return made;
    });

    app.post('/api/databases/:engine/:name/keys/:id/revoke', { config: { needs: 'programs' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      await managed(a, engine, name);
      const gone = await gate<{ label: string }>({ op: 'appkey.revoke', id: (req.params as { id: string }).id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'app-key-revoked', `${ENGINE_NAMES[engine]}: ${name}`, gone.label);
      return { ok: true };
    });


}
