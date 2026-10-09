// lfdln-gate.service: lfdln's gate on 127.0.0.1:3047 (docs/accounts-plan.md step 3),
// @panel/gate with lfdln's profile. Its own user, database role (pammy_gate on
// :5435, as the code names it) and cookie; every host sends /_pammy/ to it, and nginx
// asks it about the routes with accounts (docs/roles-plan.md step 5, docs/phase8-plan.md 8-2).
import { startGate } from '@panel/gate/start';
import { PROFILE } from '../profile.ts';

await startGate(PROFILE, { unit: 'lfdln-gate', passwordFile: '/etc/lfdln-panel/db/gate.pass' });
