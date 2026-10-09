// The panel's Postgres, build step 2 (docs/postgres-plan.md): the baseline
// migrations (db/migrations), the migration runner (src/pg-migrate.ts) and the
// connection helpers (src/pg.ts), against a throwaway container (pg-harness.ts).
//
// The schema they make is db/schema.snapshot.sql (tools/schema-snapshot.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkSchema, isTx, pgCode, SchemaMismatch, TX_ATTEMPTS, tx, type Sql } from '@panel/core/pg';
import { migrate, MigrationRefused, migrationSources, MIGRATIONS_DIR } from '@panel/core/pg-migrate';
import { normaliseDump, SNAPSHOT_FILE } from '../tools/schema-snapshot.ts';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let db: string;                 // a database with the migrations run
let owner: Sql, panel: Sql, gate: Sql;
const pools: Sql[] = [];
const open = (role: 'owner' | 'panel' | 'gate', database: string, max?: number) => {
  const s = pg.connect(role, database, max);
  pools.push(s);
  return s;
};
// a pool for one step, closed straight after (pammy_owner may only have 5 connections)
const withPg = async <T>(role: 'owner' | 'panel' | 'gate', database: string, fn: (s: Sql) => Promise<T>): Promise<T> => {
  const s = pg.connect(role, database, 1);
  try { return await fn(s); } finally { await s.end({ timeout: 2 }); }
};

before(async () => {
  pg = await startPg();
  db = pg.freshDatabase();
  owner = open('owner', db);
  await migrate(owner);
  panel = open('panel', db);
  gate = open('gate', db);
});
after(async () => {
  await Promise.all(pools.map((s) => s.end({ timeout: 2 })));
  pg?.stop();
});

// ------------------------------------------------------------------ the migrations
describe('migrations (P9)', () => {
  // a copy of db/migrations to change
  // The baseline and core's own migrations up to and including one: the database
  // as a release before a later core migration left it.
  const coreUpTo = (last: string) => {
    const d = mkdtempSync(join(tmpdir(), 'pammy-core-'));
    const core = migrationSources().find((m) => m.prefix === 'core/')!.dir;
    for (const n of readdirSync(core).filter((n) => n.endsWith('.sql') && n <= last)) cpSync(join(core, n), join(d, n));
    return [{ prefix: '', dir: MIGRATIONS_DIR }, { prefix: 'core/', dir: d }];
  };
  const copyDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'pammy-migrations-'));
    cpSync(MIGRATIONS_DIR, d, { recursive: true });
    return d;
  };

  it('run once each, in order, and a second run does nothing', async () => {
    await withPg('owner', pg.freshDatabase(), async (o) => {
      assert.deepEqual(await migrate(o), ['0001-panel.sql', '0002-media.sql', '0003-gate.sql', '0004-studio.sql', '0005-studio-users.sql', '0006-studio-drafts.sql', '0007-studio-layouts.sql', '0008-studio-resources.sql', '0009-studio-api.sql', '0010-db-examples.sql', '0011-field-order.sql', '0012-form-links.sql', '0013-comments.sql', '0014-visitors.sql', '0015-save-state.sql', '0016-drop-media-notes.sql', '0017-getting-started.sql', '0018-mail-notices.sql', 'core/0001-rights.sql', 'core/0002-drop-users-scope.sql', 'core/0003-software-places.sql', 'catalog/0001-catalog.sql', 'catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql', 'areas/0001-visitor-accounts.sql', 'areas/0002-roles.sql', 'areas/0003-privileges.sql', 'areas/0004-access.sql', 'areas/0005-route-areas.sql', 'areas/0006-account-deletions.sql', 'help/0001-first-steps.sql', 'hosts/0001-hosts.sql', 'hosts/0002-adopt.sql', 'hosts/0003-route-areas.sql', 'hosts/0004-domains.sql', 'hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql', 'monitoring/0001-monitoring.sql', 'monitoring/0002-monitoring-records.sql', 'projects/0001-git-tokens.sql', 'services/0001-backup-settings.sql']);
      assert.deepEqual(await migrate(o), []);
      const rows = await o`SELECT name, length(checksum) AS len FROM public.schema_migrations ORDER BY name`;
      assert.deepEqual(rows.map((r) => [r.name, r.len]),
        [['0001-panel.sql', 64], ['0002-media.sql', 64], ['0003-gate.sql', 64], ['0004-studio.sql', 64], ['0005-studio-users.sql', 64], ['0006-studio-drafts.sql', 64], ['0007-studio-layouts.sql', 64], ['0008-studio-resources.sql', 64], ['0009-studio-api.sql', 64], ['0010-db-examples.sql', 64], ['0011-field-order.sql', 64], ['0012-form-links.sql', 64], ['0013-comments.sql', 64], ['0014-visitors.sql', 64], ['0015-save-state.sql', 64], ['0016-drop-media-notes.sql', 64], ['0017-getting-started.sql', 64], ['0018-mail-notices.sql', 64], ['areas/0001-visitor-accounts.sql', 64], ['areas/0002-roles.sql', 64], ['areas/0003-privileges.sql', 64], ['areas/0004-access.sql', 64], ['areas/0005-route-areas.sql', 64], ['areas/0006-account-deletions.sql', 64], ['catalog/0001-catalog.sql', 64], ['catalog/0002-drop-media.sql', 64], ['catalog/0003-studio-sources.sql', 64], ['catalog/0004-app-sources.sql', 64], ['core/0001-rights.sql', 64], ['core/0002-drop-users-scope.sql', 64], ['core/0003-software-places.sql', 64], ['help/0001-first-steps.sql', 64], ['hosts/0001-hosts.sql', 64], ['hosts/0002-adopt.sql', 64], ['hosts/0003-route-areas.sql', 64], ['hosts/0004-domains.sql', 64], ['hosts/0005-target-kinds.sql', 64], ['hosts/0006-domain-hosts.sql', 64], ['monitoring/0001-monitoring.sql', 64], ['monitoring/0002-monitoring-records.sql', 64], ['projects/0001-git-tokens.sql', 64], ['services/0001-backup-settings.sql', 64], ['studio/0001-catalog-sources.sql', 64], ['studio/0002-record-labels.sql', 64]]);
    });
  });

  it('two installers at once: each migration still runs once', async () => {
    const fresh = pg.freshDatabase();
    const [a, b] = await Promise.all([withPg('owner', fresh, (o) => migrate(o)), withPg('owner', fresh, (o) => migrate(o))]);
    assert.deepEqual([...a, ...b].sort(), ['0001-panel.sql', '0002-media.sql', '0003-gate.sql', '0004-studio.sql', '0005-studio-users.sql', '0006-studio-drafts.sql', '0007-studio-layouts.sql', '0008-studio-resources.sql', '0009-studio-api.sql', '0010-db-examples.sql', '0011-field-order.sql', '0012-form-links.sql', '0013-comments.sql', '0014-visitors.sql', '0015-save-state.sql', '0016-drop-media-notes.sql', '0017-getting-started.sql', '0018-mail-notices.sql', 'areas/0001-visitor-accounts.sql', 'areas/0002-roles.sql', 'areas/0003-privileges.sql', 'areas/0004-access.sql', 'areas/0005-route-areas.sql', 'areas/0006-account-deletions.sql', 'catalog/0001-catalog.sql', 'catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'core/0001-rights.sql', 'core/0002-drop-users-scope.sql', 'core/0003-software-places.sql', 'help/0001-first-steps.sql', 'hosts/0001-hosts.sql', 'hosts/0002-adopt.sql', 'hosts/0003-route-areas.sql', 'hosts/0004-domains.sql', 'hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql', 'monitoring/0001-monitoring.sql', 'monitoring/0002-monitoring-records.sql', 'projects/0001-git-tokens.sql', 'services/0001-backup-settings.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql']);
  });

  it('a migration that fails leaves nothing behind, and the ones before it stay', async () => {
    const d = copyDir();
    writeFileSync(join(d, '0005-broken.sql'), 'CREATE TABLE panel.half_made (id int); SELECT 1/0;');
    await withPg('owner', pg.freshDatabase(), async (o) => {
      await assert.rejects(migrate(o, d), /division by zero/);
      assert.equal((await o`SELECT count(*) AS n FROM public.schema_migrations`)[0]!.n, 4);
      assert.equal((await o`SELECT to_regclass('panel.half_made') AS t`)[0]!.t, null);
    });
    rmSync(d, { recursive: true });
  });

  it('refuses a file changed after it ran, one slotted in before the last, and a database newer than the files', async () => {
    // the copy of the baseline, with the packages' own as they are (the database has run those too)
    const d = copyDir();
    writeFileSync(join(d, '0002-media.sql'), '-- changed\n', { flag: 'a' });
    await assert.rejects(migrate(owner, migrationSources(d)), (e) => e instanceof MigrationRefused && /0002-media.sql was changed/.test(e.message));
    rmSync(d, { recursive: true });

    const d2 = copyDir();
    writeFileSync(join(d2, '0002-a-late-one.sql'), 'SELECT 1;');
    await assert.rejects(migrate(owner, migrationSources(d2)), (e) => e instanceof MigrationRefused && /add new migrations at the end/.test(e.message));
    rmSync(d2, { recursive: true });

    const d3 = copyDir();
    rmSync(join(d3, '0003-gate.sql'));
    await assert.rejects(migrate(owner, migrationSources(d3)), (e) => e instanceof MigrationRefused && /older than the database/.test(e.message));
    rmSync(d3, { recursive: true });

    const d4 = copyDir();
    writeFileSync(join(d4, 'not-numbered.sql'), 'SELECT 1;');
    await assert.rejects(migrate(owner, migrationSources(d4)), /must be named NNNN-name.sql/);
    rmSync(d4, { recursive: true });
  });

  it("a package's own migrations run after the baseline, and are checked in their own folder (step 3)", async () => {
    const pkg = mkdtempSync(join(tmpdir(), 'pammy-pkg-migrations-'));
    const sources = [{ prefix: '', dir: MIGRATIONS_DIR }, { prefix: 'forms/', dir: pkg }];
    // it may use what the baseline made: the baseline has run by then
    writeFileSync(join(pkg, '0001-extra.sql'), 'CREATE TABLE gate.forms_extra (form_id bigint REFERENCES gate.forms(id));');
    const fresh = pg.freshDatabase();
    await withPg('owner', fresh, async (o) => {
      const ran = await migrate(o, sources);
      assert.equal(ran.length, 19);
      assert.equal(ran.at(-1), 'forms/0001-extra.sql');
      assert.notEqual((await o`SELECT to_regclass('gate.forms_extra') AS t`)[0]!.t, null);
      await withPg('panel', fresh, (p) => checkSchema(p, sources));
      // the baseline's services, which don't know it, are told the database is newer
      await withPg('panel', fresh, (p) => assert.rejects(checkSchema(p, MIGRATIONS_DIR),
        (e) => e instanceof SchemaMismatch && /forms\/0001-extra.sql/.test(e.message)));

      writeFileSync(join(pkg, '0002-more.sql'), 'ALTER TABLE gate.forms_extra ADD COLUMN note text;');
      assert.deepEqual(await migrate(o, sources), ['forms/0002-more.sql']);
      // 0000 sorts before the baseline's 0018 too, but only its own folder counts
      writeFileSync(join(pkg, '0000-early.sql'), 'SELECT 1;');
      await assert.rejects(migrate(o, sources), (e) => e instanceof MigrationRefused
        && /forms\/0000-early.sql sort before forms\/0002-more.sql/.test(e.message));
    });
    rmSync(pkg, { recursive: true });
  });

  it('core 0001 writes today\'s accounts the new way, each with what it could reach (permissions-plan R8)', async () => {
    await withPg('owner', pg.freshDatabase(), async (o) => {
      await migrate(o, MIGRATIONS_DIR);           // the database as it was: the baseline only
      await o.unsafe(`
        INSERT INTO panel.users (username, display_name, role, webauthn_user_id, created_at, scope) VALUES
          ('boss', 'Boss', 'manager', 'a', 1, NULL), ('helper', 'Helper', 'member', 'b', 1, NULL),
          ('olivia', 'Olivia', 'member', 'c', 1, '/olivia'), ('gone', 'Gone', 'member', 'd', 1, NULL)`).simple();
      await o.unsafe("UPDATE panel.users SET active = 0 WHERE username = 'gone'").simple();
      assert.deepEqual(await migrate(o, coreUpTo('0001-rights.sql')), ['core/0001-rights.sql']);
      const rows = await o`SELECT u.username,
          ARRAY(SELECT name FROM panel.user_rights r WHERE r.user_id = u.id ORDER BY name) AS rights,
          ARRAY(SELECT place FROM panel.user_places p WHERE p.user_id = u.id ORDER BY place) AS places
        FROM panel.users u ORDER BY u.username`;
      const member = ['comments', 'files', 'forms', 'media', 'protected', 'responses', 'subdomains'];
      assert.deepEqual(rows.map((r) => [r.username, r.rights, r.places]), [
        ['boss', [], []],                                              // an account manager needs none
        ['gone', member, []],                                          // switched off, but what it had is kept
        ['helper', member, []],
        ['olivia', ['comments', 'files', 'forms', 'media', 'responses'], ['/olivia']],
      ]);
      // users.scope is still there, as it was, until core 0002 (R9)
      assert.equal((await o`SELECT scope FROM panel.users WHERE username = 'olivia'`)[0]!.scope, '/olivia');
      // a place is a folder at the top, never the whole site; a right is a name
      await assert.rejects(o`INSERT INTO panel.user_places (user_id, place) SELECT id, '/' FROM panel.users WHERE username = 'helper'`, /check/);
      await assert.rejects(o`INSERT INTO panel.user_places (user_id, place) SELECT id, '/a/b' FROM panel.users WHERE username = 'helper'`, /check/);
      await assert.rejects(o`INSERT INTO panel.user_places (user_id, place) SELECT id, '/.git' FROM panel.users WHERE username = 'helper'`, /check/);
      await assert.rejects(o`INSERT INTO panel.user_rights (user_id, name) SELECT id, 'Files; x' FROM panel.users WHERE username = 'helper'`, /check/);
      // and they go with the account
      await o`DELETE FROM panel.users WHERE username = 'olivia'`;
      assert.equal((await o`SELECT count(*) AS n FROM panel.user_places`)[0]!.n, 0);
    });
  });

  it('core 0002 drops users.scope, and refuses while a scope is not one of that person\'s places (permissions-plan R9)', async () => {
    const people = `
      INSERT INTO panel.users (username, display_name, role, webauthn_user_id, created_at, scope) VALUES
        ('helper', 'Helper', 'member', 'b', 1, NULL), ('olivia', 'Olivia', 'member', 'c', 1, '/olivia')`;
    // out of step: step 3 would never leave this, but the migration must not lose it
    await withPg('owner', pg.freshDatabase(), async (o) => {
      await migrate(o, coreUpTo('0001-rights.sql'));
      await o.unsafe(people).simple();
      await o`DELETE FROM panel.user_places`;
      await assert.rejects(migrate(o), /users\.scope says a place user_places does not have: olivia \/olivia/);
      assert.equal((await o`SELECT scope FROM panel.users WHERE username = 'olivia'`)[0]!.scope, '/olivia');
    });
    // in step: the column goes, and the places stay
    await withPg('owner', pg.freshDatabase(), async (o) => {
      await migrate(o, coreUpTo('0001-rights.sql'));
      await o.unsafe(people).simple();
      await o`INSERT INTO panel.user_places (user_id, place) SELECT id, '/olivia' FROM panel.users WHERE username = 'olivia'`;
      await o`INSERT INTO panel.user_places (user_id, place) SELECT id, '/recipes' FROM panel.users WHERE username = 'olivia'`;
      assert.deepEqual(await migrate(o), ['core/0002-drop-users-scope.sql', 'core/0003-software-places.sql', 'catalog/0001-catalog.sql', 'catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql', 'areas/0001-visitor-accounts.sql', 'areas/0002-roles.sql', 'areas/0003-privileges.sql', 'areas/0004-access.sql', 'areas/0005-route-areas.sql', 'areas/0006-account-deletions.sql', 'help/0001-first-steps.sql', 'hosts/0001-hosts.sql', 'hosts/0002-adopt.sql', 'hosts/0003-route-areas.sql', 'hosts/0004-domains.sql', 'hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql', 'monitoring/0001-monitoring.sql', 'monitoring/0002-monitoring-records.sql', 'projects/0001-git-tokens.sql', 'services/0001-backup-settings.sql']);
      assert.equal((await o`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'panel' AND table_name = 'users' AND column_name = 'scope'`)[0]!.n, 0);
      assert.deepEqual((await o`SELECT place FROM panel.user_places ORDER BY place`).map((r) => r.place), ['/olivia', '/recipes']);
    });
  });

  it('areas 0002 makes every grant Member of the built-in Protected folder set, and leaves grants read-only; 0003 drops it (roles-plan steps 2-3)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pammy-areas-'));
    cpSync(join(migrationSources().find((m) => m.prefix === 'areas/')!.dir, '0001-visitor-accounts.sql'), join(d, '0001-visitor-accounts.sql'));
    const core = migrationSources().find((m) => m.prefix === 'core/')!;
    const database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o, [{ prefix: '', dir: MIGRATIONS_DIR }, core, { prefix: 'areas/', dir: d }]);
      await o.unsafe(`
        INSERT INTO gate.areas (id, token, path, created_at) VALUES (1, 'ta', 'a', 1), (2, 'tb', 'b', 1);
        INSERT INTO gate.visitors (id, username, password_hash, created_at, password_changed_at) VALUES (1, 'jo', '', 1, 1), (2, 'al', '', 1, 1);
        INSERT INTO gate.grants (visitor_id, area_id, created_at) VALUES (1, 1, 5), (1, 2, 6), (2, 2, 7);`).simple();
      // as it was when step 2 went in: 0002 alone (0003 drops grants)
      cpSync(join(migrationSources().find((m) => m.prefix === 'areas/')!.dir, '0002-roles.sql'), join(d, '0002-roles.sql'));
      assert.deepEqual(await migrate(o, [{ prefix: '', dir: MIGRATIONS_DIR }, core, { prefix: 'areas/', dir: d }]), ['areas/0002-roles.sql']);
      const rows = await o`SELECT m.visitor_id, m.area_id, r.key, s.key AS set, m.created_at FROM gate.memberships m
        JOIN gate.roles r ON r.id = m.role_id JOIN gate.role_sets s ON s.id = m.role_set_id ORDER BY 1, 2`;
      assert.deepEqual(rows.map((r) => [r.visitor_id, r.area_id, r.key, r.set, r.created_at]),
        [[1, 1, 'member', 'protected-folder', 5], [1, 2, 'member', 'protected-folder', 6], [2, 2, 'member', 'protected-folder', 7]]);
    });
    await withPg('gate', database, async (g) => {
      assert.equal((await g`SELECT count(*) AS n FROM grants`)[0]!.n, 3);
      await assert.rejects(g`INSERT INTO grants (visitor_id, area_id, created_at) VALUES (2, 1, 1)`, /permission denied/);
      await assert.rejects(g`DELETE FROM grants`, /permission denied/);
      // deleting a person still takes their old grants with them
      await g`DELETE FROM visitors WHERE id = 1`;
      assert.equal((await g`SELECT count(*) AS n FROM grants`)[0]!.n, 1);
      assert.equal((await g`SELECT count(*) AS n FROM memberships`)[0]!.n, 1);
    });
    // then step 3: grants goes, the memberships stay
    await withPg('owner', database, async (o) => {
      assert.deepEqual(await migrate(o), ['catalog/0001-catalog.sql', 'catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql', 'areas/0003-privileges.sql', 'areas/0004-access.sql', 'areas/0005-route-areas.sql', 'areas/0006-account-deletions.sql', 'help/0001-first-steps.sql', 'hosts/0001-hosts.sql', 'hosts/0002-adopt.sql', 'hosts/0003-route-areas.sql', 'hosts/0004-domains.sql', 'hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql', 'monitoring/0001-monitoring.sql', 'monitoring/0002-monitoring-records.sql', 'projects/0001-git-tokens.sql', 'services/0001-backup-settings.sql']);
      assert.equal((await o`SELECT to_regclass('gate.grants') AS t`)[0]!.t, null);
      assert.equal((await o`SELECT count(*) AS n FROM gate.memberships`)[0]!.n, 1);
    });
    rmSync(d, { recursive: true });
  });

  it('0017 fills in which example a copy came from, from its activity line', async () => {
    const d = copyDir();
    // as the database was before 0017: it, and everything after it, not yet run
    for (const f of readdirSync(d)) if (f >= '0017') rmSync(join(d, f));
    await withPg('owner', pg.freshDatabase(), async (o) => {
      await migrate(o, d);
      await o.unsafe(`
        INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'my_recipes', 1), ('mariadb', 'our_blog', 1), ('postgres', 'plain', 1);
        INSERT INTO panel.activity (at, actor_label, action, target, detail) VALUES
          (1, 'pamela', 'database-example-copied', 'Postgres: my_recipes', 'from the recipe book example, with 14 sample rows; the page is kitchen/recipes.html'),
          (2, 'pamela', 'database-example-copied', 'MariaDB: our_blog', 'from the blog example; the page is blog.html'),
          (3, 'pamela', 'database-created', 'Postgres: plain', null)`).simple();
      await migrate(o);
      const rows = await o`SELECT name, copied_from, page, copied_rows FROM panel.studio_databases ORDER BY name`;
      assert.deepEqual(rows.map((r) => [r.name, r.copied_from, r.page, r.copied_rows]), [
        ['my_recipes', 'recipes', 'kitchen/recipes.html', true],
        ['our_blog', 'blog', 'blog.html', false],
        ['plain', null, null, false],
      ]);
    });
    rmSync(d, { recursive: true });
  });

  it('the services check the list on start and refuse a mismatch', async () => {
    await checkSchema(panel);
    await checkSchema(gate);
    const d = copyDir();
    writeFileSync(join(d, '0006-next.sql'), 'SELECT 1;');
    await assert.rejects(checkSchema(panel, d), (e) => e instanceof SchemaMismatch && /missing migrations 0006-next.sql/.test(e.message));
    rmSync(join(d, '0006-next.sql'));
    rmSync(join(d, '0003-gate.sql'));
    await assert.rejects(checkSchema(gate, d), (e) => e instanceof SchemaMismatch && /older than the database/.test(e.message));
    rmSync(d, { recursive: true });
    const empty = pg.freshDatabase();
    await withPg('panel', empty, (p) => assert.rejects(checkSchema(p), (e) => e instanceof SchemaMismatch && /no migrations yet/.test(e.message)));
  });

  it('hosts 0005 moves every route\'s own fields into target_ref, and the table renders byte for byte as before (docs/domains-hosts-plan.md step 2)', async () => {
    const { tableFrom } = await import('@panel/hosts/panel/routes/hosts');
    const { renderAll } = await import('@panel/hosts/render');
    const { hostsConfigOf } = await import('@panel/lfdln/hosts');
    const { PROFILE } = await import('@panel/lfdln/profile');
    const d = mkdtempSync(join(tmpdir(), 'pammy-hosts-'));
    const hostsDir = migrationSources().find((m) => m.prefix === 'hosts/')!.dir;
    for (const f of readdirSync(hostsDir)) if (f < '0005') cpSync(join(hostsDir, f), join(d, f));
    const sources = [...migrationSources().filter((m) => m.prefix !== 'hosts/'), { prefix: 'hosts/', dir: d }];
    const database = pg.freshDatabase();
    const old = {
      hosts: [{ name: 'shop', enabled: true }, { name: 'tutor', enabled: true }, { name: '@', enabled: true, withWww: true }],
      folders: [{ name: 'shop', runPhp: false }],
      routes: [
        { host: 'shop', path: '/', enabled: true, kind: 'folder', folder: 'shop', spa: true, headers: [{ name: 'X-Frame-Options', value: 'DENY' }], cacheForever: ['/assets/'] },
        { host: 'shop', path: '/old/', enabled: false, kind: 'redirect', to: 'https://example.com/new', status: 301, keepPath: true },
        { host: 'tutor', path: '/', enabled: true, kind: 'service', service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: 25, signInPaths: ['/api/auth/sign-in', '=/login'], accounts: { token: 'a'.repeat(32) } },
        { host: '@', path: '/', enabled: true, kind: 'redirect', to: 'https://example.org/x', status: 302, keepPath: false },
      ],
      services: [{ service: 'tutorstar', part: 'web', port: 3041 }],
    };
    await withPg('owner', database, async (o) => {
      await migrate(o, sources);
      await o.unsafe(`
        INSERT INTO panel.site_folders (id, name, run_php, created_at) OVERRIDING SYSTEM VALUE VALUES (1, 'shop', false, 1);
        INSERT INTO panel.hosts (id, name, with_www, created_at) OVERRIDING SYSTEM VALUE VALUES (1, 'shop', false, 1), (2, 'tutor', false, 1), (3, '@', true, 1);
        INSERT INTO panel.routes (host_id, path, kind, folder_id, spa, headers, cache_forever, created_at)
          VALUES (1, '/', 'folder', 1, true, '[{"name":"X-Frame-Options","value":"DENY"}]', '{/assets/}', 1);
        INSERT INTO panel.routes (host_id, path, kind, redirect_to, redirect_status, keep_path, enabled, created_at)
          VALUES (1, '/old/', 'redirect', 'https://example.com/new', 301, true, false, 1), (3, '/', 'redirect', 'https://example.org/x', 302, false, true, 1);
        INSERT INTO panel.routes (host_id, path, kind, service, service_part, websockets, max_body_mb, sign_in_paths, area_token, accounts, created_at)
          VALUES (2, '/', 'service', 'tutorstar', 'web', true, 25, '{/api/auth/sign-in,=/login}', '${'a'.repeat(32)}', 'open', 1);`).simple();
      assert.deepEqual(await migrate(o), ['hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql']);
      const refs = await o`SELECT path, target_kind, target_ref, folder_id FROM panel.routes ORDER BY host_id, path`;
      assert.deepEqual(refs.map((r) => [r.path, r.target_kind, r.target_ref, r.folder_id === null ? null : Number(r.folder_id)]), [
        ['/', 'folder', { spa: true, headers: [{ name: 'X-Frame-Options', value: 'DENY' }], cacheForever: ['/assets/'] }, 1],
        ['/old/', 'redirect', { to: 'https://example.com/new', status: 301, keepPath: true }, null],
        ['/', 'service', { service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: 25, signInPaths: ['/api/auth/sign-in', '=/login'] }, null],
        ['/', 'redirect', { to: 'https://example.org/x', status: 302, keepPath: false }, null],
      ]);
      await assert.rejects(o`INSERT INTO panel.routes (host_id, path, target_kind, target_ref, created_at) VALUES (1, '/a/', 'folder', '{}', 1)`, /routes_folder_check/);
      await assert.rejects(o`INSERT INTO panel.routes (host_id, path, target_kind, target_ref, created_at) VALUES (1, '/a/', 'Bad Kind', '{}', 1)`, /routes_target_kind_check/);
      await assert.rejects(o`INSERT INTO panel.routes (host_id, path, target_kind, target_ref, created_at) VALUES (1, '/a/', 'redirect', '[]', 1)`, /routes_target_ref_check/);
    });
    await withPg('panel', database, async (q) => {
      const t = await tableFrom(q, old.services);
      const cfg = { ...hostsConfigOf(PROFILE), dir: '/etc/nginx/lfdln-hosts' };
      const before = renderAll(cfg, old as never);
      const after = renderAll(cfg, t);
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
      for (const [f, text] of before) assert.equal(after.get(f), text, f);
    });
    rmSync(d, { recursive: true });
  });

  it('hosts 0006: a host\'s name is one per domain; a certificate for named hosts has its names, and only it (docs/domains-hosts-plan.md step 7)', async () => {
    const database = pg.freshDatabase();
    await withPg('owner', database, async (o) => {
      await migrate(o);
      await o.unsafe(`
        INSERT INTO panel.domains (id, name, home, dns, front, cert, tls, created_at) OVERRIDING SYSTEM VALUE
          VALUES (1, 'lesfleursdelanuit.com', true, 'dreamhost', 'direct', 'wildcard-dns', '{"cert":"/c","key":"/k"}', 1);
        INSERT INTO panel.domains (id, name, dns, front, cert, cert_names, tls, created_at) OVERRIDING SYSTEM VALUE
          VALUES (2, 'gonsalvesfamily.com', 'manual', 'direct', 'names', '{gonsalvesfamily.com,www.gonsalvesfamily.com}', '{"cert":"/c","key":"/k"}', 1);
        INSERT INTO panel.hosts (name, created_at) VALUES ('@', 1);
        INSERT INTO panel.hosts (name, domain_id, created_at) VALUES ('@', 2, 1);`).simple();
      const rows = await o`SELECT name, domain_id FROM panel.hosts ORDER BY domain_id`;
      assert.deepEqual(rows.map((r) => [r.name, Number(r.domain_id)]), [['@', 1], ['@', 2]]);
      await assert.rejects(o`INSERT INTO panel.hosts (name, domain_id, created_at) VALUES ('@', 2, 1)`, /hosts_domain_name_key/);
      await assert.rejects(o`INSERT INTO panel.hosts (name, created_at) VALUES ('@', 1)`, /hosts_domain_name_key/, 'the home domain, by the trigger');
      await assert.rejects(o`INSERT INTO panel.domains (name, dns, front, cert, tls, created_at) VALUES ('a.test', 'manual', 'direct', 'names', '{"cert":"/c","key":"/k"}', 1)`, /domains_names_cert_check/);
      await assert.rejects(o`INSERT INTO panel.domains (name, dns, front, cert, cert_names, tls, created_at) VALUES ('b.test', 'manual', 'direct', 'files', '{b.test}', '{"cert":"/c","key":"/k"}', 1)`, /domains_names_cert_check/);
      await assert.rejects(o`INSERT INTO panel.domains (name, dns, front, cert, tls, created_at) VALUES ('c.test', 'manual', 'direct', 'magic', '{"cert":"/c","key":"/k"}', 1)`, /domains_cert_check/);
    });
  });
});

// ------------------------------------------------------------------ the schema the migrations make
// db/schema.snapshot.sql (tools/schema-snapshot.ts): every table, column, key,
// index, check, trigger, function and right, as pg_dump prints them. verify-panel.sh
// checks the live database against the same file. After a new migration:
//   UPDATE_SCHEMA=1 node --test test/pg.test.ts
describe('the schema the migrations make', () => {
  it('is db/schema.snapshot.sql', () => {
    const got = normaliseDump(execFileSync('podman', ['exec', '-u', 'postgres', pg.name, 'pg_dump', '--schema-only', '-d', db], { encoding: 'utf8' }));
    if (process.env.UPDATE_SCHEMA === '1') writeFileSync(SNAPSHOT_FILE, got);
    assert.equal(got, readFileSync(SNAPSHOT_FILE, 'utf8'), 'the schema changed: if a new migration meant it to, UPDATE_SCHEMA=1 node --test test/pg.test.ts');
  });
  // lfdln's installer runs setup.sql on every install, after the migrations (2026-09-28: it
  // widened what catalog/0001 had narrowed, and verify-lfdln caught it)
  it('is still it after setup.sql runs again on the migrated database', () => {
    for (const file of ['deploy/pg/setup.sql', 'deploy/lfdln/pg/setup.sql']) {
      // from its \\connect on: the schemas and rights (before it: the roles and their passwords)
      const all = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const sql = all.slice(all.search(/^\\connect \w+$/m)).replace(/^\\connect \w+$/m, `\\connect ${db}`);
      assert.match(sql, new RegExp(`^\\\\connect ${db}$`, 'm'), file);
      pg.superSql(sql);
      const got = normaliseDump(execFileSync('podman', ['exec', '-u', 'postgres', pg.name, 'pg_dump', '--schema-only', '-d', db], { encoding: 'utf8' }));
      assert.equal(got, readFileSync(SNAPSHOT_FILE, 'utf8'), `${file} run again changed the schema`);
    }
  });
});

// ------------------------------------------------------------------ the same rows turned away
// Each case runs inside a transaction that's rolled back, on top of the same
// starting rows. ok: whether it's accepted; msg: what the refusal says.
// The media schema's own rules, on a database migrated up to just before the catalog took
// it over (catalog step 2 leaves it read-only; step 3 drops it). The same rules on the
// catalog's tables: test/media-db.test.ts and test/catalog-move.test.ts.
describe('checks and triggers refuse the rows they should (D5, D7, D10)', () => {
  const SEED = `
    INSERT INTO media (id, path, scope, kind, name, size, modified_at, added_at, how, changed_at) VALUES
      (1, 'olivia/media/images/a.jpg', '/olivia', 'images', 'a.jpg', 1, 1, 1, 'found', 1),
      (2, 'media/images/b.jpg', '/', 'images', 'b.jpg', 1, 1, 1, 'found', 1),
      (3, 'olivia/trips/c.jpg', '/olivia', 'images', 'c.jpg', 1, 1, 1, 'found', 1);
    INSERT INTO tags (id, scope, name, created_at) VALUES (1, '/', 'all', 1), (2, '/olivia', 'mine', 1), (3, '/olivia/trips', 'trip', 1), (4, '/bob', 'bob', 1);
    INSERT INTO categories (id, scope, name, created_at) VALUES (1, '/olivia', 'cat', 1);
    INSERT INTO media_tags (media_id, tag_id) VALUES (3, 3), (1, 2);
    INSERT INTO media_categories (media_id, category_id) VALUES (1, 1);`;
  const media = (path: string, scope: string, kind: string, name: string, extra = '') =>
    `INSERT INTO media (path, scope, kind, name, size, modified_at, added_at, how, changed_at${extra ? ', state' : ''}) VALUES ('${path}', '${scope}', '${kind}', '${name}', 1, 1, 1, 'found', 1${extra ? `, '${extra}'` : ''})`;
  const label = (table: string, scope: string, name: string) => `INSERT INTO ${table} (scope, name, created_at) VALUES ('${scope}', '${name}', 1)`;
  const CASES: [string, boolean, RegExp?][] = [
    [media('readme.txt', '/', 'files', 'readme.txt'), true],
    [media('olivia/index.html', '/olivia', 'pages', 'index.html'), true],
    [media('media/x.txt', '/', 'files', 'x.txt'), true],
    [media('media/x.txt', '/media', 'files', 'x.txt'), false],
    [media('olivia/media/images/x.jpg', '/', 'images', 'x.jpg'), false],
    [media('olivia/media/images/x.jpg', '/olivia', 'images', 'y.jpg'), false],
    [media('olivia/media/images/x.jpg', '/olivia', 'pictures', 'x.jpg'), false],
    [media('olivia/media/images/xa.jpg', '/olivia', 'images', 'a.jpg'), false],
    [media('olivia/media/images/a.jpg', '/olivia', 'images', 'a.jpg'), false],                  // one present record per path
    [media('olivia/media/images/a.jpg', '/olivia', 'images', 'a.jpg', 'missing'), true],
    [media('olivia/media/images/z.jpg', '/olivia', 'images', 'z.jpg', 'trashed'), false],      // trashed needs a trash_id
    ["UPDATE media SET state = 'trashed', trash_id = 'abc' WHERE id = 2", true],
    [label('tags', '/', 'dogs-2'), true],
    [label('tags', '/olivia/trips/2026', 'x'), true],
    [label('tags', 'olivia', 'x'), false],
    [label('tags', '/olivia/', 'x'), false],
    [label('tags', '//x', 'x'), false],
    [label('tags', '/a//b', 'x'), false],
    [label('tags', '/', 'Dogs'), false],
    [label('tags', '/', 'a b'), false],
    [label('tags', '/', ''), false],
    [label('tags', '/', 'x'.repeat(40)), true],
    [label('tags', '/', 'x'.repeat(41)), false],
    [label('tags', '/olivia', 'mine'), false],
    [label('categories', '/olivia', 'mine'), true],
    ['INSERT INTO scopes (path, automatic, created_at) VALUES (\'/x\', 2, 1)', false],
    ["INSERT INTO thumbs (media_id, hash, result, made_at) VALUES (1, 'h', 'other', 1)", false],
    ["INSERT INTO thumbs (media_id, hash, result, made_at) VALUES (1, 'h', 'icon', 1)", true],
    ['INSERT INTO media_tags (media_id, tag_id) VALUES (1, 4)', false, /a tag only goes on files in its own scope/],
    ['INSERT INTO media_tags (media_id, tag_id) VALUES (1, 3)', false, /a tag only goes on files in its own scope/],
    ['INSERT INTO media_tags (media_id, tag_id) VALUES (3, 2)', true],
    ['INSERT INTO media_tags (media_id, tag_id) VALUES (2, 1)', true],
    ['INSERT INTO media_categories (media_id, category_id) VALUES (2, 1)', false, /a category only goes on files in its own scope/],
    ['UPDATE media_tags SET tag_id = 4 WHERE media_id = 3', false, /a tag only goes on files in its own scope/],
    ["UPDATE tags SET scope = '/bob' WHERE id = 2", false, /files in another scope still have this label/],
    ["UPDATE categories SET scope = '/bob' WHERE id = 1", false, /files in another scope still have this label/],
    ["UPDATE tags SET scope = '/olivia' WHERE id = 3", true],
    ["UPDATE media SET path = 'bob/c.jpg', scope = '/bob' WHERE id = 3", false, /move the labels to the new scope first/],
    ["UPDATE media SET path = 'olivia/trips/2026/c.jpg' WHERE id = 3", true],
    ["UPDATE media SET path = 'olivia/c.jpg' WHERE id = 3", false, /move the labels to the new scope first/],
    ['DELETE FROM tags WHERE id = 2', true],
    ['DELETE FROM media WHERE id = 1', true],
    ['INSERT INTO media_tags (media_id, tag_id) VALUES (9, 1)', false],
  ];

  let pgm: string;
  let q: Sql;
  before(async () => {
    pgm = pg.freshDatabase();
    await withPg('owner', pgm, async (o) => {
      await migrate(o, migrationSources().filter((m) => m.prefix !== 'catalog/' && m.prefix !== 'studio/'));
      await o.unsafe(SEED).simple();
      // an identity doesn't move past ids given by hand: tell it
      for (const t of ['media.media', 'media.tags', 'media.categories']) await o`SELECT setval(pg_get_serial_sequence(${t}, 'id'), 100)`;
    });
    q = open('panel', pgm, 1);
  });
  const onPg = async (stmt: string): Promise<string | null> => {
    let error: string | null = null;
    await q.begin(async (t) => {
      await t.unsafe('SET LOCAL search_path = panel, media');
      try { await t.unsafe(stmt); } catch (e) { error = (e as Error).message; }
      throw new Error('roll back');
    }).catch((e) => { if (!error && (e as Error).message !== 'roll back') error = (e as Error).message; });
    return error;
  };

  for (const [stmt, ok, msg] of CASES) {
    it(`${ok ? 'accepts' : 'refuses'}: ${stmt.replace(/\s+/g, ' ').slice(0, 110)}`, async () => {
      const p = await onPg(stmt);
      assert.equal(p === null, ok, `Postgres: ${p}`);
      if (msg) assert.match(p!, msg);
    });
  }

  it('a folder whose name holds [ or * is only itself (SQLite\'s GLOB got this wrong)', async () => {
    const stmts = [
      media('a[b]/x.jpg', '/a[b]', 'images', 'x.jpg'),
      media('ab/y.jpg', '/ab', 'images', 'y.jpg'),
      label('tags', '/a[b]', 'odd'),
    ];
    await q.begin(async (t) => {
      await t.unsafe('SET LOCAL search_path = panel, media');
      for (const s of stmts) await t.unsafe(s);
      const [x] = await t`SELECT id FROM media WHERE path = 'a[b]/x.jpg'`;
      const [y] = await t`SELECT id FROM media WHERE path = 'ab/y.jpg'`;
      const [odd] = await t`SELECT id FROM tags WHERE name = 'odd'`;
      await t`INSERT INTO media_tags (media_id, tag_id) VALUES (${x!.id}, ${odd!.id})`;   // SQLite refused this one
      await assert.rejects(t.savepoint((s) => s`INSERT INTO media_tags (media_id, tag_id) VALUES (${y!.id}, ${odd!.id})`), /only goes on files in its own scope/);
      throw new Error('roll back');
    }).catch((e) => { if ((e as Error).message !== 'roll back') throw e; });
    assert.equal((await q`SELECT media.path_under('/a*', 'ab/c.jpg') AS u`)[0]!.u, false);
    assert.equal((await q`SELECT media.path_under('/a*', 'a*/c.jpg') AS u`)[0]!.u, true);
    assert.equal((await q`SELECT media.path_under('/', 'anything') AS u`)[0]!.u, true);
    assert.equal((await q`SELECT media.path_under('/olivia', 'olivia') AS u`)[0]!.u, true);
    assert.equal((await q`SELECT media.path_under('/olivia', 'olivias/x') AS u`)[0]!.u, false);
  });

  it('panel and gate CHECKs', async () => {
    for (const [q, stmt, ok] of [
      [panel, "INSERT INTO users (username, display_name, role, webauthn_user_id, created_at) VALUES ('x', 'X', 'admin', 'w1', 1)", false],
      [gate, "INSERT INTO requests (kind, created_at) VALUES ('other', 1)", false],
      [gate, "INSERT INTO requests (kind, created_at, status) VALUES ('access', 1, 'maybe')", false],
      [gate, "INSERT INTO api_keys (label, prefix, key_hash, level, forms, created_at) VALUES ('l', 'p', 'h', 'some', 'null', 1)", false],
      [gate, "INSERT INTO forms (name, title, items, settings, created_at, updated_at, fixture) VALUES ('a', 'A', '[]', '{}', 1, 1, 'rsvp'), ('b', 'B', '[]', '{}', 1, 1, 'rsvp')", false],
      [gate, "INSERT INTO forms (name, title, items, settings, created_at, updated_at) VALUES ('a', 'A', '[]', '{}', 1, 1), ('b', 'B', '[]', '{}', 1, 1)", true],
    ] as [Sql, string, boolean][]) {
      const r = await q.begin(async (t) => { await t.unsafe(stmt); throw new Error('roll back'); }).catch((e) => (e as Error).message);
      assert.equal(r === 'roll back', ok, `${stmt}: ${r}`);
    }
  });
});

// ------------------------------------------------------------------ who may do what (P5)
describe('the roles on the migrated tables', () => {
  it('each process writes its own schemas, with ids from the identity', async () => {
    const [u] = await panel`INSERT INTO users (username, display_name, role, webauthn_user_id, created_at) VALUES ('r1', 'R', 'member', 'wr1', 1) RETURNING id`;
    assert.equal(typeof u!.id, 'number');
    const m = await panel.begin(async (t) => {
      const [i] = await t`INSERT INTO items (resource_id, key, scope_id, kind, changed_at) VALUES (1, 'r.txt', (SELECT id FROM scopes WHERE path = '/'), 'files', 1) RETURNING id`;
      await t`INSERT INTO files (item_id, name, size, modified_at, added_at, how) VALUES (${i!.id}, 'r.txt', 1, 1, 1, 'found')`;
      return i!;
    });
    assert.equal(typeof m.id, 'number');
    const [a] = await gate`INSERT INTO areas (token, path, created_at) VALUES ('t-r1', 'r1', 1) RETURNING id`;
    assert.equal(typeof a!.id, 'number');
    await panel`DELETE FROM users WHERE id = ${u!.id}`;
    await panel`DELETE FROM items WHERE id = ${m.id}`;
    await gate`DELETE FROM areas WHERE id = ${a!.id}`;
  });

  it('neither reaches the other\'s tables, nor changes the migration list', async () => {
    const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return pgCode(e); } };
    assert.equal(await code(panel`SELECT 1 FROM gate.areas`), '42501');
    assert.equal(await code(gate`SELECT 1 FROM panel.users`), '42501');
    assert.equal(await code(gate`SELECT 1 FROM catalog.items`), '42501');
    assert.equal(await code(gate`SELECT catalog.path_under('/', 'x')`), '42501');
    assert.equal(await code(gate`SELECT 1 FROM files.files`), '42501');
    assert.equal(await code(panel`SELECT catalog.path_under('/', 'x')`), 'ok');
    // media's tables are gone since catalog step 3 (catalog/0002); its empty schema stays
    assert.equal(await code(panel`SELECT 1 FROM media.media`), '42P01');
    assert.equal(await code(panel`INSERT INTO public.schema_migrations (name, checksum) VALUES ('x', 'y')`), '42501');
    assert.equal(await code(gate`DELETE FROM public.schema_migrations`), '42501');
    assert.equal(await code(panel`CREATE TABLE panel.mine (id int)`), '42501');
    assert.equal(await code(panel`ALTER TABLE users ADD COLUMN x int`), '42501');
  });

  it('memberships: a role from the area\'s own set, one per person per area (roles-plan step 2)', async () => {
    const [a] = await gate`INSERT INTO areas (token, path, created_at) VALUES ('t-m1', 'm1', 1) RETURNING id, role_set_id`;
    const [pf] = await gate`SELECT id FROM role_sets WHERE key = 'protected-folder'`;
    assert.equal(a!.role_set_id, pf!.id);
    const [v] = await gate`INSERT INTO visitors (username, password_hash, created_at, password_changed_at) VALUES ('m1', '', 1, 1) RETURNING id`;
    const [other] = await gate`INSERT INTO role_sets (label, created_at) VALUES ('Other', 1) RETURNING id`;
    const [stranger] = await gate`INSERT INTO roles (role_set_id, key, label) VALUES (${other!.id}, 'x', 'X') RETURNING id`;
    const [member] = await gate`SELECT id FROM roles WHERE role_set_id = ${pf!.id} AND key = 'member'`;
    await assert.rejects(gate`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${v!.id}, ${a!.id}, ${pf!.id}, ${stranger!.id}, 1)`, /foreign key/);
    await assert.rejects(gate`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${v!.id}, ${a!.id}, ${other!.id}, ${stranger!.id}, 1)`, /foreign key/);
    await gate`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${v!.id}, ${a!.id}, ${pf!.id}, ${member!.id}, 1)`;
    await assert.rejects(gate`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${v!.id}, ${a!.id}, ${pf!.id}, ${member!.id}, 1)`, /duplicate key/);
    await assert.rejects(gate`INSERT INTO role_privileges (role_id, privilege) VALUES (${stranger!.id}, 'Pages.Read')`, /check/);
    await assert.rejects(gate`INSERT INTO role_privileges (role_id, privilege) VALUES (${stranger!.id}, 'pages.read:some')`, /check/);
    await gate`INSERT INTO role_privileges (role_id, privilege) VALUES (${stranger!.id}, 'progress.update:own')`;
    await gate`DELETE FROM areas WHERE id = ${a!.id}`;
    assert.equal((await gate`SELECT count(*) AS n FROM memberships WHERE visitor_id = ${v!.id}`)[0]!.n, 0);
    await gate`DELETE FROM visitors WHERE id = ${v!.id}`;
    await gate`DELETE FROM role_sets WHERE id = ${other!.id}`;
  });

  it('the owner can start a sequence past the highest id ever used, as a restore does (P7)', async () => {
    await owner`SELECT setval(pg_get_serial_sequence('gate.areas', 'id'), 41)`;
    const [a] = await gate`INSERT INTO areas (token, path, created_at) VALUES ('t-r2', 'r2', 1) RETURNING id`;
    assert.equal(a!.id, 42);
    await gate`DELETE FROM areas WHERE id = 42`;
  });
});

// ------------------------------------------------------------------ src/pg.ts
describe('pg.ts', () => {
  it('bigint and count(*) come back as numbers, bytea as bytes', async () => {
    const [r] = await panel`SELECT 9007199254740991::bigint AS big, count(*) AS n, 7::integer AS i, '\\x00ff10'::bytea AS b FROM users`;
    assert.equal(r!.big, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof r!.n, 'number');
    assert.equal(r!.i, 7);
    assert.ok(r!.b instanceof Uint8Array);
    assert.deepEqual([...r!.b], [0, 255, 16]);
    await assert.rejects(panel`SELECT 9007199254740993::bigint AS x`, /too large for a JS number/);
  });

  it('a passkey public key goes in and comes out byte for byte', async () => {
    const key = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 255);
    const [u] = await panel`INSERT INTO users (username, display_name, role, webauthn_user_id, created_at) VALUES ('pk', 'P', 'member', 'wpk', 1) RETURNING id`;
    await panel`INSERT INTO passkeys (user_id, credential_id, public_key, counter, name, created_at) VALUES (${u!.id}, 'cred', ${key}, 4294967295, 'phone', 1)`;
    const [p] = await panel`SELECT public_key, counter FROM passkeys WHERE credential_id = 'cred'`;
    assert.deepEqual(new Uint8Array(p!.public_key), key);
    assert.equal(p!.counter, 4294967295);
    await panel`DELETE FROM users WHERE id = ${u!.id}`;
  });

  it('tx inside tx joins the one already open', async () => {
    await tx(panel, async (q) => {
      assert.ok(isTx(q));
      const [a] = await q`SELECT txid_current() AS t`;
      await tx(q, async (q2) => {
        assert.equal(q2, q);
        assert.deepEqual((await q2`SELECT txid_current() AS t`)[0], a);
      });
      assert.equal((await q`SHOW transaction_isolation`)[0]!.transaction_isolation, 'serializable');
    });
  });

  it('two writers that race: one is retried, and both writes count', async () => {
    const w = open('panel', db, 4);
    await w`INSERT INTO sync_state (key, value) VALUES ('race', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`;
    let attempts = 0;
    let bothRead: () => void;
    const read = new Promise<void>((r) => { bothRead = r; });
    let readers = 0;
    const bump = () => tx(w, async (q) => {
      attempts++;
      const [r] = await q`SELECT value FROM sync_state WHERE key = 'race'`;
      if (attempts <= 2) { if (++readers === 2) bothRead(); await read; }   // first time round: both read before either writes
      await q`UPDATE sync_state SET value = ${String(Number(r!.value) + 1)} WHERE key = 'race'`;
    });
    await Promise.all([bump(), bump()]);
    assert.equal((await w`SELECT value FROM sync_state WHERE key = 'race'`)[0]!.value, '2');
    assert.ok(attempts >= 3, `attempts: ${attempts}`);
  });

  it('gives up after TX_ATTEMPTS, and never retries other errors', async () => {
    let n = 0;
    await assert.rejects(tx(panel, async (q) => {
      n++;
      await q`SELECT 1`;
      throw Object.assign(new Error('always loses'), {});
    }), /always loses/);
    assert.equal(n, 1);
    n = 0;
    await assert.rejects(tx(panel, async (q) => {
      n++;
      await q`DO $$ BEGIN RAISE EXCEPTION 'lost a race' USING ERRCODE = 'serialization_failure'; END $$`;
    }), (e) => pgCode(e) === '40001');
    assert.equal(n, TX_ATTEMPTS);
  });
});
