#!/usr/bin/env bash
# Taking over the hand-written nginx files (docs/adopt-plan.md step 1): copies of the
# apex's, instastylr's and tutor's files, and Gonsalves's two (docs/domains-hosts-plan.md
# step 7), as they are in /etc/nginx (test/fixtures/
# handwritten, their ports, certificate and folders moved into a throwaway place) on
# one nginx, and what the renderer makes of the takeover rows (packages/hosts/src/
# takeover.ts) on another; the same requests to both, every answer compared.
#   test/run-adopt-nginx-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
OH=18190 OS=18553 NH=18191 NS=18554 B=18192
cleanup() {
    for n in old new live; do [[ -s $T/$n.pid ]] && nginx -p "$T" -c "$T/$n.conf" -e "$T/$n-error.log" -s stop 2>/dev/null; done
    rm -rf "$T"
}
trap cleanup EXIT

# --- the two folders, as they are on the server (names only; the bytes are made up)
S=$T/sites
mkdir -p "$S/instastylr/assets" "$S/home/stefanie/fonts"
printf '<!doctype html><div id="root"></div>\n' > "$S/instastylr/index.html"
echo 'console.log("app")' > "$S/instastylr/assets/index-DN8DMlTJ.js"
echo 'body{}'             > "$S/instastylr/assets/index-CC8mPaWf.css"
echo 'SECRET=1'           > "$S/instastylr/.env"
for f in index avant-apres code-de-correction exemples; do echo "<h1>$f</h1>" > "$S/home/stefanie/$f.html"; done
head -c 3000 /dev/urandom > "$S/home/stefanie/fonts/Bellota-Bold.otf"
head -c 3000 /dev/urandom > "$S/home/stefanie/fonts/Bellota-Regular.otf"
# Gonsalves's media, as /mnt/storage/uploads has it (user-media is never served)
U=$T/uploads
mkdir -p "$U/gedcom-admin/tree-1/media" "$U/site-media/images" "$U/user-media/7"
head -c 2000 /dev/urandom > "$U/gedcom-admin/tree-1/media/portrait.jpg"
head -c 2000 /dev/urandom > "$U/gedcom-admin/tree-1/media/wedding.jpg"
head -c 2000 /dev/urandom > "$U/site-media/images/banner.png"
echo 'secret' > "$U/site-media/images/.hidden"
echo 'private' > "$U/user-media/7/letter.pdf"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -subj "/CN=lesfleursdelanuit.com" -addext "subjectAltName=DNS:*.lesfleursdelanuit.com,DNS:lesfleursdelanuit.com,DNS:gonsalvesfamily.com,DNS:www.gonsalvesfamily.com,DNS:admin.gonsalvesfamily.com" \
    -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null

# --- the hand-written files, moved into the harness and nothing else changed
mkdir -p "$T/old"
for f in "$P"/test/fixtures/handwritten/*.conf; do
    sed -E -e "s#^(\s*)listen \[::\]:[0-9]+.*#\1\# (v6 listen left out)#" \
           -e "s#^(\s*)listen 443 ssl;#\1listen 127.0.0.1:$OS ssl;#" \
           -e "s#^(\s*)listen 80;#\1listen 127.0.0.1:$OH;#" \
           -e "s#ssl_certificate /etc/letsencrypt/live/[^ ;]+#ssl_certificate $T/cert.pem#" \
           -e "s#ssl_certificate_key /etc/letsencrypt/live/[^ ;]+#ssl_certificate_key $T/key.pem#" \
           -e "s#root /var/www/instastylr;#root $S/instastylr;#" \
           -e "s#root /var/www/lesfleursdelanuit;#root $S/home;#" \
           -e "s#proxy_pass http://127.0.0.1:(3041|3039|3040);#proxy_pass http://127.0.0.1:$B;#" \
           -e "s#alias /mnt/storage/uploads/#alias $U/#" \
           -e "s#root /var/www/html;#root $T/acme;#" \
           "$f" > "$T/old/$(basename "$f")"
done
# (comments aside: gonsalves-public's say where its media is)
OUTSIDE='^[^#]*(/var/www|/etc/letsencrypt/live|:3041|:3039|:3040|/mnt/storage)'
grep -qE "$OUTSIDE" "$T"/old/*.conf && { echo "  FAIL  a hand-written file still points outside the harness"; grep -nE "$OUTSIDE" "$T"/old/*.conf; exit 1; }

# --- the panel's files
node --disable-warning=ExperimentalWarning "$P/test/adopt-compare.ts" render "$T/new" "$S" "$NH" "$NS" "$T/cert.pem" "$T/key.pem" "$B" "$U" \
    || { echo "  FAIL  the renderer refused the takeovers"; exit 1; }

for n in old new; do
    inc="$T/old/*.conf"; [[ $n == new ]] && inc="$T/new/site.conf"
    http=$OH https=$OS; [[ $n == new ]] && http=$NH https=$NS
    cat > "$T/$n.conf" <<CONF
worker_processes 1; pid $T/$n.pid; error_log $T/$n-error.log;
events {}
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    access_log off;
    client_body_temp_path $T/$n-body; proxy_temp_path $T/$n-proxy; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    limit_req_zone \$binary_remote_addr zone=login:10m rate=5r/m;
    server { listen 127.0.0.1:$http default_server; return 421; }
    server { listen 127.0.0.1:$https ssl default_server; ssl_reject_handshake on; }
    include $inc;
}
CONF
    if ! nginx -t -q -p "$T" -c "$T/$n.conf" -e "$T/$n-error.log" 2>"$T/t.log"; then echo "  FAIL  nginx -t ($n): $(cat "$T/t.log")"; exit 1; fi
    nginx -p "$T" -c "$T/$n.conf" -e "$T/$n-error.log"
done
echo "  ok    nginx takes both: the hand-written files, and the panel's"

node --disable-warning=ExperimentalWarning "$P/test/adopt-compare.ts" compare "$S" "$OH" "$OS" "$NH" "$NS" "$B" "$U" || failed=1

# --- the takeover itself (docs/adopt-plan.md step 3): a third nginx laid out like the
# server -- sites-enabled holding links to the hand-written files in sites-available, and
# the routing helper's site.conf linked in beside them -- taken over host by host
echo "--- the takeover on a nginx laid out like the server's"
LH=18193 LS=18555 LB=18194
mkdir -p "$T/sa" "$T/se" "$T/lfdln-hosts"
for f in "$P"/test/fixtures/handwritten/*.conf; do
    n=$(basename "$f" .conf)
    sed -e "s#127.0.0.1:$OS ssl#127.0.0.1:$LS ssl#; s#127.0.0.1:$OH;#127.0.0.1:$LH;#; s#127.0.0.1:$B;#127.0.0.1:$LB;#" "$T/old/$n.conf" > "$T/sa/$n"
    ln -s "$T/sa/$n" "$T/se/$n"
done
: > "$T/lfdln-hosts/site.conf"
ln -s "$T/lfdln-hosts/site.conf" "$T/se/lfdln-hosts"
cat > "$T/live.conf" <<CONF
worker_processes 1; pid $T/live.pid; error_log $T/live-error.log;
events {}
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    client_body_temp_path $T/live-body; proxy_temp_path $T/live-proxy; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    limit_req_zone \$binary_remote_addr zone=login:10m rate=5r/m;
    server { listen 127.0.0.1:$LH default_server; return 421; }
    server { listen 127.0.0.1:$LS ssl default_server; ssl_reject_handshake on; }
    include $T/se/*;
}
CONF
nginx -t -q -p "$T" -c "$T/live.conf" -e "$T/live-error.log" || { echo "  FAIL  nginx -t (live)"; exit 1; }
nginx -p "$T" -c "$T/live.conf" -e "$T/live-error.log"
node --disable-warning=ExperimentalWarning "$P/test/adopt-takeover.ts" "$T" "$S" "$LH" "$LS" "$T/cert.pem" "$T/key.pem" "$LB" "$T/live.conf" "$U" || failed=1
[[ ${failed:-0} -eq 0 ]]
