// Comments (docs/comments-plan.md A1, A2): a comment's copy in her app, brought
// in line with the comment as it is now -- approved -> a row with approved yes
// (made, or changed back); not approved or in the trash -> approved no on the
// row it wrote before. Then the thread's count and last time are worked out
// again from its approved rows.
//
// Unlike row mode this can be done again and again, and must be: her database
// may be asleep when she un-approves something (B1). One row per response
// (comments.response_id is unique), so a try that never heard the answer can
// simply be tried again (W4) -- there is nothing to double up.
import { run, tx, type Db } from '@panel/core/pg';
import { callPammyDb, PammyDbCallError } from '@panel/studio/pammydb/client';
import type { RowPage, Scalar } from '@panel/studio/pammydb/rows';
import { readCatalog } from '@panel/studio/studio/catalog';
import { momentFor } from '../../studio/form-links.ts';
import { singular as singularOf } from '@panel/studio/studio/relationships';
import type { StoredAnswer } from '@panel/forms/shared/form-types';
import { one } from '@panel/core/pg';
import type { StoredLink } from './links.ts';
import type { Claim, Outcome } from './queue.ts';
import type { SaveRow } from './save.ts';

export async function writeComment(db: Db, now: number, socket: string, r: SaveRow, link: StoredLink, c: Claim): Promise<Outcome> {
  if (!link.enabled) return { kind: 'wait', why: 'Keeping a copy of the comments is switched off for its area.' };
  const type = r.content_type;
  const about = r.content_id;
  if (!type || !about) return { kind: 'wait', why: 'It is not about anything.' };
  const shown = r.approved_at !== null && r.trashed_at === null;
  const before = r.saved_to ? JSON.parse(r.saved_to) as { key?: { id?: Scalar } } : null;
  if (!shown && (before?.key?.id === undefined || before.key.id === null)) return { kind: 'wait', why: 'It has never been in the table.' };

  const cat = await one<{ catalog_json: string }>(db, 'SELECT catalog_json FROM studio_catalog WHERE database_id = ?', link.databaseId);
  if (!cat) return { kind: 'problem', problem: `The app for ${link.name} is switched off, so the comments can't be kept in it.` };
  const served = readCatalog(cat.catalog_json).resources;
  const threads = served.find((x) => x.table === 'comment_threads');
  const comments = served.find((x) => x.table === 'comments');
  if (!threads || !comments) return { kind: 'problem', problem: `The ${link.name} app has no comments tables in it: switch "This app takes comments" on again.` };
  if (!threads.can.create || !threads.can.edit || !comments.can.create || !comments.can.edit) {
    return { kind: 'problem', problem: "The comments tables are set up so that they can't be added to or changed." };
  }
  const needs = (res: typeof threads, cols: string[]) => cols.every((col) => res.columns.includes(col));
  if (!needs(threads, ['area', 'content_type', 'content_id', 'comments', 'last_at']) || !needs(comments, ['thread_id', 'author', 'body', 'approved', 'sent_at', 'response_id'])) {
    return { kind: 'problem', problem: 'A field the comments need is hidden or renamed in the comments tables.' };
  }

  // W5: every call to the helper pushes the claim forward, so a save that makes
  // seven of them is never taken over half way through.
  const ask = async <T>(req: Record<string, unknown>): Promise<T> => {
    try {
      return await callPammyDb<T>(socket, { engine: link.engine, name: link.name, actor: 'comments', ...req }, 30_000);
    } finally {
      await c.renew();
    }
  };
  const eq = (column: string, value: Scalar) => ({ kind: 'equals', column, value });
  const threadWhere = [eq('area', r.form_name), eq('content_type', type), eq('content_id', about)];
  const findThread = async () => (await ask<RowPage>({ op: 'list-rows', query: { table: 'comment_threads', columns: ['id'], limit: 1, offset: 0, order: { column: 'id', dir: 'asc' }, filters: threadWhere } })).items[0]?.id as Scalar | undefined;
  try {
    // the thread: found, or made (A3: two at once cannot make two -- the second finds the first)
    let thread = await findThread();
    if (thread === undefined) {
      try {
        thread = (await ask<{ row: Record<string, unknown> }>({ op: 'insert-row', table: 'comment_threads', back: ['id'],
          values: { area: r.form_name, content_type: type, content_id: about } })).row.id as Scalar;
      } catch (e) {
        if (!(e instanceof PammyDbCallError && e.code === 'conflict')) throw e;
        thread = await findThread();
      }
    }
    const tid = thread ?? null;
    // C10: a record that can be commented on is linked to its thread (the
    // record must be there: the link's reference refuses one that is not)
    const linkTable = served.find((x) => x.table === `${singularOf(type)}_comment_threads`);
    if (type !== 'page' && linkTable) {
      const refCol = `${singularOf(type)}_id`;
      const linked = await ask<RowPage>({ op: 'list-rows', query: { table: linkTable.table, columns: ['id'], limit: 1, offset: 0, order: { column: 'id', dir: 'asc' }, filters: [eq('thread_id', tid)] } });
      if (!linked.items.length) {
        try {
          await ask({ op: 'insert-row', table: linkTable.table, back: ['id'], values: { [refCol]: about, thread_id: tid } });
        } catch (e) {
          if (!(e instanceof PammyDbCallError && e.code === 'conflict')) throw e;
        }
      }
    }
    // the comment itself
    const answers = JSON.parse(r.answers) as StoredAnswer[];
    const answerOf = (field: string) => {
      const key = link.pairs.find((p) => p.field === field)?.key;
      const v = answers.find((a) => a.key === key)?.value;
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v).filter(Boolean).join(' ') : v === null || v === undefined ? null : String(v);
    };
    let id = before?.key?.id;
    if (id !== undefined && id !== null) {
      await ask({ op: 'update-row', table: 'comments', values: { approved: shown }, where: { id }, back: ['id'] });
    } else {
      try {
        id = (await ask<{ row: Record<string, unknown> }>({ op: 'insert-row', table: 'comments', back: ['id'], values: {
          thread_id: tid, author: (r.visitor_name || r.visitor_username || answerOf('author') || '').slice(0, 120) || null,
          body: answerOf('body'), approved: shown, sent_at: momentFor(link.engine, Number(r.created_at)), response_id: r.id,
        } })).row.id as Scalar;
      } catch (e) {
        if (!(e instanceof PammyDbCallError && e.code === 'conflict')) throw e;
        // it was written before (a try that died before noting it, or one that
        // never heard the answer): find it, bring it in line
        id = (await ask<RowPage>({ op: 'list-rows', query: { table: 'comments', columns: ['id'], limit: 1, offset: 0, order: { column: 'id', dir: 'asc' }, filters: [eq('response_id', r.id)] } })).items[0]?.id as Scalar;
        await ask({ op: 'update-row', table: 'comments', values: { approved: shown }, where: { id }, back: ['id'] });
      }
    }
    // W6/B6: the thread's count and last time, from its approved comments, with
    // one hand on the thread at a time -- two approvals at once used to be able
    // to read the same count and both write it back.
    await tx(db, async (q) => {
      await run(q, 'SELECT pg_advisory_xact_lock(hashtext(?))', `comments:${link.formId}:${type}:${about}`);
      const approved = await ask<RowPage>({ op: 'list-rows', query: {
        table: 'comments', columns: ['sent_at'], limit: 1, offset: 0, order: { column: 'sent_at', dir: 'desc' },
        filters: [eq('thread_id', tid), eq('approved', true)],
      } });
      await ask({ op: 'update-row', table: 'comment_threads', where: { id: tid }, back: ['id'],
        values: { comments: approved.total, last_at: (approved.items[0]?.sent_at as Scalar | undefined) ?? null } });
    });
    return {
      kind: 'done', table: comments.plural, label: shown ? 'shown' : 'not shown',
      savedTo: { engine: link.engine, name: link.name, table: 'comments', plural: comments.plural, key: { id }, label: shown ? 'shown' : 'not shown', at: now },
    };
  } catch (e) {
    if (e instanceof PammyDbCallError) {
      // W4: a comment may be tried again after a timeout -- one row per
      // response, so nothing can double up.
      return e.code === 'unavailable' || e.code === 'busy' || e.code === 'timeout'
        ? { kind: 'retry', problem: e.message }
        : { kind: 'problem', problem: e.message };
    }
    return { kind: 'retry', problem: 'The database helper could not be reached. It will be tried again.' };
  }
}
