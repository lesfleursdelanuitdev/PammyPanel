# A project's Backend tab: Supabase-like, over many databases

PROPOSED 2026-10-06, examples and Forms added the same day; reviewed against phase 0, the
namespace and the security review (docs/security-performance-review.md, D1-D18) the same day.
**Status 2026-10-06: nothing built.** Firm: **the namespace** (the project and the domain,
`/_api/`, `api.<domain>` fallback), NS-Q1..NS-Q4, L-Q3. Provisional, each confirmed before the
step named (docs/master-plan.md section 2): B-Q1, B-Q3..B-Q5, B-Q8, B-Q12, B-Q13 before B1;
B-Q6, B-Q7, B-Q9, B-Q10 and L-Q1 before B3; B-Q11 before B4; L-Q2 before B5; F-Q1, F-Q5 before
B6 (F-Q2..F-Q4 deferred). **M-Q1 firm** (confirmed by momolig 2026-10-08). Order and dependencies: docs/master-plan.md section 5,
Track B; the first slice is milestone **M1** (exam prep reads and writes through `/_api/`).

momolig asked to install Supabase on the server. Self-hosted Supabase is **one Postgres database
per stack** (its API, Auth, Storage, Realtime and Studio are each wired to that one database) and
cannot use MariaDB at all, so the ask became: *something like Supabase that manages several
databases at once, Postgres and MariaDB, with Supabase's auth features and realtime.*

momolig's answers of 2026-10-06:

- **The apps are momolig's**, not Pamela's. The audience is a programmer: a client library and
  API reference matter, beginner guides do not.
- **"Looks like Supabase" is enough.** supabase-js does not have to work unchanged; our own
  client may borrow its shape.
- **Realtime does not have to see writes made outside the API** (PHP, WordPress, `psql`) at
  first. Change data capture is a later step, not a starting point.

lfdln only: pammy.org's profile leaves the module off.

## The namespace: the project and the domain (DECIDED 2026-10-06)

momolig: *"the backend api should also take into consideration the app/project/service and then
the db name"*, *"we want the namespace to be the project and the domain"*, then **"(a) with (b) as
a fallback. Use `_api` as the reserved path."**

**There is no separate "backend" object.** A **project** (any kind: Code, Connected, Files,
Installed; docs/projects-domains-plan.md) is the namespace. Its databases (its Data tab) are named
under it, and the Supabase-like features (data API, auth, policies, realtime, storage) are a
**Backend tab** a project switches on. The module is still called `backends` in code; on screen
it is a tab of every project.

**Addresses.** The domain and the project are the address; then the database, then the table:

| | Address | When |
|---|---|---|
| **(a) on the project's own addresses** | `https://<host of the project>/_api/v1/<database>/<table>` | always, on every address the project has, on every domain |
| **(b) fallback: one API host per domain** | `https://api.<domain>/v1/<project>/<database>/<table>` | a project with no web address of its own (an API for a phone app), or a program calling from elsewhere |

```
https://examprep.lesfleursdelanuit.com/_api/v1/main/questions          (a)
https://tutorlumi.com/_api/v1/main/sessions                             (a) TutorStar on tutorlumi.com
https://tutor.lesfleursdelanuit.com/_api/v1/main/sessions               (a) the same project on its other domain
https://api.lesfleursdelanuit.com/v1/party/main/guests                  (b)
https://tutorlumi.com/_api/v1/storage/photos/ana.jpg                    (a) storage, same namespace
https://tutorlumi.com/_api/v1/auth/token                                (a) sign-in
wss://tutorlumi.com/_api/v1/realtime                                    (a) realtime
```

```ts
const db = createClient();                                   // on the project's own page: same origin, nothing to configure
const db = createClient('https://api.lesfleursdelanuit.com/v1/party', PUBLISHABLE_KEY);   // (b) from elsewhere
db.from('guests')                    // the project's default database
db.db('legacy').from('scores')       // another database of the same project
```

- **`/_api/` is reserved on every host**, beside `/_pammy/` (not `/api/`, which Next.js and Laravel
  apps use themselves; not `/_lfdln/`, kept for service hooks and closed from outside). nginx
  sends it to `lfdln-backend` with the project the route belongs to, in a header the service
  checks is nginx's (the proof of review S1). A project without the Backend tab on answers 404
  there.
- **What this settles**:
  - **B-Q2** (address): replaced by this section. Each project's addresses are their own origin, so
    projects are isolated from each other (review D8) and no new DNS name or certificate is needed
    per project; gonsalvesfamily.com works with the names it has.
  - **Same origin as the app**: no CORS for (a), and sign-in can use an **HttpOnly `__Host-` cookie**
    per host instead of tokens in `localStorage` (review D9). Tokens (JWT + refresh) stay for (b)
    and for server-to-server use.
  - **OAuth redirects, emailed links and the mail sender** stay on the domain the person used
    (docs/projects-domains-plan.md D-Q1, PD-Q4).
- **What belongs to the project** (nothing to a separate "backend"): keys (publishable, secret),
  sign-in users and settings, policies, realtime channels, storage buckets (docs/storage-plan.md),
  attached forms (F-Q5), the identity provider's name (`project:<id>`), and the components'
  attribute (`project=`, only from elsewhere; on the project's own pages it is not needed).

**Decided with it** (NS-Q1..NS-Q4, 2026-10-06, as suggested): short database names per project
(`main`, one default); one owner per database, read-only sharing shown on both projects; one user
list per project with a session per host; on a project's pages the sign-in components answer for
the project's own users when its Backend sign-in is on, else lfdln visitors (never both on one
route).

## What there is today (checked 2026-10-06)

- **Both engines behind one helper.** The Studio's database helper (`packages/studio/src/pammydb`)
  has a driver per engine (`pg.ts`, `maria.ts`) behind one interface (`driver.ts`, `ir.ts`),
  row operations (`rows.ts`: page, order, search, filters `equals` / `contains` / `range` /
  `empty` / `in`), DDL, roles. It already makes databases and `db_` logins on lfdln-appdb
  (:5436) and lfdln-appmaria (:3308) (P8-15).
- **A data API on the gate.** `/_pammy/api/data/:engine/:name/:resource` (list, one, `_labels`,
  `new`, `save`, `delete`) in `packages/studio/src/gate/data-api.ts`. Every request is decided
  by `allow()` / `mayRead()` / `ownerOf()` / `onlyPublicRows()` (`gate/studio.ts`) against the
  **catalog** the panel pushes (`studio/catalog.ts`): exact columns, key, searchable / sortable
  columns, abilities, public rows (`public.only`), connections (`refs`, `many`), rich text,
  column types, and signed-in visitors with an optional owner column (`visitors`).
- **App keys**: `pammy_app_…` Bearer keys per database, refused in the address, rate limited.
- **Visitor accounts** (`packages/people/src/gate/routes`): register, email confirmation
  (`email_confirmed_at`, A4), sign in, sign out, reset by email, change email / password,
  delete account, invites. Sessions are **cookies per hostname**, 30 days, scrypt passwords
  (`packages/core/src/gate/passwords.ts`). These accounts belong to protected areas and routes
  ("Open with accounts"), not to programs.
- **Mail**: Resend, `mail.lesfleursdelanuit.com` verified, lfdln mail module installed.
- **Passkeys**: `@simplewebauthn/server` is already a dependency (panel users only).
- **No realtime anywhere.** No WebSocket or event-stream code; `gate.record_touches` is the
  only "something changed" record, and it serves tagging, not listeners.
- **Every host already has a reserved path** (`/_pammy/`, the gate's), so another one (`/_api/`)
  needs no new DNS name or certificate; `api.<domain>` is one more name per domain (by hand on
  gonsalvesfamily.com).

What is missing, against Supabase: a project's **Backend tab** that groups its databases, sign-in
users and keys; **tokens** a program can carry (JWTs) beside a host's cookie; a **rule language**
for who may see and change which rows, on both engines; a richer **query** language; more
**sign-in methods**; **realtime**; and a **client library**.

## The idea in one paragraph

A new module, `backends`, runs as its own service (`lfdln-backend`), reached at `/_api/` on every
address of every project and at `api.<domain>/v1/<project>/` as a fallback. momolig switches on
the **Backend tab** of a project (say `quiz`), picks which of the project's databases (any engine,
short names from its Data tab) and which tables and columns it exposes, and gets a publishable
key and a secret key. Programs use the client library: `from('questions').select()`,
`auth.signInWithPassword()`, `channel('room').on(...)`. Every request carries a key (or, on the
project's own addresses, the signed-in cookie) and maybe a user; the service checks the
project's **policies** itself, because MariaDB has no row-level security, and runs the query
through the data store adapter (phase 0, C6-min). Writes the panel's modules make (this API,
form links, comments, the Studio's record pages) become **row events** after they commit
(phase 0, C4/C5), and realtime passes them on to the listeners who may read the row.

## Concepts

| Term | Is | Supabase's word |
|---|---|---|
| **Project** | the namespace: its addresses, its databases (Data tab), and its **Backend tab** (users, keys, policies, settings) | project |
| **Database** | a database on lfdln-appdb or lfdln-appmaria owned by the project, with a short name (`main`, `legacy`; NS-Q1); one is the default | (only ever one) |
| **Exposed table** | a table the Backend tab exposes, with its column window | table in the `public` schema |
| **Publishable key** | names the project; safe in a browser; requests are anonymous until a user is signed in | anon / publishable key |
| **Secret key** | server-side only; skips policies | service_role / secret key |
| **User** | someone signed in to *this* project (`project:<id>` in the identity contract); one list per project, a session per host (NS-Q3) | auth.users |
| **Policy** | a rule per table, per action, per role | RLS policy |
| **Channel** | a realtime topic | channel |
| **Bucket** | a place for files, owned by the project (docs/storage-plan.md) | bucket |

A query names the database or uses the project's default: `db.from('questions')` or
`db.db('legacy').from('scores')`. **No joins across databases**: a connection (`refs`, `many`)
has to stay inside one database. A database shared read-only from another project (NS-Q2) is
read-only here too.

## Where it runs

- **Its own service, not the gate** (B-Q3). The gate serves Pamela's and lfdln's sites and their
  sign-ins; momolig's apps, their long-lived WebSockets and their query load should not be able
  to slow or crash it. `lfdln-backend` is a Fastify process in a rootless Quadlet container
  under its own service user, `127.0.0.1:<port>`, memory capped at 1 GB (master section 9).
- **Reached through the reserved path, not a route.** There is no `service` route on Hosts for
  it: the hosts route API (C2-min) reserves `/_api/` on **every** host, so no route can be placed
  under it, and the renderer adds one `location /_api/` per server block that sends the request
  to `lfdln-backend` with the project the host's route belongs to and **the S1 proof** (`X-Lfdln-Proof`:
  an Ed25519 signature by the gate over the headers, the audience and a timestamp, S1-Q1;
  docs/s1-plan.md). The service refuses anything without a valid proof. On
  Cloudflare-fronted domains the real visitor IP comes from S6's rules; N5 adds Cloudflare's
  cache bypass for `/_api/*`. `api.<domain>` hosts are rendered the same way, with the project
  taken from the path: `api.lesfleursdelanuit.com` in B1, other domains in N6 (by hand on
  gonsalvesfamily.com). **The API host never serves user HTML** (D8).
- **On the kernel** (phase 0): `backends` is a module (`defineModule`), and `lfdln-backend` is
  the module's own server process, built on the kernel's host code like the panel and the gate
  (module host, HTTP shell, events, migrations), not a helper.
- **Its own schema**, `backend`, in the lfdln panel database (:5435): per project its exposed
  databases, keys (hashed), users, identities, sessions, refresh tokens, one-time tokens,
  factors, policies, settings, audit log. Migrations per package, as every module has them.
- **Its own database logins** (B-Q4). For each exposed database, the panel makes a login for
  the project's Backend tab (`db_` naming, P8-15) with rights only on the tables it exposes. The
  service connects directly through the **data store adapter** (phase 0 C6-min) whose two lfdln
  implementations grow out of the helper's SQL building (`ir.ts`, `pg.ts`, `maria.ts`).
- **Connections and query cost** (D18). Pools open on demand and stay small, **under one budget
  per database container** (master section 9: `lfdln-backend` ≤ 30 connections on lfdln-appdb,
  ≤ 40 on lfdln-appmaria, across all projects), with a fair share per project and an O1 gauge
  (alert at 80%). Every statement runs with a **statement time limit** (Postgres
  `statement_timeout`, MariaDB `max_statement_time`). scrypt runs in a bounded worker pool
  (4 at a time), and rate limits are checked before hashing.
- **Shared code**: from the kernel, the HTTP shell (rate limiter, refusals), events, migrations,
  the scrypt hashing function and the identity contract; WebAuthn; mail through the `mail`
  module and the domain's sender (MS1); the catalog's column windows from `studio`.
- **An identity provider of its own.** Each project's users are `project:<id>` in the identity
  contract (phase 0, C6-min): stable opaque ids (UUIDs) plus the provider, so user 42 of one
  project is never visitor 42 (D20). Visitor accounts are another provider (`people`): a
  project's users can't sign in to protected areas or the reverse (B-Q9).

## The data API

PostgREST-flavoured, because it reads well and that is what the Supabase shape expects
(B-Q8). A subset:

```
GET    /_api/v1/main/questions?select=id,title,author(name)&topic=eq.maths&order=created_at.desc&limit=20&offset=40
POST   /_api/v1/main/questions          body: one row or a list; Prefer: return=representation
PATCH  /_api/v1/main/questions?id=eq.7
DELETE /_api/v1/main/questions?id=eq.7
POST   /_api/v1/main/questions?on_conflict=id   (upsert)
```

- Filters: `eq neq gt gte lt lte like ilike in is` (null / true / false), `not.`, `or=(…)`.
  Count with `Prefer: count=exact`; `Range` / `limit` + `offset`; several `order` columns.
- `select` names columns and embeds connections (one level, from `refs` and `many`).
- Engine differences handled in the driver, not the caller: `ilike` (Postgres `ILIKE`,
  MariaDB `LOWER() LIKE LOWER()`, which can't use an index, so only on columns marked
  searchable), booleans (already handled), `RETURNING` (MariaDB has it on INSERT and DELETE
  but not UPDATE: see "Writing" under Policies), upsert (see the same), JSON columns.
- The window is the catalog: a column the project has not exposed does not exist to the API.
  The catalog gains per-project entries; the Studio's own catalog for Pamela is untouched.
- **Limits** (D18): 1000 rows per request at most; `offset` capped (about 10k rows; deeper pages
  use a filter on the key); `count=exact` capped (above the cap the answer says "more than
  N"); body size cap; caps on the number of filters, `or` depth and embeds (D3).
- **Every `/_api/` answer** (data, auth, storage, errors) carries `Cache-Control: private,
  no-store` and `Vary: Authorization, apikey, Cookie`, so no proxy (Cloudflare included) shares
  one user's GET (B-Q8). Public bucket files served by nginx at a project's own address
  (`/uploads/`) are outside `/_api/` and keep their own caching.
- **Versioning** (PD3): `/_api/v1` is frozen once B2 ships, additions only; a `v2` would run at
  least 90 days beside it.
- Later, not in the first steps: calling stored functions (`rpc`).

## Auth

### Sessions and tokens

- **On the project's own addresses** (a): sign-in sets an **HttpOnly, Secure, SameSite=Lax
  `__Host-` cookie** for that host; scripts on the page never see a refresh token (D9). POSTs
  are checked for same origin (Origin, `Sec-Fetch-Site`, JSON), as the gate does today. One
  session per host (NS-Q3).
- **Through `api.<domain>`** (b) and server to server: an **access token** (JWT) and a
  **refresh token**. The browser client keeps the access token in memory and the refresh token
  in the storage the app gives it (by default `localStorage`); allowed origins and redirect
  URLs are listed per project (the Addresses tab fills in the project's own domains), and the
  panel warns when an allowed origin is a folder others can upload `.html` / `.js` to (D9).
- **Session limits** (D9): an absolute lifetime and an idle lifetime per project; ending a
  session (sign-out, ban, password change, the panel's Sessions list) takes effect at once,
  open WebSockets included (realtime, below).
- **Access token**: a JWT, 1 hour by default, **signed ES256 only** (B-Q10, D16) with a key per
  project, published at `/_api/v1/auth/.well-known/jwks.json` on each of the project's
  addresses (and `api.<domain>/v1/<project>/auth/.well-known/jwks.json`) so momolig's own
  servers can check tokens without asking. Claims: `sub` (user id), `role` (`authenticated` /
  `anon`), `aal` (`aal1` / `aal2`), `session_id`, `email`, `app_metadata`, `user_metadata`,
  `iss` (the project's API address), `aud` (the project). Verifiers (the service, the client's
  server helper, later the gate) **pin ES256, require a `kid` from that project's JWKS, and check
  `iss` and `aud`**; the gate, when it has to verify a project token (F-Q2, deferred), reads the
  keys from the database, never from the token.
- **Refresh token**: opaque, single use, rotated on each refresh **atomically**
  (`UPDATE … SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING …`, D14).
  Two tabs refreshing at once are not theft: for **10 seconds** after a rotation, the old token
  returns the same new token. Reuse after that revokes the whole session (theft detection).
- Key rotation: a new signing key is added before the old one is retired; both are in the JWKS
  while old tokens live. Private signing keys are kept under PD1's envelope scheme.

### Ways to sign in (in step order)

1. **Email and password** (B3), with email confirmation on or off per project, reset by email,
   change of email (confirmed on both addresses), change of password.
2. **Magic link** and **email code** (B7): one-time, 1 hour / 10 minutes, single use, hashed,
   **5 tries per code** (D15).
3. **Google and GitHub** (B7; OAuth with PKCE, the `state` tied to the client's PKCE verifier).
   **Linking by email only when both sides are verified** (B-Q6, D6): Google's
   `email_verified`, GitHub's `/user/emails` `verified`, and on our side a confirmed email;
   never automatically on a project with confirmation off; an unconfirmed password is dropped
   when linking.
4. **Second factor** (B8): authenticator app (TOTP), with recovery codes; a token is `aal2` after
   it, and a policy can ask for `aal2`.

**Deferred** (master section 11): **anonymous users** (when they come: off by default, Turnstile,
a purge, and templates written as `auth.role() = 'authenticated' and not
auth.jwt('is_anonymous')`, D15) and **passkeys** for project users. No phone / SMS sign-in
(B-Q7).

### Around it

- Email templates per project (confirm, magic link, code, reset, email change, invite), sent
  through Resend from the sender of the domain the person used (MS1: `mail.tutorlumi.com` for
  tutorlumi.com, `mail.lesfleursdelanuit.com` otherwise).
- **Abuse** (D15): rate limits per IP (IPv6 by /64) and per address on every auth route;
  **send caps per address and per project per day**, inside the domain's mail budget (MS1),
  with part of it kept for resets and confirmations of existing users; **Turnstile** (from master-plan step U7a) on sign-up
  and on sending links / codes.
- **Admin**, with the secret key or in the panel: list / find / create / invite / ban /
  delete users, set `app_metadata` (roles), end sessions.
- **Hooks** (B8): `backends.user.created` / `.deleted` are events (phase 0), delivered as signed
  webhooks (C5, with D10's path rules) to the projects that ask for them in `pammy-panel.json`.
  The **custom-claims hook** is different: a synchronous call to momolig's server while a token
  is made, with a short timeout (no event; the token waits for the answer). It **can't set
  `role`, `sub`, `aal`, `iss`, `aud` or `session_id`, and fails closed** (no answer, no token;
  D16).
- Audit log per project (its Backend tab's Logs): sign-ins, failures, token reuse, admin
  actions.

### Data protection

Users' data follows master **Track PD**, built with B3:
- **PD2**: export a user and delete a user. Each exposed table declares its owner column, so
  deleting a user cascades to their rows, their objects in buckets, their events and logs;
  the app is told by `backends.user.deleted`. Audit and request logs have a retention setting;
  events carry ids, never personal data.
- **PD1**: TOTP seeds, OAuth client secrets, hook keys and signing keys are stored under one
  envelope scheme, each in the secrets table with how to rotate it.

## Policies

The service decides every request itself, the same way on both engines. **No access unless a
policy allows it.** The secret key skips policies.

A policy is: table, action (`select` / `insert` / `update` / `delete`), roles (`anon`,
`authenticated`, or a role name from `app_metadata.roles`), and up to two conditions:

- **using**: which existing rows it applies to (select, update, delete)
- **check**: what a new or changed row must satisfy (insert, update)

Conditions are written in a small SQL-like language (B-Q11) that is parsed into a tree and
never pasted into SQL:

```
owner_id = auth.uid()
published or owner_id = auth.uid()
auth.aal() = 'aal2' and team_id in (select team_id from members where user_id = auth.uid())
```

- Names: columns of the table, `auth.uid()`, `auth.role()`, `auth.aal()`,
  `auth.jwt('path.to.claim')`, `now()`, constants. Operators: `= != < <= > >= in is null`,
  `like`, `and or not`, and `in (select col from <table in the same database> where …)` for
  team-style rules. **`user_metadata` can't be used in a policy** (the user can change it;
  D16); roles come from `app_metadata`.
- **Reading**: `using` becomes extra `WHERE` conditions, joined with `or` across policies,
  on top of the caller's filters.
- **Columns, per table per role** (D3): each role sees a column window (read and write
  separately). **Filters, `order` and `or` may use only columns readable under every policy that
  matches**, so `?secret=like.a*` or `order=secret` can't answer questions about a hidden
  column. **Embeds and counts go through the target's select policy and window**, never around
  them.
- **Writing** runs in a transaction, InnoDB only on MariaDB (D7), with the keys locked first:
  - **insert**: insert, re-read the new keys, require the same count, check every row against
    `check`; any failure rolls back.
  - **update / delete** (D2): `SELECT <key> … WHERE <using> AND <filters> FOR UPDATE` locks the
    affected keys; the write runs **by those keys only**; **an update may not change a key
    column** (refused: delete and insert instead); the rows are re-read by exactly those keys
    and **the count must match** before `check` runs. Zero rows locked means zero rows changed,
    answered as such, never "the check passed over nothing".
  - **upsert** (D1): every unique key in the body is looked up and locked first; a conflict
    with a row `using` doesn't allow is refused, as for an update. On Postgres
    `INSERT … ON CONFLICT (…) DO UPDATE … WHERE <using>`; on MariaDB no `ON DUPLICATE KEY
    UPDATE` under policies (it fires on any unique key and can't carry `using`): an insert or a
    `using`-filtered update by the locked key. The test suite includes a conflict with someone
    else's row.
  - Simple `check` conditions (on the row's own columns) are also checked in memory before
    writing, so most refusals never touch the database.
- **Attaching a MariaDB database** (D7, B-Q4): at attach time and on each catalog push the
  panel **refuses non-InnoDB tables** and **lists the tables' triggers** for an explicit OK,
  because a trigger's or a MyISAM table's side effects survive a rollback.
- **Defaults**: `owner_id` filled from `auth.uid()` on insert if the column is marked as the
  owner column (as `visitors.owner` does today); never taken from the request body.
- **Tests** (master T3, T4, before B4): the security suite (D1-D3) fails before the fix; the
  differential suite sends the same request to both engines and requires the same rows, with
  random filters, `or`, embeds and counts.
- **In the panel**: a Policies section per table with templates ("anyone can read", "only the
  owner", "signed in can read, owner can change", "team members"), and **Try as** a user or
  anonymous to see which rows come back.

## Realtime

One WebSocket per client at `wss://<project host>/_api/v1/realtime` (or `api.<domain>`). On the
project's own addresses it is signed in by the cookie (Origin checked); from elsewhere the client
sends its access token, and a fresh one when it refreshes. The server closes channels when a
token expires, and **ending a session (sign-out, ban, password change) is pushed to its open
sockets at once** (D17). The server sends a **heartbeat every 30 seconds** (Cloudflare closes
idle WebSockets; under 60 s, master N5).

- **Broadcast**: messages from one client to everyone on a channel. A channel can be private:
  then a **channel policy** (same language, on the channel name and the user) decides who may
  join and who may send.
- **Database changes**: subscribe to `{ db, table, event: insert|update|delete|*, filter }`
  (`filter` = one column with `eq` / `in`, like Supabase). Realtime follows the row events
  `studio.row.*` (C5, with keys) and `backends.row.*`, so it sees **every write the panel's
  modules make**: this API, form links, comments, the Studio's record pages. Row events are
  **published after the write commits, and retried** (D4): the row lives on :5436 / :3308 and the
  outbox on :5435, so they can't share a transaction. Whole rows go in a separate short-lived
  realtime table (minutes), not in the outbox, which keeps ids. `lfdln-backend` reads them with
  **its own cursor, only below the snapshot's lowest open transaction**
  (`pg_snapshot_xmin(pg_current_snapshot())`, D5), so an event that commits late is not skipped;
  woken by the same `NOTIFY` (without payload) as the panel's dispatcher.
- **Who gets an event** (D17): only subscribers whose `select` policies allow the row, with the
  column window applied. Rules on the row's own columns are checked in memory; rules with a
  sub-select are checked by **one query per event for all its subscribers**
  (`… AND user_id = ANY($subscribers)`), with a short per-user cache. Updates send the new row
  and the old key; deletes send the old row only to those who could read it before.
- **Limits**: per project (connections, channels per connection, messages per second, message
  size) under the server-wide cap of 2,000 WebSockets (master section 9); **bounded send buffers**
  (a client that can't keep up is disconnected, not buffered without end); counts on O1's gauges.
- **Deferred**: **presence** for project users (master section 11; when it comes, with caps per
  channel).
- **Later**: changes from other writers (Postgres logical replication, MariaDB row binlog)
  publishing the same `studio.row.*` events. Nothing in realtime or the protocol changes when
  it comes. More than one service process would share the cursor the same way.

## The client library

A TypeScript package, ESM, browser and Node, with the result shape of supabase-js
(`{ data, error, count }`) and similar names:

```ts
import { createClient } from '@lfdln/client';
const db = createClient();   // on quiz.lesfleursdelanuit.com: same origin, cookie session
// from elsewhere: createClient('https://api.lesfleursdelanuit.com/v1/quiz', PUBLISHABLE_KEY)

const { data, error } = await db.from('questions')
  .select('id, title, author(name)').eq('topic', 'maths').order('created_at', { ascending: false }).range(0, 19);

await db.auth.signInWithPassword({ email, password });
db.auth.onAuthStateChange((event, session) => { … });

db.channel('room:1')
  .on('broadcast', { event: 'move' }, msg => { … })
  .on('db_changes', { db: 'main', table: 'answers', event: 'insert', filter: 'question_id=eq.7' }, e => { … })
  .subscribe();
```

- **Sessions**: on the project's own addresses the session is the HttpOnly cookie, nothing in
  `localStorage`; through `api.<domain>` tokens are refreshed before they expire and shared
  across tabs (D9, D14).
- A small server helper: `verifyUser(request)` checks a bearer token against the project's JWKS
  (ES256, `kid`, `iss`, `aud`), or on the same host asks `/_api/v1/auth/user` with the cookie.
- **Types** (B9): the panel can produce a `types.ts` for a project from its exposed tables, so
  `from()` knows the columns.
- **Served by the service** (B-Q12): `/_api/client/v1.js` on any project host and the npm
  tarball at `api.lesfleursdelanuit.com/client/`. Versioned with the server; client N-1 is
  tested against server N (PD3).
- **What a project is told**: a Code or Connected project whose Backend tab is on gets
  `LFDLN_API_URL` (its first address's `https://<host>/_api/v1`, or
  `https://api.<domain>/v1/<project>` when it has none) and `LFDLN_PUBLISHABLE_KEY`, and,
  server-side only, `LFDLN_SECRET_KEY`. A Files project (site folder) gets the public values
  through `/_pammy/data.js`. Storage's own variables are in docs/storage-plan.md.

## Forms and the Backend tab

### Forms today (checked 2026-10-06)

- A form is made in the panel's **Forms** builder and put on any page with
  `<pammy-form name="rsvp">` + `/_pammy/forms.js`. The gate serves its definition
  (`GET /_pammy/forms/:name`) and takes answers (`POST /_pammy/forms/:name`, same origin,
  JSON, 64 KB, a hidden trap field, 10 per IP per hour).
- Answers land in **Responses** (the gate's tables), wait for approval if the form says so,
  send email notices, and can be read by programs through the **forms API** with forms keys.
- **Form links** (docs/form-to-database-plan.md): a form can also **save each answer as a row**
  in a Studio table. The link pairs questions with columns (`gate.form_links`); the catalog's
  `types` check the row; the row is written through the Studio helper after the response is
  committed, now or when approved; failures retry every 15 minutes.
- **Signed-in-only** forms know lfdln **visitor accounts** (protected areas, "Open with
  accounts"). On a service's page (no folder) a form works "anywhere" and cannot be
  signed-in-only (8-5).
- Forms on lfdln are scoped to a site folder, or "anywhere" (8-5).

### What changes when a project's Backend tab is on

A form can be put to work for one of momolig's apps in three ways. **B6 builds the first;
the other two are deferred** (F-Q2..F-Q4, master section 11) until B6 has a user.

1. **A form fills a project's table** (B6). An RSVP form on `party.lesfleursdelanuit.com` saves
   into `guests` in the `party` project's `main` database. Without this plan's change the row
   would **skip the Backend tab**: realtime would still see it (form links publish
   `studio.row.inserted`, phase 0), but no column window, nothing in the project's logs. With
   it, a form link whose table is exposed by a Backend tab writes **through the project's write
   path** (F-Q1, narrowed): the form link stands in for the **role** rule only (no `anon`
   insert policy has to be opened on `guests`); the policies' **`check` and the column window
   still apply**; **`owner_id` is never taken from an answer**. A page subscribed to `guests`
   sees the new guest appear; the project's logs show it. The form must be attached to the
   project first (F-Q5).
2. *Deferred:* **an app uses a panel form with its own look** (F-Q3):

   ```ts
   const rsvp = await db.forms('rsvp').definition();    // questions, choices, required
   const { error } = await db.forms('rsvp').submit({ name: 'Ana', guests: 2 });
   ```

   and forms "only for this project's users", sending the project user as owner (F-Q2).
3. *Deferred:* **an app reads or watches responses** as a read-only source `form:<name>` with
   policies (F-Q4, limited): it exposes **answers, `created_at` and status only, never the IP,
   host or visitor**.

   ```ts
   const { data } = await db.from('form:rsvp').select('*').eq('status', 'approved');
   db.channel('rsvps').on('db_changes', { form: 'rsvp', event: 'insert' }, e => …).subscribe();
   ```

   Live responses would come from the event `forms.response.kept` (phase 0).

**Unchanged:** Pamela's forms, the builder, `<pammy-form>`, the forms API and its keys,
approvals, notices, spam rules. A form that has nothing to do with a project's Backend tab works
exactly as today. A form is **attached to a project** on its Backend tab (F-Q5); only attached
forms can write through it.

## Web components (Lit)

**Rule (momolig, 2026-10-06):** in this project, any component that can be reused is written in
**Lit**, so it is a plain web component. That is how the existing ones are built:
`packages/*/widgets/*.ts` on `PammyElement` (in the kernel after phase 0; today
`packages/core/widgets/base.ts`), rendered **into
the element, not a shadow root** so the page's own CSS reaches every part, built by Vite into
one script each with its own copy of Lit, `styles="off"` drops the built-in look. They work the
same in plain HTML, React, Vue, Svelte, Lit and Blade: attributes in, DOM events out
(`signed-in`, `signed-out`, `sent`), no wrappers.

**Naming (L-Q1):** one component per screen and the `pammy-` prefix, as today. Whose accounts
or data a component works with:
- **on a project's own pages, no attribute**: the project's own users and data when its Backend
  sign-in is on, else lfdln visitor accounts and the gate, exactly as today (NS-Q4);
- `project="party"`: **only from elsewhere** (a page that is not one of party's addresses),
  through `api.<domain>`;
- `store="party"`: a data store on an external provider (docs/external-backends-plan.md), through
  an adapter per provider (L-Q3, decided).

Each is a **component adapter** (phase 0's browser-side contract), registered by the module that
owns the identity: `people`, `backends`, `connections`. The components only ever talk to the
adapter, so the same code serves all three.

The panel's own pages stay React. A piece used both in the panel and on pages is written once
in Lit and used by the React page as a custom element.

### The components

**Built today** (13): `<pammy-form>`, `<pammy-comments>`, `<pammy-login>`, `<pammy-logout>`,
`<pammy-signed-out>`, `<pammy-register>`, `<pammy-confirm>`, `<pammy-forgot>`, `<pammy-reset>`,
`<pammy-invite>`, `<pammy-request>`, `<pammy-account>`, `<pammy-welcome>`.

**Added or extended by this plan:**

| Component | Does | Step |
|---|---|---|
| `login`, `logout`, `signed-out`, `register`, `confirm`, `forgot`, `reset`, `account`, `welcome` for a project's users | the same screens for the project's own users | B3 |
| `<pammy-guard role="host">` | shows what's inside only to signed-in people (with that role); "Please sign in" otherwise | B3 |
| `methods="password magic-link code google github"` on `<pammy-login>` | more ways to sign in | B7 |
| `<pammy-mfa>` + a code step in `<pammy-login>` | authenticator app set-up, recovery codes | B8 |
| `<pammy-sessions>` | your signed-in devices, Sign out each | B8 |
| *deferred:* `<pammy-presence channel="room:1">`; `<pammy-form>` / `<pammy-comments>` as the project's signed-in user (F-Q2); `anonymous` and `passkey` in `methods` | | master section 11 |

**Data on a page (L-Q2), after B5:**

| Component | Example |
|---|---|
| `<pammy-list>` | `<pammy-list table="guests" fields="name, plus_ones" order="-created_at" live></pammy-list>`, with a `<template>` inside for each row |
| `<pammy-record>` | `<pammy-record table="guests" key="7"></pammy-record>` |
| `<pammy-count>` | `<pammy-count table="guests" live></pammy-count>` → "31" |

What they show is what the policies let the viewer see; `live` uses realtime. **They render
values as text** (D9); a column marked rich text goes through sanitize-html first.
`<pammy-record-picker>` as a public component is deferred (master section 11).

### Questions on components

- **L-Q1. Names** (provisional, confirm before B3): `pammy-` + one per screen; on a project's
  own pages no attribute, `project=` only from elsewhere, `store=` for external providers;
  instead of a new `lfdln-` family with an all-in-one `<lfdln-sign-in>`. *Suggested: yes.*
- **L-Q2. Data components** (provisional, confirm before B5; changed by the review): `list`,
  `record`, `count` in the plan after B5, **text by default, rich text sanitized** (D9). Without
  them a static page needs its own JavaScript to show data. *Answer: yes, text by default.*
- **L-Q3. External providers: DECIDED 2026-10-06 (firm), (a).** momolig: *"allow external
  providers through own SDKs"*, then *"let's go with a"*. The same tags for every provider; an
  adapter per provider wraps its official SDK and is loaded only when a page uses that provider:
  `<pammy-login store="party">` reads from `/_pammy/data.js` that `party` is Supabase and loads
  the Supabase adapter. Moving the folder to Appwrite changes no HTML and no CSS. (Not chosen:
  a tag set per provider, `<pammy-supabase-login>` …, about 13 screens × 4 providers.) Each
  adapter declares what its provider can do and the components hide the rest; details in
  docs/external-backends-plan.md, "Components on external providers".

## External data stores

Any project can also keep data on **Supabase Cloud, Neon, Appwrite Cloud or Firebase** instead of
this server, and the Studio works with each: **docs/external-backends-plan.md** (steps X1-X9,
questions X-Q0..X-Q13). It touches this plan in two places: a project's Data tab can hold an
lfdln database *or* an external one, and a Backend tab may later expose Neon databases, **only
for read-mostly use** (B-Q5 (c); X-Q8 changed: write-then-check would hold locks across internet
round trips).

## Modules

Today (checked 2026-10-06): **25 packages**: 23 switchable modules (`MODULES` in
`packages/core/src/profile.ts`) plus `core` and `gate`, which every site needs. lfdln has 20
modules on; pammy.org has 19. Phase 0 renames `core` to `kernel` (K-rename, by shim) and makes
`gate` the kernel's gate host; the counts stay the same.

The plans add (M-Q1):

| New | Kind | Plan | Holds |
|---|---|---|---|
| `backends` | module, needs `studio`, `mail` (uses `forms` when on) | this one | the `lfdln-backend` service, data API, auth, policies, realtime, the Backend tab, the components `guard`, `mfa`, `sessions`, `list`, `record`, `count`; fills *data store kinds* (lfdln databases through a Backend tab), *identity providers* (`project:<id>`) and *component adapters*; publishes `backends.row.*`, `backends.user.*` |
| `connections` | module, needs `studio` | external-backends | provider connections, the `lfdln-remote` helper; owns *data consumers*; fills *data store kinds* (Neon, Supabase, Appwrite, Firebase), *identity providers* and *component adapters* |
| `storage` | module | storage | buckets, the objects index, the `lfdln-storage` helper, the Storage tab; owns *storage backend kinds* |
| projects registry | module (C2-min stub, C2-rest in full) | projects-domains | one Projects page and the common tabs (the Backend tab among them); owns *project kinds*. Its id is chosen in C2-min: under PD-Q1 (a) `projects` stays the Code kind's package |
| `client` | package, not a module | this one | `@lfdln/client`, the library apps install; like the kernel, nothing to switch |

→ **27 modules, 30 packages.** lfdln turns all four new modules on (24). pammy.org leaves
`backends` and `connections` off and has the projects registry (its words through the site
glossary): 20, plus `storage` if storage-plan turns it on there.

Changed, but still one module each: `studio` (owns *data store kinds*; the record picker as a Lit
component), `forms`, `comments`, `form-links` (writes through a project's Backend tab), `people`,
`areas` (sign-in screens answer for the project's users, NS-Q4), `projects` (Code), `services`
(Connected), `hosts` (`/_api/` reserved, `api.<domain>`), `php` (`/_pammy/data.js`).

- **M-Q1. Four new modules plus the client package, as above**: **firm, confirmed by momolig
  2026-10-08** (it was due before C1). *Suggested: yes.* The other way would be splitting `backends` into `backend-auth`,
  `backend-policies`, `backend-realtime`, so that, say, a project could have the data API
  without sign-in. *Not suggested:* none of the three works without the others (policies need
  users, realtime needs policies), and a project's Backend tab already turns sign-in methods or
  realtime off for that project.

## In the panel

A **Backend tab on each project** (with the `backends` right, B-Q13; off until switched on).
There is no separate Backends list; the Projects page shows which projects have it on.

- **Overview**: the project's API addresses (`/_api/` on each of its addresses, the
  `api.<domain>` fallback), keys (shown once, rotate), health, counts.
- **Tables**: which of the project's databases (from its Data tab, short names) and which tables
  and columns are exposed (the catalog window, per role); the D7 checks on MariaDB (non-InnoDB
  refused, triggers to OK).
- **Policies**: per table, templates, editor, **Try as**.
- **Auth**: ways to sign in, redirect URLs, allowed origins, email templates, session and token
  lifetimes, send caps, Turnstile, hooks.
- **Users**: list, find, invite, ban, delete, export, sessions, roles.
- **Realtime**: limits, live connections and channels, an inspector to watch a channel.
- **Forms**: attach / detach panel forms (F-Q5).
- **Logs**: API requests (sampled, with O2's request id), auth events, policy refusals.
  Deliveries of its events (webhooks) are on Settings > Events (phase 0).

Buckets and their policies are on the project's **Storage** tab (docs/storage-plan.md, ST4 uses
this tab's policy language).

## Steps

As in docs/master-plan.md section 5, Track B (that file wins on order). **Before B1**: T1, T2,
S6, S1, S2, R1, K0, C1, K-a, K-b, C2-min (hosts route API with `/_api/` reserved, project-kind
stub, secrets delivery) and C6-min (data store adapter and identity contracts, both engines
pass). B1 + B2 complete milestone **M1**; B3 + B4 are M2 (TutorStar on tutorlumi.com); B5 + B6
are M4. 🔒 = reviewed by a second session before install, tests written first (master rule 12).

Each step ships the service, the panel pages, the client library parts and tests on **both
engines**, installed with its own verify. Behind a module switch until B2 works end to end.

| Step | What | Needs | Done when |
|---|---|---|---|
| **B1** 🔒 (keys) | `backends` module (`defineModule`) and `lfdln-backend` on the kernel, `backend` schema, the Backend tab, exposed databases (own logins, D7 checks), keys, `/_api/` on project addresses (S1 proof checked), `api.lesfleursdelanuit.com` | C6-min, C2-min, S1 | `curl https://examprep.lesfleursdelanuit.com/_api/v1/health -H 'apikey: lfd_pub_…'` answers through nginx; without the S1 proof it is refused; `/_api/` on a project without the tab answers 404 |
| **B2** | data API: reads, writes with the secret key (upsert, embeds, counts), D18 limits, `no-store` / `Vary`; client `from()`. Until B4 the publishable key reads only tables marked "anyone can read" in the window; O1's database-connection gauge on Monitoring (decided 2026-10-08) | B1, T2 | M1: `curl 'https://examprep.lesfleursdelanuit.com/_api/v1/main/<table>?select=…&order=…'` with the publishable key returns only the exposed columns; with the secret key insert, update and delete work; the same suite passes on Postgres and MariaDB in CI |
| **B3** 🔒 | auth: users, email + password, confirm, reset, email change, HttpOnly `__Host-` cookie on own addresses, JWT + rotating refresh for `api.<domain>`, JWKS, sessions, Users page, PD2 (export / delete); D6, D9, D14-D16; client `auth`; sign-in components | B2, MS1, PD1 | on tutorlumi.com: sign up → confirm (mail from `mail.tutorlumi.com`) → sign in → refresh in two tabs at once → sign out; refresh-token reuse after the grace revokes the session; a deleted user's rows go |
| **B4** 🔒 | policies: language, parser, read filters, column windows per role, write-then-check with locked keys, upsert, owner default, Policies section, Try as (D1-D3, D7). Publishable key + user sessions on the data API | B3, T3, T4 | the policy suite (templates, team rule, upsert onto someone else's row, key-changing update, hidden-column filters, denied writes rolled back) and the differential suite pass on both engines |
| **B5** | realtime: WebSocket, broadcast, database changes from C5's row events, channel policies, limits, heartbeat, revocation to sockets (D4, D5, D17); client `channel()`; data components (L-Q2) | B4, C5 | two clients see each other's changes, a third without rights sees nothing, a signed-out client's socket stops at once |
| **B6** 🔒 | Forms: attach forms to a project (F-Q5), form links write through the project's write path (F-Q1, narrowed) | B5 | M4: an RSVP sent through `<pammy-form>` and a row written through the API both appear live on a page watching `guests`, filtered by policy; an answer can't set `owner_id` or a column outside the window |
| **B7** | Google, GitHub (verified linking, D6), magic link, email code (D15) | B3 | each method signs in through the client |
| **B8** | TOTP, recovery codes, `aal2` in policies; hooks (webhooks, the custom-claims hook with D16's limits); admin API | B4, C5 | a project that asked for `backends.user.created` gets it, signed; a claims hook setting `role` is refused |
| **B9** | generated types, the Backend tab on the Data tab of any project (docs/external-backends-plan.md), an API reference page in Help | X5 | a Next.js project made in the panel talks to its Backend tab with no hand setup |

**Deferred** (master section 11): anonymous users, passkeys and presence for project users;
F-Q2..F-Q4 (forms for project users, `db.forms()`, responses as a source) until B6 has a user;
`<pammy-record-picker>` as a public component.

Later, not planned here: change data capture (both engines), `rpc`, more than one service
process.

## Questions for momolig

**All answered 2026-10-06.** The namespace and NS-Q1..NS-Q4 are **firm**. momolig took the
suggested answers "for now" for B-Q1, B-Q3..B-Q13, F-Q1..F-Q5, L-Q1, L-Q2 and M-Q1: these are
**provisional** (M-Q1 since confirmed, 2026-10-08), confirmed (or changed) by asking momolig before the step named in each heading
(docs/master-plan.md section 2). Where the review (docs/security-performance-review.md) changed a
suggestion, the changed one is the answer, and the heading says so. The options are kept as the
record.

**B** questions are about a project's Backend tab in general, **F** about Forms, **NS** about
the namespace.

### B-Q1. Names: provisional, confirm before B1

What you'll type and read every day: the tab, the npm package, the start of the keys.

| | Suggested | Other example |
|---|---|---|
| Tab | **Backend** (on each project) | "Data", "Supa" |
| Package | `import { createClient } from '@lfdln/client'` | `'nuit'`, `'@lfdln/supa'` |
| Keys | `lfd_pub_8Kq…` / `lfd_secret_Zx1…` | `supa_pub_…` / `supa_secret_…` |

The key prefixes matter beyond looks: GitHub's secret scanning and our own logs can spot
`lfd_secret_` if it leaks into a commit. *Answer: the first column.* (The question first named a
"Backends" menu item; the namespace made it a tab.)

### B-Q2. One address for all backends, or one per backend: REPLACED by the namespace (firm)

Replaced by "The namespace: the project and the domain" at the top: `/_api/` on the project's own
addresses, `api.<domain>/v1/<project>/` as the fallback. The review had changed the suggestion
from (a) to (b) (D8: one shared origin gives no cookie or script isolation); the namespace gives
(b)'s isolation (each project's own origin) without a host per backend. The options as they were
asked:

**(a) One host, a path per backend:**
```
https://supa.lesfleursdelanuit.com/v1/quiz/db/main/questions
https://supa.lesfleursdelanuit.com/v1/party/auth/token
createClient('https://supa.lesfleursdelanuit.com/v1/quiz', key)
```
**(b) A host per backend:**
```
https://quiz-supa.lesfleursdelanuit.com/db/main/questions
https://party-supa.lesfleursdelanuit.com/auth/token
createClient('https://quiz-supa.lesfleursdelanuit.com', key)
```
(b) looks more like Supabase (`xyz.supabase.co`) and keeps each backend's cookies apart
(OAuth sign-in leaves a short cookie during the redirect). (a) needs one host made once, no
new Hosts entry per backend, and one place for nginx limits. Either is covered by the
wildcard certificate. *Suggested then: (a).* The OAuth cookie is scoped by path (`/v1/quiz/`),
so two backends still don't see each other's (the review showed this is not a boundary).

### B-Q3. Its own service, or inside the gate: provisional, confirm before B1

**(a) Own service** `lfdln-backend` on its own port: if a quiz app opens 2,000 WebSockets or
runs a slow query, `examprep.` and Pamela-style sites served by the gate don't notice; it can
be restarted on its own; its memory is capped on its own.
**(b) Inside the gate:** one process fewer, shares the gate's sign-in code directly, but a bug
in realtime could take forms, comments and sign-in down for every site. *Answer: (a).*

### B-Q4. How the service reaches the databases: provisional, confirm before B1 (with D7)

**(a) Its own login per project per database.** Exposing `examprep`'s `main` database on the
`quiz` project's Backend tab makes a login like `db_quiz_bk` with rights only on what the tab
exposes:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON questions, answers TO db_quiz_bk;   -- not on users_private
```
A mistake in a policy can then never reach a table the project didn't expose, and the
database's own logs say which project did what.
**(b) Through the Studio's helper socket**, as the gate's data API does today: no new logins,
but every query goes through a process that has full rights on every database, and one hop
more per query (matters for realtime re-checks). *Answer: (a)*, **with D7's checks**: on
MariaDB, non-InnoDB tables are refused and triggers listed for an explicit OK, at attach time
and on each catalog push (the apps' own logins keep `TRIGGER` and DDL, so the check can't rely
on rights).

### B-Q5. Which databases can be attached: provisional, confirm before B1

**(a) lfdln ones only:** any database on lfdln-appdb (:5436) or lfdln-appmaria (:3308), e.g.
`examprep`, a new `party` database.
**(b) Also Pamela's** (:3307 / :5433), e.g. her `recipes`: one of your apps could then read
or change her recipe book.
**(c) Also outside databases**, by connection string (a Neon or PlanetScale database).
*Answer: (a).* Her databases stay hers; outside ones can come later if an app needs one
(read-mostly only, X-Q8).

### B-Q6. Which "Sign in with…" buttons: provisional, confirm before B3 (changed: verified linking)

Each provider means registering an app on its site and pasting a client id + secret into the
project's Auth settings.
- **Google, GitHub**: free, quick to register. `db.auth.signInWithOAuth({ provider: 'google' })`.
- **Apple**: needs the paid Apple Developer Program (99 USD/year); mostly matters for iPhone apps.
- **Microsoft, Discord, Facebook…**: same work as Google, add when an app needs one.
*Answer: Google + GitHub in B7; others on request.* **Linking to an existing user only when both
emails are verified** (D6): the provider says so (`email_verified`, GitHub's verified emails)
and ours is confirmed; never on a project with confirmation off; an unconfirmed password is
dropped when linking.

### B-Q7. Phone / SMS sign-in: provisional, confirm before B3

`db.auth.signInWithOtp({ phone: '+33…' })` texts a code. It needs an SMS provider (Twilio,
Vonage) and costs per message (a few cents each, more abroad), plus abuse protection, since
people can make the server send paid texts. *Answer: no.* Email codes do the same job for
free.

### B-Q8. How a query is written on the wire: provisional, confirm before B1 (changed: headers)

The client library hides this, but you'll see it in logs and in `curl`.

**(a) PostgREST-like (Supabase's way):**
```
GET /_api/v1/main/questions?select=id,title,author(name)&topic=eq.maths&level=gte.3&order=created_at.desc&limit=20
```
**(b) A JSON body:**
```
POST /_api/v1/main/questions/query
{ "select": ["id","title",{"author":["name"]}], "where": {"topic":{"eq":"maths"},"level":{"gte":3}}, "order": [["created_at","desc"]], "limit": 20 }
```
(a) is easy to try in a browser and matches Supabase's docs and examples. (b) is easier to build
big conditions in by program. *Answer: (a)*, **with `Cache-Control: private, no-store` and
`Vary: Authorization, apikey, Cookie` on every `/_api/` answer**, storage included, so no proxy
shares one user's GET (it was suggested as "cacheable"; on tutorlumi.com Cloudflare is in front).

### B-Q9. Are a project's users separate from lfdln visitor accounts: provisional, confirm before B3

lfdln already has visitor accounts ("Open with accounts": register, reset, roles on routes).

**(a) Separate:** someone who signs up in the quiz app has a quiz account only. Signing up in
the party app is another account (as on Supabase: one user list per project). Their quiz
password does nothing on `examprep.` or a protected folder.
**(b) Shared:** one lfdln account works in every app and every protected area; a project just
sees "visitor 42" (the `lfdln-visitor` identity provider). Fewer passwords for people, but every
app sees the same users, and a leak in one app's policies concerns all of them.
*Answer: (a)*: each project is its own identity provider (`project:<id>`). If one app should
later use the lfdln account (e.g. exam prep's students), its Backend tab can add "Sign in with
lfdln" as one more way in, the way Google is one. On one route, never both (NS-Q4).

### B-Q10. How sign-in tokens are signed: provisional, confirm before B3 (with D16)

Your own server (e.g. a Next.js route) has to trust a user's token.

**(a) ES256 key pair per project:** the project signs with a private key and publishes the
public one at `/_api/v1/auth/.well-known/jwks.json` (on each of the project's addresses, and
`api.<domain>/v1/quiz/auth/…`). Your server checks a token with the public key only:
```ts
import { verifyUser } from '@lfdln/client/server';
const user = await verifyUser(req, 'https://quiz.lesfleursdelanuit.com/_api/v1');
```
Nothing secret on your server; keys can be rotated without redeploying apps.
**(b) One shared secret (HS256) per project:** your server holds the same secret that signs
tokens; if it leaks from one app's environment, anyone can make tokens. Supabase is moving
away from this. *Answer: (a)*, **with D16**: ES256 pinned (no `alg` from the token), a `kid`
required from that project's JWKS, `iss` and `aud` checked; the claims hook can't set `role`,
`sub`, `aal`, `iss`, `aud`, `session_id` and fails closed; `user_metadata` not allowed in
policies; the gate verifies project tokens from keys in the database.

### B-Q11. How policies are written: provisional, confirm before B4

Example rule: "people read published questions, and their own drafts; only the author can
change a question".

**(a) Text, SQL-like (parsed, never pasted into SQL):**
```
select   using  published or author_id = auth.uid()
update   using  author_id = auth.uid()     check  author_id = auth.uid()
```
**(b) Only a form-builder:**
```
Who can see a question:   [ anyone ▾ ] when [ Published ▾ ] [ is yes ▾ ]
                     or:  [ signed in ▾ ] when [ Author ▾ ] [ is me ▾ ]
```
*Answer: (a), with templates and (b) for the simple cases.* Team rules
(`team_id in (select team_id from members where user_id = auth.uid())`) are awkward in a form.

### B-Q12. Where the client library comes from: provisional, confirm before B1

**(a) Served by the service:**
```
npm i https://api.lesfleursdelanuit.com/client/lfdln-client-1.0.0.tgz
<script type="module"> import { createClient } from '/_api/client/v1.js' </script>
```
**(b) Published on npm** as `@lfdln/client`: `npm i @lfdln/client`. Public for anyone to see;
needs an npm account and a publish step on each release.
**(c) A GitHub repo**, `npm i github:lesfleursdelanuitdev/lfdln-client`: private, but every
build machine needs access to the repo.
*Answer: (a); npm later if it's useful.* Phase 8b's build containers can reach the server's
own address.

### B-Q13. Who can switch on a project's Backend tab: provisional, confirm before B1

**(a) A `backends` right**, like `hosts` or `projects`: given to momolig now; another
programmer could be given it later, and would see only the Backend tabs of projects they own.
**(b) Panel admins only**, no right to hand out. *Answer: (a), held by momolig only.*

### F-Q1. A form saving into a project's table: through the Backend tab or around it: provisional, confirm before B6 (changed: narrowed)

Example: the RSVP form saves into `guests`, exposed by the `party` project's Backend tab; the
party page shows a live guest list.

**(a) Through the Backend tab:** the row is written by the project's write path, the project's
logs show "form rsvp inserted guest 31". The form link stays the permission for that insert
(you chose the pairs), so no `anon` insert policy has to be opened on `guests` for it.
**(b) Around it, as today:** the row goes in through the Studio helper. The live list still
updates (the event `studio.row.inserted`), but the project's column window doesn't apply, and
its logs never show it.
*Answer: (a), narrowed by the review*: the form link skips the **role** rule only; the
policies' `check` and the column window still apply; `owner_id` is never taken from an answer.

### F-Q2. "Only signed-in visitors" with a project's users: provisional, DEFERRED until B6 has a user

Today "signed in" means an lfdln visitor in a protected area. On the party app the person is
signed in to the **party project** instead.

**(a) Forms can be "Only users of project party":**
```html
<pammy-form name="rsvp"></pammy-form>     <!-- on party's own pages; project="party" from elsewhere -->
```
The component uses the party session (the cookie on party's addresses, the client's token
elsewhere), the response records who sent it as `project:party / 7f3c…` (the identity
contract), and the form link fills `guests.user_id` with it. Someone not signed in sees "Please
sign in first." The gate verifies the token from keys in the database (D16).
**(b) No:** a form on an app page stays anonymous; the app writes the user id itself with
`db.from('guests').insert(…)` and doesn't use a form.
*Answer when it comes back: (a).*

### F-Q3. Forms in the client library: provisional, DEFERRED until B6 has a user

**(a) Yes:** `db.forms('rsvp').definition()` and `db.forms('rsvp').submit({...})`. The app
draws its own inputs, the panel still checks the answers, guards against spam, sends the
notice, waits for approval, and saves to the table. Changing a question in the builder
changes what `definition()` returns.
**(b) No:** an app either embeds `<pammy-form>` or skips Forms and inserts rows itself.
*Answer when it comes back: (a).*

### F-Q4. Reading a form's responses through the Backend tab: provisional, DEFERRED until B6 has a user (changed: limited)

Example: the party app's admin page lists RSVPs, with new ones appearing live.

**(a) Responses as a read-only source** with policies:
```
form:rsvp   select   using  auth.jwt('app_metadata.role') = 'host'
```
```ts
db.from('form:rsvp').select('created_at, answers').eq('status', 'approved')
```
plus realtime on new responses. The person's project session is enough; no forms key in the
app.
**(b) Keep the forms API only:** the app's server holds a forms key and calls
`/_pammy/api/forms/...`; nothing live.
*Answer when it comes back: (a), limited by the review*: `form:<name>` exposes the answers,
`created_at` and status only, **never the IP, host or visitor**. The forms API stays for Pamela
and for forms not attached to a project. If the form already saves into a table (F-Q1), the app
can just read that table instead.

### F-Q5. Which forms a project's Backend tab can use: provisional, confirm before B6

**(a) Attached explicitly:** on the Backend tab's Forms section you pick `rsvp` and `feedback`.
Only those write through it (and, when they come back, answer to `db.forms()` and
`form:<name>`). A form can be attached to one project.
**(b) Every form momolig can see**, with no attaching step: less clicking, but a form
someone else made for a site folder could be read by an app.
*Answer: (a).*

### NS-Q1. Database names in the address: DECIDED (a), firm

**(a) A short name per project** (`main`, `legacy`), chosen on the Data tab, one marked default:
`/_api/v1/main/questions`. **(b) The real database name** (`db_examprep`). *Suggested: (a)*: real
names carry prefixes (`db_`, P8-15) and change if the database moves (to Neon, say); the short
name keeps every app's addresses the same.

### NS-Q2. One database in two projects: DECIDED (a), firm

**(a) One owner per database**, with read-only sharing to another project as a visible option
on both Data tabs. **(b) Several owners, equal.** *Suggested: (a).* Example: if Gonsalves' public
and admin sites became two projects, `ligneous_frontend` belongs to one and is shared read-only
with the other.

### NS-Q3. Users across a project's domains: DECIDED (a), firm

TutorStar lives on tutorlumi.com and tutor.lesfleursdelanuit.com. **(a) One user list per
project, a session per host** (signing in on one domain doesn't sign you in on the other; the
same password works on both), as visitor sessions work today. **(b) A user list per domain.**
*Suggested: (a).*

### NS-Q4. Who answers the sign-in components on a project's pages: DECIDED (a), firm

On `examprep.lesfleursdelanuit.com`, `<pammy-login>` with no attribute could mean today's lfdln
visitor accounts (protected areas, "Open with accounts") or the project's own Backend users.
**(a) The project's own users when its Backend sign-in is on, else lfdln visitors**; `areas`
keeps protecting routes and folders as now. **(b) Always lfdln visitors unless `project=` is
given.** *Suggested: (a)*, and a project shouldn't have both on the same route (the panel says
which one a route uses).

## Not here

- Installing Supabase itself (one database per stack, Postgres only).
- supabase-js compatibility.
- Realtime for writes made outside the panel's modules (PHP, WordPress, `psql`; later: change
  data capture publishing the same events).
- File storage: **docs/storage-plan.md** (buckets on local disk or S3, the Storage tab; ST4 adds
  `client.storage` and bucket policies in this plan's language, local buckets first).
- Off-server copies and restore of the `backend` schema: master Track R (R1-R4).
- Edge functions (Code projects, phase 8b), `rpc`, GraphQL.
- pammy.org: the module stays off there.
