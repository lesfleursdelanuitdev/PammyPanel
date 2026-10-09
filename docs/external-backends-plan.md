# External backends: projects and the Studio on Neon and Supabase (Appwrite, Firebase later)

PROPOSED 2026-10-06 (widened the same day to every project; reviewed against phase 0 and folded
with review D11-D13 and master-plan.md version 2 the same day). Nothing built. lfdln only.

**Status.** **Firm**: X-Q0 (Projects, N-Q1), L-Q3 (components through each provider's own SDK,
one adapter per provider). **Provisional** (momolig took the suggested answers "for now",
2026-10-06; each is confirmed or changed before the step named, master-plan.md section 2): X-Q1,
X-Q2, X-Q10 before X2; X-Q5 (Postgres part), X-Q6, X-Q7, X-Q9 before X3; X-Q11, X-Q12, X-Q13
before X5. **Deferred** (master-plan.md section 11): X6-X9, and with them X-Q3, X-Q4, X-Q5's
Appwrite / Firebase parts, X-Q8. Where the review (docs/security-performance-review.md) changed a
suggestion (X-Q2, X-Q8, X-Q10, X-Q13), the changed one is the answer and is written below.

Companion to docs/backend-plan.md (a project's **Backend tab**) and docs/projects-domains-plan.md
(projects and their kinds). Order, dependencies and decisions: docs/master-plan.md (Track X) wins
over this file; how each step works: this file.

momolig, 2026-10-06: *"currently all projects managed by the panel are associated with
databases on the server. We want to allow users of the panel to create a project and connect
it to an external backend such as Supabase Cloud, Neon, Appwrite Cloud, Firebase. The studio
should be able to work with each of these backends."* And: *"when I say projects, I mean
services, hosts, site folders, installed apps, all those things managed by the panel."*

**Words in this file.** A **project** is anything the panel runs or serves, with a **kind**:
Files, Code (8b), Installed, Connected (docs/projects-domains-plan.md). Hosts are addresses of
projects, not projects (N-Q2). "Source" already means a catalog source (docs/catalog-plan.md
C3), so a database or backend a project uses is a **data store**.

## What there is today (checked 2026-10-06)

- **A Code project's data is always on this server.** Phase 8b's Database page makes a database
  on lfdln-appdb (:5436) or lfdln-appmaria (:3308) through the Studio's helper, one per branch
  (P8b-5), and sets `DATABASE_URL` (Laravel: `DB_*`). The container reaches it at 10.0.2.2.
- **The Studio speaks SQL only.** Its helper (`packages/studio/src/pammydb`) has one `Driver`
  interface (`driver.ts`) with two engines (`pg.ts`, `maria.ts`): databases, logins and
  grants, `introspect` → `Snapshot`, `apply(Step[])` for reviewed schema changes,
  `listRows` / `getRow` / `insertRow` / `updateRow` / `deleteRow` / `setLinks`. Everything
  above it (canvas, records, resources, catalog, data API, form links, comments, record
  picker) is built on that interface and on SQL ideas: tables, columns with types, keys,
  foreign keys.
- **The helper can only reach this machine.** `deploy/pammy-pammydb.service`:
  `IPAddressAllow=` localhost, nothing else. It cannot open a connection to Neon or Supabase.
- **Secrets for Code projects** are kept by the projects helper
  (`/var/lib/lfdln-projects/env/<name>.json`, root 600), handed to containers as an env file;
  revealing one in the panel needs a fresh passkey (8b).
- **Outgoing IPv6 works** (checked): Supabase's direct database address is IPv6-only, so it is
  reachable without their paid IPv4 add-on.

## The four providers are two kinds

| | Supabase Cloud | Neon | Appwrite Cloud | Firebase |
|---|---|---|---|---|
| **Data is** | Postgres | Postgres | Appwrite databases: collections and documents with typed attributes (called tables / rows / columns in recent Appwrite versions) | Firestore: collections of schemaless documents, subcollections |
| **Studio reaches data by** | a Postgres connection (TLS) | a Postgres connection (TLS) | Appwrite's server API (an API key with scopes) | the Firebase Admin API (a service account) |
| **The panel's key** (X-Q2) | the project's secret key + database password (not a personal token) | a project-scoped API key | an API key with only the scopes used | a service account with narrow roles |
| **Users (auth)** | `auth.users`, admin API with the secret key | none of its own | Users API | Firebase Auth admin |
| **Who-may-see rules** | Postgres row-level security | Postgres roles / RLS | permissions per collection / document | Security Rules (their own language) |
| **Realtime** | Supabase Realtime | none | Appwrite Realtime | Firestore listeners |
| **A dev copy** | branching (paid plans) or a second project | **branches** (instant, cheap) | a second project | a second project |

- **SQL kind (Supabase, Neon)**: the Studio's existing Postgres driver works on them almost as
  it is, over a remote connection. Most of the Studio comes for free. **Built now** (X3, X4).
- **Document kind (Appwrite, Firebase)**: no SQL. Each needs a new adapter, and some Studio
  features change meaning (Firebase has no schema to draw). **Deferred** (X6-X9).

## Concepts

- **Connection**: a panel user's link to **one project at a provider** (X-Q2): which provider,
  the per-project credentials, a name ("my Neon", "party on Supabase"). Owned by a panel user.
  Its secrets are kept under PD1's envelope scheme (below), never shown again; replacing them
  needs a fresh passkey.
- **Data store**: one database reachable through a connection: a Neon branch + database, a
  Supabase project, (later) an Appwrite database, a Firestore database. Also: an **lfdln
  database** (what 8b does today) and **the project's own Backend tab** (docs/backend-plan.md,
  reached at `LFDLN_API_URL`). **Every place that today says "a database on the server" takes a
  data store instead.**
- **Project ↔ data stores**: any project can be given one or more data stores, on its **Data
  tab**. How it receives the details depends on its kind (next section).

## What each kind of project gets

Never a secret where a visitor's browser can read it: browsers only ever get **public** values
(a Supabase publishable key, a Firebase web config, the project's Backend publishable key), which
are safe by design because the provider's rules decide what they allow. **Keys are decoded when
saved** (review D13): a value offered as public that is a Supabase `sb_secret_…` key or a legacy
JWT whose `role` is `service_role` is refused ("this is a secret key; it would let anyone
bypass your rules"), so it can never reach `data.js`.

| Kind | Example | How it gets the data store | What it can use |
|---|---|---|---|
| **Code** (8b) | the party app (Next.js) | environment variables, per branch (table below), as managed entries on its Environment page | every store |
| **Connected** (TutorStar, Gonsalves) | TutorStar on Neon | it declares in `pammy-panel.json` which variables it reads (`"data": { "DATABASE_URL": "postgres" }`); for one added later that declares `data`, the panel writes them to a drop-in env file and restarts it **only when an owner presses Apply**; adopted ones are shown only (X-Q12) | what its code supports |
| **Files, static** (HTML/JS) | `party` folder with an `index.html` | a generated, public-only `/_pammy/data.js` (X-Q11): `window.lfdln.data.party = { kind: 'supabase', url, publishableKey }` | browser-safe stores: the project's Backend tab, Supabase (later Appwrite, Firebase); never a Postgres connection string |
| **Files, PHP** | a guest book in PHP | a generated `data.php` **outside the web root**, `require`d by the page (`$data['party']['url']`); secrets allowed, it never leaves the server. A folder with `data.php` gets **its own PHP pool** (own user, `open_basedir`), so no other folder's PHP can read it (X-Q13, D13) | every store (Postgres through `pdo_pgsql`, X-Q13) |
| **Installed** (WordPress, N8) | blog | **lfdln MariaDB only**: WordPress needs MySQL / MariaDB; none of the providers is. Its database and login on lfdln-appmaria (PD-Q5); the Data tab shows it, Add offers nothing external | lfdln MariaDB |

Hosts and routes get nothing (N-Q2): a route points at a project, and the project has the data
stores. The Domains page and the Addresses tab don't list data stores.

**Anyone who can deploy code to a project can read its secrets** (D13): the code can print its
environment or `data.php`. The Data tab says so beside Add, and that is why a connection holds
per-project keys, never an account-wide token.

**Variables for Code and Connected projects** (names follow each provider's docs; `VITE_` for
Vite kinds instead of `NEXT_PUBLIC_`):

| Data store | Variables |
|---|---|
| lfdln database | `DATABASE_URL` (as today) |
| the project's own Backend tab | `LFDLN_API_URL` (its `/_api/v1` on its first address, or `https://api.<domain>/v1/<project>`), `LFDLN_PUBLISHABLE_KEY`, `LFDLN_SECRET_KEY` (server kinds) |
| Neon | `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL` |
| Appwrite (deferred) | `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY` (server kinds) |
| Firebase (deferred) | `NEXT_PUBLIC_FIREBASE_*` (web config), `FIREBASE_SERVICE_ACCOUNT` (server kinds) |

Two data stores of the same kind on one project get a suffix: `DATABASE_URL_LEGACY`.

**Data tab and Environment page both setting `DATABASE_URL`** (provisional, confirm before X5):
the Data tab writes its variables as **managed entries** on 8b's Environment page, shown there
read-only with "set by the Data tab"; a hand-set variable with the same name is refused with a
message ("`DATABASE_URL` comes from the Data tab; change it there or remove the store").

### The Data tab, with and without `connections`

The **Data** tab is a common project tab (projects registry, N2): which data stores the project
uses, Add / Remove, and **Open in the Studio**.

| | `connections` off (pammy.org) | `connections` on (lfdln) |
|---|---|---|
| lfdln databases (`studio`'s data store kinds) | shown; Add / Remove as each kind does today (8b's Database page, Installed's own login) | the same |
| the project's own Backend tab (`backends`, lfdln only) | shown when the Backend tab is on | the same |
| external stores (Neon, Supabase) | not offered | Add, through a connection |
| `data.js`, `data.php`, declared Connected variables | not offered | through the data consumers below |

The **data consumers** extension point (how a kind receives a store) is owned by `connections`;
without it the tab only shows what each kind already sets itself. Fillers: `code` (env per
branch), `services` (Connected: declared variables), `files` (static: `data.js`) with `php`
(`data.php`), `apps` (Installed: lfdln MariaDB only).

## The Studio on each

Every store is reached through the **data store adapter** (phase 0's contract, C6-min:
abilities, `introspect`, rows, `apply` where the shape can change). Today's `Driver` gives its
first two implementations (lfdln Postgres, lfdln MariaDB); this plan adds Neon and Supabase now,
Appwrite and Firebase later. The Studio's pages read each store's abilities and hide or explain
the rest.

| Studio feature | lfdln DBs | Neon | Supabase | Appwrite (deferred) | Firebase (deferred) |
|---|---|---|---|---|---|
| Browse, search, add, change, delete records | yes | yes | yes | yes (API queries) | yes (Firestore queries; no full-text search, paging by cursor) |
| Canvas: see the shape | yes | yes | yes (only `public` and your schemas; `auth`, `storage` … hidden) | yes (collections, attributes, relationships) | **inferred** from a sample of documents (X-Q4) |
| Canvas: change the shape (draft → review → Apply) | yes | yes | yes | yes (Apply becomes API calls; attributes are created in the background, Apply waits) | no schema to change (X-Q4) |
| Connections between tables | foreign keys | foreign keys | foreign keys | relationship attributes | reference fields, shown, not enforced |
| Database logins / grants | yes | yes (Neon roles) | read only (Supabase manages its roles) | API keys, read only | n/a |
| Users (sign-in accounts) | n/a (a project's Backend users are on its Backend tab) | n/a | list, find, invite, ban, delete | list, find, block, delete | list, find, disable, delete |
| Who-may-see rules | Backend policies | RLS (X-Q5) | RLS (X-Q5) | permissions (X-Q5, deferred) | Security Rules (X-Q5, deferred) |
| App pages, catalog, data API, form links, comments, record picker | yes | X-Q6 | X-Q6 | X-Q6 (deferred) | X-Q6 (deferred) |
| Make a database / branch | yes | branches (Neon API) | X-Q1 | X-Q1 | X-Q1 |

**Provider data is hostile** (review D12): table, column and field names and values at a
provider may be written by the public, and the Studio shows them on the panel's origin, where
passkey sessions live. Everything from a provider is shown as **plain text, never HTML**, with
caps: sample size, number of fields and columns, nesting depth, size of one record, length of a
name. Over a cap the Studio shows "too big to show here", never a partial render.

## Components on external providers (deferred, X8)

momolig, 2026-10-06: external providers are used **through their own SDKs**. The page components
(docs/backend-plan.md, "Web components (Lit)") take `store="party"` and load an **adapter** for
that store's provider (L-Q3 (a), **firm**): a small module wrapping the official SDK, loaded
only when a page uses that provider, so a Supabase page never downloads Firebase. The design
stays here as the record; it is built when X8 comes back (master-plan.md section 11). Until then
a static folder uses the provider's SDK itself with the values from `data.js` (X5b).

```html
<script src="/_pammy/data.js"></script>                      <!-- party = Supabase, public values -->
<script type="module" src="/_pammy/components.js"></script>
<pammy-login store="party" methods="password google"></pammy-login>
<pammy-list store="party" table="guests" fields="name" live></pammy-list>
```

| Adapter wraps | Supabase: `@supabase/supabase-js` | Appwrite: `appwrite` (web SDK) | Firebase: `firebase` (modular SDK) | Neon |
|---|---|---|---|---|
| login, register, logout, welcome | yes | yes | yes | **no sign-in of its own**: components refuse with a clear message |
| forgot / reset / confirm | yes (links come back to our `reset` / `confirm` pages) | yes (recovery and verification URLs point at our pages) | Firebase sends its own emails; our pages handle its action links (`mode=resetPassword`, `verifyEmail`) | no |
| magic link / email code | yes | yes (magic URL, email OTP) | email link | no |
| Google / GitHub | yes | yes | yes | no |
| mfa | TOTP | TOTP | TOTP (Identity Platform only) | no |
| list / record / count | yes, row-level security decides | yes, permissions decide | Firestore queries, Security Rules decide | no browser access (a Postgres connection string must never reach a page) |
| `live` | Supabase Realtime | Appwrite Realtime | `onSnapshot` | no |
| presence | Supabase Realtime presence | no (hidden) | no (hidden) | no |
| `<pammy-form store=…>` | X-Q6 | X-Q6 | X-Q6 | X-Q6 (through the gate, server side) |

Each adapter declares these abilities; a component asked for something its store can't do shows
nothing broken, just a short notice in the page and a console warning for the programmer.
Versions of the SDKs are pinned per panel release and bundled; nothing is loaded from a CDN.
Components show provider data as text (D12, as L-Q2).

## How the server reaches them

- **A new helper**, `lfdln-remote`, does everything that leaves the machine: its own service
  user, its own unit (256 MB, master-plan.md section 9), no access to the local databases or the
  panel's files. The local Studio helper keeps its localhost-only rule. Like every helper it
  uses only the kernel's helper kit (K-Q3): versioned ops over a socket. The panel talks to both
  through the same data store adapter.
- **Network rules** (review D11: the helper must not become a way into this server):

  | Rule | How |
  |---|---|
  | no local or private addresses | the unit's `IPAddressDeny=` loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), private (10/8, 172.16/12, 192.168/16), ULA (fc00::/7), 10.0.2.0/24 (the containers' host address) and the host's own public addresses; `IPAddressAllow=any` for the rest |
  | ports | 443 (HTTPS APIs), 5432 and 6543 (Postgres direct and pooled) only |
  | hosts | provider hostnames on an **allow list** (`*.neon.tech`, `*.supabase.co`, `*.pooler.supabase.com`, `api.neon.tech`, `api.supabase.com`; later Appwrite and Google endpoints); a connection string or endpoint naming anything else is refused on save |
  | DNS rebinding | a hostname is **resolved once and pinned** for the connection; the address is checked against the deny list before every connect |
  | ops | every op takes a **connection id**, never a raw host, URL or connection string |

- **Credentials** live with that helper, **encrypted at rest with PD1's envelope scheme** (a key
  from a root-only credential via `LoadCredential`), each kind listed in PD1's secrets table with
  its owner and a rotate script. They are sent only to the provider they belong to and never
  returned to the browser.
- Postgres connections always with TLS and certificate checks (`sslmode=verify-full`).
- Every call is logged per connection (what, when, by whom, no data), in the panel's Activity;
  a provider that stops answering publishes `connections.connection.failed` (phase 0 events),
  which the Notifier mails.
- Providers' rate limits are respected; a slow provider never blocks a page of the panel (a
  timeout and "Neon didn't answer, try again").

## Module

All of this is one new module, `connections` (docs/backend-plan.md, "Modules", M-Q1): on for
lfdln, off for pammy.org, needs `studio`, with its own `connections` right.

Extension points (phase 0, docs/module-contracts-plan.md section 3):
- **Data store kinds** are owned by `studio` (the Studio is their main user, and pammy.org has
  `studio` on with `connections` off). `connections` fills it with Neon and Supabase (later
  Appwrite, Firebase); `backends` with "the project's Backend tab"; `studio` itself with the two
  lfdln engines.
- **Data consumers** are owned by `connections` (the Data tab, above): `code`, `services`,
  `files` with `php`, and `apps` fill it. Its contract is written with X5 (C6-rest).
- **Identity providers** and **component adapters** (owned by the kernel): `connections`
  registers one per provider when X8 comes back, so `<pammy-login store="party">` and a form
  sent by a Supabase user work through the same contracts as lfdln visitors.

## Steps

Track X of master-plan.md section 5. Each step its own release (master-plan.md section 3).

| Step | What | Needs | Done when |
|---|---|---|---|
| **X1** | The Studio's pages read a store's abilities from the data store adapter (the adapter and its suite are C6-min) and hide or explain what a store can't do; no behaviour change for lfdln stores | C6-min | verify passes unchanged |
| **X2** 🔒 | `connections` module, connections with per-project keys (X-Q2), secrets at rest (PD1), key decoding on save (D13), the `lfdln-remote` helper with D11's network rules, Activity entries and `connections.*` events | C2-rest, X1, PD1 | a connection to Neon and Supabase can be saved and tested; D11 tests (loopback, 10.0.2.2, rebinding, unlisted host, raw host in an op) are refused |
| **X3** | **Neon**: Postgres adapter over the remote helper; branches; whole Studio; D12 text-only and caps | X1, X2 | the Studio's Postgres suite passes against a Neon branch |
| **X4** | **Supabase**: the same Postgres adapter + users (secret key) + hidden system schemas | X3 | as X3 on a Supabase project, plus users |
| **X5** | The **Data** tab on every project and Code projects: per-branch mapping, managed entries on the Environment page, Neon branch for `dev`; the data consumer contract (C6-rest) | N2, X4 | a Next.js project deploys against Neon (`main` and `dev` branches) and Supabase |
| **X5b** | Connected projects (declared variables, Apply), Files projects (`/_pammy/data.js`, `data.php` with a **PHP pool per folder**, `pdo_pgsql`) | N3, X5 | a static folder reads its `/_pammy/data.js` and signs in with supabase-js; a PHP folder reads a Neon table, and another folder's PHP can't read its `data.php` |
| X6 | **Appwrite** adapter: records, shape (Apply as API calls), relationships, users | **deferred** (section 11) | records and shape changes round-trip |
| X7 | **Firebase** adapter: records, inferred shape, users | **deferred** | records round-trip; the canvas shows fields seen |
| X8 | Component adapters: Supabase, then Appwrite, then Firebase, on the components docs/backend-plan.md builds | **deferred** (and B3 onwards) | `<pammy-login store=…>` and `<pammy-list store=… live>` work on a static folder for each |
| X9 | The rest of X-Q5 / X-Q6 (Appwrite and Firebase rules and panel features) | **deferred** | |

Deferred steps are not dropped; each comes back when an app needs it, by asking momolig.

## Questions for momolig

Answered 2026-10-06: X-Q0 by momolig's choice (firm); X-Q1..X-Q13 by taking the suggestions "for
now" (provisional, confirmed before the step named, master-plan.md section 2). Kept here as the
record, each with its examples. Where the review changed a suggestion, the changed one is the
answer.

### X-Q0. One word for "everything the panel manages" (FIRM 2026-10-06: "Projects")

momolig chose **Projects** for everything the panel runs or serves, with kinds Files, Code (8b),
Installed, Connected (docs/projects-domains-plan.md, N-Q1); hosts are its addresses (N-Q2). The
options as they were asked: the menu had Hosts, Services, Site folders, Projects, Installed
software, and **Projects** was already the 8b module's name.
**(a) Rename 8b's module to "Code projects"**, and "projects" becomes the general word:
*"Add Neon to a project"* works for a folder, a service or the party app.
**(b) Keep 8b's name, call the general thing "sites"**: *"this site uses Supabase"*.
**(c) Keep 8b's name, no general word in the UI**: every page simply has a Data tab.
*Chosen: (a), with 8b's module becoming the Code kind.*

### X-Q1. Connect existing provider projects only, or also create them (provisional, confirm before X2)

**(a) Connect only:** you make the Supabase project on supabase.com, then in the panel:
*Connections → Add → Supabase → paste the project's keys → name it "party"*.
**(b) Also create:** *a project's Data tab → Add → "New Neon branch" / "New Supabase project in
region Frankfurt"*; the panel calls their API and waits until it's ready. Mistakes cost money
on paid plans; free plans have small project limits (Supabase: 2 active projects).
*Answer: (a) for all, plus creating Neon **branches** (free, instant, and what `dev` needs).
Creating whole provider projects later if it's missed.*

### X-Q2. How a connection is authorised (provisional, confirm before X2; changed by the review)

**(a) Paste keys**, **(b) "Connect with Supabase / Neon" buttons (OAuth)**: nicer, but each
provider has to approve the panel as an integration, and Appwrite / Firebase don't offer it the
same way.
*Answer: (a) with **per-project keys*** (review D13): a Supabase connection is one project's
secret key and database password, never a personal access token (that reaches every project in
the account and their secret keys); Neon a project-scoped API key; Appwrite an API key with only
the scopes used; Firebase a service account with narrow roles. One connection = one provider
project. Kept under PD1 (secrets at rest).

### X-Q3. Firebase: Firestore only, or the Realtime Database too (deferred with X7)

Firebase has two databases: **Firestore** (collections/documents) and the older **Realtime
Database** (one big JSON tree: `/rooms/42/messages/…`). The Studio would show the JSON tree as
a folder-like browser with no tables at all. *Answer when X7 comes back: Firestore only.*

### X-Q4. Firestore has no schema: what does the canvas show (deferred with X7)

Two documents in `guests` can have different fields:
```
guests/a1  { name: "Ana", plusOnes: 2, createdAt: … }
guests/b7  { name: "Bo", email: "bo@…", vegetarian: true }
```
**(a) Inferred only:** the Studio samples (say) 200 documents per collection and draws
`guests: name (text, 2/2), plusOnes (number, 1/2), email (text, 1/2), vegetarian (yes/no,
1/2), createdAt (date, 1/2)`; record pages show these fields plus "other fields".
**(b) Inferred, plus a declared shape you can keep in the panel:** "a guest has name
(required), email, plusOnes (number)". The Studio's record pages then check what they write,
but other programs can still write anything.
*Answer when X7 comes back: (b), the declared shape optional and starting from (a); sampling
within D12's caps.*

### X-Q5. The providers' own access rules in the Studio (Postgres part provisional, confirm before X3; Appwrite / Firebase deferred with X9)

Same rule ("people see published posts and their own drafts") in each:

- **Supabase / Neon (Postgres RLS):**
  ```sql
  create policy "read" on posts for select using (published or author_id = auth.uid());
  ```
  Our Backends policy language compiles to exactly this, so the **same policy editor** can
  write it.
- **Appwrite:** permission strings per document / collection, e.g.
  `read("any")` on published documents, `read("user:7f3c")` on a draft.
- **Firebase Security Rules:**
  ```
  match /posts/{id} { allow read: if resource.data.published || resource.data.authorId == request.auth.uid; }
  ```

**(a) Editable for all.** **(b) Postgres editable, the others shown read-only first.**
*Answer: (b).* RLS reuses our editor; the other two are different languages each, and come back
with X9.

### X-Q6. Do the panel's own features work on external data stores (provisional, confirm before X3)

Features built on top of the Studio: app pages, the data API on the gate, form links (a form
fills a table), comments into a table, the record picker. Example: the RSVP form saves into
`guests` on **Neon**: the gate writes the row through `lfdln-remote`.

**(a) All data stores. (b) Postgres-kind stores (Neon, Supabase) first;** Appwrite / Firebase
show "not for this kind of data yet". **(c) None.**
*Answer: (b).* The Postgres adapter is shared, so it's mostly wiring; the document kinds are
deferred with X9.

### X-Q7. The `dev` branch's data on each provider (provisional, confirm before X3)

8b gives `dev` its own database. Per provider:
- **Neon:** a Neon branch `dev` made from `main` (a copy of the data at that moment, instant).
  "Reset dev from main" in the panel.
- **Supabase:** branching needs a paid plan. Otherwise: a second Supabase project (its own
  connection) for `dev`.
- **Appwrite / Firebase** (deferred): a second project for `dev`.
- In every case, **"use the live data for dev"** is possible, with a fresh passkey and a
  warning, as P8b-5 says.
*Answer: as listed.*

### X-Q8. Can a project's Backend tab use a Neon / Supabase database (deferred; changed by the review)

Backends B-Q5 option (c). Example: a project's Backend tab with its `main` database on Neon; our
service enforces policies and realtime on it, over `lfdln-remote`. Every query then crosses the
internet (tens of milliseconds more each), and a policy write (lock, write, check, D2) holds its
locks across those round trips.
*Answer: **only for read-mostly backends, never for write-heavy ones**, Postgres-kind stores
only, and not before it is asked for again (deferred).* Appwrite and Firebase are backends
themselves; putting ours in front of them makes little sense.

### X-Q9. Which provider first (provisional, confirm before X3)

**Neon** is plain Postgres plus branches: the shortest path to "a project on an external
database", and it gives `dev` its best story. Then **Supabase** (same driver + users); Appwrite
and Firebase are deferred. *Answer: this order.*

### X-Q10. Who sees a connection (provisional, confirm before X2; reworded by the review)

**(a) Its owner, and the owners of the projects it's used in.** **(b) Every panel user with the
`connections` right.**
*Answer: (a): the connection's owner manages it; owners of a project it's used in see its name
and can use it there, never its keys in the panel. **But anyone who can deploy code to that
project can read the keys through the code they deploy** (D13), so using a connection in a
project shares its keys with that project's owners; the page says so before Add.*

### X-Q11. How a static Files project learns its public settings (provisional, confirm before X5)

**(a) Generated `/_pammy/data.js`**, public values only (decoded and checked on save, D13),
served by the gate per host:
```html
<script src="/_pammy/data.js"></script>
<script type="module">
  const { url, publishableKey } = window.lfdln.data.party;
  const supabase = createClient(url, publishableKey);
</script>
```
Changing the store in the panel changes the page at once; nothing written into the folder.
**(b) Written into a file in the folder** (`lfdln-data.json`): visible in File Explorer, but
it goes stale if someone edits it, and it ends up in backups and copies.
*Answer: (a).*

### X-Q12. Connected projects: does the panel change their settings (provisional, confirm before X5)

TutorStar's database settings come from its own install script today.
**(a) Record and show only:** the Data tab says "TutorStar uses lfdln-appdb / tutorstar", with
Open in the Studio; changing it stays the project's own deploy job.
**(b) The panel writes the variables** the project declares, into a drop-in env file, and
restarts it when an owner presses Apply.
*Answer: (a) for the adopted ones (TutorStar, Gonsalves; moves go through the data-move plan,
and settings carry over exactly), (b) for Connected projects added later that declare `data`.*

### X-Q13. PHP folders and Postgres (provisional, confirm before X5; changed by the review)

Today's host php-fpm has no PDO drivers, so a PHP page can't talk to Neon or Supabase's
Postgres. **(a)** Add `pdo_pgsql` (and `pdo_mysql`) to the host php-fpm (root, one package
install). **(b)** Only through HTTP APIs (Supabase's REST, the project's Backend tab), no
direct Postgres from PHP.
*Answer: (a) **with a PHP pool per folder** for every folder that has a `data.php`* (review
D13): its own pool user and `open_basedir`, so its secrets are readable by its own PHP only,
never by another folder's.
