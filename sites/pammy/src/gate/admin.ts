// pammy.org's gate admin: @panel/gate's, with pammy.org's modules and database
// helper wherever the caller doesn't say (docs/accounts-plan.md step 3).
import type { Server } from 'node:net';
import type { JsonRequest } from '@panel/core/jsonline';
import type { GateLive } from '@panel/core/gate/live';
import { createGateAdminServer as createServer, handleAdmin as handle, type AdminConfig } from '@panel/gate/admin';
import { PROFILE } from '../profile.ts';

export type { AdminConfig } from '@panel/gate/admin';

const pammy = (cfg: AdminConfig): AdminConfig => ({
  // the gate's own door to the database helper, row ops only (S2)
  ...cfg, modules: cfg.modules ?? PROFILE.modules, pammydbSocket: cfg.pammydbSocket ?? PROFILE.services.sockets.pammydbGate,
});
const DEFAULT_CONFIG: AdminConfig = { publicRoot: null, domain: PROFILE.domain };

export const handleAdmin = (g: GateLive, now: number, req: JsonRequest, cfg: AdminConfig = DEFAULT_CONFIG): Promise<unknown> =>
  handle(g, now, req, pammy(cfg));
export const createGateAdminServer = (g: GateLive, now: () => number, log: (line: string) => void = () => {}, cfg: AdminConfig = DEFAULT_CONFIG): Server =>
  createServer(g, now, log, pammy(cfg));
