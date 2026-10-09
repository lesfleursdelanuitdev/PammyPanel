#!/usr/bin/env bash
# Check the panel's and the gate's Postgres (docs/postgres-plan.md) the way the
# services will use it: over 127.0.0.1:5434, as each role, with its password.
#
#   sudo ~/pamela-setup/panel/deploy/pg/verify-pg.sh
#
# Changes nothing lasting: its test tables are made and dropped straight away.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-pg.sh"

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
t() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
t_no() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
eq() { local d=$1 want=$2; shift 2; local got; got=$("$@" 2>/dev/null); [[ $got == "$want" ]] && ok "$d" || bad "$d (got: ${got:-nothing}, want: $want)"; }
t_ctl() { [[ "$(svc_ctl is-"$1" "$2" 2>/dev/null)" == "$3" ]]; }
q_super() { echo "$1" | pg_super -d "$PG_DB"; }
q_srv() { echo "$1" | pg_super; }   # the server's own settings (default database)
psql_pw() {  # psql_pw <user> <password> <db> -- a login attempt from this server
    PGPASSWORD="$2" PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p "$PG_PORT" -U "$1" -d "$3" -c 'SELECT 1'
}

echo "--- the container ($SVC)"
t "$CONTAINER is running" t_ctl active "$CONTAINER.service" active
t "$CONTAINER is healthy" as_svc podman healthcheck run "$CONTAINER"
pid=$(as_svc podman inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null)
uid=$(ps -o uid= -p "${pid:-1}" | tr -d ' ')
[[ -n $pid && $uid != 0 ]] && ok "$CONTAINER is not root on the host (uid $uid)" || bad "$CONTAINER runs as host uid ${uid:-?}"
eq "$CONTAINER has a 1G memory cap" 1073741824 svc_ctl show -p MemoryMax --value "$CONTAINER.service"
t "it starts again after a reboot (linger)" test -e "/var/lib/systemd/linger/$SVC"
eq "Postgres 17" 17 q_srv 'SELECT current_setting($$server_version_num$$)::int / 10000'
eq "it uses our pg_hba.conf" /etc/pammy-pg/pg_hba.conf q_srv 'SHOW hba_file'
eq "pg_hba.conf has no errors" 0 q_srv 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL'
eq "the engine sees the installed pg_hba.conf (its folder is mounted, not the file)" "$(grep -cE '^(local|host)' "$SVC_HOME/conf/pg_hba.conf")" q_srv 'SELECT count(*) FROM pg_hba_file_rules'
eq "passwords are stored as scram-sha-256" scram-sha-256 q_srv 'SHOW password_encryption'

echo "--- only reachable from this server"
addrs=$(ss -ltnH "sport = :$PG_PORT" | awk '{print $4}' | sort -u | tr '\n' ' ')
[[ $addrs == "127.0.0.1:$PG_PORT " ]] && ok "port $PG_PORT listens on 127.0.0.1 only" || bad "port $PG_PORT listens on: ${addrs:-nothing}"

echo "--- the password files"
t "$PASS_DIR is root's alone (700)" bash -c "[[ \$(stat -c '%a %U' $PASS_DIR) == '700 root' ]]"
for r in "${ROLES[@]}"; do
    t "$r.pass: root 600, not empty" bash -c "[[ \$(stat -c '%a %U' $PASS_DIR/$r.pass) == '600 root' && -s $PASS_DIR/$r.pass ]]"
    t "$r.pass matches its podman secret" bash -c "[[ \"\$(cat $PASS_DIR/$r.pass)\" == \"\$(source $PGSRC/lib-pg.sh; secret_of pammy-pg-$r)\" ]]"
done
t_no "nobody else can read them" runuser -u nobody -- cat "$PASS_DIR/panel.pass"
t_no "pamela can't read them" runuser -u pamela -- cat "$PASS_DIR/panel.pass"

echo "--- who may connect"
for r in "${ROLES[@]}"; do t "pammy_$r signs in to $PG_DB with its password" pg_as "$r" -c 'SELECT 1'; done
t_no "a wrong password is refused" psql_pw pammy_panel wrong-password "$PG_DB"
t_no "pammy_panel can't use another database (postgres)" psql_pw pammy_panel "$(cat "$PASS_DIR/panel.pass")" postgres
spw=$(secret_of pammy-pg-super 2>/dev/null)
t_no "the superuser can't sign in over the network, even with its password" psql_pw postgres "$spw" "$PG_DB"
t_no "a role that isn't ours is refused (pamela)" psql_pw pamela anything "$PG_DB"
eq "PUBLIC has no rights on $PG_DB" 0 q_super "SELECT count(*) FROM pg_database, aclexplode(datacl) a WHERE datname = '$PG_DB' AND a.grantee = 0"
eq "no pammy role is superuser, CREATEDB, CREATEROLE or BYPASSRLS" 0 \
    q_super "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pammy\_%' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)"
eq "the gate has a 2s statement timeout" 2s pg_as gate -c 'SHOW statement_timeout'
eq "the panel has a 15s statement timeout" 15s pg_as panel -c 'SHOW statement_timeout'

echo "--- the database"
eq "$PG_DB is owned by pammy_owner" pammy_owner q_super "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$PG_DB'"
eq "UTF8, builtin C.UTF-8 (sorts like SQLite)" "UTF8|b|C.UTF-8" \
    q_super "SELECT pg_encoding_to_char(encoding), datlocprovider, datlocale FROM pg_database WHERE datname = '$PG_DB'"
eq "schemas panel, media, gate owned by pammy_owner" "gate|media|panel" \
    q_super "SELECT string_agg(nspname, '|' ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('panel','media','gate') AND pg_get_userbyid(nspowner) = 'pammy_owner'"
t_no "nobody but the owner can make things in public" pg_as panel -c 'CREATE TABLE public.zz_verify (x int)'

echo "--- who may do what (a test table in each schema, made by the owner as a migration would)"
pg_as owner -c "CREATE TABLE panel.zz_verify (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, x int);
                CREATE TABLE media.zz_verify (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, x int);
                CREATE TABLE gate.zz_verify (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, x int);" >/dev/null 2>&1 \
    && ok "the owner can make tables in all three" || bad "the owner can't make tables"
for s in panel media; do
    t "the panel can read and write $s (new tables, no extra GRANT)" pg_as panel -c "INSERT INTO $s.zz_verify (x) VALUES (1); UPDATE $s.zz_verify SET x = 2; SELECT * FROM $s.zz_verify; DELETE FROM $s.zz_verify"
    t_no "the gate can't read $s" pg_as gate -c "SELECT * FROM $s.zz_verify"
done
t "the gate can read and write gate" pg_as gate -c "INSERT INTO gate.zz_verify (x) VALUES (1); UPDATE gate.zz_verify SET x = 2; SELECT * FROM gate.zz_verify; DELETE FROM gate.zz_verify"
t_no "the panel can't read gate (it goes through the admin socket)" pg_as panel -c 'SELECT * FROM gate.zz_verify'
t_no "the panel can't change a table's shape" pg_as panel -c 'ALTER TABLE panel.zz_verify ADD COLUMN y int'
t_no "the gate can't drop a table" pg_as gate -c 'DROP TABLE gate.zz_verify'
t_no "the panel can't make tables" pg_as panel -c 'CREATE TABLE panel.zz_verify2 (x int)'
t_no "the panel can't TRUNCATE" pg_as panel -c 'TRUNCATE panel.zz_verify'
pg_as owner -c 'DROP TABLE panel.zz_verify, media.zz_verify, gate.zz_verify' >/dev/null 2>&1 \
    && ok "test tables dropped" || bad "couldn't drop the zz_verify test tables"

echo "--- backups"
t "nightly backup timer is on" t_ctl enabled pammy-pg-backup.timer enabled
t "container auto-update timer is on" t_ctl enabled podman-auto-update.timer enabled
t "$BACKUPS is $SVC's alone (700)" bash -c "[[ \$(stat -c '%a %U' $BACKUPS) == '700 $SVC' ]]"
latest=$(ls -1t "$BACKUPS"/pammy-*.dump 2>/dev/null | head -1)
[[ -n $latest ]] && ok "a backup exists ($(basename "$latest"))" || bad "no backup in $BACKUPS"
if [[ -n $latest ]]; then
    t "it is less than 2 days old" bash -c "[[ \$(( \$(date +%s) - \$(stat -c %Y '$latest') )) -lt 172800 ]]"
    as_svc podman exec -i -u postgres "$CONTAINER" pg_restore --list < "$latest" >/dev/null 2>&1 \
        && ok "pg_restore can read it" || bad "pg_restore can't read $latest"
fi

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
