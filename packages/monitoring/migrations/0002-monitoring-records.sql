-- Monitoring step 2 (docs/monitoring-plan.md): the DNS records watched (the mail
-- records, the nameservers), as they were when first read. A record that reads
-- otherwise later is down, "changed", until an admin keeps it as it is now (the row
-- goes, and the next reading is kept).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

CREATE TABLE panel.monitor_baseline (
  key   text   PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{1,40}$'),
  value text   NOT NULL CHECK (length(value) <= 4000),
  since bigint NOT NULL
);
