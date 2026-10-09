#!/usr/bin/env bash
# to-pasta.sh (docs/s1-plan.md S1f (c)) against stand-ins: the apps' Quadlets, env files and
# secrets as files, the services helper and what a container reaches as a log and flags.
# What each app's Quadlets become, what it refuses before anything stops, a switch whose
# app doesn't come up (or reaches too much) put back, and the way back.
#   test/run-to-pasta-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
trap '[[ -n ${KEEP:-} ]] && echo "kept $T" || rm -rf "$T"' EXIT

cat > "$T/hooks.sh" <<EOF
quadlet_dir() { echo "$T/qd/\$SVC_USER"; }
secret_get() { cat "$T/secrets/\$SVC_USER/\$1"; }
# the real secret_set (lib-svc.sh) runs; only podman is a stand-in, and like podman 4.9 it
# reads \`-\` only from a pipe (a file on stdin failed the TutorStar switch, 2026-10-08)
as_svc() {
    [[ \$1 == podman && \$2 == secret ]] || { "\$@"; return; }
    local d="$T/secrets/\$SVC_USER" n=\${@: -2:1}
    case \$3 in
        exists) [[ -e \$d/\$4 ]] ;;
        create) [[ -p /dev/stdin ]] || { echo 'Error: if \`-\` is used, data must be passed into stdin' >&2; return 125; }
                [[ -e $T/fail-secret ]] && { echo 'Error: stand-in secret failure' >&2; return 125; }
                [[ \$4 == --replace || ! -e \$d/\$n ]] || { echo "Error: \$n: secret name in use" >&2; return 125; }
                cat > "\$d/\$n" ;;
        *) return 125 ;;
    esac
}
services_call() {
    echo "\$1" >> "$T/calls"
    if [[ \$1 == start && -e $T/fail-start ]]; then rm -f "$T/fail-start"; return 1; fi
    return 0
}
can_mask() { [[ ! -e $T/no-mask ]]; }
unit_active() { true; }
# on pasta (its Quadlet says so) it reaches what is forwarded at 127.0.0.1; on slirp4netns 10.0.2.2
reach() {
    echo "\$1 \$3:\$2" >> "$T/reached"
    [[ -e $T/no-tool ]] && return 2
    local q; q=\$(grep -l "^ContainerName=\$1\$" "$T/qd/\$SVC_USER"/*.container | head -1)
    if grep -q '^Network=pasta:' "\$q"; then
        [[ \$3 == 127.0.0.1 && ! -e $T/no-reach ]] && grep -q "^Network=.*,-T,\$2\(,\|\$\)" "\$q" && return 0
        [[ \$3 == 10.0.2.2 && -e $T/leaky ]] && return 0
        return 1
    fi
    [[ \$3 == 10.0.2.2 ]]
}
db_sessions() { echo 3; }
adopt() { echo adopt >> "$T/calls"; }
APPDB_PASS="$T/pass"
EOF
mkdir -p "$T/moves" "$T/env"
mk() {  # mk <user> <unit> <text>: a Quadlet
    mkdir -p "$T/qd/$1" "$T/secrets/$1"; printf '%s\n' "$3" > "$T/qd/$1/$2.container"
}
mk svc-ligneous ligneous-gedcom-api $'[Container]\nImage=localhost/gedcom-api:prod\nContainerName=ligneous-gedcom-api\nNetwork=slirp4netns:allow_host_loopback=true\nPublishPort=127.0.0.1:8091:8091'
mk svc-ligneous ligneous-flask-api "[Container]
ContainerName=ligneous-flask-api
Network=slirp4netns:allow_host_loopback=true
EnvironmentFile=$T/env/ligneous.env
Secret=ligneous-db-url,type=env,target=DATABASE_URL"
mk svc-ligneous ligneous-public "# DATABASE_URL at 10.0.2.2:5432 once (a comment: left as it is)
[Container]
ContainerName=ligneous-public
Network=slirp4netns:allow_host_loopback=true
EnvironmentFile=$T/env/ligneous.env
Secret=ligneous-db-url-public,type=env,target=DATABASE_URL
Environment=PYTHON_API_URL=http://10.0.2.2:5001"
mk svc-ligneous ligneous-admin "[Container]
ContainerName=ligneous-admin
Network=slirp4netns:allow_host_loopback=true
EnvironmentFile=$T/env/ligneous.env
Secret=ligneous-db-url,type=env,target=DATABASE_URL
Secret=ligneous-resend-key,type=env,target=RESEND_API_KEY
Environment=PYTHON_API_URL=http://10.0.2.2:5001
Environment=LIB_API_URL=http://10.0.2.2:8091"
mk svc-ligneous ligneous-migrator $'[Container]\nContainerName=ligneous-migrator\nNetwork=slirp4netns:allow_host_loopback=true\nSecret=ligneous-db-url,type=env,target=DATABASE_URL\n[Service]\nType=oneshot'
printf 'ADMIN_TREE_ID=1\nAUTH_COOKIE_NAME=gonsalves_session\n' > "$T/env/ligneous.env"
printf 'postgresql://ligneous_user:pwL@10.0.2.2:5436/ligneous_frontend?sslmode=disable' > "$T/secrets/svc-ligneous/ligneous-db-url"
printf 'postgresql://gonsalves_readonly:pwG@10.0.2.2:5436/ligneous_frontend?sslmode=disable' > "$T/secrets/svc-ligneous/ligneous-db-url-public"
printf 're_key' > "$T/secrets/svc-ligneous/ligneous-resend-key"
# the files sync-podman-secrets.sh makes the secrets from
cp "$T/secrets/svc-ligneous/ligneous-db-url" "$T/qd/svc-ligneous/ligneous-db-url"
cp "$T/secrets/svc-ligneous/ligneous-db-url-public" "$T/qd/svc-ligneous/ligneous-db-url-public"
chmod 600 "$T/qd/svc-ligneous/ligneous-db-url"*
mk svc-tutorstar tutorstar $'[Container]\nContainerName=tutorstar\nNetwork=slirp4netns:allow_host_loopback=true\n# DATABASE_URL points at 10.0.2.2:5432 (host Postgres via slirp)\nSecret=tutorstar-db-url,type=env,target=DATABASE_URL\nSecret=tutorstar-auth-secret,type=env,target=BETTER_AUTH_SECRET'
printf 'postgres://tutorstar:pwT@10.0.2.2:5436/tutorstar' > "$T/secrets/svc-tutorstar/tutorstar-db-url"
printf 'auth' > "$T/secrets/svc-tutorstar/tutorstar-auth-secret"
mk svc-lfdln-apps examprep $'# the appdb at 10.0.2.2:5436\n[Container]\nContainerName=examprep\nPublishPort=127.0.0.1:4101:4101\nNetwork=slirp4netns:allow_host_loopback=true\nSecret=examprep-db,mode=0400,uid=1000\nEnvironment=PORT=4101'
printf 'pw' > "$T/secrets/svc-lfdln-apps/examprep-db"
cp -a "$T/qd" "$T/qd.orig"; cp -a "$T/secrets" "$T/secrets.orig"; cp -a "$T/env" "$T/env.orig"
same_as_before() { diff -r "$T/qd" "$T/qd.orig" >/dev/null && diff -r "$T/secrets" "$T/secrets.orig" >/dev/null && diff -r "$T/env" "$T/env.orig" >/dev/null; }
pasta() { PASTA_TEST="$T/hooks.sh" MOVES="$T/moves" "$P/deploy/lfdln/appdb/to-pasta.sh" "$@"; }
NET=pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2

echo "--- plan: what it would do, nothing done"
out=$(pasta gonsalves plan 2>&1); rc=$?
[[ $rc -eq 0 ]] && grep -q 'ligneous-admin: '"$NET"',-T,5001,-T,5436,-T,8091' <<<"$out" && grep -q 'every 10.0.2.2 its containers name is a port forwarded to them' <<<"$out" \
    && grep -qF 'would change the secret ligneous-db-url: postgresql://ligneous_user:***@10.0.2.2:5436/ligneous_frontend?sslmode=disable -> postgresql://ligneous_user:***@127.0.0.1:5436/ligneous_frontend?sslmode=disable' <<<"$out" \
    && ok "gonsalves: each container's ports, the secrets it would change (passwords not shown)" || { bad "gonsalves plan (exit $rc)"; echo "$out" | sed 's/^/    /'; }
grep -q 'pwL\|pwG' <<<"$out" && bad "plan showed a password" || ok "...no password shown"
same_as_before && [[ ! -e $T/calls ]] && ok "...nothing changed, nothing stopped" || bad "plan changed something"
out=$(pasta nope plan 2>&1); [[ $? -eq 2 ]] && ok "an app it doesn't know" || bad "unknown app: $out"

echo "--- refused before anything stops"
printf 'GEONAMES=http://10.0.2.2:9999/x\n' >> "$T/env/ligneous.env"
out=$(pasta gonsalves switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -e $T/calls ]] && grep -q 'ligneous-flask-api names 10.0.2.2:9999, which isn.t forwarded' <<<"$out" && same_as_before 2>/dev/null; r=$?
cp "$T/env.orig/ligneous.env" "$T/env/ligneous.env"
[[ $rc -ne 0 && $r -ne 0 ]] && grep -q "10.0.2.2:9999" <<<"$out" && [[ ! -e $T/calls ]] && ok "an env file naming 10.0.2.2 at a port not forwarded: refused, named, nothing stopped" || bad "unlisted port: $out"
printf 'postgres://tutorstar:pwT@10.0.2.2/tutorstar' > "$T/secrets/svc-tutorstar/tutorstar-db-url"
out=$(pasta tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -e $T/calls ]] && grep -q 'tutorstar names 10.0.2.2 without a port' <<<"$out" && ok "10.0.2.2 without a port: refused" || bad "no port: $out"
cp "$T/secrets.orig/svc-tutorstar/tutorstar-db-url" "$T/secrets/svc-tutorstar/tutorstar-db-url"
touch "$T/no-mask"
out=$(pasta tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -e $T/calls ]] && grep -q "can't write its ~/.config/systemd/user" <<<"$out" && ok "a service user whose systemd can't keep it stopped: refused" || bad "no-mask: $out"
rm -f "$T/no-mask"
echo "switched $(date -u -d '-3 days' +%Y-%m-%dT%H:%M:%SZ)" > "$T/moves/tutorstar.switched"
out=$(pasta tutorstar switch 2>&1); rc=$?
[[ $rc -ne 0 && ! -e $T/calls ]] && grep -q "move-db.sh's way back for tutorstar is open until" <<<"$out" && ok "while move-db.sh's way back is open: refused (it would cut it off)" || bad "way back open: $out"
same_as_before && ok "...each refusal changed nothing" || bad "a refusal changed something"

echo "--- switch: TutorStar (--anyway, its way back still open)"
: > "$T/calls"; : > "$T/reached"
out=$(pasta tutorstar switch --anyway 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start adopt ' ]] && ok "stopped, started, the services helper's record taken in again" || bad "tutorstar switch (exit $rc, calls $(tr '\n' ' ' < "$T/calls"))"
grep -qx "Network=$NET,-T,5436" "$T/qd/svc-tutorstar/tutorstar.container" && ! grep -q allow_host_loopback "$T/qd/svc-tutorstar/tutorstar.container" && ok "its Quadlet: pasta, -T 5436 alone" || bad "tutorstar Quadlet: $(cat "$T/qd/svc-tutorstar/tutorstar.container")"
grep -qx '# DATABASE_URL points at 10.0.2.2:5432 (host Postgres via slirp)' "$T/qd/svc-tutorstar/tutorstar.container" && ok "...its comments as they were" || bad "comment changed"
[[ $(cat "$T/secrets/svc-tutorstar/tutorstar-db-url") == 'postgres://tutorstar:pwT@127.0.0.1:5436/tutorstar' ]] && ok "its secret at 127.0.0.1, its password as it was, no newline added" || bad "secret: $(cat "$T/secrets/svc-tutorstar/tutorstar-db-url")"
cmp -s "$T/secrets/svc-tutorstar/tutorstar-auth-secret" "$T/secrets.orig/svc-tutorstar/tutorstar-auth-secret" && ok "...its other secrets untouched" || bad "auth secret touched"
grep -qx 'tutorstar 127.0.0.1:5436' "$T/reached" && grep -qx 'tutorstar 10.0.2.2:5436' "$T/reached" && ok "checked from inside: 127.0.0.1:5436, and nothing at 10.0.2.2" || bad "reach: $(cat "$T/reached")"
[[ -e $T/moves/tutorstar.pasta ]] && ok "marked on pasta (move-db.sh refuses a switch or way back then)" || bad "no marker"
out=$(pasta tutorstar switch --anyway 2>&1); [[ $? -ne 0 ]] && grep -q 'on pasta already' <<<"$out" && ok "twice: refused" || bad "second switch: $out"

echo "--- back: as it was"
: > "$T/calls"
out=$(pasta tutorstar back 2>&1); rc=$?
[[ $rc -eq 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start adopt ' ]] && diff -r "$T/qd/svc-tutorstar" "$T/qd.orig/svc-tutorstar" >/dev/null && diff -r "$T/secrets/svc-tutorstar" "$T/secrets.orig/svc-tutorstar" >/dev/null \
    && [[ ! -e $T/moves/tutorstar.pasta && ! -e $T/moves/pasta-tutorstar ]] && ok "its Quadlet and secrets exactly as they were, the marker and copies gone" || bad "back (exit $rc): $out"
rm -f "$T/moves/tutorstar.switched"

echo "--- switch: Gonsalves, five containers, an env file and the secrets' files"
: > "$T/calls"; : > "$T/reached"
out=$(pasta gonsalves switch 2>&1); rc=$?
echo "$out" | sed 's/^/    /'
[[ $rc -eq 0 ]] && ok "switched" || bad "gonsalves switch (exit $rc)"
q=$T/qd/svc-ligneous
grep -qx "Network=$NET" "$q/ligneous-gedcom-api.container" && grep -qx "Network=$NET,-T,5436" "$q/ligneous-flask-api.container" \
    && grep -qx "Network=$NET,-T,5001,-T,5436" "$q/ligneous-public.container" && grep -qx "Network=$NET,-T,5001,-T,5436,-T,8091" "$q/ligneous-admin.container" \
    && grep -qx "Network=$NET,-T,5436" "$q/ligneous-migrator.container" && ok "each Quadlet: pasta, only its own ports (the GEDCOM API none)" || bad "gonsalves networks: $(grep -h '^Network=' "$q"/*.container)"
grep -qx 'Environment=PYTHON_API_URL=http://127.0.0.1:5001' "$q/ligneous-admin.container" && grep -qx 'Environment=LIB_API_URL=http://127.0.0.1:8091' "$q/ligneous-admin.container" \
    && grep -qx 'Environment=PYTHON_API_URL=http://127.0.0.1:5001' "$q/ligneous-public.container" && ok "...the sites call the APIs at 127.0.0.1" || bad "API URLs"
[[ $(cat "$T/secrets/svc-ligneous/ligneous-db-url-public") == 'postgresql://gonsalves_readonly:pwG@127.0.0.1:5436/ligneous_frontend?sslmode=disable' && $(cat "$q/ligneous-db-url-public") == "$(cat "$T/secrets/svc-ligneous/ligneous-db-url-public")" && $(stat -c %a "$q/ligneous-db-url-public") == 600 ]] \
    && ok "...its secrets and the files they are made from at 127.0.0.1 (mode kept)" || bad "gonsalves secrets: $(cat "$T/secrets/svc-ligneous/ligneous-db-url-public")"
cmp -s "$T/env/ligneous.env" "$T/env.orig/ligneous.env" && ok "...its env file (no 10.0.2.2 in it) untouched" || bad "env file changed"
! grep -q '^ligneous-migrator ' "$T/reached" && grep -qx 'ligneous-admin 127.0.0.1:8091' "$T/reached" && ok "checked from inside, each running one (not the one-shot migrator)" || bad "reached: $(cat "$T/reached")"
out=$(pasta gonsalves back 2>&1) && same_as_before && ok "back: everything as it was" || bad "gonsalves back: $out"

echo "--- a secret that can't be changed: put back, and the app started again all the same (2026-10-08)"
: > "$T/calls"; touch "$T/fail-secret"
out=$(pasta tutorstar switch --anyway 2>&1); rc=$?
rm -f "$T/fail-secret"
[[ $rc -ne 0 && $(tr '\n' ' ' < "$T/calls") == 'stop stop start ' ]] && grep -q 'started again, as it was' <<<"$out" && [[ ! -e $T/moves/tutorstar.pasta ]] \
    && ok "the secret refused: started again, not marked" || bad "fail-secret (exit $rc, calls $(tr '\n' ' ' < "$T/calls")): $out"
same_as_before && ok "...its Quadlet and secret as they were" || bad "fail-secret left changes"

echo "--- a switch that fails after the stop is put back, and the app started as it was"
: > "$T/calls"; touch "$T/fail-start"
out=$(pasta gonsalves switch 2>&1); rc=$?
[[ $rc -ne 0 && $(tr '\n' ' ' < "$T/calls") == 'stop start stop start ' ]] && same_as_before && [[ ! -e $T/moves/gonsalves.pasta ]] && grep -q 'started again, as it was' <<<"$out" \
    && ok "didn't come up: put back, started again, not marked" || bad "fail-start (exit $rc, calls $(tr '\n' ' ' < "$T/calls")): $out"
: > "$T/calls"; touch "$T/leaky"
out=$(pasta tutorstar switch 2>&1); rc=$?
rm -f "$T/leaky"
[[ $rc -ne 0 ]] && grep -q 'still reaches 10.0.2.2' <<<"$out" && same_as_before && ok "still reaching 10.0.2.2 after the start: put back" || bad "leaky (exit $rc): $out"
touch "$T/no-reach"
out=$(pasta tutorstar switch 2>&1); rc=$?
rm -f "$T/no-reach"
[[ $rc -ne 0 ]] && grep -q "can't reach 127.0.0.1:5436" <<<"$out" && same_as_before && ok "not reaching its database: put back" || bad "no-reach (exit $rc): $out"

echo "--- exam prep: its code's own default told by the Quadlet"
out=$(pasta examprep switch 2>&1); rc=$?
qe=$T/qd/svc-lfdln-apps/examprep.container
[[ $rc -eq 0 ]] && grep -qx "Network=$NET,-T,5436" "$qe" && [[ $(grep -A1 '^Network=' "$qe" | tail -1) == 'Environment=EXAMPREP_DB_HOST=127.0.0.1' ]] && ! grep -q '3048' "$qe" \
    && ok "pasta with -T 5436 (no 3048), EXAMPREP_DB_HOST=127.0.0.1 after it" || bad "examprep (exit $rc): $out $(cat "$qe")"
pasta examprep back >/dev/null 2>&1 && same_as_before && ok "...and back" || bad "examprep back"
touch "$T/no-tool"
out=$(pasta gonsalves switch 2>&1); rc=$?
rm -f "$T/no-tool"
[[ $rc -ne 0 ]] && grep -q "neither node nor python3" <<<"$out" && grep -q "can't reach 127.0.0.1" <<<"$out" && same_as_before && ok "no tool in a container to ask with: said; one that must reach a port and can't be asked: put back" || bad "no-tool (exit $rc): $out"

echo "--- already on pasta by hand: refused"
sed -i 's/^Network=.*/Network=pasta/' "$T/qd/svc-tutorstar/tutorstar.container"
out=$(pasta tutorstar switch 2>&1); [[ $? -ne 0 ]] && grep -q 'has no Network=slirp4netns:allow_host_loopback=true line' <<<"$out" && ok "a Quadlet of another shape: refused" || bad "other shape: $out"
cp "$T/qd.orig/svc-tutorstar/tutorstar.container" "$T/qd/svc-tutorstar/tutorstar.container"

echo
echo "  to-pasta test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
