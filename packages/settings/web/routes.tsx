// Settings (docs/roles-plan.md R1): the panel's email (docs/apps-plan.md phase 3)
// and what visitors may do for themselves (docs/accounts-plan.md A5). Each part
// shows only with its module on (the site's menu says which).
import { lazy } from 'react';
import { Mail, SlidersHorizontal } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';
import { isOn } from '@panel/core/web/lib/site';
import { VisitorSettings } from './pages/VisitorSettings';

const Email = lazy(() => import('./pages/Email'));

// Email: the Installed software part where the site has it (pammy.org), admins only where it
// doesn't (lfdln, docs/lfdln-mariadb-plan.md finding 11), as the server says
const emailNeeds = isOn('apps') ? 'software' : 'admin';

// [the module the part needs, the page]
export const parts: { mail: PageRoute[]; areas: PageRoute[] } = {
  mail: [{ path: 'email', page: () => later(<Email />), needs: emailNeeds }],
  areas: [{ path: 'visitor-settings', page: () => <VisitorSettings />, needs: 'visitor-settings' }],
};

export const menu = {
  email: { to: '/email', label: 'Email', icon: Mail, needs: emailNeeds },
  visitors: { to: '/visitor-settings', label: 'Visitors', icon: SlidersHorizontal, needs: 'visitor-settings' },
} satisfies Record<string, NavItem>;
