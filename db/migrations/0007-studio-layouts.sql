-- Where she put the rectangles (docs/studio-plan.md "draft is one JSON
-- document": positions live BESIDE the draft, not inside it).
--
-- Kept apart from `studio_drafts` on purpose. A draft is what she wants the
-- database to BE, and throwing it away means "go back to what the database
-- really has". Where she dragged a table to is not part of that wish and must
-- survive Discard -- otherwise tidying up her drawing would cost her the layout
-- she had arranged, which is not what "throw these changes away" says.
--
-- It is also not the database's business: nothing here is ever applied, and a
-- table that only exists in the draft can have a position just as well as one
-- the engine already has. That is why the key is the table NAME rather than
-- anything from the engine.
--
-- One row per database, holding every rectangle as one document, for the same
-- reason the draft is one document: two surfaces (the canvas and the Tables
-- list) edit one thing, and dragging a table is not worth a row each.
--
-- S9, until 2026-09-26: like 0004-0006, the only reference is to
-- `studio_databases`, which is not a ported table, so a rollback and re-port
-- can still empty panel/media/gate (src/port.ts:241).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

CREATE TABLE panel.studio_layouts (
  -- one layout per database; it goes when the panel stops looking after it
  database_id bigint PRIMARY KEY REFERENCES panel.studio_databases (id) ON DELETE CASCADE,
  -- { "tables": { "<table name>": { "x": <number>, "y": <number> } } }
  -- (src/studio/layout.ts checkLayout). Names, not ids: a table she has drawn
  -- but not applied has no id on the engine yet.
  layout_json text   NOT NULL,
  updated_at  bigint NOT NULL,
  updated_by  text   NOT NULL DEFAULT ''
);
