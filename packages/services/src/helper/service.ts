// The services helper's socket protocol: one JSON request per connection, one JSON
// line back (@panel/core/jsonline), like the other helpers. Only these operations;
// a request names a service and a part from the record, never a unit, a user or a
// command, and there is no delete (D2).
import type { Server } from 'node:net';
import { createJsonLineServer, type JsonRequest } from '@panel/core/jsonline';
import { ServicesError } from '../record.ts';
import type { ServicesOps } from './ops.ts';

const actorOf = (req: JsonRequest) => (typeof req.actor === 'string' ? req.actor.slice(0, 80) : 'someone');

export function handle(ops: ServicesOps, req: JsonRequest): Promise<unknown> {
  switch (req.op) {
    case 'list': return ops.list();
    case 'names': return ops.names();
    case 'status': return ops.status(req.id);
    case 'ports': return ops.ports();
    case 'start': return ops.start(req.id, req.part, actorOf(req));
    case 'stop': return ops.stop(req.id, req.part, actorOf(req));
    case 'restart': return ops.restart(req.id, req.part, actorOf(req));
    case 'logs': return ops.logs(req.id, req.part);
    case 'manifest': return ops.manifest(req.id);
    case 'storage': return ops.storage();
    case 'prune': return ops.prune(req.days);
    default: return Promise.reject(new ServicesError('invalid', 'Unknown request.'));
  }
}

// a start waits for the containers to answer: up to ten minutes to start, three to answer
export const TIMEOUT = 15 * 60_000;

export function createServicesServer(ops: ServicesOps, log: (line: string) => void = () => {}): Server {
  return createJsonLineServer((req) => handle(ops, req), log, {
    describe: (req) => `${JSON.stringify(req.id ?? '').slice(0, 40)}${typeof req.part === 'string' ? `/${req.part.slice(0, 40)}` : ''}`,
    timeoutMs: TIMEOUT,
  });
}
