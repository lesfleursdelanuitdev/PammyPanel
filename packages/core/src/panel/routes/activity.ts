// What has been done in the panel: one list, newest first, 100 at a time.
// Written by logActivity wherever something happens (src/accounts.ts).
// An account manager sees everyone's; anyone else only what they did themselves
// (docs/permissions-plan.md R7): the server leaves the rest out, not the page.
import type { FastifyInstance } from 'fastify';
import { all } from '../../pg.ts';
import type { PanelCtx } from '../context.ts';
import { isAdmin } from '../rights.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, need } = ctx;

  app.get('/api/activity', { config: { needs: 'signed-in' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const before = Number((req.query as Record<string, string>).before);
    const from = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = isAdmin(a.user)
      ? await all(db, 'SELECT * FROM activity WHERE id < ? ORDER BY id DESC LIMIT 100', from)
      : await all(db, 'SELECT * FROM activity WHERE id < ? AND actor_id = ? ORDER BY id DESC LIMIT 100', from, a.user.id);
    return { entries: rows, own: !isAdmin(a.user) };
  });
}
