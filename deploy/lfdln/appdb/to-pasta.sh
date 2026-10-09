#!/usr/bin/env bash
# An app's containers onto pasta (docs/s1-plan.md S1f (c)), as the projects went in S1d: each
# container its own address, the host's 127.0.0.1 not reachable at 10.0.2.2 any more, and of
# the host's ports only those it uses forwarded to its own 127.0.0.1 (-T). Its addresses at
# 10.0.2.2 (database URLs in its secrets, API URLs in its Quadlets) told 127.0.0.1, same port.
#
#   sudo deploy/lfdln/appdb/to-pasta.sh <app> plan     what it would change, and whether it can (changes nothing)
#   sudo deploy/lfdln/appdb/to-pasta.sh <app> switch   stopped, its files and secrets changed, started, checked
#   sudo deploy/lfdln/appdb/to-pasta.sh <app> back     the way back: as it was before the switch, from its copies
#
#   <app>: examprep | tutorstar | gonsalves
#
# `switch` is a short downtime (the services helper stops and starts the app, as move-db.sh
# does). Before anything stops it reads every input of every container (its Quadlet, the env
# files it names, its secrets): each 10.0.2.2:<port> must be one of the ports listed for that
# container below, and no other 10.0.2.2 may be left, else it refuses and names them. After
# the start each running container must reach its ports at 127.0.0.1 and nothing at 10.0.2.2;
# if anything fails, everything is put back and the app started again as it was.
set -euo pipefail
[[ $EUID -eq 0 || -n ${PASTA_TEST:-} ]] || { echo "run with sudo" >&2; exit 1; }
source "$(dirname "$(readlink -f "$0")")/lib-appdb.sh"
source "$(dirname "$(readlink -f "$0")")/lib-svc.sh"
die() { say FAIL "$1" >&2; exit 1; }

# The server's side; the test (test/run-to-pasta-test.sh) puts stand-ins in place (PASTA_TEST).
quadlet_dir() { printf '%s/.config/containers/systemd\n' "$(getent passwd "$SVC_USER" | cut -d: -f6)"; }
unit_active() { systemctl --user -M "$SVC_USER@" is-active -q "$1.service"; }
db_sessions() { appdb_super -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB' AND usename IN ($1)" 2>/dev/null || echo 0; }
adopt() {  # the services helper's record taken in again (its Quadlets changed), as install-lfdln.sh's step 6b
    (cd / && /usr/bin/node --disable-warning=ExperimentalWarning /opt/lfdln-panel/sites/lfdln/src/helpers/services-adopt.ts /var/lib/lfdln-services/services.json) >/dev/null \
        && systemctl stop lfdln-services.service 2>/dev/null
}
MOVES=${MOVES:-$APPDB_HOME/moves}
if [[ -n ${PASTA_TEST:-} ]]; then source "$PASTA_TEST"; fi

APP=${1:-}; STAGE=${2:-}
# UNITS: each container's unit and the host ports it may reach (none: nothing of the host).
# What each calls was read from its code and Quadlet on 2026-10-08; the plan checks it again.
case $APP in
    examprep)
        SVC_USER=svc-lfdln-apps; SERVICE=examprep; DB=examprep; ROLES=(examprep_app)
        UNITS=(examprep:5436); SECRETS=(); SECRET_FILES=()
        # its code's own default is 10.0.2.2 (web/lib/progress/db.ts, db/migrate.mjs), said in no file:
        # the Quadlet tells it. (Its catalog call at 10.0.2.2:3048 was dropped with S5-9: no -T,3048.)
        ENV_ADD=(examprep:EXAMPREP_DB_HOST=127.0.0.1) ;;
    tutorstar)
        SVC_USER=svc-tutorstar; SERVICE=tutorstar; DB=tutorstar; ROLES=(tutorstar)
        UNITS=(tutorstar:5436); SECRETS=(tutorstar-db-url); SECRET_FILES=(); ENV_ADD=() ;;
    gonsalves)
        SVC_USER=svc-ligneous; SERVICE=gonsalves; DB=ligneous_frontend; ROLES=(ligneous_user gonsalves_readonly)
        # the public and admin sites call the Flask API (PYTHON_API_URL, :5001), the admin site the
        # GEDCOM API too (LIB_API_URL, :8091); the GEDCOM API calls nothing of the host
        UNITS=(ligneous-gedcom-api: ligneous-flask-api:5436 ligneous-public:5436,5001 ligneous-admin:5436,5001,8091 ligneous-migrator:5436)
        SECRETS=(ligneous-db-url ligneous-db-url-public)
        # sync-podman-secrets.sh makes the secrets again from these: they move with them
        SECRET_FILES=(ligneous-db-url ligneous-db-url-public); ENV_ADD=() ;;
    *) echo "usage: to-pasta.sh examprep|tutorstar|gonsalves plan|switch|back" >&2; exit 2 ;;
esac
[[ $STAGE == plan || $STAGE == switch || $STAGE == back ]] || { echo "usage: to-pasta.sh $APP plan|switch|back" >&2; exit 2; }
QD=$(quadlet_dir)
MARK=$MOVES/$APP.pasta                  # there while the app is on pasta (move-db.sh refuses then)
KEEP=$MOVES/pasta-$APP                  # root 700: each file and secret as it was before the switch
REWRITE="$APPDB_SRC/rewrite-url.py"
OLD_NET='slirp4netns:allow_host_loopback=true'
install -d -m 700 "$MOVES"

ports_of() { local u; for u in "${UNITS[@]}"; do [[ ${u%%:*} == "$1" ]] && { tr ',' ' ' <<<"${u#*:}"; return; }; done; }
names() { local u; for u in "${UNITS[@]}"; do echo "${u%%:*}"; done; }
secrets_of() { sed -n 's/^Secret=\([^,]*\).*/\1/p' "$QD/$1.container"; }
envfiles_of() { sed -n 's/^EnvironmentFile=-\{0,1\}//p' "$QD/$1.container"; }
container_of() { sed -n 's/^ContainerName=//p' "$QD/$1.container" | head -1; }
oneshot() { grep -qx 'Type=oneshot' "$QD/$1.container"; }
# each 10.0.2.2 in a text, but in comments and the Network= line (pasta's own gateway is
# 10.0.2.2): "<port>" or "-" (none said)
old_hosts() { grep -vE '^(Network=|[[:space:]]*#)' | grep -oE '10\.0\.2\.2(:[0-9]+)?' | sed -E 's/^10\.0\.2\.2:?//; s/^$/-/' | sort -u || true; }

# ---------------------------------------------------------------- what it would change
# Every input of every container read; refused (nothing changed) when a container names
# 10.0.2.2 at a port not listed for it, or 10.0.2.2 without a port.
check_inputs() {
    local u f n p bad=0 ports
    for u in $(names); do
        [[ -f $QD/$u.container ]] || { say FAIL "$u: no Quadlet $QD/$u.container"; bad=1; continue; }
        ports=" $(ports_of "$u") "
        { cat "$QD/$u.container"
          for f in $(envfiles_of "$u"); do cat "$f" 2>/dev/null || { say FAIL "$u: its env file $f can't be read" >&2; }; done
          for n in $(secrets_of "$u"); do secret_get "$n" 2>/dev/null || true; echo; done
        } | old_hosts > "$W/hosts.$u"
        while read -r p; do
            [[ -n $p ]] || continue
            if [[ $p == - ]]; then say FAIL "$u names 10.0.2.2 without a port: on pasta it reaches nothing"; bad=1
            elif [[ $ports != *" $p "* ]]; then say FAIL "$u names 10.0.2.2:$p, which isn't forwarded to it (to-pasta.sh lists:$ports)"; bad=1
            fi
        done < "$W/hosts.$u"
    done
    return $bad
}

# the new text of a Quadlet: pasta, 10.0.2.2:<port> told 127.0.0.1, ENV_ADD after Network=
new_quadlet() {  # new_quadlet <unit> < old > new
    local u=$1 net add=() e
    net=$(pasta_net $(ports_of "$u"))
    for e in "${ENV_ADD[@]}"; do [[ ${e%%:*} == "$u" ]] && add+=("Environment=${e#*:}"); done
    python3 -c 'import re, sys
net, adds = sys.argv[1], sys.argv[2:]
out = []
for line in sys.stdin.read().split("\n"):
    if line.startswith("Network="):
        out.append("Network=" + net)
        out.extend(a for a in adds)
    elif line in adds:
        continue
    elif line.lstrip().startswith("#"):
        out.append(line)
    else:
        out.append(re.sub(r"10\.0\.2\.2:(?=\d)", "127.0.0.1:", line))
sys.stdout.write("\n".join(out))' "$net" "${add[@]}"
}
to_local() { python3 -c 'import re, sys; sys.stdout.write("".join(l if l.lstrip().startswith("#") else re.sub(r"10\.0\.2\.2:(?=\d)", "127.0.0.1:", l) for l in sys.stdin.read().splitlines(True)))'; }
# a database secret: its URL at 127.0.0.1 (rewrite-url.py, as move-db.sh changes them)
secret_url() { python3 "$REWRITE" --db "$DB" --from "$APPDB_PORT" --to "$APPDB_PORT" --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords "$@"; }

# every file and secret switch changes, each with its new text in $W/new
FILES=()                # paths
SECRET_NAMES=()         # podman secrets
plan_changes() {
    local u f n i=0
    for u in $(names); do
        grep -q "^Network=$OLD_NET\$" "$QD/$u.container" || { say FAIL "$u's Quadlet has no Network=$OLD_NET line (on pasta already, or another shape): $(grep '^Network=' "$QD/$u.container" || echo none)"; return 1; }
        new_quadlet "$u" < "$QD/$u.container" > "$W/new.$i"; FILES+=("$QD/$u.container"); i=$((i + 1))
        for f in $(envfiles_of "$u"); do
            [[ " ${FILES[*]} " == *" $f "* ]] && continue
            grep -q '10\.0\.2\.2:' "$f" || continue
            to_local < "$f" > "$W/new.$i"; FILES+=("$f"); i=$((i + 1))
        done
    done
    for f in "${SECRET_FILES[@]}"; do
        f=$QD/$f
        [[ -f $f ]] || continue
        secret_url --check --file "$f" >/dev/null 2>&1 || { grep -q '10\.0\.2\.2' "$f" && { say FAIL "$f names 10.0.2.2, but not in a URL for $DB on :$APPDB_PORT"; return 1; }; continue; }
        cp "$f" "$W/new.$i"; secret_url --file "$W/new.$i"; FILES+=("$f"); i=$((i + 1))
    done
    for n in "${SECRETS[@]}"; do
        secret_get "$n" > "$W/old-secret.$n" || { say FAIL "the secret $n can't be read as $SVC_USER"; return 1; }
        if secret_url --check < "$W/old-secret.$n" >/dev/null 2>&1; then
            secret_url < "$W/old-secret.$n" > "$W/new-secret.$n"; SECRET_NAMES+=("$n")
        elif grep -q '10\.0\.2\.2' "$W/old-secret.$n"; then say FAIL "the secret $n names 10.0.2.2, but not in a URL for $DB on :$APPDB_PORT"; return 1
        fi
    done
}
shown() { sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#g'; }

W=$(mktemp -d); trap 'rc=$?; rm -rf "$W"; (exit $rc)' EXIT
chmod 700 "$W"

# ---------------------------------------------------------------- plan
if [[ $STAGE == plan ]]; then
    echo "=== $APP onto pasta ($SVC_USER, $QD)"
    [[ -e $MARK ]] && say note "on pasta already ($(cat "$MARK")): to-pasta.sh $APP back is the way back"
    for u in $(names); do
        p=$(ports_of "$u"); say note "$u: $(pasta_net $p)"
        say note "  ${p:+forwarded to its 127.0.0.1: $p; }it names at 10.0.2.2 today: $( (cat "$QD/$u.container"; for f in $(envfiles_of "$u"); do cat "$f" 2>/dev/null; done; for n in $(secrets_of "$u"); do secret_get "$n" 2>/dev/null; echo; done) | old_hosts | tr '\n' ' ')"
    done
    check_inputs && say ok "every 10.0.2.2 its containers name is a port forwarded to them" || say FAIL "it would refuse to switch (above)"
    if [[ ! -e $MARK ]] && plan_changes; then
        i=0
        for f in "${FILES[@]}"; do say note "would change $f:"; diff <(shown < "$f") <(shown < "$W/new.$i") | grep '^[<>]' | sed 's/^/         /' || true; i=$((i + 1)); done
        for n in "${SECRET_NAMES[@]}"; do say note "would change the secret $n: $(shown < "$W/old-secret.$n") -> $(shown < "$W/new-secret.$n")"; done
    fi
    can_mask && say ok "$SVC_USER's systemd can keep it stopped" || say FAIL "$SVC_USER can't write its ~/.config/systemd/user (sudo chown $SVC_USER: it)"
    if [[ $APP != examprep && -e $MOVES/$DB.switched ]]; then
        since=$(date -d "$(cut -d' ' -f2 "$MOVES/$DB.switched")" +%s 2>/dev/null || echo 0)
        if (( $(date +%s) - since < 14 * 86400 )); then
            say note "move-db.sh's way back is open until $(date -u -d "@$((since + 14 * 86400))" +%Y-%m-%d) and refused while it is on pasta: switch after that, or say --anyway"
        fi
    fi
    exit 0
fi

# ---------------------------------------------------------------- putting things back (back, and a switch that failed)
restore() {  # every file and secret from $KEEP, as it was before the switch
    local f n bad=0
    while IFS= read -r f; do
        [[ -n $f ]] || continue
        if cat "$KEEP/file.$(sha256sum <<<"$f" | cut -c1-16)" > "$f"; then say ok "  $f as it was"
        else say FAIL "  couldn't put $f back"; bad=1; fi
    done < "$KEEP/files"
    while IFS= read -r n; do
        [[ -n $n ]] || continue
        if secret_set "$n" < "$KEEP/secret.$n"; then say ok "  the secret $n as it was"
        else say FAIL "  couldn't put the secret $n back"; bad=1; fi
    done < "$KEEP/secrets"
    return "$bad"
}
# each running container reaches its ports at 127.0.0.1 and nothing at 10.0.2.2
checks() {
    local u c p r bad=0
    for u in $(names); do
        oneshot "$u" && continue
        c=$(container_of "$u"); [[ -n $c ]] || c=$u
        unit_active "$u" || { say FAIL "  $u isn't running"; bad=1; continue; }
        for p in $(ports_of "$u"); do
            if reach "$c" "$p" 127.0.0.1; then say ok "  $c reaches 127.0.0.1:$p"; else say FAIL "  $c can't reach 127.0.0.1:$p"; bad=1; fi
        done
        reach "$c" "$APPDB_PORT" 10.0.2.2 && r=0 || r=$?
        if [[ $r == 0 ]]; then say FAIL "  $c still reaches 10.0.2.2:$APPDB_PORT (the host's loopback)"; bad=1
        elif [[ $r == 2 ]]; then say note "  $c has neither node nor python3 to ask from inside: its network is pasta's by its Quadlet alone"
        else say ok "  $c reaches nothing at 10.0.2.2"; fi
    done
    return $bad
}

# ---------------------------------------------------------------- switch
if [[ $STAGE == switch ]]; then
    [[ -e $MARK ]] && die "$APP is on pasta already ($(cat "$MARK"))"
    if [[ $APP != examprep && -e $MOVES/$DB.switched && ${3:-} != --anyway ]]; then
        since=$(date -d "$(cut -d' ' -f2 "$MOVES/$DB.switched")" +%s 2>/dev/null || echo 0)
        (( $(date +%s) - since >= 14 * 86400 )) || die "move-db.sh's way back for $APP is open until $(date -u -d "@$((since + 14 * 86400))" +%Y-%m-%d), and on pasta it would cut it off: switch after that, or add --anyway (nothing was changed)"
    fi
    echo "=== $APP onto pasta"
    check_inputs || die "refused (above): nothing was changed"
    plan_changes || die "refused (above): nothing was changed"
    can_mask || die "$SVC_USER can't write its ~/.config/systemd/user, so the services helper couldn't keep $SERVICE stopped: sudo chown $SVC_USER: it (nothing was changed)"
    rm -rf "$KEEP"; install -d -m 700 "$KEEP"
    printf '%s\n' "${FILES[@]}" > "$KEEP/files"
    for f in "${FILES[@]}"; do cp -p "$f" "$KEEP/file.$(sha256sum <<<"$f" | cut -c1-16)"; done
    printf '%s\n' "${SECRET_NAMES[@]}" > "$KEEP/secrets"
    for n in "${SECRET_NAMES[@]}"; do cp "$W/old-secret.$n" "$KEEP/secret.$n"; done
    say ok "${#FILES[@]} file(s) and ${#SECRET_NAMES[@]} secret(s) to change, each kept as it is in $KEEP"

    t0=$(date +%s)
    undo() {
        say note "putting everything back as it was before the switch"
        services_call stop || true
        # one part that can't be put back must not keep the app stopped (2026-10-08: set -e ended
        # undo at a failed secret, before the start, and TutorStar stayed down)
        if restore; then rm -rf "$KEEP"; else say FAIL "  not everything could be put back (above): the copies stay in $KEEP"; fi
        if services_call start; then say ok "  $SERVICE started again, as it was (slirp4netns)"
        else say FAIL "  $SERVICE didn't start again: start it on the Services page, or look at its log there"; fi
    }
    services_call stop || { services_call start || true; die "the services helper couldn't stop $SERVICE (nothing was changed; it was started again)"; }
    say ok "$SERVICE stopped (the services helper)"
    i=0
    for f in "${FILES[@]}"; do cat "$W/new.$i" > "$f" || { undo; die "couldn't write $f"; }; i=$((i + 1)); done
    for n in "${SECRET_NAMES[@]}"; do secret_set "$n" < "$W/new-secret.$n" || { undo; die "couldn't change the secret $n"; }; done
    say ok "its Quadlets on pasta, its addresses at 127.0.0.1: $(printf '%s ' "${FILES[@]##*/}")${SECRET_NAMES[*]}"
    services_call start || { undo; die "$SERVICE didn't come up on pasta: put back as it was"; }
    say ok "$SERVICE started on pasta, and answering"
    checks || { undo; die "a container of $SERVICE doesn't reach what it should, or reaches more: put back as it was"; }
    roles_in=$(printf "'%s'," "${ROLES[@]}" | sed 's/,$//')
    n=0; for _ in $(seq 10); do n=$(db_sessions "$roles_in"); [[ $n -gt 0 ]] && break; sleep 2; done
    if [[ $n -gt 0 ]]; then say ok "$SERVICE is connected to lfdln-appdb ($n session(s))"
    else say note "no session from $SERVICE on lfdln-appdb yet (it may connect at its first request): open the site once"; fi
    echo "on pasta since $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARK"
    adopt && say ok "the services helper took its Quadlets in again" || say note "the services helper's record still has the old Quadlets (the next install-lfdln.sh takes them in)"
    say ok "downtime: $(( $(date +%s) - t0 ))s"
    say note "the way back: sudo $APPDB_SRC/to-pasta.sh $APP back"
    exit 0
fi

# ---------------------------------------------------------------- back
if [[ $STAGE == back ]]; then
    [[ -e $MARK ]] || die "$APP isn't on pasta (no $MARK)"
    [[ -s $KEEP/files ]] || die "the copies from before the switch are missing ($KEEP)"
    echo "=== $APP back to slirp4netns (on pasta since $(cut -d' ' -f4- "$MARK"))"
    can_mask || die "$SVC_USER can't write its ~/.config/systemd/user (sudo chown $SVC_USER: it; nothing was changed)"
    t0=$(date +%s)
    services_call stop || { services_call start || true; die "the services helper couldn't stop $SERVICE (nothing was changed; it was started again, on pasta)"; }
    restore_ok=1; restore || { restore_ok=; say FAIL "not everything could be put back (above): the copies stay in $KEEP"; }
    services_call start || die "$SERVICE didn't start again as it was: start it on the Services page, or look at its log there"
    [[ -n $restore_ok ]] || die "$SERVICE started again, but not everything was put back (above); $MARK and $KEEP kept"
    rm -f "$MARK"; rm -rf "$KEEP"
    adopt || true
    say ok "$SERVICE back on slirp4netns, as before the switch, and answering; downtime $(( $(date +%s) - t0 ))s"
    exit 0
fi
