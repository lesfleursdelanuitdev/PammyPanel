# The React app (`packages/*/web`, put together by `sites/pammy/web`)

The private website's pages. Vite builds this into `public/` (`index.html` +
hashed `/assets`). The server sends that HTML for every address in
`PAGE_PATHS`. Do not edit `public/`.

Develop: `npm run web:dev` (Vite `:5173`, `/api` proxied to a panel on
`:3044`). Passkeys only work on the real origin, so most UI work uses the
e2e server instead.

## Stack and why

See [01-stack.md](01-stack.md). Short restatement: React 19, react-router 8,
TanStack Query, Tailwind 4, Radix written into `packages/core/web/components/ui`, lucide,
CodeMirror, TipTap, xyflow. No toast library (CSP). Each page copy gets a
CSP nonce; `get-nonce` reads `<meta property="csp-nonce">`.

## How it talks to the rest

`api()` in [`packages/core/web/lib/api.ts`](../../packages/core/web/lib/api.ts) is GET or JSON
POST, `credentials: same-origin`. `useAction` retries once after a
passkey if the server said `reauth-required`, then invalidates every query.

## Important types

[`packages/*/web/lib/types.ts`](../../packages/core/web/lib/types.ts) is the API as the
browser sees it. The comment says `src/app.ts` / `src/gate/forms.ts` are
the source of truth (`ANSWER_TYPES` is duplicated on purpose; the web
bundle does not import the gate).

## Function catalog — bootstrap and shell

### Where the pages are (packaging step 4)

Each package's pages, components and API types are in `packages/<name>/web`
(`pages/`, `components/`, `lib/`, `hooks/`), beside its server code in `src/`.
Each package's `web/routes.tsx` offers its pages (`routes: PageRoute[]`, each
marked `manager` / `limited`) and its menu items (`menu`). Inside a package,
imports are relative; across packages they go by name, `@panel/<name>/web/...`
(a Vite alias and a tsconfig path, `sites/pammy/web`), and only as
`test/boundaries.test.ts` allows. The core has the building blocks: `ui/`,
`page`, `dialogs`, `shell`, `api`, `useApi`, `useAction`, `names`, `format`.

### `App` — sites/pammy/web/src/App.tsx

`/login`, `/invite`, then `SignedIn`: every package's routes, filtered for the
account (managers only where `manager`; an account kept to one folder only
gets the `limited` ones). Keep in step with `PAGE_PATHS`.

### `Shell` — packages/core/web/components/shell.tsx; `MENU` — sites/pammy/web/src/menu.ts

The sliding menu. The site's `MENU` says which package's items go in which
group, and brings the red dots (`useWaiting` in `sites/pammy/web/src/waiting.ts`:
waiting requests, unread responses and comments, polled every minute) and the
studio's `useAppGroups` (a group per activated database). Limited accounts see
`limited: true` items only.

### `main.tsx`

QueryClient, hash→path rewrite for old `/#tab` links, nonce for `get-nonce`.

## Hooks

### `useApi(path, opts)` — useApi.ts

TanStack Query around `api()`. `usePageTitle` sets the tab title.

### `useAction()` — useAction.ts

Run a change; passkey retry; refetch everything; one line of news at the
bottom (`notify`).

### `useMe()` — the signed-in `Me` from `/api/session`.

### `useNarrow()` — phone layout for the form builder.

## lib

### `api` / `ApiError` / `signInWithPasskey` / `confirmWithPasskey` / `createPasskey` / `friendlyError` / `passkeysSupported`

### `packages/files/web/lib/media.ts`

Browse state in the address (`folder`, `kind`, `in`, `q`, `tag`, …),
`sendFile` (XHR for upload progress), kind helpers, prefs in localStorage.

### `packages/files/web/lib/editor.ts`

Which names are editable, the editor address.

### `packages/forms/web/lib/form-items.ts` / `help.tsx` / `schema.ts` / `status.ts` / `names.ts` / `utils.ts`

Form item helpers for the builder; Help rendering; canvas schema helpers;
the notice bar; display names; `cn()`.

## Pages

| Route | Page | What it is |
|---|---|---|
| `/` | `Home` | Waiting requests and unread responses |
| `/login` `/invite` | `Login` `Invite` | Passkey sign-in and first passkey |
| `/subdomains` | `Subdomains` | Site folders |
| `/files` `/files/edit` | `Files` `FileEditor` | Explorer + CodeMirror |
| `/tags` | `MediaTags` | Tags and categories (`/media/tags` redirects) |
| `/media` `/media/folders` `/media/examples` | `Media` `MediaFolders` `MediaExamples` | Gallery, make media folders, example pages |
| `/forms` `/forms/:id` | `Forms` `FormBuilder` | List and builder |
| `/responses` | `Responses` | Inbox |
| `/examples` | `Examples` | Guestbook / RSVP / pinboard |
| `/protected-folders` `/people` `/requests` | those three | Gate management |
| `/databases…` `/app/…` | `Database*` `AppRecord*` | Studio. Lazy-loaded. |
| `/api-keys` | `ApiKeys` | Form/media Bearer keys |
| `/passkeys` `/accounts` `/activity` | those three | Devices; managers; the log |
| `/help` `/help/:guide` `/help/:guide/:section` | `Help` | Searchable guides |

## Shared components (not `ui/`)

`page.tsx` (Page / Section / List / Row), `dialogs.tsx` (`confirm` /
`prompt`), `notice.tsx`, `folder-picker.tsx`, `form-preview.tsx`,
`form-settings.tsx`, `credentials.tsx`, `people.tsx`, `db-password.tsx`,
`record-picker.tsx`, `relationships.tsx`, `rich-text.tsx`, `add-field.tsx`,
`media/*` (grid, table, thumbs, labels, move/copy, trash), `editor/*`.

`components/ui/progress.tsx` is named in [`src/security.ts`](../../src/security.ts):
it sets `style` for the upload bar, which is why CSP allows
`style-src-attr 'unsafe-inline'`.

## See also

- [panel.md](panel.md), [auth.md](auth.md), each feature page
- Guide 08
