// The routing helper (docs/hosts-plan.md H7), lfdln-routes.service: the only thing
// that writes the hosts' nginx files. Root, because nginx's files are root's; its
// unit lets it write its own folder and nothing else, and it has no network. What
// it needs from outside that -- `nginx -t`, the reload, reading the DreamHost zone
// with the key only root may read -- it asks systemd for, one named unit each
// (@panel/core/runner).
//
// It listens on the socket systemd hands it (only the panel's user may open it),
// or on ROUTES_SOCKET when run by hand for testing.
import { chmodSync, unlinkSync } from 'node:fs';
import { systemdRunner } from '@panel/core/runner';
import type { SiteProfile } from '@panel/core/profile';
import { hostsConfigOf } from '../config.ts';
import { zoneReader } from '../zone.ts';
import { createRoutesOps } from './ops.ts';
import type { HostsConfig, RouteKind, ServicePart } from '../render.ts';
import { createRoutesServer } from './service.ts';

// The DreamHost script certbot's hook uses (root's, beside the API key's rules).
// Started through bash: systemd-run looks for the program itself, from inside
// this helper's sandbox, where /etc/letsencrypt is hidden ("Failed to find
// executable ... Permission denied", and no unit at all). The script is only
// read by the unit, which runs outside the sandbox.
export const ZONE_COMMAND = ['/bin/bash', '/etc/letsencrypt/dreamhost-hooks/dreamhost-dns.sh', 'list'];

// ports: where the site's services answer, from their record (docs/adopt-plan.md V3);
// kinds: what a route may show on the site (docs/domains-hosts-plan.md step 2);
// served: the folders nginx serves itself on service routes (step 7, 7-2)
// site: another site's helper (pammy-routes, docs/phase8-plan.md 8-7): its unit's name, its
// own settings, no zone to read (DNS kept by hand), and the hand-written files it takes over
export type RoutesSite = { unit: string; cfg: HostsConfig; zone: boolean; links: readonly string[]; ownLink?: boolean };
export function runRoutes(profile: SiteProfile, env: NodeJS.ProcessEnv = process.env, ports?: () => ServicePart[], kinds?: RouteKind[], served?: HostsConfig['served'], site?: RoutesSite) {
  const now = () => Math.floor(Date.now() / 1000);
  const unit = site?.unit ?? 'lfdln-routes';
  const run = systemdRunner(unit);
  const cfg = site?.cfg ?? { ...hostsConfigOf(profile, undefined, kinds), ...(served ? { served } : {}) };
  const log = (line: string) => console.log(line);
  const zone = site && !site.zone ? null : zoneReader(run, ZONE_COMMAND, cfg.domain, now, log);
  const server = createRoutesServer(createRoutesOps({ cfg, run, zone, log, ports, ...(site ? { links: site.links, ownLink: site.ownLink ?? false } : {}) }), log);

  if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
    server.listen({ fd: 3 });
  } else if (env.ROUTES_SOCKET) {
    try { unlinkSync(env.ROUTES_SOCKET); } catch { /* not there */ }
    server.listen(env.ROUTES_SOCKET, () => chmodSync(env.ROUTES_SOCKET!, 0o600));
  } else {
    console.error(`${unit}: no socket (expected systemd socket activation or ROUTES_SOCKET)`);
    process.exit(2);
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
}
