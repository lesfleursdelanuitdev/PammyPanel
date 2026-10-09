// The Help tab: the site's guides, as build.sh copied them in (src/help.ts reads
// them at start, so a guide edited after the build is one the install refuses).
import type { FastifyInstance } from 'fastify';
import type { HelpGuide } from '../../help.ts';
import type { PanelCtx } from '@panel/core/panel/context';
import { isKept, rightsOf } from '@panel/core/panel/rights';

// An account kept to places (D23) gets the guides its site's map marks "kept", and those
// marked with a right it has (docs/permissions-plan.md R5, docs/phase9-plan.md 9-1); the
// others are about things it doesn't have. Everyone else gets them all.
export const guidesFor = (guides: HelpGuide[], user: Parameters<typeof rightsOf>[0]) => {
  if (!isKept(user)) return guides;
  const has: readonly string[] = rightsOf(user);
  return guides.filter((g) => g.kept || g.rights.some((r) => has.includes(r)));
};

export function routes(app: FastifyInstance, ctx: PanelCtx, guides: HelpGuide[]) {
  const { need } = ctx;

  app.get('/api/help', { config: { needs: 'signed-in' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return { guides: guidesFor(guides, a.user) };
  });
}
