# Forms and responses

Pamela builds a form in the panel and puts it on any page:

```html
<script src="/_pammy/forms.js" defer></script>
<pammy-form name="olivias-form"></pammy-form>
```

Answers wait in the Responses tab. Nothing is emailed. Tables live in
schema `gate` ([`src/gate/forms.ts`](../../src/gate/forms.ts)). The panel
reaches them only through the admin socket.

## Stack and why

- **Gate schema**, not `panel` (D22). The gate already serves the public
  side. The panel has no SQL rights on `gate`.
- **`<pammy-form>`** is Lit, same contract as login. See [widgets.md](widgets.md).
- **Save is live**, no drafts (D11). `version` goes up on every save; a
  stale editor is refused, naming who saved and when.
- **A name can never change** (D3) and stays taken in the trash. Field
  keys are frozen once saved (D19) so the API keeps working.
- **Read-only API** for programs (Bearer `pammy_…`, SHA-256 at rest) and
  for pages when "anyone can read approved responses" is on.

Not in this version: file upload, signatures, payments, conditional logic,
multi-page forms, calculations, email, CSV, Turnstile.

## How it talks to the rest

Panel `/api/forms*` `/api/responses*` `/api/examples*` `/api/api-keys*` →
admin socket. Public `GET|POST /_pammy/forms/:name` and
`/_pammy/api/forms/…` on the gate. A form on a protected page runs
`decide()` on both the definition fetch and the POST, so only people who
may open the page may use the form. `forms.scope` ("Works on") plus a
folder-limited account.

The component sends `location.pathname`. The gate resolves it like
`/check` (real path, symlinks followed) and notes the page in `form_pages`
(at most one write per page per hour).

## Important types

- `Form` — id, name, title, items, settings, switches, version, scope,
  optional `fixture` (guestbook / rsvp / pinboard).
- `Item` — one question or layout piece. `cleanItems` is the one model.
- `StoredAnswer` — snapshot of key, label, type, value as sent. Editing
  the form later does not rewrite history. When a form is purged,
  `form_id` becomes NULL.
- `ApiKey` — `level` `approved` | `all`; `forms` a list or all; optional
  `media` grant.

## Panel routes

### `GET /api/forms` / `POST /api/forms` / `GET|POST /api/forms/:id`

List, create, get, save. Save carries `version`.

### `POST /api/forms/:id/switches` / `scope` / `hide-unreviewed` / `duplicate` / `trash` / `restore`

Switches: `enabled`, `approvable`, `publicApproved`, `autoApprove`. The
last two need `recent`. Scope is "Works on." Duplicate copies everything
except id and name.

### `GET /api/forms/:id/copy-name`

A free name for duplicate (`olivias-form-2`).

### `GET /api/examples` / `POST /api/examples/:kind/reset` / `install`

Fixtures. Cannot be trashed or renamed, only reset. Install: make a real
form from the starter if she hasn't got one, copy the three files through
sitefs, tell her the address and the one switch left.

### `GET /api/responses` / `unread` / `POST …/read` / `read-all` / `approve` / `trash` / `restore`

Inbox. Example entries have a badge and never count as unread.

### `GET /api/api-keys` / `POST /api/api-keys` / `POST …/:id/revoke`

Create and revoke need `manager-recent`.

## Functions — src/gate/forms.ts

### `keyFromLabel` / `cleanItems` / `cleanSettings` / `cleanImagePath` / `cleanScope` / `inScope`

The builder and the gate both use these. A key is made from the label and
never reused (`used_keys`).

### `formById` / `formByName` / `createForm` / `saveForm` / `duplicateForm` / `suggestCopyName`

### `setFormSwitches` / `setFormScope` / `trashForm` / `restoreForm` / `formsState` / `summary` / `recordFormPage`

### `cleanAnswers` / `addResponse` / `insertValues` / `valueRows` / `normValue`

Typed values: numbers are numbers, tick boxes booleans, several choices an
array, a name or address an object. `response_values` is the flattened
lower-cased copy `filterby` searches.

Checks: lengths, email/phone/number/website shapes, date and time ranges,
how many choices. Errors name the field's key. Hidden trap `website`. 10
per IP per hour. Nothing new while 1000 are unread or 10,000 are stored.

### `listResponses` / `setResponseRead` / `markAllRead` / `trashResponse` / `restoreResponse` / `setResponseApproved` / `unreadCount` / `hideUnreviewed`

### `createApiKey` / `revokeApiKey` / `listApiKeys` / `apiKeyFor`

Raw key shown once. Header only; a key in the address is refused.

### `queryResponses` / `encodeCursor` / `decodeCursor`

Cursor paging for the public API (`order`, `limit`, `after`).

### `formsHousekeeping`

Purge trash after 30 days.

## Public HTTP (gate)

### `GET /_pammy/forms/:name` / `POST /_pammy/forms/:name`

Definition (`no-store`) and submit. POST body ≤ 64 KB.

### `GET /_pammy/form-preview`

The panel's unsaved form, in a frame, drawn by the same component. The
panel hands the form by `postMessage`.

### `GET /_pammy/api/forms/<id>|by-name/<name>/<all|approved>[/filterby/<field>/<value>]`

Same rules either way. A name nobody has looks exactly like a form nobody
may read, so names cannot be fished for. Keyed answers `no-store`. Public
ones `no-cache` + ETag. IP, hostname, and read state are never given out.
`signedInAs` on keyed `/approved`; on keyless only if "Show who sent it
publicly" is on (D23).

After sending: `thanks="…"` (same site only), else `<template class="pammy-thanks">`,
else the form's words in `.pammy-sent`.

## See also

- [gate.md](gate.md), [widgets.md](widgets.md), [visitors.md](visitors.md)
- [`docs/forms-plan.md`](../forms-plan.md), [`docs/examples-plan.md`](../examples-plan.md)
- Guide 10
