# Field order: Pamela puts the fields of an app's form in the order she wants

Status: **built 2026-09-22, not installed** (with docs/form-to-database-plan.md, one release).
momolig said "go": Q1 one order, Q2/Q4 later, Q3 drag as well as buttons -- as suggested.

As built: migration 0011 (`field_order` is JSON **text**, not `text[]`: the panel's Postgres
layer takes no array parameters, and every other list it keeps is JSON text). The route is
`POST /api/databases/:engine/:name/app/:table/order`. Drag is plain HTML drag-and-drop on a
computer (no new library); Up/Down are 44px on a phone. Found by the browser test: "Put back
the table's order" first sent the hidden fields as an order, so it never went back -- fixed
(an empty list is sent). Guide 14 PART 12 "The order of the form".

---

Original status: **plan only, 2026-09-22.** Asked for by momolig ("Pamela also should be able to reorder
the fields on her input form for the app"). No code yet. *(Claude)* marks a suggestion waiting
for momolig's yes; Q1-Q4 at the end are open.

## What is being asked

The "new" and "change" forms of a generated app (`web/src/pages/AppRecord.tsx`) show a table's
fields in one fixed order. She wants to choose that order: Title first, then the post itself,
then the date, whatever reads best for her, without touching the table.

That is a Resource setting (what the form *means*), not a schema change: the columns in the
database stay where they are. The product plan always had it -- `studio_fields.form_order`
exists since migration 0008 and `resourceViews` already sorts by it -- but nothing lets her set it.

## What is there today, and a bug it hides

- `FieldView.formOrder` = the stored `form_order`, or the column's position when nothing is
  stored. The form, the list's columns, the record picker's facts and the catalog all follow it.
- There is **no way to set it**: `checkFieldPatch` has no `formOrder`, and no page offers it.
- **The bug:** changing *anything* about a field (its label, help, "In the list"...) stores a
  row for it, and a new row's `form_order` defaults to **0**. Every field she has touched
  therefore jumps to the top of the form, tied with the others she touched, in no particular
  order. It is live now: the blog example's new-post form shows Address, Summary, Body,
  Created at, Updated at, Author, **then** Title (the example set options on seven of its
  fields, not on Title). Her own apps get the same the moment she renames a field.

## What she gets

On a thing's own page (PART 12 of guide 14), a new section **"The form"**:

```text
 The form                                        [ Preview the form ]
 ┌──────────────────────────────────────────────────────────────────┐
 │ ⠿  Title                 One line            [↑] [↓]              │
 │ ⠿  Address               One line            [↑] [↓]              │
 │ ⠿  Body                  Rich text           [↑] [↓]              │
 │ ⠿  Author                Pick a related …    [↑] [↓]              │
 │ ⠿  Topics                Pick several        [↑] [↓]              │  <- a many-to-many too
 │ ⠿  Published             A tick box          [↑] [↓]              │
 │    Created at            hidden              (not on the form)    │
 └──────────────────────────────────────────────────────────────────┘
```

- **Up / Down buttons** on every row: work with a mouse, a keyboard and a finger, and on a
  screen reader ("Move Body up: now 2 of 6"). On a computer she can also **drag** a row by its
  handle.
- The order is saved **as she changes it**, like every other setting on that page.
- Hidden fields and the key are listed below, greyed, "not on the form" -- so the list is the
  whole table, but only what is shown can be moved.
- **"Put back the table's order"** undoes it.

## Decisions

| # | Decision | Source |
|---|---|---|
| O1 | The order is **per thing** (table) and is a Resource setting: the database is never changed, and it needs no Review / Apply. | momolig ("on her input form") / *(Claude)* |
| O2 | **One list of names** kept on the thing -- `studio_resources.field_order text[]` -- instead of a number on each field. A number per field is what produced the bug above; a list says the whole order at once, and saving it is one write. | Claude |
| O3 | **Until she orders a table, it keeps the table's own column order**, whatever is stored per field today. This repairs the bug for every existing app without guessing (no page ever let her set an order, so every stored `form_order` is an accident). `studio_fields.form_order` stops being read; it is dropped in a later migration. | Claude |
| O4 | What is not in the list goes **after** it, in column order: a field added later on the canvas turns up at the end of her form rather than somewhere she did not choose. A name in the list that is no longer a column is ignored (and removed on the next save). | Claude |
| O5 | **Renames keep their place:** renaming a field or a table on the canvas carries the name in the list (`carryRenames` already moves the per-field rows; it moves this list too). | Claude |
| O6 | **A many-to-many is in the order too** ("Topics"), under its connection's name, so it no longer always sits at the bottom. | Claude |
| O7 | The same order is used **everywhere she sees the fields**: the form, the list's columns, the facts under a record in the picker, and the API's catalog. (See Q1 for a separate list order.) | Claude |
| O8 | The route takes the **whole order** (`POST .../app/:table/order { order: [...] }`), checked against the table: every name a real field or many-to-many of it, none twice. Up/Down send the whole new order too, so two quick moves can never interleave into a third order. The catalog is re-pushed (`refreshCatalog`), as for every other setting. | Claude |
| O9 | The **database examples** set an order that reads well (title first), so they stop showing the bug. | Claude |

## Pieces

- **Migration 0011:** `studio_resources.field_order text[] NOT NULL DEFAULT '{}'`.
- **`src/studio/resources.ts`:** `resourceViews` orders by `field_order` (O3, O4, O6);
  `checkOrder(view, body)`; `ResourceView.fieldOrder` and a `many` entry's place.
- **`src/studio/resource-store.ts`:** `saveOrder`, and `carryRenames` updates the list (O5).
- **`src/app.ts`:** the order route (O8); "Start again" (forget) clears it.
- **`web/src/pages/DatabaseResource.tsx`:** the section; Up/Down; drag on a computer (plain
  pointer events -- no new library -- or dnd-kit if momolig prefers, Q3); announcements.
- **`web/src/pages/AppRecord.tsx`:** many-to-many fields take their place in the order.
- **Guide 14 PART 12:** "The form: putting the fields in order".

## Tests

- Unit: the order is applied; names missing go after in column order; unknown names ignored; a
  stored `form_order` no longer matters (the bug); a rename keeps the place; the check refuses
  a name twice or a field of another table.
- Panel: set an order, the form and the list follow; the catalog is re-pushed; "Start again"
  clears it; a table without an order shows the column order even when fields have saved rows.
- Browser: Up/Down with a mouse and with the keyboard; drag on a computer; on a phone the buttons
  are 44px and the page does not scroll sideways; the blog example's form starts with Title.

## Open questions

- **Q1.** One order for the form **and** the list's columns, or two? *(Claude: one. The list
  already has "In the list" to leave fields out; a second order is a second thing to keep
  right. If she wants the list different later, it can be added.)*
- **Q2.** Headings or sections inside the form ("About the post", "Publishing")? *(Claude: not
  now -- a Resource extra for later, like the Forms builder's Heading item.)*
- **Q3.** Drag and drop on a computer as well as the buttons? *(Claude: yes, with the buttons
  kept as the way that always works, on a phone above all.)*
- **Q4.** Half-width fields side by side (two short fields on one row), as the Forms builder
  has? *(Claude: later, with Q2.)*
