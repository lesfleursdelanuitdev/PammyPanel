# User stories: everything the panel does today

Written 2026-10-06 from the code on `main` (98d1dc4): pages, routes and their `needs`,
`test/routes.snapshot.txt`, the widgets, the guides and the plans. **What is built, not what is
planned.** Read from code, not clicked through. Where a story and the panel disagree, the panel
wins and this file is fixed.

momolig, 2026-10-06: *"create a set of user stories for everything the panel does"*.

## How to read it

Each story: **As a** role, **I can** do something, **so that** a benefit. Then, in brackets:
`[site · right · where]`.

- **site**: `pammy` (panel.pammy.org and pammy.org), `lfdln` (panel.lesfleursdelanuit.com and
  its hosts), or `both`.
- **right**: the part of the panel the route asks for (`packages/core/src/panel/rights.ts`):
  `files`, `media`, `subdomains`, `forms`, `responses`, `comments`, `protected`, `databases`,
  `programs`, `software`, `examples`, `hosts`, `services`, `visitor-settings`, `monitoring`,
  `projects`. Also `admin` (account manager / admin only), `signed-in` (any panel account),
  `public` (no sign-in), `visitor` (signed in on the site, not the panel). **(fresh)** means the
  passkey is asked again if not used in the last 10 minutes. **(whole site)** means a helper
  kept to places can't use it.
- **where**: the page, route or component.

**Roles**
| Role | Who |
|---|---|
| site admin | an account manager (pammy) / admin (lfdln): every right, no places |
| site owner | Pamela on pammy.org (an account manager there); used where the story is hers |
| panel member | a panel account given some rights |
| helper kept to places | a panel account kept to some folders (pammy) or hosts (lfdln) |
| visitor | someone on the public site, not signed in |
| signed-in visitor | someone signed in on the site (a visitor account, not a panel account) |
| program | code holding an API key, or a page's script |
| service/app | an adopted service, a project, or the panel's own background jobs |

Modules per site (`sites/*/src/profile.ts`): **lfdln** has no `apps`, `examples` or
`getting-started`; **pammy** has no `hosts`, `services`, `monitoring` or `projects` turned on in
the panel (its nginx is rendered from host rows, by command line only).

## Which module each part belongs to

For docs/modular-use-plan.md: what "only Forms" would and wouldn't include.

| Section | Module | Rights |
|---|---|---|
| 1-7 | core (kernel) | signed-in, admin |
| 8 | help | signed-in |
| 9 | getting-started | databases |
| 10 | files (pammy subdomains) | subdomains |
| 11-13 | files | files |
| 14 | catalog | files, databases, services |
| 15-17 | media | media |
| 18 | thumbs | signed-in |
| 19 | php | public |
| 20-25 | forms | forms, responses, programs |
| 26 | form-links | databases, responses |
| 27-28 | comments (code mostly in forms) | forms, responses, comments, databases |
| 29-36 | studio (part of 35 in comments) | databases, programs |
| 37 | examples | examples, forms, media |
| 38-44 | areas, people, requests, settings | protected, visitor-settings, hosts |
| 45-46 | mail | software (pammy), admin (lfdln) |
| 47 | apps | software, files |
| 48-53 | hosts | hosts |
| 54-55 | services, catalog | services, people |
| 56 | services (backups setting) | admin |
| 57 | monitoring | monitoring, admin |
| 58-60 | projects | projects |
| 61 | api-keys | programs, admin |
| 62 | site CLIs | server shell |

---

# A. Panel accounts and the panel itself

## 1. Signing in (passkeys only)
- As a panel member, I can sign in with a passkey (fingerprint, face or device PIN), so that I never need a password. [both · public · /login]
- As a panel member, I'm taken back to the page I first asked for after signing in (`?next=`, same site only), so that I land where I meant to go. [both · public · /login]
- As a panel member, I'm told plainly when my passkey isn't accepted, and to ask for a setup link if I never made one here, so that I know what to do. [both · public · /login]
- As a panel member, I'm told when my browser can't use passkeys, so that I switch browser. [both · public · /login, shell notice]
- As a panel member, I can sign out from the top bar or the menu, so that nobody else uses my session. [both · public · POST /api/logout]
- As a panel member, I'm asked for my passkey again before sensitive changes, so that a stolen session alone can't make them. [both · signed-in · /api/reauth/*]
- As a panel member, I'm stopped after too many sign-in tries (login, invite, reauth), so that the panel can't be brute-forced. [both · public · /api/login/*]
- As a panel member, my session ends after 8 hours unused or 7 days at most, so that a forgotten browser doesn't stay signed in. [both · signed-in · sessions]
- As a site admin, I can see each failed sign-in and failed passkey check in Activity with its IP, so that I notice attacks. [both · admin · /activity]

## 2. Setup links (panel invites)
- As a panel member, I can open a setup link, see "Hello, <name>", name my passkey and make it, so that I can sign in the first time. [both · public · /invite]
- As a panel member with passkeys already, I can use a new setup link to add another, and the old ones keep working, so that I recover after losing a device. [both · public · /invite]
- As a panel member, I'm told when a setup link is incomplete, expired, used or cancelled, so that I know to ask for a new one. [both · public · /invite]
- As a panel member, once my link has made a passkey I'm signed in, taken to Passkeys & devices, and the link leaves my browser history, so that it can't be reused. [both · public · /invite]

## 3. Passkeys & devices (my own account)
- As a panel member, I can see my passkeys (added, last used, synced or not, which one I'm using), so that I know how I get in. [both · signed-in · /passkeys]
- As a panel member, I can add another passkey and name it, so that losing one device doesn't lock me out. [both · signed-in (fresh) · /passkeys]
- As a panel member, I can rename a passkey, so that I tell my devices apart. [both · signed-in · /passkeys]
- As a panel member, I can remove a passkey but not my last one, and I'm signed out if I remove the one I'm using, so that I can't lock myself out. [both · signed-in (fresh) · /passkeys]
- As a panel member, I can see where I'm signed in (device, when, last active, IP) and sign out any other browser, so that I end sessions I don't recognise. [both · signed-in · /passkeys]

## 4. Accounts (who can use the panel)
- As a site admin, I can see every panel account: role, badges (switched off, you, "only <places>", "nothing to use yet"), its parts, passkey count, last sign-in, sessions, open setup link, so that I know who has access. [both · admin · /accounts]
- As a site admin, I can add an account and choose at once what it can use and where (it starts with nothing), so that a helper starts with exactly the right access. [both · admin (fresh) · /accounts]
- As a site admin, I can make a setup link (once, 24 hours) and copy it to send privately, or cancel an open one, so that the person can add a passkey and a misdirected link stops working. [both · admin (fresh) · /accounts]
- As a site admin, I can change what a member can use, applied from their next click without signing them out, so that access changes right away. [both · admin (fresh) · /accounts]
- As a site admin, I can keep an account to places (pammy: a top-level folder or an installed WordPress's files; lfdln: a host), so that a helper sees only their corner. [both · admin (fresh) · /accounts "Where"]
- As a site admin, I'm stopped from giving someone kept to places a part that can't tell places apart (and someone kept to WordPress files gets File Explorer only), so that their access stays sound. [both · admin · /accounts]
- As a site admin, I can switch an account off (signing them out) and on, but not myself or the last account manager. [both · admin (fresh) · /accounts]
- As a site admin, I can sign someone out on every device, so that a lost laptop can't be used. [both · admin (fresh) · /accounts]
- As a site admin, I can remove someone's passkey, even their last, then send a new setup link, so that I reset a person who lost their device. [both · admin (fresh) · /accounts]
- As a site admin, I can make someone an account manager / admin only from the server's command line, never from the panel, so that a stolen sign-in can't create admins. [both · server shell · CLI `role`]
- As a site owner, the panel calls me "account manager" on pammy and "admin" on lfdln, so that the words fit each site. [both · admin · site words]

## 5. Rights and places (what a helper experiences)
- As a panel member, I see only the menu items and pages for my parts, and the server refuses the rest anyway, so that I can't wander into something. [both · per right · menu, App.tsx]
- As a helper kept to places, I see "You look after <places>" on Home, and every part shows only what is in those places. [both · kept · Home]
- As a helper kept to places, I can't open whole-site pages (the folder list, form examples, Getting started, Services and the like). [both · kept · whole-site routes]
- As a helper kept to places, Help shows the guides for people kept to places plus those for my rights. [both · kept · /help]

## 6. Home and the menu
- As a panel member, I can open the menu from any page (swipe it closed on a phone), grouped Inbox, Website / Sites, Media, Forms, Databases, Software, Visitors, Settings, Account, so that I find each part. [both · signed-in · shell]
- As a panel member, I see red counts on Responses, Comments and Requests and a dot on the menu button when something waits, so that I notice new things. [both · forms / comments / protected · shell]
- As a panel member, each switched-on database app is its own menu group, so that my data is one click away. [both · databases · menu]
- As a site owner, my Home shows a greeting, what's waiting, stats (unread responses, waiting requests, protected folders and people, forms working), the five newest unread responses and waiting requests, so that I see what needs me. [pammy · signed-in · /]
- As a site owner, I can search my guides from Home. [pammy · signed-in · Home → /help?q=]
- As a site owner, a Databases card on Home shows "make a database" (when I have none), drawings not applied yet with their change counts, and links to switched-on apps, so that unfinished work isn't forgotten. [pammy · databases · Home]
- As a site owner, Home has shortcuts (make a subdomain, protect a folder, add a person, Forms, File Explorer, upload media, Passkeys); a helper kept to places sees only forms, files, media, passkeys. [pammy · signed-in · Home]
- As a site admin on lfdln, Home shows hosts and routes on, site folders and how many aren't shown anywhere, "Down now", the first six hosts, and recent activity ("What you did lately" for a member), so that I see the server's sites at a glance. [lfdln · hosts / monitoring / signed-in · /]
- As a panel member on lfdln, a First steps card on Home asks me to add a second passkey (ticked by itself), read "Start here", and shows "What you can change" per part with its page and guide; I can put it away and bring it back from Help. [lfdln · signed-in · Home]

## 7. Activity
- As a site admin, I can read everything done in the panel, newest first, 100 at a time, with who, a plain sentence, IP and time in my time zone, so that I can see what happened. [both · admin · /activity]
- As a panel member, I see only what I did myself. [both · signed-in · /activity]
- As a site admin, I see automatic actions too ("automatic kept "x" protected (folder was renamed …)"), so that what the panel did on its own is explained. [pammy · admin · /activity]

## 8. Help (guides)
- As a panel member, I can open Help and see every guide, long ones listed part by part, others under "More guides", each with number and summary. [both · signed-in · /help]
- As a panel member, I can search all guides as I type (up to 50 places, highlighted), so that I find the answer quickly. [both · signed-in · /help?q=]
- As a panel member, I can read a guide with its contents, long ones a part at a time, my search words highlighted with "Clear". [both · signed-in · /help/:guide/:part]
- As a panel member, I can follow "how this works" links from pages straight to the right guide part (no link when the site has no guide for it). [both · signed-in · GuideLink]
- As a site owner, Help has the same guides as my instructions folder; lfdln has its own seven. [both · signed-in · guides.map]
- As a site owner, I can see the example sign-in looks (evening, garden, postcard) inside the protected-folders guide. [pammy · signed-in · Help]

## 9. Getting started (pammy)
- As a site owner, I can answer "What would you like to do?" one question at a time (blog, pinboard, recipe book, contact, who's coming, guest book, private folder, media, a list for each person, not sure), with Back and Start again, and get a suggested path with steps. [pammy · databases (whole site) · /getting-started]
- As a site owner, I can start the path, and the panel ticks steps off by itself as they're done ("N of M done"). [pammy · databases · /getting-started]
- As a site owner, I can tick "I've done this" (only for steps the panel can't check), undo it, skip or un-skip a step, so that the list matches reality. [pammy · databases · /getting-started]
- As a site owner, I can tell the panel the database, form or folder it found "isn't the one", so that it looks for another. [pammy · databases · /getting-started]
- As a site owner, I can put a path away, and open or close the Getting started card on Home (remembered for my account). [pammy · databases · Home, /getting-started]

# B. The website: folders, files, media

## 10. Subdomains (pammy)
- As a site owner, I can see every top-level folder with badges (subdomain, name used by the server, no subdomain because of capitals or symbols, no home page, temporary page, shortcut) and its live addresses, so that I know which folders are addresses. [pammy · subdomains · /subdomains]
- As a site owner, I can make a subdomain by typing a lowercase name (checked as I type, both addresses shown); the folder is made with a temporary page, live at once, so that I get a new mini-site without help. [pammy · subdomains (whole site) · /subdomains]
- As a site owner, I can move a folder to the trash (warned if it has no index.html and others may use its files) and restore it within 30 days, under a new name if the old one is taken. [pammy · subdomains (whole site) · /subdomains]
- As a panel member, I can add, change or remove a temporary home page for a folder with no index.html (Coming soon / Under construction / Nothing here yet, my heading and message, one of my stylesheets or plain, a link to the main site or not), so that visitors don't see "403 Forbidden". [pammy · subdomains · /subdomains]
- As a helper kept to places, I see only my folders and can change only their temporary pages; I can't make, trash or restore folders. [pammy · subdomains (kept) · /subdomains]

## 11. File Explorer
- As a panel member, I can browse every file of the website as a grid or table, with a folder tree, breadcrumbs, Up and a typed address. [both · files · /files]
- As a panel member, I can search by name, filter by kind, tag and category, sort by name, date or size, and page through results. [both · files · /files]
- As a panel member, I can upload one or many files by button or drag, with progress, automatic rename on a clash, and a refusal over the size limit (100 MB on pammy, "use WinSCP"). [both · files · /files]
- As a panel member, I can make a folder, and rename, move or trash a folder from its menu. [both · files · /files]
- As a panel member, I can select several files and tag, move, copy or trash them together. [both · files · /files]
- As a panel member, I can open a file's details: preview (picture, video, audio, first PDF page), size, picture size, dates, who added it and how, tags and categories, public addresses with Copy address and Copy HTML, and Open, Download, Rename, Move, Make a copy, Move to trash. [both · files · /files]
- As a panel member, a server program file (.php, .py, .sh, .htaccess…) is marked "runs on the server": I can't rename, move or trash it, and only an account manager can download it, so that site code isn't damaged by accident. [both · files (download: admin) · /files]
- As a panel member, I can restore trashed files within 30 days with their tags, renaming on a clash. [both · files · /files Trash]
- As a panel member, I can press "Check for changes" to pick up files added by WinSCP or Claude; the panel also checks every 15 minutes. [both · files · /files]
- As a panel member, I can make any folder a tag scope, or stop. [both · files · /files folder menu]
- As a panel member, File Explorer goes full screen and remembers grid/table and the tree in this browser. [both · files · /files]
- As a site admin, I can switch File Explorer to an installed WordPress's wp-content/ and work there (browse, upload, folders, rename, move, trash, restore), so that I can manage themes and plugins. [pammy · files (not kept) · /files?root=]
- As a helper kept to places, I see only my folders (a picker if several); kept only to a WordPress, I go straight to its files. [both · files (kept) · /files]
- As a panel member on lfdln, each file shows its address through the host route that shows its folder, or "Not on the internet: no route shows this folder yet". [lfdln · files · /files]

## 12. File editor and versions
- As a panel member, I can make a new file ("A web page", "A style sheet", "An empty file"); it's never made over an existing one and opens in the editor. [both · files · /files]
- As a panel member, I can edit a text file with highlighting and find/replace, and save with the button or Ctrl/Cmd+S. [both · files · /files/edit]
- As a panel member, I can see a page as Code, Preview or Side by side; the preview shows unsaved changes live in a sandbox. [both · files · /files/edit]
- As a visitor, I can't reach a preview without its short-lived token; only the editor's frame loads it, so that drafts aren't public. [both · public (token) · /api/files/view/:token]
- As a panel member, if the file changed since I opened it I choose Keep mine, Load theirs, or Save mine as a copy, so that nobody silently overwrites anyone. [both · files · /files/edit]
- As a panel member, unsaved text is kept in this browser and offered back next time, and I'm asked before leaving unsaved. [both · files · /files/edit]
- As a panel member, I can open Earlier versions, compare any with the current text line by line, and put one back; every save keeps what it replaced for 30 days. [both · files · /files/edit]
- As a panel member, after saving .css / .js I'm told Cloudflare may serve the old copy for up to 4 hours and how to bust it. [pammy · files · /files/edit]
- As a panel member, I can read a WordPress .php file, but only a site admin can save it. [pammy · files (save .php: admin) · /files/edit?root=]

## 13. Tags and categories on files
- As a panel member, I can add or remove tags and categories on one or many files; new names are made in each file's own scope ("Summer 2026" → summer-2026). [both · files · /files, /media]
- As a panel member, I can view the labels of every folder, the top of the site, or one top folder, with file counts. [both · files · /tags]
- As a panel member, I can make, rename and delete a label in a scope, and jump to "Show files". [both · files · /tags]
- As a site owner, I can switch "Anyone can list its files" on a label (passkey), so that my pages can show those files without a key. [both · files (fresh) · /tags]
- As a helper kept to places, I see and manage only my folders' labels. [both · files (kept) · /tags]
- As a visitor of the old address /media/tags, I'm taken to /tags. [both · files · redirect]

## 14. Everywhere labels and services' catalog (catalog)
- As a site admin, I can make, rename and delete "Everywhere" labels that go on any file and on records of tagged tables, with counts. [both · files (+databases; lfdln services) (whole site) · /tags everywhere, /catalog]
- As a site owner, I can mark an Everywhere label "Anyone can see it" (passkey), so that it shows with records visitors read. [pammy · files + databases (fresh) · /tags]
- As a site admin, I can see every service offering things to tag (from its pammy-panel.json), with counts, and switch tagging on or off per service (off deletes its labels after confirming). [lfdln · services (whole site) · /catalog]
- As a site admin, I can "Read again" to pull a service's items now, letting go of vanished ones if I choose. [lfdln · services · /catalog]
- As a site admin, I can open one kind of a service's things, search, filter by sub-scope or label, page, and set each item's tags and categories. [lfdln · services · /catalog/:service/:resource]
- As a site admin, I can make, rename and delete a kind's own labels, see which ones the service gives a meaning, and "Make it" for a missing one. [lfdln · services · /catalog/:service/:resource]
- As a service/app, I can push changed and removed items, read my labels and their meanings, ask for ids with given labels, and add or remove labels on my items, through the signed local door. [lfdln · service key · /_catalog/*]

## 15. Media
- As a panel member, I can browse media (images, files, audio, video) in one media folder or all, by kind, as grid or table, with search, label filters, sort, paging and full screen; the address keeps every choice. [both · media · /media]
- As a panel member, I can upload into the current folder, or at the top have each file sorted into images / files / audio / video by type. [both · media · /media]
- As a panel member, I can make subfolders in a kind, and rename, trash, make a tag scope, or move a folder to any media folder of the same kind. [both · media · /media]
- As a panel member, I can move or copy files to any media folder; labels go along by name and I'm told which will be created. [both · media · /media]
- As a panel member, I can give a media file a Title and "What it shows" (alt text), so that galleries and slide shows show them. [both · media · /media]
- As a panel member, I'm warned about files in a media folder the panel can't use (pages, programs, shortcuts, odd names, too many to check). [both · media · /media, /files]
- As a panel member, I can restore trashed media within 30 days with its labels. [both · media · /media Trash]
- As a site admin, I can see which sites have a media folder and make one (pammy: top of the site; lfdln: in a site folder). [both · media (whole site) · /media/folders]
- As a helper kept to places, I see and change only my places' media folders. [both · media (kept) · /media]

## 16. Media examples (pammy)
- As a site owner, I can preview four working media pages (gallery, slide show, document list, music player) at computer or phone width and read and copy their code. [pammy · media · /media/examples]
- As a site owner, I can "Put this on my website": choose a media folder, labels, a page name and heading; the page is written for me and I'm offered "Switch it on" for labels not yet public. [pammy · media · /media/examples/:kind]

## 17. Public media API
- As a visitor, a page can list media carrying public labels (`/_pammy/api/media/main/t/<tag>/c/<cat>` or `/in/<folder>/…`), with titles, alt text, thumbnails, kind, order and paging (up to 100), so that galleries work. [both (lfdln: `in/<folder>` only) · public · /_pammy/api/media/*]
- As a visitor, I can load a listed picture's small WebP thumbnail. [both · public · /_pammy/media-thumbs/:name]
- As a signed-in visitor, I also get media inside a protected folder I'm signed in to. [both · visitor · /_pammy/api/media/*]
- As a visitor, the built-in example folder's media can be read, so that the media examples work before I have my own. [pammy · public · /_pammy/api/media/example/…]
- As a program, with a key limited to chosen media folders I can list any label (not only public), every file in a folder (`/all`) and a folder's labels, rate-limited. [both · API key · /_pammy/api/media/in/<folder>/*]

## 18. Thumbnails
- As a panel member, I see thumbnails for pictures, video frames, audio cover art and first PDF pages (icons for others), made by a sandboxed service and remade only when the content changes. [both · signed-in · /api/media/thumb/:id]

## 19. PHP pages
- As a visitor, I can open a .php page (index.php is a folder's home when it has no index.html), run through PHP-FPM after the gate's checks. [both · public / area rules · *.php]
- As a signed-in visitor, my username, account, role and privileges reach a PHP page (`PAMMY_*`) and can't be faked with headers. [both · visitor · *.php]
- As a program, a PHP page can call the site's `/_pammy/api/…` (data, media, forms) with its key over a local socket (`PAMMY_API_SOCKET`). [both · API key · gate php socket]

# C. Forms and comments

## 20. Making and editing forms
- As a panel member, I can see all forms: title, fixed name, number for the API, question count, response and unread counts, last response time, and badges (off, only in <folder>, approved, shown right away, approved ones public, example). [both · forms · /forms]
- As a panel member, I can make a form with a fixed name (2-64 lowercase letters, digits, hyphens), blank or from a starter (Guest book, Who's coming, Pinboard, Get in touch). [both · forms · /forms]
- As a panel member, I can choose where a form works (every page, or one top folder on pammy / one site folder on lfdln), and later move it (its pictures must be inside the new folder). [both · forms (move: whole site) · /forms]
- As a helper kept to places, I can make blank forms that work only inside my folders, and see and edit only those. [both · forms (kept) · /forms]
- As a panel member, I can build a form in a three-part builder (kinds of item, the form, the picked item's settings), dragging items on a computer. [both · forms · /forms/:id]
- As a panel member, I can build a form on a phone by tapping: "Add a question" sheet, full-screen settings, Up/Down, Duplicate, Remove. [both · forms · /forms/:id]
- As a panel member, I can add answer kinds (short and long answer, email, phone, website, drop-down, one choice, several choices, tick box, number, date, time, stars, scale, name, address, hidden) and layout items (heading, paragraph, line, picture from my media). [both · forms · /forms/:id]
- As a panel member, I can set each question's label, help, required, width, placeholder, lengths, rows, number range and decimals, date range ("today" allowed), time steps, choices with "other" and columns, fewest/most picks, starting value, name and address parts, stars, scale ends and words, and a hidden answer's fixed value or page-address setting (`?source=`). [both · forms · /forms/:id]
- As a panel member, I can mark each question "Show publicly", so that only chosen answers are given out when approved responses are public (email, phone, address, hidden are private by default). [both · forms · /forms/:id]
- As a panel member, I can set the button words, thank-you words, "only people signed in" (pammy: to a protected folder; lfdln: behind a route with accounts) and "tell them who sent each one". [both · forms · /forms/:id]
- As a panel member, I can preview the form exactly as visitors see it, at computer or phone width, without sending. [both · forms · /forms/:id Preview]
- As a panel member, saving puts the form live at once (no draft), and I'm warned about unsaved changes when I leave. [both · forms · /forms/:id]
- As a panel member, I'm stopped from saving over someone's newer save and told who and when. [both · forms · /forms/:id]
- As a panel member, I can't change a saved question's kind, and its API key stays fixed, so that old responses and API readers keep making sense. [both · forms · /forms/:id]
- As a panel member, I can duplicate a form under a suggested name ("-copy"), with questions and settings but no responses; duplicating is how I "rename". [both · forms · /forms]
- As a panel member, I can move a form to the trash (passkey) and restore it for 30 days; its responses stay and its name stays taken. [both · forms (fresh) · /forms]
- As a panel member, I'm held to limits (200 forms incl. trash, 100 items per form, 100 choices per question). [both · forms · gate]
- As a panel member, I can see which pages a form was lately shown on ("Used on"; noted hourly, forgotten after 90 days). [both · forms · /forms]
- As a panel member, I can copy ready code: the two `<pammy-form>` lines, an "After sending" snippet (`thanks="page.html"` or `<template class="pammy-thanks">`), and a "Show approved answers" snippet. [both · forms · /forms]
- As a panel member, making or changing a form is written in Activity. [both · forms · Activity]

## 21. Form switches and approval
- As a panel member, I can switch a form on or off; off, pages say "not available" and nothing can be sent. [both · forms · /forms]
- As a panel member, I can switch on "Responses can be approved" to get an Approve button; turning it off also turns off public reading and remembers what was approved. [both · forms · /forms]
- As a panel member, I can choose for new responses "Wait for my OK" or "Show right away" (approved on arrival, still unread; passkey to choose it), so that a trusted form publishes without me. [both · forms (fresh) · /forms]
- As a panel member, switching back to "Wait for my OK" offers to hide in one go the responses that went up on their own and nobody opened, so that a burst of junk comes down fast. [both · forms · /forms]
- As a panel member, I can switch "Anyone can read the approved responses" (approvals on, passkey), so that a page can show a guest book or RSVP list. [both · forms (fresh) · /forms]
- As a panel member, I can't turn approvals off while the form saves into a database "when I approve". [both · forms · /forms]

## 22. Visitors using a form (`<pammy-form>`)
- As a visitor, I can see and fill in a form placed on any page with `<pammy-form name="…">`. [both · public · /_pammy/forms/:name]
- As a visitor, after sending I see the thank-you words, the page's own thank-you markup, or I'm taken to the page's `thanks="…"` (same site only). [both · public · <pammy-form>]
- As a visitor, I get clear messages when a form is off, trashed, used outside its folder, or full ("try again in a few days"). [both · public · gate]
- As a visitor, I can send at most 10 responses an hour (64 KB each); a hidden trap field swallows robot posts. [both · public · gate]
- As a signed-in visitor on a form in a protected folder (lfdln: behind a route with accounts), I see "Sending as <name>" and my account is kept with the response. [both · visitor · <pammy-form>]
- As a signed-in visitor, only I (signed in) can use a "signed-in only" form, and on a protected page only people allowed to open it see the form. [both · visitor · gate]
- As a visitor on lfdln, I can use a form on a service's page reached through a route. [lfdln · public · gate]
- As a site admin, I can restyle and reword `<pammy-form>` with attributes, classes, CSS variables or `styles="off"`. [both · page code · forms.js]

## 23. What a response keeps
- As a site admin, each response keeps: the form, the page it came from, every answer (key, label, kind, value, plus a row per value for filtering), the signed-in visitor (on protected pages only), host, IP, time, read / approved / trashed times and by whom, whether approved automatically, and for comments the thread. The trap field is never kept. [both · responses · gate]
- As a site admin, responses stay until trashed (no expiry), capped at 1000 unread / 10000 stored per form, so that one busy form never blocks the others. [both · responses · gate]

## 24. Responses inbox
- As a panel member, I can read responses newest first, 100 at a time, filtered by form, approved or not, read or unread. [both · responses · /responses]
- As a panel member, I see a red unread number (comments and examples left out), and on pammy Home the unread ones. [both · responses · menu, Home]
- As a panel member, I can mark one, all, or one form's responses read or unread (not logged in Activity). [both · responses · /responses]
- As a panel member, I can Approve or Unapprove (approving marks it read); if the form saves on approval I'm told where it was saved or why not. [both · responses · /responses]
- As a panel member, I can see who sent it (when signed in), the page, when and by whom it was approved ("automatically" if shown right away), and who read it. [both · responses · /responses]
- As a panel member, I can "Reply by email" to a response with an email answer. [both · responses · mailto]
- As a panel member, I can trash a response and restore it for 30 days, seeing when it goes for good. [both · responses · /responses]
- As a helper kept to places, I see only responses to forms in my folders. [both · responses (kept) · /responses]
- As a service/app, the gate deletes trashed responses and forms after 30 days and forgets "Used on" pages after 90, hourly. [both · housekeeping]

## 25. Responses API
- As a program, I can read a form's responses by number or by name, all or approved only. [both · API key · /_pammy/api/forms/…]
- As a program, I can filter by one field (including a name / address part), order, set a limit (1-1000) and page with an `after` cursor, getting a total. [both · API key · /_pammy/api/forms/…]
- As a program, I get every answer, the page, approval state and signed-in sender; a key limited to approved-only or some forms is refused elsewhere, and a key in the address is refused. [both · API key · gate]
- As a visitor (a public page's script), I can read a form's approved responses without a key when "Anyone can read" is on: only "Show publicly" answers, the sender only if "tell them who sent" is on, with ETag caching. [both · public · /_pammy/api/forms/by-name/:name/approved]

## 26. Form answers into a database (form-links)
- As a site admin, I can "Save answers in a database" for a form (not an example), so that each response also becomes a record in one of my tables. [both · databases (not kept) · /forms/:id/database]
- As a site admin, I can choose only panel-made databases with their app on, and tables in the app with "Add new ones" on, so that a form can add only what I could add by hand. [both · databases · /forms/:id/database]
- As a site admin, I pair each question (or name / address part) with a fitting field, with suggestions; fill fields with a fixed value, the time, the page, or who sent it; and I'm told about required fields left unfilled. [both · databases · /forms/:id/database]
- As a site admin, I choose to save "When I approve" or "As soon as it arrives", and can pause saving without disconnecting. [both · databases · /forms/:id/database]
- As a site admin, I'm asked to confirm before private answers go into a table anyone can read. [both · databases · /forms/:id/database]
- As a site admin, I see how the link stands (saved, "may or may not have been saved", problems like a renamed field or a table switched off). [both · databases · /forms/:id/database]
- As a site admin, I can "Save the earlier responses too" once (up to 500), and "Stop saving", keeping what was saved. [both · databases · /forms/:id/database]
- As a site admin, I'm warned in the builder before deleting a question that fills a field. [both · forms + databases · /forms/:id]
- As a site admin, a table's page shows which forms fill it ("Filled in by"). [both · databases · table page]
- As a panel member, each response shows where it was saved (link to the record) or why not, with "Try again". [both · responses · /responses]
- As a visitor, I get my "Thank you" even if the database is asleep: the response is kept first and saved afterwards. [both · public · gate]
- As a service/app, the gate retries saves that failed because a database was asleep every 15 minutes for about a day, never retries an "unsure" write, and never writes two rows for one response. [both · gate]

## 27. Comments
- As a panel member, I can make a comment area with a fixed name, a title, and what people comment on (the page it's on, or the records of one app table); it gets public "Your name" and "Your comment" questions. [both · forms · /comments]
- As a panel member, I can change what a comment area asks in the forms builder. [both · forms · /forms/:id]
- As a panel member, I can copy the two lines for a page (`<pammy-comments name=…>`, with `content-id` for table areas). [both · comments · /comments]
- As a panel member, I can switch an area's "Open" off to stop new comments while shown ones stay. [both · forms · /comments]
- As a panel member, every comment waits for my OK: approvals can't be turned off and "Show right away" is refused for comment areas. [both · forms · gate]
- As a panel member, I can list comments as Waiting for your OK, Shown on your pages, All, or In the trash, filter by area, and open "The whole conversation" for one page or record. [both · comments · /comments]
- As a panel member, I can Approve, "Take it off the page", trash or restore (30 days) a comment. [both · responses · /comments]
- As a panel member, Comments has its own red number (examples left out), and comments never appear in Responses. [both · comments · menu]
- As a helper kept to places, I see and make comment areas only in my folders. [both · forms / comments (kept) · /comments]
- As a visitor, I can read a page's approved comments (newest or oldest first, a page at a time, "Show more"), author and words only (never email, IP or page). [both · public · /_pammy/comments/:name]
- As a visitor, I can write a comment (same limits as forms) and I'm told it appears once approved. [both · public · /_pammy/comments/:name]
- As a signed-in visitor, my comment shows my account's name, not what I type; on a protected page only allowed people see the area. [both · visitor · gate]
- As a visitor, comments sent from a protected page never show or count on a public page sharing the thread. [both · public · gate]
- As a visitor (a blog index page), I can get approved comment counts for up to 100 content ids in one request. [both · public · /_pammy/comments/:name/counts]
- As a site admin, I can restyle and reword `<pammy-comments>` (heading, intro, button, texts, order, per, styles off, classes, CSS variables) and set `content-id` from a script. [both · page code · comments.js]
- As a visitor on lfdln, I can comment on a service's page reached through a route. [lfdln · public · gate]

## 28. Comments kept in app tables
- As a site admin, I can switch on "This app takes comments": Conversations and Comments tables are drawn (applied only on Review > Apply) and a "<db>-comments" area is made, linked to it. [both · databases · database app page]
- As a site admin, I can switch on "People can comment on these" for a table, giving each record its own conversation. [both · databases · table page]
- As a site admin, I can choose per area which app keeps its approved comments, or none. [both · databases (not kept) · /comments]
- As a service/app, the gate keeps the app's copy in step with approval both ways and recounts each thread, retrying when the database is asleep. [both · gate]

# D. Databases (the Studio)

## 29. Databases
- As a site admin, I can see my databases grouped: looked after by the panel (engine, tables, size, since when), made myself, the services' (lfdln), and the servers' own; down engines are flagged. [both · databases · /databases]
- As a site admin, I can make a database: name, Postgres or MariaDB (asked only when the site has both), optional app name. [both · databases · /databases]
- As a site admin, I can "Look after this one" for a database made elsewhere, or "Look inside" a service's database read-only. [both (services: lfdln) · databases · /databases]
- As a site admin, I can rename a database's app or stop the panel looking after it. [both · databases · /databases]
- As a site owner, I can delete a database after typing its name (passkey), told how long last night's backup is kept and that restoring is momolig's job. [both · databases (fresh) · /databases]

## 30. Database logins
- As a site admin, I can list SQL logins by engine, with "reaches everything" warnings and built-in logins noted. [both · databases · /databases/users]
- As a site admin, I can make a login (passkey) starting with no access, its connection details shown once. [both (lfdln names start `db_`) · databases (fresh) · /databases/users]
- As a site admin, I can set per database what a login may do: No access, Read only, Read & write, Structure editor, Administrator ("custom" for grants made elsewhere). [both · databases · /databases/users/:engine/:user]
- As a site admin, I can change a login's note, give it a new password (passkey), or remove it after typing its name (passkey). [both · databases (fresh) · /databases/users/:engine/:user]

## 31. Tables, fields, canvas, review
- As a site admin, I can see a database's tables and fields, and add, rename or remove tables as a draft that changes nothing until Apply. [both · databases · /databases/:engine/:name]
- As a site admin, I can add and rename fields and set what goes in each (Text, Short text, Whole number, Decimal, Yes/no, Date, Time, Date and time, Unique id), starting value, required, unique; the key and unknown types are read-only. [both · databases · table page]
- As a site admin, I can connect tables (one-to-many, one-to-one, many-to-many with a connecting table made for me), choose what happens on delete, change or remove a connection. [both · databases · fields page, canvas]
- As a site admin, I can design on a canvas: drag tables, add a field, connect, rename, copy or delete from a table's menu, fit to screen, Tidy up, show or tuck away connecting tables; positions save by themselves. [both · databases · /canvas]
- As a site admin, I can throw the drawing away and start from the real database, and I'm warned when the database changed elsewhere. [both · databases · review]
- As a site owner, I can review every waiting change with its cost (data lost, tags that go), whether it runs all together (Postgres) or one at a time (MariaDB), what changes in a switched-on app, and the SQL under Advanced, then Apply (passkey when the app is on). [both · databases · /review]
- As a site admin, a database owned by a service or project is read-only. [lfdln · databases · database pages]

## 32. The app and its pages
- As a site admin, I can see which tables the app manages and which are only proposed, and move tables between them. [both · databases · /app]
- As a site owner, I can switch the app on or off (passkey); on, it gets a menu group with a page per table, and it never puts anything on the internet by itself. [both · databases (fresh) · /app]
- As a site admin, I can set per table what one and many are called, a description, and the field it's named by, or "Start again". [both · databases · app table page]
- As a site admin, I can set per field a label, how it's filled in (one line, a few lines, rich text, number, tick box, date, time, day + time, pick a related record, text), shown or not, in the list or not, searchable or not. [both · databases · app table page]
- As a site admin, I can reorder the form's fields (including many-to-many pickers) or reset to the table's order. [both · databases · app table page]
- As a site admin, I can switch what people may do with a table (add, look at, change, delete, make a copy, search, sort, filter); these rules bind the pages and the API. [both · databases · app table page]
- As a site admin, I can choose "Before deleting a record": just ask, or show what else it affects. [both · databases · app table page]

## 33. Records
- As a panel member, I can list a table's records as a table or cards (remembered), search, sort, filter by field or label, and page. [both · databases · /app/:engine/:name/:table]
- As a panel member, I can add or change a record in a generated form following the table's rules, and delete one after confirming. [both · databases · /app/…]
- As a panel member, I can pick related records (one, or several for many-to-many) by search, filters and scrolling, not ids. [both · databases · record form]
- As a panel member, I can write rich text (headings, lists, links, tables) in a phone-friendly editor; pasting from Word or Google Docs is cleaned and bad links flagged. [both · databases · record form]
- As a panel member, I can tag and categorise a record on its page (new names in the table's own scope). [both · databases · record form]

## 34. Record tags
- As a site admin, I can switch tags on for a table with a primary key, choose a picture field for thumbnails, see counts and "Read again". [both · databases · app table page]
- As a site admin, I can make, rename and delete a table's own labels, and mark one "Anyone can see it" (passkey). [both · databases (fresh) · app table page]

## 35. Letting programs in, and the public data API
- As a site owner, I can switch "Programs may read it" and "Programs may change it" (change needs read), with my passkey. [both · programs (fresh) · /databases/:engine/:name/programs]
- As a site owner, I can make a database key (read, or read and change; passkey), shown once; stop a key, see stopped keys, and see the addresses programs ask at. [both · programs (fresh) · /programs]
- As a site owner, I can mark a table "Anyone can read these" (passkey), optionally only records where a yes/no field is yes. [both · databases (fresh) · app table page]
- As a site owner, I can let people signed in (pammy: to a protected folder; lfdln: on a route with accounts) add and change a table's records from a page, optionally each only their own via an owner field (passkey). [both · databases (fresh) · app table page]
- As a visitor, a page can read a public table's records: shown fields only, search, sort, `?where.` filters, label filters, paging, rich text made safe, public labels attached, ETag caching. [both · public · /_pammy/api/data/…]
- As a visitor, a page can get a public table's public label names for filter buttons. [both · public · …/_labels]
- As a signed-in visitor, I can list, add, change and delete records in my area's table from a page of the same site (only my own if it has an owner field). [both · visitor · /_pammy/api/data/…]
- As a program, I can read records and, with a write key and changing on, add, change and delete them; every request is checked against the current switches, the key goes in the header (never the address), and requests are rate-limited. [both · database key · /_pammy/api/data/…]

## 36. Database examples and tutorial examples (pammy)
- As a site owner, I can see the database examples (recipe book on Postgres, blog on MariaDB) and whether each is set up. [pammy · examples · /databases/examples]
- As a site owner, I can set one up or "Put it back as it was" (tables, samples, app, the blog's comment area and sample comments); my own copies are untouched. [pammy · examples (fresh) · /databases/examples/:kind]
- As a site owner, I can preview an example's public page in a computer or phone frame, open its canvas, and read or copy its three files. [pammy · examples · /databases/examples/:kind]
- As a site owner, I can "Make my own" from an example: engine, database name, app title, folder, page name, sample rows or not; the panel makes the database, tables, app, comment area and page. [pammy · examples (fresh) · /databases/examples/:kind]
- As a site owner, I can set up or reset the tutorial examples (journal and to-do list, JavaScript and PHP, guides 15-18) and use them inside the panel. [pammy · examples (fresh) · /databases/tutorial-examples]

## 37. Form examples (pammy)
- As a site owner, I can try three working pages (Guest book, Who's coming, Pinboard) framed at computer or phone width. [pammy · forms (whole site) · /examples]
- As a site owner, I can send to an example, approve my own entry and see it appear; examples always wait for my OK and keep only their newest 50 responses. [pammy · forms / responses · /examples/:kind]
- As a site owner, I can put an example back as it was. [pammy · forms (whole site) · /examples/:kind]
- As a site owner, I can "Put this on my website": a folder, a page name, an existing or new form; the page is never written over a file, and I'm told if the public switch still needs turning on. [pammy · forms (whole site) · /examples/:kind]
- As a site owner, examples can't be deleted, moved or saved into a database, and their responses don't count in my red number. [pammy · forms · gate]
- As a visitor, example pages are never in search engines and appear only framed in the panel. [pammy · public · /_pammy/examples/*]

# E. Visitors and who may see what

## 38. Settings > Visitors
- As a site admin, I can see the six visitor switches (emailed links, self-registration, change own password, delete own account, "Open with accounts", roles and privileges), each saying what on and off mean and who last changed it. [both · visitor-settings · /visitor-settings]
- As a site admin, I can switch each on or off (all start off; each change in Activity). [both · visitor-settings · /visitor-settings]
- As a site admin, I'm told why a switch can't be turned on yet ("Mail isn't set up for visitors", "Needs Emailed links first", "Needs Register first"). [both · visitor-settings · /visitor-settings]
- As a site admin, turning a switch off turns off the ones that depend on it (I'm told which); I can't turn off roles while a folder uses its own, or "Open with accounts" while a route is open to anyone. [both · visitor-settings · /visitor-settings]

## 39. People (visitor accounts)
- As a site owner, I can see everyone who can sign in: badges (switched off, made their own account, email not confirmed, no password yet, failed sign-ins today, also opens other folders), contact, last sign-in, browsers, setup link expiry. [both · protected · /people]
- As a site owner, I can add a person (username, private name, contact), with a setup link or a password I set or make up, and on pammy which protected folders they can open. [both · protected · /people]
- As a site owner, after adding I see the setup link once ("copy link", "copy with a short message") or the username and password once with the sign-in address. [both · protected · /people]
- As a site owner, I can tick which protected folders a person can open. [pammy · protected · /people, /protected-folders]
- As a site owner, I can make a new setup link (7 days, once; older links stop) or cancel one. [both · protected · /people]
- As a site owner, I can set a new password (signs them out everywhere), email a reset link to a confirmed address, or resend a self-registered person's confirmation, without ever seeing their password. [both (emails: lfdln) · protected · /people]
- As a site owner, I can edit a person's private name and contact, sign them out everywhere, switch them off and on, or remove them completely (passkey). [both · protected (remove: fresh) · /people]
- As a helper kept to places, I see only people who open my folders, can give or take my folders' access, and change the person only when every folder they open is mine. [pammy · protected (kept) · /people]
- As a site admin on lfdln, I see deleted accounts not yet passed on to every app, with tries and last answer. [lfdln · protected (whole site) · /people]

## 40. Requests ("let me in", "forgot password")
- As a site owner, I can see waiting requests: "<name> wants to open <folder>" with contact and message, "<person> forgot their password". [both · protected · /requests]
- As a site owner, I can approve an access request with a new person (suggested username) or someone on my list, choose their role when roles are on, and get a setup link to send. [both · protected · /requests]
- As a site owner, I can answer a forgot-password request with "Make a new link" (the old password works until the link is used). [both · protected · /requests]
- As a site owner, I can decline or dismiss a request (nothing sent), or delete an access request as junk. [both · protected · /requests]
- As a site owner, I can look back at requests dealt with in the last 30 days and who handled them. [both · protected · /requests]
- As a helper kept to places, I see and handle only requests about my folders. [pammy · protected (kept) · /requests]

## 41. Protected folders (pammy)
- As a site owner, I can protect a folder so everything in it needs a username and password; five starter sign-in pages and a stylesheet are added unless the folder has its own. [pammy · protected · /protected-folders]
- As a site owner, I'm warned before a "second lock" inside a protected folder, and already protected or locked folders are greyed out. [pammy · protected · /protected-folders]
- As a site owner, I can see each protected folder's addresses, which sign-in pages are its own, warnings ("folder not found", "nobody can open it yet", "no index.html"), and copies with the same protection. [pammy · protected · /protected-folders]
- As a site owner, I can add missing starter pages back, and switch "Let people ask for access" per folder. [pammy · protected · /protected-folders]
- As a site owner, I can stop protecting a folder (passkey); people and passwords stay. [pammy · protected (fresh) · /protected-folders]
- As a site owner, I can tick who opens each folder and add a person from the folder's card. [pammy · protected · /protected-folders]
- As a site owner, renaming a protected folder in WinSCP keeps its protection, and a deleted marker is put back, both logged. [pammy · protected · automatic]
- As a site owner, I see "Locked folders" with a marker the panel doesn't recognise, with what to do. [pammy · protected · /protected-folders]

## 42. Access page (roles, groups, privileges)
- As a site owner, I can open a folder's (pammy) or route's (lfdln, from Hosts) Access page with Roles, People, Groups and Privileges; with roles off it says everyone is Member and links to Settings > Visitors. [both · protected · /access/:id]
- As a site owner, I can "Copy to change" the built-in roles (everyone keeps their role) or go back to them. [both · protected · /access/:id]
- As a site owner, I can read (again) the app's pammy-panel.json for its privileges, roles and groups, told which went and who lost a role. [both · protected · /access/:id]
- As a site owner, I can set what people not signed in may do and which role counts for anyone signed in without one. [both · protected · Roles tab]
- As a site owner, I can add, rename, edit and remove roles (groups plus extra privileges, or "made of other roles"), moving people when one goes. [both · protected · Roles tab]
- As a site owner, I can mark two roles "never together". [both · protected · Roles tab]
- As a site owner, I can give each person one role here, or none. [both · protected · People tab]
- As a site owner, I can add, edit and remove groups and, when not from pammy-panel.json, resources and their actions. [both · protected · Groups, Privileges tabs]

## 43. Visitors on the public site
- As a visitor, opening a protected page sends me to its sign-in page and back after signing in. [pammy · public · gate]
- As a visitor, I'm told "That username and password don't match", "This account can't open this folder", or "please confirm your email first". [both · public · /_pammy/login]
- As a visitor, I'm slowed after too many tries (10 per IP per 15 min, 20 per username per hour). [both · public · /_pammy/login]
- As a visitor, I can use a setup link (7 days, once) to choose my password and land signed in; other sessions end. [both · public · /_pammy/invite]
- As a visitor, I can say I forgot my password (the answer is the same whether the username exists). [pammy, or lfdln with emailed links off · public · /_pammy/forgot]
- As a visitor, I can ask for access to a folder with name, contact and message, or see "This folder isn't taking requests". [both · public · /_pammy/request]
- As a visitor, I can sign out by button or logout.html and land on the "you're signed out" page. [both · public · /_pammy/logout]
- As a signed-in visitor, a protected folder with no index.html shows a welcome page listing what I may open. [pammy · visitor · /_pammy/welcome]
- As a signed-in visitor, PHP pages and apps behind a protected folder or route are told my username, account, role and privileges. [both · visitor · gate /check]
- As a visitor on lfdln, an "Open with accounts" route works without signing in; "Only people let in" sends me to sign in, or tells me I'm signed in but not let in. [lfdln · public · gate]
- As a site owner, I can reword and restyle the sign-in components. [pammy · page code · login.js]
- As a program (a page's script), I can ask `/_pammy/me` who's signed in, `/_pammy/about` for a folder's sign-in pages, and `/_pammy/accounts` which self-service features are on. [both · public · gate]
- As a visitor, a hidden field catches robots on register and ask-for-access, and robots are told it worked. [both · public · gate]

## 44. Visitor self-service (switch-dependent)
- As a visitor, I can make my own account (username, email, password) when registering is on; it works once I confirm my email and opens nothing protected until the owner lets me in. [lfdln · public · /_pammy/register]
- As a visitor, I get "Confirm your email address" (24 hours; unconfirmed accounts removed after two days); the link confirms and signs me in. [lfdln · public · /_pammy/confirm]
- As a visitor registering with an address already used, I get "You already have an account" with a reset link, and the page says nothing different. [lfdln · public · /_pammy/register]
- As a visitor, I can ask for a reset by username or email and get a link (one hour, once) that signs me out everywhere and back in here; an account with no email becomes a forgot-password request. [lfdln · public · /_pammy/reset]
- As a signed-in visitor, I can change my password (when allowed), change or add my email (confirmed from the new address; the old one is told), sign out everywhere, and delete my account (when allowed). [both (email: lfdln) · visitor · /_pammy/account]
- As a visitor, I get at most 5 site emails a day per address (40 per site), never containing anything anyone typed, linking only to the site's own `/_pammy/` pages. [lfdln · mail]

# F. Email

## 45. Email settings (Resend)
- As a site owner, I can see whether sending is ready (sent as, notices to, how many today) or why not. [pammy · software · /email]
- As a site owner, I can enter the Resend key once (then only its last four show) and the "sent from", "replies go to" and "notices go to" addresses (passkey). [pammy · software (fresh) · /email]
- As a site admin on lfdln, I see that the key and addresses are set by the installer, not the panel. [lfdln · admin · /email]
- As a site owner, I can send a test email from the panel and from each WordPress. [both (WordPress: pammy) · software / admin · /email]

## 46. Email notices
- As a site owner, I can tick which emails I get: new responses to chosen forms, comments waiting in chosen areas, access and forgot-password requests. [both · software (pammy) / admin (lfdln) · /email]
- As a site owner, I can see when the last notice went and the last problem. [both · software / admin · /email]
- As a site owner, notices name only the form, page or folder with a link into the panel, never what was written or who wrote it; 10 per look, then one "N more". [both · notices]
- As a service/app (the notifier), I skip old news when mail isn't set up, retry up to an hour when Resend is down, never send the same item twice, and keep within 60 an hour and 90 a day. [both · notices]
- As a site admin on lfdln, I can email myself one sample of each visitor email from the command line. [lfdln · server shell]

# G. Installed software (WordPress, pammy)

## 47. Installed software
- As a site owner, I can see my WordPress installs with address, state, "How it's doing", and buttons to open and sign in to their admin. [pammy · software · /software]
- As a site owner, I can open one: where it is, whether its own settings disagree with its address, files path, version, installed or "adopted by momolig", web server and database state, free memory, disk use, its complaints (logs) and what was done lately. [pammy · software · /software/:id]
- As a site owner, I can install a new WordPress at a subdomain, a folder path, the whole site (not while pammy.org is on hosts), or no address yet (passkey); my folder names are refused. [pammy · software (fresh) · /software/new]
- As a site owner, I'm shown the admin password once, can follow progress (or leave), and "Try again" if it failed. [pammy · software · /software/:id]
- As a site owner, installs update themselves and are backed up nightly (kept 14 days). [pammy · automatic]
- As a site owner, I can "Back up now", download any backup, and put one back (passkey; the current state is backed up first). [pammy · software (fresh) · /software/:id]
- As a site owner, I can take an install offline and back online. [pammy · software · /software/:id]
- As a site owner, I can make a new admin password for a chosen administrator (passkey), shown once and written to my login file. [pammy · software (fresh) · /software/:id]
- As a site owner, I can move an install to another subdomain, folder path or the whole site (passkey). [pammy · software (fresh) · /software/:id]
- As a site owner, I can delete an install (passkey, typing its name): last backup, offline, kept in Deleted for 30 days with its backups; then restore it, or delete it for good now (passkey, name). [pammy · software (fresh) · /software]
- As a service/app, a daily timer deletes installs deleted over 30 days ago and removes them from helpers' places (and their rights if no place is left). [pammy · automatic]
- As a helper kept to a WordPress's files, I get File Explorer on just those files. [pammy · files (kept)]
- As a site owner, my WordPress password resets and comment notices go out through Resend. [pammy · automatic]

# H. Sites and the server (lfdln)

## 48. Domains
- As a site admin, I can see every domain the panel serves (home domain marked): DNS keeper, what's in front, certificate type and file, the `*` record, host count. [lfdln · hosts (whole site) · /hosts]
- As a site admin, I can see each domain's checks one by one, passed or needed, with the reason. [lfdln · hosts (whole site) · /hosts]
- As a site admin, I can add a domain through a step-by-step guide, each answer checked on the server before the next. [lfdln · hosts (whole site) · /hosts/add-domain]
- As a site admin, I can choose a certificate covering only named hosts (e.g. "@ www admin"), so that a domain without a wildcard (gonsalvesfamily.com) still works, with no catch-all. [lfdln · hosts (whole site) · /hosts/add-domain]
- As a site admin, I can Turn on a domain (passkey): its catch-all goes into nginx and a made-up name under it is tested for real. [lfdln · hosts (fresh) · /hosts]
- As a site admin, I can remove a domain with no hosts that isn't the home domain (passkey). [lfdln · hosts (fresh) · /hosts]

## 49. Hosts
- As a site admin, I can add a host under the home or another domain, or "@" with an optional www. [lfdln · hosts (whole site) · /hosts]
- As a site admin, I'm warned as I type when a name is invalid, reserved (panel, www, api, mail, git) or already has its own DNS record. [lfdln · hosts · /hosts]
- As a site admin, I can delete a host and its routes (passkey; folders stay); refused while a route has accounts, and taken-over hosts can't be deleted. [lfdln · hosts (fresh) · /hosts]
- As a panel member, I can switch a host off ("not found") and on. [lfdln · hosts · /hosts]
- As a helper kept to places, I see and manage only my hosts, their routes and folders. [lfdln · hosts (kept) · /hosts]
- As a panel member, I see each host's checks (DNS points here, certificate covers it with days left, it answers), refreshed every 10 minutes, with "Check again" (once a minute). [lfdln · hosts · /hosts]
- As a panel member, I see badges (taken over from hand-written nginx, switched off, nothing shown yet) and the live address. [lfdln · hosts · /hosts]

## 50. Routes
- As a panel member, I can add a route at a path that shows a site folder. [lfdln · hosts · /hosts]
- As a panel member, I can add a redirect (302 or 301) to a URL or path, optionally carrying the rest of the path. [lfdln · hosts · /hosts]
- As a panel member, I can add a route to part of an adopted service (its local port), with websockets, an upload limit, and sign-in paths limited to 5 tries a minute. [lfdln · hosts · /hosts]
- As a panel member, I can add a route showing a project's live release or dev preview. [lfdln · hosts · /hosts]
- As a panel member, I can switch a folder route's "single-page app" mode (unknown paths give index.html). [lfdln · hosts · /hosts]
- As a panel member, I can stop, start or remove a route (removing refused while it has accounts). [lfdln · hosts · /hosts]
- As a panel member, every change reaches nginx at once or not at all (rolled back if `nginx -t` refuses). [lfdln · hosts · all hosts routes]
- As a panel member, I can see a route's extras (security headers, cached-for-good paths, websockets, upload limit, sign-in limits). [lfdln · hosts · /hosts]

## 51. Accounts on a route (home domain only)
- As a panel member, I can set a folder, service or project route to "Open to anyone", "Open with accounts" (when switched on in Settings > Visitors) or "Only people let in". [lfdln · hosts · /hosts]
- As a panel member, I confirm before a route goes back to "Open to anyone" and I'm told who lost a role. [lfdln · hosts · /hosts]
- As a panel member, I can open a route's "Who may use it" link to its Access page. [lfdln · hosts · /hosts → /access/:id]
- As a visitor, I can use an "Open with accounts" route unsigned with guest privileges. [lfdln · public · routes]
- As a signed-in visitor, I reach "Only people let in" routes I have a role on, and the app is told my account, username, role and privileges in headers it can trust. [lfdln · visitor · routes]
- As a service/app, I get `X-Lfdln-Account`, `-Username`, `-Role`, `-Privileges` on every request (forged copies removed first). [lfdln · service/app · routes]

## 52. Site folders
- As a site admin, I can add a static folder with a placeholder page, by default at its own host straight away (or not shown yet), PHP on or off. [lfdln · hosts (whole site) · /hosts]
- As a panel member, I can switch "Run PHP pages" per folder; off, PHP is never sent as text. [lfdln · hosts · /hosts]
- As a panel member, I see each folder's addresses and badges (on the server before the panel, not on disk, not shown anywhere). [lfdln · hosts · /hosts]
- As a site admin, I can delete a site folder (passkey): routes first, then its host if nothing else is on it, then the folder to the trash for 30 days. [lfdln · hosts (fresh) · /hosts]

## 53. pammy.org on hosts (command line)
- As a site admin, I can seed host rows, apply them, switch pammy.org's nginx to them (answers compared before and after, given back on any difference) and switch back. [pammy · server shell · pammy-panel CLI]

## 54. Services
- As a panel member, I can see every adopted service (TutorStar, Gonsalves family, Placement Exam Prep): when taken in, its user, where its data is, an about line, each part's state. [lfdln · services (whole site) · /services]
- As a panel member, I see the addresses each part is shown at ("route off") and a warning when its Quadlet changed since it was taken in. [lfdln · services · /services]
- As a panel member, I can start, stop or restart a service or one part (passkey); stop survives reboots, start waits for its health path, restart restarts what depends on it. [lfdln · services (fresh) · /services]
- As a panel member, I can read the last 200 lines of a part's log. [lfdln · services · /services]
- As a panel member, a one-shot part (Gonsalves migrations) is never started from the panel. [lfdln · services · /services]
- As a panel member, I can read a service route's pammy-panel.json again (up to 64 KB; a bad file is refused whole and the last good one stays). [lfdln · protected · /access/:id]

## 55. Account deletion hooks
- As a service/app, I'm told within about a minute when a visitor account is deleted (by an admin, by the person, by the 48-hour cleanup, or a registration taken back), by a signed POST to my local `/_lfdln/account-deleted`, retried after 1, 5, 30 minutes then every 6 hours. [lfdln · service/app · automatic]

## 56. Settings > Backups
- As a site admin, I can choose how many days (7-365) nightly copies of the Studio's databases are kept (passkey); lowering it asks first and deletes older copies at once. [lfdln · admin (fresh) · /backups]
- As a panel member, the delete-a-database dialog shows how long a deleted database can still be recovered. [lfdln · signed-in · /databases]
- As a site admin, old copies are pruned hourly, recorded, and deletions logged in Activity. [lfdln · admin · /backups]

## 57. Monitoring
- As a panel member, I can see every check grouped (hosts, certificates, other addresses, services, projects and the build proxy, the panel's own pieces, backups, disk, mail DNS and nameservers, domain registration), with state, how long and why. [lfdln · monitoring (whole site) · /monitoring]
- As a panel member, I see what is down now at the top and the last 7 days of changes. [lfdln · monitoring · /monitoring]
- As a panel member, I can "Check now" (once a minute) for a full round. [lfdln · monitoring · /monitoring]
- As a panel member, an intentionally stopped part, project server or switched-off host shows as "stopped", not down. [lfdln · monitoring · /monitoring]
- As a site admin, I get an email when something fails twice in a row, when it's back, a daily "still down", and warnings (at most one per round, 10 a day). [lfdln · admin · every 5 min]
- As a site admin, I can switch monitoring emails on or off, make one subject or everything quiet for 1, 4 or 24 hours (still checked) and end it early, and "Keep as it is now" a DNS record or nameserver changed on purpose. [lfdln · admin (whole site) · /monitoring]
- As a site admin, a root watchdog emails me when the panel stops answering or its rounds stop (every 10 minutes; daily while it lasts; once when back). [lfdln · admin · watchdog timer]

## 58. Projects
- As a panel member, I can see all projects: kind, live release (id, commit, age), dev branch, running job, not built, last job failed, security and update counts, addresses. [lfdln · projects (whole site) · /projects]
- As a panel member, I can make a project (React, Vue, Svelte, Lit, Next.js static or server; TypeScript or JavaScript; npm or pnpm; Tailwind optional; dev branch optional), optionally with its own host and a private dev preview host. [lfdln · projects (whole site; + hosts) · /projects]
- As a panel member, I can check the build environment and see recent jobs and their logs. [lfdln · projects · /projects]
- As a project owner or site admin, I can rebuild, or put any earlier release back live (main or dev). [lfdln · projects + owner · /projects/:id]
- As a project owner or site admin, I can delete a project (passkey) once no route shows it; code and releases go to the trash for 30 days, databases stay. [lfdln · projects + owner (fresh) · /projects/:id]
- As a project owner or site admin, I can turn the dev branch on or off, and "Put dev live" (passkey). [lfdln · projects + owner (fresh) · /projects/:id]
- As a project owner or site admin, I can add or remove owners (never zero). [lfdln · projects + owner · /projects/:id]
- As a project owner or site admin, I can start, stop or restart a Next.js server (stopped stays stopped), and read its log. [lfdln · projects + owner · /projects/:id]
- As a project owner or site admin, I can list, set and remove environment variables (public ones flagged), seeing values only after a passkey; Activity records names, never values. [lfdln · projects + owner (values: fresh) · /projects/:id]
- As a project owner or site admin, I can give a server project's main or dev branch its own Postgres or MariaDB database (`DATABASE_URL`, `DATABASE_OWNER_URL`), and let the preview use live data for a moment (passkey, warning). [lfdln · projects + owner (fresh) · /projects/:id]

## 59. Project packages
- As a panel member, I can see a project's npm packages (dev, latest, advisories, deprecated) and scripts, and search npm with "what to know" before adding. [lfdln · projects · /projects/:id/packages]
- As a project owner or site admin, I can add, update (one, all minor/patch, or a major such as Next.js with companions), remove or fix security issues; each change is committed and built, undone if the build fails. [lfdln · projects + owner · /projects/:id/packages]
- As a project owner or site admin, I can run a package.json script in the build container. [lfdln · projects + owner · /projects/:id/packages]
- As a project owner or site admin, I can turn on nightly updates within ranges (committed, built, undone on failure). [lfdln · projects + owner · /projects/:id]
- As a service/app (a build), I reach only allow-listed registries through the build proxy. [lfdln · build proxy]

## 60. Project code (git)
- As a panel member, I see a project's clone addresses (HTTPS always; SSH for owners with a Unix account); a push to main goes live, to dev builds the preview. [lfdln · projects · /projects/:id]
- As a panel member, I can make personal git tokens (passkey; 30 days, 90 days, a year or until revoked; shown once), see when each was last used, and revoke them. [lfdln · projects (fresh) · /projects/git-tokens]
- As a program (git client), I can clone any project (Projects right) and push to ones I own at `https://git.<domain>/<project>.git` with username and token; repeated failures are blocked. [lfdln · token · git-auth]

# I. Keys and the command line

## 61. API keys (forms and media)
- As a panel member with Programs, I can see API keys (working or revoked, prefix, cover, who made it, last used). [both · programs · /api-keys]
- As a site admin, I can make a key (passkey) with a forms cover and media folders (none, all, or ticked), shown once. [both · admin (fresh) · /api-keys]
- As a site admin, I can revoke a key (passkey); it stops at once. [both · admin (fresh) · /api-keys]

## 62. Server command line (sudo)
- As a site admin, I can manage panel accounts from the shell (users, add-user, invite, disable, enable, signout, role, access, activity), so that I can get in when nobody can use the panel. [both · server shell]
- As a site admin, I can run media-sync and media-thumbs to catch up records and thumbnails. [both · server shell]
- As a site admin, I can seed the home domain, adopt existing folders as site folders, and take over a hand-written nginx host (kept only if it answers the same). [lfdln · server shell]
- As a site admin, I can check mail status and send myself sample visitor emails. [lfdln · server shell]
- As a site admin, I can adopt the hand-installed blog.pammy.org with a one-time installer command. [pammy · installer]

---

# Gaps and half-built things found while writing these

Not stories; things the reading turned up. Each is unconfirmed until someone checks the panel.

**Forms and comments**
1. Comment areas can't be deleted or restored in the panel (no Delete on Comments or the builder; the Forms trash hides them).
2. Managing comments takes three rights: making an area and its Open switch need `forms`; approve / trash need `responses`; only the Comments list needs `comments`.
3. Not built (comments plan): closing one conversation, a shorter builder for comment areas, replies, emails to commenters, comment counts in the data API, the robot check (guides say "on the way").
4. Not built (form-to-database plan): choices from a table, many-to-many, "Make a table for this form", Apply naming the forms a step would stop.
5. Not in forms v1: file upload, conditional questions, multi-page forms, CSV export, emailing the sender.
6. Responses API: any `:scope` word other than "approved" means "all".
7. lfdln's guide says to make a comment area from Forms; the button is on Comments.

**Studio**
8. The "Filter" ability defaults off and fields' `filterable` has no switch in the panel.
9. "Make a copy" can be switched on but no record page has a copy button.
10. "Show me what else it affects first" only changes the wording; it doesn't list the records.
11. No restore of a database from the panel (pammy says a fixed seven days).
12. The data API switch and database keys live in the comments package.

**Accounts and visitors**
13. pammy.org can't send visitor emails, so Emailed links, Register and Open with accounts can't be switched on there.
14. lfdln routes always take access requests; there's no switch.
15. Helpers kept to hosts on lfdln probably see no people, requests or Access pages (area paths `/route/<id>` vs places `/<host>`).
16. The Email page needs `software` on pammy but is admin-only on lfdln.
17. Settings > Visitors text talks about "protected folders" on lfdln, which has none.
18. Forgot-password requests can only be dismissed, not deleted as junk.
19. Gate rate limits and visitor mail limits are in memory: a restart resets them.
20. No way in the panel to demote an admin or change an admin's places (by design for promotion).
21. Approving a request always gives Member unless roles are on and the area has more than one named role.

**Sites and the server**
22. pammy.org has no Hosts page; its host rows are driven by command line only (8-7d set aside).
23. Add a domain's "every top-level folder its own host" is shown but disabled.
24. Accounts on a route, helpers kept to places and "Add a static folder" hosts work on the home domain only.
25. Laravel projects exist in records and labels but aren't offered (8b-6 skipped); 8b-9 not done.
26. Host checks stay cached up to 10 minutes after a fix; the "answers not found" notice is wrong for "@"/www on other domains.
27. The services list is hard-coded (`known.ts`); no add, delete or deploy from the panel.
28. Service routes always send websockets; there's no checkbox.
29. Kept helpers see route Remove / Stop and accounts controls (the server allows them under `hosts`).
30. Monitoring's "Other addresses" (Gonsalves, pammy.org) are hard-coded in lfdln's app.
31. Media examples routes are registered on lfdln though the menu and gate hide them.
32. WordPress updates have no button or status (automatic only).
