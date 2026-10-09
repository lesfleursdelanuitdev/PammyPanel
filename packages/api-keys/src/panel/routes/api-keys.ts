// The API keys: made and revoked in the gate (it serves the programs that use
// them); the panel checks who is asking and logs it (docs/catalog-plan.md step 3c).
import type { FastifyInstance } from 'fastify';
import { logActivity } from '@panel/core/accounts';
import type { PanelCtx } from '@panel/core/panel/context';
import type { ApiKey } from '../../gate/forms/api-keys.ts';
import type { KeyCover } from '../covers.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx, covers: readonly KeyCover[]) {
  const { db, now, need, body, idParam, actorOf, gate } = ctx;

  // Anyone with the API keys part can see which keys exist; only an account manager, just
  // after a passkey check, can make one or revoke it (D20) -- the server says so as the page
  // does (docs/lfdln-mariadb-plan.md finding 10).
  app.get('/api/api-keys', { config: { needs: 'programs' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return gate({ op: 'apikeys.list' });
  });

  app.post('/api/api-keys', { config: { needs: 'admin' } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const b = body(req);
    // a kind whose module is off is never asked for: no forms, no media folders
    const has = (kind: KeyCover['kind']) => covers.some((c) => c.kind === kind);
    const r = await gate<{ key: string; apiKey: ApiKey }>({
      // (the level is about responses: with no forms, the narrower one, never asked for)
      op: 'apikey.create', label: b.label, level: has('forms') ? b.level : 'approved',
      forms: has('forms') ? b.forms : 'none', media: has('media') ? b.media : null, actor: a.user.username,
    });
    await logActivity(db, now(), actorOf(a, req), 'api-key-created', r.apiKey.label,
      covers.flatMap((c) => c.describe(r.apiKey)).filter(Boolean).join(', '));
    return { ok: true, ...r };
  });

  app.post('/api/api-keys/:id/revoke', { config: { needs: 'admin' } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const k = await gate<{ id: number; label: string }>({ op: 'apikey.revoke', id: idParam(req, 'id'), actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'api-key-revoked', k.label, 'it stops working at once');
    return { ok: true };
  });
}
