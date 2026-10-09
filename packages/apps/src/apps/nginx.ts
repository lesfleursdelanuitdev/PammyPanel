// nginx for the WordPress installs (docs/apps-plan.md phases 2 and 4a, P4a):
// the files ~/pamela-setup/wordpress/lib.sh render_placement writes into
// /etc/nginx/pammy-wordpress -- main.conf (inside the pammy.org server block)
// and server.conf (at the end of the vhost) -- now with the blocks of EVERY
// install in them, plus each install's placement line and, for any install but
// the adopted blog, a proxy file of its own (the blog's proxy.conf points at its
// port, 3043). The pamela vhost itself never changes (P4a).
//
// While the blog is the only install this is byte for byte what the bash writes,
// from the same templates (build.sh copies them into the release):
// test/apps-nginx.test.ts runs both and compares. Several installs are checked
// with nginx -t and real requests in test/run-gate-nginx-test.sh.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Placement } from './placement.ts';

export const WORDPRESS_NGX = '/etc/nginx/pammy-wordpress';

// $(<file) in bash: the file without any trailing newlines
const slurp = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8').replace(/\n+$/, '');

export function placementLine(p: Placement): string {
  return p.name ? `${p.mode} ${p.name}` : p.mode;
}

// One install, as nginx needs it.
export type Placed = {
  id: string;
  placement: Placement;
  placementFile: string;      // where its placement line is kept (the blog's: WORDPRESS_NGX/placement)
  port: number;               // its web container on 127.0.0.1
  adopted: boolean;           // the blog: proxy.conf, as install-wordpress.sh installed it
};

export const proxyFileOf = (p: Placed) => (p.adopted ? 'proxy.conf' : `proxy-${p.id}.conf`);

// Which placements can be together: at most one on the whole site, and no name
// used twice (a subdomain and a path of the same name are two addresses, and
// fine). Returns her words, or null.
export function clash(all: Placed[]): string | null {
  const on = all.filter((a) => a.placement.mode !== 'off');
  if (on.filter((a) => a.placement.mode === 'root').length > 1) return 'Only one piece of software can be the whole of pammy.org.';
  for (const mode of ['subdomain', 'path'] as const) {
    const names = on.filter((a) => a.placement.mode === mode).map((a) => a.placement.name);
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return mode === 'subdomain' ? `${twice}.pammy.org is already used by other software.` : `pammy.org/${twice}/ is already used by other software.`;
  }
  return null;
}

// Every file of /etc/nginx/pammy-wordpress this writes, by path, for these
// installs as they will be.
export function renderAll(templates: string, all: Placed[], ngx = WORDPRESS_NGX): Map<string, string> {
  const why = clash(all);
  if (why) throw new Error(why);
  const on = all.filter((a) => a.placement.mode !== 'off');
  const label = all.length === 1 ? placementLine(all[0]!.placement) : all.map((a) => `${a.id}: ${placementLine(a.placement)}`).join('; ');
  const fillFor = (s: string, a: Placed) => s.split('@NAME@').join(a.placement.name ?? '').split('@NGX@/proxy.conf').join(`@NGX@/${proxyFileOf(a)}`);
  const root = on.find((a) => a.placement.mode === 'root');
  const paths = on.filter((a) => a.placement.mode === 'path').map((a) => fillFor(slurp(templates, 'path-block.conf'), a));
  const subs = on.filter((a) => a.placement.mode === 'subdomain').map((a) => fillFor(slurp(templates, 'server-subdomain.conf'), a));

  let main: string;
  if (root) {
    // the root template has no place for path blocks: the blog alone never needed one
    main = fillFor(slurp(templates, 'main-root.conf'), root) + (paths.length ? `\n${paths.join('\n')}` : '');
  } else {
    main = slurp(templates, 'main-static.conf').split('@PATH_BLOCK@').join(paths.join('\n'));
  }
  const server = subs.length
    ? subs.join('\n\n')
    : `# /etc/nginx/pammy-wordpress/server.conf -- placement: ${label}\n# (empty: WordPress has its own server block only when placed on a subdomain)`;
  const fill = (s: string) => `${s.split('@NGX@').join(ngx).split('@PLACEMENT@').join(label)}\n`;

  const out = new Map<string, string>([[`${ngx}/main.conf`, fill(main)], [`${ngx}/server.conf`, fill(server)]]);
  for (const a of all) out.set(a.placementFile, `${placementLine(a.placement)}\n`);
  // each install but the blog: its own proxy file, the blog's with its port
  const proxy = existsSync(join(templates, 'proxy.conf')) ? join(templates, 'proxy.conf') : join(templates, '..', 'proxy.conf');
  for (const a of all.filter((x) => !x.adopted)) {
    out.set(`${ngx}/${proxyFileOf(a)}`, readFileSync(proxy, 'utf8')
      .split('/etc/nginx/pammy-wordpress/proxy.conf').join(`${ngx}/${proxyFileOf(a)}`)
      .split('rootless container svc-pammywp, 127.0.0.1:3043').join(`installed from the panel as "${a.id}", 127.0.0.1:${a.port}`)
      .split('127.0.0.1:3043').join(`127.0.0.1:${a.port}`));
  }
  return out;
}

// The blog alone, as phase 2 wrote it (and as test/apps-nginx.test.ts compares
// with the bash): main.conf, server.conf and its placement line.
export function renderPlacement(templates: string, p: Placement, ngx = WORDPRESS_NGX): { 'main.conf': string; 'server.conf': string; placement: string } {
  const files = renderAll(templates, [{ id: 'blog', placement: p, placementFile: `${ngx}/placement`, port: 3043, adopted: true }], ngx);
  return { 'main.conf': files.get(`${ngx}/main.conf`)!, 'server.conf': files.get(`${ngx}/server.conf`)!, placement: files.get(`${ngx}/placement`)! };
}
