// Services (docs/adopt-plan.md V8, V9): the panel's side. What runs (TutorStar and
// the Gonsalves apps, taken in by the installer), how each part is, and Start,
// Stop and Restart -- for anyone with the services right, about the whole site
// (not for a person kept to hosts), each with a fresh passkey. The helper
// (lfdln-services) does it all; there is no delete (D2).
import type { FastifyInstance } from 'fastify';
import { AccountError, logActivity } from '@panel/core/accounts';
import { CallError } from '@panel/core/jsonline';
import { all } from '@panel/core/pg';
import { HELPER_STATUS, type PanelCtx } from '@panel/core/panel/context';
import { callServices } from '../../client.ts';
import type { ServiceStatus } from '../../helper/ops.ts';

const ACTIONS = { start: 'service-started', stop: 'service-stopped', restart: 'service-restarted' } as const;

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { config, db, now, need, body, actorOf } = ctx;
  const domain = config.site.domain;

  const helper = async <T>(req: Record<string, unknown>): Promise<T> => {
    if (!config.servicesSocket) throw new AccountError('This site has no services helper.', 503);
    try { return await callServices<T>(config.servicesSocket, req); } catch (e) {
      if (e instanceof CallError) throw new AccountError(e.message, HELPER_STATUS[e.code] ?? 500);
      throw e;
    }
  };
  // which hosts send visitors to each part (service routes, docs/adopt-plan.md V3)
  const shownAt = async () => {
    // (each host on its own domain: docs/domains-hosts-plan.md step 7)
    const rows = await all<{ name: string; domain: string | null; path: string; service: string; service_part: string; enabled: boolean; host_enabled: boolean }>(db,
      `SELECT h.name, d.name AS domain, r.path, r.target_ref->>'service' AS service, r.target_ref->>'part' AS service_part, r.enabled, h.enabled AS host_enabled
       FROM routes r JOIN hosts h ON h.id = r.host_id LEFT JOIN domains d ON d.id = h.domain_id WHERE r.target_kind = 'service' ORDER BY h.name, d.name, r.path`);
    const out = new Map<string, { address: string; live: boolean }[]>();
    for (const r of rows) {
      const k = `${r.service}/${r.service_part}`;
      out.set(k, [...(out.get(k) ?? []), { address: `https://${r.name === '@' ? '' : `${r.name}.`}${r.domain ?? domain}${r.path}`, live: r.enabled && r.host_enabled }]);
    }
    return out;
  };

  app.get('/api/services', { config: { needs: 'services', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const [{ services }, at] = await Promise.all([helper<{ services: ServiceStatus[] }>({ op: 'list' }), shownAt()]);
    return { services: services.map((s) => ({ ...s, parts: s.parts.map((p) => ({ ...p, shownAt: at.get(`${s.id}/${p.id}`) ?? [] })) })) };
  });

  app.get('/api/services/:id/logs', { config: { needs: 'services', wholeSite: true } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const part = (req.query as Record<string, unknown>).part;
    return helper({ op: 'logs', id: (req.params as { id: string }).id, part });
  });

  for (const [op, action] of Object.entries(ACTIONS)) {
    app.post(`/api/services/:id/${op}`, { config: { needs: 'services', wholeSite: true } }, async (req, reply) => {
      const a = await need(req, reply, { fresh: true });
      if (!a) return reply;
      const id = (req.params as { id: string }).id;
      const part = body(req).part ?? null;
      if (part !== null && typeof part !== 'string') throw new AccountError('Which part?', 400);
      const s = await helper<ServiceStatus>({ op, id, part, actor: a.user.username });
      const p = part ? s.parts.find((x) => x.id === part) : null;
      await logActivity(db, now(), actorOf(a, req), action, s.title, p ? p.title : null);
      return s;
    });
  }
}
