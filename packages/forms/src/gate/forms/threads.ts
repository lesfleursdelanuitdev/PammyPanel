// Comments (docs/comments-plan.md): a thread's approved comments, how many
// each thread has, and the blog example's comment area.
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { GateError } from '@panel/core/gate/ops';
import { DEFAULT_SETTINGS, type StoredAnswer } from '../../shared/form-types.ts';
import { cleanItems, COMMENT_ITEMS, CONTENT_TYPE_RE, FORM_NAME_RE, MAX_EXAMPLE_RESPONSES } from './items.ts';
import { encodeCursor, insertValues, toResponse, type Cursor, type Response, type ResponseRow, type Thread } from './responses.ts';
import { toForm, type Form, type FormRow } from './store.ts';

// One thread's approved comments, a page at a time, like queryResponses.
export async function queryThread(db: Db, q: {
  formId: number; thread: Thread; order: 'asc' | 'desc'; limit: number; after: Cursor | null;
}): Promise<{ rows: Response[]; total: number; totals: { page: string; n: number }[]; next: string | null }> {
  const where = ['form_id = ?', 'content_type = ?', 'content_id = ?', 'trashed_at IS NULL', 'approved_at IS NOT NULL'];
  const args: (number | string)[] = [q.formId, q.thread.type, q.thread.id];
  const total = (await one<{ n: number }>(db, `SELECT count(*) AS n FROM responses WHERE ${where.join(' AND ')}`, ...args))!.n;
  // W8/B7: the whole thread counted by the page each comment was sent from, so
  // the gate can leave out what this visitor may not see -- the page they are
  // reading shows "3 comments" and three comments, not "5".
  const totals = (await all<{ page: string; n: number }>(db,
    `SELECT page, count(*) AS n FROM responses WHERE ${where.join(' AND ')} GROUP BY page`, ...args))
    .map((t) => ({ page: t.page, n: Number(t.n) }));
  const cmp = q.order === 'asc' ? '>' : '<';
  const page = [...where];
  const pageArgs = [...args];
  if (q.after) { page.push(`(created_at, id) ${cmp} (?, ?)`); pageArgs.push(q.after.t, q.after.i); }
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const rows = await all<ResponseRow>(db, `SELECT * FROM responses WHERE ${page.join(' AND ')} ORDER BY created_at ${dir}, id ${dir} LIMIT ?`, ...pageArgs, q.limit + 1);
  const shown = rows.slice(0, q.limit);
  const last = shown.at(-1);
  return { rows: shown.map(toResponse), total: Number(total), totals, next: rows.length > q.limit && last ? encodeCursor({ o: q.order, t: last.created_at, i: last.id }) : null };
}

// C14: how many approved comments each of several threads has, in one query --
// a blog index showing "3 comments" under twenty posts is one request. The
// pages they were sent from come too, so the gate can count only what this
// visitor may see (a comment sent from a protected page stays behind it).
export async function threadCounts(db: Db, formId: number, type: string, ids: string[]) {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(', ');
  return all<{ content_id: string; page: string; n: number }>(db,
    `SELECT content_id, page, count(*) AS n FROM responses
      WHERE form_id = ? AND content_type = ? AND content_id IN (${marks}) AND trashed_at IS NULL AND approved_at IS NOT NULL
      GROUP BY content_id, page`, formId, type, ...ids);
}

// The blog example's comment area (docs/comments-plan.md; docs/db-examples-plan.md):
// a fixture like the form examples -- anyone may write in it, it keeps only the
// newest few (MAX_EXAMPLE_RESPONSES, in addResponse), and it never counts
// towards her red numbers. Made the first time, and on every Reset its
// comments are put back to the samples, all approved.
export async function resetExampleComments(db: Db, now: number, raw: Record<string, unknown>): Promise<Form> {
  // only the panel can ask, but everything is checked here all the same
  const text = (v: unknown, re: RegExp) => { if (typeof v !== 'string' || !re.test(v)) throw new GateError('invalid', 'That example is not one the gate knows.'); return v; };
  const input = {
    name: text(raw.name, FORM_NAME_RE), fixture: text(raw.fixture, /^[a-z-]{1,40}$/), title: text(raw.title, /^.{1,120}$/),
    contentType: text(raw.contentType, CONTENT_TYPE_RE),
    // which example page they were written on: the blog example's, or the
    // tutorial example's (docs/tutorial-examples-plan.md)
    page: `_pammy/examples/${raw.page === undefined ? 'blog' : text(raw.page, /^[a-z-]{1,40}$/)}/index.html`,
    items: (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_EXAMPLE_RESPONSES).map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        contentId: text(String(o.contentId ?? ''), /^[A-Za-z0-9._-]{1,200}$/),
        author: text(o.author, /^.{1,80}$/), body: text(o.body, /^[\s\S]{1,3000}$/),
        at: Number.isSafeInteger(o.at) ? o.at as number : now,
      };
    }),
  };
  return tx(db, async (q) => {
    let form = (await one<FormRow>(q, 'SELECT * FROM forms WHERE fixture = ?', input.fixture));
    if (!form) {
      const { items, usedKeys } = cleanItems(COMMENT_ITEMS);
      form = (await one<FormRow>(q, `INSERT INTO forms (name, title, items, settings, used_keys, enabled, approvable, fixture, kind, content_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'comments', ?, ?, ?) RETURNING *`,
        input.name, input.title, JSON.stringify(items), JSON.stringify(DEFAULT_SETTINGS), JSON.stringify(usedKeys), input.fixture, input.contentType, now, now))!;
    }
    const f = toForm(form);
    await run(q, 'DELETE FROM responses WHERE form_id = ?', f.id);
    const nameKey = f.items.find((i) => i.type === 'short-text')?.key ?? 'your-name';
    const bodyKey = f.items.find((i) => i.type === 'long-text')?.key ?? 'your-comment';
    for (const c of input.items.slice(0, MAX_EXAMPLE_RESPONSES)) {
      const answers: StoredAnswer[] = [
        { key: nameKey, label: 'Your name', type: 'short-text', value: c.author.slice(0, 80) },
        { key: bodyKey, label: 'Your comment', type: 'long-text', value: c.body.slice(0, 3000) },
      ];
      const { id } = (await one<{ id: number }>(q, `INSERT INTO responses (form_id, form_name, page, answers, created_at, read_at, approved_at, content_type, content_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        f.id, f.name, input.page, JSON.stringify(answers), c.at, c.at, c.at, f.contentType, c.contentId))!;
      await insertValues(q, id, f.id, answers);
    }
    return f;
  });
}
