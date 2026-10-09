// Migrations for the panel's Postgres (docs/postgres-plan.md P9), each run once,
// each in its own transaction, recorded in public.schema_migrations with its
// checksum. Files are appended, never edited or slotted in before the last one run
// from the same folder: either refuses.
//
// Where they are (docs/packaging-plan.md step 3):
// - db/migrations: the baseline, 0001-0018, recorded by file name. It is closed:
//   nothing is added to it any more (test/migrations.test.ts).
// - packages/<name>/migrations: a package's own, recorded as <name>/NNNN-x.sql.
//   They run after the baseline, packages in dependency order (a package after the
//   ones its package.json names), each package's own in name order.
//
// Only the installer runs them (tools/migrate.ts), as pammy_owner. The services
// just check the list (pg.ts checkSchema).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Sql } from './pg.ts';
import { appPath } from './paths.ts';

export const MIGRATIONS_DIR = appPath('db', 'migrations');
export const PACKAGES_DIR = appPath('packages');
export const MIGRATIONS_TABLE = 'public.schema_migrations';
const NAME_RE = /^\d{4}-[a-z0-9-]+\.sql$/;

// One folder of migrations; prefix '' is the baseline, 'forms/' a package's.
export type MigrationSource = { prefix: string; dir: string };
// A folder alone is the baseline's (the tests' copies of db/migrations).
export type Sources = string | MigrationSource[];

export type MigrationFile = { name: string; checksum: string; sql: string };

// The packages in dependency order: each after every @panel/* package its
// package.json depends on, ties by name, so the order never depends on the disk.
export function packageOrder(packagesDir = PACKAGES_DIR): string[] {
  const deps = new Map<string, string[]>();
  for (const name of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, name, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
    deps.set(name, Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@panel/')).map((d) => d.slice('@panel/'.length)));
  }
  const order: string[] = [], state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`packages depend on each other in a loop: ${[...path, name].join(' -> ')}`);
    if (!deps.has(name)) throw new Error(`${path.at(-1)} depends on @panel/${name}, which isn't in ${packagesDir}`);
    state.set(name, 'visiting');
    for (const d of [...deps.get(name)!].sort()) visit(d, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of deps.keys()) visit(name, []);
  return order;
}

// The baseline, then every package that has a migrations/ folder, in order.
export function migrationSources(baseline = MIGRATIONS_DIR, packagesDir = PACKAGES_DIR): MigrationSource[] {
  return [
    { prefix: '', dir: baseline },
    ...packageOrder(packagesDir)
      .map((name) => ({ prefix: `${name}/`, dir: join(packagesDir, name, 'migrations') }))
      .filter((s) => existsSync(s.dir)),
  ];
}

const toSources = (s?: Sources): MigrationSource[] =>
  s === undefined ? migrationSources() : typeof s === 'string' ? [{ prefix: '', dir: s }] : s;

// Every migration, in the order they run.
export function migrationFiles(sources?: Sources): MigrationFile[] {
  return toSources(sources).flatMap(({ prefix, dir }) => {
    const names = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
    const bad = names.filter((n) => !NAME_RE.test(n));
    if (bad.length) throw new Error(`migration files must be named NNNN-name.sql: ${bad.map((n) => prefix + n).join(', ')}`);
    return names.map((n) => {
      const sql = readFileSync(join(dir, n), 'utf8');
      return { name: prefix + n, checksum: createHash('sha256').update(sql).digest('hex'), sql };
    });
  });
}

export class MigrationRefused extends Error {}

// Runs what hasn't run. Returns the names it ran (empty: already up to date).
export async function migrate(sql: Sql, sources?: Sources, log: (s: string) => void = () => {}): Promise<string[]> {
  const files = migrationFiles(sources);
  const ran: string[] = [];
  await sql.begin(async (q) => {
    await lock(q);
    await q.unsafe(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      -- the services read the list on start (checkSchema), and nothing else here
      GRANT USAGE ON SCHEMA public TO pammy_panel, pammy_gate;
      GRANT SELECT ON ${MIGRATIONS_TABLE} TO pammy_panel, pammy_gate;
    `).simple();
  });
  const applied = await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM ${sql(MIGRATIONS_TABLE)} ORDER BY name`;
  check(files, applied);

  for (const f of files) {
    const done = await sql.begin(async (q) => {
      await lock(q);
      // someone else may have run it while we waited for the lock
      const [row] = await q<{ checksum: string }[]>`SELECT checksum FROM ${q(MIGRATIONS_TABLE)} WHERE name = ${f.name}`;
      if (row) {
        if (row.checksum !== f.checksum) throw new MigrationRefused(`${f.name} was changed after it ran`);
        return false;
      }
      // a migration waits at most this long for the services' locks, then fails whole
      await q`SET LOCAL lock_timeout = '10s'`;
      await q.unsafe(f.sql).simple();
      await q`INSERT INTO ${q(MIGRATIONS_TABLE)} (name, checksum) VALUES (${f.name}, ${f.checksum})`;
      return true;
    });
    if (done) { ran.push(f.name); log(`ran ${f.name}`); }
  }
  return ran;
}

// One migrator at a time, whatever else is connected.
async function lock(q: Db) {
  await q`SELECT pg_advisory_xact_lock(hashtext('pammy-migrate'))`;
}

function check(files: MigrationFile[], applied: { name: string; checksum: string }[]) {
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const a of applied) {
    const f = byName.get(a.name);
    if (!f) throw new MigrationRefused(`the database has ${a.name}, which these files don't: they are older than the database`);
    if (f.checksum !== a.checksum) throw new MigrationRefused(`${a.name} was changed after it ran`);
  }
  // each folder on its own: a package's first migration may come after the
  // baseline's last, but nothing may go in before what already ran from its folder
  const folder = (name: string) => name.slice(0, name.lastIndexOf('/') + 1);
  const done = new Set(applied.map((a) => a.name));
  const last = new Map<string, string>();
  for (const a of applied) if (a.name > (last.get(folder(a.name)) ?? '')) last.set(folder(a.name), a.name);
  const slotted = files.filter((f) => !done.has(f.name) && f.name < (last.get(folder(f.name)) ?? ''));
  if (slotted.length) {
    const before = [...new Set(slotted.map((f) => last.get(folder(f.name))!))].join(', ');
    throw new MigrationRefused(`${slotted.map((f) => f.name).join(', ')} sort before ${before}, which already ran: add new migrations at the end`);
  }
}
