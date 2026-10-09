-- "People signed in to a protected folder can change these" (docs/tutorials-plan.md V1-V3).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- V1, V3: the gate's area id of the protected folder whose signed-in people may
-- do what the thing's switches allow, with no key. By id, so moving the folder
-- keeps it; the gate refuses an id it no longer has. NULL: nobody.
ALTER TABLE panel.studio_resources ADD COLUMN visitor_area bigint CHECK (visitor_area IS NULL OR visitor_area > 0);
-- V2: each person only reaches the rows where this text field is their
-- username. '' means they all share every row.
ALTER TABLE panel.studio_resources ADD COLUMN visitor_owner text NOT NULL DEFAULT ''
  CHECK (visitor_owner = '' OR visitor_owner ~ '^[a-z][a-z0-9_]{0,62}$');

-- The tutorial examples (docs/tutorial-examples-plan.md): two more databases the
-- panel owns and resets, like the database examples (0010's X2).
ALTER TABLE panel.studio_databases DROP CONSTRAINT studio_databases_example_check;
ALTER TABLE panel.studio_databases ADD CONSTRAINT studio_databases_example_check
  CHECK (example IS NULL OR example IN ('recipes', 'blog', 'tutorial-journal', 'tutorial-todo'));
