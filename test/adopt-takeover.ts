// For test/run-adopt-nginx-test.sh (docs/adopt-plan.md step 3): the takeover itself, as
// the installer runs it, against a throwaway nginx whose sites-enabled holds links to the
// hand-written files (moved into the harness): the real routing helper (writing the
// panel's blocks and taking the links out, nginx -t and reload for real), a throwaway
// Postgres, and TutorStar's stand-in. Then a takeover made to differ on purpose, which
// must give the host back exactly as it was.
//   node test/adopt-takeover.ts <T> <sites-root> <http> <https> <cert> <key> <backend-port> <nginx.conf> <uploads>
// Gonsalves's two (docs/domains-hosts-plan.md step 7) are on gonsalvesfamily.com, a domain
// with named certificates, added first as the setup guide would.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { migrate } from '@panel/core/pg-migrate';
import { all, run as sql } from '@panel/core/pg';
import { realExec, type RunSpec } from '@panel/core/runner';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { takeOverHost } from '@panel/hosts/take-over';
import { fullName, TAKEOVERS } from '@panel/hosts/takeover';
import { domainsFor, servedIn } from './adopt-compare-lib.ts';
import { PROFILE } from './fixtures/lfdln-profile.ts';
import { edgeFile } from './edge-file.ts';
import { startPg } from './pg-harness.ts';

const [T, sitesRoot, http, https, cert, key, backend, conf, uploads] = process.argv.slice(2) as string[];
const D = 'lesfleursdelanuit.com';
let pass = 0, fail = 0;
const ok = (w: string) => { console.log(`  ok    ${w}`); pass++; };
const bad = (w: string) => { console.log(`  FAIL  ${w}`); fail++; };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

const echo = createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(`tutor ${req.url}`)); });
await new Promise<void>((r) => echo.listen(Number(backend), '127.0.0.1', r));

const nginx = ['-p', T!, '-c', conf!, '-e', `${T}/live-error.log`];
const run = (spec: RunSpec) => realExec(spec.what === 'nginx-test' ? ['nginx', '-t', '-q', ...nginx]
  : spec.what === 'nginx-reload' ? ['nginx', '-s', 'reload', ...nginx] : ['false']);
const ports = TAKEOVERS.flatMap((t) => t.services ?? []).map((p) => ({ ...p, port: Number(backend) }));
const cfg = {
  ...hostsConfigOf(PROFILE, T!), dir: `${T}/lfdln-hosts`, sitesRoot: sitesRoot!, edge: edgeFile(T!),
  tls: { cert: cert!, key: key!, include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' },
  php: null, listen: { http: `127.0.0.1:${http}`, https: `127.0.0.1:${https}`, v6: false }, signInZone: 'login',
  tlsRoots: [`${T}/`, '/etc/letsencrypt/'], acmeRoot: `${T}/acme`, served: servedIn(uploads!),
};
const ops = createRoutesOps({ cfg, run, zone: { taken: async () => null }, ports: () => ports, sitesEnabled: `${T}/se`, sitesAvailable: `${T}/sa` });

const pg = await startPg();
const database = pg.freshDatabase();
const owner = pg.connect('owner', database, 1);
await migrate(owner);
await owner.end();
const db = pg.connect('panel', database, 4);
try {
  // the domains' rows: the home one (the installer's seed) and gonsalvesfamily.com (the guide's)
  for (const d of domainsFor(cert!, key!)) {
    await sql(db, `INSERT INTO domains (name, home, dns, front, cert, cert_names, tls, created_by, created_at)
      VALUES (?, ?, ?, 'direct', ?, ARRAY(SELECT jsonb_array_elements_text(?::text::jsonb)), ?::text::jsonb, 'harness', 1)`,
      d.name, d.home, d.home ? 'dreamhost' : 'manual', 'names' in d ? 'names' : 'wildcard-dns', JSON.stringify('names' in d ? d.names : []), JSON.stringify(d.tls));
  }
  await ops.apply({ hosts: [], folders: [], routes: [], domains: domainsFor(cert!, key!) });      // the catch-all, as after phase 5's takeover
  const deps = {
    now: 1_800_000_000, actor: 'harness', ports, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    where: { ip: '127.0.0.1', http: Number(http), https: Number(https), domain: D },
    apply: (table: unknown, link: object) => ops.apply(table, link),
  };

  console.log('--- the takeover, as the installer runs it');
  // made to differ: instastylr without its headers -- given back, exactly as it was
  const plain = TAKEOVERS.map((t) => (t.name === 'instastylr' ? { ...t, routes: t.routes.map((r) => (r.kind === 'folder' ? { ...r, headers: [] } : r)) } : t));
  const given = await takeOverHost(db, 'instastylr', { ...deps, takeovers: plain });
  given.state === 'given-back' && given.differences.some((x) => x.includes('content-security-policy'))
    ? ok(`made to differ (no headers): given back, and why (${given.differences.length} answers differed)`) : bad(`the differing takeover: ${JSON.stringify(given).slice(0, 300)}`);
  isLink(`${T}/se/instastylr`) ? ok('...its hand-written link is back in sites-enabled') : bad('the hand-written link wasn\'t put back');
  !existsSync(`${T}/lfdln-hosts/hosts/instastylr.conf`) ? ok('...the panel\'s block is gone again') : bad('the panel\'s block was left');
  (await all(db, "SELECT 1 FROM hosts WHERE name = 'instastylr'")).length === 0 ? ok('...and the panel keeps no row of it') : bad('rows were left');

  for (const t of TAKEOVERS) {
    const shown = fullName(t, D);
    const r = await takeOverHost(db, t.domain ? shown : t.name, deps);
    r.state === 'taken-over' && r.name === shown ? ok(`${shown}: taken over, all ${r.answers} answers the same`) : bad(`${shown}: ${r.state}: ${r.differences.join(' | ')}`);
    !isLink(`${T}/se/${t.link}`) && existsSync(`${T}/sa/${t.link}`) ? ok(`...sites-enabled/${t.link} out, the file kept in sites-available`) : bad(`${t.link}'s link or file`);
    const file = t.domain ? `domains/${t.domain}/hosts/${t.name}.conf` : `hosts/${t.name}.conf`;
    existsSync(`${T}/lfdln-hosts/${file}`) ? ok(`...the panel's ${file} in`) : bad(`no ${file}`);
  }
  const again = await takeOverHost(db, 'tutor', deps);
  again.state === 'already' ? ok('a second time: the panel\'s already, nothing asked or changed') : bad(`again: ${again.state}`);
  const g = await takeOverHost(db, 'gonsalvesfamily.com', deps);
  g.state === 'already' ? ok('...and gonsalvesfamily.com, by its full name') : bad(`gonsalves again: ${g.state}`);
  const rows = await all<{ domain: string; name: string; adopted: boolean; with_www: boolean }>(db,
    'SELECT d.name AS domain, h.name, h.adopted, h.with_www FROM hosts h JOIN domains d ON d.id = h.domain_id ORDER BY d.name, h.name');
  JSON.stringify(rows) === JSON.stringify([
    { domain: 'gonsalvesfamily.com', name: '@', adopted: true, with_www: true }, { domain: 'gonsalvesfamily.com', name: 'admin', adopted: true, with_www: false },
    { domain: D, name: '@', adopted: true, with_www: true }, { domain: D, name: 'instastylr', adopted: true, with_www: false }, { domain: D, name: 'tutor', adopted: true, with_www: false },
  ]) ? ok('the panel keeps the five hosts, adopted, each on its domain (the domains with www)') : bad(`hosts: ${JSON.stringify(rows)}`);
  const acts = await all<{ action: string; target: string }>(db, "SELECT action, target FROM activity WHERE action LIKE 'host-%' ORDER BY id");
  acts.map((a) => a.action).join() === 'host-taken-over,host-given-back,host-taken-over,host-taken-over,host-taken-over,host-taken-over,host-taken-over'
    && acts.at(-1)!.target === 'admin.gonsalvesfamily.com' ? ok('Activity says each, by its full name') : bad(`activity: ${JSON.stringify(acts)}`);
  const site = readFileSync(`${T}/lfdln-hosts/site.conf`, 'utf8');
  site.includes('domains/*/hosts/*.conf') && !existsSync(`${T}/lfdln-hosts/domains/gonsalvesfamily.com/catch-all.conf`)
    ? ok('site.conf takes the other domain\'s hosts; that domain has no catch-all') : bad(`site.conf: ${site}`);
  readFileSync(`${T}/lfdln-hosts/hosts/tutor.conf`, 'utf8').includes(`proxy_pass http://127.0.0.1:${backend};`) ? ok('tutor goes to its service\'s port') : bad('tutor.conf');
} catch (e) {
  bad(`crashed: ${(e as Error).stack}`);
} finally {
  await db.end({ timeout: 2 });
  pg.stop();
  echo.close();
}
console.log(`\n  takeover test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
