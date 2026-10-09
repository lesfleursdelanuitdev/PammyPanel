# Files and the editor

File Explorer is the same library as Media, over the whole website. The
editor opens text files at `/files/edit?path=…`.

## Stack and why

- **Sitefs** for every write (as pamela). See [sitefs.md](sitefs.md).
- **CodeMirror 6** in the browser — html, htm, css, js, txt, md, json, xml,
  svg, up to 2 MB.
- **A sandboxed preview** — opaque origin, token in the address, the
  unsaved text. [`src/preview.ts`](../../src/preview.ts).
- **Versions** in `/pamela/trash/.versions/` for 30 days, at most 50 per
  file. Quick saves from one open editor share one slot (`session`).
- **Drafts** also in the browser (`localStorage`), offered back if the tab
  dies.

A save is refused with 409 `conflict` if the file's sha256 is not the one
the editor opened.

## How it talks to the rest

Panel routes `/api/files*`. Media records still apply (`queryItems` with
`library: 'all'`). A folder-limited account is confined with `ownsPath`,
same as Media. Opening Files also runs `media.syncIfStale`.

## Important types

- `Saved` / `Version` — [`src/sitefs/edit.ts`](../../src/sitefs/edit.ts).
- `PreviewToken` — who, which folder root, optional draft text. Idle 2
  hours, max 12 hours.

## Panel routes

### `GET /api/files` / `list` / `info` / `items` / `file`

Tree, one directory, one file, filtered items (kind/search/tags), file
bytes (same sandbox idea as media).

### `POST /api/files/upload` / `mkdir` / `copy` / `move` / `trash` / `restore`

Same HTTP shape as media; different sitefs ops (`files-upload`, …).

### `GET /api/files/text` / `POST /api/files/save`

Open and save. Save body is JSON `{ path, text, expect, session, create }`.
`TEXT_BODY` raises Fastify's 64 KB cap for this route.

### `GET /api/files/versions` / `version` / `POST /api/files/versions/restore`

List, read one, restore (conflict if the live file moved).

### `POST /api/files/preview` / `preview/close` / `draft`

Mint a token, drop one, push unsaved text for the iframe.

### `GET /api/files/view/:token/*`

The iframe's origin. Serves the live file, or the draft if that path has
one. HTML is rewritten so relative links stay inside the preview
(`previewHtml`). `inside(root, path)` keeps a limited account in its
folder.

## Functions — preview.ts

### `Previews`

In-memory tokens. `mint`, `get`, `close`, `draft`.

### `previewRoot(path, limitedTo)` / `inside` / `previewHtml`

The folder the iframe may see, and the rewrite of `src` / `href` so a page
preview still loads its css.

## Functions — sitefs/edit.ts

Named from the socket ops on [sitefs.md](sitefs.md): `filesWrite`,
`filesVersions`, `filesVersionRead`, `filesVersionRestore`, `purgeVersions`,
`editProblem`, `MAX_TEXT`.

## See also

- [media.md](media.md), [sitefs.md](sitefs.md), [web.md](web.md)
  (`FileEditor.tsx`, `Files.tsx`)
- [`docs/editor-plan.md`](../editor-plan.md)
