// What every page about her databases needs to ask first (docs/databases-plan.md,
// docs/refactor-plan.md phase 3): which databases there are, whether the panel
// is looking after this one, what shape it is in, what her app makes of it, and
// pushing that to the gate so programs read the same thing.
//
// The panel does not open her engines itself -- everything here asks the
// database helper (src/pammydb/) and keeps only what the panel means by the
// answer (src/studio/*). Nothing is remembered between requests: a table she has
// never looked at is proposed rather than managed, and no stale opinion is held.
import { AccountError } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { callPammyDb } from '../pammydb/client.ts';
import type { Authed } from '@panel/core/sessions';
import type { Engine } from '../pammydb/ident.ts';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { type Snapshot } from '../pammydb/ir.ts';
import { type DatabaseList } from '../pammydb/ops.ts';
import { buildCatalog } from '../studio/catalog.ts';
import { sourceCounts } from '@panel/catalog/items';
import { type DatabaseCard, getManaged, listManaged, mergeDatabases } from '../studio/databases.ts';
import { type Impact, impactOf } from '../studio/impact.ts';
import { type Layout, getLayoutRow, placed, readLayout } from '../studio/layout.ts';
import { type Relationship, relationships } from '../studio/relationships.ts';
import { fieldRows, resourceRows } from '../studio/resource-store.ts';
import { type ResourceView, pluralName, resourceViews } from '../studio/resources.ts';
import { type SchemaView, getDraftRow, schemaView } from '../studio/schema.ts';
import type { PanelCtx } from '@panel/core/panel/context';

export function studioFor(ctx: PanelCtx) {
  const { app, config, db, gate, studio } = ctx;

  // The databases right (rights.ts), which a person kept to places never has: they have
  // no databases. The panel does not open her engines itself -- everything here
  // asks the database helper (src/pammydb/) and keeps only what the panel means
  // by the answer (src/studio/databases.ts). docs/databases-plan.md 5 and 12.
  // her whole shelf: what the engines have, plus anything the panel still
  // remembers that they no longer do
  const dashboard = async (a: Authed) => {
    const [live, managed] = await Promise.all([
      studio<DatabaseList>({ op: 'list-databases', actor: a.user.username }),
      listManaged(db),
    ]);
    return { databases: mergeDatabases(live.databases, managed, live.engines), engines: live.engines };
  };

  const cardFor = async (a: Authed, engine: Engine, name: string): Promise<DatabaseCard> => {
    const all = await dashboard(a);
    const card = all.databases.find((d) => d.engine === engine && d.name === name);
    if (!card) throw new AccountError('Not found.', 404);
    return card;
  };

  // Introspect, the draft she is drawing, and Apply (docs/databases-plan.md 8
  // and 10). The panel keeps the draft and works out what it would mean; the
  // helper reads the engine, prints the SQL and runs it. Neither does the
  // other's job, which is why the SQL under Advanced on Review is the same SQL
  // Apply runs -- it comes back from the helper, it is not rendered twice.
  const managed = async (a: Authed, engine: Engine, name: string) => {
    const card = await cardFor(a, engine, name);
    if (!card.managed) throw new AccountError('The panel is not looking after that database yet. Pick it up on Your databases first.', 404);
    if (card.live !== true) throw new AccountError('That database is not on the server just now, so the panel cannot open it.', 503);
    const row = await getManaged(db, engine, name);
    if (!row) throw new AccountError('Not found.', 404);
    return { card, row };
  };
  // ...and one the panel may build on: a database app, programs let in, keys, tags, comments.
  // Never a service's (docs/lfdln-mariadb-plan.md finding 8): it is looked inside, never handed out.
  const changeable = async (a: Authed, engine: Engine, name: string) => {
    const m = await managed(a, engine, name);
    if (m.card.appOwned) throw new AccountError(`"${name}" belongs to a service, which looks after it: the panel shows it, and reads it, but never builds on it or lets programs in.`, 403);
    return m;
  };

  // Introspect and Apply can take a while on an adopted database, so they get
  // the longer end of the helper's own timeout rather than the 15s default
  // (docs/studio-plan.md S3 and the 10s socket finding).
  const studioSlow = async <T>(req: Record<string, unknown>): Promise<T> => {
    try {
      return await callPammyDb<T>(config.pammydbSocket, req, 110_000);
    } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };

  const liveSchema = (a: Authed, engine: Engine, name: string) =>
    studioSlow<Snapshot & { hash: string }>({ op: 'introspect', engine, name, actor: a.user.username });

  // The canvas needs the drawing and where the rectangles are in one go: two
  // requests would draw the tables at the origin and then jump them into place.
  const schemaFor = async (a: Authed, engine: Engine, name: string): Promise<SchemaView & {
    layout: Layout; relationships: Relationship[]; app: Impact | null;
    tagsLost: { table: string; plural: string; labelled: number }[];
  }> => {
    const { row } = await managed(a, engine, name);
    const [current, draftRow, layoutRow, saved] = await Promise.all([
      liveSchema(a, engine, name), getDraftRow(db, row.id), getLayoutRow(db, row.id), resourceRows(db, row.id),
    ]);
    const { hash, ...snapshot } = current;
    const view = schemaView({ engine, database: name, current: snapshot, currentHash: hash, row: draftRow });
    // What these changes do to her app if it is switched on: the same list the
    // menu is built from (only what she ticked), so "may affect Recipes" names
    // the thing she sees in the menu (src/studio/impact.ts).
    const app = impactOf(view.plan.steps,
      { active: row.status === 'active', title: row.display_name || row.name, programs: row.api_read === 1 || row.api_write === 1 },
      saved.filter((r) => r.enabled).map((r) => ({ table: r.table_name, plural: r.plural || pluralName(r.table_name) })));
    // every table gets somewhere to be, including ones she has just added and
    // everything at all on a first visit (src/studio/layout.ts placed)
    // docs/catalog-plan.md step 4 (S4-9): a table that goes takes its records' tags with it
    const dropped = new Set(view.plan.steps.flatMap((s) => (s.kind === 'drop-table' ? [s.table] : [])));
    const tagsLost = [];
    for (const r of saved) {
      if (!dropped.has(r.table_name) || !r.catalog_source) continue;
      const labelled = (await sourceCounts(db, Number(r.catalog_source))).labelled;
      tagsLost.push({ table: r.table_name, plural: r.plural || pluralName(r.table_name), labelled });
    }
    return {
      ...view,
      tagsLost,
      layout: placed(view.draft, readLayout(layoutRow)),
      // read back as relationships rather than as constraints, so a
      // many-to-many is one line between two tables and not two into a table
      // she never asked for (src/studio/relationships.ts)
      relationships: relationships(view.draft),
      app,
    };
  };

  // What her tables mean (docs/databases-plan.md 11). Inference every time,
  // with her overrides on top -- so a table she has never looked at is
  // proposed rather than managed, and nothing here holds a stale opinion.
  const appFor = async (a: Authed, engine: Engine, name: string): Promise<{
    engine: Engine; database: string; status: string; title: string;
    apiRead: boolean; apiWrite: boolean; resources: ResourceView[];
  }> => {
    const { row } = await managed(a, engine, name);
    const [current, rows, fields] = await Promise.all([
      liveSchema(a, engine, name), resourceRows(db, row.id), fieldRows(db, row.id),
    ]);
    const { hash, ...snapshot } = current;
    return {
      engine,
      database: name,
      status: row.status,
      title: row.display_name || name,
      apiRead: row.api_read === 1,
      apiWrite: row.api_write === 1,
      resources: resourceViews(snapshot, rows, fields),
    };
  };

  const resourceOf = (view: { resources: ResourceView[] }, table: string): ResourceView => {
    const r = view.resources.find((x) => x.table === table);
    if (!r) throw new AccountError('There is no table by that name in this database.', 404);
    return r;
  };

  // ------------------------------------------------------------ the data API
  // The gate cannot read the panel's tables, so what a database exposes to
  // programs is PUSHED to it whole (docs/studio-plan.md "catalog push"). This
  // runs after anything that changes what the answer would be: switching the
  // app on or off, changing a Resource or a field, and the API switches
  // themselves. No merge -- the gate replaces its copy.
  const pushCatalog = async (a: Authed, engine: Engine, name: string) => {
    const { row } = await managed(a, engine, name);
    if (row.status !== 'active') {
      // not switched on: the gate should not be holding a catalog for it at
      // all, and any key for it stops working at the same moment
      await gate({ op: 'catalog.drop', databaseId: row.id });
      return;
    }
    const view = await appFor(a, engine, name);
    await gate({
      op: 'catalog.push', databaseId: row.id, engine, name,
      apiRead: row.api_read === 1, apiWrite: row.api_write === 1,
      catalog: buildCatalog(view.resources),
    });
  };

  // Anything that changed what the API would answer. Deliberately quiet on
  // success and loud on failure: a stale catalog is the one thing worse than
  // no catalog, so she is told rather than left with an API that disagrees
  // with her pages.
  const refreshCatalog = async (a: Authed, engine: Engine, name: string) => {
    try {
      await pushCatalog(a, engine, name);
    } catch (e) {
      app.log.warn({ err: e }, 'pushing the catalog to the gate failed');
      throw new AccountError(
        'That is saved, but the copy programs read could not be updated just now. Try again in a moment — until then the API may answer with what it had before.', 503);
    }
  };

  return { dashboard, cardFor, managed, changeable, studioSlow, liveSchema, schemaFor, appFor, resourceOf, pushCatalog, refreshCatalog };
}
