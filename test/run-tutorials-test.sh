#!/usr/bin/env bash
# The four tutorials (docs/tutorials-plan.md T2), end to end, as momolig with
# no sudo: the files in tutorials/ copied where guides 15-18 say to put them,
# behind the REAL pamela vhost + gate snippets (PHP included) on a throwaway
# nginx, the REAL php-fpm pool and php.ini in PHP 8.3, the REAL gate with the
# databases the guides tell her to draw (test/tutorials-world.ts) -- and a
# browser doing what the guides tell her to do (test/tutorials-browser.ts).
#   test/run-tutorials-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
WP="$(readlink -f "$P/../wordpress")"
T=$(mktemp -d)
NPORT=18280 GPORT=13245 WHOPORT=13246
PHPNAME=pammy-php-tutorials-$$ PHPIMAGE=docker.io/library/php:8.3-fpm
cleanup() {
    [[ -s $T/nginx.pid ]] && nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log" -s stop 2>/dev/null
    podman rm -f -t 1 --ignore "$PHPNAME" >/dev/null 2>&1
    # the world's Postgres test container goes with it (removed by name)
    [[ -n ${world_pid:-} ]] && kill "$world_pid" 2>/dev/null && wait "$world_pid" 2>/dev/null
    [[ -n ${who_pid:-} ]] && kill "$who_pid" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT
# pulled when missing (a prune of old images must not break the test)
podman image exists "$PHPIMAGE" || podman pull -q "$PHPIMAGE" >/dev/null 2>&1 || { echo "no $PHPIMAGE image, and it couldn't be pulled"; exit 1; }

# ---------------------------------------------------------------- her website, with the tutorials where the guides put them
pub=$T/public
mkdir -p "$pub"
echo HOME > "$pub/index.html"; echo MAIN404 > "$pub/404.html"
for t in journal journal-php todo todo-php; do cp -r "$P/tutorials/$t" "$pub/$t"; done

# ---------------------------------------------------------------- the gate and her databases
node --disable-warning=ExperimentalWarning "$P/test/tutorials-world.ts" "$T" "$pub" "$GPORT" > "$T/world.log" 2>&1 &
world_pid=$!
for _ in $(seq 300); do [[ -s $T/world.json ]] && break; sleep 0.1; done
[[ -s $T/world.json ]] || { echo "the tutorials' world didn't start:"; cat "$T/world.log"; exit 1; }
# guide 18 PART 3: the key goes into settings.php
key=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).todoKey)' "$T/world.json")
sed -i "s#PUT-YOUR-KEY-HERE#$key#" "$pub/todo-php/settings.php"

# ---------------------------------------------------------------- the panel's tutorial examples (docs/tutorial-examples-plan.md)
# their copies, written by the panel's own src/tutorial-demos.ts with the examples' key
mkdir -p "$T/examples"
exkey=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).exampleKey)' "$T/world.json")
node --disable-warning=ExperimentalWarning --input-type=module -e "
  const m = await import('$P/src/tutorial-demos.ts');
  m.writeDemos('$T/examples', m.demoFiles('$P/tutorials', '$exkey'));" || { echo "couldn't write the examples' copies"; exit 1; }
# a probe beside them: what a page in the examples' pool is told, and can reach
cat > "$T/examples/journal-php/probe.php" <<PHP
<?php
header('Content-Type: text/plain');
echo 'user=[' . (\$_SERVER['PAMMY_USER'] ?? '') . "]\n";
echo 'cookie=[' . (\$_SERVER['HTTP_COOKIE'] ?? '') . "]\n";
echo 'website=' . (@file_get_contents('$pub/index.html') === false ? 'no' : 'yes') . "\n";
echo 'own=' . (@file_get_contents(__DIR__ . '/api.php') === false ? 'no' : 'yes') . "\n";
PHP
# the panel's "who is signed in" (src/app.ts /api/tutorial-examples/who), stood in
# for: the cookie panel=<name> is that account, and no cookie is nobody
node -e '
  require("http").createServer((req, res) => {
    const m = /(?:^|; )panel=([a-z]+)/.exec(req.headers.cookie || "");
    if (req.url !== "/api/tutorial-examples/who" || !m) { res.writeHead(401); return res.end(); }
    res.writeHead(204, { "X-Panel-User": m[1] }); res.end();
  }).listen(Number(process.argv[1]), "127.0.0.1");' "$WHOPORT" &
who_pid=$!

# ---------------------------------------------------------------- PHP: the real pool and php.ini
mkdir -p "$T/phprun" "$T/phptmp"
sed -e "s#/tmp/\?\$#$T/phptmp/#; s#= /tmp\$#= $T/phptmp#" -e "s#/run/pammy-php/#$T/phprun/#g" -e "s#/run/pammy-gate-php.sock#$T/php.sock#" -e "s#/pamela/public/#$pub/#" \
    -e "s#/var/lib/pammy-tutorial-examples/#$T/examples/#" \
    -e 's#^error_log = syslog#error_log = /proc/self/fd/2#' -e '/^listen.group/d' "$P/deploy/php/php-fpm.conf" > "$T/php-fpm.conf"
podman run -d --name "$PHPNAME" --network none --userns=keep-id --user "$(id -u):$(id -g)" \
    -v "$T:$T" -v "$P/deploy/php/php.ini:/etc/pammy-php/php.ini:ro" \
    "$PHPIMAGE" php-fpm -F -O -y "$T/php-fpm.conf" -c /etc/pammy-php/php.ini >/dev/null
for _ in $(seq 50); do [[ -S $T/phprun/fpm.sock && -S $T/phprun/examples.sock ]] && break; sleep 0.1; done
[[ -S $T/phprun/fpm.sock && -S $T/phprun/examples.sock ]] || { echo "PHP-FPM didn't start:"; podman logs "$PHPNAME" 2>&1 | tail -20; exit 1; }

# ---------------------------------------------------------------- nginx: the real config, made runnable here
mkdir -p "$T"/{gate,panelinc,wpinc,render}
# the files the installer writes, rendered from pammy.org's profile (docs/adapters-plan.md A4)
node --disable-warning=ExperimentalWarning "$P/tools/render-nginx.ts" "$T/rendered" --extra-range 127.0.0.1/32 >/dev/null
mkdir -p "$T/panelinc" && cp "$T/rendered/panel/cloudflare-realip.conf" "$T/rendered/panel/cloudflare-ips.geo" "$T/panelinc/"
# nginx's edge secret (docs/s1-plan.md S1c): the gate here has none, so it believes any local caller
( umask 077; printf 'proxy_set_header X-Lfdln-Edge "%s";\n' "$(openssl rand -hex 32)" > "$T/panelinc/edge.conf" )
sed -e "s#127.0.0.1:3045#127.0.0.1:$GPORT#" -e "s#/etc/nginx/pammy-panel#$T/panelinc#" -e "s#/etc/nginx/pammy-gate#$T/gate#g" "$T/rendered/gate/gate.conf" > "$T/gate/gate.conf"
cp "$T/rendered/gate/uri.conf" "$T/gate/"
sed -e "s#127.0.0.1:3044#127.0.0.1:$WHOPORT#" -e "s#/etc/nginx/pammy-panel#$T/panelinc#" -e "s#/var/lib/pammy-tutorial-examples/#$T/examples/#" -e "s#/run/pammy-php/#$T/phprun/#" \
    "$T/rendered/panel/tutorial-examples.conf" > "$T/panel-examples.conf"
sed -e "s#/etc/nginx/pammy-gate#$T/gate#g" -e "s#/run/pammy-php/#$T/phprun/#" "$T/rendered/gate/php.conf" > "$T/gate/php.conf"
bash -c "source '$WP/lib.sh'; render_placement off '' '$T/render' https://pammy.org/blog"
to_test() {
    sed -e "s#/etc/nginx/pammy-gate#$T/gate#g" \
        -e "s#/etc/nginx/pammy-wordpress#$T/wpinc#g" \
        -e "s#/pamela/public#$pub#g" \
        -e "s#/var/log/nginx/#$T/#g" \
        -e "s#^\(\s*\)listen 80;#\1listen 127.0.0.1:$NPORT;#" \
        -e '/listen \[::\]/d; /listen 443/d; /ssl_certificate/d; /letsencrypt/d; /ssl_dhparam/d'
}
for f in main.conf server.conf; do to_test < "$T/render/$f" > "$T/wpinc/$f"; done
to_test < "$WP/pamela-live-wp.nginx" > "$T/vhost.conf"
cat > "$T/nginx.conf" <<EOF
worker_processes 1; pid $T/nginx.pid; error_log $T/error.log;
events {}
http {
    access_log off;
    client_body_temp_path $T; proxy_temp_path $T; fastcgi_temp_path $T; uwsgi_temp_path $T; scgi_temp_path $T;
    include $T/vhost.conf;
    # panel.pammy.org, with only the examples' PHP pages: the rest is the panel's
    server {
        listen 127.0.0.1:$NPORT;
        server_name panel.pammy.org;
        include $T/panel-examples.conf;
        location / { return 418; }
    }
}
EOF
nginx -t -q -p "$T" -c "$T/nginx.conf" -e "$T/error.log" || { cat "$T/error.log"; exit 1; }
nginx -p "$T" -c "$T/nginx.conf" -e "$T/error.log"
sleep 0.5

# ---------------------------------------------------------------- what the guides tell her to do, in a browser
node --disable-warning=ExperimentalWarning "$P/test/tutorials-browser.ts" "$NPORT" "$pub" "$T/examples" "$T/admin.sock"
code=$?
if (( code != 0 )); then
    echo "--- gate:"; tail -20 "$T/world.log"
    echo "--- PHP:"; podman logs "$PHPNAME" 2>&1 | tail -20
    echo "--- nginx:"; tail -20 "$T/error.log"
fi
exit $code
