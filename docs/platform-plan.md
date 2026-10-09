# Platform: the panel as packages, and panel.lesfleursdelanuit.com

Status: **decided 2026-09-23**; nothing built in the panel yet. Phase 0's wildcard certificate
and a stopgap catch-all are live (2026-09-23). G3b (adding a static folder) added and decided
2026-09-23. G9 (Next.js and React + Vite projects, npm packages, the editor) proposed 2026-09-23;
J2 decided, Q-J2 to Q-J4 open. **Updated 2026-09-26**: docs/roles-plan.md, docs/domains-hosts-plan.md
and docs/catalog-plan.md change the modules (G4) and the phases ("Order from here"); **the code
editor (code-server, was phase 8c) is removed for now** (J2). Asked for by momolig: the pammy.org panel
for lesfleursdelanuit.com as well, at panel.lesfleursdelanuit.com, with every feature it
has. There, a subdomain points at an app, a container, a redirect or a folder someone chose
to expose, not at a folder that happens to be in a public directory. While porting, cut the
panel into modules.

"lfdln" below is short for lesfleursdelanuit.com.

## What momolig decided (2026-09-23)

| # | Decision |
|---|---|
| U1 | **About five people use it**: momolig, badmon, monadelanuit, ericka, and maybe one more. Each has their own panel account and passkeys. |
| U2 | **ericka is a panel user only**, with no Unix account. Adding a person is done from the panel, not by a script. |
| N1 | **DNS stays at DreamHost.** The `*` record already points every name at 203.0.113.200, so a new subdomain needs no DNS change. The DreamHost API is used for the wildcard certificate (DNS-01, `~/lesfleursdelanuit-setup/dreamhost-dns.sh`) and to read the zone. |
| N2 | **No VPN** (revised 2026-09-24; the first decision, on 2026-09-23, was "only over a VPN"). A VPN would be too complicated for the people using the panel. **panel.lesfleursdelanuit.com is on the internet, like panel.pammy.org, and only a passkey signs anyone in** (no passwords to guess). The public side (forms, comments, protected areas, media and data APIs, served by the gate on each subdomain) is public as before. |
| S1 | **The services already on the server are adopted and managed**: stop, start, restart, and health checks (delete only for software, D2). |
| S2 | **The panel manages gonsalvesfamily.com's apps too.** It is the panel for this server, with lfdln as its home domain; a domain is a first-class idea. |
| F1 | **Only folders explicitly exposed are on the internet.** A folder is served once someone attaches it to a subdomain or path, like any app. Nothing becomes public just by existing. |
| P1 | **Packages first**: pammy.org's code is cut into packages and redeployed from them unchanged, then lfdln is built on the same packages. One codebase, deployed twice. |
| D1 | **The Database Manager uses lfdln's own engines** (its own MariaDB and Postgres, like pammy's pammydb). The Gonsalves and TutorStar data **moves onto them** from the server's Postgres on :5432 (G8). |
| D2 | **Adopted services can't be deleted from the panel.** Only software (WordPress and the like), and what was installed or made from the panel, can be. They can still be stopped, started and restarted. |
| D3 | **Site folders on disk belong to a service user of the panel's own**, not to a person. |
| D4 | **Wording: the technical terms** (container, port, route, host), **in plain, short sentences.** |
| D5 | **Only live apps' databases move.** `rumi_quotes`, the `_test`, `_dev` and shadow databases stay on the server's Postgres (:5432), which stays for development. |
| D6 | **Downtime for the moves is fine at any time for now.** |
| D7 | **The domain's renewal is momolig's, and it doesn't hold anything up.** |
| F2 | **Site folders are static**, plus PHP; a build step belongs to a project (G9), not a folder (Q-F1). |
| F3 | **People with a Unix account can write into folders they own**, over SSH/SFTP, through the `lfdln-sites` group (Q-F2). |
| F4 | **No size cap per folder** at first; Monitoring shows each folder's size (Q-F3). |
| F5 | **lfdln comes with PHP**: the PHP module is on in its profile from the day the panel stands up (phase 5), and a new site folder runs `.php` pages unless its switch is turned off. |
| J1 | **Projects can be installed from the panel: Next.js and React + Vite** (G9), each with a choice of TypeScript or JavaScript, and Tailwind or not. Any npm package can be added to a project from a graphical page. |
| J2 | **How people write code** (Q-J1): git from their own computer, and VS Code's Remote-SSH for people with a Unix account. (**Revised 2026-09-26: the editor in the browser, code-server, is removed for now**; it was per person, behind the panel's sign-in, from an Open in editor button. ericka, with no Unix account, uses git over HTTPS with a panel token.) |

## Where things stand (checked 2026-09-23)

- lesfleursdelanuit.com was renewed on 2026-09-23 (D7).
- DNS: ns1-3.dreamhost.com, wildcard `*` A → 203.0.113.200 (verified with a made-up name).
  `webmail` has its own record, which points at DreamHost. Mail in: Google Workspace. Resend has
  mail.lesfleursdelanuit.com verified already (pammy's mail sends from it).
- TLS: three HTTP-01 certificates (apex+www, tutor, instastylr), renewed by certbot.timer, and
  since 2026-09-23 the **wildcard** `wildcard.lesfleursdelanuit.com` (`*.` + apex, DNS-01 through
  `dreamhost-dns.sh`, expires 2026-12-22, renewed by the same timer). `default-443` refuses
  names that no block matches.
- **Stopgap catch-all (live since 2026-09-23)**: `sites-enabled/lesfleursdelanuit-wildcard`
  serves `<name>.lesfleursdelanuit.com` from `/var/www/lesfleursdelanuit-sub/<name>` (static
  only, hidden files refused, unknown names 404). A folder there is public **as soon as it
  exists**, which F1 doesn't allow; G3b says how the panel takes it over. Only `hello/` (a test
  page) is in it today.
- Served today:

  | Name | How | Files / unit |
  |---|---|---|
  | lesfleursdelanuit.com, www | static folder (no index.html: answers 403 today) | `/var/www/lesfleursdelanuit` |
  | `<name>.lesfleursdelanuit.com` | stopgap catch-all, static | `/var/www/lesfleursdelanuit-sub/<name>` |
  | instastylr.lesfleursdelanuit.com | static folder | `/var/www/instastylr` |
  | tutor.lesfleursdelanuit.com | Quadlet container, `svc-tutorstar`, :3041 | TutorStar |
  | gonsalvesfamily.com (public, admin, 2 APIs) | 4 Quadlet containers, **all under `svc-ligneous`**, :3039/:3040/:8091/:5001 | `/srv/apps/*` |

- People: `badmon` (sudo, ligneous-dev) and `monadelanuit` exist as Unix users; `ericka`
  does not and won't (U2). Nothing VPN-like is installed.
- pammy.org's panel: about 27,000 lines of TypeScript (panel 5.5k, gate 5.4k, studio 3.7k,
  pammydb 3.3k, apps 2.3k, sitefs 1.9k, the rest in src/*.ts), 42 pages, 18 migrations, three
  web components, five root or sandboxed helpers.

## G1. What is different from pammy.org

| | pammy.org | lfdln |
|---|---|---|
| In front | Cloudflare proxy; the origin accepts only Cloudflare | Nothing: visitors connect directly |
| TLS | Cloudflare origin certificate (wildcard) | Let's Encrypt wildcard by DNS-01 through DreamHost, plus the apex's own |
| A visitor's IP | `CF-Connecting-IP` | `$remote_addr` |
| Who uses the panel | Pamela and momolig | five people, with different rights (G5) |
| Reaching the panel | through Cloudflare, anyone can try; passkeys only | directly, anyone can try; passkeys only (N2) |
| Subdomains | `<folder>` in /pamela/public ↔ `<folder>.pammy.org`, automatically | a host and its routes, each pointing at a target (G3) |
| What runs | WordPress (installed software) | WordPress, containers, site folders, redirects, several domains (S2) |
| Words | plain, for Pamela | plainly technical (the same pages; the wording is part of the site profile) |

## G2. The shape: a core, modules, and a site profile

**One repository, packages inside it** (npm workspaces). Nothing is published anywhere; the
two panels are two deployments of the same code.

- **core**: what every module stands on:
  - accounts, sessions, passkeys, fresh-passkey checks
  - permissions (G5)
  - activity
  - jobs (from the software helper's jobs.ts)
  - the helper socket protocol (jsonline.ts)
  - settings, the Postgres pool and the migration runner
  - the UI kit, the page frame and the menu
  - the installer and verify frameworks, and release building.
- **modules**: one each for the list in G4. Each module brings:
  - its schema and migrations
  - its panel routes and pages
  - its menu entries
  - its **gate routes** (the public half)
  - its helper, if it has one, and that helper's units
  - its verify checks, guides, examples, and tests (unit and browser).
- **site profile**: one file per deployment:
  - domain(s)
  - TLS mode and what is in front (Cloudflare or direct)
  - subdomain mode (folder-linked for pammy, routed for lfdln)
  - which modules are on
  - wording
  - Unix users and paths, ports, and where mail comes from.

  pammy.org's profile describes exactly what runs today.

A module registers itself with the core. The core never imports a module. Modules may
depend on each other only in the direction shown in G4.

**Separate at run time.** Each deployment has its own system users, Postgres, gate, helpers,
sockets, state folders, Resend key (M2's reasoning again), and passkeys. Passkeys belong to
their domain anyway. The two panels share code only.

## G3. Hosts, routes and targets (lfdln's subdomains)

- A **host** is a name: `tutor.lesfleursdelanuit.com`, `lesfleursdelanuit.com`, or a name on
  another domain (gonsalvesfamily.com, S2).
- A host has **routes**: a path prefix (`/` by default) → one **target**:
  - **installed software**: WordPress now, more kinds later;
  - **a service**: a container or a port on 127.0.0.1 (TutorStar, the Gonsalves apps), reverse proxied;
  - **a site folder**: static files (and PHP pages if the PHP module is on), exposed on
    purpose (F1), kept under a folder of its own, never "everything in public/";
  - **a database app**: the pages the panel makes for a database;
  - **a redirect**: to another host, path or address.
- A **protected area** is a policy on a route (host + path), not on a folder. It is enforced
  by the gate through nginx `auth_request`, as on pammy.org, whatever the target is.
  (2026-09-26: an area is now any of these with a **role set**: protected, open with accounts,
  or an app's own roles; see docs/roles-plan.md.)
- nginx:
  - one catch-all server for `*.lesfleursdelanuit.com` on the wildcard certificate, with a
    map from host to routes. A host that isn't in the map gets a plain 404 page, not a TLS
    error.
  - hosts on other domains (and the apex) get server blocks of their own, written by the
    routing helper from the same table, with their own certificates.
  - existing server blocks are adopted byte-for-byte first (A1's approach), then taken over.
- **Refused names**:
  - names with their own record at DreamHost (read by `dns-list_records`: webmail, ftp, ...)
  - `panel`, `www`, `api`, `mail`
  - hosts already used.
- Wording to settle: pammy uses **app** for a database's pages. Proposed: **target** in the
  code, and on the page "What it shows": software / service / folder / database app /
  redirect.

## G3b. Adding a static folder

A **site folder** is a folder of static files (HTML, CSS, JS, images) that the panel makes, and
that a host or a path serves. It's the simplest target in G3: no process and no database. On
pammy.org it would be a folder in /pamela/public. Here it is made on purpose, and it isn't
public until it's attached (F1).

**Add a static folder** (Subdomains → Folders → Add), one short form:

1. **Name**: one DNS label, `[a-z0-9-]`, 1-63 characters, no leading or trailing hyphen. The
   folder's name on disk and, by default, its subdomain. Refused names (G3) are refused here
   too, and so is a name another folder already has.
2. **Where it shows**, one of:
   - `<name>.lesfleursdelanuit.com` (the default);
   - a path on a host that exists, e.g. `tutor.lesfleursdelanuit.com/docs/`, if that host's
     other routes leave the path free;
   - another name or domain the panel manages (S2);
   - **not yet**: the folder is made but nothing serves it. Attaching it later is a route like
     any other (G3).
3. **Start with**, one of:
   - a placeholder `index.html` that says whose folder it is (the default);
   - an uploaded `.zip`: unpacked by the files helper, with the File Explorer's upload rules
     (sizes, names, no symlinks, no hidden files, nothing outside the folder);
   - a copy of another site folder.
4. **Owner**: the person making it, by default. Admins can pick someone else (G5 owners per
   host).

Saving creates the folder, then the route. The route goes live only once the folder exists
and nginx has reloaded cleanly (`nginx -t` first, as the routing helper always does). The
folder then opens in the File Explorer.

**On disk:**
- `/var/www/lesfleursdelanuit-sub/<name>/`, the stopgap's folder, so a folder made there keeps
  working when the stopgap is removed. The folder is owned by the panel's service user (D3),
  group-readable by nginx, mode 2750. For another domain's folder, the root stays the same: the
  folder's name is unique, not the host's.
- Nothing in the folder runs except `.php` pages, through the sandboxed PHP runtime
  (pammy-php). The folder has a **Run PHP pages** switch, on by default on lfdln (F5).

**What nginx does for a site folder route** (the same for every one):
- `try_files $uri $uri/ =404`, `index index.html`
- hidden files refused; no directory listings
- an optional 404 page of the folder's own (`404.html`), otherwise the panel's plain 404
- a protected area can be put on it like any route (G3; with roles, docs/roles-plan.md), so a
  folder can be private with a sign-in in front.

**Afterwards**, on the folder's page:
- **Start / Stop**: routes on or off nginx (G6's `site-folder` kind). While stopped, the files
  stay and the host answers 404.
- **Routes**: where else it shows. One folder can be at a subdomain and a path at once.
- **Files**: the File Explorer, kept to this folder for its owner.
- **Delete** (only for folders made from the panel, D2): routes removed first, then the folder
  goes to the Trash for 30 days, as pammy's 4c.
- Health (Monitoring): its address answers 200 or 404-by-design.

**Taking over the stopgap** (in phase 4):
1. Adopt each folder already in `/var/www/lesfleursdelanuit-sub/` as a site folder routed at
   `<name>.lesfleursdelanuit.com`, so nothing that works today stops working. `hello/` is
   deleted instead, if it's still there.
2. Swap the stopgap's regex for the host map. From then on, a folder there that the panel
   doesn't know about isn't served (F1).
3. The apex and instastylr are adopted in phase 6 as site folders *in place* (their files
   don't move, and they can't be deleted, D2).

- A route option, **Single-page app**: an unknown path serves `index.html` instead of a 404,
  for client-side routers. Off for plain sites, on for React + Vite projects (G9).

**Before File Explorer lands on lfdln (phase 8):** the folder can be made, attached, started
and stopped, and filled from a `.zip`. People with a Unix account can also copy files in (F3).

**Checks for verify:** make a folder at a test name, and it answers with its placeholder;
`.git/config` → 403; a path outside the folder (`..`, symlink) → 404; stop → 404, start → 200;
delete → the route is gone and the folder is in the Trash; a refused name is refused.

**Decided (2026-09-23):** Q-F1 static only, plus PHP (F2, F5); Q-F2 SFTP through the
`lfdln-sites` group (F3). The panel keeps its own ownership (D3), and the File Explorer's
versions only cover changes made in the panel; Q-F3 no size cap (F4).

## G4. The modules

**Revised 2026-09-26** (docs/roles-plan.md, docs/catalog-plan.md, docs/domains-hosts-plan.md).
Packages as they are now, then as the three plans cut them. **New** = a package the plans add.

| Module (package) | What it is | Needs | Plan |
|---|---|---|---|
| Core (`@panel/core`) | panel accounts, passkeys, rights and places, Activity, sessions, Postgres, nginx rendering, the runner | - | today |
| Mail (`@panel/mail`) | sending (Resend), notices; visitor mail (fixed kinds) | core | today; accounts step 2 |
| **Settings** (new, `@panel/settings`) | Email settings, the visitor switches, the roles switch | core, mail | roles step 1 |
| **People** (new, `@panel/people`) | visitors' accounts: sign in, register, confirm, reset, account page, delete; the People / Users page | core, mail | roles step 1; accounts steps 2-4 |
| Access (`@panel/areas`) | areas (folders, routes), role sets, privileges, memberships, the gate's decision, identity headers, `pammy-panel.json` roles; the Access page (pammy.org: Protected folders) | core, people | roles steps 2-5 |
| **Requests** (new, `@panel/requests`) | asking for access (a role), resets by hand | people, areas | roles step 1 |
| Hosts (`@panel/hosts`) | domains, hosts, routes, the target-kind registry, names, the routing helper, checks, the setup guide, taking over | core | hosts plan; pammy.org's Subdomains move here (hosts step 5) |
| File Explorer (`@panel/files`) | roots (a registry), the folder helper, the editor with versions, copy/move/trash; site folders (from hosts, hosts step 6) | core | catalog steps 1, 3 |
| **Catalog** (new, `@panel/catalog`) | sources, items, scopes, tags and categories on files, Studio records and app items; moderated visitor tags; the catalog API | core, API keys, areas | catalog steps 1-2, 4-6 |
| **Thumbnails** (new, `@panel/thumbs`) | pictures for any item | catalog | catalog step 1 |
| **Media folders** (new, `@panel/media`) | `media/`, the Media grid, the media API, media examples | files, catalog, thumbs, API keys | catalog step 1 |
| **API keys** (new, `@panel/api-keys`; was `@panel/programs`) | keys for programs and apps (later holding a role) | core | catalog step 1 |
| Forms (`@panel/forms`) | forms, the builder, `<pammy-form>`, Responses | people, areas, mail, API keys | today |
| Form links (`@panel/form-links`) | form answers into a database table | forms, studio | today |
| Comments (`@panel/comments`) | comment areas, `<pammy-comments>` | forms, form-links, studio, areas | today |
| Database Manager (`@panel/studio`) | engines, Studio canvas, resources, app pages, database logins; tables as catalog sources (catalog step 4) | core | today |
| Installed Software (`@panel/apps`) | WordPress and more; a File Explorer root per install (`wp-content/`), a route target | core, mail, studio | today |
| Services (`@panel/services`) | adopted services: start/stop/restart/health, their data; a route target; no File Explorer root | core | today |
| PHP (`@panel/php`) | the sandboxed PHP runtime for site folders | core | today |
| Examples, Help (`@panel/examples`, `@panel/help`) | examples, guides, Getting started | the modules they show | today |
| *lfdln:* Monitoring | every host's checks every few minutes, mail when one fails | hosts, mail | phase 7c |
| *lfdln:* Projects | Next.js and React + Vite: build, run, deploy, roll back; Packages page; reads `pammy-panel.json`; a File Explorer root and a route target | hosts, files, a build helper | phase 8b |

Notes:
- **Visitors (People) ≠ panel accounts (Core).** Two tables, two words, as on pammy.org (People
  / Accounts). Panel accounts don't use roles (roles plan R5).
- Comments needs Forms; Requests needs People and Access; Media folders needs Catalog. The
  registries (route targets, File Explorer roots, catalog sources) let a module add to hosts,
  File Explorer and the catalog without them knowing it.
- The old list (Subdomains, Protected Areas, Users, Tags and Categories, Media View, Programs,
  the Database Manager's three parts, Trash, Certificates, DNS, Domains, Redirects) is in this
  file's history; Certificates, DNS, Domains and Redirects are now parts of Hosts.

## G5. Five people: permissions

- **Admins** (momolig, and anyone momolig makes one) can do everything:
  - Certificates, DNS, Domains, Monitoring settings
  - adopting and deleting services
  - accounts.
- **Rights per module**: none, see, or change, per person. For example, ericka changes Forms
  and Responses and sees Monitoring.
- **Owners per host**: a person can be given one or more hosts. What they change inside
  those hosts (routes, protected areas, a site folder's files, that host's software) is
  limited to them. pammy's "kept to one folder" becomes a special case of this.
- The fresh-passkey rule stays for what is dangerous. The list is set per action, as today.
- **Adding a person**:
  1. an admin makes an invite in the panel;
  2. the new person gets the invite link;
  3. they open it and make a passkey, as on pammy.org.
- Every action is in Activity with the person's name.

## G6. Services (S1, S2): Installed Software, generalized

Each install has a **kind**, and a kind knows its start, stop, restart, health, backup
(if any), and delete:

| Kind | Start / stop | Health | Delete (the 30-day trash of 4c) |
|---|---|---|---|
| `wordpress` | as on pammy.org | its address answers | as pammy's 4c |
| `container` (Quadlet, rootless) | `systemctl --user` start/stop/restart of its units, masked while stopped | its port answers, plus a path of its choosing (e.g. `/health`) | its units removed; its user only if nothing else runs as it |
| `site-folder` | stop = its routes off nginx (there is no process); start = back on | an address answers | its folder moved aside; routes removed |

- **Adopting** (A1 again): record what is there, change nothing, then check the panel's
  view matches reality.
  - The apex and instastylr become site folders, and their files stay where they are.
  - TutorStar becomes a container (`svc-tutorstar`).
  - The four Gonsalves apps become containers that share one user (`svc-ligneous`), grouped as
    one install, "Gonsalves family", with four parts. The group has start/stop/restart; one
    part at a time can be restarted too.
- **Shared users**: deleting one part never removes `svc-ligneous` while another part runs as
  it.
- **Adopted services can't be deleted from the panel** (D2): there is no Delete button, and
  the helper refuses `delete` for a record with `adopted: true` whose kind isn't software.
  Software (`wordpress`, and later kinds like it) can be deleted, adopted or not. So can
  anything installed or made from the panel: a site folder exposed from the panel, or a
  container installed from the catalog, if that ever exists.
- The Gonsalves Prisma migrator (a one-shot unit) is shown but not started from the panel.
- Monitoring (G4) uses the kinds' health checks every few minutes, keeps a short history, and
  mails the owners when something goes down or comes back.

## G7. Reaching the panel (N2, revised 2026-09-24: no VPN)

- `panel.lesfleursdelanuit.com` is an ordinary public name on the wildcard certificate, like
  panel.pammy.org: anyone can reach the sign-in page, and only a passkey gets further. There
  are no passwords to guess or leak; invites are one-time links (G5).
- What already guards panel.pammy.org guards it too: the fresh-passkey rule for dangerous
  actions, sign-in rate limits, same-origin checks on every change, sessions that expire, and
  every action in Activity.
- In the profile: `panelAccess: { kind: 'front' }` (docs/adapters-plan.md A3). The VPN-only
  mode stays in the code as an option, unused.
- (Dropped 2026-09-24: WireGuard. Its scripts, written but never run, are in
  `~/lesfleursdelanuit-setup/wireguard/`.)

## G8. Moving the Gonsalves and TutorStar data (D1)

On the server's Postgres 15 (:5432) today (2026-09-23):

| Database | Size | Owner |
|---|---|---|
| ligneous_frontend | 99 MB | ligneous_user |
| ligneous_frontend_shadow | 11 MB | ligneous_user (a Prisma shadow database, for development) |
| ligneous_graphs | 121 MB | postgres |
| ligneous_graphs_test | 633 MB | postgres |
| gedcom_family_tree | 10 MB | postgres |
| family_tree | 9.5 MB | postgres |
| gedcom_api_dev | 9.4 MB | postgres |
| gedcom_api_test | 41 MB | gedcom_test_user |
| tutorstar | 9.2 MB | tutorstar |
| rumi_quotes | 158 MB | postgres (instastylr's quotes) |

- **First, an inventory from each app's own configuration** (its `DATABASE_URL` and
  secrets), not from the names above: which databases each container really uses, and with
  which role. Test, dev and shadow databases stay where they are unless a live app uses them.
  **Done 2026-09-24** (`~/lesfleursdelanuit-setup/inventory/db-inventory.sh`, report
  `/root/db-inventory-20260924T061634Z.txt`; the secret, the unit and the running container
  agree for every app):

  | App (unit) | Database | Role | Note |
  |---|---|---|---|
  | TutorStar | tutorstar | tutorstar | owner; writes all 28 tables |
  | Gonsalves admin, Flask API, Prisma migrator | ligneous_frontend | ligneous_user | owner; writes all 197 tables |
  | Gonsalves public | ligneous_frontend | gonsalves_readonly | **can INSERT/UPDATE/DELETE 189 of 197 tables**: a default privilege (`ALTER DEFAULT PRIVILEGES FOR ROLE ligneous_user ... GRANT arwd TO gonsalves_readonly`) gives it every new table |
  | Gonsalves GEDCOM API | none | - | opens no database |

  So **only two databases move: `tutorstar` and `ligneous_frontend`.** `ligneous_graphs`
  (121 MB) is used by no live app, so it stays on :5432 with the rest (D5). Also found: the
  four installed Gonsalves quadlet files differ from the repo's copies (the installed ones are
  what runs); every database gives CONNECT to PUBLIC; four development databases have a
  collation version mismatch (stay on :5432, not ours to fix). Before `gonsalves_readonly`
  becomes truly read-only on the new engine, check whether the public site writes anything
  (a form, a counter): if it does, it needs a narrow grant rather than none.
- **For each app, one at a time:**
  1. Make the database and its roles on lfdln's Postgres. Real least-privilege roles, which fixes
     `gonsalves_readonly` (today it can write to all 191 tables).
  2. `pg_dump` from :5432, restore into the new engine (same or newer major version), and
     compare row counts and checksums, as the pammy panel's port tool does.
  3. A short planned downtime: stop the app, dump again for the final copy, point the app at the
     new engine (its secret; containers reach 127.0.0.1 through the host loopback as TutorStar
     does today via 10.0.2.2), start it, and check its health.
  4. The old database is kept read-only for 14 days, as the way back, then dropped. The
     server's Postgres itself stays, for the development databases (D5).
- TutorStar first (small, one database), then the Gonsalves apps together (they share data).
  No particular time is needed for the downtime (D6).
- After that the Database Manager shows these databases like any other. Changing their
  structure from the Studio is still something to do with care: the apps' own migrations
  (Prisma) expect to own their schema. Proposed: those databases are marked **managed by the
  app** and open read-only in the Studio. Rows can be seen, structure can't be changed.

## G9. Projects: Next.js and React + Vite (J1)

A **project** is code that the panel builds and deploys: source, packages, builds, and what
runs. It's a new kind next to software (WordPress) and site folders. On lfdln only: pammy.org's
profile leaves the module off.

### What can be made

| Kind | What runs | Served as |
|---|---|---|
| **Next.js** | a Node server (`next start`, the `standalone` build) in its own container | a route to its port (G3, a service target) |
| **Next.js, static export** | nothing: `output: 'export'` gives HTML files | a site folder (G3b) |
| **React + Vite** | nothing: `vite build` gives HTML, JS and CSS | a site folder, with **Single-page app** on |

Always the **latest stable version** at the time of making (checked 2026-09-23: Next.js 16.3.6,
Vite 8.3, React 19.3, Tailwind 4.3). The version is recorded; updates come later (below).

### The form: New project

1. **Kind**: Next.js or React + Vite.
2. **Name**: a DNS label, as in G3b.
3. **Where it shows**: as in G3b (`<name>.lesfleursdelanuit.com` by default, a path, another
   domain, or not yet).
4. **Language**: TypeScript (the default) or JavaScript.
5. **Tailwind**: yes (the default) or no.
6. **More options** (folded away; the defaults are what the tools pick):
   - Next.js: static export or server (server by default); `src/` folder; ESLint, Biome or
     none (ESLint by default); React Compiler; the import alias (`@/*`); starter page or empty.
   - React + Vite: SWC instead of Babel.

Behind the form: `create-next-app@latest` with `--ts`/`--js`, `--tailwind` or not, `--app`,
`--use-npm`, `--disable-git` (the panel makes its own repository). For Vite, `create-vite` with
the `react` or `react-ts` template, then, for Tailwind, `tailwindcss` and `@tailwindcss/vite`,
the plugin line in `vite.config` and `@import "tailwindcss"` in the CSS. Then the first build,
the route, and a check that it answers. Every step shows in the job's log.

### How it is built and run

- **A build never runs as the panel or as root.** It runs in a throwaway rootless container
  (Node LTS image, with the tools native packages need: python3, make, g++), which sees only
  the project's folder. No secrets and no runtime environment variables are in it, except the
  build-time ones the project marks as such.
- **One build at a time** on the server (the jobs queue). A build can use about 2 GB of memory.
- **Next.js servers** run as rootless Quadlet containers under one service user,
  `svc-lfdln-apps`, one container per project, each on its own port on 127.0.0.1 (a range kept
  for projects, e.g. 4100-4999). Limits per container: 512 MB of memory and one CPU by default,
  changeable by an admin. It restarts if it crashes.
- **Releases**: every successful build is a release. Deploying = build, start the new release
  beside the old one, check its health, switch nginx to it, stop the old one. A failed build or
  a failed check changes nothing live. The last 3 releases are kept, so **Roll back** is
  instant.
- Room today (2026-09-23): 31 GB of memory, 12 CPUs, 780 GB free. A Next.js server uses about
  150-300 MB, and a project's folder with its packages 300-800 MB.

### The code: where it lives and how people change it

- On disk: `/srv/lfdln-projects/<name>/` with `repo.git` (a bare git repository, the
  project's one true copy), `releases/`, and `logs/`, owned by `svc-lfdln-apps`. Builds check
  out from `repo.git`; nobody edits inside it.
- **Git is the record of every change.** The panel commits its own changes (made, packages
  added or removed, files edited in the File Explorer) to `main`, with the person's name as
  author. History and "go back to this version" come from it.
- **A push to `main` builds and deploys**, whoever pushed and from wherever. A failed build
  leaves the live release alone and says so on the project's page (and by mail to its owners).
- **Two ways in** (J2), both to the same `repo.git`:
  1. **Git from their own computer**: `git clone` over HTTPS, with a personal
     token made on the panel (the only way for people without a Unix account), or over SSH for
     people with one.
  2. **Remote-SSH** (VS Code on their own computer, working on the server): for people with a
     Unix account. They clone into their home folder on the server. Their group
     (`lfdln-projects-<name>`, given to a project's owners) lets them push.

### The editor (removed for now, 2026-09-26)

The editor in the browser (code-server per person, its container, limits, sign-in and preview
addresses; was phase 8c) is **removed for now** by momolig. The design is in this file's git
history (commit c6c1574 and before) if it comes back; the open point it had (a fresh passkey
before a terminal on the server, with no VPN) would have to be settled first. Until then: git
from people's own computers and Remote-SSH (J2). Nothing in phase 8b depends on it.

### The Packages page (npm, graphical)

One page per project, three parts:

1. **Installed**: every package in `package.json`, with the version asked for, the version
   installed, the latest version, and whether it's a dependency or a dev dependency. Flags:
   *update available*, *security advisory* (from `npm audit`), *deprecated*.
2. **Add a package**: a search box over the npm registry. Each result shows its description,
   weekly downloads, last release date, licence, size, and, for TypeScript projects, whether it
   has types (if not, the matching `@types/…` package is offered with it). Choose the version
   (latest by default) and dependency or dev dependency. Several can be picked, then installed
   together.
3. **Warnings before installing**, shown plainly, never blocking:
   - the package is new (under 30 days) or has very few downloads;
   - its name is one letter away from a popular package (typosquatting);
   - it's deprecated, or its licence isn't a common open-source one;
   - it runs install scripts.

Installing: `npm install` in the build container → `package.json` and `package-lock.json`
change → a commit → a build → a deploy. If the build fails, the commit is undone and the live
project doesn't change. The same flow for **Update** (one package, or "all minor and patch
updates"), **Remove**, and **Fix security issues** (`npm audit fix`, non-breaking fixes only).

**Any package** from the public npm registry. Install scripts are allowed, because many
packages need them (sharp, esbuild, prisma), and they run only inside the build container.

**Scripts**: each script in `package.json` (lint, test, …) gets a **Run** button. It runs in
the build container and shows its output. There is no general terminal in the panel.

### A project's other pages

- **Overview**: status, address, the version running, Start / Stop / Restart / Rebuild,
  Roll back.
- **Environment**: variables, marked *build time* or *run time*. A warning for `NEXT_PUBLIC_`
  and `VITE_` ones: they are visible to anyone in the browser. Values are shown masked, and
  revealing one needs a fresh passkey.
- **Database**: connect a database from the Database Manager. It makes a database and a role
  on lfdln's engines (D1) and sets `DATABASE_URL`.
- **Logs**: the build logs, and the running server's log, live.
- **Updates**: a nightly check. Patch releases of Next.js, React and Vite are flagged (and
  applied automatically only if the project says so). A major version (Next.js 17) is a button
  that runs the official upgrade tool (`@next/codemod upgrade`) in the build container, builds,
  and deploys only if the build passes. The Node image is kept on the current LTS.
- **Delete** (made from the panel, so allowed, D2): stop, routes off, then the source and the
  releases go to the Trash for 30 days.
- **Rights** (G5): Projects is a module, with none, see or change per person, and owners per
  project. Adding a package or changing a variable needs change.

### Questions (Q-J)

- **Q-J1: how people write the code.** Decided 2026-09-23 (J2): git from their own computer,
  Remote-SSH for people with a Unix account (code-server per person removed for now, 2026-09-26). A GitHub repository
  per project (the panel pulling with a deploy key) can be added later if someone wants one.
- **Q-J2: a preview before going live?** For example, the `dev` branch builds to
  `<name>-preview.lesfleursdelanuit.com`, behind the panel's sign-in. Proposed: later, not in the first
  version.
- **Q-J3: which other projects and software, beyond Next.js and React + Vite?** Once projects
  exist, each extra kind is mostly a template. Candidates:
  - **other Vite templates**: Vue, Svelte, Preact (the same machinery, almost free);
  - **a Node API**: Express, Fastify or Hono (a server like Next.js, with no pages);
  - **Astro**: content sites, static or server;
  - **software**: Gitea (git with a web page, which also answers Q-J1), Ghost (blogs), Umami
    (visitor statistics).

  Proposed for the first version: Next.js, React + Vite, the other Vite templates, and a Node
  API. The rest one at a time, when someone asks.
- **Q-J4: package managers.** npm only (proposed), or pnpm too?

## Phases

| Phase | What | Risk |
|---|---|---|
| 0 | **Groundwork on the server**: the wildcard certificate through `dreamhost-dns.sh` (**done 2026-09-23**, `*.` + apex; the apex's old certificate still serves it) and the stopgap catch-all (**live**). (WireGuard dropped 2026-09-24: no VPN, N2.) Done | low |
| 1 | **pammy.org into packages, no change in behaviour**: workspaces, core, modules as in G4, the site profile, per-module migrations after today's 18 (kept as the baseline). pammy.org deployed from it, and its verify gives the same checks (currently 540 + 60) | medium: everything moves; the tests are the net |
| 2 | **Done 2026-09-24** (docs/adapters-plan.md; last release 7c13ddda). **Site profile adapters**: TLS mode, direct or Cloudflare, real IP, folder-linked or routed, wording. pammy.org's profile = today | low |
| 3 | Plan: docs/permissions-plan.md (decided 2026-09-24: rights on/off, places, own Activity; Pamela gets an lfdln account). **Permissions for five** (G5): rights per module, owners per host, invites from the panel. pammy.org gets it too (Pamela and momolig as admins) | medium: every route is checked again |
| 4 | **Hosts and routes** (G3) and its nginx rendering, for lfdln: catch-all, the host map, refused names from the DreamHost zone; **adding a static folder** (G3b) and taking over the stopgap | high: nginx for live sites |
| 5 | **panel.lesfleursdelanuit.com stands up**: its users, Postgres, gate, helpers, installer and verify with the lfdln profile; public, passkeys only (N2); the core modules and **PHP** on (F5); no services yet | medium |
| 6 | Plan: docs/adopt-plan.md (decided 2026-09-25). **Adopt the services** (G6): the apex and instastylr as site folders, TutorStar, then Gonsalves (grouped); start/stop/restart/health. Delete locked for adopted ones | high: live sites of other projects |
| 6b | Plan: docs/data-move-plan.md (decided 2026-09-25). **Move the data** (G8): inventory, then TutorStar, then Gonsalves, each with its downtime window and 14 days to go back | high: live data of other projects |
| 7 | **Certificates, DNS, Domains, Monitoring**, now in three parts: **7a** docs/domains-hosts-plan.md steps 1-4 (domains as data, route-target registry, checks, the setup guide); **7b** that plan's step 7 (gonsalvesfamily.com as a domain) + the Gonsalves nginx takeover (docs/adopt-plan.md V1); **7c** Monitoring (the checks every few minutes, mail when one fails), expiry and nameservers, mail DNS records (SPF/DKIM/DMARC) | low to medium |
| 8 | **The rest of the modules on lfdln** (revised 2026-09-26, G4): API keys, File Explorer with roots, Catalog, Thumbnails, Media folders, Forms, Comments, the Database Manager; Studio and app catalog sources, visitor tagging (docs/catalog-plan.md steps 3-6). People, Access and Requests are **not** here any more: they reach lfdln earlier with docs/accounts-plan.md and docs/roles-plan.md | medium; each module one release |
| 8b | **Projects** (G9): the build helper and container, React + Vite first (no server), then Next.js (servers, releases, roll back), git over HTTPS and SSH with push-to-deploy, then the Packages page, Environment, Database, Updates Also (2026-09-26): read `pammy-panel.json` on every deploy (roles, catalog), a project root in File Explorer, `project` as a route target. | medium: builds run code from npm; the sandbox is the net |
| 8c | ~~The editor~~ **removed for now** (2026-09-26, J2) | - |
| 9 | Guides and Getting started for lfdln's people, and guides for roles, the catalog and the hosts setup guide (both panels) | low |

## Order from here (2026-09-26)

Phases 0-6 are done or live; 6b has Gonsalves left. The three new plans run through the rest:

| # | What | Plans | Risk to pammy.org |
|---|---|---|---|
| 0 | Finish what's running: accounts step 1 installed, Gonsalves data switch (6b), people invited (phase 5 step 4) | accounts, data-move, stand-up | low |
| 1 | **Package splits first**, no behaviour change: People / Requests / Settings, then Catalog / Thumbnails / Media folders / API keys | roles 1, catalog 1 | medium (imports) |
| 2 | **Phase 7a**: domains as data, route-target registry, checks, the setup guide (lfdln only) | hosts 1-4 | none |
| 3 | **Accounts on lfdln, roles under the hood**: visitor mail, the gate on lfdln, accounts; memberships, privileges | accounts 2-4, roles 2-3 | medium (roles 2) |
| 4 | **Exam prep live on accounts**: areas on routes, switches on, exam prep deployed (the Access page isn't needed for it) | roles 5, accounts 6, roles 6, exam prep 5-6 | low |
| 5 | The Access page | roles 4 | low |
| 6 | **Phase 7b**: gonsalvesfamily.com as a domain, the Gonsalves nginx takeover; **7c** Monitoring | hosts 7, adopt, phase 7 | none |
| 7 | **The catalog schema move**, on its own | catalog 2 | **high** |
| 8 | **Phase 8** on lfdln | catalog 3-6, phase 8 | medium |
| 9 | **pammy.org on hosts**, on its own | hosts 5 | **high** |
| 10 | Phase 8b Projects; site folders to Files | 8b, hosts 6 | low |
| 11 | Phase 9 guides | 9 | low |

Why: the splits first, so everything after lands in the new packages (the same code doesn't
move twice); exam prep early, since it is why the roles exist; the two big pammy.org changes
(catalog 2, hosts 5) each in their own window, after the lfdln work that exercises the same
code.

pammy.org's own work goes on in between (apps phase 5 updates, phase 6 guide 21). After phase 1,
it lands in the packages and both panels get it.

## Questions for momolig

Q-J2 to Q-J4 about projects (G9). The 5th person needs nothing now: people are added from the
panel (U2).
