// Everything the studio helper can do: whole databases on her two engines
// (slice 1), the logins that reach them (slice 3), and the shape inside one
// (slice 4). No rows yet, and no idea what a Resource is
// (docs/studio-plan.md). Each op names an engine and a database; the name is
// checked here again whatever the panel already checked, and the protected
// names are refused before anything is composed (S8).
import type { ApplyOutcome, DatabaseFacts, DbUser, Driver, EngineState } from './driver.ts';
import { patchSql } from './ddl.ts';
import { snapshotHash, type Snapshot } from './ir.ts';
import { checkPatch, destructive, stepTable, type Step } from './patch.ts';
import {
  checkChangeable, checkManageableUser, checkOpenable, checkPassword, checkProjectNames, checkUserName, checkWritable,
  defaultRules, ENGINES, isEngine, isManaged, PammyDbError, type Engine, type NameRules,
} from './ident.ts';
import { checkAccessRole, type Access, type AccessRole } from './roles.ts';
import { checkLinks, checkQuery, checkTableName, checkValues, checkWhere, type RowPage } from './rows.ts';

// A site may have one engine (lfdln: Postgres only, docs/phase8-plan.md P8-8)
export type Drivers = Partial<Record<Engine, Driver>>;
const present = (drivers: Drivers) => ENGINES.filter((e) => drivers[e]);
// the site's rules for this engine (ident.ts NameRules); pammy.org's when it names none
export const rulesOf = (d: Driver): NameRules => d.rules ?? defaultRules(d.engine);

export type DatabaseList = {
  databases: DatabaseFacts[];
  // One entry per engine, so the dashboard can say "MariaDB isn't answering"
  // and still show the Postgres cards.
  engines: EngineState[];
};

function driver(drivers: Drivers, engine: unknown): Driver {
  if (!isEngine(engine)) throw new PammyDbError('invalid', 'That is not one of her two kinds of database.');
  const d = drivers[engine];
  if (!d) throw new PammyDbError('not-found', 'This site has no database server of that kind.');
  return d;
}

// Her whole shelf, both engines, one op. An engine that is down is reported,
// not thrown: the other one's databases are still worth showing.
export async function listDatabases(drivers: Drivers): Promise<DatabaseList> {
  const databases: DatabaseFacts[] = [];
  const engines: EngineState[] = [];
  await Promise.all(present(drivers).map(async (engine) => {
    try {
      const rows = await drivers[engine]!.list();
      databases.push(...rows);
      engines.push({ engine, ok: true, version: null, message: null });
    } catch (e) {
      if (!(e instanceof PammyDbError)) throw e;
      engines.push({ engine, ok: false, version: null, message: e.message });
    }
  }));
  databases.sort((a, b) => a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name));
  engines.sort((a, b) => a.engine.localeCompare(b.engine));
  return { databases, engines };
}

export async function createDatabase(drivers: Drivers, engine: unknown, name: unknown): Promise<DatabaseFacts> {
  const d = driver(drivers, engine);
  return d.create(checkWritable(d.engine, name, rulesOf(d)));
}

export async function dropDatabase(drivers: Drivers, engine: unknown, name: unknown): Promise<{ engine: Engine; name: string; dropped: true }> {
  const d = driver(drivers, engine);
  const db = checkWritable(d.engine, name, rulesOf(d));
  await d.drop(db);
  return { engine: d.engine, name: db, dropped: true };
}

export async function databaseSize(drivers: Drivers, engine: unknown, name: unknown): Promise<{ engine: Engine; name: string; bytes: number | null; tables: number }> {
  const d = driver(drivers, engine);
  // Looking inside `pamela` is allowed; only creating and deleting it is not.
  const db = checkOpenable(d.engine, name, rulesOf(d));
  return { engine: d.engine, name: db, ...await d.size(db) };
}

// Taking on a database she made herself (in her own client, or before the panel
// existed) -- including `pamela`, which is where her work already is. The helper
// only says what is there and that it can be opened; the panel is what remembers
// it, once studio_databases exists -- not before 2026-09-26 (S1).
export async function adoptDatabase(drivers: Drivers, engine: unknown, name: unknown): Promise<DatabaseFacts> {
  const d = driver(drivers, engine);
  const db = checkOpenable(d.engine, name, rulesOf(d));
  const here = (await d.list()).find((row) => row.name === db);
  if (!here) throw new PammyDbError('not-found', 'There is no database with that name on that server.');
  const { bytes, tables } = await d.size(db);
  return { ...here, bytes, tables };
}

// ------------------------------------------------------------------ projects' databases
// lfdln's projects (docs/phase8b-plan.md 8b-5): a database of the project's (the Studio shows it
// and never changes it), an owner login for its migrations (Administrator) and an app login for
// its rows (Read & write). Made again it takes up what is there -- a database kept from an
// earlier project of that name, or a try cut short -- with new passwords: nothing is dropped
// here, ever (a project's database outlives the project).
export async function projectDatabase(drivers: Drivers, engine: unknown, name: unknown, owner: unknown, ownerPassword: unknown, app: unknown, appPassword: unknown) {
  const d = driver(drivers, engine);
  const n = checkProjectNames(rulesOf(d), name, owner, app);
  const opw = checkPassword(ownerPassword);
  const apw = checkPassword(appPassword);
  const kept = (await d.list()).some((x) => x.name === n.db);
  if (!kept) await d.create(n.db);
  const users = (await d.listUsers()).map((u) => u.name);
  for (const [u, pw] of [[n.owner, opw], [n.app, apw]] as const) {
    if (users.includes(u)) await d.setPassword(u, pw);
    else await d.createUser(u, pw);
  }
  await d.grant(n.owner, n.db, 'admin');
  await d.grant(n.app, n.db, 'write');
  if (d.projectAccess) await d.projectAccess(n.db, n.owner, n.app);
  return { engine: d.engine, name: n.db, owner: n.owner, app: n.app, kept };
}

// ------------------------------------------------------------------ database users
// Logins on one engine, and which of the four roles each has on which database
// (docs/databases-plan.md 9). The names on the wire are `list-users` /
// `create-user` / ... and not the plan's `list-roles` / `create-role`: on this
// side of the panel a **role** is one of the four kinds of access she picks, and
// calling a login one too would be exactly the `pg` / `postgres` muddle S11 was
// fixed to stop (docs/studio-plan.md S12).

export type UserList = { users: DbUser[]; engines: EngineState[] };

export async function listUsers(drivers: Drivers): Promise<UserList> {
  const users: DbUser[] = [];
  const engines: EngineState[] = [];
  await Promise.all(present(drivers).map(async (engine) => {
    try {
      users.push(...await drivers[engine]!.listUsers());
      engines.push({ engine, ok: true, version: null, message: null });
    } catch (e) {
      if (!(e instanceof PammyDbError)) throw e;
      engines.push({ engine, ok: false, version: null, message: e.message });
    }
  }));
  users.sort((a, b) => a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name));
  engines.sort((a, b) => a.engine.localeCompare(b.engine));
  return { users, engines };
}

export async function createUser(drivers: Drivers, engine: unknown, name: unknown, password: unknown): Promise<DbUser> {
  const d = driver(drivers, engine);
  const user = checkManageableUser(d.engine, name, rulesOf(d));
  const pw = checkPassword(password);
  if ((await d.listUsers()).some((u) => u.name === user)) {
    throw new PammyDbError('exists', 'There is already a login with that name on that server.');
  }
  return d.createUser(user, pw);
}

export async function dropUser(drivers: Drivers, engine: unknown, name: unknown): Promise<{ engine: Engine; name: string; dropped: true }> {
  const d = driver(drivers, engine);
  const user = checkManageableUser(d.engine, name, rulesOf(d));
  await d.dropUser(user);
  return { engine: d.engine, name: user, dropped: true };
}

// The one that most needs checkManageableUser rather than checkUserName: on
// MariaDB the CREATE USER privilege lets the studio repoint ANY account on the
// server, `root` included, and the refuse-list is the only thing in the way
// (src/pammydb/ident.ts RESERVED_USERS).
export async function resetPassword(drivers: Drivers, engine: unknown, name: unknown, password: unknown): Promise<{ engine: Engine; name: string }> {
  const d = driver(drivers, engine);
  const user = checkManageableUser(d.engine, name, rulesOf(d));
  await d.setPassword(user, checkPassword(password));
  return { engine: d.engine, name: user };
}

// What one login can reach, over the databases the panel names. Reading is not
// managing, so the engine's own logins can be looked at: it is how she finds out
// that `pamela` reaches everything.
export async function userAccess(drivers: Drivers, engine: unknown, name: unknown, databases: unknown): Promise<{ engine: Engine; name: string; access: Access[] }> {
  const d = driver(drivers, engine);
  const user = checkUserName(name);
  const names = Array.isArray(databases) ? databases.map((n) => checkOpenable(d.engine, n, rulesOf(d))) : [];
  return { engine: d.engine, name: user, access: await d.accessOf(user, names) };
}

export async function grantAccess(drivers: Drivers, engine: unknown, name: unknown, database: unknown, role: unknown): Promise<{ engine: Engine; name: string; database: string; role: AccessRole }> {
  const d = driver(drivers, engine);
  const user = checkManageableUser(d.engine, name, rulesOf(d));
  // She can grant access INTO her own `pamela` database -- that is where her
  // work is -- but never into the engine's own machinery.
  const db = checkChangeable(d.engine, database, rulesOf(d));
  const r = checkAccessRole(role);
  await d.grant(user, db, r);
  return { engine: d.engine, name: user, database: db, role: r };
}

export async function revokeAccess(drivers: Drivers, engine: unknown, name: unknown, database: unknown): Promise<{ engine: Engine; name: string; database: string }> {
  const d = driver(drivers, engine);
  const user = checkManageableUser(d.engine, name, rulesOf(d));
  const db = checkChangeable(d.engine, database, rulesOf(d));
  await d.revoke(user, db);
  return { engine: d.engine, name: user, database: db };
}


// ------------------------------------------------------------------ the shape inside a database
// Introspect, the SQL a patch would run, and Apply (docs/studio-plan.md, slice
// 4). The helper is still dumb SQL: it does not know what a draft is, which
// steps she ticked, or what a Resource will be. It reads a schema, prints a
// patch, and runs one.

export async function introspect(drivers: Drivers, engine: unknown, name: unknown): Promise<Snapshot & { hash: string }> {
  const d = driver(drivers, engine);
  const db = checkOpenable(d.engine, name, rulesOf(d));
  const snapshot = await d.introspect(db);
  // The hash rides along so the panel never has to compute it the same way
  // twice: it is what Apply compares against, and one of them computing it
  // differently is the kind of bug that only shows up as a refusal she cannot
  // explain.
  return { ...snapshot, hash: snapshotHash(snapshot) };
}

// What Apply would run, without running it. Review shows this under Advanced,
// so what she reads is produced by the same printer that will do the work --
// not a second rendering that could drift from the first.
export async function previewSchema(drivers: Drivers, engine: unknown, name: unknown, patch: unknown): Promise<{
  engine: Engine; database: string; steps: Step[]; sql: string[]; destructive: boolean;
}> {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const steps = checkPatch(patch);
  return { engine: d.engine, database: db, steps, sql: patchSql(d.engine, steps), destructive: steps.some(destructive) };
}

// Two managers, or a manager and a program, must not change one database's
// shape at the same time. The lock is in this process because this process is
// the only thing that speaks to her engines at all.
const applying = new Map<string, Promise<unknown>>();

export type ApplyResult = ApplyOutcome & {
  engine: Engine;
  database: string;
  steps: Step[];
  sql: string[];
  // what the database looks like afterwards, whether it all worked or not. On
  // MariaDB this is how the panel rebuilds a draft out of "live plus the steps
  // that did not happen" rather than guessing.
  snapshot: Snapshot & { hash: string };
};

export async function applySchema(drivers: Drivers, engine: unknown, name: unknown, patch: unknown, expect: unknown): Promise<ApplyResult> {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const steps = checkPatch(patch);
  const key = `${d.engine}:${db}`;
  if (applying.has(key)) {
    throw new PammyDbError('busy', 'Someone else is changing this database right now. Give it a moment and try again.');
  }
  const work = (async () => {
    // Drift: the patch was worked out against a schema, and if the database has
    // moved since, the steps may mean something else now. Checked here rather
    // than in the panel because here is the only place that can check it
    // without a gap between the looking and the doing.
    const before = await d.introspect(db);
    if (typeof expect === 'string' && expect !== '' && snapshotHash(before) !== expect) {
      throw new PammyDbError('conflict',
        'This database changed since these changes were worked out. Have another look at it, then apply them again.');
    }
    const outcome = await d.apply(db, steps);
    const after = await d.introspect(db);
    return {
      engine: d.engine, database: db, steps, sql: patchSql(d.engine, steps), ...outcome,
      snapshot: { ...after, hash: snapshotHash(after) },
    };
  })();
  applying.set(key, work);
  try {
    return await work;
  } finally {
    applying.delete(key);
  }
}

// For the log line: "3 steps on blog_posts, comments".
export const patchSummary = (steps: Step[]): string =>
  `${steps.length} step(s) on ${[...new Set(steps.map(stepTable))].join(', ')}`;


// ------------------------------------------------------------------ her rows (slice 8)
//
// The helper still holds no opinion about Resources. Which columns may be read
// or written, and whether she is allowed to add or delete at all, is the
// panel's business (src/studio/records.ts) -- by the time a request reaches
// here it is already a list of column names and a set of values.
//
// What IS enforced here: the database must be openable at all (the same
// refuse-list that keeps the studio out of the engine's own machinery), and
// every identifier goes through rows.ts, which checks it against NAME_RE and
// quotes it. Values are parameters, never text in a statement.

export async function listRows(drivers: Drivers, engine: unknown, name: unknown, query: unknown): Promise<RowPage> {
  const d = driver(drivers, engine);
  const db = checkOpenable(d.engine, name, rulesOf(d));
  return d.listRows(db, checkQuery(query));
}

export async function getRow(drivers: Drivers, engine: unknown, name: unknown, table: unknown, columns: unknown, where: unknown) {
  const d = driver(drivers, engine);
  const db = checkOpenable(d.engine, name, rulesOf(d));
  const q = checkQuery({ table, columns, limit: 1 });
  const row = await d.getRow(db, q.table, q.columns, checkWhere(where));
  return { row };
}

export async function insertRow(drivers: Drivers, engine: unknown, name: unknown, table: unknown, values: unknown, back: unknown) {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const q = checkQuery({ table, columns: back });
  const row = await d.insertRow(db, q.table, checkValues(values), q.columns);
  return { row };
}

export async function updateRow(drivers: Drivers, engine: unknown, name: unknown, table: unknown, values: unknown, where: unknown, back: unknown) {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const q = checkQuery({ table, columns: back });
  const row = await d.updateRow(db, q.table, checkValues(values), checkWhere(where), q.columns);
  return { row };
}

export async function deleteRow(drivers: Drivers, engine: unknown, name: unknown, table: unknown, where: unknown) {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const gone = await d.deleteRow(db, checkTableName(table), checkWhere(where));
  return { gone };
}

// A record's pairs in a connecting table, replaced in one transaction
// (docs/record-picker-plan.md R12). Which connecting table, and whether it
// really connects what the panel says, is the panel's to decide; this checks
// the names and the values like every other row op.
export async function setLinks(drivers: Drivers, engine: unknown, name: unknown, o: { table: unknown; here: unknown; id: unknown; there: unknown; ids: unknown }) {
  const d = driver(drivers, engine);
  const db = checkChangeable(d.engine, name, rulesOf(d));
  const q = checkLinks(o);
  const saved = await d.setLinks(db, q.table, q.here, q.id, q.there, q.ids);
  return { saved };
}
