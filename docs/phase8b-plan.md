# Phase 8b: Projects

PROPOSED 2026-10-05 on branch phase-8b. **DECIDED 2026-10-05**: momolig took every suggested answer (P8b-1..P8b-11), "start building". The design is docs/platform-plan.md G9 (J1, J2); this
file turns it into steps. momolig's answers of 2026-10-05 to G9's open questions:

- **Q-J2: yes, a dev branch.** `dev` builds to a preview address before `main` goes live.
- **Q-J3: Laravel too**, and maybe Vue, Svelte and Lit (beside Next.js and React + Vite).
- **Q-J4: npm and pnpm, both.**

Platform plan row 10: *"Phase 8b Projects; site folders to Files"*. lfdln only: pammy.org's
profile leaves the module off.

## What there is today (checked 2026-10-05)

- **Exam prep is a project in all but name, made by hand.** Its own repository builds it
  (`web/build.sh`: tests, `next build`, a `localhost/examprep:<id>` image from the pinned
  `node:22-bookworm-slim`), and its `deploy/install.sh` (root) makes `svc-lfdln-apps`, moves
  the image across with `podman save | load`, makes podman secrets from `/etc/lfdln-appdb/*.pass`,
  runs its migrations, writes a Quadlet (`127.0.0.1:4101`, `slirp4netns:allow_host_loopback`,
  ReadOnly, 512 MB, 1 CPU, health check), restarts it, waits for `/api/health` to name the new
  release, and rolls back if not. Tags `prod` and `previous`; 3 releases kept. That is the
  shape every server project follows here, done by the panel instead of a script.
- **Services are a fixed list.** `packages/services/src/known.ts` names them (TutorStar,
  Gonsalves, exam prep); the installer adopts them into `/var/lib/lfdln-services/services.json`.
  There is no way to add one at run time, and no delete.
- **Route kinds are a registry** (domains-hosts D-4): folder, redirect, service. `project` is
  named there as the one to come. A folder route already has **Single-page app** (`spa`).
- **No jobs queue on lfdln.** pammy.org's software helper has one (`packages/apps/src/apps/jobs.ts`:
  one job per app, a step string, history), but the apps module is off here.
- **No ports are handed out.** 4100-4999 is prose in G9; exam prep took 4101 by hand.
- **PHP**: the host's php-fpm 8.3 serves site folders (one pool, no network, no mbstring,
  xml, intl or pdo drivers). **Composer is not installed.** Laravel can't run on it as it is.
- **Databases**: the Studio's database helper already makes databases and logins on
  lfdln-appdb (:5436) and lfdln-appmaria (:3308), `db_` names (P8-15).
- **The wildcard** `*.lesfleursdelanuit.com` (DNS and certificate) covers any one-level name,
  so `<name>.` and `<name>-dev.` need nothing new outside the panel.

## Decided before this plan

From G9 (unchanged): builds never run as the panel or root but in a throwaway rootless
container; one build at a time; servers as rootless Quadlet containers under `svc-lfdln-apps`;
every good build a release, 3 kept, **Roll back** instant; a failed build or check changes
nothing live; `/srv/lfdln-projects/<name>/repo.git` is the one true copy; the panel commits its
own changes; a push to `main` builds and deploys; git from people's own computers (HTTPS with a
token, or SSH) and Remote-SSH for people with a Unix account; no terminal in the panel; rights:
a `projects` module with owners per project.

## What a project can be

| Kind | Made with | Built with | Runs | Served as |
|---|---|---|---|---|
| **React** | `create-vite` `react` / `react-ts` | Node image | nothing | static, single-page app |
| **Vue** | `create-vite` `vue` / `vue-ts` | Node image | nothing | static, single-page app |
| **Svelte** | `create-vite` `svelte` / `svelte-ts` | Node image | nothing | static, single-page app |
| **Lit** | `create-vite` `lit` / `lit-ts` | Node image | nothing | static |
| **Next.js, static export** | `create-next-app`, `output: 'export'` | Node image | nothing | static |
| **Next.js** | `create-next-app` (standalone) | Node image | Node server container | proxy to its port |
| **Laravel** | `composer create-project laravel/laravel` | Composer + Node images | PHP server container | proxy to its port |

Each with **TypeScript or JavaScript** (not Laravel), **Tailwind or not**, and **npm or pnpm**
(chosen when made; afterwards the lockfile decides: `pnpm-lock.yaml` → pnpm, else npm). pnpm
comes from Corepack in the Node image, pinned by the project's `packageManager` field. Always
the latest stable version when made; the version is recorded.

Two kinds of running: **static** (the build gives files, served by nginx from the release
folder, no container at all) and **server** (Next.js, Laravel: a container per project per
release, like exam prep).

## The dev branch (Q-J2)

- A push to **`main`** deploys to the project's routes, as G9 says.
- A push to **`dev`** builds the same way into its own releases and deploys to
  **`<name>-dev.lesfleursdelanuit.com`**: a host the panel makes with the project, one level
  deep so the wildcard covers it. A server project gets a second container for it (its own
  port, half the memory by default).
- **The preview is not public**: its route has accounts on (roles plan step 5), open only to the
  visitors the project's owners pick (P8b-2). Search engines are told `noindex` on it.
- **Promote**: a button "Put dev live" fast-forwards `main` to `dev` (refused if they've
  diverged: then it says to merge), which deploys `main` as any push does.
- Environment variables and the database are **per branch** (P8b-5): dev gets its own
  database by default, so trying things never touches live data.
- `dev` is made with the project (from `main`), and can be switched off per project.

## Laravel (Q-J3)

- **Not on the host's PHP.** A Laravel project runs in its own container: the official
  **FrankenPHP** image (`dunglas/frankenphp`, PHP 8.4, with the extensions Laravel needs added
  in the project's image: pdo_pgsql, pdo_mysql, mbstring, intl, zip, bcmath, opcache), serving
  HTTP on the project's port (P8b-4). Same Quadlet shape, limits and health check as Next.js;
  health = Laravel's own `/up`.
- **Built** in two throwaway containers: the official `composer:2` image (`composer install
  --no-dev --optimize-autoloader`) and the Node image (`npm|pnpm run build` for Vite assets).
  The release image copies both results onto the FrankenPHP base.
- **Kept between releases**: `storage/` (uploads, logs, sessions) in
  `/srv/lfdln-projects/<name>/storage/<branch>/`, mounted read-write; everything else read-only.
- **On deploy**: `php artisan migrate --force` in the new release before it takes traffic
  (a switch per project, on by default; a failed migration stops the deploy, nothing switched),
  then `config:cache`, `route:cache`, `view:cache`.
- **`APP_KEY`** is made with the project and kept as a secret (per branch).
- **Artisan buttons**: a fixed short list (migrate status, cache clear, `about`), like the
  Scripts buttons. No `tinker`, no arbitrary commands (no terminal in the panel).
- **Not in the first version**: queue workers and the scheduler (a second container per
  project; P8b-7), Composer packages page (Composer packages change through git until then).

## Where things live

```
/srv/lfdln-projects/<name>/
  repo.git/                 bare repository (main, dev), the one true copy
  work/                     the helper's own checkout, for its commits (packages, env names)
  releases/<branch>/<id>/   a static project's files, or a server release's record
  storage/<branch>/         Laravel only
  logs/                     build logs, one per build
/var/lib/lfdln-projects/projects.json   the record (root, 600): kinds, ports, releases live
/etc/lfdln-projects/<name>/             pammy-panel.json as deployed (as exam prep's)
```

All of `/srv/lfdln-projects/<name>/` is `svc-lfdln-apps`'s; `repo.git` also group
`lfdln-projects-<name>` (setgid, `core.sharedRepository=group`) for the owners who push by SSH.
Server releases are images in `svc-lfdln-apps`'s podman: `localhost/proj-<name>:<id>`, tags
`<branch>` and `<branch>-previous`.

## The projects helper

A new helper, **`lfdln-projects`** (socket `/run/lfdln-projects.sock`, root:svc-lfdlnpanel
0660), shaped like the services helper: runs as root with no capabilities beyond what it
needs, and does every piece of work through `systemd-run` as `svc-lfdln-apps` (the runner
already sets what rootless podman needs). It owns the record, hands out **ports from
4200-4999** (4100-4199 stay for services made by hand, like exam prep's 4101; P8b-3), keeps
**one build at a time** in a queue with each job's steps and log, and owns the Quadlets of
project containers. The panel only asks it; it never runs a build itself.

**A build** (every kind): check out the branch at a commit into a fresh folder → throwaway
container (`--network` only to the registries, 2 GB, 2 CPUs, 15 minutes, read-only except its
folder; no secrets except variables marked *build time*) → install (`npm ci` / `pnpm install
--frozen-lockfile` / `composer install`) → build → for static: copy the output to
`releases/<branch>/<id>/`; for a server: build the release image → start it on a spare port →
health check → switch → stop the old. The job log is kept with the release.

**The switch**: static = the route's root is a `current` symlink per branch, replaced in one
rename (nginx follows it; no reload). Server = the route's port stays the project's; the new
container takes over the port after the old one stops (a few seconds of 502, said plainly on
the page), or, if P8b-6 says so, two ports per branch and nginx switched between them with
no gap.

**Git hooks**: `repo.git`'s `post-receive` (owned by root, not changeable by pushers) writes
one line, branch and commit, to `/run/lfdln-projects/pushes/` (group-writable spool); the
helper watches it and queues a build. A push that isn't `main` or `dev` builds nothing.

## Git from people's own computers

- **SSH** (people with a Unix account: badmon, monadelanuit, momolig): `git clone
  ssh://<user>@lesfleursdelanuit.com/srv/lfdln-projects/<name>/repo.git`. Allowed by the
  `lfdln-projects-<name>` group, which the panel gives a project's owners who have Unix
  accounts (the helper runs `gpasswd`).
- **HTTPS** (everyone, ericka too): `https://git.lesfleursdelanuit.com/<name>.git`, with a
  **personal token** made on the panel (Account > Git tokens, shown once, kept hashed, per
  person, revocable). nginx asks the panel (`auth_request`) whether the token's person may read
  or push that project; `git-http-backend` runs as `svc-lfdln-apps` behind fcgiwrap. A host the
  panel makes, like any other.

## A project's pages

- **Projects** (list): name, kind, address, branch states (live / building / failed), New
  project.
- **New project**: kind, name (a DNS label), where it shows (as Add a static folder: its own
  name by default, a path of a host, another domain, or not yet), TypeScript, Tailwind, npm or
  pnpm, dev branch on, More options (Next.js: static export, `src/`, linter, React Compiler,
  import alias; Vite: SWC). Making it is a job: scaffold (in the build container), first
  commit, `dev` from it, first builds, the routes and the `-dev` host, a check that both answer.
- **Overview**: per branch: commit, release, when, by whom; Start / Stop / Restart (server
  kinds), Rebuild, **Roll back** (3 releases), **Put dev live**; how to clone (SSH and HTTPS).
- **Logs**: each build's log; a server's live log (`journalctl` of its unit, as Services does).
- **Environment**: per branch, *build time* or *run time*; masked, revealing one needs a fresh
  passkey; warning on `NEXT_PUBLIC_` / `VITE_`; kept as podman secrets (run time) and handed
  to the build container only when marked build time. Never in git.
- **Database**: make one on lfdln-appdb or lfdln-appmaria through the database helper (an
  owner login for migrations and an app login, as `appdb/apps.sql` does for exam prep), per
  branch; sets `DATABASE_URL` (Laravel: `DB_CONNECTION`, `DB_HOST`, ... too). The container
  reaches it at 10.0.2.2, as exam prep does. Shown in the Studio like other databases.
- **Packages** (npm and pnpm): as G9 says (installed, add with warnings, update, remove,
  audit fix, Scripts with Run buttons). A change is a commit to `dev` when the project has
  one (so it is tried first), else to `main`.
- **Updates**: the nightly check of G9 (patch flagged, major = a button running the official
  upgrade tool in the build container, on `dev`).
- **Delete**: stop, routes and the `-dev` host off, the source, releases and storage to the
  trash for 30 days; the database is not deleted (it says so, with a link).

`pammy-panel.json` is read on every deploy of `main` (roles, catalog), as exam prep's
manifest is today, and a project's routes give it accounts like a service route.

## Rights

A **`projects`** module and right ("Projects: making, building and deploying projects, their
variables, packages and databases"), whole-site (not a place right). Plus **owners** per
project: the person who made it, and anyone an admin or an owner adds. An owner may change
their project; the right alone lets you see every project and make new ones (P8b-8). Admins:
everything. Reveal a variable, Delete, Put dev live: a fresh passkey.

## Steps

Each step is one release (build.sh, install-lfdln.sh, verify-lfdln), and pammy.org is
installed too whenever shared code changes (its verify unchanged).

| Step | What | Risk |
|---|---|---|
| 8b-1 | **Groundwork**: the `projects` module, right, package and menu (an empty Projects page); the `lfdln-projects` helper (record, ports, job queue, runs as `svc-lfdln-apps`); `svc-lfdln-apps` made by `install-lfdln.sh` (not only exam prep's script); the build image (`lfdln-build:node`: Node LTS, git, python3, make, g++, Corepack) built by the installer | medium: a new root helper |
| 8b-2 | **Static projects**: React, Vue, Svelte, Lit, Next.js static export; npm and pnpm; New project, Overview, Logs, Rebuild, Roll back, Delete; a `project` route kind (static: root on the `current` link, SPA per kind); the `main` branch only | medium: builds run code from npm |
| 8b-3 | **Git and the dev branch**: `repo.git`, the push hook and spool, SSH for owners with Unix accounts (groups), the `-dev` host with accounts, Put dev live | medium: pushes from outside |
| 8b-4 | **Next.js servers**: release images, Quadlets, health switch, roll back, Start/Stop/Restart, live log; the **Environment** page; monitoring checks each project's routes | medium: containers we run |
| 8b-5 | **Database** page (appdb and appmaria, per branch) | low: the database helper does it already |
| 8b-6 | **Laravel**: the FrankenPHP release image, Composer builds, storage, migrate on deploy, APP_KEY, Artisan buttons | medium |
| 8b-7 | **HTTPS git** with personal tokens (`git.lesfleursdelanuit.com`) | medium: a new way in from outside |
| 8b-8 | **Packages** page (npm and pnpm), Scripts, **Updates** | medium: installs any npm package (in the sandbox) |
| 8b-9 | **Site folders to Files** (domains-hosts D-3, step 6): the table's owner moves from hosts to files; nothing changes on screen | medium: every folder route's rendering |

Order reasoning: 8b-2 gives something useful with nothing running (static files only); 8b-3
before servers so every later kind has `dev` from the start; Laravel after Next.js reuses the
container switch; HTTPS git after SSH because SSH needs no new door; 8b-9 last, independent of
the rest (could go any time).

Tests per step: unit (helper ops with a fake runner, record, ports, route kind rendering),
the hosts nginx harness for the `project` kind, a builds test that really runs a tiny Vite and
Next.js build in podman (in build.sh, as move-db's test runs containers), e2e-lfdln for the
pages (desktop and phone), verify-lfdln on the live box: helper sandbox, socket mode, a
throwaway project made, built, served, rolled back and deleted.

### 8b-1 as built (2026-10-05)

- **`@panel/projects`** (module and right `projects`, whole-site; lfdln only, pammy.org's
  profile leaves it off): record (`src/record.ts`: names are DNS labels that can't end in
  `-dev`, kinds, ports 4200-4999), the job queue (`src/jobs.ts`: one at a time, last 200 in
  `jobs.json`, each log in `logs/<project or ->/<job>.log`, a job cut off by a restart is
  marked failed), the helper (`src/helper/`, socket ops `info list ports jobs job check`), the
  Projects page (build environment, Check the build environment, jobs with their logs; the
  projects list is empty until 8b-2). Menu: Sites > Projects, after Services.
- **`lfdln-projects.socket` / `.service`**: root, no capabilities, ProtectSystem=strict with
  only `/var/lib/lfdln-projects` writable, 127.0.0.1 only; socket root:svc-lfdlnpanel 0660.
  The installer doesn't stop it while a job runs.
- **`deploy/lfdln/projects/install-projects.sh`** (run by install-lfdln.sh after the
  databases): makes `svc-lfdln-apps` if missing (as exam prep's script does), the folders, and
  the build image `localhost/lfdln-build-node:current` as that user, rebuilt only when its
  files change (label `lfdln.sum`) or with `--rebuild-image`; keeps the two newest by name.
- **The build image**: `node:24-bookworm-slim` (Node 24, the LTS), git, python3, make, g++,
  and **pnpm installed with npm, not Corepack** (Corepack fetches pnpm's binary on first use,
  so a build with no network fails, and Node 25 drops it). Checked: node v24.21.0, npm 11.19.0,
  pnpm 12.9.1, git 2.39.5, offline and read-only.
- `NEEDS.projects` is `[]` until 8b-2's route kind imports hosts.
- Tests: `test/projects-helper.test.ts`, e2e-lfdln 16-projects, verify-lfdln "projects".

### 8b-2 as built (2026-10-05)

- **Inside the build container** (`packages/projects/container/`, plain Node, mounted
  read-only as `/lfdln`): `scaffold.mjs` runs the latest `create-vite` (`--no-interactive`) or
  `create-next-app` (`--no-src-dir --no-react-compiler --disable-git --skip-install --yes`),
  names the package, writes the static export config (`output: 'export'`, images unoptimized),
  installs once for the lockfile, and for Vite + Tailwind writes `vite.config` itself (Lit's
  starter has none) and puts `@import "tailwindcss"` in the kind's own CSS file (React
  `src/index.css`, Vue `src/style.css`, Svelte `src/app.css`, Lit `src/index.css`); then the
  first commit, pushed to `repo.git`. `build.mjs` clones the branch (the repository mounted
  read-only), `npm ci` / `pnpm install --frozen-lockfile`, `run build`, copies `dist/` (or
  `out/`) to the branch's releases folder.
- **The box**: `podman run --userns=keep-id` (files are svc-lfdln-apps'), read-only but its
  mounts and a 512 MB `/tmp`, 2 GB, 2 CPUs, 1024 pids, `--timeout=900`, the network open
  (P8b-11), npm's and pnpm's caches per project.
- **Folders**: `/srv/lfdln-projects/<name>` 711 (made by a root unit), `repo.git work cache
  build` 700, `releases/main` 755 so nginx reads the live release and nothing else. A release
  id is its UTC time to the second; `current` is replaced in one rename; 3 kept.
- **Route kind `project`**: the folder kind's body became `staticLocation()` in
  `packages/hosts/src/render.ts` (folder routes unchanged), used by both; SPA for the Vite
  kinds; `/assets/` (Vite) or `/_next/static/` cached for good at a host's top.
- **New project's host**: made by the page through the Hosts API (`POST /api/hosts`, then a
  `/` route of kind `project`), so it needs the Hosts part too; without it the project is made
  and shown nowhere until someone adds a route.
- **Delete differs from the plan**: refused while any route shows the project (the routes
  and hosts are the Hosts page's to remove), then the folder goes to `.trash/<name>--<when>`
  (root 700) and entries over 30 days go at the next delete.
- Tests: `test/projects-helper.test.ts` (18), `test/run-projects-builds-test.sh` (6 kinds
  for real: React/Vue/Svelte/Lit, Next.js export TS and JS, npm and pnpm; in build.sh),
  e2e-lfdln 16-projects (3), verify-lfdln: a throwaway project made, built, rebuilt, rolled
  back, deleted on the live box.

### 8b-3 design (2026-10-06)

Worked out from the code as it stands and tried on this server's git (2.43.0-1ubuntu7.3):

- **D3-1 Owners** (P8b-8): the record gets `owners` (panel usernames; the maker first; a
  project made before 8b-3 gets its maker). The `projects` right still sees every project and
  makes new ones; Rebuild, Roll back, Delete, Put dev live, the dev branch on or off and the
  owners themselves need being an owner or an admin. The panel checks it (the helper doesn't
  know who's an admin); an owner can't take away the last owner.
- **D3-2 A group per project**: `lfdln-p-<name>` (cut to 32 with a short hash for long
  names), members `svc-lfdln-apps` and the owners who have a Unix account (same name, uid
  1000-59999, a login shell). The helper sets the whole list (`gpasswd -M`) whenever the
  owners change.
- **D3-3 The repository's modes**, tried with a second uid: git updates `main` by locking
  `HEAD.lock` in the repository's top folder, so that folder must be group-writable. It is
  **3770** (setgid and sticky): a pusher can make and remove their own lock files but can't
  rename, replace or delete `config`, `HEAD` or anything else they don't own. `config`,
  `HEAD`, `hooks/` and `info/` are not group-writable; `objects/` and `refs/` are (setgid).
  `core.sharedRepository=0664` (what a pusher writes is group-writable, and readable inside the
  build box, where only svc-lfdln-apps' own uid exists), `receive.denyDeletes` (no branch
  deletes, so `packed-refs` is never rewritten by a pusher), `receive.autogc=false` (a pusher
  never repacks), `core.hooksPath` = the release's `git-hooks/` (root's).
- **D3-4 Who may push is checked by git itself**: git refuses a repository owned by another
  user ("dubious ownership") unless it is a `safe.directory`. `/etc/gitconfig` includes
  `/etc/lfdln-projects/gitconfig` (the installer adds the line once), which the helper writes:
  one `safe.directory` per project's repository, nothing wider.
- **D3-5 The push hook** (`post-receive`, run as the pusher): a push to `main` or `dev`
  writes one file, `<project> <branch> <commit>`, into **`/run/lfdln-projects/pushes/`**
  (tmpfiles: root:lfdln-git **1730**: the members of `lfdln-git` may only drop files in it,
  not list or touch others'). `lfdln-git` = svc-lfdln-apps + every project group's Unix
  people (the helper keeps it). A **path unit** (`lfdln-projects-pushes.path`,
  `DirectoryNotEmpty=`) starts the helper if it isn't running; while it runs it watches the
  folder. Each file is read and removed; it counts only if its owner may push to that
  project (in its group, or svc-lfdln-apps) and the project has that branch; a build of that
  branch already waiting takes it instead of a second. The job says who pushed.
- **D3-6 The helper's own git** (Put dev live, the dev branch) runs as svc-lfdln-apps with
  `-c core.hooksPath=/dev/null`, so nothing a pusher could leave in the repository runs as it.
  A repository with a `commondir` or `gitdir` file in its top folder is refused (the one
  file a pusher could add there that changes what git reads).
- **D3-7 The dev branch**: New project has **Dev branch** (on by default): after `main` is
  built, `dev` = `main`, built into `releases/dev`, and, with Hosts, a host `<name>-dev`
  showing it, set to **Only people let in**. A `dev` route sends `X-Robots-Tag: noindex,
  nofollow`. Per project **Turn the dev branch on/off** (off is refused while a route shows
  it; the git branch stays). **Put dev live** (owner or admin, a fresh passkey): `main`
  fast-forwarded to `dev` (`update-ref` with the old value, so a push in between makes it
  fail, not lose work), refused if they have diverged ("merge main into dev first"), then
  `main` built.
- **D3-8 Differs from P8b-2: owners aren't let in automatically.** A preview's visitors are
  the gate's accounts; panel users have no email or other link to them, so the panel can't
  tell which visitor is which owner. The project's page links to the preview's People list
  (the route's area), where an owner lets in their own visitor account like anyone else's.
  momolig 2026-10-06: fine for now; **later**, link panel accounts to visitor accounts so
  owners get into previews by themselves.
- **D3-9 Projects made before 8b-3** get their group, modes and owners the first time the
  new helper starts (a `share` job per project); dev stays off for them until turned on.
- **D3-10 Clone addresses** on the project: `ssh://<you>@lesfleursdelanuit.com/srv/lfdln-projects/<name>/repo.git`
  for owners with a Unix account (HTTPS with tokens is 8b-7).

### 8b-3 as built (2026-10-06)

- **The helper** (`packages/projects/src/helper/ops.ts`): ops `owners`, `dev` (on/off),
  `promote`, `pushes` (drain the spool now); `start()` shares projects made before 8b-3 and
  watches the spool (inotify, and every minute). Root runs only `groupadd`/`gpasswd`/
  `groupdel` and writes `/etc/lfdln-projects/gitconfig`; the repository's modes and every git
  command are svc-lfdln-apps'. `list` also says each project's group, its owners who may push
  (`pushers`), and the projects still being made (`making`).
- **Fixed from 8b-2**: New project made its host's route while the project was still being
  made, which the route kind refused ("That project isn't there"); the e2e stand-in built
  too fast to show it. A project being made is now listed, and a route may show it at once.
- **`git-hooks/post-receive`** (in the release, root's), `lfdln-projects-pushes.path`,
  `/etc/tmpfiles.d/lfdln-projects.conf`; install-projects.sh makes `lfdln-git` and adds the
  `/etc/gitconfig` include. `X-Robots-Tag` joins the headers a route may send.
- **The page**: New project's **Dev branch** (on), the `-dev` host made with *Only people
  let in* (taken away again if that can't be set); per project **Put dev live** (fresh
  passkey), **Details**: releases of each branch, the dev branch on/off, **Owners** (add,
  remove, never none), the SSH clone address for owners with a Unix account. Buttons that
  change a project are off for people who don't own it. The Hosts page's "Show a project"
  offers each project's dev branch too.
- Tests: `test/projects-helper.test.ts` (+13: groups, sharing, owners, Put dev live
  incl. a push racing it, commondir refused, the spool's files incl. a link and a
  non-member's, dev off/on, D3-9, the hook run by a real `git push`), e2e-lfdln 16-projects
  (+1), verify-lfdln: the spool, the path unit, git's include, the repository's modes, and a
  real push to dev as svc-lfdln-apps through the hook, then Put dev live.
- **Not checked by a test**: a push by SSH as a person (verify pushes as svc-lfdln-apps, the
  same hook and spool); try it with momolig's account once installed.

### 8b-4 design (2026-10-06)

Split in two, each its own release: **8b-4a** Next.js servers; **8b-4b** the Environment page
and monitoring each project's server.

8b-4a, from exam prep's install.sh (the shape) and the services helper (the controls):

- **D4-1 Made**: kind `next`: `create-next-app` as for the export, with `output: 'standalone'`.
- **D4-2 Built**: the box runs `next build`, then lays out `.next/standalone` with
  `.next/static` and `public/` beside `server.js` in `releases/<branch>/<id>/`. On the host,
  svc-lfdln-apps builds the **release image** `localhost/proj-<name>:<branch>-<id>` from
  it (`node:24-bookworm-slim`, the build image's own base, `--pull=never`; root owns the
  code, it runs as `node`), then the folder goes (the image is the release). Kept: 3 per
  branch, as for static; a release let go takes its image with it.
- **D4-3 Two ports per branch** (P8b-6), given when the project (or its dev branch) is
  made: slot a and slot b. Each slot is a Quadlet, `proj-<name>-<branch>-<a|b>.container`
  (exam prep's: 127.0.0.1:<port> to 3000 inside, `slirp4netns:allow_host_loopback` for the
  databases of 8b-5, ReadOnly, /tmp and `.next/cache` in memory, all capabilities dropped,
  512 MB and 1 CPU for main, 256 MB for dev, a health check, `Restart=always`). Only the live
  slot's file is there, so only it starts with the server.
- **D4-4 The switch**: the new release starts in the other slot; once `/` answers (2xx or
  3xx, within 90 s) nginx is pointed at it, then the old slot stops and its file goes. If it
  never answers, it is stopped and nothing changed. nginx is pointed through an **upstream
  per branch**, `lfdln-project-<name>-<branch>`, in `/etc/nginx/lfdln-projects/<name>-<branch>.conf`
  (included at http level by `conf.d/lfdln-projects.conf`), which the projects helper writes,
  `nginx -t`, then reloads (the old file put back if nginx refuses). The route itself never
  changes, so the routing helper isn't asked.
- **D4-5 Upstreams exist from the start**: written when the project is asked for (before
  its job runs), so New project can make its route at once, as for static; until a release
  runs, nginx answers 502. A project that fails to be made keeps its upstream pointing
  nowhere (`down`), never at a port another project may get; it goes with a later delete of
  that name, or is taken over when the name is made again.
- **D4-6 Roll back** = the kept release's image switched in the same way (no build).
- **D4-7 Start / Stop / Restart** the live slot (as the services helper: stop = stop, then
  mask, so it stays stopped after a reboot; start = unmask, start, wait until it answers).
  A deploy starts a stopped branch.
- **D4-8 Logs**: each build's log (as now) and the server's live log (the journal of its
  live slot's unit, last 200 lines).
- **D4-9 The route**: kind `project` with `serve: 'proxy'` for a server: `proxy_pass` to the
  upstream, websockets, the identity headers as a service route's (accounts work the same).
- **D4-10 Delete / dev off** stop both slots, remove their files, images and the upstream
  (refused while a route shows it, as now).

8b-4b, decided now:

- **D4-11 Environment, per branch**: names `[A-Z_][A-Z0-9_]*`, one line each, at most 100;
  `PORT`, `HOSTNAME`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` are the panel's. Kept by the
  helper (`/var/lib/lfdln-projects/env/<name>.json`, root 600). *Run time*: an env file,
  `/srv/lfdln-projects/<name>/env/<branch>.env` (svc-lfdln-apps, 600), the Quadlet's
  `EnvironmentFile=`; *build time*: handed to the build box with `--env-file`, gone after.
  **Differs from the plan's "podman secrets"**: a secret per variable adds files and
  steps for no one who can't already read the env file (only svc-lfdln-apps and root can).
  Masked on the page; revealing one needs a fresh passkey; a warning on `NEXT_PUBLIC_` /
  `VITE_` (in the files every visitor gets). A change says what it takes: Restart (run
  time) or Rebuild (build time).
- **D4-12 Monitoring**: a `projects` group: each running branch's live slot active and
  answering.

### 8b-4a as built (2026-10-06)

- **The helper**: kind `next` made (`output: 'standalone'`), built into `build/out/<id>`
  (never nginx's to read), its image built with `--pull=never` from `CONTAINERFILE`, the
  folder gone after; `deploy()` = the other slot's Quadlet, `restart`, asked until it answers
  (`/` below 500, 90 s), the upstream written + `nginx -t` + reload (put back if refused),
  then the old slot stopped, unmasked and its file removed. Ops `control` (start/stop/
  restart, as jobs, so never across a deploy) and `logs` (both slots' journal). `list` adds
  each server branch's live slot as systemd sees it (asked at most every 5 s).
- **Upstreams** (`/etc/nginx/lfdln-projects/<name>-<branch>.conf`, `conf.d/lfdln-projects.conf`
  includes them) are written as a server project is asked for; the ports are taken then too.
- **Route**: `serve: 'proxy'` (routes made before have none: files).
- **The page**: Next.js (a server) in New project; Details: **Its server** per branch
  (running/stopped, port, Start/Stop/Restart, **Server log**). New project now says when a
  name is one the site keeps (`panel`, `www`, `api`, `mail`) instead of making the project
  and failing on its host.
- `install-projects.sh`: the include, and `node:24-bookworm-slim` in svc-lfdln-apps' podman.
- Tests: `test/projects-helper.test.ts` (+12), the builds test runs a real Next.js server
  (pnpm, standalone, the helper's own Containerfile, read-only, no capabilities, answers / and
  its health check), e2e-lfdln 16-projects (+1), verify-lfdln: a throwaway server made,
  checked (unit, port on 127.0.0.1 only, upstream, nginx -t, read-only, user node, no caps),
  rebuilt into slot b (upstream follows, slot a gone, old port silent), stopped (masked),
  started, its log, rolled back into slot a, deleted (no unit, upstream, image left).
- Also: the helpers' names in their "isn't answering" errors no longer say "The the".

### 8b-4b as built (2026-10-06)

- **The store** (D4-11): `/var/lib/lfdln-projects/env/<name>.json`, root's, 600, written whole
  by the helper (one change at a time, never queued behind a build: a change is quick).
  Names `[A-Z_][A-Z0-9_]{0,127}`, values one line (no CR, LF or NUL), 4096 characters at most,
  100 a branch. Refused: `PORT`, `HOSTNAME`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` (the
  release image's) and also `HOME` and `CI` (the build box's own, and a build's `-e` settings
  come after `--env-file`, so they win anyway).
- **Run time**: a server's `/srv/lfdln-projects/<name>/env/<branch>.env` (svc-lfdln-apps, 600:
  made empty with `install -m 600`, then filled, then one rename), written on every change,
  every deploy, and every Start/Restart; the slot's Quadlet has `EnvironmentFile=` it. Start and
  Restart write the live slot's Quadlet again first, so a slot made by 8b-4a (no
  `EnvironmentFile=`) gets it on its next Restart.
- **Build time**: `<name>/build.env` (beside the build folder, 600), handed to the box with
  `--env-file`, removed after; the job's log names the variables, never their values.
- **What a change takes**, said by the helper: a static project's, or a server's
  `NEXT_PUBLIC_`/`VITE_` ones: Rebuild; a server's others: Restart; a branch never built yet:
  nothing (its first build uses it).
- **Dev off** drops dev's variables and its env file; **Delete** drops the record (the env
  files go to the trash with the folder).
- **Ops**: `env` (names, and which are public), `env-values` (the values), `env-set` (value
  `null` removes it), `health` (each server branch with a release: systemd's view of its live
  slot, and `/` asked if it runs).
- **The panel**: `GET /api/projects/:id/env`, `POST .../env` (set or remove), `POST
  .../env/values` (a fresh passkey) -- each only for the project's owners or an admin.
  Activity: `project-env-set`, `project-env-removed` (`<branch>: <name>`), `project-env-shown`;
  never a value.
- **The page**: Details, **Environment** per branch: names, values as dots until **Show the
  values**, Change and Remove, Add with a warning on `NEXT_PUBLIC_`/`VITE_` names (and a badge
  on those set), what the change takes in the message after; Rebuild dev beside dev's.
- **Monitoring** (D4-12): a **Projects** group (between Services and the panel's own):
  `project:<name>/<branch>`, "<name> (live)" / "(preview)", up if its live slot is active and
  `/` answers under 500; stopped from Projects is stopped on purpose; quiet works on
  `project:<name>`. The projects helper not answering is its own row ("The projects
  helper"), the group left unread.
- Also (8b-4a, found by its install): a stopped slot's failed unit is reset (`reset-failed`),
  so a deleted server leaves nothing listed; verify-lfdln's route-kind check knows `project`.
- Tests: `test/projects-helper.test.ts` (+4: the rules, the store's mode, the env file as
  svc-lfdln-apps, `--env-file` before the box's own settings and removed after, the Quadlet,
  Restart rewriting it, health, dev off, delete), `test/monitoring.test.ts` (+1), e2e-lfdln
  16-projects (+1: names, dots, a fresh passkey to show, the public warning, remove, Activity
  without values), verify-lfdln: a variable set on the throwaway server (store root 600, env
  file svc-lfdln-apps 600, the list never has the value), Restart, `podman exec printenv` sees
  it, health says it runs and answers, the record gone with it.

### 8b-5 design and as built (2026-10-06)

From the plan (Database, P8b-5), and decided while building (D5-x; momolig to confirm):

- **D5-1 Where**: lfdln-appdb (Postgres 17, :5436) or lfdln-appmaria (MariaDB 11.4, :3308),
  chosen per branch; only a server project (kind `next`) has one.
- **D5-2 Names**: `proj_<name>` (main) and `proj_<name>_dev` (dev), dashes as `_`; logins
  `db_proj_<name>[_dev]_owner` and `_app` (the `db_` prefix keeps pg_hba's rule for Studio
  logins, P8-15). The helper's rules (sites/lfdln/src/studio-site.ts `PROJECT_NAMES`) make
  every `proj_` database a **managed** one: the Studio lists and reads it ("a project's: read
  only"), never makes, drops or changes it; `db_proj_` logins are never the Studio's to make,
  drop or reset. Only the new op makes them.
- **D5-3 The op**: the database helper's `project-database` (engine, name, both logins, both
  passwords): the database if missing, each login made or its password set anew, owner
  **Administrator**, app **Read & write** (the Studio's own grants). Made again it takes up
  what is there (a database kept from an earlier project of that name) with new passwords;
  it never drops anything.
- **D5-4 Postgres's tables made later**: default privileges belong to the role that makes the
  tables (the owner login, through its migrations), and only that role may set them. The
  studio role is granted the owner login `WITH INHERIT FALSE, SET TRUE` (it gets none of its
  rights by membership; as CREATEROLE maker it could grant itself that anyway) and, for one
  transaction, `SET LOCAL ROLE` to it: what the owner makes, the app may SELECT, INSERT,
  UPDATE, DELETE (and use the sequences), the Studio SELECT. Tried on PG17 first: `FOR ROLE`
  needs INHERIT, plain membership isn't enough. MariaDB's grants are per database: nothing more.
- **D5-5 The environment**: `DATABASE_URL` (the app login: rows) and `DATABASE_OWNER_URL` (the
  owner login: migrations), `postgres://` or `mysql://`, host `10.0.2.2` (the container's way
  to the host, as exam prep's), set in the branch's environment (8b-4b): a Restart uses them.
  The panel makes the passwords (32 letters and digits, as the Studio's: its own copy, so
  Projects needs no Studio module). Running migrations stays the project's own business (its
  start script, or an owner by hand).
- **D5-6 dev on the live database** (P8b-5): **Use the live database** (a fresh passkey, a
  warning that live data changes with the preview): dev's two variables become main's, its
  record says `shared`. **Stop using** removes them; dev's own database, if it had one, is
  still there (made again, taken up).
- **D5-7 Kept**: Delete and dev off never drop a database (the delete dialog says so); the
  record keeps `database` per branch (`{engine, name, owner, app, at, by, shared?}`), the
  helper's `database` op writes it. Removing one for good: the engine's admin, by hand.
- **D5-8 Who**: the project's owners and admins; the Studio module or right isn't needed
  (its page links **In the Studio** for those who have it).

As built:

- Helper (`packages/studio/src/pammydb`): `NameRules.projects`, `isProjectDb`, `managedSchema`,
  `checkProjectNames`; `checkManageableUser` refuses project logins; driver `projectAccess`
  (Postgres); op `projectDatabase`; the list's `projectOwned`; the Studio's pages say "a
  project's".
- Projects: record `BranchDatabase`, helper op `database`; panel `POST /api/projects/:id/database`
  (`{branch, engine}`) and `POST .../database/share` (`{on}`, a fresh passkey); Activity
  `project-database`, `project-database-shared`, `-unshared`; the page's **Database** block
  (per branch: none, Make a Postgres / MariaDB database; the database, its logins, In the
  Studio; dev: Use / Stop using the live database).
- Tests: `test/projects-db.test.ts` (new: the names, the URLs and passwords, and on real
  Postgres 17 and MariaDB 11.4: made, owner makes tables, app reads and writes but changes no
  structure and reaches no other database, the Studio reads, refuses every change, made
  again keeps the tables with new passwords, bad names refused), `test/projects-helper.test.ts`
  (+1), e2e-lfdln 16-projects (+1), verify-lfdln (the op on both live engines, each login as a
  server uses it, the Studio's refusals, then removed by the engines' admins).

### 8b-6 skipped for now (2026-10-06)

momolig: "we can skip the laravel projects for now". 8b-8 next; 8b-7 and 8b-9 after.

### 8b-8 design and as built: 8b-8a (2026-10-06)

Split in two, each its own release: **8b-8a** Packages and Scripts; **8b-8b** Updates (the
nightly check, majors on dev) and the build sandbox's network narrowed to the registries (P8b-11).

Decided while building (D8-x; from platform-plan G9 "The Packages page" and this plan):

- **D8-1 Where**: its own page, `/projects/<name>/packages` (a **Packages** button on each
  project); anyone with the Projects part sees it, its owners and admins change it.
- **D8-2 Which branch**: changes go to `dev` when the project has it (tried on the preview
  first), else `main`; the page checks and shows that branch.
- **D8-3 The registry** is asked from a short box (`packages.mjs search|about`: no folders,
  read-only, 256 MB, a minute), never queued: the helper itself reaches only localhost. About a
  package: latest, first published, weekly downloads, licence, size, types (its own, or the
  `@types/` package offered for TypeScript projects), and the warnings, shown and never
  blocking: new (< 30 days), few users (< 500 a week), one letter from a popular name
  (`container/popular.json`, 190 names; Damerau-Levenshtein 1), deprecated, an uncommon or no
  licence, install scripts.
- **D8-4 A change** (add, several at once; update one to its latest, or all within their
  ranges; remove; fix security issues, npm's non-breaking `audit fix` or pnpm's `audit --fix`) is
  a job: in the box with the repository writable and the branch's environment, npm or pnpm by
  its lockfile, `package.json` and the lockfile committed as the person who asked
  (`<username>@panel.lesfleursdelanuit.com`, as the first commit), pushed fast-forward only
  (a push in between makes it fail, nothing lost). Then built, as a push would be. A failed
  build puts the branch back (`update-ref` with the commit expected, so a later push is never
  undone) and the job says so. Nothing changed: no commit, no build.
- **D8-5 The check** (`packages.mjs check`, a job): the branch cloned, installed from its
  lockfile with scripts off, `outdated` and `audit` (both pms' JSON read), latest and
  deprecated from the registry's short metadata; kept in `/var/lib/lfdln-projects/packages/
  <name>-<branch>.json` (root 600); run again after every change.
- **D8-6 Scripts**: each script of `package.json` has Run (a job: installed with scripts, the
  branch's environment, 15 minutes, the output in the job's log); `dev`, `start`, `preview`,
  `serve` are refused (they serve and never finish).
- Activity: `project-packages` (what changed), `project-script` (which).

As built: `packages/projects/container/packages.mjs` (+ `popular.json`, `packages.d.mts` for
the tests), helper ops `packages`, `packages-check`, `packages-change`, `script`,
`package-search`, `package-about`; the record's `PKG_NAME_RE`, `PKG_SPEC_RE`, `SCRIPT_RE`,
`LONG_RUNNING` (the box keeps the same: a test says so); panel `GET /api/projects/:id/packages`,
`POST .../packages/check`, `POST .../packages` (`{change}`), `POST .../scripts/run`,
`GET /api/projects/packages/search|about`; the jobs list moved to `web/components/jobs.tsx`;
the Packages page. Tests: projects-helper (+9: the rules match, the warnings, check, change
then build, a failed build undone, nothing changed, scripts, the registry box, dev off and
delete), the real builds test (+3: on a pnpm and an npm project, checked, `ms` added and removed
as two commits, `build` run as a script; the registry's search and details, a name nobody has),
e2e-lfdln 16-projects (+1), verify-lfdln (on the live throwaway project: checked on dev, `ms`
added as a commit then built, a version that doesn't exist refused with dev left alone, a
script run, `dev` refused, the registry asked).

### 8b-8b design and as built (2026-10-06)

Decided while building (D8b-x; P8b-11 and platform-plan G9 "Updates"):

- **D8b-1 The builds' network** (P8b-11): every box (build, starter, check, change, script, the
  registry box) is on `lfdln-build`, an **internal** podman network (no route out; tried on
  this server's podman 4.9.3 first: `ENETUNREACH` from a box, the proxy's name resolves).
  Its one way out is **lfdln-build-proxy** (`container/proxy.mjs`, ~70 lines of Node): HTTPS
  `CONNECT` to port 443 for the hosts in `container/proxy-allow.txt`, nothing else (no plain
  HTTP, no other port), each refusal in its log. svc-lfdln-apps' Quadlets
  (`packages/projects/deploy/lfdln-build.network`, `lfdln-build-proxy.container`: on
  `lfdln-build` and podman's own network, read-only, as `node`, no capabilities, 128 MB),
  installed and restarted by `install-lfdln.sh` with each release.
- **D8b-2 The allow-list**: registry.npmjs.org, registry.yarnpkg.com, api.npmjs.org (download
  counts); github.com, codeload.github.com, objects.githubusercontent.com,
  raw.githubusercontent.com (git dependencies, release binaries); nodejs.org (node-gyp headers);
  fonts.googleapis.com, fonts.gstatic.com (`next/font/google` at build time); binaries.prisma.sh.
  A change is a release.
- **D8b-2b Names**: the proxy looks hosts up at the server's own resolvers (`PROXY_DNS`, the
  IPv4 nameservers of systemd-resolved, put into its Quadlet by `install-lfdln.sh`), a failure
  tried again and then the container's own lookup. Found by the builds test (twice, the same
  place, its log saying `EAI_AGAIN`): on two networks the container's only resolver is the
  internal network's forwarder (10.89.x.1), which fails under a burst of lookups. Tunnels close
  whole when either side ends, idle ones after a minute; many open at once is logged.
- **D8b-3 The boxes** get `HTTPS_PROXY`/`HTTP_PROXY` (both cases), `NO_PROXY=localhost`,
  `NODE_USE_ENV_PROXY=1`: npm, pnpm and git read them, and Node 24's own `fetch` (the registry
  box) with the last. **Check the build environment** says when the proxy isn't running;
  monitoring's Projects group has its row (from the helper's health).
- **D8b-4 Each night** (the helper, every ten minutes: from 03:00 server time, once a day,
  `nightly.json`): every project's packages checked on the branch changes go to, as a
  `nightly` job; a project that says so (**Each night, update…**, `autoUpdate` in the record)
  then gets `update: 'all'` (within its ranges) through the same change: committed as `panel`,
  built, undone if the build fails. Off by default (with no dev branch it goes live).
- **D8b-5 What it found**: the Projects list's rows say **security: N** and **N updates** from
  the last check.
- **D8b-6 A new major version** of Next.js, React or Vite: **Upgrade Next.js to 16** upgrades
  it with its companions that the project has (Next.js: eslint-config-next, react, react-dom,
  their @types; React: react-dom and the @types; Vite: its plugins, @tailwindcss/vite, vitest)
  to their latest, as one change on dev (undone if the build fails), with a link to the
  framework's upgrade guide. **Differs from G9**: the official codemods (`@next/codemod
  upgrade`) aren't run; they ask questions as they go, and nobody is there to answer.

As built: `proxy.mjs` (+ `proxy-allow.txt`, `proxy.d.mts`), the Quadlets, ops.ts
`BUILD_NETWORK`, `BUILD_PROXY`, `proxyArgs`, `buildNetwork` (a dep: the tests' own network),
`proxyUp`, `changeAndBuild` (the change flow, shared), `summaryOf`, `nightly`; ops
`auto-update`, `nightly` (now, for verify and the tests); `health` says `proxy`; panel
`POST /api/projects/:id/auto-update`; Activity `project-auto-update-on|off`; the Packages
page's **Updates**. Tests: projects-helper (+5: every box on the network with the proxy, the
summary, the nightly run with and without auto-update, the proxy's list and refusals on a real
socket), monitoring (+1), the real builds test now runs every box behind a proxy of its own on
an internal network (all seven kinds made and built through it, Next.js's fonts too; the
packages flows; the registry) plus a check of the proxy itself, e2e-lfdln 16-projects (+1),
verify-lfdln (the Quadlets, the proxy running read-only as node, the network internal, a box
reaching nothing alone, the registry through the proxy but not example.com, the refusal in its
log, health's row).

### 8b-7 design (2026-10-06)

Decided while building (D7-x, momolig to confirm), from "Git from people's own computers":

- **D7-1 The address**: `https://git.lesfleursdelanuit.com/<name>.git`, one nginx site of its
  own (`site/git.conf` from `packages/projects/nginx/git.conf`, rendered only where the
  `projects` module is on, so pammy.org's files don't change), installed with the panel's as
  `lfdln-git`, under the same `nginx -t`. The wildcard name and certificate cover it. `git` joins
  the names no host may take. **Differs from the plan's "a host the panel makes"**: it is the
  panel's own fixed site, like `panel.`, not a row on the Hosts page (nothing on it is the
  owner's to change).
- **D7-2 Tokens are panel people's**, not visitors': **Projects > Your git tokens** (anyone with
  the Projects part): a label, made after a fresh passkey, shown once
  (`lfdln_git_` + 32 random bytes, base64url), kept as its SHA-256 (the token is long and
  random, so a slow hash adds nothing), at most 10 per person, each revocable. An expiry date is
  chosen when it is made: 30 days, 90 days (the default), a year, or never. The page shows when each was
  last used. Table `panel.git_tokens` (projects' first migration); a person turned off or
  deleted stops their tokens at once (the check reads `users.active`; delete cascades).
- **D7-3 Who may do what** (the same as the panel): **read** (clone, fetch) = anyone with the
  Projects part (they see every project there, P8b-8); **push** = the project's owners and
  admins (D3-1). Git's user name must be the panel username the token belongs to (so a wrong
  pairing says so instead of passing quietly).
- **D7-4 The check**: nginx's `auth_request` asks the panel (`GET /api/projects/git-auth`,
  `X-Original-URI`, the client's `Authorization`), which answers 204 with
  `X-Lfdln-Git-User: <username>`, or 401 (no or wrong token: nginx adds
  `WWW-Authenticate: Basic`, so git asks for the token) or 403 (may not). A push is
  `git-receive-pack` (the path or `?service=`). Failures are counted per address (20 in 10
  minutes, then 403 until the window passes: `auth_request` passes on only 401 and 403); successes aren't, nor git's first request without a token (git always asks without one first and sends it after the 401). The panel's own site answers
  that path with 404, so it is only reachable through the git site (and loopback).
- **D7-5 Who runs git**: `git-http-backend` under **fcgiwrap**, as **svc-lfdln-apps** (who owns
  the repositories), socket-activated: `lfdln-git-http.socket` (`/run/lfdln-git-http.sock`,
  root:www-data 660: only nginx connects) + `lfdln-git-http.service` (sandboxed: writes
  only `/srv/lfdln-projects` and the push spool, no network, 512 MB, 64 tasks). nginx fixes the
  script and `GIT_PROJECT_ROOT`; `REMOTE_USER` is the checked username, so `git-http-backend`
  takes pushes only after the check. The installer puts in the `fcgiwrap` package (apt, as
  install-panel.sh does for its own) and turns off the package's own socket and service
  (www-data, unused).
- **D7-6 The repository and hooks are 8b-3's**: `core.hooksPath` (root's), `denyDeletes`,
  `autogc=false`, `sharedRepository` all hold for HTTPS pushes; nothing new is writable.
- **D7-7 Who pushed**: the hook adds ` via <username>` when git gives it `REMOTE_USER`; the
  helper believes it only from svc-lfdln-apps' files (the HTTPS ones), so a job says
  "ericka pushed dev (over HTTPS)", not "svc-lfdln-apps".
- **D7-8 Size**: a push up to 200 MB (`client_max_body_size`), streamed (no request
  buffering), 10 minutes; a clone streamed too.
- **D7-9 The page**: each project's **Clone** box shows the HTTPS address for everyone (with
  "make a token") and the SSH one for owners with a Unix account, as now. Activity:
  `git-token-made`, `git-token-revoked` (never the token).

### 8b-7 as built (2026-10-06)

- **The panel**: `packages/projects/src/git-auth.ts` (tokens, git's Basic header, which requests
  are git's, the failure counter), `panel/routes/git.ts` (`GET/POST /api/projects/git-tokens`,
  `POST .../:id/revoke`, `GET /api/projects/git-auth` for nginx), migration
  `projects/0001-git-tokens.sql`; pages `/projects/git-tokens` (**Your git tokens**, linked from
  the Projects page and each project's clone box) and each project's HTTPS clone address;
  Activity `git-token-made` / `git-token-revoked`. `git` joins the names no host may take.
- **nginx**: `packages/projects/nginx/git.conf` -> `/etc/nginx/sites-available/lfdln-git`
  (installed with the panel's site under one `nginx -t`); the panel's site answers
  `/api/projects/git-auth` with 404. Found while testing: nginx's stock `fastcgi_params` sets
  `REMOTE_USER` from the name the client typed, and every request header (the token in
  `Authorization`) would reach git's environment; the git site sends neither (its own params,
  `fastcgi_pass_request_headers off`, only `Content-Encoding` and `Git-Protocol` passed on).
- **fcgiwrap**: `lfdln-git-http.socket` / `.service` (packages/projects/deploy);
  install-projects.sh installs the `fcgiwrap` package with its own units masked first.
- **The hook** adds ` via <user>` from `REMOTE_USER` (2-32 characters, a panel username); the
  helper believes it only from svc-lfdln-apps' files, and checks who may drop a push by the
  file's owner, as before.
- **Fixed on the way**: `/projects/:id/packages` (8b-8a) wasn't in the server's list of pages, so
  opening it from the address bar (or reloading it) gave 404.
- **Tests**: `test/git-auth.test.ts` (7), projects-helper (+2: the helper's "via", the real hook
  with REMOTE_USER), e2e-lfdln 16-projects (+1: the tokens page and the check through the panel;
  the Packages page reloaded), **`test/run-git-nginx-test.sh`** (27: the rendered git site on a
  real nginx, the real git-http-backend behind a FastCGI stand-in for fcgiwrap
  (`test/fcgi-cgi.ts`), real git clones and pushes; what git was handed, request by request),
  migrations and schema snapshot; verify-lfdln (the masked package units, the socket's owner and
  who may open it, the service's sandbox, the git site, a real HTTPS clone by a throwaway panel
  person, their push refused until an owner, then built through the hook as them, the token
  stopping when they are deleted).

### 8b-9 design and as built (2026-10-06)

Narrowed while building (D9-x, momolig took "your suggestions" 2026-10-06): **the table's
owner moves; nothing else does**.

- **D9-1 The direction**: the hosts module needs the files module (`NEEDS.hosts = ['files']`,
  `@panel/hosts` depends on `@panel/files`), not the other way. A first try moved the folder
  route kind and the Site folders endpoints into files (files needing hosts) and was dropped:
  pammy.org has Files on and the hosts module off, so its profile would no longer be valid.
  lfdln has both on; pammy.org's site imports the hosts package without the module, as before.
- **D9-2 What moved**: every read and write of `panel.site_folders` is in
  `packages/files/src/site-folders/store.ts` (list, by id, by name, add, PHP on/off, drop).
  The table keeps its name, rows and constraints (made by `hosts/0001`; no migration, no
  copy). `routes.folder_id` still points at it (`ON DELETE RESTRICT`).
- **D9-3 What stayed in hosts**: the folder route kind (both halves), the Site folders
  endpoints (same addresses and answers), adopt-folders, take-over, the renderer and the
  table the routing helper takes; they call the store. The site's three queries that joined
  `site_folders` (File Explorer's places, a file's addresses, a route's folder for its
  pammy-panel.json) moved out of `sites/lfdln/src/app.ts` into
  `packages/hosts/src/panel/folders-shown.ts` (routes from hosts, names from the store), so the
  site has no SQL on either table.
- **D9-4 Checked**: a boundary test lets only the store touch `site_folders` (master plan rule
  1, first table; C1 widens it). Migration order unchanged (files was already before hosts).
  Unit 1488/1488; the hosts tests (API answers, adopt, take-over, nginx byte-for-byte after
  hosts 0005) unchanged and passing.
- Not done (later, with C1/K-b if wanted): one folder model for both panels (pammy.org's
  folders are a path under `/pamela/public`, with no rows), and the folder route kind as the
  files module's own (it would need hosts' rendering blocks in a shared place first).

## Questions for momolig

- **P8b-1. The preview's address**: `<name>-dev.lesfleursdelanuit.com` (one level, the wildcard
  covers it) rather than `dev.<name>.` (needs a certificate per project)? Suggested: `-dev`.
- **P8b-2. Who sees a preview**: visitors the owners pick, through the route's accounts (they
  sign in like any visitor)? Or anyone with a panel account only? Suggested: picked visitors,
  with the owners added for them automatically.
- **P8b-3. Ports**: projects take 4200-4999, two per branch per server project at most;
  4100-4199 for services made by hand? Suggested: yes.
- **P8b-4. Laravel's runtime**: FrankenPHP in a container (PHP 8.4, its own extensions)
  rather than the host's php-fpm 8.3 (no extensions, no network, shared by every site folder)?
  Suggested: the container.
- **P8b-5. Per-branch environment and database**: dev gets its own variables and its own
  database (made empty, migrations run)? Suggested: yes; a project may point dev at the live
  database if an owner says so (a fresh passkey, and a warning).
- **P8b-6. The switch for servers**: a few seconds of 502 while the new container takes the
  port (simple), or two ports per branch and nginx switched between them (no gap, a reload
  per deploy)? Suggested: two ports, no gap.
- **P8b-7. Laravel queues and the scheduler**: later (a step after 8b-6, a second container)?
  Suggested: later, when a project needs it.
- **P8b-8. Rights**: the `projects` right lets someone see every project and make new ones;
  changing one needs being its owner (or an admin)? Suggested: yes.
- **P8b-9. Exam prep**: leave it as it is (its own build and install), or make it a project
  later (its repository pushed into `repo.git`, its routes moved)? Suggested: leave it; maybe
  after 8b-4 proves itself. *Since decided (2026-10-06, projects-domains N-Q3 / PD-Q2): exam
  prep moves to Code in master-plan step N7.*
- **P8b-10. Lit**: as a static site (`create-vite` `lit` template: one web component on a
  page), the same as the others? Suggested: yes; SvelteKit, Nuxt and Astro later, one at a
  time, when someone asks.
- **P8b-11. Build sandbox network**: the build container reaches only the package registries
  (npm, packagist, GitHub for Composer dists) through an allow-list proxy, or the whole
  internet? Suggested: the whole internet in 8b-2 (simpler), the allow-list in 8b-8 with the
  Packages page.

## Not here

The browser editor (removed 2026-09-26), a GitHub link per project (later, G9 Q-J1), Node API
projects (Express, Fastify, Hono: G9 Q-J3, one template away once 8b-4 exists), Gitea, Ghost,
Umami, Laravel queues/scheduler (P8b-7), Composer packages page, pammy.org.
