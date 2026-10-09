// "Show a project" (docs/phase8b-plan.md 8b-2): the routing helper's half of the projects
// module's kind of target. A static project's route serves its branch's live release, as
// files, through the `current` link the projects helper replaces on each deploy (nginx
// follows it on every request: no reload). A dev route (8b-3) is the same, with noindex.
// A server (8b-4a, `serve: 'proxy'`) goes to its branch's upstream, which the projects
// helper points at the live slot's port (D4-4): the route itself never changes on a deploy.
// The panel's half is panel/route-kind.ts.
import { routePath } from '@panel/hosts/names';
import { appCookieLine, FIELDS, gateLines, identityOf, proofLine, staticLocation, tokenOf, type HostsConfig, type RouteBase, type RouteKind } from '@panel/hosts/render';
import { BRANCHES, isProjectId, type Branch } from './record.ts';
import { PROJECTS_ROOT, upstreamOf } from './helper/ops.ts';

const PATHS_RE = /^\/[a-z0-9_.\/-]{1,60}\/$/;

// a preview isn't for search engines (D3-7)
const NOINDEX = 'noindex, nofollow';

// the app its proofs are made out to (docs/s1-plan.md S1a): a server's branch
const projectAudience = (r: { project: string; branch: Branch }) => `project.${r.project}.${r.branch}`;

// A server's location (D4-9): as a service route's, to the branch's upstream.
function proxyLocation(cfg: HostsConfig, r: RouteBase & { project: string; branch: Branch }): string[] {
  const path = routePath(r.path);
  const token = tokenOf(r);
  const id = identityOf(cfg);
  const out: string[] = [];
  if (path !== '/') out.push(`    location = ${path.slice(0, -1)} { return 301 ${path}; }`);
  out.push(`    location ^~ ${path} {`);
  if (token) out.push(...gateLines(cfg, token, '        ', projectAudience(r)));
  out.push(
    `        proxy_pass http://${upstreamOf(r.project, r.branch)};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    // who is signed in, from the gate's answer; without accounts, nothing (and never what the visitor sent)
    ...FIELDS.map(([f]) => `        proxy_set_header ${id.header(f)} ${token ? id.v(f) : '""'};`),
    // ... and the gate's proof of it, for this project's branch alone (docs/s1-plan.md S1a)
    proofLine(cfg, token, '        '),
    // the visitor's cookies without the gate's (docs/s1-plan.md S1e)
    ...appCookieLine(cfg, '        '),
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    ...(r.branch === 'dev' ? [`        add_header X-Robots-Tag "${NOINDEX}" always;`] : []),
    '    }',
  );
  return out;
}

export const projectKind = (root: string = PROJECTS_ROOT): RouteKind => ({
  kind: 'project',
  accounts: true,
  fields: (r) => {
    if (!isProjectId(r.project)) throw new Error('a route\'s project is missing or isn\'t a project\'s name.');
    if (!(BRANCHES as readonly unknown[]).includes(r.branch)) throw new Error('a project route\'s branch is main or dev.');
    if (typeof r.spa !== 'boolean') throw new Error('spa is not true or false.');
    const forever = r.cacheForever ?? [];
    if (!Array.isArray(forever) || forever.length > 5 || forever.some((x) => typeof x !== 'string' || !PATHS_RE.test(x))) throw new Error('cacheForever is not a short list of paths.');
    // (routes made before 8b-4a have no `serve`: files)
    const serve = r.serve ?? 'files';
    if (serve !== 'files' && serve !== 'proxy') throw new Error('a project route serves files or goes to its server (proxy).');
    return { project: r.project, branch: r.branch, spa: r.spa, cacheForever: forever, serve };
  },
  audience: (r) => ((r.serve ?? 'files') === 'proxy' ? projectAudience(r as unknown as { project: string; branch: Branch }) : null),
  describe: (r) => `project ${r.project} (${r.branch})${r.serve === 'proxy' ? ' (its server)' : r.spa ? ' (single-page app)' : ''}`,
  locations: (ctx, r) => {
    if (!isProjectId(r.project) || !(BRANCHES as readonly unknown[]).includes(r.branch)) throw new Error(`hosts: ${ctx.host}${routePath(r.path)} names a project that isn't one`);
    if (r.serve === 'proxy') return proxyLocation(ctx.cfg, r as unknown as RouteBase & { project: string; branch: Branch });
    const headers = r.branch === 'dev' ? [{ name: 'X-Robots-Tag', value: NOINDEX }] : [];
    return staticLocation(ctx.cfg, { ...r, spa: r.spa === true, headers, cacheForever: r.cacheForever as string[] }, `${root}/${r.project}/releases/${r.branch}/current`, false);
  },
});
