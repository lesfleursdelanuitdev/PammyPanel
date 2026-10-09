# Test report

A full run of the test suite on **2026-10-09**, against the same code as this repository (private working repository, commit `8dab81f`). It ran with `./build.sh --tier full` on the project's own Linux server, the same way every release is tested before it is installed.

**Result: 2,956 checks passed, 0 failed.** The run took 41 minutes, most of it waiting for the throwaway databases and nginx instances to start and stop.

## What ran

| Stage | What it checks | Passed | Failed |
|---|---|---|---|
| Type checks | `tsc --noEmit` for the server, both sites' front ends and the web components | ✓ | — |
| Front-end builds | Vite builds of both panels and the three web components, plus a size limit on the rich-text editor bundle | ✓ | — |
| Unit and API tests | `node --test test/*.test.ts` (71 files): modules, migrations, permissions, the nginx renderer, coupling and boundary rules | 1,918 | 0 |
| nginx: panel | Only Cloudflare may connect; the real visitor IP comes only from `CF-Connecting-IP`; other hostnames never reach the panel | 34 | 0 |
| nginx: protected folders | Signed-out visitors always get a sign-in redirect and never content; forms, media, PHP pages, WordPress placements; what happens if the gate stops | 181 | 0 |
| nginx: the same, rendered from data | The same checks against nginx files generated from the hosts tables, side by side with the hand-written ones | 179 | 0 |
| nginx: hosts and site folders | Several domains, single-page apps, several routes per host; the routing helper's apply on a second nginx; the renderer refusing input that could break out of a file | 70 | 0 |
| nginx: accounts on routes | Sign-in in front of hosted services; the gate's cookie never reaching the app | 81 | 0 |
| nginx: taking over hand-written files | Adopting existing nginx config without changing what it serves | 32 + 25 | 0 |
| Git over HTTPS | Real `git clone` and `git push` through the rendered git site, tokens required | 27 | 0 |
| Moving app databases | A live move between throwaway Postgres 15 and 17: row counts and checksums, owners and privileges, secrets rewritten, and a forced failure that must roll everything back | 83 | 0 |
| Apps onto private networking | The script that moves app containers onto pasta port forwards, against stand-ins | 34 | 0 |
| Off-site backups | The real `restic` against a throwaway S3 store: back up, check and restore | 30 | 0 |
| Tutorials | The four guide projects (blog and to-do, in JavaScript and PHP) through nginx, PHP, the gate and a browser | 67 | 0 |
| Projects | Each project kind (Next.js, Vite and so on) created and built for real in the build image | 11 | 0 |
| Browser tests: pammy.org panel | Playwright, headless Chromium, desktop and phone, with a virtual passkey authenticator | 122 | 0 |
| Browser tests: lesfleursdelanuit.com panel | Playwright, the second site's panel | 62 | 0 |

## How the tests are isolated

- Every database, nginx and S3 store in these tests is a throwaway container or process, started for the test and removed afterwards. Nothing touches the live sites.
- One run happens at a time on the server. The suites listen on fixed ports, so `build.sh` takes a shared lock, and other runs wait their turn.
- Browser tests sign in with a WebAuthn virtual authenticator, so passkey sign-in is tested for real.

## What this report does not cover

- **The live-server verify scripts.** After each install, `deploy/verify-panel.sh` and `deploy/lfdln/verify-lfdln.sh` check the running sites: services, permissions, nginx, schema and pages. They run on the server only, and their results aren't part of this report.
- **CI on GitHub.** There is none. Most suites need Postgres, nginx and container tooling, so they run on the server.
- **Safari.** The iPhone (WebKit) run of the phone tests is off by default, because WebKit needs system packages the server doesn't have.
