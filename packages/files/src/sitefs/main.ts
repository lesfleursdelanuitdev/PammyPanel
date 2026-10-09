// pammy-sitefs.service: the website folder helper. Runs as pamela, so the
// folders it makes are hers like any upload, inside a sandbox that can write
// only /pamela/public and /pamela/trash. It listens on the socket systemd hands
// it (pammy-sitefs.socket, which only svc-pammypanel may open), or on
// SITEFS_SOCKET when run by hand for testing.
import { chmodSync, unlinkSync } from 'node:fs';
import { createSiteFsServer } from './service.ts';
import type { SiteFsConfig } from './ops.ts';

// The site says where her website and trash are (sites/<name>/src/helpers/sitefs.ts).
export function runSiteFs(cfg: SiteFsConfig, env: NodeJS.ProcessEnv = process.env) {
const server = createSiteFsServer(cfg, (line) => console.log(line));

if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
  server.listen({ fd: 3 });
} else if (env.SITEFS_SOCKET) {
  try { unlinkSync(env.SITEFS_SOCKET); } catch { /* not there */ }
  server.listen(env.SITEFS_SOCKET, () => chmodSync(env.SITEFS_SOCKET!, 0o600));
} else {
  console.error('pammy-sitefs: no socket (expected systemd socket activation or SITEFS_SOCKET)');
  process.exit(2);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
