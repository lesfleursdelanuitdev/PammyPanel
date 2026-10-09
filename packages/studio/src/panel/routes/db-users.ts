// Database logins (docs/databases-plan.md 9): logins on ONE engine, for
// programs that speak SQL -- her app on :3042, a backup job, a client on her
// laptop. Not panel accounts and not API keys.
//
// The engine is the source of truth for both the logins and their access: the
// roles are read back from the real GRANTs, never from anything the panel wrote
// down. All the panel keeps is the note beside a login.
import type { FastifyInstance } from 'fastify';
import { studioFor } from '../studio.ts';
import { AccountError, logActivity } from '@panel/core/accounts';
import { ENGINE_NAMES, type Engine, NAME_RE, isEngine, newUserProblem } from '../../pammydb/ident.ts';
import { type UserList } from '../../pammydb/ops.ts';
import { type Access, ROLE_NAMES, isAccessRole } from '../../pammydb/roles.ts';
import { tx } from '@panel/core/pg';
import { type Authed } from '@panel/core/sessions';
import { type UserCard, forgetUser, listKnownUsers, mergeUsers, newDbPassword, rememberUser, roleLabel, setUserNote, withLabels } from '../../studio/users.ts';
import { type FastifyRequest } from 'fastify';
import type { StudioCtx } from '../studio-ctx.ts';

export function routes(app: FastifyInstance, ctx: StudioCtx) {
  const { config, db, now, need, body, actorOf, studio, engineParam, dbNameParam } = ctx;
  const { dashboard, cardFor } = studioFor(ctx);

    // ---------------------------------------------------------------- database users
    // Logins on ONE engine, for programs that speak SQL: her app on :3042, a
    // backup job, a client on her laptop (docs/databases-plan.md 9). Not panel
    // accounts and not API keys -- a manager passkey grants nothing here, and
    // Read & write on a database lets a program change rows whether or not the
    // generated API is switched on. That is the point of the distinction.
    //
    // The engine is the source of truth for both the logins and their access: the
    // roles are read back from the real GRANTs, never from anything the panel
    // wrote down. All the panel keeps is the note beside a login.
    const dbUserParam = (req: FastifyRequest): string => {
      const v = (req.params as { user?: string }).user;
      if (typeof v !== 'string' || !NAME_RE.test(v)) throw new AccountError('Not found.', 404);
      return v;
    };
    const noteOf = (v: unknown): string => {
      if (v === undefined) return '';
      if (typeof v !== 'string') throw new AccountError('Please type a note, or leave it empty.', 400);
      const s = v.trim().replace(/\s+/g, ' ');
      if (s.length > 200) throw new AccountError('Notes can be at most 200 characters.', 400);
      return s;
    };
    // The databases a login can be granted on: the ones really there, minus the
    // engine's own machinery. Her `pamela` database is in -- it is where her work
    // already is -- whether or not the panel looks after it.
    const grantableDatabases = async (a: Authed, engine: Engine) =>
      (await dashboard(a)).databases.filter((d) => d.engine === engine && d.live === true && !d.system);

    const userList = async () => {
      const [live, known] = await Promise.all([
        studio<UserList>({ op: 'list-users' }),
        listKnownUsers(db),
      ]);
      return { users: mergeUsers(live.users, known, live.engines), engines: live.engines };
    };
    const userCardFor = async (engine: Engine, name: string): Promise<UserCard> => {
      const card = (await userList()).users.find((u) => u.engine === engine && u.name === name);
      if (!card) throw new AccountError('Not found.', 404);
      return card;
    };

    app.get('/api/databases/users', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      return userList();
    });

    // A new login is born reaching nothing at all: she grants it a database
    // afterwards. The password is generated here, shown once, and kept nowhere --
    // not in the panel's database, not in the log line, not in this reply twice.
    app.post('/api/databases/users', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const b = body(req);
      if (!isEngine(b.engine)) throw new AccountError('Please choose which kind of database.', 400);
      const problem = newUserProblem(b.name, b.engine, config.site.studioUserPrefix);
      if (problem) throw new AccountError(problem, 400);
      const name = b.name as string;
      const note = noteOf(b.note);
      const password = newDbPassword();
      await studio({ op: 'create-user', engine: b.engine, user: name, password, actor: a.user.username });
      await tx(db, (q) => rememberUser(q, { engine: b.engine as Engine, name, note, at: now() }));
      await logActivity(db, now(), actorOf(a, req), 'db-user-created', `${ENGINE_NAMES[b.engine]}: ${name}`,
        'it cannot reach any database until access is given');
      return { ok: true, user: await userCardFor(b.engine, name), password };
    });

    app.get('/api/databases/users/:engine/:user', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbUserParam(req);
      const [user, databases] = await Promise.all([userCardFor(engine, name), grantableDatabases(a, engine)]);
      if (user.live !== true) return { user, databases: [], access: [] };
      const { access } = await studio<{ access: Access[] }>({
        op: 'user-access', engine, user: name, databases: databases.map((d) => d.name),
      });
      return { user, databases, access: withLabels(access) };
    });

    app.post('/api/databases/users/:engine/:user/note', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbUserParam(req);
      await tx(db, (q) => setUserNote(q, engine, name, noteOf(body(req).note), now()));
      return { ok: true, user: await userCardFor(engine, name) };
    });

    // She cannot be shown the old one -- nothing kept it -- so this replaces it.
    // Anything still connecting with the old password stops working at once, which
    // is what the page says before she presses it.
    app.post('/api/databases/users/:engine/:user/password', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbUserParam(req);
      const password = newDbPassword();
      await studio({ op: 'reset-password', engine, user: name, password, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'db-user-password-reset', `${ENGINE_NAMES[engine]}: ${name}`,
        'anything using the old password has stopped working');
      return { ok: true, password };
    });

    app.post('/api/databases/users/:engine/:user/delete', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbUserParam(req);
      if (body(req).confirm !== name) throw new AccountError(`Type ${name} to confirm you want it removed.`, 400);
      await studio({ op: 'drop-user', engine, user: name, actor: a.user.username });
      await tx(db, (q) => forgetUser(q, engine, name));
      await logActivity(db, now(), actorOf(a, req), 'db-user-deleted', `${ENGINE_NAMES[engine]}: ${name}`,
        'the databases it could reach are untouched');
      return { ok: true };
    });

    // Grant, or take away with role `none`. Administrator asks for a passkey tap
    // just now, the other three do not: giving the recipes app Read & write is
    // ordinary, handing a login the run of a database is not
    // (docs/databases-plan.md 3, "Names, safety, passkeys").
    app.post('/api/databases/users/:engine/:user/access', { config: { needs: 'databases' } }, async (req, reply) => {
      const b = body(req);
      const a = await need(req, reply, { fresh: b.role === 'admin' });
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbUserParam(req);
      const database = typeof b.database === 'string' ? b.database : '';
      if (!NAME_RE.test(database)) throw new AccountError('Please choose a database.', 400);
      // the panel greys these out; the helper refuses them anyway (both ends)
      const card = (await grantableDatabases(a, engine)).find((d) => d.name === database);
      if (!card) throw new AccountError('Not found.', 404);

      if (b.role === 'none') {
        await studio({ op: 'revoke-access', engine, user: name, database, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'db-access-revoked', `${ENGINE_NAMES[engine]}: ${name}`,
          `it can no longer reach ${database}`);
      } else {
        if (!isAccessRole(b.role)) throw new AccountError('Please choose what it is allowed to do.', 400);
        await studio({ op: 'grant-access', engine, user: name, database, role: b.role, actor: a.user.username });
        await logActivity(db, now(), actorOf(a, req), 'db-access-granted', `${ENGINE_NAMES[engine]}: ${name}`,
          `${ROLE_NAMES[b.role]} on ${database}`);
      }
      const { access } = await studio<{ access: Access[] }>({
        op: 'user-access', engine, user: name, databases: (await grantableDatabases(a, engine)).map((d) => d.name),
      });
      return { ok: true, access: withLabels(access) };
    });

    // The same many-to-many from the other side: who can reach THIS database
    // (docs/databases-plan.md 9). Only logins on its own engine can, ever.
    app.get('/api/databases/:engine/:name/users', { config: { needs: 'databases' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const engine = engineParam(req);
      const name = dbNameParam(req);
      await cardFor(a, engine, name);          // 404s for a database that is not there
      const users = (await userList()).users.filter((u) => u.engine === engine && u.live === true && u.canLogin);
      const withAccess = await Promise.all(users.map(async (u) => {
        const { access } = await studio<{ access: Access[] }>({ op: 'user-access', engine, user: u.name, databases: [name] });
        return { user: u, role: access[0]?.role ?? null };
      }));
      return {
        users: withAccess
          .filter((r) => r.role !== null)
          .map((r) => ({ name: r.user.name, note: r.user.note, serverWide: r.user.serverWide, role: r.role!, roleName: roleLabel(r.role!) })),
        // logins on this engine with no access to it yet, for "Grant access"
        others: withAccess.filter((r) => r.role === null && !r.user.reserved).map((r) => r.user.name),
      };
    });


}
