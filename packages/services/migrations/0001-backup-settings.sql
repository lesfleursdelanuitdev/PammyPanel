-- How long the nightly copies of the Studio's databases are kept (docs/lfdln-mariadb-plan.md B1-B3):
-- Settings > Backups, 7 to 365 days, 60 at first (what lfdln-appdb kept before). The panel prunes
-- every hour through the services helper; the last prune is kept here for the page. Every site
-- gets the table; only a site with the services module on (lfdln) uses it.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
CREATE TABLE panel.backup_settings (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  keep_days   integer NOT NULL DEFAULT 60 CHECK (keep_days BETWEEN 7 AND 365),
  pruned_at   bigint,
  pruned_note text CHECK (length(pruned_note) <= 500)
);
INSERT INTO panel.backup_settings (id) VALUES (1);
