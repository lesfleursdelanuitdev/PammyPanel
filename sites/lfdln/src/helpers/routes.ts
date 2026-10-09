// lfdln-routes.service: the routing helper (docs/hosts-plan.md H7) with lfdln's profile,
// and the services' ports from their record (docs/adopt-plan.md V3).
import { runRoutes } from '@panel/hosts/helper/main';
import { RECORD } from '@panel/services/helper/main';
import { loadRecord } from '@panel/services/record';
import { PROFILE } from '../profile.ts';
import { hostsConfigOf, routeKindsOf } from '../hosts.ts';

runRoutes(PROFILE, process.env, () => loadRecord(RECORD).services.flatMap((s) =>
  s.parts.filter((p) => p.port !== null).map((p) => ({ service: s.id, part: p.id, port: p.port! }))), routeKindsOf(PROFILE), hostsConfigOf(PROFILE).served);
