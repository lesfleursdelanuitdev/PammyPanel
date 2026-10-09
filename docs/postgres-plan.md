# The panel and the gate on Postgres

Status: **2026-09-19. Step 1 (the container) INSTALLED and the migrations RUN on the live `pammy`
(empty tables; the services are still on SQLite). Steps 2-7 BUILT, and the dry run on copies of the
live files passed: 880 rows in 2.1s, every table's checksum matching. Next: the cutover —
the run sheet is `docs/cutover.md`.** Decided with momolig
2026-09-19; where the choice was mine, it is marked *(Claude)*. All choices are settled (P14 on 2026-09-19).

The panel (panel.db, media.db) and the gate (gate.db) move from SQLite files to a Postgres of their
own, in a container, so the panel can grow into a much bigger project on a sturdier backend.
**Every row comes across.** Passkeys, sessions, visitors, forms, responses, media records, labels,
keys and the activity log all make the move. Nobody registers a passkey again, signs in again or
loses a message.

## Decisions

| # | Decision | Source |
|---|---|---|
| P1 | **Its own Postgres**, not Pamela's (svc-pammydb, :5433). Her `CREATEROLE` account can't reach panel passkeys or roles, her load and restarts don't touch the panel, and it has its own backups and upgrades. | momolig |
| P2 | A rootless **Quadlet** container, `pammy-pg`, under a new lingering service user **`svc-pammypanel-db`**. Same pattern as svc-pammydb, svc-tutorstar and svc-ligneous. Image `postgres:17` with registry auto-update, so it gets patch releases only. | momolig (container), Claude (names) |
| P3 | Listens on **127.0.0.1:5434** only. 5432 is the host's Postgres (TutorStar) and 5433 is Pamela's. Every login uses a scram-sha-256 password. | momolig |
| P4 | **One database `pammy`**, with schemas **`panel`**, **`media`** and **`gate`**. Keeping them in one database leaves room to join across them later, and backups and upgrades are one thing. | Claude (agreed earlier) |
| P5 | **One role per process, and least privilege.** `pammy_owner` owns the schemas and runs migrations, and only the installer uses it. `pammy_panel` gets DML on `panel` + `media`. `pammy_gate` gets DML on `gate`. **The panel gets no rights on `gate`**, because it still goes through the gate's admin socket as it does today. `REVOKE ALL ON DATABASE pammy FROM PUBLIC`. | Claude |
| P6 | **Move first, modernise later.** The first Postgres schema is today's final SQLite schema, table for table and column for column, with the same meanings: `INTEGER` → `bigint`, 0/1 flags stay `integer`, `BLOB` → `bytea`, JSON stays `text`. Once it runs, later migrations modernise it (`boolean`, `jsonb`, `timestamptz`). Keeping the shapes the same makes checking the port and going back simple. | Claude (agreed earlier) |
| P7 | **Ids are kept exactly**, and every sequence starts past the highest id ever used. For tables that were `AUTOINCREMENT` (areas, visitors, forms, …) that means `sqlite_sequence`, not `max(id)`, so an area id is never reused (the promise in gate.db's first migration). | Claude |
| P8 | **postgres.js** (`postgres` on npm) is the driver. `int8` is parsed to a JS `number` (all our ids and times are well below 2^53) so the code keeps working with numbers, not strings. | Claude |
| P9 | **Migrations are appended SQL files** (`db/migrations/NNNN-name.sql`) plus a `schema_migrations` table, run under an advisory lock. **Only the installer runs them**, as `pammy_owner`. The services check the version on start and refuse to run against a schema they don't expect. Today openDb() migrates on start; that ends. (Since packaging step 3, 2026-09-24: `db/migrations` is the closed baseline 0001-0018 and new ones live in `packages/<name>/migrations`, see docs/packaging-plan.md.) | Claude |
| P10 | **index.db stays SQLite.** It is the read-only snapshot the panel publishes for the gate's media API (media-api-plan M2). It is a file the gate reads, not shared state, and it keeps the media API working if Postgres is down. The example index (`:memory:`) stays too. | Claude (agreed earlier) |
| P11 | **Writes that used to be serialised stay serialised.** Every write transaction runs `SERIALIZABLE` and is retried on a serialisation failure (40001/40P01). See "Sync to async". | Claude |
| P12 | Backups: a `pg_dump -Fc` of `pammy` every night, kept 14 days. The installer also takes a dump before every migration, replacing today's `*.db.before-*` copies. Continuous WAL archiving and an off-site copy are for later. | Claude |
| P13 | **Going back is possible for 7 days.** The port tool also runs in reverse (Postgres → SQLite files in today's shapes, which P6 makes a plain copy), so going back loses nothing written after the switch. The SQLite files stay, read-only, for 30 days. | Claude |
| P14 | **Option (b).** The gate answers "may this be served?" from memory (areas, plus recently checked visitor sessions), so a Postgres outage doesn't take her site down. See "The gate and Postgres". | momolig |

## What moves

About 350 statement sites in 21 files. The biggest, by count: gate/forms.ts 65, media-db.ts 58,
gate/store.ts 54, app.ts 25, accounts.ts 23, media-labels.ts 15, gate/media-api.ts 12 (mostly
index.db, which stays), scopes.ts 11, media-public.ts 11, media-sync.ts 10, sessions.ts 9,
media-thumbs.ts 8, gate/examples.ts 8, gate/admin.ts 7, cli.ts 6. The sitefs helper and the
thumbnail service have no database and don't change.

| Today | Tables | Becomes |
|---|---|---|
| `/var/lib/svc-pammypanel/panel.db` | users, passkeys, invites, sessions, ceremonies, activity, media_notes | schema `panel` |
| `/var/lib/svc-pammypanel/media.db` | media, tags, categories, media_tags, media_categories, scopes, thumbs, sync_state, imported_notes | schema `media` |
| `/var/lib/svc-pammygate/gate.db` | areas, visitors, grants, sessions, events, links, requests, forms, responses, contact_pages, messages, api_keys, … | schema `gate` |
| `/var/lib/pammy-media-public/index.db` | (published snapshot) | **stays SQLite** (P10) |

The port script reads the full table list from `sqlite_master` and **refuses if any table is not in
its map**, so nothing is left behind by accident.

## Passkeys: what must not change

A passkey keeps working if all of these come across byte for byte:

- `passkeys.credential_id` (base64url text, unchanged)
- `passkeys.public_key` (BLOB → `bytea`, compared byte for byte)
- `passkeys.counter` (→ `bigint`; the authenticator's counter can reach 2^32)
- `passkeys.user_id` → `users.id`, and `users.webauthn_user_id`
- `transports`, `device_type`, `backed_up`

The rpID (`panel.pammy.org`) and origin don't change either. Panel sessions and visitor sessions
are ported with their `token_hash` too, so everyone's cookie still works and nobody is signed out.
In-flight ceremonies are ported as well: it costs nothing, and a sign-in half done during the
switch finishes.

## The container

```
svc-pammypanel-db (system user, linger, subuids)
  ~/.config/containers/systemd/pammy-pg.container     postgres:17, 127.0.0.1:5434:5432
  ~/.config/containers/systemd/pammy-pg.volume        data
  podman secrets: pammy-pg-super, pammy-pg-owner, pammy-pg-panel, pammy-pg-gate
  ~/.config/systemd/user/pammy-pg-backup.{service,timer}  04:30 UTC, -> /var/lib/svc-pammypanel-db/backups (700)
```

- Settings, passed as `-c` flags on the command: `max_connections=40`, `shared_buffers=256MB`,
  `password_encryption=scram-sha-256`, `idle_in_transaction_session_timeout=60s`,
  `log_min_duration_statement=500ms`. The container gets `MemoryMax=1G`.
- `pammy` uses Postgres 17's **builtin** `C.UTF-8` locale, so `ORDER BY name` sorts by code point
  as SQLite's BINARY did (tested: `B,Z,a,b,é`), and an image update can never change the order
  under an index. Nicer sorting where a person reads a list is a later, explicit `COLLATE`.
- Per role: `pammy_gate` has `statement_timeout=2s` (it answers nginx on every request) and
  `pammy_panel` has `15s`. Each has `CONNECTION LIMIT` 10.
- The services get their passwords through systemd **`LoadCredential=`** from
  `/etc/pammy-panel/db/{panel,gate}.pass` (root, 600), not the environment. The CLI wrapper
  reads the panel's the same way. The owner's is in `owner.pass` beside them, for the installer
  and the port tool. The superuser's exists only as a podman secret, and the superuser can only
  sign in through `podman exec` (pg_hba.conf).
- `IPAddressAllow=localhost` on both units already allows 127.0.0.1:5434, so no sandbox change is
  needed. Pamela's shell can reach the port, but without a password it gets nothing, and
  `pg_hba` allows only the three roles to `pammy`. (A Unix socket that only the two service
  groups can open would keep her from even connecting. Rootless container sockets make that
  fiddly, so it's a possible later step, not needed now.)

## The gate and Postgres

Today the gate's database is a file that is always there. After the move, **nginx asks the gate
about every request to her site, and the gate asks Postgres.** If Postgres is down, her whole
static site gives 500s, the same as when the gate is down today. Three options:

- **(a) Accept it.** Postgres restarts in seconds and the container has `Restart=always`. It is
  the simplest option, and the site depends on one more thing.
- **(b) Chosen (P14).** The gate keeps what it needs to **answer "may this be served?"** in memory:
  the areas (a small table, reloaded after every change the gate makes and every 60 s; built
  without `LISTEN/NOTIFY`, since the gate is the only writer of its tables) and
  recently checked visitor sessions (60 s). **Unprotected pages then never wait for Postgres**,
  and signed-in visitors keep going through a short outage. Signing in, forms and requests need
  Postgres and say "try again in a minute" while it's down.
- **(c) Keep gate.db as SQLite** and move only panel.db + media.db. It is the safest for the site,
  but it leaves the gate's data (forms, responses, visitors) out of the larger project.

The gate also has to **start before Postgres is up** (at boot, a system unit can't wait on a user
unit). It starts, retries the connection with backoff, and until then answers as in (b), or with
503 for anything that needs the database.

## Sync to async

Today every query is synchronous, and one Node process runs one request's database work start to
finish, so **no two requests' reads and writes ever interleave**. Much of the code relies on that
without saying so ("check it's free, then insert"). With an async driver they will interleave.
So:

1. `src/pg.ts` replaces `src/db.ts`. It holds the pool, the type parsers, `q` (a tagged template)
   and `tx(fn)`, which is `sql.begin('isolation level serializable', fn)` with up to 5 retries on
   40001/40P01 and jitter between them. **Every function that writes runs inside `tx`**, as every
   function inside `tx(db, …)` does today (P11).
2. Every function that touches the database becomes `async`, and so do its callers up to the
   route handler. Fastify handlers are already async, so the change stops there.
3. SQLite-only SQL, counted in `src/`:

| SQLite | Count | Postgres |
|---|---|---|
| `GLOB` in CHECKs and queries | 26 | `~` regex, or `LIKE` with escaping, each one checked by hand |
| `lastInsertRowid` | 16 | `RETURNING id` |
| `.changes` | 15 | `result.count` |
| `INSERT OR IGNORE` | 11 | `ON CONFLICT DO NOTHING` |
| `RAISE(ABORT, …)` triggers (media scopes, D7) | 6 | plpgsql trigger functions with the same messages |
| `sqlite_sequence` / `sqlite_master` | 4 | the sequences / `information_schema` |
| `strftime` | 2 | `extract(epoch from now())` |
| `COLLATE NOCASE` | 2 | `lower()` on both sides and a `lower()` index (or `citext`, later) |
| `x IS NOT y` | several | `IS DISTINCT FROM` |
| `substr` / `instr` / `\|\|` | several | same, but `instr` → `strpos` |
| `LIKE` (case-insensitive for ASCII in SQLite) | — | `ILIKE` wherever that's what the code meant |

4. `CHECK`s and partial unique indexes come across as they are (Postgres has both).
5. Migration steps written in code (`migrateContactForms`, `installExamples`, `renamePhotosInForms`,
   the media rebuilds) **don't come across**. The Postgres baseline is the schema as it stands
   *after* them, so they never need to run again. The port refuses a SQLite file that isn't at the
   current `user_version`.

## The port tool: `tools/port-sqlite-to-pg.ts`

It runs as root from the installer and reads the SQLite files read-only.

1. **Preflight.** Each file passes `PRAGMA integrity_check` and `foreign_key_check`, is at the
   expected `user_version`, and every table is in the map. It looks for values whose SQLite type
   doesn't fit the column (type affinity lets text sit in an INTEGER column) and **lists them and
   stops** rather than guessing.
2. **Copy** in one transaction per schema, in FK order, with `COPY … FROM STDIN` and the original
   ids. The media label triggers are off during the load (`ALTER TABLE … DISABLE TRIGGER USER`,
   turned back on in the same transaction), because SQLite already checked those rows. FK and
   CHECK constraints stay on: `DISABLE TRIGGER USER` leaves the FK triggers alone, unlike
   `session_replication_role = replica`, which would skip them.
3. **Sequences.** `setval` to `max(max(id), sqlite_sequence.seq)` (P7).
4. **Check** for every table: the row counts match, and a SHA-256 over every row serialised the
   same way from both sides (ordered by primary key; `bytea` as hex) matches. For passkeys, also
   each `public_key` byte for byte. Any difference stops everything and says which table and row.
5. `--reverse` writes fresh SQLite files from Postgres, with today's schema (P13), and checks them
   the same way.
6. `--dry-run` does it all **inside one transaction and rolls it back**, so it runs against the
   real database, schema, grants and triggers and gives the real numbers and the real timing.
   *(Changed while building: the plan said a throwaway `pammy_dryrun` database, but `pammy_owner`
   is `NOCREATEDB` (P5) and the superuser can only sign in through `podman exec` (P3), so making a
   database would have meant the tool shelling into the container. Rolling back is simpler and
   tests more. Two things to know: the tables must be empty, as they are before the cutover, and
   `setval` is not undone by a rollback -- which does no harm, since the real run sets the
   sequences again.)*

## Tests

- The test suites run against a **throwaway container `pammy-pg-test-<pid>`** (tmpfs data, a random
  port), started by `test/pg-harness.ts`. Every test file gets its own database from a template.
  The container is removed **by name** at the end, never with a prune.
- New tests: the port round trip (SQLite fixture → PG → SQLite, then checksums equal), a
  passkey sign-in against ported rows using the existing test authenticator
  (`test/authenticator.ts`), concurrent writes (two requests race for the same username, form
  name or tag, and exactly one wins), serialisation retry, the gate answering from memory with
  Postgres stopped (P14b), and the gate starting before Postgres.
- `deploy/verify-panel.sh` (222 checks today) gains checks for the Postgres role grants (the
  panel can't read `gate.*`, and PUBLIC can't connect), the backup timer, a fresh dump, and
  "no service still has a `.db` open".

## Build order

1. **Container. INSTALLED 2026-09-19 (verify-pg 52/52):** `deploy/pg/install-pg.sh` (the user, subuids, linger,
   secrets, Quadlet, `setup.sql`, password files, backup timer) and `verify-pg.sh`, plus
   `README.md` (how to manage and restore it). Run it on its own; nothing uses it yet. Tested
   against a throwaway rootless container: `setup.sql` twice, every access rule, the backup
   script and a restore.
2. **`src/pg.ts` + baseline migrations** (`0001-panel.sql`, `0002-media.sql`, `0003-gate.sql`),
   written from today's final SQLite schema and checked against a schema dump of a real migrated
   file. **BUILT 2026-09-19** (nothing live changed):
   - `db/migrations/0001-0003`: every table, column, default, key, FK and index as in SQLite;
     ids are `bigint GENERATED BY DEFAULT AS IDENTITY`. The media label triggers are plpgsql with
     the same messages (`check_violation`). SQLite's `GLOB folder || '/*'` became
     `media.path_under()`, a plain prefix test: the GLOB misread folders named with `*`, `?` or
     `[` (it refused a label on `a[b]/x.jpg`). The port must check every existing link against it.
   - `src/pg-migrate.ts` + `tools/migrate.ts` (P9): `public.schema_migrations` (name, sha256,
     applied_at), readable by the services and nothing more; one transaction and an advisory
     lock per file, `lock_timeout` 10s; refuses an edited file, one slotted in before the last,
     or a database newer than the files. `--check` exits 3 when something is pending.
   - `src/pg.ts`: `connectPg` (search_path per role in the startup message: panel sees
     `panel, media`, the gate `gate`), int8 → number (throws past 2^53), `tx` (SERIALIZABLE,
     5 attempts on 40001/40P01, joins an open tx), `checkSchema` for the services' start.
   - `test/pg-harness.ts`: one container per test process, `pammy-pg-test-<pid>` (not one
     shared name: node runs test files in parallel), set up with the real `setup.sql`.
     `test/pg.test.ts` (62 tests): the migrations; every table compared with the SQLite files
     made by today's code; 43 rows run on both sides, refused or accepted alike; role rights;
     pg.ts. Whole suite 385/385.
   - `db/sqlite-baseline/*.schema.sql` (`tools/sqlite-schema.ts`): the schemas the baseline
     copies, for comparing the live files (README there).
     **Checked 2026-09-19: the live panel.db, media.db and gate.db match them exactly.**
   - For step 3: a fresh Postgres has no example forms or sample entries (today
     `installExamples` puts them in as a migration). The port brings the live ones; tests and a
     new install need them put in by the gate's code.
3. **The gate** (store, forms, admin, examples, app), the smaller half, plus the in-memory answers (P14).
   **BUILT 2026-09-19** (nothing live changed; the SQLite-era code is in
   `../panel-pre-postgres-gate-20260919T203404Z.tar.gz`, for a hotfix before the cutover):
   - Every gate query is async on Postgres through `all/one/run` in `src/pg.ts` (the SQLite SQL
     with its `?` placeholders, so each query reads as before). Writes that check-then-insert
     run in `tx`. Gone: `openGateDb`, `GATE_MIGRATIONS`, `migrateContactForms`,
     `renamePhotosInForms` (the baseline is the schema after them). `sum(x IS NULL)` became
     `count(*) FILTER (...)`, `INSERT OR IGNORE` `ON CONFLICT DO NOTHING`, `lastInsertRowid`
     `RETURNING`. One small change in meaning: `lower()` now folds non-ASCII letters too (the
     same person asking twice for access, as "Zoë" and "ZOË").
   - `src/gate/live.ts` (P14): the areas in memory, saved to `GATE_AREAS_SNAPSHOT`
     (`/var/lib/svc-pammygate/areas.json`, 600) so the gate answers from its first second;
     checked sessions with their grants for 60 s, and up to 15 min while Postgres can't be
     reached. `policy.ts` decides from memory only; `/check` looks up the visitor only when a
     protection applies. Every admin op on an area, a visitor or a grant, sign-out and a used
     setup link clear the memory before answering. No `LISTEN/NOTIFY`: the gate is the only
     writer of its tables, and the 60 s reload covers hand edits.
   - Postgres unreachable: `/check` of unprotected pages 204 as ever; protected ones for a
     visitor checked lately 204, anyone else 503; every other route 503 "try again in a
     minute" (`Retry-After: 30`); the admin socket answers `unavailable`, which the panel
     already shows as 503. `main.ts` starts without waiting, retries with backoff (1-30 s)
     until `checkSchema` passes, then adds any missing worked examples (`installExamples`,
     formerly a migration).
   - Found and fixed on the way: `jsonline.ts` passes any error with a string `code` to the
     panel as a refusal, message and all, and Postgres errors have codes. The admin handler
     now turns them into `unavailable` or a plain internal error.
   - Tests: `gate.test.ts` (127) on Postgres; `gate-live.test.ts` (9, new): the outage cut
     through a relay, starting before Postgres with and without the saved areas, memory
     cleared by changes and within 60 s of a hand edit, and four races (same username, same
     form name, same folder, same access request: exactly one each). `test/gate-seed.ts` makes
     what a moved database has and a new one doesn't (the sample contact form as form 1, then
     the examples). `run-gate-nginx-test.sh` runs the real gate on a test Postgres
     (`test/pg-serve.ts`); the browser-test server too (Playwright now stops it with SIGTERM).
     The harness removes containers of test processes that were killed. Unit 390/390, nginx
     gate test 133/133, browser 43/43.
   - For step 7: the gate's unit needs `LoadCredential=db.pass:/etc/pammy-panel/db/gate.pass`
     (or `GATE_PG_PASSWORD_FILE`), no `GATE_DB`, and `GATE_AREAS_SNAPSHOT` in its state
     directory; install-panel.sh's `gate.db.before-*` copies and verify-panel.sh's gate.db
     checks change with it.
4. **The panel**: accounts, sessions, app routes, CLI.
   **BUILT 2026-09-19** (nothing live changed; before-copy in the same tarball as step 3):
   - `accounts.ts`, `sessions.ts`, `media-rename.ts`, every account/session route in `app.ts`,
     `cli.ts` and `server.ts` are async on Postgres (`all/one/run`, as the gate). The panel's
     SQLite migrations are gone from `db.ts`, which now only opens media.db (until step 5);
     `openMediaDb` no longer takes panel.db (its D17 import only runs when media.db is first
     made, and the live one exists). Config: `PANEL_DB` is no longer needed;
     `PANEL_PG_PASSWORD_FILE` (default `$CREDENTIALS_DIRECTORY/db.pass`, else
     `/etc/pammy-panel/db/panel.pass`), `PANEL_PG_HOST/PORT/DATABASE`, `PANEL_DATA_DIR`
     (where media.db and the thumbnails default to).
   - The panel waits for Postgres at start (retrying 1-30 s), unlike the gate: every page of
     it needs a signed-in account anyway. The CLI checks the schema before any command.
   - Races that SQLite's one-at-a-time hid, fixed and tested: a sign-in challenge is taken
     with one `DELETE ... RETURNING` (read-then-delete let two requests use one challenge,
     i.e. replay a passkey assertion; the test fails against the old code); a setup link's
     passkey and the link being used are one transaction (was: insert, then delete it again
     if the link was gone); the same passkey registered twice is decided by the unique key;
     "the last account manager stays" is checked inside the change (two managers switching
     each other off at once can't both win); usernames: one wins.
   - Tests: unit 394/394 (4 new race tests), panel nginx test 20/20 (the real server on a test
     Postgres, `test/pg-serve.ts` now writes panel.pass too), gate nginx 133/133, browser
     43/43. The CLI checked by hand against a test Postgres (users, add-user, role, invite,
     disable, scope, activity, and its refusals).
   - For step 7: the wrapper `pammy-panel` (deploy/pammy-panel-cli) runs the CLI as
     svc-pammypanel, which can't read `/etc/pammy-panel/db/panel.pass` (root 600). It should
     open it as root and pass it as an open fd (`3< panel.pass`, read with
     `readFileSync(3)`, not `/dev/fd/3`, which re-checks the file's permissions); the panel's
     unit gets `LoadCredential=db.pass:/etc/pammy-panel/db/panel.pass`; panel.env drops
     `PANEL_DB`.
5. **Media**: media-db, scopes, labels, rename, sync, thumbs, and media-public (reads Postgres,
   still writes index.db).
   **BUILT 2026-09-19** (nothing live changed):
   - `media-db.ts`, `scopes.ts`, `media-labels.ts`, `media-sync.ts`, `media-thumbs.ts` and
     `media-public.ts` are async on Postgres, and so are the Media, Tags and File Explorer routes
     in `app.ts` and the `media-sync` / `media-thumbs` commands. `MediaSync`, `Thumbnailer` and
     `Publisher` take the panel's pool instead of media.db; `media.mdb` is gone. `src/db.ts`
     (SQLite) is deleted: its row types now live with the code that uses them (`UserRow` and
     `PasskeyRow` in accounts.ts, `SessionRow` in sessions.ts). Config: `PANEL_MEDIA_DB` and
     `mediaDbPath` are gone; `PANEL_DATA_DIR` still says where the thumbnails and the media
     API's index live.
   - The SQLite dialect that had to be written out: `GLOB` prefix tests are `starts_with()`
     (which is what they meant: a folder called `a[b]` was misread before), `instr` is `strpos`,
     `INSERT OR IGNORE` is `ON CONFLICT DO NOTHING`, `lastInsertRowid` is `RETURNING id`,
     `.changes` is the row count, and `ORDER BY name COLLATE NOCASE` is `lower(name)`.
   - The media migrations written in code (the table rebuilds, and D17's copy of panel.db's
     `media_notes` when media.db was made) are gone: the Postgres baseline is the schema after
     them, and the port brings `imported_notes` across (step 6).
   - Races: a label made twice at once (an upload and a sync) is one row, and the insert that
     loses gets the winner's id back; `createLabel` and `renameLabel` turn a unique violation
     into the same "There's already a tag called ..." as before; every write runs in `tx`.
     The index is published one at a time, so two publishes can't rename their files into
     place the wrong way round.
   - Tests: unit 394/394 (media-db.test.ts now runs against a test Postgres; the gate's media
     API test seeds through the panel's schemas in the same database), panel nginx 20/20, gate
     nginx 133/133, browser 43/43. `tools/put-test-media.sh` labels through Postgres (it reads
     panel.pass as root and hands it over as fd 3).
   - For step 7: `deploy/panel.env` drops `PANEL_DB` and `PANEL_MEDIA_DB`, `deploy/pammy-panel-cli`
     stops passing them, install-panel.sh's `media.db.before-*` copies and verify-panel.sh's
     media.db checks (its `mdb()` helper, the file's mode, the media counts) become Postgres
     ones, and `db/sqlite-baseline/README.md` already says the media schema there is a record,
     not something today's code can make.
6. **The port tool** with `--dry-run` and `--reverse`, then **a dry run on copies of the live files**.
   Nothing live changes, and it gives the real numbers for the cutover.
   **BUILT 2026-09-19** (nothing live changed):
   - `src/port.ts` does the work and `tools/port-sqlite-to-pg.ts` is the command line;
     `tools/sqlite-schema.ts` now prints from the same code the port checks against.
     `tools/copy-live-dbs.ts` takes sound copies of the three live files while the services run
     (SQLite's own backup, not `cp`, which can catch a file mid-write or leave its -wal behind).
   - Preflight refuses, before anything is written: a file that isn't sound, one whose
     `user_version` isn't the expected 3 / 5 / 10, a table the map doesn't know, a schema that
     isn't `db/sqlite-baseline/<name>.schema.sql`, and values whose SQLite type doesn't fit the
     column (type affinity lets text sit in an INTEGER column). It also refuses to fill a table
     that already holds rows.
   - The copy is `COPY ... FROM STDIN` per table in FK order, in one transaction per schema, with
     the original ids and the media label triggers off (FK and CHECK constraints stay on).
     Sequences are then set past the highest id ever used, from `sqlite_sequence` where the table
     was AUTOINCREMENT, not from `max(id)` (P7).
   - The check is a row count and a SHA-256 over every row, ordered by primary key and serialised
     the same way from both sides, with each value tagged by type (so the text "1" can't hash the
     same as the number 1) and `bytea` as hex; passkeys are also compared byte by byte. Any
     difference stops the run and names the table.
   - Links only SQLite's `GLOB` allowed (a label scope like `/a[b]` sitting on a file in `ab/`)
     are **kept and reported**, not dropped: the panel's stricter rule will refuse to change them
     later, and momolig should know which they are.
   - `--reverse` writes fresh SQLite files with the baseline schema (it refuses to write over one
     that is there), puts the triggers on after the rows, restores `sqlite_sequence`, and runs
     `integrity_check` and `foreign_key_check` before the same checksums.
   - Tests (`test/port.test.ts`, 21): a full round trip with awkward values -- tabs, newlines,
     backslashes, a `\N`, an emoji, right-to-left text, a counter past 2^32, ids with gaps --
     every preflight refusal, the dry run keeping nothing, the checksum catching a single changed
     byte, the command line's own output and exit codes, and **a passkey registered against one
     Postgres, taken out to SQLite and put back into another, signing in there**.
   - It also refuses, before reading a single row, a Postgres whose migrations haven't run, and
     names the command that makes the tables (the first dry run found exactly that, halfway
     through a COPY, with a raw `relation "panel.users" does not exist`).

### The dry run on the live data, 2026-09-19

`sudo node tools/migrate.ts` (the first real change to the live `pammy`: empty tables, nothing
using them), then the dry run on `tools/copy-live-dbs.ts` copies. It passed:

| | rows | tables |
|---|---|---|
| panel | 132 (3 users, **5 passkeys**, 13 sessions, 105 activity) | 7 |
| media | 251 (80 records, 80 thumbnails, 13 tags, 7 categories, 18 scopes) | 9 |
| gate | 497 (424 events, 40 response values, 12 responses, 5 forms, 2 visitors) | 12 |
| **all** | **880, every checksum matching** | 28 |

**2.1 seconds**, so the cutover's unavailable window is seconds, not the "well under a minute" the
plan allowed for. No odd label links were reported: her data has none.

P7 earned its keep: `sqlite_sequence` remembers ids long since deleted, so the next visitor id is
68 (2 rows), the next area 68 (1 row), the next form 61 (5 rows), and the next API key 34 (none at
all). `max(id)` would have handed those ids out a second time.
7. Installer, verify, guides (anything that mentions `.db` files), then build last (the
   rebuild-after-guide-edits rule).
   **BUILT 2026-09-19** (nothing live changed; the release is built at cutover time):
   - `panel.env` drops `PANEL_DB` and `PANEL_MEDIA_DB` and names the database instead
     (`PANEL_PG_HOST/PORT/DATABASE`). Both units get `LoadCredential=db.pass:…`, so systemd reads
     the password as root and puts it where only that service can see it — the gate can't read
     `/etc/pammy-panel` at all (`InaccessiblePaths=`). The gate also gets `GATE_AREAS_SNAPSHOT`
     (P14) and no `GATE_DB`.
   - `/usr/local/sbin/pammy-panel` opens `panel.pass` as root and hands it to the command line on
     **file descriptor 3** (`PANEL_PG_PASSWORD_FD=3`), since the panel's user may not read the
     file. `src/pg.ts` reads the fd itself, not `/dev/fd/3`, which would check the file's
     permissions again as that user.
   - `build.sh` ships `db/` and `tools/` in the release: the services read the migration list on
     start (`checkSchema`), the installer runs the migrations from it, and the port tool needs
     `db/sqlite-baseline`. **This was already missing for steps 3-5** — the release would have
     had no `db/migrations` to check against.
   - `install-panel.sh`: refuses to start unless the database answers and the three password
     files are there; takes a **`pg_dump` before every install** (the old
     `panel.db/media.db/gate.db.before-*` copies are gone); runs the migrations from the release
     it just installed, and puts the previous code back if they fail; and reads the accounts and
     passkeys hash from Postgres before and after, as it always did.
   - `verify-panel.sh` gains a database section: the container is up and listening on 127.0.0.1
     only, the schema is migrated, each password file is root 600, **the panel cannot read
     `gate.*` and the gate cannot read `panel.passkeys`**, `PUBLIC` cannot connect, both units
     use `LoadCredential`, the panel's user can't read the passwords, **no service still holds
     panel/media/gate `.db` open**, the backup timer is on and a dump is there. Its media checks
     now query Postgres, and the media-API check labels files **as the panel's user with the
     password on fd 3**, which tests the wrapper's own mechanism.
   - Her guides need no change: none of them ever named these files (guide 13 is about her own
     MariaDB and Postgres, ports 3307 and 5433). `README.md` and `db/sqlite-baseline/README.md`
     are updated.
   - Tests: unit 416/416, panel nginx 20/20, gate nginx 133/133, browser 43/43.
8. **Cutover** (below).

## Cutover

**The run sheet, with the commands in order, is `docs/cutover.md`.** In outline, at a quiet hour;
her site is unavailable only from when the gate is stopped until the installer starts it again,
which the dry run puts at well under a minute (the port itself is about 2 seconds).

1. `pg_dump` (an empty database, but the habit), and copies of the three `.db` files.
2. Stop **pammy-panel**. Only the panel is unavailable from here.
3. Port `panel.db` + `media.db` and check them.
4. Stop **pammy-gate**; from here her site gives 500s. Port `gate.db` and check it.
5. Install the new release, which runs the migrations (a no-op on the ported schema; they only
   record the version) and starts the gate, then the panel.
6. `verify-panel.sh`, then **by hand**: momolig signs in to the panel with a passkey, a visitor
   signs in to a protected folder, a form sends a response, and the media API answers.
7. Make the `.db` files read-only (`chattr +i`, root) and keep them 30 days. `--reverse` is ready
   for 7 days.

**Going back** (inside 7 days): stop both, run `port --reverse` to fresh `.db` files, reinstall the
last SQLite release, and start. Nothing written after the switch is lost.

## Later, not in this move

`boolean` / `jsonb` / `timestamptz` columns, full-text search over responses and media, row-level
security for limited (scoped) accounts, WAL archiving and point-in-time restore, an off-site
backup, a Unix socket that only the two services can open, and a panel page that shows the
database's health.
