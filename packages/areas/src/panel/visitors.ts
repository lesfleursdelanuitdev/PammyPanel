// What a panel account may see and change of protected folders and their
// people (docs/permissions-plan.md R5), and the setup links sent to people.
// Shared by the Protected folders, People and Requests routes (docs/roles-plan.md
// step 1: one module each, these rules in one place).
import type { FastifyRequest } from 'fastify';
import { areaOf, visitorOf, type GateArea, type GateLink, type GateState, type GateVisitor } from '@panel/core/panel/gate-shapes';
import { AccountError, logActivity } from '@panel/core/accounts';
import { type Authed } from '@panel/core/sessions';
import type { PanelCtx } from '@panel/core/panel/context';
import { inPlaces, keptTo } from '@panel/core/panel/rights';

export type Mine = { places: readonly string[] | null; areas: GateArea[]; ids: Set<number> };

export function visitorRules(ctx: PanelCtx) {
  const { db, now, actorOf, gate, dateOf } = ctx;

    // ---------------------------------------------------------------- a person kept to places (docs/permissions-plan.md R5)
    // They see the protected folders in their places, the requests about those
    // folders, and the people who can open one of them. Access to their folders
    // they give and take as anyone else does; but a person (visitor) is one
    // sign-in for the whole site, so changing the person themselves (a setup
    // link, their password, name, contact, switching them off, signing them out,
    // removing them) needs every folder they open to be in one of their places.
    // Anything else is answered as not there. Anyone with no places: all of it.
    const mineOf = (a: Authed, st: GateState): Mine => {
      const places = keptTo(a.user);
      const areas = st.areas.filter((x) => inPlaces(places, x.path));
      return { places, areas, ids: new Set(areas.map((x) => x.id)) };
    };
    const seesPerson = (m: Mine, v: GateVisitor) => m.places === null || v.areas.some((id) => m.ids.has(id));
    const minePerson = (m: Mine, v: GateVisitor) => m.places === null || v.areas.every((id) => m.ids.has(id));
    const myArea = (m: Mine, st: GateState, id: number) => {
      const area = areaOf(st, id);
      if (!m.ids.has(area.id)) throw new AccountError('That protected folder no longer exists.', 404);
      return area;
    };
    const seenPerson = (m: Mine, st: GateState, id: number) => {
      const v = visitorOf(st, id);
      if (!seesPerson(m, v)) throw new AccountError('That person no longer exists.', 404);
      return v;
    };
    const wholePerson = (m: Mine, st: GateState, id: number) => {
      const v = seenPerson(m, st, id);
      if (!minePerson(m, v)) throw new AccountError(`${v.username} can also open folders that aren't yours, so only someone who looks after the whole site can change them.`, 409);
      return v;
    };

    async function makeLink(a: Authed, req: FastifyRequest, visitorId: number, areaId: number | null, why: string) {
      const l = await gate<GateLink>({ op: 'link.create', visitorId, areaId, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'person-link-created', l.visitor.username, `${why}, valid until ${dateOf(l.expiresAt)}`);
      return { url: l.url, expiresAt: l.expiresAt, firstPassword: !l.visitor.hasPassword };
    }
    // A link opens the folder it's for: the one asked about, else their first.
    const linkArea = (v: GateVisitor, preferred: number | null) =>
      preferred !== null && v.areas.includes(preferred) ? preferred : v.areas[0] ?? null;

    return { mineOf, seesPerson, minePerson, myArea, seenPerson, wholePerson, makeLink, linkArea };
}
