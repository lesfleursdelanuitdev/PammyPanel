// What every site's panel is before its modules add their routes (docs/lfdln-standup-plan.md
// L1): one Fastify app with the security headers, the same-origin check, the error and
// not-found answers, and the built page and its files, read once at startup.
// sites/<name>/src/app.ts starts from this and adds the routes of the modules it has on.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { AccountError } from '../accounts.ts';
import { type Config } from '../config.ts';
import { checkSameOrigin, SECURITY_HEADERS } from '../security.ts';

// How a module's own errors are said: a status and her words, or undefined for "not mine"
export type Refusal = (err: unknown) => { status: number; message: string } | undefined;
export type Assets = Map<string, { body: Buffer; type: string }>;

export function panelShell(config: Config, opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void; refusals?: Refusal[] } = {}): { app: FastifyInstance; page: string; assets: Assets } {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  const page = readFileSync(join(config.publicDir, 'index.html'), 'utf8');
  const assets = loadAssets(join(config.publicDir, 'assets'));
  const refusals = opts.refusals ?? [];

  app.addHook('onRequest', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (!checkSameOrigin(req, reply, config.origin)) return reply;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AccountError) return reply.code(err.status).send({ error: 'refused', message: err.message });
    for (const r of refusals) {
      const said = r(err);
      if (said) return reply.code(said.status).send({ error: 'refused', message: said.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'bad-request', message: 'The request could not be read.' });
    req.log.error(err);
    return reply.code(500).send({ error: 'server', message: 'Something went wrong on the server.' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not-found' });
    return reply.code(404).type('text/plain').send('Not found');
  });

  return { app, page, assets };
}

// A helper a site doesn't have (its module is off there): asking it is refused.
export const notHere = (what: string) => async <T>(): Promise<T> => {
  throw new AccountError(`This panel has no ${what}.`, 404);
};

// ------------------------------------------------------------------ static files
// Read once at startup; only files that exist under public/assets are ever
// served, so no request path reaches the filesystem.
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function loadAssets(root: string): Assets {
  const out: Assets = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const ext = name.slice(name.lastIndexOf('.'));
      const type = TYPES[ext];
      if (type) out.set(`/assets/${relative(root, p)}`, { body: readFileSync(p), type });
    }
  };
  walk(root);
  return out;
}
