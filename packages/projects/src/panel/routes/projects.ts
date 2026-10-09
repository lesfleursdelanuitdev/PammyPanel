// The Projects page (docs/phase8b-plan.md). 8b-1: the build environment and its check, and
// the jobs. 8b-2: static projects -- New project, Rebuild, Roll back, Delete. 8b-3: owners
// (only an owner or an admin changes a project: D3-1), the dev branch on or off, Put dev
// live. 8b-4a: a Next.js server's Start / Stop / Restart and its log. 8b-4b: each branch's
// environment (D4-11: names to owners, values after a fresh passkey, never in Activity).
// 8b-5: each branch's database, made by the database helper (lfdln-pammydb), its connection
// put in the branch's environment; dev may use main's (a fresh passkey). 8b-8a: packages
// (checked, added, updated, removed, fixed: each a commit and a build) and scripts.
// Everything is the projects helper's: the panel only asks it, and writes down who asked
// (Activity); the job's own log says how it went.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity, personOf, type Person, type UserRow } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { all } from '@panel/core/pg';
import { HELPER_STATUS, type PanelCtx } from '@panel/core/panel/context';
import { isAdmin, mayUse } from '@panel/core/panel/rights';
import { callProjects } from '../../client.ts';
import type { Job } from '../../jobs.ts';
import { DB_ENGINES, isServer, MAX_OWNERS, type BranchDatabase, type Project } from '../../record.ts';
import type { ProjectsList } from '../route-kind.ts';

type Listed = Project & { group: string; pushers: string[] };

// A project's database (8b-5): proj_<name>[_dev], its logins db_proj_<name>[_dev]_owner and
// _app (sites/lfdln/src/studio-site.ts PROJECT_NAMES); its server reaches the engines at its
// own 127.0.0.1, where the Quadlet's pasta forwards their ports alone (docs/s1-plan.md S1d)
export const PROJECT_DB_HOST = '127.0.0.1';
export function projectDbNames(id: string, branch: 'main' | 'dev') {
  const base = `${id.replaceAll('-', '_')}${branch === 'dev' ? '_dev' : ''}`;
  return { name: `proj_${base}`, owner: `db_proj_${base}_owner`, app: `db_proj_${base}_app` };
}
export const dbUrl = (engine: 'postgres' | 'mariadb', user: string, password: string, port: number, name: string) =>
  `${engine === 'postgres' ? 'postgres' : 'mysql'}://${user}:${password}@${PROJECT_DB_HOST}:${port}/${name}`;
const ENGINE_WORDS = { postgres: 'Postgres', mariadb: 'MariaDB' } as const;
// 32 letters and digits, as the Studio's (@panel/studio users.ts newDbPassword: the helper takes
// nothing else, since a password is composed into CREATE ROLE); its own copy, so Projects needs
// no Studio module
export function projectDbPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 32) for (const b of randomBytes(48)) if (b < 248 && out.length < 32) out += alphabet[b % 62];
  return out;
}

const KIND_WORDS: Record<string, string> = { react: 'React', vue: 'Vue', svelte: 'Svelte', lit: 'Lit', 'next-static': 'Next.js, static export', next: 'Next.js (a server)', laravel: 'Laravel' };

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, body, actorOf } = ctx;
  const domain = config.site.domain;

  const helper = async <T>(req: Record<string, unknown>): Promise<T> => {
    if (!config.projectsSocket) throw new AccountError('This site has no projects helper.', 503);
    try { return await callProjects<T>(config.projectsSocket, req); } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  // the project, if this person may change it: one of its owners, or an admin (D3-1)
  const mine = async (a: { user: Person }, id: string): Promise<Listed> => {
    const p = (await helper<{ projects: Listed[] }>({ op: 'list' })).projects.find((x) => x.id === id);
    if (!p) throw new AccountError(`There is no project called ${id}.`, 404);
    if (!isAdmin(a.user) && !p.owners.includes(a.user.username)) throw new AccountError(`Only ${p.id}'s owners (${p.owners.join(', ') || 'none'}) or an admin can change it.`, 403);
    return p;
  };
  // who may own a project: panel accounts that are on and have the Projects part
  const candidates = async () => {
    const out: { username: string; name: string }[] = [];
    for (const u of await all<UserRow>(db, 'SELECT * FROM users WHERE active = 1 ORDER BY username')) {
      if (mayUse(await personOf(db, u), 'projects', true)) out.push({ username: u.username, name: u.display_name });
    }
    return out;
  };
  // where each project is shown (its routes, on the Hosts page)
  const shownAt = async () => {
    const rows = await all<{ name: string; domain: string | null; path: string; project: string; branch: string | null; accounts: string | null; enabled: boolean; host_enabled: boolean }>(db,
      `SELECT h.name, d.name AS domain, r.path, r.target_ref->>'project' AS project, r.target_ref->>'branch' AS branch, r.accounts, r.enabled, h.enabled AS host_enabled
       FROM routes r JOIN hosts h ON h.id = r.host_id LEFT JOIN domains d ON d.id = h.domain_id WHERE r.target_kind = 'project' ORDER BY h.name, d.name, r.path`);
    const out = new Map<string, { address: string; live: boolean; branch: 'main' | 'dev'; accounts: string | null }[]>();
    for (const r of rows) {
      out.set(r.project, [...(out.get(r.project) ?? []), {
        address: `https://${r.name === '@' ? '' : `${r.name}.`}${r.domain ?? domain}${r.path}`, live: r.enabled && r.host_enabled,
        branch: r.branch === 'dev' ? 'dev' : 'main', accounts: r.accounts,
      }]);
    }
    return out;
  };

  app.get('/api/projects', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const [info, list, jobs, at] = await Promise.all([helper({ op: 'info' }), helper<ProjectsList & { projects: Listed[] }>({ op: 'list' }), helper<{ jobs: Job[] }>({ op: 'jobs' }), shownAt()]);
    const admin = isAdmin(a.user);
    return {
      projects: list.projects.map((p) => ({ ...p, shownAt: at.get(p.id) ?? [], mayChange: admin || p.owners.includes(a.user.username) })),
      making: list.making ?? [],
      info, jobs: jobs.jobs.slice(0, 15),
      // the clone address over SSH (D3-10): <you>@ the server, for owners with a Unix account
      ssh: { host: domain, root: '/srv/lfdln-projects' },
      me: a.user.username, candidates: await candidates(), maxOwners: MAX_OWNERS,
    };
  });

  // "Check the build environment": a job, so it waits behind any build
  app.post('/api/projects/check', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return helper({ op: 'check', actor: a.user.username });
  });

  app.get('/api/projects/jobs/:id', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return helper({ op: 'job', id: idOf(req) });
  });

  // New project: queued; the page follows its job. The host comes from the Hosts API after.
  app.post('/api/projects', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const project = { id: b.id, kind: b.kind, pm: b.pm, typescript: b.typescript, tailwind: b.tailwind, dev: b.dev === true };
    const r = await helper<{ job: Job }>({ op: 'create', project, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-created', String(b.id),
      `${KIND_WORDS[String(b.kind)] ?? b.kind}, ${b.typescript ? 'TypeScript' : 'JavaScript'}${b.tailwind ? ', Tailwind' : ''}, ${b.pm}${b.dev === true ? ', dev branch' : ''}`);
    return r;
  });

  app.post('/api/projects/:id/build', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await mine(a, idOf(req));
    const branch = body(req).branch ?? 'main';
    const r = await helper<{ job: Job }>({ op: 'build', id: idOf(req), branch, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-built', idOf(req), String(branch));
    return r;
  });

  app.post('/api/projects/:id/rollback', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await mine(a, idOf(req));
    const b = body(req);
    const r = await helper<{ job: Job }>({ op: 'rollback', id: idOf(req), branch: b.branch ?? 'main', release: b.release, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-rolled-back', idOf(req), `${b.branch === 'dev' ? 'dev ' : ''}release ${String(b.release)}`);
    return r;
  });

  // Delete (a fresh passkey): only once no route shows it -- its hosts and routes are the
  // Hosts page's -- then its folder goes to the trash for 30 days
  app.post('/api/projects/:id/delete', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const shown = (await shownAt()).get(id) ?? [];
    if (shown.length) throw new AccountError(`${id} is still shown at ${shown.map((s) => s.address).join(', ')}: remove ${shown.length === 1 ? 'that route' : 'those routes'} on the Hosts page first.`, 409);
    const r = await helper<{ job: Job }>({ op: 'delete', id, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-deleted', id, 'to the trash for 30 days');
    return r;
  });

  // Put dev live (a fresh passkey): main fast-forwarded to dev, then built (D3-7)
  app.post('/api/projects/:id/promote', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const r = await helper<{ job: Job }>({ op: 'promote', id, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-dev-live', id, 'main moved to dev, then built');
    return r;
  });

  // The dev branch on or off; off only once no route shows it (its -dev host is the Hosts page's)
  app.post('/api/projects/:id/dev', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const on = body(req).on;
    if (on === false) {
      const shown = ((await shownAt()).get(id) ?? []).filter((s) => s.branch === 'dev');
      if (shown.length) throw new AccountError(`${id}'s dev branch is still shown at ${shown.map((s) => s.address).join(', ')}: remove ${shown.length === 1 ? 'that route' : 'those routes'} on the Hosts page first.`, 409);
    }
    const r = await helper<{ job: Job }>({ op: 'dev', id, on, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), on ? 'project-dev-on' : 'project-dev-off', id, on ? 'dev made from main if new, then built' : 'its dev releases gone, the branch kept in git');
    return r;
  });

  // Owners (D3-1): panel accounts with the Projects part; never none
  app.post('/api/projects/:id/owners', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    const p = await mine(a, id);
    const want = body(req).owners;
    if (!Array.isArray(want) || want.length === 0) throw new AccountError('A project keeps at least one owner.', 400);
    const ok = new Set((await candidates()).map((c) => c.username));
    const bad = want.filter((w) => typeof w !== 'string' || !ok.has(w));
    if (bad.length) throw new AccountError(`${bad.map(String).join(', ').slice(0, 80)}: not a panel account with the Projects part.`, 400);
    const r = await helper<{ job: Job }>({ op: 'owners', id, owners: want, actor: a.user.username });
    const added = (want as string[]).filter((w) => !p.owners.includes(w));
    const gone = p.owners.filter((o) => !(want as string[]).includes(o));
    await logActivity(db, now(), actorOf(a, req), 'project-owners', id,
      [added.length && `added ${added.join(', ')}`, gone.length && `removed ${gone.join(', ')}`].filter(Boolean).join('; ') || 'unchanged');
    return r;
  });

  // A server's Start / Stop / Restart (D4-7): its owners or an admin
  app.post('/api/projects/:id/control', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const b = body(req);
    const r = await helper<{ job: Job }>({ op: 'control', id, branch: b.branch ?? 'main', action: b.action, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), `project-${String(b.action)}`, id, String(b.branch ?? 'main'));
    return r;
  });

  // A branch's environment (D4-11): its owners or an admin; names only
  app.get('/api/projects/:id/env', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await mine(a, idOf(req));
    return helper({ op: 'env', id: idOf(req), branch: (req.query as { branch?: string }).branch ?? 'main' });
  });

  // ...its values: a fresh passkey, and said in Activity (which, never what)
  app.post('/api/projects/:id/env/values', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const branch = body(req).branch ?? 'main';
    const r = await helper({ op: 'env-values', id, branch });
    await logActivity(db, now(), actorOf(a, req), 'project-env-shown', id, String(branch));
    return r;
  });

  // One variable set, or removed (value null); Activity has its name, never its value
  app.post('/api/projects/:id/env', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const b = body(req);
    const branch = b.branch ?? 'main';
    const r = await helper<{ name: string; removed: boolean }>({ op: 'env-set', id, branch, name: b.name, value: b.value });
    await logActivity(db, now(), actorOf(a, req), r.removed ? 'project-env-removed' : 'project-env-set', id, `${branch}: ${r.name}`);
    return r;
  });

  // A branch's database (8b-5): made (or one kept from before taken up) by the database
  // helper, new passwords, and its two connections put in the branch's environment
  app.post('/api/projects/:id/database', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    const p = await mine(a, id);
    const b = body(req);
    const branch = b.branch === 'dev' ? 'dev' : 'main';
    const engine = b.engine;
    if (!(DB_ENGINES as readonly unknown[]).includes(engine)) throw new AccountError('Postgres or MariaDB?', 400);
    const e = engine as BranchDatabase['engine'];
    if (!isServer(p.kind)) throw new AccountError(`${id} serves files: only a server uses a database.`, 400);
    if (!p.branches[branch]) throw new AccountError(`${id} has no ${branch} branch.`, 404);
    if (p.branches[branch]!.database && !p.branches[branch]!.database!.shared) throw new AccountError(`${id}'s ${branch} has its database already (${p.branches[branch]!.database!.name}).`, 409);
    const port = config.site.studioPorts?.[e];
    if (!port) throw new AccountError(`This site has no ${ENGINE_WORDS[e]} for projects.`, 503);
    const n = projectDbNames(id, branch);
    const ownerPassword = projectDbPassword();
    const appPassword = projectDbPassword();
    const made = await ctx.studio<{ name: string; owner: string; app: string; kept: boolean }>({ op: 'project-database', engine: e, name: n.name, owner: n.owner, ownerPassword, app: n.app, appPassword });
    // the app's connection for its rows; the owner's for its migrations (D5-4)
    await helper({ op: 'env-set', id, branch, name: 'DATABASE_URL', value: dbUrl(e, made.app, appPassword, port, made.name) });
    const set = await helper<{ needs: string }>({ op: 'env-set', id, branch, name: 'DATABASE_OWNER_URL', value: dbUrl(e, made.owner, ownerPassword, port, made.name) });
    const r = await helper<{ database: BranchDatabase }>({ op: 'database', id, branch, database: { engine: e, name: made.name, owner: made.owner, app: made.app }, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-database', id, `${branch}: ${ENGINE_WORDS[e]} ${made.name}${made.kept ? ', kept from before' : ''}`);
    return { ...r, kept: made.kept, needs: set.needs };
  });

  // dev using main's database (P8b-5): an owner's choice, a fresh passkey; off, dev has none
  // again (its own, if it had one, is still there: made again, it is taken up)
  app.post('/api/projects/:id/database/share', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const id = idOf(req);
    const p = await mine(a, id);
    const on = body(req).on === true;
    if (!p.branches.dev) throw new AccountError(`${id} has no dev branch.`, 404);
    let rec: Partial<BranchDatabase> | null = null;
    if (on) {
      const main = p.branches.main?.database;
      if (!main) throw new AccountError(`${id}'s live branch has no database to use.`, 409);
      const values = (await helper<{ values: Record<string, string> }>({ op: 'env-values', id, branch: 'main' })).values;
      if (!values.DATABASE_URL || !values.DATABASE_OWNER_URL) throw new AccountError(`${id}'s live environment has no DATABASE_URL and DATABASE_OWNER_URL to use.`, 409);
      for (const k of ['DATABASE_URL', 'DATABASE_OWNER_URL']) await helper({ op: 'env-set', id, branch: 'dev', name: k, value: values[k] });
      rec = { engine: main.engine, name: main.name, owner: main.owner, app: main.app, shared: true };
    } else {
      if (!p.branches.dev.database?.shared) throw new AccountError(`${id}'s dev branch isn't using the live database.`, 409);
      const names = (await helper<{ vars: { name: string }[] }>({ op: 'env', id, branch: 'dev' })).vars.map((v) => v.name);
      for (const k of ['DATABASE_URL', 'DATABASE_OWNER_URL']) if (names.includes(k)) await helper({ op: 'env-set', id, branch: 'dev', name: k, value: null });
    }
    const r = await helper<{ database: BranchDatabase | null }>({ op: 'database', id, branch: 'dev', database: rec, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), on ? 'project-database-shared' : 'project-database-unshared', id, on ? `dev uses ${rec!.name}` : 'dev has no database');
    return r;
  });

  // Packages (8b-8a): the last check, and the branch changes go to; anyone with the Projects part
  app.get('/api/projects/:id/packages', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const [pk, list, jobs] = await Promise.all([helper<Record<string, unknown>>({ op: 'packages', id: idOf(req) }),
      helper<{ projects: Listed[] }>({ op: 'list' }), helper<{ jobs: Job[] }>({ op: 'jobs', project: idOf(req) })]);
    const p = list.projects.find((x) => x.id === idOf(req));
    if (!p) throw new AccountError(`There is no project called ${idOf(req)}.`, 404);
    return { ...pk, project: { id: p.id, kind: p.kind, pm: p.pm, typescript: p.typescript, owners: p.owners, dev: !!p.branches.dev },
      mayChange: isAdmin(a.user) || p.owners.includes(a.user.username), jobs: jobs.jobs.slice(0, 10) };
  });

  app.post('/api/projects/:id/packages/check', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await mine(a, idOf(req));
    return helper({ op: 'packages-check', id: idOf(req), actor: a.user.username });
  });

  // One change (add, update, remove or fix): the helper checks it again
  app.post('/api/projects/:id/packages', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const change = body(req).change as Record<string, unknown> | undefined;
    const r = await helper<{ job: Job }>({ op: 'packages-change', id, change, actor: a.user.username });
    const words = !change ? '' : Array.isArray(change.add) ? `add ${(change.add as { name: string; dev?: boolean }[]).map((x) => `${x.name}${x.dev ? ' (dev)' : ''}`).join(', ')}`
      : change.update === 'all' ? 'update all (minor and patch)' : Array.isArray(change.update) ? `update ${(change.update as string[]).join(', ')}`
        : Array.isArray(change.remove) ? `remove ${(change.remove as string[]).join(', ')}` : 'fix security issues';
    await logActivity(db, now(), actorOf(a, req), 'project-packages', id, words.slice(0, 300));
    return r;
  });

  // A script of package.json's: its owners or an admin (it runs their code, with its environment)
  app.post('/api/projects/:id/scripts/run', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const script = body(req).script;
    const r = await helper<{ job: Job }>({ op: 'script', id, script, actor: a.user.username });
    await logActivity(db, now(), actorOf(a, req), 'project-script', id, String(script).slice(0, 64));
    return r;
  });

  // each night, updated within their ranges (8b-8b): its owners or an admin
  app.post('/api/projects/:id/auto-update', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idOf(req);
    await mine(a, id);
    const on = body(req).on === true;
    const r = await helper({ op: 'auto-update', id, on });
    await logActivity(db, now(), actorOf(a, req), on ? 'project-auto-update-on' : 'project-auto-update-off', id, null);
    return r;
  });

  // the npm registry: anyone with the Projects part may look
  app.get('/api/projects/packages/search', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return helper({ op: 'package-search', text: (req.query as { q?: string }).q ?? '' });
  });
  app.get('/api/projects/packages/about', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const q = req.query as { name?: string; lang?: string };
    return helper({ op: 'package-about', name: q.name ?? '', lang: q.lang === 'ts' ? 'ts' : 'js' });
  });

  // A server's log (D4-8): anyone with the Projects part may read it, as Services' logs
  app.get('/api/projects/:id/logs', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    return helper({ op: 'logs', id: idOf(req), branch: (req.query as { branch?: string }).branch ?? 'main' });
  });
}
