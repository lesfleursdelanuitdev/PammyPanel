// Comments: the page and its menu item.
import { lazy } from 'react';
import { MessageSquare } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Comments = lazy(() => import('./pages/Comments'));

export const routes: PageRoute[] = [
  { path: 'comments', page: () => later(<Comments />), needs: 'comments' },
];

export const menu = {
  comments: { to: '/comments', label: 'Comments', icon: MessageSquare, count: 'comments', needs: 'comments' },
} satisfies Record<string, NavItem>;
