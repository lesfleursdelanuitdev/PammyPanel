// The Access page (docs/roles-plan.md step 4): a protected folder's roles and
// privileges. The gate keeps them and checks every change (@panel/areas/gate/access);
// this adds who may ask (the "protected" right, and the folder in their places),
// the people they may see, the folder's pammy-panel.json for Read again, and
// Activity. With the roles switch off (Settings > Visitors) the gate refuses
// every change here, and the page is today's Protected folders page.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { callJsonLineRead } from '@panel/core/jsonline';
import type { GateArea, GateState } from '@panel/core/panel/gate-shapes';
import type { PanelCtx } from '@panel/core/panel/context';
import type { Authed } from '@panel/core/sessions';
import type { AccessState } from '../../gate/access.ts';
import { MANIFEST_FILE, MANIFEST_MAX_BYTES } from '../../manifest.ts';
import { visitorRules } from '../visitors.ts';

type Settings = { switches: { roles: boolean } };

// manifestOf: where a route's pammy-panel.json comes from (docs/roles-plan.md step 6,
// S6-3), for a site with hosts: its site folder's top, or its service's file. A
// folder's is at its own top, through the website folder helper.
export type ManifestOf = (area: GateArea, actor: string) => Promise<string>;

export function routes(app: FastifyInstance, ctx: PanelCtx, opts: { manifestOf?: ManifestOf } = {}) {
  const { db, now, need, body, idParam, actorOf, gate, config } = ctx;
  const { mineOf, seesPerson, myArea, seenPerson } = visitorRules(ctx);

  // the folder, if it's one of theirs
  const folder = async (a: Authed, req: FastifyRequest) => {
    const st = await gate<GateState>({ op: 'state' });
    const m = mineOf(a, st);
    return { st, m, area: myArea(m, st, idParam(req, 'id')) };
  };
  const roleName = (s: AccessState, id: unknown) => s.roles.find((r) => r.id === id)?.label ?? 'no role';

  app.get('/api/access/:id', { config: { needs: 'protected' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { st, m, area } = await folder(a, req);
    const [access, settings] = await Promise.all([
      gate<AccessState>({ op: 'access.state', areaId: area.id }),
      gate<Settings>({ op: 'visitor-settings.get' }),
    ]);
    const people = st.visitors.filter((v) => seesPerson(m, v)).map((v) => ({ id: v.id, username: v.username, name: v.name, active: v.active }));
    return { ...access, rolesOn: settings.switches.roles, people };
  });

  // Each change: the gate's answer, and a line in Activity.
  const change = (path: string, op: string, what: (b: Record<string, unknown>, before: AccessState, after: unknown) => [string, string | null] | null) =>
    app.post(`/api/access/:id/${path}`, { config: { needs: 'protected' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const { st, m, area } = await folder(a, req);
      const b = body(req);
      if (op === 'access.person') seenPerson(m, st, Number(b.visitorId));
      const before = await gate<AccessState>({ op: 'access.state', areaId: area.id });
      const r = await gate<unknown>({ ...b, op, areaId: area.id, actor: a.user.username });
      const line = what(b, before, r);
      if (line) await logActivity(db, now(), actorOf(a, req), line[0], area.label ?? area.path, line[1]);
      return { ok: true, result: r };
    });

  change('copy', 'access.copy', (_b, before) => ['roles-copied', `from "${before.set.label}", to change them`]);
  change('reset', 'access.reset', (_b, before, r) => {
    const lost = (r as { lost: string[] }).lost;
    return ['roles-reset', `back to "${before.set.copiedFrom ?? 'Protected folder'}"${lost.length ? `; no role now: ${lost.join(', ')}` : ''}`];
  });
  change('resource', 'access.resource', (b) => ['privileges-changed', `resource ${String(b.key)}: ${Array.isArray(b.actions) ? b.actions.join(', ') : ''}${b.owned === true ? ' (own or any)' : ''}`]);
  change('resource-delete', 'access.resource.delete', (b) => ['privileges-changed', `resource ${String(b.key)} removed`]);
  change('group', 'access.group', (b) => ['group-saved', `"${String(b.label)}": ${Array.isArray(b.privileges) ? b.privileges.join(' ') || 'nothing' : ''}`]);
  change('group-delete', 'access.group.delete', (_b, _s, r) => ['group-removed', `"${(r as { label: string }).label}"`]);
  change('role', 'access.role', (b, before) => ['role-saved', `"${typeof b.label === 'string' ? b.label : roleName(before, b.id)}"`]);
  change('role-delete', 'access.role.delete', (_b, _s, r) => {
    const x = r as { label: string; people: string[]; movedTo: string | null };
    return ['role-removed', `"${x.label}"${x.people.length ? `; ${x.people.join(', ')} ${x.movedTo ? `moved to "${x.movedTo}"` : 'now have no role'}` : ''}`];
  });
  change('signed-in', 'access.signed-in', (b, before) => ['roles-slot', `anyone signed in: ${b.roleId === null ? 'nothing' : `"${roleName(before, b.roleId)}"`}`]);
  change('never', 'access.never', (b, before) => ['roles-never', `"${roleName(before, b.a)}" and "${roleName(before, b.b)}": ${b.never === true ? 'never together' : 'may be combined'}`]);
  change('person', 'access.person', (_b, _s, r) => {
    const x = r as { username: string; role: string | null };
    return [x.role ? 'person-role' : 'person-role-removed', x.role ? `${x.username}: "${x.role}"` : x.username];
  });

  // Read again: the folder's own pammy-panel.json, through the website folder helper
  app.post('/api/access/:id/manifest', { config: { needs: 'protected' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const { area } = await folder(a, req);
    let text: string;
    if (area.kind === 'route') {
      if (!opts.manifestOf) throw new AccountError('This site has no routes.', 404);
      text = await opts.manifestOf(area, a.user.username);
    } else {
      text = await folderManifest(config.sitefsSocket, area.path, a.user.username);
    }
    const r = await gate<{ removedRoles: { label: string; people: string[] }[]; removedPrivileges: string[]; lost: string[]; created: boolean }>(
      { op: 'access.manifest', areaId: area.id, text, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'manifest-read', area.label ?? area.path, [
      r.created ? 'first read' : 'read again',
      r.removedPrivileges.length ? `privileges gone: ${r.removedPrivileges.join(' ')}` : '',
      r.removedRoles.length ? `roles gone: ${r.removedRoles.map((x) => x.label).join(', ')}` : '',
      r.lost.length ? `no role now: ${r.lost.join(', ')}` : '',
    ].filter(Boolean).join('; '));
    return { ok: true, result: r };
  });
}

// A folder's pammy-panel.json, at its top, through the website folder helper (the
// same helper, with the site folders as its root, serves lfdln's folder routes).
export async function folderManifest(socket: string, folderPath: string, actor: string): Promise<string> {
  try {
    const got = await callJsonLineRead<{ size: number }>(socket, { op: 'files-read', path: `${folderPath}/${MANIFEST_FILE}`, actor }, 'website folder helper');
    if (got.header.size > MANIFEST_MAX_BYTES) { got.bytes.destroy(); throw new AccountError(`${MANIFEST_FILE} is larger than ${MANIFEST_MAX_BYTES / 1024} KB.`, 413); }
    const parts: Buffer[] = [];
    for await (const c of got.bytes) parts.push(c as Buffer);
    const text = Buffer.concat(parts).toString('utf8');
    // (docs/catalog-plan.md step 5: only a service has somewhere the panel can read its list)
    if (offersCatalog(text)) throw new AccountError(`${MANIFEST_FILE} in "${folderPath}" has a "catalog" section, and only a service's can: a folder has nothing the panel could ask for its list of things to tag. Take the section out and read it again.`, 400);
    return text;
  } catch (e) {
    if (e instanceof AccountError) throw e;
    throw new AccountError(`There's no ${MANIFEST_FILE} at the top of "${folderPath}".`, 404);
  }
}

const offersCatalog = (text: string) => {
  try {
    const raw = JSON.parse(text) as unknown;
    return typeof raw === 'object' && raw !== null && 'catalog' in raw;
  } catch {
    return false;
  }
};
