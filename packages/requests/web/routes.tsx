// Requests from visitors: the page and its menu item (docs/roles-plan.md step 1).
import { ClipboardList } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { Requests } from './pages/Requests';

export const routes: PageRoute[] = [
  { path: 'requests', page: () => <Requests />, needs: 'protected' },
];

export const menu = {
  requests: { to: '/requests', label: 'Requests', icon: ClipboardList, count: 'requests', needs: 'protected' },
} satisfies Record<string, NavItem>;
