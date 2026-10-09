// pammy-apps.service: the software helper (docs/apps-plan.md G2). It runs as
// root, because the software it looks after belongs to other system users
// (svc-pammywp). It holds one capability (reading files that aren't its own),
// writes only its own record and WordPress's three nginx files, and does
// everything else by asking systemd to run one command as a unit of its own,
// as root or as the software's user (runner.ts).
//
// It listens on the socket systemd hands it (pammy-apps.socket, which only the
// panel's user may open), or on APPS_SOCKET when run by hand for testing.
import { chmodSync, unlinkSync } from 'node:fs';
import { realProbe, type Host } from './host.ts';
import { createOps } from './ops.ts';
import { createAppsServer } from './service.ts';

// The site says which domain (sites/<name>/src/helpers/apps.ts). Whose files these are and
// where they go stay written in (record.ts, remove.ts): they are what a root process may delete.
export function runApps(domain: string, stateDir: string, env: NodeJS.ProcessEnv = process.env, site: { wholeSite?: string } = {}) {
const host: Host = {
  root: env.APPS_ROOT ?? '/',
  domain,
  nginx: { host: '127.0.0.1', port: Number(env.APPS_NGINX_PORT ?? 443) },
  probe: realProbe,
  now: () => Math.floor(Date.now() / 1000),
  ...(site.wholeSite ? { wholeSite: site.wholeSite } : {}),
};

const log = (line: string) => console.log(line);
const server = createAppsServer(createOps(host, stateDir, {
  log,
  // the templates build.sh copies in beside the code (release/apps/wordpress-nginx)
  ...(env.APPS_TEMPLATES ? { templates: env.APPS_TEMPLATES } : {}),
}), log);

if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
  server.listen({ fd: 3 });
} else if (env.APPS_SOCKET) {
  try { unlinkSync(env.APPS_SOCKET); } catch { /* not there */ }
  server.listen(env.APPS_SOCKET, () => chmodSync(env.APPS_SOCKET!, 0o600));
} else {
  console.error('pammy-apps: no socket (expected systemd socket activation or APPS_SOCKET)');
  process.exit(2);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
