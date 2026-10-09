// Pamela's MariaDB (127.0.0.1:3307, svc-pammydb), as the studio role.
//
// MariaDB can CREATE DATABASE from any connection, so one pool with no default
// schema does all of slice 1's work: sizes come from information_schema, which
// answers for every database at once -- cheaper than Postgres, where each needs
// its own connection. The per-database map is here because DROP DATABASE fails
// if it is the current schema; slice 4 (introspect, rows) fills it.
import mysql from 'mysql2/promise';
import type { ApplyOutcome, DatabaseFacts, DbUser, Driver, EngineState } from './driver.ts';
import { checkName, checkUserName, defaultRules, isManaged, isProjectDb, PammyDbError, quote, type NameRules } from './ident.ts';
import type { Column, ColumnDefault, ColumnType, ForeignKey, Index, Snapshot, Table, Unique } from './ir.ts';
import { DEFAULT_TEXT_RE } from './ir.ts';
import { statements } from './ddl.ts';
import { applyReason } from './pg.ts';
import type { Step } from './patch.ts';
import type { Access, AccessRole, GrantedRole } from './roles.ts';
import { ACCESS_ROLES } from './roles.ts';
import {
  buildDelete, buildGet, buildInsert, buildList, buildSetLinks, buildUpdate, type RowPage,
} from './rows.ts';

export type MariaEndpoint = { host: string; port: number; user: string; password: string };

type Pool = mysql.Pool;

function open(e: MariaEndpoint, database: string | undefined, limit: number): Pool {
  return mysql.createPool({
    host: e.host,
    port: e.port,
    user: e.user,
    password: e.password,
    database,
    connectionLimit: limit,
    waitForConnections: true,
    connectTimeout: 5_000,
    idleTimeout: 60_000,
    // one statement per query, always: a patch is a list of steps the helper
    // sends one at a time, never a semicolon-joined string
    multipleStatements: false,
    namedPlaceholders: false,
    // DATETIME comes back as a string and is turned into UTC where it is used,
    // rather than through this process's timezone
    dateStrings: true,
  });
}

function friendly(err: unknown, what: string): never {
  const code = (err as { code?: string }).code;
  const errno = (err as { errno?: number }).errno;
  if (errno === 1007) throw new PammyDbError('exists', 'There is already a database with that name.');
  if (errno === 1008 || errno === 1049) throw new PammyDbError('not-found', 'That database is not there any more.');
  if (errno === 1044 || errno === 1142 || errno === 1227) {
    throw new PammyDbError('not-allowed', `The panel is not allowed to ${what}. Ask momolig.`);
  }
  if (errno === 1045) throw new PammyDbError('unavailable', 'The panel\'s MariaDB login was refused. Ask momolig to check the studio password.');
  // ER_DATA_TOO_LONG. A MariaDB TEXT holds 65,535 BYTES -- an accent is two,
  // an emoji four, and rich text's HTML counts too (docs/rich-text-plan.md
  // T16). The panel cannot tell a TEXT from a LONGTEXT (both are "text" to
  // it), so the engine is what says so, in her words -- MariaDB runs strict
  // (the default since 10.2.4), so it refuses rather than cutting it short.
  // the table's own rules, as on Postgres (pg.ts friendly), in her words
  const said = String((err as { message?: string }).message ?? '');
  if (errno === 1062) {
    const m = /Duplicate entry '(.*)' for key/.exec(said);
    throw new PammyDbError('conflict', m
      ? `There is already a record with "${m[1]}", and it has to be different for every record.`
      : 'There is already a record like that, and one of its fields has to be different for every record.');
  }
  if (errno === 1048) {
    const col = /Column '([^']+)'/.exec(said)?.[1];
    throw new PammyDbError('invalid', `${col ?? 'One of the fields'} has to be filled in.`);
  }
  if (errno === 1451 || errno === 1452) throw new PammyDbError('conflict', 'That points at a record that is not there, or another record still points at this one.');
  if (errno === 1366 || errno === 1292 || errno === 1264) throw new PammyDbError('invalid', 'One of the values is not the right kind for its field.');
  if (errno === 1406) {
    const column = /column '([^']+)'/i.exec(String((err as { message?: string }).message ?? ''))?.[1];
    throw new PammyDbError('invalid', `${column ? `${column} is` : 'That is'} too long for this field: on MariaDB a text field holds about 65,000 letters (fewer with accents or emoji). Make it shorter, or split it into more than one record.`);
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ER_GET_CONNECTION_TIMEOUT') {
    throw new PammyDbError('unavailable', 'Her MariaDB is not answering. It may be starting up; try again in a minute, or ask momolig.');
  }
  throw err;
}

function reason(err: unknown, what: string): string {
  try {
    friendly(err, what);
  } catch (mapped) {
    if (mapped instanceof PammyDbError) return mapped.message;
  }
  return 'Her MariaDB gave an answer the panel did not understand. Ask momolig.';
}

// SUM() comes back as a DECIMAL string, COUNT() as a number; both go through here.
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));


// ------------------------------------------------------------------ database users
// Her logins are made for '%', not '127.0.0.1' as docs/databases-plan.md 9
// sketched, and that is not a loosening. The engines are rootless containers, so
// a connection from the host arrives from the podman gateway and never from
// 127.0.0.1 -- `'pamela'@'%'` is how her own admin login already had to be made
// (no-sudo/install-pamela-db.sh), and a `@'127.0.0.1'` login simply could not
// connect. What keeps these logins off the internet is the published port:
// pammydb-mariadb.container binds 127.0.0.1:3307, so '%' means "from this
// machine" in practice.
const MARIA_HOST = '%';

// A user name reaches SQL as a string literal, not an identifier, so backtick
// quoting is the wrong tool. NAME_RE has already ruled out quotes and
// backslashes; this re-checks rather than trusting that.
const userLiteral = (name: string) => `'${checkUserName(name)}'@'${MARIA_HOST}'`;

// One table, used to compose the GRANTs and to read them back -- the same
// both-ends rule as the Postgres plan, so the page can never describe a grant
// the engine does not have.
const MARIA_PLAN: Record<AccessRole, string[]> = {
  read: ['SELECT'],
  write: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  structure: [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
    'CREATE VIEW', 'SHOW VIEW', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
  ],
  admin: [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
    'CREATE VIEW', 'SHOW VIEW', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
    // what an administrator has and a structure editor does not: the parts of a
    // database that are programs rather than tables
    'TRIGGER', 'EVENT', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE',
  ],
};

const sig = (privs: string[]) => [...new Set(privs)].sort().join(',');

function mariaRoleOf(privileges: string[]): GrantedRole | null {
  const held = privileges.filter((p) => p !== 'USAGE');   // USAGE means "no privileges at all"
  if (held.length === 0) return null;
  for (const role of ACCESS_ROLES) if (sig(held) === sig(MARIA_PLAN[role])) return role;
  return 'custom';
}

// ------------------------------------------------------------------ reading a schema back
// information_schema is the only catalog MariaDB has, and it shows a login only
// what it has privileges on -- the same trap Postgres sets with its own
// information_schema. What saves it here is the grant: deploy/studio/roles-maria.sql.in
// gives the studio SELECT on *.*, so it sees every table on the server. If that
// grant is ever narrowed, this is the code that quietly starts lying, and the
// verify check that counts her tables is what would catch it.
//
// COLUMN_TYPE, not DATA_TYPE: it is the one that carries `tinyint(1)` and
// `varchar(50)` whole, and those two are the whole of the difference between a
// yes/no and a number, and between short text and text.
export function mariaType(columnType: string): { type: ColumnType; length?: number; precision?: number; scale?: number } {
  const t = columnType.toLowerCase();
  const m = /^([a-z]+)(?:\((\d+)(?:,\s*(\d+))?\))?/.exec(t);
  if (!m) return { type: 'other' };
  const base = m[1]!;
  const a = m[2] === undefined ? null : Number(m[2]);
  const b = m[3] === undefined ? null : Number(m[3]);
  // unsigned, zerofill and the rest are not things the panel can make, so a
  // column wearing one stays as it is
  const plain = /^[a-z]+(\(\d+(,\s*\d+)?\))?$/.test(t);
  if (!plain) return { type: 'other' };
  switch (base) {
    case 'text': case 'mediumtext': case 'longtext': case 'tinytext': return { type: 'text' };
    case 'varchar': return a === null ? { type: 'other' } : { type: 'short_text', length: a };
    case 'int': return { type: 'integer' };
    case 'decimal': return a === null ? { type: 'other' } : { type: 'decimal', precision: a, scale: b ?? 0 };
    // MariaDB has no boolean: TINYINT(1) is the one every client reads as one,
    // and it is what the printer writes, so this is a round trip rather than a
    // guess. A wider tinyint is a number and says so.
    case 'tinyint': return a === 1 ? { type: 'boolean' } : { type: 'other' };
    case 'date': return { type: 'date' };
    case 'time': return { type: 'time' };
    case 'datetime': return { type: 'timestamptz' };
    // CHAR(36) is what the printer writes for a unique id. A hand-made CHAR(36)
    // reads as one too -- it is the same 36 characters either way, and the
    // panel would print back exactly what is already there.
    case 'char': return a === 36 ? { type: 'uuid' } : { type: 'other' };
    default: return { type: 'other' };
  }
}

export function mariaDefault(value: string | null, extra: string, type: ColumnType): ColumnDefault | null {
  if (/auto_increment/i.test(extra) || value === null) return null;
  const e = value.trim();
  // MariaDB quotes its string defaults in information_schema and wraps
  // expression defaults in parentheses
  if (/^(current_timestamp(\(\d\))?|curdate\(\)|curtime\(\)|\(current_date\)|\(current_time\))$/i.test(e)) return { kind: 'now' };
  const text = /^'((?:[^']|'')*)'$/.exec(e);
  if (text) {
    const v = text[1]!.replaceAll("''", "'");
    if ((type === 'text' || type === 'short_text' || type === 'uuid') && DEFAULT_TEXT_RE.test(v)) return { kind: 'text', value: v };
    return { kind: 'raw', sql: e };
  }
  if (/^-?\d+(\.\d+)?$/.test(e)) {
    if (type === 'boolean') return { kind: 'boolean', value: e !== '0' };
    if (type === 'integer' || type === 'decimal') return { kind: 'number', value: Number(e) };
  }
  if (e.toUpperCase() === 'NULL') return null;
  return { kind: 'raw', sql: e };
}

const mariaOnDelete = (rule: string): ForeignKey['onDelete'] =>
  /cascade/i.test(rule) ? 'cascade' : /set null/i.test(rule) ? 'set null' : 'restrict';

// rules: the site's names (ident.ts NameRules); pammy.org's lists when not given
// maxOpen: as createPgDriver's (the gate's helper, S2 review L1)
export function createMariaDriver(e: MariaEndpoint, rules: NameRules = defaultRules('mariadb'), opts: { maxOpen?: number } = {}): Driver {
  const maintenance = open(e, undefined, 3);
  const perDatabase = new Map<string, Pool>();

  const closeDb = async (name: string) => {
    const pool = perDatabase.get(name);
    if (!pool) return;
    perDatabase.delete(name);
    await pool.end().catch(() => {});
  };

  // One row per schema this role can see, with its size and table count.
  const facts = async (only?: string): Promise<DatabaseFacts[]> => {
    const [rows] = await maintenance.query<mysql.RowDataPacket[]>(
      `SELECT s.SCHEMA_NAME AS name,
              COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes,
              COUNT(CASE WHEN t.TABLE_TYPE = 'BASE TABLE' THEN 1 END) AS tables
         FROM information_schema.SCHEMATA s
         LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
        WHERE (? IS NULL OR s.SCHEMA_NAME = ?)
        GROUP BY s.SCHEMA_NAME
        ORDER BY s.SCHEMA_NAME`,
      [only ?? null, only ?? null],
    );
    return rows.map((r) => ({
      engine: 'mariadb' as const,
      name: String(r.name),
      bytes: num(r.bytes),
      tables: num(r.tables),
      owner: null,
      protectedName: rules.protected.includes(String(r.name).toLowerCase()),
      system: rules.system.includes(String(r.name).toLowerCase()),
      appOwned: isManaged(rules, String(r.name).toLowerCase()),
      projectOwned: isProjectDb(rules, String(r.name).toLowerCase()),
    }));
  };

  // The per-database pool, opened once and kept: `apply` and every row
  // operation share it rather than dialling the engine per request.
  const forDatabase = (database: string) => {
    let pool = perDatabase.get(database);
    if (pool) {
      perDatabase.delete(database);    // most recently used goes last
    } else {
      pool = open(e, database, 2);
      // the oldest pool goes, ended after 30 seconds (a gate request's own limit) so what it runs can finish
      while (opts.maxOpen && perDatabase.size >= opts.maxOpen) {
        const [oldest, old] = perDatabase.entries().next().value as [string, Pool];
        perDatabase.delete(oldest);
        setTimeout(() => { old.end().catch(() => {}); }, 30_000).unref();
      }
    }
    perDatabase.set(database, pool);
    return pool;
  };

  return {
    engine: 'mariadb',
    rules,

    async state(): Promise<EngineState> {
      try {
        const [rows] = await maintenance.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
        return { engine: 'mariadb', ok: true, version: rows[0] ? String(rows[0].v) : null, message: null };
      } catch (err) {
        return { engine: 'mariadb', ok: false, version: null, message: reason(err, 'reach her MariaDB') };
      }
    },

    async list(): Promise<DatabaseFacts[]> {
      try {
        return await facts();
      } catch (err) { friendly(err, 'list her databases'); }
    },

    async create(name: string): Promise<DatabaseFacts> {
      // utf8mb4 so accents and emoji work in her data, not just in her pages
      try {
        await maintenance.query(`CREATE DATABASE ${quote('mariadb', name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      } catch (err) { friendly(err, 'make a database'); }
      return { engine: 'mariadb', name, bytes: 0, tables: 0, owner: null, protectedName: false, system: false };
    },

    async drop(name: string): Promise<void> {
      await closeDb(name);
      try {
        await maintenance.query(`DROP DATABASE ${quote('mariadb', name)}`);
      } catch (err) { friendly(err, 'delete a database'); }
    },

    async size(name: string): Promise<{ bytes: number | null; tables: number }> {
      try {
        const [row] = await facts(name);
        if (!row) throw new PammyDbError('not-found', 'That database is not there any more.');
        return { bytes: row.bytes, tables: row.tables ?? 0 };
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'look inside that database');
      }
    },


    // --------------------------------------------------------------- database users
    // mysql.user is the server's own list. `mysql` is in SYSTEM so no OP may name
    // it as a database, but reading it here is how the helper answers "which
    // logins are there" -- that refuse-list is about the databases she works in.
    async listUsers(): Promise<DbUser[]> {
      try {
        const [rows] = await maintenance.query<mysql.RowDataPacket[]>(
          `SELECT u.User AS name, u.Host AS host,
                  EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES p
                           WHERE p.GRANTEE = CONCAT('\\'', u.User, '\\'@\\'', u.Host, '\\'')
                             AND p.PRIVILEGE_TYPE <> 'USAGE') AS server_wide
             FROM mysql.user u
            ORDER BY u.User, u.Host`);
        return rows.map((r) => ({
          engine: 'mariadb' as const,
          name: String(r.name),
          host: String(r.host),
          canLogin: true,
          reserved: rules.reservedUsers.includes(String(r.name).toLowerCase()) || String(r.name).startsWith('mariadb.'),
          serverWide: !!Number(r.server_wide),
        }));
      } catch (err) { friendly(err, 'list the logins on her MariaDB'); }
    },

    async createUser(name: string, password: string): Promise<DbUser> {
      // Nothing is granted here: a new login can reach nothing at all until she
      // gives it a database.
      try {
        await maintenance.query(`CREATE USER ${userLiteral(name)} IDENTIFIED BY '${password}'`);
      } catch (err) { friendly(err, 'make a database user'); }
      return { engine: 'mariadb', name, host: MARIA_HOST, canLogin: true, reserved: false, serverWide: false };
    },

    async dropUser(name: string): Promise<void> {
      try {
        await maintenance.query(`DROP USER ${userLiteral(name)}`);
      } catch (err) { friendly(err, 'remove a database user'); }
    },

    async setPassword(name: string, password: string): Promise<void> {
      try {
        await maintenance.query(`ALTER USER ${userLiteral(name)} IDENTIFIED BY '${password}'`);
      } catch (err) { friendly(err, 'change a database user\'s password'); }
    },

    // Cheaper than Postgres: every schema's grants are in one table, so the
    // `databases` list is a filter rather than a connection each.
    async accessOf(user: string, databases: string[]): Promise<Access[]> {
      if (databases.length === 0) return [];
      try {
        const [rows] = await maintenance.query<mysql.RowDataPacket[]>(
          `SELECT TABLE_SCHEMA AS name, PRIVILEGE_TYPE AS privilege
             FROM information_schema.SCHEMA_PRIVILEGES
            WHERE GRANTEE = ? AND TABLE_SCHEMA IN (?)`,
          [`'${checkUserName(user)}'@'${MARIA_HOST}'`, databases]);
        const held = new Map<string, string[]>();
        for (const r of rows) {
          const name = String(r.name);
          held.set(name, [...(held.get(name) ?? []), String(r.privilege)]);
        }
        const out: Access[] = [];
        for (const name of databases) {
          const role = mariaRoleOf(held.get(name) ?? []);
          if (role) out.push({ database: name, role });
        }
        return out;
      } catch (err) { friendly(err, 'look at who can reach her databases'); }
    },

    async grant(user: string, database: string, role: AccessRole): Promise<void> {
      try {
        // From nothing, so moving her down from Administrator really takes the
        // rest away. MariaDB has no "no such grant" to complain about here
        // because revoke() already swallows that one.
        await this.revoke(user, database);
        await maintenance.query(
          `GRANT ${MARIA_PLAN[role].join(', ')} ON ${quote('mariadb', database)}.* TO ${userLiteral(user)}`);
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'give a database user access');
      }
    },

    // `REVOKE ALL PRIVILEGES ON db.*` is not the statement to use here, however
    // obviously right it looks. MariaDB answers it with **1044, "Access denied
    // to database u_shop"**, even for a login that plainly may grant on that
    // database a line earlier: the ALL form is checked against the revoker's
    // *database-level* rights in `mysql.db`, and a grant made `ON *.*` puts no
    // row there. Naming the privileges works, and has to.
    //
    // So read what is actually granted and take exactly that away. Which also
    // handles the grant nobody here made: a privilege someone added in HeidiSQL
    // is in this list too, so "No access" means no access rather than "none of
    // the ones the panel knows about".
    async revoke(user: string, database: string): Promise<void> {
      try {
        const [rows] = await maintenance.query<mysql.RowDataPacket[]>(
          `SELECT PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable
             FROM information_schema.SCHEMA_PRIVILEGES
            WHERE GRANTEE = ? AND TABLE_SCHEMA = ?`,
          [`'${checkUserName(user)}'@'${MARIA_HOST}'`, checkName(database)]);
        const held = rows.map((r) => String(r.privilege)).filter((p) => p !== 'USAGE');
        // Nothing to take away is what she asked for and already true.
        if (held.length === 0) return;
        // These came back from the server, not from a request, and are checked
        // anyway before they go back into one.
        for (const p of held) {
          if (!/^[A-Z][A-Z ]{0,40}$/.test(p)) {
            throw new PammyDbError('internal', 'Her MariaDB named a privilege the panel did not recognise. Ask momolig.');
          }
        }
        if (rows.some((r) => String(r.grantable) === 'YES')) held.push('GRANT OPTION');
        await maintenance.query(
          `REVOKE ${held.join(', ')} ON ${quote('mariadb', database)}.* FROM ${userLiteral(user)}`);
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        // 1141: there was no grant to take away after all (a race with her own
        // client). Same answer as none: it is already true.
        if ((err as { errno?: number }).errno === 1141) return;
        friendly(err, 'take a database user\'s access away');
      }
    },

    // --------------------------------------------------------------- the shape inside
    async introspect(database: string): Promise<Snapshot> {
      try {
        const [[cols], [keys], [fks], [tbls]] = await Promise.all([
          maintenance.query<mysql.RowDataPacket[]>(
            `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS coltype,
                    IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, ORDINAL_POSITION`, [database]),
          // PRIMARY and the unique indexes, in their column order
          maintenance.query<mysql.RowDataPacket[]>(
            `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq,
                    NON_UNIQUE AS nonunique
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [database]),
          maintenance.query<mysql.RowDataPacket[]>(
            `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
                    k.ORDINAL_POSITION AS seq, k.REFERENCED_TABLE_NAME AS reftbl,
                    k.REFERENCED_COLUMN_NAME AS refcol, r.DELETE_RULE AS ondelete
               FROM information_schema.KEY_COLUMN_USAGE k
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                 ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
              ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [database]),
          // anything that is only a table, so views are named rather than shown
          maintenance.query<mysql.RowDataPacket[]>(
            `SELECT TABLE_NAME AS tbl, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [database]),
        ]);

        const real = new Set(tbls.filter((r) => String(r.kind) === 'BASE TABLE').map((r) => String(r.tbl)));
        const views = tbls.filter((r) => String(r.kind) !== 'BASE TABLE').length;
        const tables = new Map<string, Table>();
        const table = (name: string): Table => {
          let t = tables.get(name);
          if (!t) {
            t = { name, columns: [], primaryKey: [], uniques: [], foreignKeys: [], indexes: [] };
            tables.set(name, t);
          }
          return t;
        };
        for (const c of cols) {
          const name = String(c.tbl);
          if (!real.has(name)) continue;
          const kind = mariaType(String(c.coltype));
          const column: Column = {
            name: String(c.name),
            type: kind.type,
            sqlType: String(c.coltype),
            required: String(c.nullable) === 'NO',
            default: mariaDefault(c.def === null ? null : String(c.def), String(c.extra ?? ''), kind.type),
          };
          if (kind.length !== undefined) column.length = kind.length;
          if (kind.precision !== undefined) { column.precision = kind.precision; column.scale = kind.scale ?? 0; }
          if (/auto_increment/i.test(String(c.extra ?? ''))) column.identity = true;
          table(name).columns.push(column);
        }
        // one index is many rows here, one per column
        const byIndex = new Map<string, { tbl: string; name: string; unique: boolean; cols: string[] }>();
        for (const k of keys) {
          const tbl = String(k.tbl);
          if (!real.has(tbl)) continue;
          const id = `${tbl}\u0000${String(k.name)}`;
          let entry = byIndex.get(id);
          if (!entry) {
            entry = { tbl, name: String(k.name), unique: num(k.nonunique) === 0, cols: [] };
            byIndex.set(id, entry);
          }
          entry.cols.push(String(k.col));
        }
        const fkNames = new Set(fks.map((f) => `${String(f.tbl)}\u0000${String(f.name)}`));
        for (const entry of byIndex.values()) {
          const t = table(entry.tbl);
          if (entry.name === 'PRIMARY') t.primaryKey = entry.cols;
          // MariaDB makes an index for every foreign key. It is the key, not a
          // rule of its own, so it is not listed twice.
          else if (fkNames.has(`${entry.tbl}\u0000${entry.name}`)) continue;
          else if (entry.unique) t.uniques.push({ name: entry.name, columns: entry.cols } satisfies Unique);
          else t.indexes.push({ name: entry.name, columns: entry.cols, unique: false } satisfies Index);
        }
        const byFk = new Map<string, ForeignKey & { tbl: string }>();
        for (const f of fks) {
          const tbl = String(f.tbl);
          if (!real.has(tbl)) continue;
          const id = `${tbl}\u0000${String(f.name)}`;
          let entry = byFk.get(id);
          if (!entry) {
            entry = {
              tbl, name: String(f.name), columns: [],
              references: { table: String(f.reftbl), columns: [] },
              onDelete: mariaOnDelete(String(f.ondelete ?? '')),
            };
            byFk.set(id, entry);
          }
          entry.columns.push(String(f.col));
          entry.references.columns.push(String(f.refcol));
        }
        for (const f of byFk.values()) {
          const { tbl, ...key } = f;
          table(tbl).foreignKeys.push(key);
        }
        const list = [...tables.values()].filter((t) => t.columns.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        const notes = views > 0
          ? [`${views} view(s) in this database are made out of other tables, so the panel leaves them alone.`]
          : [];
        return { engine: 'mariadb', database, tables: list, notes };
      } catch (err) { friendly(err, 'look inside that database'); }
    },

    // One statement at a time, stopping at the first refusal, because MariaDB
    // cannot undo DDL. What ran, ran. The answer says how far it got and the
    // panel says so in her words rather than offering her a rollback that does
    // not exist (docs/databases-plan.md 8).
    async apply(database: string, steps: Step[]): Promise<ApplyOutcome> {
      const conn = await forDatabase(database).getConnection().catch((err) => friendly(err, 'open that database'));
      let applied = 0;
      try {
        for (; applied < steps.length; applied++) {
          for (const statement of statements('mariadb', steps[applied]!)) await conn.query(statement);
        }
        return { applied, failed: null, rolledBack: false };
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        return { applied, rolledBack: false, failed: { at: applied, message: applyReason(err) } };
      } finally {
        conn.release();
      }
    },

    // --- her rows. Same statements as Postgres, from the same builder, with
    // MariaDB's quoting and `?` parameters (src/pammydb/rows.ts).
    //
    // The same per-database pool `apply` uses: a couple of connections, kept
    // for as long as the helper is up, rather than one per request.
    async listRows(database, q): Promise<RowPage> {
      const pool = forDatabase(database);
      const { rows, count } = buildList('mariadb', q);
      try {
        const [items] = await pool.query(rows.text, rows.params);
        const [totals] = await pool.query(count.text, count.params);
        return {
          items: items as Record<string, unknown>[],
          total: Number((totals as { n: number }[])[0]?.n ?? 0),
        };
      } catch (err) { return friendly(err, 'read that table'); }
    },

    async getRow(database, table, columns, where): Promise<Record<string, unknown> | null> {
      const pool = forDatabase(database);
      const q = buildGet('mariadb', table, columns, where);
      try {
        const [got] = await pool.query(q.text, q.params);
        return (got as Record<string, unknown>[])[0] ?? null;
      } catch (err) { return friendly(err, 'read that record'); }
    },

    // MariaDB has no RETURNING on INSERT, so the new row is read back by the
    // key the engine filled in. `insertId` is that key when the table has an
    // AUTO_INCREMENT; when it does not, what she sent is what identifies it.
    async insertRow(database, table, values, back): Promise<Record<string, unknown>> {
      const pool = forDatabase(database);
      const q = buildInsert('mariadb', table, values);
      try {
        const [res] = await pool.query(q.text, q.params);
        const id = (res as { insertId?: number }).insertId;
        if (!back.length) return {};
        const where = id ? { [back[0]!]: id } : values;
        return (await this.getRow(database, table, back, where)) ?? {};
      } catch (err) { return friendly(err, 'add that record'); }
    },

    async updateRow(database, table, values, where, back): Promise<Record<string, unknown> | null> {
      const pool = forDatabase(database);
      const q = buildUpdate('mariadb', table, values, where);
      if (!q) return this.getRow(database, table, back, where);
      try {
        await pool.query(q.text, q.params);
        // the key may itself have changed, so read back by what it is now
        const after = { ...where };
        for (const [c, v] of Object.entries(values)) if (c in after) after[c] = v;
        return this.getRow(database, table, back, after);
      } catch (err) { return friendly(err, 'change that record'); }
    },

    async setLinks(database, table, here, id, there, ids): Promise<number> {
      const q = buildSetLinks('mariadb', table, here, id, there, ids);
      const conn = await forDatabase(database).getConnection().catch((err) => friendly(err, 'open that database'));
      try {
        await conn.beginTransaction();
        await conn.query(q.remove.text, q.remove.params);
        if (q.add) await conn.query(q.add.text, q.add.params);
        await conn.commit();
        return ids.length;
      } catch (err) {
        await conn.rollback().catch(() => {});
        return friendly(err, 'save those connections');
      } finally {
        conn.release();
      }
    },

    async deleteRow(database, table, where): Promise<boolean> {
      const pool = forDatabase(database);
      const q = buildDelete('mariadb', table, where);
      try {
        const [res] = await pool.query(q.text, q.params);
        return ((res as { affectedRows?: number }).affectedRows ?? 0) > 0;
      } catch (err) { return friendly(err, 'delete that record'); }
    },

    async close(): Promise<void> {
      const all = [...perDatabase.keys()].map(closeDb);
      perDatabase.clear();
      await Promise.all([...all, maintenance.end().catch(() => {})]);
    },
  };
}
