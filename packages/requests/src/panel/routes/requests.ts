// Requests from the public pages: "please let me in" and "I forgot my password"
// (docs/forms-plan.md; docs/roles-plan.md step 1: the Requests module).
// Nothing is sent to anyone automatically: approving gives Pamela a link to send.
import type { FastifyInstance } from 'fastify';
import { type GateRequest, type GateState, type GateVisitor } from '@panel/core/panel/gate-shapes';
import { AccountError, logActivity } from '@panel/core/accounts';
import type { PanelCtx } from '@panel/core/panel/context';
import { visitorRules, type Mine } from '@panel/areas/panel/visitors';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, idParam, actorOf, gate } = ctx;
  const { mineOf, seesPerson, seenPerson, wholePerson, makeLink, linkArea } = visitorRules(ctx);

    app.get('/api/requests', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      // with roles on, the roles each open request's area has to give (docs/roles-plan.md step 5, S5-7)
      const roles = await rolesToGive(st.requests.filter((r) => r.status === 'open' && r.kind === 'access' && myRequest(m, r)).map((r) => r.areaId));
      const view = (r: GateRequest) => {
        const v = r.visitorId === null ? undefined : st.visitors.find((x) => x.id === r.visitorId);
        const area = st.areas.find((x) => x.id === r.areaId);
        return {
          ...r, areaPath: area ? area.label ?? area.path : null,
          ...(r.status === 'open' && r.areaId !== null && roles.has(r.areaId) ? { roles: roles.get(r.areaId) } : {}),
          person: v ? { id: v.id, username: v.username, name: v.name, contact: v.contact, active: v.active, hasPassword: v.hasPassword } : null,
        };
      };
      return {
        open: st.requests.filter((r) => r.status === 'open' && myRequest(m, r)).map(view),
        recent: st.requests.filter((r) => r.status !== 'open' && myRequest(m, r)).sort((x, y) => (y.handledAt ?? 0) - (x.handledAt ?? 0)).slice(0, 50).map(view),
        visitors: st.visitors.filter((v) => seesPerson(m, v)).map((v) => ({ id: v.id, username: v.username, name: v.name })),
      };
    });

    // The named roles of each area (not the not-signed-in slot), where roles are on and
    // there is more than Member to choose from; off, approving gives Member as always.
    const rolesToGive = async (ids: (number | null)[]) => {
      const out = new Map<number, { id: number; key: string; label: string }[]>();
      const { switches } = await gate<{ switches: { roles: boolean } }>({ op: 'visitor-settings.get' });
      if (!switches.roles) return out;
      for (const id of new Set(ids.filter((x): x is number => x !== null))) {
        const st = await gate<{ roles: { id: number; key: string; label: string; slot: string | null }[] }>({ op: 'access.state', areaId: id }).catch(() => null);
        const named = st?.roles.filter((r) => !r.slot).map(({ id: rid, key, label }) => ({ id: rid, key, label })) ?? [];
        if (named.length > 1) out.set(id, named);
      }
      return out;
    };

    // a request is about one of their folders; one about no folder is the whole site's
    const myRequest = (m: Mine, r: GateRequest) => m.places === null || (r.areaId !== null && m.ids.has(r.areaId));
    const openRequest = (m: Mine, st: GateState, id: number) => {
      const r = st.requests.find((x) => x.id === id && myRequest(m, x));
      if (!r) throw new AccountError('That request is no longer there.', 404);
      if (r.status !== 'open') throw new AccountError('That request has already been dealt with.', 409);
      return r;
    };

    app.post('/api/requests/:id/approve', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      const r = openRequest(m, st, idParam(req, 'id'));
      const who = a.user.username;

      if (r.kind === 'reset') {
        const v = r.visitorId === null ? undefined : st.visitors.find((x) => x.id === r.visitorId);
        if (!v) throw new AccountError('That person no longer exists.', 404);
        wholePerson(m, st, v.id);
        const link = await makeLink(a, req, v.id, linkArea(v, r.areaId), 'after they said they forgot their password');
        await gate({ op: 'request.resolve', id: r.id, status: 'done', actor: who });
        return { ok: true, username: v.username, contact: v.contact, link };
      }

      const area = st.areas.find((x) => x.id === r.areaId);
      if (!area) throw new AccountError('The folder they asked about is no longer protected. Decline the request, or protect the folder again first.', 409);
      const where = area.label ?? area.path;
      // the role they get (S5-7): one of the area's, checked by the gate; none said, Member
      const roleId = Number.isSafeInteger(b.roleId) ? b.roleId as number : null;
      if (b.roleId !== undefined && b.roleId !== null && roleId === null) throw new AccountError('Which role?', 400);
      // checked before anyone is made, so a role that isn't there leaves nothing behind
      if (roleId !== null) {
        const roles = (await rolesToGive([area.id])).get(area.id) ?? [];
        if (!roles.some((x) => x.id === roleId)) throw new AccountError('That role is no longer there.', 404);
      }
      let v: GateVisitor;
      let created = false;
      if (Number.isSafeInteger(b.visitorId)) {
        v = seenPerson(m, st, b.visitorId as number);
        if (!v.active) throw new AccountError(`${v.username} is switched off. Switch them on first (People tab).`, 409);
      } else {
        const made = await gate<GateVisitor>({
          op: 'visitor.create', username: b.username, name: typeof b.name === 'string' && b.name.trim() ? b.name : r.name.slice(0, 60),
          contact: r.contact, password: null, actor: who,
        });
        v = { ...made, contact: r.contact, linkExpiresAt: null, areas: [] };
        created = true;
        await logActivity(db, now(), actorOf(a, req), 'person-added', v.username, `from ${r.name}'s request`);
      }
      const given = roleId === null
        ? (await gate({ op: 'grant', visitorId: v.id, areaId: area.id, allow: true, actor: who }), null)
        : (await gate<{ role: string }>({ op: 'access.person', areaId: area.id, visitorId: v.id, roleId, actor: who })).role;
      await logActivity(db, now(), actorOf(a, req), 'request-approved', where,
        `${created ? v.username : `${r.name}, as ${v.username}`}${given ? `, role ${given}` : ''}`);
      // Someone who already has a password just signs in as usual; anyone else needs a link.
      const link = v.hasPassword ? null : await makeLink(a, req, v.id, area.id, 'to choose their password');
      await gate({ op: 'request.resolve', id: r.id, status: 'done', actor: who });
      return { ok: true, username: v.username, contact: r.contact, areaPath: where, role: given, link };
    });

    app.post('/api/requests/:id/decline', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const r = openRequest(mineOf(a, st), st, idParam(req, 'id'));
      await gate({ op: 'request.resolve', id: r.id, status: 'declined', actor: a.user.username });
      const found = st.areas.find((x) => x.id === r.areaId);
      const path = found ? found.label ?? found.path : null;
      await logActivity(db, now(), actorOf(a, req), r.kind === 'reset' ? 'reset-request-dismissed' : 'request-declined', r.name, path);
      return { ok: true };
    });

    // For junk: gone without a trace in the Requests list.
    app.post('/api/requests/:id/delete', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      const r = st.requests.find((x) => x.id === idParam(req, 'id') && myRequest(m, x));
      if (!r) throw new AccountError('That request is no longer there.', 404);
      await gate({ op: 'request.delete', id: r.id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'request-deleted', r.name, null);
      return { ok: true };
    });
}
