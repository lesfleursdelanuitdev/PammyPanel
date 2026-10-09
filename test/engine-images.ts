// The engine images the tests start, read from the live containers' own Quadlet files, so a
// test can never be run on a version the server doesn't run (docs/ci-plan.md, T2). The tags
// are a series (postgres:17, mariadb:11.4): the live containers auto-update within it, and so
// does each user's podman when it pulls, so patch releases may differ for a while; the series
// can't. verify-lfdln.sh compares the running engines with these.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = join(import.meta.dirname, '..');

// Every Quadlet that runs Postgres or MariaDB on the server; they must agree per engine.
export const ENGINE_QUADLETS = {
  postgres: [
    'deploy/lfdln/appdb/quadlet/lfdln-appdb.container',
    'deploy/lfdln/pg/quadlet/lfdln-pg.container',
    'deploy/pg/quadlet/pammy-pg.container',
    '../no-sudo/quadlet/pammydb-postgres.container',
  ],
  mariadb: [
    'deploy/lfdln/appmaria/quadlet/lfdln-appmaria.container',
    '../no-sudo/quadlet/pammydb-mariadb.container',
  ],
} as const;

export type EngineName = keyof typeof ENGINE_QUADLETS;

export function imageOf(quadlet: string): string {
  const m = /^Image=(\S+)$/m.exec(readFileSync(join(PANEL, quadlet), 'utf8'));
  if (!m) throw new Error(`${quadlet} has no Image= line`);
  return m[1]!;
}

// the first of each list is the one the lfdln apps' projects use (lfdln-appdb, lfdln-appmaria)
export const PG_IMAGE = imageOf(ENGINE_QUADLETS.postgres[0]);
export const MARIA_IMAGE = imageOf(ENGINE_QUADLETS.mariadb[0]);
