// Settings > Visitors (docs/accounts-plan.md A5): what visitors may do for
// themselves. Every switch is off until the panel's owners turn it on; the gate
// keeps them (gate.visitor_settings) and checks every change, and each change is
// in Activity.
import type { FastifyInstance } from 'fastify';
import { logActivity } from '@panel/core/accounts';
import { isOn } from '@panel/core/profile';
import type { PanelCtx } from '@panel/core/panel/context';
import { SWITCHES, type SettingsState, type Switch } from '@panel/core/gate/visitor-settings';
import { SWITCH_WORDS, whyNot } from '@panel/people/shared/visitor-switches';

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, actorOf, gate, mailer, config } = ctx;

  // Whether this panel can send visitors mail: the mail module on, and its service
  // answering that it's set up. The gate adds whether it has its own door to the
  // mail service (gateMail, docs/accounts-plan.md step 4), which only it can tell.
  const mailReady = async () => isOn(config.site, 'mail')
    && (await mailer<{ ready: boolean }>({ op: 'status' }).then((s) => s.ready === true, () => false));

  const view = (st: SettingsState & { gateMail?: boolean }, panelMail: boolean) => {
    const mail = panelMail && st.gateMail !== false;
    return {
    switches: SWITCHES.map((key) => ({
      key, label: SWITCH_WORDS[key], on: st.switches[key],
      // why it can't be turned on now (null: it can, or it's on)
      blocked: st.switches[key] ? null : whyNot(key, st.switches, { mail }),
    })),
    changedBy: st.changedBy, changedAt: st.changedAt,
    };
  };

  app.get('/api/visitor-settings', { config: { needs: 'visitor-settings' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const [st, mail] = await Promise.all([gate<SettingsState>({ op: 'visitor-settings.get' }), mailReady()]);
    return view(st, mail);
  });

  app.post('/api/visitor-settings', { config: { needs: 'visitor-settings' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const b = body(req);
    const mail = await mailReady();
    const r = await gate<SettingsState & { alsoOff: Switch[]; changed: boolean }>({ op: 'visitor-settings.set', key: b.key, on: b.on, mail, actor: a.user.username });
    if (r.changed) {
      const key = b.key as Switch;
      await logActivity(db, now(), actorOf(a, req), b.on === true ? 'visitor-setting-on' : 'visitor-setting-off', SWITCH_WORDS[key],
        r.alsoOff.length ? `also turned off: ${r.alsoOff.map((k) => SWITCH_WORDS[k]).join(', ')}` : null);
    }
    return { ...view(r, mail), alsoOff: r.alsoOff };
  });
}
