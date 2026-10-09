# Deploy

How this code becomes the live services. Operator steps stay in the
[README](../../README.md). This page names the files and why they are
shaped that way.

## Stack and why

- **systemd** — one unit (or socket) per process. Socket activation for
  the helpers: they start when the panel first connects.
- **nginx** — TLS, Cloudflare IPs only, `auth_request` to the gate,
  `proxy_request_buffering off` on the 100 MB upload location.
- **Cloudflare** in front. Free-plan upload cap is why media max is 100 MB.
- **`pammy-pg`** — rootless container, Postgres on `127.0.0.1:5434` only.
  See [`deploy/pg/README.md`](../../deploy/pg/README.md).
- **No PHP on the host.** WordPress is planned as a container.

The panel unit cannot see `/pamela`. Sitefs can write only `/pamela/public`
and `/pamela/trash`. Thumbs has no network. Pammydb may use loopback and
is pinned to `:3307` and `:5433`.

## Files

| File | Job |
|---|---|
| `build.sh` | Typecheck, Vite (web + widgets), tests (API, nginx, Playwright), assemble `release/` |
| `deploy/install-panel.sh` | Copy `release/` to `/opt/pammy-panel`, migrate, restart, sync her guides (`../sync-pamela-guides.sh`), verify. Refuses a stale build. Rolls back to `/opt/pammy-panel.prev` if unhealthy. |
| `deploy/verify-panel.sh` | Live checks through Cloudflare |
| `deploy/panel.env` | `PANEL_ORIGIN` and sockets. Sourced by the unit and the CLI wrapper. |
| `deploy/pammy-panel.service` | Node, `LoadCredential=db.pass`, tight sandbox |
| `deploy/pammy-gate.service` + `pammy-gate-admin.socket` | HTTP `:3045` + admin socket |
| `deploy/pammy-sitefs.service` + `.socket` | As pamela |
| `deploy/pammy-pammydb.service` + `.socket` | Group `pammydb-clients` |
| `deploy/pammy-thumbs.service` + `.socket` | Own user, no network |
| `packages/core/nginx/panel.conf` (a template, rendered from the profile) | panel.pammy.org |
| `packages/core/nginx/gate.conf` + `uri.conf` (templates; `php.conf` is the php module's) | pammy.org `auth_request`; `$uri` must be set *inside* each location |
| `deploy/rollback-gate-nginx.sh` | Emergency: make protected folders public |
| `cloudflare-ips.txt` (rendered by `tools/render-nginx.ts`, `@panel/core/nginx`) | nginx real_ip from CF |
| `deploy/pammy-panel-cli` | `/usr/local/sbin/pammy-panel`: switch user, load env, pass the password fd |
| `deploy/studio/roles-*.sql.in` | Studio role on her engines |
| `deploy/pg/*` | Install, backup, verify the panel's Postgres |

## `build.sh` extras

- Refuses to run as root.
- Needs Node ≥ 22.18.
- Rich-text chunk gzipped ≤ 160,000 bytes (phone; `docs/rich-text-plan.md` T28).
- Copies `src`, `public`, `public-gate`, `db`, `tools`, and Help guides
  (from `../guides.map`). Production `npm ci --omit=dev` inside `release/`.
- A guide edited after `build.sh` makes the installer refuse (S6).

## First account

```
sudo pammy-panel add-user momolig "momolig" --manager
sudo pammy-panel invite momolig
```

That is also the way back in if every manager passkey is lost.

## See also

- [00-map.md](00-map.md), [database.md](database.md), [cli.md](cli.md)
- README "Deploy / update"
