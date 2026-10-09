-- docs/catalog-plan.md step 3b (P1): a place is a website folder ("/olivia") or an installed
-- software's files ("software:blog"), which File Explorer shows as a root of its own.
ALTER TABLE panel.user_places DROP CONSTRAINT user_places_place_check;
ALTER TABLE panel.user_places ADD CONSTRAINT user_places_place_check CHECK (
  (place ~ '^/[^/\\[:cntrl:]]{1,200}$' AND place !~ '^/\.')
  OR place ~ '^software:[a-z0-9][a-z0-9-]{0,39}$'
);
