-- Domains as data (docs/domains-hosts-plan.md step 1, parts 1 and 2): a domain is a
-- name the panel hands out addresses under, with its settings -- who keeps its DNS,
-- what is in front of it, its certificate, whether a wildcard record sends every new
-- name here, and whether every top-level folder is a host of its own. Until now these
-- were the site's profile (code); the installer seeds the site's own domain from it
-- (the "home" one, lfdln-panel seed-domain), and the routing helper renders from the
-- row from then on. Every site gets the table; only a site with the hosts module on
-- (lfdln) writes to it.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

CREATE TABLE panel.domains (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- lesfleursdelanuit.com: two or more DNS labels, lowercase
  name            text    NOT NULL UNIQUE CHECK (length(name) <= 253 AND name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  -- the site's own domain, from its profile: its name can't change, and there is one
  home            boolean NOT NULL DEFAULT false,
  -- who keeps its DNS: a provider whose zone the server can read (the names with a
  -- record of their own are refused as hosts), or somewhere else (no zone check)
  dns             text    NOT NULL CHECK (dns IN ('cloudflare', 'dreamhost', 'manual')),
  -- what stands in front of nginx: Cloudflare's proxy (its real-IP rules), or nothing
  front           text    NOT NULL CHECK (front IN ('cloudflare', 'direct')),
  -- the certificate: a wildcard by DNS-01, one per host, Cloudflare's origin
  -- certificate, or files already on the server; tls is where it is, as nginx reads it
  -- ({cert, key, include?: [...], dhparam?}; the routing helper checks every path)
  cert            text    NOT NULL CHECK (cert IN ('wildcard-dns', 'per-host', 'cloudflare-origin', 'files')),
  tls             jsonb   NOT NULL CHECK (jsonb_typeof(tls) = 'object' AND tls ? 'cert' AND tls ? 'key'),
  -- a `*` record points every name here, so a new host needs no DNS change
  wildcard_record boolean NOT NULL DEFAULT false,
  -- every top-level folder is a host of its own (pammy.org's way; the profile's folderSubdomains)
  folder_hosts    boolean NOT NULL DEFAULT false,
  -- the last reading of its zone: when, and whether it could be read
  zone_checked_at bigint,
  zone_readable   boolean,
  created_by      text,
  created_at      bigint  NOT NULL
);
CREATE UNIQUE INDEX domains_one_home ON panel.domains (home) WHERE home;

-- A host is on a domain, and says where it came from: made by hand on the Hosts page,
-- made with its site folder (it goes when the folder goes), or taken over from a
-- hand-written nginx file (adopted, which also says so).
ALTER TABLE panel.hosts ADD COLUMN domain_id bigint REFERENCES panel.domains (id) ON DELETE RESTRICT;
ALTER TABLE panel.hosts ADD COLUMN origin text NOT NULL DEFAULT 'hand' CHECK (origin IN ('hand', 'folder', 'adopted'));
CREATE INDEX hosts_domain ON panel.hosts (domain_id);
UPDATE panel.hosts SET origin = 'adopted' WHERE adopted;
UPDATE panel.hosts h SET origin = 'folder'
  WHERE NOT h.adopted AND EXISTS (
    SELECT 1 FROM panel.routes r JOIN panel.site_folders f ON f.id = r.folder_id
     WHERE r.host_id = h.id AND r.path = '/' AND f.name = h.name);

-- A host made without a domain is on the home domain (the installer's seed puts the
-- hosts already there on it too). Nothing to do before the home domain is seeded.
CREATE FUNCTION panel.hosts_home_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.domain_id IS NULL THEN
    NEW.domain_id := (SELECT id FROM panel.domains WHERE home);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hosts_home_domain BEFORE INSERT ON panel.hosts
  FOR EACH ROW EXECUTE FUNCTION panel.hosts_home_domain();
