// Where the studio helper is allowed to connect (docs/studio-plan.md S7), per site
// (docs/phase8-plan.md 8-4): each site's helper names its engines, the ports it must
// never reach, its login and its names (ident.ts NameRules). Nothing here falls back
// to another site's engines: a helper starts only with the site it is given.
//
// pammy.org: five database systems answer on 127.0.0.1 there -- her MariaDB (3307) and
// Postgres (5433), which are the studio's, the panel's own Postgres (5434), the host's
// Postgres (5432), and WordPress's MariaDB, which publishes no port at all.
// lfdln: one, lfdln-appdb (5436), beside the apps' own databases (P8-7, P8-8).
//
// The helper's sandbox allows loopback because it has to, so the endpoints are settled
// here and never come from a request: an op names an engine and a database, never a
// host or a port. The ports it must never reach are refused outright, so a mistyped
// unit fails to start instead of connecting to the wrong database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine, NameRules } from './ident.ts';
import type { MariaEndpoint } from './maria.ts';
import type { PgEndpoint } from './pg.ts';

export const HOST = '127.0.0.1';
export const STUDIO_USER = 'pammy_studio';

// A site's helper: its engines and their ports (a PAMMYDB_<ENGINE>_PORT may move one, never
// onto a forbidden port), the login it uses on them, and its names (ident.ts defaults when
// an engine names none).
export type HelperSite = {
  name: string;                                              // pammy-pammydb, in the log
  engines: Partial<Record<Engine, { port: number }>>;
  forbiddenPorts: number[];
  user?: string;
  rules?: Partial<Record<Engine, NameRules>>;
};

// pammy.org's: her two engines. 5432: the host's Postgres. 5434: the panel's own.
export const POSTGRES_PORT = 5433;
export const MARIADB_PORT = 3307;
export const FORBIDDEN_PORTS = [5432, 5434];
export const PAMMY_HELPER: HelperSite = {
  name: 'pammy-pammydb',
  engines: { postgres: { port: POSTGRES_PORT }, mariadb: { port: MARIADB_PORT } },
  forbiddenPorts: FORBIDDEN_PORTS,
};

export type HelperConfig = { site: HelperSite; postgres?: PgEndpoint; mariadb?: MariaEndpoint };

export function loadHelperConfig(env: NodeJS.ProcessEnv, site: HelperSite): HelperConfig {
  const out: HelperConfig = { site };
  const user = site.user ?? STUDIO_USER;
  if (site.engines.postgres) {
    out.postgres = { host: HOST, port: port(site, env.PAMMYDB_POSTGRES_PORT, site.engines.postgres.port, 'Postgres'), user: env.PAMMYDB_POSTGRES_USER || user, password: password(site, env, 'POSTGRES', 'studio-postgres.pass') };
  }
  if (site.engines.mariadb) {
    out.mariadb = { host: HOST, port: port(site, env.PAMMYDB_MARIADB_PORT, site.engines.mariadb.port, 'MariaDB'), user: env.PAMMYDB_MARIADB_USER || user, password: password(site, env, 'MARIADB', 'studio-mariadb.pass') };
  }
  return out;
}

function port(site: HelperSite, value: string | undefined, fallback: number, what: string): number {
  const n = value ? Number(value) : fallback;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${site.name}: ${what} port ${value} is not a port number`);
  if (site.forbiddenPorts.includes(n)) {
    throw new Error(`${site.name}: refusing to use port ${n} for ${what}: that is a panel's own database, or another site's, not this site's studio engine (studio-plan.md S7)`);
  }
  return n;
}

// systemd's LoadCredential= puts them in $CREDENTIALS_DIRECTORY; the tests pass
// a password straight in. The helper's user may not read the panel's settings.
function password(site: HelperSite, env: NodeJS.ProcessEnv, key: 'POSTGRES' | 'MARIADB', credential: string): string {
  const direct = env[`PAMMYDB_${key}_PASSWORD`];
  if (direct) return direct;
  const file = env[`PAMMYDB_${key}_PASSWORD_FILE`]
    ?? (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, credential) : undefined);
  if (!file) throw new Error(`${site.name}: no ${key} password (expected systemd LoadCredential=${credential} or PAMMYDB_${key}_PASSWORD_FILE)`);
  const pw = readFileSync(file, 'utf8').trim();
  if (!pw) throw new Error(`${site.name}: ${file} is empty`);
  return pw;
}
