// Pamela's Postgres (127.0.0.1:5433, svc-pammydb), as the studio role.
//
// Two kinds of connection, because CREATE DATABASE and DROP DATABASE cannot run
// against the database they are about: one maintenance pool on `postgres`, and
// per-database connections opened on demand and cached by name. Not the panel's
// own Postgres on :5434 -- see docs/postgres-plan.md P1 and studio-plan.md S7.
import postgres from 'postgres';
import type { ApplyOutcome, DatabaseFacts, DbUser, Driver, EngineState } from './driver.ts';
import { defaultRules, isManaged, isProjectDb, managedSchema, PammyDbError, quote, type NameRules } from './ident.ts';
import type { Column, ColumnDefault, ColumnType, ForeignKey, Index, Snapshot, Table, Unique } from './ir.ts';
import { DEFAULT_TEXT_RE } from './ir.ts';
import { statements } from './ddl.ts';
import type { Step } from './patch.ts';
import type { Access, AccessRole, GrantedRole } from './roles.ts';
import { ACCESS_ROLES } from './roles.ts';
import {
  buildDelete, buildSetLinks, buildGet, buildInsert, buildList, buildUpdate, type RowPage,
} from './rows.ts';

export type PgEndpoint = { host: string; port: number; user: string; password: string };

const MAINTENANCE = 'postgres';

type PgPool = ReturnType<typeof open>;

// schema: where this database's tables are (an app's may name its own: examprep's "prep",
// docs/phase8-plan.md 8-4); unqualified names in rows find them there
function open(e: PgEndpoint, database: string, max: number, schema = 'public') {
  return postgres({
    host: e.host,
    port: e.port,
    database,
    username: e.user,
    password: e.password,
    max,
    idle_timeout: 60,
    connect_timeout: 5,
    max_lifetime: 30 * 60,
    connection: { application_name: 'pammy-studio', ...(schema !== 'public' ? { search_path: schema } : {}) } as Record<string, string>,
    onnotice: () => {},
  });
}

// Postgres says why in a code; she gets a sentence. Anything unmapped is a bug
// or a broken server, and reaches the log as 'internal'.
function friendly(e: unknown, what: string): never {
  const code = (e as { code?: string }).code;
  switch (code) {
    case '42P04': throw new PammyDbError('exists', 'There is already a database with that name.');
    case '3D000': throw new PammyDbError('not-found', 'That database is not there any more.');
    case '42501': throw new PammyDbError('not-allowed', `The panel is not allowed to ${what}. Ask momolig.`);
    case '55006': throw new PammyDbError('busy', 'Something is still connected to that database. Close it and try again.');
    case '53300': throw new PammyDbError('busy', 'The database server has no free connections right now. Try again in a minute.');
    // a pooled connection ended under it: the database was just deleted by the other helper
    // (S2), or the server restarted. The pool opens a new one on the next request.
    case '57P01':
    case 'CONNECTION_CLOSED':
    case 'CONNECTION_ENDED':
    case 'CONNECTION_DESTROYED':
      throw new PammyDbError('unavailable', 'The connection to her Postgres was closed. Try again.');
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'CONNECT_TIMEOUT':
      throw new PammyDbError('unavailable', 'Her Postgres is not answering. It may be starting up; try again in a minute, or ask momolig.');
    case '28P01':
    case '28000':
      throw new PammyDbError('unavailable', 'The panel\'s Postgres login was refused. Ask momolig to check the studio password.');
    // A record the table's own rules refuse -- from the app's forms, a program,
    // or a form of hers saving into it (docs/form-to-database-plan.md F10). In
    // her words, naming the field, instead of the engine's.
    case '23505': {
      const m = /Key \(([^)]+)\)=\((.*)\) already exists/.exec(String((e as { detail?: string }).detail ?? ''));
      throw new PammyDbError('conflict', m
        ? `There is already a record with ${m[1]} "${m[2]}", and it has to be different for every record.`
        : 'There is already a record like that, and one of its fields has to be different for every record.');
    }
    case '23502': {
      const col = (e as { column_name?: string }).column_name;
      throw new PammyDbError('invalid', `${col ?? 'One of the fields'} has to be filled in.`);
    }
    case '23503': throw new PammyDbError('conflict', 'That points at a record that is not there, or another record still points at this one.');
    case '22001': throw new PammyDbError('invalid', 'One of the values is too long for its field.');
    case '22P02': case '22003': case '22007': case '22008':
      throw new PammyDbError('invalid', 'One of the values is not the right kind for its field.');
    default: throw e;
  }
}

// What went wrong with one step of a patch. Unlike everything else here the
// engine's own words are kept: "column \"total\" cannot be cast automatically to
// type integer" says exactly which field and why, and no sentence the panel
// could write in its place would help her more.
export function applyReason(err: unknown): string {
  const e = err as { message?: string; detail?: string; hint?: string; sqlMessage?: string };
  const message = (e.sqlMessage ?? e.message ?? '').split('\n')[0]!.trim();
  return [message, e.detail, e.hint].filter(Boolean).join(' ').slice(0, 400)
    || 'The database refused that change without saying why.';
}

// The sentence friendly() would have thrown, for the places that report
// instead of failing.
function reason(err: unknown, what: string): string {
  try {
    friendly(err, what);
  } catch (mapped) {
    if (mapped instanceof PammyDbError) return mapped.message;
  }
  return 'Her Postgres gave an answer the panel did not understand. Ask momolig.';
}


// ------------------------------------------------------------------ the four roles
// One table, used twice: to compose the GRANTs, and to read them back. Writing
// it once is the point -- if granting and detecting could drift, the page would
// eventually tell her something the engine does not agree with.
//
// Postgres keeps privileges per object, so a role is four grants: on the
// database, on the schema, on the tables and sequences in it, and on the tables
// she has not made yet (ALTER DEFAULT PRIVILEGES).
type PgGrantPlan = { database: string[]; schema: string[]; tables: string[]; sequences: string[]; routines: string[] };

const PG_PLAN: Record<AccessRole, PgGrantPlan> = {
  read: {
    database: ['CONNECT'],
    schema: ['USAGE'],
    tables: ['SELECT'],
    sequences: ['SELECT'],
    routines: [],
  },
  write: {
    // TEMPORARY: ORDER BY and big joins spill to temporary tables, so a login
    // that may change data is no use without it.
    database: ['CONNECT', 'TEMPORARY'],
    schema: ['USAGE'],
    tables: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    sequences: ['SELECT', 'USAGE', 'UPDATE'],
    routines: ['EXECUTE'],
  },
  structure: {
    database: ['CONNECT', 'TEMPORARY'],
    // CREATE on the schema is what "can add and change tables" means
    schema: ['USAGE', 'CREATE'],
    tables: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
    sequences: ['SELECT', 'USAGE', 'UPDATE'],
    routines: ['EXECUTE'],
  },
  admin: {
    // CREATE on the database means new schemas -- the one thing above a
    // structure editor. Dropping the database is not here and cannot be: only
    // its owner may do that, and she is not it.
    database: ['CONNECT', 'TEMPORARY', 'CREATE'],
    schema: ['USAGE', 'CREATE'],
    tables: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
    sequences: ['SELECT', 'USAGE', 'UPDATE'],
    routines: ['EXECUTE'],
  },
};

const sig = (privs: string[]) => [...new Set(privs)].sort().join(',');

// Read back: the shape on the engine, matched against the four the panel makes.
// Anything else is `custom` and says so -- the panel does not guess which of the
// four a hand-made grant is nearest to.
function pgRoleOf(database: string[], schema: string[], defaults: string[]): GrantedRole | null {
  if (database.length === 0 && schema.length === 0 && defaults.length === 0) return null;
  for (const role of ACCESS_ROLES) {
    const p = PG_PLAN[role];
    if (sig(database) === sig(p.database) && sig(schema) === sig(p.schema) && sig(defaults) === sig(p.tables)) return role;
  }
  return 'custom';
}


// ALTER DEFAULT PRIVILEGES only works for roles the caller is a member of, and
// it is per creating role. These are the ones that make tables in her
// databases: the studio (slice 4's Apply) and her own login. Ask the engine
// which of them this connection may speak for rather than assuming, so an
// adopted database owned by someone else fails in one clear place instead of
// half way through a grant.
const CREATORS = ['pammy_studio', 'pamela'];

async function defaultPrivilegeRoles(sql: PgPool): Promise<string[]> {
  const rows = await sql<{ rolname: string }[]>`
    SELECT rolname FROM pg_catalog.pg_roles
     WHERE rolname = ANY(${CREATORS})
       AND pg_catalog.pg_has_role(current_user, oid, 'USAGE')
     ORDER BY rolname`;
  return rows.map((r) => r.rolname);
}


// Postgres will only let a table's owner say who may use it. In a database the
// panel made, every table is the studio's or hers, so this never fires. In one
// she adopted it can: a table left behind by some other login is not ours to
// hand out, and saying which is much more use to her than "not allowed".
function notOurs(err: unknown): void {
  if ((err as { code?: string }).code !== '42501') return;
  throw new PammyDbError('not-allowed',
    'Something in that database belongs to a different login, so the panel cannot say who may use it. Ask momolig.');
}

// ------------------------------------------------------------------ reading a schema back
// Her tables live in `public`; anything else in the database belongs to an
// extension or to something she set up herself, and the studio says so rather
// than showing it (docs/databases-plan.md 14). An app's database may name another
// (the site's rules, schemaOf below).

// format_type() is one string that already carries the length and the
// precision, so there is one place that decides what a column is rather than
// three columns of information_schema that can disagree.
//
// Anything not in this list reads as `other` and keeps the engine's own words.
// That is not a gap: an adopted database is full of types the panel does not
// offer, and the honest thing is to show them and leave them alone.
export function pgType(formatted: string): { type: ColumnType; length?: number; precision?: number; scale?: number } {
  const m = /^([a-z ]+?)(?:\((\d+)(?:,\s*(\d+))?\))?(\[\])?$/.exec(formatted);
  if (!m || m[4]) return { type: 'other' };
  const base = m[1];
  const a = m[2] === undefined ? null : Number(m[2]);
  const b = m[3] === undefined ? null : Number(m[3]);
  switch (base) {
    case 'text': return { type: 'text' };
    // a varchar with no length is a text field wearing another name, but the
    // panel did not make it and cannot print it back, so it stays `other`
    case 'character varying': return a === null ? { type: 'other' } : { type: 'short_text', length: a };
    case 'integer': return { type: 'integer' };
    case 'numeric': return a === null ? { type: 'other' } : { type: 'decimal', precision: a, scale: b ?? 0 };
    case 'boolean': return { type: 'boolean' };
    case 'date': return { type: 'date' };
    case 'time without time zone': return { type: 'time' };
    case 'timestamp with time zone': return { type: 'timestamptz' };
    case 'uuid': return { type: 'uuid' };
    default: return { type: 'other' };
  }
}

// What Postgres says a column starts out as, turned back into the IR where it
// fits and carried as the engine's own words where it does not
// (src/pammydb/ir.ts, `raw`).
export function pgDefault(expr: string | null, identity: boolean, type: ColumnType): ColumnDefault | null {
  // the engine filling the number in IS the starting value; saying it twice
  // would make a diff out of nothing
  if (identity || expr === null) return null;
  const e = expr.trim();
  if (/^(now\(\)|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(e)) return { kind: 'now' };
  if (/^nextval\(/i.test(e)) return { kind: 'raw', sql: e };
  const text = /^'((?:[^']|'')*)'(?:::[a-z ]+(?:\(\d+(?:,\s*\d+)?\))?)?$/i.exec(e);
  if (text) {
    const value = text[1]!.replaceAll("''", "'");
    if ((type === 'text' || type === 'short_text' || type === 'uuid') && DEFAULT_TEXT_RE.test(value)) {
      return { kind: 'text', value };
    }
    return { kind: 'raw', sql: e };
  }
  if (/^-?\d+(\.\d+)?$/.test(e) && (type === 'integer' || type === 'decimal')) return { kind: 'number', value: Number(e) };
  if (/^(true|false)$/i.test(e) && type === 'boolean') return { kind: 'boolean', value: /^true$/i.test(e) };
  return { kind: 'raw', sql: e };
}

// 'a' no action, 'r' restrict, 'c' cascade, 'n' set null, 'd' set default.
// Anything the IR cannot say reads as restrict, which is what both engines do
// when nothing is asked for.
const pgOnDelete = (c: string): ForeignKey['onDelete'] =>
  c === 'c' ? 'cascade' : c === 'n' ? 'set null' : 'restrict';

// rules: the site's names (ident.ts NameRules); pammy.org's lists when not given
// maxOpen: at most this many databases' pools at once, the least recently used one put away
// first (the gate's helper, S2 review L1: two connections each, so the gate can't use up the
// studio login's CONNECTION LIMIT by asking about many databases). Unset: no cap (the panel's).
export function createPgDriver(e: PgEndpoint, rules: NameRules = defaultRules('postgres'), opts: { maxOpen?: number } = {}): Driver {
  const maintenance = open(e, MAINTENANCE, 3);
  const perDatabase = new Map<string, PgPool>();
  // where a database's tables are: its own schema if an app's names one, else public
  const schemaOf = (name: string) => (isManaged(rules, name) ? managedSchema(rules, name) : 'public');

  const db = (name: string) => {
    let sql = perDatabase.get(name);
    if (sql) {
      perDatabase.delete(name);      // most recently used goes last
    } else {
      sql = open(e, name, 2, schemaOf(name));
      // the oldest pool goes; what it is running gets 30 seconds to finish (a gate request's own limit)
      while (opts.maxOpen && perDatabase.size >= opts.maxOpen) {
        const [oldest, pool] = perDatabase.entries().next().value as [string, PgPool];
        perDatabase.delete(oldest);
        void pool.end({ timeout: 30 }).catch(() => {});
      }
    }
    perDatabase.set(name, sql);
    return sql;
  };
  const closeDb = async (name: string) => {
    const sql = perDatabase.get(name);
    if (!sql) return;
    perDatabase.delete(name);
    await sql.end({ timeout: 5 }).catch(() => {});
  };

  return {
    engine: 'postgres',
    rules,

    // Never throws: the dashboard shows one engine being down without losing the other.
    async state(): Promise<EngineState> {
      try {
        const [row] = await maintenance<{ v: string }[]>`SELECT version() AS v`;
        return { engine: 'postgres', ok: true, version: row?.v?.split(' ').slice(0, 2).join(' ') ?? null, message: null };
      } catch (err) {
        return { engine: 'postgres', ok: false, version: null, message: reason(err, 'reach her Postgres') };
      }
    },

    async list(): Promise<DatabaseFacts[]> {
      try {
        // pg_database_size needs CONNECT, so ask first and leave the size null
        // rather than failing the whole list on one database we can't look into.
        const rows = await maintenance<{ name: string; owner: string; bytes: string | null }[]>`
          SELECT d.datname AS name,
                 pg_catalog.pg_get_userbyid(d.datdba) AS owner,
                 CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT')
                      THEN pg_catalog.pg_database_size(d.oid)::text END AS bytes
            FROM pg_catalog.pg_database d
           WHERE NOT d.datistemplate AND d.datallowconn
           ORDER BY d.datname`;
        return rows.map((r) => ({
          engine: 'postgres' as const,
          name: r.name,
          bytes: r.bytes === null ? null : Number(r.bytes),
          tables: null,
          owner: r.owner,
          protectedName: rules.protected.includes(r.name),
          system: rules.system.includes(r.name),
          appOwned: isManaged(rules, r.name),
          projectOwned: isProjectDb(rules, r.name),
        }));
      } catch (err) { friendly(err, 'list her databases'); }
    },

    async create(name: string): Promise<DatabaseFacts> {
      // CREATE DATABASE cannot be prepared or run inside a transaction, so it
      // goes over the simple protocol. The name is quoted, never interpolated
      // raw: quote() checks it again first.
      try {
        await maintenance.unsafe(`CREATE DATABASE ${quote('postgres', name)}`).simple();
        // Postgres lets everyone with a login connect to a new database unless
        // told otherwise, so a database user made for the recipes app could read
        // the accounts one. Access here is something she grants, never something
        // a login already has (docs/databases-plan.md 9).
        await maintenance.unsafe(`REVOKE CONNECT ON DATABASE ${quote('postgres', name)} FROM PUBLIC`).simple();
      } catch (err) { friendly(err, 'make a database'); }
      return { engine: 'postgres', name, bytes: null, tables: 0, owner: e.user, protectedName: false, system: false };
    },

    async drop(name: string): Promise<void> {
      // our own connection to it would be the thing blocking the drop
      await closeDb(name);
      // ...and so would the other helper's: the gate's (S2) is a process of its own, with pools
      // of its own, under the same login. Only this login's sessions are ended, never anyone
      // else's: her apps' logins connected to it still make the drop refuse ("busy"), as
      // before -- which is why this is not DROP ... WITH (FORCE). Tried twice, in case the
      // other helper connects again in between.
      for (let attempt = 1; ; attempt++) {
        try {
          await maintenance`
            SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
             WHERE datname = ${name} AND usename = current_user AND pid <> pg_catalog.pg_backend_pid()`;
          await maintenance.unsafe(`DROP DATABASE ${quote('postgres', name)}`).simple();
          return;
        } catch (err) {
          if (attempt < 2 && (err as { code?: string }).code === '55006') continue;
          friendly(err, 'delete a database');
        }
      }
    },

    async size(name: string): Promise<{ bytes: number | null; tables: number }> {
      try {
        const [meta] = await maintenance<{ bytes: string | null }[]>`
          SELECT CASE WHEN pg_catalog.has_database_privilege(${name}, 'CONNECT')
                      THEN pg_catalog.pg_database_size(${name})::text END AS bytes`;
        if (!meta) throw new PammyDbError('not-found', 'That database is not there any more.');
        // pg_class, not information_schema.tables: information_schema shows only
        // what THIS role has privileges on, so a table she made as another role
        // would be missing from the count and she would be told her database is
        // empty. The catalogs tell the truth. (Introspect in slice 4 has the same
        // trap.)
        const [count] = await db(name)<{ n: string }[]>`
          SELECT count(*)::text AS n
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'
             AND n.nspname NOT LIKE 'pg_temp%'`;
        return { bytes: meta.bytes === null ? null : Number(meta.bytes), tables: Number(count?.n ?? 0) };
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'look inside that database');
      }
    },


    // --------------------------------------------------------------- database users
    // Roles that can log in. Group roles and the server's own are listed too --
    // she should see what is on her server -- but `reserved` marks the ones the
    // panel will not touch (src/pammydb/ident.ts RESERVED_USERS).
    async listUsers(): Promise<DbUser[]> {
      try {
        const rows = await maintenance<{ name: string; canlogin: boolean; server_wide: boolean }[]>`
          SELECT rolname AS name, rolcanlogin AS canlogin,
                 (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS server_wide
            FROM pg_catalog.pg_roles
           WHERE rolname NOT LIKE 'pg\_%'
           ORDER BY rolname`;
        return rows.map((r) => ({
          engine: 'postgres' as const,
          name: r.name,
          host: null,                                   // a Postgres role is just a name
          canLogin: r.canlogin,
          reserved: rules.reservedUsers.includes(r.name),
          serverWide: r.server_wide,
        }));
      } catch (err) { friendly(err, 'list the logins on her Postgres'); }
    },

    async createUser(name: string, password: string): Promise<DbUser> {
      // No privileges of any kind: a new login can reach nothing until she
      // grants it a database. And nothing above a plain login, ever -- the
      // studio has CREATEDB itself, so saying so explicitly is what stops a
      // login it makes from inheriting it.
      try {
        await maintenance.unsafe(
          `CREATE ROLE ${quote('postgres', name)} LOGIN PASSWORD '${password}'
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
        ).simple();
      } catch (err) { friendly(err, 'make a database user'); }
      return { engine: 'postgres', name, host: null, canLogin: true, reserved: false, serverWide: false };
    },

    async dropUser(name: string): Promise<void> {
      // A role still holding privileges cannot be dropped, and Postgres says so
      // in a sentence about "objects", which would mean nothing to her. Take the
      // access away first, in every database it has any in, then drop.
      try {
        const held = await this.accessOf(name, (await this.list()).map((d) => d.name));
        for (const a of held) await this.revoke(name, a.database);
        await maintenance.unsafe(`DROP ROLE ${quote('postgres', name)}`).simple();
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'remove a database user');
      }
    },

    async setPassword(name: string, password: string): Promise<void> {
      try {
        await maintenance.unsafe(`ALTER ROLE ${quote('postgres', name)} WITH PASSWORD '${password}'`).simple();
      } catch (err) { friendly(err, 'change a database user\'s password'); }
    },

    // What this user has, per database. Read from the access lists themselves
    // (aclexplode), not has_database_privilege: that one answers "could this
    // login get in", which is also true when PUBLIC was never locked down, and
    // every user would look as though she had granted it something.
    async accessOf(user: string, databases: string[]): Promise<Access[]> {
      try {
        const rows = await maintenance<{ name: string; privilege_type: string }[]>`
          SELECT d.datname AS name, a.privilege_type
            FROM pg_catalog.pg_database d
            CROSS JOIN LATERAL aclexplode(d.datacl) a
            JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
           WHERE r.rolname = ${user} AND d.datname = ANY(${databases})`;
        const onDatabase = new Map<string, string[]>();
        for (const r of rows) onDatabase.set(r.name, [...(onDatabase.get(r.name) ?? []), r.privilege_type]);

        // Only the databases it has something on are worth a connection of their
        // own: on a shelf of twenty, that is usually one or two.
        const out: Access[] = [];
        for (const name of databases) {
          const database = onDatabase.get(name);
          if (!database) continue;
          const sql = db(name);
          const [schema, defaults] = await Promise.all([
            sql<{ privilege_type: string }[]>`
              SELECT a.privilege_type
                FROM pg_catalog.pg_namespace n
                CROSS JOIN LATERAL aclexplode(n.nspacl) a
                JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
               WHERE n.nspname = 'public' AND r.rolname = ${user}`,
            sql<{ privilege_type: string }[]>`
              SELECT DISTINCT a.privilege_type
                FROM pg_catalog.pg_default_acl d
                JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
                CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
               WHERE n.nspname = 'public' AND d.defaclobjtype = 'r' AND r.rolname = ${user}`,
          ]);
          const role = pgRoleOf(database, schema.map((r) => r.privilege_type), defaults.map((r) => r.privilege_type));
          if (role) out.push({ database: name, role });
        }
        return out;
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'look at who can reach her databases');
      }
    },

    async grant(user: string, database: string, role: AccessRole): Promise<void> {
      const p = PG_PLAN[role];
      const u = quote('postgres', user);
      try {
        // Start from nothing, so moving her from Administrator down to Read only
        // really takes the rest away rather than adding to it.
        await this.revoke(user, database);
        await maintenance.unsafe(`GRANT ${p.database.join(', ')} ON DATABASE ${quote('postgres', database)} TO ${u}`).simple();

        const sql = db(database);
        const creators = await defaultPrivilegeRoles(sql);
        await sql.begin(async (q) => {
          await q.unsafe(`GRANT ${p.schema.join(', ')} ON SCHEMA public TO ${u}`);
          await q.unsafe(`GRANT ${p.tables.join(', ')} ON ALL TABLES IN SCHEMA public TO ${u}`);
          await q.unsafe(`GRANT ${p.sequences.join(', ')} ON ALL SEQUENCES IN SCHEMA public TO ${u}`);
          if (p.routines.length) await q.unsafe(`GRANT ${p.routines.join(', ')} ON ALL ROUTINES IN SCHEMA public TO ${u}`);
          // ...and the tables that do not exist yet. Default privileges are kept
          // per creating role, not per schema, so one is needed for each role
          // that makes tables here: the studio itself (slice 4's Apply) and her
          // own login. A table made by some third login is not covered -- that
          // is what the re-grant after Apply is for.
          for (const c of creators) {
            await q.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote('postgres', c)} IN SCHEMA public GRANT ${p.tables.join(', ')} ON TABLES TO ${u}`);
            await q.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote('postgres', c)} IN SCHEMA public GRANT ${p.sequences.join(', ')} ON SEQUENCES TO ${u}`);
            if (p.routines.length) await q.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote('postgres', c)} IN SCHEMA public GRANT ${p.routines.join(', ')} ON ROUTINES TO ${u}`);
          }
        });
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        notOurs(err);
        friendly(err, 'give a database user access');
      }
    },

    // Default privileges are kept per creating role, and only that role may set its own: so
    // the studio is let act as the owner login (SET, never INHERIT: it gets none of the
    // owner's rights by being a member) for one transaction, and says, as it, that the app
    // login may use what it makes -- and the studio read it (tried on PG17, 2026-10-06).
    async projectAccess(database: string, owner: string, app: string): Promise<void> {
      const o = quote('postgres', owner);
      const a = quote('postgres', app);
      const me = quote('postgres', e.user);
      const w = PG_PLAN.write;
      try {
        await maintenance.unsafe(`GRANT ${o} TO ${me} WITH INHERIT FALSE, SET TRUE`).simple();
        await db(database).begin(async (q) => {
          await q.unsafe(`SET LOCAL ROLE ${o}`);
          await q.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${w.tables.join(', ')} ON TABLES TO ${a}`);
          await q.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${w.sequences.join(', ')} ON SEQUENCES TO ${a}`);
          await q.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${w.routines.join(', ')} ON ROUTINES TO ${a}`);
          await q.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${me}`);
          await q.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${me}`);
          // ...and what it made already (a database kept from an earlier project)
          await q.unsafe(`GRANT ${w.tables.join(', ')} ON ALL TABLES IN SCHEMA public TO ${a}`);
          await q.unsafe(`GRANT ${w.sequences.join(', ')} ON ALL SEQUENCES IN SCHEMA public TO ${a}`);
          await q.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${me}`);
        });
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        friendly(err, 'say what a project\'s login may use');
      }
    },

    async revoke(user: string, database: string): Promise<void> {
      const u = quote('postgres', user);
      try {
        const sql = db(database);
        const creators = await defaultPrivilegeRoles(sql);
        await sql.begin(async (q) => {
          // The default privileges go first: they are what would quietly hand
          // the login the next table she makes, long after she took its access
          // away.
          for (const c of creators) {
            for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
              await q.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote('postgres', c)} IN SCHEMA public REVOKE ALL ON ${kind} FROM ${u}`);
            }
          }
          for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
            await q.unsafe(`REVOKE ALL PRIVILEGES ON ALL ${kind} IN SCHEMA public FROM ${u}`);
          }
          await q.unsafe(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${u}`);
        });
        await maintenance.unsafe(`REVOKE ALL PRIVILEGES ON DATABASE ${quote('postgres', database)} FROM ${u}`).simple();
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        notOurs(err);
        friendly(err, 'take a database user\'s access away');
      }
    },

    // --------------------------------------------------------------- the shape inside
    // pg_catalog, never information_schema. information_schema shows a role only
    // the tables it has privileges on, so a table she made as `pamela` and never
    // granted to the studio would simply be absent -- and the page would tell her
    // her database is empty while her data sat in it. The catalogs are readable by
    // everyone and tell the truth. (Slice 1's table count learned this first.)
    async introspect(database: string): Promise<Snapshot> {
      const sql = db(database);
      const SCHEMA = schemaOf(database);
      try {
        const [cols, cons, idx, others] = await Promise.all([
          sql<{ tbl: string; name: string; sqltype: string; required: boolean; identity: boolean; def: string | null }[]>`
            SELECT c.relname AS tbl, a.attname AS name,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS sqltype,
                   a.attnotnull AS required,
                   a.attidentity <> '' AS identity,
                   pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def
              FROM pg_catalog.pg_attribute a
              JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE n.nspname = ${SCHEMA} AND c.relkind IN ('r', 'p')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attnum`,
          sql<{ tbl: string; name: string; kind: string; cols: string[]; reftbl: string | null; refcols: string[] | null; ondelete: string }[]>`
            SELECT c.relname AS tbl, con.conname AS name, con.contype::text AS kind,
                   (SELECT array_agg(a.attname ORDER BY k.ord)
                      FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num) AS cols,
                   fc.relname AS reftbl,
                   (SELECT array_agg(a.attname ORDER BY k.ord)
                      FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num) AS refcols,
                   con.confdeltype::text AS ondelete
              FROM pg_catalog.pg_constraint con
              JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
             WHERE n.nspname = ${SCHEMA} AND con.contype IN ('p', 'u', 'f')
             ORDER BY c.relname, con.conname`,
          // constraint-backed indexes are left out: they are the constraint,
          // and showing both would read as two rules where there is one
          sql<{ tbl: string; name: string; uniq: boolean; cols: string[] }[]>`
            SELECT c.relname AS tbl, i.relname AS name, ix.indisunique AS uniq,
                   (SELECT array_agg(a.attname ORDER BY k.ord)
                      FROM unnest(ix.indkey) WITH ORDINALITY AS k(num, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.num) AS cols
              FROM pg_catalog.pg_index ix
              JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
              JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ${SCHEMA} AND NOT ix.indisprimary
               AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = ix.indexrelid)
             ORDER BY c.relname, i.relname`,
          // her tables outside `public`: counted and mentioned, never shown
          sql<{ nspname: string; n: string }[]>`
            SELECT n.nspname, count(*)::text AS n
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema', ${SCHEMA})
               AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
             GROUP BY n.nspname ORDER BY n.nspname`,
        ]);

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
          const kind = pgType(c.sqltype);
          const column: Column = {
            name: c.name,
            type: kind.type,
            sqlType: c.sqltype,
            required: c.required,
            default: pgDefault(c.def, c.identity, kind.type),
          };
          if (kind.length !== undefined) column.length = kind.length;
          if (kind.precision !== undefined) { column.precision = kind.precision; column.scale = kind.scale ?? 0; }
          if (c.identity) column.identity = true;
          table(c.tbl).columns.push(column);
        }
        for (const con of cons) {
          const t = table(con.tbl);
          const columns = con.cols ?? [];
          if (con.kind === 'p') t.primaryKey = columns;
          else if (con.kind === 'u') t.uniques.push({ name: con.name, columns } satisfies Unique);
          else if (con.reftbl) {
            t.foreignKeys.push({
              name: con.name,
              columns,
              references: { table: con.reftbl, columns: con.refcols ?? [] },
              onDelete: pgOnDelete(con.ondelete),
            } satisfies ForeignKey);
          }
        }
        for (const i of idx) {
          // an index on an expression has no plain column names; it is real, so
          // it is listed, but with nothing to say about its fields
          table(i.tbl).indexes.push({ name: i.name, columns: i.cols ?? [], unique: i.uniq } satisfies Index);
        }
        // a table with no columns at all is not one she can be shown anything
        // useful about, and the IR does not allow it
        const list = [...tables.values()].filter((t) => t.columns.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        const notes = others.map((o) => `${o.n} table(s) in this database are in "${o.nspname}" rather than the usual place, so the panel leaves them alone.`);
        return { engine: 'postgres', database, tables: list, notes };
      } catch (err) { friendly(err, 'look inside that database'); }
    },

    // One transaction: Postgres can undo DDL, so a patch that fails leaves
    // nothing behind and `applied` is 0. That is the whole difference from
    // MariaDB, and the panel is told which happened rather than guessing.
    async apply(database: string, steps: Step[]): Promise<ApplyOutcome> {
      const sql = db(database);
      let at = 0;
      try {
        await sql.begin(async (q) => {
          for (; at < steps.length; at++) {
            for (const statement of statements('postgres', steps[at]!)) await q.unsafe(statement);
          }
        });
        return { applied: steps.length, failed: null, rolledBack: false };
      } catch (err) {
        if (err instanceof PammyDbError) throw err;
        return { applied: 0, rolledBack: true, failed: { at, message: applyReason(err) } };
      }
    },

    // --- her rows. Every statement comes from src/pammydb/rows.ts, which
    // quotes identifiers and passes values as parameters; nothing here
    // composes SQL from anything a browser said.
    async listRows(database, q): Promise<RowPage> {
      const sql = db(database);
      const { rows, count } = buildList('postgres', q);
      try {
        const [items, totals] = await Promise.all([
          sql.unsafe(rows.text, rows.params as never[]),
          sql.unsafe(count.text, count.params as never[]),
        ]);
        return { items: [...items] as Record<string, unknown>[], total: Number(totals[0]?.n ?? 0) };
      } catch (err) { return friendly(err, 'read that table'); }
    },

    async getRow(database, table, columns, where): Promise<Record<string, unknown> | null> {
      const sql = db(database);
      const q = buildGet('postgres', table, columns, where);
      try {
        const got = await sql.unsafe(q.text, q.params as never[]);
        return (got[0] as Record<string, unknown>) ?? null;
      } catch (err) { return friendly(err, 'read that record'); }
    },

    async insertRow(database, table, values, back): Promise<Record<string, unknown>> {
      const sql = db(database);
      const q = buildInsert('postgres', table, values);
      // RETURNING: Postgres hands the whole new row back, so the id the engine
      // filled in needs no second look
      const text = back.length ? `${q.text} RETURNING ${back.map((c) => quote('postgres', c)).join(', ')}` : q.text;
      try {
        const got = await sql.unsafe(text, q.params as never[]);
        return (got[0] as Record<string, unknown>) ?? {};
      } catch (err) { return friendly(err, 'add that record'); }
    },

    async updateRow(database, table, values, where, back): Promise<Record<string, unknown> | null> {
      const sql = db(database);
      const q = buildUpdate('postgres', table, values, where);
      if (!q) return this.getRow(database, table, back, where);
      const text = back.length ? `${q.text} RETURNING ${back.map((c) => quote('postgres', c)).join(', ')}` : q.text;
      try {
        const got = await sql.unsafe(text, q.params as never[]);
        return (got[0] as Record<string, unknown>) ?? null;
      } catch (err) { return friendly(err, 'change that record'); }
    },

    async deleteRow(database, table, where): Promise<boolean> {
      const sql = db(database);
      const q = buildDelete('postgres', table, where);
      try {
        const got = await sql.unsafe(q.text, q.params as never[]);
        return (got.count ?? 0) > 0;
      } catch (err) { return friendly(err, 'delete that record'); }
    },

    async setLinks(database, table, here, id, there, ids): Promise<number> {
      const sql = db(database);
      const q = buildSetLinks('postgres', table, here, id, there, ids);
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(q.remove.text, q.remove.params as never[]);
          if (q.add) await tx.unsafe(q.add.text, q.add.params as never[]);
        });
        return ids.length;
      } catch (err) { return friendly(err, 'save those connections'); }
    },

    async close(): Promise<void> {
      const all = [...perDatabase.keys()].map(closeDb);
      perDatabase.clear();
      await Promise.all([...all, maintenance.end({ timeout: 5 }).catch(() => {})]);
    },
  };
}
