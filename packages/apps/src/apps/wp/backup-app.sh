#!/usr/bin/env bash
# Nightly backup of a WordPress installed from the pammy.org panel (docs/apps-plan.md 4b):
# its database dump, its files, and the address its links use -- the same files,
# names and 14 days as the blog's backup-wordpress.sh, so the panel's Backups,
# Put this back and Download work the same for both. Runs as the install's own
# user, from its backup unit, which sets every APP_ variable.
set -euo pipefail
: "${APP_DB_CONTAINER:?}" "${APP_ROOT_SECRET:?}" "${APP_DATABASE:?}" "${APP_FILES:?}" "${APP_BACKUPS:?}" "${APP_CONTENT_URL:?}"
keep_days=14
umask 077
mkdir -p "$APP_BACKUPS"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
podman exec -e "S=$APP_ROOT_SECRET" -e "D=$APP_DATABASE" "$APP_DB_CONTAINER" sh -c \
    'MYSQL_PWD="$(cat "/run/secrets/$S")" exec mariadb-dump -uroot --single-transaction --routines --triggers --databases "$D"' \
    | gzip > "$APP_BACKUPS/db-$stamp.sql.gz.part"
mv "$APP_BACKUPS/db-$stamp.sql.gz.part" "$APP_BACKUPS/db-$stamp.sql.gz"
tar -C "$(dirname "$APP_FILES")" -czf "$APP_BACKUPS/files-$stamp.tar.gz.part" "$(basename "$APP_FILES")"
mv "$APP_BACKUPS/files-$stamp.tar.gz.part" "$APP_BACKUPS/files-$stamp.tar.gz"
cp "$APP_CONTENT_URL" "$APP_BACKUPS/url-$stamp.txt" 2>/dev/null || true
find "$APP_BACKUPS" -maxdepth 1 \( -name 'db-*.sql.gz' -o -name 'files-*.tar.gz' -o -name 'url-*.txt' \) -mtime +$keep_days -delete
find "$APP_BACKUPS" -maxdepth 1 -name '*.part' -mmin +600 -delete
echo "backup ok: $APP_BACKUPS/{db,files}-$stamp"
