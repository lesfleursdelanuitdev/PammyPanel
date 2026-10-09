#!/usr/bin/env bash
# Off-server copies (docs/recovery-plan.md, R1): restic, lfdln-offsite, its settings, its
# units. Safe to re-run; re-run it after putting the keys in place to turn the timers on.
#
#   sudo ~/pamela-setup-r1/panel/deploy/recovery/install-offsite.sh 2>&1 | tee ~/install-logs/install-r1.log
#
# The server's own Postgres is dumped here from the first run (lfdln-hostpg-backup.timer).
# The off-server timers stay OFF, and nothing leaves the server, until at least one target
# (r2, b2) has its address and keys and momolig has said the restic password is kept
# somewhere off this server. Each target is turned on as soon as its keys are there.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

HERE="$(dirname "$(readlink -f "$0")")"
ETC=/etc/lfdln-offsite
CREDS=$ETC/credentials
STATE=/var/lib/lfdln-offsite
UNITS=(lfdln-offsite.service lfdln-offsite.timer lfdln-offsite-check.service lfdln-offsite-check.timer
       lfdln-hostpg-backup.service lfdln-hostpg-backup.timer)
pass=0; fail=0
say() { printf '  %-5s %s\n' "$1" "$2"; }
ok()  { say ok "$1"; pass=$((pass+1)); }
bad() { say FAIL "$1"; fail=$((fail+1)); }

echo "--- restic"
if ! command -v restic >/dev/null; then
    apt-get install -y -q restic >/dev/null
    say made "restic from Ubuntu's packages"
fi
ok "$(restic version | head -1)"

echo "--- lfdln-offsite and its settings"
install -m 755 -o root -g root "$HERE/lfdln-offsite" /usr/local/sbin/lfdln-offsite
install -d -m 700 -o root -g root "$ETC" "$CREDS"
install -m 600 -o root -g root "$HERE/sources.conf" "$HERE/excludes.conf" "$ETC/"
if [[ ! -e $ETC/offsite.conf ]]; then
    cat > "$ETC/offsite.conf" <<'CONF'
# lfdln-offsite's settings (docs/recovery-plan.md, R1). Kept between installs.
# The targets, copied one after the other; each is its own restic repository with its own key
# in /etc/lfdln-offsite/credentials/<target>/ (s3-access-key-id, s3-secret-access-key).
TARGETS="r2 b2"
# Cloudflare R2, the first copy (region "auto" is found from the address). Fill in the
# account id (Cloudflare dashboard, R2 > Overview):
RESTIC_REPOSITORY_r2=
#RESTIC_REPOSITORY_r2=s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/lfdln-offsite/vps
# Backblaze B2, the second copy, through its S3 address (region us-west-004, from the address):
RESTIC_REPOSITORY_b2=s3:https://s3.us-west-004.backblazeb2.com/lfdln-offsite-momo/vps
#KEEP_DAILY=7
#KEEP_WEEKLY=4
#KEEP_MONTHLY=6
#HOST_PG=on
#HOST_PG_SKIP='*_test|*_shadow'
#HOST_PG_KEEP_DAYS=7
CONF
    chmod 600 "$ETC/offsite.conf"
    say made "$ETC/offsite.conf (put each bucket's address in it)"
fi
. "$ETC/offsite.conf"
for t in $TARGETS; do install -d -m 700 -o root -g root "$CREDS/$t"; done
# the restic password (one, shared by the targets): made here once, never printed (it would
# land in the install log)
if [[ ! -s $CREDS/restic-password ]]; then
    (umask 077; head -c 48 /dev/urandom | base64 -w0 > "$CREDS/restic-password")
    say made "$CREDS/restic-password (a new one: keep a copy OFF this server, see below)"
fi
find "$CREDS" -type f -exec chmod 600 {} +
install -d -m 755 -o root -g root "$STATE"
install -d -m 700 -o root -g root "$STATE/dumps" "$STATE/cache"
ok "lfdln-offsite in /usr/local/sbin, settings in $ETC (700), targets: $TARGETS"

echo "--- units"
for u in "${UNITS[@]}"; do install -m 644 "$HERE/systemd/$u" /etc/systemd/system/; done
systemctl daemon-reload
if systemd-analyze verify "${UNITS[@]/#//etc/systemd/system/}" 2>/tmp/offsite-verify.$$; then ok "units are valid"
else bad "units: $(tr '\n' ' ' < /tmp/offsite-verify.$$)"; fi
rm -f /tmp/offsite-verify.$$

echo "--- the server's own Postgres (:5432), dumped here every night with or without a target"
systemctl enable lfdln-hostpg-backup.timer >/dev/null
if systemctl start lfdln-hostpg-backup.service; then
    ok "dumped now: $(jq -r '"\(.databases) databases in \(.folder)"' "$STATE/host-pg.json")"
else bad "the host Postgres dump failed: journalctl -u lfdln-hostpg-backup"; fi
systemctl is-active -q lfdln-hostpg-backup.timer || systemctl start lfdln-hostpg-backup.timer
ok "lfdln-hostpg-backup.timer on (05:30 UTC, keeps 7 days in $STATE/dumps/host-pg)"

echo "--- the targets"
configured=()
# the list once, then grep a string: `targets | grep -q` under pipefail drops every target but
# the last (grep quits at its match, targets dies of SIGPIPE; 2026-10-08 r2 was skipped so)
targets_now=$(lfdln-offsite targets)
sed 's/^/        /' <<<"$targets_now"
for t in $TARGETS; do grep -q "^$t *configured" <<<"$targets_now" && configured+=("$t"); done
is_on() { [[ " ${configured[*]} " == *" $1 "* ]]; }
mark=1; [[ -e $ETC/password-kept-offline ]] || mark=0

if (( ${#configured[@]} == 0 || mark == 0 )); then
    systemctl disable --now lfdln-offsite.timer lfdln-offsite-check.timer >/dev/null 2>&1 || true
    say off "the off-server timers stay off; nothing leaves this server. Still needed:"
    (( ${#configured[@]} )) || printf '          - at least one target with its address and keys (below)\n'
    (( mark )) || printf '          - the restic password copied off this server, then: sudo touch %s\n' "$ETC/password-kept-offline"
    is_on r2 || cat <<TXT
        R2's address in $ETC/offsite.conf (sudoedit; b2's is already there):
          RESTIC_REPOSITORY_r2=s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/lfdln-offsite/vps
        R2's API token (its S3 keys):
          sudo sh -c 'cat > $CREDS/r2/s3-access-key-id'       (paste the Access Key ID, then Ctrl-D)
          sudo sh -c 'cat > $CREDS/r2/s3-secret-access-key'   (paste the Secret Access Key, then Ctrl-D)
TXT
    is_on b2 || cat <<TXT
        B2's application key (keyID and applicationKey):
          sudo sh -c 'cat > $CREDS/b2/s3-access-key-id'       (paste the keyID, then Ctrl-D)
          sudo sh -c 'cat > $CREDS/b2/s3-secret-access-key'   (paste the applicationKey, then Ctrl-D)
TXT
    (( mark )) || cat <<TXT
        The restic password (one for every target; without it the copies can never be read back):
          sudo cat $CREDS/restic-password
          -> into your password manager AND on paper; then the touch above.
TXT
    printf '        Then re-run this installer.\n'
else
    for t in $TARGETS; do is_on "$t" || say note "$t: skipped, not configured (its keys or address: see the list above)"; done
    for t in "${configured[@]}"; do
        if lfdln-offsite restic "$t" cat config >/dev/null 2>&1; then
            ok "$t: the repository is there and the password opens it"
        elif lfdln-offsite restic "$t" init >/dev/null; then
            say made "$t: a new restic repository"; pass=$((pass+1))
        else
            bad "$t: can't open or make the repository (the keys, the address, or a password that doesn't match it)"
        fi
    done
    if (( fail == 0 )); then
        systemctl enable --now lfdln-offsite.timer lfdln-offsite-check.timer >/dev/null
        ok "timers on: copies nightly 06:15 UTC to ${configured[*]}; check + restore test Sundays 08:30 UTC"
        systemctl start --no-block lfdln-offsite.service
        say note "the first copy has started (the big one): journalctl -fu lfdln-offsite; lfdln-offsite status"
    fi
fi

echo "--- what is copied (sizes before the excludes)"
lfdln-offsite inventory | sed 's/^/        /'

echo
echo "  r1: $pass passed, $fail failed"
(( fail == 0 ))
