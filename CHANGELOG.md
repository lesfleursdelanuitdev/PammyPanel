# Changelog

The milestones of PammyPanel, newest first. Dates are when each piece went live on the server. Every install ended with a verify run against the live site. The plan behind each entry is in `docs/`.

## October 2026: hardening and structure

- **2026-10-08**: Off-site backups. Encrypted restic copies go to two independent providers, and each copy is checked after it's made (`deploy/recovery/`).
- **2026-10-08**: Signed identity between the gate and hosted apps. The gate signs who a visitor is with Ed25519, and apps check that proof instead of trusting headers. Apps run in containers on their own network (pasta port forwards).
- **2026-10-06**: Architecture review (`docs/architecture.md`). It found hidden coupling between modules, and a coupling report now keeps it visible.
- **2026-10-06**: Projects. Next.js and Vite apps with npm or pnpm, each with a dev branch, run as containers the panel manages.
- **2026-10-04**: A MariaDB service for hosted apps, and a Backups setting with how many days to keep.
- **2026-10-04**: Help on the second site, with seven new guides.

## Late September 2026: one panel, two sites

- **2026-09-30**: pammy.org moved onto the shared hosts-and-routes system, with all form answers carried over.
- **2026-09-29**: A catalog of files, database tables and apps across modules, with API keys.
- **2026-09-29**: A third domain added through the Hosts page.
- **2026-09-27**: Monitoring with a watchdog timer.
- **2026-09-26**: Roles: per-area role sets (guest, signed-in, named people), applied to routes.
- **2026-09-25**: Second site live: panel.lesfleursdelanuit.com, its own Postgres, and its nginx taken over from hand-written config. Two existing apps adopted, and their databases moved with a short planned switch.
- **2026-09-25**: Permissions. Rights switched on or off per part of the panel, plus an Accounts page.
- **2026-09-24**: Packaging. The single app split into `@panel/*` packages with per-package migrations and a site profile, with no change in behaviour.
- **2026-09-23**: Installed software. The existing WordPress was adopted without changes, with backups, restore, offline mode and email through Resend.
- **2026-09-23**: Getting started: a short questionnaire that suggests a path, with progress read from what the owner has done.

## Mid September 2026: features for the site owner

- **2026-09-22**: Tutorials and PHP. Guides for a blog and a to-do list, in plain JavaScript and in PHP, plus a PHP runtime the gate controls.
- **2026-09-22**: Comments, built on forms with forced approval.
- **2026-09-22**: Rich text fields (Tiptap, sanitised on the server) and a fix to the field order in forms.
- **2026-09-21**: Database examples: a recipe book on Postgres and a blog on MariaDB, with public read-only pages.
- **2026-09-21**: Record picker. Connected records are chosen by search and filters, many-to-many included.
- **2026-09-21**: Studio, a visual database workspace with a table canvas, relationships and an app view.
- **2026-09-19**: The panel's own data moved from SQLite to Postgres. The cutover took one evening, and every record and passkey came across.
- **2026-09-19**: The site owner's sudo access removed. Databases and containers moved to dedicated service accounts.
- **2026-09-19**: File Explorer editor with versions, and tags on every file.
- **2026-09-18**: Media: folders, a media database, thumbnails, a public media API with keys, and example pages.
- **2026-09-18**: Per-form choice between "Show right away" and "Wait for my OK".
- **2026-09-17**: Forms. A form builder that works on phones, `<pammy-form>` on any page, and responses with approval.
- **2026-09-17**: Front end rebuilt in React, Tailwind and shadcn-style components.
- **2026-09-16**: First release: passkey sign-in, accounts, activity log, subdomains, password-protected folders with self-service sign-in pages, and Help with the owner's guides.
