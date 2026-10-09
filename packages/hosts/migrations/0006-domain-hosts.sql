-- Hosts on another domain (docs/domains-hosts-plan.md step 7): gonsalvesfamily.com's "@"
-- and admin beside lesfleursdelanuit.com's "@". A host's name is one per domain now,
-- not one on the whole site.
--
-- And a certificate for named hosts only (7-1): cert 'names', with the names it covers
-- (the domain itself, or one label under it). Such a domain has no catch-all, and a host
-- whose names aren't all on the list is refused (the routing helper checks it again).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

ALTER TABLE panel.hosts DROP CONSTRAINT hosts_name_key;
-- (a host always has a domain once the home one is seeded: the trigger in 0004 sees to it)
ALTER TABLE panel.hosts ADD CONSTRAINT hosts_domain_name_key UNIQUE (domain_id, name);

ALTER TABLE panel.domains DROP CONSTRAINT domains_cert_check;
ALTER TABLE panel.domains ADD CONSTRAINT domains_cert_check CHECK (cert IN ('wildcard-dns', 'per-host', 'cloudflare-origin', 'files', 'names'));
ALTER TABLE panel.domains ADD COLUMN cert_names text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cert_names) <= 50);
ALTER TABLE panel.domains ADD CONSTRAINT domains_names_cert_check CHECK ((cert = 'names') = (cardinality(cert_names) > 0));
