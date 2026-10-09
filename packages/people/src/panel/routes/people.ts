// The people who can sign in (visitors), made and changed from the panel
// (docs/pammy-panel-design; docs/roles-plan.md step 1: the People module).
// Which protected folders they open is @panel/areas'.
import type { FastifyInstance } from 'fastify';
import { type GateArea, type GateState, type GateVisitor } from '@panel/core/panel/gate-shapes';
import { AccountError, logActivity } from '@panel/core/accounts';
import { type Authed } from '@panel/core/sessions';
import type { Body, PanelCtx } from '@panel/core/panel/context';
import { visitorRules } from '@panel/areas/panel/visitors';
import { isOn } from '@panel/core/profile';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, idParam, actorOf, gate } = ctx;
  const { mineOf, wholePerson, makeLink, linkArea, seesPerson, minePerson } = visitorRules(ctx);

    // The People page's list: the gate's alone, so it works where there are no
    // protected folders (lfdln: accounts are on routes, and roles are given on each
    // route's Access page). The folders, for the "Can open" boxes, are only the
    // folder areas; a route's area isn't one.
    app.get('/api/people', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      // accounts deleted but not yet passed on to every app (docs/accounts-plan.md step 4b):
      // only where the panel passes them on (services), and only for whoever sees everyone
      const deletions = m.places === null && isOn(ctx.config.site, 'services')
        ? (await gate<{ deletions: { username: string; deleted_at: number; tries: number; last_error: string | null }[] }>({ op: 'deletions.list' })).deletions
          .map((d) => ({ username: d.username, deletedAt: d.deleted_at, tries: d.tries, lastError: d.last_error }))
        : [];
      return {
        deletions,
        areas: m.areas.filter((x) => x.kind !== 'route'),
        visitors: st.visitors.filter((v) => seesPerson(m, v)).map((v) => ({ ...v, areas: v.areas.filter((id) => m.places === null || m.ids.has(id)), whole: minePerson(m, v) })),
      };
    });

    app.post('/api/visitors', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      // No password: they choose their own with a setup link, made straight away.
      const withLink = b.password === undefined || b.password === null;
      const areaIds = Array.isArray(b.areaIds) ? b.areaIds.filter((x): x is number => Number.isSafeInteger(x)) : [];
      const st = await gate<GateState>({ op: 'state' });
      const m = mineOf(a, st);
      // someone kept to places adds people to their own folders, or they'd be
      // adding a person nobody but the whole site's people could see again
      if (m.places !== null && (!areaIds.length || areaIds.some((id) => !m.ids.has(id)))) {
        throw new AccountError('Choose at least one of your protected folders for them to open.', 400);
      }
      const v = await gate<GateVisitor>({
        op: 'visitor.create', username: b.username, name: b.name ?? '', contact: b.contact ?? '',
        password: withLink ? null : b.password, actor: a.user.username,
      });
      const opened: GateArea[] = [];
      for (const id of areaIds) {
        const area = st.areas.find((x) => x.id === id);
        if (!area) continue;
        await gate({ op: 'grant', visitorId: v.id, areaId: id, allow: true, actor: a.user.username });
        opened.push(area);
      }
      await logActivity(db, now(), actorOf(a, req), 'person-added', v.username, opened.length ? `can open ${opened.map((x) => x.path).join(', ')}` : null);
      const link = withLink ? await makeLink(a, req, v.id, opened[0]?.id ?? null, 'to choose their password') : null;
      return { ok: true, id: v.id, username: v.username, link };
    });

    app.post('/api/visitors/:id/link', { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const st = await gate<GateState>({ op: 'state' });
      const v = wholePerson(mineOf(a, st), st, idParam(req, 'id'));
      const areaId = Number.isSafeInteger(body(req).areaId) ? body(req).areaId as number : null;
      const link = await makeLink(a, req, v.id, linkArea(v, areaId), v.hasPassword ? 'to choose a new password' : 'to choose their password');
      return { ok: true, link };
    });

    const visitorRoute = (suffix: string, fresh: boolean, run: (a: Authed, v: GateVisitor, b: Body) => Promise<[string, string | null]>) =>
      app.post(`/api/visitors/:id/${suffix}`, { config: { needs: 'protected' } }, async (req, reply) => {
        const a = await need(req, reply, { fresh });
        if (!a) return reply;
        const st = await gate<GateState>({ op: 'state' });
        const v = wholePerson(mineOf(a, st), st, idParam(req, 'id'));
        const [action, detail] = await run(a, v, body(req));
        await logActivity(db, now(), actorOf(a, req), action, v.username, detail);
        return { ok: true };
      });

    visitorRoute('password', false, async (a, v, b) => {
      await gate({ op: 'visitor.password', id: v.id, password: b.password, actor: a.user.username });
      return ['person-password-changed', 'signed out everywhere'];
    });
    visitorRoute('active', false, async (a, v, b) => {
      await gate({ op: 'visitor.active', id: v.id, active: b.active === true, actor: a.user.username });
      return [b.active === true ? 'person-switched-on' : 'person-switched-off', null];
    });
    visitorRoute('rename', false, async (a, v, b) => {
      await gate({ op: 'visitor.rename', id: v.id, name: b.name ?? '', actor: a.user.username });
      return ['person-renamed', typeof b.name === 'string' && b.name ? `now "${b.name.slice(0, 60)}"` : null];
    });
    visitorRoute('contact', false, async (a, v, b) => {
      await gate({ op: 'visitor.contact', id: v.id, contact: b.contact ?? '', actor: a.user.username });
      return ['person-contact-changed', null];
    });
    visitorRoute('link/cancel', false, async (a, v) => {
      await gate({ op: 'link.cancel', visitorId: v.id, actor: a.user.username });
      return ['person-link-cancelled', null];
    });
    visitorRoute('signout', false, async (a, v) => {
      await gate({ op: 'visitor.signout', id: v.id, actor: a.user.username });
      return ['person-signed-out', null];
    });
    visitorRoute('delete', true, async (a, v) => {
      await gate({ op: 'visitor.delete', id: v.id, actor: a.user.username });
      return ['person-removed', null];
    });
    // emailed by the gate to the address the account has (docs/accounts-plan.md step 4):
    // the owner never learns or sets the password of an account someone made
    visitorRoute('send-reset', false, async (a, v) => {
      await gate({ op: 'visitor.send-reset', id: v.id, actor: a.user.username });
      return ['person-reset-link-sent', null];
    });
    visitorRoute('resend-confirm', false, async (a, v) => {
      await gate({ op: 'visitor.resend-confirm', id: v.id, actor: a.user.username });
      return ['person-confirm-link-sent', null];
    });
}
