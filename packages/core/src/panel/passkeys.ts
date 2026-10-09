// The passkey ceremonies (docs/pammy-panel-design): offering one, checking the
// answer, and starting a session with it. WebAuthn is the only way into the
// panel -- there is no password to guess, forget or reuse.
//
// Kept apart from the routes that use it (sign in, setup links, My account,
// Accounts) because it is the same four steps every time, and because the
// registration is the one place that writes a passkey down.
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AccountError, getUser, listPasskeys, type PasskeyRow, type UserRow } from '../accounts.ts';
import { all, one, run, type Db } from '../pg.ts';
import { clientIp } from '../security.ts';
import { cleanPasskeyName, describeUserAgent } from '../util.ts';
import { createSession, sessionCookie, type SessionRow } from '../sessions.ts';
import type { PanelCtx } from './context.ts';

// One signed-in device, as My account and Accounts show it.
export const sessionView = (s: SessionRow, currentId: number | null) => ({
  id: s.id, device: describeUserAgent(s.user_agent ?? undefined), ip: s.ip,
  createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === currentId,
});

// EdDSA, ES256, RS256: what every current platform authenticator offers.
export const ALGORITHMS = [-8, -7, -257];

export function passkeys(ctx: PanelCtx) {
  const { config, db, now } = ctx;

    const credentialOf = (pk: PasskeyRow) => ({
      id: pk.credential_id,
      publicKey: new Uint8Array(pk.public_key),
      counter: pk.counter,
      transports: pk.transports ? JSON.parse(pk.transports) as string[] : undefined,
    });
    const descriptors = async (user: UserRow) =>
      (await listPasskeys(db, user.id)).map((pk) => ({ id: pk.credential_id, transports: credentialOf(pk).transports }));

    async function registrationOptions(user: UserRow) {
      return generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: user.username,
        userID: Buffer.from(user.webauthn_user_id, 'base64url'),
        userDisplayName: user.display_name,
        attestationType: 'none',
        excludeCredentials: await descriptors(user),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: ALGORITHMS,
        timeout: 180_000,
      });
    }

    // Verifies a new passkey and stores it (with q: inside that transaction). Throws AccountError on any failure.
    async function registerPasskey(user: UserRow, challenge: string, response: unknown, name: unknown, q: Db = db): Promise<PasskeyRow> {
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
      } catch {
        throw new AccountError("The passkey couldn't be checked. Please try again.", 400);
      }
      if (!result.verified) throw new AccountError("The passkey couldn't be checked. Please try again.", 400);
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
      const t = now();
      // the same passkey registered twice (two tabs at once included): the database's unique key decides
      const pk = await one<PasskeyRow>(q, `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (credential_id) DO NOTHING RETURNING *`,
        user.id, credential.id, credential.publicKey, credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        credentialDeviceType, credentialBackedUp ? 1 : 0,
        cleanPasskeyName(name, `Passkey added ${new Date(t * 1000).toISOString().slice(0, 10)}`), t);
      if (!pk) throw new AccountError('That passkey is already registered.', 409);
      return pk;
    }

    // Checks a passkey assertion. Returns the passkey and its account, or null.
    async function checkAssertion(challenge: string, response: unknown): Promise<{ pk: PasskeyRow; user: UserRow } | null> {
      const r = response as AuthenticationResponseJSON;
      if (!r || typeof r.id !== 'string') return null;
      const pk = await one<PasskeyRow>(db, 'SELECT * FROM passkeys WHERE credential_id = ?', r.id);
      if (!pk) return null;
      const user = await getUser(db, pk.user_id);
      if (!user || !user.active) return null;
      const handle = r.response?.userHandle;
      if (handle && handle !== user.webauthn_user_id) return null;
      try {
        const v = await verifyAuthenticationResponse({
          response: r,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          credential: credentialOf(pk),
          requireUserVerification: true,
        });
        if (!v.verified) return null;
        await run(db, 'UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?',
          v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp ? 1 : 0, now(), pk.id);
        return { pk, user };
      } catch {
        return null;
      }
    }

    async function signIn(reply: FastifyReply, req: FastifyRequest, user: UserRow, pk: PasskeyRow) {
      const token = await createSession(db, now(), user.id, pk.id, clientIp(req), req.headers['user-agent'] ?? null);
      reply.header('Set-Cookie', sessionCookie(token));
    }


  // Who is signed in as this account, for My account and for Accounts.
  function liveSessions(userId: number): Promise<SessionRow[]> {
    return all<SessionRow>(db, `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?
                       ORDER BY last_seen_at DESC`, userId, now(), now() - 8 * 3600);
  }

  return { credentialOf, descriptors, registrationOptions, registerPasskey, checkAssertion, signIn, liveSessions };
}
