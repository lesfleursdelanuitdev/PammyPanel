-- Accounts on a route (docs/roles-plan.md step 5, S5-3): the gate keeps the
-- area, its role set and its people; the route keeps the area's token, so the
-- routing helper renders nginx from this table alone. A token the gate doesn't
-- know is refused by the gate (403): it fails closed.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
ALTER TABLE panel.routes ADD COLUMN area_token text UNIQUE CHECK (area_token IS NULL OR area_token ~ '^[A-Za-z0-9_-]{32}$');
-- which built-in set the area was made with, for the Hosts page: 'open' (Open
-- with accounts) or 'private' (Only people let in)
ALTER TABLE panel.routes ADD COLUMN accounts text CHECK (accounts IS NULL OR accounts IN ('open', 'private'));
ALTER TABLE panel.routes ADD CONSTRAINT routes_accounts_check2 CHECK ((area_token IS NULL) = (accounts IS NULL));
