// Who pammy's mail comes from and goes to (docs/apps-plan.md M1-M3), in
// /etc/pammy-mail/settings.json (root 644: nothing secret in it). Written only
// by the software helper (src/apps/mail.ts), read by pammy-mail and the helper.
// The key is not in here: /etc/pammy-mail/resend.key, root 600.
import { readFileSync } from 'node:fs';

// What they start as is the site's (its profile's mail).
export type MailSettings = {
  from: string;          // who the emails are from
  replyTo: string;       // where replies go
  notifyTo: string;      // where the panel's notices go
};

// One plain address: no names, no lists, no line breaks -- what goes into a
// header is only ever this.
export const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// A Resend key: re_ and letters, digits, underscores
export const KEY_RE = /^re_[A-Za-z0-9_]{16,120}$/;

export class MailError extends Error {
  code: 'invalid' | 'not-set-up' | 'refused' | 'full' | 'unavailable' | 'internal';
  constructor(code: MailError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function checkSettings(v: unknown): MailSettings {
  const s = v as Partial<Record<keyof MailSettings, unknown>> | null;
  const bad = (what: string) => new MailError('invalid', `The mail settings are not right (${what}).`);
  if (!s || typeof s !== 'object') throw bad('not an object');
  for (const k of ['from', 'replyTo', 'notifyTo'] as const) {
    if (typeof s[k] !== 'string' || !ADDRESS_RE.test(s[k] as string)) throw bad(k);
  }
  return { from: s.from as string, replyTo: s.replyTo as string, notifyTo: s.notifyTo as string };
}

export function readSettings(file: string): MailSettings | null {
  try { return checkSettings(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}

export function readKey(file: string): string | null {
  try {
    const k = readFileSync(file, 'utf8').trim();
    return KEY_RE.test(k) ? k : null;
  } catch { return null; }
}
