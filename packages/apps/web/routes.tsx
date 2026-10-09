// Installed software, WordPress (docs/apps-plan.md): pages and menu item.
import { lazy } from 'react';
import { Package } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Software = lazy(() => import('./pages/Software'));
const SoftwareInstall = lazy(() => import('./pages/SoftwareInstall'));
const SoftwareDetail = lazy(() => import('./pages/Software').then((m) => ({ default: m.SoftwareDetail })));

export const routes: PageRoute[] = [
  { path: 'software', page: () => later(<Software />), needs: 'software' },
  { path: 'software/new', page: () => later(<SoftwareInstall />), needs: 'software' },
  { path: 'software/:id', page: () => later(<SoftwareDetail />), needs: 'software' },
];

export const menu = {
  software: { to: '/software', label: 'Installed software', icon: Package, needs: 'software' },
} satisfies Record<string, NavItem>;
