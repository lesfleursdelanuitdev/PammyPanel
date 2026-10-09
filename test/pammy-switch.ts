// For test/run-gate-nginx-test.sh with VHOST=hosts (docs/phase8-plan.md 8-7c): pammy.org's
// switch as the installer runs it, against a nginx laid out like the server's --
// sites-enabled holding the link to the pamela site (the real file, made runnable here) --
// with the real routing helper (links swapped, nginx -t and reload for real), a throwaway
// Postgres with the rows hosts-seed makes, and the harness's gate, PHP and website. First a
// switch made to differ (its /api/ on the wrong port), which must be given back exactly as
// it was; then the real one; then back by hand; then again.
//   node test/pammy-switch.ts <T> <public> <http> <https> <cert> <key> <api-port> <nginx.conf>
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '@panel/core/pg-migrate';
import { all, run as sql } from '@panel/core/pg';
import { realExec, type RunSpec } from '@panel/core/runner';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { proxyKind, siteKind } from '@panel/hosts/folder-gate';
import { HOSTS_KINDS } from '@panel/hosts/render';
import { hostsConfigOf } from '@panel/pammy/hosts';
import { seedHosts, WITH_HOSTS, type Install } from '@panel/pammy/nginx-hosts';
import { softwareKind } from '@panel/pammy/software-kind';
import { switchBack, switchToHosts, type Listing } from '@panel/pammy/switch';
import { startPg } from './pg-harness.ts';

const [T, pub, http, https, cert, key, api, conf] = process.argv.slice(2) as string[];
let pass = 0, fail = 0;
const ok = (w: string) => { console.log(`  ok    ${w}`); pass++; };
const bad = (w: string) => { console.log(`  FAIL  ${w}`); fail++; };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const se = `${T}/se`;

const nginx = ['-p', T!, '-c', conf!, '-e', `${T}/sw-error.log`];
const run = (spec: RunSpec) => realExec(spec.what === 'nginx-test' ? ['nginx', '-t', '-q', ...nginx]
  : spec.what === 'nginx-reload' ? ['nginx', '-s', 'reload', ...nginx] : ['false']);
const cfg = {
  ...hostsConfigOf(WITH_HOSTS), dir: `${T}/pammy-hosts`, sitesRoot: pub!, logs: T!,
  folderGate: { dir: `${T}/gate` }, tls: { cert: cert!, key: key! }, tlsRoots: [`${T}/`],
  listen: { http: `127.0.0.1:${http}`, https: `127.0.0.1:${https}`, v6: false },
  kinds: [...HOSTS_KINDS, siteKind, proxyKind, softwareKind(`${T}/swwp`)],
};
const ops = createRoutesOps({ cfg, run, zone: null, links: ['pamela'], ownLink: true, sitesEnabled: se, sitesAvailable: `${T}/sa` });
// the folder helper's files-list, from the harness's website
const list = async (dir: string): Promise<Listing> => {
  const buckets: { name: string }[] = [];
  const files: { name: string }[] = [];
  for (const e of readdirSync(join(pub!, dir), { withFileTypes: true })) {
    if (e.name.startsWith('.') || (dir !== '' && e.name === 'login-files')) continue;
    (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return readdirSync(join(pub!, dir, e.name)) && true; } catch { return false; } })()) ? buckets : files).push({ name: e.name });
  }
  return { buckets, files };
};
const installs: Install[] = [{ id: 'blog', placement: { mode: 'subdomain', name: 'blog' } }];

const pg = await startPg();
const database = pg.freshDatabase();
const owner = pg.connect('owner', database, 1);
await migrate(owner);
await owner.end();
const db = pg.connect('panel', database, 4);
try {
  const seeded = await seedHosts(db, installs, 1_800_000_000, 'harness');
  // the harness's certificate and its stand-in for pamela-app, where the server has its own
  await sql(db, "UPDATE domains SET tls = ?::text::jsonb WHERE home", JSON.stringify({ cert, key }));
  await ops.apply({ ...seeded.table, domains: seeded.table.domains!.map((d) => ({ ...d, tls: { cert: cert!, key: key! } })) });
  const deps = {
    now: 1_800_000_000, actor: 'harness', installs, list, sitesEnabled: se,
    where: { ip: '127.0.0.1', http: Number(http), https: Number(https), domain: 'pammy.org' },
    apply: (t: unknown, link: object) => ops.apply(t, link),
  };

  console.log('--- the switch, as the installer runs it');
  // made to differ: /api/ to a port nothing answers on
  await sql(db, "UPDATE routes SET target_ref = '{\"port\": 18197, \"websockets\": true}'::jsonb WHERE target_kind = 'proxy'");
  const given = await switchToHosts(db, deps);
  given.state === 'given-back' && given.differences.some((x) => x.includes('/api/'))
    ? ok(`made to differ (/api/ elsewhere): given back, and why (${given.differences.length} of ${given.answers} answers differed)`) : bad(`the differing switch: ${JSON.stringify(given).slice(0, 400)}`);
  isLink(`${se}/pamela`) && !isLink(`${se}/pammy-hosts`) ? ok('...the pamela link is back, and pammy-hosts is out') : bad('the links after giving back');

  await sql(db, "UPDATE routes SET target_ref = ?::text::jsonb WHERE target_kind = 'proxy'", JSON.stringify({ port: Number(api), websockets: true }));
  const r = await switchToHosts(db, deps);
  r.state === 'switched' && r.answers > 150 ? ok(`switched: all ${r.answers} answers the same before and after`) : bad(`the switch: ${r.state}: ${r.differences.slice(0, 5).join(' | ')}`);
  !isLink(`${se}/pamela`) && isLink(`${se}/pammy-hosts`) ? ok('...sites-enabled/pamela out (the file kept in sites-available), pammy-hosts in') : bad('the links after the switch');
  (await switchToHosts(db, deps)).state === 'already' ? ok('...and asked again: already') : bad('a second switch did something');
  (await all(db, "SELECT 1 FROM activity WHERE action = 'host-taken-over' AND target = 'pammy.org'")).length === 2 ? ok('...each try in Activity') : bad('Activity');

  await switchBack(db, deps);
  isLink(`${se}/pamela`) && !isLink(`${se}/pammy-hosts`) ? ok('switched back by hand: the pamela site again, pammy-hosts out') : bad('the links after switching back');
  const again = await switchToHosts(db, deps);
  again.state === 'switched' ? ok(`and switched again (${again.answers} answers the same)`) : bad(`the second switch: ${again.differences.slice(0, 5).join(' | ')}`);
} finally {
  await db.end();
  pg.stop();
}
console.log(`\n  pammy switch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
