// The media records (src/media-db.ts) and the sync's reasoning (planSync in
// src/media-sync.ts), without the website folder helper: schema `media` in a
// throwaway Postgres (test/pg-harness.ts). The helper and the routes:
// panel.test.ts. What the schema itself refuses, SQLite's rules beside
// Postgres's: pg.test.ts.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  KEEP_DAYS, placeOf, presentAt, presentIn, purgeRecords, recordAdded, recordCopied, recordMoved, recordRestored, recordTrashed,
  type MediaRow,
} from '@panel/files/media-db';
import { planSync } from '@panel/files/media-sync';
import { migrate } from '@panel/core/pg-migrate';
import { all, one, run, tx, type Sql } from '@panel/core/pg';
import { ensureScope } from '@panel/catalog/scopes';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let db: Sql;
const T = 1_800_000_000;

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end({ timeout: 2 });
  db = pg.connect('panel', database, 4);
});
after(async () => {
  await db?.end({ timeout: 2 });
  pg?.stop();
});

const add = (path: string, extra: Partial<{ size: number; hash: string | null; by: string }> = {}) =>
  recordAdded(db, T, { path, size: extra.size ?? 10, modifiedAt: T - 100, hash: extra.hash ?? null, how: 'uploaded', by: extra.by ?? 'pamela' });
// (since catalog step 2 the records are catalog.items + files.files, read as `records`, and
// the labels catalog.labels in catalog.scopes, linked by catalog.links)
const row = async (id: number) => (await one<MediaRow>(db, 'SELECT * FROM records WHERE id = ?', id))!;
const scopeOf = (path: string) => ensureScope(db, path, T, { automatic: false });
const label = async (table: 'tags' | 'categories', scope: string, name: string) =>
  (await one<{ id: number }>(db, 'INSERT INTO labels (scope_id, kind, name, created_at) VALUES (?, ?, ?, ?) RETURNING id', await scopeOf(scope), table === 'tags' ? 'tag' : 'category', name, T))!.id;
const tag = (mediaId: number, tagId: number) => run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', mediaId, tagId);
const labelsOf = async (id: number) => (await all<{ kind: string; scope: string; name: string }>(db,
  'SELECT l.kind, s.path AS scope, l.name FROM links x JOIN labels l ON l.id = x.label_id JOIN scopes s ON s.id = l.scope_id WHERE x.item_id = ? ORDER BY l.kind DESC, l.name', id))
  .map((l) => `${l.scope === '/' ? '' : l.scope}/${l.kind === 'tag' ? 't' : 'c'}/${l.name}`);
// a record written straight into the tables, as a sync or a bug might
const raw = (path: string, scope: string, kind: string, name: string, size = 1) => tx(db, async (q) => {
  const item = await one<{ id: number }>(q, "INSERT INTO items (resource_id, key, scope_id, kind, changed_at) VALUES (1, ?, ?, ?, 1) RETURNING id", path, await ensureScope(q, scope, T, { automatic: false }), kind);
  await run(q, "INSERT INTO files (item_id, name, size, modified_at, added_at, how) VALUES (?, ?, ?, 1, 1, 'found')", item!.id, name, size);
  return item!.id;
});
const refuses = (fn: () => Promise<unknown>, re: RegExp) => assert.rejects(fn, re);

describe('the media records: what they refuse (D5, D7, D10)', () => {
  it('knows where a path belongs', () => {
    assert.deepEqual(placeOf('olivia/media/images/2026/dog.jpg'), { scope: '/olivia', kind: 'images', name: 'dog.jpg' });
    assert.deepEqual(placeOf('media/audio/song.mp3'), { scope: '/', kind: 'audio', name: 'song.mp3' });
    assert.deepEqual(placeOf('olivia/index.html'), { scope: '/olivia', kind: 'pages', name: 'index.html' });
    assert.deepEqual(placeOf('readme.txt'), { scope: '/', kind: 'files', name: 'readme.txt' });
    for (const p of ['media//images/x.jpg', '.hidden/x.jpg', 'login-files/x.txt']) assert.equal(placeOf(p), null, p);
  });

  it('a record whose scope, kind or name disagrees with its path', async () => {
    await raw('olivia/media/images/ok.jpg', '/olivia', 'images', 'ok.jpg');
    await raw('media/images/ok.jpg', '/', 'images', 'ok.jpg');
    await refuses(() => raw('olivia/media/images/x.jpg', '/', 'images', 'x.jpg'), /check constraint/);
    await refuses(() => raw('media/images/x.jpg', '/media', 'images', 'x.jpg'), /check constraint/);
    await refuses(() => raw('olivia/media/images/x.jpg', '/olivia', 'images', 'y.jpg'), /check constraint/);
    await raw('olivia/index.html', '/olivia', 'pages', 'index.html');
    await raw('olivia/stuff/note.txt', '/olivia', 'files', 'note.txt');
    await refuses(() => run(db, "UPDATE items SET state = 'trashed' WHERE key = 'media/images/ok.jpg'"), /check constraint/);   // trashed needs its trash id
    await run(db, "DELETE FROM items WHERE id IN (SELECT id FROM records WHERE name IN ('ok.jpg', 'index.html', 'note.txt'))");
  });

  it('two records for one file that is there, but not for one that went missing', async () => {
    const a = await add('media/images/same.jpg');
    await refuses(() => raw('media/images/same.jpg', '/', 'images', 'same.jpg'), /duplicate key|unique constraint/);
    await run(db, "UPDATE items SET state = 'missing', state_at = ? WHERE id = ?", T, a);
    const b = await add('media/images/same.jpg');
    assert.notEqual(a, b);
    await run(db, 'DELETE FROM items WHERE id IN (?, ?)', a, b);
  });

  it('tag and category names like form names, in a real scope', async () => {
    await label('tags', '/', 'summer-2026');
    for (const [scope, name] of [['/', 'Summer'], ['/', 'a b'], ['/', ''], ['/', 'x'.repeat(41)], ['olivia', 'x'], ['', 'x']]) {
      await refuses(() => label('tags', scope!, name!), /check constraint/);
    }
    await label('tags', '/a/b', 'nested');             // nested folder scopes are allowed
    await refuses(() => label('tags', '/', 'summer-2026'), /duplicate key|unique constraint/);
    await label('tags', '/olivia', 'summer-2026');     // another scope: another tag
  });

  it('labels only link within their scope (or an ancestor), whichever side changes', async () => {
    const f = await add('olivia/media/images/dog.jpg');
    const mine = await label('tags', '/olivia', 'dogs');
    const root = await label('tags', '/', 'everywhere');
    const nested = await label('tags', '/olivia/media/images', 'pics');
    const other = await label('tags', '/garden', 'dogs');
    const cat = await label('categories', '/garden', 'pets');
    await tag(f, mine);
    await tag(f, root);
    await tag(f, nested);
    await refuses(() => tag(f, other), /only goes on files in its own scope/);
    await refuses(() => run(db, 'INSERT INTO links (item_id, label_id) VALUES (?, ?)', f, cat), /only goes on files in its own scope/);
    await refuses(() => run(db, 'UPDATE links SET label_id = ? WHERE item_id = ? AND label_id = ?', other, f, mine), /only goes on files in its own scope/);
    const x = await scopeOf('/x');
    await refuses(() => run(db, 'UPDATE labels SET scope_id = ? WHERE id = ?', x, mine), /another scope still have this label/);
    const garden = await scopeOf('/garden');
    await refuses(() => run(db, "UPDATE items SET key = 'garden/media/images/dog.jpg', scope_id = ? WHERE id = ?", garden, f), /move the labels/);
    await run(db, 'DELETE FROM items WHERE id = ?', f);
    assert.equal((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM links'))!.n, 0, 'links go with the record');
  });
});

describe('the media records: changes made through the panel', () => {
  it('a move or rename keeps the id and labels; into another media folder they go by name (D8)', async () => {
    const f = await add('garden/media/images/rose.jpg');
    const g = await add('garden/media/images/beds/tulip.jpg');
    await tag(f, await label('tags', '/garden', 'flowers'));
    await tag(f, await label('tags', '/garden', 'red'));
    await tag(f, await label('categories', '/garden', 'plants'));
    await label('tags', '/olivia', 'red');                     // already there: reused
    const r = await recordMoved(db, T + 1, 'garden/media/images/rose.jpg', 'olivia/media/images/rosa.jpg', 'pamela');
    assert.equal(r.moved, 1);
    assert.deepEqual(r.created, { tags: ['/olivia/t/flowers'], categories: ['/olivia/c/plants'] });
    const moved = await row(f);
    assert.deepEqual([moved.path, moved.scope, moved.name, moved.changed_at], ['olivia/media/images/rosa.jpg', '/olivia', 'rosa.jpg', T + 1]);
    assert.deepEqual(await labelsOf(f), ['/olivia/t/flowers', '/olivia/t/red', '/olivia/c/plants']);
    // a folder: everything in it follows, nothing else
    await recordMoved(db, T + 2, 'garden/media/images/beds', 'garden/media/images/borders', 'pamela');
    assert.equal((await row(g)).path, 'garden/media/images/borders/tulip.jpg');
    // into images from files is refused by the helper; here, only what the path says
    assert.deepEqual((await presentIn(db, 'garden/media/images/borders')).map((x) => x.id), [g]);
    assert.deepEqual((await presentIn(db, 'garden/media/images')).map((x) => x.id), [], 'only what is directly in it');
  });

  it('a stale record at the new path is marked missing, not doubled', async () => {
    const stale = await add('garden/media/images/old.jpg');
    const f = await add('garden/media/images/new.jpg');
    await recordMoved(db, T + 3, 'garden/media/images/new.jpg', 'garden/media/images/old.jpg', 'pamela');
    assert.deepEqual([(await row(stale)).state, (await row(f)).state, (await presentAt(db, 'garden/media/images/old.jpg'))?.id], ['missing', 'present', f]);
  });

  it('a copy is a new record with the same labels (by name elsewhere) and hash', async () => {
    const f = await add('garden/media/images/lily.jpg', { hash: 'abc', size: 7 });
    await tag(f, await label('tags', '/garden', 'white'));
    const c = await recordCopied(db, T + 4, 'garden/media/images/lily.jpg', { path: 'media/images/lily.jpg', size: 7, modifiedAt: T }, 'momolig');
    assert.notEqual(c.id, f);
    const copy = await row(c.id);
    assert.deepEqual([copy.how, copy.added_by, copy.hash, copy.scope], ['copied', 'momolig', 'abc', '/']);
    assert.deepEqual(await labelsOf(c.id), ['/t/white']);
    assert.deepEqual(c.created.tags, ['/t/white']);
    assert.deepEqual(await labelsOf(f), ['/garden/t/white'], 'the original keeps its own');
  });

  it('an upload onto a path a sync already found takes the record over', async () => {
    await raw('media/images/raced.jpg', '/', 'images', 'raced.jpg', 5);
    const id = await add('media/images/raced.jpg', { hash: 'h1' });
    const r = await row(id);
    assert.deepEqual([r.how, r.added_by, r.hash], ['uploaded', 'pamela', 'h1']);
  });

  it('trash and restore (elsewhere, or renamed) keep the record, its labels and its id', async () => {
    const a = await add('garden/media/images/shed/a.jpg');
    const b = await add('garden/media/images/shed/b.jpg');
    await tag(a, await label('tags', '/garden', 'wood'));
    assert.equal(await recordTrashed(db, T + 5, 'garden/media/images/shed', '20260918T000000Z-00000001'), 2);
    const trashed = await row(a);
    assert.deepEqual([trashed.state, trashed.trash_id, trashed.path], ['trashed', '20260918T000000Z-00000001', 'garden/media/images/shed/a.jpg']);
    assert.deepEqual([...await presentIn(db, 'garden/media/images/shed')], []);
    const r = await recordRestored(db, T + 6, '20260918T000000Z-00000001', 'garden/media/images/shed', 'garden/media/images/shed-2', 'pamela');
    assert.equal(r.restored, 2);
    const back = await row(a);
    assert.deepEqual([back.state, back.trash_id, back.path, (await row(b)).path],
      ['present', null, 'garden/media/images/shed-2/a.jpg', 'garden/media/images/shed-2/b.jpg']);
    assert.deepEqual(await labelsOf(a), ['/garden/t/wood']);
  });

  it('missing and trashed records are forgotten after 30 days, with their links', async () => {
    const f = await add('garden/media/images/gone.jpg');
    await tag(f, await label('tags', '/garden', 'soon-gone'));
    await run(db, "UPDATE items SET state = 'missing', state_at = ? WHERE id = ?", T, f);
    assert.equal(await purgeRecords(db, T + KEEP_DAYS * 86400 - 1), 0);
    assert.ok(await purgeRecords(db, T + KEEP_DAYS * 86400) >= 1);
    assert.equal(await one(db, 'SELECT 1 FROM records WHERE id = ?', f), undefined);
    assert.equal(await one(db, 'SELECT 1 FROM files WHERE item_id = ?', f), undefined);
    assert.equal(await one(db, 'SELECT 1 FROM links WHERE item_id = ?', f), undefined);
  });

  it('a nested folder scope\'s labels stay with files under it, and follow a rename', async () => {
    const f = await add('olivia/media/images/2026/trip.jpg');
    const nested = await label('tags', '/olivia/media/images/2026', 'trip');
    await tag(f, nested);
    assert.deepEqual(await labelsOf(f), ['/olivia/media/images/2026/t/trip']);
    await recordMoved(db, T + 10, 'olivia/media/images/2026', 'olivia/media/images/holidays', 'pamela');
    assert.equal((await row(f)).path, 'olivia/media/images/holidays/trip.jpg');
    assert.deepEqual(await labelsOf(f), ['/olivia/media/images/holidays/t/trip']);
  });

  // The notes a sync takes who-added-what from (D17) came from panel.db when
  // media.db was first made, and the move to Postgres brought them across
  // (docs/postgres-plan.md, build step 6). A restore still moves them: panel.test.ts.
  it('who added it is taken from an imported note when a sync finds the file', async () => {
    await run(db, "INSERT INTO imported_notes (path, added_by, added_at, how) VALUES ('media/images/note.jpg', 'pamela', 5, 'uploaded')");
    assert.equal((await one<{ added_by: string }>(db, "SELECT added_by FROM imported_notes WHERE path = 'media/images/note.jpg'"))!.added_by, 'pamela');
  });
});

describe('the sync\'s reasoning (planSync)', () => {
  let id = 1000;
  const rec = (path: string, o: Partial<MediaRow> = {}): MediaRow => {
    const place = placeOf(path)!;
    return { id: id++, path, scope: place.scope, kind: place.kind, name: place.name, size: 10, hash: null, modified_at: 50, added_at: 1, added_by: null,
      how: 'found', state: 'present', state_at: 1, trash_id: null, changed_at: 1, title: null, alt: null, ...o };
  };
  const file = (path: string, size = 10, modifiedAt = 50) => ({ path, size, modifiedAt });
  const scan = (files: ReturnType<typeof file>[], truncated = false) => ({ files, strays: [], truncated });
  const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

  it('unchanged, changed, back, new and gone', () => {
    const same = rec('media/images/same.jpg');
    const edited = rec('media/images/edited.jpg');
    const away = rec('media/images/away.jpg', { state: 'missing' });
    const gone = rec('media/images/gone.jpg', { size: 99 });
    const p = planSync([same, edited, away, gone], scan([
      file('media/images/same.jpg'), file('media/images/edited.jpg', 10, 51), file('media/images/away.jpg'), file('media/images/new.jpg', 3),
    ]), new Map());
    assert.deepEqual(ids(p.changed.map((c) => c.row)), [edited.id]);
    assert.deepEqual(ids(p.back.map((c) => c.row)), [away.id]);
    assert.deepEqual(p.found.map((f) => f.path), ['media/images/new.jpg']);
    assert.deepEqual(ids(p.gone), [gone.id]);
    assert.deepEqual([p.moved, p.needHash], [[], []]);
  });

  it('a move is recognised by its hash, asked for only when a same-size record has one', () => {
    const old = rec('media/images/a.jpg', { hash: 'h-a' });
    const other = rec('olivia/media/images/b.jpg', { hash: 'h-b', state: 'missing' });
    const s = scan([file('olivia/media/images/moved-a.jpg'), file('media/images/moved-b.jpg'), file('media/images/big.mp4', 12345)]);
    const first = planSync([old, other], s, new Map());
    assert.deepEqual(first.needHash, ['olivia/media/images/moved-a.jpg', 'media/images/moved-b.jpg'], 'not the one no record is the size of');
    const p = planSync([old, other], s, new Map([['olivia/media/images/moved-a.jpg', 'h-a'], ['media/images/moved-b.jpg', 'h-b']]));
    assert.deepEqual(p.moved.map((m) => [m.row.id, m.f.path, m.hash]), [[old.id, 'olivia/media/images/moved-a.jpg', 'h-a'], [other.id, 'media/images/moved-b.jpg', 'h-b']]);
    assert.deepEqual([p.found.map((f) => f.path), p.gone], [['media/images/big.mp4'], []]);
    const wrong = planSync([old], scan([file('media/images/c.jpg')]), new Map([['media/images/c.jpg', 'h-other']]));
    assert.deepEqual([wrong.moved, wrong.found.length, ids(wrong.gone)], [[], 1, [old.id]], 'same size, other content: new file, old one gone');
  });

  it('without a hash yet: same name, size and modified time', () => {
    const big = rec('media/video/film.mp4', { size: 5_000_000_000, modified_at: 77 });
    const p = planSync([big], scan([file('media/video/2026/film.mp4', 5_000_000_000, 77)]), new Map());
    assert.deepEqual([p.moved.length, p.needHash], [1, []]);
    const renamed = planSync([big], scan([file('media/video/film-final.mp4', 5_000_000_000, 77)]), new Map());
    assert.deepEqual([renamed.moved.length, renamed.found.length], [0, 1], 'renamed and not hashed yet: counted as new');
  });

  it('a cut-short scan marks nothing missing', () => {
    const r = rec('media/images/beyond-the-cap.jpg');
    const p = planSync([r], scan([file('media/images/x.jpg', 1)], true), new Map());
    assert.deepEqual([p.gone, p.found.length], [[], 1]);
  });

  it('indexes any public file, not only media folders', () => {
    const p = planSync([], scan([file('media/readme.txt'), file('olivia/about.html'), file('olivia/media/photos/x.jpg')]), new Map());
    assert.deepEqual(p.found.map((f) => f.path).sort(), ['media/readme.txt', 'olivia/about.html', 'olivia/media/photos/x.jpg']);
  });

  it('ignores hidden files and login-files', () => {
    const p = planSync([], scan([file('.hidden/x.jpg'), file('login-files/x.txt')]), new Map());
    assert.deepEqual(p.found, []);
  });
});
