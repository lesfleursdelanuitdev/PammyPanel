-- Accounts for visitors (docs/accounts-plan.md step 1): the switches, all off,
-- and the columns accounts will need. The areas module's first own migration.
-- Every site gets it; nothing reads the new columns until a later step, and with
-- every switch off the gate behaves exactly as before (A5).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- A5: what visitors may do for themselves, switched on and off by the panel's
-- owners (Users > Settings). One row, every switch off. A switch needs the one
-- named beside it, and the checks refuse a row that says otherwise.
CREATE TABLE gate.visitor_settings (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  emailed_links   boolean NOT NULL DEFAULT false,  -- confirm an address, reset a password, change of address (needs the panel's mail)
  self_register   boolean NOT NULL DEFAULT false,  -- people make their own account (needs emailed_links)
  change_password boolean NOT NULL DEFAULT false,  -- people change their own password
  delete_account  boolean NOT NULL DEFAULT false,  -- people delete their own account
  open_areas      boolean NOT NULL DEFAULT false,  -- "Open with accounts" areas (needs self_register)
  changed_by      text,
  changed_at      bigint,
  CHECK (emailed_links OR NOT self_register),
  CHECK (self_register OR NOT open_areas)
);
INSERT INTO gate.visitor_settings (id) VALUES (1);

-- The account's email address (lower-cased, one account each), when it was
-- confirmed, and whether the person made the account themselves. The owner's
-- people have no email and work as before.
ALTER TABLE gate.visitors
  ADD COLUMN email text CHECK (email IS NULL OR (email = lower(email) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  ADD COLUMN email_confirmed_at bigint CHECK (email_confirmed_at IS NULL OR email IS NOT NULL),
  ADD COLUMN registered boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX visitors_email ON gate.visitors (email) WHERE email IS NOT NULL;

-- What a one-time link is for. Every link so far is a setup link (choose your
-- password), which stays 7 days; confirm 24 h, reset 1 h, email-change 24 h
-- (A6). An email-change link carries the address it confirms.
ALTER TABLE gate.links
  ADD COLUMN purpose text NOT NULL DEFAULT 'setup' CHECK (purpose IN ('setup', 'confirm', 'reset', 'email-change')),
  ADD COLUMN new_email text CHECK (new_email IS NULL OR (new_email = lower(new_email) AND length(new_email) <= 254)),
  ADD CONSTRAINT links_email_change_check CHECK ((purpose = 'email-change') = (new_email IS NOT NULL));
