// Asking the services helper (lfdln-services.socket), as the panel and the hosts
// routes do: a refusal comes back as the panel says a helper's.
import { callJsonLine } from '@panel/core/jsonline';

// a start waits for the containers to answer (helper/service.ts TIMEOUT)
export const callServices = <T>(socket: string, req: Record<string, unknown>): Promise<T> =>
  callJsonLine<T>(socket, req, 'services helper', 16 * 60_000);

export type PortOf = { service: string; part: string; title: string; port: number };
