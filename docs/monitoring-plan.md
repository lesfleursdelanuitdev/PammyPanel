# Monitoring (platform phase 7c)

DECIDED 2026-09-27: momolig took every suggestion (Q1-Q8).

What it is: the checks the lfdln panel can already make, made on their own every few minutes,
kept for a while, and mailed to momolig when something goes down or comes back. The platform
plan's line: "every host's checks every few minutes, mail when one fails" (G4), "the kinds'
health checks every few minutes, a short history, mail when something goes down or comes back"
(G6), plus "expiry and nameservers, mail DNS records" (phase 7c).

**lfdln only.** A new module, `@panel/monitoring`, on in lfdln's profile and off in pammy.org's.
pammy.org's panel doesn't change.

## What there is today (checked 2026-09-27)

- **The hosts' checks** (docs/domains-hosts-plan.md step 3): the routing helper's `check` asks
  its probe, a root unit with network, about each name. Does its DNS point here? Does the
  certificate nginx gives cover it, with how many days left? Does it answer (under 500)? The
  answers are kept 10 minutes. `check-domain` does the same for a domain as a whole.
- **The services' health** (docs/adopt-plan.md V7): the services helper's `status` gives each
  part of TutorStar, Gonsalves and exam prep. Is it running? Is it masked (stopped on purpose)?
  Does it answer at its health path, and how fast?
- **Mail**: lfdln-mail sends notices to the notice address only (owner@example.com),
  with links into the panel only, **20 a day at most**. It shares one Resend account (100 a day)
  with pammy.org.
- **Jobs**: the panel runs its own timers (housekeeping every hour, deleted accounts every
  minute). **The panel has no network beyond localhost** (its sandbox), so every check goes
  through a helper.
- **Backups**: nightly dumps of lfdln-pg (04:45 UTC) and lfdln-appdb (05:00 UTC), and of
  pammy-pg. Nothing checks that they ran.
- **Mail DNS** (dig, 2026-09-27): DKIM at `resend._domainkey.mail.lesfleursdelanuit.com`, SPF and
  MX at `send.mail.lesfleursdelanuit.com`, DMARC `p=none` at `_dmarc.lesfleursdelanuit.com`.
  Nameservers: ns1-3.dreamhost.com.
- **Not on lfdln's hosts yet**: gonsalvesfamily.com and admin.gonsalvesfamily.com (their nginx
  is hand-written until 7b), and pammy.org's sites (another panel).

## M1. What is watched

| Group | Each check | How | How often |
|---|---|---|---|
| **Hosts** | every name every host answers to (`@` with www): DNS here, certificate covers it, it answers | routing helper `check`, fresh | 5 min |
| **Services** | every part: running and answering at its health path. A part stopped from the panel (masked) is **stopped on purpose**, not down | services helper `status` | 5 min |
| **The panel's own** | the gate, the mail service, lfdln-pg, lfdln-appdb, the helpers: each answers | their sockets and ports, from the panel | 5 min |
| **Certificates** | days left on each certificate nginx gives: a warning under 21 days, down under 7 (Let's Encrypt renews at 30) | from the hosts' checks | 5 min |
| **Backups** | the newest nightly dump of lfdln-pg, lfdln-appdb and pammy-pg is under 26 hours old and not empty | a new read-only `backups` op of the services helper (root, reads the three backup folders' newest file) | hourly |
| **Disk** | free space on `/` and `/mnt/storage`: a warning under 15%, down under 5% | the same op (`statfs`) | hourly |
| **Mail DNS** | the DKIM, SPF/MX and DMARC records above are there, as they were when Monitoring was turned on | a new probe task, `records` (DNS only) | hourly |
| **Nameservers** | lesfleursdelanuit.com's NS records are still DreamHost's | the same task | hourly |
| **Other addresses** (Q5) | a short list of https addresses outside lfdln's hosts: they answer under 500, and their certificate isn't close to expiring | a new probe task, `url` (only https, only names that resolve to this server) | 5 min |

## M2. Down, and back

- A check that fails **twice in a row** is **down**; one pass and it is **back**. So a restart
  that takes a minute doesn't mail anyone.
- A warning (certificate under 21 days, disk under 15%) is shown, and mailed once.
- **Quiet for maintenance**: an admin can make a host, a service or everything quiet for 1, 4 or
  24 hours. It is still checked and shown, but not mailed. Its end is in Activity. (The
  Gonsalves switch, a panel install.)
- A service part stopped from the panel isn't down: it says "stopped on purpose, since …".

## M3. Mail

- **One email per round** with everything that went down or came back ("2 down: tutor.… (no
  answer: 502), Gonsalves / Public site (not running). 1 back: …"), linking to
  `/monitoring`. Never more than one every 5 minutes.
- **A limit of its own**: at most 10 monitoring emails a day, out of lfdln-mail's 20. When the
  limit is reached, one last email says so ("more changes today: see the panel"), and the page
  says what wasn't mailed.
- Still down after a day: **one reminder a day** (Q3).
- To the notice address, which is all lfdln-mail sends to. Mail to a host's owner (G6) would need
  the mail service to send to other addresses: later (Q1).
- The words are plain, like the other notices: what, since when, what it said. Never a password,
  never a visitor.

## M4. History

- The current state of every check (last result, since when, how many failures in a row).
- **Every change** (down, back, warning, quiet) kept **90 days**, as rows. The page shows the
  last 7 days per check and the share of checks passed.
- Not every result: a check that passes every 5 minutes writes nothing new, so the table stays
  small.

## M5. The page

- **Monitoring** in the menu (lfdln), right `monitoring`: see (anyone given it) and change (quiet
  for maintenance, mail on/off: admins). G5's "ericka sees Monitoring".
- At the top: **All well**, or what's down now, first.
- Then the groups of M1. Each check shows its last result, since when, and its last changes.
  **Check now** (once a minute at most, like the Hosts page's Check again).
- A tile on Home: "All well" or "2 down", linking to the page.
- Phone-first, as every page.

## M6. Where it runs

- **In the panel's process**, as the other jobs are: a round every 5 minutes (the slow checks on
  the hour), asking the routing helper and the services helper, never the network itself. One
  round at a time. A helper that doesn't answer is a failure of that group, not of every check
  in it ("the routing helper didn't answer").
- **A watchdog** (Q6): if the panel itself is down, it can't mail that it is. A small root timer,
  `lfdln-watchdog`, every 10 minutes: the panel answers on 127.0.0.1:3046, and its last round is
  under 15 minutes old. If not, it sends one notice through lfdln-mail's socket (at most one an
  hour).

## M7. Tests and verify

- Unit: down after two failures, back after one pass, quiet, stopped on purpose, the mail limit,
  one email per round, the history's 90 days.
- Browser (lfdln): the page all well; a check made to fail (the stand-in helpers say no) shows
  down and a mail is asked for; quiet; on a phone.
- verify-lfdln: a round ran in the last 10 minutes; every check in it passed (or says which
  didn't); the watchdog timer is on.

## Steps

| # | What | Risk |
|---|---|---|
| 1 | The module, its schema, the round (hosts, services, the panel's own), down/back, quiet, mail, the page, Home's tile | low: it reads only |
| 2 | The slow checks: backups and disk (a services helper op), mail DNS and nameservers (a probe task), certificate warnings | low |
| 3 | The watchdog; other addresses (Q5); the domain's registration (Q4, if wanted) | low (built 2026-09-28) |

### Step 1 as built (2026-09-27)

- **`@panel/monitoring`** (depends on core only; the site hands it what to ask):
  - `state.ts`: the rules, pure. Down after 2 failures in a row, back after 1 pass. A part
    stopped from the panel, or a host switched off, is `stopped` (said, not mailed). Still down:
    a `still-down` once a day. One email per round, 10 lines at most, down first.
  - `panel/collect.ts`: the round's answers. Every name of every host (the routing helper's
    `check`, fresh), every part the panel can start and stop (the services helper's `list`), the
    panel's own pieces. A helper that doesn't answer is one failure of its own
    (`panel:routes`, `panel:services`), and its group's rows are left as they were.
  - `panel/monitor.ts`: the round, one at a time, in one transaction. It ends quiet whose time
    is up (in Activity), steps, writes, keeps the changes 90 days, and emails through
    lfdln-mail's `notice` (after the rows are written; a failed send is the round's note).
  - `panel/routes/monitoring.ts`: `GET /api/monitoring`, `POST /api/monitoring/check` (once a
    minute), and for admins `POST /api/monitoring/quiet` (a subject or everything, 1, 4 or 24
    hours), `.../quiet/:id/end` and `.../mail` (on/off). Each is in Activity.
  - Migration `monitoring/0001-monitoring.sql`: `monitor_checks`, `monitor_events`,
    `monitor_quiet`, `monitor_mail`, `monitor_settings`. Every site gets the tables.
- **lfdln** (`sites/lfdln/src/app.ts`, `server.ts`): the module on; the pieces are lfdln-pg
  (`SELECT 1`), lfdln-appdb (something listens on 127.0.0.1:5436, `PANEL_APPDB_PORT`), the gate,
  the mail service (`status`: ready), the folder helper. A round every 5 minutes, the first a
  minute after the panel starts. pammy.org: off (its profile leaves it out).
- **The right `monitoring`** (Accounts): the page and Check now. Admins: quiet and mail.
- **The page** `/monitoring`: All well, or what's down; Hosts, Services and the panel's own,
  each check with its state, why, since when and its last change; Emails; Quiet for
  maintenance (admins); the last 7 days. **Home**: a "Down now" tile.
- Tests: `test/monitoring.test.ts` (the rules, the collecting, the round on Postgres: quiet,
  mail off, 10 a day, a failed send, 90 days, one round at a time); the browser (lfdln): a demo
  part answering 500 is down after two rounds with one email, quiet keeps its coming back out
  of the mail, End now, Check now, Activity; the page on a phone. verify-lfdln waits for a round
  after the install and says what isn't passing.

### Step 2 as built (2026-09-27)

- **Certificates** (group `certs`, every round): one row per certificate nginx gives, by its
  names, from the hosts' checks (the probe now says `covers`: the certificate is for the name,
  whatever its days). Under 21 days: to look at ("renewing has failed", since Let's Encrypt
  renews at 30); under 7: down. A host whose certificate covers it passes; its days are the
  certificate row's, so an expiring wildcard is one row, not one per host.
- **Backups and disk** (groups `backups`, `disk`, hourly): the services helper's new op
  `storage` runs `packages/services/src/storage.ts` as a root unit of its own
  (`lfdln-services-storage-…`): the helper's root has no capability, so it can't open the
  700 backup folders, and its sandbox hides /mnt/storage. The folders and disks are
  `BACKUPS` and `DISKS` in known.ts; the unit checks them again (only
  `/var/lib/svc-*/backups`). Per folder: the newest nightly batch by its file stamp (every
  `…-<stamp>-nightly.dump` with that stamp; not `before-*`, roles or `.part` files), under 26
  hours old, none empty. Disks on the same device are one row ("Disk space: / and
  /mnt/storage": one disk today). Under 15% free: to look at; under 5%: down.
- **Mail DNS and nameservers** (group `dns`, hourly): the routing helper's new op `records`
  (the probe's `records` task: TXT, MX or NS, sorted, only names under the domain asked
  about, 20 at most). lfdln watches DKIM `resend._domainkey.mail.…`, SPF and MX at
  `send.mail.…`, DMARC `_dmarc.…` and the NS of the domain. The first reading is kept
  (`monitor_baseline`, migration `monitoring/0002`); a later one that differs is "changed:
  now …; it was …", and down after two hours. An admin's **Keep as it is now** (the row's
  button; `POST /api/monitoring/records/keep`, in Activity) drops the kept reading and runs a
  round, which keeps the new one. None there: "no TXT record (it was …)".
- **Hourly**: the first round after a start, then when an hour has passed since the last
  slow one, and every **Check now**. Between, the slow groups (and their helpers' rows,
  `panel:storage` and `panel:records`, by key) are left as they were: `step`'s unread takes
  keys as well as groups.
- A passing check keeps its words now (days left, a backup's age and size, a record's
  values); step 1's checks had none to keep.
- Tests: `test/monitoring.test.ts` (certificates, backups, disks, records, hourly),
  `test/monitoring-helpers.test.ts` (the probe's records, the routing helper's op, storage.ts,
  the services helper's op); the browser (lfdln): every group on the page, nameservers
  moving, down, kept. verify-lfdln: the four groups there, the root unit read them, five
  records kept.

### Step 3 as built (2026-09-28)

- **Other addresses** (group `other`, every round; Q5): gonsalvesfamily.com/,
  admin.gonsalvesfamily.com/api/health, pammy.org/ and panel.pammy.org/login (`OTHER_ADDRESSES`
  in `sites/lfdln/src/app.ts`), through the routing helper's new op `urls` (20 at most, a name
  and a path each) and the probe's task `url`. **Changed from the plan:** a name that points
  here is asked of nginx here, as the hosts are; a name behind **Cloudflare** is asked
  **through Cloudflare**, as visitors reach it -- pammy.org's panel closes anything that
  doesn't come from Cloudflare (444), so asking it here would always fail. A name that points
  anywhere else (or partly elsewhere) isn't asked at all. Each: it answers under 500, and a
  certificate for the name with its days judged as the certs group's (under 21 to look at,
  under 7 down). Quiet works per address (its name is the subject). The helper not
  answering: `panel:urls` fails and the group stays as it was.
- **The registration** (group `domain`, hourly; Q4): the routing helper's op `registration`,
  the probe's task `rdap` -- only the registries in `RDAP_BASES` (.com and .net at Verisign,
  .org), never an address a request names. The row is always "up": "registered until
  2027-10-09 (376 day(s))", or "not read: …". It is never down or to look at, so it is
  never mailed.
- **The watchdog** (Q6): `packages/monitoring/src/watchdog.ts`, run by
  `lfdln-watchdog.timer` (10 minutes after it starts, then every 10) as a root oneshot that
  keeps only `CAP_DAC_READ_SEARCH` and localhost. The round writes
  `/var/lib/svc-lfdlnpanel/monitor-round.json` (`PANEL_MONITOR_BEAT`, the panel user's, 600)
  after each round; the watchdog asks `http://127.0.0.1:3046/login` (under 500) and reads the
  file (under 15 minutes old). Two failures in a row send one notice through
  `/run/lfdln-mail.sock` (so an install's restart mails no one); while it stays wrong, one a
  day (stricter than "one an hour": the mail service has 20 a day); when right again, one
  "the panel is back". A notice that couldn't be sent is tried again on the next run. Its
  state: `/var/lib/lfdln-watchdog/state.json`. The installer puts the units in (section 8b).
- Tests: `test/monitoring.test.ts` (other addresses, the registration never mailed, the
  watchdog's rules and the round file), `test/monitoring-helpers.test.ts` (the probe's `url`
  against a real TLS server: here, through Cloudflare, not elsewhere; `rdap`; the helper's
  two ops); the browser (lfdln): both sections, an address down after two rounds with one
  email, back. verify-lfdln: four other addresses, the registration read, the round's file
  fresh and the panel user's, the timer on and enabled, and a watchdog run that finds
  nothing wrong.

## Questions

- **Q1. Who gets the mail?** Suggested: the notice address only (owner@example.com),
  as now. Mail to a host's owner later, when there are owners who aren't you.
- **Q2. The mail limit.** Suggested: at most 10 monitoring emails a day, of lfdln's 20.
- **Q3. Still down.** Suggested: one reminder a day while something stays down.
- **Q4. The domain's registration** (RDAP: when lesfleursdelanuit.com expires). Suggested: shown
  on the page only, **never mailed**.
- **Q5. Addresses outside lfdln's hosts.** Suggested: watch https://gonsalvesfamily.com/,
  https://admin.gonsalvesfamily.com/api/health, https://pammy.org/ and
  https://panel.pammy.org/login from here too, with mail when they go down. Gonsalves's become
  ordinary hosts with 7b.
- **Q6. The watchdog.** Suggested: yes (step 3).
- **Q7. How often.** Suggested: every 5 minutes; backups, disk and DNS records hourly.
- **Q8. History.** Suggested: changes kept 90 days; the page shows 7.
