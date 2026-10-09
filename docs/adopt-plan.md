# Taking in what already runs: phase 6 of the platform plan

Status: **decided 2026-09-25** by momolig, every suggestion taken (Q1-Q6, at the end): Gonsalves's nginx waits for phase 7; instastylr and the apex move into site folders (the apex's is `home`); apex and www kept as they are; a stopped service stays stopped (masked), and verify may restart TutorStar; `services` right, whole-site, fresh passkey; the old certificates keep renewing until phase 7. Part of
docs/platform-plan.md (phase 6: "Adopt the services (G6): the apex and instastylr as site folders,
TutorStar, then Gonsalves (grouped); start/stop/restart/health. Delete locked for adopted ones").
Builds on phase 4 (docs/hosts-plan.md: hosts, routes, site folders, the routing helper) and
phase 5 (docs/lfdln-standup-plan.md: panel.lesfleursdelanuit.com is live and has taken over the
stopgap, 2026-09-25).

Phase 6 is for two things:
- The names that already work on lesfleursdelanuit.com (the apex, www, instastylr, tutor) become
  hosts the panel keeps. Each one goes over only after the panel's version has been shown to
  answer the same way as the hand-written one.
- The containers that already run (TutorStar, the four Gonsalves apps) appear in the panel. You
  can see them, start, stop and restart them, and check that they answer.

The data doesn't move in this phase: that is phase 6b (G8).

## What was found (2026-09-25)

**Six hand-written nginx files** in sites-enabled, besides the panel's own and pammy.org's:

| File | Names | What it does | Certificate |
|---|---|---|---|
| `lesfleursdelanuit` | apex, www | static, root `/var/www/lesfleursdelanuit`, `try_files $uri $uri/ =404`. There's no `index.html` at the top, so `/` answers **403** today. The only content is `stefanie/` (5 pages and fonts, 200). | its own, HTTP-01 |
| `instastylr` | instastylr. | static single-page app, root `/var/www/instastylr`. A strict CSP and six more security headers (HSTS among them); `/assets/` cached for a year as immutable, the headers repeated there. | its own, HTTP-01 |
| `tutorstar` | tutor. | proxy to 127.0.0.1:3041 with websockets; `client_max_body_size 25m`; `/api/auth/sign-in` rate-limited (`zone=login`, 5 per minute, burst 3, in `conf.d/ratelimit.conf`) | its own, HTTP-01 |
| `gonsalves-public` | gonsalvesfamily.com, www | proxy to :3039, 25m, `= /api/auth/login` rate-limited; `/uploads/gedcom-admin/` and `/uploads/site-media/` served from `/mnt/storage/uploads` (cached 30 days) | `gonsalvesfamily.com` (one certificate for three names) |
| `gonsalves-admin` | admin.gonsalvesfamily.com | proxy to :3040, 25m, `= /api/auth/login` rate-limited, an ACME folder | the same |
| `default-443` | anything else | refuses the TLS handshake | none |

Every certbot-managed file has the same :80 block: http goes to https for its own names.

**instastylr is deployed by a script that writes nginx.** `~/apps/instastylr/deploy/deploy.sh`,
run as root, does three things:
- rsyncs `dist/` into `/var/www/instastylr` (owned by www-data, 755/644);
- **copies its own nginx file over `sites-available/instastylr` and links it back into
  sites-enabled**;
- runs `certbot --nginx`.

After a takeover, the next deploy would put the old block back beside the panel's. That gives two
blocks with the same `server_name`: nginx warns and serves whichever it loads first. So the script
has to change in the same step (V6).

**The containers** (the Quadlet files in `/srv/apps/*/deploy/quadlet`; the installed copies are
what runs, and G8 found them different from the repository's):

| Service | User | Unit | Port | Answers at | In nginx |
|---|---|---|---|---|---|
| TutorStar | svc-tutorstar | tutorstar.service | 3041 | `/` 200 | tutor. |
| Gonsalves public | svc-ligneous | ligneous-public.service | 3039 | `/` 200 | gonsalvesfamily.com, www |
| Gonsalves admin | svc-ligneous | ligneous-admin.service | 3040 | `/api/health` 200 | admin.gonsalvesfamily.com |
| Gonsalves GEDCOM API | svc-ligneous | ligneous-gedcom-api.service | 8091 | `/health` 200 | no, internal only |
| Gonsalves Flask API | svc-ligneous | ligneous-flask-api.service | 5001 | `/api/health` 200 | no, internal only |
| Gonsalves migrator | svc-ligneous | ligneous-migrator.service (one-shot) | none | none | none |

- **public and admin `Require=` the two APIs**, so stopping either API stops them too.
- `ligneous-apps.target` groups the four.
- Each container has `WantedBy=default.target`, so it comes back on its own after a reboot.
- The service users' Quadlet folders are 700. Only a root helper can read them.
- They are driven with `systemctl --user -M <user>@` (the runbooks already do this).

**The hosts module today** covers one domain and only single-label names under it (`hostName` in
names.ts). Its route targets are a site folder or a redirect. Its folder routes can't add headers
or cache rules. The routing helper may write only `/etc/nginx/lfdln-hosts/`, so it can't take a
hand-written file out of sites-enabled.

## Proposal

- **V1. Only lfdln's names go over in phase 6. Gonsalves's nginx waits for phase 7** (Q1) (2026-09-26: phase 7b = docs/domains-hosts-plan.md step 7).
  - The apex, www, instastylr and tutor become the panel's hosts. All four are covered by the
    wildcard certificate, which already includes the apex.
  - gonsalvesfamily.com is another domain, with its own certificate and a DNS zone that isn't
    DreamHost's lfdln zone. Hosts on other domains and their certificates are phase 7, as the
    hosts plan says.
  - In phase 6 the **Gonsalves services** are still taken in (V7): you can see, start, stop and
    restart them. Their two nginx files stay as they are.
- **V2. The apex and www as hosts.** The hosts table gets two names beyond single labels, and
  only these two: `@` (lesfleursdelanuit.com) and `www`.
  - `www` stays refused for new hosts: it can only exist as the apex's second name, never as a
    host of its own.
  - One server block is rendered for both, with the wildcard certificate, exactly as today (Q3).
  - The catch-all's regex already leaves `www` out, and the apex never matched it.
- **V3. A new route target: a service.** `routes.target_kind = 'service'` points at one part of
  an adopted service (V7). It is rendered as `proxy_pass http://127.0.0.1:<port>`, and the port
  comes from the service's record, never from the route. It sends the four headers every file
  here sends today (Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto). Its options:
  - **websockets** (on by default: `Upgrade`, `Connection "upgrade"`, HTTP/1.1);
  - **largest upload** in MB (nginx's default of 1 if not set; tutor 25);
  - **sign-in paths**: exact or prefix paths that get the `login` rate limit (5 per minute, burst
    3), each with the same proxy lines. tutor's is `/api/auth/sign-in` (a prefix).
- **V4. Two more options on a folder route**, for instastylr:
  - **Headers**: a list of response headers, sent `always`, on every location of the route
    (nginx's rule that a location with its own `add_header` loses the server's is handled by
    the renderer, not by people).
    - Names come from an allow-list: Content-Security-Policy, X-Content-Type-Options,
      X-Frame-Options, Referrer-Policy, Cross-Origin-Opener-Policy, Permissions-Policy,
      Strict-Transport-Security.
    - Values may contain letters, digits, spaces and `'-_.:/;=,()*@`. Nothing that could close
      the string or start a variable (`"`, `\`, `$`, `{`, newlines).
  - **Cached for good**: path prefixes inside the route (instastylr's `/assets/`) served with
    `expires 1y` and `Cache-Control "public, immutable"`, and the headers above repeated.
- **V5. Moving the two static sites into the site folders** (Q2). This follows F1 and D3: what
  is served lives in the site folders and belongs to svc-lfdlnsites.
  - `/var/www/instastylr` is copied to `<sitesRoot>/instastylr`, and `/var/www/lesfleursdelanuit`
    to `<sitesRoot>/home` (a folder needs a label for its name; `home` is suggested). Both are
    svc-lfdlnsites:lfdln-sites, 2750/640.
  - Each is adopted (`adopted`, so it can't be deleted from the panel while a route shows it),
    and its checksums are compared before the route goes over. (2026-09-27: once no route shows
    an adopted site folder any more -- exam prep's, after its host went to the Next.js service --
    Delete on the Hosts page sends it to the trash for 30 days, like any other.)
  - The old folders stay where they are for 14 days, as the way back, and are then removed by
    hand (the helper can't write /var/www outside the site folders).
- **V6. Each host goes over only when requests prove it answers the same.** `lfdln-panel
  take-over-host <name>` does it, run by the installer (`install-lfdln.sh --take-over-host
  <name>`), one host at a time:
  1. **Before**: a fixed list of requests per host (its pages, a missing page, a dot-file, the
     assets, the sign-in path, http to https) is sent to the live hand-written block. For each
     one it records the status, the headers that matter (Location, Content-Type, the security
     headers, Cache-Control) and the body's sha256.
  2. **Switch**: in one apply, the routing helper writes the panel's block and removes the
     hand-written link from sites-enabled. Then one `nginx -t` and a reload. For this, the helper
     may remove exactly the links recorded as adoptable (`lesfleursdelanuit`, `instastylr`,
     `tutorstar`), and put them back. It has no other write in sites-enabled. Two blocks for one
     name never exist together.
  3. **After**: the same requests again. Any difference and the helper puts the link back and
     removes the panel's block, and the host stays hand-written with the difference shown.
  4. The hand-written files stay in sites-available, unlinked, as the record of what was there.
  - The instastylr deploy script changes in the same step: it rsyncs into the new folder with the
    new owner and modes, and no longer touches nginx or certbot. That script lives in its own
    repository (`~/apps/instastylr`).
  - The three HTTP-01 certificates (apex, instastylr, tutor) are no longer used after this. They
    keep renewing until phase 7 removes them (Q6).
- **V7. A new module, `services`, and its helper, `lfdln-services`.**
  - **The record**: `/var/lib/lfdln-services/services.json`, root 600, written only by
    adoption. Adoption is run by the installer, never through the socket, as `apps.json` is (A1).
    Per service it holds:
    - id, title and user;
    - its parts: id, unit, port, health path, and whether it may be started from the panel
      (the migrator may not);
    - the order its parts start in (the APIs first) and stop in (the reverse);
    - adopted-at, and the sha256 of each Quadlet file at adoption, so the page can say "changed
      outside the panel since".
  - **Adopting changes nothing**: no unit, file, container, secret or nginx line.
    - TutorStar: one service, one part.
    - Gonsalves: one service, "Gonsalves family", with four parts and the migrator shown.
  - **The helper**: root, the same pattern as the software and routing helpers. Its only
    operations are `list`, `status`, `start`, `stop`, `restart` and `logs`, for a service or
    one part.
    - It runs `systemctl --user -M <user>@` and `journalctl _SYSTEMD_USER_UNIT=... _UID=...` as
      named transient units. It may run only units in its record.
    - It has no network but loopback, for the health checks.
  - **Status**: active or not, since when, restarts, memory (from the part's control group),
    and health (its port and path within 5 seconds).
  - **Start and stop**:
    - Stop is `stop`, then `mask`, so a stopped service stays stopped after a reboot (Q4).
    - Start is `unmask`, then `start`, then a wait until healthy, up to the unit's own start
      timeout.
    - Restart doesn't touch the mask.
    - A group runs its parts in order. Stopping an API part says which parts will stop with it
      (`Require=`).
  - **No Delete for these services** (D2): no button, and the helper has no such operation.
- **V8. Rights: a new `services` right, whole-site only in phase 6** (Q5).
  - Seeing services needs `services` on. Start, stop and restart need `services` and a fresh
    passkey. Adoption is the installer's.
  - A service route on the Hosts page needs both `hosts` and `services`.
  - Keeping someone to a service's hosts can come later.
- **V9. The pages.**
  - **Services** (`/services`): a card per service with its parts, each with its state, health,
    memory, and the hosts that show it. Start / Stop / Restart for the service and for each part.
    The last 200 log lines.
  - **Hosts**: service routes and their options, "Add a route → a service", the headers and
    cache options on folder routes, and "adopted" on the apex, www, instastylr and tutor.
  - Activity: `service-started/stopped/restarted`, `host-taken-over`.
- **V10. Verify** (added to `verify-lfdln.sh`):
  - the services helper's sandbox and who may ask it (as the routing helper's);
  - adopting twice changes nothing;
  - the record matches systemd;
  - a restart of a part really restarts it (TutorStar, while no one uses it: Q4's note);
  - after each takeover, the host's request list gives the same answers as the one recorded
    before;
  - tutor's sign-in path is rate-limited (the fourth fast request answers 503);
  - instastylr's headers and asset caching are there;
  - the apex's `/` answers what it did (403) and `stefanie/` 200;
  - gonsalvesfamily.com and admin. answer as before, untouched.

## Not in phase 6

- gonsalvesfamily.com's nginx and every certificate change (phase 7).
- Moving the data (phase 6b, G8).
- Building or deploying new images from the panel. Redeploys stay the runbooks
  (`/srv/apps/*/deploy`); the Projects module (G9) is where that goes later.
- Monitoring's checks every few minutes and its mail (phase 7). Phase 6 checks health when a
  page is opened and after a start.

## The net

- pammy.org: nothing changes. The `services` module is off for it, and its verify stays
  549 + 62.
- The renderer is tested through a real nginx, in the hosts nginx harness:
  - **the four hand-written files, loaded as they are, against the panel's rendered blocks**,
    with the same request list, and every answer compared;
  - a proxied test server stands in for the containers;
  - `nginx -t` refuses nothing it will later be given;
  - bad header values and ports that aren't a service's are refused before any file is written.
- The services helper is tested against a user manager in a test (a throwaway `systemd-run
  --user` unit), never against TutorStar or Gonsalves.
- On the server, one host at a time, each with its own way back (V6).

## Steps (one release each)

1. **V2-V4**: `@`/`www`, service routes, headers and caching, in the schema and the renderer.
   Tested against the four hand-written files in the nginx harness. No server change.
2. **V7-V9**: the services module, its helper and record, adoption in `install-lfdln.sh`, the
   Services page, the `services` right. Installed on the server: TutorStar and Gonsalves appear,
   and nothing about them changes.
3. **V5 + V6 for instastylr**: the folder copied, adopted and compared, the deploy script changed,
   then `--take-over-host instastylr`.
4. **V6 for the apex and www** (with `home/`), then **for tutor** (a service route to TutorStar).
5. The old folders removed after 14 days, by hand.

## Step 1, as built (2026-09-25)

Commit b9b24cb; built as release 3da161237a4a1079 / release-lfdln a632eaf9caef3ce7 (build: unit, nginx 30,
gate 175, hosts 60, adopt 15, tutorials 67, browser 115 + lfdln 16).
- `packages/hosts/migrations/0002-adopt.sql`: `hosts.name` may be `@`, `with_www` (only for `@`),
  `adopted`; routes of kind `service` (`service`, `service_part`, `websockets`, `max_body_mb`,
  `sign_in_paths`), and a folder route's `headers` and `cache_forever`. Every site gets the columns;
  pammy.org's schema snapshot changes, its tables don't.
- `names.ts`: `@`, service ids and ports, the largest upload, sign-in paths, and headers (an
  allow-list of seven names; values that can't close nginx's quotes or name a variable).
- `render.ts`: the domain's block with www and its own http→https; a service route
  (`proxy_pass` to the port from the table's `services`, never from the route; the four proxy
  headers; websockets; `client_max_body_size`; each sign-in path a location of its own with
  `limit_req zone=login burst=3 nodelay`); a folder route's headers on the route, its nested
  locations and the host's 404 page; cached-for-good paths (`expires 1y`, `immutable`, no single-page
  fallback, hidden files and PHP still refused first). The panel's own ports are refused.
- `takeover.ts`: the three takeovers (instastylr, `@` with `home/`, tutor), their request lists,
  `probe` and `compare`, and DIFFERENCES.
- **Found by the comparison and settled**: instastylr's 404s under `/assets/` carried the security
  headers (now the host's 404 page does too), and were marked immutable for a year (not copied:
  a DIFFERENCES line). `test/run-adopt-nginx-test.sh`: the hand-written files and the rendered ones
  give the same answers to 41 requests (status, the headers that matter, bodies); the sign-in limit
  (200×4 then 503), 20 MB through and 30 MB refused, a websocket switched through.

## Step 2, as built (2026-09-25)

- **`packages/services`**: `record.ts` (the record, checked when read, root 600, written whole),
  `known.ts` (TutorStar; Gonsalves's four parts and the migrator), `adopt.ts` (what `systemctl --user
  show` says: LoadState and SourcePath, and each Quadlet file's sha256; the first adoption time kept),
  `helper/` (list, status, ports, start, stop, restart, logs; no delete), `panel/routes/services.ts`,
  `web/pages/Services.tsx`, and the units `lfdln-services.{service,socket}`.
- **The helper** asks systemd for everything as the service's own user (`@panel/core/runner`):
  `show` (state, since, restarts, masked) and `sha256sum` of the Quadlet files; memory from the
  part's control group; health by one GET to 127.0.0.1. Stop = `stop` + `mask` (checked on a
  throwaway Quadlet container of momolig's: a masked generated unit refuses to start, and unmask +
  daemon-reload brings it back); start = `unmask`, `daemon-reload`, `start`, then waits (3 minutes)
  until each part answers 2xx/3xx; restart refuses a stopped part. Stopping a part takes what
  `Requires=` it with it (and masks them too); starting one starts what it needs first. One thing
  at a time per service. Logs: `journalctl _SYSTEMD_USER_UNIT=... _UID=...` as root.
- **Service routes on the Hosts page** (with the `services` right too): "Go to a service", the
  largest upload and sign-in paths. The panel sends the services' ports with the table; **the
  routing helper checks every one against the services record** and refuses anything else, so the
  panel can't send a host to another port (verify tries the panel's own database port).
- **The `services` right**, whole-site only; Services in the menu and on Home; Activity says
  `started/stopped/restarted <service> (<part>)`.
- **Installer**: section 6b adopts (as root, `sites/lfdln/src/helpers/services-adopt.ts`) and installs
  the helper. `lfdln-panel adopt-folders` and verify's table now carry the services' ports.
- **Verify** (lfdln): the record's and socket's modes, who may ask, no capabilities, nothing
  writable, 127.0.0.1 only; both services taken in and every part running and answering; their
  Quadlet files unchanged; adopting again gives the same record; no delete; the migrator refused;
  TutorStar's log; **TutorStar restarted once** (Q4); a route to :5435 refused by the routing helper.
- **Tests**: `test/services.test.ts` (21), `hosts-helper` (the port check), the lfdln browser tests
  (`04-services.spec.ts`: Services, Stop with what stops with it, Start all, Restart, the log, a
  service route; Services on a phone, dark).

## Step 3, as built (2026-09-25): the takeover, for every host

Built for all three hosts at once (one release). Each goes over only when it is asked for, one
at a time: `sudo deploy/lfdln/install-lfdln.sh --take-over-host instastylr` (then
`lesfleursdelanuit.com`, then `tutor`).
- **The installer** (section 8b), for a host with files: `rsync` from `/var/www/<old>` into
  `<sitesRoot>/<folder>` (svc-lfdlnsites:lfdln-sites, 2750/640), every file's sha256 compared,
  the old folder left for 14 days; then `lfdln-panel take-over-host <name>`.
- **`packages/hosts/src/take-over.ts`** (the command line runs it): the host's requests to the
  live hand-written block, **twice** (a body that isn't the same twice, a Next.js page's, isn't
  compared by its bytes); in one transaction the folder, host and routes (adopted) and the
  routing helper's apply with `takeOver: <link>`; the requests again, up to ten seconds for
  nginx's old workers to go; any difference and the rows go and the helper puts the link back
  (`giveBack`), then it waits until the host answers as it did before (**found by the rehearsal**:
  straight after a give-back the old workers still served the panel's block for a moment).
  Activity: `host-taken-over`, `host-given-back`.
- **The routing helper** may now write `/etc/nginx/sites-enabled` too, for one thing: take out,
  or put back, the link of a hand-written file takeover.ts names (instastylr, lesfleursdelanuit,
  tutorstar), and only if it points at that file in sites-available. The files themselves it can't
  change. The link goes with the same nginx -t as the panel's block, and comes back if nginx says no.
- **instastylr's deploy script** (`~/apps/instastylr/deploy/deploy.sh`, its own repository):
  publishes into the site folder with its owner and modes, and refuses to run while the old
  nginx link is still there. It no longer installs an nginx file or runs certbot.
- **Verify** (lfdln): for each host taken over, the panel's block in and the hand-written file
  kept, adopted, its folder's owner and mode; instastylr's CSP, cached assets and a refused
  hidden path; the apex's 403 at `/`, `/stefanie/` on both names, http to https; tutor through
  the panel's route and its sign-in limit (a 503 by the sixth fast request, at an address under
  the sign-in path that isn't one).
- **Tests**: `test/run-adopt-nginx-test.sh` now also rehearses the takeover on a nginx laid out
  like the server's (sites-enabled links to sites-available, the routing helper's site.conf
  linked beside them), with the real routing helper and a throwaway Postgres: one made to
  differ (given back, link and rows as they were), then all three taken over, and again
  (already). `hosts-helper`: the link rules.

## Live (2026-09-25)

Release-lfdln bc48b6b1525272a8 installed by momolig 2026-09-25: TutorStar and the Gonsalves
apps taken in; instastylr, lesfleursdelanuit.com (with www, folder `home`) and tutor taken
over one by one, each answering the same as its hand-written file; verify passed. On the way,
three installs back to back tripped lfdln-sitefs's start limit and the third rolled back to
f3cf1cb7 (which can't run on the migrated schema); fixed in the installer (c4cb0d5: reset-failed
first; a same-build reinstall never goes back). Left: step 5, removing /var/www/instastylr and
/var/www/lesfleursdelanuit by hand from 2026-10-09.

## Decided (momolig, 2026-09-25: every suggestion)

- **Q1. Gonsalves's nginx:** leave its two files hand-written until phase 7 (other domains and
  their certificates), while its services are taken in now? **Suggested: yes.**
- **Q2. instastylr and the apex's files:** move them into the site folders (V5), or leave them in
  `/var/www` and let a site folder point there, read-only in the panel? **Suggested: move**,
  with the old folders kept for 14 days. And the apex's folder name: `home`?
- **Q3. The apex and www:** keep them exactly as they are (both serve the same, `/` answers 403
  until there is an `index.html`), or make www redirect to the apex now? **Suggested: exactly as
  they are**; a redirect is a one-route change later.
- **Q4. A stopped service stays stopped after a reboot** (masked)? **Suggested: yes.** Verify
  restarts TutorStar once to check the helper. Is a restart of a few seconds fine at any time
  (D6 says downtime is fine for now)?
- **Q5. Who may start, stop and restart:** anyone with the `services` right, whole-site only,
  with a fresh passkey? **Suggested: yes.**
- **Q6. The old certificates** (apex, instastylr, tutor): leave them renewing, unused, until
  phase 7? **Suggested: yes.**
