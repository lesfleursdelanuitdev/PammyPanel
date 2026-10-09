// lfdln-pammydb-gate.service (@panel/studio, S2, docs/s2-plan.md): lfdln's database helper for
// the gate, on its own socket (lfdln-pammydb-gate.socket, only svc-lfdlngate may open it),
// answering row ops only. The same engines and rules as helpers/pammydb.ts.
import { startPammyDb } from '@panel/studio/pammydb/start';
import { LFDLN_HELPER } from '../studio-site.ts';

startPammyDb(LFDLN_HELPER, process.env, 'gate');
