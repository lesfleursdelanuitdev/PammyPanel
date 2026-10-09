# Tests

Three layers, all run by `build.sh`. These are not mocked unit tests of
the helpers behind a fake. They boot real sockets and a real Postgres
test container, then speak HTTP.

## Stack and why

- **`node:test`** — no extra runner. `npm test` is
  `node --test test/*.test.ts`.
- **A software passkey authenticator** ([`test/authenticator.ts`](../../test/authenticator.ts))
  so login tests do not need a device.
- **Playwright** — Chromium (and optional WebKit for the iPhone run).
  Virtual WebAuthn. Fail on console errors and CSP violations.
- **nginx harnesses** — the real site files, not a sketch of them.
- **`deploy/verify-panel.sh`** — after install, through Cloudflare.

## API / unit (`test/*.test.ts`)

| File | What it covers |
|---|---|
| `panel.test.ts` | The whole panel API: CSRF, sessions, roles, sites, gate-through-the-panel, forms, media, editor, studio, limited accounts. One `before` boots Postgres + sockets. |
| `gate.test.ts` | `/check`, sign-in, admin socket, forms, examples, look files vs guide 09 |
| `gate-live.test.ts` | Areas snapshot when Postgres is late |
| `sitefs.test.ts` | Helper ops on a temp tree, over a real socket |
| `media-db.test.ts` | Records and labels without HTTP |
| `thumbs.test.ts` | Thumbnailer + sharp |
| `pammydb.test.ts` | Helper ops (harness in `pammydb-harness.ts`) |
| `studio.test.ts` | IR, diff, resources, records (`studio-stub.ts` for a fake engine) |
| `pg.test.ts` | Migrations, the schema they make vs `db/schema.snapshot.sql` (`UPDATE_SCHEMA=1` rewrites it), checks and triggers, roles |
| `routes.test.ts` | Every route vs `routes.snapshot.txt` (`UPDATE_ROUTES=1`) |
| `help.test.ts` | Parser + every real guide in `guides.map` |
| `activity.test.ts` | What gets logged |
| `sandbox.test.ts` | Assumptions the units make |
| `rich-text.test.ts` | `cleanRich` |

`pg-harness.ts` / `pg-serve.ts` start the test Postgres.
`gate-seed.ts` fills a gate schema.

## nginx

- `test/run-nginx-test.sh` — panel.pammy.org site file
- `test/run-gate-nginx-test.sh` — the real pamela vhost + gate `auth_request`

## Browser (`test/e2e/`)

Playwright config in `test/e2e/playwright.config.ts`. Auth setup with
virtual WebAuthn (`auth.setup.ts`). Specs numbered roughly in the order
the product grew: shell, home, subdomains, protected folders, people,
requests, forms, responses, media, file explorer, editor, tags,
databases, canvas, relationships, app records, programs, examples,
passkeys/accounts, help, limited account, phone, screenshots (`zz-shots`).

`test/e2e/server.ts` is a panel+gate on `:3199` for those tests (passkeys
need a real origin; Vite `:5173` is not enough).

## Live verify

`deploy/verify-panel.sh` — sandbox reachability, Cloudflare-only access,
a real subdomain / protect / form flow. Running it more than five times
an hour can trip per-IP limits (429), which is expected.

## See also

- [deploy.md](deploy.md), [01-stack.md](01-stack.md)
- README "How it's built"
