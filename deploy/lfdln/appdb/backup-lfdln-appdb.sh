#!/usr/bin/env bash
# Backup of lfdln's apps' databases (docs/data-move-plan.md M1): pg_dump -Fc of each
# database there, and the roles (without passwords: those are podman secrets). Runs as
# svc-lfdlnappdb, nightly from lfdln-appdb-backup.timer, and from move-db.sh before a
# switch (with a label: backup-lfdln-appdb.sh before-switch-tutorstar).
#
# Installed to /var/lib/svc-lfdlnappdb/bin/. Backups: /var/lib/svc-lfdlnappdb/backups (700).
set -euo pipefail
dest=/var/lib/svc-lfdlnappdb/backups
label=${1:-nightly}
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,60}$ ]] || { echo "bad label: $label" >&2; exit 2; }

umask 077
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dbs=$(podman exec -u postgres lfdln-appdb psql -XtA -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' AND datname NOT LIKE 'prisma_migrate_shadow_db_%' ORDER BY 1")
for db in $dbs; do
    out="$dest/$db-$stamp-$label"
    podman exec -u postgres lfdln-appdb pg_dump -Fc -d "$db" > "$out.dump.part"
    # a dump that pg_restore can't read is no backup
    podman exec -i -u postgres lfdln-appdb pg_restore --list < "$out.dump.part" > /dev/null
    mv "$out.dump.part" "$out.dump"
    echo "backup ok: $out.dump"
done
podman exec -u postgres lfdln-appdb pg_dumpall --roles-only --no-role-passwords > "$dest/roles-$stamp-$label.sql"

# how long they are kept is the panel's Settings > Backups (docs/lfdln-mariadb-plan.md B2): the
# panel deletes the old ones. 400 days here is only a backstop, for a panel that never runs.
find "$dest" -maxdepth 1 -type f -mtime +400 -delete
find "$dest" -maxdepth 1 -name '*.part' -mmin +600 -delete
