# shellcheck shell=bash
# lfdln's panel database (docs/lfdln-standup-plan.md Q2): its own rootless Postgres,
# like pammy.org's (deploy/pg/), sharing nothing with it. Sourced by install-pg.sh and
# the lfdln installer and verify, not run.
#
# The roles keep the panel's own names (pammy_owner, pammy_panel, pammy_gate): the code
# and db/schema.snapshot.sql name them, and this is a cluster of its own, so they are
# not pammy.org's roles, only the same names. The database is lfdln.

LFDLN_PGSRC="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"   # not ~ : under sudo that is /root

PG_SVC=svc-lfdlnpanel-db
PG_SVC_HOME=/var/lib/svc-lfdlnpanel-db
PG_PORT=5435
PG_DB=lfdln
PG_IMAGE=docker.io/library/postgres:17
PG_CONTAINER=lfdln-pg
PG_SECRETS=(lfdln-pg-super lfdln-pg-owner lfdln-pg-panel lfdln-pg-gate)
PG_ROLES=(owner panel gate)              # pammy_<role>, password in $PASS_DIR/<role>.pass
PASS_DIR=/etc/lfdln-panel/db             # root 700; the panel gets its with LoadCredential=
PG_BACKUPS=$PG_SVC_HOME/backups

say() { printf '  %-4s %s\n' "$1" "$2"; }

pg_svc_uid() { id -u "$PG_SVC"; }
as_pg_svc() {  # rootless podman needs its runtime dir and a readable cwd
    (cd / && runuser -u "$PG_SVC" -- env XDG_RUNTIME_DIR="/run/user/$(pg_svc_uid)" HOME="$PG_SVC_HOME" "$@")
}
pg_svc_ctl() { systemctl --user -M "$PG_SVC@" "$@"; }

# SQL as the superuser, over the container's own socket (peer). Statements on stdin.
pg_super() { as_pg_svc podman exec -i -u postgres "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -X -qtA "$@"; }
pg_secret_of() { as_pg_svc podman exec "$PG_CONTAINER" cat "/run/secrets/$1"; }

# SQL as pammy_<role> the way the panel connects: TCP 127.0.0.1:5435, password.
pg_as() {  # pg_as <role> <psql args...>
    local role=$1; shift
    PGPASSWORD="$(cat "$PASS_DIR/$role.pass")" PGCONNECT_TIMEOUT=5 \
        psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p "$PG_PORT" -U "pammy_$role" -d "$PG_DB" "$@"
}

pg_wait_healthy() {  # the image's own healthcheck
    local i
    for i in $(seq 90); do
        as_pg_svc podman healthcheck run "$PG_CONTAINER" >/dev/null 2>&1 && return 0
        sleep 2
    done
    say FAIL "$PG_CONTAINER didn't become ready after 3 minutes"
    echo "       logs: journalctl _SYSTEMD_USER_UNIT=$PG_CONTAINER.service _UID=$(pg_svc_uid) -n 50" >&2
    return 1
}
