# Phase 8: the rest of pammy.org's modules on lfdln, pammy.org on hosts, visitors tagging

Status: **decided 2026-09-29** (momolig: "continue" = P8-1 to P8-14 as suggested); proposed the same day. Asked for by momolig: "start phase 8", and do
pammy.org on hosts (docs/domains-hosts-plan.md step 5) and visitors tagging
(docs/catalog-plan.md step 6) as part of it. Platform plan rows 8, 9 of "Order from here".
Questions P8-1 to P8-14 at the end; the suggestions are taken unless momolig says otherwise.

## What is on where (checked 2026-09-29)

- **lfdln** (`sites/lfdln/src/profile.ts:37`): hosts, php, services, catalog, mail, areas,
  people, requests, settings, monitoring.
- **Off on lfdln**: thumbs, files, media, api-keys, studio, forms, form-links, comments, apps,
  examples, help.
- **pammy.org**: everything but hosts, services, monitoring.
- Every package's migrations already ran on both databases (`pg-migrate.ts:57-65` runs them all,
  whatever is on), so **switching a module on needs no migration** of its own. New behaviour
  below brings a few.
- lfdln's `app.ts`, `server.ts` and web `App.tsx`/`menu.ts` are put together by hand: a module
  comes on by wiring its routes, timers and pages there, not only by the profile. The gate is
  the shared code and follows the profile (`isOn`).

## What stands in the way (the three audits, 2026-09-29)

1. **The gate is only on some of lfdln's hosts.** `/_pammy/` goes to lfdln-gate only on a host
   with a route with accounts (`hosts/src/render.ts:190-230, 442-446`), with a fixed
   `X-Pammy-Base "/"` and a 64k body limit. Forms, comments, media and the data API all live
   under `/_pammy/`, so today they would answer 404 on almost every host.
2. **The gate thinks in pammy.org's folders.** It finds a page as
   `public root + X-Pammy-Base + path` and protections by folder (`.pammy-protected`, folder
   areas). On lfdln a host shows a *route* to a site folder or a service, and protection is a
   *route area*. So:
   - a form's or a comment's page on `tutor.lesfleursdelanuit.com/contact.html` is looked for at
     `/var/www/lesfleursdelanuit-sub/contact.html`;
   - a service's page (Next.js) has no file at all, and comments refuse a page with no file;
   - **the media API would list photos from a folder behind a private route to anyone**
     (`media-api.ts:134-141` only knows folder areas). This must be closed before media is on.
   - `hostOf` only knows `<label>.lesfleursdelanuit.com`: gonsalvesfamily.com and tutorlumi.com
     hosts get `bad-host`.
3. **Studio's helper is written for Pamela's two engines**: ports 5433/3307 by default, both
   passwords needed, `pamela` protected, schema `public` only, no idea of a database the app
   owns. lfdln has one Postgres for apps (lfdln-appdb, :5436: tutorstar, ligneous_frontend,
   examprep in schema `prep`) and no MariaDB.
4. **Installed software (apps) is pammy.org through and through**: `/srv/pamela-apps`, runs as
   `pamela`, nginx includes inside pammy.org's own server block, placements as subdomains of
   pammy.org. Not something to switch on.
5. **Examples and Help are Pamela's**: her guides, her projects, fixture forms, tutorials on
   panel.pammy.org. They need files, forms, comments and apps on. Forms' Starters and Studio's
   example guard lean on them.
6. **File Explorer and Hosts both touch site folders.** Hosts keeps the record
   (`panel.site_folders`) and makes/trashes folders through the helper; File Explorer at the top
   could make, rename or trash one behind its back. And a *place* on lfdln is a host, in File
   Explorer a folder.
7. **pammy.org on hosts**: the live `pamela` site (source: `~/pamela-setup/wordpress/pamela-live-wp.nginx`,
   byte for byte; the plan named `pamela-live.nginx`, which is out of date) has what no route
   kind makes yet: `gate.conf` (nested protected folders by path, `$pammy_base` per folder, the
   2m data-API location, `media/photos` → `media/images`, `@pammy_login`), the folder 404 rule,
   `/api/` → pamela-app :3042 with websockets, `pammy.org/<folder>/` on the main host, and
   pammy.org's own certificate renewed by certbot's **nginx plugin** (it edits the vhost: the
   Gonsalves trap, 7-3). No `pammy-routes` helper exists.
8. **Visitors tagging** is designed in outline only (catalog-plan C8/C9): the schema can't hold
   it (`catalog.links` key is `(item_id, label_id)`), no privilege `catalog.tag` exists, the
   gate can't read `catalog.*`, lfdln has no Inbox, and no app needs it yet (exam prep says
   `visitorLabels: none`).

Items 1 and 2 are **one piece of work** that media, forms, comments, the data API, visitors
tagging and pammy.org on hosts all need. It comes first after File Explorer, as its own step.

## The steps

Each step is a release of both panels (pammy.org's behaviour unchanged unless the step says so),
with its verify checks, installed on its own.

| # | What | Risk |
|---|---|---|
| 8-1 | **Thumbnails + File Explorer on lfdln** | low |
| 8-2 | **The gate on every lfdln host** (no new module seen) | medium: every host's nginx |
| 8-3 | **API keys + Media folders on lfdln** | low |
| 8-4 | **Studio on lfdln** (the helper for more than Pamela's engines, databases the app owns) | medium |
| 8-5 | **Forms on lfdln** (+ Settings > Email, the notices) | low |
| 8-6 | **Form links + Comments on lfdln** | low |
| 8-7 | **pammy.org on hosts** (hosts step 5), its own window | **high**: Pamela's live site |
| 8-8 | **Visitors tagging** (catalog step 6), both panels | medium |

Not in phase 8: Installed software on lfdln (P8-11), Examples and Help on lfdln (phase 9's
guides instead, P8-12), MariaDB on lfdln (P8-8), Projects (8b).

### 8-1. Thumbnails + File Explorer

Together, because File Explorer needs Thumbnails (NEEDS).

- **Thumbnails**: `lfdln-thumbs.{socket,service}` as user `svc-lfdlnthumbs`, group
  `lfdln-sites` for reading; `/var/www` shows only the site folders, read-only, `.trash` hidden.
  Its folder `/var/lib/lfdln-media-public/thumbs` (owner svc-lfdlnpanel, group svc-lfdlngate,
  2750; media's index goes beside it in 8-3). FACTS for thumbs gains the folder (today it is
  read from `mediaPublic`, so thumbs without media has none). Panel: `Thumbnailer`, clean, kick.
- **File Explorer**: one root, **Site folders**, over `/var/www/lesfleursdelanuit-sub` (the same
  `website` root and the same helper, `lfdln-sitefs`, it already runs; `.trash` never shown).
  Tags on files (the catalog is on), the editor with versions, uploads (100 MB), the 15-minute
  sync. The Everywhere routes registered once with both needs (today lfdln's `services` and
  pammy's `files` would clash).
- **The top belongs to Hosts** (P8-1): File Explorer refuses making, renaming and trashing a
  folder at the top on lfdln; a site folder is made and removed on the Hosts page, as now.
  Inside a folder, anything goes.
- **Places** (P8-2): someone kept to hosts sees, in File Explorer, the folders those hosts'
  routes show (`folderIdsOf`).
- **Addresses**: "Real page" and a file's public address come from the routes that show its
  folder (none: "Not shown anywhere yet"), not `https://lesfleursdelanuit.com/<path>`.
- Words: the pages' "your website" through `W` (FileEditor, MediaTags, home page, the helper's
  messages).
- The first sync reads and hashes every site folder (the apex and instastylr copies too): run
  it in the installer, timed.
- verify-lfdln: the thumbs sandbox, files-* through the panel's user, a save with versions, an
  upload through nginx, `.trash/.versions` modes.

As built (branch phase-8, 2026-09-29):
- **Profile**: lfdln turns on `thumbs` and `files`; `services.sockets.thumbs` = `/run/lfdln-thumbs.sock`,
  `services.mediaPublic` = `/var/lib/lfdln-media-public` (thumbs/ now, the media index in 8-3).
  FACTS.thumbs now also needs `services.mediaPublic` (the pictures' folder).
- **The folder helper** gets `hostsKeepTop` (lfdln's `sitefs.ts` sets it): File Explorer and the
  editor refuse making, copying, moving or uploading anything into the top, renaming, moving or
  trashing a site folder, and restoring into the top (its site folder gone). Hosts' own
  `create`/`trash` ops are untouched.
- **Places** (P8-2): `withFolderPlaces` (@panel/files/panel/files-ctx) wraps `need`/`authOf` for
  File Explorer's routes on lfdln: a person's host places become the folders their hosts' routes
  show; a host that shows none keeps them to `/.none` (nothing).
- **Addresses**: `GET /api/files/shown` (lfdln: each folder's addresses through its enabled
  routes, other domains too; pammy.org: `null`); `publicAddresses(path, reserved, shown)` and
  `useShown()` on the web. No route: no "Real page", no "Open", "Not on the internet" in the details.
- Found while testing, fixed for both panels:
  - The website's trash list and "Check for changes" were Media routes (`needs: media`), so File
    Explorer broke without media folders: `GET /api/files/trash` answers for the website too,
    and `POST /api/files/sync` (needs files) is the same sync as `/api/media/sync`.
  - Thumbnails (`/api/media/thumb/:id`) needed `media`: now signed-in with `files` or `media`.
  - People's "Can open" (protected folders) was shown wherever `files` was on: now where
    folders are subdomains (`SITE.folderSubdomains`), so not on lfdln.
  - File Explorer's folder pane starts hidden on a phone (it made the page 52px too wide).
  - Title/alt on a file's details only with media on (its route is Media's).
- Everywhere's labels on lfdln: seen with `services`, changed with `services` and `files`.
- lfdln's menu: Sites > File Explorer, File tags (the files' Tags page), Tags & categories.
- Deploy: `lfdln-thumbs.{socket,service}` (svc-lfdlnthumbs, lfdln-sites while running, the site
  folders read-only, `.trash` hidden, no network), `/var/lib/lfdln-media-public{,/thumbs}`
  (svc-lfdlnpanel, group svc-lfdlngate, 2750), panel.env `PANEL_THUMBS_*`, the panel unit may
  write the folder; the installer makes the user and folder, starts the socket, and checks the
  service's tools. verify-lfdln: the thumbnail service's sandbox, and File Explorer's ops on a
  scratch site folder (the top refused; inside: folder 2750, file 640, trash).

### 8-2. The gate on every lfdln host

No page changes; the groundwork for 8-3 to 8-8.

- **Every host with a route** gets `/_pammy/` to lfdln-gate (P8-3), as pammy.org's hosts have
  it: the 64k body, the 2m data-API write location, the login pages.
- **nginx tells the gate what the route is**: `X-Pammy-Route <id>` next to the base. The gate's
  snapshot gets the route table (host, path, target kind, folder, area), so it turns host +
  path into **a site folder and a path in it**, or **a service page** (no file).
  `X-Pammy-Base` becomes the route's folder (`/home` for the apex), so the folder code the gate
  has keeps working unchanged on lfdln.
- **Route areas in every "may this visitor see it" check** (media API, forms' signed-in-only,
  comments, data API): a folder behind a private route is private (P8-4). This closes the media
  hole before 8-3 opens the API.
- `hostOf` knows every domain in `panel.domains`, not only lesfleursdelanuit.com.
- pammy.org: nothing changes (no hosts); the same gate code, the route header absent.
- verify-lfdln: `/_pammy/login.js` on a folder host, a service host and a gonsalvesfamily.com
  host; a private route's folder refused through the gate; "nothing else sends to the gate"
  (`verify-lfdln.sh:701`) replaced by the new list.

**As built (2026-09-30).** Two things differ from the outline above, both simpler and safer:
- **The route table comes from the routing helper, not the gate's snapshot.** The helper
  writes `/etc/nginx/lfdln-hosts/gate-routes.json` in the same apply as the host files (put
  back with them if `nginx -t` says no), so nginx and the gate can never disagree about a
  route, whichever path applied it (the Hosts page, take-over, adopt-folders at every
  install). The gate (`@panel/core/gate/site-routes`) reads it again when it changes (and
  at least every 2 s), keeps the last good copy over a broken one, and with none fails
  closed (503). No migration, no admin op, nothing to sync.
- **No `X-Pammy-Route` header.** `/_pammy/` is one location per host, not per route, so nginx
  can't name the route a page is on; the gate finds it from Host + the page's path
  (`placeOf`). `X-Pammy-Base` is the site folder the host shows at its top (`/home` for the
  apex), `/` when that is a service or a redirect.
- Route areas enter every check through `resolve()` (policy.ts): a site folder shown by a
  route with accounts gets that route's area as a protection, so the media API, forms'
  signed-in-only and comments all follow it with no code of their own. A route's token the
  gate has no area for locks the folder. The data API has no folder or page (its databases
  are switched on one by one), so route areas don't enter it; 8-4 decides its lfdln side.

### 8-3. API keys + Media folders

Together, because a key covers nothing on lfdln until media (or forms) is on.

- `/var/lib/lfdln-media-public` (index + thumbs), `PANEL_MEDIA_PUBLIC`, the `Publisher`, the
  media pages and the API keys page with media's cover; CLI `media-sync`, `media-thumbs`.
- **No "main site" media folder on lfdln** (P8-5): a media folder is `<site folder>/media`;
  the apex's is `home/media`.
- Addresses in the API and the page from routes (8-1).
- Media examples: hidden while examples is off.
- Keys keep the `pammy_` prefix (P8-6).
- verify-lfdln: a real media folder through a real host, a private one refused, a key made and
  withdrawn, a key in the address refused.

**As built (2026-09-30).** As outlined, and:
- The folder helper refuses a media folder at the top where the top is Hosts' (`mediaSites`
  has no `""`, `media-create ""` and any `media/...` path are refused); a site folder can't be
  called `media` (the Hosts page and adopt-folders say why), so no top-level `media/` is ever
  mistaken for a main site's.
- The media API on a site with routes: `main/` answers 404, `example/` 404 while examples are
  off; a file's `src` is relative on a host whose route shows its folder, else the first host
  that does (home domain first), `url` the same host's full address, `subdomainUrl` null.
- The media examples' panel routes are only there with examples on; API keys' help links only
  with help on; a key made where forms are off is sent the narrower responses level (never
  asked for) -- the lfdln browser test found that one.
- `media-sync` / `media-thumbs` moved into `@panel/media/cli`, shared by both command lines.
- The data API's route areas: still 8-4.

### 8-4. Studio on lfdln

- **Engines** (P8-7): lfdln-appdb (:5436) is lfdln's Postgres for the Studio. New databases made
  in the Studio go there, beside the apps'. No MariaDB (P8-8): the helper and pages work with
  one engine.
- **The helper per site**: ports, passwords, forbidden ports (5432-5435, 3307 on lfdln),
  protected names and the users that may create come from its config, not Pamela's; no
  default that points at her engines.
- **Databases the app owns** (P8-9, G8): tutorstar, ligneous_frontend, examprep are marked
  *managed by the app* (migration studio/0003). The helper refuses changing their structure,
  rows, logins and keys; the Studio shows them read-only; the Studio's role on them has SELECT
  only (grants per database, not ownership). Schemas other than `public` are shown (examprep's
  `prep`).
- Units `lfdln-pammydb.{socket,service}`, user `svc-lfdlnstudio`, a clients group for the panel
  and the gate, the studio role + its `pg_hba` lines on appdb (the data-move plan's "the net"
  widened by exactly that role), `GATE_PAMMYDB_SOCKET`, the gate's PHP socket so PHP in site
  folders can use the data API.
- The record keeper (tables as catalog sources) and its timers.
- The "who may see this app" picker lists route areas on lfdln (today `/api/protected`, folders).
- `db-password.tsx`'s ports from the page's facts; "ask momolig"/"her" words through `W`.
- verify-lfdln: a port of verify-panel's Studio part (sandbox, forbidden ports, a database made
  and dropped, a login, the data API through a host) plus: an app's database can't be changed.

**As built (2026-09-30).**
- **The helper per site**: `@panel/studio/pammydb/config` takes a `HelperSite` (engines and ports,
  forbidden ports, login, name rules) and has no default of its own; `start.ts` starts a helper
  with one. pammy.org's is `PAMMY_HELPER` (its entry is still `src/pammydb/main.ts`), lfdln's
  `sites/lfdln/src/studio-site.ts` (Postgres :5436 only; 5432/5433/5434/5435/3307 refused).
  Drivers are a partial map: a site with one engine never offers the other.
- **The apps' databases** are named in lfdln's rules, each with its schema (`examprep: prep`),
  **not in a migration** (the plan's studio/0003): the helper is what enforces it, so it is what
  knows. `checkChangeable` refuses structure, rows, logins and dropping; the list marks them
  `appOwned`; the pages show "a service's: read only", a "Look inside" section, and a note on
  their tables pages. The Postgres driver opens such a database with its schema on the
  search_path and reads its tables from there.
- **lfdln-appdb**: `appdb/studio.sql` (the `pammy_studio` login, CREATEDB CREATEROLE only,
  CONNECT on `postgres`), `appdb/studio-reads.sql.in` (CONNECT, USAGE, SELECT on each app's
  schema), one pg_hba line; run by `install-appdb.sh` (step 5c), which also copies the password
  to `/etc/lfdln-panel/db/studio-postgres.pass`. Nothing about the apps' roles changes; the
  move-db test proves it on a real Postgres 17. Run order: install-appdb.sh, then install-lfdln.sh.
- **Who may see an app's records** (the picker): `/api/databases/visitor-areas`, from the gate's
  areas -- a protected folder's people on pammy.org, a route's with accounts on lfdln.
- **Database users on lfdln** (P8-15, decided (a) 2026-09-30 after 8-4 was installed, shipped as
  8-4b): every login the Studio makes there is named `db_...` (the site's `userPrefix`; the helper
  manages no other, the panel says so before asking), and lfdln-appdb's pg_hba admits exactly
  those -- after rejecting them outright on the apps' databases, `postgres` and `template1`, so no
  grant can ever open an app's data to one. Proven on Postgres 17 in the move-db test.
- The password dialog's ports come from the profile (`services.studioPorts`). "Service", not
  "app", for the apps' databases (the glossary's app is the database app).

### 8-5. Forms

- Forms and Settings > Email (who gets the notices), the `Notifier`.
- A form's scope on lfdln is **a site folder** (P8-10); a form on a service's page has scope
  "anywhere" (a service has no folder).
- Starters don't need the examples module (the gate's `examples.state` split from `starters`).
- The preview frame and the "put it on a page" address use a host that shows the form's folder.
- Keep `<pammy-form>`, `/_pammy/forms.js` (P8-13).
- `verify-lfdln.sh:658` (forms refused) turns into a real form sent through a host.

**As built (2026-09-30).**
- The gate places a form's page by the route it is on (`pageTarget` with the host, 8-2's
  `placeOf`): a path in the site folder that route shows, or a service's page, which has no file
  and so takes only a form that works anywhere (and no signed-in-only form: nobody is known to be
  signed in to a page with no folder).
- The panel: `/api/forms/starters` (the gate's `starters`, no examples needed) and
  `/api/forms/scopes` (the folder helper's list: site folders on lfdln) in place of `/api/examples`
  and `/api/sites` on the Forms page; the worked examples' routes only with examples on; forms
  and responses kept to the folders a person's hosts show (8-1's folder places).
- Settings > Email on lfdln: the notices and the test only (`mail` routes with `sending: false`);
  the key and addresses are the installer's, and the page says so. The `Notifier` runs on lfdln.
- The preview frame needed nothing: it is `/_pammy/form-preview` on the apex, which has the gate
  since 8-2, framed only by panel.lesfleursdelanuit.com.
- Not yet: the Inbox counts in lfdln's menu (pammy.org's `useWaiting`); comments (8-6). (Both done in 8-6.)

### 8-6. Form links + Comments

- Form links: routes only; the gate reaches the Studio through 8-4's socket.
- Comments: a page is a folder page (8-2 finds its file) or **a service page by its address**
  (no file to check: the comment area names the host and path; P8-10).
- verify-lfdln: an answer lands in a table; a comment on a folder page and on a service page.

**As built (2026-09-30).**
- lfdln's profile turns on `form-links` and `comments`; the panel wires their routes (kept to
  places as forms are, 8-1's folder places) and pages. With the comments routes come the data
  API's switches and keys for a Studio database (on pammy.org they live there too). The apps'
  own databases are never a target: the Studio manages none of them (P8-9).
- **A service's page** (the gate's `placedAt`): no file, so it is known by its address -- its
  page and thread are `https://<host><path>` (no file's path starts so). Its route's area
  protects it as nginx's `/check/<token>` does (a private route: only people let in read or
  write its comments; a token the gate doesn't know locks it). A comment sent from there is left
  out of a shared thread (content-id) for anyone who may not open it (`pageResolved`, which finds
  the page again from its stored name; a page whose route has gone is opened by nobody).
- The same target serves forms: a service page still takes only an anywhere form (8-5), and now
  one for signed-in people only where its route has accounts and the visitor is signed in.
- `comments.example` is the examples module's request, not every site's with comments.
- **The Inbox on lfdln** (the counts left over from 8-5): Responses, Comments and Requests at the
  top of the menu with their red numbers; `useWaiting` moved to `@panel/core/web/hooks`.
- The gate reaches the Studio's helper through 8-4's socket (lfdln-pammydb-clients); nothing
  new to install.
- verify-lfdln: a comment on a site folder's page (kept on its file's conversation), one on a
  TutorStar page (kept and read by its address), and the gate writing a row into a Studio
  database through the helper, refused on an app's.

### 8-7. pammy.org on hosts (docs/domains-hosts-plan.md step 5)

Its own window, after 8-2 to 8-6 have run the gate-in-hosts code on lfdln.

- `pammy-routes` (the same helper as `lfdln-routes`), `/etc/nginx/pammy-hosts/`, pammy's profile
  gains `hosts` (not `services`, `monitoring`).
- **The renderer learns what `gate.conf` does** for pammy.org: folder protections by path
  (nested `.pammy-protected`), `$pammy_base` per folder, `media/photos` → `media/images`,
  `@pammy_login`, the folder's own 404 then the site's; and `pammy.org/<folder>/` on the main host.
- **`/api/` → pamela-app :3042**: a small **proxy** route kind (a port, websockets on) without
  the services module (P8-14).
- **Certificates**: the Cloudflare origin wildcard for every pammy.org name; certbot's
  pammy.org certificate retired (no more nginx plugin edits).
- Rows seeded from her top-level folders, `blog` → the software kind (WordPress's include
  becomes the apps module's route kind), `@` with `www`; folder hosts on with the fallback and
  the sync; the `pamela` site taken over and the hand-kept file retired.
- The Subdomains page on the hosts API (still called Subdomains), the `subdomains` right → `hosts`.
- Cloudflare zone: manual, no key (the open point in domains-hosts-plan, line 444).
- Fixed first (7-6's "later"): a check kept 10 minutes outliving the route that fixed it; the
  Add a host notice for a route-less `@`/www.
- **The switch check**: every folder (listed live by the helper) and every address verify knows,
  asked before and after; any difference puts the old `pamela` site back.

#### 8-7 in detail (DECIDED 2026-09-30: momolig took all three suggestions -- 8-7a and 8-7b now, 8-7c in a window of his; WordPress's placement stays on the Installed software page, which writes the blog's route; pammy.org and www on Cloudflare's origin certificate, certbot's deleted 14 days after the switch)

What pammy.org's nginx is today (read from the live files, 2026-09-30): the `pamela` site
(`wordpress/pamela-live-wp.nginx`, byte for byte the live one) with two server blocks and three
includes -- `pammy-gate/gate.conf` (+ `uri.conf`, `php.conf`), `pammy-wordpress/main.conf` and
`server.conf` (written by the apps helper).

- **pammy.org and www**: root `/pamela/public` (the whole website, every folder at
  `/<folder>/`), every file asked of the gate (`/_pammy/check`, `X-Pammy-Uri` + base `/`:
  nested protected folders by marker and by path), `/_pammy/` to the gate (64k, the 2m data-API
  writes), `media/photos` → `media/images` (301), PHP through pammy-php with `PAMMY_*` from the
  gate, `/api/` → pamela-app :3042 (websockets, no gate), a folder's own 404.html then hers,
  `.well-known` open, dot-files denied. Let's Encrypt certificate by certbot's nginx plugin.
- **Any `<label>.pammy.org`** but www/api (one regex block): root `/pamela/public/<label>`, the
  same gate with base `/<label>`, the folder's 404 then hers. Cloudflare's origin wildcard (it
  covers `pammy.org` and `*.pammy.org`; every name is proxied).
- **blog.pammy.org**: WordPress's own block (server.conf), proxied to :3043, xmlrpc refused.
- panel.pammy.org is its own site (`pammy-panel`) and stays so.

**Sub-steps** (each a release of both panels; only 8-7c changes what pammy.org serves):

- **8-7a. The renderer learns pammy.org** (nothing live changes).
  - A site setting `folderGate` (pammy.org's profile): every location that serves files asks the
    gate's `/check` with the path about to be served and the host's base, as `gate.conf` does,
    so nested protected folders keep working exactly as now (route areas stay lfdln's).
  - A **whole-website** route kind (`site`): the site folders' root at a host's top, each folder
    at `/<folder>/` with its own 404.html then the site's, the `photos` → `images` redirect.
  - **Folder hosts** (the domain's `folder_hosts`, greyed out until now): the domain's catch-all
    serves `<label>.<domain>` from the site folder of that name (base `/<label>`), 404 when there
    is none -- a folder she uploads is at its subdomain at once, as today. www, api and the
    reserved names never.
  - A **proxy** route kind (P8-14): a port on 127.0.0.1, websockets, no gate (`/api/` → :3042).
  - A **software** route kind (the apps module's): WordPress at a host's top or a path, to its
    port through its proxy file, xmlrpc refused. The apps helper stops writing main.conf and
    server.conf once pammy.org is on hosts (8-7c); until then, both.
  - PHP with the gate's `PAMMY_*` (pammy-php's socket).
  - **Proof**: an nginx harness (as `run-adopt-nginx-test.sh`) that serves one fixture tree --
    nested protected folders, markers the database doesn't know, PHP, 404s at every depth,
    photos, dot-files, symlinks, a WordPress stand-in, an /api/ stand-in -- through the live
    `pamela` file and through what the renderer makes of the rows, and compares every answer.
  - **As built (2026-09-30).** `packages/hosts/src/folder-gate.ts`: with `folderGate` (pammy's
    `hostsConfigOf`, `sites/pammy/src/hosts.ts`) a host's block is the hand-kept file's shape --
    both ports in one block, the gate's own snippets included with the host's base, the whole
    website (`site`), a folder host (the folder kind, only at a host's top here), the folder
    catch-all (`folderHosts` on the domain row), the proxy kind, and hosts with neither (the
    blog) with no gate at all. The regexes in the hand-kept order. No `disable_symlinks` (the
    gate looks at the real path, as now), no route accounts, no gate-routes.json. The software
    kind is **pammy.org's** (`sites/pammy/src/software-kind.ts`), not the apps package's: apps
    may not depend on hosts, which would force hosts on wherever apps is. The logs keep their
    names (`pammy.access.log`). pammy's profile has its `hosts` facts (the module is still off).
  - **Proved**: `VHOST=hosts test/run-gate-nginx-test.sh` runs the gate harness's checks (167;
    the whole-site WordPress ones are left out) against the rendered hosts, then runs the
    hand-kept file beside them in front of the same gate, PHP and website and asks both 2,880
    requests (every file and folder of the fixture site plus the tricky paths, on eight names,
    signed in and not): the same status, redirect, cache header, type and body every time. (It
    needed a default server for names no block serves -- on the server, default-443 and lfdln's
    catch-all answer those, loaded before both files.) Unit: `test/pammy-hosts.test.ts`.
- **8-7b. `pammy-routes` and the rows** (installed, not switched on).
  - The routing helper for pammy.org: `pammy-routes.{socket,service}`, `/etc/nginx/pammy-hosts/`,
    written and `nginx -t`'d but not in sites-enabled.
  - pammy's profile gains `hosts`. Rows: the domain pammy.org (Cloudflare in front, DNS by hand,
    the origin wildcard, folder hosts on); `@` with www → the whole website + `/api/` → :3042;
    `blog` → software; a host per top-level folder, made and removed by the 15-minute sync (so
    the Subdomains page can show and change them; the catch-all serves them anyway).
  - The Subdomains page on the hosts API (still called Subdomains); the `subdomains` right
    becomes `hosts` (a migration: whoever has one gets the other; places kept).
  - The Installed software page's placement writes the blog's route.
  - **As built (2026-09-30), narrower on purpose.** The hosts **module stays off** in pammy.org's
    profile: turned on, the gate would wait for a routes file pammy.org never writes (and fail
    closed), an account's places would be read as hosts, and a Hosts page would appear.
    pammy.org uses the module's renderer and routing helper as its nginx only
    (`sites/pammy/src/nginx-hosts.ts`, `WITH_HOSTS`):
    - `pammy-routes.{socket,service}` (deploy/): lfdln's unit with its own name, folder
      (`/etc/nginx/pammy-hosts`) and socket group (svc-pammypanel); the helper takes a site
      (`RoutesSite`: unit name, settings, no DNS zone -- a new name is refused only if the
      server keeps it -- and the one hand-written link it may take over, `pamela`).
    - `pammy-panel hosts-seed` (the installer): the home domain from the profile (folder hosts
      on, the origin certificate), `@` with www → `site` + `/api/` → proxy :3042, and the
      software routes; the files written; then `nginx -t` on a copy of nginx.conf that includes
      them in place of sites-enabled. Not linked.
    - The software routes **follow the software helper's list** (`followSoftware`: every minute
      in the panel, and `pammy-panel hosts-apply`), since placements change inside the helper's
      jobs: "subdomain x" → host x, "path x" → pammy.org/x/, root and off → none; a refusal puts
      the rows back. After the switch a move shows in nginx within a minute.
    - verify-panel: the unit and socket, the rows, the blog's route, the catch-all, `nginx -t`
      on their own, and still not live.
  - **Moved to 8-7d** (after the switch; the catch-all already serves every folder): a host row
    per top-level folder and its sync, the Subdomains page on the hosts API, `subdomains` →
    `hosts`.
- **8-7c. The switch** (its own window, momolig's). `pammy-panel take-over-host pammy.org`:
  every folder (listed live by the helper) and every address verify-panel and
  verify-pamela-access know asked before; the `pamela` link out and `pammy-hosts` in, one
  `nginx -t`; the same asked again; any difference, and the old link is back. Then certbot's
  pammy.org certificate stops renewing (deleted 14 days later, as lfdln's old ones).

  - **As built (2026-09-30).** `sites/pammy/src/switch.ts`, run by
    `install-panel.sh --switch-to-hosts` (`pammy-panel switch-to-hosts`): the questions are every
    top-level file and folder (the folder helper's files-list, live) and up to 25 files and 25
    folders directly inside each, on pammy.org and www, and each folder's own name; the 404s,
    `/.env`, `/api/`, the gate's addresses, http as well as https; the blog on its name; a name
    no folder has. Asked twice before (what differs between the two isn't compared by its
    bytes); the routing helper takes the pamela link out and links `pammy-hosts` in
    (`ownLink`, pammy-routes only) in one nginx -t; asked again for up to 10 s; any difference
    and both links go back as they were. Then certbot's `pammy.org.conf` renewal goes to
    `/etc/letsencrypt/renewal-off/` (delete the certificate 14 days later). A given-back switch
    leaves the release in and exits 3 after the checks. `--switch-back` is the way back by hand
    (the renewal file comes back too).
  - Proved in the gate harness (VHOST=hosts): a nginx laid out like the server's, TLS on both,
    the blog on its subdomain, the real routing helper: a switch made to differ (its /api/
    elsewhere) given back with both links as they were; the real switch with all 182 answers
    the same; "already"; back by hand; again.
- **8-7d. After the switch**: a host row per top-level folder (made and removed by a sync), the
  Subdomains page on the hosts API (still called Subdomains), the `subdomains` right → `hosts`,
  the Installed software page refusing "the whole website" while pammy.org is on hosts.
  - **Switched 2026-09-30 23:27 UTC** (8-7c): 316 answers the same before and after; verify
    617/617. certbot's pammy.org certificate is to be deleted from 2026-10-14.
  - **Narrowed (momolig, 2026-09-30: "narrow now, rest later").** Written before 8-7b kept the
    hosts module off on pammy.org, three of the four no longer fit: the catch-all already serves
    every folder, so per-folder rows show Pamela nothing new; and the `hosts` right belongs to
    the hosts module, so on pammy.org it would vanish from Accounts. **Set aside** until
    pammy.org turns the hosts module on (if ever): the per-folder rows and their sync, the
    Subdomains page on the hosts API, `subdomains` → `hosts`.
  - **As built.** The whole website isn't offered to software while nginx doesn't read the
    pamela site (after the switch a move there would write WordPress's main.conf into a file
    nothing includes, and say it worked): the software helper's `Host.wholeSite`
    (`/etc/nginx/sites-enabled/pamela`, pammy's `helpers/apps.ts`); move and install refuse
    "root" without it, before anything happens; `list` says `wholeSite`, and the Move and
    Install pages offer "The whole of pammy.org" only when it is true. `--switch-back` puts
    the link back and with it the choice. A move or an install asks its new address through
    nginx until it answers, up to 90 s (`answerSoon`): its route is written by the panel's
    follow, now every 20 s, not by the helper's reload. verify-apps checks the flag against
    the link. Tests: apps-jobs (refusals, list), apps (answerSoon).

### 8-8. Visitors tagging (catalog step 6)

**DEFERRED 2026-10-01 by momolig.** Checked that day: no `pammy-panel.json` on the server has a
`catalog` section (exam prep's catalog side, S5-9, was dropped 2026-09-29) and pammy.org has no
app with a manifest, so visitors would have nothing to tag. Phase 8 is done without it; the
sketch below stays for when an app asks for visitor tagging. Next: phase 9 (guides), then 8b.

- **Privileges** `catalog.read`, `catalog.tag` (shared, moderated), `catalog.tag:own` (personal)
  are **built in** (P8-12b below), given in a role like any other, never more than the resource's
  `visitorLabels`.
- **The visitor's door is the gate's** (`/_pammy/catalog/…` on a host where the app has an area,
  after 8-2); the gate keeps a copy of what visitors may read (pushed, as `record_labels`) and
  queues their changes (as `record_touches`); the panel applies them.
- Schema (catalog/0005): `links` gets its own id, `personal`, `status` (shown/pending/declined)
  and who made it (panel user / app / visitor); `labels.owner_visitor` for personal names.
- **Tag suggestions** in Requests on lfdln and in the Inbox on pammy.org: approve / decline.
- The app's door gains `for: <account>`, the visitor's rules applying.
- Limits: 500 labels and 5,000 links per visitor, 60 changes an hour per account and per
  address; all of a visitor's labels and links go with their account.
- Proved with a fixture app, as step 5 was.

## Questions for momolig

- **P8-1.** On lfdln, File Explorer can't make, rename or trash a site folder at the top: Hosts
  does that. Suggested: yes (hosts keeps one record; merging site folders into Files, D-3, stays
  for later).
- **P8-2.** Someone kept to hosts sees in File Explorer the folders their hosts show. Suggested: yes.
- **P8-3.** `/_pammy/` on **every** lfdln host with a route, not a switch per route. Suggested:
  yes (a page anywhere can then hold a form; nothing is served that the gate doesn't allow).
- **P8-4.** A folder behind a private route is private to the gate's APIs everywhere, even when
  another public route shows it too. Suggested: yes (the safer reading).
- **P8-5.** No "main site" media folder on lfdln; the apex's is `home/media`. Suggested: yes.
- **P8-6.** API keys on lfdln keep the `pammy_` prefix. Suggested: yes (shared code, and keys
  are only ever checked by the panel that made them).
- **P8-7.** The Studio's Postgres on lfdln is lfdln-appdb (:5436), not a new engine. Suggested:
  yes (the data-move plan meant it; one engine to look after).
- **P8-8.** No MariaDB on lfdln for now (D1 said both). Suggested: yes; added when someone needs it.
- **P8-9.** The apps' databases (tutorstar, ligneous_frontend, examprep) are read-only in the
  Studio, enforced by the helper and by grants, visible to people with the `databases` right.
  Suggested: yes.
- **P8-10.** On lfdln a form's scope is a site folder, and comments work on service pages by
  address. Suggested: yes.
- **P8-11.** Installed software stays pammy.org's; WordPress on lfdln, if wanted, is a kind of
  service later. Suggested: yes.
- **P8-12.** Examples and Help stay off on lfdln; phase 9 writes lfdln's guides. Suggested: yes.
  **P8-12b.** The catalog's visitor privileges are built in, not declared by each app.
  Suggested: yes.
- **P8-13.** `<pammy-form>`, `<pammy-comments>` and `/_pammy/` keep their names on lfdln.
  Suggested: yes (the hosts renderer and the gate already reserve `/_pammy/`).
- **P8-14.** pammy.org's `/api/` to pamela-app becomes a plain **proxy** route kind, without
  the services module on pammy.org. Suggested: yes.
- **P8-15.** DECIDED (a), momolig 2026-09-30 ("Allow it"). (Asked while building 8-4.) Database logins made in the Studio on lfdln:
  lfdln-appdb's pg_hba admits only the apps' roles and the Studio's. Either (a) a pg_hba line for
  logins the Studio makes, by a name prefix it enforces (`db_...`), or (b) none for now and the
  Database users page stays off. Suggested: (b) until a program on lfdln needs one.
