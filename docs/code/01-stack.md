# Stack and why

This is the whole house. Each part page repeats only the slice it owns.
Reasons here are ones already written in the tree (README, comments, plan
files). If a why was never written down, it says so.

## Runtime

**Node 22 (engines: `>=22.18`) running `.ts` directly.** The server has no
compile step. `build.sh` typechecks, builds the two front ends, runs tests,
and copies a `release/` tree. Production is `node src/server.ts` from
`/opt/pammy-panel`. TypeScript is a devDependency; Node's type stripping
does the rest.

**Vite only for the pages (`packages/*/web`) and the widgets (`packages/*/widgets`).** The panel UI becomes hashed
files under `public/`. The visitor widgets become two IIFE scripts under
`public-gate/`. The gate and the helpers are not bundled.

## Panel HTTP

**Fastify 5.** One origin, JSON bodies, a 64 KB default limit (uploads are
a separate parser). We do not use Express middleware. Every state change is
a POST. There is no PATCH or DELETE anywhere (`docs/studio-plan.md` S10);
the web client only speaks GET and POST, and `checkSameOrigin` expects JSON
(or the one upload exception).

**No session library.** Cookie `__Host-pammy_panel`, HttpOnly, Secure,
SameSite=Lax. Only a hash of the token is stored. Checked against the
database on every request, so switching an account off takes effect at
once. Lax, not Strict: Strict would drop the cookie when you arrive from a
link, and you would see the sign-in page while signed in.
[`src/sessions.ts`](../../src/sessions.ts).

**CSRF is Origin + JSON**, not a hidden token. Browsers send Origin on
POST. A form on another site cannot send `application/json` without a CORS
preflight, which this app never answers. Uploads are the one exception: raw
bytes plus `X-Pammy-Name`, which another site cannot send without a
preflight either. [`src/security.ts`](../../src/security.ts).

## Passkeys

**`@simplewebauthn/server` (and `@simplewebauthn/browser` in the UI).**
Passkeys only on the panel — no passwords for account holders. Relying
party ID is `panel.pammy.org`, not `pammy.org`, so a page on her other
hostnames cannot ask for these keys. User verification required. Ceremonies
live five minutes and are single-use.

Visitor sign-in on pammy.org is **username + password (scrypt)**, not
passkeys. A visitor is not an account holder. Different cookie, different
host, different threat.

## Databases

**`postgres.js` for the panel's own Postgres** (`pammy` on `127.0.0.1:5434`,
the `pammy-pg` container). Role `pammy_panel` sees schemas `panel, media`.
Role `pammy_gate` sees schema `gate`. Ids come back as JavaScript numbers
(they are far below 2^53). [`src/pg.ts`](../../src/pg.ts),
[`docs/postgres-plan.md`](../postgres-plan.md).

**`mysql2` and a second `postgres.js` pool, only inside pammydb**, for her
MariaDB (`:3307`) and her Postgres (`:5433`). The helper's unit pins those
ports. Ports `5432` (host Postgres, other people's data) and `5434` (the
panel's own) are refused at config load, so a mistyped unit fails to start
instead of connecting to production (`docs/studio-plan.md` S7).

No ORM. Queries are written out. The helper is "dumb SQL": it does not know
what a Resource is.

## Files and pictures

**Sitefs uses Node's `fs`, nothing else.** Every path is checked, shortcuts
are never followed, nothing is overwritten (temp file, then `link()` under
the first free name).

**`sharp` plus ffmpeg plus pdftoppm**, only in the thumbs process. One file
at a time, per-file limits, no network. The panel stores the WebP it was
given; the gate can serve those thumbs too.

**`sanitize-html`** for HTML that must not keep a script (rich text in the
studio; not the Help parser, which is its own small reader in
[`src/help.ts`](../../src/help.ts)).

## The React app (`packages/*/web`, put together by `sites/pammy/web`)

| Piece | Why |
|---|---|
| React 19 | The pages. Built 2026-09-17. |
| react-router 8 | Every tab is a real address (`/media?folder=recipes`). Old `/#tab` links are rewritten on arrival. |
| TanStack Query | `GET /api/…` with a shared client. Changes go through `useAction`, which asks for a passkey when the server wants one. |
| Tailwind 4 + Vite plugin | Layout. |
| Radix (`radix-ui`) written into `packages/core/web/components/ui` | Dialogs, sheets, switches. No toast library: sonner injects CSS, which CSP would refuse. |
| lucide-react | Icons. |
| Inter / Bricolage Grotesque + Atkinson Hyperlegible, self-hosted | `font-src 'self'`. |
| CodeMirror 6 | The file editor (html/css/js/md/json/xml/svg). |
| TipTap + StarterKit | Rich text fields in the generated database app. |
| `@xyflow/react` | The schema canvas. Tables are positioned with style attributes, which is why CSP allows `style-src-attr 'unsafe-inline'` and nothing wider. |

The server reads `public/index.html` once and sends it for every page
address, swapping in a fresh CSP nonce. `public/` is generated. Do not edit
it.

## Visitor widgets (`packages/*/widgets`, built by `sites/pammy/widgets`)

**Lit 3**, built to one IIFE per widget so her page can load
`<script src="/_pammy/login.js" defer>` with no modules. Light DOM (no
shadow root) so her CSS can reach the fields. Built-in styles sit in
`:where()`, the weakest CSS there is, so any rule on her page wins.
`styles="off"` leaves them out. Shared class names (`pammy-box`,
`pammy-form`, …) are the contract with guides 09 and 10.

## Front door

**Cloudflare → nginx (Cloudflare IPs only) → 127.0.0.1.** The Node
processes do not face the internet. nginx does `auth_request` to the gate
for every static file on pammy.org. Uploads of 100 MB are Cloudflare's
free-plan limit; nginx turns buffering off for that one location.

No email leaves the server. Forgot-password and "ask for access" create
rows the Requests tab shows. Pamela sends the links. The gate keeps a
no-network sandbox.

No PHP on the host. WordPress, when it comes, is planned as a container
through a narrow root helper (README phase list). Not built yet.

## Tests

**`node:test`** against a real Postgres test container and real Unix
sockets (sitefs, gate admin, thumbs, pammydb). A software passkey
authenticator stands in for a device. These are not mocked unit tests.

**Playwright** for the browser, including a virtual WebAuthn authenticator,
phone viewport, and a fail on console errors / CSP violations.

**`deploy/verify-panel.sh`** from the server, through Cloudflare, after an
install.

## See also

- [00-map.md](00-map.md)
- [`package.json`](../../package.json)
- [`docs/postgres-plan.md`](../postgres-plan.md), [`docs/studio-plan.md`](../studio-plan.md)
