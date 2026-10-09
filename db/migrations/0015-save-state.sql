-- How a copy into one of her tables ended (docs/refactor-plan.md phase 2, W2).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
--
-- Until now the state had to be read from three columns at once (saved_to,
-- save_problem, save_retry), and the paths that gave up half way left them
-- saying whatever they said before. One column says it plainly, and every try
-- ends by writing it (src/gate/saves/queue.ts, settle()):
--
--   waiting   nothing to do yet -- not connected, or waiting for her OK
--   saved     it is in her table
--   problem   it cannot be saved, and will not be tried again by itself
--   retrying  it will be tried again on its own (her database was asleep)
--   unsure    the database took the write and then went quiet: it may be there
--             already, so nothing is retried by itself (B3)
ALTER TABLE gate.response_saves ADD COLUMN save_state text NOT NULL DEFAULT 'waiting'
  CHECK (save_state IN ('waiting', 'saved', 'problem', 'retrying', 'unsure'));

-- W3: the retry queue takes the oldest try first, so a row that keeps failing
-- cannot starve everything newer behind it.
ALTER TABLE gate.response_saves ADD COLUMN save_tried_at bigint;

-- What the rows already there mean, in the same order settle() decides it: a
-- comment can be saved and still have something left to do (B1).
UPDATE gate.response_saves SET save_state =
  CASE WHEN save_retry                THEN 'retrying'
       WHEN saved_to IS NOT NULL      THEN 'saved'
       WHEN save_problem IS NOT NULL  THEN 'problem'
       ELSE 'waiting' END;

DROP INDEX gate.response_saves_retry;
CREATE INDEX response_saves_retry ON gate.response_saves(save_tried_at, response_id) WHERE save_retry;
