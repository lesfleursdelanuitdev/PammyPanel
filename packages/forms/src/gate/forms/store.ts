// The forms themselves (docs/forms-plan.md): made, saved, copied, switched,
// moved to the trash and back. Their responses are responses.ts's.
import { one, run, tx, type Db } from '@panel/core/pg';
import { cleanLine, GateError } from '@panel/core/gate/ops';
import { DEFAULT_SETTINGS, type Item, type Settings } from '../../shared/form-types.ts';
import {
  checkPictures, cleanBy, cleanItems, cleanScope, cleanSettings, COMMENT_ITEMS, CONTENT_TYPE_RE, FORM_NAME_RE, int, MAX_FORMS,
} from './items.ts';

export type Form = {
  id: number; name: string; title: string; items: Item[]; settings: Settings; usedKeys: string[];
  enabled: boolean; approvable: boolean; publicApproved: boolean; version: number;
  // "Show right away": new responses arrive approved (only matters while approvable).
  autoApprove: boolean;
  // One of the worked examples (examples.ts): hers to play with, never to delete.
  fixture: string | null;
  // Where it works (docs/media-plan.md D22): '/' everywhere, '/olivia' only in olivia/.
  scope: string;
  // docs/comments-plan.md C1, C4: an ordinary form, or a comment area -- and
  // what an area's comments are about ('page', or a table of one of her apps)
  kind: 'form' | 'comments';
  contentType: string;
  createdAt: number; createdBy: string | null; updatedAt: number; updatedBy: string | null;
  trashedAt: number | null; trashedBy: string | null;
};

// ------------------------------------------------------------------ forms
export type FormRow = {
  id: number; name: string; title: string; items: string; settings: string; used_keys: string;
  enabled: number; approvable: number; public_approved: number; auto_approve: number; version: number; fixture: string | null; scope: string;
  kind?: string; content_type?: string;
  created_at: number; created_by: string | null; updated_at: number; updated_by: string | null;
  trashed_at: number | null; trashed_by: string | null;
};
export const toForm = (r: FormRow): Form => ({
  id: r.id, name: r.name, title: r.title, items: JSON.parse(r.items) as Item[],
  settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings) as Partial<Settings> }, usedKeys: JSON.parse(r.used_keys) as string[],
  enabled: r.enabled === 1, approvable: r.approvable === 1, publicApproved: r.public_approved === 1, autoApprove: r.auto_approve === 1, version: r.version, fixture: r.fixture ?? null, scope: r.scope ?? '/',
  kind: r.kind === 'comments' ? 'comments' : 'form', contentType: r.content_type ?? 'page',
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by, trashedAt: r.trashed_at, trashedBy: r.trashed_by,
});

export const formById = async (db: Db, id: unknown): Promise<Form | undefined> => {
  const r = int(id) !== null ? await one<FormRow>(db, 'SELECT * FROM forms WHERE id = ?', id as number) : undefined;
  return r && toForm(r);
};
export const formByName = async (db: Db, name: unknown): Promise<Form | undefined> => {
  const r = typeof name === 'string' && FORM_NAME_RE.test(name) ? await one<FormRow>(db, 'SELECT * FROM forms WHERE name = ?', name) : undefined;
  return r && toForm(r);
};

export async function needForm(db: Db, id: unknown, opts: { trashed?: boolean } = {}): Promise<Form> {
  const f = await formById(db, id);
  if (!f) throw new GateError('not-found', 'That form no longer exists.');
  if (opts.trashed === false && f.trashedAt) throw new GateError('not-found', 'That form is in the trash. Restore it first.');
  if (opts.trashed === true && !f.trashedAt) throw new GateError('exists', "That form isn't in the trash.");
  return f;
}

async function checkNewName(db: Db, name: unknown): Promise<string> {
  if (typeof name !== 'string' || name.trim() === '') throw new GateError('invalid', 'Please give the form a name, like olivias-form.');
  const n = name.trim();
  if (!FORM_NAME_RE.test(n)) {
    throw new GateError('invalid', 'Form names are 2-64 lowercase letters, digits and single hyphens, starting and ending with a letter or digit, like olivias-form.');
  }
  const other = await one<{ trashed_at: number | null }>(db, 'SELECT trashed_at FROM forms WHERE name = ?', n);
  if (other) {
    throw new GateError('exists', other.trashed_at
      ? `There's a form called ${n} in the trash. Its name stays taken until it's deleted for good (30 days after it was moved there).`
      : `There's already a form called ${n}.`);
  }
  return n;
}

const formCount = async (db: Db) => (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM forms'))!.n;

export async function createForm(db: Db, now: number, input: { name: unknown; title?: unknown; items?: unknown; settings?: unknown; scope?: unknown; kind?: unknown; contentType?: unknown }, by: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const name = await checkNewName(q, input.name);
    const scope = cleanScope(input.scope);
    if (await formCount(q) >= MAX_FORMS) {
      throw new GateError('full', `You can have at most ${MAX_FORMS} forms (the trash counts too). Delete one you don't use first.`);
    }
    const comments = input.kind === 'comments';
    const contentType = input.contentType === undefined ? 'page' : input.contentType;
    if (typeof contentType !== 'string' || !CONTENT_TYPE_RE.test(contentType)) throw new GateError('invalid', 'What are the comments about?');
    const { items, usedKeys } = cleanItems(input.items ?? (comments ? COMMENT_ITEMS : []));
    checkPictures(scope, items);
    const title = cleanLine(input.title, 120) || name;
    // C15: a comment area always waits for her OK -- approvals on, "show right away" off
    return toForm((await one<FormRow>(q, `INSERT INTO forms (name, title, items, settings, used_keys, enabled, approvable, scope, kind, content_type, created_at, created_by, updated_at, updated_by)
                          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      name, title, JSON.stringify(items), JSON.stringify(cleanSettings(input.settings)), JSON.stringify(usedKeys), comments ? 1 : 0, scope,
      comments ? 'comments' : 'form', comments ? contentType : 'page', now, cleanBy(by), now, cleanBy(by)))!);
  });
}

// Save is live at once (D11). version: what the editor started from; if someone
// saved in between, nothing is changed and they're told who.
export async function saveForm(db: Db, now: number, input: { id: unknown; version: unknown; title?: unknown; items: unknown; settings?: unknown }, by: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const form = await needForm(q, input.id, { trashed: false });
    if (input.version !== form.version) {
      const when = new Date(form.updatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
      throw new GateError('stale', `${form.updatedBy ?? 'Someone'} saved this form at ${when} UTC, after you opened it. Reload to see those changes (yours would be lost), or copy what you changed first.`);
    }
    const { items, usedKeys } = cleanItems(input.items, form.items, form.usedKeys);
    checkPictures(form.scope, items);
    const title = input.title === undefined ? form.title : cleanLine(input.title, 120) || form.name;
    return toForm((await one<FormRow>(q, 'UPDATE forms SET title = ?, items = ?, settings = ?, used_keys = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? RETURNING *',
      title, JSON.stringify(items), JSON.stringify(cleanSettings(input.settings, form.settings)), JSON.stringify(usedKeys), now, cleanBy(by), form.id))!);
  });
}

// Everything but the id and the name (D7): items with their keys, settings, switches. Not its responses.
export async function duplicateForm(db: Db, now: number, id: unknown, name: unknown, by: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const from = await needForm(q, id);
    const n = await checkNewName(q, name);
    if (await formCount(q) >= MAX_FORMS) {
      throw new GateError('full', `You can have at most ${MAX_FORMS} forms (the trash counts too). Delete one you don't use first.`);
    }
    return toForm((await one<FormRow>(q, `INSERT INTO forms (name, title, items, settings, used_keys, enabled, approvable, public_approved, auto_approve, scope, kind, content_type, created_at, created_by, updated_at, updated_by)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      n, from.title, JSON.stringify(from.items), JSON.stringify(from.settings), JSON.stringify(from.usedKeys),
      from.enabled ? 1 : 0, from.approvable ? 1 : 0, from.publicApproved ? 1 : 0, from.autoApprove ? 1 : 0, from.scope, from.kind, from.contentType, now, cleanBy(by), now, cleanBy(by)))!);
  });
}

// "olivias-form" -> "olivias-form-copy", then "-copy-2"...
export async function suggestCopyName(db: Db, name: string): Promise<string> {
  const base = `${name.slice(0, 59).replace(/-+$/, '')}-copy`;
  const taken = async (n: string) => !!await one(db, 'SELECT 1 FROM forms WHERE name = ?', n);
  if (!await taken(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base.slice(0, 64 - String(i).length - 1)}-${i}`;
    if (!await taken(n)) return n;
  }
}

// The on/off switch, response-approvable, "anyone can read approved responses" and
// "show right away". Immediate, and not a save: they don't change the version.
// Switching approving off keeps "show right away" as it was, so switching it back
// on returns to the same way of working.
export async function setFormSwitches(db: Db, id: unknown, s: { enabled?: unknown; approvable?: unknown; publicApproved?: unknown; autoApprove?: unknown }): Promise<Form> {
  return tx(db, async (q) => {
    const form = await needForm(q, id, { trashed: false });
    const bool = (v: unknown, now: boolean) => {
      if (v === undefined) return now;
      if (typeof v !== 'boolean') throw new GateError('invalid', 'Expected on or off.');
      return v;
    };
    const enabled = bool(s.enabled, form.enabled);
    const approvable = bool(s.approvable, form.approvable);
    const publicApproved = bool(s.publicApproved, form.publicApproved);
    const autoApprove = bool(s.autoApprove, form.autoApprove);
    if (publicApproved && !approvable) throw new GateError('invalid', "Only a form whose responses can be approved can show approved responses to anyone.");
    // C15: until the robot check is in, every comment waits for her OK
    if (form.kind === 'comments' && (!approvable || autoApprove)) {
      throw new GateError('invalid', 'Comments always wait for your OK before anyone sees them.');
    }
    // W7/B4 (docs/refactor-plan.md phase 2): approvals cannot be taken away
    // while a link saves answers when she approves them -- every new response
    // would wait for an OK that can no longer be given. The link is
    // saves/links.ts's to write; this one read is the rule from the other side
    // (this file cannot import it: links.ts asks this file about the form).
    if (!approvable && form.approvable) {
      const link = await one<{ table_name: string }>(q,
        "SELECT table_name FROM form_links WHERE form_id = ? AND write_when = 'approved' AND enabled", form.id);
      if (link) {
        throw new GateError('invalid',
          `This form saves answers in ${link.table_name} when you approve them. On its Database page, change that to "as soon as they arrive" first.`);
      }
    }
    if (s.autoApprove !== undefined && autoApprove !== form.autoApprove) {
      // The examples teach the approve step, and anyone who guesses their address can send.
      if (form.fixture) throw new GateError('invalid', 'The examples always wait for your OK.');
      if (autoApprove && !approvable) throw new GateError('invalid', 'Switch on "Responses can be approved" first.');
    }
    return toForm((await one<FormRow>(q, 'UPDATE forms SET enabled = ?, approvable = ?, public_approved = ?, auto_approve = ? WHERE id = ? RETURNING *',
      enabled ? 1 : 0, approvable ? 1 : 0, publicApproved ? 1 : 0, autoApprove ? 1 : 0, form.id))!);
  });
}

// Like folders and responses: to the trash, restorable for 30 days, then gone
// (housekeeping). Its responses stay; its name stays taken until then.
export async function trashForm(db: Db, now: number, id: unknown, by: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const form = await needForm(q, id, { trashed: false });
    // The examples belong to the panel and the guides, like the example sign-in
    // looks. "Reset the example" is how you undo anything you did to one (D6).
    if (form.fixture) throw new GateError('invalid', `"${form.title}" is one of the examples, so it stays. Use "Reset the example" to put it back as it was, or "Duplicate" to make one of your own from it.`);
    return toForm((await one<FormRow>(q, 'UPDATE forms SET trashed_at = ?, trashed_by = ? WHERE id = ? RETURNING *', now, cleanBy(by), form.id))!);
  });
}

export async function restoreForm(db: Db, id: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const form = await needForm(q, id, { trashed: true });
    return toForm((await one<FormRow>(q, 'UPDATE forms SET trashed_at = NULL, trashed_by = NULL WHERE id = ? RETURNING *', form.id))!);
  });
}

// Where a form works (D22). Its pictures have to be inside the new place too.
export async function setFormScope(db: Db, id: unknown, scope: unknown): Promise<Form> {
  return tx(db, async (q) => {
    const form = await needForm(q, id);
    const sc = cleanScope(scope);
    if (form.fixture && sc !== '/') throw new GateError('invalid', 'The examples work everywhere.');
    checkPictures(sc, form.items);
    return toForm((await one<FormRow>(q, 'UPDATE forms SET scope = ? WHERE id = ? RETURNING *', sc, form.id))!);
  });
}

// Pages that showed a form lately (the component asks for it with the page's address).
export async function recordFormPage(db: Db, now: number, formId: number, page: string) {
  await run(db, 'INSERT INTO form_pages (form_id, page, last_seen) VALUES (?, ?, ?) ON CONFLICT (form_id, page) DO UPDATE SET last_seen = excluded.last_seen',
    formId, page.slice(0, 1000), now);
}

export const summary = (f: Form) => ({
  id: f.id, name: f.name, title: f.title, kind: f.kind, contentType: f.contentType, items: f.items, settings: f.settings, enabled: f.enabled, approvable: f.approvable,
  publicApproved: f.publicApproved, autoApprove: f.autoApprove, version: f.version, fixture: f.fixture, scope: f.scope, createdAt: f.createdAt, createdBy: f.createdBy,
  updatedAt: f.updatedAt, updatedBy: f.updatedBy, trashedAt: f.trashedAt, trashedBy: f.trashedBy,
});
