# Module contracts, events, and plugins

PROPOSED 2026-10-06; revised the same day for master-plan version 2 (Track D2-D4). **K0 and C1
live** (K0 merged 8b78a5a, C1 merged 853e155; "C1 as built" below); the rest not built.

**Status of the questions** (docs/master-plan.md section 2):
- **Firm**: P-Q1, K-Q1..K-Q4.
- **Firm**: C-Q1 (`defineModule` per package), confirmed by momolig 2026-10-06; C1-Q1..Q5 taken as suggested.
- **Provisional** (momolig took the suggestions "for now"): C-Q2 (helper op versions, confirm before C2-rest);
  E-Q1..E-Q6, as changed by the review, **confirm before C4**.

**Phase 0** (master-plan section 5, "Track 0") of docs/backend-plan.md and
docs/external-backends-plan.md. Only the parts M1 needs come before B1 and X1 (K0, C1, K-a, K-b,
C2-min, C6-min); the rest follows when its first user starts. On order and dependencies,
master-plan wins; on how a step works, this plan does.

momolig, 2026-10-06: *"Do we already have contracts for the modules? How are they supposed to
work together?"*, then *"we also need to include a plan for events. Do we have a plugin
system?"*

## What there is today (checked 2026-10-06)

### Contracts: they exist, spread over several places

| What | Where | Checked by |
|---|---|---|
| The list of modules | `MODULES`, `packages/core/src/profile.ts` (23) | types |
| Which module needs which on | `NEEDS`, same file | `checkModules` refuses a bad profile |
| What a module needs from the site | `FACTS`, same file (`studio: ['services.sockets.pammydb']`) | `checkFacts` |
| Who may import whom | `DEPENDS_ON`, `test/boundaries.test.ts`, and each `package.json` | the boundary test, on every import |
| A package's three parts | `src/` (server), `web/` (panel pages), `widgets/` (Lit `<pammy-*>`), each importing only its own kind | the boundary test |
| How a module plugs in | exported functions with typed dependencies: `formsRoutes(app, ctx)`, `registerDataApi(app, deps: DataApiDeps)` | TypeScript |
| Wiring | each site's composition roots (`sites/<site>/src/app.ts`, `server.ts`, `cli.ts`, `gate/*`), the only code allowed to import everything, behind `isOn(site, 'forms')` | routes snapshot, verify |
| Tables | each package's own `migrations/` | schema snapshot |
| Helpers | JSON ops over Unix sockets (`callPammyDb`, `callServices({op:'ports'})`, `callProjects`, `callMail`, the gate's admin socket) | each side's tests |
| Apps and services describing themselves | `pammy-panel.json` (roles, catalog resources) and `known.ts` (`accountDeleted`) | the services helper |

The ways modules work together, each wired by the site:

| Pattern | Example |
|---|---|
| A hook handed in | forms' `FormHooks.responseKept`, which the gate's `app.ts` fills with form-links' save |
| The context grown per module | `panelContext` + `studioParams`, `filesParts`, `withFolderPlaces` |
| A registry of kinds | Hosts' route kinds: folder, redirect, `serviceRouteKind`, `projectRouteKind` |
| A source offering items | the catalog's sources (catalog plan C2, C3) |
| The panel pushes, the gate serves | the catalog push; form links |

**What's missing.** There is no single place that says what a module is: adding one means
editing `MODULES`, `NEEDS`, `FACTS`, `DEPENDS_ON`, `package.json`, each site's four
composition roots, the installer, the units and verify, by hand. Helpers' ops have shared
types but no stated promise across releases. And there are no events.

### Events: a few, each built by hand

| What happens | How others hear of it | Kind |
|---|---|---|
| A visitor account is deleted | trigger → `gate.deleted_accounts` → the panel polls every minute → signed POST to the service (`X-Lfdln-Signature`, retries 1 min, 5 min, 30 min, then 6-hourly) (accounts plan 4b) | **durable outbox + webhook**: the model for this plan |
| A tagged table's row changes through the gate | `noteTouch` → `gate.record_touches` → the panel takes 1000 at a time | durable outbox, pulled |
| A form response is kept | `responseKept(responseId)`, a callback | in-process hook |
| Files sync, a thumbnail is made, media changes | `media.onChange`, `onHashed`, `thumbs.onMade`, `publisher.kick()`, an `onResponse` hook on `/api/media` | in-process callbacks |
| Something happened, for people to read | `logActivity` (panel, 42 files), `logEvent` (gate) | a log, nobody subscribes |
| A response arrives, a site goes down | email notices (Notifier), monitoring mail | a fixed action |

Each one has its own table, its own retry rules and its own wiring. A new module that wants
to know "a row was written" (Backends realtime) or "a release was deployed" has nowhere to
listen.

### Plugins: none

- Every module is **first-party code built into the release**. There is no loading of code
  at run time and no third-party code in the panel. Fastify's own plugin mechanism
  (`app.register`) is not used for modules.
- Apps and services **extend the panel from outside**, through `pammy-panel.json` (their roles,
  their catalog resources) and signed calls (the deletion hook, catalog push). That is an
  integration system in all but name.

## What this plan does

Five parts, each its own steps:

1. **One module contract**: each package says what it is in one place, and the lists above
   come from it.
2. **Events**: one event shape, one durable outbox with delivery and retries, webhooks to
   services and projects. The hand-built ones move onto it. (The in-process bus, C3, is
   deferred: master-plan section 11.)
3. **Extension points and plugins**: the named places a module can plug into; modules are the
   plugins (P-Q1, firm).
4. **The kernel**: `@panel/kernel`, carved out of `core`, hosting the modules (K-Q1..K-Q4,
   firm).
5. **Module rules** (section 5) that every step is checked against, with the boundary test
   checking SQL table ownership.

Plus **18 contracts** (section 3): the five the Backends and external-backends plans need and
13 more from docs/architecture.md section 8. Each is written as an interface in the step that
first needs it (C2-min, C6-min, C2-rest, C4, or "when its first user starts", C6-rest), not all
up front (master-plan section 11).

## 1. The module contract

Each package exports one definition from `src/module.ts`:

```ts
// packages/forms/src/module.ts
export default defineModule({
  name: 'forms',
  kernel: '^1',                                       // the kernel version it is written for (section 4)
  needs: ['areas', 'mail', 'api-keys'],              // was NEEDS
  facts: ['services.gate', 'services.sockets.gateAdmin'],   // was FACTS
  migrations: 'migrations',
  rights: ['forms'],                                  // the parts of the panel it adds rights for
  // worksWith: { mail: 'email notices', … }         // optional: lights up when on (docs/modular-use-plan.md)
  // sockets: { formKinds, inboxSections, … }         // its own extension points, for its plugins (Comments)
  panel:   (app, ctx, use) => formsRoutes(app, ctx),  // what app.ts called by hand
  gate:    (app, ctx, use) => formsGateRoutes(app, ctx, { events: use.events }),   // publishes forms.response.kept
  cli:     (cmd, ctx) => …,
  housekeeping: [{ every: '1h', run: (ctx) => purgeTrash(ctx) }],
  widgets: ['forms'],                                 // <pammy-form>, built into /_pammy/forms.js
  events:  { publishes: ['forms.response.kept', 'forms.response.approved'], subscribes: [] },
  provides: {},                                       // extension points it fills (section 3)
  uses:     { routeKinds: false, catalogSources: false },
});
```

- **Sites compose from definitions**: `sites/lfdln/src/app.ts` becomes "for each module that is
  on, call its `panel(...)`", plus what is truly the site's (its profile, its helpers' sockets).
  The site can still pass special things in. It does today, and that stays allowed.
- **`MODULES`, `NEEDS`, `FACTS` are made from the definitions**, and `DEPENDS_ON` is checked
  against them, so the four lists can't disagree.
- **A check per module**: `test/modules.test.ts` builds a site with only that module and what
  it needs, and boots it. It catches a module that secretly leans on one it didn't declare.
- **Helpers' ops become declared contracts**: each helper lists its ops with request and reply
  types and a version (`pammydb@3: list-rows, insert-row …`). The panel says which version it
  needs, so a panel newer than its helper refuses at start-up with a clear message instead of
  failing on the first click. The gate's admin ops become a registry the same way (gate G1).
  Contract 18 in section 3.

The net, as in the packaging plan: same route list, same schema, every suite green, the same
verify count.

## 2. Events

### The shape

```json
{
  "id": "01J9Z3K8V5Q0M6X2…",
  "type": "forms.response.kept",
  "version": 1,
  "at": "2026-10-06T14:03:11.402Z",
  "site": "lfdln",
  "subject": { "kind": "form-response", "id": "812" },
  "place":   { "host": "party", "folder": "party", "project": { "kind": "code", "id": "party" } },
  "actor":   { "kind": "person", "provider": "lfdln-visitor", "id": "0192f3c4-…" },
  "data":    { "form": "rsvp", "status": "waiting" }
}
```

- **`id`**: time-ordered (UUIDv7), so receivers can skip one they've already had.
- **`type`**: `<module>.<thing>.<what happened>`, past tense. `version` goes up when `data`
  changes shape; receivers say which version they understand.
- **`place`**: where it happened, for rights: someone kept to the `party` places only ever
  sees events from there (permissions plan R5). It also carries **`project: {kind, id}`** when
  the thing belongs to a project, so a project's Events tab and "a service only gets its own
  events" have something to filter on (contract 14 in section 3).
- **`actor`**: who did it: `panel-user`; `person`, with the identity contract's `provider`
  (`lfdln-visitor`, `project:<id>` (a project's Backend users), `store:<name>`, section 3) and an
  **opaque id** (D20); `key`; `service`; `system`.
- **`data`**: small. An event says what happened and to what, not the whole record (no visitor's
  answers, no passwords, ever; ids only, no personal data: master-plan PD2). A receiver that
  needs more asks for it with its own rights. Realtime's whole rows don't go in the outbox (see
  "Row events" below).

Every type is written down once, in the kernel, as a TypeScript type plus a JSON Schema (for
webhooks), with its **retention** and its **"who may receive" rule** (below). A module can only
publish types it declares (`events.publishes`), and only with its own prefix (rule 7); the test
checks both.

### Three ways to receive

| Way | For | Guarantee |
|---|---|---|
| **In-process bus** (C3, **deferred**) | modules in the same process: files → thumbs → media publisher | immediate; lost if the process stops at that moment. Deferred because it moves working callbacks with no gain to users (master-plan section 11); the callbacks stay |
| **Durable outbox** | anything that must not be lost: account deleted, response kept, row changed, release deployed | **at least once** (E-Q1), in order per subject |
| **Webhooks** | services and projects (outside the panel) | at least once, signed, retried; receivers dedupe by `id` (the webhook kit does it, tested) |

**The outbox.** A table `events.outbox` in the site's own Postgres (lfdln :5435, pammy.org
:5434). The panel and the gate both use that database, so both can write to it.
- **Events about the panel's own database** (`people.account.deleted`, `forms.response.*`,
  `comments.comment.*`, `hosts.route.changed` …) are written **in the same transaction as the
  change**, as the deletion trigger does today. If the change rolls back, so does the event.
- **Row events** (`studio.row.*`, `backends.row.*`) **cannot be** (review D4): the rows live in
  the app databases (lfdln-appdb :5436, lfdln-appmaria :3308), other servers than the outbox, and
  MariaDB can't join a Postgres transaction. They are written **after the row's commit and
  retried** until the outbox has them: best effort, as review D4 says (how they are kept until
  written, a retry list in the writer or a relay table in each app database, is chosen in C5).
  Row events are for catalog freshness and realtime, which both re-read the row. Whole rows for realtime go in a separate
  short-lived table (minutes) owned by `backends`, never in the outbox.
- **One `NOTIFY events` per transaction, without payload** (D19), after the commit, wakes the
  dispatcher. It also looks every 30 seconds, in case a wake-up was missed.
- **The dispatcher** runs in the panel's server (E-Q2), with **bounded concurrency and per-host
  timeouts**, so a hung service can't stall the panel. It hands each event to every subscriber
  and keeps **delivery rows per subscriber** (who, tries, last answer, next try). A subscriber
  that fails is retried on its own, without holding up the others.
- **Order (D5).** An id taken early can commit after a later one, so a plain "id > cursor"
  reader would skip it. Readers by cursor read only **below `pg_snapshot_xmin`**
  (`pg_snapshot_xmin(pg_current_snapshot())`, from an `xid8` column written with each event);
  the dispatcher uses its delivery rows instead. **Per-subject order** comes from an advisory
  lock per subject taken by the writer.
- **A subscriber in another process** (Backends realtime, in `lfdln-backend`) keeps its own
  cursor under the same snapshot rule and reads the outbox itself, woken by the same `NOTIFY`,
  through the kernel's events code. The dispatcher only delivers to subscribers in the panel and
  to webhooks.
- **Retries**: 1 min, 5 min, 30 min, then every 6 hours, as the deletion hook does. After 3
  days the delivery is marked **failed** and shown in the panel with **Try again**.
- **Partitioned by day, kept by type** (E-Q3 as changed by the review, D19): row events hours to
  days, account and response events 30 days (like `deleted_accounts`). Old partitions are
  dropped, not deleted row by row. A delivery not done when its event goes is shown as failed.

**Webhooks.** One source for the URL, one for the types (**provisional**, see below):

```json
// the connected file (/etc/lfdln-panel/connected/<id>.json, root-owned; projects-domains N3)
{ "events": { "url": "/_lfdln/events" } }
// the project's or service's pammy-panel.json
{ "events": { "types": ["people.account.deleted", "forms.response.kept"] } }
```

- **Where it is declared.** master-plan C5 asks for "one webhook source" and doesn't say which.
  Proposed, **provisional until C5**: **the connected file declares the URL** (root-owned, so the
  address a signed request goes to is as trusted as the unit it belongs to), **`pammy-panel.json`
  declares the types** (the app's own file, read through the manifest sections reader, contract
  13). A URL in `pammy-panel.json` is ignored with a warning. For Code projects (no connected
  file) the project kind gives the URL (contract 6).
- **Path rule (D10)**: the path must match `^/[A-Za-z0-9/_-]+$`; the URL is built with
  `new URL(path, 'http://127.0.0.1:<port>')` and its host and port are checked after, so
  `http://127.0.0.1:3041@evil.host/` can't send anywhere else.
- Sent straight to `127.0.0.1:<port>` (never over the internet), signed exactly as today:
  HMAC-SHA256 over `<ms>.<body>`, `X-Lfdln-Timestamp`, `X-Lfdln-Signature: v1=<hex>`, the same
  key file per service (`/etc/lfdln-panel/hooks/<id>.key`; in the secrets table, master-plan PD1).
- **"Who may receive", written per event type** (D10): each type declares who may get it, and
  the dispatcher checks it before every delivery. Defaults: a service or project gets an event
  only when `place.project` is itself, or the subject is its own (a form attached to it, an
  account that used its route). `studio.row.*` goes to **no webhook** (panel subscribers and
  realtime only). Never another service's events.
- Exam prep's `/_lfdln/account-deleted` keeps working unchanged until it moves to
  `/_lfdln/events` in N7 (E-Q4).

### The first event types

| Type | When | Who listens first |
|---|---|---|
| `people.account.deleted` | a visitor account goes, any way | services (replaces `deleted_accounts`) |
| `forms.response.kept` / `.approved` / `.trashed` | a response arrives / is approved / is trashed | form-links (replaces `responseKept`), Notifier, Backends (F-Q4) |
| `form-links.row.saved` / `.failed` | an answer saved into a table, or not | Activity |
| `studio.row.inserted` / `.updated` / `.deleted` | a row written by the panel, the data API, form links or comments (after commit, retried) | catalog (replaces `record_touches`), Backends realtime; no webhooks |
| `comments.comment.posted` / `.approved` | a comment | Notifier, Backends |
| `files.changed`, `thumbs.made`, `media.published` | the file sync and pictures | in-process: thumbs, media publisher (with C3, **deferred**; the callbacks stay until then) |
| `hosts.route.changed` | a route added, changed, removed | monitoring, the Data tab |
| `monitoring.check.down` / `.up` (was planned as `services.service.*`; rule 7) | monitoring's checks | Notifier (monitoring's mail) |
| `projects.release.deployed` / `.failed` | a build goes live or fails | Activity, webhooks to the project |
| `backends.row.changed` (after commit, retried), `backends.user.created` / `.deleted` | Backends (B2, B3) | realtime, webhooks to the project itself (B8's hooks) |
| `connections.connection.failed` | an external provider stops answering | Notifier |

### What changes for things that exist

- `gate.deleted_accounts` and its poller → `people.account.deleted` on the outbox. Same
  trigger timing, same retries, same signature; exam prep sees no difference.
- `gate.record_touches` → `studio.row.*`, which the catalog subscribes to.
- `FormHooks.responseKept` → `forms.response.kept`, which form-links subscribes to. **The form
  saves' own queue stays**: saving a row is a job with its own state (waiting, saved,
  problem…), not an event. The event starts the job.
- The file-sync callbacks stay as they are (C3 deferred).
- **Activity is not replaced.** It stays the readable log for people. An event can *also*
  write an Activity line, through a subscriber, so modules stop calling `logActivity` for the
  things that are events.

### In the panel

**Settings > Events** (admins): recent events filtered by type, place and subject; each one's
deliveries (who got it, when, tries, last answer); **Try again** on failed ones. Per service
and project: which types it asked for, and its failed deliveries.

### Events and Backends realtime

Backends realtime (backend-plan.md) subscribes to `studio.row.*` and `backends.row.*` for the
databases its backends attach. That is how a row saved by a **form link** or a **comment**
reaches a live page, not only rows written through the backend's own API. Row events are
written **after the row's commit, and retried** (D4, above), so realtime reads the outbox below
the snapshot (D5) and fetches the row itself (from its short-lived table, or the database) under
the subscriber's policy. The `NOTIFY` wake-up keeps it under a second. It also means realtime needs no change when, later, change
data capture starts publishing `studio.row.*` for writes from outside (PHP, WordPress).

## 3. Extension points and plugins

### Extension points

The named places one module can plug into another. The kernel gives the mechanism (a typed
registry); the module that **owns** a point declares it, and others fill it in `provides` and
read it through `use`. A point whose owner is off simply has no readers. Two exist already; the
plans add seven.

| Extension point | Owned by | A module adds… | Exists? | Examples |
|---|---|---|---|---|
| **Route kinds** | `hosts` | a kind of target a route can point at | yes | today folder, redirect, service, project; after N2 **`project` and `redirect`**, `project` resolving through project kinds (projects-domains N-Q2); the Studio's `database-app` needs a home there |
| **Form kinds, inbox sections, widget parts, builder panels, approval rules, read queries** | `forms` | a kind of form and what goes with it | new (U3, docs/modular-use-plan.md) | `comments` (comment areas) |
| **Project kinds** | projects registry | a kind of project (contract 6) | new (C2-min stub, N2) | Files, Code (`projects`), Installed (`apps`), Connected (`services`) |
| **Project tabs** | projects registry | a tab on every project (contract 7) | new (C2-rest) | Data (`connections`), Access (`areas`), Events (kernel), Health (`monitoring`), Backups |
| **Catalog sources** | `catalog` | a source of items to tag | yes | site files, Studio tables, services |
| **Data store kinds** | `studio` | a kind of database or backend the Studio and others can use | new (C6-min) | lfdln Postgres, lfdln MariaDB (`studio`), lfdln Backend (`backends`), Neon, Supabase, Appwrite, Firebase (`connections`) |
| **Data consumers** | `connections` | a project that can be given a data store, and how it receives it | new (X5) | Code (env), Connected (declared env), Files (`data.js` / `data.php`); Installed restricted |
| **Identity providers** | the kernel | who vouches for a signed-in person | new (C6-min) | lfdln visitors (`people`), each project's Backend users (`backends`), each external store (`connections`) |
| **Event types and subscribers** | the kernel | events it publishes, handlers it runs | new (C4) | section 2 |
| **Component adapters** (browser) | the kernel | a provider for the `<pammy-*>` components | new (L-Q3) | lfdln visitors, lfdln Backend, Supabase, Appwrite, Firebase |

Also made into registries, since sites already pass them by hand: **refusals** (errors →
messages), **housekeeping jobs**, **Help topics**, **rights**, **gate ops and helper ops**
(contract 18), **pages and assets** (gate G2), **manifest sections** (contract 13), **table
writers** (contract 15).

### The 18 contracts

Written in the kernel as interfaces, each with a test that every implementation must pass (the
same suite, run against each one, with T2's `runContractSuite(impl, engines)` where engines
matter). **Each is written when the step in the "Written" column starts, not before** (master-plan
section 5 and section 11): C6-min writes only the data store adapter and identity; C2-min the
project-kind stub, the route API, secrets delivery and the gate op registry; C2-rest and C4 / C5
what they list; the rest when their first user starts (C6-rest).

| # | Contract | Interface, short | Owner | Written | First user |
|---|---|---|---|---|---|
| 1 | **Data store adapter** | `abilities`, `introspect`, `listRows`, `getRow`, `insertRow`, `updateRow`, `deleteRow`, `apply` (for those that can change shape); grows out of today's `Driver` | `studio` | **C6-min** | B1, X1; both lfdln engines pass |
| 2 | **Events** | `publish(tx, event)` (panel database), `publishAfterCommit(event)` (row events, retried), `subscribe(type, handler)`, per-type `retention` and `mayReceive` | kernel | **C4** (webhooks C5) | form-links, deletion hook |
| 3 | **Data consumer** | `receive(project, store, values)`; what it can take (`env`, `public-js`, `server-php`) | `connections` | C6-rest, with **X5** | X5 |
| 4 | **Component adapter** (browser) | `session()`, `signIn(method, …)`, `signOut()`, `list(table, query)`, `watch(table, filter)`, `abilities` | kernel | C6-rest, with **B3 / X8** | B3 |
| 5 | **Identity** | see below | kernel | **C6-min** | B1, forms, comments |
| 6 | **Project kind** | `{ kind, list(), get(id), owners(id), tabs, routeTarget(id), health(id), backups(id), manifest(id), delete(id) }` + `projects.project.deleted` | projects registry | **C2-min** as a stub (`kind`, `list`, `get`, `routeTarget`); the rest in C2-rest | B1 (which project answers on `/_api/`), N2 |
| 7 | **Project tab** | `{ id, title, right, appliesTo(kind), page }`: a module adds a tab to every project, scoped by rights | projects registry | **C2-rest** | N2 |
| 8 | **Address / route API** | `routesFor(projectRef)`, `addRoute`, `removeRoute`, `makeHost(domain, name)` (with each domain's abilities), `addressOf(route)`, `folderPlaces`; **reserved paths `/_api/` and `/_pammy/`** on every host, which no route, folder or project may take | `hosts` | **C2-min** | B1 (`/_api/` on project addresses), N2, N6 |
| 9 | **Health + named gauges** (O1) | `health: { id, target, expect, every }` per kind; `gauges: { name, unit, read(), alertAt }` (database connections per engine, outbox lag, failed deliveries, WebSockets, scrypt queue, mail budget, disk); replaces the site's `*Like` types | `monitoring` | **C2-rest** | O1 |
| 10 | **Backup** | `{ source, where, retention, lastGood(), restore? }` per kind and per store | kernel interface; Settings > Backups reads it | **C2-rest** | R4 |
| 11 | **Access per project** | project → its areas and / or its identity provider's admin; uses identity's `rolesIn(area)` | `areas` | C6-rest, with **N2** (Access tab) | N2, B3 |
| 12 | **Mail sender** (MS1) | `send({ kind, to, domain })`; sender per domain (`mail.tutorlumi.com`, else `mail.lesfleursdelanuit.com`); budgets per domain / project / site, part kept for resets and confirmations | `mail` | **C2-rest** | MS1, B3 |
| 13 | **Manifest sections** (`pammy-panel.json`) | one reader; modules register sections (`roles`, `catalog`, `events.types`, `data`); each project kind says where its file is | kernel reader, sections by modules | **C2-rest** (connected files' part with N3) | N3, C5 |
| 14 | **Event place** | `place: { host?, folder?, project?: {kind, id} }`; the "who may receive" rule per type (section 2) | kernel | **C4** | C5's webhooks, Events tab |
| 15 | **Table writer** | `writerFor(store, table)` → `{ insert, update }` (Studio helper, a project's Backend, `lfdln-remote`); breaks the form-links ↔ backends cycle | `studio` point, filled by `backends`, `connections` | C6-rest, with **B6** | B6 |
| 16 | **Gate pushes** | `push(kind, payload)` from the panel, `serve(kind)` in the gate, for catalog, form links, `data.js`, a Backend's JWKS; the gate reads only its own tables | kernel | C6-rest, when its first **new** push starts (B3's JWKS or X5b's `data.js`); catalog and form links move then | B3 / X5b |
| 17 | **Secrets delivery** | `deliver(project, secret, how)` over env files, connected drop-ins, `data.php` and the S1 proof key; every secret in master-plan PD1's **secrets table** (secret, owner, how to rotate, overlap), stored with PD1's envelope | kernel | **C2-min** (delivery); the envelope and table with **PD1** | S1's proof key, B1's keys |
| 18 | **Op registries, with versions** | gate ops: `{ op, scoped, changes, handler }` per module (gate G1); helper ops: `{ helper, version, ops: {request, reply} }`, the panel naming the version it needs (C-Q2) | kernel | gate ops **C2-min**; helper op versions **C2-rest** | S2's gate socket, the Studio |

**Identity (contract 5)**, per review S5 and D20:

```ts
interface Identity {
  provider: 'lfdln-visitor' | `project:${string}` | `store:${string}`;
  id: string;               // stable and opaque (a UUID), never a username, never reused
  email?: string;
  rolesIn(area: string): string[];   // lfdln visitors' roles are per area (roles plan)
}
```

- An **owner column belongs to one provider** (or stores provider and id together), so visitor
  `…42` and a project user `…42` can never be the same person.
- Registries **refuse duplicate** providers; a module that is off registers nothing (tested).
- Deleted accounts' ids are never given again; names that apps show are not identities (S5).
- Forms, comments and components use it to say "sent by…" the same way whoever signed them in.

### Plugins

What a plugin could mean here, with examples:

- **(a) First-party modules are the plugins.** With `defineModule`, a module is a self-contained
  package that plugs into named extension points, and a site picks which ones it runs. Adding
  "Neon" is a package that `provides: { dataStoreKinds: [neon] }`. It is built into the
  release, reviewed and tested like the rest. **No code is loaded at run time.**
- **(b) Outside apps extend through declared integration**, as services already do: a
  `pammy-panel.json` declaring roles, catalog resources, events wanted, a data store needed; a
  webhook; their own Lit components on their own pages. They never run inside the panel.
- **(c) Third-party code loaded into the panel**, like WordPress plugins: an "Install plugin"
  button that runs someone else's code next to the passkeys, the gate's sessions and the
  helpers' sockets. One bad plugin could read every database the Studio can reach.

**Decided: (a)** (P-Q1); (b) stays as services already work; (c) is not planned.

## 4. The kernel

**Decided 2026-10-06** (K-Q1..K-Q4 below). Once modules are plugins, something hosts them: the
**kernel**, `@panel/kernel`, carved out of today's `core`.

**The rule:** the kernel never imports a module and never names one. Modules declare the kernel
version they are written for (`kernel: '^1'` in `defineModule`); the kernel's interface changes
rarely, and when it does its major version goes up and every module is checked against it.

### What the kernel does

| Kernel | Today in |
|---|---|
| **Module host**: reads the profile's module list, checks `needs` and `facts`, starts modules in order, stops them | the sites' composition roots, `checkModules`, `checkFacts` |
| **Extension points**: the generic mechanism. The module that *owns* a point declares it (`hosts` owns route kinds, `catalog` sources, `studio` data store kinds, `connections` data consumers; the kernel itself owns identity providers, event types and component adapters); other modules fill it | wired by hand per site |
| **Events**: the outbox, the dispatcher, webhook signing (section 2); the in-process bus later (C3, deferred) | four one-offs |
| **Data**: Postgres access, transactions, running each module's migrations | `pg.ts`, `pg-migrate.ts` |
| **Panel identity and rights**: panel users, passkeys, sessions, rights and places, Activity | `core/src/panel` (`passkeys.ts`, `rights.ts`, routes `accounts`, `sign-in`, `activity`), `accounts.ts`, `sessions.ts` |
| **The identity contract** for people signed in to what the panel serves: an interface (contract 5: opaque id + provider, `rolesIn(area)`) that identity modules implement | doesn't exist |
| **Three hosts**: panel, gate, cli. Each is an HTTP or command shell with the shared rules (security headers, same-origin, rate limiter, refusals, body limits) and runs whichever modules are on. A module may also run **its own server process** on the same host code: `backends`' `lfdln-backend` | `panel/shell.ts`, `packages/gate/src/app.ts`, `cli.ts` |
| **Helper kit**: socket server and client, ops declared with versions (C-Q2), `runner.ts` (systemd-run) | `runner.ts`, each helper's `main.ts` |
| **Building blocks** (A-Q3, in C2-rest): one scheduler, one job queue, one backoff policy, `atomicWriteFile`, `runHelper`, a helper-client registry | copies in many packages |
| **Config, the site profile, the site's words** | `config.ts`, `profile.ts` |
| **Browser side**: the React panel frame with a registry where modules add menu items and pages; `PammyElement` for widgets; the component adapter interface (L-Q3) | `core/web`, `core/widgets/base.ts` |

### What moves out of `core`, and in which step

The old single step **K** is split in three (master-plan section 5, Track 0). It is bigger than
first written: `core/src/gate/store.ts` holds areas', people's and requests' tables together.

| Today | Goes to | Step |
|---|---|---|
| `core/src/gate/store.ts` | split **three ways**: **areas** (role sets, memberships, the allow decision), **people** (visitors, sessions, links), **requests**; its **gate-op kit** (`GateError`, `cleanLine`, `cleanMessage`, `cleanBy`, `int`, `logEvent`) **stays in the kernel** (`kernel/gate/ops`), used by ten modules (decided 2026-10-08, module-dependency-graph) | **K-a** |
| visitor passwords (their rules and store), `common-passwords.txt`, the visitor sessions store, `visitor-settings.ts`; people's widgets in `areas/widgets/login.ts` | **`people`**: the lfdln/pammy visitor identity provider, behind the identity contract (K-Q2). The scrypt hashing function itself stays in the kernel (`security`): `backends` hashes passwords too | **K-a** |
| the gate's `/check` decision; the session cache | decision to `areas`, sessions to `people` with single-flight (gate G3, review P2) | **K-a** |
| module sockets, slots, rights, nginx locations named in `core` | registered by their modules | **K-b** |
| `state()`, `live.ts` caches | composed from module parts, registered caches (gate G4's state and caches) | **K-b** |
| media API, data API, form-links' saves built by the gate | built by their modules (gate G6); `packages/gate` becomes the kernel's **gate host** | **K-b** |
| `manifest-catalog.ts` | `catalog` | **K-b** |
| `panel/gate-shapes.ts` (forms' and areas' types); `names.ts` | forms' and areas' `src/shared/`; `files` (`isSafeEntryName` stays a kernel building block: catalog and thumbs use it) (decided 2026-10-08) | **K-b** |
| the folder picker, `isOn('apps' / 'hosts')` for places | a **place kinds** extension point owned by the kernel (files, hosts, apps fill it: list, pick, "is X inside place P"); the picker a kernel component asking the registered kinds (decided 2026-10-08) | **K-b** |
| Settings pages that reach into forms, apps, mail | a **settings sections** extension point: each module adds its own section; module-settings-plan's U11 (declared part settings) is built on it, one mechanism (decided 2026-10-08) | **K-b** |
| `nginx.ts` (rendering nginx from the profile) | `hosts`, and the few panel/gate files a site always has into the site package | **K-b** |
| comments' switch into the data API | `studio`'s API | **K-b** |
| examples writing other modules' tables | through those modules' APIs | **K-b** |
| `files.*` and `thumbs.*` tables, created by catalog's migration | `files` and `thumbs` migrations take them over (A-Q5); **expand/contract**: the new migrations adopt the tables (`IF NOT EXISTS`, nothing dropped), catalog's migration stays as history, files writes labels only through catalog's functions | **K-b** |
| the package name `@panel/core` | **`@panel/kernel`** (K-Q1), **through a shim**: `@panel/core` re-exports `@panel/kernel` for several releases; a **committed codemod** rewrites imports, and other branches re-run it when they rebase; at a quiet time; **separate from the store split** (V2-Q6) | **K-rename** |

K-a and K-b change **no behaviour and no schema names** (except review P2's faster session cache in
K-a); any package rename beyond `core` goes through a shim like K-rename, never inside K-a / K-b
(projects-domains PD-Q1).

Forms, comments and the components then ask "who is this?" through the identity contract, not
through visitors' tables. Visitors (`people`), Backends users (`backends`) and external
providers (`connections`) are three implementations, and the kernel prefers none of them. That
is what makes `backend=` and `store=` on `<pammy-form>` the same code path as today's
signed-in-only forms.

### Helpers stay small (K-Q3)

The root and sandboxed helpers (pammydb, sitefs, services, projects, routes, mail, thumbs,
apps, and later `lfdln-remote`) are separate programs with their own users and sandboxes. They
use only the **helper kit**, not the module host, the events or the shells: the less code runs
as root or next to every database, the better. A helper's ops are its contract, versioned.

## 5. Module rules

The rules this plan's steps put in place and then enforce (master-plan section 3, rules 1-9 and
14; A-Q1 firm). The same words as master-plan; how each is checked here:

| # | Rule | Checked by | From step |
|---|---|---|---|
| 1 | **A module's tables are its own**; others use its functions, ops or events | the boundary test reads table names in SQL and matches them to the migrations that create them; the **allow list is generated by K0** from current `main` and only shrinks | C1 (report from K0) |
| 2 | **Each package has a public entry**, not `"./*"` | `package.json` `exports` checked by the boundary test | C1 |
| 3 | **The kernel, the gate host and the sites name no module** | the boundary test: no imports of modules, no module names in string lists | kernel: K-b; gate host: K-b (G6) |
| 4 | **Sites only compose**: no SQL, no module logic | the boundary test (no SQL in `sites/**`) | C1 |
| 5 | **Runtime dependencies are declared** (socket ops and gate ops count) | `test/modules.test.ts` boots each module alone with its `needs`; K0's report lists undeclared ops | C1, op registries C2-min |
| 6 | **Registries are open**: no CHECK lists or fixed columns per module | review; the boundary test flags new `CHECK (… IN (…))` on kind columns | C2-min |
| 7 | **Events carry the publisher's prefix** (`monitoring.check.down`) | the events test: `events.publishes` only with the module's own name | C4 |
| 8 | **Size and copies**: no new file over ~400 lines / 25 KB; no new copied block over 6 meaningful lines; allow lists only shrink | size check (a report from C1), copy check (a report until K is done, then fails builds) | C1 |
| 9 | **Shared server / browser code lives in `<package>/src/shared/`** | the boundary test (`web/` and `widgets/` import only `src/shared/`) | C1 |
| 14 | **Both engines**: anything for databases works on Postgres and MariaDB and is tested on both | T2's `runContractSuite(impl, engines)`; the data store adapter suite runs on both | C6-min |
| 15 | **A module works with only its must-haves** (`needs`); the rest lights up (`worksWith`) | `test/modules.test.ts` boots each module with only its `needs`, and with all its `worksWith` | U2 |
| 16 | **A module's plugins plug into its sockets; the module names none of them** | the boundary test (forms names no comment) | U3 |

## Steps

Each one is its own release (master-plan rule 10): build, install, verify on both sites when
shared code changes, "as built" written, master-plan updated. Order, dependencies and sizes are
master-plan section 5, "Track 0"; this table says what each includes and how it rolls back.
**Rollback** follows master-plan section 7: migrations only add (expand, then contract in a
later release), so "install the previous release" always works; anything replacing a live
mechanism runs **side by side** with the old one first. At most one of C1, K-a, K-b, K-rename,
C2 is open at a time; K-a and K-b freeze `core/src/gate/**`, `packages/gate/**`,
`packages/areas/**` (master-plan section 6).

| Step | Includes | Gate steps | Behaviour | Rollback |
|---|---|---|---|---|
| **K0** | a **coupling report generated from current `main`**: SQL on other modules' tables, undeclared socket and gate ops, modules named in the kernel, gate and sites; replaces architecture.md section 5's hand-made lists; its SQL list becomes rule 1's allow list | — | none (a report) | nothing to roll back |
| **C1** | `defineModule` in every package (section 1); `MODULES` / `NEEDS` / `FACTS` made from them; `DEPENDS_ON` checked against them; sites compose from definitions; public entries (rule 2); the boundary test with SQL ownership (allow list = K0); size check as a report | — | unchanged: same routes, schema, verify count | previous release; no schema change |
| **K-a** | the **store split** three ways (areas / people / requests); people's widgets out of `areas/widgets/login.ts`; visitor accounts to `people` (section 4) | **G3** (decision → areas, sessions → people with single-flight), **G4a** (the store split) | unchanged, except P2: the session cache is single-flight (faster) | previous release; tables keep their names and schemas, so the old code reads them as before |
| **K-b** | **the kernel names no module**: sockets, slots, rights, nginx locations registered by modules; `manifest-catalog` → catalog; nginx rendering → hosts; comments' data-API switch → studio; examples through module APIs; `files.*` / `thumbs.*` migrations out of catalog's (A-Q5) | **G4b** (state, caches), **G6** (modules build their deps) | unchanged | previous release; the files / thumbs migrations only adopt existing tables (expand), nothing is dropped until a later contract release |
| **C2-min** | what M1 needs: the **project-kind** registry as a stub (contract 6), the **address / route API** with `/_api/` and `/_pammy/` reserved (contract 8), **secrets delivery** (17), the **gate op registry** (18, gate side) | **G1** (op registry; `admin.ts` becomes a loop) | unchanged | previous release; reserved paths are checked, not migrated |
| **C6-min** | the **data store adapter** contract and suite, passed by both lfdln engines (1); the **identity** contract (5: opaque ids + provider, `rolesIn(area)`; S5, D20) | — | unchanged | previous release; interfaces only, no schema |
| **K-rename** | `@panel/core` → `@panel/kernel` through a **shim** (old name re-exports the new for several releases) and a **committed codemod**; at a quiet time; separate from the store split | — | unchanged | previous release; the shim means old imports keep building, so other branches aren't broken |
| **C2-rest** | project tabs (7), health + named gauges (9, O1), backups (10, for R4), manifest sections (13), mail sender (12, MS1), helper op versions (18, helper side; a panel newer than its helper refuses at start-up); kernel building blocks (scheduler, job queue, backoff, `atomicWriteFile`, `runHelper`, helper-client registry; A-Q3); the other registries (refusals, housekeeping, Help topics, rights) | **G2** (pages, assets; hashed assets P6 as its own visible change) | unchanged | previous release; each building block replaces copies one at a time |
| **C4** | the outbox (section 2): event types in the kernel (2, 14), partitioned by day, kept by type, row events after commit and retried (D4), cursor below the snapshot (D5), advisory lock per subject, NOTIFY without payload; the dispatcher with bounded concurrency; Settings > Events; `people.account.deleted` and `forms.response.kept` moved on | **G5** (housekeeping, form-link retries, areas reload as module jobs on C2-rest's scheduler; `responseKept` → `forms.response.kept`, through the outbox since C3 is deferred) | exam prep sees no difference; form links still save | **side by side first**: the deletion poller and `responseKept` keep running for a release while the outbox writes the same events, and both are compared; then the old ones go in a later release. Rollback = previous release; the outbox tables stay unused |
| **C5** | `studio.row.*` with keys (replaces `record_touches`, review P1), the rest of the first event types, `monitoring.check.down/up`, webhooks with D10's rules and "who may receive", one webhook source (section 2) | — | visible: Settings > Events shows them; a service receives `forms.response.kept` for its own form only | **side by side first**: `record_touches` stays for a release and the catalog's result is compared; previous release works because `record_touches` is still written |
| **C6-rest** | the other contracts, each **when its first user starts**: data consumer (3) with X5, component adapter (4) with X8 / B3, table writer (15) with B6, access per project (11) with N2, gate pushes (16) with B3 / X5b, manifest sections' connected-file part with N3 | — | per use | with the step that uses it |
| ~~C3~~ | the in-process bus (files → thumbs → media): **deferred** (master-plan section 11). It would move working callbacks with no gain to users; G5's event part goes through the outbox in C4 instead | | | |

**G7** (signed identity headers S1, the gate's database-helper socket S2, real IP S6, emailed links
on any domain) is not in phase 0: S1, S2, S6 land before K (Track S), the rest with N4 / N5
(projects-domains).

**Done when**, for phase 0 as M1 needs it (C1 → C6-min): routes, schema and verify unchanged on
both sites; adding a module touches its package and the profile's list only; K0's allow list
only shrinks; the data store suite passes on Postgres 17 and MariaDB 11.4; then B1 and X1 can
start.

### K0 as built (2026-10-06, merged 8b78a5a, live)

`docs/coupling-report.md` and `.json`, generated by `node tools/coupling/report.ts`;
`test/coupling.test.ts` checks it is current. Questions, **taken as suggested 2026-10-06**:
- **K0-Q1** A report out of date with the code fails the fast tier. *Suggested: fail.*
- **K0-Q2** The code parser comes in through vite; pin it as its own dependency? *Suggested: not
  yet.*
- **K0-Q3** The report's module mix-up (`moduleOf` placing record-labels / touches ops): fix now or
  in K-b? *Suggested: K-b, when the gate stops naming modules.*
- **K0-Q4** C1's allow list also covers the undeclared runtime dependencies? *Suggested: yes.*

### C1 as built (2026-10-06, branch c1-define-module; merged 853e155, live)

Behaviour unchanged: same routes, schema, migration order and verify count on both sites.

- **One definition per module**: `packages/<m>/src/module.ts`, `export default defineModule({ name,
  kernel: '^1', needs, facts })` (`@panel/core/module`: the type, `defineModule`, and
  `checkModules` / `checkFacts`, which now take the definitions). Only what a module *is* moved;
  what it *does* (`panel`, `gate`, `cli`, `housekeeping`, `widgets`, `events`, `rights`, sockets)
  moves in K-b (C1-Q1).
- **`@panel/modules`** (a package, not a module) imports every definition and makes `REGISTRY`,
  `NEEDS` and `FACTS`. The sites hand `REGISTRY` to `loadConfig(profile, REGISTRY, env)`, so the
  kernel no longer holds NEEDS / FACTS. `MODULES` (the names, and the `Module` type) stays in
  `core/src/profile.ts` until K-b, checked equal to the definitions (C1-Q2).
- **Proof**: `test/modules.test.ts` compares the made NEEDS / FACTS with the hand-written ones
  (frozen at 8b78a5a) and checks both site profiles are asked exactly what they were before.
- **DEPENDS_ON** (test/boundaries.test.ts) is checked against the definitions.
- **Rules 1, 4, 5**: `docs/coupling-allow.json` (K0's report at C1: 97 SQL touches, 35
  undeclared op calls) is the allow list; the boundary test fails on anything new and on entries
  the code no longer has (`node tools/coupling/allow.ts --shrink`). Sites' SQL is in it (13), so
  rule 4 is "no new SQL in sites".
- **Rule 2**: every `package.json` lists its entries (290 over 26 packages and 2 sites, what the
  code imports by name today), not `"./*"`; `node tools/coupling/entries.ts` writes them and the
  boundary test fails when they differ (C1-Q3).
- **Rule 8**: `node tools/coupling/size.ts` reports files over 400 lines / 25 KB (31, the allow
  list `docs/size-allow.json`) and copied blocks of 7+ meaningful lines (51); the boundary test
  prints what is new and fails nothing.
- **Rule 9**: already held, more strictly: pages and widgets import only other packages' pages
  and widgets. It loosens to `src/shared/` when the first shared file is needed by a page.

**C1 questions** (taken as suggested 2026-10-06):
- **C1-Q1** Definitions hold only name, kernel, needs, facts in C1; routes and the rest move in
  K-b, when the sites stop calling modules by hand. *Suggested: yes (one move of app.ts, not two).*
- **C1-Q2** `MODULES` / `Module` stay in core until K-b. *Suggested: yes; core can't import the
  definitions without naming every module.*
- **C1-Q3** Public entries are today's 290, frozen, shrinking towards one entry per module as K
  moves code. *Suggested: yes.*
- **C1-Q4** "Boot each module alone" (rules 5 and 15) needs the definitions' `panel` / `gate`
  parts. *Suggested: in K-b; C1's test checks the lists only.*
- **C1-Q5** The copy report finds server/page copies (e.g. `studio/src/pammydb/ir.ts` and
  `studio/web/lib/schema.ts`, 26 lines): candidates for `src/shared/`. *Suggested: leave for K.*

## Questions for momolig

**All answered 2026-10-06.** P-Q1, K-Q1..K-Q4 and C-Q1 (confirmed 2026-10-06) are **firm**. C-Q2 and E-Q1..E-Q6 are
**provisional**: momolig took the suggested answers "for now"; they are confirmed (or changed)
**before C2-rest** (C-Q2) and **before C4** (E-Q*), by asking momolig (docs/master-plan.md section 2).
Where the review (docs/security-performance-review.md) changed a suggestion, the changed one is
the answer, marked **Answer** below.

### C-Q1. One definition per module

**(a) `defineModule` per package, lists made from it** (above). Adding `backends` = a package
with its `module.ts` + one word in lfdln's profile.
**(b) Keep the lists by hand**, just document them. Adding `backends` stays about ten edits in
as many files.
*Suggested: (a).*

### C-Q2. Helpers' ops with versions

Example: the panel's release adds an op `pammydb list-rows-v2`, but the helper is still on the
old release (installed separately, or rolled back).
**(a) Declared versions:** the panel starts and says "the database helper is older than this
panel (needs pammydb@4, has @3)", and the Studio pages say so.
**(b) As today:** the first click that uses the new op fails with "unknown op".
*Suggested: (a).*

### E-Q1. Delivery guarantee

**(a) At least once**: a receiver can get the same event twice (after a crash mid-delivery) and
must skip one it has seen by `id`. **(b) At most once**: never twice, but one can be lost.
**(c) Exactly once**: costs a lot (two-phase commits with every receiver).
*Suggested: (a)*, which is what the deletion hook already does.
**Answer (provisional, confirm before C4): (a), and receivers must dedupe by `id`**; the webhook
kit does it, tested (review).

### E-Q2. Where the dispatcher runs

**(a) In the panel's server process**, like the deletion poller today. **(b) Its own small
service** (`lfdln-events`): a busy dispatcher can't slow the panel's pages, and restarts on its
own. *Suggested: (a) now*; moving it out later is a deployment change, not a design change.
**Answer (provisional, confirm before C4): (a), with bounded concurrency and per-host timeouts**,
so a hung service can't stall the panel (review).

### E-Q3. How long events are kept

7, 30 or 90 days. Example: a service that was down for two weeks gets everything it missed if
it's 30 days; with 7, the panel shows the old deliveries as failed and they're lost.
*Suggested: 30 days*, as `deleted_accounts`. A setting later if needed.
**Answer (provisional, confirm before C4), changed by the review (D19): kept by type**: row
events hours to days, account and response events 30 days; the outbox partitioned by day.

### E-Q4. Exam prep's existing hook

**(a) Keep `/_lfdln/account-deleted` exactly as it is**: the outbox delivers
`people.account.deleted` to it in the old format. **(b) Move exam prep to `/_lfdln/events`**
(a release of exam prep). *Suggested: (a) now, (b) whenever exam prep is next released.*
**Answer (provisional): (a) now; (b) in N7**, when exam prep moves to Code (master-plan
Track N).

### E-Q5. Can a project or service publish events too

Example: exam prep publishes `examprep.attempt.finished` and the party app listens.
**(a) Yes**, through a signed POST to the panel, declared in its `pammy-panel.json`. **(b) Not
now**: services only receive. *Suggested: (b) now*; it's (a) in the same shape later.

### E-Q6. Events in the browser

Should a page get panel events live (say, an admin page of the party app showing new RSVPs)?
That's what Backends realtime is for (F-Q4), with its policies. *Suggested: no separate
browser events; pages go through Backends realtime.*

### P-Q1. Plugins: (a) DECIDED 2026-10-06

momolig: *"I agree that modules should be plugins."* First-party modules are the plugins: built
in, `defineModule`, plugging into named extension points. (b) (outside apps through declared
integration) is how services already work and stays; (c) (third-party code at run time) is not
planned.

Asked then: should there be a **kernel**? Yes: section 4, K-Q1..K-Q4.

### K-Q1. Name: DECIDED 2026-10-06, rename

`core` becomes **`@panel/kernel`**, so the name says the rule (nothing feature-shaped lives
there). Imports change from `@panel/core/pg` to `@panel/kernel/pg`; a mechanical change in step
**K-rename**, through a shim and a committed codemod, separate from the store split (V2-Q6).

### K-Q2. Visitor accounts: DECIDED 2026-10-06, a module

They move to **`people`**, behind the identity contract. The kernel knows that someone is
signed in and who vouches for them, never how visitors' passwords work.

### K-Q3. Helpers: DECIDED 2026-10-06, the helper kit only (as suggested)

Helpers use the socket server/client, versioned ops and `runner.ts`, nothing else of the kernel.

### K-Q4. When: DECIDED 2026-10-06, in phase 0, between C1 and C2

Step K, now **K-a** and **K-b** (and K-rename at a quiet time), carves the kernel out of `core`
with no behaviour change, before the extension points (C2-min, C2-rest) and events (C4, C5) are
built on it.
