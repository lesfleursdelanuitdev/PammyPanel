// Tags & categories where the sources are services' things (docs/catalog-plan.md step 5):
// the pages and the menu item. pammy.org's Tags page is File Explorer's (MediaTags.tsx).
import { lazy } from 'react';
import { Tags } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Catalog = lazy(() => import('./pages/Catalog'));
const AppItems = lazy(() => import('./pages/AppItems'));

export const appRoutes: PageRoute[] = [
  { path: 'catalog', page: () => later(<Catalog />), needs: 'services', wholeSite: true },
  { path: 'catalog/:service/:resource', page: () => later(<AppItems />), needs: 'services', wholeSite: true },
];

export const menu = {
  catalog: { to: '/catalog', label: 'Tags & categories', icon: Tags, needs: 'services', wholeSite: true },
} satisfies Record<string, NavItem>;
