#!/usr/bin/env bash
# lfdln-offsite (docs/recovery-plan.md, R1) with the real restic (the same 0.16.4 Ubuntu
# ships, from its image) against a throwaway S3 server standing in for both targets (two
# buckets: "r2" and "b2"): a backup to each, one target with a bad key while the other
# still succeeds, a second backup and retention, the excludes, a restore test with a real
# Postgres dump, nothing readable in the buckets, a wrong password refused, a full restore
# that compares equal. Containers are named for this run and removed by name.
# The S3 server is `rclone serve s3` over a plain folder (2026-10-08: MinIO stopped publishing
# public images, quay.io/minio/minio answers "unauthorized"); buckets are its top folders, so
# the objects restic writes are plain files there to scan for the marker. Each image is
# pulled when it isn't here (a prune of old images must not break the test).
#   test/run-offsite-test.sh
set -uo pipefail
P="$(dirname "$(readlink -f "$0")")/.."
T=$(mktemp -d)
S3=offsite-test-s3-$$ PG=offsite-test-pg-$$ MP=19900
RESTIC_IMAGE=docker.io/restic/restic:0.16.4 S3_IMAGE=docker.io/rclone/rclone:1.71
pass=0 fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
cleanup() { podman rm -f --ignore -t 2 "$S3" "$PG" >/dev/null 2>&1;  # --ignore: one never started must not keep the other (2026-10-08: a left-over Postgres kept the test lock)
    podman unshare rm -rf "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

for i in "$RESTIC_IMAGE" "$S3_IMAGE" docker.io/library/postgres:15; do
    podman image exists "$i" || podman pull -q "$i" >/dev/null || { echo "  FAIL  can't pull $i"; exit 1; }
done
mkdir -p "$T/s3" "$T/bin" "$T/etc/credentials/r2" "$T/etc/credentials/b2" "$T/state" "$T/src/etc" "$T/src/svc-a/backups" \
    "$T/src/site/node_modules/x" "$T/out"
podman run -d --rm --name "$S3" -p "127.0.0.1:$MP:9000" -v "$T/s3:/data:Z" \
    "$S3_IMAGE" serve s3 /data --addr :9000 --auth-key offsitetest,offsitetest-secret >/dev/null
podman run -d --rm --name "$PG" -e POSTGRES_PASSWORD=test docker.io/library/postgres:15 >/dev/null
# up when it answers HTTP at all (a bucket list without a key is refused: still an answer)
for _ in $(seq 60); do [[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MP/") != 000 ]] && break; sleep 0.5; done
for _ in $(seq 60); do podman exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 0.5; done

# restic from its image, seeing this run's folder at the same path
cat > "$T/bin/restic" <<EOF
#!/usr/bin/env bash
exec podman run --rm -i --net=host -v "$T:$T" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION -e RESTIC_REPOSITORY -e RESTIC_PASSWORD_FILE -e RESTIC_CACHE_DIR $RESTIC_IMAGE "\$@"
EOF
chmod +x "$T/bin/restic"
for t in r2 b2; do
    printf 'offsitetest' > "$T/etc/credentials/$t/s3-access-key-id"
    printf 'offsitetest-secret' > "$T/etc/credentials/$t/s3-secret-access-key"
done
head -c 32 /dev/urandom | base64 > "$T/etc/credentials/restic-password"
conf() {
    cat > "$T/etc/offsite.conf" <<EOF
TARGETS="r2 b2"
RESTIC_REPOSITORY_r2=s3:http://127.0.0.1:$MP/offsite-test-r2/vps
RESTIC_REPOSITORY_b2=s3:http://127.0.0.1:$MP/offsite-test-b2/vps
REGION_r2=us-east-1
REGION_b2=us-east-1
HOST_TAG=testhost
HOST_PG=off
KEEP_DAILY=1
KEEP_WEEKLY=0
KEEP_MONTHLY=0
$1
EOF
}
conf ''
printf '%s\n' "$T/src/etc" "$T/src/svc-*/backups" "$T/src/site" "$T/src/not-there" > "$T/etc/sources.conf"
cp "$P/deploy/recovery/excludes.conf" "$T/etc/excludes.conf"
offsite() { OFFSITE_ETC=$T/etc OFFSITE_STATE=$T/state OFFSITE_LOCK=$T/lock RESTIC=$T/bin/restic \
    "$P/deploy/recovery/lfdln-offsite" "$@"; }

# the sources: settings with a marker that must never be readable in the bucket, a real dump
# (the host's pg_restore reads a 15 archive), a gzip, a half-written dump, a node_modules
MARK="PLAINTEXT-MARKER-$$-$RANDOM"
echo "secret=$MARK" > "$T/src/etc/panel.env"
mkdir -p "$T/src/etc/sub"; echo "nested" > "$T/src/etc/sub/file"
podman exec "$PG" psql -qU postgres -c "CREATE TABLE t AS SELECT g AS n, '$MARK' AS s FROM generate_series(1,500) g" >/dev/null
podman exec "$PG" pg_dump -Fc -U postgres postgres > "$T/src/svc-a/backups/a-20261005T0400Z-nightly.dump"
echo "older" > "$T/src/svc-a/backups/a-20261004T0400Z-nightly.dump"; touch -d '2 days ago' "$T/src/svc-a/backups/a-20261004T0400Z-nightly.dump"
echo "$MARK" | gzip > "$T/src/svc-a/backups/maria-20261005.sql.gz"
echo "half" > "$T/src/svc-a/backups/a-now.dump.part"
echo "module" > "$T/src/site/node_modules/x/index.js"; echo "<h1>$MARK</h1>" > "$T/src/site/index.html"

echo "--- the repositories"
for t in r2 b2; do offsite restic $t init >/dev/null 2>&1 && ok "$t: restic init in its bucket" || bad "$t: restic init"; done

echo "--- a backup to each target"
if offsite backup 2>"$T/err1"; then ok "backup ran"; else bad "backup: $(tail -3 "$T/err1")"; fi
s=$(offsite status)
[[ $(jq -r .state <<<"$s") == ok ]] && ok "status: ok" || bad "status: $s"
for t in r2 b2; do
    [[ $(jq -r ".targets.$t.state" <<<"$s") == ok && $(jq -r ".targets.$t.snapshot | length" <<<"$s") -ge 8 ]] \
        && ok "$t: ok, its snapshot named" || bad "$t: $(jq -c ".targets.$t" <<<"$s")"
done
[[ $(jq -r '.targets.r2.missing[0]' <<<"$s") == "$T/src/not-there" ]] && ok "status names the missing source" || bad "missing: $s"
files=$(offsite restic b2 ls latest 2>/dev/null)
grep -q "panel.env$" <<<"$files" && grep -q "/sub/file$" <<<"$files" && ok "settings copied" || bad "settings not in the snapshot"
grep -q "nightly.dump$" <<<"$files" && grep -q "maria-20261005.sql.gz$" <<<"$files" && ok "dumps copied" || bad "dumps not in the snapshot"
grep -q '\.part$' <<<"$files" && bad "a half-written dump was copied" || ok "half-written dumps left out"
grep -q node_modules <<<"$files" && bad "node_modules copied" || ok "node_modules left out"
[[ $(offsite restic r2 snapshots --json 2>/dev/null | jq -r '.[0].id') != $(offsite restic b2 snapshots --json 2>/dev/null | jq -r '.[0].id') ]] \
    && ok "two repositories, each with its own snapshot" || bad "the targets share a repository"

echo "--- nothing readable in the buckets"
if podman unshare grep -rqa "$MARK" "$T/s3" 2>/dev/null; then bad "the marker is readable in the buckets' files"
else ok "the buckets hold only encrypted data (marker not found in $(podman unshare du -sh "$T/s3" | cut -f1))"; fi

echo "--- one target with a bad key: the other still backs up"
printf 'wrong-secret' > "$T/etc/credentials/r2/s3-secret-access-key"
echo "changed" >> "$T/src/etc/panel.env"
if offsite backup 2>"$T/err2"; then bad "the run succeeded with r2's key wrong"; else ok "the run fails (exit non-zero)"; fi
s=$(offsite status)
[[ $(jq -r .targets.r2.state <<<"$s") == failed ]] && ok "r2: failed, and says so" || bad "r2: $(jq -c .targets.r2 <<<"$s")"
[[ $(jq -r .targets.b2.state <<<"$s") == ok ]] && ok "b2: still backed up" || bad "b2: $(jq -c .targets.b2 <<<"$s")"
[[ $(jq -r .state <<<"$s") == failed ]] && ok "status.json: failed overall" || bad "overall: $(jq -r .state <<<"$s")"
printf 'offsitetest-secret' > "$T/etc/credentials/r2/s3-secret-access-key"

echo "--- a target without keys is skipped, the other runs"
mv "$T/etc/credentials/r2" "$T/r2.keys"
offsite backup b2 r2 2>"$T/err2a" && ok "the run succeeds with only b2 configured" || bad "only b2: $(tail -3 "$T/err2a")"
[[ $(offsite status | jq -r .targets.r2.state) == not-configured ]] && ok "r2: not-configured" || bad "r2: $(offsite status | jq -c .targets.r2)"
mv "$T/r2.keys" "$T/etc/credentials/r2"

echo "--- retention (keep 1 a day)"
offsite backup 2>/dev/null
n=$(offsite restic b2 snapshots --json 2>/dev/null | jq length)
[[ $n == 1 ]] && ok "one snapshot kept after forget --prune" || bad "$n snapshots kept"
conf 'KEEP_DAILY=7'
echo "changed again" >> "$T/src/etc/panel.env"
offsite backup 2>"$T/err2b" || bad "backup with keep 7: $(tail -3 "$T/err2b")"
n=$(offsite restic b2 snapshots --json 2>/dev/null | jq length)
# restic 0.16: while the policy isn't full (7 days, 1 day of snapshots) it also keeps the oldest
[[ $n == 2 ]] && ok "keep 7 a day: the newest of the day, and the oldest while the policy isn't full" || bad "$n snapshots with keep-daily 7"
conf ''

echo "--- check and restore test, per target"
offsite check 100% >/dev/null 2>&1 && ok "restic check on both, all data read back" || bad "restic check"
for t in r2 b2; do [[ $(jq -r .result "$T/state/check-$t.json") == ok ]] && ok "$t: check-$t.json ok" || bad "$t: check result"; done
if offsite restore-test 2>"$T/err3"; then
    for t in r2 b2; do
        r=$(cat "$T/state/restore-test-$t.json")
        [[ $(jq -r '.result' <<<"$r") == ok && $(jq -r '.unreadable' <<<"$r") == 0 && $(jq -r '.files' <<<"$r") -ge 2 ]] \
            && ok "$t: $(grep "^$t: restore test" "$T/err3")" || bad "$t: restore test: $r"
    done
else bad "restore test: $(tail -3 "$T/err3")"; fi
[[ -z $(ls -A "$T/state/restore-test" 2>/dev/null) ]] && ok "restore test cleaned up" || bad "restore test left its scratch folder"

echo "--- a full restore compares equal"
offsite restic r2 restore latest --target "$T/out" >/dev/null 2>&1
if diff -r "$T/src/etc" "$T/out$T/src/etc" >/dev/null && cmp -s "$T/src/svc-a/backups/a-20261005T0400Z-nightly.dump" "$T/out$T/src/svc-a/backups/a-20261005T0400Z-nightly.dump"; then
    ok "settings and the dump come back byte for byte"
else bad "the restore differs from the sources"; fi
pg_restore --list "$T/out$T/src/svc-a/backups/a-20261005T0400Z-nightly.dump" | grep -q "TABLE public t" && ok "the restored dump lists its table" || bad "the restored dump doesn't list"

echo "--- the wrong password is refused"
cp "$T/etc/credentials/restic-password" "$T/pw.keep"
echo wrong > "$T/etc/credentials/restic-password"
if offsite backup 2>/dev/null; then bad "a backup ran with the wrong password"
else [[ $(offsite status | jq -r '[.targets[].state] | unique | join(",")') == failed ]] && ok "wrong password: both targets fail and say so" || bad "status after a wrong password: $(offsite status)"; fi
cp "$T/pw.keep" "$T/etc/credentials/restic-password"

echo
echo "  offsite: $pass passed, $fail failed"
(( fail == 0 ))
