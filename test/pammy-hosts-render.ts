// For test/run-gate-nginx-test.sh with VHOST=hosts (docs/phase8-plan.md 8-7a): pammy.org's
// hosts as the renderer makes them from the rows 8-7b seeds -- pammy.org and www with the
// whole website and /api/, a folder host (recipes), folder hosts on for the rest -- with the
// server's own paths, which the harness rewrites as it does the hand-kept file's. Software
// routes on top, as the placements the harness tries: "path blog", "subdomain shop", ...
//   node test/pammy-hosts-render.ts <out> [<placement>...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostsConfigOf } from '@panel/pammy/hosts';
import { WITH_HOSTS } from '@panel/pammy/nginx-hosts';
import { renderAll, type Route, type Table } from '@panel/hosts/render';

const [out, ...placements] = process.argv.slice(2);
if (!out) throw new Error('usage: pammy-hosts-render.ts <out> [<id>:<subdomain|path>:<name>...]');

const cfg = { ...hostsConfigOf(WITH_HOSTS), dir: out, listen: { http: '80', https: '443', v6: false } };
const routes: Route[] = [
  { host: '@', path: '/', enabled: true, kind: 'site' },
  { host: '@', path: '/api/', enabled: true, kind: 'proxy', port: 3042, websockets: true },
  { host: 'recipes', path: '/', enabled: true, kind: 'folder', folder: 'recipes', spa: false },
];
const hosts = [{ name: '@', enabled: true, withWww: true }, { name: 'recipes', enabled: true }];
const software: { id: string; proxy: string }[] = [];
for (const p of placements) {
  const [id, mode, name] = p.split(':') as [string, string, string];
  software.push({ id, proxy: id === 'blog' ? 'proxy.conf' : `proxy-${id}.conf` });
  if (mode === 'subdomain') {
    hosts.push({ name, enabled: true });
    routes.push({ host: name, path: '/', enabled: true, kind: 'software', app: id });
  } else routes.push({ host: '@', path: `/${name}/`, enabled: true, kind: 'software', app: id });
}
const t: Table = {
  hosts, routes, software,
  folders: [{ name: 'recipes', runPhp: true }],
  domains: [{ name: 'pammy.org', home: true, tls: cfg.tls, folderHosts: true }],
};
for (const [f, text] of renderAll(cfg, t)) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  writeFileSync(join(out, f), text);
}
