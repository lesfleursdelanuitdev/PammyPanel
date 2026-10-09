// The tutorials' world (docs/tutorials-plan.md T2): the two databases guides
// 15-18 tell her to draw, with the app settings they tell her to choose -- made
// with the panel's own functions (starterTable, addRelationship, resourceViews,
// buildCatalog), so a guide can't promise a field name, a connection or an
// answer the panel would not really give -- pushed to the REAL gate, which
// serves them over the data API (for the pages' JavaScript) and PHP's socket
// (for their PHP). Only the database engines are the in-memory stand-in the
// browser tests use (test/studio-stub.ts).
//
//   node test/tutorials-world.ts <dir> <public> <gate port>
// writes <dir>/world.json (keys, folder tokens) once everything answers, then
// runs until SIGTERM. Used by test/run-tutorials-test.sh; the shapes are also
// checked in test/tutorials.test.ts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '@panel/studio/pammydb/ir';
import { journalSnapshot, todoSnapshot } from '@panel/examples/studio/tutorial-examples';
import { resourceViews, type FieldRow, type ResourceRow } from '@panel/studio/studio/resources';
import { buildCatalog, type Catalog } from '@panel/studio/studio/catalog';

// ------------------------------------------------------------------ what the guides tell her to draw
// The tables themselves are src/studio/tutorial-examples.ts's, which the panel's
// tutorial examples are made from too.
export { journalSnapshot, todoSnapshot };

// What the app's pages save when she switches a thing on and sets it up: the
// panel's suggestions, with only what the guide says changed.
function rowsFor(s: Snapshot, settings: Record<string, Partial<ResourceRow>>): ResourceRow[] {
  return resourceViews(s, [], []).filter((v) => settings[v.table]).map((v) => ({
    table_name: v.table, enabled: true, singular: v.singular, plural: v.plural, icon: '', description: '',
    title_field: v.titleField ?? '', sort_field: v.sortField ?? '', sort_dir: v.sortDir,
    can_create: v.can.create, can_view: v.can.view, can_edit: v.can.edit, can_delete: v.can.delete,
    can_duplicate: v.can.duplicate, can_search: v.can.search, can_sort: v.can.sort, can_filter: v.can.filter,
    on_delete: v.onDelete, ...settings[v.table],
  }));
}
function fieldsFor(s: Snapshot, rows: ResourceRow[], changes: Record<string, Partial<FieldRow>>): FieldRow[] {
  return resourceViews(s, rows, []).flatMap((v) => v.fields.filter((f) => changes[`${v.table}.${f.name}`]).map((f) => ({
    table_name: v.table, field_name: f.name, exposed: f.exposed, label: f.label, help: f.help, control: f.control,
    show_in_list: f.showInList, searchable: f.searchable, filterable: f.filterable, form_order: f.formOrder,
    ...changes[`${v.table}.${f.name}`],
  })));
}

// Guide 15, PARTS 4-5: the three things switched on, the body rich text, and
// all three "Anyone can read these" -- posts only where Published is yes.
export function journalCatalog(): Catalog {
  const s = journalSnapshot();
  const rows = rowsFor(s, {
    posts: { public_read: true, public_only: 'published' },
    authors: { public_read: true },
    topics: { public_read: true },
  });
  return buildCatalog(resourceViews(s, rows, fieldsFor(s, rows, { 'posts.body': { control: 'rich' } })));
}

// Guide 17, PARTS 3-4: tasks switched on; "People signed in to /todo", each
// person only their own by Owner. (Guide 18 changes nothing here: its PHP uses
// a key.)
export function todoCatalog(todoArea: number): Catalog {
  const s = todoSnapshot();
  return buildCatalog(resourceViews(s, rowsFor(s, { tasks: { visitor_area: todoArea, visitor_owner: 'owner' } }), []));
}

// What she types into the app's pages in guide 15, PART 6 (and a little more,
// so there is something to find): two authors, three topics, four posts, one
// of them not published.
export const JOURNAL_ROWS = {
  authors: [{ id: 1, name: 'Pamela' }, { id: 2, name: 'Olivia' }],
  topics: [{ id: 1, name: 'Garden' }, { id: 2, name: 'Kitchen' }, { id: 3, name: 'Travel' }],
  posts: [
    { id: 1, title: 'Hello, and welcome', body: '<p>This is where I write things down.</p>', published: true, published_on: '2026-03-02', author_id: 1 },
    { id: 2, title: 'The first beans', body: '<h2>What came up</h2><p>Broad beans, <strong>at last</strong>.</p><table><tbody><tr><th>Row</th><th>Sown</th></tr><tr><td>1</td><td>March</td></tr></tbody></table>', published: true, published_on: '2026-04-11', author_id: 1 },
    { id: 3, title: 'Lemon cake <3 & more', body: '<p>Olivia\'s recipe.</p>', published: true, published_on: '2026-05-20', author_id: 2 },
    { id: 4, title: 'Not finished yet', body: '<p>A draft.</p>', published: false, published_on: null, author_id: 1 },
  ],
  post_topics: [{ post_id: 2, topic_id: 1 }, { post_id: 3, topic_id: 2 }, { post_id: 3, topic_id: 1 }],
};

// ------------------------------------------------------------------ the world itself
if (import.meta.main) {
  const [dir, pub, port] = process.argv.slice(2);
  if (!dir || !pub || !port) { console.error('usage: node test/tutorials-world.ts <dir> <public> <gate port>'); process.exit(2); }
  const { migrate } = await import('@panel/core/pg-migrate');
  const { startPg } = await import('./pg-harness.ts');
  const { seedGate } = await import('./gate-seed.ts');
  const { GateLive } = await import('@panel/core/gate/live');
  const { visitorSessions } = await import('@panel/people/gate/session-cache');
  const { buildGateApp } = await import('@panel/pammy/gate/app');
  const { handleAdmin, createGateAdminServer } = await import('@panel/pammy/gate/admin');
  const { createPhpServer } = await import('@panel/php/gate/php-socket');
  const { createPammyDbServer } = await import('@panel/studio/pammydb/service');
  const { memoryRows, memorySchemas } = await import('./studio-stub.ts');
  type Driver = import('@panel/studio/pammydb/driver').Driver;

  const pg = await startPg();
  const stop = () => { pg.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const clock = () => Math.floor(Date.now() / 1000);
    const database = pg.freshDatabase();
    const owner = pg.connect('owner', database, 1);
    await migrate(owner);
    await owner.end();
    const db = pg.connect('gate', database, 8);
    await seedGate(db, clock());
    const live = new GateLive(db, { sessions: visitorSessions, now: clock });
    live.markReady();
    await live.reloadAreas();

    // the engines: her two databases, with what she typed in
    // and the panel's tutorial examples' two (docs/tutorial-examples-plan.md), for the PHP ones
    const rows = memoryRows({
      journal: structuredClone(JOURNAL_ROWS), todo: { tasks: [] },
      example_journal: structuredClone(JOURNAL_ROWS), example_todo: { tasks: [] },
    });
    const schemas = memorySchemas('postgres', {});
    const driver = (): Driver => ({
      engine: 'postgres',
      state: async () => ({ engine: 'postgres', ok: true, version: null, message: null }),
      list: async () => [], create: async () => { throw new Error('not used'); }, drop: async () => {},
      size: async () => ({ bytes: 0, tables: 0 }),
      listUsers: async () => [], createUser: async () => { throw new Error('not used'); },
      dropUser: async () => {}, setPassword: async () => {},
      accessOf: async () => [], grant: async () => {}, revoke: async () => {},
      introspect: (d) => schemas.introspect('postgres', d),
      apply: (d, steps) => schemas.apply('postgres', d, steps),
      listRows: (d, q) => rows.list(d, q),
      getRow: (d, t, columns, where) => rows.get(d, t, columns, where),
      insertRow: (d, t, values, back) => rows.insert(d, t, values, back),
      updateRow: (d, t, values, where, back) => rows.update(d, t, values, where, back),
      deleteRow: (d, t, where) => rows.remove(d, t, where),
      setLinks: (d, t, here, id, there, ids) => rows.setLinks(d, t, here, id, there, ids),
      close: async () => {},
    });
    const pammydbSocket = join(dir, 'pammydb.sock');
    const helper = createPammyDbServer({ postgres: driver(), mariadb: driver() });
    await new Promise<void>((r) => helper.listen(pammydbSocket, r));

    const app = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now: clock, pammydbSocket, mediaIndex: join(dir, 'no-media.db'), mediaThumbs: join(dir, 'no-thumbs') }, live);
    const admin = (req: Record<string, unknown>) => handleAdmin(live, clock(), req as { op: string }) as Promise<any>;

    // the protected folders (guide 17 PART 1, guide 18 PART 1), and two people in both
    const tokens: Record<string, string> = {};
    const areas: Record<string, number> = {};
    for (const path of ['todo', 'todo-php']) {
      const a = await admin({ op: 'area.create', path });
      areas[path] = a.id;
      tokens[path] = a.token;
      writeFileSync(join(pub, path, '.pammy-protected'), `pammy-protected ${a.token}\n`);
    }
    for (const u of ['alice', 'bob']) {
      const v = await admin({ op: 'visitor.create', username: u, name: u === 'alice' ? 'Alice' : '', password: `${u}-password-123` });
      for (const path of Object.keys(areas)) await admin({ op: 'grant', visitorId: v.id, areaId: areas[path], allow: true });
    }

    // "Letting programs in": reading on for the journal; reading and changing for the to-do list
    await admin({ op: 'catalog.push', databaseId: 1, engine: 'postgres', name: 'journal', apiRead: true, apiWrite: false, catalog: journalCatalog() });
    await admin({ op: 'catalog.push', databaseId: 2, engine: 'postgres', name: 'todo', apiRead: true, apiWrite: true, catalog: todoCatalog(areas.todo!) });
    // guide 18 PART 2: a key that may "Read, and add or change records"
    const todoKey = (await admin({ op: 'appkey.create', databaseId: 2, label: 'My to-do page (PHP)', resources: 'all', canWrite: true, actor: 'pamela' })).key as string;
    // the tutorial examples: the same catalogs on the examples' databases, and their own key
    await admin({ op: 'catalog.push', databaseId: 3, engine: 'postgres', name: 'example_journal', apiRead: true, apiWrite: false, catalog: journalCatalog() });
    await admin({ op: 'catalog.push', databaseId: 4, engine: 'postgres', name: 'example_todo', apiRead: true, apiWrite: true, catalog: buildCatalog(resourceViews(todoSnapshot('example_todo'), rowsFor(todoSnapshot('example_todo'), { tasks: {} }), [])) });
    const exampleKey = (await admin({ op: 'appkey.create', databaseId: 4, label: 'The tutorial examples (made by the panel)', resources: 'all', canWrite: true, actor: 'pamela' })).key as string;

    // guide 15 PART 10 (and 16): the comment area for the posts, made on the Comments tab
    await admin({ op: 'form.create', name: 'journal-comments', title: 'Journal comments', kind: 'comments', contentType: 'posts', actor: 'pamela' });
    // the panel's side of the gate, for the test to approve comments the way the panel does
    const adminServer = createGateAdminServer(live, clock, () => {}, { publicRoot: pub, domain: 'pammy.org', pammydbSocket });
    await new Promise<void>((r) => adminServer.listen(join(dir, 'admin.sock'), r));

    const php = createPhpServer((req, res) => app.routing(req, res), 'pammy.org');
    await app.listen({ host: '127.0.0.1', port: Number(port) });
    await new Promise<void>((r) => php.listen(join(dir, 'php.sock'), r));
    // written last: the script waits for this file
    writeFileSync(join(dir, 'world.json'), JSON.stringify({ todoKey, exampleKey, tokens }));
  } catch (e) {
    console.error(e);
    pg.stop();
    process.exit(1);
  }
  setInterval(() => {}, 1 << 30);
}
