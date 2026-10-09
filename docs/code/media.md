# Media

A record of every file in a `media/` folder (and, for File Explorer, every
file on the website). The bytes live on disk, as pamela, through sitefs.
The record lives in schema `media`. Tags and categories live there too.

## Stack and why

- **Sitefs** does all path work. See [sitefs.md](sitefs.md).
- **Schema `media`** — one row per file: scope, kind, size, sha256, who
  added it and how, present / trashed / missing. The panel's own changes
  update it at once. A sync catches WinSCP and Claude.
- **`pammy-thumbs`** makes WebP. See [thumbs.md](thumbs.md).
- **A published index** under `/var/lib/pammy-media-public` for the gate's
  public media API. Rewritten a moment after anything changes.
- Uploads are raw bytes, 100 MB (Cloudflare free plan), `X-Pammy-Name`.
  Refusals drain the body so nginx does not report a 502.

`media` is a reserved subdomain name. Media folders are left out of folder
lists (Subdomains, protect/form pickers, the gate's welcome page).

## How it talks to the rest

Panel routes `/api/media*` and `/api/files*` (files are the same records
with a wider filter — [files.md](files.md)). Gate public API
`/_pammy/api/media/…` reads the published index, not the panel's Postgres.
A folder-limited account sees only its folder (`ownsPath`).

## Important types

- `MediaRow` — one file. `how` is `uploaded` | `copied` | `found`.
- `MediaKind` — `images` | `files` | `audio` | `video`.
- `FileKind` — those four plus `pages` | `other` (File Explorer).
- `Label` — a tag or category, scoped to a folder. A file may take a label
  whose scope is its directory or an ancestor scope.
- `SyncSummary` — what the last sync did, plus `strays` (files outside the
  four kinds).

## Panel routes

### `GET /api/media` / `POST /api/media/sync` / `POST /api/media/folder`

Open Media (sync if the last one is over 5 minutes old). "Check for
changes." Make the four kind folders in a site.

### `GET /api/media/list` / `buckets` / `info` / `items`

One folder's contents from sitefs + records; buckets; one file; the
filtered gallery (kind, search, tags, sort, paging).

### `GET /api/media/labels` / `POST /api/media/labels` / `POST /api/media/labels/:type/:id`

List (optional `?around=<folder>` = that folder, ancestors, and scopes
below). Create, rename, public switch, delete.

### `GET /api/media/scopes` / `POST /api/media/scopes` / `scopes/delete`

Tag scopes. `/` and each top-level folder are automatic.

### `POST /api/media/items/:id/details` / `POST /api/media/items/labels`

Title/alt, and set/add/remove tags and categories on several files.

### `GET /api/media/examples` / `:kind` / `POST …/install`

Worked media pages (gallery, slideshow, documents, music, blog, recipes).
Install copies files through sitefs `install-pages`.

### `GET /api/media/thumb/:id` / `GET /api/media/file`

The WebP (immutable cache, sandbox CSP). The file itself with ranges;
anything that is not a picture/sound/video is a download.

### `POST /api/media/upload` / `mkdir` / `copy` / `move` / `trash` / `GET trash` / `POST restore`

Bytes through sitefs; records updated under the sync lock so a sync never
sees half of one. Copy/move take tags along by name (made in the
destination if need be).

## Functions — records and sync

### `kindOfName` / `inMediaLibrary` / `mediaFolderKind` / `placeOf` — media-db.ts

Where a path sits, and whether it counts as a media file.

### `presentAt` / `presentIn` / `queryItems` / `recordById` / `setDetails`

### `recordAdded` / `recordCopied` / `recordMoved` / `recordTrashed` / `recordRestored` / `recordEdited` / `recordGone`

The panel's own changes. `purgeRecords` forgets missing/trashed after 30 days.

### `MediaSync` — media-sync.ts

`sync`, `syncIfStale` (5 minutes), `syncLocked`. Scan + hash (budget 1 GB /
2000 files unless `--all-hashes`). Moves outside the panel are recognised
by hash. `planSync` is the pure function tests cover.

### `describeSync`

The activity-log line.

### `Thumbnailer` — media-thumbs.ts

Kick when a hash is known; `current` / `info` / `infoFor` for the page;
`clean` for housekeeping.

### `Publisher` / `publishIndex` — media-public.ts

Rewrite `index.db` for the gate.

## Functions — labels and scopes

### `listLabels` / `listLabelsAround` / `createLabel` / `renameLabel` / `setLabelPublic` / `deleteLabel` / `changeFileLabels` / `labelsOf`

Triggers keep a label and a file in the same scope.

### `checkScope` / `listScopes` / `addScope` / `removeScope` / `folderToScope` / `scopeToFolder` / `ancestorScopePaths` — scopes.ts

`/` and each top-level folder are automatic (`ensureAutomaticScopes`).

## Public media API (gate)

[`src/gate/media-api.ts`](../../src/gate/media-api.ts). Bearer keys (same
`api_keys` table as forms, with a `media` grant) or public labels. Thumbs
at `/_pammy/media-thumbs/:name`. The gate reads the published index, not
schema `media`.

## See also

- [sitefs.md](sitefs.md), [thumbs.md](thumbs.md), [files.md](files.md)
- [`docs/media-plan.md`](../media-plan.md), [`docs/media-api-plan.md`](../media-api-plan.md)
- Guide 12 (media on your pages)
