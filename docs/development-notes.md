# pammy.org control panel (panel.pammy.org)

A control panel for Pamela and momolig.
1. **Phase 1** (live 2026-09-16): passkey sign-in, account management, activity log.
2. **Phase 2** (live 2026-09-16): subdomains. Create a folder with a starter page,
   list folders, move a folder to `/pamela/trash`, restore it; trash is purged after 30 days.
3. **Phase 3** (live 2026-09-16): password-protected folders. The gate service sits in
   front of her whole static site. It provides the `<pammy-login>` component for her
   `login.html` pages, a shared list of people who can sign in, and 30-day visitor sessions.
   **Self-service pages** (live 2026-09-16): `login-forgot.html`, `login-invite.html` and
   `login-request.html` beside `login.html`, one-time setup links so people choose their own
   password, and a Requests tab in the panel. Nothing is emailed: Pamela sends the links.
4. **Forms** (built 2026-09-17, replacing contact forms): forms built in the panel and put on
   ANY page with `<pammy-form name="olivias-form">`, responses stored in the gate and read in
   the panel's Responses tab (read/unread, approve, trash for 30 days), plus a read-only API
   for programs (Bearer keys) and for pages when a form's approved responses are public.
   The plan and every decision behind it: `docs/forms-plan.md`.
   **Help tab**: Pamela's guides (per `../guides.map`, copied into `release/help` by
   build.sh), one page each (`/help/<guide>`, e.g. `/help/wordpress#part-2`; guide 08 has a page per part, `/help/control-panel/part-9`), formatted from the plain text by
   `src/help.ts` (paragraphs, capitals subheadings, numbered/lettered/bulleted steps,
   term + indented explanation, `key  value` tables, indented examples as code), and
   searchable. Links to web addresses, other guides and "PART n" are made in the page.
   Write new guide text in the same habits; `test/help.test.ts` checks all nine. The Turnstile CAPTCHA is not built yet;
   guide 04 PART 3 has Pamela's steps to create the widget and hand over the keys.
5. **Installed software** (phase 1 built 2026-09-23, `docs/apps-plan.md`): the WordPress
   at blog.pammy.org, adopted without changing it, and shown at `/software` (how it is doing,
   where it is, space, backups). The software helper `pammy-apps` (`src/apps/`, root, read-only
   in phase 1: one capability, loopback only) is the truth about what is installed. Phase 2
   (built 2026-09-23): back up now, download, put a backup back, offline/online, a new admin
   password, its complaints -- each command run as a named `systemd-run` unit (as root or
   svc-pammywp), long ones as jobs the page watches. Phase 3 (built 2026-09-23): **Email**
   (`/email`): WordPress sends through Resend (SMTP, a must-use plugin) and the panel emails
   hello@pammy.org about chosen forms, comments waiting and access requests, through
   `pammy-mail` (`src/mail/`), the one service allowed off this machine. Installs and updates:
   phases 4-5. She sees "Installed
   software", because "app" already means a database's pages.

**Styling the visitor forms**: `public-gate/login.js` and `forms.js` share one
documented set of class names (`pammy-box`, `pammy-form`, `pammy-heading`, `pammy-field`,
`pammy-label`, `pammy-input`, `pammy-button`, `pammy-message`, ...; form fields also carry
`data-key` and `data-type`, and their labels carry
`data-question`), more settings (`--pammy-width --pammy-gap --pammy-field-bg --pammy-field-border
--pammy-error --pammy-success`) and wording attributes for every label and message except server
errors. Built-in styles are all inside `:where()` and prepended to `<head>`, so any rule on her
page wins; `styles="off"` leaves them out (the spam trap is hidden with an inline style, and
`[hidden]` stays hidden). Her reference: guides 09 (PART 6-7) and 10 (PART 5-6); keep them in
step with the comments at the top of the two scripts. Guides 09-protected-folders and
10-forms are dedicated guides (guide 08 PARTs 6-10 are now summaries pointing to them),
and both are split into part pages in the Help tab (`GUIDES_BY_PART`).

**Media folders and the Media tab** (built 2026-09-16): any folder can have `media/` with
`photos/ files/ audio/ video/` (made only when asked), each with folders ("buckets") inside.
- All file work is the website folder helper's (as pamela): `src/sitefs/media.ts`. Paths: the
  first `media` segment is the media folder; every step is checked, shortcuts never followed,
  nothing ever overwritten (uploads/copies go to a hidden temp file, then `link()` under the first
  free name: `x.jpg`, `x-2.jpg`...). Kinds are checked by extension (photos/audio/video lists;
  files = anything but web pages and scripts). Trash: `/pamela/trash/.media/<stamp>-<rand>/` with
  `origin.json`, restorable, purged after 30 days with the folder trash.
- Streams over the helper socket (`src/jsonline.ts`, `allowHalfOpen`): `media-upload` = request
  line + exactly `size` bytes; `media-read` = reply line + bytes (ranges, for previews and video).
- Panel: `/api/media*` routes; uploads are raw bytes (`application/octet-stream` + `X-Pammy-Name`,
  the one non-JSON POST the origin check allows), up to 100 MB (Cloudflare's free-plan limit;
  nginx `location = /api/media/upload`, `proxy_request_buffering off`). Refused uploads are read to
  the end before answering, or nginx reports a 502. Previews come from `/api/media/file` with a
  `sandbox` CSP (anything not a picture/sound/video downloads). Every media file has a
  record in the **media records** (`src/media-db.ts`, schema `media` in the panel's Postgres,
  beside the `panel` schema its accounts are in): scope, kind, size, sha256, who added it and
  how, present/trashed/missing, and tags and categories that only link within their scope
  (triggers). The panel's own changes update
  it at once; a sync (`src/media-sync.ts`, helper ops `media-scan`/`media-hash`) catches what
  WinSCP or Claude changed: when Media is opened (if over 5 minutes since the last), every 15
  minutes, "Check for changes", and `pammy-panel media-sync`. Moves outside the panel are
  recognised by hash. `media_notes` (schema `panel`) is no longer used (copied in once). Details:
  `docs/media-plan.md`, "Phase 2 as built". **Thumbnails** (phase 3) come from
  `pammy-thumbs` (`src/thumbs/`: its own user, www-data only while running to read the site,
  no network, nothing writable, sharp + ffmpeg + pdftoppm under per-file limits). It hands
  back WebP bytes that the panel keeps in `/var/lib/pammy-media-public/thumbs` and serves at
  `/api/media/thumb/:id`. See "Phase 3 as built". **The Media page** (phase 4) lists from those records (`GET
  /api/media/items`): one media folder or all of them, one kind or all four, name search,
  tag and category filters, Grid or Table, and several files at once. Tags and categories
  are in `src/media-labels.ts`, and the page is in `packages/files/web/components/media/`. See "Phase 4 as
  built". **Accounts kept to one folder** (phase 5): `users.scope`. They see only that
  folder's media, forms and responses; everything else answers 404 (`LIMITED_ROUTES` in
  app.ts, and the gate's scoped ops). Forms have a scope too (`forms.scope`, "Works on").
  See "Phase 5 as built".
- "media" is a reserved subdomain name, and media folders are left out of folder lists (Subdomains,
  protect/form pickers, the gate's welcome page).
- Tested: helper ops over a real socket (sitefs.test.ts), API (panel.test.ts), nginx upload limits,
  and the browser tests (test/e2e: uploads, gallery, details, move, trash).

**Tags and categories on every file** (built 2026-09-19): labels were already stored per file for
the whole website, but the Tags & categories page and label creation still assumed media folders.
- A label can now be made in any folder at the top of the website, with or without a media folder
  (`realScope` in app.ts), or in a deeper folder marked as a tag scope.
- `GET /api/media/labels?around=<folder>` (`listLabelsAround`) lists what files in and under a folder
  can have: that folder's labels, those of the folders above it, and those of scopes below. File
  Explorer's filters and the tag editor use it.
- The page moved to `/tags` (`/media/tags` redirects there), under Website in the menu. "Show" offers
  every folder (`*`), the top of the website (`/`), or one folder. "Show files" opens File Explorer.
- The media API still lists only files in media folders, whatever carries a public label.

**The file editor** (built 2026-09-19, `docs/editor-plan.md`): text files (.html .htm .css .js
.txt .md .json .xml .svg, up to 2 MB) open at `/files/edit?path=...` in CodeMirror 6, with
Code | Preview | Side by side for pages.
- **Saving** goes through the helper (`src/sitefs/edit.ts`, as pamela): a temporary file, then a
  rename over the old one. A save is refused with 409 "conflict" if the file's sha256 isn't the
  one the editor opened.
- **Versions:** every save keeps what it replaced in `/pamela/trash/.versions/` for 30 days
  (quick saves from one open editor share one, and at most 50 are kept per file).
- **Preview:** a sandboxed frame (opaque origin) that reads the site through a token in its
  address (`src/preview.ts`), showing the unsaved text.
- **Drafts:** the unsaved text is also kept in the browser (localStorage) and offered back.

**Front end** (React, built 2026-09-17): a Vite app (React 19, react-router,
TanStack Query, Tailwind 4, shadcn/ui components written into `packages/core/web/components/ui` on
`radix-ui`, lucide-react icons, self-hosted Bricolage Grotesque + Atkinson Hyperlegible).
`build.sh` builds it into `public/` (`index.html` + hashed files under `/assets`); `public/` is
generated, don't edit it. The server reads `public/index.html` once and sends it for every
page address (`PAGE_PATHS` in `src/app.ts`, keep in step with the routes in `sites/pammy/web/src/App.tsx`)
and for `/login` and `/invite`; `/assets/*` files are cached for a year (their names change
when they do).
- **CSP:** unchanged for scripts (`script-src 'self'`). Radix dialogs lock scrolling with a
  `<style>` element, so each page copy gets a fresh nonce (`style-src 'self' 'nonce-...'`,
  `pagePolicy` in `src/security.ts`); the page reads it from `<meta property="csp-nonce">`
  and hands it to `get-nonce`. No toast library (sonner injects CSS). API answers keep the
  plain policy. `font-src 'self'` for the fonts.
- **Layout:** `packages/core/web/components/shell.tsx` (menu sliding in from the left on every
  screen: buttons, Escape, a click outside, a link, or a swipe left; red dot and counts for
  waiting requests and messages), `page.tsx` (Page / Section / List / Row building blocks),
  `dialogs.tsx` (`useDialogs().confirm/prompt` instead of the browser's), `notice.tsx` (one
  line of news at the bottom), `useAction` (runs a change, asks for a passkey check when the
  server wants one, refetches everything after).
- **Addresses:** every page is its own address (`/messages?form=3`, `/media?folder=recipes&kind=audio&in=2026-trip`,
  `/help/control-panel/part-9`, `/help/wordpress#part-2`). Signed out: `/login?next=<address>`,
  and back there after signing in (`nextPage`, panel addresses only). Old `/#tab` links are
  rewritten on arrival.
- **Develop:** `npm run web:dev` (Vite on :5173, `/api` proxied to a panel on :3044; passkeys
  only work on the real origin, so mostly use the e2e server below).

Design decisions and their reasons are in Claude's memory notes: `pammy-panel-design`.

## Deploy / update

```
~/pamela-setup/panel/build.sh                        # as yourself: typecheck, build the front end, all tests (browser too), build release/
sudo ~/pamela-setup/panel/deploy/install-panel.sh    # deploy it (runs verify-panel.sh at the end)
```

The installer is safe to re-run and refuses to deploy a stale build. If the new
version doesn't come up healthy, it puts back the previous version
(`/opt/pammy-panel.prev`). If nginx rejects the site file, nginx is restored as it was.

**First time only**, create your account and a passkey setup link:

```
sudo pammy-panel add-user momolig "momolig" --manager
sudo pammy-panel invite momolig
```

Then add Pamela from the **Accounts** tab. That gives you a setup link to send her.
Guide `08-control-panel.txt` walks her through it.

## Command line (on the server)

`sudo pammy-panel users | add-user <u> "<Name>" [--manager] | invite <u> | disable <u> | enable <u> | signout <u> | role <u> manager|member | access <u> <right,...>|none [<folder> ...] | activity [n]`

A new account has no parts of the panel until it is given some (the Accounts page, or `access`). Account managers are made only here (`role`).

This is the way back in if every manager passkey is lost: `sudo pammy-panel invite momolig`.

## How it's built

```
visitor -> Cloudflare -> nginx :443 (panel.pammy.org, Cloudflare IPs only) -> 127.0.0.1:3044
           pammy-panel.service: node 22 (runs .ts directly), Fastify, SimpleWebAuthn, postgres.js
                 |  127.0.0.1:5434  pammy-pg (rootless container, svc-pammypanel-db): database pammy,
                 |                  schemas panel + media (the panel) and gate (the gate)
                 |  /run/pammy-sitefs.sock  (root:svc-pammypanel 660)
                 v
           pammy-sitefs.service (socket-activated, runs AS pamela): list / create / trash / restore / purge
                 writes only /pamela/public and /pamela/trash
```

```
every request to pammy.org / <folder>.pammy.org
  nginx --auth_request /_pammy/check--> pammy-gate (127.0.0.1:3045, svc-pammygate, reads /pamela/public as www-data)
    204 -> file served (+ Cache-Control: private, no-store inside protected folders)
    401 -> 302 to the folder's login.html (or the built-in /_pammy/login)
  /_pammy/*  -> pammy-gate (login.js, built-in pages, sign-in/out, forgot, request, setup links; real IP from CF-Connecting-IP)
panel --/run/pammy-gate-admin.sock (root:svc-pammypanel 660)--> pammy-gate: folders, people, access, links, requests
panel --/run/pammy-sitefs.sock--> helper (as pamela): writes .pammy-protected + the five starter sign-in pages + login-files/style.css
  /_pammy/forms.js, /_pammy/forms/<name> (GET + POST), /_pammy/form-preview,
  /_pammy/api/forms/<id>|by-name/<name>/all|approved[/filterby/<field>/<value>] -> pammy-gate (forms, below)
  /_pammy/examples/<kind>/ -> pammy-gate (the three worked examples, framed by the panel)
panel --gate admin socket--> forms, responses, approvals, API keys, the examples
panel --sitefs socket--> install-pages: her own copy of an example page
```

**Forms** (docs/forms-plan.md)
- **Where things live.** `forms`, `responses`, `response_values`, `form_pages` and `api_keys`
  are tables in the gate's schema (`src/gate/forms.ts`), because the gate already serves the
  public side. The panel reaches them only through the admin socket, and has no rights on
  schema `gate` at all; the `panel` schema (accounts, passkeys) is likewise closed to the gate.
- **Which form a page shows.** The page names it: `<pammy-form name="olivias-form">`. A form's
  name is unique, lowercase-with-hyphens and can never change; it stays taken while the form is
  in the trash. The component also sends `location.pathname`, which the gate resolves exactly
  like `/check` (real path, symlinks followed) to decide who may use the form and to note which
  pages show it (`form_pages`, at most one write per page per hour).
- **Switches.** `enabled` (a page says "not available" when off), `approvable` (Approve in the
  Responses tab), `public_approved` (anyone may read the approved ones, public fields only).
- **Items.** One model for every kind of question and layout piece (`cleanItems`), each field
  with a `key` made from its label. A key is fixed once saved and never reused, so the API
  keeps working (`used_keys`).
- **Protected folders.** Both the definition fetch and the POST run `decide()`, so a form on a
  page in a protected folder only works for people who may open it, and the response records
  the signed-in visitor. A form can also be set to signed-in visitors only.
- **Responses keep a snapshot**: the form name and each answer's key, label, type and value as
  sent. Editing or deleting a form never changes them (`form_id` becomes NULL when it's purged).
  Typed values: numbers are numbers, tick boxes booleans, several choices an array, a name or
  address an object. `response_values` holds the same answers flattened and lower-cased, which
  is what `filterby` searches.
- **Saving** is live at once, with no drafts: `version` goes up on every save and a save from an
  older version is refused, naming who saved and when.
- **Checks.** Per kind (lengths, email/phone/number/website shapes, date and time ranges, how
  many choices), errors name the field's key so the page can point at it. Hidden trap field
  (`website`), 10 per IP per hour, nothing new while 1000 are unread or 10,000 are stored.
  POST body up to 64 KB (Fastify route limit, nginx `client_max_body_size 64k` in gate.conf).
- **The API** is read-only: `/all` needs a key that may read everything, `/approved` a key or
  the form's public switch. Keys are `pammy_<43 chars>`, header only (a key in the address is
  refused), SHA-256 at rest, made and revoked by an account manager after a passkey check.
  Cursor paging (`order`, `limit`, `after`), `no-store` for keyed answers, `no-cache` + ETag
  for public ones, and IP, hostname and read state are never given out.
- **The Responses bar** narrows by form, by approval and by **Show** (all / unread / read;
  `read=` on `/api/responses`). Each response's buttons sit in a footer along the bottom of
  its row (`footer` on `Row`), so the answers are read before anything is decided.
- **Trash** like folders: forms and responses both have `trashed_at`, restorable, housekeeping
  deletes after 30 days. Reading isn't logged in Activity; making, saving, switching,
  approving, trashing and keys are. No answers reach Activity or the admin socket log.
- **After sending**, all hers to style: the page's own `thanks="..."` (a page of her own, same
  site only), else her own markup from a `<template class="pammy-thanks">` inside the element,
  else the form's thank-you words in `<p class="pammy-sent">` (`sent-text="..."` overrides them
  per page). There is no built-in thank-you page any more.
- **The Forms card** shows the name and the numeric id, and has three code examples to copy:
  the two lines for a page, the ways a form can end, and a `fetch` of the approved responses
  filled in with that form's own name and field keys (`formCode`, `thanksCode`, `approvedCode`).
- **Two ways to ask the API for a form** (added 2026-09-17): `/_pammy/api/forms/<id>/...` and
  `/_pammy/api/forms/by-name/<name>/...`. Same rules, same answers, same errors -- a name
  nobody has looks exactly like a form nobody may read, so names can't be fished for. The
  card's code block and the examples' pages use the name, which needs no looking up.

**The worked examples (`docs/examples-plan.md`, added 2026-09-17)**
- **Three of them**, `guestbook`, `rsvp` and `pinboard` (`src/gate/examples.ts`): one form,
  approved responses, a page that shows them, in three sets of clothes. The same question
  lists are the starters "New form" offers (with `contact`), so what she tries is what she gets.
- **Fixtures.** Each is a real form (schema `gate`) with a `fixture` column naming its kind
  (unique index; NULL for every form of hers), created by gate migration 6 with its sample
  entries already approved. They can't be trashed or renamed, only **reset** (factory
  questions, settings, switches, and the sample entries back). Duplicate is allowed and gives
  an ordinary form: that is "Make me one of these". Their entries are in the Responses list
  with an "example" badge, but never in the unread count (`unreadCount`) or on Home
  (`examples=hide`), and each example keeps only its newest 50.
- **The pages** live in `public-gate/examples/<kind>/{page.html,style.css,entries.js}` with
  `@FORM@` and `@FILES@` filled in: by the gate at `/_pammy/examples/<kind>/` (noindex, the
  trailing slash enforced by a 301 so the two files resolve), and by the panel for her own
  copy. The panel frames the gate's page (`frame-src https://pammy.org` was already there).
  What they teach: `textContent` everywhere, and the pinboard's colour looked up in a map
  rather than dropped into a class name.
- **"Put this on my website"** (`POST /api/examples/:kind/install`): makes a form of hers from
  the starter if she hasn't got one, asks the gate for the three files, and hands them to
  sitefs `install-pages`, which writes with `flag: 'wx'` -- never over anything, never through
  a shortcut, only `name.html`/`name.css`/`name.js` one folder deep. Then the panel tells her
  the address and the one switch left ("Anyone can read the approved responses", passkey).
- **The change from contact forms** was a code migration (`migrateContactForms`) in the SQLite
  days: old forms became forms (switched off, names made from their titles), messages became
  responses with keys made from their labels, and `contact_pages` was dropped. It doesn't come
  across to Postgres: the baseline schema is what it left (docs/postgres-plan.md P6, step 5).

**Self-service pages: forgot password, setup links, asking for access**
- **The five pages.** `login.html`, `login-forgot.html`, `login-invite.html`,
  `login-request.html` and `logout.html` (`PAGES` in `src/gate/policy.ts`) are exempt, but
  only as files directly in their own protected folder, plus the `login-files` folder. The
  names are exact, so none of her existing pages (say, a party `invite.html`) can become
  public by accident; `logout.html` is the one not starting with `login` (momolig's choice,
  2026-09-17: it must open for someone just signed out, and holds nothing). Any other
  `login-*.html` or `logout-*.html` stays locked. A missing page falls back to `/_pammy/<kind>`.
- **Signing out** (added 2026-09-17). `logout.html` holds `<pammy-signed-out>`, which signs
  out on arrival (POST `/_pammy/logout`) and links back to sign in, so a plain
  `<a href="logout.html">` is a sign-out link. `POST /_pammy/logout` with `page` (any page
  in a protected folder) or `area` answers `next`: the innermost folder's logout page on
  that hostname. `<pammy-logout>` and the other sign-out links go there. `GET /_pammy/logout`
  is the built-in signed-out page.
- **Example looks** (added 2026-09-17). `public-gate/examples/<garden|evening|postcard>/` hold a
  `login-files/style.css` and the five pages each; guide 09 prints them word for word as
  PART 9 to 11 (gate.test.ts checks every file is one code block there). The gate serves them
  at `/_pammy/examples/<look>/<file>` with `frame-ancestors https://panel.pammy.org`; login.js
  sees that path and runs in preview mode (nothing sent, a bar between the five pages). In
  the Help tab a guide line `Preview: <that URL>` becomes a Show preview frame (panel CSP
  `frame-src https://pammy.org`, `sandbox="allow-scripts allow-forms"`), and code blocks get
  a Copy button.
- **Starter files.** Protecting a folder (and "Add the missing starter pages") writes the five
  pages and `login-files/style.css`, which all five link; nothing already there is touched,
  and a `login-files` that's a shortcut or a file is never written into.
  The components find each other through `GET /_pammy/about`, on whichever hostname
  they're on.
- **No email.** Both forms create rows in the gate's `requests` table. The panel's
  Requests tab lists them, and approving hands Pamela a link to send. Nothing leaves
  the server, and the gate keeps its no-network sandbox.
- **Setup links** (`links` table). Only the token's SHA-256 is stored. Each link works
  once, for 7 days, with one live link per person: a new link, a password set by
  Pamela, or switching the person off cancels it. The token is in the URL
  `#fragment`, which the page removes from the address bar and posts to
  `/_pammy/invite`. Using a link sets the password, ends every session, closes open
  forgot-password requests, and signs them in on that hostname. A person created
  "with a link" has `password_hash = ''` and can't sign in until they use it.
- **Links open** `https://pammy.org/<folder>/login-invite.html#…` if the folder has
  that page, otherwise `https://pammy.org/_pammy/invite#…`. The gate builds the URL,
  because it can see her files.
- **Forgot password** always gives the same answer. Only real usernames become
  requests, with one open request per person, 5 per IP per hour and 3 per username
  per day.
- **Ask for access** needs a name and a contact (free text). Limits:
  - One open request per name + contact per folder.
  - 5 per IP per hour.
  - At most 50 waiting per folder, 300 in total.
  - A hidden trap field: filled in, the form reports success and stores nothing.

  Each folder has a switch (`areas.requests_open`, on by default).
- **Folders with no home page.** nginx answers "403 Forbidden" for a folder with no
  `index.html`, because listings are off. So when a visitor is allowed into a protected
  folder with no `index.html`, `/check` sends them to `/_pammy/welcome?area=…&path=…`
  instead: a 401 with that as the login URL. That page lists the folder's `.html`
  pages and its subfolders that have an `index.html`, but only ones they may open,
  and only inside that area (`GET /_pammy/folder`). Signed-out visitors and
  unprotected folders are unaffected. Found live 2026-09-16: `olivia/` had only
  subfolders.
- **`/_pammy/login.js` is served `no-store`.** With `no-cache`, Cloudflare's Browser
  Cache TTL rewrote it to `max-age=14400`, so browsers kept an old copy for 4 hours.
  That's how the welcome page first showed blank. `no-store` passes through as
  BYPASS, like the panel's own assets. Verify checks this. That alone wasn't enough:
  a Cloudflare edge that had already stored the old copy kept serving it, and only
  a purge in Pamela's Cloudflare account clears that. So the built-in pages load
  `/_pammy/login.js?v=<first 12 hex of its sha256>`, which is new with every change.
  Her own pages use the plain address, which catches up once the edge copy
  expires.
- **Contact details** (`visitors.contact`) are only shown in the panel. They're copied
  from an approved request and editable on the People tab. They never reach a log:
  the admin socket logs only op, id or path, and actor.
- **The live verify posts one test request of each kind**, from the server's own IP.
  Running it more than 5 times in an hour trips the per-IP limits (429), which is
  expected, not a fault.

**Password-protected folders: how the gate decides**
- **What it checks.** nginx passes the exact path it's about to serve (`$uri`, set inside each
  serving location by `/etc/nginx/pammy-gate/uri.conf`). Setting it at server level doesn't
  work: the auth subrequest re-runs server rewrites and overwrites it. nginx also passes
  `X-Pammy-Base` (`/` or `/<folder>`). A missing or malformed header is a 403. So is any
  location that neither sets the path nor has `auth_request off`: it fails closed.
- **Real paths.** The decision is made on the path after following symlinks, so a shortcut
  into a protected folder is protected too. A missing file inside a protected folder asks
  for a sign-in, so it can't be used to learn which files exist.
- **What protects a folder.** A folder is protected if it contains a `.pammy-protected`
  marker, or if the gate's database lists its path. The marker moves with WinSCP renames;
  the database entry survives a deleted marker. A marker whose token the database doesn't
  know locks the folder for everyone. Area ids and tokens are never reused.
- **Nested folders.** Every protected ancestor must be satisfied. Each folder's own
  `login.html` and `login-files/` are exempt from that folder only, not from folders
  around it.
- **Sessions.** Sessions are per hostname (`__Host-pammy_visitor`, HttpOnly, SameSite=Lax)
  and last 30 days. They're checked on every request, so switching someone off, a new
  password or removed access takes effect on the next request.
- **Passwords.** scrypt (N=2^15, r=8, p=1). An unknown username costs the same time as a
  wrong password.
- **Sign-in rules.** Sign-in must be a same-origin JSON POST. It's limited to 10 attempts
  per IP per 15 minutes and 20 per username per hour, and `next` can only redirect to a
  path on the same hostname.
- **If the gate is down, the whole static site returns 500s.** That's deliberate: the
  alternative is serving protected files. The gate runs with `Restart=always`.
  Emergency only: `deploy/rollback-gate-nginx.sh` takes the gate out of nginx and makes
  protected folders PUBLIC. It asks you to type UNPROTECT first.
- **The vhost is shared with WordPress.** The WordPress master
  (`../wordpress/pamela-live-wp.nginx`) and placement templates now contain the gate
  lines. The pre-gate versions are kept (`*.pre-gate`, `nginx/templates-pre-gate/`), so
  the installer can check that the live files are exactly one or the other before
  changing anything.

**Why a separate helper, and why it runs as pamela**
- The panel's own sandbox stays closed to `/pamela` entirely.
- Folders the helper creates are hers (pamela:www-data 2755, pages 644), exactly
  like her uploads, so WinSCP and Claude edit them normally. No ACLs, and her web
  root's permission model doesn't change.
- Linux only lets you move a folder to another directory if you can write to that
  folder. Her folders are hers, so only something running as her can trash and
  restore them.
- Running as her needs a tighter sandbox than the panel's:
  - only `/pamela/public` and `/pamela/trash` are writable
  - her home, `/pamela/app`, `/srv`, `/var/lib` and the TLS keys are unreachable
  - `PrivateNetwork` (no network at all), and `NoNewPrivileges` (no sudo)
  - ptrace (`@debug`) is denied, so it can't attach to her other processes, and it has no capabilities
- It trusts nothing from the panel and re-checks every name itself (`src/names.ts`,
  `src/sitefs/ops.ts`). Trash is a `rename` into `/pamela/trash/<name>--<UTC stamp>`,
  never a delete. Purge removes only entries in that format that are older than 30 days.
- The panel logs every create, trash, restore and purge in Activity. The helper logs
  each operation to its journal (`journalctl -u pammy-sitefs`).

| path | what |
|---|---|
| `/opt/pammy-panel` | the release, root-owned (the service can't change its own code) |
| `127.0.0.1:5434` | the panel's Postgres (`pammy-pg`, under `svc-pammypanel-db`): everything the panel and the gate hold |
| `/etc/pammy-panel/db/{owner,panel,gate}.pass` | the database passwords, root 600; the services get theirs through `LoadCredential=`, the command line on fd 3 |
| `/var/lib/svc-pammypanel` | the panel's own state; `/var/lib/pammy-media-public` is what it publishes for the gate |
| `/etc/pammy-panel/panel.env` | origin, RP ID, database host/port/name, port (no secrets) |
| `/etc/nginx/sites-available/pammy-panel` | site; `/etc/nginx/pammy-panel/` has the generated Cloudflare lists |
| `/usr/local/sbin/pammy-panel` | command-line wrapper (runs as svc-pammypanel) |
| `/etc/systemd/system/pammy-sitefs.{socket,service}` | the website folder helper |
| `/pamela/trash` | pamela:pamela 700, outside the web root |
| `/etc/systemd/system/pammy-gate.service`, `pammy-gate-admin.socket` | the gate |
| schema `gate` | protected folders, people, grants, visitor sessions, sign-in events (180 days), forms, responses, keys |
| `/var/lib/svc-pammygate/areas.json` | the areas the gate answers from while Postgres is out of reach (P14) |
| `/etc/nginx/pammy-gate/{gate.conf,uri.conf}` | included by the pamela vhost (both blocks) and WordPress's main.conf |

Ask the helper by hand (as root):
`runuser -u svc-pammypanel -- node /opt/pammy-panel/src/sitefs/call.ts '{"op":"list"}'`

**Security model**
- **Sign-in:** passkeys only (WebAuthn, user verification required, discoverable).
  RP ID is `panel.pammy.org`, not `pammy.org`, so no page on her other hostnames
  can request these passkeys.
- **Sessions:** a 256-bit random token in a `__Host-` cookie (Secure, HttpOnly,
  SameSite=Lax). Lax rather than Strict so a link from email or chat opens the
  panel signed in; changes are still guarded by the Origin check below. Only the
  token's SHA-256 is stored. Every request is checked against the database, so switching an account off or removing a passkey takes effect
  immediately. Sessions end after 8 h idle or 7 days, whichever comes first.
- **Sensitive actions** (adding or removing passkeys, all account management) need
  a passkey check within the last 10 minutes.
- **Setup links:** one-time, 24 h, one live link per account. The token is in the
  URL `#fragment`, so it never reaches Cloudflare, nginx or server logs.
- **Cross-site requests:** every state change is a JSON POST that must carry the
  exact Origin (and `Sec-Fetch-Site: same-origin` when the browser sends it).
- **Browser hardening:** strict CSP (`script-src 'self'`, no inline code, inline styles
  only with the page's nonce), and React only ever renders text (no `dangerouslySetInnerHTML`).
- **Network:**
  - nginx closes connections that don't come from Cloudflare's IP ranges (`return 444`).
  - The app believes `X-Real-IP` only when it comes from localhost.
  - Rate limits apply per visitor IP.
- **systemd sandbox:**
  - `ProtectSystem=strict`, with only the database directory writable
  - `ProtectHome`, and `/pamela` `/srv` and the TLS keys made inaccessible
  - no capabilities, a syscall filter, and no network beyond localhost
- **Roles:** only account managers can manage accounts: momolig, and Pamela since 2026-09-17
  (`sudo pammy-panel role <username> manager|member`; the panel itself only ever makes members,
  and the last active manager can't be demoted or switched off). Everything
  else is equal, and both can see the activity log.

**Cloudflare IP list:** `deploy/cloudflare-ips.txt` is a snapshot. If Cloudflare
adds a range, visitors routed through it get refused (the safe direction).
Refresh the file from https://www.cloudflare.com/ips-v4 and /ips-v6, rebuild and re-install.

## Tests

- Contact forms and Help (2026-09-16): gate +14 (validation, protected pages, snapshots,
  caps, trash/purge, log), panel +7 (API, starter pages, messages, help parsing), helper +4,
  nginx gate test +9 (through the real vhost, 30 KB body). Totals: unit/API 175 (incl. `test/help.test.ts` and media), nginx 16 + 89.
- `test/sitefs.test.ts` (24): the helper's operations on real temp folders. Covers:
  - the name rules match the nginx regex, and reserved names come from the WordPress placement file
  - modes and setgid inheritance; files, links, hidden and `..` names are refused
  - restoring never overwrites anything, and trashing a shortcut leaves its target alone
  - purge honours the 30-day age and leaves foreign entries alone
  - the socket protocol: malformed or oversized requests, refusal codes, an unreachable helper
- `test/gate.test.ts` (51): the gate's decisions on a real folder tree. Covers:
  - symlinks, missing files, nested folders, database-only and unknown markers, renames
  - login pages and login-files, both addresses
  - sign-in: origin, wrong/unknown/switched-off users, access, redirects, hostname-bound sessions, expiry, lockout, rate limits
  - the admin socket's validation, and that no password, link token or contact detail ever reaches its log
  - the five sign-in pages (and nothing else named login-* or logout-*), `about`, the built-in pages, sign-out's next page
  - forgot password (same answer for unknown names, limits), asking for access (validation, trap field, closed folders, caps)
  - setup links: once only, 7 days, a new link or a password set by Pamela or switching the person off cancels it, sessions end, forgot requests close
- `test/run-gate-nginx-test.sh` (77): the REAL new vhost and rendered includes on an
  unprivileged nginx in front of the real gate. Covers:
  - encoded paths, `%2F`, `..`, `//`, symlinks, HEAD, Range, forged `X-Pammy-*` headers
  - the marker file never served, login.html and login-files reachable
  - sign-in through nginx, real IP, cache headers
  - the three new pages reachable (and `login-other.html` not), both forms and a whole setup link through nginx
  - the "path" and "root" WordPress placements, and the gate stopped
- `test/panel.test.ts` (51, including subdomain and protected-folder/people routes: session and recent-auth rules, rename-following and marker repair, activity entries with no passwords, 503 when a helper is down): full API flows with a software authenticator, meaning
  real P-256 keys, CBOR attestation and signatures. Covers:
  - wrong origin, wrong RP ID and no-UV passkeys are refused
  - challenges are single-use, and a counter going backwards is rejected
  - CSRF protection (including cross-site POSTs that carry a valid session cookie), recent-auth, and manager-only actions
  - immediate lockout, idle and absolute expiry
  - rate limits, spoofed IP headers, and the ceremony flood cap
- `test/run-nginx-test.sh` (13): the real site file on an unprivileged nginx in front
  of the real server. Covers:
  - direct-to-origin requests closed, even with a forged `CF-Connecting-IP`
  - http → https redirects
  - headers passed through, oversized bodies refused
  - the visitor IP reaches the app, and other hostnames don't reach the panel

**Only checkable live** (`deploy/verify-panel.sh`):
- the service user's reach
- the sandbox, checked from inside the running service
- Cloudflare-only access on the real IP, and neighbouring sites unaffected
- the helper runs as pamela, only the panel's user can open its socket, and its sandbox is checked from inside
- a real subdomain made, served through Cloudflare, trashed (404), restored, then removed
- the gate's sandbox (reads her site, can't change it, no /var/www, /srv, keys or home), and its admin socket's permissions
- a real protected folder through Cloudflare: redirect at both addresses, sign in, file served `private, no-store` and not cached by Cloudflare, locked out again when switched off
- its starter pages, both forms landing in Requests (then deleted), and a real setup link used through Cloudflare (old session ended, works once)
- a real form on a page (a test form, a response sent through Cloudflare and found, approved, read back through the API with a key, the key revoked, then all removed), and the 11 Help guides installed

- `test/e2e/` (21, Playwright, run by `build.sh`): the whole panel in headless Chromium
  against `test/e2e/server.ts` (the app, helper and gate admin in one process over a
  throwaway site on localhost:3199, seeded with a request, a forgotten password and two
  messages). A virtual WebAuthn authenticator uses a real setup link, then every page is
  driven: sign in and `next`, menu, subdomains and trash, protecting and people, requests,
  the form builder (adding, moving, preview, duplicate, trash) and responses (approve, trash), API keys, media (upload, details, rename, move, trash),
  passkeys, accounts, activity, Help, and a phone viewport (nothing scrolls sideways). Every
  test fails on a console error, an uncaught exception or any CSP violation.
  Run alone: `npm run e2e` (after `npm run web:build`); failures leave a trace in
  `test/e2e/.state/results`.

The gate's visitor components (`public-gate/login.js`, `contact.js`) stay plain JavaScript and
aren't in the browser tests yet; they were driven in jsdom on 2026-09-16.
