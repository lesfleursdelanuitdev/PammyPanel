// The database helper (src/pammydb/): the name rules and the refuse-list, the
// endpoints it is allowed to use, the ops over a real socket with stub drivers,
// and then everything again against throwaway copies of her two real engines.
//
// The refuse-list tests deliberately prove the engine WOULD have let the studio
// role through: a check that cannot fail is worse than no check
// (docs/studio-plan.md S4).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FORBIDDEN_PORTS, loadHelperConfig, MARIADB_PORT, PAMMY_HELPER, POSTGRES_PORT, type HelperSite } from '@panel/studio/pammydb/config';
import type { DatabaseFacts, Driver } from '@panel/studio/pammydb/driver';
import { checkName, checkOpenable, checkWritable, ENGINES, newNameProblem, PammyDbError, PROTECTED, quote, SYSTEM, type Engine } from '@panel/studio/pammydb/ident';
import { createMariaDriver } from '@panel/studio/pammydb/maria';
import {
  adoptDatabase, applySchema, createDatabase, createUser, databaseSize, deleteRow, dropDatabase,
  dropUser, getRow, grantAccess, insertRow, introspect, listDatabases, listRows, listUsers, previewSchema,
  resetPassword, revokeAccess, setLinks, updateRow, userAccess, type Drivers,
} from '@panel/studio/pammydb/ops';
import { canAlter, starterTable, type Column, type Snapshot, type Table } from '@panel/studio/pammydb/ir';
import type { Step } from '@panel/studio/pammydb/patch';
import { diff } from '@panel/studio/studio/diff';
import { addRelationship, relationships } from '@panel/studio/studio/relationships';
import { DB_EXAMPLE_KINDS, DB_EXAMPLES, exampleSnapshot, seedExample } from '@panel/examples/studio/db-examples';
import { checkSnapshot } from '@panel/studio/pammydb/ir';
import { createPgDriver } from '@panel/studio/pammydb/pg';
import { LFDLN_HELPER } from '@panel/lfdln/studio-site';
import { callPammyDb, PammyDbCallError } from '@panel/studio/pammydb/client';
import { createPammyDbServer } from '@panel/studio/pammydb/service';
import { cleanRich } from '@panel/studio/studio/rich-text';
import { withCommentLink } from '@panel/comments/studio/comments-tables';
import { momentFor } from '@panel/form-links/studio/form-links';
import { startEngines, type Engines } from './pammydb-harness.ts';
import mysqlLib from 'mysql2/promise';
import pgLib from 'postgres';

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { if (e instanceof PammyDbError) return e.code; throw e; }
  return 'no error';
};

// ------------------------------------------------------------------ names
describe('database names', () => {
  it('explains a bad name in her words', () => {
    assert.equal(newNameProblem('', 'postgres'), 'Please type a name.');
    assert.match(newNameProblem('Recipes', 'postgres')!, /lowercase/);
    assert.match(newNameProblem('2026_notes', 'postgres')!, /start with a letter/);
    assert.match(newNameProblem('my-recipes', 'postgres')!, /letters, digits and underscores/);
    assert.match(newNameProblem('a'.repeat(64), 'postgres')!, /at most 63/);
    assert.equal(newNameProblem('recipes', 'postgres'), null);
    assert.equal(newNameProblem('blog_posts_2026', 'mariadb'), null);
  });

  it('refuses a name already taken, per engine', () => {
    for (const n of ['postgres', 'template1']) assert.match(newNameProblem(n, 'postgres')!, /taken by the database server/);
    for (const n of ['mysql', 'information_schema']) assert.match(newNameProblem(n, 'mariadb')!, /taken by the database server/);
    // hers, on both: a new one can't be called this either
    assert.match(newNameProblem('pamela', 'postgres')!, /came with your account/);
    assert.match(newNameProblem('pamela', 'mariadb')!, /came with your account/);
    // each engine only knows its own system names
    assert.equal(newNameProblem('mysql', 'postgres'), null);
    assert.equal(newNameProblem('postgres', 'mariadb'), null);
  });

  it('checks again in the helper, and says which kind of refusal it is', async () => {
    assert.equal(await code(async () => checkName('Recipes')), 'invalid');
    assert.equal(await code(async () => checkName('drop table x')), 'invalid');
    assert.equal(await code(async () => checkName(42)), 'invalid');
    assert.equal(await code(async () => checkWritable('postgres', 'pamela')), 'not-allowed');
    assert.equal(checkWritable('postgres', 'recipes'), 'recipes');
  });

  it('lets her work inside her own database, but never creates or deletes it', () => {
    // the whole point of the two lists: `pamela` is where her work already is
    assert.equal(checkOpenable('postgres', 'pamela'), 'pamela');
    assert.equal(checkOpenable('mariadb', 'pamela'), 'pamela');
    assert.throws(() => checkWritable('postgres', 'pamela'), /will not create or delete it/);
    // the engine's own machinery is not opened at all
    for (const engine of ['postgres', 'mariadb'] as const) {
      for (const n of SYSTEM[engine]) {
        assert.throws(() => checkOpenable(engine, n), /belongs to the database server itself/, `open ${n}`);
        assert.throws(() => checkWritable(engine, n), /belongs to the database server itself/, `write ${n}`);
      }
    }
  });

  it('quotes per dialect', () => {
    assert.equal(quote('postgres', 'blog_posts'), '"blog_posts"');
    assert.equal(quote('mariadb', 'blog_posts'), '`blog_posts`');
    assert.throws(() => quote('postgres', 'blog"posts'), PammyDbError);
  });

  it('protects pamela on both engines', () => {
    assert.ok(PROTECTED.postgres.includes('pamela'));
    assert.ok(PROTECTED.mariadb.includes('pamela'));
  });
});

// ------------------------------------------------------------------ endpoints (S7)
describe('where the helper may connect', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pammydb-cfg-'));
    writeFileSync(join(dir, 'studio-postgres.pass'), 'pgsecret\n');
    writeFileSync(join(dir, 'studio-mariadb.pass'), 'mariasecret\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to her two engines and reads the credentials systemd passes', () => {
    const cfg = loadHelperConfig({ CREDENTIALS_DIRECTORY: dir }, PAMMY_HELPER);
    assert.deepEqual(cfg.postgres, { host: '127.0.0.1', port: POSTGRES_PORT, user: 'pammy_studio', password: 'pgsecret' });
    assert.deepEqual(cfg.mariadb, { host: '127.0.0.1', port: MARIADB_PORT, user: 'pammy_studio', password: 'mariasecret' });
    assert.equal(POSTGRES_PORT, 5433);
    assert.equal(MARIADB_PORT, 3307);
  });

  it('never takes a host from anywhere', () => {
    const cfg = loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_HOST: '10.0.0.9', PAMMYDB_HOST: 'example.com' } as NodeJS.ProcessEnv, PAMMY_HELPER);
    assert.equal(cfg.postgres!.host, '127.0.0.1');
    assert.equal(cfg.mariadb!.host, '127.0.0.1');
  });

  it('refuses the panel\'s own database and the host\'s (S7)', () => {
    assert.deepEqual(FORBIDDEN_PORTS, [5432, 5434]);
    for (const port of FORBIDDEN_PORTS) {
      assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_PORT: String(port) }, PAMMY_HELPER), /refusing to use port/);
      assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_MARIADB_PORT: String(port) }, PAMMY_HELPER), /refusing to use port/);
    }
    // and the check is not vacuous: another port is accepted
    assert.equal(loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_PORT: '5999' }, PAMMY_HELPER).postgres!.port, 5999);
  });

  it('will not start without a password', () => {
    assert.throws(() => loadHelperConfig({}, PAMMY_HELPER), /no POSTGRES password/);
    assert.throws(() => loadHelperConfig({ PAMMYDB_POSTGRES_PASSWORD: 'x' }, PAMMY_HELPER), /no MARIADB password/);
  });
  // docs/phase8-plan.md 8-4: another site's helper, with its own engine, ports and names
  it("lfdln's: one engine, its own port, every other site's database port refused", () => {
    const lfdln: HelperSite = { name: 'lfdln-pammydb', engines: { postgres: { port: 5436 } }, forbiddenPorts: [5432, 5433, 5434, 5435, 3307] };
    const cfg = loadHelperConfig({ CREDENTIALS_DIRECTORY: dir }, lfdln);
    assert.deepEqual(cfg.postgres, { host: '127.0.0.1', port: 5436, user: 'pammy_studio', password: 'pgsecret' });
    assert.equal(cfg.mariadb, undefined, 'no MariaDB, and no password asked for it');
    assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_PORT: '5433' }, lfdln), /lfdln-pammydb: refusing to use port 5433/, "Pamela's Postgres");
    assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_PORT: '5435' }, lfdln), /refusing/, "lfdln's panel's own");
  });

  // docs/lfdln-mariadb-plan.md M4: lfdln's real helper, both of its own engines and never Pamela's
  it("lfdln's real helper: lfdln-appdb and lfdln-appmaria, Pamela's MariaDB refused, db_ logins on both", () => {
    const cfg = loadHelperConfig({ CREDENTIALS_DIRECTORY: dir }, LFDLN_HELPER);
    assert.deepEqual(cfg.postgres, { host: '127.0.0.1', port: 5436, user: 'pammy_studio', password: 'pgsecret' });
    assert.deepEqual(cfg.mariadb, { host: '127.0.0.1', port: 3308, user: 'pammy_studio', password: 'mariasecret' });
    assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_MARIADB_PORT: '3307' }, LFDLN_HELPER), /refusing to use port 3307/, "Pamela's MariaDB");
    for (const e of ['postgres', 'mariadb'] as const) assert.equal(LFDLN_HELPER.rules![e]!.userPrefix, 'db_', e);
    assert.deepEqual(LFDLN_HELPER.rules!.mariadb!.managed, {}, 'no apps on lfdln-appmaria');
    for (const u of ['root', 'mariadb.sys', 'healthcheck', 'pammy_studio']) assert.ok(LFDLN_HELPER.rules!.mariadb!.reservedUsers.includes(u), u);
  });


  it('refuses a port that is not a port', () => {
    assert.throws(() => loadHelperConfig({ CREDENTIALS_DIRECTORY: dir, PAMMYDB_POSTGRES_PORT: 'the usual one' }, PAMMY_HELPER), /not a port number/);
  });
});

// ------------------------------------------------------------------ ops, with stub drivers
function stub(engine: 'postgres' | 'mariadb', rows: string[], fail?: string, users: string[] = []): Driver {
  const facts = (name: string): DatabaseFacts => ({
    engine, name, bytes: 10, tables: 1, owner: null,
    protectedName: PROTECTED[engine].includes(name), system: SYSTEM[engine].includes(name),
  });
  return {
    engine,
    state: async () => ({ engine, ok: !fail, version: null, message: fail ?? null }),
    list: async () => { if (fail) throw new PammyDbError('unavailable', fail); return rows.map(facts); },
    create: async (name) => facts(name),
    drop: async () => {},
    size: async () => ({ bytes: 10, tables: 1 }),
    introspect: async (database) => ({ engine, database, tables: [], notes: [] }),
    apply: async (_d, steps) => ({ applied: steps.length, failed: null, rolledBack: false }),
    listUsers: async () => {
      if (fail) throw new PammyDbError('unavailable', fail);
      return users.map((name) => ({ engine, name, host: null, canLogin: true, reserved: false, serverWide: false }));
    },
    createUser: async (name) => ({ engine, name, host: null, canLogin: true, reserved: false, serverWide: false }),
    dropUser: async () => {},
    setPassword: async () => {},
    accessOf: async (_user, databases) => databases.map((database) => ({ database, role: 'read' as const })),
    grant: async () => {},
    revoke: async () => {},
    // rows are proved against the real engines further down this file; the
    // stub driver exists to test the op layer's checking, not SQL
    listRows: async () => ({ items: [], total: 0 }),
    getRow: async () => null,
    insertRow: async () => ({}),
    updateRow: async () => null,
    deleteRow: async () => false,
    setLinks: async () => 0,
    close: async () => {},
  };
}

// docs/phase8-plan.md 8-4 (P8-8, P8-9): lfdln's helper -- one engine, and the apps' own
// databases shown and read, never changed
describe('a site with one engine and databases its apps own', () => {
  const rules = {
    system: ['postgres', 'template0', 'template1'], protected: ['postgres', 'template0', 'template1'],
    reservedUsers: ['postgres', 'pammy_studio', 'public', 'tutorstar', 'examprep_owner', 'examprep_app'],
    managed: { tutorstar: 'public', examprep: 'prep' },
    userPrefix: 'db_',
  };
  const lfdln = (): Drivers => ({ postgres: { ...stub('postgres', ['examprep', 'notebook', 'tutorstar']), rules } });

  it('lists Postgres only, and says which databases are the apps\'', async () => {
    const { databases, engines } = await listDatabases(lfdln());
    assert.deepEqual(engines.map((e) => e.engine), ['postgres']);
    assert.equal(await code(() => createDatabase(lfdln(), 'mariadb', 'notes')), 'not-found', 'no MariaDB here');
    assert.equal(await code(() => listUsers(lfdln()).then(() => { throw new PammyDbError('internal', 'ok'); })), 'internal');
    assert.ok(databases.length === 3);
  });

  it("an app's database: read, never changed -- structure, rows, logins, dropping", async () => {
    const d = lfdln();
    for (const db of ['tutorstar', 'examprep']) {
      assert.equal((await introspect(d, 'postgres', db)).database, db, 'looked inside');
      assert.deepEqual(await listRows(d, 'postgres', db, { table: 'topics', columns: ['id'] }), { items: [], total: 0 }, 'rows read');
      for (const [what, fn] of [
        ['drop', () => dropDatabase(d, 'postgres', db)],
        ['create', () => createDatabase(d, 'postgres', db)],
        ['apply', () => applySchema(d, 'postgres', db, [], 'x')],
        ['preview', () => previewSchema(d, 'postgres', db, [])],
        ['insert', () => insertRow(d, 'postgres', db, 'topics', { name: 'x' }, ['id'])],
        ['update', () => updateRow(d, 'postgres', db, 'topics', { name: 'x' }, { id: 1 }, ['id'])],
        ['delete', () => deleteRow(d, 'postgres', db, 'topics', { id: 1 })],
        ['grant', () => grantAccess(d, 'postgres', 'reader', db, 'read')],
        ['revoke', () => revokeAccess(d, 'postgres', 'reader', db)],
      ] as const) assert.equal(await code(fn), 'not-allowed', `${what} ${db}`);
    }
    // the apps' logins are never touched either
    for (const u of ['tutorstar', 'examprep_app']) {
      assert.equal(await code(() => resetPassword(d, 'postgres', u, 'A'.repeat(20))), 'not-allowed', u);
      assert.equal(await code(() => dropUser(d, 'postgres', u)), 'not-allowed', u);
    }
    // its own logins start with db_ (P8-15), and it touches no other
    assert.equal(await code(() => createUser(d, 'postgres', 'recipes', 'A'.repeat(20))), 'not-allowed');
    assert.equal(await code(() => createUser(d, 'postgres', 'db_', 'A'.repeat(20))), 'not-allowed');
    assert.equal((await createUser(d, 'postgres', 'db_recipes', 'A'.repeat(20))).name, 'db_recipes');
    assert.equal(await code(() => grantAccess(d, 'postgres', 'someone', 'notebook', 'read')), 'not-allowed');
    // a database made in the Studio is the Studio's as ever
    assert.equal((await insertRow(d, 'postgres', 'notebook', 'notes', { title: 'x' }, ['id'])) !== undefined, true);
    assert.equal((await createDatabase(d, 'postgres', 'drafts')).name, 'drafts');
  });
});

describe('the ops', () => {
  const drivers = (): Drivers => ({ postgres: stub('postgres', ['pamela', 'recipes']), mariadb: stub('mariadb', ['mysql', 'notes']) });

  it('lists both engines, marking the ones it will not touch', async () => {
    const { databases, engines } = await listDatabases(drivers());
    assert.deepEqual(databases.map((d) => `${d.engine}:${d.name}`), ['mariadb:mysql', 'mariadb:notes', 'postgres:pamela', 'postgres:recipes']);
    assert.deepEqual(databases.filter((d) => d.protectedName).map((d) => d.name), ['mysql', 'pamela']);
    assert.deepEqual(engines.map((e) => e.ok), [true, true]);
  });

  it('shows one engine\'s databases when the other is down', async () => {
    const { databases, engines } = await listDatabases({ postgres: stub('postgres', ['recipes']), mariadb: stub('mariadb', [], 'Her MariaDB is not answering.') });
    assert.deepEqual(databases.map((d) => d.name), ['recipes']);
    assert.deepEqual(engines.map((e) => [e.engine, e.ok, e.message]), [['mariadb', false, 'Her MariaDB is not answering.'], ['postgres', true, null]]);
  });

  it('refuses an engine it does not know', async () => {
    assert.equal(await code(() => createDatabase(drivers(), 'sqlite', 'notes')), 'invalid');
    assert.equal(await code(() => createDatabase(drivers(), undefined, 'notes')), 'invalid');
  });

  it('never creates or deletes a protected name (S8)', async () => {
    for (const [engine, name] of [['postgres', 'pamela'], ['postgres', 'postgres'], ['mariadb', 'mysql'], ['mariadb', 'pamela']] as const) {
      assert.equal(await code(() => createDatabase(drivers(), engine, name)), 'not-allowed', `create ${name}`);
      assert.equal(await code(() => dropDatabase(drivers(), engine, name)), 'not-allowed', `drop ${name}`);
    }
    // not vacuous: an ordinary name goes through all four ops
    assert.equal((await createDatabase(drivers(), 'postgres', 'recipes')).name, 'recipes');
    assert.deepEqual(await dropDatabase(drivers(), 'postgres', 'recipes'), { engine: 'postgres', name: 'recipes', dropped: true });
    assert.equal((await databaseSize(drivers(), 'postgres', 'recipes')).tables, 1);
    assert.equal((await adoptDatabase(drivers(), 'postgres', 'recipes')).name, 'recipes');
  });

  it('will look inside her own database, and refuses the engine\'s machinery', async () => {
    assert.equal((await databaseSize(drivers(), 'postgres', 'pamela')).name, 'pamela');
    assert.equal((await adoptDatabase(drivers(), 'postgres', 'pamela')).name, 'pamela');
    assert.equal(await code(() => databaseSize(drivers(), 'mariadb', 'mysql')), 'not-allowed');
    assert.equal(await code(() => adoptDatabase(drivers(), 'postgres', 'template1')), 'not-allowed');
  });

  it('will not adopt a database that is not there', async () => {
    assert.equal(await code(() => adoptDatabase(drivers(), 'postgres', 'nothing_here')), 'not-found');
  });
});

// ------------------------------------------------------------------ the socket
describe('the socket', () => {
  let dir: string;
  let sock: string;
  let server: ReturnType<typeof createPammyDbServer>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pammydb-sock-'));
    sock = join(dir, 'pammydb.sock');
    server = createPammyDbServer({ postgres: stub('postgres', ['recipes']), mariadb: stub('mariadb', ['notes']) });
    await new Promise<void>((r) => server.listen(sock, r));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a list', async () => {
    const r = await callPammyDb<{ databases: DatabaseFacts[] }>(sock, { op: 'list-databases', actor: 'test' });
    assert.deepEqual(r.databases.map((d) => d.name), ['notes', 'recipes']);
  });

  it('passes a refusal back with its code', async () => {
    await assert.rejects(
      callPammyDb(sock, { op: 'drop-database', engine: 'postgres', name: 'pamela' }),
      (e: PammyDbCallError) => e.code === 'not-allowed' && /will not create or delete it/.test(e.message),
    );
    await assert.rejects(
      callPammyDb(sock, { op: 'create-database', engine: 'postgres', name: 'Recipes' }),
      (e: PammyDbCallError) => e.code === 'invalid',
    );
  });

  it('refuses an op it does not have', async () => {
    await assert.rejects(callPammyDb(sock, { op: 'apply-schema' }), (e: PammyDbCallError) => e.code === 'invalid');
  });
});

// ------------------------------------------------------------------ an engine that isn't there
describe('an engine that is not answering', () => {
  it('says so in her words instead of throwing a driver error', async () => {
    // nothing listens on this port; the studio's real ports are never used here
    const postgres = createPgDriver({ host: '127.0.0.1', port: 5399, user: 'pammy_studio', password: 'x' });
    const mariadb = createMariaDriver({ host: '127.0.0.1', port: 3399, user: 'pammy_studio', password: 'x' });
    try {
      const { databases, engines } = await listDatabases({ postgres, mariadb });
      assert.deepEqual(databases, []);
      assert.equal(engines.length, 2);
      for (const e of engines) {
        assert.equal(e.ok, false);
        assert.match(e.message!, /not answering/);
      }
      const state = await postgres.state();
      assert.equal(state.ok, false);
    } finally {
      await Promise.all([postgres.close(), mariadb.close()]);
    }
  });
});

// ------------------------------------------------------------------ her real engines
describe('against real engines', () => {
  let e: Engines;
  let drivers: Drivers;

  before(async () => {
    e = await startEngines();
    drivers = { postgres: createPgDriver(e.postgres), mariadb: createMariaDriver(e.mariadb) };
  });
  after(async () => {
    await Promise.all([drivers.postgres!.close(), drivers.mariadb!.close()]).catch(() => {});
    e.stop();
  });

  it('lists what is there, both engines, with her own marked', async () => {
    const { databases, engines } = await listDatabases(drivers);
    assert.deepEqual(engines.map((x) => [x.engine, x.ok]), [['mariadb', true], ['postgres', true]]);
    const pamela = databases.filter((d) => d.name === 'pamela');
    assert.equal(pamela.length, 2, 'her database on both engines');
    // hers: never created or deleted by the panel, but not the engine's machinery either
    for (const p of pamela) {
      assert.equal(p.protectedName, true);
      assert.equal(p.system, false);
    }
    // Postgres reports an owner, MariaDB has none
    assert.equal(databases.find((d) => d.engine === 'postgres' && d.name === 'pamela')!.owner, 'pamela');
    assert.equal(databases.find((d) => d.engine === 'mariadb' && d.name === 'pamela')!.owner, null);
    // the engine's own machinery is listed and marked, not hidden
    assert.ok(databases.some((d) => d.engine === 'mariadb' && d.name === 'mysql' && d.protectedName && d.system));
    assert.ok(databases.some((d) => d.engine === 'postgres' && d.name === 'postgres' && d.protectedName && d.system));
    // templates are not databases she can use
    assert.ok(!databases.some((d) => d.name.startsWith('template')));
  });

  it('makes, measures and deletes a database on each engine', async () => {
    for (const engine of ['postgres', 'mariadb'] as const) {
      const name = `t_${engine}_recipes`;
      const made = await createDatabase(drivers, engine, name);
      assert.equal(made.name, name);
      assert.ok((await listDatabases(drivers)).databases.some((d) => d.engine === engine && d.name === name));

      const empty = await databaseSize(drivers, engine, name);
      assert.equal(empty.engine, engine);
      assert.equal(empty.name, name);
      assert.equal(empty.tables, 0);
      assert.ok(empty.bytes !== null && empty.bytes >= 0, `${engine} reports a size for an empty database`);

      // A table appears in the count even though the engine's own admin made it
      // and the studio role has no rights on it: the count comes from the
      // catalogs, not from what this role may read.
      if (engine === 'postgres') e.pgSuper('CREATE TABLE cakes (id int primary key, name text)', name);
      else e.mariaRoot(`USE \`${name}\`; CREATE TABLE cakes (id int primary key, name varchar(80));`);
      const sized = await databaseSize(drivers, engine, name);
      assert.equal(sized.tables, 1);
      assert.ok(sized.bytes !== null && sized.bytes > 0, `${engine} reports a size`);

      // adopt reports the same facts
      const adopted = await adoptDatabase(drivers, engine, name);
      assert.equal(adopted.tables, 1);
      assert.equal(adopted.protectedName, false);

      // twice is a friendly refusal, not a crash
      assert.equal(await code(() => createDatabase(drivers, engine, name)), 'exists');

      await dropDatabase(drivers, engine, name);
      assert.ok(!(await listDatabases(drivers)).databases.some((d) => d.engine === engine && d.name === name));
      assert.equal(await code(() => databaseSize(drivers, engine, name)), 'not-found');
    }
  });

  it('makes MariaDB databases utf8mb4, so accents and emoji work', async () => {
    await createDatabase(drivers, 'mariadb', 't_charset');
    const got = e.mariaRoot("SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 't_charset'");
    assert.match(got, /utf8mb4\tutf8mb4_unicode_ci/);
    await dropDatabase(drivers, 'mariadb', 't_charset');
  });

  it('makes Postgres databases the studio owns', async () => {
    await createDatabase(drivers, 'postgres', 't_owner');
    assert.equal(e.pgSuper("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 't_owner'"), 'pammy_studio');
    await dropDatabase(drivers, 'postgres', 't_owner');
  });

  // Slice 3 widened this deliberately -- making logins is the whole slice -- so
  // the test now says what the ceiling is rather than that nothing moved.
  // CREATEROLE and GRANT OPTION are expected; the list below is not.
  it('is not a superuser on either engine, and cannot become one', async () => {
    assert.equal(e.pgSuper("SELECT rolsuper OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = 'pammy_studio'"), 'f');
    assert.equal(e.pgSuper("SELECT rolcreatedb AND rolcreaterole FROM pg_roles WHERE rolname = 'pammy_studio'"), 't',
      'slice 3: it makes databases and the logins that reach them');

    const grants = e.mariaRoot("SHOW GRANTS FOR 'pammy_studio'@'%'");
    for (const p of ['SUPER', 'FILE', 'PROCESS', 'RELOAD', 'SHUTDOWN', 'REPLICATION']) {
      assert.ok(!new RegExp(`\\b${p}\\b`).test(grants), `no ${p}: ${grants}`);
    }
    assert.ok(/CREATE USER/.test(grants), `slice 3 needs CREATE USER: ${grants}`);
    assert.ok(/GRANT OPTION/.test(grants), `slice 3 needs GRANT OPTION: ${grants}`);
    assert.ok(/CREATE/.test(grants) && /DROP/.test(grants), `can still design: ${grants}`);
  });

  // GRANT OPTION only ever hands on what the grantor holds, so the list above is
  // the ceiling for every login the panel makes as well. Worth proving rather
  // than reasoning about, because it is the sentence the widening rests on.
  it('cannot hand a login a privilege it has not got itself', async () => {
    await createUser(drivers, 'mariadb', 'reacher', 'Passw0rdPassw0rdPassw0rd');
    // as the studio itself, not through the driver: the driver has no way to
    // send this, and that is not what is being tested -- the engine's ceiling is
    const c = await mysqlLib.createConnection({
      host: e.mariadb.host, port: e.mariadb.port, user: e.mariadb.user, password: e.mariadb.password,
    });
    try {
      await assert.rejects(() => c.query("GRANT SUPER ON *.* TO 'reacher'@'%'"),
        'the studio has no SUPER, so it cannot pass one on');
    } finally { await c.end(); }
    assert.ok(!/SUPER/.test(e.mariaRoot("SHOW GRANTS FOR 'reacher'@'%'")));
    await dropUser(drivers, 'mariadb', 'reacher');
  });

  // The important one: the refuse-list, and proof that it is the only thing
  // standing there (S8). This runs last on each engine because it really does
  // drop her database.
  it('refuses to drop her own database -- and the engine would have let it', async () => {
    assert.equal(await code(() => dropDatabase(drivers, 'postgres', 'pamela')), 'not-allowed');
    assert.equal(await code(() => dropDatabase(drivers, 'mariadb', 'pamela')), 'not-allowed');
    assert.equal(e.pgSuper("SELECT count(*) FROM pg_database WHERE datname = 'pamela'"), '1');
    assert.equal(e.mariaRoot("SELECT count(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'pamela'"), '1');

    // ops.ts is what refused; the driver underneath has the rights to do it
    await drivers.postgres!.drop('pamela');
    await drivers.mariadb!.drop('pamela');
    assert.equal(e.pgSuper("SELECT count(*) FROM pg_database WHERE datname = 'pamela'"), '0',
      'the studio role CAN drop her Postgres database: the refuse-list is the protection');
    assert.equal(e.mariaRoot("SELECT count(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'pamela'"), '0',
      'the studio role CAN drop her MariaDB database: the refuse-list is the protection');

    // put it back, so nothing after this runs against a half-empty server
    e.pgSuper('CREATE DATABASE pamela OWNER pamela');
    e.mariaRoot('CREATE DATABASE pamela');
  });

  it('can look inside her own database, which is the point of the two lists', async () => {
    const size = await databaseSize(drivers, 'postgres', 'pamela');
    assert.equal(size.name, 'pamela');
    assert.ok(size.tables >= 0);
    const adopted = await adoptDatabase(drivers, 'mariadb', 'pamela');
    assert.equal(adopted.name, 'pamela');
    assert.equal(adopted.protectedName, true);
    // but the engine's own machinery is not opened at all
    assert.equal(await code(() => databaseSize(drivers, 'mariadb', 'mysql')), 'not-allowed');
    assert.equal(await code(() => databaseSize(drivers, 'postgres', 'template1')), 'not-allowed');
  });

  it('refuses to drop the engine\'s own databases too', async () => {
    assert.equal(await code(() => dropDatabase(drivers, 'postgres', 'postgres')), 'not-allowed');
    assert.equal(await code(() => dropDatabase(drivers, 'mariadb', 'mysql')), 'not-allowed');
    assert.equal(await code(() => createDatabase(drivers, 'mariadb', 'information_schema')), 'not-allowed');
  });


  // Can this login actually get in with this password? The only honest way to
  // ask whether a password was really changed -- the engines keep hashes, in
  // columns whose names differ by version.
  const canLogIn = async (engine: 'postgres' | 'mariadb', user: string, password: string): Promise<boolean> => {
    if (engine === 'postgres') {
      // host and port only from the endpoint: spreading it would also carry its
      // `user`, which postgres.js prefers over `username`, and every login would
      // look like the studio's
      const sql = pgLib({
        host: e.postgres.host, port: e.postgres.port, username: user, password,
        database: 'postgres', max: 1, connect_timeout: 5, onnotice: () => {},
      });
      try { await sql`SELECT 1`; return true; } catch { return false; } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
    }
    try {
      const c = await mysqlLib.createConnection({ host: e.mariadb.host, port: e.mariadb.port, user, password, connectTimeout: 5000 });
      await c.query('SELECT 1');
      await c.end();
      return true;
    } catch { return false; }
  };
  // ---------------------------------------------------------------- database users
  // The four roles against the real engines, which is the only place the GRANT
  // mapping can be proved: a golden SQL string would only say we composed what
  // we meant to, not that the engine agrees it means that.
  describe('database users and the four roles', () => {
    // one database per engine to grant on, made once for this block
    before(async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        await createDatabase(drivers, engine, 'u_shop').catch(() => {});
      }
      // A table, so "read only really cannot write" has something to try. Made
      // as the studio, which is who makes tables in a database the panel made
      // -- as `postgres` it would be owned by the superuser, and Postgres lets
      // only an owner say who may use its tables.
      e.pgSuper('SET ROLE pammy_studio; CREATE TABLE orders (id int)', 'u_shop');
      e.mariaRoot('CREATE TABLE u_shop.orders (id int)');
    });

    it('makes a login that can reach nothing at all', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        const made = await createUser(drivers, engine, 'till', 'Passw0rdPassw0rdPassw0rd');
        assert.equal(made.name, 'till');
        assert.equal(made.reserved, false);
        assert.equal(made.serverWide, false, 'a new login has no server-wide rights');
        // it exists...
        assert.ok((await listUsers(drivers)).users.some((u) => u.engine === engine && u.name === 'till'));
        // ...and reaches none of her databases
        assert.deepEqual(await userAccess(drivers, engine, 'till', ['u_shop', 'pamela']), {
          engine, name: 'till', access: [],
        });
      }
    });

    it('refuses a second login with the same name', async () => {
      assert.equal(await code(() => createUser(drivers, 'postgres', 'till', 'Passw0rdPassw0rdPassw0rd')), 'exists');
    });

    it('grants each of the four, and reads back the one it granted', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        for (const role of ['read', 'write', 'structure', 'admin'] as const) {
          await grantAccess(drivers, engine, 'till', 'u_shop', role);
          const { access } = await userAccess(drivers, engine, 'till', ['u_shop']);
          assert.deepEqual(access, [{ database: 'u_shop', role }],
            `${engine}: granted ${role} and read back ${JSON.stringify(access)}`);
        }
      }
    });

    it('moving down really takes the rest away', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        await grantAccess(drivers, engine, 'till', 'u_shop', 'admin');
        await grantAccess(drivers, engine, 'till', 'u_shop', 'read');
        const { access } = await userAccess(drivers, engine, 'till', ['u_shop']);
        assert.deepEqual(access, [{ database: 'u_shop', role: 'read' }], `${engine}: still an administrator`);
      }
    });

    it('the roles are what she was promised, in SQL', async () => {
      // Read only really cannot write, and Read & write really can. The role is
      // a sentence on her page; this is the sentence being true.
      await grantAccess(drivers, 'mariadb', 'till', 'u_shop', 'read');
      const shown = e.mariaRoot("SHOW GRANTS FOR 'till'@'%'");
      assert.match(shown, /GRANT SELECT ON `u_shop`/);
      assert.doesNotMatch(shown, /INSERT/);
      await grantAccess(drivers, 'mariadb', 'till', 'u_shop', 'write');
      assert.match(e.mariaRoot("SHOW GRANTS FOR 'till'@'%'"), /INSERT/);

      // Postgres: read only gets SELECT and not INSERT, on a table that exists
      await grantAccess(drivers, 'postgres', 'till', 'u_shop', 'read');
      assert.equal(e.pgSuper("SELECT has_table_privilege('till', 'orders', 'SELECT')", 'u_shop'), 't');
      assert.equal(e.pgSuper("SELECT has_table_privilege('till', 'orders', 'INSERT')", 'u_shop'), 'f');
      await grantAccess(drivers, 'postgres', 'till', 'u_shop', 'write');
      assert.equal(e.pgSuper("SELECT has_table_privilege('till', 'orders', 'INSERT')", 'u_shop'), 't');
    });

    it('a table made afterwards is reachable too (Postgres default privileges)', async () => {
      // The trap this exists for: grants apply to the tables that are there, so
      // without ALTER DEFAULT PRIVILEGES a login granted Read only today sees
      // nothing she makes tomorrow, and the page would still say "Read only".
      await grantAccess(drivers, 'postgres', 'till', 'u_shop', 'read');
      e.pgSuper('SET ROLE pammy_studio; CREATE TABLE later_on (id int)', 'u_shop');
      assert.equal(e.pgSuper("SELECT has_table_privilege('till', 'later_on', 'SELECT')", 'u_shop'), 't',
        'a table the studio makes after the grant is readable');
      e.pgSuper('DROP TABLE later_on', 'u_shop');
    });

    it('says custom for a grant someone made outside the panel', async () => {
      await grantAccess(drivers, 'mariadb', 'till', 'u_shop', 'read');
      e.mariaRoot("GRANT DROP ON u_shop.* TO 'till'@'%'");
      const { access } = await userAccess(drivers, 'mariadb', 'till', ['u_shop']);
      assert.deepEqual(access, [{ database: 'u_shop', role: 'custom' }],
        'SELECT + DROP is none of the four, and the panel does not guess');
      // and picking one of the four again replaces it
      await grantAccess(drivers, 'mariadb', 'till', 'u_shop', 'read');
      assert.deepEqual((await userAccess(drivers, 'mariadb', 'till', ['u_shop'])).access,
        [{ database: 'u_shop', role: 'read' }]);
    });

    it('taking access away leaves nothing behind', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        await grantAccess(drivers, engine, 'till', 'u_shop', 'admin');
        await revokeAccess(drivers, engine, 'till', 'u_shop');
        assert.deepEqual((await userAccess(drivers, engine, 'till', ['u_shop'])).access, []);
      }
      // revoking access it never had is what she asked for, not an error
      await revokeAccess(drivers, 'mariadb', 'till', 'u_shop');
    });

    it('a new password replaces the old one, and the old one stops working', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        await resetPassword(drivers, engine, 'till', 'FirstPasswordFirstPass11');
        assert.equal(await canLogIn(engine, 'till', 'FirstPasswordFirstPass11'), true);
        await resetPassword(drivers, engine, 'till', 'SecondPasswordSecondPas22');
        assert.equal(await canLogIn(engine, 'till', 'SecondPasswordSecondPas22'), true);
        assert.equal(await canLogIn(engine, 'till', 'FirstPasswordFirstPass11'), false,
          `${engine}: the old password still works`);
      }
    });

    it('refuses a password it would have to escape', async () => {
      for (const bad of ["it's", 'a'.repeat(9), 'has space', 'quote"quote', 'back\\slash']) {
        assert.equal(await code(() => createUser(drivers, 'postgres', 'zz_pw', bad)), 'invalid', `password ${bad}`);
      }
      // and it never got as far as making the login
      assert.ok(!(await listUsers(drivers)).users.some((u) => u.name === 'zz_pw'));
    });

    it('removes a login, and the access it had with it', async () => {
      for (const engine of ['postgres', 'mariadb'] as const) {
        await grantAccess(drivers, engine, 'till', 'u_shop', 'write');
        await dropUser(drivers, engine, 'till');
        assert.ok(!(await listUsers(drivers)).users.some((u) => u.engine === engine && u.name === 'till'));
      }
      // Postgres will not drop a role that still owns privileges, so this
      // failing would mean the revoke-before-drop had quietly stopped working
      assert.equal(e.pgSuper("SELECT count(*) FROM pg_roles WHERE rolname = 'till'"), '0');
    });

    // ---- the refuse-list, and the proof it is the only thing there
    it('never touches the logins that came with the server', async () => {
      for (const [engine, name] of [['postgres', 'pamela'], ['postgres', 'postgres'], ['mariadb', 'pamela'], ['mariadb', 'root']] as const) {
        assert.equal(await code(() => dropUser(drivers, engine, name)), 'not-allowed', `drop ${engine} ${name}`);
        assert.equal(await code(() => resetPassword(drivers, engine, name, 'Passw0rdPassw0rdPassw0rd')), 'not-allowed', `reset ${engine} ${name}`);
        assert.equal(await code(() => grantAccess(drivers, engine, name, 'u_shop', 'admin')), 'not-allowed', `grant ${engine} ${name}`);
      }
      // pg_ is Postgres's own, whatever else it says
      assert.equal(await code(() => createUser(drivers, 'postgres', 'pg_monitor', 'Passw0rdPassw0rdPassw0rd')), 'not-allowed');
      // reading is not managing: she can still be shown that `pamela` reaches everything
      const pamela = (await listUsers(drivers)).users.filter((u) => u.name === 'pamela');
      assert.equal(pamela.length, 2);
      for (const p of pamela) assert.equal(p.reserved, true, `${p.engine}: marked, not hidden`);
      assert.ok(pamela.every((p) => p.serverWide), 'her own login has the run of both servers, and the page says so');
    });

    // The same request on both engines, with ops.ts out of the way: Postgres
    // refuses it itself, MariaDB carries it out. That asymmetry is the whole
    // reason RESERVED_USERS exists, and this is what stops the refusals above
    // from being a check that could never fail (S4).
    it('Postgres bounds itself; MariaDB does not, so the list is the only protection', async () => {
      await assert.rejects(
        () => drivers.postgres!.setPassword('pamela', 'TakenOverTakenOverTaken1'),
        'since Postgres 16 a CREATEROLE role may only alter roles it created, and it did not create hers');
      assert.equal(await canLogIn('postgres', 'pamela', 'TakenOverTakenOverTaken1'), false);

      await drivers.mariadb!.setPassword('pamela', 'TakenOverTakenOverTaken1');
      assert.equal(await canLogIn('mariadb', 'pamela', 'TakenOverTakenOverTaken1'), true,
        'the studio role CAN repoint a MariaDB login it does not own: RESERVED_USERS is the protection');
      // Leave it somewhere known rather than where it was: the harness's copy of
      // her password is not ours to read back. Nothing after this signs in as
      // her -- the drivers are pammy_studio -- so this only matters if a later
      // test ever tries.
      e.mariaRoot("ALTER USER 'pamela'@'%' IDENTIFIED BY 'HarnessPamelaPassword99'");
    });

    it('grants only reach databases she may open', async () => {
      await createUser(drivers, 'mariadb', 'nosy', 'Passw0rdPassw0rdPassw0rd');
      assert.equal(await code(() => grantAccess(drivers, 'mariadb', 'nosy', 'mysql', 'admin')), 'not-allowed');
      assert.equal(await code(() => grantAccess(drivers, 'postgres', 'nosy', 'template1', 'read')), 'not-allowed');
      // her own database is not the engine's machinery: that one is allowed
      await createUser(drivers, 'postgres', 'nosy', 'Passw0rdPassw0rdPassw0rd');
      await grantAccess(drivers, 'postgres', 'nosy', 'pamela', 'read');
      assert.deepEqual((await userAccess(drivers, 'postgres', 'nosy', ['pamela'])).access,
        [{ database: 'pamela', role: 'read' }]);
      await dropUser(drivers, 'postgres', 'nosy');
      await dropUser(drivers, 'mariadb', 'nosy');
    });
  });

  // ------------------------------------------------------------------ the shape inside
  // Slice 4 against real engines. The question everything here is asking is the
  // round trip: the printer writes a table, the reader reads it back, and the
  // diff between the two is nothing. If those three ever disagree, she would see
  // a change waiting on a database she has not touched.
  describe('reading a schema and changing it', () => {
    const table = (name: string, columns: Column[], over: Partial<Table> = {}): Table =>
      ({ name, columns, primaryKey: [], uniques: [], foreignKeys: [], indexes: [], ...over });
    const column = (name: string, over: Partial<Column> = {}): Column =>
      ({ name, type: 'text', required: false, default: null, ...over });

    // one of everything she can pick
    const recipes = (): Table => table('recipes', [
      column('id', { type: 'integer', required: true, identity: true }),
      column('title', { type: 'short_text', length: 120, required: true }),
      column('body'),
      column('servings', { type: 'integer', default: { kind: 'number', value: 4 } }),
      column('price', { type: 'decimal', precision: 8, scale: 2 }),
      column('vegetarian', { type: 'boolean', default: { kind: 'boolean', value: false } }),
      column('made_on', { type: 'date' }),
      column('at_time', { type: 'time' }),
      column('made_at', { type: 'timestamptz', required: true, default: { kind: 'now' } }),
      column('ref', { type: 'uuid' }),
      column('note', { default: { kind: 'text', value: 'Untitled (draft)' } }),
    ], { primaryKey: ['id'], uniques: [{ name: 'recipes_title_key', columns: ['title'] }] });

    const db = (engine: Engine) => `t_${engine}_schema`;

    before(async () => {
      for (const engine of ENGINES) await createDatabase(drivers, engine, db(engine));
    });
    after(async () => {
      for (const engine of ENGINES) await dropDatabase(drivers, engine, db(engine)).catch(() => {});
    });

    for (const engine of ENGINES) {
      it(`makes a table on ${engine} and reads back exactly what it made`, async () => {
        const name = db(engine);
        const before = await introspect(drivers, engine, name);
        assert.deepEqual(before.tables, [], 'a new database has nothing in it');

        const wanted: Snapshot = { engine, database: name, tables: [recipes()], notes: [] };
        const steps = diff(before, wanted);
        assert.deepEqual(steps.map((s) => s.kind), ['create-table']);
        const done = await applySchema(drivers, engine, name, steps, before.hash);
        assert.equal(done.failed, null, JSON.stringify(done.failed));
        assert.equal(done.applied, 1);

        // the round trip: what the engine now has, against what she asked for
        const after = await introspect(drivers, engine, name);
        assert.deepEqual(after.tables.map((t) => t.name), ['recipes']);
        const back = after.tables[0]!;
        assert.deepEqual(back.columns.map((c) => c.name), recipes().columns.map((c) => c.name));
        assert.deepEqual(back.columns.map((c) => c.type), recipes().columns.map((c) => c.type),
          'every kind of field comes back as the kind she picked');
        assert.deepEqual(back.primaryKey, ['id']);
        assert.equal(back.columns[0]!.identity, true, 'the engine fills the id in');
        assert.equal(back.columns[1]!.length, 120);
        assert.deepEqual([back.columns[4]!.precision, back.columns[4]!.scale], [8, 2]);
        assert.deepEqual(back.columns[3]!.default, { kind: 'number', value: 4 });
        assert.deepEqual(back.columns[5]!.default, { kind: 'boolean', value: false });
        assert.deepEqual(back.columns[8]!.default, { kind: 'now' });
        assert.deepEqual(back.columns[10]!.default, { kind: 'text', value: 'Untitled (draft)' });
        assert.deepEqual(back.uniques.map((u) => u.columns), [['title']]);

        // and the point of all of it: nothing is left waiting
        assert.deepEqual(diff(after, wanted), [], 'the drawing and the database agree');
      });

      it(`changes, renames and removes a field on ${engine}, keeping the rows`, async () => {
        const name = db(engine);
        const live = await introspect(drivers, engine, name);
        const put = async (sql: string) => (engine === 'postgres' ? e.pgSuper(sql, name) : e.mariaRoot(`USE \`${name}\`; ${sql}`));
        put("INSERT INTO recipes (title, body, servings) VALUES ('Scones', 'Mix, bake.', 12)");

        const wanted = structuredClone(live) as Snapshot;
        const t = wanted.tables[0]!;
        // rename one, widen one, make one required, drop one
        t.columns = t.columns
          .filter((c) => c.name !== 'ref')
          .map((c) => {
            if (c.name === 'body') return { ...c, name: 'method', was: 'body' };
            if (c.name === 'title') return { ...c, type: 'text' as const, length: null };
            if (c.name === 'servings') return { ...c, required: true, default: { kind: 'number' as const, value: 1 } };
            return c;
          });

        const steps = diff(live, wanted);
        assert.deepEqual(steps.map((s) => s.kind).sort(),
          ['alter-column', 'alter-column', 'drop-column', 'rename-column']);
        const done = await applySchema(drivers, engine, name, steps, live.hash);
        assert.equal(done.failed, null, JSON.stringify(done.failed));

        const after = await introspect(drivers, engine, name);
        const back = after.tables[0]!;
        assert.ok(!back.columns.some((c) => c.name === 'ref'), 'the dropped field is gone');
        assert.ok(back.columns.some((c) => c.name === 'method'), 'the renamed one is there under its new name');
        assert.ok(!back.columns.some((c) => c.name === 'body'));
        assert.equal(back.columns.find((c) => c.name === 'title')!.type, 'text');
        assert.equal(back.columns.find((c) => c.name === 'servings')!.required, true);

        // the row is still there, and the writing followed the rename
        const rows = engine === 'postgres'
          ? e.pgSuper('SELECT title, method, servings FROM recipes', name)
          : e.mariaRoot(`SELECT title, method, servings FROM \`${name}\`.recipes`);
        assert.match(rows, /Scones/);
        assert.match(rows, /Mix, bake\./);
        assert.match(rows, /12/);

        // a draft carries `was` while it waits; the engine never sees one, so
        // once it is applied there is nothing left to do
        assert.deepEqual(diff(after, { ...wanted, tables: [{ ...t, columns: t.columns.map(({ was, ...c }) => c) }] }), []);
      });

      // Connections go in as constraints and have to come back as connections,
      // or the canvas and the Connections list lose them the moment she applies.
      it(`connects tables on ${engine}, and reads the connections back`, async () => {
        const name = db(engine);
        const live = await introspect(drivers, engine, name);
        const id = () => column('id', { type: 'integer', required: true, identity: true });
        let wanted: Snapshot = structuredClone(live) as Snapshot;
        wanted.tables.push(table('cooks', [id(), column('name')], { primaryKey: ['id'] }));
        wanted.tables.push(table('labels', [id(), column('word')], { primaryKey: ['id'] }));
        wanted = addRelationship(wanted, { from: { table: 'cooks', column: 'id' }, to: { table: 'recipes' }, kind: 'one-to-many', onDelete: 'set null' });
        wanted = addRelationship(wanted, { from: { table: 'recipes', column: 'id' }, to: { table: 'labels' }, kind: 'many-to-many', onDelete: 'cascade' });
        // what the panel saves has to be what it can read back as a draft
        checkSnapshot(JSON.parse(JSON.stringify(wanted)), engine, name);

        const done = await applySchema(drivers, engine, name, diff(live, wanted), live.hash);
        assert.equal(done.failed, null, JSON.stringify(done.failed));
        const after = await introspect(drivers, engine, name);
        const lines = relationships(after).map((r) => [r.kind, r.from, r.to, r.junction, r.onDelete]);
        assert.deepEqual(lines.sort(), [
          ['many-to-many', 'recipes', 'labels', 'recipe_labels', 'cascade'],
          ['one-to-many', 'cooks', 'recipes', null, 'set null'],
        ]);
        assert.deepEqual(diff(after, wanted), [], 'nothing left waiting');

        // renaming a table something points at is one rename on the engine
        const renamed = structuredClone(after) as Snapshot;
        for (const t of renamed.tables) {
          if (t.name === 'cooks') { t.was = 'cooks'; t.name = 'chefs'; }
          for (const f of t.foreignKeys) if (f.references.table === 'cooks') f.references.table = 'chefs';
        }
        const steps = diff(after, renamed);
        assert.deepEqual(steps.map((x) => x.kind), ['rename-table']);
        assert.equal((await applySchema(drivers, engine, name, steps, after.hash)).failed, null);
        const back = await introspect(drivers, engine, name);
        assert.ok(relationships(back).some((r) => r.from === 'chefs' && r.to === 'recipes'), 'the connection followed the rename');

        // leave recipes as the next test expects it
        const tidy = structuredClone(back) as Snapshot;
        tidy.tables = tidy.tables.filter((t) => !['chefs', 'labels', 'recipe_labels'].includes(t.name));
        const r = tidy.tables.find((t) => t.name === 'recipes')!;
        r.foreignKeys = [];
        r.columns = r.columns.filter((c) => c.name !== 'cook_id');
        assert.equal((await applySchema(drivers, engine, name, diff(back, tidy), back.hash)).failed, null);
      });

      it(`tells her what the engine refused, and what it did before that (${engine})`, async () => {
        const name = db(engine);
        const live = await introspect(drivers, engine, name);
        // two steps: one the engine will take, then one it cannot. Making
        // `made_on` required fails because the row already there has nothing in
        // it -- a real refusal about her real data, not a made-up one.
        const wanted = structuredClone(live) as Snapshot;
        wanted.tables[0]!.columns = wanted.tables[0]!.columns.map((c) =>
          (c.name === 'made_on' ? { ...c, required: true } : c));
        wanted.tables.push(table('extra', [column('id', { type: 'integer', required: true, identity: true })], { primaryKey: ['id'] }));

        const steps = diff(live, wanted);
        assert.deepEqual(steps.map((s) => s.kind), ['create-table', 'alter-column']);
        const done = await applySchema(drivers, engine, name, steps, live.hash);
        assert.ok(done.failed, 'the engine refused the second step');
        assert.equal(done.failed!.at, 1);
        assert.ok(done.failed!.message.length > 0, 'and said why, in its own words');

        const after = await introspect(drivers, engine, name);
        if (engine === 'postgres') {
          // one transaction: the table it made first is gone again
          assert.equal(done.rolledBack, true);
          assert.equal(done.applied, 0);
          assert.ok(!after.tables.some((t) => t.name === 'extra'), 'nothing was left half done');
        } else {
          // one at a time, and no undo: the table it made is still there
          assert.equal(done.rolledBack, false);
          assert.equal(done.applied, 1);
          assert.ok(after.tables.some((t) => t.name === 'extra'), 'what ran, ran');
          await applySchema(drivers, engine, name, [{ kind: 'drop-table', table: 'extra' }], null);
        }
      });
    }

    it('refuses to apply a patch worked out from a schema that has moved', async () => {
      const name = db('postgres');
      const live = await introspect(drivers, 'postgres', name);
      e.pgSuper('CREATE TABLE somewhere_else (id int)', name);
      const steps: Step[] = [{ kind: 'create-table', table: table('late', [column('id', { type: 'integer' })]) }];
      assert.equal(await code(() => applySchema(drivers, 'postgres', name, steps, live.hash)), 'conflict');
      // without an expectation it goes ahead: the panel always sends one, and
      // this is what proves the refusal came from the check and not from the step
      const done = await applySchema(drivers, 'postgres', name, steps, null);
      assert.equal(done.failed, null);
    });

    it('sees a table it has no rights on, because it reads the catalogs', async () => {
      // the trap information_schema sets on both engines: it shows a role only
      // what it may touch. Slice 1's table count learned this; introspect has to
      // know it too, or an adopted database reads as emptier than it is.
      const name = db('postgres');
      e.pgSuper('CREATE TABLE locked_away (id int primary key, secret text)', name);
      e.pgSuper('REVOKE ALL ON locked_away FROM PUBLIC', name);
      e.pgSuper('ALTER TABLE locked_away OWNER TO postgres', name);
      const seen = await introspect(drivers, 'postgres', name);
      const locked = seen.tables.find((t) => t.name === 'locked_away');
      assert.ok(locked, 'it is there, whatever this login may read');
      assert.deepEqual(locked!.columns.map((c) => c.name), ['id', 'secret']);
      // Not vacuous, and stronger than it was written to be: this role really
      // cannot SELECT from that table, and introspect describes it anyway. That
      // is the whole difference between pg_catalog and information_schema --
      // with the latter, an adopted database would read as emptier than it is.
      const sql = pgLib({ ...e.postgres, database: name, username: e.postgres.user, password: e.postgres.password, connect_timeout: 5, onnotice: () => {} });
      try {
        await sql`SELECT * FROM locked_away`;
        assert.fail('expected the studio role to be refused');
      } catch (err) {
        assert.equal((err as { code?: string }).code, '42501', 'refused, and still seen');
      } finally {
        await sql.end();
      }
      e.pgSuper('DROP TABLE locked_away', name);
    });

    it('keeps a starting value it cannot write down, and leaves that field alone', async () => {
      const name = db('mariadb');
      e.mariaRoot(`CREATE TABLE \`${name}\`.odd (id int primary key, made_up char(8) DEFAULT (uuid_short()))`);
      const seen = await introspect(drivers, 'mariadb', name);
      const odd = seen.tables.find((t) => t.name === 'odd')!;
      const madeUp = odd.columns.find((c) => c.name === 'made_up')!;
      assert.equal(madeUp.default?.kind, 'raw', 'carried as the engine\'s own words');
      assert.equal(canAlter(madeUp), false, 'so the panel will not touch that field');
      // and a drawing that came from this reading proposes nothing
      assert.deepEqual(diff(seen, { engine: 'mariadb', database: name, tables: seen.tables, notes: [] }), []);
      e.mariaRoot(`DROP TABLE \`${name}\`.odd`);
    });

    it('will not let two Applies into one database at once', async () => {
      const name = db('postgres');
      const live = await introspect(drivers, 'postgres', name);
      const step = (t: string): Step[] => [{ kind: 'create-table', table: table(t, [column('id', { type: 'integer' })]) }];
      const first = applySchema(drivers, 'postgres', name, step('race_a'), null);
      const second = applySchema(drivers, 'postgres', name, step('race_b'), null);
      assert.equal(await code(() => second), 'busy');
      await first;
      assert.ok((await introspect(drivers, 'postgres', name)).tables.some((t) => t.name === 'race_a'));
      assert.ok(live.hash.length > 0);
    });
  });

  // ------------------------------------------------------------------ her rows
  // Slice 8 against real engines. The questions here are the ones a builder
  // can only answer with a real database: does a search for `'; DROP TABLE`
  // find nothing and break nothing, does a per cent sign mean a per cent sign,
  // and does "8 of 32" count the same 8 it listed.
  describe('reading and writing rows', () => {
    const db = (engine: Engine) => `t_${engine}_rows`;
    const shape = (engine: Engine) => [{
      name: 'recipes',
      columns: [
        { name: 'id', type: 'integer' as const, required: true, identity: true, default: null },
        { name: 'title', type: 'short_text' as const, length: 120, required: true, default: null },
        { name: 'servings', type: 'integer' as const, required: false, default: null },
        { name: 'secret', type: 'text' as const, required: false, default: null },
      ],
      primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [],
    }];

    before(async () => {
      for (const engine of ENGINES) {
        await createDatabase(drivers, engine, db(engine));
        await applySchema(drivers, engine, db(engine),
          shape(engine).map((table) => ({ kind: 'create-table' as const, table })), null);
      }
    });
    after(async () => {
      for (const engine of ENGINES) await dropDatabase(drivers, engine, db(engine)).catch(() => {});
    });

    for (const engine of ENGINES) {
      it(`adds, reads, changes and deletes a record (${engine})`, async () => {
        const name = db(engine);
        const back = ['id', 'title', 'servings'];
        const made = await insertRow(drivers, engine, name, 'recipes', { title: 'Pancakes', servings: 4 }, back);
        assert.equal(made.row.title, 'Pancakes');
        assert.ok(Number(made.row.id) > 0, 'the engine filled the key in and gave it back');

        const got = await getRow(drivers, engine, name, 'recipes', back, { id: made.row.id as number });
        assert.equal(got.row?.title, 'Pancakes');

        const changed = await updateRow(drivers, engine, name, 'recipes',
          { title: 'Pancakes with syrup' }, { id: made.row.id as number }, back);
        assert.equal(changed.row?.title, 'Pancakes with syrup');
        assert.equal(Number(changed.row?.servings), 4, 'and the rest of the record is untouched');

        assert.equal((await deleteRow(drivers, engine, name, 'recipes', { id: made.row.id as number })).gone, true);
        assert.equal((await deleteRow(drivers, engine, name, 'recipes', { id: made.row.id as number })).gone, false,
          'deleting what is not there says so rather than pretending');
      });

      // the data API's two new questions (docs/db-examples-plan.md): "one of these
      // ids", for the labels of a page of connections, and "where this yes/no is
      // yes" -- which on MariaDB is a number, so it has to be asked as a yes/no
      it(`finds rows by a list of ids, and by a yes/no (${engine})`, async () => {
        const name = db(engine);
        const extra = { kind: 'add-column' as const, table: 'recipes', column: { name: 'shared', type: 'boolean' as const, required: false, default: null } };
        assert.equal((await applySchema(drivers, engine, name, [extra], null)).failed, null);
        const ids: number[] = [];
        for (const [title, shared] of [['In one', true], ['In two', false], ['Out', true]] as const) {
          ids.push(Number((await insertRow(drivers, engine, name, 'recipes', { title, shared }, ['id'])).row.id));
        }
        const list = (filters: unknown[]) => listRows(drivers, engine, name,
          { table: 'recipes', columns: ['id', 'title'], limit: 20, offset: 0, order: { column: 'id', dir: 'asc' }, filters } as never);
        const inTwo = await list([{ kind: 'in', column: 'id', values: [ids[0], ids[1]] }]);
        assert.deepEqual(inTwo.items.map((r) => r.title), ['In one', 'In two']);
        assert.equal((await list([{ kind: 'in', column: 'id', values: [] }])).total, 0, 'one of nothing is nothing');
        const yes = await list([{ kind: 'equals', column: 'shared', value: true }]);
        assert.deepEqual(yes.items.map((r) => r.title), ['In one', 'Out']);
        const got = await getRow(drivers, engine, name, 'recipes', ['id'], { id: ids[1]!, shared: true });
        assert.equal(got.row, null, 'a record the rule keeps back is not found');
        for (const id of ids) await deleteRow(drivers, engine, name, 'recipes', { id });
        await applySchema(drivers, engine, name, [{ kind: 'drop-column', table: 'recipes', column: 'shared' }], null);
      });

      it(`searches, narrows, sorts and counts the same rows (${engine})`, async () => {
        const name = db(engine);
        for (const [title, servings] of [['Lemon cake', 8], ['Carrot cake', 6], ['Roast', 4], ['100% rye bread', 2]] as const) {
          await insertRow(drivers, engine, name, 'recipes', { title, servings }, ['id']);
        }
        const list = (over: Record<string, unknown>) => listRows(drivers, engine, name,
          { table: 'recipes', columns: ['id', 'title', 'servings'], limit: 20, offset: 0, ...over });

        const all = await list({});
        assert.equal(all.total, 4);

        const cakes = await list({ search: { columns: ['title'], text: 'cake' } });
        assert.equal(cakes.total, 2, 'the count is the narrowed count, not the whole table');
        assert.equal(cakes.items.length, 2);

        // case does not matter to her, so it must not matter here
        assert.equal((await list({ search: { columns: ['title'], text: 'CAKE' } })).total, 2);

        // a per cent sign is a per cent sign, not "anything starting 100"
        assert.equal((await list({ search: { columns: ['title'], text: '100%' } })).total, 1);
        assert.equal((await list({ search: { columns: ['title'], text: '%' } })).total, 1,
          'and a bare % matches only the row that has one');

        const few = await list({ filters: [{ kind: 'range', column: 'servings', from: 6, to: 8 }] });
        assert.equal(few.total, 2);
        const empty = await list({ filters: [{ kind: 'empty', column: 'secret', empty: true }] });
        assert.equal(empty.total, 4, 'nothing has a secret yet');

        const sorted = await list({ order: { column: 'servings', dir: 'desc' } });
        assert.deepEqual(sorted.items.map((r) => Number(r.servings)), [8, 6, 4, 2]);

        // pages do not overlap and do not skip
        const p1 = await list({ limit: 2, offset: 0, order: { column: 'servings', dir: 'asc' } });
        const p2 = await list({ limit: 2, offset: 2, order: { column: 'servings', dir: 'asc' } });
        assert.deepEqual([...p1.items, ...p2.items].map((r) => Number(r.servings)), [2, 4, 6, 8]);
      });

      it(`a search for SQL finds nothing and breaks nothing (${engine})`, async () => {
        const name = db(engine);
        const nasty = "'; DROP TABLE recipes; --";
        const found = await listRows(drivers, engine, name,
          { table: 'recipes', columns: ['id', 'title'], limit: 20, offset: 0, search: { columns: ['title'], text: nasty }, filters: [] });
        assert.equal(found.total, 0, 'it is a thing to look for, not a thing to run');
        // and the table is still there, which is the whole point
        assert.ok((await introspect(drivers, engine, name)).tables.some((t) => t.name === 'recipes'));

        // the same, stored as a value and read back exactly
        const made = await insertRow(drivers, engine, name, 'recipes', { title: nasty }, ['id', 'title']);
        assert.equal(made.row.title, nasty, 'stored as text, and comes back as text');
        assert.equal((await listRows(drivers, engine, name,
          { table: 'recipes', columns: ['id'], limit: 20, offset: 0, search: { columns: ['title'], text: 'DROP TABLE' }, filters: [] })).total, 1);
        await deleteRow(drivers, engine, name, 'recipes', { id: made.row.id as number });
      });

      it(`refuses a name no database would take (${engine})`, async () => {
        const name = db(engine);
        assert.equal(await code(() => listRows(drivers, engine, name, { table: 'recipes; DROP TABLE recipes', columns: ['id'] })), 'invalid');
        assert.equal(await code(() => listRows(drivers, engine, name, { table: 'recipes', columns: ['id"'] })), 'invalid');
        assert.equal(await code(() => deleteRow(drivers, engine, name, 'recipes', {})), 'invalid');
        // and the engine's own machinery is not a table it will read
        assert.equal(await code(() => listRows(drivers, engine, engine === 'postgres' ? 'postgres' : 'mysql',
          { table: 'x', columns: ['id'] })), 'not-allowed');
      });

      // docs/rich-text-plan.md: HTML is text like any other -- stored and read
      // back to the byte, accents and emoji too. And on MariaDB, where a TEXT
      // holds 65,535 BYTES, too long is refused in her words, never cut (T16).
      it(`keeps rich text exactly, and says in words when it is too long (${engine})`, async () => {
        const name = db(engine);
        const html = cleanRich('<h2>Café ☕ 🎉</h2><p>Crème brûlée — <strong>ñ</strong> 日本語</p>'
          + '<table><tr><th>Bed</th><th>What</th></tr><tr><td colspan="2"><a href="https://example.org/?a=1&b=2">link</a></td></tr></table>')!;
        const made = await insertRow(drivers, engine, name, 'recipes', { title: 'Rich', secret: html }, ['id', 'secret']);
        assert.equal(made.row.secret, html);
        const got = await getRow(drivers, engine, name, 'recipes', ['secret'], { id: made.row.id as number });
        assert.equal(got.row?.secret, html);

        // 40,000 accented letters: 80,000 bytes
        const big = `<p>${'é'.repeat(40_000)}</p>`;
        if (engine === 'mariadb') {
          await assert.rejects(
            updateRow(drivers, engine, name, 'recipes', { secret: big }, { id: made.row.id as number }, ['id']),
            (e: unknown) => e instanceof PammyDbError && e.code === 'invalid' && /^secret is too long for this field/.test(e.message),
          );
          assert.equal((await getRow(drivers, engine, name, 'recipes', ['secret'], { id: made.row.id as number })).row?.secret, html,
            'refused, not cut short: what was there is still there');
        } else {
          await updateRow(drivers, engine, name, 'recipes', { secret: big }, { id: made.row.id as number }, ['id']);
          assert.equal((await getRow(drivers, engine, name, 'recipes', ['secret'], { id: made.row.id as number })).row?.secret, big);
        }
        await deleteRow(drivers, engine, name, 'recipes', { id: made.row.id as number });
      });
    }

    // S2 (docs/s2-plan.md): the gate's own door, on both engines. Row ops work through it
    // exactly as through the panel's; the rest is refused and the database is untouched.
    for (const engine of ENGINES) {
      it(`the gate's door: rows yes, anything else no (${engine})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'pammydb-gate-real-'));
        const sock = join(dir, 'gate.sock');
        const server = createPammyDbServer(drivers, () => {}, 'gate');
        await new Promise<void>((r) => server.listen(sock, r));
        try {
          const name = db(engine);
          const ask = <T>(req: Record<string, unknown>) => callPammyDb<T>(sock, { engine, name, actor: 'api', ...req });
          const made = await ask<{ row: Record<string, unknown> }>({ op: 'insert-row', table: 'recipes', values: { title: 'Gate soup', servings: 2 }, back: ['id', 'title'] });
          assert.equal(made.row.title, 'Gate soup');
          const where = { id: made.row.id as number };
          assert.equal((await ask<{ row: Record<string, unknown> }>({ op: 'get-row', table: 'recipes', columns: ['title'], where })).row.title, 'Gate soup');
          assert.equal(Number((await ask<{ row: Record<string, unknown> }>({ op: 'update-row', table: 'recipes', values: { servings: 3 }, where, back: ['servings'] })).row.servings), 3);
          const page = await ask<{ total: number }>({ op: 'list-rows', query: { table: 'recipes', columns: ['id'], limit: 5, offset: 0, filters: [{ kind: 'equals', column: 'title', value: 'Gate soup' }] } });
          assert.equal(page.total, 1);
          assert.equal((await ask<{ gone: boolean }>({ op: 'delete-row', table: 'recipes', where })).gone, true);
          for (const req of [
            { op: 'drop-database' },
            { op: 'apply-schema', patch: [{ kind: 'drop-table', table: 'recipes' }], expect: null },
            { op: 'create-user', user: 'zz_gate_made', password: 'VerifyVerifyVerify12' },
            { op: 'grant-access', user: 'pammy_studio', database: name, role: 'admin' },
          ]) {
            await assert.rejects(ask(req), (e: PammyDbCallError) => e.code === 'not-allowed', req.op);
          }
          // still there, table and all
          assert.ok((await listDatabases(drivers)).databases.some((d) => d.engine === engine && d.name === name));
          assert.ok((await introspect(drivers, engine, name)).tables.some((t) => t.name === 'recipes'));
          assert.ok(!(await listUsers(drivers)).users.some((u) => u.name === 'zz_gate_made'));
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  // S2, found at install (2026-10-08): the gate's helper is a second process with pools of its
  // own, and its idle connection to a database the gate just wrote into blocked the panel
  // helper's drop ("being accessed by other users"). The drop now ends the sessions of the
  // helpers' own login on that database first -- and only those: anyone else connected (her
  // apps' db_ logins) still makes it refuse.
  describe('deleting a database the other helper has open (Postgres)', () => {
    const t = { name: 'notes', columns: [{ name: 'id', type: 'integer' as const, required: true, identity: true, default: null }, { name: 'body', type: 'short_text' as const, length: 50, required: false, default: null }], primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [] };
    const make = async (n: string) => {
      await createDatabase(drivers, 'postgres', n);
      await applySchema(drivers, 'postgres', n, [{ kind: 'create-table' as const, table: t }], null);
    };

    it("drops it all the same, and the other helper carries on (also on that name, made again)", async () => {
      const gone = 't_postgres_two_a';
      const other = 't_postgres_two_b';
      await make(gone);
      await make(other);
      const gate: Drivers = { postgres: createPgDriver(e.postgres, undefined, { maxOpen: 8 }) };
      try {
        await insertRow(gate, 'postgres', gone, 'notes', { body: 'from the gate' }, ['id']);
        await insertRow(gate, 'postgres', other, 'notes', { body: 'from the gate' }, ['id']);
        // the gate's helper holds an idle connection to `gone`; the panel's helper deletes it
        await dropDatabase(drivers, 'postgres', gone);
        assert.ok(!(await listDatabases(drivers)).databases.some((d) => d.name === gone));
        // the gate's helper: its other database still answers
        assert.equal((await listRows(gate, 'postgres', other, { table: 'notes', columns: ['id'], limit: 5, offset: 0 })).total, 1);
        // the deleted one is not there (not an internal error)
        assert.equal(await code(() => listRows(gate, 'postgres', gone, { table: 'notes', columns: ['id'], limit: 5, offset: 0 })), 'not-found');
        // made again under the same name: the gate's helper reaches it
        await make(gone);
        assert.equal((await listRows(gate, 'postgres', gone, { table: 'notes', columns: ['id'], limit: 5, offset: 0 })).total, 0);
      } finally {
        await gate.postgres!.close();
        for (const n of [gone, other]) await dropDatabase(drivers, 'postgres', n).catch(() => {});
      }
    });

    it('still refuses while anyone else is connected to it', async () => {
      const n = 't_postgres_two_c';
      await make(n);
      e.pgSuper(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zz_someone') THEN CREATE ROLE zz_someone LOGIN PASSWORD 'someone'; END IF; END $$`);
      e.pgSuper(`GRANT CONNECT ON DATABASE ${n} TO zz_someone`);
      const someone = pgLib({ host: e.postgres.host, port: e.postgres.port, database: n, username: 'zz_someone', password: 'someone', max: 1, connect_timeout: 5, onnotice: () => {} });
      try {
        await someone`SELECT 1`;
        assert.equal(await code(() => dropDatabase(drivers, 'postgres', n)), 'busy');
        assert.ok((await listDatabases(drivers)).databases.some((d) => d.name === n), 'still there');
        assert.equal(Number(e.pgSuper(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${n}' AND usename = 'zz_someone'`)), 1, 'their session was left alone');
      } finally {
        await someone.end({ timeout: 2 });
      }
      await dropDatabase(drivers, 'postgres', n);
    });
  });

  // S2 review L1: the gate's helper keeps at most maxOpen databases' pools; the oldest is put
  // away, and asking it again opens it again
  describe('a cap on open databases (the gate\'s helper)', () => {
    const names = (engine: Engine) => [`t_${engine}_cap_a`, `t_${engine}_cap_b`];
    const table = { name: 'notes', columns: [{ name: 'id', type: 'integer' as const, required: true, identity: true, default: null }, { name: 'body', type: 'short_text' as const, length: 50, required: false, default: null }], primaryKey: ['id'], uniques: [], foreignKeys: [], indexes: [] };
    before(async () => {
      for (const engine of ENGINES) for (const n of names(engine)) {
        await createDatabase(drivers, engine, n);
        await applySchema(drivers, engine, n, [{ kind: 'create-table' as const, table }], null);
      }
    });
    after(async () => {
      for (const engine of ENGINES) for (const n of names(engine)) await dropDatabase(drivers, engine, n).catch(() => {});
    });
    for (const engine of ENGINES) {
      it(`one at a time, both still answer, again and again (${engine})`, async () => {
        const one: Drivers = engine === 'postgres'
          ? { postgres: createPgDriver(e.postgres, undefined, { maxOpen: 1 }) }
          : { mariadb: createMariaDriver(e.mariadb, undefined, { maxOpen: 1 }) };
        const openOn = (n: string) => Number(e.pgSuper(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${n}' AND application_name = 'pammy-studio'`));
        const before = engine === 'postgres' ? openOn(names(engine)[0]!) : 0;   // the other driver's, from before()
        try {
          for (let round = 0; round < 3; round++) {
            for (const n of names(engine)) {
              await insertRow(one, engine, n, 'notes', { body: `r${round}` }, ['id']);
              const page = await listRows(one, engine, n, { table: 'notes', columns: ['id'], limit: 10, offset: 0 });
              assert.equal(page.total, round + 1, `${n} round ${round}`);
            }
          }
          if (engine === 'postgres') {
            // the put-away pool lets go of its connections: only the last one is still open
            await new Promise((r) => setTimeout(r, 300));
            assert.equal(openOn(names(engine)[0]!), before, 'the first database\'s pool is closed');
            assert.ok(openOn(names(engine)[1]!) > 0, 'the last one is open');
          }
        } finally {
          await one[engine]!.close();
        }
      });
    }
  });

  // main.ts is the file systemd runs, so it gets started for real here: a typo in
  // it would otherwise only show up on the live server.
  // docs/db-examples-plan.md: each example on each engine, because her copy
  // can be either -- made, seeded without ids, and the engine's counter carries
  // on after the sample rows (X4)
  // docs/comments-plan.md C8-C11, A3: the tables the comments switches draw,
  // made for real, and the writes the gate makes into them
  describe('the comments tables', () => {
    for (const engine of ENGINES) {
      it(`are made, keep one thread per thing, take a moment in the engine's own form, and refuse a link to nothing (${engine})`, async () => {
        const name = `t_${engine}_comments`;
        await createDatabase(drivers, engine, name);
        try {
          const before = await introspect(drivers, engine, name);
          const drawn = withCommentLink({ engine, database: name, tables: [starterTable('posts')], notes: [] }, 'posts');
          const done = await applySchema(drivers, engine, name, diff(before, drawn), before.hash);
          assert.equal(done.failed, null, JSON.stringify(done.failed));
          const post = await insertRow(drivers, engine, name, 'posts', {}, ['id']);
          const thread = await insertRow(drivers, engine, name, 'comment_threads', { area: 'blog-comments', content_type: 'posts', content_id: String(post.row.id) }, ['id']);
          await assert.rejects(insertRow(drivers, engine, name, 'comment_threads', { area: 'blog-comments', content_type: 'posts', content_id: String(post.row.id) }, ['id']),
            (e: unknown) => e instanceof PammyDbError && e.code === 'conflict', 'one conversation per thing');
          const when = momentFor(engine, 1_790_000_000);
          const c = await insertRow(drivers, engine, name, 'comments', { thread_id: thread.row.id as number, author: 'Rose', body: 'Hi', approved: true, sent_at: when, response_id: 7 }, ['id', 'sent_at']);
          // the same moment back, however the engine hands it over (a Date, or MariaDB's UTC text)
          const back = c.row.sent_at instanceof Date ? c.row.sent_at : new Date(`${String(c.row.sent_at).replace(' ', 'T')}Z`);
          assert.equal(back.getTime(), 1_790_000_000_000, `stored ${String(c.row.sent_at)}`);
          await assert.rejects(insertRow(drivers, engine, name, 'comments', { thread_id: thread.row.id as number, approved: false, response_id: 7 }, ['id']),
            (e: unknown) => e instanceof PammyDbError && e.code === 'conflict', 'a response is one comment');
          await insertRow(drivers, engine, name, 'post_comment_threads', { post_id: post.row.id as number, thread_id: thread.row.id as number }, ['id']);
          await assert.rejects(insertRow(drivers, engine, name, 'post_comment_threads', { post_id: 999999, thread_id: thread.row.id as number }, ['id']),
            (e: unknown) => e instanceof PammyDbError && e.code === 'conflict', 'no link to a post that is not there');
          // delete the thread and its comments go with it (and its link)
          await deleteRow(drivers, engine, name, 'comment_threads', { id: thread.row.id as number });
          assert.equal((await listRows(drivers, engine, name, { table: 'comments', columns: ['id'], limit: 5, offset: 0, filters: [] } as never)).total, 0);
        } finally {
          await dropDatabase(drivers, engine, name).catch(() => {});
        }
      });
    }
  });

  describe('the database examples', () => {
    for (const kind of DB_EXAMPLE_KINDS) {
      for (const engine of ENGINES) {
        it(`${kind} on ${engine}: made, seeded, and a new row after them gets a new id`, async () => {
          const ex = DB_EXAMPLES[kind];
          const name = `t_${engine}_ex_${kind}`;
          await createDatabase(drivers, engine, name);
          try {
            const before = await introspect(drivers, engine, name);
            const done = await applySchema(drivers, engine, name, diff(before, exampleSnapshot(ex, engine, name)), before.hash);
            assert.equal(done.failed, null, JSON.stringify(done.failed));
            const after = await introspect(drivers, engine, name);
            assert.deepEqual(diff(after, exampleSnapshot(ex, engine, name)), [], 'the database is exactly the drawing');
            const keyOf = (t: string) => after.tables.find((x) => x.name === t)!.primaryKey;
            const n = await seedExample(ex, 'pictures/', async (table, values) => {
              const key = keyOf(table);
              const got = await insertRow(drivers, engine, name, table, values, key);
              return key.length === 1 ? got.row[key[0]!] as never : null;
            });
            assert.equal(n, ex.rows.length);
            const main = kind === 'recipes' ? 'recipes' : 'posts';
            const all = await listRows(drivers, engine, name, { table: main, columns: ['id'], limit: 100, offset: 0, filters: [] } as never);
            const top = Math.max(...all.items.map((r) => Number(r.id)));
            const values = kind === 'recipes' ? { title: 'Mine' } : { title: 'Mine', slug: 'mine' };
            const mine = await insertRow(drivers, engine, name, main, values, ['id']);
            assert.ok(Number(mine.row.id) > top, `the counter carried on: ${mine.row.id} after ${top}`);

            // the table's own rules, said in her words -- what a form saving
            // into it, or the app's own page, shows (docs/form-to-database-plan.md F10)
            const tag = kind === 'recipes' ? 'tags' : 'topics';
            const taken = (await listRows(drivers, engine, name, { table: tag, columns: ['name'], limit: 1, offset: 0, filters: [] } as never)).items[0]!.name;
            await assert.rejects(insertRow(drivers, engine, name, tag, { name: taken as string }, ['id']),
              (e: unknown) => e instanceof PammyDbError && e.code === 'conflict' && e.message.includes(`"${taken}", and it has to be different for every record`));
            await assert.rejects(insertRow(drivers, engine, name, tag, { name: null }, ['id']),
              (e: unknown) => e instanceof PammyDbError && e.code === 'invalid' && /^name has to be filled in/.test(e.message));

            // docs/record-picker-plan.md R12: a record's many-to-many, replaced in one go
            const [junction, here, there, others] = kind === 'recipes'
              ? ['recipe_tags', 'recipe_id', 'tag_id', 'tags'] : ['post_topics', 'post_id', 'topic_id', 'topics'];
            const choices = (await listRows(drivers, engine, name, { table: others, columns: ['id'], limit: 100, offset: 0, filters: [] } as never)).items.map((x) => Number(x.id));
            const pairsOf = async () => (await listRows(drivers, engine, name,
              { table: junction, columns: [there], limit: 100, offset: 0, order: { column: there, dir: 'asc' }, filters: [{ kind: 'equals', column: here, value: mine.row.id }] } as never))
              .items.map((x) => Number(x[there]));
            await setLinks(drivers, engine, name, { table: junction, here, id: mine.row.id, there, ids: [choices[0], choices[1]] });
            assert.deepEqual(await pairsOf(), [choices[0], choices[1]].sort((x, y) => x! - y!));
            // one kept, one dropped, one added; a pair already there is not an error
            await setLinks(drivers, engine, name, { table: junction, here, id: mine.row.id, there, ids: [choices[1], choices[2]] });
            assert.deepEqual(await pairsOf(), [choices[1], choices[2]].sort((x, y) => x! - y!));
            // an id that is not there is refused -- and the choices before it are still there
            await assert.rejects(setLinks(drivers, engine, name, { table: junction, here, id: mine.row.id, there, ids: [choices[0], 999_999] }));
            assert.deepEqual(await pairsOf(), [choices[1], choices[2]].sort((x, y) => x! - y!), 'all or nothing');
            await setLinks(drivers, engine, name, { table: junction, here, id: mine.row.id, there, ids: [] });
            assert.deepEqual(await pairsOf(), []);
          } finally {
            await dropDatabase(drivers, engine, name).catch(() => {});
          }
        });
      }
    }
  });

  describe('the process systemd starts', () => {
    const MAIN = join(import.meta.dirname, '..', 'src', 'pammydb', 'main.ts');
    const run = (env: Record<string, string>) =>
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

    it('listens on the socket it is given and answers for both engines', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pammydb-main-'));
      const sock = join(dir, 'pammydb.sock');
      const child = run({
        PAMMYDB_SOCKET: sock,
        PAMMYDB_POSTGRES_PORT: String(e.postgres.port),
        PAMMYDB_MARIADB_PORT: String(e.mariadb.port),
        PAMMYDB_POSTGRES_PASSWORD: e.postgres.password,
        PAMMYDB_MARIADB_PASSWORD: e.mariadb.password,
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
      try {
        for (let i = 0; !existsSync(sock); i++) {
          assert.ok(i < 400, `it never listened: ${out}`);
          await new Promise((r) => setTimeout(r, 25));
        }
        const r = await callPammyDb<{ databases: DatabaseFacts[]; engines: { engine: string; ok: boolean }[] }>(sock, { op: 'list-databases', actor: 'test' });
        assert.deepEqual(r.engines.map((x) => [x.engine, x.ok]), [['mariadb', true], ['postgres', true]]);
        assert.ok(r.databases.some((d) => d.name === 'pamela'));
        // it says where it connected, so the journal shows which engines it used
        assert.match(out, /pammy-pammydb: postgres 127\.0\.0\.1:\d+, mariadb 127\.0\.0\.1:\d+, as pammy_studio/);
        // and it puts itself away on SIGTERM rather than being killed
        child.kill('SIGTERM');
        const [status] = await once(child, 'exit') as [number | null];
        assert.equal(status, 0);
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('will not start against the panel\'s own database or the host\'s (S7)', async () => {
      for (const port of FORBIDDEN_PORTS) {
        const child = run({ PAMMYDB_SOCKET: '/nonexistent/pammydb.sock', PAMMYDB_POSTGRES_PORT: String(port), PAMMYDB_POSTGRES_PASSWORD: 'x', PAMMYDB_MARIADB_PASSWORD: 'x' });
        let err = '';
        child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
        const [status] = await once(child, 'exit') as [number | null];
        assert.equal(status, 2, `exit code for port ${port}`);
        assert.match(err, new RegExp(`refusing to use port ${port}`));
      }
      // not vacuous: with her real port it gets past the check and fails later,
      // on the socket it was given
      const child = run({ PAMMYDB_SOCKET: '/nonexistent/pammydb.sock', PAMMYDB_POSTGRES_PASSWORD: 'x', PAMMYDB_MARIADB_PASSWORD: 'x' });
      let err = '';
      child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
      await once(child, 'exit');
      assert.doesNotMatch(err, /refusing to use port/);
    });
  });
});
