# The panel's Postgres

One database `pammy` on `127.0.0.1:5434` (`pammy-pg`). Three schemas, three
roles. Her MariaDB and her Postgres are **not** this; see [pammydb.md](pammydb.md).

## Stack and why

- **`postgres.js`**, ids as JavaScript numbers (P8).
- **Roles:** `pammy_panel` (`search_path panel, media`), `pammy_gate`
  (`gate`), `pammy_owner` (migrations). P5: each
  process sees only its own schemas.
- **Migrations** are append-only SQL files. The installer runs them as
  owner. The services only `checkSchema` (P9). Editing a file that already
  ran, or slotting one in before the last, is refused.

**The schema they make** is `db/schema.snapshot.sql`: `pg_dump --schema-only`
of a fresh database with every migration run, normalised by
`tools/schema-snapshot.ts`. `test/pg.test.ts` checks the migrations still make
it, and `verify-panel.sh` checks the live database is it too. A new migration
comes with `UPDATE_SCHEMA=1 node --test test/pg.test.ts` and the diff in the
same commit.

## How it talks to the rest

Passwords in `/etc/pammy-panel/db/<role>.pass`, handed to services as
systemd credentials. The CLI wrapper passes an open fd because
`svc-pammypanel` may not read the file.

## Migrations (`db/migrations/`)

| File | Schema | What |
|---|---|---|
| `0001-panel.sql` | `panel` | users, passkeys, invites, sessions, ceremonies, activity |
| `0002-media.sql` | `media` | media rows, tags, categories, joins, scopes, thumbs, sync |
| `0003-gate.sql` | `gate` | areas, visitors, grants, sessions, links, requests, forms, responses, api_keys |
| `0004-studio.sql` | `panel` | `studio_databases` |
| `0005-studio-users.sql` | `panel` | notes on engine logins |
| `0006-studio-drafts.sql` | `panel` | schema drafts |
| `0007-studio-layouts.sql` | `panel` | canvas positions |
| `0008-studio-resources.sql` | `panel` | resources and fields |
| `0009-studio-api.sql` | `gate` | catalog copy, app keys |
| `0010-db-examples.sql` | `panel` | which example databases were set up |
| `0011`-`0015` | `gate`, `panel` | field order, form links, comments, visitors, save state |
| `0016-drop-media-notes.sql` | `panel` | drops `media_notes` (refactor phase 5) |

Later gate tables (forms, and studio catalog) landed in 0003 and 0009 as
the work was done.

## Functions — src/pg-migrate.ts

### `migrationFiles` / `migrate` / `MigrationRefused`

Checksum each file. Advisory lock so two installers cannot run at once.
`check` refuses a database that has a file these sources do not (the
code is older than the database), or a checksum that changed.

### `checkSchema` — src/pg.ts

What the services run on start.

## SQLite port (gone)

`src/port.ts` and its tools copied the three SQLite files into Postgres and
back for the cutover (2026-09-19). Refactor phase 5 removed them with the
SQLite baselines; they are in git before that commit if ever needed.

## See also

- [00-map.md](00-map.md), [pammydb.md](pammydb.md), [deploy.md](deploy.md)
- [`docs/postgres-plan.md`](../postgres-plan.md)
