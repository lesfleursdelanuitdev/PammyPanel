# shellcheck shell=bash
# lfdln's MariaDB for the Studio's databases (docs/lfdln-mariadb-plan.md M1): a rootless
# container "lfdln-appmaria" under svc-lfdlnmaria on 127.0.0.1:3308 (3307 is Pamela's). No apps
# on it (M2): the databases made in the Studio and their db_ logins. Sourced by
# install-appmaria.sh and lfdln's verify, not run.

APPMARIA_SRC="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"   # not ~ : under sudo that is /root

APPMARIA_SVC=svc-lfdlnmaria
APPMARIA_HOME=/var/lib/svc-lfdlnmaria
APPMARIA_PORT=3308
APPMARIA_IMAGE=docker.io/library/mariadb:11.4
APPMARIA_CONTAINER=lfdln-appmaria
# root's password: a podman secret, only ever used inside the container
APPMARIA_SECRETS=(lfdln-appmaria-root)
# the Studio's login (M3): its password a root-only file here, and a copy for lfdln-pammydb
APPMARIA_STUDIO=pammy_studio
APPMARIA_PASS=/etc/lfdln-appmaria
APPMARIA_STUDIO_CRED=/etc/lfdln-panel/db/studio-mariadb.pass
APPMARIA_BACKUPS=$APPMARIA_HOME/backups

say() { printf '  %-4s %s\n' "$1" "$2"; }

appmaria_uid() { id -u "$APPMARIA_SVC"; }
as_appmaria() {  # rootless podman needs its runtime dir and a readable cwd
    (cd / && runuser -u "$APPMARIA_SVC" -- env XDG_RUNTIME_DIR="/run/user/$(appmaria_uid)" HOME="$APPMARIA_HOME" "$@")
}
appmaria_ctl() { systemctl --user -M "$APPMARIA_SVC@" "$@"; }

# SQL as root, inside the container (root is only 'root'@'localhost' there). Statements on stdin.
appmaria_root() {
    as_appmaria podman exec -i "$APPMARIA_CONTAINER" sh -c \
        'MYSQL_PWD="$(cat /run/secrets/lfdln-appmaria-root)" exec mariadb -uroot --batch --skip-column-names'
}
# SQL as a login the way a program connects: TCP 127.0.0.1:3308, password
appmaria_as() {  # appmaria_as <login> <password> <mariadb args...>
    local login=$1 pw=$2; shift 2
    MYSQL_PWD="$pw" mariadb -h 127.0.0.1 -P "$APPMARIA_PORT" -u "$login" --connect-timeout=5 --batch --skip-column-names "$@"
}

appmaria_wait_healthy() {  # the image's own healthcheck
    local i
    for i in $(seq 90); do
        as_appmaria podman healthcheck run "$APPMARIA_CONTAINER" >/dev/null 2>&1 && return 0
        sleep 2
    done
    say FAIL "$APPMARIA_CONTAINER didn't become ready after 3 minutes"
    echo "       logs: journalctl _SYSTEMD_USER_UNIT=$APPMARIA_CONTAINER.service _UID=$(appmaria_uid) -n 50" >&2
    return 1
}
