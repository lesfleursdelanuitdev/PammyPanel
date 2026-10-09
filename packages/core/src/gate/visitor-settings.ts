// What visitors may do for themselves (docs/accounts-plan.md A5): switches the
// panel's owners turn on and off on Settings > Visitors, every one off by default,
// so a site keeps today's behaviour until its owners choose otherwise.
//
// Kept in gate.visitor_settings (areas/0001-visitor-accounts.sql, one row). The
// gate reads it into memory with the areas (live.ts), so nothing on a public page
// waits for Postgres to know what is on; the panel changes it only through the
// gate's admin socket, which checks every change.
//
// This is the read side, which stays in the kernel with live.ts until K-b's registered
// caches (docs/k-a-plan.md KA-Q3). The rules and the writing are people's: the words,
// NEEDS and whyNot in @panel/people/shared/visitor-switches, needing and setVisitorSwitch
// in @panel/people/gate/visitor-settings (K-a4).
import { one, type Db } from '../pg.ts';

export const SWITCHES = ['emailedLinks', 'selfRegister', 'changePassword', 'deleteAccount', 'openAreas', 'roles'] as const;
export type Switch = (typeof SWITCHES)[number];
export type VisitorSettings = Readonly<Record<Switch, boolean>>;
export const isSwitch = (v: unknown): v is Switch => typeof v === 'string' && (SWITCHES as readonly string[]).includes(v);

export const ALL_OFF: VisitorSettings = Object.freeze({ emailedLinks: false, selfRegister: false, changePassword: false, deleteAccount: false, openAreas: false, roles: false });

// each switch's column (people's setVisitorSwitch writes them)
export const COLUMN: Readonly<Record<Switch, string>> = {
  emailedLinks: 'emailed_links', selfRegister: 'self_register', changePassword: 'change_password',
  deleteAccount: 'delete_account', openAreas: 'open_areas', roles: 'roles',
};

// The switches this code can carry out. Each later step of the plan adds its
// own when the feature behind it is built; until then the switch can't be
// turned on anywhere (step 1: none). A switch on in the database that this code
// can't carry out counts as off (going back to an older release).
// roles: the Access page's roles and privileges (docs/roles-plan.md step 4).
// The accounts (docs/accounts-plan.md step 4): emailed links, registering, and
// changing and deleting one's own account. "Open with accounts" areas: routes that
// anyone may use, the app told who is signed in (docs/roles-plan.md step 5).
export const BUILT: ReadonlySet<Switch> = new Set<Switch>(['roles', 'emailedLinks', 'selfRegister', 'changePassword', 'deleteAccount', 'openAreas']);

type Row = Record<string, boolean | string | number | null>;

// From the row, or from a saved copy: only a true that this code can carry out is on.
// built: which switches count (tests pass their own; everything else, BUILT).
export function settingsOf(row: Partial<Record<string, unknown>> | undefined, byColumn = true, built: ReadonlySet<Switch> = BUILT): VisitorSettings {
  const s = { ...ALL_OFF } as Record<Switch, boolean>;
  if (!row) return ALL_OFF;
  for (const k of SWITCHES) s[k] = row[byColumn ? COLUMN[k] : k] === true && built.has(k);
  return Object.freeze(s);
}

export type SettingsState = { switches: VisitorSettings; changedBy: string | null; changedAt: number | null };

export async function readVisitorSettings(db: Db, built: ReadonlySet<Switch> = BUILT): Promise<SettingsState> {
  const row = await one<Row>(db, 'SELECT * FROM visitor_settings WHERE id = 1');
  return { switches: settingsOf(row, true, built), changedBy: (row?.changed_by as string | null) ?? null, changedAt: (row?.changed_at as number | null) ?? null };
}
