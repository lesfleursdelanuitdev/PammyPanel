// pammy-pammydb-gate.service: pammy.org's database helper for the gate (S2, docs/s2-plan.md).
// The same helper as main.ts, on the gate's own socket (pammy-pammydb-gate.socket, only
// svc-pammygate may open it), answering row ops only. lfdln's is
// sites/lfdln/src/helpers/pammydb-gate.ts.
import { PAMMY_HELPER } from './config.ts';
import { startPammyDb } from './start.ts';

startPammyDb(PAMMY_HELPER, process.env, 'gate');
