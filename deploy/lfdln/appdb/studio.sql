-- lfdln-appdb: the Studio's login (docs/phase8-plan.md 8-4, P8-7, P8-9). Run by install-appdb.sh
-- as the superuser, after setup.sql and apps.sql; its password comes first on stdin as a \set
-- line, and the apps' databases it reads as \set lines too (lib-appdb.sh APPDB_STUDIO_READS,
-- which the tests keep the same as sites/lfdln/src/studio-site.ts). Safe to re-run.
--
-- It makes databases and the logins that reach them, as Pamela's studio role does
-- (deploy/studio/roles-pg.sql.in), and nothing above that. Since Postgres 16 a CREATEROLE role
-- may only alter or drop roles it created itself, so the apps' roles are out of its reach
-- whatever it asks; it holds no membership of any of them.
--
-- The apps' own databases: CONNECT, USAGE on the schema their tables are in, and SELECT on
-- those tables -- read, never written (the helper refuses writing them too). Nothing about the
-- apps' roles or their privileges changes here: every grant is to pammy_studio.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
SELECT 'CREATE ROLE pammy_studio' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pammy_studio') \gexec
ALTER ROLE pammy_studio LOGIN INHERIT NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 20 PASSWORD :'pammy_studio_pw';
ALTER ROLE pammy_studio SET application_name = 'lfdln-studio';
-- CREATE and DROP DATABASE run from the engine's own database (setup.sql took PUBLIC's CONNECT away)
GRANT CONNECT ON DATABASE postgres TO pammy_studio;
