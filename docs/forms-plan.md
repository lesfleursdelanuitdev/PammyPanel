# Forms: plan

Status: **built 2026-09-17, release f2c76278c1bdfe2c, not installed yet.** Everything in
sections 1-13 is built unless noted below. What was built differently:
- The form definition a page fetches has no ETag (the gate answers `no-store` for it anyway);
  the API's public answers do have one.
- The preview is a frame on pammy.org (`/_pammy/form-preview`) that the panel hands the form
  to by postMessage, so it is drawn by the very component visitors use.
- Dragging uses the browser's own drag and drop, with no library; phones use tapping, and Up
  and Down work everywhere.

It replaces the "Contact forms" feature (contact.html pages linked to forms in
the panel) and adds approvals plus a read API for responses.

momolig answered the open questions on 2026-09-17 (D14–D22). **Section 14
has the one question left.**

---

## 1. Goals

- Pamela (and any panel account holder) builds forms visually, Jotform-style.
- A form works on **any page** of her site via a web component, like `<pammy-login>`.
- Visitors' answers arrive as **Responses** in the panel. Nothing is emailed.
- Some forms are **response-approvable**: an account holder approves responses one by one.
- An **API** returns a form's responses (all, or only approved ones), filtered and ordered.
- Everything in the panel works on a phone.

### Not in this version

File upload, signatures, payments, conditional logic ("show this if…"),
multi-page forms, calculations, emailing responses, CSV export, Turnstile
(still planned separately; see the Turnstile note in the panel memory).

---

## 2. Words used here

| Word | Meaning |
|---|---|
| **Form** | What Pamela builds: settings plus an ordered list of items. |
| **Item** | One thing on a form: an answer field (collects something) or a layout item (heading, text, divider, image). |
| **Field key** | An answer field's stable machine name, e.g. `your-name`. Used in stored responses and in the API. |
| **Response** | One submission from a visitor (today called a "message"). |
| **Account holder** | Someone with a panel login (momolig, Pamela). |
| **API key** | A secret that lets a program read responses. |

---

## 3. Decisions so far

| # | Decision | Source |
|---|---|---|
| D1 | Rename the feature to **Forms**; rename the Messages tab to **Responses**. | momolig |
| D2 | A form goes on any page: `<pammy-form name="olivias-form" thanks="thank-you.html">`. The `contact.html` rule, page linking and `contact-thank-you.html` are removed. | momolig |
| D3 | Each form has a unique **internal id** (number, never reused) and a unique **name**: lowercase letters, digits and hyphens only. **A name can never be changed.** | momolig |
| D4 | Each form has an **on/off switch**. A form that is on works on any page. | momolig |
| D5 | The thank-you page is the component's **`thanks` attribute** (per page, not per form). | momolig |
| D6 | No backwards compatibility: there are no live contact pages. `<pammy-contact>`, `contact.js` and the old routes go away. | momolig |
| D7 | Account holders can **list, duplicate, edit, delete and preview** forms. Duplicating copies everything except the internal id and the name. | momolig |
| D8 | Deleting a form moves it to the **trash for 30 days**. | momolig |
| D9 | The field inventory in section 6 is accepted. The "not in this version" list is deferred. | momolig |
| D10 | Builder: drag and drop on larger screens, a **tap-based** builder on phones. | momolig |
| D11 | **Save is live immediately.** No drafts. A stale-edit check refuses a save over someone else's newer save. | Claude (asked: "most performant") |
| D12 | A form can be marked **response-approvable** (boolean). Only then can account holders approve its responses. | momolig |
| D13 | API routes `/forms/:id/all`, `/forms/:id/approved`, `/forms/:id/filterby/:fieldname`. Ascending order by default. | momolig (details in §9) |
| D14 | `filterby` takes a value: `/filterby/:field/:value` returns responses whose answer matches. | momolig (Q1) |
| D15 | `filterby` works under both sets: `/all/filterby/…` and `/approved/filterby/…`. | momolig (Q2) |
| D16 | `:id` in the API is the **internal id**. | momolig (Q3) |
| D17 | **A page on her site can show approved responses without a key.** Per-form switch "Anyone can read approved responses", plus a per-field "Show publicly" setting. | momolig (Q4) |
| D18 | `/approved` includes who sent it (`signedInAs`) for keyed calls. | momolig (Q5; keyless output: see §14) |
| D19 | Field keys are fixed once the form is saved with them. | momolig (Q6) |
| D20 | **Account managers** create API keys and hand them to others. | momolig (Q7) |
| D21 | Existing data is **converted**: the sample form (switched off) and all existing messages become responses. | momolig (Q8) |
| D23 | Keyless output includes `signedInAs` only when the per-form setting "Show who sent it publicly" is on (off by default). | momolig |
| D24 | The Forms card shows the numeric id as well as the name, and carries example code for reading the approved responses. | momolig (2026-09-17, after the first install) |
| D25 | Pamela has full control of the thank-you: her own page (`thanks=`), her own markup (`<template class="pammy-thanks">`) or the form's words in `.pammy-sent`. Guide 10 has a PART for it. | momolig (2026-09-17, after the first install) |
| D22 | **The account database (`panel.db`: accounts, passkeys, panel sessions) is not touched.** Everything here lives in `gate.db`. | momolig's requirement |

---

## 4. Data model (gate.db)

The gate owns `gate.db` and stays the only process that serves visitors.
The panel reaches it through the existing admin socket.

### 4.0 Which database (D22)

There are two separate SQLite files, owned by two separate system users:

| File | Owner | Holds | Changed by this plan? |
|---|---|---|---|
| `/var/lib/svc-pammypanel/panel.db` | `svc-pammypanel` (home 700) | panel accounts, **passkeys**, invites, panel sessions, activity log, media notes | **No.** No migration. New activity entries (`form-saved`, …) are new text in the existing `action` column, not a schema change. |
| `/var/lib/svc-pammygate/gate.db` | `svc-pammygate` | protected folders, visitors, visitor sessions, links, requests, forms, messages | **Yes**: this plan's migration. API keys are stored here too, because the gate checks them. |

The gate's user can't open `panel.db`, and the migration only runs inside the
gate against `gate.db`. The install backup/restore (§10) covers `gate.db` only.
`verify-panel.sh` gains a check that `panel.db`'s schema version and its
passkey count are the same before and after install.

### forms

| Column | Notes |
|---|---|
| `id` | Integer, AUTOINCREMENT, **never reused** (safe for API URLs). |
| `name` | Unique among all forms, **including forms in the trash**. `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–64 characters. Can't change. Free again only after the form is purged from the trash. |
| `title` | Free text shown in the panel (e.g. "Olivia's party RSVP"). Editable. Not shown to visitors unless she adds a Heading item. |
| `items` | JSON: ordered list of items (section 6). |
| `settings` | JSON: submit button text, sent-message text, signed-in visitors only (see §5.4). |
| `enabled` | On/off switch (D4). |
| `approvable` | Response-approvable (D12). |
| `public_approved` | "Anyone can read approved responses" (D17). Only meaningful while `approvable` is on. |
| `version` | Integer, +1 on every save. Used for the stale-edit check (D11). |
| `created_at`, `updated_at`, `updated_by` | |
| `trashed_at`, `trashed_by` | Set when deleted; purged after 30 days. |

### responses (today's `messages`, renamed)

| Column | Notes |
|---|---|
| `id` | Integer. |
| `form_id` | Set to NULL when the form is purged. |
| `form_name` | Snapshot, so a response still says which form it came from. |
| `page` | The page it was sent from (path on the site). |
| `answers` | JSON snapshot: `[{key, label, type, value}]` as they were when sent. Editing the form never changes old responses. |
| `visitor_id`, `visitor_username`, `visitor_name` | Only on a page in a protected folder, as today. |
| `host`, `ip` | As today. **Never returned by the API.** |
| `created_at` | Time received. The API's sort key. |
| `read_at`, `read_by` | Shared read state, as today. |
| `trashed_at`, `trashed_by` | 30-day trash, as today. |
| `approved_at`, `approved_by` | NULL = not approved. |

Indexes: `(form_id, created_at, id)` and `(form_id, approved_at)`.

### response_values (new, for fast filtering)

One row per answer: `(response_id, form_id, key, value_norm)`. The value is
trimmed and lower-cased. A multiple-choice field has one row per choice. A
compound field (name, address) has one row per part (`name.first`, …). Index
`(form_id, key, value_norm)`. Written in the same transaction as the response.

### api_keys (new)

See §9.2.

### Removed

`contact_pages` (it has no rows: there are no live contact pages).

### Converting existing data (D21)

- Each existing form becomes a form named from its title: `Sample contact
  form` → `sample-contact-form`. Clashes get `-2`. All converted forms are
  switched **off**.
- Field keys are made from labels the same way. Old field types map directly
  (`text` → short text, `textarea` → long text, `select` → dropdown,
  `checkbox` → single checkbox).
- `messages` is renamed to `responses`. Each message's snapshot answers get
  keys from their labels. Old checkbox answers become booleans and numbers
  become numbers. `response_values` rows are built for each one. Read and
  trash state carry over. None are approved.
- The conversion runs in one transaction. The unit test converts a copy of a
  `gate.db` built by the current release's migrations, and checks every row.

### Limits

| Limit | Today | New |
|---|---|---|
| Items per form | 30 fields | 100 items |
| Options per choice field | 50 | 100 |
| Forms | 100 | 200 (trash included) |
| Stored responses | 10,000 total, 1,000 unread | unchanged |
| Request body | 64 KB | unchanged |

---

## 5. On a page: the `<pammy-form>` component

### 5.1 Markup

```html
<script src="/_pammy/forms.js" defer></script>
<pammy-form name="olivias-form" thanks="thank-you.html"></pammy-form>
```

| Attribute | Meaning |
|---|---|
| `name` | **Required.** Which form. |
| `thanks` | Optional. Page to open after sending. Relative to the current page like a link (`thank-you.html`), or from the top of the site (`/thanks.html`). **Must resolve to the same site**. Otherwise it is ignored and the in-place message is shown. |
| `sent-text` | Optional. In-place message when there's no `thanks` (overrides the form's setting). |
| `styles="off"` | As in login.js: no built-in look. |

Several forms on one page, and the same form on many pages, both work.

### 5.2 What visitors see

| Situation | Shown |
|---|---|
| Form is on | The form. |
| Form is off, in the trash, or no such name | A short notice: "This form isn't available right now." (Wording attribute `unavailable-text`.) |
| Sent, `thanks` given | Browser goes to that page. |
| Sent, no `thanks` | The form is replaced by the sent message. |
| Sending refused (switched off meanwhile, too many, invalid) | Message above the button; answers kept. |

### 5.3 Gate routes

| Route | Purpose |
|---|---|
| `GET /_pammy/forms.js` | The component (`no-store`, as login.js; built-in pages use `?v=<hash>`). |
| `GET /_pammy/forms/:name` | Form definition for visitors: items and wording only. Nothing internal. `ETag` so repeat loads are a 304. |
| `POST /_pammy/forms/:name` | Send a response: `{page, answers, website(trap)}`. Same-origin check, JSON-only, 64 KB, as today. |

nginx needs no change: `/_pammy/` already goes to the gate on every pammy.org
hostname, so no CORS is needed anywhere on her site.

### 5.4 Protected folders

- As today, the gate resolves `page` like `/check` does. On a page inside a
  protected folder, the response records the signed-in visitor, and only
  someone allowed in can send.
- Form setting **"Only signed-in visitors"** (default off): refuse responses
  from pages outside protected folders or without a signed-in visitor.

### 5.5 "Used on" list

When a page loads a form definition, the gate records `(form_id, page,
last_seen)` in a `form_pages` table. It writes **at most once per form+page
per hour** (in-memory throttle), so page views don't each cost a write. The
panel shows "Used on: …" per form. Entries unseen for 90 days drop off.

### 5.6 Spam and abuse

Unchanged: hidden trap field, 10 responses per IP per hour, stored/unread caps.
Turnstile later. A form that is off refuses responses.

---

## 6. Item inventory

### 6.1 Settings every answer field has

| Setting | Notes |
|---|---|
| Label | Required. |
| Field key | Made from the label (`Your name` → `your-name`), unique in the form, same character rules as form names. **Can't change after the form is first saved with it** (D19). Shown in an "Advanced" part. |
| Help text | Small text under the field. |
| Required | |
| Width | Full or half (half becomes full on phones). |
| Placeholder | Text-like fields only. |
| Default value | Where it makes sense (text, number, choices, date). |
| Show publicly | Include this field when approved responses are read **without a key** (D17). On by default, **except** email, phone, address and hidden value, which are off by default. Shown only while the form's "Anyone can read approved responses" switch is on. |

### 6.2 Answer fields

| Type | Visitor sees | Extra settings | Checks (in browser **and** gate) | Stored / API value |
|---|---|---|---|---|
| Short text | one-line box | min/max length (≤ 500) | length | string |
| Long text | multi-line box | rows, min/max length (≤ 5,000) | length | string |
| Email | email box | | email shape | string |
| Phone | phone box | | phone shape | string |
| Number | number box | min, max, decimal places | range, decimals | number |
| Website | address box | | `http(s)://` only | string |
| Date | date picker | earliest, latest (fixed date or "today") | real date, range | `"YYYY-MM-DD"` |
| Time | time picker | earliest, latest, step (minutes) | range | `"HH:MM"` |
| Dropdown | select | options | one of the options | string |
| Single choice | radio buttons | options, "Other" with text box, 1 or 2 columns | one option or Other text | string |
| Multiple choice | checkboxes | options, "Other", min/max picks | options, count | array of strings |
| Single checkbox | one tick box | its text | required = must tick | boolean |
| Name | first + last boxes | include middle name, include title | parts' length | `{first, middle?, last, title?}` |
| Address | line 1, line 2, town, region, postcode, country | which parts, default country | lengths | `{line1, line2, town, region, postcode, country}` |
| Rating | stars | 3–10 stars | whole number in range | number |
| Scale | row of numbers | from 0 or 1, to 5–10, low/high labels | whole number in range | number |
| Hidden value | nothing | fixed value, or taken from the page address (`?source=…`) | length ≤ 500 | string |

Empty optional answers are stored as `null`.

### 6.3 Layout items (collect nothing, never in responses)

| Type | Settings |
|---|---|
| Heading | text, size (large/medium/small) |
| Paragraph | text (plain; line breaks kept; web addresses become links) |
| Divider | none |
| Image | picked from one of her media folders, alt text (required), width |

### 6.4 Styling

The same documented `pammy-*` classes and CSS variables as the sign-in and
current contact components, built-in CSS inside `:where()`, `styles="off"`.
Every field gets `data-key="<field key>"` and `data-type="<type>"` so her CSS
can target one field.

---

## 7. Panel

### 7.1 Menu and addresses

| Before | After |
|---|---|
| Inbox → Messages (`/messages`) | Inbox → **Responses** (`/responses`, `?form=<id>`) |
| Website → Contact forms (`/contact-forms`) | Website → **Forms** (`/forms`, `/forms/new`, `/forms/:id`) |
| Home: "contact pages" stat, "New messages" | Home: "forms on" stat, "New responses" |
| Help: `/help/contact-forms` | `/help/forms` |

### 7.2 Forms list (`/forms`)

One card per form:
- title and name
- on/off switch
- "approvable" badge
- responses count and unread count
- last response time
- "Used on" pages
- actions: **Edit**, **Preview**, **Duplicate**, **Copy code** (the two lines from §5.1 with its name), **Delete**

Plus a "New form" button (starting blank, or from a copy of the sample) and a
**Trash** section with Restore.

- **Duplicate:** asks for the new name, suggesting `<name>-copy`, then
  `-copy-2`. It copies title, items (field keys included), settings, on/off
  and approvable. Responses are not copied.
- **Delete:** a confirm that names the pages it was last seen on. The form
  goes to the trash, its pages show the unavailable notice, and its name stays
  taken. Its responses stay in Responses.

### 7.3 Builder (`/forms/new`, `/forms/:id`)

**Wide screens (≥ 1024 px): three columns**

| Left: Add | Middle: the form | Right: Settings |
|---|---|---|
| Item types in groups (Text, Choices, Date & numbers, People, Layout, Other). Drag onto the form, or click to add after the selected item. | The form as visitors see it. Drag to reorder, with a line showing where it will land. Hover/selected item shows Duplicate, Delete, Move up/down. Click a label to edit it in place. | Settings of the selected item, or of the whole form when nothing is selected (title, name (new forms only), submit text, sent message, on/off, approvable, signed-in only). |

**Medium screens (640–1023 px):** the form in the middle, the Add list as a
side drawer, and Settings as a sheet from the right.

**Phones (< 640 px), tap-based (D10):**
- The form is a list of item rows.
- An "Add" button at the bottom opens a full-screen list of types; tapping one
  adds it after the selected item (or at the end).
- Tapping a row selects it and shows Up, Down, Duplicate, Delete and Settings.
- Settings open as a full-screen panel with Back.
- No dragging is needed anywhere on phones.

**Everywhere:**
- Moving works from the keyboard too (Move up/down, and a drag handle usable
  by keyboard).
- **Save** and **Preview** stay visible in a bar at the top, with an "Unsaved
  changes" marker.
- A warning appears before leaving with unsaved changes.
- Save sends `version`. If someone else saved first, the save is refused:
  "Pamela changed this form at 14:02. Reload to see her changes (yours will be
  lost), or copy your changes first."
- Checks happen before saving, with items that have problems marked: an empty
  label, duplicate keys, a choice with no options, min > max, an image without
  alt text.

Suggested library: `@dnd-kit` (pointer, touch and keyboard sensors; sortable).

### 7.4 Preview

- A "Preview" toggle in the builder shows the **unsaved** form exactly as
  visitors will see it, rendered by the same component code in preview mode.
- In preview mode nothing is sent: checks run, and "Send" shows the sent
  message.
- Width switch: phone / desktop.
- "Preview" on the list opens the saved version the same way.

### 7.5 Responses (`/responses`)

- The current Messages page, renamed.
- Filters: form, unread, and for approvable forms **All / Approved / Not approved**.
- Each response shows answers with their labels (as sent), page, time, and the
  signed-in visitor when there is one.
- Actions: mark read/unread, trash/restore, and for approvable forms
  **Approve / Unapprove**. Approving also marks it read.
- Approvals show who approved and when.
- Activity log entries: `response-approved`, `response-unapproved`,
  `form-created`, `form-saved`, `form-duplicated`, `form-trashed`,
  `form-restored`, `form-switched`, `api-key-created`, `api-key-revoked`.

### 7.6 Approvals, the rules

- Approve/Unapprove exists only while the form is approvable.
- Switching approvable **off** keeps the stored approvals, but hides them in the panel, and `/approved` answers `404 not-approvable`. Switching it back on brings them back.
- A trashed response is never returned by the API, approved or not. Restoring it restores its approval.
- Editing the form never changes approvals.

---

## 8. Permissions

| Action | Who |
|---|---|
| List, build, save, preview, duplicate, switch on/off, trash/restore forms | Any account holder |
| Read, approve, trash responses | Any account holder |
| Switch "Anyone can read approved responses" on | Any account holder, with a passkey check in the last 10 minutes (it publishes data) |
| Create or revoke API keys | **Account managers only** (D20), with a passkey check in the last 10 minutes (existing `manager-recent` level). Members can see the key list (labels, levels, last used) but not create or revoke. |

---

## 9. API

### 9.1 Where it lives

`https://pammy.org/_pammy/api/forms/...`. The same paths work on any
`<folder>.pammy.org` hostname.

- It is served by **the gate**, which already owns `gate.db`.
- `pammy.org/api/` can't be used: nginx sends it to Pamela's own app (port 3042).
- `panel.pammy.org` isn't used either: it is passkey-session-only and can't read `gate.db`.

### 9.2 Keys

- Created by an account manager in the panel under **Forms → API keys**, then
  copied and handed to whoever needs it (D20).
- Each key has a label ("Olivia's site"), a **level** (`approved` or `all`), and
  which forms it may read (all forms, or a chosen list).
- The key is shown **once**, as `pammy_<32 random bytes, base64url>`. Only its
  SHA-256 is stored. The panel shows its first 8 characters, when it was
  created and by whom, and when it was last used.
- Revoke works immediately.
- Sent only as a header: `Authorization: Bearer pammy_…`. A key in the query
  string is refused, so keys never land in logs or Cloudflare.
- **A key must never be put in a web page.** Pages use keyless reads (§9.3a).

### 9.3 Routes

`:id` is the form's internal id (D16). All routes are `GET`.

| Route | Returns | Key level needed |
|---|---|---|
| `/_pammy/api/forms/:id/all` | every response not in the trash | `all` |
| `/_pammy/api/forms/:id/approved` | approved responses not in the trash | `approved` or `all` |
| `/_pammy/api/forms/:id/all/filterby/:field/:value` | `all`, where the field's answer matches | `all` |
| `/_pammy/api/forms/:id/approved/filterby/:field/:value` | `approved`, where the field's answer matches | `approved` or `all` |

`filterby` is nested under `all`/`approved` (D14, D15), so the key level always
matches what is returned.

### 9.3a Reading approved responses without a key (D17)

`/approved` and `/approved/filterby/…` also work **without a key** when the
form is approvable **and** its "Anyone can read approved responses" switch is
on. Otherwise a keyless call gets `401 no-key`. Keyless output differs:

- Only fields marked "Show publicly" appear, in `fields` and in each response's `answers`.
- `filterby` on a field that isn't public answers `400 unknown-field`. A private field can't be probed by guessing values.
- `page` is left out. `signedInAs` appears only if the form's "Show who sent it publicly" is on (D23).
- The rate limit is per IP: 120 requests/min.
- Built for a page on her site:
  `fetch('/_pammy/api/forms/12/approved?order=desc&limit=20')`.
  It's same-origin on pammy.org and every folder subdomain, so no CORS is needed.

**Matching rules for `filterby`:**
- **`:field`:** a field key, or a part of a compound field (`name.last`,
  `address.town`).
- **`:value`:** URL-encoded. It matches the stored answer exactly, ignoring
  capitals and spaces at either end.
- **Multiple choice:** matches if any picked option equals the value.
- **Single checkbox:** `true`/`false`.
- **Number, rating and scale:** numeric equality.
- **An unknown field key** answers `400 unknown-field`, listing the form's keys.

### 9.4 Order and paging (answers "how?")

| Query parameter | Values | Default |
|---|---|---|
| `order` | `asc` (oldest first) or `desc` (newest first) | `asc` |
| `limit` | 1–1000 | 100 |
| `after` | the `next` cursor from the previous page | (start) |

- Sort is by time received, then response id, so the order is stable even for
  responses in the same second.
- The cursor is opaque and remembers the order, so pages never skip or repeat
  a response when new ones arrive.

Examples:

```
GET /_pammy/api/forms/12/approved                       oldest first
GET /_pammy/api/forms/12/approved?order=desc&limit=20   20 newest
GET /_pammy/api/forms/12/all/filterby/attending/yes?order=desc
```

### 9.5 Response body

```json
{
  "form": { "id": 12, "name": "olivias-form", "title": "Olivia's party RSVP" },
  "fields": [
    { "key": "your-name", "label": "Your name", "type": "name" },
    { "key": "attending", "label": "Coming?", "type": "single-choice" }
  ],
  "order": "asc",
  "responses": [
    {
      "id": 481,
      "sentAt": "2026-09-18T14:02:11Z",
      "approved": true,
      "approvedAt": "2026-09-18T15:00:03Z",
      "page": "/olivia/rsvp.html",
      "signedInAs": "auntie.jo",
      "answers": {
        "your-name": { "first": "Jo", "last": "Smith" },
        "attending": "Yes"
      }
    }
  ],
  "next": "eyJ0IjoxNzU4...",
  "total": 57
}
```

- `fields` is the form **as it is now**. Each response's `answers` holds the
  keys **as they were when sent**, so a deleted field's key can still appear.
- In `/approved` output, `approved` and `approvedAt` are left out (always true).
  `signedInAs` stays in keyed calls (D18). For keyless calls, see §9.3a and §14.
- **Never returned:** IP, hostname, read state, who approved, trashed responses.
- `next` is `null` on the last page. `total` counts every match, not just this page.

### 9.6 Errors

JSON `{ "error": "<code>", "message": "<plain English>" }`.

| Status | `error` |
|---|---|
| 400 | `bad-order`, `bad-limit`, `bad-cursor`, `unknown-field`, `key-in-query` |
| 401 | `no-key` (and the form isn't public), `bad-key` (revoked and unknown keys look the same; a bad key never falls back to keyless output) |
| 403 | `not-allowed` (key level too low, or form not in the key's list) |
| 404 | `no-form` (no such id, or in the trash), `not-approvable` |
| 429 | `too-many` (per key: 600 requests/min; keyless: 120/min per IP; bad keys: 30/min per IP) |

### 9.7 Headers and caching

- Keyed responses: `Cache-Control: private, no-store`, plus `ETag` (a repeat
  request with `If-None-Match` gets a 304 and no body).
- Keyless responses: `Cache-Control: no-cache` plus `ETag`, so browsers get a
  cheap 304 but always check first. Unapproving a response, or switching the
  form's public switch off, takes effect on the very next request.
- The gate's global `no-store` already stops Cloudflare caching `/_pammy/`.
- CORS: none. On her own pages the API is same-origin. Programs elsewhere call
  it server-side.

---

## 10. Security and privacy checklist

- The response-reading API is **read-only**. Nothing in it changes data.
- **Keys:** hashed at rest, shown once, header-only, revocable, last-used shown, and creation needs a recent passkey check.
- **Key level:** an `approved` key can never read unapproved responses, including through `filterby`.
- **Keyless reads** need three things at once: the form is approvable, its public switch is on, and the response is approved. They show only "Show publicly" fields and never `page`. Turning the public switch on needs a recent passkey check and is logged.
- **No IP or hostname** in any API output.
- **Protected-folder attribution** can't be forged: the gate checks the visitor's cookie against the page.
- **Approved answers can contain anything a visitor typed.** Guide 10 must tell Pamela (and Claude, when helping her) to put them on a page with `textContent`, **never `innerHTML`**.
- **`thanks` stays on the same site** (checked in the component). The gate needs no redirect logic.
- **Name rules:** form names and field keys use a strict character set, so they are safe in URLs, HTML attributes and CSS selectors.
- **Rollback:** this migration renames and drops tables, so an old release can't run on the new `gate.db`. `install-panel.sh` must back up `gate.db` before migrating, and restore it on rollback. This is a change from the current "migrations only add" rule.
- **Accounts and passkeys are untouched (§4.0):** no `panel.db` migration, no backup or restore of it, and a verify check that its schema version and passkey count don't change.

---

## 11. Performance notes

- **Page views:** loading a form costs one indexed read. `ETag` makes repeats a 304. The "used on" write is throttled to once per hour per page.
- **Save:** one row write, with no draft copies (D11).
- **API:** list queries use the `(form_id, created_at, id)` index with cursor paging (no `OFFSET`). Filters use the indexed `response_values` table, not a JSON scan. `total` comes from a `COUNT` on the same index.
- **Builder:** all edits stay in the browser until Save. The preview uses the same component code, so there is no round trip.

---

## 12. What changes elsewhere

| Area | Change |
|---|---|
| Guides | `contact-forms-guide.txt` → `forms-guide.txt`, synced as `10-forms.txt`. Rewritten: the component, `thanks`, the builder (computer and phone), approvals, and a PART on showing approved responses on her site. `sync-pamela-guides.sh` must remove the old `10-contact-forms.txt`, or `verify-pamela-access.sh` flags an unexpected file. Guide 08: tab names, and the Forms/Responses parts. Guide 00: README lines. Guide 09: contact-page mentions. |
| Help | `GUIDES_BY_PART` / slugs: `/help/forms`. `help.test.ts` expects the new file name. |
| Gate | `contact.ts` → `forms.ts`. Routes from §5.3 and §9. `/_pammy/contact*` routes removed. `public-gate/contact.js` → `forms.js`. |
| Panel server | `/api/contact/*` → `/api/forms/*`, `/api/messages/*` → `/api/responses/*`, plus the API key routes. Home counts. |
| Panel web | Forms list, builder, preview, Responses, API keys, menu, home. |
| sitefs helper | Drop the `contact-pages` and `contact-starter` ops (no more contact.html starters). |
| nginx | No change. |
| verify-panel.sh | The live round trip becomes: make a form, put `<pammy-form>` on a test page, send through Cloudflare, see it in Responses, approve it, read it back through the API with a temporary `approved` key, revoke the key, check the key now gets 401, clean up. |
| README.md | The Forms/API section. |

---

## 13. Build order

Each step ends with `build.sh` green. Steps 1–3 can ship together or one at a time.

1. **Gate and data:**
   - migration (with the `gate.db` backup/restore in `install-panel.sh`)
   - `forms.ts` item model and every check in §6
   - `forms.js` component with all item types, `thanks`, the unavailable states and preview mode
   - submission, `response_values`, "used on"
   - unit and gate-nginx tests
2. **Panel, tap-based first:**
   - Forms list, duplicate, trash/restore, on/off
   - the builder in its **tap-based form at every width** (so phones work from day one), plus preview
   - Responses with approvals
   - e2e on desktop and phone
3. **Drag and drop:** the three-column wide-screen builder on top of step 2.
   e2e drags with mouse and keyboard.
4. **API:** keys in the panel, the routes in §9, filtering, cursors, rate limits.
   Unit tests for every level/filter/order/cursor case. The gate-nginx test
   makes sure no key or response is ever cached.
5. **Guides, verify and install:** guide rewrites, `verify-panel.sh` round trip,
   install, guide sync (including removing the old guide file).

---

## 14. Questions

All answered. The last one: keyless output includes who sent it only when the
form's **"Show who sent it publicly"** setting is on, which is **off by
default** (D23).

### Answered 2026-09-17

| Q | Answer |
|---|---|
| Q1 | `/filterby/:field/:value` (D14) |
| Q2 | Under both `all` and `approved` (D15) |
| Q3 | Internal id (D16) |
| Q4 | Yes, pages can read approved responses without a key (D17) |
| Q5 | Yes, include who sent it (D18) |
| Q6 | Fixed once saved (D19). While a field is new and unsaved, its key follows the label, so a typo fixed before Save doesn't stick. |
| Q7 | Account managers create keys and hand them out (D20) |
| Q8 | Convert (D21) |
