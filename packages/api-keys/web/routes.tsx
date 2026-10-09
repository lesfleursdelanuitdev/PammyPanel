// API keys: the page and its menu item (docs/catalog-plan.md step 3c).
import { KeyRound } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import type { PageRoute } from '@panel/core/web/lib/routes';
import type { AnyKeyCover } from './lib/covers';
import { ApiKeys } from './pages/ApiKeys';

// no page when no module on gives a key something to read
export const routes = (covers: readonly AnyKeyCover[]): PageRoute[] => (covers.length ? [
  { path: 'api-keys', page: (me) => <ApiKeys me={me} covers={covers} />, needs: 'programs' },
] : []);

export const menu = {
  apiKeys: { to: '/api-keys', label: 'API keys', icon: KeyRound, needs: 'programs' },
} satisfies Record<string, NavItem>;
