# T1: a CI runner on this server

DECIDED 2026-10-06 (momolig: CI-Q1..CI-Q5 as suggested). Master plan Track T, step T1 (milestone M1's first step). momolig: *"okay,
let's start now"* (coding allowed for the steps that don't collide with phase 8b).

## What there is today (checked 2026-10-06)

- **No CI.** No `.github/`; every check runs from `panel/build.sh`, by hand, as momolig, in the
  worktree being built (about 13 worktrees exist).
- **`build.sh` is one serial pass of ~20 minutes** (build logs 06:03-06:22 and 06:43-07:03 on
  2026-10-06): typecheck (4 projects), front-end and widget builds, unit tests
  (`node --test test/*.test.ts`, ~85 files), six nginx harnesses, the move-db test (throwaway
  Postgres 15 and 17), tutorials, **real project builds (needs the internet)**, Playwright on both
  panels, then `release/` and `release-lfdln/`.
- **Tests need**: node ≥ 22.18, `npm ci`, nginx, rootless **podman** (Postgres, MariaDB, the build
  image), Playwright's Chromium in the user's `~/.cache/ms-playwright`.
- **Fixed ports** in the harnesses (`HTTP=18080`, `HTTPS=18443`, `APP=13144`, e2e servers), so **two
  runs at the same time on this server collide**. Today that is avoided only because builds
  happen one at a time by habit.
- Branches are local (worktrees share `~/pamela-setup/.git`); `main` is pushed now and then
  (26 commits ahead of GitHub today), worktree branches never.

## The design

### A local runner, not GitHub Actions

GitHub Actions only sees what is pushed, and most work here is never pushed (worktree branches).
A small **local runner** watches the shared repository instead:

- **`lfdln-ci.timer`** (every minute) starts **`lfdln-ci.service`**, which looks at every local
  branch's head in `~/pamela-setup/.git` and runs the **fast tier** for any commit it hasn't
  checked yet (newest first, one at a time).
- **The full tier** runs when asked: `lfdln-ci full <branch>` (writes a request file the service
  picks up), and before an install (section "Installs").
- Each run checks out the commit into the runner's own folder (`git worktree` from a read-only
  view of the shared `.git`: the runner never writes into `~/pamela-setup`).

### Its own user

- **`svc-ci`**: no login, no sudo, no access to secrets (`/etc/lfdln-panel`, `/etc/pammy-panel`,
  the hook keys, the database passwords), its own home `/var/lib/lfdln-ci` with its own
  `node_modules` cache, Playwright browsers and rootless podman (`subuid` / `subgid` ranges).
- **Read-only access to the repository** through an ACL on `~/pamela-setup/.git` (and passing
  through `/home/momolig`, `--x`), as monadelanuit has it but read-only.
- **Network**: allowed (npm, the project builds' registry downloads), like momolig's builds today.
- It runs code from any local branch, written by momolig, an AI session or monadelanuit; that is
  why it is a user of its own with nothing worth stealing.

### Limits, so live sites never feel it

`lfdln-ci.service`: `Nice=10`, `CPUWeight=20`, `CPUQuota=400%` (4 of 12 cores), `MemoryMax=6G`,
`IOWeight=20`, `TasksMax=2048`, a 60-minute `RuntimeMaxSec`. The live services keep their weights.

### Tiers

| Tier | What | Runs | Time (estimate) |
|---|---|---|---|
| **fast** | typecheck (4 projects), unit tests, the boundary test, nginx snapshot tests | every new commit on any branch | ~5 min |
| **full** | everything `build.sh` runs except assembling `release/` | on request; before an install | ~20 min |

`build.sh` gains `--tier fast|full|release` (default `release`, so it works as today); the runner
calls `--tier full`.

### One test run at a time

Two runs at once collide on the fixed ports. Until the harnesses pick free ports (a later T step),
**one lock** covers every test run on the server: `flock /run/lock/lfdln-tests.lock`, taken by
`build.sh` and by the runner (the lock file group-writable for momolig and `svc-ci`). A build
started while CI is running waits (and says so), and the other way round.

### Results

- `/var/lib/lfdln-ci/results/<branch>/<commit>.json` (tier, passed / failed, each section's time,
  the failing section) and `<commit>.log`.
- **`lfdln-ci status`** (any user): every branch, its head, last fast / full result, how long ago.
  `lfdln-ci log <commit>` prints a log.
- A failing **fast** run on `main` mails momolig (the mail helper, once per commit).
- Later (O1): shown on Monitoring.

### Installs

`install-panel.sh` and `install-lfdln.sh` print whether the release's commit passed the **full**
tier. **Warn only at first**; after a week of T1 running, refuse unless `--without-ci` is given
(CI-Q4).

## Steps

| Step | What |
|---|---|
| T1-a | `build.sh --tier`, the shared test lock (no behaviour change for a plain `build.sh`) |
| T1-b | `svc-ci`, its podman / node / Playwright setup, the ACL, the units (an installer, `deploy/ci/install-ci.sh`, run with sudo) |
| T1-c | the runner (`tools/ci/runner.ts`), `lfdln-ci status / log / full`, results, mail on `main` failing |
| T1-d | installers print the CI result (warn) |

## Questions for momolig: all answered 2026-10-06 with the suggestions

### CI-Q1. A local runner rather than GitHub Actions
*Suggested: local* (most branches are never pushed; the tests need podman and this server's
nginx anyway).

### CI-Q2. Fast tier on every commit of every branch
Every commit an AI session makes triggers ~5 minutes of CPU (capped at 4 cores). **(a) every
branch** **(b) only `main` and branches named in a list**. *Suggested: (a)*, newest commit per
branch only (a burst of commits checks just the last one).

### CI-Q3. One lock for all test runs
*Suggested: yes now*; free ports in every harness later (T2 or after), then the lock can go.

### CI-Q4. Installs and CI
**Warn** for a week, then **refuse** without `--without-ci`. *Suggested: yes.*

### CI-Q5. Limits
4 cores, 6 GB, low priority. *Suggested: as written.*

## As built (2026-10-06, branch `ci-t1`; installed since, live 2026-10-08)

- **T1-a** `build.sh --tier fast|full|release` and the server's test lock
  (`/run/lock/lfdln-tests.lock`, taken just before the unit tests, let go after the browser
  tests; opened read-only, so whoever made the file, every user can take it). A plain
  `build.sh` does what it did. **The fast tier is about 1 minute**, not the 5 estimated: typecheck
  4 s, front end 3 s, widgets 2 s, unit tests 43 s (`node --test` runs the files in parallel; the
  80 engine tests run on real Postgres and MariaDB, none skipped).
- **T1-c** `tools/ci/runner.ts` (one look, at most one run: a request first, else the newest
  branch head of the last 7 days with no fast result; its own `git clone --shared`, `npm ci` only
  when `package-lock.json` changed; each `--- section`'s time recorded; results per commit as
  `<commit>.<tier>.json` and `.log`) and `tools/ci/cli.ts` (`lfdln-ci status | log | full |
  check`). Tried end to end as momolig with scratch state: a fast run of `ci-t1` passed in 57 s.
  `test/ci-runner.test.ts`: the choice of what runs.
- **T1-b** `deploy/ci/install-ci.sh` (sudo): `svc-ci` (system user, `/var/lib/lfdln-ci`, no
  login), a subuid / subgid range, linger, the slice caps (`user-<uid>.slice.d`), the read-only
  ACL on `~/pamela-setup/.git` and `safe.directory`, `results/` and `requests/` (momolig may
  write requests), the runner copied to `/opt/lfdln-ci`, `/usr/local/bin/lfdln-ci`, the four
  images pulled, **user units** `lfdln-ci.service` (oneshot) and `.timer` (every minute) in
  svc-ci's own systemd, as the other service users run their podman; its checks at the end.
- **T1-d** `install-panel.sh` and `install-lfdln.sh` print `lfdln-ci check` for the release's
  commit (warning only), or say a dirty build can't have been checked.
- **Commits from before T1** (their `build.sh` ignores `--tier` and would build a whole release,
  without the lock) are written down as **skipped (no --tier)**, never run; a branch is checked
  once it has merged `main` after T1. Tried on the 13 local branches: all skipped in 0.2 s.
- **Changed from the design**: the mail on a failing `main` is left to O1 (svc-ci is not, and
  should not be, in the mail socket's group); results are seen with `lfdln-ci status` until then.

# T2: the contract-suite kit

DECIDED 2026-10-06 (momolig: *"start working on the t2 with your suggestions"*, so T2-Q1..T2-Q4
below are taken as suggested). Master plan Track T, step T2; module-contracts-plan.md, "The 18
contracts" and module rule 14 ("both engines"). Branch `t2-contract-kit`.

## What it is

- **`test/contract-kit.ts`**: `runContractSuite(suite, impl, engines = BOTH)`. A **suite** is a
  contract's name, an optional `setUp` per engine and named cases; an **implementation** is a
  name and `make(ctx)` (and `close`). The kit makes one `describe` per contract × implementation
  × engine, cases named `<case> (<engine>)`. Each suite gets, per engine, a database name of its
  own (`ck_<contract>_<pg|my>_<n>`) and the engines' admins (`ctx.engines`).
- **Rule 14 is the default**: a suite runs on Postgres and MariaDB; running on one engine is
  refused unless the implementation gives `oneEngine: '<why>'` (an external store that is
  Postgres only, say).
- **One pair of engines per test file** (`node --test` runs each file in its own process),
  started on first use by `test/pammydb-harness.ts` and stopped after the file's last suite.
- **`test/engine-images.ts`**: the images the tests start are **read from the live Quadlet
  files** (`lfdln-appdb`, `lfdln-pg`, `pammy-pg`, `pammydb-postgres`; `lfdln-appmaria`,
  `pammydb-mariadb`), and every Quadlet of an engine must name the same series
  (`test/contract-kit.test.ts`). Both harnesses (`pammydb-harness.ts`, `pg-harness.ts`) use it,
  so a test can't run on a version the server doesn't.
- **The running engines** are compared by `verify-lfdln.sh` (root, so it can ask Postgres):
  lfdln-appdb and lfdln-appmaria must be of the series the tests use (a FAIL otherwise); when
  svc-ci's image has another patch release, a note says so.
- **The first suite**, `test/contract-rows.test.ts`: the rows half of contract 1 (data store
  adapter), against today's Studio driver with pammy.org's and lfdln's name rules, on both
  engines (state, introspect, insert, get, update, list + search + count, delete).

## Questions: taken as suggested

- **T2-Q1. Which tier runs the suites?** *Suggested: fast*, with the other unit tests. The plan
  had engines in the full tier, but as built (T1) the ~80 engine tests already run in the fast
  tier in well under a minute (random ports, tmpfs); moving them out would only hide failures.
- **T2-Q2. Pin images to a digest?** *Suggested: no*, the series tag, as the live Quadlets do
  (they auto-update within it). The series is enforced; patch drift is noted, not failed.
- **T2-Q3. Free ports in every harness, so the lock can go (CI-Q3)?** *Suggested: not in T2.*
  The engine harnesses already use random ports; the nginx harnesses (18080 / 18443 / 13144)
  and the e2e servers don't, so the lock stays until those change (with T3, which adds nginx
  tests).
- **T2-Q4. Engine pair shared per file, or per suite?** *Suggested: per file* (one start, ~8 s);
  suites keep apart by their own database names.
- **CI-Q1..CI-Q5**: decided as suggested earlier the same day (above).

## Found by the first suite

- **`contains` filters disagree between the engines**: it is a plain `LIKE`
  (`packages/studio/src/pammydb/rows.ts`), so on Postgres it matches case and on MariaDB (its
  collation) it doesn't; the search box (`LOWER(...) LIKE LOWER(...)`) ignores case on both.
  **Settled 2026-10-06 (momolig: as suggested)**: `contains` now ignores case on both engines
  (`LOWER(CAST(col)) LIKE LOWER(...)`, as the search box does); the suite checks it on both.
