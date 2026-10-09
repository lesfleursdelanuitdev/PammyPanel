// What a route may show on pammy.org (docs/phase8-plan.md 8-7): a site folder and a redirect
// (the hosts module's own), the whole website and a program on 127.0.0.1 (the /api/ proxy,
// P8-14), and installed software (the apps module's). Protected folders are folders here, so
// the renderer includes the gate's own snippets (the profile's nginx.gateDir) in every block
// that serves files, and routes have no accounts (no route gate). The routing helper, the
// panel and the tests take pammy.org's hosts settings from here.
import { isOn, type SiteProfile } from '@panel/core/profile';
import { hostsConfigOf as base } from '@panel/hosts/config';
import { proxyKind, siteKind } from '@panel/hosts/folder-gate';
import { HOSTS_KINDS, type HostsConfig, type RouteKind } from '@panel/hosts/render';
import { softwareKind } from './software-kind.ts';

export const routeKindsOf = (p: SiteProfile): RouteKind[] => [...HOSTS_KINDS, siteKind, proxyKind, ...(isOn(p, 'apps') ? [softwareKind()] : [])];

export const hostsConfigOf = (p: SiteProfile & { nginx: { gateDir: string } }, logs?: string): HostsConfig => ({
  ...base(p, logs, routeKindsOf(p)),
  folderGate: { dir: p.nginx.gateDir },
  logName: 'pammy',
  // her gate looks at folders; no route has a gate of its own
  gate: null,
});
