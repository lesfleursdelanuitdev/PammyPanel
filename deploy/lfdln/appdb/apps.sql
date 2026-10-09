-- lfdln-appdb: databases made here for the lesfleursdelanuit.com projects (G9), as opposed to
-- the ones moved in from :5432 (setup.sql, move-db.sh). Each project gets an owner role (its
-- installer runs its migrations as it) and an app role (rows only), a database of its own that
-- only those two may connect to, and German sorting like the rest. Run by install-appdb.sh as
-- the superuser; the passwords come first on stdin as \set lines (never on a command line, and
-- not container secrets: adding one would mean restarting the engine under TutorStar and
-- Gonsalves). Safe to re-run.
--
-- Placement Exam Prep (exam prep's NEXTJS-PLAN.md S3-5): examprep_owner, examprep_app, examprep.
-- Its tables come from its own migrations (web/migrations/, schema prep). A copy of this part
-- is in its web/test/appdb-examprep.sql, for its tests: keep the two alike.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY['examprep_owner', 'examprep_app']) r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE examprep_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 5 PASSWORD :'examprep_owner_pw';
ALTER ROLE examprep_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 20 PASSWORD :'examprep_app_pw';
ALTER ROLE examprep_app SET statement_timeout = '5s';
ALTER ROLE examprep_app SET idle_in_transaction_session_timeout = '30s';

SELECT 'CREATE DATABASE examprep OWNER examprep_owner TEMPLATE template0 ENCODING ''UTF8'' LOCALE_PROVIDER icu ICU_LOCALE ''de-DE'' LOCALE ''C.UTF-8'''
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'examprep') \gexec
REVOKE ALL ON DATABASE examprep FROM PUBLIC;
GRANT CONNECT ON DATABASE examprep TO examprep_owner, examprep_app;
GRANT TEMPORARY ON DATABASE examprep TO examprep_owner;

\c examprep
-- public holds only the migrations' list (the owner's); the app reads it, makes nothing
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO examprep_owner;
GRANT USAGE ON SCHEMA public TO examprep_app;
