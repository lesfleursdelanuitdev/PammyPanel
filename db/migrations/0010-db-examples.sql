-- Database examples and "Anyone can read these" (docs/db-examples-plan.md).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- X1: anyone may read this table through the data API, without a key -- only
-- while the app is on and reading is switched on, only the exposed fields.
ALTER TABLE panel.studio_resources ADD COLUMN public_read boolean NOT NULL DEFAULT false;
-- X12: and only the rows where this yes/no field is yes. '' means every row.
ALTER TABLE panel.studio_resources ADD COLUMN public_only text NOT NULL DEFAULT ''
  CHECK (public_only = '' OR public_only ~ '^[a-z][a-z0-9_]{0,62}$');

-- X2: which example a database is, if it is one. The panel made it, owns it,
-- and puts it back on Reset; she cannot delete, rename or switch it off.
ALTER TABLE panel.studio_databases ADD COLUMN example text
  CHECK (example IS NULL OR example IN ('recipes', 'blog'));
CREATE UNIQUE INDEX studio_databases_example ON panel.studio_databases (example) WHERE example IS NOT NULL;
