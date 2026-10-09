// What arrived since the panel last looked, for its email notices
// (docs/apps-plan.md phase 3, M3): responses (a comment is a response to a
// comment area) and access requests, after the ids the panel says it has seen.
//
// Only what a notice needs: which form, which page, when, whether it waits for
// approval, which folder a request is for. Never the answers, a visitor's name
// or contact, or an IP -- the panel wouldn't put them in an email anyway.
import { all, one, type Db } from '@panel/core/pg';
import { int } from './forms/items.ts';

const MAX = 50;

export async function noticesSince(db: Db, after: { responses?: unknown; requests?: unknown }) {
  const r = int(after.responses);
  const q = int(after.requests);
  // the first time: where things stand, and nothing from before
  if (r === null || q === null) {
    const m = await one<{ r: number; q: number }>(db, 'SELECT (SELECT coalesce(max(id), 0) FROM responses) AS r, (SELECT coalesce(max(id), 0) FROM requests) AS q');
    return { responses: [], requests: [], last: { responses: m?.r ?? 0, requests: m?.q ?? 0 } };
  }
  const responses = await all<{ id: number; formId: number | null; formName: string; formTitle: string | null; kind: string | null; page: string; createdAt: number; waiting: boolean }>(db,
    `SELECT r.id, r.form_id AS "formId", r.form_name AS "formName", f.title AS "formTitle", f.kind, r.page, r.created_at AS "createdAt",
            (r.approved_at IS NULL AND f.approvable = 1) AS waiting
       FROM responses r LEFT JOIN forms f ON f.id = r.form_id
      WHERE r.id > ? AND r.trashed_at IS NULL ORDER BY r.id LIMIT ${MAX}`, r);
  const requests = await all<{ id: number; kind: string; area: string | null; createdAt: number }>(db,
    `SELECT q.id, q.kind, a.path AS area, q.created_at AS "createdAt"
       FROM requests q LEFT JOIN areas a ON a.id = q.area_id
      WHERE q.id > ? AND q.status = 'open' ORDER BY q.id LIMIT ${MAX}`, q);
  return {
    responses, requests,
    // as far as these go (the next look carries on from there), or where it was
    last: { responses: responses.at(-1)?.id ?? r, requests: requests.at(-1)?.id ?? q },
  };
}
