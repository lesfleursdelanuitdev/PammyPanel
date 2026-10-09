# The house

The control panel is not one program. It is five small processes, one Postgres
with three schemas, and her two database engines that only one helper may
touch. That split is the security model. The panel never writes her website
itself. The gate never sees panel accounts. Sitefs runs as pamela. Pammydb
never reaches the host's production Postgres.

```
visitor  -> Cloudflare -> nginx :443  ->  pammy-gate  127.0.0.1:3045
manager  -> Cloudflare -> nginx :443  ->  pammy-panel 127.0.0.1:3044

pammy-panel
  |  Postgres 127.0.0.1:5434   schemas panel + media   (role pammy_panel)
  |  /run/pammy-gate-admin.sock                        (schema gate, via the gate)
  |  /run/pammy-sitefs.sock                            (as pamela: /pamela/public, /pamela/trash)
  |  /run/pammy-thumbs.sock                            (WebP, no network)
  |  /run/pammy-pammydb.sock                           (her MariaDB :3307, her Postgres :5433)

pammy-gate
  |  Postgres 127.0.0.1:5434   schema gate             (role pammy_gate)
  |  reads /pamela/public as www-data
  |  /run/pammy-pammydb.sock   for the public data API
  |  reads the media index the panel published
```

Visitors never go through the panel. Managers never go through the gate's
public HTTP. The admin socket is the only way the panel asks the gate to
change people, forms, or responses.

## The five processes

| Process | Entry | Listens | Runs as | Job |
|---|---|---|---|---|
| **panel** | [`src/server.ts`](../../src/server.ts) | `127.0.0.1:3044` | `svc-pammypanel` | The private website at panel.pammy.org |
| **gate** | [`src/gate/main.ts`](../../src/gate/main.ts) | `:3045` + admin socket | `svc-pammygate` | Front door of pammy.org; visitor sign-in; public APIs |
| **sitefs** | [`src/sitefs/main.ts`](../../src/sitefs/main.ts) | `/run/pammy-sitefs.sock` | **pamela** | The only process that writes `/pamela/public` and `/pamela/trash` |
| **pammydb** | [`src/pammydb/main.ts`](../../src/pammydb/main.ts) | `/run/pammy-pammydb.sock` | `svc-pammypanel` (studio passwords) | The only process that speaks to her MariaDB and her Postgres |
| **thumbs** | [`src/thumbs/main.ts`](../../src/thumbs/main.ts) | `/run/pammy-thumbs.sock` | its own user | One thumbnail at a time; no network; nowhere writable but its `/tmp` |

Each helper speaks the same tiny protocol: one JSON object per connection, one
JSON line back ([`src/jsonline.ts`](../../src/jsonline.ts)). Uploads add raw
bytes after the request line. The helper checks every name again, whatever the
panel already checked.

## The three schemas

One Postgres (`pammy` on `127.0.0.1:5434`, the `pammy-pg` container). Three
schemas, three roles. The panel has **no** rights on `gate`. The gate has
**no** rights on `panel` or `media`.

| Schema | Who uses it | What lives there |
|---|---|---|
| `panel` | panel | Accounts, passkeys, panel sessions, activity, studio overlay (`studio_*`) |
| `media` | panel | One row per file, tags, categories, scopes |
| `gate` | gate | Protected folders, visitors, grants, forms, responses, API keys, app keys |

Her *row data* is not here. It lives in her MariaDB (`:3307`) and her Postgres
(`:5433`). The panel only stores drawings, names, and which databases it
manages. See [database.md](database.md) and [pammydb.md](pammydb.md).

## Two cookies, two worlds

| | Panel | Gate |
|---|---|---|
| Who | Pamela, momolig, a folder-limited helper | People she lets into a private folder |
| How they sign in | A passkey (face, fingerprint, PIN) | Username and password |
| Cookie | `__Host-pammy_panel` | `__Host-pammy_visitor` |
| How long | Idle 8 hours, max 7 days | 30 days |
| Host | `panel.pammy.org` only | `pammy.org` and `*.pammy.org` |

`__Host-` means Secure, Path=/, no Domain. A page on recipes.pammy.org cannot
set or read the panel cookie, and the other way round.

## What nginx does

Cloudflare IPs only. Then:

- `panel.pammy.org` → `127.0.0.1:3044`
- `pammy.org` / `<folder>.pammy.org` → for each static file, nginx asks the
  gate `GET /check` (`auth_request`). 204 means serve the file. 401 means
  send the visitor to that folder's `login.html` (or the built-in
  `/_pammy/login`). Paths under `/_pammy/` go to the gate itself.

See [deploy.md](deploy.md) and [gate.md](gate.md).

## Housekeeping

The panel, once an hour: expired WebAuthn ceremonies, long-dead sessions,
tell sitefs to purge trash older than 30 days, forget stale thumbnails.

The panel, every 15 minutes: sync media records with the folders on disk
(WinSCP and Claude change files too).

The gate, once an hour: its own expired sessions and links.

## See also

- [01-stack.md](01-stack.md) — why these libraries
- [panel.md](panel.md), [gate.md](gate.md), [sitefs.md](sitefs.md), [pammydb.md](pammydb.md), [thumbs.md](thumbs.md)
- Operator README, "How it's built"
- [`docs/postgres-plan.md`](../postgres-plan.md)
