// What the panel API sends back for this module (its routes are the source of truth).
// Her own databases (docs/databases-plan.md 5). The engine is spelled the way
// her addresses spell it, matching src/pammydb/ident.ts.
export type DatabaseEngine = 'postgres' | 'mariadb';
export type DatabaseCard = {
  engine: DatabaseEngine;
  engineName: string;           // "Postgres" / "MariaDB"
  name: string;
  displayName: string;          // what her app is called; '' until she sets one
  managed: boolean;             // the panel looks after it
  // true: the engine has it. false: the engine answered and it is not there.
  // null: the engine did not answer, so nobody can say -- never shown as "gone".
  live: boolean | null;
  bytes: number | null;
  tables: number | null;
  owner: string | null;
  protectedName: boolean;       // never created or deleted by the panel
  appOwned: boolean;            // an app's (lfdln): looked inside, never changed
  projectOwned?: boolean;       // ...a project's (Projects, 8b-5)
  system: boolean;              // the engine's own machinery
  status: 'inactive' | 'active';
  adoptedAt: number | null;
  example: 'recipes' | 'blog' | null;  // one of the panel's own examples (docs/db-examples-plan.md)
};
export type DatabaseEngineState = { engine: DatabaseEngine; ok: boolean; version: string | null; message: string | null };
export type DatabasesData = { databases: DatabaseCard[]; engines: DatabaseEngineState[] };

// Database users (docs/databases-plan.md 9): logins on ONE engine, for programs
// that speak SQL. Not panel accounts and not API keys. The four roles come back
// from the engine's real grants, so `custom` means someone granted something in
// psql or HeidiSQL and the panel will not guess which of the four it resembles.
export type AccessRole = 'read' | 'write' | 'structure' | 'admin';
export type GrantedRole = AccessRole | 'custom';
export type DbUserCard = {
  engine: DatabaseEngine;
  engineName: string;
  name: string;
  host: string | null;          // MariaDB's half of the identity; null on Postgres
  note: string;
  known: boolean;               // the panel made it, or has a note for it
  live: boolean | null;         // the same three states as a database card
  canLogin: boolean;
  reserved: boolean;            // came with the server: shown, never touched
  serverWide: boolean;          // reaches the whole server, so no role describes it
  createdAt: number | null;
};
export type DbUsersData = { users: DbUserCard[]; engines: DatabaseEngineState[] };
export type DbUserAccess = { database: string; role: GrantedRole; roleName: string };
export type DbUserData = { user: DbUserCard; databases: DatabaseCard[]; access: DbUserAccess[] };
export type DatabaseUsersData = {
  users: { name: string; note: string; serverWide: boolean; role: GrantedRole; roleName: string }[];
  others: string[];
};
