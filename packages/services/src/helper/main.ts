// The services helper (docs/adopt-plan.md V7), lfdln-services.service: tells how
// the adopted services are, and starts, stops and restarts them. Root, so it may
// ask systemd to run `systemctl --user` as each service's user; it holds no
// capability, writes nothing, and reaches only 127.0.0.1 (to ask each part if it
// answers). What it looks after is its record, which only the installer writes.
//
// It listens on the socket systemd hands it (only the panel's user may open it),
// or on SERVICES_SOCKET when run by hand for testing.
import { chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { systemdRunner } from '@panel/core/runner';
import { loadRecord } from '../record.ts';
import { createServicesOps, type Probe } from './ops.ts';
import { createServicesServer } from './service.ts';

export const RECORD = '/var/lib/lfdln-services/services.json';
// where each service's data is, written by move-db.sh (docs/data-move-plan.md M7)
export const DATABASES_FILE = '/var/lib/lfdln-services/databases.json';

const readDatabases = (path: string) => () => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
};

// One GET to a part on this machine; any answer is a status, redirects not followed.
export const loopbackProbe: Probe = (port, path, timeoutMs) => new Promise((resolve) => {
  const started = performance.now();
  const done = (status: number | null) => resolve({ status, ms: Math.round(performance.now() - started) });
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'lfdln-services (health check)' } });
  req.on('response', (res) => { res.resume(); done(res.statusCode ?? null); req.destroy(); });
  req.on('timeout', () => { req.destroy(); done(null); });
  req.on('error', () => done(null));
  req.end();
});

export function runServices(env: NodeJS.ProcessEnv = process.env) {
  const log = (line: string) => console.log(line);
  const record = env.SERVICES_RECORD ?? RECORD;
  const server = createServicesServer(createServicesOps({ record: () => loadRecord(record), run: systemdRunner('lfdln-services'), probe: loopbackProbe, log, databases: readDatabases(env.SERVICES_DATABASES ?? DATABASES_FILE) }), log);

  if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
    server.listen({ fd: 3 });
  } else if (env.SERVICES_SOCKET) {
    try { unlinkSync(env.SERVICES_SOCKET); } catch { /* not there */ }
    server.listen(env.SERVICES_SOCKET, () => chmodSync(env.SERVICES_SOCKET!, 0o600));
  } else {
    console.error('lfdln-services: no socket (expected systemd socket activation or SERVICES_SOCKET)');
    process.exit(2);
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
