-- docs/catalog-plan.md step 5: apps as sources. A service switched on is one source per
-- kind of thing its pammy-panel.json's `catalog` section offers (kind 'app', ref
-- "<service>/<resource>"), each with its scope '/' right under All, as a Studio table's;
-- a resource's sub-scopes (its `scopes` field: exam prep's sections) are automatic scopes
-- below that. An app's items are of the kind it names.
ALTER TABLE catalog.sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE catalog.sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('files', 'studio', 'app'));
ALTER TABLE catalog.items DROP CONSTRAINT items_kind_check;
ALTER TABLE catalog.items ADD CONSTRAINT items_kind_check CHECK (kind ~ '^[a-z][a-z0-9-]{0,31}$');

-- what the manifest said of the resource, as last read (S5-1): where its list is, where an
-- item opens, the field naming an item's sub-scope, what its labels mean to it, and what
-- its visitors may do (step 6)
ALTER TABLE catalog.resources
  ADD COLUMN list_path          text CHECK (list_path IS NULL OR (length(list_path) BETWEEN 1 AND 200 AND left(list_path, 1) = '/')),
  ADD COLUMN open_url           text CHECK (open_url IS NULL OR length(open_url) <= 500),
  ADD COLUMN scopes_field       text CHECK (scopes_field IS NULL OR length(scopes_field) <= 40),
  ADD COLUMN uses               jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN visitor_labels     text NOT NULL DEFAULT 'none' CHECK (visitor_labels IN ('none', 'personal', 'shared', 'both')),
  ADD COLUMN visitor_new_labels boolean NOT NULL DEFAULT false;
