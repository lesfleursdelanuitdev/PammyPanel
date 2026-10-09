// Services (docs/adopt-plan.md V9): the page and its menu item.
import { lazy } from 'react';
import { Archive, Boxes } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Services = lazy(() => import('./pages/Services'));
// Settings > Backups (docs/lfdln-mariadb-plan.md B1): admins only
const Backups = lazy(() => import('./pages/Backups'));

export const routes: PageRoute[] = [
  { path: 'services', page: () => later(<Services />), needs: 'services', wholeSite: true },
  { path: 'backups', page: () => later(<Backups />), needs: 'admin', wholeSite: true },
];

export const menu = {
  services: { to: '/services', label: 'Services', icon: Boxes, needs: 'services', wholeSite: true },
  backups: { to: '/backups', label: 'Backups', icon: Archive, needs: 'admin', wholeSite: true },
} satisfies Record<string, NavItem>;
