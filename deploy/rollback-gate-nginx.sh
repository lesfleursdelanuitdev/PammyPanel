#!/usr/bin/env bash
# EMERGENCY ONLY: take the password-protected-folder gate back out of nginx.
#   sudo ~/pamela-setup/panel/deploy/rollback-gate-nginx.sh
#
# Use it if her site is down because of the gate and you can't get the gate
# running (normally: sudo systemctl restart pammy-gate). It puts back the pamela
# vhost and WordPress's main.conf exactly as they were before phase 3.
#
# While rolled back, EVERY PROTECTED FOLDER IS PUBLIC. To protect them again,
# fix the gate and re-run install-panel.sh.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
D="$(dirname "$(readlink -f "$0")")"
WPDIR="$(readlink -f "$D/../../wordpress")"
VHOST=/etc/nginx/sites-available/pamela
WPNGX=/etc/nginx/pammy-wordpress
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

placement=$(cat "$WPNGX/placement" 2>/dev/null || echo off)
cp -r "$WPDIR" "$tmp/wp"
cp "$WPDIR/nginx/templates-pre-gate"/* "$tmp/wp/nginx/templates/"
bash -c 'source "$1/lib.sh"; read -r mode name <<<"$2"; render_placement "$mode" "${name:-}" "$3" ""' _ "$tmp/wp" "$placement" "$tmp/old"

echo "This takes the gate out of nginx. Every protected folder becomes PUBLIC"
echo "until you fix the gate and re-run install-panel.sh."
read -r -p "Type UNPROTECT to continue: " answer
[[ $answer == UNPROTECT ]] || { echo "nothing changed"; exit 1; }

cp -a "$VHOST" "$tmp/vhost.bak"
cp -a "$WPNGX/main.conf" "$tmp/main.bak"
install -m 644 -o root -g root "$WPDIR/pamela-live-wp.nginx.pre-gate" "$VHOST"
install -m 644 -o root -g root "$tmp/old/main.conf" "$WPNGX/main.conf"
if ! nginx -t; then
    cp -a "$tmp/vhost.bak" "$VHOST"
    cp -a "$tmp/main.bak" "$WPNGX/main.conf"
    echo "nginx rejected the pre-gate config; put back as it was" >&2
    exit 1
fi
systemctl reload nginx
echo "done: the gate is out of nginx. Protected folders are public until install-panel.sh is re-run."
echo "note: install-wordpress.sh / place-wordpress.sh render the GATED templates; re-run install-panel.sh before using them."
