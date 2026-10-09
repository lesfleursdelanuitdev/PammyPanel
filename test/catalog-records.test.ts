// Catalog step 4 (docs/catalog-plan.md): a Studio table as a source. The record keeper
// (packages/studio/src/panel/tagging.ts) against a throwaway Postgres, with her table
// in memory in place of the database helper and a list in place of the gate; the
// catalog's items and labels (packages/catalog/src/items.ts); Everywhere's labels on the
// website's files; the gate's touches.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { migrate } from '@panel/core/pg-migrate';
import { all, one, run, type Sql } from '@panel/core/pg';
import {
  allScopeId, createScopeLabel, deleteScopeLabel, setScopeLabelPublic, keysWithLabel, namesByKey, namesOn, presentItems, purgeMissing, scopeLabels, setItemLabels,
  sourceCounts, websitePictures,
} from '@panel/catalog/items';
import { findLabelInAncestors } from '@panel/catalog/scopes';
import { linkedLabels, listLabels, listLabelsAround } from '@panel/catalog/labels';
import { recordAdded, recordCopied, recordMoved } from '@panel/files/media-db';
import { RecordKeeper } from '@panel/studio/panel/tagging';
import { noteTouch, takeTouches, touchKey } from '@panel/studio/gate/studio';
import { buildCatalog } from '@panel/studio/studio/catalog';
import { resourceViews, type ResourceView } from '@panel/studio/studio/resources';
import { fieldRows, resourceRows } from '@panel/studio/studio/resource-store';
import { recordKey, sitePathOf, whereOfKey } from '@panel/studio/studio/tagging';
import type { Column, Snapshot, Table } from '@panel/studio/pammydb/ir';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let db: Sql;
let gateDb: Sql;
let clock = 1_800_000_000;
const now = () => clock;

// ------------------------------------------------------------------ her table, in memory
const col = (name: string, type: Column['type'], required = false): Column => ({ name, type, required });
const recipesTable: Table = {
  name: 'recipes', columns: [col('id', 'integer', true), col('name', 'short_text', true), col('photo', 'short_text')],
  primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
};
const pairsTable: Table = {
  name: 'pairs', columns: [col('a', 'integer', true), col('b', 'integer', true), col('label', 'short_text')],
  primaryKey: ['a', 'b'], uniques: [], foreignKeys: [], indexes: [],
};
type Row = Record<string, unknown>;
let rows: Record<string, Row[]> = {};
let lies: { table: string; total: number } | null = null;   // a listing whose table changes size under it
const touches: { database_id: number; table_name: string; key: string | null; what: 'changed' | 'deleted' }[] = [];

const studio = async <T,>(req: Record<string, unknown>): Promise<T> => {
  if (req.op === 'introspect') return { engine: 'postgres', database: 'kitchen', tables: [recipesTable, pairsTable], notes: [], hash: 'h' } as Snapshot as T;
  const q = req.query as { table: string; columns: string[]; limit: number; offset: number; filters: { kind: string; column: string; values: unknown[] }[] } | undefined;
  if (req.op === 'list-rows') {
    let all = [...(rows[q!.table] ?? [])];
    for (const f of q!.filters) if (f.kind === 'in') all = all.filter((r) => f.values.includes(r[f.column]));
    all.sort((x, y) => Number(x.id ?? x.a) - Number(y.id ?? y.a));
    const page = all.slice(q!.offset, q!.offset + q!.limit).map((r) => Object.fromEntries(q!.columns.map((c) => [c, r[c] ?? null])));
    const total = lies && lies.table === q!.table && q!.offset > 0 ? lies.total : all.length;
    return { items: page, total } as T;
  }
  if (req.op === 'get-row') {
    const where = req.where as Row;
    const r = (rows[req.table as string] ?? []).find((x) => Object.entries(where).every(([k, v]) => x[k] === v));
    return { row: r ? Object.fromEntries((req.columns as string[]).map((c) => [c, r[c] ?? null])) : null } as T;
  }
  throw new Error(`stub: ${String(req.op)}`);
};
const told: Record<string, unknown>[] = [];   // what the gate was sent (step 4b)
const gate = async <T,>(req: Record<string, unknown>): Promise<T> => {
  if (req.op === 'record-touches.take') return { touches: touches.splice(0) } as T;
  if (req.op === 'record-labels.put' || req.op === 'record-labels.keep') { told.push(req); return {} as T; }
  throw new Error(`stub gate: ${String(req.op)}`);
};

let keeper: RecordKeeper;
let databaseId: number;
const views = async (): Promise<ResourceView[]> =>
  resourceViews({ engine: 'postgres', database: 'kitchen', tables: [recipesTable, pairsTable], notes: [] }, await resourceRows(db, databaseId), await fieldRows(db, databaseId));
const recipes = async () => (await views()).find((r) => r.table === 'recipes')!;
const d = () => ({ id: databaseId, engine: 'postgres' as const, name: 'kitchen' });
const refs = async () => (await keeper.refs(await recipes()))!;
const itemOf = async (key: string) => (await presentItems(db, (await refs()).resource)).get(key);

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end({ timeout: 2 });
  db = pg.connect('panel', database, 4);
  gateDb = pg.connect('gate', database, 2);
});
after(async () => {
  await db?.end({ timeout: 2 });
  await gateDb?.end({ timeout: 2 });
  pg?.stop();
});

beforeEach(async () => {
  clock += 1000;
  rows = {
    recipes: [{ id: 1, name: 'Lemon tart', photo: 'media/tart.jpg' }, { id: 2, name: 'Soup', photo: null }, { id: 3, name: 'Bread', photo: 'https://elsewhere.example/b.jpg' }],
    pairs: [{ a: 1, b: 2, label: 'one-two' }],
  };
  lies = null;
  touches.length = 0;
  told.length = 0;
  // a fresh database the panel looks after, each test
  await run(db, 'DELETE FROM studio_databases');
  databaseId = Number((await one<{ id: number }>(db, "INSERT INTO studio_databases (engine, name, adopted_at, status) VALUES ('postgres', 'kitchen', ?, 'active') RETURNING id", now()))!.id);
  await run(db, 'INSERT INTO studio_resources (database_id, table_name, enabled) VALUES (?, ?, true), (?, ?, true)', databaseId, 'recipes', databaseId, 'pairs');
  keeper = new RecordKeeper(db, studio, gate, now);
});

describe('a record as the catalog keeps it (pure)', () => {
  it('names a record by its key, and back', async () => {
    const [r, p] = await Promise.all([recipes(), views().then((v) => v.find((x) => x.table === 'pairs')!)]);
    assert.equal(recordKey(r, { id: 7, name: 'x' }), '7');
    assert.deepEqual(whereOfKey(r, '7'), { id: 7 });
    assert.equal(recordKey(p, { a: 1, b: 22 }), '["1","22"]');
    assert.deepEqual(whereOfKey(p, '["1","22"]'), { a: 1, b: 22 });
    assert.equal(recordKey(r, { id: null }), null);
    assert.equal(whereOfKey(p, 'not json'), null);
  });
  it('reads a picture only as a path on her website', () => {
    assert.equal(sitePathOf('media/tart.jpg'), 'media/tart.jpg');
    assert.equal(sitePathOf('/media/My%20tart.jpg?x=1'), 'media/My tart.jpg');
    assert.equal(sitePathOf('https://elsewhere.example/b.jpg'), null);
    assert.equal(sitePathOf('data:image/png;base64,AAAA'), null);
    assert.equal(sitePathOf('../../etc/passwd'), null);
    assert.equal(sitePathOf(''), null);
  });
  it('tells the gate which tables she tags, and the gate notes only those', async () => {
    const r = await recipes();
    assert.equal(buildCatalog([r]).resources[0]!.tagged, undefined);
    await keeper.switchOn(databaseId, r, 'momolig', null);
    const on = buildCatalog([await recipes()]).resources[0]!;
    assert.equal(on.tagged, true);
    assert.equal(touchKey(on, { id: 5, owner: 'x' }), '5');
    await noteTouch(gateDb, now(), databaseId, { ...on, tagged: false }, 'changed');
    await noteTouch(gateDb, now(), databaseId, on, 'changed');
    await noteTouch(gateDb, now(), databaseId, on, 'deleted', '5');
    await noteTouch(gateDb, now() - 8 * 86400, databaseId, on, 'changed');   // a week old: goes
    const got = await takeTouches(gateDb, now());
    assert.deepEqual(got.touches.map((t) => [t.table_name, t.what, t.key]), [['recipes', 'changed', null], ['recipes', 'deleted', '5']]);
    assert.deepEqual((await takeTouches(gateDb, now())).touches, []);
  });
});

describe('the switch (S4-1, S4-9)', () => {
  it('makes a source under All, and an item for every record', async () => {
    const res = await keeper.switchOn(databaseId, await recipes(), 'momolig', 'photo');
    assert.deepEqual({ items: res.items, made: res.made, missing: res.missing }, { items: 3, made: 3, missing: 0 });
    const r = await recipes();
    assert.equal(r.tagged, true);
    assert.equal(r.pictureField, 'photo');
    const scope = await one<{ parent_id: number; label: string; path: string }>(db, 'SELECT parent_id, label, path FROM scopes WHERE id = ?', (await refs()).scope);
    assert.deepEqual({ ...scope, parent_id: Number(scope!.parent_id) }, { parent_id: await allScopeId(db), label: 'Recipes', path: '/' });
    assert.equal((await itemOf('1'))!.title, 'Lemon tart');
    const pics = await all<{ picture: string | null }>(db, 'SELECT picture FROM studio_catalog_records ORDER BY item_id');
    assert.deepEqual(pics.map((p) => p.picture), ['media/tart.jpg', null, 'https://elsewhere.example/b.jpg']);
    assert.deepEqual(await sourceCounts(db, (await refs()).source), { items: 3, labelled: 0, links: 0, labels: 0 });
  });
  it('refuses a table without a key and one too big', async () => {
    const noKey = { ...(await recipes()), fields: (await recipes()).fields.map((f) => ({ ...f, primaryKey: false })) };
    await assert.rejects(keeper.switchOn(databaseId, noKey, 'momolig', null), /no field that tells one record from another/);
    rows.recipes = Array.from({ length: 20_001 }, (_, i) => ({ id: i + 1, name: `r${i}` }));
    await assert.rejects(keeper.switchOn(databaseId, await recipes(), 'momolig', null), /20,001 records; tags work on tables of up to 20,000/);
    assert.equal((await recipes()).tagged, false);
  });
  it('off: the table\'s labels and links go, Everywhere\'s labels stay on everything else', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    const file = await recordAdded(db, now(), { path: 'media/images/tart.jpg', size: 1, modifiedAt: now(), hash: null, how: 'uploaded', by: 'pamela' });
    const featured = await createScopeLabel(db, now(), 'momolig', await allScopeId(db), 'tag', 'featured');
    await run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', file, featured.id);
    await setItemLabels(db, now(), 'pamela', (await itemOf('1'))!.id, (await refs()).scope, { tags: ['featured', 'lemon'], categories: ['desserts'] });
    const r = await recipes();
    const had = await keeper.switchOff(databaseId, r);
    assert.deepEqual({ labelled: had!.labelled, labels: had!.labels }, { labelled: 1, labels: 2 });
    assert.equal((await recipes()).tagged, false);
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM sources WHERE kind = ?', 'studio'))!.n, 0);
    const left = await scopeLabels(db, [await allScopeId(db)]);
    assert.deepEqual(left.map((l) => [l.name, l.count]), [['featured', 1]]);
    await deleteScopeLabel(db, await allScopeId(db), 'tag', featured.id);
  });
  it('a table that goes (its Studio row deleted) takes its source with it; a rename keeps it', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    const source = (await refs()).source;
    await run(db, "UPDATE studio_resources SET table_name = 'dishes' WHERE database_id = ? AND table_name = 'recipes'", databaseId);
    assert.ok(await one(db, 'SELECT 1 FROM sources WHERE id = ?', source));
    await run(db, "DELETE FROM studio_resources WHERE database_id = ? AND table_name = 'dishes'", databaseId);
    assert.equal(await one(db, 'SELECT 1 FROM sources WHERE id = ?', source), undefined);
    assert.equal((await one(db, 'SELECT count(*)::int AS n FROM items WHERE resource_id NOT IN (SELECT id FROM resources)'))!.n, 0);
  });
  it('the database no longer looked after: every tagged table of it goes', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    await run(db, 'DELETE FROM studio_databases WHERE id = ?', databaseId);
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM sources WHERE kind = 'studio'"))!.n, 0);
  });
});

describe('keeping in step (S4-3, S4-4)', () => {
  it('a listing adds, retitles, and marks missing; the same title brings its labels back, another does not', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    const tart = (await itemOf('1'))!.id;
    await setItemLabels(db, now(), 'pamela', tart, (await refs()).scope, { tags: ['lemon'] });
    rows.recipes!.push({ id: 4, name: 'Jam' });
    rows.recipes![1]!.name = 'Pea soup';
    rows.recipes = rows.recipes!.filter((r) => r.id !== 1);
    let res = await keeper.readNow(d(), await recipes(), 'test');
    assert.deepEqual({ made: res.made, missing: res.missing, items: res.items }, { made: 1, missing: 1, items: 3 });
    assert.equal((await itemOf('2'))!.title, 'Pea soup');
    assert.equal(await itemOf('1'), undefined);
    assert.deepEqual((await one(db, 'SELECT state FROM items WHERE id = ?', tart))!.state, 'missing');
    // back, as it was: its labels too
    rows.recipes!.push({ id: 1, name: 'Lemon tart' });
    res = await keeper.readNow(d(), await recipes(), 'test');
    assert.equal((await itemOf('1'))!.id, tart);
    assert.deepEqual(await namesOn(db, tart), { tags: ['lemon'], categories: [] });
    // gone again, and the key handed to another recipe: a new item, no labels
    rows.recipes = rows.recipes!.filter((r) => r.id !== 1);
    await keeper.readNow(d(), await recipes(), 'test');
    rows.recipes!.push({ id: 1, name: 'Plum cake' });
    await keeper.readNow(d(), await recipes(), 'test');
    const cake = (await itemOf('1'))!;
    assert.notEqual(cake.id, tart);
    assert.deepEqual(await namesOn(db, cake.id), { tags: [], categories: [] });
  });
  it('a listing that saw the table change size under it marks nothing missing', async () => {
    rows.recipes = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `r${i + 1}` }));
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    rows.recipes = rows.recipes!.filter((r) => r.id !== 3);
    lies = { table: 'recipes', total: 251 };
    const res = await keeper.readNow(d(), await recipes(), 'test');
    assert.equal(res.missing, 0);
    assert.ok(await itemOf('3'));
    lies = null;
    assert.equal((await keeper.readNow(d(), await recipes(), 'test')).missing, 1);
  });
  it('records missing 30 days are forgotten; the website\'s files are not the keeper\'s', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    rows.recipes = rows.recipes!.filter((r) => r.id !== 2);
    await keeper.readNow(d(), await recipes(), 'test');
    assert.equal(await purgeMissing(db, now() + 29 * 86400), 0);
    assert.equal(await purgeMissing(db, now() + 31 * 86400), 1);
  });
  it('the panel\'s own writes: saved puts it in (reading back what the page did not have), deleted takes it out and says what went', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    rows.recipes!.push({ id: 9, name: 'Fudge' });
    const id = await keeper.recordSaved({ engine: 'postgres', name: 'kitchen' }, await recipes(), { id: 9 }, 'pamela');
    assert.equal((await itemOf('9'))!.id, id);
    assert.equal((await itemOf('9'))!.title, 'Fudge');
    await setItemLabels(db, now(), 'pamela', id!, (await refs()).scope, { tags: ['sweet'], categories: ['desserts'] });
    await keeper.recordDeleted(await recipes(), '9', { id: null, label: 'pamela' });
    assert.equal(await itemOf('9'), undefined);
    const a = await one<{ target: string; detail: string }>(db, "SELECT target, detail FROM activity WHERE action = 'record-labels-gone' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(a, { target: 'Recipe "Fudge"', detail: 'it had desserts, #sweet' });
    // a table without tags on: nothing happens
    const pairs = (await views()).find((r) => r.table === 'pairs')!;
    assert.equal(await keeper.recordSaved({ engine: 'postgres', name: 'kitchen' }, pairs, { a: 1, b: 2 }, 'pamela'), null);
  });
  it('the gate\'s touches: a delete with its key goes at once, anything else reads the table again', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    rows.recipes!.push({ id: 5, name: 'Scones' });
    rows.recipes = rows.recipes!.filter((r) => r.id !== 2);
    touches.push({ database_id: databaseId, table_name: 'recipes', key: '2', what: 'deleted' }, { database_id: databaseId, table_name: 'recipes', key: null, what: 'changed' });
    assert.equal(await keeper.takeTouches(), 2);
    assert.ok(await itemOf('5'));
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM items WHERE key = '2' AND resource_id = ?", (await refs()).resource))!.n, 0);
  });
  it('readAll reads every tagged table; one it can\'t read says why and keeps its items', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    rows.recipes!.push({ id: 6, name: 'Pie' });
    assert.equal(await keeper.readAll(), 1);
    assert.ok(await itemOf('6'));
    rows.recipes = Array.from({ length: 20_001 }, (_, i) => ({ id: i + 1, name: `r${i}` }));
    await keeper.readAll();
    const st = await keeper.state((await refs()).source);
    assert.match(st!.error!, /more than the 20,000 tags work on/);
    assert.equal(st!.items, 4);
  });
});

describe('labels on records (S4-5, S4-6)', () => {
  it('a name is the table\'s own, else Everywhere\'s, else made in the table\'s scope', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    const everywhere = await allScopeId(db);
    const featured = await createScopeLabel(db, now(), 'momolig', everywhere, 'tag', 'featured');
    const tart = (await itemOf('1'))!.id;
    const res = await setItemLabels(db, now(), 'pamela', tart, (await refs()).scope, { tags: ['featured', 'lemon'], categories: ['desserts'] });
    assert.deepEqual(res.created.sort(), ['@recipes/c/desserts', '@recipes/t/lemon']);
    assert.deepEqual(res.names, { tags: ['featured', 'lemon'], categories: ['desserts'] });
    const labels = await scopeLabels(db, [(await refs()).scope, everywhere]);
    assert.deepEqual(labels.map((l) => [l.address, l.everywhere, l.count]),
      [['*/t/featured', true, 1], ['@recipes/t/lemon', false, 1], ['@recipes/c/desserts', false, 1]]);
    assert.deepEqual(await keysWithLabel(db, (await refs()).resource, featured.id), ['1']);
    const byKey = await namesByKey(db, (await refs()).resource, ['1', '2']);
    assert.deepEqual(byKey.get('1'), { tags: ['featured', 'lemon'], categories: ['desserts'] });
    // taking one off; saving the same again changes nothing
    assert.equal((await setItemLabels(db, now(), 'pamela', tart, (await refs()).scope, { tags: ['lemon'], categories: ['desserts'] })).changed, true);
    assert.equal((await setItemLabels(db, now(), 'pamela', tart, (await refs()).scope, { tags: ['lemon'], categories: ['desserts'] })).changed, false);
    await deleteScopeLabel(db, everywhere, 'tag', featured.id);
  });
  it('a table\'s label never goes on a file, nor a folder\'s on a record (the schema refuses)', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    const lemon = await createScopeLabel(db, now(), 'pamela', (await refs()).scope, 'tag', 'lemon');
    const file = await recordAdded(db, now(), { path: 'media/images/lemon.jpg', size: 1, modifiedAt: now(), hash: null, how: 'uploaded', by: 'pamela' });
    await assert.rejects(run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', file, lemon.id), /only goes on files in its own scope/);
    const site = (await one<{ id: number }>(db, "INSERT INTO labels (scope_id, kind, name, created_at) VALUES ((SELECT id FROM scopes WHERE source_id = 1 AND path = '/'), 'tag', 'site-only', 1) RETURNING id"))!.id;
    await assert.rejects(run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', (await itemOf('1'))!.id, site), /only goes on files in its own scope/);
  });
  it('shows a record with its website picture\'s thumbnail, only one already made', async () => {
    const file = await recordAdded(db, now(), { path: 'media/tart.jpg', size: 1, modifiedAt: now(), hash: 'a'.repeat(64), how: 'uploaded', by: 'pamela' });
    assert.equal((await websitePictures(db, ['media/tart.jpg'])).size, 0);
    await run(db, "INSERT INTO thumbs (item_id, hash, result, width, height, made_at) VALUES (?, ?, 'picture', 10, 10, 1)", file, 'a'.repeat(64));
    assert.equal((await websitePictures(db, ['media/tart.jpg', 'media/none.jpg'])).get('media/tart.jpg'), `/api/media/thumb/${file}?v=aaaaaaaaaaaa`);
  });
});

describe('Everywhere on the website\'s files (C5, C14)', () => {
  it('a file can have one; the website\'s own lists stay as they were', async () => {
    const everywhere = await allScopeId(db);
    const featured = await createScopeLabel(db, now(), 'momolig', everywhere, 'category', 'featured-x');
    const found = await findLabelInAncestors(db, 'category', 'olivia/menu.html', 'featured-x');
    assert.deepEqual(found, { id: featured.id, scope: '*' });
    assert.equal((await listLabels(db, null)).some((l) => l.name === 'featured-x'), false);
    assert.ok((await listLabelsAround(db, 'olivia')).some((l) => l.name === 'featured-x' && l.scope === '*'));
    // on a file, it stays through a move and comes along on a copy
    const f = await recordAdded(db, now(), { path: 'olivia/a.html', size: 1, modifiedAt: now(), hash: null, how: 'uploaded', by: 'pamela' });
    await run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', f, featured.id);
    await recordMoved(db, now(), 'olivia/a.html', 'garden/a.html', 'pamela');
    assert.deepEqual((await linkedLabels(db, f)).map((l) => [l.scope, l.name]), [['*', 'featured-x']]);
    const copy = await recordCopied(db, now(), 'garden/a.html', { path: 'garden/b.html', size: 1, modifiedAt: now() }, 'pamela');
    assert.deepEqual((await linkedLabels(db, copy.id)).map((l) => [l.scope, l.id]), [['*', featured.id]]);
    assert.deepEqual(copy.created, { tags: [], categories: [] });
    await deleteScopeLabel(db, everywhere, 'category', featured.id);
  });
});

describe('what the data API is told (step 4b)', () => {
  const lastPut = () => told.filter((t) => t.op === 'record-labels.put').at(-1) as { table: string; databaseId: number; labels: unknown[]; records: unknown[] } | undefined;
  it('each listing sends the table\'s labels; a change sends them again, once for a flurry', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    assert.deepEqual({ ...lastPut(), op: undefined }, { op: undefined, databaseId, table: 'recipes', labels: [], records: [] });
    const r = await refs();
    const featured = await createScopeLabel(db, now(), 'momolig', await allScopeId(db), 'tag', 'featured-b');
    await setItemLabels(db, now(), 'pamela', (await itemOf('1'))!.id, r.scope, { tags: ['featured-b', 'lemon'], categories: ['desserts'] });
    await setItemLabels(db, now(), 'pamela', (await itemOf('2'))!.id, r.scope, { tags: ['lemon'] });
    await setScopeLabelPublic(db, await allScopeId(db), 'tag', featured.id, true);
    const before = told.length;
    keeper.labelsChanged(r.source);
    keeper.labelsChanged(r.source);
    await keeper.flush();
    assert.equal(told.length, before + 1, 'two changes, one message');
    const put = lastPut()!;
    assert.deepEqual(put.labels, [{ kind: 'category', name: 'desserts', public: false }, { kind: 'tag', name: 'featured-b', public: true }, { kind: 'tag', name: 'lemon', public: false }]);
    assert.deepEqual(put.records, [['1', [0, 1, 2]], ['2', [2]]]);
    await deleteScopeLabel(db, await allScopeId(db), 'tag', featured.id);
  });
  it('off: the gate is told the table has none; a full check says which tables are still tagged', async () => {
    await keeper.switchOn(databaseId, await recipes(), 'momolig', null);
    await keeper.readAll();
    assert.deepEqual(told.filter((t) => t.op === 'record-labels.keep').at(-1)!.tables, [{ databaseId, table: 'recipes' }]);
    await keeper.switchOff(databaseId, await recipes());
    assert.deepEqual({ labels: lastPut()!.labels, records: lastPut()!.records }, { labels: [], records: [] });
    await keeper.readAll();
    assert.deepEqual(told.filter((t) => t.op === 'record-labels.keep').at(-1)!.tables, []);
  });
});
