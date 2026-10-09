// The Access page's side of the gate (docs/roles-plan.md step 4): an area's role
// set as the page shows it, and every change the page can make to it. The panel
// asks through the admin socket; every change is checked here.
//
// - A built-in set (Protected folder, or an app's from its pammy-panel.json) is
//   never changed in place (R4): "Copy to change" gives the area a copy of its
//   own, and "Back to the built-in roles" returns it, people matched by role key.
// - Resources and actions can be added only on an area whose set didn't come
//   from a manifest (R12): nothing would honour them otherwise.
// - Every privilege written is one the set declares: pages.read, and its
//   resources' actions (with :own/:any where they have an owner).
// - Nothing here changes anything unless the roles switch is on (Settings >
//   Visitors), except reading, and what the Protected folders page does today.
import { applyManifest, declaredPrivileges, MAX_PRIVILEGES, NOT_SIGNED_IN, type Resource } from '../manifest.ts';
import { PAGES_READ } from '@panel/core/gate/store';
import { GateError } from '@panel/core/gate/ops';
import { readVisitorSettings } from '@panel/core/gate/visitor-settings';
import { all, one, run, tx, type Db } from '@panel/core/pg';

const WORD = /^[a-z][a-z0-9-]{0,31}$/;
// a list as one parameter: JSON, unpacked by Postgres (pg.ts takes no arrays)
const IDS = '(SELECT jsonb_array_elements_text(?::text::jsonb)::bigint)';
const TEXTS = '(SELECT jsonb_array_elements_text(?::text::jsonb))';
const list = (v: readonly (string | number)[]) => JSON.stringify(v);
const CRUD = ['read', 'create', 'update', 'delete'];
const PROTECTED_FOLDER = 'protected-folder';

type SetRow = { id: number; key: string | null; label: string; built_in: boolean; area_id: number | null; copied_from: number | null; manifest: string | null; manifest_read_at: number | null; signed_in_role_id: number | null };
type RoleRow = { id: number; key: string; label: string; slot: string | null };

export type AccessState = {
  area: { id: number; path: string; kind: 'folder' | 'route' };
  set: { id: number; label: string; builtIn: boolean; key: string | null; copiedFrom: string | null; fromManifest: boolean; manifestReadAt: number | null };
  canEditRoles: boolean;           // its own copy
  canEditPrivileges: boolean;      // its own copy, and no manifest behind it (R12)
  resources: Resource[];
  actions: { key: string; label: string }[];
  privileges: string[];            // every key it declares
  groups: { id: number; key: string; label: string; privileges: string[] }[];
  roles: { id: number; key: string; label: string; slot: string | null; groups: number[]; privileges: string[]; parts: number[]; all: string[]; people: number }[];
  signedInRoleId: number | null;
  neverTogether: { a: number; b: number; fromManifest: boolean }[];
  members: { visitorId: number; roleId: number }[];
};

// ------------------------------------------------------------------ reading
const areaRow = async (db: Db, areaId: unknown) => {
  const a = typeof areaId === 'number' ? await one<{ id: number; path: string; role_set_id: number; kind: string }>(db, 'SELECT id, coalesce(label, path) AS path, role_set_id, kind FROM areas WHERE id = ?', areaId) : undefined;
  if (!a) throw new GateError('not-found', 'That protected folder no longer exists.');
  return a;
};
const setRow = async (db: Db, id: number) => (await one<SetRow>(db, 'SELECT * FROM role_sets WHERE id = ?', id))!;

async function resourcesOf(db: Db, setId: number): Promise<Resource[]> {
  const rows = await all<{ key: string; label: string; owned: boolean; actions: string | null }>(db,
    `SELECT r.key, r.label, r.owned, string_agg(a.action, ' ' ORDER BY a.action) AS actions
       FROM resources r LEFT JOIN resource_actions a ON a.resource_id = r.id WHERE r.role_set_id = ? GROUP BY r.id ORDER BY r.key`, setId);
  return rows.map((r) => ({ key: r.key, label: r.label, owned: r.owned, actions: (r.actions ?? '').split(' ').filter(Boolean) }));
}

export async function accessState(db: Db, areaId: unknown): Promise<AccessState> {
  const a = await areaRow(db, areaId);
  const s = await setRow(db, a.role_set_id);
  const resources = await resourcesOf(db, s.id);
  const actions = await all<{ key: string; label: string }>(db, 'SELECT key, label FROM actions WHERE role_set_id = ? ORDER BY key', s.id);
  const groups = await all<{ id: number; key: string; label: string; privileges: string | null }>(db,
    `SELECT g.id, g.key, g.label, string_agg(p.privilege, ' ' ORDER BY p.privilege) AS privileges
       FROM groups g LEFT JOIN group_privileges p ON p.group_id = g.id WHERE g.role_set_id = ? GROUP BY g.id ORDER BY g.label`, s.id);
  const roles = await all<RoleRow>(db, 'SELECT id, key, label, slot FROM roles WHERE role_set_id = ? ORDER BY slot NULLS LAST, label', s.id);
  const ids = roles.map((r) => r.id);
  const listOf = async (sql: string) => {
    const m = new Map<number, (string | number)[]>();
    for (const r of await all<{ role_id: number; v: string | number }>(db, sql, list(ids))) m.set(r.role_id, [...(m.get(r.role_id) ?? []), r.v]);
    return m;
  };
  const rg = await listOf(`SELECT role_id, group_id AS v FROM role_groups WHERE role_id IN ${IDS} ORDER BY group_id`);
  const rp = await listOf(`SELECT role_id, privilege AS v FROM role_privileges WHERE role_id IN ${IDS} ORDER BY privilege`);
  const parts = await listOf(`SELECT role_id, part_id AS v FROM role_parts WHERE role_id IN ${IDS} ORDER BY part_id`);
  const allP = await listOf(`SELECT role_id, privilege AS v FROM role_all_privileges WHERE role_id IN ${IDS} ORDER BY privilege`);
  const members = await all<{ visitor_id: number; role_id: number }>(db, 'SELECT visitor_id, role_id FROM memberships WHERE area_id = ? ORDER BY visitor_id', a.id);
  const never = await all<{ role_a: number; role_b: number; from_manifest: boolean }>(db, 'SELECT role_a, role_b, from_manifest FROM never_together WHERE role_set_id = ? ORDER BY role_a, role_b', s.id);
  const from = s.copied_from ? await setRow(db, s.copied_from) : null;
  const own = !s.built_in;
  return {
    area: { id: a.id, path: a.path, kind: a.kind === 'route' ? 'route' : 'folder' },
    set: { id: s.id, label: s.label, builtIn: s.built_in, key: s.key, copiedFrom: from?.label ?? null, fromManifest: s.manifest !== null || !!from?.manifest, manifestReadAt: s.manifest_read_at ?? from?.manifest_read_at ?? null },
    canEditRoles: own,
    canEditPrivileges: own && s.manifest === null && !from?.manifest,
    resources, actions: actions.map((x) => ({ key: x.key, label: x.label })), privileges: declaredPrivileges(resources),
    groups: groups.map((g) => ({ id: g.id, key: g.key, label: g.label, privileges: (g.privileges ?? '').split(' ').filter(Boolean) })),
    roles: roles.map((r) => ({
      id: r.id, key: r.key, label: r.label, slot: r.slot,
      groups: (rg.get(r.id) ?? []) as number[], privileges: (rp.get(r.id) ?? []) as string[], parts: (parts.get(r.id) ?? []) as number[],
      all: (allP.get(r.id) ?? []) as string[], people: members.filter((m) => m.role_id === r.id).length,
    })),
    signedInRoleId: s.signed_in_role_id,
    neverTogether: never.map((n) => ({ a: n.role_a, b: n.role_b, fromManifest: n.from_manifest })),
    members: members.map((m) => ({ visitorId: m.visitor_id, roleId: m.role_id })),
  };
}

// ------------------------------------------------------------------ checks
async function needRolesOn(db: Db) {
  if (!(await readVisitorSettings(db)).switches.roles) throw new GateError('invalid', 'Roles and privileges are switched off (Settings, Visitors).');
}

// The area's own copy, to change (refused on a built-in set: R4).
async function ownSet(db: Db, areaId: unknown) {
  await needRolesOn(db);
  const a = await areaRow(db, areaId);
  const s = await setRow(db, a.role_set_id);
  if (s.built_in) throw new GateError('invalid', `"${s.label}" is built in, so it can't be changed. Copy it to change it.`);
  return { area: a, set: s };
}

const label = (v: unknown, what: string) => {
  if (typeof v !== 'string' || v.trim() === '' || v.trim().length > 80) throw new GateError('invalid', `${what}: 1 to 80 characters.`);
  return v.trim();
};
// a key from a label: "Keep progress" -> keep-progress, unique in the set
async function keyFor(db: Db, table: 'roles' | 'groups', setId: number, words: string) {
  const base = (words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'x').slice(0, 40);
  for (let i = 1; ; i++) {
    const k = i === 1 ? base : `${base}-${i}`;
    if (k !== NOT_SIGNED_IN && !await one(db, `SELECT 1 FROM ${table} WHERE role_set_id = ? AND key = ?`, setId, k)) return k;
  }
}
const ids = (v: unknown, what: string): number[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number')) throw new GateError('invalid', `${what}: a list.`);
  return [...new Set(v as number[])];
};
async function declared(db: Db, setId: number) { return new Set(declaredPrivileges(await resourcesOf(db, setId))); }
async function privilegeList(db: Db, setId: number, v: unknown): Promise<string[]> {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new GateError('invalid', 'Privileges: a list.');
  const known = await declared(db, setId);
  const bad = (v as string[]).filter((p) => !known.has(p));
  if (bad.length) throw new GateError('invalid', `Not privileges of this folder: ${bad.join(', ')}.`);
  return [...new Set(v as string[])];
}
async function rolesIn(db: Db, setId: number, wanted: number[]) {
  const rows = await all<RoleRow & { parts: number }>(db,
    `SELECT r.id, r.key, r.label, r.slot, (SELECT count(*) FROM role_parts p WHERE p.role_id = r.id)::int AS parts FROM roles r WHERE r.role_set_id = ? AND r.id IN ${IDS}`, setId, list(wanted));
  if (rows.length !== wanted.length) throw new GateError('not-found', 'That role is no longer there.');
  return rows;
}

// ------------------------------------------------------------------ copy, and back
export async function copySet(db: Db, now: number, areaId: unknown): Promise<AccessState> {
  await needRolesOn(db);
  await tx(db, async (q) => {
    await run(q, 'SET CONSTRAINTS ALL DEFERRED');
    const a = await areaRow(q, areaId);
    const from = await setRow(q, a.role_set_id);
    if (!from.built_in) throw new GateError('exists', 'This folder already has roles of its own.');
    const copy = (await one<{ id: number }>(q,
      'INSERT INTO role_sets (label, built_in, created_at, area_id, copied_from, signed_in_role_id) VALUES (?, false, ?, ?, ?, NULL) RETURNING id',
      `${from.label} (${a.path})`.slice(0, 80), now, a.id, from.id))!.id;
    await run(q, 'INSERT INTO actions (role_set_id, key, label) SELECT ?, key, label FROM actions WHERE role_set_id = ?', copy, from.id);
    for (const r of await all<{ id: number }>(q, 'SELECT id FROM resources WHERE role_set_id = ?', from.id)) {
      const n = (await one<{ id: number }>(q, 'INSERT INTO resources (role_set_id, key, label, owned) SELECT ?, key, label, owned FROM resources WHERE id = ? RETURNING id', copy, r.id))!.id;
      await run(q, 'INSERT INTO resource_actions (resource_id, action) SELECT ?, action FROM resource_actions WHERE resource_id = ?', n, r.id);
    }
    const groupMap = new Map<number, number>();
    for (const g of await all<{ id: number }>(q, 'SELECT id FROM groups WHERE role_set_id = ?', from.id)) {
      const n = (await one<{ id: number }>(q, 'INSERT INTO groups (role_set_id, key, label) SELECT ?, key, label FROM groups WHERE id = ? RETURNING id', copy, g.id))!.id;
      groupMap.set(g.id, n);
      await run(q, 'INSERT INTO group_privileges (group_id, privilege) SELECT ?, privilege FROM group_privileges WHERE group_id = ?', n, g.id);
    }
    const roleMap = new Map<number, number>();
    for (const r of await all<{ id: number }>(q, 'SELECT id FROM roles WHERE role_set_id = ?', from.id)) {
      const n = (await one<{ id: number }>(q, 'INSERT INTO roles (role_set_id, key, label, slot) SELECT ?, key, label, slot FROM roles WHERE id = ? RETURNING id', copy, r.id))!.id;
      roleMap.set(r.id, n);
      await run(q, 'INSERT INTO role_privileges (role_id, privilege) SELECT ?, privilege FROM role_privileges WHERE role_id = ?', n, r.id);
    }
    for (const rg of await all<{ role_id: number; group_id: number }>(q, 'SELECT role_id, group_id FROM role_groups WHERE role_set_id = ?', from.id)) {
      await run(q, 'INSERT INTO role_groups (role_id, group_id, role_set_id) VALUES (?, ?, ?)', roleMap.get(rg.role_id)!, groupMap.get(rg.group_id)!, copy);
    }
    for (const p of await all<{ role_id: number; part_id: number }>(q, 'SELECT role_id, part_id FROM role_parts WHERE role_set_id = ?', from.id)) {
      await run(q, 'INSERT INTO role_parts (role_id, part_id, role_set_id) VALUES (?, ?, ?)', roleMap.get(p.role_id)!, roleMap.get(p.part_id)!, copy);
    }
    for (const n of await all<{ role_a: number; role_b: number; from_manifest: boolean }>(q, 'SELECT role_a, role_b, from_manifest FROM never_together WHERE role_set_id = ?', from.id)) {
      const [x, y] = [roleMap.get(n.role_a)!, roleMap.get(n.role_b)!].sort((i, j) => i - j) as [number, number];
      await run(q, 'INSERT INTO never_together (role_set_id, role_a, role_b, from_manifest) VALUES (?, ?, ?, ?)', copy, x, y, n.from_manifest);
    }
    if (from.signed_in_role_id) await run(q, 'UPDATE role_sets SET signed_in_role_id = ? WHERE id = ?', roleMap.get(from.signed_in_role_id)!, copy);
    // the folder and its people move onto the copy together
    for (const m of await all<{ visitor_id: number; role_id: number }>(q, 'SELECT visitor_id, role_id FROM memberships WHERE area_id = ?', a.id)) {
      await run(q, 'UPDATE memberships SET role_set_id = ?, role_id = ? WHERE visitor_id = ? AND area_id = ?', copy, roleMap.get(m.role_id)!, m.visitor_id, a.id);
    }
    await run(q, 'UPDATE areas SET role_set_id = ? WHERE id = ?', copy, a.id);
  });
  return accessState(db, areaId);
}

// Back to the set it was copied from. People keep a role of the same key there;
// the rest lose theirs (and are listed).
export async function resetSet(db: Db, areaId: unknown): Promise<{ lost: string[] }> {
  const { area, set } = await ownSet(db, areaId);
  const to = set.copied_from ?? (await one<{ id: number }>(db, 'SELECT id FROM role_sets WHERE key = ?', PROTECTED_FOLDER))!.id;
  return tx(db, async (q) => {
    await run(q, 'SET CONSTRAINTS ALL DEFERRED');
    const lost: string[] = [];
    for (const m of await all<{ visitor_id: number; key: string; username: string }>(q,
      'SELECT m.visitor_id, r.key, v.username FROM memberships m JOIN roles r ON r.id = m.role_id JOIN visitors v ON v.id = m.visitor_id WHERE m.area_id = ? ORDER BY v.username', area.id)) {
      const same = await one<{ id: number }>(q, 'SELECT id FROM roles WHERE role_set_id = ? AND key = ? AND slot IS NULL', to, m.key);
      if (same) await run(q, 'UPDATE memberships SET role_set_id = ?, role_id = ? WHERE visitor_id = ? AND area_id = ?', to, same.id, m.visitor_id, area.id);
      else { lost.push(m.username); await run(q, 'DELETE FROM memberships WHERE visitor_id = ? AND area_id = ?', m.visitor_id, area.id); }
    }
    await run(q, 'UPDATE areas SET role_set_id = ? WHERE id = ?', to, area.id);
    await run(q, 'DELETE FROM role_sets WHERE id = ?', set.id);
    return { lost };
  });
}

// ------------------------------------------------------------------ privileges (R12: not under a manifest)
export async function saveResource(db: Db, areaId: unknown, r: { key: unknown; label: unknown; owned: unknown; actions: unknown; actionLabels?: unknown }) {
  const { set } = await ownSet(db, areaId);
  const st = await accessState(db, areaId);
  if (!st.canEditPrivileges) throw new GateError('invalid', "This folder's privileges come from its pammy-panel.json, so they're changed there.");
  const key = typeof r.key === 'string' ? r.key.trim().toLowerCase() : '';
  if (!WORD.test(key) || key === 'pages') throw new GateError('invalid', 'A resource is a lowercase word (a-z, 0-9, -), up to 32, and not "pages".');
  const acts = Array.isArray(r.actions) && r.actions.every((x) => typeof x === 'string' && WORD.test(x)) ? [...new Set(r.actions as string[])] : null;
  if (!acts?.length) throw new GateError('invalid', 'Tick at least one action.');
  const owned = r.owned === true;
  const labels = (r.actionLabels && typeof r.actionLabels === 'object' ? r.actionLabels : {}) as Record<string, unknown>;
  return tx(db, async (q) => {
    // what would stop being a privilege: refused while a role or group uses it
    const before = new Set(st.privileges);
    const others = st.resources.filter((x) => x.key !== key);
    const after = new Set(declaredPrivileges([...others, { key, label: 'x', owned, actions: acts }]));
    if (after.size > MAX_PRIVILEGES) throw new GateError('invalid', `That would make ${after.size} privileges; at most ${MAX_PRIVILEGES}.`);
    await refuseIfUsed(q, set.id, [...before].filter((p) => !after.has(p)));
    for (const a of acts.filter((x) => !CRUD.includes(x))) {
      const words = typeof labels[a] === 'string' && (labels[a] as string).trim() ? (labels[a] as string).trim().slice(0, 80) : a;
      await run(q, 'INSERT INTO actions (role_set_id, key, label) VALUES (?, ?, ?) ON CONFLICT (role_set_id, key) DO UPDATE SET label = EXCLUDED.label', set.id, a, words);
    }
    const res = (await one<{ id: number }>(q,
      `INSERT INTO resources (role_set_id, key, label, owned) VALUES (?, ?, ?, ?)
       ON CONFLICT (role_set_id, key) DO UPDATE SET label = EXCLUDED.label, owned = EXCLUDED.owned RETURNING id`, set.id, key, label(r.label, 'Its name'), owned))!.id;
    await run(q, 'DELETE FROM resource_actions WHERE resource_id = ?', res);
    for (const a of acts) await run(q, 'INSERT INTO resource_actions (resource_id, action) VALUES (?, ?)', res, a);
    await dropUnusedActions(q, set.id);
    return { key };
  });
}

export async function deleteResource(db: Db, areaId: unknown, key: unknown) {
  const { set } = await ownSet(db, areaId);
  const st = await accessState(db, areaId);
  if (!st.canEditPrivileges) throw new GateError('invalid', "This folder's privileges come from its pammy-panel.json, so they're changed there.");
  const r = st.resources.find((x) => x.key === key);
  if (!r) throw new GateError('not-found', 'That resource is no longer there.');
  await tx(db, async (q) => {
    await refuseIfUsed(q, set.id, declaredPrivileges([r]).filter((p) => p !== PAGES_READ));
    await run(q, 'DELETE FROM resources WHERE role_set_id = ? AND key = ?', set.id, r.key);
    await dropUnusedActions(q, set.id);
  });
  return { key: r.key };
}

// a privilege a role or group uses can't go until it's out of them (the page lists them)
async function refuseIfUsed(db: Db, setId: number, going: string[]) {
  if (!going.length) return;
  const users = await all<{ what: string }>(db,
    `SELECT DISTINCT 'the role "' || r.label || '"' AS what FROM role_privileges p JOIN roles r ON r.id = p.role_id WHERE r.role_set_id = ? AND p.privilege IN ${TEXTS}
     UNION SELECT DISTINCT 'the group "' || g.label || '"' FROM group_privileges p JOIN groups g ON g.id = p.group_id WHERE g.role_set_id = ? AND p.privilege IN ${TEXTS}`,
    setId, list(going), setId, list(going));
  if (users.length) throw new GateError('invalid', `${going.join(', ')} ${going.length === 1 ? 'is' : 'are'} still used by ${users.map((u) => u.what).join(', ')}. Take ${going.length === 1 ? 'it' : 'them'} out there first.`);
}
const dropUnusedActions = (db: Db, setId: number) => run(db,
  'DELETE FROM actions a WHERE a.role_set_id = ? AND NOT EXISTS (SELECT 1 FROM resource_actions ra JOIN resources r ON r.id = ra.resource_id WHERE r.role_set_id = a.role_set_id AND ra.action = a.key)', setId);

// ------------------------------------------------------------------ groups
export async function saveGroup(db: Db, areaId: unknown, g: { id?: unknown; label: unknown; privileges: unknown }) {
  const { set } = await ownSet(db, areaId);
  const words = label(g.label, "The group's name");
  const privileges = await privilegeList(db, set.id, g.privileges);
  return tx(db, async (q) => {
    let id: number;
    if (g.id === undefined || g.id === null) {
      id = (await one<{ id: number }>(q, 'INSERT INTO groups (role_set_id, key, label) VALUES (?, ?, ?) RETURNING id', set.id, await keyFor(q, 'groups', set.id, words), words))!.id;
    } else {
      const found = typeof g.id === 'number' ? await one<{ id: number }>(q, 'SELECT id FROM groups WHERE id = ? AND role_set_id = ?', g.id, set.id) : undefined;
      if (!found) throw new GateError('not-found', 'That group is no longer there.');
      id = found.id;
      await run(q, 'UPDATE groups SET label = ? WHERE id = ?', words, id);
      await run(q, 'DELETE FROM group_privileges WHERE group_id = ?', id);
    }
    for (const p of privileges) await run(q, 'INSERT INTO group_privileges (group_id, privilege) VALUES (?, ?)', id, p);
    return { id };
  });
}

export async function deleteGroup(db: Db, areaId: unknown, id: unknown) {
  const { set } = await ownSet(db, areaId);
  const g = typeof id === 'number' ? await one<{ id: number; label: string }>(db, 'SELECT id, label FROM groups WHERE id = ? AND role_set_id = ?', id, set.id) : undefined;
  if (!g) throw new GateError('not-found', 'That group is no longer there.');
  await run(db, 'DELETE FROM groups WHERE id = ?', g.id);     // out of every role with it
  return { label: g.label };
}

// ------------------------------------------------------------------ roles
// A plain role: groups and extra privileges. A combined role: two or more plain
// roles (parts), never a pair on the never-together list (R3, R11).
export async function saveRole(db: Db, areaId: unknown, r: { id?: unknown; label?: unknown; groups?: unknown; privileges?: unknown; parts?: unknown }) {
  const { set } = await ownSet(db, areaId);
  const groups = ids(r.groups, 'Groups');
  const privileges = await privilegeList(db, set.id, r.privileges);
  const parts = ids(r.parts, 'Roles');
  if (groups.length && (await all(db, `SELECT id FROM groups WHERE role_set_id = ? AND id IN ${IDS}`, set.id, list(groups))).length !== groups.length) {
    throw new GateError('not-found', 'That group is no longer there.');
  }
  return tx(db, async (q) => {
    let role: RoleRow | undefined;
    if (r.id !== undefined && r.id !== null) {
      role = typeof r.id === 'number' ? await one<RoleRow>(q, 'SELECT id, key, label, slot FROM roles WHERE id = ? AND role_set_id = ?', r.id, set.id) : undefined;
      if (!role) throw new GateError('not-found', 'That role is no longer there.');
    }
    if (parts.length) {
      if (role?.slot) throw new GateError('invalid', '"Not signed in" is made of privileges, not roles.');
      if (parts.length < 2) throw new GateError('invalid', 'A combined role is made of two roles or more.');
      const ps = await rolesIn(q, set.id, parts);
      if (ps.some((p) => p.slot || p.parts > 0 || p.id === role?.id)) throw new GateError('invalid', 'A combined role is made of plain roles: not "Not signed in", and not other combined roles.');
      if (role && (await one(q, 'SELECT 1 FROM role_parts WHERE part_id = ?', role.id))) throw new GateError('invalid', `"${role.label}" is part of a combined role, so it can't be combined itself.`);
      const pair = await one<{ a: string; b: string }>(q,
        `SELECT ra.label AS a, rb.label AS b FROM never_together n JOIN roles ra ON ra.id = n.role_a JOIN roles rb ON rb.id = n.role_b
          WHERE n.role_set_id = ? AND n.role_a IN ${IDS} AND n.role_b IN ${IDS} LIMIT 1`, set.id, list(parts), list(parts));
      if (pair) throw new GateError('invalid', `"${pair.a}" and "${pair.b}" can never be given together.`);
      if (groups.length || privileges.length) throw new GateError('invalid', 'A combined role gets its privileges from its roles.');
    }
    if (!role) {
      const words = label(r.label, "The role's name");
      role = (await one<RoleRow>(q, 'INSERT INTO roles (role_set_id, key, label) VALUES (?, ?, ?) RETURNING id, key, label, slot', set.id, await keyFor(q, 'roles', set.id, words), words))!;
    } else if (r.label !== undefined && !role.slot) {
      await run(q, 'UPDATE roles SET label = ? WHERE id = ?', label(r.label, "The role's name"), role.id);
    }
    const clash = await one<{ id: number }>(q, 'SELECT id FROM roles WHERE role_set_id = ? AND lower(label) = lower((SELECT label FROM roles WHERE id = ?)) AND id <> ?', set.id, role.id, role.id);
    if (clash) throw new GateError('exists', 'There is a role with that name already.');
    await run(q, 'DELETE FROM role_groups WHERE role_id = ?', role.id);
    await run(q, 'DELETE FROM role_privileges WHERE role_id = ?', role.id);
    await run(q, 'DELETE FROM role_parts WHERE role_id = ?', role.id);
    for (const g of groups) await run(q, 'INSERT INTO role_groups (role_id, group_id, role_set_id) VALUES (?, ?, ?)', role.id, g, set.id);
    for (const p of privileges) await run(q, 'INSERT INTO role_privileges (role_id, privilege) VALUES (?, ?)', role.id, p);
    for (const p of parts) await run(q, 'INSERT INTO role_parts (role_id, part_id, role_set_id) VALUES (?, ?, ?)', role.id, p, set.id);
    return { id: role.id };
  });
}

// Q2: the people holding it move to another role, or to none; a role that is
// part of a combined role, or is the signed-in slot, goes only after that changes.
export async function deleteRole(db: Db, areaId: unknown, id: unknown, moveTo: unknown) {
  const { area, set } = await ownSet(db, areaId);
  const role = typeof id === 'number' ? await one<RoleRow>(db, 'SELECT id, key, label, slot FROM roles WHERE id = ? AND role_set_id = ?', id, set.id) : undefined;
  if (!role) throw new GateError('not-found', 'That role is no longer there.');
  if (role.slot) throw new GateError('invalid', '"Not signed in" is always there.');
  const inside = await all<{ label: string }>(db, 'SELECT r.label FROM role_parts p JOIN roles r ON r.id = p.role_id WHERE p.part_id = ?', role.id);
  if (inside.length) throw new GateError('invalid', `"${role.label}" is part of ${inside.map((x) => `"${x.label}"`).join(', ')}. Change ${inside.length === 1 ? 'that' : 'those'} first.`);
  if (set.signed_in_role_id === role.id) throw new GateError('invalid', `Everyone signed in counts as "${role.label}". Choose another role for them first.`);
  let target: RoleRow | undefined;
  if (moveTo !== null && moveTo !== undefined) {
    target = typeof moveTo === 'number' ? await one<RoleRow>(db, 'SELECT id, key, label, slot FROM roles WHERE id = ? AND role_set_id = ? AND slot IS NULL', moveTo, set.id) : undefined;
    if (!target || target.id === role.id) throw new GateError('not-found', 'Choose another of these roles, or no role.');
  }
  return tx(db, async (q) => {
    const people = await all<{ username: string }>(q, 'SELECT v.username FROM memberships m JOIN visitors v ON v.id = m.visitor_id WHERE m.role_id = ? ORDER BY v.username', role.id);
    if (target) await run(q, 'UPDATE memberships SET role_id = ? WHERE role_id = ? AND area_id = ?', target.id, role.id, area.id);
    await run(q, 'DELETE FROM roles WHERE id = ?', role.id);
    return { label: role.label, people: people.map((p) => p.username), movedTo: target?.label ?? null };
  });
}

// The "signed in, no role given" slot: one of the plain or combined roles, or nothing.
export async function setSignedInRole(db: Db, areaId: unknown, roleId: unknown) {
  const { set } = await ownSet(db, areaId);
  if (roleId !== null) {
    const r = typeof roleId === 'number' ? await one<RoleRow>(db, 'SELECT id, key, label, slot FROM roles WHERE id = ? AND role_set_id = ? AND slot IS NULL', roleId, set.id) : undefined;
    if (!r) throw new GateError('not-found', 'Choose one of these roles, or nothing.');
  }
  await run(db, 'UPDATE role_sets SET signed_in_role_id = ? WHERE id = ?', roleId as number | null, set.id);
  return { ok: true };
}

// R11: the owner's pairs (the manifest's can't be taken off)
export async function setNeverTogether(db: Db, areaId: unknown, a: unknown, b: unknown, never: unknown) {
  const { set } = await ownSet(db, areaId);
  if (typeof a !== 'number' || typeof b !== 'number' || a === b) throw new GateError('invalid', 'Two different roles.');
  const [x, y] = [a, b].sort((i, j) => i - j) as [number, number];
  const rs = await rolesIn(db, set.id, [x, y]);
  if (rs.some((r) => r.slot || r.parts > 0)) throw new GateError('invalid', 'Only plain roles can be kept apart.');
  if (never === true) {
    const both = await one<{ label: string }>(db,
      'SELECT r.label FROM roles r WHERE r.role_set_id = ? AND (SELECT count(*) FROM role_parts p WHERE p.role_id = r.id AND p.part_id IN (?, ?)) = 2', set.id, x, y);
    if (both) throw new GateError('invalid', `"${both.label}" is made of both. Change it first.`);
    await run(db, 'INSERT INTO never_together (role_set_id, role_a, role_b) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', set.id, x, y);
  } else {
    const row = await one<{ from_manifest: boolean }>(db, 'SELECT from_manifest FROM never_together WHERE role_a = ? AND role_b = ?', x, y);
    if (row?.from_manifest) throw new GateError('invalid', "That pair comes from the app's pammy-panel.json.");
    await run(db, 'DELETE FROM never_together WHERE role_a = ? AND role_b = ?', x, y);
  }
  return { ok: true };
}

// ------------------------------------------------------------------ people
// One role per person per area (R2); null takes it away. Giving a role other
// than Member, or any role on a folder's own copy, needs the roles switch; the
// Protected folders page's yes/no is setMember (store.ts), as before.
export async function setPersonRole(db: Db, now: number, areaId: unknown, visitorId: unknown, roleId: unknown) {
  await needRolesOn(db);
  const a = await areaRow(db, areaId);
  const v = typeof visitorId === 'number' ? await one<{ id: number; username: string }>(db, 'SELECT id, username FROM visitors WHERE id = ?', visitorId) : undefined;
  if (!v) throw new GateError('not-found', 'That person no longer exists.');
  if (roleId === null) {
    await run(db, 'DELETE FROM memberships WHERE visitor_id = ? AND area_id = ?', v.id, a.id);
    return { username: v.username, role: null };
  }
  const r = typeof roleId === 'number' ? await one<RoleRow>(db, 'SELECT id, key, label, slot FROM roles WHERE id = ? AND role_set_id = ? AND slot IS NULL', roleId, a.role_set_id) : undefined;
  if (!r) throw new GateError('not-found', 'That role is no longer there.');
  await run(db, `INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (visitor_id, area_id) DO UPDATE SET role_id = EXCLUDED.role_id`, v.id, a.id, a.role_set_id, r.id, now);
  return { username: v.username, role: r.label };
}

// ------------------------------------------------------------------ pammy-panel.json
// "Read again": the file at the folder's top, as the panel read it. The folder
// goes onto the app's built-in set (app-folder-<id>), people matched by role
// key; a copy made from it stays a copy, but can't have privileges added (R12).
export async function readManifest(db: Db, now: number, areaId: unknown, text: unknown) {
  await needRolesOn(db);
  const a = await areaRow(db, areaId);
  if (typeof text !== 'string') throw new GateError('invalid', 'No pammy-panel.json was found at the top of the folder.');
  // a route's app set (docs/roles-plan.md step 6) is its own, and goes with its area (route-areas.ts)
  const setKey = `app-${a.kind === 'route' ? 'route' : 'folder'}-${a.id}`;
  const report = await applyManifest(db, now, setKey, text);
  const cur = await setRow(db, a.role_set_id);
  let lost: string[] = [];
  if (cur.id !== report.roleSetId && cur.copied_from !== report.roleSetId) {
    // onto the app's set: the same as going back from a copy, to it
    await tx(db, async (q) => {
      await run(q, 'SET CONSTRAINTS ALL DEFERRED');
      for (const m of await all<{ visitor_id: number; key: string; username: string }>(q,
        'SELECT m.visitor_id, r.key, v.username FROM memberships m JOIN roles r ON r.id = m.role_id JOIN visitors v ON v.id = m.visitor_id WHERE m.area_id = ?', a.id)) {
        const same = await one<{ id: number }>(q, 'SELECT id FROM roles WHERE role_set_id = ? AND key = ? AND slot IS NULL', report.roleSetId, m.key);
        if (same) await run(q, 'UPDATE memberships SET role_set_id = ?, role_id = ? WHERE visitor_id = ? AND area_id = ?', report.roleSetId, same.id, m.visitor_id, a.id);
        else { lost.push(m.username); await run(q, 'DELETE FROM memberships WHERE visitor_id = ? AND area_id = ?', m.visitor_id, a.id); }
      }
      await run(q, 'UPDATE areas SET role_set_id = ? WHERE id = ?', report.roleSetId, a.id);
      if (!cur.built_in) await run(q, 'DELETE FROM role_sets WHERE id = ?', cur.id);
    });
  }
  lost = [...lost, ...report.removedRoles.flatMap((r) => r.people)];
  return { ...report, lost: [...new Set(lost)].sort() };
}
