# The catalog: tags and categories on anything, File Explorer roots, media folders apart

Status: **decided 2026-09-26** by momolig (in conversation, C1-C14; open points at the end use
the suggestions unless momolig says otherwise); step 1 **trimmed** and built 2026-09-26 (see "Step 1
as built"). Builds on docs/media-plan.md,
docs/editor-plan.md (tags on every file), docs/roles-plan.md (privileges, `pammy-panel.json`)
and docs/domains-hosts-plan.md (the registry pattern). Platform plan phase 8 (File Explorer,
Tags, Media on lfdln) follows this shape.

What this is for: today tags and categories live in the `files` module, on files only, in schema
`media`. Exam prep wants to tag its 200 questions; a Studio table (recipes) or any app or
service may want the same. After this plan the **catalog** is a service of its own: a **source**
(a File Explorer root, a Studio table, an app) offers **items**, items sit in **scopes**, and
tags and categories are defined in scopes and put on items, by panel users, by the app itself,
or by the app's visitors. File Explorer, Media folders and Thumbnails become separate modules, so
a panel can have File Explorer with no media folders and still catalog every file.

## Decided (2026-09-26)

| # | Decision |
|---|---|
| C1 | **Four modules** where `files` is one today: **File Explorer**, **Catalog**, **Thumbnails**, **Media folders**. With Media folders off, `media/` is an ordinary folder whose files are still catalogued. |
| C2 | **The catalog knows nothing about files.** A **source** offers items; the source decides whether an item exists; the catalog keeps labels and a short cached description. |
| C3 | Sources: **File Explorer roots** (a switch per root), **Studio tables** (a switch per table), **apps and services** (declared in `pammy-panel.json`). |
| C4 | **Scopes are one tree**: **All** at the top, a scope per source below it, the source's automatic scopes below that (today's `/` and top-level folders), and scopes owners define. An item sits in its nearest scope; a label defined in scope S goes on items in S or below. |
| C5 | **Labels at All** go on any number of items in any source. |
| C6 | **A source declares, per resource, what labels mean to it** (`uses`): "featured" is *question of the day* to exam prep and *home page gallery* to the website's media grid. Labels without a declared use still work for search and filtering. |
| C7 | **Apps push and the panel pulls**: pull (a paged list the app declares) is the safety net, push makes changes show at once. |
| C8 | **Three kinds of tagger.** **Panel users**: shared labels, no moderation. **The app itself** (its key, tagging its own content): shared labels, **no moderation**. **Visitors, through the app or the API**: what the **app allows per resource**: shared only, personal only, both, or none. |
| C9 | **A visitor's shared labels are moderated**: nobody else sees one until an owner approves it. **Personal labels are not moderated**: only their visitor sees them. |
| C10 | Studio **sub-scopes** (records scoped by a field or connection) **later**. |
| C11 | **File Explorer roots are a registry**: a module adds roots (website and site folders, each software install, each project); **services get no root** (deployed from git by their owners, secrets in their env files). WordPress's root is its `wp-content/` only. |
| C12 | **"Programs" becomes an API keys module** (the menu keeps its words on pammy.org). A key belongs to a program or an app; later a key holds a role (docs/roles-plan.md). |
| C13 | **Thumbnails are for any item with a picture**: files today, a Studio picture field or an app's thumbnail later. |
| C14 | pammy.org sees **no difference**: its tags, categories, scopes, the media API's answers and the pages keep working as today. |

## What there is today (checked 2026-09-26)

- `packages/files` holds File Explorer (`sitefs`, `routes/files.ts`, `editor.ts`), the catalog
  (`media-db.ts`, `media-labels.ts`, `scopes.ts`, `media-sync.ts`), thumbnails
  (`media-thumbs.ts`, `thumbs/`), media folders (`sitefs/media.ts`, `routes/media.ts`), the media
  API (`gate/media-api.ts`, `media-public.ts`), media examples, and Subdomains (moving to hosts).
  One module; only the **rights** `files` and `media` tell them apart.
- Schema `media`: `media` (one record **per file under the website**, not only `media/`: path,
  scope, kind, size, hash, who/how added, state present/trashed/missing, title, alt), `tags` and
  `categories` (scope, name `[a-z0-9-]{1,40}`, `public`), `media_tags`, `media_categories`,
  `scopes` (paths; automatic = `/` and each top-level folder), `thumbs`, `sync_state`,
  `imported_notes`.
- File Explorer has **one root**: the website, through the folder helper (as `pamela` on
  pammy.org). Software files (`/pamela/apps/<id>` → `/srv/pamela-apps/<id>`) are outside it.
- `packages/programs` is only `api-keys.ts`; the `programs` right guards the API keys pages
  (forms responses API, data API, media API).

## The model

### Sources and resources

A **source** is one thing that offers items: a File Explorer root, a Studio table, an app. It has
one or more **resources** (kinds of item): files; a table's records; exam prep's `questions`
(and later `passages`). A resource says:

- how an item is named: its **key** (a file's path, a record's primary key, the app's own id:
  text up to 200 characters);
- how an item is shown: title, kind, thumbnail (optional), a link to open it;
- how the catalog learns of changes (C7);
- its **uses** (C6);
- **what its visitors may do** (C8): `visitorLabels`: `none` | `personal` | `shared` | `both`, and
  whether visitors may make **new** labels or only use existing ones (suggested default: existing
  only).

| Source | Resource, key | Changes |
|---|---|---|
| File Explorer root (catalogued) | files, path (the hash spots moves) | the panel's own changes + the sync (as today) |
| Studio table (switched on) | records, primary key; title field, picture field chosen | the panel's data API writes + a periodic id listing for writes made elsewhere |
| App or service | as declared | push (`POST /_pammy/catalog/items` with its key) + pull (its `list`) |

### Items

A reference to one thing in one source: resource, key, scope, cached title, kind, thumbnail,
state (present / missing / trashed), changed-at. A missing item keeps its labels 30 days (as
files do), so a restore brings them back. The source's own columns live with the source (a
file's size, hash, alt text: File Explorer's `files` table).

### Scopes (C4)

```
All                                  labels here go on anything (C5)
├── Website                          source: File Explorer, website root
│   ├── /recipes                     automatic: each top-level folder (today's scopes)
│   │   └── /recipes/desserts        defined by an owner (today's nested scopes)
│   └── /garden
├── Recipes table                    source: Studio table (sub-scopes later, C10)
└── Exam prep                        source: app
    └── questions                    a resource; the app may declare scopes below it
```

- Moving an item where one of its labels isn't visible takes that label off; Activity says which
  (as moved files today).
- Scopes are **places**: a limited panel account can be kept to scopes (as members to folders
  now); an API key and a role's `catalog.*` privileges apply within a scope. Exam prep's key
  reads and writes under **Exam prep** and never sees the website's labels.

### Labels and who puts them on (C8, C9)

A label is a **tag** or a **category** in a scope (name rules and `public` as today). Putting a
label on an item is a **link** that records who made it:

| Made by | Label | Seen by | Moderated |
|---|---|---|---|
| a panel user | shared | everyone the scope allows | no |
| the app (its key, no visitor named) | shared | everyone | no |
| a visitor (through the app naming them, or their own session) | **shared** (if the resource allows) | only them and owners until approved; then everyone | **yes**: Inbox → Tag suggestions, approve / decline, as comments |
| a visitor | **personal** (if the resource allows) | **only that visitor** | no |

- **Personal labels** belong to their visitor: their own names (e.g. "review later") or a shared
  label used privately. They're not listed in the panel (owners see counts), have a limit per
  visitor (suggested 500 labels, 5,000 links), and go when the account is deleted (accounts plan
  A9, GDPR).
- A visitor's **new shared label name** (when the resource allows new labels) is moderated with
  its first link: approving the link approves the name.
- An approved visitor link becomes an ordinary shared link; a declined one is gone (the visitor
  is not told the reason).
- Limits on visitor tagging per account and per IP (suggested 60 changes an hour), as forms.

### The two doors

- **The app's door**: `/_pammy/catalog/*` with the app's **API key** (C12). Without `for`, the
  app is tagging its own content (unmoderated). With `for: <account id>`, it acts for a visitor,
  and the visitor rules apply (the key can't make a visitor's action unmoderated).
- **The visitor's door**: the same paths with the visitor's session, on a host where the app has
  an area. The gate checks the visitor's privileges (docs/roles-plan.md): `catalog.read`,
  `catalog.tag` (shared, moderated), `catalog.tag:own` (personal), within the resource's
  `visitorLabels`. A role can't give more than the resource allows.
- Both answer: items by label, labels of an item (shared + the visitor's personal ones), label
  lists of a scope, with the `uses` so the app knows which label means what.

### `pammy-panel.json`: the `catalog` section

```json
"catalog": {
  "questions": {
    "label": "Questions",
    "list": "/api/catalog/questions",
    "open": "/questions/{id}",
    "scopes": "subject",
    "visitorLabels": "both",
    "visitorNewLabels": false,
    "uses": {
      "featured": { "kind": "tag", "label": "Question of the day", "means": "Picked for the daily question" },
      "topic":    { "kind": "category", "label": "Topic", "means": "Practice by topic groups questions by this" },
      "hidden":   { "kind": "tag", "label": "Hidden", "means": "Left out of practice and exams" }
    }
  }
}
```

- `list`: paged (`?after=&limit=`): id, title, kind, thumbnail URL, scope key, changed-at. Pulled
  every 15 minutes and on **Read again**; an id missing from a full listing becomes missing.
- `scopes`: the field that names an item's sub-scope (one scope per subject), made automatically.
- A use whose label doesn't exist yet: the panel offers to make it in the resource's scope (or
  All). A use shows beside the label wherever it's put on ("Featured, *Question of the day*
  (exam prep)") and on the Tags page ("used by: exam prep questions, website images").
- The same checks and "last good one stays" as the rest of the manifest (docs/roles-plan.md).

## The modules

| Module | Holds | Needs |
|---|---|---|
| **File Explorer** (`@panel/files`) | roots (registry, C11), the folder helper, browse/upload/copy/move/trash, the editor with versions; the File Explorer **source** for catalogued roots and its `files` table | core |
| **Catalog** (`@panel/catalog`) | sources, resources, items, scopes, labels, links, moderation, the Tags page, Inbox → Tag suggestions, the catalog API (both doors), the pull runner and the files sync's catalog half | core, API keys (the app's door), areas (the visitor's door) |
| **Thumbnails** (`@panel/thumbs`) | pictures for any item that has one (C13), the thumbs service | catalog |
| **Media folders** (`@panel/media`) | `media/` and its type rules, the Media grid, Media Folders, the media API, media examples | files, catalog, thumbs, API keys |
| **API keys** (`@panel/api-keys`) | keys for programs and apps (today's `programs`), the page | core |

Roots each module adds (C11): **website and site folders** (files; catalogued by default),
**each software install** (apps; `wp-content/` for WordPress; not catalogued by default),
**each project's source** (projects, phase 8b; a save is a commit and a deploy; not catalogued).
A root declares the helper and Unix user that reaches it (never root), read-only or not, refused
uploads, whether the editor saves, whether it's catalogued, and its places.

## Schema (moving `media` to `catalog`)

- `catalog.sources` (kind `files` | `studio` | `app`, ref, label, scope), `catalog.resources`
  (source, key, label, list/open, `visitor_labels`, `visitor_new_labels`, `uses` jsonb),
  `catalog.scopes` (tree: parent, key, label, source/resource, automatic, made by),
  `catalog.items` (resource, key, scope, title, kind, thumbnail, state, state-at, changed-at;
  unique (resource, key)), `catalog.labels` (scope, kind tag/category, name, public, made by,
  `owner_visitor` for personal names), `catalog.links` (item, label, made by panel user / app /
  visitor, `personal`, `status` shown / pending / declined, when), `catalog.sync_state`.
- `files.files` (item, path, size, hash, modified-at, added-at, added-by, how, trash id, alt):
  File Explorer's own columns; `thumbs.thumbs` keyed by item.
- The move (one migration, in a transaction): **All** and **Website** scopes made; today's
  `media.scopes` become scopes under Website with the same paths; tags and categories become
  labels (names, `public`, who made them kept); `media.media` rows become items + `files.files`;
  `media_tags` / `media_categories` become shown links made by panel users; thumbs keep their ids
  through a mapping. Counts and a checksum per table compared before commit; `media` schema kept
  read-only one release, then dropped.

## Steps

Each step is one release (build.sh, the installers, verify); pammy.org's verify passes
unchanged unless the step says otherwise.

| Step | What | Risk |
|---|---|---|
| 1 | **The split, no schema change**: `@panel/catalog`, `@panel/thumbs`, `@panel/media`, `@panel/api-keys` cut out of `files` and `programs`; imports moved; modules in the profile (pammy.org: all on); the menu as today. | medium: many imports move |
| 2 | **Catalog schema** and the move from `media.*`; File Explorer as the first source; the media API's answers byte for byte the same (verify compares). | high: Pamela's tags and scopes; the counts and checksums are the net |
| 3 | **File Explorer roots**: the registry; the website root; software roots (`wp-content/` for WordPress) not catalogued. | medium |
| 4 | **Studio tables as sources**: the switch, title and picture fields, data API writes tell the catalog, the id listing; tags on the record pages. | medium |
| 5 | **Apps as sources**: the manifest's `catalog`, the pull runner, the app's door (push, labels, reads) with its API key, app tagging unmoderated, `uses` in the panel. Tested with a fixture app. | medium |
| 6 | **Visitors tagging** (needs roles plan steps 2, 3 and 5): the visitor's door, `catalog.tag` / `:own`, personal labels, Inbox → Tag suggestions, limits, deleted with the account. | medium |

### Step 1 as built (2026-09-26, trimmed by momolig)

The catalog is left inside `@panel/files` until step 2: today's records (`media.media`) are
file-shaped, and the sync, the Files page and the tag editor share them, so a Catalog package cut
before its schema would move the same code twice. Step 1 cuts only what already stands apart:

- **`@panel/api-keys`** is `@panel/programs` renamed (module `api-keys`; the **right** stays
  `programs`, which accounts store). The API keys **page** and its `/api/api-keys` routes still
  live in `@panel/forms`; they move with step 2.
- **`@panel/thumbs`**: the Thumbnailer (`media-thumbs.ts`, with its own `ThumbSource` row type, so
  it doesn't import File Explorer) and the thumbnail helper (`thumbs/`). `@panel/files` needs it.
- **`@panel/media`** (module `media`, needs areas, api-keys, files, thumbs): the media folders'
  panel routes (`/api/media`, `folder`, `list`, `buckets`, `info`, `items`, `file`, `upload`,
  `mkdir`, `copy`, `move`, `trash`, `restore`, `examples*`), the media API and its index
  (`gate/media-api.ts`, `media-public.ts`), the media examples, and the Media, Make media folders
  and Media examples pages (with `move-copy`). The site wires the index's Publisher only with the
  module on.
- **Stays in `@panel/files`** (File Explorer, until step 2): labels, scopes, a file's details,
  the sync and each file's thumbnail (`routes/labels.ts`, same `/api/media/...` addresses, same
  rights), the records, `sitefs/media.ts` (the helper's media-folder rules), and the grid,
  details and tag components the Media pages import. The raw-upload body parser is registered
  there, so uploads work with Media folders off.
- **The gate** (`@panel/gate`, since accounts step 3) imports the API keys from `@panel/api-keys`
  and the media API from `@panel/media`; it serves the media API when `media` is on (was `files`),
  and its admin socket files `apikey*` requests under `api-keys` (was `programs`). pammy.org has
  every module on, lfdln has none of these, so neither panel answers differently.
- Routes: the same set on both panels (only their order changed). Rebased onto main 3f18e18 on
  2026-09-27; unit tests 1310/1310.

### Step 2 (2026-09-28): the schema move

DECIDED 2026-09-28 by momolig: every suggestion (Q2-1 the package in this step, Q2-2 categories
renumbered, Q2-3 any time, after telling Pamela).

What moves and what keeps working (C14: pammy.org sees no difference):

- **S2-1. The new tables, only what files need now.** `catalog.sources` (one row: the website,
  kind `files`), `catalog.resources` (one: its files), `catalog.scopes` (the tree: **All**, then
  **Website**, then today's paths `/`, `/olivia`, `/olivia/trips` below it, `automatic` kept),
  `catalog.items`, `catalog.labels` (kind tag/category, scope, name, `public`, who made it),
  `catalog.links` (item, label, made by a panel user, `personal` false, `status` shown),
  `catalog.sync_state`. `files.files` holds a file's own columns (path, size, hash, modified,
  added by/how, trash id, title, alt); `thumbs.thumbs` is keyed by item. Studio, app and visitor
  columns (`visitor_labels`, `uses`, `owner_visitor`, pending/declined) come with steps 4-6, in
  their own migrations, so nothing unused sits in the schema until then.
- **S2-2. Ids.** A file's item id **is** its media id (`OVERRIDING SYSTEM VALUE`): thumbnail
  files (`<id>-<hash>.webp`), the media API's ids and addresses, and any open page stay right.
  Tags keep their ids; **categories get new ids** (tags and categories share one `labels` table
  now). The pages read ids afresh, and the media API's answers name labels, never their ids.
- **S2-3. The move**: one migration in one transaction. Counts per table and a checksum of
  every (path, labels) and (scope, name, public) row, taken from `media.*` and from the new
  tables, compared before commit; any difference and it rolls back (the install then stops
  with the old code and the old schema, as for any failed migration, and the dump taken just
  before is there too). `media.*` stays, **read-only** (writes revoked), one release; step 3's
  migration drops it.
- **S2-4. The code.** `@panel/catalog` is cut out now (step 1 left it in `@panel/files` for this
  step): scopes, labels, links, the Tags page's routes, and the sync's catalog half. File
  Explorer keeps `files.files`, the records' life (added, moved, copied, trashed, restored), and
  the sync's file half; Thumbnails reads items. The routes, rights and pages stay at the same
  addresses. The API keys page and routes move from `@panel/forms` to `@panel/api-keys`.
- **S2-5. Proof on the day.** Before the migration, the pammy installer asks the media API for
  every public label and folder (and the panel's label and scope lists) and keeps the answers;
  after it, the same questions, compared byte for byte. A difference puts the previous release
  back and restores the dump. verify-panel adds the checks for the new schema (and that
  `media.*` refuses writes).
- **S2-6. lfdln** gets the empty tables (every site gets every migration); nothing uses them
  there until phase 8.

The harness first: a copy of the live `media` data (from the nightly dump, on a throwaway
Postgres) run through the migration, with the counts, checksums and the media API's answers
compared, before any code is built on it.

Questions:

- **Q2-1.** Cut `@panel/catalog` in this step (S2-4, as the plan says), or move the schema only
  and cut the package in step 3? Suggested: in this step; the code that reads the old tables
  has to change anyway, and changing it twice is the risk step 1 avoided.
- **Q2-2.** Categories get new ids (S2-2). Suggested: yes; nothing outside the panel uses them.
- **Q2-3.** When: the install touches Pamela's tags. Suggested: any time, after telling her
  (the Media and Files pages are down for the few seconds of the migration).

### Step 2 as built (2026-09-28, branch catalog-step-2)

- **The tables** as S2-1, plus `files.records`, a read-only view of a website file as
  media.media had it (the item, its file columns and its site scope's path): what File
  Explorer, the Media pages, Thumbnails and the media API read; writes go to the tables.
  `files.check_record` (checked at the end of a transaction) keeps media.media's rules across
  the two tables: the file columns are there, the scope and name follow from the path, trashed
  exactly when there is a trash id. The label triggers are media's, on `catalog.links` (a
  label in All goes anywhere, C5). An item keeps its site scope (`/` or a top-level folder) as
  media.scope was; "its nearest scope" waits for the Studio and app sources.
- **The code**: `@panel/catalog` holds scopes and labels (and links); the Tags and scopes
  routes **stay in File Explorer** at the same addresses (who may see a scope is a question
  about the website's folders, and a routes module in the catalog would need File Explorer's
  places: a cycle); they call the catalog. Module `catalog` (pammy.org: on); `thumbs` and
  `files` need it. The panel's search path is `panel, catalog, files, thumbs` (no `media`).
- **Not in this step** (S2-4): the API keys page stays in `@panel/forms`. It lists forms and
  media folders for a key to cover, so moving it needs a registry of "what a key can cover"
  first (forms and media need api-keys already); it waits for step 3 or its own.
- **The proof on the day** (S2-5, changed): install-panel.sh 1a asks the running version to
  sync and publish, then keeps every public label's answer and the whole index by names
  (tools/media-api-proof.ts; a copy in the dump folder); 5d asks again after the new
  version's sync and compares. A difference **stops the install and prints the way back**
  (restore the dump from 1b, then the release before), as a failed verify after a migration
  always has; it does not restore the database by itself.
- **The dry run** on a copy of live data: `node test/catalog-dry-run.ts <nightly dump>` (a
  throwaway Postgres; the old index, the move, the new index, compared).
- Tests: test/catalog-move.test.ts (the move, its refusal, the triggers, rights, the index
  before and after); the media records' and the pages' tests on the new tables.

Installed 2026-09-28 13:07 UTC: pammy.org ca44fda1 (the proof on the day the same: 19 files,
20 labels, 52 labels on files; verify 573/573), lfdln a816414b (339/339); main 5bb5fa7.

### Step 3 (2026-09-28): File Explorer roots

DECIDED 2026-09-28 by momolig: Q3-1 a helper per install, **Q3-2 admins may edit and upload PHP**
in software roots (others read-only; dot-files such as `.htaccess` and `.user.ini` refused for
everyone), Q3-3 the API keys page in its own step, Q3-4 `media.*` dropped now.

What there is: File Explorer has **one** root, the website, through **one** folder helper
(`pammy-sitefs` as `pamela`, sandboxed to `/pamela/public` and `/pamela/trash`; lfdln's
`lfdln-sitefs` as `svc-lfdlnsites` for its site folders, File Explorer off there until phase 8).
Every route takes a path relative to the website; a person's places are top-level folders of it
(`/olivia`). Software files are out of reach: the adopted blog is in `/srv/pamela-wordpress`
(`svc-pammywp`, 2770 + an ACL), a new install in `/srv/pamela-apps/<id>` (`svc-app-<id>`); today
there is no second install.

- **S3-1. The registry.** A root: id (`website`, `software-blog`), label ("Website", "Blog
  (WordPress)"), the helper socket that reaches it, read-only or not, whether the editor saves,
  refused uploads, catalogued or not, how its places are named. Modules add roots: File
  Explorer the **website** (catalogued, as today); **apps** one per installed software
  (`wp-content/` only, C11; not catalogued); projects (phase 8b) later. Services get none.
- **S3-2. One helper per root, as the root's own user** (never root, never `pamela` for
  software): `pammy-sitefs` stays as it is for the website. Software gets
  `pammy-rootfs@<id>.socket/.service`: the same helper code (`@panel/files/sitefs`) with the
  software's `wp-content/` as its folder, running as the software's user (`svc-pammywp`,
  `svc-app-<id>`), sandboxed to that folder and its own trash (`/var/lib/<user>/files-trash`,
  outside the web root, never served). The apps helper writes the instance's drop-in on install
  and adopt and removes it on delete; the installer does it for the blog that is there.
- **S3-3. What a software root refuses**: names starting with a dot (`.htaccess`, `.user.ini`:
  the WordPress container is Apache, which obeys them) for everyone; files WordPress would run
  (`.php`, `.phtml`, `.phar`) are uploaded and saved **only by panel admins** (Q3-2), shown and
  downloadable for everyone else. The panel tells the helper whether the person is an admin
  (only the panel can open the socket); the helper refuses code for anyone else whatever the
  panel checked. No media folders, no protected folders, no temporary home pages there (those
  ops refuse on a root that isn't the website). Activity names each PHP change.
- **S3-4. The routes and pages**: every `/api/files*` route takes `root` (default `website`, so
  every address today answers the same); File Explorer shows a root picker only when there is
  more than one root the person may see. Versions and trash are per root.
- **S3-5. Places**: a place is still a top-level folder of the website (`/olivia`); a software
  root is its own place (`software:blog`), given like any place on the Accounts page. A person
  kept to places sees a software root only if given it. Rights: `files` for all of it (no new
  right).
- **S3-6. `media.*` is dropped** (S2-3: kept read-only one release). The migration first checks
  that `catalog` still holds every row `media` had (the step 2 counts); if not, it refuses.
- **S3-7. lfdln** gets the registry and the new units, no roots switched on (File Explorer is
  off there until phase 8); its site folders become its website root then.

Tests: a software root on a throwaway WordPress-shaped folder owned by a test user (upload,
editor, trash, restore, versions; every refused name; no escape by `..` or symlink); every
`/api/files*` answer without `root` the same as today; verify on the live blog: listed, a .css
saved and put back, a .php refused.

Questions:

- **Q3-1.** Software roots as a **helper per install** running as its own user (S3-2), or one
  helper as a group member of every install? Suggested: one per install; a mistake in one can't
  touch another's files, and it's the pattern the apps already use (a user per install).
- **Q3-2.** In `wp-content/`, may panel users **edit PHP** (themes, plugins)? Suggested: **no**
  in this step: shown and downloadable, never saved or uploaded. WordPress's own theme editor
  and plugin installer are there for that, behind her WordPress sign-in; a panel mistake that
  runs code as the blog is worse than a refused save.
- **Q3-3.** The **API keys page** move out of `@panel/forms` (left over from step 2, it needs a
  registry of what a key can cover): in this step, or its own small step? Suggested: its own
  step after this one; this one is about files.
- **Q3-4.** Drop `media.*` now (S3-6)? Suggested: yes, as step 2 said; the before-install dump
  of step 2 (`pammy-20260928T130728Z-before-ca44fda1cc1bcc10.dump`, kept 60 days) still has it.

### Step 3 as built (2026-09-28, branch catalog-step-3)

- **The helper** (`@panel/files/sitefs`) has a software mode (`kind: 'software'`): File
  Explorer's and the editor's ops only (`SOFTWARE_OPS`; the rest answer "only for the
  website"); `.php` and its kin written, moved, renamed, trashed or restored only with the
  panel's `code: true` (a panel admin), and a folder holding any code counts as code; dot
  names never (as on the website); new files 664, folders 775 (setgid from the parent);
  `login-files` an ordinary folder there.
- **Units**: `pammy-rootfs@.socket/.service` (templates, by install-panel.sh) and a drop-in per
  install written by the software helper (`src/apps/rootfs.ts`, op `rootfs-sync`, also run
  after an install, delete, restore and purge, and by the installer): its user, `wp-content/`,
  its trash `/var/lib/<user>/files-trash`, and its config, backups, containers and
  `wp-config.php` made unreachable. **ProtectSystem=full, not strict** (strict would make
  folder and trash two mounts, and rename can't cross them); the unit's own
  InaccessiblePaths hide her website, the panel's secrets and the other services' folders.
- **The panel**: `packages/files/src/panel/roots.ts` (the registry); every `/api/files*` route
  takes `root` (none: the website, as before); a software root is listed from its helper (no
  records, labels, thumbnails or search), and its trash is `GET /api/files/trash?root=`.
  Activity names its files "blog: wp-content/...". The editor opens its `.php` read-only for
  anyone who isn't an account manager (`readOnly`), with no preview. File Explorer shows a
  root picker when there is more than one root, and a plain folder view for a software root
  (`components/software-files.tsx`).
- **S3-5 narrowed**: software roots are seen by people with `files` who are **not kept to
  places**; a person kept to places sees only their website folders. Giving a software root
  as a place waits: places are `/folder` everywhere (forms, the gate, hosts), and the gate
  refuses anything else.
- **media.\*** (catalog/0002): its tables and functions dropped, the empty schema kept (a new
  database's early migrations make their tables there), refused if media had files and the
  catalog none. `test/catalog-dry-run.ts` checks a post-step-2 dump: the catalog's index and
  labels the same before and after.
- Tests: test/rootfs.test.ts (the helper's software mode through its socket; the drop-ins),
  panel.test.ts (the routes on the blog's root: who sees it, read-only PHP, save, move, trash,
  restore, Activity), catalog-move.test.ts (0002 drops, and refuses). verify-panel.sh: per
  installed software, its helper's user, socket, refusals and sandbox (reads and refusals
  only; nothing is written into her software's files).

Installed 2026-09-28: pammy.org ad19d122 14:50 UTC (verify 595/595), lfdln d2587ba9 15:02
(339/339); main 7f78d57. The panel was down 14:06-14:51: the root sync's `${...}` was expanded
to nothing by systemd-run and removed the drop-in it had written, verify failed, and the
rollback put back code that couldn't start on the migrated schema (both fixed, with tests).

### Step 3b (2026-09-28): a software root as a place

DECIDED 2026-09-28 by momolig: QP1 files only, QP2 kept until deleted for good.

Step 3 showed software roots only to people not kept to places, because a place is a website
folder (`/olivia`) everywhere: forms and the gate, protected folders, media, hosts. This gives a
limited account the blog's files the way it gives them a folder.

- **P1. The place's name**: `software:<id>` (`software:blog`); the Accounts page lists each
  installed software beside the folders ("blog (WordPress) files"). It has to be installed
  and not deleted when it is given.
- **P2. What it gives**: File Explorer (and the editor) on that software's `wp-content/`, with
  the `files` right; nothing else. Its `.php` stay read-only for them (Q3-2: account managers
  only), as everything they can't change.
- **P3. Website places and software places kept apart**: the website's parts (forms, media,
  protected folders, File Explorer's website root, the Tags page) read only the `/...` places;
  the gate is sent only those. A person with **only** software places has no website place:
  those parts answer empty for them (the panel asks the gate nothing), never "the whole site"
  (the gate refuses an empty list, and an empty list must never mean everything).
- **P4. Rights with only software places**: only `files` (the others are about the website and
  would show nothing); with website places too, as today.
- **P5. When the software goes**: deleted (in its trash 30 days), its place stays on the
  account but reaches nothing; restored, it works again; deleted for good, it is taken off every
  account, in Activity.
- **P6. lfdln**: no installed software there; nothing changes (its places are hosts).

Tests: an account kept to `software:blog` sees that root only (not the website, not another
software), gets empty forms/media/protected answers without the gate being asked, can't be
given `forms` with only software places; one with `/olivia` + `software:blog` sees both; purge
takes the place off. verify: nothing new live (no such account exists).

Questions:

- **QP1.** P4: with only software places, only `files`? Suggested: yes.
- **QP2.** P5: keep the place while the software is in its trash, remove it at "deleted for good"?
  Suggested: yes.

As built (branch software-places): migration core/0003 lets `panel.user_places` hold
`software:<id>`; `rights.ts` keeps website places (`/...`) and software places apart
(`websitePlaces`, `softwareOfPlaces`; `keptTo` sends the gate website places only, `[]` for
someone kept only to software -- never null); `rightsOf` gives someone kept only to software
`files` alone, and `cleanAccess` refuses more (409). The Accounts page lists installed software
under the folders; the command line takes `software:blog`. File Explorer's roots: a kept person
sees the website only with a website place, and each software place's root; kept only to
software, `/api/files` answers `root: null` with their roots and the page opens the first. The
Tags page answers them empty. QP2: reading the software list takes places of software gone for
good off every account (Activity); an account left with no place loses its parts of the panel
too (no place would mean the whole site).

### Step 3c (2026-09-28): the API keys page in its own module (Q3-3)

DECIDED 2026-09-28 by momolig ("use your discretion"): QK1 yes, QK2 yes, QK3 no, as suggested.

Left over from step 2 (S2-4): the API keys **page** and its `/api/api-keys`
routes live in `@panel/forms`, because the page lists forms and media folders for a key to
cover, and `@panel/api-keys` can't import either (forms and media need api-keys, not the other
way round). Nothing a visitor or a program sees changes; the keys already made keep working.

- **K1. A registry of "what a key can cover"** in `@panel/api-keys`: a module that owns
  something a key can read registers a **cover kind** (`forms`, `media`), with
  - panel side: its words ("Which forms", "Which media folders"), how to list the choices for
    the page (forms: not trashed; media: folders with media), and one line for Activity;
  - gate side: the check it already has (today's `KeyChecks`: the form exists, the folder is
    one), keyed by kind.
  forms registers `forms` (and the `level`, approved/all responses, which is only about forms),
  media registers `media`. A kind whose module is off isn't offered (lfdln has neither: the
  page isn't there, as today).
- **K2. The page and routes move** to `@panel/api-keys` (same address `/api-keys`, same
  `/api/api-keys` routes, same `programs` right, same fresh-passkey rule for make/revoke, same
  Activity words). The page draws one section per registered kind instead of two fixed ones.
  pammy.org's menu keeps "Account > API keys".
- **K3. Storage stays as it is**: `gate.api_keys` keeps its `forms` and `media` columns; no
  migration. A key's cover is read and written through the registry, which maps each kind to
  its column. A generic `covers` (kind -> list) waits for step 5, when apps' keys need it
  (the app's door) and a migration is worth making.
- **K4. The Studio's data keys stay apart** (`gate.studio_app_keys`, made on a database's own
  page, one database each): they are a different thing (write rights per table) and have their
  own page; joining them is for the roles plan's "a key holds a role" (C12), not this step.
- **K5. The API keys module's dependencies** don't change (`core` only); forms and media gain
  the registration; the gate's admin socket asks the registry for the checks instead of
  forms/files functions by name.

Tests: the page's routes answer the same (list, make with each kind, none-at-all refused,
revoke, fresh passkey), Activity lines the same, a profile with forms on and media off offers
only forms (and the other way), the gate's checks unchanged (existing gate tests), the routes
list the same on both panels. verify-panel: the API keys checks it has already (make, read
responses and media with it, revoke).

Risk: low (code moves, no schema, no data). Install on pammy.org and lfdln; no dry run needed.

Questions:

- **QK1.** K3: keep the `forms`/`media` columns now and make `covers` in step 5? Suggested: yes.
- **QK2.** K4: leave the Studio's data keys on their databases' pages? Suggested: yes.
- **QK3.** Should the page also *show* each database's data keys (read-only, with a link to
  revoke on the database's page), so "every key there is" is on one page? Suggested: no for
  now (one more cross-module list); with the roles plan's keys.

As built (branch api-keys-page): `@panel/api-keys` has the routes
(`src/panel/routes/api-keys.ts`, given the covers), the cover type on each side
(`src/panel/covers.ts`: the Activity words; `web/lib/covers.ts`: the form's part, the badges and
facts), the page (`web/pages/ApiKeys.tsx`, moved from forms, one part per cover) and its menu
item. forms and media each have an `api-key-cover` (`src/panel/` and `web/`). The site hands in
the covers of the modules on; with none, no routes and no page. The routes send the gate
`forms: 'none'` with forms off and `media: null` with media off, whatever was asked. **K5
narrowed**: the gate's side is unchanged (`admin.ts` already imports forms and media for its
checks, and the checks are column-shaped until `covers` in step 5); the registry is the panel's
and the page's. The route list, the words on the page and in Activity are the same.
Tests: test/api-key-covers.test.ts (both kinds, each kind off, the words); unit 1264/1264.

### Step 4 (2026-09-29): Studio tables as sources

PROPOSED 2026-09-29; DECIDED 2026-09-29 by momolig ("continue"); BUILT 2026-09-29 (see "As built" below): Q4-1..Q4-6 as suggested (data API
labels as step 4b; Everywhere in this step; touches every minute; several at once later; 20,000;
off deletes).

What it's for: Pamela tags her recipes ("dessert", "quick") and her blog posts the way she tags
photos, and a label can be shared by both ("featured"). Only pammy.org has the Studio and the
catalog on; lfdln gets the release unchanged.

Checked 2026-09-29, what shapes this step:

- A managed table already has a **title field** (`panel.studio_resources.title_field`, inferred
  when empty: `name`, `title`, `label`, then the first text field), a primary key the record
  pages insist on (`keyOf`), and an `enabled` switch. There is no picture field.
- Records are written in five places: the panel's record pages (`routes/records.ts`), the
  examples, the gate's data API (`/_pammy/api/data/...`), the gate's form → table saves and
  comments (`form-links`), and outside the panel altogether (her PHP pages, her own SQL).
  Every panel and gate write goes through the pammydb helper; the gate can't read or write the
  panel's tables (it has only schema `gate`).
- The catalog code is website-shaped: `WEBSITE = 1`, scopes are folder paths, a label's address
  is `/recipes/t/dessert`. `catalog.sources.kind` allows only `files`, `catalog.items.kind`
  only file kinds. The Studio module doesn't need the catalog today (`NEEDS.studio = []`).
- A name clash: the Studio already has a "catalog" (`studio/catalog.ts`: what the panel pushes
  the gate about a database's API). It keeps its name in the code; this plan's catalog is always
  "the catalog", the Studio's is "the data API's catalog".

**S4-1. The switch.** On a managed table's settings (Database > the table's app > Settings), a
new part **Tags and categories**: "Let me tag these" (off), plus the **title field** (the one
it has) and a new **picture field** (optional: any short-text or text field). Off by default, so
nothing changes until she turns it on. Only for tables with a primary key (the record pages
need one already) and at most **20,000 records** (the listing below reads every key; a bigger
table says why it can't).

**S4-2. What the catalog gets.** Switched on, the table becomes a **source** (`kind` `studio`,
`ref` `<database id>/<table>`, label = her plural, "Recipes") with one resource `records`, and a
**scope** for it right under All (path `/`, label "Recipes"; no sub-scopes, C10). Each record
is an **item**: key = the record's primary key as the Studio already writes it in addresses
(one column: its value; several: the values joined as the record pages do), title = the title
field (cut to 200), kind `records`, changed-at. The picture value is kept with the source
(`panel.studio_catalog_records`: item, database, table, picture), not in the catalog (C2).

**S4-3. How the catalog learns of changes** (C7 for tables):
- the **panel's record pages and the examples** update the item in the same request (made,
  title changed, deleted);
- the **gate's writes** (data API, form → table, comments) add a line to a new
  `gate.record_touches` (database, table, key, made/changed/deleted, when); the panel takes
  them every minute through the admin socket (`touches-since`) and applies them; the gate
  keeps them 7 days;
- a **listing** every 15 minutes, and on **Read again** on the table's Tags part: a new pammydb
  op `list-keys` (key columns, title field, picture field only; paged by key) compared with the
  items: new records made, titles and pictures brought up to date, a record not in a full
  listing becomes **missing**. This catches her PHP pages and her own SQL.

**S4-4. A deleted record.** Deleted through the panel or the gate: its item and links go at
once (records have no trash), and Activity says which labels went ("Recipe *Lemon tart* deleted;
it had dessert, quick"). Missing from a listing (deleted elsewhere): kept 30 days as missing,
like files, and back with its labels if the key comes back **with the same title**; a record
with that key and a different title is a new item (MariaDB can hand out an id again after a
restart, and labels must never jump to another recipe).

**S4-5. Labels.** A table's labels live in its scope (made on the Tags page under "Recipes", or
typed on a record, as for files). **Labels at All** (C5) come in with this step: the Tags page
gets an **Everywhere** part at the top; a label there goes on files and on records. The
website's labels, their addresses and the media API's answers don't change (C14); a table's
labels get addresses of their own (`@recipes/t/dessert`, the `@` so they never look like a
folder). Name rules and `public` as today.

**S4-6. On the record pages.** A record's page (AppRecord) gets the same tag and category
editor as a file's details (`label-editor.tsx` moves to `@panel/catalog`'s web part, files and
Studio both use it). The records list (AppRecords) gets a Tags column and **filter by tag or
category**, the same control as the Files page. Choosing several records and **Add tags** as on
Files: suggested later (Q4-4).

**S4-7. Who may.** Tagging a table's records needs the `studio` right (as editing them does);
making, renaming or deleting a label in a table's scope the same. Labels at **Everywhere** need
both `studio` and `files` (they reach both). Accounts kept to places see no table scopes (places
are folders and software today). Activity lines as for files.

**S4-8. Pictures.** The picture field's value is looked at as a **site path** (`/media/x.jpg`,
`media/x.jpg`): if it's a catalogued website file, the record shows that file's thumbnail (C13,
no new thumbnails made). Anything else (an address on another site, empty) shows the record's
icon; the panel never fetches a picture from elsewhere.

**S4-9. Turning it off, renaming, dropping.**
- **Off**: the confirmation says how many records have labels ("12 recipes have tags; turning
  this off takes them off"); the source, its scope, items, links and the scope's labels are
  deleted; Activity says so. Labels at Everywhere stay (they only lose these links).
- **Renaming the table** (Tables page): the source's `ref` follows, nothing is lost (the Studio
  already renames the data API's key grants the same way).
- **Dropping the table**: its impact screen (`impact.ts`) adds "12 recipes with tags; the tags
  go too", then as off.
- **Deleting the database** in the panel: as dropping each switched-on table.

**S4-10. Schema.** `catalog/0003`: `sources.kind` allows `studio`; `items.kind` allows
`records`; the website-only checks (`files.check_record`, the `files.records` view) unchanged
(they look at resource 1 only). `studio/0001` (the Studio's first per-package migration):
`studio_resources.catalog` (boolean, default false), `picture_field` (text, default ''),
`panel.studio_catalog_records`, and `gate.record_touches` (the Studio's, as its data keys are;
the gate may insert and read, the panel reads through the socket). pammy.org's data is untouched: no
table is switched on until she does it. No dry run needed beyond the usual migration test on a
copy (nothing moves).

**S4-11. Modules.** The Studio's catalog part registers itself with the catalog when both
modules are on (as the API keys covers do); `NEEDS.studio` stays `[]`, so a panel with the
Studio and no catalog (none today) has no switch.

Not in this step: the **data API** answering with a record's labels or filtering by them
(`?tag=dessert` for her recipe page), because the gate can't read the catalog: the panel would
push a small index to the gate, as it does for the media API. Suggested as **step 4b** right
after (Q4-1). Visitors tagging records: step 6.

Tests: switch on/off (counts, deleted, Everywhere kept); each write path updates the item (panel
page, examples, data API, form → table, comments through touches); the listing (new, changed,
missing after a PHP-style direct write, back with the same title, not back with another);
rename and drop; labels at Everywhere on a file and a record; scope checks (a table label can't
go on a file and the other way); rights (`studio` only, `files` only, both); the website's labels,
addresses and the media API's answers unchanged; a 20,001-record table refused. verify-panel: on a
scratch table in a scratch database it makes and drops, turn the switch on, tag a record, see it
on the Tags page, delete the record, turn the switch off.

Risk: medium (a new source and a sync, no data moved). Install on pammy.org and lfdln (lfdln:
migrations only, the modules are off there).

Questions:

- **Q4-1.** Data API labels (`?tag=`, labels in answers) as **step 4b** right after this one,
  rather than in it? Suggested: yes (it touches the gate and needs an index push; keeping it
  apart keeps step 4 panel-side).
- **Q4-2.** Labels at **Everywhere** in this step (S4-5)? Suggested: yes: a label shared by
  photos and recipes is most of the point, and it is only a new part on the Tags page.
- **Q4-3.** Gate writes through `gate.record_touches` taken every minute (S4-3), or leave them
  to the 15-minute listing? Suggested: touches (a recipe added through a form can be tagged a
  minute later, not a quarter of an hour).
- **Q4-4.** Choosing several records and adding tags at once: later? Suggested: later (the
  Files page's selection code is file-shaped; one record at a time and the filter first).
- **Q4-5.** The 20,000-record limit? Suggested: yes (her tables look small, the examples'
  dozens of rows; not counted on live yet; raise it when a table needs it).
- **Q4-6.** Turning off deletes the labels on those records (with the count first), rather than
  keeping them 30 days in case she turns it back on? Suggested: delete (simple, and she is told
  what goes).

As built (branch catalog-step-4, 2026-09-29): `@panel/catalog` has `items.ts` (sources,
items, labels by scope, Everywhere) and `panel/routes/everywhere.ts`; the Studio has
`studio/tagging.ts` (a record's key, title and picture), `panel/tagging.ts` (the
`RecordKeeper`: the switch, the listing, the touches, one run at a time) and
`panel/routes/tags.ts`; the gate notes touches in `gate/studio.ts`. Migrations
`catalog/0003-studio-sources.sql` and `studio/0001-catalog-sources.sql`. Where it differs
from the above:

- **S4-2**: a source's `ref` is the Studio's own row id for the table
  (`studio_resources.id`), which a rename keeps, so S4-9's rename needs nothing. The row
  going (the table dropped, the database no longer looked after, an example reset) takes
  the source, its items and labels with it through a trigger (`panel.studio_resource_gone`
  -> `catalog.drop_source`), whatever the path; Review says so first for a dropped table
  ("Tags that go"). No Activity line of its own for that (the Apply has one).
- **S4-3**: the gate notes writes only to tables marked `tagged` in the data API's catalog
  it is pushed. A delete carries the key and goes at once; any other touch reads that
  table again. Notes come from the data API's three writes and a form's row; **not** from
  comments or the examples (the 15-minute listing catches those). A listing whose table
  changed size between pages marks nothing missing.
- **S4-6**: the list's column is "Tags & categories" (a table can have its own "Tags", a
  many-to-many: the example recipes do). Filtering by a label works for tables with a
  one-field key and up to 200 records with that label (the helper's `in` filter), else it
  says so.
- **S4-7**: the right is **`databases`** (there is no `studio` right): tagging records,
  the table's labels, the switch. Everywhere's labels: the `files` right plus `databases`
  with the Studio on; never for someone kept to places. (A person kept to places who types
  the name of an Everywhere label on a file does get that label: `findLabelInAncestors`
  looks at Everywhere last.)
- **S4-11 changed**: the module rule is "a module needs what its package depends on"
  (test/profile.test.ts), so `NEEDS.studio = ['catalog']`: a profile with the Studio has
  the catalog on (pammy.org has both; lfdln neither). A new database now runs the
  catalog's migrations (and the Studio's) before the areas module's; a live one only runs
  the two new ones.
- The media API ignores Everywhere's labels (its index takes the website's labels only),
  so its answers stay the same (C14); with the data API's labels in step 4b.
- A table unticked from the app ("Manage this" off) keeps its source and tags, unseen,
  until it is ticked again.
- Guides: 14 PART 17 (and a line in PARTS 12 and 14, and in the short version), 08's Tags
  part points at it.

Tests: test/catalog-records.test.ts (18: the switch, the listing, missing and back, the
touches, labels on records, Everywhere on files), test/e2e/41-record-tags.spec.ts (the
switch, a record's tags, the filter, Everywhere, off). verify-panel: the two migrations, a
tagged table that goes takes its source (as the panel, rolled back), the gate's touches are
the gate's.

### Step 4b (2026-09-29): her records' labels in the data API (Q4-1)

PROPOSED 2026-09-29; DECIDED 2026-09-29 by momolig ("continue"): QB1-QB5 as suggested. BUILT 2026-09-29 (see "As built" below).

What it's for: her recipe page shows "Desserts" by asking the data API for the recipes with
that category, and each recipe comes with its tags, the way her gallery page asks the media
API for pictures with a tag. Only tables with tags on (step 4) are affected; only pammy.org
has the Studio, so lfdln gets the release unchanged.

Checked 2026-09-29: the gate can't read the catalog (it has only schema `gate`), so it needs a
copy, as the media API reads the index the panel publishes (`media-public.ts`). The data API
filters rows through the helper; its `in` filter takes at most 200 values (`rows.ts`), which
is also why step 4's filter on the records page stops at 200.

**B1. The gate's copy.** A new `gate.record_labels` (database, table, record key, kind, name,
public), one row per label on a record, written only by the panel: an admin op
`record-labels.put` replaces a whole table's rows in one transaction. The panel sends it a
moment after anything changes a tagged table's labels (a record's labels, a label renamed,
deleted or made public, a record deleted, a listing that marked some missing, the switch),
at most once every few seconds per table, and after every 15-minute listing whatever
happened (the safety net). Off, or the table gone: its rows go. At most 20,000 records, so a
table's copy stays small.

**B2. In the answers.** For a table with tags on, each record the data API answers with (the
list and one record) carries `labels: { tags: [...], categories: [...] }`, names only.
(Not `tags`: a table can have its own field or connection called that; the example recipes
do.) If the table has a field called `labels`, the panel's are `pammy_labels` instead.

**B3. Asking by label.** `?tag=lemon&tag=quick&category=desserts`: only the records with all of
them (the same as the media API, which says `tag=`/`category=`). A name means the table's own
label or Everywhere's. The gate looks up the keys in its copy and asks the helper with an `in`
filter on the key, alongside her other filters, search, sort and paging, so `total` and the
pages stay right. A name nobody has (or one that isn't public, for a public reader): 404 with
the reason, as the media API does. Tables with a one-field key only (as step 4's filter).

**B4. Who sees which labels.** A **key** sees every label. **Without a key** ("Anyone can read
these") and **signed-in visitors**: only labels switched to **public**, in answers and in
`?tag=`. A new switch "Anyone can see it" on each of the table's labels (the table's Tags
part) and on Everywhere's (the Tags page), asking for a passkey like the media labels' switch.
A label is private until switched.

**B5. The label list.** `GET /_pammy/api/data/:engine/:name/:resource/labels`: the table's
labels (its own and Everywhere's that its records have), each with how many records have it,
public ones only without a key; for a page's filter buttons (as the media API's `labels`).

**B6. The `in` filter takes up to 20,000 values** (the most records a tagged table has), so
`?tag=` works for any number of records, and step 4's filter on the records page loses its
200 limit. (One parameter per value; Postgres allows 65,535, MariaDB far more.)

Not in this step: Everywhere's labels in the media API (C14 keeps its answers as they are;
suggested with visitors tagging, step 6, or on request).

Tests: the copy follows every change (label on/off a record, rename, delete, public, record
deleted, missing, switch off, table gone); answers carry `labels` only for tagged tables and
only public ones without a key; `?tag=` alone, several, with `category=`, with `where.` and
search, paging and `total`; an unknown or private name -> 404; `labels` renamed when a field
has that name; the label list; the `in` cap; the media API unchanged. Browser: the switch on a
table label and on Everywhere's. verify-panel: the gate can write its copy and the panel
can't read it; a keyless `?tag=` on a scratch catalog.

Risk: low to medium (the data API's answers gain a field for tagged tables only; nothing
changes for tables without tags). Install on pammy.org and lfdln.

Questions:

- **QB1.** Answers carry `labels: {tags, categories}` (B2)? Suggested: yes.
- **QB2.** A key sees every label; without a key or signed in, only public ones (B4)?
  Suggested: yes (as the media API).
- **QB3.** Making a label public asks for a passkey (B4)? Suggested: yes (it publishes).
- **QB4.** Raise the `in` filter to 20,000 values (B6)? Suggested: yes.
- **QB5.** Everywhere's labels stay out of the media API for now? Suggested: yes.

As built (branch catalog-step-4b, 2026-09-29): migration `studio/0002-record-labels.sql`
(`gate.record_labels`); the gate's side in `studio/src/gate/studio.ts` (`putRecordLabels`,
`keepRecordLabels`, `labelsOfKeys`, `keysWithAll`, `labelCounts`) and `gate/data-api.ts`; the
panel's in the `RecordKeeper` (`labelsChanged`, gathered 3 s, `allChanged` for Everywhere's,
`flush`, and a push after every listing) with `labelsForGate` in `@panel/catalog`. Where it
differs from the above:

- **B5**: the address is `.../:resource/_labels`, not `/labels`: a record whose key is
  "labels" keeps its address (a static segment would win over `:id`). Without a key it gives
  the public names only, no counts (a count would give away records her rule keeps back);
  with a key, counts and whether each is public.
- **B1**: the gate's admin socket takes requests up to 4 MB (was 64 KB), for a big table's
  labels in one go. A table switched off is told at once; renamed, dropped or no longer
  looked after: the next listing's `record-labels.keep` (every 15 minutes).
- **B3**: labels asked for by several names: records with all of them; up to 10 of each.
- Guide 14 PART 17: "On your pages". verify-panel: the migration, the gate can write its
  copy, the panel can't read it.

Tests: test/gate.test.ts "labels (catalog step 4b)" (6: untagged unchanged, a key sees all
and asks by several, keyless public only and her rule, the label list both ways,
`pammy_labels`, keep and refusals), test/catalog-records.test.ts (2: what the gate is told,
once for a flurry; off and keep), test/e2e/41 (the public switch on a table's label and on
Everywhere's).

Exam prep: questions as items after step 5; visitors' "review later" (personal) and suggested
topics (shared, moderated) after step 6. lfdln gets File Explorer, Catalog, Thumbnails and Media
folders in phase 8 on this shape.

### Step 5 (2026-09-29): apps as sources

PROPOSED 2026-09-29; DECIDED 2026-09-29 by momolig ("continue"): Q5-1..Q5-8 as suggested. BUILT 2026-09-29 (see "As built" below).

What it's for: exam prep's topics get tags and categories the way Pamela's photos and recipes
do. momolig marks a topic "featured" (*question of the day*) or "hidden" (*left out of
practice*) in the lfdln panel, and exam prep reads those labels and acts on them. Exam prep can
also tag its own topics itself (C8: the app's own labels, not moderated). Visitors tagging
comes in step 6.

Checked 2026-09-29, what shapes this step:

- **The only app with a `pammy-panel.json` is exam prep, and it is on lfdln.** pammy.org has
  no services and its one software install (the adopted WordPress blog) has no manifest.
  lfdln has none of the catalog's modules on (`catalog`, `files`, `thumbs`, `media`,
  `api-keys` are all off), although its database has the catalog's schema (every install runs
  every package's migrations).
- **Exam prep has no list of 200 stored questions.** Its questions are made from **73
  topics** (`MX.topics`: id such as `poly-addsub`, title, section, 2-3 variants each), with a
  fresh variant and seed each time. So a topic is the thing to tag; one generated question
  isn't.
- **The panel already talks to exam prep, server to server.** For deleted accounts
  (`services/src/panel/account-deleted.ts`) the lfdln panel calls
  `http://127.0.0.1:4101/_lfdln/account-deleted`, signed with exam prep's own key
  (`/etc/lfdln-panel/hooks/examprep.key`: HMAC-SHA256 over `"<ms>.<body>"`,
  `X-Lfdln-Timestamp` and `X-Lfdln-Signature: v1=<hex>`). Exam prep holds the same key as the
  podman secret `examprep-hook`. Its container reaches the host's 127.0.0.1 as `10.0.2.2`
  (slirp4netns, `allow_host_loopback`; that is how it reaches its database).
- **The manifest checker refuses any section it doesn't know** (`checkManifest` in
  `areas/src/manifest.ts`), so adding `catalog` to exam prep's file today would make the
  Access page refuse the whole file.
- **The catalog has no page of its own.** The Tags page, the label editor's routes and the
  scopes are in `@panel/files` and are website-shaped (`WEBSITE = 1`, folder paths). Step 4
  put records' tags on the Studio's own pages. An app needs a page for its items somewhere.
- The gate can read only schema `gate` (step 4b's reason for a copy). The panel can't be
  reached from outside except through nginx, and the lfdln units allow only localhost.

**S5-1. The manifest's `catalog` section.** As the plan's example, per resource:
`label`, `list` (a path on the service), `open` (an address with `{id}`, optional),
`scopes` (a field of each item that names its sub-scope, optional), `uses`, and
`visitorLabels` / `visitorNewLabels` (read and kept now, used in step 6). `checkManifest`
learns the section: the roles part ignores it, and the catalog has its own checks (resource
keys `[a-z][a-z0-9-]{0,31}`, at most 10 resources, at most 20 uses each, a path starting with
`/`, `{id}` in `open`). A bad `catalog` section refuses the whole file, as the rest of the
manifest does ("the last good one stays"). **Only services** can be sources: a site folder's
manifest has nothing the panel could call for its list, so a `catalog` section there is
refused with a reason.

For exam prep (done in exam prep's own step, S5-9):

```json
"catalog": {
  "topics": {
    "label": "Topics",
    "list": "/_lfdln/catalog/topics",
    "open": "/practice/{id}",
    "scopes": "section",
    "visitorLabels": "none",
    "uses": {
      "featured": { "kind": "tag", "label": "Question of the day", "means": "Picked for the daily question" },
      "hidden":   { "kind": "tag", "label": "Hidden", "means": "Left out of practice and exams" }
    }
  }
}
```

**S5-2. The switch.** On the service's page (Services > Placement Exam Prep), a new part **Tags
and categories**. It shows what the manifest's `catalog` section offers ("Topics, 73") and a
switch "Let me tag these", off. Turning it on makes a **source** (`kind` `app`, `ref` the
service id, label the service's title), one **resource** per entry, and a **scope** per
resource under All ("Placement Exam Prep: Topics"), then reads the list. When `scopes` is
given, each value gets its own automatic scope below ("Polynomials & exponents"). Off: as
step 4's off (the count first, then the source, items, links and its scopes' labels go;
Everywhere's labels stay). A resource that leaves the manifest: its items and labels go at the
next Read again, and Review says so first, as a dropped table.

**S5-3. Reading the list (pull, C7).** The panel asks
`GET http://127.0.0.1:<port><list>?after=<id>&limit=500`, signed with the service's key as
the deleted-accounts hook is, and gets
`{ items: [{ id, title, kind?, scope?, thumbnail?, changedAt? }], next: <id>|null }`. Ids up to
200 characters, titles cut to 200, at most 20,000 items per resource (as tables). Every 15
minutes and on **Read again**. An id missing from a full listing becomes **missing**: kept 30
days, back with its labels only with the same title (as records). A list that fails (service
down, a bad answer) changes nothing and says why on the page and in Monitoring.

**S5-4. The app's door (push and reads).** A small second listener in the lfdln panel on
**127.0.0.1:3048**, only the app's door, never proxied by nginx (the panel's own address stays
3046). Every request is signed with the calling service's key (the service named in
`X-Lfdln-Service`; timestamps older than 5 minutes refused). What it answers, each only for
the calling service's own resources:

| Request | What it does |
|---|---|
| `POST /_catalog/<resource>/items` `{ items: [...], gone: [ids] }` | push: the same rows as the list, made or brought up to date at once; `gone` deletes them (their labels go, as a record deleted in the panel) |
| `GET /_catalog/<resource>/labels` | the labels the resource can use (its scopes' and Everywhere's), each with its `use` if it has one, and counts |
| `GET /_catalog/<resource>/items?tag=&category=` | the ids with all of those labels (so exam prep asks "which topics are hidden?") |
| `GET /_catalog/<resource>/items/<id>/labels` | one item's labels |
| `PUT` / `DELETE /_catalog/<resource>/items/<id>/labels/<kind>/<name>` | the app tags its own item (C8: shared, not moderated); a name that doesn't exist yet is made in the item's scope |

Activity lines name the service ("Placement Exam Prep tagged *Dividing a polynomial by a
monomial* featured"). The app can't make, rename or delete Everywhere's labels, nor change
anything outside its own resources. Limits: 120 requests a minute per service.

**S5-5. The page for an app's items.** The catalog gets a page of its own, **Tags &
categories > <the service's resource>** (linked from the service's Tags part): the items
(title, scope, labels), a filter by tag or category and search, each item's labels in the
label editor (`label-editor.tsx`, which step 4 already moved to `@panel/catalog`), and the
resource's labels (make, rename, delete; the `uses` shown beside them, and a use with no label
yet offers to make it). Everywhere's labels are there too for these items. `open` makes each
title a link to the app. The Files Tags page on pammy.org is not touched (C14).

**S5-6. Rights.** Tagging an app's items and its labels: the **`services`** right (lfdln's
people who look after services). Everywhere's labels as step 4 (plus `services` where the
services module is on). Accounts kept to places see no app scopes.

**S5-7. Modules.** `NEEDS.services` stays as it is; the services' catalog part registers with
the catalog when both are on (as the Studio's does). lfdln's profile turns **`catalog`** on
(not files, thumbs or media; those are phase 8). So lfdln's catalog has no Website source to
show: its Everywhere part and app scopes only. pammy.org: nothing changes (no services, no
switch shown).

**S5-8. Schema.** `catalog/0004`: `sources.kind` allows `app`; `items.kind` allows anything
an app names (`[a-z][a-z0-9-]{0,31}`, default the resource key); `catalog.resources` gets
`list_path`, `open_url`, `uses` (jsonb, kept from the manifest), `visitor_labels`,
`visitor_new_labels`; a `catalog.app_state` (source, last listing, its result, next due). On
pammy.org the migration adds columns only; on lfdln it's the same plus the first data when
momolig turns a switch on.

**S5-9. Exam prep's side (its own step, after this one, as the Next.js steps were).** A
signed `GET /_lfdln/catalog/topics` listing the 73 topics (id, title, `section` as the scope);
the manifest's `catalog` section; reading the labels from the door every few minutes (cached,
so exam prep works when the panel is down: "hidden" and "featured" fall back to none);
"hidden" leaves a topic out of practice and exams, "featured" picks the question of the day.
Its tests, its verify.

Not in this step: visitors tagging (step 6); an API-keys-module key for a program that isn't
a service (C12: the key belongs to a program or an app; services use their own key here,
Q5-2); thumbnails for app items (C13, later); several items at once.

Tests: the manifest's section (good, each refusal, a site folder's refused); switch on/off;
the list (pages, missing and back, same-title rule, a failing list changes nothing, 20,001
refused); the door (signature, old timestamp, another service's resource, push and gone,
labels, `?tag=`, the app tagging, a new name made in scope, Everywhere's not made by the app,
the limit); uses shown and made; rights (`services`); Activity lines; pammy.org unchanged.
A **fixture service** in the tests (a small HTTP server with a key) stands in for exam prep.
verify-lfdln: the door answers only on 127.0.0.1:3048, refuses unsigned and wrongly signed
requests, nginx doesn't serve `/_catalog/`; with exam prep's side installed, its topics are
listed.

Risk: medium (a new listener and a new kind of source; nothing moved). Install on pammy.org
(migration only) and lfdln (catalog on, the door, the unit's second port).

Questions:

- **Q5-1.** Step 5 lands on **lfdln**, turning the `catalog` module on there by itself (no
  File Explorer, thumbnails or media folders until phase 8)? Suggested: yes (exam prep is the
  only app with a manifest; pammy.org gets the code with nothing to switch on).
- **Q5-2.** A service uses **its existing key** (the deleted-accounts hook's, already in exam
  prep as `examprep-hook`), both ways, rather than a key made on an API keys page? Suggested:
  yes (one key per service, already set up and signed; the API keys module stays off on lfdln).
- **Q5-3.** The app's door on the **panel's own second listener, 127.0.0.1:3048**, not through
  the gate? Suggested: yes (it is server to server; the catalog is the panel's, the gate can't
  read or write it; visitors' door in step 6 is the gate's).
- **Q5-4.** Exam prep's items are its **73 topics**, scoped by **section**, not generated
  questions? Suggested: yes (a generated question doesn't last; a topic does).
- **Q5-5.** The app may make **new labels** in its own scopes, and put Everywhere's labels on
  its items, but never make, rename or delete Everywhere's? Suggested: yes.
- **Q5-6.** The page for an app's items in the catalog module (S5-5), linked from the service's
  page? Suggested: yes.
- **Q5-7.** Tagging an app's items needs the **`services`** right? Suggested: yes (no new right).
- **Q5-8.** Exam prep's side as **its own step after this** (S5-9), built and installed on its
  own? Suggested: yes (step 5 is proved with a fixture service first).

As built (branch catalog-step-5, 2026-09-29): `@panel/catalog` has `apps.ts` (the
`AppKeeper`: the switch, Read again, the signed list, pushes, what the door reads, the page's
list), `panel/door.ts` (the door) and `panel/routes/apps.ts` (the pages' routes), and web pages
`Catalog.tsx` and `AppItems.tsx` (`/catalog`, `/catalog/:service/:resource`, menu Sites >
Tags & categories on lfdln). The section's checks are `@panel/core/manifest-catalog.ts` (the
roles' `checkManifest` and the catalog read the same), and signing is `@panel/core/signed.ts`.
Migration `catalog/0004-app-sources.sql`. lfdln's profile turns `catalog` on; its panel opens
the door (`PANEL_DOOR_PORT`, 3048, in panel.env) and reads the lists every 15 minutes (the first
2 minutes after start). Where it differs from the above:

- **S5-2**: the switch is on lfdln's **Tags & categories** page (one row per service that
  offers something, with Read again and a link per kind), not on the Services page (the
  services package would have needed the catalog's). Each kind is a **source of its own**
  (`ref` `<service>/<resource>`, label "Demo app: Topics", scope `/` under All), the shape of
  a Studio table, so `label_fits` and the rest need no change. A sub-scope is an automatic
  scope below it, found by its label, its path a slug; an empty one goes at a full listing
  once nothing (not even a missing thing) is in it.
- **A kind no longer offered**: Read again refuses with what it would take ("Topics (3 with
  tags)"), and the page asks before letting it go; the 15-minute round leaves it (shown "no
  longer offered") and still takes new kinds in.
- **S5-3**: a list that fails says why on the page (Monitoring doesn't show it).
  `items[].id` may be a number (made text); `kind` other than a word is the resource's key.
- **S5-4**: signatures are **v2**: HMAC-SHA256 over `"<ms>\n<METHOD>\n<path with query>\n<body>"`
  (`X-Lfdln-Signature: v2=<hex>`, `X-Lfdln-Timestamp`, `X-Lfdln-Service`), both ways, so a
  signed GET can't be used for another address; the deleted-accounts hook keeps v1. A push is
  at most 1,000 items and 1,000 ids gone. A name the app tags with that doesn't exist yet is
  made in the kind's own scope (not the item's sub-scope), `created_by` `app:<service>`.
- **S5-8**: no `catalog.app_state`: a kind's last listing is in `catalog.sync_state`
  (`app:<source>`), as a table's.
- The services helper has a new op `names` (ids and titles, without asking systemd).
- A folder's `pammy-panel.json` with a `catalog` section is refused at Read again (both
  panels), with the reason.
- Activity: `app-tags-on`/`-off`, `app-items-gone`, `app-items-missing`, `app-item-gone`,
  `app-tagged`/`app-untagged` (the service is the actor).

For exam prep's step (S5-9), what the panel does and takes: it asks
`GET <list>?limit=500[&after=<last id>]` on 127.0.0.1 at the service's port, signed v2 with
`examprep-hook`, and wants `{ items: [{ id, title, kind?, <scopes field>? }], next: <id>|null }`;
exam prep calls `http://10.0.2.2:3048/_catalog/topics/...` signed v2 with the same key and
`X-Lfdln-Service: examprep`.

Tests: test/catalog-apps.test.ts (14: the section and its refusals; on, pages, sub-scopes,
missing and back, a failing list, 20,001 refused, Read again and letting go, off; the door's
signatures, push and gone, the app tagging, labels and `?tag=`, the limit),
test/hosts-panel.test.ts (a folder's catalog section refused), test/e2e-lfdln/07-catalog.spec.ts
(on, the items, sub-scopes, a use made, tagging, the filter, Everywhere, off). verify-lfdln:
the migration, the door only on 127.0.0.1:3048, unsigned and wrongly signed refused, exam
prep's key taken, `/_catalog/` not on the panel's host.

## Open points (suggestions, taken unless momolig says otherwise)

- **Visitors' new label names**: the app decides per resource (`visitorNewLabels`), default
  existing labels only; a new shared name is moderated with its first link.
- **Personal labels and owners**: not listed in the panel (counts only); limits 500 labels and
  5,000 links per visitor.
- **Shared visitor tags "show right away"**: not offered (C9: always moderated).
- **Pull interval**: 15 minutes, plus **Read again**.
