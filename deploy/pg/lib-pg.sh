# shellcheck shell=bash
# Shared by install-pg.sh and verify-pg.sh (docs/postgres-plan.md). Sourced, not run.

PGSRC="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"   # not ~ : under sudo that is /root

SVC=svc-pammypanel-db
SVC_HOME=/var/lib/svc-pammypanel-db
PG_PORT=5434
PG_DB=pammy
IMAGE=docker.io/library/postgres:17
CONTAINER=pammy-pg
SECRETS=(pammy-pg-super pammy-pg-owner pammy-pg-panel pammy-pg-gate)
ROLES=(owner panel gate)                 # pammy_<role>, password in $PASS_DIR/<role>.pass
PASS_DIR=/etc/pammy-panel/db             # root 700; the services get theirs with LoadCredential=
BACKUPS=$SVC_HOME/backups

say() { printf '  %-4s %s\n' "$1" "$2"; }

svc_uid() { id -u "$SVC"; }
as_svc() {  # as_svc <cmd...> -- rootless podman needs its runtime dir and a readable cwd
    (cd / && runuser -u "$SVC" -- env XDG_RUNTIME_DIR="/run/user/$(svc_uid)" HOME="$SVC_HOME" "$@")
}
svc_ctl() { systemctl --user -M "$SVC@" "$@"; }

# SQL as the superuser, over the container's own socket (peer). Statements on stdin.
pg_super() { as_svc podman exec -i -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -X -qtA "$@"; }
secret_of() { as_svc podman exec "$CONTAINER" cat "/run/secrets/$1"; }

# SQL as pammy_<role> the way the services connect: host psql, TCP 127.0.0.1:5434, password.
# The password goes through the environment (only root can read another process's).
pg_as() {  # pg_as <role> <psql args...>
    local role=$1; shift
    PGPASSWORD="$(cat "$PASS_DIR/$role.pass")" PGCONNECT_TIMEOUT=5 \
        psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p "$PG_PORT" -U "pammy_$role" -d "$PG_DB" "$@"
}

wait_healthy() {  # the image's own healthcheck
    local i
    for i in $(seq 90); do
        as_svc podman healthcheck run "$CONTAINER" >/dev/null 2>&1 && return 0
        sleep 2
    done
    say FAIL "$CONTAINER didn't become ready after 3 minutes"
    echo "       logs: journalctl _SYSTEMD_USER_UNIT=$CONTAINER.service _UID=$(svc_uid) -n 50" >&2
    return 1
}
