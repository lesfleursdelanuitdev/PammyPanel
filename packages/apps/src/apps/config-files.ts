// Writing an install's settings files (wp.php, apache.conf, content-url,
// mail.json): root 644, in its settings folder, which is mounted read-only into
// its containers.
//
// The blog's folder (/var/lib/svc-pammywp/config) is one the helper's unit lets
// it write. A panel install's (4b) is inside its own user's 700 home, which the
// helper may read but not write; there, a short root unit writes it
// (runner.ts). Either way the file is written in place, never renamed:
// apache.conf is a single-file bind mount, which a new file would leave behind.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from './host.ts';
import { AppsError, type AppRecord } from './record.ts';
import type { Runner } from './runner.ts';

export function configWriter(h: Host, run: Runner) {
  return async (a: AppRecord, name: string, text: string) => {
    if (!/^[a-z][a-z0-9.-]{0,40}$/.test(name)) throw new AppsError('internal', 'A settings file with a strange name.');
    const path = `${a.config}/${name}`;
    if (a.layout === 'adopted-wordpress') {
      writeFileSync(join(h.root, path), text, { mode: 0o644 });
      return;
    }
    const r = await run({ as: 'root', what: 'config', timeoutSec: 60, stdin: text,
      argv: ['sh', '-euc', 'umask 022; cat > "$1"; chmod 644 "$1"', 'config', path] });
    if (r.code !== 0) throw new AppsError('internal', `Its settings could not be written (${name}).`);
  };
}
