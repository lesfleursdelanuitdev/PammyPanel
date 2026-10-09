// File Explorer: the whole website, not just the media folders (the Media tab
// is the media/ filter on the same records). docs/pammy-file-explorer.
import { sizeWords } from '@panel/core/profile';
import type { FastifyInstance } from 'fastify';
import {
  drained, itemOf, labelsNote, own, ownsPath, pathParam, siteLimits, stringParam, syncFor, who,
} from '../site-files.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { FILE_KINDS, type FileKind, moveImportedNotes, presentAt, presentIn, queryItems, recordAdded, recordCopied, recordGone, recordMoved, recordRestored, recordTrashed } from '../../media-db.ts';
import { labelsOf } from '@panel/catalog/labels';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { isKept, keptTo } from '@panel/core/panel/rights';
import { MEDIA_TYPES } from '../site-files.ts';
import { isProgramFile } from '../../sitefs/media.ts';
import { readFromSiteFs, uploadToSiteFs } from '../../sitefs/client.ts';
import type { FilesCtx } from '../files-ctx.ts';
import { roots, rootTarget, type Root } from '../roots.ts';
import type { Authed } from '@panel/core/sessions';

type Listing = { path: string; buckets: { name: string; items: number; modifiedAt: number }[]; files: { name: string; size: number; modifiedAt: number }[] };

const fileOf = (dir: string, f: { name: string; size: number; modifiedAt: number }) => ({ path: dir ? `${dir}/${f.name}` : f.name, name: f.name, size: f.size, modifiedAt: f.modifiedAt });

// opts.shown: where each top folder is on the internet, on a site that routes names to
// folders (lfdln, docs/phase8-plan.md step 8-1): "folder" -> ["https://tutor.x.com/", ...].
// Without it, a file's address is the site's domain and its path (pammy.org).
export type ShownAt = () => Promise<Record<string, string[]>>;
export function routes(app: FastifyInstance, ctx: FilesCtx, opts: { shown?: ShownAt } = {}) {
  const { config, db, now, media, thumbs, need, may, body, actorOf, authOf, helper, dateOf } = ctx;
  const R = roots(ctx);
  // a software root's page: the files straight from its helper (not catalogued, S3-1)
  const softwareList = async (r: Root, a: Authed, dir: string) => {
    const l = await R.call<Listing>(r, a, { op: 'files-list', dir, actor: a.user.username });
    return { path: l.path, folders: l.buckets.map((x) => ({ name: x.name, items: x.items })), files: l.files.map((f) => fileOf(l.path, f)) };
  };

    // ---------------------------------------------------------------- file explorer (the whole website; Media is the media/ filter)
    app.get('/api/files', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const asked = (req.query as Record<string, unknown>).root;
      const visible = (await R.visible(a)).map((x) => ({ id: x.id, label: x.label, kind: x.kind }));
      // kept only to software (step 3b): no website here; the page opens their first root
      if ((asked === undefined || asked === '') && !visible.some((x) => x.kind === 'website')) {
        return { root: null, roots: visible, dirs: [], sync: null, limitedTo: [] };
      }
      const r = await R.pick(a, asked);
      if (r.kind === 'software') {
        const tree = await R.call<{ dirs: string[] }>(r, a, { op: 'files-tree', actor: a.user.username });
        return { root: r.id, roots: visible, dirs: tree.dirs, sync: null, limitedTo: null };
      }
      try { await media.syncIfStale('automatic check'); } catch (e) { req.log.warn({ err: e }, 'media sync on opening Files failed'); }
      const tree = await helper<{ dirs: string[] }>({ op: 'files-tree', actor: a.user.username });
      const limited = siteLimits(a);
      return { root: r.id, roots: visible, dirs: tree.dirs.filter((p) => ownsPath(a, p)), sync: syncFor(a, await media.last()), limitedTo: limited };
    });

    // where the folders are shown (null: at the site's own domain, by path)
    app.get('/api/files/shown', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (!opts.shown) return { shown: null };
      const all = await opts.shown();
      return { shown: Object.fromEntries(Object.entries(all).filter(([folder]) => ownsPath(a, folder))) };
    });

    app.get('/api/files/list', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const dir = pathParam((req.query as Record<string, unknown>).dir);
      const root = await R.pick(a, (req.query as Record<string, unknown>).root);
      if (root.kind === 'software') return softwareList(root, a, dir);
      own(a, dir);
      const r = await helper<{ path: string; buckets: { name: string; items: number; modifiedAt: number }[]; files: { name: string }[] }>(
        { op: 'files-list', dir, actor: a.user.username });
      const rows = (await presentIn(db, r.path)).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
      const pictures = await thumbs.infoFor(rows);
      const labels = await labelsOf(db, rows.map((f) => f.id));
      return { path: r.path, folders: r.buckets.map((x) => ({ name: x.name, items: x.items })), items: rows.map((f) => itemOf(f, pictures, labels, 'all')) };
    });

    app.get('/api/files/info', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = pathParam((req.query as Record<string, unknown>).path);
      const root = await R.pick(a, (req.query as Record<string, unknown>).root);
      if (root.kind === 'software') {
        const st = await R.call<{ path: string; dir: boolean }>(root, a, { op: 'files-stat', path, actor: a.user.username });
        const parent = st.path.split('/').slice(0, -1).join('/');
        const name = st.path.split('/').pop() ?? st.path;
        const f = st.dir ? null : (await R.call<Listing>(root, a, { op: 'files-list', dir: parent, actor: a.user.username })).files.find((x) => x.name === name);
        return { ...st, name, size: f?.size ?? 0, modifiedAt: f?.modifiedAt ?? 0 };
      }
      own(a, path);
      let r: { path: string; dir: boolean };
      try {
        r = await helper<{ path: string; dir: boolean }>({ op: 'files-stat', path, actor: a.user.username });
      } catch (e) {
        if (e instanceof AccountError && e.status === 404) await media.withLock(() => recordGone(db, now(), path));
        throw e;
      }
      const rec = await presentAt(db, r.path);
      return { ...r, id: rec?.id ?? null, ...who(rec), thumb: rec ? await thumbs.info(rec) : null, scope: rec?.scope ?? null, title: rec?.title ?? null, alt: rec?.alt ?? null,
        ...(rec ? (await labelsOf(db, [rec.id])).get(rec.id)! : { tags: [], categories: [] }), name: r.path.split('/').pop() ?? r.path, size: rec?.size ?? 0, fits: true,
        modifiedAt: rec?.modified_at ?? 0, createdAt: rec?.added_at ?? 0 };
    });

    app.get('/api/files/items', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      const dir = pathParam(q.dir);
      const root = await R.pick(a, q.root);
      // a software root has no records to search or filter: its folder as it is
      if (root.kind === 'software') {
        const l = await softwareList(root, a, dir);
        return { mode: 'browse', dir: l.path, folders: l.folders, files: l.files, items: [], total: l.files.length, offset: 0, limit: l.files.length };
      }
      own(a, dir);
      const kindQ = stringParam(q.kind);
      const kind = (FILE_KINDS as readonly string[]).includes(kindQ) ? kindQ as FileKind : null;
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
      const browse = !search && !tags.length && !categories.length && !kind;
      let folders: { name: string; items: number }[] = [];
      if (browse) {
        const r = await helper<{ buckets: { name: string; items: number }[] }>({ op: 'files-list', dir, actor: a.user.username });
        folders = r.buckets.map((x) => ({ name: x.name, items: x.items }));
      }
      const sort = (['name', 'size', 'added'] as const).find((x) => x === q.sort) ?? 'name';
      const offset = Math.max(0, Math.min(Number(q.offset) || 0, 1_000_000));
      const limit = 100;
      const { rows, total } = await queryItems(db, {
        scope: null, within: keptTo(a.user), kind, dir, deep: !browse, library: 'all', q: search, tags, categories, sort, desc: q.order === 'desc', offset, limit,
      });
      const pictures = await thumbs.infoFor(rows);
      const labels = await labelsOf(db, rows.map((r) => r.id));
      return { mode: browse ? 'browse' : 'all', dir, folders, items: rows.map((f) => itemOf(f, pictures, labels, 'all')), total, offset, limit };
    });

    app.get('/api/files/file', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      const path = pathParam(q.path);
      const root = await R.pick(a, q.root);
      if (root.kind === 'website') own(a, path);
      // a site's program files (.php and the like) can hold its keys: admins only (finding 1)
      if (root.kind === 'website' && isProgramFile(path) && a.user.role !== 'manager') throw new AccountError('Only admins can download program files (.php and the like).', 403);
      const range = String(req.headers.range ?? '');
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m && m[1] ? Number(m[1]) : undefined;
      const end = m && m[2] ? Number(m[2]) : undefined;
      let got;
      try {
        got = await R.read<{ name: string; size: number; start: number; end: number; modifiedAt: number }>(root, a, { op: 'files-read', path, start, end, actor: a.user.username });
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

    app.post('/api/files/upload', { config: { needs: 'files' } }, async (req, reply) => {
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
      let root: Root;
      try { root = await R.pick(a, (req.query as Record<string, unknown>).root); } catch { return refuse(404, 'Not found.', 'not-found'); }
      if (root.kind === 'website' && !ownsPath(a, dir)) return refuse(404, 'Not found.', 'not-found');
      let r: { path: string; name: string; renamed: boolean; size: number; modifiedAt: number; hash: string };
      try {
        r = await R.upload(root, a, { op: 'files-upload', dir, name, size, actor: a.user.username }, body);
      } catch (e) {
        if (e instanceof CallError) return refuse(HELPER_STATUS[e.code] ?? 500, e.message, e.code === 'unavailable' || e.code === 'timeout' ? 'unavailable' : 'refused');
        await drained(body);
        throw e;
      }
      if (root.catalogued) {
        const id = await media.withLock(() => recordAdded(db, now(), { path: r.path, size: r.size, modifiedAt: r.modifiedAt, hash: r.hash, how: 'uploaded', by: a.user.username }));
        void thumbs.kick([id]);
      }
      await logActivity(db, now(), actorOf(a, req), 'file-uploaded', rootTarget(root, r.path), r.renamed ? `"${name}" was taken, so saved as "${r.name}"` : null);
      return { ok: true, path: r.path, name: r.name, renamed: r.renamed };
    });

    app.post('/api/files/mkdir', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const root = await R.pick(a, b.root);
      if (root.kind === 'website') own(a, b.dir);
      const r = await R.call<{ path: string }>(root, a, { op: 'files-mkdir', dir: b.dir, name: b.name, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'file-folder-made', rootTarget(root, r.path), null);
      return { ok: true, ...r };
    });

    app.post('/api/files/copy', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const from = pathParam(b.from);
      const root = await R.pick(a, b.root);
      if (root.kind === 'software') {
        const r = await R.call<{ path: string; name: string }>(root, a, { op: 'files-copy', from, to: b.to, name: b.name, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'file-copied', rootTarget(root, from), `to ${rootTarget(root, r.path)}`);
        return { ok: true, path: r.path, name: r.name, created: { tags: [], categories: [] } };
      }
      own(a, from, b.to);
      const { r, created } = await media.withLock(async () => {
        const r = await helper<{ path: string; name: string; size: number; modifiedAt: number }>({ op: 'files-copy', from, to: b.to, name: b.name, actor: a.user.username });
        const c = await recordCopied(db, now(), from, { path: r.path, size: r.size, modifiedAt: r.modifiedAt }, a.user.username);
        void thumbs.kick([c.id]);
        return { r, created: c.created };
      });
      await logActivity(db, now(), actorOf(a, req), 'file-copied', from, [`to ${r.path}`, labelsNote(created)].filter(Boolean).join('; '));
      return { ok: true, path: r.path, name: r.name, created };
    });

    app.post('/api/files/move', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const from = pathParam(b.from);
      const root = await R.pick(a, b.root);
      if (root.kind === 'software') {
        const r = await R.call<{ path: string; name: string }>(root, a, { op: 'files-move', from, to: b.to, name: b.name, actor: a.user.username });
        if (r.path !== from) {
          const renamedOnly = from.split('/').slice(0, -1).join('/') === r.path.split('/').slice(0, -1).join('/');
          await logActivity(db, now(), actorOf(a, req), renamedOnly ? 'file-renamed' : 'file-moved', rootTarget(root, from), renamedOnly ? `now "${r.name}"` : `to ${rootTarget(root, r.path)}`);
        }
        return { ok: true, ...r, created: { tags: [], categories: [] } };
      }
      own(a, from, b.to);
      const { r, created } = await media.withLock(async () => {
        const r = await helper<{ path: string; name: string }>({ op: 'files-move', from, to: b.to, name: b.name, actor: a.user.username });
        return { r, created: (await recordMoved(db, now(), from, r.path, a.user.username)).created };
      });
      if (r.path !== from) {
        const renamedOnly = from.split('/').slice(0, -1).join('/') === r.path.split('/').slice(0, -1).join('/');
        await logActivity(db, now(), actorOf(a, req), renamedOnly ? 'file-renamed' : 'file-moved', from,
          [renamedOnly ? `now "${r.name}"` : `to ${r.path}`, labelsNote(created)].filter(Boolean).join('; '));
      }
      return { ok: true, ...r, created };
    });

    app.post('/api/files/trash', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const root = await R.pick(a, body(req).root);
      if (root.kind === 'software') {
        const r = await R.call<{ id: string; path: string; purgeAt: number }>(root, a, { op: 'files-trash', path: body(req).path, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'file-trashed', rootTarget(root, r.path), `restorable until ${dateOf(r.purgeAt)}`);
        return { ok: true, ...r };
      }
      own(a, body(req).path);
      const r = await media.withLock(async () => {
        const r = await helper<{ id: string; path: string; purgeAt: number }>({ op: 'files-trash', path: body(req).path, actor: a.user.username });
        await recordTrashed(db, now(), r.path, r.id);
        return r;
      });
      await logActivity(db, now(), actorOf(a, req), 'file-trashed', r.path, `restorable until ${dateOf(r.purgeAt)}`);
      return { ok: true, ...r };
    });

    // A root's trash: the website's is the Media trash too (/api/media/trash), here for a
    // site with File Explorer and no media folders (lfdln, docs/phase8-plan.md step 8-1)
    app.get('/api/files/trash', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const root = await R.pick(a, (req.query as Record<string, unknown>).root);
      if (root.kind === 'website') {
        const t = await helper<{ items: { path: string }[] }>({ op: 'media-trash-list', actor: a.user.username });
        return { ...t, items: t.items.filter((i) => ownsPath(a, i.path)) };
      }
      return R.call<{ items: { id: string; path: string; name: string; isDir: boolean; trashedAt: number; purgeAt: number }[]; purgeDays: number }>(
        root, a, { op: 'media-trash-list', actor: a.user.username });
    });

    app.post('/api/files/restore', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const root = await R.pick(a, b.root);
      if (root.kind === 'software') {
        const list = await R.call<{ items: { id: string; path: string }[] }>(root, a, { op: 'media-trash-list', actor: a.user.username });
        const item = list.items.find((x) => x.id === b.id);
        const r = await R.call<{ path: string }>(root, a, { op: 'files-restore', id: b.id, as: b.as, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'file-restored', rootTarget(root, r.path), item && item.path !== r.path ? `was ${rootTarget(root, item.path)}` : null);
        return { ok: true, ...r };
      }
      const { r, item } = await media.withLock(async () => {
        const list = await helper<{ items: { id: string; path: string; name: string }[] }>({ op: 'media-trash-list', actor: a.user.username });
        const item = list.items.find((x) => x.id === b.id);
        if (isKept(a.user) && !(item && ownsPath(a, item.path))) throw new AccountError("That's no longer in the trash.", 404);
        const r = await helper<{ path: string }>({ op: 'files-restore', id: b.id, as: b.as, actor: a.user.username });
        const back = item ? await recordRestored(db, now(), item.id, item.path.replace(/(^|\/)media\/photos(\/|$)/, '$1media/images$2'), r.path, a.user.username) : null;
        if (item && !back?.restored) {
          moveImportedNotes(db, `trash:${item.id}/${item.name}`, r.path);
          try { await media.syncLocked(a.user.username); } catch (e) { req.log.warn({ err: e }, 'media sync after a restore failed'); }
        }
        return { r, item };
      });
      await logActivity(db, now(), actorOf(a, req), 'file-restored', r.path, item && item.path !== r.path ? `was ${item.path}` : null);
      return { ok: true, ...r };
    });


}
