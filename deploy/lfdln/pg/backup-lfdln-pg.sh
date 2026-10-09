#!/usr/bin/env bash
# Backup of lfdln's panel database (as pammy.org's deploy/pg/backup-pammy-pg.sh): pg_dump
# -Fc of lfdln, and the roles (without passwords: those are podman secrets). Runs as
# svc-lfdlnpanel-db, nightly from lfdln-pg-backup.timer, and from the lfdln installer
# before every install (with a label: backup-lfdln-pg.sh before-<release>).
#
# Installed to /var/lib/svc-lfdlnpanel-db/bin/. Backups: /var/lib/svc-lfdlnpanel-db/backups (700).
set -euo pipefail
dest=/var/lib/svc-lfdlnpanel-db/backups
keep_days=14
label=${1:-nightly}
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,60}$ ]] || { echo "bad label: $label" >&2; exit 2; }

umask 077
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$dest/lfdln-$stamp-$label"

podman exec -u postgres lfdln-pg pg_dump -Fc -d lfdln > "$out.dump.part"
podman exec -u postgres lfdln-pg pg_dumpall --roles-only --no-role-passwords > "$out.roles.sql.part"
# a dump that pg_restore can't read is no backup
podman exec -i -u postgres lfdln-pg pg_restore --list < "$out.dump.part" > /dev/null
mv "$out.dump.part" "$out.dump"
mv "$out.roles.sql.part" "$out.roles.sql"

# nightly ones age out; the installer's before-* ones are kept 60 days
find "$dest" -maxdepth 1 -name 'lfdln-*-nightly.*' -mtime +$keep_days -delete
find "$dest" -maxdepth 1 -name 'lfdln-*-before-*' -mtime +60 -delete
find "$dest" -maxdepth 1 -name '*.part' -mmin +600 -delete
echo "backup ok: $out.dump"
