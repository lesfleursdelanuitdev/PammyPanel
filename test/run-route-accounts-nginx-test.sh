#!/usr/bin/env bash
# Accounts on a route (docs/roles-plan.md step 5, S5-4): the files the routing helper
# writes, on a throwaway unprivileged nginx, with a stand-in gate and app
# (test/route-accounts-stubs.ts) and real requests. What the gate decides is
# test/route-areas.test.ts; here: that nginx asks it everywhere it should, passes
# its answer on, never what the visitor sent, and fails closed without it.
#   test/run-route-accounts-nginx-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
HTTP=18280 HTTPS=18643 GATE=18247 APP=18241
D=lesfleursdelanuit.com
OPEN=$(printf 'o%.0s' {1..32}) PRIV=$(printf 'p%.0s' {1..32})
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
stubs= fcgi=
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    [[ -n $stubs ]] && kill "$stubs" 2>/dev/null
    [[ -n $fcgi ]] && kill "$fcgi" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT

S=$T/sites
mkdir -p "$S/members/assets" "$S/members/sub"
echo '<h1>members home</h1>' > "$S/members/index.html"
echo 'console.log(1)'         > "$S/members/assets/app.js"
echo '<p>sub</p>'             > "$S/members/sub/index.html"
echo '<?php echo "ran";'      > "$S/members/x.php"
echo '{"version":1}'          > "$S/members/pammy-panel.json"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -subj "/CN=*.$D" -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null
node --disable-warning=ExperimentalWarning --input-type=module -e "
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { renderAll } from '@panel/hosts/render';
import { PROFILE } from '$P/test/fixtures/lfdln-profile.ts';
import { edgeFile } from '$P/test/edge-file.ts';
const [out, sites] = ['$T/hosts', '$S'];
const cfg = { ...hostsConfigOf(PROFILE, out), dir: out, sitesRoot: sites, edge: edgeFile('$T'), tls: { cert: '$T/cert.pem', key: '$T/key.pem' },
  php: { socket: '$T/no-php.sock' }, listen: { http: '127.0.0.1:$HTTP', https: '127.0.0.1:$HTTPS', v6: false }, gate: '127.0.0.1:$GATE' };
const svc = (host, extra) => ({ host, path: '/', enabled: true, kind: 'service', service: 'app', part: 'web', websockets: false, maxBodyMb: null, signInPaths: [], ...extra });
const table = {
  hosts: [{ name: 'open', enabled: true }, { name: 'private', enabled: true }, { name: 'plain', enabled: true }],
  folders: [{ name: 'members', runPhp: true }],
  routes: [
    svc('open', { accounts: { token: '$OPEN' }, signInPaths: ['=/login'] }),
    { host: 'private', path: '/', enabled: true, kind: 'folder', folder: 'members', spa: false, accounts: { token: '$PRIV' }, cacheForever: ['/assets/'] },
    svc('plain', {}),
  ],
  services: [{ service: 'app', part: 'web', port: $APP }],
};
for (const [f, text] of renderAll(cfg, table)) { mkdirSync(dirname(join(out, f)), { recursive: true }); writeFileSync(join(out, f), text); }
" || { bad "the renderer refused the table"; exit 1; }
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    include /etc/nginx/mime.types;
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    limit_req_zone \$binary_remote_addr zone=login:1m rate=60r/m;
    server { listen 127.0.0.1:$HTTP default_server; return 421; }
    server { listen 127.0.0.1:$HTTPS ssl default_server; ssl_reject_handshake on; }
    include $T/hosts/site.conf;
}
EOF
if nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log" 2>"$T/t.log"; then ok "nginx accepts every file the renderer writes"
else bad "nginx -t: $(cat "$T/t.log")"; exit 1; fi
node --disable-warning=ExperimentalWarning "$P/test/route-accounts-stubs.ts" "$GATE" "$APP" "$OPEN" "$PRIV" & stubs=$!
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"
for _ in $(seq 50); do curl -s "http://127.0.0.1:$APP/" >/dev/null && curl -s "http://127.0.0.1:$GATE/" >/dev/null && break; sleep 0.1; done

# get <host> <path> [curl args...]: "<status> <location>", the body in $T/body, headers in $T/head
get() {
    local h=$1 path=$2; shift 2
    curl -sk --path-as-is -o "$T/body" -D "$T/head" -w '%{http_code} %{redirect_url}' --max-time 5 \
        --resolve "$h.$D:$HTTPS:127.0.0.1" "$@" "https://$h.$D:$HTTPS$path"
}
is()   { local want=$1 what=$2; shift 2; local got; got=$(get "$@"); [[ ${got%% *} == "$want" ]] && ok "$what" || bad "$what: got $got"; }
# what the app was told: seen <header> (lower case), from the app's JSON answer
seen() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=b.headers[process.argv[2]]; process.stdout.write(v===undefined?"(none)":v)' "$T/body" "$1"; }
told() { local h=$1 want=$2 what=$3; local got; got=$(seen "$h"); [[ $got == "$want" ]] && ok "$what" || bad "$what: $h was '$got'"; }
JO=(-H 'Cookie: __Host-lfdln_visitor=jo')
FORGED=(-H 'X-Lfdln-Account: 99' -H 'X-Lfdln-Username: admin' -H 'X-Lfdln-Role: Teacher' -H 'X-Lfdln-Privileges: progress.read:any' -H 'X_Lfdln_Account: 98')

echo "--- a service route, Open with accounts"
is 200 "signed out: in, to the app" open /page
told x-lfdln-role 'Not signed in' "...told: not signed in"
told x-lfdln-privileges 'pages.read' "...with what anyone may do"
told x-lfdln-account '(none)' "...and no account"
is 200 "signed out, sending the headers itself" open /page "${FORGED[@]}"
told x-lfdln-account '(none)' "...its X-Lfdln-Account never reaches the app"
told x-lfdln-username '(none)' "...nor its username"
told x-lfdln-role 'Not signed in' "...its role is the gate's"
told x-lfdln-privileges 'pages.read' "...and so are its privileges"
grep -q '"x_lfdln_account"' "$T/body" && bad "an underscored copy reached the app" || ok "...an underscored copy doesn't get through either"
is 200 "signed in" open /page "${JO[@]}" "${FORGED[@]}"
told x-lfdln-account '5' "...told their account (the gate's, not the one sent)"
told x-lfdln-username 'jo' "...their username"
told x-lfdln-role 'Member' "...their role"
told x-lfdln-privileges 'pages.read progress.update:own' "...their privileges"
proven() { local want=$1 what=$2; local got; got=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).proof))' "$T/body"); [[ $got == "$want" ]] && ok "$what" || bad "$what: proof checked $got"; }
# the proof (docs/s1-plan.md S1a): the gate's, for this app, and it holds what the app was told
proven true "...with the gate's proof of it, for this app"
is 200 "signed in, sending a proof of its own" open /page "${JO[@]}" -H 'X-Lfdln-Proof: v1.1800000000000.forged'
proven true "...the visitor's proof never reaches the app: the gate's does"
# straight to the app, as anyone on the machine could (review S1): the headers without a proof
curl -s -o "$T/body" --max-time 5 -H "Host: open.$D" "${FORGED[@]}" "http://127.0.0.1:$APP/page"
proven false "straight to the app with made-up headers: no proof, so the app believes none of them"
is 200 "signed out" open /page
proven true "...nobody signed in is proven too (what anyone may do)"
is 200 "a sign-in path (its own location, rate-limited) asks the gate too" open /login "${JO[@]}"
told x-lfdln-account '5' "...and the app is told who"
is 200 "the gate's pages are on the host" open /_pammy/login
grep -q 'gate page /_pammy/login base=/ ip=127.0.0.1' "$T/body" && ok "...from the gate, with its base and the visitor's address" || bad "the gate's page: $(head -c 120 "$T/body")"
is 404 "the gate's check can't be asked from outside" open "/_pammy/check/$OPEN"

echo "--- the gate's cookie stays with the gate (docs/s1-plan.md S1e)"
is 200 "signed in, with the app's own cookies around the gate's" open /page -H 'Cookie: a=1; __Host-lfdln_visitor=jo; b=2'
told x-lfdln-account '5' "...the gate saw the cookie: signed in"
told cookie 'a=1; b=2' "...the app gets its own cookies, not the gate's"
is 200 "the gate's cookie first" open /page -H 'Cookie: __Host-lfdln_visitor=jo; a=1'
told cookie 'a=1' "...the app gets the rest"
is 200 "the gate's cookie alone" open /page "${JO[@]}"
told cookie '(none)' "...the app gets no Cookie at all"
is 200 "the gate's cookie sent twice" open /page -H 'Cookie: __Host-lfdln_visitor=x; a=1; __Host-lfdln_visitor=jo'
told cookie '(none)' "...the app gets no cookies at all, never one of them"
is 200 "a cookie that only looks like the gate's" open /page -H 'Cookie: my__Host-lfdln_visitor=1; __Host-lfdln_visitor2=2'
told cookie 'my__Host-lfdln_visitor=1; __Host-lfdln_visitor2=2' "...goes along"
is 200 "a sign-in path" open /login -H 'Cookie: a=1; __Host-lfdln_visitor=jo'
told cookie 'a=1' "...without the gate's cookie too"
is 200 "the gate's own pages" open /_pammy/login -H 'Cookie: a=1; __Host-lfdln_visitor=jo'
grep -q 'cookie=a=1; __Host-lfdln_visitor=jo$' "$T/body" && ok "...still get the visitor's whole Cookie" || bad "the gate's page: $(head -c 160 "$T/body")"
is 200 "a route without accounts" plain /page -H 'Cookie: __Host-lfdln_visitor=jo; theme=dark'
told cookie 'theme=dark' "...takes it out too"
# the review's F1: a tab after the ";", spaces before the "=" (any cookie reader might take them)
is 200 "a tab before the gate's cookie" open /page -H $'Cookie: a=1;\t__Host-lfdln_visitor=jo'
told x-lfdln-account '5' "...the gate saw it: signed in"
told cookie 'a=1' "...the app gets the rest, without it"
is 200 "spaces before the gate's cookie's \"=\"" open /page -H 'Cookie: a=1; __Host-lfdln_visitor =jo'
told cookie '(none)' "...the app gets no cookies at all"

echo "--- a folder route, Only people let in"
r=$(get private /); [[ $r == "302 https://private.$D:$HTTPS/_pammy/login?next=%2F&area=$PRIV" ]] && ok "signed out: on to the sign-in page, with where they were going" || bad "private / signed out: $r"
grep -qi '^cache-control: private, no-store' "$T/head" && ok "...never kept by a cache" || bad "the sign-in redirect's Cache-Control: $(grep -i cache-control "$T/head")"
grep -q 'members home' "$T/body" && bad "the page was sent with the redirect"
r=$(get private /assets/app.js); [[ ${r%% *} == 302 ]] && ok "a path cached for good asks too (inherited)" || bad "private /assets/app.js signed out: $r"
r=$(get private /x.php); [[ ${r%% *} == 302 ]] && ok "a PHP page asks too (inherited): not run, not sent" || bad "private /x.php signed out: $r"
r=$(get private /nope.html); [[ ${r%% *} == 302 ]] && ok "a page that isn't there asks too: nothing about what is inside" || bad "private /nope.html signed out: $r"
r=$(get private /sub/); [[ ${r%% *} == 302 ]] && ok "a folder inside asks too" || bad "private /sub/ signed out: $r"
is 200 "signed in: the page" private / "${JO[@]}"
grep -q 'members home' "$T/body" && ok "...its own page" || bad "private / signed in: $(head -c 80 "$T/body")"
grep -qi '^cache-control: private, no-store' "$T/head" && ok "...private, no-store" || bad "signed-in page's Cache-Control: $(grep -i cache-control "$T/head")"
is 200 "signed in: a path cached for good" private /assets/app.js "${JO[@]}"
grep -qi '^cache-control: private' "$T/head" && bad "cached path says private and public at once: $(grep -i cache-control "$T/head" | tr '\n' ' ')" || ok "...cached for good, not also said private"
is 502 "signed in: a PHP page goes to PHP (not running here: 502, never text)" private /x.php "${JO[@]}"
is 404 "signed in: its pammy-panel.json is never served (the panel reads it, visitors don't)" private /pammy-panel.json "${JO[@]}"
grep -q 'echo' "$T/body" && bad "the PHP source was sent"

echo "--- PHP in a site folder gets the cookies without the gate's (docs/s1-plan.md S1e, F3)"
node --disable-warning=ExperimentalWarning "$P/test/fastcgi-capture-stub.ts" "$T/no-php.sock" & fcgi=$!
for _ in $(seq 50); do [[ -S $T/no-php.sock ]] && break; sleep 0.1; done
php_told() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify(b[process.argv[2]]))' "$T/body" "$1" 2>/dev/null; }
php_is() { local want=$1 what=$2; local got; got=$(php_told cookies); [[ $got == "$want" ]] && ok "$what" || bad "$what: PHP got HTTP_COOKIE $got"; }
is 200 "signed in, a PHP page with the app's cookies around the gate's" private /x.php -H 'Cookie: a=1; __Host-lfdln_visitor=jo; b=2'
[[ $(php_told account) == '"5"' ]] && ok "...PHP is told who (the gate saw the cookie)" || bad "PHP's LFDLN_ACCOUNT: $(php_told account)"
php_is '["a=1; b=2"]' "...one HTTP_COOKIE, without the gate's cookie"
is 200 "the gate's cookie alone" private /x.php "${JO[@]}"
php_is '[""]' "...PHP gets an empty HTTP_COOKIE, never the gate's"
is 200 "a tab before it" private /x.php -H $'Cookie: a=1;\t__Host-lfdln_visitor=jo'
php_is '["a=1"]' "...taken out there too"
kill "$fcgi" 2>/dev/null; wait "$fcgi" 2>/dev/null; fcgi=

echo "--- a service route without accounts"
is 200 "the app answers" plain /page "${FORGED[@]}" "${JO[@]}"
for h in x-lfdln-account x-lfdln-username x-lfdln-role x-lfdln-privileges; do told "$h" '(none)' "...$h sent by the visitor never reaches it"; done
is 200 "a proof sent by the visitor" plain /page -H 'X-Lfdln-Proof: v1.1800000000000.forged'
told x-lfdln-proof '(none)' "...never reaches it either"
# the gate on every host (docs/phase8-plan.md 8-2, P8-3): /_pammy/ is the gate's here too, never the app's
is 200 "/_pammy/ on it is the gate's, with no accounts too" plain /_pammy/login
grep -q 'gate page' "$T/body" && ok "...the gate's page, not the app" || bad "/_pammy/login on a host without accounts: $(head -c 80 "$T/body")"
grep -q '"headers"' "$T/body" && bad "the app answered /_pammy/"

echo "--- the gate down: nothing gets through"
kill "$stubs" 2>/dev/null; wait "$stubs" 2>/dev/null; stubs=
node --disable-warning=ExperimentalWarning -e "require('http').createServer((q,s)=>{s.end(JSON.stringify({url:q.url,headers:q.headers}))}).listen($APP,'127.0.0.1')" & stubs=$!
for _ in $(seq 50); do curl -s "http://127.0.0.1:$APP/" >/dev/null && break; sleep 0.1; done
r=$(get open /page); [[ ${r%% *} == 500 ]] && ok "open with accounts: nginx's error page, the app not reached" || bad "gate down, open /page: $r"
grep -q '"headers"' "$T/body" && bad "the app answered with the gate down"
r=$(get private / "${JO[@]}"); [[ ${r%% *} == 500 ]] && ok "only people let in: nginx's error page" || bad "gate down, private /: $r"
grep -q 'members home' "$T/body" && bad "the page was served with the gate down"
is 200 "a route without accounts doesn't need the gate" plain /page

echo
echo "  route accounts nginx test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
