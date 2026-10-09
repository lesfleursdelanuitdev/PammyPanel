// The gate's own data (schema gate in Postgres, db/migrations/0003-gate.sql), what is
// still in the kernel while it splits into areas, people and requests (docs/k-a-plan.md):
// protected folders ("areas"), who may open what, and the requests people send. People's
// part (visitors, links, sign-in checks, their own accounts, session rows) is in
// @panel/people since K-a4. Only the gate's role can reach it; the panel changes it only
// through the gate's admin socket (admin.ts), which re-checks everything.
import { randomBytes } from 'node:crypto';
import { all, one, run, tx, type Db } from '../pg.ts';
import { cleanAreaPath } from '../names.ts';
import { cleanLine, cleanMessage, GateError } from './ops.ts';
import type { Area, AreaRole, Visitor } from './types.ts';

// the row types live in types.ts until C6-min / K-b (docs/k-a-plan.md KA-Q5)
export type { Area, AreaRole, Visitor } from './types.ts';

// the gate-op kit stays in the kernel (ops.ts); its names stay here too until K-a ends (docs/k-a-plan.md)
export { cleanBy, cleanLine, cleanMessage, GateError, int, logEvent } from './ops.ts';

export { AREA_TOKEN_RE, cleanAreaPath, MARKER } from '../names.ts';
// Visitor usernames: what people type to sign in. An email address works too.
// People's (@panel/people/gate/accounts-store re-exports these, the same objects); here
// until requests' store moves (K-a5), as addResetRequest cleans the username with it.
export const VISITOR_NAME_RE = /^[a-z0-9][a-z0-9._@+-]{1,63}$/;

// Public request forms: caps so a flood can't bury real requests or fill the disk.
export const MAX_OPEN_REQUESTS_PER_FOLDER = 50;
export const MAX_OPEN_REQUESTS = 300;

export type Request = {
  id: number; kind: 'access' | 'reset'; area_id: number | null; visitor_id: number | null;
  name: string; contact: string; message: string; host: string | null; ip: string | null;
  created_at: number; status: 'open' | 'done' | 'declined'; handled_at: number | null; handled_by: string | null;
};

export function cleanVisitorName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return VISITOR_NAME_RE.test(s) ? s : null;
}

// ------------------------------------------------------------------ areas
// Deciding who gets through reads the areas from memory (live.ts); these are
// for changing them, and for the admin socket's answers.
export const areaByToken = (db: Db, token: string) => one<Area>(db, 'SELECT * FROM areas WHERE token = ?', token);
export const areaByPath = (db: Db, path: string) => one<Area>(db, "SELECT * FROM areas WHERE path = ? AND kind = 'folder'", path);
export const areaById = (db: Db, id: number) => one<Area>(db, 'SELECT * FROM areas WHERE id = ?', id);

export async function createArea(db: Db, now: number, path: unknown): Promise<Area> {
  const p = cleanAreaPath(path);
  if (!p) throw new GateError('invalid', "That isn't a folder in your website.");
  return tx(db, async (q) => {
    if (await areaByPath(q, p)) throw new GateError('exists', 'That folder is already protected.');
    return (await one<Area>(q, 'INSERT INTO areas (token, path, created_at) VALUES (?, ?, ?) RETURNING *', randomBytes(24).toString('base64url'), p, now))!;
  });
}

export async function moveArea(db: Db, id: unknown, path: unknown): Promise<Area> {
  return tx(db, async (q) => {
    const a = typeof id === 'number' ? await areaById(q, id) : undefined;
    const p = cleanAreaPath(path);
    if (!a || a.kind === 'route') throw new GateError('not-found', 'That protected folder no longer exists.');
    if (!p) throw new GateError('invalid', "That isn't a folder in your website.");
    const other = await areaByPath(q, p);
    if (other && other.id !== a.id) throw new GateError('exists', 'Another protection already uses that folder.');
    return (await one<Area>(q, 'UPDATE areas SET path = ? WHERE id = ? RETURNING *', p, a.id))!;
  });
}

export async function setRequestsOpen(db: Db, id: unknown, open: unknown): Promise<Area> {
  const a = typeof id === 'number' ? await areaById(db, id) : undefined;
  if (!a) throw new GateError('not-found', 'That protected folder no longer exists.');
  if (typeof open !== 'boolean') throw new GateError('invalid', 'Expected on or off.');
  const r = await one<Area>(db, 'UPDATE areas SET requests_open = ? WHERE id = ? RETURNING *', open ? 1 : 0, a.id);
  if (!r) throw new GateError('not-found', 'That protected folder no longer exists.');
  return r;
}

export async function deleteArea(db: Db, id: unknown): Promise<void> {
  // (a route's area goes with the route's accounts: route-areas.ts)
  if (!await run(db, "DELETE FROM areas WHERE id = ? AND kind = 'folder'", typeof id === 'number' ? id : -1)) {
    throw new GateError('not-found', 'That protected folder no longer exists.');
  }
}

// ------------------------------------------------------------------ roles
// Who may do what in an area (docs/roles-plan.md): the role given there, or the
// area's role set's "signed in, no role given" slot, and that role's privileges:
// its own and its groups'.
// pages.read is opening the area's pages at all.
export const PAGES_READ = 'pages.read';

// Every area where the visitor has a role (one area only, with areaId).
export async function rolesOf(db: Db, visitorId: number, areaId?: number): Promise<Map<number, AreaRole>> {
  const rows = await all<{ area_id: number; role: string; privileges: string }>(db,
    `SELECT a.id AS area_id, r.label AS role, coalesce(string_agg(p.privilege, ' ' ORDER BY p.privilege), '') AS privileges
       FROM areas a JOIN role_sets s ON s.id = a.role_set_id
       LEFT JOIN memberships m ON m.area_id = a.id AND m.visitor_id = ?
       JOIN roles r ON r.id = coalesce(m.role_id, s.signed_in_role_id)
       LEFT JOIN role_all_privileges p ON p.role_id = r.id
      WHERE ? OR a.id = ?
      GROUP BY a.id, r.id`, visitorId, areaId === undefined, areaId ?? 0);
  return new Map(rows.map((r) => [r.area_id, { role: r.role, privileges: new Set(r.privileges.split(' ').filter(Boolean)) }]));
}

// Their role opens the pages, or the area is open to anyone (its not-signed-in slot).
export const opensArea = async (db: Db, visitorId: number, areaId: number) =>
  !!(await rolesOf(db, visitorId, areaId)).get(areaId)?.privileges.has(PAGES_READ)
  || !!await one(db, "SELECT 1 FROM areas a JOIN roles r ON r.role_set_id = a.role_set_id AND r.slot = 'not-signed-in' JOIN role_all_privileges p ON p.role_id = r.id AND p.privilege = ? WHERE a.id = ?", PAGES_READ, areaId);

export const guestPrivileges = (a: Pick<Area, 'guest_privileges'>): ReadonlySet<string> => new Set((a.guest_privileges ?? '').split(' ').filter(Boolean));
export const openToAll = (a: Pick<Area, 'guest_privileges'>) => guestPrivileges(a).has(PAGES_READ);

// The protected folders' yes/no (the panel's "may open"): yes gives the area's
// Member role, unless they hold a role there already; no takes their role away.
// (it reads the visitor itself: the visitors are people's, docs/k-a-plan.md K-a4 and K-a6)
export async function setMember(db: Db, now: number, visitorId: unknown, areaId: unknown, allow: unknown): Promise<void> {
  const v = typeof visitorId === 'number' ? await one<Visitor>(db, 'SELECT * FROM visitors WHERE id = ?', visitorId) : undefined;
  if (!v) throw new GateError('not-found', 'That person no longer exists.');
  const a = typeof areaId === 'number' ? await areaById(db, areaId) : undefined;
  if (!a) throw new GateError('not-found', 'That protected folder no longer exists.');
  if (typeof allow !== 'boolean') throw new GateError('invalid', 'Expected allow true or false.');
  if (!allow) {
    await run(db, 'DELETE FROM memberships WHERE visitor_id = ? AND area_id = ?', v.id, a.id);
    return;
  }
  const member = await one<{ id: number }>(db, "SELECT id FROM roles WHERE role_set_id = ? AND key = 'member'", a.role_set_id);
  if (!member) throw new GateError('invalid', "This folder's roles have no Member.");
  await run(db, 'INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    v.id, a.id, a.role_set_id, member.id, now);
}

// ------------------------------------------------------------------ requests
export const requestById = async (db: Db, id: unknown) =>
  typeof id === 'number' ? one<Request>(db, 'SELECT * FROM requests WHERE id = ?', id) : undefined;

const countOf = async (db: Db, sql: string, ...args: (number | string)[]) => (await one<{ n: number }>(db, sql, ...args))!.n;

export async function addAccessRequest(db: Db, now: number, area: Area, form: { name: unknown; contact: unknown; message: unknown }, host: string, ip: string | null): Promise<Request> {
  if (!area.requests_open) throw new GateError('closed', "This folder isn't taking requests at the moment.");
  const name = cleanLine(form.name, 60);
  const contact = cleanLine(form.contact, 120);
  const message = cleanMessage(form.message, 1000);
  if (!name) throw new GateError('invalid', 'Please type your name.');
  if (!contact) throw new GateError('invalid', 'Please say how to reach you.');
  return tx(db, async (q) => {
    // the same person asking again updates their request instead of adding another
    const same = await one<{ id: number }>(q, "SELECT id FROM requests WHERE kind = 'access' AND status = 'open' AND area_id = ? AND lower(name) = lower(?) AND lower(contact) = lower(?)",
      area.id, name, contact);
    if (same) return (await one<Request>(q, 'UPDATE requests SET message = ?, created_at = ?, host = ?, ip = ? WHERE id = ? RETURNING *', message, now, host, ip, same.id))!;
    if (await countOf(q, "SELECT count(*) AS n FROM requests WHERE status = 'open' AND area_id = ?", area.id) >= MAX_OPEN_REQUESTS_PER_FOLDER
      || await countOf(q, "SELECT count(*) AS n FROM requests WHERE status = 'open'") >= MAX_OPEN_REQUESTS) {
      throw new GateError('full', "Too many requests are waiting already. Please try again in a few days.");
    }
    return (await one<Request>(q, "INSERT INTO requests (kind, area_id, name, contact, message, host, ip, created_at) VALUES ('access', ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      area.id, name, contact, message, host, ip, now))!;
  });
}

// Only recorded when the username exists; the visitor sees the same answer either way.
export async function addResetRequest(db: Db, now: number, area: Area | null, username: unknown, message: unknown, host: string, ip: string | null): Promise<Request | null> {
  const u = cleanVisitorName(username);
  const v = u ? await one<Visitor>(db, 'SELECT * FROM visitors WHERE username = ?', u) : undefined;
  if (!v) return null;
  const text = cleanMessage(message, 1000);
  return tx(db, async (q) => {
    const open = await one<{ id: number }>(q, "SELECT id FROM requests WHERE kind = 'reset' AND status = 'open' AND visitor_id = ?", v.id);
    if (open) {
      return (await one<Request>(q, 'UPDATE requests SET message = ?, area_id = ?, created_at = ?, host = ?, ip = ? WHERE id = ? RETURNING *',
        text, area?.id ?? null, now, host, ip, open.id))!;
    }
    if (await countOf(q, "SELECT count(*) AS n FROM requests WHERE status = 'open'") >= MAX_OPEN_REQUESTS) return null;
    return (await one<Request>(q, "INSERT INTO requests (kind, area_id, visitor_id, name, contact, message, host, ip, created_at) VALUES ('reset', ?, ?, ?, '', ?, ?, ?, ?) RETURNING *",
      area?.id ?? null, v.id, v.username, text, host, ip, now))!;
  });
}

export async function resolveRequest(db: Db, now: number, id: unknown, status: unknown, by: unknown): Promise<Request> {
  return tx(db, async (q) => {
    const r = await requestById(q, id);
    if (!r) throw new GateError('not-found', 'That request is no longer there.');
    if (status !== 'done' && status !== 'declined') throw new GateError('invalid', 'Expected done or declined.');
    if (r.status !== 'open') throw new GateError('exists', 'That request has already been dealt with.');
    return (await one<Request>(q, 'UPDATE requests SET status = ?, handled_at = ?, handled_by = ? WHERE id = ? RETURNING *', status, now, cleanLine(by, 40) || null, r.id))!;
  });
}

export async function deleteRequest(db: Db, id: unknown): Promise<void> {
  if (!await run(db, 'DELETE FROM requests WHERE id = ?', typeof id === 'number' ? id : -1)) {
    throw new GateError('not-found', 'That request is no longer there.');
  }
}

// People's socket (docs/k-a-plan.md KA-Q2, @panel/people/gate/reset-requests): a password
// chosen with a link closes that person's open "forgot my password" requests, in the
// transaction that sets it. The gate host hands this (and addResetRequest) to people.
export const closeResetRequests = (q: Db, visitorId: number, now: number) =>
  run(q, "UPDATE requests SET status = 'done', handled_at = ?, handled_by = 'they chose a new password' WHERE kind = 'reset' AND visitor_id = ? AND status = 'open'",
    now, visitorId);

// Requests' part of the gate's hourly clean-up (until K-a5 moves it to requests): handled
// requests after 180 days. People's part is peopleHousekeeping, the event log's
// eventsHousekeeping (ops.ts); the gate host calls the three (packages/gate/src/housekeeping.ts).
export async function housekeeping(db: Db, now: number) {
  await run(db, "DELETE FROM requests WHERE status != 'open' AND handled_at <= ?", now - 180 * 86400);
}
