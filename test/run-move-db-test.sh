#!/usr/bin/env bash
# The move tool (deploy/lfdln/appdb/move-db.sh, docs/data-move-plan.md M5) against
# throwaway engines: a Postgres 15 standing in for the server's own (:5432), with a
# TutorStar-like and a Gonsalves-like database (owners, a role that may write
# everything by a default privilege, extensions, a second schema, Berlin time), and a
# Postgres 17 standing in for lfdln-appdb. `copy` while something keeps writing to the
# old one must still compare equal (one snapshot); a row or a privilege changed on the
# copy afterwards must be caught.
#   test/run-move-db-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
OLD=move-test-old-$$ NEW=move-test-new-$$ OP=15532 NP=15536
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() { podman rm -f "$OLD" "$NEW" >/dev/null 2>&1; [[ -n ${KEEP:-} ]] && echo "kept $T" || rm -rf "$T"; }
trap cleanup EXIT

for v in 15 17; do podman image exists "docker.io/library/postgres:$v" || podman pull -q "docker.io/library/postgres:$v" >/dev/null; done
for c in "$OLD:$OP:15" "$NEW:$NP:17"; do
    IFS=: read -r name port v <<<"$c"
    podman run -d --rm --name "$name" -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD=test \
        "docker.io/library/postgres:$v" -c timezone=Europe/Berlin >/dev/null
done
for c in "$OLD" "$NEW"; do
    for _ in $(seq 60); do podman exec "$c" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 0.5; done
done
sleep 1
osql() { PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p $OP -U postgres "$@"; }
nsql() { PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p $NP -U postgres "$@"; }

# --- the old engine: two apps' databases, as on :5432
osql >/dev/null <<'SQL'
CREATE ROLE tutorstar LOGIN PASSWORD 'x';
CREATE ROLE ligneous_user LOGIN CREATEDB PASSWORD 'x';
CREATE ROLE gonsalves_readonly LOGIN PASSWORD 'x';
CREATE DATABASE tutorstar OWNER tutorstar;
CREATE DATABASE ligneous_frontend OWNER ligneous_user;
REVOKE CONNECT ON DATABASE ligneous_frontend FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE ligneous_frontend TO PUBLIC;
GRANT CONNECT ON DATABASE ligneous_frontend TO gonsalves_readonly;
SQL
osql -d tutorstar >/dev/null <<'SQL'
SET ROLE tutorstar;
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__migrations (id serial PRIMARY KEY, hash text, created_at bigint);
INSERT INTO drizzle.__migrations (hash, created_at) VALUES ('a1', 1), ('b2', 2);
CREATE TABLE students (id text PRIMARY KEY, name text NOT NULL, born date, notes jsonb, tags text[], rate numeric(8,2), score double precision, photo bytea,
                       created_at timestamp DEFAULT now(), seen_at timestamptz DEFAULT now());
INSERT INTO students (id, name, born, notes, tags, rate, score, photo)
  SELECT 's' || g, (ARRAY['Ärger', 'Zoë', 'straße', 'Ōsaka', 'émile', 'Émile'])[1 + g % 6] || ' ' || g, date '2010-01-01' + g,
         jsonb_build_object('g', g, 'x', 'ünïcode'), ARRAY['a', 'b' || g], g * 1.5, g / 7.0, decode(md5(g::text), 'hex')
    FROM generate_series(1, 2000) g;
CREATE TABLE sessions (id bigserial PRIMARY KEY, student text REFERENCES students(id), at timestamptz DEFAULT now());
CREATE VIEW recent AS SELECT * FROM students ORDER BY created_at DESC LIMIT 10;
SQL
osql -d ligneous_frontend >/dev/null <<'SQL'
CREATE EXTENSION pg_trgm;
CREATE EXTENSION fuzzystrmatch;
SET ROLE ligneous_user;
ALTER DEFAULT PRIVILEGES FOR ROLE ligneous_user GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gonsalves_readonly;
CREATE SCHEMA research;
CREATE TABLE individuals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), given text, surname text, born text);
CREATE INDEX individuals_trgm ON individuals USING gin (surname gin_trgm_ops);
INSERT INTO individuals (given, surname, born) SELECT 'Given' || g, (ARRAY['Gonsalves', 'Müller', 'Ødegård'])[1 + g % 3], g::text FROM generate_series(1, 5000) g;
CREATE TABLE contact_messages (id serial PRIMARY KEY, body text, at timestamp DEFAULT now());
CREATE TABLE research.notes (id serial PRIMARY KEY, body text);
INSERT INTO research.notes (body) VALUES ('one'), ('two');
CREATE FUNCTION public.surname_like(t text) RETURNS SETOF individuals LANGUAGE sql STABLE AS $$ SELECT * FROM individuals WHERE surname % t $$;
GRANT USAGE ON SCHEMA research TO gonsalves_readonly;
GRANT SELECT ON research.notes TO gonsalves_readonly;
SQL

# --- the new engine: the apps' roles, as setup.sql makes them
nsql >/dev/null <<'SQL'
CREATE ROLE tutorstar LOGIN PASSWORD 'y';
CREATE ROLE ligneous_user LOGIN CREATEDB PASSWORD 'y';
CREATE ROLE gonsalves_readonly LOGIN PASSWORD 'y';
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL

# --- the tool, with these two in place of :5432 and lfdln-appdb
cat > "$T/hooks.sh" <<EOF
old_psql() { PGPASSWORD=test psql -h 127.0.0.1 -p $OP -U postgres "\$@"; }
old_dump() { PGPASSWORD=test pg_dump -h 127.0.0.1 -p $OP -U postgres "\$@"; }
new_super() { podman exec -i -u postgres $NEW psql -v ON_ERROR_STOP=1 -X -qtA "\$@"; }
new_restore() { podman exec -i -u postgres $NEW pg_restore "\$@"; }
new_running() { true; }
snap_owner() { :; }
# the app's side: its secrets, its containers and the services helper, as files and a log
secret_get() { cat "$T/secrets/\$1"; }
secret_set() { cat > "$T/secrets/\$1"; if [[ \$1 == rehearse-* ]]; then cat "$T/secrets/\$1" >> "$T/rh.secrets"; echo >> "$T/rh.secrets"; fi; }
reach() { [[ ! -e $T/unreachable ]]; }
services_call() {
    echo "\$1" >> "$T/calls"
    if [[ \$1 == start && -e $T/fail-start ]]; then rm -f "$T/fail-start"; return 1; fi
    if [[ \$1 == stop && -e $T/fail-stop ]]; then rm -f "$T/fail-stop"; return 1; fi    # stopped, but not masked
}
can_mask() { [[ ! -e $T/no-mask ]]; }
FILE_ROOTS=("$T/apps")
DATABASES_JSON="$T/databases.json"
APPDB_PASS="$T/pass"
LIGNEOUS_QUADLETS="$T/qd"
# the rehearsal: containers as a log; each site answers from a file per port, the same unless told
rh_run() { echo "run \$*" >> "$T/rh"; }
rh_stop() { echo "stop \$*" >> "$T/rh"; }
rh_secret_rm() { echo "secret-rm \$*" >> "$T/rh"; for n in "\$@"; do rm -f "$T/secrets/\$n"; done; }
http_get() {
    if [[ \$2 == /api/tree/random/individual ]]; then echo '{"individual":{"xref":"@I0'\$RANDOM'@"}}' > "\$3"
    elif [[ \$1 == 3139 && -e $T/differ && \$2 == /api/tree/surnames ]]; then echo "other" > "\$3"
    elif [[ \$1 == 3139 && -e $T/reorder && ( \$2 == /api/tree/events || \$2 == "/api/tree/individual-picker?q=Maria" ) ]]; then echo '{"rows":[{"id":2,"n":1},{"id":1,"n":1}]}' > "\$3"
    elif [[ \$1 == 3139 && -e $T/ties && \$2 == /api/tree/given-names ]]; then echo '{"rows":[{"id":1,"frequency":5},{"id":3,"frequency":1}]}' > "\$3"
    elif [[ \$1 == 3139 && -e $T/tie-bad && \$2 == /api/tree/given-names ]]; then echo '{"rows":[{"id":1,"frequency":5},{"id":3,"frequency":2}]}' > "\$3"
    elif [[ \$2 == /api/tree/events || \$2 == "/api/tree/individual-picker?q=Maria" ]]; then echo '{"rows":[{"id":1,"n":1},{"id":2,"n":1}]}' > "\$3"
    elif [[ \$2 == /api/tree/given-names ]]; then echo '{"rows":[{"id":1,"frequency":5},{"id":2,"frequency":1}]}' > "\$3"
    else echo "answer for \$2" > "\$3"; fi
    echo 200
}
appdb_log_since() { cat "$T/pglog" 2>/dev/null || true; }
copy_sessions() { echo 2; }
EOF
mkdir -p "$T/qd"
printf 'postgresql://ligneous_user:oldL@10.0.2.2:5432/ligneous_frontend?sslmode=disable\n' > "$T/qd/ligneous-db-url"
printf 'postgresql://gonsalves_readonly:oldG@10.0.2.2:5432/ligneous_frontend?sslmode=disable\n' > "$T/qd/ligneous-db-url-public"
chmod 600 "$T/qd/"*; cp -p "$T/qd/ligneous-db-url-public" "$T/qd-public.orig"
mkdir -p "$T/secrets" "$T/apps/tutorstar" "$T/apps/other" "$T/pass"
for r in tutorstar ligneous_user gonsalves_readonly; do echo "NEW${r//_/}0123456789abcdef" > "$T/pass/$r.pass"; done
printf 'postgres://tutorstar:oldPw1@10.0.2.2:5432/tutorstar' > "$T/secrets/tutorstar-db-url"
printf 'DATABASE_URL=postgres://tutorstar:oldPw1@localhost:5432/tutorstar\nOTHER=kept\n' > "$T/apps/tutorstar/.env"
printf 'DATABASE_URL=postgres://tutorstar:oldPw1@localhost:5432/tutorstar_test\n' > "$T/apps/other/.env"
chmod 640 "$T/apps/tutorstar/.env"
cp -p "$T/secrets/tutorstar-db-url" "$T/secret.orig"; cp -p "$T/apps/tutorstar/.env" "$T/env.orig"; cp -p "$T/apps/other/.env" "$T/other.orig"
move() { MOVE_TEST="$T/hooks.sh" MOVES="$T/moves" "$P/deploy/lfdln/appdb/move-db.sh" "$@"; }

echo "--- plan"
out=$(move tutorstar plan 2>&1)
grep -q "no copy yet" <<<"$out" && grep -qF "tutorstar-db-url: postgres://tutorstar:***@10.0.2.2:5432/tutorstar -- the switch can change it" <<<"$out" && ok "plan: what it would do, nothing done" || bad "plan: $out"

echo "--- copy, while something keeps writing to the old one"
( for i in $(seq 400); do osql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s$((i % 2000 + 1))')" >/dev/null 2>&1; done ) &
writer=$!
out=$(move tutorstar copy 2>&1); rc=$?
kill $writer 2>/dev/null; wait $writer 2>/dev/null
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 ]] && grep -q 'every table the same' <<<"$out" && ok "tutorstar copied and every table the same, although it was being written to" || bad "tutorstar copy (exit $rc)"
grep -q 'the same owners, privileges' <<<"$out" && ok "...and the same owners and privileges" || bad "tutorstar shape"
[[ $(nsql -d tutorstar -c "SELECT datlocprovider::text || ' ' || datlocale FROM pg_database WHERE datname = 'tutorstar'") == 'i de-DE-u-ka-shifted' ]] && ok "...sorting German as glibc does (ICU de-DE-u-ka-shifted)" || bad "tutorstar's collation: $(nsql -c "SELECT datlocprovider, datlocale FROM pg_database WHERE datname = 'tutorstar'")"
[[ $(nsql -c "SHOW timezone") == Europe/Berlin ]] && ok "...in Berlin time, as the old one" || bad "timezone"
[[ $(nsql -d tutorstar -c "SELECT string_agg(name, '|' ORDER BY name) FROM (SELECT DISTINCT split_part(name, ' ', 1) name FROM students) s") == 'Ärger|émile|Émile|Ōsaka|straße|Zoë' ]] \
    && ok "...and it sorts ä, é, Ō, ß and Z as German does" || bad "German sorting: $(nsql -d tutorstar -c "SELECT string_agg(name, '|' ORDER BY name) FROM (SELECT DISTINCT split_part(name, ' ', 1) name FROM students) s")"
[[ $(nsql -c "SELECT has_database_privilege('public', 'tutorstar', 'CONNECT')") == f && $(nsql -c "SELECT has_database_privilege('tutorstar', 'tutorstar', 'CONNECT')") == t ]] \
    && ok "...PUBLIC may not connect; tutorstar may, as before" || bad "tutorstar's CONNECT"

echo "--- the Gonsalves-like one: a second schema, extensions, a role that may write everything"
out=$(move gonsalves copy 2>&1); rc=$?
[[ $rc -eq 0 ]] && grep -q 'every table the same' <<<"$out" && grep -q 'the same owners, privileges' <<<"$out" && ok "copied, every table and privilege the same" || { bad "gonsalves copy (exit $rc)"; echo "$out" | sed 's/^/    /'; }
r=$(PGPASSWORD=y psql -X -qtA -h 127.0.0.1 -p $NP -U gonsalves_readonly -d ligneous_frontend -c "INSERT INTO individuals (given, surname) VALUES ('New', 'Person') RETURNING 'wrote'" 2>&1)
[[ $r == wrote ]] && ok "gonsalves_readonly may still write, as it may today (Q4)" || bad "gonsalves_readonly: $r"
r=$(PGPASSWORD=y psql -X -qtA -h 127.0.0.1 -p $NP -U ligneous_user -d ligneous_frontend -c "SELECT count(*) FROM surname_like('Muller')" 2>&1)
[[ $r =~ ^[0-9]+$ && $r -gt 0 ]] && ok "the extensions work there (a trigram search: $r)" || bad "trigram search: $r"
r=$(PGPASSWORD=y psql -X -qtA -h 127.0.0.1 -p $NP -U ligneous_user -d ligneous_frontend -c "CREATE DATABASE prisma_migrate_shadow_db_test" 2>&1; nsql -c "SELECT count(*) FROM pg_database WHERE datname = 'prisma_migrate_shadow_db_test'")
[[ ${r##*$'\n'} == 1 ]] && ok "ligneous_user may still make a database (Prisma's shadow database)" || bad "CREATEDB: $r"

echo "--- compare catches what differs"
nsql -d tutorstar -c "UPDATE students SET name = 'changed' WHERE id = 's7'" >/dev/null
out=$(move tutorstar compare 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'rows differ in 2 of' <<<"$out" && ok "a changed row on the copy (and the old one's new sessions): caught, table by table" || { bad "compare after a change (exit $rc)"; echo "$out" | sed 's/^/    /'; }
out=$(move tutorstar copy 2>&1) && ok "copy again: made afresh from the old one" || bad "copy again: $out"
nsql -d ligneous_frontend -c "REVOKE SELECT ON research.notes FROM gonsalves_readonly" >/dev/null
out=$(move gonsalves compare 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'owners or privileges differ' <<<"$out" && ok "a privilege taken away on the copy: caught" || { bad "compare after a revoke (exit $rc)"; echo "$out" | sed 's/^/    /'; }

echo "--- refused"
echo "switched 2026-01-01" > "$T/moves/tutorstar.switched"
out=$(move tutorstar copy 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'already uses the copy' <<<"$out" && ok "once switched, copy refuses to copy over what the app wrote" || bad "copy after a switch: $out"
out=$(move nope plan 2>&1); [[ $? -eq 2 ]] && ok "an app it doesn't know" || bad "unknown app: $out"

echo "--- switch: the app stopped, copied again, pointed at the new one, started"
rm -f "$T/moves/tutorstar.switched"
move tutorstar copy >/dev/null 2>&1
: > "$T/calls"
out=$(move tutorstar switch 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start ' ]] && ok "stopped, then started, through the services helper" || bad "switch (exit $rc, calls: $(tr '\n' ' ' < "$T/calls"))"
grep -q 'every table the same' <<<"$out" && ok "...copied again and compared, with the app stopped" || bad "switch's compare"
[[ $(cat "$T/secrets/tutorstar-db-url") == "postgres://tutorstar:NEWtutorstar0123456789abcdef@10.0.2.2:5436/tutorstar" ]] && ok "the secret: port and password, nothing else, no newline added" || bad "secret: $(cat "$T/secrets/tutorstar-db-url")"
[[ $(cat "$T/apps/tutorstar/.env") == $'DATABASE_URL=postgres://tutorstar:NEWtutorstar0123456789abcdef@localhost:5436/tutorstar\nOTHER=kept' ]] && ok "momolig's .env: its URL changed, the rest as it was" || bad ".env: $(cat "$T/apps/tutorstar/.env")"
cmp -s "$T/apps/tutorstar/.env.before-move" "$T/env.orig" && [[ $(stat -c %a "$T/apps/tutorstar/.env") == 640 ]] && ok "...its copy as it was beside it, and its mode kept" || bad ".before-move or mode"
cmp -s "$T/apps/other/.env" "$T/other.orig" && ok "a URL for another database (tutorstar_test) left alone" || bad "tutorstar_test touched"
r=$(osql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1')" 2>&1)
grep -q 'read-only' <<<"$r" && ok "the old one refuses writes now" || bad "old still writable: $r"
[[ $(osql -d tutorstar -c "SELECT count(*) > 0 FROM students") == t ]] && ok "...and can still be read" || bad "old can't be read"
python3 -c "import json, sys; d = json.load(open('$T/databases.json'))['tutorstar']; sys.exit(d['engine'] != 'lfdln-appdb' or d['port'] != 5436)" && ok "the Services page will say: on lfdln-appdb, :5436" || bad "databases.json: $(cat "$T/databases.json")"
out=$(move tutorstar switch 2>&1); [[ $? -ne 0 ]] && grep -q 'already uses lfdln-appdb' <<<"$out" && ok "switching twice is refused" || bad "second switch: $out"

echo "--- back: says what was written since, then the app on the old one again"
nsql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1'), ('s2'), ('s3')" >/dev/null
: > "$T/calls"
out=$(MOVE_YES=1 move tutorstar back 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start ' ]] && ok "stopped, then started" || bad "back (exit $rc)"
grep -qE 'public\.sessions +[0-9]+ -> [0-9]+' <<<"$out" && grep -q '1 table(s) differ' <<<"$out" && ok "...after naming the table written since, and its rows" || bad "back didn't say what was written"
cmp -s "$T/secrets/tutorstar-db-url" "$T/secret.orig" && ok "the secret exactly as it was" || bad "secret after back: $(cat "$T/secrets/tutorstar-db-url")"
cmp -s "$T/apps/tutorstar/.env" "$T/env.orig" && [[ ! -e $T/apps/tutorstar/.env.before-move ]] && ok "the .env as it was, its copy gone" || bad ".env after back"
r=$(osql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1') RETURNING 'wrote'" 2>&1)
[[ $r == wrote ]] && ok "the old one takes writes again" || bad "old after back: $r"
[[ ! -e $T/moves/tutorstar.switched ]] && python3 -c "import json, sys; sys.exit(json.load(open('$T/databases.json'))['tutorstar']['engine'] != 'server')" && ok "not switched any more, and the page will say :5432" || bad "marker or databases.json after back"

echo "--- a switch whose app doesn't come up is undone, and the app started on the old one"
move tutorstar copy >/dev/null 2>&1
: > "$T/calls"; touch "$T/fail-start"
out=$(move tutorstar switch 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -ne 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start start ' ]] && grep -q 'started again, on :5432' <<<"$out" && ok "refused, and started again on the old one" || bad "failed switch (exit $rc, calls: $(tr '\n' ' ' < "$T/calls"))"
cmp -s "$T/secrets/tutorstar-db-url" "$T/secret.orig" && cmp -s "$T/apps/tutorstar/.env" "$T/env.orig" && [[ ! -e $T/apps/tutorstar/.env.before-move ]] && ok "...its secret and .env as they were" || bad "secret or .env after an undone switch"
r=$(osql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1') RETURNING 'wrote'" 2>&1)
[[ $r == wrote && ! -e $T/moves/tutorstar.switched ]] && ok "...and the old one writable, not switched" || bad "after an undone switch: $r"

echo "--- a stop the services helper says failed (2026-09-27: stopped, but not masked): started again all the same"
: > "$T/calls"; touch "$T/fail-stop"
out=$(move tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start ' && ! -e $T/moves/tutorstar.switched ]] && grep -q 'started again, on :5432' <<<"$out" \
    && ok "refused, and started again on the old one" || bad "failed stop (exit $rc, calls: $(tr '\n' ' ' < "$T/calls")): $out"
r=$(osql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1') RETURNING 'wrote'" 2>&1)
[[ $r == wrote ]] && cmp -s "$T/secrets/tutorstar-db-url" "$T/secret.orig" && ok "...the old one writable, the secret as it was" || bad "after a failed stop: $r"

echo "--- refused before anything stops"
: > "$T/calls"
touch "$T/no-mask"
out=$(move tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -s $T/calls ]] && grep -q "can't write its ~/.config/systemd/user" <<<"$out" && ok "a service user whose systemd can't keep it stopped: refused, nothing stopped" || bad "no-mask: $out"
rm -f "$T/no-mask"
touch "$T/unreachable"
out=$(move tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -s $T/calls ]] && grep -q "can't reach 10.0.2.2:5436" <<<"$out" && ok "a container that can't reach the new one: refused, nothing stopped" || bad "unreachable: $out"
rm -f "$T/unreachable"
printf 'postgres://tutorstar:x@db.example:5432/tutorstar' > "$T/secrets/tutorstar-db-url"
out=$(move tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -s $T/calls ]] && grep -q 'has no URL' <<<"$out" && ok "a secret with no URL it may change: refused, nothing stopped" || bad "odd secret: $out"
cp -p "$T/secret.orig" "$T/secrets/tutorstar-db-url"
printf 'postgres://ligneous_user:x@10.0.2.2:5432/ligneous_frontend' > "$T/secrets/ligneous-db-url"
out=$(move gonsalves switch 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'rehearse first' <<<"$out" && ok "Gonsalves: not before its rehearsal (step 3)" || bad "gonsalves switch: $out"
echo "--- rehearse (Gonsalves): a throwaway site on a fresh copy, asked what the live one is asked"
printf 'postgresql://ligneous_user:oldL@10.0.2.2:5432/ligneous_frontend?sslmode=disable' > "$T/secrets/ligneous-db-url"
printf 'postgresql://gonsalves_readonly:oldG@10.0.2.2:5432/ligneous_frontend?sslmode=disable' > "$T/secrets/ligneous-db-url-public"
cp -p "$T/secrets/ligneous-db-url-public" "$T/gsecret.orig"
out=$(move tutorstar rehearse 2>&1); [[ $? -ne 0 ]] && grep -q 'only Gonsalves' <<<"$out" && ok "only Gonsalves has one" || bad "tutorstar rehearse: $out"
: > "$T/rh"
out=$(move gonsalves rehearse 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 && -e $T/moves/ligneous_frontend.rehearsed ]] && grep -q 'every table the same' <<<"$out" && ok "rehearsed on a fresh copy, every address the same" || bad "rehearse (exit $rc)"
grep -q 'run --name ligneous-rehearse-flask --network pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,5436 -p 127.0.0.1:5101:5001 .*--secret rehearse-ligneous-db-url,type=env' "$T/rh" \
    && grep -q 'run --name ligneous-rehearse-public --network pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,5101,-T,5436 -p 127.0.0.1:3139:3039 .*rehearse-ligneous-db-url-public,type=env.*PYTHON_API_URL=http://127.0.0.1:5101' "$T/rh" \
    && ok "...its Flask API and public site on their own ports, on pasta (S1f), the site's Flask calls to the rehearsal's" || bad "rehearsal containers: $(cat "$T/rh")"
[[ $(grep -o '@127.0.0.1:5436/ligneous_frontend' "$T/rh.secrets" 2>/dev/null | wc -l) == 2 ]] && ok "...their secrets pointing at the copy (127.0.0.1:5436, as on pasta)" || bad "rehearsal secrets: $(cat "$T/rh.secrets" 2>/dev/null | sed -E 's#:[^:@]+@#:***@#')"
grep -q 'stop ligneous-rehearse-public ligneous-rehearse-flask' "$T/rh" && [[ ! -e $T/secrets/rehearse-ligneous-db-url && ! -e $T/secrets/rehearse-ligneous-db-url-public ]] \
    && ok "...and they and their secrets are gone after" || bad "rehearsal cleanup: $(cat "$T/rh"); $(ls "$T/secrets")"
cmp -s "$T/secrets/ligneous-db-url-public" "$T/gsecret.orig" && ok "the live secrets untouched" || bad "live secret changed by the rehearsal"
rm -f "$T/moves/ligneous_frontend.rehearsed"; touch "$T/differ"; : > "$T/rh"
out=$(move gonsalves rehearse 2>&1); rc=$?
[[ $rc -ne 0 && ! -e $T/moves/ligneous_frontend.rehearsed ]] && grep -q '/api/tree/surnames: 200 from both, but different answers' <<<"$out" && grep -q 'stop ligneous-rehearse' "$T/rh" \
    && ok "an answer that differs: caught, not rehearsed, and cleaned up all the same" || bad "rehearse with a difference (exit $rc): $out"
rm -f "$T/differ"; echo '2026-09-25 12:00:00 UTC [77] ERROR:  collation "de_DE.UTF-8" for encoding "UTF8" does not exist' > "$T/pglog"
out=$(move gonsalves rehearse 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'logged 1 error' <<<"$out" && ok "an error in the copy's Postgres log: caught" || bad "rehearse with a log error (exit $rc): $out"
rm -f "$T/pglog"
touch "$T/reorder"; rm -f "$T/moves/ligneous_frontend.rehearsed"
out=$(move gonsalves rehearse 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q '/api/tree/events: the same answer in another order (1 list(s) reordered)' <<<"$out" \
    && grep -q 'individual-picker?q=Maria: 200 from both, but different answers .*sorted by name, so it must be the same bytes' <<<"$out" \
    && ok "the same rows in another order: a note, but not where it is sorted by name" || bad "rehearse reordered (exit $rc): $out"
ls "$T"/moves/ligneous_frontend-rehearse-*/_api_tree_individual-picker_q_Maria.new >/dev/null 2>&1 && ok "...both answers kept" || bad "answers not kept: $(ls "$T/moves")"
rm -f "$T/reorder"; touch "$T/ties"
out=$(move gonsalves rehearse 2>&1); rc=$?
[[ $rc -eq 0 ]] && grep -qF 'given-names: the same answer in another order (1 other row(s) tied at frequency=1 in $.rows)' <<<"$out" && grep -q '1 the same answer in another order' <<<"$out" \
    && ok "other rows tied at a LIMIT's cut-off: a note, rehearsed" || bad "rehearse ties (exit $rc): $out"
rm -f "$T/ties"; touch "$T/tie-bad"
out=$(move gonsalves rehearse 2>&1); rc=$?
[[ $rc -ne 0 ]] && grep -q 'differ \$.rows' <<<"$out" && ok "...but a row that isn't tied: a difference" || bad "rehearse tie-bad (exit $rc): $out"
rm -f "$T/tie-bad"
move gonsalves rehearse >/dev/null 2>&1 && ok "rehearsed again, cleanly" || bad "rehearse again"

echo "--- the Gonsalves switch moves the files its secrets are made from too (sync-podman-secrets.sh)"
: > "$T/calls"
out=$(move gonsalves switch 2>&1); rc=$?
[[ $rc -eq 0 ]] && grep -q "ligneous-db-url-public (as it was" <<<"$out" && ok "switched, with its secret files" || { bad "gonsalves switch (exit $rc)"; echo "$out" | sed 's/^/    /'; }
[[ $(cat "$T/qd/ligneous-db-url-public") == "postgresql://gonsalves_readonly:NEWgonsalvesreadonly0123456789abcdef@10.0.2.2:5436/ligneous_frontend?sslmode=disable" && $(stat -c %a "$T/qd/ligneous-db-url-public") == 600 ]] \
    && ok "...so a later sync makes the secret for :5436, not the old one" || bad "secret file: $(cat "$T/qd/ligneous-db-url-public")"
out=$(MOVE_YES=1 move gonsalves back 2>&1); rc=$?
[[ $rc -eq 0 ]] && cmp -s "$T/qd/ligneous-db-url-public" "$T/qd-public.orig" && cmp -s "$T/secrets/ligneous-db-url-public" "$T/gsecret.orig" && ok "...and back puts them as they were" || { bad "gonsalves back (exit $rc)"; echo "$out" | sed 's/^/    /'; }

r=$(printf 'X=postgres://postgres:p@localhost:5432/tutorstar\n' | python3 "$P/deploy/lfdln/appdb/rewrite-url.py" --db tutorstar --from 5432 --to 5436 --pass tutorstar="$T/pass/tutorstar.pass" 2>&1); rc=$?
[[ $rc -eq 4 ]] && ok "a URL for a role the move has no password for: refused" || bad "unknown role: $rc $r"

echo "--- S1f: an app on pasta (to-pasta.sh) is neither switched nor sent back; URLs told 127.0.0.1"
echo "on pasta since 2026-10-09T00:00:00Z" > "$T/moves/tutorstar.pasta"
for st in switch back; do
    out=$(MOVE_YES=1 move tutorstar $st 2>&1); rc=$?
    [[ $rc -ne 0 ]] && grep -q 'to-pasta.sh tutorstar back' <<<"$out" && ok "$st refused while it is on pasta" || bad "$st on pasta (exit $rc): $out"
done
rm -f "$T/moves/tutorstar.pasta"
RW() { python3 "$P/deploy/lfdln/appdb/rewrite-url.py" "$@"; }
r=$(printf 'postgresql://u:s3cret@10.0.2.2:5436/ligneous_frontend?sslmode=disable' | RW --db ligneous_frontend --from 5436 --to 5436 --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords)
[[ $r == 'postgresql://u:s3cret@127.0.0.1:5436/ligneous_frontend?sslmode=disable' ]] && ok "rewrite-url --host: 10.0.2.2 told 127.0.0.1, its password and the rest as they were, no newline added" || bad "rewrite --host: $r"
r=$(printf 'postgres://u:p@127.0.0.1:5436/tutorstar' | RW --db tutorstar --from 5436 --to 5436 --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords 2>&1); rc=$?
[[ $rc -eq 3 ]] && ok "...a URL already at 127.0.0.1: not one it changes (exit 3)" || bad "already moved: $rc $r"
r=$(printf 'x' | RW --db tutorstar --from 5436 --to 5436 --host db.example --keep-passwords 2>&1); rc=$?
[[ $rc -ne 0 && $rc -ne 3 ]] && ok "...a host off this machine: refused" || bad "odd host: $rc $r"

echo "--- the Studio's login on it (appdb/studio.sql, docs/phase8-plan.md 8-4): its own databases, the apps' read-only"
A=$P/deploy/lfdln/appdb
{ printf '\\set pammy_studio_pw %s\n' Studiopass0123456789; cat "$A/studio.sql"; } | podman exec -i -u postgres $NEW psql -v ON_ERROR_STOP=1 -X -qtA >/dev/null \
    && ok "studio.sql runs" || bad "studio.sql"
{ printf '\\set pammy_studio_pw %s\n' Studiopass0123456789; cat "$A/studio.sql"; } | podman exec -i -u postgres $NEW psql -v ON_ERROR_STOP=1 -X -qtA >/dev/null \
    && ok "...and again (safe to re-run)" || bad "studio.sql twice"
for e in tutorstar:public ligneous_frontend:public; do
    sed -e "s/__DB__/${e%%:*}/g" -e "s/__SCHEMA__/${e#*:}/g" "$A/studio-reads.sql.in" | podman exec -i -u postgres $NEW psql -v ON_ERROR_STOP=1 -X -qtA >/dev/null \
        || bad "studio-reads for $e"
done
ssql() { PGPASSWORD=Studiopass0123456789 psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p $NP -U pammy_studio "$@"; }
[[ $(ssql -d tutorstar -c "SELECT count(*) > 0 FROM students") == t ]] && ok "it reads an app's table" || bad "the Studio can't read tutorstar"
r=$(ssql -d tutorstar -c "INSERT INTO sessions (student) VALUES ('s1')" 2>&1); grep -q 'permission denied' <<<"$r" && ok "...and may not write it" || bad "the Studio wrote tutorstar: $r"
r=$(ssql -d tutorstar -c "ALTER TABLE students ADD COLUMN zz text" 2>&1); grep -qE 'must be owner|permission denied' <<<"$r" && ok "...nor change its structure" || bad "the Studio altered tutorstar: $r"
r=$(ssql -d ligneous_frontend -c "SELECT count(*) FROM research.notes" 2>&1); grep -q 'permission denied' <<<"$r" && ok "...and nothing outside the schema it was given" || bad "research.notes: $r"
r=$(ssql -d postgres -c "ALTER ROLE tutorstar PASSWORD 'x'" 2>&1); grep -qE 'permission denied|must have' <<<"$r" && ok "it can't touch an app's login (CREATEROLE reaches only its own)" || bad "the Studio altered tutorstar's login: $r"
r=$(ssql -d postgres -c "DROP DATABASE tutorstar" 2>&1); grep -qE 'must be owner|permission denied' <<<"$r" && ok "...nor drop an app's database" || bad "the Studio dropped tutorstar: $r"
ssql -d postgres -c "CREATE DATABASE zz_studio_made" >/dev/null && ssql -d zz_studio_made -c "CREATE TABLE notes (id int)" >/dev/null \
    && ssql -d postgres -c "DROP DATABASE zz_studio_made" >/dev/null && ok "its own database: made, used, dropped" || bad "the Studio's own database"
ssql -d postgres -c "CREATE ROLE zz_reader LOGIN PASSWORD 'Readerpass0123456789' NOCREATEDB" >/dev/null && ssql -d postgres -c "DROP ROLE zz_reader" >/dev/null \
    && ok "...and a login of its own" || bad "the Studio's own login"
r=$(PGPASSWORD=y psql -X -qtA -h 127.0.0.1 -p $NP -U gonsalves_readonly -d ligneous_frontend -c "INSERT INTO individuals (given, surname) VALUES ('After', 'Studio') RETURNING 'wrote'" 2>&1)
[[ $r == wrote ]] && ok "the apps' own roles may do what they did before (gonsalves_readonly still writes)" || bad "gonsalves_readonly after studio.sql: $r"

echo "--- lfdln-appdb's own pg_hba.conf on it (the apps', the Studio's, and db_ logins: P8-15)"
ssql -d postgres -c "CREATE ROLE db_verify LOGIN PASSWORD 'Dbverify0123456789' NOCREATEDB" >/dev/null
ssql -d postgres -c "CREATE DATABASE zz_studio_own" >/dev/null
ssql -d postgres -c "GRANT CONNECT ON DATABASE zz_studio_own TO db_verify" >/dev/null
# the superuser keeps a way in over TCP for the rest of this test only (the real file's
# postgres line is peer, inside the container)
{ echo "host all postgres all scram-sha-256"; grep -E '^(local|host)' "$A/pg_hba.conf"; } | podman exec -i -u postgres $NEW sh -c 'cat > "$PGDATA/pg_hba.conf"'
podman exec -u postgres $NEW psql -X -qtA -c "ALTER ROLE postgres PASSWORD 'test'" -c "SELECT pg_reload_conf()" >/dev/null
[[ $(nsql -c "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL") == 0 ]] && ok "the engine reads it without an error (regular expressions and all)" || bad "pg_hba errors: $(nsql -c "SELECT line_number, error FROM pg_hba_file_rules WHERE error IS NOT NULL")"
dsql() { PGPASSWORD=Dbverify0123456789 PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $NP -U db_verify "$@"; }
[[ $(dsql -d zz_studio_own -c "SELECT 1" 2>&1) == 1 ]] && ok "a db_ login reaches a database it was given" || bad "db_verify to its own database: $(dsql -d zz_studio_own -c 'SELECT 1' 2>&1)"
for adb in tutorstar ligneous_frontend postgres; do
    r=$(dsql -d "$adb" -c "SELECT 1" 2>&1); grep -q 'pg_hba.conf rejects' <<<"$r" && ok "...and is turned away from $adb by pg_hba itself" || bad "db_verify to $adb: $r"
done
nsql -d tutorstar -c "GRANT CONNECT ON DATABASE tutorstar TO db_verify" >/dev/null
r=$(dsql -d tutorstar -c "SELECT 1" 2>&1); grep -q 'pg_hba.conf rejects' <<<"$r" && ok "...even if someone granted it CONNECT there" || bad "db_verify to tutorstar after a grant: $r"
nsql -d tutorstar -c "REVOKE CONNECT ON DATABASE tutorstar FROM db_verify" >/dev/null
nsql -d postgres -c "CREATE ROLE zz_other LOGIN PASSWORD 'Otherpass0123456789'; GRANT CONNECT ON DATABASE zz_studio_own TO zz_other" >/dev/null
r=$(PGPASSWORD=Otherpass0123456789 PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $NP -U zz_other -d zz_studio_own -c "SELECT 1" 2>&1)
grep -q 'pg_hba.conf rejects' <<<"$r" && ok "a login not named db_ (and not an app's) is turned away" || bad "zz_other: $r"
[[ $(PGPASSWORD=Studiopass0123456789 PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $NP -U pammy_studio -d tutorstar -c "SELECT 1" 2>&1) == 1 ]] && ok "the Studio's own login still reads the apps' databases" || bad "pammy_studio after pg_hba"
[[ $(PGPASSWORD=y PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $NP -U gonsalves_readonly -d ligneous_frontend -c "SELECT 1" 2>&1) == 1 ]] && ok "and the apps' roles get in as before" || bad "gonsalves_readonly after pg_hba"

echo
echo "  move-db test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
