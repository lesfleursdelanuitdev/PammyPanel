// pammy.org's nginx from the hosts rows (docs/phase8-plan.md 8-7b). The hosts module stays
// off in pammy.org's profile -- no Hosts page, the gate as it is, an account's places still
// its folders -- and pammy.org uses the module's renderer and routing helper (pammy-routes)
// as its nginx: the rows below, rendered by sites/pammy/src/hosts.ts's settings into
// /etc/nginx/pammy-hosts. Until the switch (8-7c) nginx doesn't read those files.
//
//   pammy.org and www: the whole website, and /api/ to pamela-app (127.0.0.1:3042)
//   folder hosts on: every <folder>.pammy.org from the domain's catch-all, as today
//   installed software: one route each, following the installs' placements (the software
//     helper's list): "subdomain blog" is the host blog, "path shop" is pammy.org/shop/;
//     "root" (the whole website) isn't a route, and "off" is none
import type { Module, SiteProfile } from '@panel/core/profile';
import { callJsonLine } from '@panel/core/jsonline';
import { all, one, run, tx, type Db, type Sql } from '@panel/core/pg';
import { homeDomain, seedHomeDomain } from '@panel/hosts/domains';
import { tableFrom } from '@panel/hosts/panel/routes/hosts';
import type { Table } from '@panel/hosts/render';
import { PROFILE } from './profile.ts';

// pammy.org's profile with the hosts module on, for the hosts package's own functions: only
// here, never the site's (see above)
export const WITH_HOSTS = { ...PROFILE, modules: [...PROFILE.modules, 'hosts'] as Module[] } satisfies SiteProfile;
// pamela-app, behind pammy.org/api/ (P8-14)
export const API_PORT = 3042;

// An install as the software helper lists it.
export type Install = { id: string; placement: { mode: string; name: string | null } | null; deleted?: unknown };

// The adopted blog's proxy file is proxy.conf; every other install's proxy-<id>.conf (the
// software helper's own rule, packages/apps/src/apps/nginx.ts proxyFileOf).
const proxyOf = (id: string) => (id === 'blog' ? 'proxy.conf' : `proxy-${id}.conf`);

// The whole table, with the software its routes show.
export async function pammyTable(q: Db): Promise<Table> {
  const t = await tableFrom(q);
  const ids = [...new Set(t.routes.filter((r) => r.kind === 'software').map((r) => String(r.app)))].sort();
  return { ...t, software: ids.map((id) => ({ id, proxy: proxyOf(id) })) };
}

type HostRow = { id: number; name: string };
const hostNamed = (q: Db, name: string) => one<HostRow>(q, 'SELECT id, name FROM hosts WHERE name = ? AND domain_id = (SELECT id FROM domains WHERE home)', name);
async function hostMade(q: Db, name: string, now: number, actor: string, www = false): Promise<number> {
  const had = await hostNamed(q, name);
  if (had) return had.id;
  return (await one<{ id: number }>(q,
    "INSERT INTO hosts (name, enabled, with_www, adopted, origin, created_by, created_at) VALUES (?, true, ?, ?, ?, ?, ?) RETURNING id",
    name, www, name === '@', name === '@' ? 'adopted' : 'hand', actor, now))!.id;
}
async function routeMade(q: Db, hostId: number, path: string, kind: string, ref: Record<string, unknown>, now: number, actor: string): Promise<boolean> {
  const had = await one<{ id: number; target_kind: string; target_ref: Record<string, unknown> }>(q, 'SELECT id, target_kind, target_ref FROM routes WHERE host_id = ? AND path = ?', hostId, path);
  if (had && had.target_kind === kind && JSON.stringify(had.target_ref) === JSON.stringify(ref)) return false;
  if (had) await run(q, 'UPDATE routes SET target_kind = ?, target_ref = ?::text::jsonb, folder_id = NULL, enabled = true WHERE id = ?', kind, JSON.stringify(ref), had.id);
  else await run(q, 'INSERT INTO routes (host_id, path, target_kind, target_ref, enabled, created_by, created_at) VALUES (?, ?, ?, ?::text::jsonb, true, ?, ?)', hostId, path, kind, JSON.stringify(ref), actor, now);
  return true;
}

// The software routes as the installs' placements say, in one transaction's q: what changed.
export async function syncSoftware(q: Db, installs: Install[], now: number, actor: string): Promise<string[]> {
  const changed: string[] = [];
  const want = new Map<string, { host: string; path: string; app: string }>();
  for (const a of installs) {
    const p = a.placement;
    if (a.deleted || !p || p.mode === 'off' || p.mode === 'root' || !p.name) continue;
    const at = p.mode === 'subdomain' ? { host: p.name, path: '/' } : { host: '@', path: `/${p.name}/` };
    want.set(`${at.host} ${at.path}`, { ...at, app: a.id });
  }
  // the software routes there now: kept if wanted as they are, else taken out (and a host
  // left with no route at all goes too: it was made for the software)
  const had = await all<{ id: number; host_id: number; host: string; path: string; app: string }>(q,
    `SELECT r.id, r.host_id, h.name AS host, r.path, r.target_ref->>'app' AS app FROM routes r JOIN hosts h ON h.id = r.host_id
      WHERE r.target_kind = 'software' AND h.domain_id = (SELECT id FROM domains WHERE home)`);
  for (const r of had) {
    const w = want.get(`${r.host} ${r.path}`);
    if (w && w.app === r.app) { want.delete(`${r.host} ${r.path}`); continue; }
    await run(q, 'DELETE FROM routes WHERE id = ?', r.id);
    if (!(await one(q, 'SELECT 1 FROM routes WHERE host_id = ?', r.host_id)) && r.host !== '@') await run(q, 'DELETE FROM hosts WHERE id = ?', r.host_id);
    changed.push(`${r.host === '@' ? 'pammy.org' : `${r.host}.pammy.org`}${r.path}: ${r.app} taken out`);
  }
  for (const w of want.values()) {
    const hostId = await hostMade(q, w.host, now, actor);
    await routeMade(q, hostId, w.path, 'software', { app: w.app }, now, actor);
    changed.push(`${w.host === '@' ? 'pammy.org' : `${w.host}.pammy.org`}${w.path}: ${w.app}`);
  }
  return changed;
}

// The routing helper, with the whole table (and a hand-written link to take over or give
// back, 8-7c).
export const applyTable = (socket: string, table: Table, link: { takeOver?: string; giveBack?: string } = {}) =>
  callJsonLine<{ changed: string[]; removed: string[]; reloaded: boolean; link?: string }>(socket, { op: 'apply', table, ...link }, 'the routing helper', 150_000);

// The software routes as the software helper's list says, and nginx's files with them, in
// one transaction: the helper refusing puts the rows back. What changed ([] and no apply
// when nothing did). Every 20 seconds in the panel, and `pammy-panel hosts-apply`.
export async function followSoftware(db: Sql, routesSocket: string, installs: Install[], now: number, actor = 'the panel') {
  return tx(db, async (q) => {
    const changed = await syncSoftware(q, installs, now, actor);
    if (changed.length) await applyTable(routesSocket, await pammyTable(q));
    return changed;
  });
}

// The installer's seed (`pammy-panel hosts-seed`): the home domain from the profile (folder
// hosts on, Cloudflare's origin certificate), pammy.org and www with the whole website and
// /api/, the software routes; then the files written. Safe on every install: what is there
// already stays.
export async function seedHosts(db: Sql, installs: Install[], now: number, actor = 'installer') {
  const domain = await seedHomeDomain(db, WITH_HOSTS, now, actor);
  const home = (await homeDomain(db))!;
  if (!home.folder_hosts) throw new Error('pammy.org\'s domain row has folder hosts off: every <folder>.pammy.org would be a 404');
  const made = await tx(db, async (q) => {
    const out: string[] = [];
    const apex = await hostMade(q, '@', now, actor, true);
    if (await routeMade(q, apex, '/', 'site', {}, now, actor)) out.push('pammy.org/: the whole website');
    if (await routeMade(q, apex, '/api/', 'proxy', { port: API_PORT, websockets: true }, now, actor)) out.push(`pammy.org/api/: pamela-app (127.0.0.1:${API_PORT})`);
    out.push(...await syncSoftware(q, installs, now, actor));
    return out;
  });
  return { domain, made, table: await pammyTable(db) };
}
