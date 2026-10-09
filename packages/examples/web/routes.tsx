// The database examples and the tutorial examples: pages and menu items.
import { lazy } from 'react';
import { GraduationCap, Sparkles } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const DatabaseExamples = lazy(() => import('./pages/DatabaseExamples'));
const DatabaseExample = lazy(() => import('./pages/DatabaseExamples').then((m) => ({ default: m.DatabaseExample })));
const TutorialExamples = lazy(() => import('./pages/TutorialExamples'));

export const routes: PageRoute[] = [
  { path: 'databases/examples', page: () => later(<DatabaseExamples />), needs: 'examples' },
  { path: 'databases/examples/:kind', page: () => later(<DatabaseExample />), needs: 'examples' },
  { path: 'databases/tutorial-examples', page: () => later(<TutorialExamples />), needs: 'examples' },
];

export const menu = {
  databases: { to: '/databases/examples', label: 'Database examples', icon: Sparkles, needs: 'examples' },
  tutorials: { to: '/databases/tutorial-examples', label: 'Tutorial examples', icon: GraduationCap, needs: 'examples' },
} satisfies Record<string, NavItem>;
