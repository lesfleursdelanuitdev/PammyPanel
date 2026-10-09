// Every address of the panel is a page of its own, and the built files beside
// them. One page (web/, built into public/ by build.sh) for every address: it
// shows what the address asks for.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pagePolicy } from '@panel/core/security';
import { nextPage, PAGE_PATHS } from '../pages-list.ts';
import type { PanelCtx } from '@panel/core/panel/context';

export function routes(app: FastifyInstance, ctx: PanelCtx, files: { page: string; assets: Map<string, { body: Buffer; type: string }> }) {
  const { authOf } = ctx;
  const { page, assets } = files;

    // ---------------------------------------------------------------- pages
    // One page (web/, built into public/ by build.sh) for every address: it shows
    // what the address asks for. Each copy gets its own nonce, the only way a
    // <style> the page adds while it runs is allowed (see pagePolicy).
    const sendPage = (reply: FastifyReply) => {
      const nonce = randomBytes(18).toString('base64');
      reply.header('Content-Security-Policy', pagePolicy(nonce, ctx.config.site.domain));
      return reply.type('text/html; charset=utf-8').send(page.replaceAll('PAMMY_NONCE', nonce));
    };
    // Every page of the panel is its own address. Signed out: to sign in, and back
    // to this address afterwards.
    const appPage = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!await authOf(req)) return reply.redirect(req.url === '/' ? '/login' : `/login?next=${encodeURIComponent(req.url)}`);
      return sendPage(reply);
    };
    for (const path of PAGE_PATHS) app.get(path, appPage);
    app.get('/home', async (_req, reply) => reply.redirect('/'));
    app.get('/login', async (req, reply) => {
      if (await authOf(req)) return reply.redirect(nextPage((req.query as Record<string, unknown>).next));
      return sendPage(reply);
    });
    app.get('/invite', async (_req, reply) => sendPage(reply));
    app.get('/healthz', async () => ({ ok: true }));
    // Built files have their content's hash in their names, so they never change: cached for a year.
    app.get('/assets/*', async (req, reply) => {
      const path = req.url.split('?')[0]!;
      const asset = assets.get(path);
      if (!asset) return reply.code(404).type('text/plain').send('Not found');
      reply.header('Cache-Control', /-[\w-]{8}\.\w+$/.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      return reply.type(asset.type).send(asset.body);
    });


}
