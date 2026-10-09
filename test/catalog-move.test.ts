// The catalog move (docs/catalog-plan.md step 2, S2-3): catalog/0001 on a database whose
// `media` schema is filled the way the live one is -- nested and hand-made scopes, a
// top-level scope made by hand, labels in scopes media.scopes never listed, tags and
// categories whose ids overlap, links, thumbnails, trashed and missing records, notes and
// the sync's state. Every row compared after (ids kept for files and tags, categories
// renumbered); a move that would lose anything rolls back whole; `media` is read-only after.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate, migrationSources } from '@panel/core/pg-migrate';
import { all, type Sql } from '@panel/core/pg';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
before(async () => { pg = await startPg(); });
after(() => pg?.stop());

const withPg = async <T>(role: 'owner' | 'panel', database: string, fn: (q: Sql) => Promise<T>) => {
  const q = pg.connect(role, database, 1);
  try { return await fn(q); } finally { await q.end({ timeout: 2 }); }
};
// every migration but the catalog's (and what comes after it in its folder), and the
// studio's, whose first (step 4) needs the catalog's tables
const before0001 = () => migrationSources().filter((m) => m.prefix !== 'catalog/' && m.prefix !== 'studio/');
// ...and then the move alone, without catalog/0002 (step 3), which drops media's tables
let only0001 = '';
const through0001 = () => {
  if (!only0001) {
    only0001 = mkdtempSync(join(tmpdir(), 'catalog-0001-'));
    cpSync(join(migrationSources().find((m) => m.prefix === 'catalog/')!.dir, '0001-catalog.sql'), join(only0001, '0001-catalog.sql'));
  }
  return [...before0001(), { prefix: 'catalog/', dir: only0001 }];
};
after(() => { if (only0001) rmSync(only0001, { recursive: true, force: true }); });

// What the live data has in it, written straight into `media` (as the old code did).
const FIXTURE = `
  INSERT INTO media.scopes (path, automatic, created_at, created_by) VALUES
    ('/', 1, 100, NULL), ('/olivia', 1, 101, NULL), ('/olivia/trips', 0, 102, 'pamela'),
    ('/olivia/trips/2026', 0, 103, 'momolig'), ('/garden', 0, 104, 'pamela'), ('/media/images', 0, 105, 'pamela');
  INSERT INTO media.media (id, path, scope, kind, name, size, hash, modified_at, added_at, added_by, how, state, state_at, trash_id, changed_at, title, alt) OVERRIDING SYSTEM VALUE VALUES
    (3, 'media/images/dog.jpg', '/', 'images', 'dog.jpg', 1000, 'aaa', 10, 11, 'pamela', 'uploaded', 'present', NULL, NULL, 12, 'Our dog', 'A dog on grass'),
    (5, 'olivia/trips/2026/beach.jpg', '/olivia', 'images', 'beach.jpg', 2000, 'bbb', 20, 21, NULL, 'found', 'present', NULL, NULL, 22, NULL, NULL),
    (6, 'olivia/index.html', '/olivia', 'pages', 'index.html', 300, NULL, 30, 31, 'momolig', 'copied', 'present', NULL, NULL, 32, NULL, NULL),
    (7, 'garden/roses.png', '/garden', 'images', 'roses.png', 400, 'ccc', 40, 41, 'pamela', 'uploaded', 'trashed', 45, 'trash-1', 46, 'Roses', NULL),
    (8, 'garden/old.pdf', '/garden', 'files', 'old.pdf', 500, 'ddd', 50, 51, 'pamela', 'uploaded', 'missing', 55, NULL, 56, NULL, NULL),
    (9, 'garden/old.pdf', '/garden', 'files', 'old.pdf', 510, NULL, 57, 58, NULL, 'found', 'present', NULL, NULL, 59, NULL, NULL),
    (12, 'shop/media/files/price list.pdf', '/shop', 'files', 'price list.pdf', 600, 'eee', 60, 61, 'pamela', 'uploaded', 'present', NULL, NULL, 62, NULL, NULL),
    (20, 'readme.txt', '/', 'files', 'readme.txt', 7, NULL, 70, 71, NULL, 'found', 'present', NULL, NULL, 72, NULL, NULL);
  SELECT setval('media.media_id_seq', 25);
  INSERT INTO media.tags (id, scope, name, created_at, created_by, public) OVERRIDING SYSTEM VALUE VALUES
    (1, '/', 'dogs', 200, 'pamela', 1), (2, '/olivia', 'summer', 201, NULL, 0), (3, '/olivia/trips/2026', 'beach', 202, 'momolig', 1),
    (4, '/garden', 'flowers', 203, 'pamela', 0), (5, '/shop', 'prices', 204, 'pamela', 1), (7, '/olivia/unlisted', 'lost', 205, NULL, 0);
  INSERT INTO media.categories (id, scope, name, created_at, created_by, public) OVERRIDING SYSTEM VALUE VALUES
    (1, '/', 'pets', 300, 'pamela', 1), (2, '/olivia', 'holidays', 301, NULL, 1), (4, '/garden', 'plants', 302, 'pamela', 0);
  INSERT INTO media.media_tags (media_id, tag_id) VALUES (3, 1), (5, 2), (5, 3), (5, 1), (7, 4), (8, 4), (12, 5);
  INSERT INTO media.media_categories (media_id, category_id) VALUES (3, 1), (5, 2), (7, 4), (9, 4);
  INSERT INTO media.thumbs (media_id, hash, result, icon, width, height, why, made_at) VALUES
    (3, 'aaa', 'picture', 'image', 320, 240, NULL, 400), (5, 'bbb', 'picture', 'image', 300, 400, NULL, 401),
    (12, 'eee', 'icon', 'pdf', NULL, NULL, 'not a picture', 402);
  INSERT INTO media.imported_notes (path, added_by, added_at, how) VALUES ('trash:abc/x.jpg', 'pamela', 500, 'uploaded');
  INSERT INTO media.sync_state (key, value) VALUES ('last', '{"at":900}'), ('cursor', '"garden"');
`;

// Everything the pages and the media API see, from the old tables and the new, the same shape.
type Seen = { files: string[]; labels: string[]; scopes: string[]; thumbs: string[]; notes: string[]; state: string[] };
const seenBefore = async (q: Sql): Promise<Seen> => ({
  files: (await all<{ r: string }>(q, `SELECT concat_ws('|', m.id, m.path, m.scope, m.kind, m.name, m.size, m.hash, m.modified_at, m.added_at, m.added_by, m.how, m.state, m.state_at, m.trash_id, m.changed_at, m.title, m.alt,
      (SELECT string_agg('t:' || t.scope || ':' || t.name, ',' ORDER BY t.scope, t.name) FROM media.media_tags x JOIN media.tags t ON t.id = x.tag_id WHERE x.media_id = m.id),
      (SELECT string_agg('c:' || c.scope || ':' || c.name, ',' ORDER BY c.scope, c.name) FROM media.media_categories x JOIN media.categories c ON c.id = x.category_id WHERE x.media_id = m.id)) AS r
    FROM media.media m ORDER BY m.id`)).map((x) => x.r),
  labels: (await all<{ r: string }>(q, `SELECT r FROM (SELECT concat_ws('|', 'tag', scope, name, public = 1, created_at, created_by) AS r FROM media.tags
    UNION ALL SELECT concat_ws('|', 'category', scope, name, public = 1, created_at, created_by) FROM media.categories) a ORDER BY r`)).map((x) => x.r),
  scopes: (await all<{ r: string }>(q, "SELECT concat_ws('|', path, automatic = 1, created_at, created_by) AS r FROM media.scopes ORDER BY path")).map((x) => x.r),
  thumbs: (await all<{ r: string }>(q, "SELECT concat_ws('|', media_id, hash, result, icon, width, height, why, made_at) AS r FROM media.thumbs ORDER BY media_id")).map((x) => x.r),
  notes: (await all<{ r: string }>(q, "SELECT concat_ws('|', path, added_by, added_at, how) AS r FROM media.imported_notes ORDER BY path")).map((x) => x.r),
  state: (await all<{ r: string }>(q, "SELECT key || '=' || value AS r FROM media.sync_state ORDER BY key")).map((x) => x.r),
});
const seenAfter = async (q: Sql): Promise<Seen> => ({
  files: (await all<{ r: string }>(q, `SELECT concat_ws('|', i.id, i.key, s.path, i.kind, f.name, f.size, f.hash, f.modified_at, f.added_at, f.added_by, f.how, i.state, i.state_at, f.trash_id, i.changed_at, i.title, f.alt,
      (SELECT string_agg('t:' || ls.path || ':' || l.name, ',' ORDER BY ls.path, l.name) FROM catalog.links x JOIN catalog.labels l ON l.id = x.label_id JOIN catalog.scopes ls ON ls.id = l.scope_id WHERE x.item_id = i.id AND l.kind = 'tag'),
      (SELECT string_agg('c:' || ls.path || ':' || l.name, ',' ORDER BY ls.path, l.name) FROM catalog.links x JOIN catalog.labels l ON l.id = x.label_id JOIN catalog.scopes ls ON ls.id = l.scope_id WHERE x.item_id = i.id AND l.kind = 'category')) AS r
    FROM catalog.items i JOIN catalog.scopes s ON s.id = i.scope_id JOIN files.files f ON f.item_id = i.id ORDER BY i.id`)).map((x) => x.r),
  labels: (await all<{ r: string }>(q, `SELECT concat_ws('|', l.kind, s.path, l.name, l.public, l.created_at, l.created_by) AS r
    FROM catalog.labels l JOIN catalog.scopes s ON s.id = l.scope_id ORDER BY 1`)).map((x) => x.r),
  scopes: (await all<{ r: string }>(q, "SELECT concat_ws('|', path, automatic, created_at, created_by) AS r FROM catalog.scopes WHERE path IN (SELECT path FROM media.scopes) ORDER BY path")).map((x) => x.r),
  thumbs: (await all<{ r: string }>(q, "SELECT concat_ws('|', item_id, hash, result, icon, width, height, why, made_at) AS r FROM thumbs.thumbs ORDER BY item_id")).map((x) => x.r),
  notes: (await all<{ r: string }>(q, "SELECT concat_ws('|', path, added_by, added_at, how) AS r FROM files.imported_notes ORDER BY path")).map((x) => x.r),
  state: (await all<{ r: string }>(q, "SELECT key || '=' || value AS r FROM catalog.sync_state ORDER BY key")).map((x) => x.r),
});

describe('catalog/0001: the move from media (docs/catalog-plan.md step 2)', () => {
  let database = '';
  let was: Seen;
  before(async () => {
    database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o, before0001());
      await o.unsafe(FIXTURE).simple();
      was = await seenBefore(o);
      assert.deepEqual(await migrate(o, through0001()), ['catalog/0001-catalog.sql']);
    });
  });

  it('every file, label, link, thumbnail, note and sync state as it was, and each file keeps its id', async () => {
    await withPg('owner', database, async (o) => {
      const now = await seenAfter(o);
      assert.deepEqual(now, was);
      assert.equal(now.files.length, 8);
      assert.equal(now.labels.length, 9);
    });
  });

  it('the scopes are one tree: All, then Website ("/"), then each folder under its nearest scope', async () => {
    await withPg('owner', database, async (o) => {
      const rows = await all<{ path: string | null; label: string; parent: string | null; automatic: boolean }>(o,
        `SELECT s.path, s.label, p.path AS parent, s.automatic FROM catalog.scopes s LEFT JOIN catalog.scopes p ON p.id = s.parent_id ORDER BY s.id`);
      const tree = rows.map((r) => `${r.path ?? '(All)'} <- ${r.parent ?? (r.path === '/' ? '(All)' : '-')}${r.automatic ? ' auto' : ''}`);
      assert.deepEqual(tree.sort(), [
        '(All) <- - auto',
        '/ <- (All) auto',
        '/garden <- /',
        '/media/images <- /',
        '/olivia <- / auto',
        '/olivia/trips <- /olivia',
        '/olivia/trips/2026 <- /olivia/trips',
        '/olivia/unlisted <- /olivia',
        '/shop <- / auto',
      ].sort());
      // /garden was made by hand before any file was in it: it stays so
      assert.deepEqual(rows.find((r) => r.path === '/garden')!.automatic, false);
    });
  });

  it('tags keep their ids; categories come after them; new ones after everything', async () => {
    await withPg('owner', database, async (o) => {
      const tags = await all<{ id: number; name: string }>(o, "SELECT id, name FROM catalog.labels WHERE kind = 'tag' ORDER BY id");
      assert.deepEqual(tags.map((t) => [Number(t.id), t.name]), [[1, 'dogs'], [2, 'summer'], [3, 'beach'], [4, 'flowers'], [5, 'prices'], [7, 'lost']]);
      const cats = await all<{ id: number; name: string }>(o, "SELECT id, name FROM catalog.labels WHERE kind = 'category' ORDER BY id");
      assert.deepEqual(cats.map((c) => [Number(c.id), c.name]), [[8, 'pets'], [9, 'holidays'], [10, 'plants']]);
    });
    await withPg('panel', database, async (q) => {
      const [l] = await q`INSERT INTO catalog.labels (scope_id, kind, name, created_at) VALUES ((SELECT id FROM catalog.scopes WHERE path = '/'), 'tag', 'new-one', 1) RETURNING id`;
      assert.equal(Number(l!.id), 11);
      const id = await q.begin(async (t) => {
        const [i] = await t`INSERT INTO catalog.items (resource_id, key, scope_id, kind, changed_at) VALUES (1, 'new.txt', (SELECT id FROM catalog.scopes WHERE path = '/'), 'files', 1) RETURNING id`;
        await t`INSERT INTO files.files (item_id, name, size, modified_at, added_at, how) VALUES (${i!.id}, 'new.txt', 1, 1, 1, 'found')`;
        return i!.id;
      });
      assert.equal(Number(id), 26, 'after the last media id handed out (25), not only the last one kept');
      // an item of the website with no file columns is refused, at the end of its transaction
      await assert.rejects(q`INSERT INTO catalog.items (resource_id, key, scope_id, kind, changed_at) VALUES (1, 'bare.txt', (SELECT id FROM catalog.scopes WHERE path = '/'), 'files', 1)`, /no file columns: bare\.txt/);
    });
  });

  it('what it refuses, as media did: a label outside its scope, a scope moved from under its labels, a key moved out of a label\'s scope', async () => {
    await withPg('panel', database, async (q) => {
      await assert.rejects(q`INSERT INTO catalog.links (item_id, label_id) VALUES (3, (SELECT id FROM catalog.labels WHERE name = 'summer'))`, /a tag only goes on files in its own scope/);
      await assert.rejects(q`INSERT INTO catalog.links (item_id, label_id) VALUES (3, (SELECT id FROM catalog.labels WHERE name = 'holidays'))`, /a category only goes on files in its own scope/);
      await assert.rejects(q`UPDATE catalog.items SET key = 'olivia/elsewhere/beach.jpg' WHERE id = 5`, /move the labels to the new scope first/);
      await assert.rejects(q`UPDATE catalog.labels SET scope_id = (SELECT id FROM catalog.scopes WHERE path = '/garden') WHERE name = 'summer'`, /files in another scope still have this label/);
      await assert.rejects(q.begin(async (t) => { await t`UPDATE catalog.scopes SET path = '/elsewhere' WHERE path = '/olivia/trips/2026'`; }), /files in another scope still have this label/);
      // a label in All goes on anything (C5)
      await q`INSERT INTO catalog.labels (scope_id, kind, name, created_at) VALUES ((SELECT id FROM catalog.scopes WHERE parent_id IS NULL), 'tag', 'everywhere', 1)`;
      await q`INSERT INTO catalog.links (item_id, label_id) VALUES (3, (SELECT id FROM catalog.labels WHERE name = 'everywhere')), (12, (SELECT id FROM catalog.labels WHERE name = 'everywhere'))`;
      await assert.rejects(q`INSERT INTO catalog.scopes (parent_id, source_id, path, label, created_at) VALUES (NULL, NULL, NULL, 'Another all', 1)`, /scopes_one_all/);
    });
  });

  it('media is read-only for the panel now, and the new schemas are the panel\'s to write (not the gate\'s)', async () => {
    await withPg('panel', database, async (q) => {
      assert.equal((await q`SELECT count(*)::int AS n FROM media.media`)[0]!.n, 8);
      await assert.rejects(q`UPDATE media.media SET title = 'x' WHERE id = 3`, /permission denied/);
      await assert.rejects(q`INSERT INTO media.tags (scope, name, created_at) VALUES ('/', 'x', 1)`, /permission denied/);
      await q`UPDATE files.files SET alt = 'changed' WHERE item_id = 3`;
      await q`UPDATE thumbs.thumbs SET made_at = 1 WHERE item_id = 3`;
    });
    const gate = pg.connect('gate', database, 1);
    try { await assert.rejects(gate`SELECT 1 FROM catalog.items`, /permission denied/); } finally { await gate.end({ timeout: 2 }); }
  });

  it('an empty media schema (lfdln): empty tables, All and Website', async () => {
    const db2 = pg.freshDatabase();
    await withPg('owner', db2, async (o) => {
      await migrate(o);
      assert.deepEqual((await all<{ n: number }>(o, 'SELECT count(*)::int AS n FROM catalog.items')).map((r) => r.n), [0]);
      assert.deepEqual((await all<{ label: string }>(o, 'SELECT label FROM catalog.scopes ORDER BY id')).map((r) => r.label), ['All', 'Website']);
      assert.equal((await all(o, "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'media'")).length, 0);
    });
  });
});

describe('catalog/0002 (step 3, S3-6): media\'s tables go, the catalog stays', () => {
  it('after the move: every table and function in media gone, the empty schema kept, the catalog untouched', async () => {
    const database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o, before0001());
      await o.unsafe(FIXTURE).simple();
      await migrate(o, through0001());
      const items = await all(o, 'SELECT id, key FROM catalog.items ORDER BY id');
      const links = await all(o, 'SELECT item_id, label_id FROM catalog.links ORDER BY 1, 2');
      assert.deepEqual(await migrate(o), ['catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql']);
      assert.equal((await all(o, "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'media'")).length, 0);
      assert.equal((await all(o, "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'media'")).length, 0);
      assert.equal((await all(o, "SELECT 1 FROM pg_namespace WHERE nspname = 'media'")).length, 1);
      assert.deepEqual(await all(o, 'SELECT id, key FROM catalog.items ORDER BY id'), items);
      assert.deepEqual(await all(o, 'SELECT item_id, label_id FROM catalog.links ORDER BY 1, 2'), links);
    });
  });

  it('refused, and nothing dropped, if media has files and the catalog none', async () => {
    const database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o, before0001());
      await o.unsafe(FIXTURE).simple();
      await migrate(o, through0001());
      await o.unsafe('DELETE FROM catalog.links; DELETE FROM thumbs.thumbs; DELETE FROM files.files; DELETE FROM catalog.items').simple();
      await assert.rejects(migrate(o), /media has files and the catalog has none -- nothing was dropped/);
      assert.equal((await all(o, 'SELECT 1 FROM media.media')).length, 8);
    });
  });
});

describe('catalog/0001 refuses to lose anything', () => {
  it('a move that would change a row rolls back whole: no catalog, media as it was and still writable', async () => {
    const database = pg.freshDatabase();
    // the real migration, with one link quietly dropped before the checks
    const d = mkdtempSync(join(tmpdir(), 'catalog-move-'));
    const src = migrationSources().find((m) => m.prefix === 'catalog/')!.dir;
    for (const f of readdirSync(src)) cpSync(join(src, f), join(d, f));
    const sql = readFileSync(join(d, '0001-catalog.sql'), 'utf8');
    const marker = '-- ------------------------------------------------------------------ the same, or nothing (S2-3)';
    assert.ok(sql.includes(marker));
    writeFileSync(join(d, '0001-catalog.sql'), sql.replace(marker, `DELETE FROM catalog.links WHERE item_id = 12;\n${marker}`));
    const sources = [...before0001(), { prefix: 'catalog/', dir: d }];
    try {
      await withPg('owner', database, async (o) => {
        await migrate(o, before0001());
        await o.unsafe(FIXTURE).simple();
        await assert.rejects(migrate(o, sources), /the catalog move would change links: 11 before, 10 after -- nothing was moved/);
        assert.equal((await all(o, "SELECT 1 FROM pg_tables WHERE schemaname = 'catalog'")).length, 0);
        assert.equal((await all(o, "SELECT 1 FROM public.schema_migrations WHERE name LIKE 'catalog/%'")).length, 0);
      });
      await withPg('panel', database, async (q) => { await q`UPDATE media.media SET title = 'still mine' WHERE id = 3`; });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('files.records: the website\'s files, as media.media had them', () => {
  it('one row a file, the same columns and values as media.media; read-only', async () => {
    const database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o, before0001());
      await o.unsafe(FIXTURE).simple();
      const cols = 'id, path, scope, kind, name, size, hash, modified_at, added_at, added_by, how, state, state_at, trash_id, changed_at, title, alt';
      const old = await all(o, `SELECT ${cols} FROM media.media ORDER BY id`);
      await migrate(o, through0001());
      assert.deepEqual(await all(o, `SELECT ${cols} FROM files.records ORDER BY id`), old);
    });
    await withPg('panel', database, async (q) => {
      await assert.rejects(q`UPDATE files.records SET title = 'x' WHERE id = 3`, /permission denied|cannot update view/);
    });
  });
});

describe('the media API\'s index before and after the move (S2-5, as the installer compares it)', () => {
  it('the same files, labels and labels on files, by name; the proof tool finds no difference, and finds one when there is', async () => {
    const { publishIndex: publishStep1 } = await import('./fixtures/media-public-step1.ts');
    const { publishIndex } = await import('@panel/media/media-public');
    const { compare, readIndex } = await import('../tools/media-api-proof.ts');
    const database = pg.freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'catalog-index-'));
    try {
      await withPg('owner', database, async (o) => {
        await migrate(o, before0001());
        await o.unsafe(FIXTURE).simple();
        // two labels public, as she would have made them (M5)
        await o.unsafe("UPDATE media.tags SET public = 1 WHERE name IN ('summer', 'flowers'); UPDATE media.categories SET public = 1 WHERE name = 'plants'").simple();
      });
      const old = pg.connect('owner', database, 1);
      try {
        await old.unsafe('SET search_path = panel, media');
        await publishStep1(old, join(dir, 'before'), 1);
      } finally { await old.end({ timeout: 2 }); }
      await withPg('owner', database, async (o) => { await migrate(o, through0001()); });
      await withPg('panel', database, async (q) => { await publishIndex(q, join(dir, 'after'), 1); });
      const before = readIndex(join(dir, 'before', 'index.db'));
      const after = readIndex(join(dir, 'after', 'index.db'));
      // (only files in a media folder are in it: the dog and the price list)
      assert.deepEqual([before.files.length, before.labels.length, before.links.length], [2, 9, 3]);
      assert.deepEqual(after.urls, before.urls);
      const proof = (x: typeof before) => ({ index: { files: x.files, labels: x.labels, links: x.links }, answers: {} });
      assert.deepEqual(compare(proof(before), proof(after)), []);
      // and a real difference is said
      const worse = { ...after, links: after.links.slice(1) };
      assert.equal(compare(proof(before), proof(worse)).length, 1);
      assert.match(compare(proof(before), proof(worse))[0]!, /^index links: gone: /);
      assert.deepEqual(compare({ index: { files: [], labels: [], links: [] }, answers: { '/x': { status: 200, sha256: 'a', start: 'A' } } },
        { index: { files: [], labels: [], links: [] }, answers: { '/x': { status: 200, sha256: 'b', start: 'B' } } }), ['/x: was 200 A; now 200 B']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
