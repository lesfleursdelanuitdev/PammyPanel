// The editor (docs/editor-plan.md): text files read and saved whole (at most
// 2 MB). A save names the copy it started from (its sha256) and is refused with
// 409 "conflict" if the file has changed since; the helper keeps what each save
// replaced as an earlier version.
import type { FastifyInstance } from 'fastify';
import { own, pathParam } from '../site-files.ts';
import { AccountError, getUser, logActivity, placesOf } from '@panel/core/accounts';
import { SESSION_IDLE } from '@panel/core/config';
import { CallError } from '@panel/core/jsonline';
import { recordAdded, recordEdited } from '../../media-db.ts';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { MEDIA_TYPES, ownsPath, siteOfPath } from '../site-files.ts';
import { one } from '@panel/core/pg';
import { Previews, inside, previewHtml, previewRoot } from '../../preview.ts';
import { type Authed } from '@panel/core/sessions';
import { callSiteFs, readFromSiteFs, uploadToSiteFs } from '../../sitefs/client.ts';
import { MAX_TEXT, type Saved, type Version, editProblem } from '../../sitefs/edit.ts';
import { CODE, extensionOf } from '../../sitefs/media.ts';
import { roots, rootTarget, type Root } from '../roots.ts';
import { isAdmin } from '@panel/core/panel/rights';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FilesCtx } from '../files-ctx.ts';

export function routes(app: FastifyInstance, ctx: FilesCtx) {
  const { config, db, now, media, thumbs, need, body, actorOf, helper } = ctx;
  const R = roots(ctx);

    // ---------------------------------------------------------------- the editor (docs/editor-plan.md)
    // Text files are read and saved whole (at most 2 MB). A save names the copy it
    // started from (its sha256) and is refused with 409 "conflict" if the file has
    // changed since; the helper keeps what each save replaced as an earlier version.
    const previews = new Previews(now);
    const TEXT_BODY = { bodyLimit: 8 * 1024 * 1024 };      // 2 MB of text, even when JSON escapes much of it
    const readAll = async (bytes: import('node:stream').Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of bytes) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    };
    const helperError = (e: unknown): never => {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    };
    const decodeText = (buf: Buffer) => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new AccountError("That file isn't plain text the editor can open. Download it instead.", 415); }
    };
    const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const TOO_BIG = 'The editor opens files of up to 2 MB. Download bigger ones instead, or change them with WinSCP.';
    const conflict = (reply: FastifyReply, e: unknown) => {
      if (e instanceof CallError && e.code === 'conflict') return reply.code(409).send({ error: 'conflict', message: e.message });
      return helperError(e);
    };
    // After a save: its media record, the activity log (once per version, so a
    // quick run of Ctrl+S is one line), and a new thumbnail for an .svg.
    const recordSave = async (a: Authed, req: FastifyRequest, r: Saved, what: 'file-created' | 'file-saved' | 'file-version-restored', detail: string | null, root: Root = R.website) => {
      if (r.unchanged) return;
      // a software root keeps no records (S3-1): Activity only
      if (!root.catalogued) {
        if (what !== 'file-saved' || r.newVersion) await logActivity(db, now(), actorOf(a, req), what, rootTarget(root, r.path), detail);
        return;
      }
      const id = r.created
        ? await recordAdded(db, now(), { path: r.path, size: r.size, modifiedAt: r.modifiedAt, hash: r.hash, how: 'uploaded', by: a.user.username })
        : await recordEdited(db, now(), { path: r.path, size: r.size, modifiedAt: r.modifiedAt, hash: r.hash });
      if (id) void thumbs.kick([id]);
      if (what !== 'file-saved' || r.newVersion) await logActivity(db, now(), actorOf(a, req), what, r.path, detail);
    };

    app.get('/api/files/text', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = pathParam((req.query as Record<string, unknown>).path);
      const root = await R.pick(a, (req.query as Record<string, unknown>).root);
      if (root.kind === 'website') own(a, path);
      const name = path.split('/').pop() ?? '';
      const problem = editProblem(name, root.kind === 'software');
      if (problem) throw new AccountError(problem, 400);
      const got = await R.read<{ name: string; size: number; modifiedAt: number }>(root, a, { op: 'files-read', path, actor: a.user.username }).catch(helperError);
      if (got.header.size > MAX_TEXT) { got.bytes.destroy(); throw new AccountError(TOO_BIG, 413); }
      const buf = await readAll(got.bytes);
      // a software root's code opens for everyone, and is saved only by panel admins (Q3-2)
      const readOnly = root.kind === 'software' && CODE.has(extensionOf(name)) && !isAdmin(a.user);
      return { path, root: root.id, name: got.header.name, text: decodeText(buf), hash: sha256(buf), size: buf.length, modifiedAt: got.header.modifiedAt, readOnly };
    });

    // {path, text, expect} saves over the file opened as `expect`; {path, text, create:
    // 'exact'} makes a new one; create: 'free' too, under the next free name if taken.
    // session: the open editor it comes from (its quick saves share one version).
    app.post('/api/files/save', { ...TEXT_BODY, config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const path = pathParam(b.path);
      const root = await R.pick(a, b.root);
      if (root.kind === 'website') own(a, path);
      if (typeof b.text !== 'string') throw new AccountError('Nothing to save.', 400);
      const buf = Buffer.from(b.text, 'utf8');
      if (buf.length > MAX_TEXT) throw new AccountError('The editor saves files of up to 2 MB. Put bigger ones in with WinSCP.', 413);
      const create = b.create === 'exact' || b.create === 'free' ? b.create : false;
      let r: Saved;
      try {
        r = await media.withLock(async () => {
          const r = await R.upload<Saved>(root, a, { op: 'files-write', path, expect: create ? null : b.expect, create, session: b.session, size: buf.length, actor: a.user.username }, Readable.from([buf]));
          await recordSave(a, req, r, create ? 'file-created' : 'file-saved', null, root);
          return r;
        });
      } catch (e) { return conflict(reply, e); }
      return { ok: true, ...r };
    });

    app.get('/api/files/versions', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = pathParam((req.query as Record<string, unknown>).path);
      const root = await R.pick(a, (req.query as Record<string, unknown>).root);
      if (root.kind === 'website') own(a, path);
      return R.call<{ path: string; versions: Omit<Version, 'after' | 'session' | 'order'>[]; keepDays: number }>(root, a, { op: 'files-versions', path, actor: a.user.username });
    });

    // An earlier version's details (and its text unless meta=1), for its account only.
    const versionOf = async (a: Authed, id: unknown, withText: boolean, root: Root = R.website) => {
      const got = await R.read<Version>(root, a, { op: 'files-version-read', id, actor: a.user.username }).catch(helperError);
      if (root.kind === 'website' && !ownsPath(a, got.header.path)) { got.bytes.destroy(); throw new AccountError('That earlier version is no longer kept.', 404); }
      if (!withText) { got.bytes.destroy(); return { version: got.header, text: null }; }
      return { version: got.header, text: decodeText(await readAll(got.bytes)) };
    };
    app.get('/api/files/version', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const q = req.query as Record<string, unknown>;
      const { version: { after: _after, session: _session, order: _order, ...v }, text } = await versionOf(a, q.id, true, await R.pick(a, q.root));
      return { ...v, text };
    });

    app.post('/api/files/versions/restore', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const root = await R.pick(a, b.root);
      const { version } = await versionOf(a, b.id, false, root);
      let r: Saved;
      try {
        r = await media.withLock(async () => {
          const req2 = { op: 'files-version-restore', id: version.id, expect: typeof b.expect === 'string' ? b.expect : null, actor: a.user.username };
          const r = root.kind === 'website' ? await callSiteFs<Saved>(config.sitefsSocket, req2, 60_000) : await R.callRaw<Saved>(root, a, req2, 60_000);
          await recordSave(a, req, r, 'file-version-restored', `as it was on ${new Date(version.modifiedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`, root);
          return r;
        });
      } catch (e) { return conflict(reply, e); }
      return { ok: true, ...r };
    });

    // The preview: a token for this account and this page's folder (see preview.ts).
    app.post('/api/files/preview', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = pathParam(body(req).path);
      own(a, path);
      const token = previews.create(a.user.id, a.session.id, previewRoot(path, siteOfPath(a, path)));
      return { token, base: `/api/files/view/${token}/` };
    });
    app.post('/api/files/preview/close', { config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const token = body(req).token;
      if (typeof token === 'string') previews.drop(token, a.user.id);
      return { ok: true };
    });
    app.post('/api/files/draft', { ...TEXT_BODY, config: { needs: 'files' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const path = pathParam(b.path);
      own(a, path);
      if (typeof b.token !== 'string' || typeof b.text !== 'string') throw new AccountError('Nothing to show.', 400);
      if (Buffer.byteLength(b.text) > MAX_TEXT) throw new AccountError('The preview shows files of up to 2 MB.', 413);
      if (!previews.setDraft(b.token, a.user.id, path, b.text)) return reply.code(410).send({ error: 'expired', message: 'The preview expired. It starts again by itself.' });
      return { ok: true };
    });

    // What the preview frame loads. No cookie (the frame is sandboxed): the token is
    // the permission. Answers are sandboxed too (the CSP's own `sandbox`), even
    // when opened on their own, and may be used by that opaque origin (CORP).
    const VIEW_TYPES: Record<string, string> = {
      ...MEDIA_TYPES, html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
      js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8',
      md: 'text/plain; charset=utf-8', xml: 'application/xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
      webmanifest: 'application/manifest+json',
    };
    const o = config.origin;
    const VIEW_POLICY = [
      `default-src ${o} https: data: blob:`, `script-src ${o} https: 'unsafe-inline' 'unsafe-eval'`, `style-src ${o} https: 'unsafe-inline'`,
      `img-src ${o} https: data: blob:`, `font-src ${o} https: data:`, `media-src ${o} https: data: blob:`, `connect-src ${o}`,
      "form-action 'none'", `frame-ancestors ${o}`, 'sandbox allow-scripts',
    ].join('; ');
    app.get('/api/files/view/:token/*', { config: { needs: 'public' } }, async (req, reply) => {
      const params = req.params as { token: string; '*': string };
      reply.header('Content-Security-Policy', VIEW_POLICY);
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      const gone = (status = 404, text = 'Not found in your website.') => reply.code(status).type('text/plain; charset=utf-8').send(text);
      const p = previews.use(params.token);
      const user = p ? await getUser(db, p.userId) : undefined;
      // the session that made it must still be live (signed out, or "sign out everywhere": gone)
      const session = p ? await one<{ revoked_at: number | null; expires_at: number; last_seen_at: number }>(db,
        'SELECT revoked_at, expires_at, last_seen_at FROM sessions WHERE id = ? AND user_id = ?', p.sessionId, p.userId) : undefined;
      const live = !!session && !session.revoked_at && session.expires_at > now() && session.last_seen_at + SESSION_IDLE > now();
      if (!p || !user || !user.active || !live) return gone(410, 'This preview has expired. Close the editor and open the file again.');
      const raw = params['*'] ?? '';
      const path = pathParam(raw === '' || raw.endsWith('/') ? `${raw}index.html` : raw);
      // a person kept to places: only theirs, as they are now (not when the preview was made)
      const places = (await placesOf(db, user.id)).map((pl) => pl.slice(1));
      if (!inside(p.root, path) || (places.length && !places.some((site) => inside(site, path)))) return gone();
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
      const type = VIEW_TYPES[ext] ?? 'application/octet-stream';
      const rootBase = `/api/files/view/${params.token}/${p.root ? `${p.root.split('/').map(encodeURIComponent).join('/')}/` : ''}`;
      const isHtml = ext === 'html' || ext === 'htm';
      if (p.draft && p.draft.path === path) return reply.type(type).send(isHtml ? previewHtml(p.draft.text, rootBase) : p.draft.text);
      let got;
      try {
        got = await readFromSiteFs<{ size: number }>(config.sitefsSocket, { op: 'files-read', path, view: true, actor: user.username });
      } catch (e) {
        if (e instanceof CallError && e.code === 'invalid' && /is a folder/.test(e.message)) return reply.redirect(`${req.url.split('?')[0]}/`);
        if (e instanceof CallError && (e.code === 'not-found' || e.code === 'invalid')) return gone();
        throw e;
      }
      if (isHtml && got.header.size <= MAX_TEXT) return reply.type(type).send(previewHtml((await readAll(got.bytes)).toString('utf8'), rootBase));
      reply.header('Content-Length', String(got.header.size));
      return reply.type(type).send(got.bytes);
    });


}
