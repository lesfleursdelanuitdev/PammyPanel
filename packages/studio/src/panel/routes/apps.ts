// The Application tab (docs/databases-plan.md 11) and the data API's settings:
// what her tables mean, which fields programs may see, and who may read them.
// Inference every time, with her overrides on top -- so a table she has never
// looked at is proposed rather than managed.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { ENGINE_NAMES, type Engine } from '../../pammydb/ident.ts';
import { type GateState, areaOf } from '@panel/core/panel/gate-shapes';
import { all, run, tx } from '@panel/core/pg';
import { forgetResource, resourceRows, saveField, saveOrder, saveResource } from '../../studio/resource-store.ts';
import { checkFieldPatch, checkOrder, checkPublicOnly, checkResourcePatch, checkVisitors, pluralName, refuseIfBlind } from '../../studio/resources.ts';
import { plural } from '@panel/core/util';
import type { StudioCtx } from '../studio-ctx.ts';
import { isKept } from '@panel/core/panel/rights';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const { config, db, now, need, body, idParam, actorOf, gate, helper, studio, dateOf, engineParam, dbNameParam, tableParam, fieldParam, appNameOf } = ctx;
  const { dashboard, cardFor, managed, studioSlow, liveSchema, schemaFor, appFor, resourceOf, pushCatalog, refreshCatalog } = studioFor(ctx);
  const { refuseExample } = ctx;

    // ------------------------------------------------------------ the Application tab
    // What her tables mean (docs/databases-plan.md 11), and the data API's
    // settings. Inference every time, with her overrides on top.
    app.get('/api/databases/:engine/:name/app', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return appFor(a, engineParam(req), dbNameParam(req));
    });


    app.post('/api/databases/:engine/:name/app/:table/settings', { config: { needs: 'databases' } }, async (req, reply) => {
      const patch = checkResourcePatch(body(req));
      // "Anyone can read these" publishes, so turning it on asks for the passkey
      // again, like the media label switch (docs/db-examples-plan.md X1)
      // -- and so does letting people signed in to a folder change them (V7)
      const a = await need(req, reply, { fresh: patch.publicRead === true || !!patch.visitorArea });
      if (!a) return reply;
      if (isKept(a.user) && (patch.visitorArea !== undefined || patch.visitorOwner !== undefined)) throw new AccountError('Not found.', 404);
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const table = tableParam(req);
      const { row } = await managed(a, engine, name);
      const view = resourceOf(await appFor(a, engine, name), table);
      checkPublicOnly(view, patch);
      checkVisitors(view, patch);
      // V3: only a folder that is protected now
      if (patch.visitorArea) areaOf(await gate<GateState>({ op: 'state' }), patch.visitorArea);
      await tx(db, (q) => saveResource(q, row.id, table, patch));
      await refreshCatalog(a, engine, name);
      return { ok: true, ...await appFor(a, engine, name) };
    });

    app.post('/api/databases/:engine/:name/app/:table/fields/:field/settings', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const table = tableParam(req);
      const field = fieldParam(req);
      const { row } = await managed(a, engine, name);
      const view = resourceOf(await appFor(a, engine, name), table);
      if (!view.fields.some((f) => f.name === field)) throw new AccountError('There is no field by that name.', 404);
      const patch = checkFieldPatch(body(req));
      // a window she cannot see through is not a window
      refuseIfBlind(view, field, patch);
      await tx(db, (q) => saveField(q, row.id, table, field, patch));
      await refreshCatalog(a, engine, name);
      return { ok: true, ...await appFor(a, engine, name) };
    });

    // The order of the form (docs/field-order-plan.md O8): the whole list, from
    // the page, checked against the table. [] puts the table's own order back.
    app.post('/api/databases/:engine/:name/app/:table/order', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const table = tableParam(req);
      const { row } = await managed(a, engine, name);
      const order = checkOrder(resourceOf(await appFor(a, engine, name), table), body(req));
      await tx(db, (q) => saveOrder(q, row.id, table, order));
      await refreshCatalog(a, engine, name);
      return { ok: true, ...await appFor(a, engine, name) };
    });

    // Start this one again: forget what she said and let inference speak. Loses
    // opinions, never data, which is why it asks but does not want a passkey.
    app.post('/api/databases/:engine/:name/app/:table/forget', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const table = tableParam(req);
      const { row } = await managed(a, engine, name);
      await tx(db, (q) => forgetResource(q, row.id, table));
      await refreshCatalog(a, engine, name);
      return { ok: true, ...await appFor(a, engine, name) };
    });




}

// Switching the app on, and what that means for the gate (the catalog it
// serves programs from). Part of the Application tab; kept in its own function
// so that the routes stay registered where they were.
export function switchRoutes(app: FastifyInstance, ctx: StudioCtx) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  const { config, db, now, need, body, idParam, actorOf, gate, helper, studio, dateOf, engineParam, dbNameParam, tableParam, fieldParam, appNameOf } = ctx;
  const { dashboard, cardFor, managed, changeable, studioSlow, liveSchema, schemaFor, appFor, resourceOf, pushCatalog, refreshCatalog } = studioFor(ctx);
  const { refuseExample } = ctx;

    // ------------------------------------------------------- switching the app on
    // Activate publishes the ticked Resources as pages (docs/databases-plan.md
    // 11.6). It does not copy data and it does not put anything on the internet:
    // the API switches are separate and both start off.
    app.post('/api/databases/:engine/:name/activate', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await changeable(a, engine, name);
      const view = await appFor(a, engine, name);
      const on = view.resources.filter((r) => r.enabled);
      if (on.length === 0) {
        throw new AccountError(`Tick at least one table to manage before switching the ${APP.one} on.`, 400);
      }
      // Switching it on WRITES DOWN what is managed, rather than leaving it to
      // inference. Two reasons, and both matter:
      //   * the menu can then be built from the panel's own tables, so a sleeping
      //     engine never holds up every page;
      //   * a table added later does not silently appear in her menu -- it turns
      //     up as proposed on this tab, which is the rule (docs/studio-plan.md,
      //     "do not silently add a menu item on an active app").
      await tx(db, async (q) => {
        for (const r of on) await saveResource(q, row.id, r.table, { enabled: true });
        await run(q, 'UPDATE studio_databases SET status = ?, activated_at = ? WHERE id = ?', 'active', now(), row.id);
      });
      await refreshCatalog(a, engine, name);
      await logActivity(db, now(), actorOf(a, req), 'database-activated', `${ENGINE_NAMES[engine]}: ${name}`,
        `${plural(on.length, 'table')} to manage`);
      return { ok: true, ...await appFor(a, engine, name) };
    });

    // Deactivate hides the app; it does not drop anything (D15). Her Resource
    // definitions stay, so switching it on again does not lose her labels.
    app.post('/api/databases/:engine/:name/deactivate', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      await refuseExample(engine, name, 'switched off');
      const { row } = await managed(a, engine, name);
      // Switching off also shuts the API: the gate forgets the catalog and every
      // key for it stops working at the same moment. Her data, her tables and
      // her Resource definitions are all untouched (D15).
      await tx(db, (q) => run(q, 'UPDATE studio_databases SET status = ?, api_read = 0, api_write = 0 WHERE id = ?', 'inactive', row.id));
      await refreshCatalog(a, engine, name);
      await logActivity(db, now(), actorOf(a, req), 'database-deactivated', `${ENGINE_NAMES[engine]}: ${name}`,
        'the pages are gone, and so is the way in for programs; the data and the schema are not');
      return { ok: true, ...await appFor(a, engine, name) };
    });

    // The apps that are switched on, for the menu (docs/databases-plan.md 11.6:
    // "the menu grows a group named from the application display name"). Read
    // from the panel's own tables only -- the menu must not wait on an engine,
    // or a sleeping database would hold up every page.
    app.get('/api/apps', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const rows = await all<{ id: number; engine: Engine; name: string; display_name: string }>(db,
        // not the examples' apps: they are opened from their example page (docs/db-examples-plan.md X6)
        "SELECT id, engine, name, display_name FROM studio_databases WHERE status = 'active' AND example IS NULL ORDER BY lower(display_name), name");
      const apps = [];
      for (const row of rows) {
        const saved = await resourceRows(db, row.id);
        // only what she has ticked: inference cannot add a menu item by itself
        // on an app that is already switched on
        const things = saved.filter((r) => r.enabled).map((r) => ({
          table: r.table_name,
          // her words if she typed any, and otherwise the same guess the
          // Application tab shows -- never the bare table name
          plural: r.plural || pluralName(r.table_name),
        }));
        apps.push({ engine: row.engine, name: row.name, title: row.display_name || row.name, things });
      }
      return { apps };
    });


}
