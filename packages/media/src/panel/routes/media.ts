// The Media tab (docs/media-plan.md): her media folders and the files in them,
// and the media examples (docs/media-api-plan.md). The Media folders module
// (docs/catalog-plan.md C1), on top of File Explorer: the records, tags and the
// shared pieces are @panel/files'.
//
// The files themselves are handled by the website folder helper (as pamela);
// the panel keeps a record of each one (media-db.ts, schema media), updated by
// its own changes and by a sync for what changed outside it (media-sync.ts),
// and passes bytes through. Changes run under the sync's lock, so a sync never
// sees half of one.
import { isOn, sizeWords } from '@panel/core/profile';
import type { FastifyInstance } from 'fastify';
import {
  drained, itemOf, labelsNote, MEDIA_TYPES, own, ownsPath, ownsScope, pathParam, scopeParam, siteFiles, siteLimits, siteOf, listedScopes, stringParam, syncFor, who, type MediaList,
} from '@panel/files/panel/site-files';
import { AccountError, logActivity } from '@panel/core/accounts';
import { MEDIA_EXAMPLES, MEDIA_EXAMPLE_KINDS, isMediaExampleKind, mediaApiUrl, mediaExampleForHer } from '../../gate/media-examples.ts';
import { CallError } from '@panel/core/jsonline';
import {
  MEDIA_KINDS, moveImportedNotes, presentAt, presentIn, queryItems, recordAdded, recordCopied, recordGone, recordMoved, recordRestored, recordTrashed,
} from '@panel/files/media-db';
import { labelsOf, listLabels } from '@panel/catalog/labels';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { isKept, keptTo } from '@panel/core/panel/rights';
import { readFromSiteFs, uploadToSiteFs } from '@panel/files/sitefs/client';
import { type Kind, belongs } from '@panel/files/sitefs/media';
import type { FilesCtx } from '@panel/files/panel/files-ctx';
import { appPath } from '@panel/core/paths';

export function routes(app: FastifyInstance, ctx: FilesCtx) {
  const { config, db, now, media, thumbs, need, may, body, actorOf, authOf, helper, dateOf } = ctx;
  const {  } = siteFiles(ctx);

    // ---------------------------------------------------------------- media folders
    // The files themselves are handled by the website folder helper (as pamela);
    // the panel keeps a record of each one (media-db.ts, schema media), updated by
    // its own changes and by a sync for what changed outside it (media-sync.ts),
    // and passes bytes through. Changes run under the sync's lock, so a sync never
    // sees half of one.

    // Opening the Media page: a sync first if the last one is over 5 minutes old.
    app.get('/api/media', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      try { await media.syncIfStale('automatic check'); } catch (e) { req.log.warn({ err: e }, 'media sync on opening Media failed'); }
      const sites = await helper<{ folders: { folder: string; hasMedia: boolean }[] }>({ op: 'media-sites', actor: a.user.username });
      const limited = siteLimits(a);
      return { folders: limited === null ? sites.folders : sites.folders.filter((f) => limited.includes(f.folder)), sync: syncFor(a, await media.last()), limitedTo: limited };
    });

    app.post('/api/media/folder', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const folder = stringParam(body(req).folder).trim().replace(/^\/+|\/+$/g, '');
      if (siteLimits(a)?.includes(folder) === false) throw new AccountError('Not found.', 404);
      const r = await helper<{ folder: string; created: string[] }>({ op: 'media-create', folder, actor: a.user.username });
      if (r.created.length) await logActivity(db, now(), actorOf(a, req), 'media-folder-made', r.folder || 'the main site', r.created.includes('media') ? null : `added ${r.created.join(', ')}`);
      return { ok: true, ...r };
    });

    // One folder: its subfolders from the helper, its files from the media records.
    app.get('/api/media/list', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      own(a, (req.query as Record<string, unknown>).dir);
      const r = await helper<MediaList>({ op: 'media-list', dir: stringParam((req.query as Record<string, unknown>).dir), actor: a.user.username });
      const rows = (await presentIn(db, r.path)).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
      const pictures = await thumbs.infoFor(rows);
      const files = rows.map((f) => ({
        id: f.id, name: f.name, size: f.size, createdAt: f.added_at, modifiedAt: f.modified_at, fits: belongs(r.kind as Kind, f.name), ...who(f),
        thumb: pictures.get(f.id) ?? null,
      }));
      return { path: r.path, site: r.site, kind: r.kind, inner: r.inner, buckets: r.buckets, files };
    });

    app.get('/api/media/buckets', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      own(a, (req.query as Record<string, unknown>).dir);
      return helper({ op: 'media-buckets', dir: stringParam((req.query as Record<string, unknown>).dir), actor: a.user.username });
    });

    app.get('/api/media/info', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = pathParam((req.query as Record<string, unknown>).path);
      own(a, path);
      let r: { path: string };
      try {
        r = await helper<{ path: string }>({ op: 'media-info', path, actor: a.user.username });
      } catch (e) {
        // gone since the last sync: the record says so until it's back
        if (e instanceof AccountError && e.status === 404) await media.withLock(() => recordGone(db, now(), path));
        throw e;
      }
      const rec = await presentAt(db, r.path);
      return { ...r, id: rec?.id ?? null, ...who(rec), thumb: rec ? await thumbs.info(rec) : null, scope: rec?.scope ?? null, title: rec?.title ?? null, alt: rec?.alt ?? null,
        ...(rec ? (await labelsOf(db, [rec.id])).get(rec.id)! : { tags: [], categories: [] }) };
    });

    // The Media page's list (D20): one media folder or all of them, one kind or all
    // four, a name search and a tag or category, 100 at a time. With one media
    // folder and one kind and nothing to search for, it's browsing: that folder's
    // subfolders (from the helper) and the files directly in it. Otherwise
    // everything that matches, from every folder inside.
    app.get('/api/media/items', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      const asked = scopeParam(q.scope);
      const scopes = listedScopes(a, asked);
      const scope = scopes.length === 1 ? scopes[0]! : null;
      const kindQ = stringParam(q.kind);
      const kind = (MEDIA_KINDS as readonly string[]).includes(kindQ) ? kindQ as Kind : null;
      const search = stringParam(q.q).trim().slice(0, 200);
      const idsOf = (v: unknown): number[] => {
        const out: number[] = [];
        const seen = new Set<number>();
        for (const item of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
          for (const part of String(item).split(',')) {
            const n = Number(part.trim());
            if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
          }
        }
        return out;
      };
      const tags = idsOf(q.tag);
      const categories = idsOf(q.category);
      const inner = scope && kind ? pathParam(q.in) : '';
      const dir = scope && kind ? [siteOf(scope), 'media', kind, inner].filter(Boolean).join('/') : null;
      const browse = !!dir && !search && !tags.length && !categories.length;
      let folders: { name: string; items: number }[] = [];
      if (browse) {
        const r = await helper<MediaList>({ op: 'media-list', dir, actor: a.user.username });
        folders = r.buckets.map((x) => ({ name: x.name, items: x.items }));
      }
      const sort = (['name', 'size', 'added'] as const).find((x) => x === q.sort) ?? 'name';
      const offset = Math.max(0, Math.min(Number(q.offset) || 0, 1_000_000));
      const limit = 100;
      const { rows, total } = await queryItems(db, {
        scope, within: keptTo(a.user), kind, dir, deep: !browse, library: 'media', q: search, tags, categories, sort, desc: q.order === 'desc', offset, limit,
      });
      const pictures = await thumbs.infoFor(rows);
      const labels = await labelsOf(db, rows.map((r) => r.id));
      return { mode: browse ? 'browse' : 'all', dir, folders, items: rows.map((f) => itemOf(f, pictures, labels)), total, offset, limit };
    });

    // ---- the media examples (only where the examples are on: not lfdln, docs/phase8-plan.md P8-12)
    if (isOn(config.site, 'examples')) {
      // (docs/media-api-plan.md M10-M12)
      // ../../../: this file is src/panel/routes/, the examples are the panel's own public-gate/
      const mediaExamplesDir = `${appPath('public-gate', 'examples')}/`;
      app.get('/api/media/examples', { config: { needs: 'media' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        return { examples: MEDIA_EXAMPLE_KINDS.map((kind) => ({ kind, ...MEDIA_EXAMPLES[kind] })) };
      });

      // Its three files as the example page has them (for "the code"), pointed at the example folder.
      app.get('/api/media/examples/:kind', { config: { needs: 'media' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const kind = (req.params as { kind: string }).kind;
        if (!isMediaExampleKind(kind)) throw new AccountError('There is no example called that.', 404);
        const e = MEDIA_EXAMPLES[kind];
        return { kind, ...e, files: mediaExampleForHer(mediaExamplesDir, kind, mediaApiUrl(':example', e.demo.type === 'tag' ? [e.demo.name] : [], e.demo.type === 'category' ? [e.demo.name] : [], e.mediaKind), e.pageName) };
      });

      // "Put this on my website" (M12): the page, pointed at the tags and categories she
      // chose in one of her media folders, written into that media folder's site folder.
      app.post('/api/media/examples/:kind/install', { config: { needs: 'media' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const kind = (req.params as { kind: string }).kind;
        if (!isMediaExampleKind(kind)) throw new AccountError('There is no example called that.', 404);
        const e = MEDIA_EXAMPLES[kind];
        const b = body(req);
        const folder = typeof b.folder === 'string' ? b.folder.trim().replace(/^\/+|\/+$/g, '') : '';
        const scope = folder ? `/${folder}` : '/';
        if (!ownsScope(a, scope)) throw new AccountError('Not found.', 404);
        const sites = await helper<{ folders: { folder: string; hasMedia: boolean }[] }>({ op: 'media-sites', actor: a.user.username });
        if (!sites.folders.some((f) => f.hasMedia && f.folder === folder)) throw new AccountError(`${folder || 'The main site'} has no media folder.`, 404);
        const pageName = typeof b.page === 'string' ? b.page.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9-]{0,60}\.html$/.test(pageName)) throw new AccountError('The page needs a name like gallery.html: lowercase letters, digits and hyphens.');
        const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
        const tags = list(b.tags);
        const categories = list(b.categories);
        if (!tags.length && !categories.length) throw new AccountError('Choose a tag or a category: the page shows the files that have it.');
        const labels = await listLabels(db, scope);
        const chosen = [...tags.map((n) => ({ type: 'tag' as const, name: n })), ...categories.map((n) => ({ type: 'category' as const, name: n }))]
          .map((w) => labels.find((l) => l.type === w.type && l.name === w.name) ?? w);
        const missing = chosen.find((l) => !('id' in l));
        if (missing) throw new AccountError(`There's no ${missing.type} called "${missing.name}" in ${folder || 'the main site'}'s media folder.`);
        const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 120) : e.title;
        const files = mediaExampleForHer(mediaExamplesDir, kind, mediaApiUrl(scope, tags, categories, e.mediaKind), pageName, title);
        const written = await helper<{ path: string; created: string[] }>({ op: 'install-pages', path: folder, files, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'media-example-installed', `${folder ? `${folder}/` : ''}${pageName}`,
          `the ${e.heading.toLowerCase()} example, showing ${chosen.map((l) => ('address' in l ? l.address : l.name)).join(' and ')}`);
        const domain = config.rpID.replace(/^panel\./, '');
        return {
          ok: true, folder, created: written.created,
          address: `https://${domain}/${folder ? `${encodeURIComponent(folder)}/` : ''}${pageName}`,
          subdomainAddress: config.site.folderSubdomains && folder && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(folder) ? `https://${folder}.${domain}/${pageName}` : null,
          // what still has to be switched on before the page shows anything (M5)
          toSwitch: chosen.filter((l) => 'id' in l && !l.public),
        };
      });
    }

    // The file itself, for thumbnails, players and downloads. Never run as a page:
    // served with a sandbox policy, and anything that isn't a picture, sound or
    // video is a download.
    app.get('/api/media/file', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      const path = stringParam(q.path);
      own(a, path);
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let start: number | undefined;
      let end: number | undefined;
      if (range && (range[1] || range[2])) {
        if (range[1]) { start = Number(range[1]); end = range[2] ? Number(range[2]) : undefined; }
        else {
          const info = await helper<{ size: number }>({ op: 'media-info', path, actor: a.user.username });
          start = Math.max(0, info.size - Number(range[2]));
        }
      }
      let got;
      try {
        got = await readFromSiteFs<{ name: string; size: number; start: number; end: number; modifiedAt: number }>(config.sitefsSocket, { op: 'media-read', path, start, end, actor: a.user.username });
      } catch (e) {
        if (e instanceof CallError && e.message.includes('out of range')) return reply.code(416).header('Content-Range', 'bytes */*').send();
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
      const { header: f, bytes } = got;
      const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : '';
      const type = MEDIA_TYPES[ext];
      const inline = !!type && q.download !== '1' && !type.startsWith('application/');
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      reply.header('Cache-Control', 'private, max-age=300');
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      reply.header('Content-Length', String(f.size === 0 ? 0 : f.end - f.start + 1));
      if (range && f.size > 0) reply.code(206).header('Content-Range', `bytes ${f.start}-${f.end}/${f.size}`);
      reply.type(inline ? type! : 'application/octet-stream');
      return reply.send(bytes);
    });
    // Any refusal waits until the file has finished arriving (it's at most 100 MB):
    // answering mid-upload cuts the connection, and the browser (or nginx, with
    // a 502) would only report a broken connection instead of the reason.
    app.post('/api/media/upload', { config: { needs: 'media' } }, async (req, reply) => {
      const body = req.body as import('node:stream').Readable;
      const refuse = async (status: number, message: string, error = 'refused') => {
        await drained(body);
        return reply.code(status).send({ error, message });
      };
      const a = await authOf(req);
      if (!a) return refuse(401, 'Please sign in again.', 'signed-out');
      if (!may(a, req)) return refuse(404, 'Not found.', 'not-found');
      const size = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(size) || size < 0) return refuse(411, 'The upload has no size.');
      if (size > config.site.uploads.maxBytes) return reply.code(413).send({ error: 'refused', message: `Files can be at most ${sizeWords(config.site.uploads.maxBytes)}. Put bigger ones in with WinSCP.` });
      let name: string;
      try { name = decodeURIComponent(String(req.headers['x-pammy-name'])); } catch { return refuse(400, 'Bad file name.'); }
      const dir = stringParam((req.query as Record<string, unknown>).dir);
      if (!ownsPath(a, dir)) return refuse(404, 'Not found.', 'not-found');
      let r: { path: string; name: string; renamed: boolean; size: number; modifiedAt: number; hash: string };
      try {
        r = await uploadToSiteFs(config.sitefsSocket, { op: 'media-upload', dir, name, size, actor: a.user.username }, body);
      } catch (e) {
        if (e instanceof CallError) return refuse(HELPER_STATUS[e.code] ?? 500, e.message, e.code === 'unavailable' || e.code === 'timeout' ? 'unavailable' : 'refused');
        await drained(body);
        throw e;
      }
      // not under the lock while the bytes arrive (up to 100 MB); a sync that
      // found the file first is simply taken over
      const id = await media.withLock(() => recordAdded(db, now(), { path: r.path, size: r.size, modifiedAt: r.modifiedAt, hash: r.hash, how: 'uploaded', by: a.user.username }));
      void thumbs.kick([id]);
      await logActivity(db, now(), actorOf(a, req), 'media-uploaded', r.path, r.renamed ? `"${name}" was taken, so saved as "${r.name}"` : null);
      return { ok: true, path: r.path, name: r.name, renamed: r.renamed };
    });

    app.post('/api/media/mkdir', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      own(a, b.dir);
      const r = await helper<{ path: string }>({ op: 'media-mkdir', dir: b.dir, name: b.name, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'media-bucket-made', r.path, null);
      return { ok: true, ...r };
    });

    // D8: into another media folder, its tags and categories go by name (made there if need be).
    app.post('/api/media/copy', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const from = pathParam(b.from);
      own(a, from, b.to);
      const { r, created } = await media.withLock(async () => {
        const r = await helper<{ path: string; name: string; size: number; modifiedAt: number }>({ op: 'media-copy', from, to: b.to, name: b.name, actor: a.user.username });
        const c = await recordCopied(db, now(), from, { path: r.path, size: r.size, modifiedAt: r.modifiedAt }, a.user.username);
        void thumbs.kick([c.id]);
        return { r, created: c.created };
      });
      await logActivity(db, now(), actorOf(a, req), 'media-copied', from, [`to ${r.path}`, labelsNote(created)].filter(Boolean).join('; '));
      return { ok: true, path: r.path, name: r.name, created };
    });

    app.post('/api/media/move', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const from = pathParam(b.from);
      own(a, from, b.to);
      const { r, created } = await media.withLock(async () => {
        const r = await helper<{ path: string; name: string }>({ op: 'media-move', from, to: b.to, name: b.name, actor: a.user.username });
        return { r, created: (await recordMoved(db, now(), from, r.path, a.user.username)).created };
      });
      if (r.path !== from) {
        const renamedOnly = from.split('/').slice(0, -1).join('/') === r.path.split('/').slice(0, -1).join('/');
        await logActivity(db, now(), actorOf(a, req), renamedOnly ? 'media-renamed' : 'media-moved', from,
          [renamedOnly ? `now "${r.name}"` : `to ${r.path}`, labelsNote(created)].filter(Boolean).join('; '));
      }
      return { ok: true, ...r, created };
    });

    app.post('/api/media/trash', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      own(a, body(req).path);
      const r = await media.withLock(async () => {
        const r = await helper<{ id: string; path: string; purgeAt: number }>({ op: 'media-trash', path: body(req).path, actor: a.user.username });
        await recordTrashed(db, now(), r.path, r.id);
        return r;
      });
      await logActivity(db, now(), actorOf(a, req), 'media-trashed', r.path, `restorable until ${dateOf(r.purgeAt)}`);
      return { ok: true, ...r };
    });

    app.get('/api/media/trash', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const t = await helper<{ items: { path: string }[] }>({ op: 'media-trash-list', actor: a.user.username });
      return { ...t, items: t.items.filter((i) => ownsPath(a, i.path)) };
    });

    app.post('/api/media/restore', { config: { needs: 'media' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const { r, item } = await media.withLock(async () => {
        const list = await helper<{ items: { id: string; path: string; name: string }[] }>({ op: 'media-trash-list', actor: a.user.username });
        const item = list.items.find((x) => x.id === b.id);
        if (isKept(a.user) && !(item && ownsPath(a, item.path))) throw new AccountError("That's no longer in the trash.", 404);
        const r = await helper<{ path: string }>({ op: 'files-restore', id: b.id, as: b.as, actor: a.user.username });
        const back = item ? await recordRestored(db, now(), item.id, item.path.replace(/(^|\/)media\/photos(\/|$)/, '$1media/images$2'), r.path, a.user.username) : null;
        // trashed before the media records existed: none to bring back, so a sync
        // finds them, with who added what from the old notes
        if (item && !back?.restored) {
          await moveImportedNotes(db, `trash:${item.id}/${item.name}`, r.path);
          try { await media.syncLocked(a.user.username); } catch (e) { req.log.warn({ err: e }, 'media sync after a restore failed'); }
        }
        return { r, item };
      });
      await logActivity(db, now(), actorOf(a, req), 'media-restored', r.path, item && item.path !== r.path ? `was ${item.path}` : null);
      return { ok: true, ...r };
    });
}
