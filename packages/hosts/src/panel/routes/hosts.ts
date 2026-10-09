// Hosts, their routes, and site folders (docs/hosts-plan.md H1, H8, H9): the
// panel's side. The table lives in panel.hosts / routes, and the site folders'
// records are the files module's (@panel/files/site-folders/store, docs/phase8b-plan.md
// 8b-9: only it touches panel.site_folders; a route points at a folder by its id); the
// routing helper (lfdln-routes) turns the whole of it into nginx. Every change is
// made inside a transaction that also has the helper apply the new table, so if
// nginx refuses it, the change is rolled back too: the table and nginx never
// disagree. Site folders on disk are the folder helper's (the same one pammy.org
// uses for her folders, with lfdln's sites root).
//
// A person kept to places (on lfdln a place is a host, "/tutor"): only their
// hosts, the routes on them, and the site folders those routes show. Making or
// deleting a host or a site folder is about the whole site (wholeSite).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { callJsonLine, CallError } from '@panel/core/jsonline';
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { HELPER_STATUS, type PanelCtx } from '@panel/core/panel/context';
import { keptTo } from '@panel/core/panel/rights';
import type { Authed } from '@panel/core/sessions';
import { APEX, domainName, folderName, hostName, LABEL_RE, NameError, newHostName, redirectStatus, redirectTo, routePath } from '../../names.ts';

// a name on a certificate for named hosts (step 7): "www" and "admin" too, one label
const hostNameOrWww = (v: string) => {
  if (!LABEL_RE.test(v)) throw new NameError('A name on the certificate is "@" (the domain itself) or one name like www or admin.');
  return v;
};
import type { Route, ServicePart, Table } from '../../render.ts';
import type { PanelRouteKind } from '../route-kinds.ts';
import { domainsFrom, homeDomain, ON_HOME, type DomainRow } from '../../domains.ts';
import { addFolder, allFolders, dropFolder, folderById, folderByName, setRunPhp, type FolderRow } from '@panel/files/site-folders/store';

type HostRow = {
  id: number; name: string; enabled: boolean; with_www: boolean; adopted: boolean; created_by: string | null; created_at: number;
  domain_id: number | null; origin: 'hand' | 'folder' | 'adopted';
  // (HOSTS_SQL) its domain's name, and whether that is the home one (docs/domains-hosts-plan.md step 7)
  domain_name?: string | null; on_home?: boolean;
};
// every host with its domain's name
const HOSTS_SQL = 'SELECT h.*, d.name AS domain_name, coalesce(d.home, true) AS on_home FROM hosts h LEFT JOIN domains d ON d.id = h.domain_id';
// target_kind and target_ref (docs/domains-hosts-plan.md step 2): what the route shows, and
// that kind's own fields; a site folder route names its folder in folder_id
type RouteRow = {
  id: number; host_id: number; path: string; target_kind: string; target_ref: Record<string, unknown>; folder_id: number | null;
  enabled: boolean; created_at: number;
  // accounts on the route (docs/roles-plan.md step 5): its area's token in the gate, and which built-in set
  area_token: string | null; accounts: 'open' | 'private' | null;
};

// The whole table, as the routing helper takes it. services: the adopted services'
// parts and their ports (the services helper's record, docs/adopt-plan.md V7);
// the routing helper checks them against that record again.
export async function tableFrom(q: Db, services: ServicePart[] = []): Promise<Table> {
  const hosts = await all<HostRow>(q, `${HOSTS_SQL} ORDER BY h.name, d.name`);
  const folders = await allFolders(q);
  const routes = await all<RouteRow>(q, 'SELECT * FROM routes ORDER BY id');
  // the domains' rows (docs/domains-hosts-plan.md step 1): none before the installer seeds the home one
  const domains = await domainsFrom(q);
  const hostOf = new Map(hosts.map((h) => [h.id, h]));
  // a host on another domain says which (step 7); the home domain's say nothing, as before
  const onOther = (h: HostRow | undefined) => (h && !h.on_home && h.domain_name ? { domain: h.domain_name } : {});
  const folderNameOf = new Map(folders.map((f) => [f.id, f.name]));
  return {
    hosts: hosts.map((h) => ({ name: h.name, enabled: h.enabled, ...(h.with_www ? { withWww: true } : {}), ...onOther(h) })),
    folders: folders.map((f) => ({ name: f.name, runPhp: f.run_php })),
    // each route as its kind names its fields (render.ts RouteKind.fields checks them)
    routes: routes.map((r): Route => ({
      host: hostOf.get(r.host_id)!.name, ...onOther(hostOf.get(r.host_id)), path: r.path, enabled: r.enabled, ...(r.area_token ? { accounts: { token: r.area_token } } : {}),
      kind: r.target_kind, ...r.target_ref, ...(r.folder_id !== null ? { folder: folderNameOf.get(r.folder_id)! } : {}),
    })),
    ...(services.length ? { services } : {}),
    ...(domains.length ? { domains } : {}),
  };
}

// kinds: what else a route may show on the site besides a site folder and a redirect
// (docs/domains-hosts-plan.md step 2): each module's own (lfdln: a service).
// accounts: on a site whose gate has people (docs/roles-plan.md step 5), whether a route
// may be "Open with accounts" (the switch on Settings > Visitors); none, and no route can have accounts.
export function routes(app: FastifyInstance, ctx: PanelCtx, opts: { kinds?: PanelRouteKind[]; accounts?: () => Promise<{ open: boolean }> } = {}) {
  const { config, db, now, need, body, idParam, actorOf, helper, gate } = ctx;
  const domain = config.site.domain;
  // the routing helper; a refusal is said the way the panel says a helper's
  const routesHelper = async <T>(req: Record<string, unknown>): Promise<T> => {
    if (!config.routesSocket) throw new AccountError("This site has no routing helper.", 503);
    try { return await callJsonLine<T>(config.routesSocket, req, 'routing helper', 150_000); } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };
  // A change and nginx together: the change, the whole table read back, and the
  // helper applying it, all inside one transaction. The helper refusing (nginx -t
  // said no) throws, and the transaction rolls back.
  const commit = <T>(change: (q: Db) => Promise<T>) => tx(db, async (q) => {
    const out = await change(q);
    await routesHelper({ op: 'apply', table: await tableFrom(q, await servicesFor(q)) });
    return out;
  });
  const named = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof NameError) throw new AccountError(e.message, 400);
      throw e;
    }
  };

  // ---------------------------------------------------------------- what a person may see
  // kept to places: only the hosts that are their places, and what those show
  const mine = (a: Authed) => {
    const places = keptTo(a.user);
    return places === null ? null : new Set(places.map((p) => p.slice(1)));
  };
  // (a place is a home domain host: another domain's are the whole site's, step 7)
  const isMine = (m: Set<string> | null, h: HostRow) => !m || (h.on_home !== false && m.has(h.name));
  const hostOf = async (q: Db, a: Authed, id: number) => {
    const h = await one<HostRow>(q, `${HOSTS_SQL} WHERE h.id = ?`, id);
    if (!h || !isMine(mine(a), h)) throw new AccountError('That host no longer exists.', 404);
    return h;
  };
  // the site folders a person kept to places may point a route at: those their hosts show already
  const folderIdsOf = async (q: Db, a: Authed): Promise<Set<number> | null> => {
    const m = mine(a);
    if (!m) return null;
    const rows = await all<{ folder_id: number; name: string }>(q,
      `SELECT r.folder_id, h.name FROM routes r JOIN hosts h ON h.id = r.host_id WHERE r.folder_id IS NOT NULL AND ${ON_HOME.replace(/domain_id/g, 'h.domain_id')}`);
    return new Set(rows.filter((r) => m.has(r.name)).map((r) => r.folder_id));
  };
  const folderOf = async (q: Db, a: Authed, id: number) => {
    const f = await folderById(q, id);
    const allowed = await folderIdsOf(q, a);
    if (!f || (allowed && !allowed.has(f.id))) throw new AccountError('That site folder no longer exists.', 404);
    return f;
  };
  const routeOf = async (q: Db, a: Authed, id: number) => {
    const r = await one<RouteRow>(q, 'SELECT * FROM routes WHERE id = ?', id);
    if (!r) throw new AccountError('That route no longer exists.', 404);
    return { route: r, host: await hostOf(q, a, r.host_id) };
  };
  // ("@": the domain itself, docs/adopt-plan.md V2); a host's row: on its own domain (step 7)
  const address = (h: string | HostRow, path = '/') => {
    const [name, on] = typeof h === 'string' ? [h, domain] : [h.name, h.domain_name ?? domain];
    return `https://${name === APEX ? '' : `${name}.`}${on}${path}`;
  };

  // ---------------------------------------------------------------- the list
  app.get('/api/hosts', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const m = mine(a);
    const hosts = (await all<HostRow>(db, `${HOSTS_SQL} ORDER BY d.home DESC NULLS FIRST, d.name, h.name`)).filter((h) => isMine(m, h));
    const routes = await all<RouteRow>(db, 'SELECT * FROM routes ORDER BY path');
    const allowed = await folderIdsOf(db, a);
    const folders = (await allFolders(db)).filter((f) => !allowed || allowed.has(f.id));
    const folderName = new Map(folders.map((f) => [f.id, f.name]));
    const onDisk = new Set((await helper<{ folders: { name: string }[] }>({ op: 'list', actor: a.user.username })).folders.map((f) => f.name));
    // each route's area in the gate, for its Access page (docs/roles-plan.md step 6)
    const areaOf = new Map(opts.accounts && routes.some((r) => r.area_token)
      ? (await gate<{ areas: { id: number; routeId: number | null }[] }>({ op: 'state' }).catch(() => ({ areas: [] }))).areas
        .filter((x) => x.routeId !== null).map((x) => [x.routeId!, x.id])
      : []);
    return {
      domain,
      // accounts on a route (step 5): whether this site has them, and whether "Open with accounts" is on
      accounts: opts.accounts ? await opts.accounts().catch(() => null) : null,
      hosts: hosts.map((h) => ({
        id: h.id, name: h.name, enabled: h.enabled, address: address(h), createdBy: h.created_by, createdAt: h.created_at,
        adopted: h.adopted, withWww: h.with_www, domain: h.domain_name ?? domain, onHome: h.on_home !== false,
        routes: routes.filter((r) => r.host_id === h.id).map((r) => ({
          // the kind's own fields as they are (a folder's spa and headers, a redirect's to, a service's part)
          ...r.target_ref,
          id: r.id, path: r.path, kind: r.target_kind, enabled: r.enabled, address: address(h, r.path),
          folderId: r.folder_id, folder: r.folder_id ? folderName.get(r.folder_id) ?? null : null,
          accounts: r.accounts, accessId: areaOf.get(r.id) ?? null,
        })),
      })),
      // what a route may show here, and what each kind's form offers (a service's parts)
      kinds: allKinds.map((k) => ({ kind: k.kind, label: k.label })),
      ...Object.assign({}, ...await Promise.all(extra.map((k) => (k.options ? k.options(a).catch(() => ({})) : {})))),
      folders: folders.map((f) => ({
        id: f.id, name: f.name, runPhp: f.run_php, adopted: f.adopted, exists: onDisk.has(f.name), createdBy: f.created_by, createdAt: f.created_at,
        shownAt: routes.filter((r) => r.folder_id === f.id).map((r) => {
          const h = hosts.find((x) => x.id === r.host_id);
          return h ? address(h, r.path) : null;
        }).filter(Boolean),
      })),
    };
  });

  // The DreamHost zone's names, so the page can say which are taken before anyone types.
  app.get('/api/hosts/zone', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    try { return { ok: true, ...await routesHelper<{ taken: string[]; readAt: number }>({ op: 'zone' }) }; } catch (e) {
      if (e instanceof AccountError && e.status === 503) return { ok: false, message: e.message };
      throw e;
    }
  });

  // ---------------------------------------------------------------- checks (docs/domains-hosts-plan.md step 3)
  // For each host a person may see: does its DNS point here, does nginx's certificate cover
  // it (and for how long), does it answer. The routing helper runs them and keeps the
  // answers 10 minutes; ?again=1 asks now (at most once a minute).
  type HostCheck = { name: string; checkedAt: number | null; dns?: unknown; cert?: unknown; answers?: unknown };
  app.get('/api/hosts/checks', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const m = mine(a);
    const hosts = (await all<HostRow>(db, `${HOSTS_SQL} ORDER BY h.name`)).filter((h) => isMine(m, h));
    const home = await homeDomain(db);
    const domains = await all<DomainRow>(db, 'SELECT * FROM domains');
    const onOf = (h: HostRow) => domains.find((x) => x.id === h.domain_id) ?? home;
    const namesOf = (h: HostRow) => {
      const on = onOf(h)?.name ?? domain;
      return h.name === APEX ? [on, ...(h.with_www ? [`www.${on}`] : [])] : [`${h.name}.${on}`];
    };
    // one ask a domain (each its own front, step 7); "again" only on the first, which the helper limits anyway
    const again = (req.query as { again?: string }).again === '1';
    const groups = new Map<string, HostRow[]>();
    for (const h of hosts) groups.set(onOf(h)?.name ?? domain, [...(groups.get(onOf(h)?.name ?? domain) ?? []), h]);
    if (!groups.size) groups.set(home?.name ?? domain, []);
    const byName = new Map<string, HostCheck>();
    let againIn = 0;
    for (const [on, list] of groups) {
      const d = domains.find((x) => x.name === on);
      const r = await routesHelper<{ checks: HostCheck[]; againIn: number }>({
        op: 'check', domain: on, front: d?.front ?? config.site.front, again,
        hosts: list.map((h) => ({ name: h.name, withWww: h.with_www })),
      });
      for (const c of r.checks) byName.set(c.name, c);
      againIn = Math.max(againIn, r.againIn);
    }
    return {
      againIn,
      hosts: hosts.map((h) => ({ id: h.id, checks: namesOf(h).map((n) => byName.get(n) ?? { name: n, checkedAt: null }) })),
    };
  });

  // ---------------------------------------------------------------- domains (docs/domains-hosts-plan.md step 4)
  // The site's domains and their settings; the setup guide's checks; Add a domain (Turn on)
  // and removing one nobody uses. The home domain is the installer's, from the profile.
  type Need = { key: string; label: string; ok: boolean; why: string; required: boolean };
  const domainView = (d: DomainRow, hosts: number) => ({
    id: d.id, name: d.name, home: d.home, dns: d.dns, front: d.front, cert: d.cert, tls: d.tls, certNames: d.cert_names,
    wildcardRecord: d.wildcard_record, folderHosts: d.folder_hosts, hosts, createdBy: d.created_by, createdAt: d.created_at,
  });
  const DNS = ['cloudflare', 'dreamhost', 'manual'] as const;
  const FRONT = ['cloudflare', 'direct'] as const;
  // one per host (HTTP-01, each new host waiting for certbot) comes later: the guide says so
  // names: a certificate for named hosts only, and no catch-all (step 7)
  const CERT = ['wildcard-dns', 'cloudflare-origin', 'files', 'names'] as const;
  const answers = (b: Record<string, unknown>) => {
    const name = named(() => domainName(b.name));
    const one = <T extends string>(v: unknown, of: readonly T[], what: string): T => {
      if (!of.includes(v as T)) throw new AccountError(`${what} is one of: ${of.join(', ')}.`, 400);
      return v as T;
    };
    const t = (b.tls && typeof b.tls === 'object' ? b.tls : null) as Record<string, unknown> | null;
    const cert = one(b.cert ?? 'files', CERT, 'The certificate');
    // the names it covers: the domain itself ("@") or a name under it, as the guide asks them
    const names = cert !== 'names' ? null : (Array.isArray(b.names) ? b.names : []).slice(0, 50).map((n) => named(() => {
      const v = String(n).trim().toLowerCase();
      return v === '@' || v === name ? name : `${hostNameOrWww(v)}.${name}`;
    }));
    if (names && !names.length) throw new AccountError('Say which names the certificate is for.', 400);
    return {
      name, dns: one(b.dns ?? 'manual', DNS, 'Who keeps its DNS'), front: one(b.front ?? 'direct', FRONT, 'What is in front'),
      cert, names: names ? [...new Set(names)].sort() : null, wildcardRecord: cert === 'names' ? false : b.wildcardRecord === true,
      tls: t ? { cert: String(t.cert ?? ''), key: String(t.key ?? ''), ...(Array.isArray(t.include) ? { include: t.include.map(String).slice(0, 5) } : {}), ...(typeof t.dhparam === 'string' && t.dhparam ? { dhparam: t.dhparam } : {}) } : null,
    };
  };
  // the routing helper's checks, and first the panel's own: not a domain here already, nor
  // inside one or around one (nginx would answer those names from the other's hosts)
  const checkDomain = async (a: ReturnType<typeof answers> | { name: string; dns: string; front: string; wildcardRecord: boolean; tls: unknown; names: string[] | null }, self?: number) => {
    const others = (await all<{ id: number; name: string }>(db, 'SELECT id, name FROM domains ORDER BY name')).filter((d) => d.id !== self);
    const clash = others.find((d) => d.name === a.name || a.name.endsWith(`.${d.name}`) || d.name.endsWith(`.${a.name}`));
    const own: Need = { key: 'name', label: 'Not a domain here already, nor inside one', required: true, ok: !clash,
      why: !clash ? 'a domain of its own' : clash.name === a.name ? `${a.name} is a domain here already` : `${clash.name} is a domain here, and one is inside the other` };
    const r = await routesHelper<{ domain: string; checks: Need[]; ok: boolean }>({ op: 'check-domain', domain: a.name, dns: a.dns, front: a.front, wildcardRecord: a.wildcardRecord, tls: a.tls, names: a.names });
    return { ...r, checks: [own, ...r.checks], ok: r.ok && own.ok };
  };

  app.get('/api/domains', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const rows = await all<DomainRow>(db, 'SELECT * FROM domains ORDER BY home DESC, name');
    const counts = new Map((await all<{ domain_id: number; n: number }>(db, 'SELECT domain_id, count(*)::int AS n FROM hosts GROUP BY domain_id')).map((r) => [r.domain_id, r.n]));
    return { domains: rows.map((d) => domainView(d, counts.get(d.id) ?? 0)) };
  });

  app.get('/api/domains/:id/checks', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const d = await one<DomainRow>(db, 'SELECT * FROM domains WHERE id = ?', idParam(req, 'id'));
    if (!d) throw new AccountError('That domain no longer exists.', 404);
    const r = await checkDomain({ name: d.name, dns: d.dns, front: d.front, wildcardRecord: d.wildcard_record, tls: d.tls, names: d.cert === 'names' ? d.cert_names : null }, d.id);
    await run(db, 'UPDATE domains SET zone_checked_at = ?, zone_readable = ? WHERE id = ?', now(), r.checks.find((c) => c.key === 'zone')?.ok ?? null, d.id);
    return r;
  });

  // the guide: its answers so far, checked; nothing is saved
  app.post('/api/domains/check', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return checkDomain(answers(body(req)));
  });

  // Turn on: every required check passes again here, then the row and nginx together (its
  // catch-all), then a made-up name under it is asked for real
  app.post('/api/domains', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const b = body(req);
    if (b.folderHosts === true) throw new AccountError('A top-level folder as a host of its own comes with pammy.org\'s move to hosts (step 5).', 400);
    const x = answers(b);
    if (!x.tls) throw new AccountError('The certificate\'s files are needed.', 400);
    const checked = await checkDomain(x);
    const failed = checked.checks.filter((c) => c.required && !c.ok);
    if (failed.length) throw new AccountError(`Not yet: ${failed.map((c) => `${c.label} -- ${c.why}`).join('; ')}.`, 409);
    const id = await commit(async (q) => {
      const r = (await one<{ id: number }>(q,
        `INSERT INTO domains (name, dns, front, cert, cert_names, tls, wildcard_record, folder_hosts, created_by, created_at)
         VALUES (?, ?, ?, ?, ARRAY(SELECT jsonb_array_elements_text(?::text::jsonb)), ?::text::jsonb, ?, false, ?, ?) RETURNING id`,
        x.name, x.dns, x.front, x.cert, JSON.stringify(x.names ?? []), JSON.stringify(x.tls), x.wildcardRecord, a.user.username, now()))!;
      await logActivity(q, now(), actorOf(a, req), 'domain-added', x.name, `DNS: ${x.dns}; front: ${x.front}; certificate: ${x.cert}${x.names ? ` (${x.names.join(', ')})` : ''}${x.wildcardRecord ? '; * record' : ''}`);
      return r.id;
    });
    // (a domain with named certificates has no catch-all: a made-up name isn't the panel's)
    if (x.names) return { ok: true, id, test: null };
    const probe = `zz-check-${Math.random().toString(36).slice(2, 8)}`;
    const test = await routesHelper<{ checks: Record<string, unknown>[] }>({ op: 'check', domain: x.name, front: x.front, hosts: [{ name: probe }], again: false })
      .then((r) => r.checks[0] ?? null).catch(() => null);
    return { ok: true, id, test };
  });

  app.post('/api/domains/:id/delete', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    await commit(async (q) => {
      const d = await one<DomainRow>(q, 'SELECT * FROM domains WHERE id = ?', idParam(req, 'id'));
      if (!d) throw new AccountError('That domain no longer exists.', 404);
      if (d.home) throw new AccountError(`${d.name} is this panel's own domain.`, 409);
      if (await one(q, 'SELECT 1 FROM hosts WHERE domain_id = ?', d.id)) throw new AccountError(`${d.name} has hosts: delete them first.`, 409);
      await run(q, 'DELETE FROM domains WHERE id = ?', d.id);
      await logActivity(q, now(), actorOf(a, req), 'domain-removed', d.name, null);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- hosts
  // A new name: the server's own and DreamHost's are refused, and so is every
  // name while the zone can't be read (Q3).
  // origin: made by hand, or with its site folder (and deleted with it, docs/domains-hosts-plan.md part 2)
  // on: the domain it is on (7-6); none, the home one. Another domain's zone isn't read here
  // (step 4: its zone check is always ✗), and "@" is no name in a zone: neither asks the helper.
  // A domain whose certificate is for named hosts takes only those (7-1), www beside "@" too.
  const newHost = async (q: Db, a: Authed, req: FastifyRequest, name: string, origin: 'hand' | 'folder' = 'hand', on: DomainRow | null = null, withWww = false) => {
    const other = on && !on.home ? on : null;
    const d = other?.name ?? domain;
    const shown = name === APEX ? d : `${name}.${d}`;
    if (!other && name !== APEX) await routesHelper({ op: 'check-name', name });
    if (other?.cert === 'names') {
      const missing = [shown, ...(withWww ? [`www.${d}`] : [])].filter((n) => !other.cert_names.includes(n));
      if (missing.length) throw new AccountError(`${d}'s certificate covers ${other.cert_names.join(', ')} only, not ${missing.join(' or ')}.`, 400);
    }
    if (await one(q, `SELECT 1 FROM hosts WHERE name = ? AND ${other ? 'domain_id = ?' : ON_HOME}`, name, ...(other ? [other.id] : []))) throw new AccountError(`${shown} is already a host.`, 409);
    const h = (await one<HostRow>(q, 'INSERT INTO hosts (name, with_www, origin, domain_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
      name, withWww, origin, other?.id ?? null, a.user.username, now()))!;
    const row = { ...h, domain_name: other?.name ?? null };
    await logActivity(q, now(), actorOf(a, req), 'host-created', address(row), withWww ? `www.${d} beside it` : null);
    return row;
  };

  app.post('/api/hosts', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    // the domain it goes on (7-6): by its name; none, the home one
    let on: DomainRow | null = null;
    if (b.domain !== undefined && b.domain !== null && b.domain !== '') {
      const n = named(() => domainName(b.domain));
      on = (await one<DomainRow>(db, 'SELECT * FROM domains WHERE name = ?', n)) ?? null;
      if (!on) throw new AccountError(`${n} isn't a domain here.`, 404);
    }
    const name = named(() => newHostName(b.name));
    const h = await commit((q) => newHost(q, a, req, name, 'hand', on, name === APEX && b.withWww === true));
    return { ok: true, id: h.id, address: address(h) };
  });

  app.post('/api/hosts/:id', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const enabled = body(req).enabled;
    if (typeof enabled !== 'boolean') throw new AccountError('Say whether it is on or off.', 400);
    await commit(async (q) => {
      const h = await hostOf(q, a, idParam(req, 'id'));
      if (h.enabled === enabled) return;
      await run(q, 'UPDATE hosts SET enabled = ? WHERE id = ?', enabled, h.id);
      await logActivity(q, now(), actorOf(a, req), enabled ? 'host-started' : 'host-stopped', address(h), null);
    });
    return { ok: true };
  });

  app.post('/api/hosts/:id/delete', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    await commit(async (q) => {
      const h = await hostOf(q, a, idParam(req, 'id'));
      await noAccounts(q, 'SELECT r.path FROM routes r WHERE r.host_id = ? AND r.area_token IS NOT NULL ORDER BY r.path', h.id, (p) => address(h, p));
      await run(q, 'DELETE FROM hosts WHERE id = ?', h.id);     // its routes go with it
      await logActivity(q, now(), actorOf(a, req), 'host-deleted', address(h), 'its routes too; site folders stay');
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- routes
  // What a route shows (docs/domains-hosts-plan.md step 2): a kind, which checks what the
  // page sent. This module's own two, then the site's others.
  const folderKind: PanelRouteKind = {
    kind: 'folder', label: 'Show a site folder', accounts: true,
    make: async (q, a, b) => {
      const f = await folderOf(q, a, Number(b.folderId));
      return { folderId: f.id, ref: { spa: b.spa === true, headers: [], cacheForever: [] }, what: `site folder ${f.name}` };
    },
  };
  const redirectKind: PanelRouteKind = {
    kind: 'redirect', label: 'Redirect', accounts: false,
    make: async (_q, _a, b) => {
      const to = named(() => redirectTo(b.to));
      const status = named(() => redirectStatus(b.status));
      return { ref: { to, status, keepPath: b.keepPath !== false }, what: `redirect ${status} to ${to}` };
    },
  };
  const extra = opts.kinds ?? [];
  const allKinds = [folderKind, ...extra, redirectKind];
  const kindOf = (k: unknown) => {
    const found = allKinds.find((x) => x.kind === k);
    if (!found) throw new AccountError(`A route here ${allKinds.map((x) => x.label.toLowerCase()).join(', or ')}.`, 400);
    return found;
  };
  // what the routing helper's table needs from the kinds whose routes are there (the services' ports)
  const servicesFor = async (q: Db): Promise<ServicePart[]> => {
    const present = new Set((await all<{ target_kind: string }>(q, 'SELECT DISTINCT target_kind FROM routes')).map((r) => r.target_kind));
    const lists = await Promise.all(extra.filter((k) => k.services && present.has(k.kind)).map((k) => k.services!()));
    return lists.flat().map(({ service, part, port }) => ({ service, part, port }));
  };

  app.post('/api/hosts/:id/routes', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const path = named(() => routePath(b.path));
    const id = await commit(async (q) => {
      const h = await hostOf(q, a, idParam(req, 'id'));
      if (await one(q, 'SELECT 1 FROM routes WHERE host_id = ? AND path = ?', h.id, path)) throw new AccountError(`${address(h, path)} already has a route.`, 409);
      const k = kindOf(b.kind);
      const t = await k.make(q, a, b);
      const r = (await one<{ id: number }>(q,
        'INSERT INTO routes (host_id, path, target_kind, target_ref, folder_id, created_by, created_at) VALUES (?, ?, ?, ?::text::jsonb, ?, ?, ?) RETURNING id',
        h.id, path, k.kind, JSON.stringify(t.ref), t.folderId ?? null, a.user.username, now()))!;
      await logActivity(q, now(), actorOf(a, req), 'route-created', address(h, path), t.what);
      return r.id;
    });
    return { ok: true, id };
  });

  // switched on or off, and a folder route's single-page-app switch
  app.post('/api/routes/:id', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    await commit(async (q) => {
      const { route: r, host: h } = await routeOf(q, a, idParam(req, 'id'));
      const said: string[] = [];
      if (typeof b.enabled === 'boolean' && b.enabled !== r.enabled) {
        await run(q, 'UPDATE routes SET enabled = ? WHERE id = ?', b.enabled, r.id);
        said.push(b.enabled ? 'started' : 'stopped');
      }
      if (typeof b.spa === 'boolean' && b.spa !== (r.target_ref.spa === true) && r.target_kind === 'folder') {
        await run(q, "UPDATE routes SET target_ref = jsonb_set(target_ref, '{spa}', to_jsonb(?::boolean)) WHERE id = ?", b.spa, r.id);
        said.push(b.spa ? 'single-page app: on' : 'single-page app: off');
      }
      if (said.length) await logActivity(q, now(), actorOf(a, req), 'route-changed', address(h, r.path), said.join(', '));
    });
    return { ok: true };
  });

  app.post('/api/routes/:id/delete', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await commit(async (q) => {
      const { route: r, host: h } = await routeOf(q, a, idParam(req, 'id'));
      if (r.area_token) throw new AccountError(`${address(h, r.path)} has accounts: set it to "Open to anyone" first, so nobody's role there goes by accident.`, 409);
      await run(q, 'DELETE FROM routes WHERE id = ?', r.id);
      await logActivity(q, now(), actorOf(a, req), 'route-deleted', address(h, r.path), null);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- accounts on a route
  // (docs/roles-plan.md step 5, S5-3 and S5-6) Open to anyone (null), Open with
  // accounts ('open') or Only people let in ('private'). The gate keeps the area
  // and its people; the route keeps the area's token, and nginx follows the table.
  // On: the area first, then nginx (undone if nginx refuses). Off: nginx first,
  // so nothing asks the gate about an area that is going, then the area.
  app.post('/api/routes/:id/accounts', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const want = body(req).accounts ?? null;
    if (want !== null && want !== 'open' && want !== 'private') throw new AccountError('Accounts are open, private, or none.', 400);
    if (!opts.accounts) throw new AccountError('This site has no accounts for visitors.', 409);
    const { route: r, host: h } = await routeOf(db, a, idParam(req, 'id'));
    if (r.accounts === want) return { ok: true, accounts: want, lost: [] };
    if (want !== null && !(allKinds.find((k) => k.kind === r.target_kind)?.accounts)) throw new AccountError(r.target_kind === 'redirect' ? 'A redirect has nothing to open, so it can\'t have accounts.' : 'A route like this can\'t have accounts.', 400);
    if (want !== null && r.path.startsWith('/_pammy/')) throw new AccountError('/_pammy/ is where the sign-in pages are.', 400);
    // (the gate answers for the home domain's hosts only, step 7; nginx would refuse it anyway)
    if (want !== null && h.on_home === false) throw new AccountError(`Accounts are only on ${domain}'s routes for now, not ${h.domain_name}'s.`, 400);
    const where = address(h, r.path).replace(/^https:\/\//, '');
    const words = { open: 'open with accounts', private: 'only people let in' } as const;
    if (want === null) {
      await commit(async (q) => { await run(q, 'UPDATE routes SET area_token = NULL, accounts = NULL WHERE id = ?', r.id); });
      const done = await gate<{ lost: string[] }>({ op: 'route-area.set', routeId: r.id, accounts: null, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'route-accounts', address(h, r.path),
        `open to anyone${done.lost.length ? `; ${done.lost.length === 1 ? '1 person' : `${done.lost.length} people`} lost their role there (${done.lost.join(', ')})` : ''}`);
      return { ok: true, accounts: null, lost: done.lost };
    }
    const made = await gate<{ token: string; lost: string[] }>({ op: 'route-area.set', routeId: r.id, accounts: want, address: where, actor: a.user.username });
    try {
      await commit(async (q) => { await run(q, 'UPDATE routes SET area_token = ?, accounts = ? WHERE id = ?', made.token, want, r.id); });
    } catch (e) {
      // nginx said no: the area goes again if it was new (its people, if any, stay as they were)
      if (!r.area_token) await gate({ op: 'route-area.set', routeId: r.id, accounts: null, actor: a.user.username }).catch(() => {});
      else await gate({ op: 'route-area.set', routeId: r.id, accounts: r.accounts, address: where, actor: a.user.username }).catch(() => {});
      throw e;
    }
    await logActivity(db, now(), actorOf(a, req), 'route-accounts', address(h, r.path),
      `${words[want]}${made.lost.length ? `; ${made.lost.join(', ')} lost their role there` : ''}`);
    return { ok: true, accounts: want, lost: made.lost };
  });

  // Refused while any of these routes has accounts (S5-6): its people's roles would go with it.
  async function noAccounts(q: Db, sql: string, id: number, where: (path: string) => string) {
    const gated = await all<{ path: string }>(q, sql, id);
    if (gated.length) {
      throw new AccountError(`${gated.map((g) => where(g.path)).join(', ')} ${gated.length === 1 ? 'has' : 'have'} accounts: set ${gated.length === 1 ? 'it' : 'them'} to "Open to anyone" first, so nobody's role there goes by accident.`, 409);
    }
  }

  // ---------------------------------------------------------------- site folders
  // Add a static folder (G3b): the folder on disk with a placeholder page, then,
  // by default, the host of the same name showing it. The name is checked as a
  // host first, so nothing is made on disk for a name that would be refused.
  app.post('/api/site-folders', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const name = named(() => folderName(b.name));
    // (a site folder's media folder is <name>/media: a folder called media would be one; P8-5)
    if (name === 'media') throw new AccountError('Please pick another name: "media" is what a site folder\'s media folder is called.', 400);
    const withHost = b.host !== false;
    if (withHost) {
      named(() => hostName(name));
      await routesHelper({ op: 'check-name', name });
    }
    if (await folderByName(db, name)) throw new AccountError(`There is already a site folder called ${name}.`, 409);
    if (withHost && await one(db, `SELECT 1 FROM hosts WHERE name = ? AND ${ON_HOME}`, name)) throw new AccountError(`${name}.${domain} is already a host.`, 409);
    await helper({ op: 'create', name, actor: a.user.username });
    try {
      const made = await commit(async (q) => {
        const f = await addFolder(q, { name, runPhp: b.runPhp !== false, actor: a.user.username, now: now() });
        await logActivity(q, now(), actorOf(a, req), 'site-folder-created', name, withHost ? `shown at ${address(name)}` : 'not shown anywhere yet');
        if (!withHost) return { folder: f.id, host: null };
        const h = await newHost(q, a, req, name, 'folder');
        await run(q, `INSERT INTO routes (host_id, path, target_kind, target_ref, folder_id, created_by, created_at)
                      VALUES (?, '/', 'folder', '{"spa":false,"headers":[],"cacheForever":[]}', ?, ?, ?)`, h.id, f.id, a.user.username, now());
        return { folder: f.id, host: h.id };
      });
      return { ok: true, ...made, address: withHost ? address(name) : null };
    } catch (e) {
      // nothing points at the new folder: it goes to the trash, not left behind
      await helper({ op: 'trash', name, actor: a.user.username }).catch(() => {});
      throw e;
    }
  });

  app.post('/api/site-folders/:id', { config: { needs: 'hosts' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const runPhp = body(req).runPhp;
    if (typeof runPhp !== 'boolean') throw new AccountError('Say whether PHP pages run.', 400);
    await commit(async (q) => {
      const f = await folderOf(q, a, idParam(req, 'id'));
      if (f.run_php === runPhp) return;
      await setRunPhp(q, f.id, runPhp);
      await logActivity(q, now(), actorOf(a, req), 'site-folder-changed', f.name, runPhp ? 'PHP pages run' : 'PHP pages don\'t run');
    });
    return { ok: true };
  });

  // Delete (G3b, platform plan D2): a folder made from the panel, its routes first (and
  // nginx with them); or one that was on the server before the panel, once no route shows
  // it any more (the way a site that moved to a service leaves its old folder). The host
  // made with the folder goes with it when nothing else is on it; then the folder goes to
  // the trash, for 30 days.
  app.post('/api/site-folders/:id/delete', { config: { needs: 'hosts', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const f = await folderOf(db, a, idParam(req, 'id'));
    if (f.adopted) {
      const shown = await all<HostRow & { path: string }>(db, 'SELECT h.*, d.name AS domain_name, r.path FROM routes r JOIN hosts h ON h.id = r.host_id LEFT JOIN domains d ON d.id = h.domain_id WHERE r.folder_id = ? ORDER BY h.name, r.path', f.id);
      if (shown.length) {
        throw new AccountError(`${f.name} was on the server before the panel, so it goes only once nothing shows it: remove the route${shown.length === 1 ? '' : 's'} at ${shown.map((x) => address(x, x.path)).join(', ')} first.`, 409);
      }
    }
    await commit(async (q) => {
      await noAccounts(q, 'SELECT h.name || \'|\' || r.path AS path FROM routes r JOIN hosts h ON h.id = r.host_id WHERE r.folder_id = ? AND r.area_token IS NOT NULL ORDER BY 1', f.id,
        (p) => address(p.split('|')[0]!, p.split('|')[1]));
      const n = await run(q, 'DELETE FROM routes WHERE folder_id = ?', f.id);
      await dropFolder(q, f.id);
      const hosts = await run(q, `DELETE FROM hosts h WHERE h.origin = 'folder' AND h.name = ? AND ${ON_HOME.replace(/domain_id/g, 'h.domain_id')} AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.host_id = h.id)`, f.name);
      const said = [n ? `and its ${n === 1 ? 'route' : `${n} routes`}` : null, hosts ? `the host ${address(f.name)} made with it` : null, f.adopted ? 'it was on the server before the panel' : null];
      await logActivity(q, now(), actorOf(a, req), 'site-folder-deleted', f.name, said.filter(Boolean).join('; ') || null);
    });
    const t = await helper<{ purgeAt: number }>({ op: 'trash', name: f.name, actor: a.user.username });
    return { ok: true, purgeAt: t.purgeAt };
  });
}
