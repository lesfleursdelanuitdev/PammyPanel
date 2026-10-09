// The software helper's socket protocol: one JSON request per connection, one
// JSON line back (jsonline.ts), like the other helpers. An allow-list of
// operations and nothing else (docs/apps-plan.md G2); every argument is checked
// again in ops.ts, and a request can never name a path, a user or a command.
import type { Server } from 'node:net';
import { createJsonLineServer, SENT, type JsonRequest } from '@panel/core/jsonline';
import type { Ops } from './ops.ts';
import { AppsError } from './record.ts';

export function handle(ops: Ops, req: JsonRequest): Promise<unknown> {
  switch (req.op) {
    case 'list': return ops.list();
    case 'status': return ops.status(req.id);
    // phase 2: the long ones answer with a job at once (jobs.ts)
    case 'backups': return ops.backups(req.id);
    case 'backup': return ops.backup(req.id, req.actor);
    case 'restore': return ops.restore(req.id, req.stamp, req.actor);
    case 'offline': return ops.offline(req.id, req.actor);
    case 'online': return ops.online(req.id, req.actor);
    case 'admins': return ops.admins(req.id);
    case 'reset-admin': return ops.resetAdmin(req.id, req.user, req.actor);
    case 'logs': return ops.logs(req.id);
    // phase 3: mail settings (the panel asks for a fresh passkey before mail-set)
    case 'mail-get': return ops.mailGet();
    case 'mail-set': return ops.mailSet({ key: req.key, from: req.from, replyTo: req.replyTo, notifyTo: req.notifyTo }, req.actor);
    case 'mail-test': return ops.mailTest(req.id, req.actor);
    // phase 4a (the panel asks for a fresh passkey first)
    case 'move': return ops.move(req.id, req.to, req.actor);
    // phase 4b (the panel asks for a fresh passkey first)
    case 'install': return ops.install({ id: req.id, placement: req.placement, title: req.title, adminUser: req.adminUser, adminEmail: req.adminEmail }, req.actor);
    case 'install-login': return ops.installLogin(req.id);
    // phase 4c (the panel asks for a fresh passkey before delete and purge)
    case 'delete': return ops.remove(req.id, req.actor);
    case 'undelete': return ops.undelete(req.id, req.actor);
    case 'purge': return ops.purge(req.id, req.actor);
    case 'purge-due': return ops.purgeDue();
    case 'rootfs-sync': return ops.rootfsSync();
    default: return Promise.reject(new AppsError('invalid', 'Unknown request.'));
  }
}

// A status walks the files for their size (the first time in ten minutes) and
// asks the site through nginx; a list of admins or a new password starts a
// wp-cli container. None of them is a job, and all answer well inside this.
export const TIMEOUT = 60_000;

export function createAppsServer(ops: Ops, log: (line: string) => void = () => {}): Server {
  return createJsonLineServer((req) => handle(ops, req), log, {
    // what a log line says it was about; never a password
    describe: (req) => `${JSON.stringify(req.id ?? '').slice(0, 40)}${typeof req.stamp === 'string' ? ` ${req.stamp.slice(0, 20)}` : ''}`,
    timeoutMs: TIMEOUT,
    streams: {
      // a backup, as one .tar: a JSON line with its name, then the bytes
      download: async (req, { send }) => {
        const r = await ops.download(req.id, req.stamp);
        send({ name: r.name }, r.bytes);
        return SENT;
      },
    },
  });
}
