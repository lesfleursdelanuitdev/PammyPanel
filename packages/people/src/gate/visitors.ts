// The people who can sign in (gate.visitors; docs/k-a-plan.md K-a4, moved from core's
// gate/store.ts): what the owner does from the panel's People page, through the gate's
// admin socket, which re-checks everything.
import { one, run, tx, type Db } from '@panel/core/pg';
import { cleanDisplayName } from '@panel/core/util';
import { hashPassword } from '@panel/core/security';
import { cleanLine, GateError } from '@panel/core/gate/ops';
import type { Visitor } from '@panel/core/gate/types';
import { cleanVisitorName, passwordProblem } from './accounts-store.ts';
import { cancelLinks } from './links.ts';
import { revokeVisitorSessions } from './sessions.ts';

export type { Visitor } from '@panel/core/gate/types';

export const visitorById = async (db: Db, id: unknown) =>
  typeof id === 'number' ? one<Visitor>(db, 'SELECT * FROM visitors WHERE id = ?', id) : undefined;

export async function needVisitor(db: Db, id: unknown): Promise<Visitor> {
  const v = await visitorById(db, id);
  if (!v) throw new GateError('not-found', 'That person no longer exists.');
  return v;
}

// password null/undefined: they'll choose their own with a setup link, and
// can't sign in until they do.
export async function createVisitor(db: Db, now: number, username: unknown, name: unknown, password: unknown, contact?: unknown): Promise<Visitor> {
  const u = cleanVisitorName(username);
  if (!u) throw new GateError('invalid', 'Usernames are 2-64 characters: letters, digits and . _ @ + - (an email address works).');
  const pending = password === undefined || password === null;
  const problem = pending ? null : passwordProblem(password);
  if (problem) throw new GateError('invalid', problem);
  const n = name === undefined || name === '' ? '' : cleanDisplayName(name);
  if (n === null) throw new GateError('invalid', 'Names can be up to 60 characters.');
  const taken = () => new GateError('exists', `There is already someone called ${u}.`);
  if (await one(db, 'SELECT 1 FROM visitors WHERE username = ?', u)) throw taken();
  const hash = pending ? '' : await hashPassword(password as string);
  // someone else may have taken the name while the password was hashed
  const v = await one<Visitor>(db, `INSERT INTO visitors (username, name, password_hash, active, created_at, password_changed_at, contact) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT (username) DO NOTHING RETURNING *`, u, n, hash, now, now, cleanLine(contact, 120));
  if (!v) throw taken();
  return v;
}

export async function setVisitorContact(db: Db, id: unknown, contact: unknown): Promise<Visitor> {
  if (typeof contact !== 'string') {
    await needVisitor(db, id);
    throw new GateError('invalid', 'Expected a contact detail.');
  }
  const v = typeof id === 'number' ? await one<Visitor>(db, 'UPDATE visitors SET contact = ? WHERE id = ? RETURNING *', cleanLine(contact, 120), id) : undefined;
  if (!v) throw new GateError('not-found', 'That person no longer exists.');
  return v;
}

export async function setVisitorPassword(db: Db, now: number, id: unknown, password: unknown): Promise<Visitor> {
  const v = await needVisitor(db, id);
  const problem = passwordProblem(password);
  if (problem) throw new GateError('invalid', problem);
  const hash = await hashPassword(password as string);
  return tx(db, async (q) => {
    await needVisitor(q, v.id);
    await run(q, 'UPDATE visitors SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, now, v.id);
    await revokeVisitorSessions(q, now, v.id);
    await cancelLinks(q, now, v.id);
    return needVisitor(q, v.id);
  });
}

export async function setVisitorActive(db: Db, now: number, id: unknown, active: unknown): Promise<Visitor> {
  return tx(db, async (q) => {
    const v = await needVisitor(q, id);
    if (typeof active !== 'boolean') throw new GateError('invalid', 'Expected on or off.');
    await run(q, 'UPDATE visitors SET active = ? WHERE id = ?', active ? 1 : 0, v.id);
    if (!active) {
      await revokeVisitorSessions(q, now, v.id);
      await cancelLinks(q, now, v.id);     // switching back on doesn't revive an old link
    }
    return needVisitor(q, v.id);
  });
}

export async function renameVisitor(db: Db, id: unknown, name: unknown): Promise<Visitor> {
  const v = await needVisitor(db, id);
  const n = name === '' ? '' : cleanDisplayName(name);
  if (n === null) throw new GateError('invalid', 'Names can be up to 60 characters.');
  const r = await one<Visitor>(db, 'UPDATE visitors SET name = ? WHERE id = ? RETURNING *', n, v.id);
  if (!r) throw new GateError('not-found', 'That person no longer exists.');
  return r;
}

export async function deleteVisitor(db: Db, id: unknown): Promise<Visitor> {
  // cascades to memberships and sessions
  const v = typeof id === 'number' ? await one<Visitor>(db, 'DELETE FROM visitors WHERE id = ? RETURNING *', id) : undefined;
  if (!v) throw new GateError('not-found', 'That person no longer exists.');
  return v;
}
