# shellcheck shell=bash
# lfdln's Postgres for the apps' data (docs/data-move-plan.md M1): TutorStar's and the
# Gonsalves apps' databases, moved here from the server's own Postgres (:5432). Apart
# from the panel's own lfdln-pg (:5435), as pammy.org keeps Pamela's databases apart
# from its panel's. Sourced by install-appdb.sh, move-db.sh and lfdln's verify, not run.

APPDB_SRC="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"   # not ~ : under sudo that is /root

APPDB_SVC=svc-lfdlnappdb
APPDB_HOME=/var/lib/svc-lfdlnappdb
APPDB_PORT=5436
APPDB_IMAGE=docker.io/library/postgres:17
APPDB_CONTAINER=lfdln-appdb
# the apps' roles, as they are on :5432 (their names, attributes and privileges carried
# over, docs/data-move-plan.md M4); each one's new password is a podman secret here and
# a root-only file in $APPDB_PASS for the move tool
APPDB_ROLES=(tutorstar ligneous_user gonsalves_readonly)
APPDB_SECRETS=(lfdln-appdb-super lfdln-appdb-tutorstar lfdln-appdb-ligneous_user lfdln-appdb-gonsalves_readonly)
# the projects' roles (apps.sql), made here rather than moved: their passwords are made by
# install-appdb.sh as root-only files in $APPDB_PASS and given to the engine over its socket
APPDB_APP_ROLES=(examprep_owner examprep_app)
# the Studio's login (studio.sql, docs/phase8-plan.md 8-4): made here, its password a root-only
# file in $APPDB_PASS and a copy for lfdln-pammydb's LoadCredential; and the apps' databases it
# reads, each with its schema (the same list as sites/lfdln/src/studio-site.ts APP_DATABASES)
APPDB_STUDIO=pammy_studio
APPDB_STUDIO_READS=(tutorstar:public ligneous_frontend:public examprep:prep)
APPDB_STUDIO_CRED=/etc/lfdln-panel/db/studio-postgres.pass
APPDB_PASS=/etc/lfdln-appdb
APPDB_BACKUPS=$APPDB_HOME/backups

say() { printf '  %-4s %s\n' "$1" "$2"; }

appdb_uid() { id -u "$APPDB_SVC"; }
as_appdb() {  # rootless podman needs its runtime dir and a readable cwd
    (cd / && runuser -u "$APPDB_SVC" -- env XDG_RUNTIME_DIR="/run/user/$(appdb_uid)" HOME="$APPDB_HOME" "$@")
}
appdb_ctl() { systemctl --user -M "$APPDB_SVC@" "$@"; }

# SQL as the superuser, over the container's own socket (peer). Statements on stdin.
appdb_super() { as_appdb podman exec -i -u postgres "$APPDB_CONTAINER" psql -v ON_ERROR_STOP=1 -X -qtA "$@"; }
appdb_secret_of() { as_appdb podman exec "$APPDB_CONTAINER" cat "/run/secrets/$1"; }

# SQL as one of the apps' roles the way an app connects: TCP 127.0.0.1:5436, password
appdb_as() {  # appdb_as <role> <database> <psql args...>
    local role=$1 db=$2; shift 2
    PGPASSWORD="$(cat "$APPDB_PASS/$role.pass")" PGCONNECT_TIMEOUT=5 \
        psql -X -v ON_ERROR_STOP=1 -qtA -h 127.0.0.1 -p "$APPDB_PORT" -U "$role" -d "$db" "$@"
}

appdb_wait_healthy() {  # the image's own healthcheck
    local i
    for i in $(seq 90); do
        as_appdb podman healthcheck run "$APPDB_CONTAINER" >/dev/null 2>&1 && return 0
        sleep 2
    done
    say FAIL "$APPDB_CONTAINER didn't become ready after 3 minutes"
    echo "       logs: journalctl _SYSTEMD_USER_UNIT=$APPDB_CONTAINER.service _UID=$(appdb_uid) -n 50" >&2
    return 1
}
