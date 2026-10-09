// A project's database on the real engines (docs/phase8b-plan.md 8b-5): lfdln's rules, the
// project-database op of the database helper, and what each of its logins may then do --
// on throwaway copies of lfdln-appdb (Postgres 17) and lfdln-appmaria (MariaDB 11.4), made by
// test/pammydb-harness.ts as the Studio's tests are.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import mysql from 'mysql2/promise';
import postgres from 'postgres';
import { LFDLN_HELPER } from '@panel/lfdln/studio-site';
import { checkProjectNames, PammyDbError, type Engine } from '@panel/studio/pammydb/ident';
import { createMariaDriver } from '@panel/studio/pammydb/maria';
import { createDatabase, createUser, dropDatabase, dropUser, grantAccess, listDatabases, projectDatabase, resetPassword, type Drivers } from '@panel/studio/pammydb/ops';
import { createPgDriver } from '@panel/studio/pammydb/pg';
import { dbUrl, projectDbNames, projectDbPassword } from '@panel/projects/panel/routes/projects';
import { PASSWORD_RE } from '@panel/studio/pammydb/ident';
import { startEngines, type Engines } from './pammydb-harness.ts';

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { if (e instanceof PammyDbError) return e.code; throw e; }
  return 'no error';
};
const PW = (c: string) => c.repeat(24);

describe('the names of a project\'s database', () => {
  const rules = LFDLN_HELPER.rules!.postgres!;
  it('proj_<name> with db_proj_<name>_owner and _app; anything else is refused', () => {
    assert.deepEqual(checkProjectNames(rules, 'proj_blog_dev', 'db_proj_blog_dev_owner', 'db_proj_blog_dev_app'), { db: 'proj_blog_dev', owner: 'db_proj_blog_dev_owner', app: 'db_proj_blog_dev_app' });
    assert.throws(() => checkProjectNames(rules, 'blog', 'db_proj_blog_owner', 'db_proj_blog_app'), /proj_<its name>/);
    assert.throws(() => checkProjectNames(rules, 'proj_', 'db_proj__owner', 'db_proj__app'), /proj_<its name>/);
    assert.throws(() => checkProjectNames(rules, 'proj_blog', 'db_proj_shop_owner', 'db_proj_blog_app'), /_owner and _app/);
    assert.throws(() => checkProjectNames(rules, 'proj_blog', 'db_proj_blog_app', 'db_proj_blog_owner'), /_owner and _app/);
    assert.throws(() => checkProjectNames({ ...rules, projects: undefined }, 'proj_blog', 'db_proj_blog_owner', 'db_proj_blog_app'), /no projects/);
  });
});

describe('what the panel asks for (packages/projects/src/panel/routes/projects.ts)', () => {
  it('names from the project and branch, the lfdln rules\' shape; passwords the helper takes; URLs to the host from the container', () => {
    const rules = LFDLN_HELPER.rules!.postgres!;
    for (const [id, b] of [['blog', 'main'], ['my-shop', 'dev'], ['a'.repeat(36), 'dev']] as const) {
      const n = projectDbNames(id, b);
      assert.deepEqual(checkProjectNames(rules, n.name, n.owner, n.app), { db: n.name, owner: n.owner, app: n.app }, id);
    }
    assert.deepEqual(projectDbNames('my-shop', 'dev'), { name: 'proj_my_shop_dev', owner: 'db_proj_my_shop_dev_owner', app: 'db_proj_my_shop_dev_app' });
    const pw = projectDbPassword();
    assert.match(pw, PASSWORD_RE);
    assert.equal(pw.length, 32);
    assert.notEqual(pw, projectDbPassword());
    assert.equal(dbUrl('postgres', 'db_proj_blog_app', 'x'.repeat(32), 5436, 'proj_blog'), `postgres://db_proj_blog_app:${'x'.repeat(32)}@127.0.0.1:5436/proj_blog`);
    assert.equal(dbUrl('mariadb', 'u', 'p', 3308, 'd'), 'mysql://u:p@127.0.0.1:3308/d');
  });
});

describe('a project\'s database, on both engines', () => {
  let e: Engines;
  let drivers: Drivers;
  before(async () => {
    e = await startEngines();
    drivers = { postgres: createPgDriver(e.postgres, LFDLN_HELPER.rules!.postgres), mariadb: createMariaDriver(e.mariadb, LFDLN_HELPER.rules!.mariadb) };
  });
  after(() => e?.stop());

  // a connection as one of the project's logins, as its server makes one (127.0.0.1 there, S1d)
  const asPg = (user: string, password: string, database: string) => postgres({ host: e.postgres.host, port: e.postgres.port, user, password, database, max: 1, onnotice: () => {}, connect_timeout: 5 });
  const asMaria = (user: string, password: string, database: string) => mysql.createConnection({ host: e.mariadb.host, port: e.mariadb.port, user, password, database });
  // one statement as a login, on either engine; an error is its message
  const sqlAs = async (engine: Engine, user: string, password: string, database: string, stmt: string): Promise<string> => {
    if (engine === 'postgres') {
      const c = asPg(user, password, database);
      try { return JSON.stringify(await c.unsafe(stmt)); } catch (err) { return `ERROR ${(err as Error).message}`; } finally { await c.end({ timeout: 2 }); }
    }
    let c;
    try { c = await asMaria(user, password, database); return JSON.stringify((await c.query(stmt))[0]); } catch (err) { return `ERROR ${(err as Error).message}`; } finally { await c?.end(); }
  };
  const serial = (engine: Engine) => (engine === 'postgres' ? 'serial PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY');

  for (const engine of ['postgres', 'mariadb'] as const) {
    it(`${engine}: made; the owner makes tables, the app reads and writes them but changes no structure, the Studio reads them`, async () => {
      const r = await projectDatabase(drivers, engine, 'proj_blog', 'db_proj_blog_owner', PW('o'), 'db_proj_blog_app', PW('a'));
      assert.deepEqual(r, { engine, name: 'proj_blog', owner: 'db_proj_blog_owner', app: 'db_proj_blog_app', kept: false });
      const card = (await listDatabases(drivers)).databases.find((d) => d.engine === engine && d.name === 'proj_blog');
      assert.equal(card?.appOwned, true, 'shown in the Studio as one it never changes');

      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_owner', PW('o'), 'proj_blog', `CREATE TABLE posts (id ${serial(engine)}, title VARCHAR(100))`), /ERROR/);
      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_owner', PW('o'), 'proj_blog', "INSERT INTO posts (title) VALUES ('first')"), /ERROR/);
      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', "INSERT INTO posts (title) VALUES ('second')"), /ERROR/);
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', 'SELECT count(*) AS n FROM posts'), /"n":"?2"?/);
      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', "UPDATE posts SET title = 'changed' WHERE id = 1"), /ERROR/);
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', 'DROP TABLE posts'), /ERROR/);
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', 'CREATE TABLE mine (id INT)'), /ERROR/);
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', 'ALTER TABLE posts ADD COLUMN x INT'), /ERROR/);
      // the Studio's own login reads them (its Tables page)
      assert.match(await sqlAs(engine, e[engine].user, e[engine].password, 'proj_blog', 'SELECT count(*) AS n FROM posts'), /"n":"?2"?/);
      // ...and no other database is the project's (on lfdln-appdb pg_hba also keeps db_ logins out of postgres)
      await createDatabase(drivers, engine, 'recipes');
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'recipes', 'SELECT 1'), /ERROR/);
      assert.match(await sqlAs(engine, 'db_proj_blog_owner', PW('o'), 'recipes', 'SELECT 1'), /ERROR/);
      await dropDatabase(drivers, engine, 'recipes');
    });

    it(`${engine}: the Studio never makes, changes or drops a project's database or its logins`, async () => {
      assert.equal(await code(() => createDatabase(drivers, engine, 'proj_other')), 'not-allowed');
      assert.equal(await code(() => dropDatabase(drivers, engine, 'proj_blog')), 'not-allowed');
      assert.equal(await code(() => createUser(drivers, engine, 'db_proj_other_app', PW('x'))), 'not-allowed');
      assert.equal(await code(() => dropUser(drivers, engine, 'db_proj_blog_app')), 'not-allowed');
      assert.equal(await code(() => resetPassword(drivers, engine, 'db_proj_blog_owner', PW('x'))), 'not-allowed');
      await createUser(drivers, engine, 'db_reader', PW('r'));
      assert.equal(await code(() => grantAccess(drivers, engine, 'db_reader', 'proj_blog', 'read')), 'not-allowed');
      await dropUser(drivers, engine, 'db_reader');
    });

    it(`${engine}: made again (a project of that name made anew): what is there is kept, with new passwords`, async () => {
      const r = await projectDatabase(drivers, engine, 'proj_blog', 'db_proj_blog_owner', PW('O'), 'db_proj_blog_app', PW('A'));
      assert.equal(r.kept, true);
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('a'), 'proj_blog', 'SELECT 1'), /ERROR/, 'the old password is gone');
      assert.match(await sqlAs(engine, 'db_proj_blog_app', PW('A'), 'proj_blog', 'SELECT count(*) AS n FROM posts'), /"n":"?2"?/);
      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_owner', PW('O'), 'proj_blog', `CREATE TABLE tags (id ${serial(engine)})`), /ERROR/);
      assert.doesNotMatch(await sqlAs(engine, 'db_proj_blog_app', PW('A'), 'proj_blog', 'INSERT INTO tags VALUES (DEFAULT)'), /ERROR/);
    });

    it(`${engine}: bad names and passwords are refused before anything is made`, async () => {
      assert.equal(await code(() => projectDatabase(drivers, engine, 'recipes', 'db_proj_recipes_owner', PW('o'), 'db_proj_recipes_app', PW('a'))), 'invalid');
      assert.equal(await code(() => projectDatabase(drivers, engine, 'proj_shop', 'db_proj_shop_owner', 'short', 'db_proj_shop_app', PW('a'))), 'invalid');
      assert.equal((await listDatabases(drivers)).databases.some((d) => d.name === 'proj_shop' || d.name === 'recipes'), false);
    });
  }
});
