# nginx's edge secret (docs/s1-plan.md S1c), for both verify scripts (sourced; they have
# ok, bad, t_ok and $APP). Root only, the same in the secret and nginx's include, in every
# location to the panel and the gate and nowhere else, and believed: X-Real-IP from this
# machine counts only with it.
#
# The secret never goes on a command line (/proc/<pid>/cmdline is anyone's to read, and it
# is never rotated): compared in bash, and handed to curl as a config on stdin (-K -, a
# here-string), never -H. test/edge-secret.test.ts runs these with every command they call
# recording its arguments, and fails if the secret is among them.
#   verify_edge <etc> <nginx folder> <panel unit> <panel port> <gate unit> <gate port> <panel host> <site domain>
#   ... the rest of verify ...
#   verify_edge_limits <etc> <panel port> <gate port> <panel host> <site domain>     (last: see there)
verify_edge() {
    local etc=$1 ngx=$2 punit=$3 pport=$4 gunit=$5 gport=$6 phost=$7 domain=$8
    local secret=$etc/edge.secret conf=$ngx/edge.conf edge out i last files
    t_ok "the edge secret is root's alone ($secret, 600)"     test "$(stat -c '%U:%G %a' "$secret" 2>/dev/null)" = "root:root 600"
    t_ok "nginx's include is root's alone ($conf, 600)"       test "$(stat -c '%U:%G %a' "$conf" 2>/dev/null)" = "root:root 600"
    edge=$(tr -d '\n' < "$secret" 2>/dev/null)
    if [[ ! $edge =~ ^[0-9a-f]{64}$ ]]; then bad "the edge secret isn't 64 hex characters"; return; fi
    if [[ $(grep -v '^#' "$conf" 2>/dev/null) == "proxy_set_header X-Lfdln-Edge \"$edge\";" ]]; then ok "the include says the same secret, and nothing else"
    else bad "$conf doesn't say the secret in $secret (the installer writes it from there)"; fi
    # every file nginx might read (each *.conf under /etc/nginx, and sites-available)
    mapfile -t files < <({ find /etc/nginx -name '*.conf' -type f; find /etc/nginx/sites-available -type f; } | LC_ALL=C sort -u)
    if out=$(/usr/bin/node --disable-warning=ExperimentalWarning "$APP/tools/edge-check.ts" "$conf" "$pport,$gport" "${files[@]}" 2>&1); then
        ok "every location to the panel and the gate sends it, and nothing else in nginx does (${#files[@]} files, $out)"
    else
        bad "the edge secret in nginx's files:"; sed 's/^/        /' <<<"$out"
    fi
    # as running now: systemd's copy of it for the service (LoadCredential), and no hold left
    t_ok "$punit has it (LoadCredential)"                     cmp -s "/run/credentials/$punit.service/edge.secret" "$secret"
    t_ok "$gunit has it (LoadCredential)"                     cmp -s "/run/credentials/$gunit.service/edge.secret" "$secret"
    t_no "no installer's hold left on them (s1c-first.conf)"  sh -c "ls /run/systemd/system/$punit.service.d/s1c-first.conf /run/systemd/system/$gunit.service.d/s1c-first.conf 2>/dev/null | grep -q ."
    # with it, a made-up X-Real-IP straight to them counts as that visitor: 31 of them, a
    # bad key each, never run out the gate's limit for bad keys (30 a minute each); 21
    # never run out the panel's for sign-in checks (20 in 15 minutes each)
    for i in $(seq 1 31); do
        last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - -H "Host: $domain" -H 'X-Pammy-Base: /' -H "X-Real-IP: 192.0.2.$((100 + i))" \
            -H "Authorization: Bearer pammy_zzverifyedge$i" "http://127.0.0.1:$gport/_pammy/api/media/main" <<<"header = \"X-Lfdln-Edge: $edge\"")
        [[ $last == 429 ]] && break
    done
    [[ $last == 401 ]] && ok "the gate: X-Real-IP with the secret is believed (31 made-up visitors, each its own limit)" || bad "the gate with the secret: $last after $i"
    for i in $(seq 1 21); do
        last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - -X POST -H "Origin: https://$phost" -H 'Content-Type: application/json' \
            -H "X-Real-IP: 192.0.2.$((100 + i))" --data '{}' "http://127.0.0.1:$pport/api/login/verify" <<<"header = \"X-Lfdln-Edge: $edge\"")
        [[ $last == 429 ]] && break
    done
    [[ $last == 400 ]] && ok "the panel: X-Real-IP with the secret is believed (21 made-up visitors)" || bad "the panel with the secret: $last after $i"
}

# Without it, the same made-up X-Real-IPs all count as this machine, so the limit runs out.
# That leaves this machine's own limits used up (the gate's bad keys for a minute, the
# panel's sign-in checks for 15), so it runs LAST, after every other check that asks the
# gate or the panel from here without the secret (review L5).
verify_edge_limits() {
    local pport=$2 gport=$3 phost=$4 domain=$5 i last
    for i in $(seq 1 31); do
        last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $domain" -H 'X-Pammy-Base: /' -H "X-Real-IP: 192.0.2.$((150 + i))" \
            -H "Authorization: Bearer pammy_zzverifyedge$i" "http://127.0.0.1:$gport/_pammy/api/media/main")
        [[ $last == 429 ]] && break
    done
    [[ $last == 429 ]] && ok "the gate: a made-up X-Real-IP without the edge secret isn't believed (one limit for them all, 429 by the 31st)" || bad "the gate without the secret: $last after 31"
    for i in $(seq 1 21); do
        last=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H "Origin: https://$phost" -H 'Content-Type: application/json' \
            -H "X-Real-IP: 192.0.2.$((150 + i))" --data '{}' "http://127.0.0.1:$pport/api/login/verify")
        [[ $last == 429 ]] && break
    done
    [[ $last == 429 ]] && ok "the panel: a made-up X-Real-IP without the edge secret isn't believed (429 by the 21st)" || bad "the panel without the secret: $last after 21"
}
