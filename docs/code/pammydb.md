# The database helper (pammydb)

The only process on this machine that speaks to **her** MariaDB
(`127.0.0.1:3307`) and **her** Postgres (`127.0.0.1:5433`). Not the panel's
database on `:5434`. Not the host's Postgres on `:5432` (other people's
data).

It is not sitefs: it needs loopback, so it must not have `PrivateNetwork=yes`,
and it does not run as pamela. All it needs is the two studio passwords.
The helper is **dumb SQL**. It does not know what a Resource is. The panel
already reduced a request to columns, a table, and a where.

Entry: [`src/pammydb/main.ts`](../../src/pammydb/main.ts). Socket
`/run/pammy-pammydb.sock`, group `pammydb-clients` (`svc-pammypanel` and
`svc-pammygate`).

## Stack and why

- **`postgres.js` and `mysql2`**, one driver each, behind
  [`src/pammydb/driver.ts`](../../src/pammydb/driver.ts). Engines are not
  the same (MariaDB can `CREATE DATABASE` from any connection; Postgres
  needs a connection per database for some work). Do not merge the files.
- **Endpoints are fixed in the unit, never in a request** (S7). An op names
  an engine and a database, never a host or a port. Ports `5432` and `5434`
  are refused at config load.
- **jsonline with a 1 MB inbound line and a 120 s idle timeout**, only on
  this server. A schema patch is an inbound line; 64 KB is the wall
  everyone else keeps (S3). `introspect` / `apply-schema` on an adopted
  WordPress-sized database will not finish in 10 seconds.
- **One statement per query, always.** `multipleStatements: false` on
  MariaDB. A patch is a list of steps, never a semicolon-joined string.

## How it talks to the rest

- Panel: studio designer, generated app, keys — `callPammyDb` in
  [`src/pammydb/client.ts`](../../src/pammydb/client.ts). The comment there
  is the rule: do not query her engines from `src/app.ts`.
- Gate: public data API (`/_pammy/api/data/…`) uses the same socket.
- Studio metadata (which databases she manages, drafts, layouts, Resource
  settings) lives in schema `panel`, tables `studio_*`. Row data lives on
  the engine.

## Important types

- `Engine` — `postgres` | `mariadb` (those spellings everywhere, S11).
- `Driver` — list/create/drop/size, users, introspect, apply, rows.
- `Snapshot` — the IR of a database: tables, columns, keys, relationships.
  Storage kinds, not UI controls (one `text`, not "Text" and "Long text";
  that difference is a Resource control, S14).
- `Step` — one change in a patch. `expect` is the hash of the snapshot the
  panel worked from; Apply refuses if the engine moved.
- `PammyDbError` — `code` the panel maps to HTTP, same as sitefs.
- `AccessRole` — Read only / Read & write / Structure editor /
  Administrator. Read back from the engine's real grants, never from
  something the panel wrote down (S13). A shape the panel did not make
  reads as `custom`.

## Function catalog — config and identity

### `loadHelperConfig(env)` — src/pammydb/config.ts

Host `127.0.0.1`, ports 5433 and 3307, user `pammy_studio`, passwords from
credential files. A forbidden port or a missing password exits 2 rather
than serving requests it can never answer.

### `checkName` / `checkUserName` / `checkWritable` / `checkOpenable` — ident.ts

Names the engines will take. Protected names (`pamela`, `postgres`,
`mysql`, …) cannot be created or dropped (S8). `pamela` *can* be opened
and adopted: that is where her work already is.

### `createPgDriver` / `createMariaDriver`

The two `Driver` implementations. [`applyReason`](../../src/pammydb/pg.ts)
turns an engine error into her words; MariaDB reuses it.

## Socket ops — databases

### `op: list-databases`

Both engines, one answer. An engine that is down is reported, not thrown:
the other one's cards are still worth showing.

### `op: create-database` / `drop-database` / `database-size` / `adopt-database`

Create and drop check the refuse-list. Size and adopt may open `pamela`.
Adopt only says what is there; the panel is what remembers it in
`studio_databases`.

## Socket ops — users (logins)

A login is a `user`. A `role` is one of the four kinds of access. Never
the other way round (S12). On Postgres a login *is* a role, which is why
the product plan once said `list-roles`.

### `op: list-users` / `create-user` / `drop-user` / `reset-password`

### `op: user-access` / `grant-access` / `revoke-access`

## Socket ops — schema

### `op: introspect`

Read the engine into a `Snapshot`. Indexes are read and shown and never
diffed (S15): an adopted database's indexes were not made here.

### `op: preview-schema` / `apply-schema`

The panel sends an ordered `patch` and `expect`. Apply takes a
per-database lock. A type or default the panel did not make is carried in
the engine's own words and never written back (S17). Primary key and
"fills itself in" are settled when the table is made (S16).

## Socket ops — rows

The helper still holds no opinion about which columns may be read or
written. The panel already reduced these to the Resource's window
([`src/studio/records.ts`](../../src/studio/records.ts)).

### `op: list-rows` / `get-row` / `insert-row` / `update-row` / `delete-row`

### `op: set-links`

A record's pairs in a connecting table (the record picker, R12).

## Files next to the helper

| File | Job |
|---|---|
| `ir.ts` | The snapshot shape |
| `patch.ts` | Check a step, mark destructive ones |
| `ddl.ts` | Turn steps into SQL for each engine |
| `rows.ts` | Build list/get/insert/update/delete/set-links |
| `roles.ts` | The four access roles |
| `ops.ts` | The functions the `handle` switch calls |

## See also

- [studio.md](studio.md), [database.md](database.md)
- [`docs/studio-plan.md`](../studio-plan.md), [`docs/databases-plan.md`](../databases-plan.md)
- Guide 14 (databases in the control panel), guide 13 (databases and programs)
