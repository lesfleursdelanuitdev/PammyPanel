# Domains and hosts: one hosts concept for both panels

Status: **decided 2026-09-26** (momolig took every suggestion: D-1 to D-3 and the parts below);
steps 1-4 built 2026-09-27 on branch `hosts-7a` (see "Step N as built" under Steps). Follows docs/hosts-plan.md (phase 4, live on lfdln since 2026-09-25) and
docs/adopt-plan.md (phase 6). Grows into platform plan phase 7 (Certificates, DNS, Domains).

What this is for: pammy.org and lfdln give out addresses in two different ways, written into
each site's profile. pammy.org: a top-level folder *is* a subdomain. lfdln: a host is a row whose
routes point at folders, redirects and services. After this plan there is **one hosts module on
both panels**; how a domain hands out names, its DNS, its certificate and what is in front of it
are **settings of that domain**, chosen in a **setup guide** that says plainly what each choice
needs and checks it before anything goes live.

## Decided (2026-09-26)

| # | Decision |
|---|---|
| D-1 | **pammy.org's folder subdomains become host rows.** A new top-level folder makes a host with `/` → that folder, so Pamela's way of working stays the same; a folder host can then gain a redirect, a protected area or a second route like any host. The switch is checked address by address against today's. |
| D-2 | **Domains are part of the hosts module**, not a module of their own. Phase 7 (Certificates, DNS, Domains) grows it. |
| D-3 | **Site folders move to the Files side** (one kind of folder on both panels; hosts only point at them), but only when File Explorer comes to lfdln (phase 8). Until then only the table's owner changes. |
| D-4 | **Target kinds are a registry**: every module adds its own (folder, redirect, service, software, database app, later project); the hosts module owns none but redirect. A module that is off offers none. |
| D-5 | **A setup guide** comes with the hosts module: it fills in the domain's settings, checks each requirement, and says what is missing in plain words. |

## What there is today (checked 2026-09-26)

**pammy.org** (`folderSubdomains: true`):
- nginx is **hand-kept**, not the panel's: `/etc/nginx/sites-enabled/pamela` (source
  `~/pamela-setup/pamela-live.nginx`). One regex server
  `~^(?!(?:www|api)\.)(?<sub>...)\.pammy\.org$` serves `/pamela/public/$sub` with the gate
  (`X-Pammy-Base /$sub`), the Cloudflare origin wildcard certificate, a 404 fallback to the main
  site. The main server serves all of `/pamela/public`, so `pammy.org/<sub>/` works too.
- Cloudflare: wildcard record, proxied; the panel never reads the zone.
- **Nothing is stored**: a folder is a subdomain the moment it exists, including one Pamela makes
  over SFTP/WinSCP. The Subdomains page (`packages/files/src/panel/routes/folders.ts`,
  `web/pages/Subdomains.tsx`) makes, trashes and restores top-level folders and their temporary
  home page.
- Names: `SUBDOMAIN_RE`, `ALWAYS_RESERVED` (`www api panel media`) plus each WordPress placement
  (`packages/core/src/names.ts`). `blog.pammy.org` is WordPress through the software helper's own
  exact-name include (`/etc/nginx/pammy-wordpress/`, `placement: subdomain blog`).
- The rest of the files module reads "top-level folder = subdomain" (tag scopes, media folders,
  the media API's `folderSubdomains`, starter pages).

**lfdln** (`folderSubdomains: false`, docs/hosts-plan.md, docs/adopt-plan.md):
- `panel.hosts` (name or `@`, `with_www`, `enabled`, `adopted`), `panel.routes` (path → `folder`
  | `redirect` | `service`, with spa, headers, cache-forever, body size, websockets, sign-in
  paths), `panel.site_folders` (name, `run_php`, `adopted`; served only when routed).
- `lfdln-routes` (root helper) renders one block per host into `/etc/nginx/lfdln-hosts/` plus a
  404 catch-all, `nginx -t`, rolls back, reloads. New names are refused when reserved
  (`RESERVED_HOSTS`: `panel www api mail`) or a record in DreamHost's zone (read through
  `dreamhost-dns.sh`, 10 min cache; no new hosts while it can't be read).
- Certificate: the Let's Encrypt wildcard (DNS-01 via DreamHost's API). Front: direct.
- No gate in host blocks yet (hosts-plan step 1: `gate.conf` is pammy-shaped).
- **Where it lives: the site profile** (`hosts: { dir, sitesRoot, tls, signInZone }`, `front`,
  `folderSubdomains`): code, not data.

## The model

- A **domain**: a name the panel hands out addresses under, with its settings (below).
- A **host**: an address on a domain (the apex `@`, optionally with `www`, or `<name>`), with
  routes. Made by hand, made from a folder (folder hosts), or adopted.
- A **route**: a path on a host → a **target**, with its options and (docs/roles-plan.md) an
  **area**: protected, or open with accounts.
- A **target**: something a module can serve; the module renders its part of the server block.
- A **site folder**: a folder under the website's root that a route may point at (D-3).

## The parts

| # | Part | What it holds |
|---|---|---|
| 1 | **Domains** (new) | `panel.domains`: name; **DNS provider** (`cloudflare` \| `dreamhost` \| `manual`); **front** (`cloudflare` \| `direct`, its real-IP rules); **certificate** (`wildcard-dns` \| `per-host` \| `cloudflare-origin` \| `files`) and its paths; **wildcard record** (yes/no: does a new host need a DNS change); **folder hosts** (on/off: today's `folderSubdomains`, per domain); **zone readable** (last check). Moves `front`, `folderSubdomains`, `hosts.tls` out of the profile into data; the profile keeps only what the installer seeds. |
| 2 | **Hosts** | as now + `domain_id`, `origin` (`hand` \| `folder` \| `adopted`): a folder host is deleted with its folder, and trashed/restored with it. |
| 3 | **Routes** | as now + `area_id` (roles plan step 5) + `target_kind` / `target_ref` in place of one column per kind (the checks move into each kind). |
| 4 | **Target kinds** (D-4) | a registry in `@panel/hosts`: each kind gives its label, its form fields, its checks, and its nginx part. `folder` (files), `redirect` (hosts), `service` (services), `software` (apps: WordPress's include becomes a route), `database-app` (studio, later), `project` (phase 8b). |
| 5 | **Site folders** (D-3) | stays in hosts until phase 8, then Files. Folders are a path under the website root (pammy.org's are nested in `/pamela/public`; lfdln's are flat), not only a top-level name. |
| 6 | **Names** | one set of rules on both panels: `SUBDOMAIN_RE`; reserved = the server's own (`panel www api mail media`) + software placements; refused = records in the zone **when the domain's DNS provider is readable** (manual: no zone check, the guide says so). |
| 7 | **Rendering + routing helper** | today's `render.ts` + `lfdln-routes`, driven by the domain's settings; **the gate in host blocks** (from roles plan step 5); the catch-all per domain: **404** or, with folder hosts on, **the folder fallback** (below). pammy.org gets its own helper (`pammy-routes`, same code, its own directory `/etc/nginx/pammy-hosts/`). |
| 8 | **Checks** | per host: DNS points here (resolved from the server and, behind Cloudflare, "proxied"), the certificate covers the name and isn't expiring, it answers (the route's health path or `/`). Shown on the Hosts page and used by the guide. Read-only, cached 10 min. |
| 9 | **Taking over** | today's `--take-over-host` (adopt a hand-written site), unchanged; pammy.org's `pamela` site is taken over the same way (step 5). |
| 10 | **Rights** | the `hosts` right, a host is a place (as now); on pammy.org Pamela and momolig (admins) as today's `subdomains` right, which becomes `hosts`. |
| 11 | **Setup guide** (D-5) | below. |

### Folder hosts, and folders made outside the panel

Today a folder made over SFTP is a subdomain at once. Rows alone would break that. So with folder
hosts on:
- the domain's catch-all is **the folder fallback**: the same regex as today, serving
  `<sites root>/<name>` when that folder exists (exact host blocks win over it, as now);
- **a sync** (the files helper's watch on the website root, plus every 5 minutes) makes the host
  row for a new top-level folder and trashes it with the folder; the panel shows it at once and it
  can be changed like any host (its block then takes over from the fallback);
- the names the fallback won't serve are the reserved ones, as today.
So Pamela sees no difference: a folder is a subdomain the moment it exists, and now it is also a
host she can change.

### The words

pammy.org keeps **"Subdomains"** as the page's name and "folder" words (the glossary,
`words.website`); lfdln says **Hosts**. One page, two sets of words, as everywhere else.

## The setup guide (D-5)

On a panel with the hosts module on and no domain yet (a new install), or from **Hosts → Add a
domain**. One page per question, phone-first, every answer checked before the next page:

1. **The domain**: its name. Check: it resolves.
2. **Who keeps its DNS?** Cloudflare / DreamHost / somewhere else. Cloudflare and DreamHost ask
   for an API key (kept root-only by the helper, never shown again) and read the zone to check it
   works. "Somewhere else": no zone check; the guide says new names can't be checked against it.
3. **What's in front?** Behind Cloudflare's proxy / Directly. Check: the apex's address is
   Cloudflare's or this server's.
4. **New names**: a wildcard record `*` → this server (check: a random name resolves here), or
   one record per host (the guide lists the record to add each time; with an API key it can add
   it).
5. **Certificate**: the guide suggests one from the answers: wildcard via the DNS API
   (DreamHost/Cloudflare key), Cloudflare origin certificate (behind Cloudflare), one per host
   (HTTP-01, no key; each new host waits for certbot), or existing files. Check: the file exists
   and covers the names.
6. **Folder hosts?** Every top-level folder gets its own host (pammy.org's way) / Hosts only
   when made. Needs: a wildcard record and a wildcard certificate (the guide says so when either
   is missing and greys it out).
7. **Summary**: every requirement with ✓ or what's missing, then **Turn on**: writes the domain,
   renders the catch-all, `nginx -t`, reload, checks a test name.

The table the guide works from (also in Help):

| Choice | Needs from you | Needs on the server |
|---|---|---|
| New names without touching DNS | a wildcard record `*` → this server | - |
| Names checked against the zone, records made for you | the DNS provider's API key | the key, root-only |
| Wildcard certificate | the DNS provider's API key (DNS-01), or Cloudflare origin certificate files | certbot + hook, or the files |
| One certificate per host | nothing, but each new host waits for certbot | certbot |
| Behind Cloudflare | proxied records, SSL "Full (strict)" | real-IP rules (built in) |
| Folder hosts | a wildcard record and a wildcard certificate | site folders |
| Hosts pointing at services, software, projects | those modules on | their helpers |

## Steps

Each step is one release (build.sh, the installers, verify). lfdln's hosts must render byte for
byte the same until a step says otherwise.

| Step | What | Risk |
|---|---|---|
| 1 | **Domains as data**: `panel.domains`, `hosts.domain_id`, `origin`; lfdln's domain seeded from its profile by the installer; the renderer reads the domain. No nginx change (byte for byte). | low |
| 2 | **Target kinds as a registry**: `target_kind` / `target_ref`, each kind in its module (folder, redirect, service; software's first route kind). Same files rendered. | medium: every route's rendering moves |
| 3 | **Checks** on the Hosts page (DNS, certificate, answers). | low |
| 4 | **The setup guide** and **Add a domain**; on lfdln the existing domain shows every check green. Browser tests desktop + phone. | low |
| 5 | **pammy.org on hosts** (after roles plan step 5: the gate in host blocks): `pammy-routes`, domain pammy.org (Cloudflare DNS manual or with a key, front Cloudflare, Cloudflare origin wildcard, folder hosts on), rows seeded from today's top-level folders + `blog` → software + `@` with `www`; the folder fallback and the sync; the `pamela` site taken over (the hand-kept file retired); the Subdomains page on the hosts API; `subdomains` right → `hosts`. Every address today's verify knows (and every folder) is asked before and after the switch; any difference gives the old nginx back. | high: nginx for Pamela's live site |
| 6 | **Site folders to Files** (D-3), with File Explorer on lfdln (phase 8). Done narrowed as docs/phase8b-plan.md 8b-9: the records are the files module's, hosts points at them. | medium |
| 7 | **gonsalvesfamily.com as a second domain** (platform phase 7b; added 2026-09-26): the domain through the setup guide (its DNS provider found then; certificate = the existing per-host files, renewing as now, until a wildcard is chosen), its hosts adopted (`--take-over-host`, public + admin), then the Gonsalves nginx files retired (docs/adopt-plan.md V1). Same before/after probes and give-back as phase 6. | high: live sites of another project |

### Step 1 as built (2026-09-27)

- **`hosts/0004-domains.sql`**: `panel.domains` as in part 1 (name, `home`, `dns`, `front`,
  `cert`, `tls` as jsonb `{cert, key, include?, dhparam?}`, `wildcard_record`, `folder_hosts`,
  the last zone reading), one home domain at most (a partial unique index). `hosts.domain_id`
  and `hosts.origin` (`hand` | `folder` | `adopted`), filled for what is there: taken over =
  `adopted`; a host whose `/` shows the site folder of its own name = `folder`; else `hand`.
  A trigger puts a host made without a domain on the home one, so every way a host is made
  (the page, `adopt-folders`, `take-over-host`) needs no change for it.
- **Seeded by the installer**: `lfdln-panel seed-domain` (install-lfdln.sh step 4, after the
  migrations) makes the home row from the profile if there isn't one, and puts every host on
  it. The profile says what the row starts as (`hosts.domain`: DreamHost, wildcard record,
  wildcard certificate by DNS-01); after that the row is what counts, and a later install
  never changes it. A profile naming another domain than the row is refused.
- **The renderer reads the domain**: the table the panel sends has `domains`; the routing
  helper takes the home one's certificate from it, after checking that its name is the
  profile's (the panel can't send the hosts to another domain) and that every path is a plain
  one under `/etc/letsencrypt/` or `/etc/ssl/` (`tlsRoots`). A table with no domains (before
  the seed, and the tests' own tables) renders from the profile as before. Another domain is
  refused until step 4. The seeded row renders **byte for byte** what the profile did (a test
  compares every file; `apply` after the seed changes nothing).
- **Folder hosts go with their folder**: deleting a site folder deletes the host made with it
  (origin `folder`, the same name) when no route is left on it.
- verify-lfdln: the home row (DreamHost, direct, wildcard), its certificate, every host on a
  domain, `adopted` and `origin` agreeing.

### Step 2 as built (2026-09-27)

- **`hosts/0005-target-kinds.sql`**: `routes.kind` is `target_kind`, and each kind's own
  fields moved into `target_ref` (jsonb), under the names the routing helper's table has always
  used -- folder `{spa, headers, cacheForever}`, redirect `{to, status, keepPath}`, service
  `{service, part, websockets, maxBodyMb, signInPaths}`. Eleven columns went. A folder route
  keeps `folder_id`, the one reference the database must hold (a site folder can't go while a
  route shows it). The database checks only that the kind is a word, the fields an object of
  at most 16 KB, and that a folder route and only a folder route names a folder; the kinds
  check the rest. Accounts stay the route's.
- **The table the helper takes didn't change**: a route is still `{host, path, enabled,
  accounts?, kind, ...its kind's fields}`, so the verify scripts, the takeover specs and the
  tests' tables stand as they were.
- **The registry, two halves per kind.** The routing helper's (`render.ts` `RouteKind`: checks
  its fields, says what it is in the file, writes its locations; optional `prepare` over the
  whole table, `reserve` and `hostHeaders` at the host's level) and the panel's
  (`panel/route-kinds.ts` `PanelRouteKind`: its label, `make` from what the page sent, the
  table's extras, the page's options).
  - `folder` and `redirect` are the hosts module's own (`HOSTS_KINDS`; D-3: site folders stay
    here until phase 8).
  - `service` is the services module's (`@panel/services/route-kind` and
    `.../panel/route-kind`), with its ports, its sign-in paths and the `/_lfdln/` 404. The
    services module now needs the hosts module (`NEEDS`, package.json).
  - The site puts them together (`sites/lfdln/src/hosts.ts`: `routeKindsOf`, `hostsConfigOf`;
    the routing helper, the panel and the tests take lfdln's settings from there).
  - A route of a kind the site doesn't have is refused by the panel, by the helper and by the
    renderer.
- **Not built: `software`.** WordPress's include isn't on hosts on either panel yet (pammy.org
  moves to hosts in step 5, lfdln has no software module). It becomes the apps module's kind
  then, and nothing in the registry has to change for it.
- **The Hosts page** takes the kinds (and their labels) from `GET /api/hosts` (`kinds`), and
  the service's parts from the service kind's options. Each kind's form fields are still
  written in the page (a folder, a service, a redirect); a new kind brings its own.
- **Byte for byte**: a test (test/pg.test.ts) fills the old columns with every kind (headers,
  forever paths, sign-in paths, accounts), runs 0005, and renders the table read back against
  the table as it was: every file the same. The three nginx harnesses (hosts, accounts on a
  route, takeover) pass unchanged.
- verify-lfdln: every route's kind is one lfdln has; every service route names its service
  and part.

### Step 3 as built (2026-09-27)

- **The probe** (`packages/hosts/src/probe.ts`) runs as a root unit of its own
  (`lfdln-routes-check-...`), started by the routing helper like `nginx -t` and the zone:
  the helper has no network and can't see `/etc/letsencrypt`. The tasks go on stdin, names the
  helper has already checked, and the probe checks them again. Read-only.
  - **DNS points here**: the name's A and AAAA records against this server's own addresses;
    for a domain behind Cloudflare, Cloudflare's addresses only (proxied). Cloudflare's ranges
    are `deploy/cloudflare-ips.txt`'s (`cloudflare.ts`, a test keeps the two the same).
  - **The certificate**: the one nginx actually gives for the name (TLS to 127.0.0.1:443 with
    SNI), whether it covers the name (a wildcard one label only) and its days left. Under 14
    days is not a pass (Let's Encrypt renews at 30).
  - **It answers**: GET `/` through nginx on this server with the name; any status under 500
    passes (a host with nothing at `/` answers 404, which is an answer).
  - For step 4, two more kinds: a certificate **file** and the names it must cover, and a
    made-up name that must **resolve** here (the wildcard record).
- **The helper's `check`** takes the hosts as the table names them (`@` with www: both names)
  and the domain's front. It keeps each answer 10 minutes, and asks again at most once a
  minute when the page says so.
- **The Hosts page**: under each host, one line per name it answers to: DNS, certificate (with
  its days), answers (with its status). What fails says why. **Check again** at the top.
  `GET /api/hosts/checks` (right `hosts`; someone kept to places sees their hosts only;
  `?again=1`).
- verify-lfdln asks the live helper about lesfleursdelanuit.com, www and tutor (DNS here, the
  wildcard covers them, they answer), and a name nobody made (here through the wildcard
  record, the catch-all's 404).

### Step 4 as built (2026-09-27)

- **Hosts → Domains**: each domain with its settings (DNS, what's in front, the certificate, a `*`
  record) and the setup guide's checks for it, run when the page opens (kept 5 minutes). A domain
  with no hosts that isn't the panel's own can be **Removed**: its catch-all leaves nginx, and
  nothing else on the server is deleted.
- **Add a domain** (`/hosts/add-domain`): the seven pages of D-5, one question each, phone-first.
  **Check and go on** asks the server, and on each page shows the checks that page is about. The
  name must not already be a domain here, or inside or over one (`name`). Nothing else in nginx
  may answer for every name under it (`nginx`). The certificate must cover `<domain>` and
  `*.<domain>`, with its key (`certificate`). Those three stop the guide. DNS, the `*` record and
  the zone are shown but don't stop it.
  - **Certificate**: suggested from the answers. Behind Cloudflare, the origin files under
    `/etc/ssl/cloudflare/`. Otherwise `/etc/letsencrypt/live/wildcard.<domain>/`, with Let's
    Encrypt's TLS settings. The paths must be under the roots the site allows. One certificate
    per host (HTTP-01) is later.
  - **Folder hosts**: shown, but greyed out: it comes with pammy.org's move (step 5).
  - **Turn on** (`POST /api/domains`, a fresh passkey): the required checks again, then the row,
    then nginx with the domain's own catch-all (`domains/<name>/catch-all.conf` and its 404 page,
    included from `site.conf`; the home domain's files byte for byte as before), then a made-up
    name under it asked for real.
- **The zone**: the DreamHost script on this server reads the home domain's zone only, so another
  domain's zone check always shows ✗, saying why: new names under it aren't checked against its
  records. A Cloudflare key comes with pammy.org's move (step 5).
- **The routing helper's `check-domain`**: the `nginx` claims, the DNS of the domain and of a
  made-up name, and the certificate file with its key, through step 3's probe. The panel adds
  `name`.
- **Fixed on the way**: `/hosts/add-domain` is one of the panel's pages (a reload gave the
  server's "Not found"); the "on" message outlives the move back to Hosts (a kept notice); a
  domain just removed doesn't put up "That domain no longer exists." (its checks are quiet).
- Tests: `hosts-*.test.ts` (the guide's checks, Turn on refused while one fails, nginx saying no
  leaves no row, removing, another domain's files); the browser (lfdln): the Domains list all
  green, the whole guide through to Turn on and Remove, and the guide at a phone's width.
  `verify-lfdln` asks the live helper for lesfleursdelanuit.com's checks, and expects every one
  to pass.

Later: more domains on lfdln, DNS records made by the panel,
per-host certificates (HTTP-01) for a domain without a wildcard.

## Step 7 (2026-09-28): gonsalvesfamily.com

DECIDED 2026-09-28: momolig left Q1-Q4 to Claude ("use your discretion"), so every suggestion
was taken, and the switch (7c) is to follow as soon as 7a and 7b are in.

What is there now (checked 2026-09-28):

- **Two hand-written nginx files**, `sites-enabled/gonsalves-public` (gonsalvesfamily.com and
  www, to `gonsalves/public` on :3039) and `gonsalves-admin` (admin.gonsalvesfamily.com, to
  `gonsalves/admin` on :3040). Both have 25 MB uploads, websockets, and `= /api/auth/login`
  behind the `login` rate limit. The public one also serves two folders straight from disk,
  `/uploads/gedcom-admin/` and `/uploads/site-media/`, from `/mnt/storage/uploads/…`, with
  `expires 30d` and `Cache-Control: public, immutable`. Port 80 redirects to https.
- **DNS at GoDaddy** (ns07/ns08.domaincontrol.com): nothing on this server can read it. There
  are three names: the apex (A 203.0.113.200), www (a CNAME to the apex) and admin. There is **no
  `*` record**.
- **One certificate**, `/etc/letsencrypt/live/gonsalvesfamily.com/`, for exactly those three
  names (no wildcard). It is renewed by certbot's **nginx plugin**, which finds the server
  blocks by name and edits them for the challenge.

What step 4 can't do yet: Add a domain wants a certificate for `*.<domain>` and a catch-all
for every name under it. gonsalvesfamily.com has neither, and a wildcard would need DNS-01 at
GoDaddy.

### The parts

- **7-0. Hosts on another domain** (found while building 7a: steps 1-4 only ever put hosts on
  the home domain). A host's name is one per domain (migration hosts/0006: `UNIQUE (domain_id,
  name)`), so gonsalvesfamily.com's `@` and admin sit beside lfdln's. In the routing helper's
  table a host and a route say `domain` when it isn't the home one; their files are
  `domains/<domain>/hosts/<name>.conf`, and site.conf includes `domains/*/hosts/*.conf` once
  there is one. Each host keeps its own domain's certificate and 404 page. The Hosts page lists
  every host at its own address; Make a host and site folders stay on the home domain; a
  person kept to places is kept to home domain hosts (another domain's are the whole site's).
  No accounts on another domain's routes yet (the gate answers for the home domain). The
  checks and monitoring ask each domain for its own names, with its own front.
- **7-1. A domain with named certificates.** A new certificate kind, **`names`**: one certificate
  file that covers the listed names, and nothing under the domain beyond them. A host on such a
  domain is refused unless its names are covered. The domain gets **no catch-all**: another
  name under it gets nginx's `default-443`, as today. The setup guide asks "one certificate for
  every name" or "a certificate for these names". Its checks become "the certificate covers
  every host's names", and `nginx` claims only those names. (Built: cert `names` with
  `domains.cert_names`; the guide takes "@ www admin"; no * record is asked of it; each host
  has its own port-80 block, since there is no catch-all to send http to https.)
- **7-2. Files from disk on a service route** (Q2). A service part can declare folders that nginx
  serves itself, in `known.ts` (code, so root decides the paths, not a request). For Gonsalves's
  public part: `/uploads/gedcom-admin/` and `/uploads/site-media/` from
  `/mnt/storage/uploads/<same>/`, cached 30 days, immutable. The routing helper allows only
  folders under `/mnt/storage/uploads/`. Rendered before the proxy, as today's file does.
  (Built: known.ts SERVED_FOLDERS / SERVED_ROOTS, handed to the routing helper by the site's
  code, never by the table; a route with accounts in front of them is refused; a hidden file
  in them is refused, 403, where the hand-written file served it.)
- **7-3. Renewing the certificate** (Q1). Switch its renewal from the nginx plugin to
  **webroot**. For a `names` domain the panel renders `location ^~ /.well-known/acme-challenge/
  { root /var/www/letsencrypt; }` in its port-80 and port-443 blocks. momolig moves the renewal
  over once (a command below), then `certbot renew --cert-name gonsalvesfamily.com --dry-run`
  proves it. A deploy hook reloads nginx. certbot never edits a panel file again.
- **7-4. Taking over** (as phase 6, `--take-over-host`). The domain is added through the guide:
  DNS manual, direct, `names` certificate. The hosts `@` (with www) → `gonsalves/public` and
  `admin` → `gonsalves/admin`, each with websockets, 25 MB and the sign-in path
  `=/api/auth/login`. The two hand-written links come out and the panel's files go in, with one
  `nginx -t`. The same addresses are asked before and after: `/`, `/api/health`, an upload file,
  `/api/auth/login` (status only) and http→https. Any difference puts the hand-written links
  back. The files stay in sites-available for 14 days.
- **7-5. After.** Monitoring's `OTHER_ADDRESSES` loses the two Gonsalves addresses: they are
  hosts now, checked with the rest. (Built into 7a: an other address that is a host's name is
  left out by itself, so nothing needs changing after the switch.) known.ts's "their nginx stays hand-written" goes, and so does
  adopt-plan V1. verify-lfdln checks the two hosts, the upload folder and the challenge path.

### Steps

| # | What | Risk |
|---|---|---|
| 7a | 7-0 to 7-3 in code (and 7-5): hosts on another domain, `names` certificates, files on a service route, the challenge path; tests, lfdln's files byte for byte | low: nothing live changes |
| 7b | momolig: install (the installer makes /var/www/letsencrypt), then add gonsalvesfamily.com on the Hosts page (Add a domain: DNS somewhere else, directly, a certificate for "@ www admin", the files in /etc/letsencrypt/live/gonsalvesfamily.com/) | low: a domain with no hosts writes only its 404 page |
| 7c | The takeover of both hosts (7-4), then at once the renewal moved to webroot and dry-run | high: another project's live sites |

**The order changed while building 7a:** the renewal moves to webroot *after* the takeover,
not before. Until then only the hand-written files answer for these names, and they have no
`/var/www/letsencrypt` challenge path (public has none, admin's is `/var/www/html`), so a
webroot dry run in 7b would fail. The certificate is renewed in the meantime as now (nginx
plugin); moving right after 7c, before the next renewal, means certbot never edits a panel file.

**Done 2026-09-28:** 7b installed (release-lfdln ad5bf266, verify 327/327) and gonsalvesfamily.com
added (cert names: @ www admin); 7c: both hosts taken over (8 and 5 answers the same), verify
338/339 (the other-addresses count, fixed in abc07d8); the renewal moved to webroot with
`certbot reconfigure` (its dry run and `renew --dry-run` succeeded). momolig also added a `*`
record at GoDaddy: other names reach the server, get no TLS (default-443) and a 404 or a
redirect on http.

7a built 2026-09-28 (branch gonsalves-7b): the adopt nginx harness puts Gonsalves's two
hand-written files beside the panel's and asks both the same requests (public: 21, admin: 15,
incl. media from disk, www, http, the sign-in limit, 20/30 MB, a websocket) -- the same
answers; the takeover harness takes all five hosts over on a nginx laid out like the server's.

### Questions

- **Q1. Renewal.** Suggested: webroot, as 7-3. The other choice is to leave the nginx plugin:
  it would edit the panel's rendered files at every renewal (every 60 days), and the next apply
  would undo it.
- **Q2. The upload folders.** Suggested: declared in known.ts, as 7-2. The other choice is a
  "files from disk" field on a route in the panel, which would need a list of allowed roots and
  a check at every save.
- **Q3. Other names under gonsalvesfamily.com.** Suggested: no catch-all, so nginx's default
  answers them, as now (there is no `*` record, so none reach here anyway).
- **Q4. When.** Suggested: 7c at a quiet time you pick. Downtime should be one nginx reload
  (no restart of the apps).

### 7-6. Add a host on any domain (2026-09-29)

Found with tutorlumi.com (the third domain: Cloudflare in front, its origin certificate): 7-0
kept Make a host on the home domain, so a domain with nothing to take over could get no hosts
at all, and "@" could only ever come from a takeover.

- **Add a host** has a **Domain** choice (shown when there is more than one; the home one first),
  and takes **"@"**, the domain itself, with **www.<domain> too** (ticked by default). www is
  never a host of its own, and the server's names (panel, api, mail) stay kept on every domain
  (the renderer refuses them anywhere).
- `POST /api/hosts` takes `domain` (its name; none, the home one) and `withWww` (only for "@").
  The home domain's names are asked of DreamHost's zone as before; another domain's aren't (its
  zone isn't read here: step 4), nor is "@". On a domain whose certificate is for named hosts
  (7-1) only those names are taken, www beside "@" too. A name there already is refused on its
  own domain. Activity: `host-created` at the host's own address ("www.<domain> beside it").
- Still the home domain's only: Add a static folder's host, a person kept to places, and
  accounts on a route (now refused by the panel with its reason, not only by nginx).
- The Hosts page names a host on another domain in full (`shop.tutorlumi.com`, and the domain
  itself for "@", where it used to show the home domain's name), in its notices too.
- No migration: `hosts.domain_id`, `with_www` and `UNIQUE (domain_id, name)` are all there.

INSTALLED 2026-09-29 13:04 UTC (lfdln e0456fd1 from 9d4d884, verify 339/339); tutorlumi.com's
"@" with www made from the page and sent to TutorStar the same day.

#### Later (found 2026-09-29 with tutorlumi.com, not fixed yet)

- **Checks outlive the change that fixed them.** The routing helper keeps each name's check 10
  minutes (`CHECK_TTL`, `checked` in `src/helper/ops.ts`), and Check again runs at most once a
  minute a domain. A host's checks are taken as soon as it is made; with no route yet it has no
  server block, so they fail. Adding its route a minute later left those failures on the page
  for up to 10 minutes, though the site already answered. Fix: any change that goes to nginx
  for a host (a route added, changed, switched, removed; the host switched or deleted) forgets
  that host's names in the helper's `checked` (for example a `forget` list on `apply`, or the
  panel asking `check` with `again` for just those names after the commit, not counted in the
  once-a-minute limit), so the next look at the page checks them fresh.
- **The notice after Add a host says the wrong thing for "@" and www on another domain.** It
  says the host answers "not found" until a route shows something. That is true for a name
  under a domain with a catch-all (the catch-all's 404), but the domain itself and www aren't in
  any catch-all (it leaves them out on purpose), and a domain with named certificates has none
  at all: until the host has a route, nginx has no server block for them and refuses the
  connection (the checks say "unrecognized name"; behind Cloudflare, 525). Fix: word the notice
  and the "nothing shown yet" badge by case ("won't answer at all until a route shows
  something"), or render a route-less "@" (and a named-certificate domain's hosts) as a server
  block that answers the plain 404.

## With the roles plan

docs/roles-plan.md step 5 (areas on routes) brings the gate into host blocks; step 5 here needs
it for pammy.org's protected folders. Order: roles steps 1-5 (beside accounts steps 1-4), then
hosts step 5. Hosts steps 1-4 don't wait for either; step 7 needs steps 1-4 only.

## Questions

None open (D-1 to D-3 decided 2026-09-26). To settle while building step 5: whether pammy.org's
guide keeps the Cloudflare zone manual (no key) or gets a read-only Cloudflare token for the name
checks; suggested: a read-only token, asked for in the guide, "skip" keeps today's (no check).
