-- The order of the fields on an app's form (docs/field-order-plan.md).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- O2: one list of names for the whole table, as JSON text like every other
-- list the panel keeps ('["title","body","many:topics"]'). '[]' means she has
-- not ordered it, and the table's own column order holds (O3) -- which is also
-- what makes studio_fields.form_order stop mattering: no page ever set it, and
-- a new row's 0 put every field she had touched at the top of the form.
ALTER TABLE panel.studio_resources ADD COLUMN field_order text NOT NULL DEFAULT '[]'
  CHECK (field_order LIKE '[%]' AND length(field_order) <= 20000);
