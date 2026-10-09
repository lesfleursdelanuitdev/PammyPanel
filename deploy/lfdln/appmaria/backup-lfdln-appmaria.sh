#!/usr/bin/env bash
# Backup of lfdln's MariaDB (docs/lfdln-mariadb-plan.md M5): mariadb-dump of each database
# there (not the engine's own), gzipped and read back to the end, and the accounts with their
# grants (no passwords). Runs as svc-lfdlnmaria, nightly from lfdln-appmaria-backup.timer.
# How long they are kept is the panel's setting (Settings > Backups, B2): the panel deletes the
# old ones. 400 days here is only a backstop, for a panel that never runs.
#
# Installed to /var/lib/svc-lfdlnmaria/bin/. Backups: /var/lib/svc-lfdlnmaria/backups (700).
set -euo pipefail
dest=/var/lib/svc-lfdlnmaria/backups
label=${1:-nightly}
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,60}$ ]] || { echo "bad label: $label" >&2; exit 2; }

umask 077
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
root() { podman exec -i lfdln-appmaria sh -c 'MYSQL_PWD="$(cat /run/secrets/lfdln-appmaria-root)" exec "$@"' sh "$@"; }
dbs=$(root mariadb -uroot --batch --skip-column-names -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1")
for db in $dbs; do
    [[ $db =~ ^[a-z][a-z0-9_]{0,63}$ ]] || { echo "skipping a database with an unexpected name: $db" >&2; continue; }
    out="$dest/$db-$stamp-$label.sql.gz"
    root mariadb-dump -uroot --single-transaction --routines --triggers --events --databases "$db" | gzip > "$out.part"
    # a dump that doesn't read back to its last line is no backup
    gzip -t "$out.part"
    zcat "$out.part" | tail -n 1 | grep -q '^-- Dump completed' || { echo "dump of $db is incomplete" >&2; exit 1; }
    mv "$out.part" "$out"
    echo "backup ok: $out"
done
# the accounts and what they may do, without passwords (they are set again from the panel)
root mariadb -uroot --batch --skip-column-names -e "SELECT CONCAT('SHOW GRANTS FOR ''', user, '''@''', host, ''';') FROM mysql.user WHERE user NOT IN ('root','mariadb.sys','healthcheck','mysql') ORDER BY 1" \
    | root mariadb -uroot --batch --skip-column-names | sed -E "s/ IDENTIFIED BY PASSWORD '[^']*'//" > "$dest/accounts-$stamp-$label.sql"

# the panel keeps them as long as its setting says; this is only a backstop
find "$dest" -maxdepth 1 -type f -mtime +400 -delete
find "$dest" -maxdepth 1 -name '*.part' -mmin +600 -delete
