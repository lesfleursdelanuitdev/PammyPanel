// pammy-apps.service (src/apps/main.ts): the software helper, for pammy.org.
import { runApps } from '@panel/apps/apps/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
// software as the whole website only while the pamela site is enabled: pammy.org on its
// hosts has it out (docs/phase8-plan.md 8-7d)
runApps(env.APPS_DOMAIN ?? PROFILE.domain, env.STATE_DIRECTORY ?? env.APPS_STATE ?? PROFILE.apps.state, env, { wholeSite: '/etc/nginx/sites-enabled/pamela' });
