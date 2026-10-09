# The gate process

The front door of `pammy.org` and every `<folder>.pammy.org`. nginx asks it
`GET /check` before serving a static file. It also serves the visitor
widgets, the built-in sign-in pages, form posts, and the public form / media
/ data APIs.

It does **not** serve her HTML files. nginx does that, after a 204.

Entry: [`src/gate/main.ts`](../../src/gate/main.ts) (pammy.org; lfdln's is [`sites/lfdln/src/gate/main.ts`](../../sites/lfdln/src/gate/main.ts), both `startGate()` in [`packages/gate/src/start.ts`](../../packages/gate/src/start.ts)) → `buildGateApp()` in
[`packages/gate/src/app.ts`](../../packages/gate/src/app.ts), HTTP on `127.0.0.1:3045`, plus
the admin socket systemd hands it.

## Stack and why

- **Fastify 5** on loopback only, same as the panel.
- **`postgres.js` as role `pammy_gate`** — schema `gate` only. No rights on
  `panel` or `media`.
- **Visitor passwords are scrypt**, not passkeys. A visitor is someone she
  lets into a folder, not an account holder.
- **No network.** Forgot-password and "ask for access" write rows. Pamela
  sends the links. Nothing is emailed.
- **Starts without waiting for Postgres.** At boot a system service cannot
  wait for a user one. Until Postgres answers, it uses the last areas
  snapshot (`live.ts`, P14). Nothing is let through on a guess: no snapshot
  yet means 503 inside protected folders.

## How it talks to the rest

- Reads `/pamela/public` as www-data (the same view nginx has)
- Schema `gate` on `:5434`
- Admin socket `/run/pammy-gate-admin.sock` — only `svc-pammypanel` may
  open it. The panel has no SQL on `gate`.
- Pammydb socket — the public data API (`/_pammy/api/data/…`)
- Media index the panel published under `/var/lib/pammy-media-public`
- Cookie `__Host-pammy_visitor`, 30 days, hostname-bound

## Important types

- `Resolved` — after following symlinks: outside, unreadable, or `ok` with
  the chain of protections on that path.
- `Protection` — one locked folder on the way: its area (or a marker the
  database does not know, which locks everyone), and whether this request
  is an exempt sign-in page.
- `Decision` — allow, or 401 to a login URL.
- `Access` — who is signed in, and which areas they may open. Looked up
  before `decide`, so the decision itself never waits on Postgres.
- `GateLive` — in-memory copy of areas, refreshed from Postgres, snapshotted
  to disk for the next boot.

## Function catalog — the decision

### `GET /check`

nginx `auth_request`. Headers `X-Pammy-Base` (`/` or `/<folder>`) and the
exact `$uri` about to be served. Missing or malformed base → 403 (fail
closed). 204 → serve the file (and `Cache-Control: private, no-store`
inside a protected folder). 401 → nginx redirects to the login URL in
`X-Pammy-Login`.

### `resolve(areas, publicRoot, uri)` — src/gate/policy.ts

Walks the real path. A shortcut into a locked folder is locked too. A
missing file inside a locked folder still asks for sign-in, so you cannot
probe what exists.

### `readMarker(dir)` / `markerText(token)`

The file `.pammy-protected` holds `pammy-protected <token>`. A marker the
database does not know locks the folder for everyone. A folder is also
protected if the database lists its path (the marker was deleted).

### `needsVisitor(r)` / `decide(r, access)`

Whether this path needs a signed-in visitor, and whether *this* visitor
may open it. Exempt: the five sign-in pages (`login.html`,
`login-forgot.html`, `login-invite.html`, `login-request.html`,
`logout.html`) sitting directly in that folder, plus look-files in
`login-files/` (css, pictures, fonts). Any other `login-*.html` stays
locked. Names are exact, so a party `invite.html` never becomes public by
accident.

### `loginUrl` / `pageUrl` / `folderHome` / `safeNext`

Where to send someone who is not allowed in. `next` is only a path on this
site. A protected folder with no `index.html` goes to `/_pammy/welcome`
instead of nginx's 403 listing-off page.

### `PAGES` / `PAGE_FILES` / `LOOK_FILE_RE`

The five filenames, and what `login-files` may serve before sign-in.

## Function catalog — public HTTP

Documented in the header of [`packages/gate/src/app.ts`](../../packages/gate/src/app.ts).
Visitor auth pages and posts are here; form and media APIs have their own
pages.

### `GET /_pammy/login.js` / `GET /_pammy/forms.js`

The visitor widgets. `login.js` is `Cache-Control: no-store` (Cloudflare's
Browser Cache TTL used to pin an old copy for four hours). Built-in pages
load `login.js?v=<first 12 hex of sha256>` so a change is a new URL.

### `GET /_pammy/<kind>`

Built-in login / forgot / invite / request / logout / welcome, for a
folder that has no page of its own.

### `GET /_pammy/about`

Which of the five pages this folder has, and whether requests are open.
The components use it to draw "Forgot your password?" and "Ask for access".

### `GET /_pammy/me`

Who is signed in on this hostname, or `{ signedIn: false }`.

### `GET /_pammy/folder`

What a signed-in visitor may open in a folder with no home page (the
welcome list).

### `POST /_pammy/login` / `logout` / `forgot` / `request` / `invite` / `invite/check`

Sign in, sign out, forgot-password request, ask-for-access, choose a
password from a setup token. Details on [visitors.md](visitors.md) and
[widgets.md](widgets.md).

### `GET|POST /_pammy/forms/:name` / `GET /_pammy/form-preview`

See [forms.md](forms.md).

### `GET /_pammy/api/forms/…` / `GET /_pammy/api/media/…` / `GET /_pammy/api/data/…`

See [forms.md](forms.md), [media.md](media.md), [studio.md](studio.md).

### `GET /_pammy/examples/…`

Example looks (garden, evening, postcard) and worked form examples
(guestbook, rsvp, pinboard). `frame-ancestors https://panel.pammy.org`.
On the look pages, `login.js` runs in preview mode: nothing is sent.

## Function catalog — visitor store

[`src/gate/store.ts`](../../src/gate/store.ts) and
[`src/gate/passwords.ts`](../../src/gate/passwords.ts). People, grants,
sessions, setup links, requests. The panel reaches these only through the
admin socket.

Setup links store the token's SHA-256. One live link per person, 7 days,
one use. The token sits in the URL `#fragment`; the page strips it.

Forgot-password always gives the same answer. Only a real username becomes
a request. Ask-for-access has a hidden trap field: filled in, it reports
success and stores nothing.

## Function catalog — admin socket

[`packages/gate/src/admin.ts`](../../packages/gate/src/admin.ts) `handleAdmin`. The panel's
`gate()` helper in `app.ts` is the client. A folder-limited account may
only call `SCOPED_OPS` (forms and responses). Contact details never reach
the socket log: the log is op, id or path, and actor.

| `op` | What it does |
|---|---|
| `state` | Areas, visitors, grants, for the People / Protected folders tabs |
| `area.create` / `move` / `requests` / `delete` | Protect a folder, rename the path, requests switch, unprotect |
| `visitor.create` / `rename` / `contact` / `password` / `active` / `delete` / `signout` | A person |
| `grant` | May this person open this folder |
| `link.create` / `cancel` | Setup link (the gate builds the URL because it can see her files) |
| `request.resolve` / `delete` | Approve, decline, or forget a request |
| `forms.state` / `form.*` | Forms. See [forms.md](forms.md) |
| `starters` / `examples.*` | Form fixtures |
| `responses.*` / `response.*` | Inbox |
| `apikeys.*` | Form/media Bearer keys |
| `catalog.*` / `appkeys.*` | Studio public data API |
| `housekeeping` | Expired sessions and links |

### `createGateAdminServer` / `GateLive`

Socket server, and the in-memory areas used by `/check` so a Postgres hiccup
does not open the site.

## See also

- [visitors.md](visitors.md), [forms.md](forms.md), [widgets.md](widgets.md)
- [`docs/forms-plan.md`](../forms-plan.md)
- Guide 09 (protected folders), guide 10 (forms)
