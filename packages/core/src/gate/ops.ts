// The gate-op kit (docs/k-a-plan.md K-a1; docs/module-dependency-graph.md section 3): what
// every gate op uses, whichever module it belongs to -- the errors the gate answers with,
// the cleaning of what people type, and the gate's event log. It stays in the kernel when
// the gate's store splits into areas, people and requests (K-a): ten modules use only this.
import { run, type Db } from '../pg.ts';

export class GateError extends Error {
  code: 'invalid' | 'exists' | 'not-found' | 'closed' | 'full' | 'stale' | 'unavailable';
  field?: string;           // the form field the answer is about
  constructor(code: GateError['code'], message: string, field?: string) {
    super(message);
    this.code = code;
    if (field) this.field = field;
  }
}

// What visitors type into the public forms, and Pamela's notes: no control
// characters (messages keep their line breaks), trimmed, capped.
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return [...v.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

// A whole number from a request, or null.
export const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
// Who did something, as the panel names them.
export const cleanBy = (by: unknown) => cleanLine(by, 40) || null;

export function cleanMessage(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ')
    .split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return [...s].slice(0, max).join('');
}

// The gate's event log (gate.events): sign-ins, requests, form and comment sends.
export async function logEvent(db: Db, now: number, event: string, e: { visitorId?: number | null; username?: string | null; areaId?: number | null; host?: string; ip?: string | null }) {
  await run(db, 'INSERT INTO events (at, visitor_id, username, area_id, event, host, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now, e.visitorId ?? null, e.username?.slice(0, 80) ?? null, e.areaId ?? null, event, e.host ?? null, e.ip ?? null);
}

// The event log's part of the gate's hourly clean-up (docs/k-a-plan.md KA-Q1: gate.events is
// the kernel's, with logEvent): events older than 180 days.
export async function eventsHousekeeping(db: Db, now: number) {
  await run(db, 'DELETE FROM events WHERE at <= ?', now - 180 * 86400);
}
