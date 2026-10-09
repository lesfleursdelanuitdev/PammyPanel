import { createHash, randomBytes } from 'node:crypto';

// Session, invite and ceremony tokens: 256 random bits handed to the browser,
// only their SHA-256 kept in the database. A copied panel.db holds nothing
// that logs anyone in.
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function looksLikeToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
}

// "1 table", "3 tables": the same as the web side's plural (web/src/lib/api.ts),
// for the sentences the server writes into the activity log.
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Usernames are also shown in the activity log and typed on the command line.
export const USERNAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function cleanDisplayName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length >= 1 && s.length <= 60 ? s : null;
}

export function cleanPasskeyName(v: unknown, fallback: string): string {
  return cleanDisplayName(v) ?? fallback;
}

export function describeUserAgent(ua: string | undefined): string {
  if (!ua) return 'Unknown browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown system';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${os}`;
}
