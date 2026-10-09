// Subdomains: a folder in her website is also <folder>.pammy.org (guide 06).
// The panel never touches her files itself: pammy-sitefs (running as pamela,
// sandboxed to /pamela/public and /pamela/trash) does, and re-checks every name.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { isKept, keptTo } from '@panel/core/panel/rights';
import type { FilesCtx } from '../files-ctx.ts';

export function routes(app: FastifyInstance, ctx: FilesCtx) {
  const { db, now, need, body, actorOf, helper, syncSoon, dateOf, config } = ctx;
  const site = config.rpID.replace(/^panel\./, '');
  const nameOf = (req: { params: unknown }) => (req.params as { name?: string }).name;
  // A person kept to places (docs/permissions-plan.md R5) sees only the folders
  // that are their places, and changes only those folders' temporary home pages:
  // making, trashing or restoring a folder at the top of the website is about the
  // whole site (the list of places itself), so those routes say wholeSite.
  const ownFolder = (a: { user: { places: string[] } }, name: unknown) => {
    const places = keptTo(a.user);
    if (places && !(typeof name === 'string' && places.includes(`/${name}`))) throw new AccountError('Not found.', 404);
    return name;
  };

    // ---------------------------------------------------------------- subdomains (website folders)
    // The panel never touches her files itself: pammy-sitefs (running as pamela,
    // sandboxed to /pamela/public and /pamela/trash) does, and re-checks every name.

    app.get('/api/sites', { config: { needs: 'subdomains' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const r = await helper<{ folders: { name: string }[]; trash: unknown[] }>({ op: 'list', actor: a.user.username });
      if (!isKept(a.user)) return r;
      return { ...r, folders: r.folders.filter((f) => a.user.places.includes(`/${f.name}`)), trash: [], kept: true };
    });

    app.post('/api/sites', { config: { needs: 'subdomains', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const r = await helper<{ name: string }>({ op: 'create', name: body(req).name, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'subdomain-created', r.name, config.site.folderSubdomains ? `https://${r.name}.${config.site.domain}` : `https://${config.site.domain}/${r.name}/`);
      return { ok: true, name: r.name };
    });

    app.post('/api/sites/trash', { config: { needs: 'subdomains', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const r = await helper<{ name: string; entry: string; purgeAt: number }>({ op: 'trash', name: body(req).name, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'folder-trashed', r.name, `restorable until ${dateOf(r.purgeAt)}`);
      syncSoon();
      return { ok: true, entry: r.entry, purgeAt: r.purgeAt };
    });

    app.post('/api/sites/restore', { config: { needs: 'subdomains', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const r = await helper<{ name: string }>({ op: 'restore', entry: b.entry, as: b.as, actor: a.user.username });
      const original = typeof b.entry === 'string' ? b.entry.replace(/--\d{8}T\d{6}Z$/, '') : '';
      await logActivity(db, now(), actorOf(a, req), 'folder-restored', r.name, original && original !== r.name ? `was "${original}"` : null);
      syncSoon();
      return { ok: true, name: r.name };
    });

    // ---------------------------------------------------------------- a temporary home page (docs/temporary-home-plan.md)
    // For a top-level folder with no index.html, which visitors would see as
    // "403 Forbidden". The helper checks everything again: a subdomain folder, not
    // protected, and never a page of hers.
    app.get('/api/sites/:name/home-page', { config: { needs: 'subdomains' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return { ...await helper<Record<string, unknown>>({ op: 'home-page-get', name: ownFolder(a, nameOf(req)), actor: a.user.username }), site };
    });

    app.post('/api/sites/:name/home-page', { config: { needs: 'subdomains' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const words = { heading: b.heading, message: b.message, link: b.link, style: b.style };
      const r = await helper<{ name: string; made: boolean; words: { heading: string } }>({ op: 'home-page-save', name: ownFolder(a, nameOf(req)), words, site, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), r.made ? 'home-page-made' : 'home-page-changed', r.name, `"${r.words.heading}"`);
      return { ok: true, made: r.made, address: `https://${r.name}.${site}/` };
    });

    app.post('/api/sites/:name/home-page/remove', { config: { needs: 'subdomains' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const r = await helper<{ name: string }>({ op: 'home-page-remove', name: ownFolder(a, nameOf(req)), actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'home-page-removed', r.name, null);
      return { ok: true };
    });
}
