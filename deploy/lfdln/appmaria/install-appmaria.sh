#!/usr/bin/env bash
# lfdln's MariaDB for the Studio's databases (docs/lfdln-mariadb-plan.md M1-M5): a rootless
# container "lfdln-appmaria" under svc-lfdlnmaria on 127.0.0.1:3308, its root inside the
# container only, and the Studio's login pammy_studio (deploy/studio/roles-maria.sql.in, as
# Pamela's). The same steps as appdb/install-appdb.sh, with nothing shared.
#
#   sudo ~/pamela-setup/panel/deploy/lfdln/appmaria/install-appmaria.sh    (install-lfdln.sh runs it)
#
# Passwords: root's is a podman secret; the Studio's a root-only file in /etc/lfdln-appmaria,
# copied for lfdln-pammydb's LoadCredential. Nightly dumps: /var/lib/svc-lfdlnmaria/backups,
# kept as long as the panel's Settings > Backups says. Safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-appmaria.sh"
die() { say FAIL "$1" >&2; exit 1; }
S=$APPMARIA_SRC
ROLES=$S/../../studio

# ---------------------------------------------------------------- preflight
command -v podman >/dev/null || die "needs podman"
command -v mariadb >/dev/null || die "needs the mariadb client (mariadb-client)"
if ss -ltnpH "sport = :$APPMARIA_PORT" | grep -q . && ! ss -ltnpH "sport = :$APPMARIA_PORT" | grep -q rootlessport; then
    die "port $APPMARIA_PORT is already used by something else: $(ss -ltnpH "sport = :$APPMARIA_PORT")"
fi
if [[ -e $APPMARIA_HOME ]] && [[ "$(stat -c %U "$APPMARIA_HOME")" != "$APPMARIA_SVC" ]]; then
    die "$APPMARIA_HOME already exists and isn't $APPMARIA_SVC's -- not touching it"
fi
for f in backup-lfdln-appmaria.sh quadlet/lfdln-appmaria.container quadlet/lfdln-appmaria.volume \
         systemd/lfdln-appmaria-backup.service systemd/lfdln-appmaria-backup.timer; do
    [[ -f $S/$f ]] || die "missing $S/$f"
done
[[ -f $ROLES/roles-maria.sql.in ]] || die "missing $ROLES/roles-maria.sql.in"

# ---------------------------------------------------------------- 1. identity
if ! id "$APPMARIA_SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$APPMARIA_HOME" --create-home --shell /usr/sbin/nologin "$APPMARIA_SVC"
    say ok "created system user $APPMARIA_SVC"
fi
chmod 700 "$APPMARIA_HOME"
if ! grep -q "^$APPMARIA_SVC:" /etc/subuid; then
    # next free range after everyone else's
    start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print m}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start+65535))" --add-subgids "$start-$((start+65535))" "$APPMARIA_SVC"
    say ok "subuid/subgid $start-$((start+65535))"
fi
install -d -o root -g root -m 755 /var/lib/cni
loginctl enable-linger "$APPMARIA_SVC"
for i in $(seq 30); do [[ -S /run/user/$(appmaria_uid)/bus ]] && break; sleep 1; done
[[ -S /run/user/$(appmaria_uid)/bus ]] || die "$APPMARIA_SVC's systemd user manager didn't start"

# ---------------------------------------------------------------- 2. folders + files
install -d -o root -g root -m 755 "$APPMARIA_HOME/bin"
install -m 755 -o root -g root "$S/backup-lfdln-appmaria.sh" "$APPMARIA_HOME/bin/"
install -d -o "$APPMARIA_SVC" -g "$APPMARIA_SVC" -m 700 "$APPMARIA_BACKUPS"
install -d -o root -g root -m 700 "$APPMARIA_PASS"

# ---------------------------------------------------------------- 3. secrets
for s in "${APPMARIA_SECRETS[@]}"; do
    if ! as_appmaria podman secret exists "$s"; then
        head -c 33 /dev/urandom | base64 | tr -d '/+=\n' | as_appmaria podman secret create "$s" - >/dev/null
        say ok "podman secret $s"
    fi
done

# ---------------------------------------------------------------- 4. units + start
qd=$APPMARIA_HOME/.config/containers/systemd; ud=$APPMARIA_HOME/.config/systemd/user
install -d -o "$APPMARIA_SVC" -g "$APPMARIA_SVC" -m 700 "$APPMARIA_HOME/.config" "$qd" "$ud"
unit_before=$({ cat "$qd"/lfdln-appmaria.* 2>/dev/null || true; } | sha256sum)
install -m 644 -o "$APPMARIA_SVC" -g "$APPMARIA_SVC" "$S"/quadlet/* "$qd/"
install -m 644 -o "$APPMARIA_SVC" -g "$APPMARIA_SVC" "$S"/systemd/* "$ud/"
as_appmaria podman image exists "$APPMARIA_IMAGE" || { say ... "pulling $APPMARIA_IMAGE"; as_appmaria podman pull -q "$APPMARIA_IMAGE" >/dev/null; }
appmaria_ctl daemon-reload
appmaria_ctl reset-failed "$APPMARIA_CONTAINER.service" 2>/dev/null || true
if appmaria_ctl is-active -q "$APPMARIA_CONTAINER.service"; then
    if [[ "$(cat "$qd"/lfdln-appmaria.* | sha256sum)" != "$unit_before" ]]; then
        appmaria_ctl restart "$APPMARIA_CONTAINER.service"; say ok "restarted $APPMARIA_CONTAINER (its unit changed)"
    fi
else
    appmaria_ctl start "$APPMARIA_CONTAINER.service"
fi
appmaria_wait_healthy || exit 1
# only on loopback: never on every address
ss -ltnH "sport = :$APPMARIA_PORT" | awk '{print $4}' | grep -qvE "^127\.0\.0\.1:$APPMARIA_PORT$" \
    && die "$APPMARIA_CONTAINER answers on more than 127.0.0.1:$APPMARIA_PORT"
# root only inside the container (M2)
[[ $(echo "SELECT count(*) FROM mysql.user WHERE user = 'root' AND host NOT IN ('localhost')" | appmaria_root) == 0 ]] \
    || die "root may connect from outside the container: see SELECT user, host FROM mysql.user"
say ok "$APPMARIA_CONTAINER running on 127.0.0.1:$APPMARIA_PORT (root inside it only)"

# ---------------------------------------------------------------- 5. the Studio's login (M3)
if [[ ! -s $APPMARIA_PASS/$APPMARIA_STUDIO.pass ]]; then
    ( umask 077; head -c 33 /dev/urandom | base64 | tr -d '/+=\n' > "$APPMARIA_PASS/$APPMARIA_STUDIO.pass.new" )
    chown root:root "$APPMARIA_PASS/$APPMARIA_STUDIO.pass.new"; chmod 600 "$APPMARIA_PASS/$APPMARIA_STUDIO.pass.new"
    mv "$APPMARIA_PASS/$APPMARIA_STUDIO.pass.new" "$APPMARIA_PASS/$APPMARIA_STUDIO.pass"
    say ok "made the password of $APPMARIA_STUDIO"
fi
pw=$(cat "$APPMARIA_PASS/$APPMARIA_STUDIO.pass")
[[ $pw =~ ^[A-Za-z0-9]+$ ]] || die "$APPMARIA_PASS/$APPMARIA_STUDIO.pass isn't letters and digits only"
sed "s|__PASSWORD__|$pw|g" "$ROLES/roles-maria.sql.in" | appmaria_root >/dev/null
[[ "$(appmaria_as "$APPMARIA_STUDIO" "$pw" -e 'SELECT 1')" == 1 ]] || die "the Studio's login doesn't work on 127.0.0.1:$APPMARIA_PORT"
grants=$(echo "SHOW GRANTS FOR '$APPMARIA_STUDIO'@'%';" | appmaria_root)
for p in SUPER FILE PROCESS RELOAD SHUTDOWN 'REPLICATION SLAVE' 'REPLICATION CLIENT'; do
    if grep -q "$p" <<<"$grants"; then die "$APPMARIA_STUDIO has MariaDB $p -- that is not what roles-maria.sql.in says"; fi
done
grep -q 'CREATE USER' <<<"$grants" || die "$APPMARIA_STUDIO cannot make logins -- the Studio's Database users need CREATE USER"
install -d -o root -g root -m 700 "$(dirname "$APPMARIA_STUDIO_CRED")"
install -m 600 -o root -g root "$APPMARIA_PASS/$APPMARIA_STUDIO.pass" "$APPMARIA_STUDIO_CRED"
say ok "the Studio's login $APPMARIA_STUDIO (no SUPER, FILE, PROCESS, RELOAD or SHUTDOWN); password for lfdln-pammydb in $APPMARIA_STUDIO_CRED"

# ---------------------------------------------------------------- 6. timers
appmaria_ctl daemon-reload
appmaria_ctl enable --now podman-auto-update.timer lfdln-appmaria-backup.timer >/dev/null
say ok "nightly backup (05:15 UTC, kept as Settings > Backups says) + container auto-update timers on"
