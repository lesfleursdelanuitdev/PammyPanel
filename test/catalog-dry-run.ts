// The catalog move on a copy of the live data (docs/catalog-plan.md step 2: "the harness
// first"): a nightly dump of pammy.org's panel database restored into a throwaway Postgres
// (test/pg-harness.ts: the same image, tmpfs, removed at the end), then
//   1. the media API's index published the way step 1 does (from `media`),
//   2. every migration this release has that the dump doesn't (the catalog's move, with its
//      own counts and checksums),
//   3. the index published the way step 2 does (from the catalog), and compared by names;
//   4. every file's labels and every label read through the new code, beside the old tables.
// Nothing is written anywhere but the throwaway container and a temporary folder.
// A dump from after step 2 (catalog step 3): the catalog's index and labels before and after
// catalog/0002 drops media's tables, which must change nothing.
//   node test/catalog-dry-run.ts <pammy-...-nightly.dump>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@panel/core/pg-migrate';
import { all } from '@panel/core/pg';
import { publishIndex } from '@panel/media/media-public';
import { listLabels, labelsOf } from '@panel/catalog/labels';
import { listScopes } from '@panel/catalog/scopes';
import { compare, readIndex } from '../tools/media-api-proof.ts';
import { publishIndex as publishStep1 } from './fixtures/media-public-step1.ts';
import { startPg } from './pg-harness.ts';

const dump = process.argv[2];
if (!dump) { console.error('usage: node test/catalog-dry-run.ts <dump>'); process.exit(2); }

const pg = await startPg();
const dir = mkdtempSync(join(tmpdir(), 'catalog-dry-run-'));
let failed = 0;
const say = (ok: boolean, what: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
try {
  const database = 'dryrun';
  pg.superSql(`CREATE DATABASE ${database} OWNER pammy_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  // (on stdin: the copy is 600, and the container's postgres user isn't its owner)
  execFileSync('podman', ['exec', '-i', '-u', 'postgres', pg.name, 'pg_restore', '-d', database, '--exit-on-error'], { input: readFileSync(dump), stdio: ['pipe', 'pipe', 'inherit'] });
  console.log(`restored ${dump} into a throwaway Postgres (${pg.name})`);

  const owner = pg.connect('owner', database, 1);
  const panel = pg.connect('panel', database, 4);
  try {
    // A dump taken after step 2 (catalog step 3, catalog/0002): the catalog is the truth
    // and media a frozen copy, so "before" is the catalog's own answer, then the drop.
    const moved = (await all(owner, "SELECT 1 FROM public.schema_migrations WHERE name = 'catalog/0001-catalog.sql'")).length > 0;
    if (moved) {
      const ids = (await all<{ id: number }>(panel, 'SELECT id FROM catalog.items WHERE resource_id = 1')).map((r) => Number(r.id));
      const labelsBefore = JSON.stringify([...(await labelsOf(panel, ids)).entries()].sort((x, y) => x[0] - y[0]));
      const listBefore = (await listLabels(panel, null)).length;
      await publishIndex(panel, join(dir, 'before'), 1);
      console.log(`her catalog: ${ids.length} files, ${listBefore} labels`);
      const ran = await migrate(owner, undefined, (s) => console.log(`  ${s}`));
      say(ran.includes('catalog/0002-drop-media.sql'), `the migrations this release adds ran: ${ran.join(', ') || 'none'}`);
      say((await all(owner, "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'media'")).length === 0, "media's tables are gone");
      await publishIndex(panel, join(dir, 'after'), 1);
      const before = readIndex(join(dir, 'before', 'index.db'));
      const after = readIndex(join(dir, 'after', 'index.db'));
      const d = compare({ index: before, answers: {} }, { index: after, answers: {} });
      say(!d.length, `the media API's index: ${before.files.length} files, ${before.labels.length} labels, ${before.links.length} labels on files -- ${d.length ? `${d.length} difference(s)` : 'the same'}`);
      say(JSON.stringify([...(await labelsOf(panel, ids)).entries()].sort((x, y) => x[0] - y[0])) === labelsBefore, `every file's tags and categories: the same (${ids.length} files)`);
      say((await listLabels(panel, null)).length === listBefore, `the Tags page's list: ${listBefore} labels`);
    } else {
    // 1. before
    await owner.unsafe('SET search_path = panel, media');
    const counts = (await all<{ t: string; n: number }>(owner, `SELECT 'files' AS t, count(*)::int AS n FROM media.media UNION ALL SELECT 'tags', count(*)::int FROM media.tags
      UNION ALL SELECT 'categories', count(*)::int FROM media.categories UNION ALL SELECT 'links', (SELECT count(*) FROM media.media_tags) + (SELECT count(*) FROM media.media_categories)
      UNION ALL SELECT 'scopes', count(*)::int FROM media.scopes UNION ALL SELECT 'thumbnails', count(*)::int FROM media.thumbs`)).map((r) => `${r.n} ${r.t}`).join(', ');
    console.log(`her media data: ${counts}`);
    const oldLabels = await all<{ id: number; path: string; kind: string; name: string }>(owner, `
      SELECT m.id, m.path, 'tag' AS kind, t.scope || ':' || t.name AS name FROM media.media_tags x JOIN media.media m ON m.id = x.media_id JOIN media.tags t ON t.id = x.tag_id
      UNION ALL SELECT m.id, m.path, 'category', c.scope || ':' || c.name FROM media.media_categories x JOIN media.media m ON m.id = x.media_id JOIN media.categories c ON c.id = x.category_id`);
    await publishStep1(owner, join(dir, 'before'), 1);
    await owner.unsafe('RESET search_path');

    // 2. the move
    const ran = await migrate(owner, undefined, (s) => console.log(`  ${s}`));
    say(ran.includes('catalog/0001-catalog.sql'), `the migrations this release adds ran: ${ran.join(', ') || 'none'}`);

    // 3. after
    await publishIndex(panel, join(dir, 'after'), 1);
    const before = readIndex(join(dir, 'before', 'index.db'));
    const after = readIndex(join(dir, 'after', 'index.db'));
    const d = compare({ index: before, answers: {} }, { index: after, answers: {} });
    say(!d.length, `the media API's index: ${before.files.length} files, ${before.labels.length} labels, ${before.links.length} labels on files -- ${d.length ? `${d.length} difference(s)` : 'the same'}`);
    for (const x of d.slice(0, 20)) console.log(`        ${x}`);
    say(JSON.stringify(after.urls) === JSON.stringify(before.urls), `the addresses a visitor may ask: the same ${before.urls.length}`);

    // 4. through the new code
    const ids = [...new Set(oldLabels.map((l) => Number(l.id)))];
    const got = await labelsOf(panel, ids);
    const want = new Map<number, { tags: string[]; categories: string[] }>(ids.map((id) => [id, { tags: [], categories: [] }]));
    for (const l of oldLabels) want.get(Number(l.id))![l.kind === 'tag' ? 'tags' : 'categories'].push(l.name.split(':').pop()!);
    let same = 0;
    for (const id of ids) {
      const a = got.get(id)!; const w = want.get(id)!;
      if (JSON.stringify([a.tags.sort(), a.categories.sort()]) === JSON.stringify([w.tags.sort(), w.categories.sort()])) same++;
    }
    say(same === ids.length, `each labelled file's tags and categories through the new code: ${same} of ${ids.length} the same`);
    const labels = await listLabels(panel, null);
    say(labels.length === before.labels.length, `the Tags page's list: ${labels.length} labels`);
    const scopes = await listScopes(panel, null);
    console.log(`  scopes now: ${scopes.map((s) => `${s.path}${s.automatic ? '' : ' (made)'}`).join(', ')}`);
    }
  } finally {
    await owner.end({ timeout: 2 });
    await panel.end({ timeout: 2 });
  }
} finally {
  pg.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\ncatalog dry run: ${failed} FAILED` : '\ncatalog dry run: everything the same');
process.exit(failed ? 1 : 0);
