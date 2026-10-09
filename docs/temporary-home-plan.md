# A temporary home page, and comments' own guide

Status: **built 2026-09-23 as release 334cc5743657c80d (commit 5b1e91b), not installed** (it carries Getting started, migration 0017, too). Asked for by momolig the same day; one release (decision 5).

## Decisions (momolig, 2026-09-23)

| # | Decision |
|---|---|
| 1 | Comments get their own guide, **guide 20** (`comments-guide.txt` -> `20-comments.txt`). Guide 10 PART 18 stays, as a pointer **to guide 20**. |
| 2 | The temporary page is offered **only for top-level folders that can be subdomains**. |
| 3 | It **matches her site's look**: she picks one of her stylesheets. |
| 4 | **Protected folders are left out**: after sign-in the gate already shows its welcome page. |
| 5 | Guide 20 and the temporary page ship **in one release**. |

## Why

A folder with no `index.html` (or `index.php`) answers **"403 Forbidden"** from nginx, a bare
error page. New subdomains got a starter page, but folders made in the File Explorer, by upload or
in WinSCP had nothing.

## As built

- **`src/sitefs/home-page.ts`** (the website helper, as pamela). Ops `home-page-get`, `home-page-save`,
  `home-page-remove`. A folder qualifies when it matches `SUBDOMAIN_RE`, isn't reserved, is a real
  folder (not a shortcut) and has no `.pammy-protected` marker.
  - The page carries `<meta name="generator" content="pammy-temporary-page">` and her words as
    base64 JSON in a comment, so the panel can offer them again. Only a page with that marker (or an
    old starter page's comment) is ever changed or removed; `index.php` or any other `index.html` is hers.
  - Her words are escaped. Paragraphs are split on blank lines. Heading up to 120 characters,
    message up to 2000.
  - Looks: `plain`, `folder:<file>.css` (a relative href), or `site:<file>.css` (by its whole
    address, `https://pammy.org/<file>`, because the folder is its own subdomain too). The helper
    lists the choices itself and refuses anything else.
  - The page is written beside the old one and renamed over it (0644; the web root's setgid gives
    group www-data).
  - A new subdomain's starter page is now one of these (heading = folder name, "Coming soon.").
- `listFolders` adds `homePage` (`none` | `own` | `temporary`) and `protected`; `hasIndex` stays.
- Panel routes `GET/POST /api/sites/:name/home-page`, `POST .../home-page/remove`; activity
  `home-page-made` / `-changed` / `-removed`.
- Web: `components/home-page.tsx`, used in the rows of Subdomains ("no home page", "temporary
  page", Make / Change the words / Remove).
- Guides: 08 PART 5 "A temporary home page", 06 (making one in WinSCP; 403 Forbidden).
- Guide 20: all of the old guide 10 PART 18, plus guide 14's comments-in-your-app text (guide 14
  keeps a pointer) and the blog example's comments. Every reference moved: guides 14, 15, 16 and
  19, the tutorial files and the blog example's page, the Comments page's link (`/help/comments`),
  and Getting started. Accounts kept to one folder see guide 20 too.
- Tests: sitefs.test.ts (the ops, refusals, stylesheets, escaping, starter page, old starter),
  panel.test.ts (routes and activity), e2e 03 (made, changed, removed), help.test.ts (21 guides),
  verify-panel.sh (the live starter page's words changed through the helper, escaped).
