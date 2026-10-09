# S2: the gate's own door to the database helper (master plan Track S, 🔒)

Status: **INSTALLED** 2026-10-08 on both sites, with the fix for the regression found at install
(deleting a Postgres database the gate's helper had open): pammy cf0cfcd0 657/657+70/70+62/62,
lfdln 70ec9d15 711/711 (section "As built"); leftover zz_studio_verify_704662 removed. Merged into main.
Finding: docs/security-performance-review.md S2 (Medium). Rule 12 🔒: a second session reviews
it before it is installed (section "For the review" below). Size S, behaviour unchanged.

## The problem, in one line

The panel and the gate share the database helper's client group (`pammydb-clients` on
pammy.org, `lfdln-pammydb-clients` on lfdln), and the helper doesn't know who is calling, so the
internet-facing gate (or whoever gets code running as its user) can ask for `drop-database`,
`apply-schema`, `create-user`, `grant-access … admin`, `reset-password`, `project-database`:
everything the Studio can do, on every database the helper reaches (Pamela's own included).

## What the gate really asks (checked in the code, 2026-10-08)

| Caller (runs in the gate) | Ops |
|---|---|
| `studio/src/gate/data-api.ts` (the data API, and its connections' labels via `linksOf`) | `list-rows`, `get-row`, `insert-row`, `update-row`, `delete-row` |
| `form-links/src/gate/saves/row.ts` (a form answer saved into a table) | `insert-row` |
| `form-links/src/gate/saves/comment.ts` (comments into their tables) | `list-rows`, `insert-row`, `update-row` |
| `gate/src/admin.ts` (the panel asks the gate to save again, trash, restore: through the two above) | same |

`set-links` is **not** used by the gate (only the panel's record picker), so it is not on the
gate's list. `test/pammydb-gate-door.test.ts` scans every file under `packages/*/src/gate/` and
`packages/gate/src/` that imports the helper's client and holds the ops it sends to exactly
`GATE_OPS`: a new op in the gate fails the test until it is added (and so reviewed), one the
gate stops sending fails it until it is taken out (rule 5).

## The design

**A second door, a second helper process, the gate's group only.**

```
panel  ──► /run/<site>-pammydb.sock       root:<site clients group> 0660 ──► <site>-pammydb.service       every op
gate   ──► /run/<site>-pammydb-gate.sock  root:<gate's own group>   0660 ──► <site>-pammydb-gate.service  row ops only
```

- **The helper refuses at the door** (`packages/studio/src/pammydb/service.ts`): `ALL_OPS`,
  `GATE_OPS = list-rows, get-row, insert-row, update-row, delete-row`, and `handle(drivers,
  req, door)`. With door `'gate'` anything not in `GATE_OPS` is refused before the switch,
  with `not-allowed` ("The gate's door to the database helper answers row requests only.") for
  a real op and `invalid` for an unknown one. Fail-closed: an op added to the switch later is
  refused at the gate's door until someone adds it to `GATE_OPS`. A test holds `ALL_OPS` to
  the switch's cases.
- **Which door is fixed by the entry point, not by the request or an environment variable**:
  `startPammyDb(site, env, 'gate')` in `packages/studio/src/pammydb/main-gate.ts` (pammy.org,
  through the stable `src/pammydb/main-gate.ts`) and `sites/lfdln/src/helpers/pammydb-gate.ts`.
  A unit that ran the wrong file would show in verify (the door's refusals) and in the test
  that reads the units.
- **A process of its own, not a second socket on the first helper** (S2-Q1). The full
  helper's unit is unchanged, so the release before runs untouched beside it, and a rollback
  never meets a helper that gets two sockets it doesn't know (the old `start.ts` exits when
  `LISTEN_FDS` isn't 1). The cost is a second node process (~50 MB) and a second small pool
  per engine, started on first use.
- **The units** (`deploy/pammy-pammydb-gate.{socket,service}`,
  `deploy/lfdln/lfdln-pammydb-gate.{socket,service}`): the socket is `root:svc-pammygate` /
  `root:svc-lfdlngate`, 0660, `Service=<site>-pammydb-gate.service` (the precedent is
  `lfdln-mail-visitor.socket`: the gate's own group, no new group). The service is the full
  helper's unit with another `ExecStart`, `Requires`/`After` and description: the same user
  (`svc-pammystudio` / `svc-lfdlnstudio`), the same two passwords by `LoadCredential`, the
  same sandbox; a test compares the two units key by key.
- **The profiles** say `services.sockets.pammydbGate`; the studio module declares it as a
  fact; the gate (`gate/src/start.ts`, `buildGateApp`, pammy.org's admin wrapper) defaults to it,
  and the gate units set `GATE_PAMMYDB_SOCKET` to it.
- **The clients group is the panel's only**: the installers no longer add the gate's user, and
  take it out (below).
- **SO_PEERCRED: not done** (S2-Q2). Node has no API for a Unix socket's peer credentials
  (it would need a native addon or a `/proc/net/unix` + `ss -xp` lookup per connection, racy
  and slow). The separate socket gives the same answer by the kernel's own file permission:
  only a process with the gate's group can connect at all.

## Install order (expand, then contract, in one install per site)

pammy.org (`deploy/install-panel.sh`):
1. identity (step 1): the clients group gets the panel's user only (the gate isn't added any
   more; it is not taken out here either).
2. step 5: both new units installed; `pammy-pammydb-gate.socket` enabled and started with the
   full helper's socket (only when the studio passwords exist, as before).
3. step 5, just before the gate restarts: `gpasswd -d svc-pammygate pammydb-clients`; then the
   gate restarts with `GATE_PAMMYDB_SOCKET=/run/pammy-pammydb-gate.sock`. Until this restart the
   running gate still has the group it started with and keeps using the old door, so the data
   API, forms and comments never stop.
4. `healthy()`: as before, plus, as the gate's user, `list-databases` at the gate's door must
   come back "not-allowed: The gate's door …" (the door is up, runs the gate's entry, and the
   gate's user can open it), checked with `gate_door_refuses` (`deploy/gate-door.sh`).
5. if anything fails, `put_back_previous`: when the release before predates S2 (no
   `src/pammydb/main-gate.ts`) it stops and disables the gate's door, puts the gate's user back
   in `pammydb-clients`, points `pammy-gate.service` back at `/run/pammy-pammydb.sock`,
   reloads systemd, and only then restarts the gate.

lfdln (`deploy/lfdln/install-lfdln.sh`):
1. 5c: the clients group gets the panel's user only; the four helper units installed.
2. 6 (after the panel is healthy): `lfdln-pammydb-gate.socket` enabled and started beside the
   full one; as the gate's user, the door must refuse `list-databases` with its own words.
3. 6d, just before the gate restarts: `gpasswd -d svc-lfdlngate lfdln-pammydb-clients`, then
   the gate restarts onto `/run/lfdln-pammydb-gate.sock`. If the check in 2 failed, this step
   leaves the gate on the panel's socket and in its group, and the install fails at the end
   (review L4).

## Rollback

- **Within the install** (pammy.org): automatic, above.
- **Later, by installing the release before** (pammy.org's or lfdln's own installer from that
  release): its step 1 / 5c adds the gate's user back to the clients group, its gate unit points
  at the old socket, and it restarts the gate. The new door is left enabled but unused (its
  service would fail to start: no `main-gate.ts` in that release, and nothing connects). To tidy:
  `sudo systemctl disable --now pammy-pammydb-gate.socket` (lfdln: `lfdln-pammydb-gate.socket`).
  The full helper's unit is the same in both releases, so it needs nothing.
- **By hand, in an emergency, without a release**: `sudo usermod -aG pammydb-clients
  svc-pammygate`, set `Environment=GATE_PAMMYDB_SOCKET=/run/pammy-pammydb.sock` in
  `/etc/systemd/system/pammy-gate.service`, `sudo systemctl daemon-reload && sudo systemctl
  restart pammy-gate` (lfdln: the same with `lfdln-pammydb-clients`, `svc-lfdlngate`,
  `/run/lfdln-pammydb.sock`, `lfdln-gate`). New code works on the old door too.

## Tests (written first: they failed on 502ffbe, commit b28d453)

- `test/pammydb-gate-door.test.ts` (fast tier, no engines): the gate's door refuses all 17
  non-row ops before any driver call (a spy driver), answers the 5 row ops, the panel's door
  answers everything; the gate's code sends exactly `GATE_OPS`; `ALL_OPS` is the switch; for
  both sites the units (socket group = the gate's user, the service = the full helper's but the
  entry), the gate unit's `GATE_PAMMYDB_SOCKET`, the installers' group loop (panel only) and
  `gpasswd -d`; both entry processes started for real (`drop-database`, `list-databases`,
  `reset-password` refused; `list-rows` reaches the (absent) engine; socket 0600 when run by hand).
- `test/pammydb.test.ts` (real Postgres and MariaDB): through the gate's door, insert / get /
  update / list / delete work; `drop-database`, `apply-schema` (drop a table),
  `create-user`, `grant-access admin` are refused and the database, its table and the logins
  are unchanged (rule 14).
- `test/profile.test.ts`, `test/modules.test.ts`: the gate units and profiles name the new
  socket; studio declares the fact.
- After the review: the installers' check under pipefail, verify's probes, the open-databases
  cap on both engines (section "The review").

## Verify (both sites, live)

`deploy/verify-panel.sh` / `deploy/lfdln/verify-lfdln.sh`, in the database helper section:
only the panel's user in the clients group; the gate's user can't connect to the panel's door;
the gate's door is `root:<gate group> 660`, nobody is listed in the gate's group, the gate's user
can connect and the panel's, Pamela's, www-data's, PHP's, the other site's (and on lfdln
momolig's, the sites user's, the apps') can't; it refuses `drop-database`, `apply-schema`,
`create-user`, `grant-access admin`, `reset-password`, `list-databases` (and
`project-database` on lfdln) with the door's own words, and passes a row op on to the engine;
the running gate's `/proc/<pid>/status` has no clients group; the gate unit's environment names
its door; the gate's helper runs as the studio user, no sudo, no capabilities. Both helpers are
in the restart counter (`SANDBOXED`).

## Open questions (with suggestions)

- **S2-Q1. A process of its own, or a second socket on the one helper?** *Suggested: its own*
  (as built): rollback-safe, the full helper's unit untouched, fail-closed by entry point. The
  other way is the mail service's (`LISTEN_FDNAMES`), which saves one process.
- **S2-Q2. SO_PEERCRED too?** *Suggested: no* (as built): nothing in Node gives it cheaply, and
  the socket's group already decides who connects. Revisit if a door ever has to be shared.
- **S2-Q3. Rows on which databases?** The gate's door still reaches every database the helper
  can open (Pamela's `pamela` included), as the gate always could; which tables and columns the
  gate may touch is decided in the gate (the catalog, `allow()`), not in the helper.
  *Suggested: leave it for B2/B4*, where the data API moves to its own service with its own
  database logins (backend-plan D7); a per-database list in the helper would duplicate the
  catalog.
- **S2-Q4. The studio password rotated?** Both helpers read it at start; the gate's helper is
  socket-activated and stays up. *Suggested:* the rotation scripts (`no-sudo/install-studio-db.sh`,
  `appdb`/`appmaria` installers) already need a helper restart today; add the gate's helper to
  that note when they are next touched, nothing now.

## For the review (rule 12)

Threat closed: code running as the gate's user (the internet-facing service: a bug in the data
API, forms, comments or the media API, or anything that gets execution in it) can no longer
reach the database helper's administrative ops (drop/create databases, schema changes, logins,
grants, password resets, project databases) on Pamela's engines or lfdln's. It keeps the five row
ops it uses.

Files:
- `packages/studio/src/pammydb/service.ts` (`ALL_OPS`, `GATE_OPS`, the door check),
  `start.ts` (the `door` parameter), `main-gate.ts`, `packages/studio/package.json` (export)
- `src/pammydb/main-gate.ts`, `sites/lfdln/src/helpers/pammydb-gate.ts`
- `packages/core/src/profile.ts`, `sites/pammy/src/profile.ts`, `sites/lfdln/src/profile.ts`,
  `packages/studio/src/module.ts`
- `packages/gate/src/start.ts`, `packages/gate/src/app.ts`, `sites/pammy/src/gate/admin.ts`
- `deploy/pammy-pammydb-gate.socket`, `deploy/pammy-pammydb-gate.service`,
  `deploy/lfdln/lfdln-pammydb-gate.socket`, `deploy/lfdln/lfdln-pammydb-gate.service`,
  `deploy/pammy-gate.service`, `deploy/lfdln/lfdln-gate.service` (comments only:
  `deploy/pammy-pammydb.{socket,service}`, `deploy/lfdln/lfdln-pammydb.socket`)
- `deploy/gate-door.sh`, `packages/studio/src/pammydb/pg.ts`, `maria.ts` (`maxOpen`, after the review)
- `deploy/install-panel.sh`, `deploy/lfdln/install-lfdln.sh`, `deploy/verify-panel.sh`,
  `deploy/lfdln/verify-lfdln.sh`
- `test/pammydb-gate-door.test.ts`, `test/pammydb.test.ts`, `test/profile.test.ts`,
  `test/modules.test.ts`

Things to look at: the svc-pammygate / svc-lfdlngate groups have no other members (verify
checks); the gate's own process (`SupplementaryGroups=www-data` / `lfdln-sites`) gets nothing
new; the window between `gpasswd -d` and the gate's restart (none: the running gate keeps its
groups, the new one starts on the new door); `put_back_previous` on pammy.org.

## The review (rule 12, 2026-10-08: "OK after fixes")

| # | Finding | Done |
|---|---|---|
| **HIGH-1** | install-panel.sh `healthy()`: `(… call.ts list-databases 2>&1) \| grep -q "^not-allowed: …"` under `set -euo pipefail` always failed (call.ts exits 1 on the very refusal wanted), so every pammy.org install would have rolled back, and so would a later rollback onto S2 | `deploy/gate-door.sh` `gate_door_refuses <cmd…>`: output captured (`out=$(…) \|\| true`), then compared; sourced by both installers (lfdln's check uses it too). Tests: the function under pipefail with stubs (refused + exit 1 → true; an answer, another refusal, unreachable → false), the old pipe failing the same stub, and neither installer pipes a door check. Grepped both installers for other `cmd \| grep -q` under pipefail: the rest pipe commands that exit 0 when the answer is the wanted one (ss, find, id, `dpkg-query` where a failure means "missing" anyway, curl -s, the thumbnail `tools` call, `pammy-panel users`) |
| **MEDIUM-1** | verify's probes of the gate's door were valid admin requests (a `db_`/`zzu_` login with a password in the repo, `grant-access … admin`, `reset-password` of Pamela's or an app's login): a door wrongly in full mode would have made or changed logins | probes the op layer refuses even at the panel's door: drop `postgres`, apply-schema on `mysql`, create-user/reset-password `postgres` with an empty password, grant-access for `postgres` on `zz_none`, project-database `postgres`, plus the read-only list. A test reads them out of both verify scripts and runs them at the panel's door with each site's rules: all refused but the list, nothing but reads reaches an engine |
| L1 | the gate's helper could keep a pool (2 connections) per database it is asked about, up to the studio login's CONNECTION LIMIT 20 | `maxOpen` on both drivers, 8 for the gate's helper (`GATE_MAX_OPEN`): the least recently used database's pool is put away (Postgres: `end({ timeout: 30 })`; MariaDB: ended after 30 s), so what it runs can finish. Real-engine test with `maxOpen: 1`, both engines, and on Postgres the put-away database has no connections left |
| L2 | the unit parity test compared chosen keys | it compares every setting line but Description, Requires, After, ExecStart |
| L3 | nothing in verify reads through the running gate end to end | verify-panel.sh reads the first table anyone may read (`gate.studio_catalog`, e.g. the recipe book example) at `https://pammy.org/_pammy/api/data/…` and expects 200 with items; a note when there is none |
| L4 | install-lfdln.sh died mid-install when the door check failed | it now skips only the switch (the gate unit keeps the panel's socket, the gate stays in the group, no `gpasswd -d`), carries on, and fails at the end with what to do |
| L5 | the gate's door kept the full helper's 120 s idle timeout | 30 s at the gate's door (`GATE_TIMEOUT`, the gate's own wait) |
| L6, L7 | notes only, as the review asked (see the review's own text) | nothing changed |

## As built: installed, and a regression found at install (2026-10-08)

- **Installed** 2026-10-08 on both sites: pammy.org 1a5f12c8 (verify 657/657), lfdln 673144d1.
  verify-lfdln's form-link row checks asked as the gate at the panel's door (`dcall "$GATEU"`),
  which the gate can't open any more; 1c8f1c7 (the coordinator's) sends them to the gate's door
  (`gdcall`).
- **The regression** (verify-lfdln rerun, 710/711: "couldn't remove zz_studio_verify_…"): the
  gate's helper is a process of its own, and its per-database pool (idle_timeout 60 s) still
  held a connection to the database the gate had just written into. The panel helper's
  `drop()` closed only its own pool, so `DROP DATABASE` failed "being accessed by other users".
  Live effect: deleting a Studio Postgres database within about a minute of the data API, a
  form or a comment touching it failed with "Something is still connected". MariaDB's drop was
  not blocked.
- **The fix** (`packages/studio/src/pammydb/pg.ts`): `drop()` closes its own pool, then ends the
  sessions of **its own login only** on that database
  (`pg_terminate_backend(pid) … WHERE datname = $1 AND usename = current_user AND pid <>
  pg_backend_pid()`, parameterised), then drops; tried twice if the other helper reconnects in
  between. Not `DROP … WITH (FORCE)`: anyone else connected (her apps' `db_` logins) still makes
  it refuse ("busy"), as before. A pooled connection ended under the gate's helper comes back
  as `unavailable` ("try again") instead of `internal` (57P01, CONNECTION_CLOSED/ENDED/
  DESTROYED); postgres.js opens a new connection on the next request.
- **Tests** (written first, 06421f3, failed on 1c8f1c7): two Postgres drivers on the same
  engine (= the two helpers): the gate's writes into two databases, the panel's drops one → it
  goes; the gate's other database still answers, the dropped one says `not-found`, and made
  again under the same name the gate's helper reaches it. A foreign login connected → the drop
  says `busy`, the database stays and their session is left alone.

## Install (S2)

pammy.org first, then lfdln, one at a time (after the review):

```
sudo ~/pamela-setup-s2/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-s2-pammy.log
sudo ~/pamela-setup-s2/panel/deploy/verify-panel.sh 2>&1 | tee ~/install-logs/verify-s2-pammy.log
sudo ~/pamela-setup-s2/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s2-lfdln.log
sudo ~/pamela-setup-s2/panel/deploy/lfdln/verify-lfdln.sh 2>&1 | tee ~/install-logs/verify-s2-lfdln.log
```
