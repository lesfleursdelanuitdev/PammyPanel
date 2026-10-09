import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { SITE } from '../lib/site';

// A GET from the panel API, cached under its own address.
export function useApi<T>(path: string | null, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api<T>(path!), enabled: path !== null, ...opts });
}

export function usePageTitle(title: string | null) {
  useEffect(() => {
    if (title) document.title = `${title} · ${SITE.panelName}`;
  }, [title]);
}
