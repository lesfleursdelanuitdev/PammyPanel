// Keys programs use to read responses and media through the API.
import { randomBytes } from 'node:crypto';
import { all, one, run, tx, type Db } from '@panel/core/pg';
import { hashToken } from '@panel/core/util';
import { cleanBy, cleanLine, GateError, int } from '@panel/core/gate/ops';

export const API_KEY_RE = /^pammy_[A-Za-z0-9_-]{43}$/;
export const MAX_API_KEYS = 50;

// ------------------------------------------------------------------ API keys
// Made by an account manager (D20), shown once; only the SHA-256 is kept.
export type ApiKeyLevel = 'approved' | 'all';
type ApiKeyRow = {
  id: number; label: string; prefix: string; key_hash: string; level: ApiKeyLevel; forms: string; media: string;
  created_at: number; created_by: string | null; last_used_at: number | null; revoked_at: number | null; revoked_by: string | null;
};
// forms: null = every form, [] = none. media: null = no media folders, 'all', or scopes like '/olivia'.
export type ApiKey = { id: number; label: string; prefix: string; level: ApiKeyLevel; forms: number[] | null; media: 'all' | string[] | null; createdAt: number; createdBy: string | null; lastUsedAt: number | null; revokedAt: number | null; revokedBy: string | null };
const toKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id, label: r.label, prefix: r.prefix, level: r.level, forms: JSON.parse(r.forms) as number[] | null, media: JSON.parse(r.media ?? 'null') as ApiKey['media'],
  createdAt: r.created_at, createdBy: r.created_by, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by,
});

// What a key can be given is checked by the packages that own it (docs/packaging-plan.md
// step 1b): forms says whether a form exists, files whether a media folder is one.
export type KeyChecks = { form: (id: number) => Promise<unknown>; mediaFolder: (v: unknown) => string };

export async function createApiKey(db: Db, now: number, input: { label: unknown; level: unknown; forms: unknown; media?: unknown }, by: unknown, check: KeyChecks): Promise<{ key: string; apiKey: ApiKey }> {
  const label = cleanLine(input.label, 80);
  if (!label) throw new GateError('invalid', 'Give the key a name, like "Olivia\'s website".');
  if (input.level !== 'approved' && input.level !== 'all') throw new GateError('invalid', 'Choose what the key can read: approved responses only, or all responses.');
  let forms: number[] | null = null;
  // media folders it reads (docs/media-api-plan.md M6): none (the default), all, or a list
  let media: ApiKey['media'] = null;
  if (input.media === 'all') media = 'all';
  else if (Array.isArray(input.media) && input.media.length) media = [...new Set(input.media.map((m) => check.mediaFolder(m)))];
  else if (input.media !== undefined && input.media !== null && input.media !== 'none' && !(Array.isArray(input.media) && !input.media.length)) {
    throw new GateError('invalid', 'Choose the media folders the key can read: none, all, or some.');
  }
  if (input.forms === 'none') {
    if (media === null) throw new GateError('invalid', 'A key has to be able to read something: some forms, or some media folders.');
    forms = [];
  } else if (input.forms !== 'all') {
    if (!Array.isArray(input.forms) || input.forms.length === 0) throw new GateError('invalid', 'Choose the forms the key can read, or all forms.');
    forms = [...new Set(input.forms.map((f) => int(f) ?? -1))];
    for (const id of forms) await check.form(id);
  }
  if ((await one<{ n: number }>(db, 'SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL'))!.n >= MAX_API_KEYS) {
    throw new GateError('full', `There can be at most ${MAX_API_KEYS} keys. Revoke one you don't use first.`);
  }
  const key = `pammy_${randomBytes(32).toString('base64url')}`;
  const r = await one<ApiKeyRow>(db, 'INSERT INTO api_keys (label, prefix, key_hash, level, forms, media, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
    label, key.slice(0, 14), hashToken(key), input.level, JSON.stringify(forms), JSON.stringify(media), now, cleanBy(by));
  return { key, apiKey: toKey(r!) };
}

export async function revokeApiKey(db: Db, now: number, id: unknown, by: unknown): Promise<ApiKey> {
  return tx(db, async (q) => {
    const r = int(id) !== null ? await one<ApiKeyRow>(q, 'SELECT * FROM api_keys WHERE id = ?', id as number) : undefined;
    if (!r) throw new GateError('not-found', 'That key no longer exists.');
    if (r.revoked_at) throw new GateError('exists', 'That key was already revoked.');
    return toKey((await one<ApiKeyRow>(q, 'UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? RETURNING *', now, cleanBy(by), r.id))!);
  });
}

export const listApiKeys = async (db: Db) =>
  (await all<ApiKeyRow>(db, 'SELECT * FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC')).map(toKey);

// A live key for this token, or null. Notes when it was last used (at most once a minute).
export async function apiKeyFor(db: Db, now: number, token: string): Promise<ApiKey | null> {
  if (!API_KEY_RE.test(token)) return null;
  const r = await one<ApiKeyRow>(db, 'SELECT * FROM api_keys WHERE key_hash = ?', hashToken(token));
  if (!r || r.revoked_at) return null;
  if (!r.last_used_at || now - r.last_used_at >= 60) await run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, r.id);
  return toKey(r);
}
