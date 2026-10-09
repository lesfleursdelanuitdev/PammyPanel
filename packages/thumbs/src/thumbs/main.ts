// pammy-thumbs.service: makes thumbnails of media files for the panel
// (docs/media-plan.md D18-D19). Its own user, reading her website the way the
// web server does, with no network and nowhere to write but its own /tmp. It
// listens on the socket systemd hands it (pammy-thumbs.socket, which only
// svc-pammypanel may open), or on THUMBS_SOCKET when run by hand for testing.
import { chmodSync, unlinkSync } from 'node:fs';
import { DEFAULT_TOOLS } from './make.ts';
import { createThumbsServer } from './service.ts';

// The site says where her website is (sites/<name>/src/helpers/thumbs.ts).
export function runThumbs(publicDir: string, env: NodeJS.ProcessEnv = process.env) {
const server = createThumbsServer({
  publicDir,
  tools: { ffmpeg: env.THUMBS_FFMPEG ?? DEFAULT_TOOLS.ffmpeg, pdftoppm: env.THUMBS_PDFTOPPM ?? DEFAULT_TOOLS.pdftoppm, prlimit: DEFAULT_TOOLS.prlimit },
}, (line) => console.log(line));

if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
  server.listen({ fd: 3 });
} else if (env.THUMBS_SOCKET) {
  try { unlinkSync(env.THUMBS_SOCKET); } catch { /* not there */ }
  server.listen(env.THUMBS_SOCKET, () => chmodSync(env.THUMBS_SOCKET!, 0o600));
} else {
  console.error('pammy-thumbs: no socket (expected systemd socket activation or THUMBS_SOCKET)');
  process.exit(2);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
