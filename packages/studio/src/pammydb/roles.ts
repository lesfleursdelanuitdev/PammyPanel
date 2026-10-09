// The four roles a database user can have on one database
// (docs/databases-plan.md 9, "Roles (v1 -- no privilege matrix)"). Four names,
// in her words, and nothing about SQL: each driver maps them onto its own
// GRANT statements, because that is the dialect's business.
//
// A word about the word "role". On Postgres a login IS a role, and the product
// plan's helper table calls the ops `create-role` / `grant-role` for that
// reason. The panel does not: here a **user** is a login and a **role** is one
// of these four, because that is what she reads on the page. Using one word for
// both would be the `pg` / `postgres` mistake S11 was fixed to stop
// (docs/studio-plan.md S12).
import { PammyDbError } from './ident.ts';

export type AccessRole = 'read' | 'write' | 'structure' | 'admin';

// Ordered weakest first: the page lists them this way and `atLeast` compares on it.
export const ACCESS_ROLES: AccessRole[] = ['read', 'write', 'structure', 'admin'];

export const ROLE_NAMES: Record<AccessRole, string> = {
  read: 'Read only',
  write: 'Read & write',
  structure: 'Structure editor',
  admin: 'Administrator',
};

// One line each, hers, for the radio buttons. The plan's "She sees" column.
export const ROLE_BLURBS: Record<AccessRole, string> = {
  read: 'Can look at the information, and change nothing.',
  write: 'Can look at the information, and add, change and remove it.',
  structure: 'All of that, and can add and change tables as well.',
  admin: 'Everything inside this database. It still cannot delete the database itself.',
};

export const isAccessRole = (v: unknown): v is AccessRole =>
  typeof v === 'string' && (ACCESS_ROLES as string[]).includes(v);

export const roleRank = (r: AccessRole) => ACCESS_ROLES.indexOf(r);

// What a user turns out to have on a database. `custom` is not one of the four:
// it means the grants on the engine are not any of the shapes the panel makes,
// because someone used psql or HeidiSQL. The panel says so and does not pretend
// to know which of the four it is nearest to.
export type GrantedRole = AccessRole | 'custom';

export type Access = {
  database: string;
  role: GrantedRole;
};

export function checkAccessRole(v: unknown): AccessRole {
  if (!isAccessRole(v)) throw new PammyDbError('invalid', 'That is not one of the four kinds of access.');
  return v;
}
