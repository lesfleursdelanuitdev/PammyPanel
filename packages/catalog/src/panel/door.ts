// The app's door (docs/catalog-plan.md step 5, S5-4): a small second listener of the panel,
// on 127.0.0.1 only and never behind nginx, where a service pushes what changed, reads its
// labels and tags its own items. Every request is signed with the calling service's own key
// (v2, @panel/core/signed: the timestamp, the method, the path with its query, the body),
// the service named in X-Lfdln-Service, and only its own kinds of thing are answered.
//
//   POST   /_catalog/<resource>/items                       {items: [...], gone: [ids]}
//   GET    /_catalog/<resource>/labels                      its labels, uses and counts
//   GET    /_catalog/<resource>/items?tag=&category=        the ids with all of those
//   GET    /_catalog/<resource>/items/<id>/labels           one item's labels
//   PUT    /_catalog/<resource>/items/<id>/labels/<tag|category>/<name>
//   DELETE /_catalog/<resource>/items/<id>/labels/<tag|category>/<name>
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AccountError } from '@panel/core/accounts';
import { signedRequestOk } from '@panel/core/signed';
import { AppError, type AppKeeper, type AppService } from '../apps.ts';
import { LabelError, type LabelType } from '../labels.ts';

// how many requests a service may make a minute
export const DOOR_PER_MINUTE = 120;
const SERVICE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type DoorOpts = {
  key: (service: string) => Promise<string | null>;
  nowMs?: () => number;
  logger?: boolean;
};

export function doorApp(keeper: AppKeeper, o: DoorOpts): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const nowMs = o.nowMs ?? Date.now;
  // the body as it came: the signature covers it byte for byte
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const used = new Map<string, { minute: number; n: number }>();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AccountError || err instanceof AppError || err instanceof LabelError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong in the panel.' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found.' }));

  // who is asking: a service with a key, the signature its, not too often
  const caller = async (req: FastifyRequest, reply: FastifyReply): Promise<AppService | null> => {
    const id = req.headers['x-lfdln-service'];
    const deny = (why: string) => { void reply.code(401).send({ error: why }); return null; };
    if (typeof id !== 'string' || !SERVICE_RE.test(id)) return deny('Say which service is asking (X-Lfdln-Service).');
    const key = await o.key(id);
    const body = typeof req.body === 'string' ? req.body : '';
    if (!key || !signedRequestOk(key, { ts: req.headers['x-lfdln-timestamp'], signature: req.headers['x-lfdln-signature'] }, req.method, req.url, body, nowMs())) {
      return deny('The request isn\'t signed with that service\'s key, or its time is off by more than 5 minutes.');
    }
    const minute = Math.floor(nowMs() / 60_000);
    const u = used.get(id);
    if (u && u.minute === minute && u.n >= DOOR_PER_MINUTE) { void reply.code(429).send({ error: `At most ${DOOR_PER_MINUTE} requests a minute.` }); return null; }
    used.set(id, u && u.minute === minute ? { minute, n: u.n + 1 } : { minute, n: 1 });
    try {
      return await keeper.service(id);
    } catch {
      return deny('This panel doesn\'t look after that service.');
    }
  };
  const resourceOf = (req: FastifyRequest) => {
    const r = (req.params as Record<string, string>).resource ?? '';
    if (!RESOURCE_RE.test(r)) throw new AccountError('Not found.', 404);
    return r;
  };
  const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  const json = (req: FastifyRequest): Record<string, unknown> => {
    if (typeof req.body !== 'string' || !req.body) return {};
    try {
      const v = JSON.parse(req.body) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* below */ }
    throw new AppError('The body has to be one JSON object.');
  };
  const typeOf = (v: string): LabelType => {
    if (v === 'tag' || v === 'category') return v;
    throw new AccountError('Not found.', 404);
  };

  app.post('/_catalog/:resource/items', async (req, reply) => {
    const s = await caller(req, reply);
    if (!s) return reply;
    const b = json(req);
    return { ok: true, ...await keeper.push(s, resourceOf(req), b.items, b.gone) };
  });

  app.get('/_catalog/:resource/labels', async (req, reply) => {
    const s = await caller(req, reply);
    if (!s) return reply;
    const refs = await keeper.refs(s.id, resourceOf(req));
    return { labels: await keeper.labels(refs) };
  });

  app.get('/_catalog/:resource/items', async (req, reply) => {
    const s = await caller(req, reply);
    if (!s) return reply;
    const refs = await keeper.refs(s.id, resourceOf(req));
    const q = req.query as Record<string, unknown>;
    const tags = list(q.tag), categories = list(q.category);
    if (tags.length + categories.length > 20) throw new AppError('At most 20 labels at once.');
    return { ids: await keeper.keysWith(refs, { tags, categories }) };
  });

  app.get('/_catalog/:resource/items/:id/labels', async (req, reply) => {
    const s = await caller(req, reply);
    if (!s) return reply;
    const refs = await keeper.refs(s.id, resourceOf(req));
    return await keeper.itemLabels(refs, (req.params as Record<string, string>).id!);
  });

  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({
      method, url: '/_catalog/:resource/items/:id/labels/:type/:name',
      handler: async (req, reply) => {
        const s = await caller(req, reply);
        if (!s) return reply;
        const p = req.params as Record<string, string>;
        const refs = await keeper.refs(s.id, resourceOf(req));
        return { ok: true, ...await keeper.tag(s, refs, p.id!, typeOf(p.type!), p.name, method === 'PUT') };
      },
    });
  }
  return app;
}
