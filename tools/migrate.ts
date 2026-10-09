// Runs the panel's Postgres migrations (docs/postgres-plan.md P9), as pammy_owner.
// The installer calls it after taking a dump; by hand:
//
//   sudo node tools/migrate.ts [--password-file /etc/pammy-panel/db/owner.pass] [--port 5434] [--check]
//
// --check: only say whether anything would run (exit 0 up to date, 3 pending).
import { connectPg } from '@panel/core/pg';
import { migrate, migrationFiles, MigrationRefused, MIGRATIONS_TABLE } from '@panel/core/pg-migrate';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const passwordFile = opt('--password-file') ?? '/etc/pammy-panel/db/owner.pass';
const port = Number(opt('--port') ?? 5434);
const database = opt('--database') ?? 'pammy';

const sql = connectPg({ role: 'owner', passwordFile, port, database, max: 1, app: 'pammy-migrate' });
let code = 0;
try {
  if (args.includes('--check')) {
    const have = new Set((await sql.unsafe(`SELECT name FROM ${MIGRATIONS_TABLE}`).catch(() => [])).map((r) => r.name as string));
    const pending = migrationFiles().filter((f) => !have.has(f.name)).map((f) => f.name);
    console.log(pending.length ? `pending: ${pending.join(', ')}` : 'up to date');
    code = pending.length ? 3 : 0;
  } else {
    const ran = await migrate(sql, undefined, (s) => console.log(`  ok   ${s}`));
    if (!ran.length) console.log('  ok   migrations: up to date');
  }
} catch (e) {
  console.error(`  FAIL ${e instanceof MigrationRefused ? e.message : (e as Error).stack}`);
  code = 1;
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(code);
