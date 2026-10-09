// Accounts (admins only): who may sign in to the panel, their setup links, their
// passkeys, and what each one may use: the parts of the panel (rights) and the
// places they are kept to (docs/permissions-plan.md R4-R6).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { passkeys } from '../passkeys.ts';
import {
  AccountError, type UserRow, cancelInvites, cleanAccess, personOf, createInvite, createUser, deletePasskey, getUser, listPasskeys, setAccess, setActive, signOutEverywhere,
} from '../../accounts.ts';
import { all, one } from '../../pg.ts';
import { isOn } from '../../profile.ts';
import type { PanelCtx } from '../context.ts';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, body, idParam, actorOf, helper } = ctx;
  const { liveSessions } = passkeys(ctx);

    // ---------------------------------------------------------------- accounts (manager only)
    const target = async (req: FastifyRequest) => {
      const u = await getUser(db, idParam(req, 'id'));
      if (!u) throw new AccountError('That account no longer exists.', 404);
      return u;
    };

    app.get('/api/users', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const users = await all<UserRow>(db, 'SELECT * FROM users ORDER BY role, username');
      const out = [];
      for (const row of users) {
        const u = await personOf(db, row);
        const invite = await one<{ expires_at: number }>(db,
          'SELECT expires_at FROM invites WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1', u.id, now());
        const last = (await one<{ at: number | null }>(db, "SELECT max(at) AS at FROM activity WHERE actor_id = ? AND action IN ('login', 'invite-used')", u.id))!;
        out.push({
          id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active === 1, rights: u.rights, places: u.places,
          createdAt: u.created_at, lastLoginAt: last.at, isYou: u.id === a.user.id,
          passkeys: (await listPasskeys(db, u.id)).map((pk) => ({ id: pk.id, name: pk.name, createdAt: pk.created_at, lastUsedAt: pk.last_used_at })),
          sessions: u.active ? (await liveSessions(u.id)).length : 0,
          inviteExpiresAt: invite?.expires_at ?? null,
        });
      }
      return { users: out };
    });

    // What they may use, checked before anything is written: every place has to be
    // a folder at the top of the website that is there, or installed software (step 3b)
    // (one that isn't: nothing is made).
    async function accessOf(b: Record<string, unknown>, user: string) {
      const asked = cleanAccess(b.rights ?? [], b.places ?? []);
      // installed software's files (docs/catalog-plan.md step 3b): installed and not deleted,
      // on a site with installed software; the website places are checked below
      const soft = asked.places.filter((p) => !p.startsWith('/'));
      if (soft.length) {
        const there = isOn(config.site, 'apps')
          ? new Set((await ctx.software<{ apps: { id: string; setup: unknown; deleted: unknown }[] }>({ op: 'list', actor: user }))
            .apps.filter((x) => x.setup === null && x.deleted === null).map((x) => `software:${x.id}`))
          : new Set<string>();
        const missing = soft.filter((p) => !there.has(p));
        if (missing.length) throw new AccountError(`There's no installed software called ${missing.map((p) => p.slice('software:'.length)).join(', ')}.`, 404);
      }
      const access = { ...asked, places: asked.places.filter((p) => p.startsWith('/')) };
      // on a site with hosts (lfdln), a place is a host ("/tutor"), not a folder (docs/hosts-plan.md H9)
      if (access.places.length && isOn(config.site, 'hosts')) {
        // (the home domain's: another domain's hosts are the whole site's, docs/domains-hosts-plan.md step 7)
        const there = new Set((await all<{ name: string }>(db, 'SELECT name FROM hosts WHERE domain_id IS NULL OR domain_id = (SELECT id FROM domains WHERE home)')).map((h) => `/${h.name}`));
        const missing = access.places.filter((p) => !there.has(p));
        if (missing.length) throw new AccountError(`There's no host called ${missing.map((p) => p.slice(1)).join(', ')}.`, 404);
      } else if (access.places.length) {
        const sites = await helper<{ folders: { name: string; symlink?: boolean }[] }>({ op: 'list', actor: user });
        const there = new Set(sites.folders.filter((f) => !f.symlink).map((f) => `/${f.name}`));
        const missing = access.places.filter((p) => !there.has(p));
        if (missing.length) throw new AccountError(`There's no folder called ${missing.map((p) => p.slice(1)).join(', ')} at the top of the website.`, 404);
      }
      return asked;
    }

    app.post('/api/users', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const b = body(req);
      const access = await accessOf(b, a.user.username);
      const u = await createUser(db, now(), actorOf(a, req), b.username, b.displayName, 'member', access);
      return { ok: true, id: u.id };
    });

    app.post('/api/users/:id/access', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const u = await target(req);
      const access = await accessOf(body(req), a.user.username);
      return { ok: true, ...await setAccess(db, now(), actorOf(a, req), u, access) };
    });

    app.post('/api/users/:id/invite', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const { token, expiresAt } = await createInvite(db, now(), actorOf(a, req), await target(req));
      return { ok: true, link: `${config.origin}/invite#${token}`, expiresAt };
    });

    app.post('/api/users/:id/invite/cancel', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      return { ok: true, cancelled: await cancelInvites(db, now(), actorOf(a, req), await target(req)) };
    });

    app.post('/api/users/:id/disable', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      await setActive(db, now(), actorOf(a, req), await target(req), false);
      return { ok: true };
    });

    app.post('/api/users/:id/enable', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      await setActive(db, now(), actorOf(a, req), await target(req), true);
      return { ok: true };
    });

    app.post('/api/users/:id/signout', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const u = await target(req);
      return { ok: true, signedOut: await signOutEverywhere(db, now(), actorOf(a, req), u) };
    });

    app.post('/api/users/:id/passkeys/:pid/delete', { config: { needs: 'admin' } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const u = await target(req);
      // Removing someone else's last passkey is how a lost-device reset starts
      // (then send them a setup link); your own last one stays protected.
      await deletePasskey(db, now(), actorOf(a, req), u, idParam(req, 'pid'), u.id !== a.user.id);
      return { ok: true };
    });


}
