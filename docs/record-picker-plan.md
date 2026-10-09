# Record picker: choosing a connected record by what it is, not by its id

Status: **built 2026-09-21, not installed.** Asked for by momolig 2026-09-21 ("we should not have
to manually type in the id"); momolig took every *(Claude)* suggestion and Q1-Q3 as suggested.
What was built differently or found on the way:
- The labels code moved out of the gate into `src/studio/connect.ts` (`linksOf`), used by the
  data API and the panel's pages alike. Panel answers carry them beside the record as `links`
  (and `connections` says which field is which), never mixed into the values a form sends back.
- The list is **always open** under the box (as asked), not a dropdown; picking puts a chip at the
  top of the box.
- Facts under a row say what they are: a yes is the field's name ("Vegetarian"), a number
  carries its label ("Servings: 4").
- **Bug fixed**: the "Change" form turned a yes/no into text, so a tick box always opened as
  *no* -- and saving the form quietly made it no.
- `ResourceField` gained `required` (a connection that may be empty gets its x).

## The problem

In a generated app (docs/databases-plan.md 11.8), a field that points at another table -- an
ingredient's recipe, a recipe's cook, a post's author -- is a plain text box that wants the
other record's **id**, with the hint "Which recipes this belongs to, by its id"
(`web/src/pages/AppRecord.tsx`, control `picker`, which the code itself says is not built yet).
Nobody knows that recipe 12 is the lemon drizzle loaf.

Three more gaps come with it:

- **Lists show the id too.** The ingredients list says `Recipe: 12`.
- **Many-to-many cannot be set at all** from the app: a recipe's tags live in `recipe_tags`, a
  connecting table the app does not show, so there is nowhere to tick them.
- **Nothing in the app filters by field.** The list route has accepted `filters` since slice 8
  (`listQuery`, `src/studio/records.ts`), but no page offers them.

## What she gets

A **record picker** wherever a field points at another table, in every app:

```text
 Recipe
 ┌──────────────────────────────────────────── ✕ ┐
 │ lemon                                           │   <- type to narrow
 ├─────────────────────────────────────────────────┤
 │ + Filter by field   [Cook: Olivia ✕] [Vegetarian: yes ✕]
 ├─────────────────────────────────────────────────┤
 │ Lemon drizzle loaf                              │   <- the other table's title field
 │   Olivia · 45 min · baking, dessert, summer     │   <- its "In the list" fields
 │ Lemon and poppy seed muffins                    │
 │   Olivia · 25 min · baking                      │
 │   …                                             │   fixed height, scrolls, loads more
 └─────────────────────────────────────────────────┘
```

- The search box, the filter row and the list are **one control**, the list directly under the
  box, fixed height, scrolling. Picking a row shows its name in the box -- never the id.
- **Many-to-many** gets the same picker with ticks: a recipe's **Tags** is a field on the
  recipe's form, the chosen ones shown as removable chips above the list.
- **Lists show names**, not ids, for every connection, and a recipe's tags as a short list.

## Decisions

| # | Decision | Source |
|---|---|---|
| R1 | Every field that points at another table uses the picker, in every generated app: the "new" form, the "change" form, and wherever else a record is filled in. No setting to turn it off. | momolig |
| R2 | The search box **filters as she types** (a short pause, then one request), across the other table's **searchable** fields -- the same ones its own list searches. | momolig |
| R3 | The list sits **directly below the box, joined to it**, **fixed height (about 8 rows), scrolling**. Before she types, it lists every record, in the other table's own sort order. | momolig |
| R4 | Each row shows **enough to tell records apart**: the other table's title field in bold, and under it the fields ticked **"In the list"** on that table's app settings (up to 4), connections as names. What shows is hers to change, on the page she already uses for it, rather than something the picker decides. | momolig / how *(Claude)* |
| R5 | **Filter by field, several at once**, all of them applying together (AND), shown as removable chips: "Cook: Olivia", "Vegetarian: yes", "Minutes: under 30". The fields offered are the other table's **shown** fields that can sensibly be filtered: yes/no (yes / no), a connection (its own small picker), a number or date (from / to), short text (contains). Long text is left out. | momolig / which *(Claude)* |
| R6 | **Many-to-many too**: for each many-to-many connection, the form gets a field named after the other table ("Tags"), with the same picker and filters, choosing several. Saving the record saves its choices. | momolig |
| R7 | The search and filters run **in the database**, 20 at a time, and the list loads the next 20 as she scrolls. A table of 5,000 recipes must work as well as one of 8. | Claude |
| R8 | Only what the app already lets her see: the other table must be **switched on** in the app with "Look at them" on, and only its **shown** fields are searched, filtered or displayed. When it is not, the field falls back to the id box, with a line saying which table to switch on. | Claude |
| R9 | A field that can be left empty has a **✕ to clear it**; a required one does not. When "change" opens, the box shows the current record's name. | Claude |
| R10 | Keyboard: **↓ ↑** move through the list, **Enter** picks, **Esc** closes it, **Tab** leaves. The list is a proper listbox for screen readers (`combobox` + `listbox`, the chosen row announced). Works by touch on a phone, where the list opens under the box and the page scrolls to keep both in view. | Claude |
| R11 | **Lists show names** for connections (and a many-to-many as up to three names, "and 2 more"), using the same `{ id, label }` answers the data API already gives (docs/db-examples-plan.md X7) -- one way of working labels out, not two. | Claude |
| R12 | Saving a many-to-many is **one step in the database**: a new helper op, `set-links`, replaces a record's pairs in the connecting table inside one transaction (Postgres; on MariaDB InnoDB, also one transaction), so a failure leaves the old choices, never half of the new ones. It runs after the record itself is saved; if it fails, the page says the record was saved and the choices were not. | Claude |
| R13 | Changing a many-to-many needs the record's **"Change them"** ability (or "Add new ones", on the new form). The connecting table does not have to be switched on in the app; the panel writes its pairs only through `set-links`, and only for a connection the drawing really has. | Claude |

## How it works

### Panel routes (all behind the Resource window, `src/studio/records.ts`)

```text
GET  /api/app/:engine/:name/:table/pick/:field
       ?search=lemon&filters=[...]&page=2
     -> { items: [{ id, label, facts: ["Olivia", "45 min", ...] }], total, fields: [...filterable] }
     :field is a reference field of :table, or the name of a many-to-many (R6)

POST /api/app/:engine/:name/:table/new    and   .../save
     body grows { links: { tags: [3, 7, 9] } } beside { values }
```

`pick` works out the other table's Resource, refuses as R8 says, and reuses `listQuery` with the
filters R5 allows -- so the rule for what may be read is still written once.

`one` (open a record) and the list route add `{ id, label }` for each connection and an array
for each many-to-many, the way the data API does.

### The helper

- `set-links { table: <junction>, here, id, there, ids }` -- delete the record's pairs that are
  not in `ids`, insert the missing ones, one transaction. Names checked like every other op.
- `list-rows` already has the `in` filter (added for the data API), which is how labels for a page
  of connections are one statement.

### The front end

One component, `RecordPicker`, used for a single connection and (with `many`) for a
many-to-many. It owns the search box, the filter row, the joined scrolling list, keyboard and
screen-reader behaviour. `AppRecord.tsx` uses it for every `picker` field and every many-to-many;
`AppRecords.tsx` shows the names.

## Phases

1. **Names instead of ids** in lists and on "change" (R11) -- small, and useful on its own.
2. **The single picker** (R1-R5, R7-R10), the `pick` route, the component, e2e on the recipe
   book's ingredients.
3. **Many-to-many** (R6, R12, R13) -- `set-links` on both real engines, the form field, e2e on a
   recipe's tags.
4. **Guide 14**: PART 13 (the app's pages) says how to choose a connected record and filter;
   PART 16 (the examples) says "add an ingredient: pick its recipe".

## Tests

- Unit: the `pick` route never reads a hidden field, never filters on one, and refuses a table
  that is not switched on; filters are ANDed; paging is stable.
- Real engines: `set-links` on Postgres and MariaDB, including a failure half way leaving the old
  pairs.
- Panel: an ingredient saved with a picked recipe; a recipe's tags replaced; a record whose
  connection points at a hidden table falls back to the id box.
- Browser: type "lemon", filter by cook, pick with the keyboard, save; the list shows the name;
  tick three tags, untick one, save, reopen.

## Open questions

- **Q1.** Filters on the app's **own lists** too? The same filter row would fit above every list
  page, and the list route already supports it. *(Claude: yes, as a small phase 5 -- it is the
  same component.)*
- **Q2.** **"Add a new one" from inside the picker**, when the recipe she wants is not there
  yet? *(Claude: not in this version -- it means a form inside a form. The picker says "Not
  there? Add it on the Recipes page", with a link that opens in a new tab.)*
- **Q3.** How many fields under each row: up to **4** of the "In the list" fields? *(Claude: 4 on
  a computer, 2 on a phone.)*
