// Hosts, routes and site folders (docs/hosts-plan.md step 3): the page and its menu item.
import { lazy } from 'react';
import { Server } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Hosts = lazy(() => import('./pages/Hosts'));
const AddDomain = lazy(() => import('./pages/AddDomain'));

export const routes: PageRoute[] = [
  { path: 'hosts', page: () => later(<Hosts />), needs: 'hosts' },
  // the setup guide (docs/domains-hosts-plan.md step 4)
  { path: 'hosts/add-domain', page: () => later(<AddDomain />), needs: 'hosts' },
];

export const menu = {
  hosts: { to: '/hosts', label: 'Hosts', icon: Server, needs: 'hosts' },
} satisfies Record<string, NavItem>;
