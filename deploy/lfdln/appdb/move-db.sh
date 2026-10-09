#!/usr/bin/env bash
# Move an app's database from the server's own Postgres (:5432) to lfdln-appdb (:5436)
# (docs/data-move-plan.md M5), in stages; each says what it did.
#
#   sudo deploy/lfdln/appdb/move-db.sh <app> plan      what it would do, and what it would stop
#   sudo deploy/lfdln/appdb/move-db.sh <app> copy      a copy made, and every table compared (nothing live changes)
#   sudo deploy/lfdln/appdb/move-db.sh <app> compare   the copy compared again with the live database
#   sudo deploy/lfdln/appdb/move-db.sh gonsalves rehearse   a throwaway public site + Flask API on a fresh copy, compared with the live ones
#   sudo deploy/lfdln/appdb/move-db.sh <app> switch    the app moved: stopped, copied again, pointed at :5436, started
#   sudo deploy/lfdln/appdb/move-db.sh <app> back      the way back (14 days): the app on :5432 again
#
#   <app>: tutorstar | gonsalves
#
# `copy` can be run as often as you like until the app is switched: it makes the copy
# again from scratch each time. `plan`, `copy` and `compare` stop, change and write
# nothing live (the dump is read as postgres over the local socket).
#
# `switch` is the downtime (D6). It checks first that every secret and file it will
# change can be changed, and that each running container can reach :5436. Then it
# stops the app through the services helper; makes the old database read-only; copies
# and compares again; rewrites the app's secrets and momolig's files (M6); and starts
# the app. If any step fails, everything done so far is undone and the app is started
# again on the old database. `back` does the same in reverse, after saying what was
# written since the switch.
set -euo pipefail
[[ $EUID -eq 0 || -n ${MOVE_TEST:-} ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-appdb.sh"
source "$(dirname "$(readlink -f "$0")")/lib-svc.sh"
die() { say FAIL "$1" >&2; exit 1; }

# How it reaches the two engines. The tests (test/run-move-db-test.sh) put throwaway
# Postgres 15 and 17 containers in their place by redefining these (MOVE_TEST).
old_psql() { (cd / && runuser -u postgres -- psql "$@"); }            # :5432, as postgres, peer
old_dump() { (cd / && runuser -u postgres -- pg_dump "$@"); }
new_super() { appdb_super "$@"; }
new_restore() { as_appdb podman exec -i -u postgres "$APPDB_CONTAINER" pg_restore "$@"; }
new_running() { [[ $(appdb_ctl is-active "$APPDB_CONTAINER.service" 2>/dev/null) == active ]]; }
snap_owner() { chown postgres "$1"; }                                  # the snapshot session's files
rh_run() { as_svc podman run -d --rm "$@" >/dev/null; }                  # a throwaway container (rehearse)
rh_stop() { as_svc podman rm -f -t 5 "$@" >/dev/null 2>&1 || true; }
rh_secret_rm() { as_svc podman secret rm "$@" >/dev/null 2>&1 || true; }
http_get() {  # http_get <port> <path> <body file>: prints the status; the same Host for live and rehearsal
    curl -s --max-time 60 -H 'Host: 127.0.0.1:3039' -o "$3" -w '%{http_code}' "http://127.0.0.1:$1$2" || true
}
appdb_log_since() { as_appdb podman logs --since "$1" "$APPDB_CONTAINER" 2>&1; }
copy_sessions() { new_super -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB' AND usename = '$1'" 2>/dev/null || echo 0; }
LIGNEOUS_QUADLETS=/var/lib/svc-ligneous/.config/containers/systemd
FILE_ROOTS=(/srv/apps /home/momolig/apps)            # where momolig's files that point at it are looked for (M6)
DATABASES_JSON=/var/lib/lfdln-services/databases.json   # where each service's data is, for the Services page (M7)
if [[ -n ${MOVE_TEST:-} ]]; then source "$MOVE_TEST"; fi

APP=${1:-}; STAGE=${2:-}
case $APP in
    tutorstar)
        DB=tutorstar; OWNER=tutorstar; ROLES=(tutorstar); SVC_USER=svc-tutorstar; SERVICE=tutorstar
        SECRETS=(tutorstar-db-url:tutorstar); CONTAINERS=(tutorstar)
        SECRET_FILES=() ;;   # its register-secrets.sh makes the secret from /srv/apps/tutorstar/.env, which moves too
    gonsalves)
        DB=ligneous_frontend; OWNER=ligneous_user; ROLES=(ligneous_user gonsalves_readonly); SVC_USER=svc-ligneous; SERVICE=gonsalves
        SECRETS=(ligneous-db-url:ligneous_user ligneous-db-url-public:gonsalves_readonly); CONTAINERS=(ligneous-public ligneous-admin ligneous-flask-api)
        # sync-podman-secrets.sh makes the secrets again from these: they move with them
        SECRET_FILES=("$LIGNEOUS_QUADLETS/ligneous-db-url" "$LIGNEOUS_QUADLETS/ligneous-db-url-public") ;;
    *) echo "usage: move-db.sh tutorstar|gonsalves plan|copy|compare|rehearse|switch|back" >&2; exit 2 ;;
esac
MOVES=${MOVES:-$APPDB_HOME/moves}                    # root 700: the dumps and what each stage found
SWITCHED=$MOVES/$DB.switched               # there once the app uses the copy: no more copying over it

# SQL on the live database, as postgres over the local socket (read only)
old_sql() { PGOPTIONS='-c default_transaction_read_only=on' old_psql -X -v ON_ERROR_STOP=1 -qtA -d "$DB" "$@"; }
new_sql() { new_super -d "$DB" "$@"; }

new_running || die "$APPDB_CONTAINER isn't running (install-lfdln.sh installs it)"
# on pasta (to-pasta.sh, docs/s1-plan.md S1f) its containers reach :5436 at 127.0.0.1 and not
# :5432 at all: a switch or a way back (secrets at 10.0.2.2) would cut it off
if [[ ($STAGE == switch || $STAGE == back) && -e $MOVES/$APP.pasta ]]; then
    die "$APP is on pasta ($(cat "$MOVES/$APP.pasta")): put it back first (sudo $APPDB_SRC/to-pasta.sh $APP back)"
fi
install -d -m 700 "$MOVES"

# ---------------------------------------------------------------- what is compared
# Each table's rows: how many, and a checksum of every row's text (each row's md5, in
# the order of those md5s -- so neither the collation nor the physical order matters).
# Then what the privileges and owners are: every table, view, sequence and index with
# its owner and ACL, each schema's, each function's, the default privileges, the
# extensions, and what each app role may do with the database itself.
TABLES_SQL="SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1"
# Privileges are compared one by one (aclexplode). MAINTAIN is left out: Postgres 17 has it
# (15 hasn't), and gives it to each table's owner as it gives it every other privilege, so it
# is something the owners gain, never something anyone loses.
acl() { echo "coalesce((SELECT string_agg(coalesce(nullif(pg_get_userbyid(a.grantee), 'unknown (OID=0)'), 'PUBLIC') || '=' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY 1) FROM aclexplode($1) a WHERE a.privilege_type <> 'MAINTAIN'), '-')"; }
shape_sql() {
    cat <<SQL
SET TimeZone = 'Europe/Berlin';
SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' ' || $(acl "coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\", c.relowner))")
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1;
SELECT 'schema ' || nspname || ' ' || pg_get_userbyid(nspowner) || ' ' || $(acl "coalesce(nspacl, acldefault('n'::\"char\", nspowner))")
  FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' ORDER BY 1;
SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_userbyid(p.proowner) || ' ' || $(acl "coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))")
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1;
SELECT 'default ' || pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || ' ' || $(acl d.defaclacl)
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 1;
SELECT 'extension ' || extname FROM pg_extension ORDER BY 1;
SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || contype::text FROM pg_constraint WHERE connamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')) ORDER BY 1;
SELECT 'database ' || r || ' ' || has_database_privilege(r, current_database(), 'CONNECT') || ' ' || has_database_privilege(r, current_database(), 'CREATE') || ' ' || has_database_privilege(r, current_database(), 'TEMP')
  FROM unnest(ARRAY[$(printf "'%s'," "${ROLES[@]}" | sed 's/,$//')]) r ORDER BY 1;
SQL
}
rows_sql() {  # every table's count and checksum, one line each
    local t
    echo "SET TimeZone = 'Europe/Berlin';"
    while read -r t; do
        [[ -n $t ]] || continue
        echo "SELECT '$t ' || count(*) || ' ' || coalesce(md5(string_agg(h, '' ORDER BY h)), '-') FROM (SELECT md5(x::text) h FROM $t x) s;"
    done
}

# ---------------------------------------------------------------- one moment of the live database
# The apps keep writing while a copy is made, so the dump and what it is compared with come
# from the same snapshot: one session, REPEATABLE READ, holds it open (snap_open), pg_dump
# uses it (--snapshot), and the checksums are read inside it (snap_sql). psql runs as a
# coprocess; each answer goes to a file it closes (\o), and a marker file says it is done.
SNAP_DIR=
snap_open() {
    SNAP_DIR=$(mktemp -d); snap_owner "$SNAP_DIR"; chmod 700 "$SNAP_DIR"
    coproc SNAP { old_psql -X -qtA -v ON_ERROR_STOP=1 -d "$DB"; }
    snap_sql "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" "$SNAP_DIR/id"
    SNAP_ID=$(grep -v '^$' "$SNAP_DIR/id" | head -1)
    [[ $SNAP_ID =~ ^[0-9A-F-]+$ ]] || die "couldn't hold a snapshot of $DB open"
}
snap_sql() {  # snap_sql <sql> <out file>: run inside the held snapshot
    local n=$RANDOM$RANDOM i
    printf '\\o %s\n%s\n\\o\n\\! touch %s\n' "$SNAP_DIR/out.$n" "$1" "$SNAP_DIR/done.$n" >&"${SNAP[1]}"
    for i in $(seq 18000); do [[ -e $SNAP_DIR/done.$n ]] && break; kill -0 "$SNAP_PID" 2>/dev/null || die "the snapshot's session ended"; sleep 0.2; done
    [[ -e $SNAP_DIR/done.$n ]] || die "the snapshot's session didn't answer"
    grep -v '^$' "$SNAP_DIR/out.$n" > "$2" || true
}
snap_close() {
    if [[ -n ${SNAP_PID:-} ]]; then printf 'ROLLBACK;\n\\q\n' >&"${SNAP[1]}" 2>/dev/null || true; wait "$SNAP_PID" 2>/dev/null || true; fi
    if [[ -n $SNAP_DIR ]]; then rm -rf "$SNAP_DIR"; fi
    SNAP_PID=; SNAP_DIR=
}

compare_now() {  # compare_now <label> [snapshot]: 0 when everything is the same
    local out=$MOVES/$DB-compare-$(date -u +%Y%m%dT%H%M%SZ)-$1 tables
    LAST_COMPARE=$out
    if [[ ${2:-} == snapshot ]]; then
        snap_sql "$TABLES_SQL;" "$out.old.tables"
        snap_sql "$(rows_sql < "$out.old.tables")" "$out.old.rows"
        snap_sql "$(shape_sql)" "$out.old.shape"
    else
        old_sql -c "$TABLES_SQL" > "$out.old.tables"
        rows_sql < "$out.old.tables" | old_sql > "$out.old.rows"
        shape_sql | old_sql > "$out.old.shape"
    fi
    tables=$(cat "$out.old.tables")
    [[ $(new_sql -c "$TABLES_SQL") == "$tables" ]] || { say FAIL "the copy doesn't have the same tables"; { diff <(echo "$tables") <(new_sql -c "$TABLES_SQL") | head -20 >&2 || true; }; return 1; }
    rows_sql <<<"$tables" | new_sql > "$out.new.rows"
    shape_sql | new_sql > "$out.new.shape"
    local n same=0; n=$(wc -l < "$out.old.rows")
    if ! cmp -s "$out.old.rows" "$out.new.rows"; then
        say FAIL "rows differ in $(diff "$out.old.rows" "$out.new.rows" | grep -c '^<' || true) of $n tables:"
        diff "$out.old.rows" "$out.new.rows" | grep '^[<>]' | head -20 | sed 's/^/         /' >&2 || true
        same=1
    else
        say ok "every table the same: $n tables, $(awk '{s+=$2} END {print s}' "$out.old.rows") rows, each table's checksum"
    fi
    if ! cmp -s "$out.old.shape" "$out.new.shape"; then
        say FAIL "owners or privileges differ ($(diff "$out.old.shape" "$out.new.shape" | grep -c '^[<>]' || true) lines):"
        diff "$out.old.shape" "$out.new.shape" | grep '^[<>]' | head -20 | sed 's/^/         /' >&2 || true
        return 1
    fi
    [[ $same -eq 0 ]] || return 1
    say ok "the same owners, privileges, default privileges, constraints and extensions ($(wc -l < "$out.old.shape") things); ${ROLES[*]} may do with the database what they may today"
    say note "(Postgres 17 gives each table's owner MAINTAIN too -- VACUUM, ANALYZE, REINDEX -- which 15 has no word for)"
    say ok "(what was compared is in $out.*)"
}

# ---------------------------------------------------------------- what else points at it (M6)
# momolig's own files: TutorStar's migrations, Gonsalves's builds and his development.
# (grep -r doesn't follow a link it meets, so a linked file is changed once, at its target.)
own_files() {
    local f
    for f in "${SECRET_FILES[@]}"; do [[ -f $f ]] && grep -qE ":5432/$DB([^A-Za-z0-9_]|$)" "$f" && echo "$f"; done
    grep -rlE "(localhost|127\.0\.0\.1|10\.0\.2\.2):5432/$DB([^A-Za-z0-9_]|$)" "${FILE_ROOTS[@]}" 2>/dev/null \
        --include='.env' --include='.env.*' --include='*.env' --include='*.env.production' | grep -v node_modules | grep -vE '\.(example|before-move)$' | sort || true
}
pass_args() { local r; for r in "${ROLES[@]}"; do printf -- '--pass\n%s=%s\n' "$r" "$1/$r.pass"; done; }
REWRITE="$APPDB_SRC/rewrite-url.py"
to_new() { mapfile -t pa < <(pass_args "$APPDB_PASS"); python3 "$REWRITE" --db "$DB" --from 5432 --to "$APPDB_PORT" "${pa[@]}" "$@"; }
# ...and from a container on pasta (docs/s1-plan.md S1f): 127.0.0.1, its password as it is
to_pasta_url() { python3 "$REWRITE" --db "$DB" --from "$APPDB_PORT" --to "$APPDB_PORT" --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords "$@"; }

db_where() {  # db_where lfdln-appdb|server <port>: what the Services page says of the app's data (M7)
    install -d -m 700 "$(dirname "$DATABASES_JSON")"
    python3 - "$DATABASES_JSON" "$SERVICE" "$DB" "$1" "$2" <<'PY'
import json, os, sys, time
path, service, db, engine, port = sys.argv[1:]
try: d = json.load(open(path))
except FileNotFoundError: d = {}
d[service] = {'database': db, 'engine': engine, 'port': int(port), 'since': int(time.time())}
tmp = path + '.new'
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f: json.dump(d, f, indent=2); f.write('\n')
os.replace(tmp, path)
PY
}
old_read_only() {  # on|off: the old database refuses writes (CONNECT kept, for looking)
    if [[ $1 == on ]]; then
        old_psql -X -qtA -v ON_ERROR_STOP=1 -d postgres >/dev/null <<SQL
ALTER DATABASE "$DB" SET default_transaction_read_only = on;
SQL
        # sessions still open were made before: they end, and any that comes back is read-only
        old_psql -X -qtA -v ON_ERROR_STOP=1 -d postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()"
    else
        old_psql -X -qtA -v ON_ERROR_STOP=1 -d postgres -c "ALTER DATABASE \"$DB\" RESET default_transaction_read_only" >/dev/null
    fi
}

# ---------------------------------------------------------------- undoing a switch that failed part way
# What has been done so far, so a failure can undo it (undo_switch, from the EXIT trap).
UNDO=; STOPPED=; READ_ONLY=; SET_SECRETS=(); REWRITTEN=()
undo_switch() {
    local f n
    say note "putting everything back as it was before the switch"
    for f in "${REWRITTEN[@]}"; do cat "$f.before-move" > "$f" && rm -f "$f.before-move" && say ok "  $f as it was"; done
    for n in "${SET_SECRETS[@]}"; do secret_set "$n" < "$MOVES/secret-$n.before-move" && say ok "  secret $n as it was"; done
    [[ -n $READ_ONLY ]] && old_read_only off && say ok "  $DB on :5432 takes writes again"
    rm -f "$SWITCHED"; db_where server 5432 || true
    if [[ -n $STOPPED ]]; then
        if services_call start; then say ok "  $SERVICE started again, on :5432, and answering"
        else say FAIL "  $SERVICE didn't start again: start it on the Services page, or look at its log there"; fi
    fi
}
REHEARSING=
rehearse_cleanup() {
    rh_stop ligneous-rehearse-public ligneous-rehearse-flask
    rh_secret_rm rehearse-ligneous-db-url rehearse-ligneous-db-url-public
    REHEARSING=
}
on_exit() {
    local rc=$?
    snap_close
    if [[ -n $REHEARSING ]]; then rehearse_cleanup; fi
    if [[ $rc -ne 0 && -n $UNDO ]]; then UNDO=; undo_switch; fi
    return $rc
}
trap on_exit EXIT

# ---------------------------------------------------------------- plan
if [[ $STAGE == plan ]]; then
    echo "=== moving $APP's database ($DB) from :5432 to $APPDB_CONTAINER (:$APPDB_PORT)"
    say note "size $(old_sql -c "SELECT pg_size_pretty(pg_database_size('$DB'))"), $(old_sql -c "$TABLES_SQL" | wc -l) tables, owner $OWNER"
    say note "roles: ${ROLES[*]} (the same names and privileges on the new one, new passwords)"
    say note "connected right now: $(old_sql -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB'") session(s)"
    if [[ -f $SWITCHED ]]; then say note "already switched ($(cat "$SWITCHED"))"
    elif new_sql -c 'SELECT 1' >/dev/null 2>&1; then say note "a copy is there (copy makes it again; compare checks it)"
    else say note "no copy yet: move-db.sh $APP copy"; fi
    say note "at the switch: the services helper stops $SERVICE; its podman secret(s) get the new address (10.0.2.2:$APPDB_PORT) and password:"
    for s in "${SECRETS[@]}"; do
        n=${s%%:*}
        if v=$(secret_get "$n" 2>/dev/null); then
            shown=$(sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#' <<<"$v")
            if to_new --check <<<"$v" >/dev/null 2>&1; then say ok "  $n: $shown -- the switch can change it"
            else say FAIL "  $n: $shown -- no URL for $DB on :5432 the switch could change"; fi
        else say FAIL "  $n: can't be read as $SVC_USER"; fi
    done
    for c in "${CONTAINERS[@]}"; do
        if reach "$c" "$APPDB_PORT"; then say ok "  $c can reach 10.0.2.2:$APPDB_PORT"; else say FAIL "  $c can't reach 10.0.2.2:$APPDB_PORT (is it running?)"; fi
    done
    say note "files that point at it on :5432 (yours, and those its secrets are made from; the switch rewrites them, each kept as .before-move):"
    own_files | sed 's/^/         /'
    exit 0
fi

# ---------------------------------------------------------------- copy
# The copy afresh, and every table compared with the live database at the moment it was
# dumped. Used by `copy` (the dry run) and by `switch` (with the app stopped).
make_copy() {  # make_copy <label>
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    dump=$MOVES/$DB-$stamp.dump
    t0=$(date +%s)
    snap_open
    old_dump -Fc --snapshot="$SNAP_ID" -d "$DB" > "$dump.part"
    mv "$dump.part" "$dump"; chmod 600 "$dump"
    say ok "dumped $DB from :5432 ($(du -h "$dump" | cut -f1), $(( $(date +%s) - t0 ))s; $dump)"
    # ka-shifted: spaces and punctuation don't count on the first pass, as with glibc's de_DE on
    # :5432 ("da Silva", "D'Souza", "(unknown)"); plain ICU de-DE put them elsewhere and the
    # Gonsalves rehearsal's name lists came out in another order (2026-09-27)
    # the copy afresh: German sorting as on :5432 (Q3), its owner, and exactly the
    # rights each app role has on the database today -- given to it by name, none to PUBLIC
    new_super <<SQL >/dev/null
SET client_min_messages = warning;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB';
DROP DATABASE IF EXISTS "$DB";
CREATE DATABASE "$DB" OWNER "$OWNER" TEMPLATE template0 ENCODING 'UTF8'
    LOCALE_PROVIDER icu ICU_LOCALE 'de-DE-u-ka-shifted' LOCALE 'C.UTF-8';
REVOKE ALL ON DATABASE "$DB" FROM PUBLIC;
SQL
    for r in "${ROLES[@]}"; do
        privs=$(old_sql -c "SELECT concat_ws(',', CASE WHEN has_database_privilege('$r', '$DB', 'CONNECT') THEN 'CONNECT' END,
                                                   CASE WHEN has_database_privilege('$r', '$DB', 'CREATE') THEN 'CREATE' END,
                                                   CASE WHEN has_database_privilege('$r', '$DB', 'TEMP') THEN 'TEMP' END)")
        [[ -n $privs ]] && echo "GRANT $privs ON DATABASE \"$DB\" TO \"$r\";" | new_super >/dev/null
    done
    t0=$(date +%s)
    new_restore --exit-on-error --single-transaction -d "$DB" < "$dump" \
        || { say FAIL "pg_restore refused the dump (the copy is incomplete)"; return 1; }
    echo 'ANALYZE;' | new_sql >/dev/null
    say ok "restored into $APPDB_CONTAINER (ICU de-DE-u-ka-shifted, $(( $(date +%s) - t0 ))s)"
    compare_now "$1" snapshot || return 1
    snap_close
    echo "copied $stamp" > "$MOVES/$DB.copied"
}

if [[ $STAGE == copy ]]; then
    [[ -f $SWITCHED ]] && die "$APP already uses the copy ($(cat "$SWITCHED")): copying again would throw away what it wrote since"
    make_copy copy || die "the copy isn't the same as the live database was at the dump (see above); nothing live was touched"
    exit 0
fi

# ---------------------------------------------------------------- compare
if [[ $STAGE == compare ]]; then
    new_sql -c 'SELECT 1' >/dev/null 2>&1 || die "no copy yet: move-db.sh $APP copy"
    if [[ -f $SWITCHED ]]; then say note "$APP uses the copy since $(cut -d' ' -f2- "$SWITCHED"): only what it wrote since should differ"
    else say note "(the app is running: a table it wrote to since the copy differs; copy itself compares within one moment)"; fi
    compare_now compare
    exit $?
fi


# ---------------------------------------------------------------- rehearse (Gonsalves)
# The same images as live, as svc-ligneous, on a fresh copy: the Flask API on :5101 and the
# public site on :3139 (its Flask calls go to the rehearsal's, so every read is the copy's).
# Each page and API path is asked of the live site and of the rehearsal: the same status, and
# where the live one answers the same twice, the same bytes -- Postgres 17 and German sorting
# with Prisma and the Flask API's driver, before anything switches. Where the bytes differ,
# compare-answers.py says how: a fresh copy keeps rows in a new order on disk, so a query with
# no ORDER BY gives them in another order, and one cut by LIMIT among ties (frequency DESC)
# other rows tied at the cut-off; those pass, said as notes. REHEARSE_EXACT are sorted by
# name with a tiebreaker (German sorting): they must match byte for byte. Both answers of
# every difference are kept in $MOVES. Then the copy's Postgres log since the start must
# have no ERROR or FATAL. Nothing live is stopped or changed.
REHEARSE_PAGES=(/ /surnames /individuals /families /search "/search?q=Gonsalves" /people /dates /given-names /stories /media /albums)
REHEARSE_APIS=(/api/trees /api/tree/surnames /api/tree/given-names /api/tree/places /api/tree/families /api/tree/dates /api/tree/events
    /api/tree/events/upcoming /api/tree/whats-new /api/tree/media-tags /api/tree/individual-picker "/api/tree/individual-picker?q=Maria"
    "/api/tree/individuals?q=Gon" "/api/tree/individuals?q=M%C3%BCller" "/api/tree/places-search?q=Goa" "/api/tree/advanced-search/general?q=Gonsalves")
REHEARSE_STATUS_ONLY=(/api/tree/home-statistics /api/tree/random/individual)    # different at every ask
REHEARSE_EXACT=(/individuals /api/tree/individual-picker "/api/tree/individual-picker?q=Maria")   # by full_name_lower, xref
if [[ $STAGE == rehearse ]]; then
    [[ $APP == gonsalves ]] || die "only Gonsalves has a rehearsal (docs/data-move-plan.md M5)"
    [[ -f $SWITCHED ]] && die "$APP already uses lfdln-appdb ($(cat "$SWITCHED"))"
    echo "=== rehearsing $APP on a fresh copy in $APPDB_CONTAINER (:$APPDB_PORT); nothing live changes"
    make_copy rehearse || die "the copy isn't the same as the live database (see above)"
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    REHEARSING=1
    for s in "${SECRETS[@]}"; do
        n=${s%%:*}
        secret_get "$n" | to_new | to_pasta_url | secret_set "rehearse-$n" || die "couldn't make the rehearsal's secret from $n"
    done
    ENVF=/var/lib/svc-ligneous/env/ligneous.env
    # on pasta (docs/s1-plan.md S1f): the copy's port, and the public site the rehearsal's Flask API
    rh_run --name ligneous-rehearse-flask --network "$(pasta_net "$APPDB_PORT")" -p 127.0.0.1:5101:5001 \
        --env-file "$ENVF" --secret rehearse-ligneous-db-url,type=env,target=DATABASE_URL localhost/flask-api:prod \
        || die "the rehearsal's Flask API didn't start"
    rh_run --name ligneous-rehearse-public --network "$(pasta_net "$APPDB_PORT" 5101)" -p 127.0.0.1:3139:3039 \
        --env-file "$ENVF" --secret rehearse-ligneous-db-url-public,type=env,target=DATABASE_URL \
        -e PORT=3039 -e HOSTNAME=0.0.0.0 -e PYTHON_API_URL=http://127.0.0.1:5101 -e MEDIA_FILES_ROOT=/mnt/storage/uploads \
        -v /mnt/storage/uploads:/mnt/storage/uploads:ro localhost/public:prod \
        || die "the rehearsal's public site didn't start"
    W=$(mktemp -d); trap 'rc=$?; rm -rf "$W"; (exit $rc); on_exit' EXIT
    KEPT=$MOVES/$DB-rehearse-$(date -u +%Y%m%dT%H%M%SZ)          # both answers of each that differs
    up=
    for _ in $(seq 90); do
        [[ $(http_get 5101 /api/health "$W/h1") == 200 && $(http_get 3139 / "$W/h2") == 200 ]] && { up=1; break; }
        sleep 2
    done
    [[ -n $up ]] || die "the rehearsal didn't answer within 3 minutes (logs: podman logs ligneous-rehearse-public, as svc-ligneous)"
    say ok "the rehearsal answers: public site :3139, Flask API :5101, both on the copy"

    # three people, picked by the live site, asked of both
    people=()
    for _ in 1 2 3; do
        http_get 3039 /api/tree/random/individual "$W/r" >/dev/null
        x=$(python3 -c 'import json, sys, urllib.parse; print(urllib.parse.quote(json.load(open(sys.argv[1]))["individual"]["xref"]))' "$W/r" 2>/dev/null) || continue
        people+=("/api/tree/individuals/$x/ancestors" "/api/tree/individuals/$x/descendants")
    done
    bad=0 same=0 asked=0 reordered=0
    ask() {  # ask <path> bytes|status
        local a b how k e
        asked=$((asked + 1))
        a=$(http_get 3039 "$1" "$W/live"); b=$(http_get 3139 "$1" "$W/new")
        if [[ $a != "$b" ]]; then say FAIL "  $1: $a live, $b in the rehearsal"; bad=$((bad + 1)); return; fi
        if [[ $b == 5* ]]; then say FAIL "  $1: $b from both"; bad=$((bad + 1)); return; fi
        if [[ $2 == bytes ]]; then
            # only where the live site answers the same twice (else it is time or chance, not the database)
            http_get 3039 "$1" "$W/live2" >/dev/null
            if cmp -s "$W/live" "$W/live2" && ! cmp -s "$W/live" "$W/new"; then
                install -d -m 700 "$KEPT"; k=$KEPT/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
                cp "$W/live" "$k.live"; cp "$W/new" "$k.new"
                e=
                for x in "${REHEARSE_EXACT[@]}"; do [[ $x == "$1" ]] && e=1; done
                if [[ -z $e ]] && how=$(python3 "$(dirname "$(readlink -f "$0")")/compare-answers.py" "$W/live" "$W/new"); then
                    say note "  $1: the same answer in another order ($(awk '$1 == "order" { o++ } $1 == "ties" { t = t sprintf("%s%s other row(s) tied at %s in %s", (o || t) ? "; " : "", $4, $3, $2) }
                        END { printf "%s%s", o ? o " list(s) reordered" : "", t }' <<<"$how"))"
                    reordered=$((reordered + 1)); return
                fi
                say FAIL "  $1: $a from both, but different answers ($(wc -c < "$W/live") and $(wc -c < "$W/new") bytes)${e:+; sorted by name, so it must be the same bytes}"
                [[ -z $e ]] && grep '^differ' <<<"$how" | head -3 | sed 's/^/         /'
                say note "    both answers: $k.live, .new"
                bad=$((bad + 1)); return
            fi
            cmp -s "$W/live" "$W/new" && same=$((same + 1))
        fi
    }
    for p in "${REHEARSE_PAGES[@]}" "${REHEARSE_APIS[@]}" "${people[@]}"; do ask "$p" bytes; done
    for p in "${REHEARSE_STATUS_ONLY[@]}"; do ask "$p" status; done
    [[ $(http_get 5101 /api/health "$W/f") == "$(http_get 5001 /api/health "$W/g")" ]] || { say FAIL "  the Flask API's /api/health differs"; bad=$((bad + 1)); }
    [[ $bad -eq 0 ]] && say ok "$asked addresses asked of both: the same status each, $same of them the same bytes too$( [[ $reordered -gt 0 ]] && echo ", $reordered the same answer in another order")"

    # they really used the copy: its sessions, then its log
    n=$(copy_sessions gonsalves_readonly)
    [[ $n -gt 0 ]] && say ok "the public site is connected to the copy as gonsalves_readonly ($n session(s))" \
        || { say FAIL "no session of gonsalves_readonly on the copy: the rehearsal may not have used it"; bad=$((bad + 1)); }
    errs=$(appdb_log_since "$since" | grep -E '(ERROR|FATAL|PANIC):' || true)
    if [[ -n $errs ]]; then
        say FAIL "the copy's Postgres logged $(wc -l <<<"$errs") error(s) during the rehearsal:"; head -10 <<<"$errs" | sed 's/^/         /'; bad=$((bad + 1))
    else say ok "the copy's Postgres logged no errors during the rehearsal"; fi

    rehearse_cleanup
    say ok "the rehearsal's containers and secrets are gone"
    [[ $bad -eq 0 ]] || die "the rehearsal found $bad difference(s) (above): the switch refuses until it passes (run it again if the live site changed meanwhile)"
    echo "rehearsed $(date -u +%Y-%m-%dT%H:%M:%SZ) $asked addresses" > "$MOVES/$DB.rehearsed"
    say ok "rehearsed: move-db.sh $APP switch may run now"
    exit 0
fi

# ---------------------------------------------------------------- switch (the downtime)
if [[ $STAGE == switch ]]; then
    [[ -f $SWITCHED ]] && die "$APP already uses lfdln-appdb ($(cat "$SWITCHED"))"
    [[ -f $MOVES/$DB.copied ]] || die "copy first (move-db.sh $APP copy): a dry run should have passed before the switch"
    if [[ $APP == gonsalves && ! -f $MOVES/$DB.rehearsed ]]; then die "rehearse first (docs/data-move-plan.md step 3): the public site against the copy, before it switches"; fi
    echo "=== switching $APP to $APPDB_CONTAINER (:$APPDB_PORT)"

    # --- before anything stops: every secret and file it will change can be changed
    for s in "${SECRETS[@]}"; do
        n=${s%%:*}
        ( umask 077; secret_get "$n" > "$MOVES/secret-$n.before-move" ) || die "couldn't read $SVC_USER's secret $n"
        to_new --check < "$MOVES/secret-$n.before-move" >/dev/null || die "the secret $n has no URL for $DB on :5432 it can change (nothing was changed)"
    done
    say ok "secrets readable, each with its URL: $(printf '%s ' "${SECRETS[@]%%:*}")(as they are now: $MOVES/secret-*.before-move)"
    mapfile -t FILES < <(own_files)
    for f in "${FILES[@]}"; do
        [[ -e $f.before-move ]] && die "$f.before-move is there already: move it away first (nothing was changed)"
        to_new --check --file "$f" >/dev/null || die "$f: its URL can't be changed (nothing was changed)"
    done
    say ok "${#FILES[@]} file(s) of yours to point at :$APPDB_PORT"
    for c in "${CONTAINERS[@]}"; do
        reach "$c" "$APPDB_PORT" || die "$c can't reach 10.0.2.2:$APPDB_PORT from inside its container (nothing was changed)"
    done
    say ok "$(printf '%s ' "${CONTAINERS[@]}")can reach 10.0.2.2:$APPDB_PORT"
    # (2026-09-27: svc-ligneous's ~/.config/systemd/user was root's; the helper stopped Gonsalves,
    # couldn't mask it, and said it couldn't stop it)
    can_mask || die "$SVC_USER can't write its ~/.config/systemd/user, so the services helper couldn't keep $SERVICE stopped: sudo chown $SVC_USER: it (nothing was changed)"
    say ok "$SVC_USER's systemd can keep it stopped (~/.config/systemd/user is its own)"

    # --- the downtime
    t0=$(date +%s)
    UNDO=1
    STOPPED=1       # before: a stop that fails part way may have stopped some of it, and start is harmless
    services_call stop || die "the services helper couldn't stop $SERVICE"
    say ok "$SERVICE stopped (the services helper)"
    READ_ONLY=1; ended=$(old_read_only on)
    say ok "$DB on :5432 is read-only now ($ended session(s) of someone else's ended; any that comes back can read, not write)"
    make_copy switch || die "the copy isn't the same as the old database"
    for s in "${SECRETS[@]}"; do
        n=${s%%:*}
        to_new < "$MOVES/secret-$n.before-move" | secret_set "$n" || die "couldn't change the secret $n"
        SET_SECRETS+=("$n")
    done
    say ok "secrets point at 10.0.2.2:$APPDB_PORT, with the new passwords: ${SET_SECRETS[*]}"
    : > "$MOVES/$DB.files"
    for f in "${FILES[@]}"; do
        cp -p "$f" "$f.before-move"
        REWRITTEN+=("$f")
        to_new --file "$f" || die "couldn't change $f"
        echo "$(sha256sum "$f" | cut -d' ' -f1) $f" >> "$MOVES/$DB.files"
        say ok "  $f (as it was: $f.before-move)"
    done
    echo "switched $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SWITCHED"
    db_where lfdln-appdb "$APPDB_PORT"
    services_call start || die "$SERVICE didn't come up on lfdln-appdb"
    UNDO=
    say ok "$SERVICE started on lfdln-appdb, and answering"
    # answering isn't using the database (TutorStar's health is /): look for its sessions
    roles_in=$(printf "'%s'," "${ROLES[@]}" | sed 's/,$//')
    for _ in $(seq 15); do
        n=$(new_super -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB' AND usename IN ($roles_in)" 2>/dev/null || echo 0)
        [[ $n -gt 0 ]] && break; sleep 2
    done
    if [[ $n -gt 0 ]]; then say ok "$SERVICE is connected to lfdln-appdb ($n session(s))"
    else say note "no session from $SERVICE on lfdln-appdb yet (it may connect at its first request): open the site once and sign in"; fi
    say ok "downtime: $(( $(date +%s) - t0 ))s"
    say note "$DB stays on :5432, read-only, as the way back: move-db.sh $APP back (until 14 days from now)"
    say note "anything of yours that was connected to it (a dev server) needs a restart to read its new .env"
    exit 0
fi

# ---------------------------------------------------------------- back (the way back)
if [[ $STAGE == back ]]; then
    [[ -f $SWITCHED ]] || die "$APP isn't switched: it uses :5432 already"
    echo "=== $APP back to :5432 (it has used lfdln-appdb since $(cut -d' ' -f2- "$SWITCHED"))"
    for s in "${SECRETS[@]}"; do [[ -s $MOVES/secret-${s%%:*}.before-move ]] || die "the secret ${s%%:*} as it was before the switch is missing ($MOVES)"; done
    say note "what $APP wrote since the switch (it stays in lfdln-appdb's copy, and isn't on :5432):"
    if compare_now back >/dev/null 2>&1; then say ok "nothing: the two are the same"
    else
        if [[ -s $LAST_COMPARE.new.rows ]]; then
            say note "$(diff "$LAST_COMPARE.old.rows" "$LAST_COMPARE.new.rows" | grep -c '^<' || true) table(s) differ; each, with its rows on :5432 -> in lfdln-appdb:"
            join <(sort "$LAST_COMPARE.old.rows") <(sort "$LAST_COMPARE.new.rows") | awk '$3 != $5 { printf "         %s  %s -> %s\n", $1, $2, $4 }'
        else
            say note "the tables themselves differ (a migration since the switch?): $(diff <(cat "$LAST_COMPARE.old.tables") <(new_sql -c "$TABLES_SQL") | grep -c '^[<>]' || true) line(s)"
        fi
        if [[ -z ${MOVE_YES:-} ]]; then
            read -r -p "  go back anyway, leaving that behind? type back: " a </dev/tty
            [[ $a == back ]] || die "not going back; nothing was changed"
        fi
    fi
    can_mask || die "$SVC_USER can't write its ~/.config/systemd/user, so the services helper couldn't keep $SERVICE stopped: sudo chown $SVC_USER: it (nothing was changed)"
    t0=$(date +%s)
    if ! services_call stop; then
        services_call start || true     # it may have stopped part way
        die "the services helper couldn't stop $SERVICE (nothing was changed; it was started again, still on lfdln-appdb)"
    fi
    for s in "${SECRETS[@]}"; do n=${s%%:*}; secret_set "$n" < "$MOVES/secret-$n.before-move" || die "couldn't put the secret $n back"; done
    say ok "secrets as they were before the switch: $(printf '%s ' "${SECRETS[@]%%:*}")"
    while read -r sum f; do
        [[ -n $f ]] || continue
        if [[ ! -e $f.before-move ]]; then say note "  $f: its copy from before the switch is gone; left as it is"
        elif [[ $(sha256sum "$f" | cut -d' ' -f1) == "$sum" ]]; then cat "$f.before-move" > "$f"; rm -f "$f.before-move"; say ok "  $f as it was"
        else say note "  $f changed since the switch: left as it is; its old URL is in $f.before-move"; fi
    done < "$MOVES/$DB.files"
    old_read_only off
    say ok "$DB on :5432 takes writes again"
    mv "$SWITCHED" "$MOVES/$DB.switched-back-$(date -u +%Y%m%dT%H%M%SZ)"
    db_where server 5432
    services_call start || die "$SERVICE didn't start again on :5432: start it on the Services page, or look at its log there"
    say ok "$SERVICE started on :5432, and answering; downtime $(( $(date +%s) - t0 ))s"
    say note "move-db.sh $APP copy makes the copy afresh before another switch"
    exit 0
fi

echo "usage: move-db.sh tutorstar|gonsalves plan|copy|compare|rehearse|switch|back" >&2
exit 2
