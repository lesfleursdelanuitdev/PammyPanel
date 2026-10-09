// What the helper needs from an engine, and nothing about what a Resource is
// (docs/studio-plan.md: "the helper is dumb SQL"). One implementation per
// engine: pg.ts and maria.ts. Whole databases (slice 1), the logins that can
// reach them (slice 3), and the shape of what is inside (slice 4) -- no rows
// yet.
import type { Engine, NameRules } from './ident.ts';
import type { Snapshot } from './ir.ts';
import type { Step } from './patch.ts';
import type { Access, AccessRole } from './roles.ts';
import type { RowPage, RowQuery, Scalar } from './rows.ts';

export type DatabaseFacts = {
  engine: Engine;
  name: string;
  bytes: number | null;        // null when this role may not look inside
  tables: number | null;       // null when counting it would cost a connection (Postgres list)
  owner: string | null;        // Postgres only; MariaDB has no database owner
  // in PROTECTED: shown, and workable, but the panel never creates or deletes it
  protectedName: boolean;
  // in SYSTEM: the engine's own machinery, which the studio does not open at all
  system: boolean;
  // an app's (the site's rules, docs/phase8-plan.md P8-9): shown and read, never changed
  appOwned?: boolean;
  // ...and of those, a project's (lfdln, docs/phase8b-plan.md 8b-5)
  projectOwned?: boolean;
};

export type EngineState = {
  engine: Engine;
  ok: boolean;
  version: string | null;
  message: string | null;      // in her words, when it isn't answering
};

// A login on this engine (docs/databases-plan.md 9). `host` is MariaDB's half of
// the identity and is null on Postgres, where a role is just a name.
export type DbUser = {
  engine: Engine;
  name: string;
  host: string | null;
  // false for a Postgres group role, which is not something she can log in as
  canLogin: boolean;
  // one of the logins that came with the server: shown, never touched
  reserved: boolean;
  // it has privileges over the whole server, not a database at a time, so the
  // four roles do not describe it. Her `pamela` login is one; so is anything
  // made outside the panel with a global GRANT.
  serverWide: boolean;
};

export type Driver = {
  engine: Engine;
  // the site's names (ident.ts NameRules): pammy.org's lists when not given
  rules?: NameRules;
  state(): Promise<EngineState>;
  list(): Promise<DatabaseFacts[]>;
  create(name: string): Promise<DatabaseFacts>;
  drop(name: string): Promise<void>;
  size(name: string): Promise<{ bytes: number | null; tables: number }>;

  // --- database users, and their access to a database (slice 3)
  listUsers(): Promise<DbUser[]>;
  createUser(name: string, password: string): Promise<DbUser>;
  dropUser(name: string): Promise<void>;
  setPassword(name: string, password: string): Promise<void>;
  // Which of the four roles this user has, per database, for the databases
  // named. Only those: on Postgres reading a database's grants costs a
  // connection to it, so the caller passes the shelf it actually cares about.
  accessOf(user: string, databases: string[]): Promise<Access[]>;
  grant(user: string, database: string, role: AccessRole): Promise<void>;
  revoke(user: string, database: string): Promise<void>;
  // A project's database (lfdln, docs/phase8b-plan.md 8b-5): what its owner login makes later,
  // its app login may read and write (and the studio read). MariaDB's grants are per database
  // already, so only Postgres has one.
  projectAccess?(database: string, owner: string, app: string): Promise<void>;

  // --- the shape inside one database (slice 4)
  // What is really there, now. Never from anything written down: drift is
  // exactly the difference between this and what the draft was built from
  // (docs/databases-plan.md 8).
  introspect(database: string): Promise<Snapshot>;
  // The reviewed patch, already checked and in dependency order. Postgres runs
  // it in one transaction; MariaDB one statement at a time, and says which one
  // it got to. Neither pretends the other's behaviour.
  apply(database: string, steps: Step[]): Promise<ApplyOutcome>;

  // --- her rows (slice 8)
  // The first thing here that touches what is IN a table. Identifiers are
  // names, checked and quoted; values are always parameters
  // (src/pammydb/rows.ts). The helper still holds no opinion about which
  // columns may be read or written -- that is the Resource's window, worked
  // out by the panel before a query is ever built.
  listRows(database: string, q: RowQuery): Promise<RowPage>;
  getRow(database: string, table: string, columns: string[], where: Record<string, Scalar>): Promise<Record<string, unknown> | null>;
  insertRow(database: string, table: string, values: Record<string, Scalar>, back: string[]): Promise<Record<string, unknown>>;
  updateRow(database: string, table: string, values: Record<string, Scalar>, where: Record<string, Scalar>, back: string[]): Promise<Record<string, unknown> | null>;
  deleteRow(database: string, table: string, where: Record<string, Scalar>): Promise<boolean>;
  // a record's pairs in a connecting table, replaced in one transaction
  setLinks(database: string, table: string, here: string, id: Scalar, there: string, ids: Scalar[]): Promise<number>;

  close(): Promise<void>;
};

// What an Apply did, told the same way for both engines so the panel does not
// have to know which one it asked (docs/studio-plan.md, "we never pretend a
// rollback").
export type ApplyOutcome = {
  // steps that ran AND stayed. On Postgres a failure leaves this at 0.
  applied: number;
  failed: { at: number; message: string } | null;
  // true only on Postgres, and only when something failed: the engine undid it
  rolledBack: boolean;
};
