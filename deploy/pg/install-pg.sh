#!/usr/bin/env bash
# The panel's and the gate's own Postgres (docs/postgres-plan.md, build step 1):
# a rootless container "pammy-pg" under svc-pammypanel-db on 127.0.0.1:5434,
# database pammy with schemas panel / media / gate, and one role per process.
#
#   sudo ~/pamela-setup/panel/deploy/pg/install-pg.sh
#
# Nothing uses it yet: the panel and the gate stay on SQLite until the cutover.
# Passwords: podman secrets, copied to /etc/pammy-panel/db/<role>.pass (root 600)
# for the services (LoadCredential=) and the installer. Nightly dumps (14 days):
# /var/lib/svc-pammypanel-db/backups.
#
# Safe to re-run: each step checks whether it's already done; the roles' rights
# are put back to what setup.sql says.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-pg.sh"
die() { say FAIL "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
command -v podman >/dev/null || die "needs podman"
command -v psql >/dev/null || die "needs the psql client (postgresql-client)"
if ss -ltnpH "sport = :$PG_PORT" | grep -q . && ! ss -ltnpH "sport = :$PG_PORT" | grep -q rootlessport; then
    die "port $PG_PORT is already used by something else: $(ss -ltnpH "sport = :$PG_PORT")"
fi
if [[ -e $SVC_HOME ]] && [[ "$(stat -c %U "$SVC_HOME")" != "$SVC" ]]; then
    die "$SVC_HOME already exists and isn't $SVC's -- not touching it"
fi
for f in pg_hba.conf setup.sql backup-pammy-pg.sh quadlet/pammy-pg.container quadlet/pammy-pg.volume \
         systemd/pammy-pg-backup.service systemd/pammy-pg-backup.timer; do
    [[ -f $PGSRC/$f ]] || die "missing $PGSRC/$f"
done

# ---------------------------------------------------------------- 1. identity
if ! id "$SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$SVC_HOME" --create-home --shell /usr/sbin/nologin "$SVC"
    say ok "created system user $SVC"
fi
chmod 700 "$SVC_HOME"
if ! grep -q "^$SVC:" /etc/subuid; then
    # next free range after everyone else's
    start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print m}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start+65535))" --add-subgids "$start-$((start+65535))" "$SVC"
    say ok "subuid/subgid $start-$((start+65535))"
fi
# Podman 4.9's rootless netns overmounts /var/lib/cni, or its nearest existing
# parent (= all of /var/lib, hiding this user's storage). See wordpress/README.
install -d -o root -g root -m 755 /var/lib/cni
loginctl enable-linger "$SVC"
for i in $(seq 30); do [[ -S /run/user/$(svc_uid)/bus ]] && break; sleep 1; done
[[ -S /run/user/$(svc_uid)/bus ]] || die "$SVC's systemd user manager didn't start"

# ---------------------------------------------------------------- 2. folders + files
# bin and conf are root's: the service user runs and mounts them, can't change them
install -d -o root -g root -m 755 "$SVC_HOME/bin" "$SVC_HOME/conf"
install -m 755 -o root -g root "$PGSRC/backup-pammy-pg.sh" "$SVC_HOME/bin/"
# 644: Postgres inside the container is a subuid, not root, and has to read it
install -m 644 -o root -g root "$PGSRC/pg_hba.conf" "$SVC_HOME/conf/pg_hba.conf"
install -d -o "$SVC" -g "$SVC" -m 700 "$BACKUPS"
install -d -o root -g root -m 755 /etc/pammy-panel
install -d -o root -g root -m 700 "$PASS_DIR"

# ---------------------------------------------------------------- 3. secrets
for s in "${SECRETS[@]}"; do
    if ! as_svc podman secret exists "$s"; then
        # letters and digits only, so they're safe anywhere
        head -c 33 /dev/urandom | base64 | tr -d '/+=\n' | as_svc podman secret create "$s" - >/dev/null
        say ok "podman secret $s"
    fi
done

# ---------------------------------------------------------------- 4. units + start
qd=$SVC_HOME/.config/containers/systemd; ud=$SVC_HOME/.config/systemd/user
install -d -o "$SVC" -g "$SVC" -m 700 "$SVC_HOME/.config" "$qd" "$ud"
unit_before=$({ cat "$qd"/pammy-pg.* 2>/dev/null || true; } | sha256sum)   # none yet on a first install
install -m 644 -o "$SVC" -g "$SVC" "$PGSRC"/quadlet/* "$qd/"
install -m 644 -o "$SVC" -g "$SVC" "$PGSRC"/systemd/* "$ud/"
as_svc podman image exists "$IMAGE" || { say ... "pulling $IMAGE"; as_svc podman pull -q "$IMAGE" >/dev/null; }
svc_ctl daemon-reload
svc_ctl reset-failed "$CONTAINER.service" 2>/dev/null || true   # re-run after a failed start
if svc_ctl is-active -q "$CONTAINER.service"; then
    # a re-run: a changed unit needs a restart; a new pg_hba.conf only the reload below
    if [[ "$(cat "$qd"/pammy-pg.* | sha256sum)" != "$unit_before" ]]; then
        svc_ctl restart "$CONTAINER.service"; say ok "restarted $CONTAINER (its unit changed)"
    fi
else
    svc_ctl start "$CONTAINER.service"
fi
wait_healthy || exit 1
echo 'SELECT pg_reload_conf()' | pg_super >/dev/null
# the engine must see the pg_hba.conf just installed (pg_hba_file_rules reads it as the engine does)
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL" | pg_super) == 0 ]] \
    || die "the engine finds errors in its pg_hba.conf: see SELECT * FROM pg_hba_file_rules"
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules" | pg_super) == "$(grep -cE '^(local|host)' "$PGSRC/pg_hba.conf")" ]] \
    || die "the engine doesn't see the pg_hba.conf just installed (is $SVC_HOME/conf mounted as a folder?)"
say ok "$CONTAINER running on 127.0.0.1:$PG_PORT"

# ---------------------------------------------------------------- 5. database, roles, rights
pg_super < "$PGSRC/setup.sql" >/dev/null
say ok "database $PG_DB, schemas panel/media/gate, roles pammy_{owner,panel,gate}"

# ---------------------------------------------------------------- 6. password files
# From the secrets every time, so they can't drift apart.
for r in "${ROLES[@]}"; do
    ( umask 077; secret_of "pammy-pg-$r" > "$PASS_DIR/$r.pass.new" )
    [[ -s $PASS_DIR/$r.pass.new ]] || die "couldn't read the secret pammy-pg-$r"
    chown root:root "$PASS_DIR/$r.pass.new"; chmod 600 "$PASS_DIR/$r.pass.new"
    mv "$PASS_DIR/$r.pass.new" "$PASS_DIR/$r.pass"
done
say ok "passwords in $PASS_DIR/{owner,panel,gate}.pass (root 600)"

# ---------------------------------------------------------------- 7. timers + first backup
svc_ctl daemon-reload
svc_ctl enable --now podman-auto-update.timer pammy-pg-backup.timer >/dev/null
svc_ctl start pammy-pg-backup.service \
    || die "the first backup failed: journalctl _SYSTEMD_USER_UNIT=pammy-pg-backup.service _UID=$(svc_uid) -n 30"
say ok "nightly backup (04:30 UTC) + container auto-update timers on; first backup made"

echo
exec "$PGSRC/verify-pg.sh"
