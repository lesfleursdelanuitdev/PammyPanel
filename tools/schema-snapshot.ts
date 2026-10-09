// The shape of the panel's Postgres as the migrations leave it (docs/refactor-plan.md
// phase 5): pg_dump --schema-only with what changes from one dump to the next taken
// out. db/schema.snapshot.sql is this for a fresh database with every migration run;
// test/pg.test.ts checks the migrations still make it, and verify-panel.sh checks the
// live database is it too -- so a migration is checked against Postgres itself.
//
//   pg_dump --schema-only -d pammy | node tools/schema-snapshot.ts
//
// After a new migration: UPDATE_SCHEMA=1 node --test test/pg.test.ts rewrites the file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SNAPSHOT_FILE = join(import.meta.dirname, '..', 'db', 'schema.snapshot.sql');

// Comments, blank lines, the session SETs at the top, and pg_dump 17's
// \restrict / \unrestrict lines (a random key each time) are not the schema.
export function normaliseDump(dump: string): string {
  return dump.split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('--') && !/^SET \w+ = /.test(l) && !l.startsWith('SELECT pg_catalog.set_config(')
      && !/^\\(un)?restrict /.test(l))
    .join('\n') + '\n';
}

if (import.meta.main) process.stdout.write(normaliseDump(readFileSync(0, 'utf8')));
