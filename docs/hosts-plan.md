# Hosts, routes and site folders: phase 4 of the platform plan

Status: **decided 2026-09-25** (Q1-Q3 answered, below). Step 1 live 2026-09-25 as release 89da3a27f3c44447 (commit 11afe0a; build: unit 980, nginx 30, gate 175, hosts 49, tutorials 67, browser 115; see "Step 1, as built"; installed by momolig, the three empty tables on pammy.org). Step 2 built 2026-09-25 as release 8faaa66512a15b2a (commit d364aa8; build: unit 993, nginx 30, gate 175, hosts 60, tutorials 67, browser 115; see "Step 2, as built"); live 2026-09-25 (installed by momolig). Step 3 built 2026-09-25 as release feb54fe3ed91eeee (commit a181861; build: unit 1003, nginx 30, gate 175, hosts 60, tutorials 67, browser 115; see "Step 3, as built"); live 2026-09-25 03:52 UTC (installed by momolig; verify 549/549, access 62/62). Part of docs/platform-plan.md (phase 4: "Hosts
and routes (G3) and its nginx rendering, for lfdln: catch-all, the host map, refused names from
the DreamHost zone; adding a static folder (G3b) and taking over the stopgap"). Builds on phase 2
(docs/adapters-plan.md: nginx rendered from the profile, `folderSubdomains: false` for lfdln) and
phase 3 (docs/permissions-plan.md: "on lfdln a place is a host, from phase 4").

What phase 4 is for: after it, a lfdln host (`<name>.lesfleursdelanuit.com`) is a row the panel
keeps, with routes that point at a target, and nginx is rendered from those rows by a helper that
checks with `nginx -t` before anything goes live. Site folders are made on purpose and served only
once a route points at them (F1). pammy.org is unchanged: its subdomains stay folder-linked.

## What was found (2026-09-25)

- **The stopgap** (`/etc/nginx/sites-enabled/lesfleursdelanuit-wildcard`, live since 2026-09-23):
  a regex server for one label under lesfleursdelanuit.com (never `www`), root
  `/var/www/lesfleursdelanuit-sub/$sub`, static only, hidden files denied, the wildcard
  certificate. A folder there is public as soon as it exists. **The only folder is `hello/`**
  (one 224-byte `index.html`, root's), which G3b says is deleted, not adopted.
- **Exact names win over the regex** in nginx, so tutor., instastylr., www. and the apex keep
  their own blocks; so would any exact-name block the panel writes.
- **nginx is already rendered from the profile** (`@panel/core/nginx`, phase 2), with a byte-for-
  byte check for pammy.org and an lfdln-shaped test profile (`test/fixtures/lfdln-profile.ts`)
  that goes through a real `nginx -t` in run-nginx-test.sh.
- **The software helper already writes nginx safely** (`packages/apps`, root, one capability):
  stage every file, `nginx -t`, put everything back if nginx says no, then reload. The routing
  helper can be that pattern, for its own directory only.
- **The gate's contract** (`X-Pammy-Base: /<folder>`, `X-Pammy-Uri`, `Host`) already allows a
  routed host whose folder sits under one root (adapters plan A5): no second mode in the gate.
- **DreamHost** (`~/lesfleursdelanuit-setup/dreamhost-dns.sh list`): the zone's records through
  the API, the key in `/etc/letsencrypt/dreamhost-api.key` (root, 600), sent in the POST body.
- **Nothing for lfdln runs on the server yet**: no panel, Postgres, gate or helpers. They come in
  phase 5. So phase 4 builds and tests; the first live host is phase 5's (H10).

## Proposal

- **H1. A new module, `hosts`** (on for lfdln, off for pammy.org, whose profile doesn't list it).
  Its schema, in the module's own migrations:
  - `hosts (id, name, created_by, created_at, enabled)`: a full name, one label under
    `lesfleursdelanuit.com` in phase 4 (other domains need their own certificates: phase 7).
  - `routes (id, host_id, path, target_kind, target_id, options, enabled, created_by, created_at)`:
    `path` is a prefix (`/` by default), unique per host; `options` holds the switches below.
  - `site_folders (id, name, run_php, created_by, created_at, adopted)`: the folder on disk.
- **H2. Targets in phase 4: a site folder, or a redirect.** A service (a port on 127.0.0.1,
  reverse proxied) arrives with phase 6, when TutorStar and Gonsalves are adopted; installed
  software and database apps with their modules (phase 8). The table has room for them; the page
  offers only what exists.
- **H3. One server block per host**, each with its exact `server_name` and the wildcard
  certificate, written by the routing helper into `/etc/nginx/lfdln-hosts/<name>.conf`; plus one
  catch-all for every other `*.lesfleursdelanuit.com` name that answers a plain 404 page (not a
  TLS error). This departs from G3's "one server with a map": separate blocks keep each host's
  routes (and later its gate and PHP locations) readable, reload only what changed, and use
  nginx's own exact-name rule instead of a map lookup on every request.
- **H4. A route to a site folder** renders: `root` at the folder, `try_files $uri $uri/ =404`,
  `index index.html`, hidden files refused, no listings, the folder's own `404.html` if it has
  one; **Run PHP pages** (on by default, F5) sends `.php` to pammy-php's sandboxed pool when the
  PHP module is on; **Single-page app** (off by default) serves `index.html` for unknown paths.
  The gate's `/_pammy/` include and `X-Pammy-Base: /<folder>` are rendered in, so phase 8's
  forms, comments and protected areas work on it without changing these files.
- **H5. A redirect route**: to another host, path or `https://` address, 301 or 302 (chosen),
  keeping the rest of the path or not (chosen).
- **H6. Refused names**: `panel`, `www`, `api`, `mail`, any name with its own record in the
  DreamHost zone (webmail, ftp, ...), and any host already used. The zone is read by the routing
  helper (root, the key stays where it is) and kept for 10 minutes. If it can't be read, **a new
  host is refused** until it can (Q3).
- **H7. The routing helper, `lfdln-routes`**: root, like the software helper, but it may write
  only `/etc/nginx/lfdln-hosts/` and read the DreamHost key; it runs `nginx -t` and
  `systemctl reload nginx`. It takes the whole table from the panel, renders every file, stages,
  tests, and puts everything back if nginx refuses, so a bad route never reaches live sites. The
  panel never writes nginx itself.
- **H8. Site folders** (G3b): made by the folder helper (the one pammy.org calls pammy-sitefs,
  with lfdln's root `/var/www/lesfleursdelanuit-sub/` and its own service user, D3), mode 2750,
  group `lfdln-sites` for SFTP (F3). **Add a static folder**: name, where it shows
  (`<name>.lesfleursdelanuit.com` by default, a path on an existing host, or not yet), start with
  a placeholder page or a `.zip`. Start/Stop turns its routes on or off; Delete removes the routes
  first, then puts the folder in the trash for 30 days (as pammy's 4c).
- **H9. Places are hosts** (permissions R5): a person kept to places on lfdln sees and changes only
  their hosts' routes and the folders those routes serve; making a host is `wholeSite`. `hosts`
  joins `PLACE_RIGHTS` under a new right, `hosts`. pammy.org keeps `subdomains`.
- **H10. Taking over the stopgap happens when lfdln's panel stands up (phase 5)**: its install
  deletes `hello/`, disables `lesfleursdelanuit-wildcard`, and puts in the rendered catch-all and
  host blocks. Any folder that appears in `/var/www/lesfleursdelanuit-sub/` before then is
  adopted as a site folder routed at its own name, so nothing that works stops working (Q1).

## Not in phase 4

- Hosts on other domains and the apex, and their certificates (phase 7; the apex and instastylr
  are adopted in place in phase 6).
- Services, installed software and database apps as targets (phases 6 and 8).
- Protected areas on routes, forms and comments on site folders (phase 8; H4 leaves them room).
- The File Explorer on site folders (phase 8); before then a folder is filled from a `.zip` or
  over SFTP (F3).

## The net

- pammy.org: the same routes, schema, verify (549 + 62) and nginx files, byte for byte (the
  module is off for it).
- lfdln-shaped: the rendered files through a real `nginx -t` and real requests in the nginx test
  harness: a folder's placeholder answers 200; `.git/config` 403; `..` and a symlink out 404; a
  stopped route 404, started 200; PHP runs only with its switch on; a single-page app's unknown
  path gives `index.html`; a redirect keeps or drops the path as chosen; an unknown name gets the
  plain 404, never a TLS error; a refused name is refused; a route nginx rejects leaves the files
  as they were.
- The routing helper's sandbox checked like the other helpers' (writes only its directory).

## Steps (one release each; each goes live on pammy.org only as "nothing changed")

1. **H1 + H3 + H4 + H5**: the module's schema and the rendering (pure functions), tested through
   a real nginx.
2. **H6 + H7**: the routing helper (stage, test, roll back, reload) and the zone read, with its
   sandbox.
3. **H8 + H9**: site folders in the folder helper, the Hosts and Site folders pages and routes,
   the `hosts` right.
4. **H10**: the stopgap takeover, written into phase 5's installer (run there, not here).

## Step 1, as built (2026-09-25)

- **`packages/hosts`**: `migrations/0001-hosts.sql` (`panel.hosts`, `panel.site_folders`,
  `panel.routes`, with the name and path rules as checks), `src/names.ts` (host, folder, path,
  redirect address and status), `src/render.ts` (the table to every file's text), `src/config.ts`
  (the renderer's settings from a profile). The module is `hosts` in `MODULES`, needing only the
  core; **pammy.org's profile leaves it off**. Every package's migrations run on every site, so
  pammy.org's database gets the three tables too, empty (as it has every module's tables): its
  schema snapshot grows by three tables and verify counts them from the snapshot as before.
- **The profile's `hosts`**: `dir` (`/etc/nginx/lfdln-hosts`), `sitesRoot`
  (`/var/www/lesfleursdelanuit-sub`) and `tls` (the wildcard, Let's Encrypt's include and dhparam),
  in the lfdln-shaped test profile; lfdln's real one is phase 5's.
- **Files**: `site.conf` (the two includes sites-enabled will point at), `catch-all.conf` (any other
  `<name>.lesfleursdelanuit.com`: http to https, then the plain 404; never `www`), `hosts/<name>.conf`
  (only for a host switched on with a route on), `pages/_lfdln/404.html`.
- **Changed from H4: no gate yet.** The pammy.org `gate.conf` brings PHP for the whole server and
  pammy's media rewrite with it, and the gate's features only come to lfdln in phase 8. So a host
  block has no `auth_request` in phase 4; PHP is handled inside each folder route, by the folder's
  own **Run PHP pages** switch (on: `.php` to pammy-php's pool; off, or no PHP module: 404, never
  text). The gate goes in with phase 8, in the renderer only (the helper renders everything from
  the table on every change, so no data moves).
- **A folder at a path** (`/docs/`) is served with `alias`, and `/docs` goes on to `/docs/`. The
  folder's own `404.html` is used for a folder at the top of a host; a folder at a path gets the
  plain one.
- **Safety found on the way**: nothing is served through a symlink inside a folder
  (`disable_symlinks on from=$document_root`); a redirect "path" starting with `//` is refused
  (browsers read it as another site); a redirect to a path inside its own route is refused (it
  would loop forever); every name, path and address is checked again by the renderer.
- **Tests**: `test/hosts.test.ts` (11: the rules and the renderer) and
  `test/run-hosts-nginx-test.sh` (49, in build.sh: a real nginx, requests to every kind of route:
  folder pages, index and slash redirects, `.git`/`.env` 403, symlink and `..` refused, the folder's
  own 404, PHP 502 with the switch on and 404 with it off or `.PHP`, a single-page app, two folders
  and two redirects on one host, 301 with the path and query kept, 302 without, a host switched
  off, a stopped route, an unknown name, two levels deep, and the renderer refusing eight bad
  tables).

## Step 2, as built (2026-09-25)

- **The runner moved to the core** (`@panel/core/runner`): `systemdRunner('<helper>')` names each
  unit `<helper>-<what>-<random>`. The software helper keeps a thin `runner.ts` over it, with its
  units still named `pammy-apps-...` (its tests unchanged).
- **The routing helper** (`packages/hosts/src/helper/`): four operations over its socket, one JSON
  request each (`@panel/core/jsonline`, up to 1 MB so a big table fits):
  - `apply {table}`: the table's shape checked, every file rendered (`render.ts` checks every
    name again), only what changed written, host files no longer wanted removed; `nginx -t` as a
    root unit; if nginx says no, every file put back exactly as it was (new ones removed) and the
    request refused with nginx's first line; if yes, `systemctl reload nginx` as a root unit. The
    same table again writes nothing and asks nginx nothing. One apply at a time.
  - `check-name {name}`: refused if it isn't a host name or is one the server keeps (`invalid`),
    if it has a DNS record of its own at DreamHost (`exists`), or while the zone can't be read
    (`unavailable`, Q3). The zone is `dreamhost-dns.sh list` (certbot's copy in
    `/etc/letsencrypt/dreamhost-hooks/`), run as a root unit, so the key never enters the helper.
    A label is taken if any record sits under it; the wildcard and `_acme-challenge` don't count; a
    listing without the apex counts as a failed read. Kept ten minutes, never used once stale.
  - `zone` (the labels taken, for the page) and `status` (the hosts with a file).
  - The zone isn't checked on `apply`: hosts already there keep working whatever DreamHost says
    (Q3); the panel asks `check-name` before it makes a host (step 3).
- **Its units** (`packages/hosts/deploy/lfdln-routes.{service,socket}`, installed in phase 5):
  root with **no capabilities**, **no network** (`PrivateNetwork`, `AF_UNIX` only: the system bus),
  `ProtectSystem=strict` with only `/etc/nginx/lfdln-hosts` writable, `/etc/letsencrypt` and the
  sites' folders out of sight; the socket root:`svc-lfdlnpanel` 0660. `systemd-analyze verify`
  accepts it; phase 5's verify checks it running.
- **Tests**: `test/hosts-helper.test.ts` (13: apply, putting back, removal, one at a time, shape and
  name refusals, writing nowhere else, the zone's labels, check-name and its ten minutes, the
  socket with 1,500 hosts, the unit's sandbox lines) and 11 more in `run-hosts-nginx-test.sh`
  (now 60): the helper's own apply against a second real nginx, where a change `nginx -t` refuses
  (a certificate that isn't there) leaves the files byte for byte and the live host answering.

## Step 3, as built (2026-09-25)

Decided with momolig 2026-09-25: **a new folder starts with its placeholder page**; starting from a
`.zip` comes as a small step of its own later (a pure-JavaScript unzip library, fflate, and the File
Explorer's upload rules). Until then a folder is filled over SFTP (F3).

- **The panel's routes** (`packages/hosts/src/panel/routes/hosts.ts`, registered only where the
  module is on, so pammy.org has none of them; its route list gains only the `/hosts` page address):
  - `GET /api/hosts`: hosts with their routes and addresses, site folders with where they're shown
    and whether they're on disk; `GET /api/hosts/zone`: DreamHost's names, or why they can't be read.
  - `POST /api/site-folders` (**Add a static folder**): the name checked as a host first (the
    server's names, DreamHost's, the zone down: nothing made on disk), then the folder with its
    placeholder page (the folder helper), then, by default, the host of the same name with its `/`
    route. `host: false` makes the folder only. `POST /api/site-folders/:id` (Run PHP pages),
    `/:id/delete` (fresh passkey; refused for an adopted folder; its routes go first, then the
    folder to the trash for 30 days).
  - `POST /api/hosts` (a host with no routes yet), `/:id` (on or off), `/:id/delete` (fresh
    passkey; its routes go with it, its folders stay); `POST /api/hosts/:id/routes` (a folder or a
    redirect at a path), `POST /api/routes/:id` (started or stopped, single-page app), `/:id/delete`.
  - **Every change and nginx together**: the change, the whole table read back, and the routing
    helper's `apply`, inside one transaction. If nginx refuses, the transaction rolls back and the
    panel says why; a new folder whose host nginx refused goes to the trash, not left on disk.
  - Activity: `host-created/started/stopped/deleted`, `route-created/changed/deleted`,
    `site-folder-created/changed/deleted`, each with a sentence on the Activity page.
- **The `hosts` right** (in `RIGHTS` and `PLACE_RIGHTS`, both sides). On lfdln **a place is a host**
  (`/docs`): the Accounts page offers hosts under "Only these hosts", and the server checks them
  against the hosts table. Someone kept to hosts sees only those hosts, their routes, and the
  folders those routes show; they may switch their hosts, add and change routes on them (a folder
  route only to a folder their hosts show already), and switch PHP for those folders. Making or
  deleting a host or a folder, and the zone, are `wholeSite`.
- **The page** (`packages/hosts/web/pages/Hosts.tsx`, `/hosts`, menu "Hosts" in the site-folders
  group; only where the module is on): Add a static folder (name checked as typed against the
  server's and DreamHost's names), Hosts (each with its routes, Add a route, Stop/Start, single-page
  app, Remove, Switch off, Delete), Add a host, Site folders (where shown, Run PHP pages, Delete).
- **Config**: `profile.services.sockets.routes` and `config.routesSocket` (`PANEL_ROUTES_SOCKET`).
- **Tests**: `test/hosts-panel.test.ts` (10: every lfdln route names what it needs; a panel built with
  the lfdln-shaped profile, a real folder helper and the real routing helper writing real files,
  with nginx stood in for so it can say no). Browser tests for lfdln's pages come with phase 5's
  lfdln site; the page was checked in a browser with the lfdln-built pages (desktop and phone, dark),
  no errors.

## Decided (momolig, 2026-09-25)

- **Q1. Built and tested now; live in phase 5.** The stopgap is taken over and the first host
  goes live when lfdln's panel stands up (H10). Until then each release changes nothing on
  pammy.org.
- **Q2. Site folders and redirects** in phase 4; services (a port on 127.0.0.1) with phase 6.
- **Q3. Refuse new hosts** while the DreamHost zone can't be read (existing hosts keep working).
