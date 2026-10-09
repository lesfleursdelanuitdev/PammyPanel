// People's part of the gate's hourly clean-up (docs/k-a-plan.md K-a4; split from core's
// store.ts housekeeping): sessions and links long over, and accounts nobody confirmed.
// The gate host calls it with the kernel's (events) and requests' parts.
import { run, type Db } from '@panel/core/pg';
import { UNCONFIRMED_KEPT } from './self-service.ts';

export async function peopleHousekeeping(db: Db, now: number) {
  await run(db, 'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at <= ?', now - 7 * 86400, now - 7 * 86400);
  await run(db, 'DELETE FROM links WHERE expires_at <= ?', now - 30 * 86400);
  // Q2: an account nobody confirmed, 48 hours on
  await run(db, 'DELETE FROM visitors WHERE registered AND email_confirmed_at IS NULL AND created_at <= ?', now - UNCONFIRMED_KEPT);
}
