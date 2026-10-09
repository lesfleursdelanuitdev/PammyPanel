// Calls to the panel API, and the passkey prompts.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// GET without a body, POST (JSON) with one.
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, { ...init, credentials: 'same-origin' });
  let data: any = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(data.message || `Request failed (${res.status})`, res.status, data.error);
  return data as T;
}

export const passkeysSupported = () => browserSupportsWebAuthn();

// The browser throws NotAllowedError both when you cancel and when it times out.
export function friendlyError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { name?: string } } | null;
  const name = e?.name === 'WebAuthnError' ? e.cause?.name : e?.name;
  if (name === 'NotAllowedError') return 'Cancelled, or the passkey prompt timed out. Try again when ready.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for this account.';
  return e?.message || 'Something went wrong.';
}

export async function signInWithPasskey() {
  const { ceremony, options } = await api('/api/login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  return api('/api/login/verify', { ceremony, response });
}

export async function confirmWithPasskey() {
  const { ceremony, options } = await api('/api/reauth/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  return api('/api/reauth/verify', { ceremony, response });
}

export async function createPasskey(optionsPath: string, verifyPath: string, extra: Record<string, unknown>) {
  const { ceremony, options } = await api(optionsPath, extra);
  const response = await startRegistration({ optionsJSON: options });
  return api(verifyPath, { ...extra, ceremony, response });
}

export function formatTime(unix: number | null | undefined): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Back to sign in, and here again afterwards.
export function signedOut() {
  const here = location.pathname + location.search + location.hash;
  location.replace(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
}

// "5 minutes ago", "yesterday", "3 days ago"; older than a week: the date.
export function timeAgo(unix: number | null | undefined, now = Date.now() / 1000): string {
  if (!unix) return 'never';
  const s = Math.round(unix - now);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(unix * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
