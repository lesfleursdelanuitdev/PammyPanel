#!/usr/bin/env bash
# Check lfdln's live control panel for real (docs/lfdln-standup-plan.md L8):
#   - its users own only their own things; its database is its own
#   - each service's sandbox is actually in force
#   - it and pammy.org's panel can't reach each other's files, database or helpers
#   - https://panel.lesfleursdelanuit.com answers, with only passkeys to sign in
#
#   sudo ~/pamela-setup/panel/deploy/lfdln/verify-lfdln.sh      (install-lfdln.sh runs it)
# Changes nothing.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
D="$(dirname "$(readlink -f "$0")")"
source "$D/pg/lib-pg.sh"
SVC=svc-lfdlnpanel
SVC_APPS=svc-lfdln-apps   # who builds and runs the projects (docs/phase8b-plan.md)
SVC_HOME=/var/lib/svc-lfdlnpanel
SITES_USER=svc-lfdlnsites
SITES_GROUP=lfdln-sites
PHPU=svc-lfdlnphp
THUMBSU=svc-lfdlnthumbs
MEDIA_PUBLIC=/var/lib/lfdln-media-public
APP=/opt/lfdln-panel
PORT=3046
SITES=/var/www/lesfleursdelanuit-sub
ACME_ROOT=/var/www/letsencrypt
HOST=panel.lesfleursdelanuit.com
ORIGIN_IP=203.0.113.200

pass=0 fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  note  %s\n' "$1"; }
t_ok() { local l=$1; shift; if "$@" >/dev/null 2>&1; then ok "$l"; else bad "$l"; fi; }
t_no() { local l=$1; shift; if "$@" >/dev/null 2>&1; then bad "$l"; else ok "$l"; fi; }
# engine_series <engine> <live version> <quadlet>: is the running engine of the series the tests
# start (test/engine-images.ts reads the same Image= line; docs/ci-plan.md T2)? Patch releases
# may differ for a while (auto-update, pulls), so the CI runner's is only noted when it does.
engine_series() {
    local series ci uid env=PG_VERSION
    series=$(sed -n 's/^Image=.*:\([0-9.]*\)$/\1/p' "$3")
    [[ -n $series && ( $2 == "$series" || $2 == "$series".* ) ]] && ok "...it runs $1 $2, the $series series the tests use" || bad "it runs $1 ${2:-(no answer)}, but the tests use the $series series ($3)"
    uid=$(id -u svc-ci 2>/dev/null) || return 0
    [[ $1 == MariaDB ]] && env=MARIADB_VERSION
    ci=$(cd / && runuser -u svc-ci -- env XDG_RUNTIME_DIR=/run/user/$uid podman image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(sed -n 's/^Image=//p' "$3")" 2>/dev/null \
        | sed -n "s/^$env=\(1:\)\{0,1\}\([0-9.]*\).*/\2/p")
    [[ -z $ci || $ci == "$2" ]] || note "the CI runner's $1 image is $ci, this one $2 (same series; they meet at the next pull)"
}
as_u() { local u=$1; shift; (cd / && runuser -u "$u" -- sh -c "$1"); }
# can user $1 open the unix socket $2 (connect, not just see it)?
can_open() { (cd / && runuser -u "$1" -- /usr/bin/node -e "require('net').connect('$2').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))") >/dev/null 2>&1; }
pg() { pg_as owner -c "$1"; }
pid_of() { systemctl show -p MainPID --value "$1"; }
# node as the panel's user, with the database password on fd 3 (as lfdln-panel hands it over)
lnode() {  # lnode <module source> [args...]
    local src=$1; shift
    (cd "$APP" && exec 3<"$PASS_DIR/panel.pass"
     runuser -u "$SVC" -- env -i PATH=/usr/bin:/bin PANEL_PG_PASSWORD_FD=3 \
        /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "$src" "$@")
}
curl_panel() { curl -sS --max-time 10 --resolve "$HOST:443:$ORIGIN_IP" --resolve "$HOST:80:$ORIGIN_IP" "$@"; }
GSOCK=/run/lfdln-gate-admin.sock
GATE_PORT=3047
gask() {  # gask <user> <json> -- ask the gate's admin door; prints its answer
    local user=$1 req=$2
    (cd "$APP" && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callJsonLine } from '@panel/core/jsonline';
      console.log(JSON.stringify(await callJsonLine('$GSOCK', $req, 'gate')));")
}

SANDBOXED="lfdln-panel lfdln-sitefs lfdln-thumbs lfdln-php lfdln-routes lfdln-services lfdln-mail lfdln-gate lfdln-pammydb lfdln-pammydb-gate lfdln-projects"
restarts() { local u; for u in $SANDBOXED; do printf '%s=%s ' "$u" "$(systemctl show "$u" -p NRestarts --value)"; done; }
restarts_before=$(restarts)

echo "=== lfdln's control panel (https://$HOST)"
echo "--- identity"
t_ok "system user $SVC exists, no login shell"         test "$(getent passwd "$SVC" | cut -d: -f7)" = /usr/sbin/nologin
t_ok "its home is 700 and its own"                      test "$(stat -c '%U %a' "$SVC_HOME")" = "$SVC 700"
t_ok "system user $SITES_USER owns the site folders' work, group $SITES_GROUP, no login shell" \
     test "$(id -gn "$SITES_USER"):$(getent passwd "$SITES_USER" | cut -d: -f7)" = "$SITES_GROUP:/usr/sbin/nologin"
t_ok "system user $PHPU exists, no login shell"         test "$(getent passwd "$PHPU" | cut -d: -f7)" = /usr/sbin/nologin
for u in "$SVC" "$SITES_USER" "$PHPU"; do
    t_no "$u is NOT in sudo"                            sh -c "id -nG $u | tr ' ' '\n' | grep -qx sudo"
done
t_no "$PHPU is NOT in $SITES_GROUP or www-data permanently" sh -c "id -nG $PHPU | tr ' ' '\n' | grep -qxE '$SITES_GROUP|www-data'"
t_ok "nginx (www-data) is in $SITES_GROUP, to read the site folders" sh -c "id -nG www-data | tr ' ' '\n' | grep -qx $SITES_GROUP"
members=$(getent group "$SITES_GROUP" | cut -d: -f4)
[[ $members == www-data ]] && ok "no one else is in $SITES_GROUP yet" || note "in $SITES_GROUP: $members (people with a Unix account, F3?)"

echo "--- its own database (Postgres, 127.0.0.1:$PG_PORT)"
t_ok "it answers"                                        pg "SELECT 1"
t_ok "the container is running"                          pg_svc_ctl is-active -q "$PG_CONTAINER"
t_ok "it listens on 127.0.0.1 only"                      sh -c "ss -ltnH 'sport = :$PG_PORT' | awk '{print \$4}' | sort -u | grep -qx 127.0.0.1:$PG_PORT"
want=$(cd "$APP" && /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "import { migrationFiles } from '@panel/core/pg-migrate'; console.log(migrationFiles().length)" 2>/dev/null)
got=$(pg "SELECT count(*) FROM public.schema_migrations" 2>/dev/null)
[[ -n $want && $got == "$want" ]] && ok "every migration ran ($got)" || bad "migrations: ${got:-none} of ${want:-?}"
live_schema=$(as_pg_svc podman exec -u postgres "$PG_CONTAINER" pg_dump --schema-only -d "$PG_DB" 2>/dev/null \
    | /usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/schema-snapshot.ts")
if [[ -n $live_schema ]] && diff -q <(printf '%s\n' "$live_schema") "$APP/db/schema.snapshot.sql" >/dev/null; then
    ok "the live schema is db/schema.snapshot.sql ($(grep -c '^CREATE TABLE' "$APP/db/schema.snapshot.sql") tables), as pammy.org's"
else
    bad "the live schema is not db/schema.snapshot.sql"
fi
for r in owner panel gate; do t_ok "$PASS_DIR/$r.pass is root's, 600" test "$(stat -c '%U %a' "$PASS_DIR/$r.pass")" = "root 600"; done
t_ok "the panel's role can read its tables"              pg_as panel -c "SELECT count(*) FROM panel.users"
t_no "the panel's role can NOT read the gate's"          pg_as panel -c "SELECT count(*) FROM gate.visitors"
t_ok "the gate's role can read its own tables (accounts step 3)" pg_as gate -c "SELECT count(*) FROM gate.visitors"
t_no "the gate's role can NOT read the panel's passkeys"  pg_as gate -c "SELECT count(*) FROM panel.passkeys"
t_no "the gate's role needs its password"                 sh -c "PGPASSWORD=x PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $PG_PORT -U pammy_gate -d $PG_DB -c 'SELECT 1'"
t_no "pammy.org's gate password doesn't open it"         sh -c "PGPASSWORD=\$(cat /etc/pammy-panel/db/gate.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $PG_PORT -U pammy_gate -d $PG_DB -c 'SELECT 1'"
t_no "and its own doesn't open pammy.org's gate (5434)"  sh -c "PGPASSWORD=\$(cat $PASS_DIR/gate.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5434 -U pammy_gate -d pammy -c 'SELECT 1'"
t_ok "nobody else may connect (PUBLIC revoked)"          test "$(pg "SELECT has_database_privilege('public', '$PG_DB', 'CONNECT')")" = f
t_no "pammy.org's panel password doesn't open it"        sh -c "PGPASSWORD=\$(cat /etc/pammy-panel/db/panel.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $PG_PORT -U pammy_panel -d $PG_DB -c 'SELECT 1'"
t_no "...nor its owner's"                                 sh -c "PGPASSWORD=\$(cat /etc/pammy-panel/db/owner.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $PG_PORT -U pammy_owner -d $PG_DB -c 'SELECT 1'"
t_no "and its own doesn't open pammy.org's (5434)"        sh -c "PGPASSWORD=\$(cat $PASS_DIR/panel.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5434 -U pammy_panel -d pammy -c 'SELECT 1'"
t_ok "lfdln-panel gets its password through LoadCredential" sh -c "systemctl cat lfdln-panel | grep -q '^LoadCredential=db.pass:$PASS_DIR/panel.pass'"
t_no "$SVC can't read the database passwords"            as_u "$SVC" "cat $PASS_DIR/panel.pass"
t_ok "the nightly backup timer is on"                    pg_svc_ctl is-active -q lfdln-pg-backup.timer
t_ok "lfdln-pg sees the installed pg_hba.conf (its folder is mounted, not the file)" test "$(echo "SELECT count(*) FROM pg_hba_file_rules" | pg_super)" = "$(grep -cE '^(local|host)' "$PG_SVC_HOME/conf/pg_hba.conf")"
last=$(ls -t "$PG_BACKUPS"/lfdln-*.dump 2>/dev/null | head -1)
[[ -n $last ]] && ok "a dump is there ($(basename "$last"), $(du -h "$last" | cut -f1))" || bad "no dump in $PG_BACKUPS"

echo "--- what the panel's user can reach"
# symlinks (node_modules/.bin) always show 777; what matters is their targets, which are checked too
t_ok "code is root-owned, not writable by anyone else" \
     sh -c "! find $APP ! -type l \\( ! -user root -o -perm /022 \\) -print -quit | grep -q . && ! find $APP -type l ! -user root -print -quit | grep -q ."
t_no "can't change its own code"                         as_u "$SVC" "touch $APP/.probe"
t_no "can't enter /pamela"                               as_u "$SVC" "ls /pamela/public"
t_no "can't read pammy.org's panel settings"             as_u "$SVC" "cat /etc/pammy-panel/db/panel.pass"
t_no "can't read the TLS private key"                    as_u "$SVC" "cat /etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/privkey.pem"
for s in /run/pammy-sitefs.sock /run/pammy-gate-admin.sock /run/pammy-pammydb.sock /run/pammy-pammydb-gate.sock /run/pammy-apps.sock /run/pammy-mail.sock /run/pammy-thumbs.sock; do
    t_no "can't open pammy.org's $(basename "$s")"       can_open "$SVC" "$s"
done

echo "--- service"
t_ok "running"                                           systemctl is-active -q lfdln-panel
t_ok "starts at boot"                                    systemctl is-enabled -q lfdln-panel
t_ok "listens on 127.0.0.1:$PORT only"                   sh -c "ss -ltnH 'sport = :$PORT' | awk '{print \$4}' | sort -u | grep -qx 127.0.0.1:$PORT"
pid=$(pid_of lfdln-panel)
t_ok "runs as $SVC"                                      test "$(ps -o user= -p "$pid" | tr -d ' ')" = "$SVC"
if [[ ${pid:-0} -gt 0 ]]; then
    t_no "inside its sandbox: /pamela isn't there"           nsenter -t "$pid" -m -- test -r /pamela/public
    t_no "inside its sandbox: the site folders aren't there" nsenter -t "$pid" -m -- ls "$SITES"
    # InaccessiblePaths leaves an empty mode-000 directory, which nsenter's root can still list
    t_ok "inside its sandbox: pammy.org's panel data isn't there" test "$(nsenter -t "$pid" -m -- stat -c %a /var/lib/svc-pammypanel)" = 0
    t_no "inside its sandbox: /home is empty"                 sh -c "nsenter -t $pid -m -- ls -A /home | grep -q ."
    t_no "inside its sandbox: /usr is read-only"              nsenter -t "$pid" -m -- sh -c 'touch /usr/.lfdln-probe && rm -f /usr/.lfdln-probe'
    t_ok "inside its sandbox: its home is writable"           nsenter -t "$pid" -m -- test -w "$SVC_HOME"
fi
t_ok "no privilege escalation (NoNewPrivileges)"         test "$(systemctl show -p NoNewPrivileges --value lfdln-panel)" = yes
t_ok "no Linux capabilities at all"                      test -z "$(systemctl show -p CapabilityBoundingSet --value lfdln-panel)"
t_ok "can't open network connections beyond localhost"   sh -c "systemctl show -p IPAddressDeny --value lfdln-panel | grep -q '0.0.0.0/0'"
note "systemd exposure rating: $(systemd-analyze security lfdln-panel 2>/dev/null | tail -1)"
t_ok "command line works (lfdln-panel users)"            lfdln-panel users

echo "--- folder helper (lfdln-sitefs: as $SITES_USER, only the panel can ask it)"
t_ok "socket is root:$SVC 660"                           test "$(stat -c '%U:%G %a' /run/lfdln-sitefs.sock)" = "root:$SVC 660"
t_ok "the panel's user can ask it"                       can_open "$SVC" /run/lfdln-sitefs.sock
for u in svc-pammypanel pamela www-data momolig "$SITES_USER"; do
    t_no "$u can't ask it"                               can_open "$u" /run/lfdln-sitefs.sock
done
t_ok "the trash is $SITES_USER's own, 700, inside the site folders (one mount)" test "$(stat -c '%U %a' "$SITES/.trash")" = "$SITES_USER 700"
(cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
  import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
  await callSiteFs('/run/lfdln-sitefs.sock', { op: 'list', actor: 'verify' });") >/dev/null 2>&1
hpid=$(pid_of lfdln-sitefs)
t_ok "runs as $SITES_USER"                               test "$(ps -o user= -p "$hpid" 2>/dev/null | tr -d ' ')" = "$SITES_USER"
if [[ ${hpid:-0} -gt 0 ]]; then
    t_ok "inside its sandbox: the site folders are writable" nsenter -t "$hpid" -m -- sh -c "touch $SITES/.trash/.probe && rm -f $SITES/.trash/.probe"
    t_no "inside its sandbox: the rest of /var/www isn't there" nsenter -t "$hpid" -m -- ls /var/www/instastylr
    t_no "inside its sandbox: /etc isn't writable"            nsenter -t "$hpid" -m -- sh -c 'touch /etc/.lfdln-probe && rm -f /etc/.lfdln-probe'
    t_no "inside its sandbox: /pamela isn't there"            nsenter -t "$hpid" -m -- ls /pamela/public
    t_no "inside its sandbox: lfdln's settings blocked"       nsenter -t "$hpid" -m -- cat /etc/lfdln-panel/panel.env
fi
t_ok "helper has no network"                             test "$(systemctl show -p PrivateNetwork --value lfdln-sitefs)" = yes
t_ok "helper has no Linux capabilities"                  test -z "$(systemctl show -p CapabilityBoundingSet --value lfdln-sitefs)"
t_ok "it refuses a path outside the site folders"        sh -c "(cd / && runuser -u $SVC -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e \"
  import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
  try { await callSiteFs('/run/lfdln-sitefs.sock', { op: 'trash', name: '../instastylr', actor: 'verify' }); process.exit(1); } catch { process.exit(0); }\")"
note "helper exposure rating: $(systemd-analyze security lfdln-sitefs 2>/dev/null | tail -1)"

# docs/phase8-plan.md step 8-1: File Explorer over the site folders, with thumbnails
echo "--- thumbnails (lfdln-thumbs: as $THUMBSU, only the panel can ask it)"
t_ok "system user $THUMBSU exists, no login shell"       test "$(getent passwd "$THUMBSU" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$THUMBSU is NOT in sudo, $SITES_GROUP or www-data permanently" sh -c "id -nG $THUMBSU | tr ' ' '\n' | grep -qxE 'sudo|$SITES_GROUP|www-data'"
t_ok "socket is root:$SVC 660"                           test "$(stat -c '%U:%G %a' /run/lfdln-thumbs.sock)" = "root:$SVC 660"
t_ok "the panel's user can ask it"                       can_open "$SVC" /run/lfdln-thumbs.sock
for u in svc-pammypanel pamela www-data momolig "$SITES_USER"; do
    t_no "$u can't ask it"                               can_open "$u" /run/lfdln-thumbs.sock
done
t_ok "$MEDIA_PUBLIC and its thumbs/ are $SVC's, 2750" test "$(stat -c '%U %a' "$MEDIA_PUBLIC") $(stat -c '%U %a' "$MEDIA_PUBLIC/thumbs")" = "$SVC 2750 $SVC 2750"
tools=$( (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
  import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
  console.log(JSON.stringify(await callSiteFs('/run/lfdln-thumbs.sock', { op: 'tools', actor: 'verify' })));") 2>/dev/null)
[[ $tools == *'"ffmpeg":true'* && $tools == *'"pdftoppm":true'* ]] && ok "it answers, with ffmpeg and pdftoppm" || bad "it answers, with ffmpeg and pdftoppm ($tools)"
tpid=$(pid_of lfdln-thumbs)
t_ok "runs as $THUMBSU"                                  test "$(ps -o user= -p "$tpid" 2>/dev/null | tr -d ' ')" = "$THUMBSU"
if [[ ${tpid:-0} -gt 0 ]]; then
    t_ok "inside its sandbox: the site folders are there"      nsenter -t "$tpid" -m -- test -d "$SITES"
    t_no "inside its sandbox: the site folders are read-only"  nsenter -t "$tpid" -m -- sh -c "touch $SITES/.lfdln-probe && rm -f $SITES/.lfdln-probe"
    t_ok "inside its sandbox: their trash isn't there"         test "$(nsenter -t "$tpid" -m -- stat -c %a "$SITES/.trash")" = 0
    t_no "inside its sandbox: the rest of /var/www isn't there" nsenter -t "$tpid" -m -- ls /var/www/instastylr
    t_no "inside its sandbox: /pamela isn't there"             nsenter -t "$tpid" -m -- ls /pamela/public
fi
t_ok "thumbnails have no network"                        test "$(systemctl show -p PrivateNetwork --value lfdln-thumbs)" = yes
t_ok "thumbnails have no Linux capabilities"             test -z "$(systemctl show -p CapabilityBoundingSet --value lfdln-thumbs)"
[[ ${pid:-0} -gt 0 ]] && t_ok "the panel may write $MEDIA_PUBLIC (inside its sandbox)" nsenter -t "$pid" -m -- test -w "$MEDIA_PUBLIC/thumbs"

echo "--- File Explorer (the folder helper's files-* ops, as the panel asks them)"
VF=zz-verify-files-$$
fs() {  # fs <json request> -- ask the folder helper as the panel's user; prints the answer or FAIL:<message>
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
      try { console.log(JSON.stringify(await callSiteFs('/run/lfdln-sitefs.sock', { actor: 'verify', ...$1 }))); }
      catch (e) { console.log('FAIL:' + e.message); }") 2>/dev/null
}
fs "{ op: 'create', name: '$VF' }" >/dev/null
t_ok "a scratch site folder made the way Hosts makes one" test -d "$SITES/$VF"
has() { [[ $1 == *"$2"* ]]; }   # has <answer> <text>
a=$(fs "{ op: 'files-mkdir', dir: '', name: 'zz-verify-top' }")
t_ok "nothing is made at the top (P8-1: that's the Hosts page)" has "$a" 'Hosts page'
t_no "...and nothing was"                                test -e "$SITES/zz-verify-top"
a=$(fs "{ op: 'files-trash', path: '$VF' }"); b=$(fs "{ op: 'files-move', from: '$VF', to: '', name: 'zz-renamed' }")
t_ok "a site folder isn't trashed or renamed from File Explorer" sh -c "[ -d '$SITES/$VF' ] && [ ! -e '$SITES/zz-renamed' ]"
t_ok "...and says why"                                   has "$a$b" 'Hosts page'
a=$(fs "{ op: 'files-mkdir', dir: '$VF', name: 'inner' }")
t_ok "inside a site folder: a folder made"               has "$a" "\"path\":\"$VF/inner\""
t_ok "...2750, $SITES_USER's, group $SITES_GROUP (nginx reads, nobody else)" test "$(stat -c '%U:%G %a' "$SITES/$VF/inner")" = "$SITES_USER:$SITES_GROUP 2750"
a=$(fs "{ op: 'files-copy', from: '$VF/index.html', to: '$VF/inner', name: 'copy.html' }")
t_ok "inside a site folder: a file copied, 640"          test "$(stat -c '%a' "$SITES/$VF/inner/copy.html" 2>/dev/null)" = 640
a=$(fs "{ op: 'files-trash', path: '$VF/inner/copy.html' }")
t_ok "inside a site folder: a file trashed"              sh -c "[ ! -e '$SITES/$VF/inner/copy.html' ]"
fs "{ op: 'trash', name: '$VF' }" >/dev/null
t_no "the scratch folder went to the trash"              test -e "$SITES/$VF"

echo "--- PHP in site folders (lfdln-php: as $PHPU)"
t_ok "running, starts at boot"                           sh -c "systemctl is-active -q lfdln-php && systemctl is-enabled -q lfdln-php"
t_ok "the distribution's php8.3-fpm is still masked"     test "$(systemctl is-enabled php8.3-fpm 2>/dev/null)" = masked
t_ok "its socket is $PHPU:$SITES_GROUP 660 (nginx may knock)" test "$(stat -c '%U:%G %a' /run/lfdln-php/fpm.sock)" = "$PHPU:$SITES_GROUP 660"
ppid=$(pid_of lfdln-php)
t_ok "runs as $PHPU, never root"                         test "$(ps -o user= -p "$ppid" | tr -d ' ')" = "$PHPU"
if [[ ${ppid:-0} -gt 0 ]]; then
    t_ok "inside its sandbox: can read the site folders"  nsenter -t "$ppid" -m -- test -d "$SITES"
    t_no "inside its sandbox: can't write them"           nsenter -t "$ppid" -m -- sh -c "touch $SITES/.lfdln-probe && rm -f $SITES/.lfdln-probe"
    t_no "inside its sandbox: the rest of /var/www isn't there" nsenter -t "$ppid" -m -- ls /var/www/instastylr
    t_no "inside its sandbox: /pamela isn't there"        nsenter -t "$ppid" -m -- ls /pamela/public
    t_no "inside its sandbox: pammy.org's PHP isn't there" nsenter -t "$ppid" -m -- test -e /run/pammy-php/fpm.sock
    t_ok "inside its sandbox: the host's Postgres socket blocked" test "$(nsenter -t "$ppid" -m -- stat -c %a /run/postgresql)" = 0
fi
t_ok "PHP has no network"                                test "$(systemctl show -p PrivateNetwork --value lfdln-php)" = yes
t_ok "PHP can't make memory it can run"                  test "$(systemctl show -p MemoryDenyWriteExecute --value lfdln-php)" = yes
note "PHP exposure rating: $(systemd-analyze security lfdln-php 2>/dev/null | tail -1)"

echo "--- https://$HOST"
t_ok "the site file is nginx's, rendered from the profile" bash -c "test -L /etc/nginx/sites-enabled/lfdln-panel && diff -q /etc/nginx/sites-available/lfdln-panel <(cd / && /usr/bin/node --disable-warning=ExperimentalWarning $APP/tools/render-nginx.ts /tmp/lfdln-verify-render --site lfdln >/dev/null && cat /tmp/lfdln-verify-render/site/panel.conf)"
rm -rf /tmp/lfdln-verify-render
code=$(curl_panel -o /dev/null -w '%{http_code}' "https://$HOST/login")
[[ $code == 200 ]] && ok "https://$HOST/login: 200" || bad "https://$HOST/login: $code"
t_ok "with the wildcard certificate"                     sh -c "echo | openssl s_client -connect $ORIGIN_IP:443 -servername $HOST 2>/dev/null | openssl x509 -noout -subject | grep -q 'lesfleursdelanuit.com'"
t_ok "security headers present"                          sh -c "curl -sS -D - -o /dev/null --max-time 10 --resolve $HOST:443:$ORIGIN_IP https://$HOST/login | grep -qi '^content-security-policy:'"
t_ok "signed-out home page -> /login"                    sh -c "curl -sS -o /dev/null -w '%{redirect_url}' --max-time 10 --resolve $HOST:443:$ORIGIN_IP https://$HOST/ | grep -q '/login\$'"
t_ok "http redirects to https (301)"                     test "$(curl_panel -o /dev/null -w '%{http_code}' "http://$HOST/login")" = 301
code=$(curl_panel -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'content-type: application/json' --data '{}' "https://$HOST/api/login/options")
[[ $code == 403 ]] && ok "POST from another origin refused" || bad "POST from another origin: $code"
t_ok "passkey sign-in offered for $HOST"                 sh -c "curl -sS --max-time 10 --resolve $HOST:443:$ORIGIN_IP -X POST -H 'Origin: https://$HOST' -H 'content-type: application/json' --data '{}' https://$HOST/api/login/options | grep -q '\"rpId\":\"$HOST\"'"
t_ok "the X-Real-IP a visitor sends isn't believed (nginx sets it)" sh -c "grep -q 'proxy_set_header X-Real-IP         \$remote_addr;' /etc/nginx/sites-available/lfdln-panel"

echo "--- Help: lfdln's own guides (docs/phase9-plan.md 9-1)"
LG="$D/../../../lfdln-guides"
want=$(grep -cvE '^\s*(#|$)' "$LG/guides.map")
t_ok "its guides are installed ($want), with their map"  test "$(find "$APP/help" -maxdepth 1 -name '*.txt' | wc -l)" = "$want" -a -f "$APP/help/guides.map"
gstale=0
while read -r src dst _; do cmp -s "$LG/$src" "$APP/help/$dst" || { bad "help/$dst is not lfdln-guides/$src"; gstale=1; }; done < <(grep -vE '^\s*(#|$)' "$LG/guides.map")
(( gstale )) || ok "each is the one in lfdln-guides/"
t_ok "none of Pamela's guides among them"                 sh -c "! ls '$APP/help' | grep -qE 'README|control-panel|wordpress|protected-folders'"
t_ok "the panel reads every one (title and parts)"        sh -c "cd / && /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e \"import { loadGuides } from '$APP/packages/help/src/help.ts'; const g = loadGuides('$APP/help'); process.exit(g.length === $want && g.every((x) => x.title && x.sections.length) ? 0 : 1)\""
code=$(curl_panel -o /dev/null -w '%{http_code}' "https://$HOST/api/help")
[[ $code == 401 ]] && ok "/api/help needs signing in (401)" || bad "/api/help signed out: $code"
echo "--- First steps on Home (docs/phase9-plan.md 9-3)"
code=$(curl_panel -o /dev/null -w '%{http_code}' "https://$HOST/api/first-steps")
[[ $code == 401 ]] && ok "/api/first-steps is there, and needs signing in (401)" || bad "/api/first-steps signed out: $code"
t_ok "its table is there (help/0001-first-steps.sql)"   test "$(pg_as panel -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'panel' AND table_name = 'first_steps'")" = 1
t_ok "the front end has the card"                       sh -c "grep -rqs 'home-first-steps' '$APP/public/assets/'"

HOSTS_DIR=/etc/nginx/lfdln-hosts
echo "--- the domain (docs/domains-hosts-plan.md step 1: a row, seeded from the profile)"
t_ok "lesfleursdelanuit.com is the home domain's row"     test "$(pg_as panel -c "SELECT name || ' ' || dns || ' ' || front || ' ' || cert FROM panel.domains WHERE home")" = "lesfleursdelanuit.com dreamhost direct wildcard-dns"
t_ok "its certificate is the wildcard"                   test "$(pg_as panel -c "SELECT tls->>'cert' FROM panel.domains WHERE home")" = /etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/fullchain.pem
t_ok "every host is on a domain"                         test "$(pg_as panel -c "SELECT count(*) FROM panel.hosts WHERE domain_id IS NULL")" = 0
t_ok "the hosts taken over say so (origin adopted)"      test "$(pg_as panel -c "SELECT count(*) FROM panel.hosts WHERE adopted <> (origin = 'adopted')")" = 0
t_ok "every route shows a kind lfdln has (step 2: folder, redirect, service; 8b-2: project)" test "$(pg_as panel -c "SELECT count(*) FROM panel.routes WHERE target_kind NOT IN ('folder', 'redirect', 'service', 'project')")" = 0
t_ok "each service route names its service and part"    test "$(pg_as panel -c "SELECT count(*) FROM panel.routes WHERE target_kind = 'service' AND NOT (target_ref ? 'service' AND target_ref ? 'part')")" = 0
if [[ ! -L /etc/nginx/sites-enabled/lfdln-hosts ]]; then
    echo "--- the hosts (not live yet: install-lfdln.sh --take-over)"
    t_ok "the stopgap catch-all still serves its folders"  test -L /etc/nginx/sites-enabled/lesfleursdelanuit-wildcard
else
    echo "--- the hosts (docs/hosts-plan.md; taken over from the stopgap, H10)"
    t_no "the stopgap catch-all is off"                    test -e /etc/nginx/sites-enabled/lesfleursdelanuit-wildcard
    t_ok "nginx has the routing helper's files"             test "$(readlink /etc/nginx/sites-enabled/lfdln-hosts)" = "$HOSTS_DIR/site.conf"
    t_ok "they are root's, and nobody else may change them" sh -c "test -z \"\$(find $HOSTS_DIR \\( ! -user root -o -perm /022 \\) -print -quit)\""
    t_ok "the site folders' root is $SITES_USER:$SITES_GROUP 2750" test "$(stat -c '%U:%G %a' "$SITES")" = "$SITES_USER:$SITES_GROUP 2750"
    t_ok "every folder in it is readable to nginx's group"  sh -c "test -z \"\$(find $SITES -mindepth 1 -path $SITES/.trash -prune -o \\( ! -group $SITES_GROUP -o ! -perm -g+r \\) -print -quit)\""
    t_no "hello/ is gone"                                   test -e "$SITES/hello"
    t_ok "the routing helper's socket is root:$SVC 660"     test "$(stat -c '%U:%G %a' /run/lfdln-routes.sock)" = "root:$SVC 660"
    t_ok "the panel's user can ask it"                      can_open "$SVC" /run/lfdln-routes.sock
    for u in svc-pammypanel pamela www-data momolig "$SITES_USER"; do
        t_no "$u can't ask it"                             can_open "$u" /run/lfdln-routes.sock
    done
    t_ok "it has no Linux capabilities and no network"     sh -c "test -z \"\$(systemctl show -p CapabilityBoundingSet --value lfdln-routes)\" && test \"\$(systemctl show -p PrivateNetwork --value lfdln-routes)\" = yes"
    t_ok "the places it may write: $HOSTS_DIR, and sites-enabled's links" sh -c "systemctl show -p ReadWritePaths --value lfdln-routes | grep -qx '$HOSTS_DIR /etc/nginx/sites-enabled'"
    note "routing helper exposure rating: $(systemd-analyze security lfdln-routes 2>/dev/null | tail -1)"
    # the zone really read: the refusals below pass while it can't be read too (every name is
    # refused then), which hid a zone that was never read (2026-09-26)
    t_ok "it reads DreamHost's zone (webmail is among its names)" lnode "
          import { callJsonLine } from '@panel/core/jsonline';
          const z = await callJsonLine('/run/lfdln-routes.sock', { op: 'zone' }, 'routing helper', 90000);
          if (!z.taken.includes('webmail')) process.exit(1);"
    # what the panel does before making a host (H6): names kept for the server, and the zone's own
    for n in panel webmail; do
        t_no "it refuses the name $n"                       lnode "
          import { callJsonLine } from '@panel/core/jsonline';
          await callJsonLine('/run/lfdln-routes.sock', { op: 'check-name', name: '$n' }, 'routing helper', 60000);"
    done
    nope="zz-nope-$$"
    code=$(curl -sS -o "/tmp/lfdln-verify-$$" -w '%{http_code}' --max-time 10 --resolve "$nope.lesfleursdelanuit.com:443:$ORIGIN_IP" "https://$nope.lesfleursdelanuit.com/")
    [[ $code == 404 ]] && grep -qi 'not found' "/tmp/lfdln-verify-$$" && ok "a name nobody made: the plain 404" || bad "https://$nope.lesfleursdelanuit.com/: $code"
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "hello.lesfleursdelanuit.com:443:$ORIGIN_IP" https://hello.lesfleursdelanuit.com/)
    [[ $code == 404 ]] && ok "hello.lesfleursdelanuit.com: 404 now (Q4)" || bad "hello.lesfleursdelanuit.com: $code"
    rm -f "/tmp/lfdln-verify-$$"

    # A real host, the way the panel makes one, then taken away: a site folder by the folder
    # helper, the table with it by the routing helper (nginx -t, reload), its page and a PHP
    # page through nginx, then the table as it was and the folder in the trash. The panel's
    # own tables are never written to.
    t="zz-host-verify-$$"
    table_with() {  # table_with add|as-is|gated <token>
        lnode "
          import { connectPg } from '@panel/core/pg';
          import { tableFrom } from '@panel/hosts/panel/routes/hosts';
          import { callServices } from '@panel/services/client';
          import { callJsonLine } from '@panel/core/jsonline';
          const db = connectPg({ role: 'panel', passwordFd: 3, port: $PG_PORT, database: '$PG_DB', max: 1, app: 'lfdln-verify' });
          const t = await tableFrom(db, (await callServices('/run/lfdln-services.sock', { op: 'ports' })).parts.map(({ service, part, port }) => ({ service, part, port })));
          await db.end({ timeout: 2 });
          if (process.argv[1] === 'add' || process.argv[1] === 'gated') {
            t.folders.push({ name: '$t', runPhp: true });
            t.hosts.push({ name: '$t', enabled: true });
            t.routes.push({ host: '$t', path: '/', enabled: true, kind: 'folder', folder: '$t', spa: false,
              ...(process.argv[1] === 'gated' ? { accounts: { token: process.argv[2] } } : {}) });
          }
          await callJsonLine('/run/lfdln-routes.sock', { op: 'apply', table: t }, 'routing helper', 150000);" "$@"
    }
    sitefs() { lnode "
          import { callSiteFs } from '@panel/files/sitefs/client';
          console.log(JSON.stringify(await callSiteFs('/run/lfdln-sitefs.sock', { op: process.argv[1], name: '$t', actor: 'verify' })));" "$1"; }
    if sitefs create >/dev/null 2>&1; then
        ok "made a site folder through the folder helper ($t)"
        t_ok "it is $SITES_USER's, group $SITES_GROUP, 2750; its page 640" \
            test "$(stat -c '%U:%G %a' "$SITES/$t") $(stat -c '%U:%G %a' "$SITES/$t/index.html")" = "$SITES_USER:$SITES_GROUP 2750 $SITES_USER:$SITES_GROUP 640"
        install -m 640 -o "$SITES_USER" -g "$SITES_GROUP" /dev/stdin "$SITES/$t/v.php" <<<'<?php echo "php-ran-" . (1 + 1); ?>'
        if table_with add >/dev/null 2>&1; then
            ok "the routing helper put it in nginx (nginx -t, reload)"
            u="https://$t.lesfleursdelanuit.com"
            r=(--resolve "$t.lesfleursdelanuit.com:443:$ORIGIN_IP" --max-time 10 -sS)
            # a reload returns before nginx's new workers answer, and for a moment after it
            # old and new workers both take connections (2026-09-27: two reloads 1.3 s apart,
            # one request gated and the next three not): wait until 5 answers in a row say
            # the same, up to 30 s (a new host has taken over 5)
            settled() {  # <url> <code>
                local n=0 i
                for i in $(seq 120); do
                    if [[ $(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$1") == "$2" ]]; then (( ++n >= 5 )) && break; else n=0; sleep 0.25; fi
                done
                (( i > 20 )) && note "nginx took about $((i / 4)) s to answer $2 steadily for $1 after its reload"
                return 0
            }
            settled "$u/" 200
            t_ok "$u/ serves its placeholder page"          sh -c "curl ${r[*]} $u/ | grep -q '$t'"
            t_ok "a .php page runs, and its code isn't sent" sh -c "curl ${r[*]} $u/v.php | grep -qx 'php-ran-2'"
            code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u/.trash/")
            [[ $code =~ ^(403|404)$ ]] && ok "a dot-path isn't served ($code)" || bad "$u/.trash/: $code"
            # the gate on every host (docs/phase8-plan.md 8-2): with no accounts too, and its
            # folder open to the gate's checks while no route with accounts shows it
            t_ok "its /_pammy/ is the gate's, with no accounts on it"  sh -c "curl ${r[*]} $u/_pammy/login.js | grep -q customElements"
            gchk() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: lesfleursdelanuit.com' -H 'X-Pammy-Base: /' -H "X-Pammy-Uri: /$t/index.html" "http://127.0.0.1:$GATE_PORT/check"; }
            sleep 2.5    # (the gate reads gate-routes.json again within 2 s)
            [[ $(gchk) == 204 ]] && ok "the gate lets its folder be seen (no route with accounts shows it)" || bad "the gate's check of /$t/: $(gchk)"
            # media folders and the media API through this real host (docs/phase8-plan.md step 8-3):
            # a media folder by the folder helper, a picture in it, the panel's records and
            # thumbnail (its own commands), and a key made, used and taken away again
            thumb=
            if lnode "
                 import { callSiteFs } from '@panel/files/sitefs/client';
                 await callSiteFs('/run/lfdln-sitefs.sock', { op: 'media-create', folder: '$t', actor: 'verify' });" >/dev/null 2>&1; then
                ok "a media folder made in the site folder ($t/media)"
                base64 -d <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
                    | install -m 640 -o "$SITES_USER" -g "$SITES_GROUP" /dev/stdin "$SITES/$t/media/images/v.png"
                t_ok "lfdln-panel media-sync takes the picture in"  sh -c "lfdln-panel media-sync | grep -q '^records:'"
                t_ok "lfdln-panel media-thumbs makes what is waiting" sh -c "lfdln-panel media-thumbs | grep -q '^made '"
                t_ok "the media API's index is $SVC's, 640, for the gate" test "$(stat -c '%U %a' "$MEDIA_PUBLIC/index.db" 2>/dev/null)" = "$SVC 640"
                t_no "a media folder at the top is refused (no main site's, P8-5)" lnode "
                 import { callSiteFs } from '@panel/files/sitefs/client';
                 await callSiteFs('/run/lfdln-sitefs.sock', { op: 'media-create', folder: '', actor: 'verify' });"
                kj=$(gask "$SVC" '{"op":"apikey.create","label":"verify-lfdln (removed again)","level":"approved","forms":"none","media":"all","actor":"verify"}' 2>/dev/null)
                key=$(grep -o '"key":"pammy_[A-Za-z0-9_-]*"' <<<"$kj" | cut -d'"' -f4)
                kid=$(grep -o '"id":[0-9]*' <<<"$kj" | head -1 | cut -d: -f2)
                if [[ -n $key && -n $kid ]]; then
                    ok "a key made through the gate's door (every media folder)"
                    list=$(curl "${r[@]}" -H "Authorization: Bearer $key" "$u/_pammy/api/media/in/$t/all")
                    got=$(node -e "const j=JSON.parse(process.argv[1]); const f=(j.files||[]).find(x=>x.name==='v.png'); process.stdout.write(f ? [f.src, f.url, f.thumb ? f.thumb.src : ''].join(' ') : 'none')" "$list" 2>/dev/null)
                    [[ $got == "/media/images/v.png https://$t.lesfleursdelanuit.com/media/images/v.png"* ]] \
                        && ok "the key lists the picture, its address through the host that shows the folder" || bad "the media API with a key: $(head -c 300 <<<"$list")"
                    thumb=$(awk '{print $3}' <<<"$got")
                    code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "https://$t.lesfleursdelanuit.com/media/images/v.png")
                    [[ $code == 200 ]] && ok "...and that address serves it" || bad "$u/media/images/v.png: $code"
                    if [[ -n $thumb ]]; then
                        code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u$thumb")
                        [[ $code == 200 ]] && ok "its thumbnail is handed out while no private route shows the folder" || bad "$u$thumb: $code"
                    else note "no thumbnail for the test picture yet (lfdln-thumbs); the private-route thumbnail check is skipped"; fi
                    code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u/_pammy/api/media/in/$t/all?key=$key")
                    [[ $code == 400 ]] && ok "a key in the address is refused (400)" || bad "a key in the address: $code"
                    code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$u/_pammy/api/media/main/all")
                    [[ $code == 404 ]] && ok "there is no main site's media folder in the API (404)" || bad "/_pammy/api/media/main/all: $code"
                    gask "$SVC" "{\"op\":\"apikey.revoke\",\"id\":$kid,\"actor\":\"verify\"}" >/dev/null 2>&1
                    code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$u/_pammy/api/media/in/$t/all")
                    [[ $code == 401 ]] && ok "revoked: the key stops working at once (401)" || bad "a revoked key: $code"
                    pg_as gate -c "DELETE FROM gate.api_keys WHERE id = $kid" >/dev/null 2>&1 && ok "...and the test key removed from the list" || bad "the test key $kid is still listed"
                else
                    bad "no test key: $(head -c 200 <<<"$kj")"
                fi
            else
                bad "the folder helper made no media folder in $t"
            fi
            # a real form through this host (docs/phase8-plan.md step 8-5): kept to the site folder
            # (P8-10), answered from its page, the response kept; then removed again
            fj=$(gask "$SVC" "{\"op\":\"form.create\",\"name\":\"zz-verify-form-$$\",\"items\":[{\"type\":\"long-text\",\"label\":\"Message\"}],\"formScope\":\"/$t\",\"actor\":\"verify\"}" 2>/dev/null)
            fid=$(grep -o '"id":[0-9]*' <<<"$fj" | head -1 | cut -d: -f2)
            if [[ -n $fid ]]; then
                ok "a form kept to $t made through the gate's door"
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u/_pammy/forms/zz-verify-form-$$?page=%2Findex.html")
                [[ $code == 200 ]] && ok "its page on $t.lesfleursdelanuit.com gets the form" || bad "the form on $u: $code"
                code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "lesfleursdelanuit.com:443:$ORIGIN_IP" "https://lesfleursdelanuit.com/_pammy/forms/zz-verify-form-$$?page=%2Findex.html")
                [[ $code == 404 ]] && ok "...and another site folder's page doesn't (404)" || bad "the form on the apex: $code"
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: $u" -H 'Content-Type: application/json' \
                    --data '{"page":"/index.html","answers":{"message":"verify-lfdln says hello"}}' "$u/_pammy/forms/zz-verify-form-$$")
                [[ $code == 200 ]] && ok "a response sent from the page" || bad "sending the form on $u: $code"
                n=$(pg_as gate -c "SELECT count(*) FROM gate.responses WHERE form_id = $fid")
                [[ $n == 1 ]] && ok "...and kept (1 response)" || bad "responses kept for the test form: $n"
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
                    --data '{"page":"/index.html","answers":{"message":"x"}}' "$u/_pammy/forms/zz-verify-form-$$")
                [[ $code == 403 ]] && ok "one sent from another site is refused (403)" || bad "a cross-site send: $code"
                gask "$SVC" "{\"op\":\"form.trash\",\"id\":$fid,\"actor\":\"verify\"}" >/dev/null 2>&1
                pg_as gate -c "DELETE FROM gate.forms WHERE id = $fid" >/dev/null 2>&1 && ok "...and the test form removed, with its response" || bad "the test form $fid is still there"
            else
                bad "no test form: $(head -c 200 <<<"$fj")"
            fi
            # a comment on this site folder's page (step 8-6): its thread is the page's file
            cj=$(gask "$SVC" "{\"op\":\"form.create\",\"name\":\"zz-verify-talk-$$\",\"title\":\"verify\",\"kind\":\"comments\",\"actor\":\"verify\"}" 2>/dev/null)
            cid=$(grep -o '"id":[0-9]*' <<<"$cj" | head -1 | cut -d: -f2)
            if [[ -n $cid ]]; then
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: $u" -H 'Content-Type: application/json' \
                    --data '{"page":"/","answers":{"your-name":"verify","your-comment":"verify-lfdln on a folder page"}}' "$u/_pammy/comments/zz-verify-talk-$$")
                [[ $code == 200 ]] && ok "a comment sent from $t's page" || bad "a comment on $u: $code"
                got=$(pg_as gate -c "SELECT page || ' ' || content_id FROM gate.responses WHERE form_id = $cid")
                [[ $got == "$t $t/index.html" ]] && ok "...kept on its file's conversation ($t/index.html)" || bad "the comment on $t was kept as: $got"
                pg_as gate -c "DELETE FROM gate.forms WHERE id = $cid" >/dev/null 2>&1 && ok "...and the test comment area removed" || bad "the test comment area $cid is still there"
            else
                bad "no test comment area: $(head -c 200 <<<"$cj")"
            fi
            # accounts on it (docs/roles-plan.md step 5): Only people let in, through the real
            # gate: an area made for a route that isn't in the panel's table, then taken away
            rid=$((2000000000 + $$))
            tok=$(gask "$SVC" "{\"op\":\"route-area.set\",\"routeId\":$rid,\"accounts\":\"private\",\"address\":\"$t.lesfleursdelanuit.com/\"}" 2>/dev/null | grep -o '"token":"[A-Za-z0-9_-]*"' | cut -d'"' -f4)
            if [[ -n $tok ]] && table_with gated "$tok" >/dev/null 2>&1; then
                ok "the gate made an area for it (Only people let in), and nginx has it"
                settled "$u/" 302
                t_ok "gate-routes.json has the host with its area" lnode "
                  import { readFileSync } from 'node:fs';
                  const r = JSON.parse(readFileSync('/etc/nginx/lfdln-hosts/gate-routes.json', 'utf8')).hosts['$t.lesfleursdelanuit.com'];
                  if (r?.[0]?.folder !== '$t' || r[0].area !== '$tok') process.exit(1);"
                sleep 2.5
                [[ $(gchk) == 401 ]] && ok "the gate refuses its folder to anyone not let in, as media and forms will ask it (P8-4)" || bad "the gate's check of /$t/ behind a private route: $(gchk)"
                if [[ -n $thumb ]]; then
                    code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u$thumb")
                    [[ $code == 404 ]] && ok "its media's thumbnail isn't handed out now: the private route covers the folder (P8-4)" || bad "$u$thumb behind a private route: $code"
                fi
                loc=$(curl "${r[@]}" -o /dev/null -w '%{redirect_url}' "$u/")
                [[ $loc == "$u/_pammy/login?next=%2F&area=$tok" ]] && ok "signed out: on to the sign-in page, with where they were going" || bad "$u/ signed out: $loc"
                t_ok "...and nothing of the page with it"        sh -c "! curl ${r[*]} $u/ | grep -q '$t'"
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' -H 'X-Lfdln-Account: 1' -H 'X-Lfdln-Role: Member' -H 'Cookie: __Host-lfdln_visitor=made-up' "$u/v.php")
                [[ $code == 302 ]] && ok "a PHP page asks too, whatever headers and cookie are sent (302, not run)" || bad "$u/v.php forged: $code"
                t_ok "the sign-in page is the gate's, on the host"   sh -c "curl ${r[*]} '$u/_pammy/login?area=$tok' | grep -q '<pammy-login'"
                code=$(curl "${r[@]}" -o /dev/null -w '%{http_code}' "$u/_pammy/check/$tok")
                [[ $code == 404 ]] && ok "the gate's check can't be asked from outside (404)" || bad "$u/_pammy/check/: $code"
                # signed in for real (docs/roles-plan.md step 6, S6-6): a visitor let in, their
                # sign-in through the host's own /_pammy/login, what a PHP page is told, and
                # their role taken away mattering on the very next request
                aid=$(gask "$SVC" '{"op":"state"}' 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).areas.find(x=>x.routeId===$rid);process.stdout.write(a?String(a.id):'')})")
                vu="zz-verify-$$" vp="zz-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
                vid=$(gask "$SVC" "{\"op\":\"visitor.create\",\"username\":\"$vu\",\"password\":\"$vp\"}" 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
                if [[ -n $aid && -n $vid ]] && gask "$SVC" "{\"op\":\"grant\",\"visitorId\":$vid,\"areaId\":$aid,\"allow\":true}" >/dev/null 2>&1; then
                    install -m 640 -o "$SITES_USER" -g "$SITES_GROUP" /dev/stdin "$SITES/$t/who.php" <<<'<?php foreach (["LFDLN_ACCOUNT","LFDLN_USERNAME","LFDLN_ROLE","LFDLN_PRIVILEGES","HTTP_X_LFDLN_ACCOUNT"] as $k) echo $k, "=", $_SERVER[$k] ?? "", "\n";'
                    install -m 640 -o "$SITES_USER" -g "$SITES_GROUP" /dev/stdin "$SITES/$t/pammy-panel.json" <<<'{"version":1}'
                    jar=$(mktemp)
                    code=$(curl "${r[@]}" -c "$jar" -o /dev/null -w '%{http_code}' -H "Origin: $u" -H 'Content-Type: application/json' \
                        --data "{\"area\":\"$tok\",\"username\":\"$vu\",\"password\":\"$vp\",\"next\":\"/who.php\"}" "$u/_pammy/login")
                    [[ $code == 200 ]] && ok "signed in through the host's own /_pammy/login" || bad "sign-in on $u: $code"
                    who=$(curl "${r[@]}" -b "$jar" -H 'X-Lfdln-Account: 1' -H 'X-Lfdln-Role: Teacher' -H 'X-Lfdln-Privileges: progress.read:any' "$u/who.php")
                    [[ $who == *"LFDLN_ACCOUNT=$vid"* && $who == *"LFDLN_USERNAME=$vu"* && $who == *"LFDLN_ROLE=Member"* && $who == *"LFDLN_PRIVILEGES=pages.read"* ]] \
                        && ok "a PHP page is told who, their role and privileges, from the gate" || bad "what who.php was told: $(tr '\n' ' ' <<<"$who")"
                    [[ $who == *"HTTP_X_LFDLN_ACCOUNT="$'\n'* || $who == *"HTTP_X_LFDLN_ACCOUNT=" ]] && ok "...never the headers sent with the request" || bad "the forged header reached PHP: $(tr '\n' ' ' <<<"$who")"
                    code=$(curl "${r[@]}" -b "$jar" -o /dev/null -w '%{http_code}' "$u/pammy-panel.json")
                    [[ $code == 404 ]] && ok "the folder's pammy-panel.json is never served, signed in or not (404)" || bad "$u/pammy-panel.json: $code"
                    gask "$SVC" "{\"op\":\"grant\",\"visitorId\":$vid,\"areaId\":$aid,\"allow\":false}" >/dev/null 2>&1
                    code=$(curl "${r[@]}" -b "$jar" -o /dev/null -w '%{http_code}' "$u/who.php")
                    [[ $code == 302 ]] && ok "their role taken away: the sign-in page on the very next request" || bad "after taking the role away: $code"
                    rm -f "$jar"
                else
                    bad "couldn't let a test visitor in (area ${aid:-?}, visitor ${vid:-?})"
                fi
                [[ -n $vid ]] && { gask "$SVC" "{\"op\":\"visitor.delete\",\"id\":$vid}" >/dev/null 2>&1 && ok "...and the test visitor deleted" || bad "the test visitor $vu is still there"; }
            else
                bad "no area for the test host (token: ${tok:-none})"
            fi
            [[ -n $tok ]] && { gask "$SVC" "{\"op\":\"route-area.set\",\"routeId\":$rid,\"accounts\":null}" >/dev/null 2>&1 && ok "...and its area taken away again" || bad "the test area is still in the gate"; }
        else
            bad "the routing helper didn't put the test host in nginx"
        fi
        t_ok "the table as it was, back in nginx"            table_with as-is
        # a reload returns before the old workers are gone, so wait for them as the add did
        if declare -F settled >/dev/null; then settled "https://$t.lesfleursdelanuit.com/" 404; fi
        code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$t.lesfleursdelanuit.com:443:$ORIGIN_IP" "https://$t.lesfleursdelanuit.com/")
        [[ $code == 404 ]] && ok "...so it answers 404 again" || bad "after: $code"
        t_ok "and the folder is in the trash"               sitefs trash
    else
        bad "the folder helper couldn't make a site folder"
    fi
fi

echo "--- services (docs/adopt-plan.md V7-V8: TutorStar, the Gonsalves apps and exam prep, taken in)"
REC=/var/lib/lfdln-services/services.json
svc() {  # svc <request as JSON>: the services helper's answer, asked as the panel's user
    lnode "import { callServices } from '@panel/services/client';
      try { console.log(JSON.stringify(await callServices('/run/lfdln-services.sock', JSON.parse(process.argv[1])))); }
      catch (e) { console.log(JSON.stringify({ refused: e.code ?? 'error', message: e.message })); }" "$1"
}
t_ok "its record is root's, 600, in a folder only root may open" test "$(stat -c '%U %a' "$REC") $(stat -c '%U %a' "$(dirname "$REC")")" = "root 600 root 700"
t_ok "the socket is root:$SVC 660"                      test "$(stat -c '%U:%G %a' /run/lfdln-services.sock)" = "root:$SVC 660"
t_ok "the panel's user can ask it"                      can_open "$SVC" /run/lfdln-services.sock
for u in svc-pammypanel pamela www-data momolig "$SITES_USER" svc-tutorstar svc-ligneous svc-lfdln-apps; do
    t_no "$u can't ask it"                             can_open "$u" /run/lfdln-services.sock
done
t_ok "it has no Linux capabilities"                    test -z "$(systemctl show -p CapabilityBoundingSet --value lfdln-services)"
t_ok "nothing is writable to it (ProtectSystem=strict, no ReadWritePaths)" sh -c "test \"\$(systemctl show -p ProtectSystem --value lfdln-services)\" = strict && test -z \"\$(systemctl show -p ReadWritePaths --value lfdln-services)\""
t_ok "it is denied every address but 127.0.0.1"        sh -c "systemctl show -p IPAddressDeny --value lfdln-services | grep -q '0.0.0.0/0' && systemctl show -p IPAddressAllow --value lfdln-services | grep -q '127.0.0.0/8'"
list=$(svc '{"op":"list"}')
for s in tutorstar gonsalves examprep; do
    grep -q "\"id\":\"$s\"" <<<"$list" && ok "$s is taken in" || bad "$s isn't in the helper's list: ${list:0:300}"
done
# every part the panel may control: running, and answering where it has a health path
node -e '
  const l = JSON.parse(process.argv[1]); let bad = 0;
  for (const s of l.services ?? []) for (const p of s.parts) if (p.controls) {
    const ok = p.active === "active" && !p.masked && (p.well !== false);
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${s.title}: ${p.title} ${p.active}${p.answering ? `, ${p.health} answers ${p.answering.status}` : ""}${p.memory ? `, ${Math.round(p.memory / 1048576)} MB` : ""}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);' "$list" && pass=$((pass+1)) || fail=$((fail+1))
node -e 'const l = JSON.parse(process.argv[1]); process.exit(l.services.flatMap((s) => s.parts).some((p) => p.changed === true) ? 1 : 0)' "$list" \
    && ok "their Quadlet files are what they were when taken in" || note "a Quadlet file changed since it was taken in (the Services page says which; a reinstall takes it in again)"
# S1f (c): the apps' containers onto pasta, each in its own deploy (deploy/lfdln/appdb/to-pasta.sh);
# until then a note naming each one still on the whole server's loopback
loopy=""
for qd in /var/lib/svc-lfdln-apps/.config/containers/systemd /var/lib/svc-tutorstar/.config/containers/systemd /var/lib/svc-ligneous/.config/containers/systemd; do
    for q in $(grep -ls '^Network=slirp4netns:allow_host_loopback=true' "$qd"/*.container 2>/dev/null); do loopy+=" $(basename "$q" .container)"; done
done
if [[ -z $loopy ]]; then ok "no app's container has allow_host_loopback (S1f: exam prep, TutorStar and Gonsalves on pasta)"
else note "still on slirp4netns with the whole server's loopback (S1f, to-pasta.sh <app> switch):$loopy"; fi
for m in examprep tutorstar gonsalves; do
    [[ -e /var/lib/svc-lfdlnappdb/moves/$m.pasta ]] && note "$m: $(cat "/var/lib/svc-lfdlnappdb/moves/$m.pasta") (the way back: to-pasta.sh $m back)"
done
# adopting again (into a copy) gives the same record: taking in changes nothing
cp -a "$REC" "/tmp/lfdln-verify-rec-$$"
(cd / && /usr/bin/node --disable-warning=ExperimentalWarning "$APP/sites/lfdln/src/helpers/services-adopt.ts" "/tmp/lfdln-verify-rec-$$") >/dev/null 2>&1
cmp -s "$REC" "/tmp/lfdln-verify-rec-$$" && ok "taking them in again changes nothing" || bad "taking them in again gave a different record"
rm -f "/tmp/lfdln-verify-rec-$$"
r=$(svc '{"op":"delete","id":"tutorstar"}'); [[ $r == *'"refused":"invalid"'* ]] && ok "there is no delete (D2)" || bad "delete: $r"
r=$(svc '{"op":"start","id":"gonsalves","part":"migrator","actor":"verify"}'); [[ $r == *'"refused":"invalid"'* ]] && ok "the Gonsalves migrator isn't started from the panel" || bad "migrator start: $r"
r=$(svc '{"op":"logs","id":"tutorstar","part":"web"}'); [[ $r == *'"lines":['* ]] && ok "TutorStar's log can be read" || bad "logs: ${r:0:200}"
# a restart, for real (Q4): TutorStar, a few seconds
since_before=$(runuser -u svc-tutorstar -- env XDG_RUNTIME_DIR=/run/user/$(id -u svc-tutorstar) systemctl --user show -p ActiveEnterTimestampMonotonic --value tutorstar.service 2>/dev/null)
r=$(svc '{"op":"restart","id":"tutorstar","actor":"verify-lfdln"}')
since_after=$(runuser -u svc-tutorstar -- env XDG_RUNTIME_DIR=/run/user/$(id -u svc-tutorstar) systemctl --user show -p ActiveEnterTimestampMonotonic --value tutorstar.service 2>/dev/null)
[[ $r == *'"well":true'* && -n $since_after && $since_after != "$since_before" ]] && ok "TutorStar restarted through the helper, and answers again" || bad "restart: ${r:0:300} ($since_before -> $since_after)"
# the routing helper refuses a service route to a port that isn't a service's
r=$(lnode "
  import { callJsonLine } from '@panel/core/jsonline';
  import { connectPg } from '@panel/core/pg';
  import { tableFrom } from '@panel/hosts/panel/routes/hosts';
          import { callServices } from '@panel/services/client';
  const db = connectPg({ role: 'panel', passwordFd: 3, port: $PG_PORT, database: '$PG_DB', max: 1, app: 'lfdln-verify' });
  const t = await tableFrom(db, (await callServices('/run/lfdln-services.sock', { op: 'ports' })).parts.map(({ service, part, port }) => ({ service, part, port })));
  await db.end({ timeout: 2 });
  t.hosts.push({ name: 'zz-port-verify-$$', enabled: true });
  t.routes.push({ host: 'zz-port-verify-$$', path: '/', enabled: true, kind: 'service', service: 'tutorstar', part: 'web', websockets: true, maxBodyMb: null, signInPaths: [] });
  t.services = [{ service: 'tutorstar', part: 'web', port: $PG_PORT }];
  try { await callJsonLine('/run/lfdln-routes.sock', { op: 'apply', table: t }, 'routing helper', 60000); console.log('accepted'); }
  catch (e) { console.log('refused ' + e.code); }" 2>&1)
[[ $r == 'refused invalid' ]] && ok "the routing helper won't send a host to a port that isn't a service's ($PG_PORT)" || bad "a route to :$PG_PORT: $r"
[[ ! -e /etc/nginx/lfdln-hosts/hosts/zz-port-verify-$$.conf ]] || bad "a host file for the refused route was left behind"
note "services helper exposure rating: $(systemd-analyze security lfdln-services 2>/dev/null | tail -1)"

echo "--- projects (docs/phase8b-plan.md step 8b-1: the helper, svc-lfdln-apps and the build image)"
prj() {  # prj <request as JSON>: the projects helper's answer, asked as the panel's user
    lnode "import { callProjects } from '@panel/projects/client';
      try { console.log(JSON.stringify(await callProjects('/run/lfdln-projects.sock', JSON.parse(process.argv[1])))); }
      catch (e) { console.log(JSON.stringify({ refused: e.code ?? 'error', message: e.message })); }" "$1"
}
t_ok "svc-lfdln-apps is there, lingering, with its own subuids" sh -c "id svc-lfdln-apps >/dev/null && test -f /var/lib/systemd/linger/svc-lfdln-apps && grep -q '^svc-lfdln-apps:' /etc/subuid"
t_ok "the helper's state folder is root's, 700"          test "$(stat -c '%U %a' /var/lib/lfdln-projects)" = "root 700"
t_ok "the socket is root:$SVC 660"                      test "$(stat -c '%U:%G %a' /run/lfdln-projects.sock)" = "root:$SVC 660"
t_ok "the panel's user can ask it"                      can_open "$SVC" /run/lfdln-projects.sock
for u in svc-pammypanel pamela www-data momolig "$SITES_USER" svc-lfdln-apps; do
    t_no "$u can't ask it"                             can_open "$u" /run/lfdln-projects.sock
done
t_ok "it has no Linux capabilities"                    test -z "$(systemctl show -p CapabilityBoundingSet --value lfdln-projects)"
t_ok "it may write only its state folder and the spool" sh -c "test \"\$(systemctl show -p ProtectSystem --value lfdln-projects)\" = strict && test \"\$(systemctl show -p ReadWritePaths --value lfdln-projects)\" = '/var/lib/lfdln-projects /run/lfdln-projects'"
t_ok "it is denied every address but 127.0.0.1"        sh -c "systemctl show -p IPAddressDeny --value lfdln-projects | grep -q '0.0.0.0/0' && systemctl show -p IPAddressAllow --value lfdln-projects | grep -q '127.0.0.0/8'"
pi=$(prj '{"op":"info"}')
grep -q '"user":"svc-lfdln-apps"' <<<"$pi" && grep -q '"image":"localhost/lfdln-build-node:current"' <<<"$pi" \
    && ok "it sees its user and the build image" || bad "info: ${pi:0:300}"
grep -q '"refused":"invalid"' <<<"$(prj '{"op":"job","id":"../../etc/shadow"}')" && ok "a job id not of its shape is refused" || bad "an odd job id wasn't refused"
# S1d (docs/s1-plan.md): every project's slots on pasta, none with the whole server's loopback --
# but one refresh kept (a variable still names 10.0.2.2), said by name, not counted
slirp=$(grep -ls allow_host_loopback /var/lib/$SVC_APPS/.config/containers/systemd/proj-*.container 2>/dev/null)
if [[ -z $slirp ]]; then
    ok "no project's Quadlet has allow_host_loopback (S1d: pasta, its databases' ports only)"
else
    for q in $slirp; do
        pid=$(sed -n 's/^Label=lfdln.project=//p' "$q"); pbr=$(sed -n 's/^Label=lfdln.branch=//p' "$q")
        left=$(node -e "try { const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).branches[process.argv[2]]||{};
          console.log(Object.keys(v).filter((k)=>!/^(NEXT_PUBLIC_|VITE_)/.test(k)&&v[k].includes('10.0.2.2')).sort().join(', ')); } catch { console.log(''); }" "/var/lib/lfdln-projects/env/$pid.json" "$pbr" 2>/dev/null)
        if [[ -n $left ]]; then note "$pid $pbr kept on slirp4netns (S1d): $left still name 10.0.2.2; set them to 127.0.0.1, then Restart"
        else bad "$(basename "$q") still has allow_host_loopback, and no variable of $pid $pbr names 10.0.2.2 (run install-lfdln.sh again: its step 8c moves it)"; fi
    done
fi
# S1f (b): a project variable naming 10.0.2.2 reaches nothing from pasta (names only, never values)
oldhost=$(node -e "const fs=require('fs'), d=process.argv[1]; let out=[];
  for (const f of (fs.existsSync(d) ? fs.readdirSync(d) : []).filter((x)=>x.endsWith('.json')).sort()) {
    try { const e=JSON.parse(fs.readFileSync(d+'/'+f,'utf8')); for (const [b,v] of Object.entries(e.branches||{})) {
      const n=Object.keys(v).filter((k)=>String(v[k]).includes('10.0.2.2')).sort(); if (n.length) out.push(f.slice(0,-5)+' '+b+': '+n.join(', ')); } } catch {}
  } console.log(out.join('; '));" /var/lib/lfdln-projects/env 2>/dev/null)
if [[ -n $oldhost ]]; then note "project variables naming 10.0.2.2, which reaches nothing from a project on pasta (S1f; set them to 127.0.0.1, then Restart): $oldhost"
else ok "no project variable names 10.0.2.2 (S1f)"; fi
pc=$(prj '{"op":"check","actor":"verify-lfdln","wait":true}')
if grep -q '"state":"done"' <<<"$pc"; then
    ok "the build image runs as svc-lfdln-apps, no network, read-only: $(node -e "const r=JSON.parse(process.argv[1]).job.result; console.log('node '+r.node+', npm '+r.npm+', pnpm '+r.pnpm+', git '+r.git)" "$pc" 2>/dev/null)"
else
    bad "the build environment check: ${pc:0:400}"
fi
code=$(curl_panel -o /dev/null -w '%{http_code}' "https://$HOST/api/projects")
[[ $code == 401 ]] && ok "/api/projects needs signing in (401)" || bad "/api/projects signed out: $code"
note "projects helper exposure rating: $(systemd-analyze security lfdln-projects 2>/dev/null | tail -1)"
# 8b-3 (D3-4, D3-5): pushes reach the helper through its spool; git lets each project's group in
t_ok "the push spool is root:lfdln-git 1730"            test "$(stat -c '%U:%G %a' /run/lfdln-projects/pushes)" = "root:lfdln-git 1730"
t_ok "...made again at boot (tmpfiles)"                  grep -q '^d /run/lfdln-projects/pushes 1730 root lfdln-git' /etc/tmpfiles.d/lfdln-projects.conf
t_ok "a waiting push starts the helper (the path unit)"  systemctl is-active -q lfdln-projects-pushes.path
t_ok "svc-lfdln-apps may drop pushes (in lfdln-git)"     sh -c "id -nG $SVC_APPS | tr ' ' '\n' | grep -qx lfdln-git"
t_no "nginx (www-data) can't drop pushes"                runuser -u www-data -- test -w /run/lfdln-projects/pushes
t_ok "/etc/gitconfig includes git's list of project repositories" sh -c "git config --system --get-all include.path | grep -qx /etc/lfdln-projects/gitconfig"
t_ok "...which is root's, 644"                           test "$(stat -c '%U %a' /etc/lfdln-projects/gitconfig)" = "root 644"
HOOK=$APP/packages/projects/git-hooks/post-receive
t_ok "the push hook is root's, and nobody else may change it" sh -c "test \"\$(stat -c '%U %a' $HOOK)\" = 'root 755' && test \"\$(stat -c '%U' $APP/packages/projects/git-hooks)\" = root"

echo "--- git over HTTPS (docs/phase8b-plan.md 8b-7): git.lesfleursdelanuit.com, git-http-backend under fcgiwrap as svc-lfdln-apps"
GITH=git.lesfleursdelanuit.com
for u in fcgiwrap.socket fcgiwrap.service; do
    t_ok "the package's own $u is masked (www-data, unused)"  test "$(systemctl is-enabled "$u" 2>/dev/null)" = masked
done
t_ok "lfdln-git-http.socket listens"                        systemctl is-active -q lfdln-git-http.socket
t_ok "its socket is root:www-data 660"                      test "$(stat -c '%U:%G %a' /run/lfdln-git-http.sock)" = "root:www-data 660"
t_ok "nginx (www-data) can open it"                         can_open www-data /run/lfdln-git-http.sock
for u in "$SVC" "$SVC_APPS" momolig; do
    t_no "$u can't open it"                                can_open "$u" /run/lfdln-git-http.sock
done
t_ok "git-http-backend runs as $SVC_APPS, no capabilities"  sh -c "test \"\$(systemctl show -p User --value lfdln-git-http)\" = $SVC_APPS && test -z \"\$(systemctl show -p CapabilityBoundingSet --value lfdln-git-http)\""
t_ok "...writes only the projects and the push spool, no network" sh -c "test \"\$(systemctl show -p ProtectSystem --value lfdln-git-http)\" = strict && systemctl show -p ReadWritePaths --value lfdln-git-http | grep -qx '/srv/lfdln-projects /run/lfdln-projects/pushes' && systemctl show -p IPAddressDeny --value lfdln-git-http | grep -q '0.0.0.0/0'"
t_ok "nginx has the git site (lfdln-git)"                   test -L /etc/nginx/sites-enabled/lfdln-git
gcode() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$GITH:443:127.0.0.1" "$@"; }
t_ok "https://$GITH/ is 404 (nothing but git's own paths)"  test "$(gcode "https://$GITH/")" = 404
gh_=$(curl -sS -D - -o /dev/null --max-time 10 --resolve "$GITH:443:127.0.0.1" "https://$GITH/zz-none.git/info/refs?service=git-upload-pack" 2>&1)
[[ $gh_ == *" 401"* && $gh_ == *"WWW-Authenticate: Basic"* ]] && ok "no token: 401 with a Basic challenge, so git asks for one" || bad "no token: ${gh_:0:200}"
t_ok "the panel's own site answers the check's path with 404" test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/projects/git-auth")" = 404

echo "--- the build boxes' way out (docs/phase8b-plan.md 8b-8b, P8b-11): the internal network lfdln-build and its proxy"
as_apps_v() { (cd / && runuser -u "$SVC_APPS" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SVC_APPS")" "$@"); }
AQD=/var/lib/$SVC_APPS/.config/containers/systemd
t_ok "its Quadlets are svc-lfdln-apps', 644"                 sh -c "test \"\$(stat -c '%U %a' $AQD/lfdln-build.network)\" = '$SVC_APPS 644' && test \"\$(stat -c '%U %a' $AQD/lfdln-build-proxy.container)\" = '$SVC_APPS 644'"
t_ok "the proxy runs (svc-lfdln-apps' lfdln-build-proxy)"     systemctl --user -M "$SVC_APPS@" is-active -q lfdln-build-proxy.service
t_ok "lfdln-build is an internal network"                    sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman network inspect --format '{{.Internal}}' lfdln-build | grep -qx true"
t_ok "the proxy's container is read-only, runs as node, no capabilities" sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{len .EffectiveCaps}}' lfdln-build-proxy | grep -qx 'true node 0'"
t_ok "...it looks names up at the server's own resolvers"    sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' lfdln-build-proxy | grep -qE '^PROXY_DNS=[0-9.]+'"
PXV=http://lfdln-build-proxy:3128
alone=$(as_apps_v podman run --rm --network lfdln-build localhost/lfdln-build-node:current node -e "fetch('https://registry.npmjs.org/ms', { signal: AbortSignal.timeout(5000) }).then((r) => console.log(r.status), () => console.log('no way out'))" 2>&1 | tail -1)
[[ $alone == "no way out" ]] && ok "a box on it reaches nothing by itself" || bad "a box on lfdln-build without the proxy: $alone"
through=$(as_apps_v podman run --rm --network lfdln-build -e "HTTPS_PROXY=$PXV" -e NODE_USE_ENV_PROXY=1 localhost/lfdln-build-node:current node -e "
  const go = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.status, () => 'refused');
  Promise.all([go('https://registry.npmjs.org/ms'), go('https://example.com/')]).then((x) => console.log(x.join(' ')))" 2>&1 | tail -1)
[[ $through == "200 refused" ]] && ok "...through the proxy: the npm registry, but not example.com" || bad "through the proxy: $through"
# read as root from the journal: svc-lfdln-apps is a system uid with no journal of its own, so its podman logs comes back empty (as the helper's logs op)
t_ok "...and the proxy says it turned example.com away"     sh -c "journalctl _UID=$(id -u $SVC_APPS) _SYSTEMD_USER_UNIT=lfdln-build-proxy.service --since -5min -o cat --no-pager -q | grep -q 'refused CONNECT example.com:443'"
hp=$(prj '{"op":"health"}')
[[ $hp == *'"proxy":true'* ]] && ok "the helper's health says the proxy runs (monitoring's row)" || bad "health's proxy: ${hp:0:160}"

echo "--- a throwaway project, made, built, rebuilt, rolled back, its packages, deleted (docs/phase8b-plan.md 8b-2, 8b-8a; npm over the internet)"
PID=zz-verify-$$
PD=/srv/lfdln-projects/$PID
jstate() { node -e "const j=JSON.parse(process.argv[1]).job; console.log(j ? j.state + (j.error ? ': ' + j.error : '') : JSON.parse(process.argv[1]).message)" "$1" 2>/dev/null; }
pm=$(prj "{\"op\":\"create\",\"actor\":\"verify-lfdln\",\"wait\":true,\"project\":{\"id\":\"$PID\",\"kind\":\"react\",\"pm\":\"npm\",\"typescript\":true,\"tailwind\":true,\"dev\":true}}")
if [[ $(jstate "$pm") == done ]]; then
    ok "made with create-vite and built ($PID, React, TypeScript, Tailwind, npm, a dev branch)"
    first=$(node -e "console.log(JSON.parse(process.argv[1]).job.result.release.id)" "$pm")
    t_ok "its folder is svc-lfdln-apps', 711"                 test "$(stat -c '%U %a' "$PD")" = "svc-lfdln-apps 711"
    # 8b-3 (D3-3): its repository shared with its group, the top folder setgid and sticky
    PG_=lfdln-p-$PID
    t_ok "its group $PG_ has svc-lfdln-apps"                  sh -c "getent group $PG_ | cut -d: -f4 | tr ',' '\n' | grep -qx $SVC_APPS"
    t_ok "its repository is svc-lfdln-apps:$PG_ 3770"         test "$(stat -c '%U:%G %a' "$PD/repo.git")" = "$SVC_APPS:$PG_ 3770"
    t_ok "...config, HEAD, hooks/ and info/ not group-writable" test -z "$(find "$PD/repo.git/config" "$PD/repo.git/HEAD" "$PD/repo.git/hooks" "$PD/repo.git/info" -maxdepth 0 -perm /g+w)"
    t_ok "...its hook, deletes refused, no gc by pushers"      sh -c "runuser -u $SVC_APPS -- git --git-dir=$PD/repo.git config core.hooksPath | grep -qx $APP/packages/projects/git-hooks && runuser -u $SVC_APPS -- git --git-dir=$PD/repo.git config receive.denyDeletes | grep -qx true && runuser -u $SVC_APPS -- git --git-dir=$PD/repo.git config receive.autogc | grep -qx false"
    t_ok "...git's list is root's, 644, and nothing half-written beside it" sh -c "test \"\$(stat -c '%U %a' /etc/lfdln-projects/gitconfig)\" = 'root 644' && test ! -e /etc/lfdln-projects/gitconfig.new"
    t_ok "...on git's list (safe.directory)"                   grep -qxF "	directory = $PD/repo.git" /etc/lfdln-projects/gitconfig
    t_no "nginx (www-data) can't read its code"               runuser -u www-data -- ls "$PD/repo.git"
    t_ok "dev was built too, shown from releases/dev"          test -L "$PD/releases/dev/current" -a -r "$PD/releases/dev/current/index.html"
    t_ok "its live release is linked as current"            test "$(readlink "$PD/releases/main/current")" = "$first"
    t_ok "nginx (www-data) can read the live release"        runuser -u www-data -- test -r "$PD/releases/main/current/index.html"
    t_ok "the build folder is emptied after (no node_modules left)" test ! -e "$PD/build/src"
    pb=$(prj "{\"op\":\"build\",\"id\":\"$PID\",\"branch\":\"main\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pb") == done ]] && ok "rebuilt: a second release, live" || bad "rebuild: $(jstate "$pb")"
    pr=$(prj "{\"op\":\"rollback\",\"id\":\"$PID\",\"branch\":\"main\",\"release\":\"$first\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pr") == done && $(readlink "$PD/releases/main/current") == "$first" ]] && ok "rolled back to the first release" || bad "roll back: $(jstate "$pr")"
    # 8b-3: a real push to dev through the hook and the spool, then Put dev live
    W=$(mktemp -d); chown "$SVC_APPS:" "$W"
    as_svc() { (cd "$W" && runuser -u "$SVC_APPS" -- env HOME="$W" "$@"); }
    if as_svc git clone -q --branch dev "file://$PD/repo.git" "$W/c" && \
       as_svc sh -c "cd $W/c && sed -i 's|<title>.*</title>|<title>verify $PID</title>|' index.html && git -c user.name=verify -c user.email=verify@lfdln add -A && git -c user.name=verify -c user.email=verify@lfdln commit -qm 'verify: a change on dev' && git push -q origin dev 2>&1"; then
        new=$(as_svc git -C "$W/c" rev-parse HEAD)
        ok "pushed a commit to dev as svc-lfdln-apps (${new:0:12})"
        state=; for i in $(seq 1 120); do
            state=$(prj "{\"op\":\"jobs\",\"project\":\"$PID\"}" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8')).jobs.find((x)=>x.what==='push'); console.log(j ? j.state : '')" 2>/dev/null)
            [[ $state == done || $state == failed ]] && break; sleep 5
        done
        [[ $state == done ]] && ok "the push was picked up from the spool and dev rebuilt" || bad "the push to dev: job ${state:-never queued}"
        t_ok "...the preview has the change"                   grep -q "verify $PID" "$PD/releases/dev/current/index.html"
        t_no "...live (main) doesn't yet"                       grep -q "verify $PID" "$PD/releases/main/current/index.html"
        pp=$(prj "{\"op\":\"promote\",\"id\":\"$PID\",\"actor\":\"verify-lfdln\",\"wait\":true}")
        [[ $(jstate "$pp") == done ]] && ok "Put dev live: main moved to dev and built" || bad "Put dev live: $(jstate "$pp")"
        t_ok "...live has the change now"                       grep -q "verify $PID" "$PD/releases/main/current/index.html"
        t_ok "...main is dev's commit"                          test "$(runuser -u "$SVC_APPS" -- git --git-dir="$PD/repo.git" rev-parse main)" = "$new"
        t_ok "...a branch can't be deleted by a push"           sh -c "! (cd $W/c && runuser -u $SVC_APPS -- env HOME=$W git push -q origin :dev 2>/dev/null)"
    else
        bad "couldn't push a commit to dev as svc-lfdln-apps"
    fi
    rm -rf --one-file-system -- "$W"
    # 8b-8a: its packages, for real (npm over the internet): checked, one added (a commit on
    # dev, then built), a version that doesn't exist refused with dev left alone, a script run,
    # and the registry asked
    devhead() { runuser -u "$SVC_APPS" -- git --git-dir="$PD/repo.git" rev-parse dev; }
    pc=$(prj "{\"op\":\"packages-check\",\"id\":\"$PID\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    node -e "const c=JSON.parse(process.argv[1]).job.result.check; process.exit(c.branch==='dev'&&c.packages.some((p)=>p.name==='react')&&c.scripts.build?0:1)" "$pc" 2>/dev/null \
        && ok "packages checked on dev (react among them, its scripts read)" || bad "checking packages: $(jstate "$pc")"
    d0=$(devhead)
    pa=$(prj "{\"op\":\"packages-change\",\"id\":\"$PID\",\"change\":{\"add\":[{\"name\":\"ms\",\"version\":\"^2\"}]},\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pa") == done ]] && ok "a package added (ms), then dev built" || bad "adding a package: $(jstate "$pa")"
    t_ok "...as a commit on dev, after the one before"         sh -c "test \"\$(runuser -u $SVC_APPS -- git --git-dir=$PD/repo.git log -1 --format=%s dev)\" = 'Packages: add ms@^2' && runuser -u $SVC_APPS -- git --git-dir=$PD/repo.git merge-base --is-ancestor $d0 dev"
    t_ok "...the check after it has ms"                         sh -c "cat /var/lib/lfdln-projects/packages/$PID-dev.json | grep -q '\"name\":\"ms\"'"
    t_ok "...the check is root's, 600"                          test "$(stat -c '%U %a' "/var/lib/lfdln-projects/packages/$PID-dev.json")" = "root 600"
    d1=$(devhead)
    pf=$(prj "{\"op\":\"packages-change\",\"id\":\"$PID\",\"change\":{\"add\":[{\"name\":\"ms\",\"version\":\"99.99.99\"}]},\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pf") == failed* && $(devhead) == "$d1" ]] && ok "a version that doesn't exist: the job fails, dev left as it was" || bad "a bad version: $(jstate "$pf") (dev $(devhead | cut -c1-12))"
    ps=$(prj "{\"op\":\"script\",\"id\":\"$PID\",\"script\":\"build\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$ps") == done ]] && ok "a script run (build), with its output in the job's log" || bad "running the build script: $(jstate "$ps")"
    sd=$(prj "{\"op\":\"script\",\"id\":\"$PID\",\"script\":\"dev\",\"actor\":\"verify-lfdln\"}")
    [[ $sd == *"serves and never finishes"* ]] && ok "...never one that serves (dev is refused)" || bad "the dev script: ${sd:0:160}"
    sr=$(prj '{"op":"package-search","text":"zod"}'); ab=$(prj '{"op":"package-about","name":"zod","lang":"ts"}')
    [[ $sr == *'"name":"zod"'* && $ab == *'"found":true'* ]] && ok "the npm registry asked from a short box (search, a package's details)" || bad "the registry: ${sr:0:120} | ${ab:0:120}"
    # 8b-7: git over HTTPS, for real, through nginx, the panel's check, fcgiwrap and the hook: a
    # throwaway panel person with the Projects part and a token (gone again at the end)
    GU=zz-verify-git-$$
    pg "DELETE FROM panel.users WHERE username LIKE 'zz-verify-git-%'" >/dev/null 2>&1
    gid=$(pg "INSERT INTO panel.users (username, display_name, role, active, webauthn_user_id, created_at) VALUES ('$GU', 'verify-lfdln', 'member', 1, 'zz-verify-git-$$-$(date +%s%N)', extract(epoch FROM now())::bigint) RETURNING id" 2>/dev/null | head -1)
    graw=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
    gtok="lfdln_git_$graw"
    ghash=$(printf '%s' "$gtok" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')
    if [[ $gid =~ ^[0-9]+$ ]] && pg "INSERT INTO panel.user_rights (user_id, name) VALUES ($gid, 'projects'); INSERT INTO panel.git_tokens (user_id, label, hash, hint, created_at, expires_at) VALUES ($gid, 'verify-lfdln', '$ghash', '${graw:0:4}', extract(epoch FROM now())::bigint, extract(epoch FROM now())::bigint + 3600)" >/dev/null 2>&1; then
        G=$(mktemp -d)
        gg() { (cd "$G" && GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "http.curloptResolve=$GITH:443:127.0.0.1" "$@"); }
        GURL="https://$GU:$gtok@$GITH/$PID.git"
        gg clone -q "$GURL" "$G/c" 2>"$G/err" && ok "cloned over HTTPS with a token (someone with Projects, not an owner)" || bad "clone over HTTPS: $(head -c 300 "$G/err")"
        gg -C "$G/c" checkout -q dev 2>/dev/null && gg -C "$G/c" -c user.name=verify -c user.email=verify@lfdln commit -q --allow-empty -m 'verify: over HTTPS'
        if gg -C "$G/c" push -q origin dev 2>"$G/err"; then bad "pushed over HTTPS without being an owner"
        elif grep -q 403 "$G/err"; then ok "...but can't push: not an owner (403)"
        else bad "a non-owner's push over HTTPS: $(head -c 300 "$G/err")"; fi
        po=$(prj "{\"op\":\"owners\",\"id\":\"$PID\",\"owners\":[\"verify-lfdln\",\"$GU\"],\"actor\":\"verify-lfdln\",\"wait\":true}")
        [[ $(jstate "$po") == done ]] && ok "made an owner of $PID" || bad "owners: $(jstate "$po")"
        if gg -C "$G/c" push -q origin dev 2>"$G/err"; then
            ok "an owner's token pushes dev over HTTPS"
            state=; for i in $(seq 1 120); do
                state=$(prj "{\"op\":\"jobs\",\"project\":\"$PID\"}" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8')).jobs.find((x)=>x.what==='push'&&x.by==='$GU'); console.log(j ? j.state : '')" 2>/dev/null)
                [[ $state == done || $state == failed ]] && break; sleep 5
            done
            [[ $state == done ]] && ok "...the hook's spool took it and dev was built, the job saying $GU (not svc-lfdln-apps)" || bad "the push over HTTPS: job ${state:-never queued as $GU}"
        else
            bad "an owner's push over HTTPS: $(head -c 300 "$G/err")"
        fi
        t_ok "...the token's last use written down"            test -n "$(pg "SELECT last_used_at FROM panel.git_tokens WHERE user_id = $gid" 2>/dev/null)"
        pg "DELETE FROM panel.users WHERE id = $gid" >/dev/null 2>&1
        gg ls-remote "$GURL" >/dev/null 2>&1 && bad "the token still works after its person is gone" || ok "...and stops at once when its person is deleted"
        rm -rf --one-file-system -- "$G"
    else
        bad "couldn't make a throwaway panel person and git token"
        pg "DELETE FROM panel.users WHERE username = '$GU'" >/dev/null 2>&1
    fi
else
    bad "making a project: $(jstate "$pm")"
fi
pd=$(prj "{\"op\":\"delete\",\"id\":\"$PID\",\"actor\":\"verify-lfdln\",\"wait\":true}")
if [[ $(jstate "$pd") == done ]]; then
    to=$(node -e "console.log(JSON.parse(process.argv[1]).job.result.trashed)" "$pd")
    t_ok "deleted: out of its folder, into the trash"         test ! -e "$PD" -a -d "$to"
    t_no "...its group gone"                                   getent group "lfdln-p-$PID"
    t_no "...and off git's list"                               grep -qF "$PD/repo.git" /etc/lfdln-projects/gitconfig
    rm -rf --one-file-system -- "$to"
else
    bad "deleting $PID: $(jstate "$pd")"
    [[ -d $PD ]] && rm -rf --one-file-system -- "$PD"
fi

echo "--- a throwaway Next.js server: made, switched in, rebuilt into the other slot, stopped, started, its environment, rolled back, deleted (docs/phase8b-plan.md 8b-4a, 8b-4b)"
SID=zz-verify-srv-$$
# the engines a project may reach (S1d): their ports, as their libraries name them
P_APPDB=$(sed -n "s/^APPDB_PORT=//p" "$D/appdb/lib-appdb.sh"); P_APPMARIA=$(sed -n "s/^APPMARIA_PORT=//p" "$D/appmaria/lib-appmaria.sh")
NGX_UP=/etc/nginx/lfdln-projects
t_ok "nginx includes the projects' upstreams"               grep -qxF "include $NGX_UP/*.conf;" /etc/nginx/conf.d/lfdln-projects.conf
t_ok "the servers' base image is in svc-lfdln-apps' podman"   runuser -u "$SVC_APPS" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SVC_APPS")" sh -c 'cd / && podman image exists docker.io/library/node:24-bookworm-slim'
uctl() { systemctl --user -M "$SVC_APPS@" "$@"; }
# reach_from <container> "<host:port> ...": "<host:port>=open|closed ..." as the container sees it (S1d)
reach_from() {
    (cd / && runuser -u "$SVC_APPS" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SVC_APPS")" podman exec "$1" node -e '
      const net = require("net");
      const one = (hp) => new Promise((r) => { const i = hp.lastIndexOf(":"); const s = net.connect(Number(hp.slice(i + 1)), hp.slice(0, i));
        const t = setTimeout(() => { s.destroy(); r(hp + "=closed"); }, 3000);
        s.on("connect", () => { clearTimeout(t); s.destroy(); r(hp + "=open"); }); s.on("error", () => { clearTimeout(t); r(hp + "=closed"); }); });
      Promise.all(process.argv[1].split(" ").map(one)).then((x) => console.log(x.join(" ")));' "$2" 2>&1)
}
# a branch's live slot and its port, from the helper's list: "<slot> <port> <stopped>"
live_of() { prj '{"op":"list"}' | node -e "const p=JSON.parse(require('fs').readFileSync(0,'utf8')).projects.find((x)=>x.id===process.argv[1]); const b=p&&p.branches.main; console.log(b&&b.slot!=null ? b.slot+' '+b.ports[b.slot]+' '+!!b.stopped : 'none')" "$SID" 2>/dev/null; }
up_port() { sed -n 's/^ *server 127\.0\.0\.1:\([0-9]*\);.*/\1/p' "$NGX_UP/$SID-main.conf" 2>/dev/null; }
ps1=$(prj "{\"op\":\"create\",\"actor\":\"verify-lfdln\",\"wait\":true,\"project\":{\"id\":\"$SID\",\"kind\":\"next\",\"pm\":\"npm\",\"typescript\":true,\"tailwind\":false,\"dev\":false}}")
if [[ $(jstate "$ps1") == done ]]; then
    read -r slot port stopped <<<"$(live_of)"
    sfirst=$(node -e "console.log(JSON.parse(process.argv[1]).job.result.release.id)" "$ps1")
    ok "made with create-next-app, built standalone, its image built, live in slot $slot on :$port"
    t_ok "...its unit runs as svc-lfdln-apps"                    uctl is-active -q "proj-$SID-main-a.service"
    t_ok "...it answers on 127.0.0.1:$port"                       curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$port/"
    t_ok "...nginx's upstream points at it, and nginx takes it"   sh -c "test \"\$(sed -n 's/^ *server 127\\.0\\.0\\.1:\\([0-9]*\\);.*/\\1/p' $NGX_UP/$SID-main.conf)\" = $port && nginx -t -q"
    t_ok "...the upstream file is root's, 644"                    test "$(stat -c '%U %a' "$NGX_UP/$SID-main.conf")" = "root 644"
    cid=proj-$SID-main-a
    t_ok "...its container is read-only, runs as node, no capabilities" sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{len .EffectiveCaps}}' $cid | grep -qx 'true node 0'"
    t_ok "...listening on 127.0.0.1 only"                         sh -c "ss -Hltn 'sport = :$port' | grep -q '127.0.0.1:$port' && ! ss -Hltn 'sport = :$port' | grep -qv '127.0.0.1:$port'"
    # S1d (docs/s1-plan.md): pasta, the engines' ports alone on its own 127.0.0.1
    QD=/var/lib/$SVC_APPS/.config/containers/systemd
    t_ok "...its network is pasta, with lfdln-appdb's and lfdln-appmaria's ports forwarded" grep -qx "Network=pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,$P_APPMARIA,-T,$P_APPDB" "$QD/$cid.container"
    t_no "...no allow_host_loopback"                               grep -q allow_host_loopback "$QD/$cid.container"
    others=""; for p_ in 22 3039 3040 3041 3042 3043 3044 3045 3046 3047 3048 3307 4101 4200 5001 5432 5433 5434 5435 8091; do others+=" 127.0.0.1:$p_"; done
    reach=$(reach_from "$cid" "127.0.0.1:$P_APPDB 127.0.0.1:$P_APPMARIA$others 10.0.2.2:$P_APPDB 10.0.2.2:3046 $ORIGIN_IP:3046 $ORIGIN_IP:$P_APPDB")
    [[ $reach == "127.0.0.1:$P_APPDB=open 127.0.0.1:$P_APPMARIA=open"* ]] && ok "...from inside, it reaches lfdln-appdb and lfdln-appmaria on 127.0.0.1" || bad "...its databases from inside: $reach"
    [[ $(tr ' ' '\n' <<<"$reach" | tail -n +3 | grep -c '=open') == 0 ]] && ok "...and nothing else of the server: the panel, the gate, the other databases, exam prep, ssh, 10.0.2.2, the public address' loopback ports" || bad "...it reaches more than its databases: $reach"
    # ...as its pasta was started: no forward but the two engines' (podman adds -U none itself)
    sk=$(cd / && runuser -u "$SVC_APPS" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$SVC_APPS")" podman inspect --format '{{.NetworkSettings.SandboxKey}}' "$cid" 2>/dev/null)
    pargs=$([[ -n $sk ]] && pgrep -a -u "$SVC_APPS" pasta | grep -F -- "--netns $sk" | head -1)
    fwd=$(grep -oE -- ' -T [^ ]+' <<<"$pargs" | sort | tr -d '\n')
    [[ -n $pargs && $pargs == *' -U none'* && $fwd == " -T $P_APPMARIA -T $P_APPDB" ]] && ok "...its pasta forwards only -T $P_APPMARIA -T $P_APPDB, and -U none" || bad "...its pasta: ${pargs:0:300}"
    pb=$(prj "{\"op\":\"build\",\"id\":\"$SID\",\"branch\":\"main\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    read -r slot2 port2 _ <<<"$(live_of)"
    [[ $(jstate "$pb") == done && $slot2 == 1 && $port2 != "$port" ]] && ok "rebuilt: slot b on :$port2, switched in" || bad "rebuild of a server: $(jstate "$pb") (slot $slot2, port $port2)"
    t_ok "...nginx's upstream follows it"                         test "$(up_port)" = "$port2"
    t_no "...slot a stopped"                                       uctl is-active -q "proj-$SID-main-a.service"
    t_no "...and its Quadlet is gone"                              test -e "/var/lib/$SVC_APPS/.config/containers/systemd/proj-$SID-main-a.container"
    t_no "...the old port answers no more"                         curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port/"
    pst=$(prj "{\"op\":\"control\",\"id\":\"$SID\",\"branch\":\"main\",\"action\":\"stop\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pst") == done ]] && ok "stopped" || bad "stop: $(jstate "$pst")"
    t_ok "...and masked (stays stopped after a reboot)"           sh -c "uctl() { systemctl --user -M $SVC_APPS@ \"\$@\"; }; test \"\$(uctl show -p LoadState --value proj-$SID-main-b.service)\" = masked"
    t_no "...it answers no more"                                   curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port2/"
    pso=$(prj "{\"op\":\"control\",\"id\":\"$SID\",\"branch\":\"main\",\"action\":\"start\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    [[ $(jstate "$pso") == done ]] && ok "started again, and it answers" || bad "start: $(jstate "$pso")"
    plg=$(prj "{\"op\":\"logs\",\"id\":\"$SID\",\"branch\":\"main\"}")
    grep -q '"lines":\[' <<<"$plg" && ok "its server log reads ($(node -e "console.log(JSON.parse(process.argv[1]).lines.length)" "$plg") lines)" || bad "server log: ${plg:0:200}"
    # 8b-4b (D4-11, D4-12): its environment, and monitoring's read of it
    pe=$(prj "{\"op\":\"env-set\",\"id\":\"$SID\",\"branch\":\"main\",\"name\":\"LFDLN_VERIFY\",\"value\":\"s3cret.$$\"}")
    grep -q '"needs":"restart"' <<<"$pe" && ok "a variable set in its environment: a restart uses it" || bad "setting a variable: ${pe:0:200}"
    t_ok "...kept by the helper, root's, 600"                     test "$(stat -c '%U %a' "/var/lib/lfdln-projects/env/$SID.json")" = "root 600"
    t_ok "...its env file svc-lfdln-apps', 600"                    test "$(stat -c '%U %a' "/srv/lfdln-projects/$SID/env/main.env")" = "$SVC_APPS 600"
    names=$(prj '{"op":"list"}'; prj "{\"op\":\"env\",\"id\":\"$SID\",\"branch\":\"main\"}")
    [[ $names == *LFDLN_VERIFY* && $names != *s3cret.$$* ]] && ok "...its name listed, its value never" || bad "the list and the names: ${names:0:200}"
    prr=$(prj "{\"op\":\"control\",\"id\":\"$SID\",\"branch\":\"main\",\"action\":\"restart\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    read -r slot4 port4 _ <<<"$(live_of)"
    cid4=proj-$SID-main-$([[ $slot4 == 0 ]] && echo a || echo b)
    [[ $(jstate "$prr") == done ]] && ok "restarted, and it answers" || bad "restart: $(jstate "$prr")"
    t_ok "...the server has the variable"                          sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman exec $cid4 printenv LFDLN_VERIFY | grep -qx s3cret.$$"
    phe=$(prj '{"op":"health"}')
    node -e "const s=JSON.parse(process.argv[1]).servers.find((x)=>x.project===process.argv[2]&&x.branch==='main'); process.exit(s&&s.active==='active'&&s.answering&&s.answering.status<500?0:1)" "$phe" "$SID" \
        && ok "monitoring's read (health): it runs and answers on :$port4" || bad "health: ${phe:0:200}"
    prb=$(prj "{\"op\":\"rollback\",\"id\":\"$SID\",\"branch\":\"main\",\"release\":\"$sfirst\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    read -r slot3 port3 _ <<<"$(live_of)"
    [[ $(jstate "$prb") == done && $slot3 == 0 && $(up_port) == "$port3" ]] && ok "rolled back: the first release's image, back in slot a" || bad "roll back a server: $(jstate "$prb")"
    t_ok "...it answers"                                           curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$port3/"
    # S1d: a project as an older release left it (slirp4netns, 10.0.2.2) is moved by refresh,
    # unless a variable names 10.0.2.2 in a way refresh doesn't know: then kept, and named
    QA=/var/lib/$SVC_APPS/.config/containers/systemd/proj-$SID-main-a.container
    sed -i 's|^Network=.*|Network=slirp4netns:allow_host_loopback=true|' "$QA"
    refresh_mine() { node -e "const r=JSON.parse(process.argv[1]).job.result; const m=r.projects.find((x)=>x.project===process.argv[2]); console.log(m ? [m.result, m.env.join(','), (m.left||[]).join(',')].join(' ') : 'none')" "$1" "$SID" 2>/dev/null; }
    prj "{\"op\":\"env-set\",\"id\":\"$SID\",\"branch\":\"main\",\"name\":\"DATABASE_URL\",\"value\":\"postgres://u:p@10.0.2.2:$P_APPDB/d\"}" >/dev/null
    prj "{\"op\":\"env-set\",\"id\":\"$SID\",\"branch\":\"main\",\"name\":\"OTHER_URL\",\"value\":\"http://u:p@10.0.2.2:3046/\"}" >/dev/null
    pre=$(prj '{"op":"refresh","actor":"verify-lfdln","wait":true}')
    [[ $(jstate "$pre") == done && $(refresh_mine "$pre") == 'kept  OTHER_URL' ]] && ok "refresh: 10.0.2.2 left in OTHER_URL (the panel's port): kept on slirp4netns, named" || bad "refresh, kept: $(jstate "$pre") ($(refresh_mine "$pre"))"
    t_ok "...its Quadlet untouched"                                grep -qx 'Network=slirp4netns:allow_host_loopback=true' "$QA"
    t_ok "...its env file untouched"                               grep -qx "DATABASE_URL=postgres://u:p@10.0.2.2:$P_APPDB/d" "/srv/lfdln-projects/$SID/env/main.env"
    prj "{\"op\":\"env-set\",\"id\":\"$SID\",\"branch\":\"main\",\"name\":\"OTHER_URL\",\"value\":null}" >/dev/null
    pre=$(prj '{"op":"refresh","actor":"verify-lfdln","wait":true}')
    read -r slot5 port5 _ <<<"$(live_of)"
    [[ $(jstate "$pre") == done && $(refresh_mine "$pre") == 'redeployed DATABASE_URL ' && $slot5 == 1 ]] && ok "refresh: put live again on pasta, in slot b, its DATABASE_URL at 127.0.0.1" || bad "refresh: $(jstate "$pre") ($(refresh_mine "$pre"), slot $slot5)"
    t_ok "...it answers"                                           curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$port5/"
    t_ok "...its Quadlet is pasta's, with the shared env file"     sh -c "grep -q '^Network=pasta:' /var/lib/$SVC_APPS/.config/containers/systemd/proj-$SID-main-b.container && grep -qx 'EnvironmentFile=/srv/lfdln-projects/$SID/env/main.env' /var/lib/$SVC_APPS/.config/containers/systemd/proj-$SID-main-b.container" 
    t_no "...no env file of the new slot left"                     test -e "/srv/lfdln-projects/$SID/env/main.env.next"
    t_ok "...its DATABASE_URL at 127.0.0.1"                        sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman exec proj-$SID-main-b printenv DATABASE_URL | grep -qx 'postgres://u:p@127.0.0.1:$P_APPDB/d'"
    pre2=$(prj '{"op":"refresh","actor":"verify-lfdln","wait":true}')
    [[ $(refresh_mine "$pre2") == 'unchanged  ' ]] && ok "...a second refresh leaves it be" || bad "a second refresh: $(refresh_mine "$pre2")"
    # S1f (a): put back (this project alone): slirp4netns again, its DATABASE_URL at 10.0.2.2
    # from refresh's before-copy, slot to slot; then refresh moves it to pasta once more
    t_ok "...refresh kept a before-copy of DATABASE_URL"         node -e "const e=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.exit(e.moved && e.moved.main && e.moved.main.DATABASE_URL && e.moved.main.DATABASE_URL.from.includes('@10.0.2.2:') ? 0 : 1)" "/var/lib/lfdln-projects/env/$SID.json"
    ppb=$(prj "{\"op\":\"put-back\",\"id\":\"$SID\",\"actor\":\"verify-lfdln\",\"wait\":true}")
    read -r slot6 port6 _ <<<"$(live_of)"
    [[ $(jstate "$ppb") == done && $(refresh_mine "$ppb") == 'redeployed DATABASE_URL ' && $slot6 == 0 ]] && ok "put-back (S1f): live again in slot a, its DATABASE_URL at 10.0.2.2" || bad "put-back: $(jstate "$ppb") ($(refresh_mine "$ppb"), slot $slot6)"
    t_ok "...it answers"                                           curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$port6/"
    t_ok "...its Quadlet slirp4netns:allow_host_loopback, as a release before S1d writes it" grep -qx 'Network=slirp4netns:allow_host_loopback=true' "$QA"
    t_ok "...the server has DATABASE_URL at 10.0.2.2"              sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman exec proj-$SID-main-a printenv DATABASE_URL | grep -qx 'postgres://u:p@10.0.2.2:$P_APPDB/d'"
    pe2=$(prj "{\"op\":\"env\",\"id\":\"$SID\",\"branch\":\"main\"}")
    [[ $pe2 == *'"name":"DATABASE_URL","public":false,"oldHost":true'* && $pe2 != *10.0.2.2* ]] && ok "...the Environment page is told DATABASE_URL names 10.0.2.2 (its name, never its value)" || bad "env after put-back: ${pe2:0:300}"
    pre3=$(prj '{"op":"refresh","actor":"verify-lfdln","wait":true}')
    [[ $(refresh_mine "$pre3") == 'redeployed DATABASE_URL ' ]] && grep -q '^Network=pasta:' "/var/lib/$SVC_APPS/.config/containers/systemd/proj-$SID-main-b.container" \
        && ok "...and refresh puts it on pasta again" || bad "refresh after put-back: $(refresh_mine "$pre3")"
else
    bad "making a Next.js server: $(jstate "$ps1")"
fi
psd=$(prj "{\"op\":\"delete\",\"id\":\"$SID\",\"actor\":\"verify-lfdln\",\"wait\":true}")
if [[ $(jstate "$psd") == done ]]; then
    sto=$(node -e "console.log(JSON.parse(process.argv[1]).job.result.trashed)" "$psd")
    left=$(systemctl --user -M "$SVC_APPS@" list-units --all --plain --no-legend "proj-$SID-*" 2>&1)
    [[ -z $left ]] && ok "deleted: no slot runs" || bad "deleted, but systemd still has: ${left:0:200}"
    t_no "...its upstream gone"                                    test -e "$NGX_UP/$SID-main.conf"
    t_no "...its environment's record gone"                        test -e "/var/lib/lfdln-projects/env/$SID.json"
    t_no "...its images gone"                                      sh -c "cd / && runuser -u $SVC_APPS -- env XDG_RUNTIME_DIR=/run/user/$(id -u $SVC_APPS) podman images --format '{{.Repository}}' | grep -qx localhost/proj-$SID"
    rm -rf --one-file-system -- "$sto"
else
    bad "deleting $SID: $(jstate "$psd")"
    rm -f "$NGX_UP/$SID-main.conf"
fi

echo "--- the hosts taken over from their hand-written files (docs/adopt-plan.md V5, V6)"
code_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:443:$ORIGIN_IP" "https://$1$2"; }
head_of() { curl -sS -o /dev/null -D - --max-time 10 --resolve "$1:443:$ORIGIN_IP" "https://$1$2" | tr -d '\r'; }
any=no
# (link:name:folder:domain; Gonsalves's two on gonsalvesfamily.com, docs/domains-hosts-plan.md step 7)
G=gonsalvesfamily.com
# (TutorStar's tutor.lesfleursdelanuit.com was deleted by momolig 2026-09-30: it is on tutorlumi.com, below)
for spec in instastylr:instastylr:instastylr: lesfleursdelanuit:@:home: gonsalves-public:@::$G gonsalves-admin:admin::$G; do
    IFS=: read -r link name folder dom <<<"$spec"
    [[ -e /etc/nginx/sites-enabled/$link ]] && { note "$link: still hand-written (install-lfdln.sh --take-over-host takes it over)"; continue; }
    any=yes
    on=${dom:-lesfleursdelanuit.com}
    host=$([[ $name == @ ]] && echo "$on" || echo "$name.$on")
    file=$([[ -n $dom ]] && echo "domains/$dom/hosts/$name.conf" || echo "hosts/$name.conf")
    t_ok "$host: the panel's block ($file), the hand-written file kept in sites-available" test -f "/etc/nginx/lfdln-hosts/$file" -a -f "/etc/nginx/sites-available/$link"
    where=$([[ -n $dom ]] && echo "(SELECT id FROM panel.domains WHERE name = '$dom')" || echo "(SELECT id FROM panel.domains WHERE home)")
    [[ $(pg "SELECT adopted FROM panel.hosts WHERE name = '$name' AND domain_id = $where" 2>/dev/null) == t ]] && ok "$host: the panel keeps it, adopted" || bad "$host: the panel keeps it, adopted"
    if [[ -n $folder ]]; then
        t_ok "$host: its site folder $folder is $SITES_USER:$SITES_GROUP 2750" test "$(stat -c '%U:%G %a' "$SITES/$folder")" = "$SITES_USER:$SITES_GROUP 2750"
    fi
    if [[ -n $dom ]]; then
        health=$([[ $link == gonsalves-admin ]] && echo /api/health || echo /)
        code=$(code_of "$host" "$health"); [[ $code == 200 ]] && ok "$host$health answers 200 (Gonsalves, through the panel's route)" || bad "$host$health: $code"
        code=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 --resolve "$host:80:$ORIGIN_IP" "http://$host/")
        [[ $code == "301 https://$host/" ]] && ok "...http goes to https" || bad "http://$host/: $code"
        # certbot's webroot (7-3): a file put there answers over http, never through the app
        probe=zz-verify-$$
        if install -d -m 755 "$ACME_ROOT/.well-known/acme-challenge" 2>/dev/null && echo "$probe" > "$ACME_ROOT/.well-known/acme-challenge/$probe"; then
            got=$(curl -sS --max-time 10 --resolve "$host:80:$ORIGIN_IP" "http://$host/.well-known/acme-challenge/$probe")
            [[ $got == "$probe" ]] && ok "...certbot's challenges are answered from $ACME_ROOT" || bad "the challenge path on $host: ${got:0:80}"
            rm -f "$ACME_ROOT/.well-known/acme-challenge/$probe"
        else bad "can't write a challenge into $ACME_ROOT"; fi
        if [[ $link == gonsalves-public ]]; then
            code=$(code_of "www.$host" /); [[ $code == 200 ]] && ok "...and www too" || bad "www.$host/: $code"
            # a media file from disk (7-2): cached for good
            f=
            for d in site-media gedcom-admin; do
                f=$(find "/mnt/storage/uploads/$d" -type f ! -name '.*' -printf '%P\n' 2>/dev/null | grep -E '^[A-Za-z0-9._/~-]+$' | head -1)
                [[ -n $f ]] && break
            done
            if [[ -n $f ]]; then
                h=$(head_of "$host" "/uploads/$d/$f")
                [[ $h == "HTTP/"*" 200"* ]] && grep -qi '^cache-control:.*public, immutable' <<<"$h" && ok "...a media file from disk (/uploads/$d/), cached for good" || bad "/uploads/$d/$f: ${h%%$'\n'*}"
            else note "no media file to ask for"; fi
        fi
        continue
    fi
    case $name in
        instastylr)
            code=$(code_of "$host" /); [[ $code == 200 ]] && ok "$host/ answers 200" || bad "$host/: $code"
            head_of "$host" / | grep -qi "^content-security-policy: default-src 'self'" && ok "...with its strict CSP" || bad "$host/ has no CSP"
            a=$(ls "$SITES/instastylr/assets" 2>/dev/null | head -1)
            [[ -n $a ]] && head_of "$host" "/assets/$a" | grep -qi '^cache-control: public, immutable' && ok "...its assets cached for good" || bad "$host/assets/$a isn't cached for good"
            code=$(code_of "$host" /.env); [[ $code == 403 ]] && ok "...and a hidden path refused (403)" || bad "$host/.env: $code" ;;
        @)
            # (its front page since 2026-09-30, home/index.html; before it, 403 with no index.html)
            code=$(code_of "$host" /); [[ $code == 200 || ( $code == 403 && ! -e $SITES/home/index.html ) ]] \
                && ok "$host/ answers $code ($([[ -e $SITES/home/index.html ]] && echo 'its index.html' || echo 'no index.html, as before'))" || bad "$host/: $code"
            code=$(code_of "$host" /stefanie/); [[ $code == 200 ]] && ok "...its /stefanie/ 200" || bad "$host/stefanie/: $code"
            code=$(code_of "www.$host" /stefanie/); [[ $code == 200 ]] && ok "...and www's too" || bad "www.$host/stefanie/: $code"
            code=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 --resolve "$host:80:$ORIGIN_IP" "http://$host/")
            [[ $code == "301 https://$host/" ]] && ok "...and http goes to https" || bad "http://$host/: $code" ;;
    esac
done
[[ $any == yes ]] || note "no host taken over yet"
# TutorStar on tutorlumi.com (docs/phase8-plan.md; hosts 7-6): Cloudflare's origin certificate,
# which curl can't check from here (-k), through the panel's route
TL=tutorlumi.com
for h in $TL www.$TL; do
    code=$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$h:443:$ORIGIN_IP" "https://$h/")
    [[ $code == 200 ]] && ok "$h/ answers 200 (TutorStar, through the panel's route)" || bad "$h/: $code"
done
codes=$(for i in 1 2 3 4 5 6; do curl -ksS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$TL:443:$ORIGIN_IP" "https://$TL/api/auth/sign-in/zz-verify-$$"; echo; done | tr '\n' ' ')
[[ $codes == *503* ]] && ok "...its sign-in path is rate-limited ($codes)" || note "$TL: its sign-in path isn't rate-limited ($codes; the route has no sign-in paths)"

echo "--- Cloudflare in front (docs/security-performance-review.md S6): the visitor's own address"
# A domain whose row says Cloudflare is in front: every block of it includes the real-IP file,
# so the logs, limit_req and X-Real-IP see the visitor. Proved with two requests each: one
# straight to this server naming another address (CF-Connecting-IP: 203.0.113.9, ignored),
# one through Cloudflare (this server's own address, never Cloudflare's). Plain GETs of a
# path nobody has, read back from the access log.
HD=/etc/nginx/lfdln-hosts RIP=/etc/nginx/lfdln-hosts/cloudflare-realip.conf ALOG=/var/log/nginx/lfdln-hosts.access.log
if [[ -L /etc/nginx/sites-enabled/lfdln-hosts ]]; then
    n=$(grep -c '^set_real_ip_from ' "$RIP" 2>/dev/null)
    [[ ${n:-0} -ge 10 ]] && grep -qx 'real_ip_header CF-Connecting-IP;' "$RIP" && ! grep -qE '^set_real_ip_from (127\.|10\.|192\.168\.|::1|0\.0\.0\.0)' "$RIP" \
        && ok "the real-IP file trusts Cloudflare's $n ranges, nothing else" || bad "$RIP: ${n:-no} ranges, or something that isn't Cloudflare's"
    own=" $(hostname -I) "
    seen_ip() { sleep 1; grep -F " $1 " "$ALOG" 2>/dev/null | tail -1 | cut -d' ' -f1; }
    cf=$(pg_as panel -c "SELECT name FROM panel.domains WHERE front = 'cloudflare' ORDER BY name" 2>/dev/null)
    for dom in $cf; do
        files=$( [[ $(pg_as panel -c "SELECT home FROM panel.domains WHERE name = '$dom'") == t ]] && ls "$HD"/hosts/*.conf "$HD/catch-all.conf" 2>/dev/null || ls "$HD/domains/$dom"/hosts/*.conf "$HD/domains/$dom/catch-all.conf" 2>/dev/null)
        miss=$(for f in $files; do [[ $(grep -c '^server {' "$f") == $(grep -c "include $RIP;" "$f") ]] || echo "${f#$HD/}"; done)
        [[ -n $files && -z $miss ]] && ok "$dom: every block includes it ($(wc -w <<<"$files") file(s))" || bad "$dom: blocks without the real-IP file: ${miss:-no files}"
        p="/zz-verify-s6-$$-direct"
        curl -ksS -o /dev/null --max-time 10 -H 'CF-Connecting-IP: 203.0.113.9' --resolve "$dom:443:$ORIGIN_IP" "https://$dom$p" >/dev/null 2>&1
        ip=$(seen_ip "$p")
        [[ -n $ip && $ip != 203.0.113.9 ]] && ok "...straight to this server, CF-Connecting-IP is ignored (logged as $ip)" || bad "$dom: a request straight here was logged as '${ip:-nothing}'"
        p="/zz-verify-s6-$$-cloudflare"
        if curl -ksS -o /dev/null --max-time 15 "https://$dom$p" >/dev/null 2>&1; then
            ip=$(seen_ip "$p")
            [[ -n $ip && $own == *" $ip "* ]] && ok "...through Cloudflare, the visitor's own address (this server's, $ip)" || bad "$dom: a request through Cloudflare was logged as '${ip:-nothing}', not this server's ($own)"
        else note "$dom: couldn't go through Cloudflare from here; that half wasn't checked"; fi
    done
    [[ -n $cf ]] || note "no domain has Cloudflare in front"
    direct=$(for f in "$HD"/hosts/*.conf "$HD/catch-all.conf"; do grep -l "cloudflare-realip" "$f"; done 2>/dev/null)
    [[ $(pg_as panel -c "SELECT front FROM panel.domains WHERE home") == direct && -n $direct ]] && bad "the home domain has nothing in front, but these include the real-IP file: $direct" || ok "a domain with nothing in front doesn't include it"
fi

echo "--- the hosts' checks (docs/domains-hosts-plan.md step 3: DNS, certificate, answers; read-only)"
if [[ -L /etc/nginx/sites-enabled/lfdln-hosts ]]; then
    checks=$(lnode "
      import { callJsonLine } from '@panel/core/jsonline';
      const r = await callJsonLine('/run/lfdln-routes.sock', { op: 'check', front: 'direct', again: true, hosts: [{ name: '@', withWww: true }, { name: 'zz-nobody-$$' }] }, 'routing helper', 150000);
      for (const c of r.checks) console.log([c.name, c.dns?.ok, c.cert?.ok, c.answers?.ok, c.answers?.status, c.cert?.daysLeft].join(' '));" 2>&1)
    for n in lesfleursdelanuit.com www.lesfleursdelanuit.com; do
        line=$(grep "^$n " <<<"$checks")
        [[ $line == "$n true true true "* ]] && ok "$n: DNS points here, the wildcard covers it, it answers (${line##* } days left)" || bad "$n: ${line:-no answer from the checks: $checks}"
    done
    # a name nobody made: the wildcard record brings it here, the catch-all answers (404)
    line=$(grep "^zz-nobody-$$" <<<"$checks")
    [[ $line == "zz-nobody-$$.lesfleursdelanuit.com true true true 404 "* ]] && ok "a name nobody made: here through the wildcard record, the catch-all's 404" || bad "zz-nobody-$$: ${line:-$checks}"
    # the panel's own domain through the setup guide's checks (docs/domains-hosts-plan.md step 4): every one green
    dom=$(lnode "
      import { callJsonLine } from '@panel/core/jsonline';
      const w = '/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com';
      const r = await callJsonLine('/run/lfdln-routes.sock', { op: 'check-domain', domain: 'lesfleursdelanuit.com', dns: 'dreamhost', front: 'direct', wildcardRecord: true,
        tls: { cert: w + '/fullchain.pem', key: w + '/privkey.pem', include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' } }, 'routing helper', 150000);
      for (const c of r.checks) console.log([c.ok, c.key, c.why].join(' '));" 2>&1)
    if [[ -n $dom ]] && ! grep -qv '^true ' <<<"$dom"; then ok "lesfleursdelanuit.com: every check of the setup guide passes ($(wc -l <<<"$dom"): $(awk '{printf "%s%s", (NR > 1 ? ", " : ""), $2}' <<<"$dom"))"
    else bad "lesfleursdelanuit.com's setup-guide checks: $(grep -v '^true ' <<<"$dom" | head -3 | tr '\n' ';')"; fi
fi

echo "--- the apps' database (lfdln-appdb, 127.0.0.1:5436, docs/data-move-plan.md M1)"
source "$D/appdb/lib-appdb.sh"
t_ok "system user $APPDB_SVC exists, no login shell, NOT in sudo" sh -c "test \"\$(getent passwd $APPDB_SVC | cut -d: -f7)\" = /usr/sbin/nologin && ! id -nG $APPDB_SVC | tr ' ' '\n' | grep -qx sudo"
t_ok "its home is 700 and its own"                      test "$(stat -c '%U %a' "$APPDB_HOME")" = "$APPDB_SVC 700"
t_ok "the container is running"                         test "$(appdb_ctl is-active "$APPDB_CONTAINER.service")" = active
t_ok "it listens on 127.0.0.1 only"                     sh -c "ss -ltnH 'sport = :$APPDB_PORT' | awk '{print \$4}' | grep -qx '127.0.0.1:$APPDB_PORT' && ! ss -ltnH 'sport = :$APPDB_PORT' | awk '{print \$4}' | grep -vqx '127.0.0.1:$APPDB_PORT'"
[[ $(echo 'SHOW timezone' | appdb_super 2>/dev/null) == Europe/Berlin ]] && ok "in Berlin time, as the server's own Postgres" || bad "its time zone isn't Europe/Berlin"
live=$(echo 'SHOW server_version' | appdb_super 2>/dev/null); engine_series Postgres "${live%% *}" "$D/appdb/quadlet/lfdln-appdb.container"
for r in "${APPDB_ROLES[@]}"; do
    t_ok "$r's password file is root's, 600"            test "$(stat -c '%U %a' "$APPDB_PASS/$r.pass")" = "root 600"
done
attrs=$(echo "SELECT string_agg(rolname || ':' || rolcanlogin || rolcreatedb || rolsuper || rolcreaterole, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('tutorstar', 'ligneous_user', 'gonsalves_readonly')" | appdb_super 2>/dev/null)
[[ $attrs == 'gonsalves_readonly:truefalsefalsefalse ligneous_user:truetruefalsefalse tutorstar:truefalsefalsefalse' ]] && ok "the apps' roles, as on :5432 (ligneous_user may make databases)" || bad "roles: $attrs"
t_no "nobody may connect to its own database 'postgres'" sh -c "PGPASSWORD=\$(cat $APPDB_PASS/tutorstar.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $APPDB_PORT -U tutorstar -d postgres -c 'SELECT 1'"
t_no "the panel's password doesn't open it"             sh -c "PGPASSWORD=\$(cat $PASS_DIR/panel.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $APPDB_PORT -U pammy_panel -d tutorstar -c 'SELECT 1'"
t_no "and its roles don't open the panel's (5435)"      sh -c "PGPASSWORD=\$(cat $APPDB_PASS/ligneous_user.pass) PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p $PG_PORT -U ligneous_user -d lfdln -c 'SELECT 1'"
# tutorstar was copied with plain de-DE (2026-09-25); copies since sort as :5432 does, ka-shifted (49d9f79)
for db in tutorstar:de-DE ligneous_frontend:de-DE-u-ka-shifted; do
    loc=${db#*:}; db=${db%%:*}
    if [[ $(echo "SELECT 1 FROM pg_database WHERE datname = '$db'" | appdb_super 2>/dev/null) == 1 ]]; then
        got=$(echo "SELECT datlocprovider::text || ' ' || datlocale FROM pg_database WHERE datname = '$db'" | appdb_super)
        [[ $got == "i $loc" ]] && ok "$db is here, sorting German (ICU $loc)" || bad "$db's collation: $got, not ICU $loc"
        [[ $(echo "SELECT has_database_privilege('public', '$db', 'CONNECT')" | appdb_super) == f ]] && ok "...PUBLIC may not connect to it" || bad "PUBLIC may connect to $db"
    else
        note "$db isn't here yet (move-db.sh ${db/ligneous_frontend/gonsalves} copy)"
    fi
done
# the projects' databases (apps.sql): Placement Exam Prep's
for r in "${APPDB_APP_ROLES[@]}"; do
    t_ok "$r's password file is root's, 600"            test "$(stat -c '%U %a' "$APPDB_PASS/$r.pass")" = "root 600"
done
attrs=$(echo "SELECT string_agg(rolname || ':' || rolcanlogin || rolcreatedb || rolsuper || rolcreaterole || rolbypassrls, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'examprep\_%'" | appdb_super 2>/dev/null)
[[ $attrs == 'examprep_app:truefalsefalsefalsefalse examprep_owner:truefalsefalsefalsefalse' ]] && ok "exam prep's roles log in and nothing more" || bad "exam prep's roles: $attrs"
[[ $(echo "SELECT datlocprovider::text || ' ' || datlocale || ' ' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'examprep'" | appdb_super 2>/dev/null) == 'i de-DE examprep_owner' ]] \
    && ok "examprep is here, examprep_owner's, sorting German (ICU de-DE)" || bad "the examprep database is missing, or not examprep_owner's, or not ICU de-DE"
[[ $(echo "SELECT has_database_privilege('public', 'examprep', 'CONNECT')" | appdb_super 2>/dev/null) == f ]] && ok "...PUBLIC may not connect to it" || bad "PUBLIC may connect to examprep"
t_ok "...examprep_app connects to it with its password" appdb_as examprep_app examprep -c 'SELECT 1'
t_no "...and may make nothing there"                    appdb_as examprep_app examprep -c 'CREATE TABLE public.verify_x (a int)'
t_no "...nor open TutorStar's database"                 appdb_as examprep_app tutorstar -c 'SELECT 1'
t_no "and TutorStar's role doesn't open examprep"       appdb_as tutorstar examprep -c 'SELECT 1'
t_ok "the nightly backup timer is on"                   test "$(appdb_ctl is-enabled lfdln-appdb-backup.timer 2>/dev/null)" = enabled
# where each app's data is (M7): what the Services page says, and its secrets agree
secret_url() {  # secret_url <user> <secret>: its host:port/database, never its password
    local uid; uid=$(id -u "$1")
    (cd / && runuser -u "$1" -- env XDG_RUNTIME_DIR="/run/user/$uid" HOME="$(getent passwd "$1" | cut -d: -f6)" podman secret inspect --showsecret "$2" 2>/dev/null) \
        | python3 -c 'import json, re, sys; m = re.search(r"@([^/@\s]+/[A-Za-z0-9_]+)", json.load(sys.stdin)[0]["SecretData"]); print(m[1] if m else "-")' 2>/dev/null || echo "-"
}
for a in tutorstar:tutorstar:svc-tutorstar:tutorstar-db-url gonsalves:ligneous_frontend:svc-ligneous:ligneous-db-url,ligneous-db-url-public; do
    IFS=: read -r svc db user secrets <<<"$a"
    engine=$(python3 -c "import json, sys; print(json.load(open('/var/lib/lfdln-services/databases.json')).get('$svc', {}).get('engine', 'server'))" 2>/dev/null || echo server)
    # on pasta (S1f, to-pasta.sh) its containers reach the engine at their own 127.0.0.1
    host=10.0.2.2; [[ -e /var/lib/svc-lfdlnappdb/moves/$svc.pasta ]] && host=127.0.0.1
    if [[ $engine == lfdln-appdb ]]; then want="$host:$APPDB_PORT/$db"; else want="$host:5432/$db"; fi
    for sec in ${secrets//,/ }; do
        got=$(secret_url "$user" "$sec")
        [[ $got == "$want" ]] && ok "$svc's secret $sec points at $want, where the Services page says its data is" || bad "$svc's secret $sec points at $got, not $want"
    done
    if [[ $svc == gonsalves ]]; then   # sync-podman-secrets.sh makes the secrets again from these
        for sec in ${secrets//,/ }; do
            f=/var/lib/svc-ligneous/.config/containers/systemd/$sec
            if [[ ! -f $f ]]; then note "...no file $sec (for sync-podman-secrets.sh)"
            elif grep -q "@$want\([^A-Za-z0-9_]\|$\)" "$f"; then ok "...its file $sec (for sync-podman-secrets.sh) says $want too"
            else bad "the file $f doesn't say $want: a sync would point $svc elsewhere"; fi
        done
    fi
    if [[ $engine == lfdln-appdb ]]; then
        [[ $(cd / && runuser -u postgres -- psql -X -qtA -d "$db" -c 'SHOW default_transaction_read_only' 2>/dev/null) == on ]] \
            && ok "...and $db on :5432 is read-only, the way back (move-db.sh $svc back)" || bad "$db on :5432 takes writes, though $svc uses lfdln-appdb"
    else
        note "$svc's data is still on :5432 (move-db.sh $svc switch moves it)"
    fi
done

echo "--- mail (lfdln-mail: lfdln's emails through Resend, docs/accounts-plan.md step 2; sends nothing here)"
MAILU=svc-lfdlnmail
MSOCK=/run/lfdln-mail.sock
mask() {  # mask <user> <json> -- ask the mail service; prints its answer
    local user=$1 req=$2
    (cd "$APP" && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callMail } from '@panel/mail/mail/client';
      console.log(JSON.stringify(await callMail('$MSOCK', $req)));")
}
t_ok "system user $MAILU exists, no login shell"      test "$(getent passwd "$MAILU" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$MAILU is NOT in sudo"                           sh -c "id -nG $MAILU | tr ' ' '\n' | grep -qx sudo"
t_ok "socket is root:$SVC 660"                        test "$(stat -c '%U:%G %a' "$MSOCK")" = "root:$SVC 660"
t_ok "the panel's user can ask it"                    mask "$SVC" '{"op":"status"}'
for u in svc-pammypanel www-data momolig "$SITES_USER" svc-lfdln-apps; do
    id "$u" >/dev/null 2>&1 && t_no "$u can't ask it" can_open "$u" "$MSOCK"
done
t_ok "the key file is root's, 600"                    test "$(stat -c '%U %a' /etc/lfdln-mail/resend.key)" = "root 600"
t_ok "the settings are root's, 644"                   test "$(stat -c '%U %a' /etc/lfdln-mail/settings.json)" = "root 644"
t_no "it can't read the key file itself"              runuser -u "$MAILU" -- cat /etc/lfdln-mail/resend.key
t_ok "it gets the key through LoadCredential"         sh -c "systemctl cat lfdln-mail | grep -q '^LoadCredential=resend.key:/etc/lfdln-mail/resend.key'"
mpid=$(systemctl show -p MainPID --value lfdln-mail)
if [[ $mpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$mpid" | tr -d ' ') == "$(id -u "$MAILU")" ]] && ok "runs as $MAILU" || bad "runs as uid $(ps -o uid= -p "$mpid" | tr -d ' ')"
    [[ $(grep '^CapBnd' "/proc/$mpid/status" | awk '{print $2}') == 0000000000000000 ]] && ok "it has no Linux capabilities" || bad "lfdln-mail has capabilities"
    t_ok "inside its sandbox: /var/www is blocked (the site folders)" test "$(nsenter -t "$mpid" -m -- stat -c %a /var/www)" = 0
    t_ok "inside its sandbox: /var/lib is blocked (the panel's data)" test "$(nsenter -t "$mpid" -m -- stat -c %a /var/lib)" = 0
    t_ok "inside its sandbox: pammy.org's mail settings and key are blocked" test "$(nsenter -t "$mpid" -m -- stat -c %a /etc/pammy-mail)" = 0
    t_no "inside its sandbox: nothing is writable"         nsenter -t "$mpid" -m -- sh -c 'touch /etc/.lfdln-probe && rm -f /etc/.lfdln-probe'
else
    bad "the mail service isn't running after being asked"
fi
ms=$(mask "$SVC" '{"op":"status"}' 2>/dev/null || echo '{}')
if grep -q '"ready":true' <<<"$ms"; then
    ok "it is ready to send, from $(sed -n 's/.*"from":"\([^"]*\)".*/\1/p' <<<"$ms") to $(sed -n 's/.*"notifyTo":"\([^"]*\)".*/\1/p' <<<"$ms")"
    grep -q '"visitorPerDay":40' <<<"$ms" && ok "visitor emails kept to 40 a day (one Resend account with pammy.org)" || bad "visitor limit: $ms"
else
    note "mail isn't ready yet: $(sed -n 's/.*"why":"\([^"]*\)".*/\1/p' <<<"$ms")"
fi
# what it refuses, without sending anything: checked before Resend is ever asked
t_no "it won't send a visitor email that links off the site" \
     mask "$SVC" '{"op":"visitor","kind":"reset","to":"nobody@example.org","link":"https://evil.example/_pammy/reset"}'
t_no "nor to something that isn't one address" \
     mask "$SVC" '{"op":"visitor","kind":"deleted","to":"a@example.org, b@example.org"}'
note "not tried here, because it sends email: sudo lfdln-panel mail-samples (one of each visitor email, to the notice address)"
# the gate's door (docs/accounts-plan.md step 4): visitor emails only, and only the gate's user
MVSOCK=/run/lfdln-mail-visitor.sock
mvask() {  # mvask <user> <json> -- ask the gate's door to the mail service
    local user=$1 req=$2
    (cd "$APP" && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callMail } from '@panel/mail/mail/client';
      console.log(JSON.stringify(await callMail('$MVSOCK', $req)));")
}
t_ok "the gate's door is root:svc-lfdlngate 660"       test "$(stat -c '%U:%G %a' "$MVSOCK")" = "root:svc-lfdlngate 660"
t_ok "the gate's user can open it"                    can_open svc-lfdlngate "$MVSOCK"
for u in "$SVC" svc-pammypanel svc-pammygate www-data momolig "$SITES_USER" svc-lfdln-apps; do
    id "$u" >/dev/null 2>&1 && t_no "$u can't open the gate's door" can_open "$u" "$MVSOCK"
done
t_no "the gate can't open the panel's door"           can_open svc-lfdlngate "$MSOCK"
mv=$(mvask svc-lfdlngate '{"op":"test"}' 2>&1)
grep -q 'Unknown request' <<<"$mv" && ok "behind the gate's door: no test email, no notices (visitor emails only)" || bad "the gate's door answered a test: $(head -c 200 <<<"$mv")"
t_no "...and no visitor email that links off the site" \
     mvask svc-lfdlngate '{"op":"visitor","kind":"reset","to":"nobody@example.org","link":"https://evil.example/_pammy/reset"}'
score=$(systemd-analyze security lfdln-mail --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "mail service exposure rating: ${score#→ }"

echo "--- the gate (lfdln-gate: visitor accounts, docs/accounts-plan.md steps 3-4; accounts on routes, docs/roles-plan.md step 5)"
GATEU=svc-lfdlngate
GATE_PORT=3047
t_ok "system user $GATEU exists, no login shell"      test "$(getent passwd "$GATEU" | cut -d: -f7)" = /usr/sbin/nologin
t_no "$GATEU is NOT in sudo, $SITES_GROUP or www-data permanently" sh -c "id -nG $GATEU | tr ' ' '\n' | grep -qxE 'sudo|$SITES_GROUP|www-data'"
t_ok "its home is 700 and its own"                   test "$(stat -c '%U %a' /var/lib/$GATEU)" = "$GATEU 700"
t_ok "running, starts at boot"                        sh -c "systemctl is-active -q lfdln-gate && systemctl is-enabled -q lfdln-gate"
# X-Real-IP only from nginx (docs/s1-plan.md S1c)
source "$D/../verify-edge.sh"
verify_edge /etc/lfdln-panel /etc/nginx/lfdln-panel lfdln-panel "$PORT" lfdln-gate "$GATE_PORT" "$HOST" lesfleursdelanuit.com
t_ok "listens on 127.0.0.1:$GATE_PORT only"           sh -c "ss -ltnH 'sport = :$GATE_PORT' | awk '{print \$4}' | sort -u | grep -qx 127.0.0.1:$GATE_PORT"
t_ok "a check without nginx's headers is refused (403: it fails closed)" \
     test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$GATE_PORT/check)" = 403
t_ok "admin socket is root:$SVC 660"                  test "$(stat -c '%U:%G %a' "$GSOCK")" = "root:$SVC 660"
gs=$(gask "$SVC" '{"op":"state"}' 2>/dev/null || echo '{}')
grep -q '"areas":\[' <<<"$gs" && ok "the panel's user can ask it (it reached its database)" || bad "the gate's state: $gs"
for u in svc-pammypanel pamela www-data momolig "$SITES_USER" svc-lfdln-apps; do
    id "$u" >/dev/null 2>&1 && t_no "$u can't ask it" can_open "$u" "$GSOCK"
done
t_no "it refuses what lfdln has switched off (the examples)" gask "$SVC" '{"op":"examples.state"}'
vs=$(gask "$SVC" '{"op":"visitor-settings.get"}' 2>/dev/null || echo '{}')
sw=$(grep -o '"switches":{[^}]*}' <<<"$vs")
if [[ -z $sw ]]; then bad "the gate's visitor settings: $(head -c 200 <<<"$vs")"
elif grep -q 'true' <<<"$sw"; then note "visitor switches on: $sw"
else ok "every visitor switch is off"; fi
grep -q '"gateMail":true' <<<"$vs" && ok "it has its door to the mail service (emailed links can go on)" || bad "the gate has no door to the mail service: $(head -c 200 <<<"$vs")"
# accounts (docs/accounts-plan.md step 4), asked the way nginx would, on a made-up host:
# with the switches off, the account pages answer 404 as before; who is signed in, nobody
GH=zz-accounts-verify.lesfleursdelanuit.com
gcurl() { curl -s --max-time 5 -H "Host: $GH" -H 'X-Pammy-Base: /' -H 'X-Real-IP: 192.0.2.7' "$@"; }
t_ok "who is signed in there: nobody"                 sh -c "curl -s --max-time 5 -H 'Host: $GH' http://127.0.0.1:$GATE_PORT/_pammy/me | grep -q '\"signedIn\":false'"
acc=$(gcurl "http://127.0.0.1:$GATE_PORT/_pammy/accounts")
if [[ -z $sw ]] || grep -q 'true' <<<"$sw"; then note "what the account pages offer: $acc"
else
    [[ $acc == '{"register":false,"emailedLinks":false,"changePassword":false,"deleteAccount":false}' ]] && ok "the account pages offer nothing: $acc" || bad "/_pammy/accounts: $acc"
    for p in register confirm reset account; do
        c=$(gcurl -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATE_PORT/_pammy/$p")
        [[ $c == 404 ]] && ok "/_pammy/$p isn't there (404, every switch off)" || bad "/_pammy/$p -> $c"
    done
    c=$(gcurl -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://$GH" -H 'Content-Type: application/json' --data '{"username":"zz","email":"zz@example.org","password":"zz-verify-password"}' "http://127.0.0.1:$GATE_PORT/_pammy/register")
    [[ $c == 404 ]] && ok "nobody can register (404)" || bad "POST /_pammy/register -> $c"
fi
# (once momolig turns the switches on, people register: then it's only said how many)
reg=$(pg_as gate -c "SELECT (SELECT count(*) FROM gate.visitors WHERE registered) || ' ' || (SELECT count(*) FROM gate.links WHERE purpose <> 'setup')")
if [[ -n $sw ]] && ! grep -q 'true' <<<"$sw"; then
    [[ $reg == '0 0' ]] && ok "no registered account, no emailed link" || bad "registered accounts / emailed links with every switch off: $reg"
else
    note "registered accounts, emailed links: $reg"
fi
# accounts on routes (docs/roles-plan.md step 5): the gate's areas, the routes' tokens and
# nginx's files all say the same, and every service route clears what a visitor might send
t_ok "no protected folder (lfdln's accounts are on routes)" test "$(pg_as gate -c "SELECT count(*) FROM gate.areas WHERE kind = 'folder'")" = 0
t_ok "the built-in \"Open with accounts\" set: anyone opens the pages, everyone signed in is Member" test "$(pg_as gate -c "
  SELECT s.label || '|' || r.key || '|' || (SELECT string_agg(p.privilege, ' ') FROM gate.role_all_privileges p JOIN gate.roles n ON n.id = p.role_id WHERE n.role_set_id = s.id AND n.slot = 'not-signed-in')
    FROM gate.role_sets s JOIN gate.roles r ON r.id = s.signed_in_role_id WHERE s.key = 'open-with-accounts'")" = 'Open with accounts|member|pages.read'
gate_tokens=$(pg_as gate -c "SELECT coalesce(string_agg(token, ' ' ORDER BY token), '') FROM gate.areas WHERE kind = 'route'")
route_tokens=$(pg_as panel -c "SELECT coalesce(string_agg(area_token, ' ' ORDER BY area_token), '') FROM panel.routes WHERE area_token IS NOT NULL")
[[ $gate_tokens == "$route_tokens" ]] && ok "every route with accounts has its area in the gate, and no area is left over ($(wc -w <<<"$route_tokens"))" \
    || bad "the gate's route areas ($gate_tokens) and the routes' ($route_tokens) differ"
live_tokens=$(pg_as panel -c "SELECT coalesce(string_agg(r.area_token, ' ' ORDER BY r.area_token), '') FROM panel.routes r JOIN panel.hosts h ON h.id = r.host_id WHERE r.area_token IS NOT NULL AND r.enabled AND h.enabled")
nginx_tokens=$(grep -rhoE 'auth_request /_pammy/check/[A-Za-z0-9_-]{32}' /etc/nginx/lfdln-hosts 2>/dev/null | awk -F/ '{print $NF}' | sort -u | tr '\n' ' ' | sed 's/ $//')
[[ $nginx_tokens == "$live_tokens" ]] && ok "nginx asks the gate for exactly the routes with accounts that are switched on" || bad "nginx asks for ($nginx_tokens), the routes say ($live_tokens)"
t_no "nothing else in nginx sends to it"            sh -c "grep -rhs '$GATE_PORT' /etc/nginx/lfdln-hosts /etc/nginx/sites-enabled/lfdln-panel | grep -vqE 'proxy_pass http://127\.0\.0\.1:$GATE_PORT(/check/)?;'"
svc=$(grep -rhc 'proxy_set_header X-Forwarded-Proto' /etc/nginx/lfdln-hosts/hosts 2>/dev/null | awk '{s+=$1} END {print s+0}')
for h in Account Username Role Privileges Proof; do
    n=$(grep -rhc "proxy_set_header X-Lfdln-$h " /etc/nginx/lfdln-hosts/hosts 2>/dev/null | awk '{s+=$1} END {print s+0}')
    [[ ${n:-0} == "${svc:-0}" ]] || { bad "X-Lfdln-$h is set in $n of the $svc service locations"; continue; }
    [[ $h == Proof ]] && ok "every service location ($svc) sets the four X-Lfdln- headers and the gate's proof itself: what a visitor sends never reaches an app"
done
# the gate's cookie stays with the gate (docs/s1-plan.md S1e): every location that hands a
# visitor to an app (a service, a project's server, PHP) sends the cookies without it
t_ok "site.conf takes the gate's cookie out of what apps get (its two maps)" sh -c "grep -q '^map \$http_cookie \$app_cookie_lfdln_visitor_once {' $HOSTS_DIR/site.conf && grep -q '^map \$app_cookie_lfdln_visitor_once \$app_cookie_lfdln_visitor {' $HOSTS_DIR/site.conf"
# per location block (review F3): a block that goes to an app (proxy_pass anywhere but the
# gate) has exactly one Cookie line, a PHP block exactly one HTTP_COOKIE; counted block by
# block, so one block with two can't make up for one with none, and none at all isn't a pass
cookie_blocks() {
    awk -v gate="127.0.0.1:$GATE_PORT" '
        function close_block(   b) {
            b = sp--
            if (px[b] != "" && px[b] !~ gate) { if (ck[b] == 1) ao++; else { ab++; if (!first) first = FILENAME ":" ln[b] " (" ck[b] " Cookie lines)" } }
            if (fp[b]) { if (fc[b] == 1) po++; else { pb++; if (!first) first = FILENAME ":" ln[b] " (" fc[b] " HTTP_COOKIE lines)" } }
        }
        /\{[^}]*\}[[:space:]]*$/ { next }                       # one-line blocks: a return, an alias
        /\{[[:space:]]*$/ { sp++; px[sp] = ""; ck[sp] = 0; fp[sp] = 0; fc[sp] = 0; ln[sp] = FNR; next }
        /^[[:space:]]*\}[[:space:]]*$/ { if (sp > 0) close_block(); next }
        /^[[:space:]]*proxy_pass /                                   { px[sp] = $2 }
        /^[[:space:]]*proxy_set_header Cookie \$app_cookie_lfdln_visitor;/ { ck[sp]++ }
        /^[[:space:]]*fastcgi_pass /                                 { fp[sp] = 1 }
        /^[[:space:]]*fastcgi_param HTTP_COOKIE /                    { if ($3 == "$app_cookie_lfdln_visitor;") fc[sp]++; else fc[sp] += 100 }
        END { printf "%d %d %d %d %s\n", ao, ab, po, pb, first }
    ' "$HOSTS_DIR"/hosts/*.conf $(ls "$HOSTS_DIR"/domains/*/hosts/*.conf 2>/dev/null)
}
read -r apps_ok apps_bad php_ok php_bad first_bad <<<"$(cookie_blocks)"
if [[ ${apps_bad:-1} == 0 && ${apps_ok:-0} -gt 0 ]]; then ok "every location to an app ($apps_ok) has exactly one Cookie line: the visitor's cookies without the gate's"
elif [[ ${apps_ok:-0} == 0 && ${apps_bad:-0} == 0 ]]; then bad "no location to an app found to check (the host files, or this check, are wrong)"
else bad "$apps_bad location(s) to an app without exactly one Cookie line, first: $first_bad"; fi
if [[ ${php_bad:-1} == 0 && ${php_ok:-0} -gt 0 ]]; then ok "every PHP location ($php_ok) has exactly one HTTP_COOKIE: the cookies without the gate's"
elif [[ ${php_ok:-0} == 0 && ${php_bad:-0} == 0 ]]; then note "no site folder runs PHP: no PHP location to check"
else bad "$php_bad PHP location(s) without exactly one HTTP_COOKIE line, first: $first_bad"; fi
# every location that asks the gate and then goes to an app names the app (docs/s1-plan.md S1a)
t_no "no route to an app asks the gate without naming the app" sh -c "awk '/location /{a=0} /auth_request \/_pammy\/check\/[A-Za-z0-9_-]+;/{a=1} a && /proxy_pass/{f=1} END{exit !f}' /etc/nginx/lfdln-hosts/hosts/*.conf /etc/nginx/lfdln-hosts/domains/*/hosts/*.conf 2>/dev/null"
# the gate on every host (docs/phase8-plan.md 8-2): the routes as it reads them, written by
# the routing helper beside the host files; /_pammy/ on every host, on every domain
GR=/etc/nginx/lfdln-hosts/gate-routes.json
t_ok "gate-routes.json is root's, 644"                test "$(stat -c '%U %a' "$GR" 2>/dev/null)" = "root 644"
gr_names=$(node -e "process.stdout.write(Object.keys(JSON.parse(require('fs').readFileSync('$GR','utf8')).hosts).sort().join(' '))" 2>/dev/null)
ng_names=$(grep -rhE '^\s*server_name ' /etc/nginx/lfdln-hosts/hosts /etc/nginx/lfdln-hosts/domains/*/hosts 2>/dev/null | sed -E 's/^\s*server_name //; s/;$//' | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')
[[ -n $gr_names && $gr_names == "$ng_names" ]] && ok "it names exactly the hosts nginx has ($(wc -w <<<"$gr_names"))" || bad "gate-routes.json ($gr_names) and nginx ($ng_names) differ"
nhost=$(ls /etc/nginx/lfdln-hosts/hosts/*.conf /etc/nginx/lfdln-hosts/domains/*/hosts/*.conf 2>/dev/null | wc -l)
ngate=$(grep -lE '^    location \^~ /_pammy/ \{' /etc/nginx/lfdln-hosts/hosts/*.conf /etc/nginx/lfdln-hosts/domains/*/hosts/*.conf 2>/dev/null | wc -l)
[[ $nhost -gt 0 && $ngate == "$nhost" ]] && ok "every host's file sends /_pammy/ to the gate ($ngate)" || bad "/_pammy/ in $ngate of $nhost host files"
for h in lesfleursdelanuit.com tutorlumi.com gonsalvesfamily.com; do
    t_ok "https://$h/_pammy/login.js is the gate's"  sh -c "curl -ksS --max-time 10 --resolve $h:443:$ORIGIN_IP https://$h/_pammy/login.js | grep -q customElements"
done
# comments on a service's page (docs/phase8-plan.md step 8-6, P8-10): no file, known by its
# address; TutorStar's host (Cloudflare's origin certificate: -k), a page nobody has, the
# comment removed again
SH=tutorlumi.com
cj=$(gask "$SVC" "{\"op\":\"form.create\",\"name\":\"zz-verify-svc-$$\",\"title\":\"verify\",\"kind\":\"comments\",\"actor\":\"verify\"}" 2>/dev/null)
cid=$(grep -o '"id":[0-9]*' <<<"$cj" | head -1 | cut -d: -f2)
if [[ -n $cid ]]; then
    sr=(--resolve "$SH:443:$ORIGIN_IP" --max-time 10 -ksS)
    code=$(curl "${sr[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://$SH" -H 'Content-Type: application/json' \
        --data '{"page":"/zz-verify-page","answers":{"your-name":"verify","your-comment":"verify-lfdln on a service page"}}' "https://$SH/_pammy/comments/zz-verify-svc-$$")
    [[ $code == 200 ]] && ok "a comment sent from a page of TutorStar's ($SH)" || bad "a comment on $SH: $code"
    got=$(pg_as gate -c "SELECT content_id FROM gate.responses WHERE form_id = $cid")
    [[ $got == "https://$SH/zz-verify-page" ]] && ok "...kept on the page's address" || bad "the comment on $SH was kept as: $got"
    curl "${sr[@]}" "https://$SH/_pammy/comments/zz-verify-svc-$$?page=%2Fzz-verify-page" | grep -q "\"content\":\"https://$SH/zz-verify-page\"" \
        && ok "...and the page reads its conversation by that address" || bad "reading the comments on $SH"
    pg_as gate -c "DELETE FROM gate.forms WHERE id = $cid" >/dev/null 2>&1 && ok "...and the test comment area removed" || bad "the test comment area $cid is still there"
else
    bad "no test comment area: $(head -c 200 <<<"$cj")"
fi
t_ok "it knows gonsalvesfamily.com's hosts (from the routes)" \
     sh -c "curl -s --max-time 5 -H 'Host: gonsalvesfamily.com' http://127.0.0.1:$GATE_PORT/_pammy/me | grep -q '\"signedIn\":false'"
t_ok "...and not a name no host answers to (400)" \
     test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: nobody.gonsalvesfamily.com' http://127.0.0.1:$GATE_PORT/_pammy/me)" = 400
t_ok "a check for a route area it doesn't know is refused (403)" \
     test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $GH" "http://127.0.0.1:$GATE_PORT/check/$(printf 'A%.0s' {1..32})")" = 403
t_ok "it gets its password through LoadCredential"    sh -c "systemctl cat lfdln-gate | grep -q '^LoadCredential=db.pass:$PASS_DIR/gate.pass'"
t_no "$GATEU can't read the database passwords"       as_u "$GATEU" "cat $PASS_DIR/gate.pass"
# the proof apps check the account headers with (docs/s1-plan.md S1a, review S1)
IDKEY=/etc/lfdln-panel/identity.key IDPUB=/etc/lfdln-identity/identity.pub
t_ok "the gate's identity key is root's, 600"           test "$(stat -c '%U %a' "$IDKEY" 2>/dev/null)" = "root 600"
t_ok "...the gate gets it through LoadCredential"     sh -c "systemctl cat lfdln-gate | grep -q '^LoadCredential=identity.key:$IDKEY'"
t_no "...$GATEU can't read it itself"                as_u "$GATEU" "cat $IDKEY"
t_ok "its public half for apps is root's, 644"         test "$(stat -c '%U %a' "$IDPUB" 2>/dev/null)" = "root 644"
t_ok "...and is the key's"                             test "$(openssl pkey -in "$IDKEY" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')" = "$(cat "$IDPUB" 2>/dev/null)"
# a route to an app, as nginx asks for it: told who, with a proof the app's public key takes
aud_line=$(grep -rhoE 'auth_request /_pammy/check/[A-Za-z0-9_-]{32}/[a-z0-9.-]+;' /etc/nginx/lfdln-hosts 2>/dev/null | head -1)
if [[ -n $aud_line ]]; then
    aud_path=${aud_line#auth_request /_pammy}; aud_path=${aud_path%;}
    aud=${aud_path##*/}
    aud_host=$(grep -rlF "$aud_line" /etc/nginx/lfdln-hosts 2>/dev/null | head -1 | xargs -r grep -hm1 -E '^\s*server_name ' | awk '{print $2}' | tr -d ';')
    if out=$(curl -s -D - -o /dev/null --max-time 5 -H "Host: $aud_host" "http://127.0.0.1:$GATE_PORT$aud_path") && [[ $out == *' 204 '* ]]; then
        hv() { printf '%s' "$out" | tr -d '\r' | awk -v h="$1" 'index(tolower($0), tolower(h) ":") == 1 {sub(/^[^:]*: */, ""); print; exit}'; }
        if (cd "$APP" && node --disable-warning=ExperimentalWarning --input-type=module -e "
import { readFileSync } from 'node:fs';
import { proofOk, publicKeyOf } from '@panel/core/identity-proof';
const [proof, aud, host, account, username, role, privileges] = process.argv.slice(1);
process.exit(proofOk(publicKeyOf(readFileSync('$IDPUB', 'utf8')), proof, aud, host, { account, username, role, privileges }, Date.now()) ? 0 : 1);
" "$(hv x-pammy-proof)" "$aud" "$aud_host" "$(hv x-pammy-account)" "$(hv x-pammy-user)" "$(hv x-pammy-role)" "$(hv x-pammy-privileges)") >/dev/null 2>&1; then
            ok "the gate signs what $aud is told on $aud_host, and the public key takes it"
        else bad "the gate's proof for $aud on $aud_host isn't taken by $IDPUB"; fi
    else bad "the gate didn't answer nginx's check for $aud on $aud_host with 204"; fi
else note "no route to an app has accounts: no proof to check"; fi
gpid=$(systemctl show -p MainPID --value lfdln-gate)
if [[ $gpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$gpid" | tr -d ' ') == "$(id -u "$GATEU")" ]] && ok "runs as $GATEU" || bad "runs as uid $(ps -o uid= -p "$gpid" | tr -d ' ')"
    grep -q "^Groups:.*\b$(getent group "$SITES_GROUP" | cut -d: -f3)\b" "/proc/$gpid/status" && ok "has $SITES_GROUP only while running (to read the site folders like nginx)" || bad "it isn't in $SITES_GROUP while running"
    [[ $(grep '^CapBnd' "/proc/$gpid/status" | awk '{print $2}') == 0000000000000000 ]] && ok "it has no Linux capabilities" || bad "lfdln-gate has capabilities"
    t_ok "inside its sandbox: can read the site folders"      nsenter -t "$gpid" -m -S "$(id -u "$GATEU")" -G "$(getent group "$SITES_GROUP" | cut -d: -f3)" -- ls "$SITES"
    t_ok "inside its sandbox: can read gate-routes.json"      nsenter -t "$gpid" -m -S "$(id -u "$GATEU")" -G "$(id -g "$GATEU")" -- cat "$GR"
    t_no "inside its sandbox: can't write them"               nsenter -t "$gpid" -m -- sh -c "touch $SITES/.lfdln-probe && rm -f $SITES/.lfdln-probe"
    t_ok "inside its sandbox: the rest of /var/www isn't there" sh -c "test -z \"\$(nsenter -t $gpid -m -- ls -A /var/www | grep -vx lesfleursdelanuit-sub)\""
    t_ok "inside its sandbox: /pamela isn't there"            test "$(nsenter -t "$gpid" -m -- stat -c %a /pamela 2>/dev/null || echo 0)" = 0
    t_ok "inside its sandbox: lfdln's settings blocked"       test "$(nsenter -t "$gpid" -m -- stat -c %a /etc/lfdln-panel)" = 0
    t_ok "inside its sandbox: the panel's data blocked"       test "$(nsenter -t "$gpid" -m -- stat -c %a /var/lib/svc-lfdlnpanel)" = 0
    t_ok "inside its sandbox: pammy.org's gate's data blocked" test "$(nsenter -t "$gpid" -m -- stat -c %a /var/lib/svc-pammygate 2>/dev/null || echo 0)" = 0
    t_ok "inside its sandbox: its home is writable"           nsenter -t "$gpid" -m -- sh -c "touch /var/lib/$GATEU/.probe && rm -f /var/lib/$GATEU/.probe"
    t_no "inside its sandbox: /etc isn't writable"            nsenter -t "$gpid" -m -- sh -c 'touch /etc/.lfdln-probe && rm -f /etc/.lfdln-probe'
else
    bad "the gate isn't running"
fi
score=$(systemd-analyze security lfdln-gate --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "gate exposure rating: ${score#→ }"

echo "--- the Studio's database helper (lfdln-pammydb: lfdln-appdb, the apps' databases read-only, docs/phase8-plan.md 8-4)"
STUDIOU=svc-lfdlnstudio
PDSOCK=/run/lfdln-pammydb.sock
VDB=zz_studio_verify_$$
VUSER=db_zz_verify_$$
VPASS=VerifyVerifyVerifyVerify12
dcall() {  # dcall <user> <json> -- ask the helper the way the panel does
    local user=$1; shift
    (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callPammyDb } from '$APP/packages/studio/src/pammydb/client.ts';
      console.log(JSON.stringify(await callPammyDb('$PDSOCK', JSON.parse(process.argv[1])), null, 1));" "$@")
}
gdcall() {  # gdcall <json> -- ask the helper the way the gate does: as the gate's user, at its own door (S2)
    (cd / && runuser -u "$GATEU" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callPammyDb } from '$APP/packages/studio/src/pammydb/client.ts';
      console.log(JSON.stringify(await callPammyDb('/run/lfdln-pammydb-gate.sock', JSON.parse(process.argv[1])), null, 1));" "$@")
}
if [[ ! -S $PDSOCK || ! -s $PASS_DIR/studio-postgres.pass ]]; then
    note "the Studio's helper isn't on yet (no $PDSOCK or no studio password): sudo ~/pamela-setup/panel/deploy/lfdln/appdb/install-appdb.sh, then install-lfdln.sh"
else
    t_ok "system user $STUDIOU exists, no login shell"   test "$(getent passwd "$STUDIOU" | cut -d: -f7)" = /usr/sbin/nologin
    t_ok "socket is root:lfdln-pammydb-clients 660"      test "$(stat -c '%U:%G %a' "$PDSOCK")" = "root:lfdln-pammydb-clients 660"
    # S2 (docs/s2-plan.md): the panel's door is the panel's alone; the gate has its own
    members=$(getent group lfdln-pammydb-clients | cut -d: -f4 | tr ',' '\n' | sort | paste -sd, -)
    [[ $members == "svc-lfdlnpanel" ]] && ok "only the panel is in lfdln-pammydb-clients (the gate has its own door, S2)" || bad "lfdln-pammydb-clients holds: ${members:-nobody}"
    t_ok "the panel's user can ask it"                   dcall "$SVC" '{"op":"list-databases","actor":"verify"}'
    t_no "the gate's user can't open the panel's door (S2)" can_open "$GATEU" "$PDSOCK"
    verify_gate_door() {  # the gate's own door: the gate only, row ops only (S2)
        local gsock=/run/lfdln-pammydb-gate.sock out gpid u req
        gcall() {  # gcall <user> <json>: prints "code: message" on a refusal, the answer otherwise
            local user=$1; shift
            (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
              import { callPammyDb } from '$APP/packages/studio/src/pammydb/client.ts';
              try { console.log(JSON.stringify(await callPammyDb('$gsock', JSON.parse(process.argv[1])))); }
              catch (e) { console.log((e.code ?? 'error') + ': ' + e.message); process.exitCode = 1; }" "$@" 2>&1)
        }
        t_ok "the gate's door is root:svc-lfdlngate 660"  test "$(stat -c '%U:%G %a' "$gsock")" = "root:svc-lfdlngate 660"
        t_no "nobody else is in the svc-lfdlngate group"   sh -c "getent group svc-lfdlngate | cut -d: -f4 | grep -q ."
        t_ok "the gate's user can open its door"           can_open "$GATEU" "$gsock"
        for u in "$SVC" svc-pammypanel svc-pammygate www-data momolig "$SITES_USER" svc-lfdln-apps; do
            id "$u" >/dev/null 2>&1 && t_no "$u can't open the gate's door" can_open "$u" "$gsock"
        done
        # probes the op layer refuses even at the panel's door (review MEDIUM-1): only the door's
        # own words pass, and a door wrongly open would still change nothing
        for req in '{"op":"drop-database","engine":"postgres","name":"postgres","actor":"verify"}' \
                   '{"op":"apply-schema","engine":"mariadb","name":"mysql","patch":[],"expect":null,"actor":"verify"}' \
                   '{"op":"create-user","engine":"postgres","user":"postgres","password":"","actor":"verify"}' \
                   '{"op":"grant-access","engine":"postgres","user":"postgres","database":"zz_none","role":"admin","actor":"verify"}' \
                   '{"op":"reset-password","engine":"postgres","user":"postgres","password":"","actor":"verify"}' \
                   '{"op":"project-database","engine":"postgres","name":"postgres","actor":"verify"}' \
                   '{"op":"list-databases","actor":"verify"}'; do
            out=$(gcall "$GATEU" "$req")
            grep -q "^not-allowed: The gate's door" <<<"$out" && ok "the gate's door refuses $(sed 's/.*"op":"\([a-z-]*\)".*/\1/' <<<"$req")" \
                || bad "the gate's door answered $(sed 's/.*"op":"\([a-z-]*\)".*/\1/' <<<"$req"): $(head -c 200 <<<"$out")"
        done
        # a row op goes through to the engine (no such table: not the door's refusal)
        out=$(gcall "$GATEU" '{"op":"list-rows","engine":"postgres","name":"examprep","query":{"table":"zz_no_such_table","columns":["id"],"limit":1,"offset":0},"actor":"verify"}')
        if grep -q "gate's door" <<<"$out"; then bad "the gate's door refused a row op: $out"
        elif grep -q '^unavailable:' <<<"$out"; then bad "the gate's door didn't answer a row op: $out"
        else ok "the gate's door passes a row op on to the engine"; fi
        gpid=$(pid_of lfdln-gate)
        if [[ $gpid =~ ^[1-9][0-9]*$ ]]; then
            grep -qw "$(getent group lfdln-pammydb-clients | cut -d: -f3)" <<<"$(grep '^Groups:' "/proc/$gpid/status")" \
                && bad "the running gate still has lfdln-pammydb-clients (restart it: it predates S2's install)" || ok "the running gate doesn't have lfdln-pammydb-clients"
        fi
        t_ok "the gate is pointed at its own door"   sh -c "systemctl show -p Environment --value lfdln-gate | tr ' ' '\n' | grep -qx GATE_PAMMYDB_SOCKET=$gsock"
        gpid=$(pid_of lfdln-pammydb-gate)
        [[ $gpid =~ ^[1-9][0-9]*$ && $(ps -o uid= -p "$gpid" | tr -d ' ') == "$(id -u "$STUDIOU")" ]] && ok "the gate's helper runs as $STUDIOU" || bad "the gate's helper: pid ${gpid:-none}"
        grep -qx 'NoNewPrivileges=yes' <<<"$(systemctl show lfdln-pammydb-gate -p NoNewPrivileges)" && grep -qx 'CapabilityBoundingSet=' <<<"$(systemctl show lfdln-pammydb-gate -p CapabilityBoundingSet)" \
            && ok "the gate's helper: no sudo, no capabilities" || bad "the gate's helper sandbox"
    }
    if [[ -S /run/lfdln-pammydb-gate.sock ]]; then verify_gate_door; else bad "the gate's door to the database helper isn't there (/run/lfdln-pammydb-gate.sock, S2)"; fi
    for u in svc-pammypanel svc-pammygate www-data momolig "$SITES_USER" svc-lfdln-apps; do
        id "$u" >/dev/null 2>&1 && t_no "$u can't ask it" dcall "$u" '{"op":"list-databases"}'
    done
    list=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null)
    got=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write([j.engines.map(e=>e.engine+':'+e.ok).join(','), j.databases.filter(d=>d.appOwned).map(d=>d.name).sort().join(',')].join(' '))" "$list" 2>/dev/null)
    [[ $(tr ',' '\n' <<<"${got%% *}" | sort | paste -sd,) == "mariadb:true,postgres:true" ]] && ok "two engines, and both answer (lfdln-appdb :5436, lfdln-appmaria :3308)" || bad "engines: ${got%% *}"
    [[ ${got#* } == "examprep,ligneous_frontend,tutorstar" ]] && ok "the apps' databases are listed as theirs: ${got#* }" || bad "the apps' databases: ${got#* }"
    dpid=$(systemctl show -p MainPID --value lfdln-pammydb)
    if [[ $dpid =~ ^[1-9][0-9]*$ ]]; then
        [[ $(ps -o uid= -p "$dpid" | tr -d ' ') == "$(id -u "$STUDIOU")" ]] && ok "runs as $STUDIOU" || bad "runs as uid $(ps -o uid= -p "$dpid" | tr -d ' ')"
        t_ok "inside its sandbox: lfdln's settings blocked"   test "$(nsenter -t "$dpid" -m -- stat -c %a /etc/lfdln-panel)" = 0
        t_ok "inside its sandbox: pammy.org's blocked"        test "$(nsenter -t "$dpid" -m -- stat -c %a /etc/pammy-panel 2>/dev/null || echo 0)" = 0
        t_no "inside its sandbox: nothing writable but its /tmp" nsenter -t "$dpid" -m -- sh -c 'touch /etc/.lfdln-probe && rm -f /etc/.lfdln-probe'
        t_no "it can't read the studio password itself"       runuser -u "$STUDIOU" -- cat "$PASS_DIR/studio-postgres.pass"
    else
        bad "the Studio's helper isn't running after being asked"
    fi
    t_ok "$PASS_DIR/studio-postgres.pass is root's, 600"  test "$(stat -c '%U %a' "$PASS_DIR/studio-postgres.pass")" = "root 600"
    dprops=$(systemctl show lfdln-pammydb -p NoNewPrivileges -p PrivateNetwork -p CapabilityBoundingSet -p IPAddressDeny -p IPAddressAllow)
    grep -qx 'NoNewPrivileges=yes' <<<"$dprops" && grep -qx 'CapabilityBoundingSet=' <<<"$dprops" && ok "no sudo, no capabilities" || bad "lfdln-pammydb: $dprops"
    grep -qxE 'IPAddressDeny=(0\.0\.0\.0/0 ::/0|::/0 0\.0\.0\.0/0)' <<<"$dprops" && grep -qxE 'IPAddressAllow=(127\.0\.0\.0/8 ::1/128|::1/128 127\.0\.0\.0/8)' <<<"$dprops" && ok "loopback only" || bad "lfdln-pammydb addresses: $dprops"
    # the ports of every other database here are refused at start, for real, as its own user
    boot() { (cd / && runuser -u "$STUDIOU" -- env "$@" PAMMYDB_POSTGRES_PASSWORD=x PAMMYDB_SOCKET=/nonexistent/pammydb.sock \
              /usr/bin/node --disable-warning=ExperimentalWarning "$APP/sites/lfdln/src/helpers/pammydb.ts" 2>&1 || true); }
    for bp in 5432 5433 5434 5435 3307; do
        grep -q "refusing to use port $bp" <<<"$(boot PAMMYDB_POSTGRES_PORT=$bp)" && ok "refuses to start against port $bp" || bad "the helper did NOT refuse port $bp"
    done
    grep -q "refusing to use port 3307" <<<"$(boot PAMMYDB_MARIADB_PASSWORD=x PAMMYDB_MARIADB_PORT=3307)" && ok "refuses MariaDB on 3307 (Pamela's)" || bad "the helper did NOT refuse MariaDB on 3307"
    grep -q 'refusing to use port' <<<"$(boot)" && bad "the port refusal fires without a bad port" || ok "the refusal is about the port, not about everything"
    # the apps' databases: read, never changed (P8-9)
    for adb in tutorstar ligneous_frontend examprep; do
        t_ok "it can look inside $adb"                     dcall "$SVC" "{\"op\":\"introspect\",\"engine\":\"postgres\",\"name\":\"$adb\",\"actor\":\"verify\"}"
        t_no "it refuses to delete $adb"                   dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"postgres\",\"name\":\"$adb\",\"actor\":\"verify\"}"
        t_no "it refuses a change to $adb's structure"     dcall "$SVC" "{\"op\":\"preview-schema\",\"engine\":\"postgres\",\"name\":\"$adb\",\"patch\":[],\"actor\":\"verify\"}"
        t_no "it refuses a login to $adb"                  dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"postgres\",\"user\":\"zz_nobody\",\"database\":\"$adb\",\"role\":\"read\",\"actor\":\"verify\"}"
    done
    ep=$(dcall "$SVC" '{"op":"introspect","engine":"postgres","name":"examprep","actor":"verify"}' 2>/dev/null)
    grep -q '"tables": \[\]' <<<"$ep" && bad "examprep shows no tables (its schema is prep)" || ok "examprep's tables are shown, from its own schema (prep)"
    for u in tutorstar examprep_app postgres; do
        t_no "it refuses to change $u's password" dcall "$SVC" "{\"op\":\"reset-password\",\"engine\":\"postgres\",\"user\":\"$u\",\"password\":\"VerifyVerifyVerify12\",\"actor\":\"verify\"}"
    done
    r=$(PGPASSWORD=$(cat "$PASS_DIR/studio-postgres.pass") PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5436 -U pammy_studio -d tutorstar -c "CREATE TABLE zz_studio_probe (id int)" 2>&1)
    grep -qE 'permission denied|must be owner' <<<"$r" && ok "the engine itself refuses the Studio's login a change to an app's database (SELECT only)" || { bad "pammy_studio could change tutorstar: $r"; PGPASSWORD=$(cat "$PASS_DIR/studio-postgres.pass") psql -X -qtA -h 127.0.0.1 -p 5436 -U pammy_studio -d tutorstar -c "DROP TABLE IF EXISTS zz_studio_probe" >/dev/null 2>&1; }
    # ...and its own: a database and a login made, used and removed
    if dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"postgres\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
        ok "made a database of its own ($VDB)"
        if dcall "$SVC" "{\"op\":\"create-user\",\"engine\":\"postgres\",\"user\":\"$VUSER\",\"password\":\"$VPASS\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"postgres\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"role\":\"read\",\"actor\":\"verify\"}" >/dev/null 2>&1
            # (P8-15) a db_ login reaches what it was given, and pg_hba keeps it off the apps' databases
            [[ $(PGPASSWORD=$VPASS PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5436 -U "$VUSER" -d "$VDB" -c 'SELECT 1' 2>&1) == 1 ]] \
                && ok "a login it made ($VUSER) reaches the database it was given" || bad "$VUSER couldn't reach $VDB"
            r=$(PGPASSWORD=$VPASS PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5436 -U "$VUSER" -d tutorstar -c 'SELECT 1' 2>&1)
            grep -q 'pg_hba.conf rejects' <<<"$r" && ok "...and pg_hba turns it away from an app's database (tutorstar)" || bad "$VUSER to tutorstar: $r"
            t_no "it refuses a login not named db_" dcall "$SVC" '{"op":"create-user","engine":"postgres","user":"zz_nodb","password":"VerifyVerifyVerify12","actor":"verify"}'
            # a form's answers into a table (step 8-6): the gate writes the row through the helper,
            # as a form link does; never into an app's database
            PGPASSWORD=$(cat "$PASS_DIR/studio-postgres.pass") PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5436 -U pammy_studio -d "$VDB" \
                -c 'CREATE TABLE answers (id serial PRIMARY KEY, message text)' >/dev/null 2>&1
            ir=$(gdcall "{\"op\":\"insert-row\",\"engine\":\"postgres\",\"name\":\"$VDB\",\"table\":\"answers\",\"values\":{\"message\":\"verify-lfdln\"},\"back\":[\"id\"],\"actor\":\"forms\"}" 2>&1)
            grep -q '"id"' <<<"$ir" && ok "the gate saves a row into a Studio database (as a form link does)" || bad "the gate's row into $VDB: $(head -c 200 <<<"$ir")"
            t_no "...and never into an app's (tutorstar)" gdcall '{"op":"insert-row","engine":"postgres","name":"tutorstar","table":"users","values":{"x":1},"back":["id"],"actor":"forms"}'
            dcall "$SVC" "{\"op\":\"drop-user\",\"engine\":\"postgres\",\"user\":\"$VUSER\",\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "...and the login removed" || bad "the test login $VUSER is still there"
        else
            bad "couldn't make a login through the helper"
        fi
        dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"postgres\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "...and the database removed" || bad "couldn't remove $VDB -- remove it by hand"
    else
        bad "couldn't make a database through the helper"
    fi
    # lfdln-appmaria (docs/lfdln-mariadb-plan.md M7): the Studio's MariaDB, its own databases and db_ logins
    if [[ -s $PASS_DIR/studio-mariadb.pass ]]; then
        t_ok "$PASS_DIR/studio-mariadb.pass is root's, 600" test "$(stat -c '%U %a' "$PASS_DIR/studio-mariadb.pass")" = "root 600"
        t_no "the helper's user can't read it itself"        runuser -u "$STUDIOU" -- cat "$PASS_DIR/studio-mariadb.pass"
        listen=$(ss -ltnH 'sport = :3308' | awk '{print $4}' | sort -u | paste -sd' ')
        [[ $listen == "127.0.0.1:3308" ]] && ok "lfdln-appmaria answers on 127.0.0.1:3308 only" || bad "lfdln-appmaria listens on: ${listen:-nothing}"
        mpw=$(cat "$PASS_DIR/studio-mariadb.pass")
        mq() { MYSQL_PWD=$1 mariadb -h 127.0.0.1 -P 3308 -u "$2" --connect-timeout=5 --batch --skip-column-names "${@:3}" 2>&1; }
        live=$(mq "$mpw" pammy_studio -e "SELECT VERSION()"); engine_series MariaDB "${live%%-*}" "$D/appmaria/quadlet/lfdln-appmaria.container"
        grants=$(mq "$mpw" pammy_studio -e "SHOW GRANTS FOR CURRENT_USER")
        bad_grant=""; for g in SUPER FILE PROCESS RELOAD SHUTDOWN; do grep -q "$g" <<<"$grants" && bad_grant+=" $g"; done
        [[ -z $bad_grant && $grants == *"CREATE USER"* ]] && ok "the Studio's MariaDB login: CREATE USER, no SUPER, FILE, PROCESS, RELOAD or SHUTDOWN" || bad "pammy_studio on lfdln-appmaria:${bad_grant:- no CREATE USER}"
        [[ $(mq "$mpw" pammy_studio -e "SELECT count(*) FROM mysql.user WHERE user = 'root' AND host <> 'localhost'") == 0 ]] && ok "root is only inside the container" || bad "root may connect from outside lfdln-appmaria"
        if dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"mariadb\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
            ok "made a MariaDB database of its own ($VDB)"
            if dcall "$SVC" "{\"op\":\"create-user\",\"engine\":\"mariadb\",\"user\":\"$VUSER\",\"password\":\"$VPASS\",\"actor\":\"verify\"}" >/dev/null 2>&1; then
                dcall "$SVC" "{\"op\":\"grant-access\",\"engine\":\"mariadb\",\"user\":\"$VUSER\",\"database\":\"$VDB\",\"role\":\"read\",\"actor\":\"verify\"}" >/dev/null 2>&1
                [[ $(mq "$VPASS" "$VUSER" -D "$VDB" -e 'SELECT 1') == 1 ]] && ok "a MariaDB login it made ($VUSER) reaches the database it was given" || bad "$VUSER couldn't reach $VDB on MariaDB"
                r=$(mq "$VPASS" "$VUSER" -e 'SELECT count(*) FROM mysql.user')
                grep -qiE 'denied|command denied' <<<"$r" && ok "...and nothing else (mysql.user refused)" || bad "$VUSER read mysql.user: $r"
                t_no "it refuses a MariaDB login not named db_" dcall "$SVC" '{"op":"create-user","engine":"mariadb","user":"zz_nodb","password":"VerifyVerifyVerify12","actor":"verify"}'
                t_no "it refuses to change root's password" dcall "$SVC" '{"op":"reset-password","engine":"mariadb","user":"root","password":"VerifyVerifyVerify12","actor":"verify"}'
                dcall "$SVC" "{\"op\":\"drop-user\",\"engine\":\"mariadb\",\"user\":\"$VUSER\",\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "...and the MariaDB login removed" || bad "the test login $VUSER is still on MariaDB"
            else
                bad "couldn't make a MariaDB login through the helper"
            fi
            dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"mariadb\",\"name\":\"$VDB\",\"actor\":\"verify\"}" >/dev/null 2>&1 && ok "...and the MariaDB database removed" || bad "couldn't remove $VDB from MariaDB -- remove it by hand"
        else
            bad "couldn't make a MariaDB database through the helper"
        fi
        t_ok "its nightly backup timer is on" systemctl --user -M svc-lfdlnmaria@ is-enabled -q lfdln-appmaria-backup.timer
        t_ok "its backups folder is svc-lfdlnmaria's, 700" test "$(stat -c '%U %a' /var/lib/svc-lfdlnmaria/backups)" = "svc-lfdlnmaria 700"
    else
        bad "no $PASS_DIR/studio-mariadb.pass: sudo ~/pamela-setup/panel/deploy/lfdln/appmaria/install-appmaria.sh"
    fi
    # a project's database (docs/phase8b-plan.md 8b-5): made by the project-database op, its two
    # logins used as a project's server uses them, the Studio keeping its hands off; then
    # removed by the engines' own admins (the panel never drops one)
    source "$D/appmaria/lib-appmaria.sh"
    PJ=zz_verify_$$
    PJDB=proj_$PJ; PJO=db_proj_${PJ}_owner; PJA=db_proj_${PJ}_app
    OPW=VerifyOwnerVerifyOwner$$; APW=VerifyAppVerifyAppVerify$$
    pjsql() {  # pjsql <engine> <login> <password> <statement>: as a project's server connects
        if [[ $1 == postgres ]]; then PGPASSWORD=$3 PGCONNECT_TIMEOUT=5 psql -X -qtA -h 127.0.0.1 -p 5436 -U "$2" -d "$PJDB" -c "$4" 2>&1
        else MYSQL_PWD=$3 mariadb -h 127.0.0.1 -P 3308 -u "$2" -D "$PJDB" --connect-timeout=5 --batch --skip-column-names -e "$4" 2>&1; fi
    }
    for eng in postgres mariadb; do
        pr=$(dcall "$SVC" "{\"op\":\"project-database\",\"engine\":\"$eng\",\"name\":\"$PJDB\",\"owner\":\"$PJO\",\"ownerPassword\":\"$OPW\",\"app\":\"$PJA\",\"appPassword\":\"$APW\",\"actor\":\"verify\"}" 2>&1)
        if grep -q '"kept": false' <<<"$pr"; then
            ok "$eng: a project's database made ($PJDB, logins ${PJO#db_proj_} and ${PJA#db_proj_})"
            serial=$([[ $eng == postgres ]] && echo 'serial PRIMARY KEY' || echo 'INT AUTO_INCREMENT PRIMARY KEY')
            r=$(pjsql "$eng" "$PJO" "$OPW" "CREATE TABLE notes (id $serial, body VARCHAR(50))")
            [[ $r != *ERROR* ]] && ok "...its owner login makes a table (its migrations)" || bad "$eng owner's table: $r"
            r=$(pjsql "$eng" "$PJA" "$APW" "INSERT INTO notes (body) VALUES ('hi')"; pjsql "$eng" "$PJA" "$APW" "SELECT count(*) FROM notes")
            [[ $r == *1 && $r != *ERROR* ]] && ok "...its app login writes and reads it" || bad "$eng app's rows: $r"
            r=$(pjsql "$eng" "$PJA" "$APW" "DROP TABLE notes")
            grep -qiE 'ERROR|denied|must be owner' <<<"$r" && ok "...but changes no structure (DROP refused)" || bad "$eng app dropped a table: $r"
            pl=$(dcall "$SVC" '{"op":"list-databases","actor":"verify"}' 2>/dev/null)
            node -e "const d=JSON.parse(process.argv[1]).databases.find((x)=>x.engine===process.argv[2]&&x.name===process.argv[3]); process.exit(d&&d.appOwned&&d.projectOwned?0:1)" "$pl" "$eng" "$PJDB" \
                && ok "...the Studio lists it as a project's (read only)" || bad "$eng: the Studio's list doesn't mark $PJDB as a project's"
            t_no "...the Studio refuses to delete it"           dcall "$SVC" "{\"op\":\"drop-database\",\"engine\":\"$eng\",\"name\":\"$PJDB\",\"actor\":\"verify\"}"
            t_no "...or to remove its app login"                dcall "$SVC" "{\"op\":\"drop-user\",\"engine\":\"$eng\",\"user\":\"$PJA\",\"actor\":\"verify\"}"
            t_no "...or to change its owner login's password"   dcall "$SVC" "{\"op\":\"reset-password\",\"engine\":\"$eng\",\"user\":\"$PJO\",\"password\":\"VerifyVerifyVerify12\",\"actor\":\"verify\"}"
            t_no "...and makes no proj_ database of its own"    dcall "$SVC" "{\"op\":\"create-database\",\"engine\":\"$eng\",\"name\":\"${PJDB}_x\",\"actor\":\"verify\"}"
        else
            bad "$eng: a project's database: $(head -c 200 <<<"$pr")"
        fi
        if [[ $eng == postgres ]]; then
            printf 'DROP DATABASE IF EXISTS %s WITH (FORCE);\nDROP ROLE IF EXISTS %s;\nDROP ROLE IF EXISTS %s;\n' "$PJDB" "$PJA" "$PJO" | appdb_super >/dev/null 2>&1
            [[ -z $(echo "SELECT 1 FROM pg_roles WHERE rolname IN ('$PJA','$PJO') UNION ALL SELECT 1 FROM pg_database WHERE datname = '$PJDB'" | appdb_super 2>/dev/null) ]] \
                && ok "...removed again (by lfdln-appdb's superuser)" || bad "remove $PJDB, $PJO and $PJA from lfdln-appdb by hand"
        else
            printf "DROP DATABASE IF EXISTS %s;\nDROP USER IF EXISTS '%s'@'%%', '%s'@'%%';\n" "$PJDB" "$PJA" "$PJO" | appmaria_root >/dev/null 2>&1
            [[ $(echo "SELECT count(*) FROM mysql.user WHERE user IN ('$PJA','$PJO')" | appmaria_root 2>/dev/null) == 0 ]] \
                && ok "...removed again (by lfdln-appmaria's root)" || bad "remove $PJDB, $PJO and $PJA from lfdln-appmaria by hand"
        fi
    done
    # the data API answers through a real host (the gate, not nginx's 404 or a 502)
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "lesfleursdelanuit.com:443:$ORIGIN_IP" "https://lesfleursdelanuit.com/_pammy/api/data/postgres/zz_none/things")
    [[ $code =~ ^(401|403|404)$ ]] && ok "the data API answers through a host ($code for a database it doesn't serve)" || bad "the data API through a host: $code"
    # PHP's door to the gate's API (step 8-4)
    t_ok "PHP's door to the gate's API is root:svc-lfdlnphp 660" test "$(stat -c '%U:%G %a' /run/lfdln-gate-php.sock)" = "root:svc-lfdlnphp 660"
    score=$(systemd-analyze security lfdln-pammydb --no-pager 2>/dev/null | tail -1)
    [[ -n $score ]] && note "Studio helper exposure rating: ${score#→ }"
fi

echo "--- how long the database backups are kept (docs/lfdln-mariadb-plan.md B: Settings > Backups)"
kd=$(pg "SELECT keep_days FROM panel.backup_settings WHERE id = 1" 2>/dev/null)
[[ $kd =~ ^[0-9]+$ ]] && (( kd >= 7 && kd <= 365 )) && ok "the setting: $kd days" || bad "panel.backup_settings: ${kd:-missing}"
pr=$(svc "{\"op\":\"prune\",\"days\":${kd:-60},\"actor\":\"verify\"}")
grep -q '"sets":\[' <<<"$pr" && ! grep -q '"why":"' <<<"$pr" && ok "the services helper prunes both folders by it: $(node -e "console.log(JSON.parse(process.argv[1]).sets.map(s=>s.id+' '+s.kept+' kept').join(', '))" "$pr" 2>/dev/null)" || bad "prune: $(head -c 300 <<<"$pr")"
grep -q '"refused"' <<<"$(svc '{"op":"prune","days":3,"actor":"verify"}')" && ok "...and refuses fewer than 7 days" || bad "prune took 3 days"
for f in /var/lib/svc-lfdlnappdb/bin/backup-lfdln-appdb.sh /var/lib/svc-lfdlnmaria/bin/backup-lfdln-appmaria.sh; do
    grep -q -- '-mtime +400 -delete' "$f" && ok "$(basename "$f") deletes by age only after 400 days (the panel prunes)" || bad "$f still prunes by itself"
done

echo "--- monitoring (docs/monitoring-plan.md: a round every 5 minutes, an email when something goes down)"
if [[ $(pg "SELECT to_regclass('panel.monitor_settings') IS NOT NULL" 2>/dev/null) == t ]]; then
    # the first round runs a minute after the panel starts: wait for one since then (3 minutes at most)
    started=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value lfdln-panel)" +%s 2>/dev/null || echo 0)
    at=0
    for _ in $(seq 90); do
        at=$(pg "SELECT coalesce(round_at, 0) FROM panel.monitor_settings" 2>/dev/null || echo 0)
        (( at >= started )) && break
        sleep 2
    done
    if (( at >= started )); then ok "a round ran since the panel started ($(( $(date +%s) - at ))s ago, in $(pg "SELECT round_ms FROM panel.monitor_settings") ms)"
    else bad "no monitoring round since the panel started (the last: ${at:-never}; journalctl -u lfdln-panel)"; fi
    n=$(pg "SELECT count(*) FROM panel.monitor_checks")
    (( n > 0 )) && ok "it checks $n things (hosts, services, the panel's own)" || bad "it checks nothing"
    bad_now=$(pg "SELECT string_agg(label || ' (' || state || coalesce(': ' || nullif(why, ''), '') || ')', '; ' ORDER BY label) FROM panel.monitor_checks WHERE state IN ('down', 'warn')")
    [[ -z $bad_now ]] && ok "nothing down" || bad "down or to look at: $bad_now"
    once=$(pg "SELECT string_agg(label || ': ' || why, '; ' ORDER BY label) FROM panel.monitor_checks WHERE state <> 'down' AND fails > 0")
    [[ -z $once ]] || note "failed once (down if again): $once"
    stopped=$(pg "SELECT string_agg(label, ', ' ORDER BY label) FROM panel.monitor_checks WHERE state = 'stopped'")
    [[ -z $stopped ]] || note "stopped on purpose: $stopped"
    [[ $(pg "SELECT mail FROM panel.monitor_settings") == t ]] && ok "its emails are on (to the notice address)" || note "its emails are off (Monitoring page)"
    round_note=$(pg "SELECT coalesce(round_note, '') FROM panel.monitor_settings")
    [[ -z $round_note ]] || bad "the last round says: $round_note"
    # step 2: the certificates every round; the backups, the disk and the DNS records hourly
    # (the first round after a start asks them)
    grp() { pg "SELECT count(*) FROM panel.monitor_checks WHERE grp = '$1'"; }
    (( $(grp certs) > 0 )) && ok "the certificates: $(pg "SELECT string_agg(label || ', ' || why, '; ' ORDER BY label) FROM panel.monitor_checks WHERE grp = 'certs'")" || bad "no certificate checked"
    [[ $(grp backups) == 4 ]] && ok "the four nightly backups are checked (lfdln-pg, lfdln-appdb, lfdln-appmaria, pammy-pg)" || bad "backups checked: $(grp backups), not 4"
    note "$(pg "SELECT string_agg(label || ': ' || why, '; ' ORDER BY label) FROM panel.monitor_checks WHERE grp = 'backups'")"
    (( $(grp disk) > 0 )) && ok "the disk: $(pg "SELECT string_agg(label || ', ' || why, '; ') FROM panel.monitor_checks WHERE grp = 'disk'")" || bad "no disk checked"
    [[ $(pg "SELECT state FROM panel.monitor_checks WHERE key = 'panel:storage'") == up ]] && ok "the services helper read them through its root unit (storage)" || bad "the backups and disk weren't read: $(pg "SELECT why FROM panel.monitor_checks WHERE key = 'panel:storage'")"
    [[ $(grp dns) == 5 ]] && ok "the mail DNS records and nameservers are checked (DKIM, SPF, MX, DMARC, NS)" || bad "DNS records checked: $(grp dns), not 5"
    [[ $(pg "SELECT count(*) FROM panel.monitor_baseline") == 5 ]] && ok "...each kept as first read, to compare with" || bad "records kept: $(pg "SELECT count(*) FROM panel.monitor_baseline"), not 5"
    # step 3: the addresses outside lfdln's hosts, the registration, the watchdog
    # 4, less Gonsalves's two once they are hosts (docs/domains-hosts-plan.md 7-5: checked as hosts then)
    others=4; for l in gonsalves-public gonsalves-admin; do [[ -e /etc/nginx/sites-enabled/$l ]] || others=$((others - 1)); done
    [[ $(grp other) == "$others" ]] && ok "the other addresses: $(pg "SELECT string_agg(label || ', ' || why, '; ' ORDER BY label) FROM panel.monitor_checks WHERE grp = 'other'")" || bad "other addresses checked: $(grp other), not $others"
    [[ $(pg "SELECT state FROM panel.monitor_checks WHERE key = 'panel:urls'") == up ]] && ok "...the routing helper checked them (urls)" || bad "the other addresses weren't checked: $(pg "SELECT why FROM panel.monitor_checks WHERE key = 'panel:urls'")"
    reg=$(pg "SELECT why FROM panel.monitor_checks WHERE key = 'domain:registration'")
    [[ $reg == registered\ until* ]] && ok "the domain's registration read (shown, never mailed): $reg" || bad "the registration wasn't read: ${reg:-no row}"
    beat=/var/lib/svc-lfdlnpanel/monitor-round.json
    beat_at=$(sed -n 's/.*"at":\([0-9]*\).*/\1/p' "$beat" 2>/dev/null)
    [[ -n $beat_at ]] && (( $(date +%s) - beat_at < 900 )) && ok "the round writes its file for the watchdog ($(( $(date +%s) - beat_at ))s ago)" || bad "no fresh $beat (the watchdog would mail): ${beat_at:-none}"
    t_ok "...and it is the panel user's, 600"            test "$(stat -c '%U %a' "$beat" 2>/dev/null)" = "svc-lfdlnpanel 600"
    t_ok "the watchdog timer is on (every 10 minutes)"   systemctl is-active -q lfdln-watchdog.timer
    t_ok "...and starts at boot"                         systemctl is-enabled -q lfdln-watchdog.timer
    # its run, now, as the timer would: it must find nothing wrong
    # (its own line, not systemd's "Finished ..." after it)
    systemctl start lfdln-watchdog.service 2>/dev/null
    wd=$(journalctl -u lfdln-watchdog.service -n 20 -o cat --no-pager 2>/dev/null | grep '^lfdln-watchdog: ' | tail -1)
    [[ $(systemctl show -p Result --value lfdln-watchdog.service) == success && $wd == *"the panel answers and its rounds run"* ]] && ok "the watchdog ran: ${wd#lfdln-watchdog: }" || bad "the watchdog: ${wd:-said nothing} (journalctl -u lfdln-watchdog)"
fi

echo "--- deleted accounts passed on to the services (docs/accounts-plan.md Q1, step 4b)"
[[ $(pg "SELECT count(*) FROM pg_trigger WHERE tgname = 'visitors_deleted' AND tgrelid = 'gate.visitors'::regclass" 2>/dev/null) == 1 ]] \
    && ok "the gate notes every deleted account (trigger visitors_deleted)" || bad "no trigger visitors_deleted on gate.visitors"
t_ok "the keys' folder is root's, 700"                   test "$(stat -c '%U %a' "/etc/lfdln-panel/hooks" 2>/dev/null)" = "root 700"
for svc in examprep; do
    t_ok "$svc's key is root's, 600, and long enough"    sh -c "test \"\$(stat -c '%U %a' /etc/lfdln-panel/hooks/$svc.key)\" = 'root 600' && test \$(tr -d '\\n' < /etc/lfdln-panel/hooks/$svc.key | wc -c) -ge 32"
    t_ok "...and the panel has it (credential hooks_$svc.key)" test -s "/run/credentials/lfdln-panel.service/hooks_$svc.key"
done
code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "https://examprep.lesfleursdelanuit.com/_lfdln/account-deleted" 2>/dev/null)
[[ $code == 404 ]] && ok "from outside, /_lfdln/ is 404 (examprep.lesfleursdelanuit.com)" || bad "https://examprep.lesfleursdelanuit.com/_lfdln/account-deleted answered $code"
waiting=$(pg "SELECT count(*) || ' waiting' || coalesce(', oldest ' || to_char(to_timestamp(min(deleted_at)), 'YYYY-MM-DD HH24:MI') || ' UTC', '') || coalesce(', last: ' || max(last_error), '') FROM gate.deleted_accounts" 2>/dev/null)
note "deleted accounts not passed on yet: ${waiting:-?}"

echo "--- the services' things in the catalog (docs/catalog-plan.md step 5: the app's door, 127.0.0.1:3048)"
DOOR=${PANEL_DOOR_PORT:-3048}
[[ $(pg "SELECT count(*) FROM public.schema_migrations WHERE name = 'catalog/0004-app-sources.sql'" 2>/dev/null) == 1 ]] \
    && ok "the migration ran (catalog/0004-app-sources.sql)" || bad "catalog/0004-app-sources.sql has not run"
listen=$(ss -Hltnp "sport = :$DOOR" 2>/dev/null)
[[ $listen == *"127.0.0.1:$DOOR"* && $listen == *"pid=$(pid_of lfdln-panel),"* ]] && ok "the panel answers the door on 127.0.0.1:$DOOR" || bad "nothing of lfdln-panel's on 127.0.0.1:$DOOR: ${listen:-(none)}"
[[ $listen != *"0.0.0.0:$DOOR"* && $listen != *"*:$DOOR"* && $listen != *"[::]:$DOOR"* ]] && ok "...and only there" || bad "the door listens beyond 127.0.0.1: $listen"
door_code() {  # door_code <path> <key>: GET it signed (v2) as examprep with that key
    local ts sig; ts=$(date +%s%3N)
    sig=$(printf '%s\nGET\n%s\n' "$ts" "$1" | openssl dgst -sha256 -hmac "$2" -r | cut -d' ' -f1)
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-Lfdln-Service: examprep' -H "X-Lfdln-Timestamp: $ts" -H "X-Lfdln-Signature: v2=$sig" "http://127.0.0.1:$DOOR$1"
}
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$DOOR/_catalog/topics/labels")
[[ $code == 401 ]] && ok "an unsigned request is refused (401)" || bad "an unsigned request answered $code"
code=$(door_code /_catalog/topics/labels "not-examprep-s-key-zz-verify-$$")
[[ $code == 401 ]] && ok "one signed with another key is refused (401)" || bad "a wrongly signed request answered $code"
if [[ -s /etc/lfdln-panel/hooks/examprep.key ]]; then
    code=$(door_code /_catalog/topics/labels "$(tr -d '\n' < /etc/lfdln-panel/hooks/examprep.key)")
    case $code in
        200) ok "exam prep's own key is taken, and its topics are tagged (200)" ;;
        404) ok "exam prep's own key is taken (404: its topics aren't switched on yet)" ;;
        *) bad "a request signed with exam prep's key answered $code" ;;
    esac
fi
code=$(curl_panel -o /dev/null -w '%{http_code}' "https://$HOST/_catalog/topics/labels")
[[ $code == 404 ]] && ok "https://$HOST/_catalog/ is not the door (404)" || bad "https://$HOST/_catalog/topics/labels answered $code"
note "services with tags on: $(pg "SELECT coalesce(string_agg(ref || ' (' || (SELECT count(*) FROM catalog.items i JOIN catalog.resources r ON r.id = i.resource_id WHERE r.source_id = s.id AND i.state = 'present') || ')', ', ' ORDER BY ref), 'none') FROM catalog.sources s WHERE kind = 'app'" 2>/dev/null)"

echo "--- neighbours"
for u in https://panel.pammy.org/login https://pammy.org/ https://tutorlumi.com/; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$u")
    [[ $code =~ ^(200|301|302)$ ]] && ok "$u still answers ($code)" || bad "$u: $code"
done
t_ok "pammy.org's panel still running"                   systemctl is-active -q pammy-panel
echo "--- the edge secret, last: this machine's own limits (docs/s1-plan.md S1c, review L5)"
verify_edge_limits /etc/lfdln-panel "$PORT" 3047 "$HOST" lesfleursdelanuit.com
restarts_after=$(restarts)
[[ $restarts_after == "$restarts_before" ]] && ok "no sandboxed service crashed during these checks" || bad "restarts during the checks: $restarts_before -> $restarts_after"

echo
echo "  lfdln: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
