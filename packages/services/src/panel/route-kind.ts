// "Go to a service" on the Hosts page (docs/adopt-plan.md V3; docs/domains-hosts-plan.md
// step 2): the panel's half of the services module's kind of target (the routing
// helper's half is ../route-kind.ts). A route names a service and one of its parts, as
// the services helper lists them with their ports; sending a host to one needs the
// Services part of the panel too (it is about the whole server, docs/adopt-plan.md V8).
import { AccountError } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { HELPER_STATUS } from '@panel/core/panel/context';
import { keptTo, mayUse } from '@panel/core/panel/rights';
import { maxBodyMb, NameError, signInPath } from '@panel/hosts/names';
import type { PanelRouteKind } from '@panel/hosts/panel/route-kinds';
import type { ServicePart } from '@panel/hosts/render';

// A part of a service a route may send visitors to (the services helper's "ports").
export type ServicePort = ServicePart & { title: string };

export function serviceRouteKind(opts: { ports: () => Promise<ServicePort[]> }): PanelRouteKind {
  const ports = async (): Promise<ServicePort[]> => {
    try { return await opts.ports(); } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };
  const named = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof NameError) throw new AccountError(e.message, 400);
      throw e;
    }
  };
  return {
    kind: 'service', label: 'Go to a service', accounts: true,
    make: async (_q, a, b) => {
      if (!mayUse(a.user, 'services', true)) throw new AccountError('Sending a host to a service needs the Services part of the panel too.', 403);
      const p = (await ports()).find((x) => x.service === b.service && x.part === b.part);
      if (!p) throw new AccountError('That service isn\'t there (or has no port).', 404);
      const maxBody = named(() => maxBodyMb(b.maxBodyMb ?? null));
      const signIn = named(() => (Array.isArray(b.signInPaths) ? b.signInPaths.slice(0, 50).map(signInPath) : []));
      return {
        ref: { service: p.service, part: p.part, websockets: b.websockets !== false, maxBodyMb: maxBody, signInPaths: signIn },
        what: `service ${p.title}`,
      };
    },
    services: ports,
    // what a service route may point at: for those who may use services too
    options: async (a) => ({ services: mayUse(a.user, 'services') && keptTo(a.user) === null ? await ports().catch(() => []) : [] }),
  };
}
