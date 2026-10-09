// The panel's and the gate's Postgres (docs/postgres-plan.md): the connection,
// how values come back, and transactions. Replaces db.ts as the code moves over
// (build steps 3-5); until then nothing opens it but the tests and tools.
//
//   const sql = connectPg({ role: 'panel', passwordFile: ... });
//   await checkSchema(sql);                          // on start (P9)
//   const rows = await sql`SELECT ... WHERE id = ${id}`;
//   await tx(sql, async (q) => { ... q`...` ... });  // every write (P11)
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { MIGRATIONS_TABLE, migrationFiles, type Sources } from './pg-migrate.ts';

// int8 comes back as a JS number (P8): every id, time and count we keep is far
// below 2^53, and the code works with numbers. A value that isn't throws rather
// than coming back rounded. (numeric, e.g. sum() of a bigint, stays a string:
// cast it in the query.)
const bigint = {
  to: 20,
  from: [20],
  serialize: (x: number | bigint | string) => String(x),
  parse: (x: string) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n)) throw new Error(`a bigint too large for a JS number: ${x}`);
    return n;
  },
};
type Types = { bigint: number };

export type Sql = postgres.Sql<Types>;
export type TxSql = postgres.TransactionSql<Types>;
// What a function that queries takes: the pool, or the transaction it's inside.
export type Db = Sql | TxSql;

export type Role = 'panel' | 'gate' | 'owner';
// Each process sees only its own schemas (P5); the owner (migrations, port) all three.
// (media is left out: its tables are gone since catalog step 3, catalog/0002; the owner
// keeps it for the early migrations a new database runs; the owner's catalog comes after gate, whose links and resources are its own)
const SEARCH_PATH: Record<Role, string> = { panel: 'panel, catalog, files, thumbs', gate: 'gate', owner: 'panel, media, gate, catalog, files, thumbs' };

export type PgOptions = {
  role: Role;
  // the password itself, the file it's in (LoadCredential=, /etc/pammy-panel/db/<role>.pass),
  // or an open file descriptor: how the pammy-panel wrapper hands it over, since
  // the panel's user may not read the file itself (root 600). Read the fd, not
  // /dev/fd/N, which checks the file's permissions again as this user.
  password?: string;
  passwordFile?: string;
  passwordFd?: number;
  host?: string;          // 127.0.0.1
  port?: number;          // 5434
  database?: string;      // pammy
  max?: number;           // connections in the pool
  app?: string;           // application_name, shown in pg_stat_activity and the logs
};

export function connectPg(o: PgOptions): Sql {
  const password = o.password
    ?? (o.passwordFd !== undefined ? readPasswordFd(o.passwordFd) : o.passwordFile ? readFileSync(o.passwordFile, 'utf8').trim() : undefined);
  if (!password) throw new Error('connectPg: no password (password, passwordFile or passwordFd)');
  return postgres({
    host: o.host ?? '127.0.0.1',
    port: o.port ?? 5434,
    database: o.database ?? 'pammy',
    username: `pammy_${o.role}`,
    password,
    max: o.max ?? 5,
    idle_timeout: 60,
    connect_timeout: 5,
    max_lifetime: 30 * 60,
    types: { bigint },
    // search_path and the name go in the startup message: no extra round trip
    connection: { application_name: o.app ?? `pammy-${o.role}`, search_path: SEARCH_PATH[o.role] } as Record<string, string>,
    onnotice: () => {},
  }) as unknown as Sql;
}

function readPasswordFd(fd: number): string {
  try {
    return readFileSync(fd, 'utf8').trim();
  } catch (e) {
    throw new Error(`the database password was not passed on file descriptor ${fd}: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ transactions
// Postgres interleaves requests, so "check it's free, then insert" is not safe
// by itself: every write runs SERIALIZABLE, and a transaction that lost a race
// is run again from the top (P11). fn may run more than once: it must only touch the database, or do
// things that are safe to repeat, until it returns.
//
// Inside a tx, tx(q, ...) joins the one already open (as today's tx(db, ...) is
// only ever called outermost, this keeps nested helpers simple).
const RETRY = new Set(['40001', '40P01']);   // serialization_failure, deadlock_detected
export const TX_ATTEMPTS = 5;

export async function tx<T>(db: Db, fn: (q: TxSql) => Promise<T>): Promise<T> {
  if (isTx(db)) return fn(db);
  for (let attempt = 1; ; attempt++) {
    try {
      return await (db as Sql).begin('isolation level serializable', fn) as T;
    } catch (e) {
      if (attempt >= TX_ATTEMPTS || !RETRY.has(pgCode(e) ?? '')) throw e;
      // spread the retries out so the two sides don't collide again
      await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
    }
  }
}

export function isTx(db: Db): db is TxSql {
  return typeof (db as TxSql).savepoint === 'function';
}

// ------------------------------------------------------------------ queries with ? placeholders
// SQL written with ? placeholders, handy where a WHERE is built from parts:
//   await all(db, S, a, b)   every row
//   await one(db, S, a)      the first row, or undefined
//   await run(db, S, a)      the row count
// A ? inside a string literal would be taken for a placeholder: none of ours has one.
export type Param = string | number | boolean | null | Uint8Array;
const dollars = new Map<string, string>();
function toDollars(text: string): string {
  let out = dollars.get(text);
  if (out === undefined) {
    let n = 0;
    out = text.replace(/\?/g, () => `$${++n}`);
    if (dollars.size < 5000) dollars.set(text, out);
  }
  return out;
}

export async function all<T = Record<string, any>>(db: Db, text: string, ...args: Param[]): Promise<T[]> {
  return await db.unsafe(toDollars(text), args as never[], { prepare: true }) as unknown as T[];
}
export async function one<T = Record<string, any>>(db: Db, text: string, ...args: Param[]): Promise<T | undefined> {
  return (await all<T>(db, text, ...args))[0];
}
export async function run(db: Db, text: string, ...args: Param[]): Promise<number> {
  return (await db.unsafe(toDollars(text), args as never[], { prepare: true })).count;
}

// ------------------------------------------------------------------ errors
// Postgres can't be reached at all (down, restarting, not started yet), as
// opposed to a query that failed: the gate answers "try again in a minute".
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED']);
// 57P01-03: the server is shutting down or starting up; 53300: too many connections
const UNAVAILABLE_SQLSTATE = new Set(['57P01', '57P02', '57P03', '53300']);
export function isPgUnavailable(e: unknown): boolean {
  if (e instanceof PgUnavailable) return true;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return e instanceof postgres.PostgresError ? UNAVAILABLE_SQLSTATE.has(code) : UNREACHABLE.has(code);
}
// Thrown before Postgres has been reached and checked (the gate starting before it).
export class PgUnavailable extends Error {
  constructor(message = 'the database is not available') { super(message); }
}

// The SQLSTATE of a Postgres error, or null for anything else.
export function pgCode(e: unknown): string | null {
  return e instanceof postgres.PostgresError ? e.code : null;
}
export const isUniqueViolation = (e: unknown) => pgCode(e) === '23505';

// ------------------------------------------------------------------ schema check (P9)
// Only the installer migrates. A service checks on start that the database has
// exactly the migrations it was built with, and refuses to run otherwise: a
// missing one means the installer didn't run, an unknown one means this code is
// older than the database.
export class SchemaMismatch extends Error {}

export async function checkSchema(sql: Db, sources?: Sources) {
  const want = migrationFiles(sources).map((m) => m.name);
  let have: string[];
  try {
    have = (await sql<{ name: string }[]>`SELECT name FROM ${sql(MIGRATIONS_TABLE)} ORDER BY name`).map((r) => r.name);
  } catch (e) {
    // no list yet; or no right to read it, which the first migration run grants
    if (pgCode(e) === '42P01' || pgCode(e) === '42501') throw new SchemaMismatch('the database has no migrations yet: run the installer');
    throw e;
  }
  const missing = want.filter((n) => !have.includes(n));
  const unknown = have.filter((n) => !want.includes(n));
  if (missing.length) throw new SchemaMismatch(`the database is missing migrations ${missing.join(', ')}: run the installer`);
  if (unknown.length) throw new SchemaMismatch(`the database has migrations this code doesn't know (${unknown.join(', ')}): it is older than the database`);
}
