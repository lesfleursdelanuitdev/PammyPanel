// nginx's edge secret for a harness (docs/s1-plan.md S1c): <dir>/edge.conf as the installer
// writes it (deploy/edge-secret.sh), with a secret made up here. Returns its path.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function edgeFile(dir: string, secret = randomBytes(32).toString('hex')): string {
  const f = join(dir, 'edge.conf');
  writeFileSync(f, `proxy_set_header X-Lfdln-Edge "${secret}";\n`, { mode: 0o600 });
  return f;
}
