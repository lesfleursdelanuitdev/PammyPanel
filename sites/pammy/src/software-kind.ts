// A route to installed software (docs/phase8-plan.md 8-7): pammy.org's kind of target for the
// apps module's installs (here, where the site puts the hosts and apps modules together).
// WordPress at the top of a host (blog.pammy.org) or at a path (pammy.org/blog/), handed on
// through the proxy file the software helper writes for it (proxy.conf for the adopted
// blog, proxy-<id>.conf for the others) -- the same shapes as the placement templates
// (wordpress/nginx/templates: server-subdomain.conf, path-block.conf). No gate: WordPress
// has its own sign-ins. As the whole of a website (the "root" placement) it isn't a route:
// the Installed software page refuses that while the site is on hosts.
import { routePath } from '@panel/hosts/names';
import { safePath, type HostsConfig, type Route, type RouteKind, type SoftwarePart, type Table } from '@panel/hosts/render';
import { ID_RE } from '@panel/apps/apps/record';
import { WORDPRESS_NGX } from '@panel/apps/apps/nginx';

const PROXY_RE = /^proxy(?:-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)?\.conf$/;

function softwareOf(_cfg: HostsConfig, t: Table): Map<string, SoftwarePart> {
  const out = new Map<string, SoftwarePart>();
  for (const s of t.software ?? []) {
    if (!ID_RE.test(s.id) || !PROXY_RE.test(s.proxy) || out.has(s.id)) throw new Error(`hosts: the software "${String(s.id).slice(0, 40)}" isn't one, or is there twice`);
    out.set(s.id, s);
  }
  return out;
}

export function softwareKind(ngx = WORDPRESS_NGX): RouteKind {
  const dir = safePath(ngx, 'software folder');
  return {
    kind: 'software',
    accounts: false,
    fields: (r) => {
      if (typeof r.app !== 'string' || !ID_RE.test(r.app)) throw new Error('which software?');
      return { app: r.app };
    },
    prepare: softwareOf,
    describe: (r) => `installed software ${r.app}`,
    locations: (ctx, r: Route) => {
      const s = (ctx.state as Map<string, SoftwarePart>).get(r.app as string);
      if (!s) throw new Error(`hosts: ${ctx.host}${routePath(r.path)} shows the software "${r.app}", which isn't installed`);
      const proxy = `include ${dir}/${s.proxy};`;
      const path = routePath(r.path);
      if (path === '/') {
        return [
          '    # pingback/brute-force target; nothing she needs uses it',
          '    location = /xmlrpc.php {', '        auth_request off;', '        return 403;', '    }',
          '    location / {', '        auth_request off;', `        ${proxy}`, '    }',
        ];
      }
      // '^~' outranks every regex location (the folder-404 rule and the hidden-file deny),
      // so the hidden-file deny is repeated inside
      return [
        `    location = ${path.slice(0, -1)} {`, '        auth_request off;', `        return 301 ${path};`, '    }',
        `    location ^~ ${path} {`, '        auth_request off;',
        '        location ~ /\\. {', '            deny all;', '        }',
        `        location = ${path}xmlrpc.php {`, '            return 403;', '        }',
        `        ${proxy}`, '    }',
      ];
    },
  };
}
