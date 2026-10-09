-- First steps (docs/phase9-plan.md 9-3): the card on lfdln's Home. Whether a step is done is
-- read from the panel where it can be (two passkeys); kept here is only what it can't see:
-- "I've read it" for the guide to read first, and "I'm done with this" for the card.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
CREATE TABLE panel.first_steps (
  user_id   bigint PRIMARY KEY REFERENCES panel.users (id) ON DELETE CASCADE,
  read_at   bigint,   -- ticked "I've read it"
  hidden_at bigint    -- "I'm done with this"; brought back from Help
);
