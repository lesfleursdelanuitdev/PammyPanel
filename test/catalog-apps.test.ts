// Catalog step 5 (docs/catalog-plan.md): apps as sources. The manifest's catalog section,
// the app keeper (packages/catalog/src/apps.ts) against a throwaway Postgres and a fixture
// service on a real port that checks the panel's signatures and lists its things, and the
// app's door (packages/catalog/src/panel/door.ts) with signed requests.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { checkManifest, ManifestError } from '@panel/areas/manifest';
import { catalogOf, CatalogManifestError } from '@panel/core/manifest-catalog';
import { all, one, run, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { signRequest, signedRequestOk } from '@panel/core/signed';
import { AppError, AppKeeper, MAX_APP_ITEMS } from '@panel/catalog/apps';
import { allScopeId, createScopeLabel, namesByKey, presentItems, sourceCounts } from '@panel/catalog/items';
import { doorApp, DOOR_PER_MINUTE } from '@panel/catalog/panel/door';
import { startPg, type PgTest } from './pg-harness.ts';

const KEY = 'k'.repeat(44);
let pg: PgTest;
let db: Sql;
let clock = 1_800_000_000;
const now = () => clock;

// ------------------------------------------------------------------ the fixture service
type Topic = { id: string; title: string; section?: string };
let topics: Topic[] = [];
let asked: string[] = [];
let answer: number | null = null;          // a status to answer with instead
let fixture: Server;
let port = 0;
fixture = createServer((req, res) => {
  const url = req.url ?? '';
  asked.push(url);
  if (!signedRequestOk(KEY, { ts: req.headers['x-lfdln-timestamp'], signature: req.headers['x-lfdln-signature'] }, req.method ?? '', url, '', Date.now())) {
    res.writeHead(401).end('{}');
    return;
  }
  if (answer) { res.writeHead(answer).end('{}'); return; }
  const u = new URL(url, 'http://x');
  if (u.pathname !== '/_demo/catalog/topics') { res.writeHead(404).end('{}'); return; }
  const limit = Number(u.searchParams.get('limit'));
  const after = u.searchParams.get('after');
  const from = after === null ? 0 : topics.findIndex((t) => t.id === after) + 1;
  const page = topics.slice(from, from + limit);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    items: page, next: from + limit < topics.length ? page.at(-1)!.id : null,
  }));
});

const MANIFEST = (catalog: unknown) => JSON.stringify({ version: 1, name: 'Demo', resources: { questions: { label: 'Questions', actions: ['read'] } }, catalog });
const TOPICS = {
  label: 'Topics', list: '/_demo/catalog/topics', open: '/practice/{id}', scopes: 'section',
  uses: { featured: { kind: 'tag', label: 'Question of the day', means: 'Picked for the daily question' }, hidden: { kind: 'tag', label: 'Hidden' } },
};
let manifest = MANIFEST({ topics: TOPICS });
let keyOf: (s: string) => Promise<string | null> = async (s) => (s === 'demo' ? KEY : null);
let keeper: AppKeeper;

const refsOf = async (resource = 'topics') => keeper.refs('demo', resource);
const itemKeys = async () => [...(await presentItems(db, (await refsOf()).resource)).keys()].sort();

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end({ timeout: 2 });
  db = pg.connect('panel', database, 4);
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  port = (fixture.address() as { port: number }).port;
});
after(async () => {
  fixture.close();
  await db?.end({ timeout: 2 });
  pg?.stop();
});

beforeEach(async () => {
  clock += 1000;
  topics = [
    { id: 'poly-addsub', title: 'Adding polynomials', section: 'Polynomials & exponents' },
    { id: 'poly-divmono', title: 'Dividing by a monomial', section: 'Polynomials & exponents' },
    { id: 'lin-eq', title: 'Linear equations', section: 'Equations' },
    { id: 'word-rate', title: 'Rates' },
  ];
  asked = [];
  answer = null;
  manifest = MANIFEST({ topics: TOPICS });
  keyOf = async (s) => (s === 'demo' ? KEY : null);
  for (const r of await all<{ id: number }>(db, "SELECT id FROM sources WHERE kind = 'app'")) await one(db, 'SELECT drop_source(?)', r.id);
  await run(db, 'DELETE FROM labels WHERE scope_id = (SELECT id FROM scopes WHERE parent_id IS NULL)');
  await run(db, "DELETE FROM sync_state WHERE key LIKE 'app:%'");
  await run(db, 'DELETE FROM activity');
  keeper = new AppKeeper({
    db, now,
    services: async () => [{ id: 'demo', title: 'Demo app' }, { id: 'other', title: 'Other app' }],
    manifest: async (s) => { if (s !== 'demo') throw new Error('Other app has no pammy-panel.json.'); return manifest; },
    port: async () => port,
    key: (s) => keyOf(s),
  });
});

describe('the manifest\'s catalog section (S5-1)', () => {
  it('takes one with a catalog section, and the roles still read the rest', () => {
    const m = checkManifest(MANIFEST({ topics: TOPICS }));
    assert.equal(m.catalog?.[0]?.key, 'topics');
    assert.deepEqual(m.catalog?.[0]?.uses.featured, { kind: 'tag', label: 'Question of the day', means: 'Picked for the daily question' });
    assert.equal(m.catalog?.[0]?.visitorLabels, 'none');
    assert.equal(checkManifest(JSON.stringify({ version: 1, name: 'x' })).catalog, null);
    assert.equal(catalogOf(JSON.stringify({ version: 1, name: 'x' })), null);
  });
  it('refuses a bad section, and with it the whole file', () => {
    const bad = (catalog: unknown, re: RegExp) => {
      assert.throws(() => checkManifest(MANIFEST(catalog)), (e: unknown) => e instanceof ManifestError && e.problems.some((p) => re.test(p)), JSON.stringify(catalog));
      assert.throws(() => catalogOf(MANIFEST(catalog)), CatalogManifestError);
    };
    bad([], /catalog: an object/);
    bad({}, /at least one/);
    bad({ Topics: TOPICS }, /catalog\.Topics: a lowercase word/);
    bad({ topics: { ...TOPICS, list: 'catalog/topics' } }, /\.list: a path/);
    bad({ topics: { ...TOPICS, list: '/a/../b' } }, /\.list: a path/);
    bad({ topics: { ...TOPICS, open: '/practice/' } }, /\.open: .*\{id\}/);
    bad({ topics: { ...TOPICS, open: 'http://x/{id}' } }, /\.open/);
    bad({ topics: { ...TOPICS, scopes: 'a b' } }, /\.scopes/);
    bad({ topics: { ...TOPICS, visitorLabels: 'all' } }, /visitorLabels/);
    bad({ topics: { ...TOPICS, uses: { 'Not A Name': { kind: 'tag', label: 'x' } } } }, /uses\.Not A Name: a label's name/);
    bad({ topics: { ...TOPICS, uses: { x: { kind: 'flag', label: 'x' } } } }, /uses\.x\.kind/);
    bad({ topics: { ...TOPICS, colour: 'red' } }, /"colour" isn't/);
    bad(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, TOPICS])), /at most 10/);
  });
});

describe('a service switched on (S5-2, S5-3)', () => {
  it('says what a service offers, and why one offers nothing', async () => {
    const s = await keeper.status('demo');
    assert.equal(s.on, false);
    assert.deepEqual(s.resources.map((r) => [r.key, r.label, r.offered, r.source]), [['topics', 'Topics', true, null]]);
    const o = await keeper.status('other');
    assert.match(o.error!, /no pammy-panel.json/);
    await assert.rejects(keeper.switchOn('other', 'momolig'), /no pammy-panel.json/);
    await assert.rejects(keeper.status('nope'), /no such service/);
    manifest = JSON.stringify({ version: 1, name: 'Demo' });
    assert.match((await keeper.status('demo')).error!, /no "catalog" section/);
  });

  it('makes a source per kind, reads the list signed, and puts sub-scopes under it', async () => {
    const r = await keeper.switchOn('demo', 'momolig');
    assert.deepEqual(r.read.topics, { items: 4, made: 4, missing: 0 });
    assert.equal(asked[0], '/_demo/catalog/topics?limit=500');
    const refs = await refsOf();
    const src = await one<{ kind: string; ref: string; label: string }>(db, 'SELECT kind, ref, label FROM sources WHERE id = ?', refs.source);
    assert.deepEqual(src, { kind: 'app', ref: 'demo/topics', label: 'Demo app: Topics' });
    const res = await one<{ list_path: string; open_url: string; scopes_field: string; uses: Record<string, unknown> }>(db, 'SELECT list_path, open_url, scopes_field, uses FROM resources WHERE id = ?', refs.resource);
    assert.equal(res!.list_path, '/_demo/catalog/topics');
    assert.equal(res!.open_url, '/practice/{id}');
    assert.deepEqual(Object.keys(res!.uses).sort(), ['featured', 'hidden']);
    assert.deepEqual(await itemKeys(), ['lin-eq', 'poly-addsub', 'poly-divmono', 'word-rate']);
    const scopes = await keeper.subScopes(refs);
    assert.deepEqual(scopes.map((s) => [s.label, s.items]), [['Equations', 1], ['Polynomials & exponents', 2]]);
    const page = await keeper.items(refs, { scope: scopes[1]!.id });
    assert.deepEqual(page.items.map((i) => [i.key, i.scope]), [['poly-addsub', 'Polynomials & exponents'], ['poly-divmono', 'Polynomials & exponents']]);
    assert.equal((await keeper.items(refs, { q: 'rate' })).items[0]!.scope, null);
    const s = await keeper.status('demo');
    assert.equal(s.on, true);
    assert.equal(s.resources[0]!.counts!.items, 4);
    assert.equal(s.resources[0]!.state!.error, null);
  });

  it('reads page after page', async () => {
    topics = Array.from({ length: 1203 }, (_, i) => ({ id: `t${String(i).padStart(5, '0')}`, title: `Topic ${i}` }));
    const r = await keeper.switchOn('demo', 'momolig');
    assert.equal(r.read.topics!.items, 1203);
    assert.deepEqual(asked, ['/_demo/catalog/topics?limit=500', '/_demo/catalog/topics?limit=500&after=t00499', '/_demo/catalog/topics?limit=500&after=t00999']);
  });

  it('goes missing when no longer listed, and comes back only with the same title', async () => {
    await keeper.switchOn('demo', 'momolig');
    const refs = await refsOf();
    const item = await keeper.itemId(refs, 'lin-eq');
    await run(db, "INSERT INTO labels (scope_id, kind, name, created_at) VALUES (?, 'tag', 'hard', ?)", refs.scope, now());
    await run(db, "INSERT INTO links (item_id, label_id) SELECT ?, id FROM labels WHERE name = 'hard'", item);
    const [lin] = topics.splice(2, 1);
    let r = await keeper.readService('demo', 'momolig');
    assert.equal(r.topics!.missing, 1);
    assert.deepEqual(await itemKeys(), ['poly-addsub', 'poly-divmono', 'word-rate']);
    // the Equations sub-scope stays while its missing thing is kept
    assert.deepEqual((await keeper.subScopes(refs)).map((s) => [s.label, s.items]), [['Equations', 0], ['Polynomials & exponents', 2]]);
    topics.push(lin!);
    await keeper.readService('demo', 'momolig');
    assert.deepEqual((await namesByKey(db, refs.resource, ['lin-eq'])).get('lin-eq'), { tags: ['hard'], categories: [] });
    // gone again, and back with another title: a new thing, without the tag
    topics = topics.filter((t) => t.id !== 'lin-eq');
    await keeper.readService('demo', 'momolig');
    topics.push({ id: 'lin-eq', title: 'Something else' });
    r = await keeper.readService('demo', 'momolig');
    assert.deepEqual((await namesByKey(db, refs.resource, ['lin-eq'])).get('lin-eq'), { tags: [], categories: [] });
    assert.equal(r.topics!.made, 1);
  });

  it('a list that fails changes nothing, and says why', async () => {
    await keeper.switchOn('demo', 'momolig');
    answer = 500;
    const r = await keeper.readService('demo', 'momolig');
    assert.match(r.topics!.error!, /answered 500/);
    assert.equal((await itemKeys()).length, 4);
    assert.match((await keeper.status('demo')).resources[0]!.state!.error!, /answered 500/);
    answer = null;
    keyOf = async () => 'z'.repeat(44);           // the service doesn't know this key
    assert.match((await keeper.readService('demo', null)).topics!.error!, /answered 401/);
    keyOf = async () => null;
    assert.match((await keeper.readService('demo', null)).topics!.error!, /no key/);
    keyOf = async () => KEY;
    topics = [{ id: '', title: 'x' }];
    assert.match((await keeper.readService('demo', null)).topics!.error!, /id has to be text/);
    assert.equal((await itemKeys()).length, 4);
  });

  it('refuses more than it may have', async () => {
    topics = Array.from({ length: MAX_APP_ITEMS + 1 }, (_, i) => ({ id: `t${String(i).padStart(6, '0')}`, title: 'x' }));
    const r = await keeper.switchOn('demo', 'momolig');
    assert.match(r.read.topics!.error!, /more than 20,000/);
    assert.equal((await itemKeys()).length, 0);
  });

  it('Read again takes a new kind in, and lets one go only when asked', async () => {
    await keeper.switchOn('demo', 'momolig');
    const refs = await refsOf();
    await run(db, "INSERT INTO labels (scope_id, kind, name, created_at) VALUES (?, 'tag', 'hard', ?)", refs.scope, now());
    await run(db, "INSERT INTO links (item_id, label_id) SELECT ?, id FROM labels WHERE name = 'hard'", await keeper.itemId(refs, 'lin-eq'));
    manifest = MANIFEST({ passages: { label: 'Passages', list: '/_demo/catalog/topics' } });
    await assert.rejects(keeper.readAgain('demo', 'momolig', false), (e: unknown) => e instanceof AppError && e.status === 409 && /Topics \(1 with tags\)/.test(e.message));
    assert.ok(await refsOf());
    // the 15-minute round leaves it too, and takes the new kind in
    await keeper.readAll();
    assert.ok(await refsOf());
    assert.ok(await refsOf('passages'));
    const r = await keeper.readAgain('demo', 'momolig', true);
    assert.deepEqual(r.gone, ['Topics']);
    await assert.rejects(refsOf(), /switched on/);
    assert.equal(r.read.passages!.items, 4);
  });

  it('off: every kind, its labels and items go; Everywhere\'s labels stay', async () => {
    await keeper.switchOn('demo', 'momolig');
    const refs = await refsOf();
    const everywhere = await createScopeLabel(db, now(), 'momolig', await allScopeId(db), 'tag', 'featured');
    await run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', await keeper.itemId(refs, 'lin-eq'), everywhere.id);
    const c = await keeper.switchOff('demo');
    assert.deepEqual([c.items, c.labelled, c.links], [4, 1, 1]);
    assert.equal((await keeper.sources('demo')).size, 0);
    assert.ok(await one(db, 'SELECT 1 FROM labels WHERE id = ?', everywhere.id));
    assert.equal((await one<{ n: number }>(db, "SELECT count(*) AS n FROM scopes WHERE source_id = ?", refs.source))!.n, 0);
  });
});

// ------------------------------------------------------------------ the app's door (S5-4)
describe('the app\'s door', () => {
  let door: ReturnType<typeof doorApp>;
  let ms = Date.now();
  const call = async (method: string, path: string, body?: unknown, o: { service?: string; key?: string; ts?: number } = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(o.ts ?? ms);
    const r = await door.inject({
      method: method as 'GET', url: path, payload: body === undefined ? undefined : text,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-lfdln-service': o.service ?? 'demo', 'x-lfdln-timestamp': ts,
        'x-lfdln-signature': signRequest(o.key ?? KEY, ts, method, path, text),
      },
    });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  beforeEach(async () => {
    ms += 60_000;
    door = doorApp(keeper, { key: (s) => keyOf(s), nowMs: () => ms });
    await keeper.switchOn('demo', 'momolig');
  });

  it('answers only a service that signs with its own key, recently', async () => {
    assert.equal((await door.inject({ method: 'GET', url: '/_catalog/topics/labels' })).statusCode, 401);
    assert.equal((await call('GET', '/_catalog/topics/labels', undefined, { key: 'x'.repeat(44) })).status, 401);
    assert.equal((await call('GET', '/_catalog/topics/labels', undefined, { ts: ms - 6 * 60_000 })).status, 401);
    assert.equal((await call('GET', '/_catalog/topics/labels', undefined, { service: 'other', key: KEY })).status, 401);
    // a signature for another address doesn't do
    const ts = String(ms);
    const r = await door.inject({ method: 'GET', url: '/_catalog/topics/items?tag=a', headers: { 'x-lfdln-service': 'demo', 'x-lfdln-timestamp': ts, 'x-lfdln-signature': signRequest(KEY, ts, 'GET', '/_catalog/topics/labels', '') } });
    assert.equal(r.statusCode, 401);
    assert.equal((await call('GET', '/_catalog/topics/labels')).status, 200);
    // another service's kinds (or none switched on) aren't there for it
    keyOf = async () => KEY;
    assert.equal((await call('GET', '/_catalog/topics/labels', undefined, { service: 'other' })).status, 404);
    assert.equal((await call('GET', '/_catalog/passages/labels')).status, 404);
  });

  it('takes a push: made, changed, moved, gone (with its tags, in Activity)', async () => {
    const refs = await refsOf();
    let r = await call('POST', '/_catalog/topics/items', { items: [{ id: 'new-one', title: 'New one', section: 'Equations' }, { id: 'lin-eq', title: 'Linear equations!' }] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.items, r.body.made, r.body.gone], [2, 1, 0]);
    const page = await keeper.items(refs, {});
    assert.deepEqual(page.items.find((i) => i.key === 'lin-eq'), { key: 'lin-eq', title: 'Linear equations!', scope: null, labels: { tags: [], categories: [] } });
    assert.equal(page.items.find((i) => i.key === 'new-one')!.scope, 'Equations');
    await call('PUT', '/_catalog/topics/items/new-one/labels/tag/hard');
    r = await call('POST', '/_catalog/topics/items', { gone: ['new-one', 'never-there'] });
    assert.equal(r.body.gone, 1);
    const act = await one<{ action: string; actor_label: string; target: string; detail: string }>(db, "SELECT action, actor_label, target, detail FROM activity WHERE action = 'app-item-gone'");
    assert.deepEqual(act, { action: 'app-item-gone', actor_label: 'Demo app', target: 'Topics "New one"', detail: 'it had #hard' });
    assert.equal((await call('POST', '/_catalog/topics/items', { items: 'x' })).status, 400);
    assert.equal((await call('POST', '/_catalog/topics/items', { items: [{ title: 'no id' }] })).status, 400);
  });

  it('the app tags its own things: its own labels made, Everywhere\'s used, never made', async () => {
    const refs = await refsOf();
    const everywhere = await createScopeLabel(db, now(), 'momolig', await allScopeId(db), 'tag', 'featured');
    let r = await call('PUT', '/_catalog/topics/items/lin-eq/labels/tag/featured');
    assert.deepEqual([r.status, r.body.changed, r.body.created], [200, true, false]);
    r = await call('PUT', '/_catalog/topics/items/poly-addsub/labels/tag/hidden');
    assert.deepEqual([r.body.changed, r.body.created], [true, true]);
    r = await call('PUT', '/_catalog/topics/items/poly-addsub/labels/category/algebra');
    assert.equal(r.body.created, true);
    // made in the kind's own scope, by the app
    const made = await one<{ scope_id: number; created_by: string }>(db, "SELECT scope_id, created_by FROM labels WHERE name = 'hidden'");
    assert.deepEqual([Number(made!.scope_id), made!.created_by], [refs.scope, 'app:demo']);
    assert.equal(Number((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM labels WHERE scope_id = ?', await allScopeId(db)))!.n), 1);
    // again: no change
    assert.equal((await call('PUT', '/_catalog/topics/items/lin-eq/labels/tag/featured')).body.changed, false);
    assert.deepEqual((await call('GET', '/_catalog/topics/items/poly-addsub/labels')).body, { tags: ['hidden'], categories: ['algebra'] });
    // the labels, with what they mean to it
    const labels = (await call('GET', '/_catalog/topics/labels')).body.labels as { type: string; name: string; everywhere: boolean; count: number; use: { label: string } | null }[];
    assert.deepEqual(labels.map((l) => [l.type, l.name, l.everywhere, l.count, l.use?.label ?? null]),
      [['category', 'algebra', false, 1, null], ['tag', 'featured', true, 1, 'Question of the day'], ['tag', 'hidden', false, 1, 'Hidden']]);
    // asking by label: all of them
    await call('PUT', '/_catalog/topics/items/lin-eq/labels/tag/hidden');
    assert.deepEqual((await call('GET', '/_catalog/topics/items?tag=hidden')).body.ids, ['lin-eq', 'poly-addsub']);
    assert.deepEqual((await call('GET', '/_catalog/topics/items?tag=hidden&tag=featured')).body.ids, ['lin-eq']);
    assert.deepEqual((await call('GET', '/_catalog/topics/items?tag=hidden&category=algebra')).body.ids, ['poly-addsub']);
    assert.deepEqual((await call('GET', '/_catalog/topics/items?tag=nobody')).body.ids, []);
    // off again
    r = await call('DELETE', '/_catalog/topics/items/lin-eq/labels/tag/featured');
    assert.equal(r.body.changed, true);
    assert.ok(await one(db, 'SELECT 1 FROM labels WHERE id = ?', everywhere.id));
    assert.deepEqual((await call('GET', '/_catalog/topics/items/lin-eq/labels')).body, { tags: ['hidden'], categories: [] });
    // Activity names the service
    const acts = await all<{ action: string; actor_label: string; target: string; detail: string }>(db, "SELECT action, actor_label, target, detail FROM activity WHERE action LIKE 'app-%tagged' ORDER BY id");
    assert.deepEqual(acts[0], { action: 'app-tagged', actor_label: 'Demo app', target: 'Topics "Linear equations"', detail: '#featured' });
    assert.equal(acts.at(-1)!.action, 'app-untagged');
    // bad asks
    assert.equal((await call('PUT', '/_catalog/topics/items/nope/labels/tag/x')).status, 404);
    assert.equal((await call('PUT', '/_catalog/topics/items/lin-eq/labels/flag/x')).status, 404);
    assert.equal((await call('PUT', '/_catalog/topics/items/lin-eq/labels/tag/Not%20OK')).status, 400);
    assert.equal((await sourceCounts(db, refs.source)).labels, 2);
  });

  it(`at most ${DOOR_PER_MINUTE} requests a minute`, async () => {
    for (let i = 0; i < DOOR_PER_MINUTE; i++) assert.equal((await call('GET', '/_catalog/topics/labels')).status, 200);
    assert.equal((await call('GET', '/_catalog/topics/labels')).status, 429);
    ms += 60_000;
    assert.equal((await call('GET', '/_catalog/topics/labels')).status, 200);
  });
});
