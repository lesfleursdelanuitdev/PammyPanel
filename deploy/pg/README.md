# pammy-pg: the panel's and the gate's Postgres

See `docs/postgres-plan.md`. This folder is build step 1: the container only.
Nothing uses it until the cutover.

```
sudo ~/pamela-setup/panel/deploy/pg/install-pg.sh     # install or update; ends by running verify-pg.sh
sudo ~/pamela-setup/panel/deploy/pg/verify-pg.sh      # check it (changes nothing lasting)
```

| What | Where |
|---|---|
| Service user | `svc-pammypanel-db` (system user, linger, its own subuids) |
| Container | `pammy-pg` (`postgres:17`, patch updates via podman-auto-update), 127.0.0.1:5434, 1G memory |
| Units | `~svc-pammypanel-db/.config/containers/systemd/pammy-pg.{container,volume}`, `~/.config/systemd/user/pammy-pg-backup.{service,timer}` |
| Who may connect | `/var/lib/svc-pammypanel-db/conf/pg_hba.conf` (from `pg_hba.conf` here; the container mounts the `conf` folder, so a new file is seen); after a change, re-run the installer (it reloads and checks the engine sees it) |
| Database | `pammy`: schemas `panel`, `media`, `gate`; builtin C.UTF-8 |
| Roles | `pammy_owner` (owns everything, migrations; installer only), `pammy_panel` (panel + media), `pammy_gate` (gate) |
| Passwords | podman secrets `pammy-pg-{super,owner,panel,gate}`; copies in `/etc/pammy-panel/db/{owner,panel,gate}.pass` (root 600). The superuser has no file: it only works through `podman exec`. |
| Backups | `/var/lib/svc-pammypanel-db/backups` (700): `pammy-<time>-nightly.dump` (04:30 UTC, 14 days) and `pammy-<time>-before-<release>.dump` (made by the panel installer, 60 days), each with a `.roles.sql` |

## Handy

```
U='systemctl --user -M svc-pammypanel-db@'
sudo $U status pammy-pg                     # restart / stop the same way
sudo journalctl _SYSTEMD_USER_UNIT=pammy-pg.service _UID=$(id -u svc-pammypanel-db) -n 50
# psql as the superuser (inside the container):
sudo bash -c 'cd / && runuser -u svc-pammypanel-db -- env XDG_RUNTIME_DIR=/run/user/$(id -u svc-pammypanel-db) podman exec -it -u postgres pammy-pg psql -d pammy'
# as a service role, the way the service connects:
sudo bash -c 'PGPASSWORD=$(cat /etc/pammy-panel/db/panel.pass) psql -h 127.0.0.1 -p 5434 -U pammy_panel pammy'
# a backup now:
sudo $U start pammy-pg-backup.service
```

## Restoring a backup

Stop the panel and the gate first, so nothing writes while it's restored.

```
sudo systemctl stop pammy-panel pammy-gate
R='cd / && runuser -u svc-pammypanel-db -- env XDG_RUNTIME_DIR=/run/user/$(id -u svc-pammypanel-db)'
F=/var/lib/svc-pammypanel-db/backups/pammy-<time>-<label>.dump
sudo bash -c "$R podman exec -i -u postgres pammy-pg psql -d postgres -c 'DROP DATABASE pammy WITH (FORCE)'"
sudo ~/pamela-setup/panel/deploy/pg/install-pg.sh          # makes pammy, the roles and the rights again (empty)
sudo bash -c "$R podman exec -i -u postgres pammy-pg pg_restore -d pammy --exit-on-error --clean --if-exists" < $F
sudo systemctl start pammy-gate pammy-panel
```

If the whole volume is lost, the installer makes a fresh one, and the restore above fills it.
The roles come from the installer (their passwords are the podman secrets), so the
`.roles.sql` files are only for reference.

A restore checked on 2026-09-19 (a throwaway container): the schemas, owners and default
privileges come back.
