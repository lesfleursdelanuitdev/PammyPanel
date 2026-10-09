// Accounts on a route (docs/roles-plan.md step 5, S5-1 to S5-3): the gate's
// side. The hosts module keeps the route and asks through the admin socket
// (route-area.set); the gate keeps the area, its role set and its people, and
// answers with the area's token, which the route keeps so nginx can name it.
//
//   open     "Open with accounts": anyone may use it; the app is told who is
//            signed in. Needs the "Open with accounts" switch (Settings, Visitors).
//   private  "Only people let in": the Protected folder set, as a folder's.
//   null     no accounts: the area goes, and with it everyone's role there.
//
// Going from one to the other keeps people's roles by key (Member stays Member).
// An area on roles of its own (a copy, or an app's) is put back first, on the
// Access page: nothing here changes roles it can't show.
import { randomBytes } from 'node:crypto';
import { type Area } from '@panel/core/gate/store';
import { GateError } from '@panel/core/gate/ops';
import { readVisitorSettings } from '@panel/core/gate/visitor-settings';
import { all, one, run, tx, type Db } from '@panel/core/pg';

export const ROUTE_ACCOUNTS = { open: 'open-with-accounts', private: 'protected-folder' } as const;
export type RouteAccounts = keyof typeof ROUTE_ACCOUNTS;
export const isRouteAccounts = (v: unknown): v is RouteAccounts => v === 'open' || v === 'private';

const routeId = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new GateError('invalid', 'Which route?');
  return v;
};
// the route's address, as the panel's lists show it
const label = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-z0-9.:/_~-]{1,300}$/i.test(v)) throw new GateError('invalid', "The route's address isn't one.");
  return v;
};

export const routeArea = (db: Db, id: number) => one<Area>(db, "SELECT * FROM areas WHERE kind = 'route' AND route_id = ?", id);

export type RouteAreaAnswer = { token: string | null; areaId: number | null; accounts: RouteAccounts | null; lost: string[] };

export async function setRouteArea(db: Db, now: number, rid: unknown, accounts: unknown, address: unknown): Promise<RouteAreaAnswer> {
  const id = routeId(rid);
  if (accounts !== null && !isRouteAccounts(accounts)) throw new GateError('invalid', 'Accounts are open, private, or none.');
  const where = accounts === null ? null : label(address);
  if (accounts === 'open' && !(await readVisitorSettings(db)).switches.openAreas) {
    throw new GateError('invalid', '"Open with accounts" is switched off (Settings, Visitors).');
  }
  return tx(db, async (q) => {
    await run(q, 'SET CONSTRAINTS ALL DEFERRED');
    const cur = await one<Area & { set_key: string | null }>(q,
      "SELECT a.*, s.key AS set_key FROM areas a JOIN role_sets s ON s.id = a.role_set_id WHERE a.kind = 'route' AND a.route_id = ? FOR UPDATE OF a", id);
    if (accounts === null) {
      if (!cur) return { token: null, areaId: null, accounts: null, lost: [] };
      const lost = await people(q, cur.id);
      // its own copy of a set goes with it (role_sets.area_id cascades from the area), and
      // so does its app's set, read from its pammy-panel.json (docs/roles-plan.md step 6)
      await run(q, 'DELETE FROM areas WHERE id = ?', cur.id);
      await run(q, 'DELETE FROM role_sets WHERE key = ?', `app-route-${cur.id}`);
      return { token: null, areaId: null, accounts: null, lost };
    }
    const to = (await one<{ id: number }>(q, 'SELECT id FROM role_sets WHERE key = ?', ROUTE_ACCOUNTS[accounts]))!.id;
    if (!cur) {
      const token = randomBytes(24).toString('base64url');
      const a = (await one<Area>(q,
        "INSERT INTO areas (token, path, created_at, kind, route_id, label, role_set_id) VALUES (?, ?, ?, 'route', ?, ?, ?) RETURNING *",
        token, `/route/${id}`, now, id, where, to))!;
      return { token: a.token, areaId: a.id, accounts, lost: [] };
    }
    if (cur.role_set_id !== to) {
      if (cur.set_key?.startsWith('app-')) {
        throw new GateError('invalid', "This route's roles come from its app's pammy-panel.json. To leave them, set it to Open to anyone (everyone's role there goes).");
      }
      if (cur.set_key !== ROUTE_ACCOUNTS.open && cur.set_key !== ROUTE_ACCOUNTS.private) {
        throw new GateError('invalid', 'This route has roles of its own: put it back on the built-in roles first (Access, Roles).');
      }
      // people keep a role of the same key (Member stays Member); nobody else is there
      const lost: string[] = [];
      for (const m of await all<{ visitor_id: number; key: string; username: string }>(q,
        'SELECT m.visitor_id, r.key, v.username FROM memberships m JOIN roles r ON r.id = m.role_id JOIN visitors v ON v.id = m.visitor_id WHERE m.area_id = ? ORDER BY v.username', cur.id)) {
        const same = await one<{ id: number }>(q, 'SELECT id FROM roles WHERE role_set_id = ? AND key = ? AND slot IS NULL', to, m.key);
        if (same) await run(q, 'UPDATE memberships SET role_set_id = ?, role_id = ? WHERE visitor_id = ? AND area_id = ?', to, same.id, m.visitor_id, cur.id);
        else { lost.push(m.username); await run(q, 'DELETE FROM memberships WHERE visitor_id = ? AND area_id = ?', m.visitor_id, cur.id); }
      }
      await run(q, 'UPDATE areas SET role_set_id = ?, label = ? WHERE id = ?', to, where, cur.id);
      return { token: cur.token, areaId: cur.id, accounts, lost };
    }
    if (cur.label !== where) await run(q, 'UPDATE areas SET label = ? WHERE id = ?', where, cur.id);
    return { token: cur.token, areaId: cur.id, accounts, lost: [] };
  });
}

// who holds a role there (and loses it with the area)
const people = async (db: Db, areaId: number) =>
  (await all<{ username: string }>(db, 'SELECT v.username FROM memberships m JOIN visitors v ON v.id = m.visitor_id WHERE m.area_id = ? ORDER BY v.username', areaId)).map((r) => r.username);
