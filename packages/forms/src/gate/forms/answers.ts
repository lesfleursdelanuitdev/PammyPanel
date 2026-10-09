// A visitor's answers, checked against the form as it is now, and the rows
// the API filters on. Pure: no database here.
import { GateError, cleanLine, cleanMessage } from '@panel/core/gate/ops';
import { ADDRESS_PARTS, isAnswerType, NAME_PARTS, type AnswerType, type AnswerValue, type Item, type StoredAnswer } from '../../shared/form-types.ts';
import { minutesOf, TIME_RE, today, validDate } from './items.ts';
import type { Form } from './store.ts';

const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/;
const PHONE_RE = /^[+()0-9 .\-/]{5,40}$/;
const NUMBER_RE = /^-?[0-9]{1,15}(?:[.,][0-9]{1,6})?$/;

const answerItems = (form: Form) => form.items.filter((i): i is Item & { key: string; label: string; type: AnswerType } => isAnswerType(i.type));

// A visitor's answers, checked against the form as it is now. Throws with the
// field's key, so the page can point at it. params: the page address's ?query,
// for hidden values taken from it.
export function cleanAnswers(form: Form, values: unknown, now: number): StoredAnswer[] {
  const input = (values && typeof values === 'object' && !Array.isArray(values) ? values : {}) as Record<string, unknown>;
  return answerItems(form).map((f) => ({ key: f.key, label: f.label, type: f.type, value: cleanAnswer(f, input[f.key], now) }));
}

function cleanAnswer(f: Item & { key: string; label: string; type: AnswerType }, raw: unknown, now: number): AnswerValue {
  const bad = (message: string) => new GateError('invalid', message, f.key);
  const fill = () => bad(`Please fill in "${f.label}".`);
  const text = (max: number, multiline = false) => {
    const s = multiline ? cleanMessage(raw, 100_000) : cleanLine(raw, 100_000);
    if ([...s].length > max) throw bad(`"${f.label}" can be at most ${max} characters.`);
    return s;
  };
  switch (f.type) {
    case 'short-text':
    case 'long-text': {
      const s = text(f.maxLength ?? (f.type === 'short-text' ? 500 : 5000), f.type === 'long-text');
      if (!s) { if (f.required) throw fill(); return null; }
      if (f.minLength && [...s].length < f.minLength) throw bad(`"${f.label}" needs at least ${f.minLength} characters.`);
      return s;
    }
    case 'email': {
      const s = text(254);
      if (!s) { if (f.required) throw fill(); return null; }
      if (!EMAIL_RE.test(s)) throw bad(`"${f.label}" doesn't look like an email address.`);
      return s;
    }
    case 'phone': {
      const s = text(40);
      if (!s) { if (f.required) throw fill(); return null; }
      if (!PHONE_RE.test(s) || (s.match(/[0-9]/g) ?? []).length < 5) throw bad(`"${f.label}" doesn't look like a phone number.`);
      return s;
    }
    case 'website': {
      let s = text(2000);
      if (!s) { if (f.required) throw fill(); return null; }
      if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
      let u: URL;
      try { u = new URL(s); } catch { throw bad(`"${f.label}" doesn't look like a website address.`); }
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) throw bad(`"${f.label}" doesn't look like a website address.`);
      return s;
    }
    case 'number': {
      const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : cleanLine(raw, 40);
      if (!s) { if (f.required) throw fill(); return null; }
      if (!NUMBER_RE.test(s)) throw bad(`"${f.label}" should be a number.`);
      const [, frac = ''] = s.replace(',', '.').split('.');
      if (frac.length > (f.decimals ?? 0)) throw bad((f.decimals ?? 0) === 0 ? `"${f.label}" should be a whole number.` : `"${f.label}" can have at most ${f.decimals} decimal places.`);
      const n = Number(s.replace(',', '.'));
      if (f.min !== null && f.min !== undefined && n < f.min) throw bad(`"${f.label}" should be at least ${f.min}.`);
      if (f.max !== null && f.max !== undefined && n > f.max) throw bad(`"${f.label}" should be at most ${f.max}.`);
      return n;
    }
    case 'date': {
      const s = cleanLine(raw, 20);
      if (!s) { if (f.required) throw bad(`Please choose a date for "${f.label}".`); return null; }
      if (!validDate(s)) throw bad(`"${f.label}" should be a date.`);
      const lo = f.earliest === 'today' ? today(now) : f.earliest;
      const hi = f.latest === 'today' ? today(now) : f.latest;
      if (lo && s < lo) throw bad(`"${f.label}" can't be before ${lo}.`);
      if (hi && s > hi) throw bad(`"${f.label}" can't be after ${hi}.`);
      return s;
    }
    case 'time': {
      const s = cleanLine(raw, 10);
      if (!s) { if (f.required) throw bad(`Please choose a time for "${f.label}".`); return null; }
      if (!TIME_RE.test(s)) throw bad(`"${f.label}" should be a time.`);
      if (f.earliest && s < f.earliest) throw bad(`"${f.label}" can't be before ${f.earliest}.`);
      if (f.latest && s > f.latest) throw bad(`"${f.label}" can't be after ${f.latest}.`);
      if ((f.step ?? 1) > 1 && (minutesOf(s) - (f.earliest ? minutesOf(f.earliest) : 0)) % f.step! !== 0) {
        throw bad(`"${f.label}" should be in steps of ${f.step} minutes.`);
      }
      return s;
    }
    case 'dropdown':
    case 'single-choice': {
      const s = cleanLine(raw, 200);
      if (!s) { if (f.required) throw bad(`Please choose an answer for "${f.label}".`); return null; }
      if (!f.options!.includes(s) && !(f.type === 'single-choice' && f.other)) throw bad(`Please choose one of the answers for "${f.label}".`);
      return s;
    }
    case 'multiple-choice': {
      if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw bad(`Please choose from the answers for "${f.label}".`);
      const picked = [...new Set((raw as unknown[] | undefined ?? []).map((o) => cleanLine(o, 200)).filter(Boolean))];
      const others = picked.filter((o) => !f.options!.includes(o));
      if (others.length > (f.other ? 1 : 0)) throw bad(`Please choose from the answers for "${f.label}".`);
      if (picked.length > f.options!.length + 1) throw bad(`Please choose from the answers for "${f.label}".`);
      if (f.required && picked.length === 0) throw bad(`Please choose at least one answer for "${f.label}".`);
      if (picked.length > 0 || f.required) {
        if (f.minPicks && picked.length < f.minPicks) throw bad(`Please choose at least ${f.minPicks} answers for "${f.label}".`);
        if (f.maxPicks && picked.length > f.maxPicks) throw bad(`Please choose at most ${f.maxPicks} answers for "${f.label}".`);
      }
      return picked;
    }
    case 'checkbox':
      if (f.required && raw !== true) throw bad(`Please tick "${f.label}".`);
      return raw === true;
    case 'name':
    case 'address': {
      const parts = f.type === 'name'
        ? NAME_PARTS.filter((p) => p === 'first' || p === 'last' || f.parts?.[p])
        : ADDRESS_PARTS.filter((p) => p === 'line1' || p === 'town' || f.parts?.[p]);
      const obj = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const p of parts) {
        const s = cleanLine(obj[p], 100_000);
        if ([...s].length > (p === 'postcode' ? 20 : 200)) throw bad(`Part of "${f.label}" is too long.`);
        out[p] = s;
      }
      const empty = Object.values(out).every((s) => s === '');
      if (empty) { if (f.required) throw fill(); return null; }
      const must = f.type === 'name' ? ['first', 'last'] : ['line1', 'town'];
      if (f.required && must.some((p) => !out[p])) {
        throw bad(f.type === 'name' ? `Please fill in both first and last name for "${f.label}".` : `Please fill in at least the first line and town for "${f.label}".`);
      }
      return out;
    }
    case 'rating':
    case 'scale': {
      const lo = f.type === 'rating' ? 1 : f.from ?? 1;
      const hi = f.type === 'rating' ? f.stars ?? 5 : f.to ?? 10;
      if (raw === undefined || raw === null || raw === '') { if (f.required) throw bad(`Please choose an answer for "${f.label}".`); return null; }
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`"${f.label}" should be from ${lo} to ${hi}.`);
      return n;
    }
    case 'hidden': {
      if (!f.param) return f.value || null;
      const s = cleanLine(raw, 500);
      return s || f.value || null;
    }
  }
}

// Rows for filtering (response_values): trimmed, lower-cased, one per choice
// picked, one per part of a name or address ("name.first").
export const normValue = (v: string | number | boolean) => String(v).normalize('NFC').trim().toLowerCase().slice(0, 200);
export function valueRows(answers: StoredAnswer[]): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const a of answers) {
    const v = a.value;
    if (v === null || v === '') continue;
    if (Array.isArray(v)) for (const o of v) rows.push({ key: a.key, value: normValue(o) });
    else if (typeof v === 'object') { for (const [p, s] of Object.entries(v)) if (s) rows.push({ key: `${a.key}.${p}`, value: normValue(s) }); }
    else rows.push({ key: a.key, value: normValue(v) });
  }
  return rows;
}
