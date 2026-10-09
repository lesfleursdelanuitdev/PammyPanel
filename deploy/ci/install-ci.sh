#!/usr/bin/env bash
# The CI runner (docs/ci-plan.md, T1-b): the svc-ci user, its podman, its units, the
# lfdln-ci command. Safe to re-run; re-run it to put a new runner in /opt/lfdln-ci.
#
#   sudo ~/pamela-setup-ci/panel/deploy/ci/install-ci.sh 2>&1 | tee ~/install-logs/install-ci.log
#
# svc-ci: no login, no sudo, no secrets. It reads the shared repository (read-only ACL)
# and runs panel/build.sh --tier fast|full in a clone of its own, as a systemd user
# unit (linger), so its podman works as the other service users' does. Its whole user
# slice is capped (4 cores, 6 GB, low weights): the live sites come first.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

CI=svc-ci
STATE=/var/lib/lfdln-ci
OPT=/opt/lfdln-ci
HERE="$(dirname "$(readlink -f "$0")")"            # .../panel/deploy/ci
PANEL="$(readlink -f "$HERE/../..")"
# the shared repository the branches live in: the main checkout, whatever worktree this runs from
SRC="$(git -C "$PANEL" rev-parse --path-format=absolute --git-common-dir)"; SRC="${SRC%/.git}"
OWNER=$(stat -c %U "$SRC")
IMAGES=(docker.io/library/postgres:15 docker.io/library/postgres:17 docker.io/library/mariadb:11.4 docker.io/library/php:8.3-fpm)
pass=0; fail=0
say() { printf '  %-5s %s\n' "$1" "$2"; }
ok()  { say ok "$1"; pass=$((pass+1)); }
bad() { say FAIL "$1"; fail=$((fail+1)); }

echo "--- the user"
if ! id "$CI" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE" --create-home --shell /usr/sbin/nologin --comment "lfdln CI runner" "$CI"
    say made "$CI"
fi
chmod 755 "$STATE"                                  # results are read by everyone; podman's own folders stay 700
uid=$(id -u "$CI")
# rootless podman needs a uid / gid range of its own, after the last one given out
if ! grep -q "^$CI:" /etc/subuid; then
    next=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print (m>100000?m:100000)}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$next-$((next+65535))" --add-subgids "$next-$((next+65535))" "$CI"
    say made "subuid/subgid $next-$((next+65535))"
fi
loginctl enable-linger "$CI"
for _ in $(seq 20); do [[ -d /run/user/$uid ]] && break; sleep 0.5; done
as_ci() { (cd "$STATE" && runuser -u "$CI" -- env HOME="$STATE" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin "$@"); }

echo "--- its whole slice capped (CI-Q5)"
mkdir -p "/etc/systemd/system/user-$uid.slice.d"
cat > "/etc/systemd/system/user-$uid.slice.d/50-lfdln-ci.conf" <<EOF
# docs/ci-plan.md CI-Q5: everything svc-ci runs, its test containers too
[Slice]
CPUQuota=400%
MemoryMax=6G
TasksMax=4096
CPUWeight=20
IOWeight=20
EOF
systemctl daemon-reload
say done "user-$uid.slice: 4 cores, 6 GB, weights 20"

echo "--- reading the repository ($SRC), never writing it"
setfacl -m "u:$CI:--x" "$(dirname "$SRC")"          # /home/momolig: pass through, no listing
setfacl -m "u:$CI:r-x" "$SRC"
setfacl -R -m "u:$CI:rX" "$SRC/.git"
find "$SRC/.git" -type d -exec setfacl -d -m "u:$CI:rX" {} +
as_ci git config --global --replace-all safe.directory "$SRC"
as_ci git config --global --add safe.directory "$SRC/.git"
say done "read-only ACL on $SRC/.git, safe.directory"

echo "--- its folders"
install -d -o "$CI" -g "$CI" -m 755 "$STATE/results"
install -d -o "$CI" -g "$CI" -m 770 "$STATE/requests"
setfacl -m "u:$OWNER:rwx" -d -m "u:$OWNER:rwx,u:$CI:rwx" "$STATE/requests"   # `lfdln-ci full` as $OWNER
say done "$STATE/{results,requests}"

echo "--- the runner and the command (a copy: a branch under test can't change them)"
install -d -m 755 "$OPT"
install -m 644 "$PANEL/tools/ci/runner.ts" "$PANEL/tools/ci/cli.ts" "$OPT/"
cat > /usr/local/bin/lfdln-ci <<EOF
#!/bin/sh
# docs/ci-plan.md: what CI says (status, log, check) and asking for a full run (full)
exec /usr/bin/node --disable-warning=ExperimentalWarning $OPT/cli.ts "\$@"
EOF
chmod 755 /usr/local/bin/lfdln-ci
say done "$OPT, /usr/local/bin/lfdln-ci"

echo "--- the images the tests start, in svc-ci's podman"
for img in "${IMAGES[@]}"; do
    as_ci podman image exists "$img" || as_ci podman pull -q "$img" >/dev/null
    say have "$img"
done

echo "--- the units (svc-ci's own systemd)"
install -d -o "$CI" -g "$CI" "$STATE/.config" "$STATE/.config/systemd" "$STATE/.config/systemd/user"
cat > "$STATE/.config/systemd/user/lfdln-ci.service" <<EOF
# docs/ci-plan.md: one look at the branches, at most one run (a oneshot never overlaps itself)
[Unit]
Description=lfdln CI: run the next check (fast tier per new branch head, or a requested full tier)

[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=CI_SOURCE=$SRC
WorkingDirectory=$STATE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $OPT/runner.ts
Nice=10
TimeoutStartSec=60min
EOF
cat > "$STATE/.config/systemd/user/lfdln-ci.timer" <<EOF
[Unit]
Description=lfdln CI: look for new commits every minute

[Timer]
OnActiveSec=1min
OnUnitInactiveSec=1min

[Install]
WantedBy=timers.target
EOF
chown "$CI:$CI" "$STATE/.config/systemd/user/lfdln-ci.service" "$STATE/.config/systemd/user/lfdln-ci.timer"
systemctl --user -M "$CI@" daemon-reload
systemctl --user -M "$CI@" enable --now lfdln-ci.timer >/dev/null 2>&1
say done "lfdln-ci.timer"

echo "--- checking"
as_ci git -C "$SRC" for-each-ref --count=1 refs/heads >/dev/null && ok "$CI reads the branches" || bad "$CI can't read the branches"
as_ci touch "$SRC/.git/.ci-write-check" 2>/dev/null && { rm -f "$SRC/.git/.ci-write-check"; bad "NOT blocked: $CI writes into the repository"; } || ok "blocked: $CI writing into the repository"
for secret in /etc/lfdln-panel/db /etc/lfdln-panel/hooks /etc/pammy-panel/db /etc/lfdln-appdb; do  # the folders above them are world-listable on purpose (panel.env has no secrets)
    [[ -e $secret ]] || continue
    as_ci ls "$secret" >/dev/null 2>&1 && bad "NOT blocked: $CI lists $secret" || ok "blocked: $CI listing $secret"
done
as_ci sudo -n true >/dev/null 2>&1 && bad "NOT blocked: $CI has sudo" || ok "blocked: $CI using sudo"
as_ci podman info >/dev/null 2>&1 && ok "$CI's podman works" || bad "$CI's podman doesn't work (podman info)"
[[ $(loginctl show-user "$CI" -p Linger --value 2>/dev/null) == yes ]] && ok "linger on" || bad "linger off"
systemctl --user -M "$CI@" is-active --quiet lfdln-ci.timer && ok "lfdln-ci.timer active" || bad "lfdln-ci.timer not active"
[[ $(systemctl show "user-$uid.slice" -p MemoryMax --value) == 6442450944 ]] && ok "the slice is capped (6 GB)" || bad "the slice cap isn't in place"
runuser -u "$OWNER" -- /usr/local/bin/lfdln-ci status >/dev/null 2>&1 && ok "$OWNER runs lfdln-ci status" || bad "$OWNER can't run lfdln-ci status"
t="$STATE/requests/.check-$$.tmp"
runuser -u "$OWNER" -- sh -c "echo x > '$t'" 2>/dev/null && { rm -f "$t"; ok "$OWNER may ask for a run"; } || bad "$OWNER can't write a request"

echo
echo "$pass passed, $fail failed"
echo "watch it: lfdln-ci status   (the first fast run starts within a minute)"
(( fail == 0 ))
