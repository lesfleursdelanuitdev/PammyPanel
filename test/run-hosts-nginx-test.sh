#!/usr/bin/env bash
# lfdln's hosts (docs/hosts-plan.md step 1): the nginx files the routing helper
# will write, rendered from a table of every kind of route (test/hosts-render.ts),
# on a throwaway unprivileged nginx, with real requests. No PHP runs here: a PHP
# page that would run answers 502, and one that wouldn't answers 404 -- never text.
#   test/run-hosts-nginx-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
HTTP=18180 HTTPS=18543
D=lesfleursdelanuit.com
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    [[ -s $T/nginx-applied.pid ]] && nginx -p "$T" -c "$T/nginx-applied.conf" -e "$T/error-applied.log" -s stop 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT

# --- the site folders
S=$T/sites
mkdir -p "$S/site/.git" "$S/site/sub" "$S/docs" "$S/app/assets" "$T/outside"
echo '<h1>site home</h1>'   > "$S/site/index.html"
echo '<p>about</p>'         > "$S/site/about.html"
echo '<p>sub home</p>'      > "$S/site/sub/index.html"
echo '[core] secret'        > "$S/site/.git/config"
echo 'SECRET=1'             > "$S/site/.env"
echo '<h1>its own 404</h1>' > "$S/site/404.html"
echo '<?php echo "ran";'    > "$S/site/x.php"
echo '<?php echo "ran";'    > "$S/site/old.PHP"
echo 'outside the folder'   > "$T/outside/secret.txt"
ln -s "$T/outside/secret.txt" "$S/site/link.txt"
echo '<h1>docs home</h1>'   > "$S/docs/index.html"
echo '<p>a docs page</p>'   > "$S/docs/page.html"
echo '<?php echo "ran";'    > "$S/docs/a.php"
echo '<div id=app>spa</div>' > "$S/app/index.html"
echo 'console.log(1)'       > "$S/app/assets/app.js"

# --- the rendered files, and nginx
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -subj "/CN=*.$D" -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null
node --disable-warning=ExperimentalWarning "$P/test/hosts-render.ts" "$T/hosts" "$S" "$HTTP" "$HTTPS" "$T/cert.pem" "$T/key.pem" "$T/no-php.sock" \
    || { bad "the renderer refused the table"; exit 1; }
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    include /etc/nginx/mime.types;
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    server { listen 127.0.0.1:$HTTP default_server; return 421; }
    server { listen 127.0.0.1:$HTTPS ssl default_server; ssl_reject_handshake on; }
    include $T/hosts/site.conf;
}
EOF
if nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log" 2>"$T/t.log"; then ok "nginx accepts every file the renderer writes"
else bad "nginx -t: $(cat "$T/t.log")"; exit 1; fi
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"

# get <host> <path> [scheme]: "<status> <location>", the body in $T/body
get() {
    local h=$1 path=$2 scheme=${3:-https} port=$HTTPS
    [[ $scheme == http ]] && port=$HTTP
    curl -sk --path-as-is -o "$T/body" -D "$T/head" -w '%{http_code} %{redirect_url}' --max-time 5 \
        --resolve "$h.$D:$port:127.0.0.1" "$scheme://$h.$D:$port$path"
}
is()   { local want=$1 what=$2; shift 2; local got; got=$(get "$@"); [[ ${got%% *} == "$want" ]] && ok "$what" || bad "$what: got $got"; }
body() { grep -q "$1" "$T/body"; }

echo "--- another domain (docs/domains-hosts-plan.md step 4): its own catch-all"
r=$(curl -sk -o "$T/body" -w '%{http_code}' --max-time 5 --resolve "zz.other-domain.test:$HTTPS:127.0.0.1" "https://zz.other-domain.test:$HTTPS/")
[[ $r == 404 ]] && grep -q 'on other-domain.test' "$T/body" && ok "any name under it: its own plain 404" || bad "zz.other-domain.test: $r $(head -c 80 "$T/body")"
r=$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 --resolve "zz.other-domain.test:$HTTP:127.0.0.1" "http://zz.other-domain.test:$HTTP/x")
[[ $r == "301 https://zz.other-domain.test/x" ]] && ok "...and http goes to https" || bad "http zz.other-domain.test: $r"
r=$(curl -sk -o "$T/body" -w '%{http_code}' --max-time 5 --resolve "zz.$D:$HTTPS:127.0.0.1" "https://zz.$D:$HTTPS/")
[[ $r == 404 ]] && grep -q "on $D" "$T/body" && ok "the home domain's catch-all as before" || bad "zz.$D: $r"

echo "--- Cloudflare in front (S6): CF-Connecting-IP believed from Cloudflare's ranges only"
# seen <from> <name> <path>: the address the access log has for that request (the harness's
# own "Cloudflare" is 127.0.0.2, added to the real ranges; anyone else is 127.0.0.1)
seen() {
    curl -sk -o /dev/null --max-time 5 --interface "$1" -H 'CF-Connecting-IP: 203.0.113.9' \
        --resolve "$2:$HTTPS:127.0.0.1" "https://$2:$HTTPS$3" >/dev/null
    grep -F " $3 " "$T/hosts/lfdln-hosts.access.log" | tail -1 | cut -d' ' -f1
}
r=$(seen 127.0.0.2 cf-domain.test /s6-a); [[ $r == 203.0.113.9 ]] && ok "through Cloudflare: the visitor's address, from CF-Connecting-IP" || bad "through Cloudflare: logged as '$r'"
r=$(seen 127.0.0.1 cf-domain.test /s6-b); [[ $r == 127.0.0.1 ]] && ok "straight to the server: CF-Connecting-IP is ignored (nobody can name another address)" || bad "straight to the server: logged as '$r'"
r=$(seen 127.0.0.2 www.cf-domain.test /s6-c); [[ $r == 203.0.113.9 ]] && ok "www beside it too" || bad "www.cf-domain.test: logged as '$r'"
r=$(seen 127.0.0.2 "site.$D" /s6-d); [[ $r == 127.0.0.2 ]] && ok "a domain with nothing in front: the header means nothing, even from Cloudflare's addresses" || bad "site.$D: logged as '$r'"
r=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --interface 127.0.0.2 --resolve "cf-domain.test:$HTTPS:127.0.0.1" "https://cf-domain.test:$HTTPS/page.html")
[[ $r == 200 ]] && ok "...and the domain answers as before (the docs folder)" || bad "cf-domain.test/page.html: $r"

echo "--- a site folder at the top of a host"
is 200 "a host serves its folder's index.html" site /
body 'site home' && ok "...the folder's own page" || bad "site / served: $(head -c 80 "$T/body")"
is 200 "and a page in it" site /about.html
is 200 "a folder inside it, by its slash" site /sub/
r=$(get site /sub); [[ $r == "301 https://site.$D:$HTTPS/sub/" ]] && ok "without its slash it goes on to the slash" || bad "site /sub: $r"
is 403 ".git/config is refused" site /.git/config
is 403 ".env is refused" site /.env
is 404 "a symlink out of the folder isn't followed" site /link.txt
body 'outside the folder' && bad "the symlinked file was served"
r=$(get site /../outside/secret.txt); [[ ${r%% *} == 400 || ${r%% *} == 404 ]] && ok "../ can't climb out (nginx refuses it)" || bad "site /../: $r"
r=$(get site /%2e%2e/outside/secret.txt); [[ ${r%% *} == 400 || ${r%% *} == 404 ]] && ok "nor encoded (nginx refuses it)" || bad "site /%2e%2e/...: $r"
body 'outside the folder' && bad "the file outside was served"
is 404 "a page that isn't there" site /nope.html
body 'its own 404' && ok "...with the folder's own 404.html" || bad "the folder's 404 page wasn't used: $(head -c 80 "$T/body")"
is 502 "a PHP page, with Run PHP on, goes to PHP (not running here: 502, never text)" site /x.php
body 'echo' && bad "the PHP source was sent"
is 404 "x.PHP is never handed out" site /old.PHP
body 'echo' && bad "the .PHP source was sent"
is 301 "http goes on to https" site / http
# the gate on every host (docs/phase8-plan.md 8-2): the gate's answer where one runs on its
# port (this server's lfdln-gate), 502 where none does -- never the folder's 404
r=$(get site /_pammy/login.js); { [[ ${r%% *} == 200 ]] && body 'customElements'; } || [[ ${r%% *} == 502 ]] \
    && ok "/_pammy/ goes to the gate, on a host with no accounts too (${r%% *})" || bad "site /_pammy/login.js: $r"
r=$(get jump /_pammy/login.js); { [[ ${r%% *} == 200 ]] && body 'customElements'; } || [[ ${r%% *} == 502 ]] \
    && ok "...on a host that shows a redirect too (${r%% *})" || bad "jump /_pammy/login.js: $r"

echo "--- a single-page app"
is 200 "the top" spa /
is 200 "a file of it" spa /assets/app.js
is 200 "an unknown path gives index.html" spa /some/client/route
body 'spa' && ok "...its index.html" || bad "the SPA fallback served: $(head -c 80 "$T/body")"
is 200 "any unknown path, one with a dot too, gives index.html (the app's router decides)" spa /missing.png

echo "--- several routes on one host"
is 200 "the top: one folder" mixed /
body 'site home' && ok "...the site folder" || bad "mixed /: $(head -c 80 "$T/body")"
is 200 "/docs/: another folder" mixed /docs/
body 'docs home' && ok "...the docs folder" || bad "mixed /docs/: $(head -c 80 "$T/body")"
is 200 "/docs/page.html: a page of that folder" mixed /docs/page.html
body 'a docs page' && ok "...from the docs folder" || bad "mixed /docs/page.html: $(head -c 80 "$T/body")"
r=$(get mixed /docs); [[ $r == "301 https://mixed.$D:$HTTPS/docs/" || $r == "301 https://mixed.$D/docs/" ]] && ok "/docs goes on to /docs/" || bad "mixed /docs: $r"
is 404 "the docs folder's PHP isn't run (its switch is off), nor sent" mixed /docs/a.php
body 'echo' && bad "docs' PHP source was sent"
r=$(get mixed /docs/../../outside/secret.txt); [[ ${r%% *} == 400 || ${r%% *} == 404 ]] && ok "/docs/../../ can't climb out of the site folders (nginx refuses it)" || bad "mixed /docs/../../: $r"
body 'outside the folder' && bad "the file outside was served through /docs/"
is 404 "a file of the top folder isn't under /docs/" mixed /docs/about.html
r=$(get mixed '/old/a/b.html?x=1'); [[ $r == "301 https://example.com/new/a/b.html?x=1" ]] && ok "a 301 that takes the path and query along" || bad "mixed /old/a/b.html: $r"
r=$(get mixed /old); [[ $r == "301 https://example.com/new" ]] && ok "the route's own name without its slash goes to the address itself" || bad "mixed /old: $r"
r=$(get mixed /away/deep/page); [[ $r == "302 https://mixed.$D:$HTTPS/docs/" || $r == "302 https://mixed.$D/docs/" ]] && ok "a 302 that leaves the path behind" || bad "mixed /away/deep/page: $r"

echo "--- switched off, stopped, and unknown"
is 404 "a host switched off: the plain 404" off /
body 'nothing at this address' && ok "...the plain page" || bad "off / served: $(head -c 80 "$T/body")"
is 404 "a host whose only route is stopped: the plain 404" stopped /
is 404 "a name the panel doesn't serve: the plain 404, not a TLS error" nobody /
is 301 "...and its http goes to https first" nobody / http
r=$(get jump /anything); loc=$(tr -d '\r' < "$T/head" | sed -n 's/^[Ll]ocation: //p')
[[ ${r%% *} == 302 && $loc == "https://example.org" ]] && ok "a host that is only a redirect, to exactly its address" || bad "jump: $r (Location: $loc)"
r=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "a.b.$D:$HTTPS:127.0.0.1" "https://a.b.$D:$HTTPS/"); [[ $r == 000 ]] && ok "two levels deep: refused (no block, no certificate for it)" || bad "a.b.$D answered $r"

echo "--- the routing helper's apply, on a second nginx (docs/hosts-plan.md step 2)"
AHTTP=18181 AHTTPS=18544
mkdir -p "$T/applied"
: > "$T/applied/site.conf"
cat > "$T/nginx-applied.conf" <<EOF
worker_processes 1; pid $T/nginx-applied.pid; error_log $T/error-applied.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    server { listen 127.0.0.1:$AHTTPS ssl default_server; ssl_reject_handshake on; }
    include $T/applied/site.conf;
}
EOF
nginx -p "$T" -c "$T/nginx-applied.conf" -e "$T/error-applied.log"
apply() { node --disable-warning=ExperimentalWarning "$P/test/hosts-apply.ts" "$T" "$S" "$AHTTP" "$AHTTPS" "$T/cert.pem" "$T/key.pem" "$1"; }
aget() {  # aget <host> <want>: the status, once the reload has been taken up (or the last one seen)
    local code
    for _ in $(seq 30); do
        code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 --resolve "$1.$D:$AHTTPS:127.0.0.1" "https://$1.$D:$AHTTPS/")
        [[ $code == "$2" ]] && break; sleep 0.2
    done
    echo "$code"
}
r=$(apply one); [[ $r == *'"reloaded":true'* ]] && ok "apply writes the files, nginx -t says yes, nginx reloads" || bad "apply one: $r"
[[ $(aget live 200) == 200 ]] && ok "...and the new host answers" || bad "live didn't answer after apply"
cp "$T/applied/hosts/live.conf" "$T/live.before"
r=$(apply bad); [[ $r == *'"error":"refused"'* && $r == *'put back as it was'* ]] && ok "a change nginx -t refuses (a certificate that isn't there) is refused" || bad "apply bad: $r"
cmp -s "$T/live.before" "$T/applied/hosts/live.conf" && ok "...its files are put back byte for byte" || bad "live.conf changed after a refused apply"
[[ ! -e $T/applied/hosts/fresh.conf ]] && ok "...the host it would have added isn't left behind" || bad "fresh.conf was left behind"
[[ $(aget live 200) == 200 ]] && ok "...and the live host goes on answering" || bad "live stopped answering after a refused apply"
r=$(apply two); [[ $r == *'"hosts/fresh.conf"'* && $r == *'"reloaded":true'* ]] && ok "a good change after it goes through" || bad "apply two: $r"
[[ $(aget fresh 200) == 200 ]] && ok "...the host it adds answers after the reload" || bad "fresh didn't answer after apply two"
r=$(apply two); [[ $r == '{"changed":[],"removed":[],"reloaded":false}' ]] && ok "the same again: nothing written, nginx not asked" || bad "apply two again: $r"
r=$(apply one); [[ $r == *'"removed":["hosts/fresh.conf"]'* ]] && ok "a host that goes: its file removed" || bad "apply one after two: $r"
[[ $(aget fresh 404) == 404 ]] && ok "...and it answers the plain 404 after the reload" || bad "fresh still answers after its removal"

echo "--- the renderer refuses what could break out of a file"
node --disable-warning=ExperimentalWarning --input-type=module -e '
import { renderAll } from "@panel/hosts/render";
const cfg = { domain: "lesfleursdelanuit.com", dir: "/etc/nginx/lfdln-hosts", sitesRoot: "/var/www/x", tls: { cert: "/c", key: "/k" }, php: null, logs: "/var/log/nginx" };
const base = { hosts: [{ name: "a", enabled: true }], folders: [{ name: "f", runPhp: false }] };
const tries = {
  "a host name with a space": { ...base, hosts: [{ name: "a b", enabled: true }], routes: [] },
  "www": { ...base, hosts: [{ name: "www", enabled: true }], routes: [] },
  "a path with a quote": { ...base, routes: [{ host: "a", path: "/x\"/", enabled: true, kind: "folder", folder: "f", spa: false }] },
  "a path with ..": { ...base, routes: [{ host: "a", path: "/../", enabled: true, kind: "folder", folder: "f", spa: false }] },
  "a redirect with a $": { ...base, routes: [{ host: "a", path: "/", enabled: true, kind: "redirect", to: "https://x.com/$host", status: 301, keepPath: false }] },
  "a redirect with a ;": { ...base, routes: [{ host: "a", path: "/", enabled: true, kind: "redirect", to: "https://x.com/a;b", status: 301, keepPath: false }] },
  "a folder that is not there": { ...base, routes: [{ host: "a", path: "/", enabled: true, kind: "folder", folder: "g", spa: false }] },
  "two routes at one path": { ...base, routes: [1, 2].map(() => ({ host: "a", path: "/", enabled: true, kind: "folder", folder: "f", spa: false })) },
};
let bad = 0;
for (const [what, t] of Object.entries(tries)) {
  try { renderAll(cfg, t); console.log("  FAIL  rendered " + what); bad++; } catch { console.log("  ok    refuses " + what); }
}
process.exit(bad);
' && pass=$((pass+8)) || { fail=$((fail+1)); }

echo
echo "  hosts nginx test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
