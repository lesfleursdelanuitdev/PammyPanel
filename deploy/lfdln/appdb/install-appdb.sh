#!/usr/bin/env bash
# lfdln's Postgres for the apps' data (docs/data-move-plan.md M1): a rootless container
# "lfdln-appdb" under svc-lfdlnappdb on 127.0.0.1:5436, with the apps' roles and no
# databases yet (move-db.sh brings them). The same steps as the panel's own
# deploy/lfdln/pg/install-pg.sh, with nothing shared.
#
#   sudo ~/pamela-setup/panel/deploy/lfdln/appdb/install-appdb.sh    (install-lfdln.sh runs it)
#
# Passwords: podman secrets, copied to /etc/lfdln-appdb/<role>.pass (root 600) for the
# move tool, which writes them into the apps' own secrets. Nightly dumps, kept as long as the
# panel's Settings > Backups says: /var/lib/svc-lfdlnappdb/backups. Safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-appdb.sh"
die() { say FAIL "$1" >&2; exit 1; }
S=$APPDB_SRC

# ---------------------------------------------------------------- preflight
command -v podman >/dev/null || die "needs podman"
command -v psql >/dev/null || die "needs the psql client (postgresql-client)"
if ss -ltnpH "sport = :$APPDB_PORT" | grep -q . && ! ss -ltnpH "sport = :$APPDB_PORT" | grep -q rootlessport; then
    die "port $APPDB_PORT is already used by something else: $(ss -ltnpH "sport = :$APPDB_PORT")"
fi
if [[ -e $APPDB_HOME ]] && [[ "$(stat -c %U "$APPDB_HOME")" != "$APPDB_SVC" ]]; then
    die "$APPDB_HOME already exists and isn't $APPDB_SVC's -- not touching it"
fi
for f in pg_hba.conf setup.sql apps.sql studio.sql studio-reads.sql.in backup-lfdln-appdb.sh quadlet/lfdln-appdb.container quadlet/lfdln-appdb.volume \
         systemd/lfdln-appdb-backup.service systemd/lfdln-appdb-backup.timer; do
    [[ -f $S/$f ]] || die "missing $S/$f"
done

# ---------------------------------------------------------------- 1. identity
if ! id "$APPDB_SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$APPDB_HOME" --create-home --shell /usr/sbin/nologin "$APPDB_SVC"
    say ok "created system user $APPDB_SVC"
fi
chmod 700 "$APPDB_HOME"
if ! grep -q "^$APPDB_SVC:" /etc/subuid; then
    # next free range after everyone else's
    start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print m}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start+65535))" --add-subgids "$start-$((start+65535))" "$APPDB_SVC"
    say ok "subuid/subgid $start-$((start+65535))"
fi
install -d -o root -g root -m 755 /var/lib/cni
loginctl enable-linger "$APPDB_SVC"
for i in $(seq 30); do [[ -S /run/user/$(appdb_uid)/bus ]] && break; sleep 1; done
[[ -S /run/user/$(appdb_uid)/bus ]] || die "$APPDB_SVC's systemd user manager didn't start"

# ---------------------------------------------------------------- 2. folders + files
install -d -o root -g root -m 755 "$APPDB_HOME/bin" "$APPDB_HOME/conf"
install -m 755 -o root -g root "$S/backup-lfdln-appdb.sh" "$APPDB_HOME/bin/"
install -m 644 -o root -g root "$S/pg_hba.conf" "$APPDB_HOME/conf/pg_hba.conf"
install -d -o "$APPDB_SVC" -g "$APPDB_SVC" -m 700 "$APPDB_BACKUPS"
install -d -o root -g root -m 700 "$APPDB_PASS"

# ---------------------------------------------------------------- 3. secrets
for s in "${APPDB_SECRETS[@]}"; do
    if ! as_appdb podman secret exists "$s"; then
        head -c 33 /dev/urandom | base64 | tr -d '/+=\n' | as_appdb podman secret create "$s" - >/dev/null
        say ok "podman secret $s"
    fi
done

# ---------------------------------------------------------------- 4. units + start
qd=$APPDB_HOME/.config/containers/systemd; ud=$APPDB_HOME/.config/systemd/user
install -d -o "$APPDB_SVC" -g "$APPDB_SVC" -m 700 "$APPDB_HOME/.config" "$qd" "$ud"
unit_before=$({ cat "$qd"/lfdln-appdb.* 2>/dev/null || true; } | sha256sum)
install -m 644 -o "$APPDB_SVC" -g "$APPDB_SVC" "$S"/quadlet/* "$qd/"
install -m 644 -o "$APPDB_SVC" -g "$APPDB_SVC" "$S"/systemd/* "$ud/"
as_appdb podman image exists "$APPDB_IMAGE" || { say ... "pulling $APPDB_IMAGE"; as_appdb podman pull -q "$APPDB_IMAGE" >/dev/null; }
appdb_ctl daemon-reload
appdb_ctl reset-failed "$APPDB_CONTAINER.service" 2>/dev/null || true
if appdb_ctl is-active -q "$APPDB_CONTAINER.service"; then
    if [[ "$(cat "$qd"/lfdln-appdb.* | sha256sum)" != "$unit_before" ]]; then
        appdb_ctl restart "$APPDB_CONTAINER.service"; say ok "restarted $APPDB_CONTAINER (its unit changed)"
    fi
else
    appdb_ctl start "$APPDB_CONTAINER.service"
fi
appdb_wait_healthy || exit 1
echo 'SELECT pg_reload_conf()' | appdb_super >/dev/null
# the engine must see the pg_hba.conf just installed (pg_hba_file_rules reads it as the engine does)
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL" | appdb_super) == 0 ]] \
    || die "the engine finds errors in its pg_hba.conf: see SELECT * FROM pg_hba_file_rules"
[[ $(echo "SELECT count(*) FROM pg_hba_file_rules" | appdb_super) == "$(grep -cE '^(local|host)' "$S/pg_hba.conf")" ]] \
    || die "the engine doesn't see the pg_hba.conf just installed (is $APPDB_HOME/conf mounted as a folder?)"
say ok "$APPDB_CONTAINER running on 127.0.0.1:$APPDB_PORT"

# ---------------------------------------------------------------- 5. roles
appdb_super < "$S/setup.sql" >/dev/null
say ok "roles ${APPDB_ROLES[*]} (as on :5432, new passwords)"

# ---------------------------------------------------------------- 5b. the projects' databases (apps.sql)
# their passwords: made once, root-only files; the SQL gets them as \set lines on stdin
for r in "${APPDB_APP_ROLES[@]}"; do
    if [[ ! -s $APPDB_PASS/$r.pass ]]; then
        ( umask 077; head -c 33 /dev/urandom | base64 | tr -d '/+=\n' > "$APPDB_PASS/$r.pass.new" )
        chown root:root "$APPDB_PASS/$r.pass.new"; chmod 600 "$APPDB_PASS/$r.pass.new"
        mv "$APPDB_PASS/$r.pass.new" "$APPDB_PASS/$r.pass"
        say ok "made the password of $r"
    fi
    [[ $(cat "$APPDB_PASS/$r.pass") =~ ^[A-Za-z0-9]+$ ]] || die "$APPDB_PASS/$r.pass isn't letters and digits only"
done
{ for r in "${APPDB_APP_ROLES[@]}"; do printf '\\set %s_pw %s\n' "$r" "$(cat "$APPDB_PASS/$r.pass")"; done
  cat "$S/apps.sql"; } | appdb_super >/dev/null
say ok "the projects' databases: examprep (roles ${APPDB_APP_ROLES[*]})"

# ---------------------------------------------------------------- 5c. the Studio's login (studio.sql, docs/phase8-plan.md 8-4)
# its password: made once, root-only; a copy for lfdln-pammydb (LoadCredential, root 600)
if [[ ! -s $APPDB_PASS/$APPDB_STUDIO.pass ]]; then
    ( umask 077; head -c 33 /dev/urandom | base64 | tr -d '/+=\n' > "$APPDB_PASS/$APPDB_STUDIO.pass.new" )
    chown root:root "$APPDB_PASS/$APPDB_STUDIO.pass.new"; chmod 600 "$APPDB_PASS/$APPDB_STUDIO.pass.new"
    mv "$APPDB_PASS/$APPDB_STUDIO.pass.new" "$APPDB_PASS/$APPDB_STUDIO.pass"
    say ok "made the password of $APPDB_STUDIO"
fi
[[ $(cat "$APPDB_PASS/$APPDB_STUDIO.pass") =~ ^[A-Za-z0-9]+$ ]] || die "$APPDB_PASS/$APPDB_STUDIO.pass isn't letters and digits only"
{ printf '\\set pammy_studio_pw %s\n' "$(cat "$APPDB_PASS/$APPDB_STUDIO.pass")"; cat "$S/studio.sql"; } | appdb_super >/dev/null
for e in "${APPDB_STUDIO_READS[@]}"; do
    db=${e%%:*} schema=${e#*:}
    [[ $db =~ ^[a-z][a-z0-9_]{0,62}$ && $schema =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "$e isn't a database:schema"
    if [[ $(echo "SELECT count(*) FROM pg_database WHERE datname = '$db'" | appdb_super) == 1 ]]; then
        sed -e "s/__DB__/$db/g" -e "s/__SCHEMA__/$schema/g" "$S/studio-reads.sql.in" | appdb_super >/dev/null
    else
        say note "$db isn't here (yet): the Studio reads it once it is (run this again)"
    fi
done
install -d -o root -g root -m 700 "$(dirname "$APPDB_STUDIO_CRED")"
install -m 600 -o root -g root "$APPDB_PASS/$APPDB_STUDIO.pass" "$APPDB_STUDIO_CRED"
say ok "the Studio's login $APPDB_STUDIO: its own databases, and ${APPDB_STUDIO_READS[*]} read-only; password for lfdln-pammydb in $APPDB_STUDIO_CRED"

# ---------------------------------------------------------------- 6. password files
for r in "${APPDB_ROLES[@]}"; do
    ( umask 077; appdb_secret_of "lfdln-appdb-$r" > "$APPDB_PASS/$r.pass.new" )
    [[ -s $APPDB_PASS/$r.pass.new ]] || die "couldn't read the secret lfdln-appdb-$r"
    chown root:root "$APPDB_PASS/$r.pass.new"; chmod 600 "$APPDB_PASS/$r.pass.new"
    mv "$APPDB_PASS/$r.pass.new" "$APPDB_PASS/$r.pass"
done
say ok "passwords in $APPDB_PASS/<role>.pass (root 600)"

# ---------------------------------------------------------------- 7. timers
appdb_ctl daemon-reload
appdb_ctl enable --now podman-auto-update.timer lfdln-appdb-backup.timer >/dev/null
say ok "nightly backup (05:00 UTC, kept as Settings > Backups says) + container auto-update timers on"
