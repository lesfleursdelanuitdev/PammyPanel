// The gate's hourly clean-up: each package's own, in this order (docs/packaging-plan.md
// step 1b; docs/k-a-plan.md K-a4: the store's split into people's, the event log's and
// requests' parts -- every foreign key between them is ON DELETE SET NULL / CASCADE, so
// the order doesn't change the result). The gate core no longer calls forms' part itself.
import type { Db } from '@panel/core/pg';
import type { Module } from '@panel/core/profile';
import { eventsHousekeeping } from '@panel/core/gate/ops';
import { formsHousekeeping } from '@panel/forms/gate/forms/responses';
import { housekeeping as requestsHousekeeping } from '@panel/core/gate/store';
import { peopleHousekeeping } from '@panel/people/gate/housekeeping';
import { deletionsHousekeeping } from '@panel/areas/gate/deletions';

export async function gateHousekeeping(db: Db, now: number, modules: readonly Module[]) {
  await peopleHousekeeping(db, now);
  await eventsHousekeeping(db, now);
  await requestsHousekeeping(db, now);
  // deleted accounts not passed on in 30 days (pammy.org has no services to tell)
  await deletionsHousekeeping(db, now);
  if (modules.includes('forms')) await formsHousekeeping(db, now);
}
