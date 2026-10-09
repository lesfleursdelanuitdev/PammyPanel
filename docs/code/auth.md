# Passkeys, accounts, who may do what

How an account holder signs in, how a new one is invited, and the checks
every API route runs first. Visitor sign-in (username and password) is
[visitors.md](visitors.md), not this page.

## Stack and why

Passkeys only. No panel passwords. `@simplewebauthn`, user verification
required, RP ID `panel.pammy.org`. Invites are a URL with a `#fragment`
token, 24 hours, one live invite per account. The last manager cannot be
demoted or switched off. See [01-stack.md](01-stack.md) and
[panel.md](panel.md) for the cookie and CSRF.

## How it talks to the rest

Tables `users`, `passkeys`, `invites`, `sessions`, `ceremonies`, `activity`
in schema `panel`. The CLI (`sudo pammy-panel`) calls the same functions in
[`src/accounts.ts`](../../src/accounts.ts) as the API, so they cannot
disagree.

## Important types

- `UserRow.role` — `manager` | `member`. Managers: Accounts, studio,
  creating API keys. Made only from the CLI (`add-user --manager` / `role`).
- `UserRow.scope` — `null` (the whole panel) or `/olivia` (that folder's
  media, files, forms, responses, plus own passkeys and Help). Everything
  else is 404 (`LIMITED_ROUTES` in `app.ts`).
- `Actor` — who did a thing, for the activity log. `COMMAND_LINE` is the
  CLI (`id: null`).

## Panel routes — sign in and the session

### `POST /api/login/options` / `POST /api/login/verify`

Public. WebAuthn authentication options, then verify the assertion and set
the session cookie. Rate limited.

### `POST /api/logout`

Revoke this session, clear the cookie.

### `GET /api/session`

`{ user, recentAuth }`. The shell waits on this. `recentAuth` is whether
the last passkey tap was inside 10 minutes.

### `POST /api/invite/info` / `options` / `verify`

Public. A setup link: who it is for, then register the first passkey, then
sign in. Token in the URL hash, same pattern as visitor setup links.

### `POST /api/reauth/options` / `verify`

Signed in. Refresh `auth_at` so a sensitive action may go on.

## Panel routes — own passkeys and devices

### `GET /api/me/passkeys`

List. Adding, renaming, deleting need `recent`.

### `POST /api/me/passkeys/options` / `verify` / `:id/rename` / `:id/delete`

Register another passkey, rename one, delete one. You cannot delete your
last passkey from here (that would lock you out). A manager can, and then
send a new invite.

### `GET /api/me/sessions` / `POST /api/me/sessions/:id/revoke`

Devices this account is signed in on.

### `GET /api/activity`

The log. Reading is not itself logged. Making, trashing, keys, and account
changes are. Form *answers* never reach Activity.

## Panel routes — other accounts (managers)

### `GET /api/users`

List. Create / invite / disable / enable / signout / delete a passkey /
set scope need `manager` or `manager-recent` as the route says in `app.ts`.

### `POST /api/users`

Create a member. Managers only from the CLI.

### `POST /api/users/:id/invite` / `invite/cancel`

A 24-hour passkey setup link. One live per user; a new one cancels the old.

### `POST /api/users/:id/disable` / `enable` / `signout` / `scope` / `passkeys/:pid/delete`

Disable signs them out everywhere. Scope ends their sessions so a
half-loaded page cannot keep the old rights.

## Functions — src/accounts.ts

### `logActivity` / `getUser` / `getUserByName` / `listPasskeys`

### `createUser` / `createInvite` / `findLiveInvite` / `cancelInvites`

One live invite per account. Token stored as SHA-256.

### `setActive` / `setRole` / `setScope` / `signOutEverywhere` / `revokeSessions`

Last active manager cannot be demoted or switched off. A scoped account
cannot be a manager; a manager cannot be scoped.

### `deletePasskey(..., allowLast)`

`allowLast` is true only for a manager acting on someone else (or the CLI).

## Functions — src/app.ts (auth helpers)

### `registrationOptions` / `registerPasskey` / `checkAssertion` / `signIn`

WebAuthn register and assert. Algorithms EdDSA, ES256, RS256. A passkey
registered twice (two tabs) hits the unique key and becomes 409.

## Functions — src/util.ts (tokens and names)

### `newToken` / `hashToken` / `looksLikeToken`

43-character URL-safe tokens. SHA-256 at rest.

### `USERNAME_RE` / `cleanDisplayName` / `cleanPasskeyName` / `describeUserAgent`

Usernames: 2–32, lowercase, start with a letter. Passkey name is a label
("iPhone"). User-agent is turned into a short device line for the sessions
list.

## Help

### `GET /api/help`

Parsed guides from `helpDir` (copied by `build.sh` from `../guides.map`).
A scoped account only sees 11, 10, and 12.

### `loadGuides` / `parseGuide` / `parseBlocks` / `sentenceCase` — src/help.ts

The plain-text habits: PART headings, capital subheadings, numbered steps,
term + indented explanation, `key  value` tables, indented examples as
code. `test/help.test.ts` checks all nine (now fourteen) guides.

## See also

- [panel.md](panel.md), [cli.md](cli.md)
- Guide 08 PART 1 (first passkey), PART 11 (Help tab)
