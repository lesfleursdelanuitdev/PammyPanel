# nginx's edge secret (docs/s1-plan.md S1c), for both sites' installers (sourced; they have
# say and die). nginx adds X-Lfdln-Edge from a root-only include to everything it sends the
# panel and the gate, and they believe X-Real-IP only with it (review S1: anyone on this
# machine could otherwise say they were any visitor). Made once and kept, never printed;
# the services have it by LoadCredential, and nginx's include is written from it every
# install, so the two always agree.
#   make_edge_secret /etc/pammy-panel /etc/nginx/pammy-panel
make_edge_secret() {
    local etc=$1 ngx=$2 secret conf edge
    secret=$etc/edge.secret conf=$ngx/edge.conf
    if [[ ! -s $secret ]]; then
        ( umask 077; openssl rand -hex 32 > "$secret.new" ) || die "couldn't make nginx's edge secret"
        chown root:root "$secret.new"; chmod 600 "$secret.new"
        mv "$secret.new" "$secret"
        say ok "made nginx's edge secret ($secret)"
    fi
    chown root:root "$secret"; chmod 600 "$secret"    # every install, not only the first
    edge=$(tr -d '\n' < "$secret")
    [[ $edge =~ ^[0-9a-f]{64}$ ]] || die "$secret isn't 64 hex characters: move it aside and install again"
    install -d -o root -g root -m 755 "$ngx"
    ( umask 077; printf '# from %s by the installer (docs/s1-plan.md S1c): root only, never by hand\nproxy_set_header X-Lfdln-Edge "%s";\n' "$secret" "$edge" > "$conf.new" ) \
        || die "couldn't write $conf"
    chown root:root "$conf.new"; chmod 600 "$conf.new"
    if cmp -s "$conf.new" "$conf"; then rm -f "$conf.new"; else mv "$conf.new" "$conf"; fi
    say ok "nginx's edge secret: $conf, from $secret (both root-only)"
}

# Every file nginx might read: each *.conf under /etc/nginx, and sites-available (the
# verify scripts and edge_hold/edge_release check them all; the edge file itself is
# skipped by the check).
edge_nginx_files() {
    { find /etc/nginx -name '*.conf' -type f; find /etc/nginx/sites-available -type f; } | LC_ALL=C sort -u
}

# Does nginx send the secret everywhere it should, now? (tools/edge-check.ts over the live files)
#   edge_sent <node tools folder> <etc> <nginx folder> <panel port> <gate port>   -> 0 yes, 1 no (problems on stdout)
edge_sent() {
    local tools=$1 ngx=$3 pport=$4 gport=$5 files
    mapfile -t files < <(edge_nginx_files)
    /usr/bin/node --disable-warning=ExperimentalWarning "$tools/edge-check.ts" "$ngx/edge.conf" "$pport,$gport" "${files[@]}"
}

# The first S1c install (L1 of the review): the services would load the secret before nginx
# sends it, and every visitor would be 127.0.0.1 until nginx reloads. So while nginx's live
# files don't send it yet, a runtime drop-in holds the panel and the gate on the old way
# (<PREFIX>_EDGE=off, core/src/security.ts loadEdgeSecret) through the restarts, and
# edge_release takes it away once nginx does. Runtime (/run): a reboot drops it, which is
# why a stopped install says to re-run before one.
#   edge_hold <tools> <etc> <nginx folder> <panel unit> <panel port> <gate unit> <gate port>
EDGE_HELD=no
edge_hold() {
    local tools=$1 etc=$2 ngx=$3 punit=$4 pport=$5 gunit=$6 gport=$7 u d unit prefix
    if edge_sent "$tools" "$etc" "$ngx" "$pport" "$gport" >/dev/null 2>&1; then
        say ok "nginx already sends the edge secret: the panel and the gate use it from their restart"
        return
    fi
    for u in "$punit PANEL" "$gunit GATE"; do
        read -r unit prefix <<<"$u"
        d=/run/systemd/system/$unit.service.d
        install -d -o root -g root -m 755 "$d"
        printf '# deploy/edge-secret.sh edge_hold: until nginx sends the edge secret (docs/s1-plan.md S1c)\n[Service]\nEnvironment=%s_EDGE=off\n' "$prefix" > "$d/s1c-first.conf"
    done
    systemctl daemon-reload
    EDGE_HELD=yes
    say note "nginx doesn't send the edge secret yet: $punit and $gunit stay on the old way (any local X-Real-IP) until it does, later in this install"
}

# Once nginx sends it: the hold away, and the panel and the gate restarted onto the secret.
# Not everywhere yet: the install stops, the hold stays (edge_die_note says what to do).
#   edge_release <tools> <etc> <nginx folder> <panel unit> <panel port> <gate unit> <gate port>
edge_release() {
    local tools=$1 etc=$2 ngx=$3 punit=$4 pport=$5 gunit=$6 gport=$7 out i code port
    [[ $EDGE_HELD == yes ]] || return 0
    if ! out=$(edge_sent "$tools" "$etc" "$ngx" "$pport" "$gport" 2>&1); then
        sed 's/^/        /' <<<"$out" >&2
        die "nginx's live files still don't send the edge secret everywhere they should (above)"
    fi
    rm -f "/run/systemd/system/$punit.service.d/s1c-first.conf" "/run/systemd/system/$gunit.service.d/s1c-first.conf"
    rmdir "/run/systemd/system/$punit.service.d" "/run/systemd/system/$gunit.service.d" 2>/dev/null || true
    systemctl daemon-reload
    systemctl restart "$gunit" "$punit"
    for port in "$gport" "$pport"; do
        for i in $(seq 60); do
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null)
            [[ $code != 000 ]] && break
            sleep 0.5
        done
        [[ $code != 000 ]] || die "nothing answers on 127.0.0.1:$port after the restart onto the edge secret (journalctl -u $gunit -u $punit)"
    done
    EDGE_HELD=no
    say ok "nginx sends the edge secret everywhere: $punit and $gunit restarted onto it"
}

# What a stopped install leaves, for die (both installers call it when it is defined)
edge_die_note() {
    [[ $EDGE_HELD == yes ]] || return 0
    say note "the edge secret: the panel and the gate are still held on the old way (s1c-first.conf in /run/systemd/system/<unit>.service.d), so visitors keep their own IPs. Re-run the installer, or roll back: both are safe. A reboot drops the hold, so do it before one."
}
