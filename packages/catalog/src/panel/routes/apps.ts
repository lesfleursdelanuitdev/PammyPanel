// Tags and categories on a service's things (docs/catalog-plan.md step 5, S5-2, S5-5): the
// switch per service, Read again, a kind's items with their labels, the kind's own labels
// (make, rename, delete), and one item's labels. The services right (S5-6), as looking
// after the service needs; only with the services and the catalog on.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import type { PanelCtx } from '@panel/core/panel/context';
import { plural } from '@panel/core/util';
import { AppError, type AppKeeper } from '../../apps.ts';
import { allScopeId, createScopeLabel, deleteScopeLabel, renameScopeLabel, scopeLabels, setItemLabels, sourceCounts } from '../../items.ts';
import type { LabelType } from '../../labels.ts';

const NEEDS = { needs: 'services', wholeSite: true } as const;
const RESOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;

const typeParam = (v: unknown): LabelType => {
  if (v === 'tag' || v === 'category') return v;
  throw new AccountError('Not found.', 404);
};
const names = (v: unknown): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean).slice(0, 10));

export function routes(app: FastifyInstance, ctx: PanelCtx, keeper: AppKeeper) {
  const { db, now, need, limited, body, idParam, actorOf } = ctx;
  const params = (req: FastifyRequest) => req.params as Record<string, string>;
  const resourceOf = async (req: FastifyRequest) => {
    const p = params(req);
    const s = await keeper.service(p.service ?? '');
    if (!RESOURCE_RE.test(p.resource ?? '')) throw new AccountError('Not found.', 404);
    const refs = await keeper.refs(s.id, p.resource!);
    const view = (await keeper.status(s.id)).resources.find((r) => r.key === p.resource)!;
    return { s, refs, view };
  };
  const failed = (e: unknown): never => {
    if (e instanceof AppError) throw new AccountError(e.message, e.status);
    throw e;
  };

  // Every service, with what it offers to tag and whether it's on
  app.get('/api/catalog/apps', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const out = [];
    for (const s of await keeper.d.services()) out.push(await keeper.status(s.id));
    return { services: out };
  });

  app.get('/api/catalog/apps/:service', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return await keeper.status(params(req).service ?? '');
  });

  // {on: true} / {on: false}
  app.post('/api/catalog/apps/:service', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    if (limited(req, reply, 'app-tags-read', 30, 600)) return reply;
    const s = await keeper.service(params(req).service ?? '');
    const b = body(req);
    if (b.on === true) {
      const r = await keeper.switchOn(s.id, a.user.username).catch(failed);
      const items = Object.values(r.read).reduce((n, x) => n + x.items, 0);
      await logActivity(db, now(), actorOf(a, req), 'app-tags-on', s.title, plural(items, 'thing'));
    } else if (b.on === false) {
      const had = await keeper.switchOff(s.id);
      await logActivity(db, now(), actorOf(a, req), 'app-tags-off', s.title, had.links ? `their labels came off ${plural(had.labelled, 'thing')}` : null);
    } else throw new AccountError('Nothing to change.', 400);
    return { ok: true, ...await keeper.status(s.id) };
  });

  // "Read again": {letGo: true} lets a kind the service no longer offers go (the page asks first)
  app.post('/api/catalog/apps/:service/read', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    if (limited(req, reply, 'app-tags-read', 30, 600)) return reply;
    const s = await keeper.service(params(req).service ?? '');
    const r = await keeper.readAgain(s.id, a.user.username, body(req).letGo === true).catch((e: unknown) => {
      if (e instanceof AppError && e.status === 409) throw new AccountError(e.message, 409);
      return failed(e);
    });
    if (r.gone.length) await logActivity(db, now(), actorOf(a, req), 'app-items-gone', s.title, `no longer offered, with their tags: ${r.gone.join(', ')}`);
    const errors = Object.values(r.read).map((x) => x.error).filter(Boolean);
    if (errors.length) throw new AccountError(errors.join(' '), 400);
    return { ok: true, read: r.read, ...await keeper.status(s.id) };
  });

  // One kind: what the manifest says of it, its counts, its labels (and Everywhere's), its sub-scopes
  app.get('/api/catalog/apps/:service/:resource', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { s, refs, view } = await resourceOf(req);
    return {
      service: s, resource: view,
      counts: await sourceCounts(db, refs.source),
      labels: await scopeLabels(db, [refs.scope, await allScopeId(db)]),
      scopes: await keeper.subScopes(refs),
    };
  });

  // Its items: ?q=&scope=&tag=&category=&offset=
  app.get('/api/catalog/apps/:service/:resource/items', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { refs } = await resourceOf(req);
    const q = req.query as Record<string, unknown>;
    const scope = q.scope === undefined || q.scope === '' ? null : Number(q.scope);
    if (scope !== null && !Number.isSafeInteger(scope)) throw new AccountError('Not found.', 404);
    const offset = Number(q.offset ?? 0);
    return await keeper.items(refs, {
      q: typeof q.q === 'string' ? q.q.slice(0, 100) : undefined, scope,
      tags: names(q.tag), categories: names(q.category), offset: Number.isSafeInteger(offset) ? offset : 0, limit: 50,
    });
  });

  // One item's labels: {key, set: {tags, categories}}: a name not there yet is made in the kind's own
  app.post('/api/catalog/apps/:service/:resource/labels-of', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { refs, view } = await resourceOf(req);
    const b = body(req);
    if (typeof b.key !== 'string' || !b.key) throw new AccountError('Which one?', 400);
    const item = await keeper.itemId(refs, b.key);
    const res = await setItemLabels(db, now(), a.user.username, item, refs.scope, (b.set ?? {}) as { tags?: unknown; categories?: unknown });
    if (res.changed) {
      const title = (await keeper.items(refs, {})).items.find((x) => x.key === b.key)?.title ?? b.key;
      const detail = [`now ${[...res.names.categories.map((x) => `c/${x}`), ...res.names.tags.map((t) => `t/${t}`)].join(', ') || 'none'}`,
        res.created.length ? `made ${res.created.join(', ')}` : null].filter(Boolean).join('; ');
      await logActivity(db, now(), actorOf(a, req), 'media-labels-changed', `${view.label} "${String(title).slice(0, 80)}"`, detail);
    }
    return { ok: true, ...res };
  });

  // ---- the kind's own labels (Everywhere's are on the Tags & categories page)
  app.post('/api/catalog/apps/:service/:resource/labels', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { refs } = await resourceOf(req);
    const b = body(req);
    const l = await createScopeLabel(db, now(), a.user.username, refs.scope, typeParam(b.type), b.name);
    await logActivity(db, now(), actorOf(a, req), `media-${l.type}-made`, l.address, null);
    return { ok: true, label: l };
  });

  // {name}: rename it; {delete: true}: take it off everything and remove it
  app.post('/api/catalog/apps/:service/:resource/labels/:type/:id', { config: NEEDS }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { refs } = await resourceOf(req);
    const type = typeParam(params(req).type);
    const id = idParam(req, 'id');
    const b = body(req);
    if (b.delete === true) {
      const l = await deleteScopeLabel(db, refs.scope, type, id);
      await logActivity(db, now(), actorOf(a, req), `media-${type}-deleted`, l.address, l.count ? `taken off ${plural(l.count, 'thing')}` : null);
      return { ok: true, removedFrom: l.count };
    }
    const x = await renameScopeLabel(db, refs.scope, type, id, b.name);
    if (x.from !== x.to.address) await logActivity(db, now(), actorOf(a, req), `media-${type}-renamed`, x.from, `now ${x.to.address}`);
    return { ok: true, label: x.to };
  });
}
