// What the panel API sends back for this module (its routes are the source of truth).
export type SetupLink = { url: string; expiresAt: number; firstPassword: boolean };

export type Person = { id: number; username: string; name: string; contact: string; active: boolean };

// GET /api/access/:id (docs/roles-plan.md step 4): a folder's roles and privileges
export type AccessResource = { key: string; label: string; owned: boolean; actions: string[] };
export type AccessRole = { id: number; key: string; label: string; slot: string | null; groups: number[]; privileges: string[]; parts: number[]; all: string[]; people: number };
export type AccessGroup = { id: number; key: string; label: string; privileges: string[] };
export type AccessView = {
  area: { id: number; path: string; kind: 'folder' | 'route' };   // a route's (docs/roles-plan.md step 6): path is its address
  set: { id: number; label: string; builtIn: boolean; key: string | null; copiedFrom: string | null; fromManifest: boolean; manifestReadAt: number | null };
  canEditRoles: boolean;
  canEditPrivileges: boolean;
  resources: AccessResource[];
  actions: { key: string; label: string }[];
  privileges: string[];
  groups: AccessGroup[];
  roles: AccessRole[];
  signedInRoleId: number | null;
  neverTogether: { a: number; b: number; fromManifest: boolean }[];
  members: { visitorId: number; roleId: number }[];
  rolesOn: boolean;
  people: { id: number; username: string; name: string; active: boolean }[];
};
