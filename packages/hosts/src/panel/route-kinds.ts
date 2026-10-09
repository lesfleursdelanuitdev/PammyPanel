// The panel's side of a kind of target (docs/domains-hosts-plan.md step 2, D-4): what
// the Hosts page may make a route show. A module that has a kind gives both halves --
// this one (checks what the page sent, as the person sending it) and the routing
// helper's (render.ts RouteKind: checks the table again and writes nginx). The hosts
// module's own two, a site folder and a redirect, are in routes/hosts.ts; a site adds
// the others its modules have (sites/<site>/src/app.ts).
import type { Db } from '@panel/core/pg';
import type { Authed } from '@panel/core/sessions';
import type { ServicePart } from '../render.ts';

export type Made = {
  ref: Record<string, unknown>;      // the kind's fields, as routes.target_ref keeps them
  folderId?: number;                 // a site folder route's folder (the one reference the database holds)
  what: string;                      // for Activity: "service TutorStar"
};

export type PanelRouteKind = {
  kind: string;
  label: string;                     // what the page's "What it does" says: "Go to a service"
  accounts: boolean;                 // whether a route of this kind can have accounts
  // a new route of this kind, from what the page sent; throws AccountError when it can't be
  make(q: Db, a: Authed, b: Record<string, unknown>): Promise<Made>;
  // what the routing helper's table needs besides the routes, when a route of this kind is
  // there: the services' ports
  services?(): Promise<ServicePart[]>;
  // what the page's form offers for it (a service's parts), merged into GET /api/hosts;
  // only for someone who may make such a route
  options?(a: Authed): Promise<Record<string, unknown>>;
};
