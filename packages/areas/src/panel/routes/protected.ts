// Protected folders and who may open them (docs/pammy-panel-design,
// docs/forms-plan.md). The people themselves are @panel/people's, the requests
// @panel/requests' (docs/roles-plan.md step 1).
//
// Who may open what lives in the gate (pammy-gate); the marker file and the
// starter sign-in pages are written by the website folder helper (as pamela).
import type { FastifyInstance } from 'fastify';
import { type GateState } from '@panel/core/panel/gate-shapes';
import { AccountError, logActivity } from '@panel/core/accounts';
import type { PanelCtx } from '@panel/core/panel/context';
import { inPlaces, keptTo } from '@panel/core/panel/rights';
import { visitorRules } from '../visitors.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, idParam, actorOf, gate, helper } = ctx;
  const { mineOf, seesPerson, minePerson, myArea, seenPerson } = visitorRules(ctx);

    // ---------------------------------------------------------------- protected folders and the people who can open them
    // Who may open what lives in the gate (pammy-gate); the marker file and the
    // starter sign-in pages are written by the website folder helper (as pamela).
    type Markers = {
      found: { path: string; token: string | null; hasLogin: boolean; pages: string[]; hasIndex: boolean }[];
      status: { path: string; exists: boolean; hasLogin: boolean; pages: string[]; hasIndex: boolean; marker: string | null }[];
    };

    app.get('/api/folders', { config: { needs: 'files', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return { folders: await helper<string[]>({ op: 'dirs', actor: a.user.username }) };
    });

    app.get('/api/protected', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      // (a route's area isn't a folder: the Hosts page has it, docs/roles-plan.md step 5)
      const folderAreas = m.areas.filter((x) => x.kind !== 'route');
      const mk = await helper<Markers>({ op: 'markers', paths: folderAreas.map((x) => x.path), actor: a.user.username });
      const areas = [];
      for (const area of folderAreas) {
        let status = mk.status.find((x) => x.path === area.path);
        const copies = mk.found.filter((f) => f.token === area.token);
        // She renamed the folder in WinSCP: the marker moved, so follow it.
        if (copies.length === 1 && copies[0]!.path !== area.path && status?.marker !== area.token) {
          const from = area.path;
          try {
            await gate({ op: 'area.move', id: area.id, path: copies[0]!.path, actor: a.user.username });
            area.path = copies[0]!.path;
            await logActivity(db, now(), { id: null, label: 'automatic', ip: null }, 'protection-followed', area.path, `folder was renamed from "${from}"`);
            status = { path: area.path, exists: true, hasLogin: copies[0]!.hasLogin, pages: copies[0]!.pages, hasIndex: copies[0]!.hasIndex, marker: area.token };
          } catch { /* leave it; the database path still protects */ }
        }
        // The marker was deleted but the folder is still there: put it back
        // (only the marker: sign-in pages she deleted stay deleted).
        if (copies.length === 0 && status?.exists) {
          try {
            await helper({ op: 'protect', path: area.path, token: area.token, pages: false, actor: 'automatic repair' });
            copies.push({ path: area.path, token: area.token, hasLogin: status.hasLogin, pages: status.pages, hasIndex: status.hasIndex });
          } catch { /* still protected by the database path */ }
        }
        areas.push({
          id: area.id, path: area.path, createdAt: area.createdAt, visitors: area.visitors, requestsOpen: area.requestsOpen,
          exists: !!status?.exists || copies.length > 0,
          hasLogin: status?.exists ? status.hasLogin : copies[0]?.hasLogin ?? false,
          pages: status?.exists ? status.pages : copies[0]?.pages ?? [],
          hasIndex: status?.exists ? status.hasIndex : copies[0]?.hasIndex ?? false,
          copies: copies.map((c) => c.path).filter((p) => p !== area.path),
        });
      }
      const known = new Set(st.areas.map((x) => x.token));
      const locked = mk.found.filter((f) => (!f.token || !known.has(f.token)) && inPlaces(m.places, f.path)).map((f) => f.path);
      // the folders there are to protect, and the names the server keeps (for the
      // addresses): here, so the page needs neither Files nor Subdomains
      const dirs = await helper<string[]>({ op: 'dirs', actor: a.user.username });
      const { reserved } = await helper<{ reserved: string[] }>({ op: 'list', actor: a.user.username });
      // the roles switch (docs/roles-plan.md step 4): on, each folder links to its Access page
      const { switches } = await gate<{ switches: { roles: boolean } }>({ op: 'visitor-settings.get' });
      return {
        areas, visitors: st.visitors.filter((v) => seesPerson(m, v)).map((v) => ({ ...v, areas: v.areas.filter((id) => m.places === null || m.ids.has(id)), whole: minePerson(m, v) })),
        locked, folders: dirs.filter((d) => inPlaces(m.places, d)), reserved, rolesOn: switches.roles,
      };
    });

    app.post('/api/protected', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const path = typeof body(req).path === 'string' ? (body(req).path as string).trim().replace(/^\/+|\/+$/g, '') : '';
      if (!inPlaces(keptTo(a.user), path)) throw new AccountError('Not found.', 404);
      const created = await gate<{ id: number; token: string; path: string }>({ op: 'area.create', path, actor: a.user.username });
      let result: { path: string; loginCreated: boolean; created: string[] };
      try {
        result = await helper({ op: 'protect', path: created.path, token: created.token, actor: a.user.username });
      } catch (e) {
        await gate({ op: 'area.delete', id: created.id, actor: a.user.username }).catch(() => {});
        throw e;
      }
      await logActivity(db, now(), actorOf(a, req), 'folder-protected', created.path,
        result.created.length ? `starter pages added: ${result.created.join(', ')}` : 'using its own sign-in pages');
      return { ok: true, id: created.id, path: created.path, loginCreated: result.loginCreated, created: result.created };
    });

    // Put starter copies of any missing sign-in pages into a protected folder.
    app.post('/api/protected/:id/pages', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const area = myArea(mineOf(a, st), st, idParam(req, 'id'));
      const r = await helper<{ created: string[] }>({ op: 'protect', path: area.path, token: area.token, actor: a.user.username });
      if (r.created.length) await logActivity(db, now(), actorOf(a, req), 'signin-pages-added', area.path, r.created.join(', '));
      return { ok: true, created: r.created };
    });

    app.post('/api/protected/:id/requests', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const area = myArea(mineOf(a, st), st, idParam(req, 'id'));
      const open = body(req).open === true;
      await gate({ op: 'area.requests', id: area.id, open, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), open ? 'requests-opened' : 'requests-closed', area.path, null);
      return { ok: true };
    });

    app.post('/api/protected/:id/unprotect', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const area = myArea(mineOf(a, st), st, idParam(req, 'id'));
      const mk = await helper<Markers>({ op: 'markers', paths: [area.path], actor: a.user.username });
      const places = new Set([area.path, ...mk.found.filter((f) => f.token === area.token).map((f) => f.path)]);
      for (const path of places) await helper({ op: 'unprotect', path, token: area.token, actor: a.user.username });
      await gate({ op: 'area.delete', id: area.id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'folder-unprotected', area.path, 'anyone can open it again');
      return { ok: true };
    });

    app.post('/api/protected/:id/access', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const st = await gate<GateState>({ op: 'state' });
      const area = myArea(mineOf(a, st), st, idParam(req, 'id'));
      const visitor = seenPerson(mineOf(a, st), st, Number(b.visitorId));
      await gate({ op: 'grant', visitorId: visitor.id, areaId: area.id, allow: b.allow === true, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), b.allow === true ? 'access-granted' : 'access-removed', area.path, visitor.username);
      return { ok: true };
    });
}
