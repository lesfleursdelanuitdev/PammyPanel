-- docs/catalog-plan.md step 4: Studio tables as sources. A table she switches on is a
-- source of kind 'studio' (ref: the Studio's own id for the table, which a rename keeps),
-- its records are items of kind 'records', and its scope sits right under All.
ALTER TABLE catalog.sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE catalog.sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('files', 'studio'));
ALTER TABLE catalog.items DROP CONSTRAINT items_kind_check;
ALTER TABLE catalog.items ADD CONSTRAINT items_kind_check CHECK (kind IN ('images', 'files', 'audio', 'video', 'pages', 'records', 'other'));

-- A source and everything that is its: its labels first (a label's scope is RESTRICT, and
-- the links go with the labels), then its items (their scopes are RESTRICT too), then the
-- source (its resources and scopes go with it). Labels at All only lose these links.
CREATE FUNCTION catalog.drop_source(source bigint) RETURNS integer LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  DELETE FROM catalog.labels WHERE scope_id IN (SELECT id FROM catalog.scopes WHERE source_id = source);
  DELETE FROM catalog.items WHERE resource_id IN (SELECT id FROM catalog.resources WHERE source_id = source);
  DELETE FROM catalog.sources WHERE id = source;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

