// The link itself (docs/form-to-database-plan.md): which table a form's answers
// go into, which question fills which field, and when. The panel pushes it
// through the admin socket; the writers in saves/row.ts and saves/comment.ts
// read it back and check everything again.
//
// This module owns gate.form_links. What it decides is never the same as what
// gets written: the catalog and her database have the last word, every time.
import { all, one, run, type Db } from '@panel/core/pg';
import { checkLinkShape, type FormLink, type When } from '../../studio/form-links.ts';
import { formById } from '@panel/forms/gate/forms/store';
import { isAnswerType } from '@panel/forms/shared/form-types';
import { GateError } from '@panel/core/gate/ops';
import { counts } from './queue.ts';

type LinkRow = {
  form_id: number; database_id: number; engine: 'postgres' | 'mariadb'; name: string; table_name: string;
  write_when: When; pairs: string; fixed: string; enabled: boolean; updated_at: number; updated_by: string | null; mode?: string;
};

// mode 'comments': a comment area's copy (docs/comments-plan.md A1, A2)
export type StoredLink = FormLink & { formId: number; updatedAt: number; updatedBy: string | null; mode: 'row' | 'comments' };

const toLink = (r: LinkRow): StoredLink => {
  // what was stored was checked on the way in; read it the same way, and a
  // link that no longer reads is no link (it writes nothing)
  const shape = checkLinkShape({ table: r.table_name, when: r.write_when, pairs: JSON.parse(r.pairs), fixed: JSON.parse(r.fixed), enabled: r.enabled });
  return {
    ...shape, formId: r.form_id, databaseId: Number(r.database_id), engine: r.engine, name: r.name,
    updatedAt: Number(r.updated_at), updatedBy: r.updated_by, mode: r.mode === 'comments' ? 'comments' : 'row',
  };
};

export async function linkFor(db: Db, formId: number): Promise<StoredLink | null> {
  const r = await one<LinkRow>(db, 'SELECT * FROM form_links WHERE form_id = ?', formId);
  if (!r) return null;
  try { return toLink(r); } catch { return null; }
}

// ------------------------------------------------------------------ the panel pushes

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export async function saveLink(db: Db, now: number, input: Record<string, unknown>, by: unknown): Promise<StoredLink> {
  const form = await formById(db, input.formId);
  if (!form || form.trashedAt) throw new GateError('not-found', 'That form no longer exists.');
  // F14: anyone who finds an example's address can send to it -- except the
  // blog example's comment area, whose copy (approved comments only) is
  // part of what the example shows (docs/comments-plan.md)
  if (form.fixture && !(form.kind === 'comments' && input.mode === 'comments')) throw new GateError('invalid', "The examples' forms can't save into a database.");
  if (!Number.isSafeInteger(input.databaseId) || (input.engine !== 'postgres' && input.engine !== 'mariadb')
    || typeof input.name !== 'string' || !NAME_RE.test(input.name)) throw new GateError('invalid', 'Which database?');
  let shape;
  try { shape = checkLinkShape(input); } catch (e) { throw new GateError('invalid', (e as Error).message); }
  // every question paired is one this form really has
  const keys = new Set(form.items.filter((i) => isAnswerType(i.type) && i.key).map((i) => i.key!));
  const stray = shape.pairs.find((p) => !keys.has(p.key));
  if (stray) throw new GateError('invalid', `This form has no question called ${stray.key}.`);
  // F3: "when I approve" needs approvals. W7 is the same rule from the other
  // side: the switch can't be taken away while a link like this one stands.
  if (shape.when === 'approved' && !form.approvable) {
    throw new GateError('invalid', 'Switch on "Responses can be approved" first, or save answers as soon as they arrive.');
  }
  // A comment area's copy (docs/comments-plan.md A1, A2): into the comments
  // tables, following approval, with its author and its words -- nothing else
  const mode = input.mode === 'comments' ? 'comments' : 'row';
  if ((mode === 'comments') !== (form.kind === 'comments')) {
    throw new GateError('invalid', form.kind === 'comments' ? 'A comment area keeps its copy in the comments tables.' : 'Only a comment area keeps a copy of its comments.');
  }
  if (mode === 'comments' && (shape.table !== 'comments' || shape.when !== 'approved' || shape.fixed.length
    || shape.pairs.some((p) => p.field !== 'author' && p.field !== 'body'))) {
    throw new GateError('invalid', 'A comment area keeps its author and its words in the comments table, once approved.');
  }
  await run(db, `INSERT INTO form_links (form_id, database_id, engine, name, table_name, write_when, pairs, fixed, enabled, updated_at, updated_by, mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (form_id) DO UPDATE SET database_id = EXCLUDED.database_id, engine = EXCLUDED.engine, name = EXCLUDED.name,
                   table_name = EXCLUDED.table_name, write_when = EXCLUDED.write_when, pairs = EXCLUDED.pairs, fixed = EXCLUDED.fixed,
                   enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, mode = EXCLUDED.mode`,
    form.id, input.databaseId as number, input.engine, input.name, shape.table, shape.when,
    JSON.stringify(shape.pairs), JSON.stringify(shape.fixed), shape.enabled, now, typeof by === 'string' ? by.slice(0, 80) : null, mode);
  return (await linkFor(db, form.id))!;
}

export async function dropLink(db: Db, formId: unknown): Promise<{ ok: true }> {
  if (!Number.isSafeInteger(formId)) throw new GateError('invalid', 'Which form?');
  await run(db, 'DELETE FROM form_links WHERE form_id = ?', formId as number);
  return { ok: true };
}

// For the table's page: "Filled in by the form ..." (and the panel's checks).
export async function linksForDatabase(db: Db, databaseId: unknown) {
  if (!Number.isSafeInteger(databaseId)) throw new GateError('invalid', 'Which database?');
  const rows = await all<LinkRow & { form_name: string; title: string }>(db,
    `SELECT l.*, f.name AS form_name, f.title FROM form_links l JOIN forms f ON f.id = l.form_id
      WHERE l.database_id = ? AND f.trashed_at IS NULL ORDER BY f.title`, databaseId as number);
  return rows.map((r) => ({ formId: r.form_id, formName: r.form_name, title: r.title, table: r.table_name, enabled: r.enabled, when: r.write_when, mode: r.mode ?? 'row' }));
}

// How the link stands, for the builder: counts of what went where.
export async function linkState(db: Db, formId: unknown) {
  if (!Number.isSafeInteger(formId)) throw new GateError('invalid', 'Which form?');
  const link = await linkFor(db, formId as number);
  return { link, ...await counts(db, formId as number) };
}
