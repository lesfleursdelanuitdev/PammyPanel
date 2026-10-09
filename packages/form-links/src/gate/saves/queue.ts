// The queue of copies into her tables (docs/refactor-plan.md phase 2, W1-W3,
// W5): the one place that reads or writes gate.response_saves.
//
// A writer (saves/row.ts, saves/comment.ts) is handed a claim, works out what to
// write, writes it into her database, and hands back an outcome. It never
// touches this table itself, and every try ends in settle() -- so a try that
// stops half way cannot leave the row saying what was true before it started
// (B2), and "is there something left to do?" is one column, not three.
import { all, one, run, type Db } from '@panel/core/pg';

// How long a claim holds before another try may take it over. Renewed after
// every call to the database helper (W5), so a comment's save -- up to seven
// calls of up to 30 s each -- is never taken from under itself half way (B5).
export const CLAIM_SECONDS = 120;
// F10: a sleeping database is tried again on its own, for about a day.
export const MAX_TRIES = 96;

export type SavedTo = {
  engine: string; name: string; table: string; plural: string;
  key: Record<string, unknown>; label: string; at: number;
};

// What a try ended as (W2). Exactly one of these is written, by settle().
export type Outcome =
  // it is in her table now
  | { kind: 'done'; savedTo: SavedTo; table: string; label: string }
  // nothing to do yet or ever: not connected, switched off, waiting for her OK,
  // in the trash. No problem to show her, and nothing to try again.
  | { kind: 'wait'; why: string }
  // in her words, and not tried again by itself
  | { kind: 'problem'; problem: string }
  // in her words, and tried again by itself until MAX_TRIES
  | { kind: 'retry'; problem: string }
  // B3: the write was sent and the answer never came, so it may be there
  // already. Nothing is retried by itself; she decides, from Responses.
  | { kind: 'unsure'; problem: string };

export type Claim = {
  responseId: number;
  tries: number;                 // tries before this one
  renew: () => Promise<void>;    // W5: push the claim forward, between helper calls
};

// One try at a time for a response (F11). onlyUnsaved: row mode, where a second
// row must never be written; comments are brought in line again and again.
export async function claim(db: Db, now: number, responseId: number, o: { onlyUnsaved?: boolean } = {}): Promise<Claim | null> {
  const got = await one<{ save_tries: number }>(db,
    `INSERT INTO response_saves (response_id, save_claimed_at) VALUES (?, ?)
     ON CONFLICT (response_id) DO UPDATE SET save_claimed_at = EXCLUDED.save_claimed_at
      WHERE (response_saves.save_claimed_at IS NULL OR response_saves.save_claimed_at < ?)
        ${o.onlyUnsaved ? 'AND response_saves.saved_to IS NULL' : ''}
     RETURNING save_tries`,
    responseId, now, now - CLAIM_SECONDS);
  if (!got) return null;
  // The clock is handed in as a number (the gate's, which tests move by hand),
  // but a claim has to age in real seconds while the helper is being waited on.
  const started = Date.now();
  return {
    responseId,
    tries: Number(got.save_tries),
    renew: async () => {
      await run(db, 'UPDATE response_saves SET save_claimed_at = ? WHERE response_id = ?',
        now + Math.floor((Date.now() - started) / 1000), responseId);
    },
  };
}

// The end of a try, whatever happened. The claim is always let go.
export async function settle(db: Db, now: number, c: Claim, o: Outcome): Promise<void> {
  switch (o.kind) {
    case 'done':
      await run(db, `UPDATE response_saves SET saved_to = ?, save_problem = NULL, save_retry = false,
                       save_state = 'saved', save_claimed_at = NULL, save_tried_at = ? WHERE response_id = ?`,
        JSON.stringify(o.savedTo), now, c.responseId);
      return;
    case 'wait':
      // B2: a "nothing to do" answer clears the retry, so 50 of them cannot sit
      // at the head of the queue and block everything newer.
      await run(db, `UPDATE response_saves SET save_problem = NULL, save_retry = false,
                       save_state = 'waiting', save_claimed_at = NULL WHERE response_id = ?`, c.responseId);
      return;
    case 'retry': {
      const again = c.tries + 1 < MAX_TRIES;
      await run(db, `UPDATE response_saves SET save_problem = ?, save_retry = ?, save_state = ?,
                       save_tries = save_tries + 1, save_tried_at = ?, save_claimed_at = NULL WHERE response_id = ?`,
        o.problem.slice(0, 500), again, again ? 'retrying' : 'problem', now, c.responseId);
      return;
    }
    default:
      await run(db, `UPDATE response_saves SET save_problem = ?, save_retry = false, save_state = ?,
                       save_tries = save_tries + 1, save_tried_at = ?, save_claimed_at = NULL WHERE response_id = ?`,
        o.problem.slice(0, 500), o.kind, now, c.responseId);
  }
}

// W3: what still has something left to do, oldest try first -- with or without
// a row in her table (a comment already copied may still have to be taken down
// again, B1), in the trash or not (the writers work that out).
export async function retryDue(db: Db, limit = 50): Promise<number[]> {
  const rows = await all<{ response_id: number }>(db,
    `SELECT response_id FROM response_saves WHERE save_retry
      ORDER BY save_tried_at NULLS FIRST, response_id LIMIT ?`, limit);
  return rows.map((r) => Number(r.response_id));
}

// For the form's database page: how its responses stand.
export async function counts(db: Db, formId: number) {
  const c = (await one<{ saved: number; problems: number; waiting: number; unsure: number }>(db, `
    SELECT count(*) FILTER (WHERE s.save_state = 'saved')                        AS saved,
           count(*) FILTER (WHERE s.save_state IN ('problem', 'unsure'))         AS problems,
           count(*) FILTER (WHERE s.save_state = 'unsure')                       AS unsure,
           count(*) FILTER (WHERE s.save_state IS NULL
                              OR s.save_state IN ('waiting', 'retrying'))        AS waiting
      FROM responses LEFT JOIN response_saves s ON s.response_id = responses.id
     WHERE form_id = ? AND trashed_at IS NULL`, formId))!;
  return { saved: Number(c.saved), problems: Number(c.problems), unsure: Number(c.unsure), notSaved: Number(c.waiting) };
}
