# Tutorials: a blog and a to-do list, in HTML/JavaScript and in PHP

Status: **LIVE since 2026-09-22 (release 2f35c44e; blog comments in aa5684e5).** Server side (V1-V7, P1-P7) and the four tutorials
(T1-T4): see "Progress" at the end. Next: build.sh, install, verify, sync the guides. Asked for by momolig: four step-by-step tutorials in her
guides -- a blog and a to-do list, each once with plain HTML/CSS/JavaScript and once with PHP --
that take Pamela from designing the tables to a working page, with code to copy and every step
explained. momolig said yes to all six suggestions below ("these are fine, let's do it").

Two things were missing on the server before the tutorials could be honest:

1. **PHP did not run on pammy.org** (no PHP on the host; `.php` files were served as text).
2. **A page could not safely change data**: without a key the data API only reads, and a key
   in a page's JavaScript is readable by everyone. The blog is fine (visitors read; she writes
   in the panel); a to-do list is not.

## Decisions

| # | Decision |
|---|---|
| T1 | Four new guides, on the Help tab like the others: **15** blog (HTML/JS), **16** blog (PHP), **17** to-do list (HTML/JS), **18** to-do list (PHP). Written for her: good HTML/CSS, some JavaScript, very little SQL, never written PHP. |
| T2 | **The code in a guide is real code.** Every file she is told to copy lives in `tutorials/<name>/` and the guide prints it verbatim (a unit test compares them). The HTML/JS ones run in the browser tests against the real gate; the PHP ones run in PHP 8.3 (the WordPress CLI image) against the real gate. A later change to the panel cannot quietly break what a guide tells her to copy. |
| T3 | The blog tutorials build what the blog example is (posts, authors, topics, rich text, comments) -- by hand, so she learns each step -- but smaller: posts, authors, topics. |
| T4 | The to-do list is **one list per signed-in person**, inside a protected folder; the owner is filled in by the gate (JS) or by her PHP from the gate's word (PHP), never by what the page sends. Comments are used as **notes on a task**, only in the signed-in folder. |

### V: "People signed in to a folder can change these" (for T4, JavaScript)

| # | Decision |
|---|---|
| V1 | A new setting on a thing's page, under "Anyone can read these": **"People signed in to a protected folder"** -- choose the folder; they can then do what the thing's switches allow (add, look, change, delete), through the data API, with no key. |
| V2 | **"Each person only sees their own"**, by a short-text field she picks (e.g. `owner`). The gate writes the signed-in username into it on every new record, whatever was sent; reads, changes and deletes only ever reach rows where it is that person's name. A change can't move a row to someone else. |
| V3 | The folder is stored by the gate's **area id**, so renaming or moving the folder keeps it. A folder that stops being protected (area deleted) means nobody can write -- fails closed. |
| V4 | Only through the visitor's own session cookie, on the same hostname, and a write must carry an `Origin` of the site itself (the cookie is SameSite=Lax too). Reading and writing still need the API's two main switches on (Letting programs in). |
| V5 | Visitor answers are `private, no-store`; a visitor's allowance is per session, like a key's. |
| V6 | Connections in an answer (`{id,label}`) only from things that visitor could read by themselves. |
| V7 | Setting it asks for the passkey (it lets people change her data), like "Anyone can read these". |

### P: PHP on her website (for T1's PHP tutorials)

| # | Decision |
|---|---|
| P1 | `.php` files anywhere in her website run, through **pammy-php** (PHP 8.3 FPM), its own service and user `svc-pammyphp`. They pass the gate first, like every file: a PHP page in a protected folder is protected. |
| P2 | Its cage: reads her website (www-data group, like nginx), writes nothing but a private /tmp, **no network at all** (PrivateNetwork), no capabilities; her app folder, her home, the panel's secrets, WordPress and TLS keys invisible. |
| P3 | The one thing PHP can talk to is the **gate's data and forms API, over a unix socket** (`/run/pammy-gate-php.sock`, root:svc-pammyphp 0660, from pammy-gate-php.socket). Only `/_pammy/api/...` answers there. So a PHP page can't reach the panel, the other sites' apps, or any database directly. |
| P4 | A PHP page inside a protected folder is told who is signed in: `$_SERVER['PAMMY_USER']` (from the gate's check, never from the request). Empty elsewhere. |
| P5 | A `.php` file is **never** served as text any more: if PHP is down it's an error page, not the code (so a key kept in a `.php` file stays secret). Dotfiles and `/api/` stay as they were. |
| P6 | The distribution's own `php8.3-fpm` service is masked; only pammy-php runs PHP. |
| P7 | Where the socket is, is given to PHP as `PAMMY_API_SOCKET`; the tutorials' small `api()` function uses it with curl. |

## Progress

**2026-09-22, server side built and tested (not installed).**

- V1-V7 (visitors change data): gate + panel + migration `0014-visitors.sql` (`visitor_area` is
  `bigint`, like every id). Unit tests 786/786 (gate 160/160), typecheck clean.
- P3 (PHP's door): `src/gate/php-socket.ts`, `deploy/pammy-gate-php.socket`; the gate unit now
  lists `Sockets=pammy-gate-admin.socket pammy-gate-php.socket` (main.ts tells them apart by
  LISTEN_FDNAMES).
- P1, P2, P5-P7: `deploy/pammy-php.service`, `deploy/php/php-fpm.conf`, `deploy/php/php.ini`,
  `deploy/nginx/php.conf` (included from gate.conf, so her vhost file is unchanged).
- Installer: user svc-pammyphp; `php8.3-fpm` masked *before* apt installs php8.3-fpm +
  php8.3-curl; `/etc/pammy-php`; units; PHP started before nginx is switched; healthy() asks
  the gate's PHP socket as svc-pammyphp. On rollback to a release without PHP it switches PHP
  off and takes the PHP socket out of the gate's unit (the old gate only listens when it is
  handed exactly one socket).
- verify-panel.sh: "PHP pages" section (user, sockets, sandbox via nsenter, systemd
  properties, a real .php through Cloudflare on both addresses, .PHP 404) and PHP in the real
  protected folder (sign-in first; PAMMY_USER; forged header ignored; private, no-store).
- test/run-gate-nginx-test.sh: real pool + php.ini in `php:8.3-fpm` (no network) behind the
  real vhost: 161/161.

Gotchas found:
- An `auth_request_set` inside a location hides the server-level ones: the PHP location lost
  `private, no-store` and its sign-in redirect went nowhere. `$pammy_user` is set in gate.conf.
- gate.conf's regexes come before the vhost's dotfile deny, so php.conf skips dot-paths
  itself; `.hidden.php` gets 404 from the never-as-text rule, never runs.
- In the unit tests, sign in by `area: tokens.A`, not by page (earlier tests move the pages),
  and set bob's password yourself (an earlier test changes it).
- A filtered `node --test --test-name-pattern` run of gate.test.ts hangs; the full file finishes.

**2026-09-22, the tutorials written and tested (not installed).**

- Code: `tutorials/journal` (15), `tutorials/journal-php` (16), `tutorials/todo` (17),
  `tutorials/todo-php` (18) -- the folder names she makes under /pamela/public.
- Guides (masters in ~/pamela-setup, in guides.map): blog-with-javascript-guide.txt ->
  15-a-blog-with-javascript.txt, blog-with-php-guide.txt -> 16-a-blog-with-php.txt,
  todo-with-javascript-guide.txt -> 17-a-to-do-list-with-javascript.txt,
  todo-with-php-guide.txt -> 18-a-to-do-list-with-php.txt.
- Databases: `journal` (posts: title, body rich, published, published_on, author_id; authors;
  topics; post_topics) and `todo` (tasks: title, done, owner). 16 shares 15's database, 18
  shares 17's (the same tasks show on both pages).
- T2 tests: `test/tutorials.test.ts` (every file printed whole; every code-looking block is a
  word-for-word piece of a file, bar two listed PHP illustrations; the catalog the code relies
  on) and `test/run-tutorials-test.sh` (real vhost + gate.conf/php.conf, real pool in
  php:8.3-fpm, real gate, the databases built with the panel's own functions in
  `test/tutorials-world.ts`, Chromium doing what the guides say: 45/45). Unit 800/800.

Changes made on the way:
- T4: **no "notes on a task" (comments)**. Every comment waits for her approval and is seen by
  everyone in the folder, so it can't be a private note. Pointed to from "Making it yours"
  instead of built.
- P1: `index.php` is a folder's home page (php.conf adds `index index.php`; the gate's
  no-home-page welcome, its folder listing and sitefs's hasIndex know it too). Without it
  pammy.org/journal-php/ was a 403.
- The to-do page shows the USERNAME, not the name: guide 09 promises the name is only hers.
- src/help.ts: `<?` on an example's main lines makes it code (a PHP page's lines). A wider
  rule (lines ending in `;`) was tried and dropped: it changed how guide 05 and 10 parse.
- The browser test must never use Playwright's `context.request` (it skips routing, and went to
  the real pammy.org once), and redirects handed to `route.fulfill` aren't routed again: the
  test answers a navigation redirect with a meta refresh, and `--host-resolver-rules=MAP *
  ~NOTFOUND` makes any escape fail instead of reaching the internet.

**2026-09-22, the tutorial examples (built, not installed).** At momolig's request, finished working
copies of all four tutorials are in the control panel (Databases > Tutorial examples), with their
own example databases, and nothing on pammy.org: docs/tutorial-examples-plan.md. Each guide's
intro now points there. Also: `index.php`/`.php` count as home pages and pages in the gate's
folder listing; the Help parser treats `<?` as HTML.
