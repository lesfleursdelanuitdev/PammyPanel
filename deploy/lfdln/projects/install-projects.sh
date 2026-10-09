#!/usr/bin/env bash
# lfdln's projects (docs/phase8b-plan.md step 8b-1): the user that builds and runs them
# (svc-lfdln-apps, exam prep's too), their folders, git's settings for pushes (8b-3), and the
# Node build image. The helper's
# units are installed by install-lfdln.sh with the panel's release.
#
#   sudo ~/pamela-setup/panel/deploy/lfdln/projects/install-projects.sh    (install-lfdln.sh runs it)
#
# The image is rebuilt only when its files change (a label holds their checksum) or it is
# missing; --rebuild-image builds it again anyway (a newer Node LTS or pnpm). Safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
S="$(dirname "$(readlink -f "$0")")"
say() { printf '  %-4s %s\n' "$1" "$2"; }
die() { say FAIL "$1" >&2; exit 1; }

SVC=svc-lfdln-apps
SVC_HOME=/var/lib/$SVC
PROJECTS=/srv/lfdln-projects
STATE=/var/lib/lfdln-projects
IMAGE=localhost/lfdln-build-node

command -v podman >/dev/null || die "needs podman"
for f in build-node.Containerfile lfdln-build-versions; do [[ -f $S/$f ]] || die "missing $S/$f"; done

# ---------------------------------------------------------------- 1. the user (as exam prep's install.sh makes it)
if ! id "$SVC" >/dev/null 2>&1; then
    useradd --system --home-dir "$SVC_HOME" --create-home --shell /usr/sbin/nologin "$SVC"
    say ok "created system user $SVC"
fi
chmod 700 "$SVC_HOME"
if ! grep -q "^$SVC:" /etc/subuid; then
    start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print m}' /etc/subuid /etc/subgid)
    usermod --add-subuids "$start-$((start+65535))" --add-subgids "$start-$((start+65535))" "$SVC"
    say ok "subuid/subgid $start-$((start+65535))"
fi
loginctl enable-linger "$SVC"
uid=$(id -u "$SVC")
for i in $(seq 30); do [[ -S /run/user/$uid/bus ]] && break; sleep 1; done
[[ -S /run/user/$uid/bus ]] || die "$SVC's systemd user manager didn't start"
as_apps() { (cd / && runuser -u "$SVC" -- env XDG_RUNTIME_DIR="/run/user/$uid" HOME="$SVC_HOME" "$@"); }
say ok "$SVC (uid $uid, lingering)"

# ---------------------------------------------------------------- 2. folders
install -d -o root -g root -m 755 "$PROJECTS"      # exam prep's folder is in it too
install -d -o root -g root -m 700 "$STATE"
say ok "$PROJECTS (projects' code and releases) and $STATE (the helper's record and jobs)"

# ---------------------------------------------------------------- 2b. git (docs/phase8b-plan.md 8b-3)
# lfdln-git: who may drop a push into the helper's spool (svc-lfdln-apps, and the projects'
# Unix people, which the helper keeps); git's list of the projects' repositories, which the
# helper writes and /etc/gitconfig includes (D3-4: git refuses a repository owned by another
# user unless it is listed)
GIT_GROUP=lfdln-git
SAFE=/etc/lfdln-projects/gitconfig
getent group "$GIT_GROUP" >/dev/null || { groupadd --system "$GIT_GROUP"; say ok "created group $GIT_GROUP"; }
id -nG "$SVC" | tr ' ' '\n' | grep -qx "$GIT_GROUP" || gpasswd -a "$SVC" "$GIT_GROUP" >/dev/null
install -d -o root -g root -m 755 /etc/lfdln-projects
[[ -f $SAFE ]] || printf '# lfdln projects (docs/phase8b-plan.md D3-4): written by the projects helper; /etc/gitconfig includes it.\n' > "$SAFE"
chmod 644 "$SAFE"; chown root:root "$SAFE"
git config --system --get-all include.path 2>/dev/null | grep -qxF "$SAFE" || git config --system --add include.path "$SAFE"
say ok "git: $GIT_GROUP, $SAFE (included by /etc/gitconfig)"

# ---------------------------------------------------------------- 2c. servers (docs/phase8b-plan.md 8b-4a, D4-4)
# One nginx upstream per server branch, written by the projects helper; nginx includes them
# all at http level. An empty folder includes nothing.
NGX_UP=/etc/nginx/lfdln-projects
install -d -o root -g root -m 755 "$NGX_UP"
want="include $NGX_UP/*.conf;"
if [[ $(cat /etc/nginx/conf.d/lfdln-projects.conf 2>/dev/null) != *"$want"* ]]; then
    printf '# lfdln projects (docs/phase8b-plan.md D4-4): each server branch'"'"'s upstream, written by the projects helper.\n%s\n' "$want" > /etc/nginx/conf.d/lfdln-projects.conf
    chmod 644 /etc/nginx/conf.d/lfdln-projects.conf
    nginx -t -q 2>/dev/null || { rm -f /etc/nginx/conf.d/lfdln-projects.conf; die "nginx refused the projects' upstreams include"; }
    systemctl reload nginx
fi
say ok "nginx includes $NGX_UP/*.conf (servers' upstreams)"

# ---------------------------------------------------------------- 2d. git over HTTPS (docs/phase8b-plan.md 8b-7, D7-5)
# fcgiwrap runs git-http-backend as svc-lfdln-apps behind lfdln-git-http.socket (installed by
# install-lfdln.sh with the release). The package's own socket and service (www-data, a door
# nothing uses) are masked BEFORE it arrives, so they never start, not even once.
systemctl mask -q fcgiwrap.socket fcgiwrap.service
if ! dpkg-query -W -f='${Status}' fcgiwrap 2>/dev/null | grep -q 'install ok installed'; then
    apt_log=$(mktemp)
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends fcgiwrap >"$apt_log" 2>&1 \
        || { tail -20 "$apt_log" >&2; rm -f "$apt_log"; die "couldn't install fcgiwrap"; }
    rm -f "$apt_log"
    say ok "installed fcgiwrap (for git over HTTPS)"
fi
[[ -x /usr/sbin/fcgiwrap && -x /usr/lib/git-core/git-http-backend ]] || die "fcgiwrap or git-http-backend missing"
for u in fcgiwrap.socket fcgiwrap.service; do
    [[ $(systemctl is-enabled "$u" 2>/dev/null) == masked ]] || die "$u isn't masked"
done
say ok "git over HTTPS: fcgiwrap there, its own www-data socket and service masked"

# ---------------------------------------------------------------- 3. the build image
sum=$(cat "$S/build-node.Containerfile" "$S/lfdln-build-versions" | sha256sum | cut -c1-16)
have=$(as_apps podman image inspect --format '{{index .Labels "lfdln.sum"}}' "$IMAGE:current" 2>/dev/null || true)
if [[ $have != "$sum" || ${1:-} == --rebuild-image ]]; then
    ctx=$(mktemp -d)
    trap 'rm -rf "$ctx"' EXIT
    install -m 644 "$S/build-node.Containerfile" "$ctx/Containerfile"
    install -m 755 "$S/lfdln-build-versions" "$ctx/lfdln-build-versions"
    chown -R "$SVC:$SVC" "$ctx"
    tag=$(date -u +%Y%m%d%H%M)
    as_apps podman build --pull=newer -q --label "lfdln.sum=$sum" -t "$IMAGE:$tag" -f "$ctx/Containerfile" "$ctx" >/dev/null \
        || die "the build image didn't build (as $SVC: podman build)"
    as_apps podman tag "$IMAGE:$tag" "$IMAGE:current"
    # older builds of it: only the two newest kept (by name; never a prune)
    as_apps podman images --format '{{.Tag}}' "$IMAGE" | grep -E '^[0-9]{12}$' | sort -r | tail -n +3 \
        | while read -r old; do as_apps podman rmi "$IMAGE:$old" >/dev/null 2>&1 || true; done
    say ok "build image $IMAGE:$tag (current)"
else
    say ok "build image $IMAGE:current is up to date ($sum)"
fi
# a server's release image is built on the build image's own base, offline (D4-2)
RUN_IMAGE=docker.io/library/node:24-bookworm-slim
as_apps podman image exists "$RUN_IMAGE" || as_apps podman pull -q "$RUN_IMAGE" >/dev/null || die "couldn't pull $RUN_IMAGE as $SVC"
say ok "servers' base image $RUN_IMAGE is in $SVC's podman"
v=$(as_apps podman run --rm --network=none --read-only --memory=512m --pids-limit=128 --cpus=1 "$IMAGE:current" /usr/local/bin/lfdln-build-versions) \
    || die "the build image doesn't run as $SVC"
say ok "it runs: $v"
