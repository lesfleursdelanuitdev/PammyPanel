# Media on her pages: the media API and the media examples

Status: **LIVE 2026-09-18 (release 0ffdf5613c48c792, verify 210/210).** Decided with momolig 2026-09-18; where momolig said "your
judgement", the choice is marked *(Claude)*.

A page on her website asks for "olivia's files tagged summer and in the category travel" and
draws them: a gallery, a slide show, a list of documents, a music player. Programs can ask too,
with a key. The panel shows four worked examples, like the form examples, and writes a
ready-made page into a folder of hers.

## Decisions

| # | Decision | Source |
|---|---|---|
| M1 | The API is served by **the gate**, at `/_pammy/api/media/...` on pammy.org and every folder subdomain, like the forms API. Same-origin for her pages; the gate decides what is protected. | Claude |
| M2 | The gate never reads the panel's databases. The panel **publishes a read-only index** (`/var/lib/pammy-media-public/index.db`: files, labels, which labels are public) whenever media or labels change, written to a new file and renamed into place. The gate reopens it when it changes. Thumbnails move to `/var/lib/pammy-media-public/thumbs/` (panel writes, gate reads). | Claude |
| M3 | **The folder is always named** in the address: `main` (the main site's media folder) or `in/<folder>`. A tag belongs to one media folder (D6), so a request only ever gets that folder's files. | momolig ("appropriate media folder") |
| M4 | Filters are **tags and categories, all at once** (a file must have every one asked for), plus `?kind=`. Several of each: path pairs (`/t/dogs/t/cats/c/pets`) and/or `?tags=dogs,cats&categories=pets,street-animals` (repeated `tag=` / `category=` too). | momolig |
| M5 | **Opt-in per label**: each tag and category has a switch "Anyone can list its files", off by default, and turning it on asks for a passkey (it publishes). Without a key, every label in the request must be public, and a file lists only its public labels. A private or missing label gives the same answer, so names can't be guessed. | Claude |
| M6 | **Keys** too: the existing API keys gain "which media folders" (none, all, or chosen). A key reads any label (public or not) and `/all` (every file in the folder), sees private labels, and isn't limited by protected folders, like a forms key. Sent only as `Authorization: Bearer`. | momolig |
| M7 | **Protected folders:** without a key, a file inside a protected folder is left out unless the visitor is signed in to it. Its thumbnail follows the same rule. | Claude |
| M8 | **Thumbnails for pages**: the API gives each picture's small version, `/_pammy/media-thumbs/<id>-<hash>.webp`, served only if the file itself could be. | Claude |
| M9 | **Title and "what it shows"** (alt text) per file, edited in the file's details, returned by the API. Galleries use them. | Claude |
| M10 | Four examples: **gallery, slide show, documents list, music player**. Each: a live demo framed in the panel, the code, and "Put this on my website". | momolig |
| M11 | The demos run on a **built-in example folder** (`/_pammy/api/media/example/...`, shipped pictures, tunes and PDFs), through the same code, so they work before she has any media. | Claude |
| M12 | "Put this on my website" writes `<page>.html` and `<page>-files/{style.css,<kind>.js}` into the folder of a media folder she picks (a helper: only theirs), pointed at the tag and/or category she picks, and says which labels still need their switch (with a button). Never overwrites. | momolig/Claude |
| M13 | Menu: **Media › Media examples**. Limited accounts get it, for their folder. | Claude |
| M14 | A new guide, **12-media-on-your-pages.txt**: the switches, the four examples, the API, keys. The helper's guide points to it; limited accounts' Help shows it. | Claude |

## The API

```
GET /_pammy/api/media/main/t/summer                 the main site's files tagged summer
GET /_pammy/api/media/in/olivia/c/travel            olivia's files in the category travel
GET /_pammy/api/media/in/olivia/t/summer/c/travel   both (a file must have both); more t/ and c/ pairs: all of them
GET /_pammy/api/media/in/olivia/t/dogs/t/cats/c/pets/c/street-animals
GET /_pammy/api/media/in/olivia?tags=dogs,cats&categories=pets,street-animals
GET /_pammy/api/media/in/olivia/all                 every file in olivia's media folder (key only)
GET /_pammy/api/media/in/olivia/labels              its tags and categories with counts (public ones without a key)
GET /_pammy/api/media/example/...                   the built-in example folder (M11)
    ?kind=images|audio|video|files   ?order=newest|oldest|name (newest)   ?limit=1-100 (50)   ?offset=
    ?tags=dogs,cats   ?categories=pets,street-animals   (also repeated tag= / category=; AND with path pairs)
```

Each file: `name, kind, title, alt, size, width, height, addedAt, modifiedAt, tags, categories`,
`src` (its address from a page on this hostname), `url` (on pammy.org), `subdomainUrl`, `thumb`.
The list: `folder, filter, kind, order, total, offset, limit, next, files`. Errors like the forms
API: `{error, message}` with 400/401/403/404/429. Keyless: 120 requests a minute per IP, answers
`no-cache` with an ETag. Keyed: `private, no-store`.

## Build order

1. media.db: titles/alt, public switches; panel routes and pages for them.
2. The published index and the shared thumbnails folder.
3. The gate: routes, keys (gate.db: `api_keys.media`), protected folders, thumbnails.
4. The four examples: demo folder, templates, gate pages, panel pages, install.
5. Guides, install/verify, tests throughout.
