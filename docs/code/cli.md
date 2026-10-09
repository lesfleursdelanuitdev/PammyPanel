# The command line

`sudo pammy-panel …` on the server. Wrapper:
[`deploy/pammy-panel-cli`](../../deploy/pammy-panel-cli) →
[`src/cli.ts`](../../src/cli.ts). It switches to `svc-pammypanel`, loads
`/etc/pammy-panel/panel.env`, and passes the database password on an
open fd (the panel user may not read the password file).

This is the way in when nobody can use the panel: the first account, and
a manager who lost every passkey.

## Stack and why

Same `accounts.ts` functions as the API. Same `Config`. No second copy of
the rules.

## Commands

### `pammy-panel users`

List username, name, role, on/off, passkey count, scope.

### `pammy-panel add-user <u> "<Name>" [--manager]`

Create. Next: `invite`.

### `pammy-panel invite <u>`

Print a passkey setup link (`https://panel.pammy.org/invite#…`), 24 hours,
once. Anyone with the link can add a passkey, so send it privately.

### `pammy-panel disable` / `enable` / `signout` / `role` / `scope`

`role` is `manager` or `member`. `scope` is a folder name or `all`.
Scope signs them out everywhere.

### `pammy-panel activity [n]`

Recent log lines.

### `pammy-panel media-images`

Once: `media/photos` → `media/images`. The installer runs it.
[`src/media-rename.ts`](../../src/media-rename.ts) `renamePhotos`.

### `pammy-panel media-sync [--all-hashes]`

Bring the media records up to date with the folders now. `--all-hashes`
drops the 1 GB / 2000-file budget.

### `pammy-panel media-thumbs [--only <path>]`

Make every thumbnail still waiting, or just that file's.

## See also

- [auth.md](auth.md), [media.md](media.md), [deploy.md](deploy.md)
- README "Command line"
