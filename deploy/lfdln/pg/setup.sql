-- lfdln-pg: the database, its roles and who may do what (docs/lfdln-standup-plan.md Q2),
-- as pammy.org's deploy/pg/setup.sql. The gate's role signs in since accounts step 3
-- (lfdln-gate, docs/accounts-plan.md).
-- Run by install-pg.sh as the superuser inside the container. Safe to re-run:
-- it makes what's missing and puts every right back to what's written here.
-- Passwords come from the podman secrets, read inside psql, never on a command line.
\set ON_ERROR_STOP on
\set owner_pw `cat /run/secrets/lfdln-pg-owner`
\set panel_pw `cat /run/secrets/lfdln-pg-panel`
\set gate_pw `cat /run/secrets/lfdln-pg-gate`

SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY['pammy_owner', 'pammy_panel', 'pammy_gate']) r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- owner: owns the schemas and runs migrations; only the installer uses it
ALTER ROLE pammy_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 5 PASSWORD :'owner_pw';
-- one role per process; no rights on each other's schemas
ALTER ROLE pammy_panel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
    CONNECTION LIMIT 10 PASSWORD :'panel_pw';
ALTER ROLE pammy_gate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
    CONNECTION LIMIT 10 PASSWORD :'gate_pw';
-- the gate answers nginx on every request: nothing of its may hang
ALTER ROLE pammy_gate SET statement_timeout = '2s';
ALTER ROLE pammy_gate SET lock_timeout = '1s';
ALTER ROLE pammy_panel SET statement_timeout = '15s';
ALTER ROLE pammy_panel SET lock_timeout = '5s';

-- C.UTF-8 from Postgres itself (builtin provider): sorts by code point like SQLite's
-- BINARY did, and an image update can never change the order under an index
SELECT 'CREATE DATABASE lfdln OWNER pammy_owner TEMPLATE template0 ENCODING ''UTF8'''
    || ' LOCALE_PROVIDER builtin BUILTIN_LOCALE ''C.UTF-8'' LC_COLLATE ''C'' LC_CTYPE ''C'''
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'lfdln') \gexec
ALTER DATABASE lfdln OWNER TO pammy_owner;
REVOKE ALL ON DATABASE lfdln FROM PUBLIC;
GRANT CONNECT ON DATABASE lfdln TO pammy_panel, pammy_gate;
-- nothing else is reachable anyway (pg_hba.conf), but say so here too
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;

\connect lfdln
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS panel AUTHORIZATION pammy_owner;
CREATE SCHEMA IF NOT EXISTS media AUTHORIZATION pammy_owner;
CREATE SCHEMA IF NOT EXISTS gate AUTHORIZATION pammy_owner;
-- the catalog, File Explorer's files and the thumbnails (docs/catalog-plan.md step 2; the
-- migration catalog/0001 makes them too, for a database this hasn't been re-run on)
CREATE SCHEMA IF NOT EXISTS catalog AUTHORIZATION pammy_owner;
CREATE SCHEMA IF NOT EXISTS files AUTHORIZATION pammy_owner;
CREATE SCHEMA IF NOT EXISTS thumbs AUTHORIZATION pammy_owner;
REVOKE ALL ON SCHEMA panel, media, gate, catalog, files, thumbs FROM PUBLIC;
REVOKE ALL ON SCHEMA gate FROM pammy_panel;
REVOKE ALL ON SCHEMA panel, media, catalog, files, thumbs FROM pammy_gate;
GRANT USAGE ON SCHEMA panel, media, catalog, files, thumbs TO pammy_panel;
GRANT USAGE ON SCHEMA gate TO pammy_gate;

-- what the owner makes later (migrations) is usable by the right process at once
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel, media, catalog, files, thumbs
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel, media, catalog, files, thumbs
    GRANT USAGE, SELECT ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel, media, catalog, files, thumbs
    GRANT EXECUTE ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pammy_gate;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate
    GRANT USAGE, SELECT ON SEQUENCES TO pammy_gate;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate
    GRANT EXECUTE ON FUNCTIONS TO pammy_gate;
-- and what's already there (a re-run after migrations)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA panel, catalog, files, thumbs TO pammy_panel;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA panel, media, catalog, files, thumbs TO pammy_panel;
-- media: read-only once the catalog has taken it over (catalog/0001), and empty since
-- catalog/0002 (step 3); before the move, it is still the panel's to write. The schema itself
-- stays: a new database's early migrations make their tables in it
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'catalog')
             AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = 'items')
            THEN 'GRANT SELECT ON ALL TABLES IN SCHEMA media TO pammy_panel; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA media FROM pammy_panel'
            ELSE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA media TO pammy_panel' END \gexec
-- ...and what catalog/0001 narrowed stays narrow when this is run again after it (lfdln's
-- installer runs it on every install): new tables in media read-only, and files.records a
-- view the panel only reads (its writes go to the tables)
SELECT 'ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA media REVOKE INSERT, UPDATE, DELETE ON TABLES FROM pammy_panel'
 WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = 'items') \gexec
SELECT 'REVOKE INSERT, UPDATE, DELETE ON files.records FROM pammy_panel'
 WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'files' AND c.relname = 'records') \gexec
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gate TO pammy_gate;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gate TO pammy_gate;
