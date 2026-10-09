-- docs/catalog-plan.md step 4b: the gate's copy of her tagged tables' labels, for the data
-- API (the gate can't read the catalog). Written only by the panel, a whole table at a time
-- (the admin op record-labels.put); one row per label on a record.
CREATE TABLE gate.record_labels (
  database_id bigint NOT NULL,
  table_name  text NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 4096),
  kind        text NOT NULL CHECK (kind IN ('tag', 'category')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 40 AND name !~ '[^a-z0-9-]'),
  public      boolean NOT NULL,
  PRIMARY KEY (database_id, table_name, key, kind, name)
);
CREATE INDEX record_labels_name ON gate.record_labels (database_id, table_name, kind, name);
