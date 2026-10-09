// Her records (docs/databases-plan.md 11.7): the rows themselves, through the
// app's window -- what a table means decides what may be listed, searched,
// added, changed and deleted.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { ENGINE_NAMES, type Engine, NAME_RE } from '../../pammydb/ident.ts';
import { type ApplyResult } from '../../pammydb/ops.ts';
import { type RowPage, type Scalar, checkQuery as checkRowQuery } from '../../pammydb/rows.ts';
import { run, tx } from '@panel/core/pg';
import { type Authed } from '@panel/core/sessions';
import { type CatalogResource, buildCatalog } from '../../studio/catalog.ts';
import { type Links, linksOf } from '../../studio/connect.ts';
import {
  type ListAsk, abilityMissing, keyOf, listQuery, pickFilterable, pickQuery, readable, richAsWords, richForEditing, valuesFor, whereFor,
} from '../../studio/records.ts';
import { carryRenames, forgetMissing } from '../../studio/resource-store.ts';
import { type ResourceView } from '../../studio/resources.ts';
import { keysWithLabel, namesByKey } from '@panel/catalog/items';
import { recordKey, whereOfKey } from '../../studio/tagging.ts';
import { discardDraft, rebaseDraft, renamesDone, saveDraft, stillToDo } from '../../studio/schema.ts';
import { plural } from '@panel/core/util';
import { type FastifyRequest } from 'fastify';
import type { StudioCtx } from '../studio-ctx.ts';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  const { db, now, need, body, actorOf, gate, engineParam, dbNameParam, tableParam, fieldParam, keeper } = ctx;
  const { managed, studioSlow, schemaFor, appFor, refreshCatalog } = studioFor(ctx);

    // ------------------------------------------------------------ her records
    // The generated pages (docs/databases-plan.md 11.7, 11.8). Everything here
    // goes through the Resource's window (src/studio/records.ts): the ability
    // has to be on, and only exposed fields are ever read or written.
    // The DataViewer's toolbar, as a query string. Anything it does not
    // recognise is left out rather than refused: a stale browser should still
    // get a page (src/studio/records.ts clips this to the window anyway).
    const listAsk = (req: FastifyRequest): ListAsk => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const filters = (() => {
        if (typeof q.filters !== 'string' || !q.filters) return [];
        try {
          const parsed = JSON.parse(q.filters) as unknown;
          return checkRowQuery({ table: 'x', columns: ['x'], filters: parsed }).filters;
        } catch { return []; }
      })();
      return {
        page: Math.max(1, Math.min(100_000, Number(q.page) || 1)),
        search: typeof q.search === 'string' ? q.search.slice(0, 200) : '',
        sort: typeof q.sort === 'string' && NAME_RE.test(q.sort)
          ? { column: q.sort, dir: q.dir === 'desc' ? 'desc' : 'asc' }
          : null,
        filters,
      };
    };

    const resourceFor = async (a: Authed, engine: Engine, name: string, table: string) => {
      const { row, card } = await managed(a, engine, name);
      const view = await appFor(a, engine, name);
      const r = view.resources.find((x) => x.table === table);
      if (!r || !r.enabled) {
        throw new AccountError(`That is not one of the tables this ${APP.one} manages.`, 404);
      }
      return { r, row, card, view };
    };

    // Connections by name (docs/record-picker-plan.md R11), worked out the way
    // the data API does it (src/studio/connect.ts), through the app's own window:
    // only to a table that is in the app with "Look at them" on.
    type Connections = {
      refs: { column: string; name: string; table: string; plural: string }[];
      many: { name: string; table: string; plural: string; singular: string }[];
    };
    const appCatalog = (resources: ResourceView[]) => {
      const all = new Map(buildCatalog(resources, { decidedOnly: false }).resources.map((x) => [x.slug, x]));
      return { all, of: (table: string) => [...all.values()].find((x) => x.table === table) };
    };
    const connectionsOf = (resources: ResourceView[], table: string): Connections => {
      const { all, of } = appCatalog(resources);
      const me = of(table);
      const readable = (slug: string) => { const t = all.get(slug); return t && t.can.view && t.key.length === 1 ? t : undefined; };
      const viewOf = (t: CatalogResource) => resources.find((x) => x.table === t.table)!;
      return {
        refs: (me?.refs ?? []).flatMap((x) => { const t = readable(x.to); return t ? [{ column: x.column, name: x.name, table: t.table, plural: t.plural }] : []; }),
        many: (me?.many ?? []).flatMap((x) => { const t = readable(x.to); return t ? [{ name: x.name, table: t.table, plural: t.plural, singular: viewOf(t).singular }] : []; }),
      };
    };
    const linksFor = async (a: Authed, engine: Engine, name: string, resources: ResourceView[], table: string, items: Record<string, unknown>[]): Promise<Links[]> => {
      const { all, of } = appCatalog(resources);
      const me = of(table);
      if (!me) return items.map(() => ({}));
      return linksOf({
        list: (query) => studioSlow<RowPage>({ op: 'list-rows', engine, name, query, actor: a.user.username }),
        resource: me, all, readable: (t) => t.can.view, items,
      });
    };

    // A record's many-to-many choices, as sent with it: `{ links: { tags: [3, 7] } }`
    // (docs/record-picker-plan.md R6, R13). Checked before the record is saved,
    // so a choice that cannot be kept stops the save rather than half of it.
    type LinksAsked = { junction: string; here: string; there: string; ids: Scalar[] }[];
    const linksAsked = (resources: ResourceView[], r: ResourceView, sent: Record<string, unknown>): LinksAsked => {
      const asked = sent.links;
      if (asked === undefined || asked === null) return [];
      if (typeof asked !== 'object' || Array.isArray(asked)) throw new AccountError('The panel could not read the connections you chose.', 400);
      const c = connectionsOf(resources, r.table);
      const out: LinksAsked = [];
      for (const [nm, ids] of Object.entries(asked as Record<string, unknown>)) {
        const m = c.many.find((x) => x.name === nm);
        const how = m && r.many.find((x) => x.other === m.table);
        if (!m || !how) throw new AccountError(`${r.plural} have no connection called ${nm} here.`, 400);
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
          throw new AccountError(`The panel could not read the ${m.plural.toLowerCase()} you chose.`, 400);
        }
        out.push({ junction: how.junction, here: how.here, there: how.there, ids: ids as Scalar[] });
      }
      if (out.length && keyOf(r).length !== 1) throw new AccountError(`${r.plural} are told apart by more than one field, so their connections cannot be chosen here.`, 400);
      return out;
    };
    // One transaction per connection, after the record itself (R12). If it fails,
    // she is told the record was saved and the choices were not.
    const saveLinks = async (a: Authed, engine: Engine, name: string, r: ResourceView, row: Record<string, unknown>, links: LinksAsked) => {
      const id = row[keyOf(r)[0]!] as Scalar;
      for (const l of links) {
        try {
          await studioSlow({ op: 'set-links', engine, name, table: l.junction, here: l.here, id, there: l.there, ids: l.ids, actor: a.user.username });
        } catch (e) {
          const why = e instanceof AccountError ? ` ${e.message}` : '';
          throw new AccountError(`The ${r.singular} was saved, but what it is connected to was not.${why}`, e instanceof AccountError ? e.status : 500);
        }
      }
    };

    // A record with a rich-text field in it can be far bigger than the usual 64k
    // (docs/rich-text-plan.md T16; nginx allows these two 2 MB as well).
    const RECORD_BODY = { bodyLimit: 2 * 1024 * 1024 };

    // docs/catalog-plan.md step 4: each row's tags and categories, in the rows' order
    const labelsOfRows = async (resource: number, r: ResourceView, rows: Record<string, unknown>[]) => {
      const keys = rows.map((row) => recordKey(r, row));
      const got = await namesByKey(db, resource, keys.filter((k): k is string => k !== null));
      return keys.map((k) => (k && got.get(k)) || { tags: [], categories: [] });
    };

    app.get('/api/app/:engine/:name/:table', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r, view } = await resourceFor(a, engine, name, tableParam(req));
      const missing = abilityMissing(r, 'view');
      if (missing) throw missing;
      const ask = listAsk(req);
      const query = listQuery(r, ask);
      // docs/catalog-plan.md step 4: ?label=<id>, only the records with that tag or category
      const refs = keeper ? await keeper.refs(r) : undefined;
      const labelAsked = Number((req.query as Record<string, unknown>).label);
      if (refs && Number.isSafeInteger(labelAsked) && labelAsked > 0) {
        const keys = await keysWithLabel(db, refs.resource, labelAsked);
        const k = keyOf(r);
        if (k.length !== 1) throw new AccountError(`${r.plural} are told apart by more than one field, so they can't be filtered by tag yet.`, 400);
        if (!keys.length) return { resource: r, page: ask.page, items: [], total: 0, connections: connectionsOf(view.resources, r.table), links: [], labels: [] };
        query.filters.push({ kind: 'in', column: k[0]!, values: keys.map((x) => whereOfKey(r, x)![k[0]!]!) });
      }
      const page = await studioSlow<RowPage>({
        op: 'list-rows', engine, name, query, actor: a.user.username,
      });
      const links = await linksFor(a, engine, name, view.resources, r.table, page.items);
      const labels = refs ? await labelsOfRows(refs.resource, r, page.items) : undefined;
      // a rich-text field in a list is its words, never its HTML (rich-text-plan T15)
      richAsWords(r, page.items);
      return { resource: r, page: ask.page, ...page, connections: connectionsOf(view.resources, r.table), links, ...(labels ? { labels } : {}) };
    });

    // The record picker (docs/record-picker-plan.md): the records a field of
    // this table may point at -- a connection's column, or a many-to-many by its
    // name -- searched, filtered and a page at a time, through the OTHER table's
    // own window. Only to a table that is in the app with "Look at them" on (R8).
    app.get('/api/app/:engine/:name/:table/pick/:field', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r, view } = await resourceFor(a, engine, name, tableParam(req));
      const field = fieldParam(req);
      const c = connectionsOf(view.resources, r.table);
      const other = c.refs.find((x) => x.column === field)?.table ?? c.many.find((x) => x.name === field)?.table;
      const t = other ? view.resources.find((x) => x.table === other) : undefined;
      if (!t) throw new AccountError(`${field} does not point at anything this ${APP.one} shows.`, 404);
      const ask = listAsk(req);
      const page = await studioSlow<RowPage>({ op: 'list-rows', engine, name, query: pickQuery(t, ask), actor: a.user.username });
      const links = await linksFor(a, engine, name, view.resources, t.table, page.items);
      richAsWords(t, page.items);
      return {
        resource: t, page: ask.page, ...page,
        filterable: pickFilterable(t).map((f) => f.name),
        connections: connectionsOf(view.resources, t.table),
        links,
      };
    });

    app.get('/api/app/:engine/:name/:table/one', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r, view } = await resourceFor(a, engine, name, tableParam(req));
      const missing = abilityMissing(r, 'view');
      if (missing) throw missing;
      const { row } = await studioSlow<{ row: Record<string, unknown> | null }>({
        op: 'get-row', engine, name, table: r.table, columns: readable(r),
        where: whereFor(r, (req.query ?? {}) as Record<string, unknown>), actor: a.user.username,
      });
      if (!row) throw new AccountError(`That ${r.singular} is not there any more.`, 404);
      const [links] = await linksFor(a, engine, name, view.resources, r.table, [row]);
      const refs = keeper ? await keeper.refs(r) : undefined;
      const labels = refs ? (await labelsOfRows(refs.resource, r, [row]))[0] : undefined;
      // for the editor: clean HTML, whatever is stored (rich-text-plan T7, T11)
      return { resource: r, row: richForEditing(r, row), connections: connectionsOf(view.resources, r.table), links, ...(labels ? { labels } : {}) };
    });

    app.post('/api/app/:engine/:name/:table/new', { ...RECORD_BODY, config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r, view } = await resourceFor(a, engine, name, tableParam(req));
      const missing = abilityMissing(r, 'create');
      if (missing) throw missing;
      const sent = body(req);
      const links = linksAsked(view.resources, r, sent);
      const { row } = await studioSlow<{ row: Record<string, unknown> }>({
        op: 'insert-row', engine, name, table: r.table,
        values: valuesFor(r, sent, 'create'), back: readable(r), actor: a.user.username,
      });
      await saveLinks(a, engine, name, r, row, links);
      await keeper?.recordSaved({ engine, name }, r, row, a.user.username);
      return { ok: true, resource: r, row: richForEditing(r, row) };
    });

    app.post('/api/app/:engine/:name/:table/save', { ...RECORD_BODY, config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r, view } = await resourceFor(a, engine, name, tableParam(req));
      const missing = abilityMissing(r, 'edit');
      if (missing) throw missing;
      const sent = body(req);
      const links = linksAsked(view.resources, r, sent);
      const { row } = await studioSlow<{ row: Record<string, unknown> | null }>({
        op: 'update-row', engine, name, table: r.table,
        values: valuesFor(r, sent, 'edit'),
        where: whereFor(r, (sent.where ?? {}) as Record<string, unknown>),
        back: readable(r), actor: a.user.username,
      });
      if (!row) throw new AccountError(`That ${r.singular} is not there any more.`, 404);
      await saveLinks(a, engine, name, r, row, links);
      await keeper?.recordSaved({ engine, name }, r, row, a.user.username);
      return { ok: true, resource: r, row: richForEditing(r, row) };
    });

    // Deleting a record. What the engine does about connected rows is already
    // settled by the relationship and stays the law (D20) -- a refusal comes
    // back from the engine in her words rather than being pre-empted here.
    app.post('/api/app/:engine/:name/:table/delete', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { r } = await resourceFor(a, engine, name, tableParam(req));
      const missing = abilityMissing(r, 'delete');
      if (missing) throw missing;
      const where = whereFor(r, (body(req).where ?? {}) as Record<string, unknown>);
      const { gone } = await studioSlow<{ gone: boolean }>({
        op: 'delete-row', engine, name, table: r.table, where, actor: a.user.username,
      });
      if (!gone) throw new AccountError(`That ${r.singular} is not there any more.`, 404);
      const key = recordKey(r, where);
      if (keeper && key) await keeper.recordDeleted(r, key, actorOf(a, req));
      await logActivity(db, now(), actorOf(a, req), 'record-deleted', `${r.singular} in ${name}`, null);
      return { ok: true };
    });

    // Review: the steps in her words, and the statements from the helper's own
    // printer underneath them.
    app.get('/api/databases/:engine/:name/schema/review', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const view = await schemaFor(a, engine, name);
      if (view.plan.steps.length === 0) return { ...view, sql: [] };
      const { sql } = await studioSlow<{ sql: string[] }>({
        op: 'preview-schema', engine, name, patch: view.plan.steps, actor: a.user.username,
      });
      return { ...view, sql };
    });

    // Apply. A passkey tap just now is asked for when a step can lose something
    // she cannot get back, or when the database is switched on and something is
    // already using it (docs/databases-plan.md 8, 3 "Names, safety, passkeys").
    app.post('/api/databases/:engine/:name/schema/apply', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const { row } = await managed(a, engine, name);
      const view = await schemaFor(a, engine, name);
      if (view.plan.steps.length === 0) throw new AccountError('There is nothing to apply.', 400);
      if (view.drift) {
        throw new AccountError('This database changed since you started. Have another look at it, then apply your changes again.', 409);
      }
      if (view.plan.destructive || row.status === 'active') {
        // the same second gate as deleting a database: re-ask for the passkey
        const recent = await need(req, reply, { fresh: true });
        if (!recent) return reply;
      }
      const result = await studioSlow<ApplyResult>({
        op: 'apply-schema', engine, name, patch: view.plan.steps, expect: view.currentHash, actor: a.user.username,
      });
      const { hash, ...after } = result.snapshot;
      // What is left to do. On Postgres a failure means nothing happened, so it is
      // still the whole patch; on MariaDB it is whatever the engine did not reach.
      // The drawing is rebased first: a rename that has run is not still waiting.
      const rebased = rebaseDraft(view.draft, after);
      const left = stillToDo(after, rebased);
      const renamed = renamesDone(view.plan.steps, after);
      await tx(db, async (q) => {
        if (left.steps.length === 0) await discardDraft(q, row.id);
        else await saveDraft(q, { databaseId: row.id, draft: rebased, basedOn: hash, at: now(), by: a.user.username });
        if (result.applied > 0) await run(q, 'UPDATE studio_databases SET last_applied_at = ?, last_introspect_json = ? WHERE id = ?', now(), JSON.stringify(after), row.id);
        // A table that is gone takes what it meant with it (docs/studio-plan.md,
        // "re-run after every Apply"). Inference covers everything that is still
        // there, so nothing has to be re-derived here -- only her opinions about
        // tables that no longer exist have to stop being held.
        // ...and one that was only renamed keeps it, under its new name
        await carryRenames(q, row.id, renamed);
        if (result.applied > 0) await forgetMissing(q, row.id, after.tables.map((x) => x.name));
      });
      // A key that could reach only some tables names them, so it has to follow a
      // rename too, or a program would lose a table she only called something else.
      for (const t of renamed.tables) {
        await gate({ op: 'appkeys.rename-table', databaseId: row.id, from: t.from, to: t.to });
      }
      // A table that went takes its Resource with it (forgetMissing above), so
      // what programs can reach has changed too.
      if (result.applied > 0 && row.status === 'active') await refreshCatalog(a, engine, name);
      await logActivity(db, now(), actorOf(a, req), 'schema-applied', `${ENGINE_NAMES[engine]}: ${name}`,
        [`${result.applied} of ${plural(result.steps.length, 'change')}`,
          result.failed ? `stopped at step ${result.failed.at + 1}` : null,
          row.status === 'active' ? `its ${APP.one} is switched on` : null].filter(Boolean).join('; '));
      return {
        ok: !result.failed,
        applied: result.applied,
        total: result.steps.length,
        failed: result.failed,
        rolledBack: result.rolledBack,
        // the page re-reads everything anyway; this is so it can say what happened
        // without a second round trip
        ...await schemaFor(a, engine, name),
      };
    });


}
