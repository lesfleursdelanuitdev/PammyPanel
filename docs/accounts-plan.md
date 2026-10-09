# Accounts for visitors: register, reset by email, "Open with accounts"

Status: **decided 2026-09-25** by momolig: A1-A9, and every suggestion taken (Q1-Q9). **Revised
2026-09-26** to fit docs/roles-plan.md (see "Revised with the roles plan"). **Step 1 live** on
pammy.org since 2026-09-26 (installed with roles step 2, release b946bb4a). **Step 2 live**
2026-09-26 (lfdln 5c7e153e, pammy.org b9eac5a7; the sample emails read and accepted by momolig).
**Step 3 live** 2026-09-26 (lfdln e417cd3d, pammy.org ebb7b983). **Step 4 built** 2026-09-26 (see
"Step 4 as built"). Next: roles step 5, then step 6. Asked
for by momolig for lesfleursdelanuit.com (first user: Placement Exam Prep, see its
`NEXTJS-PLAN.md` on the `nextjs` branch of lesfleursdelanuitdev/placement-exam-prep).

What this is for: today a visitor account exists only to open protected folders. The owner makes
every account, nobody changes their own password, and a forgotten password waits in Requests for
the owner to pass on a link by hand. lfdln needs **public sites where people still have accounts**:
they register themselves, sign in, change their password, get a reset link by email, and the apps
on that site know who is signed in.

## Revised with the roles plan (2026-09-26)

docs/roles-plan.md came after this plan and changed the ground under steps 2-6. Nothing decided
above changes; where things live and what they're called does:

- **Where the code goes** (roles step 1, live): accounts, sign-in and the built-in pages are
  `@panel/people`; the switches are Settings > Visitors (`@panel/settings`, live); visitor mail is
  `@panel/mail`. The Users page below is the **People** page.
- **Grants are roles** (roles steps 2-4, live): "who may open what" is a role in each area's
  role set. Registering gives an account with **no role anywhere** (Q3 holds); what someone
  signed in without a role may do is each area's "signed in, no role given" slot (empty on
  every protected folder, so pammy.org's folders stay shut to a new account). Deleting an
  account takes its memberships with it.
- **Step 5 is roles step 5**: areas on routes, the *Open with accounts* built-in set, signed-out
  passes. The `openAreas` switch stays: it lets an owner use that set at all.
- **What apps receive** is the roles plan's: account, username, role and privileges, with the
  site's prefix (`X-Lfdln-*` to a service behind a route; `PAMMY_*` to PHP on pammy.org, which
  roles step 3 already sends). Q7 is answered by that, not by the gate's PHP door.
- **Q1's apps to tell** are the services behind an area on a route (roles step 5).
- **Mail on lfdln** (decided 2026-09-26): from `noreply@mail.lesfleursdelanuit.com`, replies and
  notices to `owner@example.com`, with **a copy of pammy.org's Resend key** (the same
  account and verified domain). The two sites then share Resend's daily limit (100 a day on the
  free plan), so Q5's 200 a day becomes **40 visitor mails a day per site** (5 per address stays).

## Decided (2026-09-25)

| # | Decision | By |
|---|---|---|
| A1 | **The panel owns the accounts** (the gate), not each app. Apps only learn *who* is signed in. | momolig |
| A2 | **One account reaches the whole site** (all of lesfleursdelanuit.com that uses accounts). The cookie is per hostname, so each subdomain signs in once. | momolig |
| A3 | **Username and password.** People register themselves, change their password, and get a **time-limited reset link by email**. | momolig |
| A4 | **Email is required and confirmed**: the account works only after the confirmation link is used. | momolig |
| A5 | **Every new visitor feature is a switch the panel's owners turn on or off, off by default.** pammy.org keeps today's behaviour unless its owners choose otherwise; lfdln turns them on. Nothing is hard-wired to one site. | momolig |
| A6 | Reset links: **1 hour, used once**. Confirmation links: **24 hours**. A reset or a password change **signs the person out everywhere**. | momolig |
| A7 | Passwords: **at least 10 characters**, and a **list of common passwords** (bundled, no lookup elsewhere) is refused. No other rules. | momolig |
| A8 | Sign in with **username or email**. | momolig |
| A9 | People can **delete their own account**; the apps they used are told and delete their data (GDPR: the server is in Germany). | momolig |

## What there is today (checked 2026-09-25)

- `gate.visitors` (username, name, scrypt `password_hash`, `active`, `contact`), `gate.sessions`
  (hashed tokens, per host, 30 days: `VISITOR_SESSION`), `gate.grants` (visitor → area),
  `gate.links` (hashed one-time setup links, 7 days: `LINK_LIFETIME`), `gate.requests`
  (`access` / `reset`, handled by hand). Passwords: `packages/core/src/gate/passwords.ts`
  (scrypt N=2^15, cost in the stored string).
- Visitor routes: `packages/areas/src/gate/routes/visitors.ts` (`/_pammy/me`, `login`, `logout`,
  `forgot`, `request`, `invite`). Signing in **needs a protected folder** (`targetOf`) and a grant
  to it: there is no sign-in on a public page.
- The gate decides on **real folders on disk** (`packages/areas/src/gate/policy.ts`): an area is a
  folder (marker file or its path in `gate.areas`). A route to a service has no folder.
- lfdln's profile (`sites/lfdln/src/profile.ts`) has modules `hosts`, `php`, `services` only. **No
  `mail`, no `areas`, no gate** (docs/lfdln-standup-plan.md Q1; platform plan phase 8). Its database
  (:5435) already has the `gate` schema from the baseline; `pammy_gate` there is NOLOGIN.
- The gate's entry point is still pammy's (`sites/pammy/src/gate/app.ts`).
- Mail (`packages/mail`): pammy-mail sends through Resend, from settings in
  `/etc/pammy-mail/settings.json` and the key in `resend.key` (root 600). It sends **notices to the
  owner**, not mail to visitors. Resend has `mail.lesfleursdelanuit.com` verified already.

## The switches (A5)

On a new **Users → Settings** page, seen and changed only by the panel's admins (a new right,
`visitor-settings`, docs/permissions-plan.md style). Every change is in Activity.

| Switch | Needs | Off (today's behaviour) |
|---|---|---|
| **People can register themselves** | Emailed links on | The owner adds people, or approves "ask for access" |
| **Emailed links** (confirm an address, reset a password, change of address) | this panel's mail working (module `mail` on and set up) | A forgotten password goes to Requests; the owner passes a link on by hand |
| **People can change their own password** | - | Only the owner, or a setup link |
| **People can delete their own account** | - | Only the owner |
| **"Open with accounts" areas** | People can register themselves | Only protected folders have a sign-in |

- A switch the panel can't support is shown greyed out **with the reason** ("mail isn't set up on
  this panel"). Turning a needed switch off first turns off the ones that need it, and says so.
- Stored in a new table `gate.visitor_settings` (one row). The gate reads it into memory with the
  areas (`live.ts`, P14: nothing on a public page waits for Postgres).
- **Protected folders, Requests and setup links keep working exactly as now**, whatever is on.
- pammy.org: all off. Its verify checks that with every switch off, the gate's answers and pages
  are the same as before (the built-in pages, `/_pammy/*` status codes, the nginx files).

## Proposal

### Accounts

- **`gate.visitors` gains** `email` (lower-cased, unique when set), `email_confirmed_at`,
  `registered` (true: made by the person, not the owner). The owner's people keep working with or
  without an email.
- **`gate.links` gains** `purpose` (`setup` today; `confirm`, `reset`, `email-change`) and
  `new_email`. Each purpose has its own lifetime (setup 7 days as now, confirm 24 h, reset 1 h,
  email-change 24 h). Only the hash of a token is stored, as now; a new link of the same purpose
  cancels the old one.
- **Registering**: username (today's `VISITOR_NAME_RE`), email, password twice. The same answer
  whether or not the username or email is taken (**"Check your email"**): if the email already
  has an account, that address gets "you already have an account, here is how to reset" instead.
  The username being taken is said on the form (it's public anyway: it's the sign-in name), the
  email never is. A honeypot field and rate limits (per address and per IP) as `/_pammy/request`.
- **Unconfirmed accounts** can't sign in, and are removed after 48 hours (Q2).
- **Signing in** with username or email (A8). Same limits and events as today's `/_pammy/login`.
- **Forgot password** (emailed links on): always "If that account exists, we've sent a link"; the
  link (1 h, once) opens a page to choose a new password; using it signs out everywhere and signs in
  here. With emailed links off: today's Requests flow, unchanged.
- **Account page** (`/_pammy/account`): change password (needs the current one; signs out other
  sessions), change email (confirmation to the new address, a notice to the old one), sign out
  everywhere, delete my account (needs the password).
- **Deleting an account**: the visitor, sessions, grants and links go; events keep only the
  username. The apps that use accounts are told (Q1).
- **Registered people open no protected folder** until an owner grants it (Q3): registering gives
  an account, not access.

### "Open with accounts" areas

- A new **kind of area**: `open`. Anyone may see everything in it; the gate only says *who* is
  signed in. It can be put on **a site folder** (as protected folders are) **or on a route**
  (hosts module; G3 said "a protected area can be put on it like any route").
- On a **site folder**: pages ask `/_pammy/me` (as today) and can use `<pammy-login>`-style
  widgets; PHP pages get the account from the gate's PHP door (Q7).
- On a **route to a service** (a Next.js app): nginx asks the gate (`auth_request`, as for
  protected folders) and passes **`X-Lfdln-Account: <id>`** and **`X-Lfdln-Username`** to the
  app. nginx **clears both headers from the client's request first**, and the app listens only on
  127.0.0.1, so only nginx can set them. Signed out: the headers are empty and the request still
  goes through (it's open). The gate's answer is cached in memory (P14), so a Postgres outage signs
  nobody out for 60 s and never blocks the page.
- The built-in pages (`/_pammy/register`, `confirm`, `login`, `forgot`, `reset`, `account`,
  `logout`) work on every host with an open area. A folder can give its own, as `login.html` today
  (`register.html`, `login-reset.html`, `account.html`; same exact-name rule).
- Apps link to them with `?next=` (same-host paths only: `safeNext`).

### Mail to visitors

- **lfdln gets its own mail service** (`lfdln-mail`, the `mail` module on in its profile): its own
  settings `/etc/lfdln-mail/settings.json`, its own Resend key `/etc/lfdln-mail/resend.key` (root
  600), from `noreply@mail.lesfleursdelanuit.com`. pammy-mail is not touched.
- The mail service gains **visitor mail**: only the fixed kinds (confirm, reset, email-change
  notice, already-registered, account deleted), plain text, the site's name and the link. **No text
  from anyone goes into a visitor mail** (it can't be used to send spam). Limits per address (5 a
  day) and per site (Q5).

### The gate on lfdln

- The gate's entry point moves from `sites/pammy/src/gate/app.ts` into a shared one that reads the
  site profile (the same move phase 1 made for the panel). lfdln gets `lfdln-gate.service`
  (+ admin socket), its role `lfdln_gate` on :5435 (LOGIN, DML on `gate` only, `pg_hba` entry), and
  the `areas` module on in its profile. Only what accounts need is switched on: forms, comments,
  media and data APIs stay phase 8.
- The visitor cookie's name comes from the profile (`__Host-lfdln_visitor` on lfdln; pammy's stays
  `__Host-pammy_visitor`).
- nginx: the gate's include is rendered only on hosts with an area, so every other lfdln host's
  file stays byte for byte the same.

### In the panel (Users)

- **Users** lists registered people with the owner's: email (confirmed or not), registered or
  added, last sign-in, switched on or off. Owners can switch someone off, sign them out, resend a
  confirmation, delete. Owners never see or set a registered person's password (they can send a
  reset link).
- **Hosts / folders**: "Open with accounts" as a choice beside "Protected".
- **Users → Settings**: the switches.

## Steps

| Step | What | Risk |
|---|---|---|
| 1 | **Live.** **The switches, all off**: `gate.visitor_settings`, the Settings page, the gate reading it; accounts columns and link purposes (migrations in `packages/areas/migrations`). pammy.org installs it and nothing changes (its verify, plus the all-off checks). | low |
| 2 | **Visitor mail** in `packages/mail` (fixed kinds, limits), and **lfdln's mail service** (profile, unit, installer, key copied from pammy.org's). Tested by sending every kind to momolig (`lfdln-panel mail-samples`). | low |
| 3 | **The gate on lfdln**: shared entry point, `lfdln-gate`, `lfdln_gate` role, `areas` on in the profile, cookie name, nginx include only where an area is. No areas yet, so no host changes. | medium |
| 4 | **Accounts** in `@panel/people`: register, confirm, sign in with email, forgot/reset by email, account page, delete; built-in pages; unconfirmed purge; the People page lists registered people. Behind the switches. | medium |
| 5 | **Replaced by docs/roles-plan.md step 5** (2026-09-26: areas on routes, with roles and privileges). Was: **"Open with accounts" areas** on folders and routes, the identity headers, the app hook (Q1), the Users page changes. | medium: nginx for live hosts |
| 6 | lfdln turns the switches on; a test host with an open area; verify-lfdln checks (headers can't be forged, signed-out passes, reset link expires, a used link is refused); a guide (**written 2026-09-27**: `lfdln-guides/accounts-guide.txt`, for the lfdln panel's people; not in `guides.map`, so not on pammy.org's Help). | low |

### Step 1 as built (2026-09-26)

- `packages/areas/migrations/0001-visitor-accounts.sql`: `gate.visitor_settings` (one row, five
  switches all off; checks: self-register needs emailed links, open areas need self-register),
  `gate.visitors.email / email_confirmed_at / registered` (lower-case, unique when set), and
  `gate.links.purpose / new_email` (every existing link is `setup`). It runs on every site.
- `packages/core/src/gate/visitor-settings.ts`: the switches, what each needs, and **`BUILT`**,
  the switches this code can carry out. It is **empty in step 1**, so no switch can be turned on
  anywhere yet (the page says "This comes in a later release of the panel."); each later step adds
  its own. A true in the database that the running code can't carry out counts as off (going back
  a release is safe). Emailed links also need the panel's mail ready (module `mail` on and
  pammy-mail's `status` ready): the panel tells the gate, which has no mail of its own.
- The gate reads the row with the areas (`live.ts`, every 60 s and after every change) and saves it
  in the same `areas.json` snapshot (`visitorSettings`); an older snapshot means all off. Admin
  socket: `visitor-settings.get`, `visitor-settings.set` (key, on, mail).
- Setup links work as before: only a `setup` link chooses a password on the invite page, and a new
  setup link cancels only the old setup link. Sign-in already refuses an account that is
  `registered` and not confirmed (A4); there are none yet.
- Panel: `GET/POST /api/visitor-settings` (the new right `visitor-settings`: account managers
  have it, members only if given), the page **Visitors > Settings** (`/visitor-settings`), and
  Activity (`visitor-setting-on` / `-off`, naming what was also turned off).
- Checks: `test/visitor-settings.test.ts`, `test/panel.test.ts`, `test/e2e/39-visitor-settings.spec.ts`;
  `verify-panel.sh` "visitor settings": one row, all off (database, gate, snapshot), the gate
  refuses turning one on, no registered accounts or non-setup links, and `/_pammy/register`,
  `confirm`, `reset`, `account` still 404 on pammy.org.

Each step is one release (build.sh, the installer, verify). Exam prep goes live on accounts after
step 6 (its plan, step B5).

### Step 3 as built (2026-09-26)

- **One gate for every site**: `packages/gate` (`@panel/gate`) is the gate's app, admin door,
  housekeeping and start-up, each taking the site's profile (what used to be
  `sites/pammy/src/gate/`). `sites/pammy/src/gate/{main,app,admin}.ts` bind it to pammy.org's
  profile and keep their old names, so pammy.org's units, tests and behaviour are unchanged;
  `sites/lfdln/src/gate/main.ts` starts lfdln's. It is not a module (like the core): it puts
  the modules' gate parts together, and a module switched off adds nothing (routes, the
  example pages, housekeeping). The admin door refuses a request of a module the site has off
  ("Unknown request.", before the database is asked).
- **The cookie's name** is the profile's (`services.gate.cookie`): `__Host-lfdln_visitor` on
  lfdln, `__Host-pammy_visitor` (the default) on pammy.org. The gate's context has it
  (`ctx.cookie`); sign-in, sign-out, the check and the data API read it from there.
- **lfdln's profile**: module `areas` on (people, requests and the rest stay off: signing in
  comes with step 4), `services.gate` 127.0.0.1:**3047** (snapshot
  `/var/lib/svc-lfdlngate/areas.json`), `sockets.gateAdmin` `/run/lfdln-gate-admin.sock`
  (also in panel.env; the panel doesn't ask it yet).
- **Its database role keeps the code's name, `pammy_gate`** (as lfdln's `pammy_owner` and
  `pammy_panel`, deploy/lfdln/pg/lib-pg.sh: its own cluster, the same names), not
  `lfdln_gate` as proposed above: the migrations and db/schema.snapshot.sql grant to
  `pammy_gate`. It now signs in (LOGIN, a podman secret `lfdln-pg-gate`, `pg_hba` entry,
  `/etc/lfdln-panel/db/gate.pass` root 600). Adding the secret changes lfdln-pg's Quadlet,
  so **the install restarts lfdln-pg once** (lfdln's panel only; the apps' database, :5436,
  is not touched).
- **lfdln-gate.service** + **lfdln-gate-admin.socket** (deploy/lfdln/): user `svc-lfdlngate`
  (home 700, `lfdln-sites` only while running, to read the site folders like nginx),
  `/var/www` empty but for the site folders (read-only), no capabilities, localhost only,
  the database password by LoadCredential; the admin door `root:svc-lfdlnpanel 660`. The
  installer's section 6d starts it and asks it (`/check` without nginx's headers: 403; the
  admin door's `state`, as the panel's user). release-lfdln now carries `public-gate/`
  (the gate reads its component files and page at start-up).
- **nginx: nothing changes.** No area exists on lfdln, and the gate's include is only ever
  rendered on a host with an area (roles step 5), so no host's file names the gate.
- Checks: `test/lfdln-gate.test.ts` (lfdln's routes are only its modules', pammy.org's all
  there; only its own domain; admin requests of switched-off modules refused; pammy.org's
  cookie opens nothing, its own does), test/profile.test.ts (the units say what the profile
  says); verify-lfdln: the gate role's password and rights (its tables, not the panel's; not
  pammy.org's password; its own not pammy.org's), and a gate section (user, port, fails
  closed, admin door only for the panel's user, forms refused, switches off, no area, no
  host sends to it, the sandbox).

### Step 4 as built (2026-09-26)

- **The switches**: `BUILT` gains `emailedLinks`, `selfRegister`, `changePassword` and
  `deleteAccount` (`openAreas` waits for roles step 5). Emailed links need the panel's mail
  set up **and the gate's own door to the mail service** (below); the gate says whether it
  has one (`gateMail` in `visitor-settings.get`/`set`), and refuses the switch without it.
  So on **pammy.org** (no door in its profile) emailed links and registering can't go on;
  changing and deleting one's own account could, and stay off. Nothing is switched on
  anywhere by this step.
- **The gate's door to the mail service**: a second socket, `lfdln-mail-visitor.socket`
  (`/run/lfdln-mail-visitor.sock`, `root:svc-lfdlngate 660`), handed to the same
  `lfdln-mail.service` (`Sockets=`, told apart by `LISTEN_FDNAMES`). Behind it the mail
  service answers only `visitor`, counted with the panel's door against the same limits
  (`createMailDoors`). The profile names it (`services.sockets.mailVisitor`); the gate gets
  a `VisitorMailer` from it (`@panel/core/gate/context`). The panel's door stays the panel's.
- **Store** (`@panel/core/gate/store`): `visitorByLogin` (username first, then the address:
  A8), `signInCheck` (says "confirm your address first" only to someone who typed the right
  password: A4), `registerVisitor`, `makeEmailedLink` (a new link cancels the last of its
  purpose), `useConfirmLink` (a new account's address, or a new address: the old one gets
  `email-changed`), `useResetLink` (1 h, once, signs out everywhere, counts the address as
  confirmed), `changeOwnPassword` (keeps this session, ends the others and any open reset
  link), `startEmailChange`, `deleteOwnAccount`, and the hourly purge of accounts nobody
  confirmed within 48 h (Q2). **A7**: `passwordProblem` refuses the 9,126 common passwords
  of 10+ characters from the UK NCSC's 100,000 (`common-passwords.txt`, bundled, any case),
  for every password, the owner's too. **No migration**: step 1's columns carry it.
- **Gate routes** (`@panel/people/gate/routes/accounts.ts`), each a 404 while its switch
  is off: `GET /_pammy/accounts` (what the pages may offer), `POST /_pammy/register`,
  `confirm`, `reset-link`, `reset/check`, `reset`, `account/password`, `account/email`,
  `account/signout`, `account/delete`; the built-in pages `/_pammy/register`, `confirm`,
  `reset`, `account`. Links go to the hostname asked from, `/_pammy/<page>#<token>`.
  Answers that could tell whether an address has an account are the same either way
  (register with a taken address: that address gets `already-registered` with a reset
  link; reset-link; a new address another account has). No email, no account: a
  registration whose confirmation can't be sent is removed again (limits say "try later").
  A reset asked from a folder's page for an account with no address still becomes a
  Requests entry (requests module on). Sign-in (`/_pammy/login`) takes an address too,
  and, with "register" on, signs in to the site itself when no folder is named (A2).
  `/_pammy/me` gives the signed-in person their own address.
- **Components** (`packages/areas/widgets/login.ts` -> `login.js`): `<pammy-register>`,
  `<pammy-confirm>` (confirms when opened, so a mail program looking at the link confirms
  nothing), `<pammy-reset>`, `<pammy-account>`; `<pammy-login>` says "Username or email"
  and, outside a folder, links to registering and the emailed reset; `<pammy-forgot>` sends
  an emailed link when that's on. The built-in pages' title names the site (`@SITE@`).
- **Panel**: People shows an account's address, "made their own account" and "hasn't
  confirmed", and for such an account no "Set a password" or setup link (the gate refuses
  them too) but **Email a reset link** and **Send the confirmation again** (the gate
  emails, to the hostname they last used; Activity `person-reset-link-sent`,
  `person-confirm-link-sent`). An owner deleting one sends it `deleted`.
- **lfdln**: module `people` on (the gate's sign-in and account routes). **Its panel's
  pages don't change yet**: People and Settings > Visitors join lfdln's menu in step 6,
  when the switches are turned on there.
- Checks: `test/accounts.test.ts` (every switch off; register, confirm, sign in by
  address, taken username/address, mail down or full, reset, account page, the owner's
  side, the purge, sign out everywhere, delete, switches off again), `test/mail.test.ts`
  (the gate's door), visitor-settings/panel/gate/lfdln-gate/route tests brought in line,
  e2e 39. verify-lfdln: the gate's door (only svc-lfdlngate; visitor emails only), the
  gate says it can mail, account pages 404 and nobody can register while off, no
  registered account or emailed link. verify-panel: pammy.org's gate refuses emailed
  links and says `gateMail` false.

### Step 2 as built (2026-09-26)

- **Visitor mail** (`packages/mail/src/mail/visitor.ts`): six fixed kinds -- `confirm`,
  `reset`, `email-change`, `already-registered` (each with a link), `email-changed` and
  `deleted` (notes after the fact, no link). Plain text, sent in the site's name (Q9), reply-to
  the site's reply address, no panel footer. **Nothing a caller writes reaches the text**: the
  request names only the kind, one address and (where the kind has one) a link, and the link
  must be `https://` to the site's domain or a subdomain, under `/_pammy/`. The address is
  never logged. Limits: 5 a day per address, 40 a day per site (revised Q5), in memory; a
  failed send counts for nothing.
- The mail service's socket gains `visitor` and `visitor-samples` (one of each kind to the
  notice address, marked as samples, to read the words: Q9). `status` says how many visitor
  emails went today. Nothing sends visitor mail yet: the gate will, in step 4 (the gate then
  needs its own way to this socket, which today only the panel's user may open).
- **lfdln-mail**: the `mail` module on in lfdln's profile (from, reply-to, notices and socket),
  `sites/lfdln/src/helpers/mail.ts` (20 notices and 40 visitor emails a day: one Resend account
  with pammy.org), `deploy/lfdln/lfdln-mail.{service,socket}` (user `svc-lfdlnmail`, the same
  sandbox as pammy-mail, and pammy-mail's settings blocked), the installer's section 6c (copies
  pammy.org's key only while lfdln has none; settings with replies and notices to
  owner@example.com), `lfdln-panel mail-status` and `lfdln-panel mail-samples`.
- verify-lfdln: the user, socket (only the panel's user), key 600 and unreadable to the
  service, LoadCredential, the sandbox, ready to send, the 40-a-day limit, and two refusals
  that are decided before Resend is asked (a link off the site, two addresses in one).
- Tests: visitor mail (texts, links, addresses, extra fields ignored, limits, a failed send,
  the samples).

## Step 4b: as built (2026-09-26): apps told when an account is deleted (Q1)

- **The gate notes every deletion.** `areas/0006-account-deletions.sql` adds `gate.deleted_accounts`
  and an AFTER DELETE trigger on `gate.visitors`, in the same transaction as the delete. That
  catches every way an account goes: an owner, the person, the 48-hour cleanup of unconfirmed
  accounts, and a registration taken back.
  - The admin ops are `deletions.list` and `deletions.told` (with `told`, `done` and `error`).
  - The gate's housekeeping forgets a row after 30 days, whether or not it was passed on.
    pammy.org has no services, so its rows only ever go this way.
- **The panel passes them on** (`packages/services/src/panel/account-deleted.ts`, run every
  minute by lfdln's `server.ts`).
  - It tells every service behind a route with accounts whose `known.ts` entry has
    `accountDeleted`. Exam prep is the only one: `/_lfdln/account-deleted`.
  - The call goes straight to `127.0.0.1:<port>`: a POST of `{account, deletedAt}`, signed with
    HMAC-SHA256 over `<ms>.<body>`. The signature goes in `X-Lfdln-Timestamp` and
    `X-Lfdln-Signature: v1=<hex>`, and the app refuses anything more than 5 minutes off.
  - A service that answers 200 counts as told. Otherwise it is tried again after a minute, 5
    minutes, 30 minutes, then every 6 hours.
  - With no service to tell, a deletion is done at once.
- **Keys.** `install-lfdln.sh` makes `/etc/lfdln-panel/hooks/<id>.key` (root 600, in a folder of
  700).
  - The panel gets the folder as its credential `hooks`, so each file arrives as
    `hooks_<id>.key` (tried on systemd 255).
  - The app's installer copies its own key (exam prep: the podman secret `examprep-hook`), so the
    lfdln panel is installed first.
- **nginx.** A host with a service route answers 404 for `/_lfdln/` from outside, and no route
  may be under `/_lfdln/` (`routePath`).
- **People** lists the deletions still being passed on, with their tries and last answer. This
  is on lfdln only, and only for whoever sees everyone.
- **Tests and checks.** `test/account-deletions.test.ts` covers every path, signing, the backoff,
  a missing key, and no service to tell. verify-lfdln checks the trigger, the keys, the panel's
  credential and the outside 404. Exam prep's verify makes a signed call and an unsigned one.

## Questions

- **Q1. How apps are told an account was deleted.** Suggested: the gate calls each service behind
  an open area at `POST http://127.0.0.1:<port>/_lfdln/account-deleted` with the account id, signed
  with a per-service secret (HMAC, a podman secret), and retries until it answers 200. The Users
  page shows a deletion still waiting. **Decided: as suggested.**
- **Q2. Unconfirmed accounts removed after 48 hours.** Suggested: yes. **Decided: as suggested.**
- **Q3. Registering opens no protected folder** until an owner grants it. Suggested: yes. **Decided: as suggested.**
- **Q4. Session length** stays 30 days, sliding. Suggested: yes. **Decided: as suggested.**
- **Q5. Mail limits**: 5 visitor mails a day per address, 200 a day per site; over it, the form
  says to try later and the panel shows it. Suggested: yes. **Decided: as suggested.**
- **Q6. A bot check** (Turnstile) on register and forgot: not now; honeypot and rate limits, and
  Turnstile as its own later piece (it's already on pammy's list). Suggested: not now. **Decided: as suggested.**
- **Q7. PHP pages on an open folder** get `$_SERVER['LFDLN_ACCOUNT']` through the gate's PHP door.
  Suggested: yes, in step 5 (it's small), or later if nobody needs it yet. **Decided: as suggested.**
- **Q8. Can owners edit a registered person's username or email?** Suggested: email no (it must
  be confirmed by its owner), username yes (renaming is today's `visitor.rename` for the display
  name; the sign-in name stays). **Decided: as suggested.**
- **Q9. The emails' words**: plain, short, the site's name as sender name ("lesfleursdelanuit.com
  <noreply@mail.lesfleursdelanuit.com>"), and a line saying to ignore it if it wasn't you.
  Suggested: yes; momolig reads them in step 2. **Decided: as suggested.** Read on 2026-09-26
  (`lfdln-panel mail-samples`): "okay for now" -- the words stay as they are.
