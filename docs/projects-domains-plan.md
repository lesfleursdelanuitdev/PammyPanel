# Projects and domains: one word for what the panel runs, on every domain

DECIDED 2026-10-06, **firm** (N-Q*, D-Q*, PD-Q* chosen by momolig; docs/master-plan.md section 2).
Analysis only, nothing built, no code yet (momolig, *"we are still doing analysis, do not start
coding"*). Order and dependencies: docs/master-plan.md section 5, Track N (that file wins on
order; this one on how a step works). lfdln; pammy.org keeps its own words (below).

momolig, 2026-10-06: *"Currently we have: hosts, projects, installed apps, services. Can we
simplify the names? How are services different from projects? We also need to make sure that
projects can live on any domain the panel manages (gonsalvesfamily.com, lesfleursdelanuit.com,
tutorlumi.com)."*

## Decided (2026-10-06)

| # | Decision |
|---|---|
| N-Q1 | **"Projects" is the general word** for everything the panel runs or serves. Phase 8b's Projects module becomes the **Code** kind. This also answers X-Q0 in docs/external-backends-plan.md (what the plans called a "managed thing" is a project). |
| N-Q2 | **Hosts become Domains**: a Domains page (domains → names → routes), and an **Addresses** tab on every project. Hosts are addresses, not things that run. |
| N-Q3 | **Services stay, as the Connected kind**; Code gets **Import an existing repository**, so exam prep can become Code. |
| N-Q3b | **Connected projects come from a root-owned file** the app's own installer writes, instead of the list in `packages/services/src/known.ts`. |
| N-Q4 | **lfdln gets the Installed kind** (WordPress, today pammy.org only). |
| D-Q1 | **Accounts on every domain.** |
| D-Q2 | **gonsalvesfamily.com is managed by hand**: new names need a DNS record at GoDaddy and a certificate made by hand. |
| D-Q3 | **Dev previews always live on lesfleursdelanuit.com** (`<name>-dev.lesfleursdelanuit.com`), whatever domain the live address uses. |
| PD-Q1 | **Words first**: the screens say Projects, Domains, Code, Installed, Connected; package names stay; package renames, if ever, through a shim like K-rename (docs/master-plan.md section 5), never in K-a / K-b (their behaviour and schema stay unchanged). |
| PD-Q2 | **Gonsalves and TutorStar stay Connected**; only exam prep moves to Code. |
| PD-Q3 | **Addresses edited in both places**: the Domains page and each project's Addresses tab. |
| PD-Q4 | **Mail goes out from the domain's own sender where it has one**: `mail.tutorlumi.com` is set up on the same Resend account (momolig, 2026-10-06), so tutorlumi.com's visitors get mail from it; other domains use `mail.lesfleursdelanuit.com`. |
| PD-Q5 | **One service user, one PHP container and one database login per Installed project.** |

## What there is today (checked 2026-10-06)

| Page (lfdln) | What it is | Who builds and runs it | Code |
|---|---|---|---|
| **Hosts** | an address (`shop.tutorlumi.com`) with routes: path → what it shows (site folder, redirect, service, project) | the routing helper writes nginx | `packages/hosts` |
| **Site folders** | files served as they are (HTML, PHP) | nginx, php-fpm | `hosts`, moving to `files` (8b-9) |
| **Services** | runs on its own: TutorStar, Gonsalves (5 parts + a migrator), exam prep | **its own repo and root install script**; the panel watches, restarts, routes, monitors, backs up. The list, Gonsalves's served folders and the backups are written in code (`packages/services/src/known.ts`) | `packages/services` |
| **Projects** (8b) | made, built and deployed by the panel from a git repo on the server: releases, roll back, dev branch, env, a database per branch | the projects helper, rootless builds, `svc-lfdln-apps` | `packages/projects` |
| **Installed software** | WordPress, installed and updated by the panel | the apps helper | `packages/apps`, **pammy.org only** (lfdln has `apps` off) |

**Services vs projects**: at run time the same thing (a container on a port behind a route).
The only difference is **who owns the source and the deploy**: a service deploys itself and the
panel adopts it; a project's repo and deploy are the panel's. Exam prep is "a project in all but
name, made by hand" (docs/phase8b-plan.md).

### Domains today

| | lesfleursdelanuit.com | tutorlumi.com | gonsalvesfamily.com |
|---|---|---|---|
| DNS | DreamHost API, `*` record | Cloudflare, `*` record | GoDaddy, unreadable, no `*` |
| Certificate | wildcard, DNS-01 | Cloudflare origin wildcard | 3 names only (apex, www, admin), webroot renewal |
| A new name works at once | yes | yes | no (by hand, D-Q2) |
| Accounts on routes | yes | **refused** | **refused** |
| Real visitor IP | yes | **no** (review S6) | yes |

- Any host on any domain can already route to a project (`project` route kind); the Projects
  page lists addresses on every domain.
- **Accounts are refused off the home domain**: `packages/hosts/src/render.ts:636`, `routes/hosts.ts:513`
  ("the site's gate answers for the home domain's hosts only").
- **New project** makes `<name>.lesfleursdelanuit.com` and `<name>-dev.lesfleursdelanuit.com`;
  it offers no other domain.

## The model

**A project** is anything the panel runs or serves. Each has a **kind**, which says where it
comes from:

| Kind | Today | Example | Comes from |
|---|---|---|---|
| **Files** | site folder | a static site, a PHP guest book | files you put there |
| **Code** | project (8b) | the party app (Next.js, Laravel) | a git repo the panel builds |
| **Installed** | installed software | WordPress | a package the panel installs and updates |
| **Connected** | service | TutorStar, Gonsalves | runs on its own; the panel watches it |

Plus **redirects**, which are routes, not projects.

**Every project has the same tabs**: Overview, **Addresses** (its routes on any domain),
**Data** (docs/external-backends-plan.md), **Backend** (docs/backend-plan.md: its data API, users,
policies, realtime, at `/_api/` on each of its addresses), **Storage** (docs/storage-plan.md:
its buckets), Health (monitoring), Logs, Backups, **Access** (accounts and roles), Events (docs/module-contracts-plan.md). Kinds add their own: Code adds
Builds, Environment and Packages; Installed adds Updates; Files adds Files; Connected adds Parts
(its units, start / stop / restart).

**The Domains page**: domains → names → routes, with each domain's abilities shown (wildcard
or by hand, accounts, Cloudflare in front). A route points at a project (any kind) or redirects.

**In code** (with phase 0, docs/module-contracts-plan.md): a **project kinds** extension point,
owned by a `projects` registry. `files`, `code` (today's `projects` package), `apps` and
`services` fill it, each giving its kind's tabs, its route target and its health checks. Route
kinds become "a project of any kind, or a redirect". Module ids in code may stay as they are at
first; only the words change (PD-Q1); a package rename, if ever, goes through a shim like
K-rename.

**pammy.org** keeps Pamela's words through the site glossary (`Words` in the profile):
"Website", "folders", "Installed software". The model underneath is the same.

## Connected projects from a file (N-Q3b)

The app's own installer, which already runs as root, writes a description where the panel looks:

```json
// /etc/lfdln-panel/connected/recipes.json   (root-owned 644, in a root-owned 755 folder)
{
  "id": "recipes",
  "title": "Recipes API",
  "user": "svc-lfdln-apps",
  "parts": [
    { "id": "api", "unit": "recipes-api", "port": 4102, "health": "/health", "controls": true }
  ],
  "manifest": "/etc/lfdln-projects/recipes/pammy-panel.json",
  "events": { "url": "/_lfdln/events" },          // where; WHICH event types: the app's pammy-panel.json (module-contracts, webhooks; provisional until C5)
  "backups": { "dir": "/var/backups/recipes", "prefix": "recipes-" }
}
```

It shows on Projects as **waiting to be connected**; an admin presses **Connect** with a fresh
passkey. Rules, checked by the services helper (root), because it can start and stop the units
named:

- only **root-owned files in a root-owned folder** are read (the same trust as editing
  `known.ts` today, which also needs root to install);
- every unit must run as the declared user, and that user must be a **service user**
  (`svc-*`), never root or a login user;
- ports in the projects range (4100-4999) or already known;
- served folders only under `SERVED_ROOTS`; the events path as in review D10
  (`^/[A-Za-z0-9/_-]+$`, built with `new URL()`, host and port checked after);
- a file that changes after Connect is shown as **changed** and its changes wait for another
  Connect (as a changed Quadlet file is flagged today).

TutorStar, Gonsalves and exam prep move to files their installers write; `known.ts` goes.

## Code: Import an existing repository (N-Q3)

New project gets a second way in: **Import**, from a git URL (with a deploy key) or a bundle.
The panel checks the kind (`package.json` / `composer.json`, Next.js, Vite, Laravel), records
how it builds and runs (the 8b kinds), copies the history into `/srv/lfdln-projects/<name>/repo.git`,
and from then on it is a Code project like any other.

**Exam prep** would move: its repo imported, its database stays where it is (the Data tab points
at it), its `pammy-panel.json` is read from the repo, its port and route carried over, its own
root installer retired. Done as a switch with the old service kept until the new one answers (as
the data-move plan did).

## Accounts on every domain (D-Q1)

What has to change:

- **The gate answers sign-in on every domain's hosts**: `/_pammy/login`, `register`, `reset`,
  the visitor cookie (already `__Host-`, per host, so nothing is shared across domains), the
  gate's routes table for other domains (`render.ts` already lists their hosts in `gateRoutes`).
- **The refusals go**: `render.ts:636`, `routes/hosts.ts:513`.
- **Emailed links name the host** the person signed up on (`https://tutorlumi.com/_pammy/reset#…`),
  never the home domain.
- **Real visitor IPs first** (review S6, step N4): on a Cloudflare domain the gate must see the visitor's
  address before any sign-in limit means anything.
- **The forged-header problem first** (review S1, step N4): more apps on more domains relying on
  `X-Lfdln-Account` makes it matter more.
- **The sender follows the domain** (PD-Q4, step MS1): each domain has an optional sending address
  (`mail.tutorlumi.com` for tutorlumi.com, already on the same Resend account); without one,
  `mail.lesfleursdelanuit.com`. The mail module's settings gain a sender per domain, and the
  visitor-mail daily cap (review S7) is kept per domain so one domain can't use up another's.

## gonsalvesfamily.com by hand (D-Q2)

The panel doesn't pretend: on that domain, **Add a name** says what to do by hand (the A record
at GoDaddy, then the certificate command, given as a sudo line with its log, as usual), checks
that the name resolves here and that a certificate covers it, and only then turns its route on.
Until then the name is listed as **waiting for DNS / certificate**. Its three names keep working
as now.

## Projects on any domain

**Reserved paths on every host**: `/_pammy/` (the gate) and **`/_api/`** (a project's Backend tab,
docs/backend-plan.md, decided 2026-10-06); `/_lfdln/` stays closed from outside. A route may not
be placed under any of them (C2-min's hosts route API reserves `/_api/`).

**`api.<domain>`, optional, per domain** (N6): the fallback API host (`api.<domain>/v1/<project>/…`)
for projects without a web address of their own. Not made for every domain: turned on per
domain where a project needs it; on a wildcard domain the name works at once, on
gonsalvesfamily.com it is added **by hand** (D-Q2). B1 starts with `api.lesfleursdelanuit.com`
only. The label `api` is already in `RESERVED_HOSTS` (`packages/hosts/src/names.ts`, with
`panel`, `www`, `mail`), so no one can take it as a site name.

- **New project** and **Addresses** offer every domain for the live address. Each domain says
  what it can do: a wildcard domain makes the name at once; gonsalvesfamily.com shows the
  by-hand steps; accounts on all (after D-Q1).
- **Dev previews always on the home domain** (D-Q3): `<name>-dev.lesfleursdelanuit.com`.
- **Backend tab** (docs/backend-plan.md, the namespace): a project's API answers at `/_api/` on
  each of its own addresses, so its pages call it same-origin on every domain (no CORS, an
  HttpOnly cookie per host). Only `api.<domain>` calls are cross-site: tokens in headers, and the
  project's allowed origins and OAuth redirect URLs list each domain it lives on (the Addresses
  tab fills them in).

## Installed on lfdln (N-Q4)

The apps module today is built around Pamela: files in `/srv/pamela-apps/<id>` linked from
`/pamela/apps/<id>`, run as her user, logins in her home, placement through her nginx site, mail
through her settings (`packages/apps/src/apps/remove.ts:27-46`, `nginx.ts`). For lfdln:

- **Each install isolated**: WordPress runs third-party plugin and theme code, so each install
  gets its own service user and its own PHP container (or pool), its own database login on
  lfdln-appmaria, and no access to other projects' files (PD-Q5).
- **Placement through Domains**: an Installed project is a route target like any other, on any
  domain, not a vhost edit.
- **Mail** through lfdln's mail module (Resend, `mail.lesfleursdelanuit.com`).
- pammy.org's installs (blog.pammy.org and the rest) unchanged.

## Order (when building starts)

As docs/master-plan.md section 5, Track N (each step its own release; Pamela: no step changes
pammy.org).

| Step | What | Needs |
|---|---|---|
| **N1** | The words: Projects, Domains, the kinds' names in lfdln's glossary; Hosts → Domains page; module ids unchanged | nothing |
| **N2** | One Projects page over all kinds (project kinds registry), the common tabs (Backend and Storage among them) | C2-rest, 8b-9 (site folders to Files) |
| **N3** | Connected from root-owned files; TutorStar, Gonsalves, exam prep moved to files; `known.ts` gone | N2, C5 (events, for the files' `events` part) |
| **N4** | = **S1 + S6** (Track S): signed proof for app headers (review S1); real visitor IP on Cloudflare domains (review S6) | Track S |
| **MS1** | **Mail sender and budget per domain** (PD-Q4, review S7): a sender per domain (`mail.tutorlumi.com`, SPF / DKIM checked at Cloudflare), the daily visitor-mail cap per domain, part kept for resets and confirmations | C2-rest |
| **N5** | Accounts on every domain (gate G7), with the **Cloudflare rules** below | N4, MS1, K-b |
| **N6** | New project / Addresses on any domain; gonsalvesfamily.com's by-hand flow; dev previews on the home domain; `api.<domain>` per domain (optional, by hand where needed) | N1, C2-min |
| **N7** | Code: Import an existing repository; exam prep moved from Connected to Code, **its hook moving to `/_lfdln/events`** (E-Q4) | N3 |
| **N8** | Installed on lfdln, one user / container / login per install (PD-Q5), placement through Domains | N2 |

**N5's Cloudflare rules** (on every Cloudflare-fronted domain, tutorlumi.com today):

| Rule | Why |
|---|---|
| **Cache bypass for `/_api/*`** (a Cloudflare cache rule) | no edge ever stores a project's data |
| **`Cache-Control: private, no-store`** on every `/_api/` answer (and `Vary: Authorization, apikey`, B-Q8) | belt and braces if a rule is missing |
| **WebSocket heartbeat < 60 s** (realtime) | Cloudflare drops idle WebSockets after about 100 s |
| **100 MB request-body limit** | Cloudflare refuses larger bodies; uploads above it go **direct to S3** with a presigned URL or are **refused with a clear message** ("files over 100 MB can't be sent through tutorlumi.com") |
| **Real visitor IP** (S6) also for `lfdln-backend`, not only the gate | every per-IP limit under `/_api/` counts visitors, not Cloudflare's edge |

### Release safety

As docs/master-plan.md section 7 (expand then contract; every step says how to roll back). Two
steps replace something live:

- **N3**: the root-owned files run **side by side with `known.ts` first**: for a release both are
  read and compared (same parts, ports, folders, backups); `known.ts` goes in the next release.
- **N7**: exam prep's switch keeps the **old service running until the new Code project
  answers** on its route (as the data-move plan did); then the old one is stopped, kept for a
  rollback window, and only then its root installer retired.

## Questions for momolig (all answered 2026-10-06, firm, see Decided)

### PD-Q1. Renaming in code, or only on screen

**Answer: (a).**

**(a) Words first**: the panel says Projects, Domains, Code, Installed, Connected; code keeps
`packages/projects`, `services`, `apps`, `hosts`. Cheap, no risk, and the confusing part
("projects" meaning two things) lives only in code comments.
**(b) Rename the packages too** (`projects` → `code`, a new `projects` registry, `hosts` →
`domains`): clearer for whoever reads the code, a large mechanical change (imports, migrations'
schemas, units, sockets, verify).
*Suggested: (a) now; (b), if ever, through a shim like K-rename (docs/master-plan.md section 5),
never inside K-a / K-b.*

### PD-Q2. Gonsalves and TutorStar

**Answer: they stay Connected.**

Both deploy themselves (Gonsalves has five parts and a one-shot migrator). *Suggested: they stay
Connected.* Only exam prep, which already follows the 8b shape, moves to Code.

### PD-Q3. Where the Addresses are edited

**Answer: (a), both.**

**(a) Both places**: the Domains page (everything on a domain) and each project's Addresses tab
(everything a project is shown at), the same routes. **(b) Only Domains.** *Suggested: (a).*

### PD-Q4. Which address sends the emails on other domains

**Answer: a sender per domain where one is set up: `mail.tutorlumi.com` for tutorlumi.com (same Resend account), `mail.lesfleursdelanuit.com` otherwise.**

A TutorStar student on tutorlumi.com gets "Reset your password" **from**:
**(a) `no-reply@mail.lesfleursdelanuit.com`** (as today; one sending domain at Resend), or
**(b) `no-reply@tutorlumi.com`** (each domain verified at Resend: DNS records for each; by hand
for gonsalvesfamily.com).
(b) looks right to the person and lands in spam less; (a) needs nothing.
*Suggested: (a) now, (b) per domain when a domain's owner wants it.*

### PD-Q5. How Installed projects are isolated on lfdln

**Answer: (a), one per install.**

**(a) One service user and one PHP container per install**, own database login: a bad plugin
reaches only its own files and database.
**(b) One shared user for all installs** (as Code projects share `svc-lfdln-apps`): simpler,
but one hacked WordPress can read the others' `wp-config.php`.
*Suggested: (a).* WordPress plugins are the most common way sites get broken into.
