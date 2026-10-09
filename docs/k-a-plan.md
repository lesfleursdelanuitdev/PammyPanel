# K-a: the store split (master plan Track 0)

Status: **PLANNED** 2026-10-08 on branch `k-a-store-split` (worktree `~/pamela-setup-ka`, from main
711ae91). K-a1..K-a4 INSTALLED 2026-10-09;
2026-10-09 (K-a4: pammy 827cc740, lfdln 76cf61a7) (sections "K-a1 as built" .. "K-a4 as built");
KA-Q1..KA-Q8 decided 2026-10-09 (all suggestions taken). Size L. Depends on C1, S1, S2 (all live).

Master plan row K-a: `core/src/gate/store.ts` → areas / people / requests; people's widgets out of
`areas/widgets/login.ts`; gate **G3** (the decision → areas, sessions → people with single-flight)
and **G4a** (the store split); the **gate-op kit** (`GateError`, input cleaning, `logEvent`) stays in
the kernel; **visitor settings** and passwords move to `people`. Behaviour unchanged, except review
**P2** (the session cache: single-flight, and forgetting only the visitor who changed). Read with
docs/module-contracts-plan.md section 4 (the kernel; "What moves out of core"),
docs/module-dependency-graph.md section 3 (the kit, visitor settings: decided 2026-10-08),
docs/code-health-plan.md G3 / G4a, docs/security-performance-review.md P2.

## The rule that shapes the slices

**Core imports no module** (test/boundaries.test.ts, `DEPENDS_ON.core = []`). So the shim C1 and
the packaging step used ("the old path re-exports the new one") can't run in this direction:
`core/src/gate/store.ts` can never re-export what has moved into `@panel/areas` or `@panel/people`.
Two consequences:

1. **Each slice moves code and switches every caller in one go** (packages, sites, tests). What
   stays in core may only use what stays in core, so the slices go in the order that keeps that
   true: the kit (stays), the session cache (core's `live.ts` stops needing `rolesOf`), people,
   requests, areas last (people's code still in core uses `areaById` until people has moved).
2. **The shim runs the other way where it is needed**: a module file may re-export from core
   (`export { … } from '@panel/core/gate/store'`) while its callers switch, then take the bodies
   over. No other branch imports these names (`core/src/gate/**`, `packages/gate/**`,
   `packages/areas/**` are frozen while K-a is open, master-plan section 6; checked: nothing in
   `packages/projects/` imports them), so nothing outside the branch breaks between slices.

`test/k-a-surface.test.ts` (K-a1) is the map that replaces a codemod: **every name `store.ts`,
`live.ts`, `passwords.ts` and `visitor-settings.ts` exported at 711ae91, and where it lives now**.
Each slice updates the map in the same commit as the move; the test imports every name from its
new home, so a name can't get lost, and a rebasing branch reads where its import went.

## Database and migrations: none

No table, column, index or migration changes in any slice. `db/schema.snapshot.sql` stays as it is
(verify on both sites compares the live schema with it), migrations keep their files and order
(`db/migrations/0003-gate.sql` and `packages/areas/migrations/0001-0006`), and every table keeps
its name and schema (module-contracts-plan: "K-a and K-b change no schema names"). A rollback is
always "install the release before": the old code reads the same tables.

What does change is **who owns a table on paper** (the coupling report's `BASELINE` / `MOVED` in
`tools/coupling/scan.ts`), where the code that touches it moves: see KA-Q1 (`gate.events`) and
KA-Q3 (`gate.visitor_settings`). That is the report only; the allow list
(`docs/coupling-allow.json`) only shrinks.

## What moves where

Function by function. "core" = the kernel (`packages/core`, `@panel/kernel` after K-rename).

### store.ts (612 lines)

| Today (`core/src/gate/store.ts`) | Goes to | Slice |
|---|---|---|
| `GateError`, `cleanLine`, `cleanMessage`, `cleanBy`, `int`, `logEvent` (the **gate-op kit**) | `core/src/gate/ops.ts` (`@panel/core/gate/ops`), stays in the kernel | K-a1 |
| `VISITOR_COOKIE` | core (`gate/context.ts`: the kernel's gate context reads the cookie; `hosts/src/config.ts` and test/hosts-render check the two agree) | K-a4 |
| `AREA_TOKEN_RE`, `MARKER`, `cleanAreaPath` re-exports | dropped: callers import `@panel/core/names` (they already live there; `names` goes to files in K-b) | K-a6 |
| types `Area`, `Visitor`, `AreaRole` | `core/src/gate/types.ts` for K-a (KA-Q5), re-exported by areas / people | K-a2 |
| `VISITOR_SESSION`, `createVisitorSession`, `revokeSession`, `revokeVisitorSessions` | people `src/gate/sessions.ts` (the rows) | K-a4 |
| `VISITOR_NAME_RE`, `cleanVisitorName`, `EMAIL_RE`, `cleanEmail`, `passwordProblem` | people `src/gate/accounts-store.ts` (names) or `src/shared/` where a page needs them | K-a4 |
| `visitorById`, `needVisitor`, `createVisitor`, `setVisitorContact`, `setVisitorPassword`, `setVisitorActive`, `renameVisitor`, `deleteVisitor` | people `src/gate/visitors.ts` | K-a4 |
| `visitorByLogin`, `passwordMatches`, `checkCredentials`, `signInCheck` (and the dummy hash) | people `src/gate/sign-in-check.ts` | K-a4 |
| `LINK_LIFETIME(S)`, `LinkPurpose`, `Link`, `cancelLinks`, `openLink`, `createLink`, `liveLink`, `linkForToken`, `useLink`, `makeEmailedLink` | people `src/gate/links.ts` | K-a4 |
| `Registered`, `registerVisitor`, `forgetRegistration`, `UNCONFIRMED_KEPT`, `useConfirmLink`, `useResetLink`, `changeOwnPassword`, `startEmailChange`, `deleteOwnAccount` | people `src/gate/self-service.ts` | K-a4 |
| the reset-request touches inside `useLink` / `useResetLink` (`UPDATE requests … kind = 'reset'`) | requests, behind a people socket (KA-Q2) | K-a4 / K-a5 |
| `MAX_OPEN_REQUESTS(_PER_FOLDER)`, `Request`, `requestById`, `countOf`, `addAccessRequest`, `addResetRequest`, `resolveRequest`, `deleteRequest` | requests `src/gate/store.ts` | K-a5 |
| `areaByToken`, `areaByPath`, `areaById`, `createArea`, `moveArea`, `setRequestsOpen`, `deleteArea` | areas `src/gate/store.ts` | K-a6 |
| `PAGES_READ`, `rolesOf`, `opensArea`, `guestPrivileges`, `openToAll`, `setMember` | areas `src/gate/roles.ts` (`setMember` checks the visitor with its own read of `gate.visitors`, which the allow list already has: "areas reads gate.visitors") | K-a6 |
| `housekeeping` | split: people's (sessions, links, unconfirmed accounts), the kit's (`events` older than 180 days), requests' (handled requests older than 180 days); `gate/src/housekeeping.ts` calls the three. The order changes (people, kit, requests instead of interleaved): every foreign key between them is `ON DELETE SET NULL` / `CASCADE`, so the result is the same | K-a4, K-a5 |

### The other gate files in core

| Today | Goes to | Slice |
|---|---|---|
| `live.ts` `visitorForSession`, `#loadSession`, `forgetSession`, the session map, `SESSION_FRESH`, `SESSION_STALE`, `MAX_SESSIONS` | people `src/gate/session-cache.ts` (`VisitorSessions`), handed to `GateLive` by the host through a small core interface (`SessionSource`, in `core/src/gate/live.ts`); `GateLive.changed()` asks it to forget | K-a2 |
| ... and single-flight + forgetting one visitor (review P2) | the same file | K-a3 |
| `live.ts` areas snapshot, visitor settings in memory, site routes, `Access`, `AreaLookup` | **stay** until K-b (G4b: registered caches) | — |
| `passwords.ts` `hashPassword`, `verifyPassword` (scrypt) | core `security.ts` (module-contracts-plan: "the scrypt hashing function itself stays in the kernel": `backends` hashes passwords too) | K-a4 |
| `passwords.ts` `isCommonPassword`, `common-passwords.txt` | people `src/gate/passwords.ts` + the file beside it (it is read with `import.meta.url`; build.sh copies `packages/` whole, so the release has it) | K-a4 |
| `visitor-settings.ts` (129 lines) | split, KA-Q3: the read side (`SWITCHES`, `Switch`, `VisitorSettings`, `ALL_OFF`, `BUILT`, `settingsOf`, `SettingsState`, `readVisitorSettings`) **stays in core** with the in-memory picture until K-b; the rules and the writing (`NEEDS`, `needing`, `whyNot`, `Abilities`, `SWITCH_WORDS`, `setVisitorSwitch`) → people (`src/gate/visitor-settings.ts`; words and `whyNot` in `src/shared/visitor-switches.ts` for settings' page). `setVisitorSwitch`'s two checks on areas' tables become areas functions (`ownRoleSetsInUse`, `routesOpenToAll`) | K-a4 |
| `context.ts` | stays (kernel); imports the kit from `ops.ts` | K-a1 |

### The gate host and the decision (G3)

| Today (`packages/gate/src/app.ts`, 454 lines) | Goes to | Slice |
|---|---|---|
| `GET /check`, `GET /check/:token`, `/check/:token/:audience`, `identity()`, `folderWithoutHome()` | areas `src/gate/routes/check.ts` (`registerCheck(ctx)`), mounted by the host **always**, as today (KA-Q7). It needs only `GateCtx` (`visitorOf`, `live`, `cfg.identityKey`) and areas' own `policy.ts`; app.ts drops under 400 lines | K-a6 |
| built-in pages' `routeLogin` wording | areas (with the check: it reads a route's area) | K-a6 |

### Widgets (`packages/areas/widgets/login.ts`, 735 lines, one built `login.js`)

| Today | Goes to | Slice |
|---|---|---|
| `<pammy-login>`, `-forgot`, `-invite`, `-register`, `-confirm`, `-reset`, `-account`, `-signed-out`, `-logout` | people `widgets/accounts.ts` | K-a7 |
| `<pammy-request>` | requests `widgets/request.ts` | K-a7 |
| `<pammy-welcome>` | stays in areas (`widgets/welcome.ts`) | K-a7 |
| `Base`, `Box`, `RequestError`, `post`, the info/folder helpers | areas `widgets/kit.ts` (people and requests both depend on areas; KA-Q6) | K-a7 |
| the bundle: `login.js` at `/_pammy/login.js`, one file, same tags | entry `sites/pammy/widgets/login.ts` (a site composes: imports the three; its opening comment is today's header, her guide's reference, word for word) | K-a7 |

## Slices (each its own release on both sites, pammy.org first)

| Slice | What | Behaviour | Needs |
|---|---|---|---|
| **K-a1** | the **gate-op kit** named: `core/src/gate/ops.ts`; `store.ts` re-exports it (core → core: allowed); the 19 module files, `context.ts`, `visitor-settings.ts` and the tests that use only kit names import `@panel/core/gate/ops`. Tests first: the kit's exact behaviour, and the surface map | unchanged | — |
| **K-a2** | **the session cache to people** (G3, sessions half): `VisitorSessions` in people; `GateLive` takes a `SessionSource` (core interface) and delegates `visitorForSession` / `forgetSession`; `changed()` still forgets every session; the host (`gate/src/start.ts`) and the test helpers build it; types to `core/src/gate/types.ts` | unchanged | KA-Q5 |
| **K-a3** | **review P2**: single-flight (the in-flight promise kept in the map, dropped when it fails) and `forgetVisitor(id)`: a sign-out, password change, switch-off or deletion forgets that visitor's sessions only; area and role changes still forget everyone's (roles are cached per session) | **faster** (P2), the same answers | — |
| **K-a4** | **people's store**: visitors, links, sign-in checks, self-service, session rows, password rules, `common-passwords.txt`, visitor settings' rules and writing; scrypt into core `security.ts`; settings' page imports people's `shared/` | unchanged | KA-Q2, KA-Q3, KA-Q4 |
| **K-a5** | **requests' store** and its housekeeping part | unchanged | KA-Q2 |
| **K-a6** | **areas' store and the decision**: areas CRUD, roles, `/check` and `/check/:token` mounted from areas | unchanged | KA-Q7 |
| **K-a7** | **widgets** split (one `login.js` still) and the **contract**: `store.ts` and `passwords.ts` gone from core, `./gate/store` and `./gate/passwords` out of core's exports, size and coupling allow lists shrunk, the report's owners, "as built", master-plan row | unchanged | KA-Q6 |

Seven releases is a lot of install windows: KA-Q8 asks whether K-a5..K-a7 may go as one.

### K-a1 in detail (built: section "K-a1 as built")

- **Tests first, on 711ae91's code** (they pass before the move and after it):
  `test/gate-ops-kit.test.ts`: `cleanLine` (control characters, runs of white space, NFC, the cap
  counted in code points, non-strings), `cleanMessage` (line breaks kept, CRLF, three blank lines
  to one, trailing spaces, the cap), `cleanBy`, `int`, `GateError` (code, message, field,
  `instanceof Error`), `logEvent` on Postgres (the row, the 80-character username, nulls), and
  that `context.ts`'s refusals still map every `GateError` code to the same status.
  `test/k-a-surface.test.ts`: the map of every name the four files exported at 711ae91 to where it
  lives now; each name is imported from its home and must be defined (types are checked by `tsc`
  through a type-only import list).
- **Then the move**: `ops.ts`; `store.ts` keeps `export { … } from './ops.ts'` so the names it
  had stay (same objects: `GateError` thrown by forms is still `instanceof` the one the gate's
  `refuse` checks; the surface test asserts `===`); callers switched; core's `package.json`
  exports `./gate/ops` (`node tools/coupling/entries.ts`); the coupling report regenerated
  (`node tools/coupling/report.ts`): files move, the allow list's lines don't (core still writes
  `gate.events`).

## Tests that pin behaviour before each move

Each slice's tests are committed first and pass on the code before the move.

| Slice | Pinned first |
|---|---|
| K-a1 | the kit (above); the surface map |
| K-a2 | test/gate-live.test.ts already pins fresh / stale / revoked / host / switched off; added: `forgetSession` drops one token only, `changed()` drops all, the 10,000 cap, a session checked while Postgres is down within 15 minutes counts, and the same through a `GateLive` built the way `start.ts` builds it |
| K-a3 | (behaviour change, so the tests are new and fail before): 40 parallel lookups of one expired session = 1 load (counted with a spy `Sql`); a failed load is not kept (the next lookup loads again); A signing out keeps B's cached session (no load); A's password changed drops A's, not B's; an area or role change drops everyone's |
| K-a4 | test/accounts.test.ts, visitor-settings.test.ts, account-deletions.test.ts, access.test.ts already cover the functions; added: the reset requests a chosen password closes (setup link and reset link), the dummy-hash timing path (a wrong username still runs scrypt: a spy on `verifyPassword`), `setVisitorSwitch`'s two refusals (own roles, open routes) word for word |
| K-a5 | test/notices.test.ts and panel.test.ts cover requests; added: the per-folder and total caps, "the same person asking again updates", reset requests for unknown usernames recorded nowhere |
| K-a6 | test/gate.test.ts, gate-routes.test.ts, route-areas.test.ts, lfdln-gate.test.ts pin `/check`; added: the routes snapshot (test/routes.snapshot.txt) unchanged with `/check` registered from areas, and every header `/check/:token/:audience` sets |
| K-a7 | the widget e2e (test/e2e: sign in, forgot, invite, request, welcome, logout, the account pages) and the example looks; added: `public-gate/login.js` defines the same eleven tags, and its banner is the header word for word |

Fast tier (`./build.sh --tier fast`) on every commit; the full build before each install
(`./build.sh`, logged to `~/install-logs/build-ka-<n>.log`).

## How both sites are verified

Every slice changes the gate, which both sites run, so every slice is installed and verified on
**both**, pammy.org first, then lfdln (master-plan rule 10):
- **Build**: the full tier: the gate nginx tests (pammy.org's vhost, and the same through its
  rendered hosts), lfdln's hosts and route-accounts nginx tests (`/check/<token>`, signed proofs),
  the tutorials (the gate behind real nginx and PHP), both panels' browser tests.
- **Live**: `deploy/verify-panel.sh` and `deploy/lfdln/verify-lfdln.sh` with **the same counts as
  the release before** (at 711ae91: pammy 657/657 + 70/70 + 62/62, lfdln 711/711): the protected
  folder sign-in, a form answer, a comment, the media API, visitor settings over the admin socket
  (pammy.org's smoke list, master-plan section 7), and on lfdln exam prep's signed check.
- K-a3 (P2) adds nothing to verify (the cache is in memory); its test is the proof.

## Rollback (per slice)

No slice changes the schema, the units, the sockets or nginx, so each rolls back by **installing
the release before** with its own installer (`deploy/install-panel.sh`, then
`deploy/lfdln/install-lfdln.sh`). The old code reads the same tables. The installers' own
`put_back_previous` covers a failed health check during an install. Nothing to tidy by hand.
K-a3's in-memory cache starts empty either way.

## Open questions (each with a suggestion)

**DECIDED 2026-10-09: momolig took all eight suggestions (KA-Q1..KA-Q8), as written below.**

- **KA-Q1. Who owns `gate.events`?** The coupling report says people (by meaning, at C1), but the
  kit's `logEvent` (kernel) writes it for forms, comments, requests and people, and the gate host's
  `state()` reads it for People's "last signed in" and "failed sign-ins". *Suggested:* the kernel
  owns it (the gate's event log, as `panel.activity` is the panel's): `BASELINE['gate.events'] =
  'core'`, and its 180-day purge goes with `logEvent` (`eventsHousekeeping` in `ops.ts`). Report
  only, no schema; done in K-a4 with the housekeeping split.
- **KA-Q2. People and requests point at each other.** Requests' "forgot my password" looks a
  visitor up by username (people's table); people closes open reset requests when a password is
  chosen and, with emailed links on, files a reset request for an account without an address
  (requests' table). Both modules are essentials (always on). *Suggested:* **requests needs
  people** (`needs: ['areas', 'people']`: a reset request is about an account; its lookup is
  people's `visitorByUsername`), and people's two touches go through a small socket people owns,
  `ctx.people.resetRequests` (`close(q, visitorId, now)` inside the same transaction, `add(…)`),
  filled by the host when requests is on, as `responseKept` is for forms. No module names the
  other's tables. The other way (allow-list entries "people writes gate.requests", "requests reads
  gate.visitors") is smaller but grows a list that should only shrink.
- **KA-Q3. Visitor settings: which part moves now?** `live.ts` (core, until K-b's registered
  caches) keeps the switches in memory and in its snapshot, and areas' Access and route ops read the
  `roles` / `openAreas` switches; areas can't import people (people needs areas). *Suggested:* the
  read side stays in core until K-b (the type, `ALL_OFF`, `BUILT`, `settingsOf`,
  `readVisitorSettings`); the rules and the writing go to people now; `gate.visitor_settings` is
  owned by people on paper (`MOVED`, it was made by areas' 0001); `setVisitorSwitch`'s two checks
  on areas' tables become areas functions. In K-b the read side moves to people as a registered
  cache and areas gets the two switches through it.
- **KA-Q4. Settings needs people.** Settings' page uses `SWITCH_WORDS` and `whyNot`.
  *Suggested:* they go to people's `src/shared/visitor-switches.ts` and settings declares `needs:
  ['people']` (as decided: "switches read by settings through people's API"); both sites have
  people on wherever settings is. test/modules.test.ts's frozen NEEDS gets that one change, with
  the reason in the commit. (U1's `worksWith` can loosen it later.)
- **KA-Q5. Where do the row types live during K-a?** `Area`, `Visitor`, `AreaRole` and `Access`
  are used by core (`GateCtx.visitorOf`, `live.ts`'s areas, `AreaLookup`) and by modules.
  *Suggested:* `core/src/gate/types.ts`, re-exported by areas and people, until C6-min's identity
  contract replaces `Access` and K-b moves `Area` with the areas cache.
- **KA-Q6. The widgets' shared parts and the bundle's entry.** *Suggested:* `Base`, `Box`,
  `RequestError` and the helpers in areas' `widgets/kit.ts`; `login.js` built from
  `sites/pammy/widgets/login.ts`, which imports areas', people's and requests' widgets and keeps
  today's header word for word (her guide points at it). One file at one address, as now.
- **KA-Q7. `/check` mounted always?** Today the gate answers `/check` whatever the profile says.
  *Suggested:* areas registers it and the host mounts it always, as now (areas is an essential);
  the module host in K-b makes it areas' gate part.
- **KA-Q8. Seven releases?** *Suggested:* K-a1..K-a4 each on its own (the kit, the cache move,
  P2, people: each worth rolling back alone); K-a5, K-a6 and K-a7 may go as one release if
  momolig prefers fewer install windows (each is still its own commit and its own tests).

## K-a1 as built (2026-10-08, not installed)

- Tests first (e3d0180, passing on 711ae91's code): `test/gate-ops-kit.test.ts` (cleaning word
  for word, `GateError` and its answer for every code through `gateCtx().refuse`, `logEvent`'s row
  on Postgres) and `test/k-a-surface.test.ts` (84 names: store 67, live 3, passwords 3,
  visitor-settings 11; each imported from its home; while store re-exports a moved name it is the
  same object).
- The move (df4ad91): `packages/core/src/gate/ops.ts`; `store.ts` re-exports the kit; 19 module
  files, `context.ts`, `visitor-settings.ts`, `test/access.test.ts` import the kit from
  `@panel/core/gate/ops`; core's exports gain `./gate/ops`; coupling report regenerated (only
  `core writes gate.events` gains `ops.ts` in its file list; allow list unchanged).
- Found while pinning: `GateError` without a field still has an own `field` property (undefined),
  from the class field declaration; pinned as it is.
- Build: fast tier and full build passed (`~/install-logs/build-ka-1.log`): unit tests, nginx 34,
  gate nginx 181 + 179 (hosts), hosts 70, route accounts 81, adopt 32 + 25, move-db 83, to-pasta
  34, offsite 30, tutorials 67, projects 11, e2e pammy 122, e2e lfdln 62. Releases: **pammy
  461cd7a637d284c3**, **lfdln 6a862610fb0c1633**.
- Install (pammy.org first, then lfdln, one at a time); verify should show the same counts as
  the release before:

```
sudo ~/pamela-setup-ka/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-ka-1-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/verify-panel.sh 2>&1 | tee ~/install-logs/verify-ka-1-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-ka-1-lfdln.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/verify-lfdln.sh 2>&1 | tee ~/install-logs/verify-ka-1-lfdln.log
```

## K-a2 as built (2026-10-09, installed)

- Tests first (9b0c1c0, passing on the code before the move): `test/session-cache.test.ts` pins
  the cache: who is signed in with roles and opens; nobody for a missing, malformed or unknown
  token or another host; 60 s from memory, then asked again; `forgetSession` forgets one token
  only; `changed()` forgets everyone's; a kept session past its expiry or of someone switched off
  counts for nothing; last seen noted at most every 5 minutes. (The 10,000-entry cap is not
  pinned: it would take 10,000 real sessions; the code is moved unchanged.)
- The move (37c711c): `packages/people/src/gate/session-cache.ts` (`VisitorSessions`,
  `visitorSessions`, `SESSION_FRESH`, `SESSION_STALE`), the same code `live.ts` had. Core's
  `GateLive` takes a `SessionSource` (`LiveOptions.sessions`, a kernel interface: `visitorFor`,
  `forget`, `forgetAll`; given `{ db, now, ready }`) and delegates `visitorForSession` and
  `forgetSession`; `changed()` calls `forgetAll()`. `gate/src/start.ts` and every test that builds a
  `GateLive` hand in `visitorSessions`. `Area`, `Visitor`, `AreaRole`, `Access` are in
  `core/src/gate/types.ts` (KA-Q5), re-exported by `store.ts` and `live.ts`; `live.ts` no longer
  imports the store. Coupling: "core reads gate.sessions" gone (allow list shrunk by one).
- Callers of `visitorForSession` / `forgetSession` (the gate context, people's routes) are
  unchanged.
- Build (2026-10-09, from 302eebb = K-a2 + main with 17feeb8): fast tier and full build passed
  (`~/install-logs/build-ka-2.log`): unit tests, nginx 34, gate nginx 181 + 179, hosts 70, route
  accounts 81, adopt 32 + 25 + 27, move-db 83, to-pasta 34, offsite 30, tutorials 67, projects 11,
  e2e pammy 122, e2e lfdln 62. Releases: **pammy 931b16c558826d2f**, **lfdln afc334c632a82021**.
- Install (pammy.org first, then lfdln, one at a time; verify: the same counts as K-a1):

```
sudo ~/pamela-setup-ka/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-ka-2-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/verify-panel.sh 2>&1 | tee ~/install-logs/verify-ka-2-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-ka-2-lfdln.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/verify-lfdln.sh 2>&1 | tee ~/install-logs/verify-ka-2-lfdln.log
```

  Rollback: install K-a1 again (pammy 461cd7a6, lfdln 6a862610) from its commit (85315f2 /
  main 904f5cc); no schema change.
- **Installed 2026-10-09:** pammy 931b16c5 (install and verify: panel 657/657, software 70/70,
  Pamela's account 62/62), then lfdln afc334c6 (install and verify: 711/711).

## K-a3 as built (2026-10-09, installed): review P2

- Tests first (e6e3636; 5 of 6 failed on the code before, as they should; the sixth pins
  today's "a failed load isn't kept"), in `test/session-cache.test.ts`, with loads counted by
  a spy on the gate's `Sql`: 40 lookups at once of a session not kept = **1 load** (and 1 more
  after it goes stale); a failed load is shared by those waiting and not kept; `forgetVisitor`
  forgets both of jo's sessions and none of sam's; a load in flight when its visitor, its token
  or everything is forgotten is not kept; through the admin socket, an owner's new password for
  jo signs jo out and leaves sam's cached session alone, a grant to sam shows at once, and an
  area change still forgets everyone's.
- The change (d88d932): `VisitorSessions` keeps the load in flight per token; `forgetVisitor`;
  a forget counter so a load that started before a forget isn't kept. `SessionSource` gains
  `forgetVisitor`; `GateLive.changed({ visitor })`. One visitor only: the admin socket's
  `visitor.*` (not `visitor.create`), `grant`, `access.person`; people's routes after a setup or
  reset link is used, a password change, signing out everywhere, deleting the account.
  Everything else (areas, roles, role sets, route areas, the switches) forgets everyone's.
- **Review (read-only, 2026-10-09): OK after one fix**, applied tests first (5fcc6f0, then the
  fix):
  - MEDIUM: a lookup arriving after `forgetVisitor` could join a load begun before it, and so let
    in someone just switched off, demoted or with a new password. Now each load in flight
    remembers the forget count when it began, and only a lookup with nothing forgotten since may
    join; otherwise it loads anew and the old load is not kept. The test holds the first load
    after it has read the visitor, switches the visitor off and forgets them: the second lookup
    loads again and is refused (it was let in before the fix).
  - LOW 1: the "failed load is shared" test now fails the load itself (5 lookups at once: all
    refused, 1 load; the next lookup loads again); the old test stays as "while Postgres is not
    ready".
  - LOW 2: `test/session-forget.test.ts`: with V's two sessions and B's in memory, each
    one-visitor change (owner: switched off, deleted, signed out, a role given; themselves: a new
    password, a setup link used, deleting the account) refuses or reloads V's and answers B's from
    memory; an area change still reloads B's.
  - INFO taken: the per-visitor forget marks are dropped when nothing is in flight.
  - Noted, unchanged (both pre-existing): changing one's email address forgets nothing (it
    changes nothing the gate tells apps); the gate has no Postgres statement timeout.
- Fast tier passed (`~/install-logs/build-ka-3-fast.log`).
- Build (2026-10-09, from 0a60b43 = K-a3 on K-a2 as installed): full build passed
  (`~/install-logs/build-ka-3.log`): unit tests, nginx 34, gate nginx 181 + 179, hosts 70, route
  accounts 81, adopt 32 + 25 + 27, move-db 83, to-pasta 34, offsite 30, tutorials 67, projects 11,
  e2e pammy 122, e2e lfdln 62. Releases: **pammy 0fba4ee07cacba84**, **lfdln 08c9b390d07a0c76**.
- Install (pammy.org first, then lfdln, one at a time; verify: the same counts as K-a2):

```
sudo ~/pamela-setup-ka/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-ka-3-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/verify-panel.sh 2>&1 | tee ~/install-logs/verify-ka-3-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-ka-3-lfdln.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/verify-lfdln.sh 2>&1 | tee ~/install-logs/verify-ka-3-lfdln.log
```

  Rollback: install K-a2 again (pammy 931b16c5, lfdln afc334c6) from main a590025; no schema
  change.
- **Installed 2026-10-09:** pammy 0fba4ee0 (install and verify: panel 657/657, software 70/70,
  Pamela's account 62/62), then lfdln 08c9b390 (install and verify: 711/711).

## K-a4 as built (2026-10-09, installed): people's store

- Tests first (bbb1f41, passing on the code before the move): `test/people-store.test.ts`
  through lfdln's gate: a password chosen with a **setup link** and with an **emailed reset
  link** closes that person's open reset requests (`done`, `they chose a new password`, at that
  moment) and leaves another person's open; a refused password (a common one) closes nothing.
  **The dummy hash**: a wrong password, a username nobody has, a malformed one, no password,
  one over 200 characters and an account still waiting for its setup link each run scrypt
  exactly once, as the right password does (ESM bindings can't be spied on, so the spy is on
  `node:crypto`'s `scrypt` with `syncBuiltinESMExports()`: the one thing `verifyPassword`
  does that takes time). `setVisitorSwitch`'s two refusals word for word, with the code and
  the switches unchanged after: test/access.test.ts (`First put "club" back on the built-in
  roles (Access, Roles).`) and test/route-areas.test.ts (`First take accounts off "<host>/"
  (Hosts), or make them "Only people let in".`, for `openAreas` and for `emailedLinks`, which
  takes it off too).
- The move (b071f66):
  - `packages/people/src/gate/`: `sessions.ts` (`VISITOR_SESSION`, `createVisitorSession`,
    `revokeSession`, `revokeVisitorSessions`), `accounts-store.ts` (`EMAIL_RE`, `cleanEmail`,
    `passwordProblem`; `VISITOR_NAME_RE`, `cleanVisitorName` re-exported, see below),
    `visitors.ts`, `sign-in-check.ts` (with the dummy hash; `passwordMatches` exported for
    self-service), `links.ts`, `self-service.ts`, `passwords.ts` (`isCommonPassword`, with
    `common-passwords.txt` beside it, `git mv`), `housekeeping.ts` (`peopleHousekeeping`:
    sessions, links, unconfirmed accounts), `reset-requests.ts` (KA-Q2's socket),
    `visitor-settings.ts` (`needing`, `setVisitorSwitch`); `src/shared/visitor-switches.ts`
    (`NEEDS`, `Abilities`, `whyNot`, `SWITCH_WORDS`), which Settings > Visitors imports.
  - core: `VISITOR_COOKIE` in `gate/context.ts`; scrypt `hashPassword` / `verifyPassword` in
    `security.ts` (`gate/passwords.ts` now only re-exports them, core to core, until K-a7);
    `eventsHousekeeping` in `gate/ops.ts` (KA-Q1); `gate/visitor-settings.ts` keeps the read
    side (`SWITCHES`, `isSwitch`, `ALL_OFF`, `BUILT`, `settingsOf`, `readVisitorSettings`,
    the types) and exports `COLUMN` for people's writing; `store.ts` (567 to 205 lines) keeps
    areas, roles and requests, plus `closeResetRequests` for the socket and `housekeeping`
    as requests' part only; `setMember` reads the visitor itself (same refusal).
  - areas: `gate/in-use.ts` (`ownRoleSetsInUse`, `routesOpenToAll`): the two checks
    `setVisitorSwitch` makes, answering the names; the words stay in people.
  - gate host: `housekeeping.ts` calls people's, the event log's, then requests' part (then
    deletions and forms, as before); `admin.ts` and `app.ts` import people's store; `app.ts`
    fills the socket (`{ close: closeResetRequests, add: addResetRequest }` with requests on,
    `NO_RESET_REQUESTS` with it off) and hands it to `registerSignIn(ctx, people)` and
    `registerAccounts(ctx, people)`; `useLink` / `useResetLink` take it and call `close(q, …)`
    inside their transaction, where the `UPDATE requests` was.
  - settings needs people (KA-Q4): `module.ts`, `package.json` (and the lock), test/boundaries'
    `DEPENDS_ON`, and test/modules.test.ts's frozen NEEDS (its one change, said in the commit).
  - Callers switched (packages and 14 test files); test/k-a-surface.test.ts's map (still 84
    names) plus a check that core's `gate/passwords` names exactly the kernel's two functions;
    package exports (`tools/coupling/entries.ts`: people +13, areas +1); coupling report
    regenerated with `gate.events` the kernel's (`BASELINE`, KA-Q1) and `gate.visitor_settings`
    people's (`MOVED`, KA-Q3); **allow list shrunk by 6** (core reads `gate.links`; core writes
    `gate.events`, `gate.links`, `gate.sessions`, `gate.visitor_settings`, `gate.visitors`),
    nothing added; size allow list shrunk by `store.ts`. `db/schema.snapshot.sql` untouched.
- Findings and choices (behaviour unchanged unless said):
  - `VISITOR_NAME_RE` and `cleanVisitorName` stay core's objects until K-a5: core's
    `addResetRequest` (requests, still in core) cleans the username with them, and core can't
    import people. People's `accounts-store.ts` re-exports them (the module-to-core shim of
    "The rule that shapes the slices"); the surface test checks they are the same objects.
    K-a5 moves the bodies to people when requests moves and needs people.
  - `housekeeping` (store.ts) keeps its name as requests' part until K-a5; the order is now
    people, events, requests (the plan's row: the foreign keys make it the same result).
  - `NEEDS` went to `shared/visitor-switches.ts`, not `gate/visitor-settings.ts`: `whyNot`
    needs it, and shared code shouldn't import the gate side.
  - With requests off the socket closes and files nothing. Today no site has people on and
    requests off (both are essentials), so nothing changes; before, a chosen password closed
    leftover reset requests even then.
  - The first full build stopped at the projects builds test: registry.npmjs.org's search
    answered 503 for about 20 minutes (checked with curl from the host, nothing of ours;
    `~/install-logs/build-ka-4-registry-503.log`, every earlier step passed). Rerun once the
    search answered 200 again: passed.
- Open (with a suggestion):
  - **KA4-Q1. The socket's place.** The decision says `ctx.people.resetRequests`; core's
    `GateCtx` can't name people's type, so the host hands `PeopleSockets` to people's two
    register functions instead, as it hands forms its `FormHooks`. *Suggested:* keep it so;
    K-b's module host can make it a slot on the module's own context.
- Fast tier passed on both commits (`~/install-logs/build-ka-4-tests-fast.log`,
  `~/install-logs/build-ka-4-fast.log`).
- Build (2026-10-09, from b071f66): full build passed (`~/install-logs/build-ka-4.log`): unit
  tests, nginx 34, gate nginx 181 + 179, hosts 70, route accounts 81, adopt 32 + 25 + 27,
  move-db 83, to-pasta 34, offsite 30, tutorials 67, projects 11, e2e pammy 122, e2e lfdln 62.
  Releases: **pammy 827cc740ea56d0d9**, **lfdln 76cf61a7439d9ca2**.
- Install (pammy.org first, then lfdln, one at a time; verify: the same counts as K-a3, pammy
  657/657 + 70/70 + 62/62, lfdln 711/711):

```
sudo ~/pamela-setup-ka/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-ka-4-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/verify-panel.sh 2>&1 | tee ~/install-logs/verify-ka-4-pammy.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-ka-4-lfdln.log
sudo ~/pamela-setup-ka/panel/deploy/lfdln/verify-lfdln.sh 2>&1 | tee ~/install-logs/verify-ka-4-lfdln.log
```

  Rollback: install K-a3 again (pammy 0fba4ee0, lfdln 08c9b390) from main 6278897; no schema
  change.
- **Installed 2026-10-09:** lfdln 76cf61a7 (install and verify: 711/711), then pammy 827cc740
  (install and verify: panel 657/657, software 70/70, Pamela's account 62/62). Review before
  install (second agent): OK, no HIGH or MEDIUM. LOWs, no action: the cookie name is written in
  context.ts and hosts config.ts (test/s1e-cookie.test.ts ties them); the name helpers wait for
  K-a5; a malformed stored hash skips scrypt (as before the move).
