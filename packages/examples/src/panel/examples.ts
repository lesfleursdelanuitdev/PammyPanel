// The examples the panel owns (N7 in docs/refactor-plan.md): one place that
// knows which kinds there are -- the database examples (recipe book, blog) and
// the tutorial ones (journal, to-do list) -- and what may not be done to them.
//
// They were three lists before: DB_EXAMPLES, TUTORIAL_EXAMPLES and the CHECK in
// the migration. deploy/verify-panel.sh compares the CHECK with these two on
// every install, so a kind added to one and not the other fails there rather
// than when she presses Set up.
import type { FastifyRequest } from 'fastify';
import { AccountError } from '@panel/core/accounts';
import { one, tx, type Sql } from '@panel/core/pg';
import type { Authed } from '@panel/core/sessions';
import type { Engine } from '@panel/studio/pammydb/ident';
import type { Scalar } from '@panel/studio/pammydb/rows';
import { getManaged, startManaging, type ManagedRow } from '@panel/studio/studio/databases';
import { DB_EXAMPLE_KINDS, DB_EXAMPLES, isDbExampleKind, seedExample, type DbExample, type DbExampleKind } from '../studio/db-examples.ts';
import { TUTORIAL_EXAMPLES, type TutorialExample, type TutorialKind } from '../studio/tutorial-examples.ts';
import { saveField, saveResource } from '@panel/studio/studio/resource-store';
import { studioFor } from '@panel/studio/panel/studio';
import { ENGINE_NAMES } from '@panel/studio/pammydb/ident';
import { type ApplyResult } from '@panel/studio/pammydb/ops';
import { run } from '@panel/core/pg';
import { exampleSnapshot } from '../studio/db-examples.ts';
import { diff } from '@panel/studio/studio/diff';
import { saveOrder } from '@panel/studio/studio/resource-store';
import type { PanelCtx } from '@panel/core/panel/context';
import type { ExampleGuard } from '@panel/studio/panel/studio-ctx';
import { appPath } from '@panel/core/paths';

// Which kinds of example there are at all: the two the Databases tab makes, and
// the two the tutorials use.
export const EXAMPLE_KINDS = [...DB_EXAMPLE_KINDS, ...Object.keys(TUTORIAL_EXAMPLES)] as const;

// Where the worked examples' own files live (the panel's copy of what the gate
// serves at /_pammy/examples/).
export const EXAMPLES_DIR = `${appPath('public-gate', 'examples')}/`;

export const kindParam = (req: FastifyRequest): DbExampleKind => {
  const kind = (req.params as { kind?: string }).kind;
  if (!isDbExampleKind(kind)) throw new AccountError('There is no example called that.', 404);
  return kind;
};

// What the studio's own pages need to know about examples (docs/packaging-plan.md
// step 1d): which names are kept for them, and a refusal. The site hands this to
// the studio's part of the context, so the studio doesn't import the examples.
export function exampleGuard(db: Sql): ExampleGuard {
  return {
    exampleNames: new Set(DB_EXAMPLE_KINDS.map((k) => DB_EXAMPLES[k].database)),
    // The examples can be used -- a recipe added, a table drawn -- but not
    // deleted, unmanaged, renamed or switched off: Reset is how one comes back (X2).
    async refuseExample(engine: Engine, name: string, doing: string) {
      const row = await getManaged(db, engine, name);
      if (row?.example) {
        const heading = DB_EXAMPLES[row.example as DbExampleKind]?.heading ?? TUTORIAL_EXAMPLES[row.example as TutorialKind]?.heading ?? '';
        throw new AccountError(`${name} is the panel's ${heading.toLowerCase()} example, so it cannot be ${doing}. "Put it back as it was" on its example page resets it.`, 403);
      }
    },
  };
}

export function examples(ctx: PanelCtx) {
  const { db, now, gate, studio } = ctx;
  const { refreshCatalog, liveSchema, studioSlow } = studioFor(ctx);

  const exampleRowOf = (kind: DbExampleKind) =>
    one<ManagedRow>(db, 'SELECT * FROM studio_databases WHERE example = ?', kind);
  const { exampleNames: EXAMPLE_NAMES, refuseExample } = exampleGuard(db);
  // Two apps switched on with one name would be two menu groups she cannot tell
  // apart -- said here, in her words, before anything is made.
  const titleTaken = async (title: string) =>
    !!await one(db, "SELECT 1 FROM studio_databases WHERE status = 'active' AND display_name <> '' AND lower(display_name) = lower(?)", title);
  // The tables, what the app says about them, the sample rows if asked for, and
  // the app switched on with reading on: everything after "make the database".
  // Shared by setting up an example and making her own, so the two cannot differ.
  async function fillDatabase(a: Authed, ex: Pick<DbExample, 'kind' | 'tables' | 'resources' | 'rows'> | TutorialExample, engine: Engine, name: string, o: { rows: boolean; pictures: string; ids?: Map<string, Scalar> }): Promise<number> {
    const row = await getManaged(db, engine, name);
    if (!row) throw new AccountError('The panel lost track of that database. Open the Database Manager and look for it there.', 500);
    // 1. the tables, by the same diff and apply as anything drawn on the canvas
    const before = await liveSchema(a, engine, name);
    const { hash, ...current } = before;
    const result = await studioSlow<ApplyResult>({
      op: 'apply-schema', engine, name, patch: diff(current, exampleSnapshot(ex, engine, name)), expect: hash, actor: a.user.username,
    });
    if (result.failed) throw new AccountError(`The tables could not all be made: ${result.failed.message}`, 500);
    const { hash: _, ...after } = result.snapshot;
    await run(db, 'UPDATE studio_databases SET last_applied_at = ?, last_introspect_json = ? WHERE id = ?', now(), JSON.stringify(after), row.id);
    // 2. what the app says about them
    await tx(db, async (q) => {
      for (const [table, { patch, fields, order }] of Object.entries(ex.resources)) {
        await saveResource(q, row.id, table, patch);
        for (const [field, fp] of Object.entries(fields ?? {})) await saveField(q, row.id, table, field, fp);
        if (order) await saveOrder(q, row.id, table, order);
      }
    });
    // 3. the sample rows, one at a time, each connection from the id the engine gave (X4)
    let rows = 0;
    if (o.rows) {
      rows = await seedExample(ex, o.pictures, async (table, values) => {
        const key = after.tables.find((t) => t.name === table)?.primaryKey ?? [];
        const got = await studio<{ row: Record<string, unknown> }>({ op: 'insert-row', engine, name, table, values, back: key, actor: a.user.username });
        return key.length === 1 ? got.row[key[0]!] as never : null;
      }, o.ids);
    }
    // 4. switched on, with reading on: the public page needs both
    await run(db, "UPDATE studio_databases SET status = 'active', activated_at = ?, api_read = 1 WHERE id = ?", now(), row.id);
    await refreshCatalog(a, engine, name);
    return rows;
  }
  // An example's own database, made afresh and empty: the one the panel made for
  // it before (if any) switched off at the gate, forgotten and dropped, and a new
  // one made and marked as that example. One of hers with the same name is never
  // touched. Says whether there was one before. Shared by the database examples
  // and the tutorial examples.
  async function remakeExampleDatabase(a: Authed, ex: { kind: string; engine: Engine; database: string; title: string }): Promise<boolean> {
    const old = await one<ManagedRow>(db, 'SELECT * FROM studio_databases WHERE example = ?', ex.kind);
    const theirs = await getManaged(db, ex.engine, ex.database);
    if (theirs && !old) {
      throw new AccountError(`There is already a database called ${ex.database} that the panel did not make for this example, so it has left it alone. Rename or delete that one first.`, 409);
    }
    if (old) {
      // switched off first, so the gate lets go of it at the same moment
      await gate({ op: 'catalog.drop', databaseId: old.id });
      await tx(db, (q) => run(q, 'DELETE FROM studio_databases WHERE id = ?', old.id));
      try {
        await studio({ op: 'drop-database', engine: ex.engine, name: ex.database, actor: a.user.username });
      } catch (e) {
        // already gone is what we wanted anyway
        if (!(e instanceof AccountError) || e.status !== 404) throw e;
      }
    }
    try {
      await studio({ op: 'create-database', engine: ex.engine, name: ex.database, actor: a.user.username });
    } catch (e) {
      if (e instanceof AccountError && e.status === 409) {
        throw new AccountError(`${ENGINE_NAMES[ex.engine]} already has a database called ${ex.database} that the panel did not make, so it has left it alone.`, 409);
      }
      throw e;
    }
    await tx(db, async (q) => {
      await startManaging(q, { engine: ex.engine, name: ex.database, displayName: ex.title, at: now() });
      await run(q, 'UPDATE studio_databases SET example = ? WHERE engine = ? AND name = ?', ex.kind, ex.engine, ex.database);
    });
    return !!old;
  }
  return { exampleRowOf, EXAMPLE_NAMES, refuseExample, titleTaken, fillDatabase, remakeExampleDatabase };
}
