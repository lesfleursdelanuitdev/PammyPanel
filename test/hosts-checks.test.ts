// The hosts' checks (docs/domains-hosts-plan.md step 3): the probe's rules, the probe
// against a real TLS server with a certificate made here, and the routing helper's
// cache. The Hosts page's side is in test/hosts-panel.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunSpec } from '@panel/core/runner';
import { CLOUDFLARE_RANGES } from '@panel/hosts/cloudflare';
import { createRoutesOps } from '@panel/hosts/helper/ops';
import { certCovers, checkTask, isCloudflare, pointsHere, runTask, sanNames, type ProbeEnv, type Result, type Task } from '@panel/hosts/probe';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { PROFILE } from '@panel/lfdln/profile';

const NOW = 1_800_000_000;
const DAY = 86400;

describe('the probe\'s rules', () => {
  it('Cloudflare\'s ranges are deploy/cloudflare-ips.txt\'s', () => {
    const file = readFileSync(new URL('../deploy/cloudflare-ips.txt', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual([...CLOUDFLARE_RANGES], file);
    assert.ok(isCloudflare('104.16.1.1') && isCloudflare('2606:4700::1111'));
    assert.ok(!isCloudflare('203.0.113.200') && !isCloudflare('not an address'));
  });

  it('DNS points here: at this server with nothing in front, at Cloudflare only behind it', () => {
    const own = ['203.0.113.200', '2a0a:4cc0:2000:122::1'];
    assert.equal(pointsHere(['203.0.113.200'], own, 'direct').ok, true);
    assert.equal(pointsHere(['203.0.113.200', '2a0a:4cc0:2000:122::1'], own, 'direct').ok, true);
    assert.match(pointsHere(['203.0.113.200', '203.0.113.9'], own, 'direct').why, /aren't this server: 203\.0\.113\.9/);
    assert.match(pointsHere(['203.0.113.9'], own, 'direct').why, /points elsewhere/);
    assert.match(pointsHere(['104.16.1.1'], own, 'direct').why, /through Cloudflare, but/);
    assert.match(pointsHere([], own, 'direct').why, /no address/);
    assert.equal(pointsHere(['104.16.1.1', '2606:4700::1'], own, 'cloudflare').ok, true);
    assert.match(pointsHere(['203.0.113.200'], own, 'cloudflare').why, /not proxied/);
  });

  it('a certificate covers a name, a wildcard one label only, and not when it is close to running out', () => {
    const sans = sanNames('DNS:lesfleursdelanuit.com, DNS:*.lesfleursdelanuit.com, IP Address:1.2.3.4');
    assert.deepEqual(sans, ['lesfleursdelanuit.com', '*.lesfleursdelanuit.com']);
    assert.equal(certCovers(sans, NOW + 60 * DAY, ['tutor.lesfleursdelanuit.com', 'lesfleursdelanuit.com'], NOW).ok, true);
    assert.equal(certCovers(sans, NOW + 60 * DAY, ['*.lesfleursdelanuit.com'], NOW).daysLeft, 60);
    assert.match(certCovers(sans, NOW + 60 * DAY, ['a.b.lesfleursdelanuit.com'], NOW).why, /doesn't cover a\.b\.lesfleursdelanuit\.com/);
    assert.match(certCovers(sans, NOW + 60 * DAY, ['gonsalvesfamily.com'], NOW).why, /doesn't cover/);
    assert.match(certCovers(sans, NOW + 5 * DAY, ['lesfleursdelanuit.com'], NOW).why, /expires in 5 day/);
    assert.match(certCovers(sans, NOW - 2 * DAY, ['lesfleursdelanuit.com'], NOW).why, /expired 2 day/);
  });

  it('checks every task again: names, paths, kinds', () => {
    assert.deepEqual(checkTask({ kind: 'host', name: 'tutor.lesfleursdelanuit.com', front: 'x' }), { kind: 'host', name: 'tutor.lesfleursdelanuit.com', front: 'direct' });
    assert.deepEqual(checkTask({ kind: 'cert-file', path: '/etc/ssl/a.pem', names: ['*.a.com'] }), { kind: 'cert-file', path: '/etc/ssl/a.pem', names: ['*.a.com'] });
    for (const bad of [
      { kind: 'host', name: '*.a.com' }, { kind: 'host', name: 'a.com; rm' }, { kind: 'host', name: 'a.com', path: '/../x' },
      { kind: 'cert-file', path: 'rel.pem', names: ['a.com'] }, { kind: 'cert-file', path: '/a/../b', names: ['a.com'] }, { kind: 'cert-file', path: '/a', names: [] },
      { kind: 'run', name: 'a.com' }, null,
    ]) assert.throws(() => checkTask(bad), JSON.stringify(bad));
  });
});

describe('the probe against a real TLS server', () => {
  let dir = '';
  let server: Server;
  let env: ProbeEnv;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hosts-checks-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=example.test',
      '-addext', 'subjectAltName=DNS:example.test,DNS:*.example.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
      res.statusCode = req.url === '/broken' ? 502 : req.headers.host === 'shop.example.test' ? 200 : 404;
      res.end('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    env = {
      ip: '127.0.0.1', port, timeoutMs: 3000, now: () => Math.floor(Date.now() / 1000), own: () => ['192.0.2.1'],
      resolve: async (name) => {
        if (name.startsWith('gone.')) { const e = new Error('nx') as NodeJS.ErrnoException; e.code = 'ENOTFOUND'; throw e; }
        return name.startsWith('away.') ? ['203.0.113.5'] : ['192.0.2.1'];
      },
    };
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('a host: DNS here, the certificate nginx gives covers it, and it answers', async () => {
    const r = await runTask({ kind: 'host', name: 'shop.example.test', front: 'direct' }, env) as Extract<Result, { kind: 'host' }>;
    assert.deepEqual([r.dns.ok, r.cert.ok, r.answers.ok, r.answers.status], [true, true, true, 200], JSON.stringify(r));
    assert.ok(r.cert.daysLeft! >= 29, JSON.stringify(r.cert));
  });

  it('what isn\'t right is said: DNS elsewhere or missing, a name the certificate doesn\'t cover, a 5xx', async () => {
    const away = await runTask({ kind: 'host', name: 'away.example.test', front: 'direct' }, env) as Extract<Result, { kind: 'host' }>;
    assert.match(away.dns.why, /points elsewhere: 203\.0\.113\.5/);
    const gone = await runTask({ kind: 'host', name: 'gone.example.test', front: 'direct' }, env) as Extract<Result, { kind: 'host' }>;
    assert.match(gone.dns.why, /no address/);
    const other = await runTask({ kind: 'host', name: 'a.b.example.test', front: 'direct' }, env) as Extract<Result, { kind: 'host' }>;
    assert.match(other.cert.why, /doesn't cover a\.b\.example\.test/);
    const broken = await runTask({ kind: 'host', name: 'shop.example.test', front: 'direct', path: '/broken' }, env) as Extract<Result, { kind: 'host' }>;
    assert.deepEqual([broken.answers.ok, broken.answers.status], [false, 502]);
    const closed = await runTask({ kind: 'host', name: 'shop.example.test', front: 'direct' }, { ...env, port: 9 }) as Extract<Result, { kind: 'host' }>;
    assert.match(closed.cert.why, /couldn't connect/);
    assert.equal(closed.answers.ok, false);
  });

  it('a certificate file: its names and days, or why it can\'t be read', async () => {
    const f = await runTask({ kind: 'cert-file', path: join(dir, 'cert.pem'), names: ['example.test', '*.example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.deepEqual([f.cert.names, f.cert.daysLeft! >= 29], [['example.test', '*.example.test'], true]);
    const missing = await runTask({ kind: 'cert-file', path: join(dir, 'nope.pem'), names: ['example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.match(missing.cert.why, /can't be read as a certificate: ENOENT/);
    const key = await runTask({ kind: 'cert-file', path: join(dir, 'key.pem'), names: ['example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.equal(key.cert.ok, false);
    // with its key (step 4): the certificate's own, or said
    const withKey = await runTask({ kind: 'cert-file', path: join(dir, 'cert.pem'), key: join(dir, 'key.pem'), names: ['example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.equal(withKey.cert.ok, true, withKey.cert.why);
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', join(dir, 'other.key')], { stdio: 'ignore' });
    const other = await runTask({ kind: 'cert-file', path: join(dir, 'cert.pem'), key: join(dir, 'other.key'), names: ['example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.match(other.cert.why, /its key is another certificate's/);
    const noKey = await runTask({ kind: 'cert-file', path: join(dir, 'cert.pem'), key: join(dir, 'none.key'), names: ['example.test'] }, env) as Extract<Result, { kind: 'cert-file' }>;
    assert.match(noKey.cert.why, /its key can't be read: ENOENT/);
  });

  it('a made-up name resolves here: the wildcard record', async () => {
    const r = await runTask({ kind: 'resolve', name: 'zz-check-1.example.test', front: 'direct' }, env) as Extract<Result, { kind: 'resolve' }>;
    assert.equal(r.dns.ok, true);
  });
});

describe('the routing helper\'s check op: its tasks, its cache', () => {
  let clock = NOW;
  const probes: Task[][] = [];
  const run = async (spec: RunSpec) => {
    assert.equal(spec.what, 'check');
    assert.deepEqual(spec.argv.slice(0, 2), ['/usr/bin/node', '--disable-warning=ExperimentalWarning']);
    assert.match(spec.argv[2]!, /packages\/hosts\/src\/probe\.ts$/);
    const tasks = JSON.parse(spec.stdin!) as Task[];
    probes.push(tasks);
    const ok = { ok: true, why: 'fine' };
    return { code: 0, stderr: '', stdout: JSON.stringify(tasks.map((t) => ({ kind: 'host', name: (t as { name: string }).name, dns: { ...ok, addresses: [] }, cert: { ...ok, notAfter: null, daysLeft: 60, names: [] }, answers: { ...ok, status: 200 } }))) };
  };
  const ops = createRoutesOps({ cfg: hostsConfigOf(PROFILE), run, zone: { taken: async () => null }, now: () => clock });

  it('every name a visitor uses, the domain itself with www', async () => {
    const r = await ops.check({ hosts: [{ name: '@', withWww: true }, { name: 'tutor' }] });
    assert.deepEqual(probes.at(-1)!.map((t) => [t.kind, (t as { name: string }).name, (t as { front: string }).front]),
      [['host', 'lesfleursdelanuit.com', 'direct'], ['host', 'www.lesfleursdelanuit.com', 'direct'], ['host', 'tutor.lesfleursdelanuit.com', 'direct']]);
    assert.deepEqual(r.checks.map((c) => [c.name, c.checkedAt]), [['lesfleursdelanuit.com', NOW], ['www.lesfleursdelanuit.com', NOW], ['tutor.lesfleursdelanuit.com', NOW]]);
  });

  it('kept 10 minutes; "again" at most once a minute; a new name is checked at once', async () => {
    const n = probes.length;
    clock += 60;
    await ops.check({ hosts: [{ name: 'tutor' }] });
    assert.equal(probes.length, n, 'from the cache');
    await ops.check({ hosts: [{ name: 'tutor' }, { name: 'shop' }] });
    assert.deepEqual(probes.at(-1)!.map((t) => (t as { name: string }).name), ['shop.lesfleursdelanuit.com']);
    const a = await ops.check({ hosts: [{ name: 'tutor' }], again: true });
    assert.equal(probes.length, n + 2);
    assert.equal(a.againIn, 60);
    await ops.check({ hosts: [{ name: 'tutor' }], again: true });
    assert.equal(probes.length, n + 2, 'again, too soon: from the cache');
    clock += 600;
    await ops.check({ hosts: [{ name: 'tutor' }] });
    assert.equal(probes.length, n + 3, 'after 10 minutes');
  });

  it('refuses what isn\'t a host or a domain', async () => {
    await assert.rejects(ops.check({ hosts: [{ name: 'a;b' }] }), /one name/);
    await assert.rejects(ops.check({ domain: 'not a domain', hosts: [] }), /A domain is/);
    await assert.rejects(ops.check({ hosts: 'tutor' }), /a list/);
  });
});
