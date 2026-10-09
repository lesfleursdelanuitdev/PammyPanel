#!/usr/bin/env bash
# Projects' builds for real (docs/phase8b-plan.md steps 8b-2, 8b-4a, 8b-8a, 8b-8b: behind the proxy): each kind made with the latest
# starter tool and built, in the build image, as the projects helper runs them -- but in your
# own podman, in a throwaway folder. Needs the internet (npm). build.sh runs it.
#   test/run-projects-builds-test.sh [kind ...]
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
C=$PWD/packages/projects/container
IMG=localhost/lfdln-build-node:test
pass=0; fail=0
podman build -q -t "$IMG" -f deploy/lfdln/projects/build-node.Containerfile deploy/lfdln/projects >/dev/null || { echo "  FAIL the build image didn't build"; exit 1; }
T=$(mktemp -d)
# 8b-8b (P8b-11): the boxes on an internal network of the test's own, out only through the
# helper's proxy (container/proxy.mjs, its allow-list), as lfdln-build and lfdln-build-proxy are
NET=lfdln-build-test-$$
PROXY=lfdln-build-test-proxy-$$
podman network create --internal "$NET" >/dev/null || { echo "  FAIL couldn't make the test's internal network"; exit 1; }
trap 'podman rm -f "$PROXY" >/dev/null 2>&1; podman network rm "$NET" >/dev/null 2>&1; podman unshare rm -rf "$T"; podman rmi -f "$IMG" >/dev/null 2>&1' EXIT
RESOLVERS=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ && $2 !~ /^127\./ {print $2}' /run/systemd/resolve/resolv.conf 2>/dev/null | head -3 | paste -sd, -)
podman run -d --rm --name "$PROXY" --network "$NET,podman" --read-only --cap-drop=all --user node -e "PROXY_DNS=$RESOLVERS" -v "$C:/lfdln:ro" docker.io/library/node:24-bookworm-slim node /lfdln/proxy.mjs >/dev/null \
    || { echo "  FAIL the test's proxy didn't start"; exit 1; }
PX=http://$PROXY:3128
PROXY_ARGS=(--network "$NET" -e "HTTPS_PROXY=$PX" -e "https_proxy=$PX" -e "HTTP_PROXY=$PX" -e "http_proxy=$PX" -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 -e NODE_USE_ENV_PROXY=1)
box() {  # box <project dir> <script and args...>: as lfdln-projects runs them (helper/ops.ts buildArgs)
    local p=$1; shift
    # another uid inside than the image's node (1000), as on the server (svc-lfdln-apps, 974):
    # the helper's --user must win over the image's USER
    podman run --rm --timeout=900 --userns=keep-id:uid=974,gid=966 --user=974:966 --memory=2g --cpus=2 --pids-limit=1024 --read-only --tmpfs /tmp:rw,size=512m,exec "${PROXY_ARGS[@]}" \
        -e HOME=/tmp/home -e npm_config_cache=/cache/npm -e npm_config_store_dir=/cache/pnpm -e npm_config_update_notifier=false -e CI=1 -e NEXT_TELEMETRY_DISABLED=1 \
        -v "$p/work:/work" -v "$p/repo.git:/repo" -v "$p/cache:/cache" -v "$p/build:/build" -v "$p/releases/main:/out" -v "$C:/lfdln:ro" \
        "$IMG" node "$@"
}
CASES=("react ts tailwind pnpm" "vue js plain npm" "svelte ts tailwind npm" "lit js tailwind pnpm" "next-static ts tailwind npm" "next-static js plain pnpm")
for c in "${CASES[@]}"; do
    read -r kind lang style pm <<<"$c"
    [[ $# -gt 0 && " $* " != *" $kind "* ]] && continue
    lock=package-lock.json; [[ $pm == pnpm ]] && lock=pnpm-lock.yaml
    p=$T/$kind-$lang-$pm; mkdir -p "$p"/{work,repo.git,cache,build,releases/main}
    if box "$p" /lfdln/scaffold.mjs "$kind" "$lang" "$style" "$pm" demo tester >"$p/make.log" 2>&1 \
       && box "$p" /lfdln/build.mjs main 20261005120000 "$kind" >"$p/build.log" 2>&1 \
       && [[ -f $p/releases/main/20261005120000/index.html ]] \
       && git -C "$p/repo.git" show "main:$lock" >/dev/null 2>&1 \
       && { [[ $style == plain ]] || grep -rqsE -- 'tailwindcss|--tw-' "$p/releases/main/20261005120000"; }; then
        echo "  ok    $c: made, built, $(tail -1 "$p/build.log")"; pass=$((pass+1))
    else
        echo "  FAIL  $c"; tail -15 "$p/make.log" "$p/build.log" 2>/dev/null | sed 's/^/        /'; fail=$((fail+1))
    fi
done
# Packages (8b-8a), for real on two of them (npm and pnpm): checked, a package added (a commit
# pushed to the repository), checked again, a script run; and the registry's search and details
pkgflow() {  # pkgflow <project dir> <label>
    local p=$1 c=$2 ok=1 r
    pk() { podman unshare rm -rf "$p/build/src"; box "$p" /lfdln/packages.mjs "$@" 2>>"$p/packages.log" | tail -1; }
    r=$(pk check main); grep -q '"packages":\[{' <<<"$r" && grep -q '"scripts":{' <<<"$r" || { ok=0; echo "        check: ${r:0:200}"; }
    r=$(pk change main tester '{"add":[{"name":"ms","version":"^2"}]}'); grep -q '"changed":true' <<<"$r" || { ok=0; echo "        change: ${r:0:200}"; }
    r=$(pk check main); grep -q '"name":"ms"' <<<"$r" || { ok=0; echo "        check after: ${r:0:200}"; }
    git -C "$p/repo.git" log -1 --format=%s main | grep -q '^Packages: add ms@\^2$' || { ok=0; echo "        the commit: $(git -C "$p/repo.git" log -1 --format=%s main)"; }
    r=$(pk change main tester '{"remove":["ms"]}'); grep -q '"changed":true' <<<"$r" || { ok=0; echo "        remove: ${r:0:200}"; }
    r=$(pk run main build); grep -q '"exit":0' <<<"$r" || { ok=0; echo "        run build: ${r:0:200}"; }
    if (( ok )); then echo "  ok    $c: packages checked, ms added and removed (two commits), build run as a script"; pass=$((pass+1))
    else echo "  FAIL  $c: packages"; tail -15 "$p/packages.log" | sed 's/^/        /'; fail=$((fail+1)); fi
}
for c in "react ts tailwind pnpm" "vue js plain npm"; do
    read -r kind lang style pm <<<"$c"
    [[ $# -gt 0 && " $* " != *" $kind "* ]] && continue
    p=$T/$kind-$lang-$pm
    [[ -f $p/releases/main/20261005120000/index.html ]] && pkgflow "$p" "$c"
done
if [[ $# -eq 0 ]]; then
    reg() { podman run --rm --timeout=60 --userns=keep-id:uid=974,gid=966 --user=974:966 --memory=256m --cpus=1 --pids-limit=128 --read-only --tmpfs /tmp:rw,size=64m "${PROXY_ARGS[@]}" \
        -e HOME=/tmp -v "$C:/lfdln:ro" "$IMG" node /lfdln/packages.mjs "$@" 2>&1 | tail -1; }
    s=$(reg search zod); a=$(reg about zod ts); n=$(reg about zz-no-such-package-lfdln js)
    if grep -q '"name":"zod"' <<<"$s" && grep -q '"found":true' <<<"$a" && grep -q '"types":"built-in"' <<<"$a" && grep -q '"warnings":\[\]' <<<"$a" && grep -q '"found":false' <<<"$n"; then
        echo "  ok    the registry: zod found, its details (its own types, nothing to warn about), and a name nobody has"; pass=$((pass+1))
    else
        echo "  FAIL  the registry: search ${s:0:150} | about ${a:0:150} | none ${n:0:100}"; fail=$((fail+1))
        podman logs "$PROXY" 2>&1 | tail -8 | sed 's/^/        proxy: /'
    fi
fi
# The proxy (8b-8b): a box reaches nothing but the allow-list, and nothing at all without it
if [[ $# -eq 0 ]]; then
    out=$(podman run --rm "${PROXY_ARGS[@]}" "$IMG" node -e "
      const go = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.status, (e) => 'refused');
      Promise.all([go('https://registry.npmjs.org/ms'), go('https://example.com/')]).then((x) => console.log(x.join(' ')))" 2>&1 | tail -1)
    alone=$(podman run --rm --network "$NET" "$IMG" node -e "fetch('https://registry.npmjs.org/ms', { signal: AbortSignal.timeout(5000) }).then((r) => console.log(r.status), () => console.log('no way out'))" 2>&1 | tail -1)
    if [[ $out == "200 refused" && $alone == "no way out" ]] && podman logs "$PROXY" 2>&1 | grep -q 'refused CONNECT example.com:443'; then
        echo "  ok    the proxy: the registry through it, example.com refused (and said), nothing at all without it"; pass=$((pass+1))
    else
        echo "  FAIL  the proxy: through it '$out', without it '$alone'"; fail=$((fail+1))
        podman logs "$PROXY" 2>&1 | tail -8 | sed 's/^/        proxy: /'
    fi
fi
# A Next.js server (8b-4a): built standalone with pnpm (its node_modules are links), made into
# a release image with the helper's own Containerfile, run as the Quadlet runs it (read-only,
# no capabilities), and it answers / and its health check
if [[ $# -eq 0 || " $* " == *" next "* ]]; then
    c="next ts tailwind pnpm"; p=$T/next-server; mkdir -p "$p"/{work,repo.git,cache,build,releases/main}
    RIMG=localhost/lfdln-project-test:server; port=$((20000 + RANDOM % 20000))
    node --disable-warning=ExperimentalWarning -e "import('@panel/projects/helper/ops').then((m) => process.stdout.write(m.CONTAINERFILE))" > "$T/Containerfile"
    if box "$p" /lfdln/scaffold.mjs next ts tailwind pnpm demo tester >"$p/make.log" 2>&1 \
       && box "$p" /lfdln/build.mjs main 20261005120000 next >"$p/build.log" 2>&1 \
       && [[ -f $p/releases/main/20261005120000/server.js && -f $p/releases/main/20261005120000/.lfdln-health.mjs ]] \
       && podman build --pull=never -q -t "$RIMG" -f "$T/Containerfile" "$p/releases/main/20261005120000" >"$p/image.log" 2>&1 \
       && podman run -d --rm --name lfdln-project-test-$$ -p "127.0.0.1:$port:3000" --read-only --tmpfs /tmp:rw,size=64m --tmpfs /app/.next/cache:rw,size=128m \
            --cap-drop=all --security-opt no-new-privileges --memory=512m "$RIMG" >/dev/null 2>"$p/run.log"; then
        got=; for _ in $(seq 60); do got=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null) && break; sleep 1; done
        if [[ $got == *"<html"* ]] && podman exec "lfdln-project-test-$$" node /app/.lfdln-health.mjs; then
            echo "  ok    $c (a server): made, built, its image runs read-only and answers /, its health check passes"; pass=$((pass+1))
        else
            echo "  FAIL  $c (a server): it didn't answer on :$port"; podman logs "lfdln-project-test-$$" 2>&1 | tail -15 | sed 's/^/        /'; fail=$((fail+1))
        fi
        podman stop -t 2 "lfdln-project-test-$$" >/dev/null 2>&1
    else
        echo "  FAIL  $c (a server)"; tail -15 "$p/make.log" "$p/build.log" "$p/image.log" "$p/run.log" 2>/dev/null | sed 's/^/        /'; fail=$((fail+1))
    fi
    podman rmi -f "$RIMG" >/dev/null 2>&1
fi
echo "  projects builds test: $pass passed, $fail failed"
(( fail == 0 ))
