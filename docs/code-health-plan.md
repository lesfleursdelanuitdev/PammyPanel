# Code health: duplication, large files, and the gate

DECIDED 2026-10-06: momolig took every suggestion (H-Q1..H-Q5). Analysis only, nothing built (no coding yet).
Follows docs/architecture.md, whose A-Q1..A-Q5 momolig answered **yes to all five** the same
day (module rules, phase 0 widened with the 13 contracts, kernel building blocks in C2,
declarative validation, files / thumbs schemas out of catalog).

momolig, 2026-10-06: *"We need to also ensure that we do not duplicate code unnecessarily and
also refactor extremely large files. We should look at refactoring the gate."*

## 1. Duplication (measured 2026-10-06)

Method: every source file in `packages/` and `sites/` (not `release*/`, not tests), comments,
imports and short lines left out, a window of 6 lines compared across files. The numbers are
matching windows, a rough size of the copy.

**Copy-paste is low overall.** The real duplication is **structural**: the same job written
again in a different shape, which no line comparison finds (section 1.2).

### 1.1 Copied code

| Windows | Where | What to do |
|---|---|---|
| 35 (+7) | `files/web/pages/Files.tsx` ↔ `media/web/pages/Media.tsx` (+ `media/web/components/move-copy.tsx`) | one file-grid / toolbar / move-copy component set, used by both pages |
| 30 | inside `files/src/sitefs/media.ts` | the repeated path / name / ownership checks of each op into shared guards |
| 27 + 26 + 2 | `studio/src/studio/resources.ts`, `studio/src/pammydb/ir.ts`, `relationships.ts` ↔ `studio/web/lib/schema.ts` | the same schema rules on the server and in the browser: one shared module (`studio/src/shared/`, as forms already has `forms/src/shared/`) imported by both |
| 24 | `files/src/panel/routes/files.ts` ↔ `media/src/panel/routes/media.ts` | shared route helpers (or media's routes become files' routes with a filter) |
| 12 + 7 + 3 + 2 + 2 | `sites/*/web/src/{App,main,menu,pages/Home}.tsx`, `vite.config.ts` | one web shell in the kernel; each site gives its menu and words |
| 8 | `forms/src/shared/form-types.ts` ↔ `forms/web/lib/types.ts` | the web imports the shared file |
| 5 | three Examples pages (`examples`, `forms`, `media`) | one examples-page component |
| 3 | `help/src/help.ts` ↔ `help/web/lib/types.ts` | shared types |

### 1.2 The same job written again (from docs/architecture.md, section 6)

| Job | Copies | One place for it |
|---|---|---|
| periodic timers | 19 `setInterval`s, 4 kinds of overlap guard | kernel scheduler (A-Q3) |
| retry / backoff | 6+ (start-up loops ×3, `tx()`, deletions table, form-link saves, thumbs) | one backoff policy |
| long jobs with steps | 2 (apps, projects) | one job queue |
| helper start-up (socket activation, fds, signals) | 9 entry points | `runHelper()` |
| atomic write-then-rename | ~16 files, no fsync | `atomicWriteFile()` |
| site composition | 2 roots ~70% the same (record keeper, media / thumbs / publisher wiring, housekeeping SQL, timers) | `startPanel(profile, extras)` in the kernel |
| nginx generation | 3 (templates, hosts' code-built strings, pammy's `nginx-hosts.ts`) | hosts' renderer, templates for the fixed parts |
| "address of a route" (`https://${host}.${domain}${path}`) | 4+ (lfdln app.ts, services, projects, admin's `linkUrl`) | the route API's `addressOf` (contract 3) |
| helper error → panel message | `HELPER_STATUS` + per-site refusals + ~20 error classes | one error shape with codes in the kernel |
| gate admin op metadata | switch + `SCOPED_OPS` + `changesMemory` + `moduleOf` + jsonline's `quiet` | op registry (section 3) |
| request validation | hand-written checks everywhere | declarative schemas (A-Q4) |

**Keep it from coming back:** a duplication check in the test suite (the measurement above, or
a tool like jscpd) that fails when a new copy over a threshold appears, with an allow list that
only shrinks (H-Q2).

## 2. Large files

Sizes in lines and KB (lines here are wide, so KB says more). Top of the list, with the split
each one wants:

| File | Lines / KB | Split into |
|---|---|---|
| `projects/src/helper/ops.ts` | 1087 / 66 | one file per concern: create and scaffold, build, releases and roll back, run (Quadlets, control), env, git and pushes, health and logs; `ops.ts` keeps the table of ops |
| `files/src/sitefs/media.ts` | 921 / 53 | media ops vs file ops (copy, move, restore…), shared guards (1.1) |
| `studio/src/pammydb/pg.ts`, `maria.ts` | 745 / 38, 641 / 32 | per concern for each engine: databases and logins, introspect, apply, rows; shared SQL building in `common/` |
| `areas/widgets/login.ts` | 735 / 42 | one file per element; the people elements (register, confirm, reset, account, invite, forgot) move to `people/widgets/` (step K) |
| `hosts/src/panel/routes/hosts.ts` | 624 / 41 | domains, hosts, routes, site folders: a route file each |
| `hosts/src/render.ts` | 667 / 39 | server blocks, catch-alls, gate lines, one file per route kind (kinds move to their modules' route-kind files, which today import hosts' internals) |
| `core/src/gate/store.ts` | 612 / 38 | areas, people, requests stores (step K, docs/architecture.md) |
| `areas/src/gate/access.ts` | 453 / 33 | role sets, memberships, manifest reading |
| `examples/src/studio/db-examples.ts` | 472 / 33 | the example data into JSON files, the code that loads them stays |
| `catalog/src/apps.ts` | 525 | the keeper (pull, push, sync state) vs the item mapping |
| `gate/src/app.ts`, `admin.ts` | 437, 432 | section 3 |
| Web pages over 500 lines: `Projects.tsx`, `Files.tsx`, `Software.tsx`, `Media.tsx`, `Hosts.tsx`, `Access.tsx`, `FileEditor.tsx`, `DatabaseCanvas.tsx` | 500-560 / 31-35 | components per panel or dialog; Files / Media share theirs (1.1) |

**Rule for the future** (H-Q1): new files stay under ~400 lines / 25 KB; a test lists the files
over it as an allow list that only shrinks; a file on the list is split when it is next changed
for a feature, never in a release of its own unless it blocks something.

## 3. The gate

### 3.1 What the gate does today (checked 2026-10-06)

`packages/gate` (4 files, ~1000 lines) plus `packages/core/src/gate` (7 files, ~1300 lines).
Eight jobs in one place:

| Job | Where | Belongs to |
|---|---|---|
| HTTP shell: headers, body limit, readiness (`WITHOUT_DB`), error handler | `gate/src/app.ts:109-131, 362-374` | **kernel** (gate host) |
| **The access decision**: `/check`, `/check/:token`, identity headers, the "folder without a home page" redirect | `app.ts:134-250` | **areas** (+ who is signed in from **people**) |
| Built-in pages and widget scripts: `login.js`, `forms.js`, `comments.js` (`no-store`, review P6), `page.html`, account pages, form preview, examples' files | `app.ts:111-124, 225-302, 310-336, 381-437` | **people**, **areas**, **forms**, **comments**, **examples** (each its own) |
| Every module's routes, with their deps built here (media API, data API, `responseKept` hook) | `app.ts:304-360` | each module builds its own deps |
| **Admin socket**: one 79-case switch, `moduleOf()`, `SCOPED_OPS`, `changesMemory()` | `gate/src/admin.ts:61-411` | each module registers its ops |
| `state()`: one query set over areas, visitors, memberships, events, sessions, requests, links | `admin.ts:75-111` | areas, people, requests each give their part |
| Emailed links' host: `hostFor`, `accountsHost` (only the home domain) | `admin.ts:117-132, 153-162` | **people**, and must change for **accounts on every domain** (D-Q1) |
| Memory: areas snapshot, visitor settings, sessions (60 s / 15 min stale), site routes | `core/src/gate/live.ts` | areas, people, hosts (each a registered cache) |
| Stores: areas, visitors, links, sessions, requests, events | `core/src/gate/store.ts` | areas, people, requests (step K) |
| Timers: areas reload 60 s, housekeeping 1 h (forms and areas hard-coded), form-link retries 15 min | `gate/src/start.ts:85-95`, `housekeeping.ts` | each module's jobs on the kernel scheduler |

### 3.2 Target

The gate becomes the **kernel's gate host**: a shell that runs whatever the modules on this
site register, and knows none of them.

```ts
// packages/forms/src/module.ts (the gate part)
gate: {
  routes:  (app, ctx) => formsGateRoutes(app, ctx),                 // /_pammy/forms/:name, responses API
  assets:  [{ name: 'forms.js', file: 'forms.js' }],                 // served hashed + immutable (P6)
  pages:   [{ path: 'form-preview', csp: framedByPanel, element: … }],
  ops: {
    'form.get':    { handler: getForm,    scoped: formInPlaces },     // was SCOPED_OPS + formIn()
    'form.save':   { handler: saveForm,   scoped: formInPlaces },
    'responses.list': { handler: listResponses, scoped: responsesInPlaces },
    …
  },
  state:   (db) => ({ forms: … }),                                    // its part of the panel's picture
  jobs:    [{ name: 'forms-housekeeping', every: '1h', run: purgeTrash }],
  events:  { publishes: ['forms.response.kept'] },                     // form-links subscribes: no hook
}
```

| Today | Target |
|---|---|
| `moduleOf()` guesses a module from an op's name | an op exists only if its module is on and registered it |
| `SCOPED_OPS` + `formIn` / `responseScope` | each op's `scoped` check, given by its module |
| `changesMemory()` prefix rules → `changed()` clears everything | ops publish in-process events (`areas.changed`, `people.visitor.changed {id}`); each cache drops only what changed (review P2) |
| `state()` SQL over three modules | each module's `state` part, composed by the host (one call from the panel, as today) |
| `/check` in the gate | areas' decision function, mounted by the host; identity headers signed (review S1) |
| sessions cache in `live.ts` | people's cache, with single-flight and per-visitor invalidation (review P2) |
| widget scripts `no-store` at fixed addresses | an asset registry: `/_pammy/a/<hash>/forms.js`, `immutable`, plus a tiny `forms.js` loader for old pages (review P6) |
| media / data API deps assembled in `app.ts` | each module builds its deps from the context and its own facts |
| housekeeping with modules hard-coded, timers in `start.ts` | module jobs on the kernel scheduler |
| emailed links only to the home domain | people picks the host the person signed up or signed in on, on any domain (D-Q1) |
| the gate's access to the database helper: every op | studio's gate part declares the ops it needs; the helper's gate socket accepts only those (review S2) |

### 3.3 Steps (each no change in behaviour unless it says so; routes snapshot and admin op list unchanged)

| Step | What | Fits into |
|---|---|---|
| **G1** | **Op registry**: each module exports its admin ops with `scoped` and `changes`; `admin.ts` becomes a loop; `moduleOf`, `SCOPED_OPS`, `changesMemory`, jsonline's `quiet` list go | phase 0 **C2** (op registries, A-Q3) |
| **G2** | **Pages and assets**: built-in pages, widget scripts, examples' files registered by their modules; the host serves them | **C2**; hashed assets (P6) as a separate, visible change |
| **G3** | **The decision to areas, sessions to people**: `/check` and `/check/:token` mounted from areas; the session cache in people with single-flight and per-visitor invalidation (review P2: a behaviour change, faster) | step **K-a** |
| **G4a** | **Store split**: `core/src/gate/store.ts` → areas / people / requests | step **K-a** (master-plan v2) |
| **G4b** | **State and caches**: `state()` composed from module parts; `live.ts` → registered caches (areas snapshot, visitor settings, site routes) | step **K-b** |
| **G5** | **Jobs and events**: housekeeping, form-link retries, areas reload as module jobs (on C2-rest's scheduler); `responseKept` → `forms.response.kept` through the outbox (C3, the in-process bus, is deferred) | **C4** |
| **G6** | **Deps built by modules**: media API, data API, form-links' saves construct their own deps; `packages/gate` holds only the host | **K-b** |
| **G7** | **Security and domains** (behaviour changes, each its own release): signed identity headers (S1), the gate's narrow database-helper socket (S2), real IP per domain front (S6), emailed links on any domain (D-Q1) | S1, S2, S6 in Track S **before K** (S6 live, S1 in progress); emailed links with N5 (docs/projects-domains-plan.md) |

After G6 the gate package is ~200 lines: start, shell, error handler, the admin socket loop,
the php door, the asset and page server.

## 4. Questions for momolig: all answered 2026-10-06 with the suggestions

### H-Q1. A size limit for files

New files under ~400 lines / 25 KB, checked by a test with a shrinking allow list; big files
split when next touched. *Suggested: yes.* Example: the next change to
`projects/src/helper/ops.ts` first splits out the part it touches.

### H-Q2. A duplication check in the tests

A test that fails when a new copied block over a threshold (say 6 meaningful lines) appears in
two files, with a shrinking allow list. *Suggested: yes.*

### H-Q3. Shared code between server and browser

Code both sides need (Studio's schema rules, forms' types, help's types) lives in
`<package>/src/shared/` and the web imports it, as forms already does. *Suggested: yes;* the
boundary test allows `web/` → `src/shared/` and nothing else of `src/`.

### H-Q4. When the gate is refactored

**(a)** Folded into phase 0 as above (G1-G2 in C2, G3-G4 in K, G5 in C3-C4, G6 end of K, G7 with
N4-N5; master-plan v2 since: G3 + G4a in K-a, G4b + G6 in K-b, G5 in C4, G7's S1 / S2 / S6 before K). **(b)** As its own track before phase 0. *Suggested: (a)*: the gate is where most of
phase 0's mechanisms (op registry, pages, caches, jobs, events) first show up, so doing it apart
would build them twice.

### H-Q5. Gate pages and widgets on every domain

With accounts on every domain, the built-in pages (`/_pammy/login`, …) and widget assets answer
on every domain's hosts. **(a)** The same pages everywhere, titled with the host's domain;
**(b)** a page set per domain (its own look). *Suggested: (a) now*; a domain's own look can come
later through the same page registry.
