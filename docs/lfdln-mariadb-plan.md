# lfdln: MariaDB, how long database backups are kept, and the guide findings

DECIDED 2026-10-04 by momolig: "lfdln should have access to MariaDB, we can make it so one of the
settings is how long we should keep database backups for. For the rest, use your judgement."
The rest are the 11 findings of docs/phase9-plan.md ("Found while writing them"); the choices
below are Claude's, written down so momolig can see and overrule them. Branch `lfdln-mariadb`
(worktree ~/pamela-setup-phase8).

This reverses P8-8 ("no MariaDB on lfdln for now ... added when someone needs it").

## M. MariaDB on lfdln

- **M1. Its own server**, as Pamela's is: MariaDB 11.4 (an LTS series, auto-update brings patch
  releases only) in a rootless Quadlet container `lfdln-appmaria`, under its own system user
  `svc-lfdlnmaria` (home /var/lib/svc-lfdlnmaria), on **127.0.0.1:3308** (3307 is Pamela's).
  Not inside svc-lfdlnappdb: each engine its own user, folder and backups, as everywhere else.
  1 GB memory cap. Installed by `deploy/lfdln/appmaria/install-appmaria.sh`, run by
  install-lfdln.sh after the apps' Postgres; safe to re-run.
- **M2. No apps on it**: only the Studio's databases and their db_ logins. Its root account is
  only inside the container (MARIADB_ROOT_HOST=localhost); nothing else is made at first start.
- **M3. The Studio's login** `pammy_studio`@'%' from the same `deploy/studio/roles-maria.sql.in`
  as Pamela's (no SUPER, FILE, PROCESS, RELOAD, SHUTDOWN; CREATE USER and GRANT OPTION). Its
  password: a root-only file in /etc/lfdln-appmaria, copied to /etc/lfdln-panel/db/
  studio-mariadb.pass for lfdln-pammydb's LoadCredential.
- **M4. lfdln's Studio helper** gets `mariadb: { port: 3308 }`; 3307 joins its forbidden ports.
  Its MariaDB rules: the engine's own databases (mysql, information_schema,
  performance_schema, sys) system and protected; logins start with db_ (as on Postgres); the
  engine's own accounts (root, mysql, mariadb.sys, healthcheck, mariadb) and pammy_studio
  reserved. The profile's `studioPorts` gets `mariadb: 3308`, so a new login's password box says
  where it answers. Your databases and Database users then show both servers, as on pammy.org
  (finding 3 goes away: the MariaDB choice becomes true).
- **M5. Backups**: nightly at 05:15 UTC, `mariadb-dump --single-transaction --routines
  --triggers --events` of each database (not the engine's own), gzipped, each checked by
  reading it back to the end, as `<db>-<stamp>-nightly.sql.gz` in /var/lib/svc-lfdlnmaria/backups
  (700), plus the accounts and their grants (no passwords). Kept as long as the setting says (B).
- **M6. Monitoring**: "The apps' MariaDB (lfdln-appmaria)" among the panel's own pieces (it
  answers), and its folder among the backups (newest nightly under 26 hours, none empty).
  The nightly-file pattern takes `.sql.gz` as well as `.dump`.
- **M7. verify-lfdln**: the container runs on 127.0.0.1:3308 only; the Studio's login works and
  has no SUPER/FILE/PROCESS; a db_ login made by the Studio works and reaches only its database;
  the helper answers with both engines; the backup timer is on.
- **M8. Reaching it**: from the server's shell `mariadb -h 127.0.0.1 -P 3308 -u db_x -p`; from a
  service's container 10.0.2.2:3308 (slirp4netns, allow_host_loopback), as for Postgres.

## B. How long database backups are kept: a setting

- **B1. Settings > Backups** (admins only: it is about the whole server): "Keep the nightly
  copies of the databases for N days", 7 to 365, 60 at first (what lfdln-appdb keeps today).
  It covers the databases on Your databases: lfdln-appdb (Postgres, the apps' too) and
  lfdln-appmaria. The panel's own database (lfdln-pg) and pammy.org's keep their fixed times.
- **B2. Who deletes**: the panel, every hour after the backups check, asks the services helper
  to prune; the helper runs a short root unit (`prune.ts`, as `storage.ts` does) over the
  folders known.ts marks prunable, with the number of days. It deletes only files whose names
  are a backup's (`<name>-<stamp>-<label>.dump|.sql|.sql.gz`) with a stamp older than that,
  and never the newest nightly batch, whatever its age. The backup scripts stop deleting by
  age themselves (they keep removing their own left-over .part files), but keep a backstop at
  400 days in case the panel never runs.
- **B3. Saved in the panel's database** (a new migration: `backup_settings`, one row), and in
  Activity. Lowering it says how many copies go at the next hourly prune.
- **B4. The Delete-a-database dialog** says the real number: the setting on lfdln, 7 on
  pammy.org (Pamela's own script).
- pammy.org: no change (no Backups page; her backups stay 7 days).

## F. The other findings (Claude's judgement)

| # | Finding | Done |
|---|---|---|
| 1 | .php files never show in File Explorer | They are listed (outside media folders), marked "This file runs on the server", with tags; Download for admins only (a program file can hold a site's keys); never opened in the editor, uploaded, renamed, moved, copied or trashed from the panel (a trashed one couldn't be restored: restoring checks the name). A folder holding them can still be trashed and restored. In a media folder they stay strays; the warning box no longer says everything is "in a media folder". Both sites. |
| 2 | Programmers can't write the site folders | **Not done here**: giving people write access to the live sites is momolig's call (F3 said "through the lfdln-sites group", but nginx and PHP's user share that group). Proposed in "Left for momolig". |
| 3 | Database users shows MariaDB | Goes away with M (true now). The page shows only the site's servers (studioPorts), so pammy.org is unchanged. |
| 4 | Delete says "seven days" | B4. |
| 5 | Visitor writes say "folder" | lfdln's words: "route", "let in there". |
| 6 | Responses/Comments say "Nothing is emailed to you"; "protected folder" setting | On a site with email notices the intros say "You can be emailed about new ones (Settings > Email)"; the form setting says "Only people with accounts (behind a route with accounts) may use it" on lfdln. |
| 7 | File tags links to Media examples | The link only where examples are on. |
| 8 | An app's database could get a database app, keys and tags | Refused by the panel for a database the site marks as an app's: "belongs to a service". |
| 9 | Catalog intro mentions exam prep's topics | Generic words. |
| 10 | API keys: page manager-only, server only `programs` | The server asks for an admin too, as the page says. |
| 11 | Settings > Email needs `software`, which lfdln can't give | On a site without Installed software, Email is admins' only, and says so; the server agrees. |

Each guide that says otherwise is updated in the same release (L3 PART 8, L7, L6 PART 3/6).

## Release

One release (both panels: shared code), after the full build:
1. `sudo install-panel.sh` (pammy.org: findings only; her verify unchanged plus F1).
2. `sudo install-lfdln.sh`: installs lfdln-appmaria (M), then the panel.
3. verify-lfdln with M7.

## Left for momolig

- **Finding 2, programmers writing site files on the server.** Suggested: POSIX ACLs on
  /var/www/lesfleursdelanuit-sub for the named programmers (badmon, monadelanuit), with default
  ACLs so new files stay theirs to change, rather than the shared group (which nginx and PHP's
  user read through). Panel versions still only cover changes made in the panel.
