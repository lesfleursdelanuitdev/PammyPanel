#!/usr/bin/env bash
# Build a release of the panel, as momolig (no sudo): typecheck, build the
# front end (sites/pammy/web + packages/*/web -> public/), run every test including the browser tests,
# then assemble release/ with production dependencies only.
#   ~/pamela-setup/panel/build.sh            (refuses uncommitted changes)
#   ~/pamela-setup/panel/build.sh --dirty    (builds them anyway, and says so in BUILD)
#   ~/pamela-setup/panel/build.sh --tier fast|full|release   (docs/ci-plan.md: how far to go;
#       fast = typecheck, front end, widgets, unit tests; full = every test, no release/;
#       release = everything, the default, as before)
# Then deploy it: sudo ~/pamela-setup/panel/deploy/install-panel.sh
# (and lfdln's release-lfdln/: sudo ~/pamela-setup/panel/deploy/lfdln/install-lfdln.sh, phase 5 step 2)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
dirty=0 tier=release
while (( $# )); do
  case $1 in
    --dirty) dirty=1 ;;
    --tier) (( $# >= 2 )) || { echo "build.sh: --tier needs fast, full or release" >&2; exit 2; }; tier=$2; shift ;;
    --tier=*) tier=${1#--tier=} ;;
    *) echo "build.sh: unknown option $1 (--dirty, --tier fast|full|release)" >&2; exit 2 ;;
  esac
  shift
done
[[ $tier == fast || $tier == full || $tier == release ]] || { echo "build.sh: --tier is fast, full or release" >&2; exit 2; }
# as root, release/ (and more) would end up root's, and the next build as yourself can't replace it
[[ $EUID -ne 0 ]] || { echo "run build.sh as yourself, without sudo (only deploy/install-panel.sh needs sudo)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) {console.error("needs node >= 22.18 (type stripping)"); process.exit(1)}'
[[ -d node_modules ]] || npm ci --no-audit --no-fund

# a live release/BUILD leads back to its source (docs/refactor-plan.md phase 0.1):
# the commit it was built from, checked before the tests, not after
commit=$(git -C .. rev-parse --short=12 HEAD)
if [[ -n $(git -C .. status --porcelain) ]]; then
  (( dirty )) || { git -C .. status --short >&2; echo "uncommitted changes in ~/pamela-setup (above): commit them first, or build with --dirty" >&2; exit 1; }
  commit="$commit+dirty"
fi

# One test run at a time on this server (docs/ci-plan.md CI-Q3): the harnesses listen on
# fixed ports, so a build and the CI runner (or two builds) at once would trip over each
# other. Every build.sh and the runner take this lock around the tests. Opened read-only:
# /run/lock is sticky, so whoever made the file owns it, and flock needs no write access.
TEST_LOCK=/run/lock/lfdln-tests.lock
take_test_lock() {
  [[ -e $TEST_LOCK ]] || (umask 022 && : > "$TEST_LOCK") 2>/dev/null || true
  exec 9<"$TEST_LOCK"
  if ! flock -n 9; then
    echo "--- waiting for another test run on this server to finish (a build.sh or the CI runner: $TEST_LOCK)"
    flock 9
  fi
}

echo "--- typecheck (server, both sites' pages, her site's components)"
# one command per line: set -e ignores a failure anywhere but last in an && list, so a chain
# let the 8b-7 build go on past a type error (and skip the pages' checks) without stopping
npx tsc --noEmit
npx tsc --noEmit -p sites/pammy/web
npx tsc --noEmit -p sites/pammy/widgets
npx tsc --noEmit -p sites/lfdln/web
echo "--- front end (pammy.org -> public/, lfdln -> public-lfdln/)"; npx vite build --config sites/pammy/web/vite.config.ts --logLevel warn
npx vite build --config sites/lfdln/web/vite.config.ts --logLevel warn
# the rich-text editor is fetched on a phone the first time she opens a form with
# one (docs/rich-text-plan.md T28): a limit written down, so it cannot quietly grow
rich=$(gzip -c public/assets/rich-text-*.js | wc -c)
(( rich <= 160000 )) || { echo "the rich-text editor is $rich bytes gzipped, over the 160000 allowed (build.sh)" >&2; exit 1; }
# the <pammy-*> widgets on her pages (Lit): packages/*/widgets/*.ts -> public-gate/{login,forms,comments}.js
echo "--- widgets"; for c in login forms comments; do PAMMY_COMPONENT=$c npx vite build --config sites/pammy/widgets/vite.config.ts; done
take_test_lock
echo "--- unit/API tests"; node --disable-warning=ExperimentalWarning --test --test-reporter=dot test/*.test.ts
if [[ $tier == fast ]]; then echo "ok: fast tier passed (commit $commit)"; exit 0; fi
echo "--- nginx test (panel.pammy.org)"; test/run-nginx-test.sh
echo "--- nginx test (password-protected folders, the real pamela vhost)"; test/run-gate-nginx-test.sh
echo "--- nginx test (the same, through pammy.org's hosts as rendered, side by side with the pamela vhost: docs/phase8-plan.md 8-7a)"; VHOST=hosts test/run-gate-nginx-test.sh
echo "--- nginx test (lfdln's hosts and site folders, docs/hosts-plan.md)"; test/run-hosts-nginx-test.sh
echo "--- nginx test (accounts on a route, docs/roles-plan.md step 5)"; test/run-route-accounts-nginx-test.sh
echo "--- nginx test (taking over the hand-written files, docs/adopt-plan.md)"; test/run-adopt-nginx-test.sh
echo "--- nginx test (git over HTTPS: real git through the rendered git site, docs/phase8b-plan.md 8b-7)"; test/run-git-nginx-test.sh
echo "--- moving the apps' databases (throwaway Postgres 15 and 17, docs/data-move-plan.md)"; test/run-move-db-test.sh
echo "--- the apps onto pasta (to-pasta.sh against stand-ins, docs/s1-plan.md S1f)"; test/run-to-pasta-test.sh
echo "--- off-server copies: the real restic against a throwaway MinIO (docs/recovery-plan.md R1)"; test/run-offsite-test.sh
echo "--- tutorials (guides 15-18 and their examples: nginx, PHP, the gate, a browser)"; test/run-tutorials-test.sh
echo "--- projects: each kind made and built for real in the build image (docs/phase8b-plan.md 8b-2; needs the internet)"; test/run-projects-builds-test.sh
echo "--- browser tests (Playwright, headless Chromium)"
npx playwright install --only-shell chromium >/dev/null     # downloads it once, into ~/.cache/ms-playwright
# the iPhone (WebKit) run of the phone tests, when its system packages are there (playwright.config.ts)
[[ ${PAMMY_E2E_WEBKIT:-} != 1 ]] || npx playwright install webkit >/dev/null
rm -rf test/e2e/.state
npx playwright test -c test/e2e/playwright.config.ts --reporter=dot
echo "--- browser tests, lfdln's panel (docs/lfdln-standup-plan.md L9)"
rm -rf test/e2e-lfdln/.state
npx playwright test -c test/e2e-lfdln/playwright.config.ts --reporter=dot
exec 9<&-      # the tests are done: the next run on this server may start
if [[ $tier == full ]]; then echo "ok: full tier passed (commit $commit)"; exit 0; fi

echo "--- release"
rm -rf release && mkdir release
# db/ comes too: the services check the migration list on start (src/pg.ts
# checkSchema), the installer runs the migrations from it, and verify-panel.sh
# checks the live schema against db/schema.snapshot.sql. tools/ is what the
# installer and the checks run (migrate.ts, schema-snapshot.ts).
# the pages' and widgets' sources stay behind: what they became is in public/ and public-gate/
rsync -a --exclude='/*/*/web/' --exclude='/*/*/widgets/' src packages sites public public-gate db tools tutorials package.json package-lock.json release/
# Pamela's guides, for the Help tab: the same files sync-pamela-guides.sh gives her, and
# the map, which gives the Help tab their order and its words (docs/phase9-plan.md 9-1)
mkdir release/help
grep -vE '^\s*(#|$)' ../guides.map | while read -r src dst _; do cp "../$src" "release/help/$dst"; done
cp ../guides.map release/help/guides.map
# WordPress's nginx templates, which the software helper renders its placement
# files from (src/apps/nginx.ts): the same ones place-wordpress.sh uses
mkdir -p release/apps/wordpress-nginx
cp ../wordpress/nginx/templates/* ../wordpress/nginx/proxy.conf ../wordpress/nginx/cookie-map.conf release/apps/wordpress-nginx/
# ...and the settings a new WordPress gets (src/apps/install.ts WP_CONFIG_FILES)
mkdir -p release/apps/wordpress-config
cp ../wordpress/config/php.ini ../wordpress/config/wp-cli.yml ../wordpress/config/auto-updates.php release/apps/wordpress-config/
# the release's own node_modules first: without them its code would find the
# packages here, in the working copy, through ../node_modules (the check below
# caught that on 2026-09-24)
(cd release && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# every file the software helper reads beside its code, where the release's own
# code looks for it (a missing one stopped a live install at its second step)
node --disable-warning=ExperimentalWarning --input-type=module -e "
  import { existsSync } from 'node:fs';
  import { join } from 'node:path';
  import { TEMPLATES, WP_CONFIG } from './release/src/apps/ops.ts';
  import { BACKUP_SCRIPT, WP_CONFIG_FILES } from './release/src/apps/install.ts';
  import { PLUGIN } from './release/src/apps/mail.ts';
  const need = [BACKUP_SCRIPT, PLUGIN, ...WP_CONFIG_FILES.map((f) => join(WP_CONFIG, f)),
    ...['main-root.conf', 'main-static.conf', 'path-block.conf', 'server-subdomain.conf', 'proxy.conf', 'wp.php'].map((f) => join(TEMPLATES, f))];
  const missing = need.filter((f) => !existsSync(f) || !f.startsWith(process.cwd() + '/release/'));
  if (missing.length) { console.error('the release is missing what the software helper reads: ' + missing.join(' ')); process.exit(1); }
" || exit 1
{ echo "built $(date -u +%FT%TZ) by $(id -un) from commit $commit"
  (cd release && find src packages sites public public-gate db tools tutorials help apps package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); } > release/BUILD
echo "ok: release/ ($(du -sh release | cut -f1), $(tail -1 release/BUILD))"

# lfdln's release (docs/lfdln-standup-plan.md): the same packages and migrations, its own
# pages as public/, the gate's files (its gate reads them: docs/accounts-plan.md step 3),
# and no src/ (its units name sites/lfdln/src/ themselves). Its node_modules are the
# same production set as pammy.org's.
rm -rf release-lfdln && mkdir release-lfdln
rsync -a --exclude='/*/*/web/' --exclude='/*/*/widgets/' packages sites db tools public-gate package.json package-lock.json release-lfdln/
rsync -a public-lfdln/ release-lfdln/public/
# lfdln's own guides, for its Help page (docs/phase9-plan.md 9-1), and their map
mkdir release-lfdln/help
grep -vE '^\s*(#|$)' ../lfdln-guides/guides.map | while read -r src dst _; do cp "../lfdln-guides/$src" "release-lfdln/help/$dst"; done
cp ../lfdln-guides/guides.map release-lfdln/help/guides.map
(cd release-lfdln && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
{ echo "built $(date -u +%FT%TZ) by $(id -un) from commit $commit"
  (cd release-lfdln && find packages sites public public-gate db tools help package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); } > release-lfdln/BUILD
echo "ok: release-lfdln/ ($(du -sh release-lfdln | cut -f1), $(tail -1 release-lfdln/BUILD))"
