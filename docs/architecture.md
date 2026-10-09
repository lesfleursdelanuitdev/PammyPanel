# Architecture: modules, how they work together, and the patterns we use

Written 2026-10-06 for momolig: *"make sure that the code and/or our plan is properly
modularized and that we have described how each module will work with each other. Clearly
document what design patterns we are using and where."* Read-only analysis of the code at
`66ee828` (branch `backends-plan`, code = `main` 231e3ba) and of the plans
(module-contracts, backend, external-backends, projects-domains, the security and performance
review). Four reviews ran in parallel; claims marked **(checked)** were read again by hand.

**The lists are now generated (K0):** who owns each table, SQL on other modules' tables,
undeclared runtime dependencies and the modules the kernel, gate host and sites name are in
[coupling-report.md](coupling-report.md), made from the code by `node tools/coupling/report.ts`
and kept current by `test/coupling.test.ts`. Sections 3-5 below are the hand-made analysis of
2026-10-06; where a list here and the report differ, **the report is right**. The prose (why it
matters, what to do) stays here.

## 1. Verdict

- **Imports are clean, everything else leaks.** Every `@panel/*` import stays inside the
  declared dependencies and `test/boundaries.test.ts` holds. But modules reach each other
  through **SQL on each other's tables**, **socket ops nobody declares**, and **module names
  written into core, the gate and other modules**. The boundary test sees none of that.
- **Three places do other modules' work.** `core` holds the areas / people / requests store
  (`core/src/gate/store.ts`, 612 lines) **(checked)**; `packages/gate` is one hand-written switch
  over every module's ops (79 cases) **(checked)**; the two **site composition roots** (~900 lines)
  hold real logic (hosts SQL, the monitoring collector) and are ~70% duplicated.
- **The plans describe the mechanisms** (defineModule, kernel, registries, events, five
  contracts) **but not the interactions**: 13 interactions are implied with no stated mechanism,
  and 13 contracts are missing (section 8). The projects-domains plan, written last, adds a
  project-kinds registry and common tabs that no contract covers yet.
- **Patterns are good and mostly consistent** (composition root, DI through deps objects,
  least-privilege helpers, JSON-line commands, plan/apply with rollback, IR + diff); the
  inconsistencies are in plumbing that was written many times (timers, retries, jobs, sockets,
  atomic writes).

## 2. Processes (today)

All Node services: `ProtectSystem=strict`, `ProtectHome=yes`, `SystemCallFilter=@system-service`,
no capabilities unless noted; helper sockets `0660 root:<group>`, socket-activated.

| Process | User | Who may connect | May touch | Code inside |
|---|---|---|---|---|
| **pammy-panel / lfdln-panel** | svc-pammypanel / svc-lfdlnpanel | nginx (HTTP :3044 / :3046); lfdln also the catalog door :3048 (signed) | its state dir, media-public dir, its site Postgres (:5434 / :5435) | the site's `server.ts` + `app.ts` and every module's panel routes; timers (follow 20 s, housekeeping 1 h, media sync 15 min, notices 1 min, touches 1 min / 15 min; lfdln + deletions 1 min, backup prune 1 h, monitoring 5 min, app keeper 15 min) |
| **pammy-gate / lfdln-gate** | svc-*gate | nginx (HTTP :3045 / :3047); admin socket → panel; php socket → php-fpm | its state dir (areas snapshot), schema `gate`; client of pammydb and (lfdln) the mail visitor socket | `packages/gate` + every module's gate code; timers (areas 60 s, housekeeping 1 h, form-link retries 15 min) |
| **sitefs** (pammy: user `pamela`; lfdln: svc-lfdlnsites) | | panel | the website / site folders only; no network | `packages/files/src/sitefs` |
| **pammy-rootfs@<id>** | per install | panel | that install's files only | sitefs in software mode |
| **thumbs** | svc-*thumbs | panel | site files read-only; no network | `packages/thumbs` |
| **pammydb** | svc-*studio | **panel and gate** (shared group, review S2) | the Studio's engines (pammy 5433 / 3307; lfdln 5436 / 3308) | `packages/studio/src/pammydb` |
| **mail** | svc-*mail | panel; lfdln gate (visitor door) | Resend | `packages/mail/src/mail` |
| **pammy-apps** (+ purge timer) | **root** (CAP_DAC_READ_SEARCH) | panel | WordPress config, mail settings; the rest via `systemd-run` | `packages/apps` |
| **routes** (pammy / lfdln) | **root** | panel | nginx host files; `nginx -t` via `systemd-run` | `packages/hosts/src/helper` |
| **lfdln-services** | **root** | panel | nothing writable; `systemctl --user` via `systemd-run` | `packages/services` |
| **lfdln-projects** (+ pushes path unit) | **root** | panel | its state, `/etc/nginx/lfdln-projects`; builds as svc-lfdln-apps | `packages/projects` |
| **php-fpm** (pammy / lfdln) | svc-*php | gate php socket | site files read-only; no network | — |
| **lfdln-watchdog** (timer) | root (DAC read) | — | panel heartbeat, mail socket | `packages/monitoring/src/watchdog.ts` |
| **Databases** | rootless Quadlets | 127.0.0.1 | own volume | pammy-pg :5434, lfdln-pg :5435, lfdln-appdb :5436, lfdln-appmaria :3308; backups 04:30-05:15 |

## 3. Modules today

*The "Owns" column, current: [coupling-report.md section 1](coupling-report.md#1-tables-and-their-owners-rule-1).*

Owner of a table = the package whose migration creates it, or by meaning for the closed
baseline (`db/migrations/0001-0018`, which created all of `gate.*`, `panel.users / passkeys /
sessions / activity`, `panel.studio_*`, `panel.mail_notices`).

| Module | Does | Owns | Needs (declared) |
|---|---|---|---|
| **core** | config, Postgres, migrations, panel identity, shell, helper kit, React frame, `PammyElement` | `panel.users/passkeys/sessions/activity/user_rights/user_places`; nginx templates | — |
| **gate** (package) | the visitor-facing server and its admin socket | no tables; `/check`, `/_pammy/*`, the admin and php sockets | (imports nearly every module) |
| **mail** | sending through Resend; email notices | `panel.mail_notices`; the mail helper | core |
| **areas** | protected folders and route areas, roles and privileges, Access, the allow / deny decision | `gate.roles … role_all_privileges`, `visitor_settings`, `deleted_accounts`; 11 sign-in widgets | core |
| **people** | visitor accounts, sign-in pages, People | by meaning `gate.visitors/sessions/links/events` (code in core) | areas |
| **requests** | "let me in", "forgot password" | by meaning `gate.requests` (code in core) | areas |
| **settings** | Settings > Visitors, Email | — | core |
| **catalog** | labels on items in scopes, across sources | `catalog.*` **and** `files.*`, `thumbs.*` (one migration) **(checked)**; the app door | core |
| **files** | File Explorer, folders, editor, file records and sync, site folders' records (8b-9) | `panel.site_folders`; sitefs helper; MediaSync; the SPA page list | catalog, thumbs |
| **thumbs** | thumbnails | thumbs helper; `Thumbnailer` | catalog |
| **media** | media folders, public media API | a SQLite index for the gate | areas, api-keys, catalog, files, thumbs |
| **api-keys** | keys for programs (responses, media) | `gate.api_keys` | core |
| **studio** | database workspace, app pages, data API, record tags | `panel.studio_*`, `gate.studio_catalog / app_keys / record_labels / record_touches`; pammydb helper | catalog |
| **forms** | forms, responses, notices source, `<pammy-form>` | `gate.forms / responses / response_values / form_pages` | areas, mail, api-keys |
| **form-links** | answers into tables | `gate.form_links / response_saves`; retry timer | forms, studio |
| **comments** | comment areas, comment tables in apps, `<pammy-comments>` | no tables (columns on forms') | areas, forms, form-links, studio |
| **apps** | WordPress (pammy.org) | apps helper state; rootfs units | mail, studio |
| **php** | PHP pages | php-fpm unit, gate's php door | — |
| **examples**, **help**, **getting-started** | worked examples; guides; questionnaire | `panel.first_steps`; `started_paths / path_steps` | many |
| **hosts** | domains, hosts, routes, site folders' routes; nginx rendering; route kinds | `panel.domains / hosts / routes`; routes helper | core, files (8b-9) |
| **services** | adopted services; backups setting; deletion hooks | `panel.backup_settings`; services helper | hosts |
| **monitoring** | health rounds, down / up mail, watchdog | `panel.monitor_*` | core |
| **projects** | git-built apps, releases, dev branch | projects helper state | hosts |

## 4. How modules work together today

Nine mechanisms, from cleanest to worst:

| Mechanism | What | Where | Verdict |
|---|---|---|---|
| **Declared imports** | a package imports another's exports | every `package.json`; `test/boundaries.test.ts` | clean, but `"./*"` exports make every file public |
| **Deps objects / context** | the site hands each module what it needs (`PanelCtx`, `XDeps`) | `core/src/panel/context.ts`, `*/ops.ts` | clean where used; services, projects, routes and thumbs bypass `PanelCtx` |
| **Registries** | route kinds, key covers, refusals | `hosts/src/render.ts:118`, `api-keys/src/panel/covers.ts`, `core/src/panel/shell.ts` | good; covers and catalog source kinds are **closed** lists |
| **Hooks** | callbacks passed in (`responseKept`, `onChange`) | `forms/src/gate/routes/forms.ts:10`, `files/src/media-sync.ts` | fragile ordering when wired after construction |
| **Helper socket ops** | JSON-line commands | `core/src/jsonline.ts`, every helper's `service.ts` | good; but **undeclared** dependencies hide here (below) |
| **Gate admin ops** | panel → gate socket, one switch | `packages/gate/src/admin.ts` | one place knows every module |
| **Push / pull** | catalog pushed to the gate; notices and touches pulled | `studio/src/panel/studio.ts`, `mail/src/panel/notices.ts`, `studio/src/panel/tagging.ts` | good pattern, each written separately |
| **Files on disk** | `gate-routes.json`, the media SQLite index, record files read by other helpers | `hosts`, `media`, `sites/lfdln/src/helpers/routes.ts` | acceptable, undocumented |
| **Shared tables** | module A's SQL on module B's tables | section 5 | **the main problem** |

**Dependencies that exist only at run time** (through socket ops; `DEPENDS_ON` doesn't show them;
current list: [coupling-report.md section 3](coupling-report.md#3-runtime-dependencies-through-sockets-rule-5)):
getting-started → forms, areas, form-links; settings → forms, apps, mail; requests → people
(`visitor.create`); hosts → areas (`route-area.set`); areas → files (sitefs `protect`);
**mail → forms (`notices.since`) while forms → mail: a cycle.**

## 5. Coupling problems, worst first

*The file and table lists behind these, current: [coupling-report.md](coupling-report.md)
sections 2 (SQL), 3 (ops) and 4 (modules named). Line numbers below are as of 2026-10-06.*

1. **The gate package knows every module.** `gate/src/admin.ts:61-73` (`moduleOf`), `:232-411`
   (one switch, 79 cases), `app.ts:285-320`, `housekeeping.ts`, plus `SCOPED_OPS` and
   `changesMemory()` lists that must agree. A module can't add a gate op without editing gate.
2. **core holds other modules' stores and reads their tables.** `core/src/gate/store.ts` holds
   areas (create, move, rolesOf), people (visitors, links, registration, sessions), requests and
   events, and joins areas' tables (`:253-290`) **(checked)**; `live.ts`, `visitor-settings.ts`
   read areas' tables. core also names modules: every socket in `config.ts:26-43`, `PanelCtx`
   slots for studio / software / mailer, `RIGHTS`, nginx locations for media / files / studio /
   apps / examples / php, `pg.ts:38` schemas, `isOn('apps'|'hosts')` in its routes and pages.
3. **Hosts' tables are queried raw from five places**: services (`routes/services.ts:32`,
   `account-deleted.ts:33`), projects (`routes/projects.ts:54`) **(checked)**, core
   (`routes/accounts.ts:65`), lfdln's site (`app.ts:130,213,283,352`), and pammy's site **writes**
   them while hosts is off (`sites/pammy/src/nginx-hosts.ts:41-76`) **(checked)**. There is no
   hosts query API (routes showing X, folder places, address of a route).
4. **Projects and services render nginx with hosts' internals** (`FIELDS`, `gateLines`,
   `identityOf`, `tokenOf` from `@panel/hosts/render`) **(checked)**; hosts' `Table` type carries
   services and software; `take-over.ts:111-180` hard-codes lfdln's services and ports;
   `folder-gate.ts` holds pammy-only kinds. Two nginx writers (routes helper, projects helper).
5. **Comments owns the Studio's data API switch and app keys**
   (`comments/src/panel/routes/comments.ts:116-185`, `UPDATE studio_databases` :131) **(checked)**:
   turning comments off removes a Studio feature.
6. **Catalog, files and thumbs share ownership.** Catalog's migration creates `files.*` and
   `thumbs.*` **(checked)**; catalog reads them and emits a files URL (`items.ts:318`); files writes
   `catalog.items` and `labels` (`media-db.ts:99-157`, `media-sync.ts:166-187`); studio writes
   catalog's `sync_state` (`tagging.ts:95-114`), duplicating catalog's own keeper.
7. **forms ↔ form-links ↔ comments run in a circle**: forms reads `form_links`
   (`store.ts:169`) and `response_saves` (`responses.ts:139`), serves `/api/comments`
   (`panel/routes/forms.ts:245`) and the examples routes (:166), and its widget knows
   `/_pammy/comments`; form-links reads studio's catalog and databases and forms' responses.
8. **examples writes other modules' tables** (forms' `forms` / `responses`:
   `examples/src/gate/examples.ts:135-207`; studio's `studio_databases` / `studio_drafts`) and
   reaches ~20 studio internals.
9. **areas holds people's things**: `deleted_accounts`, ALTERs of `visitors` / `links`, six
   people widgets in `areas/widgets/login.ts`. **sitefs implements areas' and media's ops**
   (`protect`, `markers`, `install-pages`, 14 `media-*`); areas calls sitefs without declaring
   files.
10. **The site roots hold module logic** (lfdln `app.ts`: monitoring collector with hard-coded
    ports and addresses, `monitor_baseline` SQL, `routeManifest`, `folderPlaces`) and are
    duplicated (record keeper, media / thumbs / publisher wiring, housekeeping SQL, timers).
    lfdln registers hosts, services and backups routes **unconditionally** (`app.ts:165-175`).
11. **Settings writes mail's table** (`mail_notices`) and hosts an apps route; **mail settings
    are written by the apps helper** (`apps/src/apps/mail.ts:13`).
12. **services hard-codes lfdln** (`known.ts`: services, pammy-pg backups, a projects path;
    removed by N3).
13. **media reaches deep into files** (9 web components, media-db, sitefs); `/api/media/*` is
    split between files and media.
14. **Closed registries**: `gate.api_keys` has fixed `forms` / `media` columns; catalog's
    source kinds are a CHECK list `('files','studio','app')`.
15. **Declared ≠ used**: gate → files, thumbs → catalog, getting-started → help, apps → studio,
    examples → apps / areas / api-keys / form-links are declared but never imported.

## 6. Design patterns in use

| # | Pattern | Here | Where | Applied |
|---|---|---|---|---|
| 1 | **Composition Root** | each site wires the whole graph | `sites/*/src/{server,app}.ts`, `helpers/`, `gate/main.ts` | everywhere; duplicated |
| 2 | **Feature toggles** | `PROFILE.modules`, `isOn()`, checked by `checkModules` / `checkFacts` | `core/src/profile.ts`, `gate/src/app.ts:304-351` | everywhere |
| 3 | **Dependency injection (deps objects, injected clock)** | `createXOps(d)`, `panelContext(…, calls)`, `now()` | `*/helper/ops.ts`, `core/src/panel/context.ts` | almost everywhere |
| 4 | **Context object + decorators** | `PanelCtx`; `filesParts`, `studioParams`, `withFolderPlaces` | `core/src/panel/context.ts` | mostly |
| 5 | **Plugin modules (route registration)** | `routes(app, ctx)`, `registerX(ctx)`, `web/routes.tsx` | every package | everywhere but gate admin |
| 6 | **Strategy** | route kinds, key covers, refusals, Studio `Driver` per engine | `hosts/src/render.ts:118`, `api-keys/src/panel/covers.ts`, `studio/src/pammydb/driver.ts` | consistent |
| 7 | **Chain of Responsibility** | error → `AccountError` → site refusals → generic | `core/src/panel/shell.ts` | once |
| 8 | **Command over sockets (JSON-line RPC)** + **Facade** | one request, one reply; `unavailable` vs `timeout`; `service.ts` → `ops.ts` | `core/src/jsonline.ts`, every helper | everywhere |
| 9 | **Central dispatcher** (anti-pattern next to 5) | 79-case switch + three op lists | `gate/src/admin.ts` | once |
| 10 | **Privilege separation / least-privilege helpers** | each concern a Unix user behind a socket with a narrow op list | `deploy/*.service`, helper `service.ts` | everywhere |
| 11 | **Privileged action as transient units** | `systemd-run --wait --pipe`, injectable `Runner` | `core/src/runner.ts` | consistent |
| 12 | **Socket activation + group ACL** | fd 3 / `LISTEN_FDNAMES` | 9 entry points | copy-pasted |
| 13 | **Snapshot + stale-if-error cache** | areas snapshot; sessions 60 s fresh, 15 min stale when PG is down | `core/src/gate/live.ts` | once |
| 14 | **Explicit invalidation + polling backstop** | `changed()` after ops; 60 s reload | `gate/src/admin.ts:175-196`, `live.ts:218` | once |
| 15 | **Push model** | the panel pushes the whole catalog to the gate | `studio/src/panel/studio.ts:160-175` | once (plans want more) |
| 16 | **Pull with a high-water mark** | notices `since`, record touches drained | `mail/src/panel/notices.ts`, `studio/src/panel/tagging.ts` | twice, differently |
| 17 | **Outbox / work queue with leases** | form-link saves (`claim`, `settle`, outcomes); deleted accounts (backoff table) | `form-links/src/gate/saves/queue.ts`, `areas/src/gate/deletions.ts` | twice, differently |
| 18 | **Long jobs with steps, polled** | start, `step(words)`, history, UI polls 2 s | `apps/src/apps/jobs.ts`, `projects/src/jobs.ts` | two implementations |
| 19 | **Plan / apply with rollback** | write, `nginx -t`, put back; take-over probes before and after | `hosts/src/helper/ops.ts`, `hosts/src/take-over.ts`, `sites/pammy/src/switch.ts` | consistent |
| 20 | **IR + pure diff + ordered patch** | schema IR, rename-aware diff, dialect DDL, stale-draft hash | `studio/src/pammydb/{ir,patch,ddl}.ts`, `studio/src/studio/diff.ts` | consistent |
| 21 | **Ordered, checksummed, locked migrations** | per package; only the installer migrates | `core/src/pg-migrate.ts` | everywhere |
| 22 | **Serializable transactions with retry** | `tx()` SERIALIZABLE, retries 40001 / 40P01 | `core/src/pg.ts:93-107` | everywhere (review P7: too strict for hot inserts) |
| 23 | **Signed requests (HMAC)** | v1 / v2, ±5 min, timing-safe | `core/src/signed.ts`, catalog door, account-deleted | consistent |
| 24 | **Fixed-window rate limiter** | `RateLimiter.take`; mail's own caps; nginx `limit_req` | `core/src/security.ts:64-86`, `mail/src/mail/service.ts` | consistent |
| 25 | **Glossary + templates** | `profile.words`; nginx `@@TOKENS@@` / `#@if`, snapshot-tested | `core/src/profile.ts`, `core/src/nginx.ts` | consistent |
| 26 | **Light-DOM Web Components + progressive enhancement** | Lit `PammyElement`, `:where()` styles | `core/widgets/base.ts`, `*/widgets` | consistent |
| 27 | **Observer-lite callbacks** | nullable `onChange` / `onMade` chained by hand; WeakMap side channels | `files/src/media-sync.ts`, `thumbs/src/media-thumbs.ts`, `sites/lfdln/src/app.ts:94-150` | ad hoc |
| 28 | **Debounce / single-flight / serialised chains** | `kick()`, `#running ??=`, `#chain`, `busy` flags | `media/src/media-public.ts`, `thumbs/src/media-thumbs.ts`, `catalog/src/apps.ts` | ad hoc |
| 29 | **Route-declared authorization** | `config: { needs, wholeSite }`, missing = refused, 404 | `core/src/panel/rights.ts`, `context.ts`, `test/routes.snapshot.txt` | everywhere |
| 30 | **Backend-for-frontend** | the panel's `/api` serves only its SPA, in her words | `core/web/lib/api.ts`, `core/src/security.ts` | everywhere |

Planned (in the plans, not built): **Registry / extension points** with owners, **Transactional
outbox + dispatcher + webhooks**, **Adapter** (data store adapter, component adapter),
**Identity provider** abstraction, **Kernel / microkernel**, **Anti-corruption layer** for
external providers (`lfdln-remote`).

### Inconsistencies (same problem, solved several ways)

1. Two composition roots, ~70% the same, already drifting (`keeper` vs `records`, `isOn(PROFILE)`
   vs `config.site`, lfdln purges trash without checking `files`).
2. **19 hand-written timers** **(checked)** with different overlap guards (none, `busy`, `#chain`,
   `live.ready`); not cleared on shutdown.
3. Helpers reached two ways: `PanelCtx` slots with one error mapping, or `config.xSocket!` with
   the mapping rewritten.
4. Gate admin dispatch (one switch) vs per-module registration everywhere else.
5. Two job systems (apps, projects).
6. Six or more retry / backoff implementations.
7. Socket bootstrap copied into 9 entry points; the gate and mail parse `LISTEN_FDNAMES` differently.
8. Units in three places (`deploy/`, `deploy/lfdln/`, `packages/*/deploy/`).
9. Three ways to make nginx (templates, code-built strings in hosts, pammy's `nginx-hosts.ts`).
10. Atomic write-then-rename re-implemented in ~16 files, no fsync.
11. ~20 error classes with ad hoc codes, translated by `HELPER_STATUS` + per-site refusals.
12. Callbacks wired after construction (`x.log =`, `onChange ??=`).

### Missing patterns that would help

1. **Single-flight** on the gate session cache (review P2).
2. **One scheduler**: `every(name, ms, fn)` with overlap guard, jitter, logging, stop on shutdown.
3. **One panel composition** in the kernel (`startPanel(profile, extras)`), so sites only add
   what is theirs.
4. **An op registry** for gate admin and helpers: each module contributes
   `{op, module, scoped, changesMemory, handler}`.
5. **A helper-client registry** in the context: `ctx.call('services', req)`, one error mapping.
6. **`runHelper()`** for socket activation and signals.
7. **Shared building blocks**: `atomicWriteFile()` with fsync, one job queue, one backoff policy.
8. **Declarative validation**: request and op schemas (Fastify `schema:` or a schema library),
   which could also generate the web types now kept in step by tests.

## 7. The planned system

### Target modules

| Module | Responsibility | Owns (planned) | Fills / publishes |
|---|---|---|---|
| **kernel** (`@panel/kernel`) | hosts modules; panel identity and rights; events; data; helper kit | panel users, passkeys, sessions, rights, Activity, `events.outbox`, migrations, three hosts, React frame, `PammyElement`; points: identity providers, event types, component adapters, refusals, housekeeping, Help topics, rights | — |
| **gate host** | the kernel's public HTTP shell | nothing of its own after K | — |
| **people** | lfdln/pammy visitor identity | visitors, sessions, links, sign-in pages | identity provider, default component adapter; `people.account.deleted` |
| **areas** (Access) | role sets, memberships, the allow decision, `X-Lfdln-*` | areas, roles, memberships | consumes hosts' routes |
| **requests**, **settings**, **mail**, **api-keys**, **help**, **examples**, **getting-started** | as today | | |
| **monitoring** | checks, down / up mail | monitor tables | `services.service.down/up` (misnamed, should be `monitoring.*`) |
| **files**, **catalog**, **thumbs**, **media** | as today | catalog owns catalog sources | `files.changed` → `thumbs.made` → `media.published` |
| **studio** | engines, data API, catalog push | **data store kinds** point | `studio.row.*` |
| **forms**, **form-links**, **comments** | as today | | `forms.response.*`, `form-links.row.*`, `comments.comment.*` |
| **hosts → Domains** | domains, names, routes, rendering, checks | **route kinds** point | `hosts.route.changed` |
| **projects registry** (new) | one Projects page, common tabs | **project kinds** point | — |
| **code** (today `projects`), **installed** (`apps`), **connected** (`services`), **files** (Files kind) | the four project kinds | | project kind, route kind, data consumer; `projects.release.*` |
| **backends** (new) | Supabase-like service | `backend` schema, lfdln-backend | data store kind, identity provider, component adapter; `backends.row.*`, `backends.user.*` |
| **connections** (new) | external providers | **data consumers** point, lfdln-remote | data store kinds, identity providers, component adapters; `connections.connection.failed` |
| **client** (package) | `@lfdln/client` | | |

### Interactions the plans don't describe yet

1. **Projects registry ↔ Domains**: does the Addresses tab call a hosts route API or write
   `routes` itself? No route API is planned.
2. **A project deleted → its routes**: no `projects.project.deleted` event, no rule for
   `target_ref` integrity.
3. **Backends → Domains**: with B-Q2 (b), backends must make hosts in code; no host-making API.
4. **Monitoring ← every project kind**: "health checks per kind" with no health contract.
5. **Backups**: five owners (common tab, connected file, `known.ts` BACKUPS, Settings > Backups,
   WordPress's script), no contract; Code projects' databases and Laravel storage covered nowhere.
6. **Identity roles**: the contract carries `roles`, but lfdln visitors' roles are per area.
7. **Mail sender per domain and budgets**: only in projects-domains; backends still says one sender.
8. **The S1 proof key**: who hands it to each Code / Connected project.
9. **form-links → a backend's write path (F-Q1)**: would make a cycle without a "table writer"
   registry.
10. **The gate checking backend tokens (F-Q2)**: would read the `backend` schema.
11. **Forms attached to a backend (F-Q5)**: no owner for the attachment table.
12. **`/_pammy/data.js` per host**: how connections tell the gate.
13. **Webhooks declared twice**: `pammy-panel.json` `events` and the connected file `events`.

### Ownership conflicts and contradictions between plans

- **Route kinds vs project kinds**: contracts says hosts owns route kinds (folder, redirect,
  service, project); projects-domains says routes point at "a project of any kind, or a
  redirect". *Proposed:* hosts keeps a two-kind point (`project`, `redirect`), and `project`
  resolves through the project kinds registry; `database-app` (Studio) needs a home.
- **"Hosts are addresses"** (N-Q2) vs external-backends X5b, which still lists hosts as a thing
  that uses data stores.
- **Data consumers** are owned by `connections` (off on pammy.org) but the Data tab is common;
  fillers are named projects / services / php, should be code / connected / files (+ installed,
  restricted).
- **Access tab** assumes one set of people per project, but access is one area per route (roles
  plan Q4), backend Users, or a provider's users.
- **Events page**: event `place` is `{host, folder}`, with no project; per-project Events tab and
  "a service only gets its own events" need it.
- **Row events** "same transaction" (contracts, backend) vs review D4 (impossible); cursor reader
  vs D5; 30-day retention vs D19.
- **B-Q2**: the plan still says (a), the review says (b); B1's "done when" assumes (a).
- **PD-Q1 (b) "rename in step K"** vs K's "schema unchanged".
- **Exam prep**: N7 moves it to Code; E-Q4 keeps its old hook "until the next release"; nobody
  says N7 includes that change.
- **Step K is bigger than written**: `core/src/gate/store.ts` must split three ways (areas,
  people, requests), not only "visitor passwords and sessions".

## 8. Contracts to add (phase 0)

The five in docs/module-contracts-plan.md (data store adapter, events, data consumer, component
adapter, identity) plus:

1. **Project kind**: `{ kind, list(), get(id), owners(id), tabs, routeTarget(id), health(id),
   backups(id), manifest(id), delete(id) }` + `projects.project.deleted`.
2. **Project tab**: how a module adds a tab to every project (connections → Data, areas → Access,
   kernel → Events, monitoring → Health, backups → Backups), scoped by rights.
3. **Address / route API** (hosts): `routesFor(projectRef)`, `addRoute`, `removeRoute`,
   `makeHost(domain, name)` with each domain's abilities, `addressOf(route)`, `folderPlaces`;
   replaces every raw query in section 5 item 3.
4. **Health check**: `{ id, target, expect, every }` per kind; replaces the site's `*Like` types.
5. **Backup**: `{ source, where, retention, lastGood(), restore? }` per kind and per store.
6. **Access per project**: project → its areas and / or its identity provider's admin; `roles(area)`
   in the identity contract; opaque ids + provider (review S5, D20).
7. **Mail sender**: `send({ kind, to, domain })`, sender per domain, budgets per domain / backend
   / site (S7, D15).
8. **Manifest sections** (`pammy-panel.json`): one reader, sections registered by modules (roles,
   catalog, events, data); each project kind says where its file is.
9. **Event place**: `project: {kind, id}` in `place`, and a "who may receive" rule per type.
10. **Table writer**: who writes to table T (Studio helper, a backend, lfdln-remote); breaks the
    form-links ↔ backends cycle.
11. **Gate pushes**: one "panel pushes, gate serves" contract (catalog, form links, `data.js`,
    backend JWKS), so the gate reads only its own tables.
12. **Secrets delivery**: one interface over env files, connected drop-ins, `data.php` and the
    S1 proof key.
13. **Gate ops and helper ops as registries with versions**: each module contributes its ops
    (fixes section 5 item 1 and C-Q2).

## 9. Module rules (proposed)

*Adopted (A-Q1) and renumbered: docs/master-plan.md section 3 is the list (rules 1-17); 3 and 4
here are its rule 3, 5 here its rule 4, 6-8 its rules 5-7.*

1. **A module's tables are its own.** Others use its exported functions, its ops or its events,
   never SQL on its tables. The boundary test checks table names in SQL against owners
   (migrations) the same way it checks imports.
2. **Each package has a public entry** (`index.ts` / named exports) instead of `"./*"`.
3. **The kernel names no module**: no module sockets, slots, rights or nginx locations in it;
   modules register them.
4. **The gate host names no module**: gate routes, admin ops, housekeeping come from
   `defineModule`.
5. **Sites only compose**: no SQL, no module logic; shared composition in the kernel.
6. **Runtime dependencies are declared**: a socket op to another module's helper or gate ops
   counts as a dependency and is listed in `needs`.
7. **Registries are open**: no CHECK lists or fixed columns per module (api-keys covers,
   catalog source kinds).
8. **Events have the publisher's prefix** (`monitoring.check.down`, not `services.service.down`).

## 10. Order (folding this into the plans)

1. **Documents first** (no code): fold the review's D-findings and section 7's contradictions
   into the plans; add the 13 contracts and the module rules to the contracts plan; widen step K
   (store.ts split three ways; catalog / files / thumbs ownership; comments → studio API switch;
   examples through APIs).
2. **Security fixes** S1, S6, then S2-S5 (independent of all this).
3. **Phase 0**: C1 → K (widened) → C2 (with project kinds, project tabs, the route API, health,
   backups, manifest sections, op registries) → C3 → C4 → C5 → C6.
4. Then the N, X and B tracks as docs/module-contracts-plan.md's successors (N1 any time).

## Questions for momolig: all answered YES (2026-10-06)

momolig: *"Yes to all five."* Follow-up: docs/code-health-plan.md (duplication, large files, the gate).


### A-Q1. The module rules (section 9)

Adopt them as rules every step is checked against, with the boundary test extended to SQL table
ownership? *Suggested: yes.* Example: projects' `SELECT … FROM routes JOIN hosts` becomes
`hosts.routesFor({ project: 'party' })`, and the test fails if anyone writes the SQL again.

### A-Q2. Widen phase 0

Add the 13 contracts (section 8) to docs/module-contracts-plan.md and the coupling fixes
(section 5) to step K / C2, before any N, X or B step? *Suggested: yes.* Without them, N2 and B1
would build on the same shared-table habits.

### A-Q3. Shared building blocks in the kernel

One scheduler, one job queue, one backoff policy, `atomicWriteFile`, `runHelper`, op registries,
a helper-client registry (section 6, missing patterns)? *Suggested: yes, in step C2*, each
replacing its copies with no behaviour change.

### A-Q4. Request validation

Adopt declarative schemas for panel routes, gate routes and helper ops (Fastify's JSON Schema, or
a schema library that also gives TypeScript types), instead of hand-written checks? *Suggested:
yes, new code first; existing routes as they are touched.* It also lets the web types come from
the same schemas.

### A-Q5. Who owns `files.*` and `thumbs.*`

Catalog's migration creates them today. **(a)** Move them to files and thumbs migrations (new
migrations that take over, nothing dropped) and let files write labels only through catalog's
functions; **(b)** leave as is. *Suggested: (a), in step K.*
