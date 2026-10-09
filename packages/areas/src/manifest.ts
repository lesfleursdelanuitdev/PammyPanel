// pammy-panel.json (docs/roles-plan.md R10): what an app says about its own
// privileges -- resources and their actions, its own verbs, groups, built-in
// roles, the two slots, and roles never given together. Read at the app's root;
// nginx never serves it.
//
// checkManifest() is every check the plan names, and nothing is taken from a
// manifest that fails one: the whole file is refused and the last good one
// stays (applyManifest, below). Words shown to people (labels) are kept as
// written; keys are what the gate and the app compare.
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { PAGES_READ } from '@panel/core/gate/store';
import { checkCatalogSection, type CatalogResource } from '@panel/core/manifest-catalog';

export const MANIFEST_FILE = 'pammy-panel.json';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MAX_PRIVILEGES = 100;
export const CRUD = ['read', 'create', 'update', 'delete'] as const;
export const NOT_SIGNED_IN = 'not-signed-in';

const WORD = /^[a-z][a-z0-9-]{0,31}$/;          // a resource or an action
const KEY = /^[a-z][a-z0-9-]{0,63}$/;           // a group or a role
const PRIVILEGE = /^([a-z][a-z0-9-]{0,31})\.([a-z][a-z0-9-]{0,31})(?::(own|any))?$/;

export type Resource = { key: string; label: string; owned: boolean; actions: string[] };
export type Manifest = {
  name: string;
  resources: Resource[];
  actions: { key: string; label: string }[];                  // the app's own verbs
  groups: { key: string; label: string; privileges: string[] }[];
  roles: { key: string; label: string; groups: string[]; privileges: string[] }[];
  slots: { notSignedIn: { groups: string[]; privileges: string[] }; signedIn: string | null };
  neverTogether: [string, string][];
  privileges: string[];                                       // every key it declares, pages.read first
  // what it offers the catalog to tag (docs/catalog-plan.md step 5); the roles ignore it
  catalog: CatalogResource[] | null;
};

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`${MANIFEST_FILE} was not taken: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

// The keys a set of resources declares: pages.read, then each resource's
// actions, with :own and :any where it has an owner.
export function declaredPrivileges(resources: Resource[]): string[] {
  const out = [PAGES_READ];
  for (const r of resources) for (const a of r.actions) {
    if (r.owned) out.push(`${r.key}.${a}:own`, `${r.key}.${a}:any`);
    else out.push(`${r.key}.${a}`);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkManifest(text: string): Manifest {
  const problems: string[] = [];
  const bad = (m: string) => { if (problems.length < 20) problems.push(m); };
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) throw new ManifestError([`it is larger than ${MANIFEST_MAX_BYTES / 1024} KB`]);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ManifestError([`it isn't JSON (${(e as Error).message})`]); }
  if (!isObject(raw)) throw new ManifestError(['it must be one JSON object']);

  const only = (o: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${where}: "${k}" isn't something it can say`);
  };
  const label = (v: unknown, where: string) => {
    if (typeof v !== 'string' || v.trim() === '' || v.length > 80) { bad(`${where}: a label of 1 to 80 characters`); return ''; }
    return v.trim();
  };
  const strings = (v: unknown, where: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { bad(`${where}: a list of names`); return []; }
    return [...new Set(v as string[])];
  };
  const entries = (v: unknown, where: string): [string, Record<string, unknown>][] => {
    if (v === undefined) return [];
    if (!isObject(v)) { bad(`${where}: an object`); return []; }
    return Object.entries(v).filter(([k, x]) => {
      if (!isObject(x)) { bad(`${where}.${k}: an object`); return false; }
      return true;
    }) as [string, Record<string, unknown>][];
  };

  only(raw, ['version', 'name', 'resources', 'actions', 'groups', 'roles', 'slots', 'neverTogether', 'catalog'], 'the file');
  if (raw.version !== 1) bad('"version" must be 1');
  const name = label(raw.name, 'name');

  const actions = entries(raw.actions, 'actions').map(([key, a]) => {
    only(a, ['label'], `actions.${key}`);
    if (!WORD.test(key) || (CRUD as readonly string[]).includes(key)) bad(`actions.${key}: an action is a lowercase word (a-z, 0-9, -), and read/create/update/delete are already there`);
    return { key, label: label(a.label, `actions.${key}`) };
  });
  const verbs = new Set<string>([...CRUD, ...actions.map((a) => a.key)]);

  const resources = entries(raw.resources, 'resources').map(([key, r]) => {
    only(r, ['label', 'owned', 'actions'], `resources.${key}`);
    if (!WORD.test(key)) bad(`resources.${key}: a resource is a lowercase word (a-z, 0-9, -), up to 32`);
    if (key === 'pages') bad('resources.pages: pages is built in');
    if (r.owned !== undefined && typeof r.owned !== 'boolean') bad(`resources.${key}.owned: true or false`);
    const acts = strings(r.actions, `resources.${key}.actions`);
    if (!acts.length) bad(`resources.${key}: at least one action`);
    for (const a of acts) if (!verbs.has(a)) bad(`resources.${key}: "${a}" is not read, create, update, delete or one of "actions"`);
    return { key, label: label(r.label, `resources.${key}`), owned: r.owned === true, actions: acts };
  });

  const privileges = declaredPrivileges(resources);
  if (privileges.length > MAX_PRIVILEGES) bad(`it declares ${privileges.length} privileges; at most ${MAX_PRIVILEGES}`);
  const known = new Set(privileges);
  const byKey = new Map(resources.map((r) => [r.key, r]));
  // why a key isn't one of the declared ones, in words
  const privilegeProblem = (p: string): string | null => {
    if (known.has(p)) return null;
    const m = PRIVILEGE.exec(p);
    if (!m) return `"${p}" isn't resource.action or resource.action:own|:any`;
    const r = m[1] === 'pages' ? null : byKey.get(m[1]!);
    if (m[1] === 'pages') return `"${p}": pages has only read, and no owner`;
    if (!r) return `"${p}": no resource "${m[1]}"`;
    if (!r.actions.includes(m[2]!)) return `"${p}": ${r.key} has no action "${m[2]}"`;
    return r.owned ? `"${p}": ${r.key} has an owner, so say :own or :any` : `"${p}": ${r.key} has no owner, so no :own or :any`;
  };
  const privilegeList = (v: unknown, where: string) => {
    const ps = strings(v, where);
    for (const p of ps) { const why = privilegeProblem(p); if (why) bad(`${where}: ${why}`); }
    return ps;
  };

  const groups = entries(raw.groups, 'groups').map(([key, g]) => {
    only(g, ['label', 'privileges'], `groups.${key}`);
    if (!KEY.test(key)) bad(`groups.${key}: a group is a lowercase name (a-z, 0-9, -)`);
    return { key, label: label(g.label, `groups.${key}`), privileges: privilegeList(g.privileges, `groups.${key}.privileges`) };
  });
  const groupKeys = new Set(groups.map((g) => g.key));
  const groupList = (v: unknown, where: string) => {
    const gs = strings(v, where);
    for (const g of gs) if (!groupKeys.has(g)) bad(`${where}: no group "${g}"`);
    return gs;
  };

  const roles = entries(raw.roles, 'roles').map(([key, r]) => {
    only(r, ['label', 'groups', 'privileges'], `roles.${key}`);
    if (!KEY.test(key) || key === NOT_SIGNED_IN) bad(`roles.${key}: a role is a lowercase name (a-z, 0-9, -), and not "${NOT_SIGNED_IN}"`);
    return { key, label: label(r.label, `roles.${key}`), groups: groupList(r.groups, `roles.${key}.groups`), privileges: privilegeList(r.privileges, `roles.${key}.privileges`) };
  });
  const roleKeys = new Set(roles.map((r) => r.key));
  const labels = new Map<string, string>();
  for (const r of roles) {
    const l = r.label.toLowerCase();
    if (labels.has(l)) bad(`roles.${r.key}: the same label as roles.${labels.get(l)} ("${r.label}"), and people would see two of one`);
    labels.set(l, r.key);
  }

  const slotsRaw = raw.slots === undefined ? {} : raw.slots;
  let slots: Manifest['slots'] = { notSignedIn: { groups: [], privileges: [] }, signedIn: null };
  if (!isObject(slotsRaw)) bad('slots: an object');
  else {
    only(slotsRaw, ['notSignedIn', 'signedIn'], 'slots');
    const ns = slotsRaw.notSignedIn === undefined ? {} : slotsRaw.notSignedIn;
    if (!isObject(ns)) bad('slots.notSignedIn: an object with groups and privileges');
    else {
      only(ns, ['groups', 'privileges'], 'slots.notSignedIn');
      slots = { ...slots, notSignedIn: { groups: groupList(ns.groups, 'slots.notSignedIn.groups'), privileges: privilegeList(ns.privileges, 'slots.notSignedIn.privileges') } };
    }
    const si = slotsRaw.signedIn;
    if (si !== undefined && si !== null && (typeof si !== 'string' || !roleKeys.has(si))) bad(`slots.signedIn: one of the roles, or null`);
    else slots = { ...slots, signedIn: typeof si === 'string' ? si : null };
  }

  const neverTogether: [string, string][] = [];
  if (raw.neverTogether !== undefined) {
    if (!Array.isArray(raw.neverTogether)) bad('neverTogether: a list of pairs of roles');
    else for (const pair of raw.neverTogether) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== 'string' || !roleKeys.has(x)) || pair[0] === pair[1]) {
        bad(`neverTogether: ${JSON.stringify(pair)} isn't two different roles`);
        continue;
      }
      const [a, b] = [...(pair as string[])].sort() as [string, string];
      if (!neverTogether.some(([x, y]) => x === a && y === b)) neverTogether.push([a, b]);
    }
  }

  const catalog = raw.catalog === undefined ? null : checkCatalogSection(raw.catalog, bad);

  if (problems.length) throw new ManifestError(problems);
  return { name, resources, actions, groups, roles, slots, neverTogether, privileges, catalog };
}

// ------------------------------------------------------------------ into the database
// What changed for people when a manifest was taken: privileges that went (they
// leave every role), and roles that went, with the people who held them -- they
// now count as "signed in, no role given" (docs/roles-plan.md, "When a manifest
// changes"). The caller writes it to Activity.
export type ManifestReport = {
  roleSetId: number;
  created: boolean;
  removedPrivileges: string[];
  removedRoles: { key: string; label: string; people: string[] }[];
};

// Make or bring up to date the built-in role set `setKey` from a manifest's
// text: checked first (nothing written if it fails), then everything in the set
// replaced by what the manifest says, in one transaction. A built-in set is the
// manifest's alone; owners change a copy (step 4).
export async function applyManifest(db: Db, now: number, setKey: string, text: string): Promise<ManifestReport> {
  // app-...: never one of the panel's own built-in sets (protected-folder)
  if (!KEY.test(setKey) || !setKey.startsWith('app-')) throw new ManifestError([`"${setKey}" can't name an app's role set (app-<name>)`]);
  const m = checkManifest(text);
  return tx(db, async (q) => {
    let set = await one<{ id: number; built_in: boolean }>(q, 'SELECT id, built_in FROM role_sets WHERE key = ? FOR UPDATE', setKey);
    const created = !set;
    if (!set) {
      set = (await one<{ id: number; built_in: boolean }>(q, 'INSERT INTO role_sets (key, label, built_in, created_at) VALUES (?, ?, true, ?) RETURNING id, built_in', setKey, m.name, now))!;
    }
    const sid = set.id;
    const before = new Set((await all<{ privilege: string }>(q,
      'SELECT DISTINCT p.privilege FROM role_all_privileges p JOIN roles r ON r.id = p.role_id WHERE r.role_set_id = ?', sid)).map((r) => r.privilege));

    await run(q, 'UPDATE role_sets SET label = ?, manifest = ?, manifest_read_at = ? WHERE id = ?', m.name, text, now, sid);

    // what it declares: replaced whole
    await run(q, 'DELETE FROM resources WHERE role_set_id = ?', sid);
    await run(q, 'DELETE FROM actions WHERE role_set_id = ?', sid);
    for (const a of m.actions) await run(q, 'INSERT INTO actions (role_set_id, key, label) VALUES (?, ?, ?)', sid, a.key, a.label);
    for (const r of m.resources) {
      const row = (await one<{ id: number }>(q, 'INSERT INTO resources (role_set_id, key, label, owned) VALUES (?, ?, ?, ?) RETURNING id', sid, r.key, r.label, r.owned))!;
      for (const a of r.actions) await run(q, 'INSERT INTO resource_actions (resource_id, action) VALUES (?, ?)', row.id, a);
    }
    await run(q, 'DELETE FROM groups WHERE role_set_id = ?', sid);
    const groupIds = new Map<string, number>();
    for (const g of m.groups) {
      const row = (await one<{ id: number }>(q, 'INSERT INTO groups (role_set_id, key, label) VALUES (?, ?, ?) RETURNING id', sid, g.key, g.label))!;
      groupIds.set(g.key, row.id);
      for (const p of g.privileges) await run(q, 'INSERT INTO group_privileges (group_id, privilege) VALUES (?, ?)', row.id, p);
    }

    // roles: kept by key, so the people holding one keep it
    const existing = await all<{ id: number; key: string; label: string }>(q, 'SELECT id, key, label FROM roles WHERE role_set_id = ? AND slot IS NULL', sid);
    const removedRoles: ManifestReport['removedRoles'] = [];
    for (const r of existing.filter((e) => !m.roles.some((x) => x.key === e.key))) {
      const people = (await all<{ username: string }>(q,
        'SELECT v.username FROM memberships m JOIN visitors v ON v.id = m.visitor_id WHERE m.role_id = ? ORDER BY v.username', r.id)).map((p) => p.username);
      removedRoles.push({ key: r.key, label: r.label, people });
      await run(q, 'UPDATE role_sets SET signed_in_role_id = NULL WHERE signed_in_role_id = ?', r.id);
      await run(q, 'DELETE FROM roles WHERE id = ?', r.id);      // their memberships go with it
    }
    const roleIds = new Map<string, number>();
    const fill = async (roleId: number, groups: string[], privileges: string[]) => {
      await run(q, 'DELETE FROM role_groups WHERE role_id = ?', roleId);
      await run(q, 'DELETE FROM role_privileges WHERE role_id = ?', roleId);
      for (const g of groups) await run(q, 'INSERT INTO role_groups (role_id, group_id, role_set_id) VALUES (?, ?, ?)', roleId, groupIds.get(g)!, sid);
      for (const p of privileges) await run(q, 'INSERT INTO role_privileges (role_id, privilege) VALUES (?, ?)', roleId, p);
    };
    for (const r of m.roles) {
      const row = (await one<{ id: number }>(q,
        `INSERT INTO roles (role_set_id, key, label) VALUES (?, ?, ?)
         ON CONFLICT (role_set_id, key) DO UPDATE SET label = EXCLUDED.label RETURNING id`, sid, r.key, r.label))!;
      roleIds.set(r.key, row.id);
      await fill(row.id, r.groups, r.privileges);
    }
    const slot = (await one<{ id: number }>(q,
      `INSERT INTO roles (role_set_id, key, label, slot) VALUES (?, ?, 'Not signed in', ?)
       ON CONFLICT (role_set_id, key) DO UPDATE SET slot = EXCLUDED.slot RETURNING id`, sid, NOT_SIGNED_IN, NOT_SIGNED_IN))!;
    await fill(slot.id, m.slots.notSignedIn.groups, m.slots.notSignedIn.privileges);
    await run(q, 'UPDATE role_sets SET signed_in_role_id = ? WHERE id = ?', m.slots.signedIn ? roleIds.get(m.slots.signedIn)! : null, sid);

    await run(q, 'DELETE FROM never_together WHERE role_set_id = ? AND from_manifest', sid);
    for (const [a, b] of m.neverTogether) {
      const [x, y] = [roleIds.get(a)!, roleIds.get(b)!].sort((i, j) => i - j) as [number, number];
      await run(q, 'INSERT INTO never_together (role_set_id, role_a, role_b, from_manifest) VALUES (?, ?, ?, true) ON CONFLICT (role_a, role_b) DO UPDATE SET from_manifest = true', sid, x, y);
    }

    const after = new Set((await all<{ privilege: string }>(q,
      'SELECT DISTINCT p.privilege FROM role_all_privileges p JOIN roles r ON r.id = p.role_id WHERE r.role_set_id = ?', sid)).map((r) => r.privilege));
    return { roleSetId: sid, created, removedPrivileges: [...before].filter((p) => !after.has(p)).sort(), removedRoles };
  });
}
