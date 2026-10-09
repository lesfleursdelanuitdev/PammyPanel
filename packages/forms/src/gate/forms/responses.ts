// What visitors send (docs/forms-plan.md): kept, counted, read, approved,
// moved to the trash, and read a page at a time through the API.
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { GateError } from '@panel/core/gate/ops';
import type { StoredAnswer } from '../../shared/form-types.ts';
import { cleanAnswers, normValue, valueRows } from './answers.ts';
import { cleanBy, int, MAX_EXAMPLE_RESPONSES, MAX_STORED, MAX_UNREAD, PAGE_SEEN_DAYS, TRASH_DAYS } from './items.ts';
import { formById, needForm, summary, toForm, type Form, type FormRow } from './store.ts';

export type Sender = { visitorId: number; username: string; name: string };
export type PageParams = Record<string, string>;
const LIST_PAGE = 100;

// ------------------------------------------------------------------ responses
// The examples' entries never count: a stranger who finds an example's address
// shouldn't put a red number on her Responses tab (D9).
// places: only responses to the forms that work in one of them (a person kept to
// places, D22, docs/permissions-plan.md R5); null: every form's.
export type Places = readonly string[] | null;
const inPlaces = (places: Places) =>
  (places ? { sql: ` AND form_id IN (SELECT id FROM forms WHERE scope IN (${places.map(() => '?').join(', ') || 'NULL'}))`, args: [...places] } : { sql: '', args: [] });
// The red number on Responses: comments have their own (C6), below.
export const unreadCount = async (db: Db, places: Places = null) => {
  const p = inPlaces(places);
  return (await one<{ n: number }>(db, `SELECT count(*) AS n FROM responses WHERE trashed_at IS NULL AND read_at IS NULL AND ${NOT_AN_EXAMPLE} AND ${NOT_COMMENTS}${p.sql}`, ...p.args))!.n;
};

// ...and on Comments: the ones waiting for her OK (docs/comments-plan.md C6, C15).
// Not the examples': anyone who finds the blog example can write in it, and
// that must never put a red number on her menu (as the form examples, D9).
export const commentsWaiting = async (db: Db, places: Places = null) => {
  const p = inPlaces(places);
  return Number((await one<{ n: number }>(db, `SELECT count(*) AS n FROM responses WHERE trashed_at IS NULL AND approved_at IS NULL AND ${COMMENTS_ONLY} AND ${NOT_AN_EXAMPLE}${p.sql}`, ...p.args))!.n);
};

// A comment's thread (docs/comments-plan.md): what it is about.
export type Thread = { type: string; id: string };

export async function addResponse(db: Db, now: number, form: Form, page: string, values: unknown, sender: Sender | null, host: string, ip: string | null, thread: Thread | null = null): Promise<number> {
  const answers = cleanAnswers(form, values, now);
  if (answers.length === 0) throw new GateError('closed', "This form has no questions yet, so there's nothing to send.");
  return tx(db, async (q) => {
    // Per form (docs/comments-plan.md, section 0): a busy comment area, or a
    // flood on one form, never stops her other forms taking answers.
    const counts = (await one<{ unread: number; stored: number }>(q,
      'SELECT count(*) FILTER (WHERE read_at IS NULL AND trashed_at IS NULL) AS unread, count(*) AS stored FROM responses WHERE form_id = ?', form.id))!;
    if (Number(counts.unread) >= MAX_UNREAD || Number(counts.stored) >= MAX_STORED) {
      throw new GateError('full', "Sorry, this form can't take answers at the moment. Please try again in a few days.");
    }
    // "Show right away": approved as it arrives, but still unread -- unread is how
    // she notices what went up, so it keeps its place in the red number.
    const auto = form.approvable && form.autoApprove && !form.fixture;
    const { id } = (await one<{ id: number }>(q, `INSERT INTO responses (form_id, form_name, page, answers, visitor_id, visitor_username, visitor_name, host, ip, created_at, approved_at, approved_auto, content_type, content_id)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      form.id, form.name, page, JSON.stringify(answers), sender?.visitorId ?? null, sender?.username ?? null, sender?.name ?? null, host, ip, now,
      auto ? now : null, auto ? 1 : 0, thread?.type ?? null, thread?.id ?? null))!;
    await insertValues(q, id, form.id, answers);
    // An example is open to anyone who finds its address, so it keeps only the
    // newest few entries and the older ones fall off (D10). Her own forms keep
    // everything until she moves it to the trash.
    if (form.fixture) {
      await run(q, `DELETE FROM responses WHERE form_id = ? AND id NOT IN
                  (SELECT id FROM responses WHERE form_id = ? ORDER BY id DESC LIMIT ?)`, form.id, form.id, MAX_EXAMPLE_RESPONSES);
    }
    return id;
  });
}

// A response's answers, one row per value, for the API's filterby (valueRows).
export async function insertValues(db: Db, responseId: number, formId: number, answers: StoredAnswer[]) {
  for (const v of valueRows(answers)) {
    await run(db, 'INSERT INTO response_values (response_id, form_id, key, value) VALUES (?, ?, ?, ?)', responseId, formId, v.key, v.value);
  }
}

export type ResponseRow = {
  id: number; form_id: number | null; form_name: string; page: string; answers: string; visitor_username: string | null; visitor_name: string | null;
  created_at: number; read_at: number | null; read_by: string | null; trashed_at: number | null; trashed_by: string | null;
  approved_at: number | null; approved_by: string | null; approved_auto: number;
  saved_to?: string | null; save_problem?: string | null; save_retry?: boolean; save_state?: string | null;
  content_type?: string | null; content_id?: string | null;
};
export type Response = {
  id: number; formId: number | null; formName: string; page: string; answers: StoredAnswer[];
  sender: { username: string; name: string } | null; createdAt: number;
  readAt: number | null; readBy: string | null; trashedAt: number | null; trashedBy: string | null;
  approvedAt: number | null; approvedBy: string | null;
  // approved because the form shows new responses right away, not by anyone
  approvedAuto: boolean;
  // docs/form-to-database-plan.md: the record it made, or why it has not yet
  savedTo: { engine: string; name: string; table: string; plural: string; key: Record<string, unknown>; label: string; at: number } | null;
  saveProblem: string | null;
  saveRetry: boolean;
  // how the last try ended (docs/refactor-plan.md phase 2, W2): waiting, saved,
  // problem, retrying, or unsure -- it may be in her table already (B3)
  saveState: 'waiting' | 'saved' | 'problem' | 'retrying' | 'unsure' | null;
  // docs/comments-plan.md: the thread a comment belongs to
  thread: Thread | null;
};
export const toResponse = (r: ResponseRow): Response => ({
  id: r.id, formId: r.form_id, formName: r.form_name, page: r.page, answers: JSON.parse(r.answers) as StoredAnswer[],
  sender: r.visitor_username ? { username: r.visitor_username, name: r.visitor_name ?? '' } : null,
  createdAt: r.created_at, readAt: r.read_at, readBy: r.read_by, trashedAt: r.trashed_at, trashedBy: r.trashed_by,
  approvedAt: r.approved_at, approvedBy: r.approved_by, approvedAuto: r.approved_auto === 1,
  savedTo: r.saved_to ? JSON.parse(r.saved_to) as Response['savedTo'] : null,
  saveProblem: r.save_problem ?? null, saveRetry: r.save_retry === true,
  saveState: (r.save_state as Response['saveState']) ?? null,
  thread: r.content_type && r.content_id ? { type: r.content_type, id: r.content_id } : null,
});

// The examples' entries are in the list like any other (the panel marks them),
// but they never count towards the red number: a passer-by who finds an example's
// address can't make her Responses tab look like it needs attention (D9).
const NOT_AN_EXAMPLE = '(form_id IS NULL OR form_id NOT IN (SELECT id FROM forms WHERE fixture IS NOT NULL))';
const COMMENTS_ONLY = "form_id IN (SELECT id FROM forms WHERE kind = 'comments')";
const NOT_COMMENTS = "(form_id IS NULL OR form_id NOT IN (SELECT id FROM forms WHERE kind = 'comments'))";

// Newest first, 100 at a time (before: the last id of the previous batch).
export async function listResponses(db: Db, q: { trash?: unknown; formId?: unknown; read?: unknown; approval?: unknown; before?: unknown; hideExamples?: unknown; places?: Places; kind?: unknown; contentType?: unknown; contentId?: unknown }) {
  const where = [q.trash === true ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL'];
  // Responses and Comments are two doors on the same rows (docs/comments-plan.md C6)
  where.push(q.kind === 'comments' ? COMMENTS_ONLY : NOT_COMMENTS);
  const args: (number | string)[] = [];
  if (q.places) { const p = inPlaces(q.places); where.push(p.sql.slice(' AND '.length)); args.push(...p.args); }
  if (int(q.formId) !== null) { where.push('form_id = ?'); args.push(q.formId as number); }
  // Home asks for this: what is waiting there must agree with the red number.
  else if (q.hideExamples === true) where.push(NOT_AN_EXAMPLE);
  if (q.read === 'unread') where.push('read_at IS NULL');
  if (q.read === 'read') where.push('read_at IS NOT NULL');
  if (q.approval === 'approved') where.push('approved_at IS NOT NULL');
  if (q.approval === 'waiting') where.push('approved_at IS NULL');
  if (int(q.before) !== null) { where.push('id < ?'); args.push(q.before as number); }
  // one conversation, for the Comments page (docs/comments-plan.md section 4)
  if (typeof q.contentType === 'string' && typeof q.contentId === 'string' && q.contentId.length <= 300) {
    where.push('content_type = ?', 'content_id = ?'); args.push(q.contentType, q.contentId);
  }
  // with where each one was saved, for a form that saves into a database (docs/form-to-database-plan.md)
  const rows = await all<ResponseRow>(db, `SELECT responses.*, s.saved_to, s.save_problem, s.save_retry, s.save_state
      FROM responses LEFT JOIN response_saves s ON s.response_id = responses.id
     WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${LIST_PAGE + 1}`, ...args);
  // whether each one's form can have approvals (the panel shows Approve only then)
  const approvable = new Set((await all<{ id: number }>(db, 'SELECT id FROM forms WHERE approvable = 1')).map((r) => r.id));
  return {
    responses: rows.slice(0, LIST_PAGE).map((r) => ({ ...toResponse(r), approvable: r.form_id !== null && approvable.has(r.form_id) })),
    more: rows.length > LIST_PAGE, unread: await unreadCount(db, q.places ?? null), trashDays: TRASH_DAYS,
  };
}

// The scope of the form a response came from (null: its form is gone).
export async function responseScope(db: Db, id: unknown): Promise<string | null | undefined> {
  const r = int(id) !== null ? await one<{ scope: string | null }>(db, 'SELECT f.scope FROM responses r LEFT JOIN forms f ON f.id = r.form_id WHERE r.id = ?', id as number) : undefined;
  return r === undefined ? undefined : r.scope;
}

async function needResponse(db: Db, id: unknown): Promise<ResponseRow> {
  const r = int(id) !== null ? await one<ResponseRow>(db, 'SELECT * FROM responses WHERE id = ?', id as number) : undefined;
  if (!r) throw new GateError('not-found', 'That response is no longer there.');
  return r;
}

export async function setResponseRead(db: Db, now: number, id: unknown, read: unknown, by: unknown): Promise<Response> {
  const m = await needResponse(db, id);
  if (typeof read !== 'boolean') throw new GateError('invalid', 'Expected read or unread.');
  const r = await one<ResponseRow>(db, 'UPDATE responses SET read_at = ?, read_by = ? WHERE id = ? RETURNING *', read ? now : null, read ? cleanBy(by) : null, m.id);
  if (!r) throw new GateError('not-found', 'That response is no longer there.');
  return toResponse(r);
}

export async function markAllRead(db: Db, now: number, formId: unknown, by: unknown, places: Places = null): Promise<number> {
  const byForm = int(formId) !== null;
  const p = inPlaces(places);
  return run(db, `UPDATE responses SET read_at = ?, read_by = ? WHERE read_at IS NULL AND trashed_at IS NULL${byForm ? ' AND form_id = ?' : ''}${p.sql}`,
    now, cleanBy(by), ...(byForm ? [formId as number] : []), ...p.args);
}

export async function trashResponse(db: Db, now: number, id: unknown, by: unknown): Promise<Response> {
  return tx(db, async (q) => {
    const m = await needResponse(q, id);
    if (m.trashed_at) throw new GateError('exists', 'That response is already in the trash.');
    return toResponse((await one<ResponseRow>(q, 'UPDATE responses SET trashed_at = ?, trashed_by = ? WHERE id = ? RETURNING *', now, cleanBy(by), m.id))!);
  });
}

export async function restoreResponse(db: Db, id: unknown): Promise<Response> {
  return tx(db, async (q) => {
    const m = await needResponse(q, id);
    if (!m.trashed_at) throw new GateError('exists', "That response isn't in the trash.");
    return toResponse((await one<ResponseRow>(q, 'UPDATE responses SET trashed_at = NULL, trashed_by = NULL WHERE id = ? RETURNING *', m.id))!);
  });
}

// Only on a form that is response-approvable (D12). Approving marks it read too.
// Either way it is by hand from now on, so it stops counting as approved automatically.
export async function setResponseApproved(db: Db, now: number, id: unknown, approved: unknown, by: unknown): Promise<Response> {
  return tx(db, async (q) => {
    const m = await needResponse(q, id);
    if (typeof approved !== 'boolean') throw new GateError('invalid', 'Expected approved or not.');
    const form = m.form_id === null ? undefined : await formById(q, m.form_id);
    if (!form?.approvable) throw new GateError('invalid', "This response's form doesn't have approvals switched on.");
    if (m.trashed_at) throw new GateError('invalid', 'Restore the response from the trash first.');
    const r = approved
      ? await one<ResponseRow>(q, 'UPDATE responses SET approved_at = ?, approved_by = ?, approved_auto = 0, read_at = coalesce(read_at, ?), read_by = coalesce(read_by, ?) WHERE id = ? RETURNING *',
        now, cleanBy(by), now, cleanBy(by), m.id)
      : await one<ResponseRow>(q, 'UPDATE responses SET approved_at = NULL, approved_by = NULL, approved_auto = 0 WHERE id = ? RETURNING *', m.id);
    return toResponse(r!);
  });
}

// Responses of a form that went up on their own and that nobody has opened yet:
// the ones a burst of junk would be. The panel offers to hide them when she
// switches the form back to waiting for her OK.
const UNREVIEWED_AUTO = 'form_id = ? AND approved_auto = 1 AND read_at IS NULL AND trashed_at IS NULL';
export const unreviewedAutoCount = async (db: Db, formId: number) =>
  (await one<{ n: number }>(db, `SELECT count(*) AS n FROM responses WHERE ${UNREVIEWED_AUTO}`, formId))!.n;

export async function hideUnreviewed(db: Db, id: unknown): Promise<{ form: Form; hidden: number }> {
  const form = await needForm(db, id);
  const hidden = await run(db, `UPDATE responses SET approved_at = NULL, approved_by = NULL, approved_auto = 0 WHERE ${UNREVIEWED_AUTO}`, form.id);
  return { form, hidden };
}

// ------------------------------------------------------------------ the Forms tab
export async function formsState(db: Db, places: Places = null) {
  const counts = new Map((await all<{ form_id: number | null; total: number; unread: number; approved: number; last: number | null }>(db, `
    SELECT form_id, count(*) AS total, count(*) FILTER (WHERE read_at IS NULL) AS unread, count(*) FILTER (WHERE approved_at IS NOT NULL) AS approved, max(created_at) AS last
      FROM responses WHERE trashed_at IS NULL GROUP BY form_id`)).map((r) => [r.form_id, r]));
  const pages = await all<{ form_id: number; page: string; last_seen: number }>(db, 'SELECT form_id, page, last_seen FROM form_pages ORDER BY page');
  const forms = (await all<FormRow>(db, 'SELECT * FROM forms ORDER BY name')).map(toForm).filter((f) => places === null || places.includes(f.scope));
  return {
    forms: forms.map((f) => ({
      ...summary(f),
      responses: counts.get(f.id)?.total ?? 0, unread: counts.get(f.id)?.unread ?? 0, approved: counts.get(f.id)?.approved ?? 0,
      lastResponseAt: counts.get(f.id)?.last ?? null,
      pages: pages.filter((p) => p.form_id === f.id).map((p) => ({ page: p.page, lastSeen: p.last_seen })),
    })),
    unread: await unreadCount(db, places),
    commentsWaiting: await commentsWaiting(db, places),
    trashDays: TRASH_DAYS,
  };
}

// ------------------------------------------------------------------ API queries
export type Cursor = { o: 'asc' | 'desc'; t: number; i: number };
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(s: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor;
    return (c.o === 'asc' || c.o === 'desc') && Number.isSafeInteger(c.t) && Number.isSafeInteger(c.i) ? c : null;
  } catch {
    return null;
  }
}

// Oldest first unless desc; ties by id, so the order never changes. The cursor
// carries where the last page ended, so new arrivals never make a page skip or repeat.
export async function queryResponses(db: Db, q: {
  formId: number; approvedOnly: boolean; filter: { key: string; value: string } | null;
  order: 'asc' | 'desc'; limit: number; after: Cursor | null;
}): Promise<{ rows: Response[]; total: number; next: string | null }> {
  const where = ['form_id = ?', 'trashed_at IS NULL'];
  const args: (number | string)[] = [q.formId];
  if (q.approvedOnly) where.push('approved_at IS NOT NULL');
  if (q.filter) {
    where.push('EXISTS (SELECT 1 FROM response_values v WHERE v.response_id = responses.id AND v.key = ? AND v.value = ?)');
    args.push(q.filter.key, normValue(q.filter.value));
  }
  const total = (await one<{ n: number }>(db, `SELECT count(*) AS n FROM responses WHERE ${where.join(' AND ')}`, ...args))!.n;
  const cmp = q.order === 'asc' ? '>' : '<';
  const page = [...where];
  const pageArgs = [...args];
  if (q.after) { page.push(`(created_at, id) ${cmp} (?, ?)`); pageArgs.push(q.after.t, q.after.i); }
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const rows = await all<ResponseRow>(db, `SELECT * FROM responses WHERE ${page.join(' AND ')} ORDER BY created_at ${dir}, id ${dir} LIMIT ?`, ...pageArgs, q.limit + 1);
  const shown = rows.slice(0, q.limit);
  const last = shown.at(-1);
  return { rows: shown.map(toResponse), total, next: rows.length > q.limit && last ? encodeCursor({ o: q.order, t: last.created_at, i: last.id }) : null };
}

// ------------------------------------------------------------------ housekeeping
export async function formsHousekeeping(db: Db, now: number) {
  await run(db, 'DELETE FROM responses WHERE trashed_at <= ?', now - TRASH_DAYS * 86400);
  await run(db, 'DELETE FROM forms WHERE trashed_at <= ?', now - TRASH_DAYS * 86400);
  await run(db, 'DELETE FROM form_pages WHERE last_seen <= ?', now - PAGE_SEEN_DAYS * 86400);
}
