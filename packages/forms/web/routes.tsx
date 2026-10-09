// Forms, their responses and the form examples: pages and menu items (the API keys
// page is @panel/api-keys' since docs/catalog-plan.md step 3c).
import { Inbox, Send, Sparkles } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { Example, Examples } from './pages/Examples';
import { FormBuilder } from './pages/FormBuilder';
import { Forms } from './pages/Forms';
import { Responses } from './pages/Responses';

export const routes: PageRoute[] = [
  { path: 'examples', page: () => <Examples />, needs: 'forms', wholeSite: true },
  { path: 'examples/:kind', page: () => <Example />, needs: 'forms', wholeSite: true },
  { path: 'forms', page: () => <Forms />, needs: 'forms' },
  { path: 'forms/:id', page: () => <FormBuilder />, needs: 'forms' },
  { path: 'responses', page: () => <Responses />, needs: 'responses' },
];

export const menu = {
  responses: { to: '/responses', label: 'Responses', icon: Inbox, count: 'responses', needs: 'responses' },
  forms: { to: '/forms', label: 'Forms', icon: Send, needs: 'forms' },
  examples: { to: '/examples', label: 'Form examples', icon: Sparkles, needs: 'forms', wholeSite: true },
} satisfies Record<string, NavItem>;
