// The core's pages and menu items (the site puts them together: sites/pammy/web/src).
// Login and Invite are signed-out pages; the site routes them itself.
import { Clock, KeyRound, UserCog } from 'lucide-react';
import type { NavItem } from './components/shell';
import type { PageRoute } from './lib/routes';
import { Accounts } from './pages/Accounts';
import { Activity } from './pages/Activity';
import { Passkeys } from './pages/Passkeys';

export const routes: PageRoute[] = [
  { path: 'passkeys', page: () => <Passkeys />, needs: 'signed-in' },
  { path: 'accounts', page: () => <Accounts />, needs: 'admin' },
  { path: 'activity', page: () => <Activity />, needs: 'signed-in' },
];

export const menu = {
  passkeys: { to: '/passkeys', label: 'Passkeys & devices', icon: KeyRound, needs: 'signed-in' },
  accounts: { to: '/accounts', label: 'Accounts', icon: UserCog, needs: 'admin' },
  activity: { to: '/activity', label: 'Activity', icon: Clock, needs: 'signed-in' },
} satisfies Record<string, NavItem>;
