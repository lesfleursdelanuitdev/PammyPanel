#!/usr/bin/env bash
# Password-protected folders, end to end, as momolig with no sudo: the REAL new
# pamela vhost (wordpress/pamela-live-wp.nginx) + REAL rendered placement
# includes + REAL gate snippets, on a throwaway unprivileged nginx, in front of
# the REAL gate server -- then every bypass we could think of.
#   test/run-gate-nginx-test.sh
# With VHOST=hosts (docs/phase8-plan.md 8-7a), the same checks against pammy.org's hosts as
# the renderer makes them from the rows 8-7b seeds (test/pammy-hosts-render.ts) instead of
# the hand-kept file: every answer has to be the same. WordPress placements are software
# routes there; WordPress as the whole site isn't a route, so those checks are left out.
#   VHOST=hosts test/run-gate-nginx-test.sh
set -uo pipefail
VHOST=${VHOST:-live}
P="$(dirname "$(readlink -f "$0")")/.."
WP="$(readlink -f "$P/../wordpress")"
T=$(mktemp -d)
NPORT=18180 GPORT=13145 APIPORT=18199 SHOPPORT=18198
PHPNAME=pammy-php-test-$$ PHPIMAGE=docker.io/library/php:8.3-fpm
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    [[ -n ${gate_pid:-} ]] && kill "$gate_pid" 2>/dev/null
    podman rm -f -t 1 --ignore "$PHPNAME" >/dev/null 2>&1
    # the Postgres test container goes with it (removed by name)
    [[ -n ${pg_pid:-} ]] && kill "$pg_pid" 2>/dev/null && wait "$pg_pid" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT

# ---------------------------------------------------------------- her website
pub=$T/public
mkdir -p "$pub"/{open,members,recipes/private/login-files,recipes/.git}
echo HOME > "$pub/index.html";            echo MAIN404 > "$pub/404.html"
echo OPEN > "$pub/open/index.html";       echo MEMBERS > "$pub/members/index.html"
echo RECIPES > "$pub/recipes/index.html"; echo RECIPES404 > "$pub/recipes/404.html"
echo GITSECRET > "$pub/recipes/.git/config"
echo PRIVATE-INDEX > "$pub/recipes/private/index.html"
echo SECRET-CONTENT > "$pub/recipes/private/secret.txt"
echo LOGINPAGE > "$pub/recipes/private/login.html"
echo STYLE > "$pub/recipes/private/login-files/style.css"
echo BANNER > "$pub/recipes/private/login-files/banner.jpg"
mkdir -p "$pub/recipes/private/login-files/old"
echo LF-SECRET-CONTENT > "$pub/recipes/private/login-files/old/style.css"
echo LF-SECRET-CONTENT > "$pub/recipes/private/login-files/notes.txt"
echo LF-SECRET-CONTENT > "$pub/recipes/private/login-files/page.html"
echo FORGOTPAGE > "$pub/recipes/private/login-forgot.html"
echo INVITEPAGE > "$pub/recipes/private/login-invite.html"
echo REQUESTPAGE > "$pub/recipes/private/login-request.html"
echo LOGOUTPAGE > "$pub/recipes/private/logout.html"
echo OLD-SECRET-CONTENT > "$pub/recipes/private/logout-old.html"
echo OTHER-SECRET-CONTENT > "$pub/recipes/private/login-other.html"
ln -s "$pub/recipes/private" "$pub/alias"
# a protected folder a few levels down, with things far below it
olivia=family/2026/summer/olivia
deep=$olivia/$(seq -s/ -f 'd%g' 1 30)
mkdir -p "$pub/$deep/login-files" "$pub/$olivia/d1/login-files" "$pub/family/2026/summer/other"
echo OLIVIA-LOGINPAGE > "$pub/$olivia/login.html"
echo DEEP-SECRET-CONTENT > "$pub/$deep/photo.jpg"
echo DEEP-SECRET-CONTENT > "$pub/$deep/index.html"
echo DEEP-SECRET-CONTENT > "$pub/$olivia/d1/login.html"
echo DEEP-SECRET-CONTENT > "$pub/$olivia/d1/logout.html"
echo DEEP-SECRET-CONTENT > "$pub/$olivia/d1/login-files/style.css"
echo DEEP-SECRET-CONTENT > "$pub/$deep/login-files/x.css"
echo OTHER-OPEN > "$pub/family/2026/summer/other/index.html"
# PHP pages (docs/tutorials-plan.md P1-P5). Their source says PHP-SOURCE-SECRET;
# what they print never does, so seeing it means a .php file went out as text.
cat > "$pub/open/hello.php" <<'PHP'
<?php // PHP-SOURCE-SECRET
header('Content-Type: text/plain');
function ask(string $path): string {
    $c = curl_init('http://pammy.org' . $path);
    curl_setopt_array($c, [CURLOPT_UNIX_SOCKET_PATH => getenv('PAMMY_API_SOCKET'), CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5]);
    $body = curl_exec($c);
    return curl_getinfo($c, CURLINFO_RESPONSE_CODE) . ' ' . $body;
}
echo "RAN-PHP\n";
echo 'user=[' . ($_SERVER['PAMMY_USER'] ?? '') . "]\n";
echo 'exec=' . (function_exists('exec') || function_exists('proc_open') || function_exists('fsockopen') ? 'yes' : 'no') . "\n";
echo 'passwd=' . (@file_get_contents('/etc/passwd') === false ? 'no' : 'yes') . "\n";
echo 'outside=' . (@file_get_contents(dirname(__DIR__, 2) . '/gate.pass') === false ? 'no' : 'yes') . "\n";
echo 'mine=' . (@file_get_contents(__DIR__ . '/index.html') === false ? 'no' : 'yes') . "\n";
echo 'api=' . ask('/_pammy/api/data/postgres/x/y') . "\n";
echo 'check=' . ask('/check') . "\n";
$n = curl_init('http://1.1.1.1/');
curl_setopt_array($n, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 3]);
echo 'net=' . (curl_exec($n) === false ? 'no' : 'yes') . "\n";
PHP
cat > "$pub/recipes/private/whoami.php" <<'PHP'
<?php // PHP-SOURCE-SECRET
echo 'user=[' . ($_SERVER['PAMMY_USER'] ?? '') . "]\n";
// who it is and what they may do there (docs/roles-plan.md step 3), and what a
// visitor sent under the same names (never to arrive)
foreach (['ACCOUNT', 'ROLE', 'PRIVILEGES'] as $k) echo strtolower($k) . '=[' . ($_SERVER["PAMMY_$k"] ?? '') . "]\n";
foreach (['USER', 'ACCOUNT', 'ROLE', 'PRIVILEGES'] as $k) echo 'sent-' . strtolower($k) . '=[' . ($_SERVER["HTTP_X_PAMMY_$k"] ?? '') . "]\n";
PHP
printf '%s\n' '<?php // PHP-SOURCE-SECRET' 'echo "RAN-SUB";' > "$pub/recipes/hi.php"
for f in open/old.PHP open/x.phtml open/x.php7 open/.hidden.php; do echo '<?php // PHP-SOURCE-SECRET' > "$pub/$f"; done

# ---------------------------------------------------------------- the gate, and its Postgres
node --disable-warning=ExperimentalWarning "$P/test/pg-serve.ts" "$T" > "$T/pg.log" 2>&1 &
pg_pid=$!
for _ in $(seq 150); do [[ -s $T/pg.env ]] && break; sleep 0.1; done
[[ -s $T/pg.env ]] || { echo "the test Postgres didn't start:"; cat "$T/pg.log"; exit 1; }
source "$T/pg.env"
# what the gate's tables say, straight from Postgres
q() { PGOPTIONS="-c search_path=gate" PGPASSWORD=$(cat "$T/gate.pass") psql -X -qtA -h 127.0.0.1 -p "$PGPORT" -U pammy_gate -d "$PGDATABASE" -c "$1" 2>&1; }
# nginx's edge secret (docs/s1-plan.md S1c): the gate believes X-Real-IP only with it
( umask 077; openssl rand -hex 32 > "$T/edge.secret" )
GATE_EDGE_SECRET_FILE=$T/edge.secret \
GATE_PUBLIC=$pub GATE_PORT=$GPORT GATE_ADMIN_SOCKET=$T/admin.sock GATE_PHP_SOCKET=$T/php.sock GATE_AREAS_SNAPSHOT=$T/areas.json \
    GATE_PG_PORT=$PGPORT GATE_PG_DATABASE=$PGDATABASE GATE_PG_PASSWORD_FILE=$T/gate.pass \
    node --disable-warning=ExperimentalWarning "$P/src/gate/main.ts" > "$T/gate.log" 2>&1 &
gate_pid=$!
# ready: it answers, and has reached its database (until then /_pammy/me is 503)
for _ in $(seq 100); do
    [[ -S $T/admin.sock ]] && [[ $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pammy.org' "http://127.0.0.1:$GPORT/_pammy/me") == 200 ]] && break
    sleep 0.1
done
adm() { SITEFS_SOCKET=$T/admin.sock node --disable-warning=ExperimentalWarning "$P/src/sitefs/call.ts" "$1"; }
tokA=$(adm '{"op":"area.create","path":"recipes/private"}' | grep -o '"token": "[^"]*"' | cut -d'"' -f4)
tokC=$(adm '{"op":"area.create","path":"members"}' | grep -o '"token": "[^"]*"' | cut -d'"' -f4)
echo "pammy-protected $tokA" > "$pub/recipes/private/.pammy-protected"
echo "pammy-protected $tokC" > "$pub/members/.pammy-protected"
tokO=$(adm "{\"op\":\"area.create\",\"path\":\"$olivia\"}" | grep -o '"token": "[^"]*"' | cut -d'"' -f4)
echo "pammy-protected $tokO" > "$pub/$olivia/.pammy-protected"
vid=$(adm '{"op":"visitor.create","username":"alice","password":"alice-password-123"}' | grep -o '"id": [0-9]*' | grep -o '[0-9]*')
adm "{\"op\":\"grant\",\"visitorId\":$vid,\"areaId\":1,\"allow\":true}" >/dev/null

# ---------------------------------------------------------------- nginx: the real config, made runnable here
mkdir -p "$T"/{gate,panelinc,wpinc,render}
# the files the installer writes, rendered from pammy.org's profile (docs/adapters-plan.md A4)
node --disable-warning=ExperimentalWarning "$P/tools/render-nginx.ts" "$T/rendered" --extra-range 127.0.0.1/32 >/dev/null
mkdir -p "$T/panelinc" && cp "$T/rendered/panel/cloudflare-realip.conf" "$T/rendered/panel/cloudflare-ips.geo" "$T/panelinc/"
( umask 077; printf 'proxy_set_header X-Lfdln-Edge "%s";\n' "$(cat "$T/edge.secret")" > "$T/panelinc/edge.conf" )
sed -e "s#127.0.0.1:3045#127.0.0.1:$GPORT#" -e "s#/etc/nginx/pammy-panel#$T/panelinc#" -e "s#/etc/nginx/pammy-gate#$T/gate#g" "$T/rendered/gate/gate.conf" > "$T/gate/gate.conf"
cp "$T/rendered/gate/uri.conf" "$T/gate/"
sed -e "s#/etc/nginx/pammy-gate#$T/gate#g" -e "s#/run/pammy-php/#$T/phprun/#" "$T/rendered/gate/php.conf" > "$T/gate/php.conf"

# ---------------------------------------------------------------- PHP: the real pool and php.ini, in PHP 8.3 with no network
# (the systemd cage around it -- pammy-php.service -- is checked on the server by verify-panel.sh)
mkdir -p "$T/phprun" "$T/phptmp"
sed -e "s#/tmp/\?\$#$T/phptmp/#; s#= /tmp\$#= $T/phptmp#; s#:/tmp/\$#:$T/phptmp/#" -e "s#/run/pammy-php/#$T/phprun/#g" -e "s#/run/pammy-gate-php.sock#$T/php.sock#" -e "s#/pamela/public/#$pub/#" \
    -e 's#^error_log = syslog#error_log = /proc/self/fd/2#' -e '/^listen.group/d' "$P/deploy/php/php-fpm.conf" > "$T/php-fpm.conf"
php_up=
# pulled when missing (a prune of old images must not break the test)
podman image exists "$PHPIMAGE" || podman pull -q "$PHPIMAGE" >/dev/null 2>&1
if podman image exists "$PHPIMAGE"; then
    podman run -d --name "$PHPNAME" --network none --userns=keep-id --user "$(id -u):$(id -g)" \
        -v "$T:$T" -v "$P/deploy/php/php.ini:/etc/pammy-php/php.ini:ro" \
        "$PHPIMAGE" php-fpm -F -O -y "$T/php-fpm.conf" -c /etc/pammy-php/php.ini >/dev/null
    for _ in $(seq 50); do [[ -S $T/phprun/fpm.sock ]] && break; sleep 0.1; done
    [[ -S $T/phprun/fpm.sock ]] && php_up=1 || { bad "PHP-FPM didn't start"; podman logs "$PHPNAME" 2>&1 | tail -20; }
else
    bad "no $PHPIMAGE image (podman pull $PHPIMAGE) -- the PHP checks need it"
fi
bash -c "source '$WP/lib.sh'; render_placement off '' '$T/render' https://pammy.org/blog"
to_test() {
    sed -e "s#/etc/nginx/pammy-gate#$T/gate#g" \
        -e "s#/etc/nginx/pammy-wordpress#$T/wpinc#g" \
        -e "s#/pamela/public#$pub#g" \
        -e "s#/var/log/nginx/#$T/#g" \
        -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:$NPORT;#" \
        -e '/listen \[::\]/d; /listen 443/d; /ssl_certificate/d; /letsencrypt/d; /ssl_dhparam/d' \
        -e "s#127.0.0.1:3042#127.0.0.1:$APIPORT#"
}
for f in main.conf server.conf; do to_test < "$T/render/$f" > "$T/wpinc/$f"; done
# hosts_vhost [<id>:<subdomain|path>:<name>...] -- pammy.org's hosts, rendered, as the vhost
hosts_vhost() {
    rm -rf "$T/hr"
    node --disable-warning=ExperimentalWarning "$P/test/pammy-hosts-render.ts" "$T/hr" "$@" || { bad "the renderer refused pammy.org's table"; exit 1; }
    { to_test < "$T/hr/catch-all.conf"; for f in "$T"/hr/hosts/*.conf; do to_test < "$f"; done; } > "$T/vhost.conf"
}
if [[ $VHOST == hosts ]]; then hosts_vhost; echo "--- (pammy.org's hosts, as the renderer makes them)"
else to_test < "$WP/pamela-live-wp.nginx" > "$T/vhost.conf"; fi
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    # (both say the Cookie they were given: docs/s1-plan.md S1e, WordPress never gets the gate's)
    server { listen 127.0.0.1:$APIPORT; add_header X-Got-Cookie "[\$http_cookie]" always; return 599; }     # stand-in for her /api/ app
    server { listen 127.0.0.1:$SHOPPORT; add_header X-Got-Cookie "[\$http_cookie]" always; return 598; }    # stand-in for a second WordPress (docs/apps-plan.md 4a)
    include $WP/nginx/cookie-map.conf;   # the map WordPress's proxy files name (conf.d on the server)
    # names no block serves (api.pammy.org, x.y.pammy.org): on the server, default-443 and
    # lfdln's catch-all answer them, both loaded before pammy.org's files
    server { listen 127.0.0.1:$NPORT default_server; return 421; }
    include $T/vhost.conf;
}
EOF
if ! nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log"; then bad "nginx -t rejected the gated vhost"; cat "$T/error.log"; exit 1; fi
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"
sleep 0.5

# get <host> <path> [curl args...] -> "<status>|<location>|<cache-control>", body in $T/body
get() {
    local host=$1 path=$2; shift 2
    local out
    out=$(curl -s --path-as-is --max-time 5 -o "$T/body" -D "$T/headers" -w '%{http_code}' -H "Host: $host" "$@" "http://127.0.0.1:$NPORT$path")
    local loc cc
    loc=$(grep -i '^location:' "$T/headers" | tail -1 | cut -d' ' -f2- | tr -d '\r')
    cc=$(grep -i '^cache-control:' "$T/headers" | tail -1 | cut -d' ' -f2- | tr -d '\r')
    echo "$out|$loc|$cc"
}
body_has() { grep -q "$1" "$T/body"; }
leaks() { grep -qE 'SECRET-CONTENT|PRIVATE-INDEX|STYLE-X|GITSECRET|OTHER-SECRET|PHP-SOURCE-SECRET' "$T/body"; }

echo "--- unprotected: exactly as before"
r=$(get pammy.org /);                 [[ $r == "200||" ]] && body_has HOME && ok "pammy.org/ -> 200, no cache header" || bad "pammy.org/ -> $r"
r=$(get pammy.org /open/);            [[ $r == 200* ]] && body_has OPEN && ok "a normal folder -> 200" || bad "/open/ -> $r"
r=$(get recipes.pammy.org /);         [[ $r == 200* ]] && body_has RECIPES && ok "a folder subdomain -> 200" || bad "recipes.pammy.org/ -> $r"
r=$(get pammy.org /nope);             [[ $r == 404* ]] && body_has MAIN404 && ok "missing page -> her 404" || bad "/nope -> $r"
r=$(get pammy.org /recipes/nope);     [[ $r == 404* ]] && body_has RECIPES404 && ok "missing page in a folder -> the folder's 404" || bad "/recipes/nope -> $r"
r=$(get pammy.org /api/x);            [[ $r == 599* ]] && ok "/api/ still goes straight to her app" || bad "/api/x -> $r"
r=$(get pammy.org /.well-known/acme-challenge/x); [[ $r == 404* ]] && ok "ACME path not gated (404, not a sign-in redirect)" || bad "acme -> $r"
r=$(get pammy.org /recipes/.git/config); [[ $r == 403* ]] && ! leaks && ok "dotfiles still 403" || bad ".git -> $r"

echo "--- protected, not signed in: always a sign-in redirect, never content"
for path in /recipes/private/ /recipes/private /recipes/private/secret.txt /recipes/private/index.html /recipes/private/nope.html \
            /recipes/%70rivate/secret.txt /recipes/private%2Fsecret.txt //recipes//private//secret.txt \
            /recipes/./private/../private/secret.txt /open/../recipes/private/secret.txt /alias/secret.txt /alias/ \
            /recipes/private/login-files/../secret.txt /recipes/private/secret.txt%00.css; do
    r=$(get pammy.org "$path")
    if [[ $r == 302\|*login.html\?next=* ]] && [[ $r == *"|private, no-store" ]] && ! leaks; then ok "pammy.org$path -> sign-in"
    elif [[ $r == 400* || $r == 404* ]] && ! leaks; then ok "pammy.org$path -> ${r%%|*} (nginx refused it; nothing leaked)"
    else bad "pammy.org$path -> $r"; fi
done
r=$(get recipes.pammy.org /private/secret.txt)
[[ $r == "302|http://recipes.pammy.org:$NPORT/private/login.html?next=%2Fprivate%2Fsecret.txt|private, no-store" ]] && ! leaks && ok "subdomain address -> its own sign-in URL" || bad "recipes.pammy.org/private/secret.txt -> $r"
r=$(get pammy.org /recipes/private/secret.txt -I);                 [[ $r == 302* ]] && ok "HEAD -> sign-in" || bad "HEAD -> $r"
r=$(get pammy.org /recipes/private/secret.txt -H 'Range: bytes=0-5'); [[ $r == 302* ]] && ! leaks && ok "Range request -> sign-in" || bad "Range -> $r"
r=$(get pammy.org /recipes/private/secret.txt -H 'X-Pammy-Uri: /open/' -H 'X-Pammy-Base: /open'); [[ $r == 302* ]] && ! leaks && ok "forged X-Pammy-* headers ignored" || bad "forged headers -> $r"
r=$(get pammy.org /recipes/private/.pammy-protected); [[ $r == 403* ]] && ! grep -q "$tokA" "$T/body" && ok "the marker file is never served" || bad "marker -> $r"
for path in "/$olivia" "/$olivia/" "/$deep/" "/$deep/photo.jpg" "/$deep/index.html" "/$deep/missing.jpg" "/$deep/no/such/folder/" \
            "/$olivia/d1/login.html" "/$olivia/d1/logout.html" "/$olivia/d1/login-files/style.css" "/$deep/login-files/x.css" \
            "/$olivia/d1/../$(dirname "${deep#$olivia/}")/photo.jpg"; do
    r=$(get pammy.org "$path")
    [[ $r == 302\|*"/$olivia/login.html?next="*"|private, no-store" ]] && ! leaks && ok "deep inside: pammy.org${path/$(seq -s/ -f 'd%g' 3 28)/d3/…/d28} -> sign-in" || bad "deep pammy.org$path -> $r"
done
r=$(get family.pammy.org "/${deep#family/}/photo.jpg")
[[ $r == 302\|*"/2026/summer/olivia/login.html?next="*"|private, no-store" ]] && ! leaks && ok "deep inside, subdomain address -> sign-in" || bad "deep family.pammy.org -> $r"
r=$(get pammy.org "/$olivia/login.html"); [[ $r == "200||private, no-store" ]] && body_has OLIVIA-LOGINPAGE && ok "only the folder's own login.html opens" || bad "olivia login.html -> $r"
r=$(get pammy.org /family/2026/summer/other/); [[ $r == "200||" ]] && body_has OTHER-OPEN && ok "the folder next to it stays public" || bad "other -> $r"
r=$(get pammy.org /members/); [[ $r == 302*"/_pammy/login?next=%2Fmembers%2F&area=$tokC|"* ]] && ok "no login.html -> built-in sign-in page" || bad "/members/ -> $r"

echo "--- what is reachable before signing in"
r=$(get pammy.org /recipes/private/login.html);               [[ $r == "200||private, no-store" ]] && body_has LOGINPAGE && ok "the folder's login.html (private, no-store)" || bad "login.html -> $r"
r=$(get pammy.org /recipes/private/login-files/style.css);    [[ $r == 200*"private, no-store" ]] && body_has STYLE && ok "its login-files" || bad "login-files -> $r"
r=$(get pammy.org /recipes/private/login-files/banner.jpg);   [[ $r == 200*"private, no-store" ]] && body_has BANNER && ok "a picture in login-files" || bad "login-files picture -> $r"
for f in old/style.css old/ notes.txt page.html; do
    r=$(get pammy.org "/recipes/private/login-files/$f");    [[ $r == 302*login.html* ]] && ! body_has LF-SECRET-CONTENT && ok "login-files/$f stays locked (only style, picture and font files directly inside)" || bad "login-files/$f -> $r"
done
r=$(get recipes.pammy.org /private/login.html);               [[ $r == 200* ]] && body_has LOGINPAGE && ok "login.html at the subdomain address too" || bad "sub login.html -> $r"
r=$(get pammy.org "/_pammy/login?area=$tokC&next=/members/"); [[ $r == 200* ]] && body_has "pammy-login" && ok "built-in sign-in page" || bad "/_pammy/login -> $r"
for pg in login-forgot:FORGOTPAGE login-invite:INVITEPAGE login-request:REQUESTPAGE logout:LOGOUTPAGE; do
    r=$(get pammy.org "/recipes/private/${pg%%:*}.html"); [[ $r == "200||private, no-store" ]] && body_has "${pg#*:}" && ok "the folder's ${pg%%:*}.html (private, no-store)" || bad "${pg%%:*}.html -> $r"
done
r=$(get recipes.pammy.org /private/login-request.html);       [[ $r == 200* ]] && body_has REQUESTPAGE && ok "login-request.html at the subdomain address too" || bad "sub login-request.html -> $r"
r=$(get pammy.org /recipes/private/login-other.html);         [[ $r == 302* ]] && ! leaks && ok "any other login-*.html stays locked" || bad "login-other.html -> $r"
r=$(get pammy.org /recipes/private/logout-old.html);          [[ $r == 302* ]] && ! body_has OLD-SECRET-CONTENT && ok "and so does anything else starting with logout" || bad "logout-old.html -> $r"
r=$(get pammy.org "/_pammy/logout?area=$tokC");               [[ $r == 200* ]] && body_has "pammy-signed-out" && ok "built-in signed-out page (GET; signing out itself is a POST)" || bad "/_pammy/logout -> $r"
for kind in forgot invite request; do
    r=$(get pammy.org "/_pammy/$kind?area=$tokC");            [[ $r == 200* ]] && body_has "pammy-$kind" && ok "built-in $kind page" || bad "/_pammy/$kind -> $r"
done
r=$(get recipes.pammy.org "/_pammy/about?page=/private/login.html")
[[ $r == 200* ]] && body_has '"forgot":"/private/login-forgot.html"' && ok "about: the folder's own pages, on the subdomain address" || bad "about -> $r $(cat "$T/body")"
r=$(get pammy.org /_pammy/login.js);                         [[ $r == 200* ]] && body_has "customElements" && ok "the component" || bad "login.js -> $r"
r=$(get pammy.org /_pammy/examples/garden/login.html);       [[ $r == 200* ]] && body_has "pammy-login" && ok "example look page (09-protected-folders.txt PART 9)" || bad "example page -> $r"
r=$(get recipes.pammy.org /_pammy/examples/postcard/login-files/style.css); [[ $r == 200* ]] && body_has "airmail" && ok "and its style file, on a subdomain too" || bad "example style -> $r"
r=$(get recipes.pammy.org /_pammy/login.js);                 [[ $r == 200* ]] && ok "the component on subdomains too" || bad "sub login.js -> $r"
r=$(get pammy.org /_pammy/check);                            [[ $r == 404* ]] && ok "/_pammy/check can't be called from outside" || bad "/_pammy/check -> $r"

echo "--- signing in"
login() {  # login <host> <page> <password> -> status; cookie in $T/cookie
    curl -s --max-time 10 -o "$T/body" -D "$T/headers" -w '%{http_code}' -H "Host: $1" -H "Origin: https://$1" \
        -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 203.0.113.9' \
        --data "{\"username\":\"alice\",\"password\":\"$3\",\"page\":\"$2\"}" "http://127.0.0.1:$NPORT/_pammy/login"
    grep -i '^set-cookie:' "$T/headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r' > "$T/cookie"
}
code=$(login pammy.org /recipes/private/login.html wrong-password-1); [[ $code == 401 ]] && ok "wrong password refused" || bad "wrong password -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pammy.org' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
    --data '{"username":"alice","password":"alice-password-123","page":"/recipes/private/login.html"}' "http://127.0.0.1:$NPORT/_pammy/login")
[[ $code == 403 ]] && ok "sign-in from another site refused" || bad "cross-site sign-in -> $code"
code=$(login pammy.org /recipes/private/login.html alice-password-123)
cookie=$(cat "$T/cookie")
[[ $code == 200 && $cookie == __Host-pammy_visitor=* ]] && ok "signed in (cookie set)" || bad "sign-in -> $code"
r=$(get pammy.org /recipes/private/secret.txt -H "Cookie: $cookie")
[[ $r == "200||private, no-store" ]] && body_has SECRET-CONTENT && ok "signed in: content served, private, no-store" || bad "signed-in secret -> $r"
r=$(get pammy.org /alias/secret.txt -H "Cookie: $cookie");    [[ $r == 200* ]] && ok "and through the shortcut" || bad "alias signed in -> $r"
r=$(get pammy.org /recipes/private/ -H "Cookie: $cookie");     [[ $r == 200* ]] && body_has PRIVATE-INDEX && ok "folder index page" || bad "index signed in -> $r"
r=$(get pammy.org /recipes/private/nope.html -H "Cookie: $cookie"); [[ $r == 404* ]] && ok "missing page inside, signed in -> 404" || bad "missing signed in -> $r"
mkdir -p "$pub/recipes/private/album/trip" && echo TRIP > "$pub/recipes/private/album/trip/index.html"
r=$(get pammy.org /recipes/private/album/ -H "Cookie: $cookie")
[[ $r == "302|"*"/_pammy/welcome?area=$tokA&path=%2Frecipes%2Fprivate%2Falbum%2F|private, no-store" ]] && ok "signed in, folder with no index.html -> welcome page, not 403" || bad "no-index folder signed in -> $r"
r=$(get pammy.org "/_pammy/folder?area=$tokA&path=%2Frecipes%2Fprivate%2Falbum%2F" -H "Cookie: $cookie")
[[ $r == 200* ]] && body_has '"href":"/recipes/private/album/trip/"' && ok "the welcome page's list comes through nginx" || bad "folder list -> $r $(cat "$T/body")"
r=$(get pammy.org /recipes/private/album/trip/ -H "Cookie: $cookie"); [[ $r == 200* ]] && body_has TRIP && ok "a subfolder with its own index.html opens normally" || bad "album/trip -> $r"
r=$(get pammy.org "/$deep/photo.jpg" -H "Cookie: $cookie"); [[ $r == 302*"denied=1"* ]] && ! leaks && ok "signed in, not allowed into the deep folder -> sign-in (denied)" || bad "deep, not granted -> $r"
adm "{\"op\":\"grant\",\"visitorId\":$vid,\"areaId\":3,\"allow\":true}" >/dev/null
r=$(get pammy.org "/$deep/photo.jpg" -H "Cookie: $cookie"); [[ $r == "200||private, no-store" ]] && body_has DEEP-SECRET-CONTENT && ok "allowed in: 30 levels down served, private, no-store" || bad "deep, granted -> $r"
r=$(get recipes.pammy.org /private/secret.txt -H "Cookie: $cookie"); [[ $r == 302* ]] && ! leaks && ok "the pammy.org session doesn't open the subdomain address" || bad "cookie on other host -> $r"
r=$(get pammy.org /members/ -H "Cookie: $cookie");             [[ $r == 302*"denied=1"* ]] && ! body_has MEMBERS && ok "signed in, but not allowed in another folder -> sign-in (denied)" || bad "members signed in -> $r"
adm "{\"op\":\"visitor.active\",\"id\":$vid,\"active\":false}" >/dev/null
r=$(get pammy.org /recipes/private/secret.txt -H "Cookie: $cookie"); [[ $r == 302* ]] && ! leaks && ok "switched off -> locked out on the next request" || bad "switched off -> $r"

ip=$(q "SELECT coalesce((SELECT ip FROM events WHERE event = 'login' ORDER BY id DESC LIMIT 1), 'none')")
[[ $ip == 203.0.113.9 ]] && ok "the gate saw the visitor's real IP (from CF-Connecting-IP), for sign-in limits" || bad "gate logged sign-in IP: $ip"

echo "--- requests and setup links, through nginx"
jpost() {  # jpost <host> <path> <json> -> status; body in $T/body, cookie in $T/cookie
    curl -s --max-time 10 -o "$T/body" -D "$T/headers" -w '%{http_code}' -H "Host: $1" -H "Origin: https://$1" \
        -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 203.0.113.10' --data "$3" "http://127.0.0.1:$NPORT$2"
    grep -i '^set-cookie:' "$T/headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r' > "$T/cookie"
}
code=$(jpost pammy.org /_pammy/request '{"name":"Rose","contact":"0770","message":"hi","page":"/recipes/private/login-request.html"}')
[[ $code == 200 ]] && ok "ask for access from her login-request.html" || bad "request -> $code $(cat "$T/body")"
code=$(jpost recipes.pammy.org /_pammy/forgot '{"username":"alice","page":"/private/login-forgot.html"}')
[[ $code == 200 ]] && ok "forgot password from the subdomain address" || bad "forgot -> $code $(cat "$T/body")"
rows=$(q "SELECT string_agg(kind || ':' || area_id || ':' || ip, ' ' ORDER BY id) FROM requests")
[[ $rows == "access:1:203.0.113.10 reset:1:203.0.113.10" ]] && ok "both recorded for the right folder, with the visitor's real IP" || bad "requests table: $rows"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pammy.org' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
    --data '{"name":"x","contact":"y","page":"/recipes/private/login-request.html"}' "http://127.0.0.1:$NPORT/_pammy/request")
[[ $code == 403 ]] && ok "a request posted from another site is refused" || bad "cross-site request -> $code"

nid=$(adm '{"op":"visitor.create","username":"newbie"}' | grep -o '"id": [0-9]*' | grep -o '[0-9]*')
adm "{\"op\":\"grant\",\"visitorId\":$nid,\"areaId\":1,\"allow\":true}" >/dev/null
url=$(adm "{\"op\":\"link.create\",\"visitorId\":$nid,\"areaId\":1}" | grep -o '"url": "[^"]*"' | cut -d'"' -f4)
ltok=${url#*#}
[[ $url == "https://pammy.org/recipes/private/login-invite.html#"* && ${#ltok} == 43 ]] && ok "setup link opens the folder's own login-invite.html" || bad "link url: $url"
code=$(jpost pammy.org /_pammy/invite/check "{\"token\":\"$ltok\"}")
[[ $code == 200 ]] && body_has '"username":"newbie"' && ok "the link shows their username" || bad "invite check -> $code"
code=$(jpost pammy.org /_pammy/invite "{\"token\":\"$ltok\",\"password\":\"newbie-password-1\"}")
lcookie=$(cat "$T/cookie")
[[ $code == 200 && $lcookie == __Host-pammy_visitor=* ]] && body_has '"next":"/recipes/private/"' && ok "choosing a password signs them in, and sends them to the folder" || bad "invite -> $code $(cat "$T/body")"
r=$(get pammy.org /recipes/private/secret.txt -H "Cookie: $lcookie"); [[ $r == 200* ]] && body_has SECRET-CONTENT && ok "then the folder opens" || bad "after invite -> $r"
code=$(jpost pammy.org /_pammy/invite "{\"token\":\"$ltok\",\"password\":\"newbie-password-2\"}")
[[ $code == 410 ]] && ok "the link works only once" || bad "link reuse -> $code"

echo "--- forms and the responses API, through nginx"
echo ASKPAGE > "$pub/open/ask.html"
echo MEMBERASK > "$pub/members/ask.html"
adm '{"op":"form.switches","id":1,"enabled":true,"approvable":true}' >/dev/null
r=$(get pammy.org /open/ask.html);               [[ $r == "200||" ]] && body_has ASKPAGE && ok "the page holding a form is an ordinary page" || bad "ask.html -> $r"
r=$(get open.pammy.org /_pammy/forms.js);        [[ $r == 200*"no-store" ]] && body_has "pammy-form" && ok "the component, on a subdomain too, never cached" || bad "forms.js -> $r"
r=$(get open.pammy.org "/_pammy/forms/sample-contact-form?page=%2Fask.html")
[[ $r == 200* ]] && body_has '"label":"Your name"' && ok "the form's questions, at the page's address on the subdomain" || bad "form definition -> $r $(cat "$T/body")"
r=$(get pammy.org "/_pammy/forms/no-such-form?page=%2Fopen%2Fask.html"); [[ $r == 404* ]] && ok "a form that isn't there says so" || bad "unknown form -> $r"
msg='{"page":"/open/ask.html","answers":{"your-name":"Rose","email-address":"rose@example.com","message":"hello"}}'
code=$(jpost pammy.org /_pammy/forms/sample-contact-form "$msg")
[[ $code == 200 ]] && ok "a response is sent" || bad "form post -> $code $(cat "$T/body")"
pad=$(head -c 30000 /dev/zero | tr '\0' x)
code=$(jpost pammy.org /_pammy/forms/sample-contact-form "{\"page\":\"/open/ask.html\",\"padding\":\"$pad\",\"answers\":{\"your-name\":\"Rose\",\"email-address\":\"rose@example.com\",\"message\":\"a long one\"}}")
[[ $code == 200 ]] && ok "a 30 KB response gets through nginx (not 413)" || bad "30 KB form post -> $code"
pad=$(head -c 100000 /dev/zero | tr '\0' x)
code=$(jpost pammy.org /_pammy/forms/sample-contact-form "{\"page\":\"/open/ask.html\",\"padding\":\"$pad\",\"answers\":{}}")
[[ $code == 413 ]] && ok "a form response over 64 KB is still refused by nginx" || bad "100 KB form post -> $code"
# a program writing one of her records (docs/rich-text-plan.md): 2 MB for new/save only
{ printf '{"values":{"body":"'; head -c $((1024 * 1024)) /dev/zero | tr '\0' 'a'; printf '"}}'; } > "$T/record.json"
for path in /_pammy/api/data/mariadb/example_blog/posts/new /_pammy/api/data/mariadb/example_blog/posts/7/save; do
    code=$(curl -s -o "$T/body" -w '%{http_code}' -H 'Host: pammy.org' -H 'Authorization: Bearer pammy_nottherealkey' -H 'Content-Type: application/json' --data-binary @"$T/record.json" "http://127.0.0.1:$NPORT$path")
    [[ $code != 413 && $code != 502 ]] && ok "a 1 MB record to $(basename "$path") gets through nginx to the gate (it answered $code)" || bad "1 MB data API write $path -> $code"
done
head -c $((3 * 1024 * 1024)) /dev/zero > "$T/record-huge"
code=$(curl -s -o "$T/body" -w '%{http_code}' -H 'Host: pammy.org' -H 'Authorization: Bearer pammy_x' -H 'Content-Type: application/json' --data-binary @"$T/record-huge" "http://127.0.0.1:$NPORT/_pammy/api/data/mariadb/example_blog/posts/new")
[[ $code == 413 ]] && ok "a data API write over 2 MB is refused by nginx" || bad "3 MB data API write -> $code"
code=$(curl -s -o "$T/body" -w '%{http_code}' -H 'Host: pammy.org' -H 'Content-Type: application/json' --data-binary @"$T/record.json" "http://127.0.0.1:$NPORT/_pammy/api/data/mariadb/example_blog/posts/new")
[[ $code == 401 ]] && grep -q no-key "$T/body" && ok "and one with no key is turned away by the gate, not read" || bad "1 MB keyless data API write -> $code $(head -c 200 "$T/body")"
code=$(curl -s -o "$T/body" -w '%{http_code}' -H 'Host: pammy.org' -H 'Authorization: Bearer pammy_x' -H 'Content-Type: application/json' --data-binary @"$T/record.json" "http://127.0.0.1:$NPORT/_pammy/api/data/mariadb/example_blog/posts/7/delete")
[[ $code == 413 ]] && ok "a delete keeps the small limit" || bad "1 MB data API delete -> $code"
code=$(curl -s -o "$T/body" -w '%{http_code}' -H 'Host: pammy.org' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' --data "$msg" "http://127.0.0.1:$NPORT/_pammy/forms/sample-contact-form")
[[ $code == 403 ]] && ok "a response sent from another site is refused" || bad "cross-site form post -> $code"
r=$(get pammy.org /members/ask.html);            [[ $r == 302*login* ]] && ! body_has MEMBERASK && ok "a page with a form in a protected folder needs sign-in like everything else there" || bad "protected form page -> $r"
code=$(jpost pammy.org /_pammy/forms/sample-contact-form '{"page":"/members/ask.html","answers":{"your-name":"x","email-address":"x@example.com","message":"x"}}')
[[ $code == 401 ]] && ok "and its form can't be used without signing in" || bad "protected form post -> $code"
rows=$(q "SELECT string_agg(page || ':' || ip, ' ' ORDER BY id) FROM responses WHERE form_id NOT IN (SELECT id FROM forms WHERE fixture IS NOT NULL)")
[[ $rows == "open/ask.html:203.0.113.10 open/ask.html:203.0.113.10" ]] && ok "stored for the right page, with the visitor's real IP" || bad "responses table: $rows"

# the API: with a key, and (once she says so) without one
apikey=$(adm '{"op":"apikey.create","label":"nginx test","level":"all","forms":"all","actor":"verify"}' | grep -o '"key": "[^"]*"' | cut -d'"' -f4)
first=$(q "SELECT min(id) FROM responses")
adm "{\"op\":\"response.approve\",\"id\":$first,\"approved\":true,\"actor\":\"verify\"}" >/dev/null
r=$(get pammy.org /_pammy/api/forms/1/all -H "Authorization: Bearer $apikey")
[[ $r == "200||private, no-store" ]] && grep -q '"your-name": *"Rose"' "$T/body" && ok "the API gives responses to a key, never cached" || bad "api all -> $r $(cat "$T/body")"
r=$(get pammy.org /_pammy/api/forms/1/all);      [[ $r == 401* ]] && ok "and nothing without a key" || bad "api without key -> $r"
r=$(get pammy.org "/_pammy/api/forms/1/all?key=$apikey" -H "Authorization: Bearer $apikey")
[[ $r == 400* ]] && ok "a key in the address is refused (it would end up in logs)" || bad "api key in query -> $r"
adm '{"op":"form.switches","id":1,"publicApproved":true}' >/dev/null
r=$(get pammy.org /_pammy/api/forms/1/approved)
[[ $r == 200*"no-cache" ]] && body_has '"total"' && ! body_has 'rose@example.com' && ok "approved responses are readable by anyone once she says so, without the private answers" || bad "public approved -> $r $(cat "$T/body")"
r=$(get open.pammy.org /_pammy/api/forms/1/approved/filterby/your-name/Rose)
[[ $r == 200* ]] && body_has '"total"' && ok "filtering works, on a subdomain address too" || bad "api filterby -> $r"
r=$(get pammy.org /_pammy/form-preview); [[ $r == 200* ]] && body_has "pammy-form preview" && ok "the panel's preview page is served" || bad "form-preview -> $r"

echo "--- media: photos became images, old addresses redirect for good"
mkdir -p "$pub/media/images" "$pub/open/media/images" "$pub/recipes/private/media/images"
echo MEDIA-ROOT > "$pub/media/images/cake.jpg"
echo MEDIA-OPEN > "$pub/open/media/images/my dog.jpg"
echo MEDIA-SECRET-CONTENT > "$pub/recipes/private/media/images/x.jpg"
r=$(get pammy.org /media/photos/cake.jpg);    [[ $r == "301|http://pammy.org:$NPORT/media/images/cake.jpg|" ]] && ok "the main site's /media/photos/ -> /media/images/ (301)" || bad "/media/photos -> $r"
r=$(get pammy.org /media/images/cake.jpg);    [[ $r == 200* ]] && body_has MEDIA-ROOT && ok "and the new address serves it" || bad "/media/images -> $r"
r=$(get pammy.org '/open/media/photos/my%20dog.jpg?v=2'); [[ $r == "301|http://pammy.org:$NPORT/open/media/images/my%20dog.jpg?v=2|" ]] && ok "a folder's media, a name with a space, and ?v= kept" || bad "/open/media/photos -> $r"
r=$(get open.pammy.org /media/photos/my%20dog.jpg); [[ $r == "301|http://open.pammy.org:$NPORT/media/images/my%20dog.jpg|" ]] && ok "on a folder subdomain too" || bad "open.pammy.org/media/photos -> $r"
r=$(get pammy.org /media/photos);             [[ $r == "301|http://pammy.org:$NPORT/media/images|" ]] && ok "the folder itself, without a slash" || bad "/media/photos (bare) -> $r"
r=$(get pammy.org /a/b/media/photos/x.jpg);   [[ $r == 404* ]] && ok "deeper than one folder is not a media folder: no redirect" || bad "/a/b/media/photos -> $r"
r=$(get pammy.org /media/photosx/y.jpg);      [[ $r == 404* ]] && ok "only the folder photos itself" || bad "/media/photosx -> $r"
r=$(get pammy.org /recipes/private/media/images/x.jpg); [[ $r == 302* ]] && ! body_has MEDIA-SECRET-CONTENT && ok "a protected folder's media still needs sign-in" || bad "protected media -> $r"
r=$(get pammy.org /recipes/private/media/photos/x.jpg); [[ $r == 302*login.html* ]] && ! body_has MEDIA-SECRET-CONTENT && ok "deeper than one folder: no redirect, and still the sign-in page" || bad "protected media photos -> $r"
r=$(get pammy.org /recipes/media/photos/x.jpg); [[ $r == 301* ]] && ! body_has SECRET && ok "a redirect serves nothing itself" || bad "recipes media photos -> $r"

if [[ $VHOST == hosts ]]; then
echo "--- the hand-kept file and the rendered hosts side by side: every answer the same"
# a second nginx with the hand-kept file, in front of the same gate, PHP and website
NPORT2=18181
mkdir -p "$T/live"
to_test < "$WP/pamela-live-wp.nginx" | sed "s#listen 127.0.0.1:$NPORT;#listen 127.0.0.1:$NPORT2;#" > "$T/live/vhost.conf"
sed -e "s#pid $T/nginx.pid#pid $T/live/nginx.pid#" -e "s#include $T/vhost.conf#include $T/live/vhost.conf#" \
    -e "/listen 127.0.0.1:$APIPORT;/d" -e "/listen 127.0.0.1:$SHOPPORT;/d" -e "s#listen 127.0.0.1:$NPORT default_server#listen 127.0.0.1:$NPORT2 default_server#" \
    "$T/nginx.conf" > "$T/live/nginx.conf"
if nginx -t -q -p "$T/live" -c "$T/live/nginx.conf" -e "$T/live/error.log" && nginx -p "$T/live" -c "$T/live/nginx.conf" -e "$T/live/error.log"; then
    sleep 0.5
    # answer <port> <host> <path> [cookie] -> status|location|cache-control|content-type|body's sha
    answer() {
        local h b
        h=$(curl -s --path-as-is --max-time 5 -o "$T/cmp-body" -D - -w '%{http_code}' -H "Host: $2" ${4:+-H "Cookie: $4"} "http://127.0.0.1:$1$3" | tr -d '\r')
        printf '%s|%s|%s|%s|%s\n' "${h##*$'\n'}" "$(grep -i '^location:' <<<"$h" | tail -1 | cut -d' ' -f2- | sed "s#:$NPORT2/#:$NPORT/#")" \
            "$(grep -i '^cache-control:' <<<"$h" | tail -1 | cut -d' ' -f2-)" "$(grep -i '^content-type:' <<<"$h" | tail -1 | cut -d' ' -f2-)" \
            "$(sha256sum < "$T/cmp-body" | cut -c1-16)"
    }
    mapfile -t paths < <(cd "$pub" && find . -mindepth 1 | sed 's#^\.##' | sort; cd "$pub" && find . -mindepth 1 -type d | sed 's#^\.##; s#$#/#' | sort)
    paths+=(/ /nope /nope/ /index.html /404.html /api/ /api/x /api/.env /api/x.php /.well-known/acme-challenge/x /.env /x.php /open/nope.php
            /recipes/.git/config /recipes/%70rivate/secret.txt //recipes//private//secret.txt /recipes/./private/../private/secret.txt
            /open/../recipes/private/secret.txt /recipes/private/secret.txt%00.css /media/photos/a.jpg /recipes/media/photos/
            /_pammy/login.js /_pammy/check /_pammy/me /blog /blog/ /open /recipes /private/secret.txt /private/login.html)
    n=0 diff=0
    for host in pammy.org www.pammy.org recipes.pammy.org family.pammy.org open.pammy.org nope.pammy.org api.pammy.org x.y.pammy.org; do
        for path in "${paths[@]}"; do
            for c in "" "$cookie"; do
                a=$(answer "$NPORT" "$host" "$path" "$c"); b=$(answer "$NPORT2" "$host" "$path" "$c")
                n=$((n+1))
                if [[ $a != "$b" ]]; then diff=$((diff+1)); [[ $diff -le 15 ]] && echo "        differs: $host$path${c:+ (signed in)}: hosts $a / hand-kept $b"; fi
            done
        done
    done
    [[ $diff -eq 0 ]] && ok "$n requests, the same answers from both (status, redirect, cache, type, body)" || bad "$diff of $n requests answered differently"
    nginx -p "$T/live" -c "$T/live/nginx.conf" -e "$T/live/error.log" -s stop 2>/dev/null
else
    bad "the hand-kept file wouldn't start beside the hosts"; tail -5 "$T/live/error.log"
fi
fi

echo "--- WordPress placements: WordPress itself is never gated, her folders still are"
cp "$WP/nginx/proxy.conf" "$WP/nginx/cloudflare-realip.conf" "$T/wpinc/" 2>/dev/null
for f in proxy.conf cloudflare-realip.conf; do to_test < "$WP/nginx/$f" > "$T/wpinc/$f"; done
if [[ -n $php_up ]]; then
echo "--- PHP pages (docs/tutorials-plan.md P1-P5)"
line() { grep -qxF "$1" "$T/body"; }
r=$(get pammy.org /open/hello.php)
[[ $r == 200* ]] && line RAN-PHP && ! leaks && ok "a .php page runs, and its code isn't sent" || bad "/open/hello.php -> $r $(head -c 300 "$T/body")"
line 'user=[]' && ok "outside a protected folder nobody is signed in (PAMMY_USER empty)" || bad "user: $(grep user= "$T/body")"
line 'exec=no' && ok "no running programs, no sockets of its own" || bad "exec: $(grep exec= "$T/body")"
line 'passwd=no' && line 'outside=no' && line 'mine=yes' && ok "reads her website and nothing else (open_basedir)" || bad "files: $(grep -E 'passwd=|outside=|mine=' "$T/body" | tr '\n' ' ')"
grep -qE '^api=40[14] \{"error":"(no-key|no-app)"' "$T/body" && ok "reaches the gate's API through its socket (it answers: no key, no app)" || bad "api: $(grep api= "$T/body")"
grep -q '^check=404 .*Only /_pammy/api/' "$T/body" && ok "and nothing but the API there" || bad "check: $(grep check= "$T/body")"
line 'net=no' && ok "no network" || bad "net: $(grep net= "$T/body")"
r=$(get pammy.org /open/hello.php -H 'X-Pammy-User: mallory'); line 'user=[]' && ok "a visitor can't say who they are with a header" || bad "forged user -> $(grep user= "$T/body")"
r=$(get recipes.pammy.org /hi.php); [[ $r == 200* ]] && body_has RAN-SUB && ! leaks && ok "PHP runs on folder subdomains too" || bad "recipes.pammy.org/hi.php -> $r"
r=$(get pammy.org /recipes/private/whoami.php); [[ $r == "302|"*"/recipes/private/login.html?next="*"|private, no-store" ]] && ! leaks && ! body_has 'user=' && ok "a PHP page in a protected folder needs sign-in first (P1)" || bad "protected php -> $r"
# a visitor of its own: earlier sections sign alice out and in again
pid_=$(adm '{"op":"visitor.create","username":"phppat","password":"phppat-password-123"}' | grep -o '"id": [0-9]*' | grep -o '[0-9]*')
adm "{\"op\":\"grant\",\"visitorId\":$pid_,\"areaId\":1,\"allow\":true}" >/dev/null
curl -s --max-time 10 -o "$T/body" -D "$T/headers" -H "Host: pammy.org" -H "Origin: https://pammy.org" -H 'Content-Type: application/json' -H 'CF-Connecting-IP: 203.0.113.77' \
    --data '{"username":"phppat","password":"phppat-password-123","page":"/recipes/private/login.html"}' "http://127.0.0.1:$NPORT/_pammy/login" >/dev/null
pcookie=$(grep -i '^set-cookie:' "$T/headers" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r')
r=$(get pammy.org /recipes/private/whoami.php -H "Cookie: $pcookie"); [[ $r == 200*"private, no-store"* ]] && body_has 'user=\[phppat\]' && ok "signed in: it runs, is told who (P4), and stays private" || bad "signed-in php -> $r $(cat "$T/body")"
r=$(get pammy.org /recipes/private/whoami.php -H "Cookie: $pcookie" -H 'X-Pammy-User: mallory'); body_has 'user=\[phppat\]' && ok "still them, whatever header is sent" || bad "forged signed-in -> $(cat "$T/body")"
line "account=[$pid_]" && line 'role=[Member]' && line 'privileges=[pages.read]' \
    && ok "and told their account, role and privileges there (PAMMY_ACCOUNT, PAMMY_ROLE, PAMMY_PRIVILEGES)" || bad "role -> $(cat "$T/body")"
r=$(get pammy.org /recipes/private/whoami.php -H "Cookie: $pcookie" -H 'X-Pammy-Role: Admin' -H 'X-Pammy-Privileges: everything.any' -H 'X-Pammy-Account: 1')
line 'role=[Member]' && line 'privileges=[pages.read]' && line "account=[$pid_]" && line 'sent-user=[]' && line 'sent-account=[]' && line 'sent-role=[]' && line 'sent-privileges=[]' \
    && ok "a role or privileges sent as headers change nothing, and never reach PHP" || bad "forged role -> $(cat "$T/body")"
for u in /open/old.PHP /open/x.phtml /open/x.php7 /open/old%2EPHP; do
    r=$(get pammy.org "$u"); [[ $r == 404* ]] && ! leaks && ok "$u -> 404, never as text" || bad "$u -> $r"
done
r=$(get pammy.org /open/.hidden.php); [[ $r == 40[34]* ]] && ! leaks && ! body_has RAN && ok "a dot-file .php is neither run nor sent (${r%%|*})" || bad ".hidden.php -> $r"
r=$(get pammy.org /open/nope.php);    [[ $r == 404* ]] && body_has MAIN404 && ok "a missing .php page -> her 404 page" || bad "nope.php -> $r"
r=$(get pammy.org /recipes/private/nope.php); [[ $r == "302|"*"/recipes/private/login.html?next="* ]] && ok "a missing .php in a protected folder says nothing (sign-in first)" || bad "protected nope.php -> $r"
podman stop -t 1 "$PHPNAME" >/dev/null 2>&1
r=$(get pammy.org /open/hello.php); [[ $r == 502* ]] && ! leaks && ok "PHP stopped: 502, never the code (P5)" || bad "php down -> $r"
podman start "$PHPNAME" >/dev/null 2>&1
fi

sed -i "s#127.0.0.1:3043#127.0.0.1:$APIPORT#" "$T/wpinc/proxy.conf"     # WordPress stand-in answers 599
for placement in "path blog" "root"; do
    read -r mode name <<<"$placement"
    [[ $VHOST == hosts && $mode == root ]] && continue     # (not a route: refused on hosts)
    rm -rf "$T/render"; bash -c "source '$WP/lib.sh'; render_placement '$mode' '${name:-}' '$T/render' https://pammy.org"
    for f in main.conf server.conf; do to_test < "$T/render/$f" > "$T/wpinc/$f"; done
    [[ $VHOST == hosts ]] && hosts_vhost "blog:$mode:$name"
    if ! nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log"; then bad "nginx -t rejected placement '$placement'"; continue; fi
    nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s reload; sleep 1
    if [[ $placement == "path blog" ]]; then
        r=$(get pammy.org /blog/);           [[ $r == 599* ]] && ok "path blog: /blog/ goes to WordPress, not gated" || bad "path blog /blog/ -> $r"
        r=$(get pammy.org /blog);            [[ $r == 301* ]] && ok "path blog: /blog redirects, not gated" || bad "path blog /blog -> $r"
        r=$(get pammy.org /blog/xmlrpc.php); [[ $r == 403* ]] && ok "path blog: xmlrpc still blocked" || bad "path blog xmlrpc -> $r"
        r=$(get pammy.org /blog/wp-login.php); [[ $r == 599* ]] && ok "path blog: WordPress's own .php still goes to WordPress" || bad "path blog wp-login -> $r"
        # the gate's cookie never reaches WordPress; its own do (docs/s1-plan.md S1e)
        wpc='wordpress_logged_in_abc=1; __Host-pammy_visitor=gatesecret; wp-settings-1=a; wp-settings-time-1=2; comment_author_y=z'
        r=$(get pammy.org /blog/ -H "Cookie: $wpc"); got=$(grep -i '^x-got-cookie:' "$T/headers" | cut -d' ' -f2- | tr -d '\r')
        [[ $got == '[wordpress_logged_in_abc=1; wp-settings-1=a; wp-settings-time-1=2; comment_author_y=z]' ]] \
            && ok "path blog: WordPress gets its own cookies (wordpress_*, wp-settings-*, comment_author_*), never the gate's" || bad "path blog: WordPress got cookies $got"
        r=$(get pammy.org /blog/ -H 'Cookie: __Host-pammy_visitor=gatesecret'); got=$(grep -i '^x-got-cookie:' "$T/headers" | cut -d' ' -f2- | tr -d '\r')
        [[ $got == '[]' ]] && ok "path blog: the gate's cookie alone -> no cookies at all" || bad "path blog: WordPress got cookies $got"
        r=$(get pammy.org /api/x -H "Cookie: $wpc"); got=$(grep -i '^x-got-cookie:' "$T/headers" | cut -d' ' -f2- | tr -d '\r')
        [[ $got == "[$wpc]" ]] && ok "her /api/ app still gets every cookie (S1e-Q1: unchanged for now)" || bad "/api/ got cookies $got"
    else
        r=$(get pammy.org /);                [[ $r == 599* ]] && ok "root: home page goes to WordPress, not gated" || bad "root / -> $r"
        r=$(get pammy.org /xmlrpc.php);      [[ $r == 403* ]] && ok "root: xmlrpc still blocked" || bad "root xmlrpc -> $r"
        r=$(get pammy.org /wp-login.php);    [[ $r == 599* ]] && ok "root: WordPress's own .php still goes to WordPress" || bad "root wp-login -> $r"
        r=$(get pammy.org /open/);           [[ $r == 200* ]] && body_has OPEN && ok "root: her folders still served" || bad "root /open/ -> $r"
    fi
    r=$(get pammy.org /recipes/private/secret.txt); [[ $r == 302* ]] && ! leaks && ok "$placement: protected folder still needs sign-in" || bad "$placement protected -> $r"
    r=$(get pammy.org /alias/secret.txt);           [[ $r == 302* ]] && ! leaks && ok "$placement: shortcut still needs sign-in" || bad "$placement alias -> $r"
done

echo "--- several WordPress installs at once (docs/apps-plan.md 4a, src/apps/nginx.ts): the blog answers 599, a second one 598"
render_apps() {  # render_apps <JSON list of installs> -- the software helper's own renderer
    rm -rf "$T/render"; mkdir -p "$T/render"
    node --disable-warning=ExperimentalWarning --input-type=module -e "
      import { writeFileSync } from 'node:fs';
      import { basename } from 'node:path';
      import { renderAll } from '$P/src/apps/nginx.ts';
      for (const [f, text] of renderAll('$WP/nginx/templates', JSON.parse(process.argv[1]))) writeFileSync('$T/render/' + basename(f), text);
    " "$1"
    for f in "$T"/render/*.conf; do to_test < "$f" | sed "s#127.0.0.1:3100#127.0.0.1:$SHOPPORT#" > "$T/wpinc/$(basename "$f")"; done
}
app() { printf '{"id":"%s","placement":{"mode":"%s","name":%s},"placementFile":"/etc/nginx/pammy-wordpress/placement%s","port":%s,"adopted":%s}' \
    "$1" "$2" "$([[ -n ${3:-} ]] && echo "\"$3\"" || echo null)" "$([[ $1 == blog ]] || echo "-$1")" "$([[ $1 == blog ]] && echo 3043 || echo 3100)" "$([[ $1 == blog ]] && echo true || echo false)"; }
for combo in "blog subdomain blog|shop path shop" "shop root|blog path blog" "blog path blog|shop subdomain shop"; do
    IFS='|' read -r one two <<<"$combo"
    [[ $VHOST == hosts && $combo == *root* ]] && continue     # (not a route: refused on hosts)
    render_apps "[$(app $one),$(app $two)]"
    if [[ $VHOST == hosts ]]; then read -r a1 m1 n1 <<<"$one"; read -r a2 m2 n2 <<<"$two"; hosts_vhost "$a1:$m1:$n1" "$a2:$m2:$n2"; fi
    if ! nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log"; then bad "nginx -t rejected '$combo'"; cat "$T/error.log" | tail -5; continue; fi
    nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s reload; sleep 1
    case $combo in
        "blog subdomain blog|shop path shop")
            r=$(get blog.pammy.org /);        [[ $r == 599* ]] && ok "$combo: blog.pammy.org is the blog" || bad "$combo: blog.pammy.org -> $r"
            r=$(get pammy.org /shop/);        [[ $r == 598* ]] && ok "$combo: pammy.org/shop/ is the second one" || bad "$combo: /shop/ -> $r"
            r=$(get pammy.org /shop/xmlrpc.php); [[ $r == 403* ]] && ok "$combo: its xmlrpc blocked too" || bad "$combo: /shop/xmlrpc -> $r"
            r=$(get pammy.org /shop/ -H 'Cookie: wp-settings-1=a; __Host-pammy_visitor=gatesecret'); got=$(grep -i '^x-got-cookie:' "$T/headers" | cut -d' ' -f2- | tr -d '\r')
            [[ $got == '[wp-settings-1=a]' ]] && ok "$combo: the second one's proxy file keeps the gate's cookie out too" || bad "$combo: /shop/ got cookies $got" ;;
        "shop root|blog path blog")
            r=$(get pammy.org /);             [[ $r == 598* ]] && ok "$combo: the home page is the second one" || bad "$combo: / -> $r"
            r=$(get pammy.org /blog/);        [[ $r == 599* ]] && ok "$combo: pammy.org/blog/ is still the blog" || bad "$combo: /blog/ -> $r"
            r=$(get pammy.org /nope-page);    [[ $r == 598* ]] && ok "$combo: a missing page goes to the one on the whole site" || bad "$combo: /nope-page -> $r" ;;
        "blog path blog|shop subdomain shop")
            r=$(get shop.pammy.org /);        [[ $r == 598* ]] && ok "$combo: shop.pammy.org is the second one" || bad "$combo: shop.pammy.org -> $r"
            r=$(get pammy.org /blog/);        [[ $r == 599* ]] && ok "$combo: pammy.org/blog/ is the blog" || bad "$combo: /blog/ -> $r" ;;
    esac
    r=$(get pammy.org /open/);                      [[ $r == 200* ]] && body_has OPEN && ok "$combo: her folders still served" || bad "$combo: /open/ -> $r"
    r=$(get pammy.org /recipes/private/secret.txt); [[ $r == 302* ]] && ! leaks && ok "$combo: protected folder still needs sign-in" || bad "$combo: protected -> $r"
done

if [[ $VHOST == hosts ]]; then
echo "--- the switch (docs/phase8-plan.md 8-7c) on a nginx laid out like the server's"
# (last but one: its few hundred requests from 127.0.0.1 spend the gate's allowance per address)
# its own nginx: sites-enabled with the link to the pamela site (the real file, with the
# harness's paths and a certificate of its own), the blog on its subdomain as on the server
LH=18183 LS=18556
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj "/CN=*.pammy.org" \
    -keyout "$T/sw-key.pem" -out "$T/sw-cert.pem" 2>/dev/null
mkdir -p "$T/sa" "$T/se" "$T/pammy-hosts" "$T/swwp"
sw_conf() {
    sed -e "s#/etc/nginx/pammy-gate#$T/gate#g" -e "s#/etc/nginx/pammy-wordpress#$T/swwp#g" -e "s#/pamela/public#$pub#g" -e "s#/var/log/nginx/#$T/#g" \
        -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:$LH;#" -e "s#^\(\s*\)listen 443 ssl;#\1listen 127.0.0.1:$LS ssl;#" \
        -e "s#ssl_certificate .*#ssl_certificate $T/sw-cert.pem;#" -e "s#ssl_certificate_key .*#ssl_certificate_key $T/sw-key.pem;#" \
        -e '/listen \[::\]/d; /letsencrypt/d; /ssl_dhparam/d' -e "s#127.0.0.1:3042#127.0.0.1:$APIPORT#" -e "s#127.0.0.1:3043#127.0.0.1:$APIPORT#"
}
rm -rf "$T/render"; bash -c "source '$WP/lib.sh'; render_placement subdomain blog '$T/render' https://pammy.org"
for f in main.conf server.conf; do sw_conf < "$T/render/$f" > "$T/swwp/$f"; done
for f in proxy.conf cloudflare-realip.conf; do sw_conf < "$WP/nginx/$f" > "$T/swwp/$f"; done
sw_conf < "$WP/pamela-live-wp.nginx" > "$T/sa/pamela"
ln -s "$T/sa/pamela" "$T/se/pamela"
cat > "$T/sw.conf" <<CONF
worker_processes 1; pid $T/sw.pid; error_log $T/sw-error.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    server { listen 127.0.0.1:$LH default_server; return 421; }
    server { listen 127.0.0.1:$LS ssl default_server; ssl_reject_handshake on; }
    include $WP/nginx/cookie-map.conf;
    include $T/se/*;
}
CONF
if nginx -t -q -p "$T" -c "$T/sw.conf" -e "$T/sw-error.log" && nginx -p "$T" -c "$T/sw.conf" -e "$T/sw-error.log"; then
    sleep 0.5
    out=$(node --disable-warning=ExperimentalWarning "$P/test/pammy-switch.ts" "$T" "$pub" "$LH" "$LS" "$T/sw-cert.pem" "$T/sw-key.pem" "$APIPORT" "$T/sw.conf" 2>&1)
    grep -v '^  pammy switch:' <<<"$out" | grep -E '^  (ok|FAIL) ' | while IFS= read -r l; do echo "$l"; done
    pass=$((pass + $(grep -c '^  ok ' <<<"$out"))); fail=$((fail + $(grep -c '^  FAIL ' <<<"$out")))
    grep -q '^  pammy switch: .* 0 failed' <<<"$out" || { bad "the switch script didn't finish cleanly"; tail -15 <<<"$out"; }
    nginx -p "$T" -c "$T/sw.conf" -e "$T/sw-error.log" -s stop 2>/dev/null
else
    bad "the switch's nginx wouldn't start with the pamela site"; tail -5 "$T/sw-error.log"
fi
fi

echo "--- if the gate stops"
kill "$gate_pid"; wait "$gate_pid" 2>/dev/null; gate_pid=
sleep 0.3
r=$(get pammy.org /recipes/private/secret.txt); [[ $r == 5* ]] && ! leaks && ok "protected file -> ${r%%|*}, nothing served" || bad "gate down, protected -> $r"
r=$(get pammy.org /);                           [[ $r == 5* ]] && ok "the rest of the site also -> ${r%%|*} (fails closed)" || bad "gate down, home -> $r"
r=$(get pammy.org /api/x);                      [[ $r == 599* ]] && ok "/api/ unaffected" || bad "gate down, api -> $r"

echo
echo "  gate nginx test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
