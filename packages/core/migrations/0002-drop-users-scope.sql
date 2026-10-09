-- users.scope goes (docs/permissions-plan.md R9, step 4). panel.user_places has
-- said where each person is kept since core 0001; nothing has read scope since
-- then, and step 3 kept it written only so the release before could still run.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- Refuse rather than lose anything: every scope still written must be one of that
-- person's places. (Step 3 wrote the first place; core 0001 copied the rest.)
DO $$
DECLARE lost text;
BEGIN
  SELECT string_agg(u.username || ' ' || u.scope, ', ') INTO lost
    FROM panel.users u
   WHERE u.scope IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM panel.user_places p WHERE p.user_id = u.id AND p.place = u.scope);
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'users.scope says a place user_places does not have: %', lost;
  END IF;
END $$;

ALTER TABLE panel.users DROP COLUMN scope;
