# Forms into a database: a form Pamela made in Forms puts its answers in one of her tables

Status: **built 2026-09-22, not installed** (one release with docs/field-order-plan.md).
momolig said "go": Q1 when-I-approve by default, Q2 offered once, Q5/Q7 no -- as suggested.
**Not built yet:** Q3/Q4 (choices from a table, many-to-many), Q6 ("Make a table for this
form"), and Apply's impact list naming the forms a step would stop (the table's own page does
say "Filled in by").

As built -- what differs from the plan, and what was found:
- **The catalog is the check, not a second copy.** The gate checks every row against the
  pushed catalog (which now carries each column's kind: `types`). So there is no
  `panel.studio_form_links`: the link lives only in `gate.form_links` (migration 0012), and
  switching off, hiding or renaming a field stops a form's writes with no extra hooks. Saving a
  link re-pushes the catalog first (older catalogs have no `types` and refuse form writes).
- Pieces: `src/studio/form-links.ts` (fits, linkProblems, buildValues, checkLinkShape,
  suggestPairs -- shared), `src/gate/form-links.ts` (saveLink, saveResponse, retrySaves every
  15 min in main.ts, saveEarlier), admin ops `formlink.*`, `response.save-again`, panel routes
  `/api/forms/:id/database[...]`, `/api/responses/:id/save-again`,
  `/api/databases/:engine/:name/form-links`; page `web/src/pages/FormDatabase.tsx`
  (`/forms/:id/database`); Responses line + Try again; the builder's "Connect to a database"
  and a warning before deleting a paired question; the table page's "Filled in by".
- **Found by test:** a visitor's long answer containing `<b>` became bold in a rich-text field
  (safe, but wrong) -- form answers now always go in as plain paragraphs. A whole name joined
  with commas ("Olivia, Rose") -- names now join with spaces. `/forms/:id/database` was not in
  PAGE_PATHS, so a refresh on it was a 404. The builder's new button also matched "Save".
- **Also fixed on the way:** the database helper now puts the table's own refusals in her
  words on both engines (already taken, has to be filled in, points at nothing, too long, not
  the right kind) -- the app's own forms showed the engine's text before.
- Guide 10 PART 17 and a troubleshooting entry; guide 14 PART 13 "Filled in by a form".

---

Original status: **plan only, 2026-09-22.** Asked for by momolig ("Pamela should be able to connect a
Form that she made in Forms to a database"). No code yet. *(Claude)* marks a suggestion
waiting for momolig's yes; Q1-Q7 at the end are open.

## What is being asked

Today the two halves of the panel do not meet:

- **Forms** (docs/forms-plan.md): she builds a form, puts `<pammy-form name="...">` on any
  page, and visitors' answers wait in **Responses** (the gate's own tables). She reads,
  approves, trashes them; programs read them through the responses API.
- **Databases** (docs/studio-plan.md): her own MariaDB and Postgres, tables she drew, an app to
  add and change records, and the data API.

She wants a form to **fill in a table**: a "Join the mailing list" form adds a row to
`subscribers`; an RSVP form adds a row to `guests`; a "Share a recipe" form adds a recipe,
which then appears on the recipe book page. Each answer goes into a field of the table she
chooses. The form stays exactly as it is -- same builder, same `<pammy-form>`, same spam
protection -- it just has somewhere else to send its answers as well.

## What she gets

In the form builder's settings (next to "Responses can be approved"), a new part,
**"Save answers in a database"**:

```text
 Save answers in a database                                   [ on ]
   Database   [ Recipe book (recipes) ▾ ]      Table   [ Recipes ▾ ]
   When       (•) When I approve a response   ( ) As soon as it arrives

   Question                    goes into
   Your name                   [ Cook: by name ▾ ]      <- a connection, matched by name (Q3)
   Recipe name                 [ Title ▾ ]
   What you need               [ Method ▾ ]             (rich text: kept as paragraphs)
   How many people             [ Servings ▾ ]
   Email address               [ — not saved — ▾ ]      (private: never put in a table unless she says)

   Fields with no question
   Vegetarian                  [ fixed: No ▾ ]
   Shared                      [ fixed: No ▾ ]          <- so it is not on the public page yet
   ✓ Every field the table needs is filled in.
```

- Picking a table **suggests** the pairs (same name, or a type that fits) and she changes them.
- Each response in **Responses** says where it went: "Saved in Recipes as *Lemon drizzle
  loaf*" with a link to the record, or "Not saved in Recipes yet: *Title can't be empty* --
  [Try again]".
- On the table's app page and the canvas: "Filled in by the form *Share a recipe*", so she
  knows before she renames or deletes a field it depends on.

## Decisions

| # | Decision | Source |
|---|---|---|
| F1 | **The response is always kept in Responses as well.** The database gets a *copy*. Nothing a visitor sends can be lost because a database was asleep, a field was renamed, or a value did not fit. | Claude |
| F2 | **One table per form**, chosen from her managed databases (not the examples'), and the table must be **in the app with "Add new ones" on** -- the same window the app's own pages and the data API use. What the app would not let her add by hand, a form cannot add either. | Claude |
| F3 | **When:** "When I approve a response" (only on a form whose responses can be approved) or "As soon as it arrives". *(Claude: the first by default -- a form is open to anyone on the internet, and approving is her spam filter before anything reaches a table that may be public.)* With "Show right away" on, "when I approve" means as it arrives -- the builder says so. | Claude / Q1 |
| F4 | **A pair is question -> field**, by the question's **key**, which never changes once saved (forms D19). Renaming a question's label keeps its pair. Deleting a question removes its pair, and the builder warns first if the table needs that field. | Claude |
| F5 | **Which questions fit which fields** (checked when she saves, and again when a row is written): short answer, email, phone, website, drop-down, one choice, hidden -> text; long answer -> text or rich text (as paragraphs, through the rich-text cleaner); number, stars, scale -> number (whole or decimal); date -> date; time -> time; tick box -> yes/no; several choices -> text ("a, b, c") or a many-to-many (Q4); name and address -> **one field per part** she picks (first name, last name / street, town, postcode...), or the whole as one line of text. Layout items collect nothing and are not offered. | Claude |
| F6 | **Fixed values** for fields no question fills: a yes/no, a number, a line of text, a day -- or "when it was sent" (a date-and-time field) and "the page it was sent from". *(e.g. Shared = No, so a shared recipe waits for her before the public page shows it.)* | Claude |
| F7 | **The link cannot be saved half-right**: every field the table requires that has no default must have a question that is itself required, or a fixed value. Otherwise the builder says which field is missing, in her words, before anything is switched on. | Claude |
| F8 | **Private answers stay private**: email, phone, address and hidden questions are private by default in Forms (6.1). Pairing one with a field is allowed, but the builder says when that table is readable by anyone ("Anyone can read these" is on for Recipes, so Email would be public") and asks her to confirm. | Claude |
| F9 | **Who writes it: the gate**, as for the data API. It already holds the responses and may use the database helper; it may not read the panel's tables. So the panel **pushes** the finished link (form, database, table, pairs, fixed values, when) to the gate, the way it pushes a catalog -- checked by the panel against the schema and the Resource, executed by the gate exactly as pushed. | Claude |
| F10 | **A write that fails is kept and said**, never retried blindly forever: the response is marked "not saved yet" with the helper's words ("Title can't be empty", "That name is taken", "The database is asleep"). A sleeping database is tried again on its own (every 15 minutes, for a day); a refusal waits for her "Try again" after she has fixed the cause. | Claude |
| F11 | **Once only**: a response is written at most once (the record it made is stored with it). Approving, un-approving and approving again do not make a second row. Trashing a response does not delete the row; the record is hers now. | Claude |
| F15 | **When her database takes a write and then goes quiet, the panel says so rather than guessing** (added 2026-09-22, docs/refactor-plan.md phase 2, B3). Row mode cannot ask "is it there?" without risking a second row, so the response is left *unsure*: Responses says "It may already be in Recipes: look there before you press Try again", and nothing is retried on its own. A comment's copy is different -- one row per response -- so that one simply is tried again. | Claude |
| F12 | **Switching off means switching off**: turning the link off, deactivating or un-managing the app, dropping the table, or turning "Add new ones" off stops writes at once (the gate's copy is dropped, like a catalog). Responses keep arriving in Responses; nothing is written until it is back. | Claude |
| F13 | **The spam guards stay in front**: the form's own limits (10 an hour per visitor, the honeypot, the 64 KB limit, the unread cap) run before any row is written, exactly as now. | Claude |
| F14 | Form **examples** (guest book, RSVP, pinboard) cannot be linked -- anyone can send to them. Accounts kept to one folder cannot set up a link (the Database Manager is the account manager's alone), but their form keeps working if the manager linked it. | Claude |

## How it works

### Data

- Gate: `gate.form_links (form_id PK, database_id, engine, name, table, pairs jsonb, fixed
  jsonb, write_when, pushed_at)` -- the pushed link (F9).
- Gate: `responses` gains `saved_to jsonb` (`{ table, key: {...}, label, at }`) and
  `save_problem text`, `save_tries int` (F10, F11), and since 2026-09-22 `save_state text`
  (waiting / saved / problem / retrying / unsure) and `save_tried_at` -- how the last try ended
  and when, written by `src/gate/saves/queue.ts` and nothing else (refactor-plan phase 2, W2).
- Panel: `panel.studio_form_links` -- what she set, to show and change; re-pushed from the
  same eight places a catalog is (activate, deactivate, field change, Apply, un-manage...).

### Writing a row

1. A response arrives (or is approved, F3) -> the gate looks up `form_links` for the form.
2. It builds the values from the stored answers (`StoredAnswer[]`, already cleaned by
   `cleanAnswers`) with the pairs and fixed values: parts of a name/address, "a, b, c" for
   several choices, long answers through `asRich` for a rich-text field.
3. `insert-row` through the helper, `back` = the key and the title field, **after** the
   response itself is committed (F1).
4. Store `saved_to` or `save_problem` on the response.

### The panel

- `web/src/components/form-settings.tsx`: the "Save answers in a database" part; its own route
  `GET/POST /api/forms/:id/database` returning the pairs, what each field needs, suggestions,
  and whether the link is complete (F7).
- Responses: the "Saved in ... / Not saved yet ... Try again" line.
- The thing's page and the canvas: "Filled in by the form ...". Apply's impact list
  (`src/studio/impact.ts`) says "the form *Share a recipe* writes Title; renaming it stops that
  form saving" for a step that touches a paired field.
- Guide 10 (Forms): a part on it. Guide 14 PART 13/14: a line each.

## Phases

1. **The link and the check** (F2, F4-F8): data, routes, builder part, no writing yet.
2. **Writing** (F1, F3, F9-F13): the gate's writer, marks on responses, retry and Try again.
3. **Telling her** (Responses line, the app page, Apply's impact list, guides).
4. **Connections** (Q3, Q4), if momolig wants them in the first version.

## Tests

- Unit: every question type into every field type it may go into (and refused into the rest);
  name/address parts; fixed values; F7's check; building values from stored answers.
- Gate: a response makes one row; approving twice makes one row; a refused row is marked with
  the helper's words and the response is intact; a sleeping database is retried; a link
  switched off writes nothing; spam refused before any write.
- Real engines: rows written on Postgres and MariaDB, a unique field refusing a second one.
- Browser: set up "Share a recipe" -> Recipes, send it from a page, approve it, see the recipe
  in the app and on the recipe book page; break it by renaming Title and see the Responses line.

## Open questions

- **Q1.** "When I approve" by default, or "As soon as it arrives"? *(Claude: when I approve,
  for any table that anyone can read; as soon as it arrives is still one click away.)*
- **Q2.** When she links a form that already has responses, **copy the ones already there**
  too? *(Claude: offer it once, "Also save the 12 approved responses already here", off by
  default.)*
- **Q3.** A question that picks **a record of a connected table** -- "Your name" -> the Cook
  whose name matches, or a drop-down whose choices *are* the cooks? *(Claude: the second is the
  better idea -- "Choices from a table" on a drop-down, kept up to date from the database --
  but it is its own piece of work; not in the first version.)*
- **Q4.** "Several choices" into a **many-to-many** (a recipe's tags), matched by name?
  *(Claude: with Q3, later.)*
- **Q5.** More than one table per form (a guest **and** their dietary needs in a second table)?
  *(Claude: no -- one table, one row, per response.)*
- **Q6.** The other way round: **"Make a table for this form"** -- the panel draws a new table
  with a field for each question, for her to Review and Apply? *(Claude: yes, as a small phase
  after the first; it is the easiest way to start.)*
- **Q7.** Should a change to the **record** ever flow back to the response? *(Claude: no -- one
  way only. The response is what was sent; the record is hers to change.)*
