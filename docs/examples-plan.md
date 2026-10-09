# Examples: plan

Status: **built 2026-09-17, release 9b6b528c80c92c79, not installed yet.** Sections 1-12 are
built unless noted below. What was built differently:
- Each example is **three** files, not two: `page.html`, `style.css` and `entries.js`. The
  little program that draws the entries is its own file, so the page stays readable and the
  same file can be copied to her website untouched. Her copy keeps the same shape:
  `guestbook.html` plus `guestbook-files/{style.css,entries.js}`.
- The example pages are **templates** in `public-gate/examples/<kind>/` with two things
  filled in: `@FORM@` (which form) and `@FILES@` (where the two files sit). The gate fills
  them in with the fixture's name for the example; the panel fills them in with HER form's
  name for her copy. One source, two uses.
- The pinboard shows the board **above** the form: the notes are the point of that page.
- No token was needed anywhere (D5), so the gate's example pages carry
  `X-Robots-Tag: noindex` and nothing else new.
- The sitefs op is `install-pages` (`installPages`), which writes any small page/style/script
  the panel hands it, never over something already there.
- `/api/examples` also returns the starters, so the Forms tab's "New form" and the Examples
  tab share one request.
- The menu item is **Form examples** (momolig, 2026-09-17), and each example's own page carries a
  "Make one by hand" card linking to its tutorial. The part number lives with the example
  (`guidePart` in `examples.ts`, on `examples.state`), and gate.test.ts checks it matches the
  tutorial the guide actually holds, so the link can never point at the wrong part.
- Each tutorial also **explains** its files (momolig, 2026-09-17): after each printed file, a
  "How the page / the look / the program works" walkthrough as a definition list. Terms must not
  be raw tags -- `parseRegion` in `src/help.ts` treats an indented block whose left-edge lines
  hold a tag as code, which is right for examples and wrong for a term list.
- Tutorials (momolig, 2026-09-17): one per example rather than one part for the guest book and
  one for the other two. PART 12/13/14 of guide 10 each name the three files and print them in
  full, generated from `public-gate/examples/<kind>/` with her form name filled in, so a
  gate.test.ts check keeps guide and files identical (the same trick guide 09 uses for the
  sign-in looks). Each carries a `Preview:` line, and `PREVIEW_RE` in `web/src/lib/help.tsx`
  now accepts a whole example folder (no `sandbox` for those, or the page could not fetch its
  own answers). Old API/on-purpose parts became 15 and 16.
- Responses (momolig, 2026-09-17, after the install): the examples' entries are IN the list
  with an "example" badge (D9 above), the "Unread only" switch became a **Show** select
  (All / Unread (n) / Read), and each response's buttons moved to a footer bar along the
  bottom of its row (`footer` on `Row`). Home asks for `examples=hide`, so what it says is
  waiting always agrees with the red number.

Open questions Q1-Q4 in section 13 were answered while building: Q1 delete outright (the
dialog says so), Q2 she may toggle them and Reset puts them back, Q3 50, Q4 `guestbook.html`.

Three worked examples of one mechanism -- a form whose approved responses are shown on a
page -- as live, gated pages in the panel, as starters in "New form", as a one-click copy
into her website, and as two new parts of guide 10.

Everything here builds on Forms (`forms-plan.md`, live since 2026-09-17). The capability
already exists: guide 10 PART 11 already says "This is how you make a guest book". What is
missing is the packaging: she must assemble six steps correctly and then style the result
herself.

---

## 1. Goals

- Pamela can **see** a working guest book, RSVP list and pinboard before building one.
- She can **use** them: sign the guest book, approve her own entry, watch it appear. The
  approve loop is the lesson.
- "New form" can start her off with the same questions already set up.
- One button puts a finished, styled page into a folder of her website.
- All three teach that they are the same machine wearing different clothes.

### Not in this version

Turnstile (still separate), drag-to-place notes on the pinboard (the API is read-only, so a
note's position can never be saved), example looks beyond the one shipped style, editing an
example's page inside the panel.

---

## 2. Words used here

| Word | Meaning |
|---|---|
| **Example** | One of the three: guest book, who's coming, pinboard. |
| **Fixture form** | The real form in `gate.db` behind an example. Permanent: cannot be deleted or renamed, only reset. |
| **Example page** | The page the gate serves at `/_pammy/examples/<kind>/`, framed by the panel. |
| **Starter** | A template offered by "New form" that creates an ordinary form of hers. |
| **Her copy** | The page "Put this on my website" writes into one of her folders. |

---

## 3. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | The example is a **starter form plus a documented page** (shape C), not a guide-only walkthrough and not a full wizard. | momolig 2026-09-17 |
| D2 | The public API also finds a form **by name**, so a shipped page needs no form number. | momolig |
| D3 | Three examples: **guest book**, **who's coming (RSVP)**, **pinboard**. | momolig |
| D4 | The live examples live at **`panel.pammy.org/examples/<kind>`**, behind the panel's passkey. | momolig |
| D5 | The page inside the frame is served by the gate at `pammy.org/_pammy/examples/<kind>/` and is therefore **publicly reachable if guessed. That is accepted** -- no token, no signed URL. | momolig |
| D6 | The fixture forms are **permanent fixtures she can only reset**. They are part of the panel and the guide, like the example sign-in looks. | momolig |
| D7 | **"Put this on my website"** is built now, not later: it writes a finished page into a folder she picks. | momolig |
| D8 | Starters offered by "New form": Blank, Contact, Guest book, Who's coming, Pinboard. | from D1/D3 |
| D9 | A fixture form's responses never count towards the unread badge, and are never what Home says is waiting. They ARE in the Responses list, marked "example" (momolig, 2026-09-17, after seeing an empty-looking list). | Claude / momolig |
| D10 | A fixture form keeps at most 50 responses; older ones fall off. A stranger who finds the URL cannot grow `gate.db`. | Claude, follows from D5 |

---

## 4. The three examples

All three use the same loop: `<pammy-form>` collects, she approves, a page reads
`/approved` and draws it. They differ only in questions and markup.

### 4.1 Guest book (`guestbook`)

| Field | Type | Required | Show publicly |
|---|---|---|---|
| Your name | short text | yes | yes |
| Where you're from | short text | no | yes |
| Your message | long text | yes | yes |
| Your email (I won't show it) | email | no | **no** |

Settings: button "Sign the book"; sent words "Thank you for signing. Your message will
appear on the page once Pamela has read it."; "tell them who sent each one" **off** (the
form asks for a name itself).

Display: a list, newest first, `sentAt` shown as "18 September 2026" via
`toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })`.
Empty: "No messages yet -- be the first to sign it." A "More messages" button uses `next`.

Teaches: the whole loop, `textContent`, the honest empty state.

### 4.2 Who's coming (`rsvp`)

| Field | Type | Required | Show publicly |
|---|---|---|---|
| Your name | short text | yes | yes |
| Are you coming? | radio (Yes / No / Maybe) | yes | yes |
| How many of you | number | no | yes |
| Anything I should know | long text | no | **no** |
| Your email | email | no | **no** |

Display: a count from `total` ("14 coming") and the names, read with
`.../approved/filterby/attending/yes`.

Teaches: `filterby`, `total`, and above all that some answers stay private -- allergies and
email addresses are collected but never published.

### 4.3 Pinboard (`pinboard`)

| Field | Type | Required | Show publicly |
|---|---|---|---|
| Your name | short text | yes | yes |
| Your note | long text | yes | yes |
| Colour | radio (Yellow / Pink / Mint / Blue) | yes | yes |

Display: a grid of note cards, each slightly tilted (deterministic from the response id, so
the board does not jump on reload), colour applied through a **lookup map**:

```js
const COLOURS = { Yellow: 'note-yellow', Pink: 'note-pink', Mint: 'note-mint', Blue: 'note-blue' };
note.className = 'note ' + (COLOURS[r.answers.colour] ?? 'note-yellow');
```

Teaches: never build a class name (or any markup) out of a visitor's answer -- the same
lesson as `textContent`, in the second place where it bites. Long notes are clamped by CSS,
not by trusting the length of what was sent.

---

## 5. Fixture forms in `gate.db`

Names: `example-guest-book`, `example-rsvp`, `example-pinboard`. Added by a gate.db
migration; their ids and names are permanent.

- New column `fixture TEXT NULL` on `forms` (the kind: `guestbook` | `rsvp` | `pinboard`),
  `NULL` for every ordinary form.
- A fixture **cannot** be trashed, deleted or renamed. The panel hides those buttons and
  the gate refuses the operations.
- **Duplicate is allowed** and produces an ordinary form: that is exactly "Make me one of
  these".
- Switches ship on: enabled, approvable, publicApproved. Publishing example words written
  by us is not publishing her visitors' words, so no passkey is asked at install.
  She may toggle them (it is a sandbox); **Reset** puts them back.
- Seeded with three or four approved sample responses each, in a warm, plain voice.
- **Reset the example**: restores the questions, settings and switches to factory, deletes
  every response the form has and puts the sample ones back. The confirm dialog says so
  plainly.
- At most 50 responses (D10): a new response past 50 drops the oldest non-sample one.

Responses tab: fixture responses never count towards the red unread number (D9) and appear
only when the "Form" filter is set to that example.

---

## 6. The example pages (gate)

Served like the sign-in looks, from `public-gate/examples/<kind>/`:

```
/_pammy/examples/guestbook/index.html      + guestbook-files/style.css
/_pammy/examples/rsvp/index.html           + rsvp-files/style.css
/_pammy/examples/pinboard/index.html       + pinboard-files/style.css
```

- `EXAMPLE_LOOKS` / `EXAMPLE_FILES` in `src/gate/app.ts` already do exactly this loading;
  it grows a second table for these, or generalises.
- The page is the real thing: `<script src="/_pammy/forms.js" defer>`, a `<pammy-form
  name="example-guest-book">`, and the display block below it.
- Style: Garden's palette, so it sits beside the sign-in looks she already knows.
- `<meta name="robots" content="noindex">` and an `X-Robots-Tag: noindex` header on these
  routes. Unlisted, not advertised (D5).
- Posting is limited by the existing `form-ip` limiter (10 per IP per hour). A stranger's
  entry is unapproved, therefore invisible; Reset clears it; the cap bounds it.

---

## 7. Panel

### 7.1 Addresses and menu

```
/examples             the three cards
/examples/guestbook   live example, the code, two buttons
/examples/rsvp
/examples/pinboard
```

`BrowserRouter`, so these are real paths. A menu entry **Examples** next to Help; Help's
search indexes them and guide 10 links to them.

### 7.2 An example page

- The live example in an iframe of `https://pammy.org/_pammy/examples/<kind>/`.
  `pagePolicy()` already allows `frame-src https://pammy.org` (Help frames the sign-in
  looks). Height by postMessage, **measured from the element, not the document** -- the
  form-preview gotcha, and no `sandbox` without `allow-same-origin`.
- Under it, the exact code, with Copy. It is the same code guide 10 prints.
- Two buttons:
  - **Make me one of these** -- creates an ordinary form from the starter and opens the
    builder.
  - **Put this on my website** -- section 8.
- On a phone: frame full width, code collapsed behind "Show the code".

### 7.3 New form

Instead of going straight to an empty builder, a list: Blank, Contact, Guest book, Who's
coming, Pinboard -- each a line with one sentence. A starter creates the form with its
questions, keys, "Show publicly" ticks, wording and the **on** and **can be approved**
switches set. "Anyone can read the approved responses" stays **off**: it publishes her
visitors' words and asks for a passkey, so it must be her own deliberate click. The card
shows a one-line nudge until she does it.

Suggested names: `guest-book`, `whos-coming`, `pinboard`, `-2` if taken.

---

## 8. "Put this on my website" (D7)

1. She picks a folder (the Media folder picker) and a page name -- default
   `guestbook.html`, `whos-coming.html`, `pinboard.html`.
2. If she has no form of that kind yet, it creates one from the starter at the same time,
   and says which name it used.
3. New sitefs op `installExample(folder, kind, formName, pageName)`, beside `protectDir`,
   which already writes pages into a folder. Writes:
   - `<page>.html` -- her markup, the `<pammy-form name="...">` tag and a commented,
     readable display script. Deliberately visible, so what she reads in the guide is what
     is in the file.
   - `<page>-files/style.css` -- the look, matching the `login-files/style.css` convention.
   - Never overwrites: `flag: 'wx'`, returns the list of what it created, and says so if a
     name was taken.
   - Links inside the page are relative (the folder rule of guide 06).
4. Afterwards the panel shows: the page's address, the one switch still to turn on (with
   the passkey), and -- if the folder is protected -- a note that only signed-in visitors
   will see it.

---

## 9. API: by name (D2)

```
GET /_pammy/api/forms/by-name/guest-book/approved?order=desc&limit=20
GET /_pammy/api/forms/by-name/guest-book/approved/filterby/attending/yes
```

- `by-name` cannot collide with an id (ids match `^[1-9][0-9]*$`), so the new routes sit
  beside the numeric ones; those are unchanged, and guide 10 PART 12 stays as it is.
- Identical rules: without a key, only a form that is approvable **and** publicApproved
  answers; anything else gives the same `no-key` 401 a missing form gives, so form names
  cannot be probed. A trashed form behaves as missing. Keys work here too, subject to the
  same per-form allow list.
- The card's **"Show approved answers"** button emits the by-name form -- `guest-book`
  reads better than `12`, and it is copy-paste safe.

---

## 10. Security and privacy checklist

- Every value drawn from a response goes in with `textContent`; the examples never use
  `innerHTML`, and the guide says why in both places.
- The pinboard's colour goes through a lookup map, never into a class name directly.
- Email and "anything I should know" are collected but not public in the shipped starters;
  `PRIVATE_BY_DEFAULT` already covers email and phone.
- Nothing unapproved, trashed, or unticked is ever published; the page a response came from
  is only shown to a key.
- Example pages are `noindex`, rate-limited, capped at 50 responses, and resettable.
- `panel.db` is untouched. All of this lives in `gate.db` and on her site.

---

## 11. What changes elsewhere

| File | Change |
|---|---|
| `src/gate/forms.ts` | `fixture` column + migration, fixture rules (no delete/rename/trash), seed and reset, the 50 cap |
| `src/gate/app.ts` | `by-name` routes, example page serving, `noindex` header |
| `public-gate/examples/<kind>/` | three pages + three style files |
| `src/sitefs/ops.ts` | `installExample` |
| `src/app.ts` | `/api/examples/*` (install, reset), starter definitions |
| `web/src/pages/Examples.tsx` | new; plus New-form starters in `Forms.tsx`, menu, Home, Help index |
| `forms-guide.txt` | a tutorial per example: PART 12 guest book, PART 13 who's coming, PART 14 pinboard, each printing its three files word for word (Copy buttons in Help) and previewing the live page; old 12-13 become 15-16 |
| `control-panel-guide.txt` | the Examples tab in the tour |
| `verify-panel.sh`, e2e | the three examples load, submit, approve and appear; install-into-a-folder round trip |

`help.test.ts` pins PART 3 and PART 5 of guide 10, so shifting parts below 11 is safe.

---

## 12. Build order

1. `by-name` API + the card's code block (small, useful on its own).
2. `fixture` column, migration, seeds, reset, cap.
3. The three gate example pages.
4. The panel's Examples section.
5. Starters in New form.
6. "Put this on my website" (sitefs op + the flow).
7. Guide 10 PARTs 12-13, guide 08's tour, tests, verify.

---

## 13. Questions

- **Q1** Reset: delete the added responses outright, or move them to the Responses trash for
  30 days? (Recommended: delete outright -- they are examples, and the dialog says so.)
- **Q2** May she toggle a fixture's three switches, with Reset putting them back
  (recommended), or are they locked on?
- **Q3** Is 50 the right cap per fixture, and should anything be said when it trims?
- **Q4** Page names for her copies: `guestbook.html` or `guest-book.html`?
