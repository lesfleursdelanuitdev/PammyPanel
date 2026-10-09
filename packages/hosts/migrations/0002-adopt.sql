-- Taking in what already runs (docs/adopt-plan.md V2-V4): the domain itself as a
-- host ("@", with www beside it), routes to a service, and a folder route's
-- headers and forever-cached paths. The rules here say again what names.ts says;
-- the renderer checks everything once more before it writes a file.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- "@" is the domain itself; only taking over the hand-written file makes it, and
-- www is only ever beside it (with_www), never a host of its own. adopted: it was
-- served before the panel took it over (it can't be deleted from the panel, D2).
ALTER TABLE panel.hosts DROP CONSTRAINT hosts_name_check;
ALTER TABLE panel.hosts ADD CONSTRAINT hosts_name_check CHECK (name = '@' OR name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE panel.hosts ADD COLUMN with_www boolean NOT NULL DEFAULT false;
ALTER TABLE panel.hosts ADD CONSTRAINT hosts_with_www_check CHECK (NOT with_www OR name = '@');
ALTER TABLE panel.hosts ADD COLUMN adopted boolean NOT NULL DEFAULT false;

-- A service route names a service and one of its parts, as the services helper's
-- record has them; the port comes from that record, never from here.
ALTER TABLE panel.routes DROP CONSTRAINT routes_kind_check;
ALTER TABLE panel.routes ADD CONSTRAINT routes_kind_check CHECK (kind IN ('folder', 'redirect', 'service'));
ALTER TABLE panel.routes ADD COLUMN service text CHECK (service IS NULL OR service ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$');
ALTER TABLE panel.routes ADD COLUMN service_part text CHECK (service_part IS NULL OR service_part ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$');
-- a service route: websockets, the largest upload (MB; null: nginx's 1), and the
-- sign-in addresses that get the sign-in rate limit ("/a/b" or "=/a/b")
ALTER TABLE panel.routes ADD COLUMN websockets boolean NOT NULL DEFAULT true;
ALTER TABLE panel.routes ADD COLUMN max_body_mb integer CHECK (max_body_mb IS NULL OR max_body_mb BETWEEN 1 AND 1024);
ALTER TABLE panel.routes ADD COLUMN sign_in_paths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(sign_in_paths) <= 50);
-- a folder route: response headers ([{name, value}]) and paths cached for good
ALTER TABLE panel.routes ADD COLUMN headers jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(headers) = 'array');
ALTER TABLE panel.routes ADD COLUMN cache_forever text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cache_forever) <= 50);
ALTER TABLE panel.routes DROP CONSTRAINT routes_check;
ALTER TABLE panel.routes ADD CONSTRAINT routes_check CHECK (
     (kind = 'folder'   AND folder_id IS NOT NULL AND redirect_to IS NULL AND service IS NULL)
  OR (kind = 'redirect' AND folder_id IS NULL AND redirect_to IS NOT NULL AND redirect_status IS NOT NULL AND service IS NULL)
  OR (kind = 'service'  AND folder_id IS NULL AND redirect_to IS NULL AND service IS NOT NULL AND service_part IS NOT NULL));
