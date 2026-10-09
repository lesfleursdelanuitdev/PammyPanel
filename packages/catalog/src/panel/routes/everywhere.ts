// Everywhere (docs/catalog-plan.md C5, step 4): labels at All, which go on anything in any
// source -- the website's files and her tagged tables' records alike. Made, renamed and
// deleted on the Tags page. They reach every source, so they need every right that
// reaches one: File Explorer's (the route's), and the others the site names (databases,
// with the Studio on). Never for someone kept to places.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import type { PanelCtx } from '@panel/core/panel/context';
import { rightsOf, type Right } from '@panel/core/panel/rights';
import { type Authed } from '@panel/core/sessions';
import { all } from '@panel/core/pg';
import { plural } from '@panel/core/util';
import { allScopeId, createScopeLabel, deleteScopeLabel, renameScopeLabel, scopeLabels, setScopeLabelPublic } from '../../items.ts';
import { RECENT_AUTH } from '@panel/core/config';
import type { LabelType } from '../../labels.ts';

const typeParam = (v: unknown): LabelType => {
  if (v === 'tag' || v === 'category') return v;
  throw new AccountError('Not found.', 404);
};

// onChange: an Everywhere label was renamed, deleted or made public (step 4b: the Studio
// tells the data API's copy of every tagged table)
// needs: the right the route itself asks for: File Explorer's where there is one, else the
// services' (lfdln, step 5: its sources are apps)
export function routes(app: FastifyInstance, ctx: PanelCtx, o: { alsoNeeds: readonly Right[]; needs?: Right; onChange?: () => unknown }) {
  const { db, now, need, body, idParam, actorOf } = ctx;
  const WHERE = { needs: o.needs ?? 'files', wholeSite: true } as const;

  const allowed = (a: Authed) => {
    const missing = o.alsoNeeds.filter((r) => !rightsOf(a.user).includes(r));
    if (missing.length) throw new AccountError(`Labels that go everywhere reach ${missing.includes('databases') ? 'your databases' : 'every part with tags'} too, so they need that part of the panel as well. Ask an account manager.`, 403);
  };

  // Everywhere's labels, and the sources they can go on (with how many items each has)
  app.get('/api/catalog/everywhere', { config: WHERE }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const may = o.alsoNeeds.every((r) => rightsOf(a.user).includes(r));
    const sources = await all<{ kind: string; label: string; items: number }>(db, `SELECT s.kind, s.label,
      (SELECT count(*) FROM items i JOIN resources r ON r.id = i.resource_id WHERE r.source_id = s.id AND i.state = 'present') AS items
      FROM sources s ORDER BY s.kind = 'files' DESC, s.label`);
    return {
      may,
      labels: await scopeLabels(db, [await allScopeId(db)]),
      sources: sources.map((s) => ({ kind: s.kind, label: s.kind === 'files' ? 'Website files' : s.label, items: Number(s.items) })),
    };
  });

  app.post('/api/catalog/everywhere', { config: WHERE }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    allowed(a);
    const b = body(req);
    const l = await createScopeLabel(db, now(), a.user.username, await allScopeId(db), typeParam(b.type), b.name);
    await logActivity(db, now(), actorOf(a, req), `media-${l.type}-made`, l.address, 'goes on anything');
    return { ok: true, label: l };
  });

  // {name}: rename it; {delete: true}: take it off everything and remove it;
  // {public}: whether readers of the data API without a key see it (step 4b: a passkey)
  app.post('/api/catalog/everywhere/:type/:id', { config: WHERE }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    allowed(a);
    const type = typeParam((req.params as Record<string, string>).type);
    const id = idParam(req, 'id');
    const b = body(req);
    const scope = await allScopeId(db);
    const changed = () => { try { void Promise.resolve(o.onChange?.()).catch(() => undefined); } catch { /* the next listing tells it */ } };
    if (typeof b.public === 'boolean') {
      if (b.public && now() - a.session.auth_at >= RECENT_AUTH) return reply.code(403).send({ error: 'reauth-required', message: 'Please confirm with your passkey.' });
      const l = await setScopeLabelPublic(db, scope, type, id, b.public);
      changed();
      await logActivity(db, now(), actorOf(a, req), b.public ? 'media-label-public' : 'media-label-private', l.address,
        b.public ? 'anyone can see it on the records' : 'only the panel and keys can see it');
      return { ok: true, label: l };
    }
    if (b.delete === true) {
      const l = await deleteScopeLabel(db, scope, type, id);
      changed();
      await logActivity(db, now(), actorOf(a, req), `media-${type}-deleted`, l.address, l.count ? `taken off ${plural(l.count, 'thing')}` : null);
      return { ok: true, removedFrom: l.count };
    }
    const x = await renameScopeLabel(db, scope, type, id, b.name);
    changed();
    if (x.from !== x.to.address) await logActivity(db, now(), actorOf(a, req), `media-${type}-renamed`, x.from, `now ${x.to.address}`);
    return { ok: true, label: x.to };
  });
}
