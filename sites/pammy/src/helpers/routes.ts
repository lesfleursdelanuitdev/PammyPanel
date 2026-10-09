// pammy-routes.service: the routing helper (docs/hosts-plan.md H7) for pammy.org's nginx
// (docs/phase8-plan.md 8-7): pammy.org's settings (the gate's snippets in every block that
// serves files, folder hosts, the whole website, the /api/ proxy, WordPress), no DNS zone to
// read (Cloudflare, kept by hand, with a * record), and the one hand-written file it takes
// over at the switch: the pamela site, with pammy-hosts linked in its place in the same nginx -t.
import { runRoutes } from '@panel/hosts/helper/main';
import { WITH_HOSTS } from '../nginx-hosts.ts';
import { hostsConfigOf } from '../hosts.ts';

runRoutes(WITH_HOSTS, process.env, undefined, undefined, undefined, { unit: 'pammy-routes', cfg: hostsConfigOf(WITH_HOSTS), zone: false, links: ['pamela'], ownLink: true });
