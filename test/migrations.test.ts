// Where the migrations are and the order they run in (docs/packaging-plan.md
// step 3), without a database: test/pg.test.ts runs them against Postgres.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { migrationFiles, migrationSources, MIGRATIONS_DIR, packageOrder, PACKAGES_DIR } from '@panel/core/pg-migrate';

const temps: string[] = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// a packages/ folder: { name: [its @panel deps, { migration file: sql }] }
function packages(spec: Record<string, [string[], Record<string, string>?]>) {
  const root = mkdtempSync(join(tmpdir(), 'pammy-packages-'));
  temps.push(root);
  for (const [name, [deps, migrations]] of Object.entries(spec)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({
      name: `@panel/${name}`, dependencies: Object.fromEntries(deps.map((d) => [`@panel/${d}`, '*'])),
    }));
    if (migrations) {
      mkdirSync(join(root, name, 'migrations'));
      for (const [file, sql] of Object.entries(migrations)) writeFileSync(join(root, name, 'migrations', file), sql);
    }
  }
  return root;
}
const baseline = () => {
  const d = mkdtempSync(join(tmpdir(), 'pammy-baseline-'));
  temps.push(d);
  writeFileSync(join(d, '0001-panel.sql'), 'SELECT 1;');
  return d;
};

describe('migrations: where they are and their order (step 3)', () => {
  it('the baseline is closed: db/migrations is 0001-0018 and nothing more', () => {
    // A new migration goes in the package that owns it (packages/<name>/migrations).
    assert.deepEqual(readdirSync(MIGRATIONS_DIR).sort(), [
      '0001-panel.sql', '0002-media.sql', '0003-gate.sql', '0004-studio.sql', '0005-studio-users.sql',
      '0006-studio-drafts.sql', '0007-studio-layouts.sql', '0008-studio-resources.sql', '0009-studio-api.sql',
      '0010-db-examples.sql', '0011-field-order.sql', '0012-form-links.sql', '0013-comments.sql',
      '0014-visitors.sql', '0015-save-state.sql', '0016-drop-media-notes.sql', '0017-getting-started.sql',
      '0018-mail-notices.sql',
    ]);
  });

  it('the real packages come in dependency order, core first', () => {
    const order = packageOrder();
    assert.equal(order[0], 'core');
    assert.deepEqual([...order].sort(), readdirSync(PACKAGES_DIR).sort());
    // each package after everything its package.json names
    const at = new Map(order.map((n, i) => [n, i]));
    for (const name of order) {
      const pkg = JSON.parse(readFileSync(join(PACKAGES_DIR, name, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      for (const d of Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@panel/'))) {
        assert.ok(at.get(d.slice(7))! < at.get(name)!, `${name} comes before ${d}`);
      }
    }
  });

  it('the baseline first, then each package after its dependencies, recorded as <package>/<file>', () => {
    const root = packages({
      zeta: [['core'], { '0001-z.sql': 'SELECT 1;' }],
      alpha: [['zeta', 'core'], { '0002-b.sql': 'SELECT 2;', '0001-a.sql': 'SELECT 1;' }],
      core: [[]],                                   // no migrations/ folder: nothing from it
      beta: [['core'], { '0001-b.sql': 'SELECT 1;' }],
    });
    assert.deepEqual(packageOrder(root), ['core', 'zeta', 'alpha', 'beta']);
    assert.deepEqual(migrationSources(baseline(), root).map((s) => s.prefix), ['', 'zeta/', 'alpha/', 'beta/']);
    assert.deepEqual(migrationFiles(migrationSources(baseline(), root)).map((f) => f.name),
      ['0001-panel.sql', 'zeta/0001-z.sql', 'alpha/0001-a.sql', 'alpha/0002-b.sql', 'beta/0001-b.sql']);
  });

  it('refuses a badly named file, a loop, and a dependency that is not there', () => {
    assert.throws(() => migrationFiles(migrationSources(baseline(), packages({ core: [[], { 'x.sql': '' }] }))),
      /must be named NNNN-name.sql: core\/x.sql/);
    assert.throws(() => packageOrder(packages({ a: [['b']], b: [['a']] })), /loop: a -> b -> a/);
    assert.throws(() => packageOrder(packages({ a: [['nope']] })), /a depends on @panel\/nope/);
  });

  it('the panel as it is: the baseline, then the core\'s own, the catalog\'s and the studio\'s (step 4: the studio needs the catalog), the areas module\'s, Help\'s (first steps), the hosts module\'s, monitoring\'s and the projects\' git tokens (docs/permissions-plan.md R8, R9; docs/accounts-plan.md step 1; docs/roles-plan.md steps 2-5; docs/hosts-plan.md H1; docs/domains-hosts-plan.md step 7; docs/catalog-plan.md step 2; docs/monitoring-plan.md; docs/lfdln-mariadb-plan.md B3; docs/phase9-plan.md 9-3; docs/phase8b-plan.md 8b-7)', () => {
    const names = migrationFiles().map((f) => f.name);
    assert.equal(names.length, 44);
    assert.ok(names.slice(0, 18).every((n) => !n.includes('/')));
    assert.deepEqual(names.slice(18), ['core/0001-rights.sql', 'core/0002-drop-users-scope.sql', 'core/0003-software-places.sql', 'catalog/0001-catalog.sql', 'catalog/0002-drop-media.sql', 'catalog/0003-studio-sources.sql', 'catalog/0004-app-sources.sql', 'studio/0001-catalog-sources.sql', 'studio/0002-record-labels.sql', 'areas/0001-visitor-accounts.sql', 'areas/0002-roles.sql', 'areas/0003-privileges.sql', 'areas/0004-access.sql', 'areas/0005-route-areas.sql', 'areas/0006-account-deletions.sql', 'help/0001-first-steps.sql', 'hosts/0001-hosts.sql', 'hosts/0002-adopt.sql', 'hosts/0003-route-areas.sql', 'hosts/0004-domains.sql', 'hosts/0005-target-kinds.sql', 'hosts/0006-domain-hosts.sql', 'monitoring/0001-monitoring.sql', 'monitoring/0002-monitoring-records.sql', 'projects/0001-git-tokens.sql', 'services/0001-backup-settings.sql']);
  });
});
