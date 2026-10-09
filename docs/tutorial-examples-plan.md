# Tutorial examples: the finished tutorials, on panel.pammy.org

Status: **LIVE since 2026-09-22** (with the tutorials, docs/tutorials-plan.md; journal comments since aa5684e5).

Asked for by momolig: "All examples for the tutorials should be on panel.pammy.org, not on
pammy.org" -- finished, working copies of what guides 15-18 build, in the control panel (like
Databases > Database examples), with example databases the panel owns. Pamela still builds her
own copy on pammy.org by following a guide. panel.pammy.org stays as it is: no new hostname
(examples.panel.pammy.org would need a second-level certificate Cloudflare's free plan doesn't
give).

## Decisions

| # | Decision |
|---|---|
| E1 | **Databases > Tutorial examples** (managers only, like the Databases menu): the four pages framed, each with Computer/Phone, "Open it in a tab", its guide on the Help tab, and the two databases' canvas and app settings. One "Set up" / "Put them back as they were" for both. |
| E2 | Two databases the panel owns, on Postgres: `example_journal` (guides 15, 16; sample authors, topics and posts, one unpublished) and `example_todo` (17, 18). Their tables are `journalSnapshot()` / `todoSnapshot()` in src/studio/tutorial-examples.ts -- the same functions the tutorials' tests draw theirs with. `studio_databases.example` is `tutorial-journal` / `tutorial-todo` (the CHECK is widened in 0014). Like the database examples they can't be deleted, renamed or switched off, and aren't in the menu. Set up with the same `remakeExampleDatabase` + `fillDatabase` as the database examples. |
| E3 | **The pages are the tutorials' own files** (release `tutorials/`), written at set-up into `/var/lib/pammy-tutorial-examples/<folder>/` (svc-pammypanel:svc-pammyphp 2750, files 0640) by src/tutorial-demos.ts, with only the database name changed (`journal` -> `example_journal`, `todo` -> `example_todo`) and the examples' own key in `todo-php/settings.php`, plus a stand-in `logout.html` for the to-do lists. test/tutorials.test.ts checks nothing else differs. |
| E4 | The panel serves their HTML/CSS/JS at `/tutorial-examples/<folder>/` (signed-in managers only, else 401; CSP `frame-ancestors 'self'`, script/connect `'self'`); never a `.php` (404). |
| E5 | Their questions to `/_pammy/` on panel.pammy.org are answered by the panel: `/_pammy/me` is the panel account; `example_journal` reads are passed to the gate's HTTP port as her site would ask (no key); `example_todo` goes to the gate with the examples' key, the panel doing what guide 18's PHP does -- owner written in on every new task, the list asked for `where.owner=<account>`, a task looked at before it is read, changed or deleted. So in the example each panel account has its own list. |
| E6 | The PHP pages (journal-php, todo-php): nginx on panel.pammy.org (deploy/nginx/panel-tutorial-examples.conf) asks the panel `/api/tutorial-examples/who` first (401 = PHP never runs), then hands them to **pammy-php's second pool** `[tutorial-examples]` (`/run/pammy-php/examples.sock`), whose open_basedir is the examples' folder only. `PAMMY_USER` = the panel account; `HTTP_COOKIE` is emptied (PHP never sees the panel's session). pammy-php's sandbox: `TemporaryFileSystem=/var/lib:ro` + `BindReadOnlyPaths=-/var/lib/pammy-tutorial-examples`. |
| E7 | Nothing of it is on pammy.org. |
| E8 | **Comments** (guides 15, 16 PART 10 / PART 5): her journal uses the comment area `journal-comments` (records of kind `posts`, content-id = the post's id). The example uses its own, `example-journal-comments` -- a fixture like the blog example's (`tutorial-journal-comments`), put back at set-up with three sample comments, filed under the example page `_pammy/examples/tutorial-journal/`; no database link. The panel passes `/_pammy/comments.js` and GET/POST `/_pammy/comments/example-journal-comments[/form|/counts]` to the gate as from that example page (Origin https://pammy.org, the visitor's IP), managers only, that area only. New comments wait for an OK on the Comments tab like any example's. The demo pages allow inline styles (the component's), like the gate's own example pages. |

Accepted trade-off: the JavaScript examples run on the panel's own origin, so they could call the
panel's API as whoever is signed in. They are our fixed files; the only outside content is rich
text, cleaned by the same sanitizer as the panel's own record pages.

## Tests

- test/tutorials.test.ts: the examples' files vs the tutorials' (only the expected lines differ),
  the examples' tables vs the guides'.
- test/e2e/35-tutorial-examples.spec.ts: set up in the browser; 15 and 17 working in their frames
  through the panel and the real gate; an owner sent along is ignored; 401 when not signed in;
  never a .php as text; the databases badged and not deletable.
- test/run-tutorials-test.sh (last section): the real panel snippet and second pool, in
  php:8.3-fpm, the copies written by src/tutorial-demos.ts, a stand-in for "who": 16 and 18
  working, each account its own list, 401 when not signed in, PHP sees neither the panel's cookie
  nor her website, settings.php empty, other .php 404.
- deploy/verify-panel.sh: folder and socket permissions, PHP's view of /var/lib, the key file
  unreadable by www-data and pamela, 401s through Cloudflare, nothing on pammy.org.
