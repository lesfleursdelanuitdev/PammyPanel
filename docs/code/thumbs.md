# Thumbnails (thumbs)

A small process that turns one media file into a small WebP, or says "use
this icon instead." Its own user. It reads her website the way the web
server does. No network. Nowhere to write but its own `/tmp`. Only the
panel may open the socket.

Entry: [`src/thumbs/main.ts`](../../src/thumbs/main.ts). Socket
`/run/pammy-thumbs.sock`.

The panel keeps the bytes it was given under
`/var/lib/pammy-media-public/thumbs` and serves them at
`/api/media/thumb/:id`. The gate can serve them too.

## Stack and why

- **`sharp` (libvips)** — decode pictures, always re-encode as WebP.
  `concurrency(1)`, cache off. Pixel limit 50 million, 10 s timeout.
- **ffmpeg** — a video frame or cover art. Child process under memory, CPU,
  and time limits. Only plain file formats (no playlists).
- **pdftoppm** — first page of a PDF, same limits.
- **`prlimit`** — those child limits.
- The tools get an **open file descriptor**, not the path. The path was
  walked with `lstat`, opened `O_NOFOLLOW`. A shortcut is refused.

Files come from anyone (WinSCP, Claude, the panel). Treat them as hostile.

## How it talks to the rest

The panel's `Thumbnailer` ([`src/media-thumbs.ts`](../../src/media-thumbs.ts))
asks for a thumb once a file's hash is known. One at a time: the service's
memory limit is for one file, not several. A queue in
[`src/thumbs/service.ts`](../../src/thumbs/service.ts) serializes requests.

## Important types

- `ThumbsConfig` — `publicDir` (`/pamela/public`) and tool paths.
- `Thumb` — `{ webp, width, height }` or `{ icon, why }`.
- `ThumbError` — `invalid` or `not-found`.

## Socket ops

### `op: tools`

Which tools this binary can see (`sharp` / `vips` versions, whether
ffmpeg and pdftoppm exist). The installer's checks.

### `op: thumb` (stream op for the longer timeout)

`{ op, path, kind }` → WebP as base64, or an icon name and a why. `kind`
is `images` | `files` | `audio` | `video` | `pages` | `other`.

## Function catalog — making one

### `openMediaFile(cfg, path, kind)` — src/thumbs/make.ts

Walk `/pamela/public/<path>` step by step. Refuse `login-files`, `.` / `..`,
unsafe names, shortcuts. Open with `O_NOFOLLOW`.

### `toWebp(input)`

Any picture (or a frame a tool produced) → a WebP that fits 320 px,
right way up, as forgiving as a browser about small flaws.

### `makeThumb(cfg, path, kind)`

Open the file, pick a tool by extension, re-encode. On failure return an
icon rather than throwing, so the Media page still has something to show.

### `iconFor` / `extensionOf` — src/thumbs/icons.ts

Which icon the panel should draw when there is no picture.

### `createThumbsServer(cfg, log)`

jsonline + the one-at-a-time queue.

## See also

- [media.md](media.md)
- [`docs/media-plan.md`](../media-plan.md) "Phase 3 as built"
- Guide 08 / 12 (media on your pages)
