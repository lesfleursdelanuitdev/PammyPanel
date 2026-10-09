# Databases: a visual workspace that becomes an application

Status: **planning.** Not built. This is the plan for a new tab, not a change to
the panel's own database (`docs/postgres-plan.md`) and not a rewrite of guide 13
(SSH, HeidiSQL, programs). Those stay.

Pamela already has two engines of her own on the server (guide 13): **MariaDB**
on port 3307 and **Postgres** on port 5433, both under `svc-pammydb`, role
`pamela` (Postgres has `CREATEDB` / `CREATEROLE` and is not a superuser). Today
she reaches them from her PC through an SSH tunnel, or from programs on the
server. The panel lets her pick which engine a database lives on. The canvas,
resources, and generated app are the same product on both; only the SQL the
helper emits changes.

This plan puts a **visual database workspace** in the control panel so she can
manage the lifecycle of a database without thinking like a DBA unless she wants
to. When she **activates** a database, that same design becomes a small
application: generated control-panel pages for humans, and a generated API for
programs, both sitting on one resource model.

The schema canvas is the centre of the designer: not a picture of the database,
a visual editor for the database itself. A **Resource** is Pammy's
application-level model of something stored there. Activation is what connects
that model to the interfaces (control panel and API).

```text
DATABASE
Physical storage (tables, columns, keys)
          │
          ▼
RESOURCE
Application meaning + metadata
          │
    ┌─────┴──────┬──────────────┐
    ▼            ▼              ▼
DataViewer   ResourceForm   Generated API
browse       create / edit  programs
records      (and view)     and websites
```

An **Application** is a grouping of Resources (Blog → Posts, Authors,
Categories). Each Resource automatically gets a DataViewer, a
create/edit form, and API operations. There is no separate **Views**
concept in this version. The DataViewer *is* the collection interface.

**Activate** is what joins Database to that application layer.

Before activation she has a database she can design. After: Resources, plus
control-panel pages, plus API — generated from those Resources, not drawn by
hand.

That is the product: a database designer, an admin-panel generator, a headless
CMS, and a backend-as-a-service, with her database still at the centre. She
defines the data model once, visually; Pammy derives both the human and the
programmatic interfaces from that definition.

---

## 1. Goals

- Pamela can **create, open, rename, inspect and safely delete** databases from
  the panel, the way she creates a folder. Creating one includes **which engine**
  it uses: Postgres or MariaDB (MySQL).
- She can **design the schema** on a canvas (tables, fields, keys, relationships)
  and through ordinary forms. Both views are the same schema.
- She can **grant access** in plain roles (Read only, Read & write, Structure
  editor, Administrator) to **database users** that are not her panel passkeys.
- Nothing she drags or taps on the canvas changes the live database until she
  **reviews and applies** the pending changes.
- She can mark tables as **Resources** (or let Pammy infer them) and
  **activate** the database, which publishes those Resources to the
  application layer.
- Once active, each Resource gets the operations she allowed (Create / View
  / Edit / Delete / List, and so on) as control-panel pages *and* as API
  operations, from one Resource definition — not two implementations.
- Generated forms and lists infer controls from field types and relationships
  (a boolean is a checkbox; a foreign key is a picker, not an id box). She can
  configure the Resource (label, control, which fields are exposed, "show in
  list") without changing SQL.
- The words on the screen explain the concept first; SQL names sit under
  Advanced.

### Not in this version

Moving a database from one engine to the other (no Postgres → MariaDB
migrator). SQLite, SQL Server, or any engine that is not already on this
server. Logical groups of tables on the canvas. Granular database privileges
(`SELECT` / `INSERT` / …). Query editor / SQL console. Importing a `.sql`
dump. Restoring a nightly backup from the panel (still "ask me", guide 13
PART 4). Limited (one-folder) panel accounts seeing the designer. Putting
either engine's port on the internet. WordPress-like domain apps
(`blog_posts` as a "content resource" with Drafts / Published sidebars) —
her WordPress MariaDB can be *adopted*, but we do not special-case `wp_*`
tables. A generic SQL console / phpMyAdmin-style row browser (the generated
list **is** a Resource record browser). Anonymous public read of resources
(forms already have a keyless `/approved`; this API does not, in v1).
Per-field / per-column grants on an app key (hide `body` from one key but
not another). Rich-text and media-picker *controls* (the Resource field
already has a control slot; those controls come later). One-to-one embedded
editors. Resources built from multiple tables or views (v1 is one Resource
= one table). Panel roles such as "Blog Editor" (v1 generated pages are
manager-only; the Resource still names which operations *exist*).

---

## 2. Words used here

| Word | Meaning |
|---|---|
| **Engine** | Which server program stores the database: **Postgres** (port 5433) or **MariaDB** (port 3307, the MySQL-compatible one). Chosen when the database is created, then fixed. The screen can say "MariaDB (MySQL)" so a WordPress or PHP guide still makes sense. |
| **Database** | A named container on one engine. Has a schema, users who can reach it, and settings. Not the panel's `pammy` database, not `gate.db`. She can have `blog` on Postgres and a different `blog` on MariaDB; they are not the same database. |
| **Database user** | A login on **one engine** (a Postgres role, or a MariaDB user `@127.0.0.1`). Direct database access (her app, HeidiSQL, a backup job). Separate from a panel account and from an API key. A user named `website` on Postgres is not the MariaDB user `website`. |
| **Access** | A database user granted a **role** on a particular database on the same engine. |
| **Role** | One of four, for database users: Read only, Read & write, Structure editor, Administrator. Mapped onto each engine's GRANT tables. |
| **Schema** | The structure: tables, fields, keys, relationships. On Postgres, v1 uses the `public` namespace only. On MariaDB, a database *is* the namespace (no extra schema UI). |
| **Canvas** | The visual schema editor. Tables are rectangles; relationships are lines between fields. |
| **Field** | On the canvas: a column. In a Resource: how Pammy should treat that column (label, control, exposed or hidden). Changing the Resource field does not change SQL. |
| **Pending changes** | Schema edits she has drawn or typed but not yet applied to the live database. |
| **Apply** | Run the pending changes as DDL, after a review that flags anything destructive. On an active database the review also names which Resources, pages and API operations move. |
| **Resource** | Pammy's application-level model of something stored in the database. It answers "what does this mean, and how should people and programs interact with it?" — not "how is it stored?" One Resource maps to one table in v1. Junction tables usually are not Resources; the relationship still works behind the scenes. |
| **Record** | One instance of a Resource (one row). The screen says "32 Blog Posts", not "32 rows in `blog_posts`". |
| **Resource definition** | The six parts in §11: identity, storage, fields, relationships, behavior, presentation. Not SQL. Lives in the panel store. |
| **Page** | A generated screen (All Blog Posts, New Blog Post, Edit). A Resource is not a page; Pammy builds pages *from* a Resource. |
| **Activate** | Publish this data model to the application layer: infer/review Resources, then create control-panel pages and API operations. Does not copy data. Does not put the database on the internet. |
| **Deactivate** | Take the application layer away. Data and schema stay. Pages and API stop. |
| **Application** | The generated control-panel section plus the generated API, both views over the same resources. |
| **API client / app key** | A credential a *program* uses to call the generated API. Not a database user, not a panel passkey. Existing form API keys stay for forms. |
| **Control-panel user** | A human with a passkey (Pamela, a manager, a limited account). |
| **UI metadata** | Canvas positions, zoom, simple/expanded many-to-many, *and* resource definitions (labels, controls, list columns). Not part of the database. |
| **Studio helper** | A small jsonline program (same shape as the website-folder helper) that is the only process which logs into her engines as the studio user. The panel never runs SQL from the browser. |
| **Drift** | The live database no longer matches what the canvas last applied (she, Claude, or HeidiSQL changed it outside the panel). |

Three kinds of identity, kept distinct on purpose:

```text
Database users     →  direct engine access (5433 or 3307, never the internet)
Control-panel users →  humans using pammy.org (passkeys)
API clients / keys →  programs using the generated API
```

---

## 3. Decisions

Numbered so you can confirm or change them. **D#** are for you (momolig).
**C#** are the choices this plan makes unless you say otherwise.

### Product — designer

- **D1 She picks the engine.** Creating a database asks **Postgres** or
  **MariaDB (MySQL)** before the name. The canvas, resources, generated
  pages and API are the same on both. The helper emits that engine's SQL.
  Engine cannot be changed later (no migrator in v1). Guide 13 still
  covers SSH / HeidiSQL / programs talking to either engine directly.
- **D2 The designer tab is "Databases".** Hierarchy:

      Databases → a database → Schema / Tables / Users / Settings / Application

  plus a sibling page **Database users**. After activation a *separate* menu
  group appears, named from the application's display name (e.g. **Blog**),
  with one item per resource. The designer and the generated app are not the
  same screen.
- **D3 Three identities, never mixed.** Creating a panel account never creates
  a database user or an app key. Granting panel "manager" never grants
  database Administrator and never grants API write. Form API keys (guide 10)
  stay for forms; app keys are a different credential, owned by an active
  database.
- **D4 Manager-only designer.** Creating databases, activating, and issuing
  app keys is server-wide, like today's API keys and Accounts. A one-folder
  account does not see **Databases**. (Whether a limited account may use a
  *generated* resource page later is a separate question; v1 generated pages
  are manager-only too.)
- **D5 The canvas is the schema, not a diagram of it.** There are no "diagram
  tables" vs "real tables". Creating `customers` in the Tables form and
  opening the canvas shows `customers`. Dragging a field on the canvas
  updates the form.
- **D6 Pending changes, always.** The canvas and the forms edit a draft. The
  live database changes only on Apply. Destructive steps need a typed confirm
  on the review screen, and a recent passkey. After activation the review also
  lists which resources, list pages, editors and API operations are affected.
- **D7 Design and data stay different surfaces.** The canvas answers "what
  does my database look like?" Generated Resource pages answer "what
  records are in it?" Inactive databases have no record UI. There is no
  generic SQL table browser in v1 — only Resource pages, and only after
  activation.
- **D8 Explain first, SQL second.** Relationship copy is "One user has many
  posts", then "One-to-many". Deletion copy is "Prevent deletion" /
  "Delete their posts" / "Leave posts but remove the relationship", then
  `ON DELETE RESTRICT` / `CASCADE` / `SET NULL` under Advanced.

### Product — application layer

- **D9 Activate means "make this database available to the application
  layer."** The button can say **Activate**. The explanation says it
  creates control-panel pages and API endpoints for its Resources.
  Inactive copy: "Feel free to design." Active copy: "Schema changes may
  affect live applications."
- **D10 A Resource is not a table, and not every table is a Resource.**
  A table answers "how is this stored?" A Resource answers "what does
  this mean, and how should people and programs interact with it?" Each
  table can be **Manage as Resource** (on or off). Junction tables
  default **off**, as do names that look like machinery (`sessions`,
  `schema_migrations`, `*_cache`). Other tables default **on**. A hidden
  junction table still stores the many-to-many; the Blog Post editor
  shows Categories, not "New Blog Post Category Relationship".
- **D11 One Resource, two interfaces.** Control-panel clicks and API
  requests go through the same operations. If she turns Delete off on
  the Resource, there is no Delete button *and* the API has no delete.
  We do not implement admin screens one way and the API another.
  Duplicate is a panel convenience (prefilled New); the API does not
  need a separate duplicate verb in v1.
- **D12 Activation does not publish to the internet.** Separate switches
  on the Application tab:

      Status: Active
      Control panel: on
      API read: off
      API write: off
      Authentication: required

  Defaults after Activate: control panel on, both API switches **off**,
  authentication required. Turning API read or write on still needs an
  app key; there is no anonymous Resource API in v1.
- **D13 Resources are inferred, then configured.** On the Application
  tab (and again just before Activate) Pammy proposes Resources from the
  schema: likely tables, display names, title fields, relationships,
  hidden junctions. She reviews, unticks, retitles, then Activates. She
  does not re-type what the schema already said.
- **D14 v1 is one Resource = one table, generic kind.** A later "this is
  a content Resource" is a `kind` on the definition, always `generic` in
  v1. We do **not** generate Drafts / Published / Scheduled nav items.
  Status is a field; she filters it in the DataViewer. Multi-table
  Resources are later.
- **D15 Deactivate hides the app; it does not drop the database.** Typed
  confirm + recent passkey. Data stays. App keys stop working. She can
  activate again.
- **D16 A Resource is not a page.** The Resource is the definition. Pammy
  generates three experiences from it: **DataViewer** (browse a
  collection), **ResourceForm** (create / edit / view one record),
  **API**. There is no Views object.
- **D17 Two permission levels.** The Resource names which operations
  *exist* (Create, View, Edit, Delete, Duplicate, Search, …). Identities
  (app keys now; panel accounts later) are granted a subset. An app key
  cannot Delete if the Resource itself has Delete off. v1 panel users are
  all managers, so the second level is mainly app keys.
- **D18 The Resource is a window, not a mirror.** She chooses which
  columns are Resource fields. `search_vector` and `internal_revision`
  can stay off the Resource, which means they are off the API too.
  Primary key stays in the API as `id` even if hidden from forms.
- **D19 The DataViewer is the only collection interface.** One generic
  component, the same idea as Gonsalves admin DataViewer, configured by
  the Resource (visible, searchable, filterable, default sort, title,
  later a card image field). Table or grid, 20 per page, search, filter,
  per-record view/edit/delete/duplicate. `DataViewer(resource = Blog
  Posts)` is what **Blog Posts** in the menu opens. Server-side
  `{ items, total }`. Not Gonsalves statistics, bulk edit, or bulk
  delete.
- **D20 Delete follows the schema; the Resource may only add a
  confirm.** "When an Author is deleted" on the relationship is the
  ceiling (Prevent / Cascade / Unlink). The Resource cannot make delete
  more destructive than that. It can choose **Follow the relationships**
  (default) or **Always explain and confirm first** (show related
  counts even if the FK would CASCADE). Prevent always refuses and
  names the related records. Defined on the Resource's Behavior, not a
  second delete policy on each row.
- **D21 No Views abstraction.** Draft posts are `Status = Draft` in the
  DataViewer, not a nav item. Saved filters (named queries) may come
  later as saved DataViewer state, still not a View type.

### How it sits on the server

- **C1 Studio helper, not SQL in the panel process.** The panel talks to a
  helper over a unix socket (jsonline, same as `sitefs`). The helper is the
  only thing that connects to `127.0.0.1:5433` (Postgres) and
  `127.0.0.1:3307` (MariaDB). It exposes a closed list of ops. Every op
  names the engine (or the panel id, from which the helper knows the
  engine). It never evals a string from the browser as SQL. Identifiers are
  checked against a safe-name regex before they are quoted. Row operations
  (`list-rows`, `insert-row`, …) are helper ops too; the generated API does
  not open either engine itself.
- **C2 Dedicated studio user on each engine.** Created at install:
  Postgres role `pammy_studio` with `LOGIN` + `CREATEDB` + `CREATEROLE`,
  **not** `SUPERUSER`; MariaDB user `pammy_studio`@`127.0.0.1` with rights
  to create/drop databases and users on that instance, **not** the
  `SUPER` privilege. Passwords in root-owned files the helper unit loads
  (`LoadCredential`), never in `/home/pamela/database-logins.txt` and
  never in the panel process. Two secrets, one helper.
- **C3 Existing databases can be adopted on either engine.** On first
  open, the helper lists databases `pammy_studio` can connect to on
  **both** engines. The default `pamela` database on each (from the
  no-sudo install) is offered as "manage this in the panel?" WordPress's
  MariaDB, if it sits on 3307 under another name, appears the same way —
  we do not special-case `wp_*`. Accepting grants studio what it needs
  without changing ownership of her data. Declining leaves it on SSH
  only. Adopted databases start **inactive**; activation is a separate
  step, after she has ticked resources.
- **C4 UI metadata and resource definitions live in the panel's own
  database**, not in hers. Table positions, drafts, "manage as resource",
  labels, controls, list columns, app keys' hashes. A dump of
  `family_archive` is the data; the application definition is a panel thing.
- **C5 Namespaces stay simple.** Postgres: tables she creates go in
  `public` only. MariaDB: tables go in that database (MariaDB has no
  extra schema UI). If an adopted Postgres database has other schemas,
  the panel shows `public` and says the rest are unchanged.
- **C6 The generated API is served by the gate**, same neighbourhood as
  forms and media (`/_pammy/data/…` or similar — exact paths later). The
  control-panel pages are on the panel, session cookie. Both call the same
  resource operations in the helper. App keys are checked on the gate the
  way form keys are today; they are not engine passwords. Clients do not
  need to know which engine is underneath.

### Names, safety, passkeys

- **C7 Database names** are identifiers that work on both engines:
  `^[a-z][a-z0-9_]{0,62}$`. No hyphens (Postgres would need quoting
  forever; MariaDB would allow them and then the two engines would
  disagree). Names are unique **per engine**, not globally: `blog` on
  Postgres and `blog` on MariaDB can both exist. Panel addresses therefore
  include the engine (`/databases/postgres/blog`). Reserved, never
  created from the panel: on Postgres — `postgres`, `template0`,
  `template1`, `pamela`, `pammy`, `pammy_studio`, `pg_*`; on MariaDB —
  `mysql`, `information_schema`, `performance_schema`, `sys`, `pamela`,
  `pammy_studio`. She can still *adopt* `pamela` on either engine.
- **C8 Table and field names** use the same regex. The canvas never emits
  quoted mixed-case identifiers. Rename is a pending change (`ALTER … RENAME`).
  After activation a rename is called out on the review as breaking the API
  field name.
- **C9 Database user names** same regex, plus reserved names on that
  engine. MariaDB users are created as `'name'@'127.0.0.1'` (TCP, matching
  guide 13); the host is not a UI field. The panel never lets her drop or
  rename `pamela` or `pammy_studio` on either engine.
- **C16 Engine is shown, never edited.** Cards, Settings, and Advanced SQL
  all name the engine. There is no "convert to Postgres" control.
- **C10 Resource names** have singular and plural ("Blog Post" / "Blog
  Posts"). Defaults from the table (`blog_posts` → Blog Post / Blog
  Posts). She can edit both without renaming the table. The API uses the
  table name (`blog_posts`), not the label, so renaming the label does
  not break clients.
- **C11 Recent passkey** for: create / rename / delete a database, create /
  reset / delete a database user, grant Administrator, Activate / Deactivate,
  turn API write on, create / revoke an app key, Apply when the review
  includes a destructive step or the database is already active. Granting
  Read only / Read & write (database users) is ordinary. Creating a blog post
  on a generated page is ordinary (session is enough).
- **C12 Delete a database** is typed confirm (type the name) + recent
  passkey + the helper `DROP DATABASE`. Refused while **active** — she must
  deactivate first. Nightly backups (guide 13) are how she gets data back.

---

## 4. Choosing an engine

The four layers do not care which engine she picked. A Blog resource is a
Blog resource. Only the helper's SQL dialect changes.

```text
New database

  Name     [ blog____________ ]

  Engine
    ( ) Postgres
    (•) MariaDB (MySQL)

  [ Create ]
```

Copy under the radios, short:

- **Postgres** — good default for a new app. Foreign keys and "apply all
  changes at once" are strongest here.
- **MariaDB (MySQL)** — pick this when something she already has (WordPress,
  a PHP program, HeidiSQL) expects MySQL.

**C17 Default the radio to Postgres** for a brand-new database, because
Apply can run in one transaction there (see §8). If she is adopting, the
engine is whatever that database already is.

Same canvas types on both (see §6). Advanced shows the real type for *this*
engine (`TIMESTAMPTZ` vs `DATETIME(6)`, `IDENTITY` vs `AUTO_INCREMENT`).

Same four roles on both. Same Activate, same generated API. A client holding
an app key never sees the engine.

What differs, and must stay visible so we do not lie:

| | Postgres | MariaDB |
|---|---|---|
| Port | 5433 | 3307 |
| Apply | One transaction; failure leaves nothing half-applied | DDL usually **cannot** roll back (implicit commit). Apply runs steps in order and **stops at the first error**. The review says so. The draft keeps the steps that did not run. Drift check then shows what did. |
| Auto id | `GENERATED BY DEFAULT AS IDENTITY` | `AUTO_INCREMENT` |
| Date and time | `TIMESTAMPTZ` (stored in UTC) | `DATETIME(6)` (stored in UTC; the panel always writes/reads UTC) |
| Unique id | `UUID` | `CHAR(36)` (native `UUID` if the server is new enough — helper picks) |
| Yes / no | `BOOLEAN` | `TINYINT(1)` (MariaDB's `BOOLEAN`) |
| Tables live in | `public` | the database itself |
| Users | Roles (`CREATE ROLE … LOGIN`) | `'name'@'127.0.0.1'` |
| New tables | default | `ENGINE=InnoDB` (needed for foreign keys) |
| Size | `pg_database_size` | `information_schema` / `data_length` + `index_length` |

WordPress, if it uses this MariaDB, is just another adoptable database. v1
does not hide `wp_options` for her; she leaves **Manage as resource** off.

---

## 5. The database dashboard

Address: `/databases`. Menu: a new group **Databases** with **Your databases**,
**Database users**, and (once any database is active) **App keys** as a
shortcut into that database's Application tab. A filter on the list:
All / Postgres / MariaDB.

She sees her databases as cards, engine named on each:

```text
family_archive                    Postgres · Inactive
8 tables · 3 users · Last modified today
Open Schema · Manage Users · Settings

blog                              MariaDB · Active · 3 resources
12 posts · API off
Open Blog · Schema · Settings
```

**New database** is a name plus an engine (see §4). The helper runs
`CREATE DATABASE` on that engine. The panel stores an empty layout, an empty
draft, status **inactive**, engine fixed.

Opening a database goes to `/databases/:engine/:name` (`postgres` or
`mariadb`). Tabs:

| Tab | Address | What it is |
|---|---|---|
| **Schema** | `/databases/:engine/:name` | The canvas. Centrepiece of the designer. |
| **Tables** | `/databases/:engine/:name/tables` | Conventional list + per-table field forms, plus **Manage as resource**. |
| **Users** | `/databases/:engine/:name/users` | Database users on *this* engine for *this* database. |
| **Application** | `/databases/:engine/:name/application` | Active/inactive, which tables are resources, control-panel / API switches, app keys. |
| **Settings** | `/databases/:engine/:name/settings` | Name, engine (read-only), application display name, size, delete, adopt/unmanage. |

A badge on Schema / Tables when pending changes exist: **5 schema changes ·
Review**. On an active database the badge wording is sharper: **5 schema
changes · may affect Blog**.

Home (`/`) gets a quiet card if she has databases. If any are active, the
generated app's first resource is a Home link too ("Blog posts waiting" is
later; v1 just "Open Blog").

---

## 6. The schema canvas

Imagine a simplified Figma / Lucidchart / ER diagram, not a DBA console.

Each table is a movable rectangle:

```text
┌───────────────────────────┐
│ users                     │
├───────────────────────────┤
│ 🔑 id          Integer    │
│    name        Text       │
│    email       Text       │
│    created_at  Date+time  │
└───────────────────────────┘
```

On the canvas, a field shows only what she needs at a glance:

- field name
- data type (plain word, not `VARCHAR(255)`)
- primary key, nullable / required, unique
- relationship (a small link mark)

Defaults, indexes, descriptions, check constraints, **and resource extras**
(control, list-column, label) sit in the **inspector** when the field or
table is selected.

```text
Table: blog_posts
Resource: Blog Posts     (or "not a Resource")

Fields
  id          Integer     ✓ Primary key  ✓ Auto-generated
  title       Text        Required
  body        Long text
  author_id   → Authors   Required
  published   Yes/no

[ + Add field ]
```

The canvas inspector is for **storage**. Resource identity, exposed
fields, controls, list columns and behavior live on the Application tab
(§11). A short link ("Edit Resource") is enough; the canvas must not
become a second Resource editor.

**Workspace, not a static picture.** Zoom, pan, drag tables, snap / align,
"fit schema to screen", and a simple auto-layout for a first visit or when
she asks. Positions are remembered (UI metadata).

**Creating a table** from the canvas: **+ Add table** drops a rectangle
named `table_2` (or the next free `table_n`) and opens the inspector so she
can name it. From Tables: **Create table** opens the form. Same draft.

Types she picks without opening Advanced. The canvas type is the same; the
helper stores it in that engine's SQL:

| She sees | Postgres | MariaDB | Generated control (v1) |
|---|---|---|---|
| Text | `TEXT` | `TEXT` | One-line input |
| Short text | `VARCHAR(n)` | `VARCHAR(n)` | One-line input, length in the inspector |
| Long text | `TEXT` | `TEXT` | Text area |
| Integer | `INTEGER` | `INT` | Number |
| Decimal | `NUMERIC` | `DECIMAL(12,2)` default; precision in the inspector | Number |
| Yes / no | `BOOLEAN` | `TINYINT(1)` | Checkbox |
| Date | `DATE` | `DATE` | Date picker |
| Time | `TIME` | `TIME` | Time picker |
| Date and time | `TIMESTAMPTZ` | `DATETIME(6)` | Date + time |
| Unique id | `UUID` | `CHAR(36)` (or native `UUID`) | Hidden on create if auto; otherwise text |
| Relationship | FK | FK, InnoDB | Selector of related records |
| Many-to-many | Junction | Junction, InnoDB | Multi-select / tag list |

Advanced (schema): the real type name **for this engine**, default value,
identity / auto-increment, length. Advanced (resource, later): rich text,
media picker. The inspector already has a **Control** row so we are not boxed
in; v1 only offers the controls in the table above.

A new table always starts with an `id` integer primary key, auto-generated
(Postgres `GENERATED BY DEFAULT AS IDENTITY`, MariaDB `AUTO_INCREMENT`),
which she can change or remove before Apply. New tables also start with
`created_at` / `updated_at` as optional suggested fields she can decline —
**C13: suggest, do not force.** They help the generated list's "Updated"
column. On MariaDB, `updated_at` can use `ON UPDATE CURRENT_TIMESTAMP` if
she keeps the suggestion.

Canvas library: **React Flow (`@xyflow/react`)**, bundled by Vite, no CDN
(CSP is `script-src 'self'`). Auto-layout can use a small dagre/elk helper
later; v1 can place new tables in a cascade and leave arrangement to her.

---

## 7. Relationships

She connects **fields**, not rectangles. Drag from `users.id` to
`posts.user_id`. The panel asks what kind, in her words, with the technical
name underneath:

| She sees | Means | What Apply does | What the generated form does |
|---|---|---|---|
| **One user has one profile** | One-to-one | Unique FK | Selector, or a link to the related record. No embedded editor in v1. |
| **One user has many posts** | One-to-many | FK on the many side | On the post: "Author [ Pamela Gonsalves ▼ ]". On the author: a list of their posts. |
| **Many users have many groups** | Many-to-many | Junction table | Multi-select. Junction table is not a resource unless she ticks it. |

If the target field does not exist yet, she can create it as part of the
gesture ("Add `user_id` on `posts`"). Types must match. The inspector
refuses a nonsense pair before it hits the draft.

The **title field** of a related resource (first required text field, or
`name`, or `title`, or she picks) is what the selector shows. Never the raw
id.

### Many-to-many

```text
A many-to-many relationship needs a connecting table.
Create one automatically?
```

Yes → create e.g. `user_groups` with `user_id` + `group_id` (composite
primary key, two FKs), **Manage as resource off**. She can rename the
junction table in the inspector. No → she points at an existing connecting
table.

**Two visual modes** (remembered per database):

- **Simple:** `Users ⇄ Groups` with an `M:N` mark. Junction hidden unless
  she selects the relationship.
- **Expanded:** the real three rectangles.

Both modes edit the same draft. Hiding the junction table does not delete it.

In the generated Blog Post editor she sees:

```text
Categories
☑ Travel    ☐ Personal    ☑ Photography    ☐ Technology
```

Pammy writes `blog_post_categories` itself.

### Relationship inspector

Selecting the line:

```text
Users → Posts

Relationship
  One user has many posts

Reference
  posts.user_id → users.id

When a user is deleted:
  ○ Prevent deletion
  ○ Delete their posts
  ○ Leave posts but remove the relationship
```

Advanced: `ON DELETE RESTRICT` / `CASCADE` / `SET NULL`, and `ON UPDATE`.
Default for a new relationship: **Prevent deletion** (`RESTRICT`). `SET NULL`
is offered only when the FK field is not required.

### Mobile

Do not shrink the desktop drag. The same canvas, but relationships are also
created by selection:

1. Tap `posts.user_id`
2. **Create relationship**
3. Choose table `users`, field `id`
4. Choose "One user → many posts"

Tables can collapse to a header (`Users  5`) and expand on tap. Desktop is
direct manipulation; mobile is tap-and-select. Same schema.

---

## 8. Pending changes

The strongest habit in the product: the canvas is an editor; Apply is the
moment of truth. After activation it is also how she changes a live
application.

She might accumulate:

```text
+ Added table: comments
+ Added comments.post_id
+ Added relationship posts → comments
~ Changed users.username length
- Removed users.nickname
~ Renamed blog_posts.title → headline
```

**Review changes** shows that list in her words, then the SQL under
Advanced. Destructive steps are marked:

```text
⚠ Removing users.nickname may permanently delete the words in that field.
```

On an **active** database, each step also names the application:

```text
Rename: title → headline

Affected:
  • Blog Post editor
  • Blog Post listing
  • Blog Post API  (clients sending "title" will fail)
```

Those need a check (or typing the field name) before Apply is enabled.
Apply:

1. Recent passkey if anything is destructive **or** the database is active.
2. Helper runs the DDL.
   - **Postgres:** one transaction. Failure leaves nothing half-applied.
   - **MariaDB:** steps in order, stop at the first error. DDL here usually
     cannot roll back. The review page says so in plain words: "These
     changes are applied one at a time. If a later step fails, the earlier
     ones have already happened." The draft keeps the remaining steps; a
     drift check then matches the canvas to what actually landed.
3. Resource definitions follow renames (field keys in metadata update). API
   field names follow the table/column names, so a rename *is* a breaking
   API change — the review said so.
4. On success, the draft becomes empty, UI metadata stays, activity log
   records `schema-applied` with the count of steps, `engine`, and
   `active: true|false`.
5. On failure, the error is shown in her words plus the engine message
   under Advanced.

**Discard** throws the draft away and re-reads the live schema. Positions
and resource ticks stay.

**Drift.** When she opens a database, the helper reads `information_schema`
(and on Postgres, `pg_catalog`). If that does not match the last
successfully applied snapshot, the panel says the database changed outside
the panel, offers **Take the live schema** (rebuild the draft from the
engine, keep positions and resource ticks where table names still exist) or
**Keep my draft**. No silent overwrite. Drift on an active database is a
stronger banner: the API may already disagree with the canvas.

---

## 9. Users and access

Two views of the same many-to-many: database users ↔ access ↔ databases,
**on one engine**. A Postgres user cannot be granted onto a MariaDB
database. This is **direct engine access**, for programs that speak SQL. It
is not how the generated API authenticates.

**Database users** (`/databases/users`) is grouped by engine:

```text
Postgres
  pamela_admin
  website
  analytics

MariaDB
  website
  backup_service
```

Creating a user asks which engine (same radios as New database). Opening
`website` on Postgres:

```text
website · Postgres

Databases
  ✓ pammy_main       Read + Write
  ✓ analytics        Read Only
  ○ family_archive   No Access
```

The MariaDB `website`, if it exists, is a different row.

From a database (`/databases/postgres/pammy_main/users`):

```text
pammy_main · Postgres
Users with access
  website       Read + Write
  pamela_admin  Administrator
  analytics     Read Only

[ Grant access ]
```

The grant list only shows users of **this** engine. Creating a database
user: engine (if not implied), name, password (generated, shown once).
Optional note. MariaDB host is always `127.0.0.1`. She can reset the
password later (recent passkey). She cannot see the old one.

### Roles (v1 — no privilege matrix)

| Role | She sees | Postgres (sketch) | MariaDB (sketch) |
|---|---|---|---|
| **Read only** | Can view data | `CONNECT` + `SELECT` on `public` | `GRANT SELECT ON db.*` |
| **Read & write** | Can view and change data | plus `INSERT`, `UPDATE`, `DELETE` | plus `INSERT`, `UPDATE`, `DELETE` |
| **Structure editor** | Can change tables and schema | plus `CREATE`, `ALTER`, `INDEX`, `REFERENCES` on `public` | plus `CREATE`, `ALTER`, `INDEX`, `REFERENCES` on `db.*` |
| **Administrator** | Full database access | `GRANT` all on that database; cannot drop the database | `GRANT ALL ON db.*`; cannot drop the database |

After Apply of a schema change, the helper re-grants so new tables are not
accidentally world-readable. Postgres: `PUBLIC` is revoked `CONNECT` on
databases she creates from the panel. MariaDB: no grants to `''@'%'` /
anonymous; only users she created.

A database user with Read & write can change rows **even if the generated
API write switch is off**. That is the point of the distinction: HeidiSQL
and her Node app on port 3042 are not the generated API.

---

## 10. Dual editing (schema)

Schema tab and Tables tab are two surfaces on one draft.

- Forms: create `customers`, `orders`, `products` with fields.
- Canvas: see `Customers ─────< Orders >──── Products` at once.
- Either side can add a field; the other updates without a save.

The Tables list is the conventional editor: per-table page with field rows,
reorder, type, required, unique, primary key. **Manage as Resource** lives
on the Application tab (and as a shortcut here). Resource identity, exposed
fields, behavior and presentation are not SQL and are not edited on the
canvas except as a peek in the inspector (label, title field).

---

## 11. Resources

> **A Resource is Pammy's application-level model of something stored in
> the database.**

A table answers: *how is this information stored?*

A Resource answers: *what does this information mean to Pammy, and how
should people and applications interact with it?*

That is the design rule: **Resources describe meaning and behavior
without pretending those things are the same as the underlying
structure.** A `TEXT` column can become a rich-text editor, a foreign
key can become an Author selector, a junction table can disappear into a
Categories picker, internal columns can stay hidden, and the API and
control panel are both generated from the same definition.

```text
DATABASE                    APPLICATION

blog_posts table     →      Blog Post resource
title VARCHAR        →      Title field
body TEXT            →      Rich-text editor
author_id INTEGER    →      Author relationship
status VARCHAR       →      Status selector
```

Left side is persistence. Right side is behavior and meaning. Changing
how a field appears in the control panel does not require changing the
database.

A Resource is a **type of thing** Pammy knows how to manage: Blog Post,
Author, Category, Comment, Product, Customer, Order, Event, Photo,
Recipe. One row is a **record** of that Resource. She sees "32 Blog
Posts", not "32 rows in `blog_posts`".

v1: **one Resource maps to one table.** Multi-table Resources and views
come later.

### 11.1 The six parts of a Resource

#### Identity — what is this thing?

```text
Name:        Blog Post
Plural:      Blog Posts
Icon:        document          (v1: a small built-in set)
Description: Articles published on the website
```

This is how it appears in the menu and on generated pages.

#### Storage — where does the data live?

```text
Table:       blog_posts
Primary key: id
```

The Resource does not store rows. The table does. The Resource points.

#### Fields — which columns belong, and how should Pammy treat them?

```text
title
  Database type:  text
  Resource type:  short text
  Label:          Title
  Required:       yes
  Exposed:        yes

body
  Database type:  text
  Resource type:  long text     (later: rich text)
  Label:          Article
  Help:           Write the main content of the post.
  Exposed:        yes

search_vector
  Exposed:        no            — stays an implementation detail
```

The Resource is a **controlled window** into the table. A column that is
not a Resource field is not on the form, not in the list, not in the
API (except the primary key, which the API always uses as `id`). That
is also an API-security rule: existence in SQL is not permission to
read or write.

#### Relationships — to other Resources, in her words

```text
Blog Post
   ├── belongs to → Author
   ├── has many   → Comments
   └── has many ↔ Categories
```

Underneath, `blog_posts.author_id REFERENCES authors.id` is still true.
The Resource understands "a Blog Post has an Author", which is what
lets Pammy generate a selector of names instead of `author_id: [ 17 ]`.
Many-to-many still uses the junction table; that table is storage, not
a Resource, unless she ticks it.

#### Behavior — which operations exist

```text
Blog Posts          Audit Logs
✓ Create            ✗ Create
✓ View              ✓ View
✓ Edit              ✗ Edit
✓ Delete            ✗ Delete
✓ Duplicate         ✗ Duplicate
✓ Search            ✓ Search
✓ Sort
✓ Filter

When deleting a record that has related records:
  (•) Do what the relationships say
  ( ) Always explain and confirm first
```

CRUD is not all-or-nothing. These flags control **both** the admin
interface and the API (D11). Duplicate is Create plus a copy; if Create
is off, Duplicate is off. Defaults for an inferred Resource: all on
except Filter (search is on; field filters are a tick). An "audit log"
she adopts can be View+Search only.

**Delete vs relationships (D20).** The schema relationship already
says what the engine will do (Prevent / delete related / unlink). That
stays the law. The Resource line above is only UX: follow that law
quietly (still a simple "Delete this Blog Post?"), or always show the
related counts first ("12 comments will also be deleted" / "this author
still has 4 posts, so they can't be deleted"). The Resource cannot
upgrade Prevent to Cascade; that is a schema change.

#### Presentation — how records appear

```text
Record title:     title
List columns:     title, author, status, published_at
Default sort:     published_at descending
Default view:     table          (cards on a phone)
Page size:        20             (fixed in v1)

Search:           title, slug     (short text; not long text by default)
Filter:           author, status, published_at
Create/edit form: title, author, body, categories, status, published_at
```

Search and filter are not a separate query language. They are **the
Resource's exposed fields**, each used according to its type:

| Field type | Search box | Filter |
|---|---|---|
| Short text | included by default | optional "contains" |
| Long text / rich text | off by default (too slow / noisy) | off |
| Yes / no | no | All / Yes / No |
| Date / date+time | no | from / to |
| Number | no | v1: skip, or equals |
| Relationship | no | picker of related records |
| Many-to-many | no | contains this Category |

Hidden columns cannot be searched or filtered (they are not a window).
She can tick extra fields on or off in Presentation; she cannot search
a column that is not a Resource field.

The database does not know any of this. Form field order and list
columns are presentation, not a second schema.

### 11.2 A Resource is not a page (and not a View)

The Resource is the definition. It provides three experiences:

```text
Blog Post Resource
│
├── DataViewer     browse the collection
├── ResourceForm   create / edit / view one record
└── API            the same operations for programs
```

Addresses:

```text
/app/:id/blog-posts           DataViewer
/app/:id/blog-posts/new       ResourceForm mode=create
/app/:id/blog-posts/:row      ResourceForm mode=view
/app/:id/blog-posts/:row/edit ResourceForm mode=edit
```

No "Views" type. No Draft Posts nav. Filters inside the DataViewer
cover that. Saved filters, if we add them later, are named DataViewer
queries (`status = draft`), still not a new layer.

### 11.3 Two permission levels

The Resource says what operations *exist*. Identities say who may use
them.

```text
Blog Posts — operations that exist
  Create ✓   View ✓   Edit ✓   Delete ✓

Then:
  Pamela (manager)       Create ✓  View ✓  Edit ✓  Delete ✓
  Blog Editor (later)    Create ✓  View ✓  Edit ✓  Delete ✗
  App key "website"      Create ✗  View ✓  Edit ✗  Delete ✗
```

v1: panel users are managers, so they get every operation the Resource
allows. App keys get a subset (read / write bits, mapped onto View vs
Create+Edit+Delete, and never more than the Resource allows). A later
"Blog Editor" panel role fills the second level for humans.

### 11.4 Inferred, then configured

Pamela should not re-enter what the schema already said. Lifecycle:

```text
Database schema
      │
      ▼
Pammy infers Resources
      │
      ▼
Pamela reviews / configures
      │
      ▼
Activate
      │
      ▼
Admin UI + API
```

Given `posts`, `authors`, `categories`, `post_categories`, Pammy
proposes:

```text
✓ Posts
✓ Authors
✓ Categories

Detected:  Posts → Author
Detected:  Posts ↔ Categories
Hidden:    post_categories   (junction)
Skipped:   sessions, schema_migrations
```

She can untick, rename (singular/plural), pick a different title field,
hide a column, turn Delete off, then Activate. Inference also runs when
she Applies a schema change on an already-active database (new table →
new proposed Resource, not silently published).

### 11.5 Generated forms

See **§11.8 ResourceForm**. Create and edit are one component. The
schema plus Resource field controls are enough to draw it.

### 11.6 Activate

Application tab, while inactive:

```text
Database
Status: Inactive

I found 3 likely Resources.

  ✓ Blog Posts     (blog_posts)
  ✓ Authors        (authors)
  ✓ Categories     (categories)
  ○ Blog Post Categories   hidden junction

Activating creates control-panel pages and API operations
for the ticked Resources. Nothing is on the internet until
you turn the API on and make a key.

[ Activate ]
```

After, with a recent passkey:

```text
Status: Active

Admin interface   ✓
API read          ○
API write         ○
Authentication    required
```

The menu grows a group named from the **application display name**
(Settings; she can set "Blog" while the database remains `blog`). One
item per Resource — not All / Drafts / Published:

```text
Blog
├── Blog Posts      → DataViewer(Blog Posts)
├── Authors         → DataViewer(Authors)
├── Categories      → DataViewer(Categories)
└── Comments        → DataViewer(Comments)
```

**+ New** lives on the DataViewer toolbar, not as a sibling nav item.
She does not build these screens. Deactivate: the group disappears,
keys stop, data stays. Resource definitions stay, so activating again
does not throw away her labels.

### 11.7 DataViewer (the collection interface)

One generic component, the same job as Gonsalves
`the-gonsalves-family-admin` DataViewer. We copy the **interaction**, not
the DaisyUI/TanStack source. Pammy chrome, **always server-paginated**.

```text
Resource: Blog Posts
┌────────────────────────────────────────────┐
│ Blog Posts                   + New Post    │
│ 32 blog posts                              │
│                                            │
│ Search...     Filters (2)    Table | Grid  │
│                                            │
│              DataViewer                    │
│                                            │
│ Showing 1–20 of 32              ‹ 1 2 ›    │
└────────────────────────────────────────────┘
```

Clicking **Blog Posts** in the app menu is exactly
`DataViewer(resource = Blog Posts)`. Authors is the same component with
different Resource metadata. That is the whole collection UI.

#### What the Resource passes in (Presentation)

```text
title field:     title
visible:         title, author, status, published_at
searchable:      title, body
filterable:      author, status, categories, published_at
default sort:    published_at descending
default view:    table          (cards on a phone)
card image:      (none in v1; later a media field)
```

Same DataViewer, different config for Customers or Products. The
component does not know what a blog is.

#### Anatomy (mapped from Gonsalves)

**Toolbar** (Gonsalves `DataViewerToolbar`):
- Count: `32 blog posts`, or `8 of 32` when search/filters are on
- Table | Grid join control (list icon / grid icon). No Statistics
  tab.
- **+ New** if Create is on (label from singular: "New post")

**Search:** always visible in the toolbar. Debounced (~300ms), case
insensitive, matches Presentation searchable fields. Empty = no
constraint. Goes back to page 1.

**Filter panel** (Gonsalves `FilterPanel`): a collapsible block,
"Filters" with a badge of how many are active. One control per
filterable field, typed from the field (yes/no triple, date from/to,
relationship picker, M:N contains). **Apply** and **Clear** — not live
on every click, because every apply is a helper round trip. Filters
AND together and AND with search.

**Table** (Gonsalves `DataViewerTable`):
- Columns = visible fields; relationship columns show the related
  record's title, not the id
- Click a header to sort (if Sort is on); that sort is sent to
  `list-rows`
- Row click → view (or edit if View is off)
- Actions column: View, Edit, Duplicate, Delete — each hidden when
  that behavior is off. Compact: hover shortcuts + a ⋯ menu, like
  Gonsalves

**Grid** (Gonsalves `DataViewerCardGrid`):
- Responsive cards (1 / 2 / 3 columns)
- Card title = title field
- A few visible fields under it (status, author)
- Later: if Presentation names a card image field, that image is the
  top of the card (photos, products, recipes, avatars). v1 has no
  media-picker control yet, so cards are typographic until then
- Same actions as the table, on the card

**Pagination** (Gonsalves `DataViewerPagination`):
- Fixed **20** per page, table and grid share the page
- "Showing 1–20 of 32" and first / prev / numbers / next / last
- Helper: `limit=20`, `offset`, `sort`, `search`, `filters` →
  `{ items, total }`
- Changing search, filters, or sort resets to page 1

**Empty states:**
- No records yet: "No blog posts yet" + New
- Filters/search matched nothing: "No blog posts match" + Clear

**Remembered:** table vs grid per Resource in `localStorage` (Gonsalves
`viewModeKey`). Phone defaults to grid.

**Out of v1, even though Gonsalves has them:** statistics view, row
checkboxes, shift-select, selection bar, bulk edit, bulk delete. Those
are how Gonsalves does genealogy batch work; Pammy's first DataViewer
is per-record.

**Duplicate and Delete** stay as already specified (unique fields
cleared; D20 confirm). Duplicate opens ResourceForm mode=create
prefilled.

#### Saved filters — later, still not Views

If she repeatedly wants Draft + Author = Pamela, a later control
**Save this filter** names it "My drafts" and lists it *inside* the
DataViewer. The nav stays `Blog → Posts`. Not a View type.

### 11.8 ResourceForm (create / edit / view)

The DataViewer is collections. The other generated piece is **one
record**.

```text
ResourceForm  mode = create | edit | view
```

Create and edit are the same engine. View is the same fields,
read-only (no third widget unless a later `kind` needs a special
read layout).

The Resource's form field list and each field's control (short text,
textarea, checkbox, date, relationship picker, M:N tags) are enough
to draw:

```text
Title        [________________]
Content      [                  ]
Author       [ Pamela ▼ ]
Categories   [ Guyana × ] [ History × ]
Published    [✓]
```

Rich text and media picker fill the existing control slot later; v1
uses the controls we already listed. Required / unique violations
show on the field. Save is `insert-row` or `update-row`. Cancel
returns to the DataViewer.

Duplicate is this form in create mode with values filled in (minus
unique / id / timestamps).

### 11.9 Generated API

Same operations as the Resource allows, gate-hosted, app-key
authenticated. The Resource is the common definition:

```text
             Blog Post Resource
                    │
          ┌─────────┴──────────┐
          │                    │
    DataViewer + Form          API
    browse / create / edit     List / Get / Create / Update / Delete
```

App keys live on the Application tab (not mixed with form keys on
`/api-keys`):

```text
App keys

pammy-blog-frontend
  View Blog Posts, View Categories

mobile-app
  View Blog Posts, Create Comments
```

A key has: label, secret shown once, per-Resource grants that cannot
exceed the Resource's own behavior. Write implies View. Creating a key
needs a recent passkey and API read or write to be on; otherwise the
copy says "Turn API read on before keys can work."

Revoking a key is immediate.

v1 response shape (illustrative): a list is `{ items, total }` (same
shape the DataViewer uses); one record is the **exposed** Resource
fields plus relationships as `{ id, label }`. Hidden columns do not
appear. Many-to-many arrives as an array of those. Writes accept ids
(and arrays of ids for M:N). The Resource layer translates junction
rows.

### 11.10 Spectrum (so we are not boxed in)

```text
Generic database table
        ↓
Inferred Resource
        ↓
Configured Resource       ← DataViewer + ResourceForm + API
        ↓
Saved DataViewer filters  ← later, still not a View type
        ↓
Domain-specific kind      ← later, only if DataViewer cannot express it
```

v1 stops at configured, generic `kind`. We do not invent Views because
other low-code tools have them.

---

## 12. Settings

For one database:

- Database name (`ALTER DATABASE … RENAME` on **Postgres**, recent passkey,
  not part of the schema draft). **MariaDB cannot rename a database**;
  Settings says so and only the display name is editable. Refused while
  active on Postgres too unless she deactivates — or we rely on C14 so the
  SQL name can change without breaking `/app` and the API.
- Engine — shown, not editable (C16).
- Application display name ("Blog") — resource metadata, not SQL. Must be
  unique among **active** databases so the menu does not list two Blogs
  (**C18**). If `blog` exists on both engines, the second active one needs
  a different display name ("Blog (MariaDB)").
- Size on disk (helper: `pg_database_size` or MariaDB table sizes).
- Created / last applied / last drift check / activated at.
- Unmanage (stop showing it in the designer; refused while active).
- Delete (deactivate first, then typed name + recent passkey + `DROP
  DATABASE`). Copy: nightly backups still exist for 7 days; restoring them
  is still "ask me".

No backup button in v1.

---

## 13. Addresses, menu, who can call

Designer:

```text
/databases
/databases/users
/databases/users/:engine/:user
/databases/:engine/:name
/databases/:engine/:name/tables
/databases/:engine/:name/tables/:table
/databases/:engine/:name/users
/databases/:engine/:name/application
/databases/:engine/:name/settings
/databases/:engine/:name/review
```

`:engine` is `postgres` or `mariadb`. Generated app (only while active) uses
the stable id from C14, so two engines cannot collide:

```text
/app/:id
/app/:id/:resource
/app/:id/:resource/new
/app/:id/:resource/:row
```

The menu shows the display name, not the id.

`PAGE_PATHS` and `web/src/App.tsx` grow these. Limited accounts: no designer
routes; v1 also no `/app/*` (D4). Panel JSON under `/api/databases/*` and
`/api/app/:id/:resource`. Generated public API on the gate (path TBD, stable
id, no engine in the URL). None of these go on `LIMITED_ROUTES`.

Activity actions (new): `database-created`, `database-renamed`,
`database-deleted`, `db-user-created`, `db-user-deleted`, `db-access-granted`,
`db-access-revoked`, `schema-applied`, `database-activated`,
`database-deactivated`, `app-key-created`, `app-key-revoked`,
`resource-created` / `resource-updated` / `resource-deleted` (optional; may
be noisy — **C15: log schema and activation, not every blog post**, unless
you want a paper trail of content).

---

## 14. What the helper actually does

New program, same pattern as the website-folder helper: one op per line,
JSON in, JSON out, unix socket. Suggested name: **`pammydb`**. Suggested
unit: a systemd service next to `svc-pammydb`, running as a user that can
open `127.0.0.1:5433` and `127.0.0.1:3307` as `pammy_studio` and nothing
else. The panel's `pammy-panel.service` gets the socket the way it does for
sitefs.

Every op carries `engine: "postgres" | "mariadb"` (or a panel database id
the helper resolves). One process, two connections, two credential files.

Ops (closed set):

| Op | Does |
|---|---|
| `list-databases` | Per engine: name, size, table count, connectable? |
| `create-database` | `CREATE DATABASE` on that engine + lock down public/anonymous grants + grant studio |
| `rename-database` | Postgres: `ALTER DATABASE RENAME`. MariaDB: **not supported** as SQL (no safe rename); she can change the display name. The panel says so on Settings. |
| `drop-database` | `DROP DATABASE` (no `FORCE` in v1; fail if sessions are open, tell her) |
| `adopt-database` | Grant studio on an existing DB she owns |
| `unadopt-database` | Revoke studio; panel forgets UI metadata |
| `introspect` | Tables, columns, constraints, FKs, indexes (Postgres: `public`; MariaDB: that database) |
| `apply-schema` | Helper-built DDL from a reviewed patch. Postgres: one transaction. MariaDB: sequential, stop on error. |
| `list-roles` | Studio-created logins on that engine (not `postgres` / `mysql` system users, not superusers) |
| `create-role` / `drop-role` / `reset-password` | Postgres `CREATE ROLE … LOGIN`; MariaDB `CREATE USER 'name'@'127.0.0.1'` |
| `grant-role` / `revoke-role` | Map the four panel roles onto that engine's `GRANT` / `REVOKE` |
| `database-size` | `pg_database_size` or MariaDB data+index lengths |
| `list-rows` / `get-row` | Paginated Resource reads of **exposed** fields (`limit` default 20, `offset`, `sort`, `search`, `filters`); `{ items, total }`; FKs as `{ id, label }`; M:N included; hidden columns omitted |
| `insert-row` / `update-row` / `delete-row` | Resource writes; junction rows maintained here |

The helper builds DDL from a structured patch (`addTable`, `dropColumn`,
`addForeignKey`, …) and DML from a structured record, never from a SQL
string the UI composed. Golden tests exist **twice**: once for the Postgres
SQL, once for the MariaDB SQL, from the same patch.

Install (a follow-on to `no-sudo/install-pamela-db.sh`, or a panel deploy
step): create `pammy_studio` on **both** engines, two credential files,
socket, unit. Do not put the studio passwords in `database-logins.txt`.

The gate never holds the studio passwords. It asks the panel (or the helper,
via the panel) after it has accepted an app key — same shape as today's
forms admin socket, details when we build.

---

## 15. Panel store (UI metadata, drafts, resources, keys)

In the panel's own database (SQLite today, Postgres under
`docs/postgres-plan.md` when that ships — same tables either way):

```text
studio_databases     id, engine (postgres|mariadb), name, display_name,
                     adopted_at, last_applied_at, last_introspect_json,
                     status (inactive|active), activated_at, api_read, api_write
studio_layouts       database_id, table_name, x, y, collapsed, group_id
studio_prefs         database_id, zoom, pan, mn_mode (simple|expanded)
studio_drafts        database_id, patch_json, updated_at, updated_by
studio_db_users      engine, name, note, created_at   -- cache; live source is the engine
studio_resources     database_id, table_name, enabled, kind,
                     singular, plural, icon, description,
                     title_field, list_fields_json, form_fields_json,
                     search_fields_json, default_sort_field, default_sort_dir,
                     can_create, can_view, can_edit, can_delete,
                     can_search, can_sort, can_filter, can_duplicate,
                     on_delete (follow|confirm)
studio_fields        database_id, table_name, field_name, exposed,
                     label, help, control, required, show_in_list, form_order,
                     search, filter
studio_app_keys      id, database_id, label, prefix, hash, grants_json,
                     created_at, revoked_at
```

Unique `(engine, name)` on `studio_databases`. Unique `display_name` among
rows with `status = active` (C18).

The live list of databases, roles and rows always comes from the helper.
The panel store is overlay: layout, draft, resource definition, keys. If
the store has a draft for a database the helper no longer lists, the panel
says it's gone.

Two managers editing the same draft: last write wins on the draft row, with
the same "someone else saved" stamp the form builder already uses if we can
thread it through cheaply; otherwise v1 is single-operator (Pamela).

---

## 16. Help, Home, activity

Guide **13** stays the server/SSH/HeidiSQL/programs guide. New guide **14
— Databases in the control panel**:

- PART 1: A database is a container (name, engine, users, schema).
- PART 2: Postgres or MariaDB — when to pick which; they are already on
  the server (guide 13).
- PART 3: Create one, open Schema / Tables / Users / Application / Settings.
- PART 4: The canvas, adding a table and a field.
- PART 5: Drawing a relationship (one-to-many).
- PART 6: Many-to-many and the connecting table; simple vs expanded.
- PART 7: Review and Apply; why nothing is live until then; why MariaDB
  applies one step at a time.
- PART 8: Database users vs people who sign into the panel vs app keys.
  Users belong to one engine.
- PART 9: The four roles.
- PART 10: What a Resource is (meaning, not storage); records, not rows.
- PART 11: Inference — Pammy proposes, she reviews, then Activate.
- PART 12: The six parts (identity, storage, fields, relationships,
  behavior, presentation). Why a junction table is not a Resource.
- PART 13: Generated pages vs the Resource itself; turning API read/write
  on; making a key. Hidden fields stay off the API. The API does not
  mention the engine.
- PART 14: Changing an active schema (rename is a live application change;
  a new table is a proposed Resource, not silently published).
- PART 15: When to still use HeidiSQL / Claude / guide 13 (SQL, dumps,
  programs that talk to the engine itself).

Home: if she has no databases, a one-line offer ("Make a database") once
she is a manager. If she has pending changes, say so. If she has an active
app, link it.

---

## 17. Phases

Build in this order so each step is usable without the next.

### Phase 1 — Dashboard and lifecycle

Menu, `/databases`, engine picker, create / list / rename / settings /
delete. Helper: `list-databases`, `create-database`, `rename-database`,
`drop-database`, `database-size`, `adopt-database` on **both** engines.
Tests: helper against throwaway Postgres (`PAMMYDB_TEST_URL`) and MariaDB
(`PAMMYDB_MARIA_URL`); panel tests mock the socket (same as sitefs). No
canvas yet. Status is inactive and stays there.

### Phase 2 — Database users and the four roles

`/databases/users`, grant/revoke from both sides. Helper: role ops.
Passwords shown once. Reserved names. Recent passkey on create / reset /
delete / Administrator.

### Phase 3 — Schema as forms + pending Apply

Introspect. Tables list + field forms. Draft in the panel store. Review
page with her-words diff + SQL under Advanced (that engine's SQL). Apply:
transaction on Postgres, sequential on MariaDB. Drift banner. Still no
canvas.

### Phase 4 — Canvas

React Flow workspace: tables as nodes, fields listed, inspector, pan/zoom,
fit, remembered positions, + Add table. Same draft as Phase 3. Desktop
drag of tables (not yet of relationships).

### Phase 5 — Relationships

Field-to-field edges, the three kinds in her words, inspector with deletion
behaviour, auto junction table, simple/expanded M:N. Mobile tap-and-select.
Apply emits `FOREIGN KEY` + junction `CREATE TABLE`. Junction tables are
born with **Manage as resource** off.

### Phase 6 — Resources and Activate

Inference from the schema (likely Resources, hidden junctions, skipped
machinery tables). Application tab: identity, exposed fields, behavior
flags, presentation (title, list columns, search, form order). Activate /
Deactivate. Menu group for the display name. No generated pages yet —
Activate with nothing to open is a hole, so Phase 7 follows in the same
ship if we can; otherwise Activate is disabled until Phase 7.

### Phase 7 — Generated control-panel CRUD

`/app/:id/:resource` is `DataViewer` (20 per page, table/grid, search,
filter panel). New / view / edit are `ResourceForm` modes. No Views
nav (Drafts = a filter). Helper `list-rows` is offset+total. Manager-only.

### Phase 8 — Generated API and app keys

Gate routes, app keys on the Application tab, per-Resource grants that
cannot exceed the Resource's behavior flags. API read/write switches
default off. Same operations as Phase 7. Hidden fields omitted.
Authentication required. No anonymous read.

### Phase 9 — Guide 14, Home card, activity, polish

Active-database review copy ("this affects the Blog Post API"), drift
banner, empty states, alignment / fit, collapsed tables on small screens.

**Stop.** Rich-text / media-picker controls, domain-specific kinds,
Resources built from multiple tables or views, panel roles such as
"Blog Editor", logical groups, SQL console, granular privilege
checkboxes, backup download, limited-account access to `/app`,
anonymous public read, logging every content edit, moving a database
from one engine to the other, a Views type, saved DataViewer filters,
Gonsalves statistics / bulk edit / bulk delete: later plans.

---

## 18. Tests (when we build)

- `pammydb.test.ts` — patch → SQL golden tests **for each engine**;
  identifier quoting; reserved names; role mapping; adopt/unadopt;
  insert/update that writes junction rows; delete that respects `RESTRICT`;
  MariaDB apply stops after a failed middle step and reports which steps
  landed. Live engines when `PAMMYDB_TEST_URL` / `PAMMYDB_MARIA_URL` are set.
- `panel.test.ts` — routes, manager vs limited, recent-passkey on
  destructive ops and on Activate, draft/apply API shape, mocked helper,
  resource ticks surviving a rename in the draft, inference hides
  junction tables, hidden Resource fields omitted from the mocked API
  payload, Delete-off Resource has no delete op.
- Gate tests — app key accepted / revoked / read-but-not-write; API off
  means 404 or 403 (prefer 403 with a clear message).
- `web/` component tests for the review list (destructive flag, "affected:
  Blog Post API") and the relationship copy (her words, not `1:N`).
- e2e later: create database → add two tables → relate → apply → tick
  resources → activate → create a row on the generated page → see it in
  the list.

Do not point tests at her real `pamela` database or at the panel's `pammy`
database.

---

## 19. Open questions

For you, before Phase 1 is coded. The C# / D# above are the defaults.

1. **D1** — Engine picker (Postgres / MariaDB) on create; engine cannot
   change later. Yes?
2. **D4** — Manager-only designer *and* manager-only generated pages in v1.
   Yes?
3. **C2** — Dedicated `pammy_studio` on **each** engine rather than logging
   in as `pamela`. Yes? (Adopt then has to grant studio onto DBs she
   already made as `pamela`.)
4. **Starters** — empty only, or one tiny starter ("a table called `items`
   with `id` and `name`")? Recommend empty + the default `id` on each new
   table, optional `created_at` / `updated_at`.
5. **Junction table names** — recommend: propose `user_groups` from the
   sentence "many users have many groups", and let her rename before Apply.
6. **Drop database while something is connected** — fail and tell her, or
   force-disconnect? Recommend fail: forcing would kill her app (and
   WordPress, if that MariaDB is in use).
7. **Guide 14 vs extending 13** — recommend a new 14 so 13 stays the
   server/SSH document.
8. **D12** — After Activate, API read and write both **off** until she
   turns them on. Yes?
9. **C15** — Do not activity-log every created blog post, only schema and
   activation / keys. Yes?
10. **C14** — Generated API and `/app` paths use a stable internal id so
    renaming the database (or having `blog` on both engines) does not break
    clients. Yes?
11. **Application display name** — default to title-case of the database
    name (`blog` → "Blog"), editable on Settings, unique among *active*
    databases (C18). Yes?
12. **Form API keys vs app keys** — keep them on different screens (today's
    `/api-keys` for forms; Application tab for app keys). Yes?
13. **C17** — New-database radio defaults to Postgres. Yes?
14. **MariaDB Apply is not transactional.** Sequential + stop + honest
    review copy. Acceptable? (The alternative is pretending it rolls back.)
15. **Same name on both engines** — allowed (`blog` twice). Addresses use
    `/databases/:engine/:name`. Yes?
16. **D13** — Infer Resources from the schema, she reviews, then Activate
    (rather than ticking every table by hand). Yes?
17. **D17 / D18** — Resource names the operations that exist; app keys get
    a subset; hidden columns stay off the API. Yes?
18. **Singular + plural names** (C10) on every Resource. Yes?
19. **D19 / D20 / D21** — DataViewer is the only collection UI (20/page,
    table/grid, search/filter from Resource metadata); no Views type;
    delete follows the relationship with optional Resource confirm;
    Duplicate clears unique fields and opens ResourceForm create. Yes?

---

## 20. What this is not

- Not a visual editor for the panel's own `pammy` / `gate` databases.
- Not phpMyAdmin / pgAdmin with a friendlier coat of paint. Those expose
  SQL. This exposes a lifecycle, a canvas, and — once active — an
  application generated from the schema.
- Not a replacement for guide 13. Programs on the server, SSH tunnels,
  nightly dumps, HeidiSQL, talking to Postgres or MariaDB as a database
  user: still that guide. The generated API is for programs that should
  *not* hold an engine password.
- Not "the diagram is a sketch we later generate SQL from, maybe." The
  diagram is the schema; Apply is how the live database becomes that schema;
  Activate is how that schema becomes an application.
- Not WordPress. v1 Resources are generic. Adopting the WordPress MariaDB
  is allowed; treating `wp_posts` as a Resource is her tick, not a
  special case. The slot for `kind` is how a later plan can make
  `blog_posts` feel like a content app without redesigning Database /
  Resource / Interface.
- Not a migrator. A Postgres database stays Postgres. A MariaDB database
  stays MariaDB.
