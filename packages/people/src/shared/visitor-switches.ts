// The visitor switches' words and rules (docs/accounts-plan.md A5; docs/k-a-plan.md K-a4
// and KA-Q4, moved from core's gate/visitor-settings.ts): what each is called, which one
// needs which, and why one can't be turned on now. Settings > Visitors shows them (the
// settings module needs people for these); the gate's admin socket checks every change
// with the same rules (../gate/visitor-settings.ts). What is on, as read, stays the
// kernel's until K-b (@panel/core/gate/visitor-settings).
import { BUILT, type Switch, type VisitorSettings } from '@panel/core/gate/visitor-settings';

// The switch each one needs on first (the table's checks say the same).
export const NEEDS: Readonly<Partial<Record<Switch, Switch>>> = { selfRegister: 'emailedLinks', openAreas: 'selfRegister' };

// What the panel knows and the gate can't: whether this panel's mail is set up
// (the gate has no network and no mail of its own).
// built: as settingsOf's.
export type Abilities = { mail: boolean; built?: ReadonlySet<Switch> };

// Why this switch can't be turned on now, or null.
export function whyNot(s: Switch, on: VisitorSettings, can: Abilities): string | null {
  if (!(can.built ?? BUILT).has(s)) return 'This comes in a later release of the panel.';
  if (s === 'emailedLinks' && !can.mail) return "Mail isn't set up for visitors on this site.";
  const need = NEEDS[s];
  if (need && !on[need]) return `Needs "${SWITCH_WORDS[need]}" on first.`;
  return null;
}

export const SWITCH_WORDS: Record<Switch, string> = {
  emailedLinks: 'Emailed links',
  selfRegister: 'People can register themselves',
  changePassword: 'People can change their own password',
  deleteAccount: 'People can delete their own account',
  openAreas: '"Open with accounts" areas',
  roles: 'Roles and privileges on the Access page',
};
