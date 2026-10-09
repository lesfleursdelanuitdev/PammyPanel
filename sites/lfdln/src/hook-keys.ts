// Each service's own key (docs/accounts-plan.md step 4b; docs/catalog-plan.md step 5): the
// panel signs what it sends a service with it, and checks what a service sends its door.
// lfdln-panel.service hands them in as the credential "hooks" (hooks_<service>.key); the
// command line and the tests read the folder itself.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVICE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function hookKeyFile(service: string): string {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  return dir ? join(dir, `hooks_${service}.key`) : join(process.env.PANEL_HOOKS_DIR ?? '/etc/lfdln-panel/hooks', `${service}.key`);
}

export async function hookKey(service: string): Promise<string | null> {
  if (!SERVICE_RE.test(service)) return null;
  try {
    const k = (await readFile(hookKeyFile(service), 'utf8')).trim();
    return k.length >= 20 ? k : null;
  } catch {
    return null;
  }
}
