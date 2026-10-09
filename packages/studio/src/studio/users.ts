// The panel's side of her database users (docs/databases-plan.md 9). The engine
// owns the logins and the grants; this owns the note beside a login, the
// password it is born with, and the merging of the two lists into what a page
// can show.
//
// As with databases, the live list wins: a login the panel has a note for but
// the engine no longer has is gone, and a login on the engine the panel has
// never seen is still hers to look at.
import { randomBytes } from 'node:crypto';
import { AccountError } from '@panel/core/accounts';
import { all, one, run, type Db } from '@panel/core/pg';
import type { DbUser, EngineState } from '../pammydb/driver.ts';
import { ENGINE_NAMES, PASSWORD_RE, type Engine } from '../pammydb/ident.ts';
import { ROLE_NAMES, type Access, type GrantedRole } from '../pammydb/roles.ts';

export type UserNoteRow = {
  id: number;
  engine: Engine;
  name: string;
  note: string;
  created_at: number;
};

// One row on /databases/users.
export type UserCard = {
  engine: Engine;
  engineName: string;
  name: string;
  host: string | null;          // MariaDB's half of the identity; null on Postgres
  note: string;
  known: boolean;               // the panel made it, or has a note for it
  live: boolean | null;         // true / false / null = the engine did not answer
  canLogin: boolean;
  reserved: boolean;            // came with the server: shown, never touched
  serverWide: boolean;          // reaches the whole server, so the four roles don't describe it
  createdAt: number | null;
};

export type UserAccess = {
  database: string;
  role: GrantedRole;
  roleName: string;             // "Read & write", or "Set outside the panel"
};

// Letters and digits only, and that is not laziness. CREATE ROLE and CREATE USER
// are utility statements: no engine will take a bound parameter in one, so the
// password is composed into the SQL. Narrowing the alphabet until there is
// nothing to escape is the version of that with no quoting bug in it
// (src/pammydb/ident.ts PASSWORD_RE, which refuses anything else on arrival).
//
// 32 characters of [A-Za-z0-9] is a little under 191 bits. She never types it:
// it is shown once, to copy.
export function newDbPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // rejection-free: 62 does not divide 256, so take 6 bits at a time from a
  // wider draw and keep only the values in range
  let out = '';
  while (out.length < 32) {
    for (const b of randomBytes(48)) {
      if (b < 248 && out.length < 32) out += alphabet[b % 62];
    }
  }
  if (!PASSWORD_RE.test(out)) throw new AccountError('The panel could not make a password. Ask momolig.', 500);
  return out;
}

export const roleLabel = (role: GrantedRole): string =>
  role === 'custom' ? 'Set outside the panel' : ROLE_NAMES[role];

export const withLabels = (access: Access[]): UserAccess[] =>
  access.map((a) => ({ ...a, roleName: roleLabel(a.role) }));

const key = (engine: string, name: string) => `${engine}:${name}`;

// Everything the engines have, plus anything the panel still has a note for that
// they no longer do. Pure, so it is testable without an engine.
export function mergeUsers(live: DbUser[], known: UserNoteRow[], engines: EngineState[] = []): UserCard[] {
  const silent = new Set(engines.filter((e) => !e.ok).map((e) => e.engine));
  const notes = new Map(known.map((k) => [key(k.engine, k.name), k]));
  const cards: UserCard[] = [];
  for (const u of live) {
    const k = notes.get(key(u.engine, u.name));
    notes.delete(key(u.engine, u.name));
    cards.push({
      engine: u.engine,
      engineName: ENGINE_NAMES[u.engine],
      name: u.name,
      host: u.host,
      note: k?.note ?? '',
      known: !!k,
      live: true,
      canLogin: u.canLogin,
      reserved: u.reserved,
      serverWide: u.serverWide,
      createdAt: k?.created_at ?? null,
    });
  }
  for (const k of notes.values()) {
    cards.push({
      engine: k.engine,
      engineName: ENGINE_NAMES[k.engine],
      name: k.name,
      host: null,
      note: k.note,
      known: true,
      // the same three states as a database: an engine that is asleep must never
      // be reported as a login that has been removed
      live: silent.has(k.engine) ? null : false,
      canLogin: false,
      reserved: false,
      serverWide: false,
      createdAt: k.created_at,
    });
  }
  cards.sort((a, b) => a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name));
  return cards;
}

export const listKnownUsers = (db: Db) =>
  all<UserNoteRow>(db, 'SELECT * FROM studio_db_users ORDER BY engine, name');

export const getKnownUser = (db: Db, engine: Engine, name: string) =>
  one<UserNoteRow>(db, 'SELECT * FROM studio_db_users WHERE engine = ? AND name = ?', engine, name);

// Writing a login down. Doing it twice is not an error: the second time only the
// note moves, which is what adopting a login she made in psql should do.
export async function rememberUser(db: Db, o: { engine: Engine; name: string; note?: string; at: number }): Promise<UserNoteRow> {
  await run(db,
    `INSERT INTO studio_db_users (engine, name, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (engine, name) DO UPDATE SET note = EXCLUDED.note`,
    o.engine, o.name, o.note ?? '', o.at);
  const row = await getKnownUser(db, o.engine, o.name);
  if (!row) throw new AccountError('The panel could not write that login down.', 500);
  return row;
}

// A login the engine has but the panel has no row for is perfectly normal: she
// can write a note on it, and that is what makes the row.
export const setUserNote = (db: Db, engine: Engine, name: string, note: string, at: number) =>
  rememberUser(db, { engine, name, note, at });

export const forgetUser = (db: Db, engine: Engine, name: string) =>
  run(db, 'DELETE FROM studio_db_users WHERE engine = ? AND name = ?', engine, name);
