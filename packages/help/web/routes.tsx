// Help (the site's guides): pages and menu item.
import { BookOpen } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { Help } from './pages/Help';

export const routes: PageRoute[] = [
  { path: 'help', page: () => <Help />, needs: 'signed-in' },
  { path: 'help/:guide', page: () => <Help />, needs: 'signed-in' },
  { path: 'help/:guide/:section', page: () => <Help />, needs: 'signed-in' },
];

export const menu = {
  help: { to: '/help', label: 'Help', icon: BookOpen, needs: 'signed-in' },
} satisfies Record<string, NavItem>;
