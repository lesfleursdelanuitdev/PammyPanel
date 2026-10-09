// People (visitors who sign in): the page and its menu item (docs/roles-plan.md step 1).
import { Users } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { People } from './pages/People';

export const routes: PageRoute[] = [
  { path: 'people', page: () => <People />, needs: 'protected' },
];

export const menu = {
  people: { to: '/people', label: 'People', icon: Users, needs: 'protected' },
} satisfies Record<string, NavItem>;
