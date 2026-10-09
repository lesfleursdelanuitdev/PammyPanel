// Database and table names, and what the studio helper will never touch.
// Shared by the panel (to explain, and to grey out a card) and the helper (to
// enforce, whatever the panel already checked). Nothing here talks to a
// database: it is all string rules, so the panel can import it freely.

export type Engine = 'postgres' | 'mariadb';

export const ENGINES: Engine[] = ['postgres', 'mariadb'];

// What she calls them (docs/databases-plan.md: MariaDB is "works with anything
// made for MySQL", Postgres is Postgres).
export const ENGINE_NAMES: Record<Engine, string> = { postgres: 'Postgres', mariadb: 'MariaDB' };

export const isEngine = (v: unknown): v is Engine => v === 'postgres' || v === 'mariadb';

export class PammyDbError extends Error {
  // `conflict` is slice 4's: the database moved since the changes were worked
  // out. src/app.ts HELPER_STATUS already turns it into a 409, the same as the
  // editor's "someone else saved" (src/sitefs/edit.ts).
  code: 'invalid' | 'exists' | 'not-found' | 'not-allowed' | 'busy' | 'conflict' | 'unavailable' | 'internal';
  constructor(code: PammyDbError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// One rule for both engines, and the strictest of the two: lowercase so
// Postgres never folds a name into a surprise, no dots or quotes so nothing can
// escape the quoting below, and short enough for MariaDB's 64-byte limit.
export const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

// Two lists, because they answer two different questions (docs/studio-plan.md S8).
//
// SYSTEM is the engine's own machinery. The studio never opens it at all: there
// is nothing in there she made or would want to design.
export const SYSTEM: Record<Engine, string[]> = {
  postgres: ['postgres', 'template0', 'template1'],
  mariadb: ['mysql', 'information_schema', 'performance_schema', 'sys'],
};

// PROTECTED is the same list plus `pamela`, the database that came with her
// account (no-sudo/install-pamela-db.sh). The panel never CREATES or DELETES
// these -- and `pamela` is the whole reason the list exists, because the studio
// role really could drop it. But she may look inside `pamela` and design its
// tables: it is where her own work already is, so refusing to open it would make
// the studio useless to her.
export const PROTECTED: Record<Engine, string[]> = {
  postgres: [...SYSTEM.postgres, 'pamela'],
  mariadb: [...SYSTEM.mariadb, 'pamela'],
};

// A site's own rules (docs/phase8-plan.md 8-4): the lists above are pammy.org's, and the
// defaults; another site's helper names its own (lfdln: the apps' databases and logins).
//   managed: databases an app owns (P8-9) -- shown, read, never changed from the panel: no
//            structure, no rows, no logins given to them, never dropped. By name, each with
//            the schema its tables are in (examprep's are in "prep").
//   userPrefix: the logins the Studio makes and manages all start with it (lfdln: "db_", P8-15),
//            and it touches no other; the engine's pg_hba admits exactly those
//   projects: lfdln's projects' databases (docs/phase8b-plan.md 8b-5): every database whose
//            name starts with `db` is a project's (managed, in public), made only by the
//            project-database op; logins starting with `login` are its, never the Studio's
export type NameRules = {
  system: string[];
  protected: string[];
  reservedUsers: string[];
  managed: Record<string, string>;
  userPrefix?: string;
  projects?: { db: string; login: string };
};
export const defaultRules = (engine: Engine): NameRules =>
  ({ system: SYSTEM[engine], protected: PROTECTED[engine], reservedUsers: RESERVED_USERS[engine], managed: {} });
export const isProjectDb = (r: NameRules, db: string) => !!r.projects && db.startsWith(r.projects.db) && db.length > r.projects.db.length;
export const isManaged = (r: NameRules, db: string) => Object.hasOwn(r.managed, db) || isProjectDb(r, db);
// where a managed database's tables are: an app's names its schema; a project's are in public
export const managedSchema = (r: NameRules, db: string) => (Object.hasOwn(r.managed, db) ? r.managed[db]! : 'public');

// Why a new database name can't be used, in her words, or null if it can.
// The panel says this before she presses anything; the helper just refuses.
export function newNameProblem(name: unknown, engine: Engine): string | null {
  if (typeof name !== 'string' || name === '') return 'Please type a name.';
  if (name.length > 63) return 'Names can be at most 63 characters.';
  if (/[A-Z]/.test(name)) return 'Use lowercase letters only.';
  if (/^[0-9]/.test(name)) return 'Names have to start with a letter.';
  if (!NAME_RE.test(name)) return 'Use only lowercase letters, digits and underscores, starting with a letter.';
  if (PROTECTED[engine].includes(name)) return `"${name}" is taken by the database server, or is the one that came with your account, so pick another name.`;
  return null;
}

// The helper's own check, on every op that names a database. Throws.
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new PammyDbError('invalid', 'That database name has characters the database will not take. Use lowercase letters, digits and underscores.');
  }
  return name;
}

const MANAGED_WORDS = (db: string, r?: NameRules) => (r && isProjectDb(r, db)
  ? `"${db}" belongs to a project, whose own code changes it: the Studio shows it, and reads it, but never changes it.`
  : `"${db}" belongs to a service, which looks after it: the panel shows it, and reads it, but never changes it.`);

// For create and drop: the engine's own, hers, and an app's are never made or unmade here.
export function checkWritable(engine: Engine, name: unknown, rules: NameRules = defaultRules(engine)): string {
  const db = checkName(name);
  if (rules.system.includes(db)) {
    throw new PammyDbError('not-allowed', `"${db}" belongs to the database server itself, so the panel leaves it alone.`);
  }
  if (isManaged(rules, db)) throw new PammyDbError('not-allowed', MANAGED_WORDS(db, rules));
  if (rules.protected.includes(db)) {
    throw new PammyDbError('not-allowed', `"${db}" is the database that came with your account. The panel can work inside it, but it will not create or delete it.`);
  }
  return db;
}

// For looking inside: everything except the engine's own machinery, so her own
// `pamela` database can be adopted and designed like any other (and an app's read).
export function checkOpenable(engine: Engine, name: unknown, rules: NameRules = defaultRules(engine)): string {
  const db = checkName(name);
  if (rules.system.includes(db)) {
    throw new PammyDbError('not-allowed', `"${db}" belongs to the database server itself, so the panel leaves it alone.`);
  }
  return db;
}

// For changing what is inside (its structure, its rows, who may log in to it): anything
// openable, except a database an app owns (P8-9).
export function checkChangeable(engine: Engine, name: unknown, rules: NameRules = defaultRules(engine)): string {
  const db = checkOpenable(engine, name, rules);
  if (isManaged(rules, db)) throw new PammyDbError('not-allowed', MANAGED_WORDS(db, rules));
  return db;
}

// Every identifier reaches SQL through here. NAME_RE has already ruled out the
// quote characters, so the doubling is belt and braces for the day someone
// widens the regex.
export function quote(engine: Engine, ident: string): string {
  checkName(ident);
  return engine === 'postgres' ? `"${ident.replaceAll('"', '""')}"` : `\`${ident.replaceAll('`', '``')}\``;
}

// ------------------------------------------------------------------ database users
// A login on ONE engine (docs/databases-plan.md 9). Not a panel account, not an
// API key: this is for programs that speak SQL -- her own app on :3042, a backup
// job, HeidiSQL on her laptop through a tunnel.
//
// The name rule is NAME_RE again, so a user name and a database name are the
// same shape and neither can escape quoting.

// The logins the studio never makes, renames, deletes or repoints, on top of the
// name rule. This list is not cosmetic: on MariaDB it is the whole of the
// boundary.
//
// Postgres bounds itself. `pammy_studio` is CREATEROLE, and since Postgres 16 a
// CREATEROLE role may only alter or drop roles it created itself -- `postgres`
// and `pamela` are simply out of its reach, whatever it asks for.
//
// **MariaDB does not.** The `CREATE USER` privilege there covers every account
// on the server, so `ALTER USER 'root'@'localhost' IDENTIFIED BY ...` is a
// legal statement for the studio role. Nothing in the engine stops it. This list
// is what stops it, and that is why `reset-password` checks it as carefully as
// `drop-user` does.
export const RESERVED_USERS: Record<Engine, string[]> = {
  // `pamela` is her own admin login (no-sudo/install-pamela-db.sh), `postgres`
  // the superuser, `pammy_studio` the panel's own. `public` is Postgres's
  // everyone-role and is not a login at all.
  postgres: ['postgres', 'pamela', 'pammy_studio', 'public'],
  // `mariadb.sys` and friends are the server's own internal accounts; `healthcheck`
  // is the container image's.
  mariadb: ['root', 'mysql', 'pamela', 'pammy_studio', 'healthcheck', 'mariadb'],
};

// Postgres keeps every name starting `pg_` for itself, and refuses CREATE ROLE
// on one. Say so in her words rather than letting the engine say it in its own.
const reservedPrefix = (engine: Engine, name: string) => engine === 'postgres' && name.startsWith('pg_');

// Why a new database user can't be called that, in her words, or null if it can.
// prefix: the site's (NameRules.userPrefix), when its logins must start with one.
export function newUserProblem(name: unknown, engine: Engine, prefix?: string): string | null {
  if (typeof name !== 'string' || name === '') return 'Please type a name.';
  if (name.length > 63) return 'Names can be at most 63 characters.';
  if (/[A-Z]/.test(name)) return 'Use lowercase letters only.';
  if (/^[0-9]/.test(name)) return 'Names have to start with a letter.';
  if (!NAME_RE.test(name)) return 'Use only lowercase letters, digits and underscores, starting with a letter.';
  if (RESERVED_USERS[engine].includes(name)) return `"${name}" is one of the logins that came with the server, so pick another name.`;
  if (prefix && (!name.startsWith(prefix) || name.length === prefix.length)) return `Logins here start with ${prefix}, like ${prefix}recipes.`;
  if (reservedPrefix(engine, name)) return 'Names starting with pg_ are kept by Postgres for itself. Pick another name.';
  return null;
}

// The helper's own check, on every op that names a user it is about to make or
// change. Throws. `checkUserName` alone is enough for reading.
export function checkUserName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new PammyDbError('invalid', 'That user name has characters the database will not take. Use lowercase letters, digits and underscores.');
  }
  return name;
}

export function checkManageableUser(engine: Engine, name: unknown, rules: NameRules = defaultRules(engine)): string {
  const user = checkUserName(name);
  if (rules.userPrefix && (!user.startsWith(rules.userPrefix) || user.length === rules.userPrefix.length)) {
    throw new PammyDbError('not-allowed', `"${user}" isn't one of the logins the panel looks after here: those all start with ${rules.userPrefix}.`);
  }
  if (rules.reservedUsers.includes(user) || reservedPrefix(engine, user)) {
    throw new PammyDbError('not-allowed', `"${user}" is one of the logins that came with the database server, so the panel leaves it alone.`);
  }
  if (rules.projects && user.startsWith(rules.projects.login)) {
    throw new PammyDbError('not-allowed', `"${user}" is a project's login: its project looks after it (Projects), never the Studio.`);
  }
  return user;
}

// A project's database and its two logins (docs/phase8b-plan.md 8b-5), checked by the
// project-database op only: <db prefix><name>, <login prefix><name>_owner and _app.
export function checkProjectNames(rules: NameRules, name: unknown, owner: unknown, app: unknown): { db: string; owner: string; app: string } {
  if (!rules.projects) throw new PammyDbError('not-allowed', 'This site has no projects.');
  const db = checkName(name);
  if (!isProjectDb(rules, db)) throw new PammyDbError('invalid', `A project's database is called ${rules.projects.db}<its name>.`);
  const suffix = db.slice(rules.projects.db.length);
  const o = checkUserName(owner);
  const a = checkUserName(app);
  if (o !== `${rules.projects.login}${suffix}_owner` || a !== `${rules.projects.login}${suffix}_app`) {
    throw new PammyDbError('invalid', `A project database's logins are ${rules.projects.login}${suffix}_owner and _app.`);
  }
  return { db, owner: o, app: a };
}

// Passwords never reach SQL as a parameter, because CREATE ROLE / CREATE USER
// are utility statements: no engine will bind a placeholder in one. So instead
// of escaping, the alphabet is narrowed until escaping has nothing to do --
// letters and digits only, exactly as no-sudo/install-studio-db.sh already makes
// the studio's own passwords. The panel generates them (src/studio/users.ts);
// the helper refuses anything else, whatever the panel sent.
export const PASSWORD_RE = /^[A-Za-z0-9]{16,64}$/;

export function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    throw new PammyDbError('invalid', 'The panel sent a password the helper will not put in a database. Ask momolig.');
  }
  return password;
}
