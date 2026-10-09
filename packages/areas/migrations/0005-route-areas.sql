-- Areas on routes (docs/roles-plan.md step 5, S5-1 and S5-2): a route on one of
-- the site's hosts can have accounts, as a folder can. The route itself is the
-- hosts module's (panel.routes); the gate keeps the area, its role set and its
-- people, and the route keeps the area's token (hosts/0003).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- kind: a folder of her website (as every area so far) or a route. A route
-- area's path is '/route/<route id>': a folder's never starts with '/'
-- (cleanAreaPath), so no folder lookup can ever find it. route_id: no foreign
-- key, since the gate's role can't read the panel's tables. label: the route's
-- address, for the panel's lists.
ALTER TABLE gate.areas ADD COLUMN kind text NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder', 'route'));
ALTER TABLE gate.areas ADD COLUMN route_id bigint UNIQUE;
ALTER TABLE gate.areas ADD COLUMN label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 300);
ALTER TABLE gate.areas ADD CONSTRAINT areas_kind_check2 CHECK (
     (kind = 'folder' AND route_id IS NULL AND path !~ '^/')
  OR (kind = 'route' AND route_id IS NOT NULL AND path = '/route/' || route_id));

-- The built-in set "Open with accounts": anyone may open the pages, and the app
-- is told who is signed in. Everyone signed in counts as Member.
INSERT INTO gate.role_sets (key, label, built_in, created_at)
  VALUES ('open-with-accounts', 'Open with accounts', true, extract(epoch FROM now())::bigint);
INSERT INTO gate.roles (role_set_id, key, label, slot)
  SELECT id, 'not-signed-in', 'Not signed in', 'not-signed-in' FROM gate.role_sets WHERE key = 'open-with-accounts';
INSERT INTO gate.roles (role_set_id, key, label)
  SELECT id, 'member', 'Member' FROM gate.role_sets WHERE key = 'open-with-accounts';
INSERT INTO gate.role_privileges (role_id, privilege)
  SELECT r.id, 'pages.read' FROM gate.roles r JOIN gate.role_sets s ON s.id = r.role_set_id
  WHERE s.key = 'open-with-accounts';
UPDATE gate.role_sets s SET signed_in_role_id = r.id
  FROM gate.roles r WHERE r.role_set_id = s.id AND s.key = 'open-with-accounts' AND r.key = 'member';
