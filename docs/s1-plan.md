# S1: proof on the account headers (master plan Track S, 🔒)

Status: **S1a INSTALLED** 2026-10-06 (pammy 74822b1d, lfdln 025de6e7). **S1b BUILT** 2026-10-07:
exam prep's `nextjs` at 32e5baa (image b5b46d077b933128), guide and Projects page on branch
`s1b-guide`; INSTALLED 2026-10-07 (pammy 3cea3c34, lfdln 883cadac). **S1d INSTALLED** on lfdln
2026-10-08 (f4ed591f, main 07dcc52; "S1d as built"). **S1e INSTALLED** on both sites (pammy e473291e,
lfdln adaf8766; main 35da7f8; "S1e as built"). **S1c INSTALLED** 2026-10-08 on both sites
(pammy d6a4979b 635/635+70/70+62/62, lfdln bb8f5fcd 680/680; "S1c as built"). **S1f INSTALLED**
on lfdln 2026-10-08 (5022fd6e 688/688; pammy f38fce08 needs no install); exam prep on pasta
2026-10-08 (9s downtime); TutorStar from 2026-10-09 11:00 UTC, Gonsalves from 2026-10-11 07:00 UTC
("S1f as built", "Install (S1f)").
Finding: docs/security-performance-review.md S1 (High). Rule 12 🔒: a second session reviews
each slice before it is installed (section "The review" below).

## The problem, in one line

Apps behind a route with accounts learn who is signed in from `X-Lfdln-Account`, `-Username`,
`-Role`, `-Privileges`. nginx sets them, but the apps listen on 127.0.0.1, which every local
user and (through `slirp4netns:allow_host_loopback=true`, 10.0.2.2) every project container
can reach: `curl -H 'X-Lfdln-Account: 1' -H 'X-Lfdln-Privileges: progress.read:any'
http://127.0.0.1:4101/` acts as account 1.

## The design

**The gate signs, nginx carries, the app checks.** stock nginx can't compute an HMAC, but it
already asks the gate about every request on a route with accounts (`auth_request
/_pammy/check/<token>`), and the gate already answers with the four headers. So the gate signs
them too, and nginx hands the signature on like the rest:

```
route location:  auth_request /_pammy/check/<token>/<audience>;
                 auth_request_set $lfdln_proof $upstream_http_x_pammy_proof;
                 proxy_set_header X-Lfdln-Proof $lfdln_proof;
gate:            X-Pammy-Proof: v1.<ms>.<base64url Ed25519 signature>
signed text:     JSON ["lfdln-identity","v1",ms,audience,host,account,username,role,privileges]
```

- **Ed25519, not a shared HMAC key** (S1-Q1). Apps hold only the public key. With one shared
  HMAC key, any app that can check a proof (a project's code) could make one for exam prep.
- **The audience is the app** (S1-Q2): `service.<service>.<part>` (`service.examprep.web`) or
  `project.<id>.<branch>`, written into the check address by the routing helper's kinds. A
  proof one app was shown is no good at another. The host and the time (5 minutes, as the
  signed hook requests) bind it further.
- **Only for the route's own app** (review B1): the routing helper writes each route's audience
  into gate-routes.json beside its area, and the gate signs `/check/<token>/<audience>` only
  when this host has a route with that area *and* that audience; anything else is 403. Without
  it, anyone on 127.0.0.1 (a project via 10.0.2.2, a local user) with a cookie could ask for
  exam prep's proof with another area's token (tokens are in X-Pammy-Login links) and get that
  area's privileges signed for exam prep. A gate without routes (pammy.org) signs for nobody.
- **No proof, nobody** (S1-Q3): an app believes the four headers only with a valid proof for
  its own audience; without one, whoever asks is a guest with no privileges at all (not even
  "Not signed in"'s). Nobody signed in on an open route is proven too, so the guest
  privileges still reach the app through nginx.
- **Keys** (S1-Q4): `/etc/lfdln-panel/identity.key` (Ed25519 PKCS#8 PEM, root 600, made once
  by install-lfdln.sh), to the gate by `LoadCredential=identity.key`.
  `/etc/lfdln-identity/identity.pub` (raw 32 bytes base64url, root 644, its own folder because
  the helpers may not read /etc/lfdln-panel). PD1 later wraps the private key in its envelope.
  No rotation in S1 (S1-Q5): a new key = delete it, reinstall, then reinstall each app; apps
  take the new key at their next start.
- **pammy.org is unchanged**: it has no service routes; its gate has no key and makes no proof
  (the shared code is a no-op there). Folder routes and PHP are not part of S1: PHP's socket is
  `www-data` / `lfdln-sites` only (checked 2026-10-06: `lfdln-sites` = www-data), so no local
  user can hand PHP made-up `LFDLN_*` params. nginx now also clears `HTTP_X_LFDLN_PROOF` for PHP.

## Slices (each its own release, expand then contract)

| Slice | What | Pamela | Apps |
|---|---|---|---|
| **S1a** | the key; the gate signs on `/check/<token>/<audience>` (the old `/check/<token>` stays for folder routes); the renderer names the app and forwards the proof; project Quadlets get `LFDLN_IDENTITY_KEY` + `LFDLN_IDENTITY_AUDIENCE` at their next deploy/restart; verify checks the keys, every service location's proof header, and a live signed check | no change | unchanged: they ignore the new header |
| **S1b** | apps check: exam prep (branch `s1-identity-proof` in ~/apps/placement-exam-prep-nextjs), refusing headers without a proof; its installer copies identity.pub as the podman secret `lfdln-identity`; its verify sends forged headers straight to 127.0.0.1:4101 and expects a guest. Guide L-projects: "check X-Lfdln-Proof" with a 15-line snippet (Node `crypto.verify`), and Projects' page says so | no | exam prep deploy, after S1a |
| **S1c** | the gate stops trusting `X-Real-IP` from loopback for anyone (review S1's second half: `core/src/security.ts:47`, `core/src/gate/context.ts:87`): nginx sends `X-Lfdln-Edge: <secret>` from a root-only include (`/etc/nginx/lfdln-edge.conf`, made by the installer) and the gate takes `X-Real-IP` only with it; without it, the caller's own address. Lands with or after S6 (real IP) | yes (same behaviour) | — |
| **S1d** | projects lose `allow_host_loopback`: `Network=pasta:-T,5436,-T,3308` (S1-Q6; pasta and passt are installed, podman 4.9.3) forwards only the two database ports from the container's own 127.0.0.1 to the host's, so a project reaches its databases and nothing else on the host; the project's env names `127.0.0.1` instead of `10.0.2.2` (a redeploy of each project, done by the helper on install); exam prep and TutorStar keep their own Quadlets and move the same way in their own deploys | no | every project restarted once |
| **S1e** | the gate's cookie stays with the gate (review SF3): nginx hands an app -- a service, a project's server, PHP in a site folder -- the visitor's `Cookie` without the gate's visitor cookie (`__Host-lfdln_visitor`); the gate's own locations (`/_pammy/`, its check) still get it. Two `map`s in the routing helper's `site.conf` | no (S1e-Q1) | none: apps learn who is signed in from the headers |
| **S1f** | S1d's follow-ups (decided 2026-10-08): a rollback command for moved variables, a `10.0.2.2` warning, exam prep / TutorStar / Gonsalves onto pasta (section "S1f") | no | exam prep, TutorStar, Gonsalves redeployed once each |

TutorStar: checked 2026-10-06, it doesn't read any `X-Lfdln-*` header (own sign-in), and its
route has no accounts: nothing to do in S1b. It moves in S1d only.

## Rollback (review SF2)

The new gate answers both `/check/<token>` and `/check/<token>/<audience>`, so the new gate
under old host files is fine. The other way round is not: the **old** gate under the **new**
host files answers 404 to the new check address, which nginx turns into a 500 on every route
with accounts. So a rollback of S1a is always the whole previous release with its installer
(install-lfdln.sh re-renders the hosts with that release's renderer, then restarts the gate),
never the gate alone (`/opt/lfdln-panel.prev` swapped in by hand, or a gate unit restarted on
old code). The keys stay; the old release doesn't read them.

## Known gaps (not S1a)

- **SF3, the visitor's cookie goes to the app** (pre-existing): service and project locations
  pass the whole `Cookie` header upstream, the gate's session cookie (`__Host-lfdln_visitor`)
  included. A project on the same host as an app (say a route under examprep.…/x/) sees the
  visitor's session and could act as them against the gate's own pages (/_pammy/…) and so, via
  nginx, against the app. Suggested fix (its own small step, S1e): nginx strips the gate's
  cookie from what it proxies to apps (a `map $http_cookie` that drops `__Host-lfdln_visitor`,
  set as `proxy_set_header Cookie`), since apps learn who is signed in from the headers and
  never need it; and, until then, no untrusted project route on a host that has an app.
  **Partly closed by S1e** (below): *server-side theft closed; same-origin actions remain.*
  An app's server never gets the cookie any more. But the cookie is host-only, not path-only,
  so untrusted JavaScript a project or PHP page sends to the browser, on the same host, can
  still (a) `fetch('/_pammy/…', { credentials: 'include' })` and act as the visitor (same
  origin: the gate's Origin / Sec-Fetch-Site checks pass), and (b) answer with
  `Set-Cookie: __Host-lfdln_visitor=…` (planting a session of its own, or signing the visitor
  out). **The rule stays**: no untrusted project or PHP route on a host whose visitors sign in
  for something else. Open item **S1e-Q3** (below).
- **Header values**: a value with spaces at either end, or outside Latin-1, doesn't verify on
  the app's side (fetch's Headers trims; Node won't send non-Latin-1). That fails closed (a
  guest). The gate's usernames and role names don't have either today; the guide (S1b) says so.

## S1b as built (2026-10-07)

- **exam prep** (branch `s1-identity-proof`, fast-forwarded into `nextjs`): `web/lib/progress/proof.ts`
  checks the proof as `proofOk` does (audience `service.examprep.web`, or
  `LFDLN_IDENTITY_AUDIENCE`); `who.ts` makes anyone without one nobody. The key comes from the
  podman secret `lfdln-identity` (`/run/secrets/lfdln-identity`); with none, everyone is a guest,
  logged once, looked for again after a minute. install.sh refuses without
  `/etc/lfdln-identity/identity.pub`; verify sends made-up headers straight to :4101 and expects
  401 and nobody on the page. Build: every engine check, 98 Playwright passed (6 skipped).
- **Guide** `lfdln-guides/visitors-guide.txt` PART 7: the proof, the signed text, the audience,
  the key, and an 18-line Node check (tested against `makeProof`: good, other audience, other
  host, changed privileges, 5 minutes old, none, a guest's), PART 8 step 1 and 3.
- **Projects page**: a server project's Environment says to check `X-Lfdln-Proof` and links
  PART 7. `LFDLN_IDENTITY_KEY` and `LFDLN_IDENTITY_AUDIENCE` join the panel's env names, so a
  project's own environment can't name them (the Quadlet's `Environment=` won anyway; now it
  says so).
- No review needed beyond S1b's own (done, 32e5baa): the guide and page are words; the env
  names only refuse more.

## Install (S1b)

The panel first (the guide is on Help), then exam prep:

```
cd ~/pamela-setup-s1b/panel && ./build.sh
sudo ~/pamela-setup-s1b/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1b-lfdln.log
sudo ~/apps/placement-exam-prep-nextjs/web/deploy/install.sh 2>&1 | tee ~/install-logs/install-s1b-examprep.log
```

## S1d as built (2026-10-07, branch `s1d-pasta`)

Tried first by hand (podman 4.9.3, passt 0.0~git20240220, rootless, a throwaway node container),
what a container could open:

| network | 127.0.0.1:5436/3308 | 127.0.0.1 other ports | 10.0.2.2:any | the server's public address |
|---|---|---|---|---|
| slirp4netns:allow_host_loopback (before) | refused | refused | **every loopback port** (panel, gate, exam prep, :5432, ssh) | 22/80/443 |
| `pasta:-T,5436,-T,3308` (the plan's line) | open | refused | nothing | **refused: pasta gives the container the server's own address**, so the server's websites (examprep., any DreamHost-DNS name) answer from inside the container |
| **as built**: `pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,3308,-T,5436` | open | refused | nothing (times out) | 22/80/443, as before |

So the line differs from the plan's: `-a/-n/-g` give the container an address of its own (the
websites keep working from inside it, as with slirp4netns), `-4` keeps it IPv4 only as slirp4netns
was (else it gets the server's IPv6 address too, same trouble), `--no-map-gw` says out loud that
the gateway is not the host (it isn't with this passt either; newer ones changed the default).
PublishPort still binds 127.0.0.1 only. The app sees nginx's requests from 127.0.0.1.

- **Quadlet** (`packages/projects/src/helper/ops.ts` `projectNetwork`, `quadletText`): the
  `Network=` line above; the ports are the site's engines, `PROFILE.services.studioPorts`
  (lfdln: 5436, 3308), handed to the helper by `sites/lfdln/src/helpers/projects.ts`; none:
  no `-T` at all.
- **Addresses**: `PROJECT_DB_HOST` is `127.0.0.1`, so a database made from now on is
  `postgres://…@127.0.0.1:5436/proj_…`.
- **The helper's `refresh` op** (asked by install-lfdln.sh, step 8c, last before verify; the
  installer follows the job up to 25 minutes, then says "still running, job <id>"): for every
  server project and branch,
  - its own variables are moved by `moveVars` where it is sure the address is an engine's
    (5436/3308): a URL's `@10.0.2.2:<port>`, libpq's `host=10.0.2.2 port=<port>`, and a plain
    host variable (`PGHOST`, `DB_HOST`, `DATABASE_HOST`, `POSTGRES_HOST`, `MYSQL_HOST`,
    `MARIADB_HOST`) that is exactly `10.0.2.2` while its `*_PORT` is an engine's. Not
    `NEXT_PUBLIC_`/`VITE_` ones (built into the pages).
  - **10.0.2.2 left anywhere after that** (another port, a host without its port, a form it
    doesn't know): the branch is **kept** as it is, on slirp4netns, nothing changed, and
    named with the variables (never their values) in the job, the install's output and
    verify's notes. (Its next Restart or deploy moves it to pasta all the same: the panel never
    writes slirp4netns again, so a variable can't keep a project on the whole loopback.)
  - a running server whose Quadlet or variables differ is **put live again in its other slot**
    (deploy's path) with the moved variables in a file of its own, `<branch>.env.next`; only
    once nginx has switched and the old slot stopped are the variables saved (as they are by
    then: a change made meanwhile is kept), the shared `<branch>.env` written, the new slot's
    Quadlet pointed back at it, and the next file removed. One that doesn't answer (or nginx
    refuses) is stopped, its next file removed, and **the live slot runs on as it was, its
    Quadlet, env file and variables untouched** (review HIGH, 2026-10-08: the first build
    wrote the shared env file before the switch);
  - a stopped one gets its variables, env file and Quadlet, and stays stopped;
  - asked again: nothing to do.
  The moved variables' old values are in hand at the one place they are saved (`saveMoved`), so
  a before-copy for a rollback (pending momolig) is a few lines there.
- **verify-lfdln**: no `proj-*.container` has `allow_host_loopback` (one refresh kept is a
  note naming its variables, anything else a FAIL); the throwaway Next.js server's Quadlet has
  the exact line; its running pasta has `-U none` and no `-T` but 3308 and 5436; from inside
  it, 5436 and 3308 on 127.0.0.1 open and none of :22, :3039-3048, :3307, :4101, :4200, :5001,
  :5432-5435, :8091, 10.0.2.2, the public address' :3046 and :5436; a slot set back to
  slirp4netns with a DATABASE_URL at 10.0.2.2 and an OTHER_URL at 10.0.2.2:3046 is kept
  (Quadlet and env file untouched), then, OTHER_URL removed, moved (slot b, answers, the URL at
  127.0.0.1, the shared env file in its Quadlet, no next file left); a second refresh leaves it
  be.
- **Guide** `lfdln-guides/databases-guide.txt`: a project's server uses 127.0.0.1; a
  service's container still 10.0.2.2.
- Tests: projects-helper 72/72 (the Quadlet line, ports cleaned; moveVars' forms and what it
  leaves; refresh: the next file before the start, the shared env file only after the switch
  and the old slot's stop, unchanged on a second ask; not answering: live slot's Quadlet, env
  file and variables untouched, next file gone; kept: nothing written, value never in the
  job; stopped: files only).

**Not changed here, on purpose**: exam prep (svc-lfdln-apps' own Quadlet, `~/apps/placement-exam-prep-nextjs/web/deploy`),
TutorStar and Gonsalves (svc-tutorstar@ / svc-ligneous@ Quadlets, their secrets at
10.0.2.2:5436 written by move-db.sh) and the rehearsal containers in move-db.sh. Each moves the
same way in its own deploy: the `Network=` line above with its own engine port(s), its URL
secret rewritten `10.0.2.2` → `127.0.0.1` (move-db.sh's `rewrite-url.py` and its reach check
go with it), and its other ways to the host listed first (exam prep calls the catalog at
10.0.2.2:3048 -- docs/catalog-plan.md -- so it needs `-T,3048` too, or keeps slirp4netns until
that call goes through nginx). Until then their containers still reach the whole loopback.

## Install (S1d)

lfdln only (pammy.org has no projects; its release is unchanged by S1d). Every running project
branch is put live again once, slot to slot (no downtime; a few seconds of build-free deploy
each, one after the other). The installer lists each: redeployed / unchanged / stopped /
kept (a variable still names 10.0.2.2: a note, set it to 127.0.0.1 then Restart) / failed
(FAIL: it still runs its old slot on slirp4netns, its variables and env file as they were).

```
sudo ~/pamela-setup-s1d/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1d-lfdln.log
```

Rollback: the previous release's installer. Its helper writes slirp4netns again at the next
deploy or restart of each project, but its `PROJECT_DB_HOST` is 10.0.2.2 while the variables
already say 127.0.0.1: a project put back on slirp4netns can't reach 127.0.0.1:5436 (that's
the container's own). So a rollback of S1d means setting each project's DATABASE_URL and
DATABASE_OWNER_URL back to 10.0.2.2 (the Environment tab), then Restart -- or leaving the
projects as they are (their running containers keep pasta until restarted).
*Since S1f*: `sudo lfdln-panel projects-put-back` does that for every project, before the older
installer ("Install (S1f)").

## S1f: S1d's follow-ups (decided 2026-10-08, suggestions taken)

After S1c, before or beside S2 (master-plan Track S). Built 2026-10-08: "S1f as built".

- **(a) Rollback command**: a helper op (and a line in the install notes) that puts each
  project's moved database variables back to `10.0.2.2` from the before-copy `saveMoved` keeps,
  so a rollback of S1d no longer means editing every project's Environment tab by hand.
- **(b) A warning** on a project's Environment page (and in verify's notes) when a variable
  names `10.0.2.2`: from a project on pasta that address reaches nothing.
- **(c) Exam prep, TutorStar and Gonsalves onto pasta**, each in its own deploy, as "S1d as
  built" says: exam prep with `-T,3048` beside its engine port until its catalog call goes
  through nginx; TutorStar and Gonsalves with their engine ports; their URL secrets rewritten
  `10.0.2.2` → `127.0.0.1` (move-db.sh's `rewrite-url.py` and reach check with them). Then no
  container on the server has `allow_host_loopback`.

## S1f as built (2026-10-08, branch `s1f-followups`)

**(a) The way back from S1d: `put-back`.** refresh now keeps a before-copy of each variable
it moves: the env store's `moved` (per branch: name -> `{ from, to }`, root 600 with the rest;
an older release leaves it as it is). A variable removed (or a dev branch let go) takes its
copy with it. The helper's new op `put-back` (optionally one project, `id`) is refresh the
other way: for every server branch, `backVars` puts back each variable from its copy *while
it still has the value refresh wrote*, and tells any other database address at
`127.0.0.1:<engine port>` (moved by S1d's release, which kept no copy, or a database made
since at 127.0.0.1) `10.0.2.2` by the same three forms `moveVars` knows (URL, libpq, a host
variable with its port); never `NEXT_PUBLIC_`/`VITE_` ones. Each running branch is put live
again slot to slot on `slirp4netns:allow_host_loopback=true` (deploy's `net` option; the
variables saved only once nginx has switched, as refresh); a stopped one gets its files;
asked again, nothing. Refresh and put-back share one loop (`moveAll`); `moveVars` and
`backVars` one rewriter (`rehost`). The command line: `sudo lfdln-panel projects-put-back
[<project>]` (asks, follows the job, names each branch; exit 1 if one didn't answer).
It is the step *before* a release older than S1d is installed: a deploy or Restart under
this release would put the branch on pasta again (and the warning below says so); running
install-lfdln.sh (this release) instead moves them back to pasta (step 8c).

**(b) The warning.** The helper's `env` op says per variable `oldHost: true` when its value
names `10.0.2.2` (the name only, never the value). The Environment tab shows a badge on that
variable ("names 10.0.2.2: reaches nothing") and a note under the list ("... Change it to
127.0.0.1, then Restart."; for a static project "change or remove it, then rebuild"); the
form warns while a value being typed names it. verify-lfdln: a `note` naming each project and
branch whose variables name 10.0.2.2 (names only), else ok.

**(c) The apps onto pasta: `deploy/lfdln/appdb/to-pasta.sh <app> plan|switch|back`** (beside
move-db.sh; their shared helpers moved to `lib-svc.sh`: `as_svc`, the secrets, `reach`, now
with a host and "can't ask" (2), the services helper, `pasta_net`). What each container calls
on the host, read from code, Quadlets and secrets on 2026-10-08:

| app | container | -T (its 127.0.0.1) | what was at 10.0.2.2 |
|---|---|---|---|
| examprep | examprep | 5436 | the appdb: the code's own default (`EXAMPREP_DB_HOST ?? '10.0.2.2'`), so the Quadlet gets `Environment=EXAMPREP_DB_HOST=127.0.0.1` |
| tutorstar | tutorstar | 5436 | `tutorstar-db-url` (secret) |
| gonsalves | ligneous-gedcom-api | none | nothing |
| | ligneous-flask-api | 5436 | `ligneous-db-url` |
| | ligneous-public | 5001, 5436 | `ligneous-db-url-public`, `PYTHON_API_URL=http://10.0.2.2:5001` |
| | ligneous-admin | 5001, 5436, 8091 | `ligneous-db-url`, `PYTHON_API_URL`, `LIB_API_URL=http://10.0.2.2:8091` |
| | ligneous-migrator (one-shot) | 5436 | `ligneous-db-url` |

**Exam prep needs no `-T,3048`**: its catalog call (catalog-plan S5-9) was dropped on
2026-09-29 and is in none of its code; forwarding the panel's door would only widen it (S1f-Q1).

`plan` changes nothing and shows each container's network line, what it names at 10.0.2.2
today, each file's diff and each secret's before/after (passwords as `***`). `switch` refuses
before anything stops when a container's inputs (its Quadlet, the env files it names, every
secret it names; comments aside) name 10.0.2.2 at a port not listed for it or without a port,
when a Quadlet's `Network=` isn't exactly `slirp4netns:allow_host_loopback=true`, when the
service user's systemd can't keep it stopped, or while move-db.sh's way back for that app is
still open (14 days from its switch: back would set its secrets to 10.0.2.2:5432, which
pasta can't reach; `--anyway` overrides). Then: every file and secret it changes kept in
`/var/lib/svc-lfdlnappdb/moves/pasta-<app>/` (root 700); the services helper stops the app;
each Quadlet's `Network=` becomes `pasta_net` with its ports (plus exam prep's
`EXAMPREP_DB_HOST`), every `10.0.2.2:<port>` in it, and in its env files, `127.0.0.1:<port>`;
each database secret (and Gonsalves's secret files that sync-podman-secrets.sh makes them
from) through `rewrite-url.py --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords` (new
options: the host told, the password as it is); the services helper starts it (its start
reloads systemd and waits until each part is well); from inside each running container,
`reach` must open each forwarded port at 127.0.0.1 and nothing at 10.0.2.2:5436. Any failure
after the stop puts every file and secret back and starts the app as it was. Then the marker
`moves/<app>.pasta` (move-db.sh refuses `switch` and `back` while it is there), the
services helper's record taken in again (as install step 6b), and a session count on
lfdln-appdb. `back`: stopped, everything from the copies, started, marker and copies gone.

move-db.sh's rehearsal containers (Gonsalves's throwaway public site and Flask API) are on
pasta too (`-T 5436`, the public one also `-T 5101` with `PYTHON_API_URL=http://127.0.0.1:5101`),
their secrets at 127.0.0.1. verify-lfdln: an ok when no Quadlet of svc-lfdln-apps,
svc-tutorstar or svc-ligneous has `allow_host_loopback`, else a note naming them; a note per
app on pasta with its way back.

**The apps' own repositories** (so their next install keeps pasta), each a branch, not merged,
not pushed:
- exam prep `~/apps/placement-exam-prep-s1f`, branch `s1f-pasta` (from `nextjs`): the
  Quadlet as to-pasta.sh writes it, the migrations' container likewise, and install.sh's way
  back puts the previous unit back too (it only re-tagged the image).
- Gonsalves `~/gonsalves-s1f` (worktree of /srv/apps/gonsalves), branch `s1f-pasta` (from
  `main`): the five Quadlets, README, secrets/README.
- TutorStar `~/tutorstar-s1f` (worktree of /srv/apps/tutorstar), branch `s1f-pasta` (from
  `main`): the Quadlet, register-secrets.sh (writes 127.0.0.1, not 10.0.2.2), README.
  /srv/apps/tutorstar has an uncommitted change to the same Quadlet (tutorlumi's trusted
  origins, 2026-09-29): commit it before merging.

Guide `databases-guide.txt`: a service's container uses 127.0.0.1 on pasta with `-T`, not
10.0.2.2.

Full build (066b416, 2026-10-08): every tier passed (e2e 122 + e2e-lfdln 62, move-db 83, to-pasta 32, nginx harnesses, tutorials, project builds). Tests: projects-helper 75/75 (backVars: round trip, without a copy, changed since; the copy
kept and let go; put-back slot to slot on slirp4netns, from the copy, asked again nothing, an
unknown id refused, refresh moves it again; without a copy by form; `oldHost` names only),
projects-cli 3/3, e2e-lfdln 16-projects (the badge, the note, the form's warning), run-move-db
(the rehearsal on pasta; switch and back refused on pasta; rewrite-url `--host`),
run-to-pasta 32/32 (each app's Quadlets, secrets and files; every refusal before a stop; a
start that fails, a container still reaching 10.0.2.2, one not reaching its database, one
that can't be asked: all put back; back exact). verify-lfdln: put-back of the throwaway
project (slot a, slirp4netns, DATABASE_URL at 10.0.2.2 from the copy, `oldHost` told), then
refresh moves it to pasta again.

Open points for momolig (suggestions as built):
- **S1f-Q1.** Exam prep without `-T,3048` (the decision had it "until its catalog call goes
  through nginx"; there is no such call since S5-9 was dropped). *Suggested: without*; if the
  catalog side comes back, its call goes through nginx then.
- **S1f-Q2.** TutorStar and Gonsalves only once move-db.sh's way back has closed (2026-10-09
  and 2026-10-11), rather than `--anyway` now. *Suggested: wait.*
- **S1f-Q3.** put-back tells addresses without a copy back by their form too (S1d's install
  kept no copy, and databases made since are at 127.0.0.1), not only from the copy.
  *Suggested: yes, as built* (the job names which).

## Install (S1f)

The panel first (lfdln only: pammy.org has no projects or apps; its release is rebuilt, not
reinstalled), then each app, one at a time, each its own short downtime (a stop and start
through the services helper, about as long as a restart). Each app's `plan` first:

```
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1f-lfdln.log

sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh examprep plan 2>&1 | tee ~/install-logs/s1f-pasta-examprep-plan.log
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh examprep switch 2>&1 | tee ~/install-logs/s1f-pasta-examprep.log

# TutorStar: from 2026-10-09 11:00 UTC (move-db.sh's way back, switched 2026-09-25 10:49, ends then)
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh tutorstar plan 2>&1 | tee ~/install-logs/s1f-pasta-tutorstar-plan.log
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh tutorstar switch 2>&1 | tee ~/install-logs/s1f-pasta-tutorstar.log

# Gonsalves: from 2026-10-11 07:00 UTC (switched 2026-09-27 06:33)
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh gonsalves plan 2>&1 | tee ~/install-logs/s1f-pasta-gonsalves-plan.log
sudo ~/pamela-setup-s1f/panel/deploy/lfdln/appdb/to-pasta.sh gonsalves switch 2>&1 | tee ~/install-logs/s1f-pasta-gonsalves.log
```

Then the apps' branches into their own lines (exam prep `s1f-pasta` -> `nextjs`, Gonsalves and
TutorStar `s1f-pasta` -> `main`), so their next install writes the same units. Exam prep's
next release (web/build.sh, install.sh from that branch) also works without to-pasta.sh.

**Rollback**, each on its own:
- an app: `sudo .../to-pasta.sh <app> back` (as it was before its switch, from the copies);
- S1f's panel: the previous release's installer (S1c's, bb8f5fcd). Its helper ignores the
  env store's copies and keeps them; its Environment tab shows no badge;
- S1d (projects back to slirp4netns): **first** `sudo lfdln-panel projects-put-back 2>&1 | tee
  ~/install-logs/s1f-put-back.log` (under this release: each project's variables at 10.0.2.2,
  live again on slirp4netns, one after the other), **then** the installer of a release from
  before S1d. A deploy or Restart in between puts a project on pasta with 10.0.2.2 in its
  variables (the badge says so); install-lfdln.sh of this release undoes put-back.

## S1e as built (2026-10-07)

- **Renderer** (`packages/hosts/src/render.ts`): `HostsConfig.visitorCookie` (from the profile's
  `services.gate.cookie`, `__Host-pammy_visitor` when not given, as the gate's own default;
  `packages/hosts/src/config.ts`); `appCookieMaps(cfg)` writes two maps at the top of
  `site.conf` (http level): `$app_cookie_<name>_once` takes the cookie out once, at the start
  or after a `;` and any spaces or tabs; `$app_cookie_<name>` sends **no cookies at all** if
  the name is still anywhere a cookie's name can start (`(?:^|[;\s])<name>\s*=`: sent twice,
  a tab before it, spaces before its `=`), so a header nginx can't clean never reaches an app
  (review F1: `a=1;<TAB>__Host-lfdln_visitor=jo` and `a=1; __Host-lfdln_visitor =jo` reached
  the app before).
  Names that only look like it (`my__Host-lfdln_visitor`, `__Host-lfdln_visitor2`) go along.
  A name outside `__Host-[a-z][a-z0-9_]*` is refused. Each site's variable has its own name
  (`app_cookie_lfdln_visitor`, `app_cookie_pammy_visitor`), so both site.conf files load in one nginx.
- **Where**: `appCookieLine` = `proxy_set_header Cookie $app_cookie_<name>;` in every service
  location (and its sign-in paths, `packages/services/src/route-kind.ts`) and every project
  server location (`packages/projects/src/route-kind.ts`), with or without accounts;
  `fastcgi_param HTTP_COOKIE $app_cookie_<name>;` in PHP in a site folder (`staticLocation`;
  an explicit `HTTP_` param keeps nginx from passing that header itself). Files (folders, a
  project's static release) need nothing: nginx serves them.
- **PHP, why**: PHP in a lfdln site folder is a programmer's code, as untrusted as a project, on
  hosts that have the gate's pages (`/_pammy/`). It is told who is signed in by
  `LFDLN_ACCOUNT` & co. and reaches the data API through its socket with a key
  (databases guide: "the socket passes on no visitor's cookie"), so it never needs the
  session; the tutorial examples already send `HTTP_COOKIE ""`. Its own cookies (a PHP
  session) still go along.
- **pammy.org**: the maps are in its site.conf too, but no route there uses them: its kinds are
  the whole website, `/api/` to pamela-app and WordPress, and her PHP goes through the
  hand-kept gate snippets. pamela-app and her PHP keep every cookie (S1e-Q1, decided).
- **WordPress** (momolig 2026-10-08, S1e-Q1): never gets `__Host-pammy_visitor`.
  `wordpress/nginx/proxy.conf` (the adopted blog's, :3043) has
  `proxy_set_header Cookie $wp_cookie_pammy_visitor;`, and so has every other install's
  `proxy-<id>.conf`, which the software helper makes from that file
  (`packages/apps/src/apps/nginx.ts`; the bash `render_placement` writes only main/server/
  placement, so `test/apps-nginx.test.ts` still compares equal). The map is **its own**,
  `wordpress/nginx/cookie-map.conf`, installed as `/etc/nginx/conf.d/pammy-wordpress-cookie.conf`:
  at http level through nginx.conf's `conf.d/*.conf`, so every nginx that includes a WordPress
  proxy file has it -- pammy-hosts' `blog.conf` today, the pamela site's `main.conf`/`server.conf`
  after a switch back, the test harnesses (they include it too). Its own variable name
  (`wp_cookie_…`, not pammy's site.conf `app_cookie_pammy_visitor`) because one variable can't be
  mapped twice at http level. Made by the same renderer (`appCookieMaps(cfg, 'wp_cookie_pammy_visitor')`;
  `test/s1e-cookie.test.ts` checks the file is what it makes).
  **Order** (nginx -t can't meet the variable before its map): `install-wordpress.sh` installs
  the map before proxy.conf; the panel's installer installs it in step 1c (nginx -t, reload;
  put back if refused), *before* step 2 puts in the code whose software helper writes proxy files
  naming it, and the proxy files themselves only in step 7 (one nginx -t with the rest, all put
  back if refused). The software helper writes, `nginx -t`s and puts back on its own, so even out
  of order a placement fails cleanly, never a broken nginx. The preflight refuses a blog
  proxy.conf that is neither this release's nor the one before S1e (changed by hand).
  **When it matters**: `__Host-` cookies are host-only. Today the blog is at `blog.pammy.org`
  (placement `subdomain blog`), a host with no gate locations (`/_pammy/login` there is
  WordPress's 404, checked 2026-10-08): the gate never sets its cookie there, so browsers never
  send it to WordPress today. It matters for a WordPress at a **path** of pammy.org
  (`pammy.org/<name>/`), where visitors do sign in to the gate (protected folders, forms), and
  for any later host where the gate signs visitors in beside WordPress.
- **The gate reads its cookie strictly** (review F1, `packages/core/src/sessions.ts`
  `readCookie`): spaces or tabs before a name are the separator's and are skipped, but a name
  with spaces after it (`name =v`) is another name. No caller or test relied on the old trim
  (every browser, curl and Playwright send `name=value`); the panel's own session cookie is read
  the same way. Whatever the gate reads as its cookie, the maps take out or send nothing
  (tested: `readCookie(maps(h)) === null`).
- **Not touched**: the gate's `/_pammy/` (proxied with the visitor's whole header) and its
  check (`proxy_set_header Cookie $http_cookie`). The panel's own session cookie
  (`__Host-pammy_panel`) is host-only on panel.<domain>, where no route goes, so it never
  meets an app.
- **Tests**: `test/s1e-cookie.test.ts` (8: the names, the maps run against 19 headers as nginx
  reads them -- tab and space-before-`=` included -- the gate's strict reading, refused names,
  service/sign-in/project/PHP lines, the gate's untouched); `test/hosts.test.ts` site.conf;
  `test/run-route-accounts-nginx-test.sh` +29 checks on a real nginx, 81/81: an app that echoes
  its Cookie (around, first, alone, twice, look-alikes, a tab, a space before `=`, sign-in path,
  no accounts; the gate's pages still get all of it), and a FastCGI capture stub
  (`test/fastcgi-capture-stub.ts`, review F3) on the PHP socket: exactly one `HTTP_COOKIE`,
  without the gate's cookie, and PHP still told who is signed in. verify-lfdln (review F3): per
  location block (awk): every block that proxies to an app (anywhere but the gate) has exactly
  one Cookie line, every PHP block exactly one `HTTP_COOKIE` with the map's value; none to an
  app at all is a fail (none running PHP is a note); home and other domains. verify-panel:
  pammy's maps; the WordPress map in conf.d is this release's (root, 644) and every
  `/etc/nginx/pammy-wordpress/proxy*.conf` has exactly one Cookie line naming it.
  `test/run-gate-nginx-test.sh` (both ways: the pamela vhost and pammy.org's hosts): WordPress at
  a path gets `wordpress_*`, `wp-settings-*`, `comment_author_*` and never the gate's cookie, the
  gate's cookie alone gives no cookies, a second install's `proxy-shop.conf` the same, and her
  `/api/` still gets every cookie; `wordpress/test/run-local-test.sh` includes the map.

Review (rule 12, 2026-10-07): "OK to install", with F1 (map 2 widened, strict `readCookie`),
F2 (SF3 only partly closed, wording above) and F3 (verify per block, FastCGI stub) applied.

## Install (S1e)

Two installers, one at a time (nginx reloads overlap otherwise). The routing helpers rewrite
the host files with the new renderer at install; nginx reloads. No app restarts. pammy.org's
installer also puts in WordPress's map (step 1c) and its proxy files (step 7, the blog's
proxy.conf gains the Cookie line).

```
sudo ~/pamela-setup-s1e/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-s1e-pammy.log
sudo ~/pamela-setup-s1e/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1e-lfdln.log
```

Rollback: the previous release with its installer (host files re-rendered without the line);
either way round is safe, since the maps and the lines arrive in one render. WordPress's map in
conf.d stays (harmless), and so does the blog's proxy.conf with its line (the map is there); the
old release's software helper writes proxy files without it.

## S1c as built (2026-10-08, branch `s1c-edge-secret`)

- **The check** (`core/src/security.ts`): `fromNginx(req)` = the peer is 127.0.0.1/::1 AND,
  once the process has an edge secret, `X-Lfdln-Edge` matches it (sha-256 of both sides,
  `timingSafeEqual`, so length doesn't leak either). `clientIp` (the panel) and the gate's
  `ipOf` (`core/src/gate/context.ts`) both use it; without it, the caller's own address.
  No secret loaded (no credential): as before, any local caller is believed, and the
  service logs which way it is ("X-Real-IP believed only from nginx (edge secret loaded)" /
  "no edge secret: ...").
- **Who has it**: the panel and the gate of each site, by `LoadCredential=edge.secret:` from
  `/etc/<site>-panel/edge.secret` (pammy-panel, pammy-gate; lfdln-panel, lfdln-gate). One
  secret per site, shared by its panel and its gate, because the panel asks the gate over
  HTTP for the tutorial examples (`core/src/panel/gate-http.ts`, with `edgeHeaders()`).
  `<PREFIX>_EDGE_SECRET_FILE` (PANEL_/GATE_) when run by hand (the harnesses).
- **nginx**: `<the panel's nginx folder>/edge.conf` (`/etc/nginx/pammy-panel/edge.conf`,
  `/etc/nginx/lfdln-panel/edge.conf`), root 600, one line `proxy_set_header X-Lfdln-Edge
  "<hex>";`, included right after every `proxy_set_header X-Real-IP` that goes to the panel or
  the gate: panel.conf (6), gate.conf (2, pammy.org), tutorial-examples.conf (1), git.conf (1,
  lfdln), and the hosts' `/_pammy/` + data-API locations (`hosts/src/render.ts`, `cfg.edge`
  from `hostsConfigOf`). Never in a service's, project's or program's location: apps never
  see it. *Per site, in the panel's nginx folder, not one `/etc/nginx/lfdln-edge.conf`:
  pammy.org and lfdln are separate sites with separate secrets, and the harnesses already
  point those folders at their own (S1c-Q1).*
- **Installers**: `deploy/edge-secret.sh` `make_edge_secret <etc> <nginx folder>`, sourced by
  install-panel.sh (4b, before the services) and install-lfdln.sh (2a'', before the dump):
  `openssl rand -hex 32` once, kept, root 600, never printed; the include rewritten from it
  every install (only if it changed), so the two always agree.
- **verify** (`deploy/verify-edge.sh`: `verify_edge` in the gate section, `verify_edge_limits`
  last): both files root 600 and saying the same secret (compared in bash); `tools/edge-check.ts`
  over every *.conf under /etc/nginx and all of sites-available (review L2, below);
  `/run/credentials/<unit>.service/edge.secret` is the same file for the panel and the gate, and
  no installer's hold is left; and live: 31 made-up X-Real-IPs straight to the gate's media API
  with a bad key run out the limit (429) without the secret, and don't with it; the same with
  21 to the panel's `/api/login/verify` (400, no rows written).
- **Tests**: test/edge-secret.test.ts (11: the check both ways, both callers, bad secrets, the
  credential, the hold and an empty name; the checker on both profiles' files and lfdln's hosts,
  and on made-up files for each thing it reports; the secret on no command line);
  test/hosts.test.ts (the gate's two locations carry it, a service's never); the pammy
  nginx snapshot (9 includes); test/run-nginx-test.sh runs the panel WITH a secret behind the
  real site file (the CF-Connecting-IP visitor still logged as itself; straight to the panel
  rotating X-Real-IP -> 429; with the secret -> its own limit); run-gate-nginx-test.sh runs
  the gate with one (its sign-in IP checks now go through the include); the other harnesses
  (git, tutorials, hosts, adopt, route accounts) write an edge.conf (test/edge-file.ts).

### Rollback and order (expand, then contract)

- Old gate/panel under new nginx: they ignore `X-Lfdln-Edge` and believe loopback, as before.
- New gate/panel with no credential, or `<PREFIX>_EDGE=off`, or an empty
  `<PREFIX>_EDGE_SECRET_FILE`: as before, and the service's log says which.
- **The first install has no window** (review L1). Before the services restart, `edge_hold`
  (deploy/edge-secret.sh) runs `tools/edge-check.ts` over nginx's live files; if they don't
  send the secret everywhere yet, it writes runtime drop-ins
  `/run/systemd/system/<unit>.service.d/s1c-first.conf` (`Environment=PANEL_EDGE=off` /
  `GATE_EDGE=off`) for the panel and the gate, so they restart on the old way. Once nginx has
  reloaded with the include (pammy.org after 7a, continued; lfdln after 8), `edge_release`
  checks the live files again, takes the drop-ins away, reloads systemd and restarts the
  gate and the panel onto the secret, and waits for both to answer. Later installs find nginx
  already sending it: no hold, no extra restart.
- **A stopped install** (any `die` while held) leaves the drop-ins, so the services stay on
  the old way and visitors keep their own IPs; die then says so, and to re-run or roll back
  (both safe). The drop-ins are runtime, so a reboot drops them: re-run before one. If the
  live files still don't send it everywhere at the release (a hand-written location to the
  panel or the gate, say), the install stops there, held, with the checker's findings.
- The previous release's installer leaves edge.secret and edge.conf in place (unused).

### Review fixes (2026-10-08, second session: OK after M1)

- **M1** the secret never on a command line or in a child's environment (`/proc` has no
  hidepid; it is never rotated): verify compares it in bash and gives it to curl as a config on
  stdin (`-K -`, a here-string); the installers only use bash builtins (printf) with it.
  test/edge-secret.test.ts runs make_edge_secret, verify_edge and verify_edge_limits with every
  program they call replaced by one that writes down its arguments and environment, and fails
  if the secret (or 16 characters of it) is there; curl must have had it on stdin.
- **L1** the hold above.
- **L2** `tools/edge-check.ts` reads nginx's syntax (blocks, quotes, comments): the location
  around an include or X-Real-IP, whatever the order of its lines; 127.0.0.1, localhost,
  [::1] and upstreams naming the ports; a location to the panel or the gate that doesn't set
  X-Real-IP; the secret in an app's location, inherited by a nested one (proxy_set_header is
  inherited only by a block that sets none), outside any location, or where nothing is
  proxied; over every *.conf under /etc/nginx and all of sites-available (the edge file itself
  left out; another site's edge file is that site's to check).
- **L3** `<PREFIX>_EDGE_SECRET_FILE=` (empty) is none, and the log says so.
- **L4** the check locations (gate.conf `/_pammy/check`, the hosts' `^~ /_pammy/check/`) set
  `X-Real-IP ""`: what a visitor sent is never passed on (the check uses no IP).
- **L5** the loops that run this machine's limits out without the secret
  (`verify_edge_limits`) run last in both verify scripts, after every other check that asks the
  gate or the panel from here.

## Install (S1c)

pammy.org first, then lfdln, one at a time:

```
sudo ~/pamela-setup-s1c/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-s1c-pammy.log
sudo ~/pamela-setup-s1c/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1c-lfdln.log
```

## Open questions (all confirmed 2026-10-08)

**S1-Q1..S1-Q7 confirmed as built by momolig 2026-10-08.**

- **S1-Q1** signature: Ed25519 from the gate (suggested) / HMAC with one key per app / Unix
  sockets only nginx can open. *Ed25519: one key, apps can't sign, no per-app key handling;
  Unix sockets would need every app and project container changed and nginx in each group.*
- **S1-Q2** audience: the app the route goes to, bound to the route's area in gate-routes.json
  (suggested; B1) / the host / none.
- **S1-Q3** no proof: treated as nobody, quietly, with one log line per minute (suggested) /
  refused with 400. *A 400 would break health checks and the panel's own calls.*
- **S1-Q4** where the public key lives: `/etc/lfdln-identity/identity.pub` (suggested).
- **S1-Q5** rotation: by hand for now, overlap with PD1 (suggested).
- **S1-Q6** S1d's narrower path: pasta port forwards (suggested; /usr/bin/pasta is there) / a
  socket proxy per database mounted into the container.
- **S1c-Q1** where nginx's include lives: one per site in the panel's nginx folder (taken) /
  one `/etc/nginx/lfdln-edge.conf` for both sites. *Per site: two sites, two secrets; and every
  harness already points the panel's folder at its own.*
- **S1c-Q2** the first install's window: CLOSED by the installer's hold (review L1; above),
  instead of reordering the installers.
- **S1-Q7** projects: the helper only *tells* projects the key; checking is the programmer's
  code (suggested, with the guide), or a tiny sidecar that checks before the app sees the
  request. *A sidecar is a second process per project; the guide is enough until B1, whose
  `lfdln-backend` checks proofs itself.*
- **S1e-Q1** pammy.org's own programs (pamela-app at `/api/`, WordPress) and her PHP. DECIDED
  2026-10-08 (momolig): **WordPress first**: the gate's cookie is taken out (above); pamela-app
  and her PHP unchanged for now (pamela-app's code couldn't be checked from here for a use of
  `__Host-pammy_visitor`).
- **S1e-Q2** review (rule 12): S1e is 🔒 as part of S1; a second session reads the maps and the
  harness before install (suggested; small: one renderer helper, three call sites). DONE
  2026-10-07: OK to install, F1-F3 applied.
- **S1e-Q3** same-origin actions by untrusted code (SF3's rest). **DECIDED 2026-10-08** (suggestion
  taken): later, a host of its own per untrusted project or PHP folder; master-plan rule 17 holds
  until then. What is feasible:
  - **a host of its own per untrusted project or PHP folder** (suggested, later): the gate's
    cookie is `__Host-` (host-only), so a project on `proj.<domain>` never sees, sends or sets
    the visitor cookie of `examprep.<domain>`. Works with stock nginx today; it is a rule on
    routes (the Hosts page refusing an untrusted route on a host with accounts), not new code
    in nginx.
  - **taking `Set-Cookie: __Host-lfdln_visitor` out of an app's answers**: not feasible with
    stock nginx 1.24 -- `proxy_hide_header Set-Cookie` drops *all* of an app's cookies (its own
    sign-ins break), `proxy_cookie_*` can rename paths/flags but not drop one cookie, and
    `$upstream_http_set_cookie` can't be split back into headers safely (dates have commas).
    It would need njs (`js_header_filter`; the module isn't installed: one more package and
    script on the edge). It also closes only (b), not (a).
  - nothing on the gate's side helps (a): a same-origin `fetch` passes Origin and
    Sec-Fetch-Site by design.

## The review (rule 12)

A second session, and monadelanuit where possible, before S1a is installed:
1. `packages/core/src/identity-proof.ts`: the message can't be ambiguous (JSON array), the
   check is constant-time by construction (Ed25519 verify), the age window, the audience regex.
2. `packages/gate/src/app.ts` `/check/:token/:audience`: the proof covers exactly what is
   sent (`identity()` returns it), nothing when no key, 403 on a bad audience or one this
   host's route with this area doesn't send to (`SiteRoutes.hasAudience`, gate-routes.json).
   Reviewed 2026-10-06: OK after fixes B1, SF1 (audience parts up to 63, a 36-character project
   id), SF2 (rollback note), SF3 (recorded); re-check pending.
3. The renderer (`hosts/src/render.ts` `gateLines`, `proofLine`; services and projects
   kinds): every proxy location clears or sets `X-Lfdln-Proof`, never passes the visitor's.
4. install-lfdln.sh 2a': key made root-only before the gate restarts; the public half derived,
   not trusted from disk. verify-lfdln.sh: the live signed check.
5. Tests: test/identity-proof.test.ts, test/route-areas.test.ts ("for an app"),
   test/run-route-accounts-nginx-test.sh (a forged request straight to the app has no proof;
   a visitor's own proof never reaches the app).

## Install (S1a)

Build, then the lfdln installer (it restarts lfdln-gate with the new credential and re-renders
the hosts); pammy.org's installer too, because the gate code is shared (no change there):

```
sudo ~/pamela-setup-s1/panel/deploy/install-panel.sh 2>&1 | tee ~/install-logs/install-s1a-pammy.log
sudo ~/pamela-setup-s1/panel/deploy/lfdln/install-lfdln.sh 2>&1 | tee ~/install-logs/install-s1a-lfdln.log
```
