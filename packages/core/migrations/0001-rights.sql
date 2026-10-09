-- Rights and places, per person (docs/permissions-plan.md R4, R5, R8): the core's
-- first own migration. db/migrations (0001-0018) is the closed baseline.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- R4: a row means the person has that part of the panel; no row, they don't.
-- Account managers (admins) have none: they need none. Which names exist is the
-- code's list (core/panel/rights.ts), so a module that brings a new right needs
-- no migration; the check only keeps out what could never be a name.
CREATE TABLE panel.user_rights (
  user_id bigint NOT NULL REFERENCES panel.users (id) ON DELETE CASCADE,
  name    text   NOT NULL CHECK (name ~ '^[a-z][a-z-]{0,39}$'),
  PRIMARY KEY (user_id, name)
);

-- R5: what the person is kept to. On pammy.org a place is a top-level folder of
-- her website ("/recipes"), the way users.scope spelled it. No rows: the whole site.
CREATE TABLE panel.user_places (
  user_id bigint NOT NULL REFERENCES panel.users (id) ON DELETE CASCADE,
  place   text   NOT NULL CHECK (place ~ '^/[^/\\[:cntrl:]]{1,200}$' AND place !~ '^/\.'),
  PRIMARY KEY (user_id, place)
);

-- R8: today's accounts, written the new way, so each reaches exactly what it did.
-- Members who see everything: what members have always reached.
INSERT INTO panel.user_rights (user_id, name)
SELECT u.id, r.name
  FROM panel.users u
 CROSS JOIN unnest(ARRAY['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected']) AS r(name)
 WHERE u.role = 'member' AND u.scope IS NULL;

-- Members kept to one folder: the parts that know about folders, and that folder.
INSERT INTO panel.user_rights (user_id, name)
SELECT u.id, r.name
  FROM panel.users u
 CROSS JOIN unnest(ARRAY['files', 'media', 'forms', 'responses', 'comments']) AS r(name)
 WHERE u.role = 'member' AND u.scope IS NOT NULL;

INSERT INTO panel.user_places (user_id, place)
SELECT id, scope FROM panel.users WHERE role = 'member' AND scope IS NOT NULL;

-- users.scope stays, still written beside user_places, so going back to the
-- release before this one needs no restore (R9). It is dropped in a later release.
