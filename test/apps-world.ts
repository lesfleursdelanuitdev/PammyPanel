// A folder laid out like the server, as far as the software helper reads it
// (docs/apps-plan.md phase 1): its passwd, WordPress's files, settings and
// backups, the containers' control groups, nginx's placement line and free
// memory -- as install-wordpress.sh left them. Shared by test/apps.test.ts, the
// panel's tests and the browser tests.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { OpsDeps } from '@panel/apps/apps/ops';
import type { RunResult } from '@panel/apps/apps/runner';
import { join } from 'node:path';

export const WP_UID = 988;
export const VERSION_PHP = "<?php\n$wp_db_version = 58975;\n$wp_version = '6.8.2';\n";

export function wordpressServer(root: string) {
  const put = (p: string, text: string) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  const container = (unit: string, running: boolean, anon = 50_000_000, uid = WP_UID) => {
    const cg = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
    put(`${cg}/${unit}.service/cgroup.events`, `populated ${running ? 1 : 0}\nfrozen 0\n`);
    put(`${cg}/${unit}.service/memory.stat`, `anon ${anon}\nfile 1377783808\nkernel 64106496\n`);
  };
  const placement = (line: string) => put('/etc/nginx/pammy-wordpress/placement', `${line}\n`);
  const lay = () => {
    rmSync(root, { recursive: true, force: true });
    put('/etc/passwd', `root:x:0:0:root:/root:/bin/bash\npamela:x:1001:1001::/home/pamela:/bin/bash\nsvc-pammywp:x:${WP_UID}:981::/var/lib/svc-pammywp:/usr/sbin/nologin\n`);
    placement('subdomain blog');
    put('/srv/pamela-wordpress/wp-includes/version.php', VERSION_PHP);
    put('/srv/pamela-wordpress/index.php', 'x'.repeat(1000));
    put('/srv/pamela-wordpress/wp-content/uploads/2026/09/cake.jpg', 'y'.repeat(4000));
    put('/var/lib/svc-pammywp/config/content-url', 'https://blog.pammy.org\n');
    put('/var/lib/svc-pammywp/config/wp.php', "<?php\ndefine('WP_HOME', 'https://blog.pammy.org');\n");
    put('/var/lib/svc-pammywp/config/apache.conf', '# Written by place-wordpress.sh -- placement: subdomain blog\n# no Alias: WordPress is at the root of its hostname\n');
    put('/var/lib/svc-pammywp/.local/share/containers/storage/volumes/pammywp-db/_data/ibdata1', 'z'.repeat(7000));
    // two whole backups, and half of one (a run that failed part way)
    put('/var/lib/svc-pammywp/backups/db-20260921T033012Z.sql.gz', 'a'.repeat(100));
    put('/var/lib/svc-pammywp/backups/files-20260921T033012Z.tar.gz', 'b'.repeat(300));
    put('/var/lib/svc-pammywp/backups/url-20260921T033012Z.txt', 'https://blog.pammy.org\n');
    put('/var/lib/svc-pammywp/backups/db-20260922T034501Z.sql.gz', 'a'.repeat(110));
    put('/var/lib/svc-pammywp/backups/files-20260922T034501Z.tar.gz', 'b'.repeat(310));
    put('/var/lib/svc-pammywp/backups/db-20260923T031500Z.sql.gz', 'a'.repeat(120));
    container('pammywp-web', true, 46_419_968);
    container('pammywp-db', true, 122_650_624);
    mkdirSync(join(root, 'etc/pammy-mail'), { recursive: true });    // install-panel.sh makes it
    put('/proc/meminfo', 'MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:    3000000 kB\n');
  };
  return { root, put, container, placement, lay };
}

// systemd-run, podman, nginx and the journal, stood in for over that folder --
// enough for the panel's own tests and the browser: a backup makes backup
// files, stopping a container empties its cgroup, WordPress has one admin.
// test/apps-jobs.test.ts looks at each command itself; this only plays along.
export function fakeSystem(world: ReturnType<typeof wordpressServer>, now: () => number, opts: { delayMs?: number } = {}): Omit<OpsDeps, 'templates' | 'log' | 'wpConfig'> {
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const wait = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  // an install called "flaky" stops at its second step the first time (Try again)
  let flakyFailed = false;
  return {
    run: async (spec) => {
      const [c, u, verb, ...units] = spec.argv;
      const home = spec.as === 'root' ? '' : spec.as.home;
      const uid = spec.as === 'root' ? 0 : spec.as.uid;
      // an install (4b): its user, the files its steps write, WordPress appearing
      if (c === 'sh' && spec.argv[3] === 'app-user') {
        await wait();
        const passwd = readFileSync(join(world.root, 'etc/passwd'), 'utf8');
        if (!passwd.includes(`\n${spec.argv[4]}:`)) world.put('/etc/passwd', `${passwd}${spec.argv[4]}:x:990:990::${spec.argv[5]}:/usr/sbin/nologin\n`);
        return ok();
      }
      if (c === 'sh' && spec.argv[3] === 'app-folders' && spec.argv[4] === 'svc-app-flaky' && !flakyFailed) {
        flakyFailed = true;
        return { code: 1, stdout: '', stderr: 'install: cannot create directory' };
      }
      if (c === 'sh' && ['config', 'app-unit', 'app-backup-script', 'app-mu-plugins', 'mail-plugin'].includes(spec.argv[3]!)) { world.put(spec.argv[4]!, spec.stdin ?? ''); return ok(); }
      if (c === 'systemctl' && u === '--user') {
        if (verb === 'start' && units[0]!.endsWith('-backup.service')) {
          await wait();
          const s = new Date(now() * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
          world.put(`${home}/backups/db-${s}.sql.gz`, 'd'.repeat(1_500_000));
          world.put(`${home}/backups/files-${s}.tar.gz`, 'f'.repeat(2_500_000));
          world.put(`${home}/backups/url-${s}.txt`, 'https://blog.pammy.org\n');
        } else if (verb === 'start' && units[0]!.startsWith('app-') && units[0]!.endsWith('-web.service')) {
          await wait();
          const id = units[0]!.slice(4, -'-web.service'.length);
          world.container(`app-${id}-web`, true, 40_000_000, uid);
          world.container(`app-${id}-db`, true, 90_000_000, uid);
          world.put(`/srv/pamela-apps/${id}/wp-includes/version.php`, "<?php\n$wp_version = '6.8.2';\n");
        } else if (verb === 'stop' || verb === 'start') {
          await wait();
          for (const x of units) world.container(x.replace('.service', ''), verb === 'start', undefined, uid);
          if (verb === 'start' && units.includes('pammywp-web.service')) world.container('pammywp-db', true);
        }
        return ok();
      }
      if (spec.argv.includes('list')) return ok('[{"user_login":"pamela"}]');
      if (spec.argv.includes('eval')) return ok('sent\n');
      return ok();
    },
    exec: async (argv) => ok(argv[0] === 'journalctl' ? `2026-09-23T09:0${argv.includes('CONTAINER_NAME=pammywp-web') ? '1' : '2'}:00+00:00 host x[1]: a warning\n` : ''),
    execStream: () => Readable.from([Buffer.from('the tar')]),
    sleep: async () => {},
  };
}
