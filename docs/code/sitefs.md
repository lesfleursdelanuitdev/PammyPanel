# The website folder helper (sitefs)

The only process that writes `/pamela/public` and `/pamela/trash`. It runs
**as pamela**, so a folder it makes is hers, the way a WinSCP upload is
hers. The sandbox can write nowhere else.

Entry: [`src/sitefs/main.ts`](../../src/sitefs/main.ts). Socket-activated:
`/run/pammy-sitefs.sock`, mode 660, only `svc-pammypanel` may open it.

It trusts nothing in the request. Every name is checked again in
[`src/sitefs/ops.ts`](../../src/sitefs/ops.ts) and
[`src/sitefs/media.ts`](../../src/sitefs/media.ts), whatever the panel
already checked. Shortcuts are never followed. Nothing is overwritten.

## Stack and why

- **Node `fs` only.** No extra library. Paths are walked step by step.
- **jsonline**, same as the other helpers. Stream ops for upload/read/hash
  (`allowHalfOpen`: the file ends the client side, the answer still comes).
- **Runs as pamela**, not as the panel user. The panel user cannot write
  her tree.
- **`PrivateNetwork` and a tight writable set** in the systemd unit. See
  [deploy.md](deploy.md).

## How it talks to the rest

The panel is the only caller (`callSiteFs`, `uploadToSiteFs`,
`readFromSiteFs` in [`src/sitefs/client.ts`](../../src/sitefs/client.ts)).
Trash is purged when the panel's hourly housekeeping sends `op: purge`
(30 days). WordPress placement is a file nginx already uses
(`/etc/nginx/pammy-wordpress/placement`); sitefs will not create a folder
that would collide.

## Important types

- `SiteFsConfig` — `publicDir`, `trashDir`, `placementFile`, `purgeDays`, `now`.
- `SiteFsError` — `code` is `invalid` | `not-found` | `exists` | `not-allowed` | … The panel maps those to HTTP statuses.

## Function catalog — the server

### `createSiteFsServer(cfg, log)` / `handle(cfg, req)`

The switch on `req.op`. Unknown op → `invalid`. Stream ops are registered
separately (upload, read, hash, write, version restore).

### `callSiteFs` / `uploadToSiteFs` / `readFromSiteFs`

The panel's client. `what` in the error text is `"website folder helper"`.

## Socket ops — folders

### `op: list`

Top-level folders, trash, reserved names (`www`, `mail`, `media`, …).

### `op: create`

A new site folder with a starter page. Name rules are in `ops.ts` /
[`src/names.ts`](../../src/names.ts).

### `op: trash` / `restore` / `purge`

Move a folder to `/pamela/trash/<name>--<stamp>/`, restore it (optionally
under a new name), delete anything older than 30 days. `purge` also clears
media trash and editor versions.

### `op: dirs`

The directory tree, for pickers (protect, form "works on", media folder).

### `op: markers`

Which of these paths have a `.pammy-protected` marker.

### `op: protect` / `unprotect`

Write `.pammy-protected` and the five starter sign-in pages plus
`login-files/style.css`. Never overwrite what is already there. Never write
into a `login-files` that is a shortcut or a file. Unprotect removes the
marker only.

### `op: install-pages`

Write `name.html` / `name.css` / `name.js` one folder deep, `flag: 'wx'` —
never over anything, never through a shortcut. Used when she puts a form
example on her site.

## Socket ops — media

The first `media` segment is the media folder. Kinds are
`photos`/`images`, `files`, `audio`, `video` (photos was renamed to
images; `media-rename-photos` is the one-shot). Extension lists decide
kind; `files` is anything that is not a web page or a script.

### `op: media-sites` / `media-create` / `media-list` / `media-buckets` / `media-info`

Which folders have `media/`, make the four kinds, list a dir, list buckets,
stat a file.

### `op: media-mkdir` / `media-copy` / `media-move` / `media-trash` / `media-trash-list` / `media-restore`

Buckets and files. Trash goes to `/pamela/trash/.media/<stamp>-<rand>/`
with `origin.json`, restorable, purged with folder trash.

### `op: media-scan` / `media-hash`

The panel's sync. Scan walks the trees; hash is a stream op because a large
video takes a while.

### `op: media-upload` (stream)

Request line `{op, dir, name, size}`, then exactly `size` bytes. Temp file,
then `link()` under the first free name (`x.jpg`, `x-2.jpg`). Never
overwrites.

### `op: media-read` (stream)

JSON line (name, size, range) then the bytes. Ranges, for previews and
video.

### `op: media-rename-photos`

Once: `media/photos` → `media/images`. The installer runs it.

## Socket ops — files and the editor

Same rules, over the whole website (Media is the `media/` filter).

### `op: files-tree` / `files-list` / `files-stat` / `files-mkdir` / `files-copy` / `files-move` / `files-trash` / `files-restore`

Explorer. Restore of media trash actually uses `files-restore` (same trash
layout) and then the panel updates the media record.

### `op: files-upload` / `files-read` / `files-hash` (streams)

Same shapes as media. `files-read` with `view: true` is the editor preview,
which may also read a sign-in page's `login-files`.

### `op: files-write` (stream)

The editor save. Temp file, then rename over the old one. Body is the text.
`expect` is the sha256 the editor opened; mismatch → `conflict` (HTTP 409).
`create` makes a new file. `session` groups quick saves from one open
editor into one version slot.

### `op: files-versions` / `files-version-read` / `files-version-restore`

What a save replaced lives in `/pamela/trash/.versions/` for 30 days, at
most 50 per file. Restore hashes first (stream op for the longer timeout).

## See also

- [media.md](media.md), [files.md](files.md), [visitors.md](visitors.md)
- [`docs/media-plan.md`](../media-plan.md), [`docs/editor-plan.md`](../editor-plan.md)
- Guide 06 (folders), 09 (protecting writes the starter pages)
