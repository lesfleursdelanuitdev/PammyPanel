import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

// No inline scripts anywhere, and no inline <style> elements except the page's
// own nonce'd ones, so the policy can be strict.
//
// `style-src-attr 'unsafe-inline'` is the one loosening, and it is deliberately
// the narrowest form of it. A nonce cannot cover a style ATTRIBUTE -- the spec
// has no way to nonce one -- so `style-src 'self' 'nonce-...'` blocks every
// `style="..."` on the page. That is not a theoretical corner: it silently
// stopped the upload progress bar moving (components/ui/progress.tsx sets
// transform) and collapsed the form preview's height, and the schema canvas
// positions every table that way, so it could not draw at all.
//
// What this does NOT do is let a <style> element in: those are still governed
// by `style-src`, which keeps 'self' plus the page's nonce. So an injected
// stylesheet is refused exactly as before; only attributes on elements the app
// itself renders are allowed. deploy/verify-panel.sh checks both halves,
// because a loosening that is wider than it says is worse than none.
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
};

// The panel's page: the same, plus the <style> elements carrying this page's
// nonce (the dialogs' scroll lock adds one while a dialog is open).
// Help pages frame the example sign-in pages from her website (09-protected-folders.txt, PART 9 to 11).
export function pagePolicy(nonce: string, domain: string): string {
  return POLICY.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`).replace("form-action", `frame-src https://${domain} 'self'; form-action`);
}

// nginx sets X-Real-IP after trusting CF-Connecting-IP from Cloudflare's ranges
// only. Believe the header only when the request really came from nginx: from this
// machine AND, once the site has an edge secret (docs/s1-plan.md S1c), carrying it in
// X-Lfdln-Edge. Without that, anyone on the machine could say they were any visitor
// (review S1). nginx sends it from a root-only include (<the panel's nginx folder>/edge.conf);
// this process has it from systemd (LoadCredential edge.secret). No secret: as before,
// any local caller is believed (an install that hasn't made one yet, the tests).
export const EDGE_HEADER = 'x-lfdln-edge';
let edge: { raw: string; digest: Buffer } | null = null;
export function useEdgeSecret(secret: string | null): void {
  const s = secret?.trim() ?? '';
  if (secret !== null && !/^[0-9a-f]{64}$/.test(s)) throw new Error('the edge secret is not 64 hex characters');
  edge = secret === null ? null : { raw: s, digest: createHash('sha256').update(s).digest() };
}
// systemd's LoadCredential edge.secret, or <PREFIX>_EDGE_SECRET_FILE when run by hand (set
// but empty: none). <PREFIX>_EDGE=off: none either -- the installer's hold on a first S1c
// install, until nginx sends it (deploy/edge-secret.sh). None: the old way. on: whether it
// was loaded; says: the line the service logs. One that is there but bad stops the process.
export function loadEdgeSecret(env: NodeJS.ProcessEnv, prefix: 'PANEL' | 'GATE'): { on: boolean; says: string } {
  const old = 'X-Real-IP believed from any local caller, as before S1c';
  if (env[`${prefix}_EDGE`] === 'off') {
    useEdgeSecret(null);
    return { on: false, says: `edge secret held off by the installer (${prefix}_EDGE=off, until nginx sends it): ${old}` };
  }
  const named = env[`${prefix}_EDGE_SECRET_FILE`];
  if (named === '') {
    useEdgeSecret(null);
    return { on: false, says: `${prefix}_EDGE_SECRET_FILE is empty, so no edge secret: ${old}` };
  }
  const file = named
    ?? (env.CREDENTIALS_DIRECTORY && existsSync(join(env.CREDENTIALS_DIRECTORY, 'edge.secret')) ? join(env.CREDENTIALS_DIRECTORY, 'edge.secret') : null);
  useEdgeSecret(file ? readFileSync(file, 'utf8') : null);
  return file
    ? { on: true, says: 'X-Real-IP believed only from nginx (edge secret loaded)' }
    : { on: false, says: `no edge secret: ${old}` };
}
// what this process adds to its own requests to the gate (the panel's tutorial examples)
export function edgeHeaders(): Record<string, string> {
  return edge ? { [EDGE_HEADER]: edge.raw } : {};
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// true: X-Real-IP is nginx's, believe it
export function fromNginx(req: FastifyRequest): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  if (!edge) return true;
  const sent = req.headers[EDGE_HEADER];
  return typeof sent === 'string' && timingSafeEqual(createHash('sha256').update(sent).digest(), edge.digest);
}
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? '';
  const real = req.headers['x-real-ip'];
  return fromNginx(req) && typeof real === 'string' && real.length <= 64 ? real : peer;
}

// Cross-site request forgery: every state change is a JSON POST from this exact
// origin. Browsers always send Origin on POST, and a form on another site can't
// send application/json without a CORS preflight, which this app never answers.
// Uploads are the one exception: raw bytes, with a header of our own (X-Pammy-Name),
// which another site can't send without a preflight either.
export function checkSameOrigin(req: FastifyRequest, reply: FastifyReply, origin: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const site = req.headers['sec-fetch-site'];
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
  const upload = ['/api/media/upload', '/api/files/upload'].includes(req.url.split('?')[0]!) && type === 'application/octet-stream' && typeof req.headers['x-pammy-name'] === 'string';
  const ok = req.headers.origin === origin
    && (site === undefined || site === 'same-origin')
    && (type === 'application/json' || upload);
  if (!ok) void reply.code(403).send({ error: 'forbidden', message: 'Request refused (wrong origin).' });
  return ok;
}

// Fixed-window counters in memory. Enough for one small panel behind Cloudflare;
// a restart forgets them, which only ever makes limits more lenient.
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  // true = allowed
  take(key: string, max: number, windowSec: number): boolean {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSec });
      return true;
    }
    h.count++;
    return h.count <= max;
  }
}

// Password hashing (docs/k-a-plan.md K-a4; moved from gate/passwords.ts): scrypt from
// node:crypto (no native modules), N=2^15, r=8, p=1, 32-byte key. Stored as
// scrypt$N$r$p$salt$hash so the cost can be raised later without breaking existing
// passwords. The kernel's (module-contracts-plan section 4): people's visitor passwords
// use it, and backends will too; which passwords are allowed is people's.
const N = 32768, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = stored.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
  if (!m) return false;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (n > 1 << 20 || r > 32 || p > 4) return false;
  const expected = Buffer.from(m[5]!, 'base64url');
  const key = await derive(password, Buffer.from(m[4]!, 'base64url'), n, r, p);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
