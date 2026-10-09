#!/usr/bin/env bash
# lfdln's panel database (docs/lfdln-standup-plan.md Q2): a rootless container
# "lfdln-pg" under svc-lfdlnpanel-db on 127.0.0.1:5435, database lfdln, the panel's
# roles. The same steps as pammy.org's deploy/pg/install-pg.sh, with nothing shared.
#
#   sudo ~/pamela-setup/panel/deploy/lfdln/pg/install-pg.sh    (install-lfdln.sh runs it)
#
# Passwords: podman secrets, copied to /etc/lfdln-panel/db/<role>.pass (root 600) for
# the panel (LoadCredential=) and the installer. Nightly dumps (14 days):
# /var/lib/svc-lfdlnpanel-db/backups. Safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-pg.sh"
die() { say FAIL "$1" >&2; exit 1; }
S=$LFDLN_PGSRC

# ---------------------------------------------------------------- preflight
command -v podman >/dev/null || die "needs podman"
command -v psql >/dev/null || die "needs the psql client (postgresql-client)"
if ss -ltnpH "sport = :$PG_PORT" | grep -q . && ! ss -ltnpH "sport = :$PG_PORT" | grep -q rootlessport; then
    die "port $PG_PORT is already used by something else: $(ss -ltnpH "sport = :$PG_PORT")"
fi
if [[ -e $PG_SVC_HOME ]] && [[ "$(stat -c %U "$PG_SVC_HOME")" != "$PG_SVC" ]]; then
    die "$PG_SVC_HOME already exists and isn't $PG_SVC's -- not touching it"
fi
for f in pg_hba.conf setup.sql backup-lfdln-pg.sh quadlet/lfdln-pg.container quadlet/lfdln-pg.volume \
         systemd/lfdln-pg-backup.service systemd/lfdln-pg-backup.timer; do
    [[ -f $S/$f ]] || die "missing $S/$f"
done

# ---------------------------------------------------------------- 1. identity
if ! id "$PG_SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$PG_SVC_HOME" --create-home --shell /usr/sbin/nologin "$PG_SVC"
    say ok "created system user $PG_SVC"
fi
chmod 700 "$PG_SVC_HOME"
if ! grep -q "^$PG_SVC:" /etc/subuid; then
    # next free range after everyone else's
    start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print m}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start+65535))" --add-subgids "$start-$((start+65535))" "$PG_SVC"
    say ok "subuid/subgid $start-$((start+65535))"
fi
# Podman 4.9's rootless netns overmounts /var/lib/cni, or its nearest existing parent
install -d -o root -g root -m 755 /var/lib/cni
loginctl enable-linger "$PG_SVC"
for i in $(seq 30); do [[ -S /run/user/$(pg_svc_uid)/bus ]] && break; sleep 1; done
[[ -S /run/user/$(pg_svc_uid)/bus ]] || die "$PG_SVC's systemd user manager didn't start"

# ---------------------------------------------------------------- 2. folders + files
install -d -o root -g root -m 755 "$PG_SVC_HOME/bin" "$PG_SVC_HOME/conf"
install -m 755 -o root -g root "$S/backup-lfdln-pg.sh" "$PG_SVC_HOME/bin/"
install -m 644 -o root -g root "$S/pg_hba.conf" "$PG_SVC_HOME/conf/pg_hba.conf"
install -d -o "$PG_SVC" -g "$PG_SVC" -m 700 "$PG_BACKUPS"
install -d -o root -g root -m 755 /etc/lfdln-panel
install -d -o root -g root -m 700 "$PASS_DIR"

# ---------------------------------------------------------------- 3. secrets
for s in "${PG_SECRETS[@]}"; do
    if ! as_pg_svc podman secret exists "$s"; then
        head -c 33 /dev/urandom | base64 | tr -d '/+=\n' | as_pg_svc podman secret create "$s" - >/dev/null
        say ok "podman secret $s"
    fi
done

# ---------------------------------------------------------------- 4. units + start
qd=$PG_SVC_HOME/.config/containers/systemd; ud=$PG_SVC_HOME/.config/systemd/user
install -d -o "$PG_SVC" -g "$PG_SVC" -m 700 "$PG_SVC_HOME/.config" "$qd" "$ud"
unit_before=$({ cat "$qd"/lfdln-pg.* 2>/dev/null || true; } | sha256sum)
install -m 644 -o "$PG_SVC" -g "$PG_SVC" "$S"/quadlet/* "$qd/"
install -m 644 -o "$PG_SVC" -g "$PG_SVC" "$S"/systemd/* "$ud/"
as_pg_svc podman image exists "$PG_IMAGE" || { say ... "pulling $PG_IMAGE"; as_pg_svc podman pull -q "$PG_IMAGE" >/dev/null; }
pg_svc_ctl daemon-reload
pg_svc_ctl reset-failed "$PG_CONTAINER.service" 2>/dev/null || true
if pg_svc_ctl is-active -q "$PG_CONTAINER.service"; then
    if [[ "$(cat "$qd"/lfdln-pg.* | sha256sum)" != "$unit_before" ]]; then
        pg_svc_ctl restart "$PG_CONTAINER.service"; say ok "restarted $PG_CONTAINER (its unit changed)"
    fi
else
    pg_svc_ctl start "$PG_CONTAINER.service"
fi
pg_wait_healthy || exit 1
echo 'SELECT pg_reload_conf()' | pg_super >/dev/null
# the engine must see the pg_hba.conf just installed (pg_hba_file_rules reads it as the engine does)
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL" | pg_super) == 0 ]] \
    || die "the engine finds errors in its pg_hba.conf: see SELECT * FROM pg_hba_file_rules"
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules" | pg_super) == "$(grep -cE '^(local|host)' "$S/pg_hba.conf")" ]] \
    || die "the engine doesn't see the pg_hba.conf just installed (is $PG_SVC_HOME/conf mounted as a folder?)"
say ok "$PG_CONTAINER running on 127.0.0.1:$PG_PORT"

# ---------------------------------------------------------------- 5. database, roles, rights
pg_super < "$S/setup.sql" >/dev/null
say ok "database $PG_DB, schemas panel/media/gate, roles pammy_{owner,panel,gate}"

# ---------------------------------------------------------------- 6. password files
for r in "${PG_ROLES[@]}"; do
    ( umask 077; pg_secret_of "lfdln-pg-$r" > "$PASS_DIR/$r.pass.new" )
    [[ -s $PASS_DIR/$r.pass.new ]] || die "couldn't read the secret lfdln-pg-$r"
    chown root:root "$PASS_DIR/$r.pass.new"; chmod 600 "$PASS_DIR/$r.pass.new"
    mv "$PASS_DIR/$r.pass.new" "$PASS_DIR/$r.pass"
done
say ok "passwords in $PASS_DIR/{owner,panel,gate}.pass (root 600)"

# ---------------------------------------------------------------- 7. timers
pg_svc_ctl daemon-reload
pg_svc_ctl enable --now podman-auto-update.timer lfdln-pg-backup.timer >/dev/null
say ok "nightly backup (04:45 UTC) + container auto-update timers on"
