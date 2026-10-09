// pammy.org's gate app: @panel/gate's, with pammy.org's profile (docs/accounts-plan.md step 3).
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { GateLive } from '@panel/core/gate/live';
import { buildGateApp as build, type GateOptions } from '@panel/gate/app';
import { PROFILE } from '../profile.ts';

export { EXAMPLE_FILES, EXAMPLE_LOOKS, type GateOptions } from '@panel/gate/app';

export const buildGateApp = (given: GateOptions, live: GateLive, opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void } = {}): FastifyInstance =>
  build(PROFILE, given, live, opts);
