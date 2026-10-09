// Signing in and out, the setup links that make a first passkey, confirming
// with a passkey before something that matters, and My account.
//
// A passkey is the only way in (docs/pammy-panel-design): the ceremonies
// themselves are in src/panel/passkeys.ts.
import type { FastifyInstance } from 'fastify';
import { passkeys, sessionView } from '../passkeys.ts';
import { AccountError, deletePasskey, findLiveInvite, listPasskeys, logActivity } from '../../accounts.ts';
import { RECENT_AUTH } from '../../config.ts';
import { run, tx } from '../../pg.ts';
import { clientIp } from '../../security.ts';
import { clearedSessionCookie, startCeremony, takeCeremony } from '../../sessions.ts';
import { cleanDisplayName } from '../../util.ts';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import type { PanelCtx } from '../context.ts';
import { rightsOf } from '../rights.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, limited, body, idParam, actorOf, authOf } = ctx;
  const { registrationOptions, registerPasskey, checkAssertion, signIn, descriptors, liveSessions } = passkeys(ctx);

    // ---------------------------------------------------------------- sign in / out
    app.post('/api/login/options', { config: { needs: 'public' } }, async (req, reply) => {
      if (limited(req, reply, 'login-options', 30, 600)) return reply;
      const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required', timeout: 180_000 });
      return { ceremony: await startCeremony(db, now(), 'login', options.challenge), options };
    });

    app.post('/api/login/verify', { config: { needs: 'public' } }, async (req, reply) => {
      if (limited(req, reply, 'login-verify', 20, 900)) return reply;
      const b = body(req);
      const c = await takeCeremony(db, now(), b.ceremony, 'login');
      if (!c) return reply.code(400).send({ error: 'expired', message: 'That took too long. Please try again.' });
      const ok = await checkAssertion(c.challenge, b.response);
      if (!ok) {
        await logActivity(db, now(), { id: null, label: 'unknown', ip: clientIp(req) }, 'login-failed', null, 'passkey not accepted');
        return reply.code(401).send({ error: 'not-accepted', message: "That passkey wasn't accepted. If you've never set one up here, ask for a setup link." });
      }
      await signIn(reply, req, ok.user, ok.pk);
      await logActivity(db, now(), { id: ok.user.id, label: ok.user.username, ip: clientIp(req) }, 'login', null, ok.pk.name);
      return { ok: true };
    });

    app.post('/api/logout', { config: { needs: 'public' } }, async (req, reply) => {
      const a = await authOf(req);
      if (a) {
        await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), a.session.id);
        await logActivity(db, now(), actorOf(a, req), 'logout');
      }
      return reply.header('Set-Cookie', clearedSessionCookie()).send({ ok: true });
    });

    app.get('/api/session', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return {
        user: { id: a.user.id, username: a.user.username, displayName: a.user.display_name, role: a.user.role, rights: rightsOf(a.user), places: a.user.places },
        recentAuth: now() - a.session.auth_at < RECENT_AUTH,
      };
    });

    // ---------------------------------------------------------------- setup links
    // The token travels in the link's #fragment (never sent to servers or logs)
    // and is posted in the body, never put in a URL.
    async function inviteFrom(req: FastifyRequest, reply: FastifyReply) {
      const token = body(req).token;
      const found = typeof token === 'string' ? await findLiveInvite(db, now(), token) : null;
      if (!found) {
        void reply.code(404).send({ error: 'invite-invalid', message: 'This setup link has expired or has already been used. Ask your account manager for a new one.' });
      }
      return found;
    }

    app.post('/api/invite/info', { config: { needs: 'public' } }, async (req, reply) => {
      if (limited(req, reply, 'invite', 30, 600)) return reply;
      const found = await inviteFrom(req, reply);
      if (!found) return reply;
      return { username: found.user.username, displayName: found.user.display_name, passkeys: (await listPasskeys(db, found.user.id)).length };
    });

    app.post('/api/invite/options', { config: { needs: 'public' } }, async (req, reply) => {
      if (limited(req, reply, 'invite', 30, 600)) return reply;
      const found = await inviteFrom(req, reply);
      if (!found) return reply;
      const options = await registrationOptions(found.user);
      return { ceremony: await startCeremony(db, now(), 'invite', options.challenge, { userId: found.user.id, inviteId: found.invite.id }), options };
    });

    app.post('/api/invite/verify', { config: { needs: 'public' } }, async (req, reply) => {
      if (limited(req, reply, 'invite', 30, 600)) return reply;
      const b = body(req);
      const c = await takeCeremony(db, now(), b.ceremony, 'invite');
      const found = await inviteFrom(req, reply);
      if (!found) return reply;
      if (!c || c.invite_id !== found.invite.id) {
        return reply.code(400).send({ error: 'expired', message: 'That took too long. Please try again.' });
      }
      // The passkey and the link's use go in together: a link used or cancelled
      // meanwhile leaves no passkey behind.
      const actor = { id: found.user.id, label: found.user.username, ip: clientIp(req) };
      const pk = await tx(db, async (q) => {
        const added = await registerPasskey(found.user, c.challenge, b.response, b.name, q);
        if (await run(q, 'UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL', now(), found.invite.id) !== 1) {
          throw new AccountError('This setup link was just used or cancelled.', 409);
        }
        await logActivity(q, now(), actor, 'invite-used', found.user.username);
        await logActivity(q, now(), actor, 'passkey-added', found.user.username, added.name);
        return added;
      });
      await signIn(reply, req, found.user, pk);
      return { ok: true };
    });

    // ---------------------------------------------------------------- confirm with passkey
    app.post('/api/reauth/options', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (limited(req, reply, 'reauth', 30, 600)) return reply;
      const options = await generateAuthenticationOptions({
        rpID: config.rpID, userVerification: 'required', timeout: 180_000, allowCredentials: await descriptors(a.user),
      });
      return { ceremony: await startCeremony(db, now(), 'reauth', options.challenge, { userId: a.user.id, sessionId: a.session.id }), options };
    });

    app.post('/api/reauth/verify', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (limited(req, reply, 'reauth', 30, 600)) return reply;
      const b = body(req);
      const c = await takeCeremony(db, now(), b.ceremony, 'reauth');
      if (!c || c.session_id !== a.session.id) return reply.code(400).send({ error: 'expired', message: 'That took too long. Please try again.' });
      const ok = await checkAssertion(c.challenge, b.response);
      if (!ok || ok.user.id !== a.user.id) {
        await logActivity(db, now(), actorOf(a, req), 'confirm-failed', null, 'passkey not accepted');
        return reply.code(401).send({ error: 'not-accepted', message: "That passkey wasn't accepted." });
      }
      await run(db, 'UPDATE sessions SET auth_at = ? WHERE id = ?', now(), a.session.id);
      return { ok: true };
    });

    // ---------------------------------------------------------------- my account
    app.get('/api/me/passkeys', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return {
        passkeys: (await listPasskeys(db, a.user.id)).map((pk) => ({
          id: pk.id, name: pk.name, createdAt: pk.created_at, lastUsedAt: pk.last_used_at,
          synced: pk.backed_up === 1, thisSession: pk.id === a.session.passkey_id,
        })),
      };
    });

    app.post('/api/me/passkeys/options', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const options = await registrationOptions(a.user);
      return { ceremony: await startCeremony(db, now(), 'add-passkey', options.challenge, { userId: a.user.id, sessionId: a.session.id }), options };
    });

    app.post('/api/me/passkeys/verify', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const b = body(req);
      const c = await takeCeremony(db, now(), b.ceremony, 'add-passkey');
      if (!c || c.session_id !== a.session.id) return reply.code(400).send({ error: 'expired', message: 'That took too long. Please try again.' });
      const pk = await registerPasskey(a.user, c.challenge, b.response, b.name);
      await logActivity(db, now(), actorOf(a, req), 'passkey-added', a.user.username, pk.name);
      return { ok: true, id: pk.id };
    });

    app.post('/api/me/passkeys/:id/rename', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const name = cleanDisplayName(body(req).name);
      if (!name) throw new AccountError('Please give the passkey a name (1-60 characters).');
      if (!await run(db, 'UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?', name, idParam(req, 'id'), a.user.id)) throw new AccountError('That passkey no longer exists.', 404);
      await logActivity(db, now(), actorOf(a, req), 'passkey-renamed', a.user.username, name);
      return { ok: true };
    });

    app.post('/api/me/passkeys/:id/delete', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = idParam(req, 'id');
      await deletePasskey(db, now(), actorOf(a, req), a.user, id, false);
      return { ok: true, signedOut: id === a.session.passkey_id };
    });

    app.get('/api/me/sessions', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return { sessions: (await liveSessions(a.user.id)).map((s) => sessionView(s, a.session.id)) };
    });

    app.post('/api/me/sessions/:id/revoke', { config: { needs: 'signed-in' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      if (!await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), idParam(req, 'id'), a.user.id)) throw new AccountError('That session has already ended.', 404);
      await logActivity(db, now(), actorOf(a, req), 'session-revoked', a.user.username);
      return { ok: true };
    });



}
