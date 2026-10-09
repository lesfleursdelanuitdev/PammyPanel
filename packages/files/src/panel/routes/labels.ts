// Tags, categories and their scopes on every file, a file's title and alt text,
// the records' sync and each file's thumbnail (docs/media-plan.md, docs/editor-plan.md).
// The data is the catalog's (@panel/catalog, docs/catalog-plan.md step 2); these routes
// stay File Explorer's, since who may see a scope is a question about the website's
// folders; the addresses stay under /api/media/ as before. The media folders' own
// routes are @panel/media's.
import type { FastifyInstance } from 'fastify';
import { own, ownsScope, pathParam, scopeParam, siteFiles, listedScopes, syncFor, typeParam } from '../site-files.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { RECENT_AUTH } from '@panel/core/config';
import { CallError } from '@panel/core/jsonline';
import { type MediaRow, setDetails } from '../../media-db.ts';
import {
  changeFileLabels, createLabel, deleteLabel, getLabel, listLabels, listLabelsAround, renameLabel, setLabelPublic,
} from '@panel/catalog/labels';
import { type SyncSummary, describeSync } from '../../media-sync.ts';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { isKept, rightsOf } from '@panel/core/panel/rights';
import { one } from '@panel/core/pg';
import { addScope, listScopes, removeScope } from '@panel/catalog/scopes';
import { readFileSync } from 'node:fs';
import type { FilesCtx } from '../files-ctx.ts';

export function routes(app: FastifyInstance, ctx: FilesCtx) {
  const { db, now, media, thumbs, need, limited, body, idParam, actorOf, helper } = ctx;
  const { realScope } = siteFiles(ctx);

    // "Check for changes", on the Media tab and in File Explorer (the same sync; File
    // Explorer's own since a site may have no media folders: lfdln, docs/phase8-plan.md step 8-1)
    for (const [url, needs] of [['/api/media/sync', 'media'], ['/api/files/sync', 'files']] as const) app.post(url, { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (limited(req, reply, 'media-sync', 30, 600)) return reply;
      let s: SyncSummary;
      try {
        s = await media.sync(a.user.username);
      } catch (e) {
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
      return { ok: true, ...s, strays: syncFor(a, s)!.strays, sync: syncFor(a, s), summary: describeSync(s) };
    });

    // ---- tags and categories (D6-D13)

    app.get('/api/media/labels', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      // ?around=<folder>: what files in and under that folder can have (File Explorer's filters)
      if (q.around !== undefined) {
        const folder = pathParam(q.around);
        own(a, folder);
        return { labels: (await listLabelsAround(db, folder)).filter((l) => ownsScope(a, l.scope)) };
      }
      const asked = scopeParam(q.scope);
      return { labels: (await Promise.all(listedScopes(a, asked).map((sc) => listLabels(db, sc)))).flat() };
    });

    app.get('/api/media/scopes', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const asked = scopeParam((req.query as Record<string, unknown>).tree ?? (req.query as Record<string, unknown>).scope);
      return { scopes: (await Promise.all(listedScopes(a, asked).map((tree) => listScopes(db, tree)))).flat() };
    });

    app.post('/api/media/scopes', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const folder = pathParam(body(req).path ?? body(req).folder);
      if (!folder) throw new AccountError('Choose a folder.');
      own(a, folder);
      await helper<{ path: string; dir: boolean }>({ op: 'files-stat', path: folder, actor: a.user.username }).then((st) => {
        if (!st.dir) throw new AccountError('Choose a folder.');
      });
      const row = await addScope(db, now(), a.user.username, folder);
      await logActivity(db, now(), actorOf(a, req), 'media-scope-made', row.path, null);
      return { ok: true, scope: row };
    });

    app.post('/api/media/scopes/delete', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const sc = scopeParam(body(req).path ?? body(req).scope);
      if (!sc || !ownsScope(a, sc)) throw new AccountError('Not found.', 404);
      const row = await removeScope(db, sc);
      await logActivity(db, now(), actorOf(a, req), 'media-scope-removed', row.path, null);
      return { ok: true, scope: row };
    });

    app.post('/api/media/labels', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const type = typeParam(b.type);
      const scope = await realScope(b.scope, a.user.username);
      if (!ownsScope(a, scope)) throw new AccountError('Not found.', 404);
      const l = await createLabel(db, now(), a.user.username, type, scope, b.name);
      await logActivity(db, now(), actorOf(a, req), `media-${type}-made`, l.address, null);
      return { ok: true, label: l };
    });

    // {name}: rename it; {delete: true}: remove it from every file
    app.post('/api/media/labels/:type/:id', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const type = typeParam((req.params as Record<string, string>).type);
      const id = idParam(req, 'id');
      const b = body(req);
      if (!ownsScope(a, (await getLabel(db, type, id))?.scope)) throw new AccountError('Not found.', 404);
      // M5: "Anyone can list its files" -- publishing asks for a passkey, like the forms switch
      if (typeof b.public === 'boolean') {
        if (b.public && now() - a.session.auth_at >= RECENT_AUTH) return reply.code(403).send({ error: 'reauth-required', message: 'Please confirm with your passkey.' });
        const l = await setLabelPublic(db, type, id, b.public);
        await logActivity(db, now(), actorOf(a, req), b.public ? 'media-label-public' : 'media-label-private', l.address,
          b.public ? 'anyone can list its files' : 'only the panel and keys can list its files');
        return { ok: true, label: l };
      }
      if (b.delete === true) {
        const l = await deleteLabel(db, type, id);
        await logActivity(db, now(), actorOf(a, req), `media-${type}-deleted`, l.address, l.count ? `taken off ${l.count} file${l.count === 1 ? '' : 's'}` : null);
        return { ok: true, removedFrom: l.count };
      }
      const r = await renameLabel(db, type, id, b.name);
      if (r.from !== r.to.address) await logActivity(db, now(), actorOf(a, req), `media-${type}-renamed`, r.from, `now ${r.to.address}`);
      return { ok: true, label: r.to };
    });

    // M9: a file's title and "what it shows"
    app.post('/api/media/items/:id/details', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const rec = await one<MediaRow>(db, "SELECT * FROM records WHERE id = ? AND state = 'present'", idParam(req, 'id'));
      if (!rec || !ownsScope(a, rec.scope)) throw new AccountError("That file isn't there any more.", 404);
      const b = body(req);
      const r = await media.withLock(() => setDetails(db, now(), rec.id, { title: b.title, alt: b.alt }));
      await logActivity(db, now(), actorOf(a, req), 'media-details-changed', r.path, null);
      return { ok: true, title: r.title, alt: r.alt };
    });

    // {ids, set | add | remove: {tags, categories}}: one file's labels, or many at once
    app.post('/api/media/items/labels', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const ch = (v: unknown) => (v && typeof v === 'object' ? v as { tags?: unknown; categories?: unknown } : undefined);
      if (isKept(a.user) && Array.isArray(b.ids)) {
        for (const id of b.ids) {
          const r = await one<{ scope: string }>(db, 'SELECT scope FROM records WHERE id = ?', Number(id));
          if (r && !a.user.places.includes(r.scope)) throw new AccountError("One of those files isn't there any more. Check for changes and try again.", 404);
        }
      }
      const r = await media.withLock(() => changeFileLabels(db, now(), a.user.username, b.ids, { set: ch(b.set), add: ch(b.add), remove: ch(b.remove) }));
      if (r.changed) {
        const ids = b.ids as number[];
        const single = ids.length === 1 ? (await one<{ path: string }>(db, 'SELECT path FROM records WHERE id = ?', ids[0]!))?.path : null;
        const said = (verb: string, c: { tags?: unknown; categories?: unknown } | undefined) => {
          const tags = Array.isArray(c?.tags) ? c.tags : [];
          const cats = Array.isArray(c?.categories) ? c.categories : [];
          return tags.length || cats.length ? `${verb} ${[...tags.map((t) => `t/${t}`), ...cats.map((x) => `c/${x}`)].join(', ')}` : null;
        };
        const detail = [ch(b.set) ? said('now', ch(b.set)) ?? 'none now' : null, said('added', ch(b.add)), said('removed', ch(b.remove)),
          r.created.length ? `made ${r.created.join(', ')}` : null].filter(Boolean).join('; ');
        await logActivity(db, now(), actorOf(a, req), 'media-labels-changed', single ?? `${r.changed} files`, detail || null);
      }
      return { ok: true, ...r };
    });

    // A thumbnail (D18). Its address carries the start of the content's hash, so
    // the browser may keep it for good: new content, new address.
    // Seen on the Media tab and in File Explorer, so either right will do (lfdln has File
    // Explorer and no media folders, docs/phase8-plan.md step 8-1).
    app.get('/api/media/thumb/:id', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (!rightsOf(a.user).some((r) => r === 'files' || r === 'media')) return reply.code(404).send({ error: 'not-found', message: 'Not found.' });
      const rec = await one<MediaRow>(db, 'SELECT * FROM records WHERE id = ?', idParam(req, 'id'));
      const t = rec && ownsScope(a, rec.scope) ? await thumbs.current(rec) : undefined;
      let bytes: Buffer;
      try {
        if (!rec || t?.result !== 'picture') throw new Error('none');
        bytes = readFileSync(thumbs.fileOf(rec.id, t.hash));
      } catch {
        return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not-found', icon: rec && ownsScope(a, rec.scope) ? (await thumbs.info(rec))?.icon ?? null : null });
      }
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      reply.header('ETag', `"${t.hash.slice(0, 16)}"`);
      return reply.type('image/webp').send(bytes);
    });

    // Raw bytes, one file at a time: X-Pammy-Name says its name, ?dir= where it goes.
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
}
