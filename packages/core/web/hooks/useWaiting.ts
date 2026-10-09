// What's waiting: open requests (requests) and unread responses and comments (forms,
// comments), checked every minute (and whenever the panel's window comes back into view).
// The site asks, and only of the modules its profile has switched on.
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isOn } from '../lib/site';
import { may } from '../lib/rights';
import type { Me } from '../lib/types';

export const WAITING_EVERY = 60_000;

export function useWaiting(me: Me) {
  // only what they have (docs/permissions-plan.md R4): no protected folders, no Requests (D23)
  const askRequests = isOn('requests') && may(me, 'protected');
  const askResponses = isOn('forms') && may(me, 'responses');
  const requests = useQuery({ queryKey: ['/api/requests'], queryFn: () => api<{ open: unknown[] }>('/api/requests'), refetchInterval: WAITING_EVERY, enabled: askRequests });
  const responses = useQuery({ queryKey: ['/api/responses/unread'], queryFn: () => api<{ unread: number; comments?: number }>('/api/responses/unread'), refetchInterval: WAITING_EVERY, enabled: askResponses });
  return {
    requests: requests.data?.open.length ?? 0, responses: responses.data?.unread ?? 0, comments: responses.data?.comments ?? 0,
    loaded: (!askRequests || requests.isSuccess) && (!askResponses || responses.isSuccess),
  };
}
