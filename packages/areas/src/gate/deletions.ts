// Deleted accounts, for the panel to pass on to the apps (docs/accounts-plan.md Q1, step 4b).
// The trigger in areas/0006 notes each one; the panel lists them, tells each service, and
// says which answered. A row goes once every service has, or after 30 days (housekeeping).
import { all, one, run, type Db } from '@panel/core/pg';
import { GateError } from '@panel/core/gate/ops';

export type DeletedAccount = { visitor_id: number; username: string; deleted_at: number; told: string[]; tries: number; next_at: number; last_error: string | null };

// seconds until the next try, by tries so far: a minute, five, half an hour, then every six hours
const BACKOFF = [60, 300, 1800, 6 * 3600];
export const backoff = (tries: number) => BACKOFF[Math.min(tries, BACKOFF.length - 1)]!;
export const DELETIONS_KEPT = 30 * 86400;

export const listDeletions = (db: Db) =>
  all<DeletedAccount>(db, 'SELECT visitor_id, username, deleted_at, told, tries, next_at, last_error FROM deleted_accounts ORDER BY deleted_at, visitor_id');

// told: every service that has answered so far; done: that's all of them (the row goes)
export async function deletionTold(db: Db, now: number, id: unknown, told: unknown, done: unknown, error: unknown): Promise<{ done: boolean }> {
  if (!Number.isSafeInteger(id)) throw new GateError('invalid', 'Which deleted account?');
  if (!Array.isArray(told) || told.some((s) => typeof s !== 'string' || !/^[a-z0-9-]{1,32}$/.test(s)) || told.length > 50) throw new GateError('invalid', 'Told: a list of services.');
  if (typeof done !== 'boolean') throw new GateError('invalid', 'Done: true or false.');
  if (done) {
    await run(db, 'DELETE FROM deleted_accounts WHERE visitor_id = ?', id as number);
    return { done: true };
  }
  const row = await one<{ tries: number }>(db, 'SELECT tries FROM deleted_accounts WHERE visitor_id = ?', id as number);
  if (!row) return { done: true };
  const why = typeof error === 'string' ? error.slice(0, 300) : null;
  await run(db, 'UPDATE deleted_accounts SET told = ARRAY(SELECT jsonb_array_elements_text(?::text::jsonb)), tries = tries + 1, next_at = ?, last_error = ? WHERE visitor_id = ?',
    JSON.stringify([...new Set(told as string[])]), now + backoff(row.tries), why, id as number);
  return { done: false };
}

export const deletionsHousekeeping = (db: Db, now: number) => run(db, 'DELETE FROM deleted_accounts WHERE deleted_at <= ?', now - DELETIONS_KEPT);
