# File editor: plan

Status: **built 2026-09-19, not installed yet** (see section 10, "As built"). Asked for by momolig: opening a text file in
the File Explorer brings up an editor, and an HTML file can be switched between its code
and a preview. No code is written yet.

Today, clicking a file in the File Explorer goes to `/api/files/file`, which serves it
read-only inside a locked-down sandbox. There is no way to change a file's contents from
the panel. This plan adds that.

---

## 1. Decisions (momolig, 2026-09-19)

- **D1 Every save keeps the old copy.** Earlier versions can be restored for 30 days,
  the same as the trash. This is the safety net when a page gets broken.
- **D2 Limited accounts edit only inside their own folder.** They get the same editor,
  with any file type allowed, but only under the folder they're limited to (the existing
  `ownsPath`/`own` check in `src/app.ts`). Outside that folder, the editor doesn't open for
  them and the server refuses to save.
  - Known risk, accepted: a helper's `.html`/`.js` runs on the same origin as pammy.org's
    protected folders. This is the same open question as helpers uploading those files.
- **D3 New files, not just editing.** The editor has a "New file" button. A new file can be
  blank or start from a template (for HTML, a starter page).
- **D4 On large screens, Code, Preview and Side by side.** Phones get only the Code |
  Preview switch.

## 2. Claude's choices (proposed; change any of them)

- **C1 The editor opens on its own page.** Its address is `/files/edit?path=<site path>`,
  so Back works and the address can be bookmarked. That matches the real-page-address
  setup. The existing Full screen toggle (`components/media/full-screen.tsx`) is reused.
- **C2 These file types open in the editor:** `.html .htm .css .js .txt .md .json .xml .svg`.
  Any other file opens the way it does today. The size cap is 2 MB, and the file must be
  valid UTF-8. A bigger or binary file shows "too big / not a text file to edit here".
- **C3 The editor is CodeMirror 6.** It is bundled by Vite into our own files, so there's
  no CDN and the panel's CSP doesn't change. It has colour highlighting per type, line
  numbers, find/replace, undo, and works on phones. Monaco was rejected because it is
  heavy and poor on phones.
- **C4 Saving:** a Save button plus Ctrl/Cmd+S, and a dot next to the name while there are
  unsaved changes. The editor warns before leaving (page change, Back, closing the tab)
  with unsaved changes.
- **C5 A preview of what's in the editor now, not just what's saved.** See section 4.

## 3. Saving (helper, as pamela)

- **The helper gets a new op, `files-write`,** in `src/sitefs/`. It streams the body the
  same way `files-upload` does, and takes `{ path, expectHash | null, actor }`.
  - It writes a temp file in the same folder, fsyncs it, and swaps it in with rename(2).
    The file never exists half-written, and it keeps pamela's ownership. Mode is 644, or
    the old file's mode when there was one.
  - `expectHash: null` means a new file, and creating it uses the same "never overwrite"
    link() pattern as uploads.
- **Save refuses if the file changed since it was opened.** When the editor opens a file
  it remembers its hash (`files-hash` already exists). If Pamela, momolig or WinSCP changed
  the file in the meantime, the save is refused with 409. The editor then offers three
  choices:
  - **Keep mine:** overwrite. The copy that gets replaced is still kept as a version (D1).
  - **Load theirs:** throw away my changes.
  - **Save mine as a copy:** `name (copy).html`.
- **Versions (D1)** go to `/pamela/trash/.versions/<id>/` together with an `origin.json`
  holding the path, the time, who saved and the hash, following the media trash pattern.
  - The panel's hourly housekeeping purges versions older than 30 days.
  - To stop Ctrl+S spam filling the disk, the editor keeps at most one version per file
    per 5 minutes of continuous editing, plus a cap (say 50 per file).
  - An **Earlier versions** list in the editor lets you open a version read-only, compare
    it side by side, or restore it. Restoring is itself a save, so it keeps the current
    copy as a version too.
- **media.db:** a save updates the file's record (size, modified), the way the sync does.
- **Activity log:** `file-created`, `file-saved` and `file-version-restored`, each with
  who did it and the path.
- **Route:** `PUT /api/files/text?path=` with body `text/plain; charset=utf-8`, plus
  `If-Match: <hash>`, or `If-None-Match: *` for a new file. It gets its own nginx location
  (2 MB body) and a `security.ts` allowance next to `files/upload`. That's needed because
  the panel's CSRF check only lets JSON through today, and `files/upload` was already
  refused once because of it.

## 4. Preview (HTML)

- **The preview runs in a sandboxed iframe with no `allow-same-origin`,** so a script in her
  page runs in an opaque origin. It can't read panel cookies or call the panel API. Scripts
  are allowed in the preview (`allow-scripts`), so pages behave as they do for real.
- **Relative links have to work.** Her `style.css`, `images/x.jpg` and `../` links resolve
  against a new path-style, read-only route that mirrors the site:
  `/api/files/view/<site path>`. It sends the same sandbox CSP as `/api/files/file`, plus
  `script-src` for the page's own files.
  - This route works inside protected folders and for files a visitor can't see, because
    it goes through the panel's own login and not the gate.
  - The same folder check as D2 applies.
- **The unsaved text** is posted to a short-lived preview slot on the panel, kept in memory
  for about 10 minutes per open editor. The iframe loads
  `/api/files/view/<site path>?draft=<id>`, so the page itself is the draft and everything
  it links to is the saved site. Typing refreshes the preview after about 600 ms of quiet.
  There's also a manual refresh button.
- **Gate widgets don't run in the preview:** `<pammy-form>`, `<pammy-login>`, the examples,
  and anything else from `/_pammy/…` lives on the gate, not the panel. The preview shows a
  labelled placeholder box for each ("Your form ‘guestbook’ shows here on the real page").
- **Side by side (D4) needs 1100 px or wider.** Below that the Side by side option is
  hidden, and phones get a two-way switch. The divider can be dragged, and the split is
  remembered per browser (`pref()`).
- **An "Open the real page" link** goes to the live address on pammy.org or the subdomain,
  once the file is saved.

## 5. New files (D3)

- **"New file" in the File Explorer toolbar** asks for a name. Names are checked like
  uploads, and the chosen type must be an editable type from C2.
- **Templates:**
  - Blank.
  - For `.html`, a starter page: doctype, charset, viewport, title, and a linked
    `style.css` if the folder has one.
  - For `.css`, a small starter.
- Names ending in `login.html`, `login-*.html` or `contact.html` get a note saying what that
  name does, because those names have meaning to the gate.

## 6. Things to warn about in the editor

- **Cloudflare caching:** a saved `.css` or `.js` can stay cached at Cloudflare for up to
  about 4 hours. HTML isn't cached. After saving a `.css` or `.js` file the editor says so
  and suggests a `?v=2` on the link.
- **Editing inside a protected folder is fine.** Visitors still need to sign in, and
  nothing about the protection changes.
- **Saving `login.html` or `contact.html` changes a live sign-in or contact page.** The
  editor shows a one-line note on those.

## 7. Tests

- **Helper:** atomic write, hash conflict (409), new file never overwrites, mode and owner
  kept, version kept and purged, a limited account refused outside its folder.
- **API:** the PUT route through `security.ts`, the nginx body limit, and the view route's
  CSP and folder check.
- **e2e:** open, edit, save, reload. Also: a conflict from a WinSCP-style change, preview
  toggling, side by side at desktop width, only the switch at phone width, the
  leave-with-unsaved-changes warning, new file from a template, and restoring a version.
- **verify-panel.sh:** a live round trip on a `zz-panel-verify-<pid>.html` (create, save,
  conflict, restore, trash).

## 8. Guides

- **Guide 08:** a new part on editing files, after the File Explorer part, plus a
  paragraph for limited accounts.
- Build after the guide edits (see the rebuild-after-guide-edits rule), then sync the
  guides after install.

## 9. Settled questions (momolig, 2026-09-19: "yes everything is okay")

- **Q1 Yes:** rapid Ctrl+S presses are collapsed into one version per 5 minutes of editing,
  with a cap of 50 versions per file.
- **Q2 Yes:** the editor keeps an **auto-save draft in the browser** (`localStorage`, keyed
  by account + path + the hash the file was opened at). After a closed tab or a crash it
  offers the draft back: "You have unsaved changes from 14:02. Restore?" It is never
  written to the site on its own, and it is cleared after a save or a discard. All reads and
  writes are wrapped in try/catch, so a private window with no storage still works.

## 10. As built (2026-09-19)

**Where the code is**
- **Helper (as pamela):** `src/sitefs/edit.ts`.
  - Stream ops `files-write`, `files-version-read` and `files-version-restore`; plain op `files-versions`.
  - The `purge` op now also purges versions.
  - `files-read` with `view: true` may read a sign-in page's `login-files` (the preview only).
- **Panel:** `/api/files/text`, `/api/files/save`, `/api/files/versions`, `/api/files/version`, `/api/files/versions/restore`, `/api/files/preview`, `/api/files/preview/close`, `/api/files/draft` and `/api/files/view/<token>/<path>`, in `src/app.ts`. Preview tokens and the unsaved-text store are in `src/preview.ts`.
- **Front end:**
  - The editor page: `web/src/pages/FileEditor.tsx`.
  - CodeMirror and the compare view: `web/src/components/editor/code-editor.tsx`.
  - "New file": `web/src/components/editor/new-file.tsx`.
  - Shared helpers (editable types, templates, the browser draft): `web/src/lib/editor.ts`.
  - The editor is its own lazily loaded chunk, about 230 kB gzipped.
- **Tests:**
  - `test/sitefs.test.ts`: helper, 7 tests.
  - `test/panel.test.ts`: API, 6 tests.
  - `test/run-nginx-test.sh`: 3 body-limit checks.
  - `test/e2e/19-editor.spec.ts`: 4 browser tests, plus a phone test in `phone.spec.ts`.
  - `deploy/verify-panel.sh`: a live round trip (make, save, stale save refused, version put back, served through Cloudflare, 2 MB save through nginx, preview without a token refused).

**Changes from the plan above**
- **The save is a JSON POST** (`{path, text, expect | create, session}`), not a `PUT` of text/plain.
  - It keeps the existing origin + JSON CSRF check, so there's no `security.ts` exception.
  - nginx has a location for `/api/files/(save|draft)` with an 8 MB limit, because JSON escaping can grow 2 MB of text. The route's own `bodyLimit` is the same.
  - The server refuses text over 2 MB with 413.
- **Quick saves share a version only when they come from one open editor.** Each editor page makes a random `session` id and sends it with its saves; the rule is same person, same session, within 5 minutes, and nothing else changed the file in between. The browser tests showed why the person alone isn't enough: the same account saving from a second window was merged into the first window's run, and its text was never kept. Saves with no session (programs, verify) always keep a version.
- **Versions have an `order` (milliseconds)** as well as `savedAt`. Two saves in the same second had been listed in random order.
- **The preview is reached through a token in its address, not the session cookie.** A sandboxed frame has an opaque origin, so the browser doesn't send the panel's SameSite=Lax cookie with its requests.
  - A token belongs to one account and one open editor. It reads only inside the page's folder at the top of the website, or the account's own folder for a limited account.
  - It's forgotten after 2 idle hours (12 hours at most). The account must still be switched on.
  - Answers carry the CSP `sandbox allow-scripts`, `frame-ancestors <panel>` and `Cross-Origin-Resource-Policy: cross-origin`, so the opaque frame can load them.
  - `connect-src` allows only the panel.
  - Addresses starting with "/" in `src`, `href`, `action` and `poster` are rewritten to the top of the token's folder.
  - Gate tags (`<pammy-form>`, `<pammy-login>`, `<pammy-forgot>`, `<pammy-invite>`, `<pammy-request>`, `<pammy-welcome>`, `<pammy-signed-out>`, `<pammy-logout>`) get a labelled dashed box from an injected `<style>`.
- **The frame reloads after each change**, 600 ms after typing stops, so its scroll position goes back to the top.
- **New files are recorded in media.db as `how = 'uploaded'`.** The CHECK constraint allows only uploaded, copied and found, and adding "made in the editor" would need a table rebuild. The activity log says `file-created` ("made ... in the editor").
- **Activity:** `file-saved` is logged once per new version, so a quick run of Ctrl+S is one line. `file-created` and `file-version-restored` are logged every time.
- **Only the sign-in pages get a note** (`login.html` and `login-forgot`, `invite`, `request`, `signed-out`, `logout`). `contact.html` means nothing special any more since the forms redesign.
- **Typing over a selection is handled by CodeMirror**, not the browser. Chrome's own editing first wraps the text it keeps in a `<span style=...>`, which the panel's CSP refuses (`style-src-attr`). The result was harmless but it put an error in the console.
- **Where the editor is reached:**
  - Clicking a text file in the File Explorer opens the editor. Its menu has Edit and Details.
  - The Media tab still opens details, whose footer has an Edit button for text files.
- **Guides:**
  - Guide 08 has PART 14 "Editing files", plus the File Explorer lines in PART 4 and PART 13.
  - Guide 11 has "CHANGING A PAGE" in PART 2.
  - Both need a guide sync after install.
