// Projects (docs/phase8b-plan.md): the page and its menu item.
import { lazy } from 'react';
import { Hammer } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Projects = lazy(() => import('./pages/Projects'));
const Packages = lazy(() => import('./pages/Packages'));
const GitTokens = lazy(() => import('./pages/GitTokens'));

export const routes: PageRoute[] = [
  { path: 'projects', page: () => later(<Projects />), needs: 'projects', wholeSite: true },
  // a project's packages and scripts (8b-8a)
  { path: 'projects/:id/packages', page: () => later(<Packages />), needs: 'projects', wholeSite: true },
  // your git tokens, for git over HTTPS (8b-7)
  { path: 'projects/git-tokens', page: () => later(<GitTokens />), needs: 'projects', wholeSite: true },
];

export const menu = {
  projects: { to: '/projects', label: 'Projects', icon: Hammer, needs: 'projects', wholeSite: true },
} satisfies Record<string, NavItem>;
