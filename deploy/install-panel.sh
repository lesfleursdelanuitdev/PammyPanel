#!/usr/bin/env bash
# Install or update the pammy.org control panel at https://panel.pammy.org
#
#   ~/pamela-setup/panel/build.sh                        # as yourself: test + build release/
#   sudo ~/pamela-setup/panel/deploy/install-panel.sh    # deploy that release
#
# Safe to re-run. Checks everything it can before changing anything; if the new
# version doesn't come up healthy the previous one is put back, and if nginx
# rejects a config change nginx is left exactly as it was.
#
# Since phase 3 this also puts the password-protected-folder gate in front of
# her whole static site (the pamela vhost + WordPress placement includes). To
# take that back out in an emergency: sudo ~/pamela-setup/panel/deploy/rollback-gate-nginx.sh
#
# pammy.org onto its hosts (docs/phase8-plan.md 8-7c), in a window of momolig's:
#   sudo ~/pamela-setup/panel/deploy/install-panel.sh --switch-to-hosts
# asks the pamela site everything, swaps it for pammy-hosts in one nginx -t, asks again, and
# puts the pamela site back if any answer differs; then certbot stops renewing pammy.org's
# Let's Encrypt certificate (the origin certificate covers pammy.org now). The way back:
#   sudo ~/pamela-setup/panel/deploy/install-panel.sh --switch-back
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
SWITCH=no
for a in "$@"; do
    case $a in
        --switch-to-hosts) SWITCH=to ;;
        --switch-back) SWITCH=back ;;
        *) echo "unknown option $a (--switch-to-hosts, --switch-back)" >&2; exit 2 ;;
    esac
done
D="$(dirname "$(readlink -f "$0")")"       # not ~ : under sudo that is /root
P="$(readlink -f "$D/..")"

SVC=svc-pammypanel
SVC_HOME=/var/lib/svc-pammypanel
APP=/opt/pammy-panel
ETC=/etc/pammy-panel
NGX=/etc/nginx/pammy-panel
SITE=/etc/nginx/sites-available/pammy-panel
LINK=/etc/nginx/sites-enabled/pammy-panel
TRASH=/pamela/trash
PORT=3044
GATE=svc-pammygate
GATE_HOME=/var/lib/svc-pammygate
GATE_PORT=3045
GATE_NGX=/etc/nginx/pammy-gate
THUMBS=svc-pammythumbs
THUMBS_SOCK=/run/pammy-thumbs.sock
# the database helper for HER engines (docs/studio-plan.md): its own user, and the group
# whose members may open the panel's door (every op). Since S2 (docs/s2-plan.md) that is the
# panel's user only: the gate has a door of its own (pammy-pammydb-gate.socket, group
# svc-pammygate), served by a second helper that answers row ops only.
STUDIO=svc-pammystudio
PAMMYDB_CLIENTS=pammydb-clients
PAMMYDB_GATE_SOCK=/run/pammy-pammydb-gate.sock
# PHP pages on her website (docs/tutorials-plan.md P1-P7): their own user, cage and config
PHPU=svc-pammyphp
PHP_ETC=/etc/pammy-php
PAMMYDB_SOCK=/run/pammy-pammydb.sock
# the panel's own Postgres (docs/postgres-plan.md), installed by deploy/pg/install-pg.sh
PGSVC=svc-pammypanel-db
PASS_DIR=/etc/pammy-panel/db
# SQL as pammy_owner, the way the installer's own tools connect
pg_owner() { PGPASSWORD="$(cat "$PASS_DIR/owner.pass")" PGCONNECT_TIMEOUT=5 \
    psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p 5434 -U pammy_owner -d pammy "$@"; }
WPDIR="$(readlink -f "$P/../wordpress")"
VHOST=/etc/nginx/sites-available/pamela
WPNGX=/etc/nginx/pammy-wordpress
say() { printf '  %-4s %s\n' "$1" "$2"; }
die() { say FAIL "$1" >&2; declare -F edge_die_note >/dev/null && edge_die_note >&2; exit 1; }

# ---------------------------------------------------------------- preflight
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
[[ -f $P/release/BUILD ]] || die "no release -- run ~/pamela-setup/panel/build.sh first (as yourself, without sudo)"
if find "$P/src" "$P/packages" "$P/sites" "$P/public" "$P/public-gate" "$P/db" "$P/tools" "$P/tutorials" "$P/package-lock.json" -newer "$P/release/BUILD" -print -quit | grep -q .; then
    die "the source changed after the last build -- run build.sh again"
fi
while read -r guide _; do
    if [[ $P/../$guide -nt $P/release/BUILD ]]; then die "the guide $guide changed after the last build -- run build.sh again (the Help tab shows the guides)"; fi
done < <(grep -vE '^\s*(#|$)' "$P/../guides.map")
[[ ! $P/../guides.map -nt $P/release/BUILD ]] || die "guides.map changed after the last build -- run build.sh again (the Help tab reads it)"
# CI (docs/ci-plan.md T1-d, CI-Q4): did the commit this release was built from pass the full
# tier? Said, not enforced, for now.
ci_build_line=$(head -1 "$P/release/BUILD")
if [[ $ci_build_line == *+dirty* ]]; then echo "CI: a build with uncommitted changes ($ci_build_line): CI can't have checked it"
elif [[ -x /usr/local/bin/lfdln-ci ]] && ci_commit=$(sed -n 's/.* from commit \([0-9a-f]\{7,40\}\).*/\1/p' <<<"$ci_build_line") && [[ -n $ci_commit ]]; then
    /usr/local/bin/lfdln-ci check "$ci_commit" || echo "  (only a warning for now: docs/ci-plan.md CI-Q4; ask for it with: lfdln-ci full $ci_commit)"
fi
# the software helper renders WordPress's nginx files from a copy of these (build.sh)
if find "$P/../wordpress/nginx/templates" "$P/../wordpress/nginx/proxy.conf" "$P/../wordpress/nginx/cookie-map.conf" -newer "$P/release/BUILD" -print -quit | grep -q .; then
    die "WordPress's nginx templates changed after the last build -- run build.sh again"
fi
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
    || die "/usr/bin/node is $(/usr/bin/node --version); the panel needs 22.18 or newer"
[[ -f /etc/ssl/cloudflare/pammy.org-wildcard.pem && -f /etc/ssl/cloudflare/pammy.org-wildcard.key ]] || die "wildcard origin cert missing"
# nginx's files for the panel and the gate, rendered from the site's profile by the
# release (docs/adapters-plan.md A4); installed in steps 6 and 7
(cd / && /usr/bin/node --disable-warning=ExperimentalWarning "$P/release/tools/render-nginx.ts" "$tmp/nginx" --cloudflare-ips "$D/cloudflare-ips.txt" >/dev/null) \
    || die "the release could not render nginx's files from the profile -- nothing changed"
# The panel and the gate keep everything in Postgres now: no database, no install.
command -v psql >/dev/null || die "psql is missing (apt install postgresql-client) -- the installer needs it to check the database"
for r in owner panel gate; do
    [[ -r $PASS_DIR/$r.pass ]] || die "$PASS_DIR/$r.pass is missing: install the database first (sudo $P/deploy/pg/install-pg.sh)"
done
id "$PGSVC" >/dev/null 2>&1 || die "no $PGSVC user: install the database first (sudo $P/deploy/pg/install-pg.sh)"
pg_owner -c 'SELECT 1' >/dev/null 2>&1 \
    || die "can't reach the panel's database on 127.0.0.1:5434 -- is it running? (systemctl --user -M $PGSVC@ status pammy-pg)"
nginx -t 2>/dev/null || die "nginx config is already broken before we start"
other=$(grep -RlE 'server_name[^;]*[[:space:]]panel\.pammy\.org[[:space:];]' /etc/nginx/sites-enabled/ /etc/nginx/pammy-wordpress/ 2>/dev/null \
        | grep -vx "$LINK" || true)
[[ -z $other ]] || die "panel.pammy.org is already served by: $other"
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active -q pammy-panel; then
    die "port $PORT is already in use by something else"
fi
id pamela >/dev/null 2>&1 && [[ -d /pamela/public ]] || die "no pamela user or /pamela/public"
if [[ -e $TRASH || -L $TRASH ]] && [[ "$(stat -c '%F %U' "$TRASH")" != "directory pamela" ]]; then
    die "$TRASH exists but isn't a folder owned by pamela -- not touching it"
fi
if ss -ltnH "sport = :$GATE_PORT" | grep -q . && ! systemctl is-active -q pammy-gate; then
    die "port $GATE_PORT is already in use by something else"
fi
getent group www-data >/dev/null || die "no www-data group"
# Media folders are only at the top of the site or one folder down (docs/media-plan.md
# D3/D4). One anywhere deeper is momolig's to sort out by hand, before anything changes.
deep_media=$(find /pamela/public -mindepth 3 -type d -name media -not -path '*/.*' \
    -not -path '/pamela/public/media/*' -not -path '/pamela/public/*/media/*' 2>/dev/null | head -20)
[[ -z $deep_media ]] || die "media folders deeper than one folder down (move them, or make them ordinary folders, first):
$deep_media"

# The pamela vhost and WordPress's main.conf must each be EXACTLY the version
# from before the gate, or exactly the gated one; anything else means someone
# changed them by hand, and we stop rather than overwrite that.
[[ -f $WPDIR/pamela-live-wp.nginx.pre-gate && -d $WPDIR/nginx/templates-pre-gate ]] || die "$WPDIR is missing the pre-gate copies"
placement=$(cat "$WPNGX/placement" 2>/dev/null || echo off)
render_includes() {  # render_includes <templates dir> <out dir>: main.conf + server.conf for the current placement
    local w; w=$(mktemp -d -p "$tmp")
    cp -r "$WPDIR" "$w/wp"
    cp "$1"/* "$w/wp/nginx/templates/"
    bash -c 'source "$1/lib.sh"; read -r mode name <<<"$2"; render_placement "$mode" "${name:-}" "$3" ""' _ "$w/wp" "$placement" "$2"
}
render_includes "$WPDIR/nginx/templates-pre-gate" "$tmp/inc-old"
render_includes "$WPDIR/nginx/templates" "$tmp/inc-new"
# With more than one WordPress (docs/apps-plan.md 4b) main.conf and server.conf
# hold every install's blocks, written by the software helper: what it would
# write for the installs in its record, with this release's renderer, is right too.
mkdir -p "$tmp/inc-helper"
if [[ -s /var/lib/pammy-apps/apps.json ]]; then
    /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { readFileSync, writeFileSync } from 'node:fs';
      import { basename } from 'node:path';
      import { renderAll } from '$P/release/src/apps/nginx.ts';
      import { parsePlacement } from '$P/release/src/apps/placement.ts';
      const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
      // an install that stopped before its address was written isn't in nginx yet
      const apps = JSON.parse(readFileSync('/var/lib/pammy-apps/apps.json', 'utf8')).apps.filter((a) => !a.setup || read(a.placementFile) !== null);
      const placed = apps.sort((x, y) => x.installedAt - y.installedAt || x.id.localeCompare(y.id)).map((a) => {
        const line = read(a.placementFile);
        return { id: a.id, port: a.port, placementFile: a.placementFile, adopted: a.layout === 'adopted-wordpress', placement: parsePlacement(line) ?? { mode: 'off', name: null } };
      });
      for (const [f, t] of renderAll('$P/release/apps/wordpress-nginx', placed)) if (/\/(main|server|proxy-[a-z0-9-]+)\.conf\$/.test(f)) writeFileSync('$tmp/inc-helper/' + basename(f), t);
    " 2>/dev/null || true
fi
if cmp -s "$VHOST" "$WPDIR/pamela-live-wp.nginx"; then vhost_state=gated
elif cmp -s "$VHOST" "$WPDIR/pamela-live-wp.nginx.pre-gate"; then vhost_state=old
else die "$VHOST matches neither the pre-gate nor the gated master -- changed by hand? nothing changed"; fi
if cmp -s "$WPNGX/main.conf" "$tmp/inc-new/main.conf" || cmp -s "$WPNGX/main.conf" "$tmp/inc-helper/main.conf"; then main_state=gated
elif cmp -s "$WPNGX/main.conf" "$tmp/inc-old/main.conf"; then main_state=old
else die "$WPNGX/main.conf ($placement) matches neither template set nor what the software helper writes -- changed by hand? nothing changed"; fi
cmp -s "$WPNGX/server.conf" "$tmp/inc-new/server.conf" || cmp -s "$WPNGX/server.conf" "$tmp/inc-helper/server.conf" \
    || die "$WPNGX/server.conf doesn't match its template or what the software helper writes -- nothing changed"

# The blog's proxy.conf (install-wordpress.sh's): this release's, or the same without S1e's
# Cookie line and its three comment lines -- anything else was changed by hand (step 7 replaces it)
if [[ -f $WPNGX/proxy.conf ]]; then
    sed '/^# the pammy.org gate.s visitor cookie never reaches WordPress/,/^proxy_set_header Cookie /d' "$P/release/apps/wordpress-nginx/proxy.conf" > "$tmp/proxy-before-s1e.conf"
    cmp -s "$WPNGX/proxy.conf" "$P/release/apps/wordpress-nginx/proxy.conf" || cmp -s "$WPNGX/proxy.conf" "$tmp/proxy-before-s1e.conf" \
        || die "$WPNGX/proxy.conf matches neither its template nor the one before S1e -- changed by hand? nothing changed"
fi

# ---------------------------------------------------------------- 1. identity
if ! id "$SVC" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$SVC_HOME" --create-home --shell /usr/sbin/nologin "$SVC"
    say ok "created system user $SVC"
fi
install -d -o "$SVC" -g "$SVC" -m 700 "$SVC_HOME"
if ! id "$GATE" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$GATE_HOME" --create-home --shell /usr/sbin/nologin "$GATE"
    say ok "created system user $GATE"
fi
install -d -o "$GATE" -g "$GATE" -m 700 "$GATE_HOME"
# the thumbnail service (docs/media-plan.md D19): a user with no home and nothing it owns
if ! id "$THUMBS" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$THUMBS"
    say ok "created system user $THUMBS"
fi
# the database helper (docs/studio-plan.md): like the thumbnail service, a user
# with no home and nothing of its own -- all it gets is two passwords, by
# LoadCredential=. It does NOT run as pamela.
if ! id "$STUDIO" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$STUDIO"
    say ok "created system user $STUDIO"
fi
# PHP (docs/tutorials-plan.md P2): like the thumbnail service, nothing of its own;
# the www-data group only while running. Before the units: its group owns the
# gate's PHP socket.
if ! id "$PHPU" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$PHPU"
    say ok "created system user $PHPU"
fi
# the mail service (docs/apps-plan.md phase 3): like the thumbnail service, a user
# with no home and nothing of its own -- it gets the Resend key by LoadCredential
MAILU=svc-pammymail
if ! id "$MAILU" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$MAILU"
    say ok "created system user $MAILU"
fi
# The panel's door to the database helper: only the panel's user is in its group. The
# gate used to be (studio-plan S2); since S2 of the security review (docs/s2-plan.md) it
# has its own door, and is taken out of this group in step 5, just before the gate restarts
# onto that door (expand, then contract: the running gate keeps the group it started with).
if ! getent group "$PAMMYDB_CLIENTS" >/dev/null; then
    groupadd --system "$PAMMYDB_CLIENTS"
    say ok "created group $PAMMYDB_CLIENTS"
fi
for u in "$SVC"; do
    if ! id -nG "$u" | tr ' ' '\n' | grep -qx "$PAMMYDB_CLIENTS"; then
        usermod -aG "$PAMMYDB_CLIENTS" "$u"
        say ok "$u may now ask the database helper"
    fi
done

# ---------------------------------------------------------------- 1, continued. what the panel publishes for the gate's media API (docs/media-api-plan.md M2)
# The panel writes (its index.db and the thumbnails), the gate only reads: owned by
# the panel's user, group the gate's, setgid so every new file is the gate's group.
MEDIA_PUBLIC=/var/lib/pammy-media-public
install -d -o "$SVC" -g "$GATE" -m 2750 "$MEDIA_PUBLIC" "$MEDIA_PUBLIC/thumbs"
if [[ -d $SVC_HOME/thumbs ]] && compgen -G "$SVC_HOME/thumbs/*.webp" >/dev/null; then
    find "$SVC_HOME/thumbs" -maxdepth 1 -name '*.webp' -exec mv -n -t "$MEDIA_PUBLIC/thumbs" {} +
    rmdir "$SVC_HOME/thumbs" 2>/dev/null || true
    say ok "moved the thumbnails to $MEDIA_PUBLIC/thumbs (the media API serves them from there)"
fi
chown -R "$SVC:$GATE" "$MEDIA_PUBLIC"
find "$MEDIA_PUBLIC" -type f -exec chmod 640 {} +

# ---------------------------------------------------------------- 1, continued. the tutorial examples' copies (docs/tutorial-examples-plan.md)
# The panel writes them when they are set up; pammy-php's second pool reads them.
# Owned by the panel's user, group PHP's, setgid so every new file is PHP's group.
TUTORIAL_EXAMPLES=/var/lib/pammy-tutorial-examples
install -d -o "$SVC" -g "$PHPU" -m 2750 "$TUTORIAL_EXAMPLES"
chown -R "$SVC:$PHPU" "$TUTORIAL_EXAMPLES"

# ---------------------------------------------------------------- 1a. the thumbnail tools: ffmpeg (video frames, cover art), poppler-utils (PDF pages)
missing=()
for pkg in ffmpeg poppler-utils; do dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg"); done
if (( ${#missing[@]} )); then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}" >"$tmp/apt.log" 2>&1 \
        || { tail -20 "$tmp/apt.log" >&2; die "couldn't install ${missing[*]} -- nothing else has been changed"; }
    say ok "installed ${missing[*]} (for thumbnails)"
fi
[[ -x /usr/bin/ffmpeg && -x /usr/bin/pdftoppm && -x /usr/bin/prlimit ]] || die "ffmpeg, pdftoppm or prlimit missing"

# ---------------------------------------------------------------- 1a, continued. PHP 8.3 (docs/tutorials-plan.md P1, P6)
# The distribution's php8.3-fpm service is masked BEFORE the package arrives, so
# it never starts, not even once: pammy-php is the only PHP that runs.
systemctl mask -q php8.3-fpm.service
missing=()
for pkg in php8.3-fpm php8.3-curl; do dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg"); done
if (( ${#missing[@]} )); then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}" >"$tmp/apt.log" 2>&1 \
        || { tail -20 "$tmp/apt.log" >&2; die "couldn't install ${missing[*]} -- nothing else has been changed"; }
    say ok "installed ${missing[*]} (for PHP pages)"
fi
[[ -x /usr/sbin/php-fpm8.3 ]] || die "php-fpm8.3 missing"
[[ $(systemctl is-enabled php8.3-fpm.service 2>/dev/null) == masked ]] || die "php8.3-fpm.service isn't masked"
systemctl is-active -q php8.3-fpm.service && die "php8.3-fpm.service is running -- stop it (it is masked): sudo systemctl stop php8.3-fpm"

# ---------------------------------------------------------------- 1a. the catalog move: what the media API answers now
# (docs/catalog-plan.md step 2, S2-5) Once, before the install that moves her tags and
# categories into the catalog: the running version syncs and publishes its index, then
# every public label's answer and the whole index (by names) are kept, to compare with
# what the new version publishes after its own sync (5c, below).
catalog_proof=no
if [[ $(pg_owner -c "SELECT count(*) FROM public.schema_migrations WHERE name = 'catalog/0001-catalog.sql'" 2>/dev/null) == 0 ]] \
        && [[ -f $MEDIA_PUBLIC/index.db && -x /usr/local/sbin/pammy-panel ]]; then
    out=$(/usr/local/sbin/pammy-panel media-sync 2>&1) || die "the media sync before the catalog move failed -- nothing has been changed: $out"
    out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$P/release/tools/media-api-proof.ts" capture \
        "$MEDIA_PUBLIC/index.db" "http://127.0.0.1:$GATE_PORT" pammy.org "$tmp/catalog-before.json" 2>&1) \
        || die "couldn't ask the media API before the catalog move -- nothing has been changed: $out"
    cp "$tmp/catalog-before.json" "/var/lib/$PGSVC/backups/catalog-proof-before-$(tail -1 "$P/release/BUILD").json" 2>/dev/null || true
    catalog_proof=yes
    say ok "the media API before the catalog move: $out"
fi

# ---------------------------------------------------------------- 1b. a dump of the database, before any migration
# Everything the panel and the gate hold is in Postgres (docs/postgres-plan.md
# P12): one pg_dump here replaces the old panel.db/media.db/gate.db copies. The
# dumps are kept 60 days in /var/lib/svc-pammypanel-db/backups.
new_build=$(tail -1 "$P/release/BUILD")
dump_file=                  # the dump taken here, named again if this install has to be undone
migrated=no                 # set when 2b actually runs a migration (then going back means restoring the dump)
if out=$( (cd / && runuser -u "$PGSVC" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$PGSVC")" HOME="/var/lib/$PGSVC" \
        "/var/lib/$PGSVC/bin/backup-pammy-pg.sh" "before-$new_build") 2>&1); then
    dump_file=${out##*: }
    say ok "database dumped before this install ($(basename "$dump_file"))"
else
    say FAIL "$out" >&2
    die "couldn't dump the database -- nothing has been changed"
fi

# Accounts and their passkeys, as they must stay: every account's name and role,
# and every passkey (a hash of them all, so nothing can quietly change).
passkey_count() {
    pg_owner -c "WITH u AS (SELECT string_agg(id || ':' || username || ':' || role || ':' || active, ',' ORDER BY id) s FROM panel.users),
                      k AS (SELECT string_agg(id || ':' || user_id || ':' || credential_id || ':' || encode(public_key, 'hex'), ',' ORDER BY id) s FROM panel.passkeys)
                 SELECT (SELECT count(*) FROM panel.users) || ' accounts, ' || (SELECT count(*) FROM panel.passkeys) || ' passkeys, '
                     || substr(md5(coalesce(u.s, '') || '|' || coalesce(k.s, '')), 1, 12) FROM u, k" 2>/dev/null || echo unreadable
}
schema_version() {
    # the last one applied, not the last by name: a package's (forms/0001-x.sql) sorts after the baseline's
    pg_owner -c "SELECT count(*) || ' migrations, last ' || coalesce((SELECT name FROM public.schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1), 'none')
                 FROM public.schema_migrations" 2>/dev/null || echo none
}
panel_schema_before=$(schema_version)
panel_db_before=$(passkey_count)

# ---------------------------------------------------------------- 1c. the map WordPress's proxy files name (docs/s1-plan.md S1e)
# At http level (conf.d), before this release's code can write a proxy file that names its
# variable (the software helper, from step 2 on) and before step 7 puts it in proxy.conf: a
# map nothing uses yet is harmless, a variable without its map fails nginx -t. Stays on a
# rollback (the old proxy files don't name it; the new proxy.conf, if it got that far, does).
WPMAP=/etc/nginx/conf.d/pammy-wordpress-cookie.conf
if ! cmp -s "$P/release/apps/wordpress-nginx/cookie-map.conf" "$WPMAP"; then
    [[ -f $WPMAP ]] && cp -a "$WPMAP" "$tmp/wpmap.bak"
    install -m 644 -o root -g root "$P/release/apps/wordpress-nginx/cookie-map.conf" "$WPMAP"
    if ! nginx -t 2>"$tmp/nginx-t"; then
        cat "$tmp/nginx-t" >&2
        if [[ -f $tmp/wpmap.bak ]]; then cp -a "$tmp/wpmap.bak" "$WPMAP"; else rm -f "$WPMAP"; fi
        die "nginx rejected $WPMAP -- put back as it was; nothing else changed"
    fi
    systemctl reload nginx
    say ok "the map that keeps the gate's cookie from WordPress is in $WPMAP"
else say ok "the map that keeps the gate's cookie from WordPress: already in $WPMAP"; fi

# ---------------------------------------------------------------- 2. code (root-owned: the service can't change itself)
old_build=$(tail -1 "$APP/BUILD" 2>/dev/null || echo none)
rm -rf "$APP.new" "$APP.failed"
cp -a "$P/release" "$APP.new"
setfacl -R -b "$APP.new"   # cp -a copies ACLs; monadelanuit may edit the source, never the live code
chown -R root:root "$APP.new"
chmod -R u=rwX,go=rX "$APP.new"
if [[ $old_build == "$new_build" && -d $APP.prev ]]; then
    # the same build again, after an install that stopped part way: the version
    # before it stays the one to go back to
    rm -rf "$APP"
    say note "this build was already in $APP (an install that stopped part way); $(tail -1 "$APP.prev/BUILD" 2>/dev/null || echo 'the previous version') stays the one to go back to"
else
    rm -rf "$APP.prev"
    [[ -d $APP ]] && mv "$APP" "$APP.prev"
fi
mv "$APP.new" "$APP"
say ok "code $old_build -> $new_build in $APP"

# ---------------------------------------------------------------- 2b. the database schema (docs/postgres-plan.md P9)
# Only the installer migrates; the services check the list on start and refuse to
# run against a schema they don't expect. Appended files only, each run once.
if out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/migrate.ts" --password-file "$PASS_DIR/owner.pass" 2>&1); then
    if grep -q 'ran ' <<<"$out"; then migrated=yes; sed 's/^/  /' <<<"$out"; else say ok "database schema: up to date"; fi
    # An earlier run of an install that stopped part way may have run them already (2026-09-28:
    # catalog step 3): the release to go back to can't start on this schema either, so this
    # install counts as one that migrated -- a failed check leaves this code, not a dead panel.
    if [[ $migrated == no && -d $APP.prev ]]; then
        known=$( (cd "$APP.prev" && for f in db/migrations/*.sql; do [[ -f $f ]] && basename "$f"; done
                  for f in packages/*/migrations/*.sql; do [[ -f $f ]] && echo "$(cut -d/ -f2 <<<"$f")/$(basename "$f")"; done) | sort)
        if applied=$(pg_owner -c "SELECT name FROM public.schema_migrations" 2>/dev/null); then
            unknown=$(comm -23 <(sort <<<"$applied") <(printf '%s\n' "$known") | grep . || true)
            if [[ -n $unknown ]]; then
                migrated=yes
                say note "the database already has migrations $(tail -1 "$APP.prev/BUILD" 2>/dev/null) doesn't know ($(tr '\n' ' ' <<<"$unknown")): if the checks fail, this code stays"
            fi
        fi
    fi
else
    sed 's/^/  /' <<<"$out" >&2
    # the code is back to the version that matches the schema; nothing else has run yet
    rm -rf "$APP"; [[ -d $APP.prev ]] && mv "$APP.prev" "$APP"
    die "the database migrations failed -- the previous code is back, and the database is as the dump above"
fi

# ---------------------------------------------------------------- 3. settings + command line
install -d -m 755 "$ETC"
install -m 644 -o root -g root "$D/panel.env" "$ETC/panel.env"
install -m 755 -o root -g root "$D/pammy-panel-cli" /usr/local/sbin/pammy-panel
say ok "settings $ETC/panel.env, command line /usr/local/sbin/pammy-panel"

# PHP's pool and php.ini (docs/tutorials-plan.md P2-P7), root-owned: PHP can't change them
install -d -o root -g root -m 755 "$PHP_ETC"
install -m 644 -o root -g root "$D/php/php-fpm.conf" "$D/php/php.ini" "$PHP_ETC/"
(cd / && runuser -u "$PHPU" -- /usr/sbin/php-fpm8.3 -t -y "$PHP_ETC/php-fpm.conf" -c "$PHP_ETC/php.ini") >"$tmp/fpm-t" 2>&1 || { cat "$tmp/fpm-t" >&2; die "php-fpm rejected $PHP_ETC/php-fpm.conf"; }

# the mail settings (docs/apps-plan.md phase 3): written by the software helper
# from the panel's Email page; here only made, never overwritten. The key file
# exists from the start (empty: "not set up") because LoadCredential= needs it.
install -d -o root -g root -m 755 /etc/pammy-mail
[[ -e /etc/pammy-mail/resend.key ]] || install -m 600 -o root -g root /dev/null /etc/pammy-mail/resend.key
chmod 600 /etc/pammy-mail/resend.key; chown root:root /etc/pammy-mail/resend.key
if [[ ! -e /etc/pammy-mail/settings.json ]]; then
    printf '{\n "from": "noreply@mail.lesfleursdelanuit.com",\n "replyTo": "hello@pammy.org",\n "notifyTo": "hello@pammy.org"\n}\n' > /etc/pammy-mail/settings.json
    chmod 644 /etc/pammy-mail/settings.json
    say ok "mail settings started in /etc/pammy-mail (no key yet: set it on the panel's Email page)"
fi

# ---------------------------------------------------------------- 4. trash (outside the web root: never served)
if [[ ! -e $TRASH ]]; then
    install -d -o pamela -g pamela -m 700 "$TRASH"
    say ok "created $TRASH (pamela's own, 700)"
fi
# /pamela is setgid, and mkdir there inherits that bit; the trash doesn't want it
chmod u=rwx,g-s,go-rwx "$TRASH"
chown pamela:pamela "$TRASH"

# ---------------------------------------------------------------- 4b. nginx's edge secret (docs/s1-plan.md S1c)
# Before the services start (they load it) and before nginx's files include it (6, 7, 7a).
source "$D/edge-secret.sh"
source "$D/gate-door.sh"      # gate_door_refuses (S2)
make_edge_secret "$ETC" "$NGX"
# the first time, the panel and the gate are held on the old way until nginx sends it (7a, continued)
edge_hold "$P/tools" "$ETC" "$NGX" pammy-panel "$PORT" pammy-gate "$GATE_PORT"

# ---------------------------------------------------------------- 5. services
install -m 644 -o root -g root "$D/pammy-sitefs.socket" /etc/systemd/system/pammy-sitefs.socket
install -m 644 -o root -g root "$D/pammy-sitefs.service" /etc/systemd/system/pammy-sitefs.service
install -m 644 -o root -g root "$D/pammy-gate-admin.socket" /etc/systemd/system/pammy-gate-admin.socket
install -m 644 -o root -g root "$D/pammy-gate-php.socket" /etc/systemd/system/pammy-gate-php.socket
install -m 644 -o root -g root "$D/pammy-php.service" /etc/systemd/system/pammy-php.service
install -m 644 -o root -g root "$D/pammy-gate.service" /etc/systemd/system/pammy-gate.service
install -m 644 -o root -g root "$D/pammy-panel.service" /etc/systemd/system/pammy-panel.service
install -m 644 -o root -g root "$D/pammy-thumbs.socket" /etc/systemd/system/pammy-thumbs.socket
install -m 644 -o root -g root "$D/pammy-thumbs.service" /etc/systemd/system/pammy-thumbs.service
install -m 644 -o root -g root "$D/pammy-pammydb.socket" /etc/systemd/system/pammy-pammydb.socket
install -m 644 -o root -g root "$D/pammy-pammydb.service" /etc/systemd/system/pammy-pammydb.service
# the gate's own door to it, row ops only (S2, docs/s2-plan.md)
install -m 644 -o root -g root "$D/pammy-pammydb-gate.socket" /etc/systemd/system/pammy-pammydb-gate.socket
install -m 644 -o root -g root "$D/pammy-pammydb-gate.service" /etc/systemd/system/pammy-pammydb-gate.service
# the software helper (docs/apps-plan.md G2): root, read-only in phase 1, only the panel may ask
install -m 644 -o root -g root "$D/pammy-apps.socket" /etc/systemd/system/pammy-apps.socket
install -m 644 -o root -g root "$D/pammy-apps.service" /etc/systemd/system/pammy-apps.service
# the mail service (docs/apps-plan.md phase 3): the only one allowed off this machine
install -m 644 -o root -g root "$D/pammy-mail.socket" /etc/systemd/system/pammy-mail.socket
install -m 644 -o root -g root "$D/pammy-mail.service" /etc/systemd/system/pammy-mail.service
# deleted software goes for good after 30 days (docs/apps-plan.md 4c): a daily ask of the software helper
install -m 644 -o root -g root "$D/pammy-apps-purge.service" /etc/systemd/system/pammy-apps-purge.service
install -m 644 -o root -g root "$D/pammy-apps-purge.timer" /etc/systemd/system/pammy-apps-purge.timer
# File Explorer's helper for each installed software (docs/catalog-plan.md step 3): the
# templates; the software helper writes each instance's drop-in and switches it on (below)
install -m 644 -o root -g root "$D/pammy-rootfs@.socket" /etc/systemd/system/pammy-rootfs@.socket
install -m 644 -o root -g root "$D/pammy-rootfs@.service" /etc/systemd/system/pammy-rootfs@.service
systemctl daemon-reload
systemctl enable -q pammy-sitefs.socket pammy-gate-admin.socket pammy-gate-php.socket pammy-thumbs.socket pammy-gate pammy-panel pammy-php
systemctl restart pammy-sitefs.socket
systemctl try-restart pammy-sitefs.service     # pick up new code; otherwise it starts on first use
systemctl restart pammy-thumbs.socket
systemctl try-restart pammy-thumbs.service
# The database helper can only run once its two passwords exist, and those are
# made by a script of their own on the database side.
if [[ -s $PASS_DIR/studio-postgres.pass && -s $PASS_DIR/studio-mariadb.pass ]]; then
    systemctl enable -q pammy-pammydb.socket pammy-pammydb-gate.socket
    systemctl restart pammy-pammydb.socket pammy-pammydb-gate.socket
    systemctl try-restart pammy-pammydb.service pammy-pammydb-gate.service    # pick up new code; otherwise it starts on first use
else
    systemctl disable --now -q pammy-pammydb.socket pammy-pammydb-gate.socket 2>/dev/null || true
    say note "no studio passwords yet, so the database helper is off: sudo ~/pamela-setup/no-sudo/install-studio-db.sh"
fi
# The WordPress already here becomes the first installed software (docs/apps-plan.md
# G3, A1). This writes the helper's record (/var/lib/pammy-apps/apps.json) and
# nothing else: no file, unit, container, database or nginx line of WordPress.
# Safe to repeat. A failure writes nothing, and verify-apps.sh then says so.
install -d -o root -g root -m 700 /var/lib/pammy-apps
if out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/adopt-cli.ts" 2>&1); then
    say ok "installed software: $out"
else
    say note "$out"
fi
systemctl enable -q pammy-apps.socket
systemctl enable -q --now pammy-apps-purge.timer
systemctl restart pammy-apps.socket
systemctl try-restart pammy-apps.service      # pick up new code; otherwise it starts on first use
# each installed software's files helper, as its own user (docs/catalog-plan.md step 3):
# asked of the software helper, which keeps them in step with what is installed
if out=$(cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/call.ts" '{"op":"rootfs-sync","actor":"install"}' 2>&1); then
    roots=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).roots.join(", ")||"none")}catch{console.log("?")}})')
    say ok "File Explorer's helpers for installed software: $roots"
    for id in ${roots//,/ }; do
        [[ $id == none || $id == '?' ]] && continue
        if [[ -f /etc/systemd/system/pammy-rootfs@$id.service.d/root.conf ]]; then
            say ok "  $id: drop-in there, socket $(systemctl is-enabled "pammy-rootfs@$id.socket" 2>&1)/$(systemctl is-active "pammy-rootfs@$id.socket" 2>&1)"
        else
            say note "  $id: NO drop-in after the sync; the helper said: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
        fi
    done
else
    say note "File Explorer's helpers for installed software weren't set up (verify says more): $out"
fi
systemctl enable -q pammy-mail.socket
systemctl restart pammy-mail.socket
systemctl try-restart pammy-mail.service
# The gate stops first: systemd won't start a socket for a service that is
# already running without it (PHP's door, the first time), so both of its
# doors are started while it is down, and it gets both when it starts.
# S2 (docs/s2-plan.md), the contract half: the gate's door is up (above), so the gate's user
# leaves the panel's group now, and the gate starts without it, onto its own door. (Its
# groups are the ones it starts with: the gate still running had them until this restart.)
if id -nG "$GATE" | tr ' ' '\n' | grep -qx "$PAMMYDB_CLIENTS"; then
    gpasswd -d "$GATE" "$PAMMYDB_CLIENTS" >/dev/null
    say ok "$GATE left $PAMMYDB_CLIENTS: it asks the database helper at its own door, row ops only ($PAMMYDB_GATE_SOCK)"
fi
systemctl stop pammy-gate
systemctl restart pammy-gate-admin.socket pammy-gate-php.socket
systemctl start pammy-gate
systemctl restart pammy-panel
# before nginx sends it anything (step 7). If it doesn't start, healthy() below
# says so and puts the previous version back -- not set -e, half way through.
systemctl restart pammy-php || say note "pammy-php didn't start; the check below decides"
healthy() {
    local i
    for i in $(seq 40); do
        curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" && break
        sleep 0.5
    done
    curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" || return 1
    # the helper, asked exactly the way the panel asks it (a rolled-back
    # version from before the helper existed has nothing to ask)
    [[ -f $APP/src/sitefs/call.ts ]] || return 0
    systemctl reset-failed pammy-sitefs.service 2>/dev/null || true
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" '{"op":"list","actor":"install"}') >/dev/null || return 1
    # the gate: its HTTP side (what nginx asks) and its admin socket (what the panel asks)
    [[ -f $APP/src/gate/main.ts ]] || return 0
    for i in $(seq 40); do
        curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$GATE_PORT/_pammy/login.js" && break
        sleep 0.5
    done
    curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$GATE_PORT/_pammy/login.js" || return 1
    (cd / && runuser -u "$SVC" -- env SITEFS_SOCKET=/run/pammy-gate-admin.sock /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" '{"op":"state","actor":"install"}') >/dev/null || return 1
    # PHP, and its one door (a rolled-back version predates both): the gate
    # answers PHP's user there, and only about the API
    if [[ -f $APP/src/gate/php-socket.ts ]]; then
        for i in $(seq 20); do [[ -S /run/pammy-php/fpm.sock ]] && break; sleep 0.5; done
        systemctl is-active -q pammy-php && [[ -S /run/pammy-php/fpm.sock ]] || return 1
        (cd / && runuser -u "$PHPU" -- curl -s --max-time 3 --unix-socket /run/pammy-gate-php.sock http://pammy.org/check) | grep -q 'Only /_pammy/api/' || return 1
    fi
    # the thumbnail service, with both of its tools (a rolled-back version has none)
    [[ -f $APP/src/thumbs/main.ts ]] || return 0
    systemctl reset-failed pammy-thumbs.service 2>/dev/null || true
    (cd / && runuser -u "$SVC" -- env SITEFS_SOCKET=$THUMBS_SOCK /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/sitefs/call.ts" '{"op":"tools","actor":"install"}') \
        | grep -q '"pdftoppm": true' || return 1
    # the database helper, asked as the panel asks it -- which also proves the
    # shared group works (a rolled-back version, or a box without the studio
    # passwords, has nothing to ask)
    [[ -f $APP/src/pammydb/main.ts && -s $PASS_DIR/studio-postgres.pass ]] || return 0
    systemctl reset-failed pammy-pammydb.service 2>/dev/null || true
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/pammydb/call.ts" '{"op":"list-databases","actor":"install"}') >/dev/null || return 1
    # the gate's door (S2), asked as the gate's user: it is up, and it refuses what isn't a
    # row op with its own words (a rolled-back version predates it)
    [[ -f $APP/src/pammydb/main-gate.ts ]] || return 0
    systemctl reset-failed pammy-pammydb-gate.service 2>/dev/null || true
    gate_door_refuses runuser -u "$GATE" -- env -C / PAMMYDB_SOCKET="$PAMMYDB_GATE_SOCK" /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/pammydb/call.ts" '{"op":"list-databases","actor":"install"}' \
        || return 1
}
# The software helper is asked after healthy(): a box without the studio passwords
# returns early above, and this must be asked on every box.
software_healthy() {
    [[ -f $APP/src/apps/main.ts ]] || return 0      # a rolled-back version predates it
    systemctl reset-failed pammy-apps.service 2>/dev/null || true
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/call.ts" '{"op":"list","actor":"install"}') >/dev/null || return 1
    # the mail service answers (whether or not a key is set yet); it sends nothing here
    [[ -f $APP/src/mail/main.ts ]] || return 0
    systemctl reset-failed pammy-mail.service 2>/dev/null || true
    (cd / && runuser -u "$SVC" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/mail/call.ts" '{"op":"status"}') >/dev/null
}
# The way back after an install that ran a migration (deploy/pg/README.md): the code is
# left as it is (an older release refuses a schema it doesn't know), and the dump taken
# in 1b is restored by hand, then the release before this one installed.
restore_help() {
    say note "this install ran database migrations, so the code is left as it is ($new_build, in $APP)" >&2
    cat >&2 <<EOF
        To go back, restore the dump taken before this install, then install the release before this one
        (deploy/pg/README.md):
            sudo systemctl stop pammy-panel pammy-gate
            R='cd / && runuser -u $PGSVC -- env XDG_RUNTIME_DIR=/run/user/\$(id -u $PGSVC)'
            sudo bash -c "\$R podman exec -i -u postgres pammy-pg psql -d postgres -c 'DROP DATABASE pammy WITH (FORCE)'"
            sudo $D/pg/install-pg.sh
            sudo bash -c "\$R podman exec -i -u postgres pammy-pg pg_restore -d pammy --exit-on-error --clean --if-exists" < $dump_file
            sudo systemctl start pammy-gate pammy-panel
EOF
}

# Puts /opt/pammy-panel back to the version before this install and starts it
# again. Used when the panel doesn't come up, and when the checks fail
# (docs/refactor-plan.md phase 0 step 4). The database is not touched here: with a
# migration in this install, going back means restoring the dump first, and the
# caller says so instead of calling this.
put_back_previous() {
    if [[ ! -d $APP.prev ]]; then
        systemctl disable --now -q pammy-panel pammy-sitefs.socket || true
        say note "there is no earlier version to go back to; the panel has been stopped" >&2
        return 1
    fi
    rm -rf "$APP.failed"; mv "$APP" "$APP.failed"; mv "$APP.prev" "$APP"
    # The data stays as it is: the migrations that ran are recorded, and the
    # dump taken above is what to restore from if one of them did harm
    # (deploy/pg/README.md). An older release that predates a migration will
    # refuse to start rather than run against a schema it doesn't know.
    [[ $migrated == yes ]] && say note "the database keeps the migrations this install ran; the dump before it is in /var/lib/$PGSVC/backups" >&2
    systemctl stop pammy-sitefs.service 2>/dev/null || true
    systemctl reset-failed pammy-sitefs.service 2>/dev/null || true
    systemctl stop pammy-thumbs.service 2>/dev/null || true
    systemctl reset-failed pammy-thumbs.service 2>/dev/null || true
    # the previous version predates thumbnails: nothing asks for them
    [[ -f $APP/src/thumbs/main.ts ]] || systemctl disable --now -q pammy-thumbs.socket 2>/dev/null || true
    systemctl stop pammy-pammydb.service pammy-pammydb-gate.service 2>/dev/null || true
    systemctl reset-failed pammy-pammydb.service pammy-pammydb-gate.service 2>/dev/null || true
    # the previous version predates the database helper: nothing asks for it
    [[ -f $APP/src/pammydb/main.ts ]] || systemctl disable --now -q pammy-pammydb.socket 2>/dev/null || true
    # the previous version predates the gate's own door (S2): the gate goes back to the
    # panel's door and group, and the gate's door goes (it has no code to run)
    if [[ ! -f $APP/src/pammydb/main-gate.ts ]]; then
        systemctl disable --now -q pammy-pammydb-gate.socket 2>/dev/null || true
        usermod -aG "$PAMMYDB_CLIENTS" "$GATE"
        sed -i "s#^Environment=GATE_PAMMYDB_SOCKET=.*#Environment=GATE_PAMMYDB_SOCKET=$PAMMYDB_SOCK#" /etc/systemd/system/pammy-gate.service
        systemctl daemon-reload
    fi
    systemctl stop pammy-apps.service 2>/dev/null || true
    systemctl reset-failed pammy-apps.service 2>/dev/null || true
    # the previous version predates the software helper: nothing asks for it (its
    # record in /var/lib/pammy-apps stays; it describes WordPress, which is unchanged)
    [[ -f $APP/src/apps/main.ts ]] || systemctl disable --now -q pammy-apps.socket 2>/dev/null || true
    # the previous version predates software roots (catalog step 3): nothing asks their helpers
    if [[ ! -f $APP/src/rootfs/main.ts ]]; then
        for u in $(systemctl list-units --all --plain --no-legend 'pammy-rootfs@*.socket' | awk '{print $1}'); do
            systemctl disable --now -q "$u" 2>/dev/null || true
        done
    fi
    # the previous version predates Delete (4c): nothing is ever due
    [[ -f $APP/src/apps/remove.ts ]] || systemctl disable --now -q pammy-apps-purge.timer 2>/dev/null || true
    systemctl stop pammy-mail.service 2>/dev/null || true
    systemctl reset-failed pammy-mail.service 2>/dev/null || true
    [[ -f $APP/src/mail/main.ts ]] || systemctl disable --now -q pammy-mail.socket 2>/dev/null || true
    # the previous version predates PHP: no PHP, and its gate takes exactly one
    # socket (the admin one), so the unit stops handing it PHP's as well
    if [[ ! -f $APP/src/gate/php-socket.ts ]]; then
        systemctl disable --now -q pammy-php pammy-gate-php.socket 2>/dev/null || true
        sed -i -e '/^Sockets=/d' -e '/^Wants=pammy-gate-php.socket/d' -e 's/ pammy-gate-php.socket$//' /etc/systemd/system/pammy-gate.service
        systemctl daemon-reload
    fi
    if [[ -f $APP/src/gate/main.ts ]]; then
        systemctl reset-failed pammy-gate 2>/dev/null || true
        systemctl restart pammy-gate
    else
        # the previous version predates the gate, and nginx isn't using it yet
        systemctl disable --now -q pammy-gate pammy-gate-admin.socket 2>/dev/null || true
    fi
    systemctl restart pammy-panel
    if healthy && software_healthy; then
        say ok "previous version ($old_build) is running again; the one that failed is in $APP.failed" >&2
        return 0
    fi
    say FAIL "the previous version didn't come up either: journalctl -u pammy-panel -u pammy-gate -n 50" >&2
    return 1
}
if ! healthy || ! software_healthy; then
    say FAIL "the panel, one of its helpers or the gate didn't come up; their logs:" >&2
    journalctl -u pammy-panel -u pammy-sitefs -u pammy-gate -u pammy-thumbs -u pammy-php -u pammy-apps -u pammy-mail -n 40 --no-pager >&2 || true
    put_back_previous || true
    exit 1
fi
say ok "panel healthy on 127.0.0.1:$PORT; folder helper, thumbnail service, software helper and gate (127.0.0.1:$GATE_PORT) answering"

# The accounts and their passkeys must come through any install untouched.
panel_db_after=$(passkey_count)
[[ $panel_db_before == "$panel_db_after" ]] \
    && say ok "accounts and passkeys untouched ($panel_db_after)" \
    || die "accounts or passkeys changed during the install ($panel_db_before -> $panel_db_after) -- tell momolig before doing anything else"
panel_schema_after=$(schema_version)
[[ $panel_schema_before == "$panel_schema_after" ]] || say ok "database schema: $panel_schema_before -> $panel_schema_after"

# ---------------------------------------------------------------- 5b. media: photos/ -> images/ (once; safe to repeat)
if out=$(/usr/local/sbin/pammy-panel media-images 2>&1); then
    say ok "media folders: $(tr '\n' ';' <<<"$out" | sed 's/;$//; s/;/; /g')"
elif [[ $? -eq 3 ]]; then
    say note "media folders: some files stayed in photos/ (their names were taken in images/) -- move them by hand:"
    grep '^LEFT' <<<"$out" | sed 's/^/        /'
else
    die "renaming photos/ to images/ failed: $out"
fi

# ---------------------------------------------------------------- 5c. media records: a sync now (then every 15 minutes by itself)
# The first one on a database with no media records finds every media file,
# taking who added what from the imported notes (media.imported_notes, D17).
if out=$(/usr/local/sbin/pammy-panel media-sync 2>&1); then
    say ok "media records: $(head -2 <<<"$out" | tr '\n' ';' | sed 's/;$//; s/;/; /g')"
    if grep -q '^OUT OF PLACE' <<<"$out"; then
        say note "in media folders but not where the panel can use them (shown on the Media tab too):"
        grep '^OUT OF PLACE' <<<"$out" | sed 's/^OUT OF PLACE  /        /'
    fi
    grep '^NOTE' <<<"$out" | sed 's/^NOTE  /        note: /' || true
else
    die "the first media sync failed (the Media tab lists no files until one works): $out"
fi

# ---------------------------------------------------------------- 5d. the catalog move: the same answers? (S2-5)
# The new version has synced and published its index (5c): the same questions as in 1a,
# and every answer and every file, label and label on a file compared. A difference
# stops here, with the way back (the dump taken in 1b).
if [[ $catalog_proof == yes ]]; then
    out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/media-api-proof.ts" capture \
        "$MEDIA_PUBLIC/index.db" "http://127.0.0.1:$GATE_PORT" pammy.org "$tmp/catalog-after.json" 2>&1) \
        || { say FAIL "couldn't ask the media API after the catalog move: $out" >&2; restore_help; exit 1; }
    if cmp=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/media-api-proof.ts" compare "$tmp/catalog-before.json" "$tmp/catalog-after.json" 2>&1); then
        say ok "the catalog move: $cmp ($out)"
    else
        say FAIL "the catalog move changed what the media API answers:" >&2
        sed 's/^/        /' <<<"$cmp" >&2
        restore_help
        exit 1
    fi
fi

# ---------------------------------------------------------------- 6. nginx: panel.pammy.org
# which of the rendered files differ from what nginx has now (for pammy.org's profile,
# none should: test/nginx.test.ts holds them to what was live before phase 2)
changed=()
for f in site/panel.conf panel/cloudflare-realip.conf panel/cloudflare-ips.geo panel/tutorial-examples.conf gate/gate.conf gate/uri.conf gate/php.conf; do
    case $f in site/*) dst=$SITE ;; panel/*) dst=$NGX/${f#panel/} ;; gate/*) dst=$GATE_NGX/${f#gate/} ;; esac
    cmp -s "$tmp/nginx/$f" "$dst" || changed+=("$dst")
done
[[ -d $NGX ]] && cp -a "$NGX" "$tmp/ngx.bak"
[[ -f $SITE ]] && cp -a "$SITE" "$tmp/site.bak"
[[ -L $LINK ]] && had_link=yes || had_link=no
install -d -m 755 "$NGX"
install -m 644 -o root -g root "$tmp/nginx/panel/cloudflare-realip.conf" "$tmp/nginx/panel/cloudflare-ips.geo" "$NGX/"
# the tutorial examples' PHP pages (docs/tutorial-examples-plan.md)
install -m 644 -o root -g root "$tmp/nginx/panel/tutorial-examples.conf" "$NGX/tutorial-examples.conf"
install -m 644 -o root -g root "$tmp/nginx/site/panel.conf" "$SITE"
ln -sfn "$SITE" "$LINK"
if ! nginx -t 2>"$tmp/nginx-t"; then
    cat "$tmp/nginx-t" >&2
    if [[ -f $tmp/site.bak ]]; then cp -a "$tmp/site.bak" "$SITE"; else rm -f "$SITE"; fi
    [[ $had_link == yes ]] || rm -f "$LINK"
    if [[ -d $tmp/ngx.bak ]]; then rm -rf "$NGX"; cp -a "$tmp/ngx.bak" "$NGX"; else rm -rf "$NGX"; fi
    nginx -t 2>/dev/null && die "nginx rejected the panel's site config -- nginx put back as it was (the service itself is running on localhost only)"
    die "nginx rejected the panel's site config AND the restore didn't pass nginx -t -- check 'sudo nginx -t' now"
fi
systemctl reload nginx
sleep 2     # reload returns before old workers retire
say ok "nginx serves panel.pammy.org (Cloudflare only)"
if (( ${#changed[@]} )); then say note "nginx files rendered from the profile differ from what was there: ${changed[*]}"
else say ok "nginx files rendered from the profile: the same as what was there"; fi

# ---------------------------------------------------------------- 7. nginx: the gate in front of her site
# Only now that the gate has answered. Snippets first, then WordPress's
# main.conf and the pamela vhost; one nginx -t for all of it, and everything put
# back if it fails.
cp -a "$VHOST" "$tmp/vhost.bak"
cp -a "$WPNGX/main.conf" "$tmp/main.bak"
# WordPress's proxy files with the Cookie line (docs/s1-plan.md S1e): the blog's proxy.conf
# from this release (install-wordpress.sh's, with the line), every other install's as the
# software helper writes it; the map is in since step 1c
mkdir -p "$tmp/proxy.bak"; cp -a "$WPNGX"/proxy*.conf "$tmp/proxy.bak/" 2>/dev/null || true
[[ -f $WPNGX/proxy.conf ]] && install -m 644 -o root -g root "$P/release/apps/wordpress-nginx/proxy.conf" "$WPNGX/proxy.conf"
for f in "$tmp"/inc-helper/proxy-*.conf; do [[ -f $f && -f $WPNGX/$(basename "$f") ]] && install -m 644 -o root -g root "$f" "$WPNGX/"; done
[[ -d $GATE_NGX ]] && cp -a "$GATE_NGX" "$tmp/gate.bak"
install -d -m 755 "$GATE_NGX"
install -m 644 -o root -g root "$tmp/nginx/gate/gate.conf" "$tmp/nginx/gate/uri.conf" "$tmp/nginx/gate/php.conf" "$GATE_NGX/"
[[ $main_state == old ]] && install -m 644 -o root -g root "$tmp/inc-new/main.conf" "$WPNGX/main.conf"
[[ $vhost_state == old ]] && install -m 644 -o root -g root "$WPDIR/pamela-live-wp.nginx" "$VHOST"
if ! nginx -t 2>"$tmp/nginx-t"; then
    cat "$tmp/nginx-t" >&2
    cp -a "$tmp/vhost.bak" "$VHOST"
    cp -a "$tmp/main.bak" "$WPNGX/main.conf"
    cp -a "$tmp"/proxy.bak/*.conf "$WPNGX/" 2>/dev/null || true
    if [[ -d $tmp/gate.bak ]]; then rm -rf "$GATE_NGX"; cp -a "$tmp/gate.bak" "$GATE_NGX"; else rm -rf "$GATE_NGX"; fi
    nginx -t 2>/dev/null && die "nginx rejected the gated config -- put back as it was; her site is unchanged"
    die "nginx rejected the gated config AND the restore didn't pass nginx -t -- run 'sudo nginx -t' now"
fi
if [[ $vhost_state == old || $main_state == old ]]; then
    cp -a "$tmp/vhost.bak" "$WPDIR/pamela.nginx.pre-gate-live"
    cp -a "$tmp/main.bak" "$WPDIR/main.conf.pre-gate-live"
fi
systemctl reload nginx
sleep 2
say ok "nginx: every request to pammy.org and its folder subdomains now passes the gate"

# ---------------------------------------------------------------- 7a. pammy.org's hosts: written, not live (docs/phase8-plan.md 8-7b)
# The routing helper (pammy-routes, root, writes only $HOSTS_DIR) and the rows it renders --
# pammy.org and www with the whole website and /api/, folder hosts, the software's routes --
# written into $HOSTS_DIR and tested by nginx -t on their own (a copy of nginx.conf that
# includes them in place of sites-enabled). Nothing includes them yet: the pamela site keeps
# serving pammy.org until the switch (8-7c).
HOSTS_DIR=/etc/nginx/pammy-hosts
install -d -o root -g root -m 755 "$HOSTS_DIR"
install -m 644 -o root -g root "$D/pammy-routes.socket" /etc/systemd/system/pammy-routes.socket
install -m 644 -o root -g root "$D/pammy-routes.service" /etc/systemd/system/pammy-routes.service
systemctl daemon-reload
systemctl reset-failed pammy-routes.service 2>/dev/null || true
systemctl enable -q pammy-routes.socket
systemctl restart pammy-routes.socket
systemctl stop pammy-routes.service 2>/dev/null || true
say ok "routing helper ready (pammy-routes.socket, writes only $HOSTS_DIR)"
if out=$(/usr/local/sbin/pammy-panel hosts-seed 2>&1); then
    sed 's/^/  /' <<<"$out"
else
    say FAIL "$out" >&2
    die "pammy.org's hosts rows or files couldn't be made (pammy-panel hosts-seed); nginx and her site are unchanged"
fi
sed "s#^\(\s*\)include /etc/nginx/sites-enabled/\*;#\1include $HOSTS_DIR/site.conf;#" /etc/nginx/nginx.conf > "$tmp/hosts-nginx.conf"
grep -q "include $HOSTS_DIR/site.conf;" "$tmp/hosts-nginx.conf" || die "nginx.conf has no 'include /etc/nginx/sites-enabled/*;' line to test pammy.org's hosts in place of"
if nginx -t -q -c "$tmp/hosts-nginx.conf" 2>"$tmp/hosts-nginx-t"; then
    say ok "pammy.org's hosts files ($(ls "$HOSTS_DIR"/hosts/*.conf 2>/dev/null | wc -l) host(s) and the folder catch-all) pass nginx -t on their own"
else
    cat "$tmp/hosts-nginx-t" >&2
    die "nginx refused pammy.org's hosts files on their own; they aren't live, so her site is unchanged"
fi
[[ -e /etc/nginx/sites-enabled/pammy-hosts ]] && say ok "pammy.org is served from $HOSTS_DIR (since the switch)" \
    || say ok "not live: the pamela site still serves pammy.org (the switch is 8-7c)"

# ---------------------------------------------------------------- 7a, continued. the switch (docs/phase8-plan.md 8-7c)
LE_RENEWAL=/etc/letsencrypt/renewal/pammy.org.conf
LE_OFF=/etc/letsencrypt/renewal-off
if [[ $SWITCH == to ]]; then
    say note "the switch: every folder and address asked of the pamela site, pammy-hosts in its place (one nginx -t), all asked again"
    if out=$(/usr/local/sbin/pammy-panel switch-to-hosts 2>&1); then
        sed 's/^/  /' <<<"$out"
        # certbot's nginx plugin would edit the files it finds for pammy.org on renewal (the
        # Gonsalves trap, 7-3): its renewal is set aside; the origin certificate covers pammy.org
        if [[ -f $LE_RENEWAL ]]; then
            install -d -m 700 "$LE_OFF"
            mv "$LE_RENEWAL" "$LE_OFF/pammy.org.conf"
            say ok "certbot no longer renews pammy.org's Let's Encrypt certificate (its renewal file is in $LE_OFF)"
            say note "from $(date -u -d '+14 days' +%F): sudo mv $LE_OFF/pammy.org.conf /etc/letsencrypt/renewal/ && sudo certbot delete --cert-name pammy.org"
        fi
    else
        sed 's/^/  /' <<<"$out" >&2
        # (the release itself is checked below as always; this says so again at the end)
        say FAIL "the switch was given back: the pamela site serves pammy.org as before (the differences are above)" >&2
        SWITCH_FAILED=yes
    fi
elif [[ $SWITCH == back ]]; then
    /usr/local/sbin/pammy-panel switch-back | sed 's/^/  /' || die "couldn't switch back (pammy-panel switch-back)"
    if [[ -f $LE_OFF/pammy.org.conf && ! -f $LE_RENEWAL ]]; then
        mv "$LE_OFF/pammy.org.conf" "$LE_RENEWAL"
        say ok "certbot renews pammy.org's Let's Encrypt certificate again"
    fi
fi

# ---------------------------------------------------------------- 7a, continued. the edge secret: nginx sends it now (S1c)
edge_release "$P/tools" "$ETC" "$NGX" pammy-panel "$PORT" pammy-gate "$GATE_PORT"

# ---------------------------------------------------------------- 7b. her guides (/home/pamela/instructions)
# The same files as the Help tab: the preflight refused a guide changed since the
# build, so her copies and this release's Help tab say the same thing.
if out=$("$P/../sync-pamela-guides.sh" 2>&1); then
    removed=$(grep -c '^  removed' <<<"$out" || true)
    say ok "her guides synced ($(grep -c '^  synced' <<<"$out") in /home/pamela/instructions$( ((removed)) && echo ", $removed old one(s) removed"))"
else
    say FAIL "$out" >&2
    die "couldn't sync her guides (sync-pamela-guides.sh) -- the panel is installed; run it by hand"
fi

# ---------------------------------------------------------------- 8. check it for real
echo
if ! "$D/verify-panel.sh"; then
    echo
    say FAIL "the checks failed: this release is not good" >&2
    if [[ $migrated == yes ]]; then
        # An older release refuses to start against a schema it doesn't know, so
        # putting the code back by itself would leave nothing running.
        restore_help
        exit 1
    fi
    say note "no migration ran, so the code goes back to the version before this install" >&2
    put_back_previous || true
    say note "nginx keeps this install's site files; they are the same for either version (the panel answers on 127.0.0.1:$PORT)" >&2
    exit 1
fi

if /usr/local/sbin/pammy-panel users | grep -q '^no accounts yet'; then
    cat <<'EOF'

Next: create your account and your first passkey setup link.

    sudo pammy-panel add-user momolig "momolig" --manager
    sudo pammy-panel invite momolig

Open the link on the device you want the passkey on. Then add Pamela from the
panel's Accounts tab, which gives you a setup link to send her.
EOF
fi

if [[ ${SWITCH_FAILED:-no} == yes ]]; then
    say FAIL "the release is in, but pammy.org stays on the pamela site: the switch was given back (see above)" >&2
    exit 3
fi
