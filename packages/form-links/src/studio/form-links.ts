// Forms into a database (docs/form-to-database-plan.md): the rules for a form
// whose answers also go into one of her tables. Used by the panel, to tell her
// what fits before she switches it on, and by the gate, which writes the rows
// and checks every one of them again against the catalog.
//
// Pure: no database, no socket, no clock.
import { ADDRESS_PARTS, NAME_PARTS, type AnswerType, type AnswerValue, type StoredAnswer } from '@panel/forms/shared/form-types';
import type { ColumnType } from '@panel/studio/pammydb/ir';
import type { Scalar } from '@panel/studio/pammydb/rows';
import { cleanRich, fromPlain } from '@panel/studio/studio/rich-text';

// ------------------------------------------------------------------ the shape

// One question (or one part of a name or address) into one field (F4, F5).
export type Pair = { key: string; part?: string; field: string };
// A field no question fills (F6): a value of its own, or something about the
// response itself.
export type Fixed = { field: string; value?: Scalar; from?: 'sent-at' | 'page' | 'sender' };
export type When = 'approved' | 'arrived';

export type FormLink = {
  databaseId: number;
  engine: 'postgres' | 'mariadb';
  name: string;
  table: string;
  when: When;
  pairs: Pair[];
  fixed: Fixed[];
  enabled: boolean;
};

// What the catalog says about a field (src/studio/catalog.ts `types`).
export type TargetField = { type: ColumnType; length?: number; required: boolean; defaulted: boolean; rich?: boolean };

// A question as the link sees it.
export type Question = { key: string; label: string; type: AnswerType; required: boolean; parts?: string[] };

// Said in her words when a row cannot be made; the gate keeps it on the response.
export class FormLinkError extends Error {}

export const PART_NAMES: Record<string, string> = {
  title: 'title', first: 'first name', middle: 'middle name', last: 'last name',
  line1: 'street', line2: 'second line', town: 'town', region: 'county', postcode: 'postcode', country: 'country',
};
export const FIXED_FROM: Record<NonNullable<Fixed['from']>, string> = {
  'sent-at': 'when it was sent', page: 'the page it was sent from', sender: 'who sent it (signed-in visitors)',
};

// ------------------------------------------------------------------ what fits where (F5)

const TEXT: ColumnType[] = ['text', 'short_text'];
const NUMBER: ColumnType[] = ['integer', 'decimal'];

export function fits(type: AnswerType, part: string | undefined, f: TargetField): boolean {
  if (type === 'name' || type === 'address') {
    // a part, or the whole as one line of text
    const parts: readonly string[] = type === 'name' ? NAME_PARTS : ADDRESS_PARTS;
    if (part !== undefined && !parts.includes(part)) return false;
    return TEXT.includes(f.type);
  }
  if (part !== undefined) return false;
  switch (type) {
    case 'short-text': case 'email': case 'phone': case 'website': case 'dropdown': case 'single-choice': case 'hidden':
    case 'multiple-choice':
      return TEXT.includes(f.type);
    case 'long-text':
      return TEXT.includes(f.type);
    case 'number':
      return NUMBER.includes(f.type);
    case 'rating': case 'scale':
      return NUMBER.includes(f.type);
    case 'date': return f.type === 'date';
    case 'time': return f.type === 'time';
    case 'checkbox': return f.type === 'boolean';
    default: return false;
  }
}

export function fixedFits(x: Fixed, f: TargetField): boolean {
  if (x.from === 'sent-at') return f.type === 'timestamptz' || f.type === 'date';
  if (x.from === 'page' || x.from === 'sender') return TEXT.includes(f.type);
  const v = x.value;
  if (v === null || v === undefined) return !f.required || f.defaulted;
  if (typeof v === 'boolean') return f.type === 'boolean';
  if (typeof v === 'number') return NUMBER.includes(f.type) && (f.type === 'decimal' || Number.isInteger(v));
  if (f.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (f.type === 'time') return /^\d{2}:\d{2}(:\d{2})?$/.test(v);
  return TEXT.includes(f.type);
}

// ------------------------------------------------------------------ is it complete? (F7)

// Every problem with a link, in her words. Empty means it can be switched on.
export function linkProblems(link: Pick<FormLink, 'pairs' | 'fixed'>, questions: Question[], fields: Record<string, TargetField>): string[] {
  const out: string[] = [];
  const byKey = new Map(questions.map((q) => [q.key, q]));
  const filled = new Map<string, boolean>();       // field -> is it always filled?
  for (const p of link.pairs) {
    const q = byKey.get(p.key);
    const f = fields[p.field];
    if (!q) { out.push(`A question this form no longer has (${p.key}) is still paired with ${p.field}.`); continue; }
    if (!f) { out.push(`${q.label} goes into ${p.field}, which is not one of this table's fields any more.`); continue; }
    if (!fits(q.type, p.part, f)) out.push(`${q.label}${p.part ? ` (${PART_NAMES[p.part] ?? p.part})` : ''} can't go into ${p.field}.`);
    if (filled.has(p.field)) out.push(`Two answers go into ${p.field}. Choose one.`);
    // a whole required name is always there; one part of it may not be
    filled.set(p.field, q.required && p.part === undefined && q.type !== 'hidden' ? true : (q.type === 'checkbox'));
  }
  for (const x of link.fixed) {
    const f = fields[x.field];
    if (!f) { out.push(`${x.field} is not one of this table's fields any more.`); continue; }
    if (filled.has(x.field)) out.push(`${x.field} has an answer and a fixed value. Choose one.`);
    if (!fixedFits(x, f)) out.push(`That fixed value doesn't fit ${x.field}.`);
    filled.set(x.field, x.value !== null || x.from !== undefined);
  }
  for (const [name, f] of Object.entries(fields)) {
    if (!f.required || f.defaulted) continue;
    if (!filled.has(name)) out.push(`${name} has to be filled in: pair it with a question, or give it a fixed value.`);
    else if (!filled.get(name)) out.push(`${name} has to be filled in, but its question may be left empty. Make the question required, or use a fixed value.`);
  }
  return out;
}

// ------------------------------------------------------------------ the row (F5, F6)

// a whole name reads "Olivia Rose"; a whole address "1 High St, Leeds"
const scalarOf = (v: AnswerValue, part: string | undefined, join = ', '): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  if (typeof v === 'object') {
    if (part !== undefined) return v[part]?.trim() || null;
    const joined = Object.values(v).map((x) => x.trim()).filter(Boolean).join(join);
    return joined || null;
  }
  return v;
};

// The values of one row, from a response's stored answers (already checked by
// cleanAnswers when it was sent). Throws FormLinkError, in her words, when an
// answer does not fit its field -- the response is kept and says why.
// A moment as each engine takes it: Postgres an ISO time with its zone,
// MariaDB's DATETIME plain 'YYYY-MM-DD HH:MM:SS' in UTC (it refuses the "Z",
// and the panel reads DATETIME back as UTC -- src/pammydb/maria.ts).
export const momentFor = (engine: 'postgres' | 'mariadb' | undefined, unix: number): string => {
  const iso = new Date(unix * 1000).toISOString();
  return engine === 'mariadb' ? iso.slice(0, 19).replace('T', ' ') : iso;
};

export function buildValues(
  link: Pick<FormLink, 'pairs' | 'fixed'>, answers: StoredAnswer[],
  meta: { sentAt: number; page: string; sender: string | null; engine?: 'postgres' | 'mariadb' },
  fields: Record<string, TargetField>,
): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  const byKey = new Map(answers.map((a) => [a.key, a]));
  const put = (field: string, raw: Scalar, what: string) => {
    const f = fields[field];
    if (!f) throw new FormLinkError(`${field} is not one of the table's fields any more.`);
    let v: Scalar = raw;
    if (v === null || v === '') v = null;
    else if (f.type === 'integer' || f.type === 'decimal') {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) throw new FormLinkError(`${what} is not a ${f.type === 'integer' ? 'whole ' : ''}number, so it can't go into ${field}.`);
      v = n;
    } else if (f.type === 'boolean') {
      v = v === true || v === 'true';
    } else if (typeof v === 'string' && f.rich) {
      // what a visitor typed in a box is words, even if it looks like HTML:
      // paragraphs, with a typed <b> kept as the letters "<b>" (found by test)
      v = cleanRich(fromPlain(v));
    } else if (typeof v !== 'string') {
      v = String(v);
    }
    if (typeof v === 'string' && f.type === 'short_text' && f.length && [...v].length > f.length) {
      throw new FormLinkError(`${what} is longer than ${field} can hold (${f.length} letters).`);
    }
    if (v === null && f.required && !f.defaulted) throw new FormLinkError(`${field} has to be filled in, and ${what} was left empty.`);
    if (v !== null || !f.defaulted) out[field] = v;
  };
  for (const p of link.pairs) {
    const a = byKey.get(p.key);
    put(p.field, a ? scalarOf(a.value, p.part, a.type === 'name' ? ' ' : ', ') : null, a ? `"${a.label}"` : `the answer to ${p.key}`);
  }
  for (const x of link.fixed) {
    if (x.from === 'sent-at') {
      const when = momentFor(meta.engine, meta.sentAt);
      put(x.field, fields[x.field]?.type === 'date' ? when.slice(0, 10) : when, 'when it was sent');
    } else if (x.from === 'page') put(x.field, meta.page || null, 'the page');
    else if (x.from === 'sender') put(x.field, meta.sender, 'who sent it');
    else put(x.field, x.value ?? null, `the fixed value for ${x.field}`);
  }
  return out;
}

// ------------------------------------------------------------------ reading one back

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const KEY_RE = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A link as stored or sent, read the way everything from outside is: what does
// not parse is refused (the panel) or treated as no link at all (the gate).
export function checkLinkShape(v: unknown): Omit<FormLink, 'databaseId' | 'engine' | 'name'> & { engine?: string; name?: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  const bad = (why: string) => new FormLinkError(`The panel could not read that: ${why}.`);
  if (typeof o.table !== 'string' || !NAME_RE.test(o.table)) throw bad('which table');
  if (o.when !== 'approved' && o.when !== 'arrived') throw bad('when to save');
  if (!Array.isArray(o.pairs) || o.pairs.length > 200 || !Array.isArray(o.fixed) || o.fixed.length > 200) throw bad('the pairs');
  const pairs: Pair[] = o.pairs.map((p) => {
    const x = (p ?? {}) as Record<string, unknown>;
    if (typeof x.key !== 'string' || !KEY_RE.test(x.key) || typeof x.field !== 'string' || !NAME_RE.test(x.field)) throw bad('a pair');
    if (x.part !== undefined && (typeof x.part !== 'string' || ![...NAME_PARTS, ...ADDRESS_PARTS].includes(x.part as never))) throw bad('a part');
    return x.part === undefined ? { key: x.key, field: x.field } : { key: x.key, part: x.part as string, field: x.field };
  });
  const fixed: Fixed[] = o.fixed.map((p) => {
    const x = (p ?? {}) as Record<string, unknown>;
    if (typeof x.field !== 'string' || !NAME_RE.test(x.field)) throw bad('a fixed value');
    if (x.from !== undefined) {
      if (x.from !== 'sent-at' && x.from !== 'page' && x.from !== 'sender') throw bad('a fixed value');
      return { field: x.field, from: x.from };
    }
    const val = x.value;
    if (!(val === null || typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val)) || (typeof val === 'string' && val.length <= 1000))) throw bad('a fixed value');
    return { field: x.field, value: val as Scalar };
  });
  return { table: o.table, when: o.when, pairs, fixed, enabled: o.enabled !== false };
}

// Suggested pairs for a table (the panel's first guess, which she changes): a
// field with the question's own name, or its label's, that it fits.
export function suggestPairs(questions: Question[], fields: Record<string, TargetField>): Pair[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const used = new Set<string>();
  const out: Pair[] = [];
  for (const q of questions) {
    const candidates = [norm(q.key), norm(q.label), `${norm(q.key)}s`, norm(q.label).replace(/^your_/, '')];
    const hit = candidates.find((c) => fields[c] && !used.has(c) && fits(q.type, undefined, fields[c]!));
    if (hit) { used.add(hit); out.push({ key: q.key, field: hit }); }
  }
  return out;
}
