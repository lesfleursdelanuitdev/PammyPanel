// Git over HTTPS (docs/phase8b-plan.md 8b-7): the tokens (D7-2) and what nginx's auth_request
// is asking about (D7-4). Pure: the panel's route (panel/routes/git.ts) does the database.
import { createHash, randomBytes } from 'node:crypto';
import { isProjectId } from './record.ts';

export const TOKEN_PREFIX = 'lfdln_git_';
export const MAX_TOKENS = 10;
// D7-2: how long a new token lasts, in days (0: never); 90 unless chosen
export const TOKEN_DAYS = [30, 90, 365, 0] as const;
export const DEFAULT_TOKEN_DAYS = 90;

const TOKEN_RE = /^lfdln_git_([A-Za-z0-9_-]{43})$/;

export function newGitToken(): { token: string; hash: string; hint: string } {
  const raw = randomBytes(32).toString('base64url');
  return { token: TOKEN_PREFIX + raw, hash: hashGitToken(TOKEN_PREFIX + raw)!, hint: raw.slice(0, 4) };
}

// The token's SHA-256 (long and random, so a slow hash adds nothing); null if it isn't one
export function hashGitToken(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  return createHash('sha256').update(token).digest('base64url');
}

// git's "Authorization: Basic base64(user:token)"; null if it isn't that
export function basicCredentials(header: unknown): { user: string; token: string } | null {
  if (typeof header !== 'string' || header.length > 512) return null;
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header.trim());
  if (!m) return null;
  const text = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = text.indexOf(':');
  if (i <= 0) return null;
  return { user: text.slice(0, i), token: text.slice(i + 1) };
}

// What a request to git.<domain> is: the project and whether it pushes. Only git's smart HTTP
// paths: /<name>.git/info/refs?service=git-upload-pack|git-receive-pack,
// /<name>.git/git-upload-pack, /<name>.git/git-receive-pack (a push is receive-pack, D7-4).
// Anything else (the dumb protocol, HEAD, objects/...) is null: nginx sends no such request on.
export function gitRequest(uri: unknown): { project: string; push: boolean } | null {
  if (typeof uri !== 'string' || uri.length > 300) return null;
  const q = uri.indexOf('?');
  const path = q < 0 ? uri : uri.slice(0, q);
  const query = q < 0 ? '' : uri.slice(q + 1);
  const m = /^\/([a-z0-9-]{1,36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m || !isProjectId(m[1])) return null;
  const [, project, what] = m as unknown as [string, string, string];
  if (what !== 'info/refs') return { project, push: what === 'git-receive-pack' };
  const service = new URLSearchParams(query).get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null;
  return { project, push: service === 'git-receive-pack' };
}

// Failed checks per address (D7-4): 20 in 10 minutes, then refused until the window passes.
// Successes don't count, nor git's first ask without a token (it sends one after the 401), so
// a busy person never runs into it.
export class Failures {
  private seen = new Map<string, { count: number; until: number }>();
  private now: () => number;
  private max: number;
  private windowSec: number;
  constructor(now: () => number, max = 20, windowSec = 600) {
    this.now = now;
    this.max = max;
    this.windowSec = windowSec;
  }
  blocked(key: string): boolean {
    const f = this.seen.get(key);
    return !!f && f.until > this.now() && f.count >= this.max;
  }
  failed(key: string): void {
    const now = this.now();
    if (this.seen.size > 10_000) for (const [k, v] of this.seen) if (v.until <= now) this.seen.delete(k);
    const f = this.seen.get(key);
    if (!f || f.until <= now) this.seen.set(key, { count: 1, until: now + this.windowSec });
    else f.count++;
  }
}
