// lfdln's Studio engines (docs/phase8-plan.md 8-4): lfdln-appdb, the Postgres the apps' databases
// were moved to (P8-7), and lfdln-appmaria, a MariaDB of the Studio's own with no apps on it
// (docs/lfdln-mariadb-plan.md M1, which reverses P8-8). The helper (helpers/pammydb.ts) starts
// with this and nothing else; the installer reads APP_DATABASES from here for the studio role's
// grants.
import type { HelperSite } from '@panel/studio/pammydb/config';

// The databases the apps own (P8-9, G8), each with the schema its tables are in: shown and read
// in the Studio, never changed. The studio role has SELECT on them and nothing more.
export const APP_DATABASES: Record<string, string> = {
  tutorstar: 'public',
  ligneous_frontend: 'public',
  examprep: 'prep',
};
// ...and the apps' logins (appdb/setup.sql, appdb/apps.sql): never made, changed or dropped here
const APP_LOGINS = ['tutorstar', 'ligneous_user', 'gonsalves_readonly', 'examprep_owner', 'examprep_app'];
const ENGINE_OWN = ['postgres', 'template0', 'template1'];
// MariaDB's own databases, and the accounts the engine and its image come with (M4)
const MARIA_OWN = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const MARIA_ACCOUNTS = ['root', 'mysql', 'mariadb.sys', 'healthcheck', 'mariadb', 'pammy_studio'];

export const APPDB_PORT = 5436;
export const APPMARIA_PORT = 3308;
// the logins the Studio makes here (P8-15): all start with this, it manages no other, and
// lfdln-appdb's pg_hba admits exactly these -- never to the apps' databases or postgres
export const STUDIO_USER_PREFIX = 'db_';
// lfdln's projects' databases (docs/phase8b-plan.md 8b-5): proj_<name>[_dev], with the logins
// db_proj_<name>[_dev]_owner and _app -- the Studio shows and reads them, never changes them
export const PROJECT_NAMES = { db: 'proj_', login: 'db_proj_' };
export const LFDLN_HELPER: HelperSite = {
  name: 'lfdln-pammydb',
  engines: { postgres: { port: APPDB_PORT }, mariadb: { port: APPMARIA_PORT } },
  // the server's Postgres, Pamela's two engines, pammy.org's and lfdln's panels' own
  forbiddenPorts: [5432, 5433, 5434, 5435, 3307],
  rules: {
    postgres: {
      system: ENGINE_OWN,
      protected: ENGINE_OWN,
      reservedUsers: ['postgres', 'pammy_studio', 'public', ...APP_LOGINS],
      managed: APP_DATABASES,
      userPrefix: STUDIO_USER_PREFIX,
      projects: PROJECT_NAMES,
    },
    // no apps on it: nothing is managed by a service here
    mariadb: {
      system: MARIA_OWN,
      protected: MARIA_OWN,
      reservedUsers: MARIA_ACCOUNTS,
      managed: {},
      userPrefix: STUDIO_USER_PREFIX,
      projects: PROJECT_NAMES,
    },
  },
};
