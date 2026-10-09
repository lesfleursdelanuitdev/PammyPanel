// Designing a table (docs/databases-plan.md 8 and 10): introspect, the draft
// she is drawing, the canvas, connections, and Apply.
//
// The panel keeps the draft and works out what it would mean; the helper reads
// the engine, prints the SQL and runs it. Neither does the other's job, which is
// why the SQL under Advanced on Review is the same SQL Apply runs -- it comes
// back from the helper, it is not rendered twice.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError } from '@panel/core/accounts';
import { tx } from '@panel/core/pg';
import { checkLayout, forget, getLayoutRow, isView, placed, readLayout, renamedIn, saveLayout, tidy } from '../../studio/layout.ts';
import { addRelationship, checkSpec, checkWhere, isOnDelete, removeRelationship, setOnDelete } from '../../studio/relationships.ts';
import { checkDraft, discardDraft, saveDraft } from '../../studio/schema.ts';
import type { StudioCtx } from '../studio-ctx.ts';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const { db, now, need, body, engineParam, dbNameParam } = ctx;
  const { managed, schemaFor } = studioFor(ctx);

    // ---------------------------------------------------------------- the shape of a database
    // Introspect, the draft she is drawing, and Apply (docs/databases-plan.md 8
    // and 10). The panel keeps the draft and works out what it would mean; the
    // helper reads the engine, prints the SQL and runs it. Neither does the
    // other's job, which is why the SQL under Advanced on Review is the same SQL
    // Apply runs -- it comes back from the helper, it is not rendered twice.
    app.get('/api/databases/:engine/:name/schema', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return schemaFor(a, engineParam(req), dbNameParam(req));
    });

    // Saving the drawing changes nothing in her database: it is a note of what she
    // would like, and it is why Apply is a separate press (plan 8, "the canvas is
    // an editor; Apply is the moment of truth").
    app.post('/api/databases/:engine/:name/schema/draft', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const sent = body(req);
      const { draft, basedOn } = checkDraft(sent, engine, name);
      // renaming a table from the canvas: its position goes with it (layout.ts)
      const r = (sent.renamed ?? {}) as { from?: unknown; to?: unknown; at?: unknown };
      const moved = typeof r.from === 'string' && typeof r.to === 'string'
        ? renamedIn(readLayout(await getLayoutRow(db, row.id)), draft, r.from, r.to, r.at)
        : null;
      await tx(db, async (q) => {
        await saveDraft(q, { databaseId: row.id, draft, basedOn, at: now(), by: a.user.username });
        if (moved) await saveLayout(q, { databaseId: row.id, layout: moved, at: now(), by: a.user.username });
      });
      return { ok: true, ...await schemaFor(a, engine, name) };
    });

    app.post('/api/databases/:engine/:name/schema/discard', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      await tx(db, (q) => discardDraft(q, row.id));
      return { ok: true, ...await schemaFor(a, engine, name) };
    });

    // Where she dragged the rectangles to. Not a change to the database and not
    // part of the draft, so it saves on its own and survives Discard
    // (docs/databases-plan.md 6, "positions are remembered").
    app.post('/api/databases/:engine/:name/schema/layout', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      const sent = body(req);
      // Either half may be left out: dragging a table sends positions, and the
      // simple/expanded switch sends only itself rather than every position back.
      const positions = sent.layout === undefined
        ? view.layout
        : forget(checkLayout(sent.layout), view.draft);
      const layout = { ...positions, manyToMany: isView(sent.manyToMany) ? sent.manyToMany : view.layout.manyToMany };
      await tx(db, (q) => saveLayout(q, { databaseId: row.id, layout, at: now(), by: a.user.username }));
      return { ok: true, layout: placed(view.draft, layout) };
    });

    // "Tidy up": lay the whole drawing out again in reading order. Worked out
    // here rather than in the browser so the canvas and a first visit arrange
    // tables the same way (src/studio/layout.ts).
    app.post('/api/databases/:engine/:name/schema/tidy', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      const layout = tidy(view.draft, view.layout.manyToMany);
      await tx(db, (q) => saveLayout(q, { databaseId: row.id, layout, at: now(), by: a.user.username }));
      return { ok: true, layout };
    });

    // Connecting two fields (docs/databases-plan.md 7). Worked out on the server
    // because a many-to-many means inventing a table, and that is not a thing to
    // write twice; every refusal comes back in her words with a 400.
    app.post('/api/databases/:engine/:name/schema/relationship', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      const draft = addRelationship(view.draft, checkSpec(body(req)));
      await tx(db, (q) => saveDraft(q, { databaseId: row.id, draft, basedOn: view.currentHash, at: now(), by: a.user.username }));
      return { ok: true, ...await schemaFor(a, engine, name) };
    });

    // Only what happens when a row on the "one" side is deleted. Its own route,
    // because drawing the relationship again would refuse (it is already there)
    // and rebuilding it would throw away a connecting table she may have added to.
    app.post('/api/databases/:engine/:name/schema/relationship/on-delete', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      const sent = body(req);
      if (!isOnDelete(sent.onDelete)) throw new AccountError('Pick what should happen when a row is deleted.', 400);
      const draft = setOnDelete(view.draft, checkWhere(sent), sent.onDelete);
      await tx(db, (q) => saveDraft(q, { databaseId: row.id, draft, basedOn: view.currentHash, at: now(), by: a.user.username }));
      return { ok: true, ...await schemaFor(a, engine, name) };
    });

    // Taking one off the drawing. For a many-to-many that is the connecting
    // table, which is why the page says so before asking for this.
    app.post('/api/databases/:engine/:name/schema/relationship/delete', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      const draft = removeRelationship(view.draft, checkWhere(body(req)));
      await tx(db, (q) => saveDraft(q, { databaseId: row.id, draft, basedOn: view.currentHash, at: now(), by: a.user.username }));
      return { ok: true, ...await schemaFor(a, engine, name) };
    });


}
