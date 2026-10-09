// For test/run-hosts-nginx-test.sh: renders the hosts' nginx files (docs/hosts-plan.md
// step 1) for a small table of every kind of route, with lfdln's test profile but the
// harness's own folders and ports.
//   node test/hosts-render.ts <out> <sites-root> <http-port> <https-port> <cert> <key> [<php-socket>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { CLOUDFLARE_RANGES } from '@panel/hosts/cloudflare';
import { renderAll, type Table } from '@panel/hosts/render';
import { PROFILE } from './fixtures/lfdln-profile.ts';
import { edgeFile } from './edge-file.ts';

const [out, sitesRoot, http, https, cert, key, php] = process.argv.slice(2);
if (!out || !sitesRoot || !http || !https || !cert || !key) throw new Error('usage: hosts-render.ts <out> <sites-root> <http> <https> <cert> <key> [<php-socket>]');

export const TABLE: Table = {
  hosts: [
    { name: 'site', enabled: true }, { name: 'spa', enabled: true }, { name: 'mixed', enabled: true },
    { name: 'off', enabled: false }, { name: 'stopped', enabled: true }, { name: 'jump', enabled: true },
  ],
  folders: [{ name: 'site', runPhp: true }, { name: 'docs', runPhp: false }, { name: 'app', runPhp: false }],
  routes: [
    { host: 'site', path: '/', enabled: true, kind: 'folder', folder: 'site', spa: false },
    { host: 'spa', path: '/', enabled: true, kind: 'folder', folder: 'app', spa: true },
    { host: 'mixed', path: '/', enabled: true, kind: 'folder', folder: 'site', spa: false },
    { host: 'mixed', path: '/docs/', enabled: true, kind: 'folder', folder: 'docs', spa: false },
    { host: 'mixed', path: '/old/', enabled: true, kind: 'redirect', to: 'https://example.com/new', status: 301, keepPath: true },
    { host: 'mixed', path: '/away/', enabled: true, kind: 'redirect', to: '/docs/', status: 302, keepPath: false },
    { host: 'off', path: '/', enabled: true, kind: 'folder', folder: 'site', spa: false },
    { host: 'stopped', path: '/', enabled: false, kind: 'folder', folder: 'site', spa: false },
    { host: 'jump', path: '/', enabled: true, kind: 'redirect', to: 'https://example.org', status: 302, keepPath: false },
  ],
};
// a domain with Cloudflare in front (S6): its "@" shows the docs folder
TABLE.hosts.push({ name: '@', enabled: true, withWww: true, domain: 'cf-domain.test' });
TABLE.routes.push({ host: '@', domain: 'cf-domain.test', path: '/', enabled: true, kind: 'folder', folder: 'docs', spa: false });

// the domains as rows (docs/domains-hosts-plan.md steps 1 and 4): the home one, and another
// with its own catch-all (the harness's certificate for both, allowed from its folder)
TABLE.domains = [
  { name: PROFILE.domain, home: true, tls: { cert, key } },
  { name: 'other-domain.test', home: false, tls: { cert, key } },
  { name: 'cf-domain.test', home: false, tls: { cert, key }, front: 'cloudflare' },
];
const cfg = {
  ...hostsConfigOf(PROFILE, out),
  dir: out, sitesRoot, edge: edgeFile(dirname(out)),
  tls: { cert, key },
  tlsRoots: [`${dirname(cert)}/`],
  php: php ? { socket: php } : null,
  listen: { http: `127.0.0.1:${http}`, https: `127.0.0.1:${https}`, v6: false },
  // the harness's own "Cloudflare" (S6): 127.0.0.2, beside the real ranges
  cloudflareRanges: [...CLOUDFLARE_RANGES, '127.0.0.2/32'],
};
for (const [f, text] of renderAll(cfg, TABLE)) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  writeFileSync(join(out, f), text);
}
