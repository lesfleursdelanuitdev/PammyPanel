# Module settings: what each part lets you set

PROPOSED 2026-10-06. Nothing built. **SET-Q1..SET-Q6 DECIDED 2026-10-08** (momolig took every
suggestion). The mechanism (section 2) is built on K-b's **settings sections** extension point
(module-dependency-graph, decided 2026-10-08): one mechanism, so U11 needs K-b.

momolig, 2026-10-06: *"we need to also determine what are the options for each module themselves.
What settings can users set for those?"*

Part of Track U (docs/modular-use-plan.md): once parts can be turned on and off (Settings >
Parts, ES-Q3), each part needs a place for its own settings. Read from the code on `main`
(98d1dc4) by three read-only passes, 2026-10-06; file and line references are in those passes'
notes, the important ones below.

## What there is today

**Almost nothing can be set module-wide.** Across 24 modules, five settings pages exist:

| Today | Module | Who | Site |
|---|---|---|---|
| Settings > Visitors: six switches (emailed links, register, change own password, delete own account, "Open with accounts", roles) | core (`gate/visitor-settings.ts`) | `visitor-settings` right | both |
| Settings > Email: Resend key, from, reply-to, notices-to | settings / apps helper | `software` right + fresh passkey | **pammy only**; lfdln = installer |
| Settings > Email: which forms, comment areas and requests send notices | settings / mail | `software` (pammy), admin (lfdln) | both |
| Settings > Backups: keep nightly copies 7-365 days (default 60) | services | admin + fresh | lfdln; covers only the two Studio databases |
| Monitoring: email on / off; quiet 1, 4 or 24 h; "keep as it is now" | monitoring | admin | lfdln |

Everything else a site might want different is a **constant in code** (about 150 found), a
**profile value** (upload size, trash days) or a **deploy file** (PHP limits, backup timers).

**Per-item settings are rich** and stay where they are: a form's switches and questions, a
table's abilities, a route's accounts, a project's owners. Gaps there are listed per module below.

**Values copied into words drift.** "24 hours" (setup link), "7 days" (visitor link), "30 days"
(trash), "within an hour" (reset email) are typed into pages, Activity sentences and emails, and
`passkeys.ts:122` repeats the 8-hour idle time. Change the constant and the words lie.

**Same thing, different numbers.** Certificate warning: 14 days in host checks, 21 in monitoring.
Trash: one profile value, plus three separate 30-day constants (forms, file records, catalog). Who
may change mail: a right on pammy, admin on lfdln.

## 1. Four kinds of option

| Kind | Example | Where it lives | Who |
|---|---|---|---|
| **Part settings** (new) | visitor session length; forms per hour per visitor | Settings > Parts > *part*, declared by the module | admins (SET-Q1) |
| **Item settings** (exist) | one form's "Show right away"; one table's "Anyone can read" | the item's own page | the item's right |
| **My settings** (exist / U4) | "my parts"; grid or table; Getting started card | the person's account page or the browser | the person |
| **Installer facts** (stay) | ports, sockets, paths, the home domain, engine versions | site profile, env, deploy files | momolig, by install |

This plan is about the first kind, and lists gaps in the second.

## 2. How part settings work (proposal)

- **Declared by the module** in `defineModule`:
  ```ts
  settings: {
    perVisitorPerHour: { kind: 'count', default: 10, min: 1, max: 100,
      words: 'Responses one visitor may send in an hour', applies: 'gate' },
    newFormButton: { kind: 'text', default: 'Send', max: 60, words: 'Button words on a new form' },
  }
  ```
  Kinds: switch, count, duration (with units), size, text, choice, list (of names or addresses).
- **Defaults are today's values**, so nothing changes until someone changes a setting.
- **Every setting has a range** (min / max), and the ones that protect people have **floors**
  (SET-Q5): a setting can make the site stricter freely, looser only to a limit.
- **Stored by the kernel** in one table (`panel.part_settings`: part, key, value, changed by, when),
  checked against the declaration, written in Activity, and published as an event
  (`kernel.setting.changed`, C4). The gate gets the values with its state push, like the visitor
  switches today.
- **Words read the setting**: "works once, for 7 days" is built from the value, never typed.
  Pages, Activity sentences and emails all ask the setting.
- **Settings that change server files** (nginx body size, PHP limits, backup timers) are marked
  `applies: 'install'`: saving them runs the installer's helper, the same path as turning a part
  on (ES-Q3), with a fresh passkey.
- **Kernel settings** (sessions, trash, Activity, program rate limits) use the same mechanism under
  Settings > General.
- Settings > Visitors, Email and Backups **move onto it** with no change to what they do.

## 3. Proposed settings, part by part

Columns: the setting, **today's value** (the default), a sensible range, and **who** (A = admin,
A+ = admin with a fresh passkey). "Install" = applied through the installer's helper.

### Kernel (always on): Settings > General

| Setting | Today | Range | Who |
|---|---|---|---|
| Panel: sign out after unused for | 8 h | 1-24 h | A+ |
| Panel: sign out after at most | 7 days | 1-30 days | A+ |
| Ask for the passkey again after | 10 min | 5-30 min | A+ |
| Panel setup link works for | 24 h | 1-72 h | A+ |
| **Keep deleted things for** (one trash setting for files, folders, forms, responses, software, projects, catalog's missing items, file versions) | 30 days (four separate constants today) | 7-90 days | A+ |
| Keep Activity for | forever | 90 days - forever | A |
| Programs: requests a minute with a key / without / with a bad key | 600 / 120 / 30 | stricter freely; looser up to 2× | A+ |

### Hosts (always on)

| Setting | Today | Range | Who |
|---|---|---|---|
| Re-check hosts every | 10 min | 5-60 min | A |
| New site folders run PHP | on | on / off | A |
| Names no one may take (added to the built-in panel, www, api, mail, git) | — | list | A |
| Certificate warning | 14 days (monitoring says 21) | one value, shared with monitoring | A |

Item gaps: a domain can't be edited after it's made (only deleted); a route's headers and
cache-forever paths are stored but have no editor; a service route always sends websockets.

### Visitors / protected areas: areas, people, requests (always on)

Settings > Visitors' six switches stay as they are, under this part.

| Setting | Today | Range | Who |
|---|---|---|---|
| Visitors stay signed in for | 30 days, no idle limit | 1-90 days | A+ |
| …and are signed out after unused for | never | never, or 1 h - 30 days | A+ |
| Visitor setup link works for | 7 days | 1-14 days | A+ |
| Email confirmation link works for | 24 h | 1-72 h | A+ |
| Password reset link works for | 1 h | 15 min - 24 h | A+ |
| Shortest visitor password | 10 | 10-64 (floor 10) | A+ |
| Remove unconfirmed self-registrations after | 48 h | 24 h - 14 days | A |
| Sign-in tries: per address in 15 min / per username in an hour | 10 / 20 | stricter freely; looser up to 2× | A+ |
| Register, reset, ask-for-access: per address an hour | 5 / 5 / 5 | 1-20 | A+ |
| New protected folders take "let me in" requests | on | on / off | A |
| Open requests: per folder / in all | 50 / 300 | 10-1000 | A |
| Keep handled requests, sign-in events for | 180 days | 30-730 days | A |

Item gap: lfdln routes always take requests (no per-route switch).

### Mail (always on)

| Setting | Today | Range | Who |
|---|---|---|---|
| Sender: Resend key, from, reply-to, notices-to | panel on pammy, installer on lfdln | the same page on both (SET-Q3) | A+ |
| Which forms, comment areas, requests send notices | none chosen | lists | A |
| Notices: at most an hour / a day | 60 / 90 (lfdln 20 a day) | 1-60 / 1-90 | A |
| Visitor emails: per address a day / per site a day | 5 / 40 | 1-10 / 1-90 | A+ |

The Resend account's own limit (momolig's, shared) caps the sum; the page shows what's left.

### Backups (always on, new module, U8)

| Setting | Today | Range | Who |
|---|---|---|---|
| Keep nightly copies for | 60 days, Studio databases only | 7-365 days, **every source** (panel database 14, WordPress 14, "before" copies 60 today) | A+ |
| Run nightly backups at | 03:30-05:15, per timer | a start time; sources run in turn | A+, install |
| Off-server copies (R1) | R1 live 2026-10-08: R2 + B2, 7 daily / 4 weekly / 6 monthly, set in root-only `/etc/lfdln-offsite` | on / off, where, keep for | A+ (with R1) |

### Monitoring (always on)

| Setting | Today | Range | Who |
|---|---|---|---|
| Email when something goes down | on | on / off | A |
| Check every | 5 min | 1-15 min | A |
| Call it down after | 2 failed checks | 1-5 | A |
| "Still down" reminder every | day | 6 h - 7 days | A |
| Emails a day at most | 10 | 1-50 | A |
| Quiet for | 1, 4, 24 h | add 15 min, 7 days | A |
| Certificate: warn / down at | 21 / 7 days | shared with hosts | A |
| Disk: warn / down at free | 15% / 5% | 5-50% / 1-20% | A |
| Newest backup older than | 26 h | 12-72 h | A |
| Keep events for | 90 days | 30-365 days | A |
| Other addresses to watch; DNS records to watch | hard-coded in lfdln's site | editable lists | A |

### Files (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Largest upload | 100 MB (profile) | 1-1024 MB | A+, install (nginx) |
| Earlier versions kept per file | 50, kept with the trash setting | 5-200 | A |
| Saves within … count as one version | 5 min | 1-60 min | A |
| Check for files added outside the panel every | 15 min | 5-120 min | A |
| Folder names no one may take | www, api, panel, media | add to the list | A |

### Media and thumbnails (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Public media API: most files per page | 100 | 20-500 | A |
| Thumbnail size / quality | 320 px / 75 | 160-640 / 50-90 | A (remakes thumbnails) |

### Catalog (optional)

Missing items keep their labels for the kernel's trash setting (today a separate 30 days). No
other part setting; tagging is switched per table and per service (item settings).

### API keys (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Working keys at most | 50 | 10-200 | A |

### PHP (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Memory / largest upload / longest run | 128 MB / 8 MB / 20 s | 64-512 MB / 1-128 MB / 5-120 s | A+, install |
| Pages running at once | 8 | 2-32 | A+, install |

### Forms (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Responses one visitor may send in an hour (shared with comments today) | 10 | 1-100 | A |
| Forms at most (with the trash) | 200 | 10-1000 | A |
| Per form: unread / stored at most | 1000 / 10000 | 100-10000 / 1000-100000 | A |
| New form: button words / thank-you words | "Send" / built-in | text | A |
| Remember which pages a form was on for | 90 days | 7-365 | A |

Item gaps: comment areas can't be deleted from the panel (user-stories gap 1).

### Form links (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Keep trying a failed save for | about a day (96 × 15 min) | 1 h - 7 days | A |

### Comments (optional, a Forms plugin after U3)

| Setting | Today | Range | Who |
|---|---|---|---|
| Comments one visitor may post in an hour (own, no longer shared with forms) | 10 | 1-100 | A |
| Comments per page by default | 20 | 5-100 | A |
| New comments wait for approval | always (until the robot check) | stays forced on until a robot check exists | — |

### Studio / databases (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Database keys at most | 40 for all databases together | per database, 1-100 | A |
| Largest write through the data API | 2 MB | 64 KB - 10 MB | A+, install (nginx) |
| Rows a table may have to be tagged | 20,000 | 1,000-100,000 | A |
| New tables: "Filter" ability on | off | on / off | A |

Item gaps: a field's "filterable" has no switch; "Make a copy" has no button; "show what else it
affects" doesn't list the records (user-stories gaps 8-10).

### Installed software / WordPress (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Installs at most | 3 | 1-10 | A+ |
| New install: memory (web / database) | 512 / 384 MB | 256-2048 MB | A+, install |
| New install: largest upload | 64 MB | 8-256 MB | A+, install |
| Keep its backups | 14 days | follows Backups (always on) | — |

Item gaps: automatic updates are always on with no per-install switch or status.

### Services (optional)

No part settings. The list of services is in code (`known.ts`) until N3 reads it from root-owned
files; that is the gap.

### Projects (optional)

| Setting | Today | Range | Who |
|---|---|---|---|
| Nightly package updates start at | 03:00 | a time | A |
| Build: longest / memory | 15 min / 2 GB | 5-60 min / 1-8 GB | A+ |
| Releases kept per branch | 3 | 1-20 | A |
| New project servers: memory (main / dev) | 512 / 256 MB | 128-4096 MB | A |
| Git tokens: lifetimes allowed / default / per person | 30, 90, 365 days, never / 90 / 10 | choose; "never" can be refused | A+ |
| Build proxy: extra sites builds may reach | npm, GitHub, nodejs.org, Google Fonts, Prisma | add to the list | A+, install |

Item gap: a project's server memory is fixed per branch kind, not per project.

### Examples, Getting started (optional)

No part settings.

## 4. Steps (Track U)

| Step | What | Needs | Pamela | Size |
|---|---|---|---|---|
| **U11** | the mechanism: `settings` in `defineModule`, `panel.part_settings`, Settings > Parts > *part* pages (each a module's settings section, K-b), Activity, the gate's copy, words built from values | C1, K-b, U6 | no (nothing changes) | M |
| **U12** | today's settings move onto it: Visitors switches, Email, Backups days, monitoring email; the mail sender page on both sites (SET-Q3) | U11, U8 | yes: same settings, new place | M |
| **U13** | constants become settings, part by part, defaults = today; the four trash constants become one; the certificate thresholds become one; copied words read the values | U11 | no until changed | M per part |
| **U14** | install-applied settings: upload size, data API write size, PHP limits, backup times, WordPress limits, build proxy list | U13, U6 (ES-Q3's helper) | yes | M |

## Questions for momolig

### SET-Q1. Who may change a part's settings?
(a) admins only; (b) anyone with that part's right; (c) admins for the security ones, the part's
right for the rest. **DECIDED 2026-10-08: (a)**, as suggested, with a fresh passkey for those marked A+. Settings change
the site for everyone; rights are for doing the work.

### SET-Q2. One value for the whole site, or per domain?
lfdln serves several domains (tutorlumi.com, gonsalvesfamily.com). Visitor session length or
sign-in limits could differ per domain. **Suggestion: site-wide now**; the table keeps a `scope`
column so a per-domain value can be added later without a migration of meaning. **DECIDED
2026-10-08: site-wide, with the `scope` column.**

### SET-Q3. The mail sender on lfdln: editable in the panel like on pammy?
**Suggestion: yes**, the same page on both sites, admins with a fresh passkey. Mail is now
essential (ES-Q1), so who may change it shouldn't differ by site. **DECIDED 2026-10-08: yes.**

### SET-Q4. Activity: keep forever?
**Suggestion: forever stays the default**, with the setting there for when the table grows.
**DECIDED 2026-10-08: as suggested.**

### SET-Q5. Floors on security settings
May an admin make the site *less* safe than today (passwords under 10, panel sessions over 30
days, looser rate limits)? **Suggestion:** hard floors as in the tables: stricter freely, looser
only to the stated limit, never below today's password minimum. **DECIDED 2026-10-08: as
suggested.**

### SET-Q6. One trash setting for everything?
Today four separate 30-day values. **Suggestion: one kernel setting** ("Keep deleted things for"),
which every module reads; a module can't keep things longer or shorter on its own. **DECIDED
2026-10-08: as suggested.**
