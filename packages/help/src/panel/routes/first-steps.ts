// First steps (docs/phase9-plan.md 9-3): the card on lfdln's Home, for each person. A
// second passkey (ticked when the account has two), the guide to read first (ticked by
// hand), and a line for each part they can change, with the guide about it. The card can
// be put away ("I'm done with this") and brought back from Help.
import type { FastifyInstance } from 'fastify';
import { AccountError } from '@panel/core/accounts';
import { one, run } from '@panel/core/pg';
import type { HelpGuide } from '../../help.ts';
import type { PanelCtx } from '@panel/core/panel/context';
import { rightsOf } from '@panel/core/panel/rights';
import { guidesFor } from './help.ts';

// a guide's address under /help/, as the pages make it (web/lib/help.tsx guideSlug)
export const slugOf = (file: string) => file.replace(/^\d+-/, '').replace(/\.txt$/, '').toLowerCase();
export type GuideRef = { slug: string; title: string };

// The guide about each part, for this person: the first of the guides they see whose
// map line names that right. A part no guide names has none.
export function guidesOfRights(guides: HelpGuide[], user: Parameters<typeof rightsOf>[0]): Record<string, GuideRef> {
  const seen = guidesFor(guides, user);
  const out: Record<string, GuideRef> = {};
  for (const r of rightsOf(user)) {
    const g = seen.find((x) => x.rights.includes(r));
    if (g) out[r] = { slug: slugOf(g.file), title: g.title };
  }
  return out;
}

export function routes(app: FastifyInstance, ctx: PanelCtx, guides: HelpGuide[], read: string) {
  const { db, need, body, now } = ctx;
  const first = guides.find((g) => slugOf(g.file) === read);

  app.get('/api/first-steps', { config: { needs: 'signed-in' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const [mine, keys] = await Promise.all([
      one<{ read_at: number | null; hidden_at: number | null }>(db, 'SELECT read_at, hidden_at FROM first_steps WHERE user_id = ?', a.user.id),
      one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM passkeys WHERE user_id = ?', a.user.id),
    ]);
    return {
      hidden: mine?.hidden_at != null,
      passkeys: keys?.n ?? 0,
      read: first ? { slug: read, title: first.title, done: mine?.read_at != null } : null,
      guides: guidesOfRights(guides, a.user),
    };
  });

  // { read: true | false } ticks the guide (or not); { hidden: true | false } puts the card away or back
  app.post('/api/first-steps', { config: { needs: 'signed-in' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const set: [string, number | null][] = [];
    if (typeof b.read === 'boolean') set.push(['read_at', b.read ? now() : null]);
    if (typeof b.hidden === 'boolean') set.push(['hidden_at', b.hidden ? now() : null]);
    if (!set.length || Object.keys(b).length !== set.length) throw new AccountError('Read, or hidden: true or false.', 400);
    for (const [col, v] of set) {
      await run(db, `INSERT INTO first_steps (user_id, ${col}) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET ${col} = excluded.${col}`, a.user.id, v);
    }
    return { ok: true };
  });
}
