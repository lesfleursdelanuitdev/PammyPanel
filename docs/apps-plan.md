# Apps: plan

Status: **phases 1-2 LIVE 2026-09-23** (phase 2 as release 3cd969333b8b016f; 83ba3225 was installed first, and its nginx rule 301ed the list). **Phase 3 (mail) LIVE 2026-09-23** (aee2208febd73ff1). **Phase 4a LIVE 2026-09-23** (931cf66e52b208dd; Move tried on the live blog). **Phase 4b (Install)** installed 2026-09-23 as 1744d440fe304e14, but its first step failed live (`useradd: not found`); fixes installed as 189a2978d2eb76e2 (PATH), then 93c536b16f01db06 (settings shipped, installs resumable) installed, and "garden" installed with it. **Phase 4c (Delete) built 2026-09-23 as release 0a4bce3eae4d167e**, install pending. A5, E1, Q1 and N1 decided the same day. Asked for by momolig: a panel tool that installs apps,
WordPress first, and lets her manage the installations: delete, make inactive, make active, and more.

## What momolig decided (2026-09-23)

| # | Decision |
|---|---|
| A1 | **Adopt the existing WordPress** (blog.pammy.org, `svc-pammywp`) as her first managed app. **Do not reinstall it**, and don't change it to adopt it. |
| A2 | The root work is done by **a new, narrow helper service** (`pammy-apps`), the way the database helper works: a fixed list of named operations, with a fresh passkey in the panel for the dangerous ones. |
| A3 | **One system user and one private database per app**, as the WordPress install is today. |
| A4 | **Inactive means offline**: containers stopped, the address given back. Nothing is deleted. |
| A5 | **WordPress only for now** (decided 2026-09-23). The catalog is shaped so a second app is an entry, not a rewrite (G9). |
| A6 | **Email is part of this**: apps can send mail (WordPress password resets and notices). |
| E1 | **Resend**, in **momolig's account** (decided 2026-09-23). Pamela keeps the domain and its DNS: removing the DKIM lines in Cloudflare stops it. Guide 21 tells her it exists, what it can see, and how to take it over. |
| Q1 | New apps' files go in `/pamela/apps/<id>`, which she can edit, like `/pamela/wordpress` today (decided 2026-09-23). |
| P2a | **The placement folder (G6) waits for phase 4** (decided 2026-09-23), where a second install needs it. Phase 2 writes WordPress's existing three nginx files, byte for byte as `place-wordpress.sh` does. |
| P2b | **Restore = the whole backup only** (files and database together). db-only / files-only stay in `restore-wordpress.sh` for momolig. |
| P2c | **A new admin password is shown once AND written into `/home/pamela/wordpress-login.txt`**, as pamela. |
| M1 | **Mail is sent as `noreply@mail.lesfleursdelanuit.com`** (decided 2026-09-23): the domain momolig verified in Resend (its DKIM and `send.` MX are there; the bare lesfleursdelanuit.com has neither). pammy.org's DNS doesn't change. Replies go to hello@pammy.org. |
| M2 | **A Resend key just for pammy** ("Sending access", limited to that domain), so a leak from WordPress is revoked without touching momolig's own mail. |
| M3 | **The panel sends notices too**, one email per event, to **hello@pammy.org**: new form responses, comments waiting for approval, new access requests. |
| P4a | **nginx: the vhost stays as it is** (decided 2026-09-23). The helper writes WordPress's two included files, `main.conf` and `server.conf`, with every install's blocks, and a proxy file for each install that isn't the blog. While the blog is the only one, they are byte-for-byte what `place-wordpress.sh` writes. This replaces G6's folder. |
| P4b | **New installs' files: `/srv/pamela-apps/<id>`**, with the link `/pamela/apps/<id>` where she edits them, as the blog does (`/srv/pamela-wordpress`, `/pamela/wordpress`). A folder under /pamela can't be a container's files: the container's root is a subuid that can't get through /pamela (2750). |
| P4c | **The adopted blog can be deleted like any other** (to the 30-day trash). |
| P4d | **Phase 4 in three releases**: 4a several installs in nginx, and Move; 4b Install; 4c Delete, the trash, Restore, Purge. |
| N1 | **She sees "Installed software"**, not "Apps" (decided 2026-09-23): in the panel an *app* is already the pages made for one of her databases, and a *program* is one she writes (refactor-plan phase 6). Menu group **Software**, pages `/software` and `/software/<id>`, API `/api/software`. Code and this plan keep "app" internally (`src/apps/`, `pammy-apps`), where she never sees it. |

## G1. Where it stands

One WordPress, installed by hand with `sudo ~/pamela-setup/wordpress/install-wordpress.sh subdomain blog`:

- the system user `svc-pammywp` (no shell, lingering), rootless Quadlet;
- containers `pammywp-web` (wordpress:php8.3-apache, 127.0.0.1:3043) and `pammywp-db`
  (mariadb:11.4, private podman network, no host port);
- its files in `/pamela/wordpress`, which she can edit (group access), never under `public/`;
- one nginx **placement** (`/etc/nginx/pammy-wordpress/placement`: `subdomain blog`), which
  `place-wordpress.sh` moves, rewriting the links in posts; `names.ts reservedNames()` reads it;
- `backup-wordpress.sh` / `restore-wordpress.sh`; `verify-wordpress.sh`.

Everything the tool does exists as a script already, run by momolig with sudo. The tool is those
scripts made into operations the panel can ask for, safely, plus what they don't do yet.

## G2. The helper: `pammy-apps`

- Runs as root (it has to make users, write nginx and systemd files, reload nginx). A socket
  `root:svc-pammypanel 0660`, one JSON line each way, like `pammy-sitefs`.
- **An allow-list of operations, nothing else**: `list`, `status`, `install`, `start`, `stop`,
  `delete`, `restore-deleted`, `purge`, `move`, `backup`, `backups`, `restore`, `download`, `update-check`,
  `update`, `reset-admin`, `logs`, `mail-set`, `mail-test`. Every argument is checked again in the
  helper (names by regex, app ids from its own list, never a path or a command from the panel).
- It never runs anything as `pamela`, and never writes under `/pamela/public`.
- It keeps its own record of the apps (`/var/lib/pammy-apps/apps.json`, root 600). The panel
  shows what the helper says; the helper is the truth about what is installed.
- Sandboxed as far as a root service can be (`ProtectSystem`, her home read-only apart from the
  app folders, no network beyond loopback and the image registry). The operations that make users,
  start containers and reload nginx are short, fixed sequences taken from the existing scripts,
  each one logged.
- The panel asks with a **fresh passkey** (`manager-recent`) for install, delete, move, restore,
  reset-admin and mail-set; `manager` for the rest. Account managers only.

## G3. Adopting blog.pammy.org (A1)

`pammy-apps adopt` (run once by the installer, not a panel button) **only writes the record**:
kind `wordpress`, id `blog`, user `svc-pammywp`, units `pammywp-web`/`pammywp-db`, port 3043,
files `/pamela/wordpress`, placement `subdomain blog`, installed-at from the user's creation.
It changes no file, unit, container, database or nginx line. The verify step then checks the
site answers exactly as before (verify-wordpress.sh), and the record matches what is running.

New installs follow the same shape with their own names: `svc-app-<id>`, `app-<id>-web`,
`app-<id>-db`, a free loopback port from a range (3100-3199), files in `/pamela/apps/<id>`.

## G4. What she can do

**Install** (`/apps/new`)
1. Pick an app (WordPress; the catalog, G9).
2. Where it lives: a subdomain, a path, the whole site, or "not yet" (offline). The panel and
   the helper both check the name isn't a folder, another app, or a reserved name.
3. Its title, her admin name and email. The password is made for her and shown once
   (and kept in `/home/pamela/apps/<id>-login.txt`, 600, like `wordpress-login.txt`).
4. A memory check first (G7), then a progress list: user, database, WordPress, address, first
   backup, check. "Open it" and "Sign in to its admin" at the end.

**Each app** (a card on `/apps`, its own page `/apps/<id>`)
- **Active / inactive (A4).** Inactive: containers stopped, the placement removed, nginx reloaded;
  the address goes back to whatever was there before (her folder, her 404). Active: the reverse,
  refused if something else has taken the address meanwhile.
- **Delete.** Passkey, and type its name. A final backup, then the app is stopped, its address
  removed, and its files, database volume and backups moved to `/var/lib/pammy-apps/trash`
  for 30 days ("Restore" from the trash within that time). After 30 days the user, units and
  data go for good.
- **Move** to another address, with `place-wordpress.sh`'s link rewriting and its warning when
  moving away from the whole site.
- **Backups.** Nightly (kept 14), "Back up now", "Restore this one" (a backup of now is taken
  first), "Download" (a .tar.gz of the files and the database dump, streamed to her browser).
- **Updates.** Shows WordPress's version and any core, plugin or theme updates waiting (wp-cli,
  checked daily). "Update" takes a backup first, updates, checks the site answers, and puts the
  backup back by itself if it doesn't. Minor security releases stay automatic (WordPress's own).
- **Admin password.** "Reset the admin password": a new one, shown once. Needed until mail works,
  and after.
- **Health.** Running, answering (a request to it, through nginx), memory and disk used, last
  backup, updates waiting, and the last error lines from its log, on request.
- **Activity.** Every install, start, stop, move, backup, restore, update, reset and delete.

## G5. Email (A6)

One **outgoing mail** setting for the whole panel, used by every app (and later by the panel
itself: new-response notices, visitor setup links).

- Port 25 out is blocked on purpose; mail goes by SMTP submission on 587 with a login.
- Settings: host, port, user, password, the From address (`site-owner@example.org`, or `noreply@`). The
  password is kept like the database passwords: root-only file, handed to each app's container as a
  secret, never shown again.
- WordPress uses it through a small must-use plugin the helper puts in place (`wp_mail` →
  PHPMailer SMTP with those settings), not a plugin from the directory she could remove or that
  needs updating. "Send a test email" checks it end to end.
- The panel also looks up pammy.org's SPF record (an ordinary public DNS lookup) and says whether it
  includes the sender. It tells her what to add in Cloudflare; it never changes her DNS.
- **Which service** (E1): **Resend** (free: 3,000 a month, 100 a day, SMTP on 587), account owned by
  momolig. The panel shows failed sends, so the daily cap is never hit silently.
  pammy.org today: MX Zoho, SPF `v=spf1 include:zohomail.com ~all`, DMARC `p=none`. Both services
  sign with DKIM on pammy.org and use their own bounce (Return-Path) domain, so the root SPF line
  that Zoho relies on is not touched. The check is therefore DKIM (and the service's own
  "verified" state), not the root SPF.

## G6. Addresses and conflicts

The one placement file becomes a folder of placements, one per app
(`/etc/nginx/pammy-apps/<id>.conf` included by the pamela vhost), written only by the helper.
Rules, checked in the helper and shown in the panel before she chooses:
- at most one app on **the whole site**;
- a subdomain can't be a folder of hers (or an app's), nor www, api, panel, media;
- a path can't be a top-level folder of hers;
- `names.ts reservedNames()` reads every active app's subdomain, so the Subdomains page refuses them.

Apps are never gated (as today). Keeping one private, behind a protected folder's sign-in, is a
later addition (G10).

## G7. Limits

Each WordPress needs about 250-400 MB. Before installing or making one active, the helper checks
free memory and refuses with a plain reason below a margin (and a cap, 3 running, changeable in
the helper's settings). Memory limits per container (512 MB web, 384 MB database).

## G8. The panel

- A menu group **Apps**: "Your apps", "Install an app". Account managers only.
- Home: a line per app on the Databases-style card (running / offline / updates waiting).
- Getting started: a "Start a WordPress blog" path (install, sign in, first post, set mail).
- Guide **21, Apps**, replacing guide 07 (WordPress) as the place for this; 07 keeps the
  WordPress-specific parts (its admin, themes, where its files are). Guide 19 gets a line on when
  WordPress suits better than the panel's own blog.

## G9. The catalog

An app kind is one entry: its images, its containers, its settings, its install and its checks,
update and backup steps, what "answering" means. v1 has one: `wordpress`. A second (A5, open) is
added as a new entry and its tests, nothing else.

## G10. Later (not in v1)

- A test copy ("Make a copy to try things on").
- Keep an app private behind a protected folder.
- A second app kind (A5).

## Order

| Phase | What | Risk |
|---|---|---|
| 1 | The helper, `adopt`, `list`/`status`/health, the Installed software pages, read-only | low: nothing new runs, no nginx change |
| 2 | Active / inactive, backups (now, list, restore, download), reset admin password, logs (the placement folder moved to phase 4, P2a) | medium |
| 3 | Outgoing mail (G5), for WordPress and the test email | medium |
| 4 | The placement folder (G6), install a new WordPress, delete with the 30-day trash, move | high: makes users and containers |
| 5 | Updates (check daily, update with backup and automatic undo) | medium |
| 6 | Guide 21, Getting started path, Home line | low |

Each phase is one release, with its tests: the helper's operations against a fake runner (no real
podman), nginx tests with placements, the panel's routes, the browser, and live checks in a
`verify-apps.sh` that verify-panel.sh runs.

## Phase 1 as built (2026-09-23)

**What changed from the plan.** The placement folder (G6) moved to phase 2: nothing in phase 1
writes a placement, and moving the live include only to get the same nginx result was risk with
nothing to show for it. Phase 1 changes no nginx file at all. The wording is N1.

**The helper, `src/apps/`** (`pammy-apps.socket` root:svc-pammypanel 660, `pammy-apps.service`):
- `record.ts`: `/var/lib/pammy-apps/apps.json` (root 700/600), checked field by field on every
  read (ids, users, units, absolute normal paths). A damaged record is refused with a plain
  reason, never half-used. Written by a temp file and a rename.
- `catalog.ts`: one kind, `wordpress`: its name, where its version is written, what counts as
  answering (200-399), and its admin path.
- `ops.ts`: `list` (quick: placement, address, version, containers up) and `status` (one
  app in full: state running/offline/stopped/trouble, problems in her words, containers and
  their memory, answering, disk, backups, the server's free memory). Nothing else is on the
  allow-list (`service.ts`); a request can't name a path, user or command.
- `host.ts`: everything it reads. Containers from their **cgroup files** (`cgroup.events`
  populated, `memory.stat` anon), not D-Bus into svc-pammywp's manager, so the sandbox needs no
  privilege for it. "Answering" is one GET to nginx on 127.0.0.1:443 with the visitor's host
  name (the origin certificate isn't checked; loopback only); an app served nowhere is asked on
  its own port instead, so "offline" and "broken" differ. Folder sizes are walked and kept for
  10 minutes. Backups are counted by moments with both halves (`db-` and `files-`).
- `adopt.ts` + `adopt-cli.ts` (G3): run by the installer as root, never on the socket. It
  checks that svc-pammywp, the placement line and WordPress's files are there, and then
  writes only the record: id `blog`, layout `adopted-wordpress`, the paths `lib.sh` uses,
  installedAt = the birth time of /var/lib/svc-pammywp. It is safe to run again ("already
  adopted"), writes nothing where there's no WordPress, and never writes over another app
  called `blog`.
- **Sandbox, phase 1:** root with `CapabilityBoundingSet=CAP_DAC_READ_SEARCH` only (it can
  read svc-pammywp's 700 folders, and write nothing that isn't its own), `ProtectSystem=strict`
  + `StateDirectory=pammy-apps`, `ProtectHome=yes`, /pamela and every secret inaccessible,
  loopback only, `@system-service` minus `@privileged`. Each later phase widens this on purpose.

**The panel:** `GET /api/software` and `GET /api/software/:id` (account managers; an account
kept to one folder gets 404). The menu group **Software** > **Installed software**. `/software`
lists each app with its state, address, version, last backup, "Open it", "Sign in to its
admin". `/software/<id>` shows how it's doing (Check again), where it is (address, files at
/pamela/wordpress, version, installed by momolig), inside (each container's memory, the
server's free memory), space used, backups, and "To change something about it, ask momolig."

**Install:** `install-panel.sh` puts the two units in, runs `adopt-cli.ts` (a failure is a
note and writes nothing; verify then fails), enables the socket, asks `list` as the panel's
user in its health check (and puts the previous version back if that fails, disabling the
socket for a version that predates it). `deploy/verify-apps.sh` (run by verify-panel.sh): who
can ask, the one capability, the sandbox from inside (/pamela, secrets, /home blocked; /etc,
WordPress's files, nginx not writable), the record's modes, and that what the helper says
matches what is there (placement line, version.php, `systemctl --user` for each container,
curl through nginx, the backups folder, /pamela/wordpress).

**Tests:** `test/apps.test.ts` (20: placements, adopting (and a fingerprint of every file to
prove nothing else changed), the helper over a real socket against a folder laid out like the
server (`test/apps-world.ts`), refusals, a damaged record, size caching, realProbe against a
real HTTP server), `test/panel.test.ts` "installed software" (5), `test/e2e/37-software.spec.ts`
(menu, list, detail, a stopped database shown in her words, Check again).

## Phase 2 as built (2026-09-23)

**How the helper does things (runner.ts).** It never switches user itself. Each command runs as
a short-lived systemd unit: `systemd-run --wait --pipe --collect`, named `pammy-apps-<what>-<rand>`,
either as root or as `svc-pammywp`. For `svc-pammywp` it sets `XDG_RUNTIME_DIR`, the user's bus
and `HOME`, so rootless podman and `systemctl --user` work. The helper keeps its single
capability, `CAP_DAC_READ_SEARCH`. It writes only `/var/lib/pammy-apps` and
`/etc/nginx/pammy-wordpress`, and it still can't see her home. Said plainly in its unit file: a
root process that may ask systemd for units can have anything done. The boundary is the socket
and the allow-list, whose every argument is checked against the helper's own record or against
what is really there. Its own reads (gzip -t, journalctl, tar for a download) run in the helper.

**Jobs (jobs.ts).** Backup, restore, offline and online are jobs. The request returns at once,
because the panel's API gives up after 30 s. Only one job runs per app (`busy` otherwise).
`status` carries `job` (what it's doing now, in her words) and `recent`. The history is
`/var/lib/pammy-apps/history.json` (root 600, the last 200 entries); a new admin password adds
a line there too. The page asks again every 2 s while a job runs, and re-fetches everything when
it ends.

**The operations (wordpress.ts):**
- **Back up now:** `systemctl --user start pammywp-backup.service`, the nightly unit itself.
  Refused while offline.
- **Put this back** (P2b; passkey): it checks the backup is really in the folder, `gzip -t`s both
  halves, and refuses a backup whose `url-` differs from the current address (its links would
  point elsewhere; momolig's job). Then it backs up now, stops the web container, and as root
  moves the files aside to `/srv/pamela-wordpress.pre-restore-<stamp>` (asides older than 14
  days are removed then), untars with `-p` and sets the default ACL, as `restore-wordpress.sh`
  does. It starts the web container again, waits for the database, pipes the dump into mariadb
  as `svc-pammywp`, and waits until it answers.
- **Offline (A4):** nginx first (placement `off`, rendered by `nginx.ts`, then `nginx -t`, and the
  three files are put back if nginx refuses), then the record's `offline: {from, at}`, then as
  `svc-pammywp`: `disable --now pammywp-backup.timer`, `stop` both containers, and `mask` both,
  so a reboot doesn't bring it back. **Online** is the reverse: unmask, start, wait for the
  database and the site, re-enable the timer, write `from` back to nginx, check through nginx.
  It never rewrites links: the address is the same as before.
- **New admin password** (P2c; passkey): it lists administrators with wp-cli
  (`user list --role=administrator`) and accepts only a name from that list. The password
  (18 random bytes, base64url) goes to wp-cli on **stdin** (`user update --prompt=user_pass`,
  checked against a real WordPress 2026-09-23), never on a command line. wp-cli repeats it on
  stdout, so that failure's message never quotes the output. The login file is written as
  pamela (`umask 077; cat >`). A phase-1 record reads as having
  `/home/pamela/wordpress-login.txt`.
- **Complaints:** `journalctl _UID=<svc> CONTAINER_NAME=<unit> -p warning -n 40`, web and db.
- **Download:** `tar -cf -` of the two halves and `url-`, streamed through the socket (jsonline
  streams) and the panel (`/api/software/:id/backups/:stamp/download`, nginx `location ~
  ^/api/software(/|$)`: not buffered, 120 s; not a `^~ /api/software/` prefix, which 301s the list). Recorded in the activity.

**nginx.ts** renders `main.conf`, `server.conf` and `placement` from WordPress's templates.
build.sh copies them into `release/apps/wordpress-nginx`, and the installer refuses them if they
changed after the build. `test/apps-nginx.test.ts` runs the bash `render_placement` beside it for
six placements and compares byte for byte, so the installer's exact-match check on `main.conf`
keeps passing whoever wrote it last.

**Panel:** routes in `src/panel/routes/software.ts`, activity actions `software-backup`,
`software-restore`, `software-backup-downloaded`, `software-offline`, `software-online`,
`software-admin-password` (whose detail names the user, never the password). The detail page
has a job banner, "Take it offline" / "Bring it back online" (each asks first), Backups (Back up
now, Download, Put this back), Admin password (asks WordPress for its admins only when opened),
"What it complained about lately" (loaded when opened) and "What was done lately".

**Checks:** `test/apps-jobs.test.ts` (19, with a recording runner playing systemd, podman and
nginx over the fake server), `test/apps-nginx.test.ts` (6), panel routes (+7), nginx (+3),
e2e 37 (+2). `verify-apps.sh` adds: the nginx folder is the one writable nginx place;
`admins` really runs wp-cli as svc-pammywp through systemd-run (a named unit in the journal);
logs and backups readable. It doesn't try the changes (backup, restore, offline, password),
which are tried from the panel after install.

## Phase 3 design (2026-09-23)

G5 as planned, changed by M1-M3. Nothing but these two pieces reaches the internet.
- **`pammy-mail`**: a new small service (`src/mail/`, its own user `svc-pammymail`, socket
  root:svc-pammypanel 660). It holds the key (`/etc/pammy-mail/resend.key`, root 600, by
  LoadCredential) and is the ONLY service allowed off this machine: Resend's HTTPS API. It sends
  only to the notice address in `/etc/pammy-mail/settings.json`, and only a subject, a few lines
  and a panel link. Rate limited (60 an hour, 300 a day; Resend's free plan allows 100 a day).
- **WordPress** sends itself, by SMTP from its container (`smtp.resend.com:587`, STARTTLS, user
  `resend`), through a must-use plugin `pammy-mail.php`. It reads `/etc/pammywp/mail.json` (the
  WordPress config folder, root 644 inside svc-pammywp's 700 home, mounted read-only): no
  container or quadlet change. Failed sends go to the container's stderr (`pammy-mail: ...`),
  so they show under "What it complained about lately".
- **Settings** are written by the software helper (root): `mail-get` and `mail-set` (passkey)
  write the key and settings, WordPress's mail.json and plugin, and restart pammy-mail.
  `mail-test` sends a test through WordPress with wp-cli.
- **Notices**: the panel checks the gate every minute (a new admin op, `notices.since`, with a
  cursor kept in the panel's database) and asks pammy-mail to send. The first check only sets
  the cursor, so nothing old is sent. What to be told about is chosen on the panel's **Email**
  page: forms, comment areas (only when waiting for approval), access requests. An email never
  carries the response itself or a visitor's details: "A new response to RSVP, on
  /party.html", and a link. Mail passes through Resend (US), so that is on purpose.

## Phase 3 as built (2026-09-23)

As designed above. The differences, and what to know:
- **pammy-mail** (`src/mail/`): `status`, `test`, `notice`. It sends through Resend's HTTP API
  (fetch, no new dependency), with an idempotency key per event (`response:<id>`,
  `request:<id>`). The limits are 60 an hour and 90 a day, under Resend's 100. The unit has no
  capabilities, nothing writable, and /pamela, /srv and /var/lib all inaccessible; it is the one
  unit without `IPAddressDeny`. Installed with an empty `/etc/pammy-mail/resend.key` (root 600,
  so that LoadCredential works) and default `settings.json` (root 644); the installer never
  overwrites either.
- **The helper** (`src/apps/mail.ts`): `mail-get` (the key's last 4 only), `mail-set` (key
  `re_...`, three plain addresses, one line each, so nothing can be added to a header),
  `mail-test` (wp-cli `eval` of the helper's own PHP; the address is checked by ADDRESS_RE, so
  it can't break out of the string). mail-set writes the key and settings, WordPress's
  `mail.json` (root 644 in its root-owned config folder) and the must-use plugin
  (`src/apps/wp/pammy-mail.php`, written as svc-pammywp, 664), then `systemctl try-restart
  pammy-mail`. Newly writable for the helper, optional if missing: `/etc/pammy-mail` and
  `/var/lib/svc-pammywp/config`.
- **The plugin**: `phpmailer_init` to SMTP 587 STARTTLS, user `resend`; From is the setting,
  From name is the site's own name, Reply-To the setting unless the message already has one;
  `wp_mail_failed` goes to error_log (`pammy-mail: ...`, seen in its complaints). Without the
  file it does nothing.
- **Notices** (`src/panel/notices.ts`, run by server.ts every minute): the gate's
  `notices.since` gives ids, form, title, kind, page, time and waiting, and nothing a visitor
  typed (tested). The first look only sets the cursor (migration 0018,
  `panel.mail_notices`). If mail isn't set up, it moves past the events and records why. If
  sending fails it tries again next minute, and gives up on an event after an hour. At most 10
  go one by one, then one "N more". Only forms and comment areas that exist and aren't
  examples can be chosen; a comment area notices only comments waiting for approval.
- **Panel**: `/email` (menu Software > Email): Sending (the key never shown again, only
  "ends in ...", passkey to save), Send a test (from the panel, from WordPress), Tell me about.
  The WordPress page links to it. Activity: `mail-settings-changed` (detail "a new key, ending
  XXXX" or "the addresses"), `mail-notices-changed`, `mail-test`.
- **Checks**: mail.test.ts (6), notices.test.ts (10, against a real gate), apps-jobs (+5), panel
  (+4), e2e 38. verify-apps.sh: the mail service's user, socket, key modes, that it can't
  read the key itself, runs without capabilities, and its sandbox; and, when set up,
  WordPress's mail.json and plugin. It sends nothing.

## Phase 4a as built (2026-09-23): several installs in nginx, and Move

- **nginx.ts `renderAll`** (P4a): `main.conf` and `server.conf` hold every install's blocks
  (a path block each, a subdomain server block each; with one install on the whole site, the
  others' path blocks follow the root template). Each install keeps its own placement line
  (the blog's in `placement`); every install but the blog gets `proxy-<id>.conf`, made from
  `proxy.conf` with its port. `clash()` allows one install on the whole site, and a name once
  per kind. With the blog alone the output is byte-for-byte place-wordpress.sh's: tested in
  apps-nginx.test.ts, and compared with the live server's three files on 2026-09-23 (same).
  `test/run-gate-nginx-test.sh` loads three pairs of installs into the real pamela vhost:
  nginx -t, each address reaches its own install, her folders and protected folders are
  unchanged (+14).
- **`place()`** in wordpress.ts renders from every record (the others' placement read from their
  lines). Offline and online use it too. `reload: false` leaves the reload to Move.
- **Move** (`move`, a job; passkey): refused while offline, to `off`, to the same place, to a
  reserved name (www, api, panel, media). The panel refuses a name that is one of her
  top-level folders (the folder helper's list; the software helper can't see /pamela). Then,
  as place-wordpress.sh: a backup; nginx staged and tested, not reloaded; `wp.php` and
  `apache.conf` written in place (apache.conf is a single-file bind mount; both byte-for-byte
  the bash's, tested); the web container restarted; if WordPress is installed, the three
  `search-replace` passes (the same arguments as lib.sh, tested) and `rewrite flush --hard`;
  content-url; then nginx reloads, and it asks the new address. If WordPress refuses, nginx,
  wp.php and apache.conf are put back and the container restarted, and nginx never reloads
  onto the new files. Moving away from the whole site says the links to her other pages were
  changed too. The old address stops working (the confirm dialog says so).
- `build.sh` ships `proxy.conf` beside the templates; `verify-apps.sh` checks the live files
  are exactly what the helper writes for every install.

## Phase 4b as built (2026-09-23): Install a new WordPress

- **Page** `/software/new` ("Install WordPress" on the list): where it goes (a subdomain, a folder
  of pammy.org, the whole site, or nowhere yet), its title, admin name (pamela) and admin email
  (hello@pammy.org). The short name is the address name, or typed for the whole site or
  nowhere: at most 20, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. Passkey. The panel refuses a name that
  is one of her folders. It then goes to the new install's own page, which shows each step and,
  when it ends, **its admin password once** (`POST /api/software/:id/login`: the helper hands it
  over once, within the hour, and forgets it; a POST, so no HEAD or prefetch uses it up). Titles
  are now "WordPress (id)".
- **Helper** (`install.ts`): `checkRequest`, a clash with every other install's address, and
  `preflight` (G7): the name and its user are free; fewer than 3 running; at least 1 GiB of
  memory available; at least 3 GiB of disk; a port from 3100-3199 that no record uses and that
  isn't in LISTEN in /proc/net/tcp{,6}. The record is written first (`setup: installing`,
  updated at each step), so a failure is kept with its step and reason (`setup: failed`,
  state `failed`). What was made stays, for Delete (4c). verify-apps.sh notes it, never
  fails on it.
- **Steps**, each a named systemd unit (install-wordpress.sh's, with the install's own names,
  record.ts `standardRecord`):
  1. As root: `useradd --system` `svc-app-<id>` (home `/var/lib/svc-app-<id>`, 700), the
     next subuid/subgid range, `/var/lib/cni`, linger, pamela added to its group, and a wait
     for its user bus.
  2. As root: `/srv/pamela-apps` (755), its files (2770, default ACL), its settings folder
     (root 755), `bin`, `backups` (700). The settings: wp.php, apache.conf, php.ini and
     wp-cli.yml, written by a root unit (`config-files.ts`: the helper can't write inside its
     home). `bin/backup-app.sh` (`src/apps/wp/backup-app.sh`: the blog's backup, generic, so
     the same files for Backups, Put this back and Download). As pamela: the link
     `/pamela/apps/<id>`.
  3. As its user: podman secrets for the database (never in a file).
  4. Its units (`wp/units.ts`): web (MemoryMax 512M), db (384M), volume, network, backup
     service and timer (03:40). Then its own copy of the three images.
  5. `daemon-reload`, start the web container; wait for the site and the database; as root,
     the image's world-readable first copy made hers (`chmod -R g+rwX,o-rwx`, setgid dirs).
  6. `wp core install` with `--prompt=admin_password` (the password on stdin; wp-cli repeats
     it on stdout, so that failure is never quoted), content-url,
     `rewrite structure /%postname%/`, `auto-updates.php`, mail if set up, and the timers on.
  7. As pamela: `/home/pamela/apps/<id>-login.txt`. Then its address (nginx, both installs),
     a first backup, and a look through nginx.
- **Tried for real** on 2026-09-23 as momolig, rootless and then removed by name: the generated
  units started (MemoryMax 536870912 and 402653184 in force), the database became healthy,
  `wp core install --prompt=admin_password` from stdin worked (check-password: yes), and
  backup-app.sh made a dump with 12 tables, the files, and url.
- **Her Subdomains** refuse every install's subdomain: `names.ts readPlacements` reads the
  blog's placement file and every `placement-<id>` beside it (sitefs, home pages).
- **Installer**: its exact-match check on main.conf and server.conf also accepts what this
  release's helper would write for the installs in the record (with more than one install,
  the bash single-install render no longer matches). **verify-apps.sh**, for each finished
  install: its user (no shell, not sudo, lingering), files 2770 its own, her link, settings
  root 755, and that it can't enter /pamela, can't read the blog's files, and can't rewrite
  its own settings. Then its state.

## 4b fix (2026-09-23): release 189a2978d2eb76e2

- Live, installing "garden" stopped at "Making its own user": `useradd: not found`. The
  runner gave its steps `PATH=/usr/local/bin:/usr/bin:/bin`. A step's `sh -c` finds useradd
  and usermod through that PATH (systemd resolves only argv[0], so `nginx -t` had worked).
  The rootless trial never went through systemd-run as root, so it didn't catch this.
  `runner.ts RUN_PATH` now has the sbin folders, and a test checks what systemd-run is given.
- An install stopped at its first step with no user made left only its record. It can now
  be installed again under the same name ("garden"). After its user exists, the name
  stays until Delete (4c).
- First install attempt (14:50 UTC) was rolled back by verify-apps.sh, which tripped over the
  failed "garden" record: it wanted exactly "blog" listed, and read garden's missing placement
  file. Fixed in deploy/ (commit 5cb21fa): the blog must be among those listed, and an
  install counts for nginx once finished or placed (the installer's check too). The code is
  unchanged, so it is the same release 189a2978.

## 4b fix 2 (2026-09-23): release 93c536b16f01db06

- After 189a2978, "garden" stopped at its second step: ENOENT
  `/opt/pammy-panel/apps/wordpress-config/php.ini`. build.sh never shipped
  ~/pamela-setup/wordpress/config. It does now, and the build fails if any file the helper
  reads beside its code (ops.ts TEMPLATES/WP_CONFIG, install.ts BACKUP_SCRIPT/WP_CONFIG_FILES,
  mail.ts PLUGIN) is missing from the release.
- **An install that didn't finish can be tried again** (not only one stopped before its
  user): every step is safe to repeat (user, subuids and subgids only if missing; WordPress
  set up once; tried again after that, her admin gets a new password, created if the name
  differs). The same record, port and installedAt. The failed page has **Try again**
  (`/software/new?again=<id>`, the name filled in). Delete (4c) is still the way to give up.

## Phase 4c as built (2026-09-23): Delete, the deleted software, Restore, for good

What changed from G4: the files, database volume and backups are **not moved** into
/var/lib/pammy-apps/trash. They stay with the install's own user for the 30 days. Moving a
rootless podman volume (subuid-owned) is fragile, and restoring would move it back. Her
link is what she sees, so that is what goes.

- **Delete** (`delete`, a job; passkey and its name typed, checked by the panel): if it is
  online, a last backup (if that fails, nothing is deleted: "take it offline first"), then
  `offline` as A4. Then her link goes (as pamela, only if it is a link) and the record gets
  `deleted: {at, by}` (checkRecord: deleted implies offline). Kept `KEEP_DELETED` = 30
  days. Its address is free; its name is not ("in your deleted software until ...").
  Backups can still be downloaded. `online`, move, backups, admin and mail refuse, as
  offline or deleted. **An install that didn't finish** (failed, or cut off by a helper
  restart) goes for good at once.
- **Restore** (`undelete`; manager, no passkey): her link back (refused if something else
  took the name), `deleted` cleared, still offline.
- **For good** (`purge`; passkey and name; only from deleted or unfinished):
  `wordpress.ts unplace` (every other install rendered, its placement file and
  proxy-<id>.conf removed, `nginx -t`, put back if refused; the blog's proxy.conf stays).
  Then as its user `systemctl --user stop ...; podman system reset -f` (not a must). Then
  one root unit: disable-linger, terminate-user, wait for user@, pkill, userdel,
  groupdel, subuid/subgid lines, `rm -rf --one-file-system` home + files +
  `.pre-restore-*`, her link, her login file. Then out of the record. `remove.ts
  purgePaths` allows only svc-pammywp + /srv/pamela-wordpress + /pamela/wordpress +
  wordpress-login.txt, or svc-app-<id> + /srv/pamela-apps/<id> + /pamela/apps/<id> +
  apps/<id>-login.txt.
- **After 30 days**: `pammy-apps-purge.timer` (daily 04:20, Persistent) runs
  `pammy-apps-purge.service` as svc-pammypanel (no capabilities, AF_UNIX only), which asks
  `purge-due`. Installer: install + `enable --now`, and disabled on rollback to a release
  without remove.ts. NB a rollback's older helper drops `deleted` when it next writes the
  record, so a deleted one would read as merely offline.
- **Panel**: `POST /api/software/:id/{delete,undelete,purge}`, activity `software-delete`,
  `software-undelete`, `software-purge`. The list has a separate "Deleted" section. A
  deleted one's page has a Deleted section (Restore it / Delete it for good...) and its
  Backups (download). Every other install's page has "Delete it" at the bottom. A page
  whose install went away (404 after it was shown) goes back to the list.
- **verify**: verify-apps.sh runs the blog's checks only while the blog is here (absent: a
  note if svc-pammywp is gone too; deleted: a note). wp-cli is asked only while the blog is
  online. Deleted panel installs get a note. New checks: the purge timer is enabled, runs as
  svc-pammypanel, and nothing is kept past its 30 days. verify-panel.sh neighbours =
  pammy.org + every address the helper serves (was a hard-coded blog.pammy.org).
- **Checks**: apps-jobs +10 (order, last backup failing, restore, for good incl. nginx for
  no installs, an unfinished one with its proxy, purge-due at 30 days, purgePaths
  refusals); panel +1; e2e 37 +1 (delete, list, restore, delete, for good). The root
  script was only syntax-checked here, and the link scripts were run in a scratch folder.
  Try it on a throwaway install first.

## Questions for momolig

1. **E1** Email: check whether Zoho's free plan can send by SMTP, or go straight to a sending
   service (Brevo's free tier)? Either needs an account and a DNS line in Cloudflare.
2. **A5** A second app kind: nothing for now (my suggestion), or is there one she has asked about
   (a photo gallery, a wiki, visitor statistics)?
3. **Q1** New apps' files in `/pamela/apps/<id>`, which she can edit with WinSCP and Claude, like
   `/pamela/wordpress`? (My suggestion: yes, same as today.)
