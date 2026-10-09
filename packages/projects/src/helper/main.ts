// The projects helper (docs/phase8b-plan.md), lfdln-projects.service: keeps the projects'
// record and jobs, and has every build and container started as svc-lfdln-apps. Root, so it
// may ask systemd to run things as that user; it writes only its own state folder.
//
// It listens on the socket systemd hands it (only the panel's user may open it), or on
// PROJECTS_SOCKET when run by hand for testing.
import { chmodSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { systemdRunner } from '@panel/core/runner';
import { createProjectsOps, type Probe } from './ops.ts';
import { createProjectsServer } from './service.ts';

export const STATE = '/var/lib/lfdln-projects';

// One GET to a project's server on this machine (8b-4a); any answer is a status, redirects
// not followed.
export const loopbackProbe: Probe = (port, path, timeoutMs) => new Promise((resolve) => {
  const started = performance.now();
  const done = (status: number | null) => resolve({ status, ms: Math.round(performance.now() - started) });
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'lfdln-projects (health check)' } });
  req.on('response', (res) => { res.resume(); done(res.statusCode ?? null); req.destroy(); });
  req.on('timeout', () => { req.destroy(); done(null); });
  req.on('error', () => done(null));
  req.end();
});

// dbPorts: the site's engines, the only ports of the host a project may reach (docs/s1-plan.md S1d)
export function runProjects(opts: { dbPorts?: number[] } = {}, env: NodeJS.ProcessEnv = process.env) {
  const log = (line: string) => console.log(line);
  const stateDir = env.PROJECTS_STATE ?? STATE;
  const ops = createProjectsOps({ recordFile: `${stateDir}/projects.json`, stateDir, run: systemdRunner('lfdln-projects'), probe: loopbackProbe, now: () => Math.floor(Date.now() / 1000), log, dbPorts: opts.dbPorts });
  const server = createProjectsServer(ops, log);
  ops.start();

  if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
    server.listen({ fd: 3 });
  } else if (env.PROJECTS_SOCKET) {
    try { unlinkSync(env.PROJECTS_SOCKET); } catch { /* not there */ }
    server.listen(env.PROJECTS_SOCKET, () => chmodSync(env.PROJECTS_SOCKET!, 0o600));
  } else {
    console.error('lfdln-projects: no socket (expected systemd socket activation or PROJECTS_SOCKET)');
    process.exit(2);
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
