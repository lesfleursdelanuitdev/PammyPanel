// Your databases (docs/databases-plan.md 5 and 12): the shelf, picking one up,
// putting it down, and making or removing one.
//
// The databases right (rights.ts), which a person kept to places never has: they have
// no databases. What every one of these asks first is in src/panel/studio.ts.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { type DatabaseFacts } from '../../pammydb/driver.ts';
import { ENGINE_NAMES, type Engine, isEngine, newNameProblem } from '../../pammydb/ident.ts';
import { run, tx } from '@panel/core/pg';
import { getManaged, setDisplayName, startManaging, stopManaging } from '../../studio/databases.ts';
import { plural } from '@panel/core/util';
import type { StudioCtx } from '../studio-ctx.ts';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const APP = ctx.config.site.words.app;   // the glossary (docs/adapters-plan.md A7)
  const { db, now, need, body, actorOf, gate, studio, engineParam, dbNameParam, appNameOf } = ctx;
  const { dashboard, cardFor } = studioFor(ctx);
  const { exampleNames: EXAMPLE_NAMES, refuseExample } = ctx;

    // ---------------------------------------------------------------- her databases (the studio)
    // The databases right (rights.ts), which a person kept to places never has: they have
    // no databases. What they all ask first is in src/panel/studio.ts.
    app.get('/api/databases', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return dashboard(a);
    });

    // Who an app's records can be opened to without a key (docs/tutorials-plan.md V1): the
    // people let into a protected folder (pammy.org), or into a route with accounts (lfdln,
    // docs/phase8-plan.md 8-4), by the gate's areas; a label each, in the site's words.
    app.get('/api/databases/visitor-areas', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const s = await ctx.gate<{ areas: { id: number; path: string; kind: string; label: string | null }[] }>({ op: 'state' });
      return {
        areas: s.areas.map((x) => ({ id: x.id, kind: x.kind, label: x.kind === 'route' ? `People with accounts at ${x.label ?? x.path}` : `People signed in to /${x.path}` })),
      };
    });

    app.post('/api/databases', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      if (!isEngine(b.engine)) throw new AccountError('Please choose which kind of database.', 400);
      const problem = newNameProblem(b.name, b.engine);
      if (problem) throw new AccountError(problem, 400);
      const name = b.name as string;
      if (EXAMPLE_NAMES.has(name)) throw new AccountError(`${name} is kept for the panel's example. Choose another name.`, 400);
      const displayName = b.displayName === undefined ? '' : appNameOf(b.displayName);
      const made = await studio<DatabaseFacts>({ op: 'create-database', engine: b.engine, name, actor: a.user.username });
      // If writing it down fails the database is still there, and she can adopt it:
      // better than a database the panel has forgotten it made.
      await tx(db, (q) => startManaging(q, { engine: b.engine as Engine, name, displayName, at: now() }));
      await logActivity(db, now(), actorOf(a, req), 'database-created', `${ENGINE_NAMES[b.engine]}: ${name}`,
        displayName ? `the ${APP.one} is called ${displayName}` : null);
      return { ok: true, database: { ...made, displayName, managed: true, live: true } };
    });

    app.get('/api/databases/:engine/:name', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const card = await cardFor(a, engine, name);
      if (card.live !== true) return card;
      // the size and table count are worth a second ask: the list leaves them out
      // for Postgres, which would need a connection per database
      const size = await studio<{ bytes: number | null; tables: number }>({ op: 'database-size', engine, name, actor: a.user.username });
      return { ...card, bytes: size.bytes, tables: size.tables };
    });

    // Settings, adopt and unmanage: the three that change what the PANEL thinks,
    // never the database itself. POST with a word on the end, like
    // /api/api-keys/:id/revoke -- src/security.ts:33 says every state change here
    // is a JSON POST from this origin, and that stays true (S10).
    app.post('/api/databases/:engine/:name/settings', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const displayName = appNameOf(body(req).displayName);
      await refuseExample(engine, name, 'renamed');
      await tx(db, (q) => setDisplayName(q, engine, name, displayName));
      await logActivity(db, now(), actorOf(a, req), 'database-renamed', `${ENGINE_NAMES[engine]}: ${name}`,
        displayName ? `the ${APP.one} is called ${displayName}` : `the ${APP.one} name was cleared`);
      return { ok: true, ...await cardFor(a, engine, name) };
    });

    app.post('/api/databases/:engine/:name/adopt', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      const b = body(req);
      // the helper says whether it is really there, and refuses the engine's own
      const facts = await studio<DatabaseFacts>({ op: 'adopt-database', engine, name, actor: a.user.username });
      await tx(db, (q) => startManaging(q, {
        engine, name, displayName: b.displayName === undefined ? '' : appNameOf(b.displayName), at: now(),
      }));
      await logActivity(db, now(), actorOf(a, req), 'database-adopted', `${ENGINE_NAMES[engine]}: ${name}`,
        `${plural(facts.tables ?? 0, 'table')} already in it`);
      return { ok: true, ...await cardFor(a, engine, name) };
    });

    app.post('/api/databases/:engine/:name/unmanage', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      // The gate must not be left holding a catalog for a database the panel has
      // stopped looking after -- that would leave programs reading something
      // nobody is maintaining. Its keys stop at the same moment.
      await refuseExample(engine, name, 'let go of');
      const before = await getManaged(db, engine, name);
      await tx(db, (q) => stopManaging(q, engine, name, APP.one));
      if (before) await gate({ op: 'catalog.drop', databaseId: before.id });
      await logActivity(db, now(), actorOf(a, req), 'database-unmanaged', `${ENGINE_NAMES[engine]}: ${name}`, 'the database itself was left alone');
      return { ok: true };
    });

    // Deleting a database really deletes her data, so it asks the most of her:
    // account manager, a passkey tap just now, and the name typed out (D20).
    app.post('/api/databases/:engine/:name/delete', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      await refuseExample(engine, name, 'deleted');
      if (body(req).confirm !== name) {
        throw new AccountError(`Type ${name} to confirm you want it deleted.`, 400);
      }
      const row = await getManaged(db, engine, name);
      if (row?.status === 'active') {
        throw new AccountError(`Switch its ${APP.one} off first: something is using this database.`, 403);
      }
      await studio({ op: 'drop-database', engine, name, actor: a.user.username });
      await tx(db, (q) => run(q, 'DELETE FROM studio_databases WHERE engine = ? AND name = ?', engine, name));
      // it had to be switched off first, so the gate should already have
      // forgotten it -- said again here so an older catalog cannot outlive it
      if (row) await gate({ op: 'catalog.drop', databaseId: row.id });
      await logActivity(db, now(), actorOf(a, req), 'database-deleted', `${ENGINE_NAMES[engine]}: ${name}`,
        'the database and everything in it is gone; last night\'s backup is still there');
      return { ok: true };
    });


}
