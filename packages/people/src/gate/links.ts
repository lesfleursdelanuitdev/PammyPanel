// One-time links (gate.links; docs/k-a-plan.md K-a4, moved from core's gate/store.ts): the
// owner's setup links (choose your password) and the emailed ones (confirm an address,
// reset a password, a new address). Only a link's hash is kept.
import { one, run, tx, type Db } from '@panel/core/pg';
import { hashToken, looksLikeToken, newToken } from '@panel/core/util';
import { hashPassword } from '@panel/core/security';
import { GateError } from '@panel/core/gate/ops';
import { areaById } from '@panel/core/gate/store';
import type { Area, Visitor } from '@panel/core/gate/types';
import { passwordProblem } from './accounts-store.ts';
import type { ResetRequests } from './reset-requests.ts';
import { createVisitorSession, revokeVisitorSessions } from './sessions.ts';
import { needVisitor, visitorById } from './visitors.ts';

export const LINK_LIFETIME = 7 * 24 * 3600;
// What a one-time link is for (docs/accounts-plan.md, areas/0001): each has its
// own lifetime (A6), and a new link cancels only the old one of the same purpose.
// setup: the owner's (choose your password); confirm, reset and email-change are
// emailed to the person (accounts step 4).
export type LinkPurpose = 'setup' | 'confirm' | 'reset' | 'email-change';
export const LINK_LIFETIMES: Readonly<Record<LinkPurpose, number>> = {
  setup: LINK_LIFETIME, confirm: 24 * 3600, reset: 3600, 'email-change': 24 * 3600,
};

export type Link = {
  id: number; token_hash: string; visitor_id: number; area_id: number | null;
  created_at: number; expires_at: number; used_at: number | null; cancelled_at: number | null;
  purpose: LinkPurpose; new_email: string | null;
};

export const cancelLinks = (db: Db, now: number, visitorId: number) =>
  run(db, 'UPDATE links SET cancelled_at = ? WHERE visitor_id = ? AND used_at IS NULL AND cancelled_at IS NULL', now, visitorId);

export const openLink = (db: Db, now: number, visitorId: number) =>
  one<Link>(db, "SELECT * FROM links WHERE visitor_id = ? AND purpose = 'setup' AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1", visitorId, now);

// One live link per person: a new one cancels the old. areaId is where it
// leads afterwards (and whose login-invite.html it opens), if anywhere.
export async function createLink(db: Db, now: number, visitorId: unknown, areaId: unknown): Promise<{ token: string; link: Link; visitor: Visitor; area: Area | null }> {
  const token = newToken();
  return tx(db, async (q) => {
    const v = await needVisitor(q, visitorId);
    if (!v.active) throw new GateError('invalid', `${v.username} is switched off. Switch them on first.`);
    let area: Area | null = null;
    if (areaId !== undefined && areaId !== null) {
      area = (typeof areaId === 'number' ? await areaById(q, areaId) : undefined) ?? null;
      if (!area) throw new GateError('not-found', 'That protected folder no longer exists.');
    }
    await run(q, "UPDATE links SET cancelled_at = ? WHERE visitor_id = ? AND purpose = 'setup' AND used_at IS NULL AND cancelled_at IS NULL", now, v.id);
    const link = (await one<Link>(q, "INSERT INTO links (token_hash, visitor_id, area_id, created_at, expires_at, purpose) VALUES (?, ?, ?, ?, ?, 'setup') RETURNING *",
      hashToken(token), v.id, area?.id ?? null, now, now + LINK_LIFETIMES.setup))!;
    return { token, link, visitor: v, area };
  });
}

// A link that still works: one of these purposes, unused, not cancelled, not
// expired, for someone switched on. A link made for anything else does nothing.
export async function liveLink(db: Db, now: number, token: unknown, purposes: readonly LinkPurpose[]): Promise<{ link: Link; visitor: Visitor } | null> {
  if (!looksLikeToken(token)) return null;
  const link = await one<Link>(db, 'SELECT * FROM links WHERE token_hash = ?', hashToken(token));
  if (!link || !purposes.includes(link.purpose) || link.used_at || link.cancelled_at || link.expires_at <= now) return null;
  const visitor = await visitorById(db, link.visitor_id);
  return visitor && visitor.active ? { link, visitor } : null;
}

// A setup link that still works. Only a setup link chooses a password on the invite page.
export const linkForToken = (db: Db, now: number, token: unknown) => liveLink(db, now, token, ['setup']);

// Choosing a password with a link: the link is used up, any other link and
// every existing session end, open "forgot password" requests are closed (through
// requests' socket, KA-Q2), and they're signed in on this hostname.
export async function useLink(db: Db, now: number, token: unknown, password: unknown, host: string, ip: string | null, resets: ResetRequests):
  Promise<{ visitor: Visitor; area: Area | null; session: string } | null> {
  if (!await linkForToken(db, now, token)) return null;
  const problem = passwordProblem(password);
  if (problem) throw new GateError('invalid', problem);
  const hash = await hashPassword(password as string);
  return tx(db, async (q) => {
    const found = await linkForToken(q, now, token);      // again: another tab may have used it meanwhile
    if (!found) return null;
    const { link, visitor } = found;
    await run(q, 'UPDATE links SET used_at = ? WHERE id = ?', now, link.id);
    await cancelLinks(q, now, visitor.id);
    await run(q, 'UPDATE visitors SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, now, visitor.id);
    await revokeVisitorSessions(q, now, visitor.id);
    await resets.close(q, visitor.id, now);
    const area = link.area_id === null ? null : await areaById(q, link.area_id) ?? null;
    return { visitor: await needVisitor(q, visitor.id), area, session: await createVisitorSession(q, now, visitor.id, host, ip) };
  });
}

// A new emailed link of this purpose (A6: its own lifetime): the one made before
// for the same purpose stops working. Only its hash is kept; the token goes in the email.
export async function makeEmailedLink(db: Db, now: number, visitorId: number, purpose: Exclude<LinkPurpose, 'setup'>, newEmail: string | null = null): Promise<string> {
  const token = newToken();
  await tx(db, async (q) => {
    await run(q, 'UPDATE links SET cancelled_at = ? WHERE visitor_id = ? AND purpose = ? AND used_at IS NULL AND cancelled_at IS NULL', now, visitorId, purpose);
    await run(q, 'INSERT INTO links (token_hash, visitor_id, area_id, created_at, expires_at, purpose, new_email) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      hashToken(token), visitorId, now, now + LINK_LIFETIMES[purpose], purpose, purpose === 'email-change' ? newEmail : null);
  });
  return token;
}
