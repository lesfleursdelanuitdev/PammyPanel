#!/usr/bin/env bash
# Install or update lfdln's control panel at https://panel.lesfleursdelanuit.com
# (docs/lfdln-standup-plan.md; phase 5 of docs/platform-plan.md).
#
#   ~/pamela-setup/panel/build.sh                          # as yourself: test + build release-lfdln/
#   sudo ~/pamela-setup/panel/deploy/lfdln/install-lfdln.sh               # the panel
#   sudo ~/pamela-setup/panel/deploy/lfdln/install-lfdln.sh --take-over   # ...and, once, the hosts go live
#   sudo ~/pamela-setup/panel/deploy/lfdln/install-lfdln.sh --take-over-host instastylr   # a hand-written host
#        becomes the panel's (docs/adopt-plan.md V5, V6): instastylr, lesfleursdelanuit.com, tutor,
#        and gonsalvesfamily.com, admin.gonsalvesfamily.com (docs/domains-hosts-plan.md step 7;
#        their domain added first, on the Hosts page)
#
# Its own users, database (Postgres on 127.0.0.1:5435), code (/opt/lfdln-panel), settings
# (/etc/lfdln-panel), helpers and nginx site; nothing of pammy.org's panel is touched.
# Safe to re-run. Checks what it can before changing anything; if the new version
# doesn't come up healthy the previous one is put back, and if nginx refuses the panel's
# site file nginx is left as it was.
#
# The panel, its folder helper and PHP; the services helper, with what already runs taken
# in (docs/adopt-plan.md V7); then the hosts (docs/hosts-plan.md H10, the plan's
# L6): the routing helper, and taking over the stopgap catch-all -- hello/ to the trash,
# every other folder there adopted at its own host, nginx switched from the stopgap to the
# routing helper's files in one nginx -t (all put back if it says no). The first time only
# with --take-over, so the panel can be checked first; after that every install keeps the
# routing helper's units and files up to date.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
TAKE_OVER=no
TAKE_HOSTS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --take-over) TAKE_OVER=yes ;;
        --take-over-host) [[ -n ${2:-} ]] || { echo "--take-over-host needs a name (instastylr, lesfleursdelanuit.com, tutor, gonsalvesfamily.com, admin.gonsalvesfamily.com)" >&2; exit 2; }; TAKE_HOSTS+=("$2"); shift ;;
        *) echo "unknown: $1 (--take-over, --take-over-host <name>)" >&2; exit 2 ;;
    esac
    shift
done
D="$(dirname "$(readlink -f "$0")")"       # deploy/lfdln (not ~ : under sudo that is /root)
P="$(readlink -f "$D/../..")"              # panel/
source "$D/pg/lib-pg.sh"                   # PG_*, PASS_DIR, pg_as, say

REL=$P/release-lfdln
SVC=svc-lfdlnpanel
SVC_HOME=/var/lib/svc-lfdlnpanel
SITES_USER=svc-lfdlnsites
SITES_GROUP=lfdln-sites
PHPU=svc-lfdlnphp
APP=/opt/lfdln-panel
ETC=/etc/lfdln-panel
PHP_ETC=/etc/lfdln-php
PORT=3046
SITES=/var/www/lesfleursdelanuit-sub
ACME_ROOT=/var/www/letsencrypt
TRASH=$SITES/.trash
NGX_SITE=/etc/nginx/sites-available/lfdln-panel
NGX_LINK=/etc/nginx/sites-enabled/lfdln-panel
CERT=/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com
HOSTS_DIR=/etc/nginx/lfdln-hosts
HOSTS_LINK=/etc/nginx/sites-enabled/lfdln-hosts
STOPGAP=/etc/nginx/sites-enabled/lesfleursdelanuit-wildcard
ROUTES_UNITS=(lfdln-routes.socket lfdln-routes.service)
SERVICES_UNITS=(lfdln-services.socket lfdln-services.service)
SERVICES_STATE=/var/lib/lfdln-services
PROJECTS_UNITS=(lfdln-projects.socket lfdln-projects.service lfdln-projects-pushes.path)
GIT_UNITS=(lfdln-git-http.socket lfdln-git-http.service)
NGX_GIT=/etc/nginx/sites-available/lfdln-git
NGX_GIT_LINK=/etc/nginx/sites-enabled/lfdln-git
MAILU=svc-lfdlnmail
MAIL_ETC=/etc/lfdln-mail
MAIL_UNITS=(lfdln-mail.socket lfdln-mail-visitor.socket lfdln-mail.service)
GATEU=svc-lfdlngate
GATE_HOME=/var/lib/svc-lfdlngate
GATE_PORT=3047
GATE_UNITS=(lfdln-gate-admin.socket lfdln-gate-php.socket lfdln-gate.service)
WATCHDOG_UNITS=(lfdln-watchdog.service lfdln-watchdog.timer)
UNITS=(lfdln-panel.service lfdln-sitefs.socket lfdln-sitefs.service lfdln-php.service lfdln-thumbs.socket lfdln-thumbs.service)
THUMBSU=svc-lfdlnthumbs
MEDIA_PUBLIC=/var/lib/lfdln-media-public
# the Studio's database helper (docs/phase8-plan.md step 8-4): its own user, and the group whose
# members may open the panel's door (every op). Since S2 (docs/s2-plan.md) that is the panel's
# user only: the gate has a door of its own (lfdln-pammydb-gate.socket, group svc-lfdlngate),
# served by a second helper that answers row ops only.
STUDIOU=svc-lfdlnstudio
PAMMYDB_CLIENTS=lfdln-pammydb-clients
PAMMYDB_UNITS=(lfdln-pammydb.socket lfdln-pammydb.service lfdln-pammydb-gate.socket lfdln-pammydb-gate.service)
PAMMYDB_GATE_SOCK=/run/lfdln-pammydb-gate.sock
gate_door=yes       # set to no when the gate's door doesn't answer (6): then the gate isn't switched (6d)
STUDIO_CRED=$ETC/db/studio-postgres.pass
STUDIO_MARIA_CRED=$ETC/db/studio-mariadb.pass
die() { say FAIL "$1" >&2; declare -F edge_die_note >/dev/null && edge_die_note >&2; exit 1; }

# ---------------------------------------------------------------- preflight
[[ -f $REL/BUILD && -f $REL/sites/lfdln/src/server.ts && -f $REL/public/index.html ]] \
    || die "no release-lfdln/ to install: run ~/pamela-setup/panel/build.sh first"
new_build=$(tail -1 "$REL/BUILD")
# the release is what BUILD says it is (nothing changed in it since build.sh)
got=$(cd "$REL" && find packages sites public public-gate db tools help package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
[[ $got == "$new_build" ]] || die "release-lfdln/ changed since it was built ($got, BUILD says $new_build): build again"
# CI (docs/ci-plan.md T1-d, CI-Q4): did the commit this release was built from pass the full
# tier? Said, not enforced, for now.
ci_build_line=$(head -1 "$REL/BUILD")
if [[ $ci_build_line == *+dirty* ]]; then echo "CI: a build with uncommitted changes ($ci_build_line): CI can't have checked it"
elif [[ -x /usr/local/bin/lfdln-ci ]] && ci_commit=$(sed -n 's/.* from commit \([0-9a-f]\{7,40\}\).*/\1/p' <<<"$ci_build_line") && [[ -n $ci_commit ]]; then
    /usr/local/bin/lfdln-ci check "$ci_commit" || echo "  (only a warning for now: docs/ci-plan.md CI-Q4; ask for it with: lfdln-ci full $ci_commit)"
fi
# its guides (the Help page, docs/phase9-plan.md 9-1): one edited after the build isn't the one shown
while read -r guide _; do
    if [[ $P/../lfdln-guides/$guide -nt $REL/BUILD ]]; then die "the guide lfdln-guides/$guide changed after the last build -- run build.sh again (the Help page shows the guides)"; fi
done < <(grep -vE '^\s*(#|$)' "$P/../lfdln-guides/guides.map")
[[ ! $P/../lfdln-guides/guides.map -nt $REL/BUILD ]] || die "lfdln-guides/guides.map changed after the last build -- run build.sh again"
command -v node >/dev/null && command -v nginx >/dev/null && command -v psql >/dev/null || die "needs node, nginx and psql"
[[ -x /usr/sbin/php-fpm8.3 ]] || die "needs php8.3-fpm (pammy.org's installer puts it in, masked)"
[[ -r $CERT/fullchain.pem && -r $CERT/privkey.pem ]] || die "no wildcard certificate in $CERT"
[[ -r /etc/letsencrypt/options-ssl-nginx.conf && -r /etc/letsencrypt/ssl-dhparams.pem ]] || die "no certbot TLS settings in /etc/letsencrypt"
if ss -ltnpH "sport = :$PORT" | grep -q . && ! systemctl is-active -q lfdln-panel; then
    die "port $PORT is already used by something else: $(ss -ltnpH "sport = :$PORT")"
fi
if ss -ltnpH "sport = :$GATE_PORT" | grep -q . && ! systemctl is-active -q lfdln-gate; then
    die "port $GATE_PORT (the gate's) is already used by something else: $(ss -ltnpH "sport = :$GATE_PORT")"
fi
[[ -f $REL/public-gate/login.js ]] || die "release-lfdln/ has no public-gate/ (the gate's files): build again"
[[ -d $SITES ]] || die "$SITES isn't there (the stopgap catch-all's folder; docs/platform-plan.md phase 0)"
nginx -t -q 2>/dev/null || die "nginx -t fails before anything was changed: sort that out first"
# the panel's own files, rendered from its profile by this release
RENDERED=$(mktemp -d); trap 'rm -rf "$RENDERED"' EXIT
/usr/bin/node --disable-warning=ExperimentalWarning "$REL/tools/render-nginx.ts" "$RENDERED" --site lfdln >/dev/null \
    || die "couldn't render the panel's nginx files from lfdln's profile"
[[ -f $RENDERED/site/panel.conf ]] || die "the rendered files have no site/panel.conf"

# ---------------------------------------------------------------- 1. identity
# The panel: a home of its own (700) and nothing else. The folder helper's user owns the
# site folders (platform plan D3), with lfdln-sites as its group: nginx is in it (to read
# them), and PHP only while running. PHP's user owns nothing.
getent group "$SITES_GROUP" >/dev/null || { groupadd --system "$SITES_GROUP"; say ok "group $SITES_GROUP"; }
if ! id "$SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$SVC_HOME" --create-home --shell /usr/sbin/nologin "$SVC"
    say ok "created system user $SVC"
fi
install -d -o "$SVC" -g "$SVC" -m 700 "$SVC_HOME"
if ! id "$SITES_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --gid "$SITES_GROUP" --shell /usr/sbin/nologin "$SITES_USER"
    say ok "created system user $SITES_USER (group $SITES_GROUP)"
fi
if ! id "$PHPU" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --user-group --shell /usr/sbin/nologin "$PHPU"
    say ok "created system user $PHPU"
fi
# the thumbnail service (docs/phase8-plan.md step 8-1): owns nothing; it reads the site
# folders through lfdln-sites only while running (its unit's SupplementaryGroups)
if ! id "$THUMBSU" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --user-group --shell /usr/sbin/nologin "$THUMBSU"
    say ok "created system user $THUMBSU"
fi
if ! id -nG www-data | tr ' ' '\n' | grep -qx "$SITES_GROUP"; then
    usermod -aG "$SITES_GROUP" www-data
    say ok "nginx (www-data) may read the site folders (group $SITES_GROUP)"
fi

# ---------------------------------------------------------------- 2. the database (its own Postgres, Q2)
"$D/pg/install-pg.sh"
# and the apps' own Postgres (docs/data-move-plan.md M1): lfdln-appdb on :5436, their roles;
# their databases come with deploy/lfdln/appdb/move-db.sh
"$D/appdb/install-appdb.sh"
# and the Studio's MariaDB (docs/lfdln-mariadb-plan.md M1): lfdln-appmaria on :3308
"$D/appmaria/install-appmaria.sh"
# and the projects' user, folders and build image (docs/phase8b-plan.md step 8b-1)
"$D/projects/install-projects.sh"

# ---------------------------------------------------------------- 2a. the apps' keys for "this account was deleted"
# (docs/accounts-plan.md Q1, step 4b): one per service with the hook (known.ts accountDeleted),
# made once, root-only. The panel gets them as its credential "hooks"; each app's own installer
# copies its key (exam prep: web/deploy/install.sh, as the podman secret examprep-hook).
HOOKS=$ETC/hooks
install -d -o root -g root -m 700 "$HOOKS"
for svc in examprep; do
    if [[ ! -s $HOOKS/$svc.key ]]; then
        ( umask 077; head -c 33 /dev/urandom | base64 | tr -d '/+=\n' > "$HOOKS/$svc.key.new" )
        chown root:root "$HOOKS/$svc.key.new"; chmod 600 "$HOOKS/$svc.key.new"
        mv "$HOOKS/$svc.key.new" "$HOOKS/$svc.key"
        say ok "made the key the panel signs $svc's account deletions with ($HOOKS/$svc.key)"
    fi
done

# ---------------------------------------------------------------- 2a'. the gate's identity key (docs/s1-plan.md S1a)
# The gate signs what an app behind a route with accounts is told (X-Lfdln-Proof), so the
# app can tell nginx's headers from anyone's on 127.0.0.1 (review S1). Ed25519, made once:
# the private half root-only, the gate's by LoadCredential; the public half for every app
# (exam prep's installer, the projects helper's Quadlets), outside /etc/lfdln-panel.
IDKEY=$ETC/identity.key IDPUB_DIR=/etc/lfdln-identity
if [[ ! -s $IDKEY ]]; then
    ( umask 077; openssl genpkey -algorithm ed25519 -out "$IDKEY.new" 2>/dev/null ) || die "couldn't make the gate's identity key"
    chown root:root "$IDKEY.new"; chmod 600 "$IDKEY.new"
    mv "$IDKEY.new" "$IDKEY"
    say ok "made the key the gate signs what apps are told with ($IDKEY)"
fi
chown root:root "$IDKEY"; chmod 600 "$IDKEY"    # every install, not only the first
install -d -o root -g root -m 755 "$IDPUB_DIR"
# the raw 32 bytes of the public key, base64url (the last 32 of its DER)
idpub=$(openssl pkey -in "$IDKEY" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')
[[ $idpub =~ ^[A-Za-z0-9_-]{43}$ ]] || die "couldn't read the public half of $IDKEY"
if [[ $(cat "$IDPUB_DIR/identity.pub" 2>/dev/null) != "$idpub" ]]; then
    printf '%s\n' "$idpub" > "$IDPUB_DIR/identity.pub.new"
    chown root:root "$IDPUB_DIR/identity.pub.new"; chmod 644 "$IDPUB_DIR/identity.pub.new"
    mv "$IDPUB_DIR/identity.pub.new" "$IDPUB_DIR/identity.pub"
    say ok "the gate's public key for apps: $IDPUB_DIR/identity.pub"
fi

# ---------------------------------------------------------------- 2a''. nginx's edge secret (docs/s1-plan.md S1c)
# Before the services start (they load it) and before nginx's files include it (7, 8).
source "$P/deploy/edge-secret.sh"
source "$P/deploy/gate-door.sh"      # gate_door_refuses (S2)
make_edge_secret "$ETC" /etc/nginx/lfdln-panel
# the first time, the panel and the gate are held on the old way until nginx sends it (after 8)
edge_hold "$P/tools" "$ETC" /etc/nginx/lfdln-panel lfdln-panel "$PORT" lfdln-gate "$GATE_PORT"

# ---------------------------------------------------------------- 2b. a dump before anything changes it
dump_file=
if out=$( (cd / && runuser -u "$PG_SVC" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$PG_SVC")" HOME="$PG_SVC_HOME" \
        "$PG_SVC_HOME/bin/backup-lfdln-pg.sh" "before-$new_build") 2>&1); then
    dump_file=${out##*: }
    say ok "database dumped before this install ($(basename "$dump_file"))"
else
    say FAIL "$out" >&2
    die "couldn't dump lfdln's database -- nothing else has been changed"
fi
accounts() {
    pg_as owner -c "WITH u AS (SELECT string_agg(id || ':' || username || ':' || role || ':' || active, ',' ORDER BY id) s FROM panel.users),
                         k AS (SELECT string_agg(id || ':' || user_id || ':' || credential_id || ':' || encode(public_key, 'hex'), ',' ORDER BY id) s FROM panel.passkeys)
                    SELECT (SELECT count(*) FROM panel.users) || ' accounts, ' || (SELECT count(*) FROM panel.passkeys) || ' passkeys, '
                        || substr(md5(coalesce(u.s, '') || '|' || coalesce(k.s, '')), 1, 12) FROM u, k" 2>/dev/null || echo none
}
accounts_before=$(accounts)

# ---------------------------------------------------------------- 3. code (root-owned: the service can't change itself)
old_build=$(tail -1 "$APP/BUILD" 2>/dev/null || echo none)
rm -rf "$APP.new"
cp -a "$REL" "$APP.new"
setfacl -R -b "$APP.new" 2>/dev/null || true
chown -R root:root "$APP.new"
chmod -R u=rwX,go=rX "$APP.new"
if [[ $old_build == "$new_build" && -d $APP.prev ]]; then
    rm -rf "$APP"      # the same build again: the version before it stays the one to go back to
else
    rm -rf "$APP.prev"
    [[ -d $APP ]] && mv "$APP" "$APP.prev"
fi
mv "$APP.new" "$APP"
say ok "code $old_build -> $new_build in $APP"

# ---------------------------------------------------------------- 3b. the schema (only the installer migrates)
if out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/migrate.ts" --password-file "$PASS_DIR/owner.pass" --port "$PG_PORT" --database "$PG_DB" 2>&1); then
    if grep -q 'ran ' <<<"$out"; then sed 's/^/  /' <<<"$out"; else say ok "database schema: up to date"; fi
else
    sed 's/^/  /' <<<"$out" >&2
    rm -rf "$APP"; [[ -d $APP.prev ]] && mv "$APP.prev" "$APP"
    die "the migrations failed -- the previous code is back; the dump above is the database before"
fi

# ---------------------------------------------------------------- 4. settings, command line, PHP's config
install -d -o root -g root -m 755 "$ETC" "$PHP_ETC"
install -m 644 -o root -g root "$D/panel.env" "$ETC/panel.env"
install -m 755 -o root -g root "$D/lfdln-panel-cli" /usr/local/sbin/lfdln-panel
install -m 644 -o root -g root "$D/php/php-fpm.conf" "$PHP_ETC/php-fpm.conf"
install -m 644 -o root -g root "$P/deploy/php/php.ini" "$PHP_ETC/php.ini"
say ok "settings $ETC/panel.env, command line /usr/local/sbin/lfdln-panel, PHP's $PHP_ETC"

# the site's own domain as a row (docs/domains-hosts-plan.md step 1): made from the profile
# the first time, never changed after; the hosts already there are put on it
seeded=$(lfdln-panel seed-domain 2>&1) || { echo "$seeded" >&2; die "the domain's row couldn't be made (the schema is migrated; nothing else changed)"; }
say ok "domain: $seeded"

# ---------------------------------------------------------------- 5. the site folders' trash
# Inside the site folders as .trash (a dot-name: never listed, never routed), so a folder
# goes there in one rename. The folders' own root is the stopgap's until step 3 takes it over.
install -d -o "$SITES_USER" -g "$SITES_GROUP" -m 700 "$TRASH"
say ok "trash $TRASH ($SITES_USER's, 700)"

# ---------------------------------------------------------------- 5b. the thumbnails (docs/phase8-plan.md step 8-1)
# The panel writes them (and the media API's index, step 8-3), the gate will only read them:
# the panel's user's, group the gate's (the panel's own until the gate's user exists), setgid.
MEDIA_GROUP=$(getent group "$GATEU" >/dev/null && echo "$GATEU" || echo "$SVC")
install -d -o "$SVC" -g "$MEDIA_GROUP" -m 2750 "$MEDIA_PUBLIC" "$MEDIA_PUBLIC/thumbs"
chown -R "$SVC:$MEDIA_GROUP" "$MEDIA_PUBLIC"
find "$MEDIA_PUBLIC" -type f -exec chmod 640 {} +
say ok "$MEDIA_PUBLIC ($SVC's, group $MEDIA_GROUP, 2750)"

# ---------------------------------------------------------------- 5c. the Studio's helper: its user and its clients (step 8-4)
# Before the panel starts: a process gets its groups when it starts. The gate's user is made
# here too if this is its first install (6d makes it the same way, and then leaves it be).
if ! id "$STUDIOU" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$STUDIOU"
    say ok "created system user $STUDIOU"
fi
if ! id "$GATEU" >/dev/null 2>&1; then
    useradd --system --home-dir "$GATE_HOME" --create-home --user-group --shell /usr/sbin/nologin "$GATEU"
    say ok "created system user $GATEU"
fi
getent group "$PAMMYDB_CLIENTS" >/dev/null || { groupadd --system "$PAMMYDB_CLIENTS"; say ok "group $PAMMYDB_CLIENTS"; }
# the panel's user only: the gate leaves the group in 6d, just before it restarts onto its own
# door (S2, docs/s2-plan.md; expand, then contract)
for u in "$SVC"; do
    if ! id -nG "$u" | tr ' ' '\n' | grep -qx "$PAMMYDB_CLIENTS"; then
        usermod -aG "$PAMMYDB_CLIENTS" "$u"
        say ok "$u may open the database helper's socket (group $PAMMYDB_CLIENTS)"
    fi
done
for u in "${PAMMYDB_UNITS[@]}"; do install -m 644 -o root -g root "$D/$u" "/etc/systemd/system/$u"; done

# ---------------------------------------------------------------- 6. services
for u in "${UNITS[@]}"; do install -m 644 -o root -g root "$D/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
# installs one after another (--take-over-host, host by host) start the helpers many times a
# minute: their start limits are for crash loops, not for this, so each install begins afresh
systemctl reset-failed lfdln-panel.service lfdln-sitefs.service lfdln-thumbs.service lfdln-php.service lfdln-routes.service lfdln-services.service lfdln-projects.service 2>/dev/null || true
systemctl enable -q lfdln-sitefs.socket lfdln-thumbs.socket lfdln-php.service lfdln-panel.service
systemctl restart lfdln-sitefs.socket lfdln-thumbs.socket
systemctl stop lfdln-sitefs.service lfdln-thumbs.service 2>/dev/null || true     # the next request starts this release's
systemctl restart lfdln-php.service
systemctl restart lfdln-panel.service

healthy() {
    local i
    for i in $(seq 40); do
        curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break
        sleep 0.5
    done
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" || return 1
    systemctl is-active -q lfdln-php.service || return 1
    # the folder helper, asked the way the panel asks it
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
      const r = await callSiteFs('/run/lfdln-sitefs.sock', { op: 'list', actor: 'lfdln installer' });
      if (!Array.isArray(r.folders)) process.exit(1);") >/dev/null 2>&1 || return 1
    # the thumbnail service, with both of its tools (a rolled-back version has none)
    [[ -f $APP/sites/lfdln/src/helpers/thumbs.ts ]] || return 0
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callSiteFs } from '$APP/packages/files/src/sitefs/client.ts';
      const r = await callSiteFs('/run/lfdln-thumbs.sock', { op: 'tools', actor: 'lfdln installer' });
      if (r.pdftoppm !== true) process.exit(1);") >/dev/null 2>&1 || return 1
}
if ! healthy; then
    say FAIL "the new version didn't come up healthy: journalctl -u lfdln-panel -u lfdln-sitefs -u lfdln-php -n 50" >&2
    # the same build installed again: the version kept as the way back is older than the
    # schema this one has migrated to, so going back would break more than it mends
    [[ $old_build == "$new_build" ]] && die "this build was already installed and ran; nothing put back (the version before it can't run on this schema)"
    if [[ -d $APP.prev ]]; then
        rm -rf "$APP.failed"; mv "$APP" "$APP.failed"; mv "$APP.prev" "$APP"
        systemctl stop lfdln-sitefs.service lfdln-thumbs.service 2>/dev/null || true
        # the previous version predates thumbnails: nothing asks for them
        [[ -f $APP/sites/lfdln/src/helpers/thumbs.ts ]] || systemctl disable --now -q lfdln-thumbs.socket 2>/dev/null || true
        systemctl restart lfdln-panel.service
        die "put the previous version back ($(tail -1 "$APP/BUILD")); the failed one is in $APP.failed"
    fi
    die "the first version didn't start; nothing to go back to (its code stays in $APP)"
fi
say ok "panel healthy on 127.0.0.1:$PORT; folder helper, thumbnails and PHP answering"
# the Studio's helper (step 8-4): only once its passwords exist, which install-appdb.sh and
# install-appmaria.sh make (with the studio logins); until then it is off and the Studio says so
systemctl reset-failed lfdln-pammydb.service 2>/dev/null || true
if [[ -s $STUDIO_CRED && -s $STUDIO_MARIA_CRED ]]; then
    systemctl reset-failed lfdln-pammydb-gate.service 2>/dev/null || true
    systemctl enable -q lfdln-pammydb.socket lfdln-pammydb-gate.socket
    systemctl restart lfdln-pammydb.socket lfdln-pammydb-gate.socket
    systemctl try-restart lfdln-pammydb.service lfdln-pammydb-gate.service    # this release's code; otherwise it starts on first use
    if (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
          import { callPammyDb } from '$APP/packages/studio/src/pammydb/client.ts';
          const r = await callPammyDb('/run/lfdln-pammydb.sock', { op: 'list-databases', actor: 'lfdln installer' });
          for (const k of ['postgres', 'mariadb']) if (!r.engines?.some((e) => e.engine === k && e.ok)) process.exit(1);") >/dev/null 2>&1; then
        say ok "the Studio's helper answers (lfdln-pammydb: lfdln-appdb on :5436, lfdln-appmaria on :3308)"
    else
        say FAIL "the Studio's helper doesn't reach lfdln-appdb and lfdln-appmaria (the panel is fine; the Studio isn't): journalctl -u lfdln-pammydb -n 30" >&2
    fi
    # the gate's door (S2), asked as the gate's user: it is up, and refuses what isn't a row op.
    # If not, the gate is not switched to it (6d) and the install fails at the end (review L4).
    if gate_door_refuses runuser -u "$GATEU" -- env -C / /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
          import { callPammyDb } from '$APP/packages/studio/src/pammydb/client.ts';
          try { await callPammyDb('$PAMMYDB_GATE_SOCK', { op: 'list-databases', actor: 'lfdln installer' }); console.log('answered'); }
          catch (e) { console.log(e.code + ': ' + e.message); process.exitCode = 1; }"; then
        say ok "the gate's door to the helper answers, row ops only (lfdln-pammydb-gate)"
    else
        gate_door=no
        say FAIL "the gate's door to the database helper doesn't answer as it should: the gate stays on the panel's door for now (journalctl -u lfdln-pammydb-gate -n 30)" >&2
    fi
else
    systemctl disable --now -q lfdln-pammydb.socket lfdln-pammydb-gate.socket 2>/dev/null || true
    say note "no $STUDIO_CRED or $STUDIO_MARIA_CRED yet, so the Studio's helper is off: run install-appdb.sh and appmaria/install-appmaria.sh, then this again"
fi
accounts_after=$(accounts)
# (a first install had no tables to read before: "none")
[[ $accounts_before == none || $accounts_after == "$accounts_before" ]] || die "accounts or passkeys changed during the install ($accounts_before -> $accounts_after)"
say ok "accounts and passkeys untouched ($accounts_after)"

# ---------------------------------------------------------------- 6b. services (docs/adopt-plan.md V7)
# What already runs (TutorStar, the Gonsalves apps) taken in: what systemd says of each
# unit written into the services helper's record, and nothing of them changed (A1).
# Then the helper (root, no capabilities, nothing writable, 127.0.0.1 only) behind its
# socket, which only the panel's user may open.
install -d -o root -g root -m 700 "$SERVICES_STATE"
(cd / && /usr/bin/node --disable-warning=ExperimentalWarning "$APP/sites/lfdln/src/helpers/services-adopt.ts" "$SERVICES_STATE/services.json") \
    | sed 's/^/  /' || die "taking in the services failed (their record is as it was; nothing of them changed)"
for u in "${SERVICES_UNITS[@]}"; do install -m 644 -o root -g root "$APP/packages/services/deploy/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl enable -q lfdln-services.socket
systemctl restart lfdln-services.socket
systemctl stop lfdln-services.service 2>/dev/null || true     # the next request starts this release's
say ok "services helper ready (lfdln-services.socket; its record $SERVICES_STATE/services.json)"

# ---------------------------------------------------------------- 6b2. projects (docs/phase8b-plan.md step 8b-1)
# The projects helper (root, no capabilities, writes only /var/lib/lfdln-projects, 127.0.0.1
# only) behind its socket, which only the panel's user may open. Not stopped while a job
# runs: the new release's helper takes over at its next start.
for u in "${PROJECTS_UNITS[@]}"; do install -m 644 -o root -g root "$APP/packages/projects/deploy/$u" "/etc/systemd/system/$u"; done
# 8b-3: the git hook's spool (root:lfdln-git 1730), made again at every boot by tmpfiles; a
# push waiting there starts the helper (the path unit)
install -m 644 -o root -g root "$APP/packages/projects/deploy/lfdln-projects.tmpfiles" /etc/tmpfiles.d/lfdln-projects.conf
systemd-tmpfiles --create /etc/tmpfiles.d/lfdln-projects.conf
systemctl daemon-reload
systemctl enable -q lfdln-projects.socket lfdln-projects-pushes.path
systemctl restart lfdln-projects.socket lfdln-projects-pushes.path
if [[ $(systemctl is-active lfdln-projects.service 2>/dev/null) == active ]] && \
   [[ $(printf '{"op":"info"}\n' | timeout 10 socat - UNIX-CONNECT:/run/lfdln-projects.sock 2>/dev/null) == *'"busy":true'* ]]; then
    say note "a project job is running: the projects helper keeps it; this release's starts after"
else
    systemctl stop lfdln-projects.service 2>/dev/null || true
    # asked once, so this release's helper starts now: it shares projects made before 8b-3 with
    # their owners (D3-9) and watches the spool
    printf '{"op":"info"}\n' | timeout 30 socat - UNIX-CONNECT:/run/lfdln-projects.sock >/dev/null 2>&1 || say note "the projects helper didn't answer at once"
fi
say ok "projects helper ready (lfdln-projects.socket, lfdln-projects-pushes.path; its record /var/lib/lfdln-projects/projects.json)"
# Git over HTTPS (8b-7, D7-5): git-http-backend under fcgiwrap as svc-lfdln-apps, behind a
# socket only nginx may open; stopped so this release's units start it at the next request
for u in "${GIT_UNITS[@]}"; do install -m 644 -o root -g root "$APP/packages/projects/deploy/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl enable -q lfdln-git-http.socket
systemctl stop lfdln-git-http.service 2>/dev/null || true
systemctl restart lfdln-git-http.socket
say ok "git over HTTPS ready (lfdln-git-http.socket: fcgiwrap as svc-lfdln-apps)"
# The build boxes' one way out (docs/phase8b-plan.md 8b-8b, P8b-11): the internal network
# lfdln-build and lfdln-build-proxy on it, svc-lfdln-apps' own Quadlets; restarted with each
# release (it runs this release's packages/projects/container/proxy.mjs and its allow-list)
APPS_HOME=/var/lib/svc-lfdln-apps
APPS_QD=$APPS_HOME/.config/containers/systemd
for d_ in "$APPS_HOME/.config" "$APPS_HOME/.config/containers" "$APPS_QD"; do install -d -o svc-lfdln-apps -g svc-lfdln-apps -m 700 "$d_"; done
# the proxy looks names up at the server's own resolvers (not the internal network's forwarder)
RESOLVERS=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ && $2 !~ /^127\./ {print $2}' /run/systemd/resolve/resolv.conf 2>/dev/null | head -3 | paste -sd, -)
install -m 644 -o svc-lfdln-apps -g svc-lfdln-apps "$APP/packages/projects/deploy/lfdln-build.network" "$APPS_QD/lfdln-build.network"
sed "s|__RESOLVERS__|${RESOLVERS}|" "$APP/packages/projects/deploy/lfdln-build-proxy.container" > "$APPS_QD/lfdln-build-proxy.container.new"
chown svc-lfdln-apps:svc-lfdln-apps "$APPS_QD/lfdln-build-proxy.container.new"; chmod 644 "$APPS_QD/lfdln-build-proxy.container.new"
mv -f "$APPS_QD/lfdln-build-proxy.container.new" "$APPS_QD/lfdln-build-proxy.container"
systemctl --user -M svc-lfdln-apps@ daemon-reload
systemctl --user -M svc-lfdln-apps@ restart lfdln-build-proxy.service || true
for i in $(seq 30); do systemctl --user -M svc-lfdln-apps@ is-active -q lfdln-build-proxy.service && break; sleep 1; done
# (not a die: the rest of the install still has to happen; builds wait for it, verify says so)
if systemctl --user -M svc-lfdln-apps@ is-active -q lfdln-build-proxy.service; then
    say ok "the builds' proxy runs (lfdln-build-proxy on the internal network lfdln-build: the registries only)"
else
    say FAIL "lfdln-build-proxy didn't start, so builds can't reach the registries: systemctl --user -M svc-lfdln-apps@ status lfdln-build-proxy"
fi

# ---------------------------------------------------------------- 6c. mail (docs/accounts-plan.md step 2)
# lfdln-mail: its own user, settings and key. The key is a copy of pammy.org's (the same
# Resend account and verified domain, decided 2026-09-26), taken only while lfdln has none;
# after that it's lfdln's own file. Its second door, lfdln-mail-visitor.socket, is the gate's
# (accounts step 4): the fixed visitor emails only, and only $GATEU may open it --
# so that user is made here if the gate's section (6d) hasn't made it yet.
if ! id "$MAILU" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --user-group --shell /usr/sbin/nologin "$MAILU"
    say ok "created system user $MAILU"
fi
install -d -o root -g root -m 755 "$MAIL_ETC"
if [[ ! -s $MAIL_ETC/resend.key && -s /etc/pammy-mail/resend.key ]]; then
    install -m 600 -o root -g root /etc/pammy-mail/resend.key "$MAIL_ETC/resend.key"
    say ok "Resend key copied from pammy.org's ($MAIL_ETC/resend.key, root 600)"
fi
[[ -e $MAIL_ETC/resend.key ]] || install -m 600 -o root -g root /dev/null "$MAIL_ETC/resend.key"
chmod 600 "$MAIL_ETC/resend.key"; chown root:root "$MAIL_ETC/resend.key"
if [[ ! -e $MAIL_ETC/settings.json ]]; then
    printf '{\n "from": "noreply@mail.lesfleursdelanuit.com",\n "replyTo": "owner@example.com",\n "notifyTo": "owner@example.com"\n}\n' > "$MAIL_ETC/settings.json"
    chmod 644 "$MAIL_ETC/settings.json"
    say ok "mail settings started in $MAIL_ETC (replies and notices to owner@example.com)"
fi
if ! id "$GATEU" >/dev/null 2>&1; then
    useradd --system --home-dir "$GATE_HOME" --create-home --user-group --shell /usr/sbin/nologin "$GATEU"
    say ok "created system user $GATEU"
fi
for u in "${MAIL_UNITS[@]}"; do install -m 644 -o root -g root "$D/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl reset-failed lfdln-mail.service 2>/dev/null || true
systemctl stop lfdln-mail.service 2>/dev/null || true     # its sockets are handed over again below
systemctl enable -q lfdln-mail.socket lfdln-mail-visitor.socket
systemctl restart lfdln-mail.socket lfdln-mail-visitor.socket
systemctl stop lfdln-mail.service 2>/dev/null || true     # the next request starts this release's
if [[ -s $MAIL_ETC/resend.key ]]; then say ok "mail service ready (lfdln-mail.socket, and lfdln-mail-visitor.socket for the gate; try: sudo lfdln-panel mail-status)"
else say note "mail service installed, but it has no Resend key: put one in $MAIL_ETC/resend.key (root 600)"; fi

# ---------------------------------------------------------------- 6d. the gate (docs/accounts-plan.md step 3)
# lfdln-gate: visitor accounts and the areas they sign in to, as pammy-gate is for
# pammy.org. Its own user (a home for its saved areas, 700), the database role pammy_gate
# on lfdln-pg (its password from install-pg.sh), 127.0.0.1:3047, and an admin door only
# the panel's user may open. nginx sends it nothing yet: an area on a host comes with
# roles step 5, so no host's nginx file changes here.
if ! id "$GATEU" >/dev/null 2>&1; then
    useradd --system --home-dir "$GATE_HOME" --create-home --user-group --shell /usr/sbin/nologin "$GATEU"
    say ok "created system user $GATEU"
fi
install -d -o "$GATEU" -g "$GATEU" -m 700 "$GATE_HOME"
[[ -s $PASS_DIR/gate.pass ]] || die "no $PASS_DIR/gate.pass (install-pg.sh makes it)"
for u in "${GATE_UNITS[@]}"; do install -m 644 -o root -g root "$D/$u" "/etc/systemd/system/$u"; done
# the gate's door didn't answer (6): the gate stays on the panel's door and in its group (S2 review L4)
if [[ $gate_door == no ]]; then
    sed -i "s#^Environment=GATE_PAMMYDB_SOCKET=.*#Environment=GATE_PAMMYDB_SOCKET=/run/lfdln-pammydb.sock#" /etc/systemd/system/lfdln-gate.service
    usermod -aG "$PAMMYDB_CLIENTS" "$GATEU"
fi
systemctl daemon-reload
systemctl reset-failed lfdln-gate.service 2>/dev/null || true
systemctl enable -q lfdln-gate-admin.socket lfdln-gate-php.socket lfdln-gate.service
systemctl restart lfdln-gate-admin.socket lfdln-gate-php.socket
# S2 (docs/s2-plan.md), the contract half: the gate's door is up (6, above), so the gate's user
# leaves the panel's group now, and the gate restarts without it, onto its own door. (Its groups
# are the ones it starts with: the gate still running had them until this restart.)
if [[ $gate_door == yes ]] && id -nG "$GATEU" | tr ' ' '\n' | grep -qx "$PAMMYDB_CLIENTS"; then
    gpasswd -d "$GATEU" "$PAMMYDB_CLIENTS" >/dev/null
    say ok "$GATEU left $PAMMYDB_CLIENTS: it asks the database helper at its own door, row ops only ($PAMMYDB_GATE_SOCK)"
fi
systemctl restart lfdln-gate.service
gate_ok() {
    local i code=
    for i in $(seq 40); do
        # a check without nginx's headers is refused (403): it answers, and fails closed
        code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GATE_PORT/check" 2>/dev/null || true)
        [[ $code == 403 ]] && break
        sleep 0.5
    done
    [[ $code == 403 ]] || return 1
    # its admin door, asked the way the panel asks it; "state" needs the database
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { callJsonLine } from '$APP/packages/core/src/jsonline.ts';
      for (let i = 0; i < 20; i++) {
        try { const r = await callJsonLine('/run/lfdln-gate-admin.sock', { op: 'state' }, 'gate'); if (Array.isArray(r.areas)) process.exit(0); } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.exit(1);") >/dev/null 2>&1 || return 1
}
gate_ok || die "the gate didn't come up (nothing depends on it yet; the panel is fine): journalctl -u lfdln-gate -n 50"
say ok "gate ready on 127.0.0.1:$GATE_PORT (lfdln-gate; admin door lfdln-gate-admin.socket); every host sends /_pammy/ to it, and asks it about the routes with accounts"

# ---------------------------------------------------------------- 7. nginx: panel.lesfleursdelanuit.com
# An exact server_name, so it wins over the stopgap catch-all's regex (and, from step 3,
# the hosts' catch-all). One nginx -t; the file as it was put back if nginx says no.
# 8b-7: git.lesfleursdelanuit.com (git over HTTPS, lfdln-git) goes in with it, under the same
# nginx -t, and both are put back if nginx says no.
if ! cmp -s "$RENDERED/site/panel.conf" "$NGX_SITE" || [[ ! -L $NGX_LINK ]] \
   || ! cmp -s "$RENDERED/site/git.conf" "$NGX_GIT" || [[ ! -L $NGX_GIT_LINK ]]; then
    had_site=no; [[ -f $NGX_SITE ]] && { had_site=yes; cp -a "$NGX_SITE" "$RENDERED/site-before.conf"; }
    had_link=no; [[ -L $NGX_LINK ]] && had_link=yes
    had_git=no; [[ -f $NGX_GIT ]] && { had_git=yes; cp -a "$NGX_GIT" "$RENDERED/git-before.conf"; }
    had_git_link=no; [[ -L $NGX_GIT_LINK ]] && had_git_link=yes
    install -m 644 -o root -g root "$RENDERED/site/panel.conf" "$NGX_SITE"
    ln -sfn "$NGX_SITE" "$NGX_LINK"
    install -m 644 -o root -g root "$RENDERED/site/git.conf" "$NGX_GIT"
    ln -sfn "$NGX_GIT" "$NGX_GIT_LINK"
    if ! nginx -t -q 2>"$RENDERED/nginx-t"; then
        if [[ $had_site == yes ]]; then cp -a "$RENDERED/site-before.conf" "$NGX_SITE"; else rm -f "$NGX_SITE"; fi
        [[ $had_link == yes ]] || rm -f "$NGX_LINK"
        if [[ $had_git == yes ]]; then cp -a "$RENDERED/git-before.conf" "$NGX_GIT"; else rm -f "$NGX_GIT"; fi
        [[ $had_git_link == yes ]] || rm -f "$NGX_GIT_LINK"
        cat "$RENDERED/nginx-t" >&2
        die "nginx refused the panel's or git's site file; nginx is as it was"
    fi
    systemctl reload nginx
    say ok "nginx serves panel.lesfleursdelanuit.com and git.lesfleursdelanuit.com (site files lfdln-panel, lfdln-git)"
else
    say ok "nginx: panel.lesfleursdelanuit.com and git.lesfleursdelanuit.com as they were"
fi

# ---------------------------------------------------------------- 8. the hosts go live (H10, L6)
taken_over=no; [[ -L $HOSTS_LINK && ! -e $STOPGAP ]] && taken_over=yes
if [[ $taken_over == no && $TAKE_OVER == no ]]; then
    say note "the hosts aren't live yet: the stopgap catch-all still serves $SITES/<name>."
    say note "when the panel checks out: sudo $D/install-lfdln.sh --take-over"
else
    # the routing helper: root, writes only $HOSTS_DIR (packages/hosts/deploy)
    install -d -o root -g root -m 755 "$HOSTS_DIR"
    for u in "${ROUTES_UNITS[@]}"; do install -m 644 -o root -g root "$APP/packages/hosts/deploy/$u" "/etc/systemd/system/$u"; done
    systemctl daemon-reload
    systemctl enable -q lfdln-routes.socket
    systemctl restart lfdln-routes.socket
    systemctl stop lfdln-routes.service 2>/dev/null || true
    say ok "routing helper ready (lfdln-routes.socket, writes only $HOSTS_DIR)"
    # certbot's webroot challenges for a domain with named certificates (docs/domains-hosts-plan.md
    # 7-3): nginx serves /.well-known/acme-challenge/ from here on those hosts; certbot writes it
    install -d -o root -g root -m 755 "$ACME_ROOT"
    say ok "$ACME_ROOT is there (certbot's webroot, for gonsalvesfamily.com's certificate)"

    if [[ $taken_over == no ]]; then
        # nginx's workers take up www-data's new group (lfdln-sites) when they start again:
        # before the folders' root becomes 2750, or the stopgap would stop serving them
        systemctl reload nginx
        for i in $(seq 20); do
            w=$(pgrep -u www-data -f 'nginx: worker' | head -1)
            [[ -n $w ]] && grep -q "^Groups:.*\b$(getent group "$SITES_GROUP" | cut -d: -f3)\b" "/proc/$w/status" && break
            sleep 0.5
        done
        grep -q "^Groups:.*\b$(getent group "$SITES_GROUP" | cut -d: -f3)\b" "/proc/$(pgrep -u www-data -f 'nginx: worker' | head -1)/status" \
            || die "nginx's workers aren't in $SITES_GROUP after a reload: nothing taken over"

        # hello/ (Q4): to the trash, as the panel would, gone for good in 30 days
        if [[ -d $SITES/hello ]]; then
            entry="hello--$(date -u +%Y%m%dT%H%M%SZ)"
            mv "$SITES/hello" "$TRASH/$entry"
            chown -R "$SITES_USER:$SITES_GROUP" "$TRASH/$entry"
            say ok "hello/ is in the trash ($TRASH/$entry, gone for good in 30 days)"
        fi
        # the folders' root: the folder helper's user's, 2750, lfdln-sites (D3, F3). What is
        # already in it keeps its owner, and becomes readable to the group (so nginx still can)
        chown "$SITES_USER:$SITES_GROUP" "$SITES"
        chmod 2750 "$SITES"
        for f in "$SITES"/*; do
            [[ -d $f && ! -L $f ]] || continue
            chgrp -R "$SITES_GROUP" "$f"; chmod -R g+rX "$f"
            find "$f" -type d -exec chmod g+s {} +
        done
        say ok "$SITES is $SITES_USER:$SITES_GROUP 2750"
    fi

    # every folder in it a site folder (adopted), and the routing helper's files written
    # (not yet included by nginx on the first run); prints what it did
    lfdln-panel adopt-folders | sed 's/^/  /' || die "adopting the folders failed (nothing written; nginx unchanged)"

    if [[ $taken_over == no ]]; then
        # one switch: the routing helper's files in, the stopgap out, one nginx -t
        [[ -f $HOSTS_DIR/site.conf ]] || die "the routing helper wrote no $HOSTS_DIR/site.conf"
        stopgap_target=$(readlink "$STOPGAP")
        ln -sfn "$HOSTS_DIR/site.conf" "$HOSTS_LINK"
        rm -f "$STOPGAP"
        if ! nginx -t -q 2>"$RENDERED/nginx-t-hosts"; then
            rm -f "$HOSTS_LINK"; ln -sfn "$stopgap_target" "$STOPGAP"
            cat "$RENDERED/nginx-t-hosts" >&2
            die "nginx refused the hosts' files; the stopgap is back as it was (the site folders stay the folder helper's)"
        fi
        systemctl reload nginx
        say ok "the hosts are live: nginx serves lfdln's hosts from $HOSTS_DIR; the stopgap catch-all is off (its file stays in sites-available)"
    else
        say ok "the hosts: live since the takeover; the routing helper's files are up to date"
    fi
fi

# ---------------------------------------------------------------- 8, continued. the edge secret: nginx sends it now (S1c)
edge_release "$P/tools" "$ETC" /etc/nginx/lfdln-panel lfdln-panel "$PORT" lfdln-gate "$GATE_PORT"

# ---------------------------------------------------------------- 8b. a hand-written host becomes the panel's (docs/adopt-plan.md V5, V6)
# Its files copied into the site folders (svc-lfdlnsites's, 2750/640) and compared file by
# file, the old folder left where it is for 14 days (the way back); then the panel's command
# line asks the live host its requests, switches (the routing helper writes the panel's block
# and takes the hand-written link out, one nginx -t), asks again, and puts the hand-written
# link back if any answer differs. The hand-written file stays in sites-available.
take_over_host() {
    local name=$1 link folder= from=
    case $name in
        instastylr) link=instastylr; folder=instastylr; from=/var/www/instastylr ;;
        lesfleursdelanuit.com|@|apex) name=lesfleursdelanuit.com; link=lesfleursdelanuit; folder=home; from=/var/www/lesfleursdelanuit ;;
        tutor) link=tutorstar ;;
        # (docs/domains-hosts-plan.md step 7: services, so nothing is copied; their domain is added first)
        gonsalvesfamily.com|gonsalves) name=gonsalvesfamily.com; link=gonsalves-public ;;
        admin.gonsalvesfamily.com) link=gonsalves-admin ;;
        *) die "$name isn't one the panel takes over (instastylr, lesfleursdelanuit.com, tutor, gonsalvesfamily.com, admin.gonsalvesfamily.com)" ;;
    esac
    [[ -L $HOSTS_LINK ]] || die "the hosts aren't live yet: install with --take-over first"
    if [[ -n $folder && -L /etc/nginx/sites-enabled/$link ]]; then
        [[ -d $from ]] || die "$from isn't there to copy"
        local dest=$SITES/$folder
        rsync -a --delete --no-owner --no-group "$from/" "$dest/"
        chown -R "$SITES_USER:$SITES_GROUP" "$dest"
        find "$dest" -type d -exec chmod 2750 {} +
        find "$dest" -type f -exec chmod 640 {} +
        sums() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum); }
        [[ $(sums "$from") == "$(sums "$dest")" ]] || die "$dest isn't the same as $from after copying: nothing taken over"
        say ok "$from copied into the site folder $folder ($(find "$dest" -type f | wc -l) files, the same bytes; the old folder stays for 14 days)"
    fi
    lfdln-panel take-over-host "$name" | sed 's/^/  /'
    [[ ${PIPESTATUS[0]} -eq 0 ]] || die "$name was not taken over: its hand-written file is back (the differences are above)"
}
for h in "${TAKE_HOSTS[@]}"; do take_over_host "$h"; done

# ---------------------------------------------------------------- 8b. the watchdog (docs/monitoring-plan.md step 3)
# Every 10 minutes, as root: the panel answers and its rounds of checks run (the file the
# round writes); if not, one notice through lfdln-mail's socket. Its first run is 10
# minutes after this, when the new panel has had its first rounds.
for u in "${WATCHDOG_UNITS[@]}"; do install -m 644 -o root -g root "$D/$u" "/etc/systemd/system/$u"; done
systemctl daemon-reload
systemctl enable -q lfdln-watchdog.timer
systemctl restart lfdln-watchdog.timer
say ok "watchdog on (lfdln-watchdog.timer, every 10 minutes; its log: journalctl -u lfdln-watchdog)"

# ---------------------------------------------------------------- 8c. the projects as this release makes them (docs/s1-plan.md S1d)
# Last, once nginx is as this release has it: each project's database addresses 127.0.0.1, its
# Quadlet pasta (its databases' ports only, no way to the rest of the server); a running one is
# put live again in its other slot (nginx switches once it answers; its env file changes only
# then), a stopped one starts so. One with 10.0.2.2 left in a variable is kept on slirp4netns
# and named. A helper still on the old release (a job was running at 6b2) doesn't know the
# request: the projects then move at the next install. Asked, then followed (25 minutes at most).
prj_ask() { printf '%s\n' "$1" | timeout 60 socat -t 60 - UNIX-CONNECT:/run/lfdln-projects.sock 2>/dev/null || true; }
refresh=$(prj_ask '{"op":"refresh","actor":"install-lfdln"}')
rid=$(jq -r '.result.job.id // empty' <<<"$refresh" 2>/dev/null)
if [[ $refresh == *'Unknown request'* ]]; then
    say note "the projects helper is still the old release's (a job was running): the projects move to pasta at the next install"
elif [[ -z $rid ]]; then
    say FAIL "the projects helper didn't take the request to move the projects (${refresh:0:300}): sudo journalctl -u lfdln-projects -n 30"
else
    say note "moving the projects to pasta (job $rid): each running one is put live again, one after the other"
    for _ in $(seq 300); do
        rj=$(prj_ask "{\"op\":\"job\",\"id\":\"$rid\"}")
        st=$(jq -r '.result.job.state // empty' <<<"$rj" 2>/dev/null)
        [[ $st == done || $st == failed ]] && break
        sleep 5
    done
    if [[ $st == done ]]; then
        jq -r '.result.job.result.projects[] | "  \(.result)  \(.project) \(.branch)\(if (.env | length) > 0 then " (\(.env | join(", ")) now at 127.0.0.1)" else "" end)\(if .left then ": \(.left | join(", ")) still name 10.0.2.2" else "" end)\(if .error then ": \(.error)" else "" end)"' <<<"$rj"
        failed=$(jq -r '.result.job.result.failed' <<<"$rj"); kept=$(jq -r '.result.job.result.kept' <<<"$rj")
        if [[ $kept != 0 ]]; then
            say note "$kept project branch(es) kept on slirp4netns (the whole server's 127.0.0.1): a variable above still names 10.0.2.2, which pasta can't reach. Set it to 127.0.0.1 (Projects > Environment), then Restart -- a restart or deploy moves it to pasta either way"
        fi
        if [[ $failed == 0 ]]; then
            say ok "projects on pasta: their databases at 127.0.0.1, nothing else of the server ($(jq -r '[.result.job.result.projects[] | select(.result == "redeployed")] | length' <<<"$rj") put live again)"
        else
            say FAIL "$failed project branch(es) didn't answer on pasta: each still runs its old slot, on slirp4netns, with its variables and env file as they were (above; its server log on its page)"
        fi
    elif [[ $st == failed ]]; then
        say FAIL "moving the projects stopped: $(jq -r '.result.job.error // "?"' <<<"$rj") (job $rid)"
    else
        say note "moving the projects is still running after 25 minutes: see job $rid (sudo journalctl -u lfdln-projects; verify may count it)"
    fi
fi

# ---------------------------------------------------------------- 9. the first account (L5)
if [[ $accounts_after == 0\ accounts* ]]; then
    say note "no accounts yet. The first admin: sudo lfdln-panel add-user momolig \"momolig\" --manager"
    say note "then: sudo lfdln-panel invite momolig   (a one-time link to set up a passkey)"
fi

# S2 review L4: the rest of the install went on; the gate's switch didn't
[[ $gate_door == yes ]] || die "the gate's door to the database helper didn't answer, so the gate is still on the panel's door (everything else is installed): journalctl -u lfdln-pammydb-gate -n 30, then install again"

echo
exec "$D/verify-lfdln.sh"
