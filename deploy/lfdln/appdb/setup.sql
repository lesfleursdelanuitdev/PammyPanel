-- lfdln-appdb: the apps' roles (docs/data-move-plan.md M4), as they are on the server's
-- own Postgres (:5432) -- the same names and attributes, new passwords. The databases
-- themselves, their tables and every privilege come with the move (move-db.sh), from
-- the old ones. Run by install-appdb.sh as the superuser inside the container. Safe to
-- re-run. Passwords come from the podman secrets, read inside psql, never on a command line.
\set ON_ERROR_STOP on
\set tutorstar_pw `cat /run/secrets/lfdln-appdb-tutorstar`
\set ligneous_user_pw `cat /run/secrets/lfdln-appdb-ligneous_user`
\set gonsalves_readonly_pw `cat /run/secrets/lfdln-appdb-gonsalves_readonly`

SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY['tutorstar', 'ligneous_user', 'gonsalves_readonly']) r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- (what \du says of them on :5432, 2026-09-25: all LOGIN INHERIT, no connection limit;
-- ligneous_user CREATEDB, for Prisma's shadow database)
ALTER ROLE tutorstar LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT -1 PASSWORD :'tutorstar_pw';
ALTER ROLE ligneous_user LOGIN INHERIT NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT -1 PASSWORD :'ligneous_user_pw';
ALTER ROLE gonsalves_readonly LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT -1 PASSWORD :'gonsalves_readonly_pw';

-- nobody reaches the engine's own database (pg_hba.conf says so too)
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
