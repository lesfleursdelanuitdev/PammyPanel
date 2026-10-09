// Installed software (docs/apps-plan.md): WordPress, and whatever the catalog
// gains later. The panel never looks at it itself: the software helper
// (src/apps/, pammy-apps.socket) is the truth about what is installed and how it
// is doing, and these routes pass on what it says -- and, from phase 2, ask it
// to change things, recording who asked in the activity.
//
// "Installed software", not "apps": in the panel an app is the pages it makes for
// one of her databases (docs/refactor-plan.md phase 6), and a program is one she
// writes herself. Account managers only, like her databases.
//
// Asking for a fresh passkey (G2): putting a backup back, a new admin password,
// moving, installing and deleting. Backups, offline, online and restoring a
// deleted one don't: none of them loses anything.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { readFromApps } from '../../apps/client.ts';
import { ID_RE } from '../../apps/record.ts';
import { CallError } from '@panel/core/jsonline';
import { HELPER_STATUS, type PanelCtx } from '@panel/core/panel/context';
import { all, run, tx } from '@panel/core/pg';

const STAMP_RE = /^\d{8}T\d{6}Z$/;
// 20260921T033012Z -> "2026-09-21 03:30 UTC", for the activity
const whenOf = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)} UTC`;

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, actorOf, software, helper, config } = ctx;
  const domain = config.site.domain;
  const idOf = (req: FastifyRequest) => {
    const id = (req.params as { id?: string }).id;
    // an address the helper could never have made is simply not a page
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new AccountError('Not found.', 404);
    return id;
  };
  const stampOf = (v: unknown) => {
    if (typeof v !== 'string' || !STAMP_RE.test(v)) throw new AccountError('That backup is not there any more.', 404);
    return v;
  };

    // The list, and the same with a slash: for a few minutes on 2026-09-23 nginx
    // answered /api/software with a permanent redirect to /api/software/, and a
    // browser that saw it keeps going there by itself (browsers remember 301s).
    for (const url of ['/api/software', '/api/software/']) {
      app.get(url, { config: { needs: 'software' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const list = await software<{ apps: { id: string }[] }>({ op: 'list', actor: a.user.username });
        await forgetGone(list.apps.map((x) => x.id));
        return list;
      });
    }

    // Software deleted for good is taken off every account it was a place of (docs/catalog-plan.md
    // step 3b, QP2; while it is only deleted, the place stays and reaches nothing). The helper's
    // list is the truth, so this runs whenever the list is read -- the page reads it after one goes.
    async function forgetGone(ids: string[]) {
      const known = new Set(ids.map((id) => `software:${id}`));
      const stale = (await all<{ user_id: number; username: string; place: string }>(db,
        "SELECT p.user_id, u.username, p.place FROM user_places p JOIN users u ON u.id = p.user_id WHERE p.place LIKE 'software:%' ORDER BY u.username, p.place"))
        .filter((r) => !known.has(r.place));
      for (const r of stale) {
        await tx(db, async (q) => {
          await run(q, 'DELETE FROM user_places WHERE user_id = ? AND place = ?', r.user_id, r.place);
          // no place left would mean the whole site: their parts of the panel go with it
          const left = await all(q, 'SELECT 1 FROM user_places WHERE user_id = ?', r.user_id);
          if (!left.length) await run(q, 'DELETE FROM user_rights WHERE user_id = ?', r.user_id);
          await logActivity(q, now(), { id: null, label: 'the panel' }, 'user-places-changed', r.username,
            `${r.place.slice('software:'.length)} was deleted for good, so its files are no longer theirs${left.length ? '' : '; it was their only place, so they have no parts of the panel now'}`);
        });
      }
    }

    app.get('/api/software/:id', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return software({ op: 'status', id: idOf(req), actor: a.user.username });
    });

    // ---------------------------------------------------------------- phase 2: backups
    app.get('/api/software/:id/backups', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return software({ op: 'backups', id: idOf(req), actor: a.user.username });
    });

    app.post('/api/software/:id/backup', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const id = idOf(req);
      const r = await software<{ job: unknown }>({ op: 'backup', id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-backup', id, null);
      return r;
    });

    app.post('/api/software/:id/restore', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idOf(req);
      const stamp = stampOf(body(req).stamp);
      const r = await software<{ job: unknown }>({ op: 'restore', id, stamp, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-restore', id, `the backup of ${whenOf(stamp)}`);
      return r;
    });

    // A backup as one .tar, streamed from the helper as it is read (nginx: no
    // buffering on this address, deploy/pammy-panel.nginx).
    app.get('/api/software/:id/backups/:stamp/download', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const id = idOf(req);
      const stamp = stampOf((req.params as { stamp?: string }).stamp);
      let got;
      try {
        got = await readFromApps<{ name: string }>(config.appsSocket, { op: 'download', id, stamp, actor: a.user.username });
      } catch (e) {
        if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
        throw e;
      }
      await logActivity(db, now(), actorOf(a, req), 'software-backup-downloaded', id, `the backup of ${whenOf(stamp)}`);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(got.header.name)}`);
      reply.header('Cache-Control', 'no-store');
      reply.type('application/x-tar');
      return reply.send(got.bytes);
    });

    // ---------------------------------------------------------------- phase 2: offline and online (A4)
    for (const op of ['offline', 'online'] as const) {
      app.post(`/api/software/:id/${op}`, { config: { needs: 'software' } }, async (req, reply) => {
        const a = await need(req, reply);
        if (!a) return reply;
        const id = idOf(req);
        const r = await software<{ job: unknown }>({ op, id, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), `software-${op}`, id, null);
        return r;
      });
    }

    // ---------------------------------------------------------------- phase 2: admin password (P2c)
    app.get('/api/software/:id/admins', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return software({ op: 'admins', id: idOf(req), actor: a.user.username });
    });

    // Shown once, and written into her login file by the helper; the panel
    // passes it through and keeps no copy (and the activity never names it).
    app.post('/api/software/:id/admin-password', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idOf(req);
      const user = body(req).user;
      if (typeof user !== 'string') throw new AccountError('There is no administrator by that name.', 404);
      const r = await software<{ user: string; password: string; savedTo: string | null }>({ op: 'reset-admin', id, user, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-admin-password', id, `for ${r.user}`);
      reply.header('Cache-Control', 'no-store');
      return r;
    });

    // ---------------------------------------------------------------- phase 4a: move it (passkey, G2)
    // Her folders are the panel's to see (the software helper has no way into
    // /pamela): an address that would hide one of them is refused here.
    app.post('/api/software/:id/move', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idOf(req);
      const b = body(req);
      const mode = b.mode;
      const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : null;
      if (mode !== 'root' && mode !== 'subdomain' && mode !== 'path') throw new AccountError(`Choose a subdomain, a folder of ${domain}, or the whole site.`, 400);
      if (mode !== 'root') {
        const { folders } = await helper<{ folders: { name: string }[] }>({ op: 'list', actor: a.user.username });
        if (name && folders.some((f) => f.name.toLowerCase() === name)) {
          throw new AccountError(`You have a folder called "${name}", and ${mode === 'subdomain' ? `${name}.${domain}` : `${domain}/${name}/`} shows it. Pick another name, or move or rename the folder first.`, 409);
        }
      }
      const to = mode === 'root' ? { mode } : { mode, name };
      const r = await software<{ job: unknown }>({ op: 'move', id, to, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-move', id, mode === 'root' ? `to the whole of ${domain}` : mode === 'subdomain' ? `to ${name}.${domain}` : `to ${domain}/${name}/`);
      return r;
    });

    // ---------------------------------------------------------------- phase 4b: install a new WordPress (passkey, G2)
    // Her folders again: an address that would hide one is refused here.
    app.post('/api/software/install', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const b = body(req);
      const p = (b.placement ?? {}) as { mode?: unknown; name?: unknown };
      const name = typeof p.name === 'string' ? p.name.trim().toLowerCase() : null;
      if ((p.mode === 'subdomain' || p.mode === 'path') && name) {
        const { folders } = await helper<{ folders: { name: string }[] }>({ op: 'list', actor: a.user.username });
        if (folders.some((f) => f.name.toLowerCase() === name)) {
          throw new AccountError(`You have a folder called "${name}", and ${p.mode === 'subdomain' ? `${name}.${domain}` : `${domain}/${name}/`} shows it. Pick another name.`, 409);
        }
      }
      const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().toLowerCase() : name;
      const r = await software<{ job: unknown; id: string }>({
        op: 'install', id, placement: { mode: p.mode, name }, title: b.title, adminUser: b.adminUser, adminEmail: b.adminEmail, actor: a.user.username,
      });
      await logActivity(db, now(), actorOf(a, req), 'software-install', r.id,
        p.mode === 'root' ? `as the whole of ${domain}` : p.mode === 'off' ? 'not at any address yet' : p.mode === 'subdomain' ? `at ${name}.${domain}` : `at ${domain}/${name}/`);
      return r;
    });

    // ---------------------------------------------------------------- phase 4c: delete, restore, for good
    // Deleting asks for a fresh passkey and its name typed out; so does deleting
    // for good. Restoring loses nothing, and asks for neither.
    const typed = (req: FastifyRequest, id: string) => {
      if (body(req).confirm !== id) throw new AccountError(`Type its name, "${id}", to delete it.`, 400);
    };
    app.post('/api/software/:id/delete', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idOf(req);
      typed(req, id);
      const r = await software<{ job: { op: string } }>({ op: 'delete', id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), r.job.op === 'purge' ? 'software-purge' : 'software-delete', id, r.job.op === 'purge' ? 'its install had not finished' : null);
      return r;
    });
    app.post('/api/software/:id/undelete', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const id = idOf(req);
      const r = await software<{ job: unknown }>({ op: 'undelete', id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-undelete', id, null);
      return r;
    });
    app.post('/api/software/:id/purge', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idOf(req);
      typed(req, id);
      const r = await software<{ job: unknown }>({ op: 'purge', id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'software-purge', id, null);
      return r;
    });

    // A new install's admin password, once: the helper forgets it as it hands it
    // over. A POST, so no HEAD or prefetch can use it up.
    app.post('/api/software/:id/login', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      reply.header('Cache-Control', 'no-store');
      return { login: await software({ op: 'install-login', id: idOf(req), actor: a.user.username }) };
    });

    // ---------------------------------------------------------------- phase 2: its complaints
    app.get('/api/software/:id/logs', { config: { needs: 'software' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return software({ op: 'logs', id: idOf(req), actor: a.user.username });
    });
}
