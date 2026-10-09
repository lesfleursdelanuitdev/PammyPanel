#!/usr/bin/env bash
# The REAL panel site file (rendered from the profile, tools/render-nginx.ts) on a throwaway unprivileged nginx, in front
# of the real panel server, as momolig with no sudo. 127.0.0.1 plays Cloudflare
# (added to the allow list); 127.0.0.2 plays someone hitting the origin directly.
#   test/run-nginx-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
HTTP=18080 HTTPS=18443 APP=13144
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    [[ -n ${app_pid:-} ]] && kill "$app_pid" 2>/dev/null
    # the Postgres test container goes with it (removed by name)
    [[ -n ${pg_pid:-} ]] && kill "$pg_pid" 2>/dev/null && wait "$pg_pid" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT

# --- the app, and its Postgres
node --disable-warning=ExperimentalWarning "$P/test/pg-serve.ts" "$T" > "$T/pg.log" 2>&1 &
pg_pid=$!
for _ in $(seq 150); do [[ -s $T/pg.env ]] && break; sleep 0.1; done
[[ -s $T/pg.env ]] || { echo "the test Postgres didn't start:"; cat "$T/pg.log"; exit 1; }
source "$T/pg.env"
# what the panel's tables say, straight from Postgres
q() { PGOPTIONS="-c search_path=panel" PGPASSWORD=$(cat "$T/panel.pass") psql -X -qtA -h 127.0.0.1 -p "$PGPORT" -U pammy_panel -d "$PGDATABASE" -c "$1" 2>&1; }
# nginx's edge secret (docs/s1-plan.md S1c): the panel believes X-Real-IP only with it
( umask 077; openssl rand -hex 32 > "$T/edge.secret" )
PANEL_EDGE_SECRET_FILE=$T/edge.secret \
PANEL_ORIGIN=https://panel.pammy.org PANEL_DATA_DIR=$T PANEL_PORT=$APP \
    PANEL_PG_PORT=$PGPORT PANEL_PG_DATABASE=$PGDATABASE PANEL_PG_PASSWORD_FILE=$T/panel.pass \
    node --disable-warning=ExperimentalWarning "$P/src/server.ts" > "$T/app.log" 2>&1 &
app_pid=$!

# --- nginx: real site file, paths and ports swapped, same default-443 behaviour as prod
# the files the installer writes, rendered from pammy.org's profile (docs/adapters-plan.md A4)
node --disable-warning=ExperimentalWarning "$P/tools/render-nginx.ts" "$T/rendered" --extra-range 127.0.0.1/32 >/dev/null
mkdir -p "$T/inc" && cp "$T/rendered/panel/cloudflare-realip.conf" "$T/rendered/panel/cloudflare-ips.geo" "$T/inc/"
edge_conf() { ( umask 077; printf 'proxy_set_header X-Lfdln-Edge "%s";\n' "$(cat "$T/edge.secret")" > "$1/edge.conf" ); }
edge_conf "$T/inc"
# the tutorial examples' PHP pages (docs/tutorial-examples-plan.md): PHP isn't running here
sed -e "s#127.0.0.1:3044#127.0.0.1:$APP#" -e "s#/etc/nginx/pammy-panel#$T/inc#g" "$T/rendered/panel/tutorial-examples.conf" > "$T/inc/tutorial-examples.conf"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -subj /CN=panel.pammy.org -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null
sed -e "s#/etc/nginx/pammy-panel#$T/inc#g" \
    -e "s#/etc/ssl/cloudflare/pammy.org-wildcard.pem#$T/cert.pem#; s#/etc/ssl/cloudflare/pammy.org-wildcard.key#$T/key.pem#" \
    -e "s#/var/log/nginx/#$T/#g" \
    -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:$HTTP;#; s#^\(\s*\)listen 443 ssl;#\1listen 127.0.0.1:$HTTPS ssl;#" \
    -e '/listen \[::\]/d' \
    -e "s#127.0.0.1:3044#127.0.0.1:$APP#" \
    "$T/rendered/site/panel.conf" > "$T/site.conf"
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    server { listen 127.0.0.1:$HTTP default_server; return 421; }
    server { listen 127.0.0.1:$HTTPS ssl default_server; ssl_reject_handshake on; }
    include $T/site.conf;
}
EOF
nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log" || { bad "nginx -t rejected the site file"; exit 1; }
# A site shaped like lfdln's (docs/adapters-plan.md A8): nothing in front, a Let's Encrypt
# certificate, the panel open to anyone with a passkey. Only nginx -t here: it is not served.
node --disable-warning=ExperimentalWarning "$P/tools/render-nginx.ts" "$T/lfdln" --profile "$P/test/fixtures/lfdln-profile.ts" >/dev/null
sed -i -e "s#/etc/nginx/lfdln-panel#$T/lfdln/panel#g" -e "s#/var/log/nginx/#$T/#g" \
    -e "s#/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/fullchain.pem#$T/cert.pem#; s#/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/privkey.pem#$T/key.pem#" \
    -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:$HTTP;#; s#^\(\s*\)listen 443 ssl;#\1listen 127.0.0.1:$HTTPS ssl;#" -e '/listen \[::\]/d' \
    "$T/lfdln/site/panel.conf"
mkdir -p "$T/lfdln/panel" && edge_conf "$T/lfdln/panel"
for f in "$T"/lfdln/panel/*.conf; do sed -i -e "s#/etc/nginx/lfdln-panel#$T/lfdln/panel#g" "$f"; done
sed "s#include $T/site.conf;#include $T/lfdln/site/panel.conf;#" "$T/nginx.conf" > "$T/nginx-lfdln.conf"
if nginx -t -q -p "$T" -c "$T/nginx-lfdln.conf" -e "$T/error-lfdln.log" 2>"$T/lfdln-t"; then
    ok "a direct site (shaped like lfdln's) renders a panel site nginx accepts"
else
    bad "nginx -t rejected the lfdln-shaped site: $(cat "$T/lfdln-t")"
fi
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$APP/healthz" && break; sleep 0.1; done

# curl as a given source address; prints "<exit> <status> <redirect>"
probe() {  # probe <src> <scheme> <port> <path> [curl args...]
    local src=$1 scheme=$2 port=$3 path=$4; shift 4
    local out rc
    out=$(curl -sk --interface "$src" --max-time 5 -o "$T/body" -D "$T/headers" -w '%{http_code} %{redirect_url}' \
          --resolve "panel.pammy.org:$port:127.0.0.1" "$@" "$scheme://panel.pammy.org:$port$path")
    rc=$?
    echo "$rc $out"
}

echo "--- only Cloudflare may connect"
r=$(probe 127.0.0.2 https $HTTPS /login);  [[ $r == 52* ]] && ok "direct to origin over https: connection closed, nothing served" || bad "direct https got: $r"
r=$(probe 127.0.0.2 http $HTTP /login);    [[ $r == 52* ]] && ok "direct to origin over http: connection closed" || bad "direct http got: $r"
r=$(probe 127.0.0.2 https $HTTPS /login -H 'CF-Connecting-IP: 173.245.48.1'); [[ $r == 52* ]] && ok "a forged CF-Connecting-IP doesn't get you in" || bad "forged CF header got: $r"
r=$(probe 127.0.0.1 http $HTTP /login);    [[ $r == "0 301 https://panel.pammy.org/login" ]] && ok "via Cloudflare over http: redirect to https" || bad "http via CF got: $r"

r=$(probe 127.0.0.1 https $HTTPS /login -H 'X-Forwarded-Proto: http'); [[ $r == "0 301 https://panel.pammy.org/login" ]] && ok "visitor on http (Cloudflare reaching us over https): redirect to https" || bad "X-Forwarded-Proto http got: $r"

echo "--- the panel through nginx"
r=$(probe 127.0.0.1 https $HTTPS /login)
[[ $r == "0 200 " ]] && ok "login page served" || bad "login page got: $r"
grep -qi "^content-security-policy: default-src 'none'" "$T/headers" && ok "security headers pass through" || bad "CSP header missing"
r=$(probe 127.0.0.1 https $HTTPS /)
[[ $r == "0 302 https://panel.pammy.org:$HTTPS/login" || $r == "0 302 "*"/login" ]] && ok "signed-out home page redirects to /login" || bad "home got: $r"
r=$(probe 127.0.0.1 https $HTTPS /api/login/options -X POST -H 'Content-Type: application/json' -d '{}')
[[ $r == "0 403 " ]] && ok "POST without the panel's Origin refused" || bad "no-origin POST got: $r"
r=$(probe 127.0.0.1 https $HTTPS /api/login/options -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' -d '{}')
[[ $r == "0 200 " ]] && grep -q '"rpId":"panel.pammy.org"' "$T/body" && ok "sign-in options for rpId panel.pammy.org" || bad "options got: $r $(head -c 200 "$T/body")"
head -c 70000 /dev/zero | tr '\0' 'a' > "$T/big"
r=$(probe 127.0.0.1 https $HTTPS /api/login/verify -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/big")
[[ $r == "0 413 " ]] && ok "oversized request body refused by nginx" || bad "big body got: $r"

head -c $((2 * 1024 * 1024)) /dev/zero > "$T/photo.jpg"
r=$(probe 127.0.0.1 https $HTTPS '/api/media/upload?dir=media/images' -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://panel.pammy.org' -H 'X-Pammy-Name: photo.jpg' --data-binary @"$T/photo.jpg")
[[ $r == "0 401 " ]] && ok "a 2 MB media upload gets through nginx to the panel (which wants a session)" || bad "2 MB upload got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/files/upload?dir=recipes' -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://panel.pammy.org' -H 'X-Pammy-Name: page.html' --data-binary @"$T/photo.jpg")
[[ $r == "0 401 " ]] && ok "a 2 MB File Explorer upload gets through nginx too" || bad "2 MB files upload got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/media/upload?dir=media/video' -X POST -H 'Content-Type: application/octet-stream' -H 'Origin: https://panel.pammy.org' -H 'X-Pammy-Name: big.mp4' -H "Content-Length: $((101 * 1024 * 1024))" --data-binary @"$T/photo.jpg" --max-time 3)
[[ $r == "0 413 "* ]] && ok "an upload over 100 MB is refused by nginx straight away" || bad "101 MB upload got: $r"
{ printf '{"path":"x.html","text":"'; head -c $((2 * 1024 * 1024)) /dev/zero | tr '\0' 'a'; printf '"}'; } > "$T/text.json"
for route in save draft; do
    r=$(probe 127.0.0.1 https $HTTPS "/api/files/$route" -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/text.json")
    [[ $r == "0 401 " ]] && ok "a 2 MB editor $route gets through nginx to the panel (which wants a session)" || bad "2 MB $route got: $r"
done
{ printf '{"values":{"body":"'; head -c $((1024 * 1024)) /dev/zero | tr '\0' 'a'; printf '"}}'; } > "$T/record.json"
for route in new save; do
    r=$(probe 127.0.0.1 https $HTTPS "/api/app/mariadb/example_blog/posts/$route" -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/record.json")
    [[ $r == "0 401 " ]] && ok "a 1 MB record $route (rich text) gets through nginx to the panel" || bad "1 MB record $route got: $r"
done
head -c $((3 * 1024 * 1024)) /dev/zero > "$T/record-huge"
r=$(probe 127.0.0.1 https $HTTPS '/api/app/mariadb/example_blog/posts/save' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/record-huge")
[[ $r == "0 413 " ]] && ok "a record save over 2 MB is refused by nginx" || bad "3 MB record save got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/app/mariadb/example_blog/posts/delete' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/record.json")
[[ $r == "0 413 " ]] && ok "the rest of an app's requests keep the small body limit" || bad "1 MB record delete got: $r"
head -c $((9 * 1024 * 1024)) /dev/zero > "$T/huge"
r=$(probe 127.0.0.1 https $HTTPS '/api/files/save' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/huge")
[[ $r == "0 413 " ]] && ok "an editor save over 8 MB is refused by nginx" || bad "9 MB save got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/media/mkdir' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/photo.jpg")
[[ $r == "0 413 " ]] && ok "other requests keep the small body limit" || bad "big JSON post got: $r"

r=$(probe 127.0.0.1 https $HTTPS '/api/software')
[[ $r == "0 401 " ]] && ok "the list of installed software (/api/software, no slash) reaches the panel, not an nginx redirect" || bad "/api/software got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/software/blog')
[[ $r == "0 401 " ]] && ok "one piece of software reaches the panel" || bad "/api/software/blog got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/software/blog/admin-password' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' -d '{"user":"pamela"}')
[[ $r == "0 401 " ]] && ok "installed software's own address reaches the panel (which wants a session)" || bad "software POST got: $r"
r=$(probe 127.0.0.1 https $HTTPS '/api/software/blog/restore' -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' --data-binary @"$T/big")
[[ $r == "0 413 " ]] && ok "...and keeps the small body limit" || bad "big software POST got: $r"
grep -A3 'location ~ ^/api/software(/|$)' "$T/rendered/site/panel.conf" | grep -q 'proxy_buffering off' \
    && ok "...streams (a backup download isn't buffered to disk)" || bad "software location buffers"

echo "--- visitor IP reaches the app from CF-Connecting-IP only"
probe 127.0.0.1 https $HTTPS /api/login/options -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' -d '{}' >/dev/null
ceremony=$(grep -o '"ceremony":"[^"]*"' "$T/body" | cut -d'"' -f4)
probe 127.0.0.1 https $HTTPS /api/login/verify -X POST -H 'Content-Type: application/json' -H 'Origin: https://panel.pammy.org' \
    -H 'CF-Connecting-IP: 203.0.113.77' -H 'X-Forwarded-For: 6.6.6.6' -H 'X-Real-IP: 6.6.6.7' \
    -d "{\"ceremony\":\"$ceremony\",\"response\":{\"id\":\"nope\"}}" >/dev/null
ip=$(q "SELECT coalesce((SELECT ip FROM activity ORDER BY id DESC LIMIT 1), 'none')")
[[ $ip == 203.0.113.77 ]] && ok "app logged the visitor as 203.0.113.77 (spoofed X-Real-IP/X-Forwarded-For ignored)" || bad "app logged ip: $ip"

echo "--- X-Real-IP only from nginx (docs/s1-plan.md S1c)"
grep -c 'include '"$T"'/inc/edge.conf;' "$T/site.conf" | grep -qx 6 && ok "every location to the panel sends the edge secret (6)" || bad "edge includes in the site file: $(grep -c 'edge.conf' "$T/site.conf")"
# straight to the panel, a made-up X-Real-IP each time: all this machine's, so the limit runs out
last=
for i in $(seq 1 21); do
    last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Origin: https://panel.pammy.org' -H 'Content-Type: application/json' \
        -H "X-Real-IP: 192.0.2.$i" -d '{}' "http://127.0.0.1:$APP/api/login/verify")
    [[ $last == 429 ]] && break
done
[[ $last == 429 ]] && ok "a made-up X-Real-IP straight to the panel isn't believed (429 by the 21st)" || bad "straight to the panel: $last after 21"
# with the secret, it is (the way nginx sends it)
# (on stdin, as verify sends it: never on a command line)
last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - -X POST -H 'Origin: https://panel.pammy.org' -H 'Content-Type: application/json' \
    -H 'X-Real-IP: 192.0.2.250' -d '{}' "http://127.0.0.1:$APP/api/login/verify" <<<"header = \"X-Lfdln-Edge: $(cat "$T/edge.secret")\"")
[[ $last == 400 ]] && ok "...with the edge secret it is (its own limit)" || bad "with the secret: $last"
grep -q 'X-Real-IP believed only from nginx' "$T/app.log" && ok "the panel says it has the secret" || bad "the panel's log doesn't say it has the secret"

echo "--- other hostnames are not the panel"
r=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' --resolve "pammy.org:$HTTP:127.0.0.1" "http://pammy.org:$HTTP/login")
[[ $r == 421 ]] && ok "Host: pammy.org doesn't reach the panel" || bad "pammy.org got: $r"

echo
echo "  nginx test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
