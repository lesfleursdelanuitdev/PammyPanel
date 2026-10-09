// For test/run-hosts-nginx-test.sh: the routing helper's own apply (docs/hosts-plan.md
// step 2) against the harness's throwaway nginx: its "nginx -t" and "reload" are that
// nginx's, run for real. Prints the answer as JSON, or {"error": code, "message"}.
//   node test/hosts-apply.ts <T> <sites-root> <http> <https> <cert> <key> one|bad|two
import { realExec, type RunSpec } from '@panel/core/runner';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps, HostsError } from '@panel/hosts/helper/ops';
import type { Table } from '@panel/hosts/render';
import { PROFILE } from './fixtures/lfdln-profile.ts';
import { edgeFile } from './edge-file.ts';

const [T, sitesRoot, http, https, cert, key, which] = process.argv.slice(2) as string[];
const nginx = ['-p', T!, '-c', `${T}/nginx-applied.conf`, '-e', `${T}/error-applied.log`];
const run = (spec: RunSpec) => realExec(spec.what === 'nginx-test' ? ['nginx', '-t', '-q', ...nginx]
  : spec.what === 'nginx-reload' ? ['nginx', '-s', 'reload', ...nginx] : ['false']);
const folderRoute = (host: string) => ({ host, path: '/', enabled: true, kind: 'folder' as const, folder: 'site', spa: false });
const tables: Record<string, Table> = {
  one: { hosts: [{ name: 'live', enabled: true }], folders: [{ name: 'site', runPhp: false }], routes: [folderRoute('live')] },
  two: { hosts: [{ name: 'live', enabled: true }, { name: 'fresh', enabled: true }], folders: [{ name: 'site', runPhp: false }], routes: [folderRoute('live'), folderRoute('fresh')] },
};
tables.bad = tables.two!;
const cfg = {
  ...hostsConfigOf(PROFILE, T!),
  dir: `${T}/applied`, sitesRoot: sitesRoot!, edge: edgeFile(T!),
  // "bad": a certificate that isn't there, which only nginx itself notices
  tls: { cert: which === 'bad' ? `${T}/no-such-cert.pem` : cert!, key: key! },
  php: null,
  listen: { http: `127.0.0.1:${http}`, https: `127.0.0.1:${https}`, v6: false },
};
try {
  console.log(JSON.stringify(await createRoutesOps({ cfg, run, zone: { taken: async () => null } }).apply(tables[which!])));
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof HostsError ? e.code : 'crash', message: (e as Error).message }));
}
