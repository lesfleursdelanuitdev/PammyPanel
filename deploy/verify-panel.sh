#!/usr/bin/env bash
# Check the live control panel for real (the local tests can't reach these):
#   - svc-pammypanel owns nothing but its database, and can't reach her files
#   - the service's sandbox is actually in force
#   - only Cloudflare can reach panel.pammy.org; the neighbours are unaffected
#   - the gate: its sandbox, and a real protected folder signed into through Cloudflare
#
#   sudo ~/pamela-setup/panel/deploy/verify-panel.sh
# Changes nothing.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
D="$(dirname "$(readlink -f "$0")")"
SETUP="$(readlink -f "$D/../..")"          # ~/pamela-setup
SVC=svc-pammypanel
SVC_HOME=/var/lib/svc-pammypanel
APP=/opt/pammy-panel
PORT=3044
# the panel's own Postgres (docs/postgres-plan.md), where everything lives now
PGSVC=svc-pammypanel-db
PASS_DIR=/etc/pammy-panel/db
pg() {  # pg <sql> -- as pammy_owner; one line per row, columns joined by |
    PGPASSWORD="$(cat "$PASS_DIR/owner.pass")" PGCONNECT_TIMEOUT=5 \
        psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p 5434 -U pammy_owner -d pammy -c "$1"
}
pg_role() {  # pg_role <role> <sql> -- as pammy_panel or pammy_gate, to prove what they can't do
    PGPASSWORD="$(cat "$PASS_DIR/$1.pass")" PGCONNECT_TIMEOUT=5 \
        psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p 5434 -U "pammy_$1" -d pammy -c "$2"
}
# node as the panel's user, with the database password on fd 3 -- exactly how
# /usr/local/sbin/pammy-panel hands it over
pnode() {  # pnode <module source> [args...]
    local src=$1; shift
    (cd / && exec 3<"$PASS_DIR/panel.pass"
     runuser -u "$SVC" -- env -i PATH=/usr/bin:/bin PANEL_PG_PASSWORD_FD=3 PANEL_PG_HOST=127.0.0.1 PANEL_PG_PORT=5434 PANEL_PG_DATABASE=pammy \
        PANEL_ORIGIN=https://panel.pammy.org PANEL_SITEFS_SOCKET=/run/pammy-sitefs.sock PANEL_THUMBS_SOCKET=/run/pammy-thumbs.sock \
        PANEL_THUMBS_DIR=/var/lib/pammy-media-public/thumbs PANEL_MEDIA_PUBLIC=/var/lib/pammy-media-public \
        /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "$src" "$@")
}
ORIGIN_IP=203.0.113.200

pass=0 fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  note  %s\n' "$1"; }
t_ok() { local l=$1; shift; if "$@" >/dev/null 2>&1; then ok "$l"; else bad "$l"; fi; }
t_no() { local l=$1; shift; if "$@" >/dev/null 2>&1; then bad "$l"; else ok "$l"; fi; }
as_s() { (cd / && runuser -u "$SVC" -- sh -c "$1"); }

# a sandboxed service killed mid-request (e.g. a syscall its filter forbids: SIGSYS)
# is restarted by systemd and can look like an unrelated failure; count them
SANDBOXED="pammy-panel pammy-sitefs pammy-thumbs pammy-pammydb pammy-pammydb-gate pammy-gate pammy-apps pammy-mail"
restarts() { local u; for u in $SANDBOXED; do printf '%s=%s ' "$u" "$(systemctl show "$u" -p NRestarts --value)"; done; }
restarts_before=$(restarts)
echo "=== control panel (https://panel.pammy.org)"
echo "--- identity"
t_ok "system user $SVC exists"                 id "$SVC"
t_ok "$SVC has no login shell"                 test "$(getent passwd "$SVC" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$SVC is NOT in sudo"                     sh -c "id -nG $SVC | tr ' ' '\n' | grep -qx sudo"
t_ok "its home is 700 and its own"             test "$(stat -c '%U %a' "$SVC_HOME")" = "$SVC 700"

echo "--- the database (Postgres, 127.0.0.1:5434)"
t_ok "the panel's own Postgres answers"              pg "SELECT 1"
t_ok "the container is running"                      systemctl --user -M "$PGSVC@" is-active -q pammy-pg
t_ok "it listens on 127.0.0.1 only"                  sh -c "ss -ltnH 'sport = :5434' | awk '{print \$4}' | sort -u | grep -qx 127.0.0.1:5434"
mig=$(pg "SELECT count(*) FROM public.schema_migrations" 2>/dev/null || echo 0)
[[ ${mig:-0} -ge 3 ]] && ok "the schema is migrated ($mig migrations)" || bad "migrations: ${mig:-none} (run deploy/install-panel.sh)"
# the live schema is exactly what the migrations make (db/schema.snapshot.sql, the
# same file test/pg.test.ts checks a fresh database against): nothing made by hand,
# nothing a migration left half done. pg_dump runs inside the container, so it is
# the server's own version.
live_schema=$( (cd / && runuser -u "$PGSVC" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$PGSVC")" HOME="/var/lib/$PGSVC"         podman exec -u postgres pammy-pg pg_dump --schema-only -d pammy) 2>/dev/null     | /usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/schema-snapshot.ts")
if [[ -n $live_schema ]] && diff -q <(printf '%s\n' "$live_schema") "$APP/db/schema.snapshot.sql" >/dev/null; then
    ok "the live schema is db/schema.snapshot.sql ($(grep -c '^CREATE TABLE' "$APP/db/schema.snapshot.sql") tables)"
else
    bad "the live schema is not db/schema.snapshot.sql:"
    diff <(printf '%s\n' "$live_schema") "$APP/db/schema.snapshot.sql" | head -40 | sed 's/^/        /'
fi
t_no "panel.media_notes is gone (migration 0016)"     pg "SELECT 1 FROM panel.media_notes LIMIT 0"
# the catalog (docs/catalog-plan.md steps 2-3): her files are its items, media's tables are gone
t_ok "the catalog took the media records over (catalog/0001-catalog.sql)"  test "$(pg "SELECT count(*) FROM public.schema_migrations WHERE name = 'catalog/0001-catalog.sql'")" = 1
t_ok "every website file is an item with its file columns"  test "$(pg "SELECT (SELECT count(*) FROM catalog.items WHERE resource_id = 1) = (SELECT count(*) FROM files.files)")" = t
t_ok "every label is in a scope under All, the website's"   test "$(pg "SELECT count(*) FROM catalog.labels l JOIN catalog.scopes s ON s.id = l.scope_id WHERE s.source_id IS DISTINCT FROM 1 AND s.parent_id IS NOT NULL")" = 0
t_ok "the panel can read and write the catalog"      pg_role panel "SELECT count(*) FROM catalog.items, catalog.labels, files.files, thumbs.thumbs LIMIT 1"
t_no "the gate can NOT read the catalog"             pg_role gate "SELECT count(*) FROM catalog.items"
t_ok "media's old tables are gone (catalog/0002, step 3)"  test "$(pg "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'media'")" = 0
# Studio tables as sources (step 4): a table's source goes with it, and the gate's touches are the gate's
t_ok "Studio tables can be sources (catalog/0003, studio/0001)"  test "$(pg "SELECT count(*) FROM public.schema_migrations WHERE name IN ('catalog/0003-studio-sources.sql', 'studio/0001-catalog-sources.sql')")" = 2
TAGS_GONE=$(cat <<'SQL'
BEGIN;
DO $v$
DECLARE d bigint; s bigint; r bigint; sc bigint; i bigint;
BEGIN
  INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'zz_verify_tags', 0) RETURNING id INTO d;
  INSERT INTO catalog.sources (kind, ref, label, created_at) VALUES ('studio', 'zz-verify', 'Zz verify', 0) RETURNING id INTO s;
  INSERT INTO catalog.resources (source_id, key, label) VALUES (s, 'records', 'Zz verify') RETURNING id INTO r;
  INSERT INTO catalog.scopes (parent_id, source_id, path, label, automatic, created_at)
    VALUES ((SELECT id FROM catalog.scopes WHERE parent_id IS NULL), s, '/', 'Zz verify', true, 0) RETURNING id INTO sc;
  INSERT INTO catalog.items (resource_id, key, scope_id, kind, changed_at) VALUES (r, '1', sc, 'records', 0) RETURNING id INTO i;
  INSERT INTO catalog.labels (scope_id, kind, name, created_at) VALUES (sc, 'tag', 'zz-verify', 0);
  INSERT INTO catalog.links (item_id, label_id) SELECT i, id FROM catalog.labels WHERE scope_id = sc;
  INSERT INTO panel.studio_resources (database_id, table_name, catalog_source) VALUES (d, 'zz_verify', s);
  DELETE FROM panel.studio_databases WHERE id = d;
  IF EXISTS (SELECT 1 FROM catalog.sources WHERE id = s) OR EXISTS (SELECT 1 FROM catalog.items WHERE id = i) THEN
    RAISE EXCEPTION 'a tagged table went and its catalog source stayed';
  END IF;
END $v$;
ROLLBACK;
SQL
)
t_ok "a tagged table that goes takes its source, items and labels (as the panel)"  pg_role panel "$TAGS_GONE"
t_ok "the gate can note a write to a tagged table"  pg_role gate "BEGIN; INSERT INTO gate.record_touches (database_id, table_name, what, at) VALUES (0, 'zz_verify', 'changed', 0); ROLLBACK;"
t_no "the panel can NOT read the gate's touches (it asks the gate)"  pg_role panel "SELECT count(*) FROM gate.record_touches"
# her records' labels in the data API (step 4b): the gate's copy, written only through its admin door
t_ok "the gate keeps a copy of tagged tables' labels (studio/0002)"  test "$(pg "SELECT count(*) FROM public.schema_migrations WHERE name = 'studio/0002-record-labels.sql'")" = 1
t_ok "the gate can write its copy"  pg_role gate "BEGIN; INSERT INTO gate.record_labels (database_id, table_name, key, kind, name, public) VALUES (0, 'zz_verify', '1', 'tag', 'zz-verify', false); ROLLBACK;"
t_no "the panel can NOT read the gate's copy (it sends it)"  pg_role panel "SELECT count(*) FROM gate.record_labels"
t_ok "no touches waiting longer than a week (the panel takes them every minute)"  test "$(pg "SELECT count(*) FROM gate.record_touches WHERE at < extract(epoch FROM now()) - 7 * 86400")" = 0
for f in owner panel gate; do
    t_ok "$PASS_DIR/$f.pass is root's, 600"          test "$(stat -c '%U %a' "$PASS_DIR/$f.pass")" = "root 600"
done
# least privilege (P5): each service sees its own schemas and no more
t_ok "the panel can read its own tables"             pg_role panel "SELECT count(*) FROM panel.users"
t_no "the panel can NOT read the gate's"             pg_role panel "SELECT count(*) FROM gate.visitors"
t_ok "the gate can read its own tables"              pg_role gate "SELECT count(*) FROM gate.areas"
t_no "the gate can NOT read the panel's passkeys"    pg_role gate "SELECT count(*) FROM panel.passkeys"
# rights and places, per person (docs/permissions-plan.md step 2)
t_ok "the core's own migration ran (core/0001-rights.sql)"  test "$(pg "SELECT count(*) FROM public.schema_migrations WHERE name = 'core/0001-rights.sql'")" = 1
t_ok "the panel can read who has what (rights and places)"  pg_role panel "SELECT count(*) FROM panel.user_rights, panel.user_places LIMIT 1"
t_no "the gate can NOT read who has what"            pg_role gate "SELECT count(*) FROM panel.user_rights"
t_no "...nor where they are kept"                    pg_role gate "SELECT count(*) FROM panel.user_places"
[[ $(pg "SELECT count(*) FROM panel.users u WHERE u.role = 'manager' AND (EXISTS (SELECT 1 FROM panel.user_rights r WHERE r.user_id = u.id) OR EXISTS (SELECT 1 FROM panel.user_places p WHERE p.user_id = u.id))") == 0 ]] \
    && ok "account managers have every part and no places, with nothing written for them" || bad "an account manager has rights or places written down"
# since the Accounts page chooses rights (step 3): someone kept to places has only
# the parts that tell places apart (PLACE_RIGHTS, R5)
wrong=$(pg "SELECT string_agg(u.username, ', ') FROM panel.users u WHERE u.role = 'member'
      AND EXISTS (SELECT 1 FROM panel.user_places p WHERE p.user_id = u.id)
      AND EXISTS (SELECT 1 FROM panel.user_rights r WHERE r.user_id = u.id AND r.name NOT IN ('files','media','subdomains','forms','responses','comments','protected'))") || wrong="(its query failed)"
[[ -z $wrong ]] && ok "someone kept to places has only the parts that tell places apart" || bad "accounts kept to places with a part that can't tell places apart: $wrong"
t_ok "users.scope is gone: places say where people are kept (core/0002)"  test "$(pg "SELECT count(*) FROM public.schema_migrations WHERE name = 'core/0002-drop-users-scope.sql'")$(pg "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'panel' AND table_name = 'users' AND column_name = 'scope'")" = 10
[[ $(pg "SELECT has_database_privilege('public', 'pammy', 'CONNECT')" 2>/dev/null) == f ]] \
    && ok "nobody else may connect (PUBLIC revoked)" || bad "PUBLIC may still connect to the database"
# the services get their password from systemd, not from a file they could read
for u in pammy-panel pammy-gate; do
    # systemctl show renders LoadCredential= as "[unprintable]", so it can never be
    # grepped; read the effective unit (drop-ins included) instead
    t_ok "$u gets its password through LoadCredential" sh -c "systemctl cat $u | grep -q '^LoadCredential=.*db\.pass'"
done
t_no "$SVC can't read the database passwords"        as_s "cat $PASS_DIR/panel.pass"
# nothing still has a SQLite database open: the move is done (docs/postgres-plan.md)
# (the gate does hold the media API's index.db open: that one stays SQLite, P10)
open_db=$(for u in pammy-panel pammy-gate; do
              p=$(systemctl show -p MainPID --value "$u"); [[ $p =~ ^[1-9] ]] && ls -l /proc/"$p"/fd 2>/dev/null | grep -oE '/var/lib/[^ ]*/(panel|media|gate)\.db' || true
          done)
[[ -z $open_db ]] && ok "no service still holds a .db file open" || bad "still using SQLite files: $(tr '\n' ' ' <<<"$open_db")"
# backups (P12): the timer, and a dump from the last install
t_ok "the nightly backup timer is on"                systemctl --user -M "$PGSVC@" is-enabled -q pammy-pg-backup.timer
last_dump=$(find "/var/lib/$PGSVC/backups" -maxdepth 1 -name 'pammy-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n $last_dump ]] && ok "a dump is there ($(basename "$last_dump"), $(du -h "$last_dump" | cut -f1))" || bad "no dump in /var/lib/$PGSVC/backups"

echo "--- what the panel's user can reach"
# symlinks (node_modules/.bin) always show 777; what matters is their targets, which are checked too
t_ok "code is root-owned, not writable by anyone else" \
     sh -c "! find $APP ! -type l \\( ! -user root -o -perm /022 \\) -print -quit | grep -q . && ! find $APP -type l ! -user root -print -quit | grep -q ."
t_no "can't change its own code"               as_s "test -w $APP/src/app.ts"
t_no "can't enter /pamela"                     as_s "ls /pamela"
t_no "can't read her home"                     as_s "ls /home/pamela"
t_no "can't read WordPress's settings"         as_s "ls /var/lib/svc-pammywp"
t_no "can't read the TLS private key"          as_s "cat /etc/ssl/cloudflare/pammy.org-wildcard.key"

echo "--- service"
t_ok "running"                                 systemctl is-active -q pammy-panel
t_ok "starts at boot"                          systemctl is-enabled -q pammy-panel
listen=$(ss -ltnH "sport = :$PORT" | awk '{print $4}' | LC_ALL=C sort -u | tr '\n' ' ')
[[ $listen == "127.0.0.1:$PORT " ]] && ok "listens on 127.0.0.1:$PORT only" || bad "listening on: ${listen:-nothing}"
pid=$(systemctl show -p MainPID --value pammy-panel)
if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$pid" | tr -d ' ') == "$(id -u "$SVC")" ]] && ok "runs as $SVC" || bad "runs as uid $(ps -o uid= -p "$pid")"
    # look from INSIDE the running service's own sandbox
    t_no "inside its sandbox: /pamela doesn't exist"      nsenter -t "$pid" -m -- test -r /pamela/public
    t_no "inside its sandbox: /home is empty"             sh -c "nsenter -t $pid -m -- ls -A /home | grep -q ."
    t_no "inside its sandbox: /usr is read-only"          nsenter -t "$pid" -m -- sh -c 'touch /usr/.pammy-panel-probe && rm -f /usr/.pammy-panel-probe'
    t_ok "inside its sandbox: its database dir is writable" nsenter -t "$pid" -m -- test -w "$SVC_HOME"
else
    bad "no main process"
fi
props=$(systemctl show pammy-panel -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p CapabilityBoundingSet -p IPAddressDeny -p IPAddressAllow)
grep -qx 'NoNewPrivileges=yes' <<<"$props"       && ok "no privilege escalation (NoNewPrivileges)" || bad "NoNewPrivileges not set"
grep -qx 'ProtectSystem=strict' <<<"$props"      && ok "whole filesystem read-only except its database" || bad "ProtectSystem not strict"
grep -qx 'CapabilityBoundingSet=' <<<"$props"    && ok "no Linux capabilities at all" || bad "has capabilities: $(grep CapabilityBoundingSet <<<"$props")"
grep -q '^IPAddressDeny=.*0\.0\.0\.0/0' <<<"$props" && ok "can't open network connections beyond localhost" || bad "outbound network not blocked"
score=$(systemd-analyze security pammy-panel --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "systemd exposure rating: ${score#→ }"
t_ok "command line works (pammy-panel users)"  /usr/local/sbin/pammy-panel users
login=$(curl -s --max-time 10 -i "http://127.0.0.1:$PORT/login")
grep -qi "^content-security-policy: .*style-src 'self' 'nonce-[A-Za-z0-9+/=]\{24\}'" <<<"$login" && grep -q '<div id="root">' <<<"$login" && ! grep -q PAMMY_NONCE <<<"$login" \
    && ok "the page is served with its own style nonce" || bad "login page: no page or no nonce"
js=$(grep -o 'src="/assets/index-[A-Za-z0-9_-]*\.js"' <<<"$login" | cut -d'"' -f2)
[[ -n $js && $(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$js") == 200 ]] && ok "its script is served ($js)" || bad "the page's script: ${js:-not found}"

echo "--- website folder helper (pammy-sitefs: runs as pamela, only the panel can ask it)"
SOCK=/run/pammy-sitefs.sock
TEST_SITE=zz-panel-verify-$$
call() {  # call <user> <json> -- ask the helper exactly the way the panel does
    local user=$1; shift
    (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" "$@")
}
t_ok "socket is root:svc-pammypanel 660"       test "$(stat -c '%U:%G %a' "$SOCK")" = "root:svc-pammypanel 660"
t_ok "the panel's user can ask it"             call "$SVC" '{"op":"list","actor":"verify"}'
t_no "pamela can't ask it directly"            call pamela '{"op":"list"}'
t_no "the web server (www-data) can't ask it"  call www-data '{"op":"list"}'
[[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] && t_no "$SUDO_USER can't ask it without sudo" call "$SUDO_USER" '{"op":"list"}'
t_ok "trash folder is pamela's own, 700"       test "$(stat -c '%U:%G %a' /pamela/trash)" = "pamela:pamela 700"
hpid=$(systemctl show -p MainPID --value pammy-sitefs)
if [[ $hpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$hpid" | tr -d ' ') == "$(id -u pamela)" ]] && ok "runs as pamela" || bad "helper runs as uid $(ps -o uid= -p "$hpid")"
    # from INSIDE its sandbox (as root, so only mounts can say no)
    t_ok "inside its sandbox: /pamela/public writable"        nsenter -t "$hpid" -m -- test -w /pamela/public
    t_ok "inside its sandbox: /pamela/trash writable"         nsenter -t "$hpid" -m -- test -w /pamela/trash
    t_no "inside its sandbox: nothing outside /pamela writable" nsenter -t "$hpid" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
    t_ok "inside its sandbox: public and trash on one mount (trash can move folders)" \
         test "$(nsenter -t "$hpid" -m -- stat -c %m /pamela/public)" = "$(nsenter -t "$hpid" -m -- stat -c %m /pamela/trash)"
    t_ok "inside its sandbox: her app folder (.env) blocked"  test "$(nsenter -t "$hpid" -m -- stat -c %a /pamela/app)" = 0
    t_no "inside its sandbox: her home is hidden"             sh -c "nsenter -t $hpid -m -- ls -A /home | grep -q ."
    t_ok "inside its sandbox: /srv (WordPress) blocked"       test "$(nsenter -t "$hpid" -m -- stat -c %a /srv)" = 0
    t_ok "inside its sandbox: TLS private keys blocked"       test "$(nsenter -t "$hpid" -m -- stat -c %a /etc/ssl/cloudflare)" = 0
    t_no "inside its sandbox: /usr read-only"                 nsenter -t "$hpid" -m -- sh -c 'touch /usr/.pammy-probe && rm -f /usr/.pammy-probe'
    t_no "inside its sandbox: no network but loopback"        sh -c "nsenter -t $hpid -n -- ip -o link | grep -v ' lo:' | grep -q ."
else
    bad "helper not running after being asked"
fi
hprops=$(systemctl show pammy-sitefs -p NoNewPrivileges -p PrivateNetwork -p CapabilityBoundingSet -p RestrictAddressFamilies)
grep -qx 'NoNewPrivileges=yes' <<<"$hprops"    && ok "helper can't use sudo (NoNewPrivileges)" || bad "helper NoNewPrivileges not set"
grep -qx 'CapabilityBoundingSet=' <<<"$hprops" && ok "helper has no Linux capabilities" || bad "helper has capabilities"
grep -qx 'PrivateNetwork=yes' <<<"$hprops"     && ok "helper has no network" || bad "helper PrivateNetwork not set"
if systemctl show pammy-sitefs -p SystemCallFilter --value | tr ' ' '\n' | grep -qx ptrace; then
    sysfilter=$(systemctl show pammy-sitefs -p SystemCallFilter --value)
    [[ $sysfilter == "~"* ]] && ok "helper can't attach to her other processes (ptrace denied)" || bad "helper may use ptrace"
else
    ok "helper can't attach to her other processes (ptrace not allowed)"
fi
score=$(systemd-analyze security pammy-sitefs --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "helper exposure rating: ${score#→ }"

echo "--- installed software's files helpers (pammy-rootfs@<id>: docs/catalog-plan.md step 3)"
# one per installed software, set up by the software helper; only reads and refusals here,
# so nothing is ever written into her software's files
rcall() {  # rcall <user> <socket> <json>
    local user=$1 sock=$2; shift 2
    (cd / && runuser -u "$user" -- env SITEFS_SOCKET="$sock" /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" "$@")
}
t_ok "the templates are installed" test -f /etc/systemd/system/pammy-rootfs@.service -a -f /etc/systemd/system/pammy-rootfs@.socket
rootfs_ids=$(for d in /etc/systemd/system/pammy-rootfs@*.service.d; do [[ -f $d/root.conf ]] && { d=${d##*/pammy-rootfs@}; echo "${d%.service.d}"; }; done)
installed=$(cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/call.ts" '{"op":"list","actor":"verify"}' 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{for(const a of JSON.parse(s).apps)if(!a.setup&&!a.deleted)console.log(a.id)}catch{}})' | sort)
if [[ "$(sort <<<"$rootfs_ids")" == "$installed" ]]; then ok "one for each installed software, and no others (${installed//$'\n'/, })"
else bad "one for each installed software: installed [${installed//$'\n'/ }], drop-ins [${rootfs_ids//$'\n'/ }]: $(ls -d /etc/systemd/system/pammy-rootfs@* 2>&1 | tr '\n' ' ')"; fi
for id in $rootfs_ids; do
    RS=/run/pammy-rootfs-$id.sock
    conf=/etc/systemd/system/pammy-rootfs@$id.service.d/root.conf
    ruser=$(sed -n 's/^User=//p' "$conf")
    rcontent=$(sed -n 's/^Environment=SITEFS_PUBLIC=//p' "$conf")
    rtrash=$(sed -n 's/^Environment=SITEFS_TRASH=//p' "$conf")
    t_ok "$id: runs as its own user ($ruser), never root or pamela"  test -n "$ruser" -a "$ruser" != root -a "$ruser" != pamela
    t_ok "$id: its folder is a wp-content ($rcontent)"          test "${rcontent##*/}" = wp-content -a -d "$rcontent"
    t_ok "$id: its trash is $ruser's own, 700"                   test "$(stat -c '%U %a' "$rtrash")" = "$ruser 700"
    t_ok "$id: socket is root:svc-pammypanel 660"               test "$(stat -c '%U:%G %a' "$RS")" = "root:svc-pammypanel 660"
    t_ok "$id: the panel's user can ask it"                     rcall "$SVC" "$RS" '{"op":"files-list","dir":"","actor":"verify"}'
    t_no "$id: pamela can't ask it directly"                    rcall pamela "$RS" '{"op":"files-list","dir":""}'
    t_no "$id: the web server can't ask it"                     rcall www-data "$RS" '{"op":"files-list","dir":""}'
    t_no "$id: it does nothing that is only the website's"      rcall "$SVC" "$RS" '{"op":"list","actor":"verify"}'
    t_no "$id: nothing above wp-content (wp-config.php)"        rcall "$SVC" "$RS" '{"op":"files-stat","path":"../wp-config.php","actor":"verify"}'
    # a .php copy without the admin flag is refused before anything is written
    if [[ -f $rcontent/index.php ]]; then
        out=$(rcall "$SVC" "$RS" '{"op":"files-copy","from":"index.php","to":"","name":"zz-verify.php","actor":"verify"}' 2>&1)
        [[ $out == *"Only panel admins"* && ! -e $rcontent/zz-verify.php ]] && ok "$id: .php is written by panel admins only" || bad "$id: .php copy without admin: $out"
    fi
    rpid=$(systemctl show -p MainPID --value "pammy-rootfs@$id")
    if [[ $rpid =~ ^[1-9][0-9]*$ ]]; then
        [[ $(ps -o uid= -p "$rpid" | tr -d ' ') == "$(id -u "$ruser")" ]] && ok "$id: the running helper is $ruser" || bad "$id: helper runs as uid $(ps -o uid= -p "$rpid")"
        t_ok "$id: inside its sandbox: wp-content writable"       nsenter -t "$rpid" -m -- runuser -u "$ruser" -- test -w "$rcontent"
        t_ok "$id: inside its sandbox: wp-content and trash on one mount" \
             test "$(nsenter -t "$rpid" -m -- stat -c %m "$rcontent")" = "$(nsenter -t "$rpid" -m -- stat -c %m "$rtrash")"
        t_ok "$id: inside its sandbox: wp-config.php blocked"     test "$(nsenter -t "$rpid" -m -- stat -c %a "${rcontent%/wp-content}/wp-config.php" 2>/dev/null || echo 0)" = 0
        cfgdir=$(sed -n 's/^InaccessiblePaths=-\([^ ]*\) .*/\1/p' "$conf")
        [[ -e $cfgdir ]] && t_ok "$id: inside its sandbox: its config (database password) blocked" test "$(nsenter -t "$rpid" -m -- stat -c %a "$cfgdir")" = 0
        t_ok "$id: inside its sandbox: her website blocked"       test "$(nsenter -t "$rpid" -m -- stat -c %a /pamela)" = 0
        t_ok "$id: inside its sandbox: the panel's secrets blocked" test "$(nsenter -t "$rpid" -m -- stat -c %a /etc/pammy-panel)" = 0
        t_no "$id: inside its sandbox: /usr read-only"            nsenter -t "$rpid" -m -- sh -c 'touch /usr/.pammy-probe && rm -f /usr/.pammy-probe'
        t_no "$id: inside its sandbox: no network but loopback"   sh -c "nsenter -t $rpid -n -- ip -o link | grep -v ' lo:' | grep -q ."
    else
        bad "$id: helper not running after being asked"
    fi
    rprops=$(systemctl show "pammy-rootfs@$id" -p NoNewPrivileges -p CapabilityBoundingSet)
    grep -qx 'NoNewPrivileges=yes' <<<"$rprops" && grep -qx 'CapabilityBoundingSet=' <<<"$rprops" && ok "$id: no sudo, no Linux capabilities" || bad "$id: $rprops"
done

echo "--- thumbnail service (pammy-thumbs: its own user, reads the website, only the panel can ask it)"
THUMBS=svc-pammythumbs
tcall() {  # tcall <user> <json> -- ask the thumbnail service
    local user=$1; shift
    (cd / && runuser -u "$user" -- env SITEFS_SOCKET=/run/pammy-thumbs.sock /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" "$@")
}
t_ok "system user $THUMBS exists, no login shell"      test "$(getent passwd "$THUMBS" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$THUMBS is NOT in sudo or www-data permanently"  sh -c "id -nG $THUMBS | tr ' ' '\n' | grep -qxE 'sudo|www-data'"
t_ok "socket is root:svc-pammypanel 660"               test "$(stat -c '%U:%G %a' /run/pammy-thumbs.sock)" = "root:svc-pammypanel 660"
tools=$(tcall "$SVC" '{"op":"tools","actor":"verify"}' 2>&1)
grep -q '"ffmpeg": true' <<<"$tools" && grep -q '"pdftoppm": true' <<<"$tools" && ok "the panel's user can ask it; it has ffmpeg and pdftoppm" || bad "thumbnail service tools: $tools"
t_no "pamela can't ask it"                             tcall pamela '{"op":"tools"}'
t_no "the web server (www-data) can't ask it"          tcall www-data '{"op":"tools"}'
tpid=$(systemctl show -p MainPID --value pammy-thumbs)
if [[ $tpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$tpid" | tr -d ' ') == "$(id -u "$THUMBS")" ]] && ok "runs as $THUMBS" || bad "thumbnail service runs as uid $(ps -o uid= -p "$tpid")"
    t_ok "inside its sandbox: can read the website"          nsenter -t "$tpid" -m -- test -r /pamela/public
    t_no "inside its sandbox: can't write the website"       nsenter -t "$tpid" -m -- sh -c 'touch /pamela/public/.pammy-probe && rm -f /pamela/public/.pammy-probe'
    # (/tmp and /var/tmp are its own private, throwaway ones: PrivateTmp)
    t_no "inside its sandbox: can't write /etc"              nsenter -t "$tpid" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
    t_no "inside its sandbox: can't write its own code"      nsenter -t "$tpid" -m -- sh -c 'touch /opt/pammy-panel/.pammy-probe && rm -f /opt/pammy-panel/.pammy-probe'
    t_ok "inside its sandbox: /tmp is its own, not the server's" test "$(nsenter -t "$tpid" -m -- stat -c %i /tmp)" != "$(stat -c %i /tmp)"
    t_ok "inside its sandbox: the trash is blocked"          test "$(nsenter -t "$tpid" -m -- stat -c %a /pamela/trash)" = 0
    t_ok "inside its sandbox: her app folder (.env) blocked" test "$(nsenter -t "$tpid" -m -- stat -c %a /pamela/app)" = 0
    t_ok "inside its sandbox: the panel's databases blocked" test "$(nsenter -t "$tpid" -m -- stat -c %a /var/lib)" = 0
    t_no "inside its sandbox: her home is hidden"            sh -c "nsenter -t $tpid -m -- ls -A /home | grep -q ."
    t_no "inside its sandbox: no network but loopback"       sh -c "nsenter -t $tpid -n -- ip -o link | grep -v ' lo:' | grep -q ."
else
    bad "thumbnail service not running after being asked"
fi
tprops=$(systemctl show pammy-thumbs -p NoNewPrivileges -p PrivateNetwork -p CapabilityBoundingSet -p MemoryMax)
grep -qx 'NoNewPrivileges=yes' <<<"$tprops"    && ok "thumbnail service can't gain privileges (NoNewPrivileges)" || bad "thumbs NoNewPrivileges not set"
grep -qx 'CapabilityBoundingSet=' <<<"$tprops" && ok "thumbnail service has no Linux capabilities" || bad "thumbs has capabilities"
grep -qx 'PrivateNetwork=yes' <<<"$tprops"     && ok "thumbnail service has no network" || bad "thumbs PrivateNetwork not set"
grep -qx "MemoryMax=$((512 * 1024 * 1024))" <<<"$tprops" && ok "thumbnail service memory capped at 512 MB" || bad "thumbs MemoryMax: $(grep MemoryMax <<<"$tprops")"
t_no "it refuses a path outside the website"           tcall "$SVC" '{"op":"thumb","path":"../../etc/passwd","kind":"files","actor":"verify"}'
t_no "it refuses a protected folder's login-files"      tcall "$SVC" '{"op":"thumb","path":"x/login-files/style.css","kind":"files","actor":"verify"}'
score=$(systemd-analyze security pammy-thumbs --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "thumbnail service exposure rating: ${score#→ }"

echo "--- a real subdomain, made and removed the way the panel does it"
if call "$SVC" "{\"op\":\"create\",\"name\":\"$TEST_SITE\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
    ok "created /pamela/public/$TEST_SITE"
    t_ok "folder is pamela's, group www-data, 2755"   test "$(stat -c '%U:%G %a' "/pamela/public/$TEST_SITE")" = "pamela:www-data 2755"
    t_ok "starter page is pamela's, group www-data, 644" test "$(stat -c '%U:%G %a' "/pamela/public/$TEST_SITE/index.html")" = "pamela:www-data 644"
    t_ok "pamela can edit it"                         runuser -u pamela -- test -w "/pamela/public/$TEST_SITE/index.html"
    body=$(curl -s --max-time 15 "https://$TEST_SITE.pammy.org/")
    [[ $body == *"<h1>$TEST_SITE</h1>"* ]] && ok "live at https://$TEST_SITE.pammy.org/ straight away" || bad "https://$TEST_SITE.pammy.org/ didn't show the starter page"
    # a temporary home page (docs/temporary-home-plan.md): the starter page is one, so its words can change
    if call "$SVC" "{\"op\":\"home-page-save\",\"name\":\"$TEST_SITE\",\"site\":\"pammy.org\",\"words\":{\"heading\":\"Verify &amp; <b>\",\"message\":\"\",\"link\":true,\"style\":\"plain\"},\"actor\":\"verify\"}" >/dev/null 2>&1; then
        body=$(curl -s --max-time 15 "https://$TEST_SITE.pammy.org/")
        [[ $body == *"<h1>Verify &amp;amp; &lt;b&gt;</h1>"* && $body == *'content="pammy-temporary-page"'* ]] \
            && ok "its temporary page's words changed, escaped, live straight away" || bad "the temporary page didn't change"
        t_ok "still pamela's, group www-data, 644"        test "$(stat -c '%U:%G %a' "/pamela/public/$TEST_SITE/index.html")" = "pamela:www-data 644"
    else
        bad "the helper refused to change the starter page's words"
    fi
    entry=$(call "$SVC" "{\"op\":\"trash\",\"name\":\"$TEST_SITE\",\"actor\":\"verify\"}" 2>/dev/null | grep -o '"entry": "[^"]*"' | cut -d'"' -f4)
    if [[ -n $entry && -d /pamela/trash/$entry && ! -e /pamela/public/$TEST_SITE ]]; then ok "moved to /pamela/trash/$entry"
    else bad "trash didn't move it (entry: ${entry:-none})"; fi
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://$TEST_SITE.pammy.org/")
    [[ $code == 404 ]] && ok "trashed folder no longer served (404)" || bad "trashed folder still answers: $code"
    if [[ -n $entry ]] && call "$SVC" "{\"op\":\"restore\",\"entry\":\"$entry\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
        code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://$TEST_SITE.pammy.org/")
        [[ $code == 200 ]] && ok "restored and live again" || bad "restored but https://$TEST_SITE.pammy.org/ gave $code"
    else
        bad "restore failed"
    fi
    t_no "the helper refuses a path outside the web root" call "$SVC" '{"op":"trash","name":"../app","actor":"verify"}'
else
    bad "couldn't create a test folder through the helper"
fi
rm -rf "/pamela/public/$TEST_SITE" /pamela/trash/"$TEST_SITE"--*

echo "--- database helper (pammy-pammydb: Pamela's own MariaDB and Postgres, docs/studio-plan.md)"
STUDIO=svc-pammystudio
PDGATE=svc-pammygate          # the gate's own section sets GATE later; this section runs first
PDSOCK=/run/pammy-pammydb.sock
VDB=zz_studio_verify_$$
VUSER=zzu_studio_verify_$$
VPASS=VerifyVerifyVerifyVerify12
dcall() {  # dcall <user> <json> -- ask the database helper the way the panel does
    local user=$1; shift
    (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/pammydb/call.ts" "$@")
}
if [[ ! -S $PDSOCK ]]; then
    note "the database helper isn't installed yet (no $PDSOCK): sudo ~/pamela-setup/no-sudo/install-studio-db.sh"
else
    t_ok "system user $STUDIO exists, no login shell"   test "$(getent passwd "$STUDIO" | cut -d: -f7)" = /usr/sbin/nologin
    t_no "$STUDIO is NOT in sudo"                       sh -c "id -nG $STUDIO | tr ' ' '\n' | grep -qx sudo"
    t_ok "socket is root:pammydb-clients 660"           test "$(stat -c '%U:%G %a' "$PDSOCK")" = "root:pammydb-clients 660"
    # S2 (docs/s2-plan.md): the panel's door is the panel's alone; the gate has its own
    members=$(getent group pammydb-clients | cut -d: -f4 | tr ',' '\n' | sort | paste -sd, -)
    [[ $members == "svc-pammypanel" ]] && ok "only the panel is in pammydb-clients (the gate has its own door, S2)" \
        || bad "pammydb-clients holds: ${members:-nobody}"
    t_ok "the panel's user can ask it"                  dcall "$SVC" '{"op":"list-databases","actor":"verify"}'
    # can it connect at all (not: did the helper refuse what it asked)
    can_open() { (cd / && runuser -u "$1" -- /usr/bin/node -e "require('net').connect('$2').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))") >/dev/null 2>&1; }
    t_no "the gate's user can't open the panel's door (S2)" can_open "$PDGATE" "$PDSOCK"
    verify_gate_door() {  # the gate's own door: the gate only, row ops only (S2)
        local gsock=/run/pammy-pammydb-gate.sock out gpid u
        gcall() { local user=$1; shift; (cd / && runuser -u "$user" -- env PAMMYDB_SOCKET="$gsock" /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/pammydb/call.ts" "$@" 2>&1); }
        t_ok "the gate's door is root:svc-pammygate 660"  test "$(stat -c '%U:%G %a' "$gsock")" = "root:svc-pammygate 660"
        t_no "nobody else is in the svc-pammygate group"   sh -c "getent group svc-pammygate | cut -d: -f4 | grep -q ."
        # probes the op layer refuses even at the panel's door (review MEDIUM-1): only the door's
        # own words pass, and a door wrongly open would still change nothing
        for req in '{"op":"drop-database","engine":"postgres","name":"postgres","actor":"verify"}' \
                   '{"op":"apply-schema","engine":"mariadb","name":"mysql","patch":[],"expect":null,"actor":"verify"}' \
                   '{"op":"create-user","engine":"postgres","user":"postgres","password":"","actor":"verify"}' \
                   '{"op":"grant-access","engine":"postgres","user":"postgres","database":"zz_none","role":"admin","actor":"verify"}' \
                   '{"op":"reset-password","engine":"postgres","user":"postgres","password":"","actor":"verify"}' \
                   '{"op":"project-database","engine":"postgres","name":"postgres","actor":"verify"}' \
                   '{"op":"list-databases","actor":"verify"}'; do
            out=$(gcall "$PDGATE" "$req")
            grep -q "^not-allowed: The gate's door" <<<"$out" && ok "the gate's door refuses $(sed 's/.*"op":"\([a-z-]*\)".*/\1/' <<<"$req")" \
                || bad "the gate's door answered $(sed 's/.*"op":"\([a-z-]*\)".*/\1/' <<<"$req"): $(head -c 200 <<<"$out")"
        done
        # a row op goes through to the engine (her own database has no such table: not the door's refusal)
        out=$(gcall "$PDGATE" '{"op":"list-rows","engine":"postgres","name":"pamela","query":{"table":"zz_no_such_table","columns":["id"],"limit":1,"offset":0},"actor":"verify"}')
        if grep -q "gate's door" <<<"$out"; then bad "the gate's door refused a row op: $out"
        elif grep -q '^unavailable:' <<<"$out"; then bad "the gate's door didn't answer a row op: $out"
        else ok "the gate's door passes a row op on to the engine"; fi
        t_ok "the gate's user can open its door"   can_open "$PDGATE" "$gsock"
        for u in "$SVC" pamela www-data svc-pammyphp svc-lfdlngate svc-lfdlnpanel; do
            id "$u" >/dev/null 2>&1 && t_no "$u can't open the gate's door" can_open "$u" "$gsock"
        done
        gpid=$(systemctl show -p MainPID --value pammy-gate)
        if [[ $gpid =~ ^[1-9][0-9]*$ ]]; then
            grep -qw "$(getent group pammydb-clients | cut -d: -f3)" <<<"$(grep '^Groups:' "/proc/$gpid/status")" \
                && bad "the running gate still has pammydb-clients (restart it: it predates S2's install)" || ok "the running gate doesn't have pammydb-clients"
        fi
        t_ok "the gate is pointed at its own door"   sh -c "systemctl show -p Environment --value pammy-gate | tr ' ' '\n' | grep -qx GATE_PAMMYDB_SOCKET=$gsock"
        gpid=$(systemctl show -p MainPID --value pammy-pammydb-gate)
        [[ $gpid =~ ^[1-9][0-9]*$ && $(ps -o uid= -p "$gpid" | tr -d ' ') == "$(id -u "$STUDIO")" ]] && ok "the gate's helper runs as $STUDIO" || bad "the gate's helper: pid ${gpid:-none}"
        # end to end (review L3): a table she lets anyone read, through Cloudflare, the gate and its door
        pubpath=$(pg "SELECT c.engine || '/' || c.name || '/' || (r->>'slug') FROM gate.studio_catalog c,
                        jsonb_array_elements(c.catalog_json::jsonb -> 'resources') r
                       WHERE c.api_read AND jsonb_typeof(r->'public') = 'object' AND (r->'can'->>'view') = 'true'
                       ORDER BY c.name, r->>'slug' LIMIT 1" 2>/dev/null)
        if [[ -n $pubpath ]]; then
            out=$(curl -s --max-time 15 -w '\n%{http_code}' "https://pammy.org/_pammy/api/data/$pubpath")
            [[ ${out##*$'\n'} == 200 && $out == *'"items"'* ]] && ok "the data API reads $pubpath (anyone may) through the gate's door" \
                || bad "the data API on $pubpath: ${out##*$'\n'} ${out:0:160}"
        else
            note "no table anyone may read through the data API (the recipe book example sets one up): the end-to-end read was skipped"
        fi
        grep -qx 'NoNewPrivileges=yes' <<<"$(systemctl show pammy-pammydb-gate -p NoNewPrivileges)" && grep -qx 'CapabilityBoundingSet=' <<<"$(systemctl show pammy-pammydb-gate -p CapabilityBoundingSet)" \
            && ok "the gate's helper: no sudo, no capabilities" || bad "the gate's helper sandbox"
    }
    if [[ -S /run/pammy-pammydb-gate.sock ]]; then verify_gate_door; else bad "the gate's door to the database helper isn't there (/run/pammy-pammydb-gate.sock, S2)"; fi
    t_no "pamela can't ask it directly"                 dcall pamela '{"op":"list-databases"}'
    t_no "the web server (www-data) can't ask it"       dcall www-data '{"op":"list-databases"}'
    [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] && t_no "$SUDO_USER can't ask it without sudo" dcall "$SUDO_USER" '{"op":"list-databases"}'

    # it reaches BOTH of her engines (one line per engine in the reply)
    engines=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null | grep -c '"ok": true')
    [[ ${engines:-0} == 2 ]] && ok "both her engines answer (3307 and 5433)" || bad "engines answering: ${engines:-0} of 2"

    dpid=$(systemctl show -p MainPID --value pammy-pammydb)
    if [[ $dpid =~ ^[1-9][0-9]*$ ]]; then
        [[ $(ps -o uid= -p "$dpid" | tr -d ' ') == "$(id -u "$STUDIO")" ]] && ok "runs as $STUDIO" \
            || bad "runs as uid $(ps -o uid= -p "$dpid" | tr -d ' ') -- it must NOT be pamela"
        t_ok "inside its sandbox: /pamela is blocked"        test "$(nsenter -t "$dpid" -m -- stat -c %a /pamela)" = 0
        t_ok "inside its sandbox: the panel's secrets blocked" test "$(nsenter -t "$dpid" -m -- stat -c %a /etc/pammy-panel)" = 0
        t_no "inside its sandbox: nothing is writable but its own /tmp" \
             nsenter -t "$dpid" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
        # the passwords reach it from systemd, not from a file it could open
        t_no "it can't read the studio passwords itself"  runuser -u "$STUDIO" -- cat "$PASS_DIR/studio-postgres.pass"
    else
        bad "the database helper isn't running after being asked"
    fi
    for c in studio-postgres.pass studio-mariadb.pass; do
        t_ok "$PASS_DIR/$c is root's, 600"               test "$(stat -c '%U %a' "$PASS_DIR/$c")" = "root 600"
    done
    t_ok "it gets its passwords through LoadCredential"  sh -c "systemctl cat pammy-pammydb | grep -q '^LoadCredential=studio-'"

    dprops=$(systemctl show pammy-pammydb -p NoNewPrivileges -p PrivateNetwork -p CapabilityBoundingSet -p RestrictAddressFamilies -p IPAddressDeny -p IPAddressAllow)
    grep -qx 'NoNewPrivileges=yes' <<<"$dprops"    && ok "helper can't use sudo (NoNewPrivileges)" || bad "pammydb NoNewPrivileges not set"
    grep -qx 'CapabilityBoundingSet=' <<<"$dprops" && ok "helper has no Linux capabilities" || bad "pammydb has capabilities"
    # the one place it is deliberately NOT like sitefs: it needs loopback
    grep -qx 'PrivateNetwork=no' <<<"$dprops"      && ok "helper has the network it needs (PrivateNetwork=no, on purpose)" \
        || bad "pammydb PrivateNetwork: $(grep PrivateNetwork <<<"$dprops") -- yes would hide her engines"
    # systemd prints these as the ranges the words mean, not as the words: "any"
    # comes back as 0.0.0.0/0 ::/0 and "localhost" as 127.0.0.0/8 ::1/128. Checking
    # the EFFECTIVE value is both correct and stronger than grepping the unit file.
    # The order of the two ranges isn't fixed (it changed on 2026-10-01 with the
    # same systemd), so either order is accepted.
    grep -qxE 'IPAddressDeny=(0\.0\.0\.0/0 ::/0|::/0 0\.0\.0\.0/0)' <<<"$dprops" && ok "helper is denied every address to start with" \
        || bad "pammydb IPAddressDeny: $(grep IPAddressDeny <<<"$dprops")"
    grep -qxE 'IPAddressAllow=(127\.0\.0\.0/8 ::1/128|::1/128 127\.0\.0\.0/8)' <<<"$dprops" && ok "...and allowed loopback only, nothing off this machine" \
        || bad "pammydb IPAddressAllow: $(grep IPAddressAllow <<<"$dprops")"
    grep -qx 'RestrictAddressFamilies=AF_INET AF_UNIX' <<<"$dprops" && ok "helper may use only its socket and IPv4" \
        || bad "pammydb RestrictAddressFamilies: $(grep RestrictAddressFamilies <<<"$dprops")"

    # S7: no SETTING names the two ports it must never use. Its comments explain
    # why those ports are wrong, so they are stripped before looking -- otherwise
    # this check fails on the explanation itself.
    t_no "no setting in its unit names :5432 or :5434" \
        sh -c "systemctl cat pammy-pammydb | grep -v '^[[:space:]]*#' | grep -qE '543[24]'"
    # ...then that the code refuses them outright, run for real as its own user
    boot() { (cd / && runuser -u "$STUDIO" -- env "$@" PAMMYDB_SOCKET=/nonexistent/pammydb.sock \
              /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/pammydb/main.ts" 2>&1 || true); }
    for bad_port in 5432 5434; do
        grep -q "refusing to use port $bad_port" <<<"$(boot PAMMYDB_POSTGRES_PORT=$bad_port)" \
            && ok "refuses to start against port $bad_port (the panel's own database, or the host's)" \
            || bad "the helper did NOT refuse port $bad_port"
    done
    # and that check isn't vacuous: with no bad port it fails for another reason
    if grep -q 'refusing to use port' <<<"$(boot PAMMYDB_ACTOR=verify)"; then
        bad "the port refusal fires even without a bad port -- the check proves nothing"
    else
        ok "the refusal is about the port, not about everything"
    fi

    # S8: the refuse-list, on the live engines. Her own database must survive it.
    t_no "it refuses to delete her own 'pamela' database (Postgres)"  dcall "$SVC" '{"op":"drop-database","engine":"postgres","name":"pamela","actor":"verify"}'
    t_no "it refuses to delete her own 'pamela' database (MariaDB)"   dcall "$SVC" '{"op":"drop-database","engine":"mariadb","name":"pamela","actor":"verify"}'
    t_no "it refuses to delete the engine's own (postgres)"           dcall "$SVC" '{"op":"drop-database","engine":"postgres","name":"postgres","actor":"verify"}'
    t_no "it refuses to delete the engine's own (mysql)"              dcall "$SVC" '{"op":"drop-database","engine":"mariadb","name":"mysql","actor":"verify"}'
    t_no "it refuses a name the database wouldn't take"               dcall "$SVC" '{"op":"create-database","engine":"postgres","name":"My Recipes","actor":"verify"}'
    # ...but her own database is hers to work in: only creating and deleting it is refused
    t_ok "it CAN look inside her own 'pamela' database (Postgres)"    dcall "$SVC" '{"op":"database-size","engine":"postgres","name":"pamela","actor":"verify"}'
    t_ok "it CAN look inside her own 'pamela' database (MariaDB)"     dcall "$SVC" '{"op":"database-size","engine":"mariadb","name":"pamela","actor":"verify"}'
    t_no "it does not open the engine's own machinery"                dcall "$SVC" '{"op":"database-size","engine":"mariadb","name":"mysql","actor":"verify"}'
    still=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null | grep -c '"name": "pamela"')
    [[ ${still:-0} == 2 ]] && ok "her 'pamela' database is still there on both engines" || bad "her 'pamela' database: ${still:-0} of 2 still there"

    # ...and the refusals are not vacuous: an ordinary database really can be made and removed
    for eng in postgres mariadb; do
        if dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            ok "made a database on $eng ($VDB)"
            sized=$(dcall "$SVC" "{\"op\":\"database-size\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" 2>/dev/null)
            grep -q '"tables": 0' <<<"$sized" && ok "and can measure it (no tables yet)" || bad "database-size on $eng said: ${sized:-nothing}"
            if dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
                ok "and removed it again on $eng"
            else
                bad "couldn't remove $VDB on $eng -- remove it by hand"
            fi
        else
            bad "couldn't make a database on $eng through the helper"
        fi
    done

    # ---------------------------------------------------------------- database users
    # Slice 3. The four roles are a sentence on her page ("can look at the
    # information, and change nothing"); these checks are that sentence being
    # true on the live engines, not just that the right SQL was composed.
    echo "--- database logins and the four roles (docs/databases-plan.md 9)"

    # The refuse-list first. On MariaDB this is the WHOLE boundary: the CREATE
    # USER privilege covers every account on the server, so nothing in the engine
    # stops the helper repointing root. Postgres bounds itself (since 16 a
    # CREATEROLE role may only alter roles it created), so there it is belt and
    # braces. Either way she needs both to hold.
    for eu in postgres:pamela postgres:postgres mariadb:pamela mariadb:root; do
        eng=${eu%%:*}; who=${eu##*:}
        t_no "it refuses to remove the login '$who' ($eng)" \
             dcall "$SVC" "{\"op\":\"drop-user\",\"engine\":\"$eng\",\"user\":\"$who\",\"actor\":\"verify\"}"
        t_no "it refuses to change '$who''s password ($eng)" \
             dcall "$SVC" "{\"op\":\"reset-password\",\"engine\":\"$eng\",\"user\":\"$who\",\"password\":\"VerifyVerifyVerify12\",\"actor\":\"verify\"}"
    done
    # pg_ is Postgres's own prefix, whatever else the name says
    t_no "it refuses a Postgres name beginning pg_" \
         dcall "$SVC" '{"op":"create-user","engine":"postgres","user":"pg_sneaky","password":"VerifyVerifyVerify12","actor":"verify"}'
    # a password it would have to escape never reaches an engine
    t_no "it refuses a password it would have to quote" \
         dcall "$SVC" "{\"op\":\"create-user\",\"engine\":\"postgres\",\"user\":\"$VUSER\",\"password\":\"it's a password\",\"actor\":\"verify\"}"
    # reading is not managing: she is still shown the logins that came with the server
    seen=$(dcall "$SVC" '{"op":"list-users","actor":"verify"}' 2>/dev/null | grep -c '"name": "pamela"')
    [[ ${seen:-0} == 2 ]] && ok "her own 'pamela' login is listed on both engines, marked not hidden" \
        || bad "her 'pamela' login: ${seen:-0} of 2 listed"

    # ...and none of that is vacuous: a real login is made, granted each of the
    # four, read back, and removed, on each engine.
    for eng in postgres mariadb; do
        if ! dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            bad "couldn't make $VDB on $eng to test logins against"; continue
        fi
        if dcall "$SVC" "{\"op\":\"create-user\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"password\":\"$VPASS\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            ok "made a login on $eng ($VUSER)"
        else
            bad "couldn't make a login on $eng through the helper"
            dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1
            continue
        fi
        # a new login reaches nothing at all until she says otherwise
        reach=$(dcall "$SVC" "{\"op\":\"user-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"databases\":[\"$VDB\"],\"actor\":\"verify\"}" 2>/dev/null)
        grep -q '"access": \[\]' <<<"$reach" && ok "and it reaches nothing until access is given ($eng)" \
            || bad "a new $eng login already reaches something: $reach"

        for role in read write structure admin; do
            dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"role\":\"$role\",\"actor\":\"verify\"}" >/dev/null 2>&1
            back=$(dcall "$SVC" "{\"op\":\"user-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"databases\":[\"$VDB\"],\"actor\":\"verify\"}" 2>/dev/null)
            grep -q "\"role\": \"$role\"" <<<"$back" && ok "granted $role on $eng, and the engine agrees that is what it is" \
                || bad "granted $role on $eng but it reads back as: $back"
        done
        # ...and the roles are not just labels. Read only really cannot write,
        # signed in as that login, against a real table.
        dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"role\":\"read\",\"actor\":\"verify\"}" >/dev/null 2>&1
        if [[ $eng == postgres ]]; then
            asv() { PGPASSWORD=$VPASS PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5433 -U "$VUSER" -d "$VDB" -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1; }
            PGPASSWORD=$(cat "$PASS_DIR/studio-postgres.pass") psql -X -qtA -h 127.0.0.1 -p 5433 -U pammy_studio -d "$VDB" \
                -c 'CREATE TABLE verify_rows (id int)' >/dev/null 2>&1
        else
            asv() { MYSQL_PWD=$VPASS mariadb -h 127.0.0.1 -P 3307 -u "$VUSER" -D "$VDB" --batch --skip-column-names -e "$1" >/dev/null 2>&1; }
            MYSQL_PWD=$(cat "$PASS_DIR/studio-mariadb.pass") mariadb -h 127.0.0.1 -P 3307 -u pammy_studio -D "$VDB" \
                --batch -e 'CREATE TABLE verify_rows (id int)' >/dev/null 2>&1
        fi
        asv 'SELECT count(*) FROM verify_rows' && ok "Read only really can read ($eng)" || bad "Read only cannot read on $eng"
        asv 'INSERT INTO verify_rows (id) VALUES (1)' && bad "Read only COULD write on $eng -- the role is not what the page says" \
            || ok "...and really cannot write ($eng)"
        dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"role\":\"write\",\"actor\":\"verify\"}" >/dev/null 2>&1
        asv 'INSERT INTO verify_rows (id) VALUES (1)' && ok "Read & write can ($eng)" || bad "Read & write could not write on $eng"

        # taking it away leaves nothing behind
        dcall "$SVC" "{\"op\":\"revoke-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1
        gone=$(dcall "$SVC" "{\"op\":\"user-access\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"databases\":[\"$VDB\"],\"actor\":\"verify\"}" 2>/dev/null)
        grep -q '"access": \[\]' <<<"$gone" && ok "and taking the access away leaves nothing behind ($eng)" \
            || bad "after revoking on $eng: $gone"

        if dcall "$SVC" "{\"op\":\"drop-user\",\"engine\":\"$eng\",\"user\":\"$VUSER\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            ok "and removed the login again on $eng"
        else
            bad "couldn't remove the login $VUSER on $eng -- remove it by hand"
        fi
        dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1
    done
    # her own logins came through all of that untouched -- the same count as
    # before the refusals were tested, so a refusal that had quietly stopped
    # refusing would show up here
    still_u=$(dcall "$SVC" '{"op":"list-users","actor":"verify"}' 2>/dev/null | grep -c '"name": "pamela"')
    [[ ${still_u:-0} == 2 ]] && ok "her own 'pamela' login is still there on both engines" \
        || bad "her 'pamela' login: ${still_u:-0} of 2 still there"

    score=$(systemd-analyze security pammy-pammydb --no-pager 2>/dev/null | tail -1)
    [[ -n $score ]] && note "database helper exposure rating: ${score#→ }"

    echo "--- the databases page (/databases, docs/databases-plan.md 5)"
    # The panel's side, through nginx and Cloudflare like any other page. The API
    # needs a signed-in manager, which the local tests cover; here it is the page,
    # the address list, and that the migration really landed.
    t_ok "the studio's table is in the panel's database"  pg "SELECT 1 FROM panel.studio_databases LIMIT 0"
    t_ok "the panel's own role can use it"                pg_role panel "SELECT count(*) FROM panel.studio_databases"
    t_no "the gate can NOT read it"                       pg_role gate "SELECT count(*) FROM panel.studio_databases"
    # C18: two active apps must never both be called Blog
    pg "INSERT INTO panel.studio_databases (engine, name, display_name, adopted_at, status)
        VALUES ('postgres', 'zz_c18_a', 'Blog', 0, 'active')" >/dev/null 2>&1
    t_no "two active databases can't share an app name (C18)" \
         pg "INSERT INTO panel.studio_databases (engine, name, display_name, adopted_at, status)
             VALUES ('mariadb', 'zz_c18_b', 'blog', 0, 'active')"
    t_ok "...but two inactive ones may" \
         pg "INSERT INTO panel.studio_databases (engine, name, display_name, adopted_at, status)
             VALUES ('mariadb', 'zz_c18_b', 'Blog', 0, 'inactive')"
    t_no "and a name the engines would refuse can't be written down" \
         pg "INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'Not A Name', 0)"
    t_no "nor an engine the panel doesn't have" \
         pg "INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('sqlite', 'zz_c18_c', 0)"
    pg "DELETE FROM panel.studio_databases WHERE name LIKE 'zz_c18_%'" >/dev/null
    # N7 (docs/refactor-plan.md phase 0 step 5): the kinds of example the code
    # knows and the kinds the database allows are two lists kept in step by hand
    # -- DB_EXAMPLES, TUTORIAL_EXAMPLES, and the CHECK a migration wrote. An
    # example kind added to the code but not to the database can only be found
    # when she presses Set up, so it is checked here, on the live schema.
    kinds_code=$(/usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
        const { DB_EXAMPLES } = await import('$APP/src/studio/db-examples.ts');
        const { TUTORIAL_EXAMPLES } = await import('$APP/src/studio/tutorial-examples.ts');
        console.log([...Object.keys(DB_EXAMPLES), ...Object.keys(TUTORIAL_EXAMPLES)].sort().join(' '));" 2>/dev/null)
    kinds_db=$(pg "SELECT pg_get_constraintdef(oid) FROM pg_constraint
                    WHERE conrelid = 'panel.studio_databases'::regclass AND conname = 'studio_databases_example_check'" \
               | grep -o "'[a-z0-9-]\+'" | tr -d "'" | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')
    if [[ -n $kinds_code && $kinds_code == "$kinds_db" ]]; then
        ok "the database allows exactly the example kinds the code knows ($kinds_code)"
    else
        bad "example kinds differ -- the code knows [${kinds_code:-none}], the database allows [${kinds_db:-none}]"
    fi
    # Signed out, every panel page redirects to sign-in (src/app.ts appPage), so
    # 200 is not what this address can ever give. The redirect is still the proof
    # we want: an address the panel does not know 404s instead, so a 302 here says
    # /databases really is one of its pages.
    page=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org/databases")
    [[ $page == "302 https://panel.pammy.org/login?next=%2Fdatabases" ]] \
        && ok "https://panel.pammy.org/databases is one of the panel's pages (signed out: on to sign-in)" \
        || bad "https://panel.pammy.org/databases gave $page"
    unknown=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://panel.pammy.org/zz-not-a-page-$$")
    [[ $unknown == 404 ]] && ok "...and an address it doesn't have is a 404, not that redirect" \
        || bad "an unknown panel address gave $unknown, so the check above proves nothing"
    t_ok "signing in is still what the API asks for" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases | grep -qx 401"

    echo "--- the database users page (/databases/users, docs/databases-plan.md 9)"
    # The panel keeps only the note beside a login. The logins and their access
    # are the engines', read back every time -- so there is no table here for
    # them, and that is the thing to notice about this list of checks.
    t_ok "the notes table is in the panel's database"    pg "SELECT 1 FROM panel.studio_db_users LIMIT 0"
    t_ok "the panel's own role can use it"               pg_role panel "SELECT count(*) FROM panel.studio_db_users"
    t_no "the gate can NOT read it"                      pg_role gate "SELECT count(*) FROM panel.studio_db_users"
    t_no "and a name the engines would refuse can't be written down" \
         pg "INSERT INTO panel.studio_db_users (engine, name, created_at) VALUES ('postgres', 'Not A Name', 0)"
    t_no "nor an engine the panel doesn't have" \
         pg "INSERT INTO panel.studio_db_users (engine, name, created_at) VALUES ('sqlite', 'zz_u', 0)"
    t_ok "one login per name per engine, and the same name on both is two logins" \
         pg "INSERT INTO panel.studio_db_users (engine, name, created_at)
             VALUES ('postgres', 'zz_u_verify', 0), ('mariadb', 'zz_u_verify', 0)"
    t_no "...but not twice on one engine" \
         pg "INSERT INTO panel.studio_db_users (engine, name, created_at) VALUES ('postgres', 'zz_u_verify', 0)"
    pg "DELETE FROM panel.studio_db_users WHERE name LIKE 'zz_u%'" >/dev/null
    # A password is generated, shown to her once and handed to the engine; nothing
    # keeps a copy. That is a fact about this table's shape rather than a rule the
    # code has to remember, so it is checked as a shape.
    ucols=$(pg "SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
                  FROM information_schema.columns
                 WHERE table_schema = 'panel' AND table_name = 'studio_db_users'")
    [[ $ucols == 'id,engine,name,note,created_at' ]] \
        && ok "it holds a note and when, and nothing else -- there is no password column to leak" \
        || bad "studio_db_users columns are: $ucols"
    upage=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org/databases/users")
    [[ $upage == "302 https://panel.pammy.org/login?next=%2Fdatabases%2Fusers" ]] \
        && ok "https://panel.pammy.org/databases/users is one of the panel's pages (signed out: on to sign-in)" \
        || bad "https://panel.pammy.org/databases/users gave $upage"
    t_ok "signing in is what its API asks for too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases/users | grep -qx 401"

    echo "--- designing a table (introspect and Apply, docs/databases-plan.md 8 and 10)"
    # The round trip, on her real engines: the printer writes a table, the reader
    # reads it back, and what comes back is what was asked for. If those two ever
    # disagreed she would see a change waiting on a database she had not touched.
    VSCHEMA="zz_schema_verify_$$"
    for eng in postgres mariadb; do
        if ! dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            bad "could not make a database to design on $eng"
            continue
        fi
        empty=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $empty == *'"tables":[]'* ]] && ok "a new database on $eng has nothing in it yet" \
            || bad "introspect on a new $eng database said: ${empty:0:120}"

        # one of everything she can pick, in one step
        patch='[{"kind":"create-table","table":{"name":"notes","columns":[
              {"name":"id","type":"integer","required":true,"identity":true},
              {"name":"title","type":"short_text","length":120,"required":true},
              {"name":"body","type":"text","required":false},
              {"name":"pages","type":"integer","required":false,"default":{"kind":"number","value":1}},
              {"name":"price","type":"decimal","precision":8,"scale":2,"required":false},
              {"name":"done","type":"boolean","required":false,"default":{"kind":"boolean","value":false}},
              {"name":"on_day","type":"date","required":false},
              {"name":"at_time","type":"time","required":false},
              {"name":"made_at","type":"timestamptz","required":true,"default":{"kind":"now"}},
              {"name":"ref","type":"uuid","required":false}],
              "primaryKey":["id"],"uniques":[{"name":"notes_title_key","columns":["title"]}],
              "foreignKeys":[],"indexes":[]}}]'
        # what it WOULD run, from the same printer that runs it (Review's Advanced)
        sql=$(dcall "$SVC" "{\"op\":\"preview-schema\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"patch\":$patch,\"actor\":\"verify\"}" 2>/dev/null | tr -d '\n')
        if [[ $eng == postgres ]]; then
            [[ $sql == *'GENERATED BY DEFAULT AS IDENTITY'* && $sql == *'TIMESTAMPTZ'* ]] \
                && ok "it writes Postgres's own words for a table" || bad "preview on postgres said: ${sql:0:160}"
        else
            [[ $sql == *'AUTO_INCREMENT'* && $sql == *'DATETIME(6)'* && $sql == *'ENGINE=InnoDB'* ]] \
                && ok "it writes MariaDB's own words for a table" || bad "preview on mariadb said: ${sql:0:160}"
        fi
        # looking is not doing: preview composed all that and changed nothing
        peek=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $peek == *'"tables":[]'* ]] && ok "...and looking is not doing: the table is not there yet ($eng)" \
            || bad "$eng made something while only previewing"

        applied=$(dcall "$SVC" "{\"op\":\"apply-schema\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"patch\":$patch,\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $applied == *'"applied":1'* && $applied == *'"failed":null'* ]] \
            && ok "made the table on $eng" || bad "apply on $eng said: ${applied:0:200}"

        back=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        # every kind of field comes back as the kind she picked, not as the
        # engine's spelling of it
        kinds=$(printf '%s' "$back" | grep -o '"type":"[a-z_]*"' | sed 's/.*:"//;s/"//' | paste -sd, -)
        [[ $kinds == "integer,short_text,text,integer,decimal,boolean,date,time,timestamptz,uuid" ]] \
            && ok "and reads every kind of field back as the kind it was asked for ($eng)" \
            || bad "$eng read the fields back as: $kinds"
        [[ $back == *'"identity":true'* ]] && ok "the field that fills itself in says so ($eng)" \
            || bad "$eng did not read the auto-filled id back"
        [[ $back == *'"kind":"now"'* ]] && ok "and so does the one that starts at the moment it is added ($eng)" \
            || bad "$eng did not read the 'now' starting value back"

        # a change that keeps her rows: the writing follows the rename
        dcall "$SVC" "{\"op\":\"apply-schema\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"patch\":[{\"kind\":\"rename-column\",\"table\":\"notes\",\"column\":\"body\",\"to\":\"method\"}],\"actor\":\"verify\"}" >/dev/null 2>&1
        renamed=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $renamed == *'"name":"method"'* && $renamed != *'"name":"body"'* ]] \
            && ok "renamed a field on $eng" || bad "$eng did not rename the field"

        # drift: a patch worked out from a schema that has moved is refused
        stale=$(dcall "$SVC" "{\"op\":\"apply-schema\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"patch\":[{\"kind\":\"drop-table\",\"table\":\"notes\"}],\"expect\":\"00000000000000000000000000000000\",\"actor\":\"verify\"}" 2>&1)
        [[ $stale == conflict:* ]] && ok "it refuses changes worked out from an older reading ($eng)" \
            || bad "$eng took a stale patch: ${stale:0:120}"
        still=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $still == *'"name":"notes"'* ]] && ok "...and the table it would have removed is still there ($eng)" \
            || bad "$eng removed the table despite refusing the patch"

        dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VSCHEMA\",\"actor\":\"verify\"}" >/dev/null 2>&1
    done
    # her own database is untouched by all of that
    still_db=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null | grep -c '"name": "pamela"')
    [[ ${still_db:-0} == 2 ]] && ok "her own 'pamela' database is still on both engines" \
        || bad "her 'pamela' database: ${still_db:-0} of 2 still there"

    # S3: a schema patch is an inbound line, and this socket is the only one that
    # takes a big one. Proved both ways, because a cap that is not really there
    # is worth nothing: the helper takes 200KB, the website folder helper does not.
    big=$(python3 -c "import json;print(json.dumps({'op':'introspect','engine':'postgres','name':'pamela','pad':'x'*200000,'actor':'verify'}))")
    printf '%s\n' "$big" > /tmp/pammy-verify-big.$$.json
    t_ok "the database helper takes a request far bigger than 64KB (S3)" \
         sh -c "runuser -u $SVC -- sh -c 'cat /tmp/pammy-verify-big.$$.json | socat -t 30 - UNIX-CONNECT:$PDSOCK' | grep -q '\"ok\":true'"
    t_no "...and the website folder helper still does not (its cap is untouched)" \
         sh -c "runuser -u $SVC -- sh -c 'sed s/introspect/list/ /tmp/pammy-verify-big.$$.json | socat -t 30 - UNIX-CONNECT:$SOCK' | grep -q '\"ok\":true'"
    rm -f "/tmp/pammy-verify-big.$$.json"

    echo "--- the drawing she has not applied yet (/databases/:engine/:name)"
    t_ok "the drafts table is in the panel's database"   pg "SELECT 1 FROM panel.studio_drafts LIMIT 0"
    t_ok "the panel's own role can use it"               pg_role panel "SELECT count(*) FROM panel.studio_drafts"
    t_no "the gate can NOT read it"                      pg_role gate "SELECT count(*) FROM panel.studio_drafts"
    # one drawing per database, and it goes when the panel stops looking after it
    pg "INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'zz_draft_verify', 0)" >/dev/null
    did=$(pg "SELECT id FROM panel.studio_databases WHERE name = 'zz_draft_verify'")
    t_ok "a drawing can be kept for a database the panel looks after" \
         pg "INSERT INTO panel.studio_drafts (database_id, draft_json, based_on, updated_at)
             VALUES ($did, '{\"tables\":[]}', 'x', 0)"
    t_no "...but not twice for the same one" \
         pg "INSERT INTO panel.studio_drafts (database_id, draft_json, based_on, updated_at)
             VALUES ($did, '{\"tables\":[]}', 'x', 0)"
    t_no "nor for a database it is not looking after" \
         pg "INSERT INTO panel.studio_drafts (database_id, draft_json, based_on, updated_at)
             VALUES (987654321, '{\"tables\":[]}', 'x', 0)"
    pg "DELETE FROM panel.studio_databases WHERE id = $did" >/dev/null
    left=$(pg "SELECT count(*) FROM panel.studio_drafts WHERE database_id = $did")
    [[ ${left:-1} == 0 ]] && ok "and it goes when the panel stops looking after the database" \
        || bad "a drawing outlived its database row"
    for addr in "/databases/postgres/pamela" "/databases/postgres/pamela/canvas" "/databases/postgres/pamela/tables/things" "/databases/postgres/pamela/review"; do
        enc=$(printf '%s' "$addr" | sed 's|/|%2F|g')
        dpage=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org$addr")
        [[ $dpage == "302 https://panel.pammy.org/login?next=$enc" ]] \
            && ok "https://panel.pammy.org$addr is one of the panel's pages (signed out: on to sign-in)" \
            || bad "https://panel.pammy.org$addr gave $dpage"
    done
    echo "--- the canvas, and where she put the rectangles (docs/databases-plan.md 6)"
    t_ok "the layouts table is in the panel's database"  pg "SELECT 1 FROM panel.studio_layouts LIMIT 0"
    t_ok "the panel's own role can use it"               pg_role panel "SELECT count(*) FROM panel.studio_layouts"
    t_no "the gate can NOT read it"                      pg_role gate "SELECT count(*) FROM panel.studio_layouts"
    pg "INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'zz_layout_verify', 0)" >/dev/null
    lid=$(pg "SELECT id FROM panel.studio_databases WHERE name = 'zz_layout_verify'")
    t_ok "where the rectangles are can be kept for a database the panel looks after" \
         pg "INSERT INTO panel.studio_layouts (database_id, layout_json, updated_at)
             VALUES ($lid, '{\"tables\":{}}', 0)"
    t_no "...but not twice for the same one" \
         pg "INSERT INTO panel.studio_layouts (database_id, layout_json, updated_at)
             VALUES ($lid, '{\"tables\":{}}', 0)"
    t_no "nor for a database it is not looking after" \
         pg "INSERT INTO panel.studio_layouts (database_id, layout_json, updated_at)
             VALUES (987654321, '{\"tables\":{}}', 0)"
    pg "DELETE FROM panel.studio_databases WHERE id = $lid" >/dev/null
    lleft=$(pg "SELECT count(*) FROM panel.studio_layouts WHERE database_id = $lid")
    [[ ${lleft:-1} == 0 ]] && ok "and it goes when the panel stops looking after the database" \
        || bad "a layout outlived its database row"
    # The whole reason positions are their own table: a drawing and a desk are
    # different things, so throwing one away must not tidy the other.
    lcols=$(pg "SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
                  FROM information_schema.columns
                 WHERE table_schema = 'panel' AND table_name = 'studio_layouts'")
    [[ $lcols == 'database_id,layout_json,updated_at,updated_by' ]] \
        && ok "it holds where the tables are and nothing about the database itself" \
        || bad "studio_layouts columns are: $lcols"

    # The canvas needs inline style attributes to place a single table, and a
    # nonce cannot cover an attribute. Both halves are checked, because a
    # loosening that is wider than it says is worse than no loosening: style
    # ATTRIBUTES are allowed, <style> ELEMENTS are still nonce-only.
    csp=$(curl -s --max-time 15 -D - -o /dev/null "https://panel.pammy.org/login" | tr -d '\r')
    grep -qi "^content-security-policy: .*style-src-attr 'unsafe-inline'" <<<"$csp" \
        && ok "the canvas may place a table (style-src-attr)" \
        || bad "style-src-attr is not in the panel's policy: $(grep -i '^content-security-policy' <<<"$csp" | head -c 200)"
    grep -qi "^content-security-policy: .*style-src 'self' 'nonce-[A-Za-z0-9+/=]\{24\}'" <<<"$csp" \
        && ok "...and a stylesheet still needs this page's nonce" \
        || bad "style-src is no longer nonce-only: $(grep -i '^content-security-policy' <<<"$csp" | head -c 200)"
    grep -qi "^content-security-policy: .*style-src 'self' 'nonce-[A-Za-z0-9+/=]\{24\}' 'unsafe-inline'" <<<"$csp" \
        && bad "style-src itself took 'unsafe-inline' -- the loosening is wider than it says" \
        || ok "...and 'unsafe-inline' was NOT added to style-src itself"

    echo "--- connecting tables (docs/databases-plan.md 7)"
    # The round trip on her real engines: a relationship the panel composed is
    # one an engine really takes, and it comes back as a relationship rather
    # than as a constraint. Slice 4 proved the printer; this proves the meaning.
    VREL="zz_rel_verify_$$"
    for eng in postgres mariadb; do
        if ! dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"$VREL\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            bad "could not make a database to connect tables on $eng"
            continue
        fi
        # two tables, then the connection between them, as one patch
        made='[{"kind":"create-table","table":{"name":"authors","columns":[
              {"name":"id","type":"integer","required":true,"identity":true},
              {"name":"name","type":"short_text","length":120,"required":true}],
              "primaryKey":["id"],"uniques":[],"foreignKeys":[],"indexes":[]}},
              {"kind":"create-table","table":{"name":"posts","columns":[
              {"name":"id","type":"integer","required":true,"identity":true},
              {"name":"author_id","type":"integer","required":false}],
              "primaryKey":["id"],"uniques":[],"foreignKeys":[],"indexes":[]}},
              {"kind":"add-foreign-key","table":"posts","foreignKey":{"name":"posts_author_id_fkey",
              "columns":["author_id"],"references":{"table":"authors","columns":["id"]},"onDelete":"restrict"}}]'
        applied=$(dcall "$SVC" "{\"op\":\"apply-schema\",\"engine\":\"$eng\",\"name\":\"$VREL\",\"patch\":$made,\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $applied == *'"applied":3'* && $applied == *'"failed":null'* ]] \
            && ok "made two tables and the connection between them on $eng" \
            || bad "connecting on $eng said: ${applied:0:200}"

        back=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VREL\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $back == *'"references":{"table":"authors","columns":["id"]}'* ]] \
            && ok "and reads the connection back pointing at the right place ($eng)" \
            || bad "$eng did not read the connection back: ${back:0:200}"
        [[ $back == *'"onDelete":"restrict"'* ]] \
            && ok "...with the safe default about deleting kept ($eng)" \
            || bad "$eng lost what should happen when a row is deleted"

        # Prevent deletion is not decoration: the engine really refuses. Checked
        # by asking it to, because a rule nothing enforces is worse than none.
        if [[ $eng == postgres ]]; then
            pg_as_studio() { PGPASSWORD="$(cat "$PASS_DIR/studio-postgres.pass")" PGCONNECT_TIMEOUT=5 \
                psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p 5433 -U pammy_studio -d "$VREL" -c "$1"; }
            pg_as_studio "INSERT INTO authors (name) VALUES ('Pamela')" >/dev/null 2>&1
            pg_as_studio "INSERT INTO posts (author_id) VALUES (1)" >/dev/null 2>&1
            t_no "the engine really refuses to delete a row something points at ($eng)" \
                 pg_as_studio "DELETE FROM authors WHERE id = 1"
            t_ok "...and the rows themselves are fine ($eng)" pg_as_studio "SELECT 1 FROM posts WHERE author_id = 1"
        fi

        dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VREL\",\"actor\":\"verify\"}" >/dev/null 2>&1
    done

    echo "--- what her tables mean (the app, docs/databases-plan.md 11)"
    t_ok "the resources table is in the panel's database"  pg "SELECT 1 FROM panel.studio_resources LIMIT 0"
    t_ok "the fields table is too"                         pg "SELECT 1 FROM panel.studio_fields LIMIT 0"
    t_ok "the panel's own role can use them"               pg_role panel "SELECT count(*) FROM panel.studio_resources"
    t_no "the gate can NOT read them"                      pg_role gate "SELECT count(*) FROM panel.studio_resources"
    t_no "...nor the fields"                               pg_role gate "SELECT count(*) FROM panel.studio_fields"
    pg "INSERT INTO panel.studio_databases (engine, name, adopted_at) VALUES ('postgres', 'zz_res_verify', 0)" >/dev/null
    rid=$(pg "SELECT id FROM panel.studio_databases WHERE name = 'zz_res_verify'")
    t_ok "what a table means can be written down" \
         pg "INSERT INTO panel.studio_resources (database_id, table_name) VALUES ($rid, 'recipes')"
    t_no "...but not twice for the same table" \
         pg "INSERT INTO panel.studio_resources (database_id, table_name) VALUES ($rid, 'recipes')"
    t_no "nor for a database the panel is not looking after" \
         pg "INSERT INTO panel.studio_resources (database_id, table_name) VALUES (987654321, 'recipes')"
    t_no "and not a table name the engines would refuse" \
         pg "INSERT INTO panel.studio_resources (database_id, table_name) VALUES ($rid, 'Not A Table')"
    # "she has not said" is a real third answer, not a no
    nullable=$(pg "SELECT is_nullable FROM information_schema.columns
                    WHERE table_schema = 'panel' AND table_name = 'studio_resources' AND column_name = 'enabled'")
    [[ $nullable == YES ]] \
        && ok "whether she manages a table can be unanswered, which is not the same as no" \
        || bad "studio_resources.enabled is_nullable = $nullable"
    t_ok "and what she says about one field can be written down" \
         pg "INSERT INTO panel.studio_fields (database_id, table_name, field_name) VALUES ($rid, 'recipes', 'title')"
    t_no "...but not twice for the same field" \
         pg "INSERT INTO panel.studio_fields (database_id, table_name, field_name) VALUES ($rid, 'recipes', 'title')"
    pg "DELETE FROM panel.studio_databases WHERE id = $rid" >/dev/null
    rleft=$(pg "SELECT (SELECT count(*) FROM panel.studio_resources WHERE database_id = $rid)
                     + (SELECT count(*) FROM panel.studio_fields WHERE database_id = $rid)")
    [[ ${rleft:-1} == 0 ]] && ok "and it all goes when the panel stops looking after the database" \
        || bad "a resource definition outlived its database row"
    # These tables are new and never lived in SQLite, so their yes/no columns are
    # real booleans rather than the 0/1 integers the older tables use. Checked as
    # a shape, because it is the reason `enabled` can be unanswered at all.
    bools=$(pg "SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'panel' AND table_name IN ('studio_resources', 'studio_fields')
                   AND data_type = 'boolean'")
    # Exact rather than "at least": adding a flag should be a decision someone
    # takes on purpose, the way the column-list checks above work.
    # 14 since 0010-db-examples.sql added public_read ("Anyone can read these").
    [[ ${bools:-0} == 14 ]] && ok "all 14 yes/no columns are real yes/no columns, so \"she has not said\" can exist" \
        || bad "expected 14 boolean columns across studio_resources and studio_fields, found ${bools:-0}"
    for addr in "/databases/postgres/pamela/app" "/databases/postgres/pamela/app/things"; do
        enc=$(printf '%s' "$addr" | sed 's|/|%2F|g')
        apage=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org$addr")
        [[ $apage == "302 https://panel.pammy.org/login?next=$enc" ]] \
            && ok "https://panel.pammy.org$addr is one of the panel's pages (signed out: on to sign-in)" \
            || bad "https://panel.pammy.org$addr gave $apage"
    done
    t_ok "signing in is what the app's API asks for too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases/postgres/pamela/app | grep -qx 401"

    echo "--- her records, through the app (docs/databases-plan.md 11.7)"
    # The first checks in this suite that write to a table rather than describe
    # one. Each one asks something only a real engine can answer: does a search
    # for SQL find nothing and break nothing, and is a per cent sign a per cent
    # sign rather than a wildcard.
    VROWS="zz_rows_verify_$$"
    for eng in postgres mariadb; do
        if ! dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            bad "could not make a database to keep records in on $eng"
            continue
        fi
        made='[{"kind":"create-table","table":{"name":"recipes","columns":[
              {"name":"id","type":"integer","required":true,"identity":true},
              {"name":"title","type":"short_text","length":120,"required":true},
              {"name":"servings","type":"integer","required":false}],
              "primaryKey":["id"],"uniques":[],"foreignKeys":[],"indexes":[]}}]'
        dcall "$SVC" "{\"op\":\"apply-schema\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"patch\":$made,\"actor\":\"verify\"}" >/dev/null 2>&1

        add() { dcall "$SVC" "{\"op\":\"insert-row\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"table\":\"recipes\",\"values\":{\"title\":$1,\"servings\":$2},\"back\":[\"id\",\"title\"],\"actor\":\"verify\"}" 2>/dev/null; }
        one=$(add '"Lemon cake"' 8 | tr -d ' \n')
        [[ $one == *'"title":"Lemoncake"'* || $one == *'"title": "Lemon cake"'* ]] \
            && ok "added a record and got it back ($eng)" || bad "insert on $eng said: ${one:0:160}"
        add '"Carrot cake"' 6 >/dev/null
        add '"100% rye bread"' 2 >/dev/null
        add "\"'; DROP TABLE recipes; --\"" 1 >/dev/null

        list() { dcall "$SVC" "{\"op\":\"list-rows\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"query\":{\"table\":\"recipes\",\"columns\":[\"id\",\"title\",\"servings\"],\"limit\":20,\"offset\":0$1},\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n'; }
        all=$(list "")
        [[ $all == *'"total":4'* ]] && ok "and all four are there ($eng)" || bad "$eng listed: ${all:0:160}"

        cakes=$(list ',"search":{"columns":["title"],"text":"cake"}')
        [[ $cakes == *'"total":2'* ]] && ok "a search narrows the count to the same rows it lists ($eng)" \
            || bad "$eng searched and said: ${cakes:0:160}"
        upper=$(list ',"search":{"columns":["title"],"text":"CAKE"}')
        [[ $upper == *'"total":2'* ]] && ok "...and capital letters make no difference ($eng)" \
            || bad "$eng cared about case: ${upper:0:160}"

        # % and _ mean something to LIKE. Without escaping, "100%" would match
        # everything starting with 100 -- and a bare % would match every row.
        pc=$(list ',"search":{"columns":["title"],"text":"100%"}')
        [[ $pc == *'"total":1'* ]] && ok "a per cent sign is a per cent sign, not a wildcard ($eng)" \
            || bad "$eng treated % as a wildcard: ${pc:0:160}"
        bare=$(list ',"search":{"columns":["title"],"text":"%"}')
        [[ $bare == *'"total":1'* ]] && ok "...and a search for just % finds only the row with one ($eng)" \
            || bad "$eng matched everything for a bare %: ${bare:0:160}"

        # The whole reason values are parameters: this is a thing to look for,
        # never a thing to run.
        sqlish=$(list ',"search":{"columns":["title"],"text":"DROP TABLE"}')
        [[ $sqlish == *'"total":1'* ]] && ok "SQL typed into the search box is looked for, not run ($eng)" \
            || bad "$eng searched for SQL and said: ${sqlish:0:160}"
        still=$(dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $still == *'"name":"recipes"'* ]] && ok "...and the table is still there afterwards ($eng)" \
            || bad "$eng lost the table to a search box"

        # sorted, and paged so that two pages do not show the same row twice
        sorted=$(list ',"order":{"column":"servings","dir":"desc"}')
        [[ $sorted == *'"servings":8'* ]] && ok "sorted the way it was asked ($eng)" || bad "$eng did not sort"
        p1=$(list ',"limit":2,"offset":0,"order":{"column":"servings","dir":"asc"}')
        p2=$(list ',"limit":2,"offset":2,"order":{"column":"servings","dir":"asc"}')
        [[ $p1 != "$p2" && $p1 == *'"total":4'* && $p2 == *'"total":4'* ]] \
            && ok "and two pages of it are different rows, out of the same four ($eng)" \
            || bad "$eng paged badly"

        # changing and deleting one record, by its own key
        rid=$(printf '%s' "$one" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
        upd=$(dcall "$SVC" "{\"op\":\"update-row\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"table\":\"recipes\",\"values\":{\"title\":\"Lemon drizzle\"},\"where\":{\"id\":$rid},\"back\":[\"id\",\"title\",\"servings\"],\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $upd == *'"title":"Lemondrizzle"'* ]] && ok "changed one record and left the rest of it alone ($eng)" \
            || bad "update on $eng said: ${upd:0:160}"
        [[ $upd == *'"servings":8'* ]] && ok "...its other fields are untouched ($eng)" || bad "$eng lost a field on update"
        del=$(dcall "$SVC" "{\"op\":\"delete-row\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"table\":\"recipes\",\"where\":{\"id\":$rid},\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $del == *'"gone":true'* ]] && ok "deleted one record ($eng)" || bad "delete on $eng said: ${del:0:160}"
        again=$(dcall "$SVC" "{\"op\":\"delete-row\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"table\":\"recipes\",\"where\":{\"id\":$rid},\"actor\":\"verify\"}" 2>/dev/null | tr -d ' \n')
        [[ $again == *'"gone":false'* ]] && ok "...and deleting it twice says so rather than pretending ($eng)" \
            || bad "$eng pretended to delete it twice"

        # A name no database would take is refused before a statement is built,
        # rather than quoted and sent. Capitals and spaces are enough to show it.
        badname=$(dcall "$SVC" "{\"op\":\"list-rows\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"query\":{\"table\":\"recipes\",\"columns\":[\"Not A Field\"]},\"actor\":\"verify\"}" 2>&1)
        [[ $badname == invalid:* ]] && ok "a field name no database would take is refused ($eng)" \
            || bad "$eng took a bad field name: ${badname:0:120}"
        badtable=$(dcall "$SVC" "{\"op\":\"delete-row\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"table\":\"recipes; DROP TABLE recipes\",\"where\":{\"id\":1},\"actor\":\"verify\"}" 2>&1)
        [[ $badtable == invalid:* ]] && ok "...and so is a table name with a statement in it ($eng)" \
            || bad "$eng took a table name with a statement in it: ${badtable:0:120}"

        dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$VROWS\",\"actor\":\"verify\"}" >/dev/null 2>&1
    done
    # her own database came through all of that untouched
    still_r=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null | grep -c '"name": "pamela"')
    [[ ${still_r:-0} == 2 ]] && ok "her own 'pamela' database is still on both engines" \
        || bad "her 'pamela' database: ${still_r:-0} of 2"

    for addr in "/app/postgres/pamela/things" "/app/postgres/pamela/things/new" "/app/postgres/pamela/things/edit"; do
        enc=$(printf '%s' "$addr" | sed 's|/|%2F|g')
        rpage=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org$addr")
        [[ $rpage == "302 https://panel.pammy.org/login?next=$enc" ]] \
            && ok "https://panel.pammy.org$addr is one of the panel's pages (signed out: on to sign-in)" \
            || bad "https://panel.pammy.org$addr gave $rpage"
    done
    t_ok "signing in is what the app's own pages ask for too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/app/postgres/pamela/things | grep -qx 401"
    t_ok "...and the menu of switched-on apps too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/apps | grep -qx 401"

    echo "--- letting programs in (docs/databases-plan.md 11.3)"
    # The one part of the studio the internet can reach. Everything here is
    # checked through Cloudflare, as a program would, because that is the path
    # that matters -- and the most important check is the last one: nothing is
    # reachable until she switches it on.
    t_ok "the catalog table is in the gate's database"   pg "SELECT 1 FROM gate.studio_catalog LIMIT 0"
    t_ok "and the keys table is too"                     pg "SELECT 1 FROM gate.studio_app_keys LIMIT 0"
    t_ok "the gate's own role can use them"              pg_role gate "SELECT count(*) FROM gate.studio_catalog"
    t_no "the PANEL can NOT read the keys"               pg_role panel "SELECT count(*) FROM gate.studio_app_keys"
    # the gate cannot read what a Resource means, which is the whole reason the
    # panel pushes it a finished catalog
    t_no "the gate can NOT read what a table means"      pg_role gate "SELECT count(*) FROM panel.studio_resources"
    t_no "and a catalog for a database name the engines would refuse can't be written down" \
         pg "INSERT INTO gate.studio_catalog (database_id, engine, name, catalog_json, updated_at)
             VALUES (987654321, 'postgres', 'Not A Name', '{}', 0)"
    t_no "nor for an engine the panel doesn't have" \
         pg "INSERT INTO gate.studio_catalog (database_id, engine, name, catalog_json, updated_at)
             VALUES (987654321, 'sqlite', 'ok_name', '{}', 0)"
    # forms into a database (docs/form-to-database-plan.md): the links live in
    # the gate beside the responses, and only the gate may touch them
    t_ok "the form links table is in the gate's database"  pg "SELECT 1 FROM gate.form_links LIMIT 0"
    t_ok "the gate's own role can use it"                   pg_role gate "SELECT count(*) FROM gate.form_links"
    t_no "the PANEL can NOT read it"                        pg_role panel "SELECT count(*) FROM gate.form_links"
    t_ok "a response can say where it was saved, or why not" pg "SELECT saved_to, save_problem, save_retry, save_state, save_tried_at FROM gate.response_saves LIMIT 0"
    # W2: one column says how the last try ended, and only these five words fit
    states=$(pg "SELECT pg_get_constraintdef(oid) FROM pg_constraint
                  WHERE conrelid = 'gate.response_saves'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%save_state%'" \
             | grep -o "'[a-z]\+'" | tr -d "'" | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')
    [[ $states == "problem retrying saved unsure waiting" ]] \
        && ok "...and how a try ended is one of the five the code knows ($states)" \
        || bad "save_state allows [${states:-none}], not the five in src/gate/saves/queue.ts"
    # the order of an app's form (docs/field-order-plan.md)
    t_ok "the order of an app's form can be kept"          pg "SELECT field_order FROM panel.studio_resources LIMIT 0"
    # both switches start off: switching the app on is not the same as putting
    # it on the internet (D9)
    offs=$(pg "SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'gate' AND table_name = 'studio_catalog'
                  AND column_name IN ('api_read', 'api_write') AND column_default = 'false'")
    [[ ${offs:-0} == 2 ]] && ok "reading and writing both start switched off" \
        || bad "the API switches do not default to off (${offs:-0} of 2)"
    # a key is never kept, only its hash -- the same shape as the form keys
    kcols=$(pg "SELECT string_agg(column_name, ',' ORDER BY column_name)
                  FROM information_schema.columns
                 WHERE table_schema = 'gate' AND table_name = 'studio_app_keys' AND column_name LIKE '%key%'")
    [[ $kcols == 'key_hash' ]] \
        && ok "a key is kept only as a hash: there is no column it could leak from" \
        || bad "studio_app_keys key columns are: $kcols"

    # Through Cloudflare, as a program would. allow() in src/gate/studio.ts
    # refuses in order -- no app (404), switch off (403), no key (401) -- so a
    # database with no app switched on never gets as far as the key.
    dapi() { curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/data/$1" "${@:2}"; }
    dapi_err() { curl -s --max-time 15 "https://pammy.org/_pammy/api/data/$1" "${@:2}" | grep -o '"error":"[^"]*"'; }
    # Asked up to three times: one answer lost on the way through Cloudflare
    # (empty, a timeout) failed the 8b-2 install although both said no-app.
    for _try in 1 2 3; do
        ans_hers=$(dapi_err "postgres/pamela/things")
        ans_none=$(dapi_err "postgres/zz_never_made_$$/things")
        [[ -n $ans_hers && $ans_hers == "$ans_none" ]] && break
        sleep 2
    done
    [[ -n $ans_hers && $ans_hers == "$ans_none" ]] \
        && ok "a database with no app answers exactly like one that does not exist" \
        || bad "her database answered ${ans_hers:-nothing}, a missing one ${ans_none:-nothing}"
    [[ $(dapi "postgres/pamela/things?key=pammy_app_xyz") == 400 ]] \
        && ok "...and refuses one sent in the address, where it would end up in logs" \
        || bad "a key in the address gave $(dapi 'postgres/pamela/things?key=pammy_app_xyz')"
    # The key itself, against an app planted with reading on (the gate reads
    # the catalog per request, so it sees this at once), then removed. The
    # request stops at the key, so the made-up database is never asked for.
    dapi_db="zz_verify_dapi_$$"
    pg "INSERT INTO gate.studio_catalog (database_id, engine, name, catalog_json, api_read, updated_at)
        VALUES (987654311, 'postgres', '$dapi_db',
                '{\"resources\":[{\"slug\":\"things\",\"table\":\"things\",\"singular\":\"Thing\",\"plural\":\"Things\",\"columns\":[\"id\"],\"key\":[\"id\"],\"titleField\":null,\"searchable\":[],\"sortable\":[],\"can\":{}}]}',
                true, 0)" >/dev/null 2>&1
    nokey=$(dapi "postgres/$dapi_db/things")
    madeup=$(dapi "postgres/$dapi_db/things" -H 'Authorization: Bearer pammy_app_madeup')
    pg "DELETE FROM gate.studio_catalog WHERE database_id = 987654311" >/dev/null 2>&1
    [[ $nokey == 401 ]] && ok "the data API asks for a key" \
        || bad "the data API without a key gave $nokey (on an app with reading on)"
    [[ $madeup == 401 ]] && ok "a key that was never made reaches nothing" \
        || bad "a made-up key gave $madeup (on an app with reading on)"
    body=$(curl -s --max-time 15 "https://pammy.org/_pammy/api/data/postgres/pamela/things")
    grep -q '"error"' <<<"$body" && ! grep -qi 'pamela\|postgres' <<<"$body" \
        && ok "...and the refusal says nothing about what is or is not there" \
        || bad "the refusal leaked something: ${body:0:160}"
    # the data API is not something the panel serves: it is the gate's, on her
    # own site, which is what puts it behind the same Cloudflare-only rule
    [[ $(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://panel.pammy.org/_pammy/api/data/postgres/pamela/things") == 404 ]] \
        && ok "and it is not on the panel's address at all" \
        || bad "the panel answered on the data API's address"

    for addr in "/databases/postgres/pamela/programs"; do
        enc=$(printf '%s' "$addr" | sed 's|/|%2F|g')
        kpage=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://panel.pammy.org$addr")
        [[ $kpage == "302 https://panel.pammy.org/login?next=$enc" ]] \
            && ok "https://panel.pammy.org$addr is one of the panel's pages (signed out: on to sign-in)" \
            || bad "https://panel.pammy.org$addr gave $kpage"
    done
    t_ok "signing in is what the keys API asks for too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases/postgres/pamela/keys | grep -qx 401"

    t_ok "signing in is what the designer's API asks for too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases/postgres/pamela/schema | grep -qx 401"

    echo "--- Home, activity and guide 14 (docs/databases-plan.md 16)"
    t_ok "Home's database card asks for sign-in too" \
         sh -c "curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://panel.pammy.org/api/databases/home | grep -qx 401"
    t_ok "guide 14 is on the Help tab"                    test -f "$APP/help/14-databases-in-the-control-panel.txt"
    t_ok "...all sixteen parts of it"                     grep -q '^PART 16 -- ' "$APP/help/14-databases-in-the-control-panel.txt"

    # A table applied into a switched-on app is PROPOSED, and the gate serves
    # only what she has said yes to (src/studio/catalog.ts). This is the live
    # form of that rule: every resource in every catalog the gate holds has her
    # yes written down in panel.studio_resources. Installing the fix does not
    # re-push a catalog, so this is also what says whether one pushed by the
    # slice-9 release is still holding something she never ticked. If it fails:
    # on that database's "Letting programs in" page, switch reading off and on
    # again (that pushes a fresh catalog), then run this again.
    unticked_sql="SELECT count(*) FROM gate.studio_catalog c
                   CROSS JOIN LATERAL json_array_elements((c.catalog_json::json)->'resources') r
                   WHERE NOT EXISTS (SELECT 1 FROM panel.studio_resources s
                                      WHERE s.database_id = c.database_id AND s.table_name = r->>'table' AND s.enabled)"
    served=$(pg "SELECT coalesce(sum(json_array_length((catalog_json::json)->'resources')), 0) FROM gate.studio_catalog")
    unticked=$(pg "$unticked_sql")
    [[ $unticked == 0 ]] && ok "the gate serves only what she ticked (${served:-0} thing(s) served in all)" \
        || bad "the gate is serving ${unticked:-?} thing(s) she never ticked -- see the comment above this check"
    # ...and that check can fail: a catalog naming a table nobody ticked is counted
    pg "INSERT INTO gate.studio_catalog (database_id, engine, name, catalog_json, updated_at)
        VALUES (987654310, 'postgres', 'zz_verify_s10', '{\"resources\":[{\"table\":\"zz_nobody_ticked\"}]}', 0)" >/dev/null 2>&1
    planted=$(pg "$unticked_sql")
    pg "DELETE FROM gate.studio_catalog WHERE database_id = 987654310" >/dev/null 2>&1
    [[ $planted == $(( ${unticked:-0} + 1 )) ]] && ok "...and that check notices one planted on purpose (then removed)" \
        || bad "the unticked check did not notice a planted catalog (${planted:-?})"
fi

echo "--- pammy.org's hosts (docs/phase8-plan.md 8-7b: written by pammy-routes, not live until the switch)"
PH=/etc/nginx/pammy-hosts
t_ok "pammy-routes.socket is on, the socket root:svc-pammypanel 660" test "$(systemctl is-enabled pammy-routes.socket 2>&1) $(stat -c '%U:%G %a' /run/pammy-routes.sock 2>/dev/null)" = "enabled root:$SVC 660"
for u in pamela www-data momolig svc-pammygate; do id "$u" >/dev/null 2>&1 && t_no "$u can't ask the routing helper" runuser -u "$u" -- test -w /run/pammy-routes.sock; done
rp=$(systemctl show pammy-routes -p ReadWritePaths -p PrivateNetwork -p CapabilityBoundingSet)
grep -qx 'ReadWritePaths=/etc/nginx/pammy-hosts /etc/nginx/sites-enabled' <<<"$rp" && grep -qx 'PrivateNetwork=yes' <<<"$rp" && grep -qx 'CapabilityBoundingSet=' <<<"$rp" \
    && ok "it writes only $PH (and sites-enabled's links), no network, no capabilities" || bad "pammy-routes: $rp"
[[ $(pg "SELECT name || ' ' || folder_hosts || ' ' || cert FROM panel.domains WHERE home") == 'pammy.org true cloudflare-origin' ]] \
    && ok "the domain pammy.org, folder hosts on, Cloudflare's origin certificate" || bad "the home domain: $(pg 'SELECT name, folder_hosts, cert FROM panel.domains WHERE home')"
got=$(pg "SELECT r.path || ' ' || r.target_kind FROM panel.routes r JOIN panel.hosts h ON h.id = r.host_id WHERE h.name = '@' AND h.with_www AND r.target_kind IN ('site', 'proxy') ORDER BY r.path" | tr '\n' ',')
[[ $got == '/ site,/api/ proxy,' ]] && ok "pammy.org and www: the whole website, and /api/ to pamela-app" || bad "pammy.org's routes: $got"
bp=$(tr -d '\n' < /etc/nginx/pammy-wordpress/placement 2>/dev/null)
case $bp in
    "subdomain "*) [[ -f $PH/hosts/${bp#subdomain }.conf ]] && grep -q 'pammy-wordpress/proxy.conf' "$PH/hosts/${bp#subdomain }.conf" && ok "the blog's route follows its placement ($bp)" || bad "no $PH/hosts/${bp#subdomain }.conf for the blog ($bp)" ;;
    "path "*) grep -q "location ^~ /${bp#path }/ {" "$PH/hosts/@.conf" && ok "the blog's route follows its placement ($bp)" || bad "pammy.org/${bp#path }/ isn't the blog in $PH ($bp)" ;;
    *) note "the blog is placed '$bp': no route" ;;
esac
grep -qF 'server_name "~^(?!(?:www|api)\.)(?<sub>' "$PH/catch-all.conf" 2>/dev/null && ok "every other <folder>.pammy.org: the folder catch-all" || bad "$PH/catch-all.conf isn't the folder catch-all"
# the gate's cookie kept from apps (docs/s1-plan.md S1e): the maps are in site.conf; pamela-app
# (/api/) and her PHP still get every cookie (S1e-Q1, decided 2026-10-08: unchanged for now)
t_ok "site.conf has the maps that keep the gate's cookie from apps" sh -c "grep -q '^map \$http_cookie \$app_cookie_pammy_visitor_once {' $PH/site.conf && grep -q '^map \$app_cookie_pammy_visitor_once \$app_cookie_pammy_visitor {' $PH/site.conf"
# WordPress no longer gets it (S1e, momolig 2026-10-08): the map at http level, and every
# WordPress proxy file with exactly one Cookie line naming it
t_ok "conf.d/pammy-wordpress-cookie.conf is this release's map, root's 644" sh -c "cmp -s $APP/apps/wordpress-nginx/cookie-map.conf /etc/nginx/conf.d/pammy-wordpress-cookie.conf && test \"\$(stat -c '%U %a' /etc/nginx/conf.d/pammy-wordpress-cookie.conf)\" = 'root 644'"
wp_bad=; wp_n=0
for f in /etc/nginx/pammy-wordpress/proxy*.conf; do
    [[ -f $f ]] || continue
    wp_n=$((wp_n+1))
    [[ $(grep -c '^proxy_set_header Cookie *\$wp_cookie_pammy_visitor;$' "$f") == 1 && $(grep -c '^proxy_set_header Cookie' "$f") == 1 ]] || wp_bad+=" ${f##*/}"
done
if [[ -z $wp_bad && $wp_n -gt 0 ]]; then ok "every WordPress proxy file ($wp_n) hands WordPress the cookies without the gate's"
elif [[ $wp_n == 0 ]]; then note "no WordPress proxy file: nothing to check"
else bad "WordPress proxy file(s) without exactly one Cookie line naming the map:$wp_bad"; fi
hconf=$(mktemp /tmp/pammy-hosts-nginx.XXXXXX)
sed "s#^\(\s*\)include /etc/nginx/sites-enabled/\*;#\1include $PH/site.conf;#" /etc/nginx/nginx.conf > "$hconf"
t_ok "nginx -t takes them on their own" nginx -t -q -c "$hconf"
rm -f "$hconf"
if [[ -e /etc/nginx/sites-enabled/pammy-hosts ]]; then
    t_ok "live (8-7c): sites-enabled/pammy-hosts is the link to $PH/site.conf" test "$(readlink /etc/nginx/sites-enabled/pammy-hosts)" = "$PH/site.conf"
    t_no "...and the pamela site is out of sites-enabled (its file kept in sites-available)" test -e /etc/nginx/sites-enabled/pamela
    t_no "...and certbot doesn't renew pammy.org's old certificate" test -f /etc/letsencrypt/renewal/pammy.org.conf
else t_ok "not live yet: the pamela site still serves pammy.org" test -L /etc/nginx/sites-enabled/pamela; fi
# Cloudflare in front (docs/security-performance-review.md S6): every block includes the
# real-IP file, so her logs, limit_req and every X-Real-IP (pamela-app, the gate, WordPress)
# see the visitor; a request straight here can't name another address
t_ok "the domain's row says Cloudflare is in front" test "$(pg "SELECT front FROM panel.domains WHERE home")" = cloudflare
miss=$(for f in "$PH"/hosts/*.conf "$PH/catch-all.conf"; do [[ $(grep -c '^server {' "$f") == $(grep -c "include $PH/cloudflare-realip.conf;" "$f") ]] || echo "${f#$PH/}"; done)
n=$(grep -c '^set_real_ip_from ' "$PH/cloudflare-realip.conf" 2>/dev/null)
[[ -z $miss && ${n:-0} -ge 10 ]] && ! grep -qE '^set_real_ip_from (127\.|10\.|192\.168\.|::1|0\.0\.0\.0)' "$PH/cloudflare-realip.conf" \
    && ok "every block includes the real-IP file (Cloudflare's $n ranges, nothing else)" || bad "real-IP file: ${n:-no} ranges; blocks without it: ${miss:-none}"
if [[ -e /etc/nginx/sites-enabled/pammy-hosts ]]; then
    seen_ip() { sleep 1; grep -F " $1 " /var/log/nginx/pammy.access.log 2>/dev/null | tail -1 | cut -d' ' -f1; }
    p="/zz-verify-s6-$$-direct"
    curl -ksS -o /dev/null --max-time 10 -H 'CF-Connecting-IP: 203.0.113.9' --resolve "pammy.org:443:$ORIGIN_IP" "https://pammy.org$p" >/dev/null 2>&1
    ip=$(seen_ip "$p")
    [[ -n $ip && $ip != 203.0.113.9 ]] && ok "...straight to this server, CF-Connecting-IP is ignored (logged as $ip)" || bad "pammy.org: a request straight here was logged as '${ip:-nothing}'"
    p="/zz-verify-s6-$$-cloudflare"
    if curl -ksS -o /dev/null --max-time 15 "https://pammy.org$p" >/dev/null 2>&1; then
        ip=$(seen_ip "$p")
        [[ -n $ip && " $(hostname -I) " == *" $ip "* ]] && ok "...through Cloudflare, the visitor's own address (this server's, $ip)" || bad "pammy.org: a request through Cloudflare was logged as '${ip:-nothing}'"
    else note "pammy.org: couldn't go through Cloudflare from here; that half wasn't checked"; fi
fi

echo "--- the gate (pammy-gate: password-protected folders)"
GATE=svc-pammygate
GSOCK=/run/pammy-gate-admin.sock
gcall() {  # gcall <user> <json> -- ask the gate's admin socket
    local user=$1; shift
    (cd / && runuser -u "$user" -- env SITEFS_SOCKET=$GSOCK /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" "$@")
}
t_ok "system user $GATE exists, no login shell"     test "$(getent passwd "$GATE" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$GATE is NOT in sudo or www-data permanently"  sh -c "id -nG $GATE | tr ' ' '\n' | grep -qxE 'sudo|www-data'"
t_ok "its home is 700 and its own"                   test "$(stat -c '%U %a' /var/lib/svc-pammygate)" = "$GATE 700"
t_ok "the areas it can answer with while the database is out of reach are its own" \
     sh -c 'test ! -e /var/lib/svc-pammygate/areas.json || test "$(stat -c "%U %a" /var/lib/svc-pammygate/areas.json)" = "svc-pammygate 600"'
t_ok "running, starts at boot"                       sh -c "systemctl is-active -q pammy-gate && systemctl is-enabled -q pammy-gate"
glisten=$(ss -ltnH "sport = :3045" | awk '{print $4}' | LC_ALL=C sort -u | tr '\n' ' ')
[[ $glisten == "127.0.0.1:3045 " ]] && ok "listens on 127.0.0.1:3045 only" || bad "gate listening on: ${glisten:-nothing}"
t_ok "admin socket is root:svc-pammypanel 660"       test "$(stat -c '%U:%G %a' "$GSOCK")" = "root:svc-pammypanel 660"
t_ok "the panel's user can manage it"                gcall "$SVC" '{"op":"state","actor":"verify"}'
t_no "pamela can't"                                  gcall pamela '{"op":"state"}'
t_no "the web server can't"                          gcall www-data '{"op":"state"}'
t_no "the gate's own user can't"                     gcall "$GATE" '{"op":"state"}'
# X-Real-IP only from nginx (docs/s1-plan.md S1c)
source "$D/verify-edge.sh"
verify_edge /etc/pammy-panel /etc/nginx/pammy-panel pammy-panel 3044 pammy-gate 3045 panel.pammy.org pammy.org
gpid=$(systemctl show -p MainPID --value pammy-gate)
if [[ $gpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$gpid" | tr -d ' ') == "$(id -u "$GATE")" ]] && ok "runs as $GATE" || bad "gate runs as uid $(ps -o uid= -p "$gpid")"
    grep -q "^Groups:.*\b$(getent group www-data | cut -d: -f3)\b" "/proc/$gpid/status" && ok "has www-data only while running (to read her site like nginx)" || bad "gate process lacks www-data"
    t_ok "inside its sandbox: can read her website"          nsenter -t "$gpid" -m -- test -r /pamela/public
    t_no "inside its sandbox: can't change her website"      nsenter -t "$gpid" -m -- sh -c 'touch /pamela/public/.pammy-probe && rm -f /pamela/public/.pammy-probe'
    t_ok "inside its sandbox: her app folder (.env) blocked" test "$(nsenter -t "$gpid" -m -- stat -c %a /pamela/app)" = 0
    t_ok "inside its sandbox: other sites (/var/www) blocked" test "$(nsenter -t "$gpid" -m -- stat -c %a /var/www)" = 0
    t_ok "inside its sandbox: /srv blocked"                  test "$(nsenter -t "$gpid" -m -- stat -c %a /srv)" = 0
    t_ok "inside its sandbox: TLS private keys blocked"      test "$(nsenter -t "$gpid" -m -- stat -c %a /etc/ssl/cloudflare)" = 0
    t_no "inside its sandbox: her home hidden"               sh -c "nsenter -t $gpid -m -- ls -A /home | grep -q ."
    t_ok "inside its sandbox: its database dir writable"     nsenter -t "$gpid" -m -- test -w /var/lib/svc-pammygate
else
    bad "gate not running"
fi
gprops=$(systemctl show pammy-gate -p NoNewPrivileges -p CapabilityBoundingSet -p IPAddressDeny)
grep -qx 'NoNewPrivileges=yes' <<<"$gprops" && grep -qx 'CapabilityBoundingSet=' <<<"$gprops" && grep -q '^IPAddressDeny=.*0\.0\.0\.0/0' <<<"$gprops" \
    && ok "no sudo, no capabilities, no network beyond localhost" || bad "gate sandbox properties: $gprops"
score=$(systemd-analyze security pammy-gate --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "gate exposure rating: ${score#→ }"
t_ok "nginx: the pamela vhost has the gate in both blocks" test "$(grep -c 'include /etc/nginx/pammy-gate/gate.conf;' /etc/nginx/sites-available/pamela)" = 2

echo "--- visitor settings (docs/accounts-plan.md steps 1 and 4: what needs mail stays off; the rest are the owner's)"
# Emailed links, registering and Open with accounts need the gate's door to the mail service,
# which pammy.org's profile doesn't give it: they stay off. Changing one's own password and
# deleting one's own account are momolig's and Pamela's to switch on (Settings > Visitors;
# Change password was switched on 2026-10-05): the account page is there exactly when one is.
[[ $(pg "SELECT count(*) || ' ' || bool_or(emailed_links OR self_register OR open_areas)::text FROM gate.visitor_settings" 2>/dev/null) == "1 false" ]] \
    && ok "gate.visitor_settings: one row; emailed links, registering and Open with accounts off" || bad "gate.visitor_settings: $(pg 'SELECT * FROM gate.visitor_settings' 2>&1 | head -c 200)"
vs=$(gcall "$SVC" '{"op":"visitor-settings.get","actor":"verify"}' 2>/dev/null)
vs1=$(tr -d ' \n' <<<"$vs")
off=0; for k in emailedLinks selfRegister openAreas; do grep -q "\"$k\":false" <<<"$vs1" && off=$((off+1)); done
[[ $off == 3 ]] && ok "the gate reads them: those three off" || bad "the gate's visitor settings: $(head -c 200 <<<"$vs1")"
own=""
for k in changePassword deleteAccount; do grep -q "\"$k\":true" <<<"$vs1" && own="$own $k"; done
note "switched on by the owner (Settings, Visitors):${own:- none}"
# roles (docs/roles-plan.md step 4) are momolig's and Pamela's to turn on; either way is fine
grep -q '"roles":true' <<<"$vs1" && note "roles and privileges are switched on (Settings, Visitors)" || note "roles and privileges are switched off (Settings, Visitors)"
# accounts step 4: pammy.org's gate has no door to the mail service (its profile names
# none), so emailed links -- and registering, which needs them -- can't go on here
t_no "the gate refuses emailed links (no door to the mail service for visitors), even for the panel" \
     gcall "$SVC" '{"op":"visitor-settings.set","key":"emailedLinks","on":true,"mail":true,"actor":"verify"}'
grep -q '"gateMail":false' <<<"$vs1" && ok "...and says so (gateMail false)" || bad "pammy.org's gate says it can email visitors: $(head -c 200 <<<"$vs1")"
saved=$(grep -o '"visitorSettings":{[^}]*}' /var/lib/svc-pammygate/areas.json 2>/dev/null | tr -d ' ')
same=0; for k in emailedLinks selfRegister changePassword deleteAccount openAreas; do
    [[ $(grep -o "\"$k\":[a-z]*" <<<"$saved") == "$(grep -o "\"$k\":[a-z]*" <<<"$vs1")" ]] && same=$((same+1))
done
[[ $same == 5 ]] && ok "its saved copy has the same switches" || bad "the saved copy differs: ${saved:0:200}"
[[ $(pg "SELECT (SELECT count(*) FROM gate.visitors WHERE registered OR email IS NOT NULL) || ' ' || (SELECT count(*) FROM gate.links WHERE purpose <> 'setup')" 2>/dev/null) == "0 0" ]] \
    && ok "no registered accounts, no emails, and only setup links" || bad "accounts already in use: $(pg "SELECT count(*) FROM gate.visitors WHERE registered OR email IS NOT NULL" 2>&1)"
for p in register confirm reset; do
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/$p")
    [[ $code == 404 ]] && ok "https://pammy.org/_pammy/$p is still not there (404)" || bad "/_pammy/$p -> $code"
done
code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/account")
if [[ -n $own ]]; then [[ $code == 200 ]] && ok "https://pammy.org/_pammy/account is there (200): a switch it serves is on" || bad "/_pammy/account -> $code, with$own on"
else [[ $code == 404 ]] && ok "https://pammy.org/_pammy/account is not there (404): both its switches are off" || bad "/_pammy/account -> $code, with both its switches off"; fi

echo "--- roles (docs/roles-plan.md steps 2-3: protected folders on the built-in Protected folder set, same answers)"
own=$(pg "SELECT string_agg(a.path, ' ' ORDER BY a.path) FROM gate.areas a JOIN gate.role_sets s ON s.id = a.role_set_id WHERE s.key IS DISTINCT FROM 'protected-folder'" 2>/dev/null)
roles_on=$(pg "SELECT roles FROM gate.visitor_settings" 2>/dev/null)
if [[ -z $own ]]; then ok "every protected folder uses the built-in Protected folder set"
elif [[ $roles_on == t ]]; then note "folders with roles of their own (step 4, roles switched on): $own"
else bad "folders with roles of their own while roles are switched off: $own"; fi
[[ $(pg "SELECT string_agg(r.key || '=' || coalesce(p.privilege, '-') || '/' || coalesce(r.slot, ''), ' ' ORDER BY r.key) || ' ' || (s.signed_in_role_id IS NULL)::text
         FROM gate.role_sets s JOIN gate.roles r ON r.role_set_id = s.id LEFT JOIN gate.role_all_privileges p ON p.role_id = r.id
         WHERE s.key = 'protected-folder' GROUP BY s.id" 2>/dev/null) == "member=pages.read/ not-signed-in=-/not-signed-in true" ]] \
    && ok "the set: Member opens the pages; not signed in and signed in without a role get nothing" || bad "the Protected folder set: $(pg "SELECT r.key, p.privilege FROM gate.roles r LEFT JOIN gate.role_all_privileges p ON p.role_id = r.id" 2>&1 | head -c 300)"
[[ $(pg "SELECT count(*) FROM gate.memberships m JOIN gate.roles r ON r.id = m.role_id WHERE r.slot IS NOT NULL OR (r.key <> 'member' AND NOT (SELECT roles FROM gate.visitor_settings))" 2>/dev/null) == 0 ]] \
    && ok "nobody holds a slot; with roles off, everyone is a Member ($(pg 'SELECT count(*) FROM gate.memberships' 2>/dev/null) memberships)" || bad "memberships in another role: $(pg "SELECT m.visitor_id, m.area_id, r.key FROM gate.memberships m JOIN gate.roles r ON r.id = m.role_id WHERE r.key <> 'member'" 2>&1 | head -c 200)"
[[ $(pg "SELECT to_regclass('gate.grants') IS NULL" 2>/dev/null) == t ]] && ok "gate.grants is gone (step 3)" || bad "gate.grants is still there"
[[ $(pg "SELECT count(*) FROM gate.role_sets WHERE key LIKE 'app-%'" 2>/dev/null) == 0 ]] \
    && ok "no app's pammy-panel.json taken in yet" || note "app role sets: $(pg "SELECT key FROM gate.role_sets WHERE key LIKE 'app-%'" 2>&1 | tr '\n' ' ')"
t_ok "the gate's check has room for a full list of privileges (proxy_buffer_size 16k)" \
     grep -q 'proxy_buffer_size 16k;' /etc/nginx/pammy-gate/gate.conf

echo "--- PHP pages (pammy-php: docs/tutorials-plan.md P1-P7)"
PHPU=svc-pammyphp
t_ok "system user $PHPU exists, no login shell"         test "$(getent passwd "$PHPU" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$PHPU is NOT in sudo or www-data permanently"     sh -c "id -nG $PHPU | tr ' ' '\n' | grep -qxE 'sudo|www-data'"
t_ok "the distribution's php8.3-fpm is masked (P6)"     test "$(systemctl is-enabled php8.3-fpm.service 2>/dev/null)" = masked
t_no "... and not running"                              systemctl is-active -q php8.3-fpm.service
t_ok "its /run/pammy-php is kept across restarts (so lfdln-php keeps it hidden)" test "$(systemctl show -p RuntimeDirectoryPreserve --value pammy-php)" = yes
t_ok "pammy-php is running"                             systemctl is-active -q pammy-php
t_ok "its socket is svc-pammyphp:www-data 660 (nginx may knock)" test "$(stat -c '%U:%G %a' /run/pammy-php/fpm.sock)" = "$PHPU:www-data 660"
t_ok "the gate's PHP socket is root:$PHPU 660 (P3)"     test "$(stat -c '%U:%G %a' /run/pammy-gate-php.sock)" = "root:$PHPU 660"
phpask() { (cd / && runuser -u "$1" -- curl -s --max-time 5 --unix-socket /run/pammy-gate-php.sock "http://pammy.org$2"); }
phpask "$PHPU" /check | grep -q 'Only /_pammy/api/' && ok "PHP's user reaches the gate there, and only its API" || bad "gate PHP socket: $(phpask "$PHPU" /check | head -c 200)"
t_no "pamela can't use PHP's door"                      sh -c "cd / && runuser -u pamela -- curl -sf --max-time 5 --unix-socket /run/pammy-gate-php.sock http://pammy.org/_pammy/api/"
t_no "the web server (www-data) can't either"           sh -c "cd / && runuser -u www-data -- curl -sf --max-time 5 --unix-socket /run/pammy-gate-php.sock http://pammy.org/_pammy/api/"
ppid_=$(systemctl show -p MainPID --value pammy-php)
if [[ $ppid_ =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$ppid_" | tr -d ' ') == "$(id -u "$PHPU")" ]] && ok "runs as $PHPU, never root" || bad "pammy-php runs as uid $(ps -o uid= -p "$ppid_")"
    t_ok "inside its sandbox: can read the website"          nsenter -t "$ppid_" -m -- test -r /pamela/public
    t_no "inside its sandbox: can't write the website"       nsenter -t "$ppid_" -m -- sh -c 'touch /pamela/public/.pammy-probe && rm -f /pamela/public/.pammy-probe'
    t_no "inside its sandbox: of /pamela only public/ is there" sh -c "nsenter -t $ppid_ -m -- ls -A /pamela | grep -vx public | grep -q ."
    t_no "inside its sandbox: can't write /etc"              nsenter -t "$ppid_" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
    t_ok "inside its sandbox: /tmp is its own, not the server's" test "$(nsenter -t "$ppid_" -m -- stat -c %i /tmp)" != "$(stat -c %i /tmp)"
    t_ok "inside its sandbox: the panel's secrets blocked"   test "$(nsenter -t "$ppid_" -m -- stat -c %a /etc/pammy-panel)" = 0
    # /var/lib is an empty read-only one of its own, with only the tutorial examples in it
    t_no "inside its sandbox: the panel's databases aren't there" nsenter -t "$ppid_" -m -- test -e /var/lib/svc-pammypanel
    t_no "inside its sandbox: nor the gate's, nor the database containers'" sh -c "nsenter -t $ppid_ -m -- test -e /var/lib/svc-pammygate || nsenter -t $ppid_ -m -- test -e /var/lib/svc-pammypanel-db"
    t_ok "inside its sandbox: TLS keys blocked"              test "$(nsenter -t "$ppid_" -m -- stat -c %a /etc/letsencrypt)" = 0
    t_ok "inside its sandbox: the server's Postgres socket blocked" test "$(nsenter -t "$ppid_" -m -- stat -c %a /run/postgresql)" = 0
    t_no "inside its sandbox: homes are hidden"              sh -c "nsenter -t $ppid_ -m -- ls -A /home | grep -q ."
    t_no "inside its sandbox: no network but loopback"       sh -c "nsenter -t $ppid_ -n -- ip -o link | grep -v ' lo:' | grep -q ."
else
    bad "pammy-php not running"
fi
pprops=$(systemctl show pammy-php -p NoNewPrivileges -p PrivateNetwork -p CapabilityBoundingSet -p MemoryDenyWriteExecute -p MemoryMax)
grep -qx 'NoNewPrivileges=yes' <<<"$pprops"        && ok "PHP can't gain privileges (NoNewPrivileges)" || bad "pammy-php NoNewPrivileges not set"
grep -qx 'CapabilityBoundingSet=' <<<"$pprops"     && ok "PHP has no Linux capabilities" || bad "pammy-php has capabilities"
grep -qx 'PrivateNetwork=yes' <<<"$pprops"         && ok "PHP has no network" || bad "pammy-php PrivateNetwork not set"
grep -qx 'MemoryDenyWriteExecute=yes' <<<"$pprops" && ok "PHP can't make memory it can run" || bad "pammy-php MemoryDenyWriteExecute not set"
grep -qx "MemoryMax=$((512 * 1024 * 1024))" <<<"$pprops" && ok "PHP memory capped at 512 MB" || bad "pammy-php MemoryMax: $(grep MemoryMax <<<"$pprops")"
score=$(systemd-analyze security pammy-php --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "PHP exposure rating: ${score#→ }"
# a real .php page, through Cloudflare, on both addresses
PSITE=zz-php-verify-$$
pjar=$(mktemp -d)
if call "$SVC" "{\"op\":\"create\",\"name\":\"$PSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
    runuser -u pamela -- sh -c "printf '%s\n' '<?php // PHP-SOURCE-$$' 'header(\"Content-Type: text/plain\");' 'echo \"RAN-\" . (40 + 2) . \"\n\";' 'echo \"user=[\" . (\$_SERVER[\"PAMMY_USER\"] ?? \"\") . \"]\n\";' 'echo \"exec=\" . (function_exists(\"exec\") ? \"yes\" : \"no\") . \"\n\";' 'echo \"passwd=\" . (@file_get_contents(\"/etc/passwd\") === false ? \"no\" : \"yes\") . \"\n\";' > /pamela/public/$PSITE/v.php; echo '<?php // PHP-SOURCE-$$' > /pamela/public/$PSITE/old.PHP"
    for url in "https://pammy.org/$PSITE/v.php" "https://$PSITE.pammy.org/v.php"; do
        code=$(curl -s --max-time 15 -o "$pjar/body" -w '%{http_code}' "$url")
        [[ $code == 200 ]] && grep -qx 'RAN-42' "$pjar/body" && ! grep -q "PHP-SOURCE-$$" "$pjar/body" && ok "$url runs, its code isn't sent" || bad "$url -> $code $(head -c 200 "$pjar/body")"
    done
    grep -qx 'user=\[\]' "$pjar/body" && grep -qx 'exec=no' "$pjar/body" && grep -qx 'passwd=no' "$pjar/body" \
        && ok "no one signed in there; no programs; nothing outside her website" || bad "PHP page said: $(tr '\n' ' ' < "$pjar/body")"
    code=$(curl -s --max-time 15 -o "$pjar/body" -w '%{http_code}' -H 'X-Pammy-User: mallory' "https://pammy.org/$PSITE/v.php")
    grep -qx 'user=\[\]' "$pjar/body" && ok "a visitor can't claim to be someone with a header" || bad "forged X-Pammy-User -> $(grep user= "$pjar/body")"
    code=$(curl -s --max-time 15 -o "$pjar/body" -w '%{http_code}' "https://pammy.org/$PSITE/old.PHP")
    [[ $code == 404 ]] && ! grep -q "PHP-SOURCE-$$" "$pjar/body" && ok "old.PHP -> 404, never as text" || bad "old.PHP -> $code"
else
    bad "couldn't make $PSITE for the PHP checks"
fi
rm -rf "/pamela/public/$PSITE" "$pjar"

echo "--- the tutorial examples on panel.pammy.org (docs/tutorial-examples-plan.md)"
TEX=/var/lib/pammy-tutorial-examples
t_ok "their folder is svc-pammypanel:$PHPU 2750"          test "$(stat -c '%U:%G %a' "$TEX")" = "svc-pammypanel:$PHPU 2750"
t_ok "PHP's second pool is svc-pammyphp:www-data 660"    test "$(stat -c '%U:%G %a' /run/pammy-php/examples.sock)" = "$PHPU:www-data 660"
if [[ ${ppid_:-} =~ ^[1-9][0-9]*$ ]]; then
    t_no "inside PHP's sandbox: of /var/lib only the examples" sh -c "nsenter -t $ppid_ -m -- ls -A /var/lib | grep -vx pammy-tutorial-examples | grep -q ."
    t_no "inside PHP's sandbox: can't write the examples"    nsenter -t "$ppid_" -m -- sh -c "touch $TEX/.pammy-probe && rm -f $TEX/.pammy-probe"
fi
if [[ -f $TEX/todo-php/settings.php ]]; then
    t_ok "set up: the examples' key file is 640, PHP's group"   test "$(stat -c '%G %a' "$TEX/todo-php/settings.php")" = "$PHPU 640"
    t_no "the web server can't read the examples' key"          runuser -u www-data -- cat "$TEX/todo-php/settings.php"
    t_no "pamela can't read the examples' key"                  runuser -u pamela -- cat "$TEX/todo-php/settings.php"
else
    note "the tutorial examples aren't set up yet (Databases, then Tutorial examples, in the panel)"
fi
tjar=$(mktemp -d)
for u in /tutorial-examples/journal/ /tutorial-examples/todo-php/ /tutorial-examples/journal-php/post.php /_pammy/api/data/postgres/example_todo/tasks /_pammy/api/data/postgres/example_journal/posts /_pammy/me /_pammy/comments.js '/_pammy/comments/example-journal-comments?page=/&content=1'; do
    code=$(curl -s --max-time 15 -o "$tjar/body" -w '%{http_code}' "https://panel.pammy.org$u")
    [[ $code == 401 ]] && ! grep -q '<?php\|pammy_' "$tjar/body" && ok "not signed in to the panel: $u -> 401" || bad "$u without signing in -> $code"
done
for u in /tutorial-examples/todo-php/settings.PHP /tutorial-examples/journal/x.php /tutorial-examples/todo-php/sub/x.php; do
    code=$(curl -s --max-time 15 -o "$tjar/body" -w '%{http_code}' "https://panel.pammy.org$u")
    [[ $code == 404 ]] && ! grep -q '<?php' "$tjar/body" && ok "$u -> 404, never run or sent" || bad "$u -> $code"
done
t_no "and none of it is on pammy.org"                   sh -c "curl -s --max-time 15 https://pammy.org/tutorial-examples/journal/ | grep -q 'journal.js'"
rm -rf "$tjar"

echo "--- a real protected folder, through Cloudflare"
GSITE=zz-gate-verify-$$
GUSER=zz-verify-$$
GPASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=\n')
jar=$(mktemp -d)
gcleanup() {
    [[ -n ${garea:-} ]] && gcall "$SVC" "{\"op\":\"area.delete\",\"id\":$garea,\"actor\":\"verify\"}" >/dev/null 2>&1
    [[ -n ${gvisitor:-} ]] && gcall "$SVC" "{\"op\":\"visitor.delete\",\"id\":$gvisitor,\"actor\":\"verify\"}" >/dev/null 2>&1
    for rid in ${greqs:-}; do gcall "$SVC" "{\"op\":\"request.delete\",\"id\":$rid,\"actor\":\"verify\"}" >/dev/null 2>&1; done
    rm -rf "/pamela/public/$GSITE" "$jar"
}
if call "$SVC" "{\"op\":\"create\",\"name\":\"$GSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
    runuser -u pamela -- sh -c "echo SECRET-$$ > /pamela/public/$GSITE/secret.txt"
    out=$(gcall "$SVC" "{\"op\":\"area.create\",\"path\":\"$GSITE\",\"actor\":\"verify\"}" 2>/dev/null)
    garea=$(grep -o '"id": [0-9]*' <<<"$out" | grep -o '[0-9]*'); gtoken=$(grep -o '"token": "[^"]*"' <<<"$out" | cut -d'"' -f4)
    call "$SVC" "{\"op\":\"protect\",\"path\":\"$GSITE\",\"token\":\"$gtoken\",\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "protected $GSITE (marker + starter sign-in pages, as pamela)" || bad "couldn't protect $GSITE"
    out=$(gcall "$SVC" "{\"op\":\"visitor.create\",\"username\":\"$GUSER\",\"password\":\"$GPASS\",\"actor\":\"verify\"}" 2>/dev/null)
    gvisitor=$(grep -o '"id": [0-9]*' <<<"$out" | grep -o '[0-9]*')
    gcall "$SVC" "{\"op\":\"grant\",\"visitorId\":$gvisitor,\"areaId\":$garea,\"allow\":true,\"actor\":\"verify\"}" >/dev/null 2>&1

    for url in "https://pammy.org/$GSITE/secret.txt" "https://$GSITE.pammy.org/secret.txt" "https://pammy.org/$GSITE/" "https://pammy.org/$GSITE/nope.html"; do
        res=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code} %{redirect_url}' "$url")
        if [[ $res == "302 "*"/login.html?next="* ]] && ! grep -q "SECRET-$$" "$jar/body"; then ok "$url -> sign-in page, nothing leaked"
        else bad "$url -> $res"; fi
    done
    grep -qi '^cache-control: private, no-store' "$jar/h" && ok "sign-in redirects are private, no-store" || bad "redirect missing Cache-Control"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/$GSITE/login.html")
    [[ $code == 200 ]] && grep -q '<pammy-login' "$jar/body" && ok "its login.html is reachable before signing in" || bad "login.html -> $code"
    for pg in login-forgot:pammy-forgot login-invite:pammy-invite login-request:pammy-request logout:pammy-signed-out; do
        code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/$GSITE/${pg%%:*}.html")
        [[ $code == 200 ]] && grep -q "<${pg#*:}" "$jar/body" && ok "its starter ${pg%%:*}.html is reachable too" || bad "${pg%%:*}.html -> $code"
    done
    t_ok "its starter login-files/style.css is pamela's, 644, and the pages use it" \
         sh -c "test \"\$(stat -c '%U %a' /pamela/public/$GSITE/login-files/style.css)\" = 'pamela 644' && grep -q 'href=\"login-files/style.css\"' /pamela/public/$GSITE/logout.html"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/$GSITE/login-files/style.css")
    [[ $code == 200 ]] && grep -q 'The look of the sign-in pages' "$jar/body" && ok "and the stylesheet is reachable before signing in" || bad "login-files/style.css -> $code"
    curl -s --max-time 15 -o "$jar/body" -D "$jar/h" "https://pammy.org/_pammy/login.js"
    grep -qi '^cache-control: no-store' "$jar/h" && ! grep -qi '^cf-cache-status: HIT' "$jar/h" && grep -q 'pammy-welcome' "$jar/body" \
        && ok "login.js through Cloudflare: current version, not cached (so updates reach visitors at once)" \
        || bad "login.js cached: $(grep -i '^cache-control\|^cf-cache-status' "$jar/h" | tr -d '\r' | tr '\n' ' ')"
    src=$(curl -s --max-time 15 "https://pammy.org/_pammy/welcome?area=$gtoken" | grep -o 'src="/_pammy/login.js?v=[0-9a-f]*"' | cut -d'"' -f2)
    [[ -n $src ]] && curl -s --max-time 15 "https://pammy.org$src" | grep -qE 'customElements\.define\(.pammy-welcome.' \
        && ok "built-in pages load the current script by a versioned address ($src)" || bad "built-in page script: ${src:-no versioned src}"
    curl -s --max-time 15 -o "$jar/body" -D "$jar/h" "https://pammy.org/_pammy/examples/evening/logout.html"
    grep -q '<pammy-signed-out' "$jar/body" && grep -qi '^content-security-policy: .*frame-ancestors https://panel.pammy.org;' "$jar/h" \
        && ok "example looks through Cloudflare, framable only by the panel (Help previews)" || bad "example look: $(head -1 "$jar/h" | tr -d '\r')"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/_pammy/about?page=/$GSITE/login.html")
    [[ $code == 200 ]] && grep -q "\"request\":\"/$GSITE/login-request.html\"" "$jar/body" && ok "the components can find the folder's other pages" || bad "about -> $code"
    code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' -H 'Content-Type: application/json' -H 'Origin: https://pammy.org' \
        --data "{\"username\":\"$GUSER\",\"password\":\"$GPASS\",\"page\":\"/$GSITE/login.html\"}" https://pammy.org/_pammy/login)
    gcookie=$(grep -i '^set-cookie: __Host-pammy_visitor=' "$jar/h" | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r')
    [[ $code == 200 && -n $gcookie ]] && ok "signed in through Cloudflare" || bad "sign-in -> $code"
    for n in 1 2; do
        code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' -H "Cookie: $gcookie" "https://pammy.org/$GSITE/secret.txt")
        cf=$(grep -i '^cf-cache-status:' "$jar/h" | cut -d' ' -f2 | tr -d '\r')
        [[ $code == 200 ]] && grep -q "SECRET-$$" "$jar/body" && grep -qi '^cache-control: private, no-store' "$jar/h" && [[ $cf != HIT ]] \
            && ok "signed in: file served, private, no-store, not from Cloudflare's cache (request $n: ${cf:-no cf-cache-status})" \
            || bad "signed-in request $n -> $code cf=$cf"
    done
    runuser -u pamela -- mkdir "/pamela/public/$GSITE/nohome"
    res=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' -H "Cookie: $gcookie" "https://pammy.org/$GSITE/nohome/")
    [[ $res == "302 "*"/_pammy/welcome?area=$gtoken&path=%2F$GSITE%2Fnohome%2F" ]] && ok "signed in, a folder with no index.html -> welcome page, not 403" || bad "no-index folder -> $res"
    # a PHP page in there (docs/tutorials-plan.md P1, P4): sign-in first, then told who
    runuser -u pamela -- sh -c "printf '%s\n' '<?php // PHP-SOURCE-$$' 'echo \"user=[\" . (\$_SERVER[\"PAMMY_USER\"] ?? \"\") . \"]\";' 'echo \"\\nrole=[\" . (\$_SERVER[\"PAMMY_ROLE\"] ?? \"\") . \"]\\nprivileges=[\" . (\$_SERVER[\"PAMMY_PRIVILEGES\"] ?? \"\") . \"]\";' > /pamela/public/$GSITE/who.php"
    res=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code} %{redirect_url}' "https://pammy.org/$GSITE/who.php")
    [[ $res == "302 "*"/login.html?next="* ]] && ! grep -q "PHP-SOURCE-$$\|user=" "$jar/body" && ok "a PHP page in it needs sign-in first" || bad "protected who.php -> $res"
    code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' -H "Cookie: $gcookie" -H 'X-Pammy-User: mallory' "https://pammy.org/$GSITE/who.php")
    [[ $code == 200 ]] && grep -qx "user=\[$GUSER\]" "$jar/body" && grep -qi '^cache-control: private, no-store' "$jar/h" \
        && ok "signed in: it runs, knows who (PAMMY_USER, not the header sent), private" || bad "signed-in who.php -> $code $(head -c 200 "$jar/body")"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $gcookie" -H 'X-Pammy-Role: Admin' -H 'X-Pammy-Privileges: everything.any' "https://pammy.org/$GSITE/who.php")
    [[ $code == 200 ]] && grep -qx 'role=\[Member\]' "$jar/body" && grep -qx 'privileges=\[pages.read\]' "$jar/body" \
        && ok "...and their role and privileges there (PAMMY_ROLE, PAMMY_PRIVILEGES), not the headers sent" || bad "who.php role -> $code $(head -c 200 "$jar/body")"
    res=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/$GSITE/secret.txt")
    [[ $res == 302 ]] && ! grep -q "SECRET-$$" "$jar/body" && ok "straight after, without the cookie: sign-in again (Cloudflare kept no copy)" || bad "after sign-in, no cookie -> $res"
    lip=$(pg "SELECT coalesce(ip, 'none') FROM gate.events WHERE event = 'login' AND username = '$GUSER' ORDER BY id DESC LIMIT 1" 2>/dev/null)
    lip=${lip:-none}
    if python3 -c "import ipaddress,sys; ip=ipaddress.ip_address(sys.argv[1]); cf=[ipaddress.ip_network(l.strip()) for l in open(sys.argv[2]) if l.strip() and not l.startswith('#')]; sys.exit(1 if ip.is_loopback or any(ip in n for n in cf) else 0)" "$lip" "$D/cloudflare-ips.txt" 2>/dev/null; then
        ok "the gate logged the visitor's real IP ($lip), not Cloudflare's"
    else bad "the gate logged sign-in IP: ${lip:-none}"; fi
    # the public forms: both land in the panel's Requests list, then are removed again
    jpost() {  # jpost <path> <json> -> status
        curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' -H 'Content-Type: application/json' -H 'Origin: https://pammy.org' --data "$2" "https://pammy.org$1"
    }
    c1=$(jpost /_pammy/request "{\"name\":\"zz verify\",\"contact\":\"verify-$$\",\"page\":\"/$GSITE/login-request.html\"}")
    c2=$(jpost /_pammy/forgot "{\"username\":\"$GUSER\",\"page\":\"/$GSITE/login-forgot.html\"}")
    greqs=$(gcall "$SVC" '{"op":"state","actor":"verify"}' 2>/dev/null | python3 -c '
import json, sys
st = json.load(sys.stdin); area, visitor, contact = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
print(" ".join(str(r["id"]) for r in st["requests"] if r["status"] == "open" and r["areaId"] == area
      and ((r["kind"] == "access" and r["contact"] == contact) or (r["kind"] == "reset" and r["visitorId"] == visitor))))' "$garea" "$gvisitor" "verify-$$" 2>/dev/null)
    [[ $c1 == 200 && $c2 == 200 && $(wc -w <<<"$greqs") == 2 ]] && ok "ask-for-access and forgot-password through Cloudflare reach the Requests list" || bad "request=$c1 forgot=$c2 recorded: ${greqs:-none}"

    # a real setup link, used through Cloudflare
    url=$(gcall "$SVC" "{\"op\":\"link.create\",\"visitorId\":$gvisitor,\"areaId\":$garea,\"actor\":\"verify\"}" 2>/dev/null | grep -o '"url": "[^"]*"' | cut -d'"' -f4)
    ltok=${url#*#}
    [[ $url == "https://pammy.org/$GSITE/login-invite.html#"* && ${#ltok} == 43 ]] && ok "setup link points at the folder's own login-invite.html" || bad "setup link: ${url:-none}"
    code=$(jpost /_pammy/invite/check "{\"token\":\"$ltok\"}")
    [[ $code == 200 ]] && grep -q "\"username\":\"$GUSER\"" "$jar/body" && ok "the link shows their username" || bad "link check -> $code"
    code=$(jpost /_pammy/invite "{\"token\":\"$ltok\",\"password\":\"$GPASS-new\"}")
    lcookie=$(grep -i '^set-cookie: __Host-pammy_visitor=' "$jar/h" | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r')
    [[ $code == 200 && -n $lcookie ]] && ok "choosing a password with it signs them in" || bad "using the link -> $code"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $lcookie" "https://pammy.org/$GSITE/secret.txt")
    [[ $code == 200 ]] && grep -q "SECRET-$$" "$jar/body" && ok "and the folder opens with the new sign-in" || bad "after the link -> $code"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $gcookie" "https://pammy.org/$GSITE/secret.txt")
    [[ $code == 302 ]] && ! grep -q "SECRET-$$" "$jar/body" && ok "their earlier sign-in ended when the new password was chosen" || bad "old session after link -> $code"
    code=$(jpost /_pammy/invite "{\"token\":\"$ltok\",\"password\":\"$GPASS-again\"}")
    [[ $code == 410 ]] && ok "the link works only once" || bad "link reused -> $code"
    gcookie=$lcookie

    # signing out from a page in the folder (what <pammy-logout> does): on to its logout.html, and locked again
    code=$(jpost /_pammy/login "{\"username\":\"$GUSER\",\"password\":\"$GPASS-new\",\"page\":\"/$GSITE/login.html\"}")
    ocookie=$(grep -i '^set-cookie: __Host-pammy_visitor=' "$jar/h" | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r')
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $ocookie" -H 'Content-Type: application/json' -H 'Origin: https://pammy.org' \
        --data "{\"page\":\"/$GSITE/secret.txt\"}" https://pammy.org/_pammy/logout)
    [[ -n $ocookie && $code == 200 ]] && grep -q "\"next\":\"/$GSITE/logout.html\"" "$jar/body" && ok "signing out goes on to the folder's logout.html" || bad "sign-out -> $code $(cat "$jar/body")"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $ocookie" "https://pammy.org/$GSITE/secret.txt")
    [[ $code == 302 ]] && ! grep -q "SECRET-$$" "$jar/body" && ok "signed out: locked again" || bad "after signing out -> $code"

    gcall "$SVC" "{\"op\":\"visitor.active\",\"id\":$gvisitor,\"active\":false,\"actor\":\"verify\"}" >/dev/null 2>&1
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H "Cookie: $gcookie" "https://pammy.org/$GSITE/secret.txt")
    [[ $code == 302 ]] && ! grep -q "SECRET-$$" "$jar/body" && ok "switched off: locked out on the very next request" || bad "switched off -> $code"
else
    bad "couldn't create a test folder for the gate check"
fi
gcleanup

echo "--- a real form on a page, and the API, through Cloudflare"
CSITE=zz-form-verify-$$
jar=$(mktemp -d)
ccleanup() {
    [[ -n ${ckey:-} ]] && gcall "$SVC" "{\"op\":\"apikey.revoke\",\"id\":$ckey,\"actor\":\"verify\"}" >/dev/null 2>&1
    # the test form and its response, straight from the gate's tables (there is
    # no "delete for good" in the panel on purpose)
    pg "DELETE FROM gate.response_values WHERE form_id IN (SELECT id FROM gate.forms WHERE name = 'zz-verify-$$');
        DELETE FROM gate.responses WHERE form_id IN (SELECT id FROM gate.forms WHERE name = 'zz-verify-$$');
        DELETE FROM gate.form_pages WHERE form_id IN (SELECT id FROM gate.forms WHERE name = 'zz-verify-$$');
        DELETE FROM gate.api_keys WHERE label = 'verify zz-verify-$$';
        DELETE FROM gate.forms WHERE name = 'zz-verify-$$'" >/dev/null 2>&1
    rm -rf "/pamela/public/$CSITE" "$jar"
}
want=$(grep -cvE '^\s*(#|$)' "$D/../../guides.map")
t_ok "the Help tab's guides are installed ($want)"      test "$(find "$APP/help" -maxdepth 1 -name '*.txt' | wc -l)" = "$want"
if call "$SVC" "{\"op\":\"create\",\"name\":\"$CSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
    # her page, with the two lines she would paste in
    printf '%s\n' '<!doctype html><meta charset="utf-8"><title>Ask</title>' \
        '<script src="/_pammy/forms.js" defer></script>' "<pammy-form name=\"zz-verify-$$\"></pammy-form>" > "$jar/ask.html"
    install -o pamela -g www-data -m 644 "$jar/ask.html" "/pamela/public/$CSITE/ask.html"
    out=$(gcall "$SVC" "{\"op\":\"form.create\",\"name\":\"zz-verify-$$\",\"title\":\"Verify\",\"items\":[{\"type\":\"short-text\",\"label\":\"Name\",\"required\":true},{\"type\":\"email\",\"label\":\"Email\"}],\"actor\":\"verify\"}" 2>/dev/null)
    cform=$(grep -o '"id": [0-9]*' <<<"$out" | head -1 | grep -o '[0-9]*')
    [[ -n ${cform:-} ]] && ok "made a test form" || bad "couldn't make a test form: $out"
    gcall "$SVC" "{\"op\":\"form.switches\",\"id\":${cform:-0},\"approvable\":true,\"actor\":\"verify\"}" >/dev/null 2>&1
    curl -s --max-time 15 -o "$jar/body" -D "$jar/h" "https://$CSITE.pammy.org/_pammy/forms.js"
    grep -qi '^cache-control: no-store' "$jar/h" && grep -qE 'customElements\.define\(.pammy-form.' "$jar/body" && ok "forms.js through Cloudflare, not cached" || bad "forms.js: $(grep -i '^cache-control\|^cf-cache-status' "$jar/h" | tr -d '\r' | tr '\n' ' ')"
    # comments (docs/comments-plan.md): the component, never cached
    curl -s --max-time 15 -o "$jar/body" -D "$jar/h" "https://$CSITE.pammy.org/_pammy/comments.js"
    grep -qi '^cache-control: no-store' "$jar/h" && grep -qE 'customElements\.define\(.pammy-comments.' "$jar/body" && ok "comments.js through Cloudflare, not cached" || bad "comments.js: $(grep -i '^cache-control\|^cf-cache-status' "$jar/h" | tr -d '\r' | tr '\n' ' ')"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://$CSITE.pammy.org/_pammy/forms/zz-verify-$$?page=%2Fask.html")
    [[ $code == 200 ]] && grep -q '"label":"Email"' "$jar/body" && ok "the form's questions, at its subdomain address" || bad "form definition -> $code"
    # a form that belongs to one folder (docs/media-plan.md D22) works only on that folder's pages
    gcall "$SVC" "{\"op\":\"form.scope\",\"id\":${cform:-0},\"formScope\":\"/$CSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/forms/zz-verify-$$?page=%2F$CSITE%2Fask.html")
    code2=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/forms/zz-verify-$$?page=%2F")
    [[ $code == 200 && $code2 == 404 ]] && ok "kept to its folder: works on $CSITE's page, not on the main site's" || bad "folder-only form: in folder $code, elsewhere $code2"
    other=$(gcall "$SVC" "{\"op\":\"forms.state\",\"places\":[\"/zz-nothing-$$\"],\"actor\":\"verify\"}" 2>/dev/null)
    ! grep -q "zz-verify-$$" <<<"$other" && ok "an account kept to another folder doesn't see it" || bad "forms.state for another folder shows it"
    t_no "an account kept to a folder can't reach protected folders or people" gcall "$SVC" "{\"op\":\"state\",\"places\":[\"/$CSITE\"],\"actor\":\"verify\"}"
    # the one folder sent before places is refused, never read as the whole site (permissions step 3)
    t_no "the gate refuses the old scope, rather than answering for the whole site" gcall "$SVC" "{\"op\":\"forms.state\",\"scope\":\"/$CSITE\",\"actor\":\"verify\"}"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' -H 'Content-Type: application/json' -H 'Origin: https://pammy.org' \
        --data "{\"page\":\"/$CSITE/ask.html\",\"answers\":{\"name\":\"verify $$\",\"email\":\"verify@example.com\"}}" "https://pammy.org/_pammy/forms/zz-verify-$$")
    [[ $code == 200 ]] && ok "a response sent through Cloudflare" || bad "form post -> $code $(cat "$jar/body")"
    got=$(gcall "$SVC" "{\"op\":\"responses.list\",\"formId\":${cform:-0},\"actor\":\"verify\"}" 2>/dev/null)
    grep -q "verify $$" <<<"$got" && ok "it's waiting in Responses" || bad "response not found in the gate"
    rid=$(grep -o '"id": [0-9]*' <<<"$got" | head -1 | grep -o '[0-9]*')
    gcall "$SVC" "{\"op\":\"response.approve\",\"id\":${rid:-0},\"approved\":true,\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "approved it" || bad "couldn't approve the response"
    # the API: with a key, then (once switched on) without one
    keyout=$(gcall "$SVC" "{\"op\":\"apikey.create\",\"label\":\"verify zz-verify-$$\",\"level\":\"all\",\"forms\":[${cform:-0}],\"actor\":\"verify\"}" 2>/dev/null)
    ktoken=$(grep -o '"key": "[^"]*"' <<<"$keyout" | cut -d'"' -f4)
    ckey=$(grep -o '"id": [0-9]*' <<<"$keyout" | head -1 | grep -o '[0-9]*')
    code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' -H "Authorization: Bearer $ktoken" "https://pammy.org/_pammy/api/forms/${cform:-0}/all")
    [[ $code == 200 ]] && grep -q "verify $$" "$jar/body" && grep -qi '^cache-control: private, no-store' "$jar/h" \
        && ok "the API gives the response to its key, never cached" || bad "api with key -> $code $(head -c 200 "$jar/body")"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/forms/${cform:-0}/all")
    [[ $code == 401 ]] && ok "and nothing at all without a key" || bad "api without key -> $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/forms/${cform:-0}/all?key=$ktoken")
    [[ $code == 400 ]] && ok "a key in the address is refused" || bad "api key in address -> $code"
    gcall "$SVC" "{\"op\":\"form.switches\",\"id\":${cform:-0},\"publicApproved\":true,\"actor\":\"verify\"}" >/dev/null 2>&1
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/_pammy/api/forms/${cform:-0}/approved?order=desc")
    [[ $code == 200 ]] && grep -q "verify $$" "$jar/body" && ! grep -q 'verify@example.com' "$jar/body" \
        && ok "anyone can read the approved ones once she says so, without the private answers" || bad "public approved -> $code $(head -c 200 "$jar/body")"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ktoken" "https://pammy.org/_pammy/api/forms/${cform:-0}/all/filterby/name/$(printf 'verify%%20%s' "$$")")
    [[ $code == 200 ]] && ok "filtering by an answer works" || bad "api filterby -> $code"
    # "show right away": a new response is on the public list at once, and the
    # switch back takes down what nobody has opened
    gcall "$SVC" "{\"op\":\"form.switches\",\"id\":${cform:-0},\"autoApprove\":true,\"actor\":\"verify\"}" >/dev/null 2>&1
    curl -s --max-time 15 -o /dev/null -H 'Content-Type: application/json' -H 'Origin: https://pammy.org' \
        --data "{\"page\":\"/$CSITE/ask.html\",\"answers\":{\"name\":\"quick $$\"}}" "https://pammy.org/_pammy/forms/zz-verify-$$"
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/_pammy/api/forms/${cform:-0}/approved?order=desc")
    [[ $code == 200 ]] && grep -q "quick $$" "$jar/body" && ok "show right away: a new response is public at once" || bad "auto-approve -> $code $(head -c 200 "$jar/body")"
    back=$(gcall "$SVC" "{\"op\":\"form.switches\",\"id\":${cform:-0},\"autoApprove\":false,\"actor\":\"verify\"}" 2>/dev/null)
    hid=$(gcall "$SVC" "{\"op\":\"form.hide-unreviewed\",\"id\":${cform:-0},\"actor\":\"verify\"}" 2>/dev/null)
    curl -s --max-time 15 -o "$jar/body" "https://pammy.org/_pammy/api/forms/${cform:-0}/approved?order=desc"
    grep -q '"unreviewedAuto": 1' <<<"$back" && grep -q '"hidden": 1' <<<"$hid" && ! grep -q "quick $$" "$jar/body" && grep -q "verify $$" "$jar/body" \
        && ok "switching back hides only what went up unseen" || bad "hide-unreviewed: $back $hid"
    gcall "$SVC" "{\"op\":\"apikey.revoke\",\"id\":${ckey:-0},\"actor\":\"verify\"}" >/dev/null 2>&1
    ckey=
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ktoken" "https://pammy.org/_pammy/api/forms/${cform:-0}/all")
    [[ $code == 401 ]] && ok "a revoked key stops working at once" || bad "revoked key -> $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/form-preview")
    [[ $code == 200 ]] && ok "the panel's preview page" || bad "form-preview -> $code"

    # the three worked examples (docs/examples-plan.md): each page, its two files,
    # and its own approved entries, all through Cloudflare
    for kind in guestbook rsvp pinboard; do
        code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' "https://pammy.org/_pammy/examples/$kind/")
        [[ $code == 200 ]] && grep -q '<pammy-form name="example-' "$jar/body" && ! grep -q '@FORM@' "$jar/body" \
            && grep -qi '^x-robots-tag: noindex' "$jar/h" \
            && ok "the $kind example page, never indexed" || bad "example $kind -> $code $(grep -i '^x-robots-tag' "$jar/h" | tr -d '\r')"
        for file in style.css entries.js; do
            code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/examples/$kind/$file")
            [[ $code == 200 ]] && ok "the $kind example's $file" || bad "example $kind/$file -> $code"
        done
        code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/examples/$kind")
        [[ $code == 301 ]] && ok "the $kind example without its slash redirects (so its files are found)" || bad "example $kind no slash -> $code"
    done
    code=$(curl -s --max-time 15 -o "$jar/body" -w '%{http_code}' "https://pammy.org/_pammy/api/forms/by-name/example-guest-book/approved")
    [[ $code == 200 ]] && grep -q '"your-name"' "$jar/body" && ! grep -q '"email"' "$jar/body" \
        && ok "a form can be asked for by name, private answers still held back" || bad "by-name api -> $code $(head -c 200 "$jar/body")"
    # the database examples' public pages (docs/db-examples-plan.md): served,
    # pointed at the example databases, never indexed, and the pictures there
    for pair in recipes:postgres/example_recipes blog:mariadb/example_blog; do
        kind=${pair%%:*}; api=${pair#*:}
        code=$(curl -s --max-time 15 -o "$jar/body" -D "$jar/h" -w '%{http_code}' "https://pammy.org/_pammy/examples/$kind/")
        [[ $code == 200 ]] && grep -q "data-api=\"/_pammy/api/data/$api\"" "$jar/body" && ! grep -q '@API@\|@FILES@\|@TITLE@' "$jar/body" \
            && grep -qi '^x-robots-tag: noindex' "$jar/h" \
            && ok "the $kind database example page, never indexed" || bad "database example $kind -> $code"
        code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/examples/$kind/$kind.js")
        [[ $code == 200 ]] && ok "the $kind database example's program" || bad "database example $kind/$kind.js -> $code"
        # without a key, it answers only if its example is set up (and then
        # only the tables anyone may read) -- never an error page
        code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/data/$api/${kind/blog/posts}")
        [[ $code == 200 || $code == 404 ]] && ok "the $kind example's data without a key: $code (200 once it is set up)" || bad "keyless $kind data -> $code"
    done
    code=$(curl -s --max-time 15 -o /dev/null -D "$jar/h" -w '%{http_code}' "https://pammy.org/_pammy/examples/recipes/pictures/pancakes.jpg")
    [[ $code == 200 ]] && grep -qi '^content-type: image/jpeg' "$jar/h" && ok "the recipe book's pictures" || bad "recipe picture -> $code"
    exstate=$(gcall "$SVC" '{"op":"examples.state"}' 2>/dev/null)
    [[ $(printf '%s' "$exstate" | grep -o '"kind"' | wc -l) == 3 ]] && ok "all three examples are in the database" || bad "examples.state: $(head -c 200 <<<"$exstate")"
else
    bad "couldn't make a test folder for the form check"
fi
ccleanup

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "--- a real media folder, through Cloudflare"
MSITE=zz-media-verify-$$
mcleanup() {
    rm -rf "/pamela/public/$MSITE"
    for box in /pamela/trash/.media/*/; do
        [[ -f $box/origin.json ]] && grep -q "\"$MSITE/" "$box/origin.json" && rm -rf "$box"
    done
    for box in /pamela/trash/.versions/*/; do
        [[ -f $box/version.json ]] && grep -q "\"$MSITE/" "$box/version.json" && rm -rf "$box"
    done
}
# a real PNG (1x1), sent through the helper's streaming upload exactly as the panel sends it
mnode() {  # mnode <script> [args...] -- run node as the panel's user with the live client code
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "$@")
}
mdb() {  # mdb <sql> -- the media records; one line per row, columns joined by |
    pg "$1"
}
if call "$SVC" "{\"op\":\"create\",\"name\":\"$MSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1 \
   && call "$SVC" "{\"op\":\"media-create\",\"folder\":\"$MSITE\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
    t_ok "media folder made, pamela's, 2755"            test "$(stat -c '%U %a' "/pamela/public/$MSITE/media/images")" = "pamela 2755"
    up=$(mnode '
      import { uploadToSiteFs } from "/opt/pammy-panel/src/sitefs/client.ts";
      import { Readable } from "node:stream";
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const r = await uploadToSiteFs("/run/pammy-sitefs.sock", { op: "media-upload", dir: process.argv[1] + "/media/images", name: "verify.png", size: png.length, actor: "verify" }, Readable.from([png]));
      console.log(r.path);' "$MSITE" 2>&1)
    [[ $up == "$MSITE/media/images/verify.png" ]] && ok "a streamed upload through the helper (as the panel does it)" || bad "upload through the helper: $up"
    t_ok "uploaded file is pamela's, group www-data, 644" test "$(stat -c '%U:%G %a' "/pamela/public/$MSITE/media/images/verify.png")" = "pamela:www-data 644"
    # ?verify=... on every request: Cloudflare keeps pictures for hours, and a copy it kept
    # would hide what the server itself answers (and linger after the test)
    code=$(curl -s --max-time 15 -o "$tmp/m" -w '%{http_code} %{content_type}' "https://pammy.org/$MSITE/media/images/verify.png?verify=$$-1")
    [[ $code == "200 image/png" ]] && cmp -s "$tmp/m" <(base64 -d <<<"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==") \
        && ok "served through Cloudflare at pammy.org/$MSITE/media/images/verify.png" || bad "public media file: $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://$MSITE.pammy.org/media/images/verify.png?verify=$$-2")
    [[ $code == 200 ]] && ok "and at its subdomain address" || bad "subdomain media file: $code"
    loc=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://pammy.org/$MSITE/media/photos/verify.png?verify=$$-4")
    [[ $loc == "301 https://pammy.org/$MSITE/media/images/verify.png?verify=$$-4" ]] && ok "an old media/photos address goes on to media/images (301)" || bad "photos redirect: $loc"
    loc=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$MSITE.pammy.org/media/photos/verify.png?verify=$$-5")
    [[ $loc == "301 https://$MSITE.pammy.org/media/images/verify.png?verify=$$-5" ]] && ok "and at its subdomain address" || bad "subdomain photos redirect: $loc"
    t_no "a media folder can't be made deeper than one folder down" call "$SVC" "{\"op\":\"media-create\",\"folder\":\"$MSITE/deeper\",\"actor\":\"verify\"}"
    # media records: what a sync finds, including a file made as pamela (WinSCP's way in)
    runuser -u pamela -- sh -c "printf '%%PDF-1.4 verify' > '/pamela/public/$MSITE/media/files/by-pamela.pdf'"
    syncout=$(/usr/local/sbin/pammy-panel media-sync 2>&1)
    recs=$(mdb "SELECT path, how, state, scope FROM files.records WHERE state = 'present' AND starts_with(path, '$MSITE/') ORDER BY path" 2>&1)
    # the whole website is recorded (File Explorer): the folder's starter page too
    [[ $recs == "$MSITE/index.html|found|present|/$MSITE"$'\n'"$MSITE/media/files/by-pamela.pdf|found|present|/$MSITE"$'\n'"$MSITE/media/images/verify.png|found|present|/$MSITE" ]] \
        && ok "a sync records files put in outside the panel (one made as pamela), each in its folder's scope" || bad "media sync: $recs ($syncout)"
    hashed=$(mdb "SELECT hash FROM files.records WHERE path = '$MSITE/media/files/by-pamela.pdf' AND state = 'present'" 2>&1)
    [[ $hashed == "$(printf '%%PDF-1.4 verify' | sha256sum | cut -d' ' -f1)" ]] && ok "and works out its sha256 through the helper" || bad "media hash: $hashed"
    runuser -u pamela -- mv "/pamela/public/$MSITE/media/files/by-pamela.pdf" "/pamela/public/$MSITE/media/files/moved.pdf"
    before_id=$(mdb "SELECT id FROM files.records WHERE path = '$MSITE/media/files/by-pamela.pdf' AND state = 'present'")
    /usr/local/sbin/pammy-panel media-sync >/dev/null 2>&1
    after_id=$(mdb "SELECT id FROM files.records WHERE path = '$MSITE/media/files/moved.pdf' AND state = 'present'")
    [[ -n $before_id && $before_id == "$after_id" ]] && ok "a file renamed outside the panel keeps its record" || bad "media move: ${before_id:-none} -> ${after_id:-none}"
    # thumbnails: made by pammy-thumbs, kept by the panel
    th=$(/usr/local/sbin/pammy-panel media-thumbs --only "$MSITE/media/images/verify.png" 2>&1)
    tfile=$(mdb "SELECT '/var/lib/pammy-media-public/thumbs/' || id || '-' || hash || '.webp' FROM files.records WHERE path = '$MSITE/media/images/verify.png' AND state = 'present'" 2>/dev/null)
    [[ $th == "picture image 1x1" && -f $tfile ]] && ok "a thumbnail made through the sandboxed service ($th)" || bad "thumbnail: $th"
    [[ -f $tfile ]] && t_ok "kept by the panel, readable by the gate only (640)"  test "$(stat -c '%U:%G %a' "$tfile")" = "$SVC:svc-pammygate 640"
    th=$(/usr/local/sbin/pammy-panel media-thumbs --only "$MSITE/media/files/moved.pdf" 2>&1)
    [[ $th == "icon pdf ("* ]] && ok "a file that isn't a real PDF gets the PDF icon, and why" || bad "PDF thumbnail: $th"
    # the media API (docs/media-api-plan.md): a public tag and a private one, through Cloudflare
    # as the panel's user, with the password on fd 3: the way the command line gets it
    labelled=$(pnode '
      import { loadConfig } from "/opt/pammy-panel/src/config.ts";
      import { PROFILE } from "/opt/pammy-panel/src/profile.ts";
      import { REGISTRY } from "/opt/pammy-panel/packages/modules/src/index.ts";
      import { connectPg, one } from "/opt/pammy-panel/src/pg.ts";
      import { changeFileLabels, listLabels, setLabelPublic } from "/opt/pammy-panel/src/media-labels.ts";
      import { publishIndex } from "/opt/pammy-panel/src/media-public.ts";
      const [site] = process.argv.slice(1);
      const c = loadConfig(PROFILE, REGISTRY);
      const db = connectPg({ role: "panel", passwordFile: c.pgPasswordFile, passwordFd: c.pgPasswordFd, host: c.pgHost, port: c.pgPort, database: c.pgDatabase, max: 2, app: "verify" });
      const id = async (p) => (await one(db, "SELECT id FROM records WHERE path = ? AND state = ?", `${site}/media/${p}`, "present")).id;
      const now = Math.floor(Date.now() / 1000);
      await changeFileLabels(db, now, "verify", [await id("images/verify.png")], { add: { tags: ["verify-open"] } });
      await changeFileLabels(db, now, "verify", [await id("files/moved.pdf")], { add: { tags: ["verify-closed"] } });
      const open = (await listLabels(db, `/${site}`)).find((l) => l.name === "verify-open");
      await setLabelPublic(db, "tag", open.id, true);
      console.log(await publishIndex(db, "/var/lib/pammy-media-public", now));
      await db.end({ timeout: 5 });' "$MSITE" 2>&1)
    [[ $labelled =~ ^[0-9]+$ ]] && ok "tags made, one switched on, and the index published ($labelled files; the password arrived on fd 3)" || bad "media API setup: $labelled"
    t_ok "the index is the panel's, readable by the gate's group only (640)" test "$(stat -c '%U:%G %a' /var/lib/pammy-media-public/index.db)" = "$SVC:svc-pammygate 640"
    gpid=$(systemctl show -p MainPID --value pammy-gate)
    [[ $gpid =~ ^[1-9][0-9]*$ ]] && t_ok "the gate can read it, from inside its sandbox" nsenter -t "$gpid" -m -S "$(id -u svc-pammygate)" -G "$(id -g svc-pammygate)" -- test -r /var/lib/pammy-media-public/index.db
    got=$(curl -s --max-time 15 -w '\n%{http_code}' "https://pammy.org/_pammy/api/media/in/$MSITE/t/verify-open?verify=$$")
    code=${got##*$'\n'}; body=${got%$'\n'*}
    [[ $code == 200 && $body == *'"name":"verify.png"'* && $body == *'"total":1'* ]] && ok "the media API lists the file with the public tag, through Cloudflare" || bad "media API: $code $(head -c 200 <<<"$body")"
    tsrc=$(grep -o '"thumb":{"src":"[^"]*"' <<<"$body" | cut -d'"' -f6)
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{content_type}' "https://pammy.org$tsrc")
    [[ -n $tsrc && $code == "200 image/webp" ]] && ok "and its small picture" || bad "media API thumbnail ${tsrc:-none}: $code"
    got=$(curl -s --max-time 15 "https://$MSITE.pammy.org/_pammy/api/media/in/$MSITE/t/verify-open?verify=$$")
    [[ $got == *'"src":"/media/images/verify.png"'* ]] && ok "on the folder's subdomain, addresses from that subdomain" || bad "media API on subdomain: $(head -c 200 <<<"$got")"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/media/in/$MSITE/t/verify-closed?verify=$$")
    [[ $code == 404 ]] && ok "a tag not switched on answers like one that isn't there (404)" || bad "private tag: $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/media/in/$MSITE/all?verify=$$")
    [[ $code == 401 ]] && ok "every file at once needs a key (401)" || bad "/all without a key: $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/_pammy/api/media/example/c/landscapes?verify=$$")
    [[ $code == 200 ]] && ok "the example folder answers (for the Media examples)" || bad "example folder: $code"
    got=$(mnode '
      import { readFromSiteFs } from "/opt/pammy-panel/src/sitefs/client.ts";
      const { header, bytes } = await readFromSiteFs("/run/pammy-sitefs.sock", { op: "media-read", path: process.argv[1] + "/media/images/verify.png", start: 1, end: 3, actor: "verify" });
      let n = 0; for await (const c of bytes) n += c.length;
      console.log(header.size, header.start, header.end, n);' "$MSITE" 2>&1)
    [[ $got == "70 1 3 3" ]] && ok "the helper streams part of a file back (for previews and video)" || bad "read through the helper: $got"
    tid=$(call "$SVC" "{\"op\":\"media-trash\",\"path\":\"$MSITE/media/images/verify.png\",\"actor\":\"verify\"}" 2>/dev/null | grep -o '"id": "[^"]*"' | cut -d'"' -f4)
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://pammy.org/$MSITE/media/images/verify.png?verify=$$-3")
    [[ -n $tid && $code == 404 && -d /pamela/trash/.media/$tid ]] && ok "moved to the trash: gone from the site (404)" || bad "media trash: id=${tid:-none} site=$code"
    t_ok "media trash is pamela's own, 700"             test "$(stat -c '%U %a' /pamela/trash/.media)" = "pamela 700"
    call "$SVC" "{\"op\":\"media-restore\",\"id\":\"$tid\",\"actor\":\"verify\"}" >/dev/null 2>&1 && test -f "/pamela/public/$MSITE/media/images/verify.png" \
        && ok "and restored" || bad "media restore failed"
    t_no "the helper refuses media paths outside a media folder" call "$SVC" "{\"op\":\"media-trash\",\"path\":\"$MSITE/index.html\",\"actor\":\"verify\"}"
    head -c $((2 * 1024 * 1024)) /dev/zero > "$tmp/2mb"
    code=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://panel.pammy.org' -H 'X-Pammy-Name: big.jpg' \
        --data-binary @"$tmp/2mb" "https://panel.pammy.org/api/media/upload?dir=$MSITE/media/images")
    [[ $code == 401 ]] && ok "a 2 MB upload gets through Cloudflare and nginx to the panel (which wants a passkey session)" || bad "2 MB upload through Cloudflare: $code"
    code=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://panel.pammy.org' -H 'X-Pammy-Name: big.html' \
        --data-binary @"$tmp/2mb" "https://panel.pammy.org/api/files/upload?dir=$MSITE")
    [[ $code == 401 ]] && ok "and a 2 MB File Explorer upload too" || bad "2 MB File Explorer upload through Cloudflare: $code"
    # the editor (docs/editor-plan.md): make, save, refuse a stale save, keep and put back a version
    edit=$(mnode '
      import { createHash } from "node:crypto";
      import { Readable } from "node:stream";
      import { callSiteFs, uploadToSiteFs } from "/opt/pammy-panel/src/sitefs/client.ts";
      const S = "/run/pammy-sitefs.sock", path = process.argv[1] + "/verify-edit.html", sha = (t) => createHash("sha256").update(t).digest("hex");
      const write = (req, text) => uploadToSiteFs(S, { op: "files-write", actor: "verify", ...req, path, size: Buffer.byteLength(text) }, Readable.from([Buffer.from(text)]));
      const made = await write({ create: "exact" }, "<p>one</p>");
      const saved = await write({ expect: sha("<p>one</p>"), session: "verify-session" }, "<p>two</p>");
      let stale = "saved";
      try { await write({ expect: sha("<p>one</p>") }, "<p>three</p>"); } catch (e) { stale = e.code; }
      const list = await callSiteFs(S, { op: "files-versions", path, actor: "verify" });
      console.log([made.created, saved.newVersion, stale, list.versions.length, list.versions[0]?.id === saved.version ? "same" : "other", saved.version].join(" "));' "$MSITE" 2>&1)
    vid=${edit##* }
    [[ $edit == "true true conflict 1 same "* ]] && ok "the editor's saves through the helper: made, saved with a version kept, a stale save refused" || bad "editor saves: $edit"
    t_ok "a saved page is pamela's, group www-data, 644"   test "$(stat -c '%U:%G %a' "/pamela/public/$MSITE/verify-edit.html")" = "pamela:www-data 644"
    t_ok "earlier versions are pamela's own, 700, outside the website" test "$(stat -c '%U %a' /pamela/trash/.versions)" = "pamela 700"
    got=$(curl -s --max-time 15 "https://pammy.org/$MSITE/verify-edit.html?verify=$$-6")
    [[ $got == "<p>two</p>" ]] && ok "the saved page is live through Cloudflare" || bad "saved page through Cloudflare: $(head -c 100 <<<"$got")"
    back=$(mnode '
      import { createHash } from "node:crypto";
      import { callSiteFs } from "/opt/pammy-panel/src/sitefs/client.ts";
      const r = await callSiteFs("/run/pammy-sitefs.sock", { op: "files-version-restore", id: process.argv[1], expect: createHash("sha256").update("<p>two</p>").digest("hex"), actor: "verify" }, 60000);
      console.log(r.path);' "$vid" 2>&1)
    [[ $back == "$MSITE/verify-edit.html" && $(cat "/pamela/public/$MSITE/verify-edit.html") == "<p>one</p>" ]] && ok "an earlier version put back" || bad "restore a version: $back"
    # copies go through the helper's own byte copy (copyFileSync fchown()s, which its filter forbids)
    got=$(call "$SVC" "{\"op\":\"files-copy\",\"from\":\"$MSITE/verify-edit.html\",\"to\":\"$MSITE\",\"actor\":\"verify\"}" 2>&1 | grep -o '"name": "[^"]*"' | cut -d'"' -f4)
    [[ $got == verify-edit-2.html ]] && cmp -s "/pamela/public/$MSITE/verify-edit.html" "/pamela/public/$MSITE/$got" \
        && ok "File Explorer copy through the helper" || bad "File Explorer copy: ${got:-nothing}"
    got=$(call "$SVC" "{\"op\":\"media-copy\",\"from\":\"$MSITE/media/images/verify.png\",\"to\":\"$MSITE/media/images\",\"actor\":\"verify\"}" 2>&1 | grep -o '"name": "[^"]*"' | cut -d'"' -f4)
    [[ $got == verify-2.png ]] && t_ok "media copy through the helper, pamela's, group www-data, 644" test "$(stat -c '%U:%G %a' "/pamela/public/$MSITE/media/images/$got")" = "pamela:www-data 644" \
        || bad "media copy: ${got:-nothing}"
    { printf '{"path":"%s/verify-edit.html","text":"' "$MSITE"; head -c $((2 * 1024 * 1024)) /dev/zero | tr '\0' 'a'; printf '"}'; } > "$tmp/2mb.json"
    code=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' \
        --data-binary @"$tmp/2mb.json" "https://panel.pammy.org/api/files/save")
    [[ $code == 401 ]] && ok "a 2 MB editor save gets through Cloudflare and nginx to the panel (which wants a passkey session)" || bad "2 MB editor save through Cloudflare: $code"
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://panel.pammy.org/api/files/view/not-a-token/$MSITE/verify-edit.html")
    [[ $code == 410 ]] && ok "the preview needs a token the panel made (410 without)" || bad "preview without a token: $code"
else
    bad "couldn't make a test folder with a media folder"
fi
mcleanup
if [[ ${mig:-0} -ge 3 ]]; then
    /usr/local/sbin/pammy-panel media-sync >/dev/null 2>&1
    gone=$(mdb "SELECT DISTINCT state FROM files.records WHERE starts_with(path, '$MSITE/')" 2>&1)
    [[ -z $gone || $gone == missing ]] && ok "once the test folder is gone, a sync marks its records missing" || bad "media records after clean-up: $gone"
    mdb "DELETE FROM catalog.items WHERE resource_id = 1 AND starts_with(key, '$MSITE/')" >/dev/null 2>&1 || note "couldn't remove the test's media records (they're forgotten after 30 days anyway)"
    mdb "DELETE FROM catalog.labels WHERE scope_id IN (SELECT id FROM catalog.scopes WHERE source_id = 1 AND (path = '/$MSITE' OR starts_with(path, '/$MSITE/')))" >/dev/null 2>&1
    mdb "DELETE FROM catalog.scopes WHERE source_id = 1 AND (path = '/$MSITE' OR starts_with(path, '/$MSITE/'))" >/dev/null 2>&1
    /usr/local/sbin/pammy-panel media-thumbs >/dev/null 2>&1 || true     # publishes the index again, without them
fi

echo "--- only Cloudflare can reach it"
curl -sk --max-time 8 -o /dev/null --resolve "panel.pammy.org:443:127.0.0.1" https://panel.pammy.org/login; rc=$?
[[ $rc == 52 ]] && ok "straight to the server (127.0.0.1): connection closed" || bad "straight to 127.0.0.1: curl exit $rc (expected 52)"
curl -sk --max-time 8 -o /dev/null --resolve "panel.pammy.org:443:$ORIGIN_IP" https://panel.pammy.org/login; rc=$?
[[ $rc == 52 ]] && ok "straight to the public IP $ORIGIN_IP: connection closed" || bad "straight to $ORIGIN_IP: curl exit $rc (expected 52)"
curl -sk --max-time 8 -o /dev/null --resolve "panel.pammy.org:443:$ORIGIN_IP" -H 'CF-Connecting-IP: 1.2.3.4' https://panel.pammy.org/login; rc=$?
[[ $rc == 52 ]] && ok "a forged CF-Connecting-IP doesn't help" || bad "forged header: curl exit $rc"

code=$(curl -s --max-time 15 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' https://panel.pammy.org/login)
if [[ $code == 200 ]]; then ok "https://panel.pammy.org/login through Cloudflare: 200"
else bad "https://panel.pammy.org/login through Cloudflare: $code (DNS? Cloudflare SSL mode?)"; fi
grep -qi '^server: cloudflare' "$tmp/h" && ok "answered via Cloudflare" || bad "no 'server: cloudflare' header"
grep -qi "^content-security-policy: default-src 'none'" "$tmp/h" && ok "security headers present" || bad "CSP header missing"
grep -qi '^cf-cache-status: \(HIT\|MISS\|EXPIRED\|REVALIDATED\|UPDATING\)' "$tmp/h" && bad "Cloudflare is CACHING panel pages" || ok "Cloudflare isn't caching panel pages"
code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' https://panel.pammy.org/)
[[ $code == "302 https://panel.pammy.org/login" ]] && ok "signed-out home page -> /login" || bad "home page: $code"
code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' https://panel.pammy.org/api/login/options)
[[ $code == 403 ]] && ok "POST from another origin refused" || bad "POST without Origin: $code"
code=$(curl -s --max-time 15 -o "$tmp/b" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' -d '{}' https://panel.pammy.org/api/login/options)
[[ $code == 200 ]] && grep -q '"rpId":"panel.pammy.org"' "$tmp/b" && ok "passkey sign-in offered for panel.pammy.org" || bad "sign-in options: $code"
code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' http://panel.pammy.org/login)
[[ $code == 301 || $code == 308 ]] && ok "http redirects to https ($code)" || bad "http: $code"

# installed software (docs/apps-plan.md): its own script, so it can be run alone
echo
"$D/verify-apps.sh" && ok "installed software: every check above passed (verify-apps.sh)" || bad "installed software: verify-apps.sh failed (above)"
echo
echo "--- neighbours"
# pammy.org, and every installed software's address (the blog's, while it has one)
served=$(cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/call.ts" '{"op":"list","actor":"verify"}' 2>/dev/null \
    | /usr/bin/node -e 'let t = ""; process.stdin.on("data", (c) => t += c).on("end", () => { try { for (const a of JSON.parse(t).apps) if (a.address && !a.setup && !a.deleted) console.log(a.address); } catch {} })')
for u in https://pammy.org/ $served; do
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$u")
    [[ $code == 200 ]] && ok "$u still 200" || bad "$u: $code"
done

echo "--- the edge secret, last: this machine's own limits (docs/s1-plan.md S1c, review L5)"
verify_edge_limits /etc/pammy-panel 3044 3045 panel.pammy.org pammy.org

restarts_after=$(restarts)
[[ $restarts_after == "$restarts_before" ]] && ok "no sandboxed service crashed during these checks" || bad "a sandboxed service was restarted (crashed?) during these checks: before $restarts_before, after $restarts_after -- see journalctl -u <it>"
echo
echo "  panel: $pass passed, $fail failed"
panel_fail=$fail

if [[ -x $SETUP/verify-pamela-access.sh ]]; then
    echo
    echo "=== static site (verify-pamela-access.sh)"
    "$SETUP/verify-pamela-access.sh" || panel_fail=$((panel_fail+1))
fi
[[ $panel_fail -eq 0 ]]
