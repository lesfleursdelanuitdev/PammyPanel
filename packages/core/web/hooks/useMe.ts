// Who is signed in (App.tsx fetched it once already, so this is from the cache).
import { useApi } from './useApi';
import type { Me } from '../lib/types';

export function useMe(): Me | null {
  return useApi<{ user: Me }>('/api/session', { staleTime: Infinity, refetchOnWindowFocus: false }).data?.user ?? null;
}
