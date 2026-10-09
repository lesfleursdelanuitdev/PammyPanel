-- Target kinds as a registry (docs/domains-hosts-plan.md step 2, part 3 and D-4): a
-- route names its target's kind and keeps what that kind needs in one place, instead
-- of a column per kind. The kinds are the modules' own (folder and redirect: hosts;
-- service: services; later software, database apps, projects), and each checks its
-- own fields -- here, and again in the routing helper before anything reaches nginx.
--
-- A folder route keeps folder_id, the one reference the database itself must hold
-- (a site folder can't be deleted while a route shows it). Everything else a kind
-- needs moves into target_ref, as the routing helper's table has always named it:
--   folder:   {spa, headers, cacheForever}
--   redirect: {to, status, keepPath}
--   service:  {service, part, websockets, maxBodyMb, signInPaths}
-- Accounts (area_token, accounts) stay the route's: any kind that shows something
-- can have them.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

ALTER TABLE panel.routes RENAME COLUMN kind TO target_kind;
ALTER TABLE panel.routes ADD COLUMN target_ref jsonb NOT NULL DEFAULT '{}';

UPDATE panel.routes SET target_ref = CASE target_kind
  WHEN 'folder'   THEN jsonb_build_object('spa', spa, 'headers', headers, 'cacheForever', to_jsonb(cache_forever))
  WHEN 'redirect' THEN jsonb_build_object('to', redirect_to, 'status', redirect_status, 'keepPath', keep_path)
  WHEN 'service'  THEN jsonb_build_object('service', service, 'part', service_part, 'websockets', websockets,
                                          'maxBodyMb', max_body_mb, 'signInPaths', to_jsonb(sign_in_paths))
END;

ALTER TABLE panel.routes DROP CONSTRAINT routes_check;
ALTER TABLE panel.routes DROP CONSTRAINT routes_kind_check;
ALTER TABLE panel.routes
  DROP COLUMN spa, DROP COLUMN redirect_to, DROP COLUMN redirect_status, DROP COLUMN keep_path,
  DROP COLUMN service, DROP COLUMN service_part, DROP COLUMN websockets, DROP COLUMN max_body_mb,
  DROP COLUMN sign_in_paths, DROP COLUMN headers, DROP COLUMN cache_forever;

-- a kind is a word; its fields an object of a sensible size; a folder route and only a
-- folder route names its folder
ALTER TABLE panel.routes ADD CONSTRAINT routes_target_kind_check CHECK (target_kind ~ '^[a-z][a-z-]{0,30}[a-z]$');
ALTER TABLE panel.routes ADD CONSTRAINT routes_target_ref_check CHECK (jsonb_typeof(target_ref) = 'object' AND octet_length(target_ref::text) <= 16384);
ALTER TABLE panel.routes ADD CONSTRAINT routes_folder_check CHECK ((target_kind = 'folder') = (folder_id IS NOT NULL));
ALTER TABLE panel.routes ALTER COLUMN target_ref DROP DEFAULT;
