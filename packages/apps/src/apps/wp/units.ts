// A panel install's units (4b): the blog's quadlet and backup units
// (~/pamela-setup/wordpress/quadlet, systemd), with its own names, port and
// folders -- and the memory limits plan G7 gives every new install.
import type { AppRecord } from '../record.ts';
import { partsOf } from '../wordpress.ts';

export function unitsFor(a: AppRecord, domain: string): Record<string, { dir: 'quadlet' | 'user'; text: string }> {
  const p = partsOf(a);
  const home = `/var/lib/${a.user}`;
  const who = `WordPress "${a.id}", installed from the ${domain} panel (docs/apps-plan.md 4b)`;
  return {
    [`${a.units.web}.container`]: { dir: 'quadlet', text: `# ${who}: Apache + PHP. Rootless Quadlet for ${a.user}.
# Reached only through nginx (/etc/nginx/pammy-wordpress, written by the software helper).
[Unit]
Description=${who}: web
Requires=${a.units.db}.service
After=${a.units.db}.service

[Container]
Image=docker.io/library/wordpress:php8.3-apache
ContainerName=${a.units.web}
Network=${p.network}.network
PublishPort=127.0.0.1:${a.port}:80
# www-data (33) in the container is ${a.user} on the host, so its files are a real
# user's, in a group Pamela is in (see the blog's pammywp-web.container)
UserNS=keep-id:uid=33,gid=33
User=root
Volume=${a.files}:/var/www/html
Volume=${a.config}:/etc/pammywp:ro
Volume=${a.config}/apache.conf:/etc/apache2/conf-enabled/zz-pammywp.conf:ro
Volume=${a.config}/php.ini:/usr/local/etc/php/conf.d/zz-pammywp.ini:ro
Environment=WORDPRESS_DB_HOST=${a.units.db}
Environment=WORDPRESS_DB_NAME=${p.database}
Environment=WORDPRESS_DB_USER=${p.database}
Environment=WORDPRESS_DB_PASSWORD_FILE=/run/secrets/${p.dbSecret}
Environment="WORDPRESS_CONFIG_EXTRA=require '/etc/pammywp/wp.php';"
Secret=${p.dbSecret}
AutoUpdate=registry

[Service]
Restart=always
TimeoutStartSec=300
MemoryMax=512M

[Install]
WantedBy=default.target
` },
    [`${a.units.db}.container`]: { dir: 'quadlet', text: `# ${who}: its database (MariaDB). Rootless Quadlet for ${a.user}.
[Unit]
Description=${who}: database

[Container]
# 11.4 is an LTS series: auto-update brings patch releases, never a major jump
Image=docker.io/library/mariadb:11.4
ContainerName=${a.units.db}
Network=${p.network}.network
Volume=${a.units.db}.volume:/var/lib/mysql
Environment=MARIADB_DATABASE=${p.database}
Environment=MARIADB_USER=${p.database}
Environment=MARIADB_PASSWORD_FILE=/run/secrets/${p.dbSecret}
Environment=MARIADB_ROOT_PASSWORD_FILE=/run/secrets/${p.rootSecret}
Secret=${p.dbSecret}
Secret=${p.rootSecret}
HealthCmd=healthcheck.sh --connect --innodb_initialized
HealthInterval=30s
AutoUpdate=registry

[Service]
Restart=always
TimeoutStartSec=300
MemoryMax=384M

[Install]
WantedBy=default.target
` },
    [`${a.units.db}.volume`]: { dir: 'quadlet', text: `# ${who}: its database's data, in ${a.user}'s container storage.
[Volume]
VolumeName=${a.units.db}
` },
    [`${p.network}.network`]: { dir: 'quadlet', text: `# ${who}: a private network, so the web container reaches the database by name.
[Network]
NetworkName=${p.network}
` },
    [`${p.backupUnit}.service`]: { dir: 'user', text: `[Unit]
Description=Back up ${who} (database + files)

[Service]
Type=oneshot
Environment=APP_DB_CONTAINER=${a.units.db}
Environment=APP_ROOT_SECRET=${p.rootSecret}
Environment=APP_DATABASE=${p.database}
Environment=APP_FILES=${a.files}
Environment=APP_BACKUPS=${a.backups}
Environment=APP_CONTENT_URL=${a.config}/content-url
ExecStart=${home}/bin/backup-app.sh
` },
    [`${p.backupUnit}.timer`]: { dir: 'user', text: `[Unit]
Description=Nightly backup of ${who}

[Timer]
OnCalendar=*-*-* 03:40:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
` },
  };
}
