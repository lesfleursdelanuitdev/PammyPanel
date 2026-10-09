// pammy.org's nginx from the hosts rows (docs/phase8-plan.md 8-7b): the installer's seed, the
// software routes following the installs' placements, and pammy-routes writing the files --
// on a real Postgres, with the routing helper on a socket of its own (nginx -t stood in).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:net';
import { all, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import type { RunResult, RunSpec } from '@panel/core/runner';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { createRoutesServer } from '@panel/hosts/helper/service';
import { hostsConfigOf } from '@panel/pammy/hosts';
import { applyTable, followSoftware, pammyTable, seedHosts, WITH_HOSTS, type Install } from '@panel/pammy/nginx-hosts';
import { callJsonLine } from '@panel/core/jsonline';
import { startPg, type PgTest } from './pg-harness.ts';

let pgTest: PgTest;
let db: Sql;
let dir: string;
let server: Server;
let nginxSays = 0;
const clock = 1_800_000_000;
const sock = () => join(dir, 'routes.sock');
const files = () => readdirSync(join(dir, 'nginx', 'hosts')).sort();
const blog = (mode: string, name: string | null): Install => ({ id: 'blog', placement: { mode, name } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pammy-nginx-hosts-'));
  pgTest = await startPg();
  const database = pgTest.freshDatabase();
  const owner = pgTest.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pgTest.connect('panel', database, 4);
  mkdirSync(join(dir, 'sites-enabled'));
  const run = async (spec: RunSpec): Promise<RunResult> => (spec.what === 'nginx-test'
    ? { code: nginxSays, stdout: '', stderr: nginxSays ? 'nginx: [emerg] no' : '' } : { code: 0, stdout: '', stderr: '' });
  server = createRoutesServer(createRoutesOps({ cfg: { ...hostsConfigOf(WITH_HOSTS), dir: join(dir, 'nginx') }, run, zone: null, links: ['pamela'], root: '/', sitesEnabled: join(dir, 'sites-enabled') }));
  await new Promise<void>((r) => server.listen(sock(), r));
});
after(async () => {
  server?.close();
  await db?.end();
  pgTest?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("pammy.org's hosts rows (8-7b)", () => {
  it('the seed: the domain with folder hosts, pammy.org and www with the whole website and /api/, the blog', async () => {
    const r = await seedHosts(db, [blog('subdomain', 'blog')], clock);
    assert.equal(r.domain.made, true);
    assert.deepEqual(r.made, ['pammy.org/: the whole website', 'pammy.org/api/: pamela-app (127.0.0.1:3042)', 'blog.pammy.org/: blog']);
    const a = await applyTable(sock(), r.table);
    assert.deepEqual(files(), ['@.conf', 'blog.conf']);
    assert.ok(a.changed.includes('catch-all.conf') && existsSync(join(dir, 'nginx', 'site.conf')));
    assert.match(readFileSync(join(dir, 'nginx', 'catch-all.conf'), 'utf8'), /root \/pamela\/public\/\$sub;/);
    assert.match(readFileSync(join(dir, 'nginx', 'hosts', 'blog.conf'), 'utf8'), /include \/etc\/nginx\/pammy-wordpress\/proxy\.conf;/);
    assert.ok(!existsSync(join(dir, 'nginx', 'gate-routes.json')), "pammy's gate looks at folders, not routes");
    // again: nothing new, nothing rewritten
    const again = await seedHosts(db, [blog('subdomain', 'blog')], clock);
    assert.equal(again.domain.made, false);
    assert.deepEqual(again.made, []);
    assert.deepEqual((await applyTable(sock(), again.table)).changed, []);
  });

  it('the software routes follow the placements: path, another install, off, root, deleted', async () => {
    assert.deepEqual(await followSoftware(db, sock(), [blog('path', 'blog')], clock), ['blog.pammy.org/: blog taken out', 'pammy.org/blog/: blog']);
    assert.deepEqual(files(), ['@.conf'], "the blog's own host went with its route");
    assert.match(readFileSync(join(dir, 'nginx', 'hosts', '@.conf'), 'utf8'), /location \^~ \/blog\/ \{/);
    assert.deepEqual(await followSoftware(db, sock(), [blog('path', 'blog'), { id: 'shop', placement: { mode: 'subdomain', name: 'shop' } }], clock), ['shop.pammy.org/: shop']);
    assert.match(readFileSync(join(dir, 'nginx', 'hosts', 'shop.conf'), 'utf8'), /include \/etc\/nginx\/pammy-wordpress\/proxy-shop\.conf;/);
    assert.deepEqual(await followSoftware(db, sock(), [blog('path', 'blog'), { id: 'shop', placement: { mode: 'subdomain', name: 'shop' }, deleted: { at: 1 } }], clock), ['shop.pammy.org/: shop taken out']);
    // the whole website isn't a route, and off is none: the blog's route goes, the site stays
    assert.deepEqual(await followSoftware(db, sock(), [blog('root', null)], clock), ['pammy.org/blog/: blog taken out']);
    assert.deepEqual((await pammyTable(db)).routes.map((r) => `${r.host}${r.path} ${r.kind}`), ['@/ site', '@/api/ proxy']);
    assert.deepEqual(await followSoftware(db, sock(), [blog('off', null)], clock), []);
  });

  it('nginx refusing puts the rows back', async () => {
    nginxSays = 1;
    await assert.rejects(followSoftware(db, sock(), [blog('subdomain', 'blog')], clock), /nginx did not accept/);
    nginxSays = 0;
    assert.equal((await all(db, "SELECT 1 FROM routes WHERE target_kind = 'software'")).length, 0);
    assert.deepEqual(files(), ['@.conf']);
  });

  it('only the pamela site is taken over (at the switch, 8-7c)', async () => {
    await assert.rejects(callJsonLine(sock(), { op: 'apply', table: await pammyTable(db), takeOver: 'tutorstar' }, 'the routing helper'), /isn't a hand-written file the panel takes over/);
  });
});
