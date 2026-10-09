// The apps she has switched on (docs/databases-plan.md 11.6). One group per
// active database, named by what she called the app, one item per thing it
// manages. Read from the panel's own tables, so a sleeping engine never holds
// the menu up.
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import type { NavGroup } from '@panel/core/web/components/shell';
import { api } from '@panel/core/web/lib/api';
import { may } from '@panel/core/web/lib/rights';
import type { Me } from '@panel/core/web/lib/types';

export type AppMenu = { engine: string; name: string; title: string; things: { table: string; plural: string }[] };
export function useApps(me: Me) {
  const q = useQuery({
    queryKey: ['/api/apps'],
    queryFn: () => api<{ apps: AppMenu[] }>('/api/apps'),
    enabled: may(me, 'databases'),
  });
  return q.data?.apps ?? [];
}

// ...as groups for the menu, after the site's own
export function useAppGroups(me: Me): NavGroup[] {
  return useApps(me).map((app) => ({
    label: app.title,
    items: app.things.map((thing) => ({
      to: `/app/${app.engine}/${app.name}/${thing.table}`,
      label: thing.plural,
      icon: Boxes,
      needs: 'databases' as const,
    })),
  }));
}
