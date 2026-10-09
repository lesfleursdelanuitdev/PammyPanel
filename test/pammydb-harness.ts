// Throwaway copies of Pamela's two engines for the tests, the same images and
// versions svc-pammydb runs (docs/studio-plan.md: "live engines"). Data in
// tmpfs, random 127.0.0.1 ports, one pair per test process, removed by name at
// the end -- never a prune.
//
// The studio role is made with deploy/studio/roles-*.sql.in, the files the
// installer uses, so a test that passes has proved the rights she will really
// get. Her own `pamela` role and database are made too, because the refuse-list
// tests are about those.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import postgres from 'postgres';
import type { MariaEndpoint } from '@panel/studio/pammydb/maria';
import type { PgEndpoint } from '@panel/studio/pammydb/pg';
import { MARIA_IMAGE, PG_IMAGE } from './engine-images.ts';

const ROLES = join(import.meta.dirname, '..', 'deploy', 'studio');

export type Engines = {
  postgres: PgEndpoint;
  mariadb: MariaEndpoint;
  // as the engine's own admin, the way the install scripts do it
  pgSuper: (sql: string, database?: string) => string;
  mariaRoot: (sql: string) => string;
  stop: () => void;
};

const podman = (...args: string[]) => execFileSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Containers left behind by a test process that was killed outright.
function removeOrphans() {
  const r = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^pammy-studio-test-(pg|maria)-[0-9]+$'], { encoding: 'utf8' });
  for (const n of r.stdout.split('\n').filter(Boolean)) {
    const pid = Number(n.split('-').pop());
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
    if (!alive) spawnSync('podman', ['rm', '-f', '-t', '1', '--ignore', n]);
  }
}

// letters and digits only, like the passwords the installer makes, so they are
// safe inside the SQL quotes in roles-*.sql.in
const password = () => randomBytes(18).toString('hex');

const roles = (file: string, pw: string) => readFileSync(join(ROLES, file), 'utf8').replaceAll('__PASSWORD__', pw);

export async function startEngines(): Promise<Engines> {
  removeOrphans();
  const pgName = `pammy-studio-test-pg-${process.pid}`;
  const mariaName = `pammy-studio-test-maria-${process.pid}`;
  const secrets = mkdtempSync(join(tmpdir(), 'pammy-studio-test-'));
  const pw = {
    pgSuper: password(), pgPamela: password(), pgStudio: password(),
    mariaRoot: password(), mariaPamela: password(), mariaStudio: password(),
  };
  for (const [k, v] of Object.entries(pw)) {
    writeFileSync(join(secrets, k), v);
    chmodSync(join(secrets, k), 0o644);      // read from inside the containers
  }
  chmodSync(secrets, 0o755);

  const stop = () => {
    spawnSync('podman', ['rm', '-f', '-t', '2', '--ignore', pgName]);
    spawnSync('podman', ['rm', '-f', '-t', '2', '--ignore', mariaName]);
    rmSync(secrets, { recursive: true, force: true });
  };

  try {
    spawnSync('podman', ['rm', '-f', '--ignore', pgName]);
    spawnSync('podman', ['rm', '-f', '--ignore', mariaName]);
    podman('run', '-d', '--name', pgName,
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '--shm-size=128m',
      '-p', '127.0.0.1::5432',
      '-v', `${secrets}:/run/secrets:ro`,
      '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/pgSuper',
      PG_IMAGE, 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off');
    podman('run', '-d', '--name', mariaName,
      '--tmpfs', '/var/lib/mysql:rw,size=512m',
      '-p', '127.0.0.1::3306',
      '-v', `${secrets}:/run/secrets:ro`,
      '-e', 'MARIADB_ROOT_PASSWORD_FILE=/run/secrets/mariaRoot',
      MARIA_IMAGE);

    const pgPort = Number(podman('port', pgName, '5432/tcp').split(':').pop());
    const mariaPort = Number(podman('port', mariaName, '3306/tcp').split(':').pop());

    const pgSuper = (sql: string, database = 'postgres') => {
      const r = spawnSync('podman', ['exec', '-i', '-u', 'postgres', pgName, 'psql', '-v', 'ON_ERROR_STOP=1', '-X', '-qtA', '-d', database],
        { input: sql, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const mariaRoot = (sql: string) => {
      const r = spawnSync('podman', ['exec', '-i', mariaName, 'sh', '-c',
        'MYSQL_PWD="$(cat /run/secrets/mariaRoot)" exec mariadb -uroot --batch --skip-column-names'], { input: sql, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`mariadb failed: ${r.stderr}`);
      return r.stdout.trim();
    };

    // the postgres image's first start runs a socket-only server, then the real one
    const probe = postgres({ host: '127.0.0.1', port: pgPort, username: 'postgres', password: pw.pgSuper, database: 'postgres', max: 1, connect_timeout: 2, onnotice: () => {} });
    for (let i = 0; ; i++) {
      try { await probe`SELECT 1`; break; } catch (e) {
        if (i > 160) throw new Error(`${pgName} didn't start: ${podman('logs', '--tail', '20', pgName)}`, { cause: e });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await probe.end();
    for (let i = 0; ; i++) {
      try {
        const c = await mysql.createConnection({ host: '127.0.0.1', port: mariaPort, user: 'root', password: pw.mariaRoot, connectTimeout: 2000 });
        await c.query('SELECT 1');
        await c.end();
        break;
      } catch (e) {
        if (i > 240) throw new Error(`${mariaName} didn't start: ${podman('logs', '--tail', '20', mariaName)}`, { cause: e });
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // Her own accounts, as no-sudo/install-pamela-db.sh makes them: the studio
    // role's rights (and the refuse-list) are only meaningful next to these.
    pgSuper(`CREATE ROLE pamela LOGIN CREATEDB CREATEROLE PASSWORD '${pw.pgPamela}';
             CREATE DATABASE pamela OWNER pamela;`);
    mariaRoot(`CREATE USER 'pamela'@'%' IDENTIFIED BY '${pw.mariaPamela}';
               GRANT ALL PRIVILEGES ON *.* TO 'pamela'@'%' WITH GRANT OPTION;
               CREATE DATABASE pamela;`);

    // and the studio's own, from the files the installer uses
    pgSuper(roles('roles-pg.sql.in', pw.pgStudio));
    mariaRoot(roles('roles-maria.sql.in', pw.mariaStudio));

    return {
      postgres: { host: '127.0.0.1', port: pgPort, user: 'pammy_studio', password: pw.pgStudio },
      mariadb: { host: '127.0.0.1', port: mariaPort, user: 'pammy_studio', password: pw.mariaStudio },
      pgSuper,
      mariaRoot,
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}
