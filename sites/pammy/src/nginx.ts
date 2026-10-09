// The nginx files pammy.org's installer writes (docs/adapters-plan.md A4), rendered
// from its profile by tools/render-nginx.ts. Each template is its module's.
import { appPath } from '@panel/core/paths';
import type { NginxFile } from '@panel/core/nginx';

export const NGINX_FILES: NginxFile[] = [
  { template: appPath('packages', 'core', 'nginx', 'panel.conf'), out: 'site/panel.conf' },
  { template: appPath('packages', 'core', 'nginx', 'gate.conf'), out: 'gate/gate.conf' },
  { template: appPath('packages', 'core', 'nginx', 'uri.conf'), out: 'gate/uri.conf' },
  { template: appPath('packages', 'php', 'nginx', 'php.conf'), out: 'gate/php.conf', module: 'php' },
  { template: appPath('packages', 'examples', 'nginx', 'tutorial-examples.conf'), out: 'panel/tutorial-examples.conf', module: 'examples' },
];
