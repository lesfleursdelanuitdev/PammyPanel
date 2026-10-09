// What a form is made of (docs/forms-plan.md): its name, its limits, and the
// checks on the items and settings the panel sends. Pure: no database here.
import { GateError, cleanBy, cleanLine, cleanMessage, int } from '@panel/core/gate/ops';
export { cleanBy, int };
import {
  DEFAULT_SETTINGS, isAnswerType, isLayoutType,
  type AnswerType, type Item, type ItemType, type LayoutType, type Settings,
} from '../../shared/form-types.ts';

// ------------------------------------------------------------------ names and limits
// A form's name is how a page asks for it. It can never change (D3), and stays
// taken while the form is in the trash.
export const FORM_NAME_RE = /^(?=[a-z0-9-]{2,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A field's key: its name in stored responses and the API. Fixed once saved (D19).
export const FIELD_KEY_RE = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|svg)$/i;

export const MAX_ITEMS = 100;
export const MAX_OPTIONS = 100;
export const MAX_FORMS = 200;
export const TRASH_DAYS = 30;
export const PAGE_SEEN_DAYS = 90;
// A flood can't bury real responses or fill the disk.
export const MAX_UNREAD = 1000;
export const MAX_STORED = 10_000;
// How many entries an example form keeps (examples.ts uses it too; it lives here
// because examples.ts imports this file, not the other way round).
export const MAX_EXAMPLE_RESPONSES = 50;

// ------------------------------------------------------------------ items
// Not shown publicly unless she says so (section 6.1 of the plan).
const PRIVATE_BY_DEFAULT: ReadonlySet<ItemType> = new Set(['email', 'phone', 'address', 'hidden']);

// "Your name!" -> "your-name"
export function keyFromLabel(label: string, fallback = 'field'): string {
  const k = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return k || fallback;
}

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const k = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(k)) return k;
  }
}

const optInt = (v: unknown, lo: number, hi: number, what: string): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = int(v);
  if (n === null || n < lo || n > hi) throw new GateError('invalid', `${what} must be a whole number from ${lo} to ${hi}.`);
  return n;
};
const optNumber = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15) throw new GateError('invalid', `${what} must be a number.`);
  return v;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);

export function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const today = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);

function cleanOptions(v: unknown, where: string): string[] {
  const options = [...new Set((Array.isArray(v) ? v : []).map((o) => cleanLine(o, 200)).filter(Boolean))];
  if (options.length === 0) throw new GateError('invalid', `${where} needs at least one choice.`);
  if (options.length > MAX_OPTIONS) throw new GateError('invalid', `${where} can have at most ${MAX_OPTIONS} choices.`);
  return options;
}

// The whole list of items, as the panel sends it. previous: the items as last
// saved, so a saved field keeps its key and type whatever is sent; usedKeys:
// every key the form has ever had, so a new field never takes an old one's key.
export function cleanItems(v: unknown, previous: Item[] = [], usedKeys: string[] = []): { items: Item[]; usedKeys: string[] } {
  if (!Array.isArray(v)) throw new GateError('invalid', 'Expected a list of items.');
  if (v.length > MAX_ITEMS) throw new GateError('invalid', `A form can have at most ${MAX_ITEMS} items.`);
  const before = new Map(previous.map((i) => [i.id, i]));
  const ids = new Set<string>();
  let next = Math.max(0, ...previous.map((i) => Number(i.id.slice(1)) || 0), ...v.map((raw) => {
    const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : null;
    return typeof id === 'string' && /^i[0-9]{1,6}$/.test(id) ? Number(id.slice(1)) : 0;
  }));
  const taken = new Set(usedKeys);
  const keysNow = new Set<string>();
  const out: Item[] = [];

  // saved fields claim their keys first, so a new field can't take one
  for (const raw of v) {
    const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : null;
    const old = typeof id === 'string' ? before.get(id) : undefined;
    if (old?.key) keysNow.add(old.key);
  }

  for (const [n, raw] of v.entries()) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let id = typeof r.id === 'string' && /^i[0-9]{1,6}$/.test(r.id) && !ids.has(r.id) ? r.id : '';
    if (!id) id = `i${++next}`;
    ids.add(id);
    const old = before.get(id);
    const type = old ? old.type : r.type;
    const labelText = cleanLine(r.label, 200);
    const where = `Item ${n + 1}${labelText ? ` ("${labelText}")` : ''}`;
    if (old && r.type !== undefined && r.type !== old.type) {
      throw new GateError('invalid', `${where} was saved as a different kind of field, and a saved field's kind can't change. Add a new field instead.`);
    }
    if (isLayoutType(type)) {
      out.push(cleanLayout(id, type, r, where));
      continue;
    }
    if (!isAnswerType(type)) throw new GateError('invalid', `${where} has an unknown kind.`);
    if (!labelText) throw new GateError('invalid', `Item ${n + 1} needs a label.`);

    let key: string;
    if (old?.key) {
      key = old.key;
    } else {
      const asked = typeof r.key === 'string' && r.key !== '' ? r.key : keyFromLabel(labelText);
      if (!FIELD_KEY_RE.test(asked)) throw new GateError('invalid', `${where}: a field's key uses lowercase letters, digits and single hyphens (up to 40).`);
      key = uniqueKey(asked, new Set([...taken, ...keysNow]));
      keysNow.add(key);
    }
    out.push(cleanAnswerItem(id, type, key, labelText, r, where));
  }
  const all = new Set([...usedKeys, ...out.filter((i) => i.key).map((i) => i.key!)]);
  return { items: out, usedKeys: [...all] };
}

function cleanLayout(id: string, type: LayoutType, r: Record<string, unknown>, where: string): Item {
  switch (type) {
    case 'heading': {
      const text = cleanLine(r.text, 200);
      if (!text) throw new GateError('invalid', `${where}: a heading needs some words.`);
      return { id, type, text, size: pick(r.size, ['large', 'medium', 'small'] as const, 'medium') };
    }
    case 'paragraph': {
      const text = cleanMessage(r.text, 5000);
      if (!text) throw new GateError('invalid', `${where}: a paragraph needs some words.`);
      return { id, type, text };
    }
    case 'divider': return { id, type };
    case 'image': {
      const src = cleanImagePath(r.src);
      if (!src) throw new GateError('invalid', `${where}: choose a picture from one of your media folders.`);
      const alt = cleanLine(r.alt, 200);
      if (!alt) throw new GateError('invalid', `${where}: describe the picture in a few words (for people who can't see it).`);
      return { id, type, src, alt, width: pick(r.width, ['full', 'half'] as const, 'full') };
    }
  }
}

// A picture in her website, as a path from its top: "recipes/media/images/cake.jpg".
export function cleanImagePath(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parts = v.split('/').filter((p) => p !== '');
  if (parts.length < 1 || parts.length > 32) return null;
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.') || p.length > 200 || /[\\\x00-\x1f\x7f]/.test(p)) return null;
  }
  return IMAGE_RE.test(parts.at(-1)!) ? parts.join('/') : null;
}

// ------------------------------------------------------------------ scopes (docs/media-plan.md D22)
// '/' or '/<a folder directly in her website>'.
export function cleanScope(v: unknown): string {
  if (v === undefined || v === null || v === '/') return '/';
  if (typeof v === 'string' && /^\/[^/\\\x00-\x1f\x7f]{1,200}$/.test(v) && !v.startsWith('/.')) return v;
  throw new GateError('invalid', "That isn't a place a form can belong to.");
}
// Whether a path in her website ("olivia/contact.html") is inside a scope.
export const inScope = (scope: string, rel: string) => scope === '/' || rel === scope.slice(1) || rel.startsWith(`${scope.slice(1)}/`);
// A scoped form's pictures come from its own folder.
export function checkPictures(scope: string, items: Item[]) {
  if (scope === '/') return;
  const bad = items.find((i) => i.type === 'image' && i.src && !inScope(scope, i.src));
  if (bad) throw new GateError('invalid', `The picture "${bad.src}" isn't in ${scope.slice(1)}/, so this form can't show it.`);
}

function cleanAnswerItem(id: string, type: AnswerType, key: string, label: string, r: Record<string, unknown>, where: string): Item {
  const item: Item = {
    id, type, key, label, help: cleanMessage(r.help, 500), required: type === 'hidden' ? false : r.required === true,
    width: pick(r.width, ['full', 'half'] as const, 'full'),
    public: typeof r.public === 'boolean' ? r.public : !PRIVATE_BY_DEFAULT.has(type),
  };
  const textDefault = (max: number) => cleanLine(r.default, max);
  switch (type) {
    case 'short-text':
    case 'long-text': {
      const cap = type === 'short-text' ? 500 : 5000;
      item.placeholder = cleanLine(r.placeholder, 120);
      item.minLength = optInt(r.minLength, 0, cap, `${where}: the fewest characters`);
      item.maxLength = optInt(r.maxLength, 1, cap, `${where}: the most characters`);
      if (item.minLength !== null && item.maxLength !== null && item.minLength > item.maxLength) {
        throw new GateError('invalid', `${where}: the fewest characters is more than the most.`);
      }
      if (type === 'long-text') item.rows = optInt(r.rows, 2, 20, `${where}: the height`) ?? 5;
      item.default = type === 'short-text' ? textDefault(cap) : cleanMessage(r.default, cap);
      break;
    }
    case 'email':
    case 'phone':
    case 'website':
      item.placeholder = cleanLine(r.placeholder, 120);
      item.default = textDefault(200);
      break;
    case 'number': {
      item.placeholder = cleanLine(r.placeholder, 120);
      item.min = optNumber(r.min, `${where}: the smallest number`);
      item.max = optNumber(r.max, `${where}: the largest number`);
      item.decimals = optInt(r.decimals, 0, 6, `${where}: decimal places`) ?? 0;
      if (item.min !== null && item.max !== null && item.min > item.max) throw new GateError('invalid', `${where}: the smallest number is more than the largest.`);
      const d = optNumber(r.default, `${where}: the starting value`);
      if (d !== null && ((item.min !== null && d < item.min) || (item.max !== null && d > item.max))) {
        throw new GateError('invalid', `${where}: the starting value is outside the numbers allowed.`);
      }
      item.default = d;
      break;
    }
    case 'date': {
      const day = (v: unknown, what: string) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s === '' || s === 'today' || validDate(s)) return s;
        throw new GateError('invalid', `${where}: ${what} must be a date (YYYY-MM-DD) or "today".`);
      };
      item.earliest = day(r.earliest, 'the earliest date');
      item.latest = day(r.latest, 'the latest date');
      if (validDate(item.earliest) && validDate(item.latest) && item.earliest > item.latest) throw new GateError('invalid', `${where}: the earliest date is after the latest.`);
      item.default = day(r.default, 'the starting date');
      break;
    }
    case 'time': {
      const time = (v: unknown, what: string) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s === '' || TIME_RE.test(s)) return s;
        throw new GateError('invalid', `${where}: ${what} must be a time like 09:30.`);
      };
      item.earliest = time(r.earliest, 'the earliest time');
      item.latest = time(r.latest, 'the latest time');
      if (item.earliest && item.latest && item.earliest > item.latest) throw new GateError('invalid', `${where}: the earliest time is after the latest.`);
      item.step = optInt(r.step, 1, 60, `${where}: the minutes between times`) ?? 1;
      item.default = time(r.default, 'the starting time');
      break;
    }
    case 'dropdown':
    case 'single-choice': {
      item.options = cleanOptions(r.options, where);
      if (type === 'dropdown') item.placeholder = cleanLine(r.placeholder, 120);
      else {
        item.other = r.other === true;
        item.columns = r.columns === 2 ? 2 : 1;
      }
      const d = cleanLine(r.default, 200);
      if (d && !item.options.includes(d)) throw new GateError('invalid', `${where}: the starting choice isn't one of the choices.`);
      item.default = d;
      break;
    }
    case 'multiple-choice': {
      item.options = cleanOptions(r.options, where);
      item.other = r.other === true;
      item.columns = r.columns === 2 ? 2 : 1;
      const most = item.options.length + (item.other ? 1 : 0);
      item.minPicks = optInt(r.minPicks, 0, most, `${where}: the fewest choices`);
      item.maxPicks = optInt(r.maxPicks, 1, most, `${where}: the most choices`);
      if (item.minPicks !== null && item.maxPicks !== null && item.minPicks > item.maxPicks) throw new GateError('invalid', `${where}: the fewest choices is more than the most.`);
      const d = [...new Set((Array.isArray(r.default) ? r.default : []).map((o) => cleanLine(o, 200)).filter(Boolean))];
      if (d.some((o) => !item.options!.includes(o))) throw new GateError('invalid', `${where}: a starting choice isn't one of the choices.`);
      item.default = d;
      break;
    }
    case 'checkbox':
      item.default = r.default === true;
      break;
    case 'name': {
      const p = (r.parts && typeof r.parts === 'object' ? r.parts : {}) as Record<string, unknown>;
      item.parts = { title: p.title === true, middle: p.middle === true };
      break;
    }
    case 'address': {
      const p = (r.parts && typeof r.parts === 'object' ? r.parts : {}) as Record<string, unknown>;
      item.parts = { line2: p.line2 !== false, region: p.region !== false, postcode: p.postcode !== false, country: p.country !== false };
      item.defaultCountry = cleanLine(r.defaultCountry, 80);
      break;
    }
    case 'rating':
      item.stars = optInt(r.stars, 3, 10, `${where}: the number of stars`) ?? 5;
      break;
    case 'scale': {
      item.from = r.from === 0 ? 0 : 1;
      item.to = optInt(r.to, 5, 10, `${where}: the top of the scale`) ?? 10;
      item.lowLabel = cleanLine(r.lowLabel, 60);
      item.highLabel = cleanLine(r.highLabel, 60);
      break;
    }
    case 'hidden': {
      item.value = cleanLine(r.value, 500);
      const param = typeof r.param === 'string' ? r.param.trim() : '';
      if (param && !PARAM_RE.test(param)) throw new GateError('invalid', `${where}: the address setting's name uses letters, digits, _ and - (up to 40).`);
      item.param = param;
      break;
    }
  }
  return item;
}

export function cleanSettings(v: unknown, previous: Settings = DEFAULT_SETTINGS): Settings {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    submitText: r.submitText === undefined ? previous.submitText : cleanLine(r.submitText, 60) || DEFAULT_SETTINGS.submitText,
    sentText: r.sentText === undefined ? previous.sentText : cleanMessage(r.sentText, 500) || DEFAULT_SETTINGS.sentText,
    signedInOnly: typeof r.signedInOnly === 'boolean' ? r.signedInOnly : previous.signedInOnly,
    showSender: typeof r.showSender === 'boolean' ? r.showSender : previous.showSender,
  };
}

// What a new comment area asks, unless she says otherwise (docs/comments-plan.md
// C18): a name and the comment, both shown publicly once approved.
export const COMMENT_ITEMS = [
  { id: 'new-1', type: 'short-text', label: 'Your name', required: true, public: true, maxLength: 80 },
  { id: 'new-2', type: 'long-text', label: 'Your comment', required: true, public: true, maxLength: 3000, rows: 4 },
];
export const CONTENT_TYPE_RE = /^(page|[a-z][a-z0-9_]{0,62})$/;
