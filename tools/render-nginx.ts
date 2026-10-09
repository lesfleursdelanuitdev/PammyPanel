// Renders a site's nginx files from its profile (docs/adapters-plan.md A4) into a folder:
//   <out>/site/panel.conf     -> /etc/nginx/sites-available/<profile.nginx.panel>
//   <out>/panel/*             -> <profile.nginx.panelDir>/
//   <out>/gate/*              -> <profile.nginx.gateDir>/
// The installer runs it from the release; the nginx tests run it too.
//
//   node tools/render-nginx.ts <out> [--site pammy|lfdln] [--cloudflare-ips deploy/cloudflare-ips.txt]
//        [--extra-range 127.0.0.1/32 ...] [--profile <module exporting PROFILE>]
// --site: that site's profile and files (pammy.org's when not given); --profile, for the
// tests: another profile, with the site's files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderNginx, type NginxFile } from '@panel/core/nginx';
import type { SiteProfile } from '@panel/core/profile';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) { console.error('usage: render-nginx.ts <out> [--site name] [--cloudflare-ips file] [--extra-range cidr]... [--profile module]'); process.exit(2); }
const opts = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const site = opts('--site')[0] ?? 'pammy';
if (!['pammy', 'lfdln'].includes(site)) { console.error(`render-nginx.ts: no site "${site}"`); process.exit(2); }
const { NGINX_FILES } = await import(`@panel/${site}/nginx`) as { NGINX_FILES: NginxFile[] };
const profileModule = opts('--profile')[0];
const profile = profileModule
  ? (await import(resolve(profileModule)) as { PROFILE: SiteProfile }).PROFILE
  : (await import(`@panel/${site}/profile`) as { PROFILE: SiteProfile }).PROFILE;
const ipsFile = opts('--cloudflare-ips')[0] ?? join(import.meta.dirname, '..', 'deploy', 'cloudflare-ips.txt');
const cloudflare = profile.front === 'cloudflare' ? { text: readFileSync(ipsFile, 'utf8'), extra: opts('--extra-range') } : undefined;

for (const [path, text] of renderNginx(profile, NGINX_FILES, cloudflare)) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), text);
  console.log(path);
}
