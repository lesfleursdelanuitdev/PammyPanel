# Database examples: a recipe book and a blog

Status: **built 2026-09-21, not installed.** Decided with momolig 2026-09-21; where the choice
was Claude's, it is marked *(Claude)*. Q1-Q4 answered by momolig 2026-09-21 (last section).
What was built differently:
- **Pictures in her copy go through `files-upload`**, not `install-pages`: the sitefs socket takes
  64 KB a request, and a picture is bigger than that once it is base64. `install-pages` is
  unchanged (text only, 10 files). The pictures sit flat in `<page>-files/` beside the style and
  program, so her rows say `recipes-files/pancakes.jpg`; the example's say `./pictures/…`.
- `CatalogResource` gained `booleans`, `public`, `refs` and `many`, all optional so a catalog
  from an older panel still serves (as private, with no connections).
- A yes/no filter (`?where.published=true`, and the fixed rule) is compared as a yes/no: on
  MariaDB `published = 'true'` is false, which the old text comparison would have done.
- Found on the way: the Postgres identity counter point (X4) is tested on both real engines, and
  `list-rows` has an `in` filter (tested on both).
- Menu, pages, guide 14 PART 16 (+ a PART 13 note), verify-panel.sh checks as planned.

Two worked examples of the Database Manager, the way the form and media examples work: a
real, working thing on the panel she can look at and use, and a button that makes her own
copy. A **recipe book** and a **blog**. Each is three things at once:

- an **example database**: real tables, connections and sample rows, open in the Database
  Manager like any other (canvas, tables list, Fields pages);
- its **app**: the panel's generated pages for adding and changing recipes or posts
  (docs/databases-plan.md 11), already switched on;
- its **public pages**: a recipe book / blog that anyone can read, built on the data API.

Everything here builds on the Database Manager (docs/studio-plan.md, slices 1-10 live) and
follows docs/examples-plan.md and docs/media-api-plan.md for how an example looks and installs.

## Decisions

| # | Decision | Source |
|---|---|---|
| X1 | Public pages read her data with **no key**. A new per-table switch, **"Anyone can read these"**, lets the data API answer list and one-record reads without a key, only for exposed fields, rate-limited per address (the `open` limit, 120/min). Off by default; turning it on asks for a passkey, like the media label switch (M5), because it publishes. It works only while the app is on and **reading is switched on** -- the one switch that lets the internet in stays the master switch. A key is never put in a page. | momolig |
| X2 | The examples are **real databases**, `example_recipes` on her **Postgres** and `example_blog` on her **MariaDB** (so there is one of each engine to look at), owned by the panel and badged **example** in the Database Manager. She can open the canvas, change tables, add a recipe. **Reset** puts one back as shipped (tables, rows, settings). She cannot delete, unmanage, rename or switch off an example, and cannot make a database of hers with those two names. | momolig / names *(Claude)* |
| X3 | "**Make my own**" makes a **new, empty database of hers**: engine and name her choice (Postgres or MariaDB), the same tables and connections, the same app settings, its **app switched on**, reading on, "anyone can read" on for the tables the pages need -- and the **public pages written into a folder of her website**, pointed at her new database. A tick box, **"Copy the sample rows too"** (off unless she ticks it), brings the sample rows -- and, for the recipe book, their pictures -- across. | momolig |
| X4 | Sample rows go in **one at a time, without ids**, each connection filled in from the id the engine gave back. On Postgres the id counter then carries on after them, so her next recipe does not collide with a sample one (identity is `BY DEFAULT`; explicit ids would leave the counter at 1). | Claude |
| X5 | The example databases are made **when she first opens an example** ("Set it up" button, one passkey tap), not at start-up: making a database needs the database helper live and a manager present, and a panel that cannot reach Postgres should still start. After that, Reset. | Claude |
| X6 | The examples' apps are **not in her menu**. Two example apps sitting in the sidebar for ever would be clutter; the example page links to them ("Open the app"). Her copy is in the menu like any app. | Claude |
| X7 | Data API answers **carry the connections**, as docs/databases-plan.md 11.9 always said v1 would: a field pointing at another table comes with `{ id, label }` (label = that table's title field), and a many-to-many comes as an array of those, under the other table's name. Without this a recipe page needs four requests and a junction table made public. Has-many (a recipe's ingredients) stays a second request with `where.recipe_id=`. Only for tables the key or the public switch can read -- a label from a table she has not opened is left out, not leaked. | Claude |
| X8 | Menu: **Databases > Database examples** (managers only, like the rest of Databases). Pages `/databases/examples` and `/databases/examples/:kind`. | Claude |
| X9 | Each example page: the live public page framed (computer / phone), **Open in the Database Manager** (canvas) and **Open the app**, "The code" (the three files), **Make my own**, **Reset**. | Claude, after the media examples |
| X10 | A new part in guide 14, **PART 16 -- The two examples**, and a short note in PART 13 about "Anyone can read these". The example pages link to it. | Claude |
| X12 | **"Anyone can read these" can carry one fixed rule**: "only rows where *(a yes/no field)* is yes". The gate adds it to every keyless read of that table (lists, one record, and the connections of other tables' answers that point at it), so an unpublished post is not there for anyone without a key, however they ask. A key reads everything its grants allow, as now. Only yes/no fields can be the rule, which keeps it one tick box and one field picker. | momolig (Q2) |
| X13 | "Copy the sample rows too" copies rows the same way the examples are seeded (X4). The recipe pictures go into her folder beside the page, `<page>-files/pictures/`, and her rows point there -- never at the panel's copies, which Reset or an update could change. `install-pages` learns `.jpg` (up to 300 KB each, still never overwriting). | Claude |
| X11 | Comments on the blog are **not in this version**: they need the public to write, which the data API does not allow and should not casually start to. A later version can take comments through a Form (approved responses, like the guest book). | Claude |

## The two databases

Tables are made by the same draft machinery as everything else (the `Snapshot` below is
diffed against an empty database and applied), so an example can never hold something the
Database Manager could not have made.

### Recipe book (`example_recipes`)

```text
cooks          id, name (short text, required), about (text)
recipes        id, title (short text, required), summary (text), method (text),
               servings (whole number, starts 4), prep_minutes, cook_minutes (whole numbers),
               vegetarian (yes/no, starts no), picture (short text 500: an address),
               cook_id -> cooks (keep the recipe, remove the connection),
               created_at, updated_at
ingredients    id, recipe_id -> recipes (delete with the recipe, required),
               position (whole number), amount (short text 60), item (short text, required)
tags           id, name (short text 60, required, all different)
recipe_tags    recipes <-> tags, many have many (delete the pairs with either side)
```

Sample rows: 3 cooks, 8 recipes, their ingredients, 8 tags (vegetarian, quick, baking,
dessert, soup, family, weekend, summer). **Each sample recipe has a real photo** (Q3):
public-domain (CC0 / public domain mark) photos found through Openverse, hand-picked, resized to
800 px wide JPEGs (~60-100 KB) in `public-gate/examples/recipes/pictures/`, with a
`CREDITS.txt` naming each photo's source, title, creator and licence (not required by CC0, but
the honest thing). The rows point at them as `pictures/<name>.jpg`, relative to the page. A
recipe with no picture gets a coloured placeholder with its first letter.

App settings: Recipes (title field `title`, sorted by title, search on title and summary,
filter on vegetarian and cook), Cooks, Ingredients (list shows amount + item, sorted by
position), Tags. Public: recipes, cooks, ingredients, tags.

### Blog (`example_blog`)

```text
authors        id, name (short text, required), about (text)
posts          id, title (short text, required), slug (short text 120, required, all different),
               summary (text), body (text), published (yes/no, starts no),
               published_on (date), author_id -> authors (prevent deletion),
               created_at, updated_at
topics         id, name (short text 60, required, all different)
post_topics    posts <-> topics, many have many
```

`topics` rather than `tags` so the two examples do not teach that every database has a `tags`
table *(Claude)*. Sample rows: 2 authors, 6 posts (one not published), 5 topics.

App settings: Posts (title `title`, newest first by `published_on`, search on title and summary,
filter on published and author), Authors, Topics. Public: posts (**only published ones**, X12),
authors, topics.

## The public pages

Three files each, like every other example: `page.html`, `style.css`, `<kind>.js`, in
`public-gate/examples/recipes/` and `public-gate/examples/blog/`, with the blanks `@API@`
(the data API address of the database, e.g. `/_pammy/api/data/postgres/example_recipes`),
`@FILES@` and `@TITLE@`. The gate serves them pointed at the example database; "Make my own"
fills the same blanks for her copy. One source, two uses.

- **Recipe book**: cards (picture or placeholder, title, cook, minutes, tags); a search box; tag
  buttons to filter; click a card for the recipe: ingredients in order, method, servings, the
  cook. `#recipe-12` in the address, so a recipe can be linked to and Back works.
- **Blog**: newest posts first with summary, author, date and topics; a topic filter; a post
  page at `#post-<slug>`. The body is shown as plain paragraphs (blank line = new paragraph),
  never as HTML *(Claude: a body that could hold HTML would be a way to put script on her
  site through a database row)*.

Both pages are plain script with no libraries, written to be read (they are "the code"), and
show a friendly message when a request is refused (reading off, table not public).

## "Anyone can read these" (X1), in the gate

- `studio_resources.public_read` (migration 0010, boolean, default false) and
  `studio_resources.public_only` (text, default '': a yes/no field name, X12);
  `ResourcePatch.publicRead`, `ResourcePatch.publicOnly`.
- The catalog carries `public: { only: string | null } | null` per resource (only when enabled +
  decided, as now). The panel refuses an `only` that is not an exposed yes/no field.
- `allow()` gains one path: **no key, a read (`view`, `search`, `sort`, `filter`), the
  resource is public, and `api_read` is on** -> allowed. Everything else is as today (a
  keyless write is still `no-key`). Order of refusals unchanged, so a private table still
  says `no-key`.
- Keyless answers: `Cache-Control: no-cache` and an ETag (the forms API does this), limited
  per address with `open` (120/min).
- The Application tab: the switch on each table's settings, with the words "Web pages can show
  these to anyone, without a key." The Review page's impact line names public tables.

## Connections in answers (X7)

For each column that points at another **catalog** resource the request can read, the answer
adds `<name>: { id, label }` beside the raw `<name>_id` (the raw field stays, so nothing
existing changes). For each many-to-many through a junction between two readable resources,
`<other plural slug>: [{ id, label }, ...]`. Worked out from the catalog, which gains the
connections (`links`) the panel already knows (`relationships()`), so the gate still decides
nothing about the schema by itself. One extra helper call per linked table per page (ids
collected, one `IN` query) -- a page of 20 recipes is 3 calls, not 60. Needs a helper row op
`list-rows` with `where <col> IN (...)` (a filter kind the row builder does not have yet).

## "Make my own" (X3)

A form on the example page: engine (Postgres / MariaDB), database name (suggested
`recipes` / `blog`, checked like any new database), app title, website folder (the
`FolderPicker`) and page name (`recipes.html` / `blog.html`). One passkey tap. Then, in order,
each step saying what it did:

1. make the database (`create-database`) and start looking after it;
2. apply the tables (diff from empty, `apply-schema`);
3. write the app settings (the example's `ResourcePatch`/`FieldPatch`es);
4. switch the app on, reading on, "anyone can read" on the example's public tables;
5. write the three files into her folder (`install-pages`, never overwrites).

If a step fails, the steps before it stay done and the answer says which one stopped and
what to do (the database is hers either way; deleting it is the usual Delete). No attempt to
undo: undoing a create-database is a drop, which is not something to do on her behalf.
Activity: `database-example-copied`.

## The example databases' lifecycle (X2, X5)

- `studio_databases.example` (migration 0010, text, unique where not null: `recipes`/`blog`).
- **Set it up**: create `example_<kind>`, apply, seed (X4), settings, activate, reading on,
  public on. Idempotent: a database that is half there is reset.
- **Reset**: switch off (drops the gate catalog), drop the database, set it up again. Her rows
  in it are lost, and the button says so.
- Guards (panel side, not the helper's PROTECTED list, because the panel itself must be able
  to create and drop them): delete, unmanage, deactivate, rename and "App name" refused for an
  example with a sentence; `newNameProblem` in the panel refuses the two names for her own.
- The Databases dashboard shows them with an **example** badge, after hers.
- Engines: the recipe book lives on **Postgres**, the blog on **MariaDB**. If an engine is down,
  that example's page says so and nothing else breaks.

## Phases

1. **Anyone can read** -- migration, catalog, `allow()`, keyless caching and limits, the
   switch on the Application tab, tests (gate + panel).
2. **Connections in answers** -- catalog `links`, `IN` filter in the row builder (both
   engines, tested on real engines), expansion in the data API.
3. **Example definitions** -- `src/studio/db-examples.ts`: the two snapshots, rows,
   settings, public tables; unit tests that each snapshot passes `checkSnapshot`, applies to
   an empty database on both real engines, and seeds.
4. **Lifecycle** -- set up / reset / guards / dashboard badge, panel tests.
5. **Public pages** -- the six files, served by the gate, tried against the example databases.
6. **Panel pages + Make my own** -- `/databases/examples[/:kind]`, the copy flow, e2e.
7. **Guide 14 PART 16**, verify-panel.sh checks (example pages 200 + noindex, public read
   answers without a key, a private table still 401), memory note.

## Answered (momolig, 2026-09-21)

- **Q1.** Recipes on Postgres, the blog on MariaDB (X2).
- **Q2.** Unpublished posts: a fixed rule on "anyone can read" (X12).
- **Q3.** Sample pictures: real public-domain photos via Openverse, with credits (recipe book).
- **Q4.** "Copy the sample rows too" is a tick box in Make my own (X3, X13).
