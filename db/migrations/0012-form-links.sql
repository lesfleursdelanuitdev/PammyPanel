-- Forms into a database (docs/form-to-database-plan.md): a form whose answers
-- also go into one of her tables.
--
-- In the GATE's schema, like the catalog: the gate holds the responses and is
-- the one that writes the rows, through the database helper. The panel checks a
-- link against her tables and pushes it here; the gate then checks every row it
-- writes against the pushed catalog as well, so a table switched off, a field
-- hidden or renamed, stops the writes by itself (F12).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

CREATE TABLE gate.form_links (
  form_id     bigint PRIMARY KEY REFERENCES gate.forms(id) ON DELETE CASCADE,
  -- the panel's id for the database, carried as a plain number (as in
  -- gate.studio_catalog: the gate cannot follow a key into panel.*)
  database_id bigint NOT NULL,
  engine      text NOT NULL CHECK (engine IN ('postgres', 'mariadb')),
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  table_name  text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- F3: when she approves a response, or as soon as it arrives
  write_when  text NOT NULL CHECK (write_when IN ('approved', 'arrived')),
  -- JSON: [{key, part?, field}] and [{field, value? | from?}] (src/studio/form-links.ts)
  pairs       text NOT NULL,
  fixed       text NOT NULL,
  -- her switch: off keeps the link, and writes nothing
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  bigint NOT NULL,
  updated_by  text
);
CREATE INDEX form_links_database ON gate.form_links(database_id);

-- F10, F11: where a response went, or why it has not gone yet -- one row per
-- response that a link has tried to save. Its own table rather than more
-- columns on gate.responses, which is one of the tables ported from SQLite and
-- stays exactly that shape (test/pg.test.ts compares it with the baseline).
-- A response is written at most once: saved_to is set in the same statement
-- that ends a try, and a claim stops two tries running at once.
CREATE TABLE gate.response_saves (
  response_id     bigint PRIMARY KEY REFERENCES gate.responses(id) ON DELETE CASCADE,
  saved_to        text,                           -- JSON {engine, name, table, plural, key, label, at}
  save_problem    text,                           -- in her words
  save_retry      boolean NOT NULL DEFAULT false, -- tried again on its own (the database was asleep)
  save_tries      bigint NOT NULL DEFAULT 0,
  save_claimed_at bigint                          -- a try in progress
);
CREATE INDEX response_saves_retry ON gate.response_saves(save_retry) WHERE save_retry;
