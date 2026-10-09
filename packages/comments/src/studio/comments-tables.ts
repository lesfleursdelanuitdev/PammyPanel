// The tables a comment area keeps its copy in (docs/comments-plan.md C8-C11,
// section 5, amendments A1-A3), drawn into her draft -- never run: the studio
// never touches her database without Review then Apply.
//
//   comment_threads   one row per conversation: which area, what it is about
//                     (a page's file, or a record's id), open, how many, last
//   comments          one row per comment she approved; `approved` follows
//                     her Approve both ways (A1), `response_id` all different
//                     so a comment is only ever one row
//   <post>_comment_threads   for a table whose records can be commented on
//                     (C10): which thread is a post's, one per post
//
// Pure: a snapshot in, a snapshot out, like addRelationship.
import { starterTable, type Column, type Snapshot, type Table } from '@panel/studio/pammydb/ir';
import { singularName, type FieldPatch, type ResourcePatch } from '@panel/studio/studio/resources';
import { singular } from '@panel/studio/studio/relationships';

export const THREADS = 'comment_threads';
export const COMMENTS = 'comments';
export const linkTableFor = (table: string) => `${singular(table)}_comment_threads`;
export const linkColumnFor = (table: string) => `${singular(table)}_id`;

const col = (name: string, type: Column['type'], over: Partial<Column> = {}): Column =>
  ({ name, type, required: false, default: null, sqlType: null, ...over });

// id first, then these, then the two dates every new table gets
const table = (name: string, columns: Column[], over: Partial<Table> = {}): Table => {
  const start = starterTable(name);
  const [id, ...dates] = start.columns;
  return { ...start, columns: [id!, ...columns, ...dates], ...over };
};

export function threadsTable(): Table {
  return table(THREADS, [
    col('area', 'short_text', { length: 64, required: true }),
    col('content_type', 'short_text', { length: 64, required: true }),
    col('content_id', 'short_text', { length: 300, required: true }),
    col('open', 'boolean', { required: true, default: { kind: 'boolean', value: true } }),
    col('comments', 'integer', { required: true, default: { kind: 'number', value: 0 } }),
    col('last_at', 'timestamptz'),
  ], {
    // A3: one conversation per thing, however many comments arrive at once
    uniques: [{ name: 'comment_threads_thing_key', columns: ['area', 'content_type', 'content_id'] }],
  });
}

export function commentsTable(): Table {
  return table(COMMENTS, [
    col('thread_id', 'integer', { required: true }),
    col('author', 'short_text', { length: 120 }),
    col('body', 'text'),
    col('approved', 'boolean', { required: true, default: { kind: 'boolean', value: false } }),
    col('sent_at', 'timestamptz'),
    col('response_id', 'integer', { required: true }),
  ], {
    uniques: [{ name: 'comments_response_id_key', columns: ['response_id'] }],
    // a thread that goes takes its comments with it
    foreignKeys: [{ name: 'comments_thread_id_fkey', columns: ['thread_id'], references: { table: THREADS, columns: ['id'] }, onDelete: 'cascade' }],
  });
}

// C8: the two shared tables, if the draft has not got them yet.
export function withCommentTables(s: Snapshot): Snapshot {
  const has = (n: string) => s.tables.some((t) => t.name === n);
  return {
    ...s,
    tables: [...s.tables, ...(has(THREADS) ? [] : [threadsTable()]), ...(has(COMMENTS) ? [] : [commentsTable()])],
  };
}

// C10, C11: a table whose records can be commented on gets a link table --
// one thread per record. Its reference has the record's own key type.
export function withCommentLink(s: Snapshot, target: string): Snapshot {
  const t = s.tables.find((x) => x.name === target);
  if (!t) throw new Error(`there is no table called ${target}`);
  if (t.primaryKey.length !== 1) throw new Error(`${target} is told apart by more than one field, so its records can't be commented on`);
  const key = t.columns.find((c) => c.name === t.primaryKey[0])!;
  const name = linkTableFor(target);
  if (s.tables.some((x) => x.name === name)) return s;
  const refCol = linkColumnFor(target);
  const link = table(name, [
    col(refCol, key.type, { required: true, ...(key.length ? { length: key.length } : {}) }),
    col('thread_id', 'integer', { required: true }),
  ], {
    uniques: [{ name: `${name}_${refCol}_key`, columns: [refCol] }],
    foreignKeys: [
      // delete the record, and the link to its thread goes with it
      { name: `${name}_${refCol}_fkey`, columns: [refCol], references: { table: target, columns: [key.name] }, onDelete: 'cascade' },
      { name: `${name}_thread_id_fkey`, columns: ['thread_id'], references: { table: THREADS, columns: ['id'] }, onDelete: 'cascade' },
    ],
  });
  const base = withCommentTables(s);
  return { ...base, tables: [...base.tables, link] };
}

// What the app says about them, set when she switches comments on: in the app
// (the gate may only write what the catalog shows -- docs/form-to-database-plan
// F2), able to take new rows and changes, and named in her words.
export const COMMENT_RESOURCES: Record<string, { patch: ResourcePatch; fields?: Record<string, FieldPatch> }> = {
  [COMMENTS]: {
    patch: {
      enabled: true, singular: 'Comment', plural: 'Comments', titleField: 'author', sortField: 'sent_at', sortDir: 'desc',
      can: { create: true, view: true, edit: true, delete: true, search: true, sort: true, filter: true },
    },
    fields: {
      body: { label: 'Comment', searchable: true }, approved: { label: 'Shown on the page', filterable: true },
      thread_id: { label: 'Conversation', filterable: true }, response_id: { exposed: true, showInList: false, label: 'Response number' },
      sent_at: { label: 'Sent' }, created_at: { showInList: false }, updated_at: { showInList: false },
    },
  },
  [THREADS]: {
    patch: {
      enabled: true, singular: 'Conversation', plural: 'Conversations', titleField: 'content_id', sortField: 'last_at', sortDir: 'desc',
      can: { create: true, view: true, edit: true, delete: true, search: true, sort: true, filter: true },
    },
    fields: {
      content_id: { label: 'About' }, content_type: { label: 'Which table' }, open: { label: 'Open for comments' },
      comments: { label: 'Comments shown' }, last_at: { label: 'Last comment' }, created_at: { showInList: false }, updated_at: { showInList: false },
    },
  },
};

export const linkResource = (target: string): { patch: ResourcePatch } => ({
  patch: {
    enabled: true, singular: `${singularName(target)} conversation`, plural: `${singularName(target)} conversations`,
    can: { create: true, view: true, edit: true, delete: true, search: false, sort: true, filter: false },
    description: `Which conversation is each ${singular(target)}'s. Made by the comments; there is nothing here to fill in by hand.`,
  },
});
