# Roles and privileges for visitors: People, Access, Requests

Status: **decided 2026-09-26**; steps 1-5 built and live 2026-09-26 (see "Step 1 as built" to "Step 5 as built"); step 6 built (see "Step 6 as built", and "Turning it on"). Decisions R1-R12 by momolig (2026-09-26, in
conversation); Q1-Q4 decided as suggested (below). Asked for by momolig because Placement Exam Prep
(`NEXTJS-PLAN.md`, branch `nextjs`) needs guests *and* signed-in people on the same pages, and the
same model should serve many more apps. **Replaces step 5 of docs/accounts-plan.md** ("Open with
accounts" areas); accounts steps 1-4 stand and land in the People module.

What this is for: today a visitor either may open a protected folder or may not (`gate.grants`).
That is two roles, fixed. Exam prep has two different ones (a guest who can practise, a
signed-in person whose progress is kept), a teacher would be a third, and every later app will
want its own. After this plan an account exists once, and **each area it is given gets a role**;
a role is a set of **privileges** the area declares; the gate tells an app which privileges the
person has, and the app honours them.

**Panel users are not part of this** (R5): owners, admins and their rights and places
(docs/permissions-plan.md) stay as they are. This is about visitors only.

## Decided (2026-09-26)

| # | Decision |
|---|---|
| R1 | **Split `areas` into three modules**: **People** (accounts), **Access** (areas, roles, privileges), **Requests**. Email and the visitor switches move to a new **Settings** module; mail *sending* stays `@panel/mail`. |
| R2 | **One role per person per area.** |
| R3 | **Combined roles**: a role made of other roles; its privileges are theirs together. Only allowed combinations. |
| R4 | **Built-in role sets can only be copied**, never changed in place. |
| R5 | **Panel users do not move to this model.** |
| R6 | A **privilege** is an **action on a resource, in a scope**: `resource.action`, with `:own` or `:any` where the resource has an owner. Actions are read / create / update / delete **plus the app's own verbs** (`submit`, `grade`, `approve`, ...). |
| R7 | Scopes are **`own` and `any`** only, for now. `:any` covers `:own`. |
| R8 | Three layers: **privileges** (the atoms) → **groups** (plain-language bundles) → **roles**. Owners work with **both** groups and single privileges. |
| R9 | Privileges need **an interface** (the Access page), not only a file. |
| R10 | An app declares its privileges, groups and built-in roles in **`pammy-panel.json`**. |
| R11 | **Allowed combinations**: the manifest names roles that can never be combined; owners may add more pairs. |
| R12 | **Path rules** (a sub-path needs a privilege) come later, not in this plan. **Owners can't add privileges to an area whose app ships a manifest** (nothing would honour them). |

Names (left to Claude): the code keeps **area**; the panel says **Access**. The app gets the
role's name for display and the expanded privileges to check.

## What there is today (checked 2026-09-26)

- `packages/areas` holds everything about visitors: accounts (`gate.visitors`, `sessions`,
  `links`), protected folders (`gate.areas`: `path`, `token`, `requests_open`), who may open what
  (`gate.grants`: visitor, area), requests (`gate.requests`: `access` / `reset`), and since
  accounts step 1 (98dfbcd) `gate.visitor_settings` and its page. Pages: People, Protected
  folders, Requests, Visitor settings.
- The gate keeps each session's grants in memory (`packages/core/src/gate/live.ts`: `Access` =
  visitor + `grants: Set<areaId>`); `policy.ts` decides on the real folder on disk. Nothing on a
  public page waits for Postgres (P14).
- **Other modules already use "may open this area" to mean "may do X"**: Studio's visitor writes
  (`panel.studio_resources.visitor_area` + `visitor_owner`: anyone who may open that area may
  write rows, their own when an owner column is set); forms, comments and the media API read the
  visitor from the gate. Every one of them imports `@panel/areas`.
- Headers the gate already sets: `X-Pammy-User`, `X-Pammy-Name`, `X-Pammy-Base`, `X-Pammy-Uri`,
  `X-Pammy-Login`, `X-Pammy-Next`, `X-Pammy-Cache`.

## The model

### Areas

An area is **anything people can be given**: a protected folder (today), a folder or route "open
with accounts", an app such as exam prep (a route to a service or project), and later a Studio
table with visitor writes. `gate.areas` gains `kind` (`folder` | `route`) and a target (the
folder's path, as now, or the hosts module's route id). An area has **one role set** in use.

### Role sets

Every area has **two fixed slots** and any number of named roles:

| Slot | Protected folder (pammy.org today) | Open with accounts | Exam prep (its manifest) |
|---|---|---|---|
| **Not signed in** | nothing | `pages.read` | Practise |
| **Signed in, no role given** | nothing | → Member | → Student |
| named roles | **Member**: `pages.read` | **Member**: `pages.read` | **Student**: Practise, Keep progress; **Teacher**: + See others |

- A slot holds a set of privileges ("not signed in") or points at a role ("signed in, no role
  given"), or is empty (nothing).
- "Signed in, no role given" is why exam prep needs no row per person: every account counts as a
  Student until someone gives it another role. pammy.org leaves it empty, so registering never
  opens a folder (accounts plan Q3, now a setting).
- **Built-in sets** (R4): *Protected folder*, *Open with accounts*, and each manifest's own.
  They show a lock and **Copy to change**; a copy belongs to the area and the owner edits it.
- **Combined roles** (R3): list two or more plain roles (not combined ones, so no loops); worked
  out live, so changing Student changes every combined role with Student in it. A pair on the
  "never together" list (R11) can't be saved.

### Privileges

- Key: `resource.action` or `resource.action:own|:any`. Resource and action: lowercase words with
  hyphens (`^[a-z][a-z0-9-]{0,31}$`). At most **100 privileges per area** (the header, below).
- `pages` is built in on every area, action `read`: nginx serves the pages or doesn't. The gate
  enforces it. Every other resource is the app's, and the **app** enforces it; the gate only
  passes the keys on.
- **Where they come from**: a manifest (read-only in the panel, R12), the panel's own features
  (built in), or the owner (areas with no manifest: a PHP folder, a project written in the panel).
- **When a manifest changes**: a new privilege is off in every owner-made role; a removed one
  leaves every role, and Activity says which. A removed role: its people fall back to "signed in,
  no role given", and Activity lists them. A manifest that doesn't pass the checks is refused
  whole and the last good one stays (the page says why).

### Memberships

`gate.memberships (visitor_id, area_id, role_id)`, one row per person per area (R2), replacing
`gate.grants`. Every grant today becomes **Member** of the built-in *Protected folder* set: the
gate gives the same answers, and pammy.org's verify must pass unchanged.

### What the app receives

nginx asks the gate (`auth_request`, as for protected folders), **clears these headers from the
client's request first**, and passes the gate's answer on:

```
X-Lfdln-Account: 42
X-Lfdln-Username: ana
X-Lfdln-Role: Student
X-Lfdln-Privileges: pages.read questions.read attempts.create:own attempts.read:own progress.update:own
```

- The prefix comes from the site profile (`X-Lfdln-` on lfdln, `X-Pammy-` on pammy.org, next to
  today's `X-Pammy-User`).
- Signed out: account and username empty, role `Not signed in`, privileges = that slot's.
- **Apps check privileges, never role names** (a copied or combined role must work in an app that
  never heard of it): `can('progress.update', row.owner)` passes with `progress.update:any`, or with
  `:own` when the row's owner is `X-Lfdln-Account`.
- 100 keys × 64 characters is under 7 KB; the gate's nginx include sets `proxy_buffer_size 16k`
  for its `auth_request` location so a full answer is never cut.
- PHP pages get the same through the gate's PHP door (accounts plan Q7).

## `pammy-panel.json`

At the **root of the app**: the site folder's top, or the project's source root (a service
adopted by hand names its file in the services record). nginx never serves it (denied like
`.pammy-protected`). The panel reads it when the area is made and when the owner presses **Read
again** (projects: on every deploy).

```json
{
  "version": 1,
  "name": "Placement Exam Prep",
  "resources": {
    "questions": { "label": "Questions", "actions": ["read"] },
    "attempts":  { "label": "Tries at an exam", "owned": true,
                   "actions": ["create", "read", "update", "submit"] },
    "progress":  { "label": "Saved progress", "owned": true,
                   "actions": ["read", "update", "delete"] }
  },
  "actions": {
    "submit": { "label": "Hand in" }
  },
  "groups": {
    "practise":      { "label": "Practise",
                       "privileges": ["pages.read", "questions.read", "attempts.create:own",
                                      "attempts.read:own", "attempts.update:own", "attempts.submit:own"] },
    "keep-progress": { "label": "Keep progress on any device",
                       "privileges": ["progress.read:own", "progress.update:own", "progress.delete:own"] },
    "see-others":    { "label": "See other people's progress",
                       "privileges": ["progress.read:any", "attempts.read:any"] }
  },
  "roles": {
    "student": { "label": "Student", "groups": ["practise", "keep-progress"] },
    "teacher": { "label": "Teacher", "groups": ["practise", "keep-progress", "see-others"] }
  },
  "slots": { "notSignedIn": { "groups": ["practise"] }, "signedIn": "student" },
  "neverTogether": []
}
```

Checks: every key well formed; `owned` resources' privileges carry a scope and others don't;
every group, role and slot names things that exist; no more than 100 privileges; at most 64 KB.
`pages.read` needs no declaring.

## The Access page

Access → an area, four tabs (a list of pages on phones, each role its own page, as Forms).

1. **Privileges**: resources with their actions and scopes. Manifest and built-in ones read-only
   ("from pammy-panel.json"); on an area without a manifest, **+ Add a resource** (name → key,
   tick read / create / update / delete, **+ Own action**, **Has an owner** for own/any). A
   privilege a role uses can't be removed until it's out of that role (the page lists them).
2. **Groups**: plain-language bundles; open one for a checklist of privileges under resource
   headings, in words ("Tries at an exam: hand in (their own)").
3. **Roles**: the two slots at the top, then the roles. A role: groups as switches, then **Extra
   privileges** (atoms no ticked group covers), then a summary line of what it can do. Combined
   roles pick roles and show the union. Built-in set: lock + **Copy to change**. **Never
   together**: the manifest's pairs (locked) and the owner's.
4. **People**: who has which role, a role picker each; "Anyone signed in counts as Student";
   requests for a role with Approve (pick the role) / Decline.

**pammy.org** (A5): roles and privileges are behind a Settings switch, **off by default**. Off,
the Access page is today's Protected folders page with the words it has now; nothing about
roles shows. Pamela's folders keep working exactly as now either way.

## The modules

| Package | Holds | Needs |
|---|---|---|
| `@panel/people` | `gate.visitors`, `sessions`, `links`; sign in/out, the built-in pages, register, confirm, reset, account page, delete (accounts steps 2-4); the People (Users) page | core, mail |
| `@panel/areas` (**Access**) | `gate.areas`, role sets, privileges, groups, memberships; `policy.ts`; the identity headers; `pammy-panel.json` reader; the Access page | core, people |
| `@panel/requests` | `gate.requests`: ask for access (now: for a role), resets by hand while emailed links are off; the Requests page | core, people, areas |
| `@panel/settings` | the Settings page: Email (from `@panel/mail`'s page), the visitor switches (from accounts step 1), the roles switch | core, mail |

Forms, comments, files and Studio import **people** for who is signed in and **areas** only where
they check an area. The module names in the profile follow (`MODULES` gains `people`,
`requests`, `settings`); pammy.org switches all of them on and sees no change but the menu (Email
under Settings).

## Steps

Each step is one release (build.sh, the installers, verify) and pammy.org's verify must pass
unchanged unless the step says otherwise.

| Step | What | Risk |
|---|---|---|
| 1 | **The split**: `@panel/people`, `@panel/requests`, `@panel/settings` cut out of `areas` and `mail`; imports moved; menu: Settings (Email, Visitors). No schema or behaviour change (routes snapshot moves packages only). | medium: many imports move; the tests are the net |
| 2 | **Roles under the hood**: `gate.roles`, `role_privileges`, `memberships` (+ slots on `gate.areas`); the built-in *Protected folder* set; grants copied to memberships as Member; the gate's `Access` holds area → role → privileges; `grants` kept read-only one release, then dropped. Same answers everywhere. | medium: who may open what |
| 3 | **Privileges**: resources, actions, groups, never-together; the `pammy-panel.json` reader and its checks; the identity headers with the profile's prefix, stripped from clients; `proxy_buffer_size`. Tested with a fixture app. | medium |
| 4 | **The Access page**: four tabs, copy a built-in set, combined roles, People tab; the Settings switch (off on pammy.org). Browser tests desktop + phone. | low |
| 5 | **Areas on routes** (was accounts step 5): `kind = route`, *Open with accounts* built-in set, `auth_request` on a hosts route, signed-out passes; requests ask for a role. After accounts steps 2-4. | medium: nginx for live hosts |
| 6 | lfdln switches it on (with accounts step 6); a test host with a fixture app; verify-lfdln: headers can't be forged, a guest gets the "not signed in" privileges, a role change reaches the app within the cache time. Exam prep's `pammy-panel.json`. | low |

### Step 1 as built (2026-09-26)

- **New packages**: `@panel/people` (panel `/api/visitors*`, gate `/_pammy/me`, `login`,
  `logout`, `invite/check`, `invite`; the People page), `@panel/requests` (panel
  `/api/requests*`, gate `/_pammy/forgot`, `/_pammy/request`; the Requests page),
  `@panel/settings` (the Email page and its `/api/mail*` routes from `@panel/mail`; the visitor
  switches' page and `/api/visitor-settings` from `@panel/areas`). `@panel/mail` keeps sending,
  its helper and notices.
- `@panel/areas` keeps Protected folders (`/api/folders`, `/api/protected*`, gate
  `/_pammy/folder`, `/_pammy/about`), `policy.ts`, the `<pammy-login>` widget, and two shared
  pieces: `gate/targets.ts` (which protected folder a page belongs to) and
  `panel/visitors.ts` (what an account kept to places may see and change, and setup links).
- **Direction, for now**: people and requests depend on areas (`NEEDS`: people → areas,
  requests → areas), not the other way round as the module table above says: today a sign-in is
  always to a protected folder, and the People page's add-a-person form is the Protected folders
  page's too. Accounts step 4 (signing in anywhere) and step 2 here turn it round.
- Modules `people`, `requests`, `settings` (pammy.org: all on; lfdln: none). A Settings part
  shows only with its own module on too (`settings+mail`, `settings+areas`). Rights unchanged
  (Email still needs `software`; visitor settings `visitor-settings`, now named under module
  `settings` on the Accounts page).
- Menu: **Settings** group (Email, Visitors) after Visitors; Email left the Software group;
  Requests stays in Inbox. Routes: the same set, only their order in the gate's list changed.
- Tests: unit 1050/1050, browser 116/116 (the menu order, and Settings > Visitors).

### Step 2 as built (2026-09-26)

- **Migration `areas/0002-roles.sql`**: `gate.role_sets` (built-in ones have a `key`),
  `gate.roles` (key, label; `slot = 'not-signed-in'` marks that fixed slot, one per set),
  `gate.role_privileges` (the key format of R6/R7 as a check), `gate.memberships`
  (visitor, area, role; one per person per area). The built-in set **Protected folder**:
  *Not signed in* (nothing) and *Member* (`pages.read`); its signed-in slot is empty.
- **The slots live on the role set, not on `gate.areas`** (the table above said areas): a
  built-in set brings its slots with it. `role_sets.signed_in_role_id` is the "signed in, no
  role given" slot; the not-signed-in slot is a role row that is never given to anyone.
- `gate.areas.role_set_id`, default `gate.built_in_set('protected-folder')`, so every folder
  made the way it is today gets the built-in set. Memberships carry the set's id, and two
  composite keys make sure the role is one of *that area's* set's roles.
- Every grant was copied to a membership as Member, with its date. `gate.grants` stays one more
  release **read-only** (the gate may only read it; deleting a person or folder still cascades
  to it) and nothing reads it; step 3 drops it.
- The gate: `rolesOf(visitor[, area])` works out each area's role (given, else the signed-in
  slot) and its privileges; a session keeps `roles` (area → role, privileges) and `opens`
  (areas with `pages.read`) in place of `grants`. The policy, the folder check, sign-in and
  Studio's visitor writes ask `opens`. The panel's `grant` op now gives or takes away Member
  (`setMember`); the admin listing reads memberships with `pages.read`. No change for the
  panel or visitors.
- Tests: the migration copies grants and leaves them read-only; memberships refuse a role
  from another set and a second role in one area; privilege keys are checked; a session
  follows a set's signed-in slot, and a role given there wins over it. verify-panel: every
  area on the built-in set, the set's roles and privileges, every grant a Member, the gate
  can't write `grants`.

### Step 3 as built (2026-09-26)

- **Migration `areas/0003-privileges.sql`**: `gate.grants` dropped. A set gains `resources`
  (key, label, `owned`) with `resource_actions`, `actions` (the app's own verbs and their
  words), `groups` with `group_privileges`, `role_groups` (a role's groups, from its own set),
  `never_together` (`from_manifest` marks the manifest's pairs), and the last good manifest
  (`role_sets.manifest`, `manifest_read_at`). The view `role_all_privileges` is a role's own
  privileges plus its groups'; the gate and the panel's lists read it. Privilege keys stay
  text: which ones a set may use is checked where they're written (the reader now, the Access
  page in step 4).
- **`@panel/areas/manifest`**: `checkManifest(text)` makes every check above (well-formed
  keys, scopes only on owned resources, actions declared, groups and roles and slots name
  things that exist, labels 1-80 characters and no two roles with one label, at most 100
  privileges, 64 KB, nothing it doesn't know) and lists the problems in words.
  `applyManifest(db, now, 'app-<name>', text)` makes or brings up to date that app's
  built-in set in one transaction: roles are kept by key (so people keep them), a role that
  went sends its people back to "signed in, no role given", and the report lists them and
  the privileges that went, for Activity. A file that fails changes nothing. Only `app-` keys:
  it can never touch *Protected folder*.
- **What the app receives, on pammy.org today**: a PHP page in a protected folder gets
  `PAMMY_ACCOUNT`, `PAMMY_ROLE` and `PAMMY_PRIVILEGES` (space-separated, sorted) beside
  `PAMMY_USER`, from the gate's answer for the **innermost** protected folder. The same names
  sent as headers never reach PHP (`HTTP_X_PAMMY_*` set empty). The check location has
  `proxy_buffer_size 16k` (and `proxy_buffers 4 16k`, which nginx requires with it).
- **Not here, and why**: the profile's header prefix (`X-Lfdln-`) waits for step 5, the
  first place nginx hands headers to an app behind a route; on pammy.org the only reader is
  PHP, and its names stay `PAMMY_*`. Nothing calls `applyManifest` from the panel yet (step 4's
  **Read again**, step 5's areas on routes).
- Tests: the manifest checks (the plan's exam prep example, and one refusal per check);
  applying it (slots, a role given, the same file again, a role and group removed, a bad file
  changes nothing, `protected-folder` refused); the gate's answer for nested folders on
  different sets; real nginx and PHP (the values arrive, forged headers don't). verify-panel:
  `gate.grants` gone, every membership a Member, the buffer size; PHP told its role through
  Cloudflare.

### Step 4 as built (2026-09-26)

- **The switch**: Settings > Visitors gains "Roles and privileges on the Access page"
  (`visitor_settings.roles`, off). Off, nothing changes: the Protected folders page is as it
  was, the Access page only says how to turn them on, and the gate refuses every change.
  It can be turned **off again only once every folder is back on the built-in roles**, so
  nothing the page can't show stays in effect. verify-panel reports it either way.
- **Migration `areas/0004-access.sql`**: a copy's `area_id` and `copied_from` (one copy per
  area), `role_parts` (combined roles), `role_all_privileges` now adds a combined role's
  parts', the memberships' keys deferrable (a folder and its people move sets in one
  transaction), and the switch.
- **The gate** (`@panel/areas/gate/access`, admin ops `access.*`): copy to change and back
  (people matched by role key; the rest listed), resources and actions (not under a
  manifest: R12), groups, plain and combined roles (parts are plain roles, never a
  never-together pair), the signed-in slot, never-together pairs (the manifest's locked),
  a person's role, and Read again (`pammy-panel.json` at the folder's top puts the folder on
  `app-folder-<id>`). Deleting a role moves its people or takes their role away (Q2), and
  waits while it's part of a combined role or the signed-in slot.
- **The not-signed-in slot works**: with "Open the pages" in it, the folder is open to
  anyone (the gate knows it from memory, like the folders themselves, so it never waits for
  Postgres), and its pages get `PAMMY_ROLE` "Not signed in" and that slot's privileges.
  Anyone signed in gets those privileges too, beside their role's.
- **The page**: Protected folders links each folder to **Access to <folder>** (with the
  switch on). Tabs Roles, People, Groups, Privileges (a 2 x 2 grid on phones). Privileges
  are shown in words ("Notes: change (their own)"). The menu keeps "Protected folders".
- Activity words for every change (`roles-copied`, `role-saved`, `person-role`, ...).
- Tests: gate (every change and refusal above, 9), gate check (a folder opened by its slot),
  panel API (switch off/on, copy, a role, a person, back, Activity), browser desktop + phone.

### Step 5 design (2026-09-26)

What step 5 needs, worked out from the code as it stands (steps 1-4 here, accounts 1-4 live):

- **S5-1 A route area.** `gate.areas` gains `kind` (`folder` | `route`), `route_id` (the hosts
  module's `panel.routes.id`; no key across schemas: the gate's role can't read `panel`) and
  `label` (the route's address, for the panel's lists). A route area's `path` is
  `/route/<id>`: a folder's path never starts with `/`, so no folder lookup can find it.
- **S5-2 The built-in set *Open with accounts*** (`open-with-accounts`): *Not signed in* opens
  the pages (`pages.read`); *Member* opens the pages; "signed in, no role given" is Member.
- **S5-3 Accounts on a route**: on the Hosts page a route is **Open to anyone** (as now),
  **Open with accounts** (the set above: everyone gets in, the app learns who is signed in;
  needs the `openAreas` switch) or **Only people let in** (the *Protected folder* set). The
  gate keeps the area; the route keeps its token (`panel.routes.area_token`), so the
  routing helper never has to ask the gate. A token the gate doesn't know answers 403:
  fails closed.
- **S5-4 nginx**, rendered by the routing helper, and only on a host with such a route:
  `auth_request /_pammy/check/<token>` in the route's location (inherited by the
  locations inside it), the answer's identity passed on as `X-Lfdln-Account`,
  `-Username`, `-Role`, `-Privileges` to a service, and as `LFDLN_ACCOUNT`, `_USERNAME`,
  `_ROLE`, `_PRIVILEGES` to PHP in a site folder; 401 → the sign-in page; `/_pammy/` on
  that host goes to the gate (sign-in, register, account pages). **Every** service route,
  with accounts or not, clears the four headers from the visitor's request, so an app
  can't be fooled by a route that has none (this changes the live hosts' files by four
  lines each, nothing a visitor sees). A route at `/_pammy/` can't have accounts.
- **S5-5 The gate's `/check/<token>`**: the area from memory; open to anyone: 204 with who
  is signed in (if anyone), without waiting for Postgres when nobody is; otherwise the
  session's role, as for a folder. Not allowed: 401 and the built-in sign-in page for that
  area. A folder's `/check` is unchanged.
- **S5-6 Nothing is lost by accident**: a route, host or site folder whose route has
  accounts can't be deleted until the route is back to "Open to anyone" (which deletes the
  area and its people's roles there, and says how many).
- **S5-7 Requests ask for a role**: approving an access request gives the role picked
  (any named role of the area's set; with the roles switch off, only Member exists to pick).
- **S5-8** `openAreas` joins `BUILT`. pammy.org: no hosts module, so no route area, and its
  nginx never asks `/check/<token>`: verify unchanged.
- **Not in step 5** (step 6): lfdln's People, Access and Settings pages in its menu; a
  route's `pammy-panel.json` (exam prep's).

### Step 5 as built (2026-09-26)

- **Migrations** `areas/0005-route-areas.sql` (`kind`, `route_id`, `label`; a check that a
  route area's path is `/route/<route_id>` and a folder's never starts with `/`; the
  *Open with accounts* set) and `hosts/0003-route-areas.sql` (`routes.area_token`,
  `routes.accounts`: `open` | `private`, both or neither).
- **The gate**: `@panel/areas/gate/route-areas` (`setRouteArea`: make, move between the two
  built-in sets keeping people by role key, or take away and list whose role went; a route
  on roles of its own must go back on the Access page first); admin op `route-area.set`;
  `GET /check/<token>` (answers before Postgres is reached, from the saved areas; on an
  open route a session it can't check just now counts as not signed in). A route's area is
  never found by a folder path (`byPath` leaves it out), has only the built-in sign-in
  pages, and a sign-in to it goes back to `next`, else the host's top. The roles switch and
  "Open with accounts" can't go off while a route needs them (the refusal names it).
- **The routing helper** (`render.ts`): a route with accounts gets `auth_request
  /_pammy/check/<token>`, the answer kept in `$lfdln_*`, `error_page 401 = @lfdln_login`
  (in its sign-in paths' locations too); the host gets `/_pammy/check/` (internal),
  `/_pammy/` (to the gate) and `@lfdln_login`. Folder routes add `Cache-Control
  $lfdln_cache` (not on the paths cached for good). The site's identity word is the
  profile's `hosts.identity` ("Lfdln"); the gate's address comes from `services.gate`
  when `areas` and `people` are on.
- **The panel**: `POST /api/routes/:id/accounts` (`hosts` right; on: the area, then nginx,
  undone if nginx refuses; off: nginx, then the area); `/api/hosts` says whether "Open with
  accounts" is on; the Hosts page's route line has an **Accounts** choice (folder and
  service routes). Activity `route-accounts`.
- **Requests** (S5-7): with roles on and more than Member in the area's set, `/api/requests`
  lists the roles and approving takes `roleId` (checked before anyone is made).
- **Checks**: `test/route-areas.test.ts` (the gate), `test/hosts.test.ts` (the renderer),
  `test/hosts-panel.test.ts` (the panel, with a real gate admin door),
  `test/panel.test.ts` (approving with a role), `test/run-route-accounts-nginx-test.sh`
  (real nginx, a stand-in gate and app: forged headers never reach the app, nested
  locations and sign-in paths ask too, the gate down fails closed). verify-lfdln: a
  throwaway host with *Only people let in* through the real gate, the gate's route areas =
  the routes' tokens = what nginx asks about, every service location sets the four headers
  itself, an unknown token 403. pammy.org: nothing changes (no hosts module).

### Step 6 design (2026-09-26)

- **S6-1 lfdln's menu**: modules `requests` and `settings` join lfdln's profile. New groups
  **Visitors** (People, Requests) and **Settings** (Visitors); no Protected folders page
  (lfdln's accounts are on routes). The Hosts page's route line links a route with
  accounts to its **Access** page (`/access/<area>`). The rights `protected` and
  `visitor-settings` show on lfdln's Accounts page.
- **S6-2 lfdln's panel** registers the People, Access, Requests and visitor-settings
  routes, and talks to `lfdln-mail` (so Settings > Visitors knows its mail is set up).
- **S6-3 Read again on a route**: a folder route reads `pammy-panel.json` at its site
  folder's top (the folder helper); a service route reads the file its services record
  names (the services helper's new `manifest` op, 64 KB at most). The set's key is
  `app-route-<area>`. No folder route ever serves a `pammy-panel.json` (404), and a
  route's app set goes with its area.
- **S6-4 Exam prep**: `web/pammy-panel.json` (Student and Teacher, as in this plan's
  example); its installer copies it to `/etc/lfdln-projects/examprep/pammy-panel.json`
  (root 644), which the services record names.
- **S6-5 Switching on** stays momolig's (A5), in the panel: Settings > Visitors (emailed
  links, registering, changing and deleting one's own account, "Open with accounts",
  roles); then Hosts: exam prep's route **Open with accounts**, its Access page **Read
  again**. Nothing is switched on by the installer.
- **S6-6 verify-lfdln**, live: a throwaway host with a PHP page that prints what it is
  told; signed out, the sign-in page; a visitor given Member and a session: the page gets
  `LFDLN_*` from the gate, never the headers sent; their role taken away: the sign-in
  page on the very next request; then everything removed. `pammy-panel.json` is never
  served.

### Step 6 as built (2026-09-26)

- **lfdln**: modules `requests` and `settings` on; its panel registers the Access, People,
  Requests and visitor-settings routes and talks to `lfdln-mail`; menu groups **Visitors**
  (People, Requests) and **Settings** (Visitors). `/access/:id` and `/access/:id/:tab`
  are now pages of the server on both sites (a reload of an Access page was a 404 on
  pammy.org since step 4).
- **Hosts page**: a route with accounts shows **Who may use it**, its Access page, which
  says "route" and goes back to Hosts.
- **Read again on a route** (`accessRoutes(..., { manifestOf })`, lfdln's `routeManifest`):
  a folder route through the folder helper, a service route through the services helper's
  `manifest` op (the path from `known.ts`, never written into the record). The app's set is
  `app-route-<area>`; it goes when the route is set back to Open to anyone. A route on its
  app's roles can't be moved to a built-in set from Hosts (it's left by opening it).
  "Open with accounts" can't go off while any route is open to anyone with accounts
  (built-in set, a copy, or an app's roles whose not-signed-in slot opens the pages).
- **nginx**: no folder route serves a `pammy-panel.json` (404).
- **Exam prep** (`nextjs` 1c52e94): `web/pammy-panel.json`, copied by `build.sh` into
  `release/` and by `install.sh` to `/etc/lfdln-projects/examprep/pammy-panel.json`.
- **Checks**: services (the manifest op), route-areas (an app's roles on a route: guests
  practise, anyone signed in is Student, and its set goes with the area), hosts-panel (Who
  may use it, Read again from a folder route), the route-accounts nginx test (44),
  lfdln browser tests (27: the menu, Settings > Visitors, a route's accounts and its Access
  page, the new pages on a phone). verify-lfdln: a real sign-in on the throwaway host,
  what a PHP page is told (from the gate, not the headers sent), `pammy-panel.json` never
  served, the role taken away mattering on the next request.

#### Turning it on (momolig, in lfdln's panel, after installing)

1. **Settings > Visitors**: Emailed links, then People can register themselves; change and
   delete their own account if wanted; then "Open with accounts" areas and Roles and
   privileges.
2. Exam prep: install its new release (`web/build.sh`, `sudo web/deploy/install.sh`) so
   `/etc/lfdln-projects/examprep/pammy-panel.json` is there.
3. **Hosts**: the exam prep route's Accounts → **Open with accounts**; **Who may use it** →
   **Read pammy-panel.json**. Guests practise; anyone signed in is Student; Teacher is given
   on its People tab.

Later (own plans): Studio tables, comments and forms as resources (`recipes.create`,
`recipes.update:own` in place of `visitor_area` + `visitor_owner`); path rules (R12); scopes
beyond own/any (a class, a team).

Order with the accounts plan: this step 1 before accounts step 2 (so mail-to-visitors and
register land in `@panel/people` directly); steps 2-4 here beside accounts 2-4; step 5 here
replaces accounts step 5.

## Questions (decided 2026-09-26: every suggestion)

- **Q1. A role change's delay.** A change from the panel reaches the gate at once (the `live.ts`
  reload, as grants do today); a signed-in person's next request sees it.
- **Q2. Deleting a role people hold** (owner-made). The page lists them and asks "move them to
  ..." (a role, or no role); nobody is left holding a role that no longer exists.
- **Q3. The "not signed in" slot on a protected folder.** Stays empty (nothing); giving it
  privileges needs the roles switch on, so turning a protected folder public is never one click on
  pammy.org.
- **Q4. Several areas on one app** (exam prep on two hosts). One area per route or folder; two
  routes to the same app share its `pammy-panel.json` but not their people (a later "same people
  as" link if wanted).

## With the hosts plan

docs/domains-hosts-plan.md moves pammy.org's subdomains onto hosts; its step 5 needs the gate in
host blocks, which step 5 here builds (areas on routes). So: this plan's step 5 first, then that
step.
