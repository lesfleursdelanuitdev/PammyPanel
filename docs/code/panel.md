# The panel process

The private website at `https://panel.pammy.org`. Account holders sign in with
a passkey. The process serves the React app and the JSON API. It never writes
her files or her databases itself: it asks the helpers over sockets.

Entry: [`src/server.ts`](../../src/server.ts) calls `buildApp()` in
[`src/app.ts`](../../src/app.ts), then listens on `127.0.0.1:3044`.

## Stack and why

- **Fastify 5** — one origin, JSON POSTs. See [01-stack.md](01-stack.md).
- **`postgres.js`** — schemas `panel` and `media` only.
- **`@simplewebauthn/server`** — passkeys; RP ID `panel.pammy.org`.
- **No session library** — [`src/sessions.ts`](../../src/sessions.ts).
- **The built React app** is read from `public/index.html` once at startup.
  Every page address gets that same HTML with a fresh CSP nonce.

## How it talks to the rest

- Postgres on `:5434` as role `pammy_panel`
- Gate admin socket — people, forms, responses (no rights on schema `gate`)
- Sitefs socket — folders, media bytes, the editor
- Thumbs socket — WebP
- Pammydb socket — her engines
- Cookie `__Host-pammy_panel` on `panel.pammy.org`

nginx in front, Cloudflare IPs only. See [deploy.md](deploy.md).

## Important types

- `Config` — [`src/config.ts`](../../src/config.ts). Origin, sockets, Postgres, where thumbs live. `now()` is unix seconds; tests replace it.
- `Authed` — `{ session, user }` after `lookupSession`.
- `UserRow` — an account: `role` is `manager` or `member`; `scope` is `/olivia` or null.
- `AccountError` — a refusal with an HTTP status. The error handler turns it into `{ error, message }`.

## Function catalog — boot and the app

### `loadConfig(env)` — src/config.ts

Reads `PANEL_ORIGIN` (required) and the rest from the environment. Production
values come from `/etc/pammy-panel/panel.env`, so the service and
`sudo pammy-panel` always agree.

### `buildApp(config, db, opts)` — src/app.ts

Builds the Fastify instance: security headers, CSRF check, the SPA pages, every
`/api/…` route. `opts.media` and `opts.thumbs` are the shared sync and
thumbnailer `server.ts` already started. Tests call `buildApp` too.

### `server.ts` housekeeping

Once an hour: delete expired ceremonies, forget sessions that have been dead
30 days, tell sitefs `op: purge`, clean leftover thumbs. Every 15 minutes:
media sync. Activity rows are kept.

### `PAGE_PATHS` — src/app.ts

The addresses the server will send the SPA for. Keep in step with the routes
in [`sites/pammy/web/src/App.tsx`](../../sites/pammy/web/src/App.tsx). Signed out, those addresses
redirect to `/login?next=…`.

### `nextPage(next)` — src/app.ts

After signing in, only a panel path is allowed back. Not `/login`, `/invite`,
`/api`, `/assets`, and not `//evil`.

### `need(req, reply, level)` — src/app.ts

"May this request go on?" Signed out → 401. A folder-limited account on a
route outside `LIMITED_ROUTES` → 404. A member on a manager route → 403. A
fresh passkey required (`recent` / `manager-recent`) and the last tap was
more than 10 minutes ago → 403 `reauth-required`.

`level` is `user`, `recent`, `manager`, or `manager-recent`.

HTTP routes live on the feature pages: [auth.md](auth.md), [media.md](media.md),
[files.md](files.md), [forms.md](forms.md), [visitors.md](visitors.md),
[studio.md](studio.md).

## Function catalog — sessions

### `SESSION_COOKIE`

`__Host-pammy_panel`. Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.

### `sessionCookie(token)` / `clearedSessionCookie()`

Set and clear the cookie. Max-Age is 7 days (`SESSION_MAX`).

### `readCookie(header, name)`

Finds one cookie in a `Cookie` header. Used for both panel and visitor cookies.

### `createSession(db, now, userId, passkeyId, ip, userAgent)`

Stores `token_hash` only. Returns the raw token for the Set-Cookie header.

### `lookupSession(db, now, token)`

Checked on every request. Null if the token is wrong, revoked, past
`expires_at`, idle more than 8 hours, or the account is off. Touches
`last_seen_at` at most once a minute.

### `startCeremony` / `takeCeremony`

A WebAuthn challenge: kind `login` | `invite` | `add-passkey` | `reauth`,
five minutes, one use. `takeCeremony` deletes it as it reads, so a second
tab cannot reuse it.

## Function catalog — security

### `SECURITY_HEADERS` — src/security.ts

CSP (`default-src 'none'`, scripts only `'self'`), nosniff, no referrer,
COOP/CORP, Permissions-Policy empty, HSTS, `Cache-Control: no-store`.
`style-src-attr 'unsafe-inline'` is the one loosening: a nonce cannot cover
a style *attribute*, and the upload bar, form preview, and schema canvas all
set `style=`. A `<style>` element is still refused unless it carries the
page nonce.

### `pagePolicy(nonce)`

The page CSP: the API policy, plus `'nonce-…'` on `style-src`, plus
`frame-src https://pammy.org` so Help can show the example sign-in pages.

### `clientIp(req)`

Trusts `X-Real-IP` only when the peer is localhost (nginx). Otherwise the
socket address.

### `checkSameOrigin(req, reply, origin)`

GET/HEAD pass. POST must have `Origin` equal to the panel origin,
`Sec-Fetch-Site` absent or `same-origin`, and `Content-Type` JSON — or the
upload exception (`/api/media/upload` or `/api/files/upload`,
`application/octet-stream`, header `X-Pammy-Name`).

### `RateLimiter`

Fixed windows in memory. A restart forgets them, which only ever makes
limits more lenient.

## Function catalog — Postgres helper

### `connectPg(opts)` — src/pg.ts

Pool as `pammy_panel`, `pammy_gate`, or `pammy_owner`. `search_path` is set
in the startup message. Password from a file, a systemd credential, or an
open fd (the CLI wrapper: the panel user may not read the file).

### `checkSchema(sql)`

On boot: the migrations table matches what this code expects. The panel
waits and retries; the gate does not (it starts before Postgres at boot).

### `tx` / `all` / `one` / `run`

Transactions retry a few times on conflict. `?` placeholders are rewritten
to `$1`. `all` / `one` / `run` are the three shapes every table helper uses.

### `isPgUnavailable` / `PgUnavailable`

The gate uses these when Postgres is not there yet, and serves from the last
saved areas file instead of guessing.

## Function catalog — jsonline (shared with every helper)

### `createJsonLineServer(handle, log, opts)` — src/jsonline.ts

One JSON object per connection, one JSON line back. Default inbound line
64 KB, idle 10 s. `streams` marks ops that then read or write raw bytes.
`allowHalfOpen`: an upload ends its side and still needs the answer.

### `callJsonLine` / `callJsonLineUpload` / `callJsonLineRead`

The client's three shapes. Replies may be up to 4 MB. `CallError` carries
the helper's `code` (`invalid`, `not-found`, `exists`, …).

### `SENT`

A stream handler that already called `send()` returns this so the server
does not write a second line.

## Function catalog — accounts (shared with the CLI)

The same functions the API and `sudo pammy-panel` both call, so they cannot
disagree. Full list on [auth.md](auth.md) and [cli.md](cli.md). The types
`UserRow`, `PasskeyRow`, `Actor`, `COMMAND_LINE`, and `AccountError` live
in [`src/accounts.ts`](../../src/accounts.ts).

## See also

- [00-map.md](00-map.md), [01-stack.md](01-stack.md), [auth.md](auth.md)
- Operator README, "How it's built"
- Guide 08, PART 1 (passkeys)
