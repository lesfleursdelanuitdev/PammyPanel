# Phase 9: guides

PROPOSED 2026-10-01 on branch phase-9. **DECIDED 2026-10-03**: momolig took every suggested
answer (P9-1..P9-6 yes, "okay, start the guides"). Order decided by momolig 2026-10-01: phase 8 (8-8
deferred), then **phase 9 (guides)**, then 8b (Projects).

What docs/platform-plan.md says phase 9 is: *"Guides and Getting started for lfdln's people,
and guides for roles, the catalog and the hosts setup guide (both panels)."* Low risk: it's
mostly writing, with one small code change so lfdln can show guides.

## What there is today (checked 2026-10-01)

- **Help is pammy.org's.** `@panel/help` reads the guides `build.sh` copies into `release/help/`
  from `../guides.map`, the 21 guides written for Pamela (`00-README` to `20-comments`). The
  Help page says "the same ones as in your instructions folder". The routes give a limited
  account a fixed list of Pamela's file names (`LIMITED_GUIDES`, `GUIDE_OF`). Getting started
  (the questionnaire and paths on Home) is about her projects: blog, pinboard, recipes.
- **lfdln has neither.** Its profile leaves `help` and `examples` off (P8-12: phase 9 writes
  lfdln's own guides instead). `release-lfdln/` has no `help/`.
- **One lfdln guide exists:** `lfdln-guides/accounts-guide.txt` (198 lines, 2026-09-27: visitor
  accounts, routes with accounts, exam prep as the example). It's in the Help format but not
  shown anywhere.
- **The hosts setup guide is already in the panel:** Hosts > Add a domain
  (`AddDomain.tsx`, D-5) asks the questions and checks each requirement. A written guide only
  needs to point to it and explain what the answers mean.
- **lfdln's menu** (sites/lfdln/web/src/menu.ts): Inbox (Responses, Comments, Requests); Sites
  (Hosts, Services, File Explorer, File tags, Tags & categories, Monitoring); Media; Forms;
  Databases (Your databases, Database users); Visitors (People); Settings (Email, Visitors);
  Account (API keys, Passkeys & devices, Accounts, Activity). A route's Access page is reached
  from Hosts.
- **lfdln's people** (platform plan U1, U2): momolig (admin), badmon and monadelanuit
  (programmers with Unix accounts), ericka (panel only, no Unix account; looks after things
  like Forms), maybe one more. Unlike Pamela they don't need the web explained, but ericka
  needs the panel explained in plain words.
- **No guide covers these pages yet:** Hosts and domains, Services, Monitoring, the Access page
  (roles), Tags & categories for apps (catalog step 5), the API keys page, the Studio on
  lfdln-appdb (db_ logins, app databases read-only). On pammy.org, her guides were written
  before the catalog move, the API keys page, the roles under People/Requests and pammy.org
  moving onto its hosts (8-7). Most of that changed nothing she sees, but nobody has checked
  each guide against today's panel.

## Steps

| Step | What | Risk |
|---|---|---|
| 9-1 | **Help on lfdln**: guides per site, Help switched on for lfdln with `accounts-guide.txt` as its first guide | low |
| 9-2 | **lfdln's guides** (L1-L7 below), written and shipped | none (text) |
| 9-3 | **Getting started on lfdln**: a short first-steps list on Home, ticked from what the panel can see | low |
| 9-4 | **pammy.org: her guides checked against today's panel**, wrong or missing parts fixed, synced to her instructions folder | none (text) |

Each step is one release (build.sh, both installers, verify). Steps 9-2 and 9-4 are text only,
but a guide changed after the build makes the install refuse, so a guide edit always means a
rebuild.

### 9-1. Help on lfdln

- **Guides per site.** Each site has its own map: `guides.map` stays pammy.org's;
  `lfdln-guides/guides.map` lists lfdln's (file name, then the name shown in order, as now).
  `build.sh` copies each site's into its release (`release/help/`, `release-lfdln/help/`), and
  both installers keep refusing a guide changed after the build.
- **Which guide a limited account sees** comes from the site, not from Pamela's file names
  hard-coded in the routes: each map line can name the right that guide is about
  (`forms`, `hosts`, ...). A limited account sees the guides for the rights it has, plus every
  guide with no right named. pammy.org's lines carry what `LIMITED_GUIDES` and `GUIDE_OF` say
  today, so what Pamela's limited accounts see doesn't change.
- **The Help page's words** come from the profile: "the same ones as in your instructions
  folder" on pammy.org only.
- lfdln's profile turns `help` on (not `examples`). The menu gets **Help** in the Account
  group. Getting started stays off until 9-3.
- Not on lfdln: an instructions folder on disk. Guides are read on the panel, and the source
  files are in the repository for anyone with access.
- Tests: guides per site; a limited account's list on each panel (pammy.org's unchanged);
  verify-lfdln: `/api/help` lists lfdln's guides and none of Pamela's.

#### 9-1 in detail (2026-10-03, from reading the code)

- **The map's third column.** A map line may end in a comma list of words: `kept` (an
  account kept to places sees it), a right's name (a kept account with that right sees it),
  `parts` (opened part by part, as 08, 09 and 10 are today) and `listed` (its parts listed on
  Help's front page, as 08's are). An account not kept to places sees every guide, as now.
  This replaces `LIMITED_GUIDES`, `GUIDE_OF` (routes) and `GUIDES_BY_PART`, `LISTED_BY_PART`
  (pages). Every reader of a map takes `src dst _` (sync-pamela-guides.sh and
  verify-pamela-access.sh read two columns today). build.sh copies the site's map into its
  `help/` too, and the panel reads the order and the words from it.
- **Getting started becomes its own module**, `getting-started` (needs `examples` and
  `studio`), because Help on its own needs neither and lfdln has no examples. pammy.org's
  profile has every module, so it has both, as now.
- **Links into Help from other pages** (Forms, Comments, the API keys page, Databases,
  Database users, a form's database link ...) name a *topic*, and each profile says which of
  its guides a topic is (`help.topics`). A topic the site has no guide for shows no link: on
  lfdln most show none until 9-2 writes the guide. Pages lfdln never shows (Software,
  examples, Protected folders) keep their plain links.
- **The words**: the Help page's line under its title and the search box's example come
  from the profile's `help`.
- **lfdln's file names** are fixed now, so addresses don't change as guides arrive:
  01-start-here, 02-domains-hosts-and-routes, 03-site-folders, 04-services-and-monitoring,
  05-visitors (`accounts-guide.txt` today, grown in L5), 06-forms-and-comments, 07-databases.
- **Install**: both releases change (shared help code); install-lfdln.sh refuses a guide
  changed after the build, as install-panel.sh does.

### 9-2. lfdln's guides

Written for lfdln's people. Plain words first, so ericka can follow any guide; parts marked
**FOR PROGRAMMERS** for what only badmon, monadelanuit and momolig need (manifests, ports,
signed requests, databases from code). Each guide gives the page's place in the menu, what a
right is needed for it, and an "if something goes wrong" list. Same text format as Pamela's,
so Help formats them. Proposed set (rough lengths):

| # | Guide | Covers | Size |
|---|---|---|---|
| L1 | **Start here** | signing in, passkeys (add a second), the menu, rights (none / see / change per part, places), Accounts (admins), Activity, Help | short |
| L2 | **Domains, hosts and routes** | domains (lesfleursdelanuit.com, gonsalvesfamily.com, tutorlumi.com), Add a domain (the setup guide: what each answer means, Cloudflare or not, origin certificates), hosts and routes, what a route can show (site folder, service, redirect), checks, what the panel does to nginx | long |
| L3 | **Site folders and File Explorer** | site folders (static + PHP), uploading, the editor and versions, trash, File tags, media folders and the media API, `pammy-panel.json` in a folder | medium |
| L4 | **Services and Monitoring** | the services (TutorStar, Gonsalves, exam prep), what the panel can and can't do to them, the service's `pammy-panel.json` (roles, catalog section), Tags & categories for an app's items, Monitoring and its emails | medium |
| L5 | **Visitors: accounts, roles and access** | `accounts-guide.txt` grown: open with accounts, People, the Access page (roles, combined roles, copying built-ins), Requests, visitor settings, deleting an account, what an app is told | long |
| L6 | **Forms, responses and comments** | Forms on lfdln's sites, Responses, comments, form answers into a table, notices by email (lfdln sends notices only) | medium |
| L7 | **Databases** | the Studio on lfdln-appdb, your databases, `db_` logins, the apps' databases read-only (TutorStar, ligneous_frontend, exam prep), API keys and the data API | medium |

Later: a **Projects** guide comes with 8b, not here.

#### L1 and L5, as written (2026-10-03)

- L1 `start-here-guide.txt` -> 01-start-here.txt (`kept`): signing in, a second passkey, the
  menu and its words, who can use what, Accounts, Activity, Help, and the server command
  line FOR PROGRAMMERS.
- L5 `visitors-guide.txt` -> 05-visitors.txt (`protected`), replacing `accounts-guide.txt`:
  plain parts first (switches, an address with accounts, People, the Access page, Requests),
  then FOR PROGRAMMERS (pammy-panel.json, the headers, a new app with accounts, deletion).
- **Wording on lfdln's pages found while writing them** (fixed in the same release; pammy.org's
  words unchanged): the Accounts page offered a **Subdomains** part (nothing on lfdln uses it)
  and called the People/Requests part **Protected folders** (now **Visitors**); "What they can
  use" spoke of folders and protected folders (now hosts); Media's and Forms' parts mentioned
  the examples; Requests said "your protected folders" (now the sign-in page of an address
  that only lets people in).

#### L2-L7, as written (2026-10-03/04)

- L2 `hosts-guide.txt` -> 02-domains-hosts-and-routes.txt (`hosts`), topic `hosts` (0d137c3).
- L3 `site-folders-guide.txt` -> 03-site-folders.txt (`files,media`), topic `media-api` (#part-7).
- L4 `services-guide.txt` -> 04-services-and-monitoring.txt (`services`); no page links to it yet
  (no `services`/`monitoring` topic: that needs GuideLinks on shared pages).
- L6 `forms-and-comments-guide.txt` (not `forms-guide.txt`: Pamela has one) -> 06-forms-and-comments.txt (`forms,responses,comments`), topics `forms`,
  `comments` (#part-5).
- L7 `databases-guide.txt` -> 07-databases.txt (`databases`), topics `databases`,
  `database-users` (#part-8). No `form-or-database` on lfdln.
- Start here lists all of them. Written on branch phase-9-guides (worktree ~/pamela-setup-guides)
  while the L2 build ran.

**Found while writing them** (momolig 2026-10-04: MariaDB on lfdln, a setting for how long
backups are kept, "for the rest, use your judgement": done in docs/lfdln-mariadb-plan.md, all but
2, which is left for momolig there):

1. **.php files never show in File Explorer** on lfdln: the sync counts any FORBIDDEN_WRITE file
   as a stray (media.ts:410) and the warning box says it is "in a media folder" (extras.tsx:40-45).
2. **Programmers can't write the site folders**: lfdln-sites has only www-data, and the modes give
   the group read only (2750/640). F3 ("through the lfdln-sites group") isn't done; L3 says "through
   the panel or with sudo". L2 PART 3's "or, for programmers, on the server" leans on this too.
3. **Database users page shows MariaDB** on lfdln (ENGINES hard-coded, DatabaseUsers.tsx:26-29):
   a "Which server" choice and an empty MariaDB section.
4. **Delete a database says backups last "seven days"** (Databases.tsx:102); lfdln-appdb keeps 60.
5. **Visitor writes on a table still say "folder"** in places when byRoute (DatabaseAppTable.tsx
   389, 392, 404, 413).
6. **Responses and Comments say "Nothing is emailed to you"**; lfdln has notices (Settings > Email).
   The form setting "Only people signed in to a protected folder" means a route with accounts.
7. **File tags links to "Media examples"** (labels-manager.tsx:47), which lfdln doesn't have.
8. **An app's database can maybe get a database app, keys and tags**: managed() doesn't refuse
   them (studio.ts:58-65); writes are refused by the helper, reads would work. 8-4 says keys are
   refused for them; not found in code. L7 says not to.
9. **Catalog page intro** says "(exam prep: its topics)"; exam prep has no catalog section (dropped).
10. **API keys: New key only for admins** in the page, but the server checks only `programs`.
11. **Settings > Email needs the `software` right**, whose module (apps) is off on lfdln: only admins.

### 9-3. Getting started on lfdln

Not pammy.org's questionnaire: lfdln's people come for different jobs. Instead a **first
steps** card on Home for each person, ticked from what the panel can see (as Getting started's
checks are):

1. Add a second passkey (ticks when the account has two).
2. Read "Start here" (ticked by hand).
3. One line per right they have, linking to its guide and page ("You can change Forms: see
   Forms, responses and comments"), so ericka's card is short and momolig's is long.

The card can be hidden ("I'm done with this") and brought back from Help. Tests: what each kind
of account sees; the passkey tick. verify-lfdln: Home answers with the card.

#### 9-3 as built (2026-10-05)

- **In the help package**, not getting-started (that one needs pammy.org's examples). The
  profile says `help.firstSteps: { read: 'start-here' }` (lfdln only); pammy.org has none, so
  nothing changes there.
- **Migration** `help/0001-first-steps.sql`: `panel.first_steps` (user_id, read_at, hidden_at),
  only what the panel can't see. The passkey step is counted from `panel.passkeys`.
- **`GET /api/first-steps`** (signed-in): hidden, passkey count, the guide to read and whether
  it is ticked, and for each part the person has, the first guide they see whose guides.map
  line names it. **`POST /api/first-steps`** `{ read?, hidden? }`, true or false, nothing else.
- **The card** (`packages/help/web/components/first-steps.tsx`) on lfdln's Home: two steps,
  then "What you can change": Accounts for admins, then one line per part (its label and
  what it covers from the Accounts page's words, its page from lfdln's menu, the Inbox's
  last so Visitors is People, and its guide). A part no guide names (API keys, Visitor
  settings, Monitoring) has its page only. "I'm done with this" puts it away; Help shows
  "Show first steps on Home" while it is.
- Tests: hosts-panel (admin's guides, a kept account's, read/hidden per account, refused
  bodies, a second passkey); e2e-lfdln 15-first-steps; verify-lfdln: the route (401 signed
  out), the table, the card in the front end.

### 9-4. pammy.org: her guides against today's panel

Read each of her 21 guides beside her panel as it is now and fix what's wrong or missing.
Known to check: menu names and places (Website > Tags & categories, the API keys page, Inbox),
People, Requests and protected folders after the roles change, Subdomains now that pammy.org
is on its hosts (8-7; she sees no change, but the guide's "how it works" may name the old
file), Installed software's "whole of pammy.org" option now hidden (8-7d), the Studio's tags
and the data API's `labels` (catalog 4 and 4b, which already updated guide 14). Every change
goes in the release and her instructions folder (sync-pamela-guides.sh, as the installer
does). Findings listed in this file before editing, so momolig can see what changed.

Not here: a new guide for Pamela on roles or the catalog unless 9-4 finds something she can do
that no guide explains (then it's suggested, not written straight away).

## Questions for momolig

- **P9-1.** lfdln's guides on its **Help** page, per site (9-1), and not as files on disk?
  Suggested: yes.
- **P9-2.** The guide set **L1-L7** as above? Add, drop or merge any. Suggested: as listed.
- **P9-3.** One voice for ericka and the programmers, with **FOR PROGRAMMERS** parts, rather
  than two sets of guides? Suggested: yes.
- **P9-4.** Getting started on lfdln as a **first-steps card** (9-3), not a questionnaire?
  Suggested: yes.
- **P9-5.** 9-4 (checking Pamela's guides) in this phase? Suggested: yes, last.
- **P9-6.** Order: 9-1, then 9-2 one guide at a time (L1 and L5 first, since accounts and the
  people exist now), then 9-3, then 9-4? Suggested: yes.

#### 9-4 findings (2026-10-05, before editing)

##### 9-4 findings: Pamela's guides vs the pammy.org panel (main e8d4942, 2026-10-05)

Read-only audit. Each bullet: what the guide says (line), what the panel does (file:line, quoted), a one-sentence fix. Paths are under ~/pamela-setup/panel unless they start with a guide name. Cross-cutting: none of the guides names the old nginx file "pamela" or describes how serving works, so the 8-7 switch to hosts changes no guide text.

##### 00-README.txt
- No findings in the guide list: 01-20 plus this file = 21, and they match guides.map.
- Minor: line 37-42 describes 08 as "passkey, making subdomains, password-protecting folders, forms and their responses, and media". It leaves out File Explorer and the editor, which 08 does cover. Installed software and Settings > Email are covered by no guide at all (see 07). Fix: when 07 gains the panel part, add "and the Installed software page" to the 07 line (33-35).


##### 01-uploading-files.txt
- Line 179-185 says that going Up from the website lands in /pamela, which shows "public, home, instructions, app". The panel also puts trash and WordPress there: profile `sites/pammy/src/profile.ts` `website: { ... trash: '/pamela/trash' }`, and `packages/apps/src/apps/remove.ts:28` `adopted ? '/pamela/wordpress' : \`/pamela/apps/${a.id}\``. README:104 and 07:186-188 already name these folders. I could not list /pamela (permission denied), so this comes from the code only. Fix: add "trash" and "wordpress" (and "apps", once more software is installed) to that list, each with one line.


##### 02-using-claude.txt
- No findings. It says nothing about the panel.


##### 03-mailing-list.txt
- No findings. It says nothing about the panel.


##### 04-cloudflare-settings.txt
- No findings. Part 3 (Turnstile) says "then I switch it on". The panel web code has no Turnstile yet (grep finds nothing under packages/*/web), so that is still true.


##### 05-email-address.txt
- No findings. It says nothing about the panel.


##### 06-folders-and-subdomains.txt

- Line 71-80 says "Five names are already taken: www, api, blog, panel and media". Panel: packages/core/src/names.ts:13 `ALWAYS_RESERVED = ['www', 'api', 'panel', 'media']`, and names.ts:9-11 adds the name of **every** WordPress install ("Each WordPress install adds its own name (read from its placement line ...)"), so a second install (e.g. garden) takes its name too. Fix: say "www, api, panel, media, blog, and the name of any other software you install (Installed software)".
- No mention of the old nginx file `pamela` or of how serving works anywhere in her guides (checked: no "nginx"/"vhost" in any guide), so the 8-7 switch needs no change here. No other findings; the Subdomains page strings (Subdomains.tsx:63-132, home-page.tsx) match.


##### 07-wordpress.txt
- Line 164-176 ("PART 4 -- Email from the blog [NOT SET UP YET]": "The blog can't send email yet ... 'Lost your password?' doesn't send anything"), and line 172-173 too. The panel says WordPress mail is set up: `packages/apps/web/pages/Software.tsx:536-538` `<Section title="Email" intro="Password resets and comment notices from WordPress go out through Resend.">` ... `Email settings and a test`. `packages/settings/web/pages/Email.tsx:71` says "How pammy.org sends email: WordPress's own (password resets, comment notices) ... It goes through Resend", and `:107` has the button `From WordPress`. Fix: rewrite PART 4 to say the blog's email works through Resend, and that Settings > Email has "From WordPress" to send a test.
- Line 54-56 says "If you get locked out, ask me and I'll reset it", and line 229-230 says "Locked out: Ask me. I'll reset your password." She can now do this herself: `Software.tsx:231` `<Section title="Admin password"` and `:234` `Make a new password…`, which shows `A new password for ${made.user}` with `Copy the password` (`:219-223`). Fix: point both places to Installed software > the blog > "Make a new password…".
- Line 220-223 says "Tell me roughly when it last worked. I can put the whole blog back the way it was on any of the last 14 nights." She can now do this herself: `Software.tsx:185-187` `title="Backups"` `"A new one is made every night and kept for 14 days."` plus `Back up now`, `:196` `Download`, and `:197` `Put this back`. Fix: tell her that Installed software > the blog > Backups has "Put this back" (and "Back up now" before risky changes), and keep "tell me" for when that fails.
- Missing: the guide never mentions the panel's Installed software page, even though that page links to this guide (`Software.tsx:96` `<InlineLink to="/help/wordpress">About WordPress</InlineLink>`, and the same link in `SoftwareInstall.tsx:65`). The page shows "How it's doing" (`:493`) with "Check again" and "Take it offline" / "Bring it back online" (`:513-514`), "Where it is" (`:518`, with Address, Its files, Version), "Move it…" (`:287`), and "Delete it…" (`:337`, kept 30 days, then "Restore it" or "Delete it for good…", `:367-368`). It also has "Install WordPress" for another site (`:97`). Fix: add a part "The blog in your control panel (Installed software)" that walks through these sections.
- Line 141-143 says that moving the blog (e.g. to pammy.org/blog/) means "ask me". "Move it…" now offers its own subdomain or a folder (`Software.tsx:292`). "The whole of pammy.org" is filtered out while pammy.org is on hosts: `.filter(([v]) => v !== 'root' || wholeSite)`, where `useWholeSite()` (`packages/apps/web/lib/whole-site.ts`) reads `wholeSite` from /api/software (8-7d). The same filter is in `SoftwareInstall.tsx:71`. Fix: say she can move it herself with "Move it…" to a subdomain or a folder, but not onto the whole of pammy.org (ask me for that).


##### 08-control-panel.txt

- Line 10 and 166-167 say "Only you and I can sign in" / "Who can sign in to this panel: you and me". Panel: Accounts.tsx:53 "Add an account" (and the guide itself, line 174, explains adding accounts). Fix: say "you, me, and any account you add on the Accounts tab".
- Line 17-18 says "Installing apps like WordPress is next; I'll update this guide when it arrives." Panel: it is live, menu group "Software" > "Installed software" (sites/pammy/web/src/menu.ts:33; packages/apps/web/routes.tsx:18 `label: 'Installed software'`). Fix: replace with one line pointing to Installed software (and a guide for it, see the end of this file).
- PART 4 (lines 87-202), "The tabs", lists them flat and leaves several out. The menu is now in groups (menu.ts:27-35): Inbox (Responses, Comments, Requests), Website (Subdomains, File Explorer, Tags & categories), Media, Forms, Databases (Your databases, Database users, Database examples, Tutorial examples), Software (Installed software), Visitors (Protected folders, People), Settings (Email, Visitors), Account (API keys, Passkeys & devices, Accounts, Activity, Help). Missing from the list: Comments (comments/web/routes.tsx:14), Database examples / Tutorial examples (examples/web/routes.tsx:18-19), Installed software, Settings > Email (settings/web/routes.tsx:24), Settings > Visitors (routes.tsx:25, page "Visitor settings"). Fix: reorder PART 4 by the menu's groups, name the group each tab is under, and add one entry each for Comments (-> 20-comments.txt), the two Databases examples, Installed software, Email and Visitors.
- Line 149 says Databases is for "Account managers only." Panel: packages/studio/web/routes.tsx:40-41 `needs: 'databases'`, a right any whole-site account can be given on Accounts (core/web/lib/rights.ts:38 `label: 'Databases'`); the examples need `needs: 'examples'` (examples/web/routes.tsx:18-19). Fix: "Account managers, and any account you tick Databases for (the examples need Examples ticked)."
- Line 152-155 says API keys are "Keys a program needs to read a form's answers". Panel: the page also covers media, media/web/api-key-cover.tsx:47 `reads: 'the files in media folders'` next to forms/web/api-key-cover.tsx:50 `reads: "forms' responses"`; the Accounts right says "Letting programs read forms, media and data" (core/web/lib/rights.ts:39). It is under Account in the menu (menu.ts:35). Fix: "Keys a program needs to read a form's answers or your media from somewhere else (under Account in the menu); see PART 15 of 10-forms.txt and 12-media-on-your-pages.txt".
- Line 185-186 says "Databases, API keys, Installed software and the examples can't be given to it" (an account kept to folders). Panel: core/web/lib/rights.ts:58 `PLACE_RIGHTS = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'hosts']`, so Visitor settings can't be given either. Also, under "Only these folders" the Accounts page now offers "Installed software's files" (Accounts.tsx:125): an account kept only to a WordPress install's wp-content folder. Fix: add "or Visitor settings", plus one sentence on keeping an account to an installed software's files.
- Line 204-206 says "A red dot on it means requests or responses are waiting." Panel: the dot is any waiting count (core/web/components/shell.tsx:49 `Object.values(counts).some(...)`), and counts include comments (menu.ts:39 `return { requests, responses, comments }`). Fix: "requests, responses or comments".
- Line 356-357 says click "Show the code for a page" and "Copy". Panel: forms/web/pages/Forms.tsx:313 tab label "Code for a page". Fix: say "Code for a page".
- Line 384-387 says on Responses "Nothing is emailed to you, so look in now and then." Panel: Settings > Email has "Tell me about" (settings/web/pages/Email.tsx:113-131): emails for "New responses to" a form, "Comments waiting for my OK in", and "Someone asks to be let in, or forgot their password". Fix: "Nothing is emailed to you unless you tick the form under Settings > Email, 'Tell me about'".
- Line 90-91 says Home shows "What's there and what's coming". Panel: Home shows "New responses", "Waiting requests", "Shortcuts" and "Databases" (sites/pammy/web/src/pages/Home.tsx:106, 128, 156, 245) plus the guide search. Fix: list those four blocks instead.
- No mention of the old nginx file `pamela`, and the Subdomains, temporary page, editor, File Explorer, Tags & categories (MediaTags.tsx:48-61, labels-manager.tsx:53-94), Passkeys and Accounts button labels (Accounts.tsx:179-192) all match.

##### 09-protected-folders.txt

(The sign-in widgets' tag words and defaults in PART 4-6 were checked against packages/areas/widgets/login.ts and match. People, Requests and Protected folders buttons match except as below.)

- Guide line 13-15 says it's all set up "on three tabs: "Protected folders", "People" and "Requests""; panel: there is now also Settings > Visitors (sites/pammy/web/src/menu.ts `['settings+areas', settings.visitors]`, page title packages/settings/web/pages/VisitorSettings.tsx:23 "Visitor settings") and the per-folder Access page (packages/areas/web/routes.tsx:12 `access/:id`); fix: name the Visitors settings page here and point to a new short PART on it (see the list at the end).
- Guide line 41-42 says the setup link comes "with a "Copy" button and a "Copy with a short message" button"; panel: packages/areas/web/components/credentials.tsx:42 "Copy link" (only the password box, :60, says "Copy"); fix: say "Copy link".
- Guide line 165-166 says to "untick "Let people ask for access"" on the folder; panel: it is a switch, packages/areas/web/pages/ProtectedFolders.tsx:151-158 `<Switch ...>` labelled 'Let people ask for access (the "ask for access" page)'; fix: say "switch off "Let people ask for access"".
- Guide line 151-158 (and 501) say a forgotten password always waits on Requests and "Nobody gets an email from the site"; panel: with Settings > Visitors "Emailed links" on, the forgot page emails the link itself and nothing reaches Requests (packages/settings/web/pages/VisitorSettings.tsx:11 "The panel emails people the links to confirm their address, reset a forgotten password, or change their address."; packages/areas/widgets/login.ts:327-330 "Send me a link" / "Username or email"; packages/requests/web/pages/Requests.tsx:37 "with "Emailed links" on, a forgotten password is emailed instead and never comes here"); fix: add "unless you switch on Emailed links on Settings > Visitors (all off to begin with)" to both places, and note the forgot page's words then change (login-forgot's username-label becomes "Username or email", button "Send me a link").
- Guide PART 2 (line 93-124) lists what you can do on People but not adding someone there; panel: packages/people/web/pages/People.tsx:41 section "Add a person" ("Someone who can sign in to protected folders. You choose which folders."), with "Can open" ticks (packages/areas/web/components/people.tsx `legend` "Can open"); fix: add one bullet that People has "Add a person" too, ticking the folders there.
- Guide PART 2 (line 97-124) doesn't mention the buttons and labels that appear for people who made their own account; panel: People.tsx:84-85 "made their own account", "hasn't confirmed their email yet", :102 "Email a reset link", :106 "Send the confirmation again" (and "Set a password" is hidden for them, :118); fix: add two lines saying these appear only once "People can register themselves" is on.
- Guide PART 1/3 don't mention roles; panel: with "Roles and privileges on the Access page" on (packages/core/src/gate/visitor-settings.ts:84), each folder card gets a "Roles and privileges" button (ProtectedFolders.tsx:162) to the Access page ("Access to <folder>", Access.tsx:74), and approving a request asks "With the role" (Requests.tsx:167); fix: add a short note that this is off by default and, when on, where the button and the role choice appear (or say plainly that she doesn't need it).
- Guide PART 1 step 3 (line 27-33) lists the picker's "protected" and "inside" marks only; panel: ProtectedFolders.tsx:81 also marks folders "locked" (greyed out), and a "Locked folders" section (:96) lists folders with an unrecognised .pammy-protected file; fix: add one sentence on "locked" and that section (it fits PART 8's .pammy-protected bullet).


##### 10-forms.txt (master: forms-guide.txt)

- Guide lines 10, 554-555 and 2057 say "nothing is emailed" / "Nothing is emailed to you, so look in now and then". Panel: packages/forms/web/pages/Responses.tsx:63 "A red number in the menu means some are unread; you can also be emailed about new ones (Settings > Email)", and packages/settings/web/pages/Email.tsx:113,118 "Tell me about" / "New responses to" (per-form ticks; mail is on for pammy.org). Fix: say she can choose to get an email for each new response under Settings > Email > "Tell me about" (it names the form, never what was written); keep "nothing is emailed to the person who wrote".
- Guide line 79 says the builder's top bar has "the title, the "Preview" button, "Close" and "Save"". Panel: packages/forms/web/pages/FormBuilder.tsx:172 also shows "Connect to a database" (or "Connected to <table>") for anyone with the Databases right (FormBuilder.tsx:64). Fix: add "and, if you look after databases, "Connect to a database" (PART 17)".
- Guide lines 94-103 (ON A PHONE) and 283-288 (form settings shown "when nothing is picked") don't say the whole-form settings aren't on a phone. Panel: FormBuilder.tsx:248 "Form settings (the button's words, who may use it) are on a computer's wider screen". Fix: add one line under ON A PHONE: "The form's own settings (button words, thank-you words, who may use it) are only on a computer."
- Guide line 1965 says keys are made on the panel's "API keys" tab, with no place. Panel: sites/pammy/web/src/menu.ts:38 puts "API keys" under the Account group, and packages/api-keys/web/pages/ApiKeys.tsx:49 now also covers media keys ("A key lets a program read ... , or ..."). Fix: say "API keys" (under Account in the menu), and that the same page makes media keys (guide 12).
- Guide lines 8/10/553 call Responses a "tab" with no place; it is now under Inbox (menu.ts:29, with Comments and Requests). Fix: say "Responses (under Inbox in the menu)" the first time it is named.
- Guide lines 2087-2089 (PART 17 step 4) list the choices for an unfilled field as "a fixed value", "when it was sent", or empty. Panel: packages/form-links/web/pages/FormDatabase.tsx:282-283 also offers "The page it was sent from" and "Who sent it (signed-in visitors)". Fix: add those two choices to step 4.


##### 11-one-folder.txt
- Line 85-112 lists the pages in the menu but leaves out Activity. Activity is shown to every signed-in account, kept ones included: `packages/core/web/routes.tsx:19` `activity: { to: '/activity', label: 'Activity', icon: Clock, needs: 'signed-in' }`, placed in `sites/pammy/web/src/menu.ts` under Account. Fix: add an "Activity" entry: "what you have done in the panel".
- Line 24-26 says Pamela "may give you more: your folder's own page on the Subdomains tab, or protected folders inside your folder". It leaves out Comments, which a kept account can be given: `packages/core/src/panel/rights.ts` `PLACE_RIGHTS = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'hosts']`, and Inbox > `Comments` (`packages/comments/web/routes.tsx:14`). guides.map marks 20-comments.txt `kept`. Fix: add "comments under your folder's pages (20-comments.txt)" to that list. It should also say that "protected" brings Requests and People with it (the menu items `needs: 'protected'`, `packages/requests/web/routes.tsx:12`, `packages/people/web/routes.tsx:12`).
- Line 110-112 ("Help: This guide, the full guide to forms, and the guide to showing media on your pages") leaves guides out. guides.map gives kept accounts 10, 11, 12 and 20 (`comments-guide.txt 20-comments.txt kept`), plus 06 with the subdomains right and 09 with protected (`packages/help/src/help.ts:35-36`, "kept: an account kept to places sees it; rights: a kept account with one of these sees it"). Fix: add the comments guide, and "and the guides for Subdomains or protected folders if you have them".


##### 12-media-on-your-pages.txt (media-api-guide.txt)

No mismatches found. Checked: Media > "Media examples" (menu.ts Media group; packages/media/web/routes.tsx:23 'Media examples'); Website > "Tags & categories" (packages/files/web/routes.tsx:27); the switch "Anyone can list its files", which asks for a passkey (packages/files/web/components/media/labels-manager.tsx:88); "Title" / "What it shows" (packages/files/web/components/media/details.tsx:120,123); "Put this on my website" / "Put it on my website" / "Switch it on for ..." (packages/media/web/pages/MediaExamples.tsx:172,211,161); "Check for changes" (packages/files/web/components/media/extras.tsx:26); API keys "Which media folders" (packages/media/web/api-key-cover.tsx:22), and only a manager can make one (packages/api-keys/web/pages/ApiKeys.tsx:50 `me.role === 'manager'`).

- Optional: line 220 says "make one on the "API keys" page" but not where it is. The page is now under Account in the menu (sites/pammy/web/src/menu.ts, Account group `apiKeys.apiKeys`). Fix: add "(under Account in the menu)".


##### 13-databases-and-programs.txt (databases-and-programs-guide.txt)

- Line 194 lists the taken ports as "3039-3045, 3307, 5001, 5432, 5433, 8091". The server now also listens on 3046, 3047, 3048, 3308, 4101, 5434, 5435 and 5436 (`ss -ltn` on 2026-10-05). Those include pammy's own panel database (packages profile `pg: { port: 5434 }`, sites/pammy/src/profile.ts) and lfdln's databases and services. This comes from the server, not a .tsx. Fix: change the list to "3039-3048, 3307, 3308, 4101, 5001, 5432-5436, 8091", or say "ask me which ports are free".
- Line 189: "/api/ to your app on port 3042" is still right after the hosts switch (test/pammy-hosts.test.ts:19, route `/api/` → 3042). No change needed.


##### 14-databases-in-the-control-panel.txt (databases-in-the-panel-guide.txt)

- Line 16 says "Only account managers see the Databases part of the menu." In the panel, the Databases items need the "databases" right, not the manager role: packages/studio/web/routes.tsx:40 `needs: 'databases'`. Accounts can be given that right (packages/core/web/lib/rights.ts, `databases: { label: 'Databases', about: 'Databases, their logins, tables and apps, and forms saved into them' }`). "Database examples" and "Tutorial examples" need the separate "examples" right (packages/examples/web/routes.tsx:18-19, `needs: 'examples'`). Fix: "Account managers, and any account you've ticked Databases for on the Accounts page, see the Databases part of the menu (the examples need Examples ticked too)."
- Everything else checked matches the code, including catalog 4/4b:
  - "Let me tag these", "Picture", "Read again" and "Anyone can see it" (packages/studio/web/components/table-tags.tsx:65,68,83,131)
  - "Save the tags" and "Add a tag"/"Add a category" (packages/catalog/web/components/labels.tsx:77,33)
  - the record page's "Tags and categories" section (packages/studio/web/components/record-tags.tsx:20)
  - the list's "Tags & categories" column and "Any tag or category" (packages/studio/web/pages/AppRecords.tsx:230,167)
  - Everywhere under Show (packages/files/web/pages/MediaTags.tsx:53 "Everywhere (files, and records with tags on)"), with Rename/Delete (packages/catalog/web/components/everywhere.tsx:88-89)
  - the data API's `labels` / `pammy_labels`, `?tag=` / `?category=` and `/_labels` (packages/studio/src/gate/data-api.ts:185-200,310)
  - the app page's "Switch the app on/off", "Tables your app manages", "Also in this database" and "This app takes comments" (packages/studio/web/pages/DatabaseApp.tsx:129,136,147,151,166)
  - the examples' "Set up the recipe book", "The canvas", "Open the app", "Make my own recipe book" and "App name" (packages/examples/web/pages/DatabaseExamples.tsx:136,165,167,286,267)
  - Home's Databases card (sites/pammy/web/src/pages/Home.tsx:238-263).


##### 15-a-blog-with-javascript.txt (blog-with-javascript-guide.txt)

- Guide line 192 says "1. Click Posts." (and line 204 "Open Authors ... Do the same for Topics") on "The app" page; panel: the row title is plain text, not a link. You open a table's settings with its "Settings" button: packages/studio/web/pages/DatabaseApp.tsx:59 `<Row key={r.table} title={r.enabled ? r.plural : r.table}` (Row has no link, packages/core/web/components/page.tsx:57), and DatabaseApp.tsx:85 `<Table2 />Settings</Link>`. Fix: say "Click "Settings" on the Posts row" (and the same for Authors and Topics).
- Everything else checked and matches: New database form, Canvas, "Add table"/"Add it", "Connect to another table", "Which table holds the connection?", "one has many"/"many have many", "Prevent deletion", "Review changes"/Apply, "Tables your app manages", "Also in this database", "What it is named by", "How it is filled in", "Rich text", "Anyone can read these", "Only the ones where “Published” is yes", "Switch the app on", "Letting programs in", "Where programs ask", "New Post" (AppRecords.tsx:157 `New {r.singular}`), the comment-area form (Comments.tsx:165-184), the API error strings (gate/studio.ts:352,359; data-api.ts:300), ?per (max 100, data-api.ts:42), ?sort, ?where., and the {id,label} connection shape. `labels` only appears on tables she tags (data-api.ts:191 `if (!r.tagged) return;`), and this tutorial never tags posts, so its sample answer is still right.


##### 16-a-blog-with-php.txt (blog-with-php-guide.txt)

- Guide lines 120-126 say "Make a folder called journal-php ... In it you'll put four files: api.php, index.php, post.php, style.css", but they never say HOW. Guide 15 (lines 38-39) offers "the File Explorer in the control panel, or WinSCP", and the panel refuses .php files from File Explorer. Upload and New file: packages/files/src/sitefs/media.ts:146 `"${name}" can't be put in the website from the panel.`. The editor: packages/files/src/sitefs/edit.ts:55 `The editor works on ... files, not .php`. Moving or renaming: media.ts:112 `Program files (.php and the like) are changed on the server, not in the panel.` Fix: add a line saying the .php files go in with WinSCP (or Claude), not File Explorer, which only shows them (style.css can go either way).
- The panel steps are only pointers to guide 15's PARTS, and they are right. The PHP environment exists: PAMMY_API_SOCKET is in deploy/php/php-fpm.conf.


##### 17-a-to-do-list-with-javascript.txt (todo-with-javascript-guide.txt)

- Guide lines 98-99 say "1. Click "The app". Tasks is under "Tables your app manages". Click it."; panel: the row title isn't clickable, and the table's page opens from its "Settings" button. packages/studio/web/pages/DatabaseApp.tsx:59 and :85 `<Table2 />Settings</Link>`. Fix: say "click "Settings" on the Tasks row".
- Everything else matches: the "People signed in to a protected folder" section, "Who can change them" with the option "People signed in to /todo" (studio/src/panel/routes/databases.ts:39 `` `People signed in to /${x.path}` ``), "Whose are they" with the option "Each person only their own, by “Owner”" (DatabaseAppTable.tsx:404), "What people may do" with "Delete them" (DatabaseAppTable.tsx:331, lib/schema.ts:366), the API errors (gate/studio.ts:359,363,368; data-api.ts:116), and Protected folders with its "Protect a folder"/"Protect" (areas/web/pages/ProtectedFolders.tsx:75,91).


##### 18-a-to-do-list-with-php.txt (todo-with-php-guide.txt)

- Guide lines 50-51 say "Make a folder called todo-php", and PART 3 (line 77) says "Make this file in todo-php" (settings.php), then tasks.php and index.php. As in guide 16, it never says these .php files can't be made, uploaded or edited in File Explorer: packages/files/src/sitefs/media.ts:146 `can't be put in the website from the panel.`, and edit.ts:55. Fix: say once, in PART 1, to put the .php files in with WinSCP (or ask Claude), because the panel lists them but won't take or change them.
- The key steps match: "Letting programs in", "New key", "What is it for?", "What may it do?", "Read, and add or change records", "Make the key", and "Stop it working" (packages/studio/web/pages/DatabaseKeys.tsx:57,123,149,153,158,161). So do the protected-folder ticks (ProtectedFolders.tsx:178 AccessCheckbox) and the errors "That key is not accepted." and "That key can read, but not change anything." (gate/studio.ts:385).


##### 19-forms-or-a-database.txt (master: forms-or-a-database-guide.txt)

- Guide line 108 says "Only account managers see the Databases menu." Panel: Databases is an ordinary right any whole-site account can be given: packages/core/web/lib/rights.ts:38 `databases: { label: 'Databases', about: 'Databases, their logins, tables and apps, and forms saved into them' ... }`, and the menu items need only that right (packages/studio/web/routes.tsx:40-41 `needs: 'databases'`). Fix: "Only accounts given Databases (account managers, or anyone you tick it for in Accounts) see the Databases menu." (Same stale claim in 08-control-panel.txt line 149, "Account managers only", for the guide-08 checker.)
- No other mismatches: "Make my own" (examples/web/pages/DatabaseExamples.tsx:254), "People can comment on these" (studio/web/pages/DatabaseAppTable.tsx:283), "People signed in to a protected folder" (DatabaseAppTable.tsx:382), "When I approve a response" / "Save the earlier responses too" (FormDatabase.tsx:177,140) and Getting started's "What would you like to do?" all match.


##### 20-comments.txt (master: comments-guide.txt)

- Guide line 41 says "Comments are not emailed to you, or to anyone." Panel: packages/comments/web/pages/Comments.tsx:53 "A red number in the menu means some are waiting; you can also be emailed (Settings > Email)", and Email.tsx:124 "Comments waiting for my OK in" (a tick per comment area). Fix: say she can get an email for each comment waiting for her OK, chosen per area under Settings > Email; the person who wrote still gets nothing.
- Everything else checks out: "Comments" under Inbox (menu.ts:29), "A new comment area" / "Name for the page" / "Title (for you)" / "What people comment on" / "Which table" / "Make the comment area" (Comments.tsx:166-184), "Code for a page", "Change what it asks", the "Open" switch, Show options "Waiting for your OK" / "Shown on your pages" / "All" / "In the trash" (Comments.tsx:59-62), "Area", "Approve" / "Take it off the page" / "The whole conversation" / "Move to trash", "Keep the approved comments in" (Comments.tsx:203), and "This app takes comments" (studio/web/pages/DatabaseApp.tsx:147).


##### Things she can do that no guide explains (suggestions only)

1. **Installed software** (Software > Installed software; packages/apps/web/pages/Software.tsx, SoftwareInstall.tsx). It covers backups ("Back up now", "Put this back", "Download"), "Make a new password…", "Take it offline", "Move it…" (to a subdomain or folder; "The whole of pammy.org" is hidden while pammy.org is on hosts, Software.tsx:292), "Delete it…" / "Restore it", and "Install WordPress" for another site. Best home: a new part in 07-wordpress.txt, which the page already links to as "About WordPress" (Software.tsx:96).
2. **Settings > Email** (packages/settings/web/pages/Email.tsx). It has the Resend key and addresses, "Send a test" ("From the panel" / "From WordPress"), and "Tell me about": an email per new response, per comment waiting, and per access or password request. Guides 08, 10 and 20 still say nothing is emailed. Suggest a short part in 10, with pointers from 08, 09 and 20.
3. **Settings > Visitors ("Visitor settings")** (core/src/gate/visitor-settings.ts:78-85). Six switches, all off: emailed links, self-registration, own password change, own account deletion, "Open with accounts" areas, and roles. Turning them on brings the visitor pages /_pammy/register and /_pammy/account (`<pammy-register>`, `<pammy-account>`, and a `register-text` attribute on login). Suggest a new part in 09.
4. **The Access page per protected folder** ("Roles and privileges", areas/web/pages/Access.tsx). It shows only when the roles switch is on. Suggest one paragraph in 09 saying she doesn't need it unless a program in the folder checks roles.
5. **Installed software's files in File Explorer and Accounts**. File Explorer's "Showing" picker offers "<install>: wp-content" (files/web/pages/Files.tsx:79-81), where .php opens in the editor and only account managers can save it (files/web/components/software-files.tsx). Accounts can be kept to "Installed software's files" (core/web/pages/Accounts.tsx:125). Suggest a part in 08 PART 13 and a sentence in 08 Accounts.
6. **Giving Databases / Examples / API keys to an account that isn't an account manager** (core/web/lib/rights.ts:38-41). Guides 08, 14 and 19 say managers only.
7. **Data API tag filters** `?tag=` / `?category=` and `/_labels` (studio/src/gate/data-api.ts:197-201, 310). These are in guide 14 but not in the tutorials. At most, add an optional note in 15.
