# Visitor widgets

Two scripts her pages load with a plain `<script defer>`:

- `/_pammy/login.js` — sign-in, forgot, invite, request, logout, welcome
- `/_pammy/forms.js` — `<pammy-form name="…">`

Source is [`packages/areas/widgets/login.ts`](../../packages/areas/widgets/login.ts) and
[`packages/forms/widgets/forms.ts`](../../packages/forms/widgets/forms.ts), plus
[`packages/core/widgets/base.ts`](../../packages/core/widgets/base.ts). `public-gate/*.js` is
built. Edit the `.ts`. The opening comment of each source file is copied
onto the built file (guides 09 and 10 keep in step with it).

## Stack and why

- **Lit 3**, one IIFE each, Lit bundled. No modules on her page.
- **Light DOM** — `createRenderRoot()` returns `this`. Her CSS must reach
  every field. Class names are the contract: `pammy-box`, `pammy-form`,
  `pammy-heading`, `pammy-field`, `pammy-label`, `pammy-input`,
  `pammy-button`, `pammy-message`, …
- **Built-in styles inside `:where()`**, prepended to `<head>`. Any rule
  on her page wins. `styles="off"` leaves them out (the spam trap is
  hidden with an inline style; `[hidden]` stays hidden).
- **Wording attributes** for every label except server errors
  (`heading`, `button`, `username-label`, …).
- **CSS variables:** `--pammy-accent`, `--pammy-accent-text`,
  `--pammy-radius`, `--pammy-font`, `--pammy-width`, `--pammy-gap`,
  `--pammy-field-bg`, `--pammy-field-border`, `--pammy-error`,
  `--pammy-success`.

## How it talks to the rest

They POST to `/_pammy/…` on whichever hostname they are on
(`credentials: same-origin`). `GET /_pammy/about` tells them which of the
five pages exist. Preview mode: path
`/_pammy/examples/<look>/<page>.html` — nothing is sent, a bar flips
between the five pages.

## Important types

`PammyElement` — shared base. `pammy-box` always; `pammy-styled` unless
`styles="off"`. `start()` runs once. `adopt()` runs before inner HTML is
cleared (forms keep her `<template class="pammy-thanks">`).

## Functions — packages/core/widgets/base.ts

### `addStyle(id, css)`

Prepend a `<style>` once.

### `words(...names)`

Wording attributes as Lit properties, same name as the attribute.

### `PammyElement`

Light DOM, class names, `text(attr, fallback)`.

### `trap(name)`

Honeypot field, off-screen. Login request uses `pl-leave-this-empty`;
forms use `website`.

## Custom elements — login.ts

| Element | Page | Job |
|---|---|---|
| `<pammy-login>` | `login.html` | Sign in. If already signed in but this folder is denied, says so. |
| `<pammy-forgot>` | `login-forgot.html` | Ask for a reset link |
| `<pammy-invite>` | `login-invite.html` | Choose a password from `#token` (stripped into sessionStorage) |
| `<pammy-request>` | `login-request.html` | Ask for access; honeypot; closed-text if requests are off |
| `<pammy-signed-out>` | `logout.html` | Signs out on arrival |
| `<pammy-welcome>` | built-in, or a folder with no index | List of pages this visitor may open |
| `<pammy-logout>` | any private page | Button: sign out, go to this folder's logout page |

Optional attribute `area` when the built-in pages cannot guess from the
path. `links="off"` hides forgot/request.

## Custom elements — forms.ts

### `<pammy-form name="…">`

Fetches `GET /_pammy/forms/:name`, draws items, POSTs answers. Attributes:
`thanks` (same-site page), `sent-text`, `unavailable-text`, `heading`,
`intro`, `button`, … Fields carry `data-key` and `data-type`; labels carry
`data-question`. A wrong field gets `aria-invalid="true"`.

Thank-you, in order: `thanks="…"`, else inner
`<template class="pammy-thanks">`, else `.pammy-sent`.

## Build

`PAMMY_COMPONENT=login|forms vite build --config sites/pammy/widgets/vite.config.ts`
(from `npm run components:build` / `build.sh`). IIFE, minified, source
header restored after minify.

## See also

- [gate.md](gate.md), [forms.md](forms.md), [visitors.md](visitors.md)
- Guides 09 PART 6–7 and 9–11, guide 10 PART 5–6
