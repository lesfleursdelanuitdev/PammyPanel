// "Show a project" on the Hosts page (docs/phase8b-plan.md 8b-2): the panel's half of the
// projects module's kind of target (the routing helper's half is ../route-kind.ts). A route
// names a project the projects helper lists, and its branch (main, or dev when it is on: 8b-3);
// making one needs the Projects part too. Its
// hashed build files (Vite's assets/, Next.js's _next/static/) are cached for good, where
// the route is a host's top.
import { AccountError } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { keptTo, mayUse } from '@panel/core/panel/rights';
import { NameError, routePath } from '@panel/hosts/names';
import type { PanelRouteKind } from '@panel/hosts/panel/route-kinds';
import { isServer, MADE_KINDS, SPA_KINDS, type Project } from '../record.ts';

// The helper's list: the projects, and those asked for and not made yet, which a route may
// already show (New project makes its hosts at once; they serve once the first build is done).
export type ProjectsList = { projects: Project[]; making?: { id: string; kind: Project['kind']; dev: boolean }[] };
export const projectsAndMaking = (l: ProjectsList): Project[] => [
  ...l.projects,
  ...(l.making ?? []).map((m): Project => ({
    id: m.id, kind: m.kind, pm: 'npm', typescript: false, tailwind: false, createdAt: 0, createdBy: '', owners: [], shared: false,
    branches: { main: { ports: [], live: null, releases: [] }, ...(m.dev ? { dev: { ports: [], live: null, releases: [] } } : {}) },
  })),
];

export const assetsOf = (p: Pick<Project, 'kind'>) => (p.kind === 'next-static' ? '/_next/static/' : '/assets/');

export function projectRouteKind(opts: { list: () => Promise<Project[]> }): PanelRouteKind {
  const list = async (): Promise<Project[]> => {
    try { return await opts.list(); } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };
  return {
    kind: 'project', label: 'Show a project', accounts: true,
    make: async (_q, a, b) => {
      if (!mayUse(a.user, 'projects', true)) throw new AccountError('Showing a project needs the Projects part of the panel too.', 403);
      const p = (await list()).find((x) => x.id === b.project);
      if (!p) throw new AccountError('That project isn\'t there.', 404);
      if (!MADE_KINDS.includes(p.kind)) throw new AccountError(`${p.id} isn't a project the panel can show yet.`, 400);
      const branch = b.branch ?? 'main';
      if (branch !== 'main' && branch !== 'dev') throw new AccountError('Which branch: main or dev?', 400);
      if (branch === 'dev' && !p.branches.dev) throw new AccountError(`${p.id}'s dev branch is off: turn it on on the Projects page first.`, 409);
      let top = false;
      try { top = routePath(b.path) === '/'; } catch (e) { if (!(e instanceof NameError)) throw e; }
      return {
        // a server (8b-4a): its upstream, which follows its live release; files: as before
        ref: isServer(p.kind) ? { project: p.id, branch, spa: false, cacheForever: [], serve: 'proxy' }
          : { project: p.id, branch, spa: SPA_KINDS.includes(p.kind), cacheForever: top ? [assetsOf(p)] : [], serve: 'files' },
        what: `project ${p.id}${branch === 'dev' ? ' (dev)' : ''}`,
      };
    },
    options: async (a) => ({
      projects: mayUse(a.user, 'projects') && keptTo(a.user) === null
        ? (await list().catch(() => [])).filter((p) => MADE_KINDS.includes(p.kind)).map((p) => ({ id: p.id, kind: p.kind, live: !!p.branches.main?.live, dev: !!p.branches.dev }))
        : [],
    }),
  };
}
