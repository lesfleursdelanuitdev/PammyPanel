#!/usr/bin/env bash
# Git over HTTPS (docs/phase8b-plan.md 8b-7): the REAL git site file (rendered from lfdln's
# profile, packages/projects/nginx/git.conf) on a throwaway unprivileged nginx, with the real
# git-http-backend behind it (test/fcgi-cgi.ts stands in for fcgiwrap, which needs sudo) and a
# stand-in for the panel's check, as momolig with no sudo. Real git clones and pushes through it.
#   test/run-git-nginx-test.sh
#
# The panel's check itself is tested through the panel (test/e2e-lfdln/16-projects.spec.ts);
# fcgiwrap as svc-lfdln-apps with the panel's real check, on the server (verify-lfdln.sh).
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
HTTPS=18453 AUTH=13153
HOST=git.lesfleursdelanuit.com
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    [[ -n ${fcgi_pid:-} ]] && kill "$fcgi_pid" 2>/dev/null
    [[ -n ${auth_pid:-} ]] && kill "$auth_pid" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT

# --- the panel's check, stood in for: "owner-token" is ann's (may push), "reader-token" bob's
# (may read). It answers with the token's person, whatever user name git typed (as the panel
# does after checking they match: here they needn't, to show where REMOTE_USER comes from).
cat > "$T/auth.mjs" <<'EOF'
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [port, log] = process.argv.slice(2);
createServer((req, res) => {
  const uri = req.headers['x-original-uri'] ?? '';
  appendFileSync(log, `${JSON.stringify({ method: req.method, url: req.url, uri, length: req.headers['content-length'] ?? null })}\n`);
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  const token = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  const push = /git-receive-pack/.test(uri);
  const who = token === 'owner-token' ? 'ann' : token === 'reader-token' ? 'bob' : null;
  if (!who) { res.writeHead(401).end(); return; }
  if (push && who !== 'ann') { res.writeHead(403).end(); return; }
  res.writeHead(204, { 'X-Lfdln-Git-User': who }).end();
}).listen(Number(port), '127.0.0.1');
EOF
node "$T/auth.mjs" "$AUTH" "$T/auth.log" & auth_pid=$!
node --disable-warning=ExperimentalWarning "$P/test/fcgi-cgi.ts" "$T/git.sock" "$T/params.log" > "$T/fcgi.log" 2>&1 & fcgi_pid=$!

# --- a project's repository, as the helper makes it (bare, main and dev)
mkdir -p "$T/srv/site" "$T/work"
git init -q --bare -b main "$T/srv/site/repo.git"
git -C "$T/srv/site/repo.git" config receive.denyDeletes true
git -C "$T/work" init -q -b main
git -C "$T/work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
git -C "$T/work" push -q "$T/srv/site/repo.git" main main:dev

# --- the git site, rendered and pointed at the throwaway parts
node --disable-warning=ExperimentalWarning "$P/tools/render-nginx.ts" "$T/rendered" --site lfdln >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -subj "/CN=$HOST" -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null
sed -e "s#/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/fullchain.pem#$T/cert.pem#; s#/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com/privkey.pem#$T/key.pem#" \
    -e "/include \/etc\/letsencrypt\//d; /ssl_dhparam/d" \
    -e "s#/var/log/nginx/#$T/#g" \
    -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:18089;#; s#^\(\s*\)listen 443 ssl;#\1listen 127.0.0.1:$HTTPS ssl;#" -e '/listen \[::\]/d' \
    -e "s#http://127.0.0.1:[0-9]*/api/projects/git-auth#http://127.0.0.1:$AUTH/api/projects/git-auth#" \
    -e "s#unix:/run/lfdln-git-http.sock#unix:$T/git.sock#" \
    -e "s#GIT_PROJECT_ROOT     /srv/lfdln-projects#GIT_PROJECT_ROOT     $T/srv#" \
    -e "s#/etc/nginx/lfdln-panel/edge.conf#$T/edge.conf#" \
    "$T/rendered/site/git.conf" > "$T/git.conf"
# nginx's edge secret (docs/s1-plan.md S1c), as the installer writes it
( umask 077; printf 'proxy_set_header X-Lfdln-Edge "%s";\n' "$(openssl rand -hex 32)" > "$T/edge.conf" )
grep -q "unix:$T/git.sock" "$T/git.conf" && grep -q "127.0.0.1:$AUTH/api/projects/git-auth" "$T/git.conf" && grep -q "GIT_PROJECT_ROOT     $T/srv" "$T/git.conf" \
    || { bad "couldn't point the rendered git site at the test's parts"; exit 1; }
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    include $T/git.conf;
}
EOF
if nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log" 2>"$T/nginx-t"; then ok "nginx accepts the git site as rendered"; else bad "nginx -t: $(cat "$T/nginx-t")"; exit 1; fi
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"
for _ in $(seq 50); do [[ -S $T/git.sock ]] && curl -sk -o /dev/null --resolve "$HOST:$HTTPS:127.0.0.1" "https://$HOST:$HTTPS/" && break; sleep 0.1; done

URL="https://$HOST:$HTTPS"
g() { git -c http.sslVerify=false -c "http.curloptResolve=$HOST:$HTTPS:127.0.0.1" -c credential.helper= "$@"; }
c() { curl -sk --resolve "$HOST:$HTTPS:127.0.0.1" "$@"; }

# --- no token: 401 with a Basic challenge, so git asks for one
h=$(c -D - -o /dev/null "$URL/site.git/info/refs?service=git-upload-pack")
[[ $h == *" 401"* && $h == *'WWW-Authenticate: Basic realm="git.lesfleursdelanuit.com'* ]] && ok "no token: 401 and a Basic challenge" || bad "no token: $h"
GIT_TERMINAL_PROMPT=0 g clone -q "$URL/site.git" "$T/none" 2>/dev/null && bad "cloned without a token" || ok "git can't clone without a token"
[[ $(c -o /dev/null -w '%{http_code}' -u bob:wrong "$URL/site.git/info/refs?service=git-upload-pack") == 401 ]] && ok "a wrong token: 401" || bad "a wrong token isn't 401"

# --- reading: a reader clones (protocol v2), sees dev too
if GIT_TERMINAL_PROMPT=0 g clone -q "https://bob:reader-token@$HOST:$HTTPS/site.git" "$T/bob" 2>"$T/clone.err"; then
    ok "a reader's token clones it"
else
    bad "a reader couldn't clone: $(cat "$T/clone.err")"
fi
[[ $(g -C "$T/bob" ls-remote --heads origin 2>/dev/null | wc -l) == 2 ]] && ok "...main and dev are there" || bad "ls-remote: $(g -C "$T/bob" ls-remote origin 2>&1)"

# --- pushing: the reader is refused, the owner's push lands
g -C "$T/bob" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
GIT_TERMINAL_PROMPT=0 g -C "$T/bob" push -q origin main 2>"$T/push.err" && bad "a reader pushed" || ok "a reader's push is refused"
[[ $(cat "$T/push.err") == *403* ]] && ok "...with 403" || bad "...not 403: $(cat "$T/push.err")"
# the owner's token, typed with somebody else's name: the name REMOTE_USER gets is the check's
g -C "$T/bob" remote set-url origin "https://mallory:owner-token@$HOST:$HTTPS/site.git"
if GIT_TERMINAL_PROMPT=0 g -C "$T/bob" push -q origin main 2>"$T/push2.err"; then ok "the owner's token pushes"; else bad "the owner couldn't push: $(cat "$T/push2.err")"; fi
[[ $(git -C "$T/srv/site/repo.git" rev-parse main) == $(git -C "$T/bob" rev-parse HEAD) ]] && ok "...main moved in the repository" || bad "main didn't move"
GIT_TERMINAL_PROMPT=0 g -C "$T/bob" push -q origin :dev 2>/dev/null && bad "a branch deleted over HTTPS" || ok "...a branch can't be deleted (receive.denyDeletes holds)"

# --- what git-http-backend was given (every request's params, from the stand-in)
node -e '
const fs = require("fs");
const reqs = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const say = (good, what) => console.log(`${good ? "ok" : "FAIL"} ${what}`);
say(reqs.length >= 4, `${reqs.length} requests reached git-http-backend`);
say(reqs.every((r) => !Object.keys(r).some((k) => /AUTHORIZATION|COOKIE/i.test(k))), "no request handed git the Authorization header (the token)");
say(reqs.every((r) => Object.keys(r).every((k) => !k.startsWith("HTTP_") || k === "HTTP_CONTENT_ENCODING" || k === "HTTP_GIT_PROTOCOL")), "...nor any other header but Content-Encoding and Git-Protocol");
say(reqs.every((r) => r.SCRIPT_FILENAME === "/usr/lib/git-core/git-http-backend"), "the script is always git-http-backend");
say(reqs.every((r) => /^\/site\/repo\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(r.PATH_INFO)), "PATH_INFO is always /<project>/repo.git/...");
const pushes = reqs.filter((r) => /receive-pack/.test(r.PATH_INFO + r.QUERY_STRING));
say(pushes.length > 0 && pushes.every((r) => r.REMOTE_USER === "ann"), "a push runs as the name the check answered (ann), never the one typed (mallory)");
say(reqs.every((r) => r.REMOTE_USER === "ann" || r.REMOTE_USER === "bob"), "REMOTE_USER is never empty or the typed name");
say(reqs.some((r) => r.HTTP_GIT_PROTOCOL === "version=2"), "git protocol v2 reaches it (Git-Protocol)");
' "$T/params.log" > "$T/params.out"
while read -r verdict rest; do [[ $verdict == ok ]] && ok "$rest" || bad "$rest"; done < "$T/params.out"

# --- what the check was asked: never a body, always the original path
node -e '
const reqs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ok = reqs.length > 0 && reqs.every((r) => r.method === "GET" && r.url === "/api/projects/git-auth" && /^\/site\.git\//.test(r.uri) && (r.length === null || r.length === "0"));
console.log(ok ? "ok" : "FAIL", JSON.stringify(reqs.slice(0, 2)));
' "$T/auth.log" | { read -r v rest; [[ $v == ok ]] && ok "the check gets a GET with the original path and no body" || bad "the check was asked: $rest"; }

# --- nothing else is served
for path in /site.git/HEAD /site.git/objects/info/packs /site.git/config /site/repo.git/info/refs / /api/projects/git-auth /_auth; do
    code=$(c -o /dev/null -w '%{http_code}' -u ann:owner-token "$URL$path")
    [[ $code == 404 ]] && ok "$path: 404" || bad "$path: $code (not 404)"
done
[[ $(c -o /dev/null -w '%{http_code}' -u ann:owner-token "$URL/Site.git/info/refs?service=git-upload-pack") == 404 ]] && ok "a name no project can have: 404" || bad "an odd name got through"

echo
echo "  $pass passed, $fail failed"
(( fail == 0 ))
