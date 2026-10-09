# Protected folders, people, requests

A folder with `.pammy-protected` (or a row in `gate.areas`) is private.
nginx asks the gate before serving anything. People share one list across
every protected folder; grants say who may open which.

Nothing is emailed. Forgot-password and "please let me in" become rows on
the Requests tab. Pamela copies a setup link and sends it.

## Stack and why

- **The gate decides**, on the real path after following symlinks. See
  [gate.md](gate.md).
- **Visitor cookie** `__Host-pammy_visitor`, 30 days, scrypt passwords.
- **Five exact page names** in the folder, plus `login-files` for the look.
  Protecting a folder writes them if they are missing; it never overwrites.
- **Setup tokens** in the URL `#fragment`, SHA-256 at rest, 7 days, one
  live per person, one use.

## How it talks to the rest

Panel `/api/protected*` `/api/visitors*` `/api/requests*` `/api/sites*` →
gate admin + sitefs (`protect` writes the marker and starter pages).
Public posts `/_pammy/login` etc. are on [gate.md](gate.md) and
[widgets.md](widgets.md). A folder-limited account does not see this
feature (`LIMITED_ROUTES`).

## Important types

- `Area` — a protected folder: path, token, `requests_open`, which starter
  pages exist.
- `Visitor` — a person: username, name, contact (panel only, never logged),
  whether they have a password yet (`password_hash = ''` until they use a
  link).
- `Request` — `access` or `reset`.

## Panel routes — subdomains (site folders)

These are not protection; they are her top-level folders. Listed here
because People sits next to them.

### `GET /api/sites` / `POST /api/sites` / `POST /api/sites/trash` / `restore`

Create a folder with a starter page, trash, restore. Trash needs `recent`.
Reserved names: `www`, `api`, `panel`, `media`, plus WordPress placement.

### `GET /api/folders`

Directory tree for pickers.

## Panel routes — protection and people

### `GET /api/protected` / `POST /api/protected`

List / protect a folder (sitefs `protect` + admin `area.create`).

### `POST /api/protected/:id/pages` / `requests` / `unprotect` / `access`

Add missing starter pages; requests switch; unprotect (`recent`); set
grants (who may open it).

### `POST /api/visitors` / `:id/link` / `password` / `active` / `rename` / `contact` / `link/cancel` / `signout` / `delete`

Create a person (with a password, or with a link). Delete needs `recent`.
A new link, a password set in the panel, or switching them off cancels the
live link.

### `GET /api/requests` / `POST /api/requests/:id/approve` / `decline` / `delete`

Approve of an access request creates the person (if needed) and returns a
setup link for Pamela to send. Decline leaves a record; delete forgets it.

## Public posts (gate) — short restatement

### `POST /_pammy/login`

Username, password, `page` or `area`. Sets the visitor cookie. `next` is
checked (`safeNext`).

### `POST /_pammy/logout`

Answers `next`: the innermost folder's `logout.html` on that hostname.

### `POST /_pammy/forgot`

Always the same answer. Real usernames become requests: one open per
person, 5 per IP per hour, 3 per username per day.

### `POST /_pammy/request`

Name, contact, optional message, honeypot `website`. One open per
name+contact per folder. 5 per IP per hour. At most 50 waiting per folder,
300 in total. Folder switch `areas.requests_open` (on by default).

### `POST /_pammy/invite/check` / `invite`

Check a setup token (username, whether this is the first password). Using
it sets the password, ends every session, closes open forgot-password
requests, and signs them in on that hostname.

## Functions — names.ts (folders and markers)

### `SUBDOMAIN_RE` / `ALWAYS_RESERVED` / `reservedNames` / `newNameProblem` / `isSafeEntryName`

### `TRASH_ENTRY_RE` / `trashStamp` / `parseTrashEntry`

### `MARKER` / `AREA_TOKEN_RE` / `cleanAreaPath`

`.pammy-protected` and a 32-character token. `cleanAreaPath` is the
folder path the database stores.

## Functions — gate/store.ts

People, grants, sessions, links, requests, housekeeping. `checkCredentials`
(scrypt). `createVisitorSession` / `revokeSession`. `useLink` consumes a
token. `GateError` codes match the panel's helper map.

## See also

- [gate.md](gate.md), [widgets.md](widgets.md), [sitefs.md](sitefs.md)
- Guide 09 (protected folders), 06 (folders and subdomains)
