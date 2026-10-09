# Use only what you need

PROPOSED 2026-10-06. Nothing built. **Essential parts DECIDED 2026-10-06** (section 0), **ES-Q1..ES-Q5
DECIDED 2026-10-06** (all yes). U-Q3..U-Q6 DECIDED 2026-10-06 (all as suggested); U-Q1 superseded by ES-Q3. **U-Q2 DECIDED 2026-10-06: (b)**, forms
go on websites the panel doesn't manage (section 4). **2026-10-08** (momolig, suggestions taken):
U2, U3 and U9 count as structural refactors (master-plan section 6); U0 and U1 may start now;
Turnstile is its own step, **U7a**, before U7.

momolig, 2026-10-06: *"We want to make it so that a person can use whatever parts of the panel
they need. That is, suppose the only thing they want to use from the panel is Forms, then they
should be able to just use that. Also Comments should be an extension of Forms, which is a
plugin."* Asked whether "a person" means a whole site or one person on a shared panel: *"it's
both"*.

Part of the master plan (docs/master-plan.md, Track U). It builds on phase 0
(docs/module-contracts-plan.md: `defineModule`, the kernel, extension points; P-Q1 "modules are
the plugins") and on phase 3's rights (docs/permissions-plan.md). On order and dependencies,
master-plan wins; on how a step works, this plan does.

## What it means: three levels, one rule

| Level | Who | "Only Forms" means |
|---|---|---|
| **Site** | whoever runs a panel | a panel installed with Forms and nothing else it doesn't need |
| **Person** | one person on a shared panel (lfdln, pammy.org) | they see and use Forms only: menu, Home, Help, red numbers, Getting started |
| **Plugin of a plugin** | a module | Comments plugs into Forms the way Forms plugs into the kernel. Comments off: Forms doesn't notice. Forms off: Comments can't be on |

**The one rule, at every level:** a part works with only what it *must* have; everything else
it can do with other parts **lights up when those parts are there**, and is hidden (not broken)
when they aren't.

## 0. Essential parts: always on (DECIDED 2026-10-06)

momolig, 2026-10-06: *"things that are essential: hosts/domains, visitors/protected areas,
accounts, backups, monitoring, everything else must be turned on"*.

Every site runs the kernel and these, and they can't be turned off. Every other module is
**off until someone turns it on**.

| Essential | Modules | Today |
|---|---|---|
| **Accounts** | the kernel's panel accounts, passkeys, rights and places, Activity | kernel (core) |
| **Hosts / domains** | `hosts` | lfdln only; pammy.org's host rows are command line only (8-7d set aside) |
| **Visitors / protected areas** | `areas`, `people`, `requests` (ES-Q2) | both sites |
| **Backups** | **`backups`**, a new module: Settings > Backups, pruning, and the backup contract (10) that other modules fill | inside `services` (`services/src/panel/backups.ts`, `prune.ts`, `routes/backups.ts`) |
| **Monitoring** | `monitoring` | lfdln only; what it checks is hard-coded in lfdln's site |
| **Mail** (ES-Q1) | `mail`: the sender, notices, visitor mail | both; pammy.org has no visitor mail socket yet |

**Everything else is optional**: files, media, thumbs, catalog, forms, form-links, comments, studio,
api-keys, apps, services, projects, php, examples, getting-started, and each module's guides (the
Help page itself is kernel, ES-Q4).

### What this means

1. **An essential module may need only the kernel and other essentials.** Anything optional it
   can use is works-with. That's rule 15 with one more line: no essential module *needs* an optional
   one. Checked by `checkModules` and by the per-module test (a site with only the essentials boots
   and passes its verify).
2. **Turning on is a person's action**, so U-Q1 moves toward (b): a **Settings > Parts** page lists
   the optional modules, what each adds, and what it needs. Turning one on also turns on what it
   needs, after saying which ("Comments needs Forms: turn both on?"). Turning off keeps the data
   (U-Q4) and is refused while another module that's on needs it. U6 becomes a needed step.
   Confirm in ES-Q3.
3. **Essentials found leaning on optional modules** (checked 2026-10-06):

   | Essential | Leans on | Fix |
   |---|---|---|
   | areas (protected folders) | the website files helper (sitefs `protect`, `markers`, `install-pages`), which belongs to `files` | **folder** becomes a place kind owned by `hosts` (site folders), so protecting a folder goes through hosts' places; the sitefs helper is shared infrastructure, not File Explorer's. File Explorer stays optional |
   | people (emailed links, resets, confirmations) | `mail` | none needed: mail is essential (ES-Q1); pammy.org gets a visitor mail sender (U10) |
   | monitoring (down / up mail, watchdog) | `mail` | none needed: mail is essential (ES-Q1) |
   | backups (Studio databases' nightly copies) | `studio`, `services` | the backup contract: each module registers what it backs up; backups owns the schedule, retention and the page |
   | hosts (route kinds: service, project) | `services`, `projects` | already a registry (route kinds); those kinds appear when their modules are on |
   | monitoring (checks of services, projects, hosts) | everything it checks | the health contract (9): each module registers its checks; the list in lfdln's site goes |
4. **Today's modules that must split**: backups out of `services` (new `backups` module);
   Settings > Visitors moves with `people` (people's switches); Settings > Email with `mail`.
5. **pammy.org gets hosts and monitoring turned on** (ES-Q5): the Subdomains page becomes hosts'
   folder routes (the set-aside 8-7d), and monitoring checks pammy.org's own hosts.

## What there is today (checked 2026-10-06 on main 98d1dc4)

**Sites.** Each site's profile lists its modules (`sites/lfdln/src/profile.ts:50`: 20 modules,
no `apps`, `examples` or `getting-started`). `NEEDS` (`packages/core/src/profile.ts:118`) says
which modules must be on with which, and `checkModules` refuses a profile that breaks it. Every
need is a **must**; there is no "works better with". So "only Forms" today is:

| Module | Must have today | Of those, really only for a feature |
|---|---|---|
| forms | areas, mail, api-keys | all three: signed-in-only forms (areas), email notices (mail), the responses API (api-keys) |
| comments | areas, forms, form-links, studio | areas (signed-in commenters), form-links + studio (comments about app records, in app tables) |
| examples | areas, files, forms, api-keys, studio, form-links, comments, apps | each example needs only its own modules |
| getting-started | help, examples, studio | each path needs only its own modules |
| media | areas, api-keys, catalog, files, thumbs | likely api-keys (the public media API); the rest to check in U0 |

(K0's coupling report, U0 below, fills in the rest and the needs hidden in socket and gate ops.)

**People.** Rights say what a person **may** use: 16 rights, a fixed list in
`packages/core/src/panel/rights.ts:16`, given by an admin on Accounts; the profile's modules
decide which exist. Rights don't depend on each other (Comments can be given without Forms).
An admin has every right and always sees everything. **A person can't choose what they use**:
someone with every right who only ever uses Forms still has the whole menu.

**Comments inside Forms.** Comments is a peer of Forms on paper, but it lives inside it:
- a comment area is a form with `kind = 'comments'` and a `content_type` (what it's about),
  columns on Forms' table (`forms/src/gate/forms/store.ts:19-21, 84-94`);
- the rule "comments always wait for your OK" is in Forms' store (`store.ts:158-160`);
- threads, thread counts and the blog example's comment area are in Forms
  (`forms/src/gate/forms/threads.ts`);
- Forms serves `/api/comments` and Comments' red number (`forms/src/panel/routes/forms.ts:242-268`),
  and its widget knows `/_pammy/comments`;
- "comment" appears 79 times in the forms package (server, pages, widget);
- managing comments takes **three rights**: making an area and its Open switch need `forms`,
  approving and trashing need `responses`, only the Comments list needs `comments`
  (docs/user-stories.md section 27, gap 2); comment areas can't be deleted from the panel (gap 1);
- the comments package has **no tables**, yet owns the Studio's data API switch and app keys
  (architecture.md coupling problems 5 and 7; the switch moves to `studio` in K-b).

## 1. Must have, and works better with

`defineModule` (module-contracts section 1) gets a second list:

```ts
export default defineModule({
  name: 'forms',
  needs: [],                                   // must have: forms works with the kernel alone
  worksWith: {                                 // lights up when on
    mail:       'email notices of new responses',
    areas:      'forms only signed-in visitors can fill',
    'api-keys': 'programs reading responses',
  },
  sockets: { formKinds, responseEvents, inboxSections, widgetParts, builderPanels },  // section 2
  …
});
```

- **`needs`** is what `NEEDS` is today and stays checked the same way.
- **`worksWith`** says, in words a person reads, what each other module adds. The panel can show
  it ("Turn on Email to get notices") and Help can say it.
- A module asks `use.has('mail')` and, if so, goes through mail's **public entry or sockets**,
  never its tables (rule 1). Nothing is half-on: the feature, its routes, its menu items and its
  part of the widget appear together or not at all.
- **Tested both ways**: each module boots and works (server tests, and a browser test of its
  pages and widgets) with **only its `needs`**, and once with all of its `worksWith`. Not every
  combination: two runs per module.

## 2. Plugins of plugins

The kernel hosts modules; a module can host plugins. Module-contracts already lets the module
that owns an extension point declare it ("the module that owns a point declares it"); this plan
adds the rule that goes with it: **a module names none of its plugins** (rule 3 one level down).

### Forms' sockets

| Socket | What a plugin adds | Comments uses it for |
|---|---|---|
| **Form kinds** | a kind of form with its own defaults, rules and fields | "comment area": always waits for approval, its starting fields, limits per form, what it's about (a page or an app table) |
| **Response events** (`forms.response.kept`, `.approved`; C4) | reacting to an answer | thread counts, notices |
| **Approval rules** | "this kind must wait for an OK" | forced approval (C15) |
| **Inbox sections** | a section of Inbox with its own red number | Inbox > Comments |
| **Widget parts** | building blocks of `<pammy-form>` | `<pammy-comments>`, built in comments' own `widgets/` |
| **Builder panels** | settings shown in the form builder for that kind | the comment area's settings |
| **Read queries** | a public read over a kind's approved answers | a thread, counts for many threads |

### Comments, rebuilt as a Forms plugin

- `needs: ['forms']`; `worksWith: { areas: 'signed-in commenters', studio: 'comments about app
  records', 'form-links': 'comments saved into app tables', mail: 'notices' }`.
- Registers the `comments` form kind; its routes (`/api/comments`, the red number) and
  `/_pammy/comments` move into the comments package.
- What only comments use (what an area is about, a comment's thread) moves to **comments' own
  table**, expand then contract (master-plan section 7): new table filled and read first, Forms'
  columns dropped in a later release.
- Forms afterwards contains no comment code; a boundary check refuses the word in forms' code
  (with a short allow list for history and words like "comment" in SQL).
- **Nothing changes on screen.** The same pages, widgets, data and words.

### Other candidates (not now; U-Q5)

`form-links` (a Forms plugin that also uses the Studio), `requests` (a `people` plugin),
`media` (a `files` plugin), each examples set (a plugin of the modules it shows). Each one when it's
next worked on.

## 3. Per person: rights and "my parts"

- **Rights stay what a person may use** (given by an admin, enforced by the server).
- **New: "my parts", what a person uses** (chosen by the person, not security). On their own
  account page: "What do you use the panel for?", ticking among the parts they have. The menu,
  Home, Help, search, red numbers and Getting started show only those. "Show everything" is one
  click away.
- **Default: every part you have**, so nothing changes for anyone until they choose (U-Q6).
  Admins can choose too: an admin who only does Forms sees only Forms.
- Getting started's questionnaire can set it ("I want a contact form" → Forms, Responses).
- **Features of one part that belong to another show when the person has both**: inside Forms,
  "Letting programs read responses" only with `programs`; "about an app's records" in Comments
  only with `databases`. Same rule as section 1, per person.
- Rights are registered by their modules (K-b), so a module that's off has no right, and a
  plugin's right comes with the plugin.

## 4. Per site

- **At install** (today's mechanism): the profile lists the modules; with section 1 a profile
  of `['forms']` is valid. Minimal profiles are **test profiles** first (forms only; forms +
  comments); no third real site is planned.
- **Where does a Forms-only person put their forms?** DECIDED (U-Q2 = b): **on their own
  website, which the panel doesn't manage**, as the `<pammy-form>` web component. Today the
  component only works on the panel's own sites (`forms/widgets/forms.ts`): it's loaded as
  `/_pammy/forms.js`, calls `/_pammy/forms/<name>` by relative URL with
  `credentials: 'same-origin'`, sends `page: location.pathname`, and follows a `thanks` address
  only on the same origin (`forms.ts:405-406`). Working on another site (U7) means:
  - **Absolute addresses**: the page loads `https://<panel host>/_pammy/forms.js`; the component
    finds the gate from its own script's address.
  - **Which websites, per form**: each form gets a list of websites it may be on (origins,
    e.g. `https://example.com`). The gate sends CORS headers only to those, and refuses others.
    A form with an empty list works only on the panel's own sites (today's behaviour).
    CORS only stops other people's *pages*; it doesn't stop scripts, so spam protection still matters.
  - **No cookies across sites**: browsers block third-party cookies, so **signed-in-only forms
    (areas) and comments that need sign-in stay panel-sites-only**. A form shared to other sites
    is anonymous.
  - **Spam**: honeypot + rate limits today. Other sites make **Turnstile** (planned since the
    Forms redesign) more urgent; it comes before U7, as step U7a.
  - **Thanks page**: allowed on the form's listed websites too; `page` is sent as the full
    address, so Responses shows which site an answer came from.
  - **Looks**: the host page's CSS is unknown; the component keeps its own styles (shadow DOM
    or scoped class names) and exposes a few CSS variables for colours and fonts.
  - The builder's "Put this on my website" shows the two lines to paste (script + tag) with the
    absolute address, and the websites list next to it.
  A **form link** (a page that is just the form) stays possible later; it isn't needed for this.
  **Decided 2026-10-06 (momolig, as suggested):** comment areas work on other websites the same way
  (anonymous only there, sign-in comments stay on panel sites); the websites list is **per form**
  (per comment area for comments).
- **Turning parts on and off later** (Settings > Parts) means nginx, units and migrations
  change, which is an install today. U-Q1.

## Steps

Each its own release (master-plan rule 10). **Pamela**: whether pammy.org changes on screen.

| Step | What | Needs | Pamela | Size |
|---|---|---|---|---|
| **U0** | in K0's coupling report: for each module, which `needs` are really features (must vs works with), and the hidden ones in socket and gate ops | K0 | no | S |
| **U1** | `defineModule` gets `worksWith` and `use.has()`; values are today's (everything stays a must) | C1 | no | S |
| **U2** | **Forms stands alone**: mail, areas, api-keys become works-with; the forms-only test profile boots, and its builder, inbox and `<pammy-form>` pass a browser test there; rules 15 and 16 start; a structural refactor (one at a time, master-plan section 6) | K-b | no | M |
| **U3** | **Comments as a Forms plugin** (section 2): Forms' sockets; comment kind, routes, counts, widget, builder panel move to comments; comments' own table (expand, then contract in a later release); a structural refactor (one at a time, master-plan section 6) | U2; before B6 (M4 touches the same code) | no | L |
| **U4** | **My parts** (section 3), and features that need two parts showing only with both | K-b | yes: a new choice, nothing changes until she uses it | M |
| **U5** | the other modules one at a time, when each is next touched (rule 15); examples and Getting started show only what's on | U2 | per module | per module |
| **U6** | **Settings > Parts**: optional modules off until turned on; turning on brings what it needs (section 0) | U5 | yes | M |
| **U8** | **`backups` module** split out of `services`, essential; the backup contract (10) with Studio databases as its first source | C2-rest | no | M |
| **U9** | essentials stand alone: a site with only the kernel + essentials boots and verifies; areas' folders through hosts' place kind; monitoring's checks registered by modules (contract 9); a structural refactor (one at a time, master-plan section 6) | U2, K-b, C2-rest | no | M |
| **U10** | (ES-Q5) pammy.org turns on hosts and monitoring: Subdomains → hosts' folder routes (8-7d) | U9 | yes | M |
| **U7a** | **Turnstile** (the robot check) on forms, comment areas, register and "let me in" requests: one site key per site, a switch per form; B3 reuses it for project sign-up (decided 2026-10-08) | none (not while K-a / K-b freeze the gate) | yes: a new switch, off until she turns it on | S |
| **U7** | **Forms on any website** (U-Q2 = b, section 4): absolute script address, per-form websites list + CORS, anonymous only across sites, Turnstile, thanks page on listed sites, isolated styles; security review 🔒. Form links later, if wanted | U2, U7a | yes: new websites list in the builder; existing forms unchanged | M |

## Rules this plan adds (master-plan section 3)

15. **A module works with only its must-haves.** Everything else lights up when present
    (`worksWith`, `use.has()`), and is tested both ways (only `needs`; all `worksWith`).
16. **A module's plugins plug into its sockets; the module names none of them.** Rule 3, one
    level down.

## Questions for momolig

### U-Q1. Turning parts on and off: at install, or from Settings too? (superseded by ES-Q3)
(a) at install only (the profile); (b) also Settings > Parts, without reinstalling.
**Suggestion: (a) now, (b) later (U6).** Turning a part on can add nginx locations, units and
tables; that is an install today. Data of a part turned off is kept.

### U-Q2. Forms-only, with no website in the panel: where do the forms go?
(a) a form link (a page that is just the form); (b) put the form on a website elsewhere;
(c) both. **Suggestion: (a) first; (b) later as a 🔒 step** (another origin's page talking to the
gate needs CORS rules and a review).
**DECIDED 2026-10-06 (momolig): (b).** *"the assumption is they will use the form as a web
component on a site that isn't necessarily managed by pammy panel."* (b) is the main path, and
(a) is optional later. What it needs is in section 4 and step U7.

### U-Q3. Does the Comments right need the Forms right?
**DECIDED 2026-10-06: as suggested.**
**Suggestion: no, and fix today's split.** Rights are about people: someone who only approves
comments shouldn't need the form builder. Today it takes `forms` + `responses` + `comments`
(section "What there is today"); after U3 everything about comments (areas, Open switch,
approving, trash) needs `comments` alone. The *module* dependency (Comments needs Forms on) is
what's enforced.

### U-Q4. Comments turned off on a site that has comment areas
**DECIDED 2026-10-06: as suggested.**
**Suggestion:** areas and comments are kept and hidden; `<pammy-comments>` on pages shows
nothing; turning Comments back on brings everything back.

### U-Q5. Which other modules become plugins of another, now?
**DECIDED 2026-10-06: as suggested.**
**Suggestion: only Comments now** (U3); the candidates in section 2 when each is next touched.

### U-Q6. "My parts" by default
**DECIDED 2026-10-06: as suggested.**
**Suggestion: every part the person has**, so nothing changes until they choose; Getting
started can offer to narrow it.

### ES-Q1. Is mail essential?
**DECIDED 2026-10-06: (a), mail is essential.**
Monitoring's down / up mail and visitors' emailed links both use it. (a) essential; (b) optional,
works-with for monitoring and people. **Suggestion: (a)**: a server that can't tell anyone it's
down isn't monitored. The sender is set up by the installer, as on lfdln.

### ES-Q2. Are "let me in" requests part of visitors / protected areas?
**DECIDED 2026-10-06: yes.**
**Suggestion: yes**, `requests` is essential: it's how a visitor reaches a protected area at all.

### ES-Q3. Turning parts on: from the panel (Settings > Parts), by an admin?
**DECIDED 2026-10-06: yes**, as suggested.
**Suggestion: yes**, admins only, with a fresh passkey; turning on can add nginx locations, units
and tables, so the panel does it through the installer's helper, not by itself. This replaces
U-Q1's suggestion (a).

### ES-Q4. Is Help essential?
**DECIDED 2026-10-06: yes**, as suggested.
**Suggestion:** the Help page is kernel (always there); each module brings its own guides (Help
topics registry, C2-rest), so Help shows the guides of what's on.

### ES-Q5. pammy.org gets hosts and monitoring turned on
**DECIDED 2026-10-06: yes, U10.**
**Suggestion: yes, as U10**, after the essentials stand alone (U9). It revives 8-7d (Subdomains on
the hosts API).
