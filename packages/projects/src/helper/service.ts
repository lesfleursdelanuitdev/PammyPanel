// The projects helper's socket protocol: one JSON request per connection, one JSON line back
// (@panel/core/jsonline), like the other helpers. A request names a project or a job, never a
// path, a user, an image or a command.
import type { Server } from 'node:net';
import { createJsonLineServer, type JsonRequest } from '@panel/core/jsonline';
import { ProjectsError } from '../record.ts';
import type { ProjectsOps } from './ops.ts';

const actorOf = (req: JsonRequest) => (typeof req.actor === 'string' ? req.actor.slice(0, 80) : 'someone');

export function handle(ops: ProjectsOps, req: JsonRequest): Promise<unknown> {
  switch (req.op) {
    case 'info': return ops.info();
    case 'list': return ops.list();
    case 'ports': return ops.ports();
    case 'jobs': return ops.jobs(req.project);
    case 'job': return ops.job(req.id);
    case 'check': return ops.check(actorOf(req), req.wait === true);
    case 'create': return ops.create(req.project && typeof req.project === 'object' ? req.project as Record<string, unknown> : {}, actorOf(req), req.wait);
    case 'build': return ops.build(req.id, req.branch, actorOf(req), req.wait);
    case 'rollback': return ops.rollback(req.id, req.branch, req.release, actorOf(req), req.wait);
    case 'delete': return ops.remove(req.id, actorOf(req), req.wait);
    case 'owners': return ops.owners(req.id, req.owners, actorOf(req), req.wait);
    case 'dev': return ops.dev(req.id, req.on, actorOf(req), req.wait);
    case 'promote': return ops.promote(req.id, actorOf(req), req.wait);
    case 'refresh': return ops.refresh(actorOf(req), req.wait);
    case 'put-back': return ops.putBack(req.id, actorOf(req), req.wait);
    case 'control': return ops.control(req.id, req.branch, req.action, actorOf(req), req.wait);
    case 'logs': return ops.logs(req.id, req.branch);
    case 'env': return ops.env(req.id, req.branch);
    case 'env-values': return ops.envValues(req.id, req.branch);
    case 'env-set': return ops.envSet(req.id, req.branch, req.name, req.value);
    case 'health': return ops.health();
    case 'database': return ops.database(req.id, req.branch, req.database, actorOf(req));
    case 'packages': return ops.packages(req.id);
    case 'packages-check': return ops.packagesCheck(req.id, actorOf(req), req.wait);
    case 'packages-change': return ops.packagesChange(req.id, req.change, actorOf(req), req.wait);
    case 'script': return ops.packagesRun(req.id, req.script, actorOf(req), req.wait);
    case 'package-search': return ops.packageSearch(req.text);
    case 'package-about': return ops.packageAbout(req.name, req.lang);
    case 'auto-update': return ops.autoUpdate(req.id, req.on);
    case 'nightly': return ops.nightly();
    case 'pushes': return ops.drainPushes().then((queued) => ({ queued }));
    default: return Promise.reject(new ProjectsError('invalid', 'Unknown request.'));
  }
}

// a check that waits (verify) can wait behind a build: 15 minutes, one build's limit
export const TIMEOUT = 20 * 60_000;

export function createProjectsServer(ops: ProjectsOps, log: (line: string) => void = () => {}): Server {
  return createJsonLineServer((req) => handle(ops, req), log, {
    describe: (req) => `${JSON.stringify(req.project ?? req.id ?? '').slice(0, 40)}`,
    timeoutMs: TIMEOUT,
  });
}
