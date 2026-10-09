# Site profile adapters: phase 2 of the platform plan

Status: **decided 2026-09-24** (Q1-Q3 below answered). Step 1 LIVE: release fe75669b50a79514 (commit 6b53250) installed 2026-09-24 06:15 UTC
(verify 541/541, access 62/62; the installer: "nginx files rendered from the profile: the same as
what was there"). Step 2 built 2026-09-24 as release 88b66d3ae7f97399 (commit 7281d9b; build: unit,
nginx 30, gate 175, tutorials 67, browser 115); LIVE 2026-09-24 07:01 UTC (verify 541/541,
access 62/62, rendered nginx == installed, guides synced). Step 3 (A7 glossary) built 2026-09-24 as
release 7c13dddac46fee7c (commit ac56947; build: unit, nginx 30, gate 175, tutorials 67, browser
115); LIVE 2026-09-24 07:32 UTC (verify 541/541, access 62/62, rendered nginx == installed,
guides synced). **Phase 2 done.** Part of docs/platform-plan.md (phase 2: "TLS mode, direct or
Cloudflare, real IP, folder-linked or routed, wording. pammy.org's profile = today"). Builds on
packaging step 5 (docs/packaging-plan.md), which put pammy.org's facts in
`sites/pammy/src/profile.ts` and made the packages take them from there.

What phase 2 is for: after it, everything that differs between pammy.org and lfdln in G1's
table (except the people, phase 3, and the hosts and routes themselves, phase 4) is a value in a
site's profile, and the code and nginx files follow it. pammy.org's profile gives exactly what
runs today; a test profile shaped like lfdln's proves the other values work. Nothing is
deployed for lfdln yet (that is phase 5).

## What was found (2026-09-24)

- **The gate is already neutral.** It never looks at Cloudflare or at how a host became a
  folder. nginx hands it three headers: `Host`, `X-Pammy-Base` (`/` for the domain,
  `/<folder>` for a folder subdomain) and `X-Pammy-Uri` (the exact path about to be served);
  it trusts `X-Real-IP` only from localhost (security.ts `clientIp`, gate `ipOf`). So "direct
  or Cloudflare" and "folder-linked or routed" are **nginx's** business; the gate only needs
  nginx to keep that contract.
- **Cloudflare lives in nginx files**: `deploy/pammy-panel.nginx` (only Cloudflare may
  connect: a `geo` on `$realip_remote_addr`; `X-Forwarded-Proto` for http to https; the
  Cloudflare origin certificate), `deploy/nginx/gate.conf` (includes
  `cloudflare-realip.conf` for the gate's `/_pammy/`), `render-cloudflare.sh` (the realip and
  geo files from `cloudflare-ips.txt`). The installer copies them as they are.
- **Folder-linked subdomains live in two places**: the pamela vhost (`~/pamela-setup/wordpress/
  pamela-live-wp.nginx`, a server_name regex that sets `$pammy_base`), and the panel's pages and
  helper words that say "`recipes/` is `recipes.pammy.org`" (Subdomains page and menu item,
  Home's "Make a subdomain" card, `folderAddresses`, the media file addresses, the starter
  page's link, folder names being refused because they are software's subdomain).
- **The 100 MB upload cap** is Cloudflare's free plan (sitefs/media.ts `MAX_UPLOAD`, the web's
  `MAX_UPLOAD`, nginx's `client_max_body_size 100m`).
- **Words**: packaging step 5 already takes the site's names from the profile. G1 and D4 want
  lfdln's words "plainly technical" on the same pages.

## Proposal

- **A1. Front and real IP.** `profile.front` becomes
  `{ kind: 'cloudflare', ranges: 'deploy/cloudflare-ips.txt' } | { kind: 'direct' }`.
  nginx's real-IP include is rendered from it: Cloudflare's `set_real_ip_from` list and
  `real_ip_header CF-Connecting-IP`, or nothing at all for direct (then `$remote_addr` is the
  visitor already). The app code does not change (it believes `X-Real-IP` from localhost only,
  whichever way nginx worked it out).
- **A2. TLS.** `profile.tls = { cert, key }` for the website and for the panel (pammy.org: the
  Cloudflare origin wildcard in `/etc/ssl/cloudflare/`; lfdln: the Let's Encrypt wildcard in
  `/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/`). With Cloudflare in front, http to
  https is decided from `X-Forwarded-Proto` (as today); direct, port 80 simply redirects.
- **A3. Who may reach the panel.** `profile.panelAccess = { kind: 'front' }`: through whatever
  is in front (pammy.org: only Cloudflare may connect, as today; lfdln, nothing in front:
  anyone, and only a passkey signs in, N2 as revised 2026-09-24). `{ kind: 'vpn', subnet }`
  (only a VPN subnet; everyone else gets the connection closed, 444) stays in the code as an
  option, tested, and unused since the VPN was dropped.
- **A4. nginx is rendered, not copied.** A new core module, `@panel/core/nginx`: plain functions
  from a profile to file texts (the panel's site, the gate's includes, the real-IP include, the
  access list). The installer writes what they render instead of copying `deploy/*.nginx`.
  **The net: for pammy.org's profile the rendered files are byte for byte today's files**
  (a test, and the installer's own check before it writes anything). The pamela vhost is not
  rendered in phase 2: it is pammy.org's folder-linked site and stays its own file; the routed
  host map is phase 4's.
- **A5. Folder-linked or routed.** `profile.folderSubdomains` (true: folder-linked, pammy.org;
  false: routed, lfdln; the profile already had it from packaging step 5). The contract
  with the gate is written down in `@panel/core/gate/context.ts` and stays as it is: nginx sets
  `X-Pammy-Base` to `/<folder>` of one website root. For `routed`, phase 4's host map will set
  the same header, with G3b's site folders under one root of their own, so **the gate needs no
  second mode**. In the panel, what says or assumes "a folder is a subdomain" follows the
  switch: the Subdomains page and its menu item, Home's card, the addresses shown for a folder
  or a media file, the starter page's link, and the names refused because software uses them.
  In `routed` mode they show a folder by its path only; making it a host is phase 4's page.
- **A6. Upload size.** `profile.uploads.maxBytes`: pammy.org 100 MB (Cloudflare's limit, as
  today), used by nginx's rendering, the folder helper and the pages.
- **A7. Words.** A small **glossary** in the profile for the words that differ between the two
  sites, starting with G3's: what a database's pages are called ("app" on pammy.org), "website"
  vs "site folders", and the hint lines that explain a technical word to Pamela. Pages take
  those words from `SITE.words`. A full "plainly technical" pass over every page is left to
  phase 8, one module at a time as each comes on for lfdln (Q2 below).
- **A8. A test profile shaped like lfdln's** (`test/fixtures/lfdln-profile.ts`: direct, LE
  certificate paths, the panel open to anyone with a passkey, routed) renders nginx files that
  `nginx -t` accepts in the test harness (run-nginx-test.sh already runs a real nginx), and
  the pages build with it. It is only a test: lfdln's real profile is written in phase 5.
- **Not in phase 2:** installer and verify for another site (phase 5), the host map and routes
  (phase 4), people and rights (phase 3), the gate's `/_pammy/` examples and widgets per module.

**Step 2 as built (2026-09-24):** with `folderSubdomains` off, the folder helper reports no folder
as a subdomain and its starter page points at the domain; the panel's activity line, the media and
database examples' "also at" address, the media API's `subdomainUrl` and the pages' folder and media
addresses leave the subdomain out; the Subdomains page, its menu item and Home's "Make a subdomain"
card are not there. Home's other shortcuts also follow the modules switched on. The upload limit
(`uploads.maxBytes`) is the panel's, the helper's and the pages' (their messages say it). The names
software uses stay refused either way (a WordPress placement is an address on both kinds of site).

**Step 3 as built (2026-09-24):** `profile.words` (type `Words` in `@panel/core/profile`, carried in
`SiteFacts`, so both the pages' `SITE.words` / `W` and the server's `config.site.words` have it):
`app` (`one`, `a`, `many`: "app", "an app", "apps"; lfdln's test profile "database app"), `website`
(`title`, `your`, `top`: "Website", "your website", "the top of your website"; lfdln's "Site
folders") and `explain` (the lines that explain a technical word: "A database is a tidy place for
lists", "A database user is a login a program uses...", "A table is a list...", "A table is how
something is kept"; off for lfdln). Every page that named a database's pages "app", File
Explorer's and the menu's "Website", and the panel's own messages about the app (routes in
packages/*/src/panel) take them from there. Left as they are: the gate's data-API messages
(for programs), pammy.org's Getting started paths and guides (phase 9 gives lfdln its own), and
"on your website" meaning the live site (phase 8). The site's vite.config.ts takes
`PANEL_PROFILE` / `PANEL_WEB_OUT`, and test/words.test.ts builds the pages with the lfdln-shaped
profile and checks they carry its words; it also fails on any page or panel route that writes a
glossary word itself.

## The net

The same as packaging's: same routes, same schema, every suite green, the same verify (541 +
62), the same words for pammy.org, and new: every nginx file the installer writes is byte for
byte what is live now.

## Steps (one release each)

1. **A1-A4**: `@panel/core/nginx`, the profile's `front`, `tls`, `panelAccess`; the installer
   writes the rendered files; the byte-for-byte test; the lfdln-shaped test profile through a
   real `nginx -t`.
2. **A5-A6**: `subdomains` and `uploads`, and the pages and helper that follow them.
3. **A7**: the glossary and the words pages take from it.

## Questions for momolig

- **Q1. The VPN subnet**: moot. **No VPN** (decided 2026-09-24, platform plan N2 revised): the
  lfdln panel is public and passkeys only, like panel.pammy.org.
- **Q2. Words: decided 2026-09-24, the glossary now**; the full plainly-technical wording page
  by page in phase 8.
- **Q3. Uploads on lfdln: decided 2026-09-24, 100 MB**, as on pammy.org (a profile value, easy to
  raise later).
