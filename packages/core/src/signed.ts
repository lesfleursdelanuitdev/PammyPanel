// Requests signed between a panel and a service on the same machine, with the service's
// own key (lfdln: /etc/lfdln-panel/hooks/<service>.key, which the app also holds).
//   v1 (docs/accounts-plan.md step 4b, "this account was deleted"): HMAC-SHA256 over
//      "<ms>.<body>", for one POST to one path.
//   v2 (docs/catalog-plan.md step 5, the catalog's list and the app's door): HMAC-SHA256
//      over "<ms>\n<METHOD>\n<path with its query>\n<body>", so a signed GET can't be
//      used for another address.
// Sent as X-Lfdln-Timestamp (milliseconds) and X-Lfdln-Signature ("v1=<hex>", "v2=<hex>").
import { createHmac, timingSafeEqual } from 'node:crypto';

export const sign = (key: string, ts: string, body: string) => 'v1=' + createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');

export const signRequest = (key: string, ts: string, method: string, path: string, body: string) =>
  'v2=' + createHmac('sha256', key).update(`${ts}\n${method.toUpperCase()}\n${path}\n${body}`).digest('hex');

// How far a signed request's clock may be from ours.
export const SIGNED_SKEW_MS = 5 * 60_000;

// Whether a v2 signature is this key's, for this request, and recent.
export function signedRequestOk(key: string, h: { ts: unknown; signature: unknown }, method: string, path: string, body: string, nowMs: number): boolean {
  if (typeof h.ts !== 'string' || !/^\d{10,16}$/.test(h.ts) || typeof h.signature !== 'string') return false;
  if (Math.abs(nowMs - Number(h.ts)) > SIGNED_SKEW_MS) return false;
  const want = Buffer.from(signRequest(key, h.ts, method, path, body));
  const got = Buffer.from(h.signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
