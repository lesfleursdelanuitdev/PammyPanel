# Phase 5: panel.lesfleursdelanuit.com stands up

Status: **decided 2026-09-25** by momolig, every suggestion taken: Q1 no mail (invite links only), Q2 its own Postgres container on :5435, Q3 a separate installer, Q4 hello/ deleted. Step 1 built 2026-09-25 from commit 40b2d48 (build: unit, nginx 30, gate 175, hosts 60, tutorials 67, browser 115 + lfdln 16): release eb24cf0edf4f41af (pammy.org, meant to change nothing) and release-lfdln 9edd7623d1dad4ea; live on pammy.org 2026-09-25 (installed by momolig, /opt matches). Steps 2 and 3 built 2026-09-25 from commit addec30: release-lfdln f3cf1cb7685d05b4 (release/ 3143418c, pammy.org, shared code only; its nginx files unchanged). Next: step 4, the installs on the server (momolig). Part of
docs/platform-plan.md (phase 5: "its users, Postgres, gate, helpers, installer and verify with the
lfdln profile; public, passkeys only (N2); the core modules and PHP on (F5); no services yet").
Phase 4 (docs/hosts-plan.md) built the hosts module and left its step 4, taking over the stopgap
(H10), to this phase's installer.

## What is there now

- One site, `sites/pammy/`: its profile, its app (sites/pammy/src/app.ts puts every package's
  routes together), its server and command line, its pages (sites/pammy/web) and widgets.
- One release (`release/`, from build.sh) and one installer (deploy/install-panel.sh, 657
  lines) and verify (deploy/verify-panel.sh, 1664 lines), both written for pammy.org: its users
  (`svc-pammy*`), paths (`/opt/pammy-panel`, `/etc/pammy-panel`), ports (3044, 3045, 5434) and
  Pamela's website.
- lfdln exists only as a test profile (test/fixtures/lfdln-profile.ts), with placeholders for its
  people, folders and mail.
- On the server: the stopgap catch-all (`sites-enabled/lesfleursdelanuit-wildcard`) serves
  `/var/www/lesfleursdelanuit-sub/<name>`; only `hello/` is in it. Free: 127.0.0.1:3046, :5435.

## What stands up in phase 5

The panel and nothing a later phase brings: **Home, Hosts (with site folders and routes),
Accounts, Activity**, and PHP in site folders. No gate (forms, comments, protected areas, media
and data APIs are phase 8), no services (phase 6), no databases (phase 6b/8), no mail (Q1).

- **L1. A second site, `sites/lfdln/`**, beside `sites/pammy/`: its real profile (moved out of the
  test fixture, placeholders filled), an app that adds only the core's routes and the hosts
  module's, a server and command line (`lfdln-panel users ...`), and pages built with lfdln's
  profile (menu: Home, Hosts, Accounts, Activity). pammy.org's code does not change; its verify
  must still say 549/549.
- **L2. The profile's module-only facts become optional.** Today every profile must name
  Pamela-shaped things (owner, website, gate, WordPress placement, thumbnails...). Each becomes
  the business of the module that uses it, so lfdln's profile says only what it has. A test
  checks that a module switched on has its facts.
- **L3. Its own everything, nothing shared with pammy.org** (so neither can reach the other):

  | | pammy.org (today) | lfdln (proposed) |
  |---|---|---|
  | panel user, port | `svc-pammypanel`, 3044 | `svc-lfdlnpanel`, 3046 |
  | code, settings | `/opt/pammy-panel`, `/etc/pammy-panel` | `/opt/lfdln-panel`, `/etc/lfdln-panel` |
  | its Postgres | `svc-pammypanel-db`, :5434 | `svc-lfdlnpanel-db`, :5435 (Q2) |
  | folder helper | `pammy-sitefs`, runs as pamela | `lfdln-sitefs`, runs as `svc-lfdlnsites` (D3) |
  | PHP | `pammy-php`, `svc-pammyphp` | `lfdln-php`, `svc-lfdlnphp` (reads the site folders only) |
  | routing helper | (none) | `lfdln-routes` (root, writes only `/etc/nginx/lfdln-hosts`) |
  | nginx | `pammy-panel`, `pamela` | `lfdln-panel`, `lfdln-hosts/` |
  | site folders | `/pamela/public` | `/var/www/lesfleursdelanuit-sub`, 2750, group `lfdln-sites` (F3) |
  | trash | `/pamela/trash` | `/var/www/lesfleursdelanuit-sub/.trash`, 700, never served (a dot-name; one mount for rename) |

- **L4. The panel is public, passkeys only (N2)**: `panel.lesfleursdelanuit.com` on the Let's
  Encrypt wildcard, nothing in front (the real IP is the connecting one), every guard pammy's
  panel has (fresh passkey for dangerous actions, sign-in limits, same-origin, Activity).
- **L5. First account from the command line, the rest from the panel**: `sudo lfdln-panel add-user
  momolig "momolig" --manager` then `invite momolig` gives a one-time link (as pammy-panel does); momolig then invites badmon, monadelanuit, ericka
  and Pamela from Accounts, and chooses each one's rights there (U2, permissions Q5).
- **L6. The takeover (H10), in the installer, after the panel is healthy**: every folder already
  in the stopgap root is adopted as a site folder routed at its own name, `hello/` is deleted
  first (H10), the routing helper renders the catch-all (unknown names: 404) and the host blocks,
  `lesfleursdelanuit-wildcard` is disabled, one `nginx -t` for all of it, and it is all put back
  if nginx refuses. tutor, instastylr, the apex and www keep their own nginx files (phase 6
  adopts them).
- **L7. Backups like pammy's**: a dump before every install, a nightly dump, 60 days kept.
- **L8. Its verify, `verify-lfdln.sh`**: users and sandboxes (each service sees only what it
  needs; no one reaches pammy.org's files, database or sockets, and pammy's services can't reach
  lfdln's), the panel only by passkey, a made-up name answers 404, a test host with a site folder
  made and removed through the helpers, a `.php` page runs there and its code is never sent,
  refused names refused, the stopgap gone. And pammy.org's verify runs after it, untouched.
- **L9. Browser tests for lfdln's pages** (put off in phase 4): Hosts, site folders, routes,
  Accounts with hosts as places, desktop and phone, light and dark.

## Steps

1. **The site, no server change**: L2, then `sites/lfdln/` (L1), build.sh builds both
   (`release/` stays pammy's, lfdln's goes to `release-lfdln/`), L9's browser tests.
   pammy.org is re-installed from this build and must verify 549/549 (nothing of it changed).
2. **The installer and verify, with the panel up but no hosts live**: its Postgres (like
   deploy/pg/install-pg.sh), users, units, nginx for the panel only, L5's first account, L7,
   L8 without the takeover. The stopgap keeps serving `hello/` meanwhile.
3. **The takeover (L6)** and the rest of L8. After this, a new subdomain exists only when someone
   makes it in the panel (F1).
4. **People**: momolig invites the others; nothing to build.

## Questions for momolig

- **Q1. Mail in phase 5?** Invites work without it (the panel shows a link to pass on). Mail
  needs lfdln's own mail service and Resend key (from `noreply@mail.lesfleursdelanuit.com`, as
  pammy's). **Suggested: no, links only; mail comes with phase 7 or 8.**
- **Q2. The panel's database**: its own Postgres container (:5435), or a second database in
  pammy.org's container (:5434)? **Suggested: its own**, so the two panels share nothing and one
  can be restored without touching the other; the cost is one more small container to run and back up.
- **Q3. The installer**: a separate `deploy/lfdln/install-lfdln.sh` that uses shared pieces taken
  out of pammy's installer, or one installer with `--site`? **Suggested: separate**, so pammy's
  installer changes as little as possible (only functions moved out, checked by its verify).
- **Q4. `hello/`**: H10 said delete it. Still yes, or keep it as the first adopted folder, to
  show the takeover kept what worked? **Suggested: delete** (as decided), the adoption is still
  tested in verify with a folder made for the test.

## Step 1, as built (2026-09-25)

- **L2**: `SiteProfile`'s module-only facts are optional (owner, mail, apps, the gate, the
  helpers' sockets but the folder helper's, the media, tutorial, PHP, mail and WordPress
  paths). `FACTS` in @panel/core/profile says which module needs which; `checkFacts` (called
  by `loadConfig`) refuses a profile with a module on and a fact missing. A helper of a module
  that is off is `''` in the config: nothing on such a site asks it. pammy.org's profile is
  `satisfies SiteProfile`, so its own code reads every fact as there, unchanged.
- **The shell** (`@panel/core/panel/shell`): the Fastify app, security headers, same-origin
  check, error and not-found answers, the built page and its files. A site passes its
  modules' own refusals (pammy.org: labels, scopes, the studio's). `notHere(what)` is a
  helper a site doesn't have. pammy.org's `buildApp` starts from it.
- **The account commands** (`@panel/core/cli-accounts`): users, add-user, invite, disable,
  enable, signout, role, access, activity, the same words with the site's command name and
  its word for an admin. pammy-panel keeps its media commands.
- **sites/lfdln**: profile (hosts + php; :3046, PG :5435 database `lfdln`, `/run/lfdln-sitefs.sock`,
  `/run/lfdln-routes.sock`, `/run/lfdln-php`, site folders `/var/www/lesfleursdelanuit-sub`,
  trash `/var/www/lesfleursdelanuit-sub/.trash`), app (shell + pages, sign-in, Activity, hosts,
  Accounts), server (sessions and the site folders' trash purge, hourly), `lfdln-panel` command
  line, `helpers/sitefs.ts` (no WordPress placement; the unit's `UMask=0027` makes folders
  2750 and files 640), `helpers/routes.ts` (the routing helper; lfdln-routes.service now names
  it), `nginx.ts` (only the panel's site file). Its pages (`web/`): night blue instead of plum,
  menu Home / Hosts / Passkeys & devices / Accounts / Activity, a Home of hosts, routes, site
  folders and recent activity.
- The test fixture `test/fixtures/lfdln-profile.ts` is lfdln's real profile with every module
  on (for the words and nginx tests). test/hosts-panel.test.ts runs on lfdln's own app. A site's
  package.json lists what it imports (boundaries test).
- **L9**: `test/e2e-lfdln/` (port 3299; control on 3298): its own server with the real folder
  and routing helpers, nginx and the DreamHost zone stood in for. 16 tests: the first admin's
  setup link, Home and the menu, a page of a module that is off, the words, Add a static folder
  (and its refusals), nginx saying no (nothing changed), the zone down, a redirect route,
  switching a host off and on, deleting it (the folder stays), an account kept to one host,
  Accounts, and five pages at phone width and in the dark.
- `build.sh` typechecks and builds both sites' pages (`public/`, `public-lfdln/`), runs both
  browser suites, and makes `release/` (pammy.org, unchanged) and `release-lfdln/` (packages,
  sites, db, tools, its pages as public/, no src/). `tools/render-nginx.ts --site lfdln`.
- For step 2: the rendered panel.conf for a direct site has no `include
  /etc/letsencrypt/options-ssl-nginx.conf` (nginx's defaults: TLS 1.2 and 1.3); add it for
  lfdln. Its header comment still speaks of "the pamela vhost".

## Step 2, as built (2026-09-25)

- **Its Postgres** (`deploy/lfdln/pg/`): `lfdln-pg`, rootless under `svc-lfdlnpanel-db`,
  127.0.0.1:5435, database `lfdln`, podman secrets copied to `/etc/lfdln-panel/db/{owner,panel}.pass`
  (root 600), nightly dump 04:45 UTC (14 days; the installer's `before-*` ones 60 days). The
  roles keep the panel's own names (`pammy_owner`, `pammy_panel`, `pammy_gate`): the code and
  db/schema.snapshot.sql name them, and this is a cluster of its own. `pammy_gate` is NOLOGIN
  with no password and pg_hba lets only owner and panel in: no gate before phase 8. Tried in a
  throwaway container: setup.sql, every migration, the schema is the snapshot, the dump restores.
- **Users**: `svc-lfdlnpanel` (the panel, home 700), `svc-lfdlnsites` (the folder helper; its
  group is `lfdln-sites`), `svc-lfdlnphp` (PHP; `lfdln-sites` only while running). www-data joins
  `lfdln-sites` so nginx can read the 2750 folders. Nobody else is in it yet (F3 later).
- **The trash moved inside the site folders**, as `/var/www/lesfleursdelanuit-sub/.trash` (700):
  systemd makes each writable path its own mount and rename() can't cross mounts, and a
  dot-name is never listed by the helper nor shown by any route. So the helper's sandbox has
  `/var/www` as an empty read-only tmpfs with only the site folders bound in, writable.
- **Units** (`deploy/lfdln/`): `lfdln-panel.service` (3046, no network but localhost, can't
  see /pamela, /var/www, pammy.org's panel), `lfdln-sitefs.{socket,service}` (socket
  root:svc-lfdlnpanel 660, UMask 0027), `lfdln-php.service` (+ `php/php-fpm.conf`, pammy.org's
  php.ini; socket `/run/lfdln-php/fpm.sock` group lfdln-sites 660, no gate socket), `panel.env`,
  `lfdln-panel-cli` (-> `/usr/local/sbin/lfdln-panel`).
- **install-lfdln.sh**: preflight (release-lfdln/ is what BUILD says, certificate, certbot's TLS
  settings, port free, nginx -t), users, its Postgres (pg/install-pg.sh), a dump, code to
  `/opt/lfdln-panel` (the previous kept), migrations, settings, the trash, units, health (the
  panel, PHP, and the folder helper asked as the panel asks it; the previous version put back
  if not), accounts unchanged, nginx's `lfdln-panel` site file (put back if nginx refuses), the
  first-account hint, then verify. Not yet: the routing helper's units and the takeover (step 3).
- **verify-lfdln.sh**: identity, its database (and that neither panel's passwords open the
  other's), the code, the service and its sandbox, that it can't open any of pammy.org's
  sockets, the folder helper (who may ask, its sandbox, a refused path), PHP's sandbox, the
  site over https (certificate, headers, redirects, other origins refused, passkeys for its own
  name), and the neighbours unchanged.
- **The panel's nginx file** for a direct site has certbot's `options-ssl-nginx.conf` and
  `ssl-dhparams.pem` (profile `tls.panel.include` / `dhparam`); its header names its installer
  (profile `nginx.installer`). pammy.org's rendered files are byte for byte as before.
- test/profile.test.ts checks lfdln's panel.env, units, Postgres files and installer against
  its profile.

## Step 3, as built (2026-09-25)

- **Adoption** (`packages/hosts/src/adopt.ts`, `lfdln-panel adopt-folders`): each folder in the
  site folders' root that isn't a site folder yet becomes one, `adopted` (can't be deleted from
  the panel, D2), PHP off (the stopgap served it static), with the host of its name and a route
  at / showing it. A name a host can't have (www, panel, a name the zone has) is adopted and
  shown nowhere; a name a site folder can't have is left alone. All in one transaction with the
  routing helper applying the whole table: nginx says no, nothing is written. Its Activity line:
  "took in the site folder ...". Tests: test/hosts-panel.test.ts (refused, adopted, twice).
- **The takeover** (install-lfdln.sh section 8): the first time only with `--take-over` (so the
  panel can be checked first); after that every install keeps the routing helper's units and
  files up to date. In order: the routing helper's units (from the release's
  packages/hosts/deploy) and `/etc/nginx/lfdln-hosts`; nginx reloaded and its workers checked to
  be in lfdln-sites (else stop, nothing changed); `hello/` to `.trash/hello--<time>` (gone in 30
  days); the root `svc-lfdlnsites:lfdln-sites 2750`, what is in it keeping its owner and made
  readable to the group; `lfdln-panel adopt-folders` (writes the hosts' files, not yet included);
  then one switch -- `sites-enabled/lfdln-hosts` -> `site.conf` in, the stopgap's link out, one
  `nginx -t`, both put back if it says no. The stopgap's file stays in sites-available.
- **verify-lfdln.sh**, once the hosts are live: the stopgap off, nginx on the helper's files
  (root's), the root's owner and mode, every folder readable to the group, hello/ gone, the
  routing helper's socket (only the panel may ask) and sandbox, `panel` and `webmail` refused,
  a made-up name and hello.lesfleursdelanuit.com answering the plain 404, and a real test host:
  a site folder by the folder helper (2750, its page 640), the table with it by the routing helper
  (nginx -t, reload), its page and a PHP page served (the code not sent), then the table as it
  was (404 again) and the folder in the trash. The panel's own tables are never written to.
