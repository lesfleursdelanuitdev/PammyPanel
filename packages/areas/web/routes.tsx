// Protected folders: the page and its menu item. The people who open them are
// @panel/people's, their requests @panel/requests' (docs/roles-plan.md step 1).
import { LockKeyhole } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { Access } from './pages/Access';
import { ProtectedFolders } from './pages/ProtectedFolders';

export const routes: PageRoute[] = [
  { path: 'protected-folders', page: () => <ProtectedFolders />, needs: 'protected' },
  // docs/roles-plan.md step 4: one folder's roles and privileges
  { path: 'access/:id', page: () => <Access />, needs: 'protected' },
  { path: 'access/:id/:tab', page: () => <Access />, needs: 'protected' },
];

export const menu = {
  protectedFolders: { to: '/protected-folders', label: 'Protected folders', icon: LockKeyhole, needs: 'protected' },
} satisfies Record<string, NavItem>;
