-- Hosts, routes and site folders (docs/hosts-plan.md H1): lfdln's subdomains. A
-- host is a name, a route sends a path on it to a target, and a site folder is a
-- folder of static files made on purpose (platform plan F1). Every site gets the
-- tables (packages' migrations all run); only a site with the hosts module on
-- (lfdln) writes to them.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- One label under the site's domain ("tutor" for tutor.lesfleursdelanuit.com):
-- other domains need certificates of their own (phase 7). The same rule as the
-- routing helper's (packages/hosts/src/names.ts): a DNS label, never www.
CREATE TABLE panel.hosts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text    NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  enabled    boolean NOT NULL DEFAULT true,
  created_by text,
  created_at bigint  NOT NULL
);

-- A folder of static files (and PHP pages when run_php is on) under the site
-- folders' root; its name is its folder on disk. adopted: it was there before the
-- panel (it can't be deleted from the panel, platform plan D2).
CREATE TABLE panel.site_folders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text    NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  run_php    boolean NOT NULL DEFAULT true,
  adopted    boolean NOT NULL DEFAULT false,
  created_by text,
  created_at bigint  NOT NULL
);

-- A path on a host ("/" or "/docs/") and what it shows. In phase 4 a site folder
-- or a redirect (Q2); services, software and database apps come with their
-- phases, so the kinds are only these for now.
CREATE TABLE panel.routes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id     bigint  NOT NULL REFERENCES panel.hosts (id) ON DELETE CASCADE,
  path        text    NOT NULL CHECK (path ~ '^/([A-Za-z0-9_~-][A-Za-z0-9._~-]*/)*$' AND path !~ '/\.'),
  kind        text    NOT NULL CHECK (kind IN ('folder', 'redirect')),
  folder_id   bigint  REFERENCES panel.site_folders (id) ON DELETE RESTRICT,
  -- a folder route: an unknown path serves index.html (client-side routers)
  spa         boolean NOT NULL DEFAULT false,
  -- a redirect: where to, 301 or 302, and whether the rest of the path goes along
  redirect_to     text CHECK (redirect_to IS NULL OR length(redirect_to) <= 500),
  redirect_status integer CHECK (redirect_status IS NULL OR redirect_status IN (301, 302)),
  keep_path       boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  bigint  NOT NULL,
  UNIQUE (host_id, path),
  CHECK ((kind = 'folder' AND folder_id IS NOT NULL AND redirect_to IS NULL)
      OR (kind = 'redirect' AND folder_id IS NULL AND redirect_to IS NOT NULL AND redirect_status IS NOT NULL))
);
CREATE INDEX routes_folder ON panel.routes (folder_id);
