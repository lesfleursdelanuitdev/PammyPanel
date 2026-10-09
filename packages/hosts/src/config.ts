// The renderer's settings (render.ts) from a site's profile: the hosts module's
// own part of it, the domain, the logs, and PHP when that module is on.
import { isOn, type SiteProfile } from '@panel/core/profile';
import { HOSTS_KINDS, type HostsConfig, type RouteKind } from './render.ts';

// kinds: the targets a route may have on the site (docs/domains-hosts-plan.md step 2), from
// the modules it has on; the site puts them together (sites/<site>/src/hosts.ts)
export function hostsConfigOf(p: SiteProfile, logs = '/var/log/nginx', kinds: readonly RouteKind[] = HOSTS_KINDS): HostsConfig {
  if (!p.hosts || !isOn(p, 'hosts')) throw new Error(`${p.name} has no hosts: the hosts module is off in its profile`);
  return {
    domain: p.domain,
    dir: p.hosts.dir,
    sitesRoot: p.hosts.sitesRoot,
    tls: p.hosts.tls,
    php: isOn(p, 'php') ? { socket: `${p.services.phpRun}/fpm.sock` } : null,
    logs,
    // who stands in front (S6); a domain's row says, once there is one
    front: p.front,
    signInZone: p.hosts.signInZone ?? null,
    reservedPorts: [p.services.panel.port, p.services.gate?.port, p.services.pg.port].filter((n): n is number => typeof n === 'number'),
    // accounts on a route (docs/roles-plan.md step 5): the site's gate, with people on
    identity: p.hosts.identity ?? 'Lfdln',
    gate: isOn(p, 'areas') && isOn(p, 'people') && p.services.gate ? `${p.services.gate.host}:${p.services.gate.port}` : null,
    // the gate's visitor cookie, kept from apps (docs/s1-plan.md S1e): the gate's default
    // name is core's VISITOR_COOKIE (gate/context.ts; test/s1e-cookie checks they agree)
    ...(p.services.gate ? { visitorCookie: p.services.gate.cookie ?? '__Host-pammy_visitor' } : {}),
    // nginx's edge secret for the gate's locations (docs/s1-plan.md S1c), beside the panel's files
    edge: `${p.nginx.panelDir}/edge.conf`,
    kinds: [...kinds],
  };
}
