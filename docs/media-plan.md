# Media, reorganised: plan

Status: **phases 1-5 live 2026-09-18 (phase 5 in release 77e17a04; the media API on top of it,
docs/media-api-plan.md, live in 0ffdf5613c48c792).** Decided with momolig 2026-09-18; where momolig said "your choice",
the choice is marked *(Claude)*.

Phase 1 as built:
- The redirect lives in `deploy/nginx/gate.conf` (included in both pammy.org server blocks) as
  a regex location with `rewrite ... permanent`, so names with spaces stay escaped and `?v=`
  is kept.
- The rename is the helper op `media-rename-photos`, run by the install through
  `pammy-panel media-images` (`src/media-rename.ts`). It used to move the panel's
  `media_notes` paths too; that table is gone since refactor phase 5 (migration 0016).
  Exit code 3 means files were left in photos/ because their names were taken in images/.
- The install's preflight refuses to go on if any media folder is deeper than one folder down.
- Items trashed from photos/ before the change are restored into images/.
- gate.db migration 8 rewrites form pictures under `(<folder>/)media/photos/` and bumps those
  forms' version.
- Guides 06, 08, 09, 10 and the README are updated, so they need a sync.

Phase 5 as built *(Claude, where the plan left room)*:
- **panel.db migration 3:** `users.scope` (`'/olivia'`, or NULL for everything). It's set with
  `POST /api/users/:id/scope {folder}` (manager, recent passkey), when adding an account
  (`scope`), or `pammy-panel scope <user> <folder>|all`.
  - The folder has to exist.
  - An account manager can't be limited, and a limited account can't be made a manager.
  - Changing it signs the account out everywhere and is logged. `/api/session` and
    `/api/users` show it.
  - A scope is always one top-level folder, never "/" (the main site): *(Claude)*.
- **Enforcement (D24), on the server:**
  - `need()` answers 404 to a limited account for any route outside `LIMITED_ROUTES`: session,
    logout, re-auth, own passkeys, Help, media, forms and responses. This check comes before
    the manager check, so hidden things are "not found", not "forbidden".
  - Media: every path, id and label is checked against the account's folder (`own`,
    `ownsPath`, `ownsScope`). `/api/media` lists only that folder and says `limitedTo`.
  - The trash list and restore only show and allow the account's own items.
- **Forms (gate.db migration 9):** `forms.scope`, `'/'` for every existing form.
  - Every forms and responses request from the panel carries the account's `scope`. The gate
    then allows only those ops, and only on forms of that scope (anything else is `not-found`),
    and new forms get that scope whatever was asked.
  - Others choose with `formScope` on create, or `form.scope`
    (`POST /api/forms/:id/scope`). The examples always stay `'/'`.
  - The public side: a scoped form is "not available" unless the page's *real* path (after
    shortcuts) is inside the folder, at either address.
  - A scoped form's pictures must be inside its folder, checked on save and on a scope change.
- **Pages:**
  - The menu hides what D23 lists, and the routes aren't there for a limited account.
  - Home shows only its responses and forms, plus "You look after olivia".
  - Media is kept to the one folder: no "All media folders" and no making media folders.
  - Forms: "Works on" when making a form, a per-form choice on its card, and an "only in olivia"
    badge. The builder's picture field suggests images from the form's own folder.
  - Accounts: a "Sees" choice when adding an account, a "What it sees" dialog, and an
    "only olivia" badge.
- **The install:** it now backs up panel.db, and its "accounts and passkeys untouched" check
  compares every account's name and role and every passkey. The schema version is reported on
  its own, since this phase adds a column.
- verify-panel.sh: a folder-only form works on its folder's page and not on the main site's; a
  request scoped to another folder doesn't list it; a scoped request can't reach protected
  folders or people.
- `tools/make-test-media.ts` and `tools/put-test-media.sh` (sudo) put made-up pictures, videos,
  audio and PDFs into a folder's media folder, as pamela, for trying the Media tab. They also add
  the tags and categories listed in `tools/test-media-labels.json`, made in that folder's scope
  through the panel's own code. Running it again adds only what's missing.

Phase 4 as built *(Claude, where the plan left room)*:
- **Server:**
  - `GET /api/media/items?scope=&kind=&in=&q=&tag=&category=&sort=name|size|added&order=&offset=`
    reads from media.db (`queryItems`). It pages by offset, 100 at a time, and gives `total`.
    With one scope, one kind and nothing searched for, it *browses*: the files directly in that
    folder, plus its subfolders (from the helper). Otherwise it lists every match under it, in
    any subfolder, and each item says where it is.
  - Labels: `src/media-labels.ts`, with routes `GET/POST /api/media/labels`,
    `POST /api/media/labels/:type/:id` (`{name}` renames, `{delete: true}` deletes),
    `POST /api/media/items/labels` (`{ids, set | add | remove: {tags, categories}}`). Labels are
    given by name, and a missing one is made in each file's own scope, so one call can cover
    files in several media folders. It's all or nothing, and each change is in the Activity log.
  - Names use the form-name rule (D10), at most 40 characters. The pages suggest the slug.
  - There's no separate "clone" route: copy already carries labels (D8). The move/copy dialog
    works out and shows which labels will be made in another scope before anything happens.
- **The page:** `web/src/pages/Media.tsx`, plus `web/src/components/media/*`:
  `items.tsx` (grid, table, ⋯ menu, selection bar, folder tiles), `details.tsx`,
  `move-copy.tsx`, `label-editor.tsx`, `labels-manager.tsx`, `thumb.tsx` and `extras.tsx`.
  - What's shown lives in the address: `?folder=*|/|olivia&kind=&in=&q=&tag=&cat=&sort=&order=&page=`.
  - The Grid/Table choice and the last media folder are kept per browser (localStorage, which
    is allowed to fail).
  - With no folder in the address, the page shows the one remembered, else "All media folders"
    (or the only one).
  - The kind tabs have an "All". Uploading with "All" chosen sends each file to the top of the
    kind its ending says.
  - The table folds on phones: picture, name, one line of details, then ⋯.
  - Choosing several files (checkboxes, "Choose this page") lets you add or take off tags and
    categories, move, copy and trash. Moves, copies and trashes run one file at a time through
    the existing routes, each logged. Chosen files stay chosen after tagging.
  - Audio and video players are now only in the file's details, not in the list.
- **Guide 08 PART 12** is rewritten: looking around, uploading with "All", the ⋯ menu, tags and
  categories, and choosing several files. It needs a sync.

Phase 3 as built *(Claude, where the plan left room)*:
- `src/thumbs/` is the service (`make.ts` makes one thumbnail, `icons.ts` names the icons);
  `src/media-thumbs.ts` is the panel's side; units `deploy/pammy-thumbs.{socket,service}`; user
  `svc-pammythumbs`; the install apt-installs `ffmpeg` and `poppler-utils`; `sharp` 0.35.4 is a
  dependency.
- **Difference from section 4:** the service writes nothing. It sends each WebP back over the
  socket, and the panel keeps it at `/var/lib/svc-pammypanel/thumbs/<id>-<hash>.webp` (600), with
  a row in media.db's `thumbs` table (migration 2). So the service's only writable place is a
  private /tmp, and the panel serves thumbnails without being able to read the website.
- **Limits per file:** sharp has a 50-megapixel limit, a 64 MB file limit and a 10 s timeout.
  ffmpeg and pdftoppm run under `prlimit` (768 MB address space, CPU seconds, 64 open files) in
  their own process group, which is killed after 10 s. They get the file already opened
  (`O_NOFOLLOW`, as fd 3), not its name. ffmpeg only reads plain file formats (`-format_whitelist`,
  `-protocol_whitelist file,fd`), so a playlist posing as a video reads nothing. The service as a
  whole has `MemoryMax=512M` and makes one thumbnail at a time.
- **What each file gets:** images are fitted into 320×320 and never enlarged. sharp is as
  forgiving as a browser (`failOn: 'none'`). A video gets a frame from about 1 s in, or its first
  frame if it's shorter. Audio gets its cover picture, or the music icon. A PDF gets its first page.
  Other files in files/ get an icon for their type without asking the service. A file that can't
  be read gets its kind's icon, and the reason is kept (`thumbs.why`).
- **When:** as soon as an upload or copy is recorded; after each round of hashes, since a
  thumbnail is made for one hash; 30 s after the panel starts; and with `pammy-panel media-thumbs
  [--only <path>]`. If the service isn't answering, what's waiting simply waits. Housekeeping
  (hourly) deletes pictures whose record has gone.
- `GET /api/media/thumb/:id?v=<hash start>`: signed in, `sandbox` CSP, cached `private,
  immutable`. The address changes when the content does. The list and details now include
  `thumb` (`{src, icon, width, height}`, `{src: null, icon}`, or `null` while it's being made).
- **The Media page:** the image gallery shows thumbnails (the original file while one is being
  made). Videos use theirs as the poster and no longer load anything until played. Audio and file
  rows show a small picture or an icon. The rest of the page is phase 4.
- **Tests:** stand-in scripts for ffmpeg and pdftoppm test the plumbing everywhere (fd 3, limits,
  time-out, output). The real tools are tried where they're installed (skipped otherwise).
- verify-panel.sh checks the service's user and sandbox (reads but can't write the website; no
  trash, app, /var/lib, home or network; no capabilities; 512 MB), a real thumbnail round trip,
  and the PDF icon.

Phase 2 as built *(Claude, where the plan left room)*:
- `src/media-db.ts` (schema, and the record changes the routes make), `src/media-sync.ts` (the
  sync: `planSync` is the pure part), helper ops `media-scan` and `media-hash` (a stream op, only
  for its 2-minute timeout). media.db is `PANEL_MEDIA_DB`, default next to panel.db.
- **Differences from section 2:** `path` is unique only among *present* records (a partial
  index), so a missing or trashed record can keep the path it had. Every record has
  `changed_at`. There are CHECKs that the kind and the name agree with the path too, and that
  only trashed records have a trash id.
- **media_notes (D17):** copied into an `imported_notes` table when media.db is made (panel.db is
  only read). A sync that finds one of those paths takes who and when from it and deletes it.
  Restoring something trashed before media.db existed moves its `trash:` note to where it went
  and syncs.
- **Hashes:** uploads get theirs as the bytes arrive; copies take the original's. Found files
  are hashed after each sync, smallest first, at most 1 GB or 2000 files per sync (`pammy-panel
  media-sync --all-hashes` does the lot). A move is recognised by hash; a file with no hash yet
  (a new big video) matches on name, size and modified time instead.
- **One change at a time:** move, copy, trash and restore hold the sync's lock around the
  helper call and the record change, so a sync never sees half of one. Uploads take it only for
  the record, so a sync can find an upload first and the upload then takes the record over.
- A cut-short scan (over 20,000 files) marks nothing missing, and the page says so.
- Syncs happen when Media is opened (if the last was over 5 minutes ago), every 15 minutes
  (server.ts), right after a folder is trashed or restored on the Subdomains tab, from "Check
  for changes", and with `pammy-panel media-sync` (the install runs one). A sync that changed
  something is in the Activity log as `media-synced`.
- The Media page is as before, plus "Check for changes", when it last checked, and a warning
  listing anything out of place. Files come from media.db; subfolders still come from the
  helper. Opening a file that has gone marks it missing at once.
- Copying or moving into another media folder already carries tags and categories by name (D8),
  and says which it made, although phase 4 is where they can be set.
- Guide 08 PART 12 has a new "FILES PUT IN WITH WINSCP OR CLAUDE" section, so it needs a sync.
- verify-panel.sh: media.db is 600 and the panel's, a sync finds a file made as pamela, hashes it
  through the helper, and keeps its record when pamela renames it.

Before phases 1 and 2 (live since 2026-09-16): any folder at any depth can have `media/{photos,files,audio,video}`,
with subfolders ("buckets") inside each. The Media tab shows one media folder at a time as a
gallery. It can upload, copy, move, rename, trash and restore, and it records who added each
file (`media_notes` in panel.db). Files are only ever touched by the helper (pammy-sitefs, as
pamela).

This plan changes the shape of media folders, gives every media file a database record with
tags and categories, adds thumbnails, a grid/table view and a folder picker, and prepares for
accounts that only see one subdomain.

---

## 1. Decisions

### The folders
- **D1 `photos` becomes `images`.** A media folder holds exactly `images/`, `audio/`, `video/`
  and `files/`. Nothing else may go directly under `media/`, whether a file or a folder.
  Inside each of the four, people make subfolders as deep as they like (as now).
- **D2 Old addresses keep working.** nginx answers `/<anything>/media/photos/<rest>` with a
  **301** to `.../media/images/<rest>`, on pammy.org, www and every folder subdomain. It's
  permanent and never removed.
- **D3 Media folders only at the top or one level down.** A media folder can only be at `/media`
  (the main site) or `/<folder>/media` (a top-level folder, which is the only kind that can be
  a subdomain). "Make a media folder" offers only those, and still makes all four inside.
- **D4 Existing deeper media folders** (e.g. `recipes/beef/media`): the install **checks
  first and stops** if it finds any, listing them, so momolig decides by hand. Media has
  been live for two days, so there are probably none. *(Claude)*

### Scopes
- **D5 Every media file, tag and category belongs to one scope.** The scope is `/` (the main
  site's media folder) or `/<folder>` (that top-level folder's media folder, e.g. `/olivia`).
  The scope always follows from where the file is: `olivia/media/images/x.jpg` is in
  `/olivia`. The database stores it too, for joins and permissions, and checks that the
  two agree.
- **D6 Addresses of tags and categories:**

  | | main site | subdomain `olivia` |
  |---|---|---|
  | tag `dogs` | `/t/dogs` | `/olivia/t/dogs` |
  | category `news` | `/c/news` | `/olivia/c/news` |

  These are names in the panel and its API, not pages on the website. `/t/dogs` and
  `/olivia/t/dogs` are two different tags. The number of path segments tells them apart,
  so a subdomain called `t` or `c` would still work.
- **D7 Tags and categories only link within their scope.** The database refuses a link whose
  media scope and tag scope differ (a trigger, not just a check in the code).
- **D8 Moving or cloning to another scope** carries labels across by name: a file tagged
  `/t/dogs` that moves to `/olivia` gets `/olivia/t/dogs`, which is created if it isn't there.
  Nothing is dropped silently. The confirmation says which labels will be created.
- **D9 Renaming a top-level folder** (the Subdomains tab) renames its scope in one go: media
  records, tags and categories. Forms follow too, once they have a scope (D22).

### Tags and categories *(Claude, all of D10-D13)*
- **D10 Names:** lowercase letters, digits and hyphens, 1-40 characters, unique within their
  scope, the same rule as form names. Typing "Summer 2026" suggests `summer-2026`.
- **D11 Tags and categories behave the same way.** A file can have any number of each. The
  only difference is intent: categories are the few broad shelves (`news`, `recipes`),
  and tags are the many specific words (`dogs`, `beach`). Both are kept as separate tables,
  as momolig laid out, so they can grow apart later (e.g. categories inside categories).
- **D12 They can be renamed**, because files link by id, so renaming changes the address and
  nothing else. **Deleting one** removes it from every file, and the confirmation says how
  many files that is. Nothing on the website changes either way.
- **D13 Anyone who can see a scope can create, rename and delete** its tags and categories.

### Records and sync
- **D14 One record per media file** in a new, separate database, **`media.db`**, which the
  panel's service user owns next to panel.db. panel.db is not touched by D1-D21.
- **D15 What a record holds:** id, path (the address, relative to the website), scope, kind,
  name, size, content hash, when it was added and how (uploaded / copied / found), who added
  it, the file's modified time, and its state (present / in trash / missing). Its public
  address is built from the path: `https://pammy.org/olivia/media/images/x.jpg`, and
  `https://olivia.pammy.org/media/images/x.jpg` for a top-level folder.
- **D16 Files change outside the panel** (WinSCP, Claude on the server), so the panel
  **syncs**:
  - Changes made through the panel update the record at once, keeping its id and labels.
  - A sync walks the media folders and compares them with media.db:
    - **A new path** whose size and hash match a missing record is treated as a **move**, so
      the record keeps its id and labels.
    - **Any other new path** becomes a new record: "found", dated by the file's modified time,
      and nobody named as who added it.
    - **A path that has gone** is marked missing and kept for 30 days with its labels, in
      case it comes back. After that it's removed.
    - Hashes are only computed when they're needed to recognise a move, so big videos
      aren't read every time.
  - **When:** on opening Media if the last sync was over 5 minutes ago, every 15 minutes in
    housekeeping, and from a **"Check for changes"** button.
  - A file that doesn't belong where it is (a `.pdf` in `images/`, or something directly
    under `media/`) is listed with a warning, but never moved automatically.
- **D17 `media_notes` (who added what) is copied into media.db** by its first migration, and
  the panel stops using it. The old table is left in panel.db, unused. *(Claude)*

### Thumbnails *(Claude)*
- **D18 Every record has a thumbnail**, made automatically:
  - **Images** (including SVG): scaled to fit 320×320 and saved as WebP.
  - **Video:** a frame from about one second in.
  - **Audio:** its cover picture if it has one, otherwise a music icon.
  - **PDF:** its first page.
  - **Other files:** an icon for their type (document, spreadsheet, archive…).
  - They're remade when the content hash changes. They're keyed by record id, so a move or
    rename needs no new thumbnail.
- **D19 Made by a new sandboxed service, `pammy-thumbs`,** under its own system user. It gets
  read-only access to the website (like the gate), writes only its own cache directory, has
  no network, and a memory and time cap per file. Its socket can be used only by the panel.
  Decoding files that strangers may have made is the riskiest thing here, so it gets its own
  cage.
  - **New software:** `sharp` (npm, for images), `ffmpeg` (apt, for video frames and cover
    art) and `poppler-utils` (apt, for PDFs).
  - Thumbnails are served only by the panel (signed in) and never put on the website, so a
    protected folder's media stays protected.

### The Media page
- **D20 Picking and viewing:**
  - **Top bar:**
    - a **media-folder picker**, whose first entry is *All media folders* (only for accounts
      that see everything) followed by *Main site* and each top-level folder;
    - the **kind** (All / Images / Audio / Video / Files);
    - a search box (by name);
    - tag and category filters;
    - a segmented **Grid | Table** toggle, like the DataViewer in the-gonsalves-family.
  - The toggle and folder choice are remembered per browser.
  - Subfolders show as a path you can click back up through (breadcrumbs), with folder
    cards or rows first.
  - **Grid:** responsive cards, with 2 columns on phones and more as the screen widens. Each
    card has the thumbnail, the name, one line of details (size, date) and its tags and
    categories as chips. A **⋯** button opens the actions.
  - **Table:** columns thumbnail · name · kind · folder · size · added · tags · categories ·
    actions, sortable by name, size and date. On phones each row folds into thumbnail,
    name, one line of details and ⋯, with no sideways scrolling.
  - "All media folders" is paged, 100 at a time.
- **D21 Actions on each item:** open/preview, copy address (and HTML), **rename**, **move**
  (to any subfolder of any media folder the account can see), **clone** (a copy, keeping
  labels per D8), **delete** (to the trash for 30 days, as now; restoring brings its record
  and labels back), and **edit tags and categories**.
  - Selecting several items at once allows tag, move and delete *(Claude)*.
  - Upload, drag-and-drop, making subfolders, and the Cloudflare-cache warning on trash stay
    as they are.
  - A small **"Tags & categories"** screen per scope lists them with counts, and allows
    rename and delete.

### Accounts that see one subdomain (later phase, planned now)
- **D22 An account can be limited to one scope** (e.g. badmon → `/olivia`). **Everything** it
  sees is limited to that scope:
  - **Media:** only that media folder, and "All" isn't offered.
  - **Forms:** forms get a scope too (a gate.db column; existing forms become `/`). A
    `/olivia` form works only on pages inside `olivia/` or `olivia.pammy.org`. A `/` form
    works everywhere, as now.
  - **Responses:** only its forms' responses.
  - **Home:** counts for its scope only.
  - Form image items only offer pictures from its scope.
  - Pamela and momolig (no limit) see everything, as now.
- **D23 What a limited account doesn't see** *(Claude)*: Subdomains, People, Requests,
  Protected folders, Accounts, API keys, Form examples and the whole Activity log. It does
  see Help and its own Passkeys.
  - Protected folders and requests inside its subdomain could come later.
- **D24 Enforced by the server on every request**, not by hiding menu items. Every media,
  form and response route checks the account's scope, and a path or id outside it is
  answered as "not found".
- **D25 Only account managers set or change an account's scope** (a passkey check, like
  roles). This phase changes **panel.db**: one column on `users` (`scope`, NULL = everything).
  It's the only panel.db change in this plan. The install keeps checking that passkeys are
  untouched.

---

## 2. Data: media.db

    CREATE TABLE media (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,     -- olivia/media/images/2026/dog.jpg
      scope       TEXT NOT NULL,            -- '/' or '/olivia'
      kind        TEXT NOT NULL CHECK (kind IN ('images','audio','video','files')),
      name        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      hash        TEXT,                     -- sha256, filled when first needed
      modified_at INTEGER NOT NULL,
      added_at    INTEGER NOT NULL,
      added_by    TEXT,                     -- NULL when found by a sync
      how         TEXT NOT NULL CHECK (how IN ('uploaded','copied','found')),
      state       TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present','trashed','missing')),
      state_at    INTEGER,
      trash_id    TEXT                      -- the helper's trash id while trashed
    );
    CREATE TABLE tags       (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, UNIQUE (scope, name));
    CREATE TABLE categories (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, UNIQUE (scope, name));
    CREATE TABLE media_tags       (media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                                   tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (media_id, tag_id));
    CREATE TABLE media_categories (media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                                   category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY (media_id, category_id));
    -- D7: triggers on INSERT/UPDATE of the two link tables (and on UPDATE OF scope of the
    -- three owners) that RAISE(ABORT) when the scopes differ.
    -- D5: a CHECK that scope matches the path ('/' when path starts 'media/', else '/' || first segment).
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);   -- last sync time, counts
    CREATE INDEX media_scope ON media(scope, kind, state);

Migration 1 also copies `media_notes` from panel.db (read-only, attached) into `media`, then
runs a first sync.

## 3. The helper (pammy-sitefs, `src/sitefs/media.ts`)

- `KINDS` becomes `images/audio/video/files`. The error wording says "an image".
- `parseMediaPath` accepts `media` only as the first or second segment (D3).
- `mediaSites` lists only the main site and top-level folders.
- `mediaCreate` refuses deeper folders.
- **New op `media-rename-photos`:** in each media folder, renames `photos` to `images`, or
  merges when both exist, refusing any clash. Used once by the install.
- **New op `media-scan`:** lists every file in every media folder (path, size, mtime, and
  whether it belongs), with no content. It's capped, and flags anything out of place.
- **New op `media-hash`:** returns the sha256 of one file, streamed.
- Upload, copy and move are unchanged apart from the path rules. Copy and move now also
  allow a **different scope** (they already allowed any media folder).

## 4. The thumbnail service (new: `src/thumbs/`, `deploy/pammy-thumbs.{service,socket}`)

- A jsonline socket with the op `thumb {id, path, hash, kind}`. It reads the file read-only,
  writes `/var/lib/svc-pammythumbs/<id>-<hash>.webp` (or answers "icon: <type>"), and gives
  up after 10 s and 256 MB.
- Sandboxing like the gate: its own user, no network, read-only website, write only its own
  state directory, no capabilities.
- The panel queues thumbnails after uploads and syncs, and serves them at
  `/api/media/thumb/:id` (signed in, cached privately by the browser, keyed by hash).

## 5. Panel server (`src/app.ts`, new `src/media-db.ts`)

- Open media.db alongside panel.db. Housekeeping runs sync and purges missing/trashed
  records after 30 days.
- **Media routes:**
  - `GET /api/media/items?scope=&kind=&dir=&q=&tag=&category=&sort=&after=`: lists from
    media.db, not the disk.
  - `POST /api/media/sync`
  - `GET/POST /api/media/labels` and `POST /api/media/labels/:kind/:id`: tag and category
    create, rename and delete.
  - `POST /api/media/items/:id/labels`: set a file's tags and categories.
  - Upload, move, copy and trash keep their routes, and now also update media.db. Move and
    copy do D8.
- **media_notes** stops being written. "Who added it" comes from media.db.
- **Later phase (D22-D25):**
  - `users.scope` (panel.db migration);
  - one `scopeOf(account)` helper that every media, forms and responses route uses;
  - the menu drops what D23 hides;
  - forms: `gate.db` gains `forms.scope`, and the gate refuses a scoped form on a page
    outside its scope.

## 6. Panel pages (`web/src`)

- **Media.tsx is rewritten around D20/D21:**
  - `MediaToolbar` (picker, kind, search, filters, Grid|Table toggle);
  - `MediaGrid` and `MediaTable` (shared item model and ⋯ menu);
  - `LabelEditor` (chips + typeahead that creates within the scope);
  - `LabelsManager`;
  - a selection bar for bulk actions.
- The media folder maker uses the existing folder picker, limited to the top level (D3).
- **Form builder:** image items offer only `images/` pictures from the form's scope (once
  forms have scopes) and store the new paths.

## 7. The `photos` → `images` change, everywhere

- **Disk:** the install runs `media-rename-photos` after its database backup.
- **nginx** (pamela vhost, both server blocks, and the subdomain block):
  `location ~ ^(/.*)?/media/photos/(.*)$ { return 301 $1/media/images/$2$is_args$args; }`,
  placed before the gate. It says nothing about whether the file exists, so it leaks nothing
  about protected folders. `test/run-gate-nginx-test.sh` gets cases for the main site, a
  subdomain and a protected folder.
- **gate.db:** a migration rewrites `/media/photos/` to `/media/images/` in form image items.
- **Code and tests:** `web/src/lib/media.ts`, `types.ts`, `form-settings.tsx`, `gate/forms.ts`,
  the tests, and `verify-panel.sh`.
- **Guides:** 06, 08, 09, 10, `README-for-pamela`, `pamela-upload-instructions`, and the
  mentions in the example sign-in looks (checked one by one, since some mean real photos, not
  the folder).
- **Cloudflare:** cached old copies stay reachable for up to about 4 hours, which is harmless
  here because the redirect points to the same file.

## 8. Phases (each one built, tested, installed and verified on its own)

1. **Folders:** `images`, the redirect, the top-level-only rule, the deeper-folder check, and
   the gate.db path rewrite. Small, and on its own because it changes addresses.
2. **Records:** media.db, sync, "Check for changes", media_notes copied over. The page is
   unchanged but reads from media.db.
3. **Thumbnails:** pammy-thumbs, its sandbox, and the three new tools.
4. **The new page:** picker with "All", Grid | Table, the actions, tags and categories, and bulk
   select.
5. **Limited accounts:** `users.scope`, forms scope, enforcement, and the reduced menu.

## 9. Tests (per phase)

- sitefs.test.ts: the new path rules, `media-rename-photos` (rename, merge, clash),
  `media-scan` (out-of-place files, the cap), and cross-scope copy and move.
- A new media-db test:
  - the scope CHECK and the cross-scope trigger;
  - sync: new file, a move recognised by hash, missing then back, 30-day purge;
  - D8 label mapping;
  - D9 scope rename.
- The thumbs service: each kind, a broken file, a too-big file, and the timeout. It never
  writes outside its directory.
- panel.test.ts: the new routes; later, a limited account refused on every route outside
  its scope (media, forms, responses, thumbs, file).
- e2e: picker, Grid/Table toggle on desktop and phone, rename/move/clone/delete, labels,
  and "Check for changes" after a file appears outside the panel.
- verify-panel.sh: the 301 through Cloudflare, a thumbnail round trip, and sync picking up
  a file made as pamela.

## 10. Open questions

None. Settled 2026-09-18 *(Claude)*: categories get **no colour** for now (they're
told apart by name, like tags), and tags and categories stay **private to the panel** for now.
A public "everything tagged /olivia/t/dogs" gallery can come after phase 5, built in the same
API style as forms.
