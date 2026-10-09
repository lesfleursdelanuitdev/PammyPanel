// What a route may show on lfdln (docs/domains-hosts-plan.md step 2, D-4): the kinds of
// target of the modules it has on, put together here -- a site folder and a redirect (the
// hosts module's own), a service (the services module's) and a project (the projects module's). The routing helper, the
// panel and the tests all take lfdln's hosts settings from here.
import { isOn, type SiteProfile } from '@panel/core/profile';
import { hostsConfigOf as base } from '@panel/hosts/config';
import { HOSTS_KINDS, type HostsConfig, type RouteKind } from '@panel/hosts/render';
import { SERVED_FOLDERS, SERVED_ROOTS } from '@panel/services/known';
import { serviceKind } from '@panel/services/route-kind';
import { projectKind } from '@panel/projects/route-kind';

export const routeKindsOf = (p: SiteProfile): RouteKind[] => [...HOSTS_KINDS, ...(isOn(p, 'services') ? [serviceKind] : []), ...(isOn(p, 'projects') ? [projectKind()] : [])];

// with services, the folders nginx serves itself on their routes (docs/domains-hosts-plan.md step 7, 7-2)
export const hostsConfigOf = (p: SiteProfile, logs?: string): HostsConfig => ({
  ...base(p, logs, routeKindsOf(p)),
  ...(isOn(p, 'services') ? { served: { folders: SERVED_FOLDERS, roots: SERVED_ROOTS } } : {}),
});
