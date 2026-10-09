// Which protected folder a public page belongs to (docs/roles-plan.md step 1):
// one of her sign-in pages, a built-in page naming its area, or (signing out)
// any page inside a protected folder. Used by the sign-in routes
// (@panel/people), the requests (@panel/requests) and the folder pages here.
import type { FastifyReply } from 'fastify';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { GateCtx } from '@panel/core/gate/context';
import { AREA_TOKEN_RE, type Area } from '@panel/core/gate/store';
import { PAGE_FILES, pageUrl, resolve, safeNext } from './policy.ts';

export type Target = { area: Area; dir: string; rel: string };

export function targetsFor(ctx: GateCtx) {
  const { cfg, live } = ctx;

  // One of her sign-in pages (by its path on this hostname), or the area a
  // built-in page names.
  function targetOf(base: string, input: Record<string, unknown>): Target | null {
    if (typeof input.area === 'string' && input.area !== '') {
      const area = AREA_TOKEN_RE.test(input.area) ? live.byToken(input.area) : undefined;
      if (!area) return null;
      // a route's area: no folder on disk (pageUrl and folderHome know its path)
      if (area.kind === 'route') return { area, dir: '/nonexistent', rel: area.path };
      let root: string;
      try { root = realpathSync(cfg.publicRoot); } catch { return null; }
      return { area, dir: join(root, area.path), rel: area.path };
    }
    const page = safeNext(input.page);
    if (!page) return null;
    let path: string;
    try { path = decodeURIComponent(page.split('?')[0]!); } catch { return null; }
    const r = resolve(live, cfg.publicRoot, `${base}${path}`);
    if (r.kind !== 'ok' || !r.exists || !PAGE_FILES.has(basename(r.real))) return null;
    const p = [...r.protections].reverse().find((x) => x.dir === dirname(r.real) && x.area);
    return p?.area ? { area: p.area, dir: p.dir, rel: p.rel } : null;
  }

  const noArea = (reply: FastifyReply) =>
    reply.code(400).send({ error: 'no-area', message: "This page isn't one of a protected folder's sign-in pages." });

  // Where to go after signing out from a page: its folder's logout.html (or the
  // built-in one). The page is one of the sign-in pages, a built-in page naming
  // its area, or any page inside a protected folder (a <pammy-logout> button).
  function signedOutPage(base: string, body: Record<string, unknown>): string | null {
    const t = targetOf(base, body);
    if (t) return pageUrl({ dir: t.dir, rel: t.rel, token: t.area.token }, base, 'logout');
    const page = safeNext(body.page);
    if (!page) return null;
    let path: string;
    try { path = decodeURIComponent(page.split('?')[0]!); } catch { return null; }
    const r = resolve(live, cfg.publicRoot, `${base}${path}`);
    if (r.kind !== 'ok') return null;
    const p = [...r.protections].reverse().find((x) => x.area);
    return p?.area ? pageUrl(p, base, 'logout') : null;
  }

  return { targetOf, noArea, signedOutPage };
}
