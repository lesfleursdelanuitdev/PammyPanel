# Rich text: a field she writes in with bold, headings, lists and links

Status: **built 2026-09-22, not installed** -- release `dbf7a38999c504fc` (unit/API 749, panel
nginx 24, gate nginx 133, browser 96 incl. 7 phone tests). momolig said "let's implement it",
taken as yes to Q1, Q2, Q4 and Q5 as suggested.

### As built -- what differs from the plan, and what was found

- **T16, size on MariaDB:** the panel cannot tell TEXT from LONGTEXT (both are `text`), so it
  does not pre-check bytes. MariaDB runs strict and refuses (errno 1406); `src/pammydb/maria.ts`
  turns that into her words ("body is too long for this field: ... about 65,000 letters ...").
  Proved on real MariaDB 11.4 (`test/pammydb.test.ts`): refused, and the old value still there.
- **Saving a long post was impossible before rich text too:** nginx (64k) and the panel (64k)
  refused any record over 64 KB. `/api/app/.../new` and `.../save` now take 2 MB (nginx location
  + route `bodyLimit`; `test/run-nginx-test.sh` checks both ways). What is *sent* may be up to
  500,000 characters (`MAX_RICH_SENT`); what is *kept*, 100,000.
- **The gate's data API writes were capped at 8 KB** (the gate's `bodyLimit`, and 64k in
  nginx's gate.conf). Fixed 2026-09-22 at momolig's word: `.../new` and `.../:id/save` take
  2 MB (a location nested in gate.conf's `^~ /_pammy/`, since a `^~` stops nginx looking at
  regex locations outside it; route `bodyLimit` in data-api.ts). A write with no key is refused
  in `onRequest`, before its body is read. Everything else under /_pammy/ keeps 64k / 8 KB
  (`test/run-gate-nginx-test.sh`, 139 checks).
- **Q4 nofollow** is on every absolute http(s) link, including ones to pammy.org (the cleaner
  does not know the domain; harmless).
- **Phone toolbar (T23):** the native paragraph-style `<select>` was too wide for one row at
  412px, so on a phone it is a button opening a "Paragraph style" sheet; on a computer it is
  still the select. Buttons 44px, row checked to fit without scrolling.
- **WebKit / iPhone:** `iphone` project in `test/e2e/playwright.config.ts`, off unless
  `PAMMY_E2E_WEBKIT=1` -- WebKit needs 113 system packages here
  (`sudo npx playwright install-deps webkit`, a momolig decision). The browser itself is
  downloaded (`~/.cache/ms-playwright/webkit-2359`).
- **Editor size:** 138 KB gzipped, loaded only on a form with a rich-text field; `build.sh`
  fails over 160,000 bytes (T28).
- **Guides:** guide 13 is not the data-API guide; the changes are in guide 14: PART 12 ("How it
  is filled in"; the stale "no page for choosing tags" sentence fixed), PART 13 ("Writing with
  formatting", "Showing rich text on a page"), PART 16, and two troubleshooting entries.

Found by the tests, all fixed:
1. **sanitize-html leaks a renamed tag's name** onto the next closing tag at the same depth when
   a transform renames to a disallowed tag (`<a ...>ok</pammy-unwrap>`). Tags to unwrap now keep
   their name and are marked by their attributes object for `exclusiveFilter`.
2. **The link sheet's submit saved the whole record**: React passes a submit from a portal to
   the form around the editor. `stopPropagation()`.
3. **blog.js took "rich" from the topics answer too** (`rich: []`), so the body showed as text.
   Only the posts' answer sets it now.
4. **On a phone the toolbar made the whole page wider** (grid item `min-width: auto`), so sheets
   were wider than the screen and taps missed. `min-w-0` on the editor.
5. **The editor's loading stand-in was labelled as the field** (15px), and tests measured it.

### Run sheet

1. `sudo ~/pamela-setup/panel/deploy/install-panel.sh` (new nginx location; the database helper
   changed too: maria.ts)
2. `sudo ~/pamela-setup/panel/deploy/verify-panel.sh`
3. `sudo ~/pamela-setup/sync-pamela-guides.sh` (guide 14 changed)
4. If the blog example was set up before this, "Put it back as it was" on it, so its posts are
   stored as rich text and its body field is switched to Rich text.
5. **By hand, on a real iPhone and a real Android phone** (T26, T27), on panel.pammy.org, in the
   blog example: write a post with a heading, a list, a link and a table; swipe-type a sentence;
   dictate one; paste from Google Docs; save; reopen; view "Starting a kitchen garden" on the
   blog page. Only then tell Pamela.

---

Original status: **plan only, 2026-09-21.** Asked for by momolig 2026-09-21 ("allow Pamela to set some of
the input fields on the app to rich text fields that use a rich text editor ... then ensure we
properly process the input"). No code yet. Decisions marked *(Claude)* are suggestions waiting for
momolig's yes.

momolig's answers (2026-09-21):
- **Tables inside the text: yes** (Q3) -- see T17-T20.
- **The blog example switches to rich text: yes** (Q6).
- **Tiptap and sanitize-html: both fine** (T8, T9).
- **It has to work on a phone** -- a requirement, not a nice-to-have. See "On a phone" (T21-T28).

Still open: Q1, Q2, Q4, Q5.

## What is being asked

Two things, and the second is the one that matters:

1. **A new way to fill in a field.** On a table's app settings she can already choose how each
   field is filled in -- "One line", "A few lines", "A tick box", ... (`CONTROLS`,
   `src/studio/resources.ts`). Add **"Rich text"**: an editor with a small toolbar (bold, italic,
   headings, lists, links) instead of a plain box. Offered only on fields where it makes sense.
2. **Handling what comes back safely.** A rich-text field stores **HTML**. HTML is not just
   words: it can carry scripts, tracking pictures, fake login forms and links that run code. Today
   every field is text, and every page that shows one puts it on the page *as words*
   (`textContent`, see `public-gate/examples/guestbook/entries.js`). A rich-text field has to be put
   on the page *as HTML* -- otherwise she sees `<p>` and `<strong>` instead of formatting. So from
   the moment rich text exists, **what is stored in that field must be something that is safe to
   put on a page as HTML, whoever wrote it.** "Properly process the input" = clean it on the way
   in, and not trust it on the way out.

The product plan always meant to do this: "A `TEXT` column can become a rich-text editor"
(`docs/databases-plan.md` §11, and §11.2 "Rich text and media picker fill the existing control
slot later"). This plan is that "later".

## What she gets

```text
 Body
 ┌──────────────────────────────────────────────────────────┐
 │ ¶ Paragraph ▾   B  I  S   •≡  1≡  ❝   🔗  ⊞  ―   ↶  ↷    │  <- toolbar (one row + More on a phone, T23)
 ├──────────────────────────────────────────────────────────┤
 │ The first seeds went in last weekend.                    │
 │                                                          │
 │ What we planted                                          │  <- a heading
 │  • herbs                                                 │
 │  • salad leaves                                          │
 │  • courgettes (everyone warns you about courgettes)      │
 └──────────────────────────────────────────────────────────┘
```

- On the app settings (Fields of a table, "How is it filled in?"), fields that qualify get a new
  choice, **Rich text**. Fields that do not qualify do not show it.
- The "new" and "change" forms show the editor for that field.
- The app's **lists** show the first words of it as plain text, never the formatting.
- The **data API** answers with the cleaned HTML, and says which fields are rich text, so a web
  page knows which ones to show as HTML.
- The **blog example** uses it for a post's body, and its page shows it as HTML -- the worked
  example of doing this safely.

## Decisions

| # | Decision | Source |
|---|---|---|
| T1 | **Which fields qualify:** long text fields only (`text` in the panel's words -- `TEXT` on Postgres, `TEXT`/`MEDIUMTEXT`/`LONGTEXT` on MariaDB). Not short text (a `VARCHAR(255)` fills up with tags fast, and a title with bold in it is a design mistake), not the key, not a connection, not numbers/dates/yes-no. | momolig ("any field that qualifies") / which *(Claude)* |
| T2 | **Hers to switch, per field**, on the page she already uses for a field's control. Never switched on by the panel's guessing: a long text field is still "A few lines" until she says otherwise. | momolig / default *(Claude)* |
| T3 | **Stored as HTML**, not Markdown and not the editor's own JSON. HTML is what every other program reads (WordPress stores posts as HTML, and her WordPress database can be adopted), what a web page can show directly, and what a program using the API expects. The database holds something readable without the panel. | Claude |
| T4 | **A short, fixed list of what may be in it** (the allowlist): paragraphs, line breaks, headings (levels 2-4 -- level 1 is the page's title), **bold**, *italic*, underline, strikethrough, bulleted and numbered lists, quotes, a dividing line, links, **tables** (T17). Nothing else: no styles, colours, fonts, classes, ids, scripts, frames, forms, pictures (see Q2). Anything outside the list is removed, keeping the words inside it. | Claude |
| T5 | **Links:** only `https:`, `http:`, `mailto:`, `tel:`, an address on her own site (`/…`) and `#…`. Anything else (`javascript:`, `data:`, …) and the link is removed, its words kept. Every link gets `rel="noopener noreferrer"`; one to another website also gets `nofollow` (see Q4) and opens where it is (no `target`). | Claude |
| T6 | **Cleaned on the server, on every way in.** The editor only makes allowed things, but the editor is not the defence -- anyone can send anything to the panel or the API. So **both** write paths clean a rich-text field before it goes to the helper: the panel's `valuesFor` (`src/studio/records.ts`) and the gate's `valuesFrom` (`src/gate/data-api.ts`). One cleaning function, shared, with its own tests. | Claude |
| T7 | **Cleaned again on the way out of the API.** Her databases are hers: she can write in them with any tool, her WordPress can, a program with an older catalog could. What is in the column is not proof it went through T6. The gate cleans rich-text fields in every answer too, with the same function (20 rows a page, 100,000 characters at most each -- cheap). The API's promise is then simple: **a field marked rich text is always safe to show as HTML.** | Claude |
| T8 | **The cleaner is a real HTML parser with an allowlist, never a pattern match.** Regular expressions over HTML are the classic way this goes wrong. Proposed: the `sanitize-html` package (maintained, built on `htmlparser2`, runs in Node without a browser), pinned like every other dependency, configured from one list that T4/T5 are written in. *(Alternative: DOMPurify + a server-side DOM -- heavier, and pulls in jsdom.)* | Claude, momolig: yes |
| T9 | **The editor:** Tiptap (built on ProseMirror). Its document can only hold the kinds of thing it has been told about, so pasting from Word, Google Docs or a web page keeps the headings, lists, bold and links and drops the rest (fonts, colours, pasted pictures) -- the same list as T4, enforced a second time as she types. Loaded only on pages that use it, the way the File Explorer's code editor is. | Claude, momolig: yes |
| T10 | **Empty is empty.** An editor with nothing in it gives `<p></p>`; that is stored as nothing (`NULL`), so "required" and "has it been filled in" keep working. | Claude |
| T11 | **Switching a field to rich text never rewrites what is stored.** Existing plain text opens in the editor as paragraphs (a blank line starts a new one, the same rule the blog page uses) and becomes HTML only when that record is next saved. The words are put in *as words* -- a `<` someone typed stays a `<`. | Claude |
| T12 | **Switching back** ("A few lines") shows the stored HTML as it is, tags and all, with a warning before she does it: "Records you already wrote with formatting will show their formatting codes. Nothing is lost." Nothing is converted either way without her saving a record. | Claude |
| T13 | **The catalog carries it:** `rich?: string[]` beside `booleans`, so the gate knows which fields to clean (T6, T7) and the API can say which they are. Absent (an older catalog) = none, the same "optional when read" rule the db-examples fields use. Changing a field's control already re-pushes the catalog (`refreshCatalog`), so no new push point. | Claude |
| T14 | **The panel refuses rich text on a field that does not qualify**, in her words ("Only long text can hold formatting."). Today nothing checks a control against its field at all (`checkFieldPatch` accepts any control for any field), so this is a new check -- and a stored "Rich text" on a field that later stops being long text (the Studio changed its type) falls back to what inference would pick, rather than putting an editor on a number. | Claude |
| T15 | **Lists and the record picker show plain words** from a rich-text field (tags removed, the first ~120 characters), never HTML. Searching a rich-text field searches the stored text, so a search for "strong" would match the tag; long text is not searchable by default (§11.1), and when she ticks it on for a rich-text field the hint says so. *(Better search is Q5.)* | Claude |
| T16 | **Size.** The 100,000-character limit applies to the stored HTML. On MariaDB a `TEXT` holds 65,535 **bytes**, and HTML plus accents plus emoji reaches that sooner than it looks; a post that is too long today fails with the engine's error. Rich text makes that likelier, so the panel checks the size before saving and says it in her words ("Too long for this field by about 2,000 letters -- the Studio can make it a longer kind of text."). | Claude |

## Tables

| # | Decision | Source |
|---|---|---|
| T17 | **Tables are allowed** in rich text: `table`, `thead`, `tbody`, `tr`, `th`, `td`, and an optional header row. | momolig |
| T18 | **What a cell may hold:** paragraphs, line breaks, bold, italic, underline, strikethrough, links and lists. No headings, quotes, dividing lines or tables inside a cell. A table inside a table is flattened by the cleaner, keeping the words. | Claude |
| T19 | **Merged cells: yes, within limits.** `colspan`/`rowspan` are the only attributes a cell keeps, and only as whole numbers from 1 to 20. **No column widths**: Tiptap's drag-to-resize writes widths into `style`, which the cleaner removes anyway, and dragging a column edge does not work with a finger. The table fits the page and the page's CSS decides the rest. At most **30 columns and 500 rows**; beyond that the cleaner refuses the save in her words, rather than quietly cutting the table. | Claude |
| T20 | **Tables on a web page scroll sideways on a phone** instead of squashing the words or making the whole page wider than the screen. The cleaner does not add wrappers or classes (T4), so this is done in the page's CSS: the blog example's stylesheet has the rule, and guide 13 gives it to her to copy (`table { display: block; overflow-x: auto; max-width: 100%; }`). | Claude |

Editing a table: when the cursor is in the text, the toolbar's **Table** button inserts a 3x3
table with a header row. When the cursor is inside a table, the same button opens **Table**
choices: add a row above or below, add a column left or right, delete the row, delete the column,
header row on or off, merge or split cells, delete the table. These are words in a menu, not small
icons on the table's edges, which are hard to hit with a finger.

## On a phone

momolig: "we need to make sure that it works on mobile". Pamela will write in this on her phone,
so the phone is a first-class place to use it, and tested as one, not just a desktop page that
happens to shrink.

| # | Decision | Source |
|---|---|---|
| T21 | **No zoom when she taps in.** The editor's text is at least 16px. Below that, iPhone Safari zooms the whole page when a field gets focus and does not zoom back out. The same applies to the link dialog's box. | Claude |
| T22 | **The toolbar stays in reach.** For a long post, the toolbar sticks to the top of the screen while the editor is on screen, so she does not scroll back up for Bold. It sticks to the **top**, not the bottom: a bar held above the on-screen keyboard is where iPhone and Android disagree most, and it jumps as the keyboard opens and closes. | Claude |
| T23 | **Buttons big enough for a finger:** at least 44x44px, spaced apart. On a narrow screen the toolbar is **one row**: paragraph style, Bold, Italic, bulleted list, Link, Table and **More**. More opens a sheet from the bottom of the screen with the rest (numbered list, quote, underline, strikethrough, dividing line, undo, redo). No toolbar that wraps into three rows and pushes the text off the screen. | Claude |
| T24 | **Dialogs are full-width sheets on a phone.** "Add a link" and the Table choices open from the bottom of the screen with large rows. The link box is `type="url"`, so the phone shows the keyboard with `/` and `.com`. | Claude |
| T25 | **Tables scroll sideways inside the editor**, so a wide table never makes the whole page wider than the screen (T20 for the editor). A tap in a cell puts the cursor there. The Table choices in T17 work on whichever cell the cursor is in. | Claude |
| T26 | **Phone keyboards are tested for real:** autocorrect, predictive text, swipe typing, dictation and paste. ProseMirror (under Tiptap) is used on phones widely, but these are the places where editors break: a word typed twice, the cursor jumping, a replaced word lost. **Android's Gboard and the iPhone keyboard are the two that must pass.** | Claude |
| T27 | **Paste from the phone's own apps** (Google Docs, Word, Notes, Mail, a web page in Safari/Chrome) keeps headings, lists, links and tables and drops the rest, the same as on a computer. | Claude |
| T28 | **Loaded only when needed**, so a phone on a slow connection does not download the editor for every panel page. The size it adds is measured in the build, and a limit written down in the build check so it cannot quietly grow. | Claude |

How it is checked:

- **Browser tests on the phone profile.** The e2e suite already has a `phone` project (Pixel 7,
  `test/e2e/playwright.config.ts`, files named `*phone.spec.ts`). A new `rich-text-phone.spec.ts`:
  tap into the editor and type; Bold and a list from the one-row toolbar; More opens and closes;
  add a link through the sheet; insert a table, add a row and a column from the Table choices; the
  page is never wider than the screen; the editor's text is at least 16px.
- **Safari's engine too.** Only Chromium is installed for Playwright on this machine today. The
  plan adds WebKit (`npx playwright install webkit`, which needs its system libraries -- a sudo
  step for momolig) and an **iPhone** project running the same phone file. WebKit on Linux is
  close to iPhone Safari but not the same.
- **A real iPhone and a real Android phone, by hand, before it is installed.** Emulators do not
  run a real on-screen keyboard, autocorrect or dictation (T26), so no test run can prove those.
  A short checklist in the run sheet: write a post with a heading, a list, a link and a table;
  swipe-type a sentence; dictate one; paste from Google Docs; save; reopen; view it on the blog
  page. momolig (or Pamela) does it on panel.pammy.org, on an example database, after install and
  before telling her it is ready.

## How it works

### The control

`CONTROLS` gains `rich`, named **"Rich text"** (`CONTROL_NAMES`). `controlOf` never returns it
(T2). `resourceViews` keeps a stored `rich` only when the column is `text` (T14).
`studio_fields.control` is a plain `text` column, so **no migration** is needed.

### One cleaning function

`src/studio/rich-text.ts` (used by the panel and the gate, like `connect.ts`):

```text
cleanRich(html) -> string | null     T4, T5, T10: the allowlist, links, empty -> null
plainOf(html)   -> string            T15: words only, for lists, the picker and search hints
fromPlain(text) -> html              T11: paragraphs, words escaped
```

`valuesFor` (panel) and `valuesFrom` (gate) call `cleanRich` for every field in the Resource's /
catalog's `rich` list, **after** the other checks and **before** the size check (T16). The gate's
list/one answers call it on the way out (T7).

### The API

Answers are unchanged in shape; a rich-text field's value is cleaned HTML. The resource's
description (what a program reads to learn the fields) lists `rich`. Guide 13/14 say: *show
fields listed as rich text with `innerHTML`; show every other field with `textContent`, as
before.*

### The front end

`web/src/components/rich-text.tsx` (`RichTextEditor`): Tiptap with exactly T4's extensions
(plus the table extensions, resizing off -- T19), a toolbar of labelled buttons (screen readers
hear "Bold", "Numbered list"; the usual keys Ctrl/Cmd+B, I, U, K work), a small "Add a link"
dialog that refuses T5's forbidden kinds, the Table choices (T17), and on a phone the one-row
toolbar with More and sheets (T21-T25). `AppRecord.tsx` gets `case 'rich'`. `AppRecords.tsx` and the picker
use `plainOf`. The panel never shows stored HTML as HTML outside the editor.

### The blog example

`example_blog.posts.body` becomes rich text (the example's field settings), the sample posts are
stored as simple HTML (their paragraphs; one of them gets a small table -- what went in which
bed -- so the example shows a table on a phone too), and `public-gate/examples/blog/blog.js` shows `body`
with `innerHTML` -- with a comment saying why that is safe *for this field only* (T7). Her copies
made with "Make my own" get the same.

## Phases

1. **The cleaner** (T4-T8, T10, T11) with its tests, before anything can write HTML.
2. **The control and the editor** (T1, T2, T9, T12, T14, T16, T17-T19, T21-T28): settings page,
   forms, lists, tables, the phone layout, the phone tests, WebKit.
3. **The gate** (T6, T7, T13): catalog `rich`, cleaning in and out, the API description.
4. **The blog example** and **guides**: guide 14 (choosing Rich text; switching back; tables),
   guide 13 (showing a rich-text field on a page, and the table CSS from T20), PART 16 (the blog).
   Sync guides after install.
5. **By hand on a real iPhone and Android phone** (T26, T27) before telling Pamela.

## Tests

- **Cleaner (unit), the important ones:** `<script>`, `<img onerror>`, `<svg onload>`,
  `<iframe>`, `<style>`, `style="…"`, `javascript:` / `JaVaScRiPt:` / `java&#x09;script:` /
  `data:` links, `<a href=" javascript:…">` with spaces, a `<form>` with inputs, comments,
  `<noscript>`, broken HTML (unclosed tags, `<p><div>` nesting), a well-known list of XSS
  payloads -- every one comes out with no active content, the words kept. Allowed things survive
  unchanged. `<p></p>`, `<p><br></p>` and whitespace are `null`. Tables: allowed tables survive;
`style`/`width`/`colwidth` are removed; `colspan="0"`, `"99"` and `"2x"` are removed; a table
inside a table is flattened; a heading in a cell becomes a paragraph; 31 columns or 501 rows are
refused. Cleaning twice gives the same
  as cleaning once.
- **Panel:** rich text refused on short text, a number, the key, a connection; a record saved with
  a script in it is stored without; a field whose type changes loses its rich setting;
  switching back keeps the data; too long on MariaDB is refused before the engine.
- **Gate:** a program with a write key sending a script gets it stored clean; a row planted
  straight in the database with a script comes out of the API clean (T7); an older catalog
  without `rich` still serves.
- **Browser:** choose Rich text on the blog's body; write a heading, a list and a link; save;
  reopen; paste from a word processor keeps the list and drops the colours; the list page shows
  plain words; the blog example page shows the formatting.
- **Phone:** see "On a phone" (Pixel 7 and iPhone profiles, then the real phones).
- **Both real engines:** save and read back HTML with accents and emoji on Postgres and MariaDB.

## Open questions

- **Q1. Which formatting?** T4's list: headings, bold, italic, underline, strikethrough, lists,
  quotes, dividing line, links. *(Claude: that list. Colours and fonts are left out on purpose --
  they belong to the website's look, not the words.)*
- **Q2. Pictures inside the text?** Chosen from her Media library, never pasted or from other
  websites (a picture from elsewhere can track who reads the page). *(Claude: not in this
  version; it needs the media picker, which databases-plan.md plans as its own control. Next
  step after this one.)*
- ~~Q3. Tables inside the text?~~ **Yes** (momolig) -- T17-T20, T25.
- **Q4. Links to other websites: `nofollow`?** It tells search engines not to count the link.
  *(Claude: yes by default -- the safe choice if a helper or a program writes the text; she
  loses nothing she would notice.)*
- **Q5. Searching rich text by its words, not its tags?** Needs a second, plain copy of the text
  or a database search index. *(Claude: later, only if she searches long text at all.)*
- ~~Q6. The blog example switches to rich text?~~ **Yes** (momolig).
