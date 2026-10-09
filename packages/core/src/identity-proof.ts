// The proof that an app's account headers came from nginx (docs/s1-plan.md, review S1).
// Apps behind a route with accounts are told who is signed in (X-Lfdln-Account, -Username,
// -Role, -Privileges), but they listen on 127.0.0.1, which every local user and every
// project container can reach, so the headers alone prove nothing. The gate signs what it
// answers nginx's check with, for the one app the route goes to, and nginx hands the
// signature on as X-Lfdln-Proof:
//
//   v1.<ms>.<base64url Ed25519 signature over message()>
//
// Ed25519, not a shared HMAC key: apps hold only the public key, so an app (a project's
// code, say) that can check proofs still can't make one for another app. The audience
// ("service.examprep.web", "project.<id>.<branch>") is the app the route sends to, so a
// proof one app was shown is no good at another; the host and the time bound it further.
// An app believes the headers only with a valid proof for its own audience; without one,
// whoever is asking is nobody (not even "Not signed in"'s privileges).
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const PROOF_VERSION = 'v1';
// how old a proof may be: the check is made when the request starts, and a large upload
// is read by nginx before the app is asked (as SIGNED_SKEW_MS in signed.ts)
export const PROOF_MAX_AGE_MS = 5 * 60_000;
// what may name an app: <kind>.<id>[.<part>]. Each part a DNS label (up to 63), so every id a
// module allows fits: a service's (32), a project's (36, projects/src/record.ts ID_RE), a part's
export const AUDIENCE_RE = /^[a-z]{1,16}(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,2}$/;

// what the gate tells the app, as the app reads it ("" for a header that isn't there)
export type Told = { account: string; username: string; role: string; privileges: string };

// The signed text: every part, in order, as JSON (no separator can be smuggled inside one).
export const message = (ts: string, audience: string, host: string, t: Told) =>
  JSON.stringify(['lfdln-identity', PROOF_VERSION, ts, audience, host.toLowerCase(), t.account, t.username, t.role, t.privileges]);

// The gate's private key (PEM, PKCS#8), or the app's public key: PEM, or the raw 32 bytes
// as base64url (what /etc/lfdln-panel/identity.pub holds).
export const privateKeyOf = (pem: string): KeyObject => {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('the identity key is not an Ed25519 key');
  return k;
};
export function publicKeyOf(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith('-----')) return createPublicKey(t);
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) throw new Error('the identity public key is not 32 bytes of base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: t }, format: 'jwk' });
}
export const rawPublicKey = (k: KeyObject) => String((k.type === 'private' ? createPublicKey(k) : k).export({ format: 'jwk' }).x);

export function makeProof(key: KeyObject, audience: string, host: string, t: Told, nowMs: number): string {
  if (!AUDIENCE_RE.test(audience)) throw new Error(`"${audience}" can't be a proof's audience`);
  const ts = String(nowMs);
  return `${PROOF_VERSION}.${ts}.${sign(null, Buffer.from(message(ts, audience, host, t)), key).toString('base64url')}`;
}

// Whether a proof is the gate's, for this audience, these headers and this host, and recent.
export function proofOk(key: KeyObject, proof: unknown, audience: string, host: string, t: Told, nowMs: number): boolean {
  if (typeof proof !== 'string') return false;
  const m = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{86})$/.exec(proof);
  if (!m) return false;
  if (Math.abs(nowMs - Number(m[1])) > PROOF_MAX_AGE_MS) return false;
  try {
    return verify(null, Buffer.from(message(m[1]!, audience, host, t)), key, Buffer.from(m[2]!, 'base64url'));
  } catch {
    return false;
  }
}
