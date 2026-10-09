// The gate's row types that the kernel's gate context and its in-memory picture share with
// the modules (docs/k-a-plan.md KA-Q5): an area (areas'), a visitor (people's), a role in an
// area, and who is signed in. They live here while the store splits (K-a); C6-min's identity
// contract replaces Access, and K-b moves Area with the areas cache.
export type Area = {
  id: number; token: string; path: string; created_at: number; requests_open: number; role_set_id: number;
  // a folder of the website, or a route on one of the site's hosts (docs/roles-plan.md
  // step 5): a route area's path is '/route/<route_id>', never a folder's, and its
  // label the route's address
  kind?: 'folder' | 'route'; route_id?: number | null; label?: string | null;
  // what anyone may do there, signed in or not: its role set's "not signed in"
  // slot, space-separated (GateLive loads it with the areas; '' when read alone)
  guest_privileges?: string;
};
// password_hash is '' until they choose one with a setup link. email,
// email_confirmed_at and registered: accounts people make themselves
// (docs/accounts-plan.md); null, null and false for everyone the owner adds.
export type Visitor = {
  id: number; username: string; name: string; password_hash: string; active: number;
  created_at: number; password_changed_at: number; contact: string;
  email: string | null; email_confirmed_at: number | null; registered: boolean;
};

// A visitor's role in an area, and its privileges (its own and its groups': docs/roles-plan.md)
export type AreaRole = { role: string; privileges: ReadonlySet<string> };

// Who is signed in, their role in each area where they have one, and the areas
// whose pages they may open (pages.read), worked out once per session load.
export type Access = { visitor: Visitor; sessionId: number; roles: ReadonlyMap<number, AreaRole>; opens: ReadonlySet<number> };
