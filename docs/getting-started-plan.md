# Getting started: plan

Status: **built 2026-09-23 as release f1b5788e41548bc3 (commit 82bb2cf), not installed** (migration 0017).

### As built

- `src/getting-started/`: `questions.ts` (the tree, `nextQuestion`, `cleanAnswers`, `recommend`),
  `paths.ts` (14 paths, their steps and checks, `bind`), `facts.ts` (one gather per request: panel
  tables directly, the gate's `forms.state` / `state` / `formlinks.for-database`, the website helper
  for a page, her database only when `deep`, 2 s limit), `store.ts`, `view.ts`.
- Routes `src/panel/routes/getting-started.ts`: `GET /api/getting-started[?deep=1]`, `POST .../ask`,
  `.../start`, `.../:id/step`, `.../:id/not-the-one`, `.../:id/put-away`, `.../open`. Manager only.
- "Make my own" writes `copied_from`, `page`, `copied_rows` (0017 back-fills older copies).
- Web: `components/getting-started.tsx` (Home card + step list), `pages/GettingStarted.tsx`
  (`/getting-started`), a link at the top of Help for managers.
- Guides 08 (PART 4 Home, PART 11 "Getting started") and 19 (intro) mention it.
- A step with a check can't be ticked by hand (Q3), refused by the route too. A path's
  "finished" is kept until a step is plainly not done any more, so Home (which can't see the
  steps that ask her database) doesn't flicker.
- Tests: `test/getting-started.test.ts` (every answer, every link, the checks, binding),
  panel.test.ts "getting started", pg.test.ts (0017 back-fill), e2e 36 + phone fit. Asked for by momolig: a "Getting started" block on
Home that opens "What would you like to do?", asks a few questions, recommends a path, tells her to
see guide 19 as well, and remembers how far she has got.

## What momolig decided (2026-09-23)

| # | Decision |
|---|---|
| D1 | It **remembers progress**. |
| D2 | It **stays on Home for good**. She opens and closes it; it remembers which. |
| D3 | It is **reachable from Help** as well. |
| D4 | **Account managers** see it (not accounts kept to one folder). |
| D5 | It is a **questionnaire that helps her decide**, and ends with a recommendation that also says "see guide 19". |
| D6 | The choices put **her own projects first** (blog, pinboard, recipes), then the common ones. |

## G1. Progress is read from the site, not ticked (the general mechanism)

Asked: "how can we enable this in general?" The answer is one idea and three small pieces.

**The idea.** A step is done when the thing it asks for **exists**, not when someone clicks
"done". "Make your own blog" is done when a blog database made from the example is there. "Put
the pinboard on a page" is done when the gate has seen the pinboard form on one of her pages. So
progress can't drift from the truth. If she does it some other way (in HeidiSQL, by hand in
WinSCP, or momolig does it for her), it still ticks. If she deletes the thing, the step comes
undone and says so.

**The three pieces:**

1. **Steps with checks, in code.** A *path* (what the questionnaire recommends) is a list of steps.
   Each step has a title, one line of why, a button to the page that does it, the guide part that
   explains it, and a `check`: a small function that asks the panel's own tables (and the gate's,
   through its admin socket, as other routes already do) whether it is done. A check answers
   `done`, `not yet` or `can't tell right now`. Where a check finds something, it also says
   *which* ("your copy: my_blog on MariaDB").
2. **A little stored state**, only for what the site itself can't say: which paths she started,
   her answers, a step she chose to skip or to tick by hand, and whether the Home block is open.
   One migration (0017).
3. **One API** that works out all of it: `GET /api/getting-started` (paths, steps, results),
   plus small POSTs to start, skip, tick and close.

The same three pieces work for any later checklist ("get Turnstile ready", "move a site over"):
add a path, write its checks. Nothing else changes.

**Steps the site can't check.** A few can't be seen from the panel's tables, like "write your
first post" (that's in her own database) or "tell your friends the address". Those get a check
that asks her database only on the Getting started page (never on Home, so Home stays fast), with
a two-second limit. When there isn't a check at all, the step has an "I've done this" tick. Every
step also has "Skip this".

**Which thing is hers.** A path is linked to what it made, the first time a check finds it.
For example, the first blog database made after she started the "blog" path becomes *the* blog. That
link is stored with the path, so a second database later doesn't confuse it. "That's not the one"
lets her pick another.

### What is stored (migration 0017)

- `panel.started_paths`: id, `path` (key), `answers` (json: what she chose in the questionnaire),
  `links` (json: which database, form, folder or page it found), `started_by`, `started_at`,
  `finished_at` (set when every step is done or skipped), `put_away_at` (she removed it).
- `panel.path_steps`: `started_path_id`, `step` (key), `state` (`skipped` | `done-by-hand`), `by`,
  `at`. There's only a row when she said something; otherwise the check decides.
- `panel.users.getting_started_open` (boolean, default true): the Home block open or closed,
  per account, so it's the same on her phone and her computer.
- `panel.studio_databases.copied_from` (`recipes` | `blog` | `tutorial-journal` |
  `tutorial-todo` | null) and `page` (the page "Make my own" wrote). Today a copy is only an
  activity line (`database-example-copied`, `src/panel/routes/tutorial-examples.ts:351`), which a
  check shouldn't have to parse. 0017 fills both in for copies already made, from those lines,
  and the copy route writes them from then on.

**Shared, not per account.** Paths belong to the website, so both managers see the same progress,
and each path says who started it. Only open/closed is per account.

## G2. The questionnaire

A page of its own, `/getting-started`, one question at a time, with Back. The last screen is
always a recommendation. Nothing is made until she presses "Start this".

**Question 1: What would you like to do?**

- Start a blog
- Put up a pinboard people can pin notes to
- Keep a recipe book
- Let people contact me
- Find out who's coming to something
- Have a guest book
- Keep a page or folder private for certain people
- Put photos, music or documents on my site
- Let people keep their own list (like a to-do list)
- Something else, or I'm not sure

**Then one or two questions for that choice**, only where the answer changes the path:

| Choice | Follow-up questions | What changes |
|---|---|---|
| Blog | Should readers be able to comment? | adds the comments steps |
| Pinboard | Who may pin notes: anyone, or people you know? · Should notes go up at once, or after you've read them? | adds "protect the folder" · picks "Show right away" |
| Recipe book | Should friends be able to send you recipes? | adds the "Share a recipe" form steps |
| Contact | (none) | |
| Who's coming | Anyone, or people you know? | adds "protect the folder" |
| Guest book | Show new entries at once, or after you've read them? | picks "Show right away" |
| Private | (none) | |
| Media | Pictures, music, or documents? | picks the guide 12 part |
| Own lists | HTML and JavaScript, or PHP? | guide 17 or 18 |
| Not sure | the three questions of guide 19 (below) | leads to one of the above, or a general path |

**"Not sure"** asks guide 19's questions in order:

1. Who writes it: visitors, you, or both?
2. Once it's there, will you change it, sort it or tag it?
3. Is it one list, or several kinds of thing that belong together?

This leads to one of five recommendations: *a form*, *a database*, *a database with a form
connected*, *a database people sign in to change*, or *a comment area*. Each has a general
path of its own. Where her answers match one of the named choices (visitors write it once +
shown on a page ⇒ something like the pinboard or guest book), the recommendation says so and
offers that path.

**The recommendation screen** says what it is in one line, why in one sentence (her answers
quoted back to her), and the steps it will take (just their titles). It has two buttons,
**Start this** and **Back**, and always ends with: *"Want the longer explanation first? See
guide 19, Forms or a database?"*, linked to `/help/forms-or-a-database`. Where a guide part
matches her choice exactly, the link goes to that part (for the pinboard, PART 4).

## G3. The paths

Every step's button goes to a page that exists today; no new ways of doing things. Checks are
written as the fact they read.

**Blog** (a database; guide 19 PART 5)
1. Make your own blog from the example. *Database examples, Blog, Make my own.* Done when: a
   database made by "Make my own" from the blog example exists, with its app switched on.
2. Write your first post. *Its posts page.* Done when: its posts table has a record the
   sample records didn't have (asked of her database, on this page only).
3. *(if comments)* Let readers comment. *The posts table's page, "People can comment on these".*
   Done when: that table takes comments.
4. Put the blog on your site. Done when: the page "Make my own" wrote is still there.
5. Read guide 15 (or 16) to make it your own. *I've done this.*

**Pinboard** (a form; guide 19 PART 4)
1. Put the pinboard on your site. *Form examples, Pinboard, Put this on my website.* Done when: a
   pinboard form made after she started exists.
2. Let the page show the notes. *"Anyone can read the approved responses".* Done when: that form's
   approved responses are public.
3. *(if people you know)* Protect its folder. *Protected folders.* Done when: the folder the
   page is in is protected.
4. *(if at once)* Show notes right away. Done when: the form shows new responses right away.
5. Pin the first note, and approve it. Done when: the form has an approved response that isn't
   one of yours from the example.

**Recipe book** (a database, maybe with a form; guide 19 PART 6)
1. Make your own recipe book. Done when: as the blog, from the recipes example.
2. Add a recipe of your own. Done when: a recipe the samples didn't have (this page only).
3. *(if friends send)* Make a "Share a recipe" form. *Forms, New form.* Done when: a form made
   after she started whose name or title has "recipe" in it, or the one she picks.
4. *(if friends send)* Save its answers in the recipe book. Done when: that form saves into the
   recipes table, "When I approve a response".
5. *(if friends send)* Put the form on a page. Done when: the gate has seen it on one of her pages.

**Contact**: make a form (done when one exists, made after she started); put it on a page
(seen on a page); send yourself a test (it has a response).

**Who's coming / Guest book**: the RSVP / guest book example, the same shape as the pinboard.

**Private**: protect a folder (a folder is protected); add a person (it has one); try signing in
(*I've done this*).

**Media**: make a media folder (one exists); put something in it (it has a file); put it on a
page (guide 12, *I've done this*).

**Own lists**: the to-do tutorial example on the panel (set up); guide 17 or 18 (*I've done
this*); a protected folder whose people may change the table (that switch is on).

**The general paths** (from "not sure") are the same steps, without the example: a form (make it,
put it on a page); a database (make it, draw a table, switch the app on, add a record); a database
with a form (both, then connect them); one people change (a database, a protected folder, "People
signed in to a protected folder"); a comment area (make it, put it on a page).

## G4. On Home

- A block called **Getting started**, above the other panels, only for account managers.
- **Closed**, it is one line: what's on the go ("Blog: 2 of 4 done · Pinboard: done") and
  **Start something new**. With nothing started: "What would you like to do? Start here."
- **Open**, it shows each path that isn't finished or put away. Each one shows its steps with a
  tick, a circle, or "skipped", and the next step's button. Finished paths fold into "Done (2)".
- The open/closed toggle is remembered per account (G1).
- Home only runs the quick checks (the panel's and gate's own tables). A step that needs her
  database shows "open to check" on Home and is worked out on the Getting started page.

## G5. On Help

- An entry at the top of the Help tab, **Getting started: what would you like to do?**, which
  goes to `/getting-started`.
- Guide 08 (the control panel) gets a paragraph about the Getting started block. Guide 19's
  intro mentions that the panel can ask these questions for her.

## G6. Tests

- **Every answer leads somewhere.** Walk the whole question tree in a unit test. Every route
  ends in a recommendation. Every recommendation has a path. Every step's button is a real page
  (checked against the web routes). Every guide link names a real guide part (`help.ts` parses
  them).
- **Checks:** each one, against the test Postgres and the fake gate. Not yet, then done, then
  undone again when the thing is deleted. "Can't tell" when her database doesn't answer in time.
- **Linking:** the first matching thing after the start is linked. A second one doesn't take its
  place. "That's not the one" changes it.
- **Storage:** skip, "I've done this", put away. Paths are shared by the two managers. Open/closed
  is kept per account. Accounts kept to one folder get 403, and the route snapshot lists the new
  routes as manager-only.
- **Browser:** answer the pinboard questions, Start this, press "Put this on my website", and
  come back to see the step ticked. On a phone: the Home block opens and closes.

## G7. Size and release

Medium. One release, migration **0017** (so going back means restoring the before-install dump).
Guides 08 and 19 change, and the installer syncs them now. Suggested order:

1. The mechanism: migration 0017, paths and checks, the API, unit tests.
2. The questionnaire page and the recommendation.
3. The Home block and the Help entry.
4. Guide edits, browser tests, `build.sh`.

## Questions for momolig (answered 2026-09-23: "go with your recommendations")

1. **Q1** Shared: paths belong to the website, both managers see the same progress, each says who
   started it; only open/closed is per account.
2. **Q2** A finished path stays under "Done" for good, folded away; "Put away" removes it.
3. **Q3** "I've done this" only on steps the site can't check. Every step keeps "Skip this".
