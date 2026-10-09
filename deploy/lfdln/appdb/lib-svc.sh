# shellcheck shell=bash
# An app's own side, as root (docs/data-move-plan.md M5, docs/s1-plan.md S1f): its service
# user's podman (secrets, containers), the services helper, and whether a container reaches
# a port. Needs SVC_USER and SERVICE. Sourced by move-db.sh and to-pasta.sh, not run; their
# tests put stand-ins in place of these (MOVE_TEST, PASTA_TEST).
as_svc() {  # as the app's own service user (its podman: secrets, containers)
    local uid home; uid=$(id -u "$SVC_USER"); home=$(getent passwd "$SVC_USER" | cut -d: -f6)
    (cd / && runuser -u "$SVC_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" HOME="$home" "$@")
}
secret_get() {  # exactly what the secret holds, no newline added or taken away
    as_svc podman secret inspect --showsecret "$1" | python3 -c 'import json, sys; sys.stdout.write(json.load(sys.stdin)[0]["SecretData"])'
}
secret_set() {  # the value on stdin; podman 4.9's --replace refuses a secret that isn't there yet (the rehearsal's are new)
    # podman reads `-` only from a pipe ("if `-` is used, data must be passed into stdin" for a
    # file on stdin, 2026-10-08), so the value always goes through cat, whatever stdin is
    if as_svc podman secret exists "$1" </dev/null; then cat | as_svc podman secret create --replace "$1" - >/dev/null
    else cat | as_svc podman secret create "$1" - >/dev/null; fi
}
reach() {  # reach <container> <port> [<host>]: can it open <host>:<port> (10.0.2.2 unless said), as it will the database?
    # 0 yes, 1 no, 2 it has neither node nor python3 to ask with
    as_svc podman exec "$1" sh -c 'if command -v node >/dev/null; then
        node -e "const s = require(\"net\").connect($0, \"$1\"); s.on(\"connect\", () => process.exit(0)); s.on(\"error\", () => process.exit(1)); setTimeout(() => process.exit(1), 5000)";
      elif command -v python3 >/dev/null; then python3 -c "import socket, sys; socket.create_connection((sys.argv[2], int(sys.argv[1])), 5)" "$0" "$1" || exit 1;
      else exit 2; fi' "$2" "${3:-10.0.2.2}" >/dev/null 2>&1
}
services_call() {  # services_call start|stop: through the services helper, as the panel does (it waits until it answers)
    local out
    out=$(printf '{"op":"%s","id":"%s","actor":"%s"}\n' "$1" "$SERVICE" "$(basename "$0")" | socat -t 960 -T 960 - UNIX-CONNECT:/run/lfdln-services.sock) || return 1
    python3 -c 'import json, sys
r = json.loads(sys.stdin.read() or "{}")
if not r.get("ok"): sys.exit(r.get("message") or "the services helper gave no answer")' <<<"$out"
}
can_mask() {  # can the app's own systemd keep it stopped (the services helper masks what it stops)?
    as_svc sh -c 'd=$HOME/.config/systemd/user; if [ -e "$d" ]; then test -w "$d"; else p=$HOME/.config/systemd; [ -e "$p" ] || p=$HOME/.config; test -w "$p"; fi'
}
# A container's network on pasta (docs/s1-plan.md S1d/S1f, as the projects' Quadlets have it):
# its own address, no way to the host's other ports, and these host ports at its own 127.0.0.1
pasta_net() {  # pasta_net <port>...
    local out="pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2" p
    for p in $(printf '%s\n' "$@" | sort -un); do out+=",-T,$p"; done
    printf '%s\n' "$out"
}
