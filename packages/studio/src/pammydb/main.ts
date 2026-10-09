// pammy-pammydb.service: pammy.org's database helper, the only thing on this machine
// that speaks to Pamela's own MariaDB (127.0.0.1:3307) and Postgres (127.0.0.1:5433) --
// not the panel's database, not the host's (config.ts PAMMY_HELPER, S7). lfdln's is
// sites/lfdln/src/helpers/pammydb.ts (docs/phase8-plan.md 8-4).
import { PAMMY_HELPER } from './config.ts';
import { startPammyDb } from './start.ts';

startPammyDb(PAMMY_HELPER);
