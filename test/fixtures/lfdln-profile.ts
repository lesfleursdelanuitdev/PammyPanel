// lfdln's real profile (sites/lfdln/src/profile.ts) with EVERY module switched on, for
// the tests that check what the others would look like there: its words on every page,
// every nginx file rendered for a direct site. The facts only other modules need are
// pammy.org's (lfdln gets its own as each module comes on, phase 8).
import { MODULES, type SiteProfile } from '@panel/core/profile';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { PROFILE as PAMMY } from '@panel/pammy/profile';

export const PROFILE = {
  ...PAMMY,
  ...LFDLN,
  services: { ...PAMMY.services, ...LFDLN.services, sockets: { ...PAMMY.services.sockets, ...LFDLN.services.sockets } },
  modules: MODULES,
} satisfies SiteProfile;
