// Getting started (pammy.org's questionnaire and paths, docs/getting-started-plan.md): its page.
import type { PageRoute } from '@panel/core/web/lib/routes';
import { GettingStarted } from './pages/GettingStarted';

export const routes: PageRoute[] = [
  { path: 'getting-started', page: () => <GettingStarted />, needs: 'databases' },
];
