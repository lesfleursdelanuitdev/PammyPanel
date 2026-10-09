#!/usr/bin/env bash
# Backup of the panel + gate database (docs/postgres-plan.md P12): pg_dump -Fc of
# pammy, and the roles (without passwords: those are podman secrets). Runs as
# svc-pammypanel-db, nightly from pammy-pg-backup.timer, and from the panel
# installer before every migration (with a label: backup-pammy-pg.sh before-<release>).
#
# Installed to /var/lib/svc-pammypanel-db/bin/. Backups: /var/lib/svc-pammypanel-db/backups (700).
# Restoring: deploy/pg/README.md.
set -euo pipefail
dest=${PAMMY_PG_BACKUPS:-/var/lib/svc-pammypanel-db/backups}
keep_days=14
label=${1:-nightly}
[[ $label =~ ^[a-z0-9][a-z0-9.-]{0,60}$ ]] || { echo "bad label: $label" >&2; exit 2; }

umask 077
mkdir -p "$dest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$dest/pammy-$stamp-$label"

# the superuser over the container's own socket (peer, see pg_hba.conf)
podman exec -u postgres pammy-pg pg_dump -Fc -d pammy > "$out.dump.part"
podman exec -u postgres pammy-pg pg_dumpall --roles-only --no-role-passwords > "$out.roles.sql.part"
# a dump that pg_restore can't read is no backup
podman exec -i -u postgres pammy-pg pg_restore --list < "$out.dump.part" > /dev/null
mv "$out.dump.part" "$out.dump"
mv "$out.roles.sql.part" "$out.roles.sql"

# nightly ones age out; the installer's before-* ones are kept 60 days
find "$dest" -maxdepth 1 -name 'pammy-*-nightly.*' -mtime +$keep_days -delete
find "$dest" -maxdepth 1 -name 'pammy-*-before-*' -mtime +60 -delete
find "$dest" -maxdepth 1 -name '*.part' -mmin +600 -delete   # leftovers from a failed run
echo "backup ok: $out.dump"
