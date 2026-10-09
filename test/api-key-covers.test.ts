// The API keys routes with the covers of the modules on (docs/catalog-plan.md step 3c):
// a kind whose module is off is never passed to the gate, and the Activity line
// says what it did before the move.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { PanelCtx } from '@panel/core/panel/context';
import type { ApiKey } from '@panel/api-keys/gate/forms/api-keys';
import type { KeyCover } from '@panel/api-keys/panel/covers';
import { routes } from '@panel/api-keys/panel/routes/api-keys';
import { formsCover } from '@panel/forms/panel/api-key-cover';
import { mediaCover } from '@panel/media/panel/api-key-cover';

const KEY: ApiKey = { id: 1, label: 'Site', prefix: 'pammy_abc', level: 'approved', forms: null, media: null, createdAt: 0, createdBy: 'momolig', lastUsedAt: null, revokedAt: null, revokedBy: null };

async function appWith(covers: readonly KeyCover[], made: Partial<ApiKey>) {
  const asked: Record<string, unknown>[] = [];
  const logged: unknown[][] = [];
  const db = { unsafe: async (_text: string, args: unknown[]) => { logged.push(args); return { count: 1 }; } };
  const ctx = {
    db, now: () => 100,
    need: async () => ({ user: { username: 'momolig' } }),
    body: (req: { body: unknown }) => req.body as Record<string, unknown>,
    idParam: () => 1,
    actorOf: () => ({ id: 1, label: 'momolig' }),
    gate: async (req: Record<string, unknown>) => { asked.push(req); return { key: 'pammy_x', apiKey: { ...KEY, ...made } }; },
  } as unknown as PanelCtx;
  const app = Fastify();
  routes(app, ctx, covers);
  await app.ready();
  return { app, asked, logged };
}

const make = (app: Awaited<ReturnType<typeof appWith>>['app'], payload: object) =>
  app.inject({ method: 'POST', url: '/api/api-keys', payload });

describe('API keys: what a key can cover', () => {
  it('passes both kinds on, and says in Activity what it said before the move', async () => {
    const { app, asked, logged } = await appWith([formsCover, mediaCover], { forms: [3, 4], level: 'all', media: ['/olivia', '/'] });
    assert.equal((await make(app, { label: 'Site', level: 'all', forms: [3, 4], media: ['/olivia', '/'] })).statusCode, 200);
    assert.deepEqual(asked[0], { op: 'apikey.create', label: 'Site', level: 'all', forms: [3, 4], media: ['/olivia', '/'], actor: 'momolig' });
    // at, actor id, actor label, action, target, detail, ip
    assert.deepEqual(logged[0]!.slice(3, 6), ['api-key-created', 'Site', '2 forms, all responses, media: /olivia, /']);
  });

  it('words each cover as before', () => {
    const line = (k: Partial<ApiKey>) => [formsCover, mediaCover].flatMap((c) => c.describe({ ...KEY, ...k })).filter(Boolean).join(', ');
    assert.equal(line({}), 'every form, approved responses only');
    assert.equal(line({ forms: [], media: 'all' }), 'no forms, every media folder');
    assert.equal(line({ forms: [7] }), '1 form, approved responses only');
  });

  it('with media off, never asks for media folders', async () => {
    const { app, asked } = await appWith([formsCover], {});
    await make(app, { label: 'Site', level: 'approved', forms: 'all', media: 'all' });
    assert.equal(asked[0]!.media, null);
    assert.equal(asked[0]!.forms, 'all');
  });

  it('with forms off, never asks for forms', async () => {
    const { app, asked, logged } = await appWith([mediaCover], { forms: [], media: 'all' });
    await make(app, { label: 'Site', level: 'approved', forms: 'all', media: 'all' });
    assert.equal(asked[0]!.forms, 'none');
    assert.equal(asked[0]!.media, 'all');
    assert.equal(logged[0]![5], 'every media folder');
  });
});
