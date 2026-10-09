// One response, saved into her database: which writer it is for, one try at a
// time, and one outcome written down at the end (docs/refactor-plan.md phase 2).
//
// Everything that can be said about a save is said here or in the writers; the
// queue (saves/queue.ts) is the only thing that writes it down.
import { all, one, type Db } from '@panel/core/pg';
import { GateError } from '@panel/core/gate/ops';
import { linkFor } from './links.ts';
import { claim, retryDue, settle, type Outcome } from './queue.ts';
import { writeComment } from './comment.ts';
import { writeRow } from './row.ts';

// What a writer is given: the response as it stands, and where it went last time.
export type SaveRow = {
  id: number; form_id: number | null; form_name: string; page: string; answers: string;
  visitor_username: string | null; visitor_name: string | null;
  created_at: number; trashed_at: number | null; approved_at: number | null;
  saved_to: string | null; content_type: string | null; content_id: string | null;
};

export type SaveResult =
  | { saved: true; table: string; label: string }
  // unsure: it may be in her table already (B3) -- she decides, nothing is retried
  | { saved: false; problem: string; retry: boolean; unsure?: true }
  | { saved: null; why: string };          // nothing to do: not connected, not yet time, already saved

const resultOf = (o: Outcome): SaveResult => {
  if (o.kind === 'done') return { saved: true, table: o.table, label: o.label };
  if (o.kind === 'wait') return { saved: null, why: o.why };
  return { saved: false, problem: o.problem, retry: o.kind === 'retry', ...(o.kind === 'unsure' ? { unsure: true as const } : {}) };
};

export async function saveResponse(db: Db, now: number, socket: string, responseId: unknown, o: { force?: boolean } = {}): Promise<SaveResult> {
  if (!Number.isSafeInteger(responseId)) throw new GateError('invalid', 'Which response?');
  const r = await one<SaveRow & { save_state: string | null }>(db,
    `SELECT responses.*, s.saved_to, s.save_state FROM responses
       LEFT JOIN response_saves s ON s.response_id = responses.id WHERE responses.id = ?`, responseId as number);
  if (!r) throw new GateError('not-found', 'That response is no longer there.');
  const link = r.form_id === null ? null : await linkFor(db, r.form_id);

  // B2: a response with nothing left to do stops asking to be tried again --
  // it is only worth a claim when the queue is still holding something for it.
  const nothingToDo = async (why: string): Promise<SaveResult> => {
    if (r.save_state === 'retrying' || r.save_state === 'problem' || r.save_state === 'unsure') {
      const c = await claim(db, now, r.id);
      if (c) await settle(db, now, c, { kind: 'wait', why });
    }
    return { saved: null, why };
  };

  // a comment area's copy follows approval both ways (A1): its own writer, and
  // it is done again whenever the comment changes, saved before or not
  if (link?.mode === 'comments') {
    const c = await claim(db, now, r.id);
    if (!c) return { saved: null, why: 'It is being saved just now.' };
    const outcome = await writeComment(db, now, socket, r, link, c);
    await settle(db, now, c, outcome);
    return resultOf(outcome);
  }

  if (r.saved_to) return { saved: null, why: 'It is already saved.' };
  if (r.trashed_at) return nothingToDo('It is in the trash.');
  if (r.form_id === null) return nothingToDo('Its form is gone.');
  if (!link) return nothingToDo("Its form isn't connected to a database.");
  if (!link.enabled) return nothingToDo('Saving answers in the database is switched off for its form.');
  // F3: when she approves -- a response approved as it arrived ("Show right
  // away") counts, because it is approved
  if (link.when === 'approved' && r.approved_at === null && !o.force) return nothingToDo('It is waiting for your OK.');
  if (link.when === 'approved' && r.approved_at === null) return nothingToDo('Approve it first: this form saves answers when you approve them.');

  // F11: one write at a time for a response, and never two rows
  const c = await claim(db, now, r.id, { onlyUnsaved: true });
  if (!c) return { saved: null, why: 'It is being saved just now.' };
  const outcome = await writeRow(db, now, socket, r, link);
  await settle(db, now, c, outcome);
  return resultOf(outcome);
}

// F10: whatever still has something left to do, tried again on its own --
// oldest try first, and a comment that has to be taken down again counts
// as much as one that was never written (B1, W3).
export async function retrySaves(db: Db, now: number, socket: string): Promise<number> {
  let saved = 0;
  for (const id of await retryDue(db, 50)) {
    if ((await saveResponse(db, now, socket, id)).saved === true) saved++;
  }
  return saved;
}

// Q2: the responses already there when she connected the form, saved once on
// her word -- the approved ones for a form that saves on approval.
export async function saveEarlier(db: Db, now: number, socket: string, formId: unknown) {
  if (!Number.isSafeInteger(formId)) throw new GateError('invalid', 'Which form?');
  const link = await linkFor(db, formId as number);
  if (!link || !link.enabled) throw new GateError('invalid', "This form isn't saving answers in a database.");
  const rows = await all<{ id: number }>(db, `SELECT responses.id FROM responses LEFT JOIN response_saves s ON s.response_id = responses.id
     WHERE form_id = ? AND trashed_at IS NULL AND s.saved_to IS NULL
      ${link.when === 'approved' ? 'AND approved_at IS NOT NULL' : ''} ORDER BY responses.id LIMIT 500`, formId as number);
  let saved = 0; let problems = 0;
  for (const x of rows) {
    const res = await saveResponse(db, now, socket, x.id);
    if (res.saved === true) saved++;
    else if (res.saved === false) problems++;
  }
  return { saved, problems };
}
