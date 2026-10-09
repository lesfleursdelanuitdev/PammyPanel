# Studio (her databases in the panel)

The manager-only workspace: adopt or create a database on her MariaDB or
Postgres, draw the schema, review a diff, apply it through pammydb, then
use a generated app (`/app/…`) and optionally publish a data API.

The helper is dumb SQL ([pammydb.md](pammydb.md)). This page is the
opinionated layer: Resources, the canvas, drafts, keys.

## Stack and why

- **React Flow (`@xyflow/react`)** — the canvas. Tables are positioned with
  style attributes (that is why CSP allows `style-src-attr`).
- **TipTap** — rich text fields in the generated app.
  [`src/studio/rich-text.ts`](../../src/studio/rich-text.ts) sanitises
  (`sanitize-html`) before anything is stored.
- **IR in `src/pammydb/ir.ts`**, diff in `src/studio/diff.ts`. The panel
  draws; the helper applies.
- **Catalog copy in schema `gate`**, pushed over the admin socket, so the
  public data API does not query `panel`.

All of these routes are `manager` (many `manager-recent`). Not on
`LIMITED_ROUTES`. Engines spelled `postgres` and `mariadb` (S11).

## How it talks to the rest

Panel `/api/databases*` `/api/app*` `/api/apps` → pammydb socket +
`studio_*` tables + gate `catalog.*` / `appkeys.*`. Gate
`/_pammy/api/data/:engine/:name/:resource…` with a Bearer app key.

## Important types

- `Snapshot` — tables, columns, keys, relationships (storage, not UI).
- `ResourceView` — a table as an app thing: labels, abilities, field
  controls (`line` / `paragraph` / `rich` / `picker` / …).
- `DatabaseCard` — live engine facts merged with what the panel manages.
- `Catalog` — what the data API may expose, pushed to the gate.

## Panel routes — the shelf

### `GET /api/databases` / `POST /api/databases`

List (merge live + managed). Create on an engine.

### `GET /api/databases/:engine/:name` / `POST …/settings` / `adopt` / `unmanage` / `delete`

One database. Display name. Adopt one she already has (including `pamela`).
Stop managing (does not drop the engine database). Delete drops it
(`recent`).

### `GET /api/databases/home` / `GET /api/apps`

Dashboard cards, and the menu entries for activated apps (from panel
tables, so a sleeping engine never holds the menu up).

## Panel routes — users (logins)

### `GET /api/databases/users` / `POST /api/databases/users`

### `GET|POST /api/databases/users/:engine/:user` … `/note` `/password` `/delete` `/access`

### `GET /api/databases/:engine/:name/users`

Notes live in the panel; passwords and grants go through pammydb. The four
roles are read back from the engine (S13).

## Panel routes — schema, canvas, review

### `GET /api/databases/:engine/:name/schema` / `POST …/draft` / `discard`

Introspect + current draft. Save a draft (the drawing). Discard.

### `POST …/schema/layout` / `tidy` / `relationship` / `relationship/on-delete` / `relationship/delete`

Canvas positions; tidy; add/remove a relationship and its on-delete.

### `GET …/schema/review` / `POST …/schema/apply`

The diff (`plan` / `describe` / `impactOf`). Apply sends the patch and
`expect` to pammydb, then carries renames into Resources.

## Panel routes — the generated app

### `GET /api/databases/:engine/:name/app` / `POST …/app/:table/settings` / `fields/:field/settings` / `forget`

Resource and field settings (controls, abilities, public-only).

### `POST …/api` / `GET|POST …/keys` / `POST …/keys/:id/revoke` / `activate` / `deactivate`

Public data API flag, app keys (gate), show this database in the panel menu.

### `GET /api/app/:engine/:name/:table` / `pick/:field` / `one`

### `POST /api/app/:engine/:name/:table/new` / `save` / `delete`

Record list, picker, one row, create, update, delete. The panel reduces
the body to the Resource's window (`valuesFor`, `whereFor`) and then calls
pammydb. Rich text is cleaned on the way in.

## Panel routes — examples

### `GET /api/databases/examples` / `:kind` / `POST …/setup` / `copy`

Recipes and blog. Setup seeds an engine database; copy puts a page on her
site (same `install-pages` idea as form examples).

## Functions — studio/

| File | Job |
|---|---|
| `databases.ts` | `mergeDatabases`, start/stop managing, display name |
| `users.ts` | `mergeUsers`, notes, `newDbPassword` |
| `schema.ts` | draft save/read/rebase, `schemaView`, `stillToDo` |
| `layout.ts` | canvas positions, `tidy`, `placed` |
| `relationships.ts` | derive, add, remove, on-delete |
| `diff.ts` | `diff`, `plan`, `describe` |
| `impact.ts` | what Apply will do to the app |
| `resources.ts` | kinds, controls, abilities, patches |
| `resource-store.ts` | `studio_resources` / `studio_fields` |
| `records.ts` | list/get/create/edit window onto a Resource |
| `connect.ts` | labels and links for the record picker |
| `catalog.ts` | `buildCatalog` / `readCatalog` for the gate |
| `rich-text.ts` | `cleanRich`, `fromPlain`, `plainOf` |
| `db-examples.ts` | recipes / blog seeds |

`checkDraft` / `checkLayout` / `checkSpec` / `checkResourcePatch` /
`checkFieldPatch` refuse a drawing the browser sent that the engine would
not take, with the same codes the socket uses.

## Public data API (gate)

[`src/gate/data-api.ts`](../../src/gate/data-api.ts).
`/_pammy/api/data/:engine/:name/:resource`. Bearer app key. The gate holds
a catalog copy and talks to pammydb itself. The helper still does not know
what a Resource is: the catalog already named the table and columns.

## See also

- [pammydb.md](pammydb.md), [web.md](web.md)
- [`docs/studio-plan.md`](../studio-plan.md), [`docs/databases-plan.md`](../databases-plan.md),
  [`docs/record-picker-plan.md`](../record-picker-plan.md), [`docs/rich-text-plan.md`](../rich-text-plan.md)
- Guides 13 and 14
