# Permissions for five people: phase 3 of the platform plan

Status: **decided 2026-09-24** (Q1-Q6 answered, at the end). Step 1 live 2026-09-24 23:06 UTC as
release e9f180bfb853a0bb (commit 63fe6c4; verify 541/541, access 62/62). Step 2 built 2026-09-24 as
release f12b03e11197859b (commit 8fbe8fd; build: unit 964, nginx 30, gate 175, tutorials 67,
browser 115; see "Step 2, as built" below); live 2026-09-25 00:30 UTC (verify 547/547 after
fixing two checks that still sent the gate `scope` instead of `places`, commit 9a61b26; access 62/62).
Step 3 live 2026-09-25 01:13 UTC as release a2ef508c4538a8e7 (commit 9fc0b97; build: unit 968, nginx 30, gate 175, tutorials 67, browser 115; verify 548/548, access 62/62). Its new places check had lost its "C" quotes to the shell and passed on a failed query; fixed in verify, which now fails a query error.
Step 4 live 2026-09-25 01:35 UTC as release 08b0a684c28a566f (commit a1a2568; build: unit 969, gate 175, tutorials 67, browser 115; see "Step 4, as built"; core 0002 ran, verify 549/549, access 62/62). PHASE 3 DONE.
Part of docs/platform-plan.md (phase 3, G5: "rights per module, owners per host, invites from
the panel. pammy.org gets it too (Pamela and momolig as admins)"). Builds on phase 2
(docs/adapters-plan.md, done 2026-09-24).

What phase 3 is for: after it, what a person may do in the panel is written down per person:
admin or not, which parts of the panel they have (**rights**, on or off), and which **places**
they are kept to. pammy.org gets exactly what its four accounts can do today, written the new way.
lfdln (phase 5) starts with it.

## What was found (2026-09-24)

- **Two roles and one scope.** `users.role` is `manager` or `member`; `users.scope` is null
  or one top-level folder (`/recipes`). A manager can't have a scope (accounts.ts `setRole`,
  `setScope`).
- **Four levels, asked for by each route**: `need(req, reply, 'user' | 'recent' | 'manager' |
  'manager-recent')` (core/panel/context.ts). Counted over packages/*/src: user 94, recent 7,
  manager 72, manager-recent 30. `recent` is the fresh-passkey rule (10 minutes, `RECENT_AUTH`).
- **What a scoped account reaches** is one regex, `LIMITED_ROUTES` (core/panel/limited.ts):
  its own sign-in and passkeys, Help, and files, media, forms, responses and comments. Any other
  route answers 404 for it. Inside those routes, each one checks the folder too
  (`pathUnderScope`, `ScopeError`, site-files.ts). test/routes.snapshot.txt keeps
  `limited-ok` / `limited-no` beside each of the 483 routes (218 of them under /api).
- **Manager-only today**:
  - all of Accounts;
  - Activity;
  - Databases (studio: 38 routes);
  - Installed software (16) and Email (5);
  - the examples' set-up and reset (12);
  - Getting started (7);
  - API keys (forms, 2);
  - form→database links (6);
  - the comments routes that touch a database or its keys (7).
  
  Members, with no scope, reach everything else: files, media, tags, forms, responses,
  comments, protected folders, people and requests.
- **Routes don't line up with packages.** The comments package holds the data API's switch and
  its keys (`/api/databases/:engine/:name/api`, `/keys`). The forms package holds the API keys.
  So "the package that registered it" can't be the right a route asks for. The route has to say.
- **Inviting already works.** A manager makes the account (`POST /api/users`) and an invite link
  (`/invite`), and the person makes a passkey on it (Invite.tsx). What's missing is choosing
  their rights on the same page.
- **Activity already names the person** (`actorOf` → `user-created`, etc.). G5's "every action
  in Activity with the person's name" holds already.
- **The gate and the helpers never see panel accounts.** They answer the panel, not the person.
  Nothing in phase 3 touches them.

## Proposal

- **R1. Admins.** `role` keeps its two values in the database (`manager` = admin). An admin can
  do everything, and only an admin can:
  - manage accounts;
  - see everyone's Activity (anyone else sees their own, R7);
  - use what G5 lists for lfdln: Certificates, DNS, Domains and Monitoring settings, adopting
    and deleting services (those modules arrive in phases 6-7 and say `admin` from the start).

  The word comes from the glossary: "account manager" on pammy.org (today's), "admin" on lfdln.
  The rule "the last active admin can't be switched off or demoted" stays.
- **R2. Rights: a small fixed list, not the packages.** A *right* is a named part of the panel,
  as a person sees it. Each module declares its rights; the profile's modules decide which exist:

  | Right | What it covers (pammy.org today) |
  |---|---|
  | `files` | File Explorer, the editor, Tags & categories |
  | `media` | Media, media folders, media examples |
  | `subdomains` | Subdomains (pammy.org) / hosts and routes (lfdln, phase 4) |
  | `forms` | Forms, the form builder, form examples |
  | `responses` | Responses (the inbox) |
  | `comments` | comment areas and Inbox › Comments |
  | `protected` | Protected folders, People, Requests |
  | `databases` | the Database Manager: databases, logins, canvas, apps and their records, form→database links |
  | `programs` | API keys and "letting programs in" (data and media APIs) |
  | `software` | Installed software, Email |
  | `examples` | setting up and resetting the examples |

  Help and a person's own passkeys aren't rights: everyone has them. Getting started goes
  with `databases` and `forms` (it makes both). lfdln's later modules add theirs
  (`monitoring`, `projects`, …) when they come.
- **R3. Each route says what it needs.** `need()` takes
  `{ right, level: 'change' | 'admin', fresh?: true }` in place of today's four strings. There
  is no "see" level (Q1): having a right means using that part of the panel, reading and changing.
  A few routes need only a signed-in person (their own passkeys, Help, their own Activity).
  The fresh-passkey rule stays per action, exactly where it is today (G5).

  The route snapshot test gets one more column, the right and level of every route, beside
  `limited-ok/no`. A route can't move or quietly change what it asks for without the snapshot
  saying so, and every /api route must name one (the test fails on a route without it).
- **R4. Stored per person.** A new table `panel.user_rights (user_id, right)`. A row means the
  person has that right; no row means they don't. Admins have no rows, because they need none.
  `/api/me` returns the person's rights. The menu shows only the parts they have. The server
  refuses the rest with 404, as it does for a kept account today, so a part they don't have
  isn't there for them.
- **R5. Places, in place of the one scope.** A new table `panel.user_places (user_id, place)`
  replaces `users.scope` and allows several places per person.
  - On pammy.org a place is a top-level folder (`/recipes`), which is today's scope.
  - On lfdln it is a host (`tutor.lesfleursdelanuit.com`), from phase 4. Until phase 4, lfdln
    has no places.

  **A person with places sees only their places, in every part they have (Q3, decided).** Any
  right can be given to them. Each part then shows and changes only what belongs to one of their
  places: files under their folders, forms and responses of their folders, their hosts' routes,
  and later their hosts' software, monitoring and databases. The routes that check
  `pathUnderScope` today check "under one of their places" instead. A part that can't yet
  tell which place a thing belongs to can't be given to someone with places until it can. In
  phase 3 those are `databases` (until Q4, phase 8), `programs`, `software` and `examples`. The
  Accounts page says so beside those rights, and the server refuses to save that combination.
  `LIMITED_ROUTES` goes: what a kept person reaches is now their rights, narrowed to their
  places.
- **R6. Inviting.** The Accounts page's "New account" asks for the rights and places too, with
  every right off. The invite link and the passkey flow stay as they are. An admin can change
  someone's rights and places later. The change works on their very next request, and Activity
  says what changed ("forms: on", "places: /recipes, /garden").
- **R7. Activity for everyone (Q2, decided).** Admins see all of it, as today. Anyone else sees
  the lines of what **they themselves** did, and nobody else's (the server filters by
  `actor_id`, not the page). Activity leaves the admin-only list in R1.
- **R8. pammy.org, unchanged.** The core's first own migration
  (`packages/core/migrations/0001-rights.sql`; the 18 in db/migrations are the closed baseline)
  writes today's accounts the new way:
  - managers stay admins;
  - members with no scope get every right members reach today (files, media, subdomains,
    forms, responses, comments, protected) and none of the rest;
  - scoped members get files, media, forms, responses and comments, plus a place for their scope.

  The test is that every account can reach exactly the routes it could before. It checks all
  483 routes × each kind of account against today's answers, which the snapshot already has.
  The one new thing they can reach is their own lines in Activity (R7).
- **R9. `users.scope` goes one release later (Q6, left to Claude).** Step 2 stops reading it and
  keeps it filled in beside `user_places`. The release after step 3 drops it, in its own small
  migration. A rollback from step 2 to today's code then just works, with no restore from the
  dump.

## Not in phase 3

- Hosts themselves (phase 4).
- lfdln's modules (Certificates, DNS, Monitoring, services, projects: phases 6-8), which arrive
  with their rights and know their hosts from the start.
- **Databases belonging to a host** (Q4, decided yes): in phase 8, a database and its app get a
  host, and someone with that host and `databases` gets them. Until then `databases` is for
  people with no places.
- Pamela's account on lfdln (Q5, decided yes): made from the panel in phase 5, like everyone
  else's. Her rights there are chosen then.
- Anything the gate or a helper checks: they stay as they are.

## The net

The same as the phases before:
- same routes;
- every suite green;
- the same verify (541 + 62);
- the same words for pammy.org.

New:
- the route snapshot names every route's right and level;
- the reach test: every kind of pammy.org account reaches exactly what it reached before;
- e2e with a person who has two rights and nothing else, a person kept to two places, and a
  non-admin reading Activity (their own lines only).

## Steps (one release each)

1. **R3 underneath, and R7 for pammy.org**: every route says what it needs in its Fastify config
   (`{ config: { needs: 'forms' } }`; `core/panel/rights.ts`), and `need()` keeps only
   `{ fresh }`. What each account has is still worked out from its role and scope
   (`rightsOf`: manager everything, member files, media, subdomains, forms, responses,
   comments, protected; kept files, media, forms, responses, comments). The snapshot gets two
   columns, what each route needs and who that lets in (A/M/K). Activity opens to everyone for
   their own lines (R7, momolig 2026-09-24: pammy.org gets it now). Two changes in who reaches
   what, both meant, and nothing else (checked route by route against the levels before):
   - `GET /api/activity`: kept accounts too, for their own lines (members saw everyone's
     before; now their own);
   - `GET /api/api-keys`: account managers only. Members could read the list but never make or
     revoke a key. With no "see" level (Q1) the page is the `programs` right, and the menu
     leaves it out for others.
2. **R4 + R5 + R7 + R8**: the two tables and core migration 0001. Rights and places decide,
   Activity opens to everyone for their own lines, and `/api/me` returns rights and places, which
   the menu follows. `LIMITED_ROUTES` goes, and `users.scope` is still written (R9).
3. **R1 + R6**: the Accounts page (rights, places, invites with rights), the glossary's
   "admin", and Activity lines for rights and places changes.
4. **R9**: drop `users.scope` (a small release of its own, once step 3 has run).

## Step 2, as built

- **Tables** (`packages/core/migrations/0001-rights.sql`): `panel.user_rights (user_id, name)`
  (the column is `name`: `right` is a word Postgres keeps for itself) and
  `panel.user_places (user_id, place)`, both going with the account. Which right names exist is
  the code's list (`RIGHTS`), so a module bringing a new right needs no migration: the check
  keeps out only what could never be a name, and a name the code doesn't know is ignored. A
  place is `/<folder>`: never `/`, nothing deeper, nothing starting with a dot.
- **R8**, checked three ways: the migration test (`test/pg.test.ts`) writes the four kinds of
  account the old way and reads them back the new way; the route list's A/M/K column is worked
  out from the rights now and is what it was for all 483 routes; and verify checks, on the live
  data, that every account has exactly what its kind always had.
- **Who reaches what** is `mayUse(person, needs, wholeSite)` (core/panel/rights.ts), from the
  rights and places read with the session on every request, so a change works on the person's
  very next request. `LIMITED_ROUTES` is gone.
- **`wholeSite`**: a route about the whole website says so in its config
  (`{ needs: 'forms', wholeSite: true }`), and a person kept to places never reaches it,
  whatever their rights. Five routes: `GET /api/folders`, the form examples (3) and
  `POST /api/forms/:id/scope`. The last already refused them inside the route; now the route
  list says so too (the one line of the list whose "who" changed: AMK to AM, reach unchanged).
- **The parts that know places** (`PLACE_RIGHTS`): files, media, forms, responses, comments. A
  person with places reaches no other part, whatever is written for them. **Subdomains and
  protected folders** are in R5's list of parts that can be given to a person with places, but
  they can't tell a place yet: they learn it in **step 3**, before the Accounts page can give them.
- **Several places**: every check that took the one folder takes the list. Files, media, tags,
  the editor's preview and the gate's forms (the panel now sends `places: [...]`, not `scope`;
  the gate refuses an empty list, `/` or a deeper path rather than reading them as "everything").
  With several places and nothing asked, a list shows all of them; a new form must say which
  of them it works in (with one place it is that one, as before).
- **Refusals**: a person with places gets 404 for what they can't reach, as before; anyone
  else gets 403 as before (R4's "404 for everyone" waits for step 3, with the pages).
- **Until step 3** the old controls keep working and give what they always gave: a new
  account and a demoted manager get what members have; "Sees only <folder>" writes that one
  place (and `users.scope`) and the five folder parts; "Sees everything" gives the member parts
  back. A manager has no rows.
- **The web** follows `/api/session`'s `rights` and `places`: every page and menu item names the
  part it is in (`needs`, and `wholeSite`), in place of `manager` and `limited`. The web keeps its
  own copy of the list (it can't import the server's); `test/routes.test.ts` keeps the two equal.
- **Command line**: `pammy-panel users` shows each account's places and rights.
- **R9, corrected**: keeping `users.scope` does *not* let the release before step 2 run on
  the migrated database. Any older release refuses a schema with a migration it doesn't know
  (checkSchema), so going back over core/0001 is always the installer's way: restore the dump
  it took, then install the older release. The column stays anyway (it costs nothing, and it is
  what verify compares the new rows with until step 3), and goes in step 4 as planned.
- **For step 3**: the gate's admin ignores a `scope` it no longer reads, and no `places` means the
  whole site, so an out-of-date caller gets a manager's answer (verify's two checks did, at the
  first install). The gate should refuse a request that still carries `scope`.

## Step 3, as built

Decided with momolig 2026-09-25: someone kept to places handles only **their own** people (below),
and admins stay **command line only** (`sudo pammy-panel role <user> manager`), so a stolen
sign-in can't make more of them.

- **Accounts page** (core/web/pages/Accounts.tsx): each row shows the parts a person has, or
  "nothing to use yet"; "What they can use" opens one dialog with **Where** (the whole site, or
  only some folders, ticked) and **What they can use** (a switch per part the site's modules
  bring). With folders chosen, databases, API keys, installed software and examples are greyed
  out with the reason. "Add an account" has the same picker; a new account has **nothing** until
  given (R6), and the command line's `add-user` makes one with nothing too.
- **API**: `POST /api/users/:id/access { rights, places }` replaces `/scope`; `POST /api/users`
  takes the same. `cleanAccess` checks the shape and refuses a kept person with a part outside
  `PLACE_RIGHTS` (409); the route checks every place is a folder at the top of the website
  (404, nothing written). `setAccess` writes only what changed, with one Activity line each:
  `user-rights-changed` ("forms: on, media: off") and `user-places-changed` ("places: /olivia,
  /recipes" or "places: none (the whole site)"). Nobody is signed out: it works on their next
  request. `users.scope` gets the first place (byte order) until step 4. Command line:
  `pammy-panel access <user> <right,...>|none [<folder> ...]` replaces `scope`.
- **Refusals are 404 for everyone** (R4): a part a person doesn't have, the uploads included.
  403 is left for "confirm with your passkey" and a wrong origin.
- **Subdomains know places**: a kept person sees only the folders that are their places and
  changes only those folders' temporary home pages; making, trashing and restoring a folder at
  the top are `wholeSite` (the route list: `POST /api/sites`, `/trash`, `/restore`).
- **Protected folders know places**: the areas inside their places, the requests about those
  areas, and the people (visitors) who open at least one of them, each with only their areas
  listed. They protect folders inside their places, give and take access to their areas for
  people they see, and add people only with at least one of their areas. Changing a person
  (link, password, rename, contact, switch off, sign out, remove) needs **every** area that
  person opens to be theirs; otherwise 409, and the People page hides those buttons ("also opens
  other folders"). Taking someone's last area of theirs away drops them from their list, and the
  page asks first. `GET /api/protected` now brings `folders` and `reserved` itself, so the page
  needs neither Files nor Subdomains.
- `PLACE_RIGHTS` is now files, media, subdomains, forms, responses, comments, protected (the web
  keeps a copy; test/routes.test.ts keeps it equal). The route list's who-column has a fourth
  account, **P**: kept to two places with every part it can have.
- **The gate refuses `scope`** (any request carrying it: `invalid`), rather than ignoring it and
  answering for the whole site. Verify checks it live.
- **Glossary**: `words.admin` ("account manager" on pammy.org, "admin" on lfdln) on the Accounts
  and Activity pages; the full pass over every page stays phase 8.
- **Help**: a kept person also gets guides 06 and 09 when they have subdomains or protected.
  Guides 08 (Accounts) and 11 (one folder) say how it works now.
- **Verify**: the step 2 check "every account has what its kind always had" can't hold once
  rights are chosen; it is now "someone kept to places has only place parts, and users.scope
  says their first place", plus the gate's refusal of `scope`.

## Step 4, as built

- **Core migration 0002** (`packages/core/migrations/0002-drop-users-scope.sql`) drops
  `panel.users.scope`. First it checks that every scope still written is one of that person's
  places. If one isn't, it stops and names them, and nothing is dropped. Step 3 always wrote the
  first place, so on pammy.org this finds nothing.
- `setAccess` no longer writes `scope`, and `UserRow` loses the comment about it. Nothing read the
  column after step 2.
- Old Activity lines `user-scope-changed` still read as before. The Activity page keeps their words.
- **Tests**: pg.test runs core 0001 on its own (`coreUpTo`) the way step 2 left the database, and a
  new test covers 0002 both ways: it refuses while out of step, and in step it drops the column
  and keeps every place. The schema snapshot loses `scope text`.
- **Verify**: the places check no longer compares `users.scope`. A new check confirms 0002 ran and
  the column is gone.
- **Rollback**: going back to a2ef508c means restoring the dump the installer takes first,
  because step 3's code writes `scope` and checkSchema refuses an unknown migration (R9 correction).

## Decided (momolig, 2026-09-24)

- **Q1. No "see" level**: a right is on or off.
- **Q2. Activity**: a non-admin sees what they themselves have done; admins see everything.
- **Q3. Places**: a person sees only the hosts (places) they have, in every part they have.
- **Q4. Databases belong to a host**, later (phase 8).
- **Q5. Pamela gets an account on lfdln** (made from the panel in phase 5).
- **Q6. Left to Claude**: `users.scope` is dropped one release after step 3 (R9).
