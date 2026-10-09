// The studio helper's socket protocol: one JSON request per connection, one
// JSON line back (jsonline.ts), exactly like the website folder helper. It
// trusts nothing in the request: every name is checked again in ops.ts.
//
// Unlike sitefs, this helper is async on purpose -- a size for one database and
// a list for the dashboard can overlap. Schema Apply takes a per-database lock
// when it arrives in slice 4; slice 1 has nothing that needs one.
import type { Server } from 'node:net';
import { createJsonLineServer } from '@panel/core/jsonline';
import {
  adoptDatabase, applySchema, createDatabase, createUser, databaseSize, deleteRow, dropDatabase,
  dropUser, getRow, grantAccess, insertRow, introspect, listDatabases, listRows, listUsers,
  previewSchema, projectDatabase, resetPassword, revokeAccess, setLinks, updateRow, userAccess, type Drivers,
} from './ops.ts';
import { PammyDbError } from './ident.ts';

export type PammyDbRequest = {
  op: string;
  engine?: unknown;
  name?: unknown;
  actor?: unknown;
  // database users (slice 3). `user` is a login, `role` one of the four kinds of
  // access -- never the other way round (docs/studio-plan.md S12).
  user?: unknown;
  password?: unknown;
  database?: unknown;
  databases?: unknown;
  role?: unknown;
  // her rows (slice 8)
  table?: unknown;
  query?: unknown;
  columns?: unknown;
  values?: unknown;
  back?: unknown;
  where?: unknown;
  // set-links: a record's pairs in a connecting table (docs/record-picker-plan.md R12)
  here?: unknown;
  id?: unknown;
  there?: unknown;
  ids?: unknown;
  // the shape inside a database (slice 4). `patch` is the ordered list of steps
  // the panel worked out; `expect` is the hash of the schema it worked them out
  // against, which is how Apply notices the database moved underneath it.
  patch?: unknown;
  expect?: unknown;
  // project-database (docs/phase8b-plan.md 8b-5): its two logins and their new passwords
  owner?: unknown;
  ownerPassword?: unknown;
  app?: unknown;
  appPassword?: unknown;
};

// Every op the helper has, and the few the gate may ask for (S2, docs/s2-plan.md). The
// internet-facing gate reads and writes rows for the data API, forms and comments, and
// nothing else: it gets a door of its own (<site>-pammydb-gate.socket, only the gate's user
// may open it) whose helper refuses the rest before anything reaches an engine. The panel's
// door (<site>-pammydb.socket) answers all of them, as before.
export const ALL_OPS: readonly string[] = [
  'list-databases', 'create-database', 'drop-database', 'database-size', 'adopt-database',
  'list-users', 'create-user', 'drop-user', 'reset-password', 'user-access', 'grant-access', 'revoke-access',
  'project-database', 'introspect', 'preview-schema', 'apply-schema',
  'list-rows', 'get-row', 'insert-row', 'update-row', 'delete-row', 'set-links',
];
// what the gate sends (test/pammydb-gate-door.test.ts holds this to the gate's code): no
// set-links, which only the panel's record picker uses
export const GATE_OPS: readonly string[] = ['list-rows', 'get-row', 'insert-row', 'update-row', 'delete-row'];
export type Door = 'panel' | 'gate';
// S2 review L1, L5: the gate's helper keeps at most 8 databases' pools per engine (2
// connections each: 16, under the studio login's CONNECTION LIMIT 20), and hangs up on an
// idle connection after 30 seconds (the gate's own wait), not 120 (introspect/apply's)
export const GATE_MAX_OPEN = 8;
export const GATE_TIMEOUT = 30_000;

export function handle(drivers: Drivers, req: PammyDbRequest, door: Door = 'panel'): Promise<unknown> {
  // the gate's door: anything but its row ops is refused here, whatever the request says,
  // before an engine is asked (an op added below and not to GATE_OPS is refused too)
  if (door === 'gate' && !GATE_OPS.includes(req.op)) {
    return Promise.reject(ALL_OPS.includes(req.op)
      ? new PammyDbError('not-allowed', "The gate's door to the database helper answers row requests only.")
      : new PammyDbError('invalid', 'Unknown request.'));
  }
  switch (req.op) {
    case 'list-databases': return listDatabases(drivers);
    case 'create-database': return createDatabase(drivers, req.engine, req.name);
    case 'drop-database': return dropDatabase(drivers, req.engine, req.name);
    case 'database-size': return databaseSize(drivers, req.engine, req.name);
    case 'adopt-database': return adoptDatabase(drivers, req.engine, req.name);
    case 'list-users': return listUsers(drivers);
    case 'create-user': return createUser(drivers, req.engine, req.user, req.password);
    case 'drop-user': return dropUser(drivers, req.engine, req.user);
    case 'reset-password': return resetPassword(drivers, req.engine, req.user, req.password);
    case 'user-access': return userAccess(drivers, req.engine, req.user, req.databases);
    case 'grant-access': return grantAccess(drivers, req.engine, req.user, req.database, req.role);
    case 'revoke-access': return revokeAccess(drivers, req.engine, req.user, req.database);
    // lfdln's projects (docs/phase8b-plan.md 8b-5)
    case 'project-database': return projectDatabase(drivers, req.engine, req.name, req.owner, req.ownerPassword, req.app, req.appPassword);
    case 'introspect': return introspect(drivers, req.engine, req.name);
    case 'preview-schema': return previewSchema(drivers, req.engine, req.name, req.patch);
    case 'apply-schema': return applySchema(drivers, req.engine, req.name, req.patch, req.expect);
    // her rows (slice 8). The helper still holds no opinion about which
    // columns may be read or written: the panel has already reduced these to
    // the Resource's window (src/studio/records.ts).
    case 'list-rows': return listRows(drivers, req.engine, req.name, req.query);
    case 'get-row': return getRow(drivers, req.engine, req.name, req.table, req.columns, req.where);
    case 'insert-row': return insertRow(drivers, req.engine, req.name, req.table, req.values, req.back);
    case 'update-row': return updateRow(drivers, req.engine, req.name, req.table, req.values, req.where, req.back);
    case 'delete-row': return deleteRow(drivers, req.engine, req.name, req.table, req.where);
    case 'set-links': return setLinks(drivers, req.engine, req.name, { table: req.table, here: req.here, id: req.id, there: req.there, ids: req.ids });
    default: throw new PammyDbError('invalid', 'Unknown request.');
  }
}

// A schema patch is an inbound line, and inbound is the direction jsonline is
// tight in: 64KB is the wall, while replies already have 4MB of headroom
// (docs/studio-plan.md S3). Only this server asks for more, and only for its own
// requests -- sitefs, thumbs and the gate's admin socket keep the default.
export const MAX_REQUEST = 1024 * 1024;

// Slice 1's ops answer in milliseconds. `introspect` and `apply-schema` on an
// adopted database with hundreds of tables do not, and the 10 seconds every
// jsonline server gives an idle connection would cut them off half way through
// a patch on MariaDB, where half way is somewhere real.
export const TIMEOUT = 120_000;

export function createPammyDbServer(drivers: Drivers, log: (line: string) => void = () => {}, door: Door = 'panel'): Server {
  return createJsonLineServer((req) => handle(drivers, req, door), log, {
    // What each line says it was about. `password` is deliberately not one of
    // the things named here, and never becomes one.
    describe: (req) => `${typeof req.engine === 'string' ? req.engine : '-'}:${JSON.stringify(req.name ?? req.user ?? '').slice(0, 80)}`,
    maxRequest: MAX_REQUEST,
    timeoutMs: door === 'gate' ? GATE_TIMEOUT : TIMEOUT,
  });
}
