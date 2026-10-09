-- The panel's email notices (docs/apps-plan.md phase 3, M3): what the account
-- managers want to be told about, and how far the panel has looked. One row.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
--
-- Where the emails go and who they come from are not here: those are the mail
-- service's settings (/etc/pammy-mail, written by the software helper), and the
-- key is only ever there.
CREATE TABLE panel.mail_notices (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  forms         text NOT NULL DEFAULT '[]',    -- JSON: ids of forms whose new responses she is told about
  comment_areas text NOT NULL DEFAULT '[]',    -- JSON: ids of comment areas whose comments waiting for her OK she is told about
  requests      boolean NOT NULL DEFAULT false, -- new requests to open a protected folder
  -- the last response and request the panel has looked at (gate ids); null until
  -- the first look, which only notes where things stand and sends nothing
  seen_response bigint,
  seen_request  bigint,
  last_sent_at  bigint,
  last_problem  text,                          -- in her words, shown on the Email page
  last_problem_at bigint,
  changed_by    text,
  changed_at    bigint
);
INSERT INTO panel.mail_notices (id) VALUES (1);
