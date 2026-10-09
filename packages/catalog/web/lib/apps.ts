// A service's things in the catalog (docs/catalog-plan.md step 5), as the routes send them
// (@panel/catalog panel/routes/apps.ts).
import type { Names, ScopeLabel } from './labels';

export type Use = { kind: 'tag' | 'category'; label: string; means: string | null };
export type ReadState = { at: number; items: number; missing: number; error: string | null };
export type Counts = { items: number; labelled: number; links: number; labels: number };
export type AppResource = {
  key: string; label: string; source: number | null; offered: boolean; open: string | null; scopes: string | null;
  uses: Record<string, Use>; counts: Counts | null; state: ReadState | null;
};
export type AppStatus = { service: { id: string; title: string }; on: boolean; error: string | null; resources: AppResource[]; max: number };
export type AppResourcePage = {
  service: { id: string; title: string }; resource: AppResource; counts: Counts;
  labels: ScopeLabel[]; scopes: { id: number; label: string; items: number }[];
};
export type AppItem = { key: string; title: string | null; scope: string | null; labels: Names };

// where an item opens: {id} in the manifest's address (a path is on the host the service is at,
// which the panel doesn't know: shown, not linked)
export const openOf = (open: string | null, key: string) => (open ? open.replaceAll('{id}', encodeURIComponent(key)) : null);
