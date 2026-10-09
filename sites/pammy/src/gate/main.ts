// pammy-gate.service: password-protected folders for her website, on 127.0.0.1:3045
// (the gate itself is @panel/gate's, the same for every site: docs/accounts-plan.md step 3).
import { startGate } from '@panel/gate/start';
import { PROFILE } from '../profile.ts';

await startGate(PROFILE, { unit: 'pammy-gate', passwordFile: '/etc/pammy-panel/db/gate.pass' });
