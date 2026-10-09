// A throwaway Postgres for the tests (docs/postgres-plan.md, Tests): the same
// image as pammy-pg, its data in tmpfs, on a random 127.0.0.1 port, set up with
// the real deploy/pg/setup.sql so the roles and rights are the live ones. One
// container per test process, "pammy-pg-test-<pid>", removed by name at the
// end (never a prune). Each test gets its own database copied from "pammy".
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { connectPg, type Role, type Sql } from '@panel/core/pg';
import { imageOf } from './engine-images.ts';

const IMAGE = imageOf('deploy/pg/quadlet/pammy-pg.container');
const SETUP_SQL = join(import.meta.dirname, '..', 'deploy', 'pg', 'setup.sql');

export type PgTest = {
  name: string;
  port: number;
  passwords: Record<Role | 'super', string>;
  // SQL as the superuser, over the container's own socket (as install-pg.sh does)
  superSql: (sql: string, database?: string) => string;
  // a new database with pammy's schemas, rights and default privileges
  freshDatabase: () => string;
  connect: (role: Role, database: string, max?: number) => Sql;
  stop: () => void;
};

const podman = (...args: string[]) => execFileSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Containers left by a test process that was killed outright: removed by name.
function removeOrphans() {
  const r = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^pammy-pg-test-[0-9]+$'], { encoding: 'utf8' });
  for (const n of r.stdout.split('\n').filter(Boolean)) {
    const pid = Number(n.slice('pammy-pg-test-'.length));
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
    if (!alive) spawnSync('podman', ['rm', '-f', '-t', '1', '--ignore', n]);
  }
}

export async function startPg(): Promise<PgTest> {
  removeOrphans();
  const name = `pammy-pg-test-${process.pid}`;
  const secrets = mkdtempSync(join(tmpdir(), 'pammy-pg-test-'));
  const passwords = { super: '', owner: '', panel: '', gate: '' } as PgTest['passwords'];
  for (const r of Object.keys(passwords) as (keyof typeof passwords)[]) {
    passwords[r] = randomBytes(18).toString('hex');
    writeFileSync(join(secrets, `pammy-pg-${r}`), passwords[r]);
    chmodSync(join(secrets, `pammy-pg-${r}`), 0o644);   // read by postgres inside the container
  }
  chmodSync(secrets, 0o755);
  spawnSync('podman', ['rm', '-f', '--ignore', name]);
  podman('run', '-d', '--name', name,
    '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '--shm-size=128m',
    '-p', '127.0.0.1::5432',
    '-v', `${secrets}:/run/secrets:ro`,
    '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/pammy-pg-super',
    IMAGE, 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=100');
  const stop = () => {
    spawnSync('podman', ['rm', '-f', '-t', '2', '--ignore', name]);
    rmSync(secrets, { recursive: true, force: true });
  };
  try {
    const port = Number(podman('port', name, '5432/tcp').split(':').pop());
    // the image's first start runs a socket-only server, then the real one on TCP
    const probe = postgres({ host: '127.0.0.1', port, username: 'postgres', password: passwords.super, database: 'postgres', max: 1, connect_timeout: 2, onnotice: () => {} });
    for (let i = 0; ; i++) {
      try { await probe`SELECT 1`; break; } catch (e) {
        if (i > 120) throw new Error(`${name} didn't start: ${podman('logs', '--tail', '20', name)}`, { cause: e });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await probe.end();

    const superSql = (sql: string, database = 'postgres') => {
      const r = spawnSync('podman', ['exec', '-i', '-u', 'postgres', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-X', '-qtA', '-d', database],
        { input: sql, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    podman('cp', SETUP_SQL, `${name}:/tmp/setup.sql`);
    superSql('\\i /tmp/setup.sql');

    let n = 0;
    const freshDatabase = () => {
      const db = `t${++n}`;
      // what CREATE DATABASE doesn't copy from the template: the database's own rights
      superSql(`CREATE DATABASE ${db} TEMPLATE pammy OWNER pammy_owner;
        REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${db} TO pammy_panel, pammy_gate;`);
      return db;
    };
    const connect = (role: Role, database: string, max = 4) =>
      connectPg({ role, password: passwords[role], port, database, max, app: `test-${role}` });
    return { name, port, passwords, superSql, freshDatabase, connect, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
