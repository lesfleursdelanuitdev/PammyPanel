// The Email page (docs/apps-plan.md phase 3): how pammy sends mail and what the
// panel emails about. Account managers only.
//
// The key and the addresses are the software helper's to keep (root files it
// writes), and pammy-mail is what sends; the panel keeps only which notices are
// wanted, and passes the rest on. Changing how mail is sent asks for the passkey
// again (G2 mail-set); the key never comes back out, only its last four.
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { one, run } from '@panel/core/pg';
import type { PanelCtx } from '@panel/core/panel/context';

type FormLite = { id: number; name: string; title: string; kind: string; fixture: string | null; trashedAt: number | null; approvable: boolean };

const idList = (v: unknown, known: Set<number>, what: string): number[] => {
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => Number.isSafeInteger(x) && known.has(x))) {
    throw new AccountError(`Those ${what} aren't all there any more. Open the page again.`, 400);
  }
  return [...new Set(v as number[])];
};

// opts.sending: whether the key and addresses are set here, through the software helper
// (pammy.org); where they are the installer's (lfdln, docs/phase8-plan.md 8-5), only the
// notices and the test are this page's, and it says so
export function routes(app: FastifyInstance, ctx: PanelCtx, opts: { sending?: boolean } = {}) {
  const { db, now, need, body, actorOf, software, mailer, gate } = ctx;
  const sendingHere = opts.sending ?? true;
  // who may: the Installed software part where the site has it (pammy.org); admins only where it
  // doesn't (lfdln: that part can't be given there, docs/lfdln-mariadb-plan.md finding 11)
  const needs = ctx.config.site.modules.includes('apps') ? 'software' : 'admin';
  const forms = async () => (await gate<{ forms: FormLite[] }>({ op: 'forms.state' })).forms.filter((f) => !f.trashedAt && !f.fixture);

    app.get('/api/mail', { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      // each part may be missing on its own (a helper not answering): the page says which
      const [sending, sender, list] = await Promise.all([
        sendingHere ? software<Record<string, unknown>>({ op: 'mail-get', actor: a.user.username }).catch((e: Error) => ({ error: e.message })) : { installer: true },
        mailer<Record<string, unknown>>({ op: 'status' }).catch((e: Error) => ({ error: e.message })),
        forms().catch(() => [] as FormLite[]),
      ]);
      const row = await one<{ forms: string; comment_areas: string; requests: boolean; last_sent_at: number | null; last_problem: string | null; last_problem_at: number | null }>(db,
        'SELECT forms, comment_areas, requests, last_sent_at, last_problem, last_problem_at FROM mail_notices WHERE id = 1');
      return {
        sending, sender,
        notices: {
          forms: JSON.parse(row?.forms ?? '[]'), commentAreas: JSON.parse(row?.comment_areas ?? '[]'), requests: row?.requests ?? false,
          lastSentAt: row?.last_sent_at ?? null, lastProblem: row?.last_problem ?? null, lastProblemAt: row?.last_problem_at ?? null,
        },
        forms: list.map((f) => ({ id: f.id, title: f.title, name: f.name, kind: f.kind, approvable: f.approvable })),
      };
    });

    if (sendingHere) app.post('/api/mail/settings', { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const b = body(req);
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      const r = await software<{ keyEnds: string | null }>({ op: 'mail-set', key: key || undefined, from: b.from, replyTo: b.replyTo, notifyTo: b.notifyTo, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'mail-settings-changed', null, key ? `a new key, ending ${r.keyEnds}` : 'the addresses');
      return r;
    });

    app.post('/api/mail/notices', { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const b = body(req);
      const list = await forms();
      const f = idList(b.forms ?? [], new Set(list.filter((x) => x.kind !== 'comments').map((x) => x.id)), 'forms');
      const c = idList(b.commentAreas ?? [], new Set(list.filter((x) => x.kind === 'comments').map((x) => x.id)), 'comment areas');
      if (typeof (b.requests ?? false) !== 'boolean') throw new AccountError('Say yes or no to requests.', 400);
      await run(db, 'UPDATE mail_notices SET forms = ?, comment_areas = ?, requests = ?, changed_by = ?, changed_at = ? WHERE id = 1',
        JSON.stringify(f), JSON.stringify(c), b.requests === true, a.user.username, now());
      await logActivity(db, now(), actorOf(a, req), 'mail-notices-changed', null,
        [f.length && `${f.length} form${f.length === 1 ? '' : 's'}`, c.length && `${c.length} comment area${c.length === 1 ? '' : 's'}`, b.requests === true && 'access requests'].filter(Boolean).join(', ') || 'nothing');
      return { ok: true };
    });

    app.post('/api/mail/test', { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const r = await mailer<{ to: string }>({ op: 'test' });
      await logActivity(db, now(), actorOf(a, req), 'mail-test', r.to, 'from the panel');
      return r;
    });

    // through WordPress itself: its plugin, its SMTP (the software helper runs wp-cli)
    if (sendingHere) app.post('/api/software/:id/mail-test', { config: { needs } }, async (req, reply) => {
      const a = await need(req, reply);
      if (!a) return reply;
      const id = (req.params as { id?: string }).id;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) throw new AccountError('Not found.', 404);
      const r = await software<{ to: string }>({ op: 'mail-test', id, actor: a.user.username });
      await logActivity(db, now(), actorOf(a, req), 'mail-test', r.to, `from WordPress (${id})`);
      return r;
    });
}
