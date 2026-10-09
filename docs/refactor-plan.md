# Refactor: make the code as easy to change as the panel is to use

Status: **all phases are LIVE** (5 and 6 as one release, 2026-09-23) (started 2026-09-22, momolig: "let's start the refactor").
Written after a read-through of the whole tree (product, data flow, security, code health) on
2026-09-22, against live release 17d3203e, and updated the same day after reading the tutorials
work (commit 8fb7fd5) -- see "What the tutorials work changed" below.

| Release | Installed | What went in |
|---|---|---|
| `b0ba4870cf7218ce` (`f30f11b`) | 2026-09-22 21:44 UTC, verify 535/535, access 60/60 | phase 0 steps 1 and 3: git, the commit in BUILD, the data-API rate-limit bypass (N2), the visitor draft-title leak (N3) |
| `a5cbd0ebd0b4a526` (`2a08af5`) | 2026-09-22 | phase 0 steps 2, 4, 5: the route list, the installer's rollback when the checks fail, the example-kinds check. Step 5's migration guard turned out to be there already (N1) |
| `2031365bba3d4c37` (`c4e79cb`) | 2026-09-22, migration 0015 | phases 1 and 2: the shared form types, and the copy writer rebuilt (B1-B7) |
| `a004444e59bf95c3` (`94b522a`) | 2026-09-22 23:56 UTC or later (BUILD in /opt) | phase 3: `src/app.ts` 4238 -> 202 lines, one file per area, and N4-N8 |
| `6721de1dbbe7bd6b` (`7f2877c`) | 2026-09-23 | phase 4: `src/gate/forms.ts` -> `src/gate/forms/`, `src/gate/app.ts` 989 -> 310 lines |
| `43a76e6b095c9a80` (`0c49f17`) | 2026-09-23 06:06 UTC, **migration 0016**, verify 538/538 (incl. the live schema = snapshot), access 60/60 once the guides were synced | phase 5: the SQLite port and baselines gone, `db/schema.snapshot.sql`, `media_notes` dropped; phase 6: the wording. Supersedes `0dbdb717` (never installed) |

All five questions are answered (see the end). Phase 5 is built; **phase 6 is next**
(Q3: yes, after phase 5).

Why now: Forms, the Database Manager and Studio, Comments, and forms that write into her
tables all landed within a week. The panel works, and it is well tested where it is old. But
the newest code -- where Forms, Comments and Databases meet -- is the least tested and has the
bugs, and `src/app.ts` (3963 lines, ~180 routes in one function) makes every change touch the
same file. The next planned work (tutorials V/P, Turnstile, comment counts) all lands in those
same places. (Since then the tutorials landed there too: `src/app.ts` is now 4235 lines.)

## What the tutorials work changed (read 2026-09-22, commit 8fb7fd5)

New: guides 15-18, `tutorials/`, visitor writes (V1-V7) and PHP (P1-P7) in the gate, and the
tutorial examples on panel.pammy.org (`src/studio/tutorial-examples.ts`, `src/tutorial-demos.ts`,
~265 lines of routes in `src/app.ts`, `deploy/nginx/panel-tutorial-examples.conf`, a second
pammy-php pool). It is carefully sandboxed and well tested (unit, nginx+PHP, browser). What it
means for this plan:

| # | Finding | Where | Goes to |
|---|---|---|---|
| N1 | ~~A migration edited after it ran~~ -- **checked, not a bug**: `0014-visitors.sql` already had the CHECK widening for `tutorial-journal` / `tutorial-todo` in 2f35c44e, the release that first ran 0014 on the live database (`/opt/pammy-panel.prev/db/migrations/0014-visitors.sql`). It only looks edited in git, because the repo was imported at 17d3203e. And the guard I thought was missing is there: `src/pg-migrate.ts` has kept a checksum per migration all along (step 5). | `tools/migrate.ts` | phase 0 step 5 -- checked: the guard is already there |
| N2 | **Fixed and LIVE 2026-09-22 (`b0ba4870`).** Was: the data-API rate-limit bypass (phase 0 step 3). The 2 MB write limit also opened for any request carrying a cookie with the visitor cookie's *name*; `hasVisitorCookie` is gone. | `src/gate/data-api.ts`, `src/gate/app.ts` | phase 0 step 3 -- done |
| N3 | **Fixed and LIVE 2026-09-22 (`b0ba4870`).** Was: the visitor draft-title leak listed under "Before installing V1-V7", live since V1-V7 went in: for a signed-in visitor `keyless` is false, so `connect()` applies no public rule to a connected table that is readable only because it's public. The "no owner field = everyone changes everyone's rows" warning is in the panel now too. | `src/gate/data-api.ts`, `src/gate/studio.ts` | "Visitor writes" -- done |
| N4 | Two hand-written HTTP clients to the gate in the panel (`askGate` and the `/_pammy/comments.js` pass-through), each with its own timeout, chunks and error handling. | `src/app.ts` (tutorial examples) | phase 3: one `src/panel/gate-http.ts` |
| N5 | Four to-do proxy routes repeat the same preamble (`need` manager -> `demoKey()` -> 503) and redo the gate's owner rule (V2) by hand: owner forced on new, `where.owner` forced on lists, a GET before each save/delete. Correct today, but a second copy of V2 that can drift from the gate's. | same | phase 3: one helper, and a test that the panel's proxy and the gate's visitor mode give the same answers |
| N6 | `demoKey()` reads the examples' key back out of `todo-php/settings.php` with a regex, from disk, on every request. | same | phase 3: keep the key with the panel's own state (written once at set-up) and write settings.php from it |
| N7 | Example kinds live in three places: `DB_EXAMPLES`, `TUTORIAL_EXAMPLES` (`refuseExample` looks in both) and the SQL CHECK list, which must be kept in step by hand. | `src/app.ts:2258`, migrations | the check is in verify-panel.sh (phase 0 step 5); one registry still in phase 3 |
| N8 | Setting up the two tutorial databases runs as two separate resets in a loop: if the second fails, the first has already been emptied. Acceptable for examples; say so in the code. | `/api/tutorial-examples/setup` | phase 3 (comment only) |
| N9 | ~~Plan docs say "not installed" though both are live~~ -- fixed 2026-09-22. | docs | done |

Not a problem, on purpose: the panel now answers some `/_pammy/*` paths itself (for the examples),
and `LIMITED_ROUTES` (which only lists `/api/...`) refuses them to limited accounts, on top of the
manager check.

## What this is and isn't

| # | Decision |
|---|---|
| R1 | **Nothing changes for Pamela** except the bugs listed in phase 2 (and phase 6's wording, only if momolig says yes). No new features, no new settings. |
| R2 | **One phase = one release**, through `build.sh` -> install -> verify, like every other plan. A phase that goes wrong is rolled back on its own. Phases 3 and 4 add no migrations, so `/opt/pammy-panel.prev` really is a rollback for them. |
| R3 | **Moves first, changes after.** A phase that moves code (3, 4) does not change what the code does in the same step; a phase that changes behaviour (2) does not move files around. |
| R4 | **A route list guards the moves.** Phase 0 adds a test that lists every route of `buildApp` and `buildGateApp` (method, path, body limit, and the panel's `LIMITED_ROUTES` answer for it) and compares it with a checked-in file. A route lost or quietly un-limited while moving fails the build. |
| R5 | Guides only change in phase 6. If a guide does change, `build.sh` runs last (the install refuses guides edited after the build). |

Not in this plan (their own work, before or after): Turnstile, comment counts in the data API,
off-site backups, and the tutorials' V/P server work -- but see "Before installing V1-V7" below.

## Phase 0 -- the safety net (small)

1. **Version control.** DONE 2026-09-22 (live): `~/pamela-setup` is the private GitHub repo
   `lesfleursdelanuitdev/pammy-setup` (Q1), with `.gitignore` in place. BUILT 2026-09-22: `build.sh` writes the commit into `release/BUILD`
   beside the content hash (first line, "from commit ..."; the installer still reads only the hash
   line), and refuses to build with uncommitted changes unless told (`--dirty`, then the commit
   reads `<sha>+dirty`), so a live BUILD always leads back to its source.
2. **The route list** (R4). DONE 2026-09-22: `buildApp` and `buildGateApp` take an `onRoute`
   callback (a Fastify `onRoute` hook on the root instance, so it sees routes registered later by
   plugins too -- which is what phase 3 and 4 will add). `test/routes.test.ts` builds both apps with
   stubs instead of a database (registering routes touches neither, so the test stays fast) and
   writes one line per method: the app, the method, the path, the body limit, and -- for the panel --
   whether `LIMITED_ROUTES` lets an account limited to one folder reach it. It is compared with
   `test/routes.snapshot.txt` (430 lines: 365 panel, 65 gate, 118 of them open to a limited account);
   the failure prints what went and what is new, and `UPDATE_ROUTES=1 node --test test/routes.test.ts`
   writes the file again when the change is meant. Two more checks don't depend on the snapshot: no
   route is registered twice, and Subdomains, People, Requests, Protected folders, Accounts, API keys
   and Databases stay shut to a limited account whatever moves. The 2 MB doors the data API opens
   (`/_pammy/api/data/.../new` and `/.../:id/save`) are in the list, so N2's fix can't be undone by
   accident either.
3. **Security fix first, as its own release** (not a refactor, but live and small):
   the data API's rate limit is bypassed by any made-up Bearer token
   (`src/gate/data-api.ts:76-82`: an unknown key still gets the keyed allowance, and the
   "you are guessing" limit is skipped whenever a token is sent). Do what the forms and media
   APIs already do -- look the key up first; unknown -> 401 charged to `api-bad:${ip}`; the
   keyed allowance only for a key that exists. The 2 MB write limit (`:254`) then opens only
   for a key that exists or a visitor session that exists, not for any header.
   Tests: random tokens hit the IP limit; a random token can't make the gate read 2 MB.
   LIVE 2026-09-22 (`b0ba4870`): `callerOf()` in `src/gate/data-api.ts` works out key-or-visitor once per
   request (the write routes' `onRequest` and `open()` share it); an unknown key is 401 `bad-key`
   charged to `data-bad:${ip}` (the forms API's code, which its guide already lists); the keyed
   allowance is per key id, not per token prefix; `hasVisitorCookie` is gone. One visible change:
   a revoked key now gets 401 `bad-key` where it used to get 404 `no-app` after the app was
   switched off. Tests in `test/gate.test.ts` ("a made-up key earns nothing").
4. **The installer rolls back when verify fails** (`deploy/install-panel.sh:468`), the same way
   it does when the health check fails, for a release with no new migration. With a migration,
   it stops and prints the `pg_restore` line for the dump it took at `:199-210`.
5. **A migration can't change after it has run (N1).** ~~A guard to add~~ -- **checked 2026-09-22:
   it is already there and always was.** `src/pg-migrate.ts` keeps a sha256 of every migration in
   `public.schema_migrations` beside its name, refuses one whose file changed after it ran, and
   refuses a new file that sorts before the last one that ran; `test/pg.test.ts:98-108` covers all
   three. (Today's install is the proof for the live database: `migrate()` compares every applied
   row's checksum with the file before it runs anything, and it passed with all 14 applied.) So no
   migration 0015 and nothing to write -- phase 2's column, if Q4 says a column, is 0015 and
   `media_notes`' drop is 0016. What remained of this step is the N7 check, DONE 2026-09-22:
   `verify-panel.sh` reads the live `studio_databases_example_check` and compares it with
   `DB_EXAMPLES` + `TUTORIAL_EXAMPLES` as the installed code has them, so an example kind added to
   one and not the other fails the install instead of waiting for her to press Set up.
   (`checkSchema`, which the services run at start, still compares names only: their files are the
   ones the installer already checked, so there is nothing left for it to catch.)

## Phase 1 -- break the gate <-> studio import cycle (small) -- DONE 2026-09-22

`src/studio/form-links.ts:7` imported types from `src/gate/forms.ts`, while six gate files import
from `src/studio/`. The form item and answer types (`AnswerType`, `AnswerValue`, `StoredAnswer`,
`Item`, `ItemType`, `LayoutType`, `Settings`, `ANSWER_TYPES`, `LAYOUT_TYPES`, `DEFAULT_SETTINGS`,
`isAnswerType`, `isLayoutType`, `NAME_PARTS`, `ADDRESS_PARTS`) are now in
**`src/shared/form-types.ts`**, which imports nothing at all. No `src/studio/*` file imports the
gate any more.

Two things came with it:

- `src/studio/form-links.ts` had **its own second copy** of `NAME_PARTS` and `ADDRESS_PARTS`
  (identical to the gate's, and free to drift). Gone: there is one list now. (The front end keeps
  its own in `web/src/lib/types.ts` -- a separate bundle that never imports `src/`.)
- `src/gate/forms.ts` re-exports what it used to define, so the move changes no other file (R3).
  New code asks `shared/form-types.ts`; the re-export goes when phase 4 splits `forms.ts`.

## Phase 2 -- the copy writer, rebuilt around one outcome (medium; fixes bugs) -- DONE 2026-09-22

`src/gate/form-links.ts` **had** two writers (`saveResponse` for row mode, `saveComment` for
comments), each with its own claim, its own `fail()` and several early returns that left
`response_saves` in whatever state it was in. Every bug found on 2026-09-22 came from that, and
every one is fixed below; the line numbers are the file as it was, before `src/gate/saves/`:

| Bug | Where | What goes wrong |
|---|---|---|
| B1 | `retrySaves`, `:327` | Only picks rows with `saved_to IS NULL` and not in the trash. A comment already copied that then fails to be un-approved or trashed (her database asleep) is never tried again: her table keeps showing it, and the thread count stays wrong. |
| B2 | the `saved: null` returns, `:149-158`, `:221-226` | Never clear `save_retry`. They come back every 15 minutes, and 50 of them block the `LIMIT 50` queue for everything newer. |
| B3 | `src/jsonline.ts:145` | A timeout *after the request was sent* is reported as `unavailable`, so it is retried -- but the row may already be in her table. Row mode has no way to tell, so a slow database can give two rows. |
| B4 | `setFormSwitches`, `src/gate/forms.ts:508` | Switching "Responses can be approved" off leaves a link that saves "when I approve": every new response waits for an OK that can no longer be given. |
| B5 | comment claim, `CLAIM_SECONDS = 120` | One comment save makes up to ~7 helper calls of up to 30 s each, so a second try can start while the first is still running. |
| B6 | thread recount | Read-then-write with no lock: two approvals in one thread at once can leave `comments` / `last_at` stale. |
| B7 | `src/gate/app.ts:701` | The public comment total subtracts only the hidden comments on the current page of results. |

How it is rebuilt:

| # | Decision |
|---|---|
| W1 | **One queue, two writers.** `src/gate/saves/queue.ts` owns `response_saves`: `claim()`, `settle(id, outcome)`, `retryDue()`. The writers (`saves/row.ts`, `saves/comment.ts`) only work out what to write and write it; they never touch `response_saves` themselves. Link settings (`saveLink`, `dropLink`, `linkState`, `linksForDatabase`) move to `saves/links.ts`. |
| W2 | **Every try ends in `settle`**, with one of: `done` (sets `saved_to`, clears retry and problem), `wait` (nothing to do yet, e.g. waiting for her OK: clears retry, keeps no problem), `problem` (her words, no retry), `retry` (her words, retried, counts a try), `unsure` (B3, below). No other code path writes the table. Fixes B2. |
| W3 | **The retry queue asks "is there something left to do?", not "was it ever saved?"**: `save_retry` alone picks a row, with or without `saved_to`, trashed or not (for comments, a trashed one must still be turned to "not shown"). Oldest try first, not lowest id, so nothing starves. Fixes B1. |
| W4 | **A timeout is not "asleep".** `callJsonLine` answers `timeout` (a new code) when the request line was already written, and `unavailable` only when it never got that far. Comments are safe to retry on `timeout` (one row per response: `comments.response_id` is unique). Row mode settles as `unsure`: no automatic retry, and Responses says "It may already be in *Guests* -- look there before you press Try again." Fixes B3. |
| W5 | **The claim is renewed between helper calls** (each call pushes `save_claimed_at` forward) instead of a longer fixed time. Fixes B5. |
| W6 | **A thread is recounted under a lock**: `pg_advisory_xact_lock` on (form id, content type, content id) in the gate's database, around the count-and-write. Fixes B6. |
| W7 | **Approvals can't be switched off under a link that needs them** (Q2): `setFormSwitches` refuses, in her words, and points to the form's database page ("This form saves answers in *Guests* when you approve them. Change that to 'as soon as they arrive' first."). Fixes B4. |
| W8 | The public comment total comes from the same count that `pageAllowed` filters (`threadCounts` with the page check), not from `total - hidden on this page`. Fixes B7. |

Stays as it is, on purpose, and is said in the code: row mode writes once and never follows
later changes (form-to-database-plan F-decisions); `hideUnreviewed` does not touch rows already
written.

### How it was built (2026-09-22)

`src/gate/form-links.ts` is gone. In its place, `src/gate/saves/`:

| File | What it is |
|---|---|
| `queue.ts` | the only code that reads or writes `gate.response_saves`: `claim()`, `renew()` (on the claim), `settle()`, `retryDue()`, `counts()`, and the `Outcome` type -- `done`, `wait`, `problem`, `retry`, `unsure` |
| `row.ts` | row mode: catalog checks, `buildValues`, one insert; hands back an outcome |
| `comment.ts` | a comment's copy: thread, link row, the comment, the recount |
| `links.ts` | the link settings (`saveLink`, `dropLink`, `linkFor`, `linksForDatabase`, `linkState`) |
| `save.ts` | which writer, one try at a time, and `retrySaves` / `saveEarlier` |

Decisions taken while building, beyond W1-W8:

- **Q4 = the column** (above): `save_state` and `save_tried_at`, migration `0015-save-state.sql`.
  The retry index is now `(save_tried_at, response_id) WHERE save_retry`, which is the order the
  queue reads in (W3).
- **A `wait` outcome only costs a claim when the queue is holding something.** Otherwise a form
  that was never connected would get a `response_saves` row every time anything asked.
- **W7 lives in `setFormSwitches`, and reads `form_links` directly** (one `SELECT`), because
  `saves/links.ts` asks `forms.ts` about the form: importing it back would be the cycle phase 1
  just removed.
- **`callJsonLine` now tells `timeout` from `unavailable`** (W4), which every caller of the
  helpers sees, not only the saves: `media-thumbs.ts` treats a timeout like "not answering"
  rather than "this file is no good", the panel answers 504 for it, and the two command-line
  callers exit 2 (can't reach) rather than 1 (refused).
- The panel says the new state in her words: Responses reads "Not sure whether this was saved:
  ... It may already be in Recipes: look there before you press Try again", the form's Database
  page counts them ("2 may or may not have been saved"), and the same page now says, where she
  chooses "When I approve a response", that approvals have to stay on while it is set (W7).

Tests: `test/fake-pammydb.ts` (a proxy in front of the in-memory helper, so "taken and never
answered" means the row really was written and the gate really did not hear) -- the plan said
`test/pammydb-harness.ts`, but that file drives the real engines in containers and this is a
different thing. Cases: the unsure state end to end (B3, and no second row until she asks); a
comment un-approved, binned and restored while the database sleeps, put right in one try when it
wakes (B1, W3); two approvals at once leaving the right count (B6); 60 rows with nothing left to
do letting go of the queue so a newer one is saved (B2); approvals refused under an approval link
(B4); a claim ageing in real seconds (B5); and the public comment total with a comment behind a
door, read a page at a time (B7). One browser case in `33-form-database.spec.ts`: the write is
taken and its answer swallowed, Responses says so, and the recipe really is in the app.

## Phase 3 -- split `src/app.ts` into one file per area (large, mechanical) -- DONE 2026-09-23

`buildApp` keeps what it is: one Fastify app, one process. It now only puts it together --
**202 lines**, from 4238. Each area of the panel is one file under `src/panel/routes/`, and what
they share is named:

| File | What it holds |
|---|---|
| `src/panel/context.ts` | `PanelCtx`: config, db, the clock, who is asking (`need`, `authOf`, `actorOf`), what was sent (`body`, the param checkers), and the three helper sockets (`helper`, `gate`, `studio`) |
| `src/panel/limited.ts` | `LIMITED_ROUTES`, the one list of what an account kept to one folder may reach |
| `src/panel/studio.ts` | what every page about her databases asks first: `dashboard`, `cardFor`, `managed`, `liveSchema`, `schemaFor`, `appFor`, `resourceOf`, `pushCatalog`, `refreshCatalog` |
| `src/panel/examples.ts` | the one example-kind registry (N7), `refuseExample`, `fillDatabase`, `remakeExampleDatabase` |
| `src/panel/gate-http.ts` | the one client for the gate's HTTP port (N4) |
| `src/panel/site-files.ts` | what Media, File Explorer and the editor share |
| `src/panel/gate-shapes.ts` | what the gate's admin socket answers with, named once |
| `src/panel/passkeys.ts` | the passkey ceremonies and who is signed in |
| `src/panel/comment-areas.ts` | pointing a comment area at an app's comments tables |
| `src/panel/pages-list.ts` | `PAGE_PATHS` and `nextPage` |

The route files, largest first: `media.ts` 537, `tutorial-examples.ts` 413, `records.ts` 340,
`forms.ts` 313, `visitors.ts` 309, `files.ts` 239, `editor.ts` 214, `sign-in.ts` 205, `db-users.ts`
196, `apps.ts` 194, `comments.ts` 187, `form-links.ts` 167, `shape.ts` 151, `databases.ts` 138,
`accounts.ts` 114, `db-examples.ts` 103, `folders.ts` 50, `pages.ts` 47, `activity.ts` and
`help.ts` 19. None over ~600, and `src/app.ts` is under 200 (the two targets set above).

What the moves found, beyond N4-N8:

- **`import.meta.url` moves with the file.** The media examples' folder was `new URL('../public-gate/examples/', import.meta.url)`, which meant something else from `src/panel/routes/`. The route list cannot catch that; `test/panel.test.ts` did, at once. The examples' folder is now one exported constant (`EXAMPLES_DIR`).
- **`src/studio/form-links.ts` had a second copy of `NAME_PARTS`/`ADDRESS_PARTS`** -- found in phase 1, gone.
- **N5's owner rule now has a test of its own**: `test/panel.test.ts` drives the four to-do proxy routes against a stand-in for the gate's HTTP side, and checks that the panel asks only for this account's tasks, refuses a task that is someone else's without passing it on, and puts the owner on a new task whatever the page sent.
- **N6 kept the key where PHP needs it** (the example's `settings.php`), and stopped the panel re-reading it: it holds what it read, and set-up hands it the new one. There is no migration in phase 3 (R2), so nothing was added to the panel's own tables for this.

## Phase 4 -- the gate's two big files (medium, mechanical) -- DONE 2026-09-23

- **`src/gate/forms.ts` (1140)** -> `src/gate/forms/`:
  `items.ts` (names, limits, `cleanItems`, `cleanSettings`, scopes -- pure),
  `answers.ts` (`cleanAnswers`, `valueRows` -- pure),
  `store.ts` (forms: create, save, copy, switches, trash),
  `responses.ts` (add, list, read, approve, trash, the housekeeping),
  `api-keys.ts`, `threads.ts` (`queryThread`, `threadCounts`, the example-comment reset).
  Imports are updated where they are; no barrel file left behind.
- **`src/gate/app.ts` (979)**: the comments routes (`:607-781`) -> `gate/routes/comments.ts`,
  the responses API (`:787-888`) -> `gate/routes/responses-api.ts`, sign-in and self-service ->
  `gate/routes/visitors.ts`. `/check` and the component files stay in `app.ts`.

### How it was built (2026-09-23)

`src/gate/forms/` is as planned: `items.ts` 333 (also `COMMENT_ITEMS`, `cleanBy`, the limits),
`answers.ts` 164, `store.ts` 225, `responses.ts` 279 (also `formsState`, the Forms tab, which needs
the response counts, and the housekeeping), `api-keys.ts` 74, `threads.ts` 94. `forms.ts` is gone,
with phase 1's re-exports: every import names the file that holds the name, and the form types
come from `src/shared/form-types.ts`. No cycle inside `forms/`: items and answers are pure,
store needs items, responses needs store, threads needs responses.

`src/gate/app.ts` is **310 lines**, from 989. As in the panel (phase 3), what the routes share is
named: `src/gate/context.ts` (`GateCtx`: settings, db, clock, the rate limiter, `hostOf`/`ipOf`/
`baseOf`/`visitorOf`, `post` and `sameOrigin`, `refuse`, `tooMany`, `apiError`, and `API_LIMIT`;
`GateConfig` lives here now) and `src/gate/form-use.ts` (which page a form is on, whether this
visitor may use it, `publicItems`, `notePage`, `answersOut`). The forms routes and the comments
routes are handed one `formPages(ctx)`, so "Used on" is still noted once an hour per page
whichever of them asked. Route files: `routes/visitors.ts` 246, `routes/comments.ts` 189,
`routes/responses-api.ts` 109, and `routes/forms.ts` 55 (the plan did not name it: the two form
routes sat between sign-in and comments). `HOMES` moved to `policy.ts`, beside `PAGE_FILES`.
`/check`, the component files, the built-in pages, the examples and the form preview stay in
`app.ts`, registered in the same order, so the route list is unchanged line for line.

Checks: unit 815, panel nginx 24, gate nginx 161, tutorials 67, browser 104.

## Phase 5 -- take out what the Postgres move left behind (small)

**Built 2026-09-23** (unit 789: the port tests went, pg 59). What was done:
- The port (`src/port.ts`, three tools, `test/port.test.ts`) and `db/sqlite-baseline/` are gone.
- `db/schema.snapshot.sql` (1006 lines, 38 tables): `pg_dump --schema-only` inside the container,
  normalised by `tools/schema-snapshot.ts` (drops comments, SETs, pg_dump 17's `\restrict`).
  `test/pg.test.ts` checks a fresh database against it (`UPDATE_SCHEMA=1` rewrites it);
  `verify-panel.sh` checks the **live** database against the copy in `/opt` and prints the diff.
  The "same rows turned away" cases now run on Postgres only; the FLAGS list went with P6.
- `media_notes`: one writer was left -- the photos/ -> images/ rename (`src/media-rename.ts`)
  moved its paths, which nothing read since `media.imported_notes` (D17). That part is gone
  (`PhotosRenamed.notes` too), then `0016-drop-media-notes.sql`.
- S9's verify check (no studio FK into the ported tables) went with the port: it only
  protected a re-run of the port.
- **Install on or after 2026-09-26**: that's when the `--reverse` window ends; after 0016 a
  reverse port would lose `media_notes`. Rollback = the before-install dump (migration).

What the plan said:

- Delete `src/port.ts`, `tools/port-sqlite-to-pg.ts`, `tools/sqlite-schema.ts`,
  `tools/copy-live-dbs.ts`, `test/port.test.ts`, and stop shipping them (`build.sh:37`).
- `db/sqlite-baseline/` is still what `test/pg.test.ts` compares the ported tables with.
  Replace that check with a schema snapshot of the live shape (`pg_dump --schema-only`,
  normalised), so later migrations are checked against Postgres itself, not against SQLite.
  Then delete the baseline and the `AFTER_SQLITE_COLUMNS` list.
- `media_notes`: confirm nothing reads or writes it (`src/media-db.ts:252` is the copy made once),
  then migration `0016-drop-media-notes.sql`. That makes it a migration release, so this
  phase is rolled back from the before-install dump, not `.prev`.
- The SQLite comments in `src/pg.ts:84,113` and `src/gate/examples.ts:140`.
- **Stays:** `node:sqlite` for the media `index.db` the gate reads -- live, not a leftover.

## Phase 6 -- one word for each idea (optional, Q3; touches guides)

**Built 2026-09-23** (with phase 5 in the same release). What a read of every screen found: **app**
already meant the whole database on ~60 strings (switch it on, App name, its menu group), and the
one-table unit was shown as a **thing** (code: Resource). Settled, as the rename below says:
- **app** = the database's pages (unchanged); **table** = one table, in the designer and in the
  app ("Tables your app manages", "Setting up one table", "How it connects to other tables");
  **record** = one of her rows wherever she works with her data ("sample records", "can change
  records", "how records are told apart"); the designer keeps "row" where it means the table's row.
- **response** for what a form gets, never "entry" (Form examples, Forms, guide 10).
- "app" meaning her own program (Database users) is now "program" / "the recipes website".
- Server messages that reach her screen follow (records.ts, apps.ts activity, comments.ts,
  resources.ts, sample-record activity lines, the conversations table's "Which table" label for
  new ones); the data API's `no-resource` message is "This app has no table called that."
- `web/src/pages/DatabaseResource.tsx` -> `DatabaseAppTable.tsx`. Types (`Resource`,
  `studio_resources`, `'thing'` kind values) stay: they are stored or never shown.
- Guides 10, 14 (PART 10 is three lines now; PART 12 "Setting up one table"), 15 and 17 follow.
- Left alone on purpose: `entries.js` / `.entry` in the example pages (her copies use them),
  the form builder's server errors that say "item" (a heading is an item too; the builder never
  sends one wrong), URLs (none says resource).

What the plan said:

Screens today use row, record, thing, resource, entry and app for overlapping ideas
("The Resource does not hold anything itself", `web/src/pages/DatabaseResource.tsx:231`).
Settle on **table** (in the designer), **app** and **record** (everywhere she works with her
data), and **response** / **comment** for what visitors send. Rename `DatabaseResource` ->
`DatabaseAppTable` in code too, so the code says what she sees. Guides 10 and 14 follow; guide
14 PART 10 gets shorter. `build.sh` last (R5).

## Visitor writes: DONE (fixed in `b0ba4870`; V1-V7 live since 2f35c44e)

Not refactoring, but found in the same review. That release went live without these fixes (N3); they went out
with the phase 0 security release:
- A signed-in visitor sees the titles of unpublished rows through `{id,label}` connections,
  because `publicRule` is chosen by `keyless` (`src/gate/data-api.ts:141-143`) and not by *why*
  that table may be read. Apply the public rule to a table exactly when it's readable only
  because it's public.
- "People signed in to a protected folder" with change or delete on and no owner field lets
  everyone change everyone's rows. By design (V2), but the panel should say so plainly next to
  the switch.

LIVE 2026-09-22 (`b0ba4870`): `onlyPublicRows(key, table, visitor)` in `src/gate/studio.ts` decides the public
rule per table (no key and not signed in to that table's folder), used for the table asked for and
for every connection; test: a signed-in visitor's task no longer shows an unpublished list's name.
The warning is a note under "Whose are they" on the table's page
(`web/src/pages/DatabaseResource.tsx`), shown when a folder is chosen, no owner field, and edit or
delete is on.

## Order and size

| Phase | Size | Release | Migration |
|---|---|---|---|
| 0 | small | security fix (N2) + visitor fixes (N3) **live `b0ba4870`**; route list, installer rollback, example-kinds check **built** | none (N1's guard was already there) |
| 1 + 2 | medium | one | **0015-save-state.sql** (Q4 = a column), so this one goes back from the dump, not `.prev` |
| 3 | large | **done** -- one release, includes N4-N8 | no |
| 4 | medium | **built** -- one release | no |
| 5 | small | **built** -- one release | 0016 (media_notes) |
| 6 | medium | **built** -- with phase 5 | no |

## Questions for momolig

1. **Q1** ~~Where should the git history live?~~ Answered 2026-09-22: the private GitHub repo
   `pammy-setup`.
2. **Q2** ~~Switching approvals off under a link that saves on approval: refuse, or switch the link
   to "as soon as they arrive" by itself?~~ **Answered 2026-09-22 (momolig): refuse (W7).** Nothing
   about her data changes by itself behind her back; the refusal says what to do instead, and the
   form's Database page says the rule where she chooses "When I approve a response" as well.
3. **Q3** ~~Phase 6 (wording) now, later, or not at all?~~ **Answered 2026-09-23 (momolig): do it,
   after phase 5.**
4. **Q4** ~~Row mode's "unsure" state: a new column or kept inside the existing ones?~~
   **Answered 2026-09-22 (momolig): the column.** `save_state` (migration `0015-save-state.sql`),
   one word for how the last try ended, filled in from the three columns that had to be read
   together before. Phase 2 therefore goes back from the before-install dump, not `.prev`.
5. **Q5** ~~Now items before or after the tutorials?~~ Answered 2026-09-22: the refactor started, now.
