# Looking at the code

This folder is a map of the control panel's code. It is for anyone who opens
the tree: Pamela, momolig, and a later agent. It is **not** a Help guide, and
it is not copied into the Help tab.

The Help tab still tells you how to *use* the panel. The operator README still
tells you how to build and install it. The files named `docs/*-plan.md` still
hold the decisions as they were made (D1, S7, …). This handbook answers a
fourth question: **what is this code, why this stack, and what does each
important function do?**

## How to read it

Start with [00-map.md](00-map.md) (the five processes) and [01-stack.md](01-stack.md)
(why these libraries). Then open the part you are in.

Every part page has the same shape:

1. What this is
2. Stack and why
3. How it talks to the rest
4. The few types you have to know
5. Function catalog (exports, routes, socket ops, pages)
6. See also (the matching plan, README, or guide PART)

A function entry is a short heading in ordinary words, then the name in
backticks so you can search the tree. The comment next to the line in the
source still explains the awkward detail. Do not expect JSDoc.

## What is in here

- [00-map.md](00-map.md) — five processes, sockets, schemas, who talks to whom
- [01-stack.md](01-stack.md) — whole-project stack and why each piece
- [panel.md](panel.md) — the Fastify API, pages, sessions, security
- [gate.md](gate.md) — the front door of pammy.org
- [sitefs.md](sitefs.md) — the website folder helper, running as pamela
- [pammydb.md](pammydb.md) — the helper for her MariaDB and Postgres
- [thumbs.md](thumbs.md) — thumbnails in isolation
- [auth.md](auth.md) — passkeys, invites, who may do what
- [media.md](media.md) — media records, sync, labels, the public index
- [files.md](files.md) — file explorer, editor, versions, preview
- [forms.md](forms.md) — forms, responses, the public form API
- [visitors.md](visitors.md) — protected folders, people, requests
- [studio.md](studio.md) — databases in the panel, the generated app
- [widgets.md](widgets.md) — `<pammy-login>` and `<pammy-form>`
- [web.md](web.md) — the React pages, the shell, the hooks
- [deploy.md](deploy.md) — systemd, nginx, Cloudflare, the Postgres container
- [database.md](database.md) — schemas `panel` / `media` / `gate`, migrations
- [tests.md](tests.md) — `node:test`, Playwright, live verify
- [cli.md](cli.md) — `sudo pammy-panel …`

## What counts as important

Included: exported functions, HTTP routes, socket `op`s, CLI commands, custom
elements (`<pammy-login>`, …), React pages, systemd units and nginx files.

Skipped, or a one-line mention: three-line formatters, unnamed inner helpers,
built files under `public/` and `public-gate/*.js` (document the source in
`packages/*/web` and `packages/*/widgets`), `release/`, `node_modules/`, and the shadcn files
under `packages/core/web/components/ui/` except where a comment names one as a
constraint.

If a function is both an export and an HTTP handler, it is documented once, at
the route, and the helper it calls is named there.

## Voice

The same habits as the guides (`control-panel-guide.txt`) and the comments in
the source. Short sentences. "Her" for Pamela. Reasons next to rules. No
"the authentication subsystem."

If a reason is not written down in the tree, this handbook says so rather than
inventing one.
