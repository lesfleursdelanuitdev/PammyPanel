// Git over HTTPS (docs/phase8b-plan.md 8b-7). A person's git tokens (D7-2): listed, made after a
// fresh passkey and shown once, revoked. And the check nginx's auth_request makes on
// git.<domain> for every request (D7-4): who the token is, whether they may read the project
// (the Projects part) or push to it (its owners or an admin, D3-1), answered with the username
// for git-http-backend's REMOTE_USER.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity, personOf, type UserRow } from '@panel/core/accounts';
import { all, one, run } from '@panel/core/pg';
import type { PanelCtx } from '@panel/core/panel/context';
import { isAdmin, mayUse } from '@panel/core/panel/rights';
import { clientIp } from '@panel/core/security';
import { basicCredentials, DEFAULT_TOKEN_DAYS, Failures, gitRequest, hashGitToken, MAX_TOKENS, newGitToken, TOKEN_DAYS } from '../../git-auth.ts';
import type { Project } from '../../record.ts';

type TokenRow = { id: number; label: string; hint: string; created_at: number; expires_at: number | null; last_used_at: number | null };

export function routes(app: FastifyInstance, ctx: PanelCtx, projects: () => Promise<Pick<Project, 'id' | 'owners'>[]>) {
  const { db, now, need, body, idParam, actorOf } = ctx;
  const failures = new Failures(now);

  app.get('/api/projects/git-tokens', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const rows = await all<TokenRow>(db, 'SELECT id, label, hint, created_at, expires_at, last_used_at FROM git_tokens WHERE user_id = ? ORDER BY id', a.user.id);
    return { tokens: rows.map((t) => ({ ...t, expired: t.expires_at !== null && t.expires_at <= now() })), max: MAX_TOKENS, days: TOKEN_DAYS, defaultDays: DEFAULT_TOKEN_DAYS, me: a.user.username };
  });

  app.post('/api/projects/git-tokens', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply, { fresh: true });
    if (!a) return reply;
    const b = body(req);
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (label.length < 1 || label.length > 60 || /[\p{Cc}]/u.test(label)) throw new AccountError('Give the token a name, up to 60 characters (like "my laptop").', 400);
    const days = b.days === undefined ? DEFAULT_TOKEN_DAYS : b.days;
    if (!(TOKEN_DAYS as readonly unknown[]).includes(days)) throw new AccountError('A token lasts 30 days, 90 days, a year, or until it is revoked.', 400);
    const had = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM git_tokens WHERE user_id = ?', a.user.id);
    if ((had?.n ?? 0) >= MAX_TOKENS) throw new AccountError(`You have ${MAX_TOKENS} tokens already: revoke one you don't use first.`, 400);
    const t = newGitToken();
    const at = now();
    const expires = days === 0 ? null : at + (days as number) * 86400;
    await run(db, 'INSERT INTO git_tokens (user_id, label, hash, hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', a.user.id, label, t.hash, t.hint, at, expires);
    await logActivity(db, at, actorOf(a, req), 'git-token-made', label, expires === null ? 'never expires' : `expires in ${days} days`);
    return { ok: true, token: t.token, user: a.user.username };
  });

  // your own; an admin can't see or revoke others' (turning the person off stops them all)
  app.post('/api/projects/git-tokens/:id/revoke', { config: { needs: 'projects', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const t = await one<TokenRow>(db, 'SELECT id, label FROM git_tokens WHERE id = ? AND user_id = ?', idParam(req, 'id'), a.user.id);
    if (!t) throw new AccountError('Not found.', 404);
    await run(db, 'DELETE FROM git_tokens WHERE id = ?', t.id);
    await logActivity(db, now(), actorOf(a, req), 'git-token-revoked', t.label, 'it stops working at once');
    return { ok: true };
  });

  // nginx's auth_request (D7-4): 204 with X-Lfdln-Git-User, 401 (no or wrong token: nginx asks
  // git for one), 403 (may not, or too many failures from this address: auth_request passes on
  // only 401 and 403, anything else is a 500). Reached through the git site only: the panel's
  // own site answers this path with 404.
  app.get('/api/projects/git-auth', { config: { needs: 'public' } }, async (req, reply) => {
    const ip = clientIp(req);
    if (failures.blocked(ip)) return reply.code(403).send();
    const fail = (code: 401 | 403) => { failures.failed(ip); return reply.code(code).send(); };
    const what = gitRequest(req.headers['x-original-uri']);
    if (!what) return fail(403);
    // git asks without a token first and sends it after the 401: that one isn't a failure
    if (req.headers.authorization === undefined) return reply.code(401).send();
    const cred = basicCredentials(req.headers.authorization);
    const hash = cred && hashGitToken(cred.token);
    if (!cred || !hash) return fail(401);
    const row = await one<UserRow & { token_id: number; expires_at: number | null; last_used_at: number | null }>(db,
      `SELECT u.*, t.id AS token_id, t.expires_at, t.last_used_at FROM git_tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?`, hash);
    const at = now();
    if (!row || row.username !== cred.user || row.active !== 1 || (row.expires_at !== null && row.expires_at <= at)) return fail(401);
    const person = await personOf(db, row);
    if (!mayUse(person, 'projects', true)) return fail(403);
    const p = (await projects()).find((x) => x.id === what.project);
    if (!p) return fail(403);
    if (what.push && !isAdmin(person) && !p.owners.includes(person.username)) return fail(403);
    // once a minute at most, so a clone's few requests write once
    if (row.last_used_at === null || at - row.last_used_at >= 60) await run(db, 'UPDATE git_tokens SET last_used_at = ? WHERE id = ?', at, row.token_id);
    return reply.code(204).header('X-Lfdln-Git-User', person.username).send();
  });
}
