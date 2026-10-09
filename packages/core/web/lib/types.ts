// What the panel API sends back (src/app.ts is the source of truth).
import type { Right } from './rights';

// rights: the parts of the panel they have (docs/permissions-plan.md R4); places:
// what they are kept to, ['/olivia'] (D22, R5), or [] for the whole site.
export type Me = { id: number; username: string; displayName: string; role: 'manager' | 'member'; rights: Right[]; places: string[] };

// The website's folders (GET /api/sites): every module works folder by folder.
export type Folder = { name: string; subdomain: boolean; reserved: boolean; hasIndex: boolean; homePage: 'none' | 'own' | 'temporary'; protected: boolean; symlink: boolean };
export type TrashedFolder = { entry: string; name: string; trashedAt: number; purgeAt: number };
export type SitesData = { folders: Folder[]; trash: TrashedFolder[]; reserved: string[]; purgeDays: number };

// The gate's protected folders and visitors (GET /api/protected; the server's shapes are
// in @panel/core/panel/gate-shapes too).
export type Area = {
  id: number; path: string; exists: boolean; hasIndex: boolean; pages: string[]; copies: string[];
  visitors: number[]; requestsOpen: boolean;
};
export type Visitor = {
  id: number; username: string; name: string; contact: string; active: boolean; hasPassword: boolean;
  lastLoginAt: number | null; sessions: number; linkExpiresAt: number | null; failedLast24h: number;
  // false: they also open folders outside the signed-in person's places, so only
  // someone who looks after the whole site changes them (docs/permissions-plan.md R5)
  whole: boolean;
  areas: number[];   // the protected folders they open (for someone kept to places: only theirs)
  // registered: they made the account themselves (docs/accounts-plan.md step 4): its
  // address, and whether they've confirmed it. The owner's people have no address.
  email: string | null; emailConfirmed: boolean; registered: boolean;
};
// folders: the ones there are to protect; reserved: the names the server keeps
// rolesOn: Settings > Visitors' roles switch (docs/roles-plan.md step 4)
export type GateState = { areas: Area[]; visitors: Visitor[]; locked: string[]; folders: string[]; reserved: string[]; rolesOn?: boolean };

export type Passkey = { id: number; name: string; createdAt: number; lastUsedAt: number | null; synced: boolean; thisSession: boolean };
export type SessionRow = { id: number; device: string; createdAt: number; lastSeenAt: number; ip: string | null; current: boolean };
export type Account = {
  id: number; username: string; displayName: string; role: 'manager' | 'member'; active: boolean; isYou: boolean;
  passkeys: { id: number; name: string; lastUsedAt: number | null }[]; lastLoginAt: number | null; sessions: number; inviteExpiresAt: number | null;
  rights: Right[];               // the parts of the panel written for it (docs/permissions-plan.md R4); none for an account manager, who has them all
  places: string[];              // ['/olivia', '/garden']: kept to those folders (R5); [] the whole site
};
export type ActivityEntry = { id: number; at: number; actor_label: string; action: string; target: string | null; detail: string | null; ip: string | null };
