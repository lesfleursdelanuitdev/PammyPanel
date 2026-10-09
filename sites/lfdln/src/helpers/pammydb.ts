// lfdln-pammydb.service (@panel/studio): lfdln's database helper, the only thing that speaks to
// lfdln-appdb (127.0.0.1:5436) for the Studio -- its own databases, and the apps' read-only
// (docs/phase8-plan.md 8-4). Never Pamela's engines, never a panel's own database.
import { startPammyDb } from '@panel/studio/pammydb/start';
import { LFDLN_HELPER } from '../studio-site.ts';

startPammyDb(LFDLN_HELPER);
