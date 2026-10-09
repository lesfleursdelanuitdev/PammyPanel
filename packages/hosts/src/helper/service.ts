// The routing helper's socket protocol: one JSON request per connection, one JSON
// line back (@panel/core/jsonline), like the other helpers. Only these operations;
// a request can never name a file, a path on disk or a command.
import type { Server } from 'node:net';
import { createJsonLineServer, type JsonRequest } from '@panel/core/jsonline';
import { HostsError, type RoutesOps } from './ops.ts';

export function handle(ops: RoutesOps, req: JsonRequest): Promise<unknown> {
  switch (req.op) {
    case 'apply': return ops.apply(req.table, { takeOver: req.takeOver, giveBack: req.giveBack });
    case 'check-name': return ops.checkName(req.name);
    case 'zone': return ops.zone();
    case 'status': return ops.status();
    case 'check-domain': return ops.checkDomain({ domain: req.domain, front: req.front, dns: req.dns, wildcardRecord: req.wildcardRecord, tls: req.tls, names: req.names });
    case 'check': return ops.check({ domain: req.domain, front: req.front, hosts: req.hosts, again: req.again });
    case 'records': return ops.records({ domain: req.domain, records: req.records });
    case 'urls': return ops.urls({ urls: req.urls });
    case 'registration': return ops.registration({ domain: req.domain });
    default: return Promise.reject(new HostsError('invalid', 'Unknown request.'));
  }
}

// nginx -t, then a reload, then back: well inside this
export const TIMEOUT = 150_000;

export function createRoutesServer(ops: RoutesOps, log: (line: string) => void = () => {}): Server {
  return createJsonLineServer((req) => handle(ops, req), log, {
    describe: (req) => (req.op === 'check-name' ? JSON.stringify(req.name ?? '').slice(0, 70) : ''),
    timeoutMs: TIMEOUT,
    // the whole table in one request: 64k holds a few hundred routes, this thousands
    maxRequest: 1024 * 1024,
  });
}
