// The one door PHP has (docs/tutorials-plan.md P3): her PHP pages run with no
// network at all, and reach her data through this unix socket, which only
// pammy-php may open (pammy-gate-php.socket: svc-pammygate, group svc-pammyphp,
// 0660). Behind it is the very same gate app nginx talks to -- same routes, same
// keys, same catalog -- but only its API: /_pammy/api/... and nothing else.
//
// What PHP sends about itself is not believed: the host is always hers, and
// there is no visitor cookie, forwarded address or base to pretend with. A PHP
// page acts with the key it holds, like any other program.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const PHP_PATHS = /^\/_pammy\/api\//;

export function createPhpServer(route: (req: IncomingMessage, res: ServerResponse) => void, domain: string): Server {
  return createServer((req, res) => {
    if (!PHP_PATHS.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found', message: 'Only /_pammy/api/ answers here.' }));
      return;
    }
    for (const h of ['cookie', 'x-real-ip', 'x-forwarded-for', 'x-pammy-base', 'x-pammy-uri', 'origin']) delete req.headers[h];
    req.headers.host = domain;
    route(req, res);
  });
}
