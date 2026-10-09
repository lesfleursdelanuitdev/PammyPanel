-- Comments (docs/comments-plan.md): a comment area is a form, and a comment is a
-- response with a thread -- what it is about.
--
-- The site has no users yet (amendments, section 0), so the tables carried over
-- from SQLite take the new columns; test/pg.test.ts lists them as coming after
-- the port.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- C1: an ordinary form, or a comment area
ALTER TABLE gate.forms ADD COLUMN kind text NOT NULL DEFAULT 'form' CHECK (kind IN ('form', 'comments'));
-- C4: what an area's comments are about -- 'page' (her website's pages), or the
-- name of a table of one of her apps (docs/comments-plan.md C8-C10)
ALTER TABLE gate.forms ADD COLUMN content_type text NOT NULL DEFAULT 'page'
  CHECK (content_type = 'page' OR content_type ~ '^[a-z][a-z0-9_]{0,62}$');

-- the thread: a page's file (C5, amendments) or a record's id
ALTER TABLE gate.responses ADD COLUMN content_type text;
ALTER TABLE gate.responses ADD COLUMN content_id text CHECK (content_id IS NULL OR length(content_id) BETWEEN 1 AND 300);
CREATE INDEX responses_thread ON gate.responses(form_id, content_type, content_id, approved_at);

-- A1, A2: a comment area's copy in one of her apps is its own kind of link --
-- it finds or makes the thread, and follows approval both ways -- where a
-- form's link writes one row once (docs/form-to-database-plan.md).
ALTER TABLE gate.form_links ADD COLUMN mode text NOT NULL DEFAULT 'row' CHECK (mode IN ('row', 'comments'));
