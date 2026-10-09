// Monitoring (docs/monitoring-plan.md M5): the page and its menu item.
import { lazy } from 'react';
import { Activity } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Monitoring = lazy(() => import('./pages/Monitoring'));

export const routes: PageRoute[] = [
  { path: 'monitoring', page: () => later(<Monitoring />), needs: 'monitoring', wholeSite: true },
];

export const menu = {
  monitoring: { to: '/monitoring', label: 'Monitoring', icon: Activity, needs: 'monitoring', wholeSite: true },
} satisfies Record<string, NavItem>;
