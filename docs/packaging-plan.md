# Packaging: phase 1 of the platform plan

Status: **started 2026-09-23.** Step 1 LIVE (release 8c4fff88, installed 2026-09-24 00:00 UTC). Step 2: release fd62978a failed verify on install (20 failed: six src/ paths verify loads inside `node -e` had no entry point) and rolled itself back; fixed in commit 2ebfe42 (the six entry points + a boundary test that every src/ path a script or unit runs exists), rebuilt as release 38b197cde90ed3b6, LIVE 2026-09-24 02:46 UTC (verify 541/541, access 62/62). Step 3 LIVE as 720715f04b4a8f43 (2026-09-24 04:34 UTC, verify 541/541, access 62/62). Step 4 LIVE as bb4af5721e018829 (commit 30711fd), installed 2026-09-24 04:59 UTC (verify 541/541, access 62/62; login.js now ?v=413e9b57c951). Step 5 LIVE as fb465054a0890dfd (commit d36906e), installed 2026-09-24 05:37 UTC (verify 541/541, access 62/62). All five steps done. Part of docs/platform-plan.md (P1): cut
pammy.org's panel into a core and modules, and redeploy pammy.org from them **with no change in
behaviour**. lfdln is built on the same packages afterwards.

## The net

Every step is its own release, and every release must give, compared with the live one:
- the same route list (`test/routes.snapshot.txt`, 430 lines, unchanged),
- the same database schema (`db/schema.snapshot.sql`, unchanged, and verify's live diff),
- every test suite green (unit, panel nginx, gate nginx, tutorials, browser),
- verify 538/538 and access 60/60 after install.

A step that needs any of these to change isn't a packaging step, and is split out.

## What the code looks like (import graph, 2026-09-23)

164 files, 698 imports between them. With the files grouped into the packages below, the
loops that have to be cut before anything can move are:

| Loop | Where | Cut by |
|---|---|---|
| core → sitefs, pammydb, mail, apps, media clients | `panel/context.ts` builds every helper's client | the site passes the helpers' calls in (`panelContext(app, config, db, calls)`); files and studio add their own parts beside the core's (`files-ctx.ts`: media, thumbs, publisher, syncSoon; `studio-ctx.ts`: the address readers). Route files type their context as `FilesCtx`, `StudioCtx`, or both (1a, done) |
| core → forms, areas | `gate/store.ts` imports `forms/responses.ts` (housekeeping) and `passwords.ts` | visitors, their sessions and passwords are the gate's core (forms and comments use them too); only the protected-area rules (`policy.ts`) and the visitor routes are **areas**. The hourly clean-up is put together by the site (`gate/housekeeping.ts`: the core's, then forms') (1b, done) |
| core → forms | `gate/forms/api-keys.ts` (keys are scoped to forms) | API keys become their own package, **programs**, on the core only: the caller passes in the form and media-folder checks (1b, done) |
| forms ↔ form-links | `gate/routes/forms.ts` calls `saves/save.ts` after a response | a **hook**: `registerForms(ctx, pages, { responseKept })`; the site passes form-links' save (1c, done) |
| mail → forms | `gate/notices.ts` reads form items | `gate/notices.ts` belongs to forms (it is about responses); the panel's side of notices stays in mail (1c, done) |
| examples ↔ comments, studio, apps, forms | `panel/examples.ts` is both what the studio's pages must refuse (an example database can't be renamed, deleted, ...) and the code that sets examples up | `exampleGuard(db)` (examples) gives the names and the refusal; the site hands it to the studio's part of the context (`ctx.exampleNames`, `ctx.refuseExample`). Five routes called `examples(ctx)` and used nothing from it (left over from the refactor's phase 3): removed. The media examples belong to files (1d, done) |

The composition roots (`src/server.ts`, `src/app.ts`, `src/cli.ts`, `src/gate/app.ts`,
`src/gate/main.ts`, `src/gate/admin.ts`) import every module on purpose. They become the
**site** package (sites/pammy), which is allowed to.

## The packages (phase 1)

Coarser than G4's list where the code is tangled today. G4's finer split (Tags apart from Files,
Requests and Users apart from Protected Areas, the three Database Manager parts) comes later,
inside each package, once the seams exist.

| Package | Holds today's | Depends on |
|---|---|---|
| `@panel/core` | config, pg, pg-migrate, jsonline, security, sessions, accounts, util, names; panel context, limited, passkeys, gate-http, gate-shapes; routes accounts, sign-in, activity; gate context, live, store, passwords | nothing |
| `@panel/mail` | src/mail, routes/mail, panel/notices | core |
| `@panel/areas` | gate policy, gate routes/visitors, routes/visitors (Protected Areas, Requests, Users) | core |
| `@panel/files` | sitefs, preview, site-files, pages-list, files-ctx, routes files/editor/pages/folders, media-*, scopes, thumbs, routes/media, gate media-api and media-examples (File Explorer, Tags, Media, Subdomains for pammy) | core, areas, programs |
| `@panel/forms` | shared/form-types, gate forms/*, form-use, gate routes forms/responses-api, routes/forms, gate/notices | core, areas, mail, programs |
| `@panel/programs` | gate forms/api-keys (what a key may be given is checked by the caller: forms and media folders are passed in) | core |
| `@panel/studio` | pammydb, studio (less its example files), panel/studio, studio-ctx, routes databases/records/shape/db-users, gate studio/data-api | core |
| `@panel/form-links` | gate/saves, routes/form-links, studio/form-links | core, forms, studio |
| `@panel/comments` | comment-areas, routes/comments, gate routes/comments, studio/comments-tables | core, areas, forms, form-links, studio |
| `@panel/apps` | src/apps, routes apps/software | core, mail, studio |
| `@panel/php` | gate/php-socket | core |
| `@panel/examples` | panel/examples, tutorial-demos, routes tutorial-examples/db-examples, studio db-examples/tutorial-examples, gate examples/db-examples | core and the modules it shows |
| `@panel/help` | help, getting-started, routes help/getting-started | core, examples, studio |
| `sites/pammy` | server, app, cli, gate app/main/admin/housekeeping; the site profile | everything |

## Steps (one release each)

1. **Seams, nothing moves.** Files stay in src/. Adds `test/boundaries.test.ts`: the table above as
   data, and a test that fails on any import that goes against it (with a list of the edges
   still allowed while step 1 isn't finished, which must end empty). Then:
   - 1a services registry in the panel context;
   - 1b gate parts registry; API keys apart;
   - 1c the forms hook; notices into forms;
   - 1d the examples list into the core.
2. **Workspaces and the move** (done 2026-09-24, live as 38b197cd).
   - `packages/<name>/src/` and `sites/pammy/src/`, npm workspaces (`"workspaces": ["packages/*",
     "sites/*"]`); each package's `package.json` exports `"./*": "./src/*.ts"`, so an import
     between packages reads `@panel/core/pg` or `@panel/forms/gate/forms/store`. Inside a package
     the files keep the paths they had under src/ (`src/gate/...`, `src/panel/routes/...`, the
     helper's own folder), and import each other relatively.
   - npm dependencies (fastify, postgres, ...) stay in the root `package.json`, one lockfile; a
     package lists only the `@panel/*` packages it depends on.
   - **src/ keeps 23 stable entry points**: one line each, `export * from '@panel/...'`, at the
     paths the systemd units, the installer, verify and the nginx/tutorial test scripts name
     (`src/server.ts`, `src/gate/main.ts`, `src/sitefs/call.ts`, ...). The units outlive a
     release (a rollback swaps `/opt/pammy-panel` and keeps the units), so they never name a
     path inside a package. The boundary test refuses anything else in src/.
   - Where the panel's own folders are (public, help, tutorials, db, public-gate, apps) is known
     in one place, `packages/core/src/paths.ts` (`APP_ROOT`); nothing else counts `../` from its
     own file any more.
   - `test/boundaries.test.ts` now checks the real thing: imports between packages only by
     name and only as the table allows, no relative import out of a package, each
     `package.json` listing exactly its table row, src/ only entry points.
   - Moved by a script (scratchpad `move.py`: reads the table from the boundary test, moves,
     rewrites every import, writes the package.json files and the entry points). Tests and
     tools stay where they are and import by package name.
   - Checked 2026-09-23: Node 22's type stripping works through workspace links, also after
     the release is copied elsewhere (the links are relative).
3. **Migrations per module** (built 2026-09-24). 0001-0018 stay in `db/migrations` as they are,
   as the baseline, with the same names and checksums, so the live database needs nothing.
   - The baseline is **closed**: `test/migrations.test.ts` fails if `db/migrations` holds anything
     but 0001-0018. A new migration goes in the package that owns it,
     `packages/<name>/migrations/NNNN-x.sql`, and is recorded in `public.schema_migrations` as
     `<name>/NNNN-x.sql`.
   - Order (`packages/core/src/pg-migrate.ts`): the baseline, then the packages in dependency
     order (each after every `@panel/*` package its package.json names; ties by name, never by
     the disk), each package's own files in name order. A package's migration may use what the
     baseline and its dependencies made.
   - "Appended, never slotted in" is checked per folder: `forms/0000-x.sql` is refused once
     `forms/0002-y.sql` has run, while `forms/0001-x.sql` is fine after the baseline's 0018.
     Changed-after-it-ran and database-newer-than-the-code are refused as before, and the
     services' start check (`checkSchema`) compares the whole list, packages included.
   - Every package in `packages/` counts for now. Which modules a site has switched on is the
     site profile's (step 5); a module switched off would still need its migrations kept, so
     step 5 decides that together with the profile.
   - One known gap, accepted: on a fresh database every dependency's migrations run before a
     package's, while a live one may have run them interleaved. A later migration of a
     dependency that breaks an earlier one of a package that depends on it fails on a fresh
     database, and `test/pg.test.ts` (fresh database, whole list) catches that at build time.
   - No new migration in this step; the installer's "last migration" line now names the last
     applied, not the last by name.
4. **The front end per module** (built 2026-09-24 as release bb4af5721e018829). Each package now has three parts: `src/`
   (the server), `web/` (the panel's pages) and `widgets/` (the `<pammy-*>` elements on her pages).
   - `packages/<name>/web/` keeps web/src's layout (`pages/`, `components/`, `lib/`, `hooks/`), and a
     page sits with the package whose API it calls: Accounts, Activity, Passkeys, Login, Invite and
     the building blocks (`ui/`, page, dialogs, shell, folder-picker, api, status, names, hooks) in
     core; People, Protected folders, Requests in areas; Subdomains, File Explorer, editor, Media,
     tags in files; Forms, the builder, Responses, Form examples, API keys (its routes are in forms'
     `routes/forms.ts`) in forms; FormDatabase in form-links; Comments in comments; Databases,
     database users, the designer and the app pages in studio; Software in apps; Email in mail;
     the database and tutorial examples in examples; Help and Getting started in help.
   - `lib/types.ts` is split the same way. The website's folders (`SitesData`) and the gate's
     state (`GateState`, `Area`, `Visitor`) are the core's, as on the server
     (`@panel/core/panel/gate-shapes`), since four modules read them. Two forms pages that read one
     field of a files answer (the API keys' media folders, the builder's picture list) describe
     that field locally rather than depend on files. `formatSize` and `siteLabel` moved from
     files' `lib/media` to the core's `lib/format` (a studio page and a forms page use them).
   - Each package's `web/routes.tsx` offers `routes: PageRoute[]` (path, page, `manager`,
     `limited`) and its `menu` items. `sites/pammy/web` holds index.html, main.tsx, index.css, Home
     (it reads four modules), `App.tsx` (every package's routes, filtered by the marks: the same
     15 pages for a folder-limited account, 24 for a member, and all 47 for a manager, as before),
     `menu.ts` (which items go in which group, in the same order) and `waiting.ts` (the red dots:
     requests, responses, comments). The core's `Shell` draws whatever `Menu` the site gives it; the
     studio's `useAppGroups` adds the switched-on apps.
   - Imports: relative inside a package, `@panel/<name>/web/...` across (a Vite alias and a
     tsconfig path in `sites/pammy/web`); no `@/` alias any more. `test/boundaries.test.ts` checks
     web/ and widgets/ like src/: only the table's edges, only the same part of another package
     (web/ never imports server code), nothing relative out of its own part.
   - Tailwind is told where the pages are (`@source "../../../../packages/*/web/**/*.{ts,tsx}"` in
     index.css): the built CSS is byte for byte the live one (`index-TAO_xQwX.css`).
   - Widgets: `packages/core/widgets/base.ts`, `areas/widgets/login.ts`, `forms/widgets/forms.ts`,
     `comments/widgets/comments.ts`; built by `sites/pammy/widgets/vite.config.ts` (which widget
     is whose). The built scripts differ from the live ones only in the comment lines naming
     their source, so their versioned addresses change once.
   - The release leaves the pages' and widgets' sources behind (build.sh copies with rsync,
     excluding `*/*/web/` and `*/*/widgets/`): what they became is in public/ and public-gate/.
   - Noticed, left for later: the Application tab's server routes (`routes/apps.ts`: what her
     tables mean, `/api/apps`) went to `@panel/apps` in step 2 with the software routes, though
     they are the studio's (they import only core and studio). Moving them is a server change,
     so it is not in this step; their pages are with the studio already.
5. **The site profile.** What config.ts and the units have fixed today (domain, Cloudflare in
   front, folder-linked subdomains, modules on, wording, Unix users and paths, ports, mail
   sender) moves to `sites/pammy/profile.ts`. Phase 2 of the platform plan then adds lfdln's
   adapters on top.

   Worked out 2026-09-24, from what is fixed today: about 200 lines in 60 server files and 29
   page files name pammy.org, /pamela, pamela, svc-pammy*, a socket, a port or the mail sender.
   Nearly every server value is there twice: once in panel.env or a unit's `Environment=`, and
   again as the code's fallback (`env.GATE_DOMAIN ?? 'pammy.org'`).
   - **P5.1 The profile.** `SiteProfile` (the type) is the core's (`packages/core/src/profile.ts`);
     pammy.org's is `sites/pammy/src/profile.ts`, plain data: domain, panel origin, names
     ("pammy.org", "pammy.org panel"), front (`cloudflare`), folder subdomains (on), modules on,
     owner (pamela, /home/pamela), website (/pamela, public, trash), mail sender, and the
     services (hosts, ports, sockets, data folders, the panel's database).
   - **P5.2 Packages hold no pammy.org fallback.** A package's code takes its settings from its
     caller. The panel's `Config` gains `site` (the `SiteFacts`: domain, names, front, folder
     subdomains, modules, owner, mail) and `loadConfig(profile, env)` takes the profile; the
     helpers' `main.ts` files become `runSiteFs` / `runThumbs` / `runMail` / `runApps`, and the site
     starts each (`sites/pammy/src/helpers/<name>.ts`, reading the environment as before and falling
     back to the profile). The `call.ts` scripts the installer and verify run, and
     `adopt-cli.ts`, are the site's too (`sites/pammy/src/calls/`, `helpers/adopt-wordpress.ts`).
     The src/ entry points the units run point at those, so the units don't change. The gate's
     `GateConfig` has the media files and the database helper's socket always; the site's
     `buildGateApp` fills them from the profile when a test doesn't give them. The database
     helper's `main.ts` has nothing of pammy.org's and stays as it is.
   - **P5.3 The environment still wins.** panel.env and the units keep every line they have
     (rollback-safe, and the tests set the environment). A test checks that each value they set
     is the profile's, so the two can't drift apart.
   - **P5.4 Wording.** The server's messages and the pages it writes into her website (starter
     pages, the temporary home page, the sign-in pages' starter files, mail subjects and footers,
     activity lines, the Help frames' CSP) say the profile's names. The pages get the same facts
     at build time (`__PANEL_SITE__`, defined by `sites/pammy/web/vite.config.ts` from the profile
     and checked there against `@panel/core/web/lib/site`'s `Site`), and every "pammy.org" in them
     comes from there, index.html's title too (`%PANEL_NAME%`). The words about Cloudflare's cache
     are said only when `front` is `cloudflare`. For pammy.org the words are exactly as before
     (the CSS is byte for byte the live one again). A site's `vite.config.ts` may read the site's
     profile: the boundary test leaves the build's config files out.
   - **P5.5 Modules on.** `profile.modules` decides which modules the site registers (server
     routes, gate parts, pages, menu items); the core is always on, and a module whose
     dependencies are not all on refuses to start. pammy.org has every module on. **Migrations
     do not depend on it**: every package's migrations run whether its module is on or not, so
     switching a module off never drops or strands its tables, and switching it back on finds
     them as they were. Done for: the panel's route groups (`sites/pammy/src/app.ts`), the gate's
     (visitors, forms and their preview and API, comments, the media API, the data API), the
     background jobs (media sync, thumbnails, trash purge, email notices, the examples' seeding,
     saving responses again), and the pages, menu and waiting counts. Not (yet): `PAGE_PATHS`
     (every page address still gets the page; the page itself sends a switched-off one home), the
     worked examples' files at `/_pammy/examples/`, and the widget scripts.
   - **P5.6 The software helper** takes the domain from the profile (its messages, the addresses
     it checks). Its paths and her Unix user stay written in (see below).
   - **P5.7** The Application tab's routes (`routes/apps.ts`) move from `@panel/apps` to
     `@panel/studio` (step 4's note).
   - **Stays fixed, on purpose:** the database helper's safety lists (her `pamela` database and
     login, the studio role, the forbidden ports 5432 and 5434), and the software helper's
     paths and user (`/srv/pamela-apps/<id>`, `/pamela/apps/<id>`, `/home/pamela/apps`, running
     as `pamela`; `purgePaths` and the record check): these are guards, what a root process or
     the studio role may delete or act as, compiled in so that no setting can widen them.
     lfdln's databases and software are phase 2's to design. The panel's own database (its
     `pammy_*` roles are named in the schema's grants; `pg.ts`'s defaults). The examples' sample
     content (a blog whose author is `pamela`). The literal that recognises starter pages made
     before today (home-page.ts `OLD_STARTER`). The software helper's nginx layer (`nginx.ts`:
     `/etc/nginx/pammy-wordpress`, and `clash()`'s words, which the installer and verify call
     too). Comments.
   - The net as before: same routes, same schema, every suite green, the same verify, and the
     same words on every page for pammy.org. New: `test/profile.test.ts` (panel.env and the units'
     values are the profile's; the socket units listen where it says; the modules and what each
     needs match the packages' dependencies).
