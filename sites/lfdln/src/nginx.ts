// The nginx files lfdln's installer writes for its panel (docs/adapters-plan.md A4),
// rendered from its profile by tools/render-nginx.ts. The hosts' own files are the
// routing helper's (docs/hosts-plan.md H7), not these.
import { appPath } from '@panel/core/paths';
import type { NginxFile } from '@panel/core/nginx';

export const NGINX_FILES: NginxFile[] = [
  { template: appPath('packages', 'core', 'nginx', 'panel.conf'), out: 'site/panel.conf' },
  // git over HTTPS for the projects (docs/phase8b-plan.md 8b-7): its own site, lfdln-git
  { template: appPath('packages', 'projects', 'nginx', 'git.conf'), out: 'site/git.conf', module: 'projects' },
];
